"""Bridge between a LIVE event source and the game engine.

The engine never imports a TikTok library. A Node child process
(`connector/tiktok-connector.mjs`) reads the public events of a room and prints
normalized JSON lines; this module supervises it, drops duplicates, batches
likes and feeds the engine in arrival order. A built-in mock source produces
the same events so a stream can be rehearsed without going live.
"""

from __future__ import annotations

import asyncio
import hashlib
import inspect
import json
import random
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
from collections import OrderedDict, deque
from pathlib import Path

from .engine import GameEngine

USERNAME = re.compile(r"^[A-Za-z0-9_.]{2,30}$")
QUEUE_SOFT_LIMIT = 3000      # chat beyond this is dropped; follows, shares and gifts are always kept
SEEN_LIMIT = 5000            # bounded LRU of source message ids
LIKE_WINDOW = 1.0            # seconds of likes merged into one engine event per viewer
ENTER_INTERVAL = 2.5         # at most one "just arrived" notice per interval
BATCH = 24                   # engine results merged into one state broadcast
NOT_LIVE_RETRY_DELAYS = (5, 5, 8, 10, 12)
ERROR_RETRY_DELAYS = (6, 12, 20, 30)
NOT_LIVE_JITTER = (0.0, 1.5)
ERROR_JITTER = (0.0, 2.0)
NOT_LIVE_RETRY_DELAY = NOT_LIVE_RETRY_DELAYS[0]
RETRY_DELAYS = ERROR_RETRY_DELAYS
PERMANENT_ERROR_CODES = frozenset({"BAD_USERNAME", "NOT_FOUND", "NO_NODE", "OLD_NODE", "SPAWN_FAILED", "AGE_RESTRICTED"})
STDERR_TAIL_LIMIT = 20
MOCK_LINES = ("Chúc mừng năm mới cả nhà!", "Công ty vui quá", "Sắp được về quê rồi", "Cố lên mọi người ơi", "Tết này về nhà nha", "Nay chạy KPI căng ghê")
MOCK_STATION_CHATS = (
    "lên xe", "về Nghệ An", "Cà Mau", "Đà Lạt", "Đồng Tháp", "Hà Nội",
    "Đà Nẵng", "Cần Thơ", "Nha Trang", "Hải Phòng", "Gia Lai", "Thanh Hóa",
    "Quảng Ninh", "Bến Tre", "Đắk Lắk", "Huế", "An Giang", "Nam Định",
)
MOCK_GIFTS = (("Hoa hồng", 1), ("Hoa hồng", 1), ("Trà sữa", 10), ("Bánh donut", 30), ("Pháo hoa", 99))
# Sample viewers for the rehearsal room; distinct from the seeded colleagues so both can be told apart.
MOCK_NAMES = ("Bé Na", "Tí Còi", "Hà Linh", "Tuấn Bơ", "Mai Chi", "Bông Gòn", "Kem Dâu", "Su Su", "Gấu Mập", "Na Na", "Bảo Bối", "Cún Con", "Hạt Tiêu", "Bánh Bao", "Mít Ướt", "Cà Rốt", "Ốc Sên", "Tôm Khô")


def normalize_username(value: str) -> str:
    text = str(value or "").strip()
    text = re.sub(r"^.*tiktok\.com/@?", "", text, flags=re.IGNORECASE).lstrip("@")
    return re.split(r"[/?#]", text, maxsplit=1)[0]


