#!/usr/bin/env node
/**
 * 发布前检查。
 *
 * npm 不允许覆盖已发布的版本号，所以每次发布都必须先升 version。
 * 这个脚本只做检查、不改任何文件，跑完按提示补上缺的部分再发。
 */
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = String(pkg.version ?? '');
const rows = [];
const add = (level, text, hint) => rows.push({ level, text, hint });

const bump = (v) => {
  const [a, b, c] = v.split('.').map(Number);
  if ([a, b, c].some((n) => !Number.isFinite(n))) return null;
  return { patch: `${a}.${b}.${c + 1}`, minor: `${a}.${b + 1}.0`, major: `${a + 1}.0.0` };
};

/* 1. 版本号本身 */
if (!/^\d+\.\d+\.\d+$/.test(version)) add('bad', `version 不是 x.y.z：${version}`);
else add('ok', `当前版本 ${pkg.name}@${version}`);

/* 2. CHANGELOG 必须有这一版，市场按 "## 版本号" 切分更新日志 */
const changelog = path.join(root, 'CHANGELOG.md');
if (!existsSync(changelog)) {
  add('bad', '缺 CHANGELOG.md', '市场详情页的更新日志就是从这里读的');
} else {
  const text = readFileSync(changelog, 'utf8');
  const re = new RegExp(`^##\\s+v?${version.replace(/\./g, '\\.')}\\s*$`, 'm');
  add(re.test(text) ? 'ok' : 'bad', re.test(text) ? `CHANGELOG 有「## ${version}」` : `CHANGELOG 缺「## ${version}」段落`, re.test(text) ? '' : `在文件最上方加一段 "## ${version}" 再写几条改动`);
}

/* 3. cortico.describe 指向的文件要在包里 */
const describe = pkg.cortico?.describe;
if (typeof describe !== 'string') add('bad', 'package.json 缺 cortico.describe', '跑 npm run describe 生成');
else if (!existsSync(path.join(root, describe))) add('bad', `cortico.describe 指向的 ${describe} 不存在`, '跑 npm run describe 生成');
else add('ok', `describe.json 存在（${describe}）`);

/* 4. 工作区要干净，否则推上去的和发出去的可能不是同一份 */
try {
  const dirty = execSync('git status --porcelain', { cwd: root, encoding: 'utf8' }).trim();
  if (dirty) {
    const lines = dirty.split('\n');
    add('warn', `工作区有 ${lines.length} 处未提交改动`, lines.slice(0, 6).map((l) => `  ${l}`).join('\n'));
  } else {
    add('ok', '工作区干净，已提交的部分就是要发的内容');
  }
} catch {
  add('warn', '没有 git 仓库，跳过工作区检查');
}

/* 5. 这个版本号在 npm 上是否已经被占用 */
try {
  const out = execSync(`npm view ${pkg.name}@${version} version`, {
    cwd: root,
    encoding: 'utf8',
    timeout: 25000,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  if (out) add('bad', `npm 上已经有 ${pkg.name}@${version}`, '必须升版本号，npm 不允许覆盖已发布版本');
} catch {
  add('ok', `npm 上还没有 ${version}，可以发布`);
}

/* 输出 */
const mark = { ok: '  ✓', warn: '  !', bad: '  ✗' };
console.log(`\n发布前检查：${pkg.name}@${version}\n`);
for (const r of rows) {
  console.log(`${mark[r.level]} ${r.text}`);
  if (r.hint) for (const line of r.hint.split('\n')) console.log(`      ${line}`);
}

const blocking = rows.filter((r) => r.level === 'bad');
const next = bump(version);
console.log('');
if (blocking.length) {
  console.log(`${blocking.length} 处必须先修，修好再跑一次这个脚本。\n`);
  process.exit(1);
}
console.log('检查通过。接着做：');
console.log('  1. git add -A && git commit -m "..." && git push');
console.log('  2. npm publish');
if (next) {
  console.log('');
  console.log(`下次版本号参考：修 bug → ${next.patch}，加功能 → ${next.minor}，不兼容改动 → ${next.major}`);
}
console.log('');
