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
/** 指纹尺寸（供 flash.js 判闪光）：16×9 = 144 字节/帧，60 分钟片子约 13 MB */
export const FP_W = 16;
export const FP_H = 9;
export const DEFAULT_THRESHOLD = 15;
export const HUE_WEIGHT = 1;
export const SAT_WEIGHT = 1;
export const VAL_WEIGHT = 1;

/**
 * 分数归一的亮度参考（0–255）。
 *
 * `scorePair` 算的是**绝对** HSV 差：一次剪辑在亮画面上是 25 分，在夜戏里只有 5 分，
 * 而门槛 12 是常数 —— 于是暗场/低对比素材必然全漏（实测暗场 8 段硬切 0/7，分值 3.9–5.6）。
 * 这里按"画面有多亮"把分数放大回去，让 12 分在暗场和亮场里指的是同一件事。
 * 取 160 是因为常见影视/网课素材的 V（max 通道）均值落在 140–180，正常片子增益≈1，不动。
 */
export const REF_V = 160;
/** 放大上限：再暗也不超过 3 倍，否则纯黑画面里的编码噪声会被一起放大成刀 */
export const GAIN_MAX = 3;
/** 参考亮度的下限：V 均值低于它不再继续放大 */
export const V_FLOOR = 40;
/** 一刀的绝对下限：低于它的一切都当噪声（细扫的 auto-low 可能低到 4） */
export const MIN_CUT_SCORE = 12;
/** 黑边判定：整窗每行的 V 均值 < BAR_MEAN，且该行从没亮过（< BAR_MAX） */
export const BAR_MEAN = 16;
export const BAR_MAX = 24;
/** 黑边占比上限：超过它多半是"整段黑场"，不做补偿 */
export const BAR_CAP = 0.35;
/** 长时差窗口（秒）。相邻帧差看不见渐变转场（叠化/淡入淡出），隔这么久看才看得见 */
export const LONG_SEC = 0.4;
/** 改动面积判据：把帧切成 16×9 块，块均差 ≥ 最强块 × SPREAD_BLOCK 就算"这块变了" */
export const SPREAD_GW = 16;
export const SPREAD_GH = 9;
export const SPREAD_BLOCK = 0.45;
// 注：`spread`（改动面积占比）目前**只做诊断**，不参与判定 —— 试过当硬门槛，
// 暗场/遮幅的真剪辑会被一起挡掉（暗场整帧换场时块差分布也很集中），得不偿失。
// 它留在 stats 里给 evidence 和后续的"空间证据"用。

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
 * 一次算两件事：**整帧差**（和 `scorePair` 逐位相同）与**改动面积占比 `spread`**。
 *
 * 为什么需要 spread：相邻帧差这种标量**分不开**"整帧换场"和"画面局部重画" ——
 * 动画一拍二（每 2 帧换一张画）在镜头不动的情况下，帧差会周期性地冒到 30–60 分，
 * 和一次真剪辑一模一样。唯一稳定的是**改了多少面积**：真剪辑整幅都换，
 * 局部重画只有人物/特效那几块动，背景块几乎不变（实测记管概念 PV 就是这么翻的车）。
 *
 * 做法：把帧切成 16×9 的块，各算块内平均差异；`spread` = 块均差 ≥ `blockFloor` 的块占比。
 * 代价是每帧多一趟 144 格的累加（约 +3% 扫描时间）。
 *
 * @param {Float32Array} prev 上一帧的 HSV（frameToHsv 的产物）
 * @param {Float32Array} cur  当前帧
 * @param {{width?:number, height?:number, gw?:number, gh?:number, blockFloor?:number}} o
 * @returns {{score:number, spread:number}}
 */
export function scorePairDetail(prev, cur, {
  width = SCAN_W, height = SCAN_H, gw = SPREAD_GW, gh = SPREAD_GH, blockFloor = SPREAD_BLOCK,
} = {}) {
  if (prev.length !== cur.length) throw new RangeError('frames must have the same length');
  const pixels = cur.length / 3;
  const totalWeight = HUE_WEIGHT + SAT_WEIGHT + VAL_WEIGHT;
  const nBlocks = gw * gh;
  const blockSum = new Float64Array(nBlocks);
  const blockCnt = new Uint16Array(nBlocks);
  // 每个 x 落在哪一列块：只算一次，避免每像素一次除法
  const bx = new Uint8Array(width);
  for (let x = 0; x < width; x++) bx[x] = Math.min(gw - 1, Math.floor((x * gw) / width));
  let sum = 0;
  let p = 0;
  for (let y = 0; y < height; y++) {
    const by = Math.min(gh - 1, Math.floor((y * gh) / height)) * gw;
    for (let x = 0; x < width; x++, p += 1) {
      const i = p * 3;
      const dh = Math.abs(cur[i] - prev[i]);
      const hueDiff = Math.min(dh, 255 - dh);
      const hueWeight = Math.min(cur[i + 1], prev[i + 1]) / 255;
      const d = hueDiff * hueWeight * HUE_WEIGHT
        + Math.abs(cur[i + 1] - prev[i + 1]) * SAT_WEIGHT
        + Math.abs(cur[i + 2] - prev[i + 2]) * VAL_WEIGHT;
      sum += d;
      const bi = by + bx[x];
      blockSum[bi] += d;
      blockCnt[bi] += 1;
    }
  }
  // 宽高不是网格整数倍时块大小会差 1 像素：按块内实际像素数取均值
  let peak = 0;
  for (let k = 0; k < nBlocks; k++) {
    if (blockCnt[k] === 0) continue;
    const v = blockSum[k] / blockCnt[k] / totalWeight;
    if (v > peak) peak = v;
  }
  // **相对**判据：块差达到本帧最强块的 blockFloor 倍才算"这块变了"。
  // 不能用绝对阈值 —— 暗场整帧换场时块差也很小（实测暗场真刀的块差 < 25），
  // 绝对阈值会把它们全判成"没改面积"，而真剪辑的块差分布是**摊平**的（各块都差不多），
  // 局部重画是**集中**的（只有几块高）。所以量的是"摊得多开"，不是"改得多猛"。
  let changed = 0;
  if (peak > 2) {
    const floor = peak * blockFloor;
    for (let k = 0; k < nBlocks; k++) {
      if (blockCnt[k] === 0) continue;
      if (blockSum[k] / blockCnt[k] / totalWeight >= floor) changed += 1;
    }
  }
  return { score: sum / (pixels * totalWeight), spread: changed / nBlocks };
}

