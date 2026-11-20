/**
 * shadow.js — 阴影模式：让 CfC 的 `cut` 头和线上的 HSV 判据**并排跑**，只写日志、不改任何输出。
 *
 * ## 它解决的问题
 *
 * `cut` 头在 BBC / SHOT 上是 96.4 / 73.6（±2 帧），线上运动补偿基线是 90.1 / 69.1。
 * 但那是**别人的素材**。要回答"换到我自己的片子上会不会更差"，只有一个诚实的办法：
 * 两边同时跑，逐段记下它们分歧多少。这就是 shadow。
 *
 * ## 三档开关（`~/.dsh/video.json` 的 `sceneDetector`）
 *
 *   `hsv`     现有行为，一行不变（默认，也是唯一已上线的路径）
 *   `shadow`  两条都跑，**只写日志**；输出边界仍然来自 `hsv`
 *   `liquid`  边界改用模型出（**还没做**，等日志攒够再说）
 *
 * ## 两条硬约束
 *
 * 1. **不碰 hsv 路径**。所以这里不挂在 `scanShots` 的回调上，而是**自己再解一遍码**。
 *    代价是 shadow 模式多一次全量解码（≈ 扫描本身的耗时），换来的是：
 *      - 扫描命中缓存、或 `precomputed` 复用时，依然有帧可用（挂在扫描上时那种情况根本没有帧）；
 *      - 降采样只发生在 shadow 里，不污染线上扫描；
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
 * 两条路各跑一次，`predCuts` 必须逐位相同（见交接 §5 的验收）。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { DIM, FEATURES, FEATURE_VERSION, createFeatures } from './features.js';
import { SCAN_H, SCAN_W, frameToHsv, mcRatioScore, scorePair } from './scan.js';
import { DEFAULT_FFMPEG } from './probe.js';
import { decodeCuts, forward } from './cfc.js';
import { cacheDir } from './cache.js';

/** 允许的 `sceneDetector` 取值。**顺序即优先级**：第一个是默认值。 */
export const SCENE_DETECTORS = Object.freeze(['hsv', 'shadow', 'liquid']);

/**
 * 「两个切点算一致」的容差（帧）。**必须等于 `bench/eval/datasets.mjs` 的 `TOL_FRAMES`**：
 * 分歧率的判据要和 96.4 / 73.6 那两个数字同一把尺子，否则"分歧 5%"和"F1 掉 5 个点"
 * 会被当成两件事，实际上它们是一件事。
 */
export const TOL_FRAMES = 2;

/** 一次 shadow 最多收多少帧。再长就要求把 `shadowStride` 调大（不自动降采样，见文件头）。 */
export const MAX_SHADOW_FRAMES = 1_200_000;

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
 * 读 `~/.dsh/video.json` 里的阴影配置。**两个键都可缺省**，缺省 = `hsv`（行为与今天完全一致）。
 *
 * @param {object} cfg 已经解析过的 video.json
 * @param {{env?:object}} [o] 只给测试用；`shadowLog` 可覆盖日志路径
 * @returns {{mode:string, model:string|null, stride:number, logPath:string, note:string|null}}
 */
