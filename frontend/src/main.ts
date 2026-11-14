import '@fontsource/be-vietnam-pro/400.css';
import '@fontsource/be-vietnam-pro/500.css';
import '@fontsource/be-vietnam-pro/600.css';
import '@fontsource/be-vietnam-pro/700.css';
import '@fontsource/baloo-2/600.css';
import '@fontsource/baloo-2/700.css';
import './style.css';
import { AudioManager } from './audio';
import { LiveConnection, request } from './api';
import { icon } from './icons';
import { STAGE_W, createOffice } from './office';
import type { GameResult, GameState, LiveStatus, Player } from './types';

const overlayMode = new URLSearchParams(location.search).get('overlay') === '1';
document.documentElement.classList.toggle('overlay-mode', overlayMode);
document.body.classList.toggle('overlay-mode', overlayMode);
const app = document.querySelector<HTMLDivElement>('#app')!;
const number = (value: number) => value.toLocaleString('vi-VN');
const escape = (text: string) => text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const initial = (name: string) => escape(([...name.trim()][0] || 'T').toUpperCase());
const isDemo = (player: Pick<Player, 'id'>) => player.id.startsWith('demo_') || player.id.startsWith('rehearsal_');
const isRealLive = (live: LiveStatus) => live.status === 'connected' || live.status === 'reconnecting';
const isWaitingLive = (live: LiveStatus) =>
  Boolean(live.waiting_live)
  || live.status === 'connecting'
  || (live.status === 'disconnected' && live.error.includes('Thử lại'))
  || (live.status === 'error' && (live.code === 'NOT_LIVE' || live.error.includes('tự thử lại')));

function visibleStateForRender(next: GameState): GameState {
  if (!isRealLive(next.live)) return next;
  const players = next.players.filter(player => !isDemo(player));
  const station = next.station
    ? {
        ...next.station,
        waiting: (next.station.waiting ?? []).filter(viewer => !isDemo(viewer)),
        routes: next.station.routes.map((route) => {
          const seats = route.bus.seats.map(seat => (seat && isDemo(seat) ? null : seat));
          const filled = seats.filter(Boolean).length;
          return { ...route, seated: filled, bus: { ...route.bus, seats, filled } };
        }),
      }
    : next.station;
  const originalSamples = next.stats.demo_players ?? 0;
  return {
    ...next,
    players,
    leaderboard: next.leaderboard.filter(player => !isDemo(player)),
    top_hearts: next.top_hearts.filter(player => !isDemo(player)),
    top_gifts: next.top_gifts.filter(player => !isDemo(player)),
    activities: next.activities.filter(entry => !(entry.player_id && isDemo({ id: entry.player_id }))),
    station,
    stats: {
      ...next.stats,
      demo_players: 0,
      visible_players: players.length,
      total_players: Math.max(players.length, next.stats.total_players - originalSamples),
    },
  };
}
const GIFT_LOOK: Record<string, { emoji: string; effect: (reward: number) => string }> = {
  lixi: { emoji: '🧧', effect: () => 'Cảm ơn + mưa xu' },
  treat: { emoji: '🧋', effect: (reward) => `+${number(reward)} xu cả công ty` },
  party: { emoji: '🎆', effect: (reward) => `+${number(reward)} xu · làm ngay` },
};
const LIVE_LABEL: Record<LiveStatus['status'], string> = {
  idle: 'Chưa kết nối', connecting: 'Đang kết nối…', connected: 'Đang LIVE', reconnecting: 'Đang nối lại…',
  disconnected: 'Mất kết nối', error: 'Chưa kết nối được', ended: 'LIVE đã kết thúc', mock: 'Phòng giả lập',
};
const HINTS = [
  'Bình luận 1 để vào làm · 2 để làm việc · 3 cà phê · 4 xem lương',
  'Ở bến xe: Vào xem = Xếp hàng · "lên ghế ngồi" / "1-24" / Tên tỉnh',
  'Thả tim tiếp sức cả công ty · đủ tim là ai cũng làm việc ngay',
  'Follow kênh = ký hợp đồng chính thức · +1.000 xu Tết',
  'Quà tặng chia đều cả công ty · không mua lợi thế hay tranh ghế',
  'Điểm, KPI, vé xe và xu là vật phẩm trong game · không quy đổi tiền thật',
];
const STATION_HINTS = [
  'Vào xem = Xếp hàng · "lên ghế ngồi" / "1-24" / Tên tỉnh',
  'Hàng chờ bên cửa xe · gõ tên tỉnh (63 tỉnh) hoặc số ghế 1–24 để lên xe',
  'Thả tim tiếp sức cả bến · Follow nhận +1.000 xu · Quà chia đều cả phòng',
  'Đủ 24 ghế xe tự xuất bến sau 10 giây · vé miễn phí, không quy đổi tiền thật',
];
const ROUTE_PROVINCES: Record<string, string[]> = {
  mien_tay: [
    'Long An', 'Tiền Giang', 'Bến Tre', 'Trà Vinh', 'Vĩnh Long', 'Đồng Tháp',
    'An Giang', 'Kiên Giang', 'Cần Thơ', 'Hậu Giang', 'Sóc Trăng', 'Bạc Liêu', 'Cà Mau',
  ],
  tay_nguyen: [
    'Kon Tum', 'Gia Lai', 'Đắk Lắk', 'Đắk Nông', 'Lâm Đồng', 'Đà Lạt',
    'Bình Phước', 'Tây Ninh', 'Bình Dương', 'Đồng Nai', 'Bà Rịa - Vũng Tàu', 'TP.HCM',
  ],
  mien_trung: [
    'Thanh Hóa', 'Nghệ An', 'Hà Tĩnh', 'Quảng Bình', 'Quảng Trị', 'Thừa Thiên Huế',
    'Đà Nẵng', 'Quảng Nam', 'Quảng Ngãi', 'Bình Định', 'Phú Yên', 'Khánh Hòa', 'Ninh Thuận', 'Bình Thuận',
  ],
  mien_bac: [
    'Hà Nội', 'Hải Phòng', 'Quảng Ninh', 'Hải Dương', 'Hưng Yên', 'Bắc Ninh', 'Bắc Giang',
    'Vĩnh Phúc', 'Thái Bình', 'Nam Định', 'Hà Nam', 'Ninh Bình', 'Phú Thọ', 'Thái Nguyên',
    'Tuyên Quang', 'Hà Giang', 'Cao Bằng', 'Bắc Kạn', 'Lạng Sơn', 'Lào Cai', 'Yên Bái',
    'Sơn La', 'Điện Biên', 'Lai Châu', 'Hòa Bình',
  ],
};

const face = (player: Pick<Player, 'nickname' | 'skin' | 'avatar'>, className = 'face') => `<span class="${className} skin-${player.skin % 4}" data-initial="${initial(player.nickname)}">${player.avatar ? `<img src="/api/avatar?u=${encodeURIComponent(player.avatar)}" alt="" referrerpolicy="no-referrer" decoding="async">` : ''}</span>`;

