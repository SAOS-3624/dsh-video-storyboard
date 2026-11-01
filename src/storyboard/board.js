/**
 * board.js — 「跑一次分镜要传什么」只有一份定义。
 *
 * storyboard / zoom / watch 三个入口，以前各自手写一遍 runStoryboard 的参数默认值，
 * 三次抄写已经长出了三种行为。收成一处之后，加参数只需要加一次。
 *
 * 2026-11-01 的参数收敛（配合档位 + 可变网格）：
 *   cells / sheets / need / maxPerSheet / adaptive / tileFirst / planThresholds 全部删除。
 *   「每张几格」不再是输入 —— 张数是排布器（pack.solve）的结果。
 *   换成三个真正决定画面的旋钮：**帧多少（maxFrames）、多大（strategy）、画布多大（budget）**。
 */

import { DEFAULT_STRATEGY, STRATEGIES, resolveStrategy } from './tiers.js';

/** 三个入口。默认值不同，但都由这里决定。 */
export const BOARD_KINDS = Object.freeze(['board', 'zoom', 'watch']);

/**
 * `<detail>` → 每格给多少字。**这里定义一次**，storyboard / zoom / watch 共用。
 * 60/120/400 是实测出来的：中文台词比图贵得多，med 比"每格硬切 180 字"还便宜 12%。
 */
export const DETAIL_CHARS = Object.freeze({ low: 60, med: 120, high: 400 });
export const charsForDetail = (detail) => DETAIL_CHARS[detail] ?? DETAIL_CHARS.med;

/**
 * 画布硬上限：**800×800 / 384 token**。
 *
 * DS 的视觉输入封顶就在这里，超过会被缩回去 —— 那时清单里的 `cell=` 就是假数
 * （1.2M 预算报 456×254，实际模型拿到的是 400×225 那一档）。所以预算上限直接钉死 640k。
 */
export const MAX_CANVAS_SIDE = 800;
export const MAX_BUDGET = MAX_CANVAS_SIDE * MAX_CANVAS_SIDE;
export const DEFAULT_BUDGET = MAX_BUDGET;

/**
 * 出图几何：像素预算（会被夹到 640k）。
 *
 * 旧版按 `size` 把像素预算 / 每张几格 / 下载清晰度绑在一起，结果是
 * small 允许 16 格、large 反而只允许 9 格 —— 方向和直觉是反的。现在只有一个数。
 */
export function boardGeometry(args = {}) {
  const raw = Number(args.budget);
  const budget = Number.isFinite(raw) && raw > 0
    ? Math.min(MAX_BUDGET, Math.max(64_000, Math.round(raw)))
    : DEFAULT_BUDGET;
  return { budget, maxCanvasSide: MAX_CANVAS_SIDE };
}

/**
 * `<detail>` 决定每格给多少字。只有故事板/zoom 用它，watch 用自己的总预算。
 * 这里是"什么时候开 OCR"的唯一判据：要能引用原话（high）才值得花 3 秒做硬字幕校正。
 */
export function ocrFor(args = {}, detail = args.detail ?? 'med') {
  if (args.ocr === true) return true;
  if (args.ocr === false) return false;
  return detail === 'high';
}

function fetchOptionsFor(args = {}, kind = 'board', geom = null) {
  // 下载清晰度跟着**格子最大尺寸**走，不再跟着预算走：
  // 最大格子是 1 档 = 整幅 800×450，720p 已经是 2.5 倍超采样，再高只是白下。
  const scanHeight = args.scanHeight
    ?? (kind === 'board' ? ((geom ?? boardGeometry(args)).budget >= 400_000 ? 720 : 480) : 360);
  return {
    cookies: args.cookies,
    allowAnonymous: args.allowAnonymous === true,
    scanHeight,
    // zoom 回原始流取高清：它是"看细节"的，不该被 board 的像素预算拖低
    ...(kind === 'zoom' ? { zoomHeight: args.zoomHeight ?? 1080 } : {}),
  };
}

/**
 * 把 maxFrames / maxSheets 夹到合理范围。
 * **0 / 负数 / 非数字 = 沿用 fallback**（board 的 fallback 是 0，也就是"不封顶"）。
 */
