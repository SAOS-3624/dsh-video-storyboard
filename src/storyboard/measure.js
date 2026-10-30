/**
 * measure.js — **一张图到底会产生多少帧**，只算一次，切张和渲染共用这一个答案。
 *
 * 为什么要有这个文件（2026-10-30，Kimi 的 review 指出的真问题）：
 * 切张时用 `chooseSubGrid({ cellW: 250, cellH: 140 })` 估算每格 k，渲染时又用
 * `layoutCanvas()` 算出来的**真实** cellW/cellH 再算一次。子帧下限提到 200×112 之后，
 * 这两次必然给出不同答案：
 *
 *     切张：250×140 → 250/2=125 < 200 → k=1，认为这一格 1 帧
 *     渲染：505×312 → 252/2=156 ≥ 112，252 ≥ 200 → k=2，实际拼出 4 帧
 *
 * 于是 `planSheetsByFrames()` 名义上"按帧数切张"，实际按一套错的帧数在切；
 * 清单里报的 token/格数也跟着不可信。
 *
 * 这里把"测量"收成一个纯函数：给定一组时间段，返回真实布局、每格的 k、以及总帧数。
 * **切张和渲染都调它，渲染不再自己重新决定 k。**
 *
 * 它不取像素、不写盘 —— 只做算术，所以能单测。
 */

import { bestLayout } from './plan.js';
import { layoutCanvas } from './sheet.js';
import { BUSY_MOTION, TILE_MOTION, chooseSubGrid } from './frames.js';

/**
 * 一格里"有几个分段"和"刀够不够狠"—— 决定 k 的内容侧输入。
 * 抽出来是为了让 measure 与渲染用的是同一份判断（以前这段在两处各写一遍）。
 */
/**
 * 子帧像素下限：默认要"能认出字"，音乐驱动的快剪素材回到"能分辨镜头"。
 *
 * `160×90` 的问题（2026-10-30 实测）：3×3 的格子 331×184 摊 3×3 得 **110×61**，
 * 被 160 挡在门外，于是"24 秒、8 个镜头"的格子只给到 4 帧 —— 用户原话"1 和 2 之间漏了特别多"。
 * 而 160×90 本来就是照着"让 3×3 摊 2×2 得 165×92 刚好过线"倒推的，不是从判据推的。
 *
 * 110 是旧版实测的"能分辨不同镜头"下限（原注释写作 110×61），高度沿用旧版 56：
 *   3×3 的 331×184 摊 3×3 得 110×61 → 9 帧/格
 *   4×4 的 247×137 摊 2×2 得 123×68 → 4 帧/格
 * 风险不由像素下限管：`cutScore ≥ 30`（线稿/UI 的假刀）和 `minShots ≥ 3` 已经在挡"摊出来 9 张一样"。
 */
export function subFloorFor(musicDriven) {
  return musicDriven
    ? { minSubW: 110, minSubH: 56 }
    : { minSubW: 200, minSubH: 112 };
}

function cellSignals(range, { cuts, sampleMarks, stats }) {
  const cutList = cuts.filter((c) => c.t >= range.from && c.t < range.to);
  const marks = sampleMarks.filter((t) => t >= range.from && t < range.to);
  const cutScore = cutList.length
    ? cutList.reduce((n, c) => n + (c.score ?? 0), 0) / cutList.length
    : Infinity;
  const cellStats = stats.filter((x) => x.t >= range.from && x.t < range.to);
  const meanMotion = cellStats.length
    ? cellStats.reduce((n, x) => n + x.score, 0) / cellStats.length
    : 0;
  return { cutList, marks, cutScore, meanMotion };
}

/**
 * 按「刀/秒」从高到低分配子帧预算，不够就降档。
 *
 * 这一步是"预算削减"，不是"重新决策"：k 的**愿望值**由 chooseSubGrid 定，
 * 这里只在整张图的总帧预算（subBudget）不够时往下降。放在 measure 里是因为
 * 它直接决定"实际会产生多少帧"—— 切张要用这个数，渲染也必须用同一个结果。
 */
