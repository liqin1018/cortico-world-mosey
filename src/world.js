import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { Policy, approvalFor, clampText } from './policy.js';
import { Bilibili } from './bilibili.js';
import { DouyinBrowser, secUidOf, stripLeadingFakeAt } from './douyin.js';
import { StickerBook } from './stickers.js';
import { TOOL_DECLS, EVENT_DECLS } from './tools.js';
import { CONFIG_GROUPS, DEFAULTS, validatePolicyPatch } from './config.js';
import {
  cutChars,
  dayKey,
  hourOf,
  imageMimeOf,
  looksBrokenPath,
  nowIso,
  openFolder,
  openInBrowser,
  parseBvid,
  parseCvid,
  parseDouyinId,
  parseDynamicId,
  pickFolder,
  platformUrl,
  repairMojibakePath,
  stripAtName,
  stripAtPlaceholder,
  truncate,
} from './util.js';

const ACTION_NAMES = {
  like: '赞',
  unlike: '取消赞',
  follow: '关注',
  unfollow: '取关',
  comment: '评论',
  reply: '回复',
  post: '发动态',
  dm: '私信',
  sticker: '表情包',
  image: '图片',
  save: '稍后再看',
};

const PLATFORM_NAMES = { bilibili: 'B站', douyin: '抖音' };

/** 额度档位对应的动作名，面板点开「今天做了什么」时用。 */
const METER_ACTIONS = {
  like: ['like', 'unlike'],
  comment: ['comment', 'reply'],
  follow: ['follow', 'unfollow'],
  post: ['post'],
  dm: ['dm'],
  save: ['save'],
};

/** 活跃度档位：一键改额度 + 自己出门次数 + 出门间隔，省得一项项调。 */
const ACTIVITY_PRESETS = {
  quiet: { label: '安静', dailyLikes: 4, dailyComments: 1, dailyFollows: 0, dailyPosts: 0, dailySaves: 2, autoSessionsPerDay: 1, autoGapMinutes: 300, tokenDailyBudget: 3000 },
  normal: { label: '日常', dailyLikes: 10, dailyComments: 4, dailyFollows: 2, dailyPosts: 1, dailySaves: 5, autoSessionsPerDay: 3, autoGapMinutes: 150, tokenDailyBudget: 6000 },
  lively: { label: '活跃', dailyLikes: 16, dailyComments: 6, dailyFollows: 3, dailyPosts: 2, dailySaves: 8, autoSessionsPerDay: 5, autoGapMinutes: 90, tokenDailyBudget: 9000 },
  chatty: { label: '话痨', dailyLikes: 24, dailyComments: 10, dailyFollows: 5, dailyPosts: 3, dailySaves: 10, autoSessionsPerDay: 8, autoGapMinutes: 60, tokenDailyBudget: 15000 },
};
const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

export class StrollWorld {
  constructor({ cfg, timezone, dataDir, persist, log }) {
    this.id = 'stroll';
    this.cfg = cfg;
    this.timeZone = timezone || 'Asia/Shanghai';
    this.dataDir = dataDir;
    this.persist = persist;
    this.log = log ?? {
      // 宿主没给 logger 也别让日志消失：至少进 stdout，core.log 里能看到
      info: (...args) => console.log('[stroll]', ...args),
      warn: (...args) => console.warn('[stroll]', ...args),
    };
    this.host = null;
    this.store = new Store(path.join(dataDir, 'stroll'), this.timeZone).load();
    this.store.data.autoSessions ??= {};
    this.policy = new Policy({ store: this.store, cfg, timeZone: this.timeZone });
    this.bili = new Bilibili({ dataDir, cfg, log, policy: this.policy, store: this.store });
    this.stickers = new StickerBook({ dataDir, log });
    this.douyin = new DouyinBrowser({ dataDir, cfg, log, policy: this.policy, stickers: this.stickers });
    // 扫码成功后顺手记下「现在登的是哪个抖音号」，面板要显示，也要防「给自己发私信」
    this.douyin.onSelf = (self) => this.noteDouyinSelf(self);
    this.timer = null;
    this.lastStatus = null;
    this.lastStatusAt = 0;
    this.lastImportAt = 0;
    this.lastOpen = null;
    this.inboxCache = [];
    this._dyInbox = null;
    this._dyInboxAt = 0;
    this._cfgLive = null;
    this._cfgAt = 0;
    this.presence = null;
    this.lastPresenceNotify = 0;
    this.watch = null;
    this.watchTimer = null;
    this.lastWatchPush = 0;
    this.dmTimer = null;
    this.dmBusy = false;
    /** 正在挂「私信事件通道」；以及上次尝试/上次对账的时间。 */
    this.dmArmBusy = false;
    this.dmArmAt = 0;
    this.dmArmFails = 0;
    this.dmSweepAt = 0;
    /** 群聊观察器：挂的时候防并发，以及上次尝试的时间（失败退避用）。 */
    this.groupArmBusy = false;
    this.groupArmAt = 0;
    this.groupDeepAt = 0;
    /** 自动识别出来的群名缓存：{ at, names, next, seenAt }。2 分钟刷一次，dmBeat 不会反复读页面。 */
    this.groupAuto = { at: 0, names: [], next: 0, seenAt: {} };
    /**
     * 上一次推给她的**群**消息是哪个群：{ group, at }。
     * 她回话时经常漏 target——有这个上下文，就能判断「这条本该回群」，
     * 而不是悄悄发给主人私信（以前就是这么把群回复变成私信的）。
     * 主人自己发私信、或者群消息已经回过了，就清掉。
     */
    this.lastGroupPoke = null;
    /** 上一次推私信的时间：主人刚说过话就以私信为准，别被随后进来的群消息抢走上下文。 */
    this.lastDmPoke = { at: 0 };
    /** 上一次推「该出门溜达了」的时间：那个窗口里她做的动作算自己出门，按 20 秒节奏。 */
    this.autoWalkAt = 0;
    this.running = false;
  }

  /**
   * 这次动作算「主人让她做的」吗？
   * 主人刚发过私信 → 算；否则只要不在自己出门的窗口里，也算（面板里说话、让她看个视频都算）。
   * 只有「刚被 stroll.due 叫去逛」的那段时间才切回严格节奏，避免连发招 -509。
   */
  ownerNearby() {
    if (this.policy.ownerActive()) return true;
    return Date.now() - Number(this.autoWalkAt ?? 0) > 15 * 60 * 1000;
  }

  /* ---------------- lifecycle ---------------- */

  async start(host) {
    this.host = host;
    this.running = true;
    this.store.load();
    this.store.data.autoSessions ??= {};
    this.timer = setInterval(() => {
      this.tick().catch(() => {});
    }, 10 * 60 * 1000);
    // 启动后先让进程稳定，再决定要不要自己出门
    setTimeout(() => this.tick().catch(() => {}), 90 * 1000);
    this.startDmWatch();
  }