const hud = `
  <div class="hud" id="hud" data-scene="office">
    <header class="hud-board">
      <div class="board-title" id="board-title">CÔNG TY CUỐI NĂM</div>
      <div class="board-meta"><span class="board-badge" id="hud-badge" data-mode="idle"><i></i>CHƯA LIVE</span><span id="stage-month">MỞ CỬA TỰ DO</span><span id="stage-headcount">0 nhân viên</span></div>
      <div class="board-caption"><span id="stage-caption">${HINTS[0]}</span></div>
    </header>
    <section class="hud-card hud-leaders office-only"><h3>🏆 Top nhân viên</h3><ol id="hud-leaders"></ol></section>
    <section class="hud-card hud-routes station-only"><h3>🚌 Tuyến xe Tết</h3><ul id="hud-routes"></ul></section>
    <section class="hud-card hud-howto"><h3>Cách chơi</h3><ul>
      <li class="office-only"><b>1</b>vào làm</li><li class="office-only"><b>2</b>làm việc<em>+10 KPI</em></li><li class="office-only"><b>3</b>cà phê</li><li class="office-only"><b>4</b>xem lương</li>
      <li class="station-only"><b class="wide">vào xem</b>xếp hàng</li><li class="station-only"><b class="wide">lên ghế ngồi</b>lên xe</li><li class="station-only"><b class="wide">1–24</b>chọn ghế</li><li class="station-only"><b class="wide">63 tỉnh</b>Nghệ An…</li>
      <li><b class="heart">❤</b>thả tim<em>tiếp sức</em></li><li><b class="follow">＋</b>follow<em id="howto-follow">+1.000 xu</em></li><li><b class="share">↗</b>chia sẻ<em id="howto-share">+300 xu</em></li>
    </ul></section>
    <section class="hud-card hud-gifts"><h3>🎁 Quà Tết</h3><ul id="hud-gifts"></ul></section>
    <section class="hud-card hud-energy"><h3>❤ Tiếp sức</h3><div class="energy-bar"><i id="energy-fill"></i><span id="energy-text">0 / 200 tim</span></div><div class="energy-label">TOP THẢ TIM</div><ol id="hud-hearts"></ol></section>
    <div class="hud-alert" id="hud-alert" hidden><span class="alert-kicker" id="alert-kicker"></span><span class="alert-face" id="alert-face"></span><b id="alert-name"></b><strong id="alert-title"></strong><small id="alert-detail"></small></div>
    <div class="hud-paused" id="stage-paused" hidden><span>☕</span><b id="paused-title">Công ty tạm nghỉ</b><small>Chúng mình quay lại ngay!</small></div>
    <div class="tiktok-guide" id="tiktok-guide" hidden aria-hidden="true">
      <div class="tt-crop left"><span>Có thể bị cắt trên điện thoại</span></div><div class="tt-crop right"><span>Có thể bị cắt trên điện thoại</span></div>
      <div class="tt-status"><b>12:01</b><b>▮▮ 4G 🔋</b></div>
      <div class="tt-profile"><i></i><b id="tt-channel-name">tak · @akkkkk_224</b><span class="tt-follow">+ Follow</span></div>
      <div class="tt-viewers"><i></i><i></i><span>128</span><b>✕</b></div>
      <div class="tt-pill left">🔥 Bảng xếp hạng hằng ngày</div><div class="tt-pill right">Phòng trưng…</div>
      <div class="tt-comments"><p><b>An</b> 1</p><p><b>Bình</b> làm việc</p><p>👋 <b>Chi</b> đã tham gia</p><p><b>Dung</b> ghế 12</p></div>
      <div class="tt-hearts"><span>❤</span><span>❤</span><span>❤</span></div>
      <div class="tt-input">Nhập…</div><div class="tt-buttons"><i>👥</i><i>🌹</i><i>🎁</i><i>↪</i></div>
    </div>
  </div>`;

