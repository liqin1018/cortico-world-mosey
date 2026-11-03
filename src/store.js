import fs from 'node:fs';
import path from 'node:path';
import { dayKey, randomCode, weekKey } from './util.js';

const MAX_ACTIONS = 300;
const MAX_DRAFTS = 30;
const MAX_SEEN = 2500;
const MAX_DAYS = 90;
const STAT_KEYS = { like: 'likes', comment: 'comments', follow: 'follows', post: 'posts', dm: 'dms', save: 'saves' };

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
      this.data.stats = { ...blank().stats, ...(parsed.stats ?? {}) };
      for (const d of this.data.drafts) {
        if (d.status === 'sending') {
          d.status = 'unknown';
          d.reason = '进程在发送中退出，结果不明；去平台确认，不要自动重发。';
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.data = blank();
      }
    }
    this.prune();
    return this;
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
    this.data.drafts = this.data.drafts.filter((d) => d.status === 'pending' || d.status === 'sending').slice(-MAX_DRAFTS);
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
    this.save();
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

  addDraft(draft) {
    const now = Date.now();
    this.data.drafts = this.data.drafts.filter(
      (d) => d.status === 'pending' && now - Date.parse(d.createdAt) < 30 * 60 * 1000,
    );
    const item = {
      id: randomCode('draft'),
      status: 'pending',
      createdAt: new Date().toISOString(),
      ...draft,
    };
    this.data.drafts.push(item);
    return item;
  }

  draft(id) {
    return this.data.drafts.find((d) => d.id === id) ?? null;
  }

  pendingDrafts() {
    const now = Date.now();
    return this.data.drafts
      .filter((d) => d.status === 'pending' && now - Date.parse(d.createdAt) < 30 * 60 * 1000)
      .map((d) => ({ ...d, ageSec: Math.round((now - Date.parse(d.createdAt)) / 1000) }));
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
