# TetLive Studio

Game TikTok LIVE **Làm hết năm – Về quê ăn Tết**, chặng đầu tiên: **Công ty cuối năm**. Người xem bình luận trên TikTok để vào làm, chạy KPI, thả tim tiếp sức, follow để ký hợp đồng và tặng quà Tết cho cả công ty.

## Mở game trên Windows

Nhấp đúp **`start.cmd`**, đợi dòng địa chỉ xuất hiện rồi mở:

- Bảng điều khiển: **http://127.0.0.1:8000**
- Overlay dọc 9:16: **http://127.0.0.1:8000/?overlay=1**

Giữ cửa sổ chương trình mở trong lúc LIVE. Nhấn `Ctrl+C` để dừng. Cần Python 3.14 và **Node.js 22.19 trở lên** (máy này đang chạy Python 3.14.8, Node.js 24.21.0). Lần cài đầu cần Internet để tải thư viện.

`start.cmd` kiểm tra phiên bản Node.js, cài bộ Python đã xác minh, cài thư viện npm (kể cả connector TikTok nếu máy chưa có) rồi build giao diện. Pydantic được cố định ở **2.12.5** vì bản 2.14.3 có sẵn trên máy bị Windows Application Control chặn thư viện nhị phân. Không thay đổi thiết lập bảo mật Windows.

## Kết nối TikTok LIVE

1. Bật LIVE trên TikTok (điện thoại hoặc TikTok LIVE Studio).
2. Ở bảng điều khiển, mục **TikTok LIVE**: nhập `@tên kênh` (hoặc dán link kênh) rồi bấm **Kết nối**.
3. Nhãn chuyển sang **ĐANG LIVE**, kèm số người xem và bộ đếm bình luận / tim / quà / follow / chia sẻ. Bấm **Ngắt** để dừng.

Không cần mật khẩu, cookie hay API key: chương trình chỉ đọc sự kiện công khai của phòng LIVE. Nếu mạng chập chờn, connector tự nối lại; nếu tiến trình kết nối dừng hẳn, máy chủ thử lại sau 5, 10, 20, 40, 60 giây. Lỗi được báo bằng tiếng Việt: kênh chưa LIVE, sai tên kênh, TikTok tạm chặn mạng, Node.js quá cũ.

**Chưa LIVE vẫn tập được:** bấm **Chạy thử phòng LIVE giả lập** (18 người xem mẫu bình luận, thả tim, follow, chia sẻ, tặng quà qua đúng đường xử lý của LIVE thật), hoặc dùng các nút **Tương tác LIVE thử** (20 tim, follow, chia sẻ, quà 1 / 10 / 99 xu) với tên trong ô *Tên người xem*. Hồ sơ mẫu có tiền tố `demo_` và được gắn nhãn **mẫu**.

## Đưa overlay lên LIVE

1. Bấm **Sao chép link OBS**.
2. **TikTok LIVE Studio**: thêm nguồn *Link / Trình duyệt* trỏ tới link overlay. **OBS**: thêm *Browser Source*, kích thước **1080 × 1920**.
3. Overlay nhận trạng thái qua WebSocket; tải lại vẫn lấy ảnh chụp trạng thái mới nhất. Âm thanh tự bật trong nguồn trình duyệt của TikTok LIVE Studio / OBS; trên trình duyệt thường, bấm biểu tượng loa. Chỉ để một nơi phát âm thanh để tránh tiếng lặp.

Bố cục overlay theo kiểu các game LIVE phổ biến: bảng hiệu và dòng tin chạy ở trên, **Top nhân viên** và **Cách chơi** bên trái, **Quà Tết** và **Tiếp sức / Top thả tim** bên phải, nhân vật kèm ảnh đại diện TikTok và tên ở giữa, phần dưới để trống cho khung bình luận của TikTok. Bấm **Khung TikTok** trên bảng điều khiển để phủ giao diện TikTok mô phỏng (thanh tên kênh, bình luận, ô nhập, nút quà) và vùng hai bên có thể bị cắt trên điện thoại màn hình dài. Khung này chỉ hiện ở bản xem trước, không lên overlay.

## Cách chơi

