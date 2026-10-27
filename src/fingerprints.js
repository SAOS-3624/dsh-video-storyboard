/**
 * fingerprints.js — 轻量感知哈希（aHash），供规划阶段做视觉新颖性。
 * 不引入图像库：ffmpeg 取 8×8 rgb24 → 灰度均值哈希（64 bit）。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { DEFAULT_FFMPEG } from './probe.js';

const run = promisify(execFile);
export const FP_W = 8;
export const FP_H = 8;
export const FP_BYTES = FP_W * FP_H * 3;

/** RGB → 64-bit aHash（BigInt）。全黑/失败返回 0n。 */
export function averageHash(rgb, width = FP_W, height = FP_H) {
  if (!rgb || rgb.length < width * height * 3) return 0n;
  const grays = new Float64Array(width * height);
  let sum = 0;
  for (let i = 0, p = 0; i < grays.length; i++, p += 3) {
    const g = 0.299 * rgb[p] + 0.587 * rgb[p + 1] + 0.114 * rgb[p + 2];
    grays[i] = g;
    sum += g;
  }
  const mean = sum / grays.length;
  let bits = 0n;
  for (let i = 0; i < grays.length; i++) {
    if (grays[i] >= mean) bits |= 1n << BigInt(i);
  }
  return bits;
}

export function hamming64(a, b) {
  let x = (typeof a === 'bigint' ? a : BigInt(a)) ^ (typeof b === 'bigint' ? b : BigInt(b));
  let n = 0;
  while (x) { n += Number(x & 1n); x >>= 1n; }
  return n;
}

/** 新颖性 0..1：汉明距离 / 64 */
export function noveltyFromHashes(hash, selectedHashes) {
  if (!selectedHashes?.length || hash === 0n) return 1;
  let min = 64;
  for (const h of selectedHashes) min = Math.min(min, hamming64(hash, h));
  return Math.min(1, min / 24); // ≥24 bit 差视为完全不同
}

export async function grabRgbFrame(input, at, {
  ffmpegPath = DEFAULT_FFMPEG, width = FP_W, height = FP_H,
} = {}) {
  const { stdout } = await run(ffmpegPath, [
    '-hide_banner', '-v', 'error', '-nostdin',
    '-ss', String(Math.max(0, at)), '-i', input,
    '-frames:v', '1',
    '-vf', `scale=${width}:${height}:flags=area,format=rgb24`,
    '-f', 'rawvideo', '-',
  ], { encoding: 'buffer', maxBuffer: 1 * 1024 * 1024 });
  return Buffer.from(stdout);
}

/**
 * 在若干时刻采样 aHash。失败的时刻跳过（fail-open）。
 * @returns {Promise<Array<{t:number, hash:string}>>}  hash 为 hex
 */
export async function sampleFingerprints(input, times, {
  ffmpegPath = DEFAULT_FFMPEG, concurrency = 2, max = 48,
} = {}) {
  const uniq = [...new Set(
    (times ?? []).map((t) => +Number(t).toFixed(2)).filter((t) => Number.isFinite(t) && t >= 0),
  )].sort((a, b) => a - b).slice(0, max);

  const out = [];
  for (let i = 0; i < uniq.length; i += concurrency) {
    const batch = uniq.slice(i, i + concurrency);
    const parts = await Promise.all(batch.map(async (t) => {
      try {
        const rgb = await grabRgbFrame(input, t, { ffmpegPath });
        if (rgb.length < FP_BYTES) return null;
        const hash = averageHash(rgb);
        return { t, hash: hash.toString(16).padStart(16, '0') };
      } catch {
        return null;
      }
    }));
    for (const p of parts) if (p) out.push(p);
  }
  return out;
}

export function parseHash(hex) {
  try { return BigInt(`0x${hex}`); } catch { return 0n; }
}

/** 把 fingerprints 挂到候选上（相对窗口时间） */
export function attachFingerprints(candidates, fingerprints, winStart = 0) {
  if (!fingerprints?.length) return candidates;
  const fps = fingerprints.map((f) => ({ t: f.t - winStart, hash: parseHash(f.hash) }));
  return candidates.map((c) => {
    let best = null;
    let bestD = Infinity;
    for (const f of fps) {
      const d = Math.abs(f.t - c.t);
      if (d < bestD) { bestD = d; best = f; }
    }
    if (best && bestD <= 0.75) return { ...c, hash: best.hash };
    return c;
  });
}
