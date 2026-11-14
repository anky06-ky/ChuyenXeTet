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
import {
  TikTokLiveClient,
  EventType,
  checkOnline,
  TtwidMissingError,
  UserNotFoundError,
  HostNotOnlineError,
  TikTokBlockedError,
  TikTokApiError,
  AgeRestrictedError,
  DeviceBlockedError,
  ProfileNotFoundError,
  randomUa,
} from 'piratetok-live-js';
import { connectWss } from '../node_modules/piratetok-live-js/dist/connection/wss.js';
import { buildWssUrl } from '../node_modules/piratetok-live-js/dist/connection/url.js';
import { abortableSleep } from '../node_modules/piratetok-live-js/dist/connection/supervisor.js';
import { parseCheckOnline, fetchRoomInfoJson } from '../node_modules/piratetok-live-js/dist/http/api.js';

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

class SlardarWafError extends Error {
  constructor(statusCode = 200, source = 'tiktok.com') {
    super(`SlardarWAF challenge returned (HTTP ${statusCode}) from ${source}`);
    this.name = 'SlardarWafError';
    this.statusCode = statusCode;
  }
}

const ACCEPT_LANGUAGE = 'vi-VN,vi;q=0.9,en;q=0.8';
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36';
const TTWID_ENDPOINTS = [
  'https://www.tiktok.com/',
  'https://www.tiktok.com/live',
  'https://www.tiktok.com/explore',
];

const ERRORS = {
  HostNotOnlineError: ['NOT_LIVE', 'Kênh này chưa bật LIVE. Đang chờ bạn bấm Go LIVE…'],
  UserNotFoundError: ['NOT_FOUND', 'Không tìm thấy tài khoản TikTok này. Kiểm tra lại @tên kênh.'],
  ProfileNotFoundError: ['NOT_FOUND', 'Không tìm thấy tài khoản TikTok này. Kiểm tra lại @tên kênh.'],
  AgeRestrictedError: ['AGE_RESTRICTED', 'Phòng LIVE giới hạn độ tuổi nên không đọc được sự kiện công khai.'],
  DeviceBlockedError: ['BLOCKED', 'TikTok tạm chặn phiên kết nối thiết bị (DEVICE_BLOCKED). Đang đổi phiên và thử lại…'],
  TikTokBlockedError: ['BLOCKED', 'TikTok tạm giới hạn truy cập (HTTP 403/429). Đang giãn nhịp và thử lại…'],
  SlardarWafError: ['BLOCKED', 'TikTok bật thử thách SlardarWAF. Đang giãn nhịp và thử lại…'],
  TtwidMissingError: ['BLOCKED', 'TikTok chưa cấp phiên truy cập (ttwid). Đang thử lại…'],
};

function errorDetail(error) {
  const msg = String(error?.message || error || '');
  const cause = error?.cause ? (error.cause.message || error.cause.code || String(error.cause)) : '';
  return text(cause && !msg.includes(cause) ? `${msg}: ${cause}` : msg, 240);
}

function describe(error) {
  const name = error?.constructor?.name || error?.name || '';
  const detail = errorDetail(error);
  if (ERRORS[name]) {
    const [code, message] = ERRORS[name];
    return { code, error: message, detail };
  }
  if (/DEVICE_BLOCKED/i.test(detail)) {
    return { code: 'BLOCKED', error: ERRORS.DeviceBlockedError[1], detail };
  }
  if (/SlardarWAF|_wafchallengeid/i.test(detail)) {
    return { code: 'BLOCKED', error: ERRORS.SlardarWafError[1], detail };
  }
  if (/\bHTTP\s*(403|429)\b/i.test(detail)) {
    return { code: 'BLOCKED', error: ERRORS.TikTokBlockedError[1], detail };
  }
  if (name === 'AbortError' || name === 'TimeoutError' || /timeout|timed out|ETIMEDOUT|aborted/i.test(detail)) {
    return { code: 'TIMEOUT', error: 'Kết nối TikTok LIVE bị quá thời gian. Đang thử lại…', detail };
  }
  return { code: 'CONNECT_FAILED', error: 'Chưa kết nối được TikTok LIVE. Đang thử lại…', detail };
}

