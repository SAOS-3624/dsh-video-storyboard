/**
 * cuts.js — 切点链路的**唯一**编排点。
 *
 * 为什么单独一个文件：从 `scanShots` 的原始输出到"带标签的最终切点"之间有五个阶段，
 * 其中**前三个都拿 `cuts.length` 做准入判断**。它们必须按固定顺序跑，而这个顺序
 * 在代码里是隐式的 —— 谁把新阶段插错位置，就会悄悄抬高后面阶段的门槛。
 *
 * 2026-11-03 实测代价：把"abs 尖峰补刀"夹在 `scanShots` 内部合并，SHOT 27 段掉 3.2 个点
 * （一段的极静路径被整条跳过，一段的细扫结果被丢弃）。挪到链路末尾后回到 −0.3。
 *
 * 阶段表（顺序不可变）：
 *
 *   ┌ 0. 粗扫           scanShots 已给出 cuts（本文件不管）
 *   ├ 1. 极静素材补刀   perSec < 0.1 才进；会**替换**整个 cuts
 *   ├ 2. 爆点细扫       fine.length > coarse.length 才采纳；会**整窗替换**
 *   ├ 3. 丐中丐合并     cuts+1 > 56 才触发；**逐轮加大间隔**直到装得下
 *   └ 4. 打标签         只加 type/evidence，**不增不删**
 *
 * **新增"加刀"或"删刀"的阶段，只能排在 3 之后、4 之前。**
 * 排在 1~3 之前会抬高它们的门槛；排在 4 之后会丢掉类型标签。
 */

import {
  refineCutsByWindow, spikeCuts, suppressClose,
} from './scan.js';
import { tagCuts } from './flash.js';
import { STRATEGIES } from './tiers.js';

/** 极静素材的入口密度：低于这个值才认为"这段几乎不动"（PPT / 代码录屏 / 固定机位） */
export const STILL_PER_SEC = 0.1;
/** 极静素材补刀的分数地板：abs 口径 4 分够用，mc 口径必须高得多（刻度是占比） */
export const STILL_MIN_ABS = { abs: 4, mc: 25 };
/** 一屏最多几格（1/8 档 8×8=64，留余量取 56 —— 格子会浮动到 1/7，那时只有 49 格） */
export const ONE_SHEET_CAP = 56;

/**
 * 极静素材补刀该不该采纳。
 *
 * 这道门是 0.6.x 修的：早先只看"补出了更多刀就用"，结果 BBC 第一集 503 刀被换成
 * 8792 刀（精度掉到 6%）。现在要求两条同时成立：
 *   ① 确实补出了更多刀；
 *   ② 补刀后的密度仍在"静态素材"该有的范围内（≤0.3 刀/秒）——
 *      入口已经认定这是 PPT/代码录屏，它不可能每秒换 3 次画面。
 * 再加一条新颖度：补出来的刀里要有相当一部分**离任何粗扫刀都远**（>2s），
 * 否则是"同一刀的重复检测"，没有意义。
 */
export function shouldTakeSpikes({
  coarse = 0, spikes = 0, winDur = 0, spikeTimes = null, coarseTimes = null,
  novelGap = 2.0, minNovel = 0.4,
} = {}) {
  if (!(spikes > coarse)) return false;
  if (spikes / Math.max(1e-6, winDur) > 0.3) return false;
  if (Array.isArray(spikeTimes) && Array.isArray(coarseTimes) && spikeTimes.length >= 4) {
    let novel = 0;
    for (const t of spikeTimes) {
      let near = false;
      for (const c of coarseTimes) {
        if (Math.abs(t - c) <= novelGap) { near = true; break; }
      }
      if (!near) novel += 1;
    }
    if (novel / spikeTimes.length < minNovel) return false;
  }
  return true;
}

