import { clamp, dayKey, hourOf, weekKey } from './util.js';

const ACTION_CAPS = {
  like: { daily: 'dailyLikes', weeklyFactor: 4, weeklyMax: 120, label: '赞' },
  comment: { daily: 'dailyComments', weeklyFactor: 4, weeklyMax: 40, label: '评' },
  follow: { daily: 'dailyFollows', weeklyFactor: 3, weeklyMax: 12, label: '关' },
  post: { daily: 'dailyPosts', weeklyFactor: 3, weeklyMax: 6, label: '发' },
  dm: { daily: 'dailyDms', weeklyFactor: 4, weeklyMax: 12, label: '私' },
  save: { daily: 'dailySaves', weeklyFactor: 4, weeklyMax: 40, label: '存' },
};

export class Policy {
  constructor({ store, cfg, timeZone, now = () => new Date() }) {
    this.store = store;
    this.cfg = cfg;
    this.timeZone = timeZone;
    this.now = now;
  }

  /** 新号保护：第 1-3 天 50%，4-7 天 80%，之后 100%。老号可以直接关掉。 */
  rampFactor() {
    if (!this.cfg.newAccountRamp) return 1;
    const installed = Date.parse(this.store.data.installedAt);
    if (!Number.isFinite(installed)) return 1;
    const days = Math.floor((Date.now() - installed) / 86400000);
    if (days < 3) return 0.5;
    if (days < 7) return 0.8;
    return 1;
  }

  cap(action) {
    const meta = ACTION_CAPS[action];
    if (!meta) return 0;
    const raw = Number(this.cfg[meta.daily] ?? 0);
    const factor = this.rampFactor();
    const daily = raw > 0 ? Math.max(1, Math.floor(raw * factor)) : 0;
    const weekly = raw > 0 ? Math.min(meta.weeklyMax, Math.max(daily, Math.floor(raw * meta.weeklyFactor * factor))) : 0;
    return { daily, weekly };
  }

  remaining(action) {
    const { daily, weekly } = this.cap(action);
    return {
      daily: Math.max(0, daily - this.store.usage(action)),
      weekly: Math.max(0, weekly - this.store.weekUsage(action)),
      dailyCap: daily,
      weeklyCap: weekly,
    };
  }

  isQuiet() {
    const hour = hourOf(this.now(), this.timeZone);
    const from = Number(this.cfg.quietFrom);
    const to = Number(this.cfg.quietTo);
    if (from === to) return false;
    return from < to ? hour >= from && hour < to : hour >= from || hour < to;
  }

  /** 风控拦截的力度：off 只记账不拦人，light 只在验证码时停，strict 是旧的长时间冷却。 */
  guard() {
    const v = String(this.cfg.riskGuard ?? 'off').toLowerCase();
    return v === 'light' || v === 'strict' ? v : 'off';
  }

  /** 主人刚点过单（私信/面板）的窗口：这期间她做的事算「主人让的」，不套出门节奏。 */
  ownerActive() {
    return Date.now() - Number(this.store.data.ownerAskAt ?? 0) < 180 * 1000;
  }

  paused() {
    const until = Number(this.store.data.risk.until ?? 0);
    if (until <= Date.now()) return { paused: false };
    const reason = this.store.data.risk.reason || '风控冷却中';
    // 主人自己拉的手刹永远算数
    if (String(this.store.data.risk.lastCode ?? '') === 'MANUAL') return { paused: true, until, reason };
    const guard = this.guard();
    if (guard === 'off') return { paused: false };
    // light：只有验证码/封禁这种「再试也没用」的才停；频率限流一律放行
    if (guard === 'light' && !/验证|captcha|verify|封禁|ban|异常|-352|-799/i.test(reason)) return { paused: false };
    return { paused: true, until, reason };
  }

