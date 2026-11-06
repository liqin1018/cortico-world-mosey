import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS } from '../src/config.js';
import { stripLeadingFakeAt } from '../src/douyin.js';
import { approvalFor } from '../src/policy.js';
import { StickerBook, extOfBuffer } from '../src/stickers.js';
import { cutChars, dayKey, imageMimeOf, looksBrokenPath, stripAtName, stripAtPlaceholder } from '../src/util.js';
import { StrollWorld } from '../src/world.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = path.join(root, '.smoke-data');
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });

const cfg = {
  ...DEFAULTS,
  enabled: true,
  quietFrom: 0,
  quietTo: 0,
  autoSessionsPerDay: 0,
  approval: 'confirm',
  interests: '游戏,音乐',
};

const world = new StrollWorld({
  cfg,
  timezone: 'Asia/Shanghai',
  dataDir: tmp,
  persist: (patch) => Object.assign(cfg, patch),
});

const checks = [];
function check(name, ok) {
  checks.push([name, !!ok]);
  if (!ok) throw new Error(`FAILED: ${name}`);
}

check('tools = 3', world.tools().length === 3);
check('env prompt vars', Object.keys(world.envPromptVars()).length >= 6);
check('webUi panels', world.webUi().panels?.[0]?.id === 'stroll');
check('webUi invoke', typeof world.webUi().invoke === 'function');
check('policy caps', world.policy.snapshot().caps.like > 0);
// 私信主人必须跳过审批：不然「主人一发消息就能回」永远是草稿
check('dm 不排队审批', approvalFor({ ...cfg, approval: 'confirm', allowDm: true }, 'dm') === 'auto');
check('dry_run 仍然拦 dm', approvalFor({ ...cfg, approval: 'dry_run', allowDm: true }, 'dm') === 'draft');

// 私信监听的默认节奏：默认走页面事件通道，轮询只是兜底，所以默认值要小
check('私信兜底轮询 3 秒', DEFAULTS.dmPollSec === 3 && DEFAULTS.dmWatch === true);

// B站评论：以前发完固定 sleep(1200) 再回查，现在拿到 rpid 就返回
const oldBiliReq = world.bili.request;
const oldBiliView = world.bili.view;
world.bili.view = async () => ({ bvid: 'BV1test', aid: 1, url: 'https://www.bilibili.com/video/BV1test' });
world.bili.request = async (route) => (/reply\/add/.test(route) ? { rpid: '123456', reply: { content: { members: [] } } } : {});
const ct0 = Date.now();
const fastComment = await world.bili.comment({ bvid: 'BV1test', text: '速度测试' }).catch((e) => ({ ok: false, error: e?.message }));
const commentMs = Date.now() - ct0;
check('B站评论不再固定等 1.2 秒', fastComment.ok === true && commentMs < 600, `ms=${commentMs}`);

// GLM #2 前半：空正文不能假装发出去（读回来还是空，以前会被当成成功）
const emptySend = await world.douyin.sendInChat(null, null, '   ').catch((e) => e);
check('空正文不会假装发出去', emptySend?.code === 'EMPTY_TEXT', String(emptySend?.code));

// GLM #2 后半：平台没给确认 -> receipt 标 uncertain，不再当成功记账
const oldBiliComment = world.bili.comment;
const prevWriteAt = world.store.data.lastWriteAt;
world.bili.comment = async () => ({ ok: true, confirmed: false, rpid: '1' });
const unc = await world
  .executePlan({ action: 'comment', platform: 'bilibili', target: 'BV1unc', text: '测试', dedupeKey: 'dedupe-unc', kind: 'video' }, 'model')
  .catch((e) => ({ ok: false, error: e?.message }));
check(
  '没拿到回执会标成不确定',
  unc.ok === false && unc.uncertain === true && unc.code === 'UNCONFIRMED',
  JSON.stringify(unc).slice(0, 160),
);
world.bili.comment = oldBiliComment;
// 这次执行会留下 lastWriteAt（节奏控制），恢复回去，别影响后面的风控断言
world.store.data.lastWriteAt = prevWriteAt;

// GLM #3：指纹要等推送成功后才落
world.store.data.dmSeen = { ...(world.store.data.dmSeen ?? {}), douyin: { fp: 'old-fp', at: 1 } };
const pendingHit = world.douyinDmTail([{ from: 'them', kind: 'text', text: '还没推的一条', who: '主人' }], '主人', {
  commit: false,
});
check('推送前不落私信指纹', world.store.data.dmSeen.douyin.fp === 'old-fp' && typeof pendingHit?.commit === 'function');
pendingHit?.commit?.();
check('推送成功后才落私信指纹', world.store.data.dmSeen.douyin.fp !== 'old-fp');

// GLM #7：B站请求要排队，不能并发时一起醒来
world.bili.lastRequest = 0;
const tt0 = Date.now();
await Promise.all([world.bili.takeTurn(80), world.bili.takeTurn(80)]);
check('B站请求会排队而不是一起发', Date.now() - tt0 >= 70, `ms=${Date.now() - tt0}`);

// 剩下的低危：emoji 截断 / 出门时间窗口 / unknown 草稿 / 兴趣学习 / 关注确认
check('按码点截断不会切坏 emoji', cutChars('😀😀😀', 2) === '😀😀' && cutChars('abc', 5) === 'abc');
const late = new Date();
late.setHours(23, 30, 0, 0);
const w1 = new Date(world.nextOutingWindow(late.getTime()));
check('23:30 的下次出门推到次日 9 点', w1.getHours() === 9 && w1.getDate() !== late.getDate());
const early = new Date();
early.setHours(7, 0, 0, 0);
const w2 = new Date(world.nextOutingWindow(early.getTime()));
check('7:00 的下次出门是当天 9 点', w2.getHours() === 9 && w2.getDate() === early.getDate());

world.store.data.drafts = [
  { id: 'keep-unknown', status: 'unknown', createdAt: new Date().toISOString() },
  { id: 'drop-failed', status: 'failed', createdAt: new Date().toISOString() },
];
world.store.prune();
check('unknown 草稿留 7 天，失败草稿清掉', world.store.data.drafts.some((d) => d.id === 'keep-unknown') && !world.store.data.drafts.some((d) => d.id === 'drop-failed'));

world.store.data.interests = {};
world.store.addViewed({ platform: 'bilibili', id: 'BV1interest', author: '兴趣测试UP' });
check('看过的作者会计入兴趣', Number(world.store.data.interests['兴趣测试UP'] ?? 0) === 1);

const oldRelation = world.bili.relation;
const oldBiliReq2 = world.bili.request;
world.bili.relation = async () => null;
world.bili.request = async () => ({});
const followRes = await world.bili.follow('123456', true).catch((e) => ({ ok: false, error: e?.message }));
check('关注查证失败不再报成功', followRes.ok === true && followRes.confirmed === false, JSON.stringify(followRes));
world.bili.relation = oldRelation;
world.bili.request = oldBiliReq2;
world.bili.request = oldBiliReq;
world.bili.view = oldBiliView;
// 去重口径：末尾连着几句都要一起接住；同一批不重复推；末尾是自己发的不推
const batch = [
  { from: 'them', kind: 'text', text: '在吗' },
  { from: 'them', kind: 'text', text: '看看这个' },
];
world.store.data.dmSeen = { douyin: { fp: '', at: 1 } };
const tailHit = world.douyinDmTail(batch, '穹');
check('抖音私信连着几句一起取', !!tailHit && tailHit.text === '在吗 / 看看这个');
check('同一批私信不重复推', world.douyinDmTail(batch, '穹') === null);
check('末尾是自己发的不推', world.douyinDmTail([{ from: 'me', kind: 'text', text: '嗯' }], '穹') === null);

