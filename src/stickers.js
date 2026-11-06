/**
 * 表情包库：把抖音（以后也能是别处）看到的表情包存到本地，发的时候按名字/标签挑。
 *
 * 为什么不直接塞进抖音的「收藏表情」：网页端没有稳定的收藏入口，
 * 而且那样只能在抖音里用。存成文件以后，QQ、面板、以后别的平台都能共用一份。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_ITEMS = 800;

/** 从文件头猜扩展名：抖音表情有 png / webp / gif，存错后缀发出去会失败。 */
export function extOfBuffer(buf) {
  if (!buf || buf.length < 12) return '';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return '.png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  if (buf.slice(0, 4).toString('latin1') === 'GIF8') return '.gif';
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return '.webp';
  if (buf.slice(0, 2).toString('latin1') === 'BM') return '.bmp';
  return '';
}

function cleanName(name, fallback = '表情') {
  const s = String(name ?? '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return [...(s || fallback)].slice(0, 24).join('');
}

export class StickerBook {
  constructor({ dataDir, log } = {}) {
    this.dataDir = dataDir;
    this.dir = path.join(String(dataDir ?? '.'), 'stroll', 'stickers');
    this.file = path.join(this.dir, 'index.json');
    this.log = log ?? { info() {}, warn() {} };
    this.data = null;
  }

  load() {
    if (this.data) return this.data;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = { version: 1, items: raw?.items ?? {} };
    } catch {
      this.data = { version: 1, items: {} };
    }
    return this.data;
  }

  save() {
    this.load();
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 1));
    } catch (error) {
      this.log.warn?.(`表情库索引存不下来：${error?.message ?? error}`);
    }
  }

  get(id) {
    return this.load().items[String(id ?? '')] ?? null;
  }

  /** 存一张。同样的图只留一份（按内容的 sha1 去重），返回 { entry, duplicate }。 */
  addBuffer(buf, meta = {}) {
    if (!Buffer.isBuffer(buf) || !buf.length) return { ok: false, error: '这张图是空的。' };
    if (buf.length > MAX_BYTES) return { ok: false, error: `图太大了（${Math.round(buf.length / 1024)}KB），只收 4MB 以内的表情包。` };
    const ext = extOfBuffer(buf) || (String(meta.ext ?? '').startsWith('.') ? String(meta.ext) : '.png');
    const id = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12);
    const data = this.load();
    const exist = data.items[id];
    if (exist) {
      exist.lastSeenAt = Date.now();
      if (meta.src && !exist.src) exist.src = String(meta.src);
      if (meta.tab && !exist.tab) exist.tab = String(meta.tab);
      this.save();
      return { ok: true, duplicate: true, entry: exist };
    }
    // 只留最近用过的 800 张，别让目录无限长
    const ids = Object.values(data.items)
      .sort((a, b) => Number(b.lastUsed || b.addedAt || 0) - Number(a.lastUsed || a.addedAt || 0))
      .map((x) => x.id);
    for (const drop of ids.slice(MAX_ITEMS - 1)) {
      const victim = data.items[drop];
      if (!victim) continue;
      try {
        fs.unlinkSync(path.join(this.dir, victim.file));
      } catch {
        // 文件可能已经被主人删了
      }
      delete data.items[drop];
    }
    const file = `s_${id}${ext}`;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(path.join(this.dir, file), buf);
    } catch (error) {
      return { ok: false, error: `存不进表情库：${error?.message ?? error}` };
    }
    const entry = {
      id,
      file,
      ext,
      size: buf.length,
      name: cleanName(meta.name, `表情${Object.keys(data.items).length + 1}`),
      tags: Array.isArray(meta.tags) ? meta.tags.map((t) => cleanName(t, '')).filter(Boolean).slice(0, 6) : [],
      source: String(meta.source ?? 'douyin'),
      src: String(meta.src ?? ''),
      tab: String(meta.tab ?? ''),
      addedAt: Date.now(),
      lastSeenAt: Date.now(),
      lastUsed: 0,
      used: 0,
    };
    data.items[id] = entry;
    this.save();
    return { ok: true, duplicate: false, entry };
  }

  list({ query = '', tag = '', limit = 20 } = {}) {
    const q = String(query ?? '').trim().toLowerCase();
    const t = String(tag ?? '').trim().toLowerCase();
    const items = Object.values(this.load().items)
      .filter((x) => {
        if (t && !(x.tags ?? []).some((g) => String(g).toLowerCase().includes(t))) return false;
        if (!q) return true;
        const hay = [x.id, x.name, ...(x.tags ?? [])].join(' ').toLowerCase();
        return hay.includes(q);
      })
      .sort((a, b) => Number(b.lastUsed || 0) - Number(a.lastUsed || 0) || Number(b.addedAt || 0) - Number(a.addedAt || 0));
    return { total: items.length, items: items.slice(0, Math.max(1, Number(limit) || 20)) };
  }

  stats() {
    const items = Object.values(this.load().items);
    return { total: items.length, used: items.filter((x) => Number(x.used || 0) > 0).length };
  }

  /**
   * 按「序号 / id / 名字 / 标签」挑一张。
   * 都挑不到时把现有名字给回去，让她能改口，而不是瞎发一张。
   */
  find(query) {
    const raw = String(query ?? '').trim();
    const data = this.load();
    if (!raw) {
      const any = this.list({ limit: 1 }).items[0];
      return any ? { ok: true, entry: any } : { ok: false, error: '表情库还是空的：先收藏几张再来。' };
    }
    const low = raw.toLowerCase().replace(/^#/, '');
    const exact = Object.values(data.items).find((x) => x.id === low || x.name.toLowerCase() === low);
    if (exact) return { ok: true, entry: exact };
    if (/^\d+$/.test(low)) {
      const idx = Number(low) - 1;
      const sorted = this.list({ limit: 200 }).items;
      if (sorted[idx]) return { ok: true, entry: sorted[idx] };
    }
    const byName = Object.values(data.items).filter((x) => x.name.toLowerCase().includes(low));
    if (byName.length === 1) return { ok: true, entry: byName[0] };
    const byTag = Object.values(data.items).filter((x) => (x.tags ?? []).some((g) => String(g).toLowerCase().includes(low)));
    const pool = byName.length ? byName : byTag;
    if (pool.length > 1) {
      return { ok: false, error: `「${raw}」能对上 ${pool.length} 张，说具体点。`, candidates: pool.slice(0, 8).map((x) => x.name) };
    }
    return { ok: false, error: `表情库里没有「${raw}」。`, candidates: this.list({ limit: 8 }).items.map((x) => x.name) };
  }

  fileOf(entry) {
    return entry ? path.join(this.dir, String(entry.file)) : '';
  }

  touch(id) {
    const e = this.get(id);
    if (!e) return null;
    e.lastUsed = Date.now();
    e.used = Number(e.used || 0) + 1;
    this.save();
    return e;
  }

  rename(id, name) {
    const e = this.get(id);
    if (!e) return { ok: false, error: '没这张。' };
    e.name = cleanName(name, e.name);
    this.save();
    return { ok: true, entry: e };
  }

  tag(id, tags) {
    const e = this.get(id);
    if (!e) return { ok: false, error: '没这张。' };
    const add = Array.isArray(tags) ? tags : String(tags ?? '').split(/[,，、\s]+/);
    const set = new Set([...(e.tags ?? []), ...add.map((t) => cleanName(t, '')).filter(Boolean)]);
    e.tags = [...set].slice(0, 8);
    this.save();
    return { ok: true, entry: e };
  }

  remove(id) {
    const e = this.get(id);
    if (!e) return { ok: false, error: '没这张。' };
    try {
      fs.unlinkSync(path.join(this.dir, e.file));
    } catch {
      // 文件没了也算删掉索引
    }
    delete this.load().items[e.id];
    this.save();
    return { ok: true, removed: e.id };
  }
}
