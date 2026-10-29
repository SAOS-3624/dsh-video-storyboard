/**
 * scan.js — HSV 加权镜头切分（PySceneDetect ContentDetector 思路的独立实现）。
 *
 * 为什么不用 `ffmpeg scdet`：它算的是 MAFD（亮度类），对"同亮度换色"失明。
 * 实测同一段测试片：scdet 默认阈值召回 4/9，本实现 9/9，零误检。
 *
 * 做法：ffmpeg 把画面缩到 64×36 rawvideo 喂进来（2304 像素/帧，解码量极小），
 * 逐像素转 HSV，与上一帧求三通道绝对差均值，得到 0–255 的分数。
 */

import { spawn } from 'node:child_process';

import { DEFAULT_FFMPEG } from './probe.js';
import { describeMediaSearch } from './binaries.js';

export const SCAN_W = 64;
export const SCAN_H = 36;
export const DEFAULT_THRESHOLD = 15;
export const HUE_WEIGHT = 1;
export const SAT_WEIGHT = 1;
export const VAL_WEIGHT = 1;

/** RGB(0-255) → HSV，各通道归一到 0-255（H 由角度缩放到 0-255） */
export function rgbToHsv(r, g, b) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [(h / 360) * 255, (max === 0 ? 0 : d / max) * 255, max * 255];
}

/**
 * 把整帧 RGB 缓冲转成 HSV 缓冲。out 可复用，避免每帧分配。
 * @param {Uint8Array|Buffer} rgb 长度 = pixels*3
 * @param {Float32Array} [out]    长度 = pixels*3
 */
export function frameToHsv(rgb, out = new Float32Array((rgb.length / 3) * 3)) {
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 3) {
    const rn = rgb[i] / 255;
    const gn = rgb[i + 1] / 255;
    const bn = rgb[i + 2] / 255;
    const max = rn > gn ? (rn > bn ? rn : bn) : gn > bn ? gn : bn;
    const min = rn < gn ? (rn < bn ? rn : bn) : gn < bn ? gn : bn;
    const d = max - min;
    let h = 0;
    if (d !== 0) {
      if (max === rn) h = ((gn - bn) / d) % 6;
      else if (max === gn) h = (bn - rn) / d + 2;
      else h = (rn - gn) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    out[j] = (h / 360) * 255;
    out[j + 1] = max === 0 ? 0 : (d / max) * 255;
    out[j + 2] = max * 255;
  }
  return out;
}

/** 两帧 HSV 的加权绝对差均值，0–255。全权重大于 1 时按权重和归一。 */
export function scorePair(prev, cur) {
  if (prev.length !== cur.length) throw new RangeError('frames must have the same length');
  let sum = 0;
  for (let i = 0; i < cur.length; i += 3) {
    // 色相是**环形**的：0° 和 359° 只差 1°，但直接相减会算成 359。
    // 不做这一步，红色渐变到品红（跨越 0°）会被判成一次巨大的"画面变化"，
    // 于是夜景霓虹、日落、色轮转场这些地方会凭空多出切点。
    const dh = Math.abs(cur[i] - prev[i]);
    const hueDiff = Math.min(dh, 255 - dh);
    // 低饱和像素的色相没有意义：近灰的色相会被编码噪声甩到色环另一端。
    // 实测 rgb(128,128,127) → rgb(128,127,128)（肉眼完全一样）色相差 85、整帧分数 28，
    // 而常用阈值只有 12–58 —— 于是"画面没变"被记成一次切镜。
    // 用两帧中较低的那个饱和度给色相项降权：灰的地方色相说了不算，亮色地方照常。
    const hueWeight = Math.min(cur[i + 1], prev[i + 1]) / 255;
    sum += hueDiff * hueWeight * HUE_WEIGHT
      + Math.abs(cur[i + 1] - prev[i + 1]) * SAT_WEIGHT
      + Math.abs(cur[i + 2] - prev[i + 2]) * VAL_WEIGHT;
  }
  const totalWeight = HUE_WEIGHT + SAT_WEIGHT + VAL_WEIGHT;
  return sum / ((cur.length / 3) * totalWeight);
}

