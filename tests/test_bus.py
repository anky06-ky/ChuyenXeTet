from concurrent.futures import ThreadPoolExecutor
import sqlite3

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.bus import DEPART_DELAY, FIRST_TRIP_BONUS, PROVINCES, ROUTES, SEAT_COOLDOWN, SWITCH_WINDOW, parse_station
from backend.engine import GameEngine, normalize


def station(tmp_path, now):
    engine = GameEngine(tmp_path / "game.sqlite", clock=lambda: now[0])
    assert engine.control("scene_station", "open_station")["ok"]
    return engine


def active_seats(path):
    with sqlite3.connect(path) as db:
        return db.execute("SELECT r.player_id, b.route, b.number, r.seat_no FROM seat_reservations r JOIN buses b ON b.id=r.bus_id WHERE r.status='active' ORDER BY b.route, b.number, r.seat_no").fetchall()


def test_station_comments_parse_like_tiktok_chat():
    assert parse_station(normalize("Lên xe")) == ("board", None)
    assert parse_station(normalize("lên ghế ngồi")) == ("board", None)
    assert parse_station(normalize("lên ghế")) == ("board", None)
    assert parse_station(normalize("ngồi")) == ("board", None)
    assert parse_station(normalize("ra xe")) == ("board", None)
    assert parse_station(normalize("ra xe nha"), relaxed=True) == ("board", None)
    assert parse_station(normalize("vào xe")) == ("board", None)
    assert parse_station(normalize("lên")) == ("board", None)
    assert parse_station(normalize("cho lên")) == ("board", None)
    assert parse_station(normalize("cho lên nha"), relaxed=True) == ("board", None)
    assert parse_station(normalize("lên ghế 5")) == ("seat", 5)
    assert parse_station(normalize("về quê")) == ("board", None)
    assert parse_station(normalize("đi xe")) == ("board", None)
    assert parse_station(normalize("ghế 12")) == ("seat", 12)
    assert parse_station(normalize("Ghế số 7")) == ("seat", 7)
    assert parse_station(normalize("1")) == ("seat", 1)
    assert parse_station(normalize("12")) == ("seat", 12)
    assert parse_station(normalize("25")) == (None, None)
    assert parse_station(normalize("ghế 30")) == ("seat_invalid", 30)
    assert parse_station(normalize("Về Miền Tây")) == ("route", "mien_tay")
    assert parse_station(normalize("xe miền trung")) == ("route", "mien_trung")
    assert parse_station(normalize("tây nguyên")) == ("route", "tay_nguyen")
    assert parse_station(normalize("Xuống xe")) == ("leave", None)
    assert parse_station(normalize("vé")) == ("ticket", None)
    assert parse_station(normalize("ghế 12 nha!!"), relaxed=True) == ("seat", 12)
    assert parse_station(normalize("lên xe thôi"), relaxed=True) == ("board", None)
    assert parse_station(normalize("12 người rồi"), relaxed=True) == (None, None)
    assert parse_station(normalize("bác sĩ ơi"), relaxed=True) == (None, None)
    assert parse_station(normalize("Cà Mau")) == ("province", ("mien_tay", "Cà Mau"))
    assert parse_station(normalize("quê Đồng Tháp")) == ("province", ("mien_tay", "Đồng Tháp"))
    assert parse_station(normalize("Đà Lạt ơi"), relaxed=True) == ("province", ("tay_nguyen", "Đà Lạt"))
    assert parse_station(normalize("về Nghệ An")) == ("province", ("mien_trung", "Nghệ An"))
    assert parse_station(normalize("Hải Phòng nha"), relaxed=True) == ("province", ("mien_bac", "Hải Phòng"))