/**
 * 黑边占比：整窗里"一直是黑的"顶部/底部行占多少。
 *
 * 为什么需要：分数是在**整帧** 2304 个像素上取均值的，2.39:1 的片子上下各有 12% 的黑边，
 * 这两块永远差 0，等于把分母里塞了 25% 的常数 —— 实测同样内容加黑边后，
 * 9 个硬切从 9/9 掉到 7/9（最弱的两刀从 12.2 掉到 11.8，正好跌到下限 12 以下）。
 *
 * 判据要"一直是黑的"而不只是"这一帧是黑的"：`fadeclips` 那种片头黑场里每一行都黑，
 * 但它后来亮了，所以不会被当成黑边（累计均值会被拉高、峰值会超过 BAR_MAX）。
 *
 * @param {{rowV:Float64Array|number[], rowVMax:Float64Array|number[], frames:number}} o
 *   逐行 V 累加值 / 逐行 V 峰值 / 帧数
 * @returns {number} 黑边占整帧高度的比例（0–BAR_CAP），不做补偿时返回 0
 */
export function barFraction({ rowV, rowVMax, frames, cap = BAR_CAP } = {}) {
  if (!rowV || !rowVMax || !(frames > 0)) return 0;
  const h = rowV.length;
  const dark = (y) => rowV[y] / frames < BAR_MEAN && rowVMax[y] < BAR_MAX;
  let top = 0;
  while (top < h && dark(top)) top += 1;
  let bottom = 0;
  while (bottom < h - top && dark(h - 1 - bottom)) bottom += 1;
  const frac = (top + bottom) / h;
  // 整帧都黑（片尾黑场）时 top+bottom 会吃满，这时"补偿"没有意义
  return frac >= cap || frac >= 0.999 ? 0 : +frac.toFixed(3);
}

/**
 * 把绝对差分数换成"同等亮度下的分数"。
 *
 * 两个补偿都是纯乘法，各自的依据不同：
 *  - **亮度**：`gain = clamp(REF_V / V均值, 1, 3)`。暗场 5 分 ×3 → 15 分，才够得上门槛 12。
 *    只在 V 均值低于 REF_V 时放大，亮画面（常见素材）增益 = 1，分数与老版本逐位相同。
 *  - **黑边**：`/(1 - 黑边占比)`。黑边上的差恒为 0，等于把真变化按占比打折，除回来即可。
 *
 * `stats[i]` 是"第 i+1 帧相对第 i 帧"的分数（见 scanShots 的 push 时机），
 * 所以亮度取 `means[i + 1]` —— 取错一帧在快剪处能差出一个刀。
 *
 * @param {Array<{t:number, score:number}>} stats
 * @param {number[]} [means] 逐帧 V 均值（帧下标）
 * @param {{barFrac?:number, refV?:number, gainMax?:number, vFloor?:number, offset?:number}} [opts]
 */
export function normalizeScores(stats, means, {
  barFrac = 0, refV = REF_V, gainMax = GAIN_MAX, vFloor = V_FLOOR, offset = 1,
} = {}) {
  if (!Array.isArray(stats) || stats.length === 0) return [];
  const content = Math.max(0.05, 1 - (barFrac || 0));
  const hasMeans = Array.isArray(means) && means.length > 0;
  return stats.map((s, i) => {
    const v = hasMeans ? (means[i + offset] ?? means[i]) : NaN;
    const gain = Number.isFinite(v) ? Math.min(gainMax, Math.max(1, refV / Math.max(vFloor, v))) : 1;
    if (gain === 1 && content === 1) return s;
    // `raw` 留着：阈值必须在**原始刻度**上算。0.5.4 的 47 是原始分位数，
    // 直接对放大后的分数再取分位数会抬高门槛 —— 亮场里的真刀（原始 48）就掉到门槛下面了
    // （概念 PV 22.25s 那一刀就是这么丢的：两个版本在这一帧都是 48 分，门槛却从 47 涨到 79）。
    return { ...s, raw: s.score, score: (s.score * gain) / content, gain: +gain.toFixed(2) };
  });
}

/** 逐帧指纹存进缓存时要抽稀到这么多 fps。0.125s 一帧 = 最短格子（0.5s）里也够分 4 张。 */
export const PRINT_FPS = 8;

