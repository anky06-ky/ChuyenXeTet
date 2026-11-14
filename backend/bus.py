"""Bus station rules: free tickets, 24-seat buses and one active seat per viewer.

Mixed into GameEngine so every seat change shares the engine's lock, SQLite
transaction and idempotency table. Partial UNIQUE indexes are the last line of
defence: a seat can hold one active reservation, a viewer can hold one seat.
"""

from __future__ import annotations

import re
import sqlite3

ROUTES = (
    {
        "code": "mien_tay",
        "label": "Miền Tây",
        "stops": ["Long An", "Tiền Giang", "Cần Thơ", "Đồng Tháp", "An Giang", "Kiên Giang", "Cà Mau"],
        "provinces": [
            "Long An", "Tiền Giang", "Bến Tre", "Trà Vinh", "Vĩnh Long", "Đồng Tháp",
            "An Giang", "Kiên Giang", "Cần Thơ", "Hậu Giang", "Sóc Trăng", "Bạc Liêu", "Cà Mau",
        ],
        "minutes": 7,
        "color": "#2f8a62",
    },
    {
        "code": "tay_nguyen",
        "label": "Tây Nguyên",
        "stops": ["TP.HCM", "Đồng Nai", "Bình Phước", "Lâm Đồng", "Đắk Lắk", "Gia Lai", "Kon Tum"],
        "provinces": [
            "Kon Tum", "Gia Lai", "Đắk Lắk", "Đắk Nông", "Lâm Đồng", "Bình Phước",
            "Tây Ninh", "Bình Dương", "Đồng Nai", "Bà Rịa - Vũng Tàu", "TP.HCM",
        ],
        "minutes": 9,
        "color": "#b0662a",
    },
    {
        "code": "mien_trung",
        "label": "Miền Trung",
        "stops": ["Phan Thiết", "Nha Trang", "Quy Nhơn", "Đà Nẵng", "Huế", "Nghệ An", "Thanh Hóa"],
        "provinces": [
            "Bình Thuận", "Ninh Thuận", "Khánh Hòa", "Phú Yên", "Bình Định", "Quảng Ngãi",
            "Quảng Nam", "Đà Nẵng", "Thừa Thiên Huế", "Quảng Trị", "Quảng Bình", "Hà Tĩnh", "Nghệ An", "Thanh Hóa",
        ],
        "minutes": 11,
        "color": "#2f6fa8",
    },
    {
        "code": "mien_bac",
        "label": "Miền Bắc",
        "stops": ["Ninh Bình", "Nam Định", "Thái Bình", "Hà Nội", "Hải Phòng", "Quảng Ninh", "Lào Cai"],
        "provinces": [
            "Hà Nội", "Hải Phòng", "Quảng Ninh", "Hải Dương", "Hưng Yên", "Bắc Ninh", "Bắc Giang",
            "Vĩnh Phúc", "Thái Bình", "Nam Định", "Hà Nam", "Ninh Bình", "Phú Thọ", "Thái Nguyên",
            "Tuyên Quang", "Hà Giang", "Cao Bằng", "Bắc Kạn", "Lạng Sơn", "Lào Cai", "Yên Bái",
            "Sơn La", "Điện Biên", "Lai Châu", "Hòa Bình",
        ],
        "minutes": 13,
        "color": "#b8352a",
    },
)
ROUTE_BY_CODE = {route["code"]: route for route in ROUTES}
SEATS = 24
WAITING_LIMIT = 32         # max active unseated viewers shown queuing at the bus station
SEAT_COOLDOWN = 5          # seconds between seat commands per viewer
SWITCH_WINDOW = 30         # a bus change must be confirmed within this many seconds
DEPART_DELAY = 10          # a full bus leaves this many seconds after its last seat is taken
FIRST_TRIP_BONUS = 500     # virtual lì xì for a viewer's first ride home, paid once
ROUTE_WORDS = {
    "mien tay": "mien_tay", "tay": "mien_tay", "mt": "mien_tay",
    "tay nguyen": "tay_nguyen", "tn": "tay_nguyen",
    "mien trung": "mien_trung", "trung": "mien_trung",
    "mien bac": "mien_bac", "bac": "mien_bac", "mb": "mien_bac",
}
PROVINCES: dict[str, tuple[str, str]] = {
    # Miền Tây (13 tỉnh thành + thành phố lớn)
    "long an": ("mien_tay", "Long An"), "tan an": ("mien_tay", "Long An"),
    "tien giang": ("mien_tay", "Tiền Giang"), "my tho": ("mien_tay", "Mỹ Tho"), "go cong": ("mien_tay", "Tiền Giang"),
    "ben tre": ("mien_tay", "Bến Tre"),
    "tra vinh": ("mien_tay", "Trà Vinh"),
    "vinh long": ("mien_tay", "Vĩnh Long"),
    "dong thap": ("mien_tay", "Đồng Tháp"), "cao lanh": ("mien_tay", "Cao Lãnh"), "sa dec": ("mien_tay", "Sa Đéc"), "sadec": ("mien_tay", "Sa Đéc"),
    "an giang": ("mien_tay", "An Giang"), "long xuyen": ("mien_tay", "Long Xuyên"), "chau doc": ("mien_tay", "Châu Đốc"),
    "kien giang": ("mien_tay", "Kiên Giang"), "rach gia": ("mien_tay", "Rạch Giá"), "phu quoc": ("mien_tay", "Phú Quốc"), "ha tien": ("mien_tay", "Hà Tiên"),
    "can tho": ("mien_tay", "Cần Thơ"),
    "hau giang": ("mien_tay", "Hậu Giang"), "vi thanh": ("mien_tay", "Vị Thanh"), "nga bay": ("mien_tay", "Hậu Giang"),
    "soc trang": ("mien_tay", "Sóc Trăng"),
    "bac lieu": ("mien_tay", "Bạc Liêu"),
    "ca mau": ("mien_tay", "Cà Mau"), "camau": ("mien_tay", "Cà Mau"),
    # Tây Nguyên & Đông Nam Bộ (11 tỉnh thành + thành phố lớn)
    "kon tum": ("tay_nguyen", "Kon Tum"), "kontum": ("tay_nguyen", "Kon Tum"),
    "gia lai": ("tay_nguyen", "Gia Lai"), "gialai": ("tay_nguyen", "Gia Lai"), "pleiku": ("tay_nguyen", "Pleiku"),
    "dak lak": ("tay_nguyen", "Đắk Lắk"), "dac lac": ("tay_nguyen", "Đắk Lắk"), "daklak": ("tay_nguyen", "Đắk Lắk"),
    "buon ma thuot": ("tay_nguyen", "Buôn Ma Thuột"), "ban me thuot": ("tay_nguyen", "Buôn Ma Thuột"), "buon me thuot": ("tay_nguyen", "Buôn Ma Thuột"), "bmt": ("tay_nguyen", "Buôn Ma Thuột"),
    "dak nong": ("tay_nguyen", "Đắk Nông"), "dac nong": ("tay_nguyen", "Đắk Nông"), "daknong": ("tay_nguyen", "Đắk Nông"), "gia nghia": ("tay_nguyen", "Gia Nghĩa"),
    "lam dong": ("tay_nguyen", "Lâm Đồng"), "da lat": ("tay_nguyen", "Đà Lạt"), "dalat": ("tay_nguyen", "Đà Lạt"), "bao loc": ("tay_nguyen", "Bảo Lộc"),
    "binh phuoc": ("tay_nguyen", "Bình Phước"), "dong xoai": ("tay_nguyen", "Đồng Xoài"),
    "tay ninh": ("tay_nguyen", "Tây Ninh"),
    "binh duong": ("tay_nguyen", "Bình Dương"), "thu dau mot": ("tay_nguyen", "Thủ Dầu Một"), "di an": ("tay_nguyen", "Bình Dương"), "thuan an": ("tay_nguyen", "Bình Dương"),
    "dong nai": ("tay_nguyen", "Đồng Nai"), "bien hoa": ("tay_nguyen", "Biên Hòa"), "long khanh": ("tay_nguyen", "Long Khánh"),
    "ba ria vung tau": ("tay_nguyen", "Bà Rịa - Vũng Tàu"), "ba ria": ("tay_nguyen", "Bà Rịa"), "vung tau": ("tay_nguyen", "Vũng Tàu"), "brvt": ("tay_nguyen", "Bà Rịa - Vũng Tàu"),
    "tp hcm": ("tay_nguyen", "TP.HCM"), "tphcm": ("tay_nguyen", "TP.HCM"), "ho chi minh": ("tay_nguyen", "TP.HCM"), "tp ho chi minh": ("tay_nguyen", "TP.HCM"), "hcm": ("tay_nguyen", "TP.HCM"),
    "sai gon": ("tay_nguyen", "Sài Gòn"), "saigon": ("tay_nguyen", "Sài Gòn"),
    # Duyên hải Miền Trung & Bắc Trung Bộ (14 tỉnh thành + thành phố lớn)
    "binh thuan": ("mien_trung", "Bình Thuận"), "phan thiet": ("mien_trung", "Phan Thiết"), "la gi": ("mien_trung", "La Gi"), "mui ne": ("mien_trung", "Phan Thiết"),
    "ninh thuan": ("mien_trung", "Ninh Thuận"), "phan rang": ("mien_trung", "Phan Rang"),
    "khanh hoa": ("mien_trung", "Khánh Hòa"), "nha trang": ("mien_trung", "Nha Trang"), "cam ranh": ("mien_trung", "Cam Ranh"),
    "phu yen": ("mien_trung", "Phú Yên"), "tuy hoa": ("mien_trung", "Tuy Hòa"),
    "binh dinh": ("mien_trung", "Bình Định"), "quy nhon": ("mien_trung", "Quy Nhơn"), "qui nhon": ("mien_trung", "Quy Nhơn"),
    "quang ngai": ("mien_trung", "Quảng Ngãi"),
    "quang nam": ("mien_trung", "Quảng Nam"), "tam ky": ("mien_trung", "Tam Kỳ"), "hoi an": ("mien_trung", "Hội An"),
    "da nang": ("mien_trung", "Đà Nẵng"), "danang": ("mien_trung", "Đà Nẵng"),
    "thua thien hue": ("mien_trung", "Thừa Thiên Huế"), "hue": ("mien_trung", "Huế"),
    "quang tri": ("mien_trung", "Quảng Trị"), "dong ha": ("mien_trung", "Đông Hà"),
    "quang binh": ("mien_trung", "Quảng Bình"), "dong hoi": ("mien_trung", "Đồng Hới"),
    "ha tinh": ("mien_trung", "Hà Tĩnh"),
    "nghe an": ("mien_trung", "Nghệ An"), "vinh": ("mien_trung", "Vinh"), "cua lo": ("mien_trung", "Cửa Lò"),
    "thanh hoa": ("mien_trung", "Thanh Hóa"), "sam son": ("mien_trung", "Sầm Sơn"),
    # Miền Bắc (25 tỉnh thành + thành phố lớn)
    "ha noi": ("mien_bac", "Hà Nội"), "hanoi": ("mien_bac", "Hà Nội"), "thu do": ("mien_bac", "Hà Nội"),
    "hai phong": ("mien_bac", "Hải Phòng"), "haiphong": ("mien_bac", "Hải Phòng"),
    "quang ninh": ("mien_bac", "Quảng Ninh"), "ha long": ("mien_bac", "Hạ Long"), "halong": ("mien_bac", "Hạ Long"), "mong cai": ("mien_bac", "Móng Cái"), "cam pha": ("mien_bac", "Cẩm Phả"), "uong bi": ("mien_bac", "Uông Bí"),
    "hai duong": ("mien_bac", "Hải Dương"),
    "hung yen": ("mien_bac", "Hưng Yên"),
    "bac ninh": ("mien_bac", "Bắc Ninh"),
    "bac giang": ("mien_bac", "Bắc Giang"),
    "vinh phuc": ("mien_bac", "Vĩnh Phúc"), "vinh yen": ("mien_bac", "Vĩnh Phúc"), "tam dao": ("mien_bac", "Vĩnh Phúc"),
    "thai binh": ("mien_bac", "Thái Bình"),
    "nam dinh": ("mien_bac", "Nam Định"),
    "ha nam": ("mien_bac", "Hà Nam"), "phu ly": ("mien_bac", "Hà Nam"),
    "ninh binh": ("mien_bac", "Ninh Bình"), "trang an": ("mien_bac", "Ninh Bình"), "tam diep": ("mien_bac", "Ninh Bình"),
    "phu tho": ("mien_bac", "Phú Thọ"), "viet tri": ("mien_bac", "Việt Trì"),
    "thai nguyen": ("mien_bac", "Thái Nguyên"),
    "tuyen quang": ("mien_bac", "Tuyên Quang"),
    "ha giang": ("mien_bac", "Hà Giang"),
    "cao bang": ("mien_bac", "Cao Bằng"),
    "bac kan": ("mien_bac", "Bắc Kạn"), "bac can": ("mien_bac", "Bắc Kạn"),
    "lang son": ("mien_bac", "Lạng Sơn"),
    "lao cai": ("mien_bac", "Lào Cai"), "sa pa": ("mien_bac", "Sa Pa"), "sapa": ("mien_bac", "Sa Pa"),
    "yen bai": ("mien_bac", "Yên Bái"),
    "son la": ("mien_bac", "Sơn La"), "moc chau": ("mien_bac", "Mộc Châu"),
    "dien bien": ("mien_bac", "Điện Biên"), "dien bien phu": ("mien_bac", "Điện Biên"),
    "lai chau": ("mien_bac", "Lai Châu"),
    "hoa binh": ("mien_bac", "Hòa Bình"),
}
PLACE_PREFIXES = (
    "ve que o ", "ve que ", "ve tinh ", "ve thanh pho ", "ve tp ", "ve xe ", "ve ",
    "di ve ", "di xe ", "di ",
    "que o ", "que ",
    "xe ve ", "xe di ", "xe ",
    "tuyen xe ", "tuyen ",
    "tinh ", "thanh pho ", "tp ",
)
STATION_WORDS = {
    "len xe": "board", "lenxe": "board", "ve que": "board", "veque": "board", "di xe": "board", "dixe": "board", "len": "board",
    "ra xe": "board", "raxe": "board", "vao xe": "board", "vaoxe": "board", "cho len": "board",
    "len ghe ngoi": "board", "len ghe": "board", "len xe ngoi": "board", "len ngoi": "board",
    "ngoi": "board", "ngoi xe": "board", "ngoi ghe": "board",
    "cho len xe": "board", "cho minh len xe": "board", "cho em len xe": "board", "muon len xe": "board",
    "dat ghe": "board", "lay ve": "board", "xin ghe": "board", "xin ve": "board",
    "xuong xe": "leave", "xuongxe": "leave", "huy ve": "leave", "huy ghe": "leave",
    "ve": "ticket", "ve xe": "ticket", "ve cua toi": "ticket", "ghe cua toi": "ticket", "xem ve": "ticket",
}
SEAT_PATTERN = re.compile(r"^(?:(?:len|ngoi|chon|dat|xin|doi|sang|cho) )?(?:ghe|cho|so)(?: so)? ?(\d{1,2})$")