def test_all_63_provinces_board_matching_routes_and_emit_station_audio_cues(tmp_path):
    now = [1000.0]
    engine = GameEngine(tmp_path / "game.sqlite", clock=lambda: now[0])
    opened = engine.control("scene_station", "open_station")
    assert opened["ok"] and opened["cue"] == "horn" and opened["voice"] == "station"
    all_provinces = [province for route in ROUTES for province in route["provinces"]]
    assert len(all_provinces) == 63
    for route in ROUTES:
        for province in route["provinces"]:
            cmd, arg = parse_station(normalize(province))
            assert cmd == "province" and arg[0] == route["code"]
    samples = [
        ("p_mt", "Út", "về Cà Mau", "mien_tay", "Cà Mau"),
        ("p_tn", "Ban", "Đà Lạt ơi", "tay_nguyen", "Đà Lạt"),
        ("p_mtr", "Nghệ", "quê Nghệ An", "mien_trung", "Nghệ An"),
        ("p_mb", "Hải", "xe Hải Phòng", "mien_bac", "Hải Phòng"),
    ]
    for pid, nick, text, expected_route, expected_home in samples:
        events = engine.live_event("chat", pid, nick, f"evt_{pid}", text=text)
        seated = events[-1]
        assert seated["code"] == "SEATED" and seated["cue"] == "horn"
        assert seated["ticket"]["route"] == expected_route
        assert seated["ticket"]["hometown"] == expected_home
        assert f"quê {expected_home}" in seated["message"]
    snap = engine.snapshot()["station"]
    for _, _, _, expected_route, expected_home in samples:
        route_state = next(r for r in snap["routes"] if r["code"] == expected_route)
        assert route_state["bus"]["seats"][0]["hometown"] == expected_home
    engine.control("route_mien_trung", "focus_mtr")
    departed = engine.control("depart", "depart_mtr")
    assert departed["code"] == "DEPARTED" and departed["cue"] == "depart" and departed["voice"] == "depart"


def test_scenes_gate_commands_and_seats_are_free_and_first_come(tmp_path):
    now = [1000.0]
    engine = GameEngine(tmp_path / "game.sqlite", clock=lambda: now[0])
    engine.command("a", "An", "vào làm", "join_a")
    assert engine.command("a", "An", "lên xe", "early")["code"] == "STATION_CLOSED"
    engine.control("scene_station", "open")
    assert engine.snapshot()["session"]["scene"] == "station"
    assert engine.command("a", "An", "làm việc", "work")["code"] == "WRONG_SCENE"
    seated = engine.command("a", "An", "lên xe", "board")
    assert seated["code"] == "SEATED" and seated["ticket"]["seat"] == 1 and seated["ticket"]["bus_number"] == 1 and seated["ticket"]["route"] == "mien_tay"
    assert engine.command("a", "An", "lên xe", "board_again")["code"] == "ALREADY_SEATED"
    assert engine.command("a", "An", "lên xe", "board")["duplicate"]
    now[0] += SEAT_COOLDOWN
    moved = engine.command("a", "An", "ghế 5", "move")
    assert moved["code"] == "MOVED_SEAT" and moved["ticket"]["seat"] == 5 and moved["moved_from"]["seat"] == 1
    engine.command("b", "Bình", "vào làm", "join_b")
    taken = engine.command("b", "Bình", "5", "steal")
    assert taken["code"] == "SEAT_TAKEN" and taken["suggestion"] == 4 and not taken["ok"]
    assert engine.command("b", "Bình", "4", "near")["code"] == "SEATED"
    assert engine.command("b", "Bình", "ghế 9", "too_fast")["code"] == "COOLDOWN"
    assert active_seats(tmp_path / "game.sqlite") == [("b", "mien_tay", 1, 4), ("a", "mien_tay", 1, 5)]
    assert engine.command("a", "An", "vé", "ticket")["ticket"]["seat"] == 5
    now[0] += SEAT_COOLDOWN
    left = engine.command("a", "An", "xuống xe", "leave")
    assert left["code"] == "LEFT_SEAT" and left["seat"]["seat"] == 5
    assert engine.command("a", "An", "vé", "no_ticket")["code"] == "NO_TICKET"
    engine.control("scene_office", "close")
    assert engine.command("a", "An", "làm việc", "work_again")["code"] == "WORKED"


def test_changing_bus_needs_a_confirming_comment_within_the_window(tmp_path):
    now = [1000.0]
    path = tmp_path / "game.sqlite"
    engine = station(tmp_path, now)
    engine.command("a", "An", "vào làm", "join")
    engine.command("a", "An", "ghế 3", "seat")
    now[0] += SEAT_COOLDOWN
    first = engine.command("a", "An", "miền bắc", "switch_1")
    assert first["code"] == "CONFIRM_SWITCH" and not first["changed"]
    assert active_seats(path) == [("a", "mien_tay", 1, 3)]
    now[0] += SWITCH_WINDOW + 1
    assert engine.command("a", "An", "miền bắc", "switch_2")["code"] == "CONFIRM_SWITCH"
    now[0] += 2
    moved = engine.command("a", "An", "miền bắc", "switch_3")
    assert moved["code"] == "MOVED_SEAT" and moved["ticket"]["route"] == "mien_bac"
    assert active_seats(path) == [("a", "mien_bac", 1, 1)]


