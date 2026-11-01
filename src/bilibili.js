import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  formatCount,
  formatDuration,
  parseBvid,
  parseCvid,
  parseDynamicId,
  parseKeywords,
  stripTags,
  truncate,
  uuid,
} from './util.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const ORIGIN = 'https://www.bilibili.com';
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

  /**
   * 从 摸鱼 自己的浏览器窗口里收 B站 cookie。
   * 只在主人主动点「登录 B站」后调用；不会去碰系统浏览器的资料。
   */
  async importFromContext(context) {
    if (!context) return null;
    const cookies = await context.cookies('https://www.bilibili.com').catch(() => []);
    const sess = cookies.find((c) => c.name === 'SESSDATA');
    const jct = cookies.find((c) => c.name === 'bili_jct');
    if (!sess?.value || !jct?.value) return null;
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
    return nav?.isLogin ? { loggedIn: true, uid: String(nav.mid ?? ''), name: nav.uname ?? '' } : null;
  }

  readCredentials() {
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

    const wait = Math.max(0, this.lastRequest + 650 - Date.now());
    if (wait) await new Promise((r) => setTimeout(r, wait));
    this.lastRequest = Date.now();

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
      this.policy.noteRisk(String(res.status), 'B站要求冷却');
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
        this.policy.noteRisk(String(data.code), data.message || 'B站风控');
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

  async inbox(limit = 8) {
    const out = [];
    for (const [kind, route] of [
      ['reply', '/x/msgfeed/reply'],
      ['at', '/x/msgfeed/at'],
    ]) {
      try {
        const data = await this.request(route, { platform: 'web', build: 0, mobi_app: 'web' }, { cacheMs: 60000 });
        for (const item of data.items ?? []) {
          const msg = item.item ?? {};
          const content = stripTags(msg.source_content || msg.message || msg.desc || '');
          if (!content) continue;
          const link = String(msg.uri ?? '');
          const rpid = String(msg.source_id ?? '') || String(msg.target_id ?? '') || '0';
          const rootRpid = String(msg.root_id ?? '') || '0';
          out.push({
            kind,
            platform: 'bilibili',
            type: inferMsgType(link, msg.type),
            id: String(item.id ?? ''),
            user: stripTags(item.user?.nickname ?? ''),
            mid: String(item.user?.mid ?? ''),
            text: truncate(content, 140),
            quote: truncate(stripTags(msg.target_reply_content || ''), 80),
            where: truncate(stripTags(msg.title || msg.desc || ''), 60),
            at: Number(item.reply_time ?? item.time ?? 0),
            url: commentDeepLink(link, rootRpid, rpid),
            bvid: bvidOf(link),
            dynamicId: parseDynamicId(link),
            cvid: parseCvid(link),
            rpid,
            rootRpid,
            likeState: Number(msg.like_state ?? 0) === 1,
          });
        }
      } catch {
        // 一类读不到不影响另一类
      }
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

  async hasLike(bvid) {
    try {
      const data = await this.request('/x/web-interface/archive/has/like', { bvid }, { cacheMs: 0 });
      return Number(data) === 1;
    } catch {
      return null;
    }
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
    return { ok: true, liked: on, confirmed: after == null ? true : after === on, data };
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
    return { ok: true, following: after === true };
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
    if (mentionOwner && ownerUid) {
      const name = await this.ownerName(ownerUid);
      if (name) mention = `@${name} `;
    }
    const message = `${mention}${text}`.slice(0, Number(this.cfg.commentMaxChars ?? 120) + 20);
    const body = {
      oid: target.oid,
      type: target.type,
      message,
      plat: 1,
      ...(root ? { root: String(root) } : {}),
      ...(parent ? { parent: String(parent) } : {}),
    };
    const data = await this.request('/x/v2/reply/add', body, {
      post: true,
      cacheMs: 0,
      referer: target.url || ORIGIN,
      origin: ORIGIN,
    });
    const rpid = String(data.rpid ?? '');
    const members = data.reply?.content?.members ?? [];
    const mentioned = !mentionOwner || !ownerUid ? null : members.some((m) => String(m.mid ?? '') === ownerUid);
    let visibility = 'unknown';
    if (rpid) {
      await new Promise((r) => setTimeout(r, 1200));
      try {
        const pub = await this.replyList(target.type, target.oid, 20, 0, 0);
        visibility = pub.some((r) => r.rpid === rpid) ? 'public' : 'unknown';
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
    if (mentionOwner && ownerUid) {
      const name = await this.ownerName(ownerUid);
      if (name) {
        contents.push({ raw_text: `@${name} `, type: 2, biz_id: ownerUid });
      }
    }
    contents.push({ raw_text: text, type: 1, biz_id: '' });
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
    const nav = await this.nav(true);
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
      referer: 'https://message.bilibili.com/',
      origin: 'https://message.bilibili.com',
    });
    return { ok: true, msgKey: String(data.msg_key ?? ''), sender: String(nav.mid), receiver: String(uid) };
  }

  storeDeviceId() {
    if (!this._deviceId) this._deviceId = this.policy?.store?.data?.deviceId || uuid();
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