  /** 公开动作总闸。userInitiated 是你亲手点的：只做防连点，不再按节奏拦。 */
  check(action, platform, target, { userInitiated = false, quotaAction = action, dedupeKey = '', free = false } = {}) {
    if (!this.cfg.enabled) return { ok: false, code: 'DISABLED', message: '摸鱼已停用。' };
    if (platform === 'bilibili' && !this.cfg.bilibili) return { ok: false, code: 'PLATFORM_OFF', message: 'B站这边关着。' };
    if (platform === 'douyin' && !this.cfg.douyin) return { ok: false, code: 'PLATFORM_OFF', message: '抖音这边关着。' };
    if (this.cfg.approval === 'dry_run') return { ok: false, code: 'DRY_RUN', message: '现在是只读模式，动作只会进草稿箱。' };

    // 这里原来不看风控，一律拒。现在 paused() 自己按 riskGuard 决定要不要拦：
    // 默认 off 模式下频率限流不再堵任何动作（连试都不用试的那种验证码才拦）。
    const paused = this.paused();
    if (paused.paused) {
      // 给主人的私信永远放行：风控冷却挡的是「她自己出门互动」，不该连主人的话都不回。
      if (!free) {
        return { ok: false, code: 'RISK_PAUSE', message: `先歇着：${paused.reason}。到 ${new Date(paused.until).toLocaleString('zh-CN')} 再说。` };
      }
    }

    // 安静时段只拦「自己出门」，不拦主人当场让它做的事。
    const meta = ACTION_CAPS[quotaAction];
    if (!meta) return { ok: false, code: 'UNKNOWN_ACTION', message: '不认识这个动作。' };

    // free：只发给主人的私信不限额，也不做去重（不然一天只能发一条）
    if (!free) {
      const left = this.remaining(quotaAction);
      if (left.daily <= 0) return { ok: false, code: 'DAILY_CAP', message: `今天的「${meta.label}」额度用完了（${left.dailyCap}）。` };
      if (left.weekly <= 0) return { ok: false, code: 'WEEKLY_CAP', message: `这周的「${meta.label}」额度用完了（${left.weeklyCap}）。` };
    }

    // 三档节奏：
    //   free（回主人私信） 0.5 秒，只盖住「一次发送本身的耗时」，纯粹防重发
    //   主人点单         1.5 秒，只防连点 —— 以前这里漏判，导致「回完私信马上评论」
    //                    永远撞 90 秒的 TOO_FAST，表现就是每次评论都要等一两分钟
    //   自己出门         minGapSeconds（默认 20 秒）
    const asked = userInitiated || this.ownerActive();
    const minGap = Math.max(5, Number(this.cfg.minGapSeconds ?? 20));
    const sincePlat = Date.now() - Number((this.store.data.lastWriteByPlat ?? {})[platform] ?? 0);
    const sinceAny = Date.now() - Number(this.store.data.lastWriteAt ?? 0);
    const sinceChat = Date.now() - Number(this.store.data.lastChatAt ?? 0);
    const gap = free ? 500 : asked ? 1500 : minGap * 1000;
    const since = free ? sinceChat : asked ? Math.min(sincePlat, sinceAny) : sinceAny;
    if (since < gap) {
      return {
        ok: false,
        code: 'TOO_FAST',
        message: asked || free
          ? `刚发过一次，等 ${Math.max(1, Math.ceil((gap - since) / 1000))} 秒再说，别连点。`
          : `上一次动作才过去 ${Math.round(since / 1000)} 秒，再等等（至少 ${Math.round(gap / 1000)} 秒）。`,
      };
    }

    if (!free && (target || dedupeKey)) {
      const key = dedupeKey || `${platform}:${action}:${target}`;
      const seen = this.store.seenAt(key);
      const windowMs = action === 'comment' || action === 'reply' ? 7 * 86400000 : 24 * 3600 * 1000;
      if (seen && Date.now() - seen < windowMs) {
        return {
          ok: false,
          code: 'DUPLICATE',
          message: action === 'comment' || action === 'reply' ? '这一条七天内已经回过/评过了，不重复。' : '这个对象今天已经做过同样的动作了，不重复。',
        };
      }
    }

    return { ok: true };
  }

  /** 动作成功后记账。调用方必须在平台确认成功后才会走到这里。 */
  consume(action, platform, target, detail = {}) {
    if (detail.countQuota !== false) this.store.bump(detail.quotaAction ?? action);
    for (const tag of detail.tags ?? []) this.store.noteInterest([tag]);
    // markSeen:false 用于「平台没给确认」：既没扣额度，也不该把重试挡成 DUPLICATE
    if (detail.markSeen !== false) {
      if (detail.dedupeKey) this.store.markSeen(detail.dedupeKey);
      else if (target) this.store.markSeen(`${platform}:${action}:${target}`);
    }
    const at = Date.now();
    if (detail.free) {
      // 回主人私信只算「聊天」，不占公开动作的节奏位：
      // 不然刚回完一句私信，紧接着要评论就得干等（以前就是 90 秒）
      this.store.data.lastChatAt = at;
    } else {
      this.store.data.lastWriteAt = at;
      this.store.data.lastWriteByPlat = { ...(this.store.data.lastWriteByPlat ?? {}), [platform]: at };
    }
    this.store.addAction({
      platform,
      action,
      target: String(target ?? '').slice(0, 200),
      kind: detail.kind ?? '',
      title: String(detail.title ?? '').slice(0, 160),
      text: String(detail.text ?? '').slice(0, 300),
      result: detail.result ?? 'ok',
      extra: detail.extra ?? undefined,
    });
    this.store.save();
  }

  noteRead(platform, detail = {}) {
    this.store.data.lastSessionAt = Date.now();
    if (!this.store.data.stats.opens) this.store.data.stats.opens = 0;
    if (detail.open) {
      this.store.data.stats.opens += 1;
      const day = dayKey(new Date(), this.store.timeZone);
      this.store.data.readDays ??= {};
      this.store.data.readDays[day] = Number(this.store.data.readDays[day] ?? 0) + 1;
    }
    this.store.save();
  }

