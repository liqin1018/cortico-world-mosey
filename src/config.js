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
  douyinCommentVia: 'manual',
  douyinFollowMode: 'browser',
  allowDm: true,
  allowPost: true,
  allowSave: true,
  /** 动态：发哪种、配图从哪来、要不要自动发 */
  postKind: 'text',
  postImageFrom: 'generate',
  postImageDir: '',
  postImageStyle: '',
  /** 生成的图存到哪；留空用 data/stroll/media */
  postImageSaveDir: '',
  postImageApiBase: '',
  postImageApiKey: '',
  postImageModel: '',

  /** 主人（人类）的账号；@ 和私信要用。留空时只能站内告诉主人。 */
  ownerUid: '',
  ownerName: '',
  ownerDouyin: '',

  dailyLikes: 10,
  dailyComments: 4,
  /** 私信（发给别人）：B站和抖音共用一个池子；抖音群聊不算私信，走下面 dailyGroups */
  dailyDms: 10,
  /** 抖音群聊（群里说话） */
  dailyGroups: 20,
  dailyFollows: 2,
  dailyPosts: 1,
  /** 抖音动态单独一个额度，和 B站 分开算 */
  dailyPostsDouyin: 1,
  dailySaves: 5,
  /** 每天最多看几次（brief/feed/open 这类只读调用，不管谁叫都算） */
  browseDailyCap: 60,
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
  debugLog: false,
  watchdog: true,
  /** 陌生人的私信：ask=先问主人 / auto=她自己回 / off=都不回（主人不受影响） */
  strangerDmMode: 'ask',
  /** 私信黑名单：昵称片段或 uid，逗号分隔 */
  strangerDmBlock: '',
  /** 字幕/弹幕带多少：后台 open 与一起看分开，数字越大越详细、token 越高 */
  // 字幕这个数是「20 分钟的片子带多少句」，实际句数按时长算，短片会自动加密（上限 72）
  subtitleOpen: 48,
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
  autoOuting: true,
  autoSessionsPerDay: 3,
  /** 两次自动出门之间至少隔多少分钟；和主人手动互动无关。 */
  autoGapMinutes: 150,
  /** 只在几点到几点自己出门。from===to 视为全天；from>to 支持跨天（22 到 6）。 */
  outingFrom: 9,
  outingTo: 23,
  sessionMaxItems: 8,

  /** 兴趣词，逗号分隔；本地打分用，不额外调模型。 */
  interests: '',
  avoid: '',

  /** 打开视频时抽几帧。0 = 不抽，最省 token。 */
  // 抽帧默认开着：B站 9 帧拼成一张分镜图只要约 184 token，比 3 张独立小图还便宜
  framesPerOpen: 9,
  openMode: 'both',
  douyinPostMode: 'draft',
  hostileReply: 'cold',
  shareWithOwner: true,
  shareWithOwnerPerDay: 1,
  dailyCommentsDouyin: 2,
  commentGapBili: 2,
  commentGapDouyin: 8,
  commentBlockedDm: true,
  mentionOwnerOnComment: false,
  shareWindowIdleSec: 0,
  creatorAutoProbe: true,
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
  /** 有人在评论区 @ 她时，主动叫她一声（B站/抖音，90 秒查一次）。 */
  mentionWatch: true,
  /** 分享抖音视频的方式：image=画面+标题（稳，默认）；card=走分享面板（实验）；text=只发链接。 */
  shareStyle: 'card',
  /**
   * 多久兜底看一次私信（秒）。
   * 抖音现在走页面事件通道（新消息一进 DOM 就回调），轮询只是防掉线的兜底，
   * 所以可以设得比过去小很多：抖音那边几乎不花代价，B站是 HTTP 也就几十毫秒。
   */
  dmPollSec: 3,

  /** 书库目录；留空用数据目录下的 stroll/books。面板「选文件夹」会写这里。 */
  booksDir: '',

  /**
   * 表情包的**图片**目录；留空用数据目录下的 stroll/stickers。
   * 指到别的插件的图库（比如 QQ 的 data/stickers）就能共用一份：
   * 摸鱼照旧只在自己的 stroll/stickers/index.json 里记名字和标签，图片本身放这里。
   */
  stickerDir: '',

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
  tokenDailyBudget: 6000,
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
        description: '总开关。关掉后不刷不看也不发，记录和设置都留着。',
        'x-hot': true,
      },
      [P + 'bilibili']: {
        type: 'boolean',
        title: '去 B站',
        description: '要不要去 B站。只读不用登录，点赞评论才需要登录态。',
      },
      [P + 'douyin']: {
        type: 'boolean',
        title: '去抖音',
        description: '要不要去抖音。用独立浏览器资料，第一次要在面板扫码登录。',
      },
      [P + 'background']: {
        type: 'boolean',
        title: '后台逛（不弹网页）',
        description: '默认开后：全在后台读。只有扫码登录、一起看、发抖音图文会开窗，用完自己关。',
        'x-hot': true,
      },
      [P + 'approval']: {
        type: 'string',
        title: '公开动作怎么放行',
        description: '评论/关注/发动态/私信要不要先问你。默认逐条确认。',
        'x-options': 'stroll-approval',
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
        description: '你的 B站 UID。填了才能在评论里真 @ 你、给你发私信。',
        'x-hot': true,
      },
      [P + 'ownerName']: {
        type: 'string',
        title: '主人 B站昵称',
        description: '你的 B站昵称。填了 UID 会自动查，查不到才用这里。',
      },
      [P + 'ownerDouyin']: {
        type: 'string',
        title: '主人抖音（主页链接 / sec_uid / 抖音号）',
        description: '粘主页分享链接最稳（App → 我 → 分享 → 复制）。纯抖音号解析不了。',
      },
      [P + 'booksDir']: {
        type: 'string',
        title: '书库文件夹',
        description: '她想读的书放这（txt/md）。留空用默认目录。',
        'x-hot': true,
      },
      [P + 'stickerDir']: {
        type: 'string',
        title: '表情包文件夹',
        description:
          '表情包的图片放这。留空用默认目录；填成 QQ 那边的 data\\stickers，两边就共用一份图库（名字和标签仍记在摸鱼自己的索引里）。',
        'x-hot': true,
      },
    },
  },
};

