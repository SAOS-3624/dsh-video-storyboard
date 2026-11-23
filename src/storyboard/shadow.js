/**
 * shadow.js — CfC 的 `cut` 头**推理**（`predictCuts`）+ 阴影对照（`shadowPass`）+ 接管闸（`liquidDecision`）。
 *
 * ## 它解决的问题
 *
 * `cut` 头在 BBC / SHOT 上是 96.4 / 73.6（±2 帧），线上运动补偿基线是 90.1 / 69.1。
 * 但那是**别人的素材**。要回答"换到我自己的片子上会不会更差"，只有一个诚实的办法：
 * 两边同时跑，逐段记下它们分歧多少。这就是 shadow —— 不改输出，只攒证据。
 *
 * ## 三档开关（`~/.dsh/video.json` 的 `sceneDetector`）
 *
 *   `hsv`     现有行为，一行不变（默认）
 *   `shadow`  两条都跑，**只写日志**；输出边界仍然来自 `hsv`
 *   `liquid`  边界改用模型出；**带兜底闸**（`liquidDecision`）—— 跑挂 / 0 刀 /
 *             刀数不到 hsv 的 40% 就退回 `hsv` 并写明原因。模型只验过"有硬切的
 *             真人剪辑"，拿它去切录屏/动效素材会几乎不出点（实测 213 刀 → 4 刀）。
 *
 * ## 两条硬约束
 *
 * 1. **不碰 hsv 路径**。所以这里不挂在 `scanShots` 的回调上，而是**自己再解一遍码**。
 *    代价是 shadow/liquid 各多一次全量解码（≈ 扫描本身的耗时），换来的是：
 *      - 扫描命中缓存、或 `precomputed` 复用时，依然有帧可用（挂在扫描上时那种情况根本没有帧）；
 *      - 降采样只发生在这一层，不污染线上扫描；
 *      - 回滚只需要把配置改回 `hsv`，不需要回滚代码。
 * 2. **任何错误都必须吞掉**。模型缺失、版本不符、OOM、ffmpeg 挂了 —— 一律记一条
 *    `ok:false` 的日志然后返回，绝不让导出失败。见 `shadowPass()` 的 catch。
 *
 * ## 与训练严格一致的三件事（错一件，分歧率就是噪声）
 *
 * 1. **特征顺序与版本**：`FEATURE_VERSION` 对不上直接拒绝加载。
 * 2. **标准化**：`(x - mean) / std`，mean/std 从模型文件里读，不许在本片重算。
 * 3. **`dt` 置零 + `dropped` 置零**：训练时它们就是 0（防帧率/片内位置泄漏），推理必须同样。
 *
 * 这三条和 `bench/eval/detectors/liquid.mjs` 是同一个口径 —— 验证办法是拿同一段素材
 * 两条路各跑一次，`predCuts` 必须逐位相同（见交接 §4 的验收）。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DIM, FEATURES, FEATURE_VERSION, createFeatures } from './features.js';
import { SCAN_H, SCAN_W, frameToHsv, mcRatioScore, scorePair } from './scan.js';
import { DEFAULT_FFMPEG } from './probe.js';
import { decodeCuts, forward, pickTheta } from './cfc.js';
import { cacheDir } from './cache.js';

/**
 * 允许的 `sceneDetector` 取值。
 *
 * ⚠️ **顺序不再代表默认值** —— 默认由 `DEFAULT_SCENE_DETECTOR` 决定（见下）。
 * 以前这里靠"第一个就是默认"隐式表达，改默认时得连带挪数组，容易漏。
 */
export const SCENE_DETECTORS = Object.freeze(['hsv', 'shadow', 'liquid', 'lnn']);

/**
 * 用户可见的名字 → 内部名字。
 *
 * 设置页和文档里说的是 **`lnn`**（"取帧算法：hsv / lnn"），而内部实现一开始叫
 * `liquid`（因为它接管边界、hsv 退成影子）。名字换了但**值不换** ——
 * 旧配置、旧日志、`bench/` 里那一堆脚本都还写着 `liquid`，一次全改会牵连几十处
 * 而没有任何行为收益。所以 `lnn` 只是入口别名，读到就规范成 `liquid`。
 */
const SCENE_ALIASES = Object.freeze({ lnn: 'liquid' });

/**
 * **默认取帧算法。**
 *
 * 2026-11-22 由用户拍板从 `hsv` 改成 `lnn`：真实成片上干净素材 +3.7、
 * 跨域留出 +5.1/+8.4，而且模型那一遍走帧复用后基本不额外花时间（见
 * `LNN-优化-交接-20261122.md` §8.4）。
 *
 * **已知代价**（选默认前必须知道）：淡入/黑场开头那一段会退化（实测 −8.8），
 * 而兜底闸是整窗口判的，挡不住局部塌陷。所以 `hsv` 必须一直是**一键可回**的退路：
 * 设置页里选 hsv、或 `runStoryboard({ sceneDetector: 'hsv' })`。
 */
