# TetLive Studio

Game TikTok LIVE **Làm hết năm – Về quê ăn Tết**, gồm hai chặng tương tác trực tiếp: **Công ty cuối năm** (`office`) và **Bến xe 24 ghế** (`station`). Người xem bình luận trên TikTok để vào làm, chạy KPI, chọn tuyến xe/ghế về quê theo 63 tỉnh thành, thả tim tiếp sức, follow để ký hợp đồng và tặng quà Tết cho cả phòng.

## Mở game trên Windows

Nhấp đúp **`start.cmd`**, đợi dòng địa chỉ xuất hiện rồi mở:

- Bảng điều khiển: **http://127.0.0.1:8000**
- Overlay dọc 9:16: **http://127.0.0.1:8000/?overlay=1**

Giữ cửa sổ chương trình mở trong lúc LIVE. Nhấn `Ctrl+C` để dừng. Cần Python (đã xác minh trên **Python 3.14.8**) và **Node.js 22.19 trở lên** (máy phát triển đang chạy **Node.js 24.21.0**). Lần cài đầu cần Internet để tải thư viện.

`start.cmd` kiểm tra phiên bản Node.js (`>= 22.19`), tạo `.venv` và cài phụ thuộc từ `requirements.txt`, cài thư viện npm (kể cả `piratetok-live-js` nếu chưa có) rồi chạy `npm run build`:

- **`requirements.txt`**: dùng ràng buộc phiên bản linh hoạt cho nhiều môi trường (`fastapi>=0.115.0`, `pydantic>=2.10.0,!=2.14.3`, `uvicorn>=0.32.0`, `websockets>=14.0`, `pytest>=8.0.0`, `httpx>=0.27.0`). Riêng `pydantic` loại trừ bản **2.14.3** vì extension nhị phân của phiên bản này có thể bị Windows Application Control (WDAC) chặn; không cần thay đổi thiết lập bảo mật Windows.
- **`package.json`**: yêu cầu `node >= 22.19.0`; `typescript` (`^5.7.0 || ^6.0.0 || ^7.0.0`) và `vite` (`^6.0.0 || ^7.0.0 || ^8.0.0`) dùng dải phiên bản linh hoạt. Riêng **`"piratetok-live-js": "0.3.0"` được giữ cố định chính xác ở `0.3.0`** vì `connector/tiktok-connector.mjs` dùng các đường dẫn nội bộ trong `node_modules/piratetok-live-js/dist/` (`dist/connection/wss.js`, `dist/connection/url.js`, `dist/http/api.js`) để tái sử dụng phiên `{ ttwid, userAgent }`, đọc `data.status` thô và bóc lỗi `DeviceBlockedError` (bản `0.3.0` chưa export subpath hooks này và `superviseSessions` nuốt mất `DeviceBlockedError`).

## Kết nối TikTok LIVE

1. Khi mới khởi động, ứng dụng luôn ở trạng thái **`idle`** (**`CHƯA KẾT NỐI`** trên bảng điều khiển, **`CHƯA LIVE`** trên HUD) và **không** tự kết nối vào bất kỳ kênh cá nhân nào.
2. Bật LIVE trên TikTok (điện thoại hoặc TikTok LIVE Studio).
3. Ở bảng điều khiển, mục **TikTok LIVE**: nhập `@tên_kênh` (hoặc dán link kênh TikTok) rồi bấm **Kết nối**. *(Tùy chọn cho môi trường tự động: đặt biến môi trường `TETLIVE_CHANNEL` trên máy chủ để tự nối khi khởi động; đặt `TETLIVE_NO_AUTOCONNECT=1` để tắt.)*
4. Nhãn chuyển sang **ĐANG LIVE**, kèm số người xem và bộ đếm bình luận / tim / quà / follow / chia sẻ. Bấm **Ngắt** để dừng.

Không cần mật khẩu, cookie hay API key: chương trình chỉ đọc sự kiện công khai của phòng LIVE bằng cơ chế dò phòng 3 tầng (`checkOnline` → `acquireTTWID` + `/api-live/user/room` → trang `/@<kênh>/live`).