// 事件通道整条线：页面回调 → 判重 → pushEvent(interrupt)
const dmDir = path.join(tmp, 'dm');
fs.mkdirSync(dmDir, { recursive: true });
const dmWorld = new StrollWorld({
  cfg: { ...cfg, ownerDouyin: 'MS4wLjABAAAAabcdefghijklmnop', dmWatch: true },
  timezone: 'Asia/Shanghai',
  dataDir: dmDir,
  persist: () => {},
});
const pushes = [];
dmWorld.host = {
  pushEvent: async (event, opts) => {
    pushes.push({ event, opts });
    return true;
  },
};
dmWorld.running = true;
dmWorld.store.data.douyinOwner = { secUid: 'MS4wLjABAAAAabcdefghijklmnop', name: '穹', at: Date.now() };
dmWorld.store.data.dmSeen = { douyin: { fp: '', at: 1 } };
let onHit = null;
dmWorld.douyin = {
  dmArmed: () => !!onHit,
  keepWarm: () => {},
  watchDm: async (name, fn) => {
    onHit = fn;
    return { ok: true, armed: true, thread: name };
  },
  peekThread: async () => ({ ok: false, messages: [] }),
};
await dmWorld.armDmPush();
check('私信事件通道能挂上', typeof onHit === 'function');
await onHit([{ from: 'them', kind: 'text', text: '在吗' }]);
check(
  '页面事件 → interrupt 推送',
  pushes.length === 1 && pushes[0].opts.trigger === 'interrupt' && /在吗/.test(pushes[0].event.text),
);
await onHit([{ from: 'them', kind: 'text', text: '在吗' }]);
check('同一句不重复推', pushes.length === 1);
await onHit([
  { from: 'them', kind: 'text', text: '在吗' },
  { from: 'them', kind: 'text', text: '看这个' },
]);
check('连发第二句继续推', pushes.length === 2 && /看这个/.test(pushes[1].event.text));

// 风控默认「只记账不拦人」：-509 不该再把主人的事一起停掉
world.store.clearRisk();
const soft = world.policy.noteRisk('-509', '请求过于频繁，请稍后再试');
check('默认 off：-509 只记账不暂停', soft.hours === 0 && soft.guard === 'off');
check('off 下限流不拦评论', world.policy.check('comment', 'douyin', '7702414706065083674', {}).ok === true);
check('off 下回主人私信当然放行', world.policy.check('dm', 'douyin', 'owner', { free: true, userInitiated: true }).ok === true);

// light：只有验证码类才停，频率限流继续放行
cfg.riskGuard = 'light';
world.store.clearRisk();
const rateLight = world.policy.noteRisk('-509', '请求过于频繁');
check('light：限流仍不暂停', rateLight.hours === 0 && world.policy.paused().paused === false);
const verifyLight = world.policy.noteRisk('DOUYIN_VERIFY', '请完成验证');
check('light：验证码停 30 分钟', verifyLight.hours === 0.5 && world.policy.paused().paused === true);
check('light：验证码期间评论被拦', world.policy.check('comment', 'douyin', '7702414706065083674', {}).code === 'RISK_PAUSE');
world.store.clearRisk();

// strict：保留旧的分档冷却
cfg.riskGuard = 'strict';
world.store.clearRisk();
const strictRate = world.policy.noteRisk('-509', '请求过于频繁');
check('strict：限流按档位冷却', strictRate.hours > 0 && strictRate.hours <= 0.5);
cfg.riskGuard = 'off';
world.store.clearRisk();

// 节奏闸：回完私信紧接着评论不该等 90 秒
world.store.data.lastChatAt = Date.now();
world.store.data.lastWriteAt = 0;
world.store.data.lastWriteByPlat = {};
check('私信不占公开动作节奏', world.policy.check('comment', 'douyin', '7702414706065083675', { userInitiated: true }).ok === true);
// 主人近 3 分钟点过单 → 算手点（1.5 秒防连点），不是 20 秒出门节奏
world.store.data.lastWriteAt = Date.now() - 5000;
world.store.data.lastWriteByPlat = { douyin: Date.now() - 5000 };
world.store.data.ownerAskAt = Date.now();
check('主人点单 5 秒后能继续', world.policy.check('comment', 'douyin', '7702414706065083676', {}).ok === true);
world.store.data.ownerAskAt = 0;
check('自己出门仍按节奏等', world.policy.check('comment', 'douyin', '7702414706065083677', {}).code === 'TOO_FAST');

// 正文自带「@昵称」：插真 @ 前要剥掉，否则页面上是 @ 两次
check('剥掉正文里自带的 @', stripAtName('@小月月 在西安，回民街。@小月月还在玩', '小月月') === '在西安，回民街。还在玩');
check('没写 @ 的正文原样保留', stripAtName('在西安，回民街。', '小月月') === '在西安，回民街。');
check('昵称带正则符号也不炸', stripAtName('@a.b 好', 'a.b') === '好');

// 回私信的节奏：0.5 秒只防重发，不再卡 4 秒
world.store.data.lastChatAt = Date.now() - 300;
const dmBlocked = world.policy.check('dm', 'bilibili', '123456', { free: true, userInitiated: true });
world.store.data.lastChatAt = Date.now() - 600;
const dmOk = world.policy.check('dm', 'bilibili', '123456', { free: true, userInitiated: true });
check('回私信 0.5 秒内防重发', dmBlocked.ok === false && dmBlocked.code === 'TOO_FAST');
check('回私信 0.5 秒后可再发', dmOk.ok === true);

// 书库目录可以自定义（面板「选文件夹」就是把路径写进 booksDir）
const customBooks = path.join(tmp, 'my-books');
fs.mkdirSync(customBooks, { recursive: true });
fs.writeFileSync(path.join(customBooks, '测试书.txt'), '第一段。\n\n第二段。');
cfg.booksDir = customBooks;
const customList = world.listBooks();
check('自定义书库目录生效', world.bookDir() === path.resolve(customBooks) && customList.books.some((b) => b.name === '测试书.txt'));
cfg.booksDir = '   ';
check('留空回到默认书库', world.bookDir() === path.join(tmp, 'stroll', 'books'));
cfg.booksDir = '';

// 群聊：只认设置里点过名的群，别的会话一律不许发
cfg.douyinGroups = ' 摸鱼群 , 夜聊群 , 第三个不认 ';
check('群名按配置解析并去掉空格', JSON.stringify(world.groupNames()) === JSON.stringify(['摸鱼群', '夜聊群', '第三个不认']));
const groupPlan = await world.buildPlan('dm', { platform: 'douyin', target: '摸鱼群', text: '在的' });
check('可以发到点过名的群', groupPlan.ok === true && groupPlan.group === true && groupPlan.target === '摸鱼群');
const strangerPlan = await world.buildPlan('dm', { platform: 'douyin', target: '路人甲', text: '在的' });
check('没点名的会话发不出去', strangerPlan.ok === false);
cfg.douyinGroups = '';

