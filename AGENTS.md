# AGENTS.md — 摸鱼（cortico-world-mosey）

给接手这个仓库的 AI agent 看的。读完这一页再动手，能省掉一天试错。
人类可读版在 `README.md`；发布规范在 `RELEASE.md`（**硬约束，不是建议**）。

---

## 0. 这是什么

Coopanion（Windows Electron 桌宠）的「摸鱼」插件：让桌宠自己去抖音 / B站逛、看视频、刷关注流、
评论、回复、收发私信、发表情包、写周报、看书库。

- 纯 ES module，**没有构建步骤**，`src/*.js` 就是运行代码
- 运行在宿主 Node 进程里，通过 `host.pushEvent()` 把事件推给模型
- 唯一的运行依赖：`playwright-core`（驱动系统 Edge / Chrome 打开抖音、B站）
- 宿主 API 版本：`cortico.api: 6`（见 `package.json`）

## 1. 三条铁律

1. **改代码只在这个仓库**：`F:/AI/agent/Codex/Codex Project/Coopanion插件/摸鱼插件/stroll`。
   `F:/Coopanion/data/local-extensions/cortico-world-mosey` 是 `npm run deploy:local` 的**部署目标**，
   在那里改代码不会进版本库，下次部署就被覆盖 —— 在这里花的时间等于白花。
2. **发布要亲口说；版本跟成功修改走**：`git push`、`npm publish`、`npm run describe` 只在用户说
   「发布」后做。每次用户要求的修改，`npm run check` 全绿后升一个版本位并写 `CHANGELOG.md`；
   没通过就不升号、不写日志。一次修改只升一位（bug 末位、小功能中位、大功能首位）。
3. **一次只修一个症状**。`world.js` / `douyin.js` 各 ~8.5k 行，捆绑式「顺手清理 + 修复」不可评审，
   也无法定位是哪一步改坏的。

## 2. 标准循环

```bash
cd "F:/AI/agent/Codex/Codex Project/Coopanion插件/摸鱼插件/stroll"

node scripts/smoke.mjs          # 等同 npm run check；离线断言必须全绿
node scripts/deploy-local.mjs   # 等同 npm run deploy:local；同步到安装目录
# 然后必须让人类「完全退出 Coopanion 再打开」
```

**为什么必须重启**：宿主对前端资源做了 immutable 缓存，刷新面板 / 重载插件都会跑旧代码。
「改了没生效」九成是没重启。

验证一个改动的正确顺序：

1. `npm run check` 全绿（红就是没改对，别继续）
2. `npm run deploy:local`
3. 请人类重启 Coopanion
4. 让人类在面板 / 抖音真机上复现一次
5. **读 `F:/Coopanion/data/logs/core.log`**，用日志证明行为变了 —— 不要凭「代码看起来对」宣布修好

## 3. 架构地图

| 文件 | 行数 | 管什么 |
|---|---:|---|
| `src/world.js` | ~8.6k | 世界主体：额度策略、私信/群/评论推送、工具实现、配置、提示词变量 |
| `src/douyin.js` | ~8.5k | 抖音全部：Playwright 驱动、评论读写、私信、表情面板、签名 |
| `src/bilibili.js` | ~2.3k | B站：HTTP API 为主，动态发图走网页编辑器 |
| `src/policy.js` | ~500 | 额度 / 节奏 / 风控闸门（`check()` 决定一个动作能不能做） |
| `src/stickers.js` | ~380 | 表情库（索引 + 图片目录，可指向外部图库） |
| `src/config.js` | ~1.2k | `DEFAULTS` + 面板配置 schema `CONFIG_GROUPS` + 校验 |
| `src/tools.js` | 161 | 工具声明（`stroll` 只读 / `stroll_act` 动作），**没有业务逻辑** |
| `src/definition.js` | — | 世界定义：工具、事件、webUi 入口 |
| `webui/client.js` | ~2.6k | 面板前端（原生 JS，不是 React） |
| `scripts/smoke.mjs` | ~3.7k | 离线断言，`npm run check` 就是它 |

