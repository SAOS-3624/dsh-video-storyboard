/**
 * frames.js — **取像素**：本地 / 高清直链两条路、固定并发。
 *
 * 从 pipeline.js 拆出来的。这一层只做一件事：给定时刻和格子像素，交出 RGB buffer。
 * 它不知道转写、不知道排布、不知道清单 —— 所以能单独压测。
 *
 * 2026-11-01 砍掉的东西：`chooseSubGrid` / `subTileTimes` / `splitByWeight` / `extractSubTile`
 * —— 格内摊开（一格拼 k×k 个小帧）整个方案被"档位"取代：**一个镜头就是一格**，
 * 快的地方档位高、格子小，靠排布器一张图里塞几十格，不再在格内再切一次。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { extractFrameRaw, extractSharpest } from './sheet.js';
import { DEFAULT_FFMPEG } from './probe.js';

const runFile = promisify(execFile);

/**
 * 取一帧：有高清直链就先走远程，失败回落本地低清。
 *
 * **默认 pick='mid'**：新架构里每格只有 100~800 像素宽，锐度挑选那 3 倍开销
 * （每格 3 次解码）换不来可见收益；真需要时显式传 `pick:'sharp'`。
 *
 * 远程时把候选帧降到 1：一次 HTTP seek 实测 1.92 s，3 候选即使并发也要 3–4 s/格。
 */
export async function extractFrameWithFallback({
  input, remote, at, dur, cellW, cellH, ffmpegPath, pick = 'mid',
}) {
  const grab = (src, http, candidates) => {
    if (pick === 'sharp') {
      return extractSharpest({ input: src, at, dur, cellW, cellH, ffmpegPath, http, candidates });
    }
    return extractFrameRaw({
      input: src, at, dur, cellW, cellH, ffmpegPath, http,
      mode: pick === 'thumb' ? 'thumb' : 'mid',
    });
  };
  if (remote?.uri) {
    try {
      return { ...(await grab(remote.uri, remote.http, 1)), via: 'remote' };
    } catch {
      /* 直链过期或 CDN 抖动：不整次失败，落到本地那份低清 */
    }
  }
  return { ...(await grab(input, null, pick === 'sharp' ? 3 : 1)), via: remote?.uri ? 'local-fallback' : 'local' };
}

/**
 * 固定并发数的 map：保持输出顺序，任何一个失败就整体失败（取帧失败不能静默跳过，否则图会缺格）。
 * 为什么不用 Promise.all：一次起 16 个 ffmpeg 会把机械硬盘打到爬行，也会把内存顶上去。
 */
export async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

/* ---------------------------------------------------------------- 批量取帧 */

/**
 * **一次 ffmpeg 取多帧**（`select='eq(n,k)+…'`），返回该块内所有目标帧。
 *
 * ## 为什么值
 *
 * Windows 上起一次 ffmpeg 是 **240 ms**（85 MB 的可执行文件，实测 `-version` 跑 30 次
 * 都在 236–248 ms），而解一帧 133×63 几乎不花时间。于是"一帧一进程"的耗时
 * **几乎全在进程启动上**：154 帧串行 = 36 s，12 路并发才压到 5.8 s。
 * 一次进程解 20 秒出 14 帧，把这笔启动费摊掉，实测 5.8 s → 1.6 s。
 *
 * ## 帧号怎么算（这里错一帧，整张图的编号就全错位）
 *
 * `-ss T -frames:v 1` 取的是**第一个 ≥ T 的帧**，等价于帧号 `ceil(T*fps)`；
 * 而 `select='eq(n,k)'` 的 `n` 是 `-ss lo` 之后从 0 开始数的。两者必须用同一套语义，
 * 所以 k = `ceil((at - lo) * fps)`，并且减一个极小量吃掉浮点误差
 * （实测 `(103.3-95)*25` 在 JS 里是 207.49999999999994，`Math.round` 会算成 207，
 * 差一帧 → select 少输出一帧 → 后面每一帧都错位）。
 *
 * ## 为什么统一输出尺寸
 *
 * 一格一个尺寸（1/2 档 400×225、1/3 档 267×150…），而一次过滤链只能给一个尺寸。
 * 所以统一取**本块里最大的格子尺寸**，再由 JS 用 `boxResize` 缩到各自的格子，
 * 两次盒式平均 ≈ 一次盒式平均，肉眼无差。多出来的只有管道里的字节数。
 *
 * 输出帧数一旦对不上就**整块回落到逐帧路径** —— 宁可慢，不能让编号错位。
 */

const MAX_SPAN_SEC = 20;
const MAX_FRAMES_PER_CALL = 40;

/** 帧号换算：`-ss T` 取的是**第一个 ≥ T 的帧**，即绝对帧号 `ceil(T*fps)` */
export function frameAt(sec, fps) {
  return Math.max(0, Math.ceil(Number(sec) * fps - 1e-9));
}

