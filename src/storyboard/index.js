/**
 * storyboard/index.js — 这一侧对外的**公开 API**。
 *
 * 谁在用：
 *   1. `src/index.js` —— 注册四个工具（走 `./register.js`，不从这里走）
 *   2. 拆出去的 watch 插件 —— 通过 `dsh-video-storyboard/storyboard` 引用
 *
 * 这里只导出"别人真的需要"的东西。缓存目录、ffmpeg 路径、ASR 生命周期
 * 这些是实现细节，留在各自模块里，不往公开面上放 —— 一旦放出去就改不动了。
 *
 * 依赖方向是**单向**的：storyboard 不 import 任何 watch 的东西（有分层测试守着）。
 * 所以这一侧可以单独打包、单独发布，watch 那边删掉也不影响这里。
 */

// ---- 主流程：跑一次分镜，拿到宫格图 + 清单
export { runStoryboard, formatManifest, formatPlanPreview } from './pipeline.js';

// ---- 扫描：逐帧分数、切点、以及逐帧的亮度均值与 16×9 指纹
export { scanShots, decideCuts, scanSummary, refineCutsByWindow } from './scan.js';
// 判据的零件（暗场/黑边的分数归一、事件聚类、渐变转场）——
// watch 那边想自己重判同一份 stats 时需要它们，别在外部复制一套阈值。
export {
  normalizeScores, barFraction, cutBudget, cutsFromEvents, detectGradual, detectDarkRuns,
  REF_V, GAIN_MAX, LONG_SEC,
} from './scan.js';

// ---- 切点分类：flash / white / black / hardcut / dissolve / motion（只打标签，不删点）
export { tagCuts, flashEvidence } from './flash.js';

// ---- 档位：切点密度 → 1..8 档（格子边长 1/k）、积分取帧、升降档策略
export {
  LEVEL_THRESHOLDS, HYSTERESIS, TIER_MIN, TIER_MAX, STRATEGIES, STRATEGY_NAMES,
  DEFAULT_STRATEGY, applyStrategy, fitCanvas, framesFromBounds, integralMarks, levelAt,
  levelCurve, readabilityOf, tierHistogram, tierSizes, tierSide,
} from './tiers.js';

// ---- 排布：档位序列 → 归一化矩形（按行精确最优），以及拼图
export { solve, toRects, bestPlan, rowOptions, precompute, bounds, UNIT, DEFAULT_GROW, DEFAULT_STRETCH } from './pack.js';
export { composePacked, badgeScale, drawBadgePlain, drawGlyphsOutlined, blit } from './sheet.js';

// ---- 取流：只读容器头，不花图片 token
export { probeVideo } from './probe.js';
