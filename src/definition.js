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
