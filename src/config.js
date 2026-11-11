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
  /** browser：她自己点；off：抖音关注改手动（网页端对部分账号不生效） */
  douyinFollowMode: 'browser',
  allowDm: true,
  allowPost: true,
  allowSave: true,

  /** 主人（人类）的账号；@ 和私信要用。留空时只能站内告诉主人。 */
  ownerUid: '',
  ownerName: '',
  ownerDouyin: '',

  dailyLikes: 16,
  dailyComments: 6,
  /** 私信（发给别人）：B站和抖音共用一个池子；抖音群聊不算私信，走下面 dailyGroups */
  dailyDms: 10,
  /** 抖音群聊（群里说话） */
  dailyGroups: 20,
  dailyFollows: 3,
  dailyPosts: 2,
  dailySaves: 8,
  /** 勾上=这项是「每天必须完成」的目标，而不只是上限 */
  mustLike: false,
  mustComment: false,
  mustDm: false,
  mustGroup: false,
  mustFollow: false,
  mustPost: false,
  /** 最多认几个群（名单 + 发送）；常驻监听页另算 */
  maxGroups: 6,
  /** 最多常驻几个群监听页（每个占一个后台标签页） */
  groupTabs: 3,
  /** 监听自检：页面卡死/观察器丢了自动重挂，默认开 */
  watchdog: true,
  /** 陌生人的私信：ask=先问主人 / auto=她自己回 / off=都不回（主人不受影响） */
  strangerDmMode: 'ask',
  /** 私信黑名单：昵称片段或 uid，逗号分隔 */
  strangerDmBlock: '',
  /** 字幕/弹幕带多少：后台 open 与一起看分开，数字越大越详细、token 越高 */
  subtitleOpen: 12,
  danmakuOpen: 30,
  subtitleWatch: 2,
  danmakuWatch: 6,
  watchWindowSec: 15,
  watchTalk: true,
  watchLines: 2,
  openTalk: false,
  /** 陪看浏览器：auto=Chrome 优先，也可强制 chrome/edge */
  watchBrowser: 'auto',
  watchWindow: 'maximized',
  /** 抖音「一起刷」：自动切下一条；默认关，省 token 也少招风控 */
  watchScroll: false,
  /** 0 = 这条播完就切；>0 = 停留多少秒就切 */
  watchScrollSec: 0,
  /** 刷几条才说一次（1 = 每条都说） */
  watchScrollEvery: 1,
  /** 推送时附一张当前画面（约 500 token/张） */
  watchShot: false,

  quietFrom: 23,
  quietTo: 8,
  /** 她自己出门时的动作间隔；主人当场让她做的事不走这个数（只防连点）。 */
  minGapSeconds: 20,

  /**
   * 出门方式：off=不自己出门 / sessions=按次数 / quota=按额度。
   * 以前是「次数」和「额度」两道闸门同时生效，谁先撞谁停——
   * 次数用完之后必做还没做完，就只能干等到明天。
   */
  outingMode: 'sessions',
  /** 0 = 不自己出门（等同于 outingMode=off）；按次数模式时一天出门几次。 */
  autoSessionsPerDay: 5,
  /** 两次自动出门之间至少隔多少分钟；和主人手动互动无关。 */
  autoGapMinutes: 90,
  /** 只在几点到几点自己出门。from===to 视为全天；from>to 支持跨天（22 到 6）。 */
  outingFrom: 9,
  outingTo: 23,
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
  /** 有人在评论区 @ 她时，主动叫她一声（B站，5 分钟查一次）。 */
  mentionWatch: true,
  /** 分享抖音视频的方式：image=画面+标题（稳，默认）；card=走分享面板（实验）；text=只发链接。 */
  shareStyle: 'image',
  /**
   * 多久兜底看一次私信（秒）。
   * 抖音现在走页面事件通道（新消息一进 DOM 就回调），轮询只是防掉线的兜底，
   * 所以可以设得比过去小很多：抖音那边几乎不花代价，B站是 HTTP 也就几十毫秒。
   */
  dmPollSec: 3,

  /** 书库目录；留空用数据目录下的 stroll/books。面板「选文件夹」会写这里。 */
  booksDir: '',

  /** 盯抖音群：新消息像私信一样立刻叫她。 */
  groupWatch: true,
  /**
   * 要盯的抖音群（群名，逗号分隔，最多 2 个）。**留空 = 自动盯她所在的所有群**（最多 2 个）。
   * 抖音的群没起名时，会话列表里显示的是成员名拼起来的（「A, B, C」），
   * 所以一般不用手填——留空就好。
   */
  douyinGroups: '',

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
  /** 额外允许发图的目录（绝对路径，逗号分隔）。默认空 = 只发工坊和收件箱里的图。 */
  allowedImageDirs: '',
  /** 对方只发了个表情/图片、一个字没写时，本地直接回一句，不过模型（快）。 */
  quickMediaReply: true,
  /** 给几个活跃陌生人开「常驻页」（每个 = 一个后台标签页）。0 = 不开。 */
  strangerMaxPages: 2,
};