- **Lịch thử lại chính xác trong `backend/live.py`**:
  - Kênh chưa bật LIVE (`NOT_LIVE`): tự thăm dò tăng dần theo các mốc **`5, 5, 8, 10, 12` giây** (giữ ở 12 giây cho các lần tiếp theo) cộng jitter **`0–1,5` giây**.
  - Lỗi tạm thời / bị chặn / quá thời gian / rớt mạng (`BLOCKED`, `TIMEOUT`, `CONNECT_FAILED`, `DISCONNECTED`): giãn nhịp backoff **`6, 12, 20, 30` giây** (giữ ở 30 giây cho các lần tiếp theo) cộng jitter **`0–2,0` giây**, thử lại liên tục cho tới khi vào được phòng hoặc người dùng bấm **Ngắt**; bộ đếm retry đặt lại về `0` khi `connected`.
  - Lỗi cố định (`BAD_USERNAME`, `NOT_FOUND`, `NO_NODE`, `OLD_NODE`, `SPAWN_FAILED`, `AGE_RESTRICTED`), khi LIVE kết thúc (`ended`) hoặc bấm **Ngắt** sẽ dừng thử lại ngay.
- **Dọn phiên theo phòng LIVE (`room_id`)**: khi kết nối sang một `room_id` mới, `GameEngine.on_live_room(room_id)` (lưu `sessions.live_room_id`) tự dọn dữ liệu chơi thử còn sót và làm sạch hàng chờ bến xe cùng các ghế/xe chưa xuất bến của buổi LIVE cũ, nhưng giữ nguyên hồ sơ tích lũy, xu/KPI và lịch sử chuyến xe đã xuất bến. Nối lại cùng `room_id` là thao tác bất biến (không làm mất ghế đang ngồi).

**Chưa LIVE vẫn tập được:** bấm **Chạy thử phòng LIVE giả lập** (18 người xem mẫu bình luận, thả tim, follow, chia sẻ, tặng quà theo đúng cảnh Công ty hoặc Bến xe qua pipeline LIVE thật), hoặc dùng các nút **Tương tác LIVE thử** (20 tim, follow, chia sẻ, quà 1 / 10 / 99 xu) với tên trong ô *Tên người xem*. Hồ sơ mẫu có tiền tố `demo_` và được gắn nhãn **mẫu**. Trước khi lên sóng thật có thể bấm **Làm sạch dữ liệu thử (Chuẩn bị LIVE thật)**.

## Đưa overlay lên LIVE

1. Bấm **Sao chép link OBS**.
2. **TikTok LIVE Studio**: chọn **Thêm nguồn → Liên kết (Link)** trỏ tới `http://127.0.0.1:8000/?overlay=1` và bật **Custom resolution: 1080 × 1920**. **OBS**: thêm **Browser Source**, kích thước **1080 × 1920**.
3. Overlay nhận trạng thái qua WebSocket (`/ws`); tải lại vẫn lấy ảnh chụp trạng thái mới nhất. Chỉ để một nơi phát âm thanh để tránh tiếng lặp.

Bố cục overlay 1080 × 1920 hiển thị bảng hiệu và dòng tin chạy ở trên, thẻ trái thích ứng theo chặng (**Top nhân viên** ở Chặng 1 hoặc **Tuyến xe Tết** ở Chặng 2) cùng **Cách chơi**, **Quà Tết** và **Tiếp sức / Top thả tim** bên phải, nhân vật kèm ảnh đại diện TikTok ở giữa, phần dưới chừa khoảng trống cho khung bình luận TikTok. Bấm **Khung TikTok** trên bảng điều khiển để phủ giao diện TikTok mô phỏng khi xem trước (không hiện trên overlay).

## Cách chơi

Người điều phối chuyển đổi trực tiếp giữa hai chặng bằng hai nút **`scene_office` (Công ty cuối năm)** và **`scene_station` (Bến xe 24 ghế)**.

### Chặng 1: Công ty cuối năm (`office`)

| Người xem làm | Trong game |
|---|---|
| Bình luận **1** / `vào làm` | Nhận bàn và nhân vật; vào lại giữ nguyên thành tích |
| Bình luận **2** / `làm việc` | +10 KPI, +500 xu, +5 XP; chờ 30 giây giữa hai lượt. Chưa vào làm thì tự nhận bàn rồi làm luôn |
| Bình luận **3** / `cà phê` | Đi tới góc cà phê rồi quay về; chờ 10 giây |
| Bình luận **4** / `lương` | Xem KPI, XP và xu Tết |
| Bình luận `nam` / `nữ` | Đổi nhân vật |
| Bình luận khác | Bong bóng chat trên đầu nhân vật (nếu đã có hồ sơ) |