/**
 * 按"相对本地基线"找切点：分数（= 相邻两帧的画面变化百分比）突然**比它附近的常态高很多**才算一刀。
 *
 * 为什么需要它：固定阈值对两种内容无解 ——
 *  - PPT/网课：平时变化 0.6，换页瞬间 40。固定阈值 15 能抓到换页，但"只多出一个要点"这种
 *    小改动只有 5，被阈值挡掉；而 5 其实是基线（0.6）的 8 倍。
 *  - 匀速运镜/长镜头：每帧都在变，基线本身就有 20，固定阈值要么全放过要么全挡掉；
 *    真要在这段里找剪辑，只能看"比这段自己的常态高多少"。
 *
 * 所以判据从"分数 > 15"改成"分数 > max(绝对下限, k × 本地中位数)"。
 * 返回的每一刀都带 ratio（相对基线的倍数），可以用来说明"这一刀有多确信"。
 *
 * @param {Array<{t:number, score:number}>} stats 逐帧分数
 * @param {{k?:number, minAbs?:number, halfWindow?:number}} opts
 * @returns {Array<{t:number, score:number, ratio:number}>}
 */
export function spikeCuts(stats, { k = 3, minAbs = 6, halfWindow = 15 } = {}) {
  if (!Array.isArray(stats) || stats.length < 3) return [];
  const scores = stats.map((s) => s.score);
  const sorted = [...scores].sort((a, b) => a - b);
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)))];
  // 基线取"本地中位数"和"全片中位数"里更小的那个：本地安静就用本地，
  // 本地本来就很吵（运镜）就退回全片，避免把运镜的常态当成基线而漏掉真正的剪切。
  const global = q(0.5);
  const out = [];
  for (let i = 0; i < stats.length; i++) {
    const lo = Math.max(0, i - halfWindow);
    const hi = Math.min(stats.length, i + halfWindow + 1);
    const around = scores.slice(lo, i).concat(scores.slice(i + 1, hi));
    const local = around.length ? around.sort((a, b) => a - b)[Math.floor(around.length / 2)] : global;
    const base = Math.max(0.2, Math.min(local, global));
    const need = Math.max(minAbs, base * k);
    if (scores[i] > need) {
      out.push({ ...stats[i], ratio: +(scores[i] / base).toFixed(1) });
    }
  }
  return out;
}

/** 抑制过密切点：同窗口内只保留分数最高的那个 */
export function suppressClose(cuts, minGap = 0.35) {
  const sorted = [...cuts].sort((a, b) => a.t - b.t);
  const kept = [];
  for (const cut of sorted) {
    const last = kept[kept.length - 1];
    if (last && cut.t - last.t < minGap) {
      if (cut.score > last.score) kept[kept.length - 1] = cut;
    } else {
      kept.push(cut);
    }
  }
  return kept;
}

/**
 * 自适应阈值：按"每秒大约多少个切点"反推，而不是按分数倍数。
 *
 * 为什么换掉"3×p95"（用 6 条真实视频打脸过）：
 *  - B-roll 类（p95=12.8）→ 3×=38 → 88 切点，OK
 *  - 快剪动画 PV（p90=26、p95=43）→ 3×=130 → **0 个切点**
 *  - 另一支 92s 的 PV（p95=32）→ 3×=96 → 14 个切点
 * 分数倍数在"切点极密"的素材上会把阈值推到切点带里面去。而这类素材恰恰是
 * 每个画面都不一样，倍数法必崩。
 *
 * 换成速率法后：目标约 1 个切点 / minGap 秒，再用 floor 兜住"整片不动"的素材
 * （一支 251s 的静态单镜头素材，p95=2.5，速率法会给出分数 3 的阈值 → floor 12 把它拉回来，切点 0）。
 *
 * @param {number[]} scores 逐帧分数
 * @param {{duration?:number, minGap?:number, floor?:number}} opts
 */