// 群消息指纹：末尾连着几句主人那边的都要一起接住；末尾是自己发的不算新话
const gTail = world.groupTailFp([
  { from: 'them', who: '大萌神', kind: 'text', text: '在吗' },
  { from: 'them', who: '大萌神', kind: 'text', text: '这周六有空不' },
]);
check('群消息末尾连着几句一起取', gTail.tail.length === 2 && gTail.fp.startsWith('大萌神:text:在吗'));
check('群消息末尾是自己发的不算', world.groupTailFp([{ from: 'me', who: '', kind: 'text', text: '在' }]).tail.length === 0);
// 上一屏见过的消息就是边界：新消息只取新的那些，不能把整段历史重推一遍
const seenScreen = world.groupTailFp([
  { from: 'them', who: '大萌神', kind: 'text', text: '在吗' },
  { from: 'them', who: '大萌神', kind: 'text', text: '这周六有空不' },
]);
const afterOne = world.groupTailFp(
  [
    { from: 'them', who: '大萌神', kind: 'text', text: '在吗' },
    { from: 'them', who: '大萌神', kind: 'text', text: '这周六有空不' },
    { from: 'them', who: '大萌神', kind: 'text', text: '晚上出来吃饭' },
  ],
  { tail: seenScreen.tailKeys, last: seenScreen.last },
);
check(
  '群里只推新增的那条，不带历史',
  afterOne.tail.length === 1 && afterOne.tail[0].text === '晚上出来吃饭',
);
check(
  '群里最后一条没变就不推',
  world.groupTailFp(
    [
      { from: 'them', who: '大萌神', kind: 'text', text: '在吗' },
      { from: 'them', who: '大萌神', kind: 'text', text: '这周六有空不' },
    ],
    { tail: seenScreen.tailKeys, last: seenScreen.last },
  ).tail.length === 0,
);
// 群名匹配：没起名的群标题是成员名拼接，她只写一部分也得认出来
cfg.douyinGroups = '';
world.groupAuto = { at: Date.now(), names: ['小月月一直在玩, 穹, 大萌神'] };
check('自动识别的群名能用', world.groupNames()[0] === '小月月一直在玩, 穹, 大萌神');
check('只写成员名也能对上群', world.sameGroup('小月月一直在玩, 穹, 大萌神', '穹') === true);
check('不相干的名字对不上', world.sameGroup('小月月一直在玩, 穹, 大萌神', '路人甲') === false);
// 两个群：标题里都带「小月月一直在玩」，靠"包含"就会发错群——必须认唯一
world.groupAuto = { at: Date.now(), names: ['小月月一直在玩, 穹, 大萌神', '小月月一直在玩, 阿猫, 阿狗'] };
check(
  '两个群时整串相等优先',
  world.matchGroup(world.groupNames(), '小月月一直在玩, 穹, 大萌神') === '小月月一直在玩, 穹, 大萌神',
);
check('两个群都像就不猜', world.matchGroup(world.groupNames(), '小月月一直在玩') === null);
const twoGroupPlan = await world.buildPlan('dm', { platform: 'douyin', target: '小月月一直在玩, 阿猫, 阿狗', text: '在的' });
check('两个群时能精确发到第二个', twoGroupPlan.ok === true && twoGroupPlan.target === '小月月一直在玩, 阿猫, 阿狗');
const ambiguousPlan = await world.buildPlan('dm', { platform: 'douyin', target: '小月月一直在玩', text: '在的' });
check('两个群都像时不乱发，让她问清楚', ambiguousPlan.ok === false);
// 反向包含是个坑：她写的是更长的群名（群二），不能反过来命中更短的群一
world.groupAuto = { at: Date.now(), names: ['小月月一直在玩, 穹, 大萌神'] };
check(
  '写更长的群名不会误配到短群',
  world.matchGroup(world.groupNames(), '小月月一直在玩, 穹, 大萌神, 阿猫') === null,
);
// 两个群同名（同一批人建的两个群）：第二个带 #2，能精确点到
world.groupAuto = { at: Date.now(), names: ['小月月一直在玩, 穹, 大萌神', '小月月一直在玩, 穹, 大萌神 #2'] };
check(
  '同名群用 #2 区分',
  world.matchGroup(world.groupNames(), '小月月一直在玩, 穹, 大萌神 #2') === '小月月一直在玩, 穹, 大萌神 #2',
);
// 会话标题带群人数/尾注也算同一个会话（不然每发一条都会白点一次会话，慢半秒）
check('标题带（3）也算同一个群', world.douyin.threadTitleMatches('测试3（3）', '测试3') === true);
check('群标题不会被当成人的昵称', world.douyin.threadTitleMatches('小月月一直在玩', '小月月一直在玩, 穹, 大萌神') === false);
// 限流和验证别混为一谈：主人看到的说法完全不一样
const rateErr = world.douyin.riskError({ kind: 'rate', hit: '操作频繁@semi-toast' }, '发私信');
check('限流说明是限流，不是验证', /限流/.test(rateErr.message) && !/验证/.test(rateErr.message), rateErr.message);
const verifyErr = world.douyin.riskError({ kind: 'verify', hit: '完成验证@semi-modal' }, '发私信');
check('验证说明是验证', /验证/.test(verifyErr.message), verifyErr.message);
world.douyin.rateUntil = 0;
// 刚被群消息叫起来、回话漏了 target：必须让她写清楚，不能偷偷发成私信
world.groupAuto = { at: Date.now(), names: ['小月月一直在玩, 穹, 大萌神'] };
world.lastGroupPoke = { group: '小月月一直在玩, 穹, 大萌神', at: Date.now() };
const noTargetAfterGroup = await world.buildPlan('dm', { platform: 'douyin', text: '来了' });
check('群消息之后漏 target 不发私信', noTargetAfterGroup.ok === false && /群/.test(noTargetAfterGroup.error ?? ''));
const pokedGroupPlan = await world.buildPlan('dm', { platform: 'douyin', target: '穹', text: '来了' });
check('群消息之后写群名就发群', pokedGroupPlan.ok === true && pokedGroupPlan.group === true);
// 主人刚私信过（90 秒内）：随后进群消息也不能把「回私信」判成「要回群」
world.lastDmPoke = { at: Date.now() };
const dmWins = await world.buildPlan('dm', { platform: 'douyin', text: '在' });
// 这里主人还没绑，后面会报「没绑主人」；关键是**不能**报「刚才那条是群里的」
check('主人刚私信过就不拦私信', !(dmWins.ok === false && /群/.test(dmWins.error ?? '')), dmWins.error);
world.lastDmPoke = { at: 0 };
world.lastGroupPoke = null;
world.groupAuto = { at: Date.now(), names: ['小月月一直在玩, 穹, 大萌神'] };
const aliasPlan = await world.buildPlan('dm', { platform: 'douyin', target: '群', text: '在的' });
check('只有一个群时 target 写「群」也能发', aliasPlan.ok === true && aliasPlan.group === true);
// 群里 @ 人：手打的 @ 是假 @（只是文字，对方收不到通知），计划阶段就剥掉
const ownerBackup = world.store.data.douyinOwner;
const ownerCfgBackup = cfg.ownerDouyin;
// douyinOwner() 只有在 cfg.ownerDouyin 的 sec_uid 和保存的昵称对得上时才给 name
cfg.ownerDouyin = 'MS4wLjABAAAAabcdefghijklmnop';
world.store.data.douyinOwner = { secUid: 'MS4wLjABAAAAabcdefghijklmnop', name: '小月月一直在玩', at: Date.now() };
const atPlan = await world.buildPlan('dm', {
  platform: 'douyin',
  target: '穹',
  text: '@小月月一直在玩 在吗',
  mention_owner: true,
});
check(
  '群消息计划剥掉手打 @，只留正文',
  atPlan.ok === true && atPlan.text === '在吗' && atPlan.mention === '小月月一直在玩',
);
const fakeOnly = await world.buildPlan('dm', { platform: 'douyin', target: '穹', text: '@小月月一直在玩', mention_owner: true });
check('只剩 @ 的群消息不让发', fakeOnly.ok === false);
// 也可以指定 @ 群里的别人（她之前想 @ 大萌神，但只有 @ 主人的开关）
const otherPlan = await world.buildPlan('dm', { platform: 'douyin', target: '穹', text: '@大萌神 在吗', mention: '大萌神' });
check('可以 @ 群里指定的人', otherPlan.ok === true && otherPlan.mention === '大萌神' && otherPlan.text === '在吗');
// 明确要私信主人：target 写「主人」，别再靠「没填 target」这种含糊写法
const ownerDmPlan = await world.buildPlan('dm', { platform: 'douyin', target: '主人', text: '刚在群里回了' });
check(
  'target=主人 明确发私信',
  ownerDmPlan.ok === true && !ownerDmPlan.group && ownerDmPlan.target === world.douyinOwner().secUid,
);
// target 写主人的昵称不能被群名匹配走（线上：她写「小月月一直在玩」，话进了群）
const byNickPlan = await world.buildPlan('dm', { platform: 'douyin', target: '小月月一直在玩', text: '在的' });
check('target 写主人昵称也走私信', byNickPlan.ok === true && !byNickPlan.group);
// 「@你」不是昵称：她不知道主人的抖音名时会这么写，应该当成 @ 主人，而不是拿「你」去候选里找人
world.store.data.douyinOwner = { secUid: 'MS4wLjABAAAAabcdefghijklmnop', name: '小月月一直在玩', at: Date.now() };
const youPlan = await world.buildPlan('dm', { platform: 'douyin', target: '穹', text: '@你 在吗', mention_owner: true });
check('正文写 @你 也能 @ 到主人', youPlan.ok === true && youPlan.mention === '小月月一直在玩' && youPlan.text === '在吗');
const youMention = await world.buildPlan('dm', { platform: 'douyin', target: '穹', text: '在吗', mention: '你' });
check('mention 传「你」也当主人', youMention.ok === true && youMention.mention === '小月月一直在玩');
// 线上最常见的情况：她压根不传 mention，直接把名字写在正文开头（「大萌神，在吗」）
const leadPlan = await world.buildPlan('dm', { platform: 'douyin', target: '穹', text: '大萌神，在吗，这么晚还没睡。' });
check('开头写群成员名字也算 @', leadPlan.ok === true && leadPlan.mention === '大萌神' && leadPlan.text === '在吗，这么晚还没睡。');
const leadOwner = await world.buildPlan('dm', { platform: 'douyin', target: '穹', text: '小月月一直在玩 在吗' });
check('开头的名字是主人也能 @', leadOwner.ok === true && leadOwner.mention === '小月月一直在玩' && leadOwner.text === '在吗');
const noName = await world.buildPlan('dm', { platform: 'douyin', target: '穹', text: '今天好累啊' });
check('没写名字就不乱 @', noName.ok === true && !noName.mention);
// 正文开头手打的 @别人：当成 @ 目标去插 chip，而不是发一串没有效果的蓝字
const fromTextPlan = await world.buildPlan('dm', { platform: 'douyin', target: '穹', text: '@大萌神 在吗' });
check('正文开头写 @别人 会当 @ 目标', fromTextPlan.ok === true && fromTextPlan.mention === '大萌神' && fromTextPlan.text === '在吗');
world.store.data.douyinOwner = { ...ownerBackup, name: '' };
const noNamePlan = await world.buildPlan('dm', { platform: 'douyin', target: '穹', text: '在吗', mention_owner: true });
check('不知道主人昵称时如实拒绝 @', noNamePlan.ok === false && /昵称/.test(noNamePlan.error ?? ''));
world.store.data.douyinOwner = ownerBackup;
cfg.ownerDouyin = ownerCfgBackup;
world.groupAuto = { at: 0, names: [] };