Chế độ mặc định là **văn phòng mở cửa tự do**: người đến muộn vẫn chơi được, hoàn thành 3 lượt làm việc hợp lệ nhận thêm 500 xu; khi chưa có ai, **Nhân sự · NPC** đứng đón khách. Các nút điều phối gồm **Tạm nghỉ / Tiếp tục**, **Sếp kiểm tra!**, **Vòng ba tháng · tùy chọn** (quản trò tự chuyển tháng; mỗi tháng +1.000 xu, +10 XP; **Chốt thưởng Tết** ở tháng 3 phát +3.000 xu, +20 XP đúng một lần), **Quay về chơi tự do**, và **Thử với 50 nhân vật mẫu** (tự làm việc mỗi 2,2 giây).

### Chặng 2: Bến xe 24 ghế (`station` — `backend/bus.py`, `frontend/src/station.ts`)

Chuyển sang bến xe bằng **`scene_station`** (và quay lại văn phòng bằng **`scene_office`**). Bến xe có **4 tuyến xe** phủ đủ **63 tỉnh thành** (kèm nhiều tên thành phố/địa danh quen thuộc như Sài Gòn, Đà Lạt, Nha Trang, Sa Pa, Phú Quốc…):

| Nút điều khiển | Tuyến xe | Số tỉnh thành | Thời gian hành trình hiển thị |
|---|---|---|---|
| `route_mien_tay` | **Miền Tây** | 13 | 7 phút |
| `route_tay_nguyen` | **Tây Nguyên** *(gồm Đông Nam Bộ & TP.HCM)* | 11 | 9 phút |
| `route_mien_trung` | **Miền Trung** | 14 | 11 phút |
| `route_mien_bac` | **Miền Bắc** | 25 | 13 phút |

| Người xem làm | Trong game |
|---|---|
| **Vào phòng LIVE** | Tự động vào **hàng chờ bên cửa xe** (tối đa 32 người trong snapshot, hiển thị 8 nhân vật xếp hàng kèm tổng số khách chờ) |
| Bình luận `lên xe` *(hoặc `lên ghế ngồi`, `về quê`, `đặt ghế`, `lấy vé`…)* | Lên xe tuyến đang mở cổng và nhận ghế trống gần nhất |
| Bình luận **`ghế 1`–`24`** *(hoặc số `1`–`24`, `chỗ 12`, `số 12`)* | Chọn đúng ghế 1–24 trên xe (nếu ghế đã có người thì gợi ý ghế trống gần nhất) |
| Bình luận **tên tỉnh thành** *(vd: `Cà Mau`, `Nghệ An`, `Đà Lạt`, `Hà Nội`)* hoặc **tên tuyến** *(`miền tây`, `tây nguyên`, `miền trung`, `miền bắc`)* | Tự vào đúng tuyến tương ứng, gắn tên quê lên vé/ghế (nếu gõ tên tỉnh) và nhận ghế trống |
| Bình luận **`vé`** *(hoặc `xem vé`, `vé xe`)* | Xem số xe, tuyến, số ghế và quê quán đang giữ |
| Bình luận **`xuống xe`** *(hoặc `hủy vé`, `hủy ghế`)* | Hủy chỗ hiện tại để nhường ghế và quay lại hàng chờ |

- **Quy tắc công bằng & xuất bến**: vé hoàn toàn **miễn phí**, xếp chỗ theo thứ tự bình luận trước (SQLite khóa mỗi ghế 1 khách và mỗi người giữ tối đa 1 ghế đang hoạt động). Cooldown đổi chỗ là **5 giây**; đổi sang tuyến khác cần xác nhận lại cùng tên tỉnh/tuyến trong **30 giây** để tránh bấm nhầm mất ghế.
- **Xuất bến tự động & thủ công**: mỗi xe có **24 ghế**; khi đủ 24/24 ghế, đồng hồ đếm ngược **10 giây** chạy trên màn hình rồi xe tự động xuất bến và mở xe kế tiếp cho tuyến đó. Quản trò cũng có thể bấm **Cho xe xuất bến ngay** (`depart`) cho tuyến đang mở cổng. Khi xuất bến, mỗi hành khách nhận **+20 XP** và **+500 xu** lì xì cho chuyến về quê đầu tiên (một lần).

### Tương tác LIVE dùng chung cho cả 2 chặng

