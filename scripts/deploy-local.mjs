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
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
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

/**
 * 逐文件复制。不用 cpSync：Node 22 在 Windows 上遇到中文路径时，
 * cpSync 会让进程直接退出（exit 127、没有任何报错），
 * 而调用方刚把旧目录 rm 掉——安装目录就变成一个空壳。这个坑踩过一次。
 */
function copyTree(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(src, dst);
    else copyFileSync(src, dst);
  }
}

/** 整目录替换：先拷到旁边的临时目录，成功了再换上去，中途失败不会破坏已安装的版本。 */
const dirs = ['src', 'webui', 'docs', 'assets'];
const files = ['package.json', 'describe.json', 'README.md', 'DESIGN.md', 'NOTICE.md', 'CHANGELOG.md', 'LICENSE'];

for (const dir of dirs) {
  const from = path.join(root, dir);
  const to = path.join(target, dir);
  if (!existsSync(from)) continue;
  const tmp = path.join(path.dirname(to), `.${path.basename(to)}.tmp-${process.pid}`);
  rmSync(tmp, { recursive: true, force: true });
  try {
    copyTree(from, tmp);
    const want = readdirSync(from).length;
    const got = readdirSync(tmp).length;
    if (want !== got) throw new Error(`复制不完整：${want} → ${got}`);
    rmSync(to, { recursive: true, force: true });
    renameSync(tmp, to);
  } catch (error) {
    rmSync(tmp, { recursive: true, force: true });
    console.error(`\n同步 ${dir}/ 失败：${error.message}`);
    console.error('安装目录保持原样（没有删成空目录）。');
    process.exit(1);
  }
  console.log(`  目录  ${dir}/`);
}
for (const file of files) {
  const from = path.join(root, file);
  if (!existsSync(from)) continue;
  copyFileSync(from, path.join(target, file));
  console.log(`  文件  ${file}`);
}

console.log(`\n已同步到 ${target}`);
console.log(`版本 ${installed.version} → ${pkg.version}`);
console.log('\n接下来：完全退出 Coopanion 再打开，面板才会读到新版本。');
console.log('（宿主对前端资源做了 immutable 缓存，光刷新页面没用，必须重启进程。）\n');