// 手打的 @ 只是普通字符：抖音会染成蓝色但不通知任何人，发出去前要剥掉
check('剥掉开头手打的假 @', stripLeadingFakeAt('@大萌神 在吗') === '在吗');
check('剥掉孤零零的 @', stripLeadingFakeAt('@ 你了') === '你了');
check('正文中间的 @ 不动', stripLeadingFakeAt('价格是 5@6 元') === '价格是 5@6 元');
check('整条只剩 @ 就不发', stripLeadingFakeAt('@') === '');
check('剥掉 @你', stripAtPlaceholder('@你 在吗') === '在吗');
check('剥掉 @主人', stripAtPlaceholder('@主人，看看') === '，看看');
check('正常昵称不动', stripAtPlaceholder('@大萌神 在吗') === '@大萌神 在吗');
world.store.data.lastWriteAt = 0;
world.store.data.lastWriteByPlat = {};

/* ---------------- 表情包库 ---------------- */
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
check('表情包认得出 png/gif', extOfBuffer(png) === '.png' && extOfBuffer(Buffer.from('GIF89a......', 'latin1')) === '.gif');
const book = new StickerBook({ dataDir: tmp });
const add1 = book.addBuffer(png, { name: '开心', tags: ['开心'], src: 'https://p3.douyinpic.com/a.png?x=1' });
check('收藏一张表情', add1.ok === true && add1.duplicate === false && fs.existsSync(book.fileOf(add1.entry)));
const add2 = book.addBuffer(png, { name: '重复' });
check('同一张不重复存', add2.ok === true && add2.duplicate === true && book.stats().total === 1);
check('按名字挑', book.find('开心').ok === true && book.find('开心').entry.id === add1.entry.id);
check('按序号挑', book.find('1').ok === true);
check('挑不到给候选', book.find('不存在').ok === false && Array.isArray(book.find('不存在').candidates));
check('改名能生效', book.rename(add1.entry.id, '大笑').ok === true && book.find('大笑').ok === true);
check('world 用的是同一个库', world.stickers.stats().total === 1);
check('表情库能列表', JSON.parse(await world.toolStroll({ action: 'stickers' })).total === 1);
check('没有的表情会如实拒绝', JSON.parse(await world.toolAct({ action: 'sticker', text: '查无此图' })).ok === false);

/* ---------------- 发自己画的图（图片工坊） ---------------- */
const mediaDir = path.join(tmp, 'workspace', 'media');
fs.mkdirSync(mediaDir, { recursive: true });
const imgA = path.join(mediaDir, '20261105-120000-aaaa1111.jpg');
const imgB = path.join(mediaDir, '20261105-123000-bbbb2222.jpg');
fs.writeFileSync(imgA, png);
fs.writeFileSync(imgB, png);
const imgBase = Date.now();
fs.utimesSync(imgA, new Date(imgBase - 60000), new Date(imgBase - 60000));
fs.utimesSync(imgB, new Date(imgBase), new Date(imgBase));
check('不发 file 就用最新一张', path.basename(world.resolveWorkshopImage('').path) === '20261105-123000-bbbb2222.jpg');
check('按 id 找图', path.basename(world.resolveWorkshopImage('aaaa1111').path) === '20261105-120000-aaaa1111.jpg');
check('按整条路径找图', world.resolveWorkshopImage(imgB).ok === true);
check('找不到就如实说', world.resolveWorkshopImage('nope').ok === false);
const imgList = JSON.parse(await world.toolStroll({ action: 'images' }));
check('列出图片工坊的图', imgList.ok === true && imgList.total === 2 && imgList.items[0].id === 'bbbb2222');

