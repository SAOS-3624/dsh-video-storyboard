/**
 * pipeline.js — 端到端**编排**：探测 → 扫描切点 → 定帧 → 分档 → 排布 → 取帧 → 拼图 → 清单。
 *
 * CLI（bin/storyboard.mjs）和 DSH 工具（src/index.js）都走这里，避免两份实现漂移。
 * 本模块只返回内存里的 PNG buffer 与结构化清单，落盘由调用方决定。
 *
 * ## 2026-11-01 的大砍
 *
 * 旧版在"扫描出切点"之后还有一整套独立体系：suggest() 猜格数、rodt 按密度挪格、
 * 格内摊开 k×k 子帧、measure 量帧数、按帧数切张、补满布局、裁暗场、并尾、音频驱动判定……
 * 每一层都为上一层的历史问题打补丁，最后"5 格要成 6 格"这种事说不清。
 *
 * 现在是三个阶段，一条直线：
 *
 *   1. **帧 = 镜头**。真切点切段，积分假切点在真切点之间补，一段一帧。
 *   2. **档位 = 切点密度**。密度高的地方格子小（1/8），长镜头格子大（1/1）。
 *      `tiers.levelCurve()` 按 docx 的阈值/滞回状态机算。
 *   3. **排布 = 打包**。档位序列喂给 `pack.solve()`，按行精确最优，一张装满再开下一张。
 *
 * 没有"每张几格"的参数 —— 张数是排布的结果，不是输入。
 */

import { cpus } from 'node:os';

import { probeVideo, DEFAULT_FFMPEG, DEFAULT_FFPROBE } from './probe.js';
import { resolveInput } from './fetch.js';
import {
  packPrints, packedFps, refineCutsByWindow, scanShots, spikeCuts, suppressClose, unpackPrints,
} from './scan.js';
import { tagCuts } from './flash.js';
import { rememberSegments } from './locate.js';
import { isOwned, keepAlive, scheduleStop } from './asr-lifecycle.js';
import {
  BIN_COST, DEFAULT_STRATEGY, MARK_BOOST, STRATEGIES, applyMarkBoost, applyStrategy, applyTierMap,
  fitCanvas, resolveStrategy,
  framesFromBounds, integralMarks, levelAt, levelCurve, readabilityOf, tierHistogram,
} from './tiers.js';
import { solve, toRects } from './pack.js';
import { remember } from './memory.js';
import { analyzeAudio, describeAudio, hasAudibleSamples } from './audio.js';
import { alignCells, resolveAsrConfig } from './asr.js';
import { resolveTranscript } from './transcript-pass.js';
import { cacheKey, withCache } from './cache.js';
import { pruneStorage } from './storage.js';
import { saveCells } from './cells.js';
import { ffmpegVersion, sha256File } from './provenance.js';
import { findInjection } from './injection.js';
import { addAudioStrip, addSheetHeader, clock, composePacked, encodePngBuffer } from './sheet.js';
import { extractFrameWithFallback, extractFramesBatched, mapPool } from './frames.js';
import { correctByOnScreenSubs } from './ocr-subs.js';
import { resolveHwaccel } from './hwaccel.js';

export const PICK_MODES = ['sharp', 'mid', 'thumb'];// 只有两种：时间码不烧进画面 —— 它占像素、压缩后先糊，而清单里已经有 0.01 秒精度的时间。
// （历史上 `index+time` 在参数表里但从没实现过，等于一个会静默失效的选项。）
export const BURN_MODES = ['index', 'none'];

/**
 * @param {object} opts
 * @param {string} opts.input 视频路径
 * @param {number} [opts.from] 窗口起点（秒）
 * @param {number} [opts.to] 窗口终点（秒）
 * @param {number|'auto'} [opts.threshold] 切点阈值
 * @param {number} [opts.scanGap] 切点近邻合并的秒数（0 = 关掉）
 * @param {'quality'|'balanced'|'saver'|'frugal'} [opts.strategy] 升降档策略
 * @param {number} [opts.maxFrames] 最多取多少帧（超过就合并最短的段）
 * @param {number} [opts.budget] 单图像素预算（不会超过 800×800）
 * @param {'sharp'|'mid'|'thumb'} [opts.pick]
 * @param {'index'|'none'} [opts.burn]
 * @param {(p:object)=>void} [opts.onProgress]
 */
