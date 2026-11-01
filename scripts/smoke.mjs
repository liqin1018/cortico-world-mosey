import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS } from '../src/config.js';
import { StrollWorld } from '../src/world.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = path.join(root, '.smoke-data');
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });

const cfg = {
  ...DEFAULTS,
  enabled: true,
  quietFrom: 0,
  quietTo: 0,
  autoSessionsPerDay: 0,
  approval: 'confirm',
  interests: '游戏,音乐',
};

const world = new StrollWorld({
  cfg,
  timezone: 'Asia/Shanghai',
  dataDir: tmp,
  persist: (patch) => Object.assign(cfg, patch),
});

const checks = [];
function check(name, ok) {
  checks.push([name, !!ok]);
  if (!ok) throw new Error(`FAILED: ${name}`);
}

check('tools = 3', world.tools().length === 3);
check('env prompt vars', Object.keys(world.envPromptVars()).length >= 6);
check('webUi panels', world.webUi().panels?.[0]?.id === 'stroll');
check('webUi invoke', typeof world.webUi().invoke === 'function');
check('policy caps', world.policy.snapshot().caps.like > 0);

const history = JSON.parse(await world.toolStroll({ action: 'history' }));
check('history ok', history.ok === true);

const draft = JSON.parse(await world.toolAct({ action: 'like', platform: 'bilibili', target: 'BV1SVsd6MEGZ', preview: true }));
check('draft created', draft.ok === true && draft.draft === true && !!draft.id);
check('draft pending', world.store.pendingDrafts().length === 1);
check('model cannot approve', JSON.parse(await world.toolAct({ action: 'approve', draft_id: draft.id })).ok === false);
const rejected = world.rejectDraft(draft.id);
check('reject', rejected.ok === true);

const policy = JSON.parse(await world.toolPolicy({ action: 'set', patch: { dailyLikes: 4, ownerUid: '123456' } }));
check('policy set', policy.ok === true && cfg.dailyLikes === 4 && cfg.ownerUid === '123456');

console.log(checks.map(([n, ok]) => `${ok ? 'ok' : 'NO'}  ${n}`).join('\n'));
console.log(`\n${checks.length} checks passed`);
fs.rmSync(tmp, { recursive: true, force: true });
