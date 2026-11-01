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

  paused() {
    const until = Number(this.store.data.risk.until ?? 0);
    if (until > Date.now()) {
      return { paused: true, until, reason: this.store.data.risk.reason || '风控冷却中' };
    }
    return { paused: false };
  }

  /** 公开动作总闸。userInitiated 是你亲手点的：只做防连点，不再按 90 秒节奏拦。 */
  check(action, platform, target, { userInitiated = false, quotaAction = action, dedupeKey = '' } = {}) {
    if (!this.cfg.enabled) return { ok: false, code: 'DISABLED', message: '摸鱼已停用。' };
    if (platform === 'bilibili' && !this.cfg.bilibili) return { ok: false, code: 'PLATFORM_OFF', message: 'B站这边关着。' };
    if (platform === 'douyin' && !this.cfg.douyin) return { ok: false, code: 'PLATFORM_OFF', message: '抖音这边关着。' };
    if (this.cfg.approval === 'dry_run') return { ok: false, code: 'DRY_RUN', message: '现在是只读模式，动作只会进草稿箱。' };

    const paused = this.paused();
    if (paused.paused) {
      return { ok: false, code: 'RISK_PAUSE', message: `先歇着：${paused.reason}。到 ${new Date(paused.until).toLocaleString('zh-CN')} 再说。` };
    }

    // 安静时段只拦「自己出门」，不拦主人当场让它做的事。
    const meta = ACTION_CAPS[quotaAction];
    if (!meta) return { ok: false, code: 'UNKNOWN_ACTION', message: '不认识这个动作。' };

    const left = this.remaining(quotaAction);
    if (left.daily <= 0) return { ok: false, code: 'DAILY_CAP', message: `今天的「${meta.label}」额度用完了（${left.dailyCap}）。` };
    if (left.weekly <= 0) return { ok: false, code: 'WEEKLY_CAP', message: `这周的「${meta.label}」额度用完了（${left.weeklyCap}）。` };

    // 手动点的动作只防连点；自动出门才需要完整的人类间隔
    const gap = userInitiated
      ? 2000
      : Math.max(30, Number(this.cfg.minGapSeconds ?? 90)) * 1000;
    const since = Date.now() - Number(this.store.data.lastWriteAt ?? 0);
    if (since < gap) {
      return {
        ok: false,
        code: 'TOO_FAST',
        message: userInitiated
          ? '刚发过一次，等两秒再点，别重复提交。'
          : `上一次动作才过去 ${Math.round(since / 1000)} 秒，再等等（至少 ${Math.round(gap / 1000)} 秒）。`,
      };
    }

    if (target || dedupeKey) {
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
    this.store.bump(detail.quotaAction ?? action);
    for (const tag of detail.tags ?? []) this.store.noteInterest([tag]);
    if (detail.dedupeKey) this.store.markSeen(detail.dedupeKey);
    else if (target) this.store.markSeen(`${platform}:${action}:${target}`);
    this.store.data.lastWriteAt = Date.now();
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

  /** 平台风控信号：立刻停写，不重试。 */
  noteRisk(code, message) {
    const text = `${code ?? ''} ${message ?? ''}`.toLowerCase();
    let hours = Number(this.cfg.riskPauseHours ?? 48);
    if (/412|429|-412|-352|-509|-799|频繁|rate/.test(text)) hours = Math.max(12, hours);
    if (/验证|captcha|verify|异常|封禁|ban/.test(text)) hours = Math.max(24, hours);
    if (/登录|login|-101|未登录/.test(text)) hours = 0;
    const until = hours > 0 ? Date.now() + hours * 3600 * 1000 : 0;
    this.store.setRisk(until, `${code ?? ''} ${message ?? ''}`.trim().slice(0, 160), String(code ?? ''));
    this.store.addAction({ platform: 'system', action: 'risk', target: '', text: this.store.data.risk.reason, result: 'paused' });
    this.store.save();
    return { until, hours, reason: this.store.data.risk.reason };
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
  return 'draft';
}

export function clampText(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return [...s].slice(0, clamp(max, 20, 500)).join('');
}