def _strip_place_prefix(candidate: str) -> str:
    for prefix in PLACE_PREFIXES:
        if candidate.startswith(prefix):
            return candidate[len(prefix):]
    return candidate


def parse_station(value: str, relaxed: bool = False) -> tuple[str | None, str | int | tuple[str, str] | None]:
    """`value` is already normalized (lowercase, no diacritics). Returns (command, argument)."""
    words = re.sub(r"[^a-z0-9 ]", " ", value).split()
    if not words or len(words) > 7:
        return None, None
    text = " ".join(words)
    candidates = [text]
    if relaxed:
        # Trailing chatter is allowed after a clear command: "ghế 12 nha", "lên xe thôi", "Đà Lạt ơi".
        candidates += [" ".join(words[:size]) for size in (5, 4, 3, 2, 1) if len(words) > size]
    for candidate in candidates:
        if candidate.isdigit() and candidate == text:
            seat = int(candidate)
            return ("seat", seat) if 1 <= seat <= SEATS else (None, None)
        match = SEAT_PATTERN.match(candidate)
        if match:
            seat = int(match.group(1))
            return ("seat", seat) if 1 <= seat <= SEATS else ("seat_invalid", seat)
        if candidate in STATION_WORDS and (len(candidate) > 3 or candidate == text):
            return STATION_WORDS[candidate], None
        if candidate in PROVINCES and (len(candidate) >= 3 or candidate == text):
            return "province", PROVINCES[candidate]
        if candidate in ROUTE_WORDS and (len(candidate) > 3 or candidate == text):
            return "route", ROUTE_WORDS[candidate]
        place = _strip_place_prefix(candidate)
        if place != candidate:
            if place in PROVINCES:
                return "province", PROVINCES[place]
            if place in ROUTE_WORDS:
                return "route", ROUTE_WORDS[place]
    return None, None