export function autoThreshold(scores, { duration, minGap, floor = 12 } = {}) {
  if (!Array.isArray(scores) || scores.length === 0) return floor;
  const sorted = [...scores].sort((a, b) => a - b);
  const n = sorted.length;
  const total = duration > 0 ? duration : n / 25;
  // 短片要有更细的粒度：5s 的片子按 1.5s 一个切点只剩 3 个名额，会砍掉真实的快切
  const gap = typeof minGap === 'number' ? minGap : Math.min(1.5, Math.max(0.5, total / 60));
  const target = Math.max(1, Math.min(n * 0.25, total / gap));   // 上限 25% 的帧
  const idx = Math.max(0, Math.min(n - 1, Math.floor(n - target)));
  // 取整朝下：宁可多报一个切点（后续会合并），也不要因为四舍五入丢掉真切镜
  return Math.max(floor, Math.floor(sorted[idx]));
}

/** 分数分布的摘要，供 suggest() 判断"内容有多密" */
/**
 * 从逐帧分数里"判定切点"。纯函数：同一份 stats 可以反复用不同参数重判，不需要再读一次视频。
 *
 * 这就是"细扫"真正需要的东西 —— 粗扫已经把每一帧的分数算完了（stats 全量保留），
 * 重新判定只是换一组阈值/间隔，零 IO。
 *
 * @param {Array<{t:number, score:number}>} stats 逐帧分数
 * @param {{threshold?:number|'auto'|'auto-low', minGap?:number, duration?:number}} opts
 */
export function decideCuts(stats, { threshold = 'auto', minGap = 0.35, duration } = {}) {
  const scores = stats.map((s) => s.score);
  const used = threshold === 'auto'
    ? autoThreshold(scores, { duration })
    : threshold === 'auto-low'
      ? Math.max(4, quantile(scores, 0.10))
      : threshold;
  const eps = 1e-6;
  const above = stats.filter((s) => s.score > used + eps);
  // autoThreshold 已经用分位数把阈值放在目标切点数附近；这里不要再读不存在的
  // `.target`（它返回 number），否则 cap 恒为 undefined，下面的限流分支是死代码。
  const cuts = suppressClose(above.map((s) => ({ ...s })), minGap);
  const hotRatio = stats.length > 0 ? above.length / stats.length : 0;
  // 分数序列的变异系数：区分"每帧一剪"和"匀速运镜"
  const mean = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
  const scoreCv = mean > 0
    ? Math.sqrt(scores.reduce((a, b) => a + (b - mean) ** 2, 0) / scores.length) / mean
    : 0;
  return {
    cuts,
    threshold: used,
    degraded: assessDegraded({ span: duration, cuts: cuts.length, hotRatio, scoreCv, scoreMean: mean }),
  };
}

/**
 * 切点计数是不是不可信？连续运镜会被逐帧切成"切点"，于是 cuts=N 变成一个没有节奏含义的数字。
 *
 * 判据：中位镜头 < 0.5 秒，且超过 30% 的帧都在阈值之上 —— 真正的剪辑不会这样，
 * 只有匀速运镜/甩镜/手持抖动会。
 *
 * @returns {'motion'|null}
 */
export function assessDegraded({ span, cuts, hotRatio, scoreCv, scoreMean }) {
  if (!(span > 0) || !(cuts > 0)) return null;
  const medianShot = span / cuts;
  if (medianShot >= 0.5 || hotRatio <= 0.3) return null;
  // **关键补充**：每帧一剪的素材也会"刀数极密 + 高分帧极多"，和运镜长得一模一样。
  // 区别在分数序列的平滑度：运镜每帧只变一点点（变异系数很低），
  // 而每帧一剪是"这一刀变 80、下一刀变 20"（变异系数高）。
  // 只有"整窗分数都很高"（每帧都在大改）才可能是每帧一剪；
  // 低均值 + 高变异系数只是"偶尔来一下"，那是真正的运镜素材，仍然判 motion。
  if (typeof scoreCv === 'number' && scoreCv >= 0.4 && (scoreMean ?? 0) >= 30) return null;
  return 'motion';
}

/** 取分位（0..1）。用于"这片就是很快"时的低阈值：按片中自己的分数分布定，而不是全局倍数。 */
export function quantile(scores, q) {
  if (!Array.isArray(scores) || scores.length === 0) return 0;
  const s = [...scores].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.floor(s.length * q)));
  return s[i];
}