| Người xem làm | Trong game |
|---|---|
| Bình luận **1** / `vào làm` | Nhận bàn và nhân vật; vào lại giữ nguyên thành tích |
| Bình luận **2** / `làm việc` | +10 KPI, +500 xu, +5 XP; chờ 30 giây giữa hai lượt. Chưa vào làm thì tự nhận bàn rồi làm luôn |
| Bình luận **3** / `cà phê` | Đi tới góc cà phê rồi quay về; chờ 10 giây |
| Bình luận **4** / `lương` | Xem KPI, XP và xu Tết |
| Bình luận `nam` / `nữ` | Đổi nhân vật |
| Bình luận khác | Bong bóng chat trên đầu nhân vật (nếu đã vào làm) |
| **Thả tim** | Nạp thanh *Tiếp sức* chung; đủ **200 tim**, cả công ty được làm việc ngay. Tim không tự tạo hồ sơ |
| **Follow** | Ký hợp đồng chính thức: +1.000 xu, +10 XP, **một lần** mỗi người |
| **Chia sẻ** | +300 xu, tối đa một lần mỗi 5 phút |
| **Quà 1–9 xu** | *Lì xì may mắn*: lời cảm ơn và mưa xu |
| **Quà 10–98 xu** | *Đãi trà sữa*: cả công ty +200 xu |
| **Quà 99+ xu** | *Tiệc tất niên*: cả công ty +1.000 xu, ai cũng làm việc ngay, pháo hoa |

Quà không mua lợi thế cho người tặng: phần thưởng chia đều cho cả công ty, người tặng được cảm ơn trên màn hình và lên bảng *quà*. Quà combo chỉ được tính một lần khi chuỗi kết thúc. Lệnh bình luận chấp nhận cả cách gõ tự nhiên như “vào làm nè”, “Làm việc!!”. Điểm, KPI, XP và xu là vật phẩm trong game, **không quy đổi tiền thật**.

Chế độ mặc định là **văn phòng mở cửa tự do**: người đến muộn vẫn chơi được, một người cũng hoàn thành việc nhỏ (3 lượt làm việc hợp lệ được thêm 500 xu). Khi chưa ai vào, **Nhân sự · NPC** đứng đón khách.

Các nút điều phối giữ nguyên: **Tạm nghỉ / Tiếp tục**, **Sếp kiểm tra!**, **Vòng ba tháng · tùy chọn** (quản trò tự chuyển tháng; mỗi tháng +1.000 xu, +10 XP; **Chốt thưởng Tết** ở tháng 3 phát +3.000 xu đúng một lần), **Quay về chơi tự do**, và **Thử với nhân vật mẫu** (50 hồ sơ mẫu, tự làm việc mỗi 2,2 giây).

## Bóc tách từ repo tham chiếu

