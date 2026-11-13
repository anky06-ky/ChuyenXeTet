from concurrent.futures import ThreadPoolExecutor
import sqlite3

from fastapi.testclient import TestClient

from backend.app import create_app
from backend.engine import GameEngine


def test_join_aliases_keep_one_identity_and_restart_preserves_work(tmp_path):
    path = tmp_path / "game.sqlite"
    engine = GameEngine(path)
    assert engine.command("user_1", "Minh", "XINVIEC", "join_1")["code"] == "JOINED"
    assert engine.command("user_1", "Minh mới", "vào làm", "join_2")["code"] == "WELCOME_BACK"
    assert engine.command("user_1", "Minh mới", "LAMVIEC", "work_1")["ok"]
    restored = GameEngine(path).snapshot()
    assert restored["stats"]["total_players"] == 1
    assert restored["players"][0]["nickname"] == "Minh mới"
    assert restored["players"][0]["kpi"] == 10
    assert restored["players"][0]["coins"] == 500


def test_duplicate_event_and_conflicting_payload_do_not_mutate_balance(tmp_path):
    engine = GameEngine(tmp_path / "game.sqlite")
    engine.command("u1", "An", "vào làm", "join")
    first = engine.command("u1", "An", "làm việc", "work")
    duplicate = engine.command("u1", "An", "làm việc", "work")
    assert first["ok"] and duplicate["duplicate"] and not duplicate["changed"]
    assert engine.command("u1", "An", "cà phê", "work")["code"] == "EVENT_CONFLICT"
    assert engine.snapshot()["stats"]["total_kpi"] == 10


def test_cooldown_is_persistent_and_advances_with_server_clock(tmp_path):
    now = [1000.0]
    path = tmp_path / "game.sqlite"
    engine = GameEngine(path, clock=lambda: now[0])
    engine.command("u1", "An", "vào làm", "join")
    engine.command("u1", "An", "làm việc", "work_1")
    now[0] += 4
    restored = GameEngine(path, clock=lambda: now[0])
    rejection = restored.command("u1", "An", "làm việc", "work_2")
    assert rejection["code"] == "COOLDOWN" and rejection["remaining"] == 26
    now[0] += 26
    assert restored.command("u1", "An", "làm việc", "work_3")["ok"]
    assert restored.snapshot()["stats"]["total_kpi"] == 20


def test_pause_and_phase_rules_and_once_only_bonus(tmp_path):
    engine = GameEngine(tmp_path / "game.sqlite")
    engine.control("mode_scheduled", "schedule")
    engine.command("u1", "An", "vào làm", "join")
    assert not engine.control("bonus", "early_bonus")["ok"]
    engine.control("pause", "pause")
    assert engine.command("u1", "An", "làm việc", "blocked")["code"] == "PAUSED"
    assert not engine.control("next_month", "blocked_month")["ok"]
    engine.control("resume", "resume")
    engine.control("next_month", "month_2")
    engine.control("next_month", "month_2")
    assert engine.snapshot()["session"]["month"] == 2
    engine.control("next_month", "month_3")
    engine.control("bonus", "bonus")
    engine.control("bonus", "bonus_repeated")
    assert engine.snapshot()["players"][0]["coins"] == 5000
    assert engine.command("u1", "An", "làm việc", "after_bonus")["code"] == "WRONG_PHASE"


def test_parallel_work_requests_never_multiply_kpi(tmp_path):
    engine = GameEngine(tmp_path / "game.sqlite")
    engine.command("u1", "An", "vào làm", "join")
    def send(index):
        return engine.command("u1", "An", "làm việc", f"parallel_{index}")
    with ThreadPoolExecutor(max_workers=12) as pool:
        results = list(pool.map(send, range(100)))
    assert sum(result["code"] == "WORKED" for result in results) == 1
    assert engine.snapshot()["players"][0]["coins"] == 500


def test_700_profiles_only_24_render_slots_and_seed_is_non_destructive(tmp_path):
    engine = GameEngine(tmp_path / "game.sqlite")
    engine.seed(50)
    engine.command("demo_001", "Minh Anh", "làm việc", "work")
    engine.seed(700)
    state = engine.snapshot()
    assert state["stats"]["total_players"] == 700
    assert len(state["players"]) == 24
    assert state["stats"]["total_kpi"] == 10
    assert engine.seed(700)["added"] == 0
    assert engine.command("extra", "Khách", "vào làm", "extra")["code"] == "CAPACITY"
    assert engine.command("demo_001", "Minh Anh", "lương", "profile")["player"]["coins"] == 500