app.innerHTML = `
  <aside class="sidebar">
    <a class="brand" href="/" aria-label="TetLive Studio"><span class="brand-flower">✿</span><span>Tết<span class="brand-live">live</span><small>STUDIO</small></span></a>
    <div class="sidebar-label">HÀNH TRÌNH VỀ TẾT</div>
    <nav class="journey" aria-label="Không gian hiện tại">
      <div class="journey-item active" id="nav-office" data-scene-control="scene_office" role="button" tabindex="0" aria-current="page"><span class="nav-icon">${icon('office')}</span><div>Công ty cuối năm<small>Vào chơi lúc nào cũng được</small></div></div>
      <div class="journey-item" id="nav-station" data-scene-control="scene_station" role="button" tabindex="0"><span class="nav-icon">${icon('bus')}</span><div>Bến xe 24 ghế<small>Vé miễn phí · 4 tuyến về quê</small></div></div>
    </nav>
    <div class="open-door-note">${icon('live')}<b>Chơi bằng bình luận.</b><p>Văn phòng: gõ 1, 2, 3, 4. Bến xe: gõ lên xe, ghế 1–24 hoặc tên tuyến. Tim, follow và quà đều có hiệu ứng riêng.</p></div>
    <div class="sidebar-note"><span>✿</span><p>Đi làm có đồng nghiệp.<br>Về nhà có người thương.</p><small>MỘT MÙA TẾT THẬT GẦN</small></div>
    <div class="sidebar-bottom"><button class="help-button" id="help-button">${icon('help')} Hướng dẫn chơi ${icon('chevron')}</button><div class="local-badge"><span class="status-dot"></span> Lưu trên máy của bạn</div><span class="version">TETLIVE STUDIO · V0.3</span></div>
  </aside>
  <div class="app-main">
    <header class="topbar"><div class="breadcrumb">Không gian LIVE ${icon('chevron')} <strong id="breadcrumb-scene">Công ty cuối năm</strong></div><div class="top-actions"><span class="connection-pill" id="connection-status"><i></i><span>Đang kết nối</span></span><a class="button button-small button-outline" href="/?overlay=1" target="_blank" rel="noopener">${icon('external')} Mở overlay</a></div></header>
    <main class="workspace">
      <section class="preview-column" aria-label="Xem trước trò chơi">
        <div class="page-heading"><div><div class="eyebrow">MÙA TẾT 2027 <span>✦</span> TIKTOK LIVE</div><h1 id="page-title">Công ty cuối năm<span class="heading-flower">✳</span></h1><p id="page-subtitle">Người xem bình luận để vào làm, chạy KPI và nhận thưởng Tết.</p></div><span class="month-chip" id="month-chip">Mở cửa tự do</span></div>
        <div class="preview-board"><div class="preview-label"><span>${icon('monitor')} MÀN HÌNH LIVE</span><button class="guide-toggle" id="tiktok-toggle" aria-pressed="false">${icon('phone')} Khung TikTok</button><span>9:16 <i></i> 1080 × 1920</span></div><div class="preview-centering"><div class="stage-frame"><div class="stage" id="stage"><div id="game-canvas" role="img" aria-label="Màn hình Tết với nhân vật di chuyển và phản hồi bình luận"></div>${hud}</div></div></div><div class="preview-bottom"><span><i class="status-dot"></i><b id="preview-visible">0</b> nhân vật hiển thị</span><button class="text-button" id="copy-overlay">Sao chép link OBS ${icon('external')}</button></div></div>
        <section class="leaders-section"><div class="section-label">${icon('sparkles')} THÀNH TÍCH <span id="ranking-note">Nhân vật mẫu được gắn nhãn</span></div><div class="leaders" id="leaders"><div class="empty-small">Gõ “vào làm” để nhận bàn và việc nhỏ của bạn.</div></div></section>
      </section>
      <aside class="control-column" aria-label="Điều khiển phiên chơi">
        <div class="panel-tabs" role="tablist" aria-label="Bảng điều khiển"><button id="tab-control" role="tab" aria-selected="true" aria-controls="panel-control" class="selected">${icon('settings')} Điều khiển</button><button id="tab-audio" role="tab" aria-selected="false" aria-controls="panel-audio">${icon('volume')} Âm thanh</button></div>
        <div id="panel-control" role="tabpanel" aria-labelledby="tab-control">
          <section class="panel live-panel"><div class="panel-title"><span class="panel-icon rose">${icon('live')}</span><div><h2>TikTok LIVE</h2><p id="live-subtitle">Đọc bình luận, tim, quà, follow của phòng LIVE.</p></div><span class="live-state" id="live-state" data-status="idle">CHƯA KẾT NỐI</span></div>
            <form id="live-form"><label for="live-user">Tên kênh TikTok <span>đang bật LIVE</span></label><div class="comment-input"><input id="live-user" name="live-user" placeholder="@akkkkk_224" maxlength="120" autocomplete="off" spellcheck="false" /><button class="button button-primary live-button" id="live-connect" type="submit">Kết nối</button></div></form>
            <div class="live-status" id="live-status" aria-live="polite">Bật LIVE trên TikTok trước, rồi nhập tên kênh và bấm Kết nối.</div>
            <div class="live-counters" id="live-counters"></div>
            <button class="button button-outline live-mock" id="live-mock" type="button">${icon('users')} Chạy thử phòng LIVE giả lập</button>
            <button class="button button-outline live-clear" id="clear-demo-button" type="button">${icon('sparkles')} Làm sạch dữ liệu thử (Chuẩn bị LIVE thật)</button>
            <p class="demo-disclosure">TikTok LIVE Studio: chọn <b>Thêm nguồn → Liên kết (Link)</b>, dán <b>http://127.0.0.1:8000/?overlay=1</b> và bật <b>Custom resolution: 1080 × 1920</b> (Full HD 9:16) để chữ và hình nét 1:1, không bị vỡ khi phóng to.</p>
          </section>
          <section class="panel comment-panel"><div class="panel-title"><span class="panel-icon lavender">${icon('chat')}</span><div><h2>Bình luận thử</h2><p>Một câu bình luận, một hành động.</p></div><span class="demo-label">GIẢ LẬP</span></div>
            <form id="command-form"><label for="nickname">Tên người xem <span id="player-selection">Nhân vật của bạn</span></label><input id="nickname" name="nickname" maxlength="24" value="Bạn của Tết" autocomplete="off" required /><div class="command-chips" id="office-chips"><button type="button" data-command="vào làm">${icon('users')} 1 · vào làm</button><button type="button" data-command="làm việc">${icon('sparkles')} 2 · làm việc</button><button type="button" data-command="cà phê">${icon('coffee')} 3 · cà phê</button><button type="button" data-command="lương">${icon('coin')} 4 · lương</button></div><div class="command-chips" id="station-chips" hidden><button type="button" data-command="lên ghế ngồi">${icon('bus')} lên ghế</button><button type="button" data-command="ghế 12">${icon('sparkles')} ghế 12</button><button type="button" data-command="Nghệ An">${icon('road')} Nghệ An</button><button type="button" data-command="Cà Mau">${icon('road')} Cà Mau</button><button type="button" data-command="Đà Lạt">${icon('road')} Đà Lạt</button><button type="button" data-command="Hà Nội">${icon('road')} Hà Nội</button><button type="button" data-command="Đồng Tháp">${icon('road')} Đồng Tháp</button><button type="button" data-command="vé">${icon('coin')} xem vé</button></div><label class="visually-hidden" for="comment">Nội dung bình luận</label><div class="comment-input"><input id="comment" name="comment" placeholder="Nhập bình luận, ví dụ: Nghệ An, Cà Mau hoặc ghế 12" maxlength="160" required autocomplete="off" /><button class="send-button" id="send-command" aria-label="Gửi bình luận">${icon('send')}</button></div></form>
            <div class="live-try-label">TƯƠNG TÁC LIVE THỬ</div>
            <div class="live-chips"><button type="button" data-live="like">${icon('heart')} 20 tim</button><button type="button" data-live="follow">${icon('plus')} Follow</button><button type="button" data-live="share">${icon('share')} Chia sẻ</button><button type="button" data-live="gift" data-diamonds="1" data-gift="Hoa hồng">🧧 Quà 1 xu</button><button type="button" data-live="gift" data-diamonds="10" data-gift="Trà sữa">🧋 Quà 10 xu</button><button type="button" data-live="gift" data-diamonds="99" data-gift="Pháo hoa">🎆 Quà 99 xu</button></div>
            <div class="command-feedback" id="command-feedback" aria-live="polite">${icon('help')} Gõ “vào làm” để nhận nhân vật đầu tiên.</div>
            <div class="player-profile" id="player-profile" hidden></div>
          </section>
          <section class="panel session-panel">
            <div class="panel-title"><span class="panel-icon peach">${icon('coffee')}</span><div><h2>Điều phối phiên</h2><p id="session-description">Vào chơi lúc nào cũng được.</p></div></div>
            <div class="scene-switch" role="group" aria-label="Chặng chơi">
              <button type="button" id="scene-office" data-scene-control="scene_office" aria-pressed="true">${icon('office')} Công ty cuối năm</button>
              <button type="button" id="scene-station" data-scene-control="scene_station" aria-pressed="false">${icon('bus')} Bến xe 24 ghế</button>
            </div>
            <div class="station-controls" id="station-controls" hidden>
              <small>TUYẾN ĐANG MỞ CỔNG · 24 GHẾ / XE</small>
              <div class="route-buttons" id="route-buttons"></div>
              <button type="button" class="button button-primary depart-button" id="depart-button">${icon('bus')} Cho xe xuất bến ngay</button>
              <details class="provinces-guide" id="provinces-guide" open>
                <summary>Danh sách 63 tỉnh thành · 4 tuyến xe ${icon('chevron')}</summary>
                <div class="provinces-groups" id="provinces-groups"></div>
              </details>
            </div>
            <div class="solo-note" id="solo-note">${icon('home')} Một người cũng chơi được · tự do ra vào</div>
            <div class="company-kpi"><span><span id="company-kpi-label">Việc nhỏ của bạn</span><b id="company-kpi-text">0 / 3 việc</b></span><div class="progress-track"><i id="company-kpi-fill"></i></div></div>
            <p class="mission-description" id="mission-description">Làm 3 việc, nhận thêm 500 xu. Xong lại có việc mới.</p>
            <button class="button button-primary relaxed-pause" id="pause-button">${icon('pause')} Tạm nghỉ</button>
            <button class="boss-button" id="boss-button"><span>👀</span><div><b>Sếp kiểm tra!</b><small>Thêm chút vui khi bạn muốn</small></div>${icon('chevron')}</button>
            <details class="optional-controls" id="round-options"><summary>Vòng ba tháng · tùy chọn ${icon('chevron')}</summary><div class="optional-body"><p>Bật khi bạn muốn tổ chức một vòng có mở đầu và tổng kết. Bạn chủ động chuyển tháng.</p><button class="button button-outline" id="mode-button">Tổ chức vòng ba tháng</button><button class="button button-primary" id="month-button" hidden>Sang tháng 2 ${icon('arrow')}</button></div></details>
            <details class="optional-controls" id="demo-options"><summary>Thử với nhân vật mẫu ${icon('chevron')}</summary><div class="optional-body"><div class="simulation-row"><div><b>Nhân vật mẫu tự làm việc</b><small>Giả lập một lệnh mỗi 2,2 giây</small></div><button id="simulation-toggle" class="switch" role="switch" aria-checked="false" aria-label="Bật nhân vật mẫu tự làm việc"><span></span></button></div><button class="seed-button" id="seed-button">${icon('users')} Thử với 50 nhân vật mẫu <span>+</span></button></div></details>
            <div class="capacity-note"><span id="player-count">0</span> hồ sơ người xem <span>·</span> <span id="sample-count">0</span> nhân vật mẫu</div><p class="demo-disclosure" id="audience-note">Chưa kết nối TikTok. Đây là dữ liệu chơi thử.</p>
          </section>
        </div>
        <div id="panel-audio" role="tabpanel" aria-labelledby="tab-audio" hidden><section class="panel audio-panel"><div class="audio-illustration">♫ <span>✦</span></div><div class="audio-heading"><span class="eyebrow">ÂM THANH CỦA NHỮNG NGÀY CUỐI NĂM</span><h2>Cho công ty & bến xe<br>thêm rộn ràng.</h2><p>Nhạc xuân, tiếng còi xe Tết, pháo hoa xuất bến và lời nhắc vui.</p></div><button class="button button-primary" id="enable-audio">${icon('volume')} Bật âm thanh</button><p class="audio-status" id="audio-status">Bật một lần để bắt đầu nghe.</p><div class="mixer"><label>${icon('music')} Nhạc nền <output id="music-value">25%</output><input id="music-volume" type="range" min="0" max="100" value="25" aria-label="Âm lượng nhạc nền" /></label><label>${icon('bell')} Hiệu ứng <output id="effects-value">60%</output><input id="effects-volume" type="range" min="0" max="100" value="60" aria-label="Âm lượng hiệu ứng" /></label><label>${icon('mic')} Giọng nói <output id="voice-value">80%</output><input id="voice-volume" type="range" min="0" max="100" value="80" aria-label="Âm lượng giọng nói" /></label></div><div class="sound-test-label">NGHE THỬ MỘT CHÚT</div><div class="sound-tests"><button data-sound="horn">${icon('bus')} Còi xe Tết</button><button data-sound="depart">${icon('road')} Xuất bến</button><button data-sound="work">${icon('sparkles')} Đạt KPI</button><button data-sound="salary">${icon('coin')} Nhận lương</button><button data-sound="coffee">${icon('coffee')} Cà phê</button><button data-sound="boss">${icon('mic')} Sếp gọi</button></div><div class="audio-note">Giọng nói lần lượt phát từng câu. Nhạc nền tự chuyển theo Công ty hoặc Bến xe Tết.</div></section></div>
        <section class="activity-section"><div class="section-label">VỪA XẢY RA <span class="activity-live"><i class="status-dot"></i> Theo thời gian thực</span></div><ol id="activity-list"><li class="empty-small">Một ngày làm việc mới đang bắt đầu.</li></ol></section>
      </aside>
    </main>
    <footer class="app-footer"><span>${icon('check')} <span id="save-status">Đang mở phiên làm việc…</span></span><span>Hôm nay chạy KPI. Ngày mai xách vali. <span class="footer-flower">✿</span></span></footer>
  </div>
  <div class="toast" id="toast" role="status" hidden></div>
  <dialog id="help-dialog"><button class="dialog-close" id="close-help" aria-label="Đóng hướng dẫn">×</button><span class="eyebrow">CHÀO ĐỒNG NGHIỆP MỚI</span><h2>Vào làm & Về quê ăn Tết! <span>✿</span></h2><ol><li>Bật LIVE trên TikTok, nhập <b>@akkkkk_224</b> (hoặc tên kênh của bạn) rồi bấm <b>Kết nối</b>. Trong TikTok LIVE Studio, chọn <b>Thêm nguồn → Liên kết (Link) → Custom resolution: 1080 × 1920</b> (hoặc OBS Browser Source <b>1080 × 1920</b>) để giữ nét Full HD 1:1.</li><li><b>Chặng 1 – Công ty cuối năm</b>: bình luận <b>1</b> (vào làm), <b>2</b> (làm việc: +10 KPI, +500 xu), <b>3</b> (cà phê), <b>4</b> (xem lương).</li><li><b>Chặng 2 – Bến xe 24 ghế</b>: bấm <b>Bến xe 24 ghế</b> để mở bến. Người xem bình luận <b>lên xe</b>, số ghế <b>1–24</b>, tên tuyến (<b>miền tây</b>, <b>tây nguyên</b>, <b>miền trung</b>, <b>miền bắc</b>), <b>vé</b> hoặc <b>xuống xe</b>. Đủ 24 ghế xe tự xuất bến sau 10 giây!</li><li><b>Thả tim</b> nạp thanh tiếp sức chung. <b>Follow</b> là ký hợp đồng (+1.000 xu, một lần). <b>Quà</b> chia thưởng cho cả phòng, không mua lợi thế hay tranh ghế.</li><li>Chưa LIVE vẫn thử được: <b>Chạy thử phòng LIVE giả lập</b> hoặc các nút <b>Tương tác LIVE thử</b>.</li></ol><p>Điểm, KPI, vé xe và xu là vật phẩm trong game, không quy đổi tiền thật. Hồ sơ được lưu trên máy và giữ lại khi khởi động lại.</p><button class="button button-primary" id="understood-help">Mình hiểu rồi ${icon('arrow')}</button></dialog>
  <button class="overlay-audio" id="overlay-audio" ${overlayMode ? '' : 'hidden'} aria-label="Bật âm thanh cho overlay">${icon('volume')}</button>
`;

