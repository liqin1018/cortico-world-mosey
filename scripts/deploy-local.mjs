#!/usr/bin/env node
/**
 * 把当前源码同步到本机已安装的插件目录，然后提示重启 Coopanion。
 *
 * 用法：
 *   node scripts/deploy-local.mjs
 *   node scripts/deploy-local.mjs "F:/Coopanion/data/local-extensions/cortico-world-mosey"
 *   set CORTICO_LOCAL_EXT=F:/...\cortico-world-mosey && node scripts/deploy-local.mjs
 *
 * 只覆盖源码和资源，不动 node_modules，所以 playwright-core 这类依赖不会丢。
 */
import { cpSync, existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

const target =
  process.argv[2] ||
  process.env.CORTICO_LOCAL_EXT ||
  'F:/Coopanion/data/local-extensions/cortico-world-mosey';

if (!existsSync(target)) {
  console.error(`\n找不到安装目录：${target}`);
  console.error('用法：node scripts/deploy-local.mjs "<插件安装目录>"\n');
  process.exit(1);
}

const installed = JSON.parse(readFileSync(path.join(target, 'package.json'), 'utf8'));
if (installed.name !== pkg.name) {
  console.error(`\n目录里的包是 ${installed.name}，和当前项目 ${pkg.name} 不一致，拒绝覆盖。\n`);
  process.exit(1);
}

/** 整目录替换的，先删再拷，避免残留已删除的旧文件。 */
const dirs = ['src', 'webui', 'docs', 'assets'];
const files = ['package.json', 'describe.json', 'README.md', 'DESIGN.md', 'NOTICE.md', 'CHANGELOG.md', 'LICENSE'];

for (const dir of dirs) {
  const from = path.join(root, dir);
  const to = path.join(target, dir);
  if (!existsSync(from)) continue;
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true });
  console.log(`  目录  ${dir}/`);
}
for (const file of files) {
  const from = path.join(root, file);
  if (!existsSync(from)) continue;
  cpSync(from, path.join(target, file));
  console.log(`  文件  ${file}`);
}

console.log(`\n已同步到 ${target}`);
console.log(`版本 ${installed.version} → ${pkg.version}`);
console.log('\n接下来：完全退出 Coopanion 再打开，面板才会读到新版本。');
console.log('（宿主对前端资源做了 immutable 缓存，光刷新页面没用，必须重启进程。）\n');