/**
 * 把逐帧指纹压成**稀疏序列 + base64**，供缓存。
 *
 * 为什么要压：原样存 7500 个 `Uint8Array`，`JSON.stringify` 会写成 `{"0":12,"1":34,…}`，
 * 60 分钟片子几十 MB 且读回来类型全丢（缓存注释里记过）。抽稀到 8fps 之后：
 * 144 B × 8fps × 7200s ≈ 8 MB 原始、base64 后 11 MB —— 而它是 `frameDiv` 判据的唯一来源，
 * **不存就等于"第一次跑和第二次跑摊开方式不一样"**，那种 bug 最难查。
 *
 * @param {Uint8Array[]} prints 逐帧 16×9
 * @param {number} fps 原视频帧率
 */
export function packPrints(prints, fps) {
  if (!Array.isArray(prints) || prints.length === 0) return null;
  const step = Math.max(1, Math.round((fps || 25) / PRINT_FPS));
  const kept = [];
  for (let i = 0; i < prints.length; i += step) {
    if (prints[i]?.length === FP_W * FP_H) kept.push(prints[i]);
  }
  if (kept.length === 0) return null;
  const buf = Buffer.alloc(kept.length * FP_W * FP_H);
  kept.forEach((p, i) => buf.set(p, i * FP_W * FP_H));
  // step 要**真的**记下来：解包后 fps = 原 fps / step，算错一位整条时间轴就偏了。
  return { step, fps: +(fps || 25).toFixed(3), data: buf.toString('base64') };
}

/** 解回 `Uint8Array[]`（抽稀后的版本，实际帧率 = packed.fps / packed.step）。 */
export function unpackPrints(packed) {
  if (!packed?.data) return null;
  const buf = Buffer.from(String(packed.data), 'base64');
  const size = FP_W * FP_H;
  const n = Math.floor(buf.length / size);
  if (n === 0) return null;
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = new Uint8Array(buf.subarray(i * size, (i + 1) * size));
  return out;
}

/** 抽稀后的实际帧率（给 frameDiversityOf 的时间→下标换算用） */
export function packedFps(packed, fallback = 0) {
  if (!packed) return fallback;
  const step = Math.max(1, Number(packed.step) || 1);
  return (Number(packed.fps) || fallback) / step;
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
    // 旧写法 `slice(lo,hi).slice(0,i-lo).concat(slice(i-lo+1, hi-lo))` 在 lo > 0 时
    // 会取到**全数组**的 16..30 号元素（而不是 63..hi 的邻居），于是 i 这一刀被漏掉。
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
 * "这条片子该有多少刀、刀之间至少隔多久" —— 速率法的预算。
 *
 * 抽出来是因为它有两个消费者：`autoThreshold` 用它定分位点，
 * `decideCuts` 用它做"超过预算就只留最狠的若干个"的上限。
 * 以前上限那行读的是 `autoThreshold(...).target`，而它返回的是 number
 * （`undefined.target` → 上限恒为 Infinity），等于从来没生效过。
 *
 * @param {number[]} scores
 * @param {{duration?:number, minGap?:number}} opts
 * @returns {{target:number, gap:number, total:number}}
 */
export function cutBudget(scores, { duration, minGap } = {}) {
  const n = Array.isArray(scores) ? scores.length : 0;
  const total = duration > 0 ? duration : n / 25;
  // 短片要有更细的粒度：5s 的片子按 1.5s 一个切点只剩 3 个名额，会砍掉真实的快切
  const gap = typeof minGap === 'number' ? minGap : Math.min(1.5, Math.max(0.5, total / 60));
  const target = Math.max(1, Math.min(n * 0.25, total / gap));   // 上限 25% 的帧
  return { target, gap, total };
}

/** 升序数组里第一个 > v 的下标 */
function upperBound(arr, v) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
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
  const { target } = cutBudget(scores, { duration, minGap });
  const idx = Math.max(0, Math.min(n - 1, Math.floor(n - target)));
  // 取整朝下：宁可多报一个切点（后续会合并），也不要因为四舍五入丢掉真切镜
  let v = Math.floor(sorted[idx]);
  // **并列段的坑**：分位点常常正好落在"刀带的那个分数"上（尤其是静止素材/循环素材，
  // 一大批帧同分），而判据是**严格大于** —— 于是整批刀被一起挡掉。
  // 实测：100 帧里 1/3 是 40 分、其余 2 分 → 阈值算出 40 → 切点 0。
  // 退到严格更小的那个值，因为分数是浮点均值，退一步只会多报一个，不会泛滥。
  if (n - upperBound(sorted, v) === 0 && idx > 0) {
    let j = upperBound(sorted, v) - 1;
    while (j > 0 && sorted[j - 1] === sorted[j]) j -= 1;
    v = sorted[Math.max(0, j - 1)];
  }
  return Math.max(floor, v);
}

/**
 * 把"超阈值的连续帧"并成一个个**事件**，再按间隔抑制。
 *
 * 两个旧问题都出在这里：
 *  1. 一次硬切常常横跨 2 帧（换场那两帧都在阈值之上），按时间窗抑制时它们互相挤，
 *     分数高的留下、低的那帧被删 —— 位置对，但"同一刀算两次"的隐患一直在；
 *  2. 真正的快剪（0.3s 一个镜头）里，**每一刀都合法**，可固定 0.35s 的窗口会把它们
 *     成对合并，留下隔一刀算一刀的结果。实测 12 镜 0.32s 的快剪只数出 5 刀，
 *     而且位置正好是 0.64 / 1.28 / 1.92 / 2.56 / 3.52 —— 规律的减半，不是随机漏。
 *
 * 所以：先按"帧间隔小于 1.5 帧"聚类成一刀（取该簇最高分与最高分所在时刻），
 * 再看这批事件的**典型间隔**——如果它比调用方给的 minGap 还密，说明 minGap 假设错了
 * （内容确实是快剪），把半径收到 0.8×典型间隔，让每一刀都留下。
 *
 * @param {Array<{t:number, score:number}>} above 超阈值的帧（按时间升序）
 * @param {number} step 相邻帧的时间间隔（= 1/fps）
 * @param {{minGap?:number, adaptive?:boolean}} opts
 */