| Người xem làm | Trong game |
|---|---|
| **Thả tim** | Nạp thanh *Tiếp sức* chung; đủ **200 tim**, cả phòng được xóa cooldown làm việc / đổi ghế ngay. Tim không tự tạo hồ sơ |
| **Follow** | Ký hợp đồng chính thức: +1.000 xu, +10 XP, **một lần** mỗi người |
| **Chia sẻ** | +300 xu, +5 XP, tối đa một lần mỗi 5 phút |
| **Quà 1–9 xu** | *Lì xì may mắn*: lời cảm ơn và mưa xu |
| **Quà 10–98 xu** | *Đãi trà sữa*: cả phòng +200 xu |
| **Quà 99+ xu** | *Tiệc tất niên*: cả phòng +1.000 xu, làm việc ngay, pháo hoa |

Quà chỉ tính thưởng chia đều cho cả phòng, **không mua lợi thế hay tranh ghế**; quà combo chỉ được tính một lần khi chuỗi kết thúc (`isStreakOver`). Điểm, KPI, vé xe và xu là vật phẩm trong game, **không quy đổi tiền thật**.

## Âm thanh

Kho âm thanh cục bộ trong `frontend/public/audio/` (thông số và SHA-256 trong `frontend/public/audio/audio-manifest.json`, kịch bản tái tạo trong `scripts/generate_audio.py`, tài liệu chi tiết trong `frontend/public/audio/README.md`) gồm **18 tệp âm thanh**:

- **2 bản nhạc nền WAV 24 giây chạy lặp** (stereo, 32 kHz): `office-loop.wav` (Chặng 1 – ngũ cung Rê trưởng, 80 BPM) và `station-loop.wav` (Chặng 2 – ngũ cung Sol trưởng, 120 BPM). `AudioManager.setScene()` tự động đổi nhạc nền khi chuyển cảnh.
- **10 hiệu ứng ngắn WAV** (mono, 32 kHz): `join.wav`, `work.wav`, `coffee.wav`, `salary.wav`, `bonus.wav`, `month.wav`, `boss.wav`, `click.wav`, `horn.wav`, `depart.wav`.
- **6 câu thoại Việt MP3** (thu sẵn cục bộ qua `gTTS` 2.5.4, không cần mạng lúc chạy): `voice-welcome.mp3`, `voice-boss.mp3`, `voice-month.mp3`, `voice-bonus.mp3`, `voice-station.mp3`, `voice-depart.mp3`.

Trong `frontend/src/audio.ts`, `AudioManager` dùng đồ thị **Web Audio API** (mặc định Nhạc nền **65%**, Hiệu ứng **75%**, Giọng nói **92%**, lưu trong `localStorage` ở `tetlive.audio.volumes.v1`; tự giảm nhạc nền còn **22%** khi phát thoại). Khi mở trang, ứng dụng gọi `audio.enable({ autoplay: true })` và tự mở khóa ở cử chỉ đầu tiên (hoặc bấm **Bật âm thanh** trong tab **Âm thanh** / nút loa trên overlay). Để hoạt động ổn định trong trình duyệt nhúng CEF của OBS / TikTok LIVE Studio, `AudioManager` chờ `context.resume()` tối đa **300 ms**; nếu `AudioContext` vẫn `suspended`, **autoplay watchdog chu kỳ 1.500 ms** tiếp tục đánh thức `AudioContext` đồng thời phát qua nhánh **`<audio>` (`HTMLAudioElement`) tách rời** (và fallback `speechSynthesis` tiếng Việt nếu thiếu MP3), sau đó tự bàn giao mượt về Web Audio ngay khi `AudioContext` chạy lại.

## Dữ liệu và cách phát triển

Hồ sơ, KPI, xu, tim, quà, follow, giai đoạn phiên, hàng chờ bến xe, bảng `buses` / `seat_reservations`, `live_room_id` và `processed_events` nằm ở **`data/tetlive.sqlite`** (SQLite WAL). Cơ sở dữ liệu cũ tự nâng cấp, giữ nguyên tiến độ. `TETLIVE_DB` chọn tệp SQLite riêng khi kiểm thử.

