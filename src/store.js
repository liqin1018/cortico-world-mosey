import fs from 'node:fs';
import path from 'node:path';
import { dayKey, randomCode, weekKey } from './util.js';

const MAX_ACTIONS = 300;
const MAX_DRAFTS = 30;
const MAX_SEEN = 2500;
const MAX_DAYS = 90;
/**
 * 旧草稿没有截止时间，保持创建后 30 分钟过期，不跟随设置变化。
 */
export const DRAFT_TTL_MS = 30 * 60_000;
/** 过期草稿留多久：够主人隔天回来核对，不至于无限堆积。 */
const DRAFT_EXPIRED_KEEP_MS = 3 * 86400000;
const STAT_KEYS = { like: 'likes', comment: 'comments', follow: 'follows', post: 'posts', dm: 'dms', save: 'saves' };

function draftDeadline(draft) {
  const deadline = Date.parse(draft.expiresAt ?? '');
  return Number.isFinite(deadline) ? deadline : Date.parse(draft.createdAt ?? '') + DRAFT_TTL_MS;
}

function blank() {
  return {
    version: 1,
    installedAt: new Date().toISOString(),
    usage: {},
    weekUsage: {},
    seen: {},
    actions: [],
    drafts: [],
    risk: { until: 0, reason: '', strikes: 0, lastCode: '' },
    /** 限流退避（-509/429）：只拦她自己出门，不拦主人点的事。 */
    softBackoff: { until: 0, at: 0, n: 0, reason: '' },
    /** 只读请求被限流的次数（不算动作、不加 strikes，只用来看看平台压力）。 */
    rateRead: { n: 0, at: 0, reason: '' },
    lastWriteAt: 0,
    /** 每个平台各自的上次公开动作时间：抖音限流不该连带卡住 B站。 */
    lastWriteByPlat: {},
    /** 上次给主人回私信的时间：只用来防私信连发，不占公开动作的节奏位。 */
    lastChatAt: 0,
    /** 主人最近一次点单的时间：3 分钟内她做的事算「主人让的」，不套出门节奏。 */
    ownerAskAt: 0,
    lastSessionAt: 0,
    stats: { likes: 0, comments: 0, follows: 0, posts: 0, dms: 0, saves: 0, opens: 0 },
    interests: {},
    deviceId: '',
    notes: [],
    readDays: {},
    viewed: [],
  };
}

export class Store {
  constructor(dir, timeZone = 'Asia/Shanghai') {
    this.dir = dir;
    this.timeZone = timeZone;
    this.file = path.join(dir, 'state.json');
    this.data = blank();
  }