function extractTtwidCookie(headers) {
  for (const cookie of headers.getSetCookie?.() ?? []) {
    const match = cookie.match(/^ttwid=([^;]+)/);
    if (match?.[1]) return match[1];
  }
  const fallback = (headers.get('set-cookie') ?? '').match(/ttwid=([^;]+)/);
  return fallback?.[1] || '';
}

async function fetchWithTimeout(url, options, timeoutMs, outerSignal) {
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort(outerSignal?.reason);
  if (outerSignal?.aborted) controller.abort(outerSignal.reason);
  else outerSignal?.addEventListener('abort', onOuterAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener('abort', onOuterAbort);
  }
}

async function acquireTTWID(timeoutMs, preferredUa, signal, maxAttempts = 10) {
  let sawSlardar = false;
  let lastErr = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    const ua = attempt === 0 && preferredUa ? preferredUa : randomUa();
    const endpoint = TTWID_ENDPOINTS[attempt % TTWID_ENDPOINTS.length];
    try {
      const resp = await fetchWithTimeout(endpoint, {
        headers: {
          'User-Agent': ua,
          'Accept-Language': ACCEPT_LANGUAGE,
        },
        redirect: 'manual',
      }, timeoutMs, signal);
      const ttwid = extractTtwidCookie(resp.headers);
      const body = await resp.text();
      if (ttwid) return { ttwid, userAgent: ua };
      if (body.includes('SlardarWAF') || body.includes('_wafchallengeid')) {
        sawSlardar = true;
        lastErr = new SlardarWafError(resp.status, endpoint);
      } else if (resp.status === 403 || resp.status === 429) {
        lastErr = new TikTokBlockedError(resp.status);
      } else {
        lastErr = new TtwidMissingError(resp.status);
      }
    } catch (err) {
      if (signal?.aborted) throw err;
      lastErr = err;
    }
    if (attempt + 1 < maxAttempts) {
      await abortableSleep(450 + Math.floor(Math.random() * 450), signal);
    }
  }
  if (sawSlardar) throw new SlardarWafError(200, 'ttwid');
  throw lastErr ?? new TtwidMissingError(0);
}

function extractScriptJson(html, id) {
  const marker = `id="${id}"`;
  const pos = html.indexOf(marker);
  if (pos === -1) return null;
  const gt = html.indexOf('>', pos);
  if (gt === -1) return null;
  const end = html.indexOf('</script>', gt + 1);
  if (end === -1) return null;
  try {
    return JSON.parse(html.slice(gt + 1, end));
  } catch {
    return null;
  }
}

