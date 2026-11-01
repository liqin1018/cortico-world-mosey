/**
 * worlds.stroll 配置段。
 * 所有公开动作都有硬额度；额度不是建议值，Policy 会按它拦截。
 */

export const DEFAULTS = {
  enabled: false,

  bilibili: true,
  douyin: true,

  /** confirm: 公开动作全部进草稿箱等主人点批准；auto_low_risk: 点赞自动，其余草稿；auto_all: 全部按额度自动；dry_run: 只读。 */
  approval: 'confirm',
  allowFollow: true,
  allowDm: true,
  allowPost: true,
  allowSave: true,

  /** 主人（人类）的账号；@ 和私信要用。留空时只能站内告诉主人。 */
  ownerUid: '',
  ownerName: '',
  ownerDouyin: '',

  dailyLikes: 16,
  dailyComments: 6,
  dailyFollows: 3,
  dailyPosts: 2,
  dailyDms: 3,
  dailySaves: 8,

  quietFrom: 23,
  quietTo: 8,
  minGapSeconds: 90,

  /** 0 = 不自己出门；默认一天五次，比较像会自己刷手机的人。 */
  autoSessionsPerDay: 5,
  /** 两次自动出门之间至少隔多少分钟；和主人手动互动无关。 */
  autoGapMinutes: 90,
  sessionMaxItems: 8,

  /** 兴趣词，逗号分隔；本地打分用，不额外调模型。 */
  interests: '',
  avoid: '',

  /** 打开视频时抽几帧。0 = 不抽，最省 token。 */
  framesPerOpen: 0,
  /** 打开视频后窗口留多久（秒）；0 = 看完就关。后台模式不弹窗。 */
  keepWindowSeconds: 90,
  /** 默认后台逛（headless）。只有扫码登录和「一起看」才开窗。 */
  background: true,
  /** 一起看：多久读一次页面（秒）。 */
  watchPollSec: 15,
  /** 一起看：至少隔多久才主动说一句（秒）。 */
  watchSpeakSec: 60,

  /** 复用应用里已有的 B站登录资料（通常是小号/桌宠号）。 */
  sharedBiliCookie: true,
  /** 每天给这个小家伙的模型预算，超了就只读不主动出门。 */
  tokenDailyBudget: 9000,
  commentMaxChars: 120,
  newAccountRamp: false,
  /** 她开始看东西时怎么提醒你：off / panel（面板浮条）/ chat（顺便在对话里说一句）。 */
  watchNotify: 'panel',
  riskPauseHours: 48,
};

const P = 'worlds.stroll.';

/** 基础：开关、平台、放行方式、身份。 */
const BASIC = {
  id: 'world:stroll',
  owner: 'world:stroll',
  schema: {
    type: 'object',
    title: '基础',
    description: '开关、去哪个平台、公开动作怎么放行。改完即时生效。',
    properties: {
      [P + 'enabled']: {
        type: 'boolean',
        title: '启用摸鱼',
        description: '关掉后不刷、不看、不发，只保留历史记录。',
        'x-hot': true,
      },
      [P + 'bilibili']: {
        type: 'boolean',
        title: '去 B站',
        description: '用应用里已有的 B站登录态；只读不需要登录。',
      },
      [P + 'douyin']: {
        type: 'boolean',
        title: '去抖音',
        description: '独立 Edge/Chrome 资料，第一次要在面板里扫码登录。',
      },
      [P + 'background']: {
        type: 'boolean',
        title: '后台逛（不弹网页）',
        description: '开着时都在后台读；只有扫码登录和「一起看」开窗口。',
        'x-hot': true,
      },
      [P + 'approval']: {
        type: 'string',
        title: '公开动作怎么放行',
        'x-options': 'stroll-approval',
        description: '评论、关注、发动态、私信默认都要你点头；「按额度自动」会跳过确认。',
        'x-hot': true,
        'x-warning': true,
      },
      [P + 'autoSessionsPerDay']: {
        type: 'integer',
        title: '每天自己出门',
        description: '0 = 只在你叫的时候去；5 次像正常人刷手机，活跃但不是刷量。',
        minimum: 0,
        maximum: 10,
        'x-suffix': ' 次/天',
        'x-hot': true,
      },
      [P + 'autoGapMinutes']: {
        type: 'integer',
        title: '两次出门至少隔',
        description: '太密容易撞平台风控。90 分钟 ≈ 一天能出去 5 次；想更勤就调到 60。',
        minimum: 30,
        maximum: 360,
        'x-suffix': ' 分钟',
        'x-hot': true,
      },
      [P + 'ownerUid']: {
        type: 'string',
        title: '主人 B站 UID',
        description: '用于评论/动态里 @ 你、给你发私信。留空就只能在桌面告诉你。',
        'x-hot': true,
      },
      [P + 'ownerName']: {
        type: 'string',
        title: '主人 B站昵称',
        description: 'B站 @ 认昵称；填了 UID 后程序会自己查，查不到才用这里。',
      },
      [P + 'ownerDouyin']: {
        type: 'string',
        title: '主人抖音 sec_uid',
        description: '只有要发抖音私信才需要；MS4w 开头。',
      },
    },
  },
};

