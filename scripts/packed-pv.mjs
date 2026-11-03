/**
 * packed-pv.mjs — 用真实 PV 关键帧拼一张打包分镜图（档位随机）。
 *
 * 用法：node scripts/packed-pv.mjs [n] [dir] [budget]
 *   默认 N=10，dir 取 $DSH_KEYFRAME_DIR 或相对路径 20.2_关键帧
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { solve, toRects } from '../src/storyboard/pack.js';
import {
  BACKGROUND, blit, drawBadge, drawBadgePlain, drawPadding, fillRect,
} from '../src/storyboard/sheet.js';

const FF = process.env.DSH_FFMPEG_PATH || 'ffmpeg';
const OUT = join(process.cwd(), 'out-packed');
const N = Number(process.argv[2] || 10);
const DIR = process.argv[3] || process.env.DSH_KEYFRAME_DIR || '20.2_关键帧';
const BUDGET = Number(process.argv[4] || 1_200_000);
const ASPECT = 16 / 9;

const rng = (seed) => {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
};

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(png|jpe?g)$/i.test(name)) out.push(full);
  }
  return out;
}

function pick(n, budget) {
  const files = walk(DIR).sort();
  if (files.length < n) throw new Error(`${DIR} 只有 ${files.length} 张图，不够 ${n}`);
  const step = files.length / n;
  return Array.from({ length: n }, (_, i) => files[Math.floor(i * step)]);
}

/** 随机档位 + 多次抽样取占用率最高的一次 */
function fixedPlan(n, k) { const plan = solve(new Array(n).fill(k)); return { best: { ...plan, tiers: new Array(n).fill(k) }, min: plan.fill, med: plan.fill, max: plan.fill }; }

function randomPlans(n, tries = 40) {
  const r = rng(20261101);
  let best = null;
  const fills = [];
  for (let t = 0; t < tries; t += 1) {
    const tiers = Array.from({ length: n }, () => 2 + Math.floor(r() * 7));
    const plan = solve(tiers);
    fills.push(plan.fill);
    if (!best || plan.fill > best.fill) best = { ...plan, tiers };
  }
  fills.sort((a, b) => a - b);
  return { best, min: fills[0], med: fills[tries >> 1], max: fills[tries - 1] };
}

function rawOf(file, w, h) {
  return new Promise((resolve, reject) => {
    const p = spawn(FF, [
      '-hide_banner', '-v', 'error', '-nostdin', '-i', file, '-an', '-sn',
      '-vf', `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`,
      '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
    ]);
    const chunks = [];
    let err = '';
    p.stdout.on('data', (c) => chunks.push(c));
    p.stderr.on('data', (c) => { err += c; });
    p.on('error', reject);
    p.on('close', (code) => {
      const out = Buffer.concat(chunks);
      const need = w * h * 3;
      if (code !== 0 || out.length < need) return reject(new Error(`取帧失败 ${file}: ${err.slice(0, 160)}`));
      resolve(Buffer.from(out.subarray(0, need)));
    });
  });
}

/** 并发池：同时跑 n 个任务 */
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

