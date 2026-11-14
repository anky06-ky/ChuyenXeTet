import asyncio
import shutil

import pytest
from fastapi.testclient import TestClient

from backend.app import avatar_source, create_app
from backend.engine import FOLLOW_BONUS, HEART_BOOST, SHARE_BONUS, GameEngine, parse_command
from backend.live import LiveBridge, normalize_username, player_key

AVATAR = "https://p16-sign-sg.tiktokcdn.com/aweme/100x100/avatar.webp"


def test_live_chat_is_forgiving_and_one_comment_is_enough_to_play(tmp_path):
    engine = GameEngine(tmp_path / "game.sqlite")
    assert parse_command("Vào làm nè!!", relaxed=True) == "join"
    assert parse_command("2", relaxed=True) == "work"
    assert parse_command("2 người nữa nha", relaxed=True) is None
    assert parse_command("nam ơi", relaxed=True) is None
    assert parse_command("vào làm nè") is None
    assert engine.live_event("chat", "tt_1", "An", "c0", text="alo alo") == []
    results = engine.live_event("chat", "tt_1", "An", "c1", avatar=AVATAR, text="làm việc đi")
    assert [result["code"] for result in results] == ["JOINED", "WORKED"]
    player = engine.snapshot()["players"][0]
    assert (player["kpi"], player["coins"], player["avatar"]) == (10, 500, AVATAR)
    assert engine.live_event("chat", "tt_1", "An", "c1", text="làm việc đi")[-1]["duplicate"]
    bubble = engine.live_event("chat", "tt_1", "An", "c2", text="Chúc mừng năm mới")
    assert bubble[0]["code"] == "CHAT" and bubble[0]["broadcast"] and not bubble[0]["changed"]
    assert engine.live_event("chat", "tt_1", "An", "c3", text="nữ")[0]["player"]["skin"] == 1
    assert engine.snapshot()["stats"]["total_kpi"] == 10


def test_follow_pays_once_share_has_cooldown_and_both_enroll(tmp_path):
    now = [1000.0]
    engine = GameEngine(tmp_path / "game.sqlite", clock=lambda: now[0])
    followed = engine.live_event("follow", "tt_2", "Bình", "f1", avatar="javascript:alert(1)")[0]
    assert followed["code"] == "FOLLOWED" and followed["joined"] and followed["player"]["coins"] == FOLLOW_BONUS
    assert followed["player"]["avatar"] == ""
    assert engine.live_event("follow", "tt_2", "Bình", "f1")[0]["duplicate"]
    assert engine.live_event("follow", "tt_2", "Bình", "f2")[0]["code"] == "FOLLOW_AGAIN"
    assert engine.live_event("share", "tt_2", "Bình", "s1")[0]["code"] == "SHARED"
    assert engine.live_event("share", "tt_2", "Bình", "s2")[0]["code"] == "SHARE_COOLDOWN"
    now[0] += 301
    assert engine.live_event("share", "tt_2", "Bình", "s3")[0]["code"] == "SHARED"
    state = engine.snapshot()
    assert state["stats"]["total_players"] == 1
    assert state["players"][0]["coins"] == FOLLOW_BONUS + 2 * SHARE_BONUS


def test_hearts_fill_shared_energy_without_creating_profiles_or_kpi(tmp_path):
    now = [1000.0]
    engine = GameEngine(tmp_path / "game.sqlite", clock=lambda: now[0])
    engine.command("tt_3", "Chi", "vào làm", "join")
    engine.command("tt_3", "Chi", "làm việc", "work")
    assert engine.command("tt_3", "Chi", "làm việc", "blocked")["code"] == "COOLDOWN"
    stranger = engine.live_event("like", "tt_unknown", "Khách", "l1", count=HEART_BOOST - 10)[0]
    assert stranger["code"] == "LIKED" and "player" not in stranger
    boost = engine.live_event("like", "tt_3", "Chi", "l2", count=15)[0]
    assert boost["code"] == "BOOST" and boost["boost"]
    state = engine.snapshot()
    assert state["stats"]["total_players"] == 1
    assert state["energy"] == {"hearts": 5, "target": HEART_BOOST, "boosts": 1}
    assert state["top_hearts"][0]["hearts"] == 15
    assert state["stats"]["total_kpi"] == 10
    assert engine.command("tt_3", "Chi", "làm việc", "refreshed")["code"] == "WORKED"


