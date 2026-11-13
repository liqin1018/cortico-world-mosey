/**
 * 摸鱼面板。
 * 只用宿主给的 ctx，不碰 window / document 全局（除了建节点）。
 * 结构：概览环 → 状态胶囊 → 额度条 → 后台逛/一起看双卡 → 账号 → 待批 → 这一条 → 最近/维护。
 */

const NS = 'http://www.w3.org/2000/svg';

const ICONS = {
  heart: 'M8 13.6S2.6 10.4 2.6 6.6A3.4 3.4 0 0 1 8 4.1a3.4 3.4 0 0 1 5.4 2.5c0 3.8-5.4 7-5.4 7Z',
  comment: 'M3 3.2h10v6.6H7.2L3.9 12.7V3.2Z',
  plus: 'M8 3.2v9.6M3.2 8h9.6',
  refresh: 'M13.2 8A5.2 5.2 0 1 1 11.6 4.4M13.4 2.9v3.1h-3.1',
  play: 'M5.4 3.4 12.6 8l-7.2 4.6V3.4Z',
  link: 'M6.4 9.6 9.6 6.4M6.8 5.2l.9-.9a2.6 2.6 0 0 1 3.7 3.7l-.9.9M9.2 10.8l-.9.9a2.6 2.6 0 0 1-3.7-3.7l.9-.9',
  brake: 'M8 2.2v5.6M4.2 4.6a5 5 0 1 0 7.6 0',
  shield: 'M8 2.2 12.9 4v4c0 3-2.4 5.1-4.9 6-2.5-.9-4.9-3-4.9-6V4L8 2.2Z',
  user: 'M8 8.2a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM3.2 13.4c0-2.2 2.1-3.6 4.8-3.6s4.8 1.4 4.8 3.6',
  spark: 'M8 2.6v2.2M8 11.2v2.2M2.6 8h2.2M11.2 8h2.2M4.2 4.2l1.5 1.5M10.3 10.3l1.5 1.5M11.8 4.2l-1.5 1.5M5.7 10.3l-1.5 1.5',
  check: 'M3.2 8.4 6.4 11.6 12.8 4.8',
  bookmark: 'M4.2 2.6h7.6v10.8L8 10.6l-3.8 2.8V2.6Z',
  down: 'M3.6 6.2 8 10.6l4.4-4.4',
  up: 'M3.6 9.8 8 5.4l4.4 4.4',
  close: 'M4 4l8 8M12 4l-8 8',
};

function icon(name, size = 14) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.4');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', ICONS[name] ?? ICONS.spark);
  svg.append(path);
  return svg;
}

function el(tag, text, cls) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (cls) node.className = cls;
  return node;
}