def ensure_bus_schema(db: sqlite3.Connection) -> None:
    db.executescript("""
        CREATE TABLE IF NOT EXISTS buses (
            id INTEGER PRIMARY KEY AUTOINCREMENT, route TEXT NOT NULL, number INTEGER NOT NULL,
            capacity INTEGER NOT NULL DEFAULT 24, status TEXT NOT NULL DEFAULT 'boarding',
            created_at REAL NOT NULL, full_at REAL, departed_at REAL,
            UNIQUE(route, number)
        );
        CREATE TABLE IF NOT EXISTS seat_reservations (
            id INTEGER PRIMARY KEY AUTOINCREMENT, bus_id INTEGER NOT NULL REFERENCES buses(id),
            player_id TEXT NOT NULL, seat_no INTEGER NOT NULL CHECK(seat_no BETWEEN 1 AND 24),
            status TEXT NOT NULL DEFAULT 'active', created_at REAL NOT NULL, updated_at REAL NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS seat_taken ON seat_reservations(bus_id, seat_no) WHERE status='active';
        CREATE UNIQUE INDEX IF NOT EXISTS one_seat_per_player ON seat_reservations(player_id) WHERE status='active';
        CREATE INDEX IF NOT EXISTS buses_boarding ON buses(route, status, number);
    """)
    session_columns = {row[1] for row in db.execute("PRAGMA table_info(sessions)")}
    if "scene" not in session_columns:
        db.execute("ALTER TABLE sessions ADD COLUMN scene TEXT NOT NULL DEFAULT 'office'")
    if "route" not in session_columns:
        db.execute("ALTER TABLE sessions ADD COLUMN route TEXT NOT NULL DEFAULT 'mien_tay'")
    player_columns = {row[1] for row in db.execute("PRAGMA table_info(players)")}
    for column, kind in (
        ("trips", "INTEGER NOT NULL DEFAULT 0"),
        ("last_seat", "REAL NOT NULL DEFAULT 0"),
        ("pending_route", "TEXT NOT NULL DEFAULT ''"),
        ("pending_at", "REAL NOT NULL DEFAULT 0"),
        ("hometown", "TEXT NOT NULL DEFAULT ''"),
        ("entered_at", "REAL NOT NULL DEFAULT 0"),
    ):
        if column not in player_columns:
            db.execute(f"ALTER TABLE players ADD COLUMN {column} {kind}")


