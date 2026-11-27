import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

export function roomVideo(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    if (url.hostname === 'www.bilibili.com' && /^\/video\/(?:BV[\da-zA-Z]{10}|av\d+)\/?$/.test(url.pathname)) {
      const part = url.searchParams.get('p');
      return { platform: 'bilibili', url: url.origin + url.pathname + (/^[1-9]\d{0,3}$/.test(part) ? `?p=${part}` : '') };
    }
    if (url.hostname === 'www.douyin.com' && /^\/video\/\d+\/?$/.test(url.pathname)) {
      return { platform: 'douyin', url: url.origin + url.pathname };
    }
  } catch {
    return null;
  }
  return null;
}

export function roomStartLink(value) {
  if (roomVideo(value)) return true;
  try {
    const url = new URL(value);
    return ['b23.tv', 'v.douyin.com'].includes(url.hostname) && url.origin === `https://${url.hostname}` &&
      !url.username && !url.password && /^\/[\da-zA-Z]+\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

const LOOPBACK = '127.0.0.1';
const JPEG_LIMIT = 512 * 1024;

export async function openWatchRoom() {
  const key = randomBytes(9).toString('base64url');
  let state = null;
  let update = null;
  let mark = null;
  let sequence = 0;
  let viewer = '';
  let lastSeen = 0;
  const server = createServer({ requestTimeout: 4000, headersTimeout: 4000, keepAliveTimeout: 1000 }, (request, response) => {
    const expectedHost = `${LOOPBACK}:${server.address()?.port}`;
    const supplied = Buffer.from(String(request.headers.authorization ?? ''));
    const secret = Buffer.from(`Bearer ${key}`);
    if (request.method !== 'GET' || request.headers.host !== expectedHost || request.headers.origin ||
        !/^\/state\?after=\d{1,12}$/.test(request.url) || supplied.length !== secret.length || !timingSafeEqual(supplied, secret)) {
      response.writeHead(404).end();
      return;
    }
    const id = String(request.headers['x-watch-viewer'] ?? '');
    if (!/^[a-f0-9]{24}$/.test(id)) { response.writeHead(400).end(); return; }
    if (viewer && viewer !== id && Date.now() - lastSeen < 8000) { response.writeHead(409).end(); return; }
    viewer = id;
    lastSeen = Date.now();
    const after = Number(request.url.slice('/state?after='.length));
    const body = Buffer.from(JSON.stringify({ state, update: update?.seq > after ? update : null, mark: mark?.seq > after ? mark : null }));
    response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
    response.end(body);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, LOOPBACK, resolve);
  });
  server.unref();
  return {
    role: 'host',
    code: `${server.address().port.toString(36)}-${key}`,
    state(next) {
      if (!next || next.url !== state?.url) { update = null; mark = null; }
      state = next;
    },
    publish(text, digest, bytes = null, marked = false) {
      if (!state || state.url !== digest.url) return;
      const event = { seq: ++sequence, text, digest };
      if (marked) {
        if (bytes?.length && bytes.length <= JPEG_LIMIT) event.frame = bytes.toString('base64');
        mark = event;
      } else update = event;
    },
    close() {
      server.close();
      server.closeAllConnections();
    },
  };
}

export function watchGuest(value, viewer = randomBytes(12).toString('hex')) {
  const match = /^([a-z\d]{1,4})-([\w-]{12})$/.exec(String(value).trim());
  const port = match ? Number.parseInt(match[1], 36) : 0;
  if (port < 1024 || port > 65535) return null;
  return { role: 'guest', port, key: match[2], viewer, after: 0 };
}

export async function readWatchRoom(guest) {
  const response = await fetch(`http://${LOOPBACK}:${guest.port}/state?after=${guest.after}`, {
    headers: { Authorization: `Bearer ${guest.key}`, 'X-Watch-Viewer': guest.viewer },
    signal: AbortSignal.timeout(1500),
    redirect: 'error',
  });
  if (response.status === 409) throw new Error('已有另一条鱼加入，请先退出或等几秒再试。');
  if (!response.ok) throw new Error('短码无效，或陪看房间已结束。');
  const size = Number(response.headers.get('content-length'));
  if (!size || size > 800 * 1024 || response.headers.has('content-encoding')) throw new Error('无效的陪看内容。');
  const packet = await response.json();
  if (packet.state && !roomVideo(packet.state.url)) throw new Error('无效的播放状态。');
  for (const event of [packet.update, packet.mark]) {
    if (event && (!Number.isSafeInteger(event.seq) || event.seq <= guest.after || event.digest?.url !== packet.state?.url ||
        typeof event.text !== 'string' || event.text.length > 6000 || (event.frame != null &&
          (typeof event.frame !== 'string' || event.frame.length > Math.ceil(JPEG_LIMIT / 3) * 4)))) {
      throw new Error('无效的陪看内容。');
    }
  }
  return packet;
}
