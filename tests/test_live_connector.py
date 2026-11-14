import asyncio
import json
import shutil
import subprocess
from pathlib import Path

import pytest

from backend.engine import GameEngine
from backend.live import (
    ERROR_JITTER,
    ERROR_RETRY_DELAYS,
    NOT_LIVE_JITTER,
    NOT_LIVE_RETRY_DELAYS,
    LiveBridge,
)

ROOT = Path(__file__).resolve().parent.parent
REAL_CONNECTOR = ROOT / "connector" / "tiktok-connector.mjs"
HAS_NODE = bool(shutil.which("node"))
HAS_NODE_CONNECTOR = (
    HAS_NODE
    and (ROOT / "node_modules" / "piratetok-live-js").is_dir()
    and (ROOT / "node_modules" / "ws").is_dir()
)

REQUIRED_PUBLIC_KEYS = {
    "status",
    "unique_id",
    "room_id",
    "error",
    "code",
    "viewer_count",
    "since",
    "counters",
    "queue",
    "waiting_live",
}


def _install_fast_retry(bridge: LiveBridge, observed: list[tuple[str, float, dict]]):
    orig_retry = bridge._retry

    async def fast_retry(generation: int, unique_id: str, delay: float):
        observed.append((bridge.state.get("code", ""), delay, bridge.public()))
        await orig_retry(generation, unique_id, 0.01)

    bridge._retry = fast_retry


def _wait_until(predicate, timeout: float = 5.0):
    async def runner():
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        while loop.time() < deadline:
            if predicate():
                return True
            await asyncio.sleep(0.02)
        return predicate()

    return runner()


@pytest.mark.skipif(not HAS_NODE, reason="Node.js is required for connector tests")
def test_not_live_progressive_polling_and_reset_on_connect(tmp_path):
    marker = tmp_path / "attempt.txt"
    fake = tmp_path / "not-live-connector.mjs"
    fake.write_text(
        f"""
        import fs from 'node:fs';
        import readline from 'node:readline';
        const marker = {marker.as_posix()!r};
        const attempt = (fs.existsSync(marker) ? Number(fs.readFileSync(marker, 'utf8')) : 0) + 1;
        fs.writeFileSync(marker, String(attempt));
        const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
        send({{ t: 'status', status: 'connecting', uniqueId: process.argv[2] }});
        if (attempt <= 7 || attempt === 9) {{
            send({{ t: 'status', status: 'error', code: 'NOT_LIVE', error: 'offline', detail: 'attempt ' + attempt }});
            process.exit(1);
        }}
        if (attempt === 8) {{
            send({{ t: 'status', status: 'connected', uniqueId: process.argv[2], roomId: 'room_8' }});
            setTimeout(() => {{
                send({{ t: 'status', status: 'error', code: 'NOT_LIVE', error: 'offline again' }});
                process.exit(1);
            }}, 80);
        }} else {{
            send({{ t: 'status', status: 'connected', uniqueId: process.argv[2], roomId: 'room_10' }});
            readline.createInterface({{ input: process.stdin }}).on('line', (line) => {{
                if (line.trim() === 'quit') process.exit(0);
            }});
        }}
        """,
        encoding="utf-8",
    )

    async def scenario():
        engine = GameEngine(tmp_path / "game.sqlite")

        async def publish(_results):
            return None

        bridge = LiveBridge(engine, publish, tmp_path, connector=fake)
        observed: list[tuple[str, float, dict]] = []
        _install_fast_retry(bridge, observed)

        initial = await bridge.connect("@test_channel")
        assert REQUIRED_PUBLIC_KEYS.issubset(initial.keys())
        assert initial["waiting_live"] is True

        ok = await _wait_until(
            lambda: bridge.public()["status"] == "connected" and bridge.public()["room_id"] == "room_10",
            timeout=8.0,
        )
        assert ok, bridge.public()

        final = bridge.public()
        await bridge.close()

        assert final["waiting_live"] is False
        assert final["retry_attempt"] == 0
        assert final["retry_delay"] is None
        assert final["next_retry_at"] is None
        assert final["error"] == ""
        assert final["code"] == ""

        # Attempts 1..7 are NOT_LIVE progressive delays, attempt 8 connected & reset, attempts 8->9 restart at index 0..1.
        assert len(observed) == 9
        expected_bases = [
            *NOT_LIVE_RETRY_DELAYS,
            NOT_LIVE_RETRY_DELAYS[-1],
            NOT_LIVE_RETRY_DELAYS[-1],
            NOT_LIVE_RETRY_DELAYS[0],
            NOT_LIVE_RETRY_DELAYS[1],
        ]
        for (code, delay, snapshot), base in zip(observed, expected_bases):
            assert code == "NOT_LIVE"
            assert base + NOT_LIVE_JITTER[0] <= delay <= base + NOT_LIVE_JITTER[1]
            assert snapshot["waiting_live"] is True
            assert snapshot["retry_delay"] == delay
            assert snapshot["next_retry_at"] is not None

    asyncio.run(scenario())