export function clampFrames(v, fallback) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(10_000, Math.max(1, n));
}

/**
 * 组装 runStoryboard 的参数。
 *
 * @param {object} args 工具参数（或它们的合并结果）
 * @param {{kind?: 'board'|'zoom'|'watch', frameSource?: object|null}} [o]
 * @returns {object} 直接喂给 runStoryboard
 */
export function boardOptions(args = {}, { kind = 'board', frameSource = null } = {}) {
  if (!BOARD_KINDS.includes(kind)) throw new RangeError(`unknown board kind: ${kind}`);
  const detail = args.detail ?? 'med';
  const geom = boardGeometry(args);
  // 旧名在这里就归一化（quality→full / frugal→compact…），下层的日志和清单只认新名
  const wanted = resolveStrategy(args.strategy);
  const strategy = STRATEGIES[wanted] ? wanted : DEFAULT_STRATEGY;
  const base = {
    input: args.input,
    from: args.from ?? 0,
    to: args.to ?? 0,
    pick: args.pick ?? 'mid',
    // 三个调试旋钮原样透传（undefined 时 pipeline 用自己的默认值）
    ...(args.scanGap !== undefined ? { scanGap: args.scanGap } : {}),
    ...(args.integral !== undefined ? { integral: args.integral } : {}),
    ...(args.integralSeconds !== undefined ? { integralSeconds: args.integralSeconds } : {}),
    burn: args.burn ?? 'index',
    transcript: args.transcript ?? 'auto',
    ...(args.transcriptFile !== undefined ? { transcriptFile: args.transcriptFile } : {}),
    sourceHash: args.sourceHash === true,
    detail,
    ocr: ocrFor(args, detail),
    fetchOptions: fetchOptionsFor(args, kind, geom),
    // 档位映射表原样透传（pipeline 在策略之后应用）
    ...(args.tierMap && typeof args.tierMap === 'object' ? { tierMap: args.tierMap } : {}),
    ...(typeof args.hotwords === 'string' ? { hotwords: args.hotwords } : {}),
  };

  if (kind === 'zoom') {
    return {
      ...base,
      // zoom 就是"看细节"：帧少、每帧往大里给（quality = 每帧升一档，1 档不再升）
      strategy: resolveStrategy(args.strategy) in STRATEGIES ? resolveStrategy(args.strategy) : 'full',
      maxFrames: clampFrames(args.maxFrames, 9),
      maxSheets: clampFrames(args.maxSheets, 1),   // zoom 默认一张图：几格大的
      // 一个 23 秒长镜头在窗口里可能一个切点都没有 —— 至少等分到 4 帧，否则"重看"只给一张
      minFrames: 4,
      // 统一档位：n 帧铺成 √n×√n 的一张图（6 帧 → 1/3 档 2 行 3 个；9 帧 → 3×3 满格）
      uniformTier: 'auto',
      budget: geom.budget,
      maxCanvasSide: geom.maxCanvasSide,
      frameSource,
    };
  }

  if (kind === 'watch') {
    return {
      ...base,
      // 陪看一段 60–90 秒，5 帧够讲清"这一段发生了什么"
      strategy: resolveStrategy(args.strategy) in STRATEGIES ? resolveStrategy(args.strategy) : 'compact',
      maxFrames: clampFrames(args.maxFrames, 5),
      maxSheets: clampFrames(args.maxSheets, 1),   // 陪看一段只发一张图
      minFrames: 4,                                 // 陪看也别只给一帧
      budget: geom.budget,
      maxCanvasSide: geom.maxCanvasSide,
      frameSource,
    };
  }

  return {
    ...base,
    strategy,
    // **默认不封顶**：帧数由切点决定，张数由排布决定，用户要看多少就给多少
    maxFrames: clampFrames(args.maxFrames, 0),
    maxSheets: clampFrames(args.maxSheets, 0),
    budget: geom.budget,
    maxCanvasSide: geom.maxCanvasSide,
    textOnly: args.textOnly === true,
    // 自动分段：只传 from 时，窗口默认这么长（秒）；0 = 一直看到片尾
    ...(Number(args.segment) > 0 ? { segment: Math.round(Number(args.segment)) } : {}),
  };
}
