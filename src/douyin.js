import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { formatCount, formatDuration, humanPause, parseDouyinId, parseKeywords, stripAtName, truncate } from './util.js';

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
    /** 600ms 的合并窗口：连发两句只叫一次。 */
    this.dmSettle = null;
    this.dmPendingSig = '';
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
      // 先 Edge 再 Chrome：Windows 上基本都有 Edge，没装 Chrome 的机器也能跑
      const launchOnce = async () => {
        try {
          return await chromium.launchPersistentContext(this.profileDir, { ...options, channel: 'msedge' });
        } catch {
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
        const norm = (s) => String(s ?? '').replace(/\s+/g, '').replace(/^@+/, '');
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
        const norm = (s) => String(s ?? '').replace(/\s+/g, '').replace(/^@+/, '');
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
   * 在已经打开的聊天框里把话发出去，并确认真的发出去了。
   * contenteditable 清空后会剩一个零宽字符，trim() 去不掉，所以要自己剥。
   */
  async sendInChat(page, input, text) {
    const read = () =>
      input
        .evaluate((el) => String(el.value ?? el.textContent ?? '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim())
        .catch(() => '');
    await input.click({ timeout: 6000 });
    // 打字快一点：8ms/字 打 20 个字只要 0.16 秒（以前 24ms 要 0.5 秒）。
    // 抖音输入框不看按键节奏，看的是「最后一个输入事件之后有没有变化」，所以还能再快。
    await input.pressSequentially(String(text).slice(0, 300), { delay: 8 });
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
      // 有些版本回车只是换行，得点发送
      const sendBtn = page.locator('[data-e2e="msg-send"]').first();
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
  async readMessages(page, size = 12) {
    return await page
      .evaluate((n) => {
        const isMine = (el) => !!(el.closest && el.closest('[class*="isFromMe"]'));
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
            kind = 'image';
            text = `[图片${imgs > 1 ? `×${imgs}` : ''}]`;
          } else {
            continue;
          }
          if (!text) continue;
          out.push({
            from: isMine(el) ? 'me' : 'them',
            kind,
            text: cut(text, 220),
            url,
            title,
            author,
          });
        }
        // 最新在前 → 时间顺序
        return out.slice(0, n).reverse();
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

  /** 读会话列表里某个人那一行（零点击）：预览文本 + 未读数。 */
  async readRow(page, want) {
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
  async replyDm(name, text) {
    const who = String(name ?? '').trim();
    if (!who) throw new DouyinError('BAD_TARGET', '没有会话昵称，回不了');
    // 私信页正停在这个会话上：不用跳转、不用点会话，直接打字回车。
    // 这是「秒回」的关键一段——省掉整页导航（6-8 秒）和点会话后的固定停顿（2.4 秒）。
    const dm = this.dmPage;
    if (dm && !dm.isClosed() && this.dmThread === who) {
      const input = await this.waitMsgInput(dm, 3000).catch(() => null);
      if (input) {
        await this.sendInChat(dm, input, text);
        this.lastAction = `dm ${who}`;
        return { ok: true, sent: true, fast: true };
      }
    }
    return this.serialize(async () => {
      const page = await this.getPage();
      if (!(await this.isLoggedIn())) throw new DouyinError('LOGIN_REQUIRED', '抖音还没登录，发不了私信');
      try {
        // 已经在这个会话里就直接用：省一次整页跳转和点击，回私信快好几秒
        if (this.openThread !== who || !/\/chat/.test(page.url())) {
          if (!/\/chat/.test(page.url())) await this.goto(page, `${ORIGIN}/chat`, 5200);
          const item = page.locator('[data-e2e="conversation-item"]', { hasText: who }).first();
          if (!(await item.count())) throw new DouyinError('NO_DM', '聊天列表里找不到这个会话，可能被新消息刷下去了');
          await item.click({ timeout: 6000 });
          this.openThread = who;
          // 点完不用干等两秒：下面 waitMsgInput 会一轮一轮等到输入框真的能打字
          await page.waitForTimeout(200);
        }
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