def test_gifts_thank_the_giver_and_reward_the_whole_office_exactly_once(tmp_path):
    engine = GameEngine(tmp_path / "game.sqlite")
    engine.command("tt_4", "Dung", "vào làm", "join_4")
    rose = engine.live_event("gift", "tt_5", "Giang", "g1", diamonds=1, gift="Rose")[0]
    assert rose["gift"]["tier"] == "lixi" and rose["joined"] and rose["player"]["coins"] == 0
    treat = engine.live_event("gift", "tt_5", "Giang", "g2", diamonds=30, count=3, gift="Donut")[0]
    assert treat["gift"]["tier"] == "treat" and "×3" in treat["message"]
    assert engine.live_event("gift", "tt_5", "Giang", "g2", diamonds=30, count=3, gift="Donut")[0]["duplicate"]
    party = engine.live_event("gift", "tt_5", "Giang", "g3", diamonds=199, gift="Pháo hoa")[0]
    assert party["gift"]["tier"] == "party"
    state = engine.snapshot()
    coins = {player["id"]: player["coins"] for player in state["players"]}
    assert coins == {"tt_4": 1200, "tt_5": 1200}
    assert state["top_gifts"][0]["id"] == "tt_5" and state["top_gifts"][0]["gifts"] == 230
    assert state["stats"]["total_kpi"] == 0


def test_viewer_arrivals_never_enroll_and_known_colleagues_return(tmp_path):
    now = [1000.0]
    engine = GameEngine(tmp_path / "game.sqlite", clock=lambda: now[0])
    arrival = engine.live_event("enter", "tt_6", "Hân", "e1")[0]
    assert arrival["code"] == "ENTERED" and arrival["broadcast"]
    assert engine.snapshot()["stats"]["total_players"] == 0
    engine.command("tt_6", "Hân", "vào làm", "join_6")
    assert engine.live_event("enter", "tt_6", "Hân", "e2") == []
    now[0] += 600
    assert engine.live_event("enter", "tt_6", "Hân", "e3")[0]["code"] == "RETURNED"


def test_identity_and_addresses_are_normalized():
    assert player_key({"id": "6789", "uniqueId": "an.nguyen"}) == "tt_6789"
    assert player_key({"id": "0", "idStr": "6926507410044486658", "nickname": "♐"}) == "tt_6926507410044486658"
    assert player_key({"id": "0", "uniqueId": "an.nguyen"}) == "ttu_an-nguyen"
    assert (player_key({"secUid": "MS4wLjABAAAA123"}) or "").startswith("tts_")
    assert player_key({"nickname": "không có id"}) is None
    assert normalize_username(" https://www.tiktok.com/@tet.live/live?x=1 ") == "tet.live"
    assert normalize_username("@tetlive") == "tetlive"
    assert avatar_source(AVATAR) == AVATAR
    for unsafe in ("http://p16.tiktokcdn.com/a.webp", "https://tiktokcdn.com.evil.example/a.webp", "https://127.0.0.1/a.webp", "https://user:pw@p16.tiktokcdn.com/a.webp", "https://p16.tiktokcdn.com:8443/a.webp", ""):
        assert avatar_source(unsafe) is None


def test_bridge_drops_duplicates_merges_likes_and_keeps_order(tmp_path):
    async def scenario():
        engine = GameEngine(tmp_path / "game.sqlite")
        batches = []

        async def publish(results):
            batches.append(results)

        bridge = LiveBridge(engine, publish, tmp_path)
        bridge._ensure_workers()
        viewer = {"id": "77", "nickname": "Khoa", "avatar": AVATAR}
        bridge.accept("chat", viewer, {"id": "m1", "text": "1"})
        bridge.accept("chat", viewer, {"id": "m1", "text": "1"})
        bridge.accept("chat", viewer, {"id": "m2", "text": "2"})
        for index in range(30):
            bridge.accept("like", viewer, {"id": f"like{index}", "count": 5})
        bridge.accept("gift", viewer, {"id": "g1", "gift": {"name": "Rose", "count": 2, "diamonds": 2}})
        for _ in range(60):
            await asyncio.sleep(0.05)
            if any(result["code"] == "LIKED" for batch in batches for result in batch):
                break
        await bridge.close()
        codes = [result["code"] for batch in batches for result in batch]
        assert codes == ["JOINED", "WORKED", "GIFTED", "LIKED"]
        assert bridge.state["counters"]["duplicate"] == 1 and bridge.state["counters"]["like"] == 150
        player = engine.snapshot()["players"][0]
        assert (player["id"], player["kpi"], player["hearts"], player["gifts"]) == ("tt_77", 10, 150, 2)

    asyncio.run(scenario())


