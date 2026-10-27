/**
 * scan-sampled.js — 超长窗口抽样扫描。
 *
 * 全量解码 2h+ 片子成本过高：每 N 分钟只扫 sampleLen 秒，合并切点，标 degraded。
 * 短窗口仍走完整 scanShots。
 */

import { scanShots, scanSummary, suppressClose } from './scan.js';

export const SAMPLE_ABOVE_SEC = 3600;   // ≥1h 才抽样
export const SAMPLE_EVERY_SEC = 300;    // 每 5 分钟
export const SAMPLE_LEN_SEC = 30;       // 扫 30 秒

/**
 * 抽样窗口之间（及两端）未扫描的间隙，供模型知道「切点密度未知」。
 * @param {Array<{from:number,to:number}>} windows
 * @param {{from:number,to:number}} span
 */
export function uncoveredGaps(windows, span) {
  const lo = Number(span?.from) || 0;
  const hi = Number(span?.to);
  if (!(hi > lo)) return [];
  const sorted = [...(windows || [])]
    .filter((w) => w && w.to > w.from)
    .sort((a, b) => a.from - b.from);
  const gaps = [];
  let cursor = lo;
  for (const w of sorted) {
    const a = Math.max(lo, w.from);
    const b = Math.min(hi, w.to);
    if (b <= a) continue;
    if (a > cursor + 0.05) gaps.push({ from: +cursor.toFixed(2), to: +a.toFixed(2) });
    cursor = Math.max(cursor, b);
  }
  if (hi > cursor + 0.05) gaps.push({ from: +cursor.toFixed(2), to: +hi.toFixed(2) });
  return gaps;
}

/**
 * @returns {Promise<object>} 与 scanShots 同形，额外 degraded / sample 字段
 */
export async function scanShotsMaybeSampled(opts) {
  const {
    start = 0,
    end,
    sampleAbove = SAMPLE_ABOVE_SEC,
    sampleEvery = SAMPLE_EVERY_SEC,
    sampleLen = SAMPLE_LEN_SEC,
    ...rest
  } = opts;

  const winDur = (end !== undefined ? end : start + 1e9) - start;
  if (!(winDur > sampleAbove)) {
    return scanShots({ ...rest, start, end });
  }

  const cuts = [];
  const allScores = [];
  let frames = 0;
  let threshold = 12;
  let motionHint = null;
  const windows = [];
  const spanEnd = start + winDur;

  for (let t = start; t < spanEnd - 0.05; t += sampleEvery) {
    const a = t;
    const b = Math.min(spanEnd, t + sampleLen);
    if (b - a < 1) break;
    windows.push({ from: a, to: b });
    const part = await scanShots({ ...rest, start: a, end: b });
    frames += part.frames;
    threshold = part.threshold;
    if (part.degraded === 'motion' || part.degraded_kind === 'motion') {
      motionHint = part.motion ?? motionHint ?? true;
    }
    for (const c of part.cuts) cuts.push(c);
    for (const s of part.stats ?? []) allScores.push(s.score);
  }

  const gaps = uncoveredGaps(windows, { from: start, to: spanEnd });
  const covered = windows.reduce((n, w) => n + Math.max(0, w.to - w.from), 0);
  const merged = suppressClose(cuts, rest.minGap ?? 0.35);
  return {
    cuts: merged,
    stats: [],
    frames,
    threshold,
    summary: {
      ...scanSummary(allScores),
      // 抽样时帧数偏少，p90 仍反映「被扫到的段落」节奏
      sampled: true,
    },
    degraded: true,
    degraded_kind: motionHint ? 'sampled+motion' : 'sampled',
    ...(motionHint && motionHint !== true ? { motion: motionHint } : {}),
    sample: {
      every: sampleEvery,
      len: sampleLen,
      windows: windows.length,
      coverage_ratio: +Math.min(1, covered / winDur).toFixed(3),
      unscanned_gaps: gaps.slice(0, 24),
      unscanned_gap_count: gaps.length,
    },
  };
}