export function cutsFromEvents(above, step, { minGap = 0.35, adaptive = true } = {}) {
  if (!Array.isArray(above) || above.length === 0) return [];
  const dt = step > 0 ? step : 0.04;
  const events = [];
  let lastT = -Infinity;
  for (const s of above) {
    if (s.t - lastT > dt * 1.5) events.push({ ...s });
    else if (s.score > events[events.length - 1].score) events[events.length - 1] = { ...s };
    lastT = s.t;
  }
  // 少于 6 刀时"典型间隔"没有统计意义，别拿它推翻调用方的 minGap
  if (events.length < 6 || !(minGap > 0) || !adaptive) return suppressClose(events, minGap);
  const gaps = events.slice(1).map((e, i) => e.t - events[i].t).sort((a, b) => a - b);
  // 取 25% 分位而不是中位数：正常片子里偶尔的"闪白对"会给出两个很近的间隔，
  // 中位数会被这两刀拉低；而真正的快剪素材是**所有**间隔都密，25% 分位一定也密。
  const typical = gaps[Math.floor(gaps.length * 0.25)];
  const effGap = typical > 0 && typical < minGap ? Math.max(dt * 1.2, typical * 0.8) : minGap;
  return suppressClose(events, effGap);
}

/** 分数分布的摘要，供 suggest() 判断"内容有多密" */
/**
 * 从逐帧分数里"判定切点"。纯函数：同一份 stats 可以反复用不同参数重判，不需要再读一次视频。
 *
 * 这就是"细扫"真正需要的东西 —— 粗扫已经把每一帧的分数算完了（stats 全量保留），
 * 重新判定只是换一组阈值/间隔，零 IO。
 *
 * @param {Array<{t:number, score:number}>} stats 逐帧分数
 * @param {{threshold?:number|'auto'|'auto-low', minGap?:number, duration?:number,
 *          adaptiveGap?:boolean}} opts
 */