export const DEFAULT_SCENE_DETECTOR = 'lnn';

/**
 * 把用户写的值规范成内部模式名。
 *
 * 空值、认不出来的值**都走默认**（`DEFAULT_SCENE_DETECTOR`）—— "写错了"和"没写"
 * 对用户来说是同一件事，不该一个用模型一个不用。
 *
 * @param {string} value `video.json` 的 `sceneDetector`，或设置页/工具参数传来的值
 * @returns {'hsv'|'shadow'|'liquid'}
 */
export function normalizeSceneDetector(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (!v) return normalizeSceneDetector(DEFAULT_SCENE_DETECTOR);
  if (!SCENE_DETECTORS.includes(v)) return normalizeSceneDetector(DEFAULT_SCENE_DETECTOR);
  return SCENE_ALIASES[v] ?? v;
}

/**
 * 内部模式名 → 用户可见的算法名。
 *
 * 设置页、清单里都说 **`lnn`**；`liquid` 只是内部实现的名字（见 `SCENE_ALIASES`）。
 */
export function sceneAlgorithmLabel(mode) {
  return mode === 'liquid' ? 'lnn' : mode;
}

/**
 * **内置模型**（随包分发，约 210 KB）。
 *
 * 早先的决定是"包里不带大件，没配 `liquidModel` 就退回 hsv"。那条在"只有开发者会开
 * liquid"时成立；现在它是一个给用户点的设置项 —— 选了算法还要手填模型路径，
 * 等于没做。所以把 v4 部署权重放进来，`liquidModel` 留作覆盖（想试别的权重才填）。
 *
 * 权重是 `--all-train` 训的（in-sample），所以它**只保证链路不崩**；
 * 要判断准不准看留出折（`out/joint-v4/`），见 `LNN-优化-交接-20261122.md` §8。
 */
export const BUNDLED_MODEL = fileURLToPath(new URL('./lnn-model.json', import.meta.url));
/**
 * 「两个切点算一致」的容差（帧）。**必须等于 `bench/eval/datasets.mjs` 的 `TOL_FRAMES`**：
 * 分歧率的判据要和 96.4 / 73.6 那两个数字同一把尺子，否则"分歧 5%"和"F1 掉 5 个点"
 * 会被当成两件事，实际上它们是一件事。
 */
export const TOL_FRAMES = 2;

/** 一次 shadow 最多收多少帧。再长就要求把 `shadowStride` 调大（不自动降采样，见文件头）。 */
export const MAX_SHADOW_FRAMES = 1_200_000;

/**
 * `liquid` 的兜底闸：模型出的刀数不到 hsv 的这个比例就不许接管。
 *
 * 为什么需要：模型只在 BBC/SHOT 这类"有硬切的真人剪辑"上验过。切到录屏/动效素材上
 * 它会**几乎不出点**（实测一支 29 分钟的 motion-graphics 解析片：hsv 213 刀、模型 4 刀，
 * 比值 1.9%）。没有这道闸，`liquid` 会把整片压成几帧 —— 这不是"效果差一点"，
 * 是**输出直接不可用**。
 *
 * 0.4 不是调出来的阈值，是"吹哨"用的：真剪辑片上模型与 hsv 的刀数一直在同一量级
 * （BBC 31 vs 29、SHOT 12 vs 12），掉到 40% 以下只可能是域不对。
 */
export const LIQUID_MIN_RATIO = 0.4;

/**
 * `liquid` 该不该接管。**纯函数** —— 判据和日志分开，才测得动。
 *
 * 注意这里**只看"能不能用"，不看"谁更准"**：更准与否是 shadow 日志要回答的问题，
 * 而这条闸只回答"让模型出边界会不会把这一段搞坏"。
 *
 * @param {{ok?:boolean, cutsHsv?:number, cutsLiquid?:number, error?:string|null}} o
 * @returns {{accept:boolean, reason:string|null}}
 */
export function liquidDecision({
  ok = true, cutsHsv = 0, cutsLiquid = 0, error = null,
} = {}) {
  if (!ok) return { accept: false, reason: `模型没跑成：${error ?? '未知原因'}` };
  if (cutsLiquid === 0 && cutsHsv === 0) return { accept: false, reason: '两边都没出点，没必要换' };
  if (cutsLiquid === 0) return { accept: false, reason: `模型 0 刀（hsv 有 ${cutsHsv} 刀），这类素材它不认` };
  if (cutsHsv > 0 && cutsLiquid < cutsHsv * LIQUID_MIN_RATIO) {
    return {
      accept: false,
      reason: `模型只出 ${cutsLiquid} 刀，不到 hsv ${cutsHsv} 刀的 ${Math.round(LIQUID_MIN_RATIO * 100)}%（域不对，退回 hsv）`,
    };
  }
  return { accept: true, reason: null };
}