/** 额度与节奏：每天能做什么、什么时候安静。 */
const QUOTA = {
  id: 'world:stroll-quota',
  owner: 'world:stroll',
  schema: {
    type: 'object',
    title: '额度与时段',
    description: '硬额度：到了就停，不是建议值。默认按新号保护再打折。',
    properties: {
      [P + 'dailyLikes']: {
        type: 'integer',
        title: '每天最多点赞',
        minimum: 0,
        maximum: 30,
        'x-suffix': ' 次',
      },
      [P + 'dailyComments']: {
        type: 'integer',
        title: '每天最多评论',
        minimum: 0,
        maximum: 20,
        'x-suffix': ' 条',
      },
      [P + 'dailyFollows']: {
        type: 'integer',
        title: '每天最多关注',
        minimum: 0,
        maximum: 5,
        'x-suffix': ' 人',
      },
      [P + 'dailyPosts']: {
        type: 'integer',
        title: '每天最多发动态',
        minimum: 0,
        maximum: 3,
        'x-suffix': ' 条',
      },
      [P + 'dailyDms']: {
        type: 'integer',
        title: '每天最多私信',
        minimum: 0,
        maximum: 5,
        'x-suffix': ' 条',
      },
      [P + 'dailySaves']: {
        type: 'integer',
        title: '每天最多稍后再看',
        minimum: 0,
        maximum: 10,
        'x-suffix': ' 条',
      },
      [P + 'quietFrom']: {
        type: 'integer',
        title: '安静时段开始',
        description: '这段时间不自己出门，也不主动说话。',
        minimum: 0,
        maximum: 23,
        'x-suffix': ' 点',
      },
      [P + 'quietTo']: {
        type: 'integer',
        title: '安静时段结束',
        minimum: 0,
        maximum: 23,
        'x-suffix': ' 点',
      },
      [P + 'minGapSeconds']: {
        type: 'integer',
        title: '两次动作至少间隔',
        description: '太快像机器，90 秒起步比较稳。',
        minimum: 30,
        maximum: 600,
        'x-suffix': ' 秒',
      },
      [P + 'sessionMaxItems']: {
        type: 'integer',
        title: '每次出门最多看几条',
        description: '看完就回来汇报，不无限刷。',
        minimum: 3,
        maximum: 12,
        'x-suffix': ' 条',
      },
      [P + 'commentMaxChars']: {
        type: 'integer',
        title: '评论最多几个字',
        description: '短一点更像人；20–300。',
        minimum: 20,
        maximum: 300,
        'x-suffix': ' 字',
      },
    },
  },
};

/** 互动与身份：能做哪些动作、以谁的身份。 */
const INTERACT = {
  id: 'world:stroll-interact',
  owner: 'world:stroll',
  schema: {
    type: 'object',
    title: '互动与身份',
    description: '关掉的动作用不了；额度仍然生效。',
    properties: {
      [P + 'allowFollow']: {
        type: 'boolean',
        title: '可以关注别人',
        description: '每次都要按审批规则来。',
      },
      [P + 'allowDm']: {
        type: 'boolean',
        title: '可以发私信',
        description: '只发给主人，不发陌生人。',
      },
      [P + 'allowPost']: {
        type: 'boolean',
        title: '可以发 B站动态',
        description: '纯文字；可以 @ 主人。',
      },
      [P + 'allowSave']: {
        type: 'boolean',
        title: '可以加稍后再看',
        description: '相当于帮你收藏一条视频。',
      },
      [P + 'sharedBiliCookie']: {
        type: 'boolean',
        title: '复用应用的 B站登录',
        description: '关掉后只能读公开内容，写动作不可用。',
      },
    },
  },
};