export function decideCuts(stats, {
  threshold = 'auto', minGap = 0.35, duration, adaptiveGap = true,
} = {}) {
  const scores = stats.map((s) => s.score);
  const used = threshold === 'auto'
    ? autoThreshold(stats.map((s) => s.raw ?? s.score), { duration })
    : threshold === 'auto-low'
      // 保持 4 的低下限（0.5.4 的取法）。试过抬到"本窗 auto 阈值的 1/5"，
      // 结果与直觉相反：门槛一高，留下的刀均分也变高，反而让**更多**窗口过了
      // `mean >= minScore` 那道采纳关（概念 PV 上 78 → 91 刀）。两处门槛耦合，别单动一个。
      ? Math.max(4, quantile(scores, 0.10))
      : threshold;
  const eps = 1e-6;
  // 分数够高还不够，**一次真剪辑得改掉半幅画面**：动画一拍二、局部爆炸/字幕、粒子这些
  // 帧差能到 30–60，但只动了一小块（实测记管概念 PV 里硬币在手里转被数成 20 刀）。
  // 老缓存没有 spread（undefined）时放行，靠 CACHE_VERSION 保证新条目一定带。
  const above = stats.filter((s) => s.score > used + eps);
  // 上限只对 auto 生效：显式阈值是调用方的明确意图。
  // 修过一次老 bug：这里以前读 `autoThreshold(...).target`，而它返回 number → 永远是 Infinity。
  const cap = threshold === 'auto' ? cutBudget(scores, { duration }).target : Infinity;
  // 只在"超过预算一倍"时才裁，别把压线的那批顺手砍掉
  const picked = Number.isFinite(cap) && cap > 0 && above.length > cap * 2
    ? [...above].sort((a, b) => b.score - a.score).slice(0, cap).sort((a, b) => a.t - b.t)
    : above;
  const step = stats.length > 1 ? stats[1].t - stats[0].t : 0.04;
  // **甩镜护栏**：一次剪辑是"安静 → 一下 → 安静"；甩镜/快速摇镜在切口前后同样吵。
  // 所以候选的左右邻域（各占 0.08–0.22s）中位分都要明显低于阈值，才承认它是剪辑。
  // 实测：6 秒的来回甩镜（每帧平移 300px 量级）在只判分数时会数出 11 刀。
  // 判"持续在动"而不是"邻域里有峰值"，而且用**相对于这一刀自己的分数**来比：
  // 甩镜的邻域分数和切口本身一样高（29 vs 29），快剪的邻域是平静的（3 vs 70）。
  // 用阈值当基准不行 —— 细扫的 auto-low 可能只有 4，平静帧的 3 分也会被算成"吵"。
  const neighborhoodQuiet = (t, from, to, self) => {
    let loud = 0;
    let total = 0;
    const bar = Math.max(1.5, self * 0.5);
    for (const s2 of stats) {
      if (s2.t < from || s2.t > to) continue;
      total += 1;
      if (s2.score >= bar) loud += 1;
    }
    if (total === 0) return true;
    return loud / total < 0.6;
  };
  const events = cutsFromEvents(picked, step, { minGap, adaptive: adaptiveGap });
  // 密到"每 2 帧一剪"时邻域里根本没有安静的时候，这条护栏无从判断 —— 跳过它。
  // （素材真能做到每秒 12 刀时，只能靠后面的细扫去取舍。）
  const nearest = (i) => {
    let d = Infinity;
    for (let k = 0; k < events.length; k++) {
      if (k !== i) d = Math.min(d, Math.abs(events[k].t - events[i].t));
    }
    return d;
  };
  const kept = events.filter((c, i) => nearest(i) < 0.15
    || (neighborhoodQuiet(c.t, c.t - 0.18, c.t - 0.06, c.score)
      && neighborhoodQuiet(c.t, c.t + 0.06, c.t + 0.18, c.score)));
  const cuts = kept;
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
    // 长时差窗口（秒）。0.4s 是"叠化/淡入淡出"的主场（影视剧里 0.5–1.5s），
    // 调大能看见更慢的转场，但运镜的分数也会一起变大 —— 改之前先跑合成素材对比。
    longSec = LONG_SEC,
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
    // 顺便采集两个几乎免费的量，供 flash.js 判断「亮度闪一下又回来」：
    //   means[i]  整帧 V 均值（平移/摇镜不改变它）
    //   prints[i] 16×9 的 V 指纹（比 means 多一点点空间信息，用来确认"结构没变"）
    // 实测代价：解码占 95–98%，这两样只占 1–2%。
    const means = [];
    const prints = [];
    // 逐行 V 累加/峰值：黑边检测用（见 barFraction）。黑边那几行的均值永远很低、
    // 峰值也永远不高，和"这一帧恰好是黑的"能分开。
    const rowV = new Float64Array(height);
    const rowVMax = new Float64Array(height);
    // 长时差：相邻帧差看不见叠化（1s 的变化摊到 25 帧上只有 1.6 分/帧），
    // 但隔着 0.4s 看，一次完整换场仍然是满格差。环形缓冲只占 lag×9KB，
    // 每帧多算一次 scorePair（约等于打分成本 ×2，占总耗时 1–2%）。
    const lag = Math.max(1, Math.round((longSec > 0 ? longSec : LONG_SEC) * fps));
    const ring = Array.from({ length: lag }, () => new Float32Array(n * 3));
    let ringIdx = 0;
    let ringWarm = 0;
    const longStats = [];
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      while (pending.length >= frameBytes) {
        const slice = pending.subarray(0, frameBytes);
        pending = pending.subarray(frameBytes);
        frameToHsv(slice, cur);
        const t = start + frame / fps;
        if (hasPrev) {
          // **一次算两件事**：整帧差（判"变没变"）+ 改动面积（判"改了多少画面"）。
          // 后者是防伪切点的关键：一拍二/局部特效的帧差能到 30–60，但只改一小块。
          const { score, spread } = scorePairDetail(prev, cur, { width, height });
          stats.push({ t, score, spread: +spread.toFixed(3) });
        }
        // 长时差：ring[ringIdx] 里躺着 lag 帧之前那一帧
        if (ringWarm >= lag) {
          longStats.push({ t, score: scorePair(ring[ringIdx], cur) });
        } else {
          ringWarm += 1;
        }
        ring[ringIdx].set(cur);
        ringIdx = (ringIdx + 1) % lag;
        {
          let sum = 0;
          const acc = new Float64Array(FP_W * FP_H);
          const cnt = new Uint16Array(FP_W * FP_H);
          for (let y = 0; y < height; y++) {
            const by = Math.min(FP_H - 1, Math.floor((y * FP_H) / height));
            let rowSum = 0;
            let rowMax = 0;
            for (let x = 0; x < width; x++) {
              const i = (y * width + x) * 3;
              const v = Math.max(slice[i], slice[i + 1], slice[i + 2]);
              sum += v;
              rowSum += v;
              if (v > rowMax) rowMax = v;
              const bi = by * FP_W + Math.min(FP_W - 1, Math.floor((x * FP_W) / width));
              acc[bi] += v;
              cnt[bi] += 1;
            }
            rowV[y] += rowSum / width;
            if (rowMax > rowVMax[y]) rowVMax[y] = rowMax;
          }
          const fp = new Uint8Array(FP_W * FP_H);
          for (let i = 0; i < FP_W * FP_H; i++) fp[i] = Math.round(acc[i] / (cnt[i] || 1));
          means.push(sum / n);
          prints.push(fp);
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
      // ---- 归一化：把"绝对差"换成"同等亮度下的差"，再补掉黑边占掉的分母。
      // 必须在下判定之前做 —— 否则暗场/黑边的片子会被常数门槛 12 系统性漏掉。
      const bar = barFraction({ rowV, rowVMax, frames: frame });
      const normMeans = bar > 0 ? means.map((m) => m / (1 - bar)) : means;
      const normStats = normalizeScores(stats, means, { barFrac: bar });
      const normLong = normalizeScores(longStats, means, { barFrac: bar, offset: lag });
      const decided = decideCuts(normStats, { threshold, minGap, duration: span });
      // ---- 渐变转场（叠化/淡入淡出）：补在切点列表里，只补"没有切点的地方"
      const gradual = detectGradual(normLong, normStats, {
        threshold: decided.threshold,
        lagSec: lag / Math.max(1, fps),
        cuts: decided.cuts.map((c) => c.t),
      });
      const merged = gradual.length
        ? [...decided.cuts, ...gradual].sort((a, b) => a.t - b.t)
        : decided.cuts;

      resolve({
        cuts: merged,
        stats: normStats,
        longStats: normLong,
        frames: frame,
        threshold: decided.threshold,
        degraded: decided.degraded,
        summary: scanSummary(normStats.map((s) => s.score)),
        // 逐帧的亮度均值与 16×9 指纹（供 flash.js / 转场分类用）。
        // 老调用方不读它们也不会受影响。
        means: normMeans,
        prints,
        // 黑边占比（0 = 没检测到）。清单能据此说明"这是 2.39:1 的遮幅片"
        bars: bar,
      });
    });
  });
}