@pytest.mark.skipif(not shutil.which("node"), reason="Node.js is required for the connector process")
def test_bridge_supervises_a_connector_process_end_to_end(tmp_path):
    fake = tmp_path / "fake-connector.mjs"
    fake.write_text("""
        import readline from 'node:readline';
        const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
        const user = { id: '4242', uniqueId: 'mai.tet', nickname: 'Mai Tết', avatar: '' };
        send({ t: 'status', status: 'connecting', uniqueId: process.argv[2] });
        send({ t: 'status', status: 'connected', uniqueId: process.argv[2], roomId: 'room9' });
        send({ t: 'viewers', count: 37 });
        send({ t: 'chat', id: 'a1', user, text: 'vào làm' });
        send({ t: 'chat', id: 'a1', user, text: 'vào làm' });
        send({ t: 'follow', id: 'a2', user });
        send({ t: 'gift', id: 'a3', user, gift: { name: 'Rose', count: 1, diamonds: 1 } });
        send('not an object');
        process.stdout.write('not json\\n');
        readline.createInterface({ input: process.stdin }).on('line', (line) => { if (line.trim() === 'quit') process.exit(0); });
    """, encoding="utf-8")

    async def scenario():
        engine = GameEngine(tmp_path / "game.sqlite")
        batches = []

        async def publish(results):
            batches.append(results)

        bridge = LiveBridge(engine, publish, tmp_path, connector=fake)
        await bridge.connect("@tet.live")
        for _ in range(100):
            await asyncio.sleep(0.05)
            if any(result["code"] == "GIFTED" for batch in batches for result in batch):
                break
        status = bridge.public()
        process = bridge.process
        await bridge.disconnect()
        for _ in range(60):
            if process.poll() is not None:
                break
            await asyncio.sleep(0.05)
        await bridge.close()
        assert (status["status"], status["unique_id"], status["room_id"], status["viewer_count"]) == ("connected", "tet.live", "room9", 37)
        assert [result["code"] for batch in batches for result in batch] == ["JOINED", "FOLLOWED", "GIFTED"]
        assert process.poll() is not None
        assert bridge.public()["status"] == "idle"
        player = engine.snapshot()["players"][0]
        assert (player["id"], player["nickname"], player["followed"], player["gifts"]) == ("tt_4242", "Mai Tết", 1, 1)

    asyncio.run(scenario())


def test_live_api_rehearses_events_reports_status_and_guards_the_avatar_proxy(tmp_path):
    with TestClient(create_app(tmp_path / "game.sqlite")) as client:
        assert client.get("/api/live/status").json()["status"] == "idle"
        with client.websocket_connect("/ws") as socket:
            first = socket.receive_json()
            assert first["state"]["live"]["status"] == "idle" and first["state"]["mode"] == "mock"
            response = client.post("/api/live/simulate", json={"kind": "gift", "player_id": "manual_1", "nickname": "Thử", "diamonds": 30, "gift": "Donut", "event_id": "sim_gift"})
            assert response.status_code == 200 and response.json()["results"][0]["gift"]["tier"] == "treat"
            delta = socket.receive_json()
            assert delta["events"][0]["code"] == "GIFTED" and delta["state"]["top_gifts"][0]["gifts"] == 30
            client.post("/api/live/simulate", json={"kind": "like", "player_id": "manual_1", "nickname": "Thử", "count": 12})
            assert socket.receive_json()["state"]["energy"]["hearts"] == 12
        rejected = client.post("/api/live/connect", json={"unique_id": "bad name!"}).json()
        assert rejected["status"] == "error" and rejected["code"] == "BAD_USERNAME"
        assert client.post("/api/live/disconnect").json()["status"] == "idle"
        assert client.post("/api/live/simulate", json={"kind": "hack", "player_id": "x", "nickname": "x"}).status_code == 422
        assert client.post("/api/live/connect", json={"unique_id": "tetlive"}, headers={"Origin": "https://untrusted.example"}).status_code == 403
        assert client.get("/api/avatar", params={"u": "https://example.com/a.png"}).status_code == 400
        assert client.get("/api/avatar", params={"u": "https://169.254.169.254/latest"}).status_code == 400


