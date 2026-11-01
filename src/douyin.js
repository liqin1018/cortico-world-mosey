import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { formatCount, formatDuration, humanPause, parseDouyinId, parseKeywords, truncate } from './util.js';

const ORIGIN = 'https://www.douyin.com';

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
    const context = await this.launch();
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

  async dm(secUid, text) {
    return this.serialize(async () => {
      if (!/^MS4w[A-Za-z0-9_.-]{10,200}$/.test(String(secUid ?? ''))) {
        throw new DouyinError('BAD_TARGET', '抖音私信需要作者的 sec_uid（MS4w 开头）');
      }
      const page = await this.getPage();
      if (!(await this.isLoggedIn())) throw new DouyinError('LOGIN_REQUIRED', '抖音还没登录，发不了私信');
      await this.goto(page, `${ORIGIN}/user/${secUid}`, 4200);
      const btn = page.getByText('私信', { exact: true }).first();
      if (!(await btn.count())) throw new DouyinError('NO_DM', '这个主页没有私信按钮（可能对方关闭了）');
      await btn.click({ timeout: 6000 });
      await humanPause(1600, 2600);
      const input = page.locator('div[contenteditable="true"], textarea').last();
      await input.click({ timeout: 6000 });
      await input.pressSequentially(text, { delay: 75 });
      await page.keyboard.press('Enter');
      await page.waitForTimeout(1600);
      const body = await page.locator('body').innerText().catch(() => '');
      if (RISK_TEXT.test(body)) {
        this.policy.noteRisk('DOUYIN_VERIFY', '发私信后出现验证');
        throw new DouyinError('RISK', '发私信后出现验证，已停手。');
      }
      this.lastAction = `dm ${secUid}`;
      return { ok: true, sent: true };
    });
  }

  async inbox(limit = 5) {
    return this.serialize(async () => {
      const page = await this.getPage();
      if (!(await this.isLoggedIn())) return [];
      await this.goto(page, `${ORIGIN}/user/self?from_tab_name=main`, 4200);
      const items = await page.evaluate((n) => {
        const nodes = Array.from(document.querySelectorAll('[data-e2e="conversation-item"], .conversation-item, [class*="conversation"]')).slice(0, n);
        return nodes
          .map((el) => (el.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 3).join(' · '))
          .filter(Boolean);
      }, limit);
      this.scheduleClose(60);
      return items;
    });
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