def test_one_hundred_viewers_racing_for_one_seat_get_exactly_one_ticket(tmp_path):
    now = [1000.0]
    path = tmp_path / "game.sqlite"
    engine = station(tmp_path, now)
    for index in range(100):
        engine.command(f"p{index}", f"Khách {index}", "vào làm", f"join_{index}")

    def grab(index):
        return engine.command(f"p{index}", f"Khách {index}", "ghế 7", f"grab_{index}")

    with ThreadPoolExecutor(max_workers=16) as pool:
        results = list(pool.map(grab, range(100)))
    assert sum(result["code"] == "SEATED" for result in results) == 1
    assert sum(result["code"] == "SEAT_TAKEN" for result in results) == 99
    assert [row[3] for row in active_seats(path)] == [7]

    def spam(index):
        return engine.command("p0", "Khách 0", "lên xe", f"spam_{index}")

    now[0] += SEAT_COOLDOWN
    with ThreadPoolExecutor(max_workers=12) as pool:
        list(pool.map(spam, range(20)))
    with sqlite3.connect(path) as db:
        assert db.execute("SELECT max(n) FROM (SELECT count(*) n FROM seat_reservations WHERE status='active' GROUP BY player_id)").fetchone()[0] == 1
        with pytest.raises(sqlite3.IntegrityError):
            bus_id, holder = db.execute("SELECT bus_id, player_id FROM seat_reservations WHERE status='active' AND seat_no=7").fetchone()
            db.execute("INSERT INTO seat_reservations(bus_id,player_id,seat_no,created_at,updated_at) VALUES (?,?,7,0,0)", (bus_id, "intruder"))


def test_full_bus_opens_the_next_one_and_departs_after_the_countdown(tmp_path):
    now = [1000.0]
    path = tmp_path / "game.sqlite"
    engine = station(tmp_path, now)
    for index in range(25):
        result = engine.live_event("chat", f"tt_{index}", f"Khách {index}", f"c{index}", text="lên xe")
        assert [item["code"] for item in result] == ["JOINED", "SEATED"]
    assert result[-1]["ticket"]["bus_number"] == 2 and result[-1]["ticket"]["seat"] == 1
    full = next(item for item in engine.live_event("chat", "tt_0", "Khách 0", "c_dup", text="vé"))
    assert full["ticket"]["bus_number"] == 1
    state = engine.snapshot()["station"]
    shown = next(route for route in state["routes"] if route["code"] == "mien_tay")
    assert shown["bus"]["number"] == 1 and shown["bus"]["filled"] == 24 and shown["bus"]["countdown"] == DEPART_DELAY
    assert shown["boarding_buses"] == 2
    now[0] += DEPART_DELAY - 1
    assert engine.station_tick() == []
    now[0] += 1
    departed = engine.station_tick()
    assert len(departed) == 1 and departed[0]["code"] == "DEPARTED" and departed[0]["bus"]["passengers"] == 24
    assert engine.station_tick() == []
    state = engine.snapshot()
    shown = next(route for route in state["station"]["routes"] if route["code"] == "mien_tay")
    assert shown["bus"]["number"] == 2 and shown["bus"]["filled"] == 1 and shown["departed_buses"] == 1 and shown["riders"] == 24
    riders = {player["id"]: player for player in engine.snapshot()["players"]}
    assert riders["tt_0"]["coins"] == FIRST_TRIP_BONUS
    assert len(active_seats(path)) == 1
    now[0] += SEAT_COOLDOWN
    engine.live_event("chat", "tt_0", "Khách 0", "again", text="lên xe")
    engine.control("depart", "manual_depart")
    with sqlite3.connect(path) as db:
        assert db.execute("SELECT trips, coins FROM players WHERE id='tt_0'").fetchone() == (2, FIRST_TRIP_BONUS)