/**
 * `select='eq(n,k)'` 里的 k：**绝对帧号之差**，不是"从 lo 起算的秒数×fps"。
 *
 * 这两个算法在 lo 落在两帧之间时会差一帧，而差一帧在快剪段就是"整格画面全错"
 * （实测 `lo=12.345, at=16.0`：相对算法给 92（帧 401 / 16.04s），
 * 绝对差给 91（帧 400 / 16.00s），只有后者和 `-ss 16.0` 一致）。
 */
export function frameIndexOf(at, lo, fps) {
  return frameAt(at, fps) - frameAt(lo, fps);
}

/**
 * 盒式平均缩小，**带 cover 裁切**：先按目标宽高比居中裁掉多余的一边，再缩放。
 *
 * 只缩不裁会**把画面拉变形** —— 格子比例不统一（规则格是 16:9，补位用的自由尺寸帧
 * 宽高比另算），而批量路径的源尺寸是"本块最大的那个格子"，和目标格的比例通常不同。
 * 这条也正是 batck ≈ 逐帧的验收判据：漏了裁切，平均像素差会到 7/255（肉眼就是歪的）。
 *
 * `dw × dh` 必须 ≤ 源尺寸的对应边（批量路径只缩小：源是最大格子）。
 */
export function boxResize(src, sw, sh, dw, dh) {
  if (sw === dw && sh === dh) return src;
  // cover：以目标比例为准，居中裁切源
  const targetAspect = dw / dh;
  const srcAspect = sw / sh;
  let cx = 0; let cy = 0; let cw = sw; let ch = sh;
  if (srcAspect > targetAspect) {
    cw = Math.max(1, Math.round(sh * targetAspect));
    cx = Math.floor((sw - cw) / 2);
  } else if (srcAspect < targetAspect) {
    ch = Math.max(1, Math.round(sw / targetAspect));
    cy = Math.floor((sh - ch) / 2);
  }
  const out = Buffer.allocUnsafe(dw * dh * 3);
  // 每个目标像素覆盖的源区间（预计算，避免内层乘法）
  const xs = new Int32Array(dw + 1);
  for (let x = 0; x <= dw; x += 1) xs[x] = cx + Math.floor((x * cw) / dw);
  const ys = new Int32Array(dh + 1);
  for (let y = 0; y <= dh; y += 1) ys[y] = cy + Math.floor((y * ch) / dh);
  for (let y = 0; y < dh; y += 1) {
    const y0 = ys[y];
    const y1 = Math.max(y0 + 1, ys[y + 1]);
    for (let x = 0; x < dw; x += 1) {
      const x0 = xs[x];
      const x1 = Math.max(x0 + 1, xs[x + 1]);
      let r = 0; let g = 0; let b = 0;
      let cnt = 0;
      for (let yy = y0; yy < y1; yy += 1) {
        let si = (yy * sw + x0) * 3;
        for (let xx = x0; xx < x1; xx += 1) {
          r += src[si]; g += src[si + 1]; b += src[si + 2];
          si += 3; cnt += 1;
        }
      }
      const di = (y * dw + x) * 3;
      out[di] = (r / cnt) | 0; out[di + 1] = (g / cnt) | 0; out[di + 2] = (b / cnt) | 0;
    }
  }
  return out;
}

/** 一个块：`[lo, hi)` 时间窗里的若干帧（都按同一次解码取） */
function planBatches(jobs, { maxSpan, maxFrames }) {
  const sorted = [...jobs].sort((a, b) => a.at - b.at);
  const batches = [];
  let cur = [];
  for (const j of sorted) {
    if (cur.length && (cur.length >= maxFrames || j.at - cur[0].at > maxSpan)) {
      batches.push(cur); cur = [];
    }
    cur.push(j);
  }
  if (cur.length) batches.push(cur);
  return batches;
}

/**
 * 批量取帧。`jobs` = `[{ at, cellW, cellH, key }]`，返回 `Map<key, {buffer, t}>`。
 *
 * 任何一块解不出期望帧数，就把它退给 `fallback`（逐帧）—— 这一层的正确性
 * 只有一条判据：**交出和逐帧路径一模一样的帧**。
 *
 * @returns {Promise<Map<any, {buffer:Buffer, t:number, via:string}>>}
 */
