/**
 * verify-image-tokens.mjs — 拿**宿主自己的计费实现**给我方的 `imageTokens()` 打分。
 *
 * 为什么要有这个脚本：官方文档只说"小于 544² 放大、更大的缩到约 1300²、封顶 1024"，
 * 没给换算公式。而宿主 `@deepseek-ai/dsh-llm-deepseek` 里有一份精确实现
 * （14px patch 对齐 → 42px 一格 → `rows×(cols+1)+2`），我们照抄了它。
 * 照抄的东西必须能对拍，否则宿主升级一次（v41 → v42…）我们就开始报假数。
 *
 *   node scripts/verify-image-tokens.mjs          # 对拍，不一致就 exit 1
 *   DSH_TOOLS_PATH=... node ...                  # 指定宿主包根目录（默认扫 npx 缓存）
 *
 * 找不到宿主包时**不算失败**（CI 里没有 DSH），打印一行说明就退出。
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { imageTokens } from '../src/storyboard/tiers.js';

/** 默认画布、几档常用尺寸、地板附近、封顶附近、以及极端值 */
const SIZES = [
  [800, 450], [800, 469], [1066, 600], [1280, 720], [1300, 731], [1300, 1300],
  [320, 180], [400, 225], [544, 544], [640, 360], [600, 338], [733, 412],
  [1132, 636], [1600, 900], [1920, 1080], [2000, 2000], [5000, 5000],
  [100, 56], [133, 75], [200, 113], [266, 150], [480, 270], [1, 1],
];

/** 在 npx 缓存里找一份能用的 dsh-llm-deepseek（有 deepSeekImageTokens 导出的第一个）。 */
function findHostModules() {
  if (process.env.DSH_LLM_DEEPSEEK_PATH) return process.env.DSH_LLM_DEEPSEEK_PATH;
  const roots = [];
  if (process.env.DSH_TOOLS_PATH) roots.push(process.env.DSH_TOOLS_PATH);
  if (process.env.LOCALAPPDATA) {
    const npx = join(process.env.LOCALAPPDATA, 'npm-cache', '_npx');
    if (existsSync(npx)) {
      for (const dir of readdirSync(npx)) roots.push(join(npx, dir, 'node_modules', '@deepseek-ai'));
    }
  }
  for (const root of roots) {
    const candidate = join(root, 'dsh-llm-deepseek', 'lib', 'index.js');
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

const hostPath = findHostModules();
if (!hostPath) {
  console.log('[verify-image-tokens] 没找到宿主的 dsh-llm-deepseek，跳过（这不是失败）。');
  console.log('  想跑的话：DSH_LLM_DEEPSEEK_PATH=<...>/dsh-llm-deepseek/lib/index.js node scripts/verify-image-tokens.mjs');
  process.exit(0);
}

const host = await import(`file://${hostPath.replace(/\\/g, '/')}`);
if (typeof host.deepSeekImageTokens !== 'function') {
  console.log(`[verify-image-tokens] ${hostPath} 里没有 deepSeekImageTokens，宿主的实现变了 —— 去读一遍再照抄。`);
  process.exit(2);
}

let bad = 0;
for (const [w, h] of SIZES) {
  const mine = imageTokens(w, h);
  const theirs = host.deepSeekImageTokens(w, h);
  if (mine !== theirs) {
    bad += 1;
    console.log(`DIFF ${w}x${h}  我方=${mine}  宿主=${theirs}`);
  }
}
console.log(bad === 0
  ? `[verify-image-tokens] ${SIZES.length} 组尺寸与宿主完全一致 ✅`
  : `[verify-image-tokens] ${bad} 组不一致 ❌ —— 把 tiers.js 的 gridTokens/对齐规则重新对一遍`);
process.exit(bad === 0 ? 0 : 1);