def test_station_live_events_cues_spam_emojis_and_ws_drop_isolation(tmp_path):
    with TestClient(create_app(tmp_path / "game.sqlite")) as client:
        assert client.post("/api/control", json={"action": "scene_station"}).json()["ok"]
        with client.websocket_connect("/ws") as healthy:
            assert healthy.receive_json()["state"]["session"]["scene"] == "station"
            # Connect and immediately drop a second client; healthy client must keep receiving broadcasts.
            with client.websocket_connect("/ws") as dropped:
                assert dropped.receive_json()["type"] == "snapshot"
            long_name = "🌸✨" + "Nguyễn Văn Thật Dài " * 3 + "🚌"
            enter_res = client.post("/api/live/simulate", json={"kind": "enter", "player_id": "tt_long", "nickname": long_name[:24], "event_id": "e_station"}).json()
            assert enter_res["results"][0]["code"] == "ENTERED" and enter_res["results"][0]["cue"] == "join"
            assert [w["id"] for w in enter_res["state"]["station"]["waiting"]] == ["tt_long"]
            ws_enter = healthy.receive_json()
            assert ws_enter["events"][0]["code"] == "ENTERED"
            assert [w["id"] for w in ws_enter["state"]["station"]["waiting"]] == ["tt_long"]

            # Chat with emojis + province seats the waiting viewer directly (cue=horn) and clears waiting queue.
            chat_res = client.post("/api/live/simulate", json={"kind": "chat", "player_id": "tt_long", "nickname": long_name[:24], "text": "🚌 về Nghệ An ❤️", "event_id": "c_station"}).json()
            assert [r["code"] for r in chat_res["results"]] == ["SEATED"]
            assert [r.get("cue") for r in chat_res["results"]] == ["horn"]
            assert chat_res["state"]["station"]["waiting"] == []
            ws_chat = healthy.receive_json()
            assert ws_chat["events"][0]["ticket"]["hometown"] == "Nghệ An"
            assert ws_chat["state"]["station"]["waiting"] == []

            # Emoji-only spam chat must not crash and broadcasts CHAT for seated viewer.
            spam = client.post("/api/live/simulate", json={"kind": "chat", "player_id": "tt_long", "nickname": long_name[:24], "text": "❤️❤️🔥🚌", "event_id": "c_emoji"}).json()
            assert spam["results"][0]["code"] == "CHAT"
            assert healthy.receive_json()["events"][0]["code"] == "CHAT"

            # Follow, share, gift, and 200-heart boost all emit expected cues in station mode.
            assert client.post("/api/live/simulate", json={"kind": "follow", "player_id": "tt_long", "nickname": long_name[:24], "event_id": "f_station"}).json()["results"][0]["cue"] == "join"
            assert healthy.receive_json()["events"][0]["code"] == "FOLLOWED"
            assert client.post("/api/live/simulate", json={"kind": "share", "player_id": "tt_long", "nickname": long_name[:24], "event_id": "s_station"}).json()["results"][0]["cue"] == "salary"
            assert healthy.receive_json()["events"][0]["code"] == "SHARED"
            assert client.post("/api/live/simulate", json={"kind": "gift", "player_id": "tt_long", "nickname": long_name[:24], "diamonds": 99, "gift": "Pháo hoa", "event_id": "g_station"}).json()["results"][0]["cue"] == "bonus"
            assert healthy.receive_json()["events"][0]["code"] == "GIFTED"
            boost = client.post("/api/live/simulate", json={"kind": "like", "player_id": "tt_long", "nickname": long_name[:24], "count": HEART_BOOST, "event_id": "l_station"}).json()
            assert boost["results"][0]["code"] == "BOOST" and boost["results"][0]["cue"] == "month"
            assert healthy.receive_json()["events"][0]["code"] == "BOOST"


