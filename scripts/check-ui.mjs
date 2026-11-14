import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = await mkdtemp(path.join(tmpdir(), 'tetlive-qa-'));
const artifacts = path.join(root, 'artifacts');
await mkdir(artifacts, { recursive: true });
const freePort = async () => {
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const value = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return value;
};
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const python = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const server = spawn(python, ['-m', 'uvicorn', 'backend.app:app', '--host', '127.0.0.1', '--port', String(port)], {
  cwd: root,
  env: { ...process.env, TETLIVE_DB: path.join(scratch, 'qa.sqlite'), TETLIVE_NO_AUTOCONNECT: '1' },
  windowsHide: true,
  stdio: ['ignore', 'ignore', 'pipe'],
});
let server2;
let serverLog = '';
server.stderr.on('data', chunk => { serverLog = (serverLog + chunk.toString()).slice(-4000); });
let browser;
let autoplayBrowser;
const failures = [];
const inspect = async (page, name) => {
  page.on('pageerror', error => failures.push(`${name}: ${error.message}`));
  page.on('console', msg => { if (msg.type() === 'error') failures.push(`${name} console.error: ${msg.text()}`); });
  page.on('response', response => { if (response.status() >= 400) failures.push(`${name}: ${response.status()} ${response.url()}`); });
};
const readState = () => fetch(`${base}/api/state`).then(response => response.json());

const checkHudLayout = async (targetPage, selectors, label) => {
  const result = await targetPage.evaluate((sels) => {
    const hud = document.querySelector('#hud');
    const hudRect = hud.getBoundingClientRect();
    const items = [];
    const clipped = [];
    for (const sel of sels) {
      const el = hud.querySelector(sel);
      if (!el) continue;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      items.push({ sel, left: r.left, top: r.top, right: r.right, bottom: r.bottom });
      if (r.left < hudRect.left - 1 || r.top < hudRect.top - 1 || r.right > hudRect.right + 1 || r.bottom > hudRect.bottom + 1) {
        clipped.push(`${sel} outside hud`);
      }
      if (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1) {
        clipped.push(`${sel} overflow ${el.scrollWidth}x${el.scrollHeight} > ${el.clientWidth}x${el.clientHeight}`);
      }
    }
    const overlaps = [];
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i];
        const b = items[j];
        if (a.left < b.right - 0.5 && a.right > b.left + 0.5 && a.top < b.bottom - 0.5 && a.bottom > b.top + 0.5) {
          overlaps.push(`${a.sel} overlaps ${b.sel}`);
        }
      }
    }
    const canvas = document.querySelector('#game-canvas canvas');
    return { clipped, overlaps, canvasW: canvas?.width ?? 0, canvasH: canvas?.height ?? 0 };
  }, selectors);
  assert.equal(result.canvasW, 1080, `${label} canvas width must be 1080`);
  assert.equal(result.canvasH, 1920, `${label} canvas height must be 1920`);
  assert.deepEqual(result.overlaps, [], `${label} HUD cards must not overlap`);
  assert.deepEqual(result.clipped, [], `${label} HUD cards must not clip or overflow`);
  return result;
};