def test_manual_departure_rules_and_focus_route(tmp_path):
    now = [1000.0]
    engine = GameEngine(tmp_path / "game.sqlite", clock=lambda: now[0])
    assert engine.control("depart", "closed")["code"] == "STATION_CLOSED"
    engine.control("scene_station", "open")
    assert engine.control("depart", "nobody")["code"] in ("NO_BUS", "EMPTY_BUS")
    engine.control("route_mien_bac", "focus")
    assert engine.snapshot()["session"]["route"] == "mien_bac"
    engine.command("a", "An", "vào làm", "join")
    assert engine.command("a", "An", "lên xe", "board")["ticket"]["route"] == "mien_bac"
    engine.control("pause", "pause")
    assert engine.control("depart", "paused")["code"] == "PAUSED"
    now[0] += SEAT_COOLDOWN
    assert engine.command("a", "An", "xuống xe", "leave_paused")["code"] == "PAUSED"
    engine.control("resume", "resume")
    departed = engine.control("depart", "go")
    assert departed["code"] == "DEPARTED" and departed["bus"]["route"] == "mien_bac" and departed["bus"]["passengers"] == 1
    assert engine.control("depart", "go")["duplicate"]


def test_gifts_never_buy_a_seat_and_seats_survive_restart(tmp_path):
    now = [1000.0]
    path = tmp_path / "game.sqlite"
    engine = station(tmp_path, now)
    engine.live_event("gift", "tt_rich", "Đại gia", "g1", diamonds=999, gift="Sư tử")
    engine.live_event("chat", "tt_a", "An", "c1", text="ghế 1")
    assert active_seats(path) == [("tt_a", "mien_tay", 1, 1)]
    restored = GameEngine(path, clock=lambda: now[0])
    assert restored.snapshot()["session"]["scene"] == "station"
    seats = next(route for route in restored.snapshot()["station"]["routes"] if route["code"] == "mien_tay")["bus"]["seats"]
    assert seats[0]["id"] == "tt_a" and all(seat is None for seat in seats[1:])
    assert restored.live_event("chat", "tt_rich", "Đại gia", "c2", text="ghế 1")[-1]["code"] == "SEAT_TAKEN"


def test_live_soft_failures_are_shown_to_the_room(tmp_path):
    now = [1000.0]
    engine = station(tmp_path, now)
    engine.live_event("chat", "tt_a", "An", "c1", text="12")
    failure = engine.live_event("chat", "tt_b", "Bình", "c2", text="ghế 12 nha")[-1]
    assert failure["code"] == "SEAT_TAKEN" and failure["broadcast"]
    assert engine.live_event("chat", "tt_a", "An", "c3", text="ghế 13")[-1]["code"] == "COOLDOWN"


def test_old_database_gains_station_tables_without_losing_progress(tmp_path):
    path = tmp_path / "legacy.sqlite"
    with sqlite3.connect(path) as db:
        db.executescript("""
            CREATE TABLE sessions(id TEXT PRIMARY KEY,phase TEXT,month INTEGER,paused INTEGER,version INTEGER,created_at REAL);
            INSERT INTO sessions VALUES ('old','OFFICE',2,0,7,1000);
            CREATE TABLE players(id TEXT PRIMARY KEY,nickname TEXT,skin INTEGER,kpi INTEGER,coins INTEGER,xp INTEGER,joined_at REAL,last_seen REAL,last_work REAL,last_coffee REAL);
            INSERT INTO players VALUES ('old-player','An',0,40,3500,30,1000,1100,1100,0);
        """)
    engine = GameEngine(path)
    state = engine.snapshot()
    assert state["session"]["scene"] == "office" and state["session"]["route"] == "mien_tay"
    assert state["players"][0]["coins"] == 3500 and len(state["station"]["routes"]) == 4
    engine.control("scene_station", "open")
    assert engine.command("old-player", "An", "lên xe", "board")["code"] == "SEATED"