const sentImgs = [];
const oldSendImg = world.douyin.sendStickerTo;
world.douyin.sendStickerTo = async (who, opts) => {
  sentImgs.push({ who, ...opts });
  return { ok: true, via: 'upload' };
};
world.groupAuto = { at: Date.now(), names: ['图群'] };
world.store.data.douyinOwner = { secUid: 'MS4wLjABAAAAabcdefghijklmnop', name: '小月月一直在玩', at: Date.now() };
world.cfg.ownerDouyin = 'MS4wLjABAAAAabcdefghijklmnop';
const rOwnerImg = JSON.parse(await world.toolAct({ action: 'image', target: '主人', file: imgB }));
check('图发到主人私信', rOwnerImg.ok === true && sentImgs[0].who === '小月月一直在玩' && rOwnerImg.to === 'owner', JSON.stringify(rOwnerImg));
const rGroupImg = JSON.parse(await world.toolAct({ action: 'image', target: '图群', file: 'bbbb2222' }));
check('图发到群里', rGroupImg.ok === true && sentImgs[1].who === '图群' && rGroupImg.to === 'group', JSON.stringify(rGroupImg));
world.douyin.sendStickerTo = oldSendImg;
world.groupAuto = { at: 0, names: [] };

const rCommentImg = JSON.parse(
  await world.toolAct({ action: 'image', target: 'https://www.douyin.com/video/7530000000000000000', where: 'comment' }),
);
check('审批没开 auto 时评论区发图会拒绝', rCommentImg.ok === false && rCommentImg.code === 'NEED_APPROVAL', JSON.stringify(rCommentImg));
check('抖音图源比对忽略签名参数', world.douyin.sameSrc('https://p3.douyinpic.com/a.png?x=1', 'https://p3.douyinpic.com/a.png?x=2') === true
  && world.douyin.sameSrc('https://p3.douyinpic.com/b.png', 'https://p3.douyinpic.com/a.png') === false);

/* ---------------- 收图：消息里的图片要变成模型能看的附件 ---------------- */
const pngHead = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(48, 1)]);
check('认得出 png 文件头', imageMimeOf(pngHead) === 'image/png');
check('认不出就返回空', imageMimeOf(Buffer.from('not an image at all')) === '');
const oldImgFetch = world.douyin.imageBytes;
world.douyin.imageBytes = async () => pngHead;
const imgBlobs = await world.imageBlobs(['https://p3.douyinpic.com/a.png?x=1', 'https://p3.douyinpic.com/b.png'], {
  platform: 'douyin',
  label: '私信图片',
});
check('图片能变成附件', imgBlobs.length === 2 && imgBlobs[0].mime === 'image/png' && imgBlobs[0].bytes.length === pngHead.length);
check('附件带 fallback 文案', /私信图片 1/.test(imgBlobs[0].fallbackText) && /KB/.test(imgBlobs[0].fallbackText));
world.douyin.imageBytes = oldImgFetch;
// 页面里直读出来的 dataURL（blob 图走这条路）也要能变成附件
const dataBlobs = await world.imageBlobs([`data:image/png;base64,${pngHead.toString('base64')}`], { platform: 'douyin' });
check('dataURL 图也能变附件', dataBlobs.length === 1 && dataBlobs[0].mime === 'image/png' && dataBlobs[0].bytes.length === pngHead.length);

// 收到的图要落盘：不然她只能「看见」，想转发就没辙
const recvBlobs = await world.imageBlobs([`data:image/png;base64,${pngHead.toString('base64')}`], {
  platform: 'douyin',
  label: '私信图片',
});
check('收到的图会存到本地', recvBlobs.saved?.length === 1 && /^recv-[0-9a-f]{8}\.png$/.test(recvBlobs.saved[0].name));
check('存下的图能再找到', world.resolveWorkshopImage(recvBlobs.saved[0].name).ok === true);
const listWithRecv = JSON.parse(await world.toolStroll({ action: 'images' }));
check('images 里能看到收到的图', listWithRecv.items.some((x) => x.source === '收到的'), JSON.stringify(listWithRecv.items));

// 上传前归一化：jpg/png/gif/mp4 原样；webp/heic 才需要转（这里只验不需要转的那条）
check('jpg 不用转码', (await world.douyin.normalizeImageForUpload(null, imgB)) === imgB);
// 发图失败后的冷却：到点前直接拒绝，不再去页面上试
world.douyin._imgSendUntil = Date.now() + 30000;
const cooling = await world.douyin.sendChatImage(null, null, imgB);
check('发图冷却期内直接拒绝', cooling.ok === false && cooling.code === 'IMAGE_COOLDOWN', JSON.stringify(cooling));
world.douyin._imgSendUntil = 0;

// push 要把附件原样交给宿主（宿主再按模型支持的 MIME 附上去）
const captured = [];
world.host = { pushEvent: async (e) => { captured.push(e); return {}; } };
await world.push('stroll.reply', '带图测试', {}, 'flush', imgBlobs);
check('推送带上图片附件', captured[0]?.blobs?.length === 2 && captured[0].text === '带图测试');
world.host = null;

// @ 候选行会把身份标签拼在名字前面（线上读到的是「群主 小月月一直在玩」），比对前要剥掉
const atRows = [{ text: '群主 小月月一直在玩' }, { text: '大萌神' }, { text: '成员 穹' }];
check('候选行带「群主」标签也能对上人', world.douyin.pickAtRow(atRows, '小月月一直在玩')?.text === '群主 小月月一直在玩');
check('候选行带「成员」标签也能对上人', world.douyin.pickAtRow(atRows, '穹')?.text === '成员 穹');
check('名字前有 @ 也能对上', world.douyin.pickAtRow([{ text: '@大萌神' }], '大萌神')?.text === '@大萌神');
check('两个人选都像就不乱 @', world.douyin.pickAtRow([{ text: '小月月' }, { text: '小月月一直在玩' }], '小月') === null);
check('名单里没这个人就不 @', world.douyin.pickAtRow(atRows, '不存在的人') === null);
// 老版本把 GBK 输出按 UTF-8 读，路径里会留下替换符；这种值不能再拿去 mkdir
check('认得出坏路径', looksBrokenPath(`E:\\${String.fromCharCode(65533)}`) === true && looksBrokenPath('E:\\视频') === false);

const history = JSON.parse(await world.toolStroll({ action: 'history' }));
check('history ok', history.ok === true);

const draft = JSON.parse(await world.toolAct({ action: 'like', platform: 'bilibili', target: 'BV1SVsd6MEGZ', preview: true }));
check('draft created', draft.ok === true && draft.draft === true && !!draft.id);
check('draft pending', world.store.pendingDrafts().length === 1);
check('model cannot approve', JSON.parse(await world.toolAct({ action: 'approve', draft_id: draft.id })).ok === false);
const rejected = world.rejectDraft(draft.id);
check('reject', rejected.ok === true);

const policy = JSON.parse(await world.toolPolicy({ action: 'set', patch: { dailyLikes: 4, ownerUid: '123456' } }));
check('policy set', policy.ok === true && cfg.dailyLikes === 4 && cfg.ownerUid === '123456');

/* ---------------- 每天必做 ---------------- */
const mustDay = dayKey(new Date(), world.timeZone);
const prevMustCfg = { like: world.cfg.mustLike, dailyLikes: world.cfg.dailyLikes, auto: world.cfg.autoSessionsPerDay };
const prevUsageLike = Number(world.store.data.usage?.[mustDay]?.like ?? 0);
world.cfg.mustLike = true;
world.cfg.dailyLikes = 3;
world.store.data.usage[mustDay] = { ...(world.store.data.usage[mustDay] ?? {}), like: 1 };
const mustList = world.mustDoList();
check('看视频配置默认值', DEFAULTS.subtitleOpen === 12 && DEFAULTS.danmakuOpen === 30 && DEFAULTS.subtitleWatch === 2 && DEFAULTS.danmakuWatch === 6 && DEFAULTS.watchWindowSec === 15);
check('必做清单算出还差几次', mustList.length === 1 && mustList[0].done === 1 && mustList[0].left === 2, JSON.stringify(mustList));