/**
 * 默认日志位置：`cacheDir()/shadow-cuts.jsonl`。
 *
 * 和 `seen.jsonl` / `watch.json` 同一个目录 —— 那是插件的数据目录，而 `pruneCache()`
 * 只清 `*.json`，`.jsonl` 不会被当成缓存删掉。`_pv_frames` 那种"跑完就丢"的临时目录不合适：
 * 分歧率是要攒起来做判断的。
 */
export function shadowLogPath(env = process.env) {
  return join(cacheDir(env), 'shadow-cuts.jsonl');
}

/**
 * 读 `~/.dsh/video.json` 里的取帧算法配置。**两个键都可缺省**，缺省 = `DEFAULT_SCENE_DETECTOR`
 * （当前是 `lnn`；要回到纯像素差分就显式写 `"sceneDetector": "hsv"`）。
 *
 * `shadowFrames`：
 *   `tap`（默认）  扫描那一遍顺便把帧喂给模型，**模型不再单独解码**
 *   `decode`       老行为：模型自己再解一遍（想单独回滚"帧复用"这一条时用）
 *
 * @param {object} cfg 已经解析过的 video.json
 * @param {{env?:object}} [o] 只给测试用；`shadowLog` 可覆盖日志路径
 * @returns {{mode:string, model:string|null, stride:number, logPath:string, note:string|null}}
 */
export function readSceneConfig(cfg = {}, { env = process.env } = {}) {
  const raw = cfg && typeof cfg === 'object' ? cfg : {};
  const modeRaw = String(raw.sceneDetector ?? '').trim().toLowerCase();
  const known = !modeRaw || SCENE_DETECTORS.includes(modeRaw);
  const model = typeof raw.liquidModel === 'string' && raw.liquidModel.trim()
    ? raw.liquidModel.trim()
    : null;
  const stride = Math.max(1, Math.min(60, Math.round(Number(raw.shadowStride) || 1)));
  const framesRaw = String(raw.shadowFrames ?? '').trim().toLowerCase();
  const frames = framesRaw === 'decode' ? 'decode' : 'tap';
  const logPath = typeof raw.shadowLog === 'string' && raw.shadowLog.trim()
    ? raw.shadowLog.trim()
    : shadowLogPath(env);
  // 认不出来的名字不静默当默认：悄悄降级会让人以为 shadow 开着而一条日志都没有
  if (!known) {
    return {
      mode: normalizeSceneDetector(''),
      model, stride, frames, logPath,
      note: `sceneDetector 不认识：${modeRaw}；这次按 ${DEFAULT_SCENE_DETECTOR} 跑`,
    };
  }
  return {
    mode: normalizeSceneDetector(modeRaw), model, stride, frames, logPath, note: null,
  };
}

/** 升序数值数组；丢掉 NaN 与非数字。 */
function toSortedNums(list) {
  if (!Array.isArray(list)) return [];
  return list.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
}

/** 升序数组里第一个 ≥ v 的下标。 */
function lowerBound(arr, v) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < v) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/**
 * 两组切点按「≤ tol 帧」做**一对一**匹配，再算分歧率。
 *
 * 匹配规则与评测侧（`bench/eval/metrics.mjs` 的 `matchPoints`）同构：按时间差从小到大
 * 贪心配对，每个点只能用一次。这里多了个二分窗口 —— 只有落在 tol 内的候选对才进排序，
 * 于是稀疏素材上是 O(n log m)，而不会退化成 n×m 的全对。
 *
 * `divergenceRate = 1 - 2·agreed/(cutsHsv + cutsLiquid)`：
 *   - 完全一致 → 0；两边完全不重叠 → 1（一方点数明显更多时也不会饱和）；
 *   - **两边都是 0 个切点时必须兜底成 0**，否则 0/0 = NaN，那一行日志就废了。
 *   另一条恒等式：`divergent = cutsHsv + cutsLiquid - 2·agreed`，
 *   于是 `divergenceRate === divergent / (cutsHsv + cutsLiquid)` —— 两个读数永远自洽。
 *
 * @param {number[]} cutsHsv    线上判据的切点（秒，可乱序）
 * @param {number[]} cutsLiquid 模型判据的切点（秒）
 * @param {{fps?:number, tolFrames?:number}} [o]
 * @returns {{agreed:number, divergent:number, divergenceRate:number,
 *            onlyHsv:number[], onlyLiquid:number[], cutsHsv:number, cutsLiquid:number}}
 */
export function compareCuts(cutsHsv, cutsLiquid, { fps = 25, tolFrames = TOL_FRAMES } = {}) {
  const A = toSortedNums(cutsHsv);
  const B = toSortedNums(cutsLiquid);
  const tol = tolFrames / Math.max(1, Number(fps) || 25);

  const pairs = [];
  for (let i = 0; i < A.length; i += 1) {
    for (let j = lowerBound(B, A[i] - tol); j < B.length && B[j] <= A[i] + tol; j += 1) {
      pairs.push({ i, j, d: Math.abs(A[i] - B[j]) });
    }
  }
  pairs.sort((x, y) => x.d - y.d || x.i - y.i || x.j - y.j);

  const usedA = new Set();
  const usedB = new Set();
  for (const { i, j } of pairs) {
    if (usedA.has(i) || usedB.has(j)) continue;
    usedA.add(i);
    usedB.add(j);
  }

  const agreed = usedA.size;
  const onlyHsv = A.filter((_, i) => !usedA.has(i));
  const onlyLiquid = B.filter((_, j) => !usedB.has(j));
  const total = A.length + B.length;
  const divergent = total - 2 * agreed;
  const divergenceRate = total === 0 ? 0 : +(divergent / total).toFixed(3);
  return {
    agreed, divergent, divergenceRate, onlyHsv, onlyLiquid,
    cutsHsv: A.length, cutsLiquid: B.length,
  };
}