@pytest.mark.skipif(not HAS_NODE, reason="Node.js is required for connector tests")
def test_transient_errors_backoff_never_stops_and_resets_on_connect(tmp_path):
    marker = tmp_path / "err_attempt.txt"
    fake = tmp_path / "transient-errors.mjs"
    fake.write_text(
        f"""
        import fs from 'node:fs';
        import readline from 'node:readline';
        const marker = {marker.as_posix()!r};
        const attempt = (fs.existsSync(marker) ? Number(fs.readFileSync(marker, 'utf8')) : 0) + 1;
        fs.writeFileSync(marker, String(attempt));
        const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
        send({{ t: 'status', status: 'connecting', uniqueId: process.argv[2] }});
        const modes = ['BLOCKED', 'CONNECT_FAILED', 'TIMEOUT', 'BLOCKED', 'CONNECT_FAILED', 'TIMEOUT'];
        if (attempt <= modes.length) {{
            const code = modes[attempt - 1];
            send({{ t: 'warning', code, error: 'warn ' + code, detail: 'raw ' + code }});
            send({{ t: 'status', status: 'error', code, error: 'err ' + code, detail: 'detail ' + code }});
            process.exit(1);
        }}
        send({{ t: 'status', status: 'connected', uniqueId: process.argv[2], roomId: 'room_ok' }});
        readline.createInterface({{ input: process.stdin }}).on('line', (line) => {{
            if (line.trim() === 'quit') process.exit(0);
        }});
        """,
        encoding="utf-8",
    )

    async def scenario():
        engine = GameEngine(tmp_path / "game.sqlite")

        async def publish(_results):
            return None

        bridge = LiveBridge(engine, publish, tmp_path, connector=fake)
        observed: list[tuple[str, float, dict]] = []
        _install_fast_retry(bridge, observed)

        await bridge.connect("test_channel")
        ok = await _wait_until(lambda: bridge.public()["status"] == "connected", timeout=8.0)
        assert ok, bridge.public()

        connected_pub = bridge.public()
        await bridge.close()

        assert len(observed) == 6
        expected_bases = [6, 12, 20, 30, 30, 30]
        assert list(ERROR_RETRY_DELAYS) == [6, 12, 20, 30]
        for (code, delay, snap), base in zip(observed, expected_bases):
            assert code in ("BLOCKED", "CONNECT_FAILED", "TIMEOUT")
            assert base + ERROR_JITTER[0] <= delay <= base + ERROR_JITTER[1]
            assert snap["waiting_live"] is True
            assert snap["detail"] == f"detail {code}"
            assert snap["last_warning"] and snap["last_warning"]["code"] == code

        assert connected_pub["waiting_live"] is False
        assert connected_pub["retry_attempt"] == 0
        assert connected_pub["last_warning"] is None
        assert connected_pub["detail"] == ""
        assert connected_pub["stderr_tail"] == []

    asyncio.run(scenario())


