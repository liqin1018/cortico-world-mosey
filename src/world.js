import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { Policy, approvalFor, clampText } from './policy.js';
import { Bilibili } from './bilibili.js';
import { DouyinBrowser } from './douyin.js';
import { TOOL_DECLS, EVENT_DECLS } from './tools.js';
import { CONFIG_GROUPS, validatePolicyPatch } from './config.js';
import {
  dayKey,
  hourOf,
  nowIso,
  openInBrowser,
  parseBvid,
  parseCvid,
  parseDouyinId,
  parseDynamicId,
  platformUrl,
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
  quiet: { label: '安静', dailyLikes: 4, dailyComments: 1, dailyFollows: 0, dailyPosts: 0, dailyDms: 1, dailySaves: 2, autoSessionsPerDay: 1, autoGapMinutes: 300, tokenDailyBudget: 3000 },
  normal: { label: '日常', dailyLikes: 10, dailyComments: 4, dailyFollows: 2, dailyPosts: 1, dailyDms: 2, dailySaves: 5, autoSessionsPerDay: 3, autoGapMinutes: 150, tokenDailyBudget: 6000 },
  lively: { label: '活跃', dailyLikes: 16, dailyComments: 6, dailyFollows: 3, dailyPosts: 2, dailyDms: 3, dailySaves: 8, autoSessionsPerDay: 5, autoGapMinutes: 90, tokenDailyBudget: 9000 },
  chatty: { label: '话痨', dailyLikes: 24, dailyComments: 10, dailyFollows: 5, dailyPosts: 3, dailyDms: 4, dailySaves: 10, autoSessionsPerDay: 8, autoGapMinutes: 60, tokenDailyBudget: 15000 },
};
const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

export class StrollWorld {
  constructor({ cfg, timezone, dataDir, persist, log }) {
    this.id = 'stroll';
    this.cfg = cfg;
    this.timeZone = timezone || 'Asia/Shanghai';
    this.dataDir = dataDir;
    this.persist = persist;
    this.log = log;
    this.host = null;
    this.store = new Store(path.join(dataDir, 'stroll'), this.timeZone).load();
    this.store.data.autoSessions ??= {};
    this.policy = new Policy({ store: this.store, cfg, timeZone: this.timeZone });
    this.bili = new Bilibili({ dataDir, cfg, log, policy: this.policy, store: this.store });
    this.douyin = new DouyinBrowser({ dataDir, cfg, log, policy: this.policy });
    this.timer = null;
    this.lastStatus = null;
    this.lastStatusAt = 0;
    this.lastImportAt = 0;
    this.lastOpen = null;
    this.inboxCache = [];
    this.presence = null;
    this.lastPresenceNotify = 0;
    this.watch = null;
    this.watchTimer = null;
    this.lastWatchPush = 0;
    this.running = false;
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
  }