/**
 * 加载模型并校验。**校验失败就 throw** —— 调用方（`shadowPass`）负责吞掉并记日志。
 *
 * `path` 为空时用**内置模型**（`BUNDLED_MODEL`）—— 设置页里选 lnn 就不必再填路径。
 *
 * @param {string} [path]
 * @returns {Promise<{path:string, model:object, mean:Float64Array, std:Float64Array,
 *                    theta:number, thetaQ:number, format:string, marksUsable:boolean,
 *                    dtIdx:number, dropped:Set<string>, units:number, dim:number}>}
 */
export async function loadLiquidModel(path) {
  const target = path || BUNDLED_MODEL;
  if (!existsSync(target)) {
    throw new Error(path
      ? `模型文件不存在：${target}`
      : `内置模型缺失：${target}（安装包不完整，请重装插件）`);
  }
  const j = JSON.parse(await readFile(target, 'utf8'));
  if (j.format !== 'cfc-json-v1' && j.format !== 'cfc-json-v2') {
    throw new Error(`模型格式不认识：${j.format}`);
  }
  if (j.featureVersion !== FEATURE_VERSION) {
    throw new Error(`特征版本不匹配：模型 ${j.featureVersion} / 当前 ${FEATURE_VERSION}`);
  }
  if (!Array.isArray(j.mean) || !Array.isArray(j.std)) {
    throw new Error('模型里没有 mean/std —— 训练时必须带标准化，否则推理会"能跑但全错"');
  }
  if (j.dim !== DIM || j.mean.length !== DIM || j.std.length !== DIM) {
    throw new Error(`模型维数对不上：dim ${j.dim} / mean ${j.mean?.length} / std ${j.std?.length}，当前特征 ${DIM} 维`);
  }
  if (!Array.isArray(j.heads) || !j.heads.includes('cut')) {
    throw new Error('模型里没有 cut 头 —— shadow 只比切点，别的头一概不用');
  }
  const m = { dim: j.dim, units: j.units, zdim: j.dim + j.units, heads: j.heads };
  for (const [k, v] of Object.entries(j.params ?? {})) m[k] = Float64Array.from(v);
  return {
    // 一定是**真实**路径（没配时是内置模型那条），日志里 `model` 字段要能一眼看出用的哪个
    path: target,
    model: m,
    mean: Float64Array.from(j.mean),
    std: Float64Array.from(j.std),
    theta: j.theta ?? 0.5,
    thetaQ: j.thetaQ ?? 0.5,
    format: j.format,
    /** `qWeight: 0` 的模型 `q` 头是随机初始化的，绝不能消费（本文件也确实不消费）。 */
    marksUsable: j.format === 'cfc-json-v2' && j.heads.includes('q') && j.qWeight !== 0,
    dtIdx: FEATURES.indexOf('dt'),
    dropped: new Set(j.dropped ?? []),
    units: j.units,
    dim: j.dim,
  };
}

/**
 * 特征收集器：把一帧 HSV 追加成 `n × DIM` 矩阵的一行（含标准化 + dt/dropped 置零）。
 *
 * **解码路径和"扫描顺便喂帧"路径共用这一份**。分开写两份的话，
 * 标准化或置零迟早会漂，而漂了以后分歧率看起来完全正常 —— 这个项目最恨的就是这种错。
 */
function createSink({ md, fpsEff, stride, estimate = 4096 }) {
  const { mean, std, dtIdx, dropped } = md;
  const feats = createFeatures({
    w: SCAN_W, h: SCAN_H, fps: fpsEff, longSec: 0.4, scorePair,
    mcScore: mcRatioScore, mcOpts: { tau: 15, radius: 2 },
  });
  let cap = Math.max(1024, Math.min(estimate, MAX_SHADOW_FRAMES + 8));
  let X = new Float32Array(cap * DIM);
  let count = 0;
  let truncated = false;
  return {
    stride,
    get n() { return count; },
    /** 追加一帧。返回 false = 已经满了（`truncated` 已置位），调用方应当收工。 */
    push(hsv, t) {
      if (count >= MAX_SHADOW_FRAMES) { truncated = true; return false; }
      const f = feats.push(hsv, t);
      if (count >= cap) {
        const nextCap = Math.min(MAX_SHADOW_FRAMES + 8, cap * 2);
        const next = new Float32Array(nextCap * DIM);
        next.set(X.subarray(0, count * DIM));
        X = next;
        cap = nextCap;
      }
      const base = count * DIM;
      for (let d = 0; d < DIM; d += 1) {
        let v = (f[d] - mean[d]) / std[d];
        if (d === dtIdx) v = 0;                        // 与训练一致：防帧率泄漏
        if (dropped.has(FEATURES[d])) v = 0;
        X[base + d] = v;
      }
      count += 1;
      return true;
    },
    done() { return { X, n: count, stride, truncated }; },
  };
}