@pytest.mark.skipif(not HAS_NODE, reason="Node.js is required for connector tests")
def test_permanent_errors_ended_and_disconnect_stop_retries(tmp_path):
    fake = tmp_path / "stop-cases.mjs"
    fake.write_text(
        """
        const mode = process.env.STOP_CASE;
        const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
        send({ t: 'status', status: 'connecting', uniqueId: process.argv[2] });
        if (mode === 'not_found') {
            send({ t: 'status', status: 'error', code: 'NOT_FOUND', error: 'missing', detail: 'UserNotFoundError' });
            process.exit(1);
        }
        if (mode === 'ended') {
            send({ t: 'status', status: 'connected', uniqueId: process.argv[2], roomId: 'r1' });
            setTimeout(() => {
                send({ t: 'status', status: 'ended' });
                process.exit(0);
            }, 40);
        }
        if (mode === 'blocked_wait') {
            send({ t: 'status', status: 'error', code: 'BLOCKED', error: 'blocked', detail: 'HTTP 403' });
            process.exit(1);
        }
        """,
        encoding="utf-8",
    )

    async def scenario(monkeypatch):
        engine = GameEngine(tmp_path / "game.sqlite")

        async def publish(_results):
            return None

        # 1. Invalid / empty username stops immediately with waiting_live=False.
        bridge = LiveBridge(engine, publish, tmp_path, connector=fake)
        bad = await bridge.connect("   ")
        assert bad["status"] == "error" and bad["code"] == "BAD_USERNAME"
        assert bad["waiting_live"] is False
        assert bridge.retry_task is None

        # 2. Permanent NOT_FOUND never schedules a retry and waiting_live becomes False.
        monkeypatch.setenv("STOP_CASE", "not_found")
        await bridge.connect("missing_user")
        assert await _wait_until(lambda: bridge.process is None and bridge.public()["status"] == "error")
        pub = bridge.public()
        assert pub["code"] == "NOT_FOUND"
        assert pub["waiting_live"] is False
        assert bridge.retry_task is None

        # 3. Normal stream end stops cleanly with waiting_live=False.
        monkeypatch.setenv("STOP_CASE", "ended")
        await bridge.connect("live_user")
        assert await _wait_until(lambda: bridge.public()["status"] == "ended")
        assert bridge.public()["waiting_live"] is False
        assert bridge.retry_task is None

        # 4. Explicit disconnect() cancels pending BLOCKED retry and clears waiting_live.
        monkeypatch.setenv("STOP_CASE", "blocked_wait")
        await bridge.connect("blocked_user")
        assert await _wait_until(lambda: bridge.retry_task is not None)
        assert bridge.public()["waiting_live"] is True
        disc = await bridge.disconnect()
        assert disc["status"] == "idle"
        assert disc["waiting_live"] is False
        assert bridge.retry_task is None

        await bridge.close()

    with pytest.MonkeyPatch.context() as mp:
        asyncio.run(scenario(mp))