数据流：定时轮询 / 页面事件 → `world.push()` → `host.pushEvent()` → 模型 → `toolStroll` / `toolAct` → 浏览器或 HTTP。

## 4. 运行态在哪（你看不到，但人类能）

你（沙箱里的 CLI agent）读不到活着的 Electron 进程、Playwright 页面、宿主事件流。
所有运行态只能通过这些**落盘的东西**间接看到：

| 位置 | 内容 |
|---|---|
| `F:/Coopanion/data/logs/core.log` | 宿主日志。插件每行带 `[stroll]` 前缀，先按前缀过滤再找错 |
| `F:/Coopanion/data/home/companion/data/stroll/state.json` | 插件的全部状态：`actions`（做过什么）、`dyThreads`（正在盯的楼）、`dmSeen`、额度用量 |
| `.../data/stroll/debug/` | 失败现场：`reply-empty-*.json`、`group-who-*.json`、`share-fail-*` |
| `.../data/stroll/media/` | 收到的图片（`recv-<sha1>.<ext>`） |
| `.../data/stroll/stickers/index.json` | 表情库索引（名字 / 标签 / 用过几次） |

读日志时注意：`worlds.fatfish: DSH bridge: connect ECONNREFUSED`、`core.store: 事件分片有损坏`、
`stroll digest today` 每秒刷屏 —— 这些是宿主噪音，不是插件的 bug。

## 5. 当前状态（2026-11-27）

- 本地版本：`2.13.4`；HEAD 以 `git log -1 --oneline` 为准。
- 工作区已有既有未提交修复和本次代码/文档改动，**以 `git status -sb` 为准**。
- 线上版本发布前另行核对，不要沿用旧文档里的版本号。
- 这台机器上真正可用的模型只有 `cn:deepseek-v4.1-flash`，其他模型在网关里全是 100% 失败。

### B站评论审批链路（当前主线）

- `stroll_act` 返回的 `draft_...` 是草稿号，不是 B站 `rpid`。回执里 `status` 是 `pending_owner_approval`、`sent: false`，并保留 `draft: true`、`id`、`expiresAt`、`expiresInSec`；草稿内部状态是 `pending`，30 分钟有效。
- 只有主人在面板批准后才会执行 `comment`，成功回执才带 `rpid` 和 `visibility`。草稿创建后立即 `save()`；写盘失败返回 `DRAFT_SAVE_FAILED`，不进入待审批。
- 创建、查询、审批和 tick 都走 `store.expireDueDrafts()`：过期草稿标 `status: expired`、`sent: false`，保留 3 天，不物理删除。`approveDraft` 对过期草稿返回 `DRAFT_EXPIRED`，不发网络请求、不扣额度。
- 过期后会推 `stroll.draft_expired`（`trigger: flush`）：tick 一次最多推一条，最多列 3 条预览；安静时段延后；推送成功才写 `expiredNotifiedAt`，失败下轮重试；不使用 `interrupt`。
- `history` / `status` / `brief` 都带 `expiredDrafts`，字段为 `id` / `action` / `platform` / `preview` / `expiredSec` / `status: 'expired'` / `sent: false`。
- `visibility=public/hidden/unknown` 是**发送后**的可见性检查，不是审批状态。`hidden/unknown` 不自动重试。
- 健康检查只看最近一条已发 B站评论在发送时记录的 `extra.visibility`；只有 `hidden` 才报。

### B站评论问题排查顺序

1. `state.json.drafts`：看 `status`、`createdAt`、`expiredAt`，先分清待批、已发、已过期。
2. `state.json.actions[].extra.visibility`：确认发送后是 `public`、`hidden` 还是 `unknown`。
3. `core.log`：搜 `stroll draft expired`、`stroll draft expired push`、`stroll account health`。
4. 确认当前实际部署/加载的版本，再判断代码是否已经生效。

### 历史专项：抖音楼中楼续聊（未完成真机验证）

> 这条不是当前主线，保留供追溯；完整交接见 [`../docs/handoff-2026-11-22.md`](../docs/handoff-2026-11-22.md)。

