import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS } from '../src/config.js';
import { stripLeadingFakeAt } from '../src/douyin.js';
import { approvalFor } from '../src/policy.js';
import { StickerBook, extOfBuffer } from '../src/stickers.js';
import { looksBrokenPath, stripAtName, stripAtPlaceholder } from '../src/util.js';
import { StrollWorld } from '../src/world.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = path.join(root, '.smoke-data');
// 上一次的浏览器 profile 可能还被系统锁着。删不掉就别硬跑——带着脏目录跑会卡在启动浏览器那步。
let cleared = false;
for (let i = 0; i < 6 && !cleared; i += 1) {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
    cleared = true;
  } catch (e) {
    await new Promise((r) => setTimeout(r, 300));
  }
}
if (!cleared) {
  console.error(`删不掉 ${tmp}（多半是上次的浏览器进程还占着）。先关掉再重跑，或手动删除该目录。`);
  process.exit(1);
}
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
check('群名最多认两个且去掉空格', JSON.stringify(world.groupNames()) === JSON.stringify(['摸鱼群', '夜聊群']));
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
check('抖音图源比对忽略签名参数', world.douyin.sameSrc('https://p3.douyinpic.com/a.png?x=1', 'https://p3.douyinpic.com/a.png?x=2') === true
  && world.douyin.sameSrc('https://p3.douyinpic.com/b.png', 'https://p3.douyinpic.com/a.png') === false);
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

console.log(checks.map(([n, ok]) => `${ok ? 'ok' : 'NO'}  ${n}`).join('\n'));
console.log(`\n${checks.length} checks passed`);
// 必须 stop：world 里有 tick / 私信轮询 / watch 三个 interval，不停就会挂住事件循环，
// 进程退不出去（浏览器也不关），最后连 .smoke-data 都删不掉。
await world.stop();
// Windows 上浏览器进程释放 profile 有延迟，直接删会 EBUSY。重试几次，实在删不掉就算了，
// 别让清理失败把「97 项都过了」变成退出码 1。
for (let i = 0; i < 8; i += 1) {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
    break;
  } catch (e) {
    if (i === 7) console.log(`(清理临时目录失败，可手动删除 ${tmp}：${e.code || e.message})`);
    else await new Promise((r) => setTimeout(r, 250));
  }
}