  async stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stopWatchTimer();
    await this.douyin.close().catch(() => {});
    this.store.save();
  }

  async tick() {
    if (!this.running || !this.cfg.enabled) return;
    if (this.cfg.autoSessionsPerDay <= 0) return;
    const hour = hourOf(new Date(), this.timeZone);
    if (hour < 9 || hour >= 23) return;
    if (this.policy.isQuiet() || this.policy.paused().paused) return;
    const day = dayKey(new Date(), this.timeZone);
    const used = Number(this.store.data.autoSessions[day] ?? 0);
    const budgetCap = Math.max(0, Math.floor(Number(this.cfg.tokenDailyBudget ?? 6000) / 1500));
    const cap = Math.min(Number(this.cfg.autoSessionsPerDay), budgetCap);
    if (used >= cap) return;
    // 用 lastAutoAt 而不是 lastSessionAt：主人手动让她看东西，不该把自动出门往后推
    const lastAuto = Number(this.store.data.lastAutoAt ?? this.store.data.lastSessionAt ?? 0);
    if (Date.now() - lastAuto < this.autoGapMs()) return;
    if (Math.random() > 0.6) return;
    this.store.data.lastAutoAt = Date.now();
    this.store.data.autoSessions[day] = used + 1;
    this.store.save();
    await this.push(
      'stroll.due',
      `该出门溜达了。今天还剩：${this.policy.summary()}。\n想逛就调 stroll action=brief（一次拿全，别连续 status/feed/inbox）；不想去就回「今天不逛」。`,
      { day, used: used + 1 },
      'debounce',
    );
  }

  async push(type, text, meta = {}, trigger = 'debounce') {
    if (!this.host) return;
    try {
      await this.host.pushEvent(
        {
          type,
          source: this.id,
          ts: nowIso(this.timeZone),
          text,
          senderKey: `stroll:${type}`,
          origin: 'internal',
          meta,
        },
        { trigger },
      );
    } catch (error) {
      this.log?.warn?.('stroll push failed', { type, message: error?.message });
    }
  }

  /* ---------------- prompt ---------------- */

  envPromptVars() {
    const owner = this.cfg.ownerUid
      ? `主人 B站 UID ${this.cfg.ownerUid}${this.cfg.ownerName ? `（${this.cfg.ownerName}）` : ''}`
      : '还没设主人 UID（@ 和私信要它）';
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
      const url = String(args.url ?? args.id ?? '').trim();
      if (!url) return JSON.stringify({ ok: false, error: '给个 B站视频/动态/专栏链接。' });
      const data = await this.bili.commentsOf(url, clamp(args.n ?? 10, 1, 20));
      return JSON.stringify({ ok: true, ...data });
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
    if (action === 'read') return JSON.stringify(this.readBook({ name: args.book, chars: args.chars }));
    if (action === 'note') return JSON.stringify(this.noteBook(args.text));
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
    const plan = await this.buildPlan(action, args);
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
      owner: { uid: this.cfg.ownerUid || '', name: this.cfg.ownerName || '' },
      pending: this.store.pendingDrafts().map((d) => ({ id: d.id, action: d.action, platform: d.platform, preview: this.previewText(d) })),
      last: this.store.lastActions(3),
      interests: this.store.topInterests(6),
      autoSessions: this.store.data.autoSessions[dayKey()] ?? 0,
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
    return { ok: true, platform: p, items: items.map(({ _score, ...rest }) => rest) };
  }

  async readOpen(args) {
    const raw = String(args.url ?? args.id ?? '').trim();
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

  async inbox(platform, n) {
    const p = platform === 'douyin' || platform === 'bilibili' ? platform : 'bilibili';
    if (p === 'bilibili') {
      if (!this.cfg.bilibili) return { ok: false, error: 'B站关着。' };
      const items = await this.bili.inbox(clamp(n ?? 6, 1, 8));
      if (items.length) this.inboxCache = items;
      return { ok: true, platform: p, items };
    }
    if (!this.cfg.douyin) return { ok: false, error: '抖音关着。' };
    return { ok: true, platform: p, items: await this.douyin.inbox(clamp(n ?? 5, 1, 8)) };
  }

  async login(platform) {
    if (platform === 'bilibili') {
      // 之前点过「退出登录」：先把窗口里残留的 cookie 清干净，保证这次是干净的二维码
      if (this.bili.isLoggedOut()) {
        if (!this.douyin.context) await this.douyin.launch({ headless: true }).catch(() => {});
        await this.douyin.clearCookiesMatching(/bilibili\.com$/i).catch(() => null);
        this.bili.markLoggedOut(false);
      }
      let info;
      try {
        info = await this.douyin.loginWindow('https://passport.bilibili.com/login');
      } catch (error) {
        return {
          ok: false,
          code: error?.code ?? 'BROWSER_LAUNCH',
          error: `登录窗没打开：${error?.message ?? String(error)}。多半是没装 Edge / Chrome，或者上次的窗口没退干净。`,
        };
      }
      // 扫码是异步的：后台轮询，登上了就把 cookie 收回来并关窗
      let tries = 0;
      const timer = setInterval(async () => {
        tries += 1;
        if (tries > 60 || !this.douyin.context) {
          clearInterval(timer);
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
      if (Number.isFinite(ts)) hours[new Date(ts + 8 * 3600000).getUTCHours()] += 1;
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
    const clock = (n) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
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

  async buildPlan(action, args) {
    const platform = this.inferPlatform(args.target ?? args.url ?? '', args.platform);
    const targetRaw = String(args.target ?? args.url ?? '').trim();
    const text = String(args.text ?? '').trim();
    const mentionOwner = args.mention_owner === true;

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
      const check = this.policy.check(action, platform, target, { quotaAction: 'like' });
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
      const check = this.policy.check(action, platform, target, { quotaAction: 'follow' });
      if (!check.ok) return check;
      return { ok: true, action, platform, target, text: '' };
    }

    if (action === 'save') {
      if (platform !== 'bilibili') return { ok: false, error: '稍后再看只有 B站。' };
      if (!this.cfg.allowSave) return { ok: false, error: '稍后再看关着。' };
      const bvid = parseBvid(targetRaw);
      if (!bvid) return { ok: false, error: '给个 BV 号/链接。' };
      const check = this.policy.check('save', platform, bvid, { quotaAction: 'save' });
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
        const check = this.policy.check(action, platform, target, { quotaAction: 'comment' });
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
      const check = this.policy.check(action, platform, target, { quotaAction: 'comment', dedupeKey });
      if (!check.ok) return check;
      return { ok: true, action, platform, target, text, mentionOwner, root, parent, kind, dynamicId, articleId, oid, commentType, dedupeKey };
    }

    if (action === 'post') {
      if (platform !== 'bilibili') return { ok: false, error: '抖音图文发布暂未开放；B站可以发纯文字动态。' };
      if (!this.cfg.allowPost) return { ok: false, error: '发动态关着。' };
      if ([...text].length < 4) return { ok: false, error: '正文太短。' };
      if ([...text].length > 2000) return { ok: false, error: '正文最多 2000 字。' };
      const check = this.policy.check('post', platform, 'dynamic', { quotaAction: 'post' });
      if (!check.ok) return check;
      return { ok: true, action, platform, target: 'dynamic', text, mentionOwner };
    }

    if (action === 'dm') {
      if (!this.cfg.allowDm) return { ok: false, error: '私信关着。' };
      if (!text) return { ok: false, error: '私信要有正文。' };
      let target;
      if (platform === 'bilibili') {
        const owner = String(this.cfg.ownerUid || '').trim();
        if (!owner) return { ok: false, error: '没设主人 B站 UID；先 stroll_policy set {"ownerUid":"..."}。' };
        target = String(targetRaw || owner).trim();
        if (target !== owner) return { ok: false, error: '私信只发主人，不发别人。' };
      } else {
        const owner = String(this.cfg.ownerDouyin || '').trim();
        if (!owner) return { ok: false, error: '没设主人抖音 sec_uid；先 stroll_policy set {"ownerDouyin":"MS4w..."}。' };
        target = String(targetRaw || owner).trim();
        if (target !== owner) return { ok: false, error: '私信只发主人，不发别人。' };
      }
      const check = this.policy.check('dm', platform, target, { quotaAction: 'dm' });
      if (!check.ok) return check;
      return { ok: true, action, platform, target, text };
    }

    return { ok: false, error: `不认识的动作：${action}` };
  }

  makeDraft(plan) {
    return this.store.addDraft({
      action: plan.action,
      platform: plan.platform,
      target: plan.target,
      kind: plan.kind ?? '',
      dynamicId: plan.dynamicId ?? '',
      articleId: plan.articleId ?? '',
      oid: plan.oid ?? '',
      commentType: plan.commentType ?? 0,
      dedupeKey: plan.dedupeKey ?? '',
      text: plan.text ?? '',
      mentionOwner: !!plan.mentionOwner,
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
          ? `给 ${draft.target}`
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
      action: draft.action,
      platform: draft.platform,
      target: draft.target,
      kind: draft.kind,
      dynamicId: draft.dynamicId,
      articleId: draft.articleId,
      oid: draft.oid,
      commentType: draft.commentType,
      dedupeKey: draft.dedupeKey,
      text: draft.text,
      mentionOwner: draft.mentionOwner,
      root: draft.root,
      parent: draft.parent,
    };
    const receipt = await this.executePlan(plan, source);
    this.store.closeDraft(id, receipt.ok ? 'sent' : receipt.code === 'WRITE_UNCERTAIN' ? 'unknown' : 'failed', {
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
          : await this.douyin.comment(target, text);
      } else if (action === 'post') {
        result = await this.bili.post({ text, mentionOwner: plan.mentionOwner });
      } else if (action === 'dm') {
        result = platform === 'bilibili' ? await this.bili.dm(target, text) : await this.douyin.dm(target, text);
      } else {
        return { ok: false, code: 'UNKNOWN_ACTION', error: '不认识的动作。' };
      }

      this.policy.consume(action, platform, target, {
        quotaAction: this.capAction(action),
        dedupeKey: plan.dedupeKey,
        text,
        title: this.titleOf(platform, target),
        kind: plan.kind ?? result?.kind,
        result: 'ok',
        extra: result,
        tags: plan.mentionOwner ? [] : [],
      });
      const receipt = { ok: true, action, platform, target, result, receipt: this.receiptText(action, platform, result) };
      if (source === 'operator') {
        await this.push('stroll.sent', `${this.receiptText(action, platform, result)}`, { action, platform, target }, 'flush');
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

  receiptText(action, platform, result) {
    const p = PLATFORM_NAMES[platform] ?? platform;
    if (action === 'like' || action === 'unlike') {
      const what = action === 'like' ? '点赞' : '取消赞';
      if (result?.already) return `${p} 已经是${what}后的状态，不用重复操作`;
      if (result?.confirmed === false) return `${p} ${what}请求发出去了，但平台没给确认`;
      return `${p} ${what}成功`;
    }
    if (action === 'comment' || action === 'reply') {
      if (platform === 'douyin' && result?.queued) return '抖音 评论发出去了，评论区暂时没刷出来，可能审核中';
    }
    if (action === 'comment' || action === 'reply') {
      const verb = action === 'reply' ? '回复' : '评论';
      const bits = [`${p} ${verb}发出去了`];
      if (result?.kind === 'opus') bits.push('动态');
      if (result?.kind === 'article') bits.push('专栏');
      if (result.rpid) bits.push(`rpid ${result.rpid}`);
      if (result.mentioned === true) bits.push('@ 已生效');
      if (result.mentioned === false) bits.push('@ 没生效');
      if (result.visibility === 'public') bits.push('公开可见');
      if (result.visibility === 'unknown') bits.push('公开列表暂未看到，可能审核中');
      return bits.join('，');
    }
    if (action === 'post') return `${p} 动态发出去了${result.dynamicId ? `（${result.dynamicId}）` : ''}`;
    if (action === 'dm') return `${p} 私信发出去了`;
    if (action === 'save') return '已加到 B站稍后再看';
    if (action === 'follow' || action === 'unfollow') return `${p} ${action === 'follow' ? '关注' : '取关'}完成`;
    return `${p} ${ACTION_NAMES[action] ?? action}完成`;
  }

  /* ---------------- policy view / webui ---------------- */

  policyView() {
    return {
      ok: true,
      enabled: this.cfg.enabled,
      approval: this.cfg.approval,
      owner: { uid: this.cfg.ownerUid, name: this.cfg.ownerName },
      platforms: { bilibili: this.cfg.bilibili, douyin: this.cfg.douyin },
      caps: this.policy.snapshot(),
      quiet: { from: this.cfg.quietFrom, to: this.cfg.quietTo },
      autoSessionsPerDay: this.cfg.autoSessionsPerDay,
      interests: this.cfg.interests,
      avoid: this.cfg.avoid,
      tokenDailyBudget: this.cfg.tokenDailyBudget,
      risk: this.store.data.risk,
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
        if (!this.cfg.bilibili) return { ok: true, items: [], counts: { all: 0, reply: 0, at: 0 }, unread: 0 };
        const items = await this.bili.inbox(clamp(Number(args[0] ?? 15), 1, 20));
        this.inboxCache = items;
        return {
          ok: true,
          items: items.map((x) => ({ ...x, fresh: !this.store.seenAt(`msg:${x.id}`) })),
          counts: {
            all: items.length,
            reply: items.filter((x) => x.kind === 'reply').length,
            at: items.filter((x) => x.kind === 'at').length,
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
      if (method === 'logout_bili') return await this.logoutBili();
      if (method === 'logout_douyin') return await this.logoutDouyin();
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
    const budgetCap = Math.max(0, Math.floor(Number(this.cfg.tokenDailyBudget ?? 9000) / 1500));
    const cap = Math.min(daily, budgetCap);
    const day = dayKey(new Date(), this.timeZone);
    const used = Number(this.store.data.autoSessions[day] ?? 0);
    if (used >= cap) return { done: true, used, cap };
    const last = Number(this.store.data.lastAutoAt ?? this.store.data.lastSessionAt ?? 0);
    const gap = this.autoGapMs();
    return { done: false, used, cap, gapMinutes: Math.round(gap / 60000), at: last ? last + gap : Date.now() + 90 * 1000 };
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
      stats: this.store.data.stats,
      config: {
        background: this.cfg.background !== false,
        approval: this.cfg.approval,
        autoSessionsPerDay: Number(this.cfg.autoSessionsPerDay ?? 0),
        dailyLikes: Number(this.cfg.dailyLikes ?? 0),
        dailyComments: Number(this.cfg.dailyComments ?? 0),
        dailyFollows: Number(this.cfg.dailyFollows ?? 0),
        dailyPosts: Number(this.cfg.dailyPosts ?? 0),
        dailyDms: Number(this.cfg.dailyDms ?? 0),
        dailySaves: Number(this.cfg.dailySaves ?? 0),
        watchSpeakSec: Number(this.cfg.watchSpeakSec ?? 60),
        tokenDailyBudget: Number(this.cfg.tokenDailyBudget ?? 6000),
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
