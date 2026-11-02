import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { formatCount, formatDuration, humanPause, parseDouyinId, parseKeywords, truncate } from './util.js';

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

export class DouyinBrowser {
  constructor({ dataDir, cfg, log, policy }) {
    this.dataDir = dataDir;
    this.cfg = cfg;
    this.log = log;
    this.policy = policy;
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
    this.launching = null;
    this.lastAction = '';
    this.lastError = '';
  }

  serialize(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
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
      try {
        context = await chromium.launchPersistentContext(this.profileDir, { ...options, channel: 'msedge' });
      } catch {
        context = await chromium.launchPersistentContext(this.profileDir, { ...options, channel: 'chrome' });
      }
      context.on('close', () => {
        // 旧窗口的 close 可能比新窗口的赋值还晚到，只处理自己的那一个
        if (this.context !== context) return;
        this.context = null;
        this.page = null;
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

  async getPage() {
    // 沿用当前的窗口模式：开着的登录窗不能被一次隐式 launch 关掉重开
    const context = await this.launch({ headless: this.headless ?? (this.cfg.background !== false) });
    if (this.page && !this.page.isClosed()) return this.page;
    this.page = await context.newPage();
    this.page.setDefaultTimeout(20000);
    return this.page;
  }

  async checkRisk(page) {
    const text = await page.locator('body').innerText().catch(() => '');
    if (RISK_TEXT.test(text)) {
      this.policy.noteRisk('DOUYIN_VERIFY', '抖音出现验证/频繁提示');
      throw new DouyinError('RISK', '抖音弹出验证或提示操作频繁，已经停手。');
    }
  }

  async goto(page, url, waitMs = 4200) {
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
    this.lastLogin = { at: new Date().toISOString(), ...extra };
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
        }
      } catch {
        // 下一轮再看
      }
    }, 2500);
  }

  async isLoggedIn() {
    if (!this.context) return !!this.savedLogin();
    const cookies = await this.context.cookies(ORIGIN).catch(() => []);
    const ok = cookies.some((c) => c.name === 'sessionid' || c.name === 'sid_tt');
    if (ok) this.markLoggedIn();
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
    await page.waitForTimeout(2600);
    return page
      .evaluate(() => {
        const text = (document.body.innerText ?? '').slice(0, 2000);
        const id = text.match(/抖音号[:：]\s*([A-Za-z0-9_.-]{2,40})/)?.[1] ?? '';
        const name = (document.querySelector('h1')?.innerText ?? '').trim().split('\n')[0] ?? '';
        return { douyinId: id.trim(), name };
      })
      .catch(() => ({ douyinId: '', name: '' }));
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
    if (this.closeTimer) clearTimeout(this.closeTimer);
    if (!seconds || seconds <= 0) {
      this.closeTimer = setTimeout(() => this.closePage().catch(() => {}), 1500);
      return;
    }
    this.closeTimer = setTimeout(() => this.closePage().catch(() => {}), seconds * 1000);
  }

  async closePage() {
    if (this.page && !this.page.isClosed()) await this.page.close().catch(() => {});
    this.page = null;
  }

  async ensureVideo(page, id) {
    if (!page.url().includes(`/video/${id}`)) await this.goto(page, `${ORIGIN}/video/${id}`, 3800);
    else await humanPause(900, 1800);
  }

  async like(idOrUrl, on = true) {
    return this.serialize(async () => {
      const id = await this.idOf(idOrUrl);
      if (!id) throw new DouyinError('BAD_ID', '不是有效的抖音视频');
      const page = await this.getPage();
      if (!(await this.isLoggedIn())) throw new DouyinError('LOGIN_REQUIRED', '抖音还没登录，点不了赞');
      await this.ensureVideo(page, id);
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
        const body = await page.locator('body').innerText().catch(() => '');
        if (RISK_TEXT.test(body)) {
          this.policy.noteRisk('DOUYIN_VERIFY', '点赞后出现验证');
          throw new DouyinError('RISK', '点赞后出现验证/频繁提示，已停手。');
        }
        if (/短信验证码|为确保是本人操作/.test(body)) {
          throw new DouyinError('VERIFY_REQUIRED', '抖音要求短信验证：在面板点「登录抖音」开窗手动完成一次。');
        }
        if (/登录后|请先登录|扫码登录/.test(body)) throw new DouyinError('LOGIN_REQUIRED', '抖音登录态失效了，去面板重新扫码');
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

  /** 抖音的评论框是惰性的：先点 #comment-input-container，Draft.js 编辑器才挂上来。 */
  async openCommentEditor(page) {
    const box = page.locator('#comment-input-container').first();
    if (await box.count().catch(() => 0)) {
      await box.scrollIntoViewIfNeeded().catch(() => {});
      await box.click({ force: true, timeout: 6000 }).catch(() => {});
      await page.waitForTimeout(900);
    }
    return this.findCommentInput(page);
  }

  async comment(idOrUrl, text) {
    return this.serialize(async () => {
      const id = await this.idOf(idOrUrl);
      if (!id) throw new DouyinError('BAD_ID', '不是有效的抖音视频');
      const page = await this.getPage();
      if (!(await this.isLoggedIn())) throw new DouyinError('LOGIN_REQUIRED', '抖音还没登录，发不了评论');
      await this.ensureVideo(page, id);
      let input = await this.findCommentInput(page);
      if (!input) input = await this.openCommentEditor(page);
      if (!input) {
        // 评论按钮在部分宽度下不可见；直接触发页面内点击，和用户点一下等价。
        await page
          .evaluate(() => {
            const el = document.querySelector('[data-e2e="feed-comment-icon"]');
            if (el) el.click();
            const more = document.querySelector('[data-e2e="video-comment-more"]');
            if (more) more.scrollIntoView({ block: 'center' });
          })
          .catch(() => {});
        await humanPause(1800, 2600);
        input = await this.findCommentInput(page);
      }
      if (!input) {
        const body = await page.locator('body').innerText().catch(() => '');
        if (/登录后|请先登录|扫码登录|立即登录/.test(body)) {
          throw new DouyinError('LOGIN_REQUIRED', '抖音登录态失效了，去面板重新扫码再评论');
        }
        throw new DouyinError('NO_INPUT', '没找到评论输入框（页面可能改版，或这条视频关了评论）');
      }
      await input.click({ force: true, timeout: 6000 }).catch(() => {});
      await input.evaluate((el) => el.focus()).catch(() => {});
      await input.fill('').catch(() => {});
      // contenteditable 用键盘输入更像真人，也更容易触发「发送」按钮变亮。
      await input.type(text, { delay: 70 + Math.floor(Math.random() * 50) }).catch(async () => {
        await input.pressSequentially(text, { delay: 70 });
      });
      await humanPause(800, 1500);
      const send = await this.findSendButton(page);
      if (send) await send.click({ force: true, timeout: 5000 }).catch(() => {});
      else await input.press('Enter');
      await page.waitForTimeout(2400);
      const body = await page.locator('body').innerText().catch(() => '');
      if (/短信验证码|为确保是本人操作|身份验证|完成验证|安全验证/.test(body)) {
        throw new DouyinError(
          'VERIFY_REQUIRED',
          '抖音要求短信验证（不是封号）。在面板点「登录抖音」开窗，手动发一条评论并按提示完成验证；之后自动化才能继续。',
        );
      }
      if (RISK_TEXT.test(body)) {
        this.policy.noteRisk('DOUYIN_VERIFY', '发评论后出现验证');
        throw new DouyinError('RISK', '发评论后出现验证/频繁提示，已停手。');
      }
      const left = await input.evaluate((el) => (el.innerText || el.value || '').trim()).catch(() => '');
      const inList = await page
        .evaluate((t) => {
          const items = Array.from(document.querySelectorAll('[data-e2e="comment-item"]'));
          return items.some((n) => (n.innerText || '').includes(t));
        }, text)
        .catch(() => false);
      if (left.length > 0 && !inList) {
        throw new DouyinError('NOT_CONFIRMED', '点了发送，但输入框没清空、评论区也没出现；可能被拦了');
      }
      this.lastAction = `comment ${id}`;
      return { ok: true, confirmed: inList, queued: !inList, text };
    });
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
   * 在已经打开的聊天框里把话发出去，并确认真的发出去了。
   * contenteditable 清空后会剩一个零宽字符，trim() 去不掉，所以要自己剥。
   */
  async sendInChat(page, input, text) {
    const read = () =>
      input
        .evaluate((el) => String(el.value ?? el.textContent ?? '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim())
        .catch(() => '');
    await input.click({ timeout: 6000 });
    await input.pressSequentially(String(text).slice(0, 300), { delay: 60 });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1500);
    let left = await read();
    if (left) {
      // 有些版本回车只是换行，得点发送
      const sendBtn = page.locator('[data-e2e="msg-send"]').first();
      if ((await sendBtn.count().catch(() => 0)) > 0 && (await sendBtn.isVisible().catch(() => false))) {
        await sendBtn.click({ timeout: 4000 }).catch(() => {});
        await page.waitForTimeout(1200);
        left = await read();
      }
    }
    if (left) {
      throw new DouyinError('NOT_SENT', '消息还留在输入框里，没发出去（可能被限流，或对方设置了陌生人限制）');
    }
    const body = await page.locator('body').innerText().catch(() => '');
    if (RISK_TEXT.test(body)) {
      this.policy.noteRisk('DOUYIN_VERIFY', '发私信后出现验证');
      throw new DouyinError('RISK', '发私信后出现验证，已停手。');
    }
    return true;
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
   * 每条会话的 innerText 依次是：昵称 / 时间 / 最后一句 / 未读数。
   */
  async inbox(limit = 6) {
    return this.serialize(async () => {
      const page = await this.getPage();
      if (!(await this.isLoggedIn())) return [];
      await this.goto(page, `${ORIGIN}/chat`, 5200);
      const rows = await page.evaluate((n) => {
        const nodes = Array.from(document.querySelectorAll('[data-e2e="conversation-item"]')).slice(0, n);
        return nodes.map((el) => (el.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean));
      }, limit);
      this.scheduleClose(60);
      return rows
        .filter((l) => l.length >= 2)
        .map((lines, i) => {
          const name = lines[0] ?? '抖音好友';
          const text = lines[2] ?? '';
          const unread = lines.length >= 4 && /^\d+$/.test(lines[3]) ? Number(lines[3]) : 0;
          return {
            kind: 'dm',
            platform: 'douyin',
            type: 'dm',
            id: `dm:douyin:${i}:${name}`,
            user: name,
            text: truncate(text, 120),
            where: unread > 0 ? `${unread} 条未读` : '私信',
            unread,
            at: approxTime(lines[1] ?? '', i),
            timeLabel: lines[1] ?? '',
            url: `${ORIGIN}/chat`,
            order: i,
          };
        });
    });
  }

  /** 在抖音聊天页回一条私信：按昵称找到会话，点进去输入。 */
  async replyDm(name, text) {
    return this.serialize(async () => {
      const who = String(name ?? '').trim();
      if (!who) throw new DouyinError('BAD_TARGET', '没有会话昵称，回不了');
      const page = await this.getPage();
      if (!(await this.isLoggedIn())) throw new DouyinError('LOGIN_REQUIRED', '抖音还没登录，发不了私信');
      try {
        await this.goto(page, `${ORIGIN}/chat`, 5200);
        const item = page.locator('[data-e2e="conversation-item"]', { hasText: who }).first();
        if (!(await item.count())) throw new DouyinError('NO_DM', '聊天列表里找不到这个会话，可能被新消息刷下去了');
        await item.click({ timeout: 6000 });
        await humanPause(1200, 1900);
        const input = await this.waitMsgInput(page, 6000);
        if (!input) throw new DouyinError('NO_INPUT', '没找到输入框，抖音可能改版了');
        await this.sendInChat(page, input, text);
        this.lastAction = `dm ${who}`;
        return { ok: true, sent: true };
      } finally {
        this.scheduleClose(60);
      }
    });
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