def _safe_int(value, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def player_key(user: dict) -> str | None:
    """Stable in-game identity for a platform account: the numeric id, never the nickname."""
    for field in ("id", "idStr"):
        raw = str(user.get(field) or "").strip()
        if raw.isdigit() and raw != "0":
            return f"tt_{raw}"[:80]
    unique = re.sub(r"[^A-Za-z0-9_-]", "-", str(user.get("uniqueId") or "")).strip("-")[:60]
    if unique:
        return f"ttu_{unique}"
    sec_uid = str(user.get("secUid") or "").strip()
    if sec_uid:
        return f"tts_{hashlib.sha256(sec_uid.encode()).hexdigest()[:20]}"
    return None


class LiveBridge:
    def __init__(self, engine: GameEngine, publish, root: Path, connector: Path | None = None, on_status=None):
        self.engine = engine
        self.publish = publish          # async (results: list[dict]) -> None; an empty list announces status only
        self.root = root
        self.connector = connector or root / "connector" / "tiktok-connector.mjs"
        self.on_status = on_status
        self.generation = 0
        self.process: subprocess.Popen | None = None
        self.loop: asyncio.AbstractEventLoop | None = None
        self.queue: asyncio.Queue | None = None
        self.tasks: list[asyncio.Task] = []
        self.mock_task: asyncio.Task | None = None
        self.retry_task: asyncio.Task | None = None
        self.retries = 0
        self.not_live_retries = 0
        self.error_retries = 0
        self._stopped = False
        self._stderr_tail: deque[str] = deque(maxlen=STDERR_TAIL_LIMIT)
        self.seen: OrderedDict[str, None] = OrderedDict()
        self.likes: dict[str, dict] = {}
        self.last_enter = 0.0
        self.last_viewer_notice = 0.0
        self.state = self._blank()

    def _blank(self, status: str = "idle") -> dict:
        return {
            "status": status,
            "unique_id": "",
            "room_id": "",
            "error": "",
            "code": "",
            "detail": "",
            "last_warning": None,
            "stderr_tail": [],
            "retry_attempt": 0,
            "retry_delay": None,
            "next_retry_at": None,
            "viewer_count": None,
            "since": None,
            "counters": {"chat": 0, "like": 0, "gift": 0, "follow": 0, "share": 0, "enter": 0, "duplicate": 0, "dropped": 0},
        }

    def public(self) -> dict:
        return {
            **self.state,
            "counters": dict(self.state["counters"]),
            "last_warning": dict(self.state["last_warning"]) if isinstance(self.state.get("last_warning"), dict) else None,
            "stderr_tail": list(self.state.get("stderr_tail") or []),
            "queue": self.queue.qsize() if self.queue else 0,
            "waiting_live": self.waiting_live,
        }

    @property
    def waiting_live(self) -> bool:
        status = self.state["status"]
        if status in ("connecting", "reconnecting"):
            return True
        if status in ("error", "disconnected"):
            if self._stopped or not self.state.get("unique_id"):
                return False
            return self.state.get("code") not in PERMANENT_ERROR_CODES
        return False

    @property
    def connected(self) -> bool:
        return self.state["status"] in ("connected", "reconnecting")

    def _notify_status(self):
        if not self.on_status:
            return
        try:
            result = self.on_status(self.public())
            if inspect.isawaitable(result):
                asyncio.create_task(result)
        except Exception as error:
            print(f"[live] on_status failed: {error!r}", file=sys.stderr)

    # ---- lifecycle -------------------------------------------------------

    def _ensure_workers(self):
        self.loop = asyncio.get_running_loop()
        if self.queue is None:
            self.queue = asyncio.Queue()
        if not self.tasks or any(task.done() for task in self.tasks):
            for task in self.tasks:
                task.cancel()
            self.tasks = [asyncio.create_task(self._work()), asyncio.create_task(self._flush_likes())]

    async def connect(self, unique_id: str) -> dict:
        unique_id = normalize_username(unique_id)
        await self._stop_source()
        self._stopped = False
        self.retries = 0
        self.not_live_retries = 0
        self.error_retries = 0
        self._stderr_tail.clear()
        if not USERNAME.match(unique_id):
            self.state = {**self._blank("error"), "code": "BAD_USERNAME", "error": "Tên tài khoản TikTok chưa đúng. Nhập dạng @tenkenh."}
            self._notify_status()
            await self.publish([])
            return self.public()
        self._ensure_workers()
        self._spawn(unique_id)
        self._notify_status()
        await self.publish([])
        return self.public()

    def _spawn(self, unique_id: str):
        self.generation += 1
        generation = self.generation
        self.retry_task = None
        same_channel = self.state.get("unique_id") == unique_id
        counters = self.state["counters"] if same_channel else self._blank()["counters"]
        prev_since = self.state.get("since") if same_channel else None
        prev_warning = self.state.get("last_warning") if same_channel and self.retries > 0 else None
        stderr_tail = list(self._stderr_tail) if same_channel and self.retries > 0 else []
        self.state = {
            **self._blank("connecting"),
            "unique_id": unique_id,
            "counters": counters,
            "since": prev_since,
            "last_warning": prev_warning,
            "stderr_tail": stderr_tail,
            "retry_attempt": self.retries,
        }
        node = shutil.which("node")
        if not node or not self.connector.is_file():
            self.state.update(status="error", code="NO_NODE", error="Chưa tìm thấy Node.js hoặc tệp connector. Chạy lại start.cmd để cài đặt.")
            return
        try:
            self.process = subprocess.Popen(
                [node, str(self.connector), unique_id], cwd=str(self.root),
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                text=True, encoding="utf-8", errors="replace", bufsize=1,
                creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
            )
        except OSError as error:
            self.state.update(status="error", code="SPAWN_FAILED", error=f"Không khởi động được connector: {error}")
            return
        stderr_thread = threading.Thread(target=self._read_stderr, args=(self.process, generation), daemon=True, name="tiktok-connector-stderr")
        stderr_thread.start()
        threading.Thread(target=self._read, args=(self.process, generation, stderr_thread), daemon=True, name="tiktok-connector").start()

    def _read_stderr(self, process: subprocess.Popen, generation: int):
        loop = self.loop
        try:
            if process.stderr is None:
                return
            for raw in process.stderr:
                line = raw.strip()[:300]
                if not line:
                    continue
                if loop and not loop.is_closed():
                    try:
                        loop.call_soon_threadsafe(self._record_stderr, generation, line)
                    except RuntimeError:
                        break
        except (OSError, ValueError):
            pass

    def _record_stderr(self, generation: int, line: str):
        if generation != self.generation:
            return
        self._stderr_tail.append(line)
        self.state["stderr_tail"] = list(self._stderr_tail)

    def _read(self, process: subprocess.Popen, generation: int, stderr_thread: threading.Thread | None = None):
        loop = self.loop
        try:
            for line in process.stdout:
                try:
                    message = json.loads(line)
                except ValueError:
                    continue
                if isinstance(message, dict) and loop and not loop.is_closed():
                    try:
                        loop.call_soon_threadsafe(self._ingest, generation, message)
                    except RuntimeError:
                        break
        except (OSError, ValueError):
            pass
        code = process.wait()
        if stderr_thread is not None:
            stderr_thread.join(timeout=0.5)
        if process.stdin is not None:
            try:
                process.stdin.close()
            except (OSError, ValueError):
                pass
        if loop and not loop.is_closed():
            try:
                loop.call_soon_threadsafe(self._exited, generation, code)
            except RuntimeError:
                pass

    def _kill(self, process: subprocess.Popen | None):
        if not process or process.poll() is not None:
            return
        if process.stdin is not None:
            try:
                process.stdin.write("quit\n")
                process.stdin.flush()
            except (OSError, ValueError):
                pass
            try:
                process.stdin.close()
            except (OSError, ValueError):
                pass

        def reap():
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
        threading.Thread(target=reap, daemon=True).start()

    async def _stop_source(self):
        self._stopped = True
        self.generation += 1
        for task in (self.mock_task, self.retry_task):
            if task:
                task.cancel()
        self.mock_task = self.retry_task = None
        self._kill(self.process)
        self.process = None
        self.likes.clear()
        if self.queue is not None:
            while not self.queue.empty():
                try:
                    self.queue.get_nowait()
                except asyncio.QueueEmpty:
                    break

    async def disconnect(self) -> dict:
        await self._stop_source()
        self.retries = 0
        self.not_live_retries = 0
        self.error_retries = 0
        self._stderr_tail.clear()
        self.state = self._blank()
        self._notify_status()
        await self.publish([])
        return self.public()

    async def close(self):
        await self._stop_source()
        for task in self.tasks:
            task.cancel()
        self.tasks = []
        process, self.process = self.process, None
        if process and process.poll() is None:
            process.kill()

    def _next_retry_delay(self, code: str) -> tuple[float, int]:
        if code == "NOT_LIVE":
            self.error_retries = 0
            base = NOT_LIVE_RETRY_DELAYS[min(self.not_live_retries, len(NOT_LIVE_RETRY_DELAYS) - 1)]
            delay = round(base + random.uniform(*NOT_LIVE_JITTER), 2)
            self.not_live_retries += 1
            self.retries += 1
            return delay, self.not_live_retries
        self.not_live_retries = 0
        base = ERROR_RETRY_DELAYS[min(self.error_retries, len(ERROR_RETRY_DELAYS) - 1)]
        delay = round(base + random.uniform(*ERROR_JITTER), 2)
        self.error_retries += 1
        self.retries += 1
        return delay, self.error_retries

    def _exited(self, generation: int, returncode: int):
        if generation != self.generation or self._stopped:
            return
        self.process = None
        status = self.state["status"]
        if status in ("ended", "idle"):
            return
        uid = self.state.get("unique_id", "")
        detail = (self.state.get("detail") or (self._stderr_tail[-1] if self._stderr_tail else ""))[:300]
        if status == "error":
            code = self.state.get("code") or "CONNECT_FAILED"
            if not uid or code in PERMANENT_ERROR_CODES:
                self.state.update(detail=detail, retry_delay=None, next_retry_at=None)
                self._notify_status()
                asyncio.create_task(self.publish([]))
                return
            delay, attempt = self._next_retry_delay(code)
            if code == "NOT_LIVE":
                error_msg = f"Kênh @{uid} chưa bật LIVE. Đang chờ bạn bấm Go LIVE (tự thử lại sau {round(delay)} giây)…"
            else:
                base_err = re.sub(r"\s*Tự thử lại sau .*$", "", str(self.state.get("error") or "Chưa kết nối được TikTok LIVE.")).strip()
                error_msg = f"{base_err} Tự thử lại sau {round(delay)} giây (lần {attempt})…"
            self.state.update(
                error=error_msg[:240],
                detail=detail,
                retry_attempt=self.retries,
                retry_delay=delay,
                next_retry_at=time.time() + delay,
            )
            self.retry_task = asyncio.create_task(self._retry(generation, uid, delay))
            self._notify_status()
            asyncio.create_task(self.publish([]))
            return
        if not uid:
            return
        code = self.state.get("code") or ("CONNECT_FAILED" if returncode != 0 and status == "connecting" else "DISCONNECTED")
        delay, attempt = self._next_retry_delay(code)
        self.state.update(
            status="disconnected",
            code=code,
            detail=detail,
            error=f"Mất kết nối TikTok LIVE. Tự thử lại sau {round(delay)} giây (lần {attempt})…",
            viewer_count=None,
            retry_attempt=self.retries,
            retry_delay=delay,
            next_retry_at=time.time() + delay,
        )
        self.retry_task = asyncio.create_task(self._retry(generation, uid, delay))
        self._notify_status()
        asyncio.create_task(self.publish([]))

    async def _retry(self, generation: int, unique_id: str, delay: float):
        await asyncio.sleep(delay)
        if generation != self.generation or self._stopped:
            return
        self.retry_task = None
        self._spawn(unique_id)
        self._notify_status()
        await self.publish([])

    # ---- ingest ----------------------------------------------------------

    def _ingest(self, generation: int, message: dict):
        if generation != self.generation:
            return
        kind = message.get("t")
        if kind == "warning":
            warn_detail = str(message.get("detail") or "")[:300]
            self.state["last_warning"] = {
                "code": str(message.get("code") or "WARNING")[:40],
                "error": str(message.get("error") or "")[:240],
                "detail": warn_detail,
                "at": time.time(),
            }
            if warn_detail:
                self.state["detail"] = warn_detail
            asyncio.create_task(self.publish([]))
        elif kind == "status":
            status = str(message.get("status") or "")
            if status == "connected":
                self.retries = 0
                self.not_live_retries = 0
                self.error_retries = 0
                self._stderr_tail.clear()
                room_id = str(message.get("roomId") or "")[:40]
                self.state.update(
                    status="connected",
                    error="",
                    code="",
                    detail="",
                    last_warning=None,
                    stderr_tail=[],
                    retry_attempt=0,
                    retry_delay=None,
                    next_retry_at=None,
                    room_id=room_id,
                    since=self.state["since"] or time.time(),
                )
                self.engine.clear_rehearsal(only_if_present=True)
                if room_id and hasattr(self.engine, "on_live_room"):
                    self.engine.on_live_room(room_id)
                self._notify_status()
            elif status == "connecting":
                self.state.update(status="connecting")
                self._notify_status()
            elif status == "reconnecting":
                detail = str(message.get("detail") or "")[:300]
                if detail:
                    self.state["detail"] = detail
                if not (self.state.get("room_id") or self.state.get("since") or self.state.get("status") == "connected"):
                    return
                self.state.update(status="reconnecting")
                self._notify_status()
            elif status in ("error", "ended"):
                code = str(message.get("code") or "")[:40]
                default_err = "Phiên LIVE đã kết thúc." if status == "ended" else "Mất kết nối TikTok LIVE."
                error = str(message.get("error") or default_err)[:240]
                detail = (str(message.get("detail") or "") or (self._stderr_tail[-1] if self._stderr_tail else ""))[:300]
                if status == "error" and code == "NOT_LIVE" and self.state.get("unique_id"):
                    error = f"Kênh @{self.state['unique_id']} chưa bật LIVE. Đang chờ bạn bấm Go LIVE (tự thử lại)…"
                self.state.update(status=status, code=code, error=error, detail=detail, viewer_count=None)
                self._notify_status()
            else:
                return  # "disconnected" is followed by the process exit, which decides whether to retry.
            asyncio.create_task(self.publish([]))
        elif kind == "viewers":
            count = max(0, _safe_int(message.get("count"), 0))
            changed = count != self.state["viewer_count"]
            self.state["viewer_count"] = count
            if changed and time.monotonic() - self.last_viewer_notice > 5:
                self.last_viewer_notice = time.monotonic()
                asyncio.create_task(self.publish([]))
        elif kind in ("chat", "gift", "like", "follow", "share", "join"):
            user = message.get("user") if isinstance(message.get("user"), dict) else {}
            self.accept("enter" if kind == "join" else kind, user, message, source=self.state["room_id"] or self.state["unique_id"])

    def accept(self, kind: str, user: dict, message: dict, source: str = "mock", player_id: str | None = None):
        """Deduplicate, prioritize and queue one normalized event. Never blocks."""
        player_id = player_id or player_key(user)
        if not player_id or self.queue is None:
            return
        counters = self.state["counters"]
        raw_id = str(message.get("id") or "").strip()
        source_id = "" if raw_id in ("", "0", "-1") else raw_id
        if source_id:
            key = f"{kind}:{source_id}"
            if key in self.seen:
                counters["duplicate"] += 1
                return
            self.seen[key] = None
            if len(self.seen) > SEEN_LIMIT:
                self.seen.popitem(last=False)
        nickname = str(user.get("nickname") or "").strip() or str(user.get("uniqueId") or "").strip() or "Đồng nghiệp"
        avatar = str(user.get("avatar") or "")
        if kind == "like":
            like_count = max(1, _safe_int(message.get("count"), 1))
            counters["like"] += like_count
            entry = self.likes.setdefault(player_id, {"count": 0, "nickname": nickname, "avatar": avatar})
            entry["count"] += min(500, like_count)
            return
        if kind in ("chat", "enter") and self.queue.qsize() >= QUEUE_SOFT_LIMIT:
            counters["dropped"] += 1
            return
        counters[kind] += 1
        gift = message.get("gift") if isinstance(message.get("gift"), dict) else {}
        self.queue.put_nowait({
            "kind": kind, "player_id": player_id, "nickname": nickname, "avatar": avatar,
            "event_id": f"live:{source}:{kind}:{source_id}"[:100] if source_id else f"live:{uuid.uuid4()}",
            "text": str(message.get("text") or "").strip(), "count": max(1, _safe_int(gift.get("count"), 1)),
            "diamonds": max(0, _safe_int(gift.get("diamonds"), 0)), "gift": str(gift.get("name") or ""),
        })

    async def _flush_likes(self):
        while True:
            await asyncio.sleep(LIKE_WINDOW)
            if not self.likes or self.queue is None:
                continue
            batch, self.likes = self.likes, {}
            for player_id, entry in batch.items():
                self.queue.put_nowait({"kind": "like", "player_id": player_id, "nickname": entry["nickname"], "avatar": entry["avatar"], "event_id": f"live:{uuid.uuid4()}", "text": "", "count": entry["count"], "diamonds": 0, "gift": ""})

    def _apply(self, items: list[dict]) -> list[dict]:
        results: list[dict] = []
        for item in items:
            try:
                results.extend(self.engine.live_event(item["kind"], item["player_id"], item["nickname"], item["event_id"], avatar=item["avatar"], text=item["text"], count=item["count"], diamonds=item["diamonds"], gift=item["gift"]))
            except Exception as error:  # One malformed event must not stop the stream.
                print(f"[live] event skipped: {error!r}", file=sys.stderr)
        return results

    async def _work(self):
        while True:
            items = [await self.queue.get()]
            while len(items) < BATCH and not self.queue.empty():
                items.append(self.queue.get_nowait())
            try:
                results = self._apply(items)
                shown = [result for result in results if not result.get("duplicate") and (result.get("changed") or result.get("broadcast") or result.get("cue"))]
                if shown:
                    await self.publish(shown)
            except asyncio.CancelledError:
                raise
            except Exception as error:
                print(f"[live] batch failed: {error!r}", file=sys.stderr)

    # ---- rehearsal -------------------------------------------------------

    async def start_mock(self) -> dict:
        await self._stop_source()
        self._ensure_workers()
        self.retries = 0
        self.not_live_retries = 0
        self.error_retries = 0
        self._stderr_tail.clear()
        self.state = {**self._blank("mock"), "unique_id": "kênh_thử", "since": time.time(), "viewer_count": 0}
        self._notify_status()
        self.mock_task = asyncio.create_task(self._mock(self.generation))
        await self.publish([])
        return self.public()

    async def _mock(self, generation: int):
        """Sample viewers behave like a small room. Their profiles are labelled demo_* everywhere."""
        cast = [{"id": f"demo_tt_{index + 1:02d}", "nickname": name} for index, name in enumerate(MOCK_NAMES)]
        inside: list[dict] = []
        while generation == self.generation:
            await asyncio.sleep(random.uniform(0.5, 1.4))
            if generation != self.generation:
                return
            if len(inside) < len(cast) and (not inside or random.random() < 0.3):
                viewer = cast[len(inside)]
                inside.append(viewer)
                self.state["viewer_count"] = len(inside) + 3
                in_station = self.engine.snapshot()["session"]["scene"] == "station"
                first_text = random.choice((*MOCK_STATION_CHATS, f"ghế {random.randint(1, 24)}")) if in_station else random.choice(("1", "vào làm", "vao lam"))
                self.accept("chat", viewer, {"text": first_text}, player_id=viewer["id"])
                continue
            viewer = random.choice(inside)
            roll = random.random()
            if roll < 0.42:
                in_station = self.engine.snapshot()["session"]["scene"] == "station"
                chat_text = random.choice((*MOCK_STATION_CHATS, f"ghế {random.randint(1, 24)}", "vé")) if in_station else random.choice(("2", "2", "làm việc", "lam viec", "3", "cà phê", "4"))
                self.accept("chat", viewer, {"text": chat_text}, player_id=viewer["id"])
            elif roll < 0.72:
                self.accept("like", viewer, {"count": random.randint(4, 18)}, player_id=viewer["id"])
            elif roll < 0.80:
                self.accept("follow", viewer, {}, player_id=viewer["id"])
            elif roll < 0.87:
                self.accept("share", viewer, {}, player_id=viewer["id"])
            elif roll < 0.93:
                name, diamonds = random.choice(MOCK_GIFTS)
                self.accept("gift", viewer, {"gift": {"name": name, "count": 1, "diamonds": diamonds}}, player_id=viewer["id"])
            else:
                self.accept("chat", viewer, {"text": random.choice(MOCK_LINES)}, player_id=viewer["id"])