function shrinkToBudget(cells, subBudget) {
  let left = subBudget;
  for (const c of [...cells].sort((x, y) => y.rate - x.rate)) {
    let s = c.want;
    while (s > 1 && s * s - 1 > left) s -= 1;
    if (s > 1) left -= s * s - 1;
    c.k = s;
  }
  return cells;
}

/**
 * 测一组时间段（= 一张图）。
 *
 * @param {Array<{from:number,to:number}>} ranges 这一张要放的格
 * @param {object} o
 * @param {number} o.aspect        源画面比例
 * @param {number} o.budget        整张图的像素预算（layoutCanvas 的口径）
 * @param {boolean} [o.audioStrip] 是否有音频条带（要扣 10% 预算）
 * @param {boolean} [o.musicDriven]
 * @param {number} [o.subBudget]   整张图最多摊出多少子帧（默认 48）
 * @param {Array} [o.cuts]         真切点（绝对时间）
 * @param {Array} [o.sampleMarks]  积分采样点（绝对时间）
 * @param {Array} [o.stats]        逐帧分数
 * @returns {{cols:number, rows:number, width:number, height:number, cellW:number, cellH:number,
 *            cells:Array<object>, frameCount:number}}
 */
export function measureGroup(ranges, {
  aspect = 16 / 9, budget = 640_000, audioStrip = false, musicDriven = false,
  subBudget = 48, cuts = [], sampleMarks = [], stats = [],
} = {}) {
  const n = Math.max(1, ranges.length);
  const { cols, rows } = bestLayout(n, aspect);
  // 有音频带时先扣掉条带占用的预算：layoutCanvas 与 composeSheet 必须用**同一个** budget，
  // 否则取帧尺寸和拼图尺寸不一致，图会变成斜条纹（踩过）
  const cellBudget = audioStrip ? Math.round(budget * 0.9) : budget;
  const { width, height, cellW, cellH } = layoutCanvas(cols, rows, aspect, cellBudget);

  const cells = ranges.map((range) => {
    const { cutList, marks, cutScore, meanMotion } = cellSignals(range, { cuts, sampleMarks, stats });
    const shots = cutList.length + 1 + marks.length;
    const want = chooseSubGrid({
      shots, cellW, cellH, dur: range.to - range.from, cutScore, meanMotion,
      // 音乐驱动：单镜头但有动静就摊（门槛 1.5 → 0.7）
      minMotion: musicDriven ? 0.7 : 1.5,
      // **子帧下限逐格判，不看整片类型**。
      // 200×112 是为"看重字"定的（口播、字幕、讲义）；110×56 是"能分辨不同镜头"。
      // 该用哪条，取决于**这一格的画面动得多不多**，而不是整部片子被判成什么：
      // 记管 MAD02 被节奏判据判成"说话型"（包络主导 2 Hz），于是整片走 200×112，
      // 4×4 的 247×137 摊 2×2 得 123×68 一格都摊不动 —— 可它单格运动值最高 22.79，
      // 165 个镜头只看到 32 个。整片一个标签定死全部格子，这种错一定会再犯。
      ...(meanMotion >= TILE_MOTION ? { minSubW: 110, minSubH: 56 } : subFloorFor(musicDriven)),
    });
    return {
      ...range,
      k: want,
      want,
      // 真切点个数（不含积分采样点）：清单里 `cuts:` 报的是这个，别混
      cellCuts: cutList.length,
      // 本格的分段边界（真切点 + 积分采样点），摊开时用它决定每个子帧落在哪一段里
      cutTimes: [...cutList.map((c) => c.t), ...marks].sort((x, y) => x - y),
      rate: shots / Math.max(0.1, range.to - range.from),
      // 段内逐帧分数的均值（画面"有多热闹"）：静止约 0.2、匀速摇镜 1.5~3、快剪 5+。
      // 和"镜头数"是两个维度：快剪 8 个镜头和慢摇 8 个镜头，前者该摊细、后者该留大图。
      meanMotion: +meanMotion.toFixed(2),
    };
  });
  shrinkToBudget(cells, subBudget);
  const frameCount = cells.reduce((sum, c) => sum + c.k * c.k, 0);
  return { cols, rows, width, height, cellW, cellH, cellBudget, cells, frameCount };
}