/**
 * 提前打开"帧出口"，交给 `scanShots` 的 `onFrame`，**模型那一遍就不必再解一次码**。
 *
 * ## 为什么值得（实测，60s 640×360）
 *
 *   扫描（硬解）        1885 ms
 *   模型那一遍（软解）  4891 ms   ← 相当于把整条链路的 wall time 翻倍
 *   复用扫描的帧        ≈ 32 ms    ← 只剩 CfC 前向（特征已经摊在扫描那一遍里了）
 *
 * ## 三条保证（文件头"两条硬约束"里那三条，一条都没丢）
 *
 * 1. **缓存命中时也能跑**：扫描命中缓存时 `onFrame` 一次都不会被调，
 *    `result()` 返回 `null`，调用方自动退回自己解码（`collectMatrix`）。
 * 2. **不污染线上**：这里只**读**扫描给出的 HSV 缓冲，不写；回调抛错只关掉出口
 *    （`scanShots` 里 try/catch），扫描照常跑完。
 * 3. **回滚仍然只改配置**：`sceneDetector: 'hsv'` 时这个函数根本不会被调用。
 *    想单独回滚"帧复用"这一条：`shadowFrames: 'decode'`（见 `readSceneConfig`）。
 *
 * @returns {Promise<{md:object|null, error:string|null, onFrame:Function|null,
 *                    result:Function, seen:number}>} 模型加载失败时 `md=null`，
 *          此时 `onFrame` 也是 null，`shadowPass` 会照常记一条 `ok:false`。
 */
export async function openFrameTap({ modelPath, fps, stride = 1, estimate = 4096 }) {
  // fps 不合法时不要建（`t = n / (fps/step)` 会算出 Infinity，特征全脏）。返回一个死的。 --
  if (!(fps > 0)) {
    return {
      md: null, error: `fps 不合法：${fps}`, onFrame: null, result: () => null, seen: 0,
    };
  }
  let md;
  try {
    md = await loadLiquidModel(modelPath);
  } catch (e) {
    return {
      md: null, error: String(e?.message ?? e).slice(0, 200), onFrame: null, result: () => null, seen: 0,
    };
  }
  const step = Math.max(1, Math.round(stride));
  const fpsEff = fps / step;
  const sink = createSink({ md, fpsEff, stride: step, estimate });
  let seenRaw = 0;
  let dead = false;
  return {
    md,
    error: null,
    get seen() { return seenRaw; },
    /** 交给 `scanShots({ onFrame })`。**永不抛错**，只可能是"静默关掉自己"。 */
    onFrame(hsv) {
      if (dead) return;
      const keep = seenRaw % step === 0;
      seenRaw += 1;
      if (!keep) return;
      try {
        sink.push(hsv, sink.n / fpsEff);
      } catch {
        dead = true;
      }
    },
    /** 扫描结束后取结果。少于 2 帧（缓存命中/解码失败/步长太大）就返回 null → 退回自己解码。 */
    result() { return dead || sink.n < 2 ? null : sink.done(); },
  };
}

/**
 * 第二遍解码 + 抽 14 维 + 标准化，直接写成 `n × DIM` 的矩阵。
 *
 * **spawn 参数必须与 `scan.js:scanShots` 逐字一致**（`-skip_loop_filter all`、
 * `scale=W:H:flags=area`、`format=rgb24`）—— 换一个参数，模型看到的就是另一批像素，
 * 分歧率会莫名其妙地偏。`_pv_frames` 时代的训练特征也是这条命令出来的。
 *
 * `stride > 1` 时按每 stride 帧取一帧，并且把 `fps` 也按同比例降下来喂给 `createFeatures`，
 * 这样 `s_long` 的窗口仍是 0.4 秒。**但 `s_adj` 会整体抬高**（相邻样本隔得更远），
 * 模型的 `theta` 不再成立 —— 只可用来"看分歧率"，不可用来出边界。
 *
 * `hwaccel`：与扫描同一档硬件解码。**这一遍原本是软解** —— 实测同一支 640×360 的片子
 * 软解 13.7s / `cuda` 3.9s，等于模型这半边白慢 2.4 倍。⚠️ 硬解出来的 64×36 帧在部分片源上
 * 与软解**不完全逐字节相同**（实测 4.4% 的字节不同、平均差 0.08/255、最大 15），
 * 所以要跟 `liquid.mjs` 做"逐位对拍"时，两条路必须走同一条解码路径
 * （`DSH_HWACCEL=none`，或者干脆用帧复用那条路）。
 *
 * @returns {Promise<{X:Float32Array, n:number, stride:number, truncated:boolean}>}
 */
