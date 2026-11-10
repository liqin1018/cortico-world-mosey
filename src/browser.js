import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

/**
 * 找 playwright-core：先看环境变量（离线回归用），再直接 import，最后翻宿主的 extensions 目录。
 * 抖音和 B站抽帧都要用，所以才从 douyin.js 里抽出来——两边各写一份迟早会走偏。
 */
export async function loadPlaywright(dataDir) {
  if (process.env.STROLL_PLAYWRIGHT) return import(process.env.STROLL_PLAYWRIGHT);
  try {
    return await import('playwright-core');
  } catch {
    // 继续找宿主目录
  }
  const require = createRequire(import.meta.url);
  const extensions = path.join(dataDir, '..', '..', '..', 'extensions');
  const candidates = [extensions, process.cwd()];
  // pnpm 的依赖在 .pnpm 里，不一定 hoist 到 node_modules 根
  try {
    const pnpm = path.join(extensions, 'node_modules', '.pnpm');
    for (const name of fs.readdirSync(pnpm)) {
      if (name.startsWith('playwright-core@')) candidates.push(path.join(pnpm, name, 'node_modules'));
    }
  } catch {
    // 没有 .pnpm 就只试普通目录
  }
  for (const dir of candidates) {
    try {
      return require(require.resolve('playwright-core', { paths: [dir] }));
    } catch {
      // 换下一个
    }
  }
  throw new Error('找不到 playwright-core：在插件目录执行 corepack pnpm install，或在扩展目录重装依赖。');
}

/**
 * 后台无头浏览器。playwright-core 不自带内核，所以按 chrome → edge 的顺序借本机装好的，
 * 都没有才退回 Playwright 自带的。
 */
export async function launchHeadless(dataDir) {
  const mod = await loadPlaywright(dataDir);
  const chromium = mod.chromium ?? mod.default?.chromium;
  const options = { headless: true, args: ['--disable-blink-features=AutomationControlled'] };
  for (const channel of ['chrome', 'msedge']) {
    try {
      return await chromium.launch({ ...options, channel });
    } catch {
      // 试下一个渠道
    }
  }
  return await chromium.launch(options);
}