def test_websocket_snapshot_delta_and_reconnect(tmp_path):
    with TestClient(create_app(tmp_path / "game.sqlite")) as client:
        with client.websocket_connect("/ws") as socket:
            assert socket.receive_json()["type"] == "snapshot"
            response = client.post("/api/command", json={"player_id": "u1", "nickname": "An", "text": "vào làm", "event_id": "join"})
            assert response.status_code == 200
            delta = socket.receive_json()
            assert delta["state"]["stats"]["total_players"] == 1
            assert delta["event"]["code"] == "JOINED"
            client.post("/api/command", json={"player_id": "u1", "nickname": "An", "text": "lương", "event_id": "salary"})
            assert socket.receive_json()["event"]["code"] == "PROFILE"
        with client.websocket_connect("/ws") as reconnected:
            assert reconnected.receive_json()["state"]["session"]["version"] == 1


def test_api_rejects_untrusted_origins_and_invalid_payloads(tmp_path):
    with TestClient(create_app(tmp_path / "game.sqlite")) as client:
        assert client.post("/api/demo/seed", json={"count": 1}, headers={"Origin": "https://untrusted.example"}).status_code == 403
        assert client.post("/api/demo/seed", json={"count": 701}).status_code == 422
        assert client.post("/api/command", json={"player_id": "<script>", "nickname": "An", "text": "vào làm"}).status_code == 422
        assert client.get("/api/health").json()["ok"]


def test_empty_open_office_waits_without_advancing_or_inventing_viewers(tmp_path):
    now = [1000.0]
    engine = GameEngine(tmp_path / "game.sqlite", clock=lambda: now[0])
    now[0] += 60 * 60 * 12
    state = engine.snapshot()
    assert state["session"]["play_mode"] == "open"
    assert state["session"]["month"] == 1
    assert state["stats"]["total_players"] == 0
    assert state["audience"] == {"connected": False, "viewer_count": None}
    assert engine.control("next_month", "next")["code"] == "OPEN_MODE"
    engine.control("mode_scheduled", "schedule")
    assert engine.control("next_month", "empty_next")["code"] == "NO_PLAYERS"
    assert engine.snapshot()["session"]["month"] == 1


def test_one_player_can_finish_repeating_missions_and_replay_never_pays_twice(tmp_path):
    now = [1000.0]
    path = tmp_path / "game.sqlite"
    engine = GameEngine(path, clock=lambda: now[0])
    engine.command("solo", "An", "vào làm", "join")
    for index in range(3):
        now[0] += 31
        result = engine.command("solo", "An", "làm việc", f"work_{index}")
        assert result["ok"]
    assert result["mission_completed"]
    assert result["player"]["coins"] == 2000
    assert engine.command("solo", "An", "làm việc", "work_2")["duplicate"]
    restored = GameEngine(path, clock=lambda: now[0]).snapshot()
    assert restored["players"][0]["missions_completed"] == 1
    assert restored["players"][0]["mission_works"] == 0
    assert restored["players"][0]["coins"] == 2000
    assert restored["session"]["month"] == 1
    now[0] += 31
    assert engine.command("solo", "An", "làm việc", "next_mission")["player"]["mission_works"] == 1


def test_free_play_accepts_latecomers_after_scheduled_bonus_without_resetting_balances(tmp_path):
    engine = GameEngine(tmp_path / "game.sqlite")
    engine.command("first", "An", "vào làm", "join")
    engine.control("mode_scheduled", "schedule")
    engine.control("next_month", "month_2")
    engine.control("next_month", "month_3")
    engine.control("bonus", "bonus")
    engine.control("mode_open", "reopen")
    engine.command("late", "Đến muộn", "vào làm", "late_join")
    assert engine.command("late", "Đến muộn", "làm việc", "late_work")["ok"]
    assert engine.command("first", "An", "lương", "salary")["player"]["coins"] == 5000
    assert engine.snapshot()["session"]["phase"] == "BONUS"


def test_existing_database_migrates_to_open_mode_without_losing_progress(tmp_path):
    path = tmp_path / "legacy.sqlite"
    with sqlite3.connect(path) as db:
        db.executescript("""
            CREATE TABLE sessions(id TEXT PRIMARY KEY,phase TEXT,month INTEGER,paused INTEGER,version INTEGER,created_at REAL);
            INSERT INTO sessions VALUES ('old-session','OFFICE',2,0,7,1000);
            CREATE TABLE players(id TEXT PRIMARY KEY,nickname TEXT,skin INTEGER,kpi INTEGER,coins INTEGER,xp INTEGER,joined_at REAL,last_seen REAL,last_work REAL,last_coffee REAL);
            INSERT INTO players VALUES ('old-player','An',0,40,3500,30,1000,1100,1100,0);
        """)
    state = GameEngine(path).snapshot()
    assert state["session"]["play_mode"] == "open"
    assert state["session"]["month"] == 2
    assert state["session"]["version"] == 7
    assert state["players"][0]["coins"] == 3500
    assert state["players"][0]["kpi"] == 40
    assert state["players"][0]["mission_works"] == 0
