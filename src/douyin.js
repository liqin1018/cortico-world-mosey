import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { formatCount, formatDuration, humanPause, parseDouyinId, parseKeywords, stripAtName, stripAtPlaceholder, truncate } from './util.js';

const ORIGIN = 'https://www.douyin.com';

/** 抖音主页 id（sec_uid）：MS4w 开头，后面是字母数字和 _ - 。 */
export const SEC_UID_RE = /MS4w[A-Za-z0-9_-]{10,200}/;

/** 从一段文字里抠 sec_uid：直接填、粘主页链接、粘分享文案都能用。 */
export function secUidOf(value) {
  const hit = String(value ?? '').match(SEC_UID_RE);
  return hit ? hit[0] : '';
}

export class DouyinError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DouyinError';
    this.code = code;
  }
}

const feedScript = (limit) => String.raw`(() => {
  const limit = ${limit};
  const out = [];
  for (const card of Array.from(document.querySelectorAll('[data-aweme-id]'))) {
    const id = card.getAttribute('data-aweme-id');
    if (!id) continue;
    const lines = (card.innerText || '').split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
    const title = lines.filter(function (l) { return l.length > 8 && l.charAt(0) !== '@'; }).sort(function (a, b) { return b.length - a.length; })[0] || lines[0] || '';
    const author = lines.find(function (l) { return l.charAt(0) === '@'; }) || '';
    const duration = lines.find(function (l) { return /^\d{1,2}:\d{2}$/.test(l); }) || '';
    const like = lines.find(function (l) { return /^[\d.]+\s*(万|亿)?$/.test(l); }) || '';
    const img = card.querySelector('img');
    out.push({ id: id, title: title, author: author.replace(/^@/, ''), duration: duration, like: like, cover: img ? img.getAttribute('src') : '', url: 'https://www.douyin.com/video/' + id });
    if (out.length >= limit) break;
  }
  return out;
})()`;

const metaScript = String.raw`(() => {
  const pick = function (sel) { const el = document.querySelector(sel); return el ? el.innerText.trim() : ''; };
  const counts = Array.from(document.querySelectorAll('[data-e2e="video-player-digg"], [data-e2e="feed-comment-icon"]')).map(function (n) { return n.innerText.trim(); });
  const comments = Array.from(document.querySelectorAll('[data-e2e="comment-item"]')).slice(0, 8)
    .map(function (n) { return n.innerText.split("\n").map(function (s) { return s.trim(); }).filter(Boolean).slice(0, 3).join(" "); })
    .filter(Boolean);
  const video = document.querySelector('video');
  const h1 = document.querySelector('h1');
  const cleanTitle = String(document.title || '').replace(/\s*-\s*抖音\s*$/, '').trim();
  return {
    title: (cleanTitle.length > 4 ? cleanTitle : '') || pick('[data-e2e="detail-video-info"]').split("\n")[0] || (h1 ? h1.innerText.trim() : "") || document.title,
    detail: pick('[data-e2e="detail-video-info"]'),
    author: (pick('[data-e2e="user-info"]').split("\n")[0] || "").split("粉丝")[0].trim(),
    counts: counts,
    comments: comments,
    duration: video && isFinite(video.duration) ? Math.round(video.duration) : null,
  };
})()`;

const seekScript = (t) => String.raw`(() => {
  const t = ${t};
  const video = document.querySelector('video');
  if (!video || !isFinite(video.duration)) return false;
  video.currentTime = Math.min(t, Math.max(0.5, video.duration - 1));
  video.pause();
  return true;
})()`;

const stateScript = String.raw`(() => {
  const like = document.querySelector('[data-e2e="video-player-digg"]');
  const follow = Array.from(document.querySelectorAll('button')).find(function (b) { return /^(关注|已关注)$/.test((b.innerText || '').trim()); });
  const video = document.querySelector('video');
  const login = document.body.innerText.includes('请先登录') || document.body.innerText.includes('登录后即可');
  return {
    liked: like ? like.getAttribute('data-e2e-state') === 'video-player-digged' : null,
    following: follow ? (follow.innerText || '').trim() === '已关注' : null,
    login,
    duration: video && isFinite(video.duration) ? Math.round(video.duration) : null,
  };
})()`;

const watchScript = String.raw`(() => {
  const v = document.querySelector('video');
  const pick = (sels) => {
    for (const sel of sels) {
      const nodes = Array.from(document.querySelectorAll(sel)).slice(0, 6);
      const out = nodes
        .map((n) => (n.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 2).join(' '))
        .filter(Boolean);
      if (out.length) return out;
    }
    return [];
  };
  const text = document.body.innerText || '';
  const platform = /bilibili\.com/.test(location.host) ? 'bilibili' : /douyin\.com/.test(location.host) ? 'douyin' : 'web';
  let title = (document.title || '').replace(/\s*-\s*抖音\s*$/, '').trim();
  if (platform === 'douyin' && title.length < 5) {
    const info = document.querySelector('[data-e2e="detail-video-info"]');
    if (info) title = (info.innerText || '').split('\n')[0] || title;
  }
  if (platform === 'bilibili') {
    const h1 = document.querySelector('h1');
    if (h1) title = h1.innerText.trim() || title;
    title = title.replace(/_哔哩哔哩.*$/, '').trim();
  }
  return {
    platform: platform,
    url: location.href,
    title: title.slice(0, 120),
    time: v && isFinite(v.currentTime) ? Math.round(v.currentTime) : null,
    duration: v && isFinite(v.duration) ? Math.round(v.duration) : null,
    paused: v ? !!v.paused : null,
    comments: pick(['[data-e2e="comment-item"]', '#comment .reply-item', '.reply-item', '.comment-item', '.danmaku-item']),
    loginHint: /登录后|请先登录|扫码登录|立即登录/.test(text),
  };
})()`;

/** 抖音只给「11分钟前 / 昨天 / 周四」这种相对时间，换成大约的时间戳，用来排序。 */
function approxTime(label, index = 0) {
  const text = String(label ?? '');
  const now = Date.now();
  let m = /^(\d+)\s*秒前/.exec(text);
  if (m) return now - Number(m[1]) * 1000;
  m = /^(\d+)\s*分钟前/.exec(text);
  if (m) return now - Number(m[1]) * 60 * 1000;
  m = /^(\d+)\s*小时前/.exec(text);
  if (m) return now - Number(m[1]) * 3600 * 1000;
  if (text.includes('昨天')) return now - 24 * 3600 * 1000;
  const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const wi = week.findIndex((w) => text.includes(w));
  if (wi >= 0) {
    const today = new Date(now).getDay();
    const diff = (today - wi + 7) % 7 || 7;
    return now - diff * 24 * 3600 * 1000;
  }
  m = /^(\d{2})-(\d{2})/.exec(text);
  if (m) {
    const d = new Date(new Date(now).getFullYear(), Number(m[1]) - 1, Number(m[2]));
    return d.getTime() > now ? d.getTime() - 365 * 24 * 3600 * 1000 : d.getTime();
  }
  return now - index * 1000;
}

const RISK_TEXT = /(完成验证|安全验证|操作频繁|账号异常|访问过于频繁|请稍后再试|captcha|verify)/i;

/**
 * 一次往返把整页的「验证/登录墙」状态问清楚。
 * 以前每个检查点各查一次 body.innerText()，最多查三次；这里合并成一次。
 * 注意必须用 innerText 而不是 textContent：textContent 会把 <script> 里的
 * 打包代码一起读进来，那里面本来就有 verify/captcha 字样，实测全是误报。
 */
async function bodyFlags(page) {
  return page
    .evaluate(() => {
      const t = document.body ? document.body.innerText || '' : '';
      return {
        risk: /完成验证|安全验证|操作频繁|账号异常|访问过于频繁|请稍后再试|captcha|verify/i.test(t),
        verify: /短信验证码|为确保是本人操作|身份验证|完成验证|安全验证/.test(t),
        login: /登录后|请先登录|扫码登录|立即登录/.test(t),
      };
    })
    .catch(() => ({ risk: false, verify: false, login: false }));
}

/**
 * 剥掉正文开头手打的「@某人」。
 *
 * 聊天框里手打的 `@` 只是普通字符：抖音会把它染成蓝色，看起来像提到了人，
 * 实际上后面没有名字、对方也收不到通知。真 @ 只能从候选面板选（插 chip）。
 * 所以发正文前把开头这种假 @ 去掉，别让主人以为被 @ 了。
 * 只处理开头，正文中间正常的「@」不动。
 */
export function stripLeadingFakeAt(text) {
  let s = String(text ?? '').trim();
  for (let i = 0; i < 3; i += 1) {
    const before = s;
    s = s
      // 「@昵称」后面跟空格/标点
      .replace(/^@[^\s@，。！？、,.!?：:;；~～]{1,24}\s*/, '')
      // 孤零零的「@ 」
      .replace(/^@+\s+/, '')
      .trim();
    if (s === before) break;
  }
  // 整条只剩 @ 的话就别发了
  return s.replace(/^@+$/, '').trim();
}

/**
 * 挂在聊天页里的观察器：消息列表的 DOM 一变，就把「变了」这件事推给 Node 侧。
 * 抖音自己的长连接/轮询会先更新 DOM，所以这边几乎和手机上同时知道——不用我们再轮询接口，
 * 也不用反复点开会话（点会话正是 -509 的来源）。
 * 这里只做「变了」的判断（消息条数 + 末尾几条的文字），内容仍由 Node 侧读，保证和 inbox 一致。
 */
function dmObserverScript() {
  const win = window;
  if (win.__strollDmObs) return 'already';
  const text = (el) => String(el.innerText || '').replace(/\s+/g, ' ').trim();
  const sigOf = () => {
    const items = Array.from(document.querySelectorAll('[data-e2e="msg-item-content"]'));
    if (!items.length) {
      // 会话列表那一行（还没点进会话，或会话被切走时）也要能发现新消息
      const rows = Array.from(document.querySelectorAll('[data-e2e="conversation-item"]')).slice(0, 3).map(text).join('|');
      return `0#${rows.slice(-200)}`;
    }
    return `${items.length}#${items.slice(0, 6).map(text).join('|').slice(-200)}`;
  };
  let last = sigOf();
  let timer = 0;
  const check = () => {
    timer = 0;
    let now = '';
    try {
      now = sigOf();
    } catch (error) {
      return;
    }
    if (now === last) return;
    // 绑定还没到位（刚导航完）：这次变动先别吃掉，等下一次 DOM 变化再报
    if (typeof win.__strollDmSignal !== 'function') return;
    last = now;
    try {
      win.__strollDmSignal(now);
    } catch (error) {
      // 页面正在卸载：下一次导航后会重新挂
    }
  };
  // 只看消息区/会话列表，别被页面上的动画带着空转；
  // 认不出容器时按 300ms 最多算一次签名，代价也很小。
  const hot = (node) => {
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    if (!el || !el.closest) return false;
    return !!(
      el.closest('[data-e2e="msg-item-content"]') ||
      el.closest('[data-e2e="conversation-item"]') ||
      el.closest('[class*="messageList"]') ||
      el.closest('[class*="MessageList"]') ||
      el.closest('[class*="message-list"]') ||
      el.closest('[class*="onversationItem"]')
    );
  };
  const obs = new MutationObserver((records) => {
    let hit = false;
    for (const r of records) {
      if (hot(r.target)) {
        hit = true;
        break;
      }
      const added = r.addedNodes ? Array.from(r.addedNodes) : [];
      if (added.some(hot)) {
        hit = true;
        break;
      }
    }
    if (!hit || timer) return;
    timer = setTimeout(check, 120);
  });
  obs.observe(document.body, { childList: true, subtree: true, characterData: true });
  win.__strollDmObs = obs;
  return 'ok';
}

/**
 * 在页面里找「一片小图」的区域 = 表情面板。
 * 不认抖音的类名（它们会变），只认形状：可见、16~96 像素、不在消息气泡里，
 * 而且成片出现（同一块地方 >= 4 张）。这样改版也还能用。
 */
function probeEmojiPanelInPage() {
  const vis = (n) => {
    const r = n.getBoundingClientRect();
    const st = getComputedStyle(n);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) > 0.05;
  };
  const small = [];
  const push = (el, src) => {
    const r = el.getBoundingClientRect();
    if (r.width < 16 || r.width > 96 || r.height < 16 || r.height > 96) return;
    if (!vis(el)) return;
    if (el.closest('[data-e2e="msg-item-content"]')) return;
    if (el.closest('[data-e2e="conversation-item"]')) return;
    small.push({ el, src, x: r.x, y: r.y, w: r.width, h: r.height });
  };
  for (const img of Array.from(document.querySelectorAll('img'))) {
    push(img, img.currentSrc || img.src || '');
  }
  // 有的表情是背景图，不是 <img>。全页算样式有点贵，限个上限。
  const bgPool = document.querySelectorAll('span, i, div');
  for (let i = 0; i < bgPool.length && i < 4000 && small.length < 120; i += 1) {
    const el = bgPool[i];
    if (el.childElementCount) continue;
    const bg = getComputedStyle(el).backgroundImage || '';
    const m = /url\("?(.+?)"?\)/.exec(bg);
    if (m) push(el, m[1]);
  }
  if (small.length < 4) return { found: false, items: [], tabs: [] };
  /**
   * 找「最紧凑的那一片」：候选容器宽 160-680、高 80-640，里面 >=4 张小图。
   * 只按「图片多」挑会挑到 body（整页都算），所以用「张数 + 密度」打分，
   * 表情面板永远是又小又密的那块。
   */
  let best = null;
  for (const s of small) {
    let n = s.el.parentElement;
    for (let i = 0; i < 8 && n; i += 1) {
      const r = n.getBoundingClientRect();
      if (r.width >= 160 && r.width <= 680 && r.height >= 80 && r.height <= 640) {
        const cnt = small.filter((x) => n.contains(x.el)).length;
        if (cnt >= 4) {
          const density = cnt / Math.max(1, (r.width * r.height) / 10000);
          const score = cnt + density;
          if (!best || score > best.score) best = { el: n, cnt, score };
          break;
        }
      }
      n = n.parentElement;
    }
  }
  if (!best) return { found: false, items: [], tabs: [] };
  const box = best.el.getBoundingClientRect();
  const items = small
    .filter((s) => best.el.contains(s.el))
    .map((s, i) => ({ i, src: s.src, x: Math.round(s.x + s.w / 2), y: Math.round(s.y + s.h / 2), w: Math.round(s.w) }))
    .filter((x) => x.x > 0 && x.y > 0);
  // 面板里那排「小图标」就是分类 tab（表情 / 收藏 / 各个表情包）
  const tabs = [];
  const up = best.el.parentElement;
  const upRect = up ? up.getBoundingClientRect() : null;
  const root = up && upRect && upRect.width <= 680 && upRect.height <= 700 ? up : best.el;
  for (const el of Array.from(root.querySelectorAll('img, span, div, button'))) {
    if (best.el.contains(el)) continue;
    if (el.childElementCount) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 14 || r.width > 60 || r.height < 14 || r.height > 60) continue;
    if (!vis(el)) continue;
    const label = String(el.alt || el.innerText || '').replace(/\s+/g, ' ').trim();
    if (label.length > 8) continue;
    tabs.push({ i: tabs.length, label, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
  }
  return {
    found: true,
    box: { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) },
    items,
    tabs: tabs.slice(0, 12),
  };
}

/**
 * 输入框旁边那些小图标按钮（发图 / 表情 / 发送…）。
 *
 * 两个坑都踩过：
 * 1. 「往上找一块容器再全扫」会把消息气泡、会话头像也算进来（实测点开过群资料面板）；
 * 2. 反过来「把 el 的子元素全排除」也不行——传进来的 el 常常就是
 *    `[data-e2e="msg-input"]` 那整个输入区，工具栏就在它**里面**，
 *    结果一个按钮都找不到，表情直接发不出去（1.8.1 的线上故障）。
 * 所以现在：框按输入区算，只排除**编辑器本身**，再按几何把工具栏那一排圈出来。
 */
