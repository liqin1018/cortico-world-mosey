import fs from 'node:fs';
import path from 'node:path';
import { cutChars, formatDuration, humanPause, imageMimeOf, parseDouyinId, parseKeywords, stripAtName, stripAtPlaceholder, truncate } from './util.js';
import { loadPlaywright } from './browser.js';

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

/**
 * 「@我的」通知 → 内部 at 条目。
 * 抖音把评论里的 @ 放在 notice type=45 的 at 里；评论 id 只出现在 schema_url
 * 的 cid 参数上，不是独立字段。sub_type=1 是发作品时提到她，没有评论可回。
 */
export function mapAtNotice(item) {
  if (!item || Number(item.type) !== 45) return null;
  const at = item.at ?? {};
  const aweme = at.aweme ?? {};
  const user = at.user_info ?? {};
  const awemeId = String(
    item.aweme_id && String(item.aweme_id) !== '0' ? item.aweme_id : aweme.aweme_id ?? '',
  );
  if (!awemeId) return null;
  const schema = String(at.schema_url ?? '');
  const cid = schema.match(/[?&]cid=(\d+)/)?.[1] ?? String(at.cid ?? at.comment_id ?? '');
  const rootCid = schema.match(/[?&]reply_id=(\d+)/)?.[1] ?? (String(at.reply_id ?? '') || cid);
  const note = Number(aweme.aweme_type ?? item.aweme_type ?? 0) === 68;
  const content = String(at.content ?? at.label_text ?? '').trim();
  const title = String(aweme.desc ?? aweme.item_title ?? aweme.title ?? '').trim();
  const nickname = String(user.nickname ?? '').trim();
  return {
    kind: 'at',
    platform: 'douyin',
    type: note ? 'note' : 'video',
    id: String(item.nid_str ?? item.nid ?? `${awemeId}:${cid || ''}`),
    user: nickname,
    secUid: String(user.sec_uid ?? ''),
    mid: String(user.uid ?? ''),
    text: truncate(content || title || '（在评论里 @ 了你）', 140),
    quote: '',
    where: truncate(title || `视频 ${awemeId}`, 60),
    at: Number(item.create_time ?? 0) * 1000,
    url: `${ORIGIN}/${note ? 'note' : 'video'}/${awemeId}`,
    awemeId,
    cid,
  };
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
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 120 && r.height >= 90 && r.bottom > 0 && r.top < innerHeight * 1.2;
  };
  const videos = Array.from(document.querySelectorAll('video'));
  // 抖音会预加载下一条，页面里可能同时有两个 video：优先「可见且没暂停」的那个，
  // 不然读到的可能是上一条的进度（一起刷时尤其明显）
  const v = videos.find((x) => visible(x) && !x.paused) || videos.find(visible) || videos[0] || null;
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
  let author = '';
  if (platform === 'douyin') {
    if (title.length < 5) {
      const info = document.querySelector('[data-e2e="detail-video-info"]');
      if (info) title = (info.innerText || '').split('\n')[0] || title;
    }
    const who =
      document.querySelector('[data-e2e="video-author-name"]') ||
      document.querySelector('[data-e2e="detail-video-info"] a[href*="/user/"]');
    if (who) author = ((who.innerText || '').split('\n')[0] || '').trim();
  }
  if (platform === 'bilibili') {
    const h1 = document.querySelector('h1');
    if (h1) title = h1.innerText.trim() || title;
    title = title.replace(/_哔哩哔哩.*$/, '').trim();
    const up = document.querySelector('.up-name, .username');
    if (up) author = ((up.innerText || '').split('\n')[0] || '').trim();
  }
  const src = v ? String(v.currentSrc || v.src || '') : '';
  const m = location.pathname.match(/\/video\/(\d+)/);
  return {
    platform: platform,
    url: location.href,
    videoId: m ? m[1] : '',
    videoKey: src ? src.slice(-160) : '',
    title: title.slice(0, 120),
    author: author.slice(0, 40),
    time: v && isFinite(v.currentTime) ? Math.round(v.currentTime) : null,
    duration: v && isFinite(v.duration) ? Math.round(v.duration) : null,
    paused: v ? !!v.paused : null,
    ended: v ? !!v.ended : null,
    loop: v ? !!v.loop : null,
    videoCount: videos.length,
    comments: pick(['[data-e2e="comment-item"]', '#comment .reply-item', '.reply-item', '.comment-item', '.danmaku-item']),
    loginHint: /登录后|请先登录|扫码登录|立即登录/.test(text),
  };
})()`;

/** 只读评论列表，别把整页 innerText 拖过来。 */
const readCommentsScript = String.raw`(() => {
  const sels = ['[data-e2e="comment-item"]', '#comment .reply-item', '.reply-item', '.comment-item'];
  for (const sel of sels) {
    const out = Array.from(document.querySelectorAll(sel))
      .slice(0, 8)
      .map((n) => (n.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 2).join(' '))
      .filter(Boolean);
    if (out.length) return out;
  }
  return [];
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

/**
 * 一次往返把「验证/登录墙」状态问清楚。
 *
 * 以前是读整个 `document.body.innerText`。那玩意儿会强制整页重排：
 * 聊天记录一多就是几百毫秒，而它每次发完消息都要跑一遍，直接拖慢回复。
 * 验证/限流只会出现在弹层、toast、验证码 iframe 里，所以只查这几处。
 *
 * 1.8.7 第一版查得太宽（`[class*=verify]` + 不看 iframe 可不可见），
 * 抖音页面里常驻一个**隐藏的**验证 iframe，结果每次发完都报「要验证」——
 * 主人看到的就是「抖音把我拦下了」。现在：iframe 必须真的显示在屏幕上，
 * 文本只认那几句明确的话，并且把「到底命中了什么」一起返回，方便下次定位。
 */
async function bodyFlags(page) {
  return page
    .evaluate(() => {
      const visible = (n, minW = 8, minH = 8) => {
        const r = n.getBoundingClientRect();
        if (r.width < minW || r.height < minH) return false;
        const st = getComputedStyle(n);
        if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) < 0.05) return false;
        return r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
      };
      let hit = '';
      // 整页被跳到验证页
      if (/\/verify|captcha/i.test(location.href)) hit = `url:${location.href.slice(0, 80)}`;
      // 验证码 iframe：必须真的显示出来，抖音会常驻一个 0×0 的隐藏验证 iframe
      if (!hit) {
        for (const f of Array.from(document.querySelectorAll('iframe'))) {
          const src = String(f.getAttribute('src') || '');
          if (!/captcha|verify/i.test(src)) continue;
          if (!visible(f, 160, 80)) continue;
          hit = `iframe:${src.slice(0, 70)}`;
          break;
        }
      }
      /**
       * 弹层 / toast：只认明确的几句话。
       * 不要加英文 captcha / verify —— 中文界面上出现这两个词基本都是代码或误伤。
       */
      const RE = /完成验证|安全验证|短信验证码|为确保是本人操作|身份验证|操作频繁|账号异常|访问过于频繁|请稍后再试/;
      if (!hit) {
        const boxes = Array.from(
          document.querySelectorAll('.semi-modal-content, [role="dialog"], [class*="toast"], [class*="Toast"]'),
        ).slice(0, 10);
        for (const b of boxes) {
          if (!visible(b, 120, 36)) continue;
          const t = String(b.innerText || '').replace(/\s+/g, ' ').trim();
          if (!t || t.length > 300) continue;
          const m = RE.exec(t);
          if (m) {
            hit = `${m[0]}@${String(b.className || '').slice(0, 36)}`;
            break;
          }
        }
      }
      // 登录墙：只找那几个按钮，不读整页文本
      let login = false;
      const btns = Array.from(document.querySelectorAll('button, [role="button"], a')).slice(0, 150);
      for (const b of btns) {
        const s = String(b.textContent || '').replace(/\s+/g, '');
        if (!s || s.length > 8) continue;
        if (!/^(扫码登录|立即登录|登录|登录后|请先登录)$/.test(s)) continue;
        if (!visible(b)) continue;
        login = true;
        break;
      }
      // 分清「要验证码」和「只是限流」：主人看到的说法完全不一样
      const kind = !hit ? '' : /完成验证|安全验证|短信验证码|为确保是本人操作|身份验证|captcha|verify/i.test(hit) ? 'verify' : 'rate';
      return { risk: !!hit, verify: kind === 'verify', login, hit, kind };
    })
    .catch(() => ({ risk: false, verify: false, login: false, hit: '', kind: '' }));
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
    // 「陌生人消息」入口always要算进签名：陌生私信不进主列表，只在这里露头
    const sbox = document.querySelector('[class*="conversationStrangerBoxwrapper"]');
    const stranger = sbox ? text(sbox).slice(0, 80) : '';
    const items = Array.from(document.querySelectorAll('[data-e2e="msg-item-content"]'));
    if (!items.length) {
      // 会话列表那一行（还没点进会话，或会话被切走时）也要能发现新消息
      const rows = Array.from(document.querySelectorAll('[data-e2e="conversation-item"]')).slice(0, 3).map(text).join('|');
      return `0#${rows.slice(-200)}#${stranger}`;
    }
    return `${items.length}#${items.slice(0, 6).map(text).join('|').slice(-200)}#${stranger}`;
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
      el.closest('[class*="StrangerBox"]') ||
      el.closest('[class*="StrangerConversationList"]') ||
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
    /** 「一起看」用独立浏览器窗口：不跟私信/群标签混在一起 */
    this.watchBrowser = null;
    this.watchContext = null;
    this.watchPage = null;
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
    /**
     * 「回私信」专用页：停在 /chat，发完就**留在那个人的会话上**。
     *
     * 之前回陌生人用的是主页（this.page）：发完 60 秒就被收走，下次又要冷启动 +
     * 跳 /chat（7-9 秒）。主人那条快，就是因为她有一个永远停在会话上的页。
     * 这里给陌生人配一个同样的：第一次慢，之后同一个人就是点一下、打字、回车。
     */
    this.chatPage = null;
    /**
     * chatPage 上现在开着谁。
     * 和 `openThread` 分开：那个是给 dmPage（主人监听页）/ readThread 共用的，
     * 混在一起会让「发送前要不要点会话」判断错，把话打进别人那儿。
     */
    this.chatThread = '';
    /**
     * 陌生人的「常驻页」：谁进了快车道，就给他开一个页面停在他的会话上（最多 2 个）。
     *
     * 主人私信和群聊之所以能稳稳读到图，是因为**页面本来就停在那儿**；
     * 陌生人在共享页上「找→点→读」，标题又读不出来，每次都靠猜。
     * 这里照抄群聊那套：一人一页，读完不换人。
     */
    this.strangerPages = new Map();
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
    /**
     * 兜底超时：Playwright 的 page.evaluate 是**没有超时**的（setDefaultTimeout 只管网页元素），
     * 标签页一旦卡住（渲染进程崩了、抖音把标签页冻了），这个串行队列就会永远堵在第一个任务上，
     * 后面所有私信/发送/评论全都排队等死——外面看起来就是「桌宠不动了 / 死机」。
     * 群一多，页面就多，撞上这种卡死的概率也就上去了。
     */
    let timer = null;
    try {
      if (this.holdOpen) return await fn(); // 登录窗要等人扫码，不能掐
      const ms = Math.max(60000, Number(this.cfg?.opTimeoutMs ?? 240000) || 240000);
      const guard = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new DouyinError('STUCK', '抖音页面太久没响应，这一轮先放弃')), ms);
        timer.unref?.();
      });
      return await Promise.race([fn(), guard]);
    } finally {
      if (timer) clearTimeout(timer);
      this.busy -= 1;
    }
  }

  /**
   * 依次尝试：环境变量 → 插件自己的依赖 → Coopanion 扩展目录里已有的 playwright-core。
   * link: 安装时依赖不一定被 hoist 到插件目录，这个兜底能少一堆“浏览器没起来”。
   */
  /** 复用 src/browser.js 的共享实现（B站抽帧也要用），错误码仍按抖音这边抛。 */
  async loadPlaywright() {
    try {
      return await loadPlaywright(this.dataDir);
    } catch {
      throw new DouyinError(
        'BROWSER_DEP',
        '找不到 playwright-core：在插件目录执行 corepack pnpm install，或在扩展目录重装依赖。',
      );
    }
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
      // 上次进程被强杀、cookie 没来得及落盘时，用备份补一次（缺 sessionid 才补）
      await this.restoreCookies().catch(() => {});
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
    if (this.page && !this.page.isClosed() && !this.page.__strollRole) return this.page;
    if (this.page?.__strollRole) this.page = null;
    /**
     * 启动时自带一个 about:blank，直接用它；另开一个的话那个空页永远没人关，
     * 浏览器进程会一直驻留（实测能挂一小时、十几个进程），下次启动还会抢 profile。
     *
     * 但**群聊/私信 tab 刚建出来时也是 about:blank**（newPage 之后那一小段，以及 goto 还没提交时）。
     * 以前这里会把它当主页抢走：两个群一开，主页面可能变成某个群的聊天页，
     * 之后评论/私信全在这个页上乱跳，群监听也跟着错位——看着就像「死机」。
     * 所以建群页/私信页时都打了 __strollRole，这里必须跳过它们。
     *
     * 还有一个更窄的窗口：`ctx.newPage()` 已经返回、但 `__strollRole` 还没打上的那几毫秒。
     * 有人开新群时正好有私信要回，就会撞上。用 `_reserving` 把这段窗口堵死：
     * 正在建页的时候，getPage 宁可自己再开一个，也不去认领别人的空页。
     */
    const blank = this._reserving
      ? null
      : context.pages().find((p) => p && !p.isClosed() && p.url() === 'about:blank' && !p.__strollRole);
    this.page = blank ?? (await context.newPage());
    this.page.__strollRole = '';
    this.page.setDefaultTimeout(20000);
    return this.page;
  }

  /** 把一次风险命中翻译成人话，顺手记一笔；限流时进入两分钟冷却，别让她连着重试。 */
  /**
   * source='read'：只是读页面时看到风控提示（导航、翻页）——不记动作、不续期退避。
   * source='write'：点发送/点赞之后被挡，这种才算「她真的被拦住了」。
   */
  riskError(f, where = '操作', { source = 'write' } = {}) {
    const why = String(f?.hit || '页面提示').slice(0, 60);
    if (f?.kind === 'rate') {
      if (source !== 'read') this.rateUntil = Date.now() + 2 * 60 * 1000;
      this.policy.noteRisk('DOUYIN_RATE', `${where}后限流（${why}）`, { source });
      return new DouyinError('RISK', `抖音限流了（${why}），等两分钟再发，别连着重试。`);
    }
    this.policy.noteRisk('DOUYIN_VERIFY', `${where}后要验证（${why}）`, { source });
    return new DouyinError('RISK', `抖音要验证（${why}），得主人在手机上过一下验证码。`);
  }

  async checkRisk(page) {
    const f = await bodyFlags(page);
    if (f.risk) throw this.riskError(f, '刷抖音', { source: 'read' });
  }

  async goto(page, url, waitMs = 4200) {
    this.openThread = '';
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await humanPause(2200, 3600);
    if (waitMs) await page.waitForTimeout(waitMs);
    await this.checkRisk(page);
    this.lastError = '';
  }

  /** 拿到那个「回私信专用页」（没有就建一个，同一个 context，cookie 共用）。 */
  async chatPageForSend() {
    const ctx = await this.launch({ headless: this.headless ?? (this.cfg.background !== false) });
    if (this.chatPage && !this.chatPage.isClosed()) return this.chatPage;
    this._reserving = Number(this._reserving ?? 0) + 1;
    let page;
    try {
      page = await ctx.newPage();
      // 打个标记：getPage() 不能把它当成自己的空页抢走
      page.__strollRole = 'chat';
    } finally {
      this._reserving = Math.max(0, Number(this._reserving ?? 0) - 1);
    }
    page.setDefaultTimeout(20000);
    this.chatPage = page;
    this.chatThread = '';
    page.on('close', () => {
      if (this.chatPage === page) {
        this.chatPage = null;
        this.chatThread = '';
      }
    });
    return page;
  }

  /** 这个陌生人有没有常驻页（world 用它决定要不要读正文）。 */
  hasStrangerPage(who) {
    const hit = this.strangerPages?.get(String(who ?? '').trim());
    return !!(hit?.page && !hit.page.isClosed());
  }

  /**
   * 给某个陌生人开一个常驻页（最多 max 个，超了关最旧的）。
   *
   * 和群监听一样：建页 → 进 /chat → 点开这个人 → 收起文件夹，之后读消息直接读这一页。
   * 失败就返回 null，调用方退回共享页那条老路，不影响发送。
   */
  async ensureStrangerPage(who, { max = 2 } = {}) {
    const want = String(who ?? '').trim();
    if (!want) return null;
    this.strangerPages ??= new Map();
    const hit = this.strangerPages.get(want);
    if (hit?.page && !hit.page.isClosed()) {
      hit.at = Date.now();
      return hit.page;
    }
    return this.serialize(async () => {
      const again = this.strangerPages.get(want);
      if (again?.page && !again.page.isClosed()) return again.page;
      // 超上限：关最久没动过的那个
      if (this.strangerPages.size >= max) {
        const [oldWho, old] = [...this.strangerPages.entries()].sort((a, b) => a[1].at - b[1].at)[0] ?? [];
        if (oldWho) {
          this.strangerPages.delete(oldWho);
          if (old?.page && !old.page.isClosed()) await old.page.close().catch(() => {});
        }
      }
      const ctx = await this.launch({ headless: this.headless ?? (this.cfg.background !== false) });
      this._reserving = Number(this._reserving ?? 0) + 1;
      let page;
      try {
        page = await ctx.newPage();
        page.__strollRole = 'stranger';
      } finally {
        this._reserving = Math.max(0, Number(this._reserving ?? 0) - 1);
      }
      page.setDefaultTimeout(20000);
      this.strangerPages.set(want, { page, at: Date.now(), thread: '' });
      page.on('close', () => {
        const cur = this.strangerPages.get(want);
        if (cur?.page === page) this.strangerPages.delete(want);
      });
      try {
        await this.gotoChat(page);
        // 新页面：等「陌生人消息」入口渲染出来再点
        /**
         * 注意：有些账号根本没有「陌生人消息」文件夹（日志里 `hasBox: false`），
         * 对方就排在主会话列表里。所以文件夹点不到还要退回主列表，否则常驻页永远建不起来。
         */
        await page
          .waitForSelector('[class*="conversationStrangerBoxwrapper"]', { timeout: 3000 })
          .catch(() => {});
        let ok = await this.clickStrangerThread(page, want, { blind: true }).catch(() => false);
        if (!ok) ok = await this.clickThread(page, want).catch(() => false);
        if (!ok) throw new Error('no thread');
        await this.closeStrangerInbox(page).catch(() => {});
        this.strangerPages.get(want).thread = want;
        return page;
      } catch {
        this.strangerPages.delete(want);
        if (!page.isClosed()) await page.close().catch(() => {});
        return null;
      }
    });
  }

  /**
   * 刷新一个陌生人的常驻页：重新加载 → 重新点开会话。
   *
   * 后台标签页有时收不到新消息（列表还停在上一句），读出来自然对不上。
   * 这条路只在「补图」时用，慢一点没关系。
   */
  async refreshStrangerPage(who) {
    const want = String(who ?? '').trim();
    const hit = this.strangerPages?.get(want);
    if (!want || !hit?.page || hit.page.isClosed()) return false;
    return this.serialize(async () => {
      try {
        await hit.page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        await hit.page
          .waitForSelector('[data-e2e="conversation-item"]', { timeout: 6000 })
          .catch(() => {});
        let ok = await this.clickStrangerThread(hit.page, want, { blind: true }).catch(() => false);
        if (!ok) ok = await this.clickThread(hit.page, want).catch(() => false);
        if (ok) {
          hit.thread = want;
          hit.at = Date.now();
        }
        return !!ok;
      } catch {
        return false;
      }
    });
  }

  /** 收掉所有陌生人常驻页。 */
  async releaseStrangerPages() {
    const all = [...(this.strangerPages?.values() ?? [])];
    this.strangerPages?.clear();
    for (const x of all) {
      if (x?.page && !x.page.isClosed()) await x.page.close().catch(() => {});
    }
  }

  /**
   * 预热：把「回私信」那个常驻页提前切到某个陌生人。
   *
   * 纯后台：不读消息、不发请求，只把会话点开。这一步和模型思考**并行**，
   * 等她想好回什么时页面已经停在对方那儿，发送就只剩打字回车（实测 ~200ms）。
   * 点不到就算了，不影响正常流程（发送时会自己点一次）。
   */
  async prewarmStranger(who) {
    const want = String(who ?? '').trim();
    if (!want) return false;
    if (this.chatThread === want) return true;
    if (this._prewarm === want) return false;
    this._prewarm = want;
    try {
      return await this.serialize(async () => {
        let page = null;
        let opened = false;
        try {
          page = await this.chatPageForSend();
          if (this.chatThread === want) return true;
          if (!/\/chat/.test(String(page.url?.() ?? ''))) await this.gotoChat(page);
          const title = await this.currentChatTitle(page).catch(() => '');
          if (title && this.threadTitleMatches(title, want)) {
            this.chatThread = want;
            return true;
          }
          let ok = await this.clickStrangerThread(page, want, { blind: true }).catch(() => false);
          opened = !!ok;
          // 没有「陌生人消息」文件夹的账号，人就排在主列表里
          if (!ok) ok = await this.clickThread(page, want).catch(() => false);
          if (ok) {
            // 点完核一次标题：点空了就别把 chatThread 记成这个人，
            // 否则下一次回复会跳过点击、直接打进当前开着的会话（11-08 私信进群就是这么来的）
            await page.waitForTimeout(120);
            const after = await this.currentChatTitle(page).catch(() => '');
            if (after && this.threadTitleMatches(after, want)) this.chatThread = want;
          }
          return !!ok;
        } finally {
          // 文件夹是浮层：收起来，别挡着后面打字
          if (opened && page && !page.isClosed()) await this.closeStrangerInbox(page).catch(() => {});
        }
      });
    } catch {
      return false;
    } finally {
      this._prewarm = '';
    }
  }

  /**
   * 快速回到聊天页。
   *
   * `goto()` 是给「看视频/主页」用的：里面有人味停顿 2.2-3.6 秒 + 再死等 5.2 秒，
   * 一次差不多 8 秒。回私信用它，就是「为什么回陌生人要 10 秒」的主要来源。
   * 聊天页只需要「列表渲染出来」，等条件就够。
   */
  async gotoChat(page) {
    this.openThread = '';
    if (page === this.chatPage) this.chatThread = '';
    const t0 = Date.now();
    await page.goto(`${ORIGIN}/chat`, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    const ready = await page
      .waitForSelector('[data-e2e="conversation-item"]', { timeout: 6000 })
      .then(() => true)
      .catch(() => false);
    await this.checkRisk(page).catch(() => {});
    this.lastError = '';
    return { ok: ready, ms: Date.now() - t0 };
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

  get cookieFile() {
    return path.join(this.dataDir, 'stroll', 'douyin-cookies.json');
  }

  /**
   * 把当前登录态另存一份到磁盘。
   * profile 里的 Cookies 由 Chromium 自己管：进程被强杀（reapOrphans 用的是 Stop-Process -Force）、
   * 或者没来得及 flush 时，最近轮换过的 sessionid 会丢，下次启动就变成「未登录」——
   * 表现出来就是每隔几个小时要重新扫码。有这份备份就能在启动时补回去。
   */
  async saveCookies({ force = false } = {}) {
    if (!this.context) return 0;
    const now = Date.now();
    if (!force && this.cookiesSavedAt && now - this.cookiesSavedAt < 10 * 60 * 1000) return 0;
    this.cookiesSavedAt = now;
    const list = await this.context.cookies().catch(() => []);
    const useful = list.filter((c) => /(^|\.)(douyin|bytedance|amemv|snssdk)\.(com|cn)$/i.test(String(c.domain ?? '')));
    if (!useful.length) return 0;
    try {
      fs.mkdirSync(path.dirname(this.cookieFile), { recursive: true });
      fs.writeFileSync(this.cookieFile, JSON.stringify({ at: new Date(now).toISOString(), cookies: useful }), { mode: 0o600 });
    } catch {
      return 0;
    }
    return useful.length;
  }

  /** 启动时把备份补回 profile；只在缺 sessionid 时补，别覆盖页面刚写进去的新 cookie。 */
  async restoreCookies() {
    if (!this.context) return 0;
    let saved = null;
    try {
      saved = JSON.parse(fs.readFileSync(this.cookieFile, 'utf8'));
    } catch {
      return 0;
    }
    const cookies = Array.isArray(saved?.cookies) ? saved.cookies : [];
    if (!cookies.length) return 0;
    const now = Date.now();
    const live = await this.context.cookies().catch(() => []);
    const alive = live.some(
      (c) => (c.name === 'sessionid' || c.name === 'sid_tt') && (!c.expires || c.expires < 0 || c.expires * 1000 > now),
    );
    if (alive) return 0;
    // 过期的丢掉；session cookie（expires<=0）补一个 30 天，免得下次又被当成会话 cookie 丢掉
    const fixed = cookies
      .filter((c) => !c.expires || c.expires <= 0 || c.expires * 1000 > now)
      .map((c) => ({ ...c, expires: c.expires && c.expires > 0 ? c.expires : Math.floor(now / 1000) + 30 * 86400 }));
    if (!fixed.length) return 0;
    await this.context.addCookies(fixed).catch(() => {});
    this.log?.info?.('stroll douyin cookies restored', { n: fixed.length, from: saved.at });
    return fixed.length;
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
        /**
         * 每次都要重新问一次服务端。
         * sessionAlive 有 5 分钟缓存：扫码之前面板查过一次「未登录」，这个 false 会被缓存住，
         * 扫完码 isLoggedIn 仍然返回 false，于是白白等到缓存过期才收窗——
         * 这就是「登录完了那个网页还挂着好久」的真正原因。
         */
        this.sessionOkAt = 0;
        if (await this.isLoggedIn()) {
          this.markLoggedIn();
          clearInterval(this.loginPoller);
          this.loginPoller = null;
          /**
           * 收窗要快：以前这里先 `selfProfile()`（另开一页读昵称，几秒到十几秒），
           * 读完才 close，主人在桌面上看着一个登录窗挂在那一动不动。
           * 昵称/uid 其实 sessionAlive() 已经顺手填好了，不用再跑一趟。
           */
          await this.saveCookies({ force: true }).catch(() => {});
          await this.close();
          // 收窗后别留着「未登录」的旧缓存，不然面板还要再等 5 分钟才变绿
          this.sessionOk = true;
          this.sessionOkAt = Date.now();
          this.log?.info?.('stroll: 抖音登录成功，已切回后台', { who: this.selfName || '' });
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
    }, 1200);
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
    if (res.name) this.selfName = res.name;
    if (res.uid) this.selfUid = res.uid;
    /**
     * 只有下面三种结论：
     *   0    → 活着
     *   8    → 真的未登录（要重新扫码）
     *   其它 → 不知道（-1 没问到；2154/2483 是风控/需要验证）
     * 以前把「其它」一律当成掉线，结果风控一来面板就显示未登录，
     * 主人白扫一次码，过一会儿又好了——「每隔几小时掉线」有一半是这个误报。
     */
    if (code === 0) {
      this.sessionOk = true;
      this.sessionOkAt = now;
      return true;
    }
    if (code === 8) {
      this.sessionOk = false;
      this.sessionOkAt = now;
      return false;
    }
    return null;
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
  /** 收掉「回私信专用页」（关监听 / 退出时用）。 */
  async releaseChatPage() {
    const page = this.chatPage;
    this.chatPage = null;
    this.chatThread = '';
    this.openThread = '';
    if (page && !page.isClosed()) await page.close().catch(() => {});
  }

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
    this.releaseChatPage().catch(() => {});
    this.releaseStrangerPages().catch(() => {});
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
  /**
   * 读「陌生人消息」文件夹。
   *
   * 抖音把非好友的私信单独收在「陌生人消息」里，主会话列表**看不到**——
   * 主列表那条 `conversation-item` 只含主人和群。入口本身带最新一条的预览，
   * 所以先用入口文本判断有没有新东西，再点进去读完整列表，读完点返回。
   */
  /**
   * 主会话列表里都有谁（不含「陌生人消息」文件夹里那批）。
   * 用来兜底找人：主人和群之外的行，就是陌生人开的新会话。
   */
  async conversationRows(page = this.dmPage) {
    if (!page || page.isClosed()) return [];
    return await page
      .evaluate(() => {
        const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
        const TIME = /^(刚刚|\d{1,2}:\d{2}|昨天|前天|星期[一二三四五六日]|\d+\s*(?:秒|分钟|小时|天)前|\d{1,2}-\d{1,2})$/;
        const TRAIL = /\s+(刚刚|\d{1,2}:\d{2}|昨天|前天|星期[一二三四五六日]|\d+\s*(?:秒|分钟|小时|天)前|\d{1,2}-\d{1,2})$/;
        return Array.from(document.querySelectorAll('[data-e2e="conversation-item"]'))
          .filter((el) => !el.closest('[class*="StrangerConversationList"]'))
          .slice(0, 40)
          .map((el) => {
            const t = el.querySelector('[class*="ConversationItemtitle"]');
            const lines = String(el.innerText || '')
              .split('\n')
              .map(norm)
              .filter(Boolean);
            let name = norm(t?.innerText || lines[0] || '');
            let at = '';
            // 标题块里常常连着时间：「小鹿 9分钟前」。不剥掉的话，
            // 名字每分钟变一次（9分钟前→刚刚），会话永远找不到、去重也永远不重合。
            const m = TRAIL.exec(name);
            if (m) {
              at = m[1];
              name = name.slice(0, m.index).trim();
            }
            if (!at) at = lines.find((l) => TIME.test(l)) || '';
            // 预览：去掉标题那行（名字/时间）和纯时间行，再把开头重复的昵称切掉
            const rest = lines.filter((l, i) => !(i === 0 && l.includes(name)) && !TIME.test(l));
            let preview = rest.join(' ').trim();
            if (name && preview.startsWith(name)) preview = preview.slice(name.length).replace(/^[\s:：]+/, '');
            return { name, at, preview };
          })
          .filter((row) => row.name);
      })
      .catch(() => []);
  }

  /**
   * 只读「陌生人消息」入口那一行文字，不点进去。
   *
   * 入口本身就带最新一条：「陌生人消息 刚刚 小鹿：你好」。
   * 很多账号/布局下根本点不开那个文件夹（或者类名换了），光靠入口也能发现新消息。
   * 返回 { who, at, preview, raw } 或 null。
   */
  async strangerEntry(page = this.dmPage) {
    if (!page || page.isClosed()) return null;
    const raw = await page
      .evaluate(() => {
        const box =
          document.querySelector('[class*="conversationStrangerBoxwrapper"]') ||
          document.querySelector('[class*="StrangerBox"]') ||
          document.querySelector('[class*="strangerBox"]');
        return box ? String(box.innerText || '').replace(/\s+/g, ' ').trim() : '';
      })
      .catch(() => '');
    if (!raw) return null;
    const TIME = /(刚刚|\d{1,2}:\d{2}|昨天|前天|星期[一二三四五六日]|\d+\s*(?:秒|分钟|小时|天)前|\d{1,2}-\d{1,2})/;
    // 「陌生人消息 刚刚 小鹿：你好」→ 名字取「时间」后面、冒号前面那段
    const afterTime = raw.replace(/^.*?陌生人消息\s*/, '');
    const m = TIME.exec(afterTime);
    const tail = m ? afterTime.slice(m.index + m[0].length).trim() : afterTime;
    const nameHit = /^([^:：]{1,30})[:：]\s*(.*)$/.exec(tail);
    const who = (nameHit?.[1] ?? '').trim();
    const preview = (nameHit?.[2] ?? '').trim();
    return {
      who,
      at: m ? m[1] : '',
      preview: preview || tail,
      raw,
    };
  }

  /**
   * 诊断用：把私信页里跟「陌生人」有关的东西全抓一份，落盘给主人/开发看。
   * 线上出过一次「扫描一直空」，光看日志猜不出来，只能把 DOM 掏出来。
   */
  async strangerDebug(page = this.dmPage) {
    if (!page || page.isClosed()) return { ok: false, error: '私信页没开' };
    return await page
      .evaluate(() => {
        const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
        const cls = (el) => String(el?.className ?? '');
        const box = Array.from(document.querySelectorAll('[class*="Stranger"],[class*="stranger"]')).map((el) => ({
          tag: el.tagName,
          cls: cls(el).slice(0, 120),
          text: norm(el.innerText).slice(0, 120),
        }));
        const items = Array.from(document.querySelectorAll('[data-e2e="conversation-item"]')).map((el) => ({
          inFolder: !!el.closest('[class*="StrangerConversationList"]'),
          text: norm(el.innerText).slice(0, 80),
        }));
        // 左栏所有容器的类名：抖音改版时靠这个找新入口
        const wrap = Array.from(document.querySelectorAll('[class*="conversation" i],[class*="Conversation"]'))
          .slice(0, 40)
          .map((el) => cls(el).slice(0, 90))
          .filter(Boolean);
        return {
          url: location.href,
          hasBox: !!document.querySelector('[class*="conversationStrangerBoxwrapper"]'),
          strangerNodes: box.slice(0, 12),
          items: items.slice(0, 20),
          wrapClasses: [...new Set(wrap)].slice(0, 20),
        };
      })
      .catch((error) => ({ ok: false, error: String(error?.message ?? error) }));
  }

  async strangerThreads({ owner = '', groups = [] } = {}) {
    const page = this.dmPage;
    if (!page || page.isClosed()) return [];

    const info = await page
      .evaluate(() => {
        const box = document.querySelector('[class*="conversationStrangerBoxwrapper"]');
        if (!box) return null;
        const text = String(box.innerText || '').replace(/\s+/g, ' ').trim();
        // 入口上挂的红点/未读数也要算：只有「陌生人消息」四个字、预览不更新时，
        // 光看文字永远发现不了新消息（线上就是这样漏的）
        const badge = Array.from(box.querySelectorAll('[class*="adge"],[class*="Dot"],[class*="dot"],[class*="unread"],[class*="Unread"]'))
          .map((n) => String(n.textContent || '').trim())
          .filter((s) => s && s.length <= 4)
          .join(',');
        return { text, badge };
      })
      .catch(() => null);
    if (!info) return [];
    const sig = `${info.text}|${info.badge}`;
    // 亮着红点时 3 分钟重看一次（红点可能一直不清），没红点就 10 分钟
    const maxAge = info.badge ? 3 * 60 * 1000 : 10 * 60 * 1000;
    // 入口没变化 = 上次已经读完这一屏，不用反复点进去
    if (sig === this.strangerBoxSig && Date.now() - Number(this.strangerBoxSigAt ?? 0) < maxAge) {
      return [];
    }
    this.strangerBoxSig = sig;
    this.strangerBoxSigAt = Date.now();

    const opened = await this.openStrangerInbox(page);
    if (!opened) return [];
    try {
      return await this.readStrangerList(page, { owner, groups });
    } finally {
      await this.closeStrangerInbox(page);
    }
  }

  /**
   * 「陌生人消息」文件夹现在是不是真的开着。
   *
   * 关键：关过一次之后容器仍然留在 DOM 里，只是被 translateX 推到屏幕外 + opacity:0。
   * 所以不能只看 count()>0 —— 那样会「以为开着」，然后去点一个屏幕外的行，什么都没发生。
   */
  async strangerInboxOpen(page = this.dmPage) {
    if (!page || page.isClosed()) return false;
    return await page
      .evaluate(() => {
        const wrap = document.querySelector('[class*="StrangerConversationListlistWrapper"]');
        if (!wrap) return false;
        const r = wrap.getBoundingClientRect();
        if (r.width < 50 || r.left < -10) return false;
        const cs = getComputedStyle(wrap);
        return Number(cs.opacity || 1) > 0.5;
      })
      .catch(() => false);
  }

  /** 等文件夹滑出来。50ms 一轮：通常 150-300ms 就到位，比死等 700ms 快一半。 */
  async waitStrangerInbox(page = this.dmPage, ms = 1500) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await this.strangerInboxOpen(page)) return true;
      await page.waitForTimeout(50);
    }
    return false;
  }

  /** 点开「陌生人消息」文件夹；打不开返回 false。 */
  async openStrangerInbox(page = this.dmPage) {
    if (!page || page.isClosed()) return false;
    if (await this.strangerInboxOpen(page)) return true;
    const box = page.locator('[class*="conversationStrangerBoxwrapper"]').first();
    // 新开的页面要等列表渲染出来：以前直接 count() 判 0 就返回失败，
    // 常驻页就是这么一直建不起来的（日志里 `stroll stranger page ok: false`）。
    if (!(await box.count().catch(() => 0))) {
      await page
        .waitForSelector('[class*="conversationStrangerBoxwrapper"]', { timeout: 2500 })
        .catch(() => {});
    }
    if (!(await box.count().catch(() => 0))) return false;
    await box.click({ force: true }).catch(() => {});
    if (await this.waitStrangerInbox(page, 1500)) return true;
    // 老布局没有动画/样式读不出来时，退回 count 判断，别把能用的页面判死
    return await page
      .locator('[class*="StrangerConversationListlistWrapper"]')
      .count()
      .then((n) => n > 0)
      .catch(() => false);
  }

  /**
   * 在「陌生人消息」文件夹里找一个人：只读不点，找完把文件夹关回去。
   * 用于「她能不能给这个人发私信」的判断——推送里给过名字，发送时得先确认这个人真的在。
   */
  async findStranger(name) {
    const page = this.dmPage;
    const want = String(name ?? '').trim();
    if (!want || !page || page.isClosed()) return null;
    const norm = (s) => String(s ?? '').replace(/[\s\u3000]+/g, '').toLowerCase();
    const w = norm(want);
    if (!w) return null;
    const wasOpen = await this.strangerInboxOpen(page);
    if (!wasOpen && !(await this.openStrangerInbox(page))) return null;
    /** 在 rows 里按「整串相等 → 唯一包含」找，找不到返回 null。 */
    const pick = (rows) => {
      const exact = rows.find((r) => norm(r.who) === w);
      if (exact) return exact;
      // 只认唯一的包含命中：两个都像就不猜，宁可让她说「认不出」
      const partial = rows.filter((r) => norm(r.who).includes(w) || w.includes(norm(r.who)));
      return partial.length === 1 ? partial[0] : null;
    };
    try {
      const rows = await this.readStrangerList(page, {});
      const hit = pick(rows);
      if (hit) return hit;
      // 时间格式没认出来（版本差异）时退回「只看第一行」，至少还能按名字认人
      const names = await page
        .evaluate(() => {
          const box = document.querySelector('[class*="StrangerConversationListlistWrapper"]');
          if (!box) return [];
          return Array.from(box.querySelectorAll('[data-e2e="conversation-item"]'))
            .slice(0, 30)
            .map((r) => String((r.innerText || '').split('\n')[0] || '').trim())
            .filter(Boolean);
        })
        .catch(() => []);
      return pick(names.map((who) => ({ who, at: '', preview: '', unread: 0 })));
    } finally {
      if (!wasOpen) await this.closeStrangerInbox(page);
    }
  }

  /** 主列表找不到时，去「陌生人消息」文件夹里点开这个会话。 */
  /**
   * 点开「陌生人消息」里的某个人。
   *
   * `blind: true` = 标题读不出来时也认「点到了」。这个布局的聊天标题经常读不出
   * （选择器全落空），严格核对会让这条路永远失败——调用方必须自己核对内容
   * （`readStrangerThread` 会拿列表预览和读到的消息比对）。
   */
  async clickStrangerThread(page, name, { blind = false } = {}) {
    const want = String(name ?? '').trim();
    if (!want || !page || page.isClosed()) return false;
    const norm = (s) => String(s ?? '').replace(/[\s\u3000]+/g, '').toLowerCase();
    const open = async () => {
      if (await this.strangerInboxOpen(page)) return true;
      return await this.openStrangerInbox(page);
    };
    if (!(await open())) return false;
    // 按昵称整串点，不用 hasText 子串：行里还有消息预览，可能正好含这个名字
    const hit = await page
      .evaluate(
        ({ w }) => {
          const box = document.querySelector('[class*="StrangerConversationListlistWrapper"]');
          if (!box) return null;
          const flat = (s) => String(s ?? '').replace(/\s+/g, '').toLowerCase();
          const rows = Array.from(box.querySelectorAll('[data-e2e="conversation-item"]'));
          const nameOf = (el) => {
            const t = el.querySelector('[class*="ConversationItemtitle"]');
            const raw = String(t?.innerText || (el.innerText || '').split('\n')[0] || '').trim();
            /**
             * 抖音把时间也塞进标题：「小鹿 刚刚」「小鹿 10:55」。
             * 不剥掉的话整串相等永远不成立，blind 点击会一直判「点不到」。
             */
            return raw
              .replace(
                /\s+(刚刚|\d{1,2}:\d{2}|昨天|前天|星期[一二三四五六日]|\d+\s*(?:秒|分钟|小时|天)前|\d{1,2}-\d{1,2})$/,
                '',
              )
              .trim();
          };
          let el = rows.find((r) => flat(nameOf(r)) === w) ?? null;
          const exact = !!el;
          if (!el) {
            const partial = rows.filter((r) => flat(nameOf(r)).includes(w) || w.includes(flat(nameOf(r))));
            if (partial.length === 1) el = partial[0];
          }
          if (!el) return null;
          el.scrollIntoView({ block: 'nearest' });
          const r = el.getBoundingClientRect();
          if (r.width < 10 || r.height < 10) return null;
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), exact };
        },
        { w: norm(want) },
      )
      .catch(() => null);
    if (!hit) return false;
    await page.mouse.click(hit.x, hit.y).catch(() => {});
    /**
     * 先看一眼标题读不读得出来：这个布局经常整块读不到。
     * 读不到就别白等 1.2 秒——点了就返回，让调用方用内容去核对。
     */
    const probe = await this.currentChatTitle(page).catch(() => '');
    if (!probe) return !!(blind && hit.exact);
    /**
     * 以前写死等 900ms。真正要等的是「右边聊天区切到这个人了」——
     * 每 50ms 看一眼标题，通常 150-350ms 对上，慢的时候也不会比死等更久。
     */
    const deadline = Date.now() + 1200;
    while (Date.now() < deadline) {
      const title = await this.currentChatTitle(page).catch(() => '');
      if (title && this.threadTitleMatches(title, want)) return true;
      await page.waitForTimeout(50);
    }
    return false;
  }

  /** 诊断用：最近两条「谁说的 + 类型 + 开头」，读错会话时一眼能看出来。 */
  sampleOf(msgs) {
    return (Array.isArray(msgs) ? msgs : [])
      .slice(-2)
      .map((m) => `${m.from}:${m.kind}:${String(m.text ?? '').slice(0, 10)}`);
  }

  /**
   * 读到的最后几条，和列表预览对得上吗？
   *   'text'  = 正文里能找到预览那句话（最可信）
   *   'media' = 预览是「表情/图片」这类占位，正文里也有表情/图片（可信度中等）
   *   ''      = 对不上，多半是切错了会话
   */
  threadMatchMode(msgs, preview) {
    const flat = (s) => String(s ?? '').replace(/[\s\u3000]+/g, '').toLowerCase();
    // 预览常黏着未读数（「[撸袖子] 1」「在吗 2」），先剥掉再比，否则永远对不上
    const pv = flat(String(preview ?? '').replace(/\s+\d{1,2}$/, ''));
    const list = (Array.isArray(msgs) ? msgs : []).filter((m) => m && m.from !== 'me');
    if (!list.length) return '';
    if (!pv) return 'text';
    // `[大力拥抱]` 这种表情名字也要认；关键词只是兜底（「[动画表情]」「转发图片」）
    const media = /^\[[^\]]{1,12}\]$/.test(pv) || /(表情|图片|视频|分享|名片|语音|文件)/.test(pv);
    const pv8 = pv.slice(0, 8);
    for (const m of list.slice(-3)) {
      const t = flat(m.text);
      if (t && pv && (t.includes(pv) || pv.includes(t.slice(0, 8)) || (pv8 && t.includes(pv8)))) return 'text';
      if (media && ['emoji', 'image', 'share', 'card'].includes(m.kind)) return 'media';
    }
    return '';
  }

  /** 读文件夹里的会话行（和主列表同一套 DOM，只是容器不同）。 */
  async readStrangerList(page = this.dmPage, { owner = '', groups = [] } = {}) {
    if (!page || page.isClosed()) return [];
    const rows = await page
      .evaluate(() => {
        const box = document.querySelector('[class*="StrangerConversationListlistWrapper"]');
        if (!box) return [];
        return Array.from(box.querySelectorAll('[data-e2e="conversation-item"]'))
          .slice(0, 30)
          .map((r) => (r.innerText || '').replace(/\s+/g, ' ').trim());
      })
      .catch(() => []);

    const TIME = /^(.*?)\s+(刚刚|\d{1,2}:\d{2}|昨天|前天|星期[一二三四五六日]|\d+\s*(?:秒|分钟|小时|天)前|\d{1,2}-\d{1,2})\s+(.*)$/;
    const ownerName = String(owner ?? '').trim();
    const skip = new Set((groups ?? []).map((g) => String(g ?? '').trim()).filter(Boolean));
    const out = [];
    for (const text of rows) {
      const m = String(text).match(TIME);
      if (!m) continue;
      const who = m[1].trim();
      if (!who) continue;
      if (ownerName && who === ownerName) continue;
      if (skip.has(who)) continue;
      let preview = m[3].trim();
      let unread = 0;
      // 行尾那个孤立数字是未读数
      const tail = preview.match(/^(.*?)\s+(\d{1,2})$/);
      if (tail) {
        preview = tail[1].trim();
        unread = Number(tail[2]);
      }
      out.push({ who, at: m[2], preview, unread, raw: text });
    }
    return out;
  }

  /** 退回主私信列表。 */
  async closeStrangerInbox(page = this.dmPage) {
    if (!page || page.isClosed()) return;
    // 返回箭头是标题栏里那个 svg；点标题栏空白处没反应
    const icon = page.locator('[class*="StrangerConversationListicon"]').first();
    if (await icon.count().catch(() => 0)) {
      await icon.click({ force: true }).catch(() => {});
    } else {
      const head = page.locator('[class*="StrangerConversationListhead"]').first();
      if (await head.count().catch(() => 0)) {
        await head.click({ force: true }).catch(() => {});
      } else {
        await page.keyboard.press('Escape').catch(() => {});
      }
    }
    await page.waitForTimeout(500);
  }

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
      this._reserving = Number(this._reserving ?? 0) + 1;
      try {
        page = await ctx.newPage();
        // 标记归属：主页 getPage() 不能把它当成自己的 about:blank 空页抢走
        page.__strollRole = 'dm';
      } finally {
        this._reserving = Math.max(0, Number(this._reserving ?? 0) - 1);
      }
      page.setDefaultTimeout(20000);
      this.dmPage = page;
      this.dmThread = '';
      this.dmArmedAt = 0;
      page.on('crash', () => {
        page.__strollCrashed = true;
        if (this.dmPage === page) {
          this.dmPage = null;
          this.dmThread = '';
          this.dmArmedAt = 0;
        }
      });
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
      slot = {
        page: null,
        thread: '',
        hit: null,
        busy: false,
        queued: false,
        settle: null,
        armedAt: 0,
        arming: null,
        // 连续失败次数 / 下次再试的时间：两个群都挂不上时不能每 30 秒重开一遍页面
        failCount: 0,
        nextTryAt: 0,
      };
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
   * 监听健康自检：页面还在吗、观察器还在吗、页面还能不能响应。
   * 不看「有没有收到消息」——群里几小时没人说话是正常的，那不是故障。
   */
  async watchHealth({ timeout = 4000 } = {}) {
    const probe = async (page) => {
      if (!page || page.isClosed()) return { ok: false, reason: 'PAGE_CLOSED' };
      // 被页面自己的路由带走（回到首页/推荐流）也算不健康：观察器挂在这种页面上收不到消息
      if (!/\/chat/i.test(String(page.url() ?? ''))) return { ok: false, reason: 'PAGE_NAVIGATED' };
      try {
        const alive = await Promise.race([
          page.evaluate(() => !!(window.__strollDmObs && typeof window.__strollDmSignal === 'function')),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeout)),
        ]);
        // 观察器对象还在，但可能被页面自己的路由卸掉了
        return alive ? { ok: true } : { ok: false, reason: 'OBSERVER_GONE' };
      } catch (error) {
        return { ok: false, reason: String(error?.message ?? '') === 'timeout' ? 'PAGE_HUNG' : 'PAGE_ERROR' };
      }
    };

    const dmArmed = this.dmArmed();
    const dm = dmArmed ? await probe(this.dmPage) : { ok: true, reason: 'NOT_ARMED' };
    // 并行探，别让 4 个群各等 4 秒把心跳拖住
    const groups = (
      await Promise.all(
        [...(this.groupPages ?? [])]
          .filter(([name]) => this.groupArmed(name))
          .map(async ([name, slot]) => ({ name, ...(await probe(slot.page)) })),
      )
    ).filter(Boolean);
    return { dmArmed, dm, groups };
  }

  /** 观察器被页面导航带走了：不用重开页，原地重新挂一次就行。 */
  async rearmObserver(page) {
    if (!page || page.isClosed()) return false;
    const r = await page.evaluate(dmObserverScript).catch(() => 'failed');
    return r === 'ok' || r === 'already';
  }

  /** 群页确认死了：关掉并清状态，下一拍 armGroupPush 会重开。 */
  async resetGroup(name) {
    const key = String(name ?? '').trim();
    const slot = this.groupPages?.get?.(key);
    if (!slot) return false;
    slot.armedAt = 0;
    slot.thread = '';
    slot.pendingSig = '';
    slot.nextTryAt = 0;
    slot.failCount = 0;
    await slot.page?.close().catch(() => {});
    slot.page = null;
    this.groupPages.delete(key);
    return true;
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
      this._reserving = Number(this._reserving ?? 0) + 1;
      try {
        page = await ctx.newPage();
        // 标记归属：主页 getPage() 不能把它当 about:blank 空页抢走
        page.__strollRole = 'group';
      } finally {
        this._reserving = Math.max(0, Number(this._reserving ?? 0) - 1);
      }
      page.setDefaultTimeout(20000);
      slot.page = page;
      page.on('crash', () => {
        page.__strollCrashed = true;
        if (slot.page === page) {
          slot.page = null;
          slot.thread = '';
          slot.armedAt = 0;
        }
      });
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

    // 先把会话 id 打到列表行上：两个群同名时，clickThread 要靠它才点得准
    await this.readThreadRows(page).catch(() => []);

    if (slot.thread !== who) {
      /**
       * 用 clickThread 而不是 `locator(hasText: 群名)`。
       * hasText 是**子串**匹配：两个群的标题都带「阿柚」时，
       * 它可能把第二个群点成第一个群；而且标题被截断时又永远匹配不上。
       * clickThread 先按整串相等找，再退回「唯一包含」，两个群也分得清。
       */
      const deadline = Date.now() + 20000;
      let picked = false;
      while (Date.now() < deadline) {
        picked = await this.clickThread(page, who);
        if (picked) break;
        await page.waitForTimeout(350);
      }
      if (!picked) {
        await this.dismissBubbles(page);
        return { ok: false, code: 'NO_THREAD' };
      }
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
      // page.evaluate 没有超时：标签页一卡住，slot.busy 会永远 true，这个群就再也不更新了
      const messages = await Promise.race([
        this.readGroupMessages(page, 10),
        new Promise((resolve) => setTimeout(() => resolve([]), 8000)),
      ]).catch(() => []);
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

  /** 只保留这些群的监听 tab，其余收掉（换了群/退群时别把聊天 tab 一直留着）。 */
  async pruneGroupPages(keep = []) {
    const want = new Set((keep ?? []).map((n) => String(n ?? '').trim()).filter(Boolean));
    for (const name of Array.from(this.groupPages.keys())) {
      if (want.has(name)) continue;
      await this.releaseGroupPage(name).catch(() => {});
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
        if (f.risk) throw this.riskError(f, '点赞');
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

  /** 读自己主页的关注数（带 _t 破缓存）。拿不到返回 null。 */
  async followingCount(page) {
    if (!page || page.isClosed()) return null;
    const n = await page
      .evaluate(async () => {
        try {
          const r = await fetch(
            '/aweme/v1/web/user/profile/self/?device_platform=webapp&aid=6383&channel=channel_pc_web&_t=' + Date.now(),
            { credentials: 'include' },
          );
          const t = await r.json();
          const v = Number(t?.user?.following_count);
          return Number.isFinite(v) ? v : null;
        } catch {
          return null;
        }
      })
      .catch(() => null);
    return typeof n === 'number' ? n : null;
  }

  /** 从视频页读出作者主页的 sec_uid（拿不到就返回空，退回视频页按钮）。 */
  async videoAuthorUid(page) {
    const href = await page
      .evaluate(() => {
        const visible = (x) => {
          const r = x.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && r.top >= 0 && r.top < innerHeight * 0.65;
        };
        const hit = Array.from(document.querySelectorAll('a[href*="/user/MS4w"]')).find(visible);
        return hit ? hit.href : '';
      })
      .catch(() => '');
    return secUidOf(String(href ?? ''));
  }

  /** 点击后的小停顿。抽成方法是为了测试能设成 0，不用真等 4 秒。 */
  async pause(a, b) {
    await humanPause(a, b);
  }

  /** 关注失败时存一份现场：按钮、弹窗、页面文字。下次一眼看出是被登录框挡了还是按钮找错了。 */
  async dumpFollowDebug(page, extra = {}) {
    try {
      const data = await page
        .evaluate(() => {
          const cut = (s, n = 1200) => String(s ?? '').slice(0, n);
          const rect = (n) => {
            const r = n.getBoundingClientRect();
            return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
          };
          const buttons = Array.from(document.querySelectorAll('button, [role="button"], [data-e2e]'))
            .filter((b) => /关注|已关注|互相关注/.test(b.innerText || ''))
            .slice(0, 12)
            .map((b) => ({
              text: cut((b.innerText || '').trim(), 40),
              e2e: b.getAttribute('data-e2e') || '',
              cls: cut(b.className, 120),
              ...rect(b),
              html: cut(b.outerHTML, 800),
            }));
          const popups = [];
          const all = document.querySelectorAll('body *');
          for (let i = 0; i < all.length && i < 6000 && popups.length < 10; i += 1) {
            const n = all[i];
            const st = getComputedStyle(n);
            if (!/^(fixed|absolute)$/.test(st.position)) continue;
            const r = n.getBoundingClientRect();
            if (r.width < 200 || r.height < 120) continue;
            const cls = String(n.className || '');
            const txt = (n.innerText || '').replace(/\s+/g, ' ').slice(0, 120);
            if (!/login|captcha|verify|验证|登录|安全/.test(cls + txt)) continue;
            popups.push({ tag: n.tagName, cls: cut(cls, 140), ...rect(n), text: cut(txt, 120) });
          }
          return {
            url: location.href,
            title: document.title,
            bodyText: cut((document.body.innerText || '').replace(/\s+/g, ' '), 1500),
            buttons,
            popups,
          };
        })
        .catch(() => null);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const file = path.join(this.dataDir, 'stroll', 'debug', `follow-${stamp}.json`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...extra, ...data }, null, 1));
      this.lastDebugDump = file;
      this.log?.warn?.(`关注没成功，界面结构已存到 ${file}`);
      return file;
    } catch {
      return '';
    }
  }

  /**
   * 找页面顶部那个「关注/已关注」按钮。
   * 抖音主页的推荐位、右侧列表里也有同名按钮，`first()` 很容易点到别人——
   * 所以只接受 y 在上半屏的，并且优先抖音自己的 data-e2e。
   */
  async pickFollowButton(page) {
    const limit = await page.evaluate(() => window.innerHeight).catch(() => 900);
    const maxY = Math.max(320, Math.min(560, Math.round(Number(limit || 900) * 0.45)));
    for (const sel of ['[data-e2e="user-info-follow-btn"]', '[data-e2e="user-follow-btn"]', 'button']) {
      const loc = page.locator(sel);
      const n = Math.min(16, await loc.count().catch(() => 0));
      let best = null;
      for (let i = 0; i < n; i += 1) {
        const el = loc.nth(i);
        const text = (await el.innerText().catch(() => '')).trim();
        if (!/^(关注|已关注|互相关注)$/.test(text)) continue;
        const box = await el.boundingBox().catch(() => null);
        if (!box || box.width < 24 || box.y < 0 || box.y > maxY) continue;
        if (!best || box.y < best.y) best = { el, y: box.y, text };
      }
      if (best) return best;
    }
    return null;
  }

  /**
   * 关注/取关一个人。三种入口都认：主页链接、sec_uid、视频链接。
   * 以前只认视频 ID——主人在对方主页上点「关注」，反而被要求「给个视频」，很不合理。
   */
  async follow(idOrUrl, on = true) {
    return this.serialize(async () => {
      const raw = String(idOrUrl ?? '').trim();
      const page = await this.getPage();
      if (!(await this.isLoggedIn())) throw new DouyinError('LOGIN_REQUIRED', '抖音还没登录，关注不了');

      const secUid = secUidOf(raw);
      let target = secUid;
      let where = 'profile';
      if (secUid) {
        await this.goto(page, `${ORIGIN}/user/${secUid}`, 2400);
        // 主页的按钮比视频页晚一拍，多等一会儿再找
        await page.waitForTimeout(700);
        // 没真的打开这个主页就别点：页面上照样有别人的关注按钮
        if (!page.url().includes(`/user/${secUid}`)) {
          throw new DouyinError('BAD_TARGET', `打不开这个抖音主页（${secUid}），可能账号不存在或链接过期`);
        }
      } else {
        const id = await this.idOf(raw);
        if (!id) throw new DouyinError('BAD_ID', '抖音关注：给主页链接、sec_uid 或视频链接都行');
        target = id;
        where = 'video';
        await this.ensureVideo(page, id);
        /**
         * 视频不存在时抖音会跳到推荐流，页面上照样有关注按钮——以前点了就算成功，
         * 结果「面板显示关注成功、实际谁也没关注上」。所以必须核对 URL 还在这条视频上。
         */
        if (!page.url().includes(`/video/${id}`) && !page.url().includes(`/note/${id}`)) {
          throw new DouyinError(
            'BAD_ID',
            `抖音上打不开 ${id}：这串可能是用户 ID，不是视频。给主页链接（/user/MS4w…）更稳`,
          );
        }
        /**
         * 视频页的「关注」常被播放器/浮层压住，点了没反应。
         * 能从这条视频里读出作者主页，就跳过去用主页的按钮点——命中率明显更高。
         */
        const authorUid = await this.videoAuthorUid(page);
        if (authorUid) {
          await this.goto(page, `${ORIGIN}/user/${authorUid}`, 2200);
          await page.waitForTimeout(700);
          if (page.url().includes(`/user/${authorUid}`)) {
            where = 'profile';
            target = authorUid;
          }
        }
      }

      const isFollowing = (t) => /已关注|互相关注/.test(String(t ?? ''));

      /**
       * 抖音的关注是「乐观更新」：点下去前端立刻把按钮改成「已关注」，
       * 请求被拒（风控 / 要验证 / 权重低）也不回滚，只有刷新才看得见真相。
       * 所以只信两样：关注接口的 status_code，和刷新页面后的按钮状态。
       */
      const verify = async (api) => {
        const code = api?.body ? Number(api.body.status_code ?? api.body.code) : NaN;
        if (api?.seen && Number.isFinite(code)) {
          return { ok: code === 0, why: 'api', apiCode: code, apiMsg: String(api.body?.status_msg ?? '') };
        }
        // 没抓到接口回执（接口改名/走别的域名）：刷新一次，破掉假状态
        if (where !== 'profile' || !page.url().includes(`/user/${target}`)) {
          return { ok: null, why: 'none' };
        }
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
        await page.waitForTimeout(900);
        if (!page.url().includes(`/user/${target}`)) {
          return { ok: null, why: 'navigated', afterReload: page.url() };
        }
        const again = await this.pickFollowButton(page);
        const t = (again?.text ?? '').trim();
        return { ok: isFollowing(t) === on, why: 'reload', afterReload: t };
      };

      // 只认页面顶部的那个：主页的推荐位、侧栏也有「关注」，取第一个容易点到别人
      const hit = await this.pickFollowButton(page);
      if (!hit) {
        throw new DouyinError(
          'NO_FOLLOW',
          where === 'profile' ? '主页上没找到关注按钮（可能要登录/验证）' : '页面上没找到关注按钮',
        );
      }
      const button = hit.el;
      const text = hit.text;

      // 页面显示「已关注」也可能是上次乐观更新留下的脏状态：刷新确认一次再下结论
      if (isFollowing(text) === on) {
        const v0 = await verify(null);
        if (v0.ok === true) return { ok: true, already: true, following: on, target, where, verified: v0.why };
        const file = await this.dumpFollowDebug(page, { target, where, phase: 'already-stale', before: text, ...v0 });
        throw new DouyinError(
          'STATE_STALE',
          `页面上写着「${text}」，但刷新后是「${v0.afterReload || '空'}」——上次那个「已关注」是假的，实际没关注上。现场：${file}`,
        );
      }

      // 抖音 -509 限流时，关注接口照样返回 status_code 0，但服务端不执行。
      // 唯一靠谱的证据是「自己的关注数有没有变」，所以点之前先记一下。
      const beforeFollowing = await this.followingCount(page);

      // 点之前挂响应监听：抖音网页版关注走 commit/item/follow 这类接口
      const api = { seen: false, body: null };
      const onResp = (r) => {
        try {
          const u = r.url();
          // 关注列表（spotlight/relation）、私信轮询也会带 follow 字样，别拿它们当结果
          if (/spotlight|relation\/list|\/im\//i.test(u)) return;
          if (!/follow|commit\/item/i.test(u)) return;
          r.json()
            .then((b) => {
              // 只收带 status_code 的：埋点、粉丝列表没有这个字段，会污染判断
              const code = Number(b?.status_code ?? b?.code);
              if (!Number.isFinite(code)) return;
              api.seen = true;
              api.body = b;
            })
            .catch(() => {});
        } catch {
          // 响应已释放，忽略
        }
      };
      page.on('response', onResp);

      await button.click({ timeout: 6000 });
      await this.checkRisk(page);
      // 按钮变化有延迟（抖音要先请求再回写 UI）：轮询 4 次，别读一次就判死
      let after = '';
      for (let i = 0; i < 4; i += 1) {
        await this.pause(700, 1100);
        after = (await button.innerText().catch(() => '')).trim();
        if (isFollowing(after) === on) break;
      }
      await page.waitForTimeout(400);
      page.off('response', onResp);

      if (isFollowing(after) !== on) {
        const needLogin = await page
          .evaluate(() =>
            /登录后|请先登录|扫码登录|验证码|安全验证|身份验证/.test(document.body.innerText || ''),
          )
          .catch(() => false);
        const file = await this.dumpFollowDebug(page, { target, where, after, needLogin, api: api.body });
        throw new DouyinError(
          needLogin ? 'NEED_LOGIN' : 'NOT_CONFIRMED',
          needLogin
            ? `点了关注弹出了登录/验证：先用 stroll action=login 打开登录窗扫一次码。现场：${file}`
            : `点了关注，按钮还是「${after || '空'}」。现场已存 ${file}`,
        );
      }

      // 按钮变了不算数，还要验真
      const v = await verify(api);
      if (v.ok === false) {
        const file = await this.dumpFollowDebug(page, { target, where, phase: 'rejected', after, api: api.body, ...v });
        throw new DouyinError(
          'FOLLOW_REJECTED',
          v.why === 'api'
            ? `抖音把这次关注挡回去了（接口 ${v.apiCode}${v.apiMsg ? ` ${v.apiMsg}` : ''}）。多半是账号被限制或在要验证。现场：${file}`
            : `页面上显示「${after}」，但刷新后是「${v.afterReload || '空'}」——抖音只是把按钮改了，没真的关注上。现场：${file}`,
        );
      }
      if (v.ok === null) {
        return { ok: true, following: on, confirmed: false, target, where, verified: 'none' };
      }

      // 接口说成功也要再核一次关注数：被 -509 限流时接口返回 0 但什么都没发生
      if (beforeFollowing != null) {
        const afterFollowing = await this.followingCount(page);
        if (afterFollowing != null && afterFollowing === beforeFollowing) {
          const throttled = await page
            .evaluate(() => /-509|请求过于频繁|操作过于频繁|操作太快/.test(document.body.innerText || ''))
            .catch(() => false);
          if (throttled) this.policy?.noteRisk?.('DOUYIN_FREQ', '-509 请求过于频繁（关注被挡）');
          const file = await this.dumpFollowDebug(page, {
            target,
            where,
            phase: 'count-unchanged',
            beforeFollowing,
            afterFollowing,
            throttled,
            api: api.body,
          });
          throw new DouyinError(
            'FOLLOW_BLOCKED',
            `抖音收下了请求但没真的关注（关注数还是 ${afterFollowing}${throttled ? '，页面提示请求过于频繁' : ''}）。` +
              `多半是被限流了，等 20-30 分钟再试。现场：${file}`,
          );
        }
      }

      this.lastAction = `${on ? 'follow' : 'unfollow'} ${target}`;
      return { ok: true, following: on, confirmed: true, target, where, verified: v.why };
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

  /**
   * 评论区发图：点开评论框 → 塞图片 →（可选）配一句正文 → 发送。
   *
   * 抖音网页版评论区的发图入口不是每个版本都有：先找输入区附近隐藏的 input[type=file]，
   * 没有就点工具条里像「图片」的按钮再找一次。都找不到就明确报错并留 dump，
   * 不去硬调发布接口——图片评论要额外的上传 token，猜接口只会更糟。
   */
  async commentImage(idOrUrl, filePath, { text = '' } = {}) {
    if (!fs.existsSync(filePath)) throw new DouyinError('NO_FILE', `找不到文件：${filePath}`);
    const id = await this.idOf(idOrUrl);
    if (!id) throw new DouyinError('BAD_ID', '不是有效的抖音视频');
    return this.serialize(async () => {
      const page = await this.getPage();
      if (!(await this.isLoggedIn())) throw new DouyinError('LOGIN_REQUIRED', '抖音还没登录，发不了评论');
      await this.ensureVideo(page, id, { note: /\/note\//.test(String(idOrUrl)), quick: true });
      let input = await this.findCommentInput(page);
      if (!input) input = await this.openCommentEditor(page);
      if (!input) throw new DouyinError('NO_INPUT', '没找到评论输入框（页面可能改版，或这条视频关了评论）');
      await input.click({ force: true, timeout: 6000 }).catch(() => {});

      const published = page
        .waitForResponse((r) => /\/comment\/publish/.test(r.url()), { timeout: 15000 })
        .then(async (r) => (await r.json().catch(() => null))?.comment ?? null)
        .catch(() => null);

      // webp/heic 评论区也不一定收，统一转 jpeg
      const payload = await this.normalizeImageForUpload(page, filePath);
      let fed = await this.feedFileInput(page, payload, input);
      if (!fed) {
        const btn = await this.findCommentImageButton(page, input);
        if (btn) {
          await btn.click({ force: true }).catch(() => {});
          await page.waitForTimeout(220);
          fed = await this.feedFileInput(page, payload, input);
        }
      }
      if (!fed) {
        const dump = await this.dumpChatDebug(page, 'comment-image', { id });
        throw new DouyinError(
          'NO_IMAGE_ENTRY',
          `抖音网页版评论区没找到发图入口（可能不支持图片评论）。现场：${dump || '（dump 失败）'}`,
        );
      }
      // 等预览贴上来（有的版本上传完要 0.5-1 秒）
      await page.waitForTimeout(600);
      if (text) await input.type(text, { delay: 22 }).catch(() => {});
      await humanPause(120, 220);
      await input.press('Enter').catch(() => {});
      let left = '';
      for (let i = 0; i < 12; i += 1) {
        await page.waitForTimeout(80);
        left = await input.evaluate((el) => (el.innerText || el.value || '').trim()).catch(() => '');
        if (!left) break;
      }
      if (left) {
        const send = await this.findSendButton(page);
        if (send) await send.click({ force: true, timeout: 5000 }).catch(() => {});
        for (let i = 0; i < 10; i += 1) {
          await page.waitForTimeout(80);
          left = await input.evaluate((el) => (el.innerText || el.value || '').trim()).catch(() => '');
          if (!left) break;
        }
      }
      const flags = await bodyFlags(page);
      if (flags.verify) throw new DouyinError('VERIFY_REQUIRED', '抖音要求短信验证，先在手机上过一下。');
      if (flags.risk) throw this.riskError(flags, '发图片评论');
      const pub = await Promise.race([published, page.waitForTimeout(1800).then(() => null)]);
      this.lastAction = `comment image ${id}`;
      return {
        ok: true,
        via: 'comment-image',
        confirmed: !!pub,
        cid: String(pub?.cid ?? ''),
        status: Number(pub?.status ?? 0),
        note: pub ? '' : '发出去了但没拿到回执，去评论区看一眼再下结论。',
      };
    });
  }

  /** 评论工具条里那个「图片」按钮（有些版本是 label + 隐藏 input，feedFileInput 已经能直接命中）。 */
  async findCommentImageButton(page, input) {
    const h = await page
      .evaluateHandle((ed) => {
        const scope = ed.closest('[id*="comment-input-container"]') || ed.parentElement?.parentElement || document;
        const cands = Array.from(
          scope.querySelectorAll('button, [role="button"], label, [class*="upload"], [class*="Upload"], [class*="image"], [class*="Image"]'),
        );
        return (
          cands.find((n) => {
            if (n === ed || n.contains(ed)) return false;
            const label = String(n.getAttribute('aria-label') || n.getAttribute('title') || n.textContent || '');
            return /图片|照片|image|photo|上传/i.test(label);
          }) || null
        );
      }, input)
      .catch(() => null);
    return h ? h.asElement() : null;
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
      if (flags.risk) throw this.riskError(flags, '发评论');
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
                // 抖音评论也能发图 / 大表情：把图源带上，读评论时可以真的看见
                images: [
                  ...(Array.isArray(c.image_list) ? c.image_list : []),
                  ...(c.sticker ? [c.sticker] : []),
                ]
                  .map((im) => im?.origin_url?.url_list?.[0] || im?.url_list?.[0] || im?.static_url?.url_list?.[0] || '')
                  .filter((u) => typeof u === 'string' && /^https?:/.test(u)),
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
   * 评论区里 @ 她：读抖音的「@我的」通知（notice_group=6）。
   *
   * 不点通知页：页面里的接口要页面上下文带的 cookie，直接 fetch 更稳，
   * 也不会把她的消息标成已读（is_mark_read=0），主人自己打开抖音时红点还在。
   */
  async noticeMentions(limit = 6) {
    const page = await this.getPage();
    if (!(await this.isLoggedIn().catch(() => false))) return [];
    if (!/douyin\.com/.test(page.url())) {
      await this.goto(page, `${ORIGIN}/user/message`, 2500).catch(() => null);
    }
    const list = await page
      .evaluate(
        async ({ count }) => {
          const q = new URLSearchParams({
            device_platform: 'webapp',
            aid: '6383',
            channel: 'channel_pc_web',
            is_new_notice: '1',
            is_mark_read: '0',
            notice_group: '6',
            count: String(count),
            min_time: '0',
            max_time: '0',
            update_version_code: '170400',
            pc_client_type: '1',
            pc_libra_divert: 'Windows',
            support_h265: '1',
            support_dash: '1',
            cpu_core_num: '20',
            version_code: '170400',
            version_name: '17.4.0',
            cookie_enabled: 'true',
            platform: 'PC',
          });
          const r = await fetch(`https://www.douyin.com/aweme/v1/web/notice/?${q}`, {
            credentials: 'include',
          });
          if (!r.ok) return [];
          const d = await r.json().catch(() => null);
          if (Number(d?.status_code ?? -1) !== 0) return [];
          return Array.isArray(d?.notice_list_v2) ? d.notice_list_v2 : [];
        },
        { count: Math.max(1, Math.min(20, limit)) },
      )
      .catch(() => []);
    return list.map(mapAtNotice).filter(Boolean).slice(0, Math.max(1, limit));
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
      // 120ms 一轮：刚点开会话时输入框通常 100-300ms 就挂上了，
      // 以前 400ms 一轮，最坏白等 0.4 秒——回消息的体感差距就在这儿。
      await page.waitForTimeout(120);
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
            // 否则「老K」这种前面没有身份标签的行会被整行丢掉
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
  /** 一次 CDP insertText 把整段正文塞进编辑器；没落进去返回 false（调用方退回逐字输入）。 */
  async insertTextFast(page, input, text) {
    try {
      this._cdp ??= new Map();
      let cdp = this._cdp.get(page);
      if (!cdp) {
        cdp = await page.context().newCDPSession(page);
        this._cdp.set(page, cdp);
      }
      await cdp.send('Input.insertText', { text: String(text ?? '') });
      await page.waitForTimeout(25);
      const got = await input
        .evaluate((el) => String(el.innerText || el.value || '').replace(/[\u200B-\u200D\uFEFF]/g, ''))
        .catch(() => '');
      const head = String(text ?? '').slice(0, 6);
      const ok = !!got && got.includes(head);
      if (!ok) this._cdp.delete(page);
      return ok;
    } catch {
      this._cdp?.delete(page);
      return false;
    }
  }

  async sendInChat(page, input, text, { mention = '' } = {}) {
    // 刚被限流过：直接告诉她还要等多久，别再去页面上试（越试越糟）
    if (Number(this.rateUntil ?? 0) > Date.now()) {
      const left = Math.ceil((Number(this.rateUntil) - Date.now()) / 1000);
      throw new DouyinError('RATE_WAIT', `抖音刚限流，${left} 秒后再发。`);
    }
    const read = () =>
      input
        .evaluate((el) => String(el.value ?? el.textContent ?? '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim())
        .catch(() => '');
    // 正文里她手打的「@某人」先剥掉：真 @ 由 mention 插 chip，
    // 手打的那个只是普通字符——抖音会染成蓝色，但对方收不到通知，还容易和真 chip 重复成一个。
    let body = cutChars(text, 300);
    if (mention) body = stripAtName(body, mention);
    // 「@你 / @主人」不是昵称，留着也只是一个假 @
    body = stripAtPlaceholder(stripLeadingFakeAt(body));
    // 空正文按回车只会弹「不能发送空白消息」，而读回来还是空——会被当成「发出去了」。
    // 没有 @ 要插就直接拒绝（GLM 审出来的 #2 前半）。
    if (!body && !mention) {
      throw new DouyinError('EMPTY_TEXT', '正文是空的，没发（空消息只会弹「不能发送空白消息」）。');
    }
    await input.click({ timeout: 6000, force: true }).catch(() => {});
    let mentioned = false;
    if (mention) {
      mentioned = await this.mentionInChat(page, input, mention).catch(() => false);
    }
    // 先试「整段插入」：Slate 编辑器认 beforeinput/input，一次事件就落进去，
    // 20 个字从 200ms+ 降到 ~20ms。编辑器没接住（还是空的）再退回逐字输入。
    let pastedOk = false;
    if (body) {
      pastedOk = await this.insertTextFast(page, input, body);
      if (!pastedOk) {
        if (mentioned) {
          // mentionInChat 收尾已经在 chip 后面补了空格，这里直接接正文
          await page.keyboard.type(body, { delay: 0 });
        } else {
          await input.pressSequentially(body, { delay: 0 });
        }
      }
    }
    this.lastMention = mentioned;
    // 逐字输入可能「静默失败」（焦点不在编辑器里）：读一次确认；insertText 那条路已经校验过 DOM 了
    if (body && !pastedOk) {
      const typedNow = await read();
      if (!typedNow) throw new DouyinError('NOT_TYPED', '正文没进输入框，没发。');
    }
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
    if (f.risk) throw this.riskError(f, '发私信');
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

  /** 消息区状态：条数 + 图片总数 + 尾部文字。发图要拿它判断「真的落地了没有」。 */
  async msgState(page) {
    return await page
      .evaluate(() => {
        const items = Array.from(document.querySelectorAll('[data-e2e^="msg-item"]'));
        let imgTotal = 0;
        for (const el of items) imgTotal += el.querySelectorAll('img').length;
        let tail = '';
        for (const el of items.slice(-2)) {
          tail += `|${String(el.innerText || '').replace(/\s+/g, ' ').slice(0, 24)}`;
        }
        return { count: items.length, imgTotal, tail };
      })
      .catch(() => null);
  }

  /**
   * 等消息区稳定下来再取基线。
   *
   * 这是「她说发了、对方没收到」的根源：发图前页面上可能正在重渲染
   * （刚点开会话、刚关掉表情面板），基线取在「还没渲染完」的那一刻，
   * 之后列表从 0 变成 8 条，就被当成「我的图发出去了」。
   * 连续两次读到的条数和尾部一样才算稳定。
   */
  async stableMsgState(page, { maxWait = 1200 } = {}) {
    const deadline = Date.now() + maxWait;
    let prev = await this.msgState(page);
    while (Date.now() < deadline) {
      await page.waitForTimeout(100);
      const next = await this.msgState(page);
      if (next && prev && next.count === prev.count && next.tail === prev.tail) return next;
      prev = next ?? prev;
    }
    return prev ?? { count: 0, imgTotal: 0, tail: '' };
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
    // 基线必须取「稳定后」的条数：列表还在渲染时取，会把重渲染当成「发出去了」
    const before = await this.stableMsgState(page);
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

  /**
   * 按 src 认人。
   *
   * 抖音的图有两条会变：
   *   - 查询串（签名、过期时间）每分钟都不同；
   *   - **CDN 域名**会在 p3-sign / p26-sign / p9-sign 之间轮换。
   * 以前只剥了协议和查询串，域名一换就认不出来 → 面板里明明有这张也判「没有」，
   * 于是退回「按图片发」。现在只比路径（`/obj/im-resource/xxx`），两边都能认。
   */
  sameSrc(a, b) {
    const norm = (v) => {
      const t = String(v ?? '').trim();
      if (!t) return '';
      try {
        return new URL(t, 'https://x.invalid').pathname || '';
      } catch {
        return t.split('?')[0].replace(/^https?:\/\/[^/]+/, '');
      }
    };
    const x = norm(a);
    const y = norm(b);
    if (!x || !y) return false;
    if (x === y) return true;
    // 兜底：路径末段一样也算（有的版本会给同一张图不同的目录前缀）
    const tail = (v) => v.split('/').filter(Boolean).pop() ?? '';
    return tail(x) === tail(y) && tail(x).length >= 12;
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
      /**
       * 表情面板是「带着动画弹出来」的：后台标签页里动画可能一直不推进，
       * 元素读出来 opacity 还是 0，`probePanel` 就判定「面板没打开」。
       * 先把这一页提到前台再点，命中率明显不一样（headless 下没有副作用）。
       */
      await page.bringToFront().catch(() => {});
      const opened = await this.openEmojiPanel(page, input);
      if (opened.ok) {
        const hit = opened.panel.items.find((it) => this.sameSrc(it.src, src));
        if (hit) {
          const r = await this.clickPanelItem(page, input, hit);
          await this.closeChatModals(page);
          if (r.ok) return { ...r, sticker: name, panel: 'hit' };
        }
        // 面板开着会盖住输入区，走上传前先关掉，不然发送按钮点不到
        await this.closeChatModals(page);
        /**
         * 面板开着但没找到这张：留一条诊断，不然只能看到「退化成按图片发」。
         * 常见原因是 src 的 CDN 域名换了（已按路径比对修过），或者这张根本不在收藏里。
         */
        this.lastStickerDiagnosis = {
          at: Date.now(),
          reason: 'not-in-panel',
          items: opened.panel.items.length,
          want: String(src).split('?')[0].split('/').pop() ?? '',
          sample: opened.panel.items.slice(0, 3).map((it) => String(it.src ?? '').split('?')[0].split('/').pop() ?? ''),
        };
      } else {
        this.lastStickerDiagnosis = {
          at: Date.now(),
          reason: opened.code ?? 'no-panel',
          error: String(opened.error ?? '').slice(0, 120),
        };
      }
    } else {
      this.lastStickerDiagnosis = { at: Date.now(), reason: 'no-src' };
    }
    if (file && fs.existsSync(file)) {
      const up = await this.sendChatImage(page, input, file);
      return { ...up, sticker: name, panel: 'fallback-image', diagnosis: this.lastStickerDiagnosis };
    }
    return { ok: false, code: 'NO_STICKER', error: '表情面板里没有这张，也没有本地文件可发。', diagnosis: this.lastStickerDiagnosis };
  }

  /** 抖音聊天上传只稳收 jpg/png/gif/mp4；webp/heic 转成 jpeg 再传（顺便缩到 1280，传得更快）。 */
  async normalizeImageForUpload(page, filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (/^\.(jpe?g|png|gif|mp4)$/.test(ext)) return filePath;
    try {
      const bytes = fs.readFileSync(filePath);
      const jpg = await this.toJpegBytes(page, bytes);
      if (!jpg) return filePath;
      return { name: `${path.basename(filePath, ext)}.jpg`, mimeType: 'image/jpeg', buffer: jpg };
    } catch {
      return filePath;
    }
  }

  /**
   * 把本地图片当附件发进聊天：点工具按钮 → 接住系统文件选择框 → 等预览 → 发送。
   * 表情包发出去是图片消息，不是「收藏表情」；能点面板时优先走面板。
   */
  async sendChatImage(page, input, filePath) {
    if (!fs.existsSync(filePath)) return { ok: false, code: 'NO_FILE', error: `找不到文件：${filePath}` };
    // 抖音对图片上传有节流：刚失败过就先等一会儿，别连着试（她 12:57-12:58 连试三次，越试越发不出去）
    if (Number(this._imgSendUntil ?? 0) > Date.now()) {
      return {
        ok: false,
        code: 'IMAGE_COOLDOWN',
        error: `刚才发图被挡了一下，等 ${Math.ceil((Number(this._imgSendUntil) - Date.now()) / 1000)} 秒再发`,
      };
    }
    // 上一轮可能把表情面板留在屏幕上（它是个 semi-modal，会挡住输入区），先关掉
    await this.closeChatModals(page);
    // webp/heic 抖音聊天上传不一定收：统一转成 jpeg（顺便缩到 1280），传上去更快更稳
    const payload = await this.normalizeImageForUpload(page, filePath);
    // 最先试输入区里直接挂着的隐藏 input[type=file]：实测抖音的输入栏里一直有两个，
    // 塞文件就走上传，不用点图标、不用接系统文件框（点图标要等 700ms，还可能点空）。
    // 必须在选文件之前记指纹：有的版本 setFiles 当场就把消息发出去了
    const before = await this.chatSig(page);
    const done = async () => {
      const r = await this.afterImagePicked(page, input, before);
      // 失败冷却 90 秒；成功也留 2.5 秒间隔——上传接口对连续调用很敏感
      this._imgSendUntil = r.ok ? Date.now() + 2500 : Date.now() + 90 * 1000;
      return r;
    };
    if (await this.feedFileInput(page, payload, input)) {
      // 选上了不等于接住了：700ms 内没预览就说明喂错了 input（抖音有两个），换另一个再试一次
      if (await this.waitPreview(page, input, 700)) return await done();
      if (await this.feedReplaceInput(page, payload)) {
        if (await this.waitPreview(page, input, 700)) return await done();
      }
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
      if (await this.feedFileInput(page, payload, input)) {
        chooserPromise.then((ch) => ch?.setFiles([]).catch(() => {})).catch(() => {});
        return await done();
      }
      const chooser = await chooserPromise;
      if (chooser) {
        await chooser.setFiles(payload).catch(() => {});
        return await done();
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
  /** 输入区里出现图片预览（缩略图）没有。 */
  async hasPreview(page, input) {
    return await input
      .evaluate((el) => {
        const box = el.closest('[data-e2e="msg-input"]') || el;
        return Array.from(box.querySelectorAll('img')).some((im) => {
          const r = im.getBoundingClientRect();
          return r.width >= 24 && r.height >= 24;
        });
      })
      .catch(() => false);
  }

  async waitPreview(page, input, ms = 600) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (await this.hasPreview(page, input)) return true;
      await page.waitForTimeout(80);
    }
    return false;
  }

  /** 抖音输入栏里有两个 file input，第一个没反应时试 replace 那个。 */
  async feedReplaceInput(page, payload) {
    const loc = page.locator('input.semi-upload-hidden-input-replace').first();
    if (!(await loc.count().catch(() => 0))) return false;
    return await loc
      .setInputFiles(payload)
      .then(() => true)
      .catch(() => false);
  }

  async afterImagePicked(page, input, before) {
    const beforeCount = Number(before?.count ?? -1);
    /**
     * 「发出去了」的唯一判据：消息条数比基线多。
     *
     * 以前是「指纹变了就算」——而指纹是 `条数#前三条文字`，列表一重渲染（或者对方正好来消息）
     * 就变，于是明明没发出去也返回 ok:true，她就说「发了」，对方什么都没收到。
     * 基线条数在上一步已经等稳定了，所以 +1 才是真消息。
     */
    const changed = async () => {
      if (beforeCount < 0) return (await this.chatSig(page)) !== before;
      const st = await this.msgState(page);
      return !!st && st.count > beforeCount;
    };
    /**
     * 抖音选完图会先弹一个确认框：
     *   「发送给 阿柚, 阿澈, 老K(3)   s_811c597ed5c8.png  118.2 KB   取消   发送（1）」
     * 不点那个「发送」，图就一直挂在预览里——上一版漏了这一步，回执写「图选上了但没确认发出去」，
     * 界面上其实什么都不会出现。所以这里一边等消息变化，一边盯着这个确认框。
     */
    const modalSend = () =>
      page.locator('.semi-modal-wrap button:has-text("发送"), .semi-modal-wrap [role="button"]:has-text("发送")').last();
    let viaModal = false;
    let until = Date.now() + 6000;
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
    const preview = () => this.hasPreview(page, input);
    let ready = false;
    for (let i = 0; i < 25; i += 1) {
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
  /** 下载一张图（有页面就借页面的 cookie，没有再开临时请求）。 */
  async imageBytes(src, page = null) {
    const p =
      page ||
      (this.dmPage && !this.dmPage.isClosed() ? this.dmPage : null) ||
      (this.page && !this.page.isClosed() ? this.page : null) ||
      Array.from(this.groupPages?.values?.() ?? [])
        .map((s) => s.page)
        .find((x) => x && !x.isClosed()) ||
      null;
    if (!p) return null;
    const bytes = await this.fetchImageBytes(p, src).catch(() => null);
    if (!bytes) return null;
    // 抖音常给 avif/heic：模型多半不吃，转成 jpeg 再给
    if (!imageMimeOf(bytes)) return this.toJpegBytes(p, bytes).catch(() => null);
    return bytes;
  }

  /**
   * 把已经下载好的图片重新编码成 jpeg（顺带缩到 1280px 以内）。
   * 传字节而不是 URL：图片 CDN 不一定允许页内跨域 fetch，但字节已经在手里了，
   * 走 blob 就不受 CORS 限制。手机直出照片动辄 4000px，原图塞给模型又慢又容易超限。
   */
  async toJpegBytes(page, bytes) {
    const input = Buffer.from(bytes).toString('base64');
    const b64 = await page
      .evaluate(async (data) => {
        try {
          const bin = atob(data);
          const u8 = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i += 1) u8[i] = bin.charCodeAt(i);
          const bmp = await createImageBitmap(new Blob([u8]));
          const scale = Math.min(1, 1280 / Math.max(bmp.width || 1, bmp.height || 1));
          const c = document.createElement('canvas');
          c.width = Math.max(1, Math.round((bmp.width || 1) * scale));
          c.height = Math.max(1, Math.round((bmp.height || 1) * scale));
          const g = c.getContext('2d');
          if (!g) return '';
          g.drawImage(bmp, 0, 0, c.width, c.height);
          return String(c.toDataURL('image/jpeg', 0.86).split(',')[1] || '');
        } catch {
          return '';
        }
      }, input)
      .catch(() => '');
    if (!b64) return null;
    const buf = Buffer.from(b64, 'base64');
    return buf.length && imageMimeOf(buf) ? buf : null;
  }

  async fetchImageBytes(page, src) {
    const url = String(src ?? '').trim();
    if (!/^https?:/.test(url)) return null;
    try {
      const resp = await page.context().request.get(url, {
        // 别主动要 avif：模型大多不认，白转一道
        headers: { Referer: `${ORIGIN}/`, Accept: 'image/webp,image/png,image/jpeg,image/*;q=0.8' },
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
          //（实测 innerText = "阿柚 刚刚"），按 class 取会多一截。
          const name = lines[0] || clean(title?.innerText) || '';
          // 兜底：把标题/时间/在线状态剔掉，剩下的才可能是消息预览
          const junk = new Set([clean(name), clean(time?.innerText), clean(online?.innerText)].filter(Boolean));
          const fallback = lines.find((l) => !junk.has(clean(l))) ?? '';
          const unread = Number(clean(badge?.innerText).replace(/\D/g, '')) || 0;
          let previewText = clean(preview?.innerText) || fallback;
          // 预览里常把未读角标一起算进来（实测「阿澈 2」），那个 2 不是消息内容
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
    const rows = await page
      .evaluate(async ([n, withSender, self]) => {
        // 「是不是我发的」：抖音把语义拼在块名后面（messageMessageBoxisFromMe /
        // MessageBoxContentisFromMe），用「包含」匹配才对得上。
        const isMine = (el) => !!(el.closest && el.closest('[class*="isFromMe"]'));
        /**
         * 这一条消息自己的容器：从内容往上爬，**爬到「再上一层就会包住两条消息」为止**。
         * 不能直接用 `closest('[class*=messageMessageBox]')`：有些版本那个类会套住一整段消息，
         * 里面的 querySelector 永远抓到最上面那个人的名字——于是群里所有人说的话都被标成同一个人
         * （线上就是这样，全标成了主人）。
         */
        const rowOf = (el) => {
          let row = el.parentElement;
          for (let i = 0; i < 6 && row?.parentElement; i += 1) {
            const up = row.parentElement;
            if (up.querySelectorAll('[data-e2e="msg-item-content"]').length > 1) break;
            row = up;
          }
          return row;
        };
        /**
         * 群里要分清是谁说的。昵称按优先级一个个找，**不能写成一串选择器**：
         * `querySelector('a, b')` 返回的是文档里最靠前的那个，不是列表里第一个命中的，
         * 页面上任何一个更早出现的 nickname 都会被误当成发言人。
         */
        const senderOf = (el) => {
          if (!withSender) return '';
          const row = rowOf(el);
          if (!row) return '';
          const sels = [
            '[class*="MessageBoxMessageTitleavatarName"]',
            '[class*="avatarName"]',
            '[class*="MessageBoxMessageTitle"]',
            '[class*="nickname"]',
            '[class*="Nickname"]',
            '[class*="userName"]',
            '[class*="UserName"]',
          ];
          let name = '';
          for (const s of sels) {
            const node = row.querySelector(s);
            const t = String(node?.innerText ?? '').replace(/\s+/g, ' ').trim();
            if (t) {
              name = t;
              break;
            }
          }
          if (!name) {
            const av = row.querySelector('img[alt], [class*="avatar"][title]');
            name = String(av?.getAttribute('alt') || av?.getAttribute('title') || '').trim();
          }
          /**
           * 最后一层：这条消息自己的 React props。抖音的消息模型里带发送者信息，
           * 但字段名各版本不一样，只认几个明确叫昵称的键，别乱抓（名片/视频作者也有名字字段）。
           */
          if (!name) {
            const key = Object.keys(el).find((k) => k.indexOf('__reactProps$') === 0);
            if (key) {
              const seen = new Set();
              const walk = (v, d) => {
                if (name || !v || typeof v !== 'object' || d > 7 || seen.has(v)) return;
                seen.add(v);
                for (const k of Object.keys(v)) {
                  if (k === '_owner' || k === 'ref' || k === 'return' || k === 'stateNode') continue;
                  const val = v[k];
                  if (typeof val === 'string') {
                    if (/^(nickname|nickName|userName|displayName|senderName)$/i.test(k)) {
                      const t = val.trim();
                      if (t && t.length <= 24) {
                        name = t;
                        return;
                      }
                    }
                  } else {
                    walk(val, d + 1);
                  }
                  if (name) return;
                }
              };
              try {
                walk(el[key], 0);
              } catch {
                // props 里有循环引用就算了
              }
            }
          }
          // 角色标签可能拼在名字前面（「群主 阿柚」）也可能在后面
          name = name
            .replace(/^(群主|管理员|群成员|成员)\s*/u, '')
            .replace(/\s*(群主|管理员|群成员|成员)$/u, '')
            .trim();
          const arr = Array.from(name);
          return arr.length > 24 ? arr.slice(0, 24).join('') : name;
        };
        /** 这一条是不是「新一段消息」的开头（有自己的头像）。用来判断名字能不能往下继承。 */
        const startsRun = (el) => {
          const row = rowOf(el);
          return !!(row && row.querySelector('[class*="avatar"] img, img[class*="avatar"], [class*="avatar"]'));
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
        /**
         * 补全图片地址。抖音的图有几种写法：
         * `//p3-sign.douyinpic.com/...`（协议相对）、懒加载的 `data-src`、`srcset` 里的多档。
         * 只认 http(s) 会把协议相对的全都丢掉——线上「只收到 [图片] 标记、画面没过来」就是它。
         */
        const absUrl = (u) => {
          const s = String(u ?? '').trim();
          if (!s) return '';
          if (s.startsWith('//')) return `https:${s}`;
          if (/^https?:\/\//i.test(s)) return s;
          if (s.startsWith('/')) return `https://www.douyin.com${s}`;
          return '';
        };
        const urlsIn = (el, allowSmall = false) => {
          const out = [];
          for (const im of el.querySelectorAll('img, source')) {
            // 头像是 36px 左右，先排掉，别把它当成图片消息。
            // 但**表情消息本身就很小**（小黄脸 ~30px）：那条路要 allowSmall，
            // 否则表情的图永远抓不到，只剩「[表情]」三个字。
            if (im.tagName === 'IMG' && im.naturalWidth && im.naturalWidth < 60 && !allowSmall) continue;
            if (/aweme-avatar/i.test(String(im.currentSrc || im.src || ''))) continue;
            for (const attr of ['currentSrc', 'src', 'data-src', 'data-original', 'srcset']) {
              const v = im[attr] ?? im.getAttribute?.(attr);
              if (!v) continue;
              for (const piece of String(v).split(',')) {
                const u = absUrl(String(piece).trim().split(/\s+/)[0]);
                if (u && !/aweme-avatar/i.test(u)) out.push(u);
              }
            }
          }
          if (!out.length) {
            // 有些版本把图放在背景图里（div + background-image，甚至挂在 ::before 上）
            for (const n of [el, ...el.querySelectorAll('div, span')]) {
              for (const pseudo of [null, '::before', '::after']) {
                const bg = getComputedStyle(n, pseudo).backgroundImage || '';
                const m = /url\(["']?([^"')]+)/i.exec(bg);
                if (!m) continue;
                const u = absUrl(m[1]);
                if (u && !/aweme-avatar/i.test(u)) out.push(u);
              }
            }
          }
          return out;
        };
        /**
         * 图源也可能只存在这条消息的 React props 里（占位 div、懒加载、加密图）。
         * 扫一遍这条消息自己的 props，挑像图片 CDN 的字符串。
         */
        const imgFromProps = (el) => {
          const key = Object.keys(el).find((k) => k.indexOf('__reactProps$') === 0);
          if (!key) return '';
          const seen = new Set();
          let out = '';
          const walk = (v, d) => {
            if (out || !v || typeof v !== 'object' || d > 9 || seen.has(v)) return;
            seen.add(v);
            for (const k of Object.keys(v)) {
              if (k === '_owner' || k === 'ref' || k === 'return' || k === 'stateNode') continue;
              const val = v[k];
              if (typeof val === 'string') {
                const s = val.trim();
                if (
                  s.length > 24 &&
                  s.length < 600 &&
                  !/aweme-avatar/i.test(s) &&
                  /^(https?:)?\/\/[^\s"'<>]*(douyinpic|byteimg|snssdk|tplv|aweme)[^\s"'<>]*$/i.test(s)
                ) {
                  out = s;
                  return;
                }
              } else {
                walk(val, d + 1);
              }
              if (out) return;
            }
          };
          try {
            walk(el[key], 0);
          } catch {
            // 循环引用就算了
          }
          return out;
        };
        /**
         * 图源是 blob: / data: 时（抖音有些图是先取回来再用 blob URL 显示的），
         * 直接把字节读成 dataURL。blob 是同源的，不受 CORS 限制。
         */
        const dataUrlOf = async (el, minSide = 0) => {
          /**
           * 抖音的聊天图是**加密存的**：CDN 上直接下回来是一堆随机字节（实测 200 + application/octet-stream），
           * 由页面脚本解密后再画出来。所以真正能用的只有「屏幕上已经解出来的画面」：
           *   - canvas（解密后画上去的）
           *   - <img src="blob:...">（解密后生成的 blob）
           *   - 元素/伪元素的 background-image 是 blob:
           * 直接下 CDN 那条路只在图片本来就没加密时才有用。
           */
          const big = (d) => d && d.length > 200;
          for (const cv of el.querySelectorAll('canvas')) {
            // minSide：表情那条路要排除 16px 的 UI 小图标（画出来只会是一团糊）
            if (!cv.width || !cv.height || cv.width < minSide) continue;
            if (cv.__strollData) return cv.__strollData;
            try {
              const d = cv.toDataURL('image/jpeg', 0.86);
              if (big(d)) {
                cv.__strollData = d;
                return d;
              }
            } catch {
              // 被污染的画布读不了，换下一个
            }
          }
          const im = el.querySelector('img');
          if (im) {
            const src = String(im.currentSrc || im.src || '');
            if (src.startsWith('data:image/')) return src;
            if (im.__strollData) return im.__strollData;
            if (src.startsWith('blob:')) {
              try {
                const r = await fetch(src);
                const b = await r.blob();
                const d = await new Promise((res) => {
                  const fr = new FileReader();
                  fr.onload = () => res(String(fr.result || ''));
                  fr.onerror = () => res('');
                  fr.readAsDataURL(b);
                });
                if (big(d)) im.__strollData = d;
                return big(d) ? d : '';
              } catch {
                // 落到下面的背景图
              }
            }
            // 普通 https 图：如果页面给它开了 CORS，画一轮也能拿到像素。
            // 头像不算（36px 那张，画出来也不是对方发的图）。
            if (im.complete && im.naturalWidth && im.naturalWidth >= minSide && !/aweme-avatar/i.test(src)) {
              try {
                const c = document.createElement('canvas');
                const scale = Math.min(1, 1280 / Math.max(im.naturalWidth, im.naturalHeight));
                c.width = Math.round(im.naturalWidth * scale);
                c.height = Math.round(im.naturalHeight * scale);
                c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
                const d = c.toDataURL('image/jpeg', 0.86);
                if (big(d)) {
                  im.__strollData = d;
                  return d;
                }
              } catch {
                // 跨域污染：读不了，退回下载
              }
            }
          }
          for (const n of [el, ...el.querySelectorAll('div, span')]) {
            const bg = getComputedStyle(n).backgroundImage || '';
            const m = /url\(["']?(blob:[^"')]+)/i.exec(bg);
            if (!m) continue;
            try {
              const r = await fetch(m[1]);
              const b = await r.blob();
              const d = await new Promise((res) => {
                const fr = new FileReader();
                fr.onload = () => res(String(fr.result || ''));
                fr.onerror = () => res('');
                fr.readAsDataURL(b);
              });
              if (big(d)) return d;
            } catch {
              // 下一个
            }
          }
          return '';
        };
        // 只解析最新的这些：DOM 是最新在前，整屏几百条全解析（每条都要走一遍 React props）
        // 纯属浪费，而且 MutationObserver 每抖一下都要跑一遍。
        const rows = Array.from(document.querySelectorAll('[data-e2e="msg-item-content"]')).slice(0, Math.max(n * 2, 12));
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
          let image = '';
          /**
           * 抖音的 emoji 经常把**名字**塞进 text / innerText（「[抠鼻]」「[微笑]」），
           * 只看 `p.text` 就会当成一句文字，走到 text 分支，永远取不到图——
           * 线上表现就是「只收到表情包的名字」。
           */
          const emojiFlag = !!(p.emoji_type || p.image_type || p.package_id || p.resource_type);
          const bracketOnly = /^\[[^\]\n]{1,12}\]$/.test(raw);
          const hasMedia = !!imgs || !!el.querySelector('canvas');
          /**
           * 只看名字就够了：抖音有些表情不是 <img>，而是 div 的 background-image
           * （有些还是加密的下发图），那种 `imgs` 是 0——以前因此判成「文字」，
           * 于是一个表情只剩个名字。进了这条分支至少会去 dataUrlOf / 背景图里捞一次。
           */
          const mediaLike = emojiFlag || bracketOnly;

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
          } else if (!mediaLike && p.text) {
            text = cut(p.text, 200);
            url = urlIn(text);
          } else if (!mediaLike && raw) {
            text = cut(raw, 200);
            url = urlIn(raw);
          } else if (hasMedia || mediaLike) {
            // 大表情 / 贴纸也走 img，但 props 里有 emoji_type / package_id 这些标记；
            // 有些图是解密后画到 canvas 上的，没有 img
            const isEmoji = emojiFlag || bracketOnly;
            kind = isEmoji ? 'emoji' : 'image';
            // 有名字就用名字（「[抠鼻]」），比一个「[表情]」有用；没名字才用占位
            text = isEmoji ? (bracketOnly ? raw : '[表情]') : `[图片${imgs > 1 ? `×${imgs}` : ''}]`;
            /**
             * 图片和表情走**同一条**取像素的路。
             *
             * 以前这行是 `kind === 'image' ? await dataUrlOf(el) : ''`——表情被明确跳过，
             * 于是永远只有「[表情]」三个字，线上就是「看不到表情包，只有表情两个字」。
             * 抖音的表情多半是加密 CDN、blob 或 canvas，只有这条路能拿到画面。
             */
            let shown = await dataUrlOf(el, isEmoji ? 16 : 0);
            if (!shown) {
              const row = rowOf(el);
              if (row && row !== el) shown = await dataUrlOf(row, isEmoji ? 16 : 0);
            }
            let cand = urlsIn(el, isEmoji);
            if (!cand.length) {
              const row = rowOf(el);
              if (row && row !== el) cand = urlsIn(row, isEmoji);
            }
            const propUrl = absUrl(imgFromProps(el) || p.url || p.image_url || p.origin_url || p.image?.url || '');
            // 有签名参数的那条才是能下的（srcset 里常混一条没有 query 的缩略图地址）
            const signed = cand.find((u) => /[?&](x-signature|lk3s)=/i.test(u));
            image =
              shown ||
              signed ||
              cand.find((u) => /douyinpic|byteimg|snssdk|aweme|tplv/i.test(u)) ||
              cand[0] ||
              propUrl;
            if (!image) {
              // 还是找不到：把这一行的 HTML 留给主进程落盘
              try {
                window.__strollLastImgHtml = String((rowOf(el) || el).outerHTML || '').slice(0, 12000);
              } catch {
                // 算了
              }
            }
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
            image,
            // 先记下「这一条自己带没带名字」，没带的由下面统一继承
            who: mine ? '' : nick,
            // 这一条是不是新一段消息的开头：是的话不能沿用上一个人的名字
            runStart: mine ? false : startsRun(el),
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
          else if (m.runStart) {
            // 新的一段开始了，但这一版没读到名字：宁可标成「有人」，
            // 也不能沿用上一个人的名字——线上就是这样把别人说的话全算成了主人。
            lastWho = '';
          } else if (lastWho) m.who = lastWho;
        }
        for (const m of ordered) delete m.runStart;
        return ordered;
      }, [size, group, selfName])
      .catch(() => []);
    // 有「[图片]」却取不到地址时，页面里会留一份现场，这里落盘（5 分钟最多一份）
    const miss = await page
      .evaluate(() => {
        const h = window.__strollLastImgHtml;
        window.__strollLastImgHtml = '';
        return h || '';
      })
      .catch(() => '');
    if (miss) this.dumpImageMissingOnce(miss).catch(() => {});
    return rows;
  }

  /**
   * 图片消息取不到地址时留证。
   * `[图片]` 是能看见的，地址却抓不到，说明这一版把图放在我们没想到的地方——
   * 存下这一行的 HTML，下次照着改，别再猜。
   */
  async dumpImageMissingOnce(html) {
    if (Date.now() - Number(this._imgDumpAt ?? 0) < 5 * 60 * 1000) return '';
    this._imgDumpAt = Date.now();
    try {
      const dir = path.join(this.dataDir, 'stroll', 'debug');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `image-missing-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
      fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), html: String(html).slice(0, 20000) }, null, 1));
      return file;
    } catch {
      return '';
    }
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
    const out = rows.map((m) => (m.from === 'them' && this.wasJustSent(m.text) ? { ...m, from: 'me', who: '' } : m));
    /**
     * 一段里「别人说的话」全标成同一个人 = 昵称没读对（线上就是这样把三个人说的话
     * 全算成了主人）。这时候留一份现场，下次照着真实结构改，不用再猜。
     */
    const theirs = out.filter((m) => m.from === 'them');
    const names = new Set(theirs.map((m) => m.who).filter(Boolean));
    if (theirs.length >= 3 && names.size === 1) this.dumpGroupWhoOnce(page, out).catch(() => {});
    return out;
  }

  /**
   * 发言人认错时留证：把消息列表最后几行的 HTML 存一份。
   * 10 分钟最多存一次，别把磁盘写满。
   */
  async dumpGroupWhoOnce(page, rows) {
    if (Date.now() - Number(this._whoDumpAt ?? 0) < 10 * 60 * 1000) return '';
    this._whoDumpAt = Date.now();
    const html = await page
      .evaluate(() => {
        const list = document.querySelector('[class*="messageMessageListlist"]');
        const kids = list ? Array.from(list.children).slice(-6) : [];
        return kids
          .map((r) => String(r.outerHTML || '').slice(0, 4500))
          .join('\n<!-- ---- -->\n')
          .slice(0, 20000);
      })
      .catch(() => '');
    if (!html) return '';
    try {
      const dir = path.join(this.dataDir, 'stroll', 'debug');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `group-who-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
      // 图片可能是整段 dataURL，落盘时压掉，别让 dump 变成几 MB
      const safe = (rows ?? []).map((r) => ({
        ...r,
        image: String(r?.image ?? '').startsWith('data:') ? '[data-url]' : r?.image,
      }));
      fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), rows: safe, html }, null, 1));
      return file;
    } catch {
      return '';
    }
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
          const nickOf = (el) => {
            const sels = [
              '[class*="MessageBoxMessageTitleavatarName"]',
              '[class*="avatarName"]',
              '[class*="MessageBoxMessageTitle"]',
              '[class*="nickname"]',
              '[class*="Nickname"]',
              '[class*="userName"]',
              '[class*="UserName"]',
            ];
            for (const s of sels) {
              const node = el.querySelector(s);
              const t = clean(node?.innerText);
              if (t) {
                // 角色标签可能在前也可能在后
                return t.replace(/^(群主|管理员|群成员|成员)\s*/, '').replace(/\s*(群主|管理员|群成员|成员)$/, '');
              }
            }
            return '';
          };
          out.push({
            from: me ? 'me' : 'them',
            kind: content.querySelector('img') ? 'image' : 'text',
            text,
            url: '',
            title: '',
            author: '',
            image: (() => {
              const im = content.querySelector('img');
              const raw = String(im?.currentSrc || im?.getAttribute?.('data-src') || im?.getAttribute?.('src') || im?.src || '').trim();
              if (raw.startsWith('//')) return `https:${raw}`;
              return /^https?:\/\//i.test(raw) ? raw : '';
            })(),
            who: me ? '' : nickOf(box),
            runStart: me ? false : !!box.querySelector('[class*="avatar"]'),
          });
        }
        // 和 readMessages 一样：新一段没读到名字就别沿用上一个人的
        let last = '';
        for (const m of out) {
          if (m.from === 'me') { last = ''; continue; }
          if (m.who) last = m.who;
          else if (m.runStart) last = '';
          else if (last) m.who = last;
          delete m.runStart;
        }
        return out;
      }, size)
      .catch(() => []);
  }

  /** 点开某个会话并读消息。已经在这个会话里就不重复点。 */
  /**
   * 读某个**陌生人**的最后几条消息。
   *
   * 陌生人不在主会话列表里，`readThread` 那种 hasText 点击找不到；得走「陌生人消息」文件夹。
   * 用「回私信」那个常驻页（chatPage），不碰主人的监听页（dmPage）——否则读一眼陌生人
   * 就把主人那边的会话切走了。
   *
   * 读不到就返回 []：调用方退回列表预览。宁可只有一个占位文案，
   * 也不能因为「切不过去」就把当前会话（可能是主人的）的话当成他说的。
   */
  async readStrangerThread(who, size = 8, { preview = '' } = {}) {
    const want = String(who ?? '').trim();
    if (!want) return [];
    return this.serialize(async () => {
      let page = null;
      let openedFolder = false;
      // 留一份诊断：读不到时能看出是「标题读不出」「点不到行」还是「内容对不上」
      const trace = { who: want, via: '', title: '', clicked: false, mode: '', msgs: 0 };
      try {
        /**
         * ① 有常驻页：直接读，不点、不导航——和主人私信完全同一条路。
         * 这是「把主人那套复制过来」的关键：页面本来就停在对方身上。
         */
        const pinned = this.strangerPages?.get(want);
        if (pinned?.page && !pinned.page.isClosed() && pinned.thread === want) {
          trace.via = 'pinned';
          const msgs = await this.readMessages(pinned.page, size).catch(() => []);
          trace.msgs = Array.isArray(msgs) ? msgs.length : 0;
          trace.sample = this.sampleOf(msgs);
          const mode = this.threadMatchMode(msgs, preview);
          trace.mode = mode;
          if (mode) return this.pickStrangerMsgs(msgs, mode);
          /**
           * 常驻页读出来对不上：多半是**后台标签页还停在上一句**。
           * 这里直接返回空，让上层走「补图」那条路（刷新页面再读）。
           * 不再退到共享页再点一圈——那要 2.4 秒，而且读到的大概率也是旧内容。
           */
          trace.via = 'pinned-miss';
          return [];
        }
        trace.via = 'chat';
        page = await this.chatPageForSend();
        // 不查 isLoggedIn：它要读 cookie 再探一次会话，白花几百毫秒。
        // 没登录的话下面点会话本身就会失败，返回空即可。
        if (!/\/chat/.test(String(page.url?.() ?? ''))) await this.gotoChat(page);
        // ① 已经停在同一个人身上（标题读得出来时）
        const title = await this.currentChatTitle(page).catch(() => '');
        trace.title = String(title ?? '').slice(0, 24);
        if (title && this.threadTitleMatches(title, want)) {
          const msgs = await this.readMessages(page, size).catch(() => []);
          const mode = this.threadMatchMode(msgs, preview);
          if (mode) {
            const picked = this.pickStrangerMsgs(msgs, mode);
            trace.mode = mode;
            trace.msgs = picked.length;
            return picked;
          }
        }
        /**
         * ② 点开这个人。
         * 标题在这个布局里读不出来是常态（上一版就是卡在这里，永远返回空）——
         * 所以 blind 点一下，**用「读到的内容」去核对**，而不是靠标题。
         */
        const clicked = await this.clickStrangerThread(page, want, { blind: true }).catch(() => false);
        trace.clicked = !!clicked;
        // 这个函数会自己打开「陌生人消息」文件夹
        if (clicked) {
          openedFolder = true;
          // 页面确实切过来了：记下来，后面发送就不用再点（200ms 级）
          this.chatThread = want;
        }
        if (!clicked) {
          // 也可能是已经变成好友的（在主列表里）
          const main = await this.clickThread(page, want).catch(() => false);
          if (!main) return [];
        }
        const deadline = Date.now() + 1200;
        while (Date.now() < deadline) {
          const msgs = await this.readMessages(page, size).catch(() => []);
          trace.msgs = Array.isArray(msgs) ? msgs.length : 0;
          trace.sample = this.sampleOf(msgs);
          const mode = this.threadMatchMode(msgs, preview);
          trace.mode = mode;
          if (mode) return this.pickStrangerMsgs(msgs, mode);
          await page.waitForTimeout(120);
        }
        return [];
      } catch {
        return [];
      } finally {
        this.lastStrangerRead = trace;
        // 文件夹是浮层：只有我们自己打开的才收起来，别乱点返回
        if (openedFolder && page && !page.isClosed()) await this.closeStrangerInbox(page).catch(() => {});
      }
    });
  }

  /**
   * 只把「确认是这个会话」的消息交出去。
   *
   * media 模式下**只留表情/图片这类消息**：万一切错了会话，
   * 顶多把别人的一个表情当成他的，不会把别人的文字带出去。
   */
  pickStrangerMsgs(msgs, mode) {
    const list = (Array.isArray(msgs) ? msgs : []).filter((m) => m && m.from !== 'me');
    if (!list.length) return [];
    if (mode === 'media') {
      return list.filter((m) => ['emoji', 'image', 'share', 'card'].includes(m.kind)).slice(-2);
    }
    return list.slice(-3);
  }

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

  /** 读会话列表里的行（纯 DOM，不导航、不点击）。 */
  async readThreadRows(page) {
    return await page
      .evaluate(() => {
        const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
        /**
         * 私信会话的 React props 里有 `toParticipantSecUserId`（对方 sec_uid），
         * 群会话这个字段是空串（实测 2026-11）。比「名字里有没有逗号」可靠得多：
         * 群没起名时抖音会把成员名拼起来，但起了名的群就不带逗号了。
         * 拿不到 props 时退回形状启发式。
         */
        const conversationMeta = (el) => {
          const key =
            Object.keys(el).find((k) => k.indexOf('__reactProps$') === 0) ||
            Object.keys(el).find((k) => k.indexOf('__reactFiber$') === 0);
          if (!key) return null;
          const seen = new Set();
          const acc = { secUid: '', sortOrder: 0, cid: '', hasSec: false };
          const walk = (v, d) => {
            if (!v || typeof v !== 'object' || d > 8 || seen.has(v)) return;
            seen.add(v);
            // 会话 id：两个群同名时（同一批人建的两个群，标题一模一样）只能靠它区分
            if (!acc.cid) {
              const cid = v.conversationId ?? v.conversationShortId ?? v.convId;
              if (typeof cid === 'string' && cid) acc.cid = cid;
            }
            if (Object.prototype.hasOwnProperty.call(v, 'toParticipantSecUserId')) {
              acc.secUid = String(v.toParticipantSecUserId ?? '');
              acc.sortOrder = Number(v.sortOrder ?? 0);
              acc.hasSec = true;
              return;
            }
            for (const k of Object.keys(v)) {
              if (k === '_owner' || k === 'ref' || k === 'return' || k === 'stateNode' || k === 'child' || k === 'sibling') continue;
              walk(v[k], d + 1);
            }
          };
          try {
            walk(el[key], 0);
          } catch {
            // props 里有循环引用就算没有
          }
          return acc.hasSec || acc.cid ? acc : null;
        };
        return Array.from(document.querySelectorAll('[data-e2e="conversation-item"]'))
          .slice(0, 60)
          .map((el) => {
            const lines = (el.innerText || '').split('\n').map(clean).filter(Boolean);
            const badge = el.querySelector('[class*="unread"], [class*="Unread"]');
            const unread = Number(clean(badge?.innerText).replace(/\D/g, '')) || 0;
            const meta = conversationMeta(el);
            const name = lines[0] || '';
            /**
             * 群判据（按可靠程度）：
             * 1) props 里 toParticipantSecUserId 是空串 —— 实测最准；
             * 2) 行里有多个头像（群头像是几个人的头像拼的）；
             * 3) 名字是成员名用逗号拼起来的（没起名的群）；
             * 4) 行里有群图标/群角标。
             * 2-4 只在拿不到 props 时才用，免得把普通私信当群。
             */
            const avatars = el.querySelectorAll('img').length;
            const groupMark = !!el.querySelector(
              '[class*="groupIcon"], [class*="GroupIcon"], [class*="teamIcon"], [class*="groupTag"], [class*="GroupTag"]',
            );
            const nameParts = name.split(/[,，、]/).map((s) => clean(s)).filter(Boolean);
            const looksGroup = avatars >= 2 || groupMark || nameParts.length >= 2;
            const isGroup = meta?.hasSec ? meta.secUid === '' : looksGroup;
            // 把会话 id 打到 DOM 上：两个群同名时，点会话要靠它才分得清
            if (meta?.cid) el.setAttribute('data-stroll-cid', meta.cid);
            return {
              name,
              preview: lines.slice(1).join(' ').slice(0, 60),
              unread,
              kind: isGroup ? 'group' : 'dm',
              secUid: meta?.secUid || '',
              cid: meta?.cid || '',
              lastAt: meta?.sortOrder || 0,
            };
          })
          .filter((x) => x.name);
      })
      .catch(() => []);
  }

  /** 把会话列表滚到顶/底：抖音的列表是虚拟的，不滚的话只有看得见的那几条。 */
  async scrollThreadList(page, to = 'bottom') {
    const moved = await page
      .evaluate((dir) => {
        const items = Array.from(document.querySelectorAll('[data-e2e="conversation-item"]'));
        if (!items.length) return false;
        let box = items[0].parentElement;
        for (let i = 0; i < 6 && box; i += 1) {
          if (box.scrollHeight > box.clientHeight + 24) break;
          box = box.parentElement;
        }
        if (!box) return false;
        const target = dir === 'bottom' ? box.scrollHeight : 0;
        if (Math.abs(box.scrollTop - target) < 4) return false;
        box.scrollTop = target;
        box.dispatchEvent(new Event('scroll', { bubbles: true }));
        return true;
      }, to)
      .catch(() => false);
    if (moved) await page.waitForTimeout(420);
    return moved;
  }

  /** 读全部会话行。deep=true 时上下各滚一遍，把虚拟列表外面的也捞出来。 */
  async allThreadRows(page, { deep = false } = {}) {
    const out = new Map();
    const add = (rows) => {
      for (const r of rows) if (r?.name) out.set(r.name, { ...(out.get(r.name) ?? {}), ...r });
    };
    add(await this.readThreadRows(page));
    if (deep) {
      await this.scrollThreadList(page, 'bottom');
      add(await this.readThreadRows(page));
      await this.scrollThreadList(page, 'top');
      add(await this.readThreadRows(page));
    }
    return Array.from(out.values());
  }

  /**
   * 列出现在有哪些会话（零点击、不跳转会话）。
   * 抖音网页版把群和私信放在同一个列表里，所以两边都返回，由调用方按 kind / 名字认群。
   * deep=true 会滚动列表，把虚拟列表里看不见的会话也读出来。
   */
  async listThreads({ deep = false } = {}) {
    // 已经有页面停在 /chat（私信页、群监听页）就直接读它：
    // 不为了一份列表把主页面从正在看的视频上拽到 /chat
    const live = [this.dmPage, ...Array.from(this.groupPages?.values?.() ?? []).map((s) => s.page), this.page].find(
      (p) => p && !p.isClosed() && /\/chat/.test(p.url()),
    );
    if (live) {
      const rows = await this.allThreadRows(live, { deep });
      if (rows.length) return { ok: true, threads: rows, via: 'live' };
    }
    return this.serialize(async () => {
      const page = await this.getPage();
      if (!(await this.isLoggedIn())) throw new DouyinError('LOGIN_REQUIRED', '抖音还没登录，看不了会话列表');
      if (!/\/chat/.test(page.url())) await this.goto(page, `${ORIGIN}/chat`, 2600);
      await this.dismissBubbles(page);
      const rows = await this.allThreadRows(page, { deep });
      this.scheduleClose(60);
      return { ok: true, threads: rows, via: 'main' };
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
    /**
     * 只认抖音自己的域名。
     *
     * 这个动作会真的把她的浏览器导航过去，然后在页面上按文字找「加入群聊」点一下——
     * 等于「任意网址 + 一次可被诱导的点击」。别人发一个精心做的钓鱼页，
     * 就能借她的手点不该点的地方。群邀请只会来自抖音，别的域名一律不进。
     */
    let host = '';
    try {
      host = new URL(link).hostname.toLowerCase();
    } catch {
      throw new DouyinError('BAD_LINK', '这个链接读不出来，换一个。');
    }
    const trusted = /(^|\.)douyin\.com$/.test(host) || /(^|\.)iesdouyin\.com$/.test(host);
    if (!trusted) {
      throw new DouyinError('BAD_LINK', `只认抖音的群邀请链接（douyin.com），这个是 ${host}，不进。`);
    }
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
      /**
       * 先确认这一页还停在主人身上。
       * 抖音可能自己把会话切走（新建群、点进别人的消息、刷新），
       * 页面没关、观察器还活着，`dmThread` 却已经过期——这时读到的是别人/群的聊天，
       * 却被当成「主人发私信了」。新开群后私信突然不回，就是这种错位。
       */
      /**
       * 读之前必须按昵称重新点一次会话。
       *
       * 这里以前是「标题读不出来就放过」（`const onOwner = !title || ...`）——
       * 而这个号 `currentChatTitle` **恒为空**，于是页面停在群里时照样往下读，
       * 读到的是群消息；群里最后一条通常是「我发的」，`dmTailOf` 取不到尾巴，
       * 判定「没有新私信」→ 主人的话永远推不过来。
       * 2026-11-12 13:04「私信已读不回」就是这么来的：她根本没收到通知。
       */
      const clicked = await this.reopenThread(dm, who).catch(() => false);
      if (!clicked) {
        // 点不到就不读：与其把别人/群的会话当成主人的，不如这一轮跳过
        this.log?.info?.('stroll dm peek miss', { who, url: String(dm.url?.() ?? '') });
        return { ok: false, code: 'THREAD_DRIFT', messages: [] };
      }
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
      // 缓存只当「防 -509 的秒级短路」：最多 5 秒，而且有未读就直接点开，
      // 免得预览行没变时把新消息（尤其是同一句/图片）一直挡在缓存里
      if (
        row &&
        cache &&
        cache.name === who &&
        cache.preview === row.preview &&
        Number(row.unread ?? 0) === 0 &&
        Date.now() - Number(cache.at ?? 0) < 5000 &&
        cache.messages?.length
      ) {
        return { ok: true, messages: cache.messages, cached: true };
      }
      const messages = await this.readThread(page, who, size).catch(() => []);
      if (row) this.peekCache = { name: who, preview: row.preview, messages, at: Date.now() };
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
  async replyDm(name, text, { mention = '', strict = false, requireTitle = false } = {}) {
    const who = String(name ?? '').trim();
    if (!who) throw new DouyinError('BAD_TARGET', '没有会话昵称，回不了');
    // 各段耗时带上：主人在追「一秒内」，得知道慢在哪一段（挂在回执里，不额外打日志）
    const t0 = Date.now();
    // 私信页正停在这个会话上：不用跳转、不用点会话，直接打字回车。
    // 这是「秒回」的关键一段——省掉整页导航（6-8 秒）和点会话后的固定停顿（2.4 秒）。
    const dm = this.dmPage;
    // 诊断用：只在失败/走兜底时打一行，正常发送零开销
    const diag = { who, dmThread: this.dmThread, chatThread: this.chatThread, steps: [] };
    if (dm && !dm.isClosed() && this.dmThread === who) {
      /**
       * 不信任 `dmThread`，发送前一律按昵称重新点一次会话。
       *
       * 以前这里是 `ensureThreadOpen(dm, who, { strict })`：它读会话标题，读不到就直接
       * `return true`（`strict` 只管「点完再核一次标题」，标题为空时同样不起作用）。
       * 而这个号 `currentChatTitle` **恒为空**（日志里 `stroll chat title miss`），
       * 于是那句「核实」永远通过——只要页面被抖音自己导航走（刷新后恢复上次会话、
       * SPA 路由、手动切过），私信就原地打进当时开着的群。
       * 2026-11-08 三条私信进群、2026-11-12 13:06 又进「测试2」，都是这条路。
       * 点一次 0.2~0.4 秒，比把私信发到群里便宜。
       */
      const clicked = await this.reopenThread(dm, who).catch(() => false);
      if (!clicked) {
        this.dmThread = '';
        diag.steps.push('dmPage:click-miss');
        diag.dmTitle = await this.currentChatTitle(dm).catch(() => '');
        diag.dmUrl = String(dm.url?.() ?? '');
      } else {
        const t1 = Date.now();
        const input = await this.waitMsgInput(dm, 3000).catch(() => null);
        if (input) {
          const t2 = Date.now();
          await this.sendInChat(dm, input, text, { mention });
          this.lastAction = `dm ${who}`;
          return {
            ok: true, sent: true, fast: true,
            ms: { prep: t1 - t0, input: t2 - t1, send: Date.now() - t2, total: Date.now() - t0 },
            mentioned: mention ? !!this.lastMention : null,
            mentionDebug: this.lastMention ? '' : this.lastMentionDump || '',
          };
        }
      }
    }
    /**
     * 陌生人的常驻页：页面就停在他身上（建页时按整串同名点过，之后只读不导航）。
     * 和主人私信那条一眼——不用找、不用点、不用跳转，直接打字回车。
     */
    const sp = this.strangerPages?.get(who);
    if (sp?.page && !sp.page.isClosed() && sp.thread === who) {
      const input = await this.waitMsgInput(sp.page, 3000).catch(() => null);
      if (input) {
        const t1 = Date.now();
        await this.sendInChat(sp.page, input, text, { mention });
        this.lastAction = `dm ${who}`;
        sp.at = Date.now();
        return {
          ok: true, sent: true, fast: true, pinned: true,
          ms: { prep: t1 - t0, input: 0, send: Date.now() - t1, total: Date.now() - t0 },
          mentioned: mention ? !!this.lastMention : null,
          mentionDebug: this.lastMention ? '' : this.lastMentionDump || '',
        };
      }
    }
    // 群：那个群的监听页正停在群里，同样可以直接在那页打字（零跳转）
    const slot = this.groupPages?.get?.(who);
    if (slot?.page && !slot.page.isClosed() && slot.thread === who) {
      // 和主人私信同一条规矩：读不到标题，slot.thread 只是缓存，发前点一次再发
      const clicked = await this.reopenThread(slot.page, who).catch(() => false);
      if (clicked) {
        const t1 = Date.now();
        const input = await this.waitMsgInput(slot.page, 3000).catch(() => null);
        if (input) {
          const t2 = Date.now();
          await this.sendInChat(slot.page, input, text, { mention });
          this.lastAction = `group ${who}`;
          return {
            ok: true, sent: true, fast: true, group: true,
            ms: { prep: t1 - t0, input: t2 - t1, send: Date.now() - t2, total: Date.now() - t0 },
            mentioned: mention ? !!this.lastMention : null,
            mentionDebug: this.lastMention ? '' : this.lastMentionDump || '',
          };
        }
      }
    }
    return this.serialize(async () => {
      // 专用页：发完留在那个人的会话上，下一次同一个人的回复就是毫秒级
      const page = await this.chatPageForSend();
      if (!(await this.isLoggedIn())) throw new DouyinError('LOGIN_REQUIRED', '抖音还没登录，发不了私信');
      try {
        // 已经在这个会话里就直接用：省一次整页跳转和点击，回私信快好几秒
        // 用 chatThread 而不是 openThread：后者被 dmPage 的读取共用，会误判
        const needSwitch = this.chatThread !== who || !/\/chat/.test(page.url());
        // 点之前先记一份内容指纹：这套页面读不出标题，靠「内容有没有换」判断切没切过去
        let before = null;
        /**
         * 不管 needSwitch 都点一次目标会话。
         * `chatThread` 只是缓存，页面被抖音自己导航走之后它不会更新；标题又读不出来，
         * 于是 `verifyThread` 在 needSwitch=false 时直接放行——私信就发进了当时开着的群。
         * 已经在目标会话时点它自己无害（只是重新激活列表里的那一行）。
         */
        if (!/\/chat/.test(page.url())) await this.gotoChat(page);
        before = await this.threadFingerprint(page);
        let ok = await this.clickThread(page, who);
        diag.steps.push(`click:${ok ? 'ok' : 'miss'}`);
        if (!ok) {
          // 主列表里没有：抖音会把非好友的私信收进「陌生人消息」文件夹
          ok = await this.clickStrangerThread(page, who);
          diag.steps.push(`stranger:${ok ? 'ok' : 'miss'}`);
        }
        if (!ok) {
          diag.chatUrl = String(page.url?.() ?? '');
          diag.chatTitle = await this.currentChatTitle(page).catch(() => '');
          this.log?.info?.('stroll dm diag', { ...diag, fail: 'NO_DM' });
          throw new DouyinError('NO_DM', '聊天列表和「陌生人消息」里都找不到这个会话，可能被新消息刷下去了');
        }
        // 点完不用干等两秒：下面 waitMsgInput 会一轮一轮等到输入框真的能打字
        await page.waitForTimeout(200);
        /**
         * 先核实、再认账。
         * 以前点完就把 chatThread 记成 who：只要那一下点空了（限流 toast 盖住列表时很常见），
         * 后面每一条都会跳过点击、直接打进当前开着的会话——2026-11-08 那三条私信进群就是这么来的。
         */
        const readTitle = async () => await this.currentChatTitle(page).catch(() => '');
        /**
         * 核实「页面真的切过去了」：
         *   标题读得出来 → 按标题比；
         *   标题读不出来（这套页面就是这样）→ 看会话内容有没有换过。
         * 都不通过就不发——比把私信打进群聊强。
         */
        const verifyThread = async () => {
          const t = await readTitle();
          if (t) return this.threadTitleMatches(t, who);
          return needSwitch ? await this.waitThreadChanged(page, before) : true;
        };
        if (!(await verifyThread())) {
          // 可能是点空了（限流 toast 盖住列表时很常见）：再点一次再核
          diag.steps.push('retry-click');
          await this.clickThread(page, who).catch(() => {});
          await page.waitForTimeout(300);
          if (!(await verifyThread())) {
            // 没核实通过就把缓存清掉，别让下一条继续错下去
            if (this.chatThread === who) this.chatThread = '';
            if (this.openThread === who) this.openThread = '';
            const driftTitle = await readTitle();
            this.log?.info?.('stroll thread drift', {
              who,
              title: driftTitle,
              url: String(page.url?.() ?? ''),
              needSwitch,
              steps: diag.steps,
            });
            throw new DouyinError('THREAD_DRIFT', `页面没切到「${who}」这个会话（标题：${driftTitle || '空'}），没发`);
          }
        }
        this.openThread = who;
        this.chatThread = who;
        const input = await this.waitMsgInput(page, 6000);
        if (!input) {
          diag.chatUrl = String(page.url?.() ?? '');
          diag.chatTitle = await this.currentChatTitle(page).catch(() => '');
          this.log?.info?.('stroll dm diag', { ...diag, fail: 'NO_INPUT' });
          throw new DouyinError('NO_INPUT', '没找到输入框，抖音可能改版了');
        }
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
    /**
     * 两个群同名时（同一批人建的两个群，抖音没起名，标题就是同一串成员名），
     * 光凭标题永远点不到第二个。resolveGroups 会给它们加「#2」后缀，
     * 并在读列表时把会话 id 打到 DOM 上——这里优先按会话 id 点。
     */
    const m = /^(.*?)\s*#(\d+)$/.exec(want);
    const base = (m ? m[1] : want).trim();
    const nth = m ? Math.max(1, Number(m[2])) : 0;
    const cid = String(this.threadCids?.[want] ?? '');
    const box = await page
      .evaluate(
        ({ target, nth, cid }) => {
          const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
          const items = Array.from(document.querySelectorAll('[data-e2e="conversation-item"]'));
          const titleOf = (el) => {
            const t = el.querySelector('[class*="ConversationItemtitle"]');
            const line = String((el.innerText || '').split('\n')[0] || '');
            const raw = norm(t?.innerText || line);
            /**
             * 列表标题常黏着时间（`小鹿 刚刚`、`小鹿 10:55`）。
             * 不剥的话 exact 永远不成立，只能落到「包含」；而群名也可能含这个人名
             * （`群A、小鹿`），包含就会同时命中两条 → 判成歧义 → 直接返回 false，
             * 表现就是「列表里明明看得见，发的时候说找不到」。
             */
            return raw
              .replace(
                /\s+(刚刚|\d{1,2}:\d{2}|昨天|前天|星期[一二三四五六日]|\d+\s*(?:秒|分钟|小时|天)前|\d{1,2}-\d{1,2})$/,
                '',
              )
              .trim();
          };
          let hit = null;
          if (cid) hit = items.find((el) => el.getAttribute('data-stroll-cid') === cid) ?? null;
          if (!hit) {
            const exact = items.filter((el) => titleOf(el) === norm(target));
            if (nth > 0) hit = exact[nth - 1] ?? null;
            else hit = exact[0] ?? null;
          }
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
        },
        { target: base, nth, cid },
      )
      .catch(() => null);
    if (box) {
      await page.mouse.click(box.x, box.y).catch(() => {});
      return true;
    }
    /**
     * 还没找到：会话可能在列表很下面（昨晚的消息，中间刷了十几个小时）。
     * 抖音的会话列表是**虚拟滚动**，屏幕外的行根本不在 DOM 里，`querySelectorAll`
     * 看不到——所以先滚到顶，再一屏一屏往下找。
     */
    const found = await this.scrollConversationList(page, async () =>
      page
        .evaluate(
          ({ target, nth, cid }) => {
            const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
            const items = Array.from(document.querySelectorAll('[data-e2e="conversation-item"]'));
            const titleOf = (el) => {
              const t = el.querySelector('[class*="ConversationItemtitle"]');
              const line = String((el.innerText || '').split('\n')[0] || '');
              return norm(t?.innerText || line)
                .replace(
                  /\s+(刚刚|\d{1,2}:\d{2}|昨天|前天|星期[一二三四五六日]|\d+\s*(?:秒|分钟|小时|天)前|\d{1,2}-\d{1,2})$/,
                  '',
                )
                .trim();
            };
            let hit = null;
            if (cid) hit = items.find((el) => el.getAttribute('data-stroll-cid') === cid) ?? null;
            if (!hit) {
              const exact = items.filter((el) => titleOf(el) === norm(target));
              hit = (nth > 0 ? exact[nth - 1] : exact[0]) ?? null;
            }
            if (!hit) {
              const partial = items.filter((el) => titleOf(el).includes(norm(target)));
              if (partial.length === 1) hit = partial[0];
            }
            if (!hit) return null;
            hit.scrollIntoView({ block: 'nearest' });
            const r = hit.getBoundingClientRect();
            if (r.width < 10 || r.height < 10) return null;
            return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
          },
          { target: base, nth, cid },
        )
        .catch(() => null),
    );
    if (!found) return false;
    await page.mouse.click(found.x, found.y).catch(() => {});
    return true;
  }

  /**
   * 在会话列表里一段一段往下滚，每滚一次调一次 `find()`。
   * 不依赖类名：从第一条会话往上找「overflow-y 真的能滚」的那个祖先。
   */
  async scrollConversationList(page, find, { tries = 10 } = {}) {
    const toTop = () => {
      const el = document.querySelector('[data-e2e="conversation-item"]');
      let p = el?.parentElement ?? null;
      while (p) {
        const st = getComputedStyle(p);
        if (/(auto|scroll|overlay)/.test(st.overflowY) && p.scrollHeight > p.clientHeight + 20) {
          p.scrollTop = 0;
          return;
        }
        p = p.parentElement;
      }
    };
    const step = () => {
      const el = document.querySelector('[data-e2e="conversation-item"]');
      let p = el?.parentElement ?? null;
      while (p) {
        const st = getComputedStyle(p);
        if (/(auto|scroll|overlay)/.test(st.overflowY) && p.scrollHeight > p.clientHeight + 20) {
          const before = p.scrollTop;
          p.scrollTop = before + Math.max(80, Math.round(p.clientHeight * 0.75));
          return p.scrollTop !== before;
        }
        p = p.parentElement;
      }
      return false;
    };
    // 先回到顶部：目标可能在上面，从当前位置往下滚永远到不了
    await page.evaluate(toTop).catch(() => {});
    await page.waitForTimeout(120);
    for (let i = 0; i < tries; i += 1) {
      const moved = await page.evaluate(step).catch(() => false);
      if (!moved) break;
      await page.waitForTimeout(160);
      const hit = await find();
      if (hit) return hit;
    }
    return null;
  }

  /** 读聊天页顶部那个会话标题（认不出就返回空串，调用方当「不校验」处理）。 */
  async currentChatTitle(page) {
    return await page
      .evaluate(() => {
        const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
        const nodes = document.querySelectorAll(
          '[data-e2e="chat-title"], [data-e2e="conversation-title"], [class*="ConversationHeader"], [class*="ChatHeader"], [class*="conversationHeader"], [class*="chatHeader"], [class*="ChatTitle"], [class*="chatTitle"], [class*="ConversationTitle"], [class*="conversationTitle"]',
        );
        for (const n of nodes) {
          const r = n.getBoundingClientRect();
          if (r.width < 40 || r.height < 12 || r.y > window.innerHeight * 0.6) continue;
          const t = clean(n.innerText);
          if (t && t.length <= 60) return t;
        }
        /**
         * 不做「猜一个短文本」的兜底：猜错（比如抓到「发消息」按钮）比抓不到更糟——
         * 抓不到时调用方按「读不出来」放行，猜错会变成「明明停在这个人这儿，却判定没切过去」。
         * 类名全换了就返回空，靠下面的日志和 actual 行为去修选择器。
         */
        return '';
      })
      .catch(() => '');
  }

  /**
   * 会话内容指纹：切换会话之后这里会变。
   * 这套页面读不到标题（实测 `currentChatTitle` 一直返回空），所以「有没有真的切过去」
   * 只能靠内容变没变来判断——这也是 2.1.2 把主人私信逼进 20 秒慢路的原因。
   */
  async threadFingerprint(page) {
    return await page
      .evaluate(() => {
        const nodes = Array.from(document.querySelectorAll('[data-e2e="msg-item-content"]'));
        const txt = (n) => String(n?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
        return {
          n: nodes.length,
          first: nodes.length ? txt(nodes[0]) : '',
          last: nodes.length ? txt(nodes[nodes.length - 1]) : '',
        };
      })
      .catch(() => null);
  }

  /** 等内容真的换掉（切会话的动画/请求要一点时间）。读不到指纹时放行，别误伤。 */
  async waitThreadChanged(page, before, timeout = 1800) {
    if (!before) return true;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const now = await this.threadFingerprint(page);
      if (!now) return true;
      if (now.n !== before.n || now.last !== before.last || now.first !== before.first) return true;
      await page.waitForTimeout(120);
    }
    return false;
  }

  /** 会话标题比对：忽略空白、大小写和同名群的「#2」后缀；认不出标题时算匹配（别误伤）。 */
  threadTitleMatches(title, who) {
    const norm = (s) =>
      String(s ?? '')
        .replace(/\s*#\d+$/, '')
        // 标题常带群人数：「群C（3）」「群C 3人」
        .replace(/[（(]\s*\d+\s*[)）]\s*$/, '')
        .replace(/^\d+\s*人\s*/, '')
        .replace(/[\s\u3000]+/g, '')
        .toLowerCase();
    const t = norm(title);
    const w = norm(who);
    if (!t || !w) return true;
    // 群标题（成员名用逗号拼）和单个人的昵称不是一回事：
    // 主人的昵称本身是群名的一部分，不区分就会把「私信页」当成「群页」。
    const groupLike = (s) => /[,，、]/.test(s);
    if (groupLike(t) !== groupLike(w)) return false;
    return t === w || w.includes(t) || t.startsWith(w);
  }

  /**
   * 发之前确认这一页还停在目标会话上。
   * 群页是常驻的，抖音可能自己切到别的会话（新群、刷新、消息跳转）；
   * 不确认就往当前输入框里打字，话会落到另一个群里——看起来「发了」，群里却没有。
   */
  /**
   * 不信任任何缓存，按昵称在会话列表里重新点一次目标会话。
   *
   * 为什么不信缓存：这套页面 `currentChatTitle` 读出来恒为空，
   * `ensureThreadOpen` 在标题为空时直接放行，等于没核实；`dmThread` / `chatThread`
   * 只要和现实对不上（页面被抖音自己导航、刷新后恢复上次会话、手动切过），
   * 私信就会原地打进当时开着的群——2026-11-08 和 2026-11-12 两次事故都是这样。
   *
   * 点不到（列表里没有这个人/这个群）就返回 false，调用方必须不发，而不是猜一个。
   */
  async reopenThread(page, who, { wait = 160 } = {}) {
    if (!page || page.isClosed()) return false;
    const name = String(who ?? '').trim();
    if (!name) return false;
    if (!/\/chat/.test(String(page.url?.() ?? ''))) {
      await page.goto(`${ORIGIN}/chat`, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      await page.waitForTimeout(800).catch(() => {});
    }
    let ok = await this.clickThread(page, name).catch(() => false);
    if (!ok) ok = await this.clickStrangerThread(page, name).catch(() => false);
    if (!ok) return false;
    // 点完让切换落定：立刻打字会打在上一个会话里（正是「发进群」的形态）
    await page.waitForTimeout(wait).catch(() => {});
    return true;
  }

  async ensureThreadOpen(page, who, { strict = false, requireTitle = false } = {}) {
    let title = await this.currentChatTitle(page).catch(() => '');
    if (!title) {
      // 刚切换会话时标题可能还没重绘：再给一次机会
      await page.waitForTimeout(120);
      title = await this.currentChatTitle(page).catch(() => '');
    }
    /**
     * 标题读不出来 = 没法确认停在谁那儿。
     * 默认放行（群里/主人那条路径一直这么用，读不到标题时照发）；
     * strict 是给陌生人用的：宁可报没发，也不能把话打进别人的会话里。
     */
    if (!title) {
      this.lastTitleMiss = { at: Date.now(), who, url: String(page.url?.() ?? '') };
      /**
       * requireTitle：连标题都读不出来，就没法确认页面停在哪。
       * 主人私信走这条——宁可回执写「没发」，也不能像 11-08 那样把私信打进群聊。
       * 其它调用照旧放行：点会话那一步已经核过（点不到会直接抛 NO_DM），
       * 这里再拦就变成「永远发不出去」。
       */
      if (requireTitle) {
        this.log?.info?.('stroll chat title miss', { who, url: String(page.url?.() ?? '') });
        return false;
      }
      return true;
    }
    if (this.threadTitleMatches(title, who)) return true;
    let ok = await this.clickThread(page, who).catch(() => false);
    // 主列表里没有：抖音把非好友的私信收在「陌生人消息」文件夹里，得点进去才看得到
    if (!ok) ok = await this.clickStrangerThread(page, who).catch(() => false);
    if (ok) {
      await page.waitForTimeout(120);
      if (strict) {
        // 点完再核一次：点错行、动画没完、标题还是旧的，都不能算切过去
        let after = await this.currentChatTitle(page).catch(() => '');
        if (after && this.threadTitleMatches(after, who)) return true;
        // 切换有时候要 300-500ms 才重绘完，再看一眼，别把「慢」当成「切错」
        await page.waitForTimeout(400);
        after = await this.currentChatTitle(page).catch(() => '');
        if (!after) return true; // 读不出来就放行（和上面同一条规则）
        return this.threadTitleMatches(after, who);
      }
    }
    return ok;
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
    /**
     * 陌生人的常驻页：页面就停在他身上，不用导航、不用点会话。
     * 以前发表情/发图给陌生人走的是主页（getPage）——那边要 gotoChat + 点会话，
     * 列表还在重渲染，发图很容易被误判成「发出去了」，实际没到。
     */
    const sp = this.strangerPages?.get?.(name);
    if (name && sp?.page && !sp.page.isClosed() && sp.thread === name) {
      const input = await this.waitMsgInput(sp.page, 2500).catch(() => null);
      if (input) return { page: sp.page, input, stranger: true, fast: true };
    }
    if (this.dmPage && !this.dmPage.isClosed() && (!name || this.dmThread === name)) {
      const input = await this.waitMsgInput(this.dmPage, 2500).catch(() => null);
      if (input) return { page: this.dmPage, input, fast: true };
    }
    return await this.serialize(async () => {
      const page = await this.getPage();
      if (!(await this.isLoggedIn())) throw new DouyinError('LOGIN_REQUIRED', '抖音还没登录');
      const opened = await (async () => {
        if (!/\/chat/.test(page.url())) await this.gotoChat(page);
        if (name) {
          /**
           * 以前这里写的是 `if (name && this.openThread !== name)`：openThread 是个全局缓存，
           * 在群里回完一句它就被写成群名/人名，下一次给主人发图时如果恰好「等于」就跳过点击，
           * 于是图片直接打进当时开着的那个会话（2026-11-11 分享视频发到群聊就是这么来的）。
           * 点击只要 200ms，别为省这点时间赌对。
           */
          let ok = await this.clickThread(page, name);
          // 陌生人会话不在主列表里
          if (!ok) ok = await this.clickStrangerThread(page, name).catch(() => false);
          if (!ok) throw new DouyinError('NO_DM', '聊天列表和「陌生人消息」里都找不到这个会话');
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

  /**
   * 只给「主人私信」用的发送页：必须是核实过的那一页。
   * 宁可不发、回退成纯文字，也绝不把图打到当时开着的群/别人会话里。
   */
  async ownerChat(name) {
    const who = String(name ?? '').trim();
    if (!who) return null;
    // 1) 监听器专门停在主人会话上的那一页（最稳）
    if (this.dmPage && !this.dmPage.isClosed() && this.dmThread === who) {
      const input = await this.waitMsgInput(this.dmPage, 2000).catch(() => null);
      if (input) return { page: this.dmPage, input, via: 'dm-page' };
    }
    // 2) 主页面：点会话 + 用「会话内容有没有换」核实（这套页面读不到标题）
    const page = await this.getPage().catch(() => null);
    if (!page) return null;
    if (!/\/chat/.test(page.url())) await this.gotoChat(page).catch(() => {});
    const before = await this.threadFingerprint(page).catch(() => null);
    const clicked = await this.clickThread(page, who).catch(() => false);
    if (!clicked) return null;
    await page.waitForTimeout(250);
    if (before && !(await this.waitThreadChanged(page, before, 1800).catch(() => false))) return null;
    const input = await this.waitMsgInput(page, 3000).catch(() => null);
    if (!input) return null;
    this.openThread = who;
    return { page, input, via: 'chat' };
  }

  /**
   * 走抖音网页自己的「分享 → 分享给朋友」发一张原生卡片。
   *
   * 三条实测结论（2026-11-11，别再踩）：
   *   1. 必须用 `/?modal_id=<id>` 这种「视频浮层」打开。直接开 /video/<id> 是宽版详情页，
   *      竖排动作列不渲染（`video-player-share` 恒为 0×0），点了没反应。
   *   2. **无头模式渲染不出浮层**（等 40 秒也没有那个按钮）。所以后台运行时另开一个
   *      「离屏有头窗口」来做，窗口在屏幕外，用户看不见，但渲染和点击都正常。
   *   3. 首次进浮层会弹「滚轮/键盘上下键…我知道了」引导，它盖住页面，不关掉就点不动——
   *      之前 no-trigger 有一半是它干的。
   */
  async shareCardTo(name, url) {
    const who = String(name ?? '').trim();
    const id = String(url ?? '').match(/(\d{8,})/)?.[1] ?? '';
    if (!who || !id) return { ok: false, step: 'args' };
    /**
     * 同一个视频刚抓失败过：一小时之内别再试。
     * `no-trigger` 里有一部分是「这个视频本来就不给分享」（作者关了、私密、审核中），
     * 那种情况重试只是白等十几秒——不如直接走图片。
     */
    const lastFail = Number(this.shareFailAt?.[id] ?? 0);
    if (lastFail && Date.now() - lastFail < 60 * 60 * 1000) {
      return { ok: false, step: 'cached-fail', at: lastFail };
    }
    const result = await this.doShareCardTo(who, id);
    if (!result?.ok && result?.step !== 'no-confirm') {
      this.shareFailAt = { ...(this.shareFailAt ?? {}), [id]: Date.now() };
    }
    return result;
  }

  async doShareCardTo(who, id) {
    // 主上下文本来就有头（一起看/扫码登录时）：直接开一页，省一次浏览器启动
    if (this.context && this.headless !== true) {
      let page = null;
      try {
        page = await this.context.newPage();
        return await this.shareOnPage(page, who, id);
      } catch (error) {
        return { ok: false, step: 'error', reason: String(error?.message ?? error).slice(0, 80) };
      } finally {
        await page?.close().catch(() => {});
      }
    }
    return await this.shareInTempWindow(who, id);
  }

  /**
   * 分享用的离屏有头窗口：**常驻复用**。
   *
   * 以前每次分享都 `launchPersistentContext` + `close`，冷启动就要 2.5~3.5 秒，
   * 而且连续开关同一个 profile 容易卡在「锁没放干净」的状态——第二次分享直接
   * `no-trigger`（2026-11-12 13:25 实例）。常驻之后这两件事一起消失。
   * 空闲 5 分钟自动关，不常占内存。
   */
  async ensureShareWindow() {
    const alive = this.shareCtx && (typeof this.shareCtx.isClosed !== 'function' || !this.shareCtx.isClosed());
    if (alive) {
      let page = this.sharePage && !this.sharePage.isClosed() ? this.sharePage : null;
      if (!page) {
        page = await this.shareCtx.newPage().catch(() => null);
        this.sharePage = page;
      }
      if (page) {
        // 顺手刷新一次登录态：窗口可能挂了几分钟，cookie 轮换过
        const cookies = await this.shareCookies().catch(() => []);
        if (cookies.length) await this.shareCtx.addCookies(cookies).catch(() => {});
        return { page, reused: true };
      }
      await this.closeShareWindow().catch(() => {});
    }
    const mod = await this.loadPlaywright();
    const chromium = mod.chromium ?? mod.default?.chromium;
    const dir = path.join(this.dataDir, 'stroll', 'share-profile');
    fs.mkdirSync(dir, { recursive: true });
    const ctx = await chromium.launchPersistentContext(dir, {
      headless: false,
      channel: this.channel ?? 'msedge',
      viewport: { width: 1400, height: 900 },
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      args: [
        '--disable-blink-features=AutomationControlled',
        '--autoplay-policy=no-user-gesture-required',
        /**
         * 必须静音。这个窗口虽然有头且挪到了屏幕外，但视频是**真播**的——
         * 不静音的话主人会在电脑后台听见一段不明来历的声音（2026-11-12 反馈）。
         * 分享只需要点按钮，不需要真的听声音。
         */
        '--mute-audio',
        // 挪到屏幕外：看得见就打扰人了，但必须真渲染，所以不能 headless
        '--window-position=-2400,-2400',
        '--window-size=1420,940',
        '--disable-features=CalculateNativeWinOcclusion',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
      ],
      ignoreDefaultArgs: ['--enable-automation'],
    });
    const cookies = await this.shareCookies();
    if (cookies.length) await ctx.addCookies(cookies).catch(() => {});
    const page = await ctx.newPage();
    this.shareCtx = ctx;
    this.sharePage = page;
    ctx.on?.('close', () => {
      if (this.shareCtx === ctx) {
        this.shareCtx = null;
        this.sharePage = null;
      }
    });
    return { page, reused: false };
  }

  /** 关掉分享窗口（空闲超时 / 出异常 / 世界停止时）。 */
  async closeShareWindow() {
    if (this.shareIdleTimer) clearTimeout(this.shareIdleTimer);
    this.shareIdleTimer = null;
    this.sharePage = null;
    const ctx = this.shareCtx;
    this.shareCtx = null;
    if (ctx) await ctx.close().catch(() => {});
  }

  /** 每次用完续一次空闲计时：5 分钟没人用就关掉，别一直占着 200~300MB 内存。 */
  touchShareWindow() {
    if (this.shareIdleTimer) clearTimeout(this.shareIdleTimer);
    this.shareIdleTimer = setTimeout(() => {
      this.closeShareWindow().catch(() => {});
    }, 5 * 60 * 1000);
    this.shareIdleTimer.unref?.();
  }

  /**
   * 抓不到卡片时留一份现场：截图 + 关键状态。
   * `no-trigger` 本身不带任何信息，没有这个只能靠猜（是没渲染、被频控、还是视频不给分享）。
   */
  async captureShareFailure(page, who, id, step) {
    try {
      const dir = path.join(this.dataDir, 'stroll', 'debug');
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const base = path.join(dir, `share-fail-${id}-${stamp}`);
      const info = await page
        .evaluate(() => ({
          url: String(location.href),
          title: String(document.title),
          hasVideo: !!document.querySelector('video'),
          shareBtns: document.querySelectorAll('[data-e2e="video-player-share"]').length,
          guide: String(document.body?.innerText ?? '').includes('我知道了'),
          text: String(document.body?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 600),
        }))
        .catch(() => null);
      fs.writeFileSync(`${base}.json`, JSON.stringify({ who, id, step, at: Date.now(), info }, null, 2));
      await page.screenshot({ path: `${base}.png`, timeout: 5000 }).catch(() => {});
      this.log?.info?.('stroll share fail captured', { id, step, name: `${base}.json` });
    } catch {
      // 留证据失败不影响主流程
    }
  }

  /**
   * 后台（无头）时用的离屏有头窗口：独立资料目录 + 从当前上下文/备份注入登录态。
   * 用独立目录是为了不跟主 profile 抢锁，也不会把主人正在用的页面带跑。
   */
  async shareInTempWindow(who, id) {
    try {
      const { page, reused } = await this.ensureShareWindow();
      this.touchShareWindow();
      let result = await this.shareOnPage(page, who, id);
      this.touchShareWindow();
      /**
       * `no-trigger` 基本都不是「视频不能分享」，而是浮层没渲染出来：
       * 连续开关同一个 share-profile（上一轮的锁还没放干净）、抖音自己抽风、
       * 首屏还在加载。同一页再看一次往往就出来了，比直接降级成「画面 + 标题」便宜。
       * 2026-11-12 13:25 那次就是：第一次成功，隔 30 秒第二次 no-trigger。
       */
      if (!result.ok && result.step === 'no-trigger') {
        this.log?.info?.('stroll share retry', { who, id, step: result.step });
        await page.waitForTimeout(900);
        result = await this.shareOnPage(page, who, id);
      }
      // 还是不通：留一份现场（截图 + 页面状态），下次不用靠猜
      if (!result.ok) await this.captureShareFailure(page, who, id, result.step);
      this.touchShareWindow();
      this.log?.info?.('stroll share temp window', { ok: result.ok, step: result.step ?? '', reused });
      return result;
    } catch (error) {
      // 窗口本身坏了（崩了/被关）：关掉重来，下次重新启动
      await this.closeShareWindow().catch(() => {});
      return { ok: false, step: 'temp-browser', reason: String(error?.message ?? error).slice(0, 80) };
    }
  }

  /** 分享窗口要用的 cookie：优先当前上下文的实时值，没有再用落盘备份。 */
  async shareCookies() {
    const pick = (list) =>
      (Array.isArray(list) ? list : [])
        .filter((c) => /(^|\.)(douyin|bytedance|amemv|snssdk)\.(com|cn)$/i.test(String(c?.domain ?? '')))
        .map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path ?? '/',
          expires: c.expires && c.expires > 0 ? c.expires : undefined,
          httpOnly: !!c.httpOnly,
          secure: !!c.secure,
          sameSite: c.sameSite ?? 'Lax',
        }));
    const live = this.context ? await this.context.cookies().catch(() => []) : [];
    const fromLive = pick(live);
    if (fromLive.length) return fromLive;
    try {
      const saved = JSON.parse(fs.readFileSync(this.cookieFile, 'utf8'));
      return pick(saved?.cookies ?? []);
    } catch {
      return [];
    }
  }

  /** 在一个页面上把整套分享流程走完。 */
  async shareOnPage(page, who, id) {
    page.setDefaultTimeout(8000);
    await page
      .goto(`https://www.douyin.com/?modal_id=${id}`, { waitUntil: 'domcontentloaded', timeout: 30000 })
      .catch(() => {});
    const box = await this.waitShareTrigger(page, 12000);
    if (!box) return { ok: false, step: 'no-trigger' };
    await page.bringToFront().catch(() => {});
    let opened = false;
    for (let i = 0; i < 2 && !opened; i += 1) {
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      await page.mouse.move(cx, cy, { steps: 12 }).catch(() => {});
      await page.waitForTimeout(600);
      await page.mouse.click(cx, cy).catch(() => {});
      opened = await this.waitSharePanel(page, 5000);
    }
    if (!opened) return { ok: false, step: 'no-panel' };
    const clicked = await this.shareRowClick(page, who);
    if (!clicked.ok) return { ok: false, step: clicked.step };
    if (!(await this.waitShareDone(page, who, 5000))) return { ok: false, step: 'no-confirm' };
    this.log?.info?.('stroll share card ok', { who, id });
    return { ok: true, via: 'card', id };
  }

  /**
   * 等竖排里那个分享按钮变得可点。顺便把「我知道了」引导关掉——它盖在页面上，
   * 不关的话点哪都没反应。
   */
  async waitShareTrigger(page, timeout = 20000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const guide = page.getByText('我知道了', { exact: true }).first();
      if (await guide.count().catch(() => 0)) {
        await guide.click({ timeout: 1200 }).catch(() => {});
        await page.waitForTimeout(500);
      }
      const box = await page
        .evaluate(() => {
          const boxes = Array.from(document.querySelectorAll('[data-e2e="video-player-share"]'))
            .map((el) => {
              const r = el.getBoundingClientRect();
              return { x: r.left, y: r.top, width: r.width, height: r.height };
            })
            .filter((b) => b.width > 10 && b.height > 30 && b.x > 0 && b.y > 0 && b.y < window.innerHeight);
          // 信息流里可能有多条视频的按钮，取最靠上的那条（当前播放的）
          boxes.sort((a, b) => a.y - b.y);
          return boxes[0] ?? null;
        })
        .catch(() => null);
      if (box) return box;
      await page.waitForTimeout(400).catch(() => {});
    }
    return null;
  }

  /** 分享面板有没有弹出来（「分享给朋友」是它的标题）。 */
  async waitSharePanel(page, timeout = 6000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const ok = await page
        .evaluate(() => String(document.body?.innerText ?? '').includes('分享给朋友'))
        .catch(() => false);
      if (ok) return true;
      await page.waitForTimeout(300).catch(() => {});
    }
    return false;
  }

  /**
   * 在「分享给朋友」列表里找到昵称正好是 who 的那一行，点它自己那个「分享」按钮。
   * 只认名字完全一致的行（去掉「在线/分享/捎句话」这些状态词），差一个字都不点——
   * 点错就是把视频发给别人。
   */
  async shareRowClick(page, who) {
    return await page
      .evaluate((name) => {
        const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
        const bare = (t) =>
          t
            .split(' ')
            .filter((x) => x && !/^(在线|分享|捎句话|已分享)$/.test(x))
            .join(' ');
        const rows = [];
        const collect = (match) => {
          document.querySelectorAll('div').forEach((el) => {
            const t = clean(el.innerText);
            if (!t || !/(分享|捎句话|已分享)$/.test(t)) return;
            const r = el.getBoundingClientRect();
            if (r.width < 240 || r.width > 440 || r.height < 36 || r.height > 100) return;
            if (!match(t)) return;
            rows.push(el);
          });
        };
        // 第一轮：整串严格相等（人名走这条，差一个字都不点）
        collect((t) => bare(t) === name);
        if (!rows.length) {
          /**
           * 第二轮：群名归一化后再比。
           * 群在列表里可能写成「A, B, C」也可能写成「A、B、C」，空格多少也不一定；
           * 严格相等对群几乎永远不成立，于是群里永远发不出卡片（2026-11-12 反馈）。
           * 只去掉空白、统一逗号/顿号，不做包含匹配——点错就是把视频发给别人。
           */
          const key = (s) => String(s ?? '').replace(/[\s\u3000]+/g, '').replace(/[,，、]/g, ',');
          const want = key(name);
          collect((t) => key(bare(t)) === want);
        }
        if (!rows.length) return { ok: false, step: 'no-row' };
        const row = rows[rows.length - 1];
        const btn = Array.from(row.querySelectorAll('div,span,button'))
          .filter((b) => clean(b.innerText) === '分享')
          .pop();
        if (!btn) return { ok: false, step: 'no-btn' };
        const r = btn.getBoundingClientRect();
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return { ok: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      }, who)
      .catch((error) => ({ ok: false, step: 'eval', reason: String(error?.message ?? '').slice(0, 60) }));
  }

  /** 发成功的信号：那一行变成「捎句话」，或者出现「分享成功」。 */
  async waitShareDone(page, who, timeout = 5000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const done = await page
        .evaluate((name) => {
          const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
          const t = clean(document.body?.innerText ?? '');
          if (/分享成功|已分享/.test(t)) return true;
          return Array.from(document.querySelectorAll('div')).some((el) => {
            const s = clean(el.innerText);
            if (!s || s.length > 40) return false;
            if (!/捎句话/.test(s)) return false;
            return s.startsWith(name);
          });
        }, who)
        .catch(() => false);
      if (done) return true;
      await page.waitForTimeout(400).catch(() => {});
    }
    return false;
  }

  /** 发一张表情到某个会话（群名 / 昵称 / 留空 = 当前会话）。 */
  async sendStickerTo(who, { file = '', src = '', label = '' } = {}) {
    const t = await this.chatPageOf(who);
    try {
      // 先确认这一页真的停在这个会话上：上传框是页面级的，飘到别的会话就会传错地方/传不出去
      if (who && !(await this.ensureThreadOpen(t.page, who).catch(() => false))) {
        return { ok: false, code: 'THREAD_DRIFT', error: `页面没停在「${who}」这个会话上，点不回去，没发` };
      }
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
  /** 一起看：单独起一个有窗口的浏览器，主浏览器（私信/群）不露头。 */
  async watchStart(url, { cookies = [] } = {}) {
    return this.serialize(async () => {
      await this.closeWatch();
      const browser = await this.launchWatchBrowser();
      this.watchBrowser = browser;
      try {
        const context = await browser.newContext({
          // 不给固定 viewport：让窗口自己决定大小，最大化/全屏才有效
          viewport: null,
          locale: 'zh-CN',
          timezoneId: 'Asia/Shanghai',
        });
        this.watchContext = context;
        // 把主会话的 B站 登录态带过去，省得每次陪看都要扫码
        if (cookies?.length) await context.addCookies(cookies).catch(() => {});
        const page = await context.newPage();
        page.setDefaultTimeout(20000);
        this.watchPage = page;
        await this.applyWatchWindow(browser, page);
        if (url) await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        const hasVideo = await page
          .waitForSelector('video', { timeout: 12000 })
          .then(() => true)
          .catch(() => false);
        const finalUrl = page.url();
        // 打不开就别假装成功：about:blank / 错误页会把一个空白窗口当成「一起看中」
        if (url && (/^about:blank/i.test(finalUrl) || /^chrome-error:/i.test(finalUrl))) {
          throw new DouyinError('WATCH_OPEN_FAILED', `陪看窗口打不开这个地址：${url}`);
        }
        this.watchStartedAt = Date.now();
        // 抖音打开后常常停在暂停态（浏览器拦自动播放）：主动播一下，不然「一起刷」第一轮就卡住
        if (hasVideo && this.platformOf(finalUrl) === 'douyin') await this.ensureWatchPlaying(page);
        const digest = await page.evaluate(watchScript).catch(() => null);
        return {
          ok: true,
          platform: this.platformOf(finalUrl),
          title: digest?.title || (await page.title().catch(() => '')),
          url: finalUrl,
          hasVideo,
        };
      } catch (error) {
        await this.closeWatch();
        throw error;
      }
    });
  }

  async launchWatchBrowser() {
    const mod = await this.loadPlaywright();
    const chromium = mod.chromium ?? mod.default?.chromium;
    const winMode = String(this.cfg.watchWindow ?? 'maximized');
    const args = ['--autoplay-policy=no-user-gesture-required', '--disable-blink-features=AutomationControlled'];
    if (winMode === 'fullscreen') args.push('--start-fullscreen');
    else if (winMode === 'normal') args.push('--window-size=1300,860');
    else args.push('--start-maximized');
    const options = { headless: false, args };
    // 默认 Chrome 优先；也允许在设置里强制 chrome/edge。都没有就用 Playwright 自带的
    const pref = String(this.cfg.watchBrowser ?? 'auto');
    const order = this.channel
      ? [this.channel, 'chrome', 'msedge']
      : pref === 'edge'
        ? ['msedge', 'chrome']
        : ['chrome', 'msedge'];
    for (const channel of order) {
      try {
        return await chromium.launch({ ...options, channel });
      } catch {
        // 试下一个渠道
      }
    }
    return await chromium.launch(options);
  }

  /** 最大化/全屏：启动参数不一定生效，再用 CDP 设一次窗口状态。 */
  async applyWatchWindow(browser, page) {
    const mode = String(this.cfg.watchWindow ?? 'maximized');
    if (mode === 'normal') return;
    try {
      const cdp = await browser.newBrowserCDPSession();
      const { windowId } = await cdp.send('Browser.getWindowForTarget');
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: mode } });
      await cdp.detach().catch(() => {});
    } catch {
      // 启动参数已经带 --start-maximized/--start-fullscreen，失败就算了
    }
  }

  /** 关掉一起看专用浏览器（不动主浏览器）。 */
  async closeWatch() {
    const page = this.watchPage;
    this.watchPage = null;
    await page?.close().catch(() => {});
    const context = this.watchContext;
    this.watchContext = null;
    await context?.close().catch(() => {});
    const browser = this.watchBrowser;
    this.watchBrowser = null;
    await browser?.close().catch(() => {});
  }

  platformOf(url) {
    if (/bilibili\.com/.test(url)) return 'bilibili';
    if (/douyin\.com/.test(url)) return 'douyin';
    return 'web';
  }

  /** 同页面摘要：标题、进度、评论区。没开窗时返回 null。 */
  async watchDigest() {
    const page = this.watchPage;
    if (!page || page.isClosed()) return null;
    try {
      return await page.evaluate(watchScript);
    } catch {
      return null;
    }
  }

  /**
   * 一起刷：切到下一条抖音视频。
   * 顺序：页面自带的「下一个」按钮 → 推荐列表里没看过的一条 → 滚一下（推荐流）。
   * 切完会核对 videoId/videoKey 有没有真的变，没变就报 NO_NEXT，别让上层以为刷成功了。
   */
  async watchNext({ seen = [], currentId = '' } = {}) {
    const page = this.watchPage;
    if (!page || page.isClosed()) return { ok: false, code: 'NO_WATCH_PAGE' };
    const before = await this.watchDigest();
    const idOf = (u) => (String(u).match(/\/video\/(\d+)/) || [])[1] || '';
    const changedFrom = (d) =>
      !!d && !!before && (d.videoId !== before.videoId || d.videoKey !== before.videoKey || d.url !== before.url);

    // 1) 抖音自己的「下一个」
    // 只在播放器容器里找，别点到页面其他地方的轮播箭头
    for (const sel of [
      '[data-e2e="video-switch-next"]',
      '[data-e2e="player-container"] [data-e2e="arrow-right"]',
    ]) {
      const btn = page.locator(sel).first();
      if (!(await btn.count().catch(() => 0))) continue;
      await btn.click({ force: true }).catch(() => {});
      await page.waitForTimeout(1000);
      const after = await this.watchDigest();
      if (changedFrom(after)) {
        await this.ensureWatchPlaying(page);
        return { ok: true, via: 'button', digest: after };
      }
    }

    // 2) 推荐列表里挑一条没看过的
    const cands = await page
      .evaluate(() =>
        Array.from(document.querySelectorAll('a[href*="/video/"]'))
          .map((a) => ({ href: a.href, text: (a.innerText || '').trim().slice(0, 40) }))
          .filter((x) => x.href),
      )
      .catch(() => []);
    const seenSet = new Set(seen.map(String));
    // watchDigest 偶尔读不到（页面正在跳）：拿 currentId 兜底，别让 newId !== undefined 变成假成功
    const baseId = before?.videoId || currentId;
    const pick = cands
      .filter((c) => {
        const id = idOf(c.href);
        return id && id !== currentId && id !== before?.videoId && !seenSet.has(id);
      })
      // 侧边栏/评论区里也有 /video/ 链接，优先挑带标题文字的
      .sort((a, b) => (b.text ? 1 : 0) - (a.text ? 1 : 0))[0];
    if (pick) {
      await page.goto(pick.href, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
      await page.waitForSelector('video', { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(700);
      const after = await this.watchDigest();
      const newId = idOf(page.url());
      // 只有真换了才算成功：goto 失败时 URL 还是原来那条，不能当已经刷过去了
      if (changedFrom(after) || (newId && newId !== baseId)) {
        await this.ensureWatchPlaying(page);
        return { ok: true, via: 'list', digest: after };
      }
    }

    // 3) 兜底：滚一下 + 方向键（推荐流只能这么切）
    await page.mouse.wheel(0, 900).catch(() => {});
    await page.waitForTimeout(400);
    await page.keyboard.press('ArrowDown').catch(() => {});
    await page.waitForTimeout(900);
    const after = await this.watchDigest();
    if (changedFrom(after)) {
      await this.ensureWatchPlaying(page);
      return { ok: true, via: 'scroll', digest: after };
    }
    return { ok: false, code: 'NO_NEXT', via: 'scroll' };
  }

  /** 切完视频可能停在暂停态（自动播放被拦）：主动 play 一下，别让一起刷卡住。 */
  async ensureWatchPlaying(page = this.watchPage) {
    if (!page || page.isClosed()) return;
    await page
      .evaluate(() => {
        const visible = (el) => {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          return r.width >= 120 && r.height >= 90;
        };
        const vs = Array.from(document.querySelectorAll('video'));
        const v = vs.find((x) => visible(x) && !x.paused) || vs.find(visible) || vs[0];
        if (v && v.paused) v.play().catch(() => {});
      })
      .catch(() => {});
  }

  /** 抖音评论区：先直接读，读不到就点开评论图标再读一次。 */
  async watchComments() {
    const page = this.watchPage;
    if (!page || page.isClosed()) return [];
    const read = () => page.evaluate(readCommentsScript).catch(() => []);
    let list = await read();
    if (list.length) return list;
    for (const sel of [
      '[data-e2e="comment-icon"]',
      '[data-e2e="feed-comment-icon"]',
      '[data-e2e="video-comment"]',
      '[data-e2e="detail-comment-icon"]',
    ]) {
      const btn = page.locator(sel).first();
      if (!(await btn.count().catch(() => 0))) continue;
      await btn.click({ force: true }).catch(() => {});
      await page.waitForTimeout(700);
      list = await read();
      if (list.length) return list;
    }
    return [];
  }

  /** 附一张当前画面（抖音没字幕，她只能靠这个看见画面）。 */
  async watchShot() {
    const page = this.watchPage;
    if (!page || page.isClosed()) return null;
    const box = await page
      .locator('[data-e2e="player-container"], video')
      .first()
      .boundingBox()
      .catch(() => null);
    const clip =
      box && box.width >= 120 && box.height >= 90
        ? { x: Math.max(0, box.x), y: Math.max(0, box.y), width: box.width, height: box.height }
        : null;
    const buf = await page.screenshot({ type: 'jpeg', quality: 58, ...(clip ? { clip } : {}) }).catch(() => null);
    if (!buf) return null;
    return { bytes: buf, mime: 'image/jpeg', name: '陪看画面', fallbackText: '（陪同观看的当前画面）' };
  }

  async watchStop() {
    this.watchStartedAt = 0;
    await this.closeWatch();
    return { ok: true };
  }

  async close() {
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.closeTimer = null;
    this.holdOpen = false;
    // 关窗之前先备份登录态：进程被强杀时 Chromium 不一定来得及把 cookie 落盘
    await this.saveCookies({ force: true }).catch(() => {});
    await this.closeWatch().catch(() => {});
    // 分享用的离屏窗口是常驻的（为了省冷启动），这里必须一起收掉
    await this.closeShareWindow().catch(() => {});
    await this.page?.close().catch(() => {});
    this.page = null;
    await this.dmPage?.close().catch(() => {});
    this.dmPage = null;
    this.dmThread = '';
    this.dmArmedAt = 0;
    await this.chatPage?.close().catch(() => {});
    this.chatPage = null;
    this.chatThread = '';
    this.openThread = '';
    await this.releaseStrangerPages().catch(() => {});
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
