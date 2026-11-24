# 发布流程（给 agent 看的硬规范）

对象：`cortico-world-mosey`（摸鱼）。仓库 `F:/AI/WorkBuddy-workspace/桌宠B站抖音/stroll`。

---

## 0. 铁律：没听到「发布」两个字，不许发布

用户明确说过很多次。以下动作**只在**他亲口说「发布 / 发吧 / 可以发」之后才允许：

| 动作 | 平时能不能做 |
|---|---|
| 改 `package.json` 的 `version` | ❌ 不许 |
| 写 `CHANGELOG.md` | ❌ 不许 |
| `git push` | ❌ 不许 |
| `npm publish` | ❌ 不许 |
| `npm run describe`（会改 `describe.json`） | ❌ 不许（只在发布流程里跑） |

平时改完代码只跑 `npm run check` + `npm run deploy:local`，然后让用户重启 Coopanion 试。

如果用户没说要发布，而你说"已发布"，就是最严重的错误。

---

## 1. 动手前先确认「真的有东西可发」

```bash
cd "F:/AI/WorkBuddy-workspace/桌宠B站抖音/stroll"
git status -sb                 # 必须是干净的，或者你正要提交的改动
node -e "console.log(require('./package.json').version)"
npm view cortico-world-mosey version
```

判据：

- **本地版本 == npm 上的版本，且工作区没有新代码** → 没有可发的内容，停下来告诉用户，不要为了"发一次"而空升版本号。
- 本地有改动 → 继续。
- 本地版本 == npm 版本但工作区有改动 → 需要升版本号（下一步）。

---

## 2. 升版本号（用户定的规则，不跳号、不复用）

| 改了什么 | 怎么升 | 例 |
|---|---|---|
| 修 bug | 末尾 +1 | 2.12.0 → 2.12.1 |
| 加功能 | 中间 +1 | 2.12.0 → 2.13.0 |
| 大更新 / 破坏性改动 | 最前面 +1 | 2.12.0 → 3.0.0 |

同时改三处：

1. `package.json` 的 `"version"`
2. `CHANGELOG.md`，顶部加 `## <新版本号>`，写**用户能感知到什么**，不是"改了哪个函数"
3. 如果简介/功能有变化，`package.json` 的 `description`、`cortico.locales.zh.description`、`cortico.locales.en.description` 三处同步

CHANGELOG 格式（`release-check` 按 `## 版本号` 切分）：

```markdown
## 2.13.0

- 抖音楼中楼里有人回复时会主动叫她（以前只有 @ 才会）
- 楼中楼回复被平台挡住时会说明原因，不再只回一句 403
```

**隐私红线**：CHANGELOG / README / 提示词 / 测试断言里一律不写真实账号昵称。示例统一用 `小鹿`、`阿柚`、`老K`、`阿澈`、`群A/群B`。CHANGELOG 会原样显示在市场详情页，`src/**` 和 `describe.json` 会随包分发——写进去就是公开。

---

## 3. 七步流程

### ① 回归

```bash
npm run check
```

通过标准：末行 `NNN checks passed`，**退出码 0**。任何一条 `FAILED` 都不许继续。

### ② 重建 describe（只有工具/事件有变动才需要，但每次跑一遍最稳）

```bash
npm run describe
git diff --stat describe.json    # 看它到底改了什么
```

新增/修改工具或事件时，`src/tools.js`（`TOOL_DECLS` / `TOOL_SUMMARIES` / `EVENT_DECLS`）和 `src/definition.js` 必须同步。

### ③ 发布前检查（会拦人）

```bash
npm run release:check
```

它会检查：版本号 vs npm 占位、CHANGELOG 是否有对应小节、三处简介是否都带「QQ 交流群：745879632」、工作区是否干净、describe.json 是否存在。

**必须看到全部 `✓`**。有 `✗` 就按提示修，修完重跑，不许绕过。

### ④ 本地部署（让用户马上能试）

```bash
npm run deploy:local
```

目标目录固定 `F:/Coopanion/data/local-extensions/cortico-world-mosey`。脚本是「先写临时目录再替换」，**不要**自己 `rm -rf` 再 `cp`，会把安装目录搞成空壳。

跑完要提醒用户：**完全退出 Coopanion 再打开**（宿主对前端资源做了 immutable 缓存，刷页面无效）。

### ⑤ 提交

```bash
git add -A
git commit -m "2.13.0：<一句话说清这次改了什么>"
```

只做本地提交，**这一步不推远端**。

### ⑥ 推远端

```bash
git pull --rebase origin main
git push
```

`pull --rebase` 冲突时：本地一般是超集，取自己的版本（`--theirs` 侧），重跑 ① 的 `npm run check` 再继续。

### ⑦ 发到 npm

```bash
npm whoami            # 没登录会报 ENEEDAUTH，先 npm login
npm publish
```

**关键**：`npm publish` 经常返回 **HTTP 202**，这不是失败。registry 要 3–5 分钟才生效，中间 `npm view` 还是旧版本属正常，**不要因此重发**。

---

## 4. 发布后验证（必做，别只看 publish 输出）

```bash
# 等 3-5 分钟
npm view cortico-world-mosey version
npm view cortico-world-mosey dist-tags.latest
```

两个都应该是新版本号。

想更稳就下载包比对：

```bash
cd /tmp && npm pack cortico-world-mosey@<新版本号>
tar -tzf cortico-world-mosey-<新版本号>.tgz | head -30
```

确认 `src/`、`webui/`、`describe.json` 都在，且和你本地一致（`sha256sum` 对比几个关键文件）。

---

## 5. 出问题怎么办

| 情况 | 处理 |
|---|---|
| 发完发现代码有 bug | **不要 unpublish**。改完按 bug 规则升号（+1）再发一次 |
| 版本号搞错了 | 发过的号不可改；只能发更高的号。`npm unpublish` 国内镜像有缓存，不保证干净 |
| publish 返回 202 但 `npm view` 一直没变 | 先等满 5 分钟；仍没有就 `npm view cortico-world-mosey versions --json` 看有没有真的进去 |
| release:check 说工作区不干净 | 先把该提交的提交，再重跑；不要用 `--force` 之类绕过 |

---

## 6. 绝对不要做

- ❌ 没听到「发布」就升版本号 / 写 CHANGELOG / push / publish
- ❌ 跳过 `npm run check` 或 `npm run release:check`
- ❌ 直接 `rm -rf` 部署目录
- ❌ 把 `.probe/`、`scripts/probe-*.mjs`、临时 profile 目录提交进仓库（它们在 `.gitignore` 里，别手动 `git add -f`）
- ❌ 在文档/注释/测试里写真实账号昵称
- ❌ publish 返回 202 就以为失败，重复发
- ❌ 在多个分支或 worktree 上同时改 `src/`，再"合并一下"——这个仓库的大文件（`douyin.js` 8k 行）合并必炸

---

## 7. 一次性复制版

```bash
cd "F:/AI/WorkBuddy-workspace/桌宠B站抖音/stroll"

# 0) 确认有东西可发
git status -sb && node -e "console.log(require('./package.json').version)" && npm view cortico-world-mosey version

# 1) 改 version + CHANGELOG（手动）

# 2) 验证
npm run check
npm run describe
npm run release:check

# 3) 部署 + 提交 + 推 + 发
npm run deploy:local
git add -A && git commit -m "<版本号>：<一句话>"
git pull --rebase origin main && git push
npm publish

# 4) 等 3-5 分钟后验证
npm view cortico-world-mosey version
```