def test_station_api_controls_and_websocket_delivery(tmp_path):
    with TestClient(create_app(tmp_path / "game.sqlite")) as client:
        assert client.post("/api/control", json={"action": "scene_station"}).json()["ok"]
        assert client.post("/api/control", json={"action": "route_tay_nguyen"}).json()["state"]["session"]["route"] == "tay_nguyen"
        assert client.post("/api/control", json={"action": "route_atlantis"}).status_code == 422
        with client.websocket_connect("/ws") as socket:
            assert socket.receive_json()["state"]["station"]["focus"] == "tay_nguyen"
            reply = client.post("/api/live/simulate", json={"kind": "chat", "player_id": "manual_1", "nickname": "Thử", "text": "ghế 9"}).json()
            assert [item["code"] for item in reply["results"]] == ["JOINED", "SEATED"]
            delta = socket.receive_json()
            seats = next(route for route in delta["state"]["station"]["routes"] if route["code"] == "tay_nguyen")["bus"]["seats"]
            assert seats[8]["nickname"] == "Thử"
            direct = client.post("/api/command", json={"player_id": "rehearsal_1", "nickname": "Bạn", "text": "ghế 12"}).json()
            assert direct["code"] == "SEATED" and direct["ticket"]["seat"] == 12
            delta2 = socket.receive_json()
            seats2 = next(route for route in delta2["state"]["station"]["routes"] if route["code"] == "tay_nguyen")["bus"]["seats"]
            assert seats2[11]["nickname"] == "Bạn"


def test_province_collisions_emojis_and_hometown_switch_safety(tmp_path):
    # Verify every key in PROVINCES resolves unambiguously without substring collisions.
    for key, expected in PROVINCES.items():
        assert parse_station(key, relaxed=False) == ("province", expected)
        assert parse_station(key, relaxed=True) == ("province", expected)

    cases = [
        ("ha tinh", "mien_trung", "Hà Tĩnh"),
        ("ha noi", "mien_bac", "Hà Nội"),
        ("quang nam", "mien_trung", "Quảng Nam"),
        ("quang ngai", "mien_trung", "Quảng Ngãi"),
        ("quang ninh", "mien_bac", "Quảng Ninh"),
        ("vinh", "mien_trung", "Vinh"),
        ("vinh long", "mien_tay", "Vĩnh Long"),
        ("vinh phuc", "mien_bac", "Vĩnh Phúc"),
        ("tra vinh", "mien_tay", "Trà Vinh"),
        ("về quê ở Nghệ An", "mien_trung", "Nghệ An"),
        ("❤️ Cà Mau 🚌", "mien_tay", "Cà Mau"),
        ("tphcm ơi", "tay_nguyen", "TP.HCM"),
    ]
    for raw, route, home in cases:
        assert parse_station(normalize(raw), relaxed=True) == ("province", (route, home))
    assert parse_station(normalize("🔥 ghế 12 nha"), relaxed=True) == ("seat", 12)
    assert parse_station(normalize("12 🎉"), relaxed=True) == ("seat", 12)

    now = [1000.0]
    engine = station(tmp_path, now)
    seated = engine.live_event("chat", "tt_h", "Hòa", "c1", text="Cà Mau")[-1]
    assert seated["ticket"]["hometown"] == "Cà Mau"
    now[0] += SEAT_COOLDOWN
    # Unconfirmed cross-route switch must not overwrite the existing hometown on the current bus.
    confirm = engine.live_event("chat", "tt_h", "Hòa", "c2", text="Hà Nội")[-1]
    assert confirm["code"] == "CONFIRM_SWITCH"
    assert engine.snapshot()["players"][0]["hometown"] == "Cà Mau"
    now[0] += 1
    switched = engine.live_event("chat", "tt_h", "Hòa", "c3", text="Hà Nội")[-1]
    assert switched["code"] == "MOVED_SEAT" and switched["ticket"]["hometown"] == "Hà Nội"