  load() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = { ...blank(), ...parsed };
      this.data.risk = { ...blank().risk, ...(parsed.risk ?? {}) };
      this.data.softBackoff = { ...blank().softBackoff, ...(parsed.softBackoff ?? {}) };
      this.data.rateRead = { ...blank().rateRead, ...(parsed.rateRead ?? {}) };
      this.data.stats = { ...blank().stats, ...(parsed.stats ?? {}) };
      for (const d of this.data.drafts) {
        if (d.status === 'sending') {
          d.status = 'unknown';
          d.reason = '进程在发送中退出，结果不明；去平台确认，不要自动重发。';
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        // 损坏的 state.json 别静默清空：留一份现场（额度、去重、草稿都在里面），方便排查/恢复
        try {
          const bad = path.join(this.dir, `state.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
          fs.renameSync(this.file, bad);
        } catch {
          // 备份失败也只能继续
        }
        this.data = blank();
      }
    }
    this.prune();
    return this;
  }

  /**
   * 攒一下再写盘。
   *
   * save() 是同步的（JSON.stringify + writeFileSync + rename），state.json 几百 KB 时
   * 一次要 10~50ms。回复私信的主链路上如果直接 save，等于凭空加一段延迟。
   * 这里 debounce 800ms：多次写只落一次盘，主链路只付「改内存」的微秒级成本。
   */
  saveSoon(delay = 800) {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      try {
        this.save();
      } catch {
        // 写盘失败下一轮还会再试，不在这里打扰主流程
      }
    }, delay);
    this._saveTimer.unref?.();
  }

  save() {
    this.prune();
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  prune() {
    const today = dayKey(new Date(), this.timeZone);
    const days = Object.keys(this.data.usage).sort();
    for (const day of days.slice(0, Math.max(0, days.length - MAX_DAYS))) delete this.data.usage[day];
    const reads = Object.keys(this.data.readDays ?? {}).sort();
    for (const day of reads.slice(0, Math.max(0, reads.length - MAX_DAYS))) delete this.data.readDays[day];
    const auto = Object.keys(this.data.autoSessions ?? {}).sort();
    for (const day of auto.slice(0, Math.max(0, auto.length - MAX_DAYS))) delete this.data.autoSessions[day];
    const weeks = Object.keys(this.data.weekUsage).sort();
    for (const week of weeks.slice(0, Math.max(0, weeks.length - 26))) delete this.data.weekUsage[week];
    this.data.actions = this.data.actions.slice(-MAX_ACTIONS);
    // pending/sending 必留；unknown（进程退出时发送中，结果不明）留 7 天，让主人能核对，不再当场删掉；
    // expired 留 3 天——过期不等于没发生过，主人得能看见「这几条作废了」
    const keep = new Set(['pending', 'sending', 'unknown', 'expired']);
    this.data.drafts = this.data.drafts
      .filter((d) => {
        if (!keep.has(d.status)) return false;
        if (d.status === 'expired') {
          const at = Date.parse(d.expiredAt ?? d.createdAt ?? '');
          return Number.isFinite(at) && Date.now() - at < DRAFT_EXPIRED_KEEP_MS;
        }
        if (d.status !== 'unknown') return true;
        const at = Date.parse(d.createdAt ?? '');
        return Number.isFinite(at) && Date.now() - at < 7 * 86400000;
      })
      .slice(-MAX_DRAFTS);
    const seen = Object.entries(this.data.seen).sort((a, b) => b[1] - a[1]);
    if (seen.length > MAX_SEEN) this.data.seen = Object.fromEntries(seen.slice(0, MAX_SEEN));
    if (!this.data.deviceId) this.data.deviceId = randomDeviceId();
    if (!this.data.usage[today]) this.data.usage[today] = {};
  }

  usage(action) {
    return Number(this.data.usage[dayKey(new Date(), this.timeZone)]?.[action] ?? 0);
  }

  weekUsage(action) {
    return Number(this.data.weekUsage[weekKey(new Date(), this.timeZone)]?.[action] ?? 0);
  }

  bump(action) {
    const d = dayKey(new Date(), this.timeZone);
    const w = weekKey(new Date(), this.timeZone);
    this.data.usage[d] ??= {};
    this.data.weekUsage[w] ??= {};
    this.data.usage[d][action] = Number(this.data.usage[d][action] ?? 0) + 1;
    this.data.weekUsage[w][action] = Number(this.data.weekUsage[w][action] ?? 0) + 1;
    const stat = STAT_KEYS[action];
    if (stat) this.data.stats[stat] = Number(this.data.stats[stat] ?? 0) + 1;
  }

  markSeen(key) {
    this.data.seen[key] = Date.now();
  }

  seenAt(key) {
    return Number(this.data.seen[key] ?? 0);
  }

  addAction(entry) {
    this.data.actions.push({ at: new Date().toISOString(), ...entry });
    if (this.data.actions.length > MAX_ACTIONS) this.data.actions = this.data.actions.slice(-MAX_ACTIONS);
  }

  /** 看过的视频，新的在前；同平台同 id 只留一条。 */
  addViewed(entry) {
    const key = `${entry.platform}:${entry.id}`;
    this.data.viewed = (this.data.viewed ?? []).filter((v) => `${v.platform}:${v.id}` !== key);
    this.data.viewed.unshift({ at: new Date().toISOString(), ...entry });
    if (this.data.viewed.length > 80) this.data.viewed = this.data.viewed.slice(0, 80);
    // 兴趣学习：她实际点开看了谁，就把作者记一笔（原来 interests 只在 consume 里传空数组，永远不涨）
    const who = String(entry.author ?? '').trim();
    if (who) this.noteInterest([who]);
    // 延迟落盘：这个函数在「打开视频」的路径上，同步 save 会白加 10~50ms
    this.saveSoon();
  }

  viewedList(n = 6) {
    return (this.data.viewed ?? []).slice(0, n);
  }

  /** 今天读了几条（只算 open，不算刷 feed）。 */
  readsToday() {
    return Number(this.data.readDays?.[dayKey(new Date(), this.timeZone)] ?? 0);
  }

  lastActions(n = 5) {
    return this.data.actions.slice(-n).reverse();
  }

  addDraft(draft, ttlMs = DRAFT_TTL_MS) {
    // 超时的旧草稿标 expired，不物理删除：删了面板就「凭空少一条」，主人和鱼对不上账
    this.expireDueDrafts();
    const item = {
      id: randomCode('draft'),
      status: 'pending',
      createdAt: new Date().toISOString(),
      ...draft,
    };
    item.expiresAt = new Date(Date.parse(item.createdAt) + ttlMs).toISOString();
    this.data.drafts.push(item);
    return item;
  }

  /**
   * 把所有已到截止时间还没批的 pending 草稿标成 expired。
   *
   * 这是唯一改状态的入口：创建、查询、审批、tick 通知都走它，
   * 避免有的路径看到「过期」、有的路径还当 pending。
   */
  expireDueDrafts(now = Date.now()) {
    const out = [];
    for (const d of this.data.drafts) {
      if (d.status !== 'pending') continue;
      const deadline = draftDeadline(d);
      if (!Number.isFinite(deadline) || now < deadline) continue;
      d.status = 'expired';
      d.expiredAt = new Date(now).toISOString();
      out.push(d);
    }
    return out;
  }

  draft(id) {
    return this.data.drafts.find((d) => d.id === id) ?? null;
  }

  pendingDrafts() {
    const now = Date.now();
    this.expireDueDrafts(now);
    return this.data.drafts
      .filter((draft) => draft.status === 'pending' && Number.isFinite(Date.parse(draft.createdAt)))
      .map((draft) => {
        const deadline = draftDeadline(draft);
        return {
          ...draft,
          ageSec: Math.round((now - Date.parse(draft.createdAt)) / 1000),
          expiresAt: new Date(deadline).toISOString(),
          expiresInSec: Math.ceil((deadline - now) / 1000),
        };
      });
  }

  /**
   * 已经超时、不能再批的草稿。
   *
   * 面板拿它显示「N 条已过期，要重发」——以前这批草稿是静默消失的，
   * 主人只知道「刚才明明看到一条」，鱼那边还以为在等审批。
   * 先把实际已经超时的 pending 标成 expired，再返回最近几条。
   */
  expiredDrafts(limit = 5) {
    this.expireDueDrafts();
    const now = Date.now();
    return this.data.drafts
      .filter((d) => d.status === 'expired')
      .slice(-limit)
      .reverse()
      .map((d) => ({
        ...d,
        status: 'expired',
        sent: false,
        expiredSec: Math.round((now - Date.parse(d.expiredAt ?? d.createdAt)) / 1000),
      }));
  }

  closeDraft(id, status, extra = {}) {
    const d = this.data.drafts.find((x) => x.id === id);
    if (!d) return null;
    d.status = status;
    d.closedAt = new Date().toISOString();
    Object.assign(d, extra);
    return d;
  }

  setRisk(until, reason, code = '') {
    this.data.risk = {
      until,
      reason,
      lastCode: code,
      strikes: Number(this.data.risk.strikes ?? 0) + (until > Date.now() ? 1 : 0),
    };
  }

  clearRisk() {
    this.data.risk = { until: 0, reason: '', strikes: 0, lastCode: '' };
    // 限流退避一起清：主人都点「继续」了，别再自己歇着
    this.data.softBackoff = { until: 0, at: 0, n: 0, reason: '' };
  }

  noteInterest(tags) {
    for (const tag of tags) {
      if (!tag) continue;
      this.data.interests[tag] = Number(this.data.interests[tag] ?? 0) + 1;
    }
    const top = Object.entries(this.data.interests).sort((a, b) => b[1] - a[1]);
    this.data.interests = Object.fromEntries(top.slice(0, 80));
  }

  topInterests(n = 8) {
    return Object.entries(this.data.interests)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([k]) => k);
  }
}

function randomDeviceId() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16).toUpperCase();
  });
}