@pytest.mark.skipif(not HAS_NODE, reason="Node.js is required for connector tests")
def test_stderr_capture_warning_and_pre_connect_reconnecting_guard(tmp_path):
    marker = tmp_path / "crash_once.txt"
    fake = tmp_path / "crash-and-reconnect.mjs"
    fake.write_text(
        f"""
        import fs from 'node:fs';
        import readline from 'node:readline';
        const marker = {marker.as_posix()!r};
        const attempt = (fs.existsSync(marker) ? Number(fs.readFileSync(marker, 'utf8')) : 0) + 1;
        fs.writeFileSync(marker, String(attempt));
        const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
        send({{ t: 'status', status: 'connecting', uniqueId: process.argv[2] }});
        if (attempt === 1) {{
            // Premature reconnecting before initial connected must NOT flip bridge status to reconnecting.
            send({{ t: 'status', status: 'reconnecting', uniqueId: process.argv[2], detail: 'pre-open retry' }});
            send({{ t: 'warning', code: 'BLOCKED', error: 'waf', detail: 'SlardarWAF challenge on ttwid' }});
            process.stderr.write('TypeError: simulated connector crash\\n');
            process.exit(1);
        }}
        send({{ t: 'status', status: 'connected', uniqueId: process.argv[2], roomId: 'room_live' }});
        setTimeout(() => {{
            send({{ t: 'status', status: 'reconnecting', uniqueId: process.argv[2], detail: 'socket dropped' }});
        }}, 60);
        readline.createInterface({{ input: process.stdin }}).on('line', (line) => {{
            if (line.trim() === 'quit') process.exit(0);
        }});
        """,
        encoding="utf-8",
    )

    async def scenario():
        engine = GameEngine(tmp_path / "game.sqlite")
        status_events = []

        async def publish(_results):
            return None

        bridge = LiveBridge(engine, publish, tmp_path, connector=fake, on_status=lambda s: status_events.append(s["status"]))
        observed = []
        _install_fast_retry(bridge, observed)

        await bridge.connect("test_channel")
        # Wait until attempt 1 crashes into retry (before fast retry completes or inspect observed snapshot).
        assert await _wait_until(lambda: len(observed) >= 1 and bridge.public()["status"] == "reconnecting", timeout=6.0)

        first_code, first_delay, snap_before_retry = observed[0]
        assert first_code == "CONNECT_FAILED"
        assert 6.0 <= first_delay <= 8.0
        assert snap_before_retry["status"] == "disconnected"
        assert snap_before_retry["waiting_live"] is True
        assert "TypeError: simulated connector crash" in snap_before_retry["stderr_tail"]
        assert snap_before_retry["last_warning"]["detail"] == "SlardarWAF challenge on ttwid"
        # Before first 'connected', status never became 'reconnecting'.
        first_connected_idx = status_events.index("connected")
        assert "reconnecting" not in status_events[:first_connected_idx]
        # Post-connected 'reconnecting' DOES transition and stays waiting_live=True.
        assert bridge.public()["status"] == "reconnecting"
        assert bridge.public()["waiting_live"] is True

        await bridge.close()

    asyncio.run(scenario())


@pytest.mark.skipif(not HAS_NODE, reason="Node.js is required for connector tests")
def test_on_status_and_engine_on_live_room_contract(tmp_path):
    fake = tmp_path / "room-hook.mjs"
    fake.write_text(
        """
        import readline from 'node:readline';
        const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
        send({ t: 'status', status: 'connecting', uniqueId: process.argv[2] });
        send({ t: 'status', status: 'connected', uniqueId: process.argv[2], roomId: 'room_xyz' });
        readline.createInterface({ input: process.stdin }).on('line', (line) => {
            if (line.trim() === 'quit') process.exit(0);
        });
        """,
        encoding="utf-8",
    )

    class SpyEngine(GameEngine):
        def __init__(self, path):
            super().__init__(path)
            self.rooms = []

        def on_live_room(self, room_id: str):
            self.rooms.append(room_id)
            return {"ok": True, "room_id": room_id}

    async def scenario():
        engine = SpyEngine(tmp_path / "game.sqlite")
        hooked = []

        async def on_status(snap):
            hooked.append((snap["status"], snap["room_id"], snap["waiting_live"]))

        async def publish(_results):
            return None

        bridge = LiveBridge(engine, publish, tmp_path, connector=fake, on_status=on_status)
        await bridge.connect("test_channel")
        assert await _wait_until(lambda: bridge.public()["status"] == "connected")
        await asyncio.sleep(0.05)
        await bridge.close()

        assert engine.rooms == ["room_xyz"]
        assert ("connected", "room_xyz", False) in hooked

    asyncio.run(scenario())


