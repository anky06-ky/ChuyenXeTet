"""Local-only HTTP and WebSocket delivery for TetLive Studio."""

from __future__ import annotations

import asyncio
import hashlib
import os
import re
import sys
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urljoin, urlparse

import httpx
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .engine import GameEngine
from .live import LiveBridge

ROOT = Path(__file__).resolve().parent.parent

# Profile pictures are fetched by this machine, so only TikTok's image CDNs are allowed.
AVATAR_HOSTS = re.compile(r"\.(tiktokcdn\.com|tiktokcdn-us\.com|tiktokcdn-eu\.com|tiktokcdn-asia\.com|ibytedtos\.com|byteimg\.com|tiktokv\.com)$", re.IGNORECASE)
AVATAR_TYPES = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif", "image/avif": ".avif"}
AVATAR_MAX_BYTES = 3 * 1024 * 1024
AVATAR_MAX_FILES = 400
AVATAR_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36"


class CommandInput(BaseModel):
    player_id: str = Field(min_length=1, max_length=80, pattern=r"^[a-zA-Z0-9_-]+$")
    nickname: str = Field(min_length=1, max_length=24)
    text: str = Field(min_length=1, max_length=160)
    event_id: str = Field(default_factory=lambda: str(uuid.uuid4()), max_length=100, min_length=1)


class ControlInput(BaseModel):
    action: str = Field(pattern=r"^(pause|resume|next_month|bonus|boss|mode_open|mode_scheduled|scene_office|scene_station|depart|clear_demo|route_(mien_tay|tay_nguyen|mien_trung|mien_bac))$")
    event_id: str = Field(default_factory=lambda: str(uuid.uuid4()), max_length=100, min_length=1)


class SeedInput(BaseModel):
    count: int = Field(default=50, ge=1, le=700)


class ConnectInput(BaseModel):
    unique_id: str = Field(min_length=1, max_length=120)


class SimulateInput(BaseModel):
    kind: str = Field(pattern=r"^(chat|like|follow|share|gift|enter)$")
    player_id: str = Field(min_length=1, max_length=80, pattern=r"^[a-zA-Z0-9_-]+$")
    nickname: str = Field(min_length=1, max_length=24)
    avatar: str = Field(default="", max_length=2048)
    text: str = Field(default="", max_length=160)
    count: int = Field(default=1, ge=1, le=5000)
    diamonds: int = Field(default=1, ge=1, le=1_000_000)
    gift: str = Field(default="", max_length=24)
    event_id: str = Field(default_factory=lambda: str(uuid.uuid4()), max_length=100, min_length=1)


LOOPBACK_HOSTS = ("127.0.0.1", "localhost", "::1", "testserver")
TUNNEL_READONLY_PATHS = ("/", "/index.html", "/favicon.ico", "/favicon.svg", "/api/health", "/api/state", "/api/live/status", "/api/avatar")
TUNNEL_READONLY_PREFIXES = ("/assets/", "/audio/")


def is_loopback_host(host: str | None) -> bool:
    return (host or "").strip().lower() in LOOPBACK_HOSTS


def is_readonly_overlay_path(path: str) -> bool:
    return path in TUNNEL_READONLY_PATHS or path.startswith(TUNNEL_READONLY_PREFIXES)


def local_origin(origin: str | None) -> bool:
    if not origin:
        return True
    parsed = urlparse(origin)
    return parsed.scheme in ("http", "https") and is_loopback_host(parsed.hostname)


def ws_origin_allowed(origin: str | None, host: str | None) -> bool:
    if is_loopback_host(host):
        return local_origin(origin)
    if not origin:
        return True
    parsed = urlparse(origin)
    return parsed.scheme in ("http", "https") and (parsed.hostname or "").strip().lower() == (host or "").strip().lower()


def avatar_source(raw: str | None) -> str | None:
    value = str(raw or "")
    if len(value) > 2048:
        return None
    try:
        parsed = urlparse(value)
        port = parsed.port
    except ValueError:
        return None
    if parsed.scheme != "https" or port not in (None, 443) or parsed.username or parsed.password or not AVATAR_HOSTS.search(parsed.hostname or ""):
        return None
    return value