export function toolbarProbeInPage(el) {
  if (!el) return [];
  const vis = (n) => {
    const r = n.getBoundingClientRect();
    const st = getComputedStyle(n);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) > 0.05;
  };
  const ed = el.matches?.('textarea, input, [contenteditable="true"]')
    ? el
    : el.querySelector?.('[contenteditable="true"], [data-slate-editor="true"], textarea') || el;
  const box = el.closest?.('[data-e2e="msg-input"]') || el.closest?.('[class*="MsgInput"]') || el;
  const br = box.getBoundingClientRect();
  const banned =
    '[data-e2e="msg-item-content"], [data-e2e="conversation-item"], [class*="MessageItem"], [class*="MessageBox"], [class*="messageMessageList"], [class*="avatar"], [class*="Avatar"]';
  // SVG 元素的 className 是个对象（SVGAnimatedString），直接拼字符串会变成
  // "[object SVGAnimatedString]"——发送按钮就靠 class 里的 publishBtn 认，漏了就认错
  const clsOf = (n) => String(n.getAttribute?.('class') ?? n.className ?? '');
  const kindOf = (n, hint) => {
    const h = hint || `${n.tagName} ${clsOf(n)} ${clsOf(n.parentElement)} ${n.getAttribute?.('aria-label') ?? ''} ${n.getAttribute?.('title') ?? ''}`.toLowerCase();
    if (/upload|file|文件|图片|相册|photo|album/.test(h)) return 'upload';
    if (/send|发送|publish|submit/.test(h)) return 'send';
    if (/voice|record|语音|mic|说话/.test(h)) return 'voice';
    if (/emoji|表情|smile|sticker|emote|face/.test(h)) return 'emoji';
    return 'other';
  };
  const inBox = (n) => {
    // 只排除编辑器本身：工具栏就在 el 里，不能连它一起排掉
    if (!n || n === ed || ed.contains(n) || n.contains(ed)) return false;
    if (n.closest(banned)) return false;
    const r = n.getBoundingClientRect();
    if (r.width < 15 || r.height < 15 || r.width > 56 || r.height > 56) return false;
    if (!vis(n)) return false;
    const cy = r.y + r.height / 2;
    const cx = r.x + r.width / 2;
    if (cy < br.top - 40 || cy > br.bottom + 40) return false;
    if (cx < br.left - 24 || cx > br.right + 140) return false;
    return true;
  };

  const hosts = [];
  const push = (n) => {
    if (n && inBox(n) && !hosts.some((h) => h === n)) hosts.push(n);
  };
  // 图标基本都是 svg：它自己的框就是可点区域，别再往上跳到一整排按钮上
  for (const svg of Array.from(document.querySelectorAll('svg'))) {
    const r = svg.getBoundingClientRect();
    if (r.width < 14 || r.width > 48 || r.height < 14 || r.height > 48) continue;
    const cy = r.y + r.height / 2;
    if (cy < br.top - 40 || cy > br.bottom + 40) continue;
    let host = svg;
    if (!inBox(host)) {
      host = svg.parentElement;
      for (let i = 0; i < 2 && host; i += 1) {
        const hr = host.getBoundingClientRect();
        if (hr.width >= 16 && hr.height >= 16 && hr.width <= 56 && hr.height <= 56) break;
        host = host.parentElement;
      }
    }
    push(host);
  }
  // 没有 svg 的版本：按类名找图标
  if (hosts.length < 2) {
    for (const n of Array.from(document.querySelectorAll('div, span, button, i'))) {
      if (!/icon|emoji|btn|button|tool/i.test(String(n.className ?? ''))) continue;
      if (n.querySelector('svg, img') || !inBox(n)) continue;
      hosts.push(n);
    }
  }

  const out = [];
  const seen = new Set();
  for (const n of hosts) {
    const r = n.getBoundingClientRect();
    const x = Math.round(r.x + r.width / 2);
    const y = Math.round(r.y + r.height / 2);
    const key = `${x},${y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const text = String(n.innerText || n.getAttribute('aria-label') || n.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
    const hint = `${n.tagName} ${clsOf(n)} ${clsOf(n.parentElement)} ${n.getAttribute('aria-label') ?? ''} ${n.getAttribute('title') ?? ''}`.toLowerCase();
    out.push({
      x,
      y,
      text: text.slice(0, 12),
      cls: clsOf(n).slice(0, 90),
      e2e: String(n.getAttribute('data-e2e') ?? ''),
      hint,
      kind: kindOf(n, hint),
    });
  }
  // 表情排最前，其次「认不出来但也不是发图/发送/语音」的，危险按钮（发图/发送/语音）垫底
  const rank = { emoji: 0, other: 1, upload: 2, send: 3, voice: 4 };
  out.sort((a, b) => rank[a.kind] - rank[b.kind] || a.x - b.x);
  return out.slice(0, 10);
}


export class DouyinBrowser {
  constructor({ dataDir, cfg, log, policy, stickers }) {
    this.dataDir = dataDir;
    this.cfg = cfg;
    this.log = log;
    this.policy = policy;
    /** 本地表情库（收藏/发送用）；world 启动时注入。 */
    this.stickers = stickers ?? null;
    /** 最近一次界面没认出来时落盘的调试文件。 */
    this.lastDebugDump = '';
    this.profileDir = path.join(dataDir, 'stroll', 'douyin-profile');
    this.loginFile = path.join(dataDir, 'stroll', 'douyin-login.json');
    this.context = null;
    this.headless = null;
    this.loginPoller = null;
    this.watchStartedAt = 0;
    this.page = null;
    this.queue = Promise.resolve();
    this.closeTimer = null;
    this.holdOpen = false;
    /** 私信监听开着的期间保持浏览器热着（见 keepWarm）。 */
    this.warm = false;
    this.busy = 0;
    this.launching = null;
    this.lastAction = '';
    this.lastError = '';
    /** 当前消息列表里打开的是哪个会话：监听轮询时省一次点击。 */
    this.openThread = '';
    /** peekThread 的缓存：预览行没变就别点开会话（防 -509 的关键）。 */
    this.peekCache = null;
    /**
     * 私信监听专用的第二个标签页：停在主人的会话上不动。
     * 主页（this.page）还要拿去评论/看视频，一导航就把聊天页带走了，所以单独开一个。
     * 它不开新浏览器（同一个 context，cookie 共用），只是一个后台 tab。
     */
    this.dmPage = null;
    /** dmPage 上正开着谁的会话。 */
    this.dmThread = '';
    /** 正在建 dmPage 的 promise，防并发重复建。 */
    this.dmArming = null;
    /** 收到页面内「有新消息」信号时的回调（由 world 提供）。 */
    this.dmHit = null;
    /** 信号处理中的重入标记：一轮还没读完又来信号，就合并成一次。 */
    this.dmSignalBusy = false;
    this.dmSignalQueued = false;
    /** 上一次把观察器挂上去的时间，用来判断要不要重挂。 */
    this.dmArmedAt = 0;
    this.dmMarkAt = 0;
    /** 登录态的服务端校验结果缓存：cookie 在也有可能被踢，见 sessionAlive。 */
    this.sessionOk = null;
    this.sessionOkAt = 0;
    /** 她自己这个号的昵称/uid：群里用来把「我发的」和「别人发的」分开。 */
    this.selfName = '';
    this.selfUid = '';
    /** 最近发出去的话：{text, at}。群消息里用来兜底识别「这几条其实是我自己说的」。 */
    this.recentSent = [];
    /** 上一次发送有没有把 @ 插成真 chip（回执用）。 */
    this.lastMention = false;
    /** 600ms 的合并窗口：连发两句只叫一次。 */
    this.dmSettle = null;
    this.dmPendingSig = '';

    /**
     * 群聊监听：跟私信一个思路（常驻 tab + 页面内观察器），但每个群单独一个 tab。
     * 私信那个 tab 必须钉在主人会话上不动，所以群不能共用它。
     * 只盯配置里点名的群，没点名就一个都不开。
     */
    this.groupPages = new Map();
  }

  serialize(fn) {
    const run = this.queue.then(
      () => this.runBusy(fn),
      () => this.runBusy(fn),
    );
    this.queue = run.catch(() => {});
    return run;
  }

  /**
   * 所有排队操作都在这里跑，顺便记一个「正在忙」的深度。
   * 自动收窗的定时器可能在上一个操作排下来、甚至操作进行到一半时到点，
   * 以前就这么把正在用的页面关掉，表现是「网页突然退出/操作中断」。
   */
  async runBusy(fn) {
    this.busy += 1;
    // 有人在用，先把排队中的自动收窗取消，别打断这一轮
    if (this.closeTimer) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
    try {
      return await fn();
    } finally {
      this.busy -= 1;
    }
  }

  /**
   * 依次尝试：环境变量 → 插件自己的依赖 → Coopanion 扩展目录里已有的 playwright-core。
   * link: 安装时依赖不一定被 hoist 到插件目录，这个兜底能少一堆“浏览器没起来”。
   */
  async loadPlaywright() {
    if (process.env.STROLL_PLAYWRIGHT) return import(process.env.STROLL_PLAYWRIGHT);
    try {
      return await import('playwright-core');
    } catch {
      // 继续找宿主目录
    }
    const require = createRequire(import.meta.url);
    const extensions = path.join(this.dataDir, '..', '..', '..', 'extensions');
    const candidates = [extensions, process.cwd()];
    // pnpm 的依赖在 .pnpm 里，不一定 hoist 到 node_modules 根
    try {
      const pnpm = path.join(extensions, 'node_modules', '.pnpm');
      for (const name of fs.readdirSync(pnpm)) {
        if (name.startsWith('playwright-core@')) candidates.push(path.join(pnpm, name, 'node_modules'));
      }
    } catch {
      // 没有 .pnpm 就只试普通目录
    }
    for (const dir of candidates) {
      try {
        return require(require.resolve('playwright-core', { paths: [dir] }));
      } catch {
        // 换下一个
      }
    }
    throw new DouyinError(
      'BROWSER_DEP',
      '找不到 playwright-core：在插件目录执行 corepack pnpm install，或在扩展目录重装依赖。',
    );
  }

  /**
   * 默认后台（headless）。只有扫码登录和「一起看」才开窗。
   * 模式变了就重开一个上下文，免得把 headless 进程当有头用。
   */
  async launch({ headless = this.cfg.background !== false, force = false } = {}) {
    if (this.context && !force && this.headless === headless) return this.context;
    if (this.context && (force || this.headless !== headless)) await this.close();
    if (this.launching) return this.launching;
    this.launching = (async () => {
      const mod = await this.loadPlaywright();
      const chromium = mod.chromium ?? mod.default?.chromium;
      const options = {
        headless: headless !== false,
        viewport: { width: 1440, height: 900 },
        locale: 'zh-CN',
        timezoneId: 'Asia/Shanghai',
        args: [
          '--disable-blink-features=AutomationControlled',
          '--autoplay-policy=no-user-gesture-required',
          '--window-size=1460,940',
        ],
      };
      let context;
      // 先 Edge 再 Chrome：Windows 上基本都有 Edge，没装 Chrome 的机器也能跑。
      // 注意：Edge 和 Chrome 的 cookie 加密密钥是绑应用身份的（App-Bound Encryption），
      // 换一个浏览器读同一个 profile 会「没登录」——所以探针/调试要认准当初建库那个。
      const launchOnce = async () => {
        try {
          return await chromium.launchPersistentContext(this.profileDir, { ...options, channel: this.channel ?? 'msedge' });
        } catch (error) {
          if (this.channel) throw error;
          return await chromium.launchPersistentContext(this.profileDir, { ...options, channel: 'chrome' });
        }
      };
      try {
        context = await launchOnce();
      } catch (error) {
        // 上次没收干净：profile 还锁着（exit 21 / ProcessSingleton），
        // 先把自己这个 profile 的残留进程清掉再试一次；不清的话会一直「浏览器起不来」。
        const reaped = await this.reapOrphans();
        if (!reaped) throw error;
        await new Promise((resolve) => setTimeout(resolve, 1500));
        context = await launchOnce();
      }
      if (context.pages().length === 0) await context.newPage().catch(() => {});
      context.on('close', () => {
        // 旧窗口的 close 可能比新窗口的赋值还晚到，只处理自己的那一个
        if (this.context !== context) return;
        this.context = null;
        this.page = null;
        this.dmPage = null;
        this.dmThread = '';
        this.headless = null;
      });
      this.context = context;
      this.headless = headless !== false;
      return context;
    })()
      .catch((error) => {
        this.launching = null;
        throw new DouyinError('BROWSER_LAUNCH', `浏览器没起来：${error.message}`);
      })
      .finally(() => {
        this.launching = null;
      });
    return this.launching;
  }

  /**
   * 清掉占着这个 profile 的残留浏览器进程。
   * 只认命令行里带自己 user-data-dir 的进程，绝不碰主人自己开的浏览器。
   */
  async reapOrphans() {
    if (process.platform !== 'win32') return 0;
    const { execFile } = await import('node:child_process');
    const needle = `--user-data-dir=${this.profileDir}`;
    const script =
      `$hit = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${needle}*' -and $_.CommandLine -notlike '*--type=*' }; ` +
      'foreach ($p in @($hit)) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }; ' +
      'Write-Output @($hit).Count';
    return await new Promise((resolve) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { timeout: 20000, windowsHide: true },
        (error, stdout) => {
          if (error) return resolve(0);
          resolve(Number(String(stdout).trim()) || 0);
        },
      );
    });
  }

  async getPage() {
    // 沿用当前的窗口模式：开着的登录窗不能被一次隐式 launch 关掉重开
    const context = await this.launch({ headless: this.headless ?? (this.cfg.background !== false) });
    if (this.page && !this.page.isClosed()) return this.page;
    // 启动时自带一个 about:blank，直接用它；另开一个的话那个空页永远没人关，
    // 浏览器进程会一直驻留（实测能挂一小时、十几个进程），下次启动还会抢 profile。
    const blank = context.pages().find((p) => !p.isClosed() && p.url() === 'about:blank');
    this.page = blank ?? (await context.newPage());
    this.page.setDefaultTimeout(20000);
    return this.page;
  }

  async checkRisk(page) {
    const f = await bodyFlags(page);
    if (f.risk) {
      this.policy.noteRisk('DOUYIN_VERIFY', '抖音出现验证/频繁提示');
      throw new DouyinError('RISK', '抖音弹出验证或提示操作频繁，已经停手。');
    }
  }

  async goto(page, url, waitMs = 4200) {
    this.openThread = '';
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await humanPause(2200, 3600);
    if (waitMs) await page.waitForTimeout(waitMs);
    await this.checkRisk(page);
    this.lastError = '';
  }

  async status() {
    if (this.context) {
      const loggedIn = await this.isLoggedIn();
      return {
        platform: 'douyin',
        running: true,
        headless: this.headless !== false,
        loggedIn,
        ok: loggedIn,
        note: loggedIn ? '已登录' : '浏览器开着，但没登录',
      };
    }
    const saved = this.savedLogin();
    return {
      platform: 'douyin',
      running: false,
      headless: true,
      loggedIn: !!saved,
      ok: !!saved,
      note: saved ? `已登录（${saved.at.slice(0, 10)} 确认过，后台待命）` : '还没登录：在面板点「登录抖音」扫一次码',
    };
  }

  /** 登录态落一份标记：浏览器关着时也能回答「登没登录」。 */
  markLoggedIn(extra = {}) {
    const now = Date.now();
    this.lastLogin = { at: new Date(now).toISOString(), ...extra };
    // 私信监听每隔几秒就会探一次登录态：没必要每次都写盘，十分钟落一次足够
    if (!Object.keys(extra).length && this.dmMarkAt && now - this.dmMarkAt < 10 * 60 * 1000) return;
    this.dmMarkAt = now;
    try {
      fs.mkdirSync(path.dirname(this.loginFile), { recursive: true });
      fs.writeFileSync(this.loginFile, JSON.stringify(this.lastLogin), { mode: 0o600 });
    } catch {
      // 写不了就算了，内存里还有
    }
  }

  savedLogin() {
    if (this.lastLogin && Date.now() - Date.parse(this.lastLogin.at) < 30 * 86400000) return this.lastLogin;
    try {
      const raw = JSON.parse(fs.readFileSync(this.loginFile, 'utf8'));
      if (raw?.at && Date.now() - Date.parse(raw.at) < 30 * 86400000) {
        this.lastLogin = raw;
        return raw;
      }
    } catch {
      // 没登录过
    }
    return null;
  }

  async login() {
    return this.serialize(async () => {
      await this.launch({ headless: false, force: true });
      // 扫码期间不许自动收窗（launch 内部的 close 会清掉，所以放在它后面）
      this.holdOpen = true;
      const page = await this.getPage();
      await this.goto(page, `${ORIGIN}/jingxuan`, 2000);
      if (!(await this.isLoggedIn())) {
        await page.getByText('登录', { exact: true }).first().click({ timeout: 5000 }).catch(() => {});
        await humanPause(1200, 2200);
      }
      this.watchLogin();
      return {
        ok: true,
        message: '登录窗口已打开：扫码完成后会自动确认，并把窗口收起来，之后都在后台逛。',
        url: page.url(),
      };
    });
  }

  /** 扫码是异步的：登录成功后落盘并关窗，不阻塞面板。 */
  watchLogin() {
    if (this.loginPoller) return;
    const started = Date.now();
    this.loginPoller = setInterval(async () => {
      try {
        if (!this.context) return;
        if (await this.isLoggedIn()) {
          this.markLoggedIn();
          clearInterval(this.loginPoller);
          this.loginPoller = null;
          // 顺手记一下「现在登的是哪个号」，面板就能显示昵称、也能发现和主人是同一个号
          const self = await this.selfProfile().catch(() => null);
          if (self?.secUid) this.onSelf?.(self);
          await this.close();
          this.log?.info?.('stroll: 抖音登录成功，已切回后台');
        } else if (Date.now() - started > 5 * 60 * 1000) {
          clearInterval(this.loginPoller);
          this.loginPoller = null;
          // 五分钟没扫就收窗，不然这个有头窗口会一直挂在桌面上
          this.holdOpen = false;
          await this.close().catch(() => {});
        }
      } catch {
        // 下一轮再看
      }
    }, 2500);
  }

  /**
   * 轻量问一次服务端：这个 cookie 现在还能用吗。
   * 只看 cookie 在不在不够——会话被踢之后 cookie 还留着，页面却什么都读不到，
   * 表现就是「面板说已登录，实际私信一条都读不出来」。返回 null 表示没法判断（没有页面）。
   */
  async sessionAlive({ force = false, maxAge = 5 * 60 * 1000 } = {}) {
    const now = Date.now();
    if (!force && this.sessionOkAt && now - this.sessionOkAt < maxAge) return this.sessionOk;
    const page = this.page;
    if (!page || page.isClosed() || !/douyin\.com/.test(page.url())) return null;
    const res = await page
      .evaluate(async () => {
        try {
          const r = await fetch('/aweme/v1/web/user/profile/self/?device_platform=webapp&aid=6383&channel=channel_pc_web', {
            credentials: 'include',
          });
          const t = await r.json().catch(() => ({}));
          return { code: Number(t.status_code ?? -1), name: String(t.user?.nickname ?? ''), uid: String(t.user?.uid ?? '') };
        } catch {
          return { code: -1, name: '', uid: '' };
        }
      })
      .catch(() => ({ code: -1, name: '', uid: '' }));
    const code = res?.code ?? -1;
    // 8 = 用户未登录；-1 是没问到，别拿它当结论
    if (code === -1) return null;
    if (res.name) this.selfName = res.name;
    if (res.uid) this.selfUid = res.uid;
    this.sessionOk = code === 0;
    this.sessionOkAt = now;
    return this.sessionOk;
  }

  /** 她自己这个号的昵称（群里用来区分「谁说的」，拿不到就空串）。 */
  async selfNickname() {
    if (this.selfName) return this.selfName;
    await this.sessionAlive({ force: true }).catch(() => null);
    return this.selfName || '';
  }

  async isLoggedIn() {
    if (!this.context) return !!this.savedLogin();
    const cookies = await this.context.cookies(ORIGIN).catch(() => []);
    const ok = cookies.some((c) => c.name === 'sessionid' || c.name === 'sid_tt');
    if (!ok) return false;
    // cookie 在不代表服务端还认：被踢之后必须让主人重新扫码，而不是装作已登录
    const alive = await this.sessionAlive().catch(() => null);
    if (alive === false) return false;
    this.markLoggedIn();
    return ok;
  }

  /** 只清某个域名的 cookie，其它站点的原样留着。窗口没开时返回 cleared:0。 */
  async clearCookiesMatching(pattern) {
    if (!this.context) return { ok: false, cleared: 0, reason: 'no-window' };
    const all = await this.context.cookies().catch(() => []);
    const hit = (c) => pattern.test(String(c.domain ?? ''));
    const drop = all.filter(hit);
    if (!drop.length) return { ok: true, cleared: 0 };
    await this.context.clearCookies().catch(() => {});
    const keep = all.filter((c) => !hit(c));
    if (keep.length) await this.context.addCookies(keep).catch(() => {});
    return { ok: true, cleared: drop.length };
  }

  /** 退出登录：清 cookie、关窗、删掉登录标记，之后当没登录处理。 */
  async logout() {
    if (!this.context) await this.launch({ headless: true }).catch(() => {});
    const res = await this.clearCookiesMatching(/(^|\.)douyin\.com$|(^|\.)bytedance\.com$/i).catch(() => null);
    await this.close().catch(() => {});
    try {
      fs.unlinkSync(this.loginFile);
    } catch {
      // 本来就没存
    }
    this.lastLogin = null;
    return { ok: true, cleared: res?.cleared ?? 0 };
  }

  /** v.douyin.com 短链要在服务端展开；不打开浏览器也能拿到视频 id。 */
  async resolveShort(value) {
    const text = String(value ?? '');
    const short = /v\.douyin\.com\/([A-Za-z0-9_-]+)/.exec(text)?.[1];
    if (!short) return null;
    const ua =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
    try {
      const res = await fetch(`https://v.douyin.com/${short}/`, {
        redirect: 'follow',
        headers: { 'user-agent': ua },
        signal: AbortSignal.timeout(15000),
      });
      const fromUrl = /\/video\/(\d{10,24})/.exec(res.url ?? '')?.[1];
      if (fromUrl) return fromUrl;
      const html = await res.text().catch(() => '');
      return (
        /"videoId"\s*:\s*"(\d{10,24})"/.exec(html)?.[1] ??
        /\/video\/(\d{10,24})/.exec(html)?.[1] ??
        null
      );
    } catch {
      return null;
    }
  }

  async idOf(value) {
    return parseDouyinId(value) ?? (await this.resolveShort(value));
  }

  /**
   * 当前登录的是哪个号。
   * /user/self 不会跳到 /user/<sec_uid>，页面里的 <a> 又大多是推荐位/广告（实测点开是别人），
   * 所以不能拿第一个链接当自己。可靠做法：先从页面读出「抖音号：xxx」，
   * 再把 HTML 里出现的 sec_uid 逐个打开核一遍，抖音号对上的那个才是自己。
   */
  async selfProfile() {
    return this.serialize(async () => {
      const page = await this.getPage();
      if (!(await this.isLoggedIn())) {
        throw new DouyinError('LOGIN_REQUIRED', '抖音还没登录：先点「登录 / 验证」扫一次码');
      }
      try {
        await page.goto(`${ORIGIN}/user/self`, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch((error) => {
          throw new DouyinError('NAV', `打不开抖音个人页：${error.message}`);
        });
        await page.waitForTimeout(2600);
        const meta = await page
          .evaluate(() => {
            const text = document.body.innerText ?? '';
            const douyinId = (text.match(/抖音号[:：]\s*([A-Za-z0-9_.-]{2,40})/) ?? ['', ''])[1].trim();
            const name = (document.querySelector('h1')?.innerText ?? '').trim().split('\n')[0] ?? '';
            const html = document.documentElement.innerHTML;
            const ids = Array.from(new Set(html.match(/MS4w[A-Za-z0-9_-]{10,200}/g) ?? [])).slice(0, 4);
            return { douyinId, name, ids, url: location.href };
          })
          .catch(() => ({ douyinId: '', name: '', ids: [], url: page.url() }));

        let uid = secUidOf(page.url());
        let verified = !!uid;
        if (!uid && meta.douyinId) {
          for (const cand of meta.ids) {
            const info = await this.profileOf(page, cand);
            if (info.douyinId && info.douyinId === meta.douyinId) {
              uid = cand;
              verified = true;
              break;
            }
          }
        }
        if (!uid) uid = meta.ids[0] ?? '';
        if (!uid) {
          throw new DouyinError('NO_SELF', '读不到当前登录的抖音号（抖音可能改版了）；也可以把主页链接粘到「主人抖音」里');
        }
        return {
          ok: true,
          secUid: uid,
          name: meta.name || '',
          douyinId: meta.douyinId || '',
          verified,
        };
      } finally {
        this.scheduleClose(45);
      }
    });
  }

  /**
   * 把「主人抖音」填的东西统一成 sec_uid：
   * sec_uid 直接认；主页链接/分享文案里抠；纯抖音号解析不了（抖音搜索页反爬），会给出替代办法。
   */
  async resolveOwner(input) {
    return this.serialize(async () => {
      const raw = String(input ?? '').trim();
      if (!raw) throw new DouyinError('EMPTY', '没填内容');
      // 抖音号最常见的就是别里带 @ 或者「抖音号：」前缀
      const handle = raw
        .replace(/^@/, '')
        .replace(/^抖音号[:：]\s*/, '')
        .replace(/\s+/g, '')
        .trim();
      const direct = secUidOf(raw);
      if (direct) return { ok: true, secUid: direct, name: '', source: 'sec_uid' };

      // 分享文案里夹着链接也算链接（"复制此链接，打开抖音搜索…" 那种整段）
      const linkInText =
        raw.match(/https?:\/\/\S+/i)?.[0] ?? (/^v\.douyin\.com\//i.test(raw) ? `https://${raw}` : '');

      // 纯抖音号：实测搜索页在后台是空壳（只有导航、没有结果，换 UA 也一样）。
      // 不进浏览器，直接说清楚该怎么填，省得主人等十秒再失败。
      if (!linkInText) {
        throw new DouyinError(
          'HANDLE_UNSUPPORTED',
          `抖音号「${handle}」解析不了：抖音的搜索页对后台浏览器是空的（反爬），这条路走不通。两个能用的办法：① 抖音 App →「我」→ 右上角分享 → 复制链接，把主页链接整段粘到「主人抖音」；② 直接填 sec_uid（主页链接里 MS4w 开头那一段）。`,
        );
      }

      const page = await this.getPage();
      if (!(await this.isLoggedIn())) {
        throw new DouyinError('LOGIN_REQUIRED', '抖音还没登录：先点「登录 / 验证」扫一次码');
      }
      // 链接：短链会先跳一次，落到主页地址上再抠
      {
        const url = linkInText;
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
        await page.waitForTimeout(2600);
        const fromUrl = secUidOf(page.url());
        if (fromUrl) {
          const name = await page
            .evaluate(() => (document.querySelector('h1')?.innerText ?? '').trim().split('\n')[0] ?? '')
            .catch(() => '');
          this.scheduleClose(45);
          return { ok: true, secUid: fromUrl, name, source: 'link' };
        }
        throw new DouyinError('NO_SEC_UID', '这个链接里没有抖音主页；把「分享主页」的链接整段粘进来');
      }
    });
  }

  /** 打开某人主页，读昵称和主页上写的抖音号（核对身份用）。 */
  async profileOf(page, secUid) {
    await page.goto(`${ORIGIN}/user/${secUid}`, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    // 主页偶尔要两拍才渲染出昵称；只读一次会把「登录」「抖音」这种占位当成名字
    let last = { douyinId: '', name: '' };
    for (let i = 0; i < 4; i += 1) {
      await page.waitForTimeout(i === 0 ? 2200 : 1300);
      last = await page
        .evaluate(() => {
          const text = (document.body.innerText ?? '').slice(0, 2000);
          const id = text.match(/抖音号[:：]\s*([A-Za-z0-9_.-]{2,40})/)?.[1] ?? '';
          const title = String(document.title || '').replace(/\s*[-–]\s*抖音\s*$/, '').trim();
          const h1 = (document.querySelector('h1')?.innerText ?? '').trim().split('\n')[0] ?? '';
          return { douyinId: id.trim(), name: (h1 || title || '').trim() };
        })
        .catch(() => ({ douyinId: '', name: '' }));
      if (last.name && !/^(登录|未登录|抖音|首页)$/.test(last.name)) break;
    }
    return last;
  }

  /** 只读主人主页的昵称：评论里 @ 人要用昵称，sec_uid 不行。 */
  async ownerProfile(secUid) {
    return this.serialize(async () => {
      const uid = secUidOf(secUid);
      if (!uid) throw new DouyinError('BAD_TARGET', '主人抖音 sec_uid 不对');
      const page = await this.getPage();
      if (!(await this.isLoggedIn())) throw new DouyinError('LOGIN_REQUIRED', '抖音还没登录：先点「登录 / 验证」扫一次码');
      const got = await this.profileOf(page, uid);
      this.scheduleClose(45);
      return { ok: true, secUid: uid, name: got.name || '', douyinId: got.douyinId || '' };
    });
  }

  async feed(limit = 6) {
    return this.serialize(async () => {
      const page = await this.getPage();
      await this.goto(page, `${ORIGIN}/jingxuan`);
      for (let i = 0; i < Math.max(1, Math.ceil(limit / 6)); i++) {
        await page.mouse.wheel(0, 900 + Math.floor(Math.random() * 420));
        await humanPause(1200, 2100);
      }
      const raw = await page.evaluate(feedScript(Math.min(20, Math.max(limit, 6))));
      const items = raw.map((item) => this.mapCard(item));
      this.lastAction = `feed ${items.length}`;
      return this.rank(items).slice(0, limit);
    });
  }

  /** 关注流：读 /follow 页。没登录时返回空数组，由上层给提示。 */
  async following(limit = 6) {
    return this.serialize(async () => {
      const page = await this.getPage();
      await this.goto(page, `${ORIGIN}/follow`);
      if (!(await this.isLoggedIn())) return [];
      for (let i = 0; i < Math.max(1, Math.ceil(limit / 6)); i++) {
        await page.mouse.wheel(0, 900 + Math.floor(Math.random() * 400));
        await humanPause(1200, 2000);
      }
      const raw = await page.evaluate(feedScript(Math.min(20, Math.max(limit, 6))));
      this.scheduleClose(45);
      this.lastAction = `following ${raw.length}`;
      return raw.slice(0, limit).map((item) => ({
        platform: 'douyin',
        kind: 'video',
        id: String(item.id),
        bvid: '',
        title: truncate(item.title, 70),
        author: truncate(item.author, 18),
        authorId: '',
        at: 0,
        url: item.url,
        stat: item.like ? `${item.like} 赞` : '',
        cover: item.cover,
      }));
    });
  }

  mapCard(item) {
    const tags = this.matchTags(`${item.title} ${item.author}`);
    const durSec = this.durationOf(item.duration);
    return {
      id: String(item.id),
      title: truncate(item.title, 48),
      author: truncate(item.author, 16),
      dur: item.duration || formatDuration(durSec),
      durSec,
      stat: `${item.like || '0'}赞`,
      why: tags.length ? `兴趣：${tags.slice(0, 2).join('、')}` : '',
      url: item.url,
      cover: item.cover,
      _score: this.score(item, tags, durSec),
    };
  }

  durationOf(text) {
    const parts = String(text ?? '').split(':').map(Number);
    if (parts.some((n) => !Number.isFinite(n))) return 0;
    return parts.reduce((acc, n) => acc * 60 + n, 0);
  }

  likeCount(text) {
    const s = String(text ?? '');
    const n = parseFloat(s);
    if (!Number.isFinite(n)) return 0;
    if (s.includes('亿')) return n * 100000000;
    if (s.includes('万')) return n * 10000;
    return n;
  }

  matchTags(text) {
    const lower = String(text).toLowerCase();
    return parseKeywords(this.cfg.interests).filter((k) => lower.includes(k.toLowerCase())).slice(0, 3);
  }

  score(item, tags, durSec) {
    let score = Math.log10(this.likeCount(item.like) + 1) * 2;
    score += tags.length * 6;
    const avoid = parseKeywords(this.cfg.avoid);
    const text = `${item.title} ${item.author}`.toLowerCase();
    if (avoid.some((k) => text.includes(k.toLowerCase()))) score -= 100;
    if (this.policy?.store?.seenAt?.(`douyin:open:${item.id}`)) score -= 12;
    if (durSec > 0 && durSec < 20) score -= 2;
    if (durSec > 1800) score -= 2;
    return score;
  }

  rank(items) {
    const seen = new Set();
    return items
      .sort((a, b) => b._score - a._score)
      .filter((item) => {
        if (seen.has(item.author)) return false;
        seen.add(item.author);
        return true;
      });
  }

  async open(idOrUrl, { frames = 0, keep = 90 } = {}) {
    return this.serialize(async () => {
      const id = await this.idOf(idOrUrl);
      if (!id) throw new DouyinError('BAD_ID', '不是有效的抖音视频链接或 ID');
      const page = await this.getPage();
      await this.goto(page, `${ORIGIN}/video/${id}`, 4500);
      const meta = await page.evaluate(metaScript);
      const duration = meta.duration || this.durationOf(meta.duration) || 60;
      const shots = [];
      if (frames > 0) {
        const box = await page.locator('[data-e2e="player-container"]').first().boundingBox().catch(() => null);
        for (let i = 0; i < Math.min(3, frames); i++) {
          const at = Math.max(1, Math.round(duration * ((i + 0.5) / frames)));
          const ok = await page.evaluate(seekScript(at)).catch(() => false);
          await humanPause(900, 1500);
          if (!ok) break;
          const shot = await page
            .screenshot({
              type: 'jpeg',
              quality: 62,
              clip: box ?? { x: 0, y: 0, width: 1280, height: 720 },
            })
            .catch(() => null);
          if (shot) shots.push({ at, mime: 'image/jpeg', bytes: shot });
        }
      }
      this.scheduleClose(keep);
      this.lastAction = `open ${id}`;
      return {
        platform: 'douyin',
        id,
        title: truncate(meta.title, 80),
        author: truncate(meta.author, 20),
        dur: formatDuration(duration),
        stat: (meta.counts ?? []).join(' / '),
        desc: truncate(String(meta.detail ?? '').replace(/\n/g, ' '), 260),
        comments: (meta.comments ?? []).slice(0, 5).map((c) => truncate(c, 90)),
        url: `${ORIGIN}/video/${id}`,
        frames: shots,
        note: shots.length ? '画面已附上' : '没有抽画面；需要时把 frames 设成 1-3。',
      };
    });
  }

  scheduleClose(seconds) {
    // 登录窗开着时不自动关页：扫码可能要好几十秒
    if (this.holdOpen) return;
    // 私信监听开着时也留着：关一次再开要十几秒，那段时间主人说的话就接不住
    if (this.warm) return;
    if (this.closeTimer) clearTimeout(this.closeTimer);
    const delay = (!seconds || seconds <= 0 ? 1.5 : seconds) * 1000;
    this.closeTimer = setTimeout(() => {
      // 还有操作在跑：等它做完再收。中途关页 = 主人看到「网页突然退出」。
      if (this.busy > 0) {
        this.scheduleClose(15);
        return;
      }
      this.closePage().catch(() => {});
    }, delay);
  }

  /** 私信监听期间把聊天页留在后台，别反复冷启动浏览器。 */
  keepWarm(on) {
    this.warm = !!on;
    if (this.warm) {
      // 之前排下的关窗定时器要撤掉，不然 60 秒后照样把页面收走
      if (this.closeTimer) {
        clearTimeout(this.closeTimer);
        this.closeTimer = null;
      }
      return;
    }
    // 关监听时聊天页也收掉：留着只会白占内存
    this.releaseDmPage().catch(() => {});
    this.releaseGroupPage().catch(() => {});
    if (this.page && !this.page.isClosed()) this.scheduleClose(60);
  }

  /* ---------------- 私信「秒知道」：常驻聊天页 + 页面内观察器 ---------------- */

  /** 观察器挂好了没有（world 用它决定还要不要轮询兜底）。 */
  dmArmed() {
    return !!(this.dmPage && !this.dmPage.isClosed() && this.dmThread && this.dmHit);
  }

  /**
   * 开始盯主人的会话：开一个专用 tab 停在 /chat 的那个会话上，挂观察器。
   * 新消息一进 DOM 就回调 onHit(messages)。
   * 只点一次会话（第一次），之后一直是同一个页面——没有反复点击，也就没有 -509。
   */
  async watchDm(name, onHit) {
    const who = String(name ?? '').trim();
    if (!who) return { ok: false, code: 'NO_NAME' };
    this.dmWant = who;
    if (typeof onHit === 'function') this.dmHit = onHit;
    // 已经在盯同一个会话、观察器也还在：什么都不用做
    if (this.dmArmed() && this.dmThread === who) return { ok: true, armed: true, cached: true };
    if (this.dmArming) return this.dmArming;
    this.dmArming = this.armDmPage().finally(() => {
      this.dmArming = null;
    });
    return this.dmArming;
  }

  /** 关掉「是否保存登录信息？」这类浮层——它盖在会话列表上，会把点击吃掉。 */
  async dismissBubbles(page) {
    const gone = await page
      .evaluate(() => {
        const nodes = Array.from(document.querySelectorAll('div, section, aside'));
        const hit = nodes.find((n) => {
          const t = String(n.textContent || '');
          return t.length < 60 && /是否保存登录信息|保存登录信息/.test(t);
        });
        if (!hit) return false;
        const btn = Array.from(hit.querySelectorAll('button, span, div')).find((b) => String(b.textContent || '').trim() === '取消');
        if (btn) {
          btn.click();
          return true;
        }
        hit.remove();
        return true;
      })
      .catch(() => false);
    if (gone) await page.waitForTimeout(300);
    return gone;
  }

  async armDmPage() {
    // 登录窗/一起看开着时别插一脚：那会儿浏览器是有头窗口，突然多一个聊天 tab 很突兀
    if (this.holdOpen) return { ok: false, code: 'BUSY_WINDOW' };
    const headless = this.headless ?? (this.cfg.background !== false);
    const ctx = await this.launch({ headless });
    let page = this.dmPage;
    if (!page || page.isClosed()) {
      if (page) await page.close().catch(() => {});
      page = await ctx.newPage();
      page.setDefaultTimeout(20000);
      this.dmPage = page;
      this.dmThread = '';
      this.dmArmedAt = 0;
      page.on('close', () => {
        if (this.dmPage === page) {
          this.dmPage = null;
          this.dmThread = '';
          this.dmArmedAt = 0;
        }
      });
      // 页面自己刷新（掉线重连、点错链接）后观察器会丢，导航完补挂一次
      page.on('domcontentloaded', () => {
        if (this.dmPage !== page || !this.dmHit || !page.__strollDmBound) return;
        page.evaluate(dmObserverScript).catch(() => {});
      });
      await page.goto(`${ORIGIN}/chat`, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    } else if (!/\/chat/.test(page.url())) {
      await page.goto(`${ORIGIN}/chat`, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      this.dmThread = '';
    }

    // 绑定 Node 侧回调（每个 page 只能绑一次，导航后依然有效）
    if (!page.__strollDmBound) {
      await page
        .exposeFunction('__strollDmSignal', (sig) => this.onDmSignal(sig))
        .then(() => {
          page.__strollDmBound = true;
        })
        .catch(() => {});
    }

    const items = page.locator('[data-e2e="conversation-item"]');
    if (!(await items.first().waitFor({ state: 'attached', timeout: 30000 }).then(() => true).catch(() => false))) {
      // 没列表只有两种可能：没登录，或者页面还在加载
      const loggedIn = await this.isLoggedIn().catch(() => false);
      return { ok: false, code: loggedIn ? 'NO_LIST' : 'LOGIN_REQUIRED' };
    }

    if (this.dmThread !== this.dmWant) {
      const item = page.locator('[data-e2e="conversation-item"]', { hasText: this.dmWant }).first();
      // 列表是先出骨架、再填名字的：只等第一条挂上来不够，得等**这一条**出现名字
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        if (await item.count().catch(() => 0)) break;
        await page.waitForTimeout(350);
      }
      if (!(await item.count().catch(() => 0))) {
        // 顺带把「是否保存登录信息」这类浮层关掉，它们会挡住点击
        await this.dismissBubbles(page);
        return { ok: false, code: 'NO_THREAD' };
      }
      await this.dismissBubbles(page);
      // 会话列表不滚动的话，老会话可能在视口外：先滚进来再点
      await item.scrollIntoViewIfNeeded().catch(() => {});
      await item.click({ timeout: 8000 }).catch(async () => {
        await item.evaluate((el) => el.click()).catch(() => {});
      });
      this.dmThread = this.dmWant;
      this.openThread = this.dmWant;
      const opened = await page
        .locator('[data-e2e="msg-item-content"]')
        .first()
        .waitFor({ state: 'attached', timeout: 10000 })
        .then(() => true)
        .catch(() => false);
      if (!opened) {
        // 点击被浮层吃掉时再点一次
        await this.dismissBubbles(page);
        await item.evaluate((el) => el.click()).catch(() => {});
        await page
          .locator('[data-e2e="msg-item-content"]')
          .first()
          .waitFor({ state: 'attached', timeout: 8000 })
          .catch(() => {});
      }
    }

    const armed = await page.evaluate(dmObserverScript).catch(() => 'failed');
    this.dmArmedAt = Date.now();
    return { ok: armed !== 'failed', armed: armed !== 'failed', thread: this.dmThread, code: armed };
  }

  /**
   * 页面观察器回调。消息列表一变就往这里报，但**不立刻**读：
   * 留 40ms 的合并窗口——一条消息到达时 DOM 会抖好几下（头像、文字、时间各触发一次），
   * 这个窗口把它们合成一次。再往下压容易出现「同一句叫两次」，她就会回两遍。
   */
  onDmSignal(sig) {
    if (!this.dmHit) return;
    this.dmPendingSig = sig;
    if (this.dmSettle) clearTimeout(this.dmSettle);
    this.dmSettle = setTimeout(() => {
      this.dmSettle = null;
      this.onDmSettled().catch(() => {});
    }, 40);
  }

  async onDmSettled() {
    if (!this.dmHit) return;
    if (this.dmSignalBusy) {
      // 上一批还在读：读完再看一眼，不丢
      this.dmSignalQueued = true;
      return;
    }
    this.dmSignalBusy = true;
    try {
      const page = this.dmPage;
      if (!page || page.isClosed()) return;
      const messages = await this.readMessages(page, 8);
      if (!messages.length) return;
      await this.dmHit(messages, { sig: this.dmPendingSig });
    } catch (error) {
      this.log?.warn?.('stroll dm signal failed', { message: error?.message });
    } finally {
      this.dmSignalBusy = false;
      if (this.dmSignalQueued) {
        this.dmSignalQueued = false;
        setTimeout(() => {
          this.onDmSettled().catch(() => {});
        }, 200);
      }
    }
  }

  /** 收掉私信页（关监听、切号、一起看时用）。 */
  async releaseDmPage() {
    const page = this.dmPage;
    this.dmPage = null;
    this.dmThread = '';
    this.dmArmedAt = 0;
    if (this.dmSettle) clearTimeout(this.dmSettle);
    this.dmSettle = null;
    if (page && !page.isClosed()) await page.close().catch(() => {});
  }

  /* ---------------- 群聊：一个群一个常驻 tab ---------------- */

  /** 拿（必要时建）某个群的监听槽。 */
  groupSlot(name) {
    const key = String(name ?? '').trim();
    if (!key) return null;
    let slot = this.groupPages.get(key);
    if (!slot) {
      slot = { page: null, thread: '', hit: null, busy: false, queued: false, settle: null, armedAt: 0, arming: null };
      this.groupPages.set(key, slot);
    }
    return slot;
  }

  /** 这个群现在有人盯着吗（观察器挂着 + 停在群里）。 */
  groupArmed(name) {
    const slot = this.groupPages.get(String(name ?? '').trim());
    return !!(slot?.page && !slot.page.isClosed() && slot.thread && slot.hit);
  }

  /**
   * 盯一个群：开（或复用）一个 tab 停在群会话上，挂同一个观察器。
   * 第一次要点一下会话，之后页面不动——新消息进 DOM 就回调，跟私信一样快。
   */
  async watchGroup(name, onHit) {
    const who = String(name ?? '').trim();
    if (!who) return { ok: false, code: 'NO_NAME' };
    const slot = this.groupSlot(who);
    if (typeof onHit === 'function') slot.hit = onHit;
    if (this.groupArmed(who)) return { ok: true, armed: true, cached: true };
    if (slot.arming) return slot.arming;
    slot.arming = this.armGroupPage(who).finally(() => {
      slot.arming = null;
    });
    return slot.arming;
  }

  async armGroupPage(who) {
    const slot = this.groupSlot(who);
    if (!slot) return { ok: false, code: 'NO_NAME' };
    // 登录窗/一起看开着时别插一脚（那会儿是有头窗口）
    if (this.holdOpen) return { ok: false, code: 'BUSY_WINDOW' };
    const headless = this.headless ?? (this.cfg.background !== false);
    const ctx = await this.launch({ headless });
    let page = slot.page;
    if (page && page.isClosed()) {
      slot.page = null;
      slot.thread = '';
      slot.armedAt = 0;
      page = null;
    }
    if (!page) {
      page = await ctx.newPage();
      page.setDefaultTimeout(20000);
      slot.page = page;
      page.on('close', () => {
        if (slot.page === page) {
          slot.page = null;
          slot.thread = '';
          slot.armedAt = 0;
        }
      });
      page.on('domcontentloaded', () => {
        if (slot.page !== page || !page.__strollGroupBound) return;
        page.evaluate(dmObserverScript).catch(() => {});
      });
      await page.goto(`${ORIGIN}/chat`, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    } else if (!/\/chat/.test(page.url())) {
      await page.goto(`${ORIGIN}/chat`, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      slot.thread = '';
    }

    if (!page.__strollGroupBound) {
      await page
        .exposeFunction('__strollDmSignal', (sig) => this.onGroupSignal(who, sig))
        .then(() => {
          page.__strollGroupBound = true;
        })
        .catch(() => {});
    }

    const items = page.locator('[data-e2e="conversation-item"]');
    const hasList = await items
      .first()
      .waitFor({ state: 'attached', timeout: 30000 })
      .then(() => true)
      .catch(() => false);
    if (!hasList) {
      const loggedIn = await this.isLoggedIn().catch(() => false);
      return { ok: false, code: loggedIn ? 'NO_LIST' : 'LOGIN_REQUIRED' };
    }

    if (slot.thread !== who) {
      const item = page.locator('[data-e2e="conversation-item"]', { hasText: who }).first();
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        if (await item.count().catch(() => 0)) break;
        await page.waitForTimeout(350);
      }
      if (!(await item.count().catch(() => 0))) {
        await this.dismissBubbles(page);
        return { ok: false, code: 'NO_THREAD' };
      }
      await item.scrollIntoViewIfNeeded().catch(() => {});
      await item.click({ timeout: 8000 }).catch(async () => {
        await item.evaluate((el) => el.click()).catch(() => {});
      });
      slot.thread = who;
      // 主页面的「当前会话」跟这个 tab 不是一回事，别互相污染
      this.openThread = '';
      await page
        .locator('[data-e2e="msg-item-content"]')
        .first()
        .waitFor({ state: 'attached', timeout: 12000 })
        .catch(() => {});
    }

    const armed = await page.evaluate(dmObserverScript).catch(() => 'failed');
    slot.armedAt = Date.now();
    return { ok: armed !== 'failed', armed: armed !== 'failed', thread: slot.thread, code: armed };
  }

  /** 群消息观察器回调：和私信一样留 40ms 去抖。 */
  onGroupSignal(name, sig) {
    const slot = this.groupSlot(name);
    if (!slot?.hit) return;
    slot.pendingSig = sig;
    if (slot.settle) clearTimeout(slot.settle);
    slot.settle = setTimeout(() => {
      slot.settle = null;
      this.onGroupSettled(name).catch(() => {});
    }, 40);
  }

  async onGroupSettled(name) {
    const slot = this.groupSlot(name);
    if (!slot?.hit) return;
    if (slot.busy) {
      slot.queued = true;
      return;
    }
    slot.busy = true;
    try {
      const page = slot.page;
      if (!page || page.isClosed()) return;
      const messages = await this.readGroupMessages(page, 10);
      if (!messages.length) return;
      await slot.hit(messages, { sig: slot.pendingSig, group: name });
    } catch (error) {
      this.log?.warn?.('stroll group signal failed', { group: name, message: error?.message });
    } finally {
      slot.busy = false;
      if (slot.queued) {
        slot.queued = false;
        setTimeout(() => {
          this.onGroupSettled(name).catch(() => {});
        }, 200);
      }
    }
  }

  /** 收掉某个群（或全部群）的监听 tab。 */
  async releaseGroupPage(name) {
    const key = String(name ?? '').trim();
    const targets = key ? [key] : Array.from(this.groupPages.keys());
    for (const one of targets) {
      const slot = this.groupPages.get(one);
      if (!slot) continue;
      const page = slot.page;
      if (slot.settle) clearTimeout(slot.settle);
      this.groupPages.delete(one);
      if (page && !page.isClosed()) await page.close().catch(() => {});
    }
  }

  async closePage() {
    if (this.busy > 0) {
      this.scheduleClose(15);
      return;
    }
    // 后台模式用完就整个关掉：只关 page 的话，上下文里那个初始空页还留着，
    // 浏览器进程会常驻；下次要再用时还会跟残留进程抢 profile。
    if (this.context && this.headless !== false) {
      await this.close().catch(() => {});
      return;
    }
    if (this.page && !this.page.isClosed()) await this.page.close().catch(() => {});
    this.page = null;
  }

  async ensureVideo(page, id, { note = false, quick = false } = {}) {
    // 图文（note）从 /video/ 打开会自动重定向到 /note/；反过来也一样，两边都算「已经在看」。
    // 老实现只认 /video/，在 note 页上每次都会误判「没在这个内容」而重新跳转。
    const here = page.url().includes(`/video/${id}`) || page.url().includes(`/note/${id}`);
    if (here) {
      await humanPause(400, 800);
      return;
    }
    // 以前走 goto()：固定睡 2.2-3.6 秒 + 3.8 秒 = 6-7 秒，光等页面就比一次评论还久。
    // 现在等「评论区骨架挂上来」这个真事件，通常 1-2 秒就继续。
    // quick：评论用。评论区本来就还要再等编辑器 hydrate，这里不必先等一遍骨架，省 2 秒。
    this.openThread = '';
    await page.goto(`${ORIGIN}/${note ? 'note' : 'video'}/${id}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await humanPause(quick ? 80 : 450, quick ? 160 : 900);
    if (!quick) {
      await page
        .locator('#comment-input-container, [data-e2e="comment-list"], [data-e2e="feed-comment-icon"], [data-e2e="video-player-digg"]')
        .first()
        .waitFor({ state: 'attached', timeout: 12000 })
        .catch(() => {});
      // quick 模式（发评论）不查页面文本：紧接着的发布接口会直接告诉我们成没成，
      // 真被挡住时接口会返回错误码，比扫一遍整页文案更快也更准。
      await this.checkRisk(page);
    }
    this.lastError = '';
  }

  async like(idOrUrl, on = true) {
    return this.serialize(async () => {
      const id = await this.idOf(idOrUrl);
      if (!id) throw new DouyinError('BAD_ID', '不是有效的抖音视频/图文');
      const page = await this.getPage();
      if (!(await this.isLoggedIn())) throw new DouyinError('LOGIN_REQUIRED', '抖音还没登录，点不了赞');
      await this.ensureVideo(page, id, { note: /\/note\//.test(String(idOrUrl)) });
      const like = page.locator('[data-e2e="video-player-digg"]').first();
      if (!(await like.count())) throw new DouyinError('NO_LIKE', '页面上没找到点赞按钮');
      const readState = async () =>
        (await like.getAttribute('data-e2e-state').catch(() => '')) ||
        (await like.evaluate((el) => el.getAttribute('data-e2e-state') || '').catch(() => ''));
      const before = await readState();
      const liked = this.isDigged(before);
      if (liked === on) return { ok: true, already: true, liked: on, state: before };

      // 抖音桌面版把右侧操作栏做成 hover 才出现；Playwright 的可见性检查会误判，
      // 这里两种点法都试：可见就真点，不可见就走页面内 click（和用户点一下等价）。
      const visible = await like.isVisible().catch(() => false);
      if (visible) {
        await like.click({ timeout: 6000 }).catch(async () => {
          await like.evaluate((el) => el.click());
        });
      } else {
        await like.evaluate((el) => el.click());
      }

      let after = before;
      for (let i = 0; i < 10; i++) {
        await page.waitForTimeout(400);
        after = await readState();
        if (this.isDigged(after) === on) break;
      }
      if (this.isDigged(after) !== on) {
        const f = await bodyFlags(page);
        if (f.risk) {
          this.policy.noteRisk('DOUYIN_VERIFY', '点赞后出现验证');
          throw new DouyinError('RISK', '点赞后出现验证/频繁提示，已停手。');
        }
        if (f.verify) {
          throw new DouyinError('VERIFY_REQUIRED', '抖音要求短信验证：在面板点「登录抖音」开窗手动完成一次。');
        }
        if (f.login) throw new DouyinError('LOGIN_REQUIRED', '抖音登录态失效了，去面板重新扫码');
        throw new DouyinError('NOT_CONFIRMED', `点了，但点赞状态没变（${before} → ${after || '读不到'}）；可能被拦截`);
      }
      this.lastAction = `${on ? 'like' : 'unlike'} ${id}`;
      return { ok: true, liked: on, confirmed: true, state: after };
    });
  }

  async follow(idOrUrl, on = true) {
    return this.serialize(async () => {
      const id = await this.idOf(idOrUrl);
      if (!id) throw new DouyinError('BAD_ID', '不是有效的抖音视频');
      const page = await this.getPage();
      if (!(await this.isLoggedIn())) throw new DouyinError('LOGIN_REQUIRED', '抖音还没登录，关注不了');
      await this.ensureVideo(page, id);
      const buttons = page.getByRole('button', { name: /^(关注|已关注)$/ });
      const count = await buttons.count();
      if (!count) throw new DouyinError('NO_FOLLOW', '页面上没找到关注按钮');
      const button = buttons.first();
      const text = (await button.innerText().catch(() => '')).trim();
      const following = text === '已关注';
      if (following === on) return { ok: true, already: true, following: on };
      await button.click({ timeout: 6000 });
      await humanPause(1500, 2600);
      const after = (await button.innerText().catch(() => '')).trim();
      if ((after === '已关注') !== on) {
        throw new DouyinError('NOT_CONFIRMED', '点了关注，但按钮没变成「已关注」；可能弹了登录/验证');
      }
      this.lastAction = `${on ? 'follow' : 'unfollow'} ${id}`;
      return { ok: true, following: on, confirmed: true };
    });
  }

  isDigged(state) {
    return /digged/i.test(String(state ?? '')) && !/no-digged/i.test(String(state ?? ''));
  }

  async findCommentInput(page) {
    const groups = [
      '[data-e2e="comment-input"] [contenteditable="true"]',
      '[data-e2e="comment-input"]',
      'div[contenteditable="true"][data-e2e*="comment"]',
      'div[contenteditable="true"]',
      'textarea[placeholder*="评论"]',
      'textarea',
    ];
    for (const sel of groups) {
      const loc = page.locator(sel);
      const n = await loc.count().catch(() => 0);
      for (let i = 0; i < n; i++) {
        const item = loc.nth(i);
        if (await item.isVisible().catch(() => false)) return item;
      }
    }
    return null;
  }

  async findSendButton(page) {
    // 评论区没有文字按钮，只有一个粉色的发送图标（#FE2C55）；有字时才亮。
    // 别限定在 #comment-input-container 里：图文（note）页的容器只有 class 没有 id，
    // 而右侧这排按钮的 class commentInput-right-ct 两边是同一个。
    const scope = page.locator('.commentInput-right-ct').first();
    if (await scope.count().catch(() => 0)) {
      const icon = scope.locator('svg path[fill="#FE2C55"]').first();
      if (await icon.count().catch(() => 0)) return icon;
      const lastSpan = scope.locator('span').last();
      if ((await lastSpan.count().catch(() => 0)) && (await lastSpan.isVisible().catch(() => false))) return lastSpan;
    }
    const icon = page.locator('#comment-input-container .commentInput-right-ct svg path[fill="#FE2C55"]').first();
    if (await icon.count().catch(() => 0)) return icon;
    const lastSpan = page.locator('#comment-input-container .commentInput-right-ct span').last();
    if (await lastSpan.count().catch(() => 0)) {
      if (await lastSpan.isVisible().catch(() => false)) return lastSpan;
    }
    const groups = [
      '[data-e2e="comment-send"]',
      'button:has-text("发送")',
      '[role="button"]:has-text("发送")',
      'div:has-text("发送")',
      'span:has-text("发送")',
    ];
    for (const sel of groups) {
      const loc = page.locator(sel);
      const n = await loc.count().catch(() => 0);
      for (let i = n - 1; i >= 0; i--) {
        const item = loc.nth(i);
        const label = (await item.innerText().catch(() => '')).trim();
        if (label && label !== '发送' && !label.endsWith('发送')) continue;
        if (await item.isVisible().catch(() => false)) return item;
      }
    }
    return null;
  }

  /**
   * 评论框的位置（「留下你的精彩评论吧 / 善语结善缘 / 说点什么」那行提示）。
   * 视频页和图文页都用得到：编辑器是惰性的，**必须真的点在这行提示上**才挂载；
   * 点外层容器（#comment-input-container）在视频页上实测无效。
   */
  async commentHint(page) {
    return await page
      .evaluate(() => {
        // 用 textContent 先粗筛：比 innerText 便宜得多，不然一个大页面光这一下就要上百毫秒
        const nodes = Array.from(document.querySelectorAll('div, span, p'));
        const hit = nodes.find((x) => {
          const t = String(x.textContent || '').trim();
          if (!t || t.length > 16) return false;
          if (!/^(留下你的精彩评论吧|善语结善缘|说点什么|发条友善的评论吧?)$/.test(t)) return false;
          const b = x.getBoundingClientRect();
          return b.width > 60 && b.height > 10 && b.y > 0 && b.y < window.innerHeight;
        });
        if (!hit) return null;
        const b = hit.getBoundingClientRect();
        return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      })
      .catch(() => null);
  }

  /** 等评论编辑器挂上来（惰性渲染），比固定睡死更稳也更快。 */
  async waitCommentInput(page, ms = 1500) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const input = await this.findCommentInput(page);
      if (input) return input;
      await page.waitForTimeout(120);
    }
    return null;
  }

  /**
   * 抖音的评论框是惰性的：点在那行「留下你的精彩评论吧」上，Draft.js 编辑器才挂上来。
   * 而且实测视频页要等页面 hydrate 完（4-5 秒）才吃这一下——点早了没反应。
   * 所以这里不设固定 sleep，而是「点一下 → 看编辑器上来没有 → 没有就再点」，谁快谁慢都自适应。
   */
  async openCommentEditor(page) {
    const deadline = Date.now() + 9000;
    let triedIcon = false;
    while (Date.now() < deadline) {
      const hint = await this.commentHint(page);
      if (hint) {
        await page.mouse.click(hint.x, hint.y).catch(() => {});
        const opened = await this.waitCommentInput(page, 900);
        if (opened) return opened;
      } else if (!triedIcon) {
        // 连提示条都没有：多半是评论侧栏还没展开（图文页是这种），点一下评论图标
        triedIcon = true;
        const icon = page.locator('[data-e2e="feed-comment-icon"]').first();
        const r = await icon.boundingBox().catch(() => null);
        if (r) await page.mouse.click(r.x + r.width / 2, r.y + r.height / 2).catch(() => {});
        await page.waitForTimeout(500);
        continue;
      }
      await page.waitForTimeout(250);
    }
    // 兜底：点容器本身（老版本页面还能用）
    const box = page.locator('#comment-input-container').first();
    if (await box.count().catch(() => 0)) {
      await box.click({ force: true, timeout: 4000 }).catch(() => {});
      const opened = await this.waitCommentInput(page, 1500);
      if (opened) return opened;
    }
    return this.findCommentInput(page);
  }

  /** note 页两段式展开评论输入框（先点图标展开侧栏，再点提示条）。 */
  async openCommentEditorViaHint(page) {
    const icon = page.locator('[data-e2e="feed-comment-icon"]').first();
    const r = await icon.boundingBox().catch(() => null);
    if (r) await page.mouse.click(r.x + r.width / 2, r.y + r.height / 2).catch(() => {});
    // 侧栏展开 + 提示条渲染通常 0.6-1.2 秒；以前固定睡 2.2 秒，白白多等一秒
    let hint = await this.commentHint(page);
    const deadline = Date.now() + 3200;
    while (!hint && Date.now() < deadline) {
      await page.waitForTimeout(220);
      hint = await this.commentHint(page);
    }
    if (!hint) return this.findCommentInput(page);
    await page.mouse.click(hint.x, hint.y).catch(() => {});
    return this.waitCommentInput(page, 1800);
  }

  /**
   * 走抖音页面自己的发布接口发评论。
   * 实测（2026-11）：页面内 fetch 不需要额外签名，1 秒内就返回 cid/status；
   * 而走评论框那条要 6-8 秒，其中 5 秒纯粹在等抖音把评论区 hydrate 出来。
   * 只在不带 @ 的时候用：@ 是编辑器插的 chip（text_extra），字段拼错了会变成一条
   * 纯文本「@昵称」——看起来提到了、其实没通知人，还不如慢一点稳。
   * 返回 null 表示「这条路走不通」，调用方退回点评论框。
   */
  async commentViaApi(page, id, text) {
    if (!page || page.isClosed()) return null;
    if (!/douyin\.com/.test(page.url())) return null;
    const r = await page
      .evaluate(
        async ({ awemeId, text }) => {
          const body = new URLSearchParams({
            aweme_id: String(awemeId),
            text,
            text_extra: '[]',
            reply_id: '0',
            reply_to_reply_id: '0',
            is_following: '0',
            aweme_type: '0',
            channel_id: '0',
            city: '',
            sticker_id: '',
            sticker_uri: '',
            text_extra_str: '[]',
          });
          const q = new URLSearchParams({
            device_platform: 'webapp',
            aid: '6383',
            channel: 'channel_pc_web',
            pc_client_type: '1',
            version_code: '190500',
            version_name: '19.5.0',
            cookie_enabled: 'true',
            platform: 'PC',
            downlink: '10',
          });
          const res = await fetch(`https://www.douyin.com/aweme/v1/web/comment/publish/?${q}`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: body.toString(),
          });
          const raw = await res.text();
          let data = null;
          try {
            data = JSON.parse(raw);
          } catch {
            data = null;
          }
          return {
            http: res.status,
            code: data?.status_code ?? -1,
            msg: data?.status_msg ?? '',
            cid: data?.comment?.cid ? String(data.comment.cid) : '',
            status: Number(data?.comment?.status ?? 0),
            extra: Array.isArray(data?.comment?.text_extra) ? data.comment.text_extra : [],
          };
        },
        { awemeId: id, text },
      )
      .catch(() => null);
    if (!r) return null;
    // status_code 8 既可能是「未登录」也可能是参数不对（实测 aweme_id 无效时也是 8），
    // 只有明确说未登录才升级成登录问题，其余一律当作「这条路走不通」，退回点评论框。
    if (!r.cid) {
      if (/未登录|请先登录|login/i.test(String(r.msg ?? ''))) {
        throw new DouyinError('LOGIN_REQUIRED', '抖音登录态失效了，去面板重新扫码再评论');
      }
      return null;
    }
    return r;
  }

  async comment(idOrUrl, text, { mention = '' } = {}) {
    return this.serialize(async () => {
      const id = await this.idOf(idOrUrl);
      if (!id) throw new DouyinError('BAD_ID', '不是有效的抖音视频');
      // 正文里自己写了「@昵称」：真 @ 是编辑器里插的 chip，正文再留一个就成了 @ 两次
      if (mention) {
        const clean = stripAtName(text, mention);
        if (clean) text = clean;
      }
      const page = await this.getPage();
      if (!(await this.isLoggedIn())) throw new DouyinError('LOGIN_REQUIRED', '抖音还没登录，发不了评论');

      // ---- 快路径：不带 @ 直接调发布接口 ----
      // 1 秒出结果，省掉「等评论区 hydrate（约 5 秒）+ 点两下 + 打字 + 等回执」
      // 前提是页面得停在这条视频上：实测从抖音首页调会被 403 挡回来，从 /video/ 页调才通。
      if (!mention) {
        await this.ensureVideo(page, id, { note: /\/note\//.test(String(idOrUrl)), quick: true });
        const fast = await this.commentViaApi(page, id, text).catch((e) => {
          if (e?.code === 'LOGIN_REQUIRED') throw e;
          return null;
        });
        if (fast?.cid) {
          let status = fast.status;
          // 刚提交常是 7（审核中）；按 0.2/0.3/0.6 秒查一次，落定就走
          if (!status || status === 7) {
            for (const wait of [200, 300, 600]) {
              await page.waitForTimeout(wait);
              const st = await this.commentStatus(id, fast.cid).catch(() => null);
              if (st && st.status > 0) {
                status = st.status;
                if (status !== 7) break;
              }
            }
          }
          const statusKnown = status > 0;
          const visible = statusKnown ? status === 1 : null;
          const note = !statusKnown
            ? ''
            : status === 2
              ? '抖音把这条评论压住了：只有她自己看得见，别人看不到（多半是限流/审核）。别重发。'
              : status === 7
                ? '抖音还在审核这条评论，过一会儿才会公开。'
                : '';
          this.lastAction = `comment ${id}`;
          return {
            ok: true,
            confirmed: true,
            queued: false,
            text,
            mentioned: null,
            cid: fast.cid,
            status,
            visible,
            note,
            via: 'api',
            url: `https://www.douyin.com/video/${id}`,
          };
        }
      }

      // ---- 稳路径：真的去点评论框（带 @ 时只能走这条） ----
      // 图文（note）要开 /note/，纯 id 才按视频开（抖音会自动重定向纠正）
      await this.ensureVideo(page, id, { note: /\/note\//.test(String(idOrUrl)), quick: true });
      let input = await this.findCommentInput(page);
      if (!input) input = await this.openCommentEditor(page);
      if (!input) {
        const f = await bodyFlags(page);
        if (f.login) {
          throw new DouyinError('LOGIN_REQUIRED', '抖音登录态失效了，去面板重新扫码再评论');
        }
        throw new DouyinError('NO_INPUT', '没找到评论输入框（页面可能改版，或这条视频关了评论）');
      }
      await input.click({ force: true, timeout: 6000 }).catch(() => {});
      await input.evaluate((el) => el.focus()).catch(() => {});
      await input.fill('').catch(() => {});
      // 先 @ 人再写正文：抖音的 @ 是「插入一个 chip」，必须在打字前提。
      let mentioned = null;
      if (mention) mentioned = await this.mentionInComment(page, input, mention).catch(() => false);
      // contenteditable 用键盘输入更像真人，也更容易触发「发送」按钮变亮。
      // 每个字 22-32ms：一句 20 字从 2 秒压到 0.5 秒，节奏仍然是人手的节奏
      await input.type(text, { delay: 22 + Math.floor(Math.random() * 10) }).catch(async () => {
        await input.pressSequentially(text, { delay: 22 });
      });
      // 以「发送前编辑器里到底有没有 chip」为准：上面那次校验偶尔会被 Draft 的重渲染骗到，
      // 但 chip 在不在是硬事实，别把真 @ 当成没提到。
      if (!mentioned && mention) {
        const inEditor = await page
          .evaluate(() => !!document.querySelector('#comment-input-container .douyin_mention_word'))
          .catch(() => false);
        if (inEditor) mentioned = true;
      }
      // 打字的余韵：让输入事件落定就行，200ms 够抖音把发送按钮点亮（以前 250-450ms）
      await humanPause(120, 220);
      // 抖音发布评论的接口会把「刚发出去的这条」原样返回（cid / status / text_extra），
      // 比翻 DOM 或翻评论列表都准：这一条到底进没进审核、@ 有没有真带上人，看这里就知道。
      const published = page
        .waitForResponse((r) => /\/comment\/publish/.test(r.url()), { timeout: 15000 })
        .then(async (r) => (await r.json().catch(() => null))?.comment ?? null)
        .catch(() => null);
      // @ 候选面板还开着时按回车会「选中候选」而不是发送，先把它关掉
      const atOpen = await page.evaluate(() => !!document.querySelector('.atBox-outside-container')).catch(() => false);
      if (atOpen) await page.keyboard.press('Escape').catch(() => {});
      // Enter 在视频页和图文页的编辑器里都验证过能发；先回车，没发出去（编辑器还留着字）再点发送图标。
      await input.press('Enter').catch(() => {});
      // 轮询「编辑器清空了没有」：正常 250-500ms 就发完了，以前固定等 1.2 秒
      let stillThere = '';
      for (let i = 0; i < 20; i += 1) {
        await page.waitForTimeout(60);
        stillThere = await input.evaluate((el) => (el.innerText || el.value || '').trim()).catch(() => '');
        if (!stillThere) break;
      }
      if (stillThere.length > 0) {
        const send = await this.findSendButton(page);
        if (send) await send.click({ force: true, timeout: 5000 }).catch(() => {});
      }
      // 发布接口的回执通常 300-800ms 就回来；最多等 2.5 秒，不再固定睡 2.4 秒
      const pub = await Promise.race([published, page.waitForTimeout(2500).then(() => null)]);
      const flags = await bodyFlags(page);
      if (flags.verify) {
        throw new DouyinError(
          'VERIFY_REQUIRED',
          '抖音要求短信验证（不是封号）。在面板点「登录抖音」开窗，手动发一条评论并按提示完成验证；之后自动化才能继续。',
        );
      }
      if (flags.risk) {
        this.policy.noteRisk('DOUYIN_VERIFY', '发评论后出现验证');
        throw new DouyinError('RISK', '发评论后出现验证/频繁提示，已停手。');
      }
      const left = await input.evaluate((el) => (el.innerText || el.value || '').trim()).catch(() => '');
      const posted = await page
        .evaluate((t) => {
          const items = Array.from(document.querySelectorAll('[data-e2e="comment-item"]'));
          const mine = items.find((n) => (n.innerText || '').includes(t));
          if (!mine) return null;
          // 发出去之后再看一眼这条里有没有 @ chip，不然「mentioned」只能算编辑框里的推测
          return { chip: !!mine.querySelector('.douyin_mention_word') };
        }, text)
        .catch(() => null);
      const inList = !!posted;
      if (left.length > 0 && !inList) {
        throw new DouyinError('NOT_CONFIRMED', '点了发送，但输入框没清空、评论区也没出现；可能被拦了');
      }
      // 拿到了发布回执就按回执算；没拿到再走「翻评论列表」这条兜底
      let cid = String(pub?.cid ?? '');
      let status = 0;
      let statusKnown = false;
      if (pub) {
        status = Number(pub.status ?? 0);
        statusKnown = status > 0;
        const tags = Array.isArray(pub.text_extra) ? pub.text_extra : [];
        // 回执里的 text_extra 有时是空的（不代表没 @ 到人），空着就别覆盖编辑器的判断
        if (tags.length) mentioned = tags.some((e) => Number(e.type) === 0 && (e.sec_uid || e.user_id));
      }
      let confirmed = inList || !!pub;
      if (!pub) {
        let apiHit = null;
        try {
          const probe = text.replace(/\s+/g, '').slice(0, 12);
          const list = (await this.commentList(id, { pages: 3 })) ?? [];
          apiHit =
            list.find((c) => String(c.text || '').replace(/\s+/g, '').includes(probe)) ??
            list.find((c) => String(c.text || '').replace(/\s+/g, '').includes(text.replace(/\s+/g, '').slice(-12))) ??
            null;
        } catch {
          apiHit = null;
        }
        confirmed = inList || !!apiHit;
        if (apiHit) {
          cid = apiHit.cid;
          status = apiHit.status;
          statusKnown = status > 0;
          const tags = Array.isArray(apiHit.extra) ? apiHit.extra : [];
          if (tags.length) mentioned = tags.some((e) => Number(e.type) === 0 && (e.sec_uid || e.user_id));
        } else if (mentioned === true && posted && posted.chip === false) {
          // 编辑框里插了 chip、发出去却没了：如实说没提到，别让主人白等通知
          mentioned = false;
        }
      }
      // 发完再看一次这条的最终状态：1=公开，2=只有自己看得见，7=还在审核。
      // 发布回执里已经带了非 7 的状态就直接用，不再多查一次（那一次往返 300ms 起）。
      // 还是 7 的，按 0.2/0.3/0.6 秒递进着查，落定就走——原来这一圈最多要 4 秒。
      if (cid && (!statusKnown || status === 7)) {
        let st = null;
        for (const wait of [200, 300, 600]) {
          await page.waitForTimeout(wait);
          st = (await this.commentStatus(id, cid).catch(() => null)) ?? st;
          if (st && st.status > 0 && st.status !== 7) break;
        }
        if (st && st.status > 0) {
          status = st.status;
          statusKnown = true;
          // 这条评论最终形态里的 @ 才是真的：以它为准
          if (Array.isArray(st.extra)) mentioned = st.extra.some((e) => Number(e.type) === 0 && (e.sec_uid || e.user_id));
        }
      }
      const visible = statusKnown ? status === 1 : null;
      const note = !statusKnown
        ? ''
        : status === 2
          ? mentioned
            ? '抖音把这条 @ 评论压住了：只有她自己看得见，别人（包括被 @ 的人）都看不到，也不会有通知。最常见的原因是对方把「谁可以 @ 我」设成了「只有关注的人」，或者这条视频的评论在审核里。别重发，改成私信把链接发过去更稳。'
            : '抖音把这条评论压住了：只有她自己看得见，别人看不到（多半是限流/审核）。别重发。'
          : status === 7
            ? '抖音还在审核这条评论，过一会儿才会公开；这期间被 @ 的人也收不到通知。'
            : '';
      this.lastAction = `comment ${id}`;
      return {
        ok: true,
        confirmed,
        queued: !confirmed,
        text,
        mentioned,
        cid,
        status,
        visible,
        note,
        url: cid ? page.url().split('?')[0] || `https://www.douyin.com/video/${id}` : '',
      };
    });
  }

  /** 按 cid 取单条评论的最终状态（发布接口返回的 status 只是「刚提交」，会变）。 */
  async commentStatus(awemeId, cid) {
    const page = this.page;
    if (!page || !awemeId || !cid) return null;
    return await page
      .evaluate(
        async ({ id, cid }) => {
          const q = new URLSearchParams({
            device_platform: 'webapp',
            aid: '6383',
            channel: 'channel_pc_web',
            aweme_id: String(id),
            cursor: '0',
            count: '10',
            item_type: '0',
            insert_ids: String(cid),
            pc_client_type: '1',
            version_code: '190500',
            version_name: '19.5.0',
            cookie_enabled: 'true',
            platform: 'PC',
            downlink: '10',
          });
          const r = await fetch(`https://www.douyin.com/aweme/v1/web/comment/list/?${q}`, { credentials: 'include' });
          if (!r.ok) return null;
          const d = await r.json().catch(() => null);
          const hit = (d?.comments ?? []).find((c) => String(c.cid) === String(cid));
          if (!hit) return null;
          return {
            status: Number(hit.status ?? 0),
            text: String(hit.text ?? ''),
            extra: Array.isArray(hit.text_extra) ? hit.text_extra.map((e) => ({ type: e.type, sec_uid: e.sec_uid })) : [],
          };
        },
        { id: String(awemeId), cid: String(cid) },
      )
      .catch(() => null);
  }

  /**
   * 抖音评论列表接口。在页面里带 cookie 直接 fetch 就行，不需要 a_bogus 签名（实测 2026-11）。
   * 用来确认「评论到底发出去没有」「@ 有没有真带上人」——DOM 只渲染前几十条，靠不住。
   */
  async commentList(awemeId, { pages = 3 } = {}) {
    const page = this.page;
    if (!page || !awemeId) return null;
    return await page
      .evaluate(
        async ({ id, pages }) => {
          const out = [];
          let cursor = 0;
          for (let i = 0; i < pages; i += 1) {
            const q = new URLSearchParams({
              device_platform: 'webapp',
              aid: '6383',
              channel: 'channel_pc_web',
              aweme_id: String(id),
              cursor: String(cursor),
              count: '50',
              item_type: '0',
              pc_client_type: '1',
              version_code: '190500',
              version_name: '19.5.0',
              cookie_enabled: 'true',
              platform: 'PC',
              downlink: '10',
            });
            const r = await fetch(`https://www.douyin.com/aweme/v1/web/comment/list/?${q}`, { credentials: 'include' });
            if (!r.ok) break;
            const d = await r.json().catch(() => null);
            if (!d || !Array.isArray(d.comments)) break;
            for (const c of d.comments) {
              out.push({
                cid: String(c.cid ?? ''),
                text: String(c.text ?? ''),
                uid: String(c.user?.uid ?? ''),
                nick: String(c.user?.nickname ?? ''),
                create: Number(c.create_time ?? 0),
                digg: Number(c.digg_count ?? 0),
                status: Number(c.status ?? 0),
                extra: Array.isArray(c.text_extra) ? c.text_extra.map((e) => ({ type: e.type, sec_uid: e.sec_uid, user_id: e.user_id })) : [],
              });
            }
            if (!d.has_more || !d.comments.length) break;
            cursor = Number(d.cursor ?? cursor + d.comments.length);
          }
          return out;
        },
        { id: String(awemeId), pages },
      )
      .catch(() => null);
  }

  /**
   * 在评论框里 @ 人。
   * 实测（2026-11）三件事：
   *   1. 候选面板固定是 .atBox-outside-container > .atBox-inner-container，
   *      每项是 .QLIVVPgY（头像 + span.lgAE_oZa 昵称），**按输入的前缀过滤**
   *   2. 只有插成 <span class="douyin_mention_word">（chip）才会真的通知对方，纯文本 @ 不算
   *   3. 面板开着时按回车 = 选中第一个候选；面板没开时按回车 = 直接把评论发出去
   * 所以：敲「@+完整昵称」把候选搜窄 → 精确对上昵称才动手（第一项就回车，否则鼠标点）
   * → 校验 chip。全程没对上就退化成纯文本，**绝不按回车**（否则半句话就被发出去）。
   */
  async mentionInComment(page, input, name) {
    const target = String(name ?? '').trim().replace(/^@+/, '');
    if (!target) return false;
    const flat = target.replace(/\s+/g, '');
    await input.click({ force: true }).catch(() => {});
    await input.evaluate((el) => el.focus()).catch(() => {});
    // 光标移到开头，@ 放最前面（macOS 的 Home 是 Cmd 组合）
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Home' : 'Control+Home').catch(() => {});
    // 一次敲「@昵称」：面板本身就是搜索框，敲全了才不会跟同名的人撞车
    await page.keyboard.type(`@${target}`, { delay: 22 });
    // 候选面板是异步拉的（通常 0.6-1.2 秒），轮询到有人就继续；以前不管快慢都固定睡 2.3 秒
    const deadline = Date.now() + 2600;
    while (Date.now() < deadline) {
      await page.waitForTimeout(100);
      if (await this.findAtCandidate(page, flat)) break;
    }
    await this.liftAtPanel(page);

    let pick = await this.findAtCandidate(page, flat);
    if (pick && pick.needScroll) {
      await page.mouse.wheel(0, pick.needScroll).catch(() => {});
      await page.waitForTimeout(450);
      pick = await this.findAtCandidate(page, flat);
    }
    if (!pick || pick.index < 0 || (!pick.x && !pick.y)) {
      // 没对上人：把刚敲的 @昵称 删干净，别让正文变成「@昵称 正文」
      await this.backspace(page, Array.from(target).length + 1);
      return false;
    }
    if (pick.index === 0) await page.keyboard.press('Enter');
    else await page.mouse.click(pick.x, pick.y);
    // chip 插进去通常是瞬间的，轮询确认，最多等 1.5 秒
    let ok = false;
    for (let i = 0; i < 12; i += 1) {
      await page.waitForTimeout(100);
      ok = await this.hasMentionChip(page, flat);
      if (ok) break;
    }
    if (!ok) {
      // 名字后缀（表情、状态）对不上，但 chip 确实插进去了：也算提到了，别把它清掉
      const anyChip = await page
        .evaluate(() => !!document.querySelector('#comment-input-container .douyin_mention_word'))
        .catch(() => false);
      if (anyChip) return true;
      await this.clearEditor(page);
    }
    return ok;
  }

  /** 编辑器里有没有「就是这个人」的 @ chip。 */
  async hasMentionChip(page, flat) {
    return await page
      .evaluate((want) => {
        const ce = document.querySelector('#comment-input-container div[contenteditable="true"]');
        if (!ce) return false;
        const norm = (s) => String(s ?? '').replace(/[\s\u200B-\u200D\uFEFF]+/g, '').replace(/^@+/, '');
        return Array.from(ce.querySelectorAll('.douyin_mention_word')).some((c) => norm(c.innerText) === want);
      }, flat)
      .catch(() => false);
  }

  async backspace(page, n) {
    for (let i = 0; i < Math.max(0, n); i += 1) {
      await page.keyboard.press('Backspace').catch(() => {});
    }
    await page.waitForTimeout(200);
  }

  async clearEditor(page) {
    const ce = page.locator('#comment-input-container div[contenteditable="true"]').first();
    await ce.click({ force: true }).catch(() => {});
    await page.keyboard.press('Control+a').catch(() => {});
    await page.keyboard.press('Backspace').catch(() => {});
    await page.waitForTimeout(300);
  }

  /** 面板伸出视口时把页面往上滚一点，不然候选点不到。 */
  async liftAtPanel(page) {
    const overflow = await page
      .evaluate(() => {
        const p = document.querySelector('.atBox-outside-container');
        if (!p) return 0;
        const r = p.getBoundingClientRect();
        return Math.max(0, Math.ceil(r.bottom - (window.innerHeight - 24)));
      })
      .catch(() => 0);
    if (overflow > 0) {
      await page.mouse.wheel(0, overflow).catch(() => {});
      await page.waitForTimeout(700);
    }
  }

  /**
   * 在 @ 候选面板里按昵称找人。
   * 返回 { index, x, y, needScroll }：index 是这个人在候选里的序号（0 = 第一个，回车就能选），
   * x/y 是昵称中心的视口坐标；needScroll != 0 表示这个候选在视口外，得先滚一下再取坐标。
   */
  async findAtCandidate(page, flat) {
    return await page
      .evaluate((want) => {
        const norm = (s) => String(s ?? '').replace(/[\s\u200B-\u200D\uFEFF]+/g, '').replace(/^@+/, '');
        const panel = document.querySelector('.atBox-outside-container');
        if (!panel) return null;
        const inner = panel.querySelector('.atBox-inner-container') ?? panel;
        let cells = Array.from(inner.querySelectorAll('.QLIVVPgY'));
        if (!cells.length) cells = Array.from(inner.querySelectorAll('div')).filter((n) => n.querySelector('img, span'));
        const items = cells
          .map((cell) => {
            const label = cell.querySelector('span.lgAE_oZa') ?? cell.querySelector('span');
            return { cell, label, name: norm(label?.innerText || cell.innerText) };
          })
          .filter((x) => x.name);
        if (!items.length) return null;
        let idx = items.findIndex((x) => x.name === norm(want));
        if (idx < 0) {
          // 昵称后面挂了表情/状态后缀也算，但只认唯一一个，避免 @ 错人
          const pref = items.map((x, i) => ({ x, i })).filter(({ x }) => x.name.startsWith(norm(want)));
          if (pref.length === 1) idx = pref[0].i;
        }
        if (idx < 0) return { index: -1, x: 0, y: 0, needScroll: 0 };
        const el = items[idx].label ?? items[idx].cell;
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) return { index: -1, x: 0, y: 0, needScroll: 0 };
        if (r.bottom > window.innerHeight - 4 || r.top < 4) {
          const need = Math.ceil(r.bottom - (window.innerHeight - 48));
          return { index: idx, x: 0, y: 0, needScroll: need > 0 ? need : Math.ceil(r.top - 12) };
        }
        return { index: idx, x: r.x + r.width / 2, y: r.y + r.height / 2, needScroll: 0 };
      }, flat)
      .catch(() => null);
  }

  /**
   * 点一个「文字正好是这个」的可见元素。
   * 抖音主页的「私信」在 DOM 里有两份：一份是隐藏的模板（宽高 0），点它必然超时。
   * 所以不能 getByText().first()，要逐个挑可见的。
   */
  async clickVisibleText(page, text, { limit = 14 } = {}) {
    const nodes = page
      .locator('button, [role="button"], a, span, div')
      .filter({ hasText: new RegExp(`^\\s*${text}\\s*$`) });
    const total = Math.min(await nodes.count().catch(() => 0), limit);
    for (let i = 0; i < total; i += 1) {
      const el = nodes.nth(i);
      if (!(await el.isVisible().catch(() => false))) continue;
      const box = await el.boundingBox().catch(() => null);
      if (!box || box.width < 4 || box.height < 4) continue;
      try {
        await el.scrollIntoViewIfNeeded().catch(() => {});
        await el.click({ timeout: 4000 });
        return true;
      } catch {
        // 换下一个（可能被浮层挡住）
      }
    }
    return false;
  }

  /** 等私信输入框出现（抽屉是异步挂上来的）。 */
  async waitMsgInput(page, ms = 9000) {
    const deadline = Date.now() + ms;
    const loc = page.locator('[data-e2e="msg-input"], div[contenteditable="true"], textarea');
    while (Date.now() < deadline) {
      const n = await loc.count().catch(() => 0);
      for (let i = 0; i < n; i += 1) {
        const el = loc.nth(i);
        if (await el.isVisible().catch(() => false)) return el;
      }
      await page.waitForTimeout(400);
    }
    return null;
  }

  /**
   * 在聊天输入框里插入**真正的 @**（结构化 chip）。
   *
   * 为什么非要做这一步：抖音消息里手打的一个 `@` 会被渲染成蓝色，看起来像 @ 了人，
   * 但它是纯文本——后面不带名字、对方也收不到任何通知。只有从候选面板里选中，
   * 才会插成带 uid 的 chip，才叫真提到。
   *
   * 1.8.1 那次线上还是没成，dump 里能看出来：一口气把「@昵称」全打进去，
   * 候选面板压根没弹出来（列表是空的）。抖音是靠**单独一个 @** 触发面板的，
   * 名字敲太快会把面板顶掉。所以现在：先打一个 @，等名单出来，再从名单里点人。
   * 点完补一个空格——不然正文会贴着名字，看着就像没 @ 上。
   */
  async mentionInChat(page, input, name) {
    const target = String(name ?? '').trim().replace(/^@+/, '');
    if (!target) return false;
    const ed = await this.editorOf(input);
    this.lastMentionDump = '';
    await ed.click({ force: true }).catch(() => {});

    // 等候选名单：群成员是异步拉的，0.3-1.2 秒。
    // 试两次：第一下 @ 偶尔会落在编辑器刚拿到焦点的那一刻被吞掉。
    let rows = null;
    for (let attempt = 0; attempt < 2 && !rows?.count; attempt += 1) {
      // 上一次失败留下的残字会让后面全乱，先清干净
      await this.clearChatInput(page, input);
      await ed.click({ force: true }).catch(() => {});
      await page.waitForTimeout(attempt * 120);
      await page.keyboard.type('@', { delay: 40 });
      const deadline = Date.now() + 1800;
      while (Date.now() < deadline) {
        await page.waitForTimeout(80);
        rows = await this.chatAtItems(page, '');
        if (rows?.count) break;
        if (Date.now() + 450 > deadline) {
          // 面板没落在那个容器里（有些版本走 portal）：最后扫一遍浮层
          rows = await this.chatAtRowsGeneric(page, '');
          if (rows?.count) break;
        }
      }
    }
    if (!rows?.count) {
      this.lastMentionDump = await this.dumpChatDebug(page, 'mention-nopanel', { target });
      await this.clearChatInput(page, input);
      return false;
    }

    // 名单里的名字可能带「群主 / 管理员」标签，剥掉再比；也只认唯一命中，别 @ 错人
    const hit = this.pickAtRow(rows.items, target);
    if (!hit) {
      this.lastMentionDump = await this.dumpChatDebug(page, 'mention-noname', { target, rows });
      await this.clearChatInput(page, input);
      return false;
    }
    // 坐标是上一次 evaluate 拍的，面板重绘后会偏；重新找一次并给那一行打标，用 locator 点
    const tagged = await this.chatAtItems(page, target);
    // 点之前记一份编辑器里的 HTML：点中候选会把它整个换掉，点空则一动不动。
    // 这比猜 chip 的类名可靠得多（抖音的类名是哈希的，改一次版就没了）。
    const htmlBefore = await ed.evaluate((el) => el.innerHTML).catch(() => '');
    const tag = page.locator('[data-stroll-at="1"]').first();
    let clicked = false;
    if (tagged?.index >= 0 && (await tag.count().catch(() => 0))) {
      clicked = await tag
        .click({ timeout: 1500 })
        .then(() => true)
        .catch(() => false);
    }
    if (!clicked) await page.mouse.click(hit.x, hit.y).catch(() => {});

    let ok = false;
    for (let i = 0; i < 12; i += 1) {
      await page.waitForTimeout(60);
      ok = await this.mentionInserted(ed, target, htmlBefore);
      if (ok) break;
    }
    if (!ok) {
      // 名字那一截点不动（有的版本把点击绑在整行上）→ 再试整行
      const rowTag = page.locator('[data-stroll-at-row="1"]').first();
      if ((await rowTag.count().catch(() => 0)) > 0) {
        await rowTag.click({ timeout: 1200 }).catch(() => {});
        for (let i = 0; i < 40; i += 1) {
          await page.waitForTimeout(60);
          ok = await this.mentionInserted(ed, target, htmlBefore);
          if (ok) break;
        }
      }
    }
    if (!ok) {
      // 面板还开着时，回车=选中候选，不会发送
      const open = await this.chatAtItems(page, '');
      if (open?.count) {
        await page.keyboard.press('Enter');
        for (let i = 0; i < 10; i += 1) {
          await page.waitForTimeout(60);
          ok = await this.mentionInserted(ed, target, htmlBefore);
          if (ok) break;
        }
      }
    }
    if (!ok) {
      const chip = await this.hasChatMention(page, input, target);
      this.lastMentionDump = await this.dumpChatDebug(page, 'mention-nochip', { target, rows, chip });
      await this.clearChatInput(page, input);
      return false;
    }
    // chip 后面补一个空格：抖音要靠它把 chip 定下来，正文也不会贴着名字
    await page.keyboard.type(' ', { delay: 20 });
    return true;
  }

  /**
   * 选完候选之后，**编辑器里真的多了这个名字**才算 @ 上了。
   * 判据两条一起：文字里出现了这个名字，而且 HTML 跟点之前不一样（点空的话 HTML 不会变）。
   */
  async mentionInserted(ed, name, htmlBefore) {
    const state = await ed
      .evaluate((el) => ({ text: String(el.textContent ?? ''), html: el.innerHTML }))
      .catch(() => null);
    if (!state) return false;
    const norm = (s) => String(s ?? '').replace(/[\s\u200B-\u200D\uFEFF]+/g, '').replace(/^@+/, '').trim();
    if (!norm(state.text).includes(norm(name))) return false;
    return state.html !== htmlBefore;
  }

  /** 输入框里的可编辑区（有 contenteditable 就用它，没有就退回容器）。 */
  async editorOf(input) {
    const ed = input.locator('[contenteditable="true"], [data-slate-editor="true"], textarea').first();
    if (await ed.count().catch(() => 0)) return ed;
    return input;
  }

  /** 在候选名单里按昵称找人（剥掉群主/管理员这类身份标签，容忍零宽字符）。 */
  pickAtRow(items, name) {
    const norm = (s) => String(s ?? '').replace(/[\s\u200B-\u200D\uFEFF]+/g, '').replace(/^@+/, '').trim();
    const bare = (s) => norm(s).replace(/(群主|管理员|群成员|成员|owner|admin)/gi, '');
    const key = bare(name);
    if (!key) return null;
    const list = (items ?? []).filter((it) => it && it.text);
    let hit = list.find((it) => bare(it.text) === key) ?? null;
    if (!hit) {
      const pref = list.filter((it) => bare(it.text).startsWith(key));
      if (pref.length === 1) hit = pref[0];
    }
    if (!hit) {
      const part = list.filter((it) => bare(it.text).includes(key));
      if (part.length === 1) hit = part[0];
    }
    return hit;
  }

  /** 聊天输入框里有没有「就是这个人」的 @ chip。 */
  async hasChatMention(page, input, want) {
    return await input
      .evaluate((el, name) => {
        const norm = (s) => String(s ?? '').replace(/[\s\u200B-\u200D\uFEFF]+/g, '').replace(/^@+/, '').trim();
        const key = norm(name);
        // textarea 没有 chip 结构，选中候选就是往 value 里写「@昵称 」，只能认文本
        const ed = el.matches?.('[contenteditable="true"]')
          ? el
          : el.querySelector?.('[contenteditable="true"], [data-slate-editor="true"], textarea') || el;
        if (ed.tagName === 'TEXTAREA' || ed.tagName === 'INPUT') return norm(ed.value).includes(key);
        // 手打进去的「@昵称」一定落在 data-string 叶子上；选中候选后这一片会被 chip 替换掉。
        // 所以「叶子还在」= 假 @，「叶子没了、编辑器里还有个正好叫这名字的节点」= chip。
        const leaves = Array.from(ed.querySelectorAll('[data-string], [data-leaf]'));
        const plain = leaves.find((n) => norm(n.textContent) === key);
        if (plain && !plain.closest('[class*="mention"], [data-mention], [data-slate-inline="true"]')) return false;
        const chips = Array.from(ed.querySelectorAll('[class*="mention"], [data-mention], [data-slate-inline="true"]'));
        if (chips.some((n) => norm(n.textContent) === key && n.childElementCount > 0)) return true;
        if (plain) return false;
        return Array.from(ed.querySelectorAll('*')).some((n) => n.childElementCount > 0 && norm(n.textContent) === key);
      }, want)
      .catch(() => false);
  }

  /** 清空聊天输入框（不发送）。选全删一次可能只删掉一层，删完要复查。 */
  async clearChatInput(page, input) {
    const ed = await this.editorOf(input);
    for (let i = 0; i < 3; i += 1) {
      await ed.click({ force: true }).catch(() => {});
      await page.keyboard.press('Control+a').catch(() => {});
      await page.keyboard.press('Backspace').catch(() => {});
      await page.waitForTimeout(70);
      if (!(await this.inputText(page, input))) return true;
    }
    return false;
  }

  /**
   * 读聊天输入框的 @ 候选面板。
   *
   * 线上 dump 里的真实结构（21:22）：
   *   .messageMsgInputmentionContainer        ← 外层，常年挂着，可能是 0 高
   *     .MsgInputMentionmentionContainer      ← 真正撑开的是这层
   *       .MentionMentionItemcontainer        ← 一行候选
   *         .MentionMentionIteminnerContainer（头像 + 「群主」标签）
   *         span.MentionMentionItemuserName   ← 名字
   * 所以**不能拿外层容器的尺寸判断面板开没开**（上一版就死在这儿：
   * 面板明明弹着，外层 0 高，直接 return count 0，回执就成了「没找到选人面板」）。
   * 现在把几层容器里的行全收上来，去重后按文字认人。want 为空 = 只要名单。
   */
  async chatAtItems(page, want) {
    return await page
      .evaluate((name) => {
        const norm = (s) => String(s ?? '').replace(/[\s\u200B-\u200D\uFEFF]+/g, '').replace(/^@+/, '').trim();
        const bare = (s) => norm(s).replace(/(群主|管理员|群成员|成员|owner|admin)/gi, '');
        const panels = Array.from(
          document.querySelectorAll('.atBox-outside-container, [class*="mentionContainer"], [class*="mentionPanel"]'),
        );
        if (!panels.length) return null;
        const hasAvatar = (el) => !!(el && el.querySelector && el.querySelector('img, [class*="avatar"], [class*="Avatar"]'));
        const inPanel = (el) => panels.some((p) => p === el || p.contains(el));
        const txt = (el) => String(el?.innerText ?? el?.textContent ?? '').replace(/\s+/g, ' ').trim();

        let cands = [];
        // ① 首选名字节点：线上是 span.MentionMentionItemuserName，文字就是昵称本身。
        //    比「猜哪一层是整行」稳得多——整行的高度/宽度都随样式变，名字节点不会。
        for (const el of Array.from(document.querySelectorAll('[class*="userName"]'))) {
          if (!inPanel(el)) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 16 || r.height < 10 || r.height > 96) continue;
          const t = txt(el);
          if (!t || t.length > 40) continue;
          // 点名字那一截：它在整行的可点区域里，事件会冒泡到行上
          cands.push({ el, t, r, click: r, avatar: hasAvatar(el.closest('[class*="Itemcontainer"], li, [role="option"]')) });
        }

        // ② 没有名字节点（改版）时退回「像一行候选」的扫描
        if (!cands.length) {
          const seenEl = new Set();
          for (const panel of panels) {
            for (const el of Array.from(panel.querySelectorAll('div, li, a, span'))) {
              if (seenEl.has(el)) continue;
              seenEl.add(el);
              const r = el.getBoundingClientRect();
              if (r.width < 60 || r.height < 18 || r.height > 96) continue;
              const t = txt(el);
              if (!t || t.length > 40) continue;
              const n = el.querySelector('[class*="userName"]');
              const nr = n ? n.getBoundingClientRect() : null;
              cands.push({
                el,
                t,
                r,
                click: nr && nr.width > 0 ? nr : r,
                avatar: hasAvatar(el),
              });
            }
          }
        }
        if (!cands.length) return { count: 0, index: -1, pick: null, items: [] };

        // 同一个名字可能命中好几层（整行 / 行内文字），按文字去重，留最宽的那个当代表
        const byText = new Map();
        for (const c of cands) {
          const k = bare(c.t);
          if (!k) continue;
          const prev = byText.get(k);
          if (!prev || c.r.width > prev.r.width || (c.r.width === prev.r.width && c.avatar && !prev.avatar)) byText.set(k, c);
        }
        let pool = Array.from(byText.values());
        // 有头像的优先当候选行（没头像的可能是分组标题）；一个都没有就不挑
        if (pool.some((x) => x.avatar)) pool = pool.filter((x) => x.avatar);

        const key = bare(name);
        let idx = -1;
        if (key) {
          idx = pool.findIndex((x) => bare(x.t) === key);
          if (idx < 0) {
            const pref = pool.map((x, i) => ({ x, i })).filter(({ x }) => bare(x.t).startsWith(key));
            if (pref.length === 1) idx = pref[0].i;
          }
          if (idx < 0) {
            const part = pool.map((x, i) => ({ x, i })).filter(({ x }) => bare(x.t).includes(key));
            if (part.length === 1) idx = part[0].i;
          }
        }
        const spot = (x) => ({
          x: Math.round(x.click.x + x.click.width / 2),
          y: Math.round(x.click.y + x.click.height / 2),
        });
        for (const el of Array.from(document.querySelectorAll('[data-stroll-at]'))) el.removeAttribute('data-stroll-at');
        for (const el of Array.from(document.querySelectorAll('[data-stroll-at-row]'))) el.removeAttribute('data-stroll-at-row');
        if (idx >= 0 && pool[idx]?.el) {
          pool[idx].el.setAttribute('data-stroll-at', '1');
          // 整行也标一下：名字那一截点不动时，还能改点整行
          const row = pool[idx].el.closest?.('[class*="Itemcontainer"], li, [role="option"]');
          if (row && row !== pool[idx].el) row.setAttribute('data-stroll-at-row', '1');
        }
        return {
          count: pool.length,
          index: idx,
          pick: idx >= 0 ? spot(pool[idx]) : null,
          items: pool.slice(0, 12).map((x) => ({ text: x.t, ...spot(x) })),
        };
      }, want ?? '')
      .catch(() => null);
  }

  /**
   * 兜底：不认类名，直接在输入框附近的浮层里找候选行。
   * 用 textContent 扫（不强制布局），命中了才量尺寸，比满页 innerText 快两个数量级。
   */
  async chatAtRowsGeneric(page, name) {
    return await page
      .evaluate((want) => {
        const norm = (s) => String(s ?? '').replace(/[\s\u200B-\u200D\uFEFF]+/g, '').replace(/^@+/, '').trim();
        const bare = (s) => norm(s).replace(/(群主|管理员|群成员|成员|owner|admin)/gi, '');
        const key = bare(want);
        const ed =
          document.querySelector('[data-e2e="msg-input"] [contenteditable="true"]') ||
          document.querySelector('[data-slate-editor="true"]') ||
          document.querySelector('div[contenteditable="true"]');
        const er = ed ? ed.getBoundingClientRect() : null;
        // 浮层：fixed/absolute、够宽够高、就在输入框上方
        const roots = [];
        const all = document.querySelectorAll('body *');
        for (let i = 0; i < all.length && i < 7000 && roots.length < 8; i += 1) {
          const n = all[i];
          if (ed && (n === ed || ed.contains(n))) continue;
          if (n.closest('[data-e2e="msg-item-content"], [data-e2e="conversation-item"]')) continue;
          const st = getComputedStyle(n);
          if (!/^(fixed|absolute)$/.test(st.position)) continue;
          const r = n.getBoundingClientRect();
          if (r.width < 140 || r.width > 960 || r.height < 40 || r.height > 720) continue;
          if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) < 0.05) continue;
          if (er) {
            if (r.bottom < er.top - 640 || r.top > er.bottom + 40) continue;
            if (r.right < er.left - 80 || r.left > er.right + 80) continue;
          }
          roots.push(n);
        }
        let best = null;
        let scanned = 0;
        for (const root of roots) {
          for (const n of Array.from(root.querySelectorAll('div, li, a, span, p'))) {
            if (++scanned > 1500) break;
            const t = String(n.textContent ?? '').replace(/\s+/g, ' ').trim();
            if (!t || t.length > 40) continue;
            if (key && !bare(t).includes(key)) continue;
            // 只有「子元素自己也能当一行」时才算外壳；名字那一小截不算，
            // 否则「大萌神」这种前面没有身份标签的行会被整行丢掉
            const shell = Array.from(n.children).some((c) => {
              if (String(c.textContent ?? '').replace(/\s+/g, ' ').trim() !== t) return false;
              const cr = c.getBoundingClientRect();
              return cr.width >= 90 && cr.height >= 18;
            });
            if (shell) continue;
            const r = n.getBoundingClientRect();
            if (r.width < 90 || r.width > 760 || r.height < 18 || r.height > 72) continue;
            if (!best || r.height < best.h) best = { el: n, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), h: Math.round(r.height), text: t };
          }
        }
        for (const el of Array.from(document.querySelectorAll('[data-stroll-at]'))) el.removeAttribute('data-stroll-at');
        if (!best) return { count: 0, pick: null, items: [] };
        best.el.setAttribute('data-stroll-at', '1');
        return { count: 1, index: 0, pick: { x: best.x, y: best.y }, items: [{ text: best.text.slice(0, 40), x: best.x, y: best.y }] };
      }, name ?? '')
      .catch(() => null);
  }

  /**
   * 在已经打开的聊天框里把话发出去，并确认真的发出去了。
   * contenteditable 清空后会剩一个零宽字符，trim() 去不掉，所以要自己剥。
   */
  async sendInChat(page, input, text, { mention = '' } = {}) {
    const read = () =>
      input
        .evaluate((el) => String(el.value ?? el.textContent ?? '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim())
        .catch(() => '');
    // 正文里她手打的「@某人」先剥掉：真 @ 由 mention 插 chip，
    // 手打的那个只是普通字符——抖音会染成蓝色，但对方收不到通知，还容易和真 chip 重复成一个。
    let body = String(text ?? '').slice(0, 300);
    if (mention) body = stripAtName(body, mention);
    // 「@你 / @主人」不是昵称，留着也只是一个假 @
    body = stripAtPlaceholder(stripLeadingFakeAt(body));
    await input.click({ timeout: 6000 }).catch(() => {});
    let mentioned = false;
    if (mention) {
      mentioned = await this.mentionInChat(page, input, mention).catch(() => false);
    }
    // 打字快一点：8ms/字 打 20 个字只要 0.16 秒（以前 24ms 要 0.5 秒）。
    // 抖音输入框不看按键节奏，看的是「最后一个输入事件之后有没有变化」，所以还能再快。
    if (body) {
      if (mentioned) {
        // mentionInChat 收尾已经在 chip 后面补了空格，这里直接接正文
        await page.keyboard.type(body, { delay: 8 });
      } else {
        await input.pressSequentially(body, { delay: 8 });
      }
    }
    this.lastMention = mentioned;
    await page.keyboard.press('Enter');
    // 轮询「输入框清空了没有」：正常 200-300ms 就发完了。每 25ms 问一次，
    // 比原来 60ms 平均快 35ms，比死等 1.5 秒快一个数量级。
    let left = '';
    for (let i = 0; i < 24; i += 1) {
      await page.waitForTimeout(25);
      left = await read();
      if (!left) break;
    }
    if (left) {
      // 有些版本回车只是换行，得点发送（发送按钮是个 svg，class 里带 publishBtn / e2e-send-msg-btn）
      const sendBtn = page
        .locator('[data-e2e="msg-send"], .e2e-send-msg-btn, [class*="publishBtn"], button:has-text("发送")')
        .first();
      if ((await sendBtn.count().catch(() => 0)) > 0 && (await sendBtn.isVisible().catch(() => false))) {
        await sendBtn.click({ timeout: 4000 }).catch(() => {});
        for (let i = 0; i < 12; i += 1) {
          await page.waitForTimeout(25);
          left = await read();
          if (!left) break;
        }
      }
    }
    if (left) {
      throw new DouyinError('NOT_SENT', '消息还留在输入框里，没发出去（可能被限流，或对方设置了陌生人限制）');
    }
    const f = await bodyFlags(page);
    if (f.risk) {
      this.policy.noteRisk('DOUYIN_VERIFY', '发私信后出现验证');
      throw new DouyinError('RISK', '发私信后出现验证，已停手。');
    }
    // 记一笔自己刚发出去的话：群里用来兜底区分「我发的」和「别人发的」
    this.noteSent(text);
    return true;
  }

  /* ---------------- 表情面板 / 发图 / 出问题留证 ---------------- */

  /**
   * 抖音的面板结构会变，猜类名迟早失手。失败时把输入框附近真实结构存一份，
   * 下次照着改就行——总比自己脑补 DOM 强。
   */
  async dumpChatDebug(page, tag, extra = {}) {
    try {
      const data = await page.evaluate(() => {
        const cut = (s, n = 3000) => String(s ?? '').slice(0, n);
        const rect = (n) => {
          const r = n.getBoundingClientRect();
          return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
        };
        const input =
          document.querySelector('[data-e2e="msg-input"]') ||
          document.querySelector('div[contenteditable="true"]') ||
          document.querySelector('textarea');
        let scope = input;
        for (let i = 0; i < 4 && scope?.parentElement; i += 1) scope = scope.parentElement;
        // 输入区（带工具栏的那块）：比输入框高、够宽的第一个祖先，专门存一份方便定位图标
        let composer = input;
        for (let i = 0; i < 5 && composer?.parentElement; i += 1) {
          const r = composer.getBoundingClientRect();
          if (r.height >= 80 && r.height <= 340 && r.width >= 400) break;
          composer = composer.parentElement;
        }
        // 全页扫定位元素很贵：限定最多看 8000 个节点，够覆盖聊天区就行
        const floaters = [];
        const all = document.querySelectorAll('body *');
        for (let i = 0; i < all.length && i < 8000 && floaters.length < 40; i += 1) {
          const n = all[i];
          const st = getComputedStyle(n);
          if (!/^(fixed|absolute)$/.test(st.position)) continue;
          const r = n.getBoundingClientRect();
          if (r.width < 120 || r.height < 60 || r.top >= window.innerHeight || r.bottom <= 0) continue;
          floaters.push({
            tag: n.tagName,
            cls: cut(n.className, 140),
            ...rect(n),
            imgs: n.querySelectorAll('img').length,
            text: cut((n.innerText || '').replace(/\s+/g, ' '), 90),
          });
        }
        return {
          input: input ? { tag: input.tagName, cls: cut(input.className, 120), ...rect(input), html: cut(input.outerHTML, 2000) } : null,
          composerHtml: composer ? cut(composer.outerHTML, 14000) : '',
          // @ 面板 / 工具栏单独留一份：下次再失败，一眼就能看出「面板没弹」还是「弹了但结构不认」
          mentionHtml: (() => {
            const m = document.querySelector('[class*="mentionContainer"], [class*="mentionPanel"]');
            return m ? cut(m.outerHTML, 8000) : '';
          })(),
          actionsHtml: (() => {
            const a = input?.querySelector?.('[class*="inputAction"], [class*="InputAction"]');
            return a ? cut(a.outerHTML, 4000) : '';
          })(),
          scopeHtml: scope ? cut(scope.outerHTML, 9000) : '',
          floaters,
          e2e: Array.from(new Set(Array.from(document.querySelectorAll('[data-e2e]')).map((n) => n.getAttribute('data-e2e')))),
          bodyText: cut((document.body.innerText || '').replace(/\s+/g, ' '), 200),
        };
      });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const file = path.join(this.dataDir, 'stroll', 'debug', `chat-${tag}-${stamp}.json`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), url: page.url(), tag, extra, ...data }, null, 1));
      this.lastDebugDump = file;
      this.log?.warn?.(`抖音界面没认出来，结构已存到 ${file}`);
      return file;
    } catch {
      return '';
    }
  }

  async probePanel(page) {
    return await page.evaluate(probeEmojiPanelInPage).catch(() => null);
  }

  async chatToolbar(page, input) {
    return await input.evaluate(toolbarProbeInPage).catch(() => []);
  }

  async msgCount(page) {
    return await page.locator('[data-e2e="msg-item-content"]').count().catch(() => 0);
  }

  /**
   * 消息区的「指纹」：条数 + 末尾几条的文字 + 图的数量。
   * 图片/表情消息不一定带 msg-item-content，只数那个会漏，所以指纹要放宽到 msg-item*。
   */
  async chatSig(page) {
    return await page
      .evaluate(() => {
        const items = Array.from(document.querySelectorAll('[data-e2e^="msg-item"]'));
        let tail = '';
        for (const el of items.slice(0, 3)) {
          tail += `|${String(el.innerText || '').replace(/\s+/g, ' ').slice(0, 30)}#${el.querySelectorAll('img').length}`;
        }
        return `${items.length}#${tail}`;
      })
      .catch(() => '');
  }

  async inputText(page, input) {
    return await input
      .evaluate((el) => String(el.value ?? el.textContent ?? '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim())
      .catch(() => '');
  }

  /**
   * 打开输入框旁边的表情面板：挨个点小图标，谁弹出一片小图就是谁。
   * 不依赖 data-e2e / 类名，抖音换图标也能摸到。
   * 上一次点成功的位置会记下来，下次先点它（省掉一轮试错）。
   */
  async openEmojiPanel(page, input) {
    const already = await this.probePanel(page);
    if (already?.found && already.items?.length >= 4) return { ok: true, panel: already, cached: true };
    const cands = await this.chatToolbar(page, input);
    // 只点「表情」和认不出来的那些：发图会弹系统文件框、发送会发空消息、语音会开始录音
    const safe = cands.filter((c) => c.kind !== 'upload' && c.kind !== 'send' && c.kind !== 'voice');
    const known = this.emojiBtn && this.emojiBtn.page === page ? this.emojiBtn : null;
    const order = safe.length ? safe : known ? [{ ...known, kind: 'other', hint: '' }] : [];
    if (!order.length) {
      const dump = await this.dumpChatDebug(page, 'emoji-toolbar', { cands });
      return { ok: false, code: 'NO_TOOLBAR', error: '输入框旁边没找到表情按钮（抖音可能改版了）', dump };
    }
    for (const c of order.slice(0, 3)) {
      await page.mouse.click(c.x, c.y).catch(() => {});
      await page.waitForTimeout(240);
      const panel = await this.probePanel(page);
      if (panel?.found && panel.items?.length >= 4) {
        this.emojiBtn = { page, x: c.x, y: c.y, cls: c.cls, e2e: c.e2e };
        return { ok: true, panel, clicked: c };
      }
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(60);
    }
    const dump = await this.dumpChatDebug(page, 'emoji-panel', { cands });
    return { ok: false, code: 'NO_EMOJI_PANEL', error: '点了表情按钮，但没有面板弹出来（抖音可能改版了）', dump, cands };
  }

  /** 点面板里的第 i 个表情；点完确认真的发出去了（或至少进了输入框）。 */
  async clickPanelItem(page, input, item) {
    const before = await this.chatSig(page);
    await page.mouse.click(item.x, item.y).catch(() => {});
    let sent = false;
    for (let i = 0; i < 18; i += 1) {
      await page.waitForTimeout(80);
      if ((await this.chatSig(page)) !== before) {
        sent = true;
        break;
      }
    }
    if (sent) return { ok: true, via: 'panel' };
    // 有些表情只是插进输入框（小黄脸就是这样），再回车发出去。
    // 注意面板是 semi-modal：不关掉的话遮罩会挡住输入框，回车根本进不去。
    await this.closeChatModals(page);
    const typed = await this.inputText(page, input);
    if (!typed) return { ok: false, code: 'NOT_SENT', error: '点了表情，但消息没发出去' };
    await input.click({ force: true }).catch(() => {});
    await page.keyboard.press('Enter').catch(() => {});
    for (let i = 0; i < 20; i += 1) {
      await page.waitForTimeout(80);
      if (!(await this.inputText(page, input))) return { ok: true, via: 'panel+enter' };
    }
    return { ok: false, code: 'NOT_SENT', error: '表情插进输入框了，但回车没发出去' };
  }

  /** 按 src 认人：抖音 CDN 的图带签名参数，比对时只看到 `?` 之前。 */
  sameSrc(a, b) {
    const clean = (s) => String(s ?? '').split('?')[0].replace(/^https?:/, '');
    if (!a || !b) return false;
    return clean(a) === clean(b);
  }

  /**
   * 关掉聊天里弹着的浮层。抖音的表情面板、发图确认框都是 semi-modal，
   * Escape 它们**不认**（实测按了也没关），点遮罩最稳。
   */
  async closeChatModals(page) {
    for (let i = 0; i < 3; i += 1) {
      const mask = page.locator('.semi-modal-mask').first();
      if (!(await mask.count().catch(() => 0))) return;
      await mask.click({ position: { x: 6, y: 6 }, timeout: 1200 }).catch(() => {});
      await page.waitForTimeout(120);
    }
  }

  /**
   * 发一张表情：库里记过 src（= 抖音收藏里有的），直接在面板里点它；
   * 不在面板里就把本地文件当图片发上去。
   */
  async sendStickerInChat(page, input, { file = '', src = '', name = '' } = {}) {
    // 有 src 才值得开面板找（开面板要一两秒）；纯本地文件直接走上传
    if (src) {
      const opened = await this.openEmojiPanel(page, input);
      if (opened.ok) {
        const hit = opened.panel.items.find((it) => this.sameSrc(it.src, src));
        if (hit) {
          const r = await this.clickPanelItem(page, input, hit);
          await this.closeChatModals(page);
          if (r.ok) return { ...r, sticker: name };
        }
        // 面板开着会盖住输入区，走上传前先关掉，不然发送按钮点不到
        await this.closeChatModals(page);
      }
    }
    if (file && fs.existsSync(file)) {
      const up = await this.sendChatImage(page, input, file);
      return { ...up, sticker: name };
    }
    return { ok: false, code: 'NO_STICKER', error: '表情面板里没有这张，也没有本地文件可发。' };
  }

  /**
   * 把本地图片当附件发进聊天：点工具按钮 → 接住系统文件选择框 → 等预览 → 发送。
   * 表情包发出去是图片消息，不是「收藏表情」；能点面板时优先走面板。
   */
  async sendChatImage(page, input, filePath) {
    if (!fs.existsSync(filePath)) return { ok: false, code: 'NO_FILE', error: `找不到文件：${filePath}` };
    // 上一轮可能把表情面板留在屏幕上（它是个 semi-modal，会挡住输入区），先关掉
    await this.closeChatModals(page);
    // 最先试输入区里直接挂着的隐藏 input[type=file]：实测抖音的输入栏里一直有两个，
    // 塞文件就走上传，不用点图标、不用接系统文件框（点图标要等 700ms，还可能点空）。
    // 必须在选文件之前记指纹：有的版本 setFiles 当场就把消息发出去了
    const before = await this.chatSig(page);
    if (await this.feedFileInput(page, filePath, input)) {
      return await this.afterImagePicked(page, input, before);
    }
    const cands = await this.chatToolbar(page, input);
    // 已经知道哪个是表情按钮了，就别再去点它（点开面板还要再关，白等一秒）
    const emoji = this.emojiBtn && this.emojiBtn.page === page ? this.emojiBtn : null;
    const near = (c, k) => k && Math.abs(c.x - k.x) <= 8 && Math.abs(c.y - k.y) <= 8;
    const order = cands
      .filter((c) => !near(c, emoji))
      .filter((c) => c.kind !== 'send' && c.kind !== 'voice')
      .sort((a, b) => (a.kind === 'upload' ? -1 : 0) - (b.kind === 'upload' ? -1 : 0) || a.x - b.x);
    if (!order.length) {
      const dump = await this.dumpChatDebug(page, 'image-toolbar', { cands });
      return { ok: false, code: 'NO_TOOLBAR', error: '输入框旁边没找到发图片的按钮', dump };
    }
    for (const c of order) {
      const chooserPromise = page.waitForEvent('filechooser', { timeout: 700 }).catch(() => null);
      await page.mouse.click(c.x, c.y).catch(() => {});
      // 抖音多数版本不弹系统框，只在按钮旁边挂一个隐藏的 input[type=file]。
      // 先给它 120ms 挂上去，找到了就直接喂文件，不用等 filechooser 超时（省半秒）。
      await page.waitForTimeout(120);
      if (await this.feedFileInput(page, filePath, input)) {
        chooserPromise.then((ch) => ch?.setFiles([]).catch(() => {})).catch(() => {});
        return await this.afterImagePicked(page, input, before);
      }
      const chooser = await chooserPromise;
      if (chooser) {
        await chooser.setFiles(filePath).catch(() => {});
        return await this.afterImagePicked(page, input, before);
      }
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(60);
    }
    const dump = await this.dumpChatDebug(page, 'image-upload', { cands });
    return { ok: false, code: 'NO_UPLOAD', error: '没找到发图片的入口（抖音可能改版了）', dump };
  }

  /** 页面里有隐藏的 input[type=file]（accept 是图片）就往里塞文件；塞成功返回 true。 */
  async feedFileInput(page, filePath, scope = null) {
    const roots = [];
    if (scope) {
      const inner = scope.locator('input[type="file"]');
      if ((await inner.count().catch(() => 0)) > 0) roots.push(inner);
    }
    roots.push(page.locator('input[type="file"]'));
    for (const loc of roots) {
      const count = await loc.count().catch(() => 0);
      for (let i = 0; i < count; i += 1) {
        const el = loc.nth(i);
        const accept = String((await el.getAttribute('accept').catch(() => '')) ?? '');
        if (accept && !/image|\.png|\.jpe?g|\.gif|\.webp/i.test(accept)) continue;
        const done = await el.setInputFiles(filePath).then(() => true).catch(() => false);
        if (done) return true;
      }
    }
    return false;
  }

  /**
   * 图选好之后：抖音有时自动发，有时要再点一次「发送」。
   * 判据用 chatSig（图片消息不一定带 msg-item-content，只数那个会漏——实测图片其实已经发出去了，
   * 却因为数不到又按了一次回车，弹「不能发送空白消息」）。
   */
  async afterImagePicked(page, input, before) {
    const changed = async () => (await this.chatSig(page)) !== before;
    /**
     * 抖音选完图会先弹一个确认框：
     *   「发送给 小月月一直在玩, 穹, 大萌神(3)   s_811c597ed5c8.png  118.2 KB   取消   发送（1）」
     * 不点那个「发送」，图就一直挂在预览里——上一版漏了这一步，回执写「图选上了但没确认发出去」，
     * 界面上其实什么都不会出现。所以这里一边等消息变化，一边盯着这个确认框。
     */
    const modalSend = () =>
      page.locator('.semi-modal-wrap button:has-text("发送"), .semi-modal-wrap [role="button"]:has-text("发送")').last();
    let viaModal = false;
    let until = Date.now() + 4000;
    while (Date.now() < until) {
      await page.waitForTimeout(100);
      if (await changed()) return { ok: true, via: viaModal ? 'upload+modal' : 'upload' };
      if (viaModal) continue;
      const btn = modalSend();
      if ((await btn.count().catch(() => 0)) > 0 && (await btn.isVisible().catch(() => false))) {
        await btn.click({ timeout: 3000 }).catch(() => {});
        viaModal = true;
        // 点完「发送」还要等消息真的落地，多给几秒
        until = Date.now() + 5000;
      }
    }
    // 有的版本不弹确认框：图挂在输入区当预览，得再点一下那个红按钮。
    // 预览要时间，先等它出来（没有预览就点发送只会弹「不能发送空白消息」）。
    const preview = async () =>
      await input
        .evaluate((el) => {
          const box = el.closest('[data-e2e="msg-input"]') || el;
          return Array.from(box.querySelectorAll('img')).some((im) => {
            const r = im.getBoundingClientRect();
            return r.width >= 24 && r.height >= 24;
          });
        })
        .catch(() => false);
    let ready = false;
    for (let i = 0; i < 12; i += 1) {
      if (await preview()) {
        ready = true;
        break;
      }
      await page.waitForTimeout(100);
    }
    // 发送按钮是个 svg（class 里带 e2e-send-msg-btn / publishBtn），不是 data-e2e
    const send = page.locator('[data-e2e="msg-send"], .e2e-send-msg-btn, [class*="publishBtn"]').first();
    const typed = await this.inputText(page, input);
    if ((ready || typed) && (await send.count().catch(() => 0)) > 0) {
      await send.click({ timeout: 3000 }).catch(() => {});
      for (let i = 0; i < 40; i += 1) {
        await page.waitForTimeout(100);
        if (await changed()) return { ok: true, via: 'upload+button' };
      }
    }
    // 只有输入框里真有东西才回车：空着回车会弹「不能发送空白消息」
    if (typed) {
      await input.click({ force: true }).catch(() => {});
      await page.keyboard.press('Enter').catch(() => {});
      for (let i = 0; i < 30; i += 1) {
        await page.waitForTimeout(100);
        if (await changed()) return { ok: true, via: 'upload+enter' };
      }
    }
    const dump = await this.dumpChatDebug(page, 'image-send', { before, ready, viaModal });
    return {
      ok: false,
      code: 'NOT_SENT',
      error: viaModal ? '点了确认框的「发送」，但消息没落地（多半被限流）' : '图选上了，但没确认发出去（可能还在上传，或者被限流）',
      dump,
    };
  }

  /** 在页面里把图抓下来：先走 context 的 request（带 cookie），不行再用页内 fetch。 */
  async fetchImageBytes(page, src) {
    const url = String(src ?? '').trim();
    if (!/^https?:/.test(url)) return null;
    try {
      const resp = await page.context().request.get(url, {
        headers: { Referer: `${ORIGIN}/`, Accept: 'image/avif,image/webp,image/*,*/*;q=0.8' },
        timeout: 15000,
      });
      if (resp.ok()) {
        const body = await resp.body();
        if (body?.length) return body;
      }
    } catch {
      // 换页内 fetch
    }
    const b64 = await page
      .evaluate(async (u) => {
        try {
          const r = await fetch(u, { credentials: 'include' });
          if (!r.ok) return '';
          const blob = await r.blob();
          return await new Promise((resolve) => {
            const fr = new FileReader();
            fr.onload = () => resolve(String(fr.result || '').split(',')[1] || '');
            fr.onerror = () => resolve('');
            fr.readAsDataURL(blob);
          });
        } catch {
          return '';
        }
      }, url)
      .catch(() => '');
    if (!b64) return null;
    try {
      return Buffer.from(b64, 'base64');
    } catch {
      return null;
    }
  }

  /**
   * 收藏：把表情面板里现在能看到的那些图存进本地表情库。
   * 这是「收藏抖音表情包」最靠谱的入口——面板里就是她自己账号的收藏 + 官方表情。
   * 面板底下那排 tab 里如果有「收藏 / 我的」，也顺手点进去收一遍。
   */
  async collectStickers(page, input, { limit = 12, source = 'douyin' } = {}) {
    const opened = await this.openEmojiPanel(page, input);
    const max = Math.max(1, Math.min(30, Number(limit) || 12));
    const seen = new Set();
    let saved = 0;
    let dup = 0;
    let failed = 0;
    const names = [];
    const tabs = opened?.panel?.tabs?.map((t) => t.label).filter(Boolean) ?? [];

    const grab = async (items) => {
      for (const it of items) {
        if (saved + dup >= max) return;
        const key = String(it.src ?? '').split('?')[0];
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const buf = await this.fetchImageBytes(page, it.src);
        if (!buf) {
          failed += 1;
          continue;
        }
        const r = this.stickers?.addBuffer?.(buf, {
          source,
          src: it.src,
          name: `表情${(this.stickers?.stats?.().total ?? 0) + 1}`,
        });
        if (r?.ok) {
          if (r.duplicate) dup += 1;
          else {
            saved += 1;
            names.push(r.entry.name);
          }
        } else {
          failed += 1;
        }
      }
    };

    if (opened?.ok) {
      await grab(opened.panel.items);
      // 「收藏 / 我的」那一栏里的才是她自己的表情包，默认那栏往往只是官方小黄脸
      const favTab = (opened.panel.tabs ?? []).find((t) => /收藏|我的|自定义|表情包/.test(String(t.label ?? '')));
      if (favTab && saved + dup < max) {
        await page.mouse.click(favTab.x, favTab.y).catch(() => {});
        await page.waitForTimeout(500);
        const again = await this.probePanel(page);
        if (again?.found && again.items?.length) await grab(again.items);
      }
    }
    // 面板打不开、或者面板是一张雪碧图（抓不到一张张小图）时退一步：
    // 把聊天记录里别人发过的表情/图片收进来——「收藏表情包」本来也是收看到的那张。
    let via = opened?.ok ? 'panel' : '';
    if (!saved && !dup) {
      const fromChat = await page
        .evaluate(() => {
          const out = [];
          for (const el of Array.from(document.querySelectorAll('[data-e2e="msg-item-content"]'))) {
            for (const img of Array.from(el.querySelectorAll('img'))) {
              const r = img.getBoundingClientRect();
              if (r.width < 36 || r.width > 260 || r.height < 36 || r.height > 260) continue;
              const src = img.currentSrc || img.src || '';
              if (/^https?:/.test(src)) out.push(src);
            }
          }
          return out.slice(0, 40);
        })
        .catch(() => []);
      if (fromChat.length) {
        via = 'chat';
        await grab(fromChat.map((src) => ({ src })));
      }
    }
    // 面板是 semi-modal，收完不关会一直挡着输入区
    if (opened?.ok) await this.closeChatModals(page);
    return {
      ok: saved + dup > 0,
      saved,
      duplicate: dup,
      failed,
      via: via || 'none',
      panel: { found: opened?.panel?.items?.length ?? 0, tabs },
      names,
      code: saved + dup > 0 ? undefined : opened?.code,
      dump: opened?.dump,
      error:
        saved + dup > 0
          ? undefined
          : opened?.error ?? '面板和聊天记录里都没抓到图（可能是懒加载还没出图，或者这个会话里还没有表情）',
    };
  }

  /** 记下最近发出去的话（5 分钟内有效，最多 10 条）。 */
  noteSent(text) {
    const t = String(text ?? '').trim();
    if (!t) return;
    const now = Date.now();
    this.recentSent = [{ text: t, at: now }, ...(this.recentSent ?? [])].filter((x) => now - x.at < 5 * 60 * 1000).slice(0, 10);
  }

  /** 这句是不是我 3 分钟内刚发的（群消息里抖音可能不给 isFromMe，兜底用）。 */
  wasJustSent(text) {
    const t = String(text ?? '').trim();
    if (!t) return false;
    const now = Date.now();
    return (this.recentSent ?? []).some((x) => x.text === t && now - x.at < 3 * 60 * 1000);
  }

  async dm(secUid, text) {
    return this.serialize(async () => {
      const uid = secUidOf(secUid);
      if (!uid) {
        throw new DouyinError('BAD_TARGET', '抖音私信需要主人的 sec_uid（MS4w 开头）');
      }
      const page = await this.getPage();
      if (!(await this.isLoggedIn())) throw new DouyinError('LOGIN_REQUIRED', '抖音还没登录，发不了私信');
      try {
        await this.goto(page, `${ORIGIN}/user/${uid}`, 4600);
        const clicked = await this.clickVisibleText(page, '私信');
        if (!clicked) {
          throw new DouyinError(
            'NO_DM',
            '这个主页上没有能点的「私信」：对方关了私信，或者这根本就是你现在登录的号（抖音不能给自己发私信）',
          );
        }
        await page.waitForTimeout(1200);
        const input = await this.waitMsgInput(page, 9000);
        if (!input) {
          throw new DouyinError('NO_INPUT', '点了「私信」但聊天框没弹出来（抖音可能改版了）');
        }
        await this.sendInChat(page, input, text);
        this.lastAction = `dm ${uid}`;
        return { ok: true, sent: true };
      } finally {
        // 失败也要收窗口：以前抛错就直接留着，后台会堆一堆浏览器
        this.scheduleClose(60);
      }
    });
  }

  /**
   * 私信会话列表。地址是 /chat，不是 /user/self——后者只有导航壳，什么都读不到。
   * 注意：不能按 innerText 的行号猜内容。实测卡片是
   *   昵称 / 时间 / 「2小时内在线」     ← 第三行是**在线状态**，不是最后一句
   * 以前的 lines[2] 会把「2小时内在线」当成主人的回复，等于看不见回复。
   * 现在按 className 取：标题、时间、预览（Desc 里非 onlineStatus 的那个）、未读角标。
   */
  async inbox(limit = 6) {
    return this.serialize(async () => {
      const page = await this.getPage();
      if (!(await this.isLoggedIn())) return [];
      await this.goto(page, `${ORIGIN}/chat`, 5200);
      this.openThread = '';
      const rows = await page.evaluate((n) => {
        const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
        const items = Array.from(document.querySelectorAll('[data-e2e="conversation-item"]')).slice(0, n);
        return items.map((el) => {
          const title = el.querySelector('[class*="ConversationItemtitle"]');
          const time = el.querySelector('[class*="ConversationItemTagNextToTitle"]');
          const descs = Array.from(el.querySelectorAll('[class*="ConversationItemDesc"]'));
          const preview = descs.find((d) => !/onlineStatus/i.test(String(d.className)));
          const online = descs.find((d) => /onlineStatus/i.test(String(d.className)));
          const badge = el.querySelector('[class*="unread"], [class*="Unread"]');
          const lines = (el.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean);
          // 昵称优先取第一行：有未读时 title 元素的 class 会连带把时间包进来
          //（实测 innerText = "小月月一直在玩 刚刚"），按 class 取会多一截。
          const name = lines[0] || clean(title?.innerText) || '';
          // 兜底：把标题/时间/在线状态剔掉，剩下的才可能是消息预览
          const junk = new Set([clean(name), clean(time?.innerText), clean(online?.innerText)].filter(Boolean));
          const fallback = lines.find((l) => !junk.has(clean(l))) ?? '';
          const unread = Number(clean(badge?.innerText).replace(/\D/g, '')) || 0;
          let previewText = clean(preview?.innerText) || fallback;
          // 预览里常把未读角标一起算进来（实测「穹 2」），那个 2 不是消息内容
          if (unread > 0) previewText = previewText.replace(new RegExp(`\\s*${unread}$`), '').trim();
          return {
            name,
            timeLabel: clean(time?.innerText) || lines[1] || '',
            preview: previewText,
            online: clean(online?.innerText) || '',
            unread,
          };
        });
      }, limit);
      // 列表只有一行预览，分不清是主人回的还是她自己发的；分享卡在列表里只是「分享[图集]」。
      // 顺手点开最近那个会话（有未读的也算），把最后十几句读出来（谁说的 + 内容 + 链接）。
      const wanted = rows
        .map((r, i) => ({ name: r.name, i }))
        .filter((x) => x.name && (x.i === 0 || rows[x.i].unread > 0))
        .slice(0, 2);
      const threads = {};
      for (const w of wanted) {
        threads[w.i] = await this.readThread(page, w.name, 12).catch(() => []);
      }
      this.scheduleClose(60);
      return rows
        .filter((r) => r.name)
        .map((r, i) => {
          const recent = threads[i] ?? [];
          const last = recent.length ? recent[recent.length - 1] : null;
          const lastFromThem = last ? last.from === 'them' : null;
          // 主人连着发的几句都算「还没回」：只读一条会漏掉前面的话
          let pending = 0;
          for (let k = recent.length - 1; k >= 0; k -= 1) {
            if (recent[k].from !== 'them') break;
            pending += 1;
          }
          const tail = pending ? recent.slice(recent.length - pending) : [];
          const said = tail.map((m) => (m.url ? `${m.text}（${m.url}）` : m.text)).join(' / ');
          // 最新一条是分享卡时，列表预览是「分享[图集]」，用读到的标题补上
          let preview = truncate(r.preview, 120);
          if (last && last.kind !== 'text' && last.kind !== 'image' && last.text) preview = truncate(last.text, 120);
          return {
            kind: 'dm',
            platform: 'douyin',
            type: 'dm',
            id: `dm:douyin:${i}:${r.name}`,
            user: r.name,
            text: preview,
            where: r.unread > 0 ? `${r.unread} 条未读` : '私信',
            unread: r.unread,
            at: approxTime(r.timeLabel, i),
            timeLabel: r.timeLabel,
            online: r.online,
            // 最新一句是谁说的：false = 她发的（对方还没回），true = 主人回的
            lastFromThem,
            pending,
            said,
            lastUrl: last?.url || '',
            recent,
            url: `${ORIGIN}/chat`,
            order: i,
          };
        });
    });
  }

  /**
   * 读当前打开的会话里的消息。
   * 以前只认 MessageItemTextcontainer，于是：
   *   - 分享的图文/视频（MessageItemShareAweme）整条读不到，主人发过来只显示「分享[图集]」
   *   - 图片消息是空文本，被 filter 掉
   * 现在按 [data-e2e="msg-item-content"] 一条一条读：
   *   - 方向看祖先有没有 isFromMe（DOM 自带的，比按左右位置猜稳）
   *   - 内容优先取 React props 上的 parsedContent（原始消息体，分享卡里有 itemId 和标题）
   *   - 读不到再退回 innerText
   * DOM 顺序是「最新在前」，这里翻成时间顺序返回。
   */
  async readMessages(page, size = 12, { group = false, selfName = '' } = {}) {
    return await page
      .evaluate(([n, withSender, self]) => {
        // 「是不是我发的」：抖音把语义拼在块名后面（messageMessageBoxisFromMe /
        // MessageBoxContentisFromMe），用「包含」匹配才对得上。
        const isMine = (el) => !!(el.closest && el.closest('[class*="isFromMe"]'));
        /**
         * 群里要分清是谁说的。实测（2026-11）昵称在 `MessageBoxMessageTitleavatarName`，
         * 而且**只出现在一段连续消息的最上面那条**——也就是 DOM 里最旧的那一条
         * （消息列表是 column-reverse，DOM 首元素是最新的）。其余条目完全不带名字，
         * 所以这里拿不到就返回空串，交给下面「从旧往新继承」那一步补。
         */
        const senderOf = (el) => {
          if (!withSender) return '';
          const row = el.closest('[class*="messageMessageBox"]') || el.parentElement;
          if (!row) return '';
          const cand = row.querySelector(
            '[class*="avatarName"], [class*="nickname"], [class*="Nickname"], [class*="userName"], [class*="UserName"]',
          );
          const t = String(cand?.innerText || '').replace(/\s+/g, ' ').trim();
          // 昵称后面常跟「群主 / 管理员」角色标签，混进 innerText 会变成「小月月群主」
          return Array.from(t.replace(/(群主|管理员|群成员)$/, '')).slice(0, 20).join('');
        };
        const parsedOf = (el) => {
          const key = Object.keys(el).find((k) => k.indexOf('__reactProps$') === 0);
          if (!key) return null;
          const seen = new Set();
          let found = null;
          const walk = (v, d) => {
            if (found || !v || typeof v !== 'object' || d > 8 || seen.has(v)) return;
            seen.add(v);
            if (v.parsedContent && typeof v.parsedContent === 'object') {
              found = v.parsedContent;
              return;
            }
            for (const k of Object.keys(v)) {
              if (k === '_owner' || k === 'ref' || k === 'return' || k === 'stateNode') continue;
              walk(v[k], d + 1);
              if (found) return;
            }
          };
          try {
            walk(el[key], 0);
          } catch {
            // props 里有循环引用就算了，退回 innerText
          }
          return found;
        };
        const urlIn = (t) => {
          const m = String(t || '').match(/https?:\/\/[^\s，。！？、"'）】]+/);
          return m ? m[0] : '';
        };
        // 按「字」截断：直接 slice 会把 emoji 的代理对切成半个，JSON 里就成 \ud83d
        const cut = (s, n) => {
          const t = String(s || '').replace(/\s+/g, ' ').trim();
          const arr = Array.from(t);
          return arr.length > n ? `${arr.slice(0, n).join('')}…` : t;
        };
        const rows = Array.from(document.querySelectorAll('[data-e2e="msg-item-content"]'));
        const out = [];
        for (const el of rows) {
          const p = parsedOf(el) || {};
          const raw = (el.innerText || '').replace(/\s+/g, ' ').trim();
          const imgs = el.querySelectorAll('img').length;
          let kind = 'text';
          let text = '';
          let url = '';
          let title = '';
          let author = '';
          if (p.itemId) {
            // 分享的视频 / 图文。image_count > 1 是图集，规范地址是 /note/
            const photos = Number(p.image_count || 0) > 1 || Number(p.awemeType) === 68;
            kind = 'share';
            author = cut(p.content_name, 30);
            title = cut(p.content_title, 80);
            url = `https://www.douyin.com/${photos ? 'note' : 'video'}/${p.itemId}`;
            text = `[分享${photos ? '图集' : '视频'}${author ? `·${author}` : ''}]${title ? ` ${title}` : ''}`;
          } else if (p.secUID && (p.name || p.desc)) {
            // 名片分享（把某人的主页发过来）
            kind = 'card';
            author = cut(p.name || p.desc, 30);
            url = `https://www.douyin.com/user/${p.secUID}`;
            text = `[分享了 ${author || '某人的主页'}]`;
          } else if (p.text) {
            text = cut(p.text, 200);
            url = urlIn(text);
          } else if (raw) {
            text = cut(raw, 200);
            url = urlIn(raw);
          } else if (imgs) {
            // 大表情 / 贴纸也走 img，但 props 里有 emoji_type / package_id 这些标记
            const isEmoji = !!(p.emoji_type || p.image_type || p.package_id || p.resource_type);
            kind = isEmoji ? 'emoji' : 'image';
            text = isEmoji ? '[表情]' : `[图片${imgs > 1 ? `×${imgs}` : ''}]`;
          } else {
            continue;
          }
          if (!text) continue;
          // 群里抖音不一定给 isFromMe：昵称和自己一样也算「我发的」，
          // 免得把自己刚说的话当成别人说的、回头又回一遍。
          const nick = isMine(el) ? '' : senderOf(el);
          const mine = isMine(el) || (!!self && !!nick && nick === self);
          out.push({
            from: mine ? 'me' : 'them',
            kind,
            text: cut(text, 220),
            url,
            title,
            author,
            // 先记下「这一条自己带没带名字」，没带的由下面统一继承
            who: mine ? '' : nick,
          });
        }
        // DOM 是最新在前，倒过来就是时间顺序
        const ordered = out.slice(0, n).reverse();
        // 群里的昵称只标在一段连续消息的**最旧那条**上，所以从旧往新走，
        // 没名字的就沿用上一个说话的人。切了人（新的一段）自然会重新赋值。
        let lastWho = '';
        for (const m of ordered) {
          if (m.from === 'me') {
            lastWho = '';
            continue;
          }
          if (m.who) lastWho = m.who;
          else if (lastWho) m.who = lastWho;
        }
        return ordered;
      }, [size, group, selfName])
      .catch(() => []);
  }

  /**
   * 群消息读取：先走和私信同一条路（`msg-item-content`）。
   * 群里有系统提示、版本差异的气泡没有这个标记，读不到就退回按消息列表的行来解析。
   * 群里还要分清是谁说的，所以多带一个 who（拿不到就是空串，调用方自己兜底成「有人」）。
   */
  async readGroupMessages(page, size = 10) {
    const selfName = await this.selfNickname().catch(() => '');
    const base = await this.readMessages(page, size, { group: true, selfName });
    const rows = base.length ? base : await this.readGroupRows(page, size);
    // 最后一层兜底：刚发出去的那几句，如果抖音既没给 isFromMe 也没给昵称，
    // 就按「我发的」算——不然她会把自己刚说的话当成别人说的，回头再回一遍。
    return rows.map((m) => (m.from === 'them' && this.wasJustSent(m.text) ? { ...m, from: 'me', who: '' } : m));
  }

  /** 群里没有 `msg-item-content` 标记时的退路：直接按消息列表的行解析。 */
  async readGroupRows(page, size = 10) {
    return await page
      .evaluate((n) => {
        const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
        const cut = (s, len) => {
          const a = Array.from(clean(s));
          return a.length > len ? `${a.slice(0, len).join('')}…` : a.join('');
        };
        const list = document.querySelector('[class*="messageMessageListlist"]');
        if (!list) return [];
        const rows = Array.from(list.children).slice(-n);
        const out = [];
        for (const row of rows) {
          const rowCls = String(row.className || '');
          const head = String(row.innerHTML || '').slice(0, 120);
          // 系统提示（「邀请你加入了群聊」）和时间分隔不是人说的话，跳过
          if (/GroupNotice|TimeLayout|SystemTip/.test(rowCls) || /GroupNotice/.test(head)) continue;
          const box = row.querySelector('[class*="messageMessageBox"]') || row;
          const me = /isFromMe/.test(String(box.className || ''));
          const content =
            box.querySelector('[data-e2e="msg-item-content"]') || box.querySelector('[class*="MessageBoxContent"]') || box;
          const text = cut(content.innerText, 200);
          if (!text) continue;
          const nickEl = box.querySelector('[class*="avatarName"], [class*="nickname"], [class*="Nickname"], [class*="userName"]');
          out.push({
            from: me ? 'me' : 'them',
            kind: content.querySelector('img') ? 'image' : 'text',
            text,
            url: '',
            title: '',
            author: '',
            who: me ? '' : cut(nickEl?.innerText, 20),
          });
        }
        return out;
      }, size)
      .catch(() => []);
  }

  /** 点开某个会话并读消息。已经在这个会话里就不重复点。 */
  async readThread(page, name, size = 12) {
    const who = String(name ?? '').trim();
    if (!who) return [];
    if (this.openThread !== who || !(await page.evaluate(() => document.querySelectorAll('[data-e2e="msg-item-content"]').length).catch(() => 0))) {
      const item = page.locator('[data-e2e="conversation-item"]', { hasText: who }).first();
      if (!(await item.count().catch(() => 0))) return [];
      await item.click({ timeout: 6000 }).catch(() => {});
      this.openThread = who;
      await page.waitForTimeout(2400);
    }
    let msgs = await this.readMessages(page, size);
    if (!msgs.length) {
      // 虚拟列表偶尔要等一拍才挂上来
      await page.waitForTimeout(1600);
      msgs = await this.readMessages(page, size);
    }
    return msgs;
  }

  /** 读某个会话，返回末尾几条（时间顺序）。 */
  async readLatestThread(page, name, size = 12) {
    const msgs = await this.readThread(page, name, size);
    this.scheduleClose(60);
    return msgs;
  }

  /**
   * 列出现在有哪些会话（零点击、不跳转会话）。
   * 抖音网页版把群和私信放在同一个列表里，也没有可靠的「这是群」标记，
   * 所以这里如实返回名字 + 预览 + 未读，由调用方按名字认群。
   */
  async listThreads() {
    return this.serialize(async () => {
      const page = await this.getPage();
      if (!(await this.isLoggedIn())) throw new DouyinError('LOGIN_REQUIRED', '抖音还没登录，看不了会话列表');
      if (!/\/chat/.test(page.url())) await this.goto(page, `${ORIGIN}/chat`, 2600);
      await this.dismissBubbles(page);
      const rows = await page
        .evaluate(() => {
          const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
          /**
           * 私信会话的 React props 里有 `toParticipantSecUserId`（对方 sec_uid），
           * 群会话这个字段是空串（实测 2026-11）。比「名字里有没有逗号」可靠得多：
           * 群没起名时抖音会把成员名拼起来，但起了名的群就不带逗号了。
           * 拿不到 props 时退回名字启发式。
           */
          const conversationMeta = (el) => {
            const key =
              Object.keys(el).find((k) => k.indexOf('__reactProps$') === 0) ||
              Object.keys(el).find((k) => k.indexOf('__reactFiber$') === 0);
            if (!key) return null;
            const seen = new Set();
            let out = null;
            const walk = (v, d) => {
              if (out || !v || typeof v !== 'object' || d > 8 || seen.has(v)) return;
              seen.add(v);
              if (Object.prototype.hasOwnProperty.call(v, 'toParticipantSecUserId')) {
                out = { secUid: String(v.toParticipantSecUserId ?? ''), sortOrder: Number(v.sortOrder ?? 0) };
                return;
              }
              for (const k of Object.keys(v)) {
                if (k === '_owner' || k === 'ref' || k === 'return' || k === 'stateNode' || k === 'child' || k === 'sibling') continue;
                walk(v[k], d + 1);
                if (out) return;
              }
            };
            try {
              walk(el[key], 0);
            } catch {
              // props 里有循环引用就算没有
            }
            return out;
          };
          return Array.from(document.querySelectorAll('[data-e2e="conversation-item"]'))
            .slice(0, 30)
            .map((el) => {
              const lines = (el.innerText || '').split('\n').map(clean).filter(Boolean);
              const badge = el.querySelector('[class*="unread"], [class*="Unread"]');
              const unread = Number(clean(badge?.innerText).replace(/\D/g, '')) || 0;
              const meta = conversationMeta(el);
              const name = lines[0] || '';
              const isGroup = meta ? meta.secUid === '' : /,\s/.test(name);
              return {
                name,
                preview: lines.slice(1).join(' ').slice(0, 60),
                unread,
                kind: isGroup ? 'group' : 'dm',
                secUid: meta?.secUid || '',
                lastAt: meta?.sortOrder || 0,
              };
            })
            .filter((x) => x.name);
        })
        .catch(() => []);
      this.scheduleClose(60);
      return { ok: true, threads: rows };
    });
  }

  /**
   * 点群邀请链接进群。
   * 抖音没有「搜群号加入」这条路，只能被邀请或者点别人的邀请链接，
   * 所以这里只做三件事：打开链接、找到「加入群聊」、点它。
   */
  async joinGroup(url) {
    const link = String(url ?? '').trim();
    if (!/^https?:\/\//i.test(link)) throw new DouyinError('BAD_LINK', '要一个 http/https 的群邀请链接');
    return this.serialize(async () => {
      const page = await this.getPage();
      if (!(await this.isLoggedIn())) throw new DouyinError('LOGIN_REQUIRED', '抖音还没登录，进不了群');
      await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      await humanPause(1400, 2200);
      const clicked = await page
        .evaluate(() => {
          const nodes = Array.from(document.querySelectorAll('button, div, span, a'));
          const hit = nodes.find((n) => {
            const t = String(n.textContent || '').replace(/\s+/g, '');
            if (!/^(加入群聊|加入该群|立即加入|加入)$/.test(t)) return false;
            const r = n.getBoundingClientRect();
            return r.width > 40 && r.height > 20;
          });
          if (!hit) return false;
          hit.click();
          return true;
        })
        .catch(() => false);
      if (!clicked) return { ok: false, code: 'NO_JOIN_BUTTON', url: page.url() };
      await humanPause(1200, 2000);
      const body = await page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 200)).catch(() => '');
      return { ok: true, joined: /已加入|进群|群聊/.test(body), url: page.url() };
    });
  }

  /**
   * 只读看一眼某个会话的最后几条，专门给「主人发私信就马上回」的监听用。
   * 不排自动关窗：页面热着的时候读一次只要几十毫秒，关了再开要多等八秒。
   *
   * 轻量化（2026-11）：频繁点开会话正是被 -509 限流的原因之一。所以先读会话列表里
   * 那行预览（零点击），预览和上次一样就返回缓存的消息，变了才点开读全文。
   */
  async peekThread(name, size = 8) {
    const who = String(name ?? '').trim();
    if (!who) return { ok: false, code: 'NO_NAME', messages: [] };
    // 私信页正停在主人这个会话上：直接读它。零点击、零导航，实测几十毫秒。
    // 这一步不走 serialize 队列——队列里可能正排着一次十几秒的评论，主人的话不该等它。
    const dm = this.dmPage;
    if (dm && !dm.isClosed() && this.dmThread === who) {
      const live = await this.readMessages(dm, size).catch(() => []);
      if (live.length) return { ok: true, messages: live, live: true };
    }
    return this.serialize(async () => {
      const page = await this.getPage();
      if (!(await this.isLoggedIn().catch(() => false))) return { ok: false, code: 'LOGIN_REQUIRED', messages: [] };
      if (!/\/chat/.test(page.url())) {
        await this.goto(page, `${ORIGIN}/chat`, 4200);
        // 重新进来以后右侧默认是哪个会话不一定，别拿旧名字骗自己
        this.openThread = '';
      }
      let count = await page.locator('[data-e2e="conversation-item"]').count().catch(() => 0);
      if (!count) {
        // 页面被别的操作带走了、或者列表没加载出来：重新开一次
        await page.goto(`${ORIGIN}/chat`, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
        this.openThread = '';
        await page.waitForTimeout(4600);
        count = await page.locator('[data-e2e="conversation-item"]').count().catch(() => 0);
      }
      if (!count) return { ok: false, code: 'NO_LIST', messages: [] };

      // 预览行就是最新一条消息：它没变，会话里就没新话，不必点开
      const row = await this.readRow(page, who).catch(() => null);
      const cache = this.peekCache;
      if (row && cache && cache.name === who && cache.preview === row.preview && cache.messages?.length) {
        return { ok: true, messages: cache.messages, cached: true };
      }
      const messages = await this.readThread(page, who, size).catch(() => []);
      if (row) this.peekCache = { name: who, preview: row.preview, messages };
      return { ok: true, messages };
    });
  }

  /** 读会话列表里某个人那一行（零点击）：预览文本 + 未读数。 */  async readRow(page, want) {
    return await page
      .evaluate((name) => {
        const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
        const items = Array.from(document.querySelectorAll('[data-e2e="conversation-item"]'));
        const el = items.find((x) => (x.innerText || '').split('\n')[0]?.trim() === name);
        if (!el) return null;
        const descs = Array.from(el.querySelectorAll('[class*="ConversationItemDesc"]'));
        const preview = descs.find((d) => !/onlineStatus/i.test(String(d.className)));
        const badge = el.querySelector('[class*="unread"], [class*="Unread"]');
        const unread = Number(clean(badge?.innerText).replace(/\D/g, '')) || 0;
        let previewText = clean(preview?.innerText);
        if (unread > 0) previewText = previewText.replace(new RegExp(`\\s*${unread}$`), '').trim();
        return { preview: previewText, unread };
      }, String(want ?? '').trim())
      .catch(() => null);
  }

  /** 在抖音聊天页回一条私信：按昵称找到会话，点进去输入。 */
  /**
   * 在聊天页发一条。mention 是「要真的 @ 到的昵称」（群里才有意义）：
   * 传了就会先从候选面板插一个真 chip，再写正文。
   */
  async replyDm(name, text, { mention = '' } = {}) {
    const who = String(name ?? '').trim();
    if (!who) throw new DouyinError('BAD_TARGET', '没有会话昵称，回不了');
    // 私信页正停在这个会话上：不用跳转、不用点会话，直接打字回车。
    // 这是「秒回」的关键一段——省掉整页导航（6-8 秒）和点会话后的固定停顿（2.4 秒）。
    const dm = this.dmPage;
    if (dm && !dm.isClosed() && this.dmThread === who) {
      const input = await this.waitMsgInput(dm, 3000).catch(() => null);
      if (input) {
        await this.sendInChat(dm, input, text, { mention });
        this.lastAction = `dm ${who}`;
        return { ok: true, sent: true, fast: true, mentioned: mention ? !!this.lastMention : null, mentionDebug: this.lastMention ? '' : this.lastMentionDump || '' };
      }
    }
    // 群：那个群的监听页正停在群里，同样可以直接在那页打字（零跳转）
    const slot = this.groupPages?.get?.(who);
    if (slot?.page && !slot.page.isClosed() && slot.thread === who) {
      const input = await this.waitMsgInput(slot.page, 3000).catch(() => null);
      if (input) {
        await this.sendInChat(slot.page, input, text, { mention });
        this.lastAction = `group ${who}`;
        return { ok: true, sent: true, fast: true, group: true, mentioned: mention ? !!this.lastMention : null, mentionDebug: this.lastMention ? '' : this.lastMentionDump || '' };
      }
    }
    return this.serialize(async () => {
      const page = await this.getPage();
      if (!(await this.isLoggedIn())) throw new DouyinError('LOGIN_REQUIRED', '抖音还没登录，发不了私信');
      try {
        // 已经在这个会话里就直接用：省一次整页跳转和点击，回私信快好几秒
        if (this.openThread !== who || !/\/chat/.test(page.url())) {
          if (!/\/chat/.test(page.url())) await this.goto(page, `${ORIGIN}/chat`, 5200);
          const ok = await this.clickThread(page, who);
          if (!ok) throw new DouyinError('NO_DM', '聊天列表里找不到这个会话，可能被新消息刷下去了');
          this.openThread = who;
          // 点完不用干等两秒：下面 waitMsgInput 会一轮一轮等到输入框真的能打字
          await page.waitForTimeout(200);
        }
        const input = await this.waitMsgInput(page, 6000);
        if (!input) throw new DouyinError('NO_INPUT', '没找到输入框，抖音可能改版了');
        await this.sendInChat(page, input, text, { mention });
        this.lastAction = `dm ${who}`;
        return { ok: true, sent: true, mentioned: mention ? !!this.lastMention : null, mentionDebug: this.lastMention ? '' : this.lastMentionDump || '' };
      } finally {
        this.scheduleClose(60);
      }
    });
  }

  /**
   * 点开会话列表里的某个人/某个群。
   * 不能用 hasText 直接点：群名常常是「主人名, 另一个人, 再一个」，按子串找会
   * 把发给主人的私信点成群聊。先按标题整串相等找，再退回包含。
   */
  async clickThread(page, name) {
    const want = String(name ?? '').trim();
    if (!want) return false;
    const box = await page
      .evaluate((target) => {
        const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
        const items = Array.from(document.querySelectorAll('[data-e2e="conversation-item"]'));
        const titleOf = (el) => {
          const t = el.querySelector('[class*="ConversationItemtitle"]');
          const line = String((el.innerText || '').split('\n')[0] || '');
          return norm(t?.innerText || line);
        };
        let hit = items.find((el) => titleOf(el) === norm(target));
        if (!hit) {
          // 群名可能被截断（列表里显示不全），这时才用包含
          const partial = items.filter((el) => titleOf(el).includes(norm(target)));
          if (partial.length === 1) hit = partial[0];
        }
        if (!hit) return null;
        hit.scrollIntoView({ block: 'nearest' });
        const r = hit.getBoundingClientRect();
        if (r.width < 10 || r.height < 10) return null;
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      }, want)
      .catch(() => null);
    if (!box) return false;
    await page.mouse.click(box.x, box.y).catch(() => {});
    return true;
  }

  /**
   * 找一页停在某个会话上的聊天页：群的监听页优先，其次私信页，都没有就自己开一页点进去。
   * 返回 { page, input, group, fast }。
   */
  async chatPageOf(who) {
    const name = String(who ?? '').trim();
    const slot = name ? this.groupPages?.get?.(name) : null;
    if (slot?.page && !slot.page.isClosed() && slot.thread === name) {
      const input = await this.waitMsgInput(slot.page, 2500).catch(() => null);
      if (input) return { page: slot.page, input, group: true, fast: true };
    }
    if (this.dmPage && !this.dmPage.isClosed() && (!name || this.dmThread === name)) {
      const input = await this.waitMsgInput(this.dmPage, 2500).catch(() => null);
      if (input) return { page: this.dmPage, input, fast: true };
    }
    return await this.serialize(async () => {
      const page = await this.getPage();
      if (!(await this.isLoggedIn())) throw new DouyinError('LOGIN_REQUIRED', '抖音还没登录');
      const opened = await (async () => {
        if (!/\/chat/.test(page.url())) await this.goto(page, `${ORIGIN}/chat`, 5200);
        if (name && this.openThread !== name) {
          const ok = await this.clickThread(page, name);
          if (!ok) throw new DouyinError('NO_DM', '聊天列表里找不到这个会话');
          this.openThread = name;
          await page.waitForTimeout(200);
        }
        const input = await this.waitMsgInput(page, 6000);
        if (!input) throw new DouyinError('NO_INPUT', '没找到输入框，抖音可能改版了');
        return { page, input, fast: false };
      })();
      return opened;
    });
  }

  /** 发一张表情到某个会话（群名 / 昵称 / 留空 = 当前会话）。 */
  async sendStickerTo(who, { file = '', src = '', label = '' } = {}) {
    const t = await this.chatPageOf(who);
    try {
      const r = await this.sendStickerInChat(t.page, t.input, { file, src, name: label });
      if (r.ok) this.lastAction = `sticker ${who || 'chat'}`;
      return r;
    } finally {
      if (!t.fast) this.scheduleClose(60);
    }
  }

  /** 收藏：打开某个会话的表情面板，把里面的表情存进本地库。 */
  async collectStickersFrom(who, { limit = 12 } = {}) {
    const t = await this.chatPageOf(who);
    try {
      return await this.collectStickers(t.page, t.input, { limit, source: 'douyin' });
    } finally {
      if (!t.fast) this.scheduleClose(60);
    }
  }

  /**
   * 专门用来登录的窗口：开一个有头窗口停在登录页，期间不自动关页。
   * 不复用「一起看」，免得扫码扫到一半被 scheduleClose 关掉。
   */
  async loginWindow(url, { clearCookies = null } = {}) {
    return this.serialize(async () => {
      // 先挂住，别让排队中的自动关页把刚开的窗口关掉
      if (this.closeTimer) clearTimeout(this.closeTimer);
      this.closeTimer = null;
      this.holdOpen = true;
      try {
        await this.launch({ headless: false, force: true });
        // launch 内部的 close() 会把 holdOpen 清掉，这里补回来：
        // 不然扫码期间只要来一次 inbox/feed，60 秒后登录窗就被自动关掉（看起来就是「网页闪一下没了」）
        this.holdOpen = true;
        // 换号场景：新窗口里先把目标站点的 cookie 清干净，再跳登录页
        if (clearCookies) await this.clearCookiesMatching(clearCookies);
        const page = await this.getPage();
        if (url) await this.goto(page, url, 2200);
        return { ok: true, url: page.url() };
      } catch (error) {
        this.holdOpen = false;
        throw error;
      }
    });
  }

  async loginWindowClose() {
    this.holdOpen = false;
    await this.close().catch(() => {});
    return { ok: true };
  }

  /** 一起看：开一个有头窗口，主人可以自己在这个窗口里翻页，桌宠读同一个页面。 */
  async watchStart(url) {
    return this.serialize(async () => {
      if (this.closeTimer) clearTimeout(this.closeTimer);
      this.closeTimer = null;
      await this.launch({ headless: false, force: true });
      // 一起看期间不许自动收窗：期间任何动作排下的 60 秒定时器都会把主人正在看的页面关掉
      this.holdOpen = true;
      try {
        const page = await this.getPage();
        if (url) await this.goto(page, url, 2200);
        this.watchStartedAt = Date.now();
        const digest = await page.evaluate(watchScript).catch(() => null);
        return {
          ok: true,
          platform: this.platformOf(page.url()),
          title: digest?.title || (await page.title()),
          url: page.url(),
        };
      } catch (error) {
        this.holdOpen = false;
        throw error;
      }
    });
  }

  platformOf(url) {
    if (/bilibili\.com/.test(url)) return 'bilibili';
    if (/douyin\.com/.test(url)) return 'douyin';
    return 'web';
  }

  /** 同页面摘要：标题、进度、评论区。没开窗时返回 null。 */
  async watchDigest() {
    if (!this.context || !this.page || this.page.isClosed()) return null;
    try {
      return await this.page.evaluate(watchScript);
    } catch {
      return null;
    }
  }

  async watchStop() {
    this.watchStartedAt = 0;
    await this.close();
    return { ok: true };
  }

  async close() {
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.closeTimer = null;
    this.holdOpen = false;
    await this.page?.close().catch(() => {});
    this.page = null;
    await this.dmPage?.close().catch(() => {});
    this.dmPage = null;
    this.dmThread = '';
    this.dmArmedAt = 0;
    for (const slot of this.groupPages.values()) {
      if (slot.settle) clearTimeout(slot.settle);
      await slot.page?.close().catch(() => {});
    }
    this.groupPages.clear();
    await this.context?.close().catch(() => {});
    this.context = null;
  }

  snapshot() {
    return {
      running: !!this.context,
      lastAction: this.lastAction,
      lastError: this.lastError,
    };
  }
}