async function collectMatrix({
  input, fps, start = 0, end, stride = 1, ffmpegPath = DEFAULT_FFMPEG, signal, md, hwaccel = null,
}) {
  const step = Math.max(1, Math.round(stride));
  const fpsEff = fps / step;
  const estimate = Number.isFinite(end) && end > start
    ? Math.ceil(((end - start) * fps) / step) + 8
    : 4096;
  const sink = createSink({ md, fpsEff, stride: step, estimate });

  const n = SCAN_W * SCAN_H;
  const frameBytes = n * 3;
  const hsv = new Float32Array(n * 3);

  await new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, [
      '-hide_banner', '-v', 'error', '-nostdin',
      ...(start > 0 ? ['-ss', String(start)] : []),
      ...(Number.isFinite(end) ? ['-t', String(Math.max(0.1, end - start))] : []),
      // 硬件解码必须在 -i 之前（与 scanShots 同一条规矩，见 hwaccel.js）
      ...(hwaccel ? ['-hwaccel', hwaccel] : []),
      '-skip_loop_filter', 'all',
      '-i', input, '-an', '-sn',
      '-vf', `scale=${SCAN_W}:${SCAN_H}:flags=area,format=rgb24`, '-f', 'rawvideo', '-',
    ], { stdio: ['ignore', 'pipe', 'pipe'], signal, windowsHide: true });

    let pending = Buffer.alloc(0);
    let seen = 0;
    let killedByUs = false;
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      while (pending.length >= frameBytes) {
        const slice = pending.subarray(0, frameBytes);
        pending = pending.subarray(frameBytes);
        const keep = seen % step === 0;
        seen += 1;
        if (!keep) continue;
        frameToHsv(slice, hsv);
        if (!sink.push(hsv, sink.n / fpsEff)) {
          // 到上限就收工。**必须记下来** —— 拿半条时间轴算出来的分歧率是残的，
          // 而它看起来和完整的一样（这个项目最恨的就是"看不出哪里错"）。
          killedByUs = true;
          child.kill('SIGKILL');
          return;
        }
      }
    });
    child.stderr.on('data', (d) => { if (stderr.length < 8192) stderr += d; });
    child.on('error', (e) => reject(new Error(`ffmpeg spawn 失败：${e.message}`)));
    child.on('close', (code) => {
      /**
       * 只认两种"成功"：正常放完（0），或**我们自己**掐掉的（到帧数上限）。
       *
       * 别写成 `|| count > 0` —— 那会把"解到一半 ffmpeg 崩了"当成跑完了，
       * 于是用半条时间轴算出一个看起来很正常的残分歧率。
       */
      if (code === 0 || killedByUs) { resolve(); return; }
      if (signal?.aborted) { reject(new Error('已取消')); return; }
      reject(new Error(`ffmpeg 退出 ${code}：${String(stderr).slice(0, 300)}`));
    });
  });

  if (sink.n === 0) throw new Error('一帧都没解出来');
  return sink.done();
}

/** 时间戳只留前 10 个（对齐到毫秒），避免日志爆掉；总数另记。 */
const HEAD = 10;
const headOf = (arr) => arr.slice(0, HEAD).map((v) => +Number(v).toFixed(3));

/**
 * 只出模型那边的切点（不比较、不写日志）。`shadowPass` 的前半段，单独导出是为了
 * **能和 `bench/eval/detectors/liquid.mjs` 对拍**：同一段素材两条路的 `predCuts`
 * 必须逐位相同，否则"特征/标准化/dropped 三件事与训练一致"就只是口头承诺。
 *
 * @param {object} o 同 `shadowPass`，但要求先 `loadLiquidModel` 得到的 `md`
 * @param {object} o.md `loadLiquidModel()` 的返回值
 * @param {{X:Float32Array,n:number,stride:number,truncated:boolean}|null} [o.tapped]
 *   扫描顺便喂过来的帧（`openFrameTap().result()`）。给了就用它，**不再解码**；
 *   为 null / 帧数不足时自动退回 `collectMatrix`。
 * @returns {Promise<{predCuts:number[], pred:Array, theta:number, sampled:number,
 *                    stride:number, msPass:number, msForward:number, framesFrom:string}>}
 */
