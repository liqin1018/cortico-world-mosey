#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const appDir = 'F:/Coopanion';
const defaultTarget = path.resolve(appDir, 'data/local-extensions/cortico-world-mosey');
const target = path.resolve(process.argv[2] || process.env.CORTICO_LOCAL_EXT || defaultTarget);
const samePath = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
const manageApp = process.platform === 'win32' && samePath(target, defaultTarget);
const app = path.resolve(appDir, 'Coopanion.exe');
const names = ['src', 'webui', 'docs', 'assets', 'describe.json', 'README.md', 'DESIGN.md', 'NOTICE.md', 'CHANGELOG.md', 'LICENSE', 'package.json'];
const stat = (file) => lstatSync(file, { throwIfNoEntry: false });
const readPackage = (dir) => JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));

function copy(source, destination) {
  const info = lstatSync(source);
  if (info.isDirectory() && !info.isSymbolicLink()) {
    mkdirSync(destination);
    for (const name of readdirSync(source)) copy(path.join(source, name), path.join(destination, name));
  } else if (info.isFile()) {
    copyFileSync(source, destination);
  } else {
    throw new Error(`拒绝复制链接或特殊文件：${source}`);
  }
}

function running() {
  const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const count = execFileSync(powershell, [
    '-NoProfile', '-NonInteractive', '-Command', '@(Get-Process -Name Coopanion -ErrorAction SilentlyContinue).Count',
  ], { encoding: 'utf8', windowsHide: true, timeout: 10_000 }).trim();
  if (!/^\d+$/.test(count)) throw new Error('无法确认 Coopanion 进程状态。');
  return Number(count) > 0;
}

async function startApp() {
  const child = spawn(app, [], { cwd: appDir, detached: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('spawn', resolve);
  });
  child.unref();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await sleep(500);
    if (running()) return;
  }
  throw new Error('没有检测到 Coopanion 启动，请手动打开。');
}

async function deploy() {
  if (!stat(target)?.isDirectory() || !samePath(realpathSync(target), target) || samePath(path.resolve(root), target)) {
    throw new Error(`不是有效的独立插件安装目录：${target}`);
  }
  const installed = readPackage(target);
  const source = readPackage(root);
  if (source.name !== installed.name) throw new Error(`安装目录不是 ${source.name}，拒绝覆盖。`);
  if (manageApp && (!stat(app)?.isFile() || process.env.CORTICO_COMPANION_DATA || process.env.ELECTRON_RUN_AS_NODE)) {
    throw new Error('未检测到标准 Coopanion 启动环境，未部署。');
  }

  const stage = mkdtempSync(path.join(target, '.stroll-deploy-'));
  const backup = path.join(stage, 'backup');
  const replaced = [];
  let stopped = false;
  let keepBackup = false;
  try {
    mkdirSync(backup);
    const updates = names.filter((name) => stat(path.join(root, name)));
    for (const name of updates) copy(path.join(root, name), path.join(stage, name));

    if (manageApp && running()) {
      console.log('正在请 Coopanion 正常退出并保存状态…');
      execFileSync(app, ['--quit-for-installer'], { cwd: appDir, windowsHide: true, timeout: 15_000 });
      const deadline = Date.now() + 120_000;
      while (running()) {
        if (Date.now() >= deadline) throw new Error('Coopanion 未完全退出，未覆盖插件文件。');
        await sleep(750);
      }
      stopped = true;
    }

    for (const name of updates) {
      const dest = path.join(target, name);
      const previous = path.join(backup, name);
      const old = stat(dest);
      if (old && (old.isSymbolicLink() || !samePath(realpathSync(dest), dest))) throw new Error(`不能替换链接：${dest}`);
      if (old) renameSync(dest, previous);
      replaced.push({ name, old, installed: false });
      renameSync(path.join(stage, name), dest);
      replaced.at(-1).installed = true;
    }
    if (readPackage(target).version !== source.version) throw new Error('安装版本校验失败。');
    console.log(`已同步到 ${target}：${installed.version} → ${source.version}`);
  } catch (error) {
    try {
      for (const { name, old, installed: placed } of replaced.reverse()) {
        const dest = path.join(target, name);
        if (placed) renameSync(dest, path.join(stage, name));
        if (old) renameSync(path.join(backup, name), dest);
      }
    } catch (rollbackError) {
      keepBackup = true;
      throw new AggregateError([error, rollbackError], `部署失败且回滚未完成，备份已保留：${backup}`);
    }
    if (stopped) await startApp().catch((startError) => console.error(startError.message));
    throw error;
  } finally {
    if (!keepBackup && stat(stage) && samePath(realpathSync(stage), stage) && samePath(path.dirname(stage), target)) {
      try {
        rmSync(stage, { recursive: true, force: true });
      } catch (error) {
        console.warn(`临时目录未清理：${stage}（${error.message}）`);
      }
    }
  }

  if (manageApp) {
    await startApp();
    console.log('Coopanion 已重新打开。');
  } else {
    console.log('自定义目录已同步，未关闭或启动 Coopanion。');
  }
}

try {
  await deploy();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