class BusStation:
    """Seat rules. Every method expects to run inside the engine's open write transaction."""

    # ---- lookups ---------------------------------------------------------

    def _seat_of(self, db, player_id):
        return db.execute("""
            SELECT r.id reservation_id, r.seat_no, b.id bus_id, b.route, b.number, b.status bus_status, p.hometown
            FROM seat_reservations r JOIN buses b ON b.id = r.bus_id JOIN players p ON p.id = r.player_id
            WHERE r.player_id=? AND r.status='active'""", (player_id,)).fetchone()

    def _taken(self, db, bus_id):
        return {row[0] for row in db.execute("SELECT seat_no FROM seat_reservations WHERE bus_id=? AND status='active'", (bus_id,))}

    def _display_bus(self, db, route):
        """The bus shown for a route: the oldest one still at the platform (it may be full and counting down)."""
        return db.execute("SELECT * FROM buses WHERE route=? AND status='boarding' ORDER BY number LIMIT 1", (route,)).fetchone()

    def _open_bus(self, db, route, now):
        """The bus a new passenger joins: the oldest one with a free seat, or a fresh one from the pool."""
        for bus in db.execute("SELECT * FROM buses WHERE route=? AND status='boarding' ORDER BY number", (route,)).fetchall():
            if len(self._taken(db, bus["id"])) < bus["capacity"]:
                return bus
        number = db.execute("SELECT coalesce(max(number),0)+1 FROM buses WHERE route=?", (route,)).fetchone()[0]
        cursor = db.execute("INSERT INTO buses(route,number,capacity,created_at) VALUES (?,?,?,?)", (route, number, SEATS, now))
        return db.execute("SELECT * FROM buses WHERE id=?", (cursor.lastrowid,)).fetchone()

    @staticmethod
    def _bus_name(route_code, number):
        return f"xe {ROUTE_BY_CODE[route_code]['label']} số {number}"

    def _nearest_free(self, taken, seat):
        free = [number for number in range(1, SEATS + 1) if number not in taken]
        return min(free, key=lambda number: (abs(number - seat), number)) if free else None

    def _mark_full(self, db, bus, now):
        if bus["full_at"] is None and len(self._taken(db, bus["id"])) >= bus["capacity"]:
            db.execute("UPDATE buses SET full_at=? WHERE id=?", (now, bus["id"]))
            return True
        return False

    def _ticket_payload(self, db, player_id):
        seat = self._seat_of(db, player_id)
        if not seat:
            return None
        route = ROUTE_BY_CODE[seat["route"]]
        return {"bus_id": seat["bus_id"], "route": seat["route"], "route_label": route["label"], "bus_number": seat["number"], "seat": seat["seat_no"], "color": route["color"], "hometown": seat["hometown"]}

    # ---- commands --------------------------------------------------------

    def _station_command(self, db, result, session, player, command, argument, now):
        """Apply one seat command for an enrolled player. Mutates `result` in place."""
        name = player["nickname"]
        if command == "ticket":
            ticket = self._ticket_payload(db, player["id"])
            if ticket:
                home_tail = f" · quê {ticket['hometown']}" if ticket.get("hometown") else ""
                result.update(ok=True, code="TICKET", cue="salary", ticket=ticket, message=f"{name} · vé {self._bus_name(ticket['route'], ticket['bus_number'])} · ghế {ticket['seat']}{home_tail}", player=dict(player))
            else:
                result.update(ok=True, code="NO_TICKET", message=f"{name} chưa có vé. Gõ “lên xe” hoặc số ghế để lên xe nhé!", player=dict(player))
            return
        if command == "seat_invalid":
            result.update(code="SEAT_INVALID", message=f"Xe chỉ có ghế 1 đến {SEATS}. Gõ ví dụ “ghế 12” nhé!", player=dict(player))
            return
        if session["paused"]:
            result.update(code="PAUSED", message="Bến xe đang tạm nghỉ. Đợi quản trò tiếp tục nhé!", player=dict(player))
            return
        current = self._seat_of(db, player["id"])
        if command == "province":
            route, hometown = argument
        else:
            route = argument if command == "route" else (current["route"] if current else session["route"])
            hometown = ""
        wanted_seat = argument if command == "seat" else None
        if command in ("board", "route", "province", "seat") and current and current["route"] == route and (wanted_seat is None or wanted_seat == current["seat_no"]):
            hometown_updated = False
            if hometown and player["hometown"] != hometown:
                db.execute("UPDATE players SET hometown=? WHERE id=?", (hometown, player["id"]))
                player = self._player(db, player["id"])
                hometown_updated = True
            home_tail = f" · quê {player['hometown']}" if player["hometown"] else ""
            msg = f"{name} đang ngồi ghế {wanted_seat} rồi." if wanted_seat is not None else f"{name} đã có ghế {current['seat_no']} trên {self._bus_name(current['route'], current['number'])}{home_tail} rồi."
            result.update(ok=True, changed=hometown_updated, code="ALREADY_SEATED", message=msg, player=dict(player), ticket=self._ticket_payload(db, player["id"]))
            if hometown_updated:
                result["cue"] = "click"
            return
        remaining = max(0, int(SEAT_COOLDOWN - (now - player["last_seat"]) + 0.999)) if player["last_seat"] else 0
        if remaining:
            result.update(code="COOLDOWN", remaining=remaining, message=f"{name} đợi thêm {remaining} giây rồi đổi chỗ nhé.", player=dict(player))
            return
        if command == "leave":
            if not current:
                result.update(code="NO_TICKET", message=f"{name} chưa có ghế nào để xuống.", player=dict(player))
                return
            db.execute("UPDATE seat_reservations SET status='cancelled',updated_at=? WHERE id=?", (now, current["reservation_id"]))
            db.execute("UPDATE buses SET full_at=NULL WHERE id=?", (current["bus_id"],))
            db.execute("UPDATE players SET last_seat=?,last_seen=?,entered_at=?,pending_route='' WHERE id=?", (now, now, now, player["id"]))
            player = self._player(db, player["id"])
            message = f"{name} xuống {self._bus_name(current['route'], current['number'])}, nhường ghế {current['seat_no']}."
            result.update(ok=True, changed=True, code="LEFT_SEAT", cue="click", message=message, player=dict(player), seat={"bus_id": current["bus_id"], "seat": current["seat_no"], "route": current["route"]}, seq=self._event(db, "leave", message, player))
            return

        if current and current["route"] != route:
            # Changing bus can lose a good seat, so it needs the same comment twice.
            if player["pending_route"] != route or now - player["pending_at"] > SWITCH_WINDOW:
                db.execute("UPDATE players SET pending_route=?,pending_at=? WHERE id=?", (route, now, player["id"]))
                label = hometown or ROUTE_BY_CODE[route]["label"]
                result.update(ok=True, changed=False, code="CONFIRM_SWITCH", message=f"{name} đang có ghế {current['seat_no']} {self._bus_name(current['route'], current['number'])}. Gõ lại “{label.lower()}” trong {SWITCH_WINDOW} giây để đổi xe.", player=dict(player))
                return
        if current and current["route"] == route and wanted_seat is not None:
            bus = db.execute("SELECT * FROM buses WHERE id=?", (current["bus_id"],)).fetchone()
        else:
            # The bus on screen while it has room, otherwise the next one from the pool.
            bus = self._open_bus(db, route, now)
        taken = self._taken(db, bus["id"])
        if current and current["bus_id"] == bus["id"] and wanted_seat == current["seat_no"]:
            result.update(ok=True, code="ALREADY_SEATED", message=f"{name} đang ngồi ghế {wanted_seat} rồi.", player=dict(player), ticket=self._ticket_payload(db, player["id"]))
            return
        seat = wanted_seat if wanted_seat is not None else self._nearest_free(taken, 1)
        if seat is None or seat in taken:
            hint = self._nearest_free(taken, wanted_seat or 1)
            tail = f" Ghế trống gần nhất: {hint}." if hint else " Xe này đã đầy, gõ “lên xe” để sang xe kế tiếp."
            result.update(code="SEAT_TAKEN", message=f"Ghế {wanted_seat} {self._bus_name(bus['route'], bus['number'])} đã có người.{tail}", player=dict(player), suggestion=hint)
            return
        moved_from = None
        try:
            if current:
                moved_from = {"bus_id": current["bus_id"], "seat": current["seat_no"], "route": current["route"]}
                if current["bus_id"] == bus["id"]:
                    db.execute("UPDATE seat_reservations SET seat_no=?,updated_at=? WHERE id=?", (seat, now, current["reservation_id"]))
                else:
                    db.execute("UPDATE seat_reservations SET status='cancelled',updated_at=? WHERE id=?", (now, current["reservation_id"]))
                    db.execute("UPDATE buses SET full_at=NULL WHERE id=?", (current["bus_id"],))
                    db.execute("INSERT INTO seat_reservations(bus_id,player_id,seat_no,created_at,updated_at) VALUES (?,?,?,?,?)", (bus["id"], player["id"], seat, now, now))
            else:
                db.execute("INSERT INTO seat_reservations(bus_id,player_id,seat_no,created_at,updated_at) VALUES (?,?,?,?,?)", (bus["id"], player["id"], seat, now, now))
        except sqlite3.IntegrityError:
            result.update(code="SEAT_TAKEN", message=f"Ghế {seat} vừa có người nhanh tay hơn. Thử ghế khác nhé!", player=dict(player))
            return
        new_hometown = hometown or player["hometown"]
        db.execute("UPDATE players SET last_seat=?,last_seen=?,entered_at=0,pending_route='',pending_at=0,hometown=? WHERE id=?", (now, now, new_hometown, player["id"]))
        full = self._mark_full(db, bus, now)
        player = self._player(db, player["id"])
        verb = "đổi sang" if moved_from else "lên"
        home_tail = f" · quê {player['hometown']}" if player["hometown"] else ""
        message = f"{name} {verb} {self._bus_name(bus['route'], bus['number'])} · ghế {seat}{home_tail}"
        if full:
            message += f" · Xe đầy! Xuất bến sau {DEPART_DELAY} giây"
        ticket = {"bus_id": bus["id"], "route": bus["route"], "route_label": ROUTE_BY_CODE[bus["route"]]["label"], "bus_number": bus["number"], "seat": seat, "color": ROUTE_BY_CODE[bus["route"]]["color"], "hometown": player["hometown"]}
        result.update(ok=True, changed=True, code="MOVED_SEAT" if moved_from else "SEATED", cue="horn", message=message, player=dict(player), ticket=ticket, moved_from=moved_from, bus_full=full, seq=self._event(db, "seat", message, player))

    def _depart(self, db, bus, now, reason):
        passengers = db.execute("SELECT r.player_id FROM seat_reservations r WHERE r.bus_id=? AND r.status='active'", (bus["id"],)).fetchall()
        ids = [row[0] for row in passengers]
        db.execute("UPDATE buses SET status='departed',departed_at=? WHERE id=?", (now, bus["id"]))
        db.execute("UPDATE seat_reservations SET status='completed',updated_at=? WHERE bus_id=? AND status='active'", (now, bus["id"]))
        first = 0
        for player_id in ids:
            trips = db.execute("SELECT trips FROM players WHERE id=?", (player_id,)).fetchone()[0]
            bonus = FIRST_TRIP_BONUS if trips == 0 else 0
            first += bool(bonus)
            db.execute("UPDATE players SET trips=trips+1,xp=xp+20,coins=coins+?,last_seen=? WHERE id=?", (bonus, now, player_id))
        route = ROUTE_BY_CODE[bus["route"]]
        message = f"{self._bus_name(bus['route'], bus['number']).capitalize()} xuất bến với {len(ids)} hành khách · {' → '.join(route['stops'])}. Về quê ăn Tết thôi!"
        seq = self._event(db, "depart", message)
        return {"ok": True, "changed": True, "code": "DEPARTED", "cue": "depart", "voice": "depart", "message": message, "seq": seq, "reason": reason,
                "bus": {"id": bus["id"], "route": bus["route"], "number": bus["number"], "passengers": len(ids), "first_trips": first, "minutes": route["minutes"]}}

    def _depart_focus(self, db, session, now):
        """Streamer action inside control(): send off the bus shown for the focused route."""
        bus = self._display_bus(db, session["route"])
        if session["scene"] != "station":
            return {"code": "STATION_CLOSED", "message": "Bến xe chưa mở. Bấm “Mở bến xe” trước nhé."}
        if session["paused"]:
            return {"code": "PAUSED", "message": "Đang tạm nghỉ. Tiếp tục rồi hãy cho xe chạy nhé."}
        if not bus:
            return {"code": "NO_BUS", "message": "Chưa có xe nào ở bến để xuất bến."}
        if not self._taken(db, bus["id"]):
            return {"code": "EMPTY_BUS", "message": f"{self._bus_name(bus['route'], bus['number']).capitalize()} chưa có khách."}
        return self._depart(db, bus, now, "manual")

    def station_tick(self) -> list[dict]:
        """Depart every bus whose countdown finished. Safe to call often; idempotent per bus."""
        now = self.clock()
        with self.database() as db:
            db.execute("BEGIN IMMEDIATE")
            session = db.execute("SELECT scene,paused FROM sessions LIMIT 1").fetchone()
            if session["scene"] != "station" or session["paused"]:
                return []
            due = db.execute("SELECT * FROM buses WHERE status='boarding' AND full_at IS NOT NULL AND full_at<=? ORDER BY full_at", (now - DEPART_DELAY,)).fetchall()
            results = []
            for bus in due:
                if len(self._taken(db, bus["id"])) >= bus["capacity"]:
                    results.append(self._depart(db, bus, now, "full"))
                else:
                    db.execute("UPDATE buses SET full_at=NULL WHERE id=?", (bus["id"],))
            return results

    def station_snapshot(self, db, session, now) -> dict:
        routes = []
        for route in ROUTES:
            bus = self._display_bus(db, route["code"])
            seats = [None] * SEATS
            filled = 0
            countdown = None
            if bus:
                for row in db.execute("""
                        SELECT r.seat_no, p.id, p.nickname, p.skin, p.avatar, p.hometown FROM seat_reservations r JOIN players p ON p.id = r.player_id
                        WHERE r.bus_id=? AND r.status='active'""", (bus["id"],)):
                    seats[row["seat_no"] - 1] = {"id": row["id"], "nickname": row["nickname"], "skin": row["skin"], "avatar": row["avatar"], "hometown": row["hometown"]}
                    filled += 1
                if bus["full_at"] is not None:
                    countdown = max(0, int(DEPART_DELAY - (now - bus["full_at"]) + 0.999))
            number = bus["number"] if bus else db.execute("SELECT coalesce(max(number),0)+1 FROM buses WHERE route=?", (route["code"],)).fetchone()[0]
            boarding_buses = db.execute("SELECT count(*) FROM buses WHERE route=? AND status='boarding'", (route["code"],)).fetchone()[0]
            totals = db.execute("""
                SELECT count(DISTINCT b.id) buses, count(r.id) riders FROM buses b
                LEFT JOIN seat_reservations r ON r.bus_id = b.id AND r.status='completed'
                WHERE b.route=? AND b.status='departed'""", (route["code"],)).fetchone()
            seated = db.execute("SELECT count(*) FROM seat_reservations r JOIN buses b ON b.id=r.bus_id WHERE b.route=? AND b.status='boarding' AND r.status='active'", (route["code"],)).fetchone()[0]
            routes.append({**route, "bus": {"id": bus["id"] if bus else None, "number": number, "filled": filled, "capacity": SEATS, "countdown": countdown, "full_at": bus["full_at"] if bus else None, "seats": seats},
                           "boarding_buses": boarding_buses, "seated": seated, "departed_buses": totals["buses"], "riders": totals["riders"]})
        waiting_list = []
        if session["scene"] == "station":
            waiting_rows = db.execute("""
                SELECT p.id, p.nickname, p.skin, p.avatar, p.hometown, p.entered_at
                FROM players p
                WHERE p.entered_at > 0
                  AND NOT EXISTS (
                      SELECT 1 FROM seat_reservations r WHERE r.player_id = p.id AND r.status = 'active'
                  )
                ORDER BY p.entered_at DESC, p.id DESC
                LIMIT ?
            """, (WAITING_LIMIT,)).fetchall()
            waiting_list = [
                {
                    "id": row["id"],
                    "name": row["nickname"],
                    "nickname": row["nickname"],
                    "skin": row["skin"],
                    "avatar": row["avatar"],
                    "hometown": row["hometown"],
                    "entered_at": row["entered_at"],
                }
                for row in reversed(waiting_rows)
            ]
        return {"routes": routes, "focus": session["route"], "capacity": SEATS, "depart_delay": DEPART_DELAY, "switch_window": SWITCH_WINDOW, "waiting": waiting_list}
