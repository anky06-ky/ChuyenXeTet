"""Transactional, connector-independent rules for the office demo."""

from __future__ import annotations

import hashlib
import json
import random
import re
import sqlite3
import threading
import time
import unicodedata
import uuid
from contextlib import contextmanager
from pathlib import Path

from .bus import ROUTE_BY_CODE, SEAT_COOLDOWN, BusStation, ensure_bus_schema, parse_station

VISIBLE_LIMIT = 24
WORK_COOLDOWN = 30
COFFEE_COOLDOWN = 10
MAX_PROFILES = 700
# LIVE interactions. Every reward is a virtual in-game item.
HEART_BOOST = 200      # hearts from the whole room that refill everyone's energy
FOLLOW_BONUS = 1000    # paid once per profile
SHARE_BONUS = 300
SHARE_COOLDOWN = 300
# Gifts never buy a personal advantage: the giver is thanked and the whole office shares the treat.
GIFT_TIERS = (
    {"key": "party", "min": 99, "label": "Tiệc tất niên", "reward": 1000, "refresh": True},
    {"key": "treat", "min": 10, "label": "Đãi trà sữa", "reward": 200, "refresh": False},
    {"key": "lixi", "min": 1, "label": "Lì xì may mắn", "reward": 0, "refresh": False},
)
NAMES = ["Minh Anh", "Hoàng Nam", "Bảo Ngọc", "Gia Huy", "Thảo Vy", "Đức Minh", "Khánh Linh", "Tuấn Kiệt", "Hà My", "Quốc Bảo", "Phương Anh", "Nhật Minh", "Thanh Trúc", "Anh Khoa", "Tú Anh", "Ngọc Mai", "Hải Đăng", "Yến Nhi", "Trọng Nhân", "Diệu Linh", "Quỳnh Chi", "Đăng Khoa", "Kim Ngân", "Thiên Phúc"]
ALIASES = {
    "vao lam": "join", "vo lam": "join", "xin viec": "join", "xinviec": "join", "join": "join", "1": "join",
    "lam viec": "work", "lamviec": "work", "kpi": "work", "2": "work",
    "ca phe": "coffee", "caphe": "coffee", "cafe": "coffee", "coffee": "coffee", "3": "coffee",
    "luong": "salary", "salary": "salary", "4": "salary",
    "nam": "skin_boy", "nu": "skin_girl",
}
PLAYER_COLUMNS = "id,nickname,skin,kpi,coins,xp,last_work,last_seen,mission_works,missions_completed,avatar,hearts,gifts,followed,hometown,entered_at"


def normalize(text: str) -> str:
    value = unicodedata.normalize("NFD", text.lower().replace("đ", "d"))
    return " ".join("".join(char for char in value if not unicodedata.combining(char)).split())


def parse_command(text: str, relaxed: bool = False) -> str | None:
    """Map a comment to a command. LIVE chat is forgiving about punctuation and trailing words."""
    value = normalize(text)
    if value in ALIASES:
        return ALIASES[value]
    if not relaxed:
        return None
    words = re.sub(r"[^a-z0-9 ]", " ", value).split()
    if not words or len(words) > 5:
        return None
    # "vào làm nè" still joins; a lone word or digit followed by other words is ordinary chatter.
    return ALIASES.get(words[0] if len(words) == 1 else " ".join(words[:2]))


def clean_name(text: str) -> str:
    value = "".join(char for char in str(text or "") if char.isprintable()).strip()
    return value[:24] or "Đồng nghiệp"


def clean_avatar(url: str | None) -> str:
    value = str(url or "").strip()
    return value if value.startswith("https://") and len(value) <= 2048 and not any(char.isspace() for char in value) else ""


def gift_tier(diamonds: int) -> dict:
    return next(tier for tier in GIFT_TIERS if diamonds >= tier["min"])


def dotted(amount: int) -> str:
    return f"{amount:,}".replace(",", ".")