def test_bridge_retries_not_live_and_survives_spam(tmp_path):
    fake = tmp_path / "offline-then-live.mjs"
    marker = tmp_path / "attempts.txt"
    fake.write_text(f"""
        import fs from 'node:fs';
        import readline from 'node:readline';
        const marker = {marker.as_posix()!r};
        const attempt = (fs.existsSync(marker) ? Number(fs.readFileSync(marker, 'utf8')) : 0) + 1;
        fs.writeFileSync(marker, String(attempt));
        const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
        send({{ t: 'status', status: 'connecting', uniqueId: process.argv[2] }});
        if (attempt === 1) {{
            send({{ t: 'status', status: 'error', code: 'NOT_LIVE', error: 'offline' }});
            process.exit(1);
        }}
        send({{ t: 'status', status: 'connected', uniqueId: process.argv[2], roomId: 'room_test' }});
        for (let i = 0; i < 30; i++) {{
            send({{ t: 'chat', id: 'spam_' + i, user: {{ id: '999', uniqueId: 'spam.user', nickname: '🔥' + 'A'.repeat(60) }}, text: 'lên xe 🎉' }});
        }}
        readline.createInterface({{ input: process.stdin }}).on('line', (line) => {{ if (line.trim() === 'quit') process.exit(0); }});
    """, encoding="utf-8")

    async def scenario():
        engine = GameEngine(tmp_path / "game.sqlite")
        engine.control("scene_station", "open_station")
        batches = []

        async def publish(results):
            batches.append(results)

        bridge = LiveBridge(engine, publish, tmp_path, connector=fake)
        # Speed up the polite NOT_LIVE retry check while verifying 5.0..6.5s first delay is requested.
        orig_retry = bridge._retry
        observed_delays = []

        async def fast_retry(generation, unique_id, delay):
            observed_delays.append(delay)
            await orig_retry(generation, unique_id, 0.05)

        bridge._retry = fast_retry
        await bridge.connect("@test_channel")
        for _ in range(100):
            await asyncio.sleep(0.05)
            if bridge.public()["status"] == "connected" and any(r.get("code") == "SEATED" for b in batches for r in b):
                break
        status = bridge.public()
        await bridge.close()
        assert len(observed_delays) == 1 and 5.0 <= observed_delays[0] <= 6.5
        assert status["unique_id"] == "test_channel"
        assert status["status"] == "connected"
        assert status["counters"]["chat"] == 30
        players = engine.snapshot()["players"]
        assert len(players) == 1 and len(players[0]["nickname"]) <= 24

    asyncio.run(scenario())


def test_bridge_preserves_back_to_back_joins_and_number_comments(tmp_path):
    async def scenario():
        engine = GameEngine(tmp_path / "game.sqlite")
        engine.control("scene_station", "open_station")
        batches = []

        async def publish(results):
            batches.append(results)

        bridge = LiveBridge(engine, publish, tmp_path)
        bridge._ensure_workers()
        u1 = {"id": "101", "uniqueId": "nick.phu.1", "nickname": "Nick Phụ 1", "avatar": AVATAR}
        u2 = {"id": "102", "uniqueId": "nick.phu.2", "nickname": "Nick Phụ 2", "avatar": AVATAR}
        # Back-to-back enters with id="0" (unset protobuf msgId) must not be throttled or deduped.
        bridge.accept("enter", u1, {"id": "0"})
        bridge.accept("enter", u2, {"id": "0"})
        for _ in range(40):
            await asyncio.sleep(0.05)
            if len(engine.snapshot()["station"]["waiting"]) == 2:
                break
        assert [w["id"] for w in engine.snapshot()["station"]["waiting"]] == ["tt_101", "tt_102"]

        bridge.accept("chat", u1, {"id": "c1", "text": "1"})
        bridge.accept("chat", u2, {"id": "c2", "text": "lên ghế ngồi"})
        for _ in range(40):
            await asyncio.sleep(0.05)
            seats = next(r for r in engine.snapshot()["station"]["routes"] if r["code"] == "mien_tay")["bus"]["seats"]
            if seats[0] and seats[1]:
                break
        await bridge.close()
        seats = next(r for r in engine.snapshot()["station"]["routes"] if r["code"] == "mien_tay")["bus"]["seats"]
        assert seats[0]["id"] == "tt_101" and seats[1]["id"] == "tt_102"
        assert engine.snapshot()["station"]["waiting"] == []

    asyncio.run(scenario())