/** 高级：兴趣、省 token、一起看、风控。 */
const ADVANCED = {
  id: 'world:stroll-advanced',
  owner: 'world:stroll',
  schema: {
    type: 'object',
    title: '高级',
    description: '一般不用改。改错最多是多花点 token 或多等一会儿。',
    properties: {
      [P + 'interests']: {
        type: 'string',
        title: '兴趣词',
        description: '逗号分隔。只在本地给候选打分，不花模型 token。',
        'x-hot': true,
      },
      [P + 'avoid']: {
        type: 'string',
        title: '不想看的内容',
        description: '逗号分隔，命中就不进候选。',
      },
      [P + 'tokenDailyBudget']: {
        type: 'integer',
        title: '每天模型预算',
        description: '只限制主动出门的频率，不拦你主动找她。',
        minimum: 1000,
        maximum: 50000,
        'x-suffix': ' token',
      },
      [P + 'framesPerOpen']: {
        type: 'integer',
        title: '看视频抽几帧',
        description: '0 最省 token；1 帧约 500 token。',
        minimum: 0,
        maximum: 3,
        'x-suffix': ' 帧',
      },
      [P + 'keepWindowSeconds']: {
        type: 'integer',
        title: '打开后窗口留多久',
        description: '只对开窗模式有效；后台模式不弹窗。',
        minimum: 0,
        maximum: 600,
        'x-suffix': ' 秒',
      },
      [P + 'watchPollSec']: {
        type: 'integer',
        title: '一起看：多久读一次',
        description: '读标题、进度和评论区；不截图，不花 token。',
        minimum: 5,
        maximum: 120,
        'x-suffix': ' 秒',
      },
      [P + 'watchSpeakSec']: {
        type: 'integer',
        title: '一起看：多久说一句',
        description: '太短会吵。',
        minimum: 20,
        maximum: 600,
        'x-suffix': ' 秒',
      },
      [P + 'watchNotify']: {
        type: 'string',
        title: '她开始看时提醒我',
        'x-options': 'stroll-notify',
        description: '面板上永远有「正在看」浮条；选「对话里也说一句」会多花一点 token。',
        'x-hot': true,
      },
      [P + 'newAccountRamp']: {
        type: 'boolean',
        title: '新号保护',
        description: '前 3 天额度打五折，4–7 天八折，之后恢复。老号可以关掉。',
      },
      [P + 'riskPauseHours']: {
        type: 'integer',
        title: '风控后暂停多久',
        description: '遇到验证/412/频繁提示时，停写这么久。',
        minimum: 1,
        maximum: 168,
        'x-suffix': ' 小时',
      },
    },
  },
};

export const CONFIG_GROUPS = [BASIC, QUOTA, INTERACT, ADVANCED];

/** 旧引用兼容：第一组即基础组。 */
export const CONFIG_GROUP = BASIC;

/** 可经 stroll_policy 修改的字段及边界。 */
export const POLICY_FIELDS = {
  approval: { type: 'enum', values: ['confirm', 'auto_low_risk', 'auto_all', 'dry_run'] },
  ownerUid: { type: 'string', max: 20 },
  ownerName: { type: 'string', max: 40 },
  ownerDouyin: { type: 'string', max: 220 },
  bilibili: { type: 'boolean' },
  douyin: { type: 'boolean' },
  allowFollow: { type: 'boolean' },
  allowDm: { type: 'boolean' },
  allowPost: { type: 'boolean' },
  allowSave: { type: 'boolean' },
  dailyLikes: { type: 'int', min: 0, max: 30 },
  dailyComments: { type: 'int', min: 0, max: 20 },
  dailyFollows: { type: 'int', min: 0, max: 5 },
  dailyPosts: { type: 'int', min: 0, max: 3 },
  dailyDms: { type: 'int', min: 0, max: 5 },
  dailySaves: { type: 'int', min: 0, max: 10 },
  quietFrom: { type: 'int', min: 0, max: 23 },
  quietTo: { type: 'int', min: 0, max: 23 },
  minGapSeconds: { type: 'int', min: 30, max: 600 },
  autoSessionsPerDay: { type: 'int', min: 0, max: 10 },
  autoGapMinutes: { type: 'int', min: 30, max: 360 },
  sessionMaxItems: { type: 'int', min: 3, max: 12 },
  interests: { type: 'string', max: 300 },
  avoid: { type: 'string', max: 300 },
  framesPerOpen: { type: 'int', min: 0, max: 3 },
  keepWindowSeconds: { type: 'int', min: 0, max: 600 },
  background: { type: 'boolean' },
  watchSpeakSec: { type: 'int', min: 20, max: 600 },
  watchPollSec: { type: 'int', min: 5, max: 120 },
  tokenDailyBudget: { type: 'int', min: 1000, max: 50000 },
  commentMaxChars: { type: 'int', min: 20, max: 300 },
  riskPauseHours: { type: 'int', min: 1, max: 168 },
};

export function validatePolicyPatch(patch) {
  const out = {};
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return out;
  for (const [key, meta] of Object.entries(POLICY_FIELDS)) {
    if (!(key in patch)) continue;
    const value = patch[key];
    if (meta.type === 'boolean') {
      if (typeof value === 'boolean') out[key] = value;
      continue;
    }
    if (meta.type === 'enum') {
      if (meta.values.includes(value)) out[key] = value;
      continue;
    }
    if (meta.type === 'int') {
      const n = Number(value);
      if (Number.isFinite(n)) out[key] = Math.min(meta.max, Math.max(meta.min, Math.round(n)));
      continue;
    }
    if (meta.type === 'string') {
      if (typeof value === 'string') out[key] = value.trim().slice(0, meta.max);
    }
  }
  return out;
}
