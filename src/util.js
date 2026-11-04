/** 小工具：时间、格式化、URL 白名单、人类化等待。 */

import { execFile, execFileSync, spawn } from 'node:child_process';

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

/**
 * PowerShell 的 stdout 走的是控制台代码页（中文机器上是 GBK），
 * Node 按 UTF-8 解就把 `E:\视频` 读成 `E:\��Ƶ`——面板上那串乱码就是这么来的，
 * 而且还会被当成目录名 mkdir 出来一个乱码文件夹。
 * 所以跨进程只传 base64（纯 ASCII），Node 这边再按 UTF-16 还原，绕开代码页。
 */
function psEncode(text) {
  return Buffer.from(String(text ?? ''), 'utf16le').toString('base64');
}

function psDecode(b64) {
  const raw = String(b64 ?? '').trim();
  if (!raw) return '';
  try {
    return Buffer.from(raw, 'base64').toString('utf16le');
  } catch {
    return '';
  }
}

/** 路径里带 U+FFFD（= 解码失败留下的替换符）基本就是被代码页坑过的乱码。 */
export function looksBrokenPath(value) {
  return /[\uFFFD]/.test(String(value ?? ''));
}

/**
 * 把「被 GBK→UTF-8 错解」的路径还原成盘上真实存在的那个目录。
 * 做法：拿同级目录名做一次 GBK 字节 → UTF-8 解码，跟坏字符串比对，唯一命中才算数。
 * 只在真的坏了的时候调一次，找不到就返回空串（调用方退回默认目录）。
 */
export function repairMojibakePath(bad) {
  const broken = String(bad ?? '').trim();
  if (process.platform !== 'win32' || !looksBrokenPath(broken)) return '';
  const script = [
    `$bad = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${psEncode(broken)}'))`,
    '$root = [IO.Path]::GetPathRoot($bad)',
    'if (-not $root) { exit }',
    '$rest = $bad.Substring($root.Length)',
    '$hit = @()',
    `try { foreach ($d in [IO.Directory]::GetDirectories($root)) { $n = [IO.Path]::GetFileName($d); $m = [Text.Encoding]::UTF8.GetString([Text.Encoding]::GetEncoding(936).GetBytes($n)); if ($m -eq $rest) { $hit += $d } } } catch {}`,
    "if ($hit.Count -eq 1) { [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($hit[0]))) }",
  ].join('; ');
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
      timeout: 6000,
      windowsHide: true,
      encoding: 'utf8',
    });
    const fixed = psDecode(out);
    return fixed && !looksBrokenPath(fixed) ? fixed : '';
  } catch {
    return '';
  }
}

/**
 * 弹系统的「选择文件夹」窗口，返回选中的绝对路径；取消或非 Windows 返回空串。
 * 面板只能拿到字符串路径，弹窗只能在 Node 这边开，所以走 PowerShell 的 FolderBrowserDialog。
 */
export function pickFolder(description = '选择文件夹') {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve('');
    const safe = String(description).replace(/'/g, "''");
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
      `$d.Description = '${safe}'`,
      '$d.ShowNewFolderButton = $true',
      'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($d.SelectedPath))) }',
    ].join('; ');
    try {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-STA', '-Command', script],
        { timeout: 300000, windowsHide: true, encoding: 'utf8' },
        (error, stdout) => resolve(error ? '' : psDecode(stdout)),
      );
    } catch {
      resolve('');
    }
  });
}

/**
 * 在资源管理器里打开一个目录（不做递归、不动文件）。
 * 以前直接 spawn explorer.exe：路径里带中文/特殊字符时它常常一声不吭地什么都不做，
 * 所以改成让 shell 自己按「双击文件夹」的动作打开（Invoke-Item），路径用 base64 传。
 */
export function openFolder(dir) {
  const target = String(dir ?? '').trim();
  if (!target) return { ok: false, error: '没有目录。' };
  if (process.platform === 'win32') {
    const script = `$p = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${psEncode(target)}')); if (Test-Path -LiteralPath $p) { Invoke-Item -LiteralPath $p }`;
    try {
      execFile('powershell.exe', ['-NoProfile', '-Command', script], { timeout: 8000, windowsHide: true }, () => {});
      return { ok: true, dir: target };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }
  const [cmd, args] = process.platform === 'darwin' ? ['open', [target]] : ['xdg-open', [target]];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
  return { ok: true, dir: target };
}

export function parseBvid(value) {
  const text = String(value ?? '');
  const direct = /\b(BV[0-9A-Za-z]{10})\b/.exec(text);
  if (direct) return direct[1];
  const av = /\bav(\d+)\b/i.exec(text);
  if (av) return `av${av[1]}`;
  return null;
}

/**
 * B站动态 ID：t.bilibili.com/<id>、bilibili.com/opus/<id>、dyn:<id>，或写成纯数字。
 * 纯数字只在明确按 B站 解析时才认，不然会和抖音视频 ID 撞车。
 */
export function parseDynamicId(value) {
  const text = String(value ?? '').trim();
  const fromUrl = /(?:t\.bilibili\.com|bilibili\.com\/opus|bilibili\.com\/dynamic)\/(\d{10,25})/.exec(text);
  if (fromUrl) return fromUrl[1];
  const tagged = /^dyn[:/]?(\d{10,25})$/i.exec(text);
  if (tagged) return tagged[1];
  if (/^\d{15,25}$/.test(text)) return text;
  return null;
}

/** B站专栏：/read/cv123456、cv123456，或 cv:<id>。 */
export function parseCvid(value) {
  const text = String(value ?? '').trim();
  const cv = /\bcv(\d{5,20})\b/i.exec(text) || /^cv[:/]?(\d{5,20})$/i.exec(text);
  if (cv) return cv[1];
  if (/^\d{5,20}$/.test(text)) return text;
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

/**
 * 正文里自己写了「@昵称」，而发的时候又会前置一个真 @ → 页面上就成了 @ 两次。
 * 插真 @ 之前先把它从正文里剥掉（连带紧跟的一个空格）。name 为空就原样返回。
 */
export function stripAtName(text, name) {
  const s = String(text ?? '');
  const who = String(name ?? '').trim();
  if (!who) return s;
  const escaped = who.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return s
    .replace(new RegExp(`@${escaped}[ \\t]?`, 'g'), '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * 手打的「@你 / @主人」：她不知道主人在抖音叫什么时就会这么写。
 * 这几个字不是昵称，拿去候选面板里永远找不到人；正文里留着也只是个假 @。
 */
export function stripAtPlaceholder(text) {
  return String(text ?? '')
    .replace(/@(你|您|主人|主人你|老板)(?=[\s，。！？、,.!?~～…]|$)/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}