const P = 'worlds.stroll.';

/** 基础：开关、平台、放行方式。 */
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
        description: '评论/关注/发动态/私信默认等你点头；「按额度自动」跳过确认。',
        'x-hot': true,
        'x-warning': true,
      },
    },
  },
};

/**
 * 主人：@ 谁、发私信给谁、书从哪读。
 */
const OWNER = {
  id: 'world:stroll-owner',
  owner: 'world:stroll',
  schema: {
    type: 'object',
    title: '主人',
    description: '她 @ 谁、给谁发私信、书从哪读。',
    properties: {
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
      [P + 'booksDir']: {
        type: 'string',
        title: '书库文件夹',
        description:
          '她想读的书放这儿（txt / md）。留空就用默认目录。可以直接粘路径，也可以在面板「在读」卡片点「选文件夹」用系统窗口挑。',
        'x-hot': true,
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
    title: '每日额度',
    description:
      '每天最多做多少。「必做」＝当成今天的目标：按额度出门时，勾了的要做满才收工；按次数出门时只决定先补哪个，不会额外催她出门（所以切模式不用取消勾选）。没勾的只当上限。周上限自动是日上限 × 7。',
    properties: {

      [P + 'dailyLikes']: {
        type: 'integer',
        title: '每天最多点赞',
        minimum: 0,
        maximum: 200,
        'x-suffix': ' 次',
      },
      [P + 'mustLike']: {
        type: 'boolean',
        title: '必做：点赞',
        description: '勾上后，今天要做满「每天最多点赞」的次数；按额度出门时这是收工条件之一。',
      },
      [P + 'dailyComments']: {
        type: 'integer',
        title: '每天最多评论',
        minimum: 0,
        maximum: 100,
        'x-suffix': ' 条',
      },
      [P + 'mustComment']: {
        type: 'boolean',
        title: '必做：评论',
        description: '勾上后，今天要做满「每天最多评论」的条数。审批不是 auto 时评论会进草稿，批准后才算完成。',
      },
      [P + 'dailyDms']: {
        type: 'integer',
        title: '每天最多私信',
        description:
          '发给别人的私信（陌生人、私聊对象）算这里；给主人的私信不限量，抖音群聊也不算私信。B站和抖音共用一个额度，不设上限，想填多少填多少。',
        minimum: 0,
        'x-suffix': ' 条',
      },
      [P + 'mustDm']: {
        type: 'boolean',
        title: '必做：私信',
        description:
          '勾上后，今天要发够「每天最多私信」的条数，晚上没做完会提醒你。但按额度出门不拿它当收工条件——没人给你发消息时，硬凑会变成骚扰陌生人。',
      },
      [P + 'dailyGroups']: {
        type: 'integer',
        title: '每天最多群聊',
        description: '在抖音群里说话的条数（不算私信额度）。',
        minimum: 0,
        'x-suffix': ' 条',
      },
      [P + 'mustGroup']: {
        type: 'boolean',
        title: '必做：群聊',
        description: '勾上后，今天要在群里说够「每天最多群聊」的条数。**按额度出门也不拿它当收工条件**（群里没人说话时不能硬插话）。',
      },
      [P + 'dailyFollows']: {
        type: 'integer',
        title: '每天最多关注',
        minimum: 0,
        maximum: 100,
        'x-suffix': ' 人',
      },
      [P + 'mustFollow']: {
        type: 'boolean',
        title: '必做：关注',
        description: '勾上后，今天要关注够「每天最多关注」的人数；按额度出门时这是收工条件之一。',
      },
      [P + 'dailyPosts']: {
        type: 'integer',
        title: '每天最多发动态',
        minimum: 0,
        maximum: 30,
        'x-suffix': ' 条',
      },
      [P + 'mustPost']: {
        type: 'boolean',
        title: '必做：发动态',
        description: '勾上后，今天要发够「每天最多发动态」的条数。审批不是 auto 时会进草稿，批准后才算完成。',
      },
      [P + 'dailySaves']: {
        type: 'integer',
        title: '每天最多稍后再看',
        minimum: 0,
        maximum: 100,
        'x-suffix': ' 条',
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
    title: '公开动作',
    description: '关掉的动作用不了；额度仍然生效。',
    properties: {
      [P + 'allowFollow']: {
        type: 'boolean',
        title: '可以关注别人',
        description: '每次都要按审批规则来。',
      },
      [P + 'douyinFollowMode']: {
        type: 'string',
        title: '抖音关注方式',
        description: '「关」= 她自己不点关注，你在手机 App 里关注；网页端点对部分账号不生效（刷新就没了）。点赞评论不受影响。',
        'x-options': 'stroll-douyin-follow',
      },
      [P + 'allowDm']: {
        type: 'boolean',
        title: '可以发私信',
        description:
          '关掉后私信全停（包括回陌生人）。给主人发私信不限量；回别人占「每日额度」里的私信额度。谁能给她发私信在上一组设置。',
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

/** 自己出门：方式、次数、间隔、时段、预算——她自己的节奏全在这一组。 */
const OUTING = {
  id: 'world:stroll-outing',
  owner: 'world:stroll',
  schema: {
    type: 'object',
    title: '自己出门',
    description:
      '她什么时候出去、一天出去几次、被什么挡住。按次数＝出去几次就收工；按额度＝把勾了必做的项做满才收工。',
    properties: {
      [P + 'outingMode']: {
        type: 'string',
        title: '出门方式',
        'x-options': 'stroll-outing-mode',
        description:
          '按次数：每天出去几次就收工，额度只当单个动作的上限。' +
          '按额度：出去几次不限，把勾了必做的项做满才收工（一个都没勾时按全部主动额度算）；' +
          '私信/群聊不算，没人找你时这两项永远做不满。没勾必做的额度只当上限，不会逼她做。',
        'x-hot': true,
      },
      [P + 'autoSessionsPerDay']: {
        type: 'integer',
        title: '每天自己出门',
        description: '只在「出门方式＝按次数」时生效；0＝不自己出门。',
        minimum: 0,
        maximum: 10,
        'x-suffix': ' 次/天',
        'x-hot': true,
      },
      [P + 'autoGapMinutes']: {
        type: 'integer',
        title: '两次出门至少隔',
        description: '太密容易撞风控；90 分钟≈一天 5 次。按额度模式也按这个间隔走。',
        minimum: 30,
        maximum: 360,
        'x-suffix': ' 分钟',
        'x-hot': true,
      },
      [P + 'outingFrom']: {
        type: 'integer',
        title: '出门时段：从几点',
        description: '只在这个时间段自己出门。想只走谷时可以填 1 到 6。',
        minimum: 0,
        maximum: 23,
        'x-suffix': ' 点',
        'x-hot': true,
      },
      [P + 'outingTo']: {
        type: 'integer',
        title: '出门时段：到几点',
        description: '填 24 表示到当天结束。和上面填一样的值＝全天都能出门；跨天也行，比如 22 到 6。',
        minimum: 0,
        maximum: 24,
        'x-suffix': ' 点',
        'x-hot': true,
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
        description: '看完就回来，不无限刷。',
        minimum: 3,
        maximum: 12,
        'x-suffix': ' 条',
      },
      [P + 'tokenDailyBudget']: {
        type: 'integer',
        title: '每天模型预算',
        description: '按每出门一次约 1500 token 折算成「今天最多还能出门几次」，两种出门方式都受它限制。',
        minimum: 1000,
        maximum: 50000,
        'x-suffix': ' token',
      },
    },
  },
};

/** 高级：兴趣、评论、风控、图片目录。 */
const ADVANCED = {
  id: 'world:stroll-advanced',
  owner: 'world:stroll',
  schema: {
    type: 'object',
    title: '高级',
    description: '一般不用改。改错最多多花点 token 或多等一会儿。',
    properties: {

      [P + 'commentMaxChars']: {
        type: 'integer',
        title: '评论最多几个字',
        description: '20-300，短一点更像人。',
        minimum: 20,
        maximum: 300,
        'x-suffix': ' 字',
      },
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
      [P + 'newAccountRamp']: {
        type: 'boolean',
        title: '新号保护',
        description: '前 3 天额度打五折，4–7 天八折，之后恢复。老号可以关掉。',
      },
      [P + 'riskGuard']: {
        type: 'string',
        title: '风控拦截力度',
        description: 'off 只记不拦（推荐）；light 验证码时停 30 分钟；strict 长冷却。',
        'x-options': 'stroll-risk-guard',
      },
      [P + 'riskPauseHours']: {
        type: 'integer',
        title: '严格模式停多久',
        description: '只在「风控拦截力度＝严格」时生效。',
        minimum: 1,
        maximum: 168,
        'x-suffix': ' 小时',
      },
      [P + 'allowedImageDirs']: {
        type: 'string',
        title: '额外允许发图的目录',
        description:
          '默认空：她只能发「图片工坊」和「收到的图」这两个目录里的图片（jpg/png/webp/gif，单张 ≤8MB）。' +
          '确实要让她发别的目录（比如你自己存的图），填绝对路径，多个用逗号分隔。' +
          '填了就代表这个目录里的图她都可能发出去，别填桌面/文档这种混着私人文件的目录。',
      },

    },
  },
};

/** 私信：主人发来就接住，不用等她下次出门。 */
const VIEWING = {
  id: 'world:stroll-viewing',
  owner: 'world:stroll',
  schema: {
    type: 'object',
    title: '看视频',
    description: 'B站视频的字幕和弹幕带多少条。数字越大越详细，token 和延迟也越高；填 0 就是不看不带。',
    properties: {
      [P + 'subtitleOpen']: {
        type: 'integer',
        title: '后台看：带几句字幕',
        description:
          'open 时返回的字幕句数。按时间分段抽样，从开头一路覆盖到结尾（不是只取开头几句）；' +
          '想知道某一段可以让她带 at=分:秒 再读。没有 CC 字幕的视频这里设多少都是空。',
        minimum: 0,
        maximum: 60,
        'x-suffix': ' 句',
      },
      [P + 'danmakuOpen']: {
        type: 'integer',
        title: '后台看：带几条弹幕',
        description: '按时间均匀抽样后返回的弹幕条数。',
        minimum: 0,
        maximum: 60,
        'x-suffix': ' 条',
      },
      [P + 'framesPerOpen']: {
        type: 'integer',
        title: '看视频抽几帧',
        description:
          'B站用进度条缩略图（160×90，不用登录、不开播放页，只看得出画面大概在干嘛）；' +
          '抖音用播放页截图。0 最省；1 帧约 500 token。',
        minimum: 0,
        maximum: 3,
        'x-suffix': ' 帧',
      },
      [P + 'keepWindowSeconds']: {
        type: 'integer',
        title: '打开后窗口留多久',
        description: '只对开窗模式有效。',
        minimum: 0,
        maximum: 600,
        'x-suffix': ' 秒',
      },
      [P + 'openTalk']: {
        type: 'boolean',
        title: '后台看完也说一句',
        description: '不在一起看、她自己刷到一条时，要不要主动跟你聊一句。会多花一点 token。',
      },

    },
  },
};

/**
 * 一起看：多久说一次、说几句、带多少字幕弹幕。
 */
const WATCH = {
  id: 'world:stroll-watch',
  owner: 'world:stroll',
  schema: {
    type: 'object',
    title: '一起看',
    description: '一起看时多久说一次、说几句、带多少字幕弹幕。',
    properties: {

      [P + 'watchTalk']: {
        type: 'boolean',
        title: '一起看时主动说几句',
        description: '开着时，播报会提醒她说 1-2 句观后感，不是只报进度。',
        'x-hot': true,
      },
      [P + 'watchLines']: {
        type: 'integer',
        title: '一次说几句',
        description: '配合上一条，控制每次说多少。',
        minimum: 1,
        maximum: 3,
        'x-suffix': ' 句',
      },
      [P + 'watchSpeakSec']: {
        type: 'integer',
        title: '一起看：多久说一句',
        description: '太短会吵。',
        minimum: 20,
        maximum: 600,
        'x-suffix': ' 秒',
      },
      [P + 'subtitleWatch']: {
        type: 'integer',
        title: '一起看：带几句字幕',
        description: '按当前播放进度取的字幕句数（通常 1-2 句就够）。',
        minimum: 0,
        maximum: 5,
        'x-suffix': ' 句',
      },
      [P + 'danmakuWatch']: {
        type: 'integer',
        title: '一起看：带几条弹幕',
        description: '当前进度前后窗口内取几条弹幕。',
        minimum: 0,
        maximum: 20,
        'x-suffix': ' 条',
      },
      [P + 'watchWindowSec']: {
        type: 'integer',
        title: '一起看：弹幕窗口多大',
        description: '以当前播放秒数为中心，前后各取多少秒的弹幕。',
        minimum: 5,
        maximum: 120,
        'x-suffix': ' 秒',
      },
      [P + 'watchPollSec']: {
        type: 'integer',
        title: '一起看：多久读一次',
        description: '读标题/进度/评论，不花 token。',
        minimum: 5,
        maximum: 120,
        'x-suffix': ' 秒',
      },
      [P + 'watchNotify']: {
        type: 'string',
        title: '她开始看时提醒我',
        'x-options': 'stroll-notify',
        description: '面板上永远有「正在看」浮条；选「对话里也说一句」会多花一点 token。',
        'x-hot': true,
      },
      [P + 'watchWindow']: {        type: 'string',
        title: '陪看窗口多大',
        description: '最大化够用；全屏会隐藏标题栏，按 F11 退出。',
        'x-options': 'stroll-watch-window',
      },
      [P + 'watchBrowser']: {
        type: 'string',
        title: '陪看用哪个浏览器',
        description: '默认 Chrome 优先；没装会自动退回 Edge/自带 Chromium。',
        'x-options': 'stroll-watch-browser',
      },

    },
  },
};

/**
 * 抖音一起刷：只在「一起看」抖音时生效，和 B站 无关。
 */
const SHORTS = {
  id: 'world:stroll-shorts',
  owner: 'world:stroll',
  schema: {
    type: 'object',
    title: '抖音一起刷',
    description: '陪主人刷抖音：多久切一条、隔几条说一句、要不要附画面。',
    properties: {
      [P + 'watchScroll']: {
        type: 'boolean',
        title: '抖音一起刷',
        description: '开着时，陪看窗口会自动切到下一条抖音视频（只对抖音生效，B站不受影响）。',
        'x-hot': true,
      },
      [P + 'watchScrollSec']: {
        type: 'integer',
        title: '一起刷：多久切一条',
        description: '0 = 这条播完就切；填 30 就是每条停 30 秒。',
        minimum: 0,
        maximum: 180,
        'x-suffix': ' 秒',
      },
      [P + 'watchScrollEvery']: {
        type: 'integer',
        title: '一起刷：隔几条说一句',
        description: '1 = 每条都说话；3 = 刷三条才说一次，省 token。',
        minimum: 1,
        maximum: 10,
        'x-suffix': ' 条',
      },
      [P + 'watchShot']: {
        type: 'boolean',
        title: '一起刷：附一张画面',
        description: '抖音没字幕，附截图她才看得见画面。每张约 500 token，默认关。',
      },
    },
  },
};

const MESSAGES = {
  id: 'world:stroll-messages',
  owner: 'world:stroll',
  schema: {
    type: 'object',
    title: '私信与群',
    description: '抖音私信和群消息，主人一发就接住。',
    properties: {
      [P + 'dmWatch']: {
        type: 'boolean',
        title: '私信马上回',
        description:
          '开着时每隔一会儿看一眼你和她的私信，你一发就推给她回，不用等她下次出门。关掉就只能等她主动去查。',
        'x-hot': true,
      },
      [P + 'mentionWatch']: {
        type: 'boolean',
        title: '有人 @ 我就叫我',
        description:
          'B站评论区里有人 @ 她时，主动把她叫起来看一眼（90 秒查一次，安静时段不查）。' +
          '关掉的话，只有她出门逛、或你让她查消息时才看得到。回复仍是公开评论，按「审批」来。',
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
      [P + 'shareStyle']: {
        type: 'string',
        title: '分享视频怎么发',
        description:
          '她给主人发抖音视频时的样子。' +
          '「画面 + 标题」：先发一张视频画面，再发标题和链接（推荐）。' +
          '「只发链接」：就是一段纯文字链接。' +
          '注：抖音网页版没有「分享到私信」的入口（实测那个按钮是隐藏占位），所以发不了原生分享卡。',
        'x-options': 'stroll-share-style',
        'x-hot': true,
      },
      [P + 'strangerDmMode']: {
        type: 'string',
        title: '陌生人的私信',
        description:
          '「先问我」会把私信转给你、你点头她才回；「她自己回」按人设直接回；「都不回」当没看见。回陌生人占「每天最多私信」的额度，主人不受影响。',
        'x-options': 'stroll-stranger-dm',
        'x-hot': true,
      },
      [P + 'quickMediaReply']: {
        type: 'boolean',
        title: '本地秒回',
        description:
          '对方只发了个表情/图片，或者只说了句「在吗 / 你好 / hi」这类开场白时，不叫模型，' +
          '直接从几句短话里挑一句回过去（0.3-0.6 秒，走模型要 2-5 秒）。' +
          '只在「她自己回」模式下生效，同一个人 3 分钟最多秒回一次；有内容的话一律交给她自己想。' +
          '对方发的是表情时，回的是真的表情字符（😄 这种），不是「（笑）」这种文字描述。',
      },
      [P + 'strangerMaxPages']: {
        type: 'integer',
        title: '陌生人常驻页数量',
        description:
          '给最近聊过的几个陌生人各开一个后台页，页面停在他的会话上——读表情/图片、发消息都跟主人私信一样快' +
          '（发送 200ms 级）。每个页约 50-100MB 内存，默认 2，最多 4；填 0 = 不开（省内存，但表情包/图片可能读不到）。',
        minimum: 0,
        maximum: 4,
        'x-suffix': ' 个',
      },
      [P + 'strangerDmBlock']: {
        type: 'string',
        title: '私信黑名单',
        description: '这些人发的私信一律不理。填昵称片段或 UID，多个用逗号隔开。',
      },
      [P + 'groupWatch']: {
        type: 'boolean',
        title: '盯着抖音群',
        description: '群里有人说话就叫她一声。她的号没进任何群时这一项没有影响。',
        'x-hot': true,
      },
      [P + 'douyinGroups']: {
        type: 'string',
        title: '要盯的抖音群（可留空）',
        description:
          '留空就自动盯她所在的群——推荐留空。只有想指定某几个群时才填：填群名，和抖音聊天列表里显示的一字不差，多个用逗号隔开。',
      },
      [P + 'maxGroups']: {
        type: 'integer',
        title: '最多认几个群',
        description: '名单最多保留几个群；决定「能不能给第 N 个群发消息」。',
        minimum: 1,
        maximum: 10,
        'x-suffix': ' 个',
        'x-hot': true,
      },
      [P + 'groupTabs']: {
        type: 'integer',
        title: '最多常驻几个群监听页',
        description:
          '每个常驻群会开一个后台标签页（约 100-150MB 内存）。超过这个数的群仍然能发消息，但发的时候才临时点进去，不会一直挂着。',
        minimum: 1,
        maximum: 8,
        'x-suffix': ' 个',
        'x-hot': true,
      },
      [P + 'watchdog']: {
        type: 'boolean',
        title: '监听自检',
        description:
          '每分钟检查一次私信/群的监听页：观察器被页面导航带走了就原地重挂，页面卡死就重开。关掉可能漏消息。',
        'x-hot': true,
      },
    },
  },
};

/**
 * 设置页的顺序（从「最常改」到「一般不动」）：
 *   基础 → 主人 → 公开动作（她能做什么）→ 每日额度（做多少 / 哪些必做）
 *   → 自己出门（怎么出去）→ 私信与群 → 看视频 → 一起看 → 抖音一起刷 → 高级
 */
export const CONFIG_GROUPS = [BASIC, OWNER, INTERACT, QUOTA, OUTING, MESSAGES, VIEWING, WATCH, SHORTS, ADVANCED];

/** 旧引用兼容：第一组即基础组。 */

/** 可经 stroll_policy 修改的字段及边界。 */
export const POLICY_FIELDS = {
  approval: { type: 'enum', values: ['confirm', 'auto_low_risk', 'auto_all', 'dry_run'] },
  ownerUid: { type: 'string', max: 20 },
  ownerName: { type: 'string', max: 40 },
  ownerDouyin: { type: 'string', max: 500 },
  bilibili: { type: 'boolean' },
  douyin: { type: 'boolean' },
  allowFollow: { type: 'boolean' },
  douyinFollowMode: { type: 'enum', values: ['browser', 'off'] },
  allowDm: { type: 'boolean' },
  allowPost: { type: 'boolean' },
  allowSave: { type: 'boolean' },
  dailyLikes: { type: 'int', min: 0, max: 200 },
  dailyComments: { type: 'int', min: 0, max: 100 },
  dailyDms: { type: 'int', min: 0, max: 9999 },
  dailyGroups: { type: 'int', min: 0, max: 9999 },
  dailyFollows: { type: 'int', min: 0, max: 100 },
  dailyPosts: { type: 'int', min: 0, max: 30 },
  dailySaves: { type: 'int', min: 0, max: 100 },
  mustLike: { type: 'boolean' },
  mustComment: { type: 'boolean' },
  mustDm: { type: 'boolean' },
  mustGroup: { type: 'boolean' },
  mustFollow: { type: 'boolean' },
  mustPost: { type: 'boolean' },
  maxGroups: { type: 'int', min: 1, max: 10 },
  groupTabs: { type: 'int', min: 1, max: 8 },
  watchdog: { type: 'boolean' },
  strangerDmMode: { type: 'enum', values: ['ask', 'auto', 'off'] },
  strangerDmBlock: { type: 'string', max: 500 },
  subtitleOpen: { type: 'int', min: 0, max: 60 },
  danmakuOpen: { type: 'int', min: 0, max: 60 },
  subtitleWatch: { type: 'int', min: 0, max: 5 },
  danmakuWatch: { type: 'int', min: 0, max: 20 },
  watchWindowSec: { type: 'int', min: 5, max: 120 },
  watchTalk: { type: 'boolean' },
  watchLines: { type: 'int', min: 1, max: 3 },
  openTalk: { type: 'boolean' },
  watchBrowser: { type: 'enum', values: ['auto', 'chrome', 'edge'] },
  watchWindow: { type: 'enum', values: ['maximized', 'fullscreen', 'normal'] },
  watchScroll: { type: 'boolean' },
  watchScrollSec: { type: 'int', min: 0, max: 180 },
  watchScrollEvery: { type: 'int', min: 1, max: 10 },
  watchShot: { type: 'boolean' },
  quietFrom: { type: 'int', min: 0, max: 23 },
  quietTo: { type: 'int', min: 0, max: 23 },
  minGapSeconds: { type: 'int', min: 10, max: 600 },
  riskGuard: { type: 'enum', values: ['off', 'light', 'strict'] },
  autoSessionsPerDay: { type: 'int', min: 0, max: 10 },
  outingMode: { type: 'enum', values: ['off', 'sessions', 'quota'] },
  autoGapMinutes: { type: 'int', min: 30, max: 360 },
  outingFrom: { type: 'int', min: 0, max: 23 },
  outingTo: { type: 'int', min: 0, max: 24 },
  sessionMaxItems: { type: 'int', min: 3, max: 12 },
  interests: { type: 'string', max: 300 },
  avoid: { type: 'string', max: 300 },
  framesPerOpen: { type: 'int', min: 0, max: 3 },
  keepWindowSeconds: { type: 'int', min: 0, max: 600 },
  background: { type: 'boolean' },
  watchSpeakSec: { type: 'int', min: 20, max: 600 },
  watchPollSec: { type: 'int', min: 5, max: 120 },
  dmWatch: { type: 'boolean' },
  mentionWatch: { type: 'boolean' },
  shareStyle: { type: 'enum', values: ['image', 'text'] },
  dmPollSec: { type: 'int', min: 3, max: 300 },
  booksDir: { type: 'string', max: 400 },
  groupWatch: { type: 'boolean' },
  douyinGroups: { type: 'string', max: 200 },
  tokenDailyBudget: { type: 'int', min: 1000, max: 50000 },
  commentMaxChars: { type: 'int', min: 20, max: 300 },
  riskPauseHours: { type: 'int', min: 1, max: 168 },
  allowedImageDirs: { type: 'string', max: 600 },
  quickMediaReply: { type: 'boolean' },
  strangerMaxPages: { type: 'int', min: 0, max: 4 },
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