export async function runStoryboard(opts) {
  const {
    input: inputRaw,
    from = 0,
    to,
    threshold = 'auto',
    // **切点近邻合并默认关掉**：旧版 0.35s 会把"3 秒 18 个快闪镜头"压成 4 刀。
    // 档位算法自己会用密度把快剪区压成小格子，不需要在扫描阶段先丢掉一半切点。
    // 例外：`thrifty`（恭喜发财档）自己带 `defaultScanGap: 0.35`，见下面 capGap。
    scanGap = 0,
    refineBursts = true,
    // 取帧并发数：每路 ffmpeg 只解一帧，互不依赖。实测 154 帧（16 核 i9-12900HX）：
    // 4 路 9.65s / 8 路 6.58s / 12 路 5.68s / 16 路 5.56s / 24 路 6.44s（过了 16 就抢不到核）。
    // 取 0.75×核数：16 核 → 12，比 8 快 14%，又不像 24 那样把机械盘和内存带宽打满。
    frameConcurrency = Math.min(12, Math.max(2, Math.floor(cpus().length * 0.75))),
    strategy: strategyRaw = DEFAULT_STRATEGY,
    // **0 = 不封顶**。帧数由切点决定：一部长片几千刀就几千帧，用户自己承担解码时间。
    maxFrames = 0,
    // 张数上限：zoom / 陪看要**一张图**，概览默认也不封顶（帧多自然张多）。
    maxSheets = 0,
    // 至少取几帧：zoom / 陪看这种"窗口短 + 可能一个长镜头"的场景，光有切点会只出 1 帧。
    // 不够就把最长的段等分切开（补足到 minFrames），保证"看这一段"至少有几张。
    minFrames = 0,
    // 'auto' = 所有帧统一取 ceil(sqrt(帧数)) 档（zoom 用：n 帧正好铺成 sqrt(n)×sqrt(n) 的一张图）
    uniformTier = null,
    // 档位映射表：`{1:3, 5:4, 6:4}` —— 接在策略之后，调用方说啥就是啥（没写的档位原样保留）
    tierMap = null,
    // 积分取帧（假切点）：真切点之间按"画面变化率的时间积分"补采样点，累够就触发、触发即清零。
    integral = true,
    integralSeconds = 6,
    pick = 'mid',
    burn = 'index',
    transcript = 'auto',
    transcriptFile,
    sourceHash = false,
    frameSource = null,
    fetchOptions = null,
    audioStrip = true,
    asrMaxChunk = 45,
    hotwords,
    ocr = false,
    asrKey,
    asrIdleMs = null,
    cache = true,
    textOnly = false,
    precomputed = null,
    // 出图几何：像素预算 / 画布边长上限。两个都由 board.js 收口后传进来。
    budget = 640_000,
    maxCanvasSide = 800,
    // 只传 from 时自动推下一段：segment 秒。0 = 看到片尾（短片默认）。
    segment = 0,
    encode = true,
    ffmpegPath = DEFAULT_FFMPEG,
    ffprobePath = DEFAULT_FFPROBE,
    onProgress,
  } = opts;
  if (!inputRaw) throw new Error('input is required');
  if (!PICK_MODES.includes(pick)) throw new RangeError(`pick must be one of ${PICK_MODES.join('/')}`);
  if (!BURN_MODES.includes(burn)) throw new RangeError(`burn must be one of ${BURN_MODES.join('/')}`);
  // 旧名（quality / balanced / saver / frugal / thrifty / ultra）在这里换成新名，不报错
  const strategy = resolveStrategy(strategyRaw);
  if (!STRATEGIES[strategy]) {
    throw new RangeError(`strategy must be one of ${Object.keys(STRATEGIES).join(' / ')}`
      + ` (old names quality/balanced/saver/frugal/thrifty/ultra still accepted)`);
  }
  // 扫描期最小间隔：调用方显式给了就用它，否则用策略自带的（只有"恭喜发财档"带 0.35）
  const capGap = Number(scanGap) > 0
    ? Number(scanGap)
    : (STRATEGIES[strategy]?.defaultScanGap ?? 0);
  // **0 = 不限**（用户明确要求长片不封顶）。正数才当上限；NaN 也当不限。
  // 别写成 `|| 96` —— 那会把"没限制"变成"96 帧"，正是上一版被吐槽的地方。
  const capFrames = Number.isFinite(Number(maxFrames)) && Number(maxFrames) > 0
    ? Math.min(10_000, Math.round(Number(maxFrames)))
    : Infinity;
  const capSheets = Number.isFinite(Number(maxSheets)) && Number(maxSheets) > 0
    ? Math.min(64, Math.round(Number(maxSheets)))
    : Infinity;

  const resolved = await resolveInput(inputRaw, { ...(fetchOptions ?? {}), ffmpegPath });
  const input = resolved.path;
  const sourceInfo = resolved.source;
  // zoom 用高清直链取帧；失败要能回落到本地低清，所以这里只记"首选源"，不替换 input
  const remoteFrame = frameSource?.uri
    ? { uri: frameSource.uri, http: { userAgent: frameSource.userAgent, referer: frameSource.referer } }
    : null;

  const info = { ...(await probeVideo(input, { ffprobePath })), path: input };
  const [ffmpeg, sha256] = await Promise.all([
    ffmpegVersion(ffmpegPath),
    sourceHash ? sha256File(input).catch(() => 'unavailable') : Promise.resolve(null),
  ]);
  const provenance = { ...(ffmpeg ? { ffmpeg } : {}), ...(sourceHash ? { sha256 } : {}) };
  const winStart = Math.max(0, Math.min(Number(from) || 0, Math.max(0, info.duration - 0.2)));
  const segSec = Number(segment) > 0
    ? Math.max(1, Math.round(Number(segment)))
    : (winStart > 0 ? 300 : 0);
  const autoWindow = !(Number(to) > 0) && segSec > 0;
  const winEnd = Math.min(
    info.duration,
    Number(to) > 0 ? Number(to) : (autoWindow ? winStart + segSec : info.duration),
  );
  const winDur = Math.max(0.2, winEnd - winStart);

  let asrLife = null;
  let asrSeconds = null;
  let asrCached = null;

  const timing = {};
  let _t = Date.now();
  const mark = (name) => { timing[name] = ((Date.now() - _t) / 1000); _t = Date.now(); };

  // ---- 音频测量（零模型：响度 + 静音）。只为了图上的那根条带，不再参与排布。
  //
  // **串行放在扫描前面**（试过并行，更慢）：两条 ffmpeg 一起跑时会和扫描的 cuda 解码
  // 抢 IO 和 CPU —— 实测并行让 scan 从 2.2s 涨到 3.7s，而 audio 自己只有 0.9s，
  // 净亏 0.6s。0.9s 已经压到地板（两条 ffmpeg 的启动各 240ms），没必要再动。
  const needAudio = info.hasAudio && !textOnly && audioStrip !== false;
  const audio = needAudio
    ? await analyzeAudio({ input, ffmpegPath, start: winStart, end: winStart + winDur })
    : null;
  const stripAudio = audioStrip !== false ? audio : null;
  const silences = audio?.silences ?? [];
  mark('audio');

  // 转写在**扫描的同时**跑：它只依赖音频静音位置，不依赖切点。
  const transcriptP = resolveTranscript({
    input, info, sourceInfo, fetchOptions, transcript, transcriptFile,
    winStart, winDur, silences, ffmpegPath, hotwords, asrKey, asrMaxChunk, cache,
  }).then((r) => {
    asrLife = r.asrLife;
    asrSeconds = r.asrSeconds;
    asrCached = r.asrCached;
    return { transcriptInfo: r.transcriptInfo, textInSilence: r.textInSilence };
  });

  // 扫描结果按 (文件, 窗口, 阈值策略) 缓存：storyboard 之后的 zoom 能直接复用
  const key = cache ? await cacheKey({
    input, start: winStart, end: winStart + winDur, threshold, minGap: capGap,
  }) : null;
  let scanMeans = null;
  let scanPrints = null;
  let printFps = 0;
  let hwaccelUsed = null;
  const scan = precomputed
    ? {
      cuts: (precomputed.cuts ?? []).filter((c) => c.t >= winStart && c.t < winStart + winDur),
      summary: precomputed.summary ?? { frames: 0, p90: 0, p99: 0 },
      threshold: precomputed.threshold ?? threshold,
      cached: false,
      reused: true,
      ...(Array.isArray(precomputed.prints) ? { printsRaw: precomputed.prints } : {}),
    }
    : await withCache(key, async () => {
      // 硬件解码只服务"整片顺序解码"这一件事（见 hwaccel.js）。放在缓存回调里：
      // 命中缓存时一行解码都不做，探测本身就是白花的 300ms。
      const hwaccel = await resolveHwaccel({ ffmpegPath, input });
      hwaccelUsed = hwaccel;
      const s = await scanShots({
        input, fps: info.fps, threshold, start: winStart, end: winStart + winDur,
        minGap: capGap, ffmpegPath, hwaccel, onProgress,
      });
      scanMeans = s.means;
      scanPrints = s.prints;
      return {
        cuts: s.cuts, stats: s.stats, frames: s.frames,
        threshold: s.threshold, degraded: s.degraded, summary: s.summary,
        printPack: s.prints?.length ? packPrints(s.prints, info.fps) : null,
      };
    }, { enabled: cache });
  if (scanPrints?.length) {
    printFps = info.fps;
  } else if (scan.printPack) {
    scanPrints = unpackPrints(scan.printPack);
    printFps = packedFps(scan.printPack, info.fps);
  } else if (scan.printsRaw) {
    scanPrints = scan.printsRaw;
    printFps = info.fps;
  }
  if (cache && !scan.cached && !precomputed) await pruneStorage();
  mark('scan');

  if (isOwned()) keepAlive();
  let cuts = scan.cuts;

  // ---- 极静素材（PPT / 代码录屏 / 固定机位）：绝对阈值会漏掉"只改了几个像素"的翻页。
  if (!precomputed && scan.stats.length > 20) {
    const perSec = cuts.length / Math.max(1, winDur);
    if (perSec < 0.25) {
      const spikes = suppressClose(spikeCuts(scan.stats, { k: 4, minAbs: 4, halfWindow: 12 }), capGap);
      if (spikes.length > cuts.length) cuts = spikes;
    }
  }

  // ---- 爆点细扫：粗扫看不见 0.35s 以下的刀
  let refinedBursts = [];
  if (refineBursts && !precomputed && !textOnly) {
    const r = refineCutsByWindow({
      stats: scan.stats, coarseCuts: cuts, fps: info.fps, winStart, winDur,
      coarseThreshold: scan.threshold ?? 0,
    });
    cuts = r.cuts;
    refinedBursts = r.refined;
  }

  const trace = [];
  if (hwaccelUsed) trace.push(`hwaccel:${hwaccelUsed}`);
  // ---- 丐中丐档：**自适应加大切点最小间隔**，直到整段能装进一张图。
  // 一张 1/8 档画布最多 8×8=64 格，留点余量取 56（格子会浮动到 1/7，那时只有 49 格）。
  // 间隔是**对原始切点**逐轮放大的（不是在上一次结果上继续合并），所以单调、可复现。
  if (STRATEGIES[strategy]?.fitOneSheet && !precomputed && cuts.length + 1 > 56) {
    const ONE_SHEET = 56;
    let gap = capGap > 0 ? capGap : 0.2;
    let fitted = suppressClose(cuts, gap);
    let rounds = 0;
    while (fitted.length + 1 > ONE_SHEET && gap < 120 && rounds < 60) {
      gap *= 1.3;
      fitted = suppressClose(cuts, gap);
      rounds += 1;
    }
    if (fitted.length < cuts.length) {
      cuts = fitted;
      trace.push(`cuts-merged:${scan.cuts.length}->${cuts.length}@gap${gap.toFixed(1)}s`);
    }
  }

  // ---- 给每个切点打类型标签（flash / white / black / hardcut / dissolve / motion）。
  // **一个都不删**：删掉误检会让这段在插件眼里变成"完全静止"。
  if (!precomputed && !textOnly && Array.isArray(scanPrints) && scanPrints.length) {
    cuts = tagCuts(cuts, {
      prints: scanPrints,
      means: scanMeans,
      fps: info.fps,
      scores: scan.stats?.map((s) => s.score),
    });
  }

  // ---- 台词：显式文件 > 字幕轨 > ASR；三者都没有就静默跳过（绝不让分镜失败）
  const transcriptResult = await transcriptP;
  let { transcriptInfo } = transcriptResult;
  const { textInSilence } = transcriptResult;
  let ocrReport = null;
  if (ocr && transcriptInfo?.source === 'asr' && (transcriptInfo.segments?.length ?? 0) > 0) {
    ocrReport = await correctByOnScreenSubs({
      input, winStart, winDur, ffmpegPath, segments: transcriptInfo.segments, remoteFrame,
      sourceCopyHeight: sourceInfo ? (sourceInfo.scanActual ?? sourceInfo.scanHeight ?? null) : null,
    }).catch((e) => {
      if (process.env.DSH_OCR_DEBUG) console.error('[ocr]', e?.message ?? e);
      return { status: 'failed', reason: String(e?.message ?? e).slice(0, 160) };
    });
    if (ocrReport?.status === 'applied' && ocrReport.fixed > 0) {
      transcriptInfo = { ...transcriptInfo, segments: ocrReport.segments, ocrFixed: ocrReport.fixed };
    }
    delete ocrReport.segments;
  }
  const relSegments = (transcriptInfo?.segments ?? [])
    .map((seg) => ({ ...seg, from: seg.from - winStart, to: seg.to - winStart }))
    .filter((seg) => seg.to > 0 && seg.from < winDur);
  const transcriptChars = relSegments.reduce((n, seg) => n + String(seg.text ?? '').length, 0);
  const externalSource = sourceInfo?.url ?? info.path ?? null;
  const suspectInjection = findInjection(
    [
      ...(sourceInfo?.title ? [{ text: sourceInfo.title }] : []),
      ...relSegments,
    ],
    { source: externalSource },
  );

  /* ================================================================ 新链路 */

  // ---- 1) 积分取帧（假切点）：只在**真切点之间**补，真切点自己已经是边界
  const absCuts = cuts.map((c) => c.t);
  // 乞丐档不要假切点：那些帧是"画面一直在变"补出来的，省钱的档位不该再为它多取帧
  const wantIntegral = integral && !STRATEGIES[strategy]?.noIntegral;
  const sampleMarks = wantIntegral && scan.stats?.length
    ? integralMarks({
      duration: winDur,
      series: scan.stats,
      cuts: absCuts,
      start: winStart,
      equivSeconds: integralSeconds,
    })
    : [];

  // ---- 2) 帧 = 镜头（+ 积分采样点切出来的子段），3) 档位，4) 排布
  //
  // 三件事必须一起做：**帧数影响档位序列，档位序列决定张数**。所以当调用方要求
  // "最多几张图"（zoom / 陪看都是一张）时，只能减少帧数再重排 —— 不能事后砍掉尾图，
  // 那会让最后一格覆盖半分钟却只给一帧。
  const curve = levelCurve({ duration: winDur, fps: info.fps, cuts: absCuts });
  const canvas = fitCanvas(info.aspect, { maxSide: maxCanvasSide, budget });
  // 排布沿用"按行凑满"（fillRows: true）：放开它虽然填充率更高，但**张数会涨**（5 → 7），
  // 那是舍本逐末 —— 一张图固定 384 token，张数才是成本。`fillRows:false` 保留给调用方自己选。
  const PACK = { stretch: 0.2, binCost: BIN_COST[strategy] ?? 1.02, fillRows: true };
  // 低于 minFrames 就把最长的段反复二等分（zoom / 陪看用）
  const ensureMinFrames = (segsIn, min) => {
    let out = segsIn;
    while (out.length < min) {
      let idx = 0;
      let len = 0;
      for (let i = 0; i < out.length; i += 1) {
        const l = out[i].to - out[i].from;
        if (l > len) { len = l; idx = i; }
      }
      if (len < 0.25) break;                 // 段已经太短，再切没意义
      const s0 = out[idx];
      const mid = (s0.from + s0.to) / 2;
      out = [
        ...out.slice(0, idx),
        { ...s0, to: mid, t: (s0.from + mid) / 2 },
        { ...s0, from: mid, t: (mid + s0.to) / 2, cut: false },
        ...out.slice(idx + 1),
      ];
    }
    return out;
  };

  const build = (cap) => {
    let sg = framesFromBounds({
      duration: winDur, start: winStart, cuts: absCuts, marks: sampleMarks, maxFrames: cap,
    });
    if (Number(minFrames) > 1) sg = ensureMinFrames(sg, Math.min(24, Math.round(Number(minFrames))));
    // 档位 = 切点密度；假切点段额外 +2 档（那里画面在连续变化，一帧代表不了多久）
    const base = sg.map((s) => levelAt(curve, s.t - winStart));
    const raw = applyMarkBoost(base, sg);
    let tr = applyStrategy(raw, strategy);
    tr = applyTierMap(tr, tierMap);
    if (uniformTier === 'auto') {
      // zoom 的语义是"一张图里 n 个格子看清楚"，不是"按内容密度分配大小"：
      // 统一成 ceil(sqrt(n)) 档，刚好铺满 √n×√n 网格。
      const k = Math.max(1, Math.min(8, Math.ceil(Math.sqrt(sg.length))));
      tr = sg.map(() => k);
    }
    return { segs: sg, raw, tiers: tr, plan: solve(tr, { stretch: 0.2, ...PACK }) };
  };
  let built = build(capFrames);
  if (Number.isFinite(capSheets) && built.plan.bins > capSheets) {
    // 张数对帧数**近似单调**（帧少 → 张少），所以二分找"能装进 maxSheets 的最多帧数"。
    // 别按比例一步砍：73 帧 5 张要 4 张，一步砍到 34 帧 3 张 —— 白白丢掉一半帧。
    let lo = 1;
    let hi = built.segs.length;
    let best = null;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const b = build(mid);
      if (b.plan.bins <= capSheets) {
        if (!best || b.segs.length > best.segs.length) best = b;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (best) built = best;
  }
  // 尾部瘦身：最后一张只装 1~4 帧、填充率又低于 65% 时，把那几帧的档位加一档重排。
  // 一张图 = 384 token，换最后几帧小一档是划算的（片尾标题 + 演职员表各占半张图，实测很常见）。
  // 只加档、不减帧：时间覆盖和"不封顶"都不受影响。
  const trimTail = (b) => {
    const lastBin = b.plan.cells.filter((c) => c.bin === b.plan.bins - 1);
    if (b.plan.bins < 2 || lastBin.length === 0 || lastBin.length > 4) return b;
    const lastFill = lastBin.reduce((a, c) => a + c.w * c.h, 0);
    if (lastFill >= 0.65) return b;
    const from = lastBin[0].seq;
    for (let step = 1; step <= 2; step += 1) {
      const bumped = b.tiers.map((t, i) => (i >= from ? Math.min(8, t + step) : t));
      const p2 = solve(bumped, { stretch: 0.2, ...PACK });
      if (p2.bins < b.plan.bins) return { ...b, tiers: bumped, plan: p2 };
    }
    return b;
  };
  built = trimTail(built);

  // ---- 补位：排布留了洞就**把那段长镜头切开多取一帧**，而不是让画布空着。
  //
  // 洞的成因固定：某张图覆盖的段太少（片尾标题 + 演职员表、一个 20 秒长镜头），
  // 格子占不满一行。补法不是"塞一张无关的帧"，而是**把最长的那段再切一刀**——
  // 时间轴仍然连续、清单不会出现两个重叠的时间段，多出来的帧还正好是该看的。
  // 切点用段起点的哈希取 0.35~0.65 之间的位置（同一部片可复现，但不会所有刀都落在正中）。
  const hash01 = (v) => {
    const x = Math.sin((Number(v) || 0) * 12.9898) * 43758.5453;
    return x - Math.floor(x);
  };
  const splitSeg = (seg, frac) => {
    const mid = seg.from + (seg.to - seg.from) * frac;
    return [
      { from: seg.from, to: mid, t: (seg.from + mid) / 2, cut: seg.cut, via: seg.via },
      { from: mid, to: seg.to, t: (mid + seg.to) / 2, cut: false, via: seg.via },
    ];
  };
  // 补位目标：每张图都往 90% 上推。低于它的部分算"欠满"。
  const FILL_TARGET = 0.9;
  // 每张图的填充率（= 格子面积之和），以及"欠满总量" = Σ max(0, FILL_TARGET - fill)
  const binFills = (plan) => {
    const m = new Map();
    for (const c of plan.cells) m.set(c.bin, (m.get(c.bin) ?? 0) + c.w * c.h);
    return [...m.entries()];
  };
  const deficitOf = (plan) => binFills(plan).reduce((n, [, a]) => n + Math.max(0, FILL_TARGET - a), 0);

  const fillGaps = (b) => {
    let cur = b;
    const startFrames = b.segs.length;
    // **不许因为补位多开图**：一张图 384 token，补位只该在现有张数里找缝，不能拿张数换填充率。
    const binCap = b.plan.bins;
    for (let round = 0; round < 10; round += 1) {
      const fills = binFills(cur.plan);
      let worst = null;
      for (const [bin, area] of fills) if (!worst || area < worst.area) worst = { bin, area };
      if (!worst || worst.area >= FILL_TARGET) break;

      // **先试"减帧"**：n 个正方形铺不满时，减到最近的较小平方数反而能 100%，
      // 而且格子放大一档（6 个 1/3 → 4 个 1/2），画面更清楚。这比"切几刀补到较大平方数"
      // 省帧、也不会把张数顶开 —— 唯一代价是少看几个瞬间。
      {
        const cellsOfBin = cur.plan.cells.filter((c) => c.bin === worst.bin);
        const nb = cellsOfBin.length;
        const small = [4, 9, 16, 25].filter((k) => k < nb).pop();
        if (small && nb - small <= 3) {
          const first = cellsOfBin[0].seq;
          const last = cellsOfBin[cellsOfBin.length - 1].seq;
          const lo = cur.segs[first].from;
          const hi = cur.segs[last].to;
          const span = (hi - lo) / small;
          const tier = Math.round(Math.sqrt(small));
          const newSegs = Array.from({ length: small }, (_, j) => ({
            from: lo + span * j,
            to: lo + span * (j + 1),
            t: lo + span * (j + 0.5),
            cut: j === 0,
            via: 'start',
          }));
          const segs2 = [...cur.segs.slice(0, first), ...newSegs, ...cur.segs.slice(last + 1)];
          const tiers2 = [...cur.tiers.slice(0, first),
            ...new Array(small).fill(tier), ...cur.tiers.slice(last + 1)];
          const p2 = solve(tiers2, { stretch: 0.2, ...PACK });
          if (process.env.DSH_PLAN_DEBUG) {
            console.error(`[fillGaps] coarsen bin=${worst.bin} ${nb}->${small} tier=${tier}`
              + ` -> bins=${p2.bins} fill=${p2.fill.toFixed(3)}`
              + ` deficit=${deficitOf(cur.plan).toFixed(3)}->${deficitOf(p2).toFixed(3)}`);
          }
          if (p2.bins <= cur.plan.bins && deficitOf(p2) < deficitOf(cur.plan) - 1e-9) {
            cur = { ...cur, segs: segs2, tiers: tiers2, plan: p2 };
            if (cur.segs.length > startFrames * 2) break;
            continue;                       // 这张补好了，回去看还有没有更空的
          }
        }
      }

      // **第三招：把这张图覆盖的时间重新均分，档位统一**（n → 最近的平方数）。
      // 混合档位时行内矮格上方的缝是几何必然（一行里 400 和 133 并排，行高取大的那个），
      // 只有"整张图尺寸一致"才能铺满。代价是这张图内部不再区分长镜头/快剪 —— 只在它欠满时用。
      {
        const cellsOfBin = cur.plan.cells.filter((c) => c.bin === worst.bin);
        const nb = cellsOfBin.length;
        const sq = [4, 9, 16, 25].reduce(
          (best, k) => (Math.abs(k - nb) < Math.abs(best - nb) ? k : best), 4,
        );
        if (sq !== nb && Math.abs(sq - nb) <= 4) {
          const tier = Math.round(Math.sqrt(sq));
          const first = cellsOfBin[0].seq;
          const last = cellsOfBin[cellsOfBin.length - 1].seq;
          const lo = cur.segs[first].from;
          const hi = cur.segs[last].to;
          const span = (hi - lo) / sq;
          const newSegs = Array.from({ length: sq }, (_, j) => ({
            from: lo + span * j,
            to: lo + span * (j + 1),
            t: lo + span * (j + 0.5),
            cut: j === 0,
            via: 'start',
          }));
          const segs2 = [...cur.segs.slice(0, first), ...newSegs, ...cur.segs.slice(last + 1)];
          const tiers2 = [...cur.tiers.slice(0, first),
            ...new Array(sq).fill(tier), ...cur.tiers.slice(last + 1)];
          const p2 = solve(tiers2, { stretch: 0.2, ...PACK });
          if (process.env.DSH_PLAN_DEBUG) {
            console.error(`[fillGaps] uniform bin=${worst.bin} ${nb}->${sq} tier=${tier}`
              + ` -> bins=${p2.bins} fill=${p2.fill.toFixed(3)}`
              + ` deficit=${deficitOf(cur.plan).toFixed(3)}->${deficitOf(p2).toFixed(3)}`);
          }
          if (p2.bins <= cur.plan.bins && deficitOf(p2) < deficitOf(cur.plan) - 1e-9) {
            cur = { ...cur, segs: segs2, tiers: tiers2, plan: p2 };
            if (cur.segs.length > startFrames * 2) break;
            continue;
          }
        }
      }

      // 减帧不成，再试"切几刀补到较大平方数"。
      // 只看**这张图覆盖的段**，按长度从长到短排。切太短的段（<1s）取不出两张不同的画面。
      const seqs = cur.plan.cells.filter((c) => c.bin === worst.bin).map((c) => c.seq);
      const cand = [];
      for (let i = Math.min(...seqs); i <= Math.max(...seqs); i += 1) {
        const len = cur.segs[i].to - cur.segs[i].from;
        if (len >= 1.0) cand.push({ i, len });
      }
      if (cand.length === 0) break;
      cand.sort((x, y) => y.len - x.len);

      // 填满的关键是**帧数凑成完全平方数**：n 个正方形最多只能铺到 n/k²，
      // 6 个 1/3 格 = 2 行 × 3 个 = 2/3 高（67%），补到 9 个才是 3×3 = 100%。
      // 所以先按"补到最近的较大平方数"切几刀；补不上（或已经凑齐）再用自由尺寸帧填缝。
      const n = cur.plan.cells.filter((c) => c.bin === worst.bin).length;
      const target = [4, 9, 16].find((k) => k > n);
      const toSquare = target ? Math.min(6, target - n) : 0;
      const want = Math.max(toSquare, 1);      // 至少补一个（可能是自由尺寸）
      let accepted = false;
      for (const pick of cand.slice(0, 4)) {
        if (toSquare === 0) break;             // 已经凑成平方数，走自由尺寸那条路
        const segs2 = [...cur.segs];
        const tiers2 = [...cur.tiers];
        // 一次切 toSquare 刀（刀数不够就用 cand 里能切的）
        const cuts = cand.slice(0, toSquare).sort((x, y) => y.i - x.i);
        for (const c2 of cuts) {
          const fr = 0.35 + hash01(cur.segs[c2.i].from) * 0.3;
          const ps = splitSeg(cur.segs[c2.i], fr);
          segs2.splice(c2.i, 1, ...ps);
          tiers2.splice(c2.i, 1, cur.tiers[c2.i], cur.tiers[c2.i]);
        }
        const p2 = solve(tiers2, { stretch: 0.2, ...PACK });
        if (process.env.DSH_PLAN_DEBUG) {
          console.error(`[fillGaps] bin=${worst.bin} n=${n} toSquare=+${toSquare}`
            + ` -> bins=${p2.bins} fill=${p2.fill.toFixed(3)}`
            + ` deficit=${deficitOf(cur.plan).toFixed(3)}->${deficitOf(p2).toFixed(3)}`);
        }
        if (p2.bins <= binCap && deficitOf(p2) < deficitOf(cur.plan) - 1e-9) {
          cur = { ...cur, segs: segs2, tiers: tiers2, plan: p2 };
          accepted = true;
        }
        break;                                  // 只试这一种（切哪几段由 cand 排序决定）
      }
      if (!accepted && toSquare === 0) {
        // 已经是平方数但还欠满 → 用自由尺寸帧填缝（它按剩余宽度伸展）
        for (const pick of cand.slice(0, 4)) {
          const segs2 = [...cur.segs];
          const tiers2 = [...cur.tiers];
          const frac = 0.35 + hash01(cur.segs[pick.i].from) * 0.3;
          const parts = splitSeg(cur.segs[pick.i], frac);
          segs2.splice(pick.i, 1, ...parts);
          tiers2.splice(pick.i, 1, cur.tiers[pick.i], 0);
          const p2 = solve(tiers2, { stretch: 0.2, ...PACK });
          if (process.env.DSH_PLAN_DEBUG) {
            console.error(`[fillGaps] bin=${worst.bin} free-filler seg=${pick.i}`
              + ` -> bins=${p2.bins} fill=${p2.fill.toFixed(3)}`
              + ` deficit=${deficitOf(cur.plan).toFixed(3)}->${deficitOf(p2).toFixed(3)}`);
          }
          if (p2.bins <= binCap && deficitOf(p2) < deficitOf(cur.plan) - 1e-9) {
            cur = { ...cur, segs: segs2, tiers: tiers2, plan: p2 };
            accepted = true;
            break;
          }
        }
      }
      if (!accepted) break;
      if (cur.segs.length > startFrames * 2) break;    // 兜底：最多补一倍
    }
    return cur;
  };
  // **显式限帧就不补**：调用方说"最多 4 帧"就是 4 帧，补到 5 帧是违约。
  if (!Number.isFinite(capFrames)) built = fillGaps(built);

  const { segs, raw: rawTiers, tiers, plan: packed } = built;

  // 每格对到帧：seq 就是帧下标（排布不改顺序）
  const cellFrames = segs.map((s, i) => ({ ...s, tier: tiers[i], rawTier: rawTiers[i], seq: i }));

  const sheetRects = [];
  for (let b = 0; b < packed.bins; b += 1) {
    // 把 `via` 带到 rect 上：拼图时要靠它决定"这一格画不画编号"
    sheetRects.push(toRects(packed.cells, {
      width: canvas.width, height: canvas.height, bin: b,
    }).map((r) => ({ ...r, via: cellFrames[r.seq]?.via })));
  }

  if (segs.length < absCuts.length + 1) trace.push(`frames-merged:${absCuts.length + 1 + sampleMarks.length}->${segs.length}`);
  if (strategy !== DEFAULT_STRATEGY) trace.push(`strategy:${DEFAULT_STRATEGY}->${strategy}`);

  const minCellW = Math.min(...packed.cells.map((c) => Math.round(c.w * canvas.width)));
  const minCellH = Math.min(...packed.cells.map((c) => Math.round(c.h * canvas.height)));

  const planInfo = {
    // 兼容字段：`cells` 现在是"单张最多几格"（实测值），`sheets` 是张数
    cells: Math.max(...sheetRects.map((r) => r.length)),
    sheets: packed.bins,
    frames: segs.length,
    produced: segs.length,
    strategy,
    strategyNote: STRATEGIES[strategy].note,
    // 映射表写进清单：模型自己设的覆盖，复核时要能一眼看到
    ...(tierMap && Object.keys(tierMap).length ? { tierMap } : {}),
    // 清单里要把"不限"说出来：写个 0 会让模型以为只能取 0 帧
    maxFrames: Number.isFinite(capFrames) ? capFrames : 0,
    markBoost: MARK_BOOST,
    budget,
    canvas: { width: canvas.width, height: canvas.height },
    // **最小格**是清单该报的那个数：模型看到的就是最小那格的可读性
    cell: {
      w: minCellW, h: minCellH,
      readability: readabilityOf(minCellW, minCellH),
    },
    fill: +(packed.fill * 100).toFixed(1),
    // 每张图的填充率：**只有平均值会骗人** —— 平均 79% 可能是"四张 95% + 一张 50%"，
    // 那最后一张有一半是灰条，模型会以为图里没东西。
    sheetFill: sheetRects.map((r) => {
      const a = r.reduce((n, x) => n + (x.pw * x.ph) / (canvas.width * canvas.height), 0);
      return +(a * 100).toFixed(0);
    }),
    tiers: tierHistogram(tiers),
    rawTiers: tierHistogram(rawTiers),
    sampleMarks: sampleMarks.length,
    pick, burn, scanGap: capGap,
    adaptive: false,
    trace,
    inputs: {
      duration: +winDur.toFixed(2),
      scanThreshold: scan.threshold,
      motion: +(Number(scan.summary?.p90) || 0).toFixed(1),
      cuts: cuts.length,
      hasSubtitle: Boolean(info.hasSubtitle),
      meanLufs: Number.isFinite(audio?.mean) ? +audio.mean.toFixed(1) : null,
    },
    fps: info.fps,
  };

  // textOnly：只算"帧 → 台词"，一帧都不解、一张图都不拼。
  if (textOnly) {
    const aligned = alignCells(segs, transcriptInfo?.segments ?? []);
    const cellsMeta = segs.map((s, i) => {
      const t = aligned[i] ?? null;
      return {
        i: i + 1,
        t_start: +s.from.toFixed(3),
        t_end: +s.to.toFixed(3),
        tier: tiers[i],
        ...(t?.text ? { text: t.text, charsPerSec: t.charsPerSec } : {}),
        ...(t?.lines?.length > 1 ? { lines: t.lines } : {}),
      };
    });
    return {
      info,
      window: { from: winStart, to: winStart + winDur, duration: winDur },
      cuts,
      summary: scan.summary,
      threshold: scan.threshold,
      ...(scan.degraded ? { degraded: scan.degraded } : {}),
      cached: Boolean(scan.cached),
      audio: null,
      transcript: transcriptInfo
        ? { source: transcriptInfo.source, model: transcriptInfo.model ?? null,
          segments: relSegments.length, chars: transcriptChars,
          charsPerSec: +(transcriptChars / Math.max(1, winDur)).toFixed(2),
          ...(suspectInjection.length ? { suspectInjection } : {}) }
        : null,
      provenance,
      plan: { ...planInfo, bursts: [] },
      sheets: [],
      cells: cellsMeta,
      textOnly: true,
      ...(sourceInfo ? { source: sourceInfo } : {}),
      ...(refinedBursts.length ? { refinedBursts } : {}),
      totalDuration: +segs.reduce((n, s) => n + (s.to - s.from), 0).toFixed(3),
    };
  }

  // ---- 5) 取帧 + 拼图
  //
  // **取帧跨张全铺开**（2026-11-01）。旧版是"逐张 mapPool"：一张图 9–17 帧、8 路并发，
  // 每张只跑 2–3 轮就有大半线程空转，13 张之间还互相等。实测 154 帧：
  // 逐张 7.8s，全铺开 16 路 5.6s。帧之间本来就互不依赖（每次 ffmpeg 只解一帧），
  // 没有理由按张分段。
  //
  // 唯一要管的是内存：一帧 = pw×ph×3 字节，800×450 的大格子约 1MB，
  // 长片几千帧全塞进内存会顶到 GB 级。所以按**像素预算**切块（默认 96MB ≈ 100 张满格），
  // 块内一次并发跑完，块间串行。
  const out = [];
  let fallbacks = 0;
  let globalIndex = 0;

  const jobs = [];
  for (let si = 0; si < sheetRects.length; si += 1) {
    for (let k = 0; k < sheetRects[si].length; k += 1) {
      const r = sheetRects[si][k];
      jobs.push({ si, k, rect: r, cell: cellFrames[r.seq] });
    }
  }
  // 一块最多 EXTRA 轮并发（轮数太多不利于"最先失败的先报"），也受像素预算约束
  const EXTRACT_BUDGET = 96 << 20;
  const batches = [];
  {
    let cur = [];
    let bytes = 0;
    const maxJobs = Math.max(1, frameConcurrency) * 4;
    for (const j of jobs) {
      const b = j.rect.pw * j.rect.ph * 3;
      if (cur.length && (bytes + b > EXTRACT_BUDGET || cur.length >= maxJobs)) {
        batches.push(cur); cur = []; bytes = 0;
      }
      cur.push(j); bytes += b;
    }
    if (cur.length) batches.push(cur);
  }
  const shotOf = new Map();
  const _ex0 = Date.now();
  // 批量路径（一次 ffmpeg 取多帧）只在**本地 + 不做锐度挑选**时可用：
  // - 远程直链要带 header、一次 HTTP seek 1.9s，批量反而更糟；
  // - pick='sharp' 要每格解 3 个候选帧再挑最锐的，和"一次解码"是两套语义。
  //
  // `DSH_EXTRACT_MODE=single` 强制逐帧：批量路径的像素是"先缩到源比例、再盒式 cover 到目标格"
  // （两次采样 ≈ 一次采样），需要逐位复现旧输出、或怀疑某片源 select 帧号对不上时用它。
  const useBatch = pick === 'mid' && !remoteFrame && process.env.DSH_EXTRACT_MODE !== 'single';
  if (useBatch) {
    const list = jobs.map((j) => ({
      at: j.cell.t, cellW: j.rect.pw, cellH: j.rect.ph, key: `${j.si}:${j.k}`,
    }));
    const got = await extractFramesBatched({
      input, jobs: list, fps: info.fps, ffmpegPath,
      srcW: info.width, srcH: info.height,
      // 扫描已经按 (ffmpeg, input) 探过一次，这里直接命中进程内缓存；没探过就是 null
      hwaccel: await resolveHwaccel({ ffmpegPath, input }),
      // 批量块是"解码 20 秒"的重活，开太多路会互相抢解码器；实测 4 路已接近线性
      concurrency: Math.max(2, Math.min(4, Math.round(frameConcurrency / 3))),
      fallback: async (j) => extractFrameWithFallback({
        input, remote: null, at: j.at, dur: 0,
        cellW: j.cellW, cellH: j.cellH, ffmpegPath, pick,
      }),
    });
    for (const [k, v] of got) shotOf.set(k, v);
  } else {
    for (const batch of batches) {
      const shots = await mapPool(batch, frameConcurrency, async (j) => extractFrameWithFallback({
        input, remote: remoteFrame, at: j.cell.t, dur: 0,
        cellW: j.rect.pw, cellH: j.rect.ph, ffmpegPath, pick,
      }));
      for (let i = 0; i < batch.length; i += 1) shotOf.set(`${batch[i].si}:${batch[i].k}`, shots[i]);
    }
  }
  timing.extract = (Date.now() - _ex0) / 1000;

  for (let si = 0; si < sheetRects.length; si += 1) {
    const rects = sheetRects[si];
    const aligned = alignCells(rects.map((r) => cellFrames[r.seq]), transcriptInfo?.segments ?? []);

    const frames = [];
    const cellMeta = [];
    for (let k = 0; k < rects.length; k += 1) {
      const r = rects[k];
      const f = cellFrames[r.seq];
      const shot = shotOf.get(`${si}:${k}`) ?? null;
      if (!shot) throw new Error(`internal: frame for sheet ${si + 1} cell ${k + 1} was never extracted`);
      if (shot.via === 'local-fallback') fallbacks += 1;
      globalIndex += 1;
      frames.push({ buffer: shot.buffer, w: r.pw, h: r.ph });
      const text = aligned[k] ?? null;
      const cutCount = absCuts.filter((t) => t >= f.from && t < f.to).length;
      cellMeta.push({
        i: globalIndex,
        sheet: si + 1,
        // 积分假切点：图上不烧编号（它不是"换镜头"），清单里标出来让调用方能对上
        ...(f.via === 'mark' ? { via: 'mark' } : {}),
        // 绝对时间（zoom 的 cellId 直接寻址要用它）
        t_start: +f.from.toFixed(3),
        t_end: +f.to.toFixed(3),
        t_frame: +shot.t.toFixed(3),
        tier: f.tier,
        cell: { w: r.pw, h: r.ph },
        ...(cutCount > 0 ? { cuts: cutCount } : {}),
        ...(shot.sharp !== undefined ? { sharp: +shot.sharp.toFixed(1) } : {}),
        ...(text?.text ? { text: text.text, charsPerSec: text.charsPerSec } : {}),
        // 一格里有 **≥2 句**才带上每句自己的时间。单句时格时间就够（模型能算中点）；
        // 多句时不给时间，模型只能把整段当成"从格首开始"—— 而 ASR 段起点实测比真实开口
        // 早 0.3–1 s（VAD 会把起音前的气口算进去），一句话挂到上一格就是这么来的。
        ...(text?.lines?.length > 1 ? { lines: text.lines } : {}),
      });
    }

    // **把画布裁到内容的外接矩形**：底部/右侧的灰条不是"没内容"，是"这张图就排到这"。
    // 裁掉之后每张图的高宽比由它自己的行数决定（800×450 / 800×300 / 800×380…），
    // 内容一点不少、token 还更省，而且**抓帧尺寸完全不变**（rect 是按原画布算的）。
    const contentW = Math.max(...rects.map((r) => r.px + r.pw));
    const contentH = Math.max(...rects.map((r) => r.py + r.ph));
    const sheetW = Math.max(64, Math.min(canvas.width, contentW));
    const sheetH = Math.max(36, Math.min(canvas.height, contentH));

    let sheet = composePacked({
      frames, rects, width: sheetW, height: sheetH, burn,
    });
    const sheetFrom = cellFrames[rects[0].seq].from;
    const last = cellFrames[rects[rects.length - 1].seq];
    sheet = addSheetHeader(sheet, {
      text: `${clock(sheetFrom)}-${clock(last.to)} ${si + 1}/${sheetRects.length}`,
    });
    const stripHasSignal = hasAudibleSamples(stripAudio);
    if (stripHasSignal) {
      // 条带高度不能超过最小格高的一半：1/8 档的格子只有 56px 高，条带再高就喧宾夺主
      const stripH = Math.max(20, Math.min(Math.round(sheetW * 0.05), Math.round(minCellH * 0.5)));
      sheet = addAudioStrip(sheet, {
        loudness: stripAudio, silences: stripAudio.silences, cuts: absCuts,
        window: { from: winStart, to: winStart + winDur }, stripH,
      });
    }
    out.push({
      sheet: si + 1,
      cols: 0,
      rows: 0,
      cellW: minCellW,
      cellH: minCellH,
      width: sheet.width,
      // 裁切前的理想画布：清单里能看出"这张图裁掉了多少空白"
      ...(sheetW !== canvas.width || sheetH !== canvas.height
        ? { croppedFrom: `${canvas.width}x${canvas.height}` } : {}),
      height: sheet.height,
      buffer: sheet.buffer,
      cells: cellMeta,
      ...(sheet.headerH ? { headerH: sheet.headerH } : {}),
      ...(sheet.stripH ? { stripH: sheet.stripH } : {}),
    });
  }

  // PNG 编码**并行**：每张是一次独立 ffmpeg（rawvideo → PNG），彼此无关。
  // 串行时 13 张 ≈ 2.6s，占整次导出的 15%，纯粹是排队等。
  if (encode) {
    const _en0 = Date.now();
    // 一张 PNG 要 150–200ms，跟取帧不是同一层资源（纯 CPU + zlib），
    // 所以给到核数一半：16 核 → 8 路，13 张只需两轮。
    const pngs = await mapPool(out, Math.min(8, Math.max(2, Math.floor(cpus().length / 2))),
      (s) => encodePngBuffer(s.buffer, s.width, s.height, { ffmpegPath }));
    for (let i = 0; i < out.length; i += 1) out[i].png = pngs[i];
    timing.encode = (Date.now() - _en0) / 1000;
  }

  const totalDuration = +segs.reduce((n, s) => n + (s.to - s.from), 0).toFixed(3);

  // 记一笔"看过什么"：下次 probe 能告诉模型"这部片子你看过"。
  await remember(info, {
    from: winStart, to: winStart + winDur, cells: segs.length, cuts: cuts.length,
  }).catch(() => {});

  mark('frames');
  if (asrLife?.owned || isOwned()) {
    const c = resolveAsrConfig();
    scheduleStop({
      owned: true, config: c, baseUrl: c.baseUrl,
      minIdleMs: Number.isFinite(asrIdleMs) ? asrIdleMs : undefined,
    });
  }

  const result = {
    timing,
    ...(ocrReport ? { ocr: ocrReport } : {}),
    info,
    provenance,
    window: { from: winStart, to: winStart + winDur, duration: winDur },
    cuts,
    summary: scan.summary,
    threshold: scan.threshold,
    ...(scan.degraded ? { degraded: scan.degraded } : {}),
    cached: Boolean(scan.cached),
    ...(sourceInfo ? { source: sourceInfo } : {}),
    ...(refinedBursts.length ? { refinedBursts } : {}),
    ...(fallbacks > 0 ? { frameFallbacks: fallbacks } : {}),
    audio: stripAudio
      ? { ...stripAudio, summary: describeAudio(stripAudio, winDur) }
      : null,
    transcript: transcriptInfo
      ? { source: transcriptInfo.source, model: transcriptInfo.model ?? null,
        segments: relSegments.length,
        chars: transcriptChars,
        charsPerSec: +(transcriptChars / Math.max(1, winDur)).toFixed(2),
        ...(suspectInjection.length ? { suspectInjection } : {}),
        ...(transcriptInfo.chunks ? { chunks: transcriptInfo.chunks } : {}),
        ...(transcriptInfo.suspect ? {
          suspect: transcriptInfo.suspect, suspectDetail: transcriptInfo.suspectDetail,
        } : {}),
        ...(transcriptInfo.termsFixed ? { termsFixed: transcriptInfo.termsFixed } : {}),
        ...(textInSilence ? { textInSilence } : {}),
        ...(asrSeconds !== null ? { asrSeconds, asrCached: asrCached === true } : {}),
        ...(transcriptInfo.error ? { error: transcriptInfo.error } : {}) }
      : null,
    plan: planInfo,
    sheets: out,
    totalDuration,
    ...(segSec > 0 ? {
      segment: {
        sec: segSec,
        auto: autoWindow,
        index: Math.floor(winStart / segSec) + 1,
        total: Math.max(1, Math.ceil(info.duration / segSec)),
        watchedSec: +winStart.toFixed(2),
        leftSec: +Math.max(0, info.duration - winEnd).toFixed(2),
      },
    } : {}),
  };

  // 记下"这一格 = 这段**绝对**时间"，供 video_zoom({ cellId }) 直接寻址。
  if (!textOnly) {
    const cellTimes = [];
    for (const sheet of out) {
      for (const c of sheet.cells) cellTimes.push({ i: c.i, from: c.t_start, to: c.t_end });
    }
    await saveCells([inputRaw, input].filter(Boolean), cellTimes);
  }

  return result;
}

/* ---- 兼容入口 ---------------------------------------------------------------
 * `./pipeline` 是 package.json 里公开的子路径（老版本把清单渲染也放在这里）。
 * 内部代码一律直接从 format.js / scan.js 取；这一段只为不让已经
 * `import { formatManifest } from 'dsh-video-storyboard/pipeline'` 的调用方断掉。
 */
export {
  DETAIL_CHARS, buildEvidence, countTextInSilence, formatForDetail, formatManifest,
  formatProbe, formatRemoteProbe, formatTimeline, saveStoryboards, truncateAtSentence,
  withSheetSuffix,
} from './format.js';
export { refineCutsByWindow } from './scan.js';
