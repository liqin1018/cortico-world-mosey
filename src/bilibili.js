import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  cutChars,
  formatCount,
  formatDuration,
  parseBvid,
  parseCvid,
  parseDynamicId,
  parseKeywords,
  stripAtName,
  stripTags,
  truncate,
  uuid,
} from './util.js';
import { launchHeadless } from './browser.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const ORIGIN = 'https://www.bilibili.com';

/**
 * 抽帧要取哪几个时间点。
 *
 * - 给了 `at`：定点，以这一秒为中心向两边铺开（跨度 ≈ 帧数 × 3 秒），
 *   这是「想知道这段发生了什么」的正确取法。以前只能按全片比例取，跟内容无关。
 * - 没给：均匀铺满全片，掐头去尾各 2%（片头片尾多是黑屏/字幕卡）。
 *
 * 结果只是「理想时间点」，真正落到哪一格由 storyboard 的 index 吸附决定
 * （B站预览图大约 20 秒一格），所以调用方要按吸附后的时间再去重。
 */
export function pickFrameTimes({ duration = 0, index = [], frames = 9, at = null } = {}) {
  const n = Math.max(1, Math.min(12, Math.round(Number(frames) || 9)));
  const last = Array.isArray(index) && index.length ? Number(index[index.length - 1]) || 0 : 0;
  const dur = Number(duration) || last;
  if (!dur) return [];
  const edge = Math.min(6, dur * 0.02);
  const lo = edge;
  const hi = Math.max(lo, dur - edge);
  const out = [];
  const pinned = at != null && Number.isFinite(Number(at));
  if (pinned) {
    const center = Math.max(lo, Math.min(hi, Number(at)));
    const span = Math.min(hi - lo, Math.max(6, n * 3));
    const step = n > 1 ? span / (n - 1) : 0;
    const start = Math.max(lo, Math.min(hi - span, center - span / 2));
    for (let i = 0; i < n; i += 1) out.push(Math.min(hi, start + step * i));
  } else {
    for (let i = 0; i < n; i += 1) {
      const ratio = (i + 1) / (n + 1);
      out.push(lo + (hi - lo) * ratio);
    }
  }
  return out.filter((t, i) => i === 0 || Math.abs(t - out[i - 1]) > 0.5);
}
const MIXIN = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
];

export class BiliError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'BiliError';
    this.code = code;
    Object.assign(this, extra);
  }
}

function signWbi(params, imgUrl, subUrl) {
  const raw = imgUrl.split('/').at(-1).split('.')[0] + subUrl.split('/').at(-1).split('.')[0];
  if (raw.length !== 64) throw new BiliError('SIGNING', 'B站签名密钥不可用');
  const key = MIXIN.map((i) => raw[i]).join('').slice(0, 32);
  const v = { ...params, wts: Math.floor(Date.now() / 1000) };
  const query = Object.keys(v)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v[k]).replace(/[!'()*]/g, ''))}`)
    .join('&');
  return `${query}&w_rid=${crypto.createHash('md5').update(query + key).digest('hex')}`;
}

/** B站返回的长 ID 先转成字符串，避免 JSON 解析丢精度。 */
function parseJson(raw) {
  return JSON.parse(
    raw.replace(
      /("(?:rpid|rpid_str|root|parent|oid|mid|id_str|dynamic_id|dynamic_id_str|id)"\s*:\s*)(\d{16,})(?=\s*[,}])/g,
      '$1"$2"',
    ),
  );
}

/** 消息里的 uri 是网页地址；type 说明它落在视频、动态还是专栏里。 */
/**
 * 把一条 msgfeed（评论/@ 通知）映射成内部结构。inbox 和 @ 轮询共用，
 * 免得两边字段慢慢长歪。
 */
function mapMsgFeedItem(kind, item) {
  const msg = item?.item ?? {};
  const content = stripTags(msg.source_content || msg.message || msg.desc || '');
  if (!content) return null;
  const link = String(msg.uri ?? '');
  const rpid = String(msg.source_id ?? '') || String(msg.target_id ?? '') || '0';
  const rootRpid = String(msg.root_id ?? '') || '0';
  return {
    kind,
    platform: 'bilibili',
    type: inferMsgType(link, msg.type),
    id: String(item.id ?? ''),
    user: stripTags(item.user?.nickname ?? ''),
    mid: String(item.user?.mid ?? ''),
    text: truncate(content, 140),
    quote: truncate(stripTags(msg.target_reply_content || ''), 80),
    where: truncate(stripTags(msg.title || msg.desc || ''), 60),
    // @ 通知的时间在 at_time 里，评论通知在 reply_time 里；单位都是秒。
    // 以前只读 reply_time，@ 条目拿到 0 → inbox 排序垫底、被 slice 切掉，等于「收不到 @」。
    at: Number(item.reply_time ?? item.at_time ?? item.time ?? 0),
    url: commentDeepLink(link, rootRpid, rpid),
    bvid: bvidOf(link),
    dynamicId: parseDynamicId(link),
    cvid: parseCvid(link),
    rpid,
    rootRpid,
    likeState: Number(msg.like_state ?? 0) === 1,
  };
}