export function readSceneConfig(cfg = {}, { env = process.env } = {}) {
  const raw = cfg && typeof cfg === 'object' ? cfg : {};
  const mode = String(raw.sceneDetector ?? '').trim().toLowerCase();
  const model = typeof raw.liquidModel === 'string' && raw.liquidModel.trim()
    ? raw.liquidModel.trim()
    : null;
  const stride = Math.max(1, Math.min(60, Math.round(Number(raw.shadowStride) || 1)));
  const logPath = typeof raw.shadowLog === 'string' && raw.shadowLog.trim()
    ? raw.shadowLog.trim()
    : shadowLogPath(env);
  // 认不出来的名字不静默当 hsv：悄悄降级会让人以为 shadow 开着而一条日志都没有
  if (mode && !SCENE_DETECTORS.includes(mode)) {
    return { mode: 'hsv', model, stride, logPath, note: `sceneDetector 不认识：${mode}` };
  }
  return { mode: mode || 'hsv', model, stride, logPath, note: null };
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
 * @param {string} path
 * @returns {Promise<{path:string, model:object, mean:Float64Array, std:Float64Array,
 *                    theta:number, thetaQ:number, format:string, marksUsable:boolean,
 *                    dtIdx:number, dropped:Set<string>, units:number, dim:number}>}
 */
export async function loadLiquidModel(path) {
  if (!path) throw new Error('没配 liquidModel（video.json 里给一个 .json 模型路径）');
  if (!existsSync(path)) throw new Error(`模型文件不存在：${path}`);
  const j = JSON.parse(await readFile(path, 'utf8'));
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
    path,
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
 * @returns {Promise<{X:Float32Array, n:number, stride:number}>}
 */
async function collectMatrix({
  input, fps, start = 0, end, stride = 1, ffmpegPath = DEFAULT_FFMPEG, signal, md,
}) {
  const step = Math.max(1, Math.round(stride));
  const fpsEff = fps / step;
  const { mean, std, dtIdx, dropped } = md;
  const feats = createFeatures({
    w: SCAN_W, h: SCAN_H, fps: fpsEff, longSec: 0.4, scorePair,
    mcScore: mcRatioScore, mcOpts: { tau: 15, radius: 2 },
  });

  const n = SCAN_W * SCAN_H;
  const frameBytes = n * 3;
  const estimate = Number.isFinite(end) && end > start
    ? Math.ceil(((end - start) * fps) / step) + 8
    : 4096;
  let cap = Math.max(1024, Math.min(estimate, MAX_SHADOW_FRAMES + 8));
  let X = new Float32Array(cap * DIM);
  let count = 0;
  let truncated = false;
  const grow = () => {
    const next = new Float32Array(Math.min(MAX_SHADOW_FRAMES + 8, cap * 2) * DIM);
    next.set(X.subarray(0, count * DIM));
    X = next;
    cap = Math.min(MAX_SHADOW_FRAMES + 8, cap * 2);
  };

  await new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, [
      '-hide_banner', '-v', 'error', '-nostdin',
      ...(start > 0 ? ['-ss', String(start)] : []),
      ...(Number.isFinite(end) ? ['-t', String(Math.max(0.1, end - start))] : []),
      '-skip_loop_filter', 'all',
      '-i', input, '-an', '-sn',
      '-vf', `scale=${SCAN_W}:${SCAN_H}:flags=area,format=rgb24`, '-f', 'rawvideo', '-',
    ], { stdio: ['ignore', 'pipe', 'pipe'], signal, windowsHide: true });

    let pending = Buffer.alloc(0);
    const hsv = new Float32Array(n * 3);
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
        if (count >= MAX_SHADOW_FRAMES) {
          // 到上限就收工。**必须记下来** —— 拿半条时间轴算出来的分歧率是残的，
          // 而它看起来和完整的一样（这个项目最恨的就是"看不出哪里错"）。
          truncated = true;
          killedByUs = true;
          child.kill('SIGKILL');
          return;
        }
        frameToHsv(slice, hsv);
        const t = count / fpsEff;
        const f = feats.push(hsv, t);
        if (count >= cap) grow();
        const base = count * DIM;
        for (let d = 0; d < DIM; d += 1) {
          let v = (f[d] - mean[d]) / std[d];
          if (d === dtIdx) v = 0;                        // 与训练一致：防帧率泄漏
          if (dropped.has(FEATURES[d])) v = 0;
          X[base + d] = v;
        }
        count += 1;
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

  if (count === 0) throw new Error('一帧都没解出来');
  return { X, n: count, stride: step, truncated };
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
 * @returns {Promise<{predCuts:number[], sampled:number, stride:number, msPass:number, msForward:number}>}
 */
export async function predictCuts({
  input, fps, start = 0, end, stride = 1, ffmpegPath = DEFAULT_FFMPEG, signal, md,
}) {
  const t0 = Date.now();
  const matrix = await collectMatrix({
    input, fps, start, end: Number.isFinite(Number(end)) ? Number(end) : undefined,
    stride, ffmpegPath, signal, md,
  });
  const msPass = Date.now() - t0;

  const rows = new Array(matrix.n);
  const dts = new Float64Array(matrix.n);
  const dt = 1 / (fps / matrix.stride);
  for (let i = 0; i < matrix.n; i += 1) { rows[i] = i; dts[i] = dt; }

  const fw0 = Date.now();
  const { out } = forward(md.model, matrix.X, rows, dts);
  const msForward = Date.now() - fw0;

  // 时间轴换算：第 i 个样本对应 `i / fpsEff` 秒；decodeCuts 用 fpsEff 就是为了这一点
  const predCuts = decodeCuts(out.cut, { fps: fps / matrix.stride, theta: md.theta });
  return {
    predCuts,
    sampled: matrix.n,
    stride: matrix.stride,
    truncated: matrix.truncated,
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
  } = o;

  const base = {
    ts: new Date().toISOString(),
    video: input ? basename(String(input)) : null,
    fps: Number(fps) || null,
    duration: Number.isFinite(Number(duration)) ? +Number(duration).toFixed(3) : null,
    window: { from: +Number(start).toFixed(3), to: Number.isFinite(Number(end)) ? +Number(end).toFixed(3) : null },
  };

  const t0 = Date.now();
  try {
    if (!(fps > 0)) throw new Error(`fps 不合法：${fps}`);
    const md = await loadLiquidModel(modelPath);
    const r = await predictCuts({
      input, fps, start, end, stride, ffmpegPath, signal, md,
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
      thetaLiquid: md.theta,
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
      msFeature: Math.max(0, r.msPass - r.msForward),
      msForward: r.msForward,
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
    if (notes.length) record.note = notes.join('；');
    if (writeLog) await appendShadowLog(logPath, record);
    return record;
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