  /**
   * 平台风控信号。
   * 默认 riskGuard=off：**只记账，不暂停**。频率限流（-509/429）本来就是几十分钟自己好的，
   * 停掉全部动作只会把主人当场点的事一起埋了——之前评论发不出去、要等一两个小时就是这么来的。
   * 真被验证码/封号挡住时平台自己会报错，她会如实告诉主人。
   * light：只有验证码/封禁这种「再试也没用」的才停 30 分钟。strict：旧的 48h/24h 分档。
   */
  noteRisk(code, message) {
    const text = `${code ?? ''} ${message ?? ''}`.toLowerCase();
    const verify = /验证|captcha|verify|异常|封禁|ban|-352|-799/.test(text);
    const rate = /429|-509|请求过于频繁|操作频繁|访问过于频繁|rate/.test(text);
    const guard = this.guard();
    const before = Number(this.store.data.risk.strikes ?? 0);
    const strikes = rate ? before + 1 : before;

    let hours = 0;
    if (guard === 'strict') {
      hours = Number(this.cfg.riskPauseHours ?? 48);
      // 分档按「这次之前撞过几次」算：第 1 次 30 分钟，第 2 次 2 小时，之后 6 小时封顶
      if (rate) hours = before >= 2 ? 6 : before === 1 ? 2 : 0.5;
      else if (/412|-412/.test(text)) hours = Math.max(12, hours);
      else if (verify) hours = Math.max(24, hours);
      else if (/登录|login|-101|未登录/.test(text)) hours = 0;
    } else if (guard === 'light' && verify) {
      // 30 分钟够主人去处理一次验证码，也不至于把一整天埋掉
      hours = 0.5;
    }

    const until = hours > 0 ? Date.now() + hours * 3600 * 1000 : 0;
    this.store.setRisk(until, `${code ?? ''} ${message ?? ''}`.trim().slice(0, 160), String(code ?? ''));
    // setRisk 自己会把 strikes +1，这里以算好的值为准
    this.store.data.risk.strikes = strikes;
    this.store.addAction({
      platform: 'system',
      action: 'risk',
      target: '',
      text: this.store.data.risk.reason,
      result: hours > 0 ? 'paused' : 'noted',
    });
    this.store.save();
    return { until, hours, reason: this.store.data.risk.reason, guard };
  }

  /** 给 ENV_PROMPT 的一行摘要。 */
  summary() {
    const label = Object.fromEntries(Object.entries(ACTION_CAPS).map(([k, v]) => [k, v.label]));
    const parts = Object.keys(ACTION_CAPS)
      .map((action) => {
        const left = this.remaining(action);
        return `${label[action]}${this.store.usage(action)}/${left.dailyCap}`;
      })
      .join(' ');
    const paused = this.paused();
    const risk = paused.paused ? `停到 ${new Date(paused.until).toLocaleString('zh-CN')}` : '正常';
    const approval = { confirm: '全批准', auto_low_risk: '赞自动', auto_all: '按额度', dry_run: '只读' }[this.cfg.approval] ?? this.cfg.approval;
    return `今日 ${parts} · 风险 ${risk} · 审批 ${approval}`;
  }

  /** 给面板的完整计数。 */
  snapshot() {
    const usage = {};
    const caps = {};
    for (const action of Object.keys(ACTION_CAPS)) {
      usage[action] = this.store.usage(action);
      caps[action] = this.remaining(action).dailyCap;
    }
    return {
      day: dayKey(this.now(), this.timeZone),
      week: weekKey(this.now(), this.timeZone),
      usage,
      caps,
      quiet: this.isQuiet(),
      paused: this.paused(),
      ramp: this.rampFactor(),
      approval: this.cfg.approval,
      summary: this.summary(),
    };
  }
}

export const ACTION_LABELS = Object.fromEntries(
  Object.entries(ACTION_CAPS).map(([k, v]) => [k, v.label]),
);

/** 审批矩阵：点赞可自动，公开文字/关注/私信默认要人点头。 */
export function approvalFor(cfg, action) {
  if (cfg.approval === 'dry_run') return 'draft';
  if (cfg.approval === 'auto_all') return 'auto';
  if (cfg.approval === 'auto_low_risk' && (action === 'like' || action === 'unlike')) return 'auto';
  if (action === 'save' && cfg.allowSave) return 'auto';
  // 私信主人不是公开动作，也不给别人看：等批准的话「主人一发消息就能回」就成了空话
  if (action === 'dm' && cfg.allowDm) return 'auto';
  return 'draft';
}

export function clampText(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return [...s].slice(0, clamp(max, 20, 500)).join('');
}