const mustPushes = [];
const oldMustPush = world.push;
world.push = async (type, text) => {
  mustPushes.push({ type, text });
  return true;
};
const wasRunning = world.running;
world.running = true;
world.cfg.autoSessionsPerDay = 3;
world.store.data.autoSessions[mustDay] = 0;
world.store.data.lastAutoAt = Date.now() - 31 * 60 * 1000;
world.store.data.mustNudge = { day: mustDay, n: 0, at: 0 };
const mustNoon = new Date();
mustNoon.setHours(12, 0, 0, 0);
await world.tick(mustNoon.getTime());
check(
  '必做没完成会强制出门',
  mustPushes.some((p) => p.type === 'stroll.due' && /必做日/.test(p.text)) && Number(world.store.data.autoSessions[mustDay]) === 1,
  JSON.stringify(mustPushes).slice(0, 160),
);

mustPushes.length = 0;
world.store.data.mustNudge = { day: mustDay, n: 0, at: 0 };
await world.maybeMustNudge(world.mustDoList().filter((x) => x.left > 0), 19, mustDay);
await world.maybeMustNudge(world.mustDoList().filter((x) => x.left > 0), 19, mustDay);
check('晚上必做会催，且 30 分钟内只催一次', mustPushes.filter((p) => /必做没完成/.test(p.text)).length === 1);

world.push = oldMustPush;
world.running = wasRunning;
world.cfg.mustLike = prevMustCfg.like;
world.cfg.dailyLikes = prevMustCfg.dailyLikes;
world.cfg.autoSessionsPerDay = prevMustCfg.auto;
world.store.data.usage[mustDay] = { ...(world.store.data.usage[mustDay] ?? {}), like: prevUsageLike };
world.store.data.autoSessions[mustDay] = 0;

/* ---------------- 群数量上限（可配置） ---------------- */
const prevGroupCfg = {
  max: world.cfg.maxGroups,
  tabs: world.cfg.groupTabs,
  names: world.cfg.douyinGroups,
  auto: world.groupAuto,
};
world.cfg.maxGroups = 4;
world.cfg.groupTabs = 2;
world.cfg.douyinGroups = '';
world.groupAuto = { at: Date.now(), names: ['g1', 'g2', 'g3', 'g4', 'g5'], next: Date.now() + 600000, seenAt: {} };
check('名单按 maxGroups 截断', world.groupNames().length === 4 && world.groupNames()[3] === 'g4');
world.cfg.douyinGroups = 'g1,g2,g3,g4';
check('手填群名不再退化成 2 个', world.groupNames().length === 4, JSON.stringify(world.groupNames()));
check('上限会被夹在合法范围', world.maxGroupsCap() === 4 && world.groupTabsCap() === 2);

world.groupAuto = { at: Date.now(), names: [], next: Date.now() + 600000, seenAt: {} };
world.absorbGroups(
  ['g1', 'g2', 'g3', 'g4', 'g5'].map((name, i) => ({ kind: 'group', name, cid: `cid${i}` })),
  { ttlMs: 60000 },
);
check('自动识别的群也按 maxGroups 保留', (world.groupAuto.names ?? []).length === 4, JSON.stringify(world.groupAuto.names));

const armedGroups = [];
const prevWatchGroup = world.douyin.watchGroup;
const prevGroupArmed = world.douyin.groupArmed;
const prevGroupSlot = world.douyin.groupSlot;
const prevPrune = world.douyin.pruneGroupPages;
world.douyin.watchGroup = async (name) => {
  armedGroups.push(name);
  return { ok: true };
};
world.douyin.groupArmed = () => false;
world.douyin.groupSlot = () => null;
world.douyin.pruneGroupPages = async () => {};
world.seedGroupBaseline = async () => {};
await world.armGroupPush();
check('只常驻 groupTabs 个群监听页', armedGroups.length === 2, JSON.stringify(armedGroups));
world.douyin.watchGroup = prevWatchGroup;
world.douyin.groupArmed = prevGroupArmed;
world.douyin.groupSlot = prevGroupSlot;
world.douyin.pruneGroupPages = prevPrune;

world.cfg.maxGroups = prevGroupCfg.max;
world.cfg.groupTabs = prevGroupCfg.tabs;
world.cfg.douyinGroups = prevGroupCfg.names;
world.groupAuto = prevGroupCfg.auto;

/* ---------------- B站字幕/弹幕 ---------------- */
const oldBiliViewMedia = world.bili.view;
const oldBiliReqMedia = world.bili.request;
const oldFetchRawMedia = world.bili.fetchRaw;
world.bili.view = async () => ({ aid: '1', cid: '999', bvid: 'BV1test', title: '测试', duration: 100 });
world.bili.request = async (route) => (/player/.test(route) ? { subtitle: { subtitles: [] } } : {});
const dmXml = '<i><d p="10.5,1,25,16777215,0,0,0,0">你好&amp;世界</d><d p="30,1,25,16711680,0,0,0,0">第二条</d></i>';
world.bili.fetchRaw = async () => zlib.deflateRawSync(Buffer.from(dmXml));
const mt = await world.bili.mediaText('BV1test', { danmakuLimit: 10 });
check('B站弹幕能解析', mt.ok === true && mt.danmaku.length === 2 && mt.danmaku[0].text === '你好&世界', JSON.stringify(mt.danmaku));
const near = await world.bili.mediaText('BV1test', { around: 30, windowSec: 5 });
check('一起看只取附近弹幕', near.danmaku.length === 1 && near.danmaku[0].text === '第二条', JSON.stringify(near.danmaku));
world.bili.view = oldBiliViewMedia;
world.bili.request = oldBiliReqMedia;
world.bili.fetchRaw = oldFetchRawMedia;

/* ---------------- 一起看主动说话 / 后台看完说一句 ---------------- */
check('一起看解说默认值', DEFAULTS.watchTalk === true && DEFAULTS.watchLines === 2 && DEFAULTS.openTalk === false);
const prevWatch = world.watch;
const prevDigest = world.douyin.watchDigest;
const prevWatchComments = world.watchComments;
const prevPush2 = world.push;
const watchPushes = [];
world.push = async (type, text) => {
  watchPushes.push(text);
  return true;
};
world.watch = { url: 'https://example.com/v', title: '测试视频', platform: 'web', startedAt: Date.now() };
world.lastWatchPush = 0;
world.cfg.watchTalk = true;
world.cfg.watchLines = 2;
world.cfg.watchSpeakSec = 20;
world.douyin.watchDigest = async () => ({ platform: 'web', url: 'https://example.com/v', title: '测试视频', time: 10, duration: 100, paused: false });
world.watchComments = async () => [];
await world.watchTick();
check('一起看会要求她说两句', watchPushes.some((t) => /用 2 句说说/.test(t)), JSON.stringify(watchPushes).slice(0, 120));
world.watch = prevWatch;
world.douyin.watchDigest = prevDigest;
world.watchComments = prevWatchComments;
world.push = prevPush2;

const prevBiliOpen = world.bili.open;
const prevMediaText = world.bili.mediaText;
world.cfg.openTalk = true;
world.bili.open = async () => ({ kind: 'video', id: 'BV1GJ411x7h7', title: '测试', author: 'UP', url: 'https://www.bilibili.com/video/BV1GJ411x7h7', dur: '1:00' });
world.bili.mediaText = async () => ({ ok: true, subtitles: [], danmaku: [], total: { subtitles: 0, danmaku: 0 } });
const opened = JSON.parse(await world.toolStroll({ action: 'open', url: 'https://www.bilibili.com/video/BV1GJ411x7h7' }));
check('后台看完会提示说一句', typeof opened.followUp === 'string' && /说说/.test(opened.followUp), JSON.stringify(opened).slice(0, 120));
world.bili.open = prevBiliOpen;
world.bili.mediaText = prevMediaText;
world.cfg.openTalk = false;