function inferMsgType(uri, rawType) {
  const link = String(uri ?? '');
  if (/\/video\//.test(link) || /\/list\//.test(link)) return 'video';
  if (/\/opus\//.test(link) || /t\.bilibili\.com/.test(link)) return 'opus';
  if (/\/read\//.test(link)) return 'article';
  if (rawType === 'reply') return 'video';
  if (rawType === 'album' || rawType === 'dynamic') return 'opus';
  return 'other';
}

function bvidOf(uri) {
  const m = /\/(?:video|list)\/(BV[0-9A-Za-z]{10}|av\d+)/.exec(String(uri ?? ''));
  return m ? m[1] : '';
}

/**
 * 拼一条能直接跳到那条评论的网页地址。
 * B站评论区的锚点是 `#reply<rpid>`；uri 自带锚点时原样保留。
 */
function commentDeepLink(uri, rootRpid, rpid) {
  const link = String(uri ?? '').trim();
  if (!link) return '';
  if (/#reply\d+/.test(link)) return link;
  const anchor = [rootRpid, rpid].find((x) => x && x !== '0' && /^\d+$/.test(x));
  if (!anchor) return link;
  return `${link.replace(/#.*$/, '')}#reply${anchor}`;
}

/** 动态正文分散在 desc / opus / draw / article 里，按类型挨个找。 */
function dynamicText(item) {
  const md = item?.modules?.module_dynamic ?? {};
  const bits = [
    md.desc?.text,
    md.major?.opus?.summary?.text,
    md.major?.opus?.title,
    md.major?.article?.title,
    md.major?.article?.desc,
    md.major?.archive?.title,
    md.major?.archive?.desc,
    ...((md.major?.draw?.items ?? []).map((x) => x?.description) ?? []),
  ];
  return stripTags(bits.filter(Boolean).join(' '));
}

/** 动态配图（最多三张），只给面板当标题辅助，不下载。 */
function dynamicImages(item) {
  const md = item?.modules?.module_dynamic ?? {};
  const draw = md.major?.draw?.items ?? md.major?.opus?.pics ?? [];
  return draw.map((x) => x?.src ?? x?.url ?? '').filter(Boolean).slice(0, 3);
}

/**
 * 评论区的 oid / type 不是动态 ID：
 * 图文动态是 type=11 + 相册 id，视频动态是 type=1 + aid。
 * 所以每次回复前都先读一遍详情，不能拿动态 ID 硬当 oid。
 */
function commentTargetOf(item) {
  const basic = item?.basic ?? {};
  const oid = String(basic.comment_id_str ?? basic.rid_str ?? '');
  const type = Number(basic.comment_type ?? 0);
  return { oid, type: type || 17 };
}

/** 一条评论压成面板能直接渲染的样子；rpid 留着，方便在弹层里回。 */
function replyView(c) {
  return {
    rpid: c.rpid,
    u: truncate(c.author, 12),
    t: truncate(c.text, 120),
    l: formatCount(c.like),
    at: c.at ?? 0,
  };
}


export class Bilibili {
  constructor({ dataDir, cfg, log, policy, store }) {
    this.dataDir = dataDir;
    this.cfg = cfg;
    this.log = log;
    this.policy = policy;
    this.store = store;
    this.cache = new Map();
    /** 字幕/弹幕缓存：cid -> { at, subtitles, danmaku } */
    this.mediaCache = new Map();
    this.lastRequest = 0;
    this.wbi = null;
    this.navCache = null;
    this.followingCache = { at: 0, ids: new Set() };
    this.credentialsOverride = null;
  }

  /** 允许从面板传入一次性 cookie（不进配置文件）。 */
  setCredentials(cred) {
    this.credentialsOverride = cred;
    this.cache.clear();
    this.navCache = null;
    this.wbi = null;
  }

  /** 点过「退出登录」后，插件自己的和共用的凭据都不再读，直到重新登录。 */
  isLoggedOut() {
    return !!this.store?.data?.biliLoggedOut;
  }

  markLoggedOut(on = true) {
    if (!this.store?.data) return;
    this.store.data.biliLoggedOut = !!on;
    this.store.save?.();
  }

  /** 退出登录：删掉自己存的那份 cookie，并让 readCredentials 不再兜底去读共用凭据。 */
  logout() {
    this.credentialsOverride = null;
    this.navCache = null;
    this.wbi = null;
    this.cache.clear();
    try {
      fs.unlinkSync(path.join(this.dataDir, 'stroll', 'bilibili.json'));
    } catch {
      // 本来就没存过
    }
    this.markLoggedOut(true);
    return { ok: true, loggedOut: true };
  }

  /**
   * 从 摸鱼 自己的浏览器窗口里收 B站 cookie。
   * 只在主人主动登录、或面板刷新时调用；不会去碰系统浏览器的资料。
   * 返回带 stage 的结果，方便上层说清楚卡在哪一步（没窗口 / 没 cookie / 校验没过）。
   */
  async importFromContext(context) {
    if (this.isLoggedOut()) {
      return { ok: false, stage: 'logged-out', error: '已经退出登录了，先点「登录 B站」。' };
    }
    if (!context) {
      return { ok: false, stage: 'no-window', error: '还没有打开的浏览器窗口，先点「登录 B站」。' };
    }
    const cookies = await context.cookies('https://www.bilibili.com').catch(() => []);
    const sess = cookies.find((c) => c.name === 'SESSDATA');
    const jct = cookies.find((c) => c.name === 'bili_jct');
    if (!sess?.value || !jct?.value) {
      return { ok: false, stage: 'no-cookie', error: '窗口里还没看到 B站登录 cookie，先在窗口里扫码。' };
    }
    const cred = {
      sessdata: sess.value,
      bili_jct: jct.value,
      buvid3: cookies.find((c) => c.name === 'buvid3')?.value ?? '',
    };
    try {
      const dir = path.join(this.dataDir, 'stroll');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'bilibili.json'), JSON.stringify(cred, null, 2), { mode: 0o600 });
    } catch {
      // 写不了文件也先用在内存里
    }
    this.setCredentials(cred);
    const nav = await this.nav(true).catch(() => null);
    if (nav?.isLogin) {
      return { ok: true, stage: 'ok', loggedIn: true, uid: String(nav.mid ?? ''), name: nav.uname ?? '' };
    }
    // cookie 已经收下也存好了，只是这次校验没通过（多为风控），别让主人以为白扫了
    return {
      ok: false,
      stage: 'verify-failed',
      saved: true,
      error: 'cookie 已经保存，但身份校验没通过（多半是风控）。过一会儿点「重新登录」或刷新面板再试。',
    };
  }

  readCredentials() {
    if (this.isLoggedOut()) return null;
    if (this.credentialsOverride) return this.credentialsOverride;
    const candidates = [];
    // 自己在 摸鱼 窗口登录的那份优先；没有再复用应用共用的那份
    candidates.push(path.join(this.dataDir, 'stroll', 'bilibili.json'));
    if (this.cfg.sharedBiliCookie) candidates.push(path.join(this.dataDir, 'credentials.json'));
    for (const file of candidates) {
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        const sessdata = raw.sessdata ?? raw.SESSDATA ?? raw.SESSDATA_V2 ?? '';
        const biliJct = raw.bili_jct ?? raw.BILI_JCT ?? raw.csrf ?? '';
        if (sessdata && biliJct) {
          return {
            sessdata: String(sessdata),
            bili_jct: String(biliJct),
            buvid3: String(raw.buvid3 ?? raw.BUVID3 ?? ''),
          };
        }
      } catch {
        // 继续找下一份
      }
    }
    return null;
  }

  cookieHeader() {
    const c = this.readCredentials();
    if (!c) return '';
    return `SESSDATA=${c.sessdata}; bili_jct=${c.bili_jct}${c.buvid3 ? `; buvid3=${c.buvid3}` : ''}`;
  }

  get csrf() {
    return this.readCredentials()?.bili_jct ?? '';
  }

  /**
   * 请求排队：并发调用会一个接一个地过闸，而不是同时读到同一个 lastRequest、
   * 同时睡完再一起发（那样等于没有节流，面板轮询+用户点击就会撞出 412）。
   */
  async takeTurn(gap) {
    const prev = this._reqChain ?? Promise.resolve();
    let release;
    this._reqChain = new Promise((resolve) => {
      release = resolve;
    });
    await prev.catch(() => {});
    const wait = Math.max(0, Number(this.lastRequest ?? 0) + gap - Date.now());
    if (wait) await new Promise((r) => setTimeout(r, wait));
    this.lastRequest = Date.now();
    release();
  }

  async request(route, params = {}, opts = {}) {
    const base = opts.base ?? 'https://api.bilibili.com';
    const url = new URL(route, base);
    const allowed = new Set(['api.bilibili.com', 'api.vc.bilibili.com']);
    if (!allowed.has(url.hostname) || url.protocol !== 'https:' || url.username || url.password) {
      throw new BiliError('HOST', '不允许的接口地址');
    }

    const cookie = opts.anon ? '' : this.cookieHeader();
    const hasAuth = !!cookie;

    if (opts.wbi) {
      if (!this.wbi || this.wbi.exp < Date.now()) {
        const nav = await this.nav(true).catch(() => null);
        const img = nav?.wbi_img?.img_url;
        const sub = nav?.wbi_img?.sub_url;
        if (!img || !sub) throw new BiliError('SIGNING', '拿不到 B站签名密钥');
        this.wbi = { img, sub, exp: Date.now() + 10 * 60 * 1000 };
      }
      const signed = opts.post
        ? opts.csrfQuery
          ? { csrf: this.csrf }
          : {}
        : params;
      url.search = signWbi(signed, this.wbi.img, this.wbi.sub);
    } else if (!opts.post) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }

    const key = url.href + (opts.post ? `#${JSON.stringify(params).slice(0, 200)}` : '');
    const cached = this.cache.get(key);
    if (opts.cacheMs && cached && cached.until > Date.now()) return structuredClone(cached.value);

    // 650ms 是给「刷列表/翻评论」防 412 用的；发私信、发评论这种一次性的动作
    // 没必要时时等满 650ms，调用点用 minGapMs 单独给预算。
    const gap = Math.max(0, Number(opts.minGapMs ?? 650));
    await this.takeTurn(gap);

    const headers = {
      'User-Agent': UA,
      Referer: opts.referer ?? ORIGIN,
      Origin: opts.origin ?? ORIGIN,
      Accept: 'application/json, text/plain, */*',
    };
    if (cookie) headers.Cookie = cookie;

    let body;
    if (opts.post) {
      const data = { ...params };
      if (!opts.noCsrf && this.csrf) {
        data.csrf = this.csrf;
        data.csrf_token = this.csrf;
      }
      if (opts.json) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(data);
      } else {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        body = new URLSearchParams(
          Object.entries(data).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)]),
        ).toString();
      }
    }

    let res;
    try {
      res = await fetch(url, {
        method: opts.post ? 'POST' : 'GET',
        headers,
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(opts.timeoutMs ?? 20000),
      });
    } catch (error) {
      if (opts.post) {
        throw new BiliError('WRITE_UNCERTAIN', '请求超时或断线，结果不明；先不要去重发，去平台确认。', { cause: error });
      }
      throw new BiliError('NETWORK', '连不上 B站接口，稍后再试。', { cause: error });
    }

    if ([412, 429].includes(res.status)) {
      this.policy.noteRisk(String(res.status), 'B站要求冷却', { source: opts.post ? 'write' : 'read' });
      throw new BiliError('RISK', 'B站要求冷却，已自动停手。');
    }
    if (!res.ok) {
      throw new BiliError(opts.post ? 'WRITE_UNCERTAIN' : 'HTTP', `B站接口 HTTP ${res.status}`);
    }

    let data;
    try {
      data = parseJson(await res.text());
    } catch {
      throw new BiliError(opts.post ? 'WRITE_UNCERTAIN' : 'BAD_RESPONSE', 'B站返回了无法解析的内容');
    }

    if (data.code !== 0) {
      if ([-412, -352, -509, -799].includes(data.code)) {
        this.policy.noteRisk(String(data.code), data.message || 'B站风控', { source: opts.post ? 'write' : 'read' });
        throw new BiliError('RISK', 'B站风控拦截，已停手。');
      }
      if (data.code === -101) {
        throw new BiliError('LOGIN_REQUIRED', 'B站登录态失效了，需要重新登录。');
      }
      if (data.code === -111) {
        throw new BiliError('CSRF', 'B站 CSRF 校验失败，登录态可能不完整。');
      }
      throw new BiliError(`BILI_${data.code}`, `B站拒绝了请求：${data.message || data.code}`);
    }

    const value = data.data ?? data.result ?? {};
    if (opts.cacheMs) {
      if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value);
      this.cache.set(key, { value, until: Date.now() + opts.cacheMs });
    }
    return value;
  }

  async nav(force = false) {
    if (!force && this.navCache && this.navCache.until > Date.now()) return this.navCache.data;
    try {
      const data = await this.request('/x/web-interface/nav', {}, { cacheMs: 0, anon: !this.readCredentials() });
      this.navCache = { data, until: Date.now() + 5 * 60 * 1000 };
      return data;
    } catch (error) {
      if (error.code === 'LOGIN_REQUIRED' || error.code === 'BILI_-101') {
        const anon = await this.request('/x/web-interface/nav', {}, { anon: true }).catch(() => ({}));
        this.navCache = { data: anon, until: Date.now() + 60 * 1000 };
        return anon;
      }
      throw error;
    }
  }

  async health() {
    try {
      const nav = await this.nav();
      return {
        ok: !!nav?.isLogin,
        loggedIn: !!nav?.isLogin,
        uid: nav?.mid ? String(nav.mid) : '',
        name: nav?.uname ?? '',
        level: nav?.level ?? 0,
        cookie: !!this.readCredentials(),
      };
    } catch (error) {
      return { ok: false, loggedIn: false, uid: '', name: '', cookie: !!this.readCredentials(), error: error.message };
    }
  }

  async feed(limit = 6) {
    const data = await this.request('/x/web-interface/popular', { ps: Math.min(20, Math.max(6, limit)), pn: 1 }, { cacheMs: 120000 });
    const list = Array.isArray(data.list) ? data.list : [];
    const following = await this.following().catch(() => new Set());
    const items = list.map((v) => this.mapVideo(v, following));
    return this.rank(items).slice(0, limit);
  }

  /**
   * 关注的人在发什么（动态流）。需要登录；没登录时接口返回空列表，不抛错。
   */
  async followFeed(limit = 8) {
    const data = await this.request(
      '/x/polymer/web-dynamic/v1/feed/all',
      { type: 'all', page: 1, timezone_offset: -480 },
      { cacheMs: 90 * 1000 },
    );
    const list = Array.isArray(data.items) ? data.items : [];
    return list.slice(0, Math.max(1, limit)).map((item) => {
      const author = item.modules?.module_author ?? {};
      const major = item.modules?.module_dynamic?.major ?? {};
      const arch = major.archive;
      const text = dynamicText(item);
      const dynId = String(item.id_str ?? '');
      const bvid = String(arch?.bvid ?? '');
      const pics = dynamicImages(item).length;
      return {
        platform: 'bilibili',
        kind: bvid ? 'video' : major.article ? 'article' : 'opus',
        id: dynId,
        bvid,
        title: truncate(text || arch?.title || `${author.name ?? ''}发了${pics ? `${pics} 张图` : '一条动态'}`, 70),
        author: stripTags(author.name ?? ''),
        authorId: String(author.mid ?? ''),
        at: Number(author.pub_ts ?? 0) * 1000,
        url: bvid ? `https://www.bilibili.com/video/${bvid}` : `https://t.bilibili.com/${dynId}`,
        stat: `${formatCount(Number(item.modules?.module_stat?.comment?.count ?? 0))} 评`,
        pics,
      };
    });
  }

  /** 稍后再看。空列表很常见，不当成错误。 */
  async toview(limit = 8) {
    const data = await this.request('/x/v2/history/toview', {}, { cacheMs: 60000 });
    const list = Array.isArray(data.list) ? data.list : [];
    return list.slice(0, limit).map((v) => ({
      id: v.bvid,
      title: truncate(stripTags(v.title), 60),
      author: stripTags(v.owner?.name ?? ''),
      dur: formatDuration(Number(v.duration) || 0),
      progress: Number(v.progress) || 0,
      url: `https://www.bilibili.com/video/${v.bvid}`,
    }));
  }

  async search(query, limit = 6) {
    const data = await this.request(
      '/x/web-interface/wbi/search/type',
      { search_type: 'video', keyword: String(query).slice(0, 50), page: 1 },
      { wbi: true, cacheMs: 120000 },
    );
    const list = Array.isArray(data.result) ? data.result : [];
    const items = list
      .filter((v) => v.bvid)
      .map((v) =>
        this.mapVideo(
          {
            bvid: v.bvid,
            title: stripTags(v.title),
            desc: stripTags(v.description ?? ''),
            duration: this.parseDurationText(v.duration),
            owner: { name: stripTags(v.author) },
            stat: { like: Number(v.like) || 0, view: Number(v.play) || 0 },
            tname: stripTags(v.typename ?? ''),
          },
          new Set(),
        ),
      );
    return this.rank(items).slice(0, limit);
  }

  parseDurationText(text) {
    const parts = String(text ?? '').split(':').map(Number);
    if (parts.some((n) => !Number.isFinite(n))) return 0;
    return parts.reduce((acc, n) => acc * 60 + n, 0);
  }

  mapVideo(v, following) {
    const title = truncate(stripTags(v.title), 48);
    const desc = stripTags(v.desc ?? '');
    const tags = this.matchTags(`${title} ${desc} ${v.tname ?? ''}`);
    const owner = stripTags(v.owner?.name ?? '');
    const stat = v.stat ?? {};
    return {
      id: v.bvid,
      title,
      author: owner,
      dur: formatDuration(v.duration),
      durSec: Number(v.duration) || 0,
      stat: `${formatCount(stat.like)}赞 ${formatCount(stat.view)}播`,
      why: tags.length ? `兴趣：${tags.slice(0, 2).join('、')}` : following.has(String(v.owner?.mid ?? '')) ? '你关注的人' : '',
      url: `https://www.bilibili.com/video/${v.bvid}`,
      _score: this.score(v, tags, following),
    };
  }

  matchTags(text) {
    const lower = String(text).toLowerCase();
    const interests = parseKeywords(this.cfg.interests);
    return interests.filter((k) => lower.includes(k.toLowerCase())).slice(0, 3);
  }

  score(v, tags, following) {
    const stat = v.stat ?? {};
    let score = Math.log10(Number(stat.like ?? 0) + 1) * 3 + Math.log10(Number(stat.view ?? 0) + 1);
    score += tags.length * 6;
    const avoid = parseKeywords(this.cfg.avoid);
    const text = `${v.title ?? ''} ${v.desc ?? ''}`.toLowerCase();
    if (avoid.some((k) => text.includes(k.toLowerCase()))) score -= 100;
    if (following.has(String(v.owner?.mid ?? ''))) score += 4;
    if (this.store?.seenAt?.(`bilibili:open:${v.bvid}`)) score -= 12;
    const dur = Number(v.duration) || 0;
    if (dur > 0 && dur < 45) score -= 2;
    if (dur > 1800) score -= 2;
    return score;
  }

  rank(items) {
    const seenOwner = new Set();
    return items
      .sort((a, b) => b._score - a._score)
      .filter((item) => {
        if (seenOwner.has(item.author)) return false;
        seenOwner.add(item.author);
        return true;
      });
  }

  async following() {
    if (this.followingCache.at > Date.now() - 60 * 60 * 1000) return this.followingCache.ids;
    const nav = await this.nav();
    if (!nav?.mid) return new Set();
    const ids = new Set();
    try {
      const data = await this.request(
        '/x/relation/followings',
        { vmid: nav.mid, ps: 50, pn: 1, order: 'desc' },
        { cacheMs: 60 * 60 * 1000 },
      );
      for (const item of data.list ?? []) ids.add(String(item.mid));
    } catch {
      // 关注列表拿不到就不加分，不影响主流程
    }
    this.followingCache = { at: Date.now(), ids };
    return ids;
  }

  async view(id) {
    const key = parseBvid(id);
    if (!key) throw new BiliError('BAD_ID', '不是有效的 BV 号或 av 号');
    const params = key.startsWith('BV') ? { bvid: key } : { aid: key.slice(2) };
    const data = await this.request('/x/web-interface/view', params, { cacheMs: 5 * 60 * 1000 });
    return {
      aid: String(data.aid),
      /** 弹幕/字幕都要 cid；番剧/直播这里可能没有 */
      cid: String(data.cid ?? ''),
      bvid: data.bvid,
      title: stripTags(data.title),
      desc: stripTags(data.desc ?? ''),
      author: stripTags(data.owner?.name ?? ''),
      authorId: String(data.owner?.mid ?? ''),
      duration: Number(data.duration) || 0,
      cover: data.pic ?? '',
      tags: (data.tags ?? []).map((t) => t.tag_name).filter(Boolean).slice(0, 5),
      stat: {
        view: Number(data.stat?.view ?? 0),
        like: Number(data.stat?.like ?? 0),
        reply: Number(data.stat?.reply ?? 0),
        danmaku: Number(data.stat?.danmaku ?? 0),
      },
      pubdate: Number(data.pubdate ?? 0),
      url: `https://www.bilibili.com/video/${data.bvid}`,
    };
  }

  /**
   * 读一条视频的字幕 + 弹幕。
   * - 不传 `around`：字幕**按时间分段抽样**，从开头一路覆盖到结尾（以前只取开头 12 句，
   *   10 分钟的视频基本只知道前十几秒在讲什么）。
   * - 传 `around`：只取这个时间点附近的，供「一起看」按进度播报，或 `read at=5:30` 定点读。
   */
  async mediaText(
    idOrUrl,
    { subtitleLimit = 24, danmakuLimit = 40, around = null, windowSec = 15, aroundSpan = null, maxChars = 1500 } = {},
  ) {
    const v = await this.view(idOrUrl);
    if (!v.cid) {
      return { ok: false, code: 'NO_CID', error: '这条视频拿不到 cid（可能是番剧/直播），读不了字幕和弹幕', subtitles: [], danmaku: [] };
    }
    let cache = this.mediaCache.get(v.cid);
    if (!cache || Date.now() - cache.at > 10 * 60 * 1000) {
      const [subtitles, danmaku] = await Promise.all([
        this.subtitlesOf(v.aid, v.cid).catch(() => []),
        this.danmakuOf(v.cid).catch(() => []),
      ]);
      cache = { at: Date.now(), subtitles, danmaku };
      this.mediaCache.set(v.cid, cache);
      // 只留最近 20 条视频，别把内存吃满
      if (this.mediaCache.size > 20) {
        const oldest = [...this.mediaCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (oldest) this.mediaCache.delete(oldest[0]);
      }
    }
    let subtitles = [];
    let segments = 0;
    let sampled = false;
    if (around != null) {
      if (subtitleLimit > 0) {
        // 一起看只要当前这一句（前后 3/6 秒）；定点读要一整段（默认前后 6/36 秒）
        const back = Number(aroundSpan?.back ?? 3);
        const ahead = Number(aroundSpan?.ahead ?? 6);
        const at = Number(around);
        subtitles = cache.subtitles.filter((x) => x.to >= at - back && x.from <= at + ahead).slice(0, Math.max(1, subtitleLimit));
        segments = subtitles.length ? 1 : 0;
      }
    } else {
      const picked = sampleSubtitles(cache.subtitles, subtitleLimit);
      subtitles = picked.lines;
      segments = picked.segments;
      sampled = picked.sampled;
    }
    // 条数拉满（60 句）时也不能一口气把上下文撑爆：按总字数匀着截断，保留覆盖，不砍掉后半段
    const capped = capSubtitleChars(subtitles, maxChars);
    subtitles = capped.lines;
    const danmaku =
      around != null
        ? cache.danmaku.filter((x) => Math.abs(x.t - Number(around)) <= windowSec).slice(0, 12)
        : sampleDanmaku(cache.danmaku, danmakuLimit);
    return {
      ok: true,
      aid: v.aid,
      cid: v.cid,
      title: v.title,
      duration: v.duration,
      subtitles,
      danmaku,
      total: { subtitles: cache.subtitles.length, danmaku: cache.danmaku.length },
      // 面板/提示词要看得出「这是抽样，不是全片」：total 是原始句数，picked 是这次给了几句
      coverage: {
        total: cache.subtitles.length,
        picked: subtitles.length,
        segments,
        sampled,
        chars: capped.chars,
        truncated: capped.truncated,
        from: subtitles.length ? Number(subtitles[0].from) || 0 : 0,
        to: subtitles.length ? Number(subtitles[subtitles.length - 1].to) || 0 : 0,
      },
    };
  }

  /** CC 字幕：player/v2 列出字幕轨，subtitle_url 里是 {from,to,content}。 */
  async subtitlesOf(aid, cid) {
    let data = null;
    try {
      data = await this.request('/x/player/wbi/v2', { aid, cid }, { wbi: true, cacheMs: 0 });
    } catch {
      data = await this.request('/x/player/v2', { aid, cid }, { cacheMs: 0 }).catch(() => null);
    }
    const tracks = data?.subtitle?.subtitles ?? [];
    const out = [];
    for (const t of tracks.slice(0, 2)) {
      const raw = String(t.subtitle_url ?? '');
      if (!raw) continue;
      const url = raw.startsWith('//') ? `https:${raw}` : raw;
      const json = await this.fetchJson(url).catch(() => null);
      for (const line of json?.body ?? []) {
        const text = String(line.content ?? '').trim();
        if (!text) continue;
        out.push({ from: Number(line.from) || 0, to: Number(line.to) || 0, text: cutChars(text, 80) });
      }
    }
    // 同一句常常同时有「中文轨 + AI 轨」两份：时间差不到 2 秒、文字一样就去重
    const out2 = [];
    for (const line of out.sort((a, b) => a.from - b.from)) {
      const prev = out2[out2.length - 1];
      if (prev && prev.text === line.text && Math.abs(prev.from - line.from) < 2) continue;
      out2.push(line);
    }
    return out2;
  }

  /**
   * B站抽帧：走播放器的「进度条预览图」接口（videoshot）。
   * 不用登录、不用开播放页：一次接口给一张 10×10 的精灵图 + 每格的秒数，
   * 按时间挑最近的一格裁出来。分辨率只有 160×90，够看「画面大概在干嘛」，
   * 看不清字和细节——要更清楚只能开播放页截图，那样要登录态还慢，先不做。
   */
  async framesOf(idOrUrl, n = 1) {
    const v = await this.view(idOrUrl);
    if (!v.cid) throw new BiliError('NO_CID', '这条视频拿不到 cid，取不了画面');
    const sheet = await this.storyboard(v.aid, v.cid);
    if (!sheet) throw new BiliError('NO_FRAME', '这条视频没有进度条预览图');
    const count = Math.min(3, Math.max(1, Math.round(Number(n) || 1)));
    const out = [];
    for (let i = 0; i < count; i += 1) {
      // 均匀取：1 帧取中间，2 帧取 1/3、2/3，3 帧取 1/4、2/4、3/4
      const ratio = (i + 1) / (count + 1);
      const slot = Math.min(sheet.index.length - 1, Math.round(ratio * (sheet.index.length - 1)));
      const cell = sheet.cellAt(sheet.index[slot] ?? 0);
      const bytes = await this.cropSprite(cell).catch(() => null);
      if (bytes) out.push({ at: cell.at, bytes });
    }
    return out;
  }

  /**
   * 多帧拼成**一张分镜图**，每格下面烧上时间码。
   *
   * 为什么拼：单独发 N 张 160×90 的小图，每张都要付一次「小于 544×544」的地板价
   * （宿主按 544×544 计费），3 张 ≈ 552 token 只能看 3 帧；
   * 拼成一张 482×314 只算 184 token，却能看 9 帧。同样的钱多看 3 倍。
   *
   * `at` 给了就不均匀取，改成「以这一秒为中心前后各取几帧」——
   * 这是网友要的「定点抽帧」，之前只能按比例取，跟内容无关。
   */
  async framesSheet(idOrUrl, { frames = 9, at = null } = {}) {
    const v = await this.view(idOrUrl);
    if (!v.cid) throw new BiliError('NO_CID', '这条视频拿不到 cid，取不了画面');
    const sheet = await this.storyboard(v.aid, v.cid);
    if (!sheet) throw new BiliError('NO_FRAME', '这条视频没有进度条预览图');
    const times = pickFrameTimes({
      duration: Number(v.duration) || 0,
      index: sheet.index,
      frames,
      at,
    });
    if (!times.length) return [];
    // 落到真实的格子上，并按吸附后的时间再去一次重（多个理想点可能落进同一格）
    const cells = [];
    const seen = new Set();
    for (const t of times) {
      const cell = sheet.cellAt(t);
      const k = Math.round(Number(cell.at) || 0);
      if (seen.has(k)) continue;
      seen.add(k);
      cells.push(cell);
    }
    if (!cells.length) return [];
    const bytes = await this.composeSheet(cells).catch(() => null);
    if (!bytes) return [];
    const ats = cells.map((c) => c.at);
    return [{ at: ats[Math.floor(ats.length / 2)] ?? ats[0], ats, cols: 3, bytes }];
  }

  /**
   * 高清取帧：打开播放页，把 `<video>` seek 到指定秒再画进 canvas。
   *
   * 和 `framesSheet`（进度条预览图，160×90）的分工：
   *   - 这个清楚 3~6 倍（匿名 360×360 起，登录态更高），但**慢 5~10 倍**——
   *     要加载整个播放页，每次 seek 还要等解码，实测 8~15 秒。
   *   - 所以只在「要认真看这一段」时用，平时还是走 sprite（1.5 秒）。
   *
   * 2026-11-13 探针（.probe/t-video-seek.mjs）实测：匿名无头浏览器能解码、
   * seek 生效、`canvas.drawImage` **不会被污染**（toDataURL / getImageData 都正常）。
   */
  async framesFromVideo(idOrUrl, { frames = 9, at = null, cols = 3, cellW = 320, cellH = 180 } = {}) {
    const v = await this.view(idOrUrl);
    if (!v.bvid) throw new BiliError('BAD_ID', '不是有效的 B站视频');
    const times = pickFrameTimes({ duration: Number(v.duration) || 0, frames, at });
    if (!times.length) return [];
    const page = await this.videoPage();
    try {
      await page
        .goto(`https://www.bilibili.com/video/${v.bvid}`, { waitUntil: 'domcontentloaded', timeout: 45000 })
        .catch(() => {});
      const ready = await page
        .waitForFunction(
          () => {
            const el = document.querySelector('video');
            return !!el && el.readyState >= 2 && el.videoWidth > 0;
          },
          { timeout: 25000 },
        )
        .then(() => true)
        .catch(() => false);
      if (!ready) throw new BiliError('NO_VIDEO', '这条视频的播放页没加载出画面（可能要登录，或者不是普通视频）');
      const dataUrl = await page
        .evaluate(
          async (p) => {
            const video = document.querySelector('video');
            if (!video) return '';
            try {
              video.pause();
            } catch {
              // 暂停失败也能画，继续
            }
            const gap = 1;
            const rows = Math.ceil(p.times.length / p.cols);
            const W = p.cols * p.cellW + (p.cols - 1) * gap;
            const H = rows * (p.cellH + p.labelH) + (rows - 1) * gap;
            const canvas = document.createElement('canvas');
            canvas.width = W;
            canvas.height = H;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#121214';
            ctx.fillRect(0, 0, W, H);
            const vw = video.videoWidth || 16;
            const vh = video.videoHeight || 9;
            for (let i = 0; i < p.times.length; i += 1) {
              const t = p.times[i];
              await new Promise((done) => {
                let over = false;
                const finish = () => {
                  if (over) return;
                  over = true;
                  video.removeEventListener('seeked', finish);
                  done();
                };
                video.addEventListener('seeked', finish);
                try {
                  video.currentTime = t;
                } catch {
                  finish();
                }
                setTimeout(finish, 5000);
              });
              /**
               * `seeked` 只代表「播放位置变了」，不代表画面已经画出来——
               * 直接画会隔几格出现一张白屏（2026-11-13 第 6 格）。
               * 这里等 300ms 让解码器把这一帧填进缓冲；画完再抽样检查是不是白屏，
               * 白就往前后挪一点重来一次。实测比 requestVideoFrameCallback 可靠
               * （暂停状态下那个回调根本不触发）。
               */
              await new Promise((done) => setTimeout(done, 600));
              const col = i % p.cols;
              const row = Math.floor(i / p.cols);
              const dx = col * (p.cellW + gap);
              const dy = row * (p.cellH + p.labelH + gap);
              // contain：保持比例、居中、留黑边，绝不拉伸
              const scale = Math.min(p.cellW / vw, p.cellH / vh);
              const dw = vw * scale;
              const dh = vh * scale;
              const draw = () => {
                try {
                  ctx.drawImage(video, 0, 0, vw, vh, dx + (p.cellW - dw) / 2, dy + (p.cellH - dh) / 2, dw, dh);
                } catch {
                  // 某一帧画失败就留空，别把整张图废掉
                }
              };
              // 取画面中心 50% 区域算平均亮度：>210 就认为这一帧「白到看不清」（解码没跟上，或者技能闪光这样的过曝帧）。
              // 不能用「点采样」——白帧常常只白一部分，角上的采样点会漏判（2026-11-13 踩过）。
              const looksBlank = () => {
                try {
                  const cx = Math.round(dx + (p.cellW - dw) / 2);
                  const cy = Math.round(dy + (p.cellH - dh) / 2);
                  const w = Math.max(2, Math.round(dw * 0.5));
                  const h = Math.max(2, Math.round(dh * 0.5));
                  const data = ctx.getImageData(cx, cy, w, h).data;
                  let sum = 0;
                  for (let k = 0; k < data.length; k += 4) sum += (data[k] + data[k + 1] + data[k + 2]) / 3;
                  return data.length ? sum / (data.length / 4) > 210 : false;
                } catch {
                  return false;
                }
              };
              draw();
              if (looksBlank()) {
                // 白屏：挪 1.2 秒重来一次（多半是转场、闪白，或者解码器慢了一拍）
                await new Promise((done) => {
                  let over = false;
                  const finish = () => {
                    if (over) return;
                    over = true;
                    video.removeEventListener('seeked', finish);
                    done();
                  };
                  video.addEventListener('seeked', finish);
                  try {
                    video.currentTime = t + 1.2;
                  } catch {
                    finish();
                  }
                  setTimeout(finish, 4000);
                });
                await new Promise((done) => setTimeout(done, 300));
                draw();
              }
              const sec = Math.max(0, Math.round(t));
              const hh = Math.floor(sec / 3600);
              const mm = Math.floor((sec % 3600) / 60);
              const ss = String(sec % 60).padStart(2, '0');
              const label = hh > 0 ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
              ctx.fillStyle = 'rgba(0,0,0,.72)';
              ctx.fillRect(dx, dy + p.cellH, p.cellW, p.labelH);
              ctx.fillStyle = '#ffeb3b';
              ctx.font = '11px "Microsoft YaHei", sans-serif';
              ctx.textBaseline = 'middle';
              ctx.fillText(label, dx + 4, dy + p.cellH + p.labelH / 2 + 0.5);
            }
            return canvas.toDataURL('image/jpeg', 0.85);
          },
          { times, cols, cellW, cellH, labelH: 16 },
        )
        .catch(() => '');
      const b64 = String(dataUrl).split(',')[1] ?? '';
      if (!b64) return [];
      return [
        {
          at: times[Math.floor(times.length / 2)] ?? times[0],
          ats: times.map((t) => Math.round(t)),
          cols,
          hd: true,
          bytes: Buffer.from(b64, 'base64'),
        },
      ];
    } finally {
      await page.close().catch(() => {});
    }
  }

  /** 借精灵图那个无头浏览器开一个独立页（独立 viewport，不共享它的 160×90）。 */
  async videoPage() {
    await this.spritePage().catch(() => null);
    const browser = this._spriteBrowser;
    if (!browser) throw new BiliError('NO_BROWSER', '开不了浏览器');
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN' });
    page.setDefaultTimeout(60000);
    return page;
  }

  /**
   * 把若干格拼到一块画布上。所有格子尺寸相同（B站预览图固定 160×90）。
   * 一次 `evaluate` 画完：以前每帧都要 setContent + screenshot，9 帧要开关 9 次，
   * 现在是「下载 1 张精灵图 + 画 9 格」，快一个数量级。
   */
  async composeSheet(cells, { cols = 3, gap = 1, labelH = 14 } = {}) {
    const list = Array.isArray(cells) ? cells.filter((c) => c?.url) : [];
    if (!list.length) return null;
    const cw = Math.max(1, Number(list[0].w) || 160);
    const ch = Math.max(1, Number(list[0].h) || 90);
    const use = list.slice(0, Math.max(1, cols * 3));
    const rows = Math.ceil(use.length / cols);
    const W = cols * cw + (cols - 1) * gap;
    const H = rows * (ch + labelH) + (rows - 1) * gap;
    // 长视频的预览图会分成好几张，按 url 去重后各下一次
    const urls = [...new Set(use.map((c) => c.url))];
    const raws = {};
    for (const url of urls) {
      const raw = await this.fetchRaw(url, { binary: true }).catch(() => null);
      if (!raw?.length) return null;
      raws[url] = Buffer.from(raw).toString('base64');
    }
    const page = await this.spritePage();
    await page.setViewportSize({ width: W, height: H });
    const dataUrl = await page
      .evaluate(
        async (p) => {
          const load = (src) =>
            new Promise((resolve, reject) => {
              const img = new Image();
              img.onload = () => resolve(img);
              img.onerror = () => reject(new Error('bad image'));
              img.src = `data:image/jpeg;base64,${src}`;
            });
          const uniq = [...new Set(p.cells.map((c) => c.url))];
          const imgs = {};
          await Promise.all(uniq.map(async (u) => {
            imgs[u] = await load(p.raws[u]);
          }));
          const canvas = document.createElement('canvas');
          canvas.width = p.W;
          canvas.height = p.H;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#121214';
          ctx.fillRect(0, 0, p.W, p.H);
          p.cells.forEach((cell, i) => {
            const col = i % p.cols;
            const row = Math.floor(i / p.cols);
            const dx = col * (p.cw + p.gap);
            const dy = row * (p.ch + p.labelH + p.gap);
            try {
              ctx.drawImage(imgs[cell.url], cell.x, cell.y, p.cw, p.ch, dx, dy, p.cw, p.ch);
            } catch {
              // 单格失败就留空，别把整张图废掉
            }
            const t = Math.max(0, Math.round(Number(cell.at) || 0));
            const hh = Math.floor(t / 3600);
            const mm = Math.floor((t % 3600) / 60);
            const ss = String(t % 60).padStart(2, '0');
            const label = hh > 0 ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
            ctx.fillStyle = 'rgba(0,0,0,.72)';
            ctx.fillRect(dx, dy + p.ch, p.cw, p.labelH);
            ctx.fillStyle = '#ffeb3b';
            ctx.font = '10px "Microsoft YaHei", sans-serif';
            ctx.textBaseline = 'middle';
            ctx.fillText(label, dx + 3, dy + p.ch + p.labelH / 2 + 0.5);
          });
          return canvas.toDataURL('image/jpeg', 0.82);
        },
        { cells: use, raws, cols, cw, ch, W, H, gap, labelH },
      )
      .catch(() => '');
    const b64 = String(dataUrl).split(',')[1] ?? '';
    if (!b64) return null;
    return Buffer.from(b64, 'base64');
  }

  /** 预览图索引（按 cid 缓存 10 分钟）。index 里的值就是每一帧的时间（秒）。 */
  async storyboard(aid, cid) {
    const key = `sb:${cid}`;
    const hit = this.mediaCache.get(key);
    if (hit?.sheet && Date.now() - hit.at < 10 * 60 * 1000) return hit.sheet;
    const data = await this.request('/x/player/videoshot', { aid, cid, index: 1 }, { cacheMs: 0 }).catch(() => null);
    const images = (data?.image ?? []).map((u) => (String(u).startsWith('//') ? `https:${String(u)}` : String(u)));
    const index = (data?.index ?? []).map((x) => Number(x) || 0);
    if (!images.length || !index.length) return null;
    const cols = Math.max(1, Number(data.img_x_len) || 10);
    const w = Math.max(1, Number(data.img_x_size) || 160);
    const h = Math.max(1, Number(data.img_y_size) || 90);
    const per = cols * Math.max(1, Number(data.img_y_len) || 10);
    const sheet = {
      images,
      cols,
      w,
      h,
      index,
      /** 第 sec 秒那一帧：落在第几张图、哪一格。长视频会有多张图，index 是跨图连着的。 */
      cellAt: (sec) => {
        let best = 0;
        for (let i = 1; i < index.length; i += 1) {
          if (Math.abs(index[i] - sec) < Math.abs(index[best] - sec)) best = i;
        }
        const page = Math.floor(best / per);
        const local = best % per;
        return {
          at: index[best] ?? sec,
          url: images[page] ?? images[0],
          x: (local % cols) * w,
          y: Math.floor(local / cols) * h,
          w,
          h,
        };
      },
    };
    this.mediaCache.set(key, { at: Date.now(), sheet });
    return sheet;
  }

  /**
   * 裁一格。没有图片库，就借无头浏览器：把精灵图铺上去，截视口那么大一块。
   * 浏览器懒启动、闲置 3 分钟自己关，不常驻。
   */
  async cropSprite(cell) {
    const page = await this.spritePage();
    const raw = await this.fetchRaw(cell.url, { binary: true });
    if (!raw?.length) return null;
    const b64 = Buffer.from(raw).toString('base64');
    await page.setViewportSize({ width: cell.w, height: cell.h });
    await page.setContent(
      `<style>html,body{margin:0;padding:0;background:#000;overflow:hidden}` +
        `img{position:absolute;left:${-cell.x}px;top:${-cell.y}px}</style>` +
        `<img src="data:image/jpeg;base64,${b64}">`,
      { waitUntil: 'load' },
    );
    return await page.screenshot({ type: 'jpeg', quality: 62, clip: { x: 0, y: 0, width: cell.w, height: cell.h } });
  }

  async spritePage() {
    if (this._spritePage && !this._spritePage.isClosed()) {
      clearTimeout(this._spriteIdle);
      this._spriteIdle = this.spriteIdleTimer();
      return this._spritePage;
    }
    const browser = await launchHeadless(this.dataDir);
    const page = await browser.newPage({ viewport: { width: 160, height: 90 }, locale: 'zh-CN' });
    this._spriteBrowser = browser;
    this._spritePage = page;
    this._spriteIdle = this.spriteIdleTimer();
    return page;
  }

  spriteIdleTimer() {
    const timer = setTimeout(() => this.closeSprite(), 3 * 60 * 1000);
    timer.unref?.();
    return timer;
  }

  async closeSprite() {
    clearTimeout(this._spriteIdle);
    this._spriteIdle = null;
    const browser = this._spriteBrowser;
    this._spriteBrowser = null;
    this._spritePage = null;
    await browser?.close().catch(() => {});
  }

  /** 弹幕：comment.bilibili.com/{cid}.xml 是 raw-deflate 的 XML，解压后按 <d p="..."> 读。 */
  async danmakuOf(cid) {
    const buf = await this.fetchRaw(`https://comment.bilibili.com/${cid}.xml`, { binary: true });
    if (!buf) return [];
    let xml = '';
    try {
      xml = zlib.inflateRawSync(buf).toString('utf8');
    } catch {
      xml = buf.toString('utf8');
    }
    const out = [];
    for (const m of xml.matchAll(/<d p="([^"]*)"[^>]*>([\s\S]*?)<\/d>/g)) {
      const parts = m[1].split(',');
      const at = Number(parts[0]);
      if (!Number.isFinite(at)) continue;
      const text = unescapeXml(m[2]).trim();
      if (!text) continue;
      out.push({
        t: Math.round(at * 10) / 10,
        mode: Number(parts[1]) || 1,
        color: Number(parts[3]) || 0xffffff,
        text: cutChars(text, 50),
      });
    }
    return out.sort((a, b) => a.t - b.t);
  }

  async fetchRaw(url, { binary = false, timeout = 8000 } = {}) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          Referer: 'https://www.bilibili.com/',
          ...(this.cookieHeader() ? { Cookie: this.cookieHeader() } : {}),
        },
        signal: ctl.signal,
      });
      if (!res.ok) return null;
      return binary ? Buffer.from(await res.arrayBuffer()) : await res.text();
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async fetchJson(url) {
    const text = await this.fetchRaw(url);
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  async open(id, { comments = 5 } = {}) {
    const v = await this.view(id);
    let top = [];
    try {
      top = await this.replyList(1, v.aid, comments);
    } catch {
      top = [];
    }
    return {
      platform: 'bilibili',
      kind: 'video',
      id: v.bvid,
      title: truncate(v.title, 80),
      author: v.author,
      dur: formatDuration(v.duration),
      stat: `${formatCount(v.stat.like)}赞 · ${formatCount(v.stat.view)}播 · ${formatCount(v.stat.reply)}评`,
      desc: truncate(v.desc, 300),
      tags: v.tags,
      url: v.url,
      comments: top.map(replyView),
      note: 'B站返回的是文字和热评，没有画面；要看画面用「陪看」插件。',
    };
  }

  /** 一条动态：正文、作者、评论区的真实 oid/type，后面回复要用。 */
  async dynamic(id) {
    const dynId = parseDynamicId(id) ?? '';
    if (!dynId) throw new BiliError('BAD_ID', '不是有效的动态链接/ID');
    const url = `https://t.bilibili.com/${dynId}`;
    const data = await this.request(
      '/x/polymer/web-dynamic/v1/detail',
      { id: dynId, timezone_offset: -480 },
      { cacheMs: 60 * 1000, referer: url },
    );
    const item = data?.item;
    if (!item) throw new BiliError('NO_DYNAMIC', '这条动态看不到（可能删了、或者只给粉丝看）。');
    const { oid, type: commentType } = commentTargetOf(item);
    const stat = item.modules?.module_stat ?? {};
    const author = item.modules?.module_author ?? {};
    const text = dynamicText(item);
    const dynType = String(item.type ?? '');
    const images = dynamicImages(item);
    const fallback = {
      DYNAMIC_TYPE_DRAW: images.length ? `图片动态（${images.length} 张图）` : '图片动态',
      DYNAMIC_TYPE_WORD: '文字动态',
      DYNAMIC_TYPE_AV: '视频动态',
      DYNAMIC_TYPE_ARTICLE: '专栏动态',
      DYNAMIC_TYPE_FORWARD: '转发动态',
    }[dynType] ?? '一条动态';
    return {
      kind: 'opus',
      id: String(item.id_str ?? dynId),
      type: dynType,
      oid,
      commentType,
      title: truncate(text || `${author.name ?? ''} · ${fallback}`, 80),
      text: truncate(text, 500),
      author: stripTags(author.name ?? ''),
      authorId: String(author.mid ?? ''),
      pubdate: Number(author.pub_ts ?? 0),
      images,
      stat: {
        like: Number(stat.like?.count ?? 0),
        comment: Number(stat.comment?.count ?? 0),
        forward: Number(stat.forward?.count ?? 0),
      },
      url,
    };
  }

  async openDynamic(id, { comments = 5 } = {}) {
    const d = await this.dynamic(id);
    let top = [];
    if (d.oid) {
      try {
        top = await this.replyList(d.commentType, d.oid, comments);
      } catch {
        top = [];
      }
    }
    return {
      platform: 'bilibili',
      kind: 'opus',
      id: d.id,
      title: d.title,
      author: d.author,
      stat: `${formatCount(d.stat.comment)}评 · ${formatCount(d.stat.like)}赞`,
      desc: d.text,
      tags: [],
      url: d.url,
      comments: top.map(replyView),
      note: '这是 B站动态，不是视频；评论区能看，也能在面板里直接回。',
    };
  }

  /** 专栏：只读标题和摘要，正文不抓，省流量。 */
  async article(id) {
    const cvid = parseCvid(id) ?? '';
    if (!cvid) throw new BiliError('BAD_ID', '不是有效的专栏链接/ID');
    const data = await this.request(
      '/x/article/viewinfo',
      { id: cvid },
      { cacheMs: 5 * 60 * 1000, referer: `https://www.bilibili.com/read/cv${cvid}` },
    );
    const title = stripTags(data.title ?? '');
    const text = stripTags(data.summary ?? '');
    return {
      kind: 'article',
      id: cvid,
      oid: cvid,
      commentType: 12,
      title: truncate(title || `专栏 cv${cvid}`, 80),
      text: truncate(text, 500),
      author: stripTags(data.author_name ?? ''),
      authorId: String(data.mid ?? ''),
      pubdate: Number(data.publish_time ?? 0),
      stat: {
        like: Number(data.stats?.like ?? 0),
        comment: Number(data.stats?.reply ?? 0),
        view: Number(data.stats?.view ?? 0),
      },
      url: `https://www.bilibili.com/read/cv${cvid}`,
    };
  }

  async openArticle(id, { comments = 5 } = {}) {
    const a = await this.article(id);
    let top = [];
    try {
      top = await this.replyList(12, a.oid, comments);
    } catch {
      top = [];
    }
    return {
      platform: 'bilibili',
      kind: 'article',
      id: a.id,
      title: a.title,
      author: a.author,
      stat: `${formatCount(a.stat.comment)}评 · ${formatCount(a.stat.view)}读`,
      desc: a.text,
      tags: [],
      url: a.url,
      comments: top.map(replyView),
      note: '这是 B站专栏，评论区能看也能回。',
    };
  }

  /**
   * 评论区通用读取。type 见 B站：1 视频、11 图文动态、12 专栏、17 转发动态。
   * sort: 2 按热度，0 按时间。
   */
  async replyList(type, oid, limit = 5, sort = 2, cacheMs = 60 * 1000, page = 1) {
    const data = await this.request(
      '/x/v2/reply',
      { type: Number(type) || 1, oid: String(oid), sort, ps: Math.min(20, Math.max(1, limit)), pn: page },
      { cacheMs },
    );
    return (data.replies ?? []).slice(0, limit).map((r) => ({
      rpid: String(r.rpid),
      author: stripTags(r.member?.uname ?? ''),
      uid: String(r.member?.mid ?? ''),
      text: stripTags(r.content?.message ?? ''),
      like: Number(r.like ?? 0),
      root: String(r.root ?? 0),
      parent: String(r.parent ?? 0),
      at: Number(r.ctime ?? 0),
      // 评论里真正 @ 到的人（不是正文里那个 @ 字符）
      mentions: (r.content?.members ?? []).map((m) => String(m.mid ?? '')),
      // 带图评论：B站把图片放在 content.pictures[].img_src
      pictures: (r.content?.pictures ?? [])
        .map((p) => String(p?.img_src ?? ''))
        .filter((u) => /^https?:/.test(u)),
    }));
  }

  async comments(aid, limit = 5) {
    return this.replyList(1, aid, limit);
  }

  /** 找一条评论：先按热度翻（消息里多半是热评），再按时间补一遍。 */
  async findReply(type, oid, rpid, pages = 2) {
    for (const sort of [2, 0]) {
      for (let page = 1; page <= pages; page++) {
        const list = await this.replyList(type, oid, 20, sort, page === 1 ? 30 * 1000 : 0, page);
        const hit = list.find((c) => c.rpid === String(rpid));
        if (hit) return hit;
        if (list.length < 20) break;
      }
    }
    return null;
  }

  /** 面板点「看评论」：不管链接是视频、动态还是专栏，都返回同一个形状。 */
  async commentsOf(raw, limit = 10) {
    const link = String(raw ?? '').trim();
    const bvid = parseBvid(link);
    if (bvid) {
      const v = await this.view(bvid);
      return {
        kind: 'video',
        id: v.bvid,
        oid: v.aid,
        commentType: 1,
        title: v.title,
        url: v.url,
        total: v.stat.reply,
        items: await this.replyList(1, v.aid, limit),
      };
    }
    const dyn = parseDynamicId(link);
    if (dyn) {
      const d = await this.dynamic(dyn);
      return {
        kind: 'opus',
        id: d.id,
        oid: d.oid,
        commentType: d.commentType,
        title: d.title,
        url: d.url,
        total: d.stat.comment,
        items: d.oid ? await this.replyList(d.commentType, d.oid, limit) : [],
      };
    }
    const cvid = parseCvid(link);
    if (cvid) {
      const a = await this.article(cvid);
      return {
        kind: 'article',
        id: a.id,
        oid: a.oid,
        commentType: 12,
        title: a.title,
        url: a.url,
        total: a.stat.comment,
        items: await this.replyList(12, a.oid, limit),
      };
    }
    throw new BiliError('BAD_ID', '这个链接不是 B站视频/动态/专栏。');
  }

  /** 私信会话列表。只认文字消息（msg_type 1），系统卡片和推荐位不混进来。 */
  async dmSessions(limit = 8, { fresh = false } = {}) {
    const data = await this.request(
      '/session_svr/v1/session_svr/get_sessions',
      { session_type: 1, group_id: 0, mobi_app: 'web', build: 0, platform: 'web' },
      {
        base: 'https://api.vc.bilibili.com',
        // 监听私信时不能吃缓存：30 秒的旧数据看起来就是「收不到消息」
        cacheMs: fresh ? 0 : 30 * 1000,
        referer: 'https://message.bilibili.com/',
        origin: 'https://message.bilibili.com',
      },
    );
    const list = (data.session_list ?? [])
      .map((s) => {
        const last = s.last_msg ?? {};
        const msgType = Number(last.msg_type ?? 0);
        let body = '';
        try {
          body = JSON.parse(last.content ?? '{}').content ?? '';
        } catch {
          body = '';
        }
        body = stripTags(body);
        // 主人发的是图片/表情/分享时正文是空的：以前会被过滤掉，
        // 看起来就是「发了消息她没反应」。这里给个占位，别把会话整条丢掉。
        if (!body && msgType > 1) body = msgType === 2 ? '[图片]' : msgType === 3 ? '[表情]' : '[分享]';
        return {
          talkerId: String(s.talker_id ?? ''),
          unread: Number(s.unread_count ?? 0),
          at: Number(last.timestamp ?? 0),
          msgType,
          senderUid: String(last.sender_uid ?? ''),
          seqno: String(s.max_seqno ?? ''),
          body,
          fromThem: String(last.sender_uid ?? '') === String(s.talker_id ?? ''),
        };
      })
      .filter((x) => x.talkerId && x.msgType > 0 && x.at > 0)
      .sort((a, b) => b.at - a.at)
      .slice(0, Math.max(1, limit));
    return list;
  }

  /** 把某个会话标成已读；B站那边的红点才会消。失败就算了，不影响收发。 */
  async dmAck(talkerId, ackSeqno) {
    if (!talkerId || !ackSeqno) return false;
    try {
      await this.request(
        '/session_svr/v1/session_svr/update_ack',
        { talker_id: String(talkerId), session_type: 1, ack_seqno: String(ackSeqno) },
        {
          post: true,
          base: 'https://api.vc.bilibili.com',
          cacheMs: 0,
          referer: 'https://message.bilibili.com/',
          origin: 'https://message.bilibili.com',
        },
      );
      return true;
    } catch {
      return false;
    }
  }

  /** 批量取昵称，省得一条私信查一次空间（那个接口很容易 412）。 */
  async userCards(uids) {
    const list = [...new Set((uids ?? []).map(String).filter((x) => /^\d+$/.test(x)))];
    if (!list.length) return {};
    const data = await this.request(
      '/account/v1/user/cards',
      { uids: list.join(',') },
      {
        base: 'https://api.vc.bilibili.com',
        cacheMs: 6 * 60 * 60 * 1000,
        referer: 'https://message.bilibili.com/',
        origin: 'https://message.bilibili.com',
      },
    );
    const out = {};
    for (const u of data ?? []) out[String(u.mid ?? '')] = stripTags(u.name ?? '');
    return out;
  }

  /** 和某个人的最近几条私信；默认按时间正序，方便直接接在面板里看。 */
  async dmThread(talkerId, size = 10) {
    const data = await this.request(
      '/svr_sync/v1/svr_sync/fetch_session_msgs',
      { talker_id: String(talkerId), session_type: 1, size: Math.min(30, Math.max(1, size)), build: 0, mobi_app: 'web', platform: 'web' },
      {
        base: 'https://api.vc.bilibili.com',
        cacheMs: 0,
        referer: 'https://message.bilibili.com/',
        origin: 'https://message.bilibili.com',
      },
    );
    return (data.messages ?? [])
      .map((m) => {
        let obj = {};
        try {
          obj = JSON.parse(m.content ?? '{}') ?? {};
        } catch {
          obj = {};
        }
        const body = obj.content ?? '';
        // msg_type 2 = 图片；图片消息的 URL 在 content.url 里
        const type = Number(m.msg_type ?? 0);
        const pic = String(obj.url ?? '') || String(Array.isArray(obj.image_urls) ? obj.image_urls[0] : '');
        const isPic = type === 2 || (!body && /^https?:/.test(pic));
        return {
          at: Number(m.timestamp ?? 0) * 1000,
          from: String(m.sender_uid ?? ''),
          type,
          text: stripTags(body) || (isPic ? '[图片]' : ''),
          image: isPic ? pic : '',
          key: String(m.msg_key ?? ''),
        };
      })
      .filter((m) => m.text)
      .sort((a, b) => a.at - b.at);
  }

  /** 下载一张图（B站图床一般不需要 cookie，带 Referer 就够）。 */
  async imageBytes(url) {
    const u = String(url ?? '').trim();
    if (!/^https?:/.test(u)) return null;
    try {
      const r = await fetch(u, {
        headers: {
          Referer: 'https://www.bilibili.com/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
        },
      });
      if (!r.ok) return null;
      const buf = Buffer.from(await r.arrayBuffer());
      return buf.length ? buf : null;
    } catch {
      return null;
    }
  }

  /**
   * 只读「@我的」：评论区里有人 @ 她。
   * inbox 会把私信也混进来，还带一串私信会话请求；轮询用这个更轻。
   */
  async mentions(limit = 6) {
    // 不走缓存：这是轮询用的，缓存会让刚 @ 的一分钟内看不到
    const data = await this.request('/x/msgfeed/at', { platform: 'web', build: 0, mobi_app: 'web' }, { cacheMs: 0 });
    return (data.items ?? [])
      .map((item) => mapMsgFeedItem('at', item))
      .filter(Boolean)
      .slice(0, Math.max(1, limit));
  }

  async inbox(limit = 8) {
    const out = [];
    for (const [kind, route] of [
      ['reply', '/x/msgfeed/reply'],
      ['at', '/x/msgfeed/at'],
    ]) {
      try {
        const data = await this.request(route, { platform: 'web', build: 0, mobi_app: 'web' }, { cacheMs: 60000 });
        for (const item of data.items ?? []) {
          const mapped = mapMsgFeedItem(kind, item);
          if (mapped) out.push(mapped);
        }
      } catch {
        // 一类读不到不影响另一类
      }
    }
    // 私信：以前完全没读，所以主人发过来她永远「收不到」
    try {
      const sessions = await this.dmSessions(Math.min(6, Math.max(2, limit)));
      if (sessions.length) {
        const cards = await this.userCards(sessions.map((x) => x.talkerId)).catch(() => ({}));
        for (const s of sessions) {
          out.push({
            kind: 'dm',
            platform: 'bilibili',
            type: 'dm',
            id: `dm:${s.talkerId}`,
            user: cards[s.talkerId] || `UID ${s.talkerId}`,
            mid: s.talkerId,
            text: truncate(s.fromThem ? s.body : `（我最后说）${s.body}`, 140),
            quote: '',
            where: s.unread > 0 ? `${s.unread} 条未读` : '私信',
            at: s.at,
            url: `https://message.bilibili.com/#/whisper/mid${s.talkerId}`,
            bvid: '',
            dynamicId: '',
            cvid: '',
            rpid: '0',
            rootRpid: '0',
            unread: s.unread,
            ackSeqno: s.seqno,
            fromThem: s.fromThem,
            likeState: false,
          });
        }
      }
    } catch {
      // 私信读不到不影响评论/@
    }

    const seen = new Set();
    return out
      .sort((a, b) => b.at - a.at)
      .filter((x) => {
        if (seen.has(x.id)) return false;
        seen.add(x.id);
        return true;
      })
      .slice(0, limit);
  }

  async relation(uid) {
    try {
      const data = await this.request('/x/relation', { fid: String(uid) }, { cacheMs: 0 });
      return Number(data.attribute ?? 0) >= 2;
    } catch {
      return null;
    }
  }

  async like(bvid, on = true) {
    await this.view(bvid);
    const has = () =>
      this.request('/x/web-interface/archive/has/like', { bvid }, { cacheMs: 0 })
        .then((d) => Number(d?.data ?? d) === 1)
        .catch(() => null);
    const before = await has();
    if (before === on) return { ok: true, already: true, liked: on };
    let data;
    try {
      data = await this.request(
        '/x/web-interface/archive/like',
        { bvid, like: on ? 1 : 2 },
        { post: true, cacheMs: 0, referer: `https://www.bilibili.com/video/${bvid}` },
      );
    } catch (error) {
      // 65006 = 重复点赞：服务端已经是这个状态，按成功算
      if (/65006|重复/.test(String(error?.message ?? ''))) return { ok: true, already: true, liked: on };
      throw error;
    }
    const after = await has();
    return { ok: true, liked: on, confirmed: after == null ? false : after === on, data };
  }

  async follow(uid, on = true) {
    const already = await this.relation(uid);
    if (on && already === true) return { ok: true, already: true, following: true };
    if (!on && already === false) return { ok: true, already: true, following: false };
    await this.request(
      '/x/relation/modify',
      { fid: String(uid), act: on ? 1 : 2, re_src: 11 },
      { post: true, cacheMs: 0, referer: `https://space.bilibili.com/${uid}` },
    );
    const after = await this.relation(uid);
    return { ok: true, following: after === true, confirmed: after == null ? false : after === on };
  }

  async save(bvid) {
    const v = await this.view(bvid);
    await this.request(
      '/x/v2/history/toview/add',
      { aid: v.aid },
      { post: true, cacheMs: 0, referer: v.url },
    );
    return { ok: true, saved: true };
  }

  async ownerName(uid) {
    const known = String(this.cfg.ownerName ?? '').trim();
    if (!uid) return known;
    try {
      const data = await this.request(
        '/x/space/wbi/acc/info',
        { mid: String(uid) },
        { wbi: true, cacheMs: 24 * 60 * 60 * 1000, referer: `https://space.bilibili.com/${uid}` },
      );
      return stripTags(data.name ?? '') || known;
    } catch {
      return known;
    }
  }

  /**
   * 发评论/回复。视频、动态、专栏的 oid/type 不一样，先各自解析成同一个形状再发。
   * 动态必须读一次详情：图文动态的评论区 oid 是相册 id，不是动态 id。
   */
  async comment({ bvid, dynamicId, articleId, oid, replyType, text, root = '', parent = '', mentionOwner = false }) {
    let target;
    if (bvid) {
      const v = await this.view(bvid);
      target = { kind: 'video', id: v.bvid, oid: v.aid, type: 1, url: v.url };
    } else if (dynamicId) {
      const d = await this.dynamic(dynamicId);
      if (!d.oid) throw new BiliError('NO_COMMENT', '这条动态没开评论区。');
      target = { kind: 'opus', id: d.id, oid: d.oid, type: d.commentType, url: d.url };
    } else if (articleId) {
      const a = await this.article(articleId);
      target = { kind: 'article', id: a.id, oid: a.oid, type: 12, url: a.url };
    } else if (oid && replyType) {
      target = { kind: 'plain', id: String(oid), oid: String(oid), type: Number(replyType) || 17, url: '' };
    } else {
      throw new BiliError('BAD_ID', '没给要评论的视频/动态/专栏。');
    }

    const ownerUid = String(this.cfg.ownerUid ?? '').trim();
    let mention = '';
    let bodyText = String(text ?? '');
    const atNameToMid = {};
    if (mentionOwner && ownerUid) {
      const name = await this.ownerName(ownerUid);
      if (name) {
        // 正文里如果已经写了「@昵称」，再前置一个就成了 @ 两次（实测 2026-11 动态里
        // 就是「@阿柚 … @阿柚还在玩」）。剥得干净才前置；正文本来就只是 @昵称 的，
        // 不前置、靠下面的 at_name_to_mid 把正文里那个变成真 @。
        const clean = stripAtName(bodyText, name);
        if (clean) {
          bodyText = clean;
          mention = `@${name} `;
        }
        // 关键：光在正文里写 @昵称 只是纯文本，B站不会真的提到人、也不会发通知。
        // 必须随请求带上 at_name_to_mid（{"昵称": mid}），服务端才会把它变成真 @。
        atNameToMid[name] = Number(ownerUid);
      }
    }
    const message = `${mention}${bodyText}`.slice(0, Number(this.cfg.commentMaxChars ?? 120) + 20);
    const body = {
      oid: target.oid,
      type: target.type,
      message,
      plat: 1,
      ...(root ? { root: String(root) } : {}),
      ...(parent ? { parent: String(parent) } : {}),
      ...(Object.keys(atNameToMid).length ? { at_name_to_mid: JSON.stringify(atNameToMid) } : {}),
    };
    const data = await this.request('/x/v2/reply/add', body, {
      post: true,
      cacheMs: 0,
      minGapMs: 150,
      referer: target.url || ORIGIN,
      origin: ORIGIN,
    });
    const rpid = String(data.rpid ?? '');
    const members = data.reply?.content?.members ?? [];
    let mentioned = null;
    if (mentionOwner && ownerUid) {
      // add 接口的响应不一定带 members，先看，看不到就发布后回查一次
      mentioned = members.some((m) => String(m.mid ?? '') === ownerUid) ? true : null;
    }
    /**
     * 以前这里固定 sleep(1200) 再回查可见性——评论慢 1.2 秒全耗在这。
     * 现在：只有「@ 了主人、但响应里看不出有没有 @ 上」才回查一次；
     * 其它情况拿到 rpid 就算发出去了，可见性交给面板的 inbox/comments 后看。
     */
    let visibility = 'unchecked';
    if (rpid && mentionOwner && mentioned === null) {
      try {
        const pub = await this.replyList(target.type, target.oid, 20, 0, 0);
        const mine = pub.find((r) => r.rpid === rpid);
        visibility = mine ? 'public' : 'unknown';
        if (mine) mentioned = (mine.mentions ?? []).includes(ownerUid);
      } catch {
        visibility = 'unknown';
      }
    }
    return {
      ok: true,
      kind: target.kind,
      targetId: target.id,
      url: target.url,
      rpid,
      mentioned,
      visibility,
      message,
      aid: target.kind === 'video' ? target.oid : undefined,
      oid: target.oid,
      type: target.type,
    };
  }

  async post({ text, mentionOwner = false }) {
    const ownerUid = String(this.cfg.ownerUid ?? '').trim();
    const contents = [];
    let bodyText = String(text ?? '');
    if (mentionOwner && ownerUid) {
      const name = await this.ownerName(ownerUid);
      if (name) {
        // 同上：正文自带「@昵称」时先剥掉，否则动态里会出现两个 @。
        const clean = stripAtName(bodyText, name);
        if (clean) {
          bodyText = clean;
          contents.push({ raw_text: `@${name} `, type: 2, biz_id: ownerUid });
        }
      }
    }
    contents.push({ raw_text: bodyText, type: 1, biz_id: '' });
    const body = {
      dyn_req: {
        content: { contents },
        scene: 1,
        meta: { app_meta: { from: 'create.dynamic.web', mobi_app: 'web' } },
      },
    };
    const data = await this.request('/x/dynamic/feed/create/dyn', body, {
      post: true,
      wbi: true,
      csrfQuery: true,
      json: true,
      cacheMs: 0,
      referer: 'https://t.bilibili.com/',
    });
    return {
      ok: true,
      dynamicId: String(data.dynamic_id_str ?? data.dynamic_id ?? ''),
      url: data.dynamic_id_str ? `https://t.bilibili.com/${data.dynamic_id_str}` : 'https://t.bilibili.com/',
    };
  }

  async dm(uid, text) {
    // 登录信息 5 分钟缓存就够了，没必要每发一条都强制拉一次 nav（省一个 650ms 的请求）
    const nav = await this.nav();
    if (!nav?.isLogin || !nav.mid) throw new BiliError('LOGIN_REQUIRED', '发私信需要 B站登录');
    if (!uid) throw new BiliError('NO_OWNER', '没设主人 UID');
    if (String(uid) === String(nav.mid)) {
      throw new BiliError('SELF_DM', '这个账号就是主人自己，私信自己没意义；用桌面说或者换个桌宠小号。');
    }
    const devId = this.storeDeviceId();
    const body = {
      'msg[sender_uid]': String(nav.mid),
      'msg[receiver_id]': String(uid),
      'msg[receiver_type]': 1,
      'msg[msg_type]': 1,
      'msg[msg_status]': 0,
      'msg[content]': JSON.stringify({ content: String(text).slice(0, 500) }),
      'msg[dev_id]': devId,
      'msg[timestamp]': Math.floor(Date.now() / 1000),
    };
    const data = await this.request('/web_im/v1/web_im/send_msg', body, {
      post: true,
      base: 'https://api.vc.bilibili.com',
      cacheMs: 0,
      minGapMs: 120,
      referer: 'https://message.bilibili.com/',
      origin: 'https://message.bilibili.com',
    });
    return { ok: true, msgKey: String(data.msg_key ?? ''), sender: String(nav.mid), receiver: String(uid) };
  }

  /**
   * 私信接口要一个稳定的 dev_id：每次重启都换新的，B站会当成陌生设备，
   * 表现就是「发出去了但对面收不到」。所以生成一次就存进 state.json。
   */
  storeDeviceId() {
    if (this._deviceId) return this._deviceId;
    const data = this.store?.data ?? this.policy?.store?.data;
    if (!data) {
      this._deviceId = uuid();
      return this._deviceId;
    }
    if (!data.deviceId) {
      data.deviceId = uuid();
      try {
        (this.store ?? this.policy.store).save?.();
      } catch {
        // 存不了也先用着，至少本次进程内稳定
      }
    }
    this._deviceId = String(data.deviceId);
    return this._deviceId;
  }

  /** 给面板/工具用的 compact 状态。 */
  async status() {
    const h = await this.health();
    return {
      platform: 'bilibili',
      ok: h.loggedIn,
      loggedIn: h.loggedIn,
      name: h.name,
      uid: h.uid,
      cookie: h.cookie,
      note: h.loggedIn ? `已登录：${h.name}` : h.cookie ? '登录态失效或接口不通' : '未登录（只能读公开内容）',
    };
  }
}