/** 额度与节奏：每天能做什么、什么时候安静。 */
/**
 * 动态：发 B站动态的内容形态、配图来源、自动发。
 */
const POSTING = {
  id: 'world:stroll-post',
  owner: 'world:stroll',
  schema: {
    type: 'object',
    title: '动态',
    description: '发 B站动态：发什么、配什么图、什么时候发。',
    properties: {
      [P + 'postKind']: {
        type: 'string',
        title: '发哪种动态',
        description: '纯文字 / 纯图片 / 图文，B站和抖音都按这个发。选后两种要先配好「配图从哪来」。',
        'x-options': 'stroll-post-kind',
        'x-hot': true,
      },
      [P + 'shareWindowIdleSec']: {
        type: 'number',
        title: '分享窗口空闲多久关（秒）',
        description: '抖音分享卡片的窗口空闲多久关。默认 0 = 用完立刻关。',
        minimum: 0,
        maximum: 3600,
      },
      [P + 'douyinPostMode']: {
        type: 'string',
        title: '抖音图文怎么发',
        description: '默认「写好暂存你点发布」。号养熟了可以换「她自己发」（开屏幕外窗口，验证码你看不到）。',
        'x-options': 'stroll-douyin-post-mode',
        'x-hot': true,
      },
      [P + 'postImageFrom']: {
        type: 'string',
        title: '配图从哪来',
        description: '配图只能从这里取：不跨目录、也不会自己现画。想现画先让她画好再发。',
        'x-options': 'stroll-post-image-from',
      },
      [P + 'postImageDir']: {
        type: 'string',
        title: '本地图片目录',
        description: '选「本地目录」时生效。会自动往下找两层，挑最新的一张。',
      },
      [P + 'postImageStyle']: {
        type: 'string',
        title: '出图风格',
        description: '出图风格，拼进提示词。比如「胶片颗粒」「阴天冷色调」。',
      },
      [P + 'postImageSaveDir']: {
        type: 'string',
        title: '生成的图存到哪',
        description: '生成的图存在哪。留空存插件目录。注意这是「存」，上面那个是「读」。',
      },
      [P + 'postImageApiBase']: {
        type: 'string',
        title: '出图接口地址',
        description: 'OpenAI 兼容的接口地址，比如 https://api.openai.com/v1。',
      },
      [P + 'postImageApiKey']: {
        type: 'string',
        title: '出图密钥',
        description: '出图密钥。只存本地。填过就留空，要换才重新粘贴。',
      },
      [P + 'postImageModel']: {
        type: 'string',
        title: '出图模型',
        description: '出图模型，比如 gpt-image-1、flux-schnell、seedream-3。',
      },
    },
  },
};