def test_tunnel_readonly_get_and_ws_allowed_while_post_stays_loopback_only(tmp_path):
    tunnel_host = "tet-overlay-test.trycloudflare.com"
    tunnel_origin = f"https://{tunnel_host}"
    with TestClient(create_app(tmp_path / "game.sqlite")) as client:
        # Loopback POST works cleanly.
        assert client.post("/api/control", json={"action": "scene_station"}).status_code == 200

        # Tunnel GET read-only overlay routes work cleanly.
        for path in ("/", "/?overlay=1", "/api/health", "/api/state", "/api/live/status"):
            res = client.get(path, headers={"Host": tunnel_host})
            assert res.status_code == 200, (path, res.status_code, res.text)
        # /api/avatar reaches handler (400 invalid URL, NOT 403 forbidden).
        assert client.get("/api/avatar", params={"u": "https://example.com/a.png"}, headers={"Host": tunnel_host}).status_code == 400

        # Tunnel WebSocket works for matching origin or absent origin, and blocks cross-site origin.
        with client.websocket_connect("/ws", headers={"Host": tunnel_host, "Origin": tunnel_origin}) as ws:
            snap = ws.receive_json()
            assert snap["type"] == "snapshot" and snap["state"]["session"]["scene"] == "station"
            ws.send_text("ping")
            assert ws.receive_json() == {"type": "pong"}

        from starlette.websockets import WebSocketDisconnect
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect("/ws", headers={"Host": tunnel_host, "Origin": "https://evil.example"}):
                pass

        # ALL POST mutations MUST be strictly blocked (403) over tunnel host or forwarded proxy headers.
        post_cases = [
            ("/api/command", {"player_id": "u1", "nickname": "A", "text": "lên xe"}),
            ("/api/control", {"action": "depart"}),
            ("/api/live/connect", {"unique_id": "@test_channel"}),
            ("/api/live/disconnect", {}),
            ("/api/live/mock", {}),
            ("/api/live/simulate", {"kind": "enter", "player_id": "u1", "nickname": "A"}),
            ("/api/demo/seed", {"count": 1}),
            ("/api/demo/tick", {}),
        ]
        for path, payload in post_cases:
            r_tunnel = client.post(path, json=payload, headers={"Host": tunnel_host, "Origin": tunnel_origin})
            assert r_tunnel.status_code == 403, (path, r_tunnel.status_code)
            r_fwd = client.post(path, json=payload, headers={"X-Forwarded-For": "203.0.113.9"})
            assert r_fwd.status_code == 403, (path, r_fwd.status_code)
            r_fwd_host = client.post(path, json=payload, headers={"X-Forwarded-Host": tunnel_host})
            assert r_fwd_host.status_code == 403, (path, r_fwd_host.status_code)