Bản sao repo [khanhdevngu/xemtuvionline-bear](https://github.com/khanhdevngu/xemtuvionline-bear) (MIT, BEAR DEV, commit `87ada77`) nằm ở `reference/xemtuvionline-bear/` để đối chiếu; thư mục này không được build hay chạy. TetLive không lấy hình ảnh, âm thanh hay nội dung tử vi của repo, chỉ học cách vận hành:

| Trong repo (`live/server.mjs`, `live/overlay.html`) | TetLive |
|---|---|
| `piratetok-live-js` 0.3.0 đọc chat, quà, tim, follow, chia sẻ, người vào phòng theo `@username` | `connector/tiktok-connector.mjs`: tiến trình Node riêng, chỉ in sự kiện đã chuẩn hóa (JSON từng dòng). Luật game không import thư viện TikTok |
| Chỉ tính quà khi `isStreakOver` | Giữ nguyên; thêm khóa chống trùng lưu trong SQLite |
| `seenEventIds` dọn theo thời gian | LRU giới hạn 5.000 mã sự kiện + bảng `processed_events` bền vững |
| Người xem nằm trong `Map` trên RAM, tối đa 64, đầy thì xóa người ít tương tác | Hồ sơ lưu SQLite, tối đa 700, định danh bằng ID số của TikTok (`tt_<id>`). Chỉ 24 người hoạt động gần nhất được vẽ; người khác rời màn hình chứ không mất hồ sơ |
| Mỗi lượt tim gửi một sự kiện | Gộp tim theo từng người mỗi 1 giây; hàng đợi có giới hạn, bình luận thường bị bỏ trước khi quá tải, follow / quà luôn được giữ |
| Proxy ảnh đại diện: chỉ host TikTok CDN, kiểm tra redirect, tối đa 3 MB, tối đa 400 tệp | `/api/avatar` làm lại bằng Python với cùng danh sách trắng và giới hạn; ảnh lưu ở `data/avatar-cache/` |
| Overlay 1080 × 1920 tự co theo cửa sổ, thẻ tên + ảnh tròn trên đầu nhân vật, thẻ thông báo quà lớn, bảng top | Cảnh Phaser 1080 × 1920 + lớp HUD cùng tỉ lệ, thẻ tên có ảnh TikTok, thẻ thông báo xếp hàng, Top KPI / Top tim |
| Bot mô phỏng và nút thử tương tác | Phòng LIVE giả lập và nút **Tương tác LIVE thử** đi qua đúng pipeline của LIVE thật |

## Âm thanh

Mở tab **Âm thanh** và bấm **Bật âm thanh** một lần. Có nhạc nền Tết nguyên bản 24 giây chạy lặp, tám hiệu ứng ngắn và bốn câu thoại Việt đã lưu thành MP3. Âm lượng nhạc, hiệu ứng và giọng nói được chỉnh riêng, lưu trong trình duyệt. Tệp WAV được tổng hợp từ đầu; câu thoại là kịch bản của dự án, tổng hợp qua gTTS và lưu cục bộ. Nguồn và thông số nằm trong `frontend/public/audio/audio-manifest.json`, cách tái tạo trong `frontend/public/audio/README.md`.

## Dữ liệu và cách phát triển

Hồ sơ, KPI, xu, tim, quà, follow, giai đoạn phiên và sự kiện chống trùng nằm ở **`data/tetlive.sqlite`** (SQLite WAL). Cơ sở dữ liệu cũ tự nâng cấp, giữ nguyên tiến độ. Không xóa thư mục `data` khi muốn giữ tiến độ; có thể sao chép cả thư mục sau khi dừng chương trình. `TETLIVE_DB` chọn tệp SQLite riêng khi kiểm thử.

```text
connector/tiktok-connector.mjs    Đọc sự kiện công khai của phòng TikTok LIVE (Node)
backend/live.py                   Giám sát connector, chống trùng, gộp tim, hàng đợi, phòng giả lập
backend/engine.py                 Luật game, transaction và chống trùng
backend/app.py                    FastAPI, API, WebSocket, proxy ảnh đại diện
frontend/src/main.ts              Bảng điều khiển, HUD overlay, thông báo
frontend/src/office.ts            Cảnh Phaser 1080 × 1920, nhân vật, hiệu ứng
frontend/src/audio.ts             Nhạc, hiệu ứng, hàng đợi thoại
tests/test_game.py, test_live.py  Luật game, sự kiện LIVE, connector, API
scripts/check-ui.mjs              Kiểm tra trình duyệt với database tạm riêng
reference/xemtuvionline-bear/     Bản sao repo tham chiếu (chỉ để đọc)
```

Phát triển với hai cửa sổ terminal:

```powershell
.\.venv\Scripts\python.exe -m uvicorn backend.app:app --host 127.0.0.1 --port 8000
npm run dev
```

Giao diện phát triển tại `http://127.0.0.1:5173`, tự chuyển API và WebSocket về backend. Build phát hành: `npm run build`, sau đó khởi động lại backend.

## Kiểm tra

```powershell
.\.venv\Scripts\python.exe -m pytest tests -q
npm run build
npm run test:ui
```

21 kiểm tra backend: 12 kiểm tra luật gốc (định danh, chống trùng, cooldown qua restart, thưởng một lần, 100 yêu cầu đồng thời, 700 hồ sơ chỉ vẽ 24, snapshot/reconnect, kiểm tra đầu vào, nâng cấp database cũ…) và 9 kiểm tra LIVE: bình luận tự nhiên và tự vào làm, follow trả thưởng một lần, chia sẻ có thời gian chờ, tim không tạo hồ sơ và nạp tiếp sức, quà chia cho cả công ty đúng một lần, người vào phòng không bị tự ghi danh, chuẩn hóa ID / link kênh / ảnh đại diện, cầu nối bỏ sự kiện trùng và gộp tim, một tiến trình connector thật chạy từ đầu đến cuối (dùng connector giả lập lệnh), API LIVE từ chối nguồn lạ và ảnh ngoài danh sách trắng.

`test:ui` tự chạy backend với database tạm, mở Edge/Chrome headless, kiểm tra luồng chơi, tim / follow / quà, kiểm tra tên kênh, khung TikTok, phòng LIVE giả lập, overlay đồng bộ và bố cục điện thoại, rồi xuất ảnh trong `artifacts/`. Chỉ định trình duyệt bằng biến `TETLIVE_BROWSER`.

## Lưu ý

- `piratetok-live-js` là thư viện cộng đồng, **không phải API chính thức của TikTok**, có thể ngừng chạy khi TikTok đổi hệ thống. Kiểm tra điều khoản TikTok trước khi dùng cho kênh của bạn.
- Đã kiểm tra connector trả lỗi đúng khi kênh chưa LIVE. **Chưa đo trên một phòng LIVE thật đang phát**; hãy chạy thử với LIVE của bạn trước buổi chính. Chưa đo tải connector hay FPS trên máy phát OBS. Kiểm tra 700 hồ sơ không phải benchmark 700 người LIVE.
- Ứng dụng chỉ lắng nghe ở `127.0.0.1`; trang web lạ không gửi lệnh được (kiểm tra `Origin`).
- Sprite có chuyển động vị trí và rung nhẹ, chưa có bộ frame đi bộ bốn hướng.

Bước tiếp theo: tích hợp chặng 3 (Đường hoa xuân / Đón giao thừa). Các tài liệu PDF/SVG gốc trong thư mục được giữ nguyên.