const audio = new AudioManager();
let state: GameState | undefined;
let online = false;
let activePlayerId = '';
let simulation: ReturnType<typeof setInterval> | undefined;
let ticking = false;
let busy = false;
let liveBusy = false;
let toastTimer: ReturnType<typeof setTimeout>;
let selectedPlayer: Player | undefined;
let lastNoticeAt = 0;
const seenEvents = new Map<string, boolean>();
const nicknameInput = $<HTMLInputElement>('#nickname');
const liveInput = $<HTMLInputElement>('#live-user');
const storage = {
  get: (key: string) => { try { return localStorage.getItem(key); } catch { return null; } },
  set: (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* Optional convenience. */ } },
};
nicknameInput.value = storage.get('tetlive.nickname') || 'Bạn của Tết';
liveInput.value = storage.get('tetlive.tiktok') || '@akkkkk_224';

function manualId(name: string) {
  let hash = 2166136261;
  for (const char of name.trim().toLowerCase()) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return `manual_${(hash >>> 0).toString(16)}`;
}
const currentPlayerId = () => activePlayerId || manualId(nicknameInput.value);

const office = createOffice($('#game-canvas'), (player) => {
  activePlayerId = player.id;
  nicknameInput.value = player.nickname;
  $('#player-selection').textContent = 'Đã chọn trên màn hình';
  profile(player);
  if (!overlayMode) nicknameInput.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}, overlayMode);

// The HUD is laid out in 1080 × 1920 pixels and scaled with the stage, like the canvas.
const stageFrameElement = $<HTMLElement>('.stage-frame');
const stageElement = $('#stage');
const hudElement = $('#hud');
const syncStageScale = () => {
  if (overlayMode) {
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;
    if (vw > 0 && vh > 0) {
      const targetW = Math.max(180, Math.floor(Math.min(vw, (vh * 9) / 16)));
      const targetH = Math.max(320, Math.floor((targetW * 16) / 9));
      stageFrameElement.style.width = `${targetW}px`;
      stageFrameElement.style.height = `${targetH}px`;
    }
  }
  const width = stageElement.getBoundingClientRect().width || stageElement.clientWidth;
  if (width > 0) {
    hudElement.style.transform = Math.abs(width - STAGE_W) < 0.5 ? 'none' : `scale(${width / STAGE_W})`;
  }
};
const resizeObserver = new ResizeObserver(syncStageScale);
resizeObserver.observe(stageElement);
resizeObserver.observe(document.documentElement);
window.addEventListener('resize', syncStageScale);
syncStageScale();

const htmlCache = new WeakMap<HTMLElement, string>();
function setHtml(element: HTMLElement, html: string) {
  if (htmlCache.get(element) === html) return;
  htmlCache.set(element, html);
  element.innerHTML = html;
  element.querySelectorAll('img').forEach((image) => image.addEventListener('error', () => image.remove(), { once: true }));
}

function toast(message: string) {
  const element = $('#toast');
  element.textContent = message;
  element.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { element.hidden = true; }, 4200);
}

// ---- Board caption: a short queue so a busy LIVE never flickers ----------
const captions: string[] = [];
let captionTimer: ReturnType<typeof setTimeout> | undefined;
let hintIndex = 0;
function showCaption(text: string) {
  const element = $('#stage-caption');
  element.textContent = text;
  element.classList.remove('scrolling');
  element.style.removeProperty('--scroll');
  const overflow = element.scrollWidth - (element.parentElement?.clientWidth ?? element.scrollWidth);
  if (overflow > 4) {
    element.style.setProperty('--scroll', `${-overflow - 24}px`);
    element.style.setProperty('--scroll-time', `${Math.max(4, overflow / 60 + 2.5)}s`);
    void element.offsetWidth;
    element.classList.add('scrolling');
  }
}
function pumpCaptions() {
  captionTimer = undefined;
  const next = captions.shift();
  if (next === undefined) return;
  showCaption(next);
  captionTimer = setTimeout(pumpCaptions, captions.length ? 2600 : 6000);
}
function caption(text: string, urgent = false) {
  lastNoticeAt = Date.now();
  if (urgent) {
    // The streamer's own actions jump the queue.
    captions.length = 0;
    clearTimeout(captionTimer);
    captionTimer = undefined;
  }
  if (captions.length >= 4) captions.shift();
  captions.push(text);
  if (!captionTimer) pumpCaptions();
}

// ---- Big alerts for gifts, follows and room-wide moments -----------------
type Alert = { kicker: string; name: string; who?: Pick<Player, 'nickname' | 'skin' | 'avatar'>; title: string; detail: string; tone: string };
// Small gifts are the most frequent: thank quickly so the side boards stay readable.
const ALERT_TIME: Record<string, number> = { lixi: 2600, follow: 3200, boost: 3800, treat: 4200, party: 4800 };
const alerts: Alert[] = [];
let alertTimer: ReturnType<typeof setTimeout> | undefined;
function pumpAlerts() {
  const element = $('#hud-alert');
  const next = alerts.shift();
  if (!next) { element.hidden = true; alertTimer = undefined; return; }
  element.className = `hud-alert ${next.tone}`;
  $('#alert-kicker').textContent = next.kicker;
  setHtml($('#alert-face'), next.who ? face(next.who, 'alert-avatar') : '<span class="alert-avatar crowd">🏢</span>');
  $('#alert-name').textContent = next.name;
  $('#alert-title').textContent = next.title;
  $('#alert-detail').textContent = next.detail;
  element.hidden = false;
  element.style.animation = 'none';
  void element.offsetWidth;
  element.style.removeProperty('animation');
  const time = ALERT_TIME[next.tone] ?? 4200;
  alertTimer = setTimeout(pumpAlerts, alerts.length ? Math.min(time, 3000) : time);
}
function alert(next: Alert) {
  if (alerts.length >= 5) { const drop = alerts.findIndex(item => item.tone !== 'party'); alerts.splice(drop >= 0 ? drop : 0, 1); }
  alerts.push(next);
  if (!alertTimer) pumpAlerts();
}