  async stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stopDmWatch();
    this.stopWatchTimer();
    await this.douyin.close().catch(() => {});
    this.store.save();
  }

  async tick() {
    if (!this.running || !this.cfg.enabled) return;
    const hour = hourOf(new Date(), this.timeZone);
    if (hour < 9 || hour >= 23) return;
    if (this.policy.isQuiet() || this.policy.paused().paused) return;
    const day = dayKey(new Date(), this.timeZone);
    // 勾了「必做」但今天还没做够的项：出门要优先补，晚上到点还要单独催
    const pending = this.mustDoList().filter((x) => x.left > 0);
    await this.maybeMustNudge(pending, hour, day);
    if (this.cfg.autoSessionsPerDay <= 0) return;
    const used = Number(this.store.data.autoSessions[day] ?? 0);
    const budgetCap = Math.max(0, Math.floor(Number(this.cfg.tokenDailyBudget ?? DEFAULTS.tokenDailyBudget) / 1500));
    const cap = Math.min(Number(this.cfg.autoSessionsPerDay), budgetCap);
    if (used >= cap) return;
    // 用 lastAutoAt 而不是 lastSessionAt：主人手动让她看东西，不该把自动出门往后推
    const lastAuto = Number(this.store.data.lastAutoAt ?? this.store.data.lastSessionAt ?? 0);
    // 有必做没完成：间隔压到最多 30 分钟，而且不再掷骰子跳过
    const gap = pending.length ? Math.min(this.autoGapMs(), 30 * 60 * 1000) : this.autoGapMs();
    if (Date.now() - lastAuto < gap) return;
    if (!pending.length && Math.random() > 0.6) return;
    this.store.data.lastAutoAt = Date.now();
    this.store.data.autoSessions[day] = used + 1;
    // 记住「这是一次自己出门」：出门窗口内她连续做动作要按 20 秒节奏，
    // 不能拿主人点单的 1.5 秒去连发（那会招 -509）。
    this.autoWalkAt = Date.now();
    this.store.save();
    const mustLine = pending.length
      ? `\n今天是必做日，还差：${pending.map((x) => `${x.label} ${x.left}`).join('、')}。先补这些，别只刷着看。`
      : '';
    await this.push(
      'stroll.due',
      `该出门溜达了。今天还剩：${this.policy.summary()}。${mustLine}\n想逛就调 stroll action=brief（一次拿全，别连续 status/feed/inbox）；不想去就回「今天不逛」。`,
      { day, used: used + 1, must: pending.length > 0 },
      'debounce',
    );
  }

  /**
   * 今天的「必做」清单：勾了开关的项，目标次数就是对应的每日额度。
   * 用 usage 里的今日计数（unlike→like、reply→comment、unfollow→follow 已经在 capAction 里归一）。
   */
  mustDoList() {
    const day = dayKey(new Date(), this.timeZone);
    const usage = this.store.data.usage?.[day] ?? {};
    const items = [
      ['like', '点赞', 'mustLike', 'dailyLikes', '次'],
      ['comment', '评论', 'mustComment', 'dailyComments', '条'],
      ['follow', '关注', 'mustFollow', 'dailyFollows', '人'],
      ['post', '发动态', 'mustPost', 'dailyPosts', '条'],
    ];
    return items
      .filter(([, , flag]) => this.cfg[flag] === true)
      .map(([action, label, , quotaKey, unit]) => {
        const need = Math.max(0, Number(this.cfg[quotaKey] ?? 0));
        const done = Number(usage[action] ?? 0);
        return { action, label, unit, need, done, left: Math.max(0, need - done) };
      })
      .filter((x) => x.need > 0);
  }

  /** 晚上还没做完必做：单独催她，最多 3 次、每次间隔 30 分钟。 */
  async maybeMustNudge(pending, hour, day) {
    if (!pending?.length || hour < 18) return;
    const state = this.store.data.mustNudge ?? {};
    if (state.day !== day) {
      state.day = day;
      state.n = 0;
      state.at = 0;
    }
    if (Number(state.n ?? 0) >= 3) return;
    if (Date.now() - Number(state.at ?? 0) < 30 * 60 * 1000) return;
    state.n = Number(state.n ?? 0) + 1;
    state.at = Date.now();
    this.store.data.mustNudge = state;
    this.store.save();
    await this.push(
      'stroll.due',
      `今天还有必做没完成：${pending.map((x) => `${x.label} ${x.done}/${x.need}`).join('、')}。现在就去补，不用等下一次出门；补完再回我一句。`,
      { must: true, day },
      'flush',
    );
  }

  /* ---------------- 私信监听：主人一说话就接上 ---------------- */

  /**
   * 以前只有「她自己去查」才看得到私信：主人在抖音/B站说完，要等她下一次出门才回，
   * 表现出来就是「发了好几句，半天没人理，最后只回了一条」。
   * 这里按 dmPollSec 轮询两边的会话：B站走 HTTP（几十毫秒），抖音读已经开着的聊天页 DOM。
   * 一出现「主人说的新话」就推一条事件把她叫起来，马上回。
   */
  startDmWatch() {
    this.stopDmWatch();
    if (!this.running) return;
    this.dmLastAt = 0;
    const live = this.liveConfig() ?? {};
    const warm = this.dmWatchOn(live) && (live.douyin ?? this.cfg.douyin) !== false;
    // 抖音监听要靠浏览器读 DOM：保持后台页面热着，冷启动一次要十几秒，那段时间的消息接不住
    this.douyin.keepWarm?.(warm);
    // 抖音走「事件通道」：客服页里的观察器一看到新消息就直接回调过来，几百毫秒内就知道。
    // 这条路不轮询、不点会话，所以可以做得比轮询快得多。
    if (warm) this.armDmPush().catch(() => {});
    // 心跳 5 秒：抖音有事件通道后这里只是兜底（挂观察器、防掉线）；
    // B站是 HTTP，几秒一次毫无压力。
    this.dmTimer = setInterval(() => {
      this.dmBeat().catch(() => {});
    }, 5 * 1000);
    // 刚启动别抢登录/初始化，等十几秒再开始看
    setTimeout(() => this.dmBeat().catch(() => {}), 8 * 1000);
  }

  /**
   * 把抖音的「新消息」事件通道挂上：单独一个聊天页停在主人会话上，
   * 页面里的 MutationObserver 一变就回调 onDouyinPoke。
   */
  async armDmPush() {
    if (this.dmArmBusy) return;
    const owner = this.douyinOwner();
    if (!owner.secUid) return;
    this.dmArmBusy = true;
    try {
      const name = owner.name || (await this.douyinOwnerName().catch(() => ''));
      if (!name) return;
      // 不在这里判「已经挂好了」：watchDm 自己会判断，而且它还要把回调换成最新的这个
      const res = await this.douyin.watchDm(name, (messages) => this.onDouyinPoke(messages, name)).catch(() => null);
      if (res?.ok) {
        this.dmArmFails = 0;
        this.log?.info?.('stroll dm push armed', { thread: res.thread ?? name });
      } else {
        this.dmArmFails = Number(this.dmArmFails ?? 0) + 1;
        this.log?.warn?.('stroll dm push arm failed', { code: res?.code, fails: this.dmArmFails });
      }
    } finally {
      this.dmArmBusy = false;
    }
  }

  /**
   * 要盯的抖音群。
   *
   * 抖音的群如果没起名，会话列表里显示的是成员名拼起来的「A, B, C」——
   * 这种标题本身带逗号，所以配置里那条既可能是「一个群名」也可能是「两个群名」，
   * 光靠分隔符分不清。做法是：把配置切成片段，拿去和自动识别出的真实群名比对，
   * 命中的用真实群名；一个都没命中才把片段当成群名直接用（手填的场合）。
   */
  /** 名单里最多保留几个群（用户可配，默认 6）。 */
  maxGroupsCap() {
    return clamp(Math.round(Number(this.cfg.maxGroups ?? 6) || 6), 1, 10);
  }

  /** 最多给几个群常驻监听页（用户可配，默认 3）。 */
  groupTabsCap() {
    return clamp(Math.round(Number(this.cfg.groupTabs ?? 3) || 3), 1, 8);
  }

  groupNames() {
    const cap = this.maxGroupsCap();
    const raw = String(this.cfg.douyinGroups ?? '').trim();
    const detected = (this.groupAuto?.names ?? []).slice(0, cap);
    if (!raw) return detected.slice(0, cap);
    const fragments = raw
      .split(/[,，、;；\n]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const hit = [];
    // 整条配置先当成一个群名比一次（群名自带逗号时这一步就命中）
    const whole = this.matchGroup(detected, raw);
    if (whole) hit.push(whole);
    for (const f of fragments) {
      const m = this.matchGroup(detected, f);
      if (m && !hit.includes(m)) hit.push(m);
    }
    // 以前这里写死 slice(0,2)：手填群名后反而只能认 2 个。现在跟 maxGroups 一致
    if (hit.length) return hit.slice(0, cap);
    // 还没识别到群（或手填的名字对不上）：先按片段当群名，挂载时会再核一次
    return fragments.slice(0, cap);
  }

  /** 群名比较：忽略空白和大小写，允许「包含」——这样她只写「小月月」也能对上。 */
  sameGroup(a, b) {
    const norm = (s) =>
      String(s ?? '')
        .replace(/[\s\u3000]+/g, '')
        .replace(/\(\d+\)$|（\d+）$/, '')
        .toLowerCase();
    const x = norm(a);
    const y = norm(b);
    if (!x || !y) return false;
    return x === y || x.includes(y) || y.includes(x);
  }

  /** 群名的比较键：去掉空白、大小写，以及同名群加的「#2」后缀。 */
  groupKey(name) {
    return String(name ?? '')
      .replace(/\s*#\d+$/, '')
      .replace(/[\s\u3000]+/g, '')
      .toLowerCase();
  }

  /**
   * 在已知群名里挑目标：**整串相等优先，其次「唯一包含」**。
   * 两个群共用成员时（「A, 穹, 大萌神」和「A, 穹, 阿猫」），
   * 只写「A」两个都像——这时候返回 null，宁可让她问清楚，也不能把话发错群。
   */
  matchGroup(names, wanted) {
    const norm = (s) =>
      String(s ?? '')
        .replace(/[\s\u3000]+/g, '')
        .replace(/\(\d+\)$|（\d+）$/, '')
        .toLowerCase();
    const key = norm(wanted);
    if (!key) return null;
    const list = (names ?? []).filter(Boolean);
    const exact = list.find((n) => norm(n) === key);
    if (exact) return exact;
    /**
     * 只允许「她写的是群名的一部分」：写「大萌神」→ 命中「A, 穹, 大萌神」。
     *
     * **反过来绝对不行**：她写的是更长的群名（第二个群）时，
     * 拿它去 `key.includes(群一)` 会命中更短的那个群一——
     * 于是本该发到群二的话静静发进了群一，回执还写「发出去了」。
     * 这正是「第二个群怎么回都没动静」的来源之一。
     */
    const part = list.filter((n) => norm(n).includes(key));
    return part.length === 1 ? part[0] : null;
  }

  /** 群监听的开关 + 平台开关是否都允许。 */
  groupWatchOn(live = this.liveConfig() ?? {}) {
    if (live.groupWatch === false || this.cfg.groupWatch === false) return false;
    if ((live.douyin ?? this.cfg.douyin) === false) return false;
    return true;
  }

  /**
   * 自动认出她在哪些群里：会话列表里 `kind === 'group'` 的那些。
   *
   * 缓存 2 分钟（以前 10 分钟：主人刚把她拉进第二个群时，名单要等十分钟才更新，
   * 这期间她回群会被当成「没这个群」）。force=true 时**滚动列表做深度读取**，
   * 因为抖音的会话列表是虚拟的，不滚就只有看得见的那几条。
   */
  async resolveGroups(force = false, { deep = false } = {}) {
    if (!this.groupWatchOn()) return [];
    /**
     * 有页面正停在 /chat 时，读一次只是几毫秒的 DOM 扫描——45 秒刷一次，
     * 主人刚把她拉进新群也能很快发现。没有常驻聊天页时得靠主页面导航过去，
     * 那就别刷太勤（5 分钟），免得把她正在看的视频顶掉。
     */
    const liveChat = [this.douyin?.dmPage, ...(this.douyin?.groupPages?.values?.() ?? [])].some(
      (p) => p && !p.isClosed() && /\/chat/.test(p.url()),
    );
    const ttl = liveChat ? 45 * 1000 : 5 * 60 * 1000;
    const cache = this.groupAuto ?? { at: 0, names: [], next: 0, seenAt: {} };
    // next 是显式的下次可重试时间；老缓存只有 at，就按 at + 2 分钟算
    const nextAt = Number(cache.next ?? 0) || Number(cache.at ?? 0) + ttl;
    if (!force && Date.now() < nextAt) return this.groupNames();
    // 几个地方会同时问（心跳、发送前解析群名）：共用同一次读页面，
    // 别让它们各自去 goto /chat —— 那正是把聊天页折腾死的来源之一
    if (this.groupResolving) return this.groupResolving;
    this.groupResolving = (async () => {
      const res = await this.douyin.listThreads({ deep: deep || !!force }).catch(() => null);
      if (!res?.ok) {
        // 读不到（没登录 / 页面还没起来）：留个 2 分钟的重试窗口，
        // 不然 dmBeat 每 5 秒就会去拉一次会话列表，白白折腾抖音。
        this.groupAuto = {
          at: cache.at ?? 0,
          names: cache.names ?? [],
          next: Date.now() + 2 * 60 * 1000,
          seenAt: cache.seenAt ?? {},
        };
        return this.groupNames();
      }
      return this.absorbGroups(res.threads, { via: res.via, ttlMs: ttl });
    })().finally(() => {
      this.groupResolving = null;
    });
    return this.groupResolving;
  }

  /**
   * 把一次会话列表读数里的群挑出来写进缓存。
   *
   * 两个群同名很常见：同一批人建的两个群、都没起名，抖音就把成员名拼成一样的标题。
   * 光看标题永远只认得出「一个」群，第二个群既盯不上、也点不开。
   * 所以同名时按出现顺序加「#2」后缀，并把会话 id 记下来，点击时按 id 精确定位。
   */
  absorbGroups(threads, { via = '', ttlMs = 2 * 60 * 1000 } = {}) {
    const detected = (threads ?? []).filter((t) => t.kind === 'group' && t.name);
    const cids = { ...(this.groupCids ?? {}) };
    const dup = new Map();
    const labels = [];
    for (const t of detected) {
      const k = this.groupKey(t.name);
      const n = (dup.get(k) ?? 0) + 1;
      dup.set(k, n);
      const label = n === 1 ? t.name : `${t.name} #${n}`;
      labels.push(label);
      if (t.cid) cids[label] = t.cid;
    }
    this.groupCids = cids;
    if (this.douyin) this.douyin.threadCids = cids;
    const now = Date.now();
    const seenAt = { ...(this.groupAuto?.seenAt ?? {}) };
    for (const n of labels) seenAt[n] = now;
    // 虚拟列表偶尔会读少一个群：15 分钟内还认它，别把它踢下线
    // （踢了会把它的 tab 关掉，下一拍再重开，来回折腾）
    const keep = Object.keys(seenAt).filter((n) => now - Number(seenAt[n] ?? 0) < 15 * 60 * 1000);
    const names = [...new Set([...labels, ...keep])].slice(0, this.maxGroupsCap());
    const before = this.groupAuto?.names ?? [];
    this.groupAuto = { at: now, names, next: now + ttlMs, seenAt };
    if (JSON.stringify(names) !== JSON.stringify(before)) {
      this.log?.info?.('stroll groups detected', { groups: names, total: (threads ?? []).length, via });
    }
    return this.groupNames();
  }

  /** 把要盯的群各挂一个观察器（每个群一个后台 tab，跟私信同一个机制）。 */
  async armGroupPush() {
    if (this.groupArmBusy) return;
    if (!this.groupWatchOn()) return;
    const names = await this.resolveGroups().catch(() => []);
    if (!names.length) return;
    // 名单可以有很多个，但常驻监听页只给前 groupTabs 个；其余的群发消息时再临时点进去
    const watch = names.slice(0, this.groupTabsCap());
    this.groupArmBusy = true;
    try {
      for (const name of watch) {
        if (this.douyin.groupArmed?.(name)) continue;
        const slot = this.douyin.groupSlot?.(name);
        // 连续挂不上的群要退避：两个群都挂不上时，不能每 30 秒把两个聊天页各重开一遍
        if (slot?.nextTryAt && Date.now() < slot.nextTryAt) continue;
        const res = await this.douyin.watchGroup(name, (messages) => this.onGroupPoke(messages, name)).catch(() => null);
        if (res?.ok) {
          if (slot) {
            slot.failCount = 0;
            slot.nextTryAt = 0;
          }
          this.log?.info?.('stroll group watch armed', { group: name });
          await this.seedGroupBaseline(name).catch(() => {});
        } else {
          if (slot) {
            slot.failCount = Math.min(5, Number(slot.failCount ?? 0) + 1);
            slot.nextTryAt = Date.now() + Math.min(10 * 60 * 1000, 30 * 1000 * 2 ** (slot.failCount - 1));
          }
          this.log?.warn?.('stroll group watch failed', { group: name, code: res?.code, fails: slot?.failCount });
        }
      }
      // 不在名单里的群（退群/换了群）把它的 tab 收掉，别一直挂着占内存
      await this.douyin.pruneGroupPages?.(watch).catch(() => {});
    } finally {
      this.groupArmBusy = false;
      /**
       * 开新群/挂群页的这段时间里，私信监听可能被挤掉（页面被切走、观察器丢了）。
       * 顺手补挂一次：不然「新开了群之后私信不回」会一直持续到下一轮心跳。
       */
      if (this.dmWatchOn() && !this.douyin.dmArmed?.()) this.armDmPush().catch(() => {});
    }
  }

  /** 一条消息的身份，用来做「上次看到的是哪条」的锚点。 */
  msgKey(m) {
    return `${m?.who ?? ''}:${m?.kind ?? ''}:${m?.text ?? ''}`;
  }

  /** 末尾连着的那几句（都是对方说的），最多 cap 条。 */
  dmTailOf(messages, cap = 4) {
    const tail = [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].from !== 'them') break;
      tail.unshift(messages[i]);
      if (tail.length >= cap) break;
    }
    return tail;
  }

  fpOf(tail) {
    return tail.map((m) => this.msgKey(m)).join('|').slice(0, 300);
  }

  /**
   * 群消息的「新增内容」。
   *
   * 以前只按「末尾一路往前收，遇到自己发的就停」来取尾巴。群里根本没有自己发的消息，
   * 于是一条新话会把整个群历史当成新消息全推一遍。
   *
   * 现在用「上一屏见过哪些消息」当边界：从最新的往前收，一碰到见过的就停。
   * 存的是 key 的集合而不是单条锚点，这样即便消息列表被虚拟化裁剪、
   * 或者顺序抖动，也不会把旧话重新当成新话。
   */
  groupTailFp(messages, seen = null) {
    const list = Array.isArray(messages) ? messages : [];
    const last = list.length ? this.msgKey(list[list.length - 1]) : '';
    const known = new Set(seen?.tail ?? []);
    const tail = [];
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const m = list[i];
      // 自己说的话就是边界：前面那些更旧的不可能还没被接住
      if (m.from !== 'them') break;
      if (known.has(this.msgKey(m))) break;
      tail.unshift(m);
      if (tail.length >= 6) break;
    }
    return {
      tail,
      fp: this.fpOf(tail),
      last,
      // 记下这一屏都见过什么，下一拍据此判断「新」在哪里
      tailKeys: list.slice(-8).map((m) => this.msgKey(m)),
    };
  }

  /**
   * 刚挂上观察器时先把当前末尾记成基线。
   * 不这么做的话，进群之后的第一条消息会被当成「基线」吞掉——表现就是「她怎么不理」。
   */
  async seedGroupBaseline(name) {
    const slot = this.douyin.groupPages?.get?.(name);
    const page = slot?.page;
    if (!page || page.isClosed()) return;
    // 带超时：这里卡住会把 armGroupPush 整个堵死（groupArmBusy 一直 true，第二个群永远挂不上）
    const messages = await Promise.race([
      this.douyin.readGroupMessages(page, 10).catch(() => []),
      new Promise((resolve) => setTimeout(() => resolve([]), 8000)),
    ]);
    if (!messages.length) return;
    const { fp, last, tailKeys } = this.groupTailFp(messages);
    this.store.data.dmSeen = {
      ...(this.store.data.dmSeen ?? {}),
      groups: { ...(this.store.data.dmSeen?.groups ?? {}), [name]: { fp, last, tail: tailKeys, at: Date.now() } },
    };
    this.store.save();
  }

  /** 群里有人说话：跟私信走同一套去重和推送，只是多带群名和发言人。 */
  async onGroupPoke(messages, group) {
    if (!this.running || !this.dmWatchOn() || !messages?.length) return;
    const paused = this.policy.paused();
    const soft = paused.paused && /-509|-412|429|频繁|rate/i.test(String(paused.reason ?? ''));
    if (paused.paused && !soft) return;
    const seen = this.store.data.dmSeen?.groups?.[group] ?? null;
    const saveSeen = (value) => {
      this.store.data.dmSeen = {
        ...(this.store.data.dmSeen ?? {}),
        groups: { ...(this.store.data.dmSeen?.groups ?? {}), [group]: value },
      };
      this.store.save();
    };
    const { tail, fp, last, tailKeys } = this.groupTailFp(messages, seen);
    if (!seen) {
      // 第一次看到这个群：把当前这一屏记成基线，别把历史消息全推一遍
      saveSeen({ fp, last, tail: tailKeys, at: Date.now() });
      return;
    }
    // 最后一条没变 = 没有新消息（页面上别的地方抖了一下，不算）
    if (seen.last && seen.last === last) return;
    // 有新消息就记下这一屏。哪怕新话全是自己发的（tail 空）也要更新，
    // 否则下次会把这几条自己的话当成别人的新消息推给她。
    saveSeen({ fp, last, tail: tailKeys, at: Date.now() });
    if (!tail.length) return;
    // 记下「这次说的是哪个群」：她回话时漏了 target 也能判断出该回群
    this.lastGroupPoke = { group, at: Date.now() };
    const lines = tail.map((m) => `${m.who || '有人'}：${m.url ? `${m.text}（${m.url}）` : m.text}`);
    // 群友发的图也一起带上：不然她只知道「有张图」，看不见内容
    const urls = tail.flatMap((m) => (m.image ? [m.image] : []));
    const blobs = urls.length
      ? await this.imageBlobsSoon(urls, { platform: 'douyin', label: '群里的图片' })
      : null;
    const savedLine = blobs?.saved?.length
      ? `\n图已存到本地：${blobs.saved.map((f) => f.name).join('、')}（要转发就用 stroll_act action=image file=<这个名字>）`
      : '';
    const body =
      `群「${group}」有人说话：\n${lines.join('\n')}\n` +
      `回群：stroll_act action=dm platform=douyin target=${group} text=…` +
      '（target 原样照抄群名；不用每条都回）' +
      savedLine;
    if (!urls.length && tail.some((m) => m.kind === 'image' || m.kind === 'emoji')) {
      this.log?.warn?.('stroll image url missing (group)', { group, kinds: tail.map((m) => m.kind) });
    } else if (urls.length && !blobs?.length) {
      this.log?.warn?.('stroll image fetch failed (group)', { group, urls: urls.slice(0, 2) });
    }
    const meta = { platform: 'douyin', group, count: tail.length, images: urls.length };
    if (await this.push('stroll.reply', body, meta, 'interrupt', blobs)) return;
    if (await this.push('stroll.reply', body, meta, 'flush', blobs)) return;
    await this.push('stroll.reply', body, meta, 'debounce', blobs);
  }

  /** 私信监听到底该不该干活：总开关、私信开关、平台开关都得是开的。 */
  dmWatchOn(live = this.liveConfig() ?? {}) {    const enabled = (live.enabled ?? this.cfg.enabled) !== false;
    const on = (live.dmWatch ?? this.cfg.dmWatch) !== false;
    if (!enabled || !on) return false;
    return (live.douyin ?? this.cfg.douyin) !== false || (live.bilibili ?? this.cfg.bilibili) !== false;
  }

  stopDmWatch() {
    if (this.dmTimer) clearInterval(this.dmTimer);
    this.dmTimer = null;
    // 万一上一拍还卡在某个页面调用里，标记要清掉，不然重新开监听会一直跳过心跳
    this.dmBeatBusy = false;
    this.douyin.keepWarm?.(false);
  }

  /** 心跳：按设置里的开关和间隔决定这一拍要不要真去看。 */
  async dmBeat() {
    if (!this.running) return;
    /**
     * 绝不叠着跑。这一拍里有「解析群名 → 给每个群开/点会话页」这种十几秒的活，
     * 而定时器是 5 秒一次：群一多（两个群），上一拍还没跑完下一拍就进来，
     * 两个心跳同时对同一个聊天页做 goto / evaluate，页面直接被折腾死——
     * 表现就是「拉进第二个群之后整个桌宠卡住不动」。
     */
    if (this.dmBeatBusy) return;
    this.dmBeatBusy = true;
    try {
      await this.dmBeatOnce();
    } finally {
      this.dmBeatBusy = false;
    }
  }

  async dmBeatOnce() {
    const live = this.liveConfig() ?? {};
    if (!this.dmWatchOn(live)) {
      // 主人在设置里关掉了：把后台页面放掉，别白占内存
      this.douyin.keepWarm?.(false);
      return;
    }
    const useDy = (live.douyin ?? this.cfg.douyin) !== false;
    // 兜底：观察器没挂上（刚重启、页面被带跑、掉线重连）就补挂一次。
    // 连不上时按 20s→40s→…→10min 退避，别在没登录的时候一直刷抖音。
    if (useDy && !this.douyin.dmArmed?.()) {
      const fails = Math.min(5, Number(this.dmArmFails ?? 0));
      const gap = Math.min(10 * 60 * 1000, 20000 * 2 ** fails);
      if (Date.now() - Number(this.dmArmAt ?? 0) > gap) {
        this.dmArmAt = Date.now();
        this.armDmPush().catch(() => {});
      }
    }
    // 群聊：观察器掉了就补挂（30 秒最多试一次）。
    // 群名留空时靠自动识别；每 3 分钟滚动会话列表做一次深度读取，
    // 这样刚被拉进的新群不用等旧名单过期就能被发现。
    if (useDy && this.groupWatchOn(live) && Date.now() - Number(this.groupArmAt ?? 0) > 30000) {
      const deep = Date.now() - Number(this.groupDeepAt ?? 0) > 3 * 60 * 1000;
      if (deep) this.groupDeepAt = Date.now();
      const names = await this.resolveGroups(false, { deep }).catch(() => []);
      const missing = names.filter((n) => !this.douyin.groupArmed?.(n));
      if (missing.length) {
        this.groupArmAt = Date.now();
        this.armGroupPush().catch(() => {});
      }
    }
    const sec = Math.max(3, Number(live.dmPollSec ?? this.cfg.dmPollSec ?? 3) || 3);
    if (Date.now() - Number(this.dmLastAt ?? 0) < sec * 1000 - 800) return;
    this.dmLastAt = Date.now();
    await this.watchDms();
  }

  async watchDms() {
    if (!this.running || this.dmBusy) return;
    // 风险冷却分软硬：频率限流（-509/频繁）是软的，几分钟到半小时就恢复，
    // 而且读私信的浏览操作不写任何东西，继续看没有风险——不能让它把主人的私信埋掉。
    // 只有验证码/封禁这种硬风险才真的全停（那种状态下连读都可能出问题）。
    const paused = this.policy.paused();
    const soft = paused.paused && /-509|-412|429|频繁|rate/i.test(String(paused.reason ?? ''));
    if (paused.paused && !soft) return;
    const live = this.liveConfig() ?? {};
    const useBili = (live.bilibili ?? this.cfg.bilibili) !== false;
    const useDy = (live.douyin ?? this.cfg.douyin) !== false;
    this.dmBusy = true;
    try {
      const fresh = [];
      if (useBili) fresh.push(...(await this.newBiliDm().catch(() => [])));
      // 抖音已经走事件通道时就不必每 5 秒读一遍 DOM 了；但每 60 秒仍然对一次账，
      // 万一观察器漏了（页面卡住、切走了），最多晚一分钟，而不是一直不响。
      const dyArmed = !!this.douyin.dmArmed?.();
      const sweep = !dyArmed || Date.now() - Number(this.dmSweepAt ?? 0) > 60 * 1000;
      if (useDy && sweep) {
        this.dmSweepAt = Date.now();
        fresh.push(...(await this.newDouyinDm().catch(() => [])));
      }
      await this.pushDm(fresh);
    } finally {
      this.dmBusy = false;
    }
  }

  /** 把「主人发私信了」这件事推给她。攒一批一起推，别一条一条地叫。 */
  async pushDm(fresh) {
    if (!fresh?.length) return false;
    // 主人在私信里说话了：接下来的回话对象是主人，不再是群
    this.lastGroupPoke = null;
    this.lastDmPoke = { at: Date.now() };
    // 主人刚点过单：接下来三分钟她做的动作都算「主人让的」，不套她自己出门的节奏，
    // 也不该因为给主人回私信就把后面的评论卡住（以前就是这里卡 90 秒）。
    this.store.data.ownerAskAt = Date.now();
    // 顺手把风控的连续计数清掉：主人重新开口，说明平台那边已经恢复了
    if (Number(this.store.data.risk?.strikes ?? 0) > 0) this.store.data.risk.strikes = 0;
    this.store.save();
    const lines = fresh.map((x) => `${PLATFORM_NAMES[x.platform] ?? x.platform}·${x.who}：${x.text}`);
    /**
     * 推给她的文字要短：这段话会进模型的上下文，越长首字越慢。
     * 以前每条都带一大段「别先查 status/feed…」，现在压成两句，实测能省一点推理时间。
     */
    // 带图私信：下载成附件一起推过去（最多两张，别把一条推送撑爆）
    const urls = fresh.flatMap((x) => x.images ?? []);
    const blobs = urls.length
      ? await this.imageBlobsSoon(urls, { platform: fresh[0].platform, label: '私信图片' })
      : null;
    // 收到的图已存到本地：告诉她文件名，想转发时才能用 action=image file=<名字>
    const savedLine = blobs?.saved?.length
      ? `\n图已存到本地：${blobs.saved.map((f) => f.name).join('、')}（要转发就用 stroll_act action=image file=<这个名字>）`
      : '';
    const body =
      `主人私信你：\n${lines.join('\n')}\n` +
      '现在就回一句短的，别查 status/feed。' +
      (fresh[0].platform === 'douyin' ? '抖音记得 target=主人。' : '') +
      savedLine;
    if (!urls.length && /\[图片\]|\[表情\]/.test(lines.join(' '))) {
      this.log?.warn?.('stroll image url missing (dm)', { who: fresh[0].who });
    } else if (urls.length && !blobs?.length) {
      this.log?.warn?.('stroll image fetch failed (dm)', { urls: urls.slice(0, 2) });
    }
    const meta = { platform: fresh[0].platform, count: fresh.length, images: urls.length };
    // interrupt 最急（当场把她叫起来）；宿主不认这个值就退到 flush / debounce，别让消息掉地上
    let sent = false;
    if (await this.push('stroll.reply', body, meta, 'interrupt', blobs)) sent = true;
    else if (await this.push('stroll.reply', body, meta, 'flush', blobs)) sent = true;
    else sent = await this.push('stroll.reply', body, meta, 'debounce', blobs);
    // 推送成功才把「这条已经接过」写进状态；失败就留着，下次还能再推（GLM #3）
    if (sent) {
      let dirty = false;
      for (const x of fresh) {
        try {
          if (x?.commit) {
            x.commit();
            dirty = true;
          }
        } catch {
          // 单条落状态失败不影响别的
        }
      }
      if (dirty) this.store.save();
    }
    return sent;
  }

  /**
   * 抖音页面里的观察器报到「消息列表变了」：直接判是不是主人的新话，是就立刻推。
   * 这条路径不经过任何轮询，抖音那边一更新 DOM 就到这儿（实测几百毫秒）。
   */
  async onDouyinPoke(messages, name) {
    if (!this.running || !this.dmWatchOn()) return;
    const paused = this.policy.paused();
    const soft = paused.paused && /-509|-412|429|频繁|rate/i.test(String(paused.reason ?? ''));
    if (paused.paused && !soft) return;
    const hit = this.douyinDmTail(messages, name, { commit: false });
    if (!hit) return;
    await this.pushDm([hit]);
  }

  /** B站私信：会话列表里主人那条的最新时间变了，就说明有新话。 */
  async newBiliDm() {
    const ownerUid = this.ownerId('bilibili');
    if (!ownerUid) return [];
    const sessions = await this.bili.dmSessions(8, { fresh: true }).catch(() => []);
    const hit = sessions.find((s) => String(s.talkerId) === String(ownerUid));
    if (!hit || !hit.fromThem || !hit.at) return [];
    const seen = this.store.data.dmSeen?.bilibili ?? null;
    if (seen && String(seen.at) === String(hit.at)) return [];
    const old = Date.now() / 1000 - Number(hit.at) > 300;
    // 会话预览只有最后一句，主人连着发好几条时会漏。顺手把末尾连着那几句都读出来。
    const thread = await this.bili.dmThread(ownerUid, 12).catch(() => []);
    const tail = [];
    for (let i = thread.length - 1; i >= 0; i -= 1) {
      if (String(thread[i].from) !== String(ownerUid)) break;
      tail.unshift(thread[i]);
    }
    const body = tail.length ? tail.map((m) => m.text).join(' / ') : hit.body;
    const nextSeen = { at: hit.at, body };
    // 第一次跑、或者这条已经放了好几分钟（上个版本的旧消息）：只记基线，不叫她
    if (!seen || old) {
      this.store.data.dmSeen = { ...(this.store.data.dmSeen ?? {}), bilibili: nextSeen };
      this.store.save();
      return [];
    }
    const images = tail.flatMap((m) => (m.image ? [m.image] : []));
    return [
      {
        platform: 'bilibili',
        who: this.cfg.ownerName || '主人',
        text: body || '（发来一条非文字消息）',
        images,
        // 指纹推迟到「真的推给她了」再写：推送失败回滚，下次轮询还能重来（GLM #3）
        commit: () => {
          this.store.data.dmSeen = { ...(this.store.data.dmSeen ?? {}), bilibili: nextSeen };
        },
      },
    ];
  }

  /** 抖音私信：读会话末尾连着的那几句主人说的话。 */
  async newDouyinDm() {
    const owner = this.douyinOwner();
    if (!owner.secUid) return [];
    const name = owner.name || (await this.douyinOwnerName().catch(() => ''));
    if (!name) {
      // 没昵称就没法定位会话：与其乱读别人的私信，不如跳过，等主人点一次「绑定这个号」
      this.log?.warn?.('stroll dm watch skipped: 还不知道主人抖音昵称');
      return [];
    }
    const res = await this.douyin.peekThread(name, 8).catch(() => null);
    if (!res?.ok || !res.messages?.length) return [];
    const hit = this.douyinDmTail(res.messages, name, { commit: false });
    return hit ? [hit] : [];
  }

  /**
   * 从一段会话消息里判断「有没有主人还没被接住的新话」。
   * 轮询和页面事件都走这里，保证两条路的去重口径一致。返回要推的条目或 null。
   */
  douyinDmTail(messages, name, { commit = true } = {}) {
    const list = Array.isArray(messages) ? messages : [];
    // 末尾连着的那几句，最多 6 条：主人连发一大串时别把整屏都塞进推送
    const tail = this.dmTailOf(list, 6);
    const fp = tail.map((m) => `${m.kind}:${m.text}`).join('|').slice(0, 300);
    const seen = this.store.data.dmSeen?.douyin ?? null;
    // 第一次跑：把当前尾巴记成基线。以前这里直接 return，基线一直为空，
    // 于是「装好以后主人发的第一句」永远被当成基线吞掉——正是「发了没反应」。
    if (!seen) {
      this.store.data.dmSeen = { ...(this.store.data.dmSeen ?? {}), douyin: { fp, at: Date.now() } };
      this.store.save();
      return null;
    }
    if (!tail.length) {
      // 末尾是我发的（说明已经接住了）：把指纹清掉，
      // 否则主人过会儿再发一模一样的一句（「在吗」），指纹相同就被当成旧消息吞了。
      if (seen.fp) {
        this.store.data.dmSeen = { ...(this.store.data.dmSeen ?? {}), douyin: { fp: '', at: Date.now() } };
        this.store.save();
      }
      return null;
    }
    if (seen.fp === fp) return null;
    const nextSeen = { fp, at: Date.now() };
    const payload = {
      platform: 'douyin',
      who: name,
      text: tail.map((m) => (m.url ? `${m.text}（${m.url}）` : m.text)).join(' / '),
      // 主人发来的图片：推的时候下载成附件，她才能真的看见
      images: tail.flatMap((m) => (m.image ? [m.image] : [])),
    };
    if (commit) {
      this.store.data.dmSeen = { ...(this.store.data.dmSeen ?? {}), douyin: nextSeen };
      this.store.save();
    } else {
      // 推送成功后再落指纹；推失败就不落，下一轮还会重来，不会把主人的话永久吞掉
      payload.commit = () => {
        this.store.data.dmSeen = { ...(this.store.data.dmSeen ?? {}), douyin: nextSeen };
      };
    }
    return payload;
  }

  async push(type, text, meta = {}, trigger = 'debounce', blobs = null) {
    if (!this.host) return false;
    try {
      const event = {
        type,
        source: this.id,
        ts: nowIso(this.timeZone),
        text,
        senderKey: `stroll:${type}`,
        origin: 'internal',
        meta,
        // 图片附件：宿主会按模型接受的 MIME 类型附上；不接受就用 fallbackText
        ...(blobs?.length ? { blobs } : {}),
      };
      try {
        await this.host.pushEvent(event, { trigger });
      } catch (error) {
        // 老宿主可能不认 blobs：别因为一张图把整条消息丢了
        if (!blobs?.length) throw error;
        const { blobs: _drop, ...plain } = event;
        this.log?.warn?.('stroll push with blobs failed, retry plain', { type, message: error?.message });
        await this.host.pushEvent(plain, { trigger });
      }
      return true;
    } catch (error) {
      this.log?.warn?.('stroll push failed', { type, trigger, message: error?.message });
      return false;
    }
  }

  /** 带时间预算的取图：超时就不带图先推，别为了一张图把回复拖慢。 */
  async imageBlobsSoon(urls, opts = {}, ms = 3000) {
    if (!urls?.length) return null;
    return Promise.race([
      this.imageBlobs(urls, opts).catch(() => []),
      new Promise((resolve) => setTimeout(() => resolve(null), ms)),
    ]);
  }

  /** 收到的图存这里：和「图片工坊」分开，但发图时两边都能挑。 */
  mediaInbox() {
    return path.join(this.dataDir, 'stroll', 'media');
  }

  /**
   * 把一张收到的图存到本地，返回 {name, path, kb}。
   * 文件名按内容 hash（recv-1a2b3c4d.jpg）：同一张图重复收到只存一份。
   */
  saveImageBytes(bytes) {
    const mime = imageMimeOf(bytes);
    if (!mime) return null;
    const ext = mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1];
    const hash = crypto.createHash('sha1').update(bytes).digest('hex').slice(0, 8);
    const name = `recv-${hash}.${ext}`;
    const file = path.join(this.mediaInbox(), name);
    try {
      if (!fs.existsSync(file)) {
        fs.mkdirSync(this.mediaInbox(), { recursive: true });
        fs.writeFileSync(file, bytes);
      }
      return { name, path: file, kb: Math.round(bytes.length / 1024) };
    } catch (error) {
      this.log?.warn?.('stroll image save failed', { name, message: error?.message });
      return null;
    }
  }

  /**
   * 把几条消息里的图片下载成附件（最多 limit 张），顺手存到本地收件箱。
   * 单张上限 6MB：宿主那边模型附件也有体积限制，太大反而整条丢掉。
   */
  async imageBlobs(urls, { limit = 2, maxBytes = 6 * 1024 * 1024, platform = 'douyin', label = '图片', save = true } = {}) {
    const list = (urls ?? [])
      .filter((u) => typeof u === 'string' && (/^https?:/.test(u) || /^data:image\//.test(u)))
      .slice(0, limit);
    const blobs = [];
    const files = [];
    for (const url of list) {
      let bytes = null;
      if (url.startsWith('data:image/')) {
        // 页面里直读出来的 dataURL（blob 图走的就是这条路）
        const m = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(url);
        if (m) bytes = Buffer.from(m[2], 'base64');
      } else {
        bytes =
          platform === 'bilibili'
            ? await this.bili.imageBytes(url).catch(() => null)
            : await this.douyin.imageBytes(url).catch(() => null);
      }
      if (!bytes || !bytes.length) {
        this.log?.warn?.('stroll image download empty', { url: url.slice(0, 90), platform });
        continue;
      }
      if (bytes.length > maxBytes) {
        this.log?.warn?.('stroll image too big', { url: url.slice(0, 90), kb: Math.round(bytes.length / 1024) });
        continue;
      }
      const mime = imageMimeOf(bytes);
      if (!mime) {
        this.log?.warn?.('stroll image mime unknown', { url: url.slice(0, 90), head: Buffer.from(bytes).subarray(0, 12).toString('hex') });
        continue;
      }
      // 收到的 webp 落盘时就转成 jpg：发出去时不用再转一次，也避开抖音上传框不收 webp 的坑
      let saveBytes = bytes;
      if (save && mime === 'image/webp' && platform === 'douyin') {
        const page =
          (this.douyin.dmPage && !this.douyin.dmPage.isClosed() ? this.douyin.dmPage : null) ||
          (this.douyin.page && !this.douyin.page.isClosed() ? this.douyin.page : null);
        const jpg = page ? await this.douyin.toJpegBytes(page, bytes).catch(() => null) : null;
        if (jpg) saveBytes = jpg;
      }
      const saved = save ? this.saveImageBytes(saveBytes) : null;
      if (saved) files.push(saved);
      blobs.push({
        bytes,
        mime,
        name: `${label}-${blobs.length + 1}`,
        fallbackText: `（${label} ${blobs.length + 1}：${Math.round(bytes.length / 1024)}KB ${mime}${saved ? `，已存为 ${saved.name}` : ''}）`,
      });
    }
    // 数组上挂一份「存到哪了」，调用方拼推送文案用（宿主只读 blobs 的每一项，不会看这个属性）
    blobs.saved = files;
    if (blobs.length) {
      this.log?.info?.('stroll image attached', {
        count: blobs.length,
        kb: blobs.map((b) => Math.round(b.bytes.length / 1024)),
      });
    }
    return blobs;
  }

  /* ---------------- prompt ---------------- */

  /**
   * 设置里改的值不一定热更新到运行中的实例——她可能还在读启动时那份 cfg。
   * 这里兜底读一次磁盘上的 config.json（两秒缓存），改完设置不用重启。
   */
  liveConfig() {
    const now = Date.now();
    if (this._cfgAt && now - this._cfgAt < 2000) return this._cfgLive;
    this._cfgAt = now;
    this._cfgLive = null;
    try {
      const file = path.join(this.dataDir, '..', 'config.json');
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      const world = parsed?.worlds?.stroll;
      if (world && typeof world === 'object') this._cfgLive = world;
    } catch {
      // 读不到就退回内存里的 cfg
    }
    return this._cfgLive;
  }

  /** 主人的账号：优先读磁盘上最新的那份，读不到再用内存里的。 */
  ownerId(platform) {
    const key = platform === 'douyin' ? 'ownerDouyin' : 'ownerUid';
    const live = this.liveConfig()?.[key];
    if (live) return String(live).trim();
    const inline = this.cfg?.[key];
    return String(inline ?? '').trim();
  }

  /**
   * 抖音主人这一栏可以填三种东西：sec_uid、主页链接（分享文案也行）、抖音号。
   * bound 只有前两种能当场成立；抖音号要解析一次（面板按钮或第一次发私信时）。
   */
  douyinOwner() {
    const raw = this.ownerId('douyin');
    const secUid = secUidOf(raw);
    const saved = this.store?.data?.douyinOwner;
    const self = this.store?.data?.douyinSelf;
    const selfSecUid = String(self?.secUid ?? '');
    const selfDouyinId = String(self?.douyinId ?? '');
    // 填的是抖音号、又正好是桌宠登录的那个号：不用解析也能判断「自己不能发给自己」
    const sameHandle = !secUid && !!selfDouyinId && raw.replace(/^@/, '').replace(/^抖音号[:：]\s*/, '').trim() === selfDouyinId;
    return {
      raw,
      secUid,
      name: secUid && saved?.secUid === secUid ? String(saved.name ?? '') : '',
      bound: !!secUid,
      selfSecUid,
      selfName: cleanNick(self?.name) ?? '',
      selfDouyinId,
      sameAsSelf: (!!secUid && !!selfSecUid && secUid === selfSecUid) || sameHandle,
    };
  }

  /** 抖音主人昵称：评论里 @ 人要用昵称。没存过就现读一次主页，然后写回 state。 */
  async douyinOwnerName() {
    const owner = this.douyinOwner();
    if (!owner.secUid) return '';
    if (owner.name) return owner.name;
    try {
      const got = await this.douyin.ownerProfile(owner.secUid);
      if (got?.name) {
        this.store.data.douyinOwner = {
          ...(this.store.data.douyinOwner ?? {}),
          secUid: owner.secUid,
          name: got.name,
          at: Date.now(),
        };
        this.store.save();
        return got.name;
      }
      this.log?.warn?.('stroll douyin owner name empty', { secUid: owner.secUid.slice(-8) });
    } catch (error) {
      // 读不到就算了：@ 会退化成纯文本，不该挡住评论本身
      this.log?.warn?.('stroll douyin owner profile failed', { message: error?.message });
    }
    return '';
  }

  noteDouyinSelf(self) {
    if (!self?.secUid) return;
    const prev = this.store.data.douyinSelf ?? {};
    // 页面没渲染完时 h1 会是「未登录」「抖音」这类占位，别把它当昵称存下来
    const name = cleanNick(self.name) || cleanNick(prev.name) || '';
    this.store.data.douyinSelf = {
      secUid: self.secUid,
      name,
      douyinId: self.douyinId || prev.douyinId || '',
      verified: self.verified === true ? true : prev.verified === true,
      at: Date.now(),
    };
    this.store.save();
  }

  /** 主人绑定情况：两边说法对齐，别让她自己猜。 */
  ownerLine() {
    const bili = this.ownerId('bilibili');
    const dy = this.douyinOwner();
    const bits = [
      bili
        ? `B站主人已绑（UID ${bili}${this.cfg.ownerName ? `，${this.cfg.ownerName}` : ''}）`
        : 'B站主人没绑（B站 @ 和私信要用）',
    ];
    if (dy.bound) {
      bits.push(
        `抖音主人已绑（sec_uid …${dy.secUid.slice(-8)}${dy.name ? `，${dy.name}` : ''}）${dy.sameAsSelf ? '；注意：这个号就是她现在登录的抖音号，抖音不能给自己发私信' : ''}`,
      );
    } else if (dy.raw) {
      bits.push(`抖音主人没绑（填的是「${truncate(dy.raw, 20)}」，还不是 sec_uid；面板点「读我的抖音号」换掉）`);
    } else {
      bits.push('抖音主人没绑（抖音私信要用）');
    }
    return bits.join('；');
  }

  /**
   * 确保「主人抖音」是能用的 sec_uid。填的是抖音号/主页链接时，现场解析一次并存回去。
   * 发私信前调用，所以填抖音号也能用，只是第一次慢一点。
   */
  async ensureDouyinOwner() {
    const raw = this.ownerId('douyin');
    if (!raw) {
      return {
        ok: false,
        error:
          '抖音主人没绑：面板「账号」里点「读我的抖音号」，或者把主页链接/抖音号填到「主人抖音」。抖音不能给自己发私信。',
      };
    }
    const direct = secUidOf(raw);
    if (direct) {
      if (direct !== raw) this.persist({ ownerDouyin: direct });
      const saved = this.store.data.douyinOwner;
      return { ok: true, secUid: direct, name: saved?.secUid === direct ? String(saved.name ?? '') : '' };
    }
    if (this.douyinOwner().sameAsSelf) {
      return {
        ok: false,
        error: `「${truncate(raw, 18)}」就是她现在登录的抖音号，抖音不能给自己发私信。给她换一个号登录，或者把你自己另一个号的主页链接填进来。`,
      };
    }
    try {
      const got = await this.douyin.resolveOwner(raw);
      this.persist({ ownerDouyin: got.secUid });
      this.store.data.douyinOwner = { secUid: got.secUid, name: got.name ?? '', at: Date.now() };
      this.store.save();
      return { ok: true, secUid: got.secUid, name: got.name ?? '', resolved: true };
    } catch (error) {
      return {
        ok: false,
        error: `「${truncate(raw, 18)}」不是 sec_uid，自动解析也没成功：${error?.message ?? String(error)}。面板点「读我的抖音号」最稳。`,
      };
    }
  }

  /**
   * 她现在登录的是哪个抖音号。只读，不改绑定——用来回答「私信为什么发不出去」：
   * 如果这个号就是主人自己，抖音不允许给自己发私信，换号才有解。
   */
  async douyinSelf() {
    const saved = this.store?.data?.douyinSelf;
    try {
      const self = await this.douyin.selfProfile();
      this.noteDouyinSelf(self);
      const owner = this.douyinOwner();
      return {
        ok: true,
        ...self,
        sameAsOwner: owner.sameAsSelf,
        message: owner.sameAsSelf
          ? `现在登录的就是「${self.name || '这个号'}」，跟主人绑定的是同一个号——抖音不能给自己发私信。`
          : `现在登录的是「${self.name || '这个号'}」，和主人不是一个号，私信可以发。`,
      };
    } catch (error) {
      return {
        ok: false,
        code: error?.code ?? 'ERROR',
        error: error?.message ?? String(error),
        lastKnown: saved ?? null,
      };
    }
  }

  envPromptVars() {
    const owner = this.ownerLine();
    const identity = this.lastStatus
      ? `B站 ${this.lastStatus.bili?.loggedIn ? this.lastStatus.bili.name || '已登录' : '未登录'}；抖音 ${this.lastStatus.douyin?.loggedIn ? '已登录' : '未登录/未开'}`
      : '还没查登录态';
    const watchLine = this.watch
      ? `正在和主人一起看《${truncate(this.watch.title || this.watch.url, 40)}》${this.watch.last?.time != null ? `（${this.watch.last.time}s）` : ''}`
      : '没在一起看';
    const commentCap = this.policy.cap('comment').daily;
    const activity =
      commentCap >= 8
        ? '话痨：每次出门看 2-3 条，看到真有意思的就留一句，不要复读同一句'
        : commentCap >= 4
          ? '活跃：每次出门看 2 条左右，挑 1 条真的想说的评一句'
          : commentCap >= 2
            ? '日常：看 1-2 条，偶尔评一句'
            : '安静：只看看，不主动评论';
    const present = this.presenceView();
    const book = this.bookView();
    return {
      'stroll.summary': this.policy.summary(),
      'stroll.activity': activity,
      'stroll.books': book.current
        ? `在读《${truncate(book.current.name.replace(/\.(txt|md|markdown)$/i, ''), 30)}》，已读 ${book.current.percent}%`
        : book.empty
          ? '书库是空的（把 txt 放进面板上显示的那个目录）'
          : '书库有书，但还没开始读',
      'stroll.presence': present
        ? `正在${present.platform === 'douyin' ? '抖音' : 'B站'}看《${truncate(present.title || present.url, 40)}》`
        : '现在没在看',
      'stroll.watch': watchLine,
      'stroll.identity': identity,
      'stroll.owner': owner,
      'stroll.platforms': `${this.cfg.bilibili ? 'B站开' : 'B站关'}，${this.cfg.douyin ? '抖音开' : '抖音关'}`,
      'stroll.interests': this.cfg.interests || this.store.topInterests(6).join('、') || '还没填',
      'stroll.last': this.store.lastActions(1)[0]
        ? `${this.store.lastActions(1)[0].platform} ${this.store.lastActions(1)[0].action} ${this.store.lastActions(1)[0].result}`
        : '还没出过门',
      'stroll.approval': { confirm: '全部等主人批准', auto_low_risk: '点赞自动，其余等批准', auto_all: '按额度自动', dry_run: '只读' }[this.cfg.approval] ?? this.cfg.approval,
    };
  }

  /* ---------------- tools ---------------- */

  tools() {
    return TOOL_DECLS.map((decl) => ({
      ...decl,
      handler: async (args) => {
        try {
          if (decl.name === 'stroll') return await this.toolStroll(args ?? {});
          if (decl.name === 'stroll_act') return await this.toolAct(args ?? {});
          return await this.toolPolicy(args ?? {});
        } catch (error) {
          const code = error?.code ?? 'ERROR';
          if (code === 'RISK') {
            await this.push('stroll.risk', `平台风控：${error.message}。已经停手，不要重试。`, { code }, 'flush');
          }
          return JSON.stringify({
            ok: false,
            code,
            error: error?.message ?? String(error),
            hint: code === 'RISK' ? '不要重试；等冷却结束或主人处理验证。' : undefined,
          });
        }
      },
    }));
  }

  async toolStroll(args) {
    const action = String(args.action ?? 'status');
    if (action === 'status' || action === 'whoami') return JSON.stringify(await this.compactStatus());
    if (action === 'brief') return JSON.stringify(await this.brief(args.platform));
    if (action === 'feed') return JSON.stringify(await this.feed(args.platform, args.n));
    if (action === 'open') return this.readOpen(args);
    if (action === 'inbox') return JSON.stringify(await this.inbox(args.platform, args.n));
    if (action === 'comments') {
      const url = String(args.url ?? args.id ?? args.target ?? '').trim();
      if (!url) return JSON.stringify({ ok: false, error: '给个视频/动态/专栏链接。' });
      const plat = String(args.platform ?? '').trim() || (/douyin\.com|iesdouyin/i.test(url) ? 'douyin' : 'bilibili');
      if (plat === 'douyin') {
        const id = parseDouyinId(url);
        if (!id) return JSON.stringify({ ok: false, error: '给个抖音视频链接或视频 ID。' });
        const list = await this.douyin.commentList(id, { pages: 1 }).catch(() => null);
        if (!list) return JSON.stringify({ ok: false, error: '读不到抖音评论区（要登录，或者正被限流）。' });
        const items = list.slice(0, clamp(args.n ?? 10, 1, 20)).map((c) => ({
          user: c.nick,
          text: c.text || (c.images?.length ? '[图片评论]' : ''),
          like: c.digg,
          at: c.create,
          // 图片评论：URL 也给她，同时最多挑两张真的附上去
          images: c.images ?? [],
        }));
        const blobs = await this.imageBlobs(items.flatMap((x) => x.images), {
          limit: 2,
          platform: 'douyin',
          label: '评论图片',
        }).catch(() => []);
        return { text: JSON.stringify({ ok: true, platform: 'douyin', id, items }), ...(blobs.length ? { blobs } : {}) };
      }
      const data = await this.bili.commentsOf(url, clamp(args.n ?? 10, 1, 20));
      const blobs = await this.imageBlobs((data.items ?? []).flatMap((c) => c.pictures ?? []), {
        limit: 2,
        platform: 'bilibili',
        label: '评论图片',
      }).catch(() => []);
      return { text: JSON.stringify({ ok: true, ...data }), ...(blobs.length ? { blobs } : {}) };
    }
    if (action === 'search') {
      if (!String(args.query ?? '').trim()) return JSON.stringify({ ok: false, error: '给个搜索词。' });
      if (args.platform === 'douyin') {
        return JSON.stringify({ ok: false, error: '抖音搜索暂未开放；直接打开链接或刷 feed。' });
      }
      return JSON.stringify({ ok: true, platform: 'bilibili', items: await this.bili.search(args.query, clamp(args.n ?? 6, 1, 8)) });
    }
    if (action === 'watch') {
      const sub = String(args.watch_action ?? 'status');
      if (sub === 'start') {
        const url = String(args.url ?? '').trim();
        if (!url) return JSON.stringify({ ok: false, error: '给个要一起看的链接。' });
        return JSON.stringify(await this.watchStart(url));
      }
      if (sub === 'stop') return JSON.stringify(await this.watchStop());
      return JSON.stringify(await this.watchStatus());
    }
    if (action === 'login') return JSON.stringify(await this.login(args.platform));
    if (action === 'following') return JSON.stringify(await this.followingFeed(args.platform, args.n));
    if (action === 'weekly') return JSON.stringify(this.weeklyReport(args.days));
    if (action === 'books') return JSON.stringify(this.listBooks());
    if (action === 'groups') {
      const list = await this.douyin.listThreads({ deep: true }).catch((error) => ({ ok: false, error: error?.message ?? '读不到会话列表' }));
      if (!list.ok) return JSON.stringify({ ok: false, error: list.error ?? '读不到会话列表' });
      // 顺手刷新一次自动识别（用户可能就是来问「我在哪些群」）
      if (list.threads?.some((t) => t.kind === 'group')) this.absorbGroups(list.threads, { via: 'groups' });
      return JSON.stringify({
        ok: true,
        watched: this.groupNames(),
        arming: this.groupWatchOn(),
        threads: list.threads,
      });
    }
    if (action === 'join_group') {
      const link = String(args.url ?? '').trim();
      if (!link) return JSON.stringify({ ok: false, error: '给一个群邀请链接（url）。' });
      return JSON.stringify(await this.douyin.joinGroup(link).catch((error) => ({ ok: false, error: error?.message ?? '进群失败' })));
    }
    if (action === 'read') return JSON.stringify(this.readBook({ name: args.book, chars: args.chars }));
    if (action === 'note') return JSON.stringify(this.noteBook(args.text));
    if (action === 'images') {
      // 能发的图：自己画的 + 别人发来存下的
      const files = this.listImageFiles().map((x) => ({
        file: x.f,
        id: (x.f.match(/([0-9a-f]{6,})\./i) ?? [])[1] ?? x.f.replace(/\.[^.]+$/, ''),
        kb: x.kb,
        at: new Date(x.at).toISOString(),
        source: x.source === 'recv' ? '收到的' : '画的',
      }));
      const q = String(args.query ?? '').trim().toLowerCase();
      const hit = q
        ? files.filter((x) => x.file.toLowerCase().includes(q) || x.id.toLowerCase().includes(q))
        : files;
      return JSON.stringify({
        ok: true,
        drawDir: this.workshopDir(),
        recvDir: this.mediaInbox(),
        total: files.length,
        items: hit.slice(0, 20),
      });
    }
    if (action === 'stickers') {
      const list = this.stickers.list({
        query: String(args.query ?? '').trim(),
        tag: String(args.tag ?? '').trim(),
        limit: clamp(Number(args.n ?? 10), 1, 40),
      });
      return JSON.stringify({
        ok: true,
        ...list,
        dir: this.stickers.dir,
        stats: this.stickers.stats(),
        hint: list.total
          ? '发的时候用 stroll_act action=sticker text=<名字/序号>；不写 text 就是随机一张。'
          : '表情库还是空的：用 stroll_act action=collect_stickers 从抖音收藏几张。',
      });
    }
    if (action === 'history') return JSON.stringify(this.history());
    return JSON.stringify({ ok: false, error: `不认识的动作：${action}` });
  }

  async toolAct(args) {
    const action = String(args.action ?? '');
    if (action === 'approve' || action === 'reject') {
      return JSON.stringify({
        ok: false,
        error: '批准只能由主人在「摸鱼」面板里点；模型不能自己批准。',
        draftId: args.draft_id ?? null,
      });
    }
    // 表情包 / 自己画的图：聊天行为，和私信一样直接发，不占公开额度、不进草稿箱
    if (action === 'sticker') return JSON.stringify(await this.sendStickerAct(args));
    if (action === 'image') return JSON.stringify(await this.sendImageAct(args));
    if (action === 'collect_stickers') return JSON.stringify(await this.collectStickersAct(args));
    if (action === 'sticker_name') return JSON.stringify(this.nameStickerAct(args));
    const plan = await this.buildPlan(action, args, { byOwner: this.ownerNearby() });
    if (!plan.ok) return JSON.stringify(plan);
    if (args.preview === true || approvalFor(this.cfg, plan.action) === 'draft') {
      const draft = this.makeDraft(plan);
      return JSON.stringify({
        ok: true,
        draft: true,
        id: draft.id,
        preview: this.previewText(draft),
        message: '已放进草稿箱；等主人在「摸鱼」面板点批准。不要自己批准，也不要重复提交。',
      });
    }
    const receipt = await this.executePlan(plan, 'model');
    return JSON.stringify(receipt);
  }

  async toolPolicy(args) {
    const action = String(args.action ?? 'get');
    if (action === 'get') return JSON.stringify(this.policyView());
    if (action === 'pause') {
      const hours = clamp(Number(args.hours ?? 24), 1, 168);
      this.store.setRisk(Date.now() + hours * 3600 * 1000, `主人拉了手刹（${hours} 小时）`, 'MANUAL');
      this.store.save();
      await this.push('stroll.risk', `主人拉了手刹：${hours} 小时内不出去。`, { hours }, 'flush');
      return JSON.stringify({ ok: true, pausedUntil: new Date(this.store.data.risk.until).toISOString() });
    }
    if (action === 'resume') {
      this.store.clearRisk();
      this.store.save();
      return JSON.stringify({ ok: true, resumed: true });
    }
    const patch = validatePolicyPatch(args.patch ?? {});
    if (!Object.keys(patch).length) return JSON.stringify({ ok: false, error: 'patch 里没有可改的字段。' });
    this.persist(patch);
    this.store.save();
    return JSON.stringify({ ok: true, changed: patch, now: this.policyView() });
  }

  /* ---------------- read ---------------- */

  async compactStatus() {
    // 只有当前没登录、且窗口刚开过时才去收 cookie，避免每次刷新都打 nav
    if (
      this.cfg.sharedBiliCookie &&
      this.douyin.context &&
      !this.lastStatus?.bili?.loggedIn &&
      Date.now() - this.lastImportAt > 60 * 1000
    ) {
      this.lastImportAt = Date.now();
      await this.bili.importFromContext(this.douyin.context).catch(() => null);
    }
    const [bili, douyin] = await Promise.all([
      this.bili.status().catch((e) => ({ platform: 'bilibili', ok: false, loggedIn: false, note: e.message })),
      this.douyin.status().catch((e) => ({ platform: 'douyin', ok: false, loggedIn: false, note: e.message })),
    ]);
    this.lastStatus = { bili, douyin };
    this.lastStatusAt = Date.now();
    return {
      ok: true,
      bili,
      douyin,
      policy: this.policy.snapshot(),
      owner: (() => {
        const uid = this.ownerId('bilibili');
        const dy = this.douyinOwner();
        return {
          uid,
          name: this.cfg.ownerName || '',
          douyin: dy.secUid || dy.raw,
          douyinOk: dy.bound,
          douyinPending: !!dy.raw && !dy.bound,
          douyinName: dy.name,
          douyinSelf: dy.selfSecUid,
          douyinSelfName: dy.selfName,
          douyinSelfId: dy.selfDouyinId,
          douyinSame: dy.sameAsSelf,
        };
      })(),
      pending: this.store.pendingDrafts().map((d) => ({ id: d.id, action: d.action, platform: d.platform, preview: this.previewText(d) })),
      last: this.store.lastActions(3),
      interests: this.store.topInterests(6),
      autoSessions: this.store.data.autoSessions[dayKey()] ?? 0,
      // 必做清单（勾了开关的项）：她出门前先看还差多少
      mustDo: this.mustDoList(),
    };
  }

  async brief(platform) {
    const status = await this.compactStatus();
    const chosen = platform === 'douyin' || platform === 'bilibili' ? platform : this.pickPlatform();
    let feed = [];
    let inbox = [];
    const errors = [];
    let actual = chosen;
    try {
      if (chosen === 'bilibili' && this.cfg.bilibili) feed = await this.bili.feed(3);
      if (chosen === 'douyin' && this.cfg.douyin) feed = await this.douyin.feed(3);
      if (!feed.length && chosen === 'douyin' && this.cfg.bilibili) throw new Error('抖音没给出候选');
    } catch (error) {
      errors.push({ platform: chosen, error: error.message });
      // 一个平台没开/没登录时，换另一个，不要让 brief 空手而归
      if (chosen === 'douyin' && this.cfg.bilibili) {
        try {
          feed = await this.bili.feed(3);
          actual = 'bilibili';
        } catch (second) {
          errors.push({ platform: 'bilibili', error: second.message });
        }
      } else if (chosen === 'bilibili' && this.cfg.douyin) {
        try {
          feed = await this.douyin.feed(3);
          actual = 'douyin';
        } catch (second) {
          errors.push({ platform: 'douyin', error: second.message });
        }
      }
    }
    try {
      if (this.cfg.bilibili) inbox = await this.bili.inbox(3);
      // 抖音私信要用浏览器抓，brief 里只用已经热着的缓存（一分钟内），别让主人等十秒
      if (this.cfg.douyin && this._dyInbox?.length && Date.now() - this._dyInboxAt < 60 * 1000) {
        inbox = inbox.concat(this._dyInbox).sort((a, b) => Number(b.at ?? 0) - Number(a.at ?? 0)).slice(0, 5);
      }
      if (inbox.length) this.inboxCache = inbox;
    } catch (error) {
      errors.push({ platform: 'bilibili', error: error.message });
    }
    this.policy.noteRead(actual, { open: false });
    return {
      ok: true,
      status: {
        bili: status.bili,
        douyin: status.douyin,
        policy: status.policy.summary,
        pending: status.pending.length,
        owner: status.owner,
        // 必做清单要跟着 brief 一起给她，不然出门推送里只能看到「还剩几次」却不知道目标
        mustDo: status.mustDo ?? this.mustDoList(),
      },
      platform: actual,
      feed: feed.map(({ _score, ...rest }) => rest),
      inbox,
      errors: errors.length ? errors : undefined,
      hint: '一次 brief 就够；挑 0-2 条真的有意思的。大多数时候什么都不做也可以。',
    };
  }

  pickPlatform() {
    if (!this.cfg.bilibili) return 'douyin';
    if (!this.cfg.douyin) return 'bilibili';
    const day = dayKey();
    const n = [...day].reduce((a, c) => a + c.charCodeAt(0), 0);
    return n % 3 === 0 ? 'douyin' : 'bilibili';
  }

  async feed(platform, n) {
    const p = platform === 'douyin' || platform === 'bilibili' ? platform : this.pickPlatform();
    if (p === 'bilibili') {
      if (!this.cfg.bilibili) return { ok: false, error: 'B站关着。' };
      const items = await this.bili.feed(clamp(n ?? 6, 1, 8));
      this.policy.noteRead('bilibili');
      return { ok: true, platform: p, items: items.map(({ _score, ...rest }) => rest) };
    }
    if (!this.cfg.douyin) return { ok: false, error: '抖音关着。' };
    const items = await this.douyin.feed(clamp(n ?? 6, 1, 8));
    this.policy.noteRead('douyin');
    return { ok: true, platform: p, items: items.map(({ _score, ...rest }) => ({ kind: 'video', ...rest })) };
  }

  async readOpen(args) {
    // target 是 act 那边的叫法，她很容易顺手带过来——两个都认，少一次失败
    const raw = String(args.url ?? args.id ?? args.target ?? '').trim();
    if (!raw) return JSON.stringify({ ok: false, error: '给个链接或 ID。' });
    const platform = this.inferPlatform(raw, args.platform);
    const frames = clamp(Number(args.frames ?? this.cfg.framesPerOpen ?? 0), 0, 3);
    const keep = clamp(Number(this.cfg.keepWindowSeconds ?? 90), 0, 600);

    if (platform === 'bilibili') {
      const bvid = parseBvid(raw);
      const dynId = bvid ? null : parseDynamicId(raw);
      const cvid = bvid || dynId ? null : parseCvid(raw);
      if (!bvid && !dynId && !cvid) {
        return JSON.stringify({ ok: false, error: '不是有效的 B站视频 / 动态 / 专栏链接。' });
      }
      const detail = bvid
        ? await this.bili.open(bvid, { comments: 5 })
        : dynId
          ? await this.bili.openDynamic(dynId, { comments: 5 })
          : await this.bili.openArticle(cvid, { comments: 5 });
      this.store.markSeen(`bilibili:open:${detail.id}`);
      this.policy.noteRead('bilibili', { open: true });
      this.lastOpen = {
        platform: 'bilibili',
        kind: detail.kind,
        id: detail.id,
        title: detail.title,
        url: detail.url,
        at: Date.now(),
      };
      this.setPresence({
        platform: 'bilibili',
        kind: detail.kind,
        id: detail.id,
        title: detail.title,
        author: detail.author,
        url: detail.url,
        phase: 'reading',
        keepMs: 180000,
        duration: clockToSeconds(detail.dur),
      });
      this.store.addViewed({
        platform: 'bilibili',
        kind: detail.kind,
        id: detail.id,
        title: detail.title,
        author: detail.author,
        dur: detail.dur ?? '',
        url: detail.url,
      });
      return JSON.stringify({
        ok: true,
        ...detail,
        window: '后台看的，没有开网页。要一起看就在面板点「一起看」。',
      });
    }

    if (platform === 'douyin') {
      const result = await this.douyin.open(raw, { frames, keep });
      this.lastOpen = { platform: 'douyin', id: result.id, title: result.title, url: result.url, at: Date.now() };
      this.setPresence({
        platform: 'douyin',
        id: result.id,
        title: result.title,
        author: result.author,
        url: result.url,
        phase: 'reading',
        keepMs: Math.max(120000, keep * 1000 + 60000),
        duration: clockToSeconds(result.dur),
      });
      this.store.addViewed({
        platform: 'douyin',
        id: result.id,
        title: result.title,
        author: result.author,
        dur: result.dur,
        url: result.url,
      });
      result.window = '后台看的，没有开网页。要一起看就在面板点「一起看」。';
      this.store.markSeen(`douyin:open:${result.id}`);
      this.policy.noteRead('douyin', { open: true });
      const blobs = (result.frames ?? []).map((f, i) => ({
        bytes: f.bytes,
        mime: f.mime,
        name: `douyin-${result.id}-${f.at}s.jpg`,
        fallbackText: `抖音画面 第 ${f.at} 秒（第 ${i + 1} 张）`,
      }));
      delete result.frames;
      return { text: JSON.stringify({ ok: true, ...result }), blobs };
    }

    return JSON.stringify({ ok: false, error: '只认 B站/抖音链接。' });
  }

  /**
   * 抖音私信要开浏览器，慢；面板会频繁刷，所以留一点缓存。
   * 但别留太长：以前缓存三分钟、brief 里还用十分钟前的快照，
   * 主人连着发好几句，她读到的还是上一轮那一句——看起来就是「只收到一条」。
   */
  async douyinInbox(force = false) {
    if (!this.cfg.douyin) return [];
    const ttl = 20 * 1000;
    if (!force && this._dyInbox && Date.now() - this._dyInboxAt < ttl) return this._dyInbox;
    try {
      const items = await this.douyin.inbox(5);
      this._dyInbox = items;
    } catch (error) {
      this.log?.warn?.('stroll douyin inbox failed', { message: error?.message });
      this._dyInbox = this._dyInbox ?? [];
    }
    this._dyInboxAt = Date.now();
    return this._dyInbox;
  }

  async inbox(platform, n) {
    const p = platform === 'douyin' || platform === 'bilibili' ? platform : 'bilibili';
    if (p === 'bilibili') {
      if (!this.cfg.bilibili) return { ok: false, error: 'B站关着。' };
      const items = await this.bili.inbox(clamp(n ?? 6, 1, 8));
      // 只换掉 B站那部分，别把抖音的缓存冲掉：两边共用这一份 inboxCache
      if (items.length) {
        this.inboxCache = [...items, ...(this.inboxCache ?? []).filter((x) => x.platform !== 'bilibili')];
      }
      return { ok: true, platform: p, items };
    }
    if (!this.cfg.douyin) return { ok: false, error: '抖音关着。' };
    const items = (await this.douyinInbox()).slice(0, clamp(n ?? 5, 1, 8));
    // 抖音这几条也要进 inboxCache：面板点「回私信」时是拿 id 回查的，
    // 以前只写 B站那份，导致抖音私信一点就提示「消息已经刷新掉了」。
    if (items.length) {
      this.inboxCache = [...items, ...(this.inboxCache ?? []).filter((x) => x.platform !== 'douyin')];
    }
    return { ok: true, platform: p, items };
  }

  async login(platform) {
    if (platform === 'bilibili') {
      // 之前点过「退出登录」：开窗时顺手把 B站 cookie 清掉，保证这次看到的是干净二维码
      const wasOut = this.bili.isLoggedOut();
      let info;
      try {
        info = await this.douyin.loginWindow('https://passport.bilibili.com/login', {
          clearCookies: wasOut ? /bilibili\.com$/i : null,
        });
      } catch (error) {
        return {
          ok: false,
          code: error?.code ?? 'BROWSER_LAUNCH',
          error: `登录窗没打开：${error?.message ?? String(error)}。多半是没装 Edge / Chrome，或者上次的窗口没退干净。`,
        };
      }
      if (wasOut) this.bili.markLoggedOut(false);
      // 扫码是异步的：后台轮询，登上了就把 cookie 收回来并关窗
      let tries = 0;
      const timer = setInterval(async () => {
        tries += 1;
        if (tries > 60 || !this.douyin.context) {
          clearInterval(timer);
          // 三分钟没扫完就收窗，别让一个有头窗口永远挂在桌面上
          if (tries > 60) await this.douyin.loginWindowClose().catch(() => {});
          return;
        }
        try {
          const got = await this.bili.importFromContext(this.douyin.context).catch(() => null);
          if (got?.ok) {
            clearInterval(timer);
            this.lastImportAt = Date.now();
            await this.douyin.loginWindowClose().catch(() => {});
            await this.push('stroll.sent', `B站登录成功：${got.name || got.uid || '已登录'}。`, { kind: 'bili-login' }, 'flush');
          }
        } catch {
          // 继续等
        }
      }, 3000);
      return {
        ok: true,
        message: 'B站登录窗已经开了；在窗口里扫码，登上后会自动收回登录态并关窗。',
        url: info.url,
      };
    }
    return this.douyin.login();
  }

  /** 退出 B站：删掉插件存的 cookie，并把窗口里的 B站 cookie 一起清掉。 */
  async logoutBili() {
    this.bili.logout();
    const res = await this.douyin.clearCookiesMatching(/bilibili\.com$/i).catch(() => null);
    this.lastStatus = null;
    this.lastImportAt = 0;
    return {
      ok: true,
      windowOpen: !!this.douyin.context,
      cleared: res?.cleared ?? 0,
      message: res?.ok
        ? `B站已退出登录，清掉了 ${res.cleared} 个 cookie。`
        : 'B站已退出登录；浏览器没开着，下次登录时会先清干净。',
    };
  }

  async logoutDouyin() {
    const res = await this.douyin.logout();
    this.lastStatus = null;
    // 「现在登录的是哪个号」跟着登录态一起清掉，不然面板会拿旧号报「自己给自己发私信」
    delete this.store.data.douyinSelf;
    this.store.save();
    return { ok: true, ...res, message: '抖音已退出登录，窗口已关。' };
  }

  history() {
    return {
      ok: true,
      recent: this.store.lastActions(8),
      drafts: this.store.pendingDrafts().map((d) => ({ id: d.id, preview: this.previewText(d), ageSec: d.ageSec })),
      stats: this.store.data.stats,
      interests: this.store.topInterests(8),
      risk: this.store.data.risk,
      usage: this.policy.snapshot(),
    };
  }

  /* ---------------- 关注流 / 周报 / 书 ---------------- */

  /**
   * 关注的人在发什么。B站走动态流接口，抖音读 /follow 页面。
   * 结果落一份到本地，面板不用每次都拉。
   */
  async followingFeed(platform = 'both', n = 8) {
    const want = platform === 'douyin' || platform === 'bilibili' ? platform : 'both';
    const limit = clamp(n ?? 8, 1, 20);
    const items = [];
    const errors = [];

    if (want !== 'douyin') {
      if (!this.cfg.bilibili) errors.push({ platform: 'bilibili', error: 'B站关着' });
      else if (!this.bili.readCredentials()) errors.push({ platform: 'bilibili', error: 'B站没登录，关注流要登录才看得到' });
      else {
        try {
          items.push(...(await this.bili.followFeed(limit)));
        } catch (error) {
          errors.push({ platform: 'bilibili', error: error.message });
        }
      }
    }

    if (want !== 'bilibili') {
      if (!this.cfg.douyin) errors.push({ platform: 'douyin', error: '抖音关着' });
      else {
        try {
          const got = await this.douyin.following(limit);
          if (!got.length) errors.push({ platform: 'douyin', error: '抖音关注流读不到（后台页面是空壳）；抖音这边用 feed 刷精选' });
          items.push(...got);
        } catch (error) {
          errors.push({ platform: 'douyin', error: error.message });
        }
      }
    }

    items.sort((a, b) => Number(b.at ?? 0) - Number(a.at ?? 0));
    const list = items.slice(0, limit);
    if (list.length) {
      this.store.data.followFeed = { at: Date.now(), items: list.slice(0, 12) };
      this.store.save();
    }
    return {
      ok: list.length > 0,
      platform: want,
      items: list,
      errors: errors.length ? errors : undefined,
      hint: list.length
        ? '挑一条真的想看的；不要每条都点开，也不要复述标题。'
        : '关注流暂时没东西；可以先用 feed 刷候选。',
    };
  }

  /** 本地缓存的一份关注流，给面板用。 */
  followFeedView(n = 5) {
    const cached = this.store.data.followFeed;
    if (!cached?.items?.length) return null;
    return { at: Number(cached.at ?? 0), items: cached.items.slice(0, n), total: cached.items.length };
  }

  /** 最近 N 天的周报：全本地算，不花 token。 */
  weeklyReport(days = 7) {
    const span = clamp(days ?? 7, 1, 30);
    const tz = this.timeZone;
    const now = Date.now();
    const dayKeys = [];
    for (let i = span - 1; i >= 0; i -= 1) dayKeys.push(dayKey(new Date(now - i * 86400000), tz));

    const usage = this.store.data.usage ?? {};
    const sum = { like: 0, unlike: 0, comment: 0, reply: 0, follow: 0, unfollow: 0, post: 0, dm: 0, save: 0 };
    let reads = 0;
    const perDay = [];
    for (const key of dayKeys) {
      const day = usage[key] ?? {};
      let total = 0;
      for (const k of Object.keys(sum)) {
        const v = Number(day[k] ?? 0);
        sum[k] += v;
        total += v;
      }
      const read = Number(this.store.data.readDays?.[key] ?? 0);
      reads += read;
      perDay.push({ day: key.slice(5), actions: total, reads: read });
    }
    const totalActions = Object.values(sum).reduce((a, b) => a + b, 0);

    const since = now - span * 86400000;
    const acts = (this.store.data.actions ?? []).filter((a) => Date.parse(a.at ?? '') >= since);
    const platformCount = new Map();
    const hours = new Array(24).fill(0);
    for (const a of acts) {
      const p = a.platform === 'douyin' ? '抖音' : 'B站';
      platformCount.set(p, (platformCount.get(p) ?? 0) + 1);
      const ts = Date.parse(a.at ?? '');
      if (Number.isFinite(ts)) hours[hourOf(new Date(ts), tz)] += 1;
    }
    const busiest = hours.reduce((best, v, i) => (v > hours[best] ? i : best), 0);

    const authors = new Map();
    const viewed = (this.store.data.viewed ?? []).filter((v) => Date.parse(v.at ?? '') >= since);
    for (const v of viewed) {
      const name = String(v.author ?? '').trim();
      if (name) authors.set(name, (authors.get(name) ?? 0) + 1);
    }
    const topAuthors = [...authors.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([name, count]) => ({ name, count }));

    const activeDays = perDay.filter((d) => d.actions > 0 || d.reads > 0).length;
    const topPlatform = [...platformCount.entries()].sort((a, b) => b[1] - a[1])[0];

    return {
      ok: true,
      days: span,
      range: { from: dayKeys[0], to: dayKeys[dayKeys.length - 1] },
      totalActions,
      actions: sum,
      reads,
      views: viewed.length,
      activeDays,
      perDay,
      platforms: [...platformCount.entries()].map(([name, count]) => ({ name, count })),
      topAuthors,
      busiestHour: totalActions ? { hour: busiest, count: hours[busiest] } : null,
      headline: totalActions || reads
        ? `${span} 天里出门 ${totalActions} 次、看书 ${reads} 段${topPlatform ? `，主要在${topPlatform[0]}` : ''}`
        : `${span} 天里几乎什么都没做`,
      hint: '用一两句说这周过得怎么样，不要逐条念数字，也不要编没发生的事。',
    };
  }

  /* ---------------- 本地书库 ---------------- */

  bookDir() {
    // 主人可以在设置里指定任意目录；留空就用数据目录下默认那个
    const custom = String(this.cfg.booksDir ?? '').trim();
    if (custom) {
      // 老版本用 PowerShell 的 utf8 标准输出读路径，被 GBK 代码页坑成了乱码，
      // 还把乱码当目录名建了个文件夹。这里认出来就还原成盘上真实的那个目录；
      // 还原不了就当没设过，别让「读书」一直对着一个不存在的乱码路径。
      if (looksBrokenPath(custom)) {
        if (this._bookDirFix === undefined) {
          this._bookDirFix = repairMojibakePath(custom);
          if (this._bookDirFix) {
            try {
              this.cfg.booksDir = this._bookDirFix;
              this.persist({ booksDir: this._bookDirFix });
            } catch {
              // 存不下也只是下次再修一遍，不影响读书
            }
          }
        }
        if (!this._bookDirFix) return path.join(this.dataDir, 'stroll', 'books');
        return path.resolve(this._bookDirFix);
      }
      try {
        return path.resolve(custom);
      } catch {
        // 路径写坏了就退回默认，不要让「读书」整个挂掉
      }
    }
    return path.join(this.dataDir, 'stroll', 'books');
  }

  /** 扫本地书库；没有就返回空列表，不报错。 */
  listBooks() {
    const dir = this.bookDir();
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => /\.(txt|md|markdown)$/i.test(f));
    } catch {
      return { ok: true, dir, books: [], empty: true };
    }
    const state = this.store.data.books ?? {};
    const books = files.slice(0, 40).map((name) => {
      const prog = state[name] ?? {};
      const total = Number(prog.total ?? 0);
      const offset = Number(prog.offset ?? 0);
      return {
        name,
        total,
        offset,
        percent: total ? Math.min(100, Math.round((offset / total) * 100)) : 0,
        updatedAt: Number(prog.updatedAt ?? 0),
        notes: Array.isArray(prog.notes) ? prog.notes.length : 0,
      };
    });
    return { ok: true, dir, books, empty: books.length === 0 };
  }

  /** 手头那本：最近读过的优先，没读过就第一本。 */
  currentBook(list) {
    const state = this.store.data.books ?? {};
    const ranked = list
      .map((b) => ({ ...b, updatedAt: Number(state[b.name]?.updatedAt ?? 0) }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return ranked[0] ?? null;
  }

  /** 面板上的「在读」卡片：只给一本书的信息，不把整本书塞进去。 */
  bookView() {
    const info = this.listBooks();
    const current = this.currentBook(info.books);
    return {
      dir: info.dir,
      empty: info.empty,
      total: info.books.length,
      current: current
        ? {
            name: current.name,
            percent: current.percent,
            offset: current.offset,
            total: current.total,
            notes: (this.store.data.books?.[current.name]?.notes ?? []).slice(-2).reverse(),
          }
        : null,
    };
  }

  /** 读一段，默认 900 字；读不动就明说，不编。 */
  readBook({ name, chars = 900 } = {}) {
    const list = this.listBooks().books;
    if (!list.length) {
      return { ok: false, error: `书库是空的：把 txt 放进 ${this.bookDir()} 再来。`, dir: this.bookDir() };
    }
    const pick = name
      ? list.find((b) => b.name === name || b.name.replace(/\.(txt|md|markdown)$/i, '') === name)
      : this.currentBook(list);
    if (!pick) {
      return { ok: false, error: '没找到这本书。', books: list.map((b) => b.name) };
    }

    let text = '';
    try {
      text = fs.readFileSync(path.join(this.bookDir(), pick.name), 'utf8');
    } catch (error) {
      return { ok: false, error: `读不了 ${pick.name}：${error.message}` };
    }
    if (text.slice(0, 200000).includes('\uFFFD')) {
      return { ok: false, error: `${pick.name} 可能是 GBK 编码，另存成 UTF-8 再放进书库。` };
    }
    const clean = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n');
    if (!clean.trim()) return { ok: false, error: `${pick.name} 是空的。` };

    const size = clamp(Number(chars) || 900, 200, 2000);
    const start = Math.min(clean.length, Math.max(0, Number(pick.offset) || 0));
    const chunk = clean.slice(start, start + size);
    const next = Math.min(clean.length, start + chunk.length);
    const state = this.store.data.books ?? {};
    state[pick.name] = {
      ...(state[pick.name] ?? {}),
      offset: next,
      total: clean.length,
      updatedAt: Date.now(),
      notes: Array.isArray(state[pick.name]?.notes) ? state[pick.name].notes : [],
    };
    this.store.data.books = state;
    this.store.save();

    return {
      ok: true,
      book: pick.name,
      text: chunk,
      offset: next,
      total: clean.length,
      percent: Math.round((next / clean.length) * 100),
      done: next >= clean.length,
      hint: '读完说一句你自己的感受，别复述剧情，别假装读过后面。',
    };
  }

  /** 存一句摘抄，跟着这本书走。 */
  noteBook(text) {
    const body = truncate(String(text ?? '').trim(), 120);
    if (!body) return { ok: false, error: '摘抄要有内容。' };
    const list = this.listBooks().books;
    const pick = this.currentBook(list);
    if (!pick) return { ok: false, error: '书库还是空的。' };
    const state = this.store.data.books ?? {};
    const prog = state[pick.name] ?? { offset: 0, total: 0, updatedAt: Date.now(), notes: [] };
    prog.notes = [...(Array.isArray(prog.notes) ? prog.notes : []), { text: body, at: Date.now() }].slice(-20);
    state[pick.name] = prog;
    this.store.data.books = state;
    this.store.save();
    return { ok: true, book: pick.name, note: body };
  }

  /* ---------------- 正在看 ---------------- */

  /**
   * 记一条「她现在在看什么」。面板靠它显示浮条，主人一打开就知道她在哪个平台、
   * 看的是哪一条；默认只留在本地，不花 token。
   */
  setPresence({ platform, kind, id, title, author, url, phase, keepMs = 150000, duration = 0 }) {
    const startedAt = Date.now();
    this.presence = {
      platform,
      kind: kind || 'video',
      id: String(id ?? ''),
      title: title || '',
      author: author || '',
      url: url || '',
      phase: phase || 'reading',
      startedAt,
      endsAt: keepMs > 0 ? startedAt + keepMs : 0,
      duration: Number(duration ?? 0),
    };
    this.notifyPresence().catch(() => {});
    return this.presence;
  }

  presenceView() {
    const p = this.presence;
    if (!p) return null;
    if (p.phase !== 'co-watch' && p.endsAt && Date.now() > p.endsAt) return null;
    return {
      platform: p.platform,
      kind: p.kind || 'video',
      id: p.id,
      title: p.title,
      author: p.author,
      url: p.url,
      phase: p.phase,
      startedAt: p.startedAt,
      endsAt: p.endsAt,
      duration: p.duration,
      elapsed: Math.max(0, Math.round((Date.now() - p.startedAt) / 1000)),
    };
  }

  async notifyPresence() {
    const mode = String(this.cfg.watchNotify ?? 'panel');
    if (mode !== 'chat') return;
    const p = this.presence;
    if (!p) return;
    // 半小时内只说一次，免得她每打开一条就播报
    if (Date.now() - this.lastPresenceNotify < 30 * 60 * 1000) return;
    this.lastPresenceNotify = Date.now();
    const where = p.platform === 'douyin' ? '抖音' : 'B站';
    await this.push(
      'stroll.watching',
      `她正在${where}看《${truncate(p.title || p.url, 40)}》。想一起看就回她一句，或者打开「摸鱼」面板点「我也看看」。`,
      { platform: p.platform, url: p.url, title: p.title },
      'debounce',
    ).catch(() => {});
  }

  /* ---------------- 一起看 ---------------- */

  async watchStart(url) {
    const info = await this.douyin.watchStart(url);
    this.watch = { startedAt: Date.now(), url: info.url, title: info.title, platform: info.platform, last: null };
    this.setPresence({
      platform: info.platform,
      id: '',
      title: info.title,
      url: info.url,
      phase: 'co-watch',
      keepMs: 0,
    });
    this.lastWatchPush = 0;
    this.startWatchTimer();
    await this.push(
      'stroll.watch',
      `主人开了「一起看」：${info.title || info.url}。你也一起看，看到有意思的地方用一两句说自己的反应；不要每段都夸，也不要抢话。`,
      { platform: info.platform, url: info.url },
      'flush',
    );
    return {
      ok: true,
      ...info,
      note: '陪看窗口已打开。主人在窗口里翻页/拖进度，你在后台跟着看；想评论就说，想发到平台就用 stroll_act。',
    };
  }

  startWatchTimer() {
    this.stopWatchTimer();
    const sec = clamp(Number(this.cfg.watchPollSec ?? 15), 5, 120);
    this.watchTimer = setInterval(() => this.watchTick().catch(() => {}), sec * 1000);
  }

  stopWatchTimer() {
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.watchTimer = null;
  }

  async watchTick() {
    if (!this.watch) {
      this.stopWatchTimer();
      return;
    }
    const digest = await this.douyin.watchDigest();
    if (!digest) return;
    const changed = digest.url !== this.watch.url;
    const now = Date.now();
    const speakEvery = clamp(Number(this.cfg.watchSpeakSec ?? 60), 20, 600) * 1000;
    const due = changed || now - this.lastWatchPush >= speakEvery;
    this.watch = { ...this.watch, url: digest.url, title: digest.title, platform: digest.platform, last: digest };
    if (!due) return;
    this.lastWatchPush = now;
    const clock = (n) => {
      const sec = Math.max(0, Math.floor(Number(n) || 0));
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      const rest = sec % 60;
      return h ? `${h}:${String(m).padStart(2, '0')}:${String(rest).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
    };
    const progress = digest.duration ? `${clock(digest.time || 0)}/${clock(digest.duration)}` : '没有进度条';
    const rawComments = await this.watchComments(digest);
    const comments = rawComments.slice(0, 3).map((c) => truncate(c, 60)).join(' / ');
    const shown = (t) => {
      const name = truncate(t || '', 60);
      return /^《.*》$/.test(name) ? name : `《${name}》`;
    };
    const head = changed
      ? `主人翻到了新页面：${shown(digest.title || digest.url)} ${progress}。`
      : `一起看中：${shown(digest.title)} ${progress}${digest.paused ? '（暂停）' : ''}。`;
    const tail = comments ? `评论区在说：${comments}` : '评论区还没读到。';
    await this.push('stroll.watch', `${head}${tail}`, { platform: digest.platform, url: digest.url }, 'debounce');
  }

  /** B站评论区在 shadow DOM 里，DOM 读不到；一起看时直接用官方评论接口。 */
  async watchComments(digest) {
    if (digest?.platform !== 'bilibili') return digest?.comments ?? [];
    try {
      const bvid = parseBvid(digest.url);
      if (bvid) {
        const info = await this.bili.view(bvid);
        const list = await this.bili.comments(info.aid, 3);
        return list.map((c) => `${c.author}：${c.text}`);
      }
      const dyn = parseDynamicId(digest.url);
      if (dyn) {
        const d = await this.bili.dynamic(dyn);
        if (!d.oid) return [];
        const list = await this.bili.replyList(d.commentType, d.oid, 3);
        return list.map((c) => `${c.author}：${c.text}`);
      }
    } catch {
      return [];
    }
    return [];
  }

  async watchStatus() {
    if (!this.watch) return { ok: true, watching: false };
    const digest = await this.douyin.watchDigest();
    return {
      ok: true,
      watching: true,
      startedAt: new Date(this.watch.startedAt).toISOString(),
      platform: digest?.platform ?? this.watch.platform,
      url: digest?.url ?? this.watch.url,
      title: digest?.title ?? this.watch.title,
      time: digest?.time ?? null,
      duration: digest?.duration ?? null,
      paused: digest?.paused ?? null,
      comments: (digest ? await this.watchComments(digest) : []).slice(0, 3),
    };
  }

  async watchStop() {
    this.stopWatchTimer();
    if (this.presence?.phase === 'co-watch') this.presence = null;
    this.watch = null;
    await this.douyin.watchStop().catch(() => {});
    return { ok: true, watching: false };
  }

  /** 面板上的快捷动作：主人点了就等于批准，直接发；额度照旧。 */
  async quickAct(action, text = '', explicit = '') {
    const url = String(explicit || this.lastOpen?.url || this.watch?.url || '').trim();
    if (!url) return { ok: false, error: '先打开一条视频，或先开「一起看」。' };
    const plan = await this.buildPlan(action, {
      platform: this.inferPlatform(url),
      target: url,
      text,
      mention_owner: false,
    });
    if (!plan.ok) return plan;
    return this.executePlan(plan, 'operator');
  }

  /**
   * 在面板里直接回一条「谁找你」里的评论。
   * 视频、动态、专栏走同一套：先确认评论区在哪，再带 root/parent 回楼中楼。
   */
  async replyToMessage(id, text) {
    const item = (this.inboxCache ?? []).find((x) => String(x.id) === String(id));
    if (!item) return { ok: false, error: '这条消息已经刷新掉了，点「刷新消息」再来。' };
    if (!text) return { ok: false, error: '回复要有正文。' };

    // 私信：直接往这个会话里接着说话，不用管评论那套 root/parent
    if (item.kind === 'dm') {
      const receipt = await this.replyDmItem(item, text).catch((error) => ({
        ok: false,
        error: error?.message ?? String(error),
      }));
      if (receipt?.ok) {
        this.store.markSeen(`msg:${id}`);
        this.store.save();
        this.inboxCache = this.inboxCache.map((x) =>
          String(x.id) === String(id) ? { ...x, replied: true, fresh: false, unread: 0, text: truncate(text, 140) } : x,
        );
      }
      return receipt;
    }

    if (!item.rpid || item.rpid === '0') {
      return { ok: false, error: '这条消息没带评论 ID，去网页里回。' };
    }

    let kind = '';
    if (item.type === 'video' && item.bvid) kind = 'video';
    else if (item.type === 'opus' && item.dynamicId) kind = 'opus';
    else if (item.type === 'article' && item.cvid) kind = 'article';
    if (!kind) return { ok: false, error: '这条落在页面里，没有可回复的评论接口；点「去看看」在网页里回。' };

    let target = '';
    let oid = '';
    let commentType = 1;
    let dynamicId = '';
    let articleId = '';
    try {
      if (kind === 'video') {
        target = item.bvid;
        const v = await this.bili.view(target);
        oid = v.aid;
      } else if (kind === 'opus') {
        dynamicId = item.dynamicId;
        target = `dyn:${dynamicId}`;
        const d = await this.bili.dynamic(dynamicId);
        if (!d.oid) return { ok: false, error: '这条动态没开评论区。' };
        oid = d.oid;
        commentType = d.commentType;
      } else {
        articleId = item.cvid;
        target = `cv:${articleId}`;
        oid = articleId;
        commentType = 12;
      }
    } catch (error) {
      return { ok: false, code: error?.code ?? 'ERROR', error: error?.message ?? String(error) };
    }

    const dedupeKey = `bilibili:reply:${target}:r${item.rpid}`;
    const check = this.policy.check('reply', 'bilibili', target, {
      userInitiated: true,
      quotaAction: 'comment',
      dedupeKey,
    });
    if (!check.ok) return { ok: false, code: check.code, error: check.message ?? '今天额度不够。' };

    const plan = {
      action: 'reply',
      platform: 'bilibili',
      target,
      kind,
      dynamicId,
      articleId,
      oid,
      commentType,
      dedupeKey,
      text,
      root: item.rootRpid && item.rootRpid !== '0' ? item.rootRpid : item.rpid,
      parent: item.rpid,
    };
    const receipt = await this.executePlan(plan, 'operator');
    if (receipt?.ok) {
      this.store.markSeen(`msg:${id}`);
      this.store.save();
      this.inboxCache = this.inboxCache.map((x) => (String(x.id) === String(id) ? { ...x, replied: true, fresh: false } : x));
    }
    return receipt;
  }

  /** 私信回到哪个平台，由消息自己决定。 */
  async replyDmItem(item, text) {
    if (item?.platform === 'douyin') return this.replyDouyinDm(item, text);
    return this.replyDm(item?.mid, text);
  }

  /** 抖音私信：有会话就直接在聊天页回（比去主页点「私信」快十几秒），没有才回退到主页。 */
  async douyinDmFast(secUid, text) {
    const name = this.douyinOwner().name || (await this.douyinOwnerName().catch(() => ''));
    if (name) {
      const ok = await this.douyin
        .replyDm(name, cutChars(text, 300))
        .then(() => true)
        .catch(() => false);
      if (ok) return { ok: true, sent: true, via: 'chat' };
    }
    return await this.douyin.dm(secUid, text);
  }

  /** 抖音私信：走页面操作，慢一点，也不占她的额度。 */
  async replyDouyinDm(item, text) {
    const body = String(text ?? '').trim();
    const who = String(item?.user ?? '').trim();
    if (!body) return { ok: false, error: '回复要有正文。' };
    if (!who) return { ok: false, error: '这条抖音私信没有昵称，回不了。' };
    if (!this.cfg.douyin) return { ok: false, error: '抖音关着。' };
    try {
      await this.douyin.replyDm(who, cutChars(body, 300));
      this.store.addAction({
        platform: 'douyin',
        action: 'dm',
        target: who,
        title: who,
        text: cutChars(body, 300),
        result: 'ok',
        extra: { by: 'owner' },
      });
      this.store.save();
      this._dyInboxAt = 0;
      return { ok: true, receipt: '抖音私信发出去了' };
    } catch (error) {
      return { ok: false, code: error?.code ?? 'ERROR', error: error?.message ?? String(error) };
    }
  }

  /**
   * 面板里回私信：这是主人自己在说话，不占她的社交额度，只记一笔。
   * 只允许回已经有会话的人；不给陌生人发私信。
   */
  async replyDm(talkerId, text) {
    const uid = String(talkerId ?? '').trim();
    const body = String(text ?? '').trim();
    if (!uid || !/^\d+$/.test(uid)) return { ok: false, error: '这条私信没有可回复的 UID。' };
    if (!body) return { ok: false, error: '回复要有正文。' };
    if (!this.cfg.bilibili) return { ok: false, error: 'B站关着。' };
    const known = (this.inboxCache ?? []).some((x) => x.kind === 'dm' && String(x.mid) === uid);
    if (!known) return { ok: false, error: '只回已经有会话的人；先刷新一次消息。' };
    try {
      const sent = await this.bili.dm(uid, body.slice(0, 500));
      // 回了就说明看过了，顺手把 B站那边的红点清掉
      const known2 = (this.inboxCache ?? []).find((x) => x.kind === 'dm' && String(x.mid) === uid);
      if (known2?.ackSeqno) await this.bili.dmAck(uid, known2.ackSeqno).catch(() => false);
      this.store.data.lastWriteAt = Date.now();
      this.store.addAction({
        platform: 'bilibili',
        action: 'dm',
        target: uid,
        title: this.titleOf('bilibili', uid) || '私信',
        text: cutChars(body, 300),
        result: 'ok',
        extra: { by: 'owner', msgKey: sent.msgKey },
      });
      this.store.save();
      return { ok: true, receipt: `私信发出去了（${new Date().toLocaleTimeString('zh-CN', { hour12: false })}）`, msgKey: sent.msgKey };
    } catch (error) {
      return { ok: false, code: error?.code ?? 'ERROR', error: error?.message ?? String(error) };
    }
  }

  /* ---------------- 表情包（收藏 / 发送） ---------------- */

  /**
   * 表情包发给谁：群名优先，其次主人私信。
   * 和私信一样，只允许发给主人或主人这边的群，不给陌生人发东西。
   */
  async stickerTargetOf(raw) {
    const wanted = String(raw ?? '').trim();
    const OWNER_ALIAS = /^(主人|主人私信|私信|私聊|owner|dm|你|您)$/i;
    let groups = await this.resolveGroups().catch(() => this.groupNames());
    if (wanted && !OWNER_ALIAS.test(wanted)) {
      let hit = this.matchGroup(groups, wanted);
      if (!hit) {
        // 名单可能是旧的（刚被拉进新群）：强刷一次再认，别把群名当成「不认识的人」
        groups = await this.resolveGroups(true, { deep: true }).catch(() => groups);
        hit = this.matchGroup(groups, wanted);
      }
      if (hit) return { ok: true, who: hit, group: true };
      const list = groups.length ? groups.map((g) => `「${g}」`).join(' 或 ') : '（现在一个群都没认出来）';
      return {
        ok: false,
        error: `没认出「${wanted}」是哪个群，表情没发。现在认得出：${list}。要发到主人私信就写 target=主人。`,
      };
    }
    const owner = this.douyinOwner();
    if (owner.sameAsSelf) {
      return {
        ok: false,
        error: '抖音主人绑的就是她自己登录的那个号，抖音不能给自己发消息。要么给她换个号，要么把表情发到群里。',
      };
    }
    const name = String(owner.name ?? '').trim();
    if (!name) {
      return { ok: false, error: '还不知道主人在抖音的昵称。先让主人在面板点一次「绑定这个号」。' };
    }
    return { ok: true, who: name, group: false };
  }

  async sendStickerAct(args) {
    if (!this.cfg.douyin) return { ok: false, error: '抖音关着。' };
    const pick = this.stickers.find(args.text);
    if (!pick.ok) {
      return { ok: false, error: pick.error, candidates: pick.candidates, total: this.stickers.stats().total };
    }
    const target = await this.stickerTargetOf(args.target);
    if (!target.ok) return target;
    const check = this.policy.check('dm', 'douyin', target.who, { quotaAction: 'dm', free: true });
    if (!check.ok) return check;
    const entry = pick.entry;
    this.log?.info?.(`发表情「${entry.name}」→ ${target.who || '主人私信'}`);
    const result = await this.douyin
      .sendStickerTo(target.who, { file: this.stickers.fileOf(entry), src: entry.src, label: entry.name })
      .catch((error) => ({ ok: false, code: error?.code ?? 'ERROR', error: error?.message ?? String(error) }));
    if (result.ok) {
      this.stickers.touch(entry.id);
      this.store.addAction({
        platform: 'douyin',
        action: 'sticker',
        target: target.who,
        title: target.who,
        text: `[表情] ${entry.name}`,
        result: 'ok',
        extra: { sticker: entry.id, via: result.via },
      });
      this.store.save();
    } else {
      // 失败也要留痕：不然「发了四五次都不行」只剩一句抱怨，查都没法查
      this.log?.warn?.(`发表情失败：${result.code ?? '?'} ${result.error ?? ''} ${result.dump ?? ''}`);
      this.store.addAction({
        platform: 'douyin',
        action: 'sticker',
        target: target.who,
        title: target.who,
        text: `[表情没发出去] ${entry.name}`,
        result: 'fail',
        extra: {
          sticker: entry.id,
          code: result.code ?? '',
          error: String(result.error ?? '').slice(0, 160),
          dump: result.dump ?? '',
        },
      });
      this.store.save();
    }
    return {
      ...result,
      sticker: entry.name,
      id: entry.id,
      to: target.who,
      group: target.group,
      receipt: result.ok
        ? `表情包「${entry.name}」发到${target.group ? `群「${truncate(target.who, 16)}」` : '主人私信'}了${result.via === 'upload' ? '（按图片发的）' : ''}`
        : `表情包没发出去：${result.error ?? '不知道什么原因'}`,
    };
  }

  /** 图片工坊的产物目录（她画好的图都在这里）。 */
  workshopDir() {
    // 图片工坊默认放 workspace/media；换版本后如果换了位置，退到 workspace 也还能找到
    const media = path.join(this.dataDir, 'workspace', 'media');
    return fs.existsSync(media) ? media : path.join(this.dataDir, 'workspace');
  }

  /**
   * 找一张要发的图：
   *   - 直接给绝对路径（图片工坊面板「复制路径」拿到的那种）
   *   - 给文件名或 id 片段（ab6899f7）
   *   - 什么都不给：用最新的一张
   */
  resolveWorkshopImage(raw) {
    const s = String(raw ?? '')
      .trim()
      .replace(/^["'“”]+|["'“”]+$/g, '');
    if (s && fs.existsSync(s) && fs.statSync(s).isFile()) {
      return { ok: true, path: s, name: path.basename(s), from: 'path' };
    }
    const files = this.listImageFiles();
    if (!files.length) {
      return { ok: false, error: `还没有可发的图（画好的在 ${this.workshopDir()}，收到的在 ${this.mediaInbox()}）` };
    }
    const key = s.toLowerCase();
    const hit = key ? files.find((x) => x.f.toLowerCase().includes(key)) : files[0];
    if (!hit) {
      return { ok: false, error: `没找到「${s}」。现有的：${files.slice(0, 5).map((x) => x.f).join('、')}` };
    }
    return { ok: true, path: path.join(hit.dir, hit.f), name: hit.f, from: key ? 'match' : 'latest' };
  }

  /**
   * 能发的图：图片工坊画的 + 收到的图存下来的。按时间从新到旧。
   * source: draw=画的，recv=别人发来的。
   */
  listImageFiles() {
    const dirs = [
      { dir: this.workshopDir(), source: 'draw' },
      { dir: this.mediaInbox(), source: 'recv' },
    ];
    const out = [];
    for (const { dir, source } of dirs) {
      let names = [];
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const f of names) {
        if (!/\.(jpe?g|png|webp|gif)$/i.test(f)) continue;
        const full = path.join(dir, f);
        try {
          const st = fs.statSync(full);
          if (!st.isFile()) continue;
          out.push({ f, dir, source, at: st.mtimeMs, kb: Math.round(st.size / 1024) });
        } catch {
          // 文件刚好被删了，跳过
        }
      }
    }
    return out.sort((a, b) => b.at - a.at);
  }

  /**
   * 发一张本地图片：私信 / 群聊走聊天上传；评论区走抖音的图片评论。
   * 图片工坊画的图就是普通 jpg，直接塞给上传框。
   */
  async sendImageAct(args) {
    if (!this.cfg.douyin) return { ok: false, error: '抖音关着。' };
    const pick = this.resolveWorkshopImage(args.file ?? args.path ?? args.id ?? '');
    if (!pick.ok) return pick;
    const caption = String(args.text ?? '').trim().slice(0, 100);
    const targetRaw = String(args.target ?? '').trim();
    const where = String(args.where ?? '').trim().toLowerCase();
    const isComment =
      where === 'comment' || where === '评论区' || /douyin\.com\/(video|note)|^\d{15,}$/i.test(targetRaw);
    const fileName = path.basename(pick.path);

    if (isComment) {
      if (approvalFor(this.cfg, 'comment') !== 'auto') {
        return {
          ok: false,
          code: 'NEED_APPROVAL',
          error: '评论区发图属于公开动作，当前审批不是 auto；图片草稿面板还不支持，先把审批调成 auto 再发。',
        };
      }
      const check = this.policy.check('comment', 'douyin', targetRaw, { quotaAction: 'comment' });
      if (!check.ok) return check;
      const r = await this.douyin
        .commentImage(targetRaw, pick.path, { text: caption })
        .catch((error) => ({ ok: false, code: error?.code ?? 'ERROR', error: error?.message ?? String(error) }));
      this.store.addAction({
        platform: 'douyin',
        action: 'image',
        target: targetRaw,
        title: '评论区',
        text: `[图片] ${fileName}${caption ? ` ${caption}` : ''}`,
        result: r.ok ? 'ok' : 'fail',
        extra: { file: pick.path, where: 'comment', via: r.via, code: r.code ?? '' },
      });
      this.store.save();
      return {
        ...r,
        file: pick.path,
        where: 'comment',
        receipt: r.ok ? '图片评论发出去了' : `图片评论没发出去：${r.error ?? r.code ?? ''}`,
      };
    }

    const target = await this.stickerTargetOf(targetRaw);
    if (!target.ok) return target;
    const check = this.policy.check('dm', 'douyin', target.who, { quotaAction: 'dm', free: true });
    if (!check.ok) return check;
    const r = await this.douyin
      .sendStickerTo(target.who, { file: pick.path, label: fileName })
      .catch((error) => ({ ok: false, code: error?.code ?? 'ERROR', error: error?.message ?? String(error) }));
    this.store.addAction({
      platform: 'douyin',
      action: 'image',
      target: target.who,
      title: target.who,
      text: `[图片] ${fileName}`,
      result: r.ok ? 'ok' : 'fail',
      extra: { file: pick.path, via: r.via, code: r.code ?? '' },
    });
    this.store.save();
    this.log?.[r.ok ? 'info' : 'warn']?.(
      `发图 ${fileName} → ${target.who}${r.ok ? '' : ` 失败：${r.code ?? ''} ${r.error ?? ''}`}`,
    );
    return {
      ...r,
      file: pick.path,
      to: target.group ? 'group' : 'owner',
      receipt: r.ok
        ? `图片发给${target.group ? `群「${target.who}」` : '主人'}了`
        : `图片没发出去：${r.error ?? r.code ?? ''}`,
    };
  }

  async collectStickersAct(args) {
    if (!this.cfg.douyin) return { ok: false, error: '抖音关着。' };
    const paused = this.policy.paused();
    if (paused.paused) return { ok: false, error: `现在停手了：${paused.reason ?? '风控冷却中'}` };
    const target = await this.stickerTargetOf(args.target);
    // 收表情不改任何东西，目标解析不出来就去当前打开的会话里收
    const who = target.ok ? target.who : '';
    const limit = clamp(Number(args.n ?? 12), 1, 30);
    const result = await this.douyin
      .collectStickersFrom(who, { limit })
      .catch((error) => ({ ok: false, code: error?.code ?? 'ERROR', error: error?.message ?? String(error) }));
    const total = this.stickers.stats().total;
    return {
      ...result,
      to: who || '当前会话',
      total,
      dir: this.stickers.dir,
      receipt: result.ok
        ? `从${result.via === 'chat' ? '聊天记录' : '抖音表情面板'}收了 ${result.saved} 张新的（重复 ${result.duplicate ?? 0} 张），库里有 ${total} 张了`
        : `没收到表情：${result.error ?? '面板没打开'}`,
    };
  }

  nameStickerAct(args) {
    const id = String(args.target ?? '').trim();
    const name = String(args.text ?? '').trim();
    if (!id || !name) return { ok: false, error: '要说清楚哪一张（id）和它的新名字。' };
    const r = this.stickers.rename(id, name);
    return r.ok ? { ok: true, id: r.entry.id, name: r.entry.name } : r;
  }

  /**
   * 面板「看评论」弹层里，直接回某一条。
   * url 可以是视频 / 动态 / 专栏；rpid 是弹层里那条评论。
   */
  async replyComment(url, rpid, text) {
    const raw = String(url ?? '').trim();
    if (!raw) return { ok: false, error: '没有可回复的链接。' };
    const bvid = parseBvid(raw);
    const dynId = bvid ? null : parseDynamicId(raw);
    const cvid = bvid || dynId ? null : parseCvid(raw);
    if (!bvid && !dynId && !cvid) return { ok: false, error: '这个链接不是 B站视频/动态/专栏。' };

    let kind = 'video';
    let id = bvid;
    let oid = '';
    let commentType = 1;
    try {
      if (bvid) {
        const v = await this.bili.view(bvid);
        oid = v.aid;
        id = v.bvid;
      } else if (dynId) {
        const d = await this.bili.dynamic(dynId);
        if (!d.oid) return { ok: false, error: '这条动态没开评论区。' };
        kind = 'opus';
        id = d.id;
        oid = d.oid;
        commentType = d.commentType;
      } else {
        const a = await this.bili.article(cvid);
        kind = 'article';
        id = a.id;
        oid = a.oid;
        commentType = 12;
      }
    } catch (error) {
      return { ok: false, code: error?.code ?? 'ERROR', error: error?.message ?? String(error) };
    }

    const target = kind === 'video' ? id : kind === 'opus' ? `dyn:${id}` : `cv:${id}`;
    const dynamicId = kind === 'opus' ? id : '';
    const articleId = kind === 'article' ? id : '';
    const found = await this.bili.findReply(commentType, oid, rpid);
    if (!found) return { ok: false, error: '评论区里找不到这条了，刷新一下再试。' };
    const dedupeKey = `bilibili:reply:${target}:r${rpid}`;
    const check = this.policy.check('reply', 'bilibili', target, {
      userInitiated: true,
      quotaAction: 'comment',
      dedupeKey,
    });
    if (!check.ok) return { ok: false, code: check.code, error: check.message };
    return this.executePlan(
      {
        action: 'reply',
        platform: 'bilibili',
        target,
        kind,
        dynamicId,
        articleId,
        oid,
        commentType,
        dedupeKey,
        text,
        root: found.root && found.root !== '0' ? found.root : found.rpid,
        parent: found.rpid,
      },
      'operator',
    );
  }

  /* ---------------- write planning ---------------- */

  inferPlatform(raw, hint) {
    if (hint === 'bilibili' || hint === 'douyin') return hint;
    const text = String(raw ?? '').toLowerCase();
    if (text.includes('douyin.com') || text.includes('iesdouyin.com')) return 'douyin';
    if (text.includes('bilibili.com') || /^bv[0-9a-z]{10}$/i.test(text) || /^av\d+$/i.test(text)) return 'bilibili';
    if (/^\d{10,24}$/.test(text)) return 'douyin';
    return 'bilibili';
  }

  async buildPlan(action, args, { byOwner = false } = {}) {
    const platform = this.inferPlatform(args.target ?? args.url ?? '', args.platform);
    const targetRaw = String(args.target ?? args.url ?? '').trim();
    const text = String(args.text ?? '').trim();
    const mentionOwner = args.mention_owner === true;
    // 对话里点单的动作只防连点，不套她自己出门的 20 秒节奏。
    // 这一点以前漏了：回完私信紧接着评论，永远撞 90 秒的 TOO_FAST，
    // 表现就是「每次让她评论都要等一两分钟」。
    const asked = byOwner || this.policy.ownerActive();

    if (!this.cfg.enabled) return { ok: false, error: '摸鱼 已停用。' };
    if (platform === 'bilibili' && !this.cfg.bilibili) return { ok: false, error: 'B站关着。' };
    if (platform === 'douyin' && !this.cfg.douyin) return { ok: false, error: '抖音关着。' };

    if (action === 'like' || action === 'unlike') {
      let target;
      if (platform === 'douyin') {
        target = await this.douyin.idOf(targetRaw);
        if (!target) return { ok: false, error: '给个抖音视频链接/ID。' };
      } else {
        target = parseBvid(targetRaw);
        if (!target) return { ok: false, error: '给个 BV 号/链接。' };
      }
      const check = this.policy.check(action, platform, target, { quotaAction: 'like', userInitiated: asked });
      if (!check.ok) return check;
      return { ok: true, action, platform, target, text: '' };
    }

    if (action === 'follow' || action === 'unfollow') {
      if (!this.cfg.allowFollow) return { ok: false, error: '关注功能关着。' };
      let target;
      if (platform === 'bilibili') {
        target = /^\d{1,20}$/.test(targetRaw) ? targetRaw : '';
        if (!target) {
          const bvid = parseBvid(targetRaw);
          if (bvid) {
            const v = await this.bili.view(bvid);
            target = v.authorId;
          } else {
            const dynId = parseDynamicId(targetRaw);
            if (!dynId) return { ok: false, error: '关注要给对方 UID、视频链接或动态链接。' };
            const d = await this.bili.dynamic(dynId);
            target = d.authorId;
          }
        }
        if (!target) return { ok: false, error: '拿不到对方 UID。' };
      } else {
        target = await this.douyin.idOf(targetRaw);
        if (!target) return { ok: false, error: '抖音关注要给视频链接/ID（从视频页点）。' };
      }
      const check = this.policy.check(action, platform, target, { quotaAction: 'follow', userInitiated: asked });
      if (!check.ok) return check;
      return { ok: true, action, platform, target, text: '' };
    }

    if (action === 'save') {
      if (platform !== 'bilibili') return { ok: false, error: '稍后再看只有 B站。' };
      if (!this.cfg.allowSave) return { ok: false, error: '稍后再看关着。' };
      const bvid = parseBvid(targetRaw);
      if (!bvid) return { ok: false, error: '给个 BV 号/链接。' };
      const check = this.policy.check('save', platform, bvid, { quotaAction: 'save', userInitiated: asked });
      if (!check.ok) return check;
      return { ok: true, action, platform, target: bvid, text: '' };
    }

    if (action === 'comment' || action === 'reply') {
      const max = clamp(Number(this.cfg.commentMaxChars ?? 120), 20, 300);
      if (!text) return { ok: false, error: '评论要有正文。' };
      if ([...text].length > max) return { ok: false, error: `评论最多 ${max} 字。` };
      if ([...text].length < 4) return { ok: false, error: '太短了，像刷屏；至少四个字。' };
      if (/https?:\/\/|www\./i.test(text)) return { ok: false, error: '评论里不要放链接。' };
      if (/(.)\1{7,}/.test(text)) return { ok: false, error: '别刷重复字符。' };

      let target;
      if (platform === 'douyin') {
        if (action === 'reply') return { ok: false, error: '抖音楼中楼回复暂未开放；先发一条评论。' };
        target = await this.douyin.idOf(targetRaw);
        if (!target) return { ok: false, error: '给个抖音视频链接/ID。' };
        const check = this.policy.check(action, platform, target, { quotaAction: 'comment', userInitiated: asked });
        if (!check.ok) return check;
        return { ok: true, action, platform, target, text, mentionOwner };
      }

      let kind = 'video';
      target = parseBvid(targetRaw);
      let dynamicId = '';
      let articleId = '';
      if (!target) {
        dynamicId = parseDynamicId(targetRaw) ?? '';
        articleId = dynamicId ? '' : (parseCvid(targetRaw) ?? '');
        if (dynamicId) {
          kind = 'opus';
          target = `dyn:${dynamicId}`;
        } else if (articleId) {
          kind = 'article';
          target = `cv:${articleId}`;
        }
      }
      if (!target) return { ok: false, error: '给个视频 / 动态 / 专栏链接。' };

      let oid = '';
      let commentType = kind === 'article' ? 12 : 1;
      if (kind === 'opus') {
        const d = await this.bili.dynamic(dynamicId);
        if (!d.oid) return { ok: false, error: '这条动态没开评论区。' };
        oid = d.oid;
        commentType = d.commentType;
      } else if (kind === 'article') {
        oid = articleId;
      } else {
        const v = await this.bili.view(target);
        oid = v.aid;
      }

      let root = '';
      let parent = '';
      let dedupeKey = '';
      if (action === 'reply') {
        const rpid = String(args.reply_to ?? '').trim();
        if (!rpid) return { ok: false, error: '回复要给 reply_to（评论 ID）。' };
        const found = await this.bili.findReply(commentType, oid, rpid);
        if (!found) return { ok: false, error: '在评论区里没找到这条评论；可能删了，或再往前翻一页。' };
        root = found.root && found.root !== '0' ? found.root : found.rpid;
        parent = found.rpid;
        // 一条评论只回一次；同一内容下的不同评论互不影响
        dedupeKey = `${platform}:${action}:${target}:r${rpid}`;
      }
      const check = this.policy.check(action, platform, target, { quotaAction: 'comment', dedupeKey, userInitiated: asked });
      if (!check.ok) return check;
      return { ok: true, action, platform, target, text, mentionOwner, root, parent, kind, dynamicId, articleId, oid, commentType, dedupeKey };
    }

    if (action === 'post') {
      if (platform !== 'bilibili') return { ok: false, error: '抖音图文发布暂未开放；B站可以发纯文字动态。' };
      if (!this.cfg.allowPost) return { ok: false, error: '发动态关着。' };
      if ([...text].length < 4) return { ok: false, error: '正文太短。' };
      if ([...text].length > 2000) return { ok: false, error: '正文最多 2000 字。' };
      const check = this.policy.check('post', platform, 'dynamic', { quotaAction: 'post', userInitiated: asked });
      if (!check.ok) return check;
      return { ok: true, action, platform, target: 'dynamic', text, mentionOwner };
    }

    if (action === 'dm') {
      if (!this.cfg.allowDm) return { ok: false, error: '私信关着。' };
      if (!text) return { ok: false, error: '私信要有正文。' };
      let target;
      if (platform === 'bilibili') {
        const owner = this.ownerId('bilibili');
        if (!owner) return { ok: false, error: '没设主人 B站 UID；先到面板设置里填「主人 B站 UID」。' };
        target = String(targetRaw || owner).trim();
        if (target !== owner) return { ok: false, error: '私信只发主人，不发别人。' };
      } else {
        /**
         * 群聊：target 写群名；target 写「主人 / 私信」= 明确要私信主人。
         *
         * 以前这里有个很坑的静默回退：target 给了群名但没认出来（群还没被识别、
         * 名字写错、名单过期），代码会一路掉到最后「私信主人」——她以为发到群里了，
         * 其实发进了主人的私信，群里当然一条都没有。现在只要 target 不是空的、
         * 又不是「主人」，认不出群就报错，绝不改道。
         */
        let groups = await this.resolveGroups().catch(() => this.groupNames());
        const wantedRaw = String(targetRaw ?? '').trim();
        const OWNER_ALIAS = /^(主人|主人私信|私信|私聊|owner|dm|你|您)$/i;
        const ownerNick = String(this.douyinOwner().name ?? '').trim();
        const flat = (s) => String(s ?? '').replace(/\s+/g, '').toLowerCase();
        /**
         * target 写的是**主人的抖音昵称**时，按私信主人处理，别去群名单里找。
         * 线上踩过：她回群话时写了「小月月一直在玩」（主人的名字），
         * 而群标题恰好包含这个名字——于是话被发进了一个群，她以为在私信主人。
         */
        const toOwnerDm = OWNER_ALIAS.test(wantedRaw) || (!!ownerNick && !!wantedRaw && flat(wantedRaw) === flat(ownerNick));
        const wanted = toOwnerDm ? '' : wantedRaw;
        // 上一次推送是哪个群：她回群消息时经常漏 target，这个上下文能兜住。
        // 但主人刚发过私信（90 秒内）时以私信为准——否则「主人先私信、群里紧接着有人说话」
        // 会把回私信的那条判成「该回群」，看起来就是「私聊不理我」。
        const dmFresh = Date.now() - Number(this.lastDmPoke?.at ?? 0) < 90 * 1000;
        const pokedGroup =
          !dmFresh && this.lastGroupPoke && Date.now() - Number(this.lastGroupPoke.at ?? 0) < 10 * 60 * 1000
            ? String(this.lastGroupPoke.group ?? '')
            : '';
        let asGroup = wanted ? this.matchGroup(groups, wanted) : null;
        if (!asGroup && wanted && groups.length === 1 && /^(群|群聊|那个群|抖音群|group|the group)$/i.test(wanted)) {
          asGroup = groups[0];
        }
        if (!asGroup && wanted) {
          // 名单可能是旧的（主人刚把她拉进新群）：滚动会话列表强刷一次再认
          groups = await this.resolveGroups(true, { deep: true }).catch(() => groups);
          asGroup = this.matchGroup(groups, wanted);
        }
        if (!asGroup && wanted && pokedGroup && this.matchGroup([pokedGroup], wanted)) asGroup = pokedGroup;
        if (!asGroup && !wanted && pokedGroup) {
          return {
            ok: false,
            error: `刚才那条是群「${truncate(pokedGroup, 24)}」里的消息，不是私信。要回群就把 target 写成群名（照着推送里给的写）；要私信主人就写 target=主人。`,
          };
        }
        if (!asGroup && wanted) {
          const list = groups.length ? groups.map((g) => `「${g}」`).join(' 或 ') : '（现在一个群都没认出来）';
          return {
            ok: false,
            error: `没认出「${wanted}」是哪个群。现在认得出：${list}。要回群就照抄群名（或只写其中一个成员名）；要私信主人就写 target=主人。`,
          };
        }
        if (asGroup) {
          // 要真 @ 人就得知道那个人在群里的昵称；不知道就直说，别让她手打一个假 @。
          // 默认 @ 主人；也可以用 args.mention 指定群里的别人。
          const rawMention = String(args.mention ?? '').trim().replace(/^@+/, '');
          // 她常把要 @ 的人直接写在正文开头（「@大萌神 在吗」）——那只是个普通字符。
          // 这里把它当成 @ 目标，交给候选面板插成真 chip，而不是发一串蓝字。
          const leadingAt = /^@([^\s@，。！？、,.!?：:;；~～]{1,24})/.exec(String(text ?? '').trim());
          const fromText = leadingAt ? leadingAt[1].trim() : '';
          // 「@你 / @主人」不是昵称：她不知道主人的抖音名时就会这么写，候选面板里永远找不到人
          const isPlaceholder = (v) => /^(你|您|主人|主人你|老板|我|me|you|owner)$/i.test(v);
          const explicit = isPlaceholder(rawMention) ? '' : rawMention || (isPlaceholder(fromText) ? '' : fromText);
          const ownerName = String(this.douyinOwner().name ?? '').trim();
          const wantsOwner = mentionOwner || isPlaceholder(rawMention) || isPlaceholder(fromText);
          /**
           * 还有一种最常见的写法：不传 mention，直接把名字写在正文开头（「大萌神，在吗」）。
           * 以前这种情况就当普通正文发出去，一个字都不 @。群标题没起名时就是成员名拼的，
           * 从里面拆出名单，在开头对一次名字——对上了就当成 @ 目标。
           */
          const rawText = String(text ?? '').trim();
          const members = [...String(asGroup).split(/[,，、]/).map((s) => s.trim()).filter(Boolean), ownerName].filter(Boolean);
          let lead = null;
          if (!explicit) {
            for (const n of members) {
              const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              const m = new RegExp(`^@?\\s*${esc}(?=[\\s，。！？、,.!?：:;；~～]|$)[\\s，。！？、,.!?：:;；~～]*`).exec(rawText);
              if (m && (!lead || n.length > lead.name.length)) lead = { name: n, cut: m[0].length };
            }
          }
          const wantMention = explicit || (lead ? lead.name : '') || (wantsOwner ? ownerName : '');
          if (!explicit && !lead && wantsOwner && !ownerName) {
            return {
              ok: false,
              error: '还不知道主人在抖音叫什么，群里 @ 不到人。先让主人在面板点一次「绑定这个号」，或者把群里的昵称告诉我。',
            };
          }
          // 手打的「@昵称」/ 开头的名字都是假 @（只是文字），发之前剥掉；真 @ 由插入 chip 完成
          let body = rawText;
          if (lead && lead.name === wantMention) body = body.slice(lead.cut);
          body = stripLeadingFakeAt(stripAtPlaceholder(wantMention ? stripAtName(body, wantMention) : body));
          body = body.replace(/^[\s，。！？、,.!?：:;；~～]+/, '').trim();
          if (!body) {
            return { ok: false, error: '除了 @ 就没有正文了。群里只发一个 @ 等于刷屏，写点要说的。' };
          }
          const check = this.policy.check('dm', platform, asGroup, { quotaAction: 'dm', free: true });
          if (!check.ok) return check;
          return { ok: true, action, platform, target: asGroup, text: body, free: true, group: true, mention: wantMention };
        }
        const owner = await this.ensureDouyinOwner();
        if (!owner.ok) return owner;
        if (this.douyinOwner().sameAsSelf) {
          return {
            ok: false,
            error:
              '抖音主人绑的就是她现在登录的那个号，抖音不能给自己发私信。要么给桌宠换一个号登录，要么这条私信走面板说。',
          };
        }
        target = toOwnerDm ? owner.secUid : String(targetRaw || owner.secUid).trim();
        if (target !== owner.secUid) return { ok: false, error: '私信只发主人，不发别人。' };
      }
      // 只发给主人的私信不限量：不进每日额度，也不受「同一个对象一天一次」限制
      const check = this.policy.check('dm', platform, target, { quotaAction: 'dm', free: true });
      if (!check.ok) return check;
      return { ok: true, action, platform, target, text, free: true };
    }

    return { ok: false, error: `不认识的动作：${action}` };
  }

  makeDraft(plan) {
    return this.store.addDraft({
      action: plan.action,
      platform: plan.platform,
      target: plan.target,
      group: !!plan.group,
      kind: plan.kind ?? '',
      dynamicId: plan.dynamicId ?? '',
      articleId: plan.articleId ?? '',
      oid: plan.oid ?? '',
      commentType: plan.commentType ?? 0,
      dedupeKey: plan.dedupeKey ?? '',
      text: plan.text ?? '',
      mentionOwner: !!plan.mentionOwner,
      // 群里的 @ 目标要跟着草稿一起存：批准时走的是 draft，丢了就变成「只有正文没有 @」
      mention: String(plan.mention ?? ''),
      root: plan.root ?? '',
      parent: plan.parent ?? '',
    });
  }

  previewText(draft) {
    const p = PLATFORM_NAMES[draft.platform] ?? draft.platform;
    const a = ACTION_NAMES[draft.action] ?? draft.action;
    const known = this.titleOf(draft.platform, draft.target);
    const target =
      draft.action === 'post'
        ? '动态'
        : draft.action === 'dm'
          ? draft.group
            ? `群「${truncate(String(draft.target), 16)}」`
            : `给主人（${draft.platform === 'douyin' ? '抖音' : 'B站'}）`
          : known
            ? `《${truncate(known, 24)}》`
            : draft.kind === 'opus'
              ? '一条动态'
              : draft.kind === 'article'
                ? '一篇专栏'
                : draft.target;
    const body = draft.text ? `：${truncate(draft.text, 80)}` : '';
    return `【${p}·${a}】${target}${body}${draft.mentionOwner ? '（@主人）' : ''}`;
  }

  /** 面板批准后走这里；这是唯一真正执行草稿的入口。 */
  async approveDraft(id, source = 'operator') {
    const draft = this.store.draft(id);
    if (!draft || draft.status !== 'pending') return { ok: false, error: '这条草稿不在了或已处理。' };
    const check = this.policy.check(draft.action, draft.platform, draft.target, {
      userInitiated: true,
      quotaAction: this.capAction(draft.action),
      dedupeKey: draft.dedupeKey,
      free: draft.action === 'dm',
    });
    if (!check.ok) {
      this.store.closeDraft(id, 'rejected', { reason: check.message });
      this.store.save();
      return { ok: false, error: check.message };
    }
    draft.status = 'sending';
    draft.startedAt = new Date().toISOString();
    this.store.save();
    const plan = {
      free: draft.action === 'dm',
      action: draft.action,
      platform: draft.platform,
      target: draft.target,
      group: !!draft.group,
      kind: draft.kind,
      dynamicId: draft.dynamicId,
      articleId: draft.articleId,
      oid: draft.oid,
      commentType: draft.commentType,
      dedupeKey: draft.dedupeKey,
      text: draft.text,
      mentionOwner: draft.mentionOwner,
      mention: draft.mention ?? '',
      root: draft.root,
      parent: draft.parent,
    };
    const receipt = await this.executePlan(plan, source);
    this.store.closeDraft(id, receipt.ok ? (receipt.uncertain ? 'unknown' : 'sent') : receipt.code === 'WRITE_UNCERTAIN' ? 'unknown' : 'failed', {
      receipt,
    });
    this.store.save();
    return receipt;
  }

  rejectDraft(id) {
    const draft = this.store.closeDraft(id, 'rejected');
    this.store.save();
    return draft ? { ok: true, rejected: id } : { ok: false, error: '没这条草稿。' };
  }

  async executePlan(plan, source) {
    const { action, platform, target, text } = plan;
    const t0 = Date.now();
    try {
      let result;
      if (action === 'like' || action === 'unlike') {
        result = platform === 'bilibili'
          ? await this.bili.like(target, action === 'like')
          : await this.douyin.like(target, action === 'like');
      } else if (action === 'follow' || action === 'unfollow') {
        result = platform === 'bilibili'
          ? await this.bili.follow(target, action === 'follow')
          : await this.douyin.follow(target, action === 'follow');
      } else if (action === 'save') {
        result = await this.bili.save(target);
      } else if (action === 'comment' || action === 'reply') {
        result = platform === 'bilibili'
          ? await this.bili.comment({
              bvid: plan.kind === 'video' || !plan.kind ? target : '',
              dynamicId: plan.kind === 'opus' ? plan.dynamicId : '',
              articleId: plan.kind === 'article' ? plan.articleId : '',
              oid: plan.oid,
              replyType: plan.commentType,
              text,
              root: plan.root,
              parent: plan.parent,
              mentionOwner: plan.mentionOwner,
            })
          : await this.douyin.comment(target, text, {
              // 抖音 @ 人要用昵称（sec_uid 不行）；没存昵称就现读一次
              mention: plan.mentionOwner ? await this.douyinOwnerName() : '',
            });
      } else if (action === 'post') {
        result = await this.bili.post({ text, mentionOwner: plan.mentionOwner });
      } else if (action === 'dm') {
        result =
          platform === 'bilibili'
            ? await this.bili.dm(target, text)
            : plan.group
              ? await this.douyin.replyDm(target, text, {
                  // 群里 @ 人必须是真 chip：手打 @ 只是文字，看起来蓝但对方收不到通知
                  mention: String(plan.mention ?? '').trim(),
                })
              : await this.douyinDmFast(target, text);
      } else {
        return { ok: false, code: 'UNKNOWN_ACTION', error: '不认识的动作。' };
      }

      // 记总耗时：主人在追「一秒内回复」，得能看出是发送慢还是别的地方慢
      if (result && typeof result === 'object') result = { ...result, msTotal: Date.now() - t0 };

      // 「平台没给确认」不能当成功记账：额度扣了会冤枉人，去重键还会把重试挡成 DUPLICATE
      const uncertain = !!result && (result.ok === false || result.confirmed === false);
      try {
        this.policy.consume(action, platform, target, {
          quotaAction: this.capAction(action),
          countQuota: !plan.free && !uncertain,
          dedupeKey: plan.free || uncertain ? '' : plan.dedupeKey,
          // free：回主人私信只算聊天，不占公开动作的节奏位
          free: !!plan.free,
          text,
          title: this.titleOf(platform, target),
          kind: plan.kind ?? result?.kind,
          result: uncertain ? 'unknown' : 'ok',
          markSeen: !uncertain,
          extra: result,
          tags: result?.author ? [String(result.author)] : [],
        });
      } catch (error) {
        // 记账失败（磁盘满/权限）不能反过来把已经发出去的动作标成失败，否则主人一重试就重复发（#9）
        this.log?.warn?.('stroll quota consume failed', { action, message: error?.message });
      }
      const receipt = {
        ok: true,
        action,
        platform,
        target,
        group: !!plan.group,
        // 发到哪儿要写死：她以前会把「私信主人」当成「发到群里」
        ...(action === 'dm' ? { to: plan.group ? 'group' : 'owner' } : {}),
        ...(uncertain ? { uncertain: true } : {}),
        result,
        receipt: this.receiptText(action, platform, result, plan),
      };
      // 群里的这句已经回掉了：上下文清掉，别让她下一条（可能是私信主人）被当成回群
      if (plan.group) this.lastGroupPoke = null;
      if (source === 'operator') {
        await this.push('stroll.sent', `${this.receiptText(action, platform, result, plan)}`, { action, platform, target }, 'flush');
      }
      return receipt;
    } catch (error) {
      const code = error?.code ?? 'ERROR';
      if (code === 'RISK') {
        await this.push('stroll.risk', `平台风控：${error.message}。已经停手，不要重试。`, { code, action, platform }, 'flush');
      }
      return { ok: false, code, action, platform, target, error: error?.message ?? String(error) };
    }
  }

  capAction(action) {
    if (action === 'unlike') return 'like';
    if (action === 'unfollow') return 'follow';
    if (action === 'reply') return 'comment';
    return action;
  }

  receiptText(action, platform, result, plan = {}) {
    const p = PLATFORM_NAMES[platform] ?? platform;
    if (action === 'like' || action === 'unlike') {
      const what = action === 'like' ? '点赞' : '取消赞';
      if (result?.already) return `${p} 已经是${what}后的状态，不用重复操作`;
      if (result?.confirmed === false) return `${p} ${what}请求发出去了，但平台没给确认`;
      return `${p} ${what}成功`;
    }
    if (action === 'comment' || action === 'reply') {
      if (platform === 'douyin' && result?.queued) {
        const tail = result.mentioned === true ? '，@ 已生效' : result.mentioned === false ? '，@ 没生效' : '';
        return `抖音 评论发出去了，评论区暂时没刷出来，可能审核中${tail}`;
      }
    }
    if (action === 'comment' || action === 'reply') {
      const verb = action === 'reply' ? '回复' : '评论';
      const bits = [`${p} ${verb}发出去了`];
      if (result?.kind === 'opus') bits.push('动态');
      if (result?.kind === 'article') bits.push('专栏');
      if (result.rpid) bits.push(`rpid ${result.rpid}`);
      if (result.confirmed === false) bits.push('没拿到发布回执，可能没发出去');
      if (result.mentioned === true) bits.push('@ 已生效');
      if (result.mentioned === false) bits.push('@ 没生效');
      if (result.visibility === 'public') bits.push('公开可见');
      if (result.visibility === 'unknown') bits.push('公开列表暂未看到，可能审核中');
      return bits.join('，');
    }
    if (action === 'post') return `${p} 动态发出去了${result.dynamicId ? `（${result.dynamicId}）` : ''}`;
    if (action === 'dm') {
      if (!plan.group) return `${p} 私信发给主人了（不是群）`;
      const name = truncate(String(plan.target ?? ''), 16);
      if (plan.mention) {
        // 群里 @ 只有在插成 chip 时才真的会通知对方；插不上就如实说，别让主人以为提到了
        return result?.mentioned
          ? `${p} 群「${name}」发出去了，@${plan.mention} 已经插进去（带名字的那种）`
          : `${p} 群「${name}」发出去了，但 @${plan.mention} 没插上——那样只是正文里一个 @ 符号，对方收不到通知`;
      }
      return `${p} 群「${name}」发出去了`;
    }
    if (action === 'save') return '已加到 B站稍后再看';
    if (action === 'follow' || action === 'unfollow') {
      const what = action === 'follow' ? '关注' : '取关';
      if (result?.already) return `${p} 已经是${what}后的状态，不用重复操作`;
      if (result?.confirmed === false) return `${p} ${what}请求发出去了，但平台没给确认`;
      return `${p} ${what}完成`;
    }
    return `${p} ${ACTION_NAMES[action] ?? action}完成`;
  }

  /* ---------------- policy view / webui ---------------- */

  policyView() {
    return {
      ok: true,
      enabled: this.cfg.enabled,
      approval: this.cfg.approval,
      owner: (() => {
        const uid = this.ownerId('bilibili');
        const dy = this.douyinOwner();
        return {
          uid,
          name: this.cfg.ownerName || '',
          douyin: dy.secUid || dy.raw,
          douyinOk: dy.bound,
          douyinPending: !!dy.raw && !dy.bound,
          douyinName: dy.name,
          douyinSelf: dy.selfSecUid,
          douyinSelfName: dy.selfName,
          douyinSelfId: dy.selfDouyinId,
          douyinSame: dy.sameAsSelf,
        };
      })(),
      platforms: { bilibili: this.cfg.bilibili, douyin: this.cfg.douyin },
      caps: this.policy.snapshot(),
      quiet: { from: this.cfg.quietFrom, to: this.cfg.quietTo },
      autoSessionsPerDay: this.cfg.autoSessionsPerDay,
      interests: this.cfg.interests,
      avoid: this.cfg.avoid,
      tokenDailyBudget: this.cfg.tokenDailyBudget,
      risk: this.store.data.risk,
      // 风控拦截力度：off 只记账不拦人（默认）/ light 只拦验证码 / strict 旧的长冷却
      riskGuard: this.cfg.riskGuard ?? 'off',
      riskGuardPaused: this.policy.paused(),
      pending: this.store.pendingDrafts().length,
    };
  }

  webUi() {
    const policy = this.policy.snapshot();
    const biliOk = !!this.lastStatus?.bili?.loggedIn;
    const douyinOk = !!this.lastStatus?.douyin?.loggedIn;
    const risk = policy.paused.paused;
    const pending = this.store.pendingDrafts().length;
    return {
      label: '摸鱼',
      lamps: [
        { label: 'B站', state: biliOk ? 'online' : 'offline', hint: biliOk ? this.lastStatus.bili.name : '未登录/未查' },
        { label: '抖音', state: douyinOk ? 'online' : 'offline', hint: douyinOk ? '已登录' : '窗口未开/未登录' },
        { label: '风控', state: risk ? 'error' : 'online', hint: risk ? policy.paused.reason : '正常' },
        {
          label: '额度',
          state: Object.entries(policy.caps).some(([key, cap]) => cap > 0 && Number(policy.usage[key] ?? 0) >= cap) ? 'offline' : 'online',
          hint: policy.summary,
        },
      ],
      badges: [
        { label: '今日赞', value: `${policy.usage.like}/${policy.caps.like}`, tone: 'plain' },
        { label: '评', value: `${policy.usage.comment}/${policy.caps.comment}`, tone: 'plain' },
        { label: '待批', value: pending, tone: pending ? 'on' : 'off' },
      ],
      panels: [
        {
          id: 'stroll',
          title: '摸鱼',
          description: '出门看看、批准草稿、打开视频、拉手刹。',
          getMethods: ['status'],
        },
      ],
      config: CONFIG_GROUPS,
      promptDocs: [
        {
          key: 'worlds.stroll.envPrompt',
          title: '摸鱼 · 环境提示词',
          description: '出门的边界、省 token 的读法、公开动作的语气与停手规则。',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
          vars: [
            { name: 'stroll.summary', description: '今日额度、风控、审批方式' },
            { name: 'stroll.activity', description: '今天的活跃度建议（由评论额度推出）' },
            { name: 'stroll.presence', description: '她现在正在看哪一条' },
            { name: 'stroll.identity', description: 'B站/抖音登录身份' },
            { name: 'stroll.owner', description: '主人 UID/昵称' },
            { name: 'stroll.platforms', description: '两个平台开关' },
            { name: 'stroll.approval', description: '审批方式' },
            { name: 'stroll.interests', description: '兴趣词' },
            { name: 'stroll.last', description: '上次动作' },
            { name: 'stroll.watch', description: '一起看的当前页面' },
            { name: 'stroll.books', description: '在读哪本书、读到百分之几' },
          ],
        },
      ],
      invoke: (panel, method, args) => this.invoke(panel, method, args),
    };
  }

  async invoke(panel, method, args = []) {
    try {
      if (method === 'status') return await this.panelStatus();
      if (method === 'approve') return await this.approveDraft(String(args[0] ?? ''), 'operator');
      if (method === 'reject') return this.rejectDraft(String(args[0] ?? ''));
      if (method === 'open') {
        const result = await this.readOpen({ url: String(args[0] ?? '') });
        if (typeof result === 'string') return JSON.parse(result);
        if (result && typeof result.text === 'string') return JSON.parse(result.text);
        return result;
      }
      if (method === 'pause') {
        const hours = clamp(Number(args[0] ?? 24), 1, 168);
        this.store.setRisk(Date.now() + hours * 3600 * 1000, `主人拉了手刹（${hours} 小时）`, 'MANUAL');
        this.store.save();
        return { ok: true, pausedUntil: new Date(this.store.data.risk.until).toISOString() };
      }
      if (method === 'resume') {
        this.store.clearRisk();
        this.store.save();
        return { ok: true };
      }
      if (method === 'reset_usage') return this.resetToday();
      if (method === 'set_background') {
        const on = args[0] === true || args[0] === 'true' || args[0] === 1 || args[0] === 'on';
        this.persist({ background: on });
        return { ok: true, background: on };
      }
      if (method === 'set_auto') {
        const n = clamp(Number(args[0] ?? 0), 0, 10);
        this.persist({ autoSessionsPerDay: n });
        return { ok: true, autoSessionsPerDay: n };
      }
      if (method === 'set_approval') {
        const v = String(args[0] ?? '');
        if (!['dry_run', 'confirm', 'auto_low_risk', 'auto_all'].includes(v)) {
          return { ok: false, error: '只有 只读 / 全批准 / 赞自动 三种。' };
        }
        this.persist({ approval: v });
        return { ok: true, approval: v };
      }
      if (method === 'search') {
        const q = String(args[0] ?? '').trim();
        if (!q) return { ok: false, error: '给个搜索词。' };
        if (!this.cfg.bilibili) return { ok: false, error: 'B站关着。' };
        const items = await this.bili.search(q, 6);
        return {
          ok: true,
          query: q,
          items: items.map((v) => ({ id: v.id, title: v.title, author: v.author, dur: v.dur, stat: v.stat, url: v.url })),
        };
      }
      if (method === 'list') {
        if (!this.cfg.bilibili) return { ok: true, items: [] };
        const kind = String(args[0] ?? 'viewed');
        if (kind === 'toview') return { ok: true, items: await this.bili.toview(8) };
        if (kind === 'popular') {
          const items = await this.bili.feed(8);
          return {
            ok: true,
            items: items.map((v) => ({
              id: v.id,
              title: v.title,
              author: v.author,
              dur: v.dur,
              stat: v.stat,
              url: v.url,
            })),
          };
        }
        return { ok: true, items: [] };
      }
      if (method === 'inbox') {
        const only = args[1] === 'douyin' ? 'douyin' : args[1] === 'bilibili' ? 'bilibili' : '';
        const limit = clamp(Number(args[0] ?? 15), 1, 20);
        let items = [];
        if (only !== 'douyin' && this.cfg.bilibili) items = await this.bili.inbox(limit);
        if (only !== 'bilibili' && this.cfg.douyin) {
          const dy = await this.douyinInbox();
          items = items.concat(dy);
        }
        items = items.sort((a, b) => Number(b.at ?? 0) - Number(a.at ?? 0)).slice(0, limit);
        // 抖音那边的 at 是「刚读到」的时间，不覆盖更早的评论
        this.inboxCache = items;
        return {
          ok: true,
          items: items.map((x) => ({ ...x, fresh: !this.store.seenAt(`msg:${x.id}`) })),
          counts: {
            all: items.length,
            reply: items.filter((x) => x.kind === 'reply').length,
            at: items.filter((x) => x.kind === 'at').length,
            dm: items.filter((x) => x.kind === 'dm').length,
          },
          unread: items.filter((x) => !this.store.seenAt(`msg:${x.id}`)).length,
        };
      }
      if (method === 'mark_seen') {
        const ids = Array.isArray(args[0]) ? args[0].map(String).filter(Boolean) : [String(args[0] ?? '')].filter(Boolean);
        if (!ids.length) return { ok: true, marked: 0 };
        for (const id of ids) this.store.markSeen(`msg:${id}`);
        this.store.save();
        return { ok: true, marked: ids.length };
      }
      if (method === 'open_external') {
        const raw = String(args[0] ?? '').trim();
        if (!raw) return { ok: false, error: '没有链接可打开。' };
        return openInBrowser(raw);
      }
      if (method === 'books_pick') {
        // 面板拿不到系统对话框，只能由 Node 这边弹一个
        const picked = await pickFolder('选择书库文件夹（放 txt / md）');
        if (!picked) {
          return { ok: false, error: '没选文件夹（取消了，或者系统不让弹窗）。也可以在设置里手动粘路径。' };
        }
        // 走到这儿还带替换符，说明拿到的还是坏字符串：宁可不改，也别再建一个乱码目录
        if (looksBrokenPath(picked)) {
          return { ok: false, error: '路径里有中文没读对，没敢保存。请在设置里手动粘一次路径。' };
        }
        let exists = false;
        try {
          exists = fs.statSync(picked).isDirectory();
        } catch {
          exists = false;
        }
        if (!exists) {
          try {
            fs.mkdirSync(picked, { recursive: true });
          } catch (error) {
            return { ok: false, error: `建不了这个目录：${error?.message ?? error}` };
          }
        }
        this._bookDirFix = picked;
        this.persist({ booksDir: picked });
        return { ok: true, dir: picked, books: this.listBooks() };
      }
      if (method === 'books_open') {
        const dir = this.bookDir();
        try {
          if (!fs.statSync(dir).isDirectory()) throw new Error('不是目录');
        } catch {
          try {
            fs.mkdirSync(dir, { recursive: true });
          } catch (error) {
            return { ok: false, dir, error: `这个目录打不开：${error?.message ?? error}` };
          }
        }
        const opened = openFolder(dir);
        return { ...opened, dir };
      }
      if (method === 'reply_to_comment') {
        const id = String(args[0] ?? '');
        const text = clampText(String(args[1] ?? ''), Number(this.cfg.commentMaxChars ?? 120));
        return await this.replyToMessage(id, text);
      }
      if (method === 'comments') {
        const url = String(args[0] ?? '').trim();
        if (!url) return { ok: false, error: '没有可看的链接。' };
        const n = clamp(Number(args[1] ?? 10), 1, 20);
        const data = await this.bili.commentsOf(url, n);
        return { ok: true, ...data };
      }
      if (method === 'reply_comment') {
        const url = String(args[0] ?? '').trim();
        const rpid = String(args[1] ?? '').trim();
        const text = clampText(String(args[2] ?? ''), Number(this.cfg.commentMaxChars ?? 120));
        if (!rpid) return { ok: false, error: '没指定要回哪一条评论。' };
        if (!text) return { ok: false, error: '回复要有正文。' };
        return await this.replyComment(url, rpid, text);
      }
      if (method === 'save_toview') {
        const url = String(args[0] ?? this.lastOpen?.url ?? '').trim();
        if (!url) return { ok: false, error: '先打开一条 B站视频。' };
        return await this.quickAct('save', '', url);
      }
      if (method === 'set_activity') {
        const key = String(args[0] ?? '');
        const preset = ACTIVITY_PRESETS[key];
        if (!preset) return { ok: false, error: '只有 安静 / 日常 / 活跃 / 话痨 四档。' };
        const fields = { ...preset };
        delete fields.label;
        this.persist(fields);
        return { ok: true, activity: key, label: preset.label, ...fields };
      }
      if (method === 'presence') return { ok: true, presence: this.presenceView(), watching: !!this.watch };
      if (method === 'usage_detail') return this.usageDetail(String(args[0] ?? ''));
      if (method === 'timeline') return { ok: true, items: this.timelineItems(args[0]) };
      if (method === 'set_ramp') {
        const on = args[0] !== false && args[0] !== 'false';
        this.persist({ newAccountRamp: on });
        return { ok: true, newAccountRamp: on, ramp: this.policy.rampFactor() };
      }
      if (method === 'presence_dismiss') {
        this.presence = null;
        return { ok: true };
      }
      if (method === 'set_watch_notify') {
        const mode = String(args[0] ?? 'panel');
        if (!['off', 'panel', 'chat'].includes(mode)) return { ok: false, error: '只有 off / panel / chat。' };
        this.persist({ watchNotify: mode });
        return { ok: true, watchNotify: mode };
      }
      if (method === 'nudge') {
        await this.push(
          'stroll.due',
          `主人叫你现在去逛一圈。今天还剩：${this.policy.summary()}。\n想逛就调 stroll action=brief（一次拿全，别连续 status/feed/inbox）；不想去就回「今天不逛」。`,
          { manual: true },
          'flush',
        );
        return { ok: true, message: '叫她了。' };
      }
      if (method === 'watch_start') {
        const url = String(args[0] ?? '').trim();
        if (!url) return { ok: false, error: '给个要一起看的链接。' };
        return await this.watchStart(url);
      }
      if (method === 'watch_stop') return await this.watchStop();
      if (method === 'watch_status') return await this.watchStatus();
      if (method === 'quick_like') return await this.quickAct('like', '', String(args[0] ?? ''));
      if (method === 'quick_unlike') return await this.quickAct('unlike', '', String(args[0] ?? ''));
      if (method === 'quick_comment') {
        const text = clampText(String(args[0] ?? ''), Number(this.cfg.commentMaxChars ?? 120));
        if (!text) return { ok: false, error: '评论要有正文。' };
        return await this.quickAct('comment', text, String(args[1] ?? ''));
      }
      if (method === 'quick_follow') return await this.quickAct('follow', '', String(args[0] ?? ''));
      if (method === 'login') return await this.login(String(args[0] ?? 'douyin'));
      if (method === 'dm_me') {
        // 主人自己点的「B站私信我」：不发公开内容、不占额度，就是验证链路通不通
        const text = String(args[0] ?? '').trim() || '在的，看到这条就说明私信通了。';
        const platform = String(args[1] ?? 'bilibili') === 'douyin' ? 'douyin' : 'bilibili';
        if (platform === 'douyin') {
          if (!this.cfg.douyin) return { ok: false, error: '抖音关着。' };
          const owner = await this.ensureDouyinOwner();
          if (!owner.ok) return owner;
          if (this.douyinOwner().sameAsSelf) {
            return {
              ok: false,
              error: `你绑的抖音号（${owner.name || `…${owner.secUid.slice(-8)}`}）就是她现在登录的那个号，抖音不能给自己发私信。给她换一个号登录，或者只把她当「面板里能发」用。`,
            };
          }
          try {
            await this.douyin.dm(owner.secUid, cutChars(text, 300));
            this.store.addAction({
              platform: 'douyin',
              action: 'dm',
              target: owner.secUid,
              title: `私信主人${owner.name ? `（${owner.name}）` : ''}`,
              text: cutChars(text, 300),
              result: 'ok',
              extra: { by: 'owner', test: true },
            });
            this.store.save();
            return { ok: true, message: '抖音私信发出去了。去抖音「消息 → 私信」看看收到没有。' };
          } catch (error) {
            return { ok: false, code: error?.code ?? 'ERROR', error: error?.message ?? String(error) };
          }
        }
        const uid = this.ownerId('bilibili');
        if (!uid) return { ok: false, error: '先在设置里填主人 B站 UID。' };
        if (!this.cfg.bilibili) return { ok: false, error: 'B站关着。' };
        try {
          const sent = await this.bili.dm(uid, cutChars(text, 200));
          this.store.addAction({
            platform: 'bilibili',
            action: 'dm',
            target: uid,
            title: '私信主人',
            text: cutChars(text, 300),
            result: 'ok',
            extra: { by: 'owner', test: true },
          });
          this.store.save();
          return {
            ok: true,
            message: `私信发出去了（msg_key ${sent.msgKey || '—'}）。去 B站「消息 → 私信」看看收到没有。`,
            msgKey: sent.msgKey,
          };
        } catch (error) {
          return { ok: false, code: error?.code ?? 'ERROR', error: error?.message ?? String(error) };
        }
      }
      if (method === 'logout_bili') return await this.logoutBili();
      if (method === 'logout_douyin') return await this.logoutDouyin();
      if (method === 'bind_douyin_owner') {
        // 传内容 = sec_uid / 主页链接 / 抖音号，解析后存回配置
        const input = String(args[0] ?? '').trim();
        if (!input) return { ok: false, error: '要绑哪个号？给 sec_uid、主页链接或抖音号。' };
        try {
          const got = await this.douyin.resolveOwner(input);
          this.persist({ ownerDouyin: got.secUid });
          this.store.data.douyinOwner = { secUid: got.secUid, name: got.name ?? '', at: Date.now(), source: got.source };
          this.store.save();
          return {
            ok: true,
            secUid: got.secUid,
            name: got.name ?? '',
            sameAsSelf: this.douyinOwner().sameAsSelf,
            unverified: got.unverified === true,
            message: `已绑定${got.name ? `「${got.name}」` : ''}（sec_uid …${got.secUid.slice(-8)}）。${
              got.unverified ? '注意：没在主页上核到抖音号，是按同名搜出来的，发私信前最好对一眼是不是本人。' : ''
            }`,
          };
        } catch (error) {
          return { ok: false, code: error?.code ?? 'ERROR', error: error?.message ?? String(error) };
        }
      }
      if (method === 'douyin_self') return await this.douyinSelf();
      if (method === 'refreshBili') {
        return await this.bili.importFromContext(this.douyin.context);
      }
      return { ok: false, error: `不认识的方法：${method}` };
    } catch (error) {
      return { ok: false, code: error?.code ?? 'ERROR', error: error?.message ?? String(error) };
    }
  }

  /** 下一次自动出门大概什么时候；今天用完或关着就返回 null。 */
  autoNextView() {
    const daily = Number(this.cfg.autoSessionsPerDay ?? 0);
    if (daily <= 0 || !this.cfg.enabled) return null;
    const budgetCap = Math.max(0, Math.floor(Number(this.cfg.tokenDailyBudget ?? DEFAULTS.tokenDailyBudget) / 1500));
    const cap = Math.min(daily, budgetCap);
    const day = dayKey(new Date(), this.timeZone);
    const used = Number(this.store.data.autoSessions[day] ?? 0);
    if (used >= cap) return { done: true, used, cap };
    const last = Number(this.store.data.lastAutoAt ?? this.store.data.lastSessionAt ?? 0);
    // tick 里有 40% 概率跳过（Math.random() > 0.6 才出门），按期望 1/0.6 折算，
    // 不然显示的时间永远比实际早一截
    const gap = this.autoGapMs() / 0.6;
    let at = last ? last + gap : Date.now() + 90 * 1000;
    at = this.nextOutingWindow(Math.max(at, Date.now()));
    return { done: false, used, cap, gapMinutes: Math.round(this.autoGapMs() / 60000), at };
  }

  /** 自动出门只在 9:00-23:00；落在窗外就推到下一个 9:00。 */
  nextOutingWindow(ts) {
    const d = new Date(ts);
    const h = d.getHours();
    if (h < 9) d.setHours(9, 0, 0, 0);
    else if (h >= 23) {
      d.setDate(d.getDate() + 1);
      d.setHours(9, 0, 0, 0);
    }
    return d.getTime();
  }

  /** 两次自动出门之间的最小间隔（毫秒）。 */
  autoGapMs() {
    return clamp(Number(this.cfg.autoGapMinutes ?? 90), 30, 360) * 60 * 1000;
  }

  /** 这条动作针对的内容叫什么；老记录没有标题，就从「看过」里补。 */
  titleOf(platform, target) {
    const raw = String(target ?? '');
    if (!raw) return '';
    const id = raw.replace(/^(dyn|cv):/i, '');
    if (this.lastOpen && this.lastOpen.platform === platform && String(this.lastOpen.id) === id) {
      return this.lastOpen.title || '';
    }
    const hit = (this.store.data.viewed ?? []).find((v) => v.platform === platform && String(v.id) === id);
    return hit?.title || '';
  }

  /** 把一条动作记录补成面板能直接渲染的样子。 */
  describeAction(entry) {
    return {
      action: entry.action,
      platform: entry.platform,
      kind: entry.kind || kindOfTarget(entry.target),
      target: entry.target ?? '',
      text: entry.text ?? '',
      title: entry.title || this.titleOf(entry.platform, entry.target),
      result: entry.result ?? 'ok',
      at: entry.at,
      url: actionUrl(entry),
    };
  }

  /** 今天某个额度项下具体做了什么：评论原文、点赞/稍后再看的视频名、关注了谁。 */
  usageDetail(key) {
    const wanted = METER_ACTIONS[key] ?? [key];
    const today = dayKey(new Date(), this.timeZone);
    const items = this.store.data.actions
      .filter((a) => wanted.includes(a.action) && dayKey(new Date(a.at), this.timeZone) === today)
      .slice(-60)
      .reverse()
      .map((a) => this.describeAction(a));
    const cap = this.policy.cap(key)?.daily ?? 0;
    return { ok: true, key, label: ACTION_NAMES[key] ?? key, items, day: today, cap };
  }

  /** 全部动作；面板「最近」点开看全部时用。 */
  timelineItems(n = 60) {
    return this.store.lastActions(clamp(Number(n) || 60, 6, 120)).map((a) => this.describeAction(a));
  }

  /** 当前额度最接近哪一档；都不像就是 custom。 */
  activityKey() {
    for (const [key, preset] of Object.entries(ACTIVITY_PRESETS)) {
      const same = Object.entries(preset).every(([k, v]) => k === 'label' || Number(this.cfg[k] ?? 0) === Number(v));
      if (same) return key;
    }
    return 'custom';
  }

  /** 主人手动清零今天的计数（测试/误操作后不用等第二天）。 */
  resetToday() {
    const day = dayKey(new Date(), this.timeZone);
    this.store.data.usage[day] = {};
    this.store.data.lastWriteAt = 0;
    // 顺带清掉「今天做过了」的去重键，不然清零后还是评不了同一条
    const keep = {};
    for (const [key, at] of Object.entries(this.store.data.seen ?? {})) {
      if (/^(bilibili|douyin):(like|unlike|comment|reply|follow|unfollow|post|dm|save):/.test(key)) continue;
      keep[key] = at;
    }
    this.store.data.seen = keep;
    this.store.save();
    return { ok: true, day, usage: this.policy.snapshot().usage };
  }

  /** 近 7 天的动作数（写动作按 usage 汇总，读按 readDays），给面板画小柱子。 */
  weekBars() {
    const out = [];
    const now = new Date();
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 86400000);
      const key = dayKey(d, this.timeZone);
      const used = Object.values(this.store.data.usage?.[key] ?? {}).reduce((a, b) => a + Number(b ?? 0), 0);
      out.push({
        day: key.slice(5),
        weekday: ['日', '一', '二', '三', '四', '五', '六'][d.getDay()],
        actions: used,
        reads: Number(this.store.data.readDays?.[key] ?? 0),
        today: i === 0,
      });
    }
    return out;
  }

  async panelStatus() {
    const status = await this.compactStatus();
    return {
      ok: true,
      status,
      drafts: this.store.pendingDrafts().map((d) => ({
        id: d.id,
        action: d.action,
        platform: d.platform,
        preview: this.previewText(d),
        ageSec: d.ageSec,
      })),
      recent: this.store.lastActions(10).map((x) => this.describeAction(x)),
      recentTotal: this.store.data.actions.length,
      risk: this.store.data.risk,
      policy: this.policyView(),
      lastOpen: this.lastOpen,
      presence: this.presenceView(),
      activity: this.activityKey(),
      watchNotify: String(this.cfg.watchNotify ?? 'panel'),
      inboxUnread: (this.inboxCache ?? []).filter((x) => !this.store.seenAt(`msg:${x.id}`)).length,
      inboxCount: (this.inboxCache ?? []).length,
      todayReads: this.store.readsToday(),
      viewed: this.store.viewedList(6),
      following: this.followFeedView(4),
      weekly: this.weeklyReport(7),
      books: this.bookView(),
      week: this.weekBars(),
      autoSessions: Number(this.store.data.autoSessions[dayKey(new Date(), this.timeZone)] ?? 0),
      autoNext: this.autoNextView(),
      mustDo: this.mustDoList(),
      stats: this.store.data.stats,
      config: {
        background: this.cfg.background !== false,
        approval: this.cfg.approval,
        autoSessionsPerDay: Number(this.cfg.autoSessionsPerDay ?? 0),
        dailyLikes: Number(this.cfg.dailyLikes ?? 0),
        dailyComments: Number(this.cfg.dailyComments ?? 0),
        dailyFollows: Number(this.cfg.dailyFollows ?? 0),
        dailyPosts: Number(this.cfg.dailyPosts ?? 0),
        dailySaves: Number(this.cfg.dailySaves ?? 0),
        watchSpeakSec: Number(this.cfg.watchSpeakSec ?? 60),
        tokenDailyBudget: Number(this.cfg.tokenDailyBudget ?? DEFAULTS.tokenDailyBudget),
        mustLike: this.cfg.mustLike === true,
        mustComment: this.cfg.mustComment === true,
        mustFollow: this.cfg.mustFollow === true,
        mustPost: this.cfg.mustPost === true,
        commentMaxChars: Number(this.cfg.commentMaxChars ?? 120),
        newAccountRamp: this.cfg.newAccountRamp !== false,
      },
      watch: this.watch
        ? {
            watching: true,
            title: this.watch.title,
            url: this.watch.url,
            platform: this.watch.platform,
            startedAt: new Date(this.watch.startedAt).toISOString(),
            time: this.watch.last?.time ?? null,
            duration: this.watch.last?.duration ?? null,
          }
        : { watching: false },
    };
  }
}

/** "5:59" / "1:02:03" → 秒；拿不到就 0。 */
function clockToSeconds(text) {
  const parts = String(text ?? '')
    .split(':')
    .map((x) => Number(x));
  if (!parts.length || parts.some((n) => !Number.isFinite(n))) return 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/** 昵称的占位值不能当人名：页面没渲染完时 h1 会读到「未登录」「抖音」。 */
function cleanNick(value) {
  const s = String(value ?? '').trim();
  if (!s) return '';
  if (/^(未登录|登录|抖音|Douyin|验证|加载中)/i.test(s)) return '';
  return [...s].length > 24 ? [...s].slice(0, 24).join('') : s;
}

function clamp(n, min, max) {
  const v = Number(n);
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, Math.round(v)));
}

/** 把动作记录里的 target（BV 号 / 动态 ID / 专栏 ID / 抖音 ID / UID）还原成能打开的网页。 */
function actionUrl(entry) {
  const target = String(entry?.target ?? '').trim();
  if (!target) return '';
  const kind = entry.kind || kindOfTarget(target);
  const bare = target.replace(/^(dyn|cv):/i, '');
  if (entry.platform === 'bilibili') {
    if (kind === 'opus') return `https://t.bilibili.com/${bare}`;
    if (kind === 'article') return `https://www.bilibili.com/read/cv${bare}`;
    if (/^(BV[0-9A-Za-z]{10}|av\d+)$/i.test(target)) return `https://www.bilibili.com/video/${target}`;
    if (/^\d{5,20}$/.test(target)) return `https://space.bilibili.com/${target}`;
  }
  if (entry.platform === 'douyin' && /^\d{10,24}$/.test(target)) return `https://www.douyin.com/video/${target}`;
  return '';
}

/** 从 target 前缀猜它是视频、动态还是专栏；老记录没有 kind 时用。 */
function kindOfTarget(target) {
  const text = String(target ?? '');
  if (/^dyn:/i.test(text)) return 'opus';
  if (/^cv:/i.test(text)) return 'article';
  return 'video';
}
