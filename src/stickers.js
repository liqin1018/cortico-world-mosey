/**
 * 表情包库：把抖音（以后也能是别处）看到的表情包存到本地，发的时候按名字/标签挑。
 *
 * 为什么不直接塞进抖音的「收藏表情」：网页端没有稳定的收藏入口，
 * 而且那样只能在抖音里用。存成文件以后，QQ、面板、以后别的平台都能共用一份。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const STICKER_MAX_BYTES = 4 * 1024 * 1024;
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
  constructor({ dataDir, dir, log } = {}) {
    this.dataDir = dataDir;
    // 索引永远在摸鱼自己的数据目录：和别的插件共用图库时，只共享图片，不往别人目录里塞 index.json
    this.indexDir = path.join(String(dataDir ?? '.'), 'stroll', 'stickers');
    this.file = path.join(this.indexDir, 'index.json');
    // 图片目录可以指到别处（cfg.stickerDir），比如 QQ 的 data/stickers
    this.dir = dir ? path.resolve(String(dir)) : this.indexDir;
    this.log = log ?? { info() {}, warn() {} };
    this.data = null;
  }

  /** 换过目录之后，老收藏的图还留在原来的 stroll/stickers 里：找到就用它，不搬文件。 */
  fileOf(entry) {
    if (!entry) return '';
    const name = String(entry.file ?? '');
    const first = path.join(this.dir, name);
    if (fs.existsSync(first) || this.dir === this.indexDir) return first;
    const legacy = path.join(this.indexDir, name);
    return fs.existsSync(legacy) ? legacy : first;
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
    const tmp = `${this.file}.${crypto.randomUUID()}.tmp`;
    try {
      fs.mkdirSync(this.indexDir, { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1), { flag: 'wx' });
      fs.renameSync(tmp, this.file);
      return true;
    } catch (error) {
      try { fs.unlinkSync(tmp); } catch {}
      this.log.warn?.(`表情库索引存不下来：${error?.message ?? error}`);
      return false;
    }
  }

  get(id) {
    const key = String(id ?? '');
    return this.load().items[key] ?? this.scanDir().find((x) => x.id === key) ?? null;
  }

  /**
   * 图库目录里还没登记进索引的图片（共用 QQ 图库时，几千张都在这里）。
   *
   * 别人的图库是「文件名就是全部信息」，所以名字用文件名、没有标签。按目录读一次缓存 60 秒：
   * 每调一次 `stickers` 就 readdir + stat 几千个文件，白白卡住她。
   */
  scanDir(refresh = false) {
    const now = Date.now();
    if (!refresh && this._scan && this._scanDir === this.dir && now - this._scanAt < 60_000) return this._scan;
    const out = [];
    let names = [];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      // 目录还没建：就是空的
    }
    for (const name of names) {
      if (!/\.(png|jpe?g|webp|gif|bmp)$/i.test(name)) continue;
      const full = path.join(this.dir, name);
      let st = null;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      out.push({
        id: `dir:${name}`,
        file: name,
        ext: path.extname(name).toLowerCase(),
        size: st.size,
        name: cleanName(path.basename(name, path.extname(name)), '表情'),
        tags: [],
        source: 'dir',
        src: '',
        tab: '',
        addedAt: st.mtimeMs,
        lastSeenAt: st.mtimeMs,
        lastUsed: 0,
        used: 0,
      });
    }
    this._scan = out;
    this._scanAt = now;
    this._scanDir = this.dir;
    return out;
  }

  /** 索引里登记过的 + 目录里还没登记过的。所有「有几张、叫什么」都走这里。 */
  allEntries() {
    const known = Object.values(this.load().items);
    const seen = new Set(known.map((x) => String(x.file)));
    return [...known, ...this.scanDir().filter((x) => !seen.has(x.file))];
  }

  /**
   * 把目录里扫出来的一张登记进索引，之后才能改名/打标签/记用过几次。
   * 文件不动，只在 index.json 里加一条。
   */
  ensure(id) {
    const key = String(id ?? '');
    const data = this.load();
    if (data.items[key]) return data.items[key];
    const found = this.scanDir().find((x) => x.id === key);
    if (!found) return null;
    data.items[key] = { ...found, addedAt: Date.now(), lastSeenAt: Date.now() };
    this.save();
    return data.items[key];
  }

  /** 存一张。同样的图只留一份（按内容的 sha1 去重），返回 { entry, duplicate }。 */
  addBuffer(buf, meta = {}) {
    if (!Buffer.isBuffer(buf) || !buf.length) return { ok: false, error: '这张图是空的。' };
    if (buf.length > STICKER_MAX_BYTES) return { ok: false, error: `图太大了（${Math.round(buf.length / 1024)}KB），只收 4MB 以内的表情包。` };
    const ext = extOfBuffer(buf) || (String(meta.ext ?? '').startsWith('.') ? String(meta.ext) : '.png');
    const id = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12);
    const data = this.load();
    const exist = data.items[id];
    const file = `s_${id}${ext}`;
    const dest = path.join(this.dir, file);
    if (exist?.file === file && this.matchesBuffer(meta.source === 'received' ? dest : this.fileOf(exist), buf)) {
      if (meta.source === 'received') return { ok: true, duplicate: true, entry: exist };
      exist.lastSeenAt = Date.now();
      if (meta.src && !exist.src) exist.src = String(meta.src);
      if (meta.tab && !exist.tab) exist.tab = String(meta.tab);
      this.save();
      return { ok: true, duplicate: true, entry: exist };
    }
    if (meta.source === 'received') {
      const duplicate = this.scanDir().find((item) => item.size === buf.length && this.matchesBuffer(path.join(this.dir, item.file), buf));
      if (duplicate) {
        const known = Object.values(data.items).find((item) => item.file === duplicate.file);
        return { ok: true, duplicate: true, entry: known ?? duplicate };
      }
    }
    const own = meta.source !== 'received' && this.dir === this.indexDir && !fs.lstatSync(this.dir, { throwIfNoEntry: false })?.isSymbolicLink()
      ? Object.values(data.items).filter((item) => item.id !== id && item.source !== 'received' && /^s_[a-f0-9]{12}\.(png|jpg|gif|webp|bmp)$/.test(item.file))
      : [];
    const victims = own
      .sort((a, b) => Number(b.lastUsed || b.addedAt || 0) - Number(a.lastUsed || a.addedAt || 0))
      .slice(MAX_ITEMS - 1);
    let created = false;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      if (!this.matchesBuffer(dest, buf)) {
        const fd = fs.openSync(dest, 'wx');
        created = true;
        try { fs.writeFileSync(fd, buf); } finally { fs.closeSync(fd); }
      }
    } catch (error) {
      if (created) { try { fs.unlinkSync(dest); } catch {} }
      return { ok: false, error: `存不进表情库：${error?.message ?? error}` };
    }
    const entry = exist?.file === file ? exist : {
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
    for (const victim of victims) delete data.items[victim.id];
    data.items[id] = entry;
    if (!this.save()) {
      if (exist) data.items[id] = exist;
      else delete data.items[id];
      for (const victim of victims) data.items[victim.id] = victim;
      if (created) { try { fs.unlinkSync(dest); } catch {} }
      return { ok: false, error: '表情库索引写入失败，这张图未收藏。' };
    }
    for (const victim of victims) {
      const old = path.join(this.dir, victim.file);
      try {
        const stat = fs.lstatSync(old);
        if (!stat.isFile() || stat.size > STICKER_MAX_BYTES) continue;
        const hash = crypto.createHash('sha1').update(fs.readFileSync(old)).digest('hex').slice(0, 12);
        if (victim.file.startsWith(`s_${hash}.`)) fs.unlinkSync(old);
      } catch {}
    }
    this._scan = null; // 新文件进来了，下次重新扫目录
    return { ok: true, duplicate: false, entry };
  }

  matchesBuffer(file, buf) {
    try {
      const stat = fs.lstatSync(file);
      return stat.isFile() && stat.size === buf.length && buf.equals(fs.readFileSync(file));
    } catch {
      return false;
    }
  }

  list({ query = '', tag = '', limit = 20 } = {}) {
    const q = String(query ?? '').trim().toLowerCase();
    const t = String(tag ?? '').trim().toLowerCase();
    const items = this.allEntries()
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
    const items = this.allEntries();
    return { total: items.length, used: items.filter((x) => Number(x.used || 0) > 0).length };
  }

  /**
   * 按「序号 / id / 名字 / 标签」挑一张。
   * 都挑不到时把现有名字给回去，让她能改口，而不是瞎发一张。
   */
  find(query) {
    const raw = String(query ?? '').trim();
    if (!raw) {
      // 「不写 text 就是随机一张」得真的是随机：以前取的是列表第一个，永远发同一张
      const all = this.allEntries();
      if (!all.length) return { ok: false, error: '表情库还是空的：先收藏几张再来。' };
      return { ok: true, entry: all[Math.floor(Math.random() * all.length)] };
    }
    const low = raw.toLowerCase().replace(/^#/, '');
    const all = this.allEntries();
    const exact = all.find((x) => x.id === low || x.name.toLowerCase() === low);
    if (exact) return { ok: true, entry: exact };
    if (/^\d+$/.test(low)) {
      // 序号按列表顺序。上限原来写死 200：共用 QQ 图库后有两千多张，第 201 张以后就点不到
      const idx = Number(low) - 1;
      const sorted = this.list({ limit: Number.MAX_SAFE_INTEGER }).items;
      if (sorted[idx]) return { ok: true, entry: sorted[idx] };
    }
    const byName = all.filter((x) => x.name.toLowerCase().includes(low));
    if (byName.length === 1) return { ok: true, entry: byName[0] };
    const byTag = all.filter((x) => (x.tags ?? []).some((g) => String(g).toLowerCase().includes(low)));
    const pool = byName.length ? byName : byTag;
    if (pool.length > 1) {
      return { ok: false, error: `「${raw}」能对上 ${pool.length} 张，说具体点。`, candidates: pool.slice(0, 8).map((x) => x.name) };
    }
    return { ok: false, error: `表情库里没有「${raw}」。`, candidates: this.list({ limit: 8 }).items.map((x) => x.name) };
  }

  touch(id) {
    const e = this.ensure(id);
    if (!e) return null;
    e.lastUsed = Date.now();
    e.used = Number(e.used || 0) + 1;
    this.save();
    return e;
  }

  rename(id, name) {
    const e = this.ensure(id);
    if (!e) return { ok: false, error: '没这张。' };
    e.name = cleanName(name, e.name);
    this.save();
    return { ok: true, entry: e };
  }

  tag(id, tags) {
    const e = this.ensure(id);
    if (!e) return { ok: false, error: '没这张。' };
    const add = Array.isArray(tags) ? tags : String(tags ?? '').split(/[,，、\s]+/);
    const set = new Set([...(e.tags ?? []), ...add.map((t) => cleanName(t, '')).filter(Boolean)]);
    e.tags = [...set].slice(0, 8);
    this.save();
    return { ok: true, entry: e };
  }

  remove(id) {
    // 只删索引里登记过的：目录里扫出来、还没登记的那些，删了索引也删不掉文件，不如不认这个动作
    const e = this.load().items[String(id ?? '')];
    if (!e) return { ok: false, error: '没这张。' };
    // 共用图库时，别人的文件不能删（QQ 还在用）；只删摸鱼自己写的 s_ 那份
    if (/^s_/.test(String(e.file ?? ''))) {
      try {
        fs.unlinkSync(this.fileOf(e));
      } catch {
        // 文件没了也算删掉索引
      }
    }
    delete this.load().items[e.id];
    this._scan = null;
    this.save();
    return { ok: true, removed: e.id };
  }
}