**症状**：主人在视频评论里 @ 她 → 她能回；但主人**在她那条评论下面接着回**，她永远收不到。

已经剥开的四层（每一层都修了，但每修一层露出下一层）：

1. **读回复的判据错了**：`comment/list` 返回的 `reply_comment` 多数是**对象或 null，不是数组**，
   旧代码 `Array.isArray()` 一律读成 0 条。→ 已修（兼容 object + `kind` 日志）
2. **预览不给内容**：现在 `reply_comment` 常常是 `null`，只给 `reply_comment_total`。
   → 已加 fallback：`comment/list/reply` 接口（`via: 'reply_api'` / `'reply_api_empty'`）
3. **发出去但没记录**：楼中楼回复撞验证码 / 响应丢失时没有 cid，那层楼就永远进不了监控名单。
   → 已加：`if (!cid)` 反查 + `commentReplies()` 按正文找回自己刚发的那句（`via: 'api-verify'`）
4. **查的时候页面在导航**：`page.evaluate` 抛 `Execution context was destroyed`，被 catch 成空数组。
   → 已加：等 800ms 重试一次，日志 `stroll dy replies retry`

**还没解决**：以上四处都没经过真机验证。若回到这条历史专项，先看这行日志判断走到哪了：

```
[stroll] stroll dy replies api { http, root, found, total, n, kind, via }
```

- `via: 'preview'` + `total: 0` → 这层楼确实没人回，或查错了楼
- `via: 'reply_api'` + `n > 0` → 读通了，接下来看 `stroll dy replies { kept }` 是否 > 0
- `via: 'reply_api_empty'` → 官方接口也不给，**只剩一条路：点 UI 读 DOM**
  （打开视频页 → 找到主评论 → 点「展开 N 条回复」→ 读新渲染的子评论）。
  照 `douyin.js` 里 `readMessages()` 的写法（`page.evaluate` + `data-e2e` 选择器）抄，
  约 150 行。这是该历史专项的下一步，不是当前 B站审批主线。

**另一个已知阻塞**：抖音会弹人机验证（`captcha/v2`），日志会写
`抖音要验证…得主人在手机上过一下验证码`。验证码没过时任何自动化都会卡 4 分钟然后失败 ——
这不是代码问题，先让人类在面板「登录抖音」里手动过掉。

## 6. 容易踩的坑

- **Windows 路径**：仓库路径含中文。`git`、`node` 这类原生程序不认 `/f/...`，用 `F:/...` 正斜杠路径。
- **`node -e` 跑多行或含中文的脚本会炸**（`compileSourceTextModule`）。写 `.mjs` 文件再 `node` 它。
- **Playwright 只认 `msedge` / `chrome` 的持久化 profile**。抖音 cookie 绑应用身份（App-Bound Encryption），
  换个浏览器读同一个 profile 就是「没登录」。
- **抖音视频页在 headless 里会崩**（`Target crashed`）。要在无头环境调接口，用 `https://www.douyin.com/`
  首页借同源，别开 `/video/`；或者 `page.route()` 屏蔽 `media`/`image` 资源。
- **不要在这个仓库和另一个 worktree 里同时改 `src/` 再「合并一下」**。8k 行的文件合并必炸。
- **`npm run check` 里有一条依赖网络的断言**（`readOpen` 会去抓 B站预览图）。它返回
  `{ text, blobs }` 或纯字符串两种形态，测试用 `asJson()` 兼容 —— 别改回 `JSON.parse(字符串)`。
- **隐私红线**：`CHANGELOG` / `README` / 提示词 / 测试断言里**不写真实账号昵称**。
  示例统一用 `小鹿`、`阿柚`、`老K`、`阿澈`、`群A/群B`。这些文件会原样进 npm 包和市场详情页。

## 7. 提交前自检

```bash
node --check src/douyin.js && node --check src/world.js   # 语法
npm run check                                              # 以末行输出为准，退出码必须 0
git status --short                                         # 只应有你打算提交的文件
```

改完在回复里写清楚三件事：**改了什么文件 / 日志里哪一行能证明生效 / 还剩什么没验证**。