export async function extractFramesBatched({
  input, jobs, fps, ffmpegPath = DEFAULT_FFMPEG, srcW = 0, srcH = 0, hwaccel = null,
  maxSpan = MAX_SPAN_SEC, maxFrames = MAX_FRAMES_PER_CALL,
  concurrency = 4, fallback,
}) {
  const out = new Map();
  if (!jobs.length) return out;
  const batches = planBatches(jobs, { maxSpan, maxFrames });
  // 每块的平均帧数太少（稀疏长片），批量反而比逐帧慢 —— 一次进程解 20 秒只出 1 帧，
  // 那 240 ms 的启动费一点没摊薄。密度低于 4 帧/块时整体走逐帧。
  //
  // **但必须并发跑**：这里写成 `for … await fallback()` 的话，`--frames 12` 这种稀疏场景
  // 会变成 12 次串行 ffmpeg（实测 extract 5.3s，比批量的 2.0s 还慢一倍），
  // 而逐帧路径本来就是按并发设计的。
  if (jobs.length / batches.length < 4) {
    const shots = await mapPool(jobs, Math.max(2, concurrency * 3), (j) => fallback(j));
    for (let i = 0; i < jobs.length; i += 1) out.set(jobs[i].key, { ...shots[i], via: shots[i]?.via ?? 'local' });
    return out;
  }

  await mapPool(batches, concurrency, async (batch) => {
    // ---- 第一步的尺寸：**保持源宽高比，一次都不裁**
    //
    // 这里是整条批量路径唯一容易错的地方。第一版写成"缩到本块最大格 = `scale=W:H:
    // force_original_aspect_ratio=increase,crop=W:H`"，结果第一步就把画面按**最大格的比例**
    // 裁了一圈，第二步 `boxResize` 再 cover 到目标格时又裁一圈 —— 画面被裁掉两次。
    // 实测 213×100 这一档（目标比例 1.6，最大格 400×225 是 1.78）平均像素差 38.6/255，
    // 就是上下各少了 8% 的画面。
    //
    // 正确做法：第一步只缩放不裁（`scale=W:-2`，-2 = 高按比例取偶数），
    // 让 `boxResize` 的 cover 成为**唯一一次裁切**，几何就和逐帧路径完全一致。
    //
    // 宽取够大，保证任何目标格都能被 cover 住：W ≥ max(cellW) 且 W ≥ max(cellH × 源比例)。
    const srcAspect = (srcW && srcH) ? srcW / srcH : 16 / 9;
    const needW = Math.max(...batch.map((j) => Math.max(j.cellW, Math.ceil(j.cellH * srcAspect))));
    // 偶数：yuv 系编码器要偶数，rgb24 不要求但统一取偶数省得记两套规则
    const W = Math.max(2, needW + (needW % 2));
    // **lo 对齐到帧边界**：让 n=0 确定地等于帧 K0，不依赖 ffmpeg 在两帧之间的丢弃策略
    const K0 = frameAt(batch[0].at, fps);
    const lo = K0 / fps;
    const hi = batch[batch.length - 1].at;
    const span = Math.max(0.5, hi - lo + 1);
    const ks = batch.map((j) => Math.max(0, frameIndexOf(j.at, lo, fps)));
    // 两个格子可能落在**同一帧**（极短段的相邻中点）：select 对同一个 n 只吐一次，
    // 所以按唯一帧号去取，再把同一份 buffer 分给这几格。
    const uniq = [...new Set(ks)].sort((a, b) => a - b);
    const filter = `select='${uniq.map((k) => `eq(n,${k})`).join('+')}',`
      + `scale=${W}:-2:flags=area`;
    let stdout;
    try {
      ({ stdout } = await runFile(ffmpegPath, [
        '-hide_banner', '-v', 'error', '-nostdin',
        // 批量块是**连续解码**（一块 20 秒、几百帧），和扫描同性质，所以硬件解码在这里
        // 也是赚的；单帧 seek 那种"每次新建 CUDA 上下文"的场景才不适合（见 hwaccel.js）。
        ...(hwaccel ? ['-hwaccel', hwaccel] : []),
        '-ss', String(lo), '-t', String(span), '-i', input,
        '-an', '-sn', '-vf', filter, '-vsync', '0',
        '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
      ], { maxBuffer: Math.max(64 << 20, W * 2 * 3 * uniq.length * 8 + (8 << 20)), encoding: 'buffer' }));
    } catch {
      stdout = null;
    }
    // 帧数/行宽不对 = 帧号语义和 ffmpeg 的实际行为不一致。整块退回逐帧，不让编号错位。
    const H = stdout ? Math.round(stdout.length / uniq.length / (W * 3)) : 0;
    if (!stdout || H <= 0 || stdout.length !== W * H * 3 * uniq.length) {
      for (const j of batch) out.set(j.key, { ...(await fallback(j)), via: 'local' });
      return;
    }
    const atK = new Map(uniq.map((k, i) => [k, i]));
    for (let i = 0; i < batch.length; i += 1) {
      const j = batch[i];
      const src = stdout.subarray(atK.get(ks[i]) * W * H * 3, (atK.get(ks[i]) + 1) * W * H * 3);
      out.set(j.key, {
        buffer: boxResize(src, W, H, j.cellW, j.cellH),
        // 批量路径能算出**真实帧时间**（逐帧路径上报的是 seek 位置，差半帧）
        t: lo + ks[i] / fps,
        via: 'local',
      });
    }
  });
  return out;
}
