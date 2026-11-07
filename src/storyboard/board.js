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

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { configuredNumber, configuredText, readVideoFile } from './user-config.js';

import {
  AUTO_STRATEGY, DEFAULT_STRATEGY, STRATEGIES, resolveStrategy,
  DEFAULT_BUDGET as TIER_DEFAULT_BUDGET,
  IMAGE_UPSCALE_AREA, MAX_CANVAS_SIDE as TIER_MAX_CANVAS_SIDE, MAX_IMAGE_AREA,
} from './tiers.js';

/** 三个入口。默认值不同，但都由这里决定。 */
export const BOARD_KINDS = Object.freeze(['board', 'zoom', 'watch']);

/**
 * auto 选档能不能用。**默认开**，两个地方可以关掉：
 *
 *   - 环境变量 `DSH_STORYBOARD_AUTO=0`（false/off/no 也算）
 *   - `~/.dsh/video.json` 里 `{"storyboard": {"auto": false}}`
 *
 * 关掉之后默认回到 `compact`，也就是 0.6.0 的默认值 —— 行为可复现，不会因为升级变了口味。
 * 桌面版 DSH 读不到 setx 的环境变量，所以配置文件那条路是必须的。
 */
export function autoStrategyEnabled() {
  const env = process.env.DSH_STORYBOARD_AUTO;
  if (env !== undefined && env !== '') {
    return !/^(0|false|off|no)$/i.test(String(env).trim());
  }
  try {
    const home = process.env.DSH_HOME
      || join(process.env.USERPROFILE || process.env.HOME || homedir(), '.dsh');
    const cfg = JSON.parse(readFileSync(join(home, 'video.json'), 'utf8'));
    const v = cfg?.storyboard?.auto;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'string') return !/^(0|false|off|no)$/i.test(v.trim());
  } catch { /* 没配置文件就是默认开 */ }
  return true;
}

/** board 的默认策略。model 不点名时用它：auto（可关）> compact。 */
export function defaultBoardStrategy() {
  return autoStrategyEnabled() ? AUTO_STRATEGY : DEFAULT_STRATEGY;
}

/**
 * `<detail>` → 每格给多少字。**这里定义一次**，storyboard / zoom / watch 共用。
 * 60/120/400 是实测出来的：中文台词比图贵得多，med 比"每格硬切 180 字"还便宜 12%。
 */
export const DETAIL_CHARS = Object.freeze({ low: 60, med: 120, high: 400 });
export const charsForDetail = (detail) => DETAIL_CHARS[detail] ?? DETAIL_CHARS.med;

/**
 * 画布的像素预算范围。**常量只有一份**（在 tiers.js），这里只做转出，避免两处各写一个 800。
 *
 * 上限 = 1300×1300（官方现行的缩放目标，见 tiers.MAX_CANVAS_SIDE 的注释）；
 * **默认 = 360k**，也就是 16:9 的 800×450 —— 与 0.6.1 之前的输出**逐像素相同**。
 * 以前默认写 640k 却被单边 800 卡成 360k，等于"说要 640k、实际只给 360k"；
 * 现在默认直接是 360k，参数和结果对得上，想要更大的画布自己给 budget。
 */
export const MAX_CANVAS_SIDE = TIER_MAX_CANVAS_SIDE;
export const MAX_BUDGET = MAX_IMAGE_AREA;
export const DEFAULT_BUDGET = TIER_DEFAULT_BUDGET;

/**
 * 出图几何：像素预算（会被夹到 [64k, 1300²]）。
 *
 * 旧版按 `size` 把像素预算 / 每张几格 / 下载清晰度绑在一起，结果是
 * small 允许 16 格、large 反而只允许 9 格 —— 方向和直觉是反的。现在只有一个数。
 */