/**
 * 字幕分段抽样：把整条字幕按时间切成几段，每段取开头几条**连续**字幕。
 * 为什么不像弹幕那样单句散抽：字幕是台词，单句抽出来没有上下文；连续 2-3 句才看得懂那段在干嘛。
 * 为什么按字幕自己的时间轴切而不是视频时长：很多视频的字幕只覆盖一部分，
 * 按视频时长切会有整段落在没字幕的地方。
 */
function sampleSubtitles(list, limit) {
  if (!list.length || limit <= 0) return { lines: [], segments: 0, sampled: false };
  if (list.length <= limit) return { lines: list.slice(), segments: 1, sampled: false };
  const perSeg = limit >= 6 ? 3 : 2;
  const segs = Math.max(1, Math.min(Math.floor(limit / perSeg), list.length));
  const from = Number(list[0]?.from ?? 0);
  const last = list[list.length - 1];
  const to = Number(last?.to ?? last?.from ?? from);
  const span = Math.max(0, to - from);
  const out = [];
  const seen = new Set();
  for (let i = 0; i < segs && out.length < limit; i += 1) {
    // 段首均摊到「开头 → 结尾」之间：最后一段贴着结尾，不然 10 分钟的视频最后一抽只到 7:30
    const denom = segs > 1 ? segs - 1 : 1;
    const target = from + (span * i) / denom;
    let idx = list.findIndex((x) => Number(x.from ?? 0) >= target - 0.001);
    if (idx < 0) idx = list.length - 1;
    idx = Math.min(idx, Math.max(0, list.length - perSeg));
    for (let k = 0; k < perSeg && idx + k < list.length && out.length < limit; k += 1) {
      const line = list[idx + k];
      const key = `${line.from}|${line.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(line);
    }
  }
  out.sort((a, b) => a.from - b.from);
  return { lines: out, segments: segs, sampled: true };
}

/** 字幕总字数上限：超了就按条数匀着截断，保住「覆盖到结尾」，而不是把后半段整段砍掉。 */
function capSubtitleChars(list, maxChars) {
  const cap = Math.max(200, Number(maxChars) || 1500);
  const count = (arr) => arr.reduce((n, x) => n + [...String(x.text ?? '')].length, 0);
  if (count(list) <= cap) return { lines: list, chars: count(list), truncated: false };
  const allowance = Math.max(12, Math.floor(cap / Math.max(1, list.length)));
  const lines = list.map((x) => ({ ...x, text: cutChars(String(x.text ?? ''), allowance) }));
  return { lines, chars: count(lines), truncated: true };
}

/** 弹幕里同名刷屏太多：按时间均匀抽，再按文字去重。 */
function sampleDanmaku(list, limit) {
  if (!list.length) return [];
  if (list.length <= limit) return list.slice();
  const step = list.length / limit;
  const out = [];
  const seen = new Set();
  for (let i = 0; i < limit; i += 1) {
    const item = list[Math.min(list.length - 1, Math.floor(i * step))];
    if (!item || seen.has(item.text)) continue;
    seen.add(item.text);
    out.push(item);
  }
  return out;
}

function unescapeXml(text) {
  return String(text ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}