const MIN_REFINE_SCORE = 25;
// 整窗平均分高于这个值 → 认为"几乎每帧都在大改"（每帧一剪）。
// 实测：真每帧一剪 44.5，概念 PV 的快剪窗口 12–18，所以 30 能把两者分开。
const PER_FRAME_MEAN = 30;
/**
 * 逐窗口重判：**先算画面差异，再按窗口决定用多细的间隔去数刀。**
 *
 * 早先的版本靠 `findBursts` 找爆点再细判，那有个死穴：整片都快时，"到处一样快"就没有爆点，
 * 于是全片都被 0.35s 的间隔压扁（实测 3 秒 18 镜的素材只数出 4 刀）。
 *
 * 改成逐个 2 秒窗口判断，问的问题变成"**这个窗口的刀，粗间隔看得见吗**"，是局部且绝对的，
 * 跟全片平均无关。采纳条件三条：
 *   1) 细判（一帧间隔）确实数出更多刀
 *   2) 没被判成 motion（连续运镜每帧都在变，但幅度小）
 *   3) 这些刀的分数均值 ≥ 25（真剪辑一次性换画面，运镜每帧只挪一点）
 *
 * 细判不需要重新读盘：两套判定都跑在同一份逐帧分数上。
 *
 * @returns {{cuts:Array, refined:Array<{from:number,to:number,coarse:number,fine:number}>}}
 */
export function refineCutsByWindow({
  stats, fps, coarseCuts, winStart = 0, winDur, winSec = 2, minScore = MIN_REFINE_SCORE,
  coarseThreshold = 0,
}) {
  // 间隔要按内容选：
  //   - 普通快闪：间隔略大于一帧（1.02/fps），避免同一个镜头的相邻帧被判成两刀；
  //   - **每帧一剪**：整窗平均分很高（实测 44，普通快闪只有 12–18），这时才把间隔压到一帧以下，
  //     否则 23 刀只会数出 9 刀。
  // 用固定的小间隔会把普通动画的快镜放成 19 刀/秒（实测概念 PV 48 → 164），所以必须按窗口内容分流。
  const out = [];
  const refined = [];
  let open = null;
  let finalGap = Math.max(1.02 / Math.max(1, fps), 0.04);   // 收尾合并用的间隔（遇到每帧一剪会调小）                                          // 正在进行的采纳区间

  // 按下标切窗口：stats 是等间隔的，用 slice 比每窗 filter 全量快几个量级
  // （60 分钟片子 90k 帧、1800 个窗口，原来每窗都扫全量 = 1.6 亿次比较）
  const perWin = Math.max(4, Math.round(winSec * Math.max(1, fps)));
  for (let i0 = 0; i0 < stats.length; i0 += perWin) {
    const windowStats = stats.slice(i0, i0 + perWin);
    const from = windowStats[0].t;
    const to = windowStats[windowStats.length - 1].t + 1 / Math.max(1, fps);
    const coarse = coarseCuts.filter((c) => c.t >= from && c.t < to);
    if (windowStats.length < 4) { out.push(...coarse); continue; }

    // 这两道闸都用**原始分数**（与 0.5.4 同刻度）：亮度归一化只用来"让暗场更容易过线"，
    // 不该顺带抬高"整窗是不是每帧都在大改"的判据 —— 那会让暗底片子被细扫过度采纳。
    const rawOf = (x) => (x.raw ?? x.score);
    const meanScoreAll = windowStats.reduce((a, s) => a + rawOf(s), 0) / windowStats.length;
    const perFrame = meanScoreAll >= PER_FRAME_MEAN;            // 整窗几乎每帧都在大改
    const gap = perFrame
      ? Math.max(0.9 / Math.max(1, fps), 0.03)              // 一帧以下：每帧一剪也数得出
      : Math.max(1.02 / Math.max(1, fps), 0.04);            // 略大于一帧：不把同镜头的相邻帧算两刀
    if (perFrame) finalGap = Math.min(finalGap, gap);
    const fineRaw = decideCuts(windowStats, { threshold: 'auto-low', minGap: gap, duration: to - from });
    // 细扫的阈值是"本窗低分位"，可能低到 4 —— 那会把 4 分的鬼影也当刀（实测概念 PV 里
    // 57.3s/57.4s 这种 4 分的刀，画面根本没换）。刀本身必须过全局下限，否则不认。
    // 细扫的刀还要**够得着粗阈值的 3/4**：纯按"本窗低分位"判，2–4 分的抖动也会被收进来，
    // 实测概念 PV 里 23.9/24.0/35.9/55.0 四个"刀"画面几乎没变（同一镜头里换张画）。
    const fineFloor = Math.max(MIN_CUT_SCORE, coarseThreshold * 0.75);
    const fine = { ...fineRaw, cuts: fineRaw.cuts.filter((c) => (c.raw ?? c.score ?? 0) >= fineFloor) };
    const mean = fine.cuts.reduce((a, c) => a + rawOf(c), 0) / Math.max(1, fine.cuts.length);
    // 采纳门槛**保持绝对阈值**（minScore=25），不改成"相对本窗基线"。
    // 试过相对判据（`max(6, 3×窗内中位分)`）：暗场/低对比快剪能多救回几刀，但代价是
    // **逐帧动画（一拍二/一拍三）的片子全线崩** —— 记管概念 PV 上细扫从 44 刀涨到 122 刀，
    // 抽 8 个新增点逐个看前后帧，6 个是同一个镜头里换张画（硬币在手里转、白剪影摆姿势），
    // 不是剪辑。相邻帧差这种信号分不开"整帧换场"和"局部换画"，靠调门槛只会两头晃。
    // 要放宽必须先有**空间证据**（改了多少块/多少像素），那是下一版的事。
    const need = minScore;
    // **逐帧动画的坑**（记管概念 PV 实测）：动画经常"一拍二/一拍三"，画面每 2–3 帧换一张画，
    // 帧差于是每隔两帧出现一个不小的峰。整窗又不是"每帧都在大改"（meanScoreAll 只有 5–8），
    // 相对门槛会把这一串峰全当成剪辑点 —— 8 秒里数出 20 刀，而那些帧其实是同一个镜头里
    // 手里那枚硬币在动（抽样看过）。
    // 所以非 perFrame 的窗口要求细判出的刀**至少隔 3.5 帧**：真人剪辑不会 2 帧一剪。
    const gaps = fine.cuts.slice(1).map((c, i) => c.t - fine.cuts[i].t).sort((a, b) => a - b);
    const medianGap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : null;
    const minShot = Math.max(0.13, 3.5 / Math.max(1, fps));
    const tooTight = !perFrame && medianGap !== null && medianGap < minShot;
    const adopt = fine.cuts.length > coarse.length
      && fine.degraded !== 'motion'
      && !tooTight
      && mean >= need;

    if (adopt) {
      out.push(...fine.cuts);
      const n = out.length;
      if (open && Math.abs(open.to - from) < 1e-6) { open.to = to; open.fine = n; }
      else {
        if (open) refined.push({ from: open.from, to: open.to, coarse: open.coarse, fine: open.count });
        open = { from, to, coarse: coarse.length, count: 0, fine: 0 };
      }
      open.count += fine.cuts.length;
    } else {
      out.push(...coarse);
      if (open) { refined.push({ from: open.from, to: open.to, coarse: open.coarse, fine: open.count }); open = null; }
    }
  }
  if (open) refined.push({ from: open.from, to: open.to, coarse: open.coarse, fine: open.count });

  return {
    // 收尾再并一次：跨窗口边界可能留下贴得很近的两刀。
    // 间隔取"所有窗口用过的最小值"，否则每帧一剪的结果会在这一步被并回去（实测 21 → 9）。
    cuts: suppressClose(out.sort((a, b) => a.t - b.t), finalGap),
    refined: refined.map((r) => ({
      from: +r.from.toFixed(2), to: +r.to.toFixed(2), coarse: r.coarse, fine: r.fine,
    })),
  };
}