function eventAlert(event: GameResult) {
  const who = event.player;
  if (event.code === 'GIFTED' && who && event.gift) {
    const gift = event.gift;
    alert({ kicker: gift.tier === 'party' ? '🎆 TIỆC TẤT NIÊN 🎆' : '🎁 QUÀ TẾT CHO CẢ CÔNG TY', name: who.nickname, who, title: `${gift.name}${gift.count > 1 ? ` ×${gift.count}` : ''} · ${gift.label}`, detail: gift.reward ? `Cả công ty +${number(gift.reward)} xu Tết${gift.tier === 'party' ? ' · ai cũng làm việc ngay' : ''}` : 'Cảm ơn bạn đã lì xì cả công ty!', tone: gift.tier });
  } else if (event.code === 'FOLLOWED' && who) {
    alert({ kicker: '✍ KÝ HỢP ĐỒNG CHÍNH THỨC', name: who.nickname, who, title: 'Đã follow kênh', detail: `+${number(state?.rewards.follow ?? 1000)} xu Tết · cảm ơn bạn!`, tone: 'follow' });
  } else if (event.code === 'BOOST') {
    alert({ kicker: '❤ TIẾP SỨC CẢ CÔNG TY', name: 'Cả công ty', title: `Đủ ${state?.energy.target ?? 200} tim!`, detail: 'Ai cũng được làm việc ngay, không cần chờ', tone: 'boost' });
  } else if (event.code === 'DEPARTED') {
    alert({ kicker: '🚌 CHUYẾN XE ĐOÀN VIÊN', name: 'Bến xe Tết', title: event.message.split('·')[0].trim(), detail: event.message.split('·').slice(1).join('·').trim() || 'Về quê ăn Tết thôi!', tone: 'party' });
  } else if (event.code === 'CONTROL' && (event.action === 'next_month' || event.action === 'bonus')) {
    alert({ kicker: event.action === 'bonus' ? '🧧 THƯỞNG TẾT' : '📅 SANG THÁNG MỚI', name: 'Cả công ty', title: event.message.split('!')[0] + '!', detail: event.message.split('!').slice(1).join('!').trim() || 'Cùng làm tiếp nào!', tone: 'party' });
  }
}

function profile(player: Player) {
  selectedPlayer = player;
  const element = $('#player-profile');
  element.hidden = false;
  element.innerHTML = `<span class="profile-avatar skin-${player.skin % 4}">${initial(player.nickname)}</span><div><b>${escape(player.nickname)}</b><span>${number(player.kpi)} KPI <i>·</i> ${number(player.xp)} XP <i>·</i> ${number(player.hearts ?? 0)} tim</span></div><strong>${number(player.coins)}<small>xu Tết</small></strong>`;
  renderProgress();
}

function renderProgress() {
  if (!state) return;
  const open = state.session.play_mode !== 'scheduled';
  const personal = state.players.find(player => player.id === currentPlayerId()) ?? selectedPlayer;
  const target = state.mission?.target ?? 3;
  const current = open ? personal?.mission_works ?? 0 : state.stats.total_kpi;
  const goal = open ? target : state.stats.company_target;
  $('#company-kpi-fill').style.width = `${Math.min(100, current / goal * 100)}%`;
  $('#company-kpi-text').textContent = `${number(current)} / ${number(goal)}${open ? ' việc' : ' KPI'}`;
  $('#company-kpi-label').textContent = open ? 'Việc nhỏ của bạn' : 'KPI chung';
  $('#mission-description').hidden = !open;
  $('#mission-description').textContent = personal ? `${personal.nickname} · xong ${target} việc nhận thêm 500 xu. Đã nhận ${personal.missions_completed ?? 0} phần quà.` : 'Vào làm để nhận việc nhỏ. Xong 3 việc được thêm 500 xu, rồi lại có việc mới.';
}

function renderHud(next: GameState) {
  const { session, stats, live, station } = next;
  const inStation = session.scene === 'station';
  $('#hud').dataset.scene = session.scene;
  $('#board-title').textContent = inStation ? 'BẾN XE VỀ QUÊ' : 'CÔNG TY CUỐI NĂM';
  const open = session.play_mode !== 'scheduled';
  const focusRoute = station?.routes.find(route => route.code === station.focus) ?? station?.routes[0];
  $('#stage-month').textContent = inStation
    ? (focusRoute ? `TUYẾN ${focusRoute.label.toUpperCase()} · XE ${focusRoute.bus.number}` : 'BẾN XE MỞ CỬA')
    : (open ? 'MỞ CỬA TỰ DO' : session.phase === 'BONUS' ? 'THƯỞNG TẾT ĐOÀN VIÊN' : `THÁNG ${session.month} / 3`);
  const samples = stats.demo_players ?? 0;
  const viewers = stats.total_players - samples;
  const totalSeated = station ? station.routes.reduce((sum, route) => sum + route.seated, 0) : 0;
  const waitingCount = station?.waiting?.length ?? 0;
  $('#stage-headcount').textContent = inStation
    ? `${number(totalSeated)} trên xe · ${number(waitingCount)} chờ`
    : (samples ? `${number(viewers)} nhân viên · ${number(samples)} mẫu` : `${number(viewers)} nhân viên`);
  const badge = $('#hud-badge');
  const waitingLive = isWaitingLive(live);
  let badgeMode = 'idle';
  let badgeText = 'CHƯA LIVE';
  if (live.status === 'connected') {
    badgeMode = 'live';
    badgeText = 'LIVE';
  } else if (live.status === 'reconnecting') {
    badgeMode = 'reconnecting';
    badgeText = 'NỐI LẠI LIVE';
  } else if (waitingLive) {
    badgeMode = 'waiting';
    badgeText = 'CHỜ LIVE';
  } else if (live.status === 'mock') {
    badgeMode = 'mock';
    badgeText = 'MÔ PHỎNG';
  }
  badge.dataset.mode = badgeMode;
  badge.lastChild!.textContent = badgeText;
  $('#stage-paused').hidden = !session.paused;
  $('#paused-title').textContent = inStation ? 'Bến xe tạm nghỉ' : 'Công ty tạm nghỉ';
  $('#howto-follow').textContent = `+${number(next.rewards.follow)} xu`;
  $('#howto-share').textContent = `+${number(next.rewards.share)} xu`;
  const medals = ['🥇', '🥈', '🥉'];
  setHtml($('#hud-leaders'), next.leaderboard.filter(player => player.kpi > 0).slice(0, 3).map((player, index) => `<li>${face(player)}<span class="name">${medals[index]} ${escape(player.nickname)}${isDemo(player) ? ' <small>mẫu</small>' : ''}</span><b>${number(player.kpi)}<small>KPI</small></b></li>`).join('') || '<li class="empty">Bình luận <b>1</b> để vào làm!</li>');
  if (station) {
    setHtml($('#hud-routes'), station.routes.map(route => `<li class="${route.code === station.focus ? 'focus' : ''}"><span class="route-dot" style="background:${route.color}"></span><span class="route-name">${escape(route.label)}</span><em class="${route.bus.countdown !== null ? 'leaving' : ''}">${route.bus.countdown !== null ? `${route.bus.countdown}s` : `${route.bus.filled}/${route.bus.capacity}`}</em></li>`).join(''));
  }
  setHtml($('#hud-gifts'), next.rewards.gift_tiers.map(tier => `<li><span class="gift-icon">${GIFT_LOOK[tier.key]?.emoji ?? '🎁'}</span><div><b>${escape(tier.label)}<em>${number(tier.min)}+ xu</em></b><small>${GIFT_LOOK[tier.key]?.effect(tier.reward) ?? ''}</small></div></li>`).join(''));
  const energy = next.energy;
  $('#energy-fill').style.width = `${Math.min(100, energy.hearts / energy.target * 100)}%`;
  $('#energy-text').textContent = `${number(energy.hearts)} / ${number(energy.target)} tim`;
  setHtml($('#hud-hearts'), next.top_hearts.slice(0, 3).map(player => `<li>${face(player)}<span class="name">${escape(player.nickname)}</span><b>❤ ${number(player.hearts)}</b></li>`).join('') || '<li class="empty">Thả tim để lên bảng!</li>');
}

