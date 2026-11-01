/** 只放三把工具：读、写、改规矩。工具越少，常驻 schema 越便宜。 */

export const TOOL_DECLS = [
  {
    name: 'stroll',
    description:
      '出门看看（只读，默认后台，不弹网页）。action=status 查登录/额度；brief 一次拿全（推荐，省 token）；feed 刷候选；open 后台看指定视频/链接；inbox 看谁回了你；search 搜 B站；watch 一起看（watch_action=start/stop/status，start 才开窗）；login 打开登录窗；history 看最近做过什么。先 brief，少反复 status。',
    tags: ['read'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'brief', 'feed', 'open', 'inbox', 'search', 'login', 'history', 'whoami', 'watch'],
          description: '要做什么。',
        },
        platform: { type: 'string', enum: ['bilibili', 'douyin'], description: '去哪个平台；open 会从链接自动判断。' },
        url: { type: 'string', description: '视频链接（open 用）。' },
        id: { type: 'string', description: 'BV 号 / av 号 / 抖音视频 ID（open 用）。' },
        query: { type: 'string', description: '搜索词（search 用）。' },
        n: { type: 'integer', minimum: 1, maximum: 8, description: '要几条，默认 6。' },
        frames: { type: 'integer', minimum: 0, maximum: 3, description: '抖音抽几帧；默认 0，最省 token。' },
        watch_action: {
          type: 'string',
          enum: ['start', 'stop', 'status'],
          description: 'watch 用：start 和主人一起看（会开一个窗口，主人可以在里面翻页）；stop 结束；status 看现在看到哪。',
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'stroll_act',
    description:
      '做一个公开动作：like/unlike、follow/unfollow、comment、reply、post（B站动态）、dm、save（B站稍后再看）。默认只生成草稿，等主人在面板点批准；点赞在 auto_low_risk 下可直接执行。不要自己批准，不要绕过额度。',
    tags: ['act', 'speak'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['like', 'unlike', 'follow', 'unfollow', 'comment', 'reply', 'post', 'dm', 'save', 'approve', 'reject'],
        },
        platform: { type: 'string', enum: ['bilibili', 'douyin'] },
        target: { type: 'string', description: '视频链接/ID；关注时是对方 UID；私信时是对方 UID/sec_uid。' },
        text: { type: 'string', description: '评论/动态/私信正文。评论不超过 120 字。' },
        reply_to: { type: 'string', description: '回复评论时，被回复的评论 ID（rpid）。' },
        mention_owner: { type: 'boolean', description: '公开内容里 @ 主人；默认 false。' },
        draft_id: { type: 'string', description: 'approve/reject 用。' },
        preview: { type: 'boolean', description: 'true = 只出草稿，不发送。' },
      },
      required: ['action'],
    },
  },
  {
    name: 'stroll_policy',
    description:
      '读/改摸鱼的规矩：每日额度、审批方式、安静时段、兴趣词、主人 UID、自动出门次数。action=get 看现状；set 传 patch；pause 拉手刹（小时）；resume 解除。改额度不会绕过周上限。',
    tags: ['flow', 'act'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['get', 'set', 'pause', 'resume'] },
        patch: {
          type: 'object',
          additionalProperties: true,
          description: '要改的字段，例如 {"dailyLikes":6,"approval":"confirm","ownerUid":"123"}。',
        },
        hours: { type: 'integer', minimum: 1, maximum: 168, description: 'pause 几小时。' },
      },
      required: ['action'],
    },
  },
];

export const TOOL_SUMMARIES = {
  stroll: { zh: '出门看看：状态、候选、打开视频、消息、搜索。只读。', en: 'Look around: status, feed, open a video, inbox, search. Read-only.' },
  stroll_act: { zh: '点赞/评论/关注/发动态/私信；默认先出草稿等主人批准。', en: 'Like, comment, follow, post or DM; drafts wait for the owner.' },
  stroll_policy: { zh: '读/改额度、审批、安静时段、兴趣与主人账号。', en: 'Read or change caps, approval, quiet hours, interests and owner account.' },
};

export const EVENT_DECLS = [
  { type: 'stroll.due', description: { zh: '自己该出门溜达了（每天最多几次）。', en: 'A scheduled outing is due.' }, trigger: 'debounce' },
  { type: 'stroll.sent', description: { zh: '主人批准后，公开动作真的发出去了。', en: 'An approved public action was sent.' }, trigger: 'flush' },
  { type: 'stroll.risk', description: { zh: '平台风控/验证，已自动停手。', en: 'A platform risk signal paused all writes.' }, trigger: 'flush' },
  { type: 'stroll.reply', description: { zh: '有人回复或 @ 了她。', en: 'Someone replied to or mentioned her.' }, trigger: 'debounce' },
  { type: 'stroll.watch', description: { zh: '和主人一起看时，页面/进度/评论区的新情况。', en: 'The shared watch page changed: title, progress or comments.' }, trigger: 'debounce' },
  { type: 'stroll.watching', description: { zh: '她开始看某一条了（只在配置里选了「对话里也说一句」时推送）。', en: 'She started watching something (only when chat notifications are on).' }, trigger: 'debounce' },
];