/**
 * 跑完整条切点链路。
 *
 * @param {object} o
 * @param {object} o.scan           `scanShots()` 的返回值
 * @param {string} o.scanMode       'mc' | 'abs'（决定极静补刀的分数地板）
 * @param {number} o.capGap         扫描期最小间隔（0 = 不合并）
 * @param {string} o.strategy       档位名（丐中丐要读 fitOneSheet）
 * @param {boolean} o.refineBursts  是否跑爆点细扫
 * @param {boolean} o.textOnly      纯文本模式：跳过所有图像相关的阶段
 * @param {boolean} o.precomputed   复用已有扫描结果：**原样返回**，一个阶段都不跑
 * @param {number} o.fps
 * @param {number} o.winStart       窗口起点（秒）
 * @param {number} o.winDur         窗口长度（秒）
 * @param {Array}  [o.prints]       逐帧指纹（打标签用）
 * @param {Array}  [o.means]        逐帧亮度均值（打标签用）
 * @returns {{cuts: Array, refinedBursts: Array, trace: string[]}}
 */
export function resolveCuts({
  scan, scanMode = 'mc', capGap = 0, strategy, refineBursts = true,
  textOnly = false, precomputed = null, fps, winStart, winDur,
  prints = null, means = null,
}) {
  const trace = [];
  let cuts = scan.cuts ?? [];
  // 复用缓存时不做任何变换：那些阶段跑过一次了，重跑只会因为 stats 缺失而行为不同
  if (precomputed) return { cuts, refinedBursts: [], trace };

  // ---- 1. 极静素材补刀：绝对阈值会漏掉"只改了几个像素"的翻页
  if ((scan.stats?.length ?? 0) > 20) {
    const perSec = cuts.length / Math.max(1, winDur);
    if (perSec < STILL_PER_SEC) {
      const minAbs = STILL_MIN_ABS[scanMode] ?? STILL_MIN_ABS.abs;
      const spikes = suppressClose(spikeCuts(scan.stats, { k: 4, minAbs, halfWindow: 12 }), capGap);
      if (shouldTakeSpikes({
        coarse: cuts.length, spikes: spikes.length, winDur,
        spikeTimes: spikes.map((c) => c.t), coarseTimes: cuts.map((c) => c.t),
      })) {
        trace.push(`still:${cuts.length}->${spikes.length}`);
        cuts = spikes;
      }
    }
  }

  // ---- 2. 爆点细扫：粗扫看不见 0.35s 以下的刀
  let refinedBursts = [];
  if (refineBursts && !textOnly) {
    const r = refineCutsByWindow({
      stats: scan.stats, coarseCuts: cuts, fps, winStart, winDur,
      coarseThreshold: scan.threshold ?? 0,
    });
    cuts = r.cuts;
    refinedBursts = r.refined;
    for (const x of r.refined) trace.push(`refine:${x.from}-${x.to}s ${x.coarse}->${x.fine}`);
  }

  // ---- 3. 丐中丐档：自适应加大最小间隔，直到整段能装进一张图
  if (STRATEGIES[strategy]?.fitOneSheet && cuts.length + 1 > ONE_SHEET_CAP) {
    let gap = capGap > 0 ? capGap : 0.2;
    let fitted = suppressClose(cuts, gap);
    let rounds = 0;
    while (fitted.length + 1 > ONE_SHEET_CAP && gap < 120 && rounds < 60) {
      gap *= 1.3;
      fitted = suppressClose(cuts, gap);
      rounds += 1;
    }
    if (fitted.length < cuts.length) {
      trace.push(`merge:${cuts.length}->${fitted.length}@${gap.toFixed(1)}s`);
      cuts = fitted;
    }
  }

  // ---- 4. 打标签：**一个都不删**（删掉误检会让这段在插件眼里变成"完全静止"）
  if (!textOnly && Array.isArray(prints) && prints.length) {
    cuts = tagCuts(cuts, {
      prints, means, fps, scores: scan.stats?.map((s) => s.score),
    });
  }

  return { cuts, refinedBursts, trace };
}