/**
 * 渐变转场（叠化 / 淡入淡出 / 划像）—— 相邻帧差**结构上**看不见的那一类。
 *
 * 为什么单靠 `stats` 永远抓不到：1 秒的叠化把"整整一次换场"摊到 25 帧上，
 * 每帧只有 1.6 分，而同镜头内运动的中位分就有 2.3 —— 倍数 1.3×，任何阈值都分不开
 * （实测：3 个 1s 叠化，相邻帧判据 0/3，`spikeCuts` 降到 k=2 也只捞回 1 个）。
 *
 * 长时差（`scanShots` 里同时算的 `score(i, i-lag)`，lag≈0.4s）就分得开：
 * 跨过转场时它满格，镜头内运动再快，0.4s 内的差也远小于一次换场。
 *
 * 判据四条 AND（前三条排除"运镜"这个主要伪影）：
 *  1. long ≥ 门槛（和帧判据同一个门槛，不开小灶）
 *  2. long ≥ RATIO × 同一时刻的帧差 —— 变化是"积累出来的"而不是"一直在变"
 *  3. 前后 0.25s 都要**安静**：转场是"两个稳定状态之间的一段过渡"，
 *     而甩镜/匀速运镜在它前后同样吵 —— 这条是区分两者的关键，只看 1、2 会被甩镜骗
 *  4. 附近 dedupe 秒内没有已判定的切点（硬切已经报了，别重复）
 *
 * @param {Array<{t:number, score:number}>} longStats 长时差序列
 * @param {Array<{t:number, score:number}>} frameStats 相邻帧差序列（"安静"与"积累"都用它）
 * @param {{threshold?:number, lagSec?:number, ratio?:number, quiet?:number, margin?:number,
 *          dedupe?:number, cuts?:number[]}} opts
 * @returns {Array<{t:number, score:number, kind:'gradual', width:number}>}
 */