export async function predictCuts({
  input, fps, start = 0, end, stride = 1, ffmpegPath = DEFAULT_FFMPEG, signal, md,
  tapped = null, hwaccel = null,
}) {
  const t0 = Date.now();
  const useTap = Boolean(tapped && tapped.n >= 2);
  const matrix = useTap ? tapped : await collectMatrix({
    input,
    fps,
    start,
    end: Number.isFinite(Number(end)) ? Number(end) : undefined,
    stride,
    ffmpegPath,
    signal,
    md,
    hwaccel,
  });
  // `framesFrom` 进日志与返回：`tap` 表示这一遍一帧都没解（wall time 里没有解码），
  // `decode` 表示扫描没喂帧（缓存命中/帧出口被关掉），自己解了一遍。
  const framesFrom = useTap ? 'tap' : 'decode';
  const msPass = useTap ? 0 : Date.now() - t0;

  const rows = new Array(matrix.n);
  const dts = new Float64Array(matrix.n);
  const dt = 1 / (fps / matrix.stride);
  for (let i = 0; i < matrix.n; i += 1) { rows[i] = i; dts[i] = dt; }

  const fw0 = Date.now();
  const { out } = forward(md.model, matrix.X, rows, dts);
  const msForward = Date.now() - fw0;

  const fpsEff = fps / matrix.stride;
  /**
   * 阈值**按本片的噪声自适应**，不用模型文件里那个固定值。
   *
   * 模型自带的 `md.theta`（部署模型 0.92）是学习期在 BBC 上标的：慢节奏合适，
   * 快剪素材会欠检（SHOT 上 10 刀只报 1 刀）。实测自适应后 BBC 94.8→95.3、SHOT 69.5→76.9。
   * 判据只看概率序列（见 `cfc.js:pickTheta`），不碰真值，所以可以在线上直接用。
   */
  const thetaAuto = pickTheta(out.cut, { fps: fpsEff });
  // 时间轴换算：第 i 个样本对应 `i / fpsEff` 秒；decodeCuts 用 fpsEff 就是为了这一点
  const predCuts = decodeCuts(out.cut, { fps: fpsEff, theta: thetaAuto });
  /**
   * 出点连同**它自己的概率**一起带出去。
   *
   * `liquid` 接管时要拿这批点去排布，而 `suppressClose`（丐中丐档的近邻合并）比的是
   * `cut.score` —— 没有分数就只能"留第一个"，那会把模型的置信度丢掉。
   */
  const pred = predCuts.map((t) => {
    const i = Math.min(out.cut.length - 1, Math.max(0, Math.round(t * fpsEff)));
    return { t, score: out.cut[i] };
  });
  return {
    predCuts,
    pred,
    theta: thetaAuto,
    sampled: matrix.n,
    stride: matrix.stride,
    truncated: matrix.truncated,
    framesFrom,
    msPass,
    msForward,
  };
}

/**
 * 跑一次阴影对照。**永不抛错**。
 *
 * 成功时写一行 `ok:true` 的 JSONL；任何失败（模型缺失/版本不符/解码挂了）都写
 * `ok:false` + `error` 然后返回 —— 这是本次接入的第一风险点：**绝不能让主流程失败**。
 *
 * @param {object} o
 * @param {string} o.input       本地视频路径
 * @param {number} o.fps
 * @param {number} [o.start]     窗口起点（秒）—— cut 的时间轴是**窗口相对**的
 * @param {number} [o.end]       窗口终点（秒）
 * @param {number} [o.duration]
 * @param {number} [o.frames]    线上扫描数到的帧数（仅用于日志对照）
 * @param {Array<{t:number}>|number[]} o.cuts 线上 hsv 判据的最终切点
 * @param {number|null} [o.thetaHsv] 线上扫描用的阈值
 * @param {string} [o.modelPath]
 * @param {number} [o.stride]
 * @param {string} [o.logPath]
 * @param {string} [o.ffmpegPath]
 * @param {AbortSignal} [o.signal]
 * @param {boolean} [o.writeLog] false = 只算不写（测试用）
 * @returns {Promise<object>} 写进日志的那条记录
 */
