/** 小工具：时间、格式化、URL 白名单、人类化等待。 */

import { spawn } from 'node:child_process';

export const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function rand(min, max) {
  return Math.floor(min + Math.random() * (max - min));
}

/** 人类化停顿：动作之间不要像机器一样等固定值。 */
export async function humanPause(minMs = 900, maxMs = 2600) {
  await sleep(rand(minMs, maxMs));
}

export function dayKey(date = new Date(), timeZone = 'Asia/Shanghai') {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/** ISO 周：2026-W44。用于周额度。 */
export function weekKey(date = new Date(), timeZone = 'Asia/Shanghai') {
  const day = dayKey(date, timeZone);
  const d = new Date(day + 'T00:00:00Z');
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function nowIso(timeZone = 'Asia/Shanghai', date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value ?? '00';
  const asUtc = Date.UTC(
    Number(get('year')),
    Number(get('month')) - 1,
    Number(get('day')),
    Number(get('hour')),
    Number(get('minute')),
    Number(get('second')),
  );
  const offsetMin = Math.round((asUtc - date.getTime()) / 60000);
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const offset = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}${offset}`;
}

export function hourOf(date, timeZone) {
  try {
    return Number(
      new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hour12: false }).format(date),
    );
  } catch {
    return date.getHours();
  }
}

export function formatDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s >= 3600) return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function formatCount(n) {
  const v = Number(n) || 0;
  if (v >= 100000000) return `${(v / 100000000).toFixed(1)}亿`;
  if (v >= 10000) return `${(v / 10000).toFixed(1)}万`;
  return String(v);
}

export function stripTags(s) {
  return String(s ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export function truncate(s, n) {
  const text = String(s ?? '').replace(/\s+/g, ' ').trim();
  const chars = [...text];
  return chars.length <= n ? text : chars.slice(0, Math.max(0, n - 1)).join('') + '…';
}

/** 只允许平台官网链接；不接受账号密码、非 https、内网地址。 */
export function platformUrl(raw) {
  let u;
  try {
    u = new URL(String(raw ?? '').trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  const host = u.hostname.toLowerCase();
  const ok =
    host === 'www.bilibili.com' ||
    host === 'bilibili.com' ||
    host === 'm.bilibili.com' ||
    host === 't.bilibili.com' ||
    host === 'www.douyin.com' ||
    host === 'douyin.com' ||
    host === 'v.douyin.com' ||
    host === 'www.iesdouyin.com' ||
    host === 'iesdouyin.com';
  return ok ? u.href : null;
}

/**
 * 在主人自己的默认浏览器里打开链接（不是桌宠的后台浏览器）。
 * 只接受 http/https，不接受带账号密码的 URL。
 */
export function openInBrowser(raw) {
  let u;
  try {
    u = new URL(String(raw ?? '').trim());
  } catch {
    return { ok: false, error: '链接格式不对。' };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    return { ok: false, error: '只打开 http/https 链接。' };
  }
  if (u.username || u.password) return { ok: false, error: '链接里不要带账号密码。' };
  const url = u.href;
  const [cmd, args] =
    process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
  } catch (error) {
    return { ok: false, error: `打不开浏览器：${error?.message ?? error}` };
  }
  return { ok: true, url };
}

export function parseBvid(value) {
  const text = String(value ?? '');
  const direct = /\b(BV[0-9A-Za-z]{10})\b/.exec(text);
  if (direct) return direct[1];
  const av = /\bav(\d+)\b/i.exec(text);
  if (av) return `av${av[1]}`;
  return null;
}

export function parseDouyinId(value) {
  const text = String(value ?? '').trim();
  if (/^\d{10,24}$/.test(text)) return text;
  const fromUrl = /\/(?:video|note)\/(\d{10,24})/.exec(text) || /modal_id=(\d{10,24})/.exec(text);
  return fromUrl?.[1] ?? null;
}

export function stableKey(parts) {
  return parts.map((p) => String(p ?? '').replace(/[|\n]/g, ' ')).join('|').slice(0, 500);
}

export function randomCode(prefix = 'd') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16).toUpperCase();
  });
}

export function parseKeywords(text) {
  return String(text ?? '')
    .split(/[,，、;；\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 30);
}

export function safeJson(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}