export function detectGradual(longStats, frameStats, {
  threshold = 12, lagSec = LONG_SEC, ratio = 2, quiet, margin = 0.25, dedupe = 0.6, cuts = [],
} = {}) {
  if (!Array.isArray(longStats) || longStats.length < 4) return [];
  if (!Array.isArray(frameStats) || frameStats.length === 0) return [];
  // 长时差曲线的**基线随内容变**：暗场归一化后被放大了 3 倍，它自己的抖动就能摸到 12。
  // 所以门槛取"绝对门槛"和"1.5×本片长时差中位数"里更严的那个（和 spikeCuts 同思路）。
  const baseLong = quantile(longStats.map((s) => s.score), 0.5);
  const longThr = Math.max(8, threshold, baseLong * 1.5);
  const quietMax = quiet ?? Math.max(3, threshold * 0.55);
  const step = longStats.length > 1 ? longStats[1].t - longStats[0].t : 0.04;
  const at = (t) => {
    const i = Math.round((t - frameStats[0].t) / step);
    return i >= 0 && i < frameStats.length ? frameStats[i].score : null;
  };
  /** 那一帧的改动面积（改动面积是 0.5.x 之后才有的字段，老传入缺它就返回 null = 不判） */
  const spreadAt = (t) => {
    const i = Math.round((t - frameStats[0].t) / step);
    const v = i >= 0 && i < frameStats.length ? frameStats[i]?.spread : null;
    return typeof v === 'number' ? v : null;
  };
  const med = (from, to) => {
    const vals = [];
    for (let t = from; t <= to + 1e-9; t += step) {
      const v = at(t);
      if (Number.isFinite(v)) vals.push(v);
    }
    if (vals.length === 0) return null;
    vals.sort((a, b) => a - b);
    return vals[Math.floor(vals.length / 2)];
  };

  const out = [];
  let run = null;
  const flush = () => {
    if (!run) return;
    const { from, to, peak, peakT } = run;
    run = null;
    const width = to - from + step;
    // ① 至少两帧宽。单帧尖峰是"某一帧抖了一下"，不是过渡过程 ——
    //    实测没有这条时，匀速运镜会报出 5 个假转场（每个 0.04s 宽）。
    if (width < step * 1.5) return;
    if (width > Math.max(2.5, lagSec * 4)) return;        // 太宽：持续运动，不是一次转场
    const before = med(from - margin - step, from - step);
    const after = med(to + step, to + margin + step);
    const here = med(from, to);
    if (before === null || after === null || here === null) return;
    // ② 前后都要安静（±0.25s）。这是区分"转场"和"甩镜/匀速运镜"的主判据：
    //    运镜在过渡期间和过渡前后一样吵，转场则是"两个静止状态之间的一段过渡"。
    if (before > quietMax || after > quietMax) return;
    // ③ 过渡期间相邻帧差必须**低**（< 0.45×门槛）。叠化 3–5 分，运镜 9–15 分。
    //    只看"长时差大"会被运镜骗：0.4s 的位移在两种情况下都很大。
    if (here > Math.max(3, threshold * 0.45)) return;
    // ④ 长时差要明显高于这里自己的帧差 —— 变化是"攒出来的"
    if (peak < ratio * Math.max(1.5, here)) return;
    // 短转场（宽度≈lag）的区间中心比转场中心晚半个 lag，长转场同理
    // （run ≈ [a, a+d+lag] → 中心 = a+d/2 + lag/2，恒减半个 lag 就回到转场中心）
    const center = (from + to) / 2 - lagSec / 2;
    const wide = width > lagSec * 1.6;                    // 宽 = 渐变；窄 = 分数偏低的硬切
    out.push({
      t: +center.toFixed(3), score: +peak.toFixed(1),
      kind: wide ? 'gradual' : 'cut', width: +width.toFixed(2),
    });
  };
  for (const s of longStats) {
    if (s.score >= longThr) {
      if (run && s.t - run.to <= step * 1.5) {
        run.to = s.t;
        if (s.score > run.peak) { run.peak = s.score; run.peakT = s.t; }
      } else {
        flush();
        run = { from: s.t, to: s.t, peak: s.score, peakT: s.t };
      }
    } else if (run) {
      flush();
    }
  }
  flush();
  if (out.length === 0) return [];
  // 和已报切点重合的丢掉（硬切在长时差曲线上也是一次"转场"），
  // 自己之间也按 0.4s 去重（同一个转场被噪声切成两段时只留最狠的那个）
  const kept = out.filter((g) => !cuts.some((c) => Math.abs(c - g.t) <= dedupe));
  const out2 = [];
  for (const g of kept.sort((a, b) => a.t - b.t)) {
    const last = out2[out2.length - 1];
    if (last && g.t - last.t < 0.4) {
      if (g.score > last.score) out2[out2.length - 1] = g;
    } else out2.push(g);
  }
  return out2;
}


/**
 * 找出**黑场区间**（片头黑屏、转场黑场、片尾字幕前的黑）。
 *
 * 为什么需要：黑场在分数上几乎为 0（前后都是黑的，没有"变化"），所以永远不会被当成切点。
 * 结果它就和后面的 logo / 正片挤在同一格里，那一段的代表帧取中点 —— 正好落在黑里，
 * 整格变成一张纯黑图，片头的内容全丢。
 *
 * 实测概念 PV：前 5 秒亮度只有 1（全黑），第一个切点在 5.71 秒（logo 出现），
 * 而 0–37.6 秒那一格的中点 18.8 秒亮度是 0 —— 整格黑。
 *
 * @param {number[]} means 逐帧亮度均值（0–255）
 * @param {{threshold?:number, minFrames?:number, fps?:number}} opts
 *   threshold: 低于它算黑（默认 12）
 *   minFrames: 至少持续这么多帧才算一段黑场（默认 0.4 秒），避免把暗场镜头误判
 * @returns {Array<{from:number, to:number}>} 黑场区间（秒）
 */
export function detectDarkRuns(means, { threshold = 12, minFrames = 10, fps = 25 } = {}) {
  if (!Array.isArray(means) || means.length === 0) return [];
  const runs = [];
  let start = -1;
  for (let i = 0; i <= means.length; i++) {
    const dark = i < means.length && means[i] < threshold;
    if (dark && start < 0) start = i;
    if (!dark && start >= 0) {
      if (i - start >= minFrames) runs.push({ from: start / fps, to: i / fps });
      start = -1;
    }
  }
  return runs;
}
