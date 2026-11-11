import { DEFAULTS } from './config.js';
import { StrollWorld } from './world.js';
import { TOOL_DECLS, TOOL_SUMMARIES, EVENT_DECLS } from './tools.js';

export const STROLL = {
  id: 'stroll',
  label: '摸鱼',
  defaults: () => ({ ...DEFAULTS }),
  create: (ctx) =>
    new StrollWorld({
      cfg: ctx.cfg,
      timezone: ctx.timezone,
      dataDir: ctx.dataDir,
      persist: (patch) => ctx.persist(patch),
      // 之前没接宿主日志：群监听/私信挂载这些关键事件在 core.log 里一条都看不到，
      // 出问题只能靠猜。宿主有 ctx.log 就接上（worlds.stroll 前缀）。
      log: ctx.log,
    }),
  /** 配置里的中文下拉：值仍是英文，显示给主人看的是中文。 */
  configOptions: (kind, language) => {
    const zh = language !== 'en';
    if (kind === 'stroll-notify') {
      return [
        { value: 'panel', label: zh ? '只在面板上（不花 token）' : 'Panel banner only' },
        { value: 'chat', label: zh ? '面板 + 对话里说一句' : 'Banner + one line in chat' },
        { value: 'off', label: zh ? '不提醒' : 'Off' },
      ];
    }
    if (kind === 'stroll-watch-browser') {
      return [
        { value: 'auto', label: zh ? '自动（Chrome 优先）' : 'Auto (Chrome first)' },
        { value: 'chrome', label: 'Chrome' },
        { value: 'edge', label: 'Edge' },
      ];
    }
    if (kind === 'stroll-watch-window') {
      return [
        { value: 'maximized', label: zh ? '最大化（推荐）' : 'Maximized' },
        { value: 'fullscreen', label: zh ? '全屏（F11 退出）' : 'Fullscreen (F11 to exit)' },
        { value: 'normal', label: zh ? '普通窗口 1280×800' : 'Window 1280×800' },
      ];
    }
    if (kind === 'stroll-share-style') {
      return [
        { value: 'image', label: zh ? '画面 + 标题（稳，推荐）' : 'Frame + title (stable)' },
        { value: 'card', label: zh ? '真分享卡（原生卡片）' : 'Native share card' },
        { value: 'text', label: zh ? '只发链接' : 'Plain link' },
      ];
    }
    if (kind === 'stroll-stranger-dm') {
      return [
        { value: 'ask', label: zh ? '先问我，我同意再回（默认）' : 'Ask me first (default)' },
        { value: 'auto', label: zh ? '她自己回' : 'Reply automatically' },
        { value: 'off', label: zh ? '都不回' : 'Never reply' },
      ];
    }
    if (kind === 'stroll-douyin-follow') {
      return [
        { value: 'browser', label: zh ? '让她在网页里点（默认）' : 'Click in browser (default)' },
        { value: 'off', label: zh ? '关（你在手机上关注）' : 'Off (follow on phone)' },
      ];
    }
    if (kind === 'stroll-risk-guard') {
      return [
        { value: 'off', label: zh ? '不拦（推荐）' : 'Off (recommended)' },
        { value: 'light', label: zh ? '只在验证码时停' : 'Only on captcha' },
        { value: 'strict', label: zh ? '严格' : 'Strict' },
      ];
    }
    if (kind === 'stroll-outing-mode') {
      return [
        { value: 'sessions', label: zh ? '按次数：出去几次就收工（默认）' : 'By trip count (default)' },
        { value: 'quota', label: zh ? '按额度：额度做满才收工' : 'By daily quota' },
        { value: 'off', label: zh ? '不自己出门' : 'Never go out on its own' },
      ];
    }
    if (kind !== 'stroll-approval') return [];
    return [
      { value: 'confirm', label: zh ? '全部等我批准（推荐）' : 'Ask me first (recommended)' },
      { value: 'auto_low_risk', label: zh ? '点赞自动，其余问我' : 'Auto like, ask for the rest' },
      { value: 'dry_run', label: zh ? '只读，只写草稿' : 'Read only, draft only' },
      { value: 'auto_all', label: zh ? '按额度自动，不再问我' : 'Auto within quota, never ask' },
    ];
  },
  describe: {
    tools: TOOL_DECLS.map(({ name, description, parameters, tags }) => ({
      name,
      description,
      parameters,
      tags,
      summary: TOOL_SUMMARIES[name],
    })),
    events: EVENT_DECLS,
  },
};

export default STROLL;