function button(label, onClick, variant = '') {
  const b = el('button', label, `stroll-btn ${variant}`.trim());
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

function iconButton(iconName, label, onClick, variant = '') {
  const b = el('button', undefined, `stroll-chipbtn ${variant}`.trim());
  b.type = 'button';
  b.append(icon(iconName, 13), el('span', label));
  b.addEventListener('click', onClick);
  return b;
}

function chip(text, tone = '') {
  const node = el('span', undefined, `stroll-chip ${tone}`.trim());
  node.append(el('i'), el('span', text));
  return node;
}

function sectionHead(title, hint, right) {
  const head = el('div', undefined, 'stroll-sec-head');
  const h = el('h3', title);
  head.append(h);
  if (hint) head.append(el('span', hint, 'stroll-sec-hint'));
  if (right) head.append(right);
  return head;
}

const METERS = [
  { key: 'like', label: '点赞' },
  { key: 'comment', label: '评论' },
  { key: 'dm', label: '私信' },
  { key: 'group', label: '群聊' },
  { key: 'follow', label: '关注' },
  { key: 'post', label: '发动态' },
];

const ACTION_LABEL = {
  like: '点赞',
  unlike: '取消赞',
  follow: '关注',
  unfollow: '取关',
  comment: '评论',
  reply: '回复',
  post: '发动态',
  dm: '私信',
  save: '稍后再看',
  open: '打开',
  risk: '风控停手',
};

const ACTION_TONE = {
  like: '#3b82f6',
  unlike: '#94a3b8',
  follow: '#0ea5a4',
  unfollow: '#94a3b8',
  comment: '#8b5cf6',
  reply: '#8b5cf6',
  post: '#f59e0b',
  dm: '#fe2c55',
  save: '#0ea5a4',
};

const PLATFORM_LABEL = { bilibili: 'B站', douyin: '抖音', system: '系统' };
const APPROVALS = [
  { value: 'dry_run', label: '只读' },
  { value: 'confirm', label: '全批准' },
  { value: 'auto_low_risk', label: '赞自动' },
  { value: 'auto_all', label: '按额度' },
];

const APPROVAL_HINT = {
  dry_run: '只读：所有公开动作都只写草稿，不发送。',
  confirm: '全批准：点赞/评论/关注/动态/私信都先停在草稿箱，等你点批准。',
  auto_low_risk: '赞自动：点赞直接发，其余仍等你批准。',
  auto_all: '按额度：所有公开动作都不再问你，直接按每日额度发。慎用。',
};

function clock(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n < 0) return '--:--';
  const m = Math.floor(n / 60);
  const s = Math.floor(n % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function hhmm(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 关注流里的时间：今天给几点，更早给月-日。 */
function whenShort(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return hhmm(ts);
  return `${d.getMonth() + 1}-${d.getDate()}`;
}

function ago(sec) {
  const n = Math.max(0, Number(sec) || 0);
  if (n < 60) return `${Math.floor(n)} 秒前`;
  if (n < 3600) return `${Math.floor(n / 60)} 分钟前`;
  return `${Math.floor(n / 3600)} 小时前`;
}

function cut(text, max) {
  const s = String(text ?? '');
  const chars = [...s];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : s;
}

/**
 * 路径太长会把三列网格撑爆、压到旁边「这周」上（2026-11 反馈）。
 * 显示只留最后两级，完整路径放 title，鼠标悬停能看到。
 */
function shortPath(dir, keep = 2) {
  const s = String(dir ?? '').trim();
  if (!s) return '';
  if (s.length <= 30) return s;
  const parts = s.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= keep) return s;
  const sep = s.includes('\\') ? '\\' : '/';
  return `…${sep}${parts.slice(-keep).join(sep)}`;
}

export default {
  panels: {
    stroll: {
      mount(ctx) {
        const root = el('div', undefined, 'stroll-panel');
        ctx.root.append(root);

        /* ---------------- 概览 ---------------- */
        const hero = el('section', undefined, 'stroll-hero');
        const heroText = el('div', undefined, 'stroll-hero-text');
        const kicker = el('div', undefined, 'stroll-kicker');
        const kickerDot = el('i');
        kicker.append(kickerDot, el('span', '摸鱼 · 出门看看'));
        const lede = el('p', undefined, 'stroll-lede');
        const chips = el('div', undefined, 'stroll-chips');
        heroText.append(kicker, el('h2', '今天想去哪儿'), lede, chips);

        const heroSide = el('div', undefined, 'stroll-hero-side');
        const ring = el('div', undefined, 'stroll-ring');
        const ringSvg = document.createElementNS(NS, 'svg');
        ringSvg.setAttribute('viewBox', '0 0 100 100');
        ringSvg.setAttribute('aria-hidden', 'true');
        const ringTrack = document.createElementNS(NS, 'circle');
        ringTrack.setAttribute('class', 'stroll-ring-track');
        for (const [k, v] of Object.entries({ cx: '50', cy: '50', r: '42' })) ringTrack.setAttribute(k, v);
        ringTrack.setAttribute('pathLength', '100');
        const ringFill = document.createElementNS(NS, 'circle');
        ringFill.setAttribute('class', 'stroll-ring-fill');
        for (const [k, v] of Object.entries({ cx: '50', cy: '50', r: '42' })) ringFill.setAttribute(k, v);
        ringFill.setAttribute('pathLength', '100');
        ringFill.setAttribute('stroke-dasharray', '100');
        ringFill.setAttribute('stroke-dashoffset', '100');
        ringSvg.append(ringTrack, ringFill);
        const ringCenter = el('div', undefined, 'stroll-ring-center');
        const ringNum = el('strong', '0');
        const ringCap = el('span', '/ 0');
        ringCenter.append(ringNum, ringCap);
        ring.append(ringSvg, ringCenter);
        const refreshBtn = button('刷新', () => refresh(), 'ghost xs');
        refreshBtn.prepend(icon('refresh', 12));
        heroSide.append(ring, refreshBtn);
        hero.append(heroText, heroSide);
        root.append(hero);

        const msg = el('div', undefined, 'stroll-msg');
        root.append(msg);

        /* ---------------- 正在看（常驻浮条 + 提醒） ---------------- */
        const live = el('section', undefined, 'stroll-live');
        live.style.display = 'none';
        const liveHead = el('div', undefined, 'stroll-live-head');
        const liveDot = el('span', undefined, 'stroll-live-dot');
        const liveLabel = el('span', '正在看', 'stroll-live-label');
        const livePlat = el('span', 'B站', 'stroll-live-plat bilibili');
        const liveElapsed = el('span', '已看 00:00', 'stroll-live-elapsed');
        liveHead.append(liveDot, liveLabel, livePlat, liveElapsed);
        const liveTitle = el('div', undefined, 'stroll-live-title');
        const liveMeta = el('div', undefined, 'stroll-live-meta');
        const liveMain = el('div', undefined, 'stroll-live-main');
        liveMain.append(liveHead, liveTitle, liveMeta);
        const liveActions = el('div', undefined, 'stroll-live-actions');
        const liveCome = button('我也看看', () => openPresence(), 'primary xs');
        const liveHide = button('收起', () => dismissPresence(), 'ghost xs');
        liveCome.prepend(icon('play', 11));
        liveActions.append(liveCome, liveHide);
        const liveTrack = el('div', undefined, 'stroll-live-track');
        const liveBar = el('i');
        liveTrack.append(liveBar);
        live.append(liveMain, liveActions, liveTrack);
        root.append(live);

        const toast = el('div', undefined, 'stroll-toast');
        root.append(toast);

        /* ---------------- 明细弹层 ---------------- */
        const sheet = el('div', undefined, 'stroll-sheet');
        sheet.hidden = true;
        const sheetCard = el('div', undefined, 'stroll-sheet-card');
        const sheetHead = el('div', undefined, 'stroll-sheet-head');
        const sheetTitle = el('h3');
        const sheetHint = el('span', undefined, 'stroll-sheet-hint');
        const sheetClose = el('button', undefined, 'stroll-sheet-x');
        sheetClose.type = 'button';
        sheetClose.title = '关闭';
        sheetClose.append(icon('close', 13));
        const sheetTitles = el('div', undefined, 'stroll-sheet-titles');
        sheetTitles.append(sheetTitle, sheetHint);
        sheetHead.append(sheetTitles, sheetClose);
        const sheetTabs = el('div', undefined, 'stroll-tabs stroll-sheet-tabs');
        sheetTabs.style.display = 'none';
        const sheetBody = el('div', undefined, 'stroll-sheet-body');
        sheetCard.append(sheetHead, sheetTabs, sheetBody);
        sheet.append(sheetCard);
        root.append(sheet);
        sheetClose.addEventListener('click', () => closeSheet());
        sheet.addEventListener('click', (e) => {
          if (e.target === sheet) closeSheet();
        });
        document.addEventListener('keydown', (e) => {
          if (e.key === 'Escape' && !sheet.hidden) closeSheet();
        });

        const barWrap = el('div', undefined, 'stroll-barwrap');
        const openBar = el('div', undefined, 'stroll-openbar');
        const modeSeg = el('div', undefined, 'stroll-mode');
        const modeOpen = el('button', '链接');
        const modeSearch = el('button', '搜 B站');
        modeOpen.type = 'button';
        modeSearch.type = 'button';
        modeOpen.classList.add('on');
        modeSeg.append(modeOpen, modeSearch);
        const input = el('input');
        input.type = 'text';
        input.placeholder = '粘贴 B站 / 抖音链接，她在后台看完再说话';
        input.className = 'stroll-openbar-input';
        const openBtn = button('打开', () => submitBar(), 'solid');
        openBar.append(modeSeg, input, openBtn);
        const results = el('div', undefined, 'stroll-results');
        results.style.display = 'none';
        barWrap.append(openBar, results);
        root.append(barWrap);
        let barMode = 'open';
        modeOpen.addEventListener('click', () => setBarMode('open'));
        modeSearch.addEventListener('click', () => setBarMode('search'));
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') submitBar();
          if (e.key === 'Escape') results.style.display = 'none';
        });

        /* ---------------- 今日额度 ---------------- */
        const meterSec = el('section', undefined, 'stroll-sec');
        const meterHint = el('span', undefined, 'stroll-sec-hint');
        const meterHead = el('div', undefined, 'stroll-sec-head');
        meterHead.append(el('h3', '今日额度'), meterHint);
        const meters = el('div', undefined, 'stroll-meters');

        const activityRow = el('div', undefined, 'stroll-activity');
        const activitySeg = el('div', undefined, 'stroll-seg stroll-activity-seg');
        const activityBtns = new Map();
        for (const [key, label] of [
          ['quiet', '安静'],
          ['normal', '日常'],
          ['lively', '活跃'],
          ['chatty', '话痨'],
        ]) {
          const b = el('button', label);
          b.type = 'button';
          b.title = {
            quiet: '一天 1 次，几乎不互动，只看看',
            normal: '一天 3 次，偶尔评一句',
            lively: '一天 5 次（约 90 分钟一次），看到喜欢的就评一句',
            chatty: '一天 8 次（约 60 分钟一次），评论额度最多',
          }[key];
          b.addEventListener('click', () => setActivity(key));
          activityBtns.set(key, b);
          activitySeg.append(b);
        }
        const activityNote = el('span', undefined, 'stroll-token');
        activityRow.append(el('span', '活跃度', 'stroll-activity-label'), activitySeg, activityNote);

        const rampRow = el('div', undefined, 'stroll-ramp');
        rampRow.style.display = 'none';
        const rampText = el('span');
        const rampOff = button('关掉保护', () => turnOffRamp(), 'ghost xs');
        rampRow.append(rampText, rampOff);

        meterSec.append(meterHead, activityRow, rampRow, meters);
        root.append(meterSec);

        /* ---------------- 后台逛 / 一起看 ---------------- */
        const duo = el('div', undefined, 'stroll-duo');

        const browse = el('article', undefined, 'stroll-card stroll-card-browse');
        const browseHead = el('div', undefined, 'stroll-card-head');
        const browseTitle = el('h4');
        browseTitle.append(el('span', '后台逛'), el('span', 'background', 'stroll-en'));
        const browseState = el('span', undefined, 'stroll-state');
        browseHead.append(browseTitle, browseState);
        const browseDesc = el(
          'p',
          '不开网页、不抢鼠标。按兴趣自己刷，只读标题、简介和热评，几乎不花 token。',
          'stroll-card-desc',
        );
        const browseSwitch = el('button', undefined, 'stroll-switch-row');
        browseSwitch.type = 'button';
        const switchTrack = el('span', undefined, 'stroll-switch');
        switchTrack.append(el('i'));
        const switchLabel = el('span', '后台模式');
        browseSwitch.append(switchTrack, switchLabel);
        browseSwitch.addEventListener('click', () => toggleBackground());

        const autoSwitch = el('button', undefined, 'stroll-switch-row');
        autoSwitch.type = 'button';
        const autoTrack = el('span', undefined, 'stroll-switch');
        autoTrack.append(el('i'));
        const autoLabel = el('span', '每天自己逛一次');
        autoSwitch.append(autoTrack, autoLabel);
        autoSwitch.addEventListener('click', () => toggleAuto());

        const browseStats = el('div', undefined, 'stroll-stats');
        const statReads = statBlock('今天看了');
        const statAuto = statBlock('自己出门');
        const statBudget = statBlock('今日预算');
        browseStats.append(statReads.root, statAuto.root, statBudget.root);

        const browseFoot = el('div', undefined, 'stroll-card-foot');
        const tokenHint = el('span', undefined, 'stroll-token');
        const nudgeBtn = button('让她逛一圈', () => nudge(), 'primary');
        nudgeBtn.prepend(icon('spark', 12));
        browseFoot.append(tokenHint, nudgeBtn);
        browse.append(browseHead, browseDesc, browseSwitch, autoSwitch, browseStats, browseFoot);

        const watch = el('article', undefined, 'stroll-card stroll-card-watch');
        const watchHead = el('div', undefined, 'stroll-card-head');
        const watchTitle = el('h4');
        watchTitle.append(el('span', '一起看'), el('span', 'co-watch', 'stroll-en'));
        const watchState = el('span', undefined, 'stroll-state');
        watchHead.append(watchTitle, watchState);
        const watchDesc = el(
          'p',
          '开一个窗口，你在里面翻页、拖进度；她在后台读同一个页面，隔一会儿说一句。',
          'stroll-card-desc',
        );
        const watchBody = el('div', undefined, 'stroll-watch-body');
        const watchEmpty = el('div', undefined, 'stroll-empty soft');
        watchEmpty.append(el('strong', '还没开始一起看'), el('span', '贴个链接，两个人看同一个页面。'));
        const watchLive = el('div', undefined, 'stroll-watch-live');
        const watchNowTitle = el('div', undefined, 'stroll-watch-title');
        const watchTrack = el('div', undefined, 'stroll-progress');
        const watchBar = el('i');
        watchTrack.append(watchBar);
        const watchMeta = el('div', undefined, 'stroll-watch-meta');
        const watchTime = el('span');
        const watchComment = el('span');
        watchMeta.append(watchTime, watchComment);
        watchLive.append(watchNowTitle, watchTrack, watchMeta);
        watchBody.append(watchEmpty, watchLive);

        const watchRow = el('div', undefined, 'stroll-inline');
        const watchInput = el('input');
        watchInput.type = 'text';
        watchInput.placeholder = '要一起看的网页 / 视频链接';
        watchInput.className = 'stroll-input';
        const watchBtn = button('一起看', () => startWatch(), 'primary');
        watchBtn.prepend(icon('play', 12));
        watchRow.append(watchInput, watchBtn);

        const watchFoot = el('div', undefined, 'stroll-card-foot');
        const watchHint = el('span', undefined, 'stroll-token');
        const watchStopBtn = button('结束', () => stopWatch(), 'ghost xs');
        watchFoot.append(watchHint, watchStopBtn);
        watch.append(watchHead, watchDesc, watchBody, watchRow, watchFoot);

        duo.append(browse, watch);
        root.append(duo);

        /* ---------------- 她的生活：关注流 / 在读 / 这周 ---------------- */
        const lifeSec = el('section', undefined, 'stroll-sec');
        lifeSec.append(sectionHead('她的生活', '关注流 · 在读 · 这周'));

        const followCard = el('article', undefined, 'stroll-life-card');
        const followHead = el('div', undefined, 'stroll-life-head');
        followHead.append(el('h4', '关注的人在发什么'), el('span', '', 'stroll-token'));
        const followCount = followHead.lastChild;
        const followEmpty = el('p', '还没有关注流；她自己逛的时候会顺手拉一份。', 'stroll-muted');
        const followList = el('div', undefined, 'stroll-life-list');
        followCard.append(followHead, followEmpty, followList);

        const bookCard = el('article', undefined, 'stroll-life-card');
        const bookHead = el('div', undefined, 'stroll-life-head');
        bookHead.append(el('h4', '在读'), el('span', '', 'stroll-token'));
        const bookPct = bookHead.lastChild;
        const bookTitle = el('p', undefined, 'stroll-life-title');
        const bookBarWrap = el('div', undefined, 'stroll-life-bar');
        const bookBar = el('i');
        bookBarWrap.append(bookBar);
        const bookMeta = el('span', '', 'stroll-token');
        const bookHint = el('p', '把 txt 放进书库，她就会一段一段地读。', 'stroll-muted stroll-life-note');
        const bookActions = el('div', undefined, 'stroll-life-actions');
        let bookDirNow = '';

        const bookPick = button(
          '选文件夹',
          async () => {
            const old = bookPick.textContent;
            bookPick.disabled = true;
            bookPick.textContent = '选择中…';
            try {
              const r = await ctx.invoke('books_pick');
              if (r?.ok && r.dir) {
                bookDirNow = r.dir;
                bookHint.textContent = `书库：${shortPath(r.dir)}`;
                bookHint.title = r.dir;
                refresh();
              } else if (r?.error) {
                bookHint.textContent = r.error;
              }
            } catch (error) {
              bookHint.textContent = `选不了文件夹：${error?.message ?? error}`;
            } finally {
              bookPick.disabled = false;
              bookPick.textContent = old;
            }
          },
          'ghost xs',
        );
        const bookOpen = button(
          '打开',
          async () => {
            const r = await ctx.invoke('books_open').catch(() => null);
            if (r && r.ok === false && r.error) bookHint.textContent = r.error;
          },
          'ghost xs',
        );
        bookActions.append(bookPick, bookOpen);
        bookCard.append(bookHead, bookTitle, bookBarWrap, bookMeta, bookHint, bookActions);

        const weekCard = el('article', undefined, 'stroll-life-card');
        const weekHead = el('div', undefined, 'stroll-life-head');
        weekHead.append(el('h4', '这周'), el('span', '', 'stroll-token'));
        const weekRange = weekHead.lastChild;
        const weekLine = el('p', undefined, 'stroll-life-title');
        const weekStats = el('div', undefined, 'stroll-life-stats');
        const weekOut = statBlock('出门');
        const weekComment = statBlock('评论');
        const weekRead = statBlock('看书');
        weekStats.append(weekOut.root, weekComment.root, weekRead.root);
        weekCard.append(weekHead, weekLine, weekStats);

        const lifeGrid = el('div', undefined, 'stroll-life');
        lifeGrid.append(followCard, bookCard, weekCard);
        lifeSec.append(lifeGrid);
        root.append(lifeSec);

        /* ---------------- 账号 ---------------- */
        const accountSec = el('section', undefined, 'stroll-sec');
        accountSec.append(sectionHead('账号'));
        const accounts = el('div', undefined, 'stroll-accounts');

        const biliTile = el('div', undefined, 'stroll-account');
        const biliAvatar = el('div', 'B', 'stroll-avatar bili');
        const biliBody = el('div', undefined, 'stroll-account-body');
        const biliName = el('strong', 'B站');
        const biliSub = el('span', '未登录');
        const biliOwner = el('span', 'B站主人没绑', 'stroll-owner-line');
        biliBody.append(biliName, biliSub, biliOwner);
        const biliBtn = button('登录 B站', () => login('bilibili'), 'ghost xs');
        const biliOut = button('退出登录', () => logoutAccount('bilibili'), 'ghost xs');
        const biliActions = el('div', undefined, 'stroll-account-actions');
        biliActions.append(biliOut, biliBtn);
        biliTile.append(biliAvatar, biliBody, biliActions);

        const dyTile = el('div', undefined, 'stroll-account');
        const dyAvatar = el('div', '抖', 'stroll-avatar dy');
        const dyBody = el('div', undefined, 'stroll-account-body');
        const dyName = el('strong', '抖音');
        const dySub = el('span', '未登录');
        const dyOwner = el('span', '抖音主人没绑', 'stroll-owner-line');
        dyBody.append(dyName, dySub, dyOwner);
        const dyBtn = button('登录 / 验证', () => login('douyin'), 'ghost xs');
        const dyBind = button('查登录号', () => checkDouyinSelf(), 'ghost xs');
        dyBind.title = '查一下桌宠现在登录的是哪个抖音号（昵称 + 抖音号），和主人绑的是不是同一个。抖音不能给自己发私信，所以这两个必须是不同的号。';
        const dyResolve = button('绑定这个号', () => bindPendingDouyin(), 'ghost xs');
        dyResolve.style.display = 'none';
        const dyOut = button('退出登录', () => logoutAccount('douyin'), 'ghost xs');
        const dyActions = el('div', undefined, 'stroll-account-actions');
        dyActions.append(dyOut, dyResolve, dyBind, dyBtn);
        dyTile.append(dyAvatar, dyBody, dyActions);

        accounts.append(biliTile, dyTile);
        accountSec.append(accounts);
        root.append(accountSec);

        /* ---------------- 谁找你 ---------------- */
        const inboxSec = el('section', undefined, 'stroll-sec');
        inboxSec.style.display = 'none';
        const inboxHead = el('div', undefined, 'stroll-sec-head');
        const inboxTitle = el('h3');
        const inboxCount = el('span', '0', 'stroll-count');
        inboxTitle.append(el('span', '谁找你'), inboxCount);
        const inboxHint = el('span', undefined, 'stroll-sec-hint');
        const inboxTools = el('div', undefined, 'stroll-inbox-tools');
        const inboxReadAll = button('全部已读', () => markAllSeen(), 'ghost xs');
        const inboxRefresh = button('刷新', () => loadInbox(true), 'ghost xs');
        inboxRefresh.prepend(icon('refresh', 11));
        const inboxDmMe = button('B站私信我', () => dmMe('bilibili'), 'ghost xs');
        const inboxDmDy = button('抖音私信我', () => dmMe('douyin'), 'ghost xs');
        inboxDmDy.style.display = 'none';
        inboxTools.append(inboxDmMe, inboxDmDy, inboxReadAll, inboxRefresh);
        const inboxMeta = el('div', undefined, 'stroll-inbox-meta');
        inboxMeta.append(inboxHint, inboxTools);
        inboxHead.append(inboxTitle, inboxMeta);
        const inboxLead = el('p', '评论能在面板直接回；私信两边都能看，也能在这儿回。点「去看看」会用你的浏览器打开。', 'stroll-muted');
        const inboxTabs = el('div', undefined, 'stroll-tabs stroll-inbox-tabs');
        const inboxList = el('div', undefined, 'stroll-inbox');
        const inboxMore = el('div', undefined, 'stroll-inbox-more');
        inboxSec.append(inboxHead, inboxLead, inboxTabs, inboxList, inboxMore);
        root.append(inboxSec);

        /* ---------------- 待你点头 ---------------- */
        const draftSec = el('section', undefined, 'stroll-sec');
        const draftHead = el('div', undefined, 'stroll-sec-head');
        const draftTitle = el('h3');
        draftTitle.append(el('span', '待你点头'), el('span', '0', 'stroll-count'));
        const seg = el('div', undefined, 'stroll-seg');
        const segButtons = new Map();
        for (const item of APPROVALS) {
          const b = el('button', item.label);
          b.type = 'button';
          b.addEventListener('click', () => setApproval(item.value));
          segButtons.set(item.value, b);
          seg.append(b);
        }
        draftHead.append(draftTitle, seg);
        const draftHint = el('p', undefined, 'stroll-muted');
        // 陌生人私信：模式是「先问我」时，别人发来的消息停在这里等她点头。
        // 以前只靠她在对话里说一句，主人一忙就错过了，所以必须有个看得见的地方。
        const strangerSec = el('div', undefined, 'stroll-strangers');
        strangerSec.style.display = 'none';
        const strangerHead = el('div', undefined, 'stroll-strangers-head');
        const strangerTitle = el('strong', '有人找你，等你点头');
        const strangerScan = button('现在查一下', async () => {
          strangerScan.disabled = true;
          strangerScan.textContent = '正在看…';
          try {
            const r = await ctx.invoke('stranger_scan');
            if (r?.ok === false) throw new Error(r.error || '没查到');
            msgSet(r?.receipt || '查完了。');
          } catch (error) {
            msgSet(error.message || String(error), true);
          }
          strangerScan.disabled = false;
          strangerScan.textContent = '现在查一下';
          refresh();
        }, 'ghost xs');
        strangerHead.append(strangerTitle, strangerScan);
        const strangerList = el('div', undefined, 'stroll-stranger-list');
        strangerSec.append(strangerHead, strangerList);
        const draftBox = el('div', undefined, 'stroll-drafts');
        draftSec.append(draftHead, draftHint, strangerSec, draftBox);
        /* ---------------- 出图密钥（脱敏，只在面板里） ---------------- */
        // 设置页是宿主渲染的，只能明文显示密钥；这里给一个安全入口：
        // 只显示「已配置 / 未配置」，要换就粘贴新的覆盖，面板永远不回显明文。
        const keySec = el('section', undefined, 'stroll-sec');
        const keyHead = el('div', undefined, 'stroll-sec-head');
        const keyTitle = el('h3');
        const keyCount = el('span', '—', 'stroll-count');
        keyTitle.append(el('span', '出图密钥'), keyCount);
        keyHead.append(keyTitle);
        const keyHint = el('p', undefined, 'stroll-muted');
        const keyRow = el('div');
        keyRow.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;';
        const keyInput = document.createElement('input');
        keyInput.type = 'password';
        keyInput.autocomplete = 'off';
        keyInput.style.cssText =
          'flex:1;min-width:200px;padding:7px 10px;border-radius:8px;border:1px solid rgba(0,0,0,.14);background:transparent;color:inherit;font:inherit;';
        keyInput.placeholder = '粘贴密钥（只存在本地）';
        const keySave = button('保存', async () => {
          const v = String(keyInput.value ?? '').trim();
          if (!v) { msgSet('先粘贴密钥。', true); return; }
          try {
            const r = await ctx.invoke('set_post_key', [v]);
            if (r?.ok === false) throw new Error(r.error || '没存上');
            keyInput.value = '';
            msgSet('密钥已保存（只存在本地，面板不回显）。');
            await loadPostKey();
          } catch (error) {
            msgSet(error.message || String(error), true);
          }
        }, 'ghost xs');
        const keyClear = button('清除', async () => {
          try {
            await ctx.invoke('clear_post_key');
            msgSet('密钥已清除。');
            await loadPostKey();
          } catch (error) {
            msgSet(error.message || String(error), true);
          }
        }, 'ghost xs');
        keyRow.append(keyInput, keySave, keyClear);
        keySec.append(keyHead, keyHint, keyRow);

        async function loadPostKey() {
          try {
            const r = await ctx.invoke('get_post_key');
            const has = r?.configured === true;
            keyCount.textContent = has ? '已配置' : '未配置';
            keyCount.className = ('stroll-count ' + (has ? 'on' : '')).trim();
            keyInput.placeholder = has ? '已配置；粘贴新的可以覆盖' : '粘贴密钥（只存在本地）';
            keyHint.textContent = has
              ? '密钥只存在本地配置文件里，这里不回显。要换就粘贴新的再点保存。'
              : '还没配。用「自己生成」做配图前必须填这个；用图片工坊的图就不用。';
          } catch {
            keySec.style.display = 'none';
          }
        }

        root.append(keySec);
        root.append(draftSec);

        /* ---------------- 这一条 ---------------- */
        const nowSec = el('section', undefined, 'stroll-sec');
        const nowHead = sectionHead('这一条', '打开后可以当场赞、评、关注');
        const nowCard = el('div', undefined, 'stroll-now');
        const nowEmpty = el('div', undefined, 'stroll-empty soft');
        nowEmpty.append(el('strong', '还没打开视频'), el('span', '用上面的输入条贴个链接，她就去后台看。'));

        const nowLive = el('div', undefined, 'stroll-now-live');
        const nowTop = el('div', undefined, 'stroll-now-head');
        const nowBadge = el('span', undefined, 'stroll-badge');
        const nowTitle = el('div', undefined, 'stroll-now-title');
        const nowWhen = el('span', undefined, 'stroll-now-time');
        nowTop.append(nowBadge, nowTitle, nowWhen);
        const nowActions = el('div', undefined, 'stroll-now-actions');
        const likeBtn = iconButton('heart', '点赞', () => quick('quick_like'));
        const unlikeBtn = iconButton('heart', '取消赞', () => quick('quick_unlike'));
        const followBtn = iconButton('plus', '关注', () => quick('quick_follow'));
        const openHereBtn = iconButton('link', '在浏览器看', () => openLastInBrowser('lastOpen'));
        const saveBtn = iconButton('bookmark', '稍后再看', () => quick('save_toview'));
        const commentsBtn = iconButton('comment', '看评论', () => openComments());
        nowActions.append(likeBtn, unlikeBtn, followBtn, openHereBtn, saveBtn, commentsBtn);
        const commentRow = el('div', undefined, 'stroll-inline');
        const commentInput = el('input');
        commentInput.type = 'text';
        commentInput.placeholder = '以她的口气评论这一条…';
        commentInput.className = 'stroll-input';
        commentInput.maxLength = 120;
        const commentBtn = button('发评论', () => quickComment(), 'primary');
        commentBtn.prepend(icon('comment', 12));
        commentRow.append(commentInput, commentBtn);
        nowLive.append(nowTop, nowActions, commentRow);
        nowCard.append(nowEmpty, nowLive);
        nowSec.append(nowHead, nowCard);
        root.append(nowSec);

        /* ---------------- 看点 ---------------- */
        const historySec = el('section', undefined, 'stroll-sec');
        const historyHead = el('div', undefined, 'stroll-sec-head');
        historyHead.append(el('h3', '看点'));
        const listTabs = el('div', undefined, 'stroll-tabs');
        const LIST_TABS = [
          ['viewed', '最近看过'],
          ['toview', '稍后再看'],
          ['popular', '热门'],
        ];
        const listButtons = new Map();
        for (const [kind, label] of LIST_TABS) {
          const tab = el('button', label);
          tab.type = 'button';
          tab.addEventListener('click', () => selectList(kind));
          listButtons.set(kind, tab);
          listTabs.append(tab);
        }
        listButtons.get('viewed').classList.add('on');
        historyHead.append(listTabs);
        const historyList = el('div', undefined, 'stroll-list');
        historySec.append(historyHead, historyList);
        root.append(historySec);

        /* ---------------- 最近 / 维护 ---------------- */
        const split = el('div', undefined, 'stroll-split');

        const recentSec = el('section', undefined, 'stroll-sec');
        const recentMore = button('查看全部', () => openTimeline(), 'ghost xs');
        recentMore.append(icon('link', 11));
        const recentRight = el('div', undefined, 'stroll-sec-more');
        recentRight.append(recentMore);
        const recentHint = el('span', undefined, 'stroll-sec-hint');
        const recentHead = sectionHead('最近', null, recentRight);
        recentHead.insertBefore(recentHint, recentRight);
        recentSec.append(recentHead);
        const timeline = el('div', undefined, 'stroll-timeline');
        recentSec.append(timeline);

        const sideCol = el('div', undefined, 'stroll-col');

        const chartSec = el('section', undefined, 'stroll-sec');
        const chartHint = el('span', undefined, 'stroll-sec-hint');
        const chartHead = el('div', undefined, 'stroll-sec-head');
        chartHead.append(el('h3', '近 7 天'), chartHint);
        const chartCard = el('div', undefined, 'stroll-chartcard');
        const chart = el('div', undefined, 'stroll-chart');
        chartCard.append(chart);
        chartSec.append(chartHead, chartCard);

        const toolSec = el('section', undefined, 'stroll-sec');
        toolSec.append(sectionHead('手刹与维护'));
        const toolCard = el('div', undefined, 'stroll-toolcard');
        const toolGrid = el('div', undefined, 'stroll-tools');
        toolGrid.append(
          button('暂停 1 小时', () => brake(1)),
          button('暂停 24 小时', () => brake(24)),
          button('解除手刹', () => resume()),
          button('重置今日计数', () => resetUsage()),
        );
        const toolHint = el('p', '手刹只停「自己出门」，不影响你现在让她做的事。', 'stroll-muted');
        toolCard.append(toolGrid, toolHint);
        toolSec.append(toolCard);

        sideCol.append(chartSec, toolSec);
        split.append(recentSec, sideCol);
        root.append(split);

        root.append(
          el(
            'p',
            '公开动作有硬额度；平台仍可能按自己的规则处理。不保证不封号，建议用单独的小号。',
            'stroll-foot',
          ),
        );

        /* ---------------- 状态 ---------------- */
        let busy = false;
        let lastData = null;
        let liveData = null;
        let liveWatch = null;
        let toastTimer = null;
        let lastPresenceKey = '';
        // 关掉「自己出门」再打开时，恢复上次的次数/方式，而不是硬塞成 1 次
        let autoRemember = 5;
        let autoRememberMode = 'sessions';

        function msgSet(text, bad = false) {
          msg.textContent = text || '';
          msg.className = `stroll-msg ${text ? 'show' : ''} ${bad ? 'bad' : ''}`.trim();
        }

        function statBlock(label) {
          const rootNode = el('div', undefined, 'stroll-stat');
          const cap = el('span', label);
          const num = el('strong', '0');
          const unit = el('em', '');
          const line = el('div', undefined, 'stroll-stat-line');
          line.append(num, unit);
          rootNode.append(cap, line);
          return {
            root: rootNode,
            set(value, suffix = '') {
              num.textContent = String(value);
              unit.textContent = suffix;
            },
          };
        }

        function render(data) {
          lastData = data;
          const s = data?.status ?? {};
          const p = s.policy ?? {};
          const cfg = data?.config ?? {};
          const usage = p.usage ?? {};
          const caps = p.caps ?? {};
          const bili = s.bili ?? {};
          const dy = s.douyin ?? {};
          const paused = p.paused?.paused === true;
          const left = (key) => Math.max(0, Number(caps[key] ?? 0) - Number(usage[key] ?? 0));
          // 哪些项被主人勾成了「每天必做」
          const mustKeys = {
            like: cfg.mustLike === true,
            comment: cfg.mustComment === true,
            dm: cfg.mustDm === true,
            group: cfg.mustGroup === true,
            follow: cfg.mustFollow === true,
            post: cfg.mustPost === true,
          };

          // 概览
          kickerDot.className = paused ? 'bad' : p.quiet ? 'warn' : 'ok';
          if (paused) {
            lede.textContent = `手刹拉着：${p.paused.reason || '暂停中'}。解除了再出门。`;
          } else {
            const b = bili.loggedIn ? 'B站已登录' : 'B站未登录';
            const d = dy.loggedIn ? '抖音已登录' : '抖音未登录';
            const quotaLine = (key, name) =>
              left(key) > 0 ? `还能${name} ${left(key)} 次` : `${name}今天用完了`;
            lede.textContent = `${b} · ${d}；${quotaLine('like', '赞')}，${quotaLine('comment', '评')}。`;
          }

          chips.replaceChildren(
            ...[
              chip(bili.loggedIn ? `B站 ${cut(bili.name || '已登录', 12)}` : 'B站 未登录', bili.loggedIn ? 'ok' : 'off'),
              chip(
                dy.loggedIn ? `抖音 ${dy.running && dy.headless ? '后台待命' : '已登录'}` : '抖音 待登录',
                dy.loggedIn ? 'ok' : 'warn',
              ),
              chip(paused ? '风控 手刹中' : p.quiet ? '安静时段' : '风控 正常', paused ? 'bad' : p.quiet ? 'warn' : 'ok'),
              chip(`审批 ${APPROVALS.find((a) => a.value === p.approval)?.label ?? '—'}`, 'off'),
              chip(s.owner?.uid ? 'B站主人 已绑' : 'B站主人 没绑', s.owner?.uid ? 'off' : 'warn'),
              chip(
                s.owner?.douyinOk ? '抖音主人 已绑' : s.owner?.douyinPending ? '抖音主人 待解析' : '抖音主人 没绑',
                s.owner?.douyinOk ? 'off' : 'warn',
              ),
              data?.watch?.watching ? chip('一起看 进行中', 'live') : null,
              Number(data?.inboxUnread ?? 0) > 0 ? chip(`谁找你 ${data.inboxUnread} 条新`, 'live') : null,
            ].filter(Boolean),
          );

          let used = 0;
          let total = 0;
          for (const m of METERS) {
            const cap = Number(caps[m.key] ?? 0);
            const u = Number(usage[m.key] ?? 0);
            if (cap > 0) {
              used += Math.min(u, cap);
              total += cap;
            }
          }
          const pct = total > 0 ? used / total : 0;
          ringFill.setAttribute('stroke-dashoffset', String(100 - pct * 100));
          ring.classList.toggle('is-paused', paused);
          ringNum.textContent = String(total > 0 ? used : '—');
          ringCap.textContent = `/ ${total || 0}`;

          // 活跃度
          const activityKey = data?.activity ?? 'custom';
          for (const [key, b] of activityBtns) b.classList.toggle('on', key === activityKey);
          const rawLike = Number(cfg.dailyLikes ?? caps.like);
          const rawComment = Number(cfg.dailyComments ?? caps.comment);
          const rawAuto = Number(cfg.autoSessionsPerDay ?? 0);
          const rawGap = Number(cfg.autoGapMinutes ?? 90);
          const rawMode = String(cfg.outingMode ?? 'sessions');
          const tail =
            rawMode === 'off'
              ? ' · 不自己出门'
              : rawMode === 'quota'
                ? ` · 按额度出门（每 ${rawGap} 分钟一次，做满就停）`
                : rawAuto > 0
                  ? ` · 自己出门 ${rawAuto} 次（每 ${rawGap} 分钟一次）`
                  : ' · 不自己出门';
          activityNote.textContent =
            activityKey === 'custom'
              ? `自定义：每天 ${rawLike} 赞 / ${rawComment} 评${tail}`
              : `每天 ${rawLike} 赞 · ${rawComment} 评${tail}`;
          const ramp = Number(p.ramp ?? 1);
          rampRow.style.display = ramp < 1 ? '' : 'none';
          rampText.textContent = `新号保护生效中：额度 ×${Math.round(ramp * 100)}%，前 7 天逐步放开`;

          // 额度
          meterHint.textContent = cfg.newAccountRamp
            ? `${p.day ?? ''} · 新号保护 ×${Math.round((p.ramp ?? 1) * 100)}%`
            : `${p.day ?? ''} · 0 点重置`;
          meters.replaceChildren();
          for (const m of METERS) {
            const cap = Number(caps[m.key] ?? 0);
            const u = Number(usage[m.key] ?? 0);
            const ratio = cap > 0 ? Math.min(1, u / cap) : 0;
            const item = el('button', undefined, 'stroll-meter');
            item.type = 'button';
            item.title = `看今天${m.label}的具体内容`;
            item.addEventListener('click', () => openUsage(m.key, m.label));
            if (cap > 0 && u >= cap) item.classList.add('full');
            else if (ratio >= 0.7) item.classList.add('warn');
            const head = el('div', undefined, 'stroll-meter-head');
            head.append(el('span', mustKeys[m.key] ? `${m.label} · 必做` : m.label, 'stroll-meter-label'));
            const num = el('span', undefined, 'stroll-meter-num');
            num.append(el('strong', String(u)), el('span', `/${cap}`));
            head.append(num);
            const track = el('div', undefined, 'stroll-meter-track');
            const bar = el('i');
            bar.style.width = `${Math.round(ratio * 100)}%`;
            track.append(bar);
            const footText =
              cap === 0
                ? '今天关着'
                : mustKeys[m.key]
                  ? left(m.key) > 0
                    ? `必做还差 ${left(m.key)} 次 · 点开看`
                    : '必做已完成 · 点开看'
                  : left(m.key) > 0
                    ? `还能 ${left(m.key)} 次 · 点开看`
                    : '今天用完了 · 点开看';
            const foot = el('div', footText, 'stroll-meter-foot');
            if (mustKeys[m.key]) foot.classList.add('stroll-must');
            item.append(head, track, foot);
            meters.append(item);
          }

          // 后台逛
          const bgOn = cfg.background !== false;
          browseState.textContent = bgOn ? '已开启' : '已关闭';
          browseState.className = `stroll-state ${bgOn ? 'on' : ''}`.trim();
          switchTrack.classList.toggle('on', bgOn);
          switchLabel.textContent = bgOn ? '后台模式' : '开窗模式';
          browseSwitch.setAttribute('aria-checked', String(bgOn));
          const outingMode = String(cfg.outingMode ?? 'sessions');
          if (outingMode !== 'off') autoRememberMode = outingMode;
          const autoOn = outingMode !== 'off';
          const autoCap = Number(cfg.autoSessionsPerDay ?? 0);
          if (autoCap > 0) autoRemember = autoCap;
          autoTrack.classList.toggle('on', autoOn);
          autoSwitch.setAttribute('aria-checked', String(autoOn));
          const autoNext = data?.autoNext;
          const autoUsed = Number(data?.autoSessions ?? 0);
          const quotaLeft = Number(autoNext?.quotaLeft ?? 0);
          const quotaTotal = Number(autoNext?.quotaTotal ?? 0);
          const quotaDone = Math.max(0, quotaTotal - quotaLeft);
          let autoText = '关着，只在你叫的时候';
          if (autoOn) {
            if (outingMode === 'quota') {
              // 按额度：目标项 = 勾了必做的那几项（没勾就按全部主动额度）
              const targets = Array.isArray(autoNext?.targets) ? autoNext.targets : [];
              const pendingText = targets.map((t) => `${t.label} ${t.left}`).join('、');
              if (autoNext?.done && autoNext?.reason === 'budget') {
                autoText = `按额度 · token 预算用完了（还差 ${pendingText || `${quotaLeft} 个`}）`;
              } else if (autoNext?.done && autoNext?.reason === 'none') {
                autoText = '按额度 · 没有能做的动作（看「公开动作」和是不是只读模式）';
              } else if (autoNext?.done && autoNext?.reason === 'drafts') {
                autoText = `按额度 · 还有 ${Number(autoNext?.drafts ?? 0)} 条草稿等你批，先不出门`;
              } else if (quotaLeft <= 0) {
                autoText = '按额度 · 目标做完了，今天收工';
              } else {
                autoText = `按额度 · 还差 ${pendingText || `${quotaLeft} 个`}`;
                if (autoNext?.at) {
                  const remainMs = Number(autoNext.at) - Date.now();
                  autoText += remainMs > 5 * 60 * 1000 ? ` · 下次约 ${hhmm(Number(autoNext.at))}` : ' · 快出门了';
                }
              }
            } else {
              autoText = autoCap > 0 ? `按次数 · 每天自己逛 ${autoCap} 次` : '按次数 · 次数是 0，不会自己出门';
              const effCap = Number(autoNext?.cap ?? autoCap);
              if (autoCap > 0 && effCap < autoCap) autoText += `（token 预算只够 ${effCap} 次）`;
              if (autoCap > 0) {
                if (autoNext?.done) autoText += ' · 今天够了';
                else if (autoNext?.at) {
                  const remainMs = Number(autoNext.at) - Date.now();
                  autoText += remainMs > 5 * 60 * 1000 ? ` · 下次约 ${hhmm(Number(autoNext.at))}` : ' · 快出门了';
                }
              }
            }
            // 撞了 -509 会自己歇几分钟：面板上说清楚，别让主人以为她卡住了
            const rateWait = p?.caps?.rateWait;
            if (rateWait?.waiting) autoText += ` · 限流歇 ${Number(rateWait.minutes ?? 0)} 分钟`;
          }
          autoLabel.textContent = autoText;
          statReads.set(Number(data?.todayReads ?? 0), ' 条');
          // 按次数看「出门几次」；按额度看「额度做了多少」，两边的分母不是一个东西
          const autoShownCap = Number(autoNext?.cap ?? autoCap);
          statAuto.set(
            autoOn && outingMode === 'sessions' ? `${autoUsed}/${autoShownCap}` : String(autoUsed),
            !autoOn ? ' 次 · 关着' : outingMode === 'quota' ? ` 次 · 额度 ${quotaDone}/${quotaTotal}` : ' 次',
          );
          // 这是「预算」（配置值），不是已用量；原来 Math.round(8600/1000) 会显示成 9k，看着像超了
          const budgetK = (Number(cfg.tokenDailyBudget ?? 0) / 1000).toFixed(1).replace(/\.0$/, '');
          statBudget.set(budgetK, 'k token 预算');
          tokenHint.textContent = '预算只决定每天出门几次，不是已用量';

          // 一起看
          const watching = data?.watch?.watching === true;
          watchState.textContent = watching ? '进行中' : '未开始';
          watchState.className = `stroll-state ${watching ? 'live' : ''}`.trim();
          watchEmpty.style.display = watching ? 'none' : '';
          watchLive.style.display = watching ? '' : 'none';
          watchStopBtn.disabled = !watching;
          if (watching) {
            const t = Number(data.watch.time ?? 0);
            const d = Number(data.watch.duration ?? 0);
            watchNowTitle.textContent = data.watch.title || data.watch.url || '正在看';
            watchBar.style.width = d > 0 ? `${Math.min(100, Math.round((t / d) * 100))}%` : '0%';
            watchTime.textContent = d > 0 ? `${clock(t)} / ${clock(d)}` : '进度未知';
            watchComment.textContent = data.watch.platform === 'douyin' ? '抖音页面' : 'B站页面';
          }
          watchHint.textContent = `她最多每 ${Number(cfg.watchSpeakSec ?? 60)} 秒说一句`;
          liveWatch = watching ? data.watch : null;
          applyPresence(data?.presence);

          // 她的生活
          const following = data?.following;
          followList.replaceChildren();
          if (following?.items?.length) {
            followEmpty.style.display = 'none';
            followCount.textContent = `${following.total} 条`;
            for (const item of following.items) {
              const isDy = item.platform === 'douyin';
              const row = el('button', undefined, 'stroll-life-row');
              row.type = 'button';
              row.title = item.title || '';
              row.append(el('span', isDy ? '抖' : 'B', `stroll-life-dot ${isDy ? 'dy' : 'bili'}`));
              const body = el('span', undefined, 'stroll-life-body');
              body.append(el('b', cut(item.author || (isDy ? '抖音' : 'B站'), 10)), el('span', cut(item.title || '', 34)));
              row.append(body);
              if (item.at) row.append(el('span', whenShort(item.at), 'stroll-token'));
              row.addEventListener('click', () => openExternal(item.url, cut(item.title || '这一条', 16)));
              followList.append(row);
            }
          } else {
            followEmpty.style.display = '';
            followCount.textContent = '';
          }

          const books = data?.books;
          // 路径只显示最后两级（完整路径在 title 里）：长路径会把卡片撑破、压到「这周」上
          if (books?.dir) {
            bookDirNow = String(books.dir);
            bookHint.title = bookDirNow;
          }
          if (books?.current) {
            bookTitle.textContent = String(books.current.name).replace(/\.(txt|md|markdown)$/i, '');
            bookPct.textContent = `${books.current.percent}%`;
            bookBar.style.width = `${books.current.percent}%`;
            const lastNote = books.current.notes?.[0];
            bookMeta.textContent = `${Math.max(1, Math.round(books.current.offset / 1000))}k / ${Math.max(1, Math.round(books.current.total / 1000))}k 字`;
            bookHint.textContent = lastNote ? `摘：「${cut(lastNote.text, 24)}」` : `书库 ${books.total} 本`;
          } else {
            bookTitle.textContent = '书库还是空的';
            bookPct.textContent = '';
            bookBar.style.width = '0%';
            bookMeta.textContent = '';
            bookHint.textContent = bookDirNow ? `把 txt 放进 ${shortPath(bookDirNow)}` : '把 txt 放进书库目录';
          }

          const weekly = data?.weekly;
          if (weekly) {
            weekRange.textContent = weekly.range ? `${weekly.range.from.slice(5)} – ${weekly.range.to.slice(5)}` : '';
            weekLine.textContent = weekly.headline || '';
            weekOut.set(weekly.totalActions ?? 0);
            weekComment.set((weekly.actions?.comment ?? 0) + (weekly.actions?.reply ?? 0));
            weekRead.set(weekly.reads ?? 0);
          }

          // 账号
          biliName.textContent = bili.loggedIn ? bili.name || '已登录' : 'B站';
          biliSub.textContent = bili.loggedIn ? `UID ${bili.uid || '—'} · 写动作可用` : '未登录 · 能看不能赞';
          biliBtn.textContent = bili.loggedIn ? '重新登录' : '登录 B站';
          biliOut.style.display = bili.loggedIn ? '' : 'none';
          dyName.textContent = dy.loggedIn ? '抖音' : '抖音（未登录）';
          dySub.textContent = dy.loggedIn
            ? dy.running
              ? dy.headless
                ? '已登录 · 后台运行'
                : '已登录 · 窗口开着'
              : '已登录 · 后台待命'
            : '未登录：扫码 / 过验证';
          dyBtn.textContent = dy.loggedIn ? '重新登录' : '登录 / 验证';
          dyOut.style.display = dy.loggedIn ? '' : 'none';
          // 填了抖音号/链接还没解析时，优先给「绑定这个号」；已绑才给「查登录号」
          const pending = s.owner?.douyinPending === true;
          dyResolve.style.display = pending ? '' : 'none';
          dyBind.style.display = !pending && dy.loggedIn ? '' : 'none';

          // 主人绑定：两边说法一致，一眼看出哪边没绑
          const owner = s.owner ?? {};
          if (owner.douyinSelfName && dy.loggedIn) dySub.textContent = `${dySub.textContent} · ${owner.douyinSelfName}`;
          dySub.title = owner.douyinSelfId
            ? `桌宠现在登录的抖音号：${owner.douyinSelfId}${owner.douyinSelfName ? `（${owner.douyinSelfName}）` : ''}`
            : '点「查登录号」可以读出她现在登录的是哪个抖音号';
          biliOwner.textContent = owner.uid ? `B站主人已绑 · UID ${owner.uid}` : 'B站主人没绑';
          biliOwner.classList.toggle('is-warn', !owner.uid);
          const dyBound = owner.douyinOk === true;
          const dyTail = owner.douyinName
            ? ` · ${owner.douyinName}`
            : owner.douyin
              ? ` · …${String(owner.douyin).slice(-6)}`
              : '';
          dyOwner.textContent = dyBound
            ? `抖音主人已绑${dyTail}${owner.douyinSame ? '（就是现在登录的号）' : ''}`
            : owner.douyinPending
              ? `抖音主人待解析 · ${cut(owner.douyin, 16)}${owner.douyinSame ? '（就是现在登录的号）' : ''}`
              : '抖音主人没绑';
          dyOwner.title = dyBound
            ? owner.douyinSame
              ? '这个号就是桌宠现在登录的抖音号，抖音不能给自己发私信'
              : '抖音私信可用'
            : owner.douyinPending
              ? '抖音号在后台常常搜不出结果；点「绑定这个号」会说明，主页链接最稳'
              : '把 sec_uid、主页链接或抖音号填到设置里的「主人抖音」';          dyOwner.classList.toggle('is-warn', !dyBound);
          inboxDmDy.style.display = dyBound && !owner.douyinSame ? '' : 'none';

          // 待批（草稿 + 等你点头的陌生人私信，一起算进这个数字）
          const drafts = data?.drafts ?? [];
          const strangerPend = data?.strangerPending ?? [];
          draftsCount = drafts.length;
          renderStrangers(strangerPend);
          draftHint.textContent = APPROVAL_HINT[p.approval] ?? '';
          for (const [value, b] of segButtons) b.classList.toggle('on', value === p.approval);
          draftBox.replaceChildren();
          if (!drafts.length) {
            const empty = el('div', undefined, 'stroll-empty');
            const mark = el('span', undefined, 'stroll-empty-icon');
            mark.append(icon('check', 16));
            empty.append(mark, el('strong', '没有待批的草稿'), el('span', '她出门时写下的评论、关注、动态会先停在这里。'));
            draftBox.append(empty);
          } else {
            for (const draft of drafts) {
              draftBox.append(draftCard(draft));
            }
          }

          // 这一条
          const lastOpen = data?.lastOpen;
          nowEmpty.style.display = lastOpen ? 'none' : '';
          nowLive.style.display = lastOpen ? '' : 'none';
          if (lastOpen) {
            const isDy = lastOpen.platform === 'douyin';
            const kind = lastOpen.kind || 'video';
            const kindLabel = kind === 'opus' ? '动态' : kind === 'article' ? '专栏' : '';
            nowBadge.textContent = isDy ? '抖音' : kindLabel ? `B站·${kindLabel}` : 'B站';
            nowBadge.className = `stroll-badge ${isDy ? 'douyin' : 'bilibili'}`;
            nowTitle.textContent = lastOpen.title || lastOpen.id || '';
            nowTitle.title = lastOpen.title || lastOpen.url || '';
            nowWhen.textContent = lastOpen.at ? `${hhmm(lastOpen.at)} 打开` : '';
            // 点赞/稍后再看只对视频有效；动态和专栏只开放评论与关注
            const videoLike = !isDy && kind === 'video';
            likeBtn.style.display = videoLike ? '' : 'none';
            unlikeBtn.style.display = videoLike ? '' : 'none';
            saveBtn.style.display = videoLike ? '' : 'none';
            commentsBtn.style.display = isDy ? 'none' : '';
            commentInput.maxLength = Number(cfg.commentMaxChars ?? 120);
            commentInput.placeholder =
              kind === 'opus' ? '在她这条动态下面说一句…' : kind === 'article' ? '在她这篇专栏下面说一句…' : '以她的口气评论这一条…';
          }

          // 看点：看过是本地数据，稍后再看/热门按需拉
          listData.viewed = data?.viewed ?? [];
          if (listKind === 'viewed') renderHistoryList(listData.viewed);

          // 近 7 天
          const week = data?.week ?? [];
          chart.replaceChildren();
          const top = Math.max(1, ...week.map((d) => Math.max(Number(d.actions ?? 0), Number(d.reads ?? 0))));
          const weekActions = week.reduce((sum, d) => sum + Number(d.actions ?? 0), 0);
          const weekReads = week.reduce((sum, d) => sum + Number(d.reads ?? 0), 0);
          chartHint.textContent = `本周 ${weekActions} 次动作 · ${weekReads} 条看过`;
          if (weekActions + weekReads === 0) {
            const empty = el('div', undefined, 'stroll-chart-empty');
            empty.append(el('strong', '这几天还没有记录'), el('span', '她出门一次，这里就会长出柱子'));
            chart.append(empty);
          }
          for (const day of week) {
            if (weekActions + weekReads === 0) break;
            const val = Math.max(Number(day.actions ?? 0), Number(day.reads ?? 0));
            const bar = el('div', undefined, `stroll-bar ${day.today ? 'today' : ''}`.trim());
            bar.title = `${day.day} · 动作 ${day.actions ?? 0} · 看过 ${day.reads ?? 0}`;
            const track = el('div', undefined, 'stroll-bar-track');
            const fill = el('i');
            fill.style.height = `${Math.max(val ? 10 : 3, Math.round((val / top) * 100))}%`;
            track.append(fill);
            bar.append(el('b', val ? String(val) : ''), track, el('span', day.weekday));
            chart.append(bar);
          }

          // 最近
          const recent = data?.recent ?? [];
          const recentTotal = Number(data?.recentTotal ?? recent.length);
          recentHint.textContent = recentTotal > recent.length ? `共 ${recentTotal} 条` : '';
          recentMore.style.display = recentTotal > 3 ? '' : 'none';
          timeline.replaceChildren();
          if (!recent.length) {
            timeline.append(el('p', '还没出过门。', 'stroll-muted'));
          } else {
            for (const item of recent.slice(0, 10)) {
              const row = el('div', undefined, 'stroll-tl');
              if (item.result && item.result !== 'ok') row.classList.add('bad');
              row.append(el('i'));
              const body = el('div', undefined, 'stroll-tl-body');
              const label = ACTION_LABEL[item.action] ?? item.action ?? '动作';
              const line = item.title ? `《${cut(item.title, 26)}》` : '';
              body.append(el('p', item.text ? `${label}：${cut(item.text, 60)}` : line || label));
              body.append(
                el(
                  'span',
                  `${PLATFORM_LABEL[item.platform] ?? item.platform ?? ''}${item.at ? ` · ${hhmm(item.at)}` : ''}`,
                ),
              );
              row.append(body);
              if (item.url) {
                row.classList.add('clickable');
                row.title = '在你的浏览器里打开';
                const go = el('span', undefined, 'stroll-item-go');
                go.append(icon('link', 11));
                row.append(go);
                row.addEventListener('click', () => openExternal(item.url, label));
              }
              timeline.append(row);
            }
          }
        }

        /* ---------------- 明细弹层 ---------------- */

        let sheetFilter = 'all';

        /** 面板自带 container-type，fixed 会相对面板；所以按可视区域算出局部坐标。 */
        function placeSheet() {
          // 按面板文字颜色判断深浅主题：浅色主题下文字是深色，深色主题下反过来
          const rgb = getComputedStyle(root).color.match(/\d+(\.\d+)?/g);
          if (rgb && rgb.length >= 3) {
            const lum = 0.299 * Number(rgb[0]) + 0.587 * Number(rgb[1]) + 0.114 * Number(rgb[2]);
            sheet.classList.toggle('dark', lum > 150);
          }
          const rect = root.getBoundingClientRect();
          const visibleTop = Math.max(0, rect.top);
          const visibleBottom = Math.min(window.innerHeight, rect.bottom);
          sheet.style.left = '0px';
          sheet.style.width = `${Math.round(rect.width)}px`;
          sheet.style.top = `${Math.round(visibleTop - rect.top)}px`;
          sheet.style.height = `${Math.round(Math.max(280, visibleBottom - visibleTop))}px`;
        }

        window.addEventListener('resize', () => {
          if (!sheet.hidden) placeSheet();
        });
        window.addEventListener(
          'scroll',
          () => {
            if (!sheet.hidden) placeSheet();
          },
          { passive: true },
        );
        document.addEventListener(
          'wheel',
          (e) => {
            if (!sheet.hidden && e.target === sheet) e.preventDefault();
          },
          { passive: false },
        );

        function openSheet({ title, hint = '', tabs = [], active = '', onTab = null, render }) {
          sheetTitle.textContent = title;
          sheetHint.textContent = hint;
          sheetTabs.replaceChildren();
          if (tabs.length) {
            sheetTabs.style.display = '';
            for (const t of tabs) {
              const b = el('button', undefined, '');
              b.type = 'button';
              b.append(el('span', t.label), el('b', String(t.count ?? '')));
              b.classList.toggle('on', t.key === active);
              b.addEventListener('click', () => onTab?.(t.key));
              sheetTabs.append(b);
            }
          } else {
            sheetTabs.style.display = 'none';
          }
          sheetBody.replaceChildren();
          render(sheetBody);
          sheetBody.scrollTop = 0;
          sheet.hidden = false;
          placeSheet();
          requestAnimationFrame(() => sheet.classList.add('show'));
        }

        function closeSheet() {
          sheet.classList.remove('show');
          sheet.hidden = true;
        }

        /** 一条动作的完整样子：谁、什么时候、原文、在哪条内容上。 */
        /** 今天只给时间，更早的带上日期，免得看不出来是哪天的。 */
        function actionTime(at) {
          if (!at) return '';
          const d = new Date(at);
          if (Number.isNaN(d.getTime())) return '';
          if (d.toDateString() === new Date().toDateString()) return hhmm(at);
          return `${d.getMonth() + 1}-${d.getDate()} ${hhmm(at)}`;
        }

        function detailRow(item) {
          const row = el('div', undefined, 'stroll-detail');
          if (item.result && item.result !== 'ok') row.classList.add('bad');
          if (item.url) row.classList.add('clickable');

          const head = el('div', undefined, 'stroll-detail-head');
          head.append(el('span', ACTION_LABEL[item.action] ?? item.action ?? '动作', 'stroll-detail-kind'));
          head.append(el('span', PLATFORM_LABEL[item.platform] ?? item.platform ?? '', 'stroll-detail-plat'));
          head.append(el('span', actionTime(item.at), 'stroll-detail-time'));
          row.append(head);

          if (item.text) row.append(el('p', item.text, 'stroll-detail-text'));

          const target = String(item.target ?? '');
          let where = item.title || '';
          if (!where && target) where = /^follow|unfollow$/.test(item.action ?? '') ? `UID ${target}` : target;
          if (where) {
            const line = el('div', undefined, 'stroll-detail-where');
            line.append(icon('play', 11), el('span', cut(where, 34)));
            row.append(line);
          }

          if (item.url) {
            row.title = '在你的浏览器里打开';
            const go = el('span', undefined, 'stroll-detail-go');
            go.append(icon('link', 11));
            row.append(go);
            row.addEventListener('click', () => openExternal(item.url, where || '这一条'));
          }
          return row;
        }

        function renderDetailList(body, items, emptyTitle, emptyHint) {
          if (!items.length) {
            const empty = el('div', undefined, 'stroll-empty soft');
            empty.append(el('strong', emptyTitle), el('span', emptyHint));
            body.append(empty);
            return;
          }
          const list = el('div', undefined, 'stroll-detail-list');
          for (const item of items) list.append(detailRow(item));
          body.append(list);
        }

        async function openUsage(key, label) {
          let data = null;
          try {
            data = await ctx.invoke('usage_detail', [key]);
          } catch {
            // 读不到就当空的
          }
          const items = Array.isArray(data?.items) ? data.items : [];
          const cap = Number(data?.cap ?? 0);
          openSheet({
            title: `${label} · 今天`,
            hint: cap ? `${items.length} 条 / 额度 ${cap}` : `${items.length} 条`,
            render: (body) =>
              renderDetailList(
                body,
                items,
                `今天还没有${label}`,
                key === 'comment' ? '她看到想说的才会留一句。' : '等她出门，或者在上面那一行直接让她做。',
              ),
          });
        }

        async function openTimeline() {
          let data = null;
          try {
            data = await ctx.invoke('timeline', [120]);
          } catch {
            // 读不到就退回面板上那几条
          }
          const all = Array.isArray(data?.items) ? data.items : (lastData?.recent ?? []);
          const total = Number(data?.total ?? all.length);
          const isRisk = (x) => x?.action === 'risk' || x?.platform === 'system';
          const groups = {
            action: all.filter((x) => !isRisk(x)),
            risk: all.filter(isRisk),
          };
          // 默认落在「动作」：风控记录再多也不该把真正做过的事盖住
          let active = groups.action.length ? 'action' : groups.risk.length ? 'risk' : 'all';
          const filters = [
            { key: 'action', label: '动作', count: groups.action.length },
            { key: 'risk', label: '风控', count: groups.risk.length },
            { key: 'all', label: '全部', count: all.length },
          ];
          const paint = () => {
            const items = active === 'all' ? all : groups[active] ?? [];
            openSheet({
              title: '最近做过什么',
              hint: `${items.length} 条${total > all.length ? '（更早的已折叠）' : ''}`,
              tabs: filters,
              active,
              onTab: (key) => {
                if (key === active) return;
                active = key;
                paint();
              },
              render: (body) =>
                renderDetailList(
                  body,
                  items,
                  active === 'risk' ? '没被限流过' : '还没出过门',
                  active === 'risk' ? '只有平台限流/要验证的时候才会记在这里。' : '等她自己出门，或者在上面贴个链接。',
                ),
            });
          };
          paint();
        }

        async function openComments(urlOverride) {
          const url = String(urlOverride || lastData?.lastOpen?.url || '').trim();
          if (!url) {
            msgSet('先打开一条内容。', true);
            return;
          }
          msgSet('正在读评论区…');
          let data = null;
          try {
            data = await ctx.invoke('comments', [url, 12]);
          } catch (error) {
            msgSet(error.message || String(error), true);
            return;
          }
          if (!data || data.ok === false) {
            msgSet(data?.error || '读不到评论。', true);
            return;
          }
          msgSet('');
          const kindLabel = { video: '视频', opus: '动态', article: '专栏' }[data.kind] || '内容';
          openSheet({
            title: `${kindLabel}评论区`,
            hint: `《${cut(data.title || '', 18)}》 · 共 ${Number(data.total ?? 0)} 条`,
            render: (body) => renderCommentList(body, data, url),
          });
        }

        function renderCommentList(body, data, url) {
          const items = Array.isArray(data.items) ? data.items : [];
          if (!items.length) {
            const empty = el('div', undefined, 'stroll-empty soft');
            empty.append(el('strong', '评论区还是空的'), el('span', '没有热评；想看原文就点「在浏览器看」。'));
            body.append(empty);
            return;
          }
          body.append(el('p', `热评 ${items.length} 条 · 点「回这句」直接回到楼里`, 'stroll-muted'));
          const list = el('div', undefined, 'stroll-comments');
          for (const c of items) list.append(commentCard(c, url));
          body.append(list);
        }

        function commentCard(c, url) {
          const row = el('div', undefined, 'stroll-comment');
          const head = el('div', undefined, 'stroll-comment-head');
          const name = c.u || '有人';
          const tone = [...name].reduce((a, ch) => a + ch.charCodeAt(0), 0) % 360;
          const avatar = el('span', [...name][0] ?? '?', 'stroll-msgavatar');
          avatar.style.setProperty('--tone', `hsl(${tone} 58% 52%)`);
          head.append(avatar, el('span', name, 'stroll-msguser'));
          if (c.l && c.l !== '0') head.append(el('span', `${c.l} 赞`, 'stroll-comment-like'));
          row.append(head, el('p', c.t || '', 'stroll-comment-text'));

          const acts = el('div', undefined, 'stroll-comment-acts');
          const replyBtn = button('回这句', () => toggle(), 'ghost xs');
          acts.append(replyBtn);
          row.append(acts);

          const box = el('div', undefined, 'stroll-comment-reply');
          box.style.display = 'none';
          const input = el('input');
          input.type = 'text';
          input.className = 'stroll-input';
          input.maxLength = Number(lastData?.config?.commentMaxChars ?? 120);
          input.placeholder = `回 ${cut(name, 8)}`;
          const hint = el('span', undefined, 'stroll-token');
          const send = button('发送', () => submit(), 'primary xs');
          const line = el('div', undefined, 'stroll-inline');
          line.append(input, send);
          box.append(line, hint);
          row.append(box);

          function toggle() {
            const open = box.style.display === 'none';
            box.style.display = open ? '' : 'none';
            replyBtn.classList.toggle('on', open);
            if (open) input.focus?.();
          }

          async function submit() {
            const text = input.value.trim();
            if (!text) {
              hint.textContent = '先写一句。';
              return;
            }
            send.disabled = true;
            hint.textContent = '发送中…';
            try {
              const result = await ctx.invoke('reply_comment', [url, c.rpid, text]);
              if (result?.ok === false) throw new Error(result.error || '没发出去');
              input.value = '';
              hint.textContent = '';
              box.style.display = 'none';
              replyBtn.textContent = '已回';
              row.classList.add('replied');
              msgSet(result?.receipt || '回复发出去了。');
            } catch (error) {
              hint.textContent = error.message || String(error);
            } finally {
              send.disabled = false;
            }
          }

          input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') submit();
          });
          return row;
        }

        function openInboxSheet(filter = sheetFilter) {
          sheetFilter = filter;
          const count = (k) => (k === 'all' ? inboxItems.length : inboxItems.filter((x) => x.kind === k).length);
          const tabs = [
            { key: 'all', label: '全部', count: count('all') },
            { key: 'reply', label: '评论', count: count('reply') },
          ];
          if (count('at')) tabs.push({ key: 'at', label: '@ 我', count: count('at') });
          const list = filter === 'all' ? inboxItems : inboxItems.filter((x) => x.kind === filter);
          openSheet({
            title: '谁找你',
            hint: `${inboxItems.length} 条 · 在框内滚动，不撑长页面`,
            tabs,
            active: filter,
            onTab: (k) => openInboxSheet(k),
            render: (body) => {
              if (!list.length) {
                const empty = el('div', undefined, 'stroll-empty soft');
                empty.append(el('strong', '这一类还没有消息'), el('span', '换个分类，或者过一会儿再刷新。'));
                body.append(empty);
                return;
              }
              const wrap = el('div', undefined, 'stroll-inbox');
              for (const item of list) wrap.append(inboxCard(item));
              body.append(wrap);
            },
          });
        }

        /* ---------------- 正在看 / 活跃度 ---------------- */

        function applyPresence(p) {
          const prev = liveData;
          liveData = p || null;
          if (!p) {
            live.style.display = 'none';
            if (lastPresenceKey && listKind === 'viewed') renderHistoryList(listData.viewed ?? []);
            lastPresenceKey = '';
            return;
          }
          live.style.display = '';
          live.classList.toggle('cowatch', p.phase === 'co-watch');
          const isDy = p.platform === 'douyin';
          const kindLabel = p.kind === 'opus' ? '动态' : p.kind === 'article' ? '专栏' : '';
          livePlat.textContent = isDy ? '抖音' : 'B站';
          livePlat.className = `stroll-live-plat ${isDy ? 'douyin' : 'bilibili'}`;
          liveTitle.textContent = p.title || p.url || '一条内容';
          liveTitle.title = p.title || p.url || '';
          liveMeta.textContent = [
            p.author ? cut(p.author, 16) : '',
            p.phase === 'co-watch'
              ? '一起看，跟着你的进度'
              : kindLabel
                ? `后台看${kindLabel}，不占你的屏幕`
                : '后台看，不占你的屏幕',
            p.duration ? clock(p.duration) : '',
          ]
            .filter(Boolean)
            .join(' · ');
          const key = `${p.platform}:${p.id || p.title}:${p.startedAt}`;
          if (prev && key !== lastPresenceKey) showToast(p);
          const changed = key !== lastPresenceKey;
          lastPresenceKey = key;
          if (changed && listKind === 'viewed') renderHistoryList(listData.viewed ?? []);
          tickLive();
        }

        function tickLive() {
          const p = liveData;
          if (!p) return;
          const elapsed = Math.max(0, Math.floor((Date.now() - Number(p.startedAt)) / 1000));
          if (p.phase === 'co-watch' && Number(liveWatch?.duration ?? 0) > 0) {
            const t = Number(liveWatch.time ?? 0);
            const d = Number(liveWatch.duration);
            liveElapsed.textContent = `${clock(t)} / ${clock(d)}`;
            liveBar.classList.remove('shimmer');
            liveBar.style.width = `${Math.min(100, Math.round((t / d) * 100))}%`;
          } else {
            liveElapsed.textContent = `已看 ${clock(elapsed)}`;
            liveBar.classList.add('shimmer');
            liveBar.style.width = '100%';
          }
        }

        function showToast(p) {
          const isDy = p.platform === 'douyin';
          const what = p.kind === 'opus' ? '看动态' : p.kind === 'article' ? '看专栏' : '了';
          toast.replaceChildren(
            icon('play', 12),
            el('b', `她去${isDy ? '抖音' : 'B站'}${what}`),
            el('span', cut(p.title || p.url || '', 24)),
          );
          toast.className = `stroll-toast show ${isDy ? 'douyin' : 'bilibili'}`;
          clearTimeout(toastTimer);
          toastTimer = setTimeout(() => toast.classList.remove('show'), 7000);
        }

        async function openPresence() {
          const url = liveData?.url;
          if (!url) {
            msgSet('这一条没有可打开的链接。', true);
            return;
          }
          await openExternal(url, cut(liveData.title || '', 18));
        }

        async function dismissPresence() {
          live.style.display = 'none';
          liveData = null;
          lastPresenceKey = '';
          try {
            await ctx.invoke('presence_dismiss');
          } catch {
            // 收起只是本地的事
          }
        }

        async function pollPresence() {
          try {
            const result = await ctx.invoke('presence');
            if (result?.ok === false) return;
            applyPresence(result?.presence);
          } catch {
            // 读不到就保持原样
          }
        }

        async function setActivity(key) {
          const labels = { quiet: '安静', normal: '日常', lively: '活跃', chatty: '话痨' };
          msgSet(`正在切到「${labels[key] ?? key}」…`);
          try {
            const result = await ctx.invoke('set_activity', [key]);
            if (result?.ok === false) throw new Error(result.error || '没切过去');
            msgSet(
              `活跃度改成「${result.label}」：每天最多 ${result.dailyLikes} 赞 / ${result.dailyComments} 评 / 自己出门 ${result.autoSessionsPerDay} 次。`,
            );
            await refresh();
            await loadInbox(true);
          } catch (error) {
            msgSet(error.message || String(error), true);
          }
        }

        async function turnOffRamp() {
          msgSet('正在关掉新号保护…');
          try {
            const result = await ctx.invoke('set_ramp', [false]);
            if (result?.ok === false) throw new Error(result.error || '没关掉');
            msgSet('新号保护已关掉，额度按全额算。');
            await refresh();
          } catch (error) {
            msgSet(error.message || String(error), true);
          }
        }

        function draftCard(draft) {
          const tone = ACTION_TONE[draft.action] ?? '#3b82f6';
          const card = el('div', undefined, 'stroll-draft');
          const iconBox = el('div', ACTION_LABEL[draft.action]?.slice(0, 1) ?? '·', 'stroll-draft-icon');
          iconBox.style.setProperty('--tone', tone);
          const body = el('div', undefined, 'stroll-draft-body');
          body.append(el('p', draft.preview));
          body.append(
            el(
              'span',
              `${PLATFORM_LABEL[draft.platform] ?? draft.platform} · ${ACTION_LABEL[draft.action] ?? draft.action} · ${ago(draft.ageSec)}`,
              'stroll-draft-meta',
            ),
          );
          const actions = el('div', undefined, 'stroll-draft-actions');
          actions.append(
            button('批准', () => act('approve', draft.id), 'solid xs'),
            button('拒绝', () => act('reject', draft.id), 'ghost xs'),
          );
          card.append(iconBox, body, actions);
          return card;
        }

        /**
         * 只重画「等你点头」这一块。
         * 之前面板完全没有自动刷新：检测到了也不会自己冒出来，非得主人点「刷新」。
         * 现在每秒调一次轻量接口（只读内存里的待办，不查登录态），变了才重画。
         */
        let draftsCount = 0;
        let strangerSig = '__init__';
        function renderStrangers(items) {
          const list = items ?? [];
          strangerSec.style.display = list.length ? '' : 'none';
          strangerList.replaceChildren();
          for (const item of list) strangerList.append(strangerCard(item));
          const total = draftsCount + list.length;
          draftTitle.lastChild.textContent = String(total);
          draftTitle.lastChild.className = `stroll-count ${total ? 'on' : ''}`.trim();
          strangerSig = list.map((x) => x.id).join(',');
        }

        function strangerCard(item) {
          const card = el('div', undefined, 'stroll-stranger');
          // el(tag, 文字, 类名)——以前把类名写进了第二个参数，面板上就直接显示「stroll-draft-icon」
          const iconBox = el('span', item.platform === 'bilibili' ? 'B' : '抖', 'stroll-draft-icon');
          iconBox.style.setProperty('--tone', '#fe2c55');
          const body = el('div', undefined, 'stroll-draft-body');
          const head = el('p');
          head.append(el('strong', item.who || '有人'), el('span', ` · ${ago(Math.round((Date.now() - Number(item.at || 0)) / 1000))}`, 'stroll-draft-meta'));
          body.append(head);
          body.append(el('p', cut(item.text || '（发来一条非文字消息）', 80), 'stroll-stranger-text'));
          body.append(
            el(
              'span',
              `${PLATFORM_LABEL[item.platform] ?? item.platform} · 陌生私信 · 你说回她才回`,
              'stroll-draft-meta',
            ),
          );
          const actions = el('div', undefined, 'stroll-draft-actions');
          actions.append(
            button('让她回', () => act('stranger_approve', item.id), 'solid xs'),
            button('不回', () => act('stranger_reject', item.id), 'ghost xs'),
          );
          card.append(iconBox, body, actions);
          return card;
        }

        /* ---------------- 动作 ---------------- */
        // 1 秒轮询「有没有人等我点头」：新消息进来 1 秒内就出现在面板上
        setInterval(() => {
          if (document.visibilityState !== 'visible') return;
          if (!strangerSec.isConnected) return;
          ctx
            .invoke('stranger_pending')
            .then((r) => {
              if (!r?.ok) return;
              if (r.sig === strangerSig) return;
              renderStrangers(r.items ?? []);
            })
            .catch(() => {});
        }, 1000);

        async function refresh() {
          if (busy) return;
          busy = true;
          refreshBtn.disabled = true;
          try {
            const data = await ctx.invoke('status');
            if (data?.ok === false) throw new Error(data.error || '读取失败');
            render(data);
            msgSet('');
          } catch (error) {
            msgSet(error.message || String(error), true);
          } finally {
            busy = false;
            refreshBtn.disabled = false;
          }
        }

        async function act(method, id) {
          msgSet('处理中…');
          try {
            const result = await ctx.invoke(method, [id]);
            if (result?.ok === false) throw new Error(result.error || '没成功');
            msgSet(result?.receipt || (method === 'approve' ? '已批准并发出。' : '已拒绝。'));
            await refresh();
          } catch (error) {
            msgSet(error.message || String(error), true);
            await refresh();
          }
        }

        function setBarMode(mode) {
          barMode = mode;
          modeOpen.classList.toggle('on', mode === 'open');
          modeSearch.classList.toggle('on', mode === 'search');
          openBtn.textContent = mode === 'search' ? '搜索' : '打开';
          input.placeholder =
            mode === 'search' ? '搜 B站视频：输入关键词，回车' : '粘贴 B站 / 抖音链接，她在后台看完再说话';
          results.style.display = 'none';
          input.focus?.();
        }

        function submitBar() {
          if (barMode === 'search') doSearch();
          else openVideo();
        }

        async function openVideo() {
          const url = input.value.trim();
          if (!url) {
            msgSet('先贴个链接。', true);
            return;
          }
          const ok = await openUrl(url);
          if (ok) input.value = '';
        }

        async function openUrl(url) {
          openBtn.disabled = true;
          msgSet('正在后台打开…');
          try {
            const result = await ctx.invoke('open', [url]);
            if (result?.ok === false) throw new Error(result.error || '没打开');
            msgSet(`已打开：${cut(result.title || result.id || '', 32)}`);
            results.style.display = 'none';
            await refresh();
            return true;
          } catch (error) {
            msgSet(error.message || String(error), true);
            return false;
          } finally {
            openBtn.disabled = false;
          }
        }

        async function doSearch() {
          const q = input.value.trim();
          if (!q) {
            msgSet('给个搜索词。', true);
            return;
          }
          openBtn.disabled = true;
          msgSet(`正在搜「${q}」…`);
          try {
            const result = await ctx.invoke('search', [q]);
            if (result?.ok === false) throw new Error(result.error || '没搜到');
            renderResults(result.items ?? [], q);
            msgSet('');
          } catch (error) {
            msgSet(error.message || String(error), true);
          } finally {
            openBtn.disabled = false;
          }
        }

        function renderResults(items, query) {
          results.replaceChildren();
          const head = el('div', undefined, 'stroll-results-head');
          head.append(el('span', `「${cut(query, 20)}」`), el('span', `${items.length} 条`, 'stroll-results-count'));
          head.append(button('收起', () => { results.style.display = 'none'; }, 'ghost xs'));
          results.append(head);
          if (!items.length) {
            results.append(el('div', '没搜到，换个词试试。', 'stroll-muted'));
          }
          for (const item of items) {
            const row = el('button', undefined, 'stroll-result');
            row.type = 'button';
            const main = el('div', undefined, 'stroll-result-main');
            main.append(el('div', item.title || item.id || '', 'stroll-result-title'));
            main.append(
              el('div', [item.author, item.dur, item.stat].filter(Boolean).join(' · '), 'stroll-result-meta'),
            );
            const go = el('span', undefined, 'stroll-result-go');
            go.append(icon('play', 12));
            row.append(main, go);
            if (item.url) row.addEventListener('click', () => openUrl(item.url));
            results.append(row);
          }
          results.style.display = '';
        }

        let listKind = 'viewed';
        const listData = { viewed: [], toview: null, popular: null };

        function selectList(kind) {
          listKind = kind;
          for (const [k, b] of listButtons) b.classList.toggle('on', k === kind);
          if (kind === 'viewed') {
            renderHistoryList(listData.viewed ?? []);
            return;
          }
          if (listData[kind]) {
            renderHistoryList(listData[kind]);
            return;
          }
          renderListLoading(kind);
          loadList(kind);
        }

        async function loadList(kind) {
          try {
            const result = await ctx.invoke('list', [kind]);
            if (result?.ok === false) throw new Error(result.error || '没取到');
            listData[kind] = result.items ?? [];
            if (listKind === kind) renderHistoryList(listData[kind]);
          } catch (error) {
            if (listKind !== kind) return;
            historyList.replaceChildren();
            const empty = el('div', undefined, 'stroll-empty soft');
            empty.append(el('strong', '没取到'), el('span', error.message || '过一会儿再试'));
            historyList.append(empty);
          }
        }

        function renderListLoading(kind) {
          historyList.replaceChildren();
          const empty = el('div', undefined, 'stroll-empty soft');
          empty.append(el('strong', '正在取…'), el('span', kind === 'toview' ? '稍后再看' : '热门'));
          historyList.append(empty);
        }

        function renderHistoryList(items) {
          historyList.replaceChildren();
          if (!items.length) {
            const empty = el('div', undefined, 'stroll-empty soft');
            const text =
              listKind === 'toview'
                ? ['稍后再看是空的', '在 B站把视频加进「稍后再看」，这里就会出现。']
                : listKind === 'popular'
                  ? ['没取到热门', '检查一下 B站登录，或稍后再试。']
                  : ['还没看过内容', '打开一条之后，这里会记住它，方便再看。'];
            empty.append(el('strong', text[0]), el('span', text[1]));
            historyList.append(empty);
            return;
          }
          for (const item of items) historyList.append(historyRow(item));
        }

        function historyRow(v) {
          const row = el('div', undefined, 'stroll-item');
          if (liveData && liveData.id && liveData.platform === v.platform && String(liveData.id) === String(v.id)) {
            row.classList.add('live');
          }
          row.setAttribute('role', 'button');
          row.tabIndex = 0;
          row.append(el('span', undefined, `stroll-dot ${v.platform === 'douyin' ? 'douyin' : 'bilibili'}`));
          const main = el('div', undefined, 'stroll-item-main');
          main.append(el('div', v.title || v.id || '', 'stroll-item-title'));
          const meta = [v.author, v.dur, v.stat, v.at ? hhmm(v.at) : ''].filter(Boolean).join(' · ');
          main.append(el('div', meta, 'stroll-item-meta'));
          const go = el('span', undefined, 'stroll-item-go');
          go.append(icon('play', 12));
          go.title = '她在后台看一遍';
          row.append(main, go);
          if (v.url) {
            const ext = el('button', undefined, 'stroll-item-ext');
            ext.type = 'button';
            ext.title = '在你的浏览器里打开';
            ext.append(icon('link', 12));
            ext.addEventListener('click', (event) => {
              event.stopPropagation();
              openExternal(v.url, cut(v.title || v.id, 18));
            });
            row.append(ext);
            row.classList.add('clickable');
            row.addEventListener('click', () => openUrl(v.url));
            row.addEventListener('keydown', (e) => {
              if (e.key === 'Enter' || e.key === ' ') openUrl(v.url);
            });
          } else {
            row.classList.add('disabled');
          }
          return row;
        }

        function inboxTime(at) {
          const n = Number(at);
          if (!Number.isFinite(n) || n <= 0) return '';
          const d = new Date(n * 1000);
          const diff = Date.now() - d.getTime();
          if (diff < 3600000) return `${Math.max(1, Math.floor(diff / 60000))} 分钟前`;
          if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
          return `${d.getMonth() + 1}/${d.getDate()} ${hhmm(d.toISOString())}`;
        }

        let inboxItems = [];
        let inboxAt = 0;
        let inboxCounts = { all: 0, reply: 0, at: 0 };
        let inboxFilter = 'all';
        const INBOX_FOLD = 4;
        const INBOX_TYPES = { video: '视频', opus: '动态', article: '专栏', dm: '私信', other: '页面' };

        async function loadInbox(force = false) {
          if (!force && Date.now() - inboxAt < 2 * 60 * 1000) return;
          inboxAt = Date.now();
          try {
            const result = await ctx.invoke('inbox', [15]);
            if (result?.ok === false) return;
            inboxItems = Array.isArray(result.items) ? result.items : [];
            inboxCounts = result.counts ?? {
              all: inboxItems.length,
              reply: inboxItems.filter((x) => x.kind === 'reply').length,
              at: inboxItems.filter((x) => x.kind === 'at').length,
              dm: inboxItems.filter((x) => x.kind === 'dm').length,
            };
            renderInbox();
            // 顶部那颗「谁找你 N 条新」跟着消息一起变，不用等下一次 15 秒轮询
            if (Number(result.unread ?? 0) !== Number(lastData?.inboxUnread ?? -1)) refresh();
          } catch {
            // 读不到就保持原样
          }
        }

        function inboxFiltered() {
          if (inboxFilter === 'all') return inboxItems;
          return inboxItems.filter((x) => x.kind === inboxFilter);
        }

        function renderInbox() {
          if (!inboxItems.length) {
            inboxSec.style.display = 'none';
            return;
          }
          inboxSec.style.display = '';
          const unread = inboxItems.filter((x) => x.fresh).length;
          inboxCount.textContent = String(inboxItems.length);
          inboxCount.className = `stroll-count ${unread ? 'on' : ''}`.trim();
          const platLabel = inboxItems.some((x) => x.platform === 'douyin') ? 'B站+抖音' : 'B站';
          inboxHint.textContent = `${inboxItems.length} 条 · ${platLabel}${unread ? ` · ${unread} 条还没点开` : ''}`;
          inboxReadAll.style.display = unread ? '' : 'none';

          // 分类：只有真收到 @ 才显示这排，别凭空多两个空标签
          if (inboxFilter === 'at' && !inboxCounts.at) inboxFilter = 'all';
          inboxTabs.replaceChildren();
          const tabs = [
            ['all', '全部', inboxCounts.all],
            ['dm', '私信', inboxCounts.dm],
            ['reply', '评论', inboxCounts.reply],
            ['at', '@ 我', inboxCounts.at],
          ].filter(([key]) => key === 'all' || key === 'reply' || inboxCounts[key] > 0);
          inboxTabs.style.display = tabs.length > 2 ? '' : 'none';
          for (const [key, label, n] of tabs) {
            const tab = el('button', undefined, '');
            tab.type = 'button';
            tab.append(el('span', label), el('b', String(n ?? 0)));
            tab.classList.toggle('on', inboxFilter === key);
            tab.addEventListener('click', () => {
              if (inboxFilter === key) return;
              inboxFilter = key;
              renderInbox();
            });
            inboxTabs.append(tab);
          }

          const list = inboxFiltered();
          const shown = list.slice(0, INBOX_FOLD);
          inboxList.replaceChildren();
          if (!list.length) {
            const empty = el('div', undefined, 'stroll-empty soft');
            empty.append(el('strong', '这一类还没有消息'), el('span', '换个分类，或者过一会儿再刷新。'));
            inboxList.append(empty);
          } else {
            for (const item of shown) inboxList.append(inboxCard(item));
          }

          inboxMore.replaceChildren();
          if (list.length > INBOX_FOLD) {
            const rest = list.length - INBOX_FOLD;
            const moreBtn = button(`查看全部 ${list.length} 条`, () => openInboxSheet(inboxFilter), 'ghost xs');
            moreBtn.append(icon('link', 11));
            inboxMore.append(moreBtn, el('span', `还有 ${rest} 条，点开在弹层里看`, 'stroll-token'));
          }
        }

        /** 每条消息都标清楚是哪个平台的，评论和私信都不例外。 */
        function platformTag(platform) {
          const dy = platform === 'douyin';
          return el('span', dy ? '抖音' : 'B站', `stroll-msgplat ${dy ? 'is-dy' : 'is-bili'}`);
        }

        function inboxCard(item) {
          const card = el('div', undefined, 'stroll-msgcard');
          if (item.fresh) card.classList.add('fresh');
          if (item.replied) card.classList.add('replied');

          const main = el('button', undefined, 'stroll-msgcard-main');
          main.type = 'button';
          main.title = item.url ? '在你的浏览器里打开这条消息' : '没有可打开的链接';

          const head = el('div', undefined, 'stroll-msgcard-head');
          const name = item.user || '有人';
          const tone = [...name].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
          const avatar = el('span', [...name][0] ?? '?', 'stroll-msgavatar');
          avatar.style.setProperty('--tone', `hsl(${tone} 58% 52%)`);
          head.append(avatar, el('span', name, 'stroll-msguser'));
          const kindLabel = item.kind === 'dm' ? '私信你' : item.kind === 'at' ? '@ 你' : '回复你';
          head.append(platformTag(item.platform), el('span', kindLabel, 'stroll-msgkind'));
          head.append(el('span', item.timeLabel || inboxTime(item.at), 'stroll-msgtime'));
          if (item.fresh) head.append(el('i', undefined, 'stroll-msgnew'));
          main.append(head);
          main.append(el('div', item.text || '', 'stroll-msgtext'));
          if (item.quote) main.append(el('div', `你说的：${cut(item.quote, 30)}`, 'stroll-msgquote'));
          const where =
            item.kind === 'dm'
              ? [
                  item.platform === 'douyin' ? '抖音私信' : 'B站私信',
                  item.where && item.where !== '私信' ? item.where : '',
                ]
                  .filter(Boolean)
                  .join(' · ')
              : [item.where ? `《${cut(item.where, 22)}》` : '', INBOX_TYPES[item.type] ?? '页面'].filter(Boolean).join(' · ');
          main.append(el('div', where, 'stroll-msgwhere'));
          if (item.replied) main.append(el('div', '已经回过这一条', 'stroll-msgdone'));

          main.addEventListener('click', () => {
            if (item.url) openExternal(item.url, `「${cut(name, 10)}」那条消息`);
            markSeen([item.id]);
          });
          card.append(main);

          const acts = el('div', undefined, 'stroll-msgacts');
          const goBtn = el('button', undefined, 'stroll-chipbtn');
          goBtn.type = 'button';
          goBtn.append(icon('link', 12), el('span', '去看看'));
          goBtn.addEventListener('click', () => {
            if (item.url) openExternal(item.url, `「${cut(name, 10)}」那条消息`);
            markSeen([item.id]);
          });
          acts.append(goBtn);

          let replyBox = null;
          if (item.kind === 'dm' || item.bvid || item.dynamicId || item.cvid) {
            const replyBtn = el('button', undefined, 'stroll-chipbtn');
            replyBtn.type = 'button';
            replyBtn.append(icon('comment', 12), el('span', item.kind === 'dm' ? '回私信' : '回一句'));
            replyBox = el('div', undefined, 'stroll-msgreply');
            replyBox.style.display = 'none';
            const replyInput = el('input');
            replyInput.type = 'text';
            replyInput.className = 'stroll-input';
            replyInput.placeholder = item.kind === 'dm' ? `回 ${cut(name, 10)} 的私信…` : `回 ${cut(name, 10)}…`;
            replyInput.maxLength = item.kind === 'dm' ? 300 : Number(lastData?.config?.commentMaxChars ?? 120);
            const replySend = button('发送', () => sendReply(item, replyInput, replyHint, replySend), 'primary xs');
            const replyHint = el('span', undefined, 'stroll-token');
            const row = el('div', undefined, 'stroll-inline');
            row.append(replyInput, replySend);
            replyBox.append(row, replyHint);
            replyBtn.addEventListener('click', () => {
              const open = replyBox.style.display === 'none';
              replyBox.style.display = open ? '' : 'none';
              replyBtn.classList.toggle('on', open);
              if (open) replyInput.focus?.();
            });
            replyInput.addEventListener('keydown', (e) => {
              if (e.key === 'Enter') sendReply(item, replyInput, replyHint, replySend);
            });
            acts.append(replyBtn);
          }
          if (item.mid) {
            const homeBtn = el('button', undefined, 'stroll-chipbtn');
            homeBtn.type = 'button';
            homeBtn.append(icon('user', 12), el('span', 'TA 的主页'));
            homeBtn.addEventListener('click', () => {
              openExternal(`https://space.bilibili.com/${item.mid}`, `${cut(name, 10)} 的主页`);
              markSeen([item.id]);
            });
            acts.append(homeBtn);
          }
          card.append(acts);
          if (replyBox) card.append(replyBox);
          return card;
        }

        async function openExternal(url, label) {
          if (!url) return false;
          msgSet('正在用你的浏览器打开…');
          try {
            const result = await ctx.invoke('open_external', [url]);
            if (result?.ok === false) throw new Error(result.error || '打不开');
            msgSet(`已经在你的浏览器里打开${label ? `：${label}` : ''}。`);
            return true;
          } catch (error) {
            msgSet(error.message || String(error), true);
            return false;
          }
        }

        async function sendReply(item, input, hint, btn) {
          const text = input.value.trim();
          if (!text) {
            hint.textContent = '先写一句。';
            return;
          }
          btn.disabled = true;
          hint.textContent = '发送中…';
          try {
            const result = await ctx.invoke('reply_to_comment', [item.id, text]);
            if (result?.ok === false) throw new Error(result.error || '没发出去');
            item.replied = true;
            item.fresh = false;
            hint.textContent = '';
            input.value = '';
            msgSet(result?.receipt || '回复发出去了。');
            renderInbox();
          } catch (error) {
            hint.textContent = error.message || String(error);
            msgSet(error.message || String(error), true);
          } finally {
            btn.disabled = false;
          }
        }

        async function dmMe(platform = 'bilibili') {
          msgSet(platform === 'douyin' ? '让她用抖音给你发条私信…' : '让她给你发条私信…');
          try {
            const result = await ctx.invoke('dm_me', ['', platform]);
            if (result?.ok === false) throw new Error(result.error || '没发出去');
            msgSet(result.message || '私信发出去了。');
            await refresh();
          } catch (error) {
            msgSet(error.message || String(error), true);
          }
        }

        async function markSeen(ids) {
          const list = ids?.length ? ids : [];
          let changed = false;
          for (const item of inboxItems) {
            if (list.length ? list.includes(item.id) : item.fresh) {
              if (item.fresh) changed = true;
              item.fresh = false;
            }
          }
          if (changed) renderInbox();
          try {
            await ctx.invoke('mark_seen', [list]);
          } catch {
            // 标已读失败不影响看消息
          }
        }

        function markAllSeen() {
          const ids = inboxItems.map((x) => x.id);
          markSeen(ids);
        }

        async function quick(method) {
          msgSet('处理中…');
          try {
            const url = lastData?.lastOpen?.url ?? '';
            const result = await ctx.invoke(method, [url]);
            if (result?.ok === false) throw new Error(result.error || '没成功');
            msgSet(result?.receipt || '做完了。');
            await refresh();
          } catch (error) {
            msgSet(error.message || String(error), true);
            await refresh();
          }
        }

        async function openLastInBrowser() {
          const url = lastData?.lastOpen?.url ?? '';
          if (!url) {
            msgSet('还没打开过视频。', true);
            return;
          }
          await openExternal(url, cut(lastData.lastOpen.title || '这一条', 18));
        }

        async function quickComment() {
          const text = commentInput.value.trim();
          if (!text) {
            msgSet('先写一句评论。', true);
            return;
          }
          commentBtn.disabled = true;
          msgSet('正在发评论…');
          try {
            const result = await ctx.invoke('quick_comment', [text, lastData?.lastOpen?.url ?? '']);
            if (result?.ok === false) throw new Error(result.error || '没发出去');
            commentInput.value = '';
            msgSet(result?.receipt || '评论发出去了。');
            await refresh();
          } catch (error) {
            msgSet(error.message || String(error), true);
          } finally {
            commentBtn.disabled = false;
          }
        }

        async function nudge() {
          nudgeBtn.disabled = true;
          msgSet('叫她出门了…');
          try {
            const result = await ctx.invoke('nudge');
            if (result?.ok === false) throw new Error(result.error || '没叫动');
            msgSet(result?.message || '叫她了。');
          } catch (error) {
            msgSet(error.message || String(error), true);
          } finally {
            nudgeBtn.disabled = false;
          }
        }

        async function toggleBackground() {
          const next = lastData?.config?.background === false;
          msgSet(next ? '正在切回后台…' : '正在切换成开窗模式…');
          try {
            const result = await ctx.invoke('set_background', [next]);
            if (result?.ok === false) throw new Error(result.error || '没切过去');
            msgSet(next ? '后台模式：开。以后看视频不弹窗。' : '开窗模式：开。以后打开视频会弹出窗口。');
            await refresh();
          } catch (error) {
            msgSet(error.message || String(error), true);
          }
        }

        async function toggleAuto() {
          const cur = String(lastData?.config?.outingMode ?? 'sessions');
          const turningOn = cur === 'off';
          const next = turningOn ? autoRememberMode || 'sessions' : 'off';
          msgSet(turningOn ? '正在开启自己出门…' : '正在关掉自己出门…');
          try {
            // 按次数但次数是 0：顺手把次数填回去，不然开了等于没开
            const needCount = turningOn && next === 'sessions' && Number(lastData?.config?.autoSessionsPerDay ?? 0) <= 0;
            const result = needCount
              ? await ctx.invoke('set_auto', [autoRemember > 0 ? autoRemember : 5])
              : await ctx.invoke('set_outing', [next]);
            if (result?.ok === false) throw new Error(result.error || '没改成');
            msgSet(
              !turningOn
                ? '已关掉自己出门，只在你叫的时候逛。'
                : next === 'quota'
                  ? '已开启：按额度出门，主动额度做满才收工。'
                  : `已开启：每天最多自己逛 ${Number(lastData?.config?.autoSessionsPerDay ?? 5)} 次，两次之间会隔一会儿。`,
            );
            await refresh();
          } catch (error) {
            msgSet(error.message || String(error), true);
          }
        }

        async function setApproval(value) {
          const prev = lastData?.config?.approval;
          if (value === prev) return;
          msgSet('正在改审批…');
          try {
            const result = await ctx.invoke('set_approval', [value]);
            if (result?.ok === false) throw new Error(result.error || '没改成功');
            msgSet(APPROVAL_HINT[value] ?? '审批已改。');
            await refresh();
          } catch (error) {
            msgSet(error.message || String(error), true);
          }
        }

        async function startWatch() {
          const url = watchInput.value.trim();
          if (!url) {
            msgSet('贴个要一起看的链接。', true);
            return;
          }
          watchBtn.disabled = true;
          msgSet('正在打开陪看窗口…');
          try {
            const result = await ctx.invoke('watch_start', [url]);
            if (result?.ok === false) throw new Error(result.error || '没打开');
            msgSet(result?.note || '窗口开了，你在里面翻，她会跟着看。');
            watchInput.value = '';
            await refresh();
          } catch (error) {
            msgSet(error.message || String(error), true);
          } finally {
            watchBtn.disabled = false;
          }
        }

        async function stopWatch() {
          msgSet('正在结束一起看…');
          try {
            const result = await ctx.invoke('watch_stop');
            msgSet(result?.ok ? '一起看结束了。' : result?.error || '没结束', result?.ok === false);
            await refresh();
          } catch (error) {
            msgSet(error.message || String(error), true);
          }
        }

        async function brake(hours) {
          msgSet('拉手刹…');
          try {
            const result = await ctx.invoke('pause', [hours]);
            msgSet(result?.ok ? `已暂停 ${hours} 小时。` : result?.error || '没成功', !result?.ok);
            await refresh();
          } catch (error) {
            msgSet(error.message || String(error), true);
          }
        }

        async function resume() {
          msgSet('解除中…');
          try {
            const result = await ctx.invoke('resume');
            msgSet(result?.ok ? '手刹解除了。' : result?.error || '没成功', !result?.ok);
            await refresh();
          } catch (error) {
            msgSet(error.message || String(error), true);
          }
        }

        async function login(platform) {
          msgSet(`正在打开 ${platform === 'bilibili' ? 'B站' : '抖音'}登录窗…`);
          try {
            const result = await ctx.invoke('login', [platform]);
            msgSet(
              result?.message || (result?.ok ? '窗口开了，去登录吧。' : result?.error || '没成功'),
              result?.ok === false,
            );
            await refresh();
          } catch (error) {
            msgSet(error.message || String(error), true);
          }
        }

        /** 把设置里填的抖音号/链接解析成 sec_uid 并绑上。 */
        async function bindPendingDouyin() {
          let raw = String(lastData?.status?.owner?.douyin ?? '').trim();
          if (!raw) {
            // 刚在设置里改完，面板还没刷到：先拉一次最新状态
            await refresh();
            raw = String(lastData?.status?.owner?.douyin ?? '').trim();
          }
          if (!raw) {
            msgSet('设置里的「主人抖音」还是空的：填抖音号或主页链接再来。', true);
            return;
          }
          msgSet(`正在解析「${cut(raw, 20)}」…（要开一次浏览器，慢一点）`);
          try {
            const result = await ctx.invoke('bind_douyin_owner', [raw]);
            if (result?.ok === false) throw new Error(result.error || '没解析出来');
            msgSet(result.message || '已绑定。');
            await refresh();
          } catch (error) {
            msgSet(error.message || String(error), true);
          }
        }

        /** 只读：看桌宠现在登的是哪个抖音号，和主人是不是同一个。 */
        async function checkDouyinSelf() {
          msgSet('正在读她现在登录的抖音号…（要开一次浏览器，慢一点）');
          try {
            const result = await ctx.invoke('douyin_self');
            if (result?.ok === false) throw new Error(result.error || '没读到');
            msgSet(result.message || `现在登录的是「${result.name || '这个号'}」。`);
            await refresh();
          } catch (error) {
            msgSet(error.message || String(error), true);
          }
        }

        async function logoutAccount(platform) {
          const label = platform === 'bilibili' ? 'B站' : '抖音';
          msgSet(`正在退出 ${label}…`);
          try {
            const result = await ctx.invoke(platform === 'bilibili' ? 'logout_bili' : 'logout_douyin');
            msgSet(result?.message || (result?.ok ? `${label} 已退出登录。` : result?.error || '没成功'), result?.ok === false);
            await refresh();
          } catch (error) {
            msgSet(error.message || String(error), true);
          }
        }

        async function resetUsage() {
          msgSet('正在清零今天的计数…');
          try {
            const result = await ctx.invoke('reset_usage');
            msgSet(result?.ok ? `今天（${result.day}）的计数已清零。` : result?.error || '没成功', result?.ok === false);
            await refresh();
          } catch (error) {
            msgSet(error.message || String(error), true);
          }
        }

        refresh();
        loadInbox(true);
        loadPostKey();
        if (ctx.interval) {
          ctx.interval(refresh, 15000);
          ctx.interval(() => loadInbox(), 180000);
          // 正在看是本地状态，5 秒问一次不花 token；秒表本地走
          ctx.interval(pollPresence, 5000);
          ctx.interval(tickLive, 1000);
        }
      },
    },
  },
};