```text
connector/tiktok-connector.mjs     Đọc sự kiện công khai phòng LIVE, dò phòng 3 tầng, JSON từng dòng (Node)
backend/live.py                    Giám sát connector, lịch retry NOT_LIVE/backoff, chống trùng, gộp tim, phòng giả lập
backend/engine.py                  Luật Chặng 1, transaction SQLite, chống trùng, on_live_room() dọn dữ liệu thử/phòng cũ
backend/bus.py                     Luật Chặng 2 (4 tuyến, 63 tỉnh thành, 24 ghế/xe, hàng chờ, xuất bến tự động)
backend/app.py                     FastAPI, REST API, WebSocket /ws, depart_watch, proxy /api/avatar, bảo vệ loopback
frontend/src/main.ts               Bảng điều khiển, HUD overlay 2 chặng, khung TikTok xem trước
frontend/src/office.ts             Cảnh Phaser Chặng 1 (Công ty cuối năm, 1080 × 1920)
frontend/src/station.ts            Cảnh Phaser Chặng 2 (Bến xe 24 ghế, hàng chờ lên xe, bảng LED, xuất bến)
frontend/src/audio.ts              Web Audio, autoplay watchdog 1.500 ms và nhánh dự phòng <audio>
frontend/public/audio/             18 tệp âm thanh (2 loop WAV, 10 SFX WAV, 6 thoại MP3) + audio-manifest.json
scripts/generate_audio.py          Tổng hợp lại các tệp WAV và cập nhật audio-manifest.json
scripts/check-ui.mjs               Kiểm tra Playwright đầu-cuối (Chặng 1, Chặng 2, audio, overlay) với DB tạm riêng
tests/                             50 kiểm thử backend (test_game.py, test_live.py, test_bus.py, test_live_connector.py)
docs/TetLive_Lam_3_Thang_Ve_Que_An_Tet_Bo_Sung_Free_50_700.pdf
                                   Tài liệu thiết kế trò chơi (thư mục gốc đã dọn sạch PDF và notegit.txt)
concept/                           Các tệp SVG phác thảo nhân vật và bố cục 9:16
reference/xemtuvionline-bear/      Bản sao repo tham chiếu (chỉ để đọc)
```

Phát triển với hai cửa sổ terminal:

```powershell
.\.venv\Scripts\python.exe -m uvicorn backend.app:app --host 127.0.0.1 --port 8000
npm run dev
```

Giao diện phát triển tại `http://127.0.0.1:5173`, tự proxy `/api` và `/ws` về backend. Build phát hành: `npm run build`, sau đó khởi động lại backend.

## Bóc tách từ repo tham chiếu