def test_viewer_enter_waiting_queue_board_phrases_and_number_seating(tmp_path):
    now = [1000.0]
    engine = station(tmp_path, now)
    av1 = "https://p16-sign-sg.tiktokcdn.com/aweme/100x100/v1.webp"
    av2 = "https://p16-sign-sg.tiktokcdn.com/aweme/100x100/v2.webp"

    e1 = engine.live_event("enter", "tt_q1", "Nick Phụ 1", "e1", avatar=av1)
    assert e1[0]["code"] == "ENTERED" and e1[0]["cue"] == "join" and e1[0]["changed"]
    now[0] += 0.2
    e2 = engine.live_event("enter", "tt_q2", "Nick Phụ 2", "e2", avatar=av2)
    assert e2[0]["code"] == "ENTERED" and e2[0]["cue"] == "join"

    waiting = engine.snapshot()["station"]["waiting"]
    assert [w["id"] for w in waiting] == ["tt_q1", "tt_q2"]
    assert waiting[0]["name"] == "Nick Phụ 1" and waiting[0]["nickname"] == "Nick Phụ 1"
    assert waiting[0]["avatar"] == av1 and waiting[0]["entered_at"] == 1000.0

    # "lên ghế ngồi" seats Viewer 1 onto seat 1 and removes them from waiting queue.
    b1 = engine.live_event("chat", "tt_q1", "Nick Phụ 1", "c1", text="lên ghế ngồi")
    assert [r["code"] for r in b1] == ["SEATED"] and b1[0]["cue"] == "horn"
    assert b1[0]["ticket"]["seat"] == 1
    assert [w["id"] for w in engine.snapshot()["station"]["waiting"]] == ["tt_q2"]

    # Viewer 2 tries "1" (taken -> stays in waiting), then "7" -> seated on seat 7 and leaves waiting.
    taken = engine.live_event("chat", "tt_q2", "Nick Phụ 2", "c2", text="1")
    assert taken[-1]["code"] == "SEAT_TAKEN"
    assert [w["id"] for w in engine.snapshot()["station"]["waiting"]] == ["tt_q2"]

    b2 = engine.live_event("chat", "tt_q2", "Nick Phụ 2", "c3", text="7")
    assert [r["code"] for r in b2] == ["SEATED"] and b2[0]["ticket"]["seat"] == 7
    assert engine.snapshot()["station"]["waiting"] == []

    # Same-route province comment while seated updates hometown cleanly.
    home = engine.live_event("chat", "tt_q1", "Nick Phụ 1", "c4", text="Cà Mau")
    assert home[0]["code"] == "ALREADY_SEATED" and home[0]["changed"] and home[0]["ticket"]["hometown"] == "Cà Mau"

    # Cross-route province comment after cooldown prompts once, then switches cleanly.
    now[0] += SEAT_COOLDOWN
    assert engine.live_event("chat", "tt_q2", "Nick Phụ 2", "c5", text="Nghệ An")[0]["code"] == "CONFIRM_SWITCH"
    now[0] += 1
    moved = engine.live_event("chat", "tt_q2", "Nick Phụ 2", "c6", text="Nghệ An")[0]
    assert moved["code"] == "MOVED_SEAT" and moved["ticket"]["route"] == "mien_trung" and moved["ticket"]["hometown"] == "Nghệ An"

    # Leaving seat places viewer back into waiting queue; departing does not.
    now[0] += SEAT_COOLDOWN
    left = engine.live_event("chat", "tt_q2", "Nick Phụ 2", "c7", text="xuống xe")[0]
    assert left["code"] == "LEFT_SEAT"
    assert [w["id"] for w in engine.snapshot()["station"]["waiting"]] == ["tt_q2"]

    engine.control("depart", "depart_mt")
    assert [w["id"] for w in engine.snapshot()["station"]["waiting"]] == ["tt_q2"]


def test_ra_xe_boards_and_clear_demo_resets_rehearsal_clutter_cleanly(tmp_path):
    with TestClient(create_app(tmp_path / "game.sqlite")) as client:
        assert client.post("/api/control", json={"action": "scene_station"}).json()["ok"]
        assert client.post("/api/demo/seed", json={"count": 5}).json()["added"] == 5
        assert client.post("/api/live/simulate", json={"kind": "chat", "player_id": "demo_001", "nickname": "Minh Anh", "text": "1"}).json()["ok"]
        assert client.post("/api/live/simulate", json={"kind": "chat", "player_id": "manual_giahuy", "nickname": "Gia Huy", "text": "2"}).json()["ok"]
        assert client.post("/api/live/simulate", json={"kind": "like", "player_id": "manual_giahuy", "nickname": "Gia Huy", "count": 220}).json()["ok"]
        assert client.post("/api/live/simulate", json={"kind": "enter", "player_id": "tt_real", "nickname": "♐"}).json()["ok"]

        with client.websocket_connect("/ws") as ws:
            snap = ws.receive_json()["state"]
            assert snap["stats"]["demo_players"] == 5
            assert snap["energy"]["boosts"] == 1
            cleared = client.post("/api/control", json={"action": "clear_demo"}).json()
            assert cleared["ok"] and cleared["action"] == "clear_demo"
            delta = ws.receive_json()["state"]
            assert delta["stats"]["demo_players"] == 0
            assert delta["stats"]["total_players"] == 1
            assert delta["energy"] == {"hearts": 0, "target": 200, "boosts": 0}
            seats = next(r for r in delta["station"]["routes"] if r["code"] == "mien_tay")["bus"]["seats"]
            assert all(s is None for s in seats)

        # Now real viewer boards cleanly with "ra xe" onto seat 1.
        board = client.post("/api/live/simulate", json={"kind": "chat", "player_id": "tt_real", "nickname": "♐", "text": "ra xe"}).json()
        assert board["results"][0]["code"] == "SEATED" and board["results"][0]["ticket"]["seat"] == 1
        assert board["state"]["station"]["waiting"] == []


