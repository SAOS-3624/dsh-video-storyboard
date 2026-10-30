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
export { runStoryboard, formatManifest } from './pipeline.js';

// ---- 扫描：逐帧分数、切点、以及逐帧的亮度均值与 16×9 指纹
export { scanShots, decideCuts, scanSummary, refineCutsByWindow } from './scan.js';

// ---- 切点分类：flash / white / black / hardcut / dissolve / motion（只打标签，不删点）
export { tagCuts, flashEvidence } from './flash.js';

// ---- 格位规划：按画面变化率的积分分配格子（也可以传切点密度走老路）
export { planCellRanges, densityFromScore } from './density.js';

// ---- 排版：格数与布局、画布尺寸、拼图
export { bestLayout, fillLayout, suggest } from './plan.js';
export { composeSheet, layoutCanvas } from './sheet.js';

// ---- 取流：只读容器头，不花图片 token
export { probeVideo } from './probe.js';
