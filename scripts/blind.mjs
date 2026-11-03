/**
 * blind.mjs — 编号盲测：标签从固定池里随机取、随机分配，脚本**不打印答案**。
 * 用法：node scripts/blind.mjs <N> <scale> <seed>
 *   产出 out-packed/blind-<scale>.png 与 blind-<scale>.truth.json（答案，读图后再看）
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { solve, toRects } from '../src/storyboard/pack.js';
import { BACKGROUND, blit, drawBadge, drawBadgePlain, fillRect } from '../src/storyboard/sheet.js';

const FF = process.env.DSH_FFMPEG_PATH || 'ffmpeg';
const OUT = join(process.cwd(), 'out-packed');
const DIR = process.env.DSH_KEYFRAME_DIR || '20.2_关键帧';
const ASPECT = 16 / 9;

const N = Number(process.argv[2] || 16);
const SCALE = Number(process.argv[3] || 3);
const SEED = Number(process.argv[4] || 1);

const rng = (seed) => {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
};

function rawOf(file, w, h) {
  const r = spawnSync(FF, ['-hide_banner', '-v', 'error', '-nostdin', '-i', file, '-an', '-sn',
    '-vf', `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`,
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 28 });
  const need = w * h * 3;
  if (r.status !== 0 || r.stdout.length < need) throw new Error(`取帧失败 ${file}`);
  return Buffer.from(r.stdout.subarray(0, need));
}

function encodePng(buf, w, h) {
  const r = spawnSync(FF, ['-hide_banner', '-v', 'error', '-y',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${w}x${h}`, '-i', '-',
    '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', '-'], { input: buf, maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error('PNG 编码失败');
  return r.stdout;
}

function main() {
  mkdirSync(OUT, { recursive: true });
  const r = rng(SEED);
  // 标签池：13..99 里随机取 N 个不重复的
  const pool = [];
  while (pool.length < N) {
    const v = 13 + Math.floor(r() * 87);
    if (!pool.includes(v)) pool.push(v);
  }
  // 打乱分配（位置和数值无关）
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(r() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  const L = process.env.TIER_LIST ? process.env.TIER_LIST.split(',').map(Number) : new Array(N).fill(4);
  const plan = solve(L);
  const W = 1461, H = 822;
  const rects = toRects(plan.cells, { width: W, height: H });

  const pad = Math.max(2, Math.round(SCALE * 1.0));
  const bw = (n) => String(n).length * 6 * SCALE - SCALE + pad * 2;
  const bh = 7 * SCALE + pad * 2;
  const free = (x, y, w, h) => {
    if (x < 0 || y < 0 || x + w > W || y + h > H) return false;
    for (const o of rects) if (x < o.px + o.pw && o.px < x + w && y < o.py + o.ph && o.py < y + h) return false;
    return true;
  };

  const buf = Buffer.alloc(W * H * 3);
  fillRect(buf, W, H, 0, 0, W, H, BACKGROUND);
  const files = (() => {
    const out = [];
    const walk = (d) => {
      for (const n of readdirSync(d)) {
        const f = join(d, n);
        if (statSync(f).isDirectory()) walk(f);
        else if (/\.(png|jpe?g)$/i.test(n)) out.push(f);
      }
    };
    walk(DIR);
    return out.sort();
  })();

  rects.forEach((rc, i) => {
    const src = files[Math.floor((i * files.length) / rects.length)];
    blit(buf, W, H, rc.px, rc.py, rc.pw, rc.ph, rawOf(src, rc.pw, rc.ph));
    const label = pool[i];
    const oy = rc.py - bh - 1;
    const inGap = free(rc.px, oy, bw(label), bh);
    const bx = inGap ? rc.px : rc.px + 1;
    const by = inGap ? oy : rc.py + 1;
    if ((process.env.BADGE_STYLE || 'plain') === 'plain' || rc.t >= 6) drawBadgePlain(buf, W, H, bx, by, label, SCALE);
    else drawBadge(buf, W, H, bx, by, rc.pw, rc.ph, label, null, SCALE);
  });

  const tag = process.env.TIER_LIST ? 'mix' : 'flat';
  writeFileSync(join(OUT, `blind-${SCALE}${tag === 'mix' ? '-m' : ''}.png`), encodePng(buf, W, H));
  writeFileSync(join(OUT, `blind-${SCALE}${tag === 'mix' ? '-m' : ''}.truth.json`), JSON.stringify(pool));
  console.log(`已出图 blind-${SCALE}.png（${N} 格，scale=${SCALE}，答案另存，未打印）`);
}

main();