async function resolveRoomFromLivePage(clean, session, timeoutMs, signal) {
  const ua = session?.userAgent || CHROME_UA;
  const headers = {
    'User-Agent': ua,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': ACCEPT_LANGUAGE,
    Referer: 'https://www.tiktok.com/',
    'Upgrade-Insecure-Requests': '1',
  };
  if (session?.ttwid) headers.Cookie = `ttwid=${session.ttwid}`;

  const resp = await fetchWithTimeout(`https://www.tiktok.com/@${clean}/live`, { headers, redirect: 'follow' }, timeoutMs, signal);
  const pageTtwid = extractTtwidCookie(resp.headers);
  const nextSession = pageTtwid ? { ttwid: pageTtwid, userAgent: ua } : session;
  const html = await resp.text();
  if (html.includes('SlardarWAF') || html.includes('_wafchallengeid')) {
    throw new SlardarWafError(resp.status, `/@${clean}/live`);
  }
  if (resp.status === 403 || resp.status === 429) {
    throw new TikTokBlockedError(resp.status);
  }

  const sigi = extractScriptJson(html, 'SIGI_STATE');
  const liveUser = sigi?.LiveRoom?.liveRoomUserInfo;
  if (liveUser) {
    const roomId = nonZero(liveUser?.user?.roomId ?? liveUser?.liveRoom?.roomId, 40);
    const liveStatus = Number(liveUser?.liveRoom?.status ?? liveUser?.user?.status ?? 0);
    if (!roomId || liveStatus !== 2) throw new HostNotOnlineError(clean);
    return { roomId, anchorId: text(liveUser?.user?.id ?? '', 40), session: nextSession };
  }

  const uni = extractScriptJson(html, '__UNIVERSAL_DATA_FOR_REHYDRATION__');
  const scope = uni?.['__DEFAULT_SCOPE__'];
  if (scope) {
    const userDetail = scope['webapp.user-detail'];
    const liveDetail = scope['webapp.live-detail'];
    if (!userDetail && !liveDetail) {
      throw new TikTokBlockedError(resp.status || 403);
    }
    const detailCode = Number(userDetail?.statusCode ?? 0);
    if (detailCode === 10221 || detailCode === 10223) throw new UserNotFoundError(clean);
    const room = liveDetail?.roomInfo?.room;
    const roomId = nonZero(room?.id ?? liveDetail?.liveRoom?.roomId ?? userDetail?.userInfo?.user?.roomId, 40);
    if (!roomId) throw new HostNotOnlineError(clean);
    const explicitStatus = Number(room?.status ?? liveDetail?.liveRoom?.status ?? userDetail?.userInfo?.user?.status ?? 0);
    if (explicitStatus === 2) {
      return { roomId, anchorId: text(userDetail?.userInfo?.user?.id ?? '', 40), session: nextSession };
    }
    if (explicitStatus === 4) throw new HostNotOnlineError(clean);
    const info = await fetchRoomInfoJson(roomId, timeoutMs);
    if (Number(info?.data?.status ?? 0) === 2) {
      return { roomId, anchorId: text(userDetail?.userInfo?.user?.id ?? '', 40), session: nextSession };
    }
    throw new HostNotOnlineError(clean);
  }

  throw new TikTokBlockedError(resp.status || 403);
}

async function resolveRoom(clean, timeoutMs, signal) {
  try {
    const res = await checkOnline(clean, timeoutMs, 'vi', 'VN');
    return { ...res, session: null };
  } catch (err) {
    if (err instanceof HostNotOnlineError || err instanceof UserNotFoundError || signal?.aborted) {
      throw err;
    }
    if (!closing) emit({ t: 'warning', ...describe(err) });
  }

  let session = null;
  try {
    session = await acquireTTWID(timeoutMs, CHROME_UA, signal, 6);
  } catch (err) {
    if (signal?.aborted) throw err;
  }

  if (session) {
    try {
      const params = new URLSearchParams({
        aid: '1988',
        app_name: 'tiktok_web',
        device_platform: 'web_pc',
        app_language: 'vi',
        browser_language: 'vi-VN',
        region: 'VN',
        user_is_login: 'false',
        sourceType: '54',
        staleTime: '600000',
        uniqueId: clean,
      });
      const resp = await fetchWithTimeout(`https://www.tiktok.com/api-live/user/room?${params}`, {
        headers: {
          'User-Agent': session.userAgent,
          Accept: 'application/json, text/plain, */*',
          'Accept-Language': ACCEPT_LANGUAGE,
          Referer: `https://www.tiktok.com/@${clean}/live`,
          Origin: 'https://www.tiktok.com',
          Cookie: `ttwid=${session.ttwid}`,
        },
      }, timeoutMs, signal);
      const parsed = parseCheckOnline(await resp.text(), resp.status, clean);
      return { ...parsed, session };
    } catch (err) {
      if (err instanceof HostNotOnlineError || err instanceof UserNotFoundError || signal?.aborted) {
        throw err;
      }
      if (!closing) emit({ t: 'warning', ...describe(err) });
    }
  }

  return await resolveRoomFromLivePage(clean, session, timeoutMs, signal);
}

let client = null;
let closing = false;
const shutdownController = new AbortController();

function shutdown(code = 0) {
  if (closing) return;
  closing = true;
  shutdownController.abort();
  try { client?.disconnect(); } catch { /* Already closed. */ }
  // Give stdout a moment to flush the final status line.
  setTimeout(() => process.exit(code), 150);
}