export function scanSummary(scores) {
  if (!Array.isArray(scores) || scores.length === 0) {
    return { p50: 0, p90: 0, p95: 0, p99: 0, max: 0, frames: 0 };
  }
  const s = [...scores].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  return {
    p50: +q(0.5).toFixed(2), p90: +q(0.9).toFixed(2), p95: +q(0.95).toFixed(2),
    p99: +q(0.99).toFixed(2), max: +s[s.length - 1].toFixed(2), frames: s.length,
  };
}

/**
 * 扫描整条视频，返回切点与逐帧分数。
 * @param {{input:string, fps:number, ffmpegPath?:string, width?:number, height?:number,
 *          threshold?:number|'auto', minGap?:number, signal?:AbortSignal, onProgress?:Function}} opts
 *   threshold='auto' 时按 p95×3 自适应（推荐，真实素材与合成素材都能用）
 * @returns {Promise<{cuts:Array<{t:number,score:number}>, stats:Array<{t:number,score:number}>,
 *                    frames:number, threshold:number}>}
 */
export function scanShots(opts) {
  const {
    input,
    fps,
    ffmpegPath = DEFAULT_FFMPEG,
    width = SCAN_W,
    height = SCAN_H,
    threshold = 'auto',
    minGap = 0.35,
    start = 0,
    end,
    signal,
    onProgress,
  } = opts;

  if (!(fps > 0)) throw new RangeError(`fps must be > 0, got ${fps}`);
  const n = width * height;
  const frameBytes = n * 3;

  return new Promise((resolve, reject) => {
    const child = spawn(
      ffmpegPath,
      ['-hide_banner', '-v', 'error', '-nostdin',
        ...(start > 0 ? ['-ss', String(start)] : []),
        ...(end !== undefined ? ['-t', String(Math.max(0.1, end - start))] : []),
        '-i', input, '-an', '-sn',
        '-vf', `scale=${width}:${height},format=rgb24`, '-f', 'rawvideo', '-'],
      { stdio: ['ignore', 'pipe', 'pipe'], signal },
    );

    let pending = Buffer.alloc(0);
    let prev = new Float32Array(n * 3);
    let cur = new Float32Array(n * 3);
    let hasPrev = false;
    let frame = 0;
    const stats = [];
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      while (pending.length >= frameBytes) {
        const slice = pending.subarray(0, frameBytes);
        pending = pending.subarray(frameBytes);
        frameToHsv(slice, cur);
        if (hasPrev) {
          stats.push({ t: start + frame / fps, score: scorePair(prev, cur) });
        }
        // 交换缓冲，避免每帧分配
        const tmp = prev;
        prev = cur;
        cur = tmp;
        hasPrev = true;
        frame += 1;
      }
      onProgress?.({ frames: frame, lastScore: stats.length ? stats[stats.length - 1].score : 0 });
    });

    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => reject(new Error(
      `ffmpeg spawn failed: ${err.message} (${describeMediaSearch('ffmpeg')})`,
    )));
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exited ${code}: ${stderr.trim().split('\n').slice(-3).join(' | ')}`));
        return;
      }
      const span = end !== undefined ? end - start : frame / fps;
      const decided = decideCuts(stats, { threshold, minGap, duration: span });
      const cuts = decided.cuts;

      resolve({
        cuts, stats, frames: frame, threshold: decided.threshold, degraded: decided.degraded,
        summary: scanSummary(stats.map((s) => s.score)),
      });
    });
  });
}

/** 只在测试/调试用：直接从文件读一帧出来做断言 */
export async function grabFrameHsv(input, at, opts = {}) {
  const { ffmpegPath = DEFAULT_FFMPEG, width = SCAN_W, height = SCAN_H } = opts;
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { stdout } = await promisify(execFile)(ffmpegPath, [
    '-v', 'error', '-nostdin', '-ss', String(at), '-i', input, '-frames:v', '1',
    '-vf', `scale=${width}:${height},format=rgb24`, '-f', 'rawvideo', '-',
  ], { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 });
  return frameToHsv(Buffer.from(stdout));
}