@pytest.mark.skipif(not shutil.which("node"), reason="Node.js is required for the connector process")
def test_app_autoconnects_on_startup_and_clears_rehearsal_on_connected(tmp_path, monkeypatch):
    import time

    db_path = tmp_path / "game.sqlite"
    seed_engine = GameEngine(db_path)
    seed_engine.control("scene_station", "open_station")
    seed_engine.seed(3)
    seed_engine.live_event("chat", "demo_001", "Tí Còi", "d1", text="1")
    seed_engine.live_event("like", "manual_1", "Gia Huy", "d2", count=81)

    fake = tmp_path / "auto-live.mjs"
    fake.write_text("""
        import readline from 'node:readline';
        const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
        send({ t: 'status', status: 'connecting', uniqueId: process.argv[2] });
        send({ t: 'status', status: 'connected', uniqueId: process.argv[2], roomId: 'room_live' });
        const userA = { id: '0', idStr: '6926507410044486658', uniqueId: '', nickname: '♐', avatar: '' };
        const userTak = { id: '0', uniqueId: 'tak', nickname: 'tak', avatar: '' };
        setTimeout(() => {
            send({ t: 'join', id: '0', user: userA, members: 2 });
            send({ t: 'chat', id: '-1', user: userA, text: '1' });
            send({ t: 'chat', id: '0', user: userTak, text: ' ra xe ' });
            send({ t: 'like', id: '0', user: userTak, count: 5 });
        }, 120);
        setTimeout(() => {
            send({ t: 'status', status: 'reconnecting', uniqueId: process.argv[2] });
            send({ t: 'status', status: 'connected', uniqueId: process.argv[2], roomId: 'room_live' });
        }, 300);
        readline.createInterface({ input: process.stdin }).on('line', (line) => { if (line.trim() === 'quit') process.exit(0); });
    """, encoding="utf-8")

    monkeypatch.setenv("TETLIVE_NO_AUTOCONNECT", "0")
    monkeypatch.setenv("TETLIVE_CHANNEL", "@test_channel")

    with TestClient(create_app(db_path, connector=fake)) as client:
        assert client.app.state.live.on_status is not None
        deadline = time.monotonic() + 5.0
        state = client.get("/api/state").json()
        while time.monotonic() < deadline:
            state = client.get("/api/state").json()
            seats = next(r for r in state["station"]["routes"] if r["code"] == "mien_tay")["bus"]["seats"]
            if state["live"]["status"] == "connected" and seats[0] and seats[1] and state["energy"]["hearts"] == 5:
                break
            time.sleep(0.05)
        assert state["live"]["status"] == "connected"
        assert state["live"]["unique_id"] == "test_channel"
        assert state["stats"]["demo_players"] == 0
        assert state["stats"]["total_players"] == 2
        assert state["energy"] == {"hearts": 5, "target": HEART_BOOST, "boosts": 0}
        seats = next(r for r in state["station"]["routes"] if r["code"] == "mien_tay")["bus"]["seats"]
        assert seats[0]["id"] == "tt_6926507410044486658" and seats[0]["nickname"] == "♐"
        assert seats[1]["id"] == "ttu_tak" and seats[1]["nickname"] == "tak"
        # Wait past reconnect->connected pulse to confirm real players/hearts are preserved.
        time.sleep(0.35)
        after = client.get("/api/state").json()
        assert after["stats"]["total_players"] == 2
        assert after["energy"]["hearts"] == 5