Bản sao repo [khanhdevngu/xemtuvionline-bear](https://github.com/khanhdevngu/xemtuvionline-bear) (MIT, BEAR DEV, commit `87ada77`) nằm ở `reference/xemtuvionline-bear/` để đối chiếu; thư mục này không được build hay chạy. TetLive chỉ học cách vận hành kỹ thuật:

| Trong repo tham chiếu (`live/server.mjs`, `live/overlay.html`) | TetLive |
|---|---|
| `piratetok-live-js` 0.3.0 đọc chat, quà, tim, follow, chia sẻ, người vào phòng theo `@username` | `connector/tiktok-connector.mjs`: tiến trình Node riêng, dò phòng 3 tầng, in sự kiện JSON chuẩn hóa. Luật game không import thư viện TikTok |
| Chỉ tính quà khi `isStreakOver` | Giữ nguyên; thêm khóa chống trùng lưu trong SQLite |
| `seenEventIds` dọn theo thời gian | LRU giới hạn 5.000 mã sự kiện (`SEEN_LIMIT`) + bảng `processed_events` bền vững (giữ 10.000 khóa mới nhất) |
| Người xem nằm trong `Map` trên RAM, tối đa 64 | Hồ sơ lưu SQLite, tối đa 700 (`MAX_PROFILES`), định danh bằng ID số của TikTok (`tt_<id>`). Chặng 1 vẽ 24 nhân vật hoạt động gần nhất; Chặng 2 xếp 24 ghế/xe và tối đa 32 người trong hàng chờ |
| Mỗi lượt tim gửi một sự kiện | Gộp tim theo từng người mỗi 1 giây (`LIKE_WINDOW`); hàng đợi 3.000 sự kiện bỏ chat/enter trước khi quá tải, luôn giữ follow / quà |
| Proxy ảnh đại diện TikTok CDN (tối đa 3 MB, 400 tệp) | `/api/avatar` bằng Python với cùng danh sách trắng CDN, kiểm tra mọi bước redirect và giới hạn 3 MB / 400 tệp tại `data/avatar-cache/` |
| Bot mô phỏng và nút thử tương tác | Phòng LIVE giả lập và nút **Tương tác LIVE thử** đi qua đúng pipeline của LIVE thật |

## Kiểm tra

```powershell
.\.venv\Scripts\python.exe -m pytest tests -v
npm run build
npm run test:ui
```

- **50 kiểm tra backend** (`pytest tests --collect-only -q`):
  - `tests/test_game.py` (**12 test**): luật gốc Chặng 1 (định danh, chống trùng, cooldown qua restart, thưởng một lần, 100 yêu cầu đồng thời, 700 hồ sơ chỉ vẽ 24, snapshot/reconnect, kiểm tra đầu vào, chế độ mở cửa tự do, nâng cấp DB cũ).
  - `tests/test_live.py` (**16 test**): sự kiện LIVE Chặng 1 & Chặng 2 (bình luận tự nhiên, follow/share/tim/quà, chuẩn hóa ID & avatar proxy, cầu nối chống trùng & gộp tim, tunnel read-only vs loopback POST, tự nối qua `TETLIVE_CHANNEL`, dọn phòng cũ khi đổi `room_id`, và khởi động `idle` không tự nối khi `TETLIVE_CHANNEL` trống/chưa đặt).
  - `tests/test_bus.py` (**15 test**): luật Chặng 2 Bến xe 24 ghế (phân tích bình luận, đủ 63 tỉnh thành & 4 tuyến + âm thanh bến xe, vé miễn phí & 100 người tranh 1 ghế, xác nhận đổi tuyến trong 30 giây, đầy 24 ghế mở xe kế tiếp & tự xuất bến 10 giây, xuất bến thủ công, di trú DB cũ, hàng chờ vào bến & `clear_demo`, dọn hàng chờ/ghế cũ khi đổi `room_id` và tính bất biến khi cùng `room_id`).
  - `tests/test_live_connector.py` (**7 test**): kiểm tra lịch retry `NOT_LIVE` (5/5/8/10/12s + jitter), backoff lỗi tạm thời (6/12/20/30s + jitter), dừng retry với lỗi cố định / `ended` / `disconnect`, thu `stderr_tail` & bảo vệ `reconnecting` trước khi kết nối, contract `on_status`/`on_live_room`, cùng **2 kiểm tra tích hợp chạy trực tiếp `connector/tiktok-connector.mjs`** (`test_real_connector_bad_username_exits_with_code_2` và `test_real_connector_offline_slardar_device_blocked_and_wss_protobuf`). **Lưu ý:** 2 test connector thật này tự động bỏ qua (`@pytest.mark.skipif(not HAS_NODE_CONNECTOR, ...)`) khi máy chưa có Node.js hoặc chưa cài `node_modules` (`piratetok-live-js` và `ws`); 5 test giả lập tiến trình Node của file này cũng tự động bỏ qua (`skipif`) khi thiếu `node`.
- `npm run build`: kiểm tra TypeScript (`tsc --noEmit -p frontend/tsconfig.json`) và đóng gói Vite ra `dist/`.
- `npm run test:ui`: chạy backend với database tạm, mở Edge/Chrome headless kiểm tra luồng chơi Chặng 1 & Chặng 2, âm thanh, kết nối LIVE UI, phòng giả lập, overlay đồng bộ và bố cục điện thoại, rồi xuất ảnh vào `artifacts/` (chọn trình duyệt qua biến `TETLIVE_BROWSER`).

## Lưu ý

- `piratetok-live-js` (`0.3.0`) là thư viện cộng đồng, **không phải API chính thức của TikTok**, có thể ngừng chạy khi TikTok đổi hệ thống. Kiểm tra điều khoản TikTok trước khi dùng cho kênh của bạn.
- Đã kiểm tra connector trả lỗi đúng khi kênh chưa LIVE và qua harness HTTP/WSS protobuf ngoại tuyến; hãy chạy thử với phòng LIVE thật của bạn trước buổi chính.
- Ứng dụng lắng nghe ở `127.0.0.1`; các yêu cầu ghi (`POST`) từ nguồn/host ngoài loopback bị chặn (`Origin` và kiểm tra proxy headers), trong khi các đường dẫn chỉ đọc và `/ws` phục vụ hiển thị overlay.
- Sprite nhân vật có chuyển động vị trí, nghiêng và nhún nhẹ, chưa có bộ frame đi bộ bốn hướng.
- Tài liệu thiết kế PDF nằm ở `docs/TetLive_Lam_3_Thang_Ve_Que_An_Tet_Bo_Sung_Free_50_700.pdf`; các bản phác thảo SVG nằm ở `concept/`. Bước mở rộng tiếp theo (chưa tích hợp): Chặng 3 (Đường hoa xuân / Đón giao thừa).