def create_app(database_path: str | Path | None = None, connector: Path | None = None) -> FastAPI:
    clients: set[WebSocket] = set()
    database = Path(database_path or os.getenv("TETLIVE_DB", str(ROOT / "data" / "tetlive.sqlite")))
    avatar_dir = database.parent / "avatar-cache"
    avatar_jobs: dict[str, asyncio.Task] = {}
    avatar_slots = asyncio.Semaphore(4)

    def sync_live_room(live: dict | None = None) -> None:
        info = live if live is not None else app.state.live.public()
        if info.get("status") == "connected" and info.get("room_id"):
            app.state.engine.on_live_room(info["room_id"])

    def on_live_status(live: dict) -> None:
        sync_live_room(live)

    def snapshot() -> dict:
        live = app.state.live.public()
        sync_live_room(live)
        state = app.state.engine.snapshot()
        state["live"] = live
        if live["status"] in ("connected", "reconnecting"):
            state["mode"] = "live"
            state["audience"] = {"connected": True, "viewer_count": live["viewer_count"]}
        return state

    async def broadcast(message: dict):
        for websocket in tuple(clients):
            try:
                await asyncio.wait_for(websocket.send_json(message), timeout=1)
            except Exception:
                clients.discard(websocket)

    async def publish_many(results: list[dict]):
        """One state broadcast for a batch of LIVE results; an empty batch announces a status change."""
        sync_live_room()
        await broadcast({"type": "state", "state": snapshot(), "events": results})

    async def depart_watch():
        while True:
            await asyncio.sleep(0.5)
            try:
                departed = app.state.engine.station_tick()
                if departed and clients:
                    await publish_many(departed)
            except asyncio.CancelledError:
                raise
            except Exception as error:
                print(f"[depart_watch] error: {error!r}", file=sys.stderr)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.engine = GameEngine(database)
        app.state.live = LiveBridge(app.state.engine, publish_many, ROOT, connector=connector, on_status=on_live_status)
        depart_task = asyncio.create_task(depart_watch())
        auto_channel = os.getenv("TETLIVE_CHANNEL", "").strip()
        if os.getenv("TETLIVE_NO_AUTOCONNECT", "").strip() != "1" and auto_channel:
            await app.state.live.connect(auto_channel)
        try:
            yield
        finally:
            depart_task.cancel()
            try:
                await depart_task
            except asyncio.CancelledError:
                pass
            await app.state.live.close()
            for websocket in tuple(clients):
                try:
                    await websocket.close()
                except Exception:
                    pass

    app = FastAPI(title="TetLive Studio", lifespan=lifespan)

    @app.middleware("http")
    async def loopback_guard(request: Request, call_next):
        host = request.url.hostname
        if is_loopback_host(host):
            if request.method not in ("GET", "HEAD", "OPTIONS"):
                forwarded_host = request.headers.get("x-forwarded-host", "").split(",")[0].strip().split(":")[0]
                if (forwarded_host and not is_loopback_host(forwarded_host)) or request.headers.get("x-forwarded-for") or request.headers.get("cf-connecting-ip"):
                    return JSONResponse({"detail": "Local access only"}, status_code=403)
                if not local_origin(request.headers.get("origin")):
                    return JSONResponse({"detail": "Local origin required"}, status_code=403)
            return await call_next(request)
        if request.method in ("GET", "HEAD", "OPTIONS") and is_readonly_overlay_path(request.url.path):
            return await call_next(request)
        return JSONResponse({"detail": "Local access only"}, status_code=403)

    async def publish(result: dict):
        state = snapshot()
        if result.get("changed") or result.get("broadcast") or (result.get("ok") and result.get("cue") and not result.get("duplicate")):
            await broadcast({"type": "state", "state": state, "event": result})
        return {**result, "state": state}

    @app.get("/api/health")
    async def health():
        live = app.state.live.public()
        return {"ok": True, "mode": "live" if app.state.live.connected else "mock", "storage": "sqlite", "clients": len(clients), "live": live["status"]}

    @app.get("/api/state")
    async def state():
        return snapshot()

    @app.post("/api/command")
    async def command(body: CommandInput):
        # The rehearsal box accepts comments the way TikTok chat does ("2", "vào làm nè").
        return await publish(app.state.engine.command(body.player_id, body.nickname.strip() or "Đồng nghiệp", body.text, body.event_id, relaxed=True))

    @app.post("/api/control")
    async def control(body: ControlInput):
        return await publish(app.state.engine.control(body.action, body.event_id))

    @app.post("/api/demo/seed")
    async def seed(body: SeedInput):
        return await publish(app.state.engine.seed(body.count))

    @app.post("/api/demo/tick")
    async def tick():
        return await publish(app.state.engine.tick())

    @app.get("/api/live/status")
    async def live_status():
        live = app.state.live.public()
        sync_live_room(live)
        return live

    @app.post("/api/live/connect")
    async def live_connect(body: ConnectInput):
        return await app.state.live.connect(body.unique_id)

    @app.post("/api/live/disconnect")
    async def live_disconnect():
        return await app.state.live.disconnect()

    @app.post("/api/live/mock")
    async def live_mock():
        return await app.state.live.start_mock()

    @app.post("/api/live/simulate")
    async def live_simulate(body: SimulateInput):
        """Rehearse one LIVE interaction through the same rules a real viewer triggers."""
        results = app.state.engine.live_event(body.kind, body.player_id, body.nickname.strip() or "Đồng nghiệp", body.event_id, avatar=body.avatar, text=body.text, count=body.count, diamonds=body.diamonds, gift=body.gift)
        shown = [result for result in results if not result.get("duplicate") and (result.get("changed") or result.get("broadcast") or result.get("cue"))]
        current = snapshot()
        if shown:
            await broadcast({"type": "state", "state": current, "events": shown})
        return {"ok": all(result.get("ok") for result in results), "results": results, "state": current}

    async def fetch_avatar(url: str, target: Path):
        async with avatar_slots:
            async with httpx.AsyncClient(timeout=8, follow_redirects=False, headers={"user-agent": AVATAR_AGENT, "accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8"}) as client:
                for _ in range(3):
                    async with client.stream("GET", url) as response:
                        if response.status_code in (301, 302, 303, 307, 308):
                            # Every hop must stay on the allowlist.
                            url = avatar_source(urljoin(url, response.headers.get("location", "")))
                            if not url:
                                raise ValueError("avatar redirect left the allowlist")
                            continue
                        response.raise_for_status()
                        extension = AVATAR_TYPES.get(response.headers.get("content-type", "").split(";")[0].strip().lower())
                        if not extension:
                            raise ValueError("avatar is not a supported image")
                        chunks, size = [], 0
                        async for chunk in response.aiter_bytes():
                            size += len(chunk)
                            if size > AVATAR_MAX_BYTES:
                                raise ValueError("avatar too large")
                            chunks.append(chunk)
                    avatar_dir.mkdir(parents=True, exist_ok=True)
                    final = target.with_suffix(extension)
                    temporary = final.with_suffix(extension + ".tmp")
                    temporary.write_bytes(b"".join(chunks))
                    temporary.replace(final)
                    files = sorted((item for item in avatar_dir.iterdir() if item.suffix in AVATAR_TYPES.values()), key=lambda item: item.stat().st_mtime)
                    for stale in files[:-AVATAR_MAX_FILES]:
                        stale.unlink(missing_ok=True)
                    return
                raise ValueError("too many avatar redirects")

    def cached_avatar(target: Path) -> Path | None:
        return next((candidate for candidate in (target.with_suffix(extension) for extension in AVATAR_TYPES.values()) if candidate.is_file()), None)

    @app.get("/api/avatar")
    async def avatar(u: str = ""):
        url = avatar_source(u)
        if not url:
            return JSONResponse({"detail": "Unsupported avatar address"}, status_code=400)
        target = avatar_dir / hashlib.sha256(url.encode()).hexdigest()[:40]
        found = cached_avatar(target)
        if not found:
            job = avatar_jobs.get(target.name)
            if not job:
                job = avatar_jobs[target.name] = asyncio.create_task(fetch_avatar(url, target))
                job.add_done_callback(lambda _: avatar_jobs.pop(target.name, None))
            try:
                await asyncio.shield(job)
            except Exception:
                return JSONResponse({"detail": "Avatar unavailable"}, status_code=404)
            found = cached_avatar(target)
            if not found:
                return JSONResponse({"detail": "Avatar unavailable"}, status_code=404)
        media = next(kind for kind, extension in AVATAR_TYPES.items() if extension == found.suffix)
        return FileResponse(found, media_type=media, headers={"Cache-Control": "private, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff"})

    @app.websocket("/ws")
    async def socket(websocket: WebSocket):
        forwarded_host = websocket.headers.get("x-forwarded-host", "").split(",")[0].strip().split(":")[0]
        effective_host = forwarded_host or websocket.url.hostname
        if not ws_origin_allowed(websocket.headers.get("origin"), effective_host):
            await websocket.close(code=1008)
            return
        await websocket.accept()
        clients.add(websocket)
        try:
            await websocket.send_json({"type": "snapshot", "state": snapshot()})
            while True:
                message = await websocket.receive_text()
                if message == "ping":
                    await websocket.send_json({"type": "pong"})
        except WebSocketDisconnect:
            pass
        finally:
            clients.discard(websocket)

    if (ROOT / "dist" / "index.html").is_file():
        app.mount("/", StaticFiles(directory=ROOT / "dist", html=True), name="frontend")
    else:
        @app.get("/")
        async def not_built():
            return JSONResponse({"message": "Run npm run build, then restart the server. Development UI: http://127.0.0.1:5173"})

    return app


app = create_app()
