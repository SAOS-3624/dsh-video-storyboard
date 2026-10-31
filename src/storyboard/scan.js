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
  // 上限只对 auto 生效：显式阈值是调用方的明确意图
  const cap = threshold === 'auto' ? autoThreshold(scores, { duration }).target : Infinity;
  const picked = Number.isFinite(cap) && cap > 0 && above.length > cap
    ? [...above].sort((a, b) => b.score - a.score).slice(0, cap).sort((a, b) => a.t - b.t)
    : above;
  const cuts = suppressClose(picked.map((s) => ({ ...s })), minGap);
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
    // 顺便采集两个几乎免费的量，供 flash.js 判断「亮度闪一下又回来」：
    //   means[i]  整帧 V 均值（平移/摇镜不改变它）
    //   prints[i] 16×9 的 V 指纹（比 means 多一点点空间信息，用来确认"结构没变"）
    // 实测代价：解码占 95–98%，这两样只占 1–2%。
    const means = [];
    const prints = [];
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
        {
          let sum = 0;
          const acc = new Float64Array(FP_W * FP_H);
          const cnt = new Uint16Array(FP_W * FP_H);
          for (let y = 0; y < height; y++) {
            const by = Math.min(FP_H - 1, Math.floor((y * FP_H) / height));
            for (let x = 0; x < width; x++) {
              const i = (y * width + x) * 3;
              const v = Math.max(slice[i], slice[i + 1], slice[i + 2]);
              sum += v;
              const bi = by * FP_W + Math.min(FP_W - 1, Math.floor((x * FP_W) / width));
              acc[bi] += v;
              cnt[bi] += 1;
            }
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
      const decided = decideCuts(stats, { threshold, minGap, duration: span });
      const cuts = decided.cuts;

      resolve({
        cuts, stats, frames: frame, threshold: decided.threshold, degraded: decided.degraded,
        summary: scanSummary(stats.map((s) => s.score)),
        // 逐帧的亮度均值与 16×9 指纹（供 flash.js / 转场分类用）。
        // 老调用方不读它们也不会受影响。
        means, prints,
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

    const meanScoreAll = windowStats.reduce((a, s) => a + s.score, 0) / windowStats.length;
    const perFrame = meanScoreAll >= PER_FRAME_MEAN;        // 整窗几乎每帧都在大改
    const gap = perFrame
      ? Math.max(0.9 / Math.max(1, fps), 0.03)              // 一帧以下：每帧一剪也数得出
      : Math.max(1.02 / Math.max(1, fps), 0.04);            // 略大于一帧：不把同镜头的相邻帧算两刀
    if (perFrame) finalGap = Math.min(finalGap, gap);
    const fine = decideCuts(windowStats, { threshold: 'auto-low', minGap: gap, duration: to - from });
    const mean = fine.cuts.reduce((a, c) => a + (c.score ?? 0), 0) / Math.max(1, fine.cuts.length);
    const adopt = fine.cuts.length > coarse.length
      && fine.degraded !== 'motion'
      && mean >= minScore;

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