readline.createInterface({ input: process.stdin }).on('line', (line) => { if (line.trim() === 'quit') shutdown(0); }).on('close', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));
process.on('uncaughtException', (error) => { status('error', { uniqueId, ...describe(error) }); shutdown(1); });
process.on('unhandledRejection', (error) => { status('error', { uniqueId, ...describe(error) }); shutdown(1); });

status('connecting', { uniqueId });

let lastSessionError = null;
let sawDeviceBlocked = false;

try {
  client = new TikTokLiveClient(uniqueId).maxRetries(6).language('vi').region('VN');

  let room = '';
  let everConnected = false;
  let retrying = false;

  const markConnected = () => {
    if (closing) return;
    if (!everConnected || retrying) {
      everConnected = true;
      retrying = false;
      status('connected', { uniqueId, roomId: room });
    }
  };
  const flowing = () => { if (retrying) markConnected(); };

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
  client.on(EventType.liveEnded, () => { status('ended', { uniqueId, roomId: room }); shutdown(0); });
  client.on(EventType.reconnecting, () => {
    if (closing || !everConnected) return;
    retrying = true;
    status('reconnecting', { uniqueId, roomId: room, detail: lastSessionError ? errorDetail(lastSessionError) : '' });
  });
  client.on(EventType.disconnected, () => {
    // Before everConnected is true, runSessions rejects immediately after emitting disconnected;
    // let the catch block emit the underlying error instead of masking it via shutdown(0).
    if (!closing && everConnected) {
      status('disconnected', { uniqueId, roomId: room, detail: lastSessionError ? errorDetail(lastSessionError) : '' });
      shutdown(0);
    }
  });
  client.on('error', (error) => { if (!closing) emit({ t: 'warning', ...describe(error) }); });

  const resolved = await resolveRoom(uniqueId, client.timeoutMs, shutdownController.signal);
  if (closing) shutdown(0);
  room = text(resolved.roomId, 40);
  let initialSession = resolved.session;

  await client.runSessions(room, (signal) => {
    const onAbort = () => client?.disconnect();
    if (shutdownController.signal.aborted) onAbort();
    else shutdownController.signal.addEventListener('abort', onAbort, { once: true });
    return {
      newSession: async () => {
        if (initialSession) {
          const reused = initialSession;
          initialSession = null;
          return reused;
        }
        return await acquireTTWID(client.timeoutMs, undefined, signal);
      },
      runSession: async (session, onOpen) => {
        try {
          return await connectWss(
            buildWssUrl(client.cdnHost, room, 'vi', 'VN', client._compress, client._heartbeatMs),
            session.ttwid,
            room,
            {
              onEvent: (evt) => client.emit(evt.type, evt.data),
              onError: (err) => client.emitError(err),
              onOpen: () => {
                onOpen();
                markConnected();
              },
              staleTimeoutMs: client._staleTimeoutMs,
            },
            signal,
            {
              userAgent: session.userAgent,
              cookies: client._cookies,
              acceptLanguage: ACCEPT_LANGUAGE,
              proxy: client._proxy,
              heartbeatMs: client._heartbeatMs,
            },
          );
        } catch (err) {
          lastSessionError = err;
          if (err instanceof DeviceBlockedError || /DEVICE_BLOCKED/i.test(err?.message || '')) {
            sawDeviceBlocked = true;
            // piratetok-live-js supervisor catches DeviceBlockedError without calling hooks.onError;
            // emit it explicitly so backend diagnostics see the real block reason.
            client.emitError(err instanceof DeviceBlockedError ? err : new DeviceBlockedError());
          }
          throw err;
        }
      },
      sleep: abortableSleep,
      now: () => Date.now(),
    };
  });
} catch (error) {
  const effective = (error?.message === 'disconnected before the WSS handshake completed' && (lastSessionError || sawDeviceBlocked))
    ? (lastSessionError ?? new DeviceBlockedError())
    : error;
  if (!closing) status('error', { uniqueId, ...describe(effective) });
  shutdown(1);
}
