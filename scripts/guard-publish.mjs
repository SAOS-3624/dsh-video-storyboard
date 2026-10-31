#!/usr/bin/env node
/**
 * guard-publish.mjs — `npm publish` 前的一道闸门。
 *
 * 为什么需要它：`npm pack/publish` 打包的是**磁盘上的工作区**，跟 git 提交完全无关。
 * 0.5.11 就是在这个误解下发的 —— 工作区里留着别人未提交的改动，一起被打进了包里。
 * 现在反过来：**只要工作区不干净，就拒绝发布**。想发就先 commit（或 stash）到干净状态，
 * 这样"发出去的"和"仓库里的"永远是同一份东西。
 *
 * 直接跑：`node scripts/guard-publish.mjs`（只看状态，不发包）。
 */
import { execFileSync } from 'node:child_process';

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

let dirty;
try {
  dirty = git(['status', '--porcelain']);
} catch (e) {
  console.error(`guard-publish: 读不到 git 状态（${e.message.split('\n')[0]}）—— 跳过检查`);
  process.exit(0);
}

if (dirty) {
  const lines = dirty.split('\n');
  const show = lines.slice(0, 12).map((l) => `  ${l}`).join('\n');
  console.error([
    '',
    '✗ 拒绝发布：工作区有未提交的改动。',
    '',
    '  npm publish 打包的是**磁盘文件**，不是 git 提交 —— 这些改动会被原样发出去。',
    `  当前 ${lines.length} 处：`,
    show,
    lines.length > 12 ? `  …（还有 ${lines.length - 12} 处）` : '',
    '',
    '  想发布：先 git add / git commit（或 git stash）到干净状态，再重跑。',
    '',
  ].filter(Boolean).join('\n'));
  process.exit(1);
}

console.log('guard-publish: 工作区干净，可以发布。');
