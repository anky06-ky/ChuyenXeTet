// TikTok LIVE connector for TetLive Studio.
//
// Runs as a child process of the FastAPI backend. It only READS the public
// events of a live room (no account, cookie or password) and prints one
// normalized JSON object per line on stdout. The game rules never see the
// TikTok library: they receive these normalized events only.
//
// Connection approach follows khanhdevngu/xemtuvionline-bear (MIT, BEAR DEV):
// piratetok-live-js signs the WebSocket locally, so no signing server or API key.
//
//   node connector/tiktok-connector.mjs <uniqueId>
//
// stdin: the line "quit" (or stdin closing) disconnects and exits.

import process from 'node:process';
import readline from 'node:readline';

const emit = (message) => { process.stdout.write(JSON.stringify(message) + '\n'); };
const status = (state, extra = {}) => emit({ t: 'status', status: state, ...extra });

const uniqueId = String(process.argv[2] || '').trim().replace(/^.*tiktok\.com\/@?/i, '').replace(/^@/, '').replace(/[/?#].*$/, '');
if (!/^[A-Za-z0-9_.]{2,30}$/.test(uniqueId)) {
  status('error', { code: 'BAD_USERNAME', error: 'Tên tài khoản TikTok chưa đúng. Nhập dạng @tenkenh.' });
  process.exit(2);
}

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 19)) {
  status('error', { code: 'OLD_NODE', error: `Node.js ${process.versions.node} quá cũ. Kết nối TikTok LIVE cần Node.js 22.19 trở lên.` });
  process.exit(3);
}

const text = (value, limit) => String(value ?? '').replace(/[\u0000-\u001f\u007f\u200b\u200e\u200f\u2060\ufeff]/g, ' ').trim().slice(0, limit);
const nonZero = (value, limit = 40) => {
  const s = text(value, limit);
  return s && s !== '0' && s !== '-1' ? s : '';
};
const userId = (user, fallbackId = '') => nonZero(user?.id, 32) || nonZero(user?.idStr, 32) || nonZero(fallbackId, 32);
const avatarOf = (user) => user?.avatarThumb?.urlList?.[0] || user?.avatarMedium?.urlList?.[0] || user?.avatarLarge?.urlList?.[0] || '';
const person = (user, fallbackId = '') => ({
  id: userId(user, fallbackId),
  uniqueId: text(user?.uniqueId, 40),
  secUid: text(user?.secUid, 96),
  nickname: text(user?.nickname, 40) || text(user?.uniqueId, 40) || 'Đồng nghiệp',
  avatar: text(avatarOf(user), 2048),
  follower: Number(user?.followInfo?.followStatus ?? 0) >= 1,
});
const messageId = (data) => nonZero(data?.common?.msgId ?? data?.msgId ?? '', 40);
const known = (user, fallbackId = '') => Boolean(userId(user, fallbackId) || text(user?.uniqueId, 40) || text(user?.secUid, 96));
const memberUser = (data) => {
  const user = data?.user && typeof data.user === 'object' ? data.user : null;
  const id = userId(user, data?.userId);
  if (!user && !id) return null;
  return { ...(user || {}), id };
};

const ERRORS = {
  HostNotOnlineError: ['NOT_LIVE', 'Kênh này chưa bật LIVE. Đang chờ bạn bấm Go LIVE (tự thử lại mỗi 3 giây)…'],
  UserNotFoundError: ['NOT_FOUND', 'Không tìm thấy tài khoản TikTok này. Kiểm tra lại @tên kênh.'],
  AgeRestrictedError: ['AGE_RESTRICTED', 'Phòng LIVE giới hạn độ tuổi nên không đọc được sự kiện công khai.'],
  DeviceBlockedError: ['BLOCKED', 'TikTok tạm chặn kết nối từ máy này. Đợi vài phút rồi thử lại.'],
  TikTokBlockedError: ['BLOCKED', 'TikTok tạm chặn kết nối từ mạng này. Đợi vài phút rồi thử lại.'],
  TtwidMissingError: ['BLOCKED', 'TikTok chưa cấp phiên truy cập. Kiểm tra mạng rồi thử lại.'],
};
function describe(error) {
  const name = error?.constructor?.name || error?.name || '';
  const [code, message] = ERRORS[name] || ['CONNECT_FAILED', 'Chưa kết nối được TikTok LIVE. Kiểm tra mạng rồi thử lại.'];
  return { code, error: message, detail: text(error?.message || error, 200) };
}