@pytest.mark.skipif(not shutil.which("node"), reason="Node.js is required for the connector process")
def test_app_clears_prior_stream_waiting_and_seats_when_new_room_connects(tmp_path, monkeypatch):
    import sqlite3
    import time

    db_path = tmp_path / "game.sqlite"
    seed_engine = GameEngine(db_path)
    seed_engine.control("scene_station", "open_station")
    seed_engine.live_event("enter", "tt_6928665283280323586", "🦭", "old_e1")
    seed_engine.live_event("chat", "tt_6926507410044486658", "♉", "old_c1", text="ghế 3")
    seed_engine.live_event("like", "tt_6926507410044486658", "♉", "old_l1", count=3)
    # Simulate an existing DB migrated from before live_room_id existed (old waiting + old seat).
    with sqlite3.connect(db_path) as db:
        db.execute("UPDATE sessions SET live_room_id=''")
        db.execute("UPDATE players SET entered_at=1794578059.0 WHERE id='tt_6928665283280323586'")
    assert len(seed_engine.snapshot()["station"]["waiting"]) == 1

    fake = tmp_path / "multi-room.mjs"
    marker = tmp_path / "room-seq.txt"
    fake.write_text(f"""
        import fs from 'node:fs';
        import readline from 'node:readline';
        const marker = {marker.as_posix()!r};
        const seq = (fs.existsSync(marker) ? Number(fs.readFileSync(marker, 'utf8')) : 0) + 1;
        fs.writeFileSync(marker, String(seq));
        const roomId = seq === 1 ? 'room_today_1' : 'room_today_2';
        const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
        send({{ t: 'status', status: 'connecting', uniqueId: process.argv[2] }});
        send({{ t: 'status', status: 'connected', uniqueId: process.argv[2], roomId }});
        if (seq === 1) {{
            setTimeout(() => {{
                send({{ t: 'join', id: '0', user: {{ id: '555', uniqueId: 'fresh.viewer', nickname: 'Khách Mới', avatar: '' }} }});
            }}, 80);
            setTimeout(() => {{
                send({{ t: 'status', status: 'reconnecting', uniqueId: process.argv[2] }});
                send({{ t: 'status', status: 'connected', uniqueId: process.argv[2], roomId: 'room_today_1' }});
            }}, 220);
        }}
        readline.createInterface({{ input: process.stdin }}).on('line', (line) => {{ if (line.trim() === 'quit') process.exit(0); }});
    """, encoding="utf-8")

    monkeypatch.setenv("TETLIVE_NO_AUTOCONNECT", "0")
    monkeypatch.setenv("TETLIVE_CHANNEL", "@test_channel")

    with TestClient(create_app(db_path, connector=fake)) as client:
        assert client.app.state.live.on_status is not None
        deadline = time.monotonic() + 5.0
        state = client.get("/api/state").json()
        while time.monotonic() < deadline:
            state = client.get("/api/state").json()
            waiting_ids = [w["id"] for w in state["station"]["waiting"]]
            if state["live"]["room_id"] == "room_today_1" and waiting_ids == ["tt_555"]:
                break
            time.sleep(0.05)

        assert state["live"]["status"] == "connected"
        assert state["session"]["live_room_id"] == "room_today_1"
        assert [w["id"] for w in state["station"]["waiting"]] == ["tt_555"]
        mt_seats = next(r for r in state["station"]["routes"] if r["code"] == "mien_tay")["bus"]["seats"]
        assert all(s is None for s in mt_seats)
        # Old viewers' cumulative profiles are preserved even though their stale queue/seat was cleared.
        assert state["stats"]["total_players"] == 3

        # Same-room reconnect preserves current stream's waiting queue.
        time.sleep(0.3)
        after_reconnect = client.get("/api/state").json()
        assert [w["id"] for w in after_reconnect["station"]["waiting"]] == ["tt_555"]

        # Connecting to a new room_id clears room_today_1's waiting queue immediately.
        with client.websocket_connect("/ws") as ws:
            assert ws.receive_json()["type"] == "snapshot"
            client.post("/api/live/connect", json={"unique_id": "@test_channel"})
            deadline = time.monotonic() + 5.0
            while time.monotonic() < deadline:
                state2 = client.get("/api/state").json()
                if state2["live"]["status"] == "connected" and state2["live"]["room_id"] == "room_today_2":
                    break
                time.sleep(0.05)
            assert state2["session"]["live_room_id"] == "room_today_2"
            assert state2["station"]["waiting"] == []


def test_app_starts_idle_without_autoconnect_when_channel_unset_or_empty(tmp_path, monkeypatch):
    marker = tmp_path / "spawned.txt"
    fake = tmp_path / "unexpected-connector.mjs"
    fake.write_text(f"""
        import fs from 'node:fs';
        fs.writeFileSync({marker.as_posix()!r}, process.argv[2] || 'called');
    """, encoding="utf-8")

    monkeypatch.delenv("TETLIVE_NO_AUTOCONNECT", raising=False)
    monkeypatch.delenv("TETLIVE_CHANNEL", raising=False)

    with TestClient(create_app(tmp_path / "unset.sqlite", connector=fake)) as client:
        assert client.app.state.live.on_status is not None
        status = client.get("/api/live/status").json()
        state = client.get("/api/state").json()
        assert status["status"] == "idle"
        assert status["unique_id"] == ""
        assert not status["waiting_live"]
        assert state["live"]["status"] == "idle"
        assert state["live"]["unique_id"] == ""
        assert state["mode"] == "mock"
    assert not marker.exists()

    monkeypatch.setenv("TETLIVE_CHANNEL", "   ")
    with TestClient(create_app(tmp_path / "empty.sqlite", connector=fake)) as client:
        status = client.get("/api/live/status").json()
        assert status["status"] == "idle"
        assert status["unique_id"] == ""
        assert not status["waiting_live"]
    assert not marker.exists()