function renderLive(live: LiveStatus) {
  const onAir = isRealLive(live);
  const waiting = isWaitingLive(live);
  const active = onAir || live.status === 'mock' || waiting;
  const chip = $('#live-state');
  chip.dataset.status = waiting ? 'connecting' : live.status;
  chip.textContent = (waiting ? 'Đang chờ LIVE…' : LIVE_LABEL[live.status]).toUpperCase();
  const button = $<HTMLButtonElement>('#live-connect');
  button.textContent = active ? 'Ngắt' : 'Kết nối';
  button.classList.toggle('button-outline', active);
  button.classList.toggle('button-primary', !active);
  button.disabled = !online || liveBusy;
  liveInput.disabled = active;
  $<HTMLButtonElement>('#live-mock').disabled = !online || liveBusy || live.status === 'mock';
  const since = live.since ? new Intl.DateTimeFormat('vi-VN', { hour: '2-digit', minute: '2-digit' }).format(new Date(live.since * 1000)) : '';
  const room = live.unique_id ? `@${live.unique_id}` : 'phòng LIVE';
  const lines: Record<LiveStatus['status'], string> = {
    idle: 'Bật LIVE trên TikTok trước, rồi nhập tên kênh và bấm Kết nối.',
    connecting: `Đang mở ${room}…`,
    connected: `Đang đọc ${room}${live.viewer_count !== null ? ` · ${number(live.viewer_count)} người xem` : ''}${since ? ` · từ ${since}` : ''}`,
    reconnecting: `${room} chập chờn, đang nối lại. Hồ sơ đã lưu vẫn giữ nguyên.`,
    disconnected: live.error || 'Mất kết nối TikTok LIVE.',
    error: live.error || 'Chưa kết nối được TikTok LIVE.',
    ended: `${room} đã kết thúc LIVE. Hồ sơ và thành tích đã được lưu.`,
    mock: 'Phòng giả lập: 18 người xem mẫu bình luận, thả tim, follow và tặng quà. Hồ sơ được gắn nhãn mẫu.',
  };
  const status = $('#live-status');
  status.textContent = lines[live.status];
  status.classList.toggle('feedback-error', (live.status === 'error' || live.status === 'disconnected') && !waiting);
  const counters = live.counters;
  $('#live-counters').innerHTML = live.status === 'idle' && !counters.chat && !counters.like ? '' : `<span>💬 ${number(counters.chat)}</span><span>❤ ${number(counters.like)}</span><span>🎁 ${number(counters.gift)}</span><span>＋ ${number(counters.follow)}</span><span>↗ ${number(counters.share)}</span>${counters.duplicate ? `<span title="Sự kiện lặp đã bỏ qua">⟲ ${number(counters.duplicate)}</span>` : ''}`;
  $('#live-subtitle').textContent = onAir ? 'Bình luận của người xem đang điều khiển phiên LIVE.' : waiting ? `Tự động kết nối ngay khi ${room} bấm Go LIVE.` : 'Đọc bình luận, tim, quà, follow của phòng LIVE.';
  const pill = $('#connection-status');
  pill.classList.toggle('connected', online);
  pill.classList.toggle('on-air', onAir);
  $('#connection-status span').textContent = !online ? 'Đang nối lại…' : onAir ? `LIVE · @${live.unique_id}` : waiting ? `Chờ LIVE · @${live.unique_id} · sẵn sàng` : live.status === 'mock' ? 'Phòng giả lập' : 'Chơi thử · sẵn sàng';
  $('#audience-note').textContent = onAir ? `Đang nhận sự kiện từ @${live.unique_id}. Hồ sơ định danh bằng ID TikTok.` : waiting ? `Đang chờ @${live.unique_id} bật LIVE trên TikTok LIVE Studio.` : live.status === 'mock' ? 'Phòng giả lập đang chạy. Người xem mẫu được gắn nhãn.' : 'Chưa kết nối TikTok. Đây là dữ liệu chơi thử.';
  $('#ranking-note').textContent = onAir ? 'Bảng xếp hạng phòng LIVE thật' : 'Nhân vật mẫu được gắn nhãn';
}

function processEvent(event: GameResult, shouldNotify = true) {
  const key = event.event_id || (event.seq ? `seq_${event.seq}` : undefined);
  const notify = shouldNotify && event.code !== 'IDLE' && Boolean(event.message);
  if (key && seenEvents.has(key)) {
    // A LIVE copy may arrive before the HTTP reply: only the feedback is still owed.
    if (notify && !seenEvents.get(key)) { seenEvents.set(key, true); feedback(event); }
    return;
  }
  if (key) {
    seenEvents.set(key, notify);
    if (seenEvents.size > 400) seenEvents.delete(seenEvents.keys().next().value!);
  }
  if (event.duplicate) return;
  if (state && isRealLive(state.live) && event.player && isDemo(event.player)) return;
  if (event.player && event.player.id === currentPlayerId() && 'kpi' in event.player) profile(event.player);
  if (event.ok) {
    if (event.cue) audio.play(event.cue);
    if (event.voice) audio.say(event.voice);
    office.scene.react(event);
    eventAlert(event);
    if (event.message && !['IDLE', 'CHAT', 'LIKED'].includes(event.code) && !(state?.session.scene === 'station' && (event.code === 'ENTERED' || event.code === 'RETURNED'))) {
      caption(event.message, event.code === 'CONTROL' || event.code === 'DEPARTED');
    }
  } else if (event.broadcast) {
    office.scene.react(event);
  }
  if (notify) feedback(event);
}

function feedback(event: GameResult) {
  $('#command-feedback').textContent = event.message;
  $('#command-feedback').classList.toggle('feedback-error', !event.ok);
  if (!event.ok || event.code === 'CONTROL' || event.code === 'DEPARTED') toast(event.message);
}