try {
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    try { ready = (await fetch(`${base}/api/health`)).ok; } catch { /* Wait for owned server. */ }
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  assert(ready, `Server failed to start: ${serverLog}`);
  const executables = [process.env.TETLIVE_BROWSER, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].filter(Boolean);
  browser = await chromium.launch({ headless: true, executablePath: executables.find(existsSync) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1080 } });
  const page = await context.newPage();
  await inspect(page, 'desktop');
  await page.goto(base);
  await expect(page.locator('#connection-status')).toContainText('sẵn sàng');
  await expect.poll(async () => (await readState()).stats.total_players).toBe(0);
  await expect(page.locator('#month-chip')).toHaveText('Mở cửa tự do');
  await expect(page.locator('#stage-month')).toHaveText('MỞ CỬA TỰ DO');
  await expect(page.locator('#live-state')).toHaveText('CHƯA KẾT NỐI');
  await expect(page.locator('#live-user')).toHaveValue('');
  await expect(page.locator('#hud-badge')).toHaveText('CHƯA LIVE');
  await expect(page.locator('#hud-badge')).toHaveAttribute('data-mode', 'idle');
  await expect(page.locator('#month-button')).toBeHidden();
  assert.equal(await page.locator('.journey-item').count(), 2);
  await expect(page.locator('#game-canvas canvas')).toBeVisible();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(artifacts, 'open-office-empty.png'), fullPage: true });
  await expect(page.locator('#music-value')).toHaveText('65%');
  await expect(page.locator('#effects-value')).toHaveText('75%');
  await expect(page.locator('#voice-value')).toHaveText('92%');

  // Comments from the rehearsal box follow the same rules as TikTok chat.
  await page.locator('#nickname').fill('Kiểm thử Tết');
  await page.locator('[data-command="vào làm"]').click();
  await expect(page.locator('#command-feedback')).toContainText('đã vào công ty');
  await expect(page.locator('#enable-audio')).toContainText('Tắt âm thanh', { timeout: 15000 });
  await expect(page.locator('#audio-status')).toContainText('Âm thanh sẵn sàng');
  await page.locator('#comment').fill('2');
  await page.locator('#send-command').click();
  await expect(page.locator('#player-profile')).toContainText('10 KPI');
  await expect(page.locator('#player-profile')).toContainText('500');
  await expect(page.locator('#company-kpi-text')).toHaveText('1 / 3 việc');
  await expect(page.locator('#hud-leaders')).toContainText('Kiểm thử Tết');
  assert.equal((await readState()).stats.total_players, 1);
  await page.locator('[data-command="làm việc"]').click();
  await expect(page.locator('#command-feedback')).toContainText('đợi thêm');
  assert.equal((await readState()).stats.total_kpi, 10);
  await page.locator('[data-command="cà phê"]').click();
  await expect(page.locator('#command-feedback')).toContainText('góc cà phê');

  // LIVE interactions: hearts, follow and gifts.
  await page.locator('[data-live="like"]').click();
  await expect(page.locator('#energy-text')).toHaveText('20 / 200 tim');
  await expect(page.locator('#hud-hearts')).toContainText('Kiểm thử Tết');
  await page.locator('[data-live="follow"]').click();
  await expect(page.locator('#hud-alert')).toBeVisible();
  await expect(page.locator('#alert-title')).toHaveText('Đã follow kênh');
  await expect(page.locator('#player-profile')).toContainText('1.500');
  await page.locator('[data-live="follow"]').click();
  await expect.poll(async () => (await readState()).players[0].coins).toBe(1500);
  await page.locator('[data-live="gift"][data-diamonds="99"]').click();
  await expect(page.locator('#alert-title')).toContainText('Tiệc tất niên', { timeout: 8000 });
  await expect(page.locator('#player-profile')).toContainText('2.500');
  await expect(page.locator('#hud-gifts')).toContainText('99+ xu');

  await page.locator('#pause-button').click();
  await expect(page.locator('#stage-paused')).toBeVisible();
  await page.locator('[data-command="làm việc"]').click();
  await expect(page.locator('#command-feedback')).toContainText('tạm nghỉ');
  await page.locator('#pause-button').click();
  await expect(page.locator('#stage-paused')).toBeHidden();
  await page.locator('#boss-button').click();
  await expect(page.locator('#stage-caption')).toContainText('Sếp kiểm tra');
  await page.locator('#help-button').click();
  await expect(page.locator('#help-dialog')).toBeVisible();
  await page.locator('#understood-help').click();

  // Connector input is validated locally; a bad name never starts a connection.
  await page.locator('#live-user').fill('bad name!');
  await page.locator('#live-connect').click();
  await expect(page.locator('#live-status')).toContainText('Tên tài khoản TikTok chưa đúng');
  await expect(page.locator('#live-state')).toHaveText('CHƯA KẾT NỐI ĐƯỢC');

  await page.locator('#tab-audio').click();
  await expect(page.locator('#enable-audio')).toContainText('Tắt âm thanh', { timeout: 15000 });
  // Clicking #enable-audio toggles mute/unmute cleanly once audio is running.
  await page.locator('#enable-audio').click();
  await expect(page.locator('#enable-audio')).toContainText('Bật âm thanh');
  await page.locator('#enable-audio').click();
  await expect(page.locator('#enable-audio')).toContainText('Tắt âm thanh');
  for (const cue of ['horn', 'depart', 'work', 'salary', 'coffee', 'boss']) await page.locator(`[data-sound="${cue}"]`).click();
  await page.locator('#music-volume').evaluate(element => { element.value = '18'; element.dispatchEvent(new Event('input', { bubbles: true })); });
  await expect(page.locator('#music-value')).toHaveText('18%');
  await page.waitForTimeout(2200);
  await page.screenshot({ path: path.join(artifacts, 'audio.png'), fullPage: true });
  await page.reload();
  await expect(page.locator('#connection-status')).toContainText('sẵn sàng');
  await expect(page.locator('#nickname')).toHaveValue('Kiểm thử Tết');
  await page.locator('[data-command="lương"]').click();
  await expect(page.locator('#player-profile')).toContainText('2.500');
  await expect(page.locator('#music-value')).toHaveText('18%');
  await page.locator('#tiktok-toggle').click();
  await expect(page.locator('#tiktok-guide')).toBeVisible();
  await page.waitForTimeout(2200);
  await page.screenshot({ path: path.join(artifacts, 'desktop.png'), fullPage: true });
  await page.locator('#stage').screenshot({ path: path.join(artifacts, 'tiktok-frame.png') });
  await page.locator('#tiktok-toggle').click();
  await expect(page.locator('#tiktok-guide')).toBeHidden();

  const overlay = await context.newPage();
  await inspect(overlay, 'overlay');
  // Verify ?overlay=1 fits crisp 9:16 with zero scrollbars on both wide desktop Chrome and 9:16 viewports.
  for (const vp of [{ width: 1280, height: 800, fullBleed: false }, { width: 1080, height: 1920, fullBleed: true }, { width: 540, height: 960, fullBleed: true }]) {
    await overlay.setViewportSize({ width: vp.width, height: vp.height });
    if (vp.width === 1280) await overlay.goto(`${base}/?overlay=1`);
    await expect(overlay.locator('.topbar')).toBeHidden();
    await expect(overlay.locator('#game-canvas canvas')).toBeVisible();
    await expect(overlay.locator('#tiktok-guide')).toBeHidden();
    const fit = await overlay.evaluate(() => {
      const stage = document.querySelector('#stage').getBoundingClientRect();
      const hud = document.querySelector('#hud').getBoundingClientRect();
      const canvas = document.querySelector('#game-canvas canvas');
      const doc = document.documentElement;
      return {
        stage: { x: stage.x, y: stage.y, width: stage.width, height: stage.height },
        hud: { width: hud.width, height: hud.height },
        canvas: { width: canvas?.width ?? 0, height: canvas?.height ?? 0 },
        scrollW: doc.scrollWidth,
        clientW: doc.clientWidth,
        scrollH: doc.scrollHeight,
        clientH: doc.clientHeight,
        innerW: window.innerWidth,
        innerH: window.innerHeight,
      };
    });
    assert.equal(fit.canvas.width, 1080, `Overlay ${vp.width}x${vp.height} canvas backing width must stay 1080`);
    assert.equal(fit.canvas.height, 1920, `Overlay ${vp.width}x${vp.height} canvas backing height must stay 1920`);
    assert(Math.abs(fit.stage.width / fit.stage.height - 9 / 16) < 0.01, `Overlay ${vp.width}x${vp.height} must keep 9:16 ratio`);
    assert(Math.abs(fit.hud.width - fit.stage.width) < 1.5 && Math.abs(fit.hud.height - fit.stage.height) < 1.5, 'HUD must scale with the stage');
    assert(fit.stage.x >= -0.5 && fit.stage.y >= -0.5 && fit.stage.width <= fit.innerW + 0.5 && fit.stage.height <= fit.innerH + 0.5, `Overlay ${vp.width}x${vp.height} stage clipped`);
    assert(fit.scrollW <= fit.clientW + 1 && fit.scrollH <= fit.clientH + 1, `Overlay ${vp.width}x${vp.height} has scrollbars: ${fit.scrollW}x${fit.scrollH} vs ${fit.clientW}x${fit.clientH}`);
    if (vp.fullBleed) {
      assert(Math.abs(fit.stage.width - vp.width) < 1.5 && Math.abs(fit.stage.height - vp.height) < 1.5, `Overlay ${vp.width}x${vp.height} must fill 100%`);
    }
  }
  await page.locator('#demo-options summary').click();
  await page.locator('#seed-button').click();
  await expect.poll(async () => (await readState()).stats.total_players).toBe(51);
  await expect(overlay.locator('#stage-headcount')).toHaveText('1 nhân viên · 50 mẫu');
  assert.equal((await readState()).players.length, 24);
  await page.locator('#simulation-toggle').click();
  await expect.poll(async () => (await readState()).stats.total_kpi, { timeout: 8000 }).toBeGreaterThan(10);
  await page.locator('#simulation-toggle').click();
  await page.locator('#round-options summary').click();
  await page.locator('#mode-button').click();
  await page.locator('#month-button').click();
  await expect(page.locator('#month-chip')).toHaveText('Tháng 2 / 3');
  await page.locator('#month-button').click();
  await expect(page.locator('#month-chip')).toHaveText('Tháng 3 / 3');
  await page.locator('#month-button').click();
  await expect(page.locator('#month-chip')).toContainText('Thưởng Tết');
  await expect(page.locator('#month-button')).toBeDisabled();
  await expect(overlay.locator('#stage-month')).toHaveText('THƯỞNG TẾT ĐOÀN VIÊN');
  await page.locator('#mode-button').click();
  await expect(page.locator('#month-chip')).toHaveText('Mở cửa tự do');
  await expect(overlay.locator('#stage-month')).toHaveText('MỞ CỬA TỰ DO');
  await page.locator('#nickname').fill('Người đến muộn');
  await page.locator('[data-command="vào làm"]').click();
  await page.locator('[data-command="làm việc"]').click();
  await expect(page.locator('#player-profile')).toContainText('10 KPI');

  // Rehearsal room: sample viewers drive the overlay through the real LIVE pipeline.
  await page.locator('#live-mock').click();
  await expect(page.locator('#live-state')).toHaveText('PHÒNG GIẢ LẬP');
  await expect(overlay.locator('#hud-badge')).toHaveText('MÔ PHỎNG');
  await expect(overlay.locator('#hud-badge')).toHaveAttribute('data-mode', 'mock');
  await expect.poll(async () => (await (await fetch(`${base}/api/live/status`)).json()).counters.chat, { timeout: 10000 }).toBeGreaterThan(2);
  await expect.poll(async () => (await readState()).stats.demo_players, { timeout: 10000 }).toBeGreaterThan(50);
  await overlay.waitForTimeout(3000);
  await checkHudLayout(overlay, ['.hud-board', '.hud-leaders', '.hud-howto', '.hud-gifts', '.hud-energy'], 'Office overlay');
  await overlay.screenshot({ path: path.join(artifacts, 'overlay.png') });
  await page.locator('#live-connect').click();
  await expect(page.locator('#live-state')).toHaveText('CHƯA KẾT NỐI');
  await expect(overlay.locator('#hud-badge')).toHaveText('CHƯA LIVE');
  await expect(overlay.locator('#hud-badge')).toHaveAttribute('data-mode', 'idle');

  // Stage 2: Bus station 24 seats, waiting queue join -> "lên ghế ngồi" / "1" / province -> departure.
  await page.locator('#scene-station').click();
  await expect(page.locator('#board-title')).toHaveText('BẾN XE VỀ QUÊ');
  await expect(overlay.locator('#board-title')).toHaveText('BẾN XE VỀ QUÊ');
  await expect(page.locator('#station-controls')).toBeVisible();
  await expect(page.locator('#provinces-guide')).toBeVisible();
  assert((await page.locator('[data-province]').count()) >= 63, 'All 63 provinces must be listed in station guide');

  // Real-time viewer enter adds named chibis into station.waiting visible in HUD & queue.
  const simPost = (payload) => fetch(`${base}/api/live/simulate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }).then(r => r.json());
  const enterOne = await simPost({ kind: 'enter', player_id: 'tt_wait_1', nickname: 'Nick Phụ 1', event_id: 'ui-enter-1' });
  assert.equal(enterOne.results[0].code, 'ENTERED');
  assert.equal(enterOne.results[0].cue, 'join');
  const enterTwo = await simPost({ kind: 'enter', player_id: 'tt_wait_2', nickname: 'Nick Phụ 2', event_id: 'ui-enter-2' });
  assert.equal(enterTwo.results[0].code, 'ENTERED');
  const enterThree = await simPost({ kind: 'enter', player_id: 'tt_wait_3', nickname: 'Khách Đợi Xe', event_id: 'ui-enter-3' });
  assert.equal(enterThree.results[0].code, 'ENTERED');
  await expect(page.locator('#stage-headcount')).toContainText('3 chờ');
  await expect(overlay.locator('#stage-headcount')).toContainText('3 chờ');
  await expect(page.locator('#preview-visible')).toHaveText('3');

  // "1" moves Nick Phụ 2 from waiting queue onto seat 1 on Miền Tây with horn audio cue.
  const boardNum = await simPost({ kind: 'chat', player_id: 'tt_wait_2', nickname: 'Nick Phụ 2', text: '1', event_id: 'ui-board-2' });
  assert.equal(boardNum.results[0].code, 'SEATED');
  assert.equal(boardNum.results[0].cue, 'horn');
  assert.equal(boardNum.results[0].ticket.seat, 1);
  await expect.poll(async () => (await readState()).station.waiting.map(w => w.id)).not.toContain('tt_wait_2');
  await expect(overlay.locator('#stage-headcount')).toContainText('1 trên xe · 2 chờ');

  // "lên ghế ngồi" moves Nick Phụ 1 from waiting queue onto open seat 2 with horn audio cue.
  const boardPhrase = await simPost({ kind: 'chat', player_id: 'tt_wait_1', nickname: 'Nick Phụ 1', text: 'lên ghế ngồi', event_id: 'ui-board-1' });
  assert.equal(boardPhrase.results[0].code, 'SEATED');
  assert.equal(boardPhrase.results[0].cue, 'horn');
  assert.equal(boardPhrase.results[0].ticket.seat, 2);
  await expect.poll(async () => (await readState()).station.waiting.map(w => w.id)).not.toContain('tt_wait_1');
  await expect(overlay.locator('#stage-headcount')).toContainText('2 trên xe · 1 chờ');

  // Province comment updates hometown pill with audio cue ("Cà Mau" on Miền Tây).
  const pickHome = await simPost({ kind: 'chat', player_id: 'tt_wait_2', nickname: 'Nick Phụ 2', text: 'Cà Mau', event_id: 'ui-home-2' });
  assert.equal(pickHome.results[0].ticket.hometown, 'Cà Mau');
  assert.equal(pickHome.results[0].cue, 'click');
  await expect.poll(async () => {
    const st = (await readState()).station;
    const mienTay = st?.routes?.find(r => r.code === 'mien_tay');
    return mienTay?.bus?.seats?.[0]?.hometown;
  }).toBe('Cà Mau');

  // Direct province comment from waiting queue seats viewer with hometown pill and removes from queue.
  const enterFour = await simPost({ kind: 'enter', player_id: 'tt_wait_4', nickname: 'Hành Khách 4', event_id: 'ui-enter-4' });
  assert.equal(enterFour.results[0].code, 'ENTERED');
  const boardProv = await simPost({ kind: 'chat', player_id: 'tt_wait_4', nickname: 'Hành Khách 4', text: 'Cần Thơ', event_id: 'ui-board-4' });
  assert.equal(boardProv.results[0].code, 'SEATED');
  assert.equal(boardProv.results[0].cue, 'horn');
  assert.equal(boardProv.results[0].ticket.hometown, 'Cần Thơ');
  await expect.poll(async () => (await readState()).station.waiting.map(w => w.id)).not.toContain('tt_wait_4');

  // "ra xe" moves a waiting viewer onto the next open seat and clears them from the waiting queue.
  const enterFive = await simPost({ kind: 'enter', player_id: 'tt_wait_5', nickname: 'Khách Ra Xe', event_id: 'ui-enter-5' });
  assert.equal(enterFive.results[0].code, 'ENTERED');
  const boardRaXe = await simPost({ kind: 'chat', player_id: 'tt_wait_5', nickname: 'Khách Ra Xe', text: 'ra xe', event_id: 'ui-board-raxe' });
  assert.equal(boardRaXe.results[0].code, 'SEATED');
  assert.equal(boardRaXe.results[0].cue, 'horn');
  assert.equal(boardRaXe.results[0].ticket.seat, 4);
  await expect.poll(async () => (await readState()).station.waiting.map(w => w.id)).not.toContain('tt_wait_5');

  // Ensure 3 rows render inside #hud-hearts so .hud-energy 3-row fit is verified without overflow.
  await simPost({ kind: 'like', player_id: 'tt_wait_2', nickname: 'Nick Phụ 2', count: 15, event_id: 'ui-like-wait-2' });
  await simPost({ kind: 'like', player_id: 'tt_wait_1', nickname: 'Nick Phụ 1', count: 10, event_id: 'ui-like-wait-1' });
  await expect(overlay.locator('#hud-hearts li:not(.empty)')).toHaveCount(3);

  // Check native 1080×1920 overlay HUD layout and capture screenshots before asserting geometry.
  await overlay.setViewportSize({ width: 1080, height: 1920 });
  await page.waitForTimeout(1600);
  await page.screenshot({ path: path.join(artifacts, 'station.png'), fullPage: true });
  await overlay.screenshot({ path: path.join(artifacts, 'station-overlay.png') });
  await checkHudLayout(overlay, ['.hud-board', '.hud-routes', '.hud-howto', '.hud-gifts', '.hud-energy'], 'Station overlay');

  await page.locator('#nickname').fill('Khách Nghệ An');
  await page.locator('[data-province="Nghệ An"]').click();
  await expect(page.locator('#command-feedback')).toContainText('Nghệ An');
  await expect(page.locator('#command-feedback')).toContainText('Miền Trung');
  await expect.poll(async () => {
    const st = (await readState()).station;
    const mienTrung = st?.routes?.find(r => r.code === 'mien_trung');
    return mienTrung?.bus?.seats?.find(Boolean)?.hometown;
  }).toBe('Nghệ An');
  await page.locator('#nickname').fill('Người đến muộn');
  await page.locator('[data-route="route_tay_nguyen"]').click();
  await expect(page.locator('#stage-month')).toContainText('TUYẾN TÂY NGUYÊN');
  await page.locator('[data-command="ghế 12"]').click();
  await expect(page.locator('#command-feedback')).toContainText('ghế 12');
  await expect(overlay.locator('#hud-routes')).toContainText('1/24');
  await page.locator('#depart-button').click();
  await expect(page.locator('#command-feedback')).toContainText('xuất bến');

  // clear_demo button wipes demo_* and manual_* players, seats, and rehearsal energy cleanly while preserving real tt_* viewers.
  await page.locator('#clear-demo-button').click();
  await expect(page.locator('#command-feedback')).toContainText('Đã làm sạch');
  await expect.poll(async () => {
    const st = await readState();
    const isTestId = (id) => id.startsWith('demo_') || id.startsWith('manual_') || id.startsWith('rehearsal_');
    const badPlayers = st.players.filter(p => isTestId(p.id)).length;
    const badSeats = (st.station?.routes ?? []).flatMap(r => r.bus.seats).filter(s => s && isTestId(s.id)).length;
    const badWait = (st.station?.waiting ?? []).filter(w => isTestId(w.id)).length;
    return { demo: st.stats.demo_players, badPlayers, badSeats, badWait, hearts: st.energy.hearts, boosts: st.energy.boosts };
  }).toEqual({ demo: 0, badPlayers: 0, badSeats: 0, badWait: 0, hearts: 0, boosts: 0 });
  assert((await readState()).players.some(p => p.id === 'tt_wait_2'), 'Real tt_* viewers must survive clear_demo');
  await expect(overlay.locator('#energy-text')).toHaveText('0 / 200 tim');
  const clearedHudText = await overlay.locator('#hud').innerText();
  for (const fakeName of ['Bé Na', 'Kiểm thử Tết', 'Người đến muộn', 'Khách Nghệ An']) {
    assert(!clearedHudText.includes(fakeName), `Fake/manual name "${fakeName}" remained in HUD after clear_demo`);
  }
  await expect(overlay.locator('#hud-alert')).toBeHidden({ timeout: 8000 });
  await overlay.screenshot({ path: path.join(artifacts, 'station-cleared.png') });

  await page.locator('#scene-office').click();
  await expect(page.locator('#board-title')).toHaveText('CÔNG TY CUỐI NĂM');
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'Desktop layout overflows horizontally');

  // Verify CHỜ LIVE -> LIVE -> NỐI LẠI LIVE -> LIVE badge transitions + auto-clean + real "ra xe" via an ephemeral server with a mock connector.
  const port2 = await freePort();
  const base2 = `http://127.0.0.1:${port2}`;
  const markerFile = path.join(scratch, 'live-attempt.txt');
  const fakeConnector = path.join(scratch, 'fake-connector.mjs');
  await writeFile(fakeConnector, `
    import fs from 'node:fs';
    import readline from 'node:readline';
    const marker = ${JSON.stringify(markerFile)};
    const attempt = (fs.existsSync(marker) ? Number(fs.readFileSync(marker, 'utf8')) : 0) + 1;
    fs.writeFileSync(marker, String(attempt));
    const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
    send({ t: 'status', status: 'connecting', uniqueId: process.argv[2] });
    if (attempt === 1) {
      setTimeout(() => {
        send({ t: 'status', status: 'error', code: 'NOT_LIVE', error: 'offline' });
        process.exit(1);
      }, 250);
    } else {
      setTimeout(() => {
        send({ t: 'status', status: 'connected', uniqueId: process.argv[2], roomId: 'qa_live_room' });
        send({ t: 'viewers', count: 12 });
      }, 250);
      setTimeout(() => {
        send({ t: 'status', status: 'reconnecting', uniqueId: process.argv[2] });
      }, 1500);
      setTimeout(() => {
        send({ t: 'status', status: 'connected', uniqueId: process.argv[2], roomId: 'qa_live_room' });
        send({ t: 'chat', id: 'qa_real_raxe', user: { id: '888123', uniqueId: 'real.tester', nickname: 'Khách LIVE Thật' }, text: 'ra xe' });
      }, 2600);
      readline.createInterface({ input: process.stdin }).on('line', (line) => { if (line.trim() === 'quit') process.exit(0); });
    }
  `, 'utf8');
  const liveRunner = `import uvicorn; from pathlib import Path; from backend.app import create_app; uvicorn.run(create_app(Path(${JSON.stringify(path.join(scratch, 'qa-live.sqlite'))}), connector=Path(${JSON.stringify(fakeConnector)})), host='127.0.0.1', port=${port2}, log_level='warning')`;
  server2 = spawn(python, ['-c', liveRunner], {
    cwd: root,
    env: { ...process.env, TETLIVE_NO_AUTOCONNECT: '1' },
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let server2Ready = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    try { server2Ready = (await fetch(`${base2}/api/health`)).ok; } catch { /* Wait for ephemeral live QA server. */ }
    if (server2Ready) break;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  assert(server2Ready, 'Ephemeral live QA server failed to start');
  const livePage = await context.newPage();
  await inspect(livePage, 'live-transitions');
  await livePage.goto(base2);
  await expect(livePage.locator('#hud-badge')).toHaveText('CHƯA LIVE');
  await expect(livePage.locator('#live-user')).toHaveValue('');
  await livePage.locator('#scene-station').click();
  await expect(livePage.locator('#board-title')).toHaveText('BẾN XE VỀ QUÊ');
  await fetch(`${base2}/api/demo/seed`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ count: 3 }) });
  await livePage.locator('#live-user').fill('@kenh_thu_live');
  await livePage.locator('#live-connect').click();
  await expect(livePage.locator('#hud-badge')).toHaveText('CHỜ LIVE');
  await expect(livePage.locator('#hud-badge')).toHaveAttribute('data-mode', 'waiting');
  await expect(livePage.locator('#live-state')).toHaveText('ĐANG CHỜ LIVE…', { timeout: 6000 });
  await expect(livePage.locator('#hud-badge')).toHaveText('LIVE', { timeout: 10000 });
  await expect(livePage.locator('#hud-badge')).toHaveAttribute('data-mode', 'live');
  await expect(livePage.locator('#live-state')).toHaveText('ĐANG LIVE');
  const postConnectState = await fetch(`${base2}/api/state`).then(r => r.json());
  assert.equal(postConnectState.stats.demo_players, 0, 'Connected live session must auto-clear demo_* clutter');
  await expect(livePage.locator('#stage-headcount')).toHaveText('0 trên xe · 0 chờ');
  await expect(livePage.locator('#hud-badge')).toHaveText('NỐI LẠI LIVE', { timeout: 6000 });
  await expect(livePage.locator('#hud-badge')).toHaveAttribute('data-mode', 'reconnecting');
  await expect(livePage.locator('#hud-badge')).toHaveText('LIVE', { timeout: 6000 });
  await expect.poll(async () => {
    const st = await fetch(`${base2}/api/state`).then(r => r.json());
    const mienTay = st.station?.routes?.find(r => r.code === 'mien_tay');
    return mienTay?.bus?.seats?.[0]?.nickname ?? null;
  }, { timeout: 6000 }).toBe('Khách LIVE Thật');
  await livePage.close();
  server2.kill();
  server2 = undefined;

  const mobile = await context.newPage();
  await inspect(mobile, 'mobile');
  await mobile.setViewportSize({ width: 390, height: 844 });
  await mobile.goto(base);
  await expect(mobile.locator('#connection-status')).toContainText('sẵn sàng');
  assert(await mobile.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'Mobile layout overflows horizontally');
  await mobile.waitForTimeout(2500);
  await mobile.screenshot({ path: path.join(artifacts, 'mobile.png'), fullPage: true });

  // Verify ?overlay=1 with --autoplay-policy=no-user-gesture-required auto-enables audible Web Audio with zero clicks.
  autoplayBrowser = await chromium.launch({
    headless: true,
    executablePath: executables.find(existsSync),
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  const autoplayContext = await autoplayBrowser.newContext({ viewport: { width: 1080, height: 1920 } });
  const autoplayPage = await autoplayContext.newPage();
  await inspect(autoplayPage, 'overlay-autoplay');
  const audioResponses = new Map();
  autoplayPage.on('response', (response) => {
    const pathname = new URL(response.url()).pathname;
    if (pathname.startsWith('/audio/')) audioResponses.set(pathname, response.status());
  });
  await autoplayPage.addInitScript(() => {
    const NativeCtx = window.AudioContext || window.webkitAudioContext;
    if (!NativeCtx) return;
    const probe = { contexts: [], gains: [], analyser: null };
    window.__audioProbe = probe;
    const origConnect = AudioNode.prototype.connect;
    const origCreateGain = NativeCtx.prototype.createGain;
    NativeCtx.prototype.createGain = function (...args) {
      const gain = origCreateGain.apply(this, args);
      probe.gains.push(gain);
      return gain;
    };
    function PatchedAudioContext(...args) {
      const ctx = new NativeCtx(...args);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      origConnect.call(analyser, ctx.destination);
      ctx.__probeAnalyser = analyser;
      probe.contexts.push(ctx);
      probe.analyser = analyser;
      return ctx;
    }
    PatchedAudioContext.prototype = NativeCtx.prototype;
    AudioNode.prototype.connect = function (dest, ...rest) {
      const ctx = this.context;
      if (ctx && ctx.__probeAnalyser && this !== ctx.__probeAnalyser && dest === ctx.destination) {
        return origConnect.call(this, ctx.__probeAnalyser, ...rest);
      }
      return origConnect.call(this, dest, ...rest);
    };
    window.AudioContext = PatchedAudioContext;
    if (window.webkitAudioContext) window.webkitAudioContext = PatchedAudioContext;
  });
  await autoplayPage.goto(`${base}/?overlay=1`);
  await expect(autoplayPage.locator('#overlay-audio')).toHaveClass(/audio-on/, { timeout: 15000 });
  await expect.poll(() => audioResponses.get('/audio/audio-manifest.json'), { timeout: 10000 }).toBe(200);
  await expect.poll(() => audioResponses.get('/audio/office-loop.wav'), { timeout: 10000 }).toBe(200);
  await expect.poll(() => audioResponses.get('/audio/station-loop.wav'), { timeout: 10000 }).toBe(200);
  await expect.poll(() => audioResponses.get('/audio/horn.wav'), { timeout: 10000 }).toBe(200);
  await expect.poll(() => audioResponses.get('/audio/voice-station.mp3'), { timeout: 10000 }).toBe(200);
  for (const [assetPath, status] of audioResponses.entries()) {
    assert.equal(status, 200, `Expected HTTP 200 for ${assetPath}`);
  }
  await autoplayPage.waitForTimeout(700);
  const signal = await autoplayPage.evaluate(async () => {
    const probe = window.__audioProbe;
    if (!probe || !probe.contexts.length || !probe.analyser) return { ok: false, reason: 'missing audio probe' };
    const ctx = probe.contexts[0];
    const buf = new Float32Array(probe.analyser.fftSize);
    let maxPeak = 0;
    let maxRms = 0;
    for (let sample = 0; sample < 8; sample++) {
      probe.analyser.getFloatTimeDomainData(buf);
      let sq = 0;
      for (let i = 0; i < buf.length; i++) {
        const abs = Math.abs(buf[i]);
        if (abs > maxPeak) maxPeak = abs;
        sq += buf[i] * buf[i];
      }
      const rms = Math.sqrt(sq / buf.length);
      if (rms > maxRms) maxRms = rms;
      await new Promise(resolve => setTimeout(resolve, 60));
    }
    const gainValues = probe.gains.map(g => Number(g.gain.value.toFixed(3)));
    return { ok: true, state: ctx.state, maxPeak, maxRms, gainValues };
  });
  assert(signal.ok, `Overlay audio probe failed: ${signal.reason}`);
  assert.equal(signal.state, 'running', 'Overlay AudioContext must auto-start in running state');
  assert(signal.gainValues.some(v => v >= 0.5), `Expected non-zero music gain >= 0.5, got ${JSON.stringify(signal.gainValues)}`);
  assert(signal.maxPeak > 0.02 && signal.maxRms > 0.005, `Expected audible non-zero overlay output, got peak=${signal.maxPeak} rms=${signal.maxRms}`);
  await autoplayPage.close();

  // Verify suspended-context fallback (<audio> BGM) and 1500ms watchdog recovery without double-play.
  const watchdogPage = await autoplayContext.newPage();
  await inspect(watchdogPage, 'overlay-watchdog');
  await watchdogPage.addInitScript(() => {
    const NativeCtx = window.AudioContext || window.webkitAudioContext;
    const NativeAudio = window.Audio;
    window.__watchdogProbe = { resumeCalls: 0, allowWatchdogResume: false, contexts: [], audios: [] };
    window.Audio = function (...args) {
      const el = new NativeAudio(...args);
      window.__watchdogProbe.audios.push(el);
      return el;
    };
    window.Audio.prototype = NativeAudio.prototype;
    if (!NativeCtx) return;
    const origResume = NativeCtx.prototype.resume;
    const stateDesc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(NativeCtx.prototype), 'state')
      || Object.getOwnPropertyDescriptor(NativeCtx.prototype, 'state');
    NativeCtx.prototype.resume = function (...args) {
      window.__watchdogProbe.resumeCalls += 1;
      if (!window.__watchdogProbe.allowWatchdogResume || window.__watchdogProbe.resumeCalls === 1) {
        return Promise.resolve();
      }
      this.__fakeSuspended = false;
      return origResume.apply(this, args).then((result) => {
        this.dispatchEvent(new Event('statechange'));
        return result;
      });
    };
    function TrackedContext(...args) {
      const ctx = new NativeCtx(...args);
      ctx.__fakeSuspended = true;
      Object.defineProperty(ctx, 'state', {
        configurable: true,
        get() {
          return this.__fakeSuspended ? 'suspended' : (stateDesc?.get ? stateDesc.get.call(this) : 'running');
        },
      });
      window.__watchdogProbe.contexts.push(ctx);
      return ctx;
    }
    TrackedContext.prototype = NativeCtx.prototype;
    window.AudioContext = TrackedContext;
    if (window.webkitAudioContext) window.webkitAudioContext = TrackedContext;
  });
  await watchdogPage.goto(`${base}/?overlay=1`);
  await expect.poll(async () => watchdogPage.evaluate(() => ({
    state: window.__watchdogProbe.contexts[0]?.state ?? 'none',
    fallbackPlaying: window.__watchdogProbe.audios.some(a => !a.paused),
  })), { timeout: 6000 }).toEqual({ state: 'suspended', fallbackPlaying: true });
  await expect(watchdogPage.locator('#overlay-audio')).toHaveClass(/audio-on/, { timeout: 6000 });
  const preHandoverResumes = await watchdogPage.evaluate(() => {
    const calls = window.__watchdogProbe.resumeCalls;
    window.__watchdogProbe.allowWatchdogResume = true;
    return calls;
  });
  assert(preHandoverResumes >= 1, `Expected initial resume attempt before handover, got ${preHandoverResumes}`);
  await expect.poll(async () => watchdogPage.evaluate((baseline) => ({
    state: window.__watchdogProbe.contexts[0]?.state ?? 'none',
    anyFallbackPlaying: window.__watchdogProbe.audios.some(a => !a.paused),
    resumedByWatchdog: window.__watchdogProbe.resumeCalls > baseline,
  }), preHandoverResumes), { timeout: 8000 }).toEqual({ state: 'running', anyFallbackPlaying: false, resumedByWatchdog: true });
  await expect(watchdogPage.locator('#overlay-audio')).toHaveClass(/audio-on/);
  await watchdogPage.close();

  // Verify normal "/" under strict user-activation gating stays locked before gesture and unlocks on first click anywhere without opening #tab-audio.
  const strictContext = await browser.newContext({ viewport: { width: 1440, height: 1080 } });
  try {
    const strictPage = await strictContext.newPage();
    await inspect(strictPage, 'desktop-first-click');
    await strictPage.addInitScript(() => {
      const NativeCtx = window.AudioContext || window.webkitAudioContext;
      window.__strictProbe = { contexts: [], blockedResumeCalls: 0, userGestureSeen: false };
      const markGesture = (event) => {
        if (event.isTrusted) window.__strictProbe.userGestureSeen = true;
      };
      for (const evt of ['pointerdown', 'mousedown', 'touchstart', 'keydown', 'click']) {
        window.addEventListener(evt, markGesture, { capture: true, passive: true });
      }
      if (NativeCtx) {
        const origResume = NativeCtx.prototype.resume;
        const stateDesc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(NativeCtx.prototype), 'state')
          || Object.getOwnPropertyDescriptor(NativeCtx.prototype, 'state');
        NativeCtx.prototype.resume = function (...args) {
          if (!window.__strictProbe.userGestureSeen) {
            window.__strictProbe.blockedResumeCalls += 1;
            return Promise.resolve();
          }
          this.__fakeSuspended = false;
          return origResume.apply(this, args).then((result) => {
            this.dispatchEvent(new Event('statechange'));
            return result;
          });
        };
        function StrictContext(...args) {
          const ctx = new NativeCtx(...args);
          ctx.__fakeSuspended = true;
          Object.defineProperty(ctx, 'state', {
            configurable: true,
            get() {
              return this.__fakeSuspended ? 'suspended' : (stateDesc?.get ? stateDesc.get.call(this) : 'running');
            },
          });
          window.__strictProbe.contexts.push(ctx);
          return ctx;
        }
        StrictContext.prototype = NativeCtx.prototype;
        window.AudioContext = StrictContext;
        if (window.webkitAudioContext) window.webkitAudioContext = StrictContext;
      }
      const origPlay = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function (...args) {
        if (!window.__strictProbe.userGestureSeen) {
          return Promise.reject(new DOMException('play() failed because the user did not interact with the document first.', 'NotAllowedError'));
        }
        return origPlay.apply(this, args);
      };
    });
    await strictPage.goto(base);
    await expect(strictPage.locator('#connection-status')).toContainText('sẵn sàng');
    await strictPage.waitForTimeout(500);
    await expect(strictPage.locator('#enable-audio')).toContainText('Bật âm thanh');
    const beforeClick = await strictPage.evaluate(() => ({
      state: window.__strictProbe.contexts[0]?.state ?? 'none',
      blockedResumeCalls: window.__strictProbe.blockedResumeCalls,
      audioPanelHidden: document.querySelector('#panel-audio')?.hidden,
    }));
    assert.equal(beforeClick.state, 'suspended', 'AudioContext must remain suspended before first user interaction');
    assert(beforeClick.blockedResumeCalls >= 1, 'Startup autoplay must have attempted resume()');
    assert.equal(beforeClick.audioPanelHidden, true, '#panel-audio must still be closed');

    // Click a regular control (#game-canvas) without opening #tab-audio.
    await strictPage.locator('#game-canvas').click();
    await expect(strictPage.locator('#enable-audio')).toContainText('Tắt âm thanh', { timeout: 15000 });
    await expect(strictPage.locator('#audio-status')).toContainText('Âm thanh sẵn sàng');
    const afterClickState = await strictPage.evaluate(() => window.__strictProbe.contexts[0]?.state ?? 'none');
    assert.equal(afterClickState, 'running', 'First click anywhere must unlock AudioContext to running');
    await strictPage.close();
  } finally {
    await strictContext.close();
  }

  assert.deepEqual(failures, [], 'Browser errors or failed requests');
  console.log('PASS: join, comment "2", KPI/cooldown, coffee, hearts/energy, follow once, gift alert, pause/resume, boss, connector validation, help, audio (first-click unlock, overlay autoplay signal, watchdog fallback handover), saved volume/profile, TikTok frame, 50-person demo, simulation, three months/bonus, rehearsal LIVE room, WebSocket overlay, 1080x1920 buffer, non-overlapping station HUD, "1"/"ra xe"/"lên ghế ngồi"/provinces boarding, clear_demo, CHỜ LIVE -> LIVE -> NỐI LẠI LIVE transitions, desktop/mobile, and zero browser errors.');
  console.log(`Screenshots: ${artifacts}`);
} finally {
  await autoplayBrowser?.close();
  await browser?.close();
  server2?.kill();
  server.kill();
}
