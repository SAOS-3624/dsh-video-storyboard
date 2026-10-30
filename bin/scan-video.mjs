#!/usr/bin/env node
/**
 * scan-video — 对任意视频跑一遍探测 + HSV 镜头切分，打印切点与分数。
 *
 *   node bin/scan-video.mjs <video> [cells]
 *
 * 用途：调阈值。先看 cuts 与 top peaks，再决定 threshold 要不要动。
 */
import { probeVideo } from '../src/storyboard/probe.js';
import { scanShots } from '../src/storyboard/scan.js';
import { fitSegments, segmentsFromCuts, totalDur } from '../src/storyboard/segments.js';

const [, , input, cellsArg] = process.argv;
if (!input) {
  console.error('usage: node bin/scan-video.mjs <video> [cells]');
  process.exit(2);
}
const cells = Number(cellsArg) || 9;

const info = await probeVideo(input);
console.log(`[probe] ${info.width}x${info.height} ${info.fps.toFixed(2)}fps ${info.duration.toFixed(2)}s` +
  `${info.rotation ? ` rotation=${info.rotation}` : ''}${info.hasAudio ? ' audio' : ''}${info.hasSubtitle ? ' subtitle' : ''}`);

const t0 = Date.now();
const { cuts, stats, frames, threshold } = await scanShots({ input, fps: info.fps });
const ms = Date.now() - t0;

console.log(`[scan] ${frames} frames, ${cuts.length} cuts (threshold ${threshold}), ${ms}ms (${(info.duration / (ms / 1000)).toFixed(1)}x realtime)`);
for (const c of cuts) console.log(`  ${c.t.toFixed(2)}s  score=${c.score.toFixed(1)}`);

const segs = segmentsFromCuts(info.duration, cuts.map((c) => c.t));
console.log(`[segments] ${segs.length} 段  总长 ${totalDur(segs).toFixed(2)}s`);
const fitted = fitSegments(segs, cells);
console.log(`[fitted] 调到 ${fitted.length} 段（目标 ${cells}）`);
for (const [a, b] of fitted) console.log(`  ${a.toFixed(2)}–${b.toFixed(2)}  (${(b - a).toFixed(2)}s)`);

const top = [...stats].sort((a, b) => b.score - a.score).slice(0, 5);
console.log('[top peaks] ' + top.map((s) => `${s.t.toFixed(2)}s:${s.score.toFixed(0)}`).join('  '));