function setState(next: GameState, events: GameResult[] = []) {
  if (state && state.session.id === next.session.id && next.session.version < state.session.version) return;
  const previousScene = state?.session.scene;
  state = next;
  const view = visibleStateForRender(next);
  if (isRealLive(next.live) && selectedPlayer && isDemo(selectedPlayer)) {
    activePlayerId = '';
    selectedPlayer = undefined;
    $('#player-selection').textContent = 'Nhân vật của bạn';
    $('#player-profile').hidden = true;
  }
  office.scene.applyState(view);
  const { session, stats, station } = view;
  const inStation = session.scene === 'station';
  if (previousScene !== session.scene && !captionTimer) {
    showCaption(inStation ? STATION_HINTS[0] : HINTS[0]);
  }
  const open = session.play_mode !== 'scheduled';
  $('#scene-office').setAttribute('aria-pressed', String(!inStation));
  $('#scene-station').setAttribute('aria-pressed', String(inStation));
  $('#nav-office').classList.toggle('active', !inStation);
  $('#nav-station').classList.toggle('active', inStation);
  $('#breadcrumb-scene').textContent = inStation ? 'Bến xe 24 ghế' : 'Công ty cuối năm';
  $('#page-title').innerHTML = `${inStation ? 'Bến xe 24 ghế' : 'Công ty cuối năm'}<span class="heading-flower">✳</span>`;
  $('#page-subtitle').textContent = inStation ? 'Vào xem = Xếp hàng · bình luận “lên ghế ngồi”, số ghế 1–24 hoặc tên tỉnh để về quê ăn Tết.' : 'Người xem bình luận để vào làm, chạy KPI và nhận thưởng Tết.';
  $('#office-chips').hidden = inStation;
  $('#station-chips').hidden = !inStation;
  $('#station-controls').hidden = !inStation;
  if (station) {
    setHtml($('#route-buttons'), station.routes.map(route => `<button type="button" data-route="route_${route.code}" aria-pressed="${route.code === station.focus}"><i style="background:${route.color}"></i>${escape(route.label)}<span>${route.bus.filled}/${route.bus.capacity}</span></button>`).join(''));
    setHtml($('#provinces-groups'), station.routes.map(route => {
      const provinces = route.provinces?.length ? route.provinces : (ROUTE_PROVINCES[route.code] ?? route.stops);
      return `<div class="province-group"><div class="province-group-title"><i style="background:${route.color}"></i><b>${escape(route.label)}</b><span>${provinces.length} tỉnh thành</span></div><div class="province-chips">${provinces.map(p => `<button type="button" class="province-chip" data-province="${escape(p)}">${escape(p)}</button>`).join('')}</div></div>`;
    }).join(''));
    const focusRoute = station.routes.find(route => route.code === station.focus) ?? station.routes[0];
    $<HTMLButtonElement>('#depart-button').disabled = !online || session.paused || !focusRoute || focusRoute.bus.filled === 0;
  }
  $('#month-chip').textContent = inStation ? 'Bến xe Tết' : open ? 'Mở cửa tự do' : session.phase === 'BONUS' ? 'Thưởng Tết ✦' : `Tháng ${session.month} / 3`;
  const samples = stats.demo_players ?? 0;
  const focusBusFilled = station?.routes.find(route => route.code === station.focus)?.bus.filled ?? 0;
  const waitingCount = station?.waiting?.length ?? 0;
  $('#preview-visible').textContent = String(inStation ? focusBusFilled + waitingCount : stats.visible_players);
  $('#player-count').textContent = number(stats.total_players - samples);
  $('#sample-count').textContent = number(samples);
  $('#solo-note').hidden = !open || inStation;
  $('#session-description').textContent = inStation ? 'Đủ 24 khách xe tự xuất bến sau 10 giây, hoặc bạn bấm cho xe chạy ngay.' : open ? 'Ở lại bao lâu tùy bạn. Ghé muộn vẫn chơi được.' : session.phase === 'BONUS' ? 'Đã chốt sổ · thưởng Tết đã vào hồ sơ!' : [`Tháng đầu tiên · cùng bắt nhịp nào!`, `Tháng thứ hai · giữ vững phong độ!`, `Tháng cuối cùng · Tết gần lắm rồi!`][session.month - 1];
  $('#pause-button').innerHTML = `${icon(session.paused ? 'play' : 'pause')} ${session.paused ? 'Tiếp tục' : 'Tạm nghỉ'}`;
  const monthButton = $<HTMLButtonElement>('#month-button');
  monthButton.innerHTML = session.month === 3 ? `${icon('gift')} ${session.phase === 'BONUS' ? 'Đã nhận thưởng' : 'Chốt thưởng Tết'}` : `Sang tháng ${session.month + 1} ${icon('arrow')}`;
  monthButton.hidden = open;
  monthButton.disabled = open || session.phase === 'BONUS' || session.paused || !online;
  $('#mode-button').textContent = open ? 'Tổ chức vòng ba tháng' : 'Quay về chơi tự do';
  $<HTMLButtonElement>('#mode-button').disabled = !online;
  if (!open) $<HTMLDetailsElement>('#round-options').open = true;
  $<HTMLButtonElement>('#boss-button').hidden = inStation;
  $<HTMLButtonElement>('#boss-button').disabled = inStation || (!open && session.phase !== 'OFFICE') || session.paused || !online;
  $('#save-status').textContent = `Đã lưu hồ sơ · Phiên ${session.id.slice(0, 6).toUpperCase()}`;
  $('#leaders').innerHTML = view.leaderboard.slice(0, 3).map((player, index) => `<div class="leader"><span class="leader-rank">${index === 0 ? '✦' : `0${index + 1}`}</span><span class="profile-avatar skin-${player.skin % 4}">${initial(player.nickname)}</span><div><b>${escape(player.nickname)}</b><small>${isDemo(player) ? 'Mẫu · ' : ''}${number(player.kpi)} KPI</small></div></div>`).join('') || '<div class="empty-small">Gõ “vào làm” để nhận bàn và việc nhỏ của bạn.</div>';
  const timeFormat = new Intl.DateTimeFormat('vi-VN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' });
  const activityIcon = (type: string) => ({ work: 'sparkles', coffee: 'coffee', seed: 'users', join: 'users', return: 'users', follow: 'plus', share: 'share', gift: 'gift', boost: 'heart', seat: 'bus', leave: 'bus', depart: 'road' } as Record<string, string>)[type] ?? 'bell';
  $('#activity-list').innerHTML = view.activities.slice(0, 5).map((entry) => `<li><span class="activity-icon ${entry.type === 'work' || entry.type === 'seat' ? 'green' : entry.type === 'gift' || entry.type === 'follow' || entry.type === 'depart' ? 'rose' : ''}">${icon(activityIcon(entry.type))}</span><div>${escape(entry.message)}<time>${timeFormat.format(new Date(entry.created_at * 1000))}</time></div></li>`).join('') || '<li class="empty-small">Một ngày làm việc mới đang bắt đầu.</li>';
  audio.setScene(session.scene);
  audio.setRunning(!session.paused);
  renderHud(view);
  renderLive(view.live);
  renderProgress();
  if (((!open && session.phase === 'BONUS' && !inStation) || isRealLive(next.live)) && simulation) toggleSimulation(false);
  const mine = (event: GameResult) => event.code === 'CONTROL' || event.code === 'DEPARTED' || event.code === 'SEEDED' || event.player?.id === currentPlayerId();
  for (const event of events) processEvent(event, mine(event));
}

function connectionStatus(connected: boolean) {
  online = connected;
  for (const id of ['send-command', 'seed-button', 'pause-button', 'clear-demo-button']) $<HTMLButtonElement>(`#${id}`).disabled = !connected;
  if (!connected) $('#save-status').textContent = 'Đang kết nối lại · hồ sơ đã lưu được giữ nguyên';
  if (state) setState(state);
  else { $('#connection-status').classList.toggle('connected', connected); $('#connection-status span').textContent = connected ? 'Chơi thử · sẵn sàng' : 'Đang nối lại…'; }
}

async function action(path: string, body: object, notify = true): Promise<GameResult | undefined> {
  try {
    const result = await request<GameResult>(path, body);
    if (result.state) setState(result.state);
    processEvent(result, notify);
    return result;
  } catch (error) {
    toast(error instanceof Error ? error.message : 'Kết nối tạm gián đoạn. Thử lại nhé.');
    return undefined;
  }
}

async function sendCommand(text: string) {
  if (busy || !online) return;
  const nickname = nicknameInput.value.trim();
  if (!nickname) { nicknameInput.reportValidity(); return; }
  busy = true;
  $<HTMLButtonElement>('#send-command').disabled = true;
  document.querySelectorAll<HTMLButtonElement>('[data-command],[data-province]').forEach((button) => { button.disabled = true; });
  storage.set('tetlive.nickname', nickname);
  await action('/api/command', { player_id: currentPlayerId(), nickname, text, event_id: crypto.randomUUID() });
  $<HTMLInputElement>('#comment').value = '';
  busy = false;
  $<HTMLButtonElement>('#send-command').disabled = !online;
  document.querySelectorAll<HTMLButtonElement>('[data-command],[data-province]').forEach((button) => { button.disabled = !online; });
}

async function simulate(kind: string, extra: Record<string, unknown>) {
  if (!online) return;
  const nickname = nicknameInput.value.trim();
  if (!nickname) { nicknameInput.reportValidity(); return; }
  storage.set('tetlive.nickname', nickname);
  try {
    const reply = await request<{ ok: boolean; results: GameResult[]; state: GameState }>('/api/live/simulate', { kind, player_id: currentPlayerId(), nickname, event_id: crypto.randomUUID(), ...extra });
    setState(reply.state);
    for (const result of reply.results) processEvent(result, true);
  } catch (error) {
    toast(error instanceof Error ? error.message : 'Kết nối tạm gián đoạn. Thử lại nhé.');
  }
}

async function liveRequest(path: string, body: object = {}) {
  liveBusy = true;
  if (state) renderLive(state.live);
  try {
    const live = await request<LiveStatus>(path, body);
    if (state) { state = { ...state, live }; renderLive(live); }
    if (live.status === 'error' && live.code !== 'NOT_LIVE') toast(live.error);
  } catch (error) {
    toast(error instanceof Error ? error.message : 'Kết nối tạm gián đoạn. Thử lại nhé.');
  } finally {
    liveBusy = false;
    if (state) renderLive(state.live);
  }
}

$('#live-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const live = state?.live;
  const status = live?.status ?? 'idle';
  if (['connected', 'reconnecting', 'connecting', 'mock'].includes(status) || (live && isWaitingLive(live))) {
    void liveRequest('/api/live/disconnect');
    return;
  }
  const name = liveInput.value.trim();
  if (!name) { liveInput.focus(); toast('Nhập tên kênh TikTok đang LIVE, ví dụ @akkkkk_224.'); return; }
  storage.set('tetlive.tiktok', name);
  void liveRequest('/api/live/connect', { unique_id: name });
});
$('#live-mock').addEventListener('click', () => { void liveRequest('/api/live/mock'); });
$('#clear-demo-button').addEventListener('click', async () => {
  if (!online) return;
  if (simulation) toggleSimulation(false);
  const button = $<HTMLButtonElement>('#clear-demo-button');
  button.disabled = true;
  try {
    const result = await action('/api/control', { action: 'clear_demo', event_id: crypto.randomUUID() });
    if (result?.ok) {
      activePlayerId = '';
      selectedPlayer = undefined;
      $('#player-selection').textContent = 'Nhân vật của bạn';
      $('#player-profile').hidden = true;
      renderProgress();
    }
  } finally {
    button.disabled = !online;
  }
});
document.querySelectorAll<HTMLButtonElement>('[data-live]').forEach((button) => button.addEventListener('click', () => {
  const kind = button.dataset.live!;
  void simulate(kind, kind === 'like' ? { count: 20 } : kind === 'gift' ? { diamonds: Number(button.dataset.diamonds), gift: button.dataset.gift } : {});
}));

