/**
 * packed-demo.mjs — 用打包排布拼一张真实分镜图（验证用，不进插件主链路）。
 *
 * 用法：node scripts/packed-demo.mjs [n] [budget]
 *   自造一段测试视频（ffmpeg testsrc2，自带帧号），按 pack.js 的排布取帧、拼图、烧编号。
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { bestPlan, toRects } from '../src/storyboard/pack.js';
import {
  BACKGROUND, blit, drawBadge, fillRect,
} from '../src/storyboard/sheet.js';
import { DEFAULT_FFMPEG } from '../src/storyboard/probe.js';

const FF = process.env.DSH_FFMPEG_PATH || DEFAULT_FFMPEG;
const OUT = join(process.cwd(), 'out-packed');
const CLIP = join(OUT, '_test.mp4');

const N = Number(process.argv[2] || 15);
const BUDGET = Number(process.argv[3] || 1_200_000);
const ASPECT = 16 / 9;

function ensureClip() {
  mkdirSync(OUT, { recursive: true });
  const r = spawnSync(FF, [
    '-hide_banner', '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25:duration=30',
    '-pix_fmt', 'yuv420p', CLIP,
  ], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`生成测试视频失败: ${r.stderr}`);
}

/** 只允许排进一张图的候选（bins === 1） */
function planOneSheet(n) {
  const plan = bestPlan(n);
  if (plan.bins === 1) return plan;
  // 退一步：全同档里挑能进一张、占用率最高的
  let best = null;
  for (let k = 2; k <= 8; k += 1) {
    const seq = new Array(n).fill(k);
    const p = bestPlan(n, { tiers: [k] });
    if (p.bins === 1 && (!best || p.fill > best.fill)) best = p;
  }
  return best ?? plan;
}

function main() {
  ensureClip();
  const plan = planOneSheet(N);
  const W = Math.round(Math.sqrt(BUDGET * ASPECT));
  const H = Math.round(W / ASPECT);
  const rects = toRects(plan.cells, { width: W, height: H });

  console.log(`n=${N}  seq=${plan.tag}  bins=${plan.bins}  占用率=${(plan.fill * 100).toFixed(2)}%`);
  console.log(`画布 ${W}×${H}，格子 ${rects.length} 个，尺寸分布 ${
    [...new Set(rects.map((r) => `${r.pw}×${r.ph}`))].join(' / ')}`);

  const buf = Buffer.alloc(W * H * 3);
  fillRect(buf, W, H, 0, 0, W, H, BACKGROUND);

  const t0 = Date.now();
  const dur = 30;
  rects.forEach((r, i) => {
    const at = (dur - 1) * ((i + 0.5) / rects.length);
    const { buffer } = extractFrameRawSync({ at, w: r.pw, h: r.ph });
    blit(buf, W, H, r.px, r.py, r.pw, r.ph, buffer);
    // 编号：右上角。右边如果有空位（本行没填满）就放到空位里，不压画面
    const rightGap = (W - (r.px + r.pw));
    const sameRow = rects.filter((o) => Math.abs(o.py - r.py) < 2 && o.px > r.px);
    const gap = sameRow.length ? Math.min(...sameRow.map((o) => o.px)) - (r.px + r.pw) : rightGap;
    const badgeW = String(i + 1).length * 6 * Math.max(2, Math.round(r.ph * 0.18 / 7));
    if (gap >= badgeW + 6) {
      drawBadge(buf, W, H, r.px + r.pw + 4, r.py + 2, r.pw, r.ph, i + 1);
    } else {
      drawBadge(buf, W, H, r.px + r.pw - badgeW - 4, r.py + 2, r.pw, r.ph, i + 1);
    }
  });
  console.log(`取帧+拼图 ${Date.now() - t0}ms`);

  const png = encodePngBufferSync(buf, W, H);
  const out = join(OUT, `packed-${N}.png`);
  writeFileSync(out, png);
  console.log(`写出 ${out}`);
}

/** 同步取一帧 raw RGB（demo 用；插件里用 sheet.extractFrameRaw 的异步版） */
function extractFrameRawSync({ at, w, h }) {
  const r = spawnSync(FF, [
    '-hide_banner', '-v', 'error', '-nostdin', '-ss', String(at), '-i', CLIP,
    '-an', '-sn', '-vf', `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`,
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ], { maxBuffer: 1 << 28 });
  const need = w * h * 3;
  if (r.status !== 0 || r.stdout.length < need) {
    throw new Error(`取帧失败 @${at.toFixed(2)}s: ${r.stderr?.toString().slice(0, 200)}`);
  }
  return { buffer: Buffer.from(r.stdout.subarray(0, need)) };
}

function encodePngBufferSync(buf, w, h) {
  const r = spawnSync(FF, [
    '-hide_banner', '-v', 'error', '-y',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${w}x${h}`, '-i', '-',
    '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', '-',
  ], { input: buf, maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`PNG 编码失败: ${r.stderr?.toString().slice(0, 200)}`);
  return r.stdout;
}

main();
