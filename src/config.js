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
  dailySaves: 8,

  quietFrom: 23,
  quietTo: 8,
  /** 她自己出门时的动作间隔；主人当场让她做的事不走这个数（只防连点）。 */
  minGapSeconds: 20,

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

  /** 私信监听：主人在抖音/B站发来就马上推给她回。 */
  dmWatch: true,
  /**
   * 多久兜底看一次私信（秒）。
   * 抖音现在走页面事件通道（新消息一进 DOM 就回调），轮询只是防掉线的兜底，
   * 所以可以设得比过去小很多：抖音那边几乎不花代价，B站是 HTTP 也就几十毫秒。
   */
  dmPollSec: 5,

  /** 复用应用里已有的 B站登录资料（通常是小号/桌宠号）。 */
  sharedBiliCookie: true,
  /** 每天给这个小家伙的模型预算，超了就只读不主动出门。 */
  tokenDailyBudget: 9000,
  commentMaxChars: 120,
  newAccountRamp: false,
  /** 她开始看东西时怎么提醒你：off / panel（面板浮条）/ chat（顺便在对话里说一句）。 */
  watchNotify: 'panel',
  /** 风控力度：off 只记账不拦人（默认）/ light 只在验证码时停 30 分钟 / strict 旧的长时间冷却。 */
  riskGuard: 'off',
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
        title: '主人抖音（主页链接 / sec_uid / 抖音号）',
        description:
          '最稳的是「主页分享链接」：抖音 App → 我 → 右上角分享 → 复制链接，整段粘进来（分享文案里夹着链接也行）。也可以填 MS4w 开头的 sec_uid。纯抖音号填了也解析不了——抖音搜索页对后台浏览器是空的，这条路走不通。抖音不能给自己发私信，桌宠登录的号要和你不是同一个。',
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
        title: '她自己多久能动一次',
        description: '只约束她自己出门逛的时候；你在对话里让她做的事只防连点，不受这个限制。',
        minimum: 10,
        maximum: 600,
        'x-suffix': ' 秒',
        'x-hot': true,
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
      [P + 'riskGuard']: {
        type: 'string',
        title: '风控拦截力度',
        description: 'off＝只记一笔、不拦任何动作（推荐，限流本来几十分钟就自己好）；light＝只有要验证码时停 30 分钟；strict＝旧的长时间冷却。',
        enum: ['off', 'light', 'strict'],
        'x-options': ['off', 'light', 'strict'],
        'x-labels': { off: '不拦（推荐）', light: '只在验证码时停', strict: '严格' },
      },
      [P + 'riskPauseHours']: {
        type: 'integer',
        title: '严格模式停多久',
        description: '只在「风控拦截力度＝严格」时生效。',
        minimum: 1,
        maximum: 168,
        'x-suffix': ' 小时',
      },
    },
  },
};

/** 私信：主人发来就接住，不用等她下次出门。 */
const MESSAGES = {
  id: 'world:stroll-messages',
  owner: 'world:stroll',
  schema: {
    type: 'object',
    title: '私信',
    description: '你给她发私信，她能不能马上回。抖音要常驻一个后台页面。',
    properties: {
      [P + 'dmWatch']: {
        type: 'boolean',
        title: '私信马上回',
        description:
          '开着时每隔一会儿看一眼你和她的私信，你一发就推给她回，不用等她下次出门。关掉就只能等她主动去查。',
        'x-hot': true,
      },
      [P + 'dmPollSec']: {
        type: 'integer',
        title: '多久看一次私信',
        description:
          '抖音有新消息时页面会立刻通知她（1-2 秒），这个间隔只是掉线时的兜底。默认 5 秒；嫌吵可以调到 15-30 秒。',
        minimum: 3,
        maximum: 300,
        'x-suffix': ' 秒',
        'x-hot': true,
      },
    },
  },
};

export const CONFIG_GROUPS = [BASIC, QUOTA, MESSAGES, INTERACT, ADVANCED];

/** 旧引用兼容：第一组即基础组。 */
export const CONFIG_GROUP = BASIC;

/** 可经 stroll_policy 修改的字段及边界。 */
export const POLICY_FIELDS = {
  approval: { type: 'enum', values: ['confirm', 'auto_low_risk', 'auto_all', 'dry_run'] },
  ownerUid: { type: 'string', max: 20 },
  ownerName: { type: 'string', max: 40 },
  ownerDouyin: { type: 'string', max: 500 },
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
  dailySaves: { type: 'int', min: 0, max: 10 },
  quietFrom: { type: 'int', min: 0, max: 23 },
  quietTo: { type: 'int', min: 0, max: 23 },
  minGapSeconds: { type: 'int', min: 10, max: 600 },
  riskGuard: { type: 'enum', values: ['off', 'light', 'strict'] },
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
  dmWatch: { type: 'boolean' },
  dmPollSec: { type: 'int', min: 3, max: 300 },
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