class GameEngine(BusStation):
    def __init__(self, path: str | Path, clock=time.time):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.clock = clock
        self.lock = threading.RLock()
        with self.database() as db:
            db.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS sessions (
                    id TEXT PRIMARY KEY, phase TEXT NOT NULL DEFAULT 'OFFICE',
                    month INTEGER NOT NULL DEFAULT 1, paused INTEGER NOT NULL DEFAULT 0,
                    version INTEGER NOT NULL DEFAULT 0, created_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS players (
                    id TEXT PRIMARY KEY, nickname TEXT NOT NULL, skin INTEGER NOT NULL,
                    kpi INTEGER NOT NULL DEFAULT 0, coins INTEGER NOT NULL DEFAULT 0,
                    xp INTEGER NOT NULL DEFAULT 0, joined_at REAL NOT NULL,
                    last_seen REAL NOT NULL, last_work REAL NOT NULL DEFAULT 0,
                    last_coffee REAL NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS processed_events (
                    event_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL,
                    result TEXT NOT NULL, created_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS activities (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, seq INTEGER NOT NULL,
                    type TEXT NOT NULL, nickname TEXT, player_id TEXT,
                    message TEXT NOT NULL, created_at REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS players_active ON players(last_seen DESC);
            """)
            # Additive migrations preserve existing profiles, balances and scheduled rounds.
            session_columns = {row["name"] for row in db.execute("PRAGMA table_info(sessions)")}
            if "play_mode" not in session_columns:
                db.execute("ALTER TABLE sessions ADD COLUMN play_mode TEXT NOT NULL DEFAULT 'open'")
            for column in ("hearts", "boosts"):
                if column not in session_columns:
                    db.execute(f"ALTER TABLE sessions ADD COLUMN {column} INTEGER NOT NULL DEFAULT 0")
            player_columns = {row["name"] for row in db.execute("PRAGMA table_info(players)")}
            for column in ("mission_works", "missions_completed", "hearts", "gifts", "followed"):
                if column not in player_columns:
                    db.execute(f"ALTER TABLE players ADD COLUMN {column} INTEGER NOT NULL DEFAULT 0")
            if "avatar" not in player_columns:
                db.execute("ALTER TABLE players ADD COLUMN avatar TEXT NOT NULL DEFAULT ''")
            if "last_share" not in player_columns:
                db.execute("ALTER TABLE players ADD COLUMN last_share REAL NOT NULL DEFAULT 0")
            ensure_bus_schema(db)
            if not db.execute("SELECT 1 FROM sessions LIMIT 1").fetchone():
                db.execute("INSERT INTO sessions(id,created_at) VALUES (?,?)", (str(uuid.uuid4()), self.clock()))

    @contextmanager
    def database(self):
        with self.lock:
            db = sqlite3.connect(self.path, timeout=10)
            db.row_factory = sqlite3.Row
            db.execute("PRAGMA busy_timeout=10000")
            db.execute("PRAGMA synchronous=NORMAL")
            try:
                yield db
                db.commit()
            except Exception:
                db.rollback()
                raise
            finally:
                db.close()

    def snapshot(self) -> dict:
        now = self.clock()
        with self.database() as db:
            session = dict(db.execute("SELECT * FROM sessions LIMIT 1").fetchone())
            session["paused"] = bool(session["paused"])
            energy = {"hearts": session.pop("hearts"), "target": HEART_BOOST, "boosts": session.pop("boosts")}
            totals = db.execute("SELECT count(*) total_players,coalesce(sum(kpi),0) total_kpi,coalesce(sum(coins),0) total_coins,coalesce(sum(id GLOB 'demo_*'),0) demo_players FROM players").fetchone()
            players = [dict(row) for row in db.execute(f"SELECT {PLAYER_COLUMNS} FROM players ORDER BY last_seen DESC,id LIMIT ?", (VISIBLE_LIMIT,))]
            leaders = [dict(row) for row in db.execute(f"SELECT {PLAYER_COLUMNS} FROM players ORDER BY (id GLOB 'demo_*'),kpi DESC,xp DESC,id LIMIT 5")]
            top_hearts = [dict(row) for row in db.execute(f"SELECT {PLAYER_COLUMNS} FROM players WHERE hearts>0 ORDER BY hearts DESC,id LIMIT 5")]
            top_gifts = [dict(row) for row in db.execute(f"SELECT {PLAYER_COLUMNS} FROM players WHERE gifts>0 ORDER BY gifts DESC,id LIMIT 5")]
            activities = [dict(row) for row in db.execute("SELECT * FROM activities ORDER BY id DESC LIMIT 12")]
            station = self.station_snapshot(db, session, now)
            return {
                "session": session,
                "players": players,
                "leaderboard": leaders,
                "top_hearts": top_hearts,
                "top_gifts": top_gifts,
                "activities": activities,
                "stats": {**dict(totals), "visible_players": len(players), "visible_limit": VISIBLE_LIMIT, "company_target": 1000},
                "server_time": now,
                "mode": "mock",
                "audience": {"connected": False, "viewer_count": None},
                "mission": {"target": 3, "reward": 500},
                "work_cooldown": WORK_COOLDOWN,
                "energy": energy,
                "rewards": {"follow": FOLLOW_BONUS, "share": SHARE_BONUS, "gift_tiers": [dict(tier) for tier in reversed(GIFT_TIERS)]},
                "station": station,
            }

    def _event(self, db, event_type, message, player=None):
        db.execute("UPDATE sessions SET version=version+1")
        version = db.execute("SELECT version FROM sessions LIMIT 1").fetchone()[0]
        db.execute("INSERT INTO activities(seq,type,nickname,player_id,message,created_at) VALUES (?,?,?,?,?,?)", (version, event_type, player["nickname"] if player else None, player["id"] if player else None, message, self.clock()))
        db.execute("DELETE FROM activities WHERE id <= (SELECT coalesce(max(id),0)-250 FROM activities)")
        return version

    def _lookup_event(self, db, event_id, fingerprint):
        saved = db.execute("SELECT * FROM processed_events WHERE event_id=?", (event_id,)).fetchone()
        if not saved:
            return None
        if saved["fingerprint"] != fingerprint:
            return {"ok": False, "code": "EVENT_CONFLICT", "message": "Mã sự kiện đã được dùng cho một lệnh khác.", "changed": False}
        return {**json.loads(saved["result"]), "duplicate": True, "changed": False}

    def _store_event(self, db, event_id, fingerprint, result):
        db.execute("INSERT INTO processed_events VALUES (?,?,?,?)", (event_id, fingerprint, json.dumps(result, ensure_ascii=False), self.clock()))
        # Keep a bounded replay window and explicitly retain the newest 10,000 keys.
        db.execute("DELETE FROM processed_events WHERE event_id IN (SELECT event_id FROM processed_events ORDER BY created_at DESC,rowid DESC LIMIT -1 OFFSET 10000)")
        return result

    def _player(self, db, player_id):
        return db.execute("SELECT * FROM players WHERE id=?", (player_id,)).fetchone()

    def _enroll(self, db, player_id, nickname, avatar, now):
        """Return (profile, created). A full registry returns (None, False) and never evicts anyone."""
        player = self._player(db, player_id)
        if player:
            if avatar and avatar != player["avatar"]:
                db.execute("UPDATE players SET avatar=? WHERE id=?", (avatar, player_id))
            db.execute("UPDATE players SET nickname=?,last_seen=? WHERE id=?", (nickname, now, player_id))
            return self._player(db, player_id), False
        if db.execute("SELECT count(*) FROM players").fetchone()[0] >= MAX_PROFILES:
            return None, False
        skin = int(hashlib.sha256(player_id.encode()).hexdigest()[:4], 16) % 4
        db.execute("INSERT INTO players(id,nickname,skin,joined_at,last_seen,avatar) VALUES (?,?,?,?,?,?)", (player_id, nickname, skin, now, now, avatar))
        return self._player(db, player_id), True

    def command(self, player_id: str, nickname: str, text: str, event_id: str, avatar: str | None = None, relaxed: bool = False) -> dict:
        norm = normalize(text)
        avatar = clean_avatar(avatar)
        fingerprint = hashlib.sha256(json.dumps([player_id, nickname, text], ensure_ascii=False).encode()).hexdigest()
        now = self.clock()
        with self.database() as db:
            db.execute("BEGIN IMMEDIATE")
            prior = self._lookup_event(db, event_id, fingerprint)
            if prior:
                return prior
            session = db.execute("SELECT * FROM sessions LIMIT 1").fetchone()
            in_station = session["scene"] == "station"
            if in_station:
                station_cmd, station_arg = parse_station(norm, relaxed)
                command = None if station_cmd else parse_command(text, relaxed)
            else:
                command = parse_command(text, relaxed)
                station_cmd, station_arg = (None, None) if command else parse_station(norm, relaxed)
            result = {
                "ok": False,
                "changed": False,
                "code": "UNKNOWN_COMMAND",
                "message": "Thử lệnh: tên tỉnh thành (Cà Mau, Nghệ An, Đà Lạt…), ghế 1–24, lên xe, vé hoặc xuống xe." if in_station else "Thử lệnh: vào làm, làm việc, cà phê hoặc lương.",
                "event_id": event_id,
            }
            player = self._player(db, player_id)
            if player and avatar and avatar != player["avatar"]:
                db.execute("UPDATE players SET avatar=? WHERE id=?", (avatar, player_id))
                player = self._player(db, player_id)
            if station_cmd and not in_station:
                result.update(code="STATION_CLOSED", message="Bến xe chưa mở. Cùng chạy KPI ở văn phòng trước nhé!")
                return self._store_event(db, event_id, fingerprint, result)
            if station_cmd:
                if not player:
                    player, _ = self._enroll(db, player_id, nickname, avatar, now)
                    if not player:
                        result.update(code="CAPACITY", message="Phiên demo đã đủ 700 hồ sơ. Người đã tham gia vẫn chơi được.")
                        return self._store_event(db, event_id, fingerprint, result)
                self._station_command(db, result, session, player, station_cmd, station_arg, now)
                if not result.get("changed") and not player["entered_at"] and not self._seat_of(db, player["id"]):
                    db.execute("UPDATE players SET entered_at=? WHERE id=?", (now, player["id"]))
                    result["player"] = dict(self._player(db, player["id"]))
                if not result.get("changed") and result.get("code") in ("SEAT_TAKEN", "COOLDOWN", "SEAT_INVALID", "NO_TICKET", "ALREADY_SEATED", "CONFIRM_SWITCH", "TICKET"):
                    result["broadcast"] = True
                return self._store_event(db, event_id, fingerprint, result)
            if command == "join":
                if not player:
                    player, _ = self._enroll(db, player_id, nickname, avatar, now)
                    if not player:
                        result.update(code="CAPACITY", message="Phiên demo đã đủ 700 hồ sơ. Người đã tham gia vẫn chơi được.")
                        return self._store_event(db, event_id, fingerprint, result)
                    message = f"{nickname} đã vào công ty. Chào đồng nghiệp mới!"
                    seq = self._event(db, "join", message, player)
                    result.update(ok=True, changed=True, code="JOINED", cue="join", seq=seq, message=message, player=dict(player))
                else:
                    db.execute("UPDATE players SET nickname=?,last_seen=? WHERE id=?", (nickname, now, player_id))
                    player = self._player(db, player_id)
                    seq = self._event(db, "return", f"{nickname} quay lại công ty.", player)
                    result.update(ok=True, changed=True, code="WELCOME_BACK", seq=seq, message=f"{nickname} đã có hồ sơ rồi. Cùng làm việc nha!", player=dict(player))
            elif command and not player:
                result.update(code="JOIN_FIRST", message="Gõ “vào làm” trước để nhận nhân vật của bạn nha!")
            elif command == "salary":
                result.update(ok=True, code="PROFILE", cue="salary", message=f"{player['nickname']} · {player['kpi']} KPI · {player['coins']:,} xu Tết · {player['xp']} XP", player=dict(player))
            elif command in ("skin_boy", "skin_girl"):
                skin = 0 if command == "skin_boy" else 1
                if player["skin"] % 2 == skin:
                    result.update(ok=True, code="SKIN_SAME", message=f"{player['nickname']} đang dùng nhân vật này rồi.", player=dict(player))
                else:
                    db.execute("UPDATE players SET skin=?,last_seen=? WHERE id=?", (skin, now, player_id))
                    player = self._player(db, player_id)
                    message = f"{player['nickname']} đổi sang nhân vật {'nam' if skin == 0 else 'nữ'}."
                    seq = self._event(db, "skin", message, player)
                    result.update(ok=True, changed=True, code="SKIN", cue="click", seq=seq, message=message, player=dict(player))
            elif command in ("work", "coffee"):
                if in_station:
                    result.update(code="WRONG_SCENE", message="Cả công ty đã ra bến xe. Gõ “lên xe” hoặc số ghế (1–24) nhé!")
                elif session["paused"]:
                    result.update(code="PAUSED", message="Công ty đang tạm nghỉ. Đợi quản trò tiếp tục nhé!")
                elif session["play_mode"] != "open" and session["phase"] != "OFFICE":
                    result.update(code="WRONG_PHASE", message="Đã chốt sổ cuối năm. Cùng nhận thưởng Tết nào!")
                else:
                    last = player["last_work" if command == "work" else "last_coffee"]
                    cooldown = WORK_COOLDOWN if command == "work" else COFFEE_COOLDOWN
                    remaining = max(0, int(cooldown - (now - last) + 0.999)) if last else 0
                    if remaining:
                        result.update(code="COOLDOWN", remaining=remaining, message=f"{player['nickname']} đợi thêm {remaining} giây rồi thử lại nhé.", player=dict(player))
                    else:
                        if command == "work":
                            db.execute("UPDATE players SET kpi=kpi+10,coins=coins+500,xp=xp+5,last_work=?,last_seen=? WHERE id=?", (now, now, player_id))
                            message = f"{player['nickname']} hoàn thành công việc · +10 KPI · +500 xu"
                            if session["play_mode"] == "open":
                                completed = player["mission_works"] + 1 >= 3
                                db.execute("UPDATE players SET mission_works=?,missions_completed=missions_completed+?,coins=coins+? WHERE id=?", (0 if completed else player["mission_works"] + 1, int(completed), 500 if completed else 0, player_id))
                                result["mission_completed"] = completed
                                if completed:
                                    message += " · Xong 3 việc nhỏ, nhận thêm 500 xu!"
                        else:
                            db.execute("UPDATE players SET last_coffee=?,last_seen=? WHERE id=?", (now, now, player_id))
                            message = f"{player['nickname']} đang nạp năng lượng ở góc cà phê."
                        player = self._player(db, player_id)
                        seq = self._event(db, command, message, player)
                        result.update(ok=True, changed=True, code="WORKED" if command == "work" else "COFFEE", cue="bonus" if result.get("mission_completed") else command, seq=seq, message=message, player=dict(player))
            return self._store_event(db, event_id, fingerprint, result)

    def live_event(self, kind: str, player_id: str, nickname: str, event_id: str, *, avatar: str | None = None, text: str = "", count: int = 1, diamonds: int = 0, gift: str = "") -> list[dict]:
        """Apply one normalized LIVE interaction. Returns every result worth showing, in order."""
        nickname = clean_name(nickname)
        avatar = clean_avatar(avatar)
        if kind == "chat":
            return self._live_chat(player_id, nickname, text, event_id, avatar)
        if kind == "enter":
            return self._live_enter(player_id, nickname, avatar)
        if kind not in ("follow", "share", "like", "gift"):
            return [{"ok": False, "changed": False, "code": "UNKNOWN_EVENT", "message": "Sự kiện LIVE chưa được hỗ trợ.", "event_id": event_id}]
        now = self.clock()
        fingerprint = f"live:{kind}:{player_id}"
        with self.database() as db:
            db.execute("BEGIN IMMEDIATE")
            prior = self._lookup_event(db, event_id, fingerprint)
            if prior:
                return [prior]
            result = {"ok": True, "changed": False, "code": "IGNORED", "message": "", "event_id": event_id, "kind": kind}
            if kind == "like":
                self._like(db, result, player_id, max(1, min(5000, int(count))), now)
            else:
                player, created = self._enroll(db, player_id, nickname, avatar, now)
                if not player:
                    result.update(ok=False, code="CAPACITY", message="Phiên demo đã đủ 700 hồ sơ. Người đã tham gia vẫn chơi được.")
                elif kind == "follow":
                    self._follow(db, result, player, created)
                elif kind == "share":
                    self._share(db, result, player, created, now)
                else:
                    self._gift(db, result, player, created, max(1, min(1_000_000, int(diamonds))), max(1, min(9999, int(count))), clean_name(gift) if gift else "Quà")
            return [self._store_event(db, event_id, fingerprint, result)]

    def _live_chat(self, player_id, nickname, text, event_id, avatar):
        text = "".join(char for char in str(text or "") if char.isprintable()).strip()[:160]
        with self.database() as db:
            session = db.execute("SELECT scene FROM sessions LIMIT 1").fetchone()
            player = self._player(db, player_id)
        in_station = session["scene"] == "station"
        station_cmd, _ = parse_station(normalize(text), relaxed=True) if in_station else (None, None)
        command = None if station_cmd else parse_command(text, relaxed=True)
        if not station_cmd and not command:
            # Ordinary chatter only decorates someone who already has a character.
            if not player or not text:
                return []
            return [{"ok": True, "changed": False, "broadcast": True, "code": "CHAT", "message": "", "event_id": event_id, "player": {key: player[key] for key in ("id", "nickname", "skin", "avatar")}, "text": text[:60]}]
        results = []
        if not player and command != "join":
            # One comment is enough on a delayed LIVE: enroll first, then run the command.
            joined = self.command(player_id, nickname, "vào làm", f"{event_id}:join", avatar=avatar)
            results.append(joined)
            if not joined["ok"]:
                return results
        results.append(self.command(player_id, nickname, text, event_id, avatar=avatar, relaxed=True))
        return results

    def _live_enter(self, player_id, nickname, avatar):
        """A viewer opened the room. In station mode, register them in the waiting queue; in office mode, announce only."""
        now = self.clock()
        with self.database() as db:
            db.execute("BEGIN IMMEDIATE")
            session = db.execute("SELECT scene FROM sessions LIMIT 1").fetchone()
            in_station = bool(session and session["scene"] == "station")
            player = self._player(db, player_id)
            if not in_station:
                if not player:
                    return [{"ok": True, "changed": False, "broadcast": True, "code": "ENTERED", "message": f"{nickname} vừa vào xem. Gõ 1 để vào làm nhé!", "viewer": {"nickname": nickname, "avatar": avatar}}]
                if now - player["last_seen"] < 120:
                    return []
                db.execute("UPDATE players SET nickname=?,last_seen=?,avatar=CASE WHEN ?<>'' THEN ? ELSE avatar END WHERE id=?", (nickname, now, avatar, avatar, player_id))
                player = self._player(db, player_id)
                message = f"{nickname} quay lại công ty."
                seq = self._event(db, "return", message, player)
                return [{"ok": True, "changed": True, "code": "RETURNED", "seq": seq, "message": message, "player": dict(player)}]

            was_waiting = bool(player and player["entered_at"])
            previous_seen = player["last_seen"] if player else 0.0
            player, created = self._enroll(db, player_id, nickname, avatar, now)
            if not player:
                return [{"ok": True, "changed": False, "broadcast": True, "code": "ENTERED", "message": f"{nickname} vừa vào xem. Gõ “lên ghế ngồi”, tên tỉnh hoặc ghế 1–24 để lên xe nhé!", "viewer": {"nickname": nickname, "avatar": avatar}}]
            seated = self._seat_of(db, player_id)
            if seated:
                if not created and now - previous_seen < 120:
                    return []
                message = f"{player['nickname']} quay lại bến xe."
                seq = self._event(db, "return", message, player)
                return [{"ok": True, "changed": True, "broadcast": True, "code": "RETURNED", "cue": "join", "seq": seq, "message": message, "player": dict(player)}]
            if created or not was_waiting:
                db.execute("UPDATE players SET entered_at=? WHERE id=?", (now, player_id))
                player = self._player(db, player_id)
                message = f"{player['nickname']} vừa vào bến xếp hàng! Gõ “lên ghế ngồi”, tên tỉnh hoặc ghế 1–24 để lên xe."
                seq = self._event(db, "enter", message, player)
                viewer = {"id": player["id"], "name": player["nickname"], "nickname": player["nickname"], "skin": player["skin"], "avatar": player["avatar"], "hometown": player["hometown"], "entered_at": player["entered_at"]}
                return [{"ok": True, "changed": True, "broadcast": True, "code": "ENTERED", "cue": "join", "seq": seq, "message": message, "player": dict(player), "viewer": viewer}]
            if now - previous_seen < 120:
                return []
            message = f"{player['nickname']} quay lại bến xe."
            seq = self._event(db, "return", message, player)
            viewer = {"id": player["id"], "name": player["nickname"], "nickname": player["nickname"], "skin": player["skin"], "avatar": player["avatar"], "hometown": player["hometown"], "entered_at": player["entered_at"]}
            return [{"ok": True, "changed": True, "broadcast": True, "code": "RETURNED", "cue": "join", "seq": seq, "message": message, "player": dict(player), "viewer": viewer}]

    def _like(self, db, result, player_id, count, now):
        player = self._player(db, player_id)
        if player:
            db.execute("UPDATE players SET hearts=hearts+?,last_seen=? WHERE id=?", (count, now, player_id))
            player = self._player(db, player_id)
            result["player"] = dict(player)
        session = db.execute("SELECT hearts,boosts,scene FROM sessions LIMIT 1").fetchone()
        hearts = session["hearts"] + count
        gained = hearts // HEART_BOOST
        db.execute("UPDATE sessions SET hearts=?,boosts=boosts+?", (hearts % HEART_BOOST, gained))
        result.update(changed=True, code="LIKED", count=count, boost=bool(gained))
        if gained:
            db.execute("UPDATE players SET last_work=0,last_seat=0")
            if session["scene"] == "station":
                message = f"Đủ {HEART_BOOST} tim! Cả bến xe được tiếp sức, lên xe và đổi ghế ngay không cần chờ."
            else:
                message = f"Đủ {HEART_BOOST} tim! Cả công ty được tiếp sức, làm việc ngay không cần chờ."
            result.update(code="BOOST", cue="month", message=message, seq=self._event(db, "boost", message, player))

    def _follow(self, db, result, player, created):
        result.update(player=dict(player), joined=created)
        if player["followed"]:
            result.update(changed=created, code="FOLLOW_AGAIN")
        else:
            db.execute("UPDATE players SET followed=1,coins=coins+?,xp=xp+10 WHERE id=?", (FOLLOW_BONUS, player["id"]))
            player = self._player(db, player["id"])
            message = f"{player['nickname']} đã follow · ký hợp đồng chính thức · +{dotted(FOLLOW_BONUS)} xu"
            result.update(changed=True, code="FOLLOWED", cue="join", message=message, player=dict(player), seq=self._event(db, "follow", message, player))
        if created and "seq" not in result:
            result["seq"] = self._event(db, "join", f"{player['nickname']} đã vào công ty. Chào đồng nghiệp mới!", player)

    def _share(self, db, result, player, created, now):
        result.update(player=dict(player), joined=created)
        if player["last_share"] and now - player["last_share"] < SHARE_COOLDOWN:
            result.update(changed=created, code="SHARE_COOLDOWN")
        else:
            db.execute("UPDATE players SET last_share=?,coins=coins+?,xp=xp+5 WHERE id=?", (now, SHARE_BONUS, player["id"]))
            player = self._player(db, player["id"])
            message = f"{player['nickname']} rủ thêm đồng nghiệp · +{SHARE_BONUS} xu"
            result.update(changed=True, code="SHARED", cue="salary", message=message, player=dict(player), seq=self._event(db, "share", message, player))
        if created and "seq" not in result:
            result["seq"] = self._event(db, "join", f"{player['nickname']} đã vào công ty. Chào đồng nghiệp mới!", player)

    def _gift(self, db, result, player, created, diamonds, count, gift):
        tier = gift_tier(diamonds)
        db.execute("UPDATE players SET gifts=gifts+? WHERE id=?", (diamonds, player["id"]))
        if tier["reward"]:
            db.execute("UPDATE players SET coins=coins+?", (tier["reward"],))
        if tier["refresh"]:
            db.execute("UPDATE players SET last_work=0")
        player = self._player(db, player["id"])
        times = f" ×{count}" if count > 1 else ""
        message = f"{player['nickname']} tặng {gift}{times} · {tier['label']}"
        if tier["reward"]:
            message += f" · cả công ty +{dotted(tier['reward'])} xu"
        result.update(changed=True, code="GIFTED", cue="bonus", message=message, player=dict(player), joined=created, gift={"name": gift, "count": count, "diamonds": diamonds, "tier": tier["key"], "label": tier["label"], "reward": tier["reward"]}, seq=self._event(db, "gift", message, player))

    def control(self, action: str, event_id: str) -> dict:
        fingerprint = "control:" + action
        with self.database() as db:
            db.execute("BEGIN IMMEDIATE")
            prior = self._lookup_event(db, event_id, fingerprint)
            if prior:
                return prior
            session = db.execute("SELECT * FROM sessions LIMIT 1").fetchone()
            result = {"ok": False, "changed": False, "code": "INVALID_ACTION", "event_id": event_id, "message": "Thao tác chưa phù hợp với giai đoạn hiện tại."}
            message = None
            cue = None
            voice = None
            if action == "depart":
                result.update(self._depart_focus(db, session, self.clock()))
                return self._store_event(db, event_id, fingerprint, result)
            if action in ("pause", "resume"):
                desired = action == "pause"
                db.execute("UPDATE sessions SET paused=?", (desired,))
                message = "Tạm nghỉ một chút, đồng nghiệp ơi." if desired else "Công ty tiếp tục làm việc!"
            elif action in ("scene_office", "scene_station"):
                scene = "station" if action == "scene_station" else "office"
                db.execute("UPDATE sessions SET scene=?", (scene,))
                if scene == "station":
                    message, cue, voice = "Mở bến xe Tết! Bình luận tên tỉnh thành hoặc số ghế 1–24 để nhận vé về quê.", "horn", "station"
                else:
                    message, cue = "Quay lại văn phòng cuối năm. Cùng chạy KPI tiếp nhé!", "click"
            elif action.startswith("route_"):
                route_code = action.removeprefix("route_")
                if route_code in ROUTE_BY_CODE:
                    db.execute("UPDATE sessions SET route=?", (route_code,))
                    route = ROUTE_BY_CODE[route_code]
                    message, cue = f"Đang mở cổng tuyến {route['label']} ({' → '.join(route['stops'])}).", "click"
            elif action in ("mode_open", "mode_scheduled"):
                mode = "open" if action == "mode_open" else "scheduled"
                db.execute("UPDATE sessions SET play_mode=?", (mode,))
                message = "Văn phòng mở cửa tự do. Vào chơi lúc nào cũng được!" if mode == "open" else "Đã bật vòng ba tháng. Quản trò chủ động chuyển tháng khi phù hợp."
            elif action in ("next_month", "bonus") and session["play_mode"] == "open":
                result.update(code="OPEN_MODE", message="Văn phòng đang mở tự do. Bật vòng ba tháng trong phần tùy chọn khi bạn muốn tổ chức.")
            elif action in ("next_month", "bonus") and not db.execute("SELECT 1 FROM players LIMIT 1").fetchone():
                result.update(code="NO_PLAYERS", message="Đón một đồng nghiệp vào làm trước rồi hãy chuyển tháng nhé.")
            elif action == "boss" and (session["phase"] == "OFFICE" or session["play_mode"] == "open") and not session["paused"]:
                message, cue, voice = "Sếp kiểm tra! Cả nhà quay về bàn làm việc nha!", "boss", "boss"
            elif action == "next_month" and session["phase"] == "OFFICE" and session["month"] < 3 and not session["paused"]:
                month = session["month"] + 1
                db.execute("UPDATE sessions SET month=?", (month,))
                db.execute("UPDATE players SET coins=coins+1000,xp=xp+10,last_work=0")
                message, cue, voice = f"Xin chào tháng {month}! Mỗi đồng nghiệp nhận thêm 1.000 xu.", "month", "month"
            elif action == "bonus" and session["phase"] == "OFFICE" and session["month"] == 3 and not session["paused"]:
                db.execute("UPDATE sessions SET phase='BONUS'")
                db.execute("UPDATE players SET coins=coins+3000,xp=xp+20")
                message, cue, voice = "Chốt sổ ba tháng! Cả nhà nhận thưởng 3.000 xu Tết.", "bonus", "bonus"
            if message:
                seq = self._event(db, action, message)
                result.update(ok=True, changed=True, code="CONTROL", seq=seq, message=message, cue=cue, voice=voice, action=action)
            return self._store_event(db, event_id, fingerprint, result)

    def seed(self, target: int) -> dict:
        with self.database() as db:
            db.execute("BEGIN IMMEDIATE")
            now = self.clock()
            added = 0
            for index in range(target):
                if db.execute("SELECT count(*) FROM players").fetchone()[0] >= MAX_PROFILES:
                    break
                player_id = f"demo_{index + 1:03d}"
                name = NAMES[index % len(NAMES)] + (f" {index // len(NAMES) + 1}" if index >= len(NAMES) else "")
                cursor = db.execute("INSERT OR IGNORE INTO players(id,nickname,skin,joined_at,last_seen) VALUES (?,?,?,?,?)", (player_id, name, index % 4, now, now - index * 0.001))
                added += cursor.rowcount
            result = {"ok": True, "changed": bool(added), "code": "SEEDED", "message": f"Đã thêm {added} đồng nghiệp mẫu. Hồ sơ và KPI hiện tại được giữ nguyên.", "added": added}
            if added:
                result["seq"] = self._event(db, "seed", f"Chào đón {added} đồng nghiệp mới vào công ty!")
            return result

    def tick(self) -> dict:
        now = self.clock()
        with self.database() as db:
            session = db.execute("SELECT scene FROM sessions LIMIT 1").fetchone()
            if session["scene"] == "station":
                players = db.execute("""
                    SELECT p.id, p.nickname FROM players p
                    WHERE p.id LIKE 'demo_%' AND p.last_seat<=?
                    AND NOT EXISTS (SELECT 1 FROM seat_reservations r WHERE r.player_id=p.id AND r.status='active')
                    ORDER BY p.last_seat, p.id LIMIT 12""", (now - SEAT_COOLDOWN,)).fetchall()
                action_text = "lên xe"
            else:
                players = db.execute("SELECT id,nickname FROM players WHERE id LIKE 'demo_%' AND last_work<=? ORDER BY last_work,id LIMIT 12", (now - WORK_COOLDOWN,)).fetchall()
                action_text = "làm việc"
        if not players:
            return {"ok": True, "changed": False, "code": "IDLE", "message": "Đồng nghiệp đang chờ lượt tiếp theo."}
        player = random.choice(players)
        return self.command(player["id"], player["nickname"], action_text, str(uuid.uuid4()))