check('没开一起看时 digest 为空', (await world.douyin.watchDigest()) === null);

const prevCookieHeader = world.bili.cookieHeader;
world.bili.cookieHeader = () => 'SESSDATA=abc%3D; bili_jct=def; buvid3=xyz';
const watchCookies = world.biliCookiesForWatch();
check(
  'B站登录态能带进陪看浏览器',
  watchCookies.length === 3 && watchCookies[0].name === 'SESSDATA' && watchCookies[0].value === 'abc%3D' && watchCookies[0].domain === '.bilibili.com',
  JSON.stringify(watchCookies),
);
world.bili.cookieHeader = prevCookieHeader;

check('陪看浏览器默认 Chrome 优先', DEFAULTS.watchBrowser === 'auto');
check('陪看窗口默认最大化', DEFAULTS.watchWindow === 'maximized');

/* ---------------- 抖音一起刷 ---------------- */
check(
  '一起刷默认关',
  DEFAULTS.watchScroll === false && DEFAULTS.watchScrollSec === 0 && DEFAULTS.watchScrollEvery === 1 && DEFAULTS.watchShot === false,
);

const prevScrollCfg = { on: world.cfg.watchScroll, sec: world.cfg.watchScrollSec, every: world.cfg.watchScrollEvery };
const prevWatchNext2 = world.douyin.watchNext;
const prevWatchComments3 = world.douyin.watchComments;

world.cfg.watchScroll = false;
world.watchScrollState = { id: '111', at: Date.now() - 60000, count: 0, seen: [], retryAt: 0 };
check(
  '没开一起刷就不切',
  (await world.maybeWatchScroll({ platform: 'douyin', videoId: '111', url: 'https://www.douyin.com/video/111', duration: 10, time: 10 })) === null,
);

let nextCalls = 0;
world.cfg.watchScroll = true;
world.cfg.watchScrollSec = 0;
world.douyin.watchNext = async () => {
  nextCalls += 1;
  return {
    ok: true,
    via: 'list',
    digest: { platform: 'douyin', videoId: '222', url: 'https://www.douyin.com/video/222', title: '下一条', time: 0, duration: 12 },
  };
};
const sc1 = await world.maybeWatchScroll({
  platform: 'douyin',
  videoId: '111',
  url: 'https://www.douyin.com/video/111',
  duration: 10,
  time: 10,
});
check(
  '播完会切下一条',
  sc1?.ok === true && nextCalls === 1 && world.watchScrollState.id === '222' && world.watchScrollState.count === 1,
  JSON.stringify(sc1)?.slice(0, 120),
);

world.cfg.watchScrollSec = 30;
world.watchScrollState = { id: '222', at: Date.now() - 1000, count: 1, seen: ['111', '222'], retryAt: 0 };
check(
  '没到设定秒数不切',
  (await world.maybeWatchScroll({ platform: 'douyin', videoId: '222', url: 'https://www.douyin.com/video/222', duration: 60, time: 5 })) === null,
);
world.watchScrollState = { id: '222', at: Date.now() - 31000, count: 1, seen: ['111', '222'], retryAt: 0 };
check(
  '到设定秒数就切',
  (await world.maybeWatchScroll({ platform: 'douyin', videoId: '222', url: 'https://www.douyin.com/video/222', duration: 60, time: 5 }))?.ok === true,
);

world.cfg.watchScroll = true;
check(
  'B站不会被一起刷带跑',
  (await world.maybeWatchScroll({ platform: 'bilibili', url: 'https://www.bilibili.com/video/BV1x', duration: 100, time: 100 })) === null,
);

world.cfg.watchScrollSec = 0;
let longCalls = 0;
world.douyin.watchNext = async () => {
  longCalls += 1;
  return { ok: false, code: 'NO_NEXT' };
};
// 长视频：读得到时长（10 分钟）时，不能因为「等了 90 秒」就被切走
world.watchScrollState = { id: '333', at: Date.now() - 95000, count: 0, seen: [], retryAt: 0 };
const longVideo = await world.maybeWatchScroll({
  platform: 'douyin',
  videoId: '333',
  url: 'https://www.douyin.com/video/333',
  duration: 600,
  time: 95,
});
check('长视频不会被 90 秒兜底切走', longVideo === null && longCalls === 0, `calls=${longCalls}`);
// 读不到时长（duration 0）时才用 90 秒兜底
world.watchScrollState = { id: '444', at: Date.now() - 95000, count: 0, seen: [], retryAt: 0 };
await world.maybeWatchScroll({
  platform: 'douyin',
  videoId: '444',
  url: 'https://www.douyin.com/video/444',
  duration: 0,
  time: 0,
});
check('读不到时长才用 90 秒兜底', longCalls === 1, `calls=${longCalls}`);

world.douyin.watchNext = async () => ({ ok: false, code: 'NO_NEXT' });
world.watchScrollState = { id: '222', at: Date.now() - 60000, count: 2, seen: [], retryAt: 0 };
const scrollFail = await world.maybeWatchScroll({
  platform: 'douyin',
  videoId: '222',
  url: 'https://www.douyin.com/video/222',
  duration: 10,
  time: 10,
});
check('切不动会退避 10 秒', scrollFail === null && world.watchScrollState.retryAt > Date.now());

// 自动刷时推送要写「自动刷到了下一条」，而不是「主人翻到了新页面」
const prevPush3 = world.push;
const prevDigest3 = world.douyin.watchDigest;
const prevNext3 = world.douyin.watchNext;
const prevTalk = world.cfg.watchTalk;
const prevShot = world.cfg.watchShot;
const scrollTexts = [];
world.push = async (type, text) => {
  scrollTexts.push(text);
  return true;
};
world.cfg.watchScroll = true;
world.cfg.watchScrollSec = 0;
world.cfg.watchScrollEvery = 1;
world.cfg.watchTalk = true;
world.cfg.watchShot = false;
world.watch = { startedAt: Date.now(), url: 'https://www.douyin.com/video/111', title: '第一条', platform: 'douyin', last: { videoId: '111' } };
world.watchScrollState = { id: '111', at: Date.now() - 60000, count: 0, seen: ['111'], retryAt: 0 };
world.douyin.watchDigest = async () => ({
  platform: 'douyin',
  videoId: '111',
  url: 'https://www.douyin.com/video/111',
  title: '第一条',
  author: '阿甲',
  duration: 10,
  time: 10,
  comments: ['甲：好看'],
});
world.douyin.watchNext = async () => ({
  ok: true,
  via: 'list',
  digest: {
    platform: 'douyin',
    videoId: '222',
    url: 'https://www.douyin.com/video/222',
    title: '第二条',
    author: '阿乙',
    duration: 12,
    time: 0,
    comments: [],
  },
});
await world.watchTick();
check(
  '一起刷推送写「自动刷到了下一条」',
  scrollTexts.some((t) => /自动刷到了下一条/.test(t) && /第二条/.test(t) && /@阿乙/.test(t)),
  JSON.stringify(scrollTexts).slice(0, 200),
);
world.push = prevPush3;
world.douyin.watchDigest = prevDigest3;
world.douyin.watchNext = prevNext3;
world.cfg.watchTalk = prevTalk;
world.cfg.watchShot = prevShot;
world.watch = null;
world.watchScrollState = null;