export function boardGeometry(args = {}) {
  const raw = Number(args.budget);
  const requested = Number.isFinite(raw) && raw > 0
    ? Math.min(MAX_BUDGET, Math.max(64_000, Math.round(raw)))
    : DEFAULT_BUDGET;
  // **地板**：小于 544² 的图计费时一律按 544² 收（`tiers.imageTokens`），
  // 所以给一个更小的预算只会更糊、不会更便宜。这里抬到地板，并把"抬过"记下来，
  // 清单会写明 —— 不能偷偷改用户给的数。
  const budget = Math.max(IMAGE_UPSCALE_AREA, requested);
  return {
    budget,
    maxCanvasSide: MAX_CANVAS_SIDE,
    ...(budget !== requested ? { floorRaisedFrom: requested } : {}),
  };
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
  // 下载清晰度跟着**格子最大尺寸**走，不再跟着预算的"名义值"走：
  // 默认画布 800×450 的 1 档格子就是整幅，720p（1280×720）已是 1.6 倍超采样，再高只是白下。
  // 阈值 300k 是"画布能放下 800×450"的分界：过了它就该给 720p，所以**默认 360k 仍然是 720p**，
  // 换画布口径不会偷偷把抓帧降到 480p（那样输出的像素就不是原来那张了）。
  const scanHeight = args.scanHeight
    ?? (kind === 'board' ? ((geom ?? boardGeometry(args)).budget >= IMAGE_UPSCALE_AREA ? 720 : 480) : 360);
  return {
    cookies: args.cookies,
    allowAnonymous: args.allowAnonymous === true,
    scanHeight,
    // 键里带清晰度：zoom / 陪看的本地副本只做探测和兜底，隔壁已有同一条链接的副本就直接用，
    // 不为一个兜底文件重新解析 + 重新下载（匿名重下高清会 503，2026-11-02 实报）。
    // **分镜不能开**：它的本地副本就是产出源，清晰度必须严格照参数走。
    ...(kind !== 'board' ? { reuseCached: true } : {}),
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
  /**
   * 用户级配置（`~/.dsh/video.json`）读一次，下面 strategy 和 tierMap 共用。
   *
   * 读一次而不是各读各的：这个函数在每次调用都会跑，多读一遍盘只为了省一行代码不划算。
   */
  const userCfg = readVideoFile();
  const sbCfg = userCfg && typeof userCfg.storyboard === 'object' && !Array.isArray(userCfg.storyboard)
    ? userCfg.storyboard
    : {};
  const wanted = resolveStrategy(args.strategy);
  const configuredStrategy = resolveStrategy(sbCfg.strategy);
  // 不点名 → auto（可被关掉，见 autoStrategyEnabled）；点名就照办，`auto` 也是合法值。
  // 调用方没传才看配置 —— 设置页写的默认值不该压掉某一次调用的显式指定。
  const picked = wanted || configuredStrategy;
  const strategy = picked === AUTO_STRATEGY
    ? AUTO_STRATEGY
    : (STRATEGIES[picked] ? picked : defaultBoardStrategy());
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
    /**
     * 档位映射表（pipeline 在策略之后应用）。
     *
     * 三层优先序，和 `cutFloor` 一致：本次调用显式传的 > `video.json` 的
     * `storyboard.tierMap`（设置页写的默认值）> 不传（不做映射）。
     */
    ...(() => {
      const explicit = args.tierMap && typeof args.tierMap === 'object' && !Array.isArray(args.tierMap)
        ? args.tierMap : null;
      const configured = sbCfg.tierMap && typeof sbCfg.tierMap === 'object' && !Array.isArray(sbCfg.tierMap)
        ? sbCfg.tierMap : null;
      const m = explicit ?? configured;
      return m && Object.keys(m).length ? { tierMap: m } : {};
    })(),
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
    // 切点判定下限。三层优先序，与项目里其它配置一致：
    //   ① 本次调用显式传的 args.cutFloor
    //   ② ~/.dsh/video.json 里的 storyboard.cutFloor（设置页写的默认值）
    //   ③ 不传 —— scanShots 按口径取默认（mc:80 / abs:12）
    // 这是"这段素材该怎么切"的入口：80 适合纪录片/电影，60 适合短视频/快剪。
    ...(() => {
      const explicit = Number(args.cutFloor);
      const v = Number.isFinite(explicit) && explicit > 0
        ? explicit
        : configuredNumber(userCfg, 'storyboard.cutFloor', { min: 1, max: 255 });
      return v ? { cutFloor: Math.min(255, Math.round(v)) } : {};
    })(),
    // 七道阈值取哪一套（`~/.dsh/video.json` 的 `storyboard.tierCurve`）。
    // 认不出来的名字在 thresholdsFor 里退回 docx，这里只负责把配置读出来。
    ...(() => {
      const v = configuredText(userCfg, 'storyboard.tierCurve');
      return v ? { tierCurve: v } : {};
    })(),
    // **默认不封顶**：帧数由切点决定，张数由排布决定，用户要看多少就给多少
    maxFrames: clampFrames(args.maxFrames, 0),
    maxSheets: clampFrames(args.maxSheets, 0),
    budget: geom.budget,
    // 预算被地板抬过（<544² 一分钱不省）时把原值带上，清单要写明白
    ...(geom.floorRaisedFrom ? { budgetFloorRaisedFrom: geom.floorRaisedFrom } : {}),
    maxCanvasSide: geom.maxCanvasSide,
    textOnly: args.textOnly === true,
    // 预演：只扫描 + 排布，回报切点数与各档代价，不出图（也是"先看刀数再选档"的入口）
    planOnly: args.dryRun === true,
    // 自动分段：只传 from 时，窗口默认这么长（秒）；0 = 一直看到片尾
    ...(Number(args.segment) > 0 ? { segment: Math.round(Number(args.segment)) } : {}),
  };
}
