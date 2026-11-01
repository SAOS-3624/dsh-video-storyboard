/**
 * plan.js — **只保留窗口规划**（CLI 的 `--plan` 预览、`--batch` 分段）。
 *
 * 2026-11-01：这个文件原来还装着"格数建议 / 布局 / 可读性 / 音乐驱动判定"，
 * 那一整套被档位（tiers.js）与打包（pack.js）取代，已删除。
 * 现在它只回答一个问题：整片按 `step` 秒切，会切出几个窗口、每个窗口多少帧。
 */

import { fitCanvas, imageTokens } from './tiers.js';

/**
 * 默认画布（16:9 + 默认预算 = 800×450）上一张图的价格，只给 `--plan` 的粗估用。
 * 真正出图时每张按自己的尺寸算（`imageTokens`），别把这个数当常量用。
 */
export const PLAN_IMAGE_TOKENS = imageTokens(fitCanvas(16 / 9).width, fitCanvas(16 / 9).height);

/** 时长 → 常见格数（历史遗留的粗估，只给 `--plan` 预览用）。 */
export function snapCells(n) {
  const SNAP = [4, 6, 9, 12, 16];
  const v = Math.max(1, Math.round(Number(n) || 1));
  return SNAP.reduce((best, x) => (Math.abs(x - v) < Math.abs(best - v) ? x : best), SNAP[0]);
}

export function planWindows(duration, step = 300, {
  cells, maxWindows = 12, boundaries = [], snapRatio = 0.2,
} = {}) {
  if (!(duration > 0)) throw new RangeError(`duration must be > 0, got ${duration}`);
  if (!(step > 0)) throw new RangeError(`step must be > 0, got ${step}`);
  // 段数超上限时不是"砍掉尾巴"，而是把每段拉长，保证覆盖全片
  let span = step;
  let total = Math.ceil(duration / span);
  let stepAdjusted = false;
  if (total > maxWindows) {
    span = duration / maxWindows;
    total = maxWindows;
    stepAdjusted = true;
  }
  total = Math.max(1, total);
  // 尾巴短于 30 秒就并进前一个窗口：92s 按 30s 切会剩一个 2.18s 的窗口，只够 1 格，
  // 白白多花一张图的钱（≈233）换一张几乎没信息的图。用绝对阈值（而不是按比例），
  // 这样 650s/300s 那种 50s 的尾巴不会被无谓地并掉。
  if (total > 1) {
    const tail = duration - (total - 1) * span;
    if (tail < 30) total -= 1;
  }
  const windows = [];
  for (let i = 0; i < total; i++) {
    const from = +(i * span).toFixed(2);
    // 最后一个窗口吸收剩下的全部（含被并掉的尾巴）
    const to = i === total - 1 ? +duration.toFixed(2) : +Math.min(duration, from + span).toFixed(2);
    const len = to - from;
    const n = cells ?? snapCells(Math.max(4, Math.round(len / 20)));
    const images = 1;
    windows.push({
      index: i + 1, from, to, duration: +len.toFixed(2),
      cells: n, images, approxTokens: images * PLAN_IMAGE_TOKENS,
    });
  }
  // 窗口边界吸附到最近的剪辑点：按钟表切会把一句话劈成两半，
  // 按内容切则每个窗口都是"几个完整镜头"。只吸附到 step×snapRatio 以内的点，
  // 太远就不动（否则窗口长度会失控）。
  let snapped = 0;
  if (boundaries.length > 0 && windows.length > 1) {
    const sorted = [...boundaries].filter((t) => t > 0 && t < duration).sort((a, b) => a - b);
    const limit = span * snapRatio;
    for (let i = 1; i < windows.length; i++) {
      const target = windows[i].from;
      let best = null;
      let bestD = limit;
      for (const t of sorted) {
        const d = Math.abs(t - target);
        if (d < bestD) { best = t; bestD = d; }
      }
      if (best === null) continue;
      const prevFrom = windows[i - 1].from;
      if (best - prevFrom < span * 0.3) continue;      // 别把窗口压得太短
      windows[i].from = +best.toFixed(2);
      windows[i - 1].to = +best.toFixed(2);
      windows[i].duration = +(windows[i].to - windows[i].from).toFixed(2);
      windows[i - 1].duration = +(windows[i - 1].to - windows[i - 1].from).toFixed(2);
      snapped += 1;
    }
  }

  return {
    total,
    snapped,
    step: +span.toFixed(2),
    requestedStep: step,
    stepAdjusted,
    covered: +windows.reduce((sum, w) => sum + w.duration, 0).toFixed(2),
    windows,
    approxTokens: windows.reduce((sum, w) => sum + w.approxTokens, 0),
  };
}