def test_new_live_room_clears_old_waiting_and_boarding_seats_while_same_room_is_idempotent(tmp_path):
    now = [1000.0]
    path = tmp_path / "game.sqlite"
    engine = station(tmp_path, now)

    # Empty station has no demo or old-room viewers by default.
    initial = engine.snapshot()
    assert initial["station"]["waiting"] == []
    assert all(all(s is None for s in r["bus"]["seats"]) for r in initial["station"]["routes"])
    assert initial["stats"]["demo_players"] == 0

    # Room 1: one departed bus, one un-departed boarding bus with 1 seated viewer, and 1 waiting viewer.
    assert engine.on_live_room("room_1")["changed"]
    assert engine.live_event("chat", "tt_dep", "Cũ Đi", "c_dep", text="Cà Mau")[-1]["code"] == "SEATED"
    assert engine.control("depart", "depart_r1")["code"] == "DEPARTED"
    assert engine.live_event("chat", "tt_seat", "Ngồi Chờ", "c_seat", text="ghế 4")[-1]["code"] == "SEATED"
    assert engine.live_event("enter", "tt_wait", "Xếp Hàng", "e_wait")[0]["code"] == "ENTERED"
    assert engine.live_event("like", "tt_wait", "Xếp Hàng", "l_wait", count=15)[0]["code"] == "LIKED"
    engine.seed(2)

    # Empty room_id or reconnecting to the same room_1 must be a no-op for active waiting/seats.
    assert not engine.on_live_room("")["changed"]
    same = engine.on_live_room("room_1")
    assert not same["changed"]
    snap_same = engine.snapshot()
    assert [w["id"] for w in snap_same["station"]["waiting"]] == ["tt_wait"]
    mt_same = next(r for r in snap_same["station"]["routes"] if r["code"] == "mien_tay")
    assert mt_same["bus"]["seats"][3]["id"] == "tt_seat"

    # Restarting engine and connecting to a NEW room_2 clears waiting queue, boarding seats & rehearsal rows,
    # while preserving departed history and cumulative player profiles.
    now[0] += 3600
    restarted = GameEngine(path, clock=lambda: now[0])
    assert not restarted.on_live_room("room_1")["changed"]
    transition = restarted.on_live_room("room_2")
    assert transition["changed"] and transition["previous_room_id"] == "room_1"
    assert transition["cleared_waiting"] == 1 and transition["cleared_seats"] == 1 and transition["cleared_buses"] == 1

    snap_new = restarted.snapshot()
    assert snap_new["session"]["live_room_id"] == "room_2"
    assert snap_new["station"]["waiting"] == []
    mt_new = next(r for r in snap_new["station"]["routes"] if r["code"] == "mien_tay")
    assert mt_new["bus"]["filled"] == 0 and all(s is None for s in mt_new["bus"]["seats"])
    assert mt_new["bus"]["number"] == 2  # bus 1 already departed; old un-departed bus 2 was cleared cleanly
    assert mt_new["departed_buses"] == 1 and mt_new["riders"] == 1
    assert snap_new["stats"]["demo_players"] == 0
    assert snap_new["stats"]["total_players"] == 3
    by_id = {p["id"]: p for p in snap_new["players"]}
    assert by_id["tt_wait"]["hearts"] == 15
    assert by_id["tt_dep"]["coins"] == FIRST_TRIP_BONUS

    # Returning viewer entering room_2 enters waiting queue cleanly again.
    reenter = restarted.live_event("enter", "tt_wait", "Xếp Hàng", "e_r2")
    assert reenter[0]["code"] == "ENTERED"
    assert [w["id"] for w in restarted.snapshot()["station"]["waiting"]] == ["tt_wait"]