let client = null;
let closing = false;
function shutdown(code = 0) {
  if (closing) return;
  closing = true;
  try { client?.disconnect(); } catch { /* Already closed. */ }
  // Give stdout a moment to flush the final status line.
  setTimeout(() => process.exit(code), 150);
}

readline.createInterface({ input: process.stdin }).on('line', (line) => { if (line.trim() === 'quit') shutdown(0); }).on('close', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));
process.on('uncaughtException', (error) => { status('error', describe(error)); shutdown(1); });
process.on('unhandledRejection', (error) => { status('error', describe(error)); shutdown(1); });

status('connecting', { uniqueId });

try {
  const { TikTokLiveClient, EventType } = await import('piratetok-live-js');
  client = new TikTokLiveClient(uniqueId).maxRetries(8);

  // The library announces retries but not their success, so the first event
  // that arrives after a retry proves the stream is flowing again.
  let room = '';
  let retrying = false;
  const flowing = () => { if (retrying && !closing) { retrying = false; status('connected', { uniqueId, roomId: room }); } };

  client.on(EventType.chat, (data) => {
    flowing();
    const user = data?.user && typeof data.user === 'object' ? data.user : null;
    if (!known(user, data?.userId)) return;
    const content = text(data?.content ?? data?.comment ?? '', 160);
    if (content) emit({ t: 'chat', id: messageId(data), user: person(user, data?.userId), text: content });
  });
  client.on(EventType.gift, (data) => {
    flowing();
    // Combo gifts send running totals; only the final event of a streak counts.
    if (!known(data?.user) || !data.isStreakOver) return;
    const each = Math.max(0, Number(data.gift?.diamondCount) || 0);
    const count = Math.max(1, Number(data.repeatCount) || 1);
    emit({
      t: 'gift', id: messageId(data), user: person(data.user),
      gift: { id: text(data.giftId ?? data.gift?.id, 20), name: text(data.gift?.name || 'Quà', 40), each, count, diamonds: each * count, icon: text(data.gift?.icon?.urlList?.[0] || data.gift?.image?.urlList?.[0] || '', 2048) },
    });
  });
  client.on(EventType.like, (data) => {
    flowing();
    if (!known(data?.user)) return;
    emit({ t: 'like', id: messageId(data), user: person(data.user), count: Math.max(1, Math.min(500, Number(data.count) || 1)), total: Number(data.total) || 0 });
  });
  client.on(EventType.follow, (data) => { flowing(); if (known(data?.user)) emit({ t: 'follow', id: messageId(data), user: person(data.user) }); });
  client.on(EventType.share, (data) => { flowing(); if (known(data?.user)) emit({ t: 'share', id: messageId(data), user: person(data.user) }); });
  client.on(EventType.member, (data) => {
    flowing();
    const action = Number(data?.action ?? 1);
    if (action !== 0 && action !== 1) return;
    const user = memberUser(data);
    if (known(user)) emit({ t: 'join', id: messageId(data), user: person(user), members: Number(data.memberCount) || 0 });
  });
  client.on(EventType.roomUserSeq, (data) => { flowing(); emit({ t: 'viewers', count: Math.max(0, Number(data.viewerCount ?? data.totalUser) || 0) }); });
  client.on(EventType.liveEnded, () => { status('ended', { uniqueId }); shutdown(0); });
  client.on(EventType.reconnecting, () => { if (!closing) { retrying = true; status('reconnecting', { uniqueId }); } });
  client.on(EventType.disconnected, () => { if (!closing) { status('disconnected', { uniqueId }); shutdown(0); } });
  client.on('error', (error) => { if (!closing) emit({ t: 'warning', ...describe(error) }); });

  room = text(await client.connect(), 40);
  if (!closing) status('connected', { uniqueId, roomId: room });
} catch (error) {
  if (!closing) status('error', { uniqueId, ...describe(error) });
  shutdown(1);
}
