# NOTICE

摸鱼（`cortico-world-mosey`，英文名 Mosey，World id `stroll`）以 MIT 许可发布。

实现过程中参考了同生态中同样以 MIT 发布的插件，仅复用接口路径、签名算法、页面选择器与交互模式；没有复制它们的业务状态、额度逻辑或用户数据。

## 参考项目

- **cortico-world-bili-whale**（B站工作台，作者 htzyq，MIT）
  - WBI 签名算法（MIXIN 重排 + MD5）
  - B站 Web API 路径与 CSRF 用法
  - 长整型 ID 在 JSON 解析前转字符串的处理方式
- **cortico-world-douyin**（抖音，Coopanion 生态，MIT）
  - 精选页 `[data-aweme-id]` 卡片读取思路
  - 视频详情 `[data-e2e="detail-video-info"]` / `[data-e2e="user-info"]` 读取思路
  - 独立 Edge 资料、持久化登录的做法
- **cortico-world-bili-video-pro**（陪看，MIT）
  - “B站 @ 认昵称不认 UID”的行为与 `@昵称` 校验方式
  - 评论回执中如实说明 @ 是否生效的产品表达
- **cortico-world-social-media**（社交视窗，MIT）
  - 独立浏览器资料、动作串行队列、验证页识别的总体思路

## 字体与图标

`assets/icon.png` 由本项目的 `assets/icon.svg` 用 Chrome 无头渲染生成，没有使用第三方图标库。

## 平台声明

本项目不是抖音、哔哩哔哩的官方产品，也未获得其背书。所有平台名称、接口与页面结构归各自权利人所有。使用者应自行遵守平台服务条款与当地法律；作者不对账号处罚、内容审核或数据丢失承担责任。