// 陪看浏览器要带抖音登录态（主浏览器没起来时至少还有 B站 的）
const prevCtx2 = world.douyin.context;
const prevCookieHeader2 = world.bili.cookieHeader;
world.douyin.context = null;
world.bili.cookieHeader = () => 'SESSDATA=abc; bili_jct=def';
const wc1 = await world.watchCookies();
check('陪看 cookie 带 B站 登录态', wc1.some((c) => c.name === 'SESSDATA') && wc1.length >= 2, JSON.stringify(wc1).slice(0, 120));
world.douyin.context = prevCtx2;
world.bili.cookieHeader = prevCookieHeader2;

const dmComments = await world.watchComments({ platform: 'douyin', comments: ['甲：好看', '乙：哈哈'] });
check('抖音评论先用手上的 DOM', dmComments.length === 2 && dmComments[0] === '甲：好看');
world.douyin.watchComments = async () => ['丙：点开评论区才读到'];
const dmComments2 = await world.watchComments({ platform: 'douyin', comments: [] });
check('DOM 空了才去点开评论区', dmComments2[0] === '丙：点开评论区才读到');

world.douyin.watchNext = prevWatchNext2;
world.douyin.watchComments = prevWatchComments3;
world.cfg.watchScroll = prevScrollCfg.on;
world.cfg.watchScrollSec = prevScrollCfg.sec;
world.cfg.watchScrollEvery = prevScrollCfg.every;
world.watchScrollState = null;

/* ---------------- 暂停 / 防重入 / 轮询间隔 ---------------- */
const prevPauseCfg = { on: world.cfg.watchScroll, sec: world.cfg.watchScrollSec, poll: world.cfg.watchPollSec };
const prevPauseDigest = world.douyin.watchDigest;
const prevPausePush = world.push;

world.cfg.watchScroll = true;
world.cfg.watchScrollSec = 0;
world.cfg.watchPollSec = 15;
world.watchScrollState = { id: '555', at: Date.now() - 60000, count: 0, seen: [], retryAt: 0 };
const pausedScroll = await world.maybeWatchScroll({
  platform: 'douyin',
  videoId: '555',
  url: 'https://www.douyin.com/video/555',
  duration: 10,
  time: 10,
  paused: true,
});
check(
  '暂停时不切视频且冻结计时',
  pausedScroll === null && world.watchScrollState.at > Date.now() - 3000,
  JSON.stringify(world.watchScrollState),
);

check('开了一起刷轮询变 4 秒', world.watchPollSeconds() === 4);
world.cfg.watchScroll = false;
check('没开一起刷按设置轮询', world.watchPollSeconds() === 15);

const pausePushes = [];
world.push = async (type, text) => {
  pausePushes.push(text);
  return true;
};
world.cfg.watchScroll = false;
world.watchBusy = false;
world.watch = { startedAt: Date.now(), url: 'https://www.douyin.com/video/666', title: '暂停测试', platform: 'douyin', last: null };
world.douyin.watchDigest = async () => ({
  platform: 'douyin',
  videoId: '666',
  url: 'https://www.douyin.com/video/666',
  title: '暂停测试',
  duration: 600,
  time: 100,
  paused: true,
});
world.lastWatchPush = 0;
await world.watchTickInner();
const firstPauseCount = pausePushes.length;
world.lastWatchPush = 0;
await world.watchTickInner();
check(
  '暂停只在刚暂停时播报一次',
  firstPauseCount === 1 && pausePushes.length === 1,
  `first=${firstPauseCount} total=${pausePushes.length}`,
);

let digestCalls = 0;
world.douyin.watchDigest = async () => {
  digestCalls += 1;
  return null;
};
world.watchBusy = true;
await world.watchTick();
check('上一轮没跑完就跳过这轮', digestCalls === 0);
world.watchBusy = false;

world.push = prevPausePush;
world.douyin.watchDigest = prevPauseDigest;
world.watch = null;
world.watchScrollState = null;
world.cfg.watchScroll = prevPauseCfg.on;
world.cfg.watchScrollSec = prevPauseCfg.sec;
world.cfg.watchPollSec = prevPauseCfg.poll;

// 陪看窗口被关掉：连续三次读不到就自动结束
const prevGoneDigest = world.douyin.watchDigest;
const prevGoneStop = world.watchStop;
let stopCalls = 0;
world.watchStop = async () => {
  stopCalls += 1;
  return { ok: true };
};
world.watch = { startedAt: Date.now(), url: 'https://www.douyin.com/video/1', title: 'gone', platform: 'douyin', last: null };
world.watchMiss = 0;
world.douyin.watchDigest = async () => null;
await world.watchTickInner();
await world.watchTickInner();
check('两次读不到还不收工', stopCalls === 0, `calls=${stopCalls}`);
await world.watchTickInner();
check('连续三次读不到就自动结束', stopCalls === 1, `calls=${stopCalls}`);
world.watchStop = prevGoneStop;
world.douyin.watchDigest = prevGoneDigest;
world.watch = null;
world.watchMiss = 0;

/* ---------------- 出门时段 / 群第一句 ---------------- */
const prevOuting = { from: world.cfg.outingFrom, to: world.cfg.outingTo };
world.cfg.outingFrom = 22;
world.cfg.outingTo = 6;
check('跨天窗口：23 点在', world.inOutingWindow(23) === true);
check('跨天窗口：3 点在', world.inOutingWindow(3) === true);
check('跨天窗口：12 点不在', world.inOutingWindow(12) === false);
const noon = new Date();
noon.setHours(12, 0, 0, 0);
const nextOuting = new Date(world.nextOutingWindow(noon.getTime()));
check(
  '12 点的下次出门是当天 22 点',
  nextOuting.getHours() === 22 && nextOuting.getDate() === noon.getDate(),
  nextOuting.toString(),
);
world.cfg.outingFrom = 9;
world.cfg.outingTo = 9;
check('填一样的值＝全天', world.inOutingWindow(3) === true && world.inOutingWindow(15) === true);
world.cfg.outingFrom = prevOuting.from;
world.cfg.outingTo = prevOuting.to;

// 第一次看到某个群：结尾是别人说的话就推最后一句，不再整段吞掉
const prevGroupPush = world.push;
const prevDmWatchOn2 = world.dmWatchOn;
const prevBlobsSoon = world.imageBlobsSoon;
const prevRunning2 = world.running;
const groupPushes = [];
world.push = async (type, text) => {
  groupPushes.push(text);
  return true;
};
world.dmWatchOn = () => true;
world.imageBlobsSoon = async () => null;
world.running = true;
world.store.data.dmSeen = { ...(world.store.data.dmSeen ?? {}), groups: {} };
const groupScreen = [
  { from: 'them', who: '甲', kind: 'text', text: '历史一' },
  { from: 'them', who: '乙', kind: 'text', text: '历史二' },
  { from: 'them', who: '主人', kind: 'text', text: '@桌宠 在吗' },
];
await world.onGroupPoke(groupScreen, '新群');
check(
  '第一次看到群也会推最后一句',
  groupPushes.length === 1 && /@桌宠 在吗/.test(groupPushes[0]) && !/历史一/.test(groupPushes[0]),
  JSON.stringify(groupPushes).slice(0, 160),
);
groupPushes.length = 0;
await world.onGroupPoke(groupScreen, '新群');
check('同一屏不会重复推', groupPushes.length === 0, `n=${groupPushes.length}`);
world.push = prevGroupPush;
world.dmWatchOn = prevDmWatchOn2;
world.imageBlobsSoon = prevBlobsSoon;
world.running = prevRunning2;

console.log(checks.map(([n, ok]) => `${ok ? 'ok' : 'NO'}  ${n}`).join('\n'));
console.log(`\n${checks.length} checks passed`);
fs.rmSync(tmp, { recursive: true, force: true });