export async function shadowPass(o) {
  const {
    input, fps, start = 0, end, duration, frames = null,
    cuts = [], thetaHsv = null, modelPath = null, stride = 1,
    logPath = shadowLogPath(), ffmpegPath = DEFAULT_FFMPEG,
    signal, writeLog = true,
    /** `openFrameTap()` 的返回值：扫描已经顺便把帧喂好了，这一遍不再解码。 */
    tap = null,
    /** 与扫描同一档硬件解码（只在"自己解码"那条路上生效）。 */
    hwaccel = null,
  } = o;

  const base = {
    /**
     * 日志口径版本。**字段含义一变就得加 1**（和 `FEATURE_VERSION` 一个道理）：
     *   v1：`onlyHsv` / `onlyLiquid` 是**窗口相对**秒；多了 `path`（抽帧要用）。
     * 加它是因为踩过一次：早先时间没减 `window.from`，同一批日志里两种基准混着，
     * 而报告完全看不出来 —— 旧行只能在 `shadow-report` 里被标成"旧口径"。
     */
    v: 1,
    ts: new Date().toISOString(),
    video: input ? basename(String(input)) : null,
    // 全路径也留着：`shadow-report --montage` 要拿它抽"分歧点前后帧"，
    // 只有 basename 的话那一步就得人肉找片
    path: input ? String(input) : null,
    fps: Number(fps) || null,
    duration: Number.isFinite(Number(duration)) ? +Number(duration).toFixed(3) : null,
    window: { from: +Number(start).toFixed(3), to: Number.isFinite(Number(end)) ? +Number(end).toFixed(3) : null },
  };

  const t0 = Date.now();
  try {
    if (!(fps > 0)) throw new Error(`fps 不合法：${fps}`);
    // 模型可能已经在 `openFrameTap()` 里加载过（帧出口需要 mean/std），别加载两次
    const md = tap?.md ?? await loadLiquidModel(modelPath);
    const r = await predictCuts({
      input, fps, start, end, stride, ffmpegPath, signal, md,
      tapped: tap ? tap.result() : null,
      hwaccel,
    });

    const hsvTimes = Array.isArray(cuts)
      ? cuts.map((c) => (typeof c === 'number' ? c : c?.t)).filter(Number.isFinite)
      : [];

    /**
     * **时间基准必须先对齐再比。**
     *
     * 管线里的 `cuts` 是**绝对时间**（`scanShots` 里 `t = start + frame/fps`，见
     * `pipeline.js` 的 `absCuts`），而模型这一遍是从窗口起点解码的，`predCuts` 是
     * **窗口相对秒**。差一个 `start` 的话，窗口起点不为 0 的素材会得到"0 个一致"这种
     * 假分歧（BBC 300–600s 那段实测就是 100%，全是这个偏移造成的）。
     *
     * 落进日志的所有时间（含 `onlyHsv` / `onlyLiquid`）一律是**窗口相对**的，
     * 加回 `window.from` 就是绝对时间 —— 与 `window` 字段放在一起才自洽。
     */
    const rel = Number(start) || 0;
    const hsvRel = hsvTimes.map((t) => +(t - rel).toFixed(3));

    const cmp = compareCuts(hsvRel, r.predCuts, { fps, tolFrames: TOL_FRAMES });
    const record = {
      ...base,
      frames: frames ?? r.sampled,
      sampled: r.sampled,
      stride: r.stride,
      thetaHsv: Number.isFinite(Number(thetaHsv)) ? Number(thetaHsv) : null,
      thetaLiquid: r.theta,
      // 模型文件里那个固定值也留着：两条数一起看才知道"自适应到底改了什么"
      thetaModel: md.theta,
      model: basename(String(md.path)),
      cutsHsv: cmp.cutsHsv,
      cutsLiquid: cmp.cutsLiquid,
      agreed: cmp.agreed,
      divergent: cmp.divergent,
      divergenceRate: cmp.divergenceRate,
      onlyHsv: headOf(cmp.onlyHsv),
      onlyLiquid: headOf(cmp.onlyLiquid),
      onlyHsvTotal: cmp.onlyHsv.length,
      onlyLiquidTotal: cmp.onlyLiquid.length,
      // msFeature = 这一遍重扫（解码 + 14 维）**减去**前向；msForward 单独量
      // `framesFrom: 'tap'` 时没有重扫，msFeature 会接近 0 —— 这是对的，不是没量到
      msFeature: Math.max(0, r.msPass - r.msForward),
      msForward: r.msForward,
      framesFrom: r.framesFrom,
      ...(r.truncated ? { truncated: true } : {}),
      ok: true,
    };
    const notes = [];
    if (r.truncated) {
      notes.push(`帧数超过 ${MAX_SHADOW_FRAMES} 上限，只跑了前 ${r.sampled} 帧 —— 分歧率是残的`);
    }
    if (r.stride > 1) {
      notes.push('stride>1：s_adj 被抬高、theta 不成立，只能看分歧率，不能用它出边界');
    }
    if (r.framesFrom === 'tap') {
      notes.push('帧复用：这一遍没有单独解码，用的是扫描那一遍的帧');
    } else if (tap) {
      notes.push(`扫描没喂到帧（${tap.error ?? '缓存命中或帧出口被关掉'}），自己解了一遍`);
    }
    if (notes.length) record.note = notes.join('；');
    if (writeLog) await appendShadowLog(logPath, record);
    /**
     * `pred` **只在返回值里，不进日志**：`liquid` 接管时要拿它去排布（还带着概率），
     * 而日志是给人看的、也是要攒的 —— 几百个 {t, score} 塞进去只会让它变成二进制。
     */
    return { ...record, pred: r.pred };
  } catch (e) {
    const record = {
      ...base,
      frames,
      thetaHsv: Number.isFinite(Number(thetaHsv)) ? Number(thetaHsv) : null,
      cutsHsv: Array.isArray(cuts) ? cuts.length : 0,
      ok: false,
      error: String(e?.message ?? e).slice(0, 200),
      ms: Date.now() - t0,
    };
    if (writeLog) await appendShadowLog(logPath, record);
    return record;
  }
}

/**
 * 追加一行 JSONL。**永不抛错** —— 日志写不进去（盘满、权限）不该让导出失败。
 *
 * @returns {Promise<boolean>} 写成功了吗（只用于测试与诊断）
 */
export async function appendShadowLog(path, record) {
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}