function encodePng(buf, w, h) {
  const r = spawnSync(FF, [
    '-hide_banner', '-v', 'error', '-y',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${w}x${h}`, '-i', '-',
    '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', '-',
  ], { input: buf, maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`PNG 编码失败: ${r.stderr?.toString().slice(0, 160)}`);
  return r.stdout;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const files = pick(N, BUDGET);
  const FIXED = Number(process.env.FIXED_TIER || 0);
  const LIST = process.env.TIER_LIST ? process.env.TIER_LIST.split(',').map(Number) : null;
  const { best, min, med, max } = LIST
    ? (() => { const p = solve(LIST); return { best: { ...p, tiers: LIST }, min: p.fill, med: p.fill, max: p.fill }; })()
    : FIXED ? fixedPlan(N, FIXED) : randomPlans(N);

  const W = Math.round(Math.sqrt(BUDGET * ASPECT));
  const H = Math.round(W / ASPECT);
  const rects = toRects(best.cells, { width: W, height: H });

  console.log(`N=${N}  档位=${best.tiers.join(',')}`);
  console.log(`bins=${best.bins}  占用率=${(best.fill * 100).toFixed(2)}%  `
    + `(40 次随机抽样: 最低 ${(min * 100).toFixed(1)}% / 中位 ${(med * 100).toFixed(1)}% / 最高 ${(max * 100).toFixed(1)}%)`);
  const sizes = [...new Set(rects.map((r) => `${r.pw}×${r.ph}`))].sort();
  console.log(`画布 ${W}×${H}  格子尺寸 ${sizes.join(' / ')}`);

  const buf = Buffer.alloc(W * H * 3);
  fillRect(buf, W, H, 0, 0, W, H, BACKGROUND);

  // 先把空位涂成灰底（本行没填满 / 箱底剩下）
  const gaps = [];
  const byY = new Map();
  rects.forEach((r) => {
    const k = r.py.toFixed(0);
    if (!byY.has(k)) byY.set(k, []);
    byY.get(k).push(r);
  });
  for (const [, rs] of byY) {
    const right = Math.max(...rs.map((r) => r.px + r.pw));
    const h = Math.max(...rs.map((r) => r.ph));
    if (right < W - 2) gaps.push({ x: right, y: rs[0].py, w: W - right, h });
  }
  gaps.forEach((g) => drawPadding(buf, W, H, g.x, g.y, g.w, g.h));

  const t0 = Date.now();
  const CONC = Number(process.env.FRAME_CONCURRENCY || 6);
  const frames = await pool(rects, CONC, (r, i) => rawOf(files[i], r.pw, r.ph));
  const tFetch = Date.now() - t0;

  // 编号字号：按画布宽定，保证缩到 1000px 宽也能看清
  const BSCALE = Number(process.env.BADGE_SCALE || 0) || Math.max(2, Math.min(6, Math.round(W / 450)));
  const pad = Math.max(3, Math.round(BSCALE * 1.2));
  const bw = (n) => String(n).length * (5 + 1) * BSCALE - BSCALE + pad * 2;
  const bh = 7 * BSCALE + pad * 2;

  // 是否被别的格子占住（用于判断"左上角外面"有没有空位）
  const free = (x, y, w, h) => {
    if (x < 0 || y < 0 || x + w > W || y + h > H) return false;
    for (const o of rects) {
      if (x < o.px + o.pw && o.px < x + w && y < o.py + o.ph && o.py < y + h) return false;
    }
    return true;
  };

  let plainCount = 0;
  rects.forEach((r, i) => {
    blit(buf, W, H, r.px, r.py, r.pw, r.ph, frames[i]);
    const n = i + 1;
    // 小格（档位 >= 6）不画黑底，只用描边数字 —— 保住 ID 又不压画面
    const style = process.env.BADGE_STYLE || 'plain';   // plain | box | small
    const plain = style === 'plain' || (style === 'small' && r.t >= 6);
    if (plain) plainCount += 1;
    const oy = r.py - bh - 1;
    const inGap = free(r.px, oy, bw(n), bh);
    const bx = inGap ? r.px : r.px + 1;
    const by = inGap ? oy : r.py + 1;
    if (plain) drawBadgePlain(buf, W, H, bx, by, n, BSCALE);
    else drawBadge(buf, W, H, bx, by, r.pw, r.ph, n, null, BSCALE);
  });
  console.log(`取帧 ${tFetch}ms（并发 ${CONC}）+ 拼图 ${Date.now() - t0 - tFetch}ms  无底描边编号 ${plainCount} 个`);

  const out = join(OUT, `pv-${N}${FIXED ? '-t' + FIXED : ''}${LIST ? '-L' : ''}${process.env.BADGE_SCALE ? '-b' + process.env.BADGE_SCALE : ''}.png`);
  writeFileSync(out, encodePng(buf, W, H));
  console.log(`写出 ${out}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
