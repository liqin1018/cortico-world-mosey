/** 只放三把工具：读、写、改规矩。工具越少，常驻 schema 越便宜。 */

export const TOOL_DECLS = [
  {
    name: 'stroll',
    description:
      '出门看看（只读，默认后台，不弹网页）。action=status 查登录/额度；brief 一次拿全（推荐，省 token）；feed 刷候选；following 看关注的人在发什么（B站/抖音）；open 后台看指定视频/动态/专栏（B站/抖音链接都行，/note/ 图文也行；B站视频会带字幕和弹幕）；comments 只读评论区（B站/抖音，链接自动判断；带图评论会附最多两张图）；inbox 看谁回了你（评论/@/私信都算；抖音私信带 recent 最近十几句，含分享的视频/图文链接，还有 pending/said 表示主人连着发了几句）；groups 看抖音会话列表（私信和群都在里面，会标出哪些是群、正在盯哪几个）；join_group 用群邀请链接进群（url 参数）；stickers 看本地表情包库（query 按名字/标签筛，没有就空），images 看能发的图（自己画的 + 别人发来存下的，发图前用它确认有哪些）；search 搜 B站；weekly 看这周小结；books 看书库、read 读一段、note 记一句摘抄；watch 一起看（watch_action=start/stop/status，start 才开窗）；login 打开登录窗；history 看最近做过什么。先 brief，少反复 status。',
    tags: ['read'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'brief', 'feed', 'following', 'open', 'comments', 'inbox', 'search', 'weekly', 'books', 'read', 'note', 'login', 'history', 'whoami', 'watch', 'groups', 'join_group', 'stickers', 'images'],
          description: '要做什么。',
        },
        platform: { type: 'string', enum: ['bilibili', 'douyin'], description: '去哪个平台；open 会从链接自动判断。' },
        url: { type: 'string', description: '视频 / 动态 / 专栏链接（open 用）。' },
        id: { type: 'string', description: 'BV 号、av 号、动态 ID、cv 号或抖音视频 ID（open 用）。' },
        query: { type: 'string', description: '搜索词（search 用）；stickers 用它按名字/标签筛。' },
        n: { type: 'integer', minimum: 1, maximum: 20, description: '要几条，默认 6。' },
        days: { type: 'integer', minimum: 1, maximum: 30, description: 'weekly 看最近几天，默认 7。' },
        book: { type: 'string', description: 'read 用：书名（不带后缀也行）；不填就接着上次那本。' },
        chars: { type: 'integer', minimum: 200, maximum: 2000, description: 'read 一次读多少字，默认 900。' },
        text: { type: 'string', description: 'note 用：要记下来的那句摘抄。' },
        tag: { type: 'string', description: 'stickers 用：只看带这个标签的表情包。' },
        frames: { type: 'integer', minimum: 0, maximum: 3, description: '抖音抽几帧；默认 0，最省 token。' },
        watch_action: {
          type: 'string',
          enum: ['start', 'stop', 'status'],
          description: 'watch 用：start 和主人一起看（会开一个窗口，主人可以在里面翻页；开了「抖音一起刷」时会自动切下一条）；stop 结束；status 看现在看到哪。',
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'stroll_act',
    description:
      '做一个公开动作：like/unlike、follow/unfollow、comment、reply、post（B站动态）、dm、save（B站稍后再看）、sticker（发表情包）、image（把自己画的图/本地图片发到抖音私信、群聊或评论区）、collect_stickers（收藏抖音表情包）、sticker_name（给收藏的表情改名字）。comment/reply 的 target 可以是视频、B站动态（t.bilibili.com/… 或 opus 链接）或专栏；回复楼中楼要带 reply_to（评论 rpid）。默认只生成草稿，等主人在面板点批准；点赞在 auto_low_risk 下、私信主人（dm）在任何非 dry_run 模式下都直接发。表情包的发送和收藏只在抖音聊天里，跟私信一样直接发、不占公开额度。不要自己批准，不要绕过额度。',
    tags: ['act', 'speak'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['like', 'unlike', 'follow', 'unfollow', 'comment', 'reply', 'post', 'dm', 'save', 'approve', 'reject', 'sticker', 'image', 'collect_stickers', 'sticker_name'],
        },
        platform: { type: 'string', enum: ['bilibili', 'douyin'] },
        target: {
          type: 'string',
          description:
            '视频 BV/链接、B站动态链接（t.bilibili.com/… 或 /opus/…）、专栏 cv 号；关注时是对方 UID（抖音给主页链接、sec_uid 或视频链接都行）。发抖音私信给主人就把 target 写成「主人」（或「私信」）；在抖音群里说话就把 target 写成群名（照抄推送/`groups` 里给的名字，同名群会带 #2）；只有一个群时写「群」也算。刚回过群消息又没写 target，会被要求写清楚——不会再自动发成私信。image 发评论区时，target 写视频链接（或配 where=comment）。collect_stickers 也用它指定去哪个群/会话里收。',
        },
        text: {
          type: 'string',
          description:
            '评论/动态/私信正文。评论不超过 120 字。sticker 用它挑表情（名字、序号或 id，留空＝随机一张）；sticker_name 用它当新名字（配 target=表情 id）。',
        },
        file: {
          type: 'string',
          description:
            'image 用：本地图片路径（图片工坊面板「复制路径」拿到的那种），或者文件名/id 片段（如 ab6899f7）。留空＝用图片工坊最新的一张。',
        },
        where: {
          type: 'string',
          enum: ['chat', 'comment'],
          description: 'image 用：chat 发到私信/群（默认），comment 发到评论区（这时 target 要给视频链接）。',
        },
        reply_to: { type: 'string', description: '回复评论时，被回复的评论 ID（rpid）。' },
        mention_owner: {
          type: 'boolean',
          description:
            '真的 @ 主人（B站评论/动态、抖音评论、抖音群消息都支持）。评论和群消息会在候选面板里选中人插成带 uid 的 chip。**正文里不要自己手写 @昵称**：手打的 @ 只是普通字符，会被染成蓝色但对方收不到通知，还会和真 chip 重复；真带了也会被自动剥掉。',
        },
        mention: {
          type: 'string',
          description:
            '群里 @ 谁的昵称（照抄群成员列表，比如「老K」）。@主人不用填这个，用 mention_owner: true —— 系统知道主人的抖音昵称。不要填「你」「主人」这种称呼，也不要自己写 @ 符号。',
        },
        draft_id: { type: 'string', description: 'approve/reject 用。' },
        preview: { type: 'boolean', description: 'true = 只出草稿，不发送。' },
      },
      required: ['action'],
    },
  },
  {
    name: 'stroll_policy',
    description:
      '看/改摸鱼的偏好。action=get 看现状（额度、审批、安静时段、主人账号都能读）；set 只能改兴趣词（interests）和不想看的内容（avoid），别的一律会被拒绝——额度/审批/主人账号/开关只能主人在面板改；pause 拉手刹（小时，你自己最多 1 小时）；resume 解除。',
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
  { type: 'stroll.reply', description: { zh: '有人回复或 @ 了她，或者主人刚发来私信（会立刻把她叫起来回）。', en: 'Someone replied or mentioned her, or the owner just sent a DM (she is woken to answer right away).' }, trigger: 'debounce' },
  { type: 'stroll.watch', description: { zh: '和主人一起看时，页面/进度/评论区的新情况。', en: 'The shared watch page changed: title, progress or comments.' }, trigger: 'debounce' },
  { type: 'stroll.watching', description: { zh: '她开始看某一条了（只在配置里选了「对话里也说一句」时推送）。', en: 'She started watching something (only when chat notifications are on).' }, trigger: 'debounce' },
];