document.querySelectorAll<HTMLElement>('[data-scene-control]').forEach((element) => {
  element.addEventListener('click', () => {
    if (!online) return;
    void action('/api/control', { action: element.dataset.sceneControl!, event_id: crypto.randomUUID() });
  });
  element.addEventListener('keydown', (event) => {
    if ((event.key === 'Enter' || event.key === ' ') && element.tagName !== 'BUTTON') {
      event.preventDefault();
      element.click();
    }
  });
});
$('#route-buttons').addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-route]');
  if (!button || !online) return;
  void action('/api/control', { action: button.dataset.route!, event_id: crypto.randomUUID() });
});
$('#depart-button').addEventListener('click', () => {
  if (!online) return;
  void action('/api/control', { action: 'depart', event_id: crypto.randomUUID() });
});
$('#provinces-groups').addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-province]');
  if (!button || !online) return;
  void sendCommand(button.dataset.province!);
});

$('#command-form').addEventListener('submit', (event) => { event.preventDefault(); void sendCommand($<HTMLInputElement>('#comment').value); });
nicknameInput.addEventListener('input', () => { activePlayerId = ''; selectedPlayer = undefined; renderProgress(); $('#player-selection').textContent = 'Nhân vật của bạn'; $('#player-profile').hidden = true; });
document.querySelectorAll<HTMLButtonElement>('[data-command]').forEach((button) => button.addEventListener('click', () => { void sendCommand(button.dataset.command!); }));
$('#pause-button').addEventListener('click', () => { if (state) void action('/api/control', { action: state.session.paused ? 'resume' : 'pause', event_id: crypto.randomUUID() }); });
$('#month-button').addEventListener('click', async () => {
  $<HTMLButtonElement>('#month-button').disabled = true;
  await action('/api/control', { action: state?.session.month === 3 ? 'bonus' : 'next_month', event_id: crypto.randomUUID() });
  if (state) setState(state);
});
$('#boss-button').addEventListener('click', () => { void action('/api/control', { action: 'boss', event_id: crypto.randomUUID() }); });
$('#mode-button').addEventListener('click', async () => {
  $<HTMLButtonElement>('#mode-button').disabled = true;
  await action('/api/control', { action: state?.session.play_mode === 'scheduled' ? 'mode_open' : 'mode_scheduled', event_id: crypto.randomUUID() });
  if (state) setState(state);
});
$('#seed-button').addEventListener('click', async () => {
  $<HTMLButtonElement>('#seed-button').disabled = true;
  await action('/api/demo/seed', { count: 50 });
  $<HTMLButtonElement>('#seed-button').disabled = !online;
});

function toggleSimulation(enable: boolean) {
  clearInterval(simulation);
  simulation = undefined;
  $('#simulation-toggle').setAttribute('aria-checked', String(enable));
  if (enable) {
    simulation = setInterval(async () => {
      if (ticking || !online || state?.session.paused || (state?.session.play_mode === 'scheduled' && state?.session.phase !== 'OFFICE' && state?.session.scene !== 'station')) return;
      ticking = true;
      try { await action('/api/demo/tick', {}, false); } finally { ticking = false; }
    }, 2200);
  }
}
$('#simulation-toggle').addEventListener('click', () => toggleSimulation(!simulation));

const guideToggle = $<HTMLButtonElement>('#tiktok-toggle');
function setGuide(show: boolean) {
  guideToggle.setAttribute('aria-pressed', String(show));
  $('#tiktok-guide').hidden = !show;
  storage.set('tetlive.guide', show ? '1' : '0');
}
guideToggle.addEventListener('click', () => setGuide(guideToggle.getAttribute('aria-pressed') !== 'true'));
if (!overlayMode && storage.get('tetlive.guide') === '1') setGuide(true);

for (const tab of ['control', 'audio']) {
  $(`#tab-${tab}`).addEventListener('click', () => {
    for (const current of ['control', 'audio']) {
      $(`#tab-${current}`).setAttribute('aria-selected', String(tab === current));
      $(`#tab-${current}`).classList.toggle('selected', tab === current);
      $(`#panel-${current}`).hidden = current !== tab;
    }
  });
}

function renderAudio() {
  $('#enable-audio').innerHTML = `${icon(audio.enabled && !audio.muted ? 'mute' : 'volume')} ${audio.enabled && !audio.muted ? 'Tắt âm thanh' : 'Bật âm thanh'}`;
  $('#audio-status').textContent = audio.status.label;
  $('#overlay-audio').classList.toggle('audio-on', audio.enabled && !audio.muted);
  $('#overlay-audio').setAttribute('aria-label', audio.enabled && !audio.muted ? 'Tắt âm thanh overlay' : 'Bật âm thanh overlay');
  for (const channel of ['music', 'effects', 'voice'] as const) {
    const value = Math.round(audio.volumes[channel] * 100);
    $<HTMLInputElement>(`#${channel}-volume`).value = String(value);
    $(`#${channel}-value`).textContent = `${value}%`;
  }
}

async function enableAudio() {
  try {
    if (!audio.enabled) { await audio.enable(); audio.say(state?.session.scene === 'station' ? 'station' : 'welcome'); }
    else audio.setMuted(!audio.muted);
    renderAudio();
  } catch { toast('Trình duyệt chưa cho phát âm thanh. Bấm bật lại giúp mình nhé.'); }
}
$('#enable-audio').addEventListener('click', () => { void enableAudio(); });
$('#overlay-audio').addEventListener('click', () => { void enableAudio(); });
for (const channel of ['music', 'effects', 'voice'] as const) {
  $(`#${channel}-volume`).addEventListener('input', (event) => { audio.setVolume(channel, Number((event.target as HTMLInputElement).value) / 100); renderAudio(); });
}
document.querySelectorAll<HTMLButtonElement>('[data-sound]').forEach((button) => button.addEventListener('click', async () => {
  if (!audio.enabled) await audio.enable();
  if (audio.muted) audio.setMuted(false);
  const cue = button.dataset.sound as 'work' | 'salary' | 'coffee' | 'boss' | 'horn' | 'depart';
  audio.play(cue);
  if (cue === 'boss') { audio.say('boss'); toast('“Sếp tới rồi! Cả nhà quay về bàn làm việc nha!”'); }
  else if (cue === 'horn') { audio.say('station'); toast('“Bến xe Tết đã mở cửa! Bà con bình luận tên tỉnh thành hoặc số ghế từ 1 đến 24 để lên xe về quê ăn Tết nha!”'); }
  else if (cue === 'depart') { audio.say('depart'); toast('“Chuyến xe Tết đã xuất bến! Chúc bà con thượng lộ bình an, về quê ăn Tết sum vầy!”'); }
  renderAudio();
}));

$('#copy-overlay').addEventListener('click', async () => {
  const url = new URL('/?overlay=1', location.origin).href;
  try { await navigator.clipboard.writeText(url); toast('Đã sao chép link overlay. Trong TikTok LIVE Studio chọn Link → Custom resolution: 1080 × 1920 để hiển thị nét 1:1.'); }
  catch { toast(`Link overlay: ${url}`); }
});
const help = $<HTMLDialogElement>('#help-dialog');
$('#help-button').addEventListener('click', () => help.showModal());
$('#close-help').addEventListener('click', () => help.close());
$('#understood-help').addEventListener('click', () => help.close());
help.addEventListener('click', (event) => { if (event.target === help) { const bounds = help.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) help.close(); } });

const connection = new LiveConnection(setState, connectionStatus);
audio.onStatus = () => renderAudio();
renderAudio();
if (overlayMode) {
  void audio.enable({ autoplay: true }).then(renderAudio);
  document.addEventListener('pointerdown', (event) => {
    if (!audio.enabled && !(event.target as HTMLElement | null)?.closest('#overlay-audio')) {
      void enableAudio();
    }
  });
}
void request<GameState>('/api/state').then((initialState) => {
  setState(initialState);
  // Opening a page never invents participants or advances the round.
  // In a real desktop browser (not headless WebDriver tests), auto-connect to the pre-filled TikTok channel if idle.
  if (!navigator.webdriver && !overlayMode && initialState.live.status === 'idle' && liveInput.value.trim()) {
    void liveRequest('/api/live/connect', { unique_id: liveInput.value.trim() });
  }
}).catch(() => connectionStatus(false));

const hintTimer = setInterval(() => {
  if (!state?.session.paused && !captionTimer && Date.now() - lastNoticeAt > 14000) {
    const list = state?.session.scene === 'station' ? STATION_HINTS : HINTS;
    showCaption(list[++hintIndex % list.length]);
  }
}, 7000);
window.addEventListener('beforeunload', () => { clearInterval(simulation); clearInterval(hintTimer); connection.dispose(); audio.dispose(); office.game.destroy(true); });
