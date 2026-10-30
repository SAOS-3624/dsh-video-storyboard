#!/usr/bin/env node
/**
 * scan-stats — 分数分布与阈值扫描。调阈值前先看这个，别靠猜。
 *
 *   node bin/scan-stats.mjs <video> [--step 2]
 *
 * 输出：分位数、各阈值下的切点数、切点间隔统计（判断是否有误检成簇）。
 */
import { args as parse } from './_args.mjs';
import { probeVideo } from '../src/storyboard/probe.js';
import { scanShots } from '../src/storyboard/scan.js';

const opt = parse(process.argv.slice(2), { step: 2 });
const input = opt._[0];
if (!input) {
  console.error('usage: node bin/scan-stats.mjs <video> [--step 2]');
  process.exit(2);
}

const info = await probeVideo(input);
const t0 = Date.now();
const { stats, frames } = await scanShots({ input, fps: info.fps, threshold: 999 });
const ms = Date.now() - t0;
const scores = stats.map((s) => s.score).sort((a, b) => a - b);
const q = (p) => scores[Math.min(scores.length - 1, Math.floor(scores.length * p))];

console.log(`[probe] ${info.width}x${info.height} ${info.fps.toFixed(2)}fps ${info.duration.toFixed(1)}s ` +
  `${info.hasAudio ? 'audio' : 'no-audio'}${info.hasSubtitle ? ' subtitle' : ''}`);
console.log(`[scan] ${frames} 帧 / ${ms}ms (${(info.duration / (ms / 1000)).toFixed(1)}x realtime)`);
console.log(`[分数] p50=${q(0.5).toFixed(1)} p90=${q(0.9).toFixed(1)} p95=${q(0.95).toFixed(1)} ` +
  `p99=${q(0.99).toFixed(1)} max=${scores.at(-1).toFixed(1)}`);
console.log('[阈值 → 切点数 → 平均间隔]');
const step = Math.max(1, Number(opt.step));
for (let th = 10; th <= 60; th += step) {
  const hits = stats.filter((s) => s.score >= th).map((s) => s.t);
  const gaps = hits.slice(1).map((t, i) => t - hits[i]);
  const minGap = gaps.length ? Math.min(...gaps) : NaN;
  const near = gaps.filter((g) => g < 1.0).length;
  console.log(`  ${String(th).padStart(3)}  → ${String(hits.length).padStart(4)} 个` +
    `  → 平均 ${hits.length > 1 ? (info.duration / hits.length).toFixed(1) : '—'}s/个` +
    `  → 最短间隔 ${Number.isFinite(minGap) ? minGap.toFixed(2) + 's' : '—'}` +
    `  → <1s 的密集簇 ${near} 处`);
}
