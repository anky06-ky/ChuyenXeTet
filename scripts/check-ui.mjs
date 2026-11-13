import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = await mkdtemp(path.join(tmpdir(), 'tetlive-qa-'));
const artifacts = path.join(root, 'artifacts');
await mkdir(artifacts, { recursive: true });
const probe = createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const base = `http://127.0.0.1:${port}`;
const python = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const server = spawn(python, ['-m', 'uvicorn', 'backend.app:app', '--host', '127.0.0.1', '--port', String(port)], {
  cwd: root,
  env: { ...process.env, TETLIVE_DB: path.join(scratch, 'qa.sqlite') },
  windowsHide: true,
  stdio: ['ignore', 'ignore', 'pipe'],
});
let serverLog = '';
server.stderr.on('data', chunk => { serverLog = (serverLog + chunk.toString()).slice(-4000); });
let browser;
const failures = [];
const inspect = async (page, name) => {
  page.on('pageerror', error => failures.push(`${name}: ${error.message}`));
  page.on('console', msg => { if (msg.type() === 'error') failures.push(`${name} console.error: ${msg.text()}`); });
  page.on('response', response => { if (response.status() >= 400) failures.push(`${name}: ${response.status()} ${response.url()}`); });
};
const readState = () => fetch(`${base}/api/state`).then(response => response.json());

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
  await expect(page.locator('#hud-badge')).toHaveText('DEMO');
  await expect(page.locator('#month-button')).toBeHidden();
  assert.equal(await page.locator('.journey-item').count(), 2);
  await expect(page.locator('#game-canvas canvas')).toBeVisible();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(artifacts, 'open-office-empty.png'), fullPage: true });

  // Comments from the rehearsal box follow the same rules as TikTok chat.
  await page.locator('#nickname').fill('Kiểm thử Tết');
  await page.locator('[data-command="vào làm"]').click();
  await expect(page.locator('#command-feedback')).toContainText('đã vào công ty');
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
  await page.locator('#enable-audio').click();
  await expect(page.locator('#enable-audio')).toContainText('Tắt âm thanh', { timeout: 15000 });
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
      const doc = document.documentElement;
      return {
        stage: { x: stage.x, y: stage.y, width: stage.width, height: stage.height },
        hud: { width: hud.width, height: hud.height },
        scrollW: doc.scrollWidth,
        clientW: doc.clientWidth,
        scrollH: doc.scrollHeight,
        clientH: doc.clientHeight,
        innerW: window.innerWidth,
        innerH: window.innerHeight,
      };
    });
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
  await expect(overlay.locator('#hud-badge')).toHaveText('GIẢ LẬP');
  await expect.poll(async () => (await (await fetch(`${base}/api/live/status`)).json()).counters.chat, { timeout: 10000 }).toBeGreaterThan(2);
  await expect.poll(async () => (await readState()).stats.demo_players, { timeout: 10000 }).toBeGreaterThan(50);
  await overlay.waitForTimeout(3000);
  await overlay.screenshot({ path: path.join(artifacts, 'overlay.png') });
  await page.locator('#live-connect').click();
  await expect(page.locator('#live-state')).toHaveText('CHƯA KẾT NỐI');
  await expect(overlay.locator('#hud-badge')).toHaveText('DEMO');

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

  // Capture Miền Tây with seated passengers, hometown pills, and waiting chibi in the queue.
  await page.waitForTimeout(1600);
  await page.screenshot({ path: path.join(artifacts, 'station.png'), fullPage: true });
  await overlay.screenshot({ path: path.join(artifacts, 'station-overlay.png') });

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
  await page.locator('#scene-office').click();
  await expect(page.locator('#board-title')).toHaveText('CÔNG TY CUỐI NĂM');
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'Desktop layout overflows horizontally');

  const mobile = await context.newPage();
  await inspect(mobile, 'mobile');
  await mobile.setViewportSize({ width: 390, height: 844 });
  await mobile.goto(base);
  await expect(mobile.locator('#connection-status')).toContainText('sẵn sàng');
  assert(await mobile.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'Mobile layout overflows horizontally');
  await mobile.waitForTimeout(2500);
  await mobile.screenshot({ path: path.join(artifacts, 'mobile.png'), fullPage: true });
  assert.deepEqual(failures, [], 'Browser errors or failed requests');
  console.log('PASS: join, comment "2", KPI/cooldown, coffee, hearts/energy, follow once, gift alert, pause/resume, boss, connector validation, help, audio, saved volume/profile, TikTok frame, 50-person demo, simulation, three months/bonus, rehearsal LIVE room, WebSocket overlay, desktop/mobile, and zero browser errors.');
  console.log(`Screenshots: ${artifacts}`);
} finally {
  await browser?.close();
  server.kill();
}