@pytest.mark.skipif(
    not HAS_NODE_CONNECTOR,
    reason="Requires Node.js and npm dependencies (node_modules/piratetok-live-js)",
)
def test_real_connector_bad_username_exits_with_code_2():
    proc = subprocess.run(
        ["node", str(REAL_CONNECTOR), "bad name!"],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=5,
    )
    assert proc.returncode == 2
    lines = [json.loads(line) for line in proc.stdout.splitlines() if line.strip()]
    assert lines == [
        {
            "t": "status",
            "status": "error",
            "code": "BAD_USERNAME",
            "error": "Tên tài khoản TikTok chưa đúng. Nhập dạng @tenkenh.",
        }
    ]


@pytest.mark.skipif(
    not HAS_NODE_CONNECTOR,
    reason="Requires Node.js and npm dependencies (node_modules/piratetok-live-js)",
)
def test_real_connector_offline_slardar_device_blocked_and_wss_protobuf(tmp_path):
    preload = tmp_path / "offline-hooks.mjs"
    wss_server_script = tmp_path / "wss-harness.mjs"

    # Harness starts a local HTTP/WSS mock server, then spawns REAL connector/tiktok-connector.mjs
    # with --import preload redirecting TikTok HTTP + WSS endpoints to the offline harness.
    preload.write_text(
        """
        import module from 'node:module';

        const mode = process.env.MOCK_MODE;
        const port = process.env.MOCK_WSS_PORT;

        module.registerHooks({
          load(url, context, nextLoad) {
            if (url.endsWith('/piratetok-live-js/dist/connection/url.js')) {
              return {
                format: 'module',
                shortCircuit: true,
                source: `export function buildWssUrl(_cdn, roomId) { return "ws://127.0.0.1:${port}/ws?room=" + roomId; }`,
              };
            }
            if (url.endsWith('/piratetok-live-js/dist/connection/supervisor.js')) {
              const res = nextLoad(url, context);
              const patched = String(res.source)
                .replace('export const DEVICE_BLOCKED_DELAY_MS = 2_000;', 'export const DEVICE_BLOCKED_DELAY_MS = 10;')
                .replace('return Math.min(2 ** attempt * 1000, MAX_BACKOFF_MS);', 'return 10;');
              return { ...res, source: patched };
            }
            return nextLoad(url, context);
          },
        });

        globalThis.fetch = async (input, init = {}) => {
          const url = String(input);
          const headers = new Headers();
          if (url.includes('/api-live/user/room')) {
            return new Response('Forbidden', { status: 403 });
          }
          if (url === 'https://www.tiktok.com/' || url === 'https://www.tiktok.com/live' || url === 'https://www.tiktok.com/explore') {
            headers.append('set-cookie', 'ttwid=mock_ttwid_123; Path=/');
            return new Response('<html>ok</html>', { status: 200, headers });
          }
          if (url.includes('/@test_user/live')) {
            if (mode === 'slardar_waf') {
              return new Response('<html><script>"slardarClient":"SlardarWAF"</script></html>', { status: 200 });
            }
            const sigi = JSON.stringify({
              LiveRoom: { liveRoomUserInfo: { user: { id: '55', roomId: '999888777', status: 2 }, liveRoom: { status: 2 } } },
            });
            return new Response(`<html><script id="SIGI_STATE">${sigi}</script></html>`, { status: 200 });
          }
          return new Response('not mocked: ' + url, { status: 500 });
        };
        """,
        encoding="utf-8",
    )

    wss_server_script.write_text(
        f"""
        import http from 'node:http';
        import {{ spawn }} from 'node:child_process';
        import {{ WebSocketServer }} from {(ROOT / 'node_modules/ws/wrapper.mjs').as_uri()!r};
        import {{ root }} from {(ROOT / 'node_modules/piratetok-live-js/dist/proto/schema.js').as_uri()!r};
        import {(ROOT / 'node_modules/piratetok-live-js/dist/proto/messages.js').as_uri()!r};

        const mode = process.argv[2];
        const PushFrame = root.lookupType('WebcastPushFrame');
        const ResponseMsg = root.lookupType('WebcastResponse');
        const MemberMsg = root.lookupType('WebcastMemberMessage');
        const ChatMsg = root.lookupType('WebcastChatMessage');
        const LikeMsg = root.lookupType('WebcastLikeMessage');
        const SocialMsg = root.lookupType('WebcastSocialMessage');
        const GiftMsg = root.lookupType('WebcastGiftMessage');
        const RoomSeqMsg = root.lookupType('WebcastRoomUserSeqMessage');

        function encodeEventFrame(method, msgType, payloadObj) {{
          const payload = msgType.encode(msgType.create(payloadObj)).finish();
          const resp = ResponseMsg.encode(ResponseMsg.create({{
            messages: [{{ method, payload }}],
            needsAck: false,
          }})).finish();
          return PushFrame.encode(PushFrame.create({{
            payloadEncoding: 'pb',
            payloadType: 'msg',
            payload: resp,
          }})).finish();
        }}

        const server = http.createServer();
        const wss = new WebSocketServer({{ noServer: true }});
        server.on('upgrade', (req, socket, head) => {{
          if (mode === 'device_blocked') {{
            socket.write('HTTP/1.1 403 Forbidden\\r\\nhandshake-msg: DEVICE_BLOCKED\\r\\nhandshake-status: 200\\r\\n\\r\\n');
            socket.destroy();
            return;
          }}
          wss.handleUpgrade(req, socket, head, (ws) => {{
            // Emit member with action=0, user.id="0", msgId="0" AND action=1, plus chat/like/follow/share/gift/viewers.
            ws.send(encodeEventFrame('WebcastMemberMessage', MemberMsg, {{
              common: {{ msgId: 0 }},
              action: 0,
              user: {{ id: 0, uniqueId: 'tak', nickname: 'tak' }},
              memberCount: 12,
            }}));
            ws.send(encodeEventFrame('WebcastMemberMessage', MemberMsg, {{
              common: {{ msgId: '1001' }},
              action: 1,
              user: {{ id: '6926507410044486658', nickname: '♐' }},
              memberCount: 13,
            }}));
            ws.send(encodeEventFrame('WebcastChatMessage', ChatMsg, {{
              common: {{ msgId: '1002' }},
              user: {{ id: 0, uniqueId: 'tak', nickname: 'tak' }},
              content: 'vào làm',
            }}));
            ws.send(encodeEventFrame('WebcastLikeMessage', LikeMsg, {{
              common: {{ msgId: '1003' }},
              user: {{ id: '6926507410044486658', nickname: '♐' }},
              count: 7,
              total: 7,
            }}));
            ws.send(encodeEventFrame('WebcastSocialMessage', SocialMsg, {{
              common: {{ msgId: '1004' }},
              action: 1,
              user: {{ id: '6926507410044486658', nickname: '♐' }},
            }}));
            ws.send(encodeEventFrame('WebcastSocialMessage', SocialMsg, {{
              common: {{ msgId: '1005' }},
              action: 3,
              user: {{ id: '6926507410044486658', nickname: '♐' }},
            }}));
            ws.send(encodeEventFrame('WebcastGiftMessage', GiftMsg, {{
              common: {{ msgId: '1006' }},
              giftId: 5655,
              repeatCount: 2,
              repeatEnd: 1,
              user: {{ id: '6926507410044486658', nickname: '♐' }},
              gift: {{ id: 5655, name: 'Rose', diamondCount: 1 }},
            }}));
            ws.send(encodeEventFrame('WebcastRoomUserSeqMessage', RoomSeqMsg, {{
              totalUser: 42,
            }}));
            setTimeout(() => {{ ws.close(); }}, 150);
          }});
        }});

        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = server.address().port;
        const child = spawn(process.execPath, ['--import', {preload.as_uri()!r}, {str(REAL_CONNECTOR)!r}, 'test_user'], {{
          cwd: {str(ROOT)!r},
          env: {{ ...process.env, MOCK_MODE: mode, MOCK_WSS_PORT: String(port) }},
          stdio: ['pipe', 'pipe', 'pipe'],
        }});
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (c) => {{
          stdout += c.toString();
          if (mode === 'wss_events' && stdout.includes('"t":"viewers"')) {{
            child.stdin.write('quit\\n');
          }}
        }});
        child.stderr.on('data', (c) => {{ stderr += c.toString(); }});
        child.on('exit', (code) => {{
          server.close();
          process.stdout.write(JSON.stringify({{ code, stderr, lines: stdout.trim().split('\\n').filter(Boolean).map((l) => JSON.parse(l)) }}));
        }});
        """,
        encoding="utf-8",
    )

    def run_harness(mode: str) -> dict:
        proc = subprocess.run(
            ["node", str(wss_server_script), mode],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=10,
        )
        assert proc.returncode == 0, proc.stderr
        return json.loads(proc.stdout)

    # 1. SlardarWAF on /@user/live after HTTP 403 on /api-live/user/room -> code=BLOCKED with SlardarWAF detail.
    slardar = run_harness("slardar_waf")
    assert slardar["code"] == 1
    assert slardar["stderr"] == ""
    statuses = [m for m in slardar["lines"] if m.get("t") == "status"]
    assert [s["status"] for s in statuses] == ["connecting", "error"]
    assert statuses[-1]["code"] == "BLOCKED"
    assert "SlardarWAF" in statuses[-1]["detail"]

    # 2. DEVICE_BLOCKED on WSS handshake -> surfaces BLOCKED warning + final BLOCKED error (never CONNECT_FAILED or pre-connect reconnecting).
    dev_blocked = run_harness("device_blocked")
    assert dev_blocked["code"] == 1
    assert dev_blocked["stderr"] == ""
    db_statuses = [m for m in dev_blocked["lines"] if m.get("t") == "status"]
    db_warnings = [m for m in dev_blocked["lines"] if m.get("t") == "warning"]
    assert [s["status"] for s in db_statuses] == ["connecting", "error"]
    assert db_statuses[-1]["code"] == "BLOCKED"
    assert "DEVICE_BLOCKED" in db_statuses[-1]["detail"]
    assert any(w["code"] == "BLOCKED" and "DEVICE_BLOCKED" in w["detail"] for w in db_warnings)

    # 3. HTTP 403 fallback to /@test_user/live SIGI_STATE + real protobuf event stream -> connected + all events normalized.
    events = run_harness("wss_events")
    assert events["code"] == 0
    assert events["stderr"] == ""
    ev_lines = events["lines"]
    assert any(m.get("t") == "warning" and m.get("code") == "BLOCKED" for m in ev_lines)
    assert any(m.get("t") == "status" and m.get("status") == "connected" and m.get("roomId") == "999888777" for m in ev_lines)
    joins = [m for m in ev_lines if m.get("t") == "join"]
    assert len(joins) == 2
    assert joins[0]["id"] == "" and joins[0]["user"]["id"] == "" and joins[0]["user"]["uniqueId"] == "tak"
    assert joins[1]["user"]["id"] == "6926507410044486658" and joins[1]["user"]["nickname"] == "♐"
    chats = [m for m in ev_lines if m.get("t") == "chat"]
    assert len(chats) == 1 and chats[0]["text"] == "vào làm" and chats[0]["user"]["uniqueId"] == "tak"
    likes = [m for m in ev_lines if m.get("t") == "like"]
    assert len(likes) == 1 and likes[0]["count"] == 7
    follows = [m for m in ev_lines if m.get("t") == "follow"]
    assert len(follows) == 1
    shares = [m for m in ev_lines if m.get("t") == "share"]
    assert len(shares) == 1
    gifts = [m for m in ev_lines if m.get("t") == "gift"]
    assert len(gifts) == 1 and gifts[0]["gift"]["diamonds"] == 2
    viewers = [m for m in ev_lines if m.get("t") == "viewers"]
    assert len(viewers) == 1 and viewers[0]["count"] == 42