const QUOTA = {
  id: 'world:stroll-quota',
  owner: 'world:stroll',
  schema: {
    type: 'object',
    title: '每日额度',
    // F：6 个「必做：xxx」就挂在这一组每项额度下面（勾上 = 今天必须做够，不是上限）。
    // 宿主没有子分组能力，用 description 把这件事说清楚，比把 6 项拆出去更省事。
    description:
      '每一档额度下面的「必做：xxx」勾上之后，那一项就变成今天的**硬目标**（要做够，不是上限）：' +
      '按额度模式会一直出门做到满，按次数模式至少把它排在最前面。' +
      '**都不勾**就只看额度：做多少算多少，晚上不会额外催你。',
    description:
      '每天最多做多少。「必做」＝当成今天的目标：按额度出门时，勾了的要做满才收工；按次数出门时只决定先补哪个，不会额外催她出门（所以切模式不用取消勾选）。没勾的只当上限。周上限自动是日上限 × 7。',
    properties: {

      [P + 'dailyLikes']: {
        type: 'integer',
        title: '每天最多点赞',
        description: '一天最多赞几个（B站+抖音合计）。默认 10；新号建议 3~5。',
        minimum: 0,
        maximum: 200,
        'x-suffix': ' 次',
      },
      [P + 'mustLike']: {
        type: 'boolean',
        title: '必做：点赞',
        description: '勾上 = 今天必须赞满上面的数，没做够不算收工。',
      },
      [P + 'dailyComments']: {
        type: 'integer',
        title: '每天最多 B站评论',
        description: '一天最多几条 B站评论（不含回复）。默认 4。',
        minimum: 0,
        maximum: 100,
        'x-suffix': ' 条',
      },
      [P + 'dailyCommentsDouyin']: {
        type: 'integer',
        minimum: 0,
        maximum: 100,
        title: '每天最多抖音评论',
        description: '一天最多几条抖音评论。默认 2——抖音连着发就判机器。',
        'x-suffix': ' 条',
        'x-hot': true,
      },
      [P + 'commentGapBili']: {
        type: 'integer',
        minimum: 0,
        maximum: 120,
        title: 'B站：两条评论之间至少隔几分钟',
        description: 'B站两条评论至少隔几分钟。默认 2，B站基本不怕压。',
        'x-suffix': ' 分钟',
      },
      [P + 'commentGapDouyin']: {
        type: 'integer',
        minimum: 0,
        maximum: 120,
        title: '抖音：两条评论之间至少隔几分钟',
        description: '抖音两条评论至少隔几分钟。默认 8。被压了先把这个调到 15。',
        'x-suffix': ' 分钟',
        'x-hot': true,
      },
      [P + 'mustComment']: {
        type: 'boolean',
        title: '必做：评论',
        description: '勾上 = 今天必须评论满上面的数。审批非全自动时会先停在草稿箱。',
      },
      [P + 'dailyDms']: {
        type: 'integer',
        title: '每天最多私信',
        description: '一天最多给别人的私信（B站+抖音合计）。给主人发不限量。',
        minimum: 0,
        'x-suffix': ' 条',
      },
      [P + 'mustDm']: {
        type: 'boolean',
        title: '必做：私信',
        description: '勾上 = 今天要发够私信数。没人找她时不会硬凑陌生人。',
      },
      [P + 'dailyGroups']: {
        type: 'integer',
        title: '每天最多群聊',
        description: '一天最多在抖音群里说几条。默认 20。',
        minimum: 0,
        'x-suffix': ' 条',
      },
      [P + 'mustGroup']: {
        type: 'boolean',
        title: '必做：群聊',
        description: '勾上 = 今天要发够群聊数。但不会硬插话，没做够只提醒你。',
      },
      [P + 'dailyFollows']: {
        type: 'integer',
        title: '每天最多关注',
        description: '一天最多关注几个人。默认 2，别调大——连续关注最招风控。',
        minimum: 0,
        maximum: 100,
        'x-suffix': ' 人',
      },
      [P + 'mustFollow']: {
        type: 'boolean',
        title: '必做：关注',
        description: '勾上 = 今天必须关注满上面的数。额度填高很危险。',
      },
      [P + 'dailyPosts']: {
        type: 'integer',
        title: '每天最多发几条 B站动态',
        description: '一天最多发几条 B站动态。默认 1。',
        minimum: 0,
        maximum: 30,
        'x-suffix': ' 条',
      },
      [P + 'dailyPostsDouyin']: {
        type: 'integer',
        title: '每天最多发几条抖音动态',
        description: '一天最多发几条抖音动态，和 B站分开算。默认 1。',
        minimum: 0,
        maximum: 30,
        'x-suffix': ' 条',
      },
      [P + 'mustPost']: {
        type: 'boolean',
        title: '必做：发动态',
        description: '勾上 = 今天要发够 B站+抖音合计那么多条。这就是「自动发」。',
      },
      [P + 'browseDailyCap']: {
        type: 'integer',
        title: '每天最多看几次',
        description: '一天最多看几条内容（含一起刷）。0 = 不限。',
        minimum: 0,
        maximum: 500,
        'x-suffix': ' 次',
      },
      [P + 'dailySaves']: {
        type: 'integer',
        title: '每天最多稍后再看',
        description: '一天最多加几条稍后再看。纯收藏，不公开，调大没风险。',
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
      [P + 'shareWithOwner']: {
        type: 'boolean',
        title: '看到好东西会跟你提一句',
        description: '刷到你可能会喜欢的（你关注过的作者）会提一句。一天最多一次。',
        'x-hot': true,
      },
      [P + 'shareWithOwnerPerDay']: {
        // 宿主按 JSON Schema 渲染：必须是 integer + minimum/maximum，
        // 写成 int/min/max 不会报错，但面板上不给输入框（2026-11-17 用户反馈「填不了」）
        type: 'integer',
        minimum: 0,
        maximum: 5,
        title: '每天最多主动提几次',
        description: '一天最多主动提几次。0 和 1 最舒服，2 以上会烦。',
        'x-suffix': ' 次',
      },
      [P + 'commentBlockedDm']: {
        type: 'boolean',
        title: '评论被压时私信告我',
        description: '@ 你的评论被抖音压住时，私信告你内容。每条被压都发，嫌吵可关。',
        'x-hot': true,
      },
      [P + 'mentionOwnerOnComment']: {
        type: 'boolean',
        title: '评论时 @ 主人',
        description: '她发新评论时要不要 @ 你。B站会真发通知；楼中楼不生效。',
        'x-hot': true,
      },
      [P + 'hostileReply']: {
        type: 'string',
        title: '有人挑衅时怎么回',
        description: '有人阴阳怪气时怎么接：冷处理 / 无视 / 犀利。都不会骂人。',
        'x-options': 'stroll-hostile-reply',
        'x-hot': true,
      },
      [P + 'allowFollow']: {
        type: 'boolean',
        title: '可以关注别人',
        description: '她能不能自己关注别人。关掉就你在 App 里点。',
      },
      [P + 'douyinCommentVia']: {
        type: 'string',
        title: '抖音评论怎么发',
        description: '默认「打字」（慢 5~10 秒但不容易被压）。「接口」快，但容易被判只有自己可见。',
        'x-options': 'stroll-comment-via',
        default: 'manual',
        'x-hot': true,
      },
      [P + 'douyinFollowMode']: {
        type: 'string',
        title: '抖音关注方式',
        description: '网页点对部分账号不生效（刷新就没）。点不上就切「关」，你在 App 里点。',
        'x-options': 'stroll-douyin-follow',
      },
      [P + 'allowDm']: {
        type: 'boolean',
        title: '可以发私信',
        description: '能不能主动给别人发私信。关掉后连回陌生人也停；给主人发不受影响。',
      },
      [P + 'allowPost']: {
        type: 'boolean',
        title: '可以发 B站动态',
        description: '会不会发动态。发什么由「发哪种动态」决定，可以文字也可以带图。',
      },
      [P + 'allowSave']: {
        type: 'boolean',
        title: '可以加稍后再看',
        description: '能不能加稍后再看。相当于帮你收藏一条视频。',
      },
      [P + 'sharedBiliCookie']: {
        type: 'boolean',
        title: '复用应用的 B站登录',
        description: '复用应用里的 B站登录。关掉后只能读公开内容，写动作不行。',
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
      [P + 'autoOuting']: {
        type: 'boolean',
        title: '自动出门',
        description: '关掉就完全不自己出门，连催促都不发。手动让她看东西不受影响。',
        'x-hot': true,
      },
      [P + 'outingMode']: {
        type: 'string',
        title: '出门方式',
        description: '按次数 = 出去 N 次就停；按额度 = 把必做做满才停。私信群聊不算必做。',
        'x-options': 'stroll-outing-mode',
        'x-hot': true,
      },
      [P + 'autoSessionsPerDay']: {
        type: 'integer',
        title: '每天自己出门',
        description: '一天自己出去几次（只在按次数模式生效）。0 = 不自己出门。',
        minimum: 0,
        maximum: 10,
        'x-suffix': ' 次/天',
        'x-hot': true,
      },
      [P + 'autoGapMinutes']: {
        type: 'integer',
        title: '两次出门至少隔',
        description: '两次出门至少隔多久。默认 150 分钟。活跃度档位会自动改它。',
        minimum: 30,
        maximum: 360,
        'x-suffix': ' 分钟',
        'x-hot': true,
      },
      [P + 'outingFrom']: {
        type: 'integer',
        title: '出门时段：从几点',
        description: '只在「从几点到几点」之间自己出门。想走谷时可填 1~6。',
        minimum: 0,
        maximum: 23,
        'x-suffix': ' 点',
        'x-hot': true,
      },
      [P + 'outingTo']: {
        type: 'integer',
        title: '出门时段：到几点',
        description: '出门时段结束。填 24 = 到当天结束。填 22~6 就是只在夜里。',
        minimum: 0,
        maximum: 24,
        'x-suffix': ' 点',
        'x-hot': true,
      },
      [P + 'quietFrom']: {
        type: 'integer',
        title: '安静时段开始',
        description: '安静时段开始：不自己出门、也不主动说话。默认 23 点。',
        minimum: 0,
        maximum: 23,
        'x-suffix': ' 点',
      },
      [P + 'quietTo']: {
        type: 'integer',
        title: '安静时段结束',
        description: '安静时段结束，默认 7 点。和上面填一样 = 没有安静时段。',
        minimum: 0,
        maximum: 23,
        'x-suffix': ' 点',
      },
      [P + 'minGapSeconds']: {
        type: 'integer',
        title: '她自己多久能动一次',
        description: '她自己逛时两次动作至少隔几秒。默认 20。你让她做的事不受这个限制。',
        minimum: 10,
        maximum: 600,
        'x-suffix': ' 秒',
        'x-hot': true,
      },
      [P + 'sessionMaxItems']: {
        type: 'integer',
        title: '每次出门最多看几条',
        description: '一次出门最多看几条。默认 8，看完就回来。',
        minimum: 3,
        maximum: 12,
        'x-suffix': ' 条',
      },
      [P + 'tokenDailyBudget']: {
        type: 'integer',
        title: '每天模型预算',
        description: '每天模型预算，折算成「今天最多还能出去几次」。',
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
        description: '一条评论最多几个字。默认 100，短一点更像人。',
        minimum: 20,
        maximum: 300,
        'x-suffix': ' 字',
      },
      [P + 'interests']: {
        type: 'string',
        title: '兴趣词',
        description: '兴趣词，逗号分隔（猫, 历史, 编程）。只本地打分，不花 token。',
        'x-hot': true,
      },
      [P + 'avoid']: {
        type: 'string',
        title: '不想看的内容',
        description: '不想看的，逗号分隔。命中不进候选，只影响她自己挑，不影响你指定。',
      },
      [P + 'newAccountRamp']: {
        type: 'boolean',
        title: '新号保护',
        description: '新号保护：前 3 天额度过半，4~7 天八折。老号可以关。',
      },
      [P + 'riskGuard']: {
        type: 'string',
        title: '风控拦截力度',
        description: '遇到验证码怎么反应。默认「只记不拦」；号被限过就选严格。',
        'x-options': 'stroll-risk-guard',
      },
      [P + 'riskPauseHours']: {
        type: 'integer',
        title: '严格模式停多久',
        description: '严格模式下撞到风控停几小时。默认 6。',
        minimum: 1,
        maximum: 168,
        'x-suffix': ' 小时',
      },
      [P + 'allowedImageDirs']: {
        type: 'string',
        title: '额外允许发图的目录',
        description: '还允许从哪些目录取图发动态（一行一个）。不在列表里的一律不读。',
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
      [P + 'openMode']: {
        type: 'string',
        title: '看视频方式',
        description: '只看文字（默认，最省）/ 文字+9格分镜 / 只看画面。没字幕会自动补 1 帧。',
        'x-options': 'stroll-open-mode',
        'x-hot': true,
      },
      [P + 'subtitleOpen']: {
        type: 'integer',
        title: '后台看：带几句字幕',
        description: '后台看时带几句字幕（按 20 分钟折算，短的可到 72 句）。默认 24。',
        minimum: 0,
        maximum: 60,
        'x-suffix': ' 句',
      },
      [P + 'danmakuOpen']: {
        type: 'integer',
        title: '后台看：带几条弹幕',
        description: '后台看时带几条弹幕，按时间均匀抽。默认 12。',
        minimum: 0,
        maximum: 60,
        'x-suffix': ' 条',
      },
      [P + 'framesPerOpen']: {
        type: 'integer',
        title: '看视频抽几帧',
        description: '看视频抽几帧。默认 0（只看文字）；建议 9，B站会拼成一张图约 184 token。',
        minimum: 0,
        maximum: 9,
        'x-suffix': ' 帧',
      },
      [P + 'keepWindowSeconds']: {
        type: 'integer',
        title: '打开后窗口留多久',
        description: '开窗看完后窗口留多久。默认 90 秒，0 = 立刻关。',
        minimum: 0,
        maximum: 600,
        'x-suffix': ' 秒',
      },
      [P + 'openTalk']: {
        type: 'boolean',
        title: '后台看完也说一句',
        description: '她自己刷到一条时要不要跟你聊一句。会多花 token。',
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
        description: '一起看时说观后感，而不是只报进度。',
        'x-hot': true,
      },
      [P + 'watchLines']: {
        type: 'integer',
        title: '一次说几句',
        description: '每次开口说几句，默认 1。说多了更热闹也更花 token。',
        minimum: 1,
        maximum: 3,
        'x-suffix': ' 句',
      },
      [P + 'watchSpeakSec']: {
        type: 'integer',
        title: '一起看：多久说一句',
        description: '一起看时两次开口至少隔多久。默认 90 秒，60~120 最自然。',
        minimum: 20,
        maximum: 600,
        'x-suffix': ' 秒',
      },
      [P + 'subtitleWatch']: {
        type: 'integer',
        title: '一起看：带几句字幕',
        description: '一起看时带几句当前字幕。默认 2 句够接话。',
        minimum: 0,
        maximum: 5,
        'x-suffix': ' 句',
      },
      [P + 'danmakuWatch']: {
        type: 'integer',
        title: '一起看：带几条弹幕',
        description: '一起看时带几条当前弹幕。默认 6 条，能听出观众在笑什么。',
        minimum: 0,
        maximum: 20,
        'x-suffix': ' 条',
      },
      [P + 'watchWindowSec']: {
        type: 'integer',
        title: '一起看：弹幕窗口多大',
        description: '取弹幕的时间窗口（当前进度前后各多少秒）。默认 30。',
        minimum: 5,
        maximum: 120,
        'x-suffix': ' 秒',
      },
      [P + 'watchPollSec']: {
        type: 'integer',
        title: '一起看：多久读一次',
        description: '多久读一次页面状态。默认 10 秒，不花 token，可以调小。',
        minimum: 5,
        maximum: 120,
        'x-suffix': ' 秒',
      },
      [P + 'watchNotify']: {
        type: 'string',
        title: '她开始看时提醒我',
        description: '她开始看时怎么提醒你：只在面板（不花 token）/ 面板+对话说一句 / 不提醒。',
        'x-options': 'stroll-notify',
        'x-hot': true,
      },
      [P + 'watchWindow']: {        type: 'string',
        title: '陪看窗口多大',
        description: '陪看窗口开多大。最大化够用；全屏按 F11 退出。',
        'x-options': 'stroll-watch-window',
      },
      [P + 'watchBrowser']: {
        type: 'string',
        title: '陪看用哪个浏览器',
        description: '陪看用哪个浏览器。默认 Chrome 优先，没装自动退回 Edge。',
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
        description: '陪看抖音时自动切下一条。只对抖音生效，默认关。',
        'x-hot': true,
      },
      [P + 'watchScrollSec']: {
        type: 'integer',
        title: '一起刷：多久切一条',
        description: '一起刷时每条停多久。0 = 播完就切；填 30 = 30 秒后切。',
        minimum: 0,
        maximum: 180,
        'x-suffix': ' 秒',
      },
      [P + 'watchScrollEvery']: {
        type: 'integer',
        title: '一起刷：隔几条说一句',
        description: '刷几条说一句。默认 2——像人刷抖音也不是每条都评论。',
        minimum: 1,
        maximum: 10,
        'x-suffix': ' 条',
      },
      [P + 'watchShot']: {
        type: 'boolean',
        title: '一起刷：附一张画面',
        description: '一起刷时附一张当前画面。抖音没字幕，不附她其实看不见内容。约 500 token/张。',
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
        description: '开着 = 你一发消息几秒内就回。关掉只能等她下次查。',
        'x-hot': true,
      },
      [P + 'mentionWatch']: {
        type: 'boolean',
        title: '有人 @ 我就叫我',
        description: '有人 @ 她时主动叫起来看一眼（90 秒一次，安静时段不查）。',
        'x-hot': true,
      },
      [P + 'dmPollSec']: {
        type: 'integer',
        title: '多久看一次私信',
        description: '多久查一次私信。页面会自己推消息，这个只是掉线兜底。默认 5 秒。',
        minimum: 3,
        maximum: 300,
        'x-suffix': ' 秒',
        'x-hot': true,
      },
      [P + 'shareStyle']: {
        type: 'string',
        title: '分享视频怎么发',
        description: '给你发抖音视频的样子：画面+标题（默认，最稳）/ 真分享卡片 / 只发链接。',
        'x-options': 'stroll-share-style',
        'x-hot': true,
      },
      [P + 'strangerDmMode']: {
        type: 'string',
        title: '陌生人的私信',
        description: '陌生人私信：先问我（默认）/ 她自己回 / 都不回。回陌生人占私信额度。',
        'x-options': 'stroll-stranger-dm',
        'x-hot': true,
      },
      [P + 'quickMediaReply']: {
        type: 'boolean',
        title: '本地秒回',
        description: '对方只发表情或「在吗」时不叫模型，直接秒回。3 分钟内只一次。',
      },
      [P + 'strangerMaxPages']: {
        type: 'integer',
        title: '陌生人常驻页数量',
        description: '给几个陌生人开常驻页（读表情/发消息更快）。默认 2，每页 50~100MB。',
        minimum: 0,
        maximum: 4,
        'x-suffix': ' 个',
      },
      [P + 'strangerDmBlock']: {
        type: 'string',
        title: '私信黑名单',
        description: '这些人的私信一律不回（一行一个：昵称 / UID / sec_uid）。',
      },
      [P + 'groupWatch']: {
        type: 'boolean',
        title: '盯着抖音群',
        description: '要不要盯抖音群，有人说话就叫她。B站没有群聊。',
        'x-hot': true,
      },
      [P + 'douyinGroups']: {
        type: 'string',
        title: '要盯的抖音群（可留空）',
        description: '要盯哪些群（一行一个群名）。留空 = 自动认最近有消息的。',
      },
      [P + 'maxGroups']: {
        type: 'integer',
        title: '最多认几个群',
        description: '最多同时认几个群。默认 3，群多了会顾不过来。',
        minimum: 1,
        maximum: 10,
        'x-suffix': ' 个',
        'x-hot': true,
      },
      [P + 'groupTabs']: {
        type: 'integer',
        title: '最多常驻几个群监听页',
        description: '给几个群开常驻监听页。默认 1，每个约 50~100MB 内存。',
        minimum: 1,
        maximum: 8,
        'x-suffix': ' 个',
        'x-hot': true,
      },
      [P + 'debugLog']: {
        type: 'boolean',
        title: '调试日志',
        description: '打开后关键路径多打 info 日志，方便排查。平时关着，不然 core.log 会被刷满。',
      },
      [P + 'watchdog']: {
        type: 'boolean',
        title: '监听自检',
        description: '监听卡住时自动重启浏览器。一般不用管。',
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
/**
 * 分组顺序按「先用哪个」排，不按代码模块排。
 *
 * 2026-11-17 用户反馈设置页看不懂：'可以发 B站动态' 写着「纯文字」，
 * 下面「发哪种动态」却有图文——说明各自独立演进，没人从整页角度看过。
 *
 * 现在的顺序：先能跑起来（基础）→ 做多少（额度）→ 什么时候出去（出门）
 * → 出去看什么（看视频）→ 怎么互动（公开动作）→ 发什么（动态）
 * → 怎么聊（私信与群）→ 一起看 → 高级（风控/日志，最后）。
 */
export const CONFIG_GROUPS = [
  BASIC,        // 平台、开关、审批方式
  OWNER,        // 她 @ 谁、私信给谁
  QUOTA,        // 每天能做多少（最常调）
  OUTING,       // 什么时候自己出去
  VIEWING,      // 出去看什么、看多深
  INTERACT,     // 评论/点赞/关注的方式和限制
  POSTING,      // 发动态：发哪种、配图从哪来
  MESSAGES,     // 私信、陌生人、群
  WATCH,        // 一起看
  SHORTS,       // 抖音一起刷（暂时独立，键名不动）
  ADVANCED,     // 风控、日志、浏览器
];

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
  postKind: { type: 'enum', values: ['text', 'image', 'text_image'] },
  postImageFrom: { type: 'enum', values: ['generate', 'local'] },
  postImageDir: { type: 'string', max: 300 },
  postImageStyle: { type: 'string', max: 200 },
  postImageSaveDir: { type: 'string', max: 300 },
  postImageApiBase: { type: 'string', max: 300 },
  postImageApiKey: { type: 'string', max: 300 },
  postImageModel: { type: 'string', max: 120 },
  douyinCommentVia: { type: 'enum', values: ['manual', 'api'] },
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
  dailyPostsDouyin: { type: 'int', min: 0, max: 30 },
  dailySaves: { type: 'int', min: 0, max: 100 },
  browseDailyCap: { type: 'int', min: 0, max: 500 },
  mustLike: { type: 'boolean' },
  mustComment: { type: 'boolean' },
  mustDm: { type: 'boolean' },
  mustGroup: { type: 'boolean' },
  mustFollow: { type: 'boolean' },
  mustPost: { type: 'boolean' },
  maxGroups: { type: 'int', min: 1, max: 10 },
  groupTabs: { type: 'int', min: 1, max: 8 },
  debugLog: { type: 'boolean' },
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
  autoOuting: { type: 'boolean' },
  autoSessionsPerDay: { type: 'int', min: 0, max: 10 },
  outingMode: { type: 'enum', values: ['off', 'sessions', 'quota'] },
  autoGapMinutes: { type: 'int', min: 30, max: 360 },
  outingFrom: { type: 'int', min: 0, max: 23 },
  outingTo: { type: 'int', min: 0, max: 24 },
  sessionMaxItems: { type: 'int', min: 3, max: 12 },
  interests: { type: 'string', max: 300 },
  avoid: { type: 'string', max: 300 },
  framesPerOpen: { type: 'int', min: 0, max: 9 },
  openMode: { type: 'enum', values: ['text', 'both', 'frames'] },
  douyinPostMode: { type: 'enum', values: ['draft', 'publish'] },
  hostileReply: { type: 'enum', values: ['cold', 'ignore', 'sharp'] },
  shareWithOwner: { type: 'boolean' },
  shareWithOwnerPerDay: { type: 'int', min: 0, max: 5 },
  dailyCommentsDouyin: { type: 'integer', min: 0, max: 100 },
  commentGapBili: { type: 'integer', min: 0, max: 120 },
  commentGapDouyin: { type: 'integer', min: 0, max: 120 },
  commentBlockedDm: { type: 'boolean' },
  mentionOwnerOnComment: { type: 'boolean' },
  shareWindowIdleSec: { type: 'number' },
  creatorAutoProbe: { type: 'boolean' },
  creatorAutoProbe: { type: 'boolean' },
  keepWindowSeconds: { type: 'int', min: 0, max: 600 },
  background: { type: 'boolean' },
  watchSpeakSec: { type: 'int', min: 20, max: 600 },
  watchPollSec: { type: 'int', min: 5, max: 120 },
  dmWatch: { type: 'boolean' },
  mentionWatch: { type: 'boolean' },
  shareStyle: { type: 'enum', values: ['card', 'image', 'text'] },
  dmPollSec: { type: 'int', min: 3, max: 300 },
  booksDir: { type: 'string', max: 400 },
  stickerDir: { type: 'string', max: 400 },
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
