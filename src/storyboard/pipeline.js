/**
 * pipeline.js — 端到端**编排**：探测 → 切分 → 分段 → 取帧 → 拼图 → 清单。
 *
 * CLI（bin/storyboard.mjs）和 DSH 工具（index.js）都走这里，避免两份实现漂移。
 * 本模块只返回内存里的 PNG buffer 与结构化清单，落盘由调用方决定。
 *
 * 本文件只留"一次运行是按什么顺序做什么"。三件事已经各自独立成模块：
 *   frames.js     取像素（本地/直链、单帧/摊格、并发）
 *   ocr-subs.js   用画面硬字幕校正转写
 *   format.js     把结果渲染成清单 / 时间线 / 证据文件
 *   scan.js       镜头切分（含爆点细扫 refineCutsByWindow）
 */

import { cpus } from 'node:os';

import { probeVideo, DEFAULT_FFMPEG, DEFAULT_FFPROBE } from './probe.js';
import { resolveInput } from './fetch.js';
import { loadTranscriptFile } from './transcript-file.js';
import { detectDarkRuns, refineCutsByWindow, scanShots, spikeCuts, suppressClose } from './scan.js';
import { tagCuts } from './flash.js';
import { rememberSegments } from './locate.js';
import { ensureAsr, isOwned, keepAlive, scheduleStop } from './asr-lifecycle.js';
import { fitSegments, segmentsFromCuts } from './segments.js';
import { bestLayout, fillLayout, isMusicDriven, suggest, PLAN_THRESHOLDS } from './plan.js';
import {
  densityFromScore, findBursts, integralMarks, planByRodt, planByShotCount, planCellRanges, planSheetsByFrames,
} from './density.js';
import { remember } from './memory.js';
import { analyzeAudio, describeAudio, detectOnsets } from './audio.js';
import {
  ASR_DEFAULTS, alignCells, applyTermMap, canTranscribe, describeAsrTarget, explainFetchError,
  extractSubtitleTrack, filterSuspectSegments, resolveAsrConfig, speechCurve, transcribeLong,
} from './asr.js';
import { fetchRemoteSubtitles } from './subtitles.js';
import { cacheKey, withCache } from './cache.js';
import { pruneStorage } from './storage.js';
import { saveCells } from './cells.js';
import { ffmpegVersion, sha256File } from './provenance.js';
import { findInjection } from './injection.js';
import { addAudioStrip, composeSheet, encodePngBuffer, layoutCanvas } from './sheet.js';
import { chooseSubGrid, extractFrameWithFallback, extractSubTile, mapPool } from './frames.js';
import { correctByOnScreenSubs } from './ocr-subs.js';
import { countTextInSilence } from './format.js';

export const PICK_MODES = ['sharp', 'mid', 'thumb'];// 只有两种：时间码不烧进画面 —— 它占像素、压缩后先糊，而清单里已经有 0.01 秒精度的时间。
// （历史上 `index+time` 在参数表里但从没实现过，等于一个会静默失效的选项。）
export const BURN_MODES = ['index', 'none'];

/**
 * @param {object} opts
 * @param {string} opts.input 视频路径
 * @param {number} [opts.from] 窗口起点（秒）
 * @param {number} [opts.to] 窗口终点（秒）
 * @param {number} [opts.cells] 每张格数（0=自动）
 * @param {number} [opts.sheets] 张数（0=自动）
 * @param {number|'auto'} [opts.threshold]
 * @param {number} [opts.minGap] 采样最小间隔
 * @param {'sharp'|'mid'|'thumb'} [opts.pick]
 * @param {'index'|'none'} [opts.burn]
 * @param {boolean} [opts.sourceHash] 在清单里写源文件 SHA-256（默认关；大文件要整读一遍）
 * @param {number} [opts.badgeRatio]
 * @param {number} [opts.budget] 单图像素预算
 * @param {string} [opts.ffmpegPath]
 * @param {string} [opts.ffprobePath]
 * @param {(p:object)=>void} [opts.onProgress]
 */
export async function runStoryboard(opts) {
  const {
    input: inputRaw,
    from = 0,
    to,
    threshold = 'auto',
    minGap = 1.2,
    // 扫描时的"两刀最短间隔"。和上面的 minGap（格子合并）不是一回事：
    // 快闪素材要把这个调小才数得出镜头数，否则 3 秒 18 镜会被压成 4 刀。
    scanGap = 0.35,
    refineBursts = true,
    // 取帧并发数：每路 ffmpeg 只解一帧，互不依赖。实测 9 格 90 秒片：
    // 1 路 13.3s / 3 路 8.0s / 5 路 6.5s / 8 路 4.0s（这台 16 核）。
    // 默认取核数一半、上限 8 —— 弱机或机械盘上不会把 IO 打死。
    frameConcurrency = Math.min(8, Math.max(2, Math.floor(cpus().length / 2))),
    adaptive = true,
    pick = 'sharp',
    burn = 'index',
    transcript = 'auto',
    transcriptFile,
    sourceHash = false,
    frameSource = null,
    fetchOptions = null,
    audioStrip = true,
    asrMaxChunk = 45,
    // 热词按**这一次**覆盖全局：材料视频该传「位错 滑移 柏氏矢量」，口播摄影片传「像差 焦段」。
    // 全局 asr.json 里的那份是默认值，不是铁律 —— 学科不对时它对识别是负偏置。
    hotwords,
    // 用画面硬字幕校正 ASR（detail=high 时才开）：OCR 全程本地，不花 token
    ocr = false,
    // undefined = 按 env / $DSH_HOME/asr.json 解析；显式 null = 明确不用 env/file 里的 key
    // （云端因此变成 no-key；本机服务按设计不需要 key，仍会尝试。要彻底关掉转写用 transcript:'off'）
    asrKey,
    // 内容分类阈值（musicLufs / musicSpeechRate / speechRateCut）可覆盖：
    // 不同母带响度能差 9 LU，写死的常数换一批片源就误判。实际生效的那组会写进清单。
    planThresholds = null,
    // 本次运行结束后，本地 ASR 至少再活这么久（毫秒）。陪看用它跨段保活。
    asrIdleMs = null,
    cache = true,
    textOnly = false,
    precomputed = null,
    badgeRatio = 0.15,
    budget = 640_000,
    encode = true,
    ffmpegPath = DEFAULT_FFMPEG,
    ffprobePath = DEFAULT_FFPROBE,
    onProgress,
  } = opts;
  if (!inputRaw) throw new Error('input is required');
  if (!PICK_MODES.includes(pick)) throw new RangeError(`pick must be one of ${PICK_MODES.join('/')}`);
  if (!BURN_MODES.includes(burn)) throw new RangeError(`burn must be one of ${BURN_MODES.join('/')}`);

  // 链接在这里变成一份本地文件；本地路径原样返回（source 为 null）。
  // 后面的所有阶段都只面对 input，不知道它原来是不是个 URL。
  // ffmpegPath 也要带过去：链接下载时 yt-dlp 需要它来合流 DASH 的 video+audio（issue #18）
  const resolved = await resolveInput(inputRaw, { ...(fetchOptions ?? {}), ffmpegPath });
  const input = resolved.path;
  const sourceInfo = resolved.source;
  // zoom 用高清直链取帧；失败要能回落到本地低清，所以这里只记"首选源"，不替换 input
  const remoteFrame = frameSource?.uri
    ? { uri: frameSource.uri, http: { userAgent: frameSource.userAgent, referer: frameSource.referer } }
    : null;

  const info = { ...(await probeVideo(input, { ffprobePath })), path: input };
  // Provenance 是锦上添花：ffmpeg 版本缓存/失败不阻塞；hash 只在显式要求时算。
  const [ffmpeg, sha256] = await Promise.all([
    ffmpegVersion(ffmpegPath),
    sourceHash ? sha256File(input).catch(() => 'unavailable') : Promise.resolve(null),
  ]);
  const provenance = {
    ...(ffmpeg ? { ffmpeg } : {}),
    ...(sourceHash ? { sha256 } : {}),
  };
  const winStart = Math.max(0, Math.min(Number(from) || 0, Math.max(0, info.duration - 0.2)));
  const winEnd = Math.min(info.duration, Number(to) > 0 ? Number(to) : info.duration);
  const winDur = Math.max(0.2, winEnd - winStart);

  // 分阶段计时：只有真跑的时候才知道慢在哪。结果里带 timing，不额外开销（Date.now 级别）
  // 本地 ASR 的生命周期句柄：只有"我们拉起来的"那个才会在结束时被停。
  // 必须声明在转写块之前 —— 转写现在跑在扫描之前（并行），拿不到后面声明的变量。
  let asrLife = null;

  const timing = {};
  let _t = Date.now();
  const mark = (name) => { timing[name] = ((Date.now() - _t) / 1000); _t = Date.now(); };

  // ---- 音频测量（零模型：响度 + 静音）。先做，因为静音位置要用来切 ASR 请求。
  const needAudio = info.hasAudio && !textOnly && (audioStrip !== false || transcript !== 'off');
  const audio = needAudio
    ? await analyzeAudio({ input, ffmpegPath, start: winStart, end: winStart + winDur })
    : null;
  const stripAudio = audioStrip !== false ? audio : null;
  const silences = audio?.silences ?? [];
  // 声音事件：突然变响/突然安静。画面没动但事情发生的时刻，只能靠它抓到。
  // 口播片里"每句话的停顿"都会触发，所以**只用最突出的若干个**参与格位加权
  // （全部 90 多个事件铺上去等于把密度曲线压平），清单里也按强度排序展示。
  const allEvents = audio ? detectOnsets(audio) : [];
  mark('audio');

  // 转写在**扫描的同时**跑：它只依赖音频静音位置，不依赖切点。
  // 21 分钟教程实测：扫描 133s、转写 58s，串起来 202s；并行后只等较慢的那个。
  const transcriptP = (async () => {
    // 这次调用到底会不会真的转写：云端没配 key 只是"跳过"的其中一种，本机服务不需要 key。
    // 判据必须和 `transcribe()` 的门同源（见 asr.js 的 canTranscribe），否则清单会和实际行为相反。
    const willTranscribe = () => canTranscribe(resolveAsrConfig(), asrKey);
    let transcriptInfo = null;
    // 站点有字幕轨但要登录 —— 清单要说明"现在用的是 ASR，不是这视频没字幕"
    let subtitleNeedsLogin = false;
    if (transcriptFile) {
      // 显式给了转写就只用它：不查字幕轨、不跑 ASR。
      // 接 B 站时这一步最省 —— 字幕本来就有，没必要再识别一遍（10 分钟口播省 60–120 秒）。
      // 也**不跑幻觉过滤**：那是给 ASR 兜底的，用户递进来的文件按可信处理。
      try {
        const loaded = await loadTranscriptFile(transcriptFile);
        const { segments: fixed, replaced } = applyTermMap(loaded.segments, resolveAsrConfig().terms);
        transcriptInfo = {
          ...(replaced > 0 ? { termsFixed: replaced } : {}),
          source: fixed.length > 0 ? 'file' : 'file-empty',
          model: `file:${loaded.format}`,
          segments: fixed,
          suspect: 0,
          suspectDetail: [],
        };
      } catch (error) {
        transcriptInfo = {
          segments: [],
          source: 'file-failed',
          error: String(error?.message ?? error).slice(0, 300),
        };
      }
    } else if (transcript !== 'off' && info.hasAudio) {
      // **先试站点字幕轨**（B 站 CC）：作者写的文本比 ASR 准，还不烧 CPU。
      // 以前只看"下载下来的 mp4 里有没有内嵌字幕流"，而 B 站的字幕是单独轨道，
      // 于是永远判成"没有字幕"，白白退回 ASR。
      // 站点字幕默认开（准、且省掉一次 ASR）；想省钱/想只走 ASR 时可以显式关：
      //   fetchOptions: { siteSubtitles: false }
      const remote = (sourceInfo?.url && fetchOptions?.siteSubtitles !== false)
        ? await fetchRemoteSubtitles({ url: sourceInfo.url, cookies: fetchOptions?.cookies ?? null })
        : null;
      const subtitle = remote?.ok
        ? remote.segments
        : (info.hasSubtitle ? await extractSubtitleTrack({ input, ffmpegPath }) : null);
      if (remote && !remote.ok && remote.reason === 'needs-login') {
        // 有字幕但要登录：这个事实必须让用户看到，否则会以为"这视频没字幕"
        subtitleNeedsLogin = true;
      }
      if (subtitle) {
        transcriptInfo = {
          segments: subtitle,
          source: 'subtitle',
          model: remote?.ok ? `site-cc${remote.lang ? `:${remote.lang}` : ''}` : 'embedded',
        };
      } else if (!willTranscribe()) {
        // 压根不会转写（云端没配 key）—— 跟"跑了但没听懂"是两码事。
        // 旧代码走的是 withCache → null 空壳 → asr.empty → 'asr-empty'，清单于是写
        // "ASR ran and found no speech here"，一个字都没听过却说"这片子没人说话"。
        transcriptInfo = { segments: [], source: 'no-key' };
      } else {
        try {
          // 切片调用：单次请求过长会让时间码整体压早（实测 299s 压早 13s）。
          // 结果按 (文件, 窗口, 后端, 切片长度) 缓存 —— 否则 textOnly 分页每翻一页都要重跑 ASR。
          const asrCacheKey = await cacheKey({
            input, start: winStart, end: winStart + winDur,
            threshold: `asr|${ASR_DEFAULTS.baseUrl}|${ASR_DEFAULTS.model}|${asrMaxChunk}|${transcript}|${hotwords ?? ''}`,
          });
          // 本地 ASR 可能要临时拉起（用完就停）—— 只在 asr.json 配了 manage.start 时才托管
          const asrCfg = resolveAsrConfig();
          // `spawnImpl` 不要在这里传：这个文件从来没导入过 spawn，
          // 传 `spawnImpl: spawn` 等于每跑一次就 ReferenceError 一次，被下面的 catch 吞成
          // "asr-failed · spawn is not defined" —— 转写于是永远是空的。默认值在 asr-lifecycle 里。
          asrLife = await ensureAsr({ baseUrl: asrCfg.baseUrl, config: asrCfg })
            .catch((e) => { if (process.env.DSH_ASR_DEBUG) console.error('[asr-lifecycle]', e.message); return null; });
          const asr = await withCache(asrCacheKey, () => transcribeLong({
            input, ffmpegPath, start: winStart, end: winStart + winDur,
            // apiKey 必须传：否则关掉 ASR 只能靠"没 key"，而本机服务不需要 key
            silences, maxChunk: asrMaxChunk, apiKey: asrKey,
            ...(hotwords !== undefined ? { hotwords } : {}),
          }), { enabled: cache });
          if (asr) {
            // 音乐段的幻觉句会命中多个格子、被复制好几遍，先过滤（结果里报出来，不静默丢）
            const { kept, dropped } = filterSuspectSegments(asr.segments);
            // 用户词典校正（确定性替换，替换次数会报出来）
            const { segments: fixed, replaced } = applyTermMap(kept, resolveAsrConfig().terms);
            transcriptInfo = {
              ...(replaced > 0 ? { termsFixed: replaced } : {}),
              ...asr,
              // 空结果（整片纯音乐 / 服务在跑但没听到话）不该自称 asr —— 见 PR #3。
              // "没配 key 所以没跑" 已经在上面被 willTranscribe() 分流成 no-key，走不到这里。
              source: asr.empty || fixed.length === 0 ? 'asr-empty' : 'asr',
              segments: fixed,
              suspect: dropped.length,
              suspectDetail: dropped.slice(0, 3).map((d) => ({
                from: +d.from.toFixed(2), to: +d.to.toFixed(2),
                charsPerSec: d.charsPerSec, reason: d.reason,
              })),
            };
          }
        } catch (error) {
          transcriptInfo = {
            segments: [],
            source: 'asr-failed',
            // 把真实原因带出来 —— 只写 "ASR call failed" 会让每次故障都得重新猜
            error: `${explainFetchError(error).slice(0, 300)}  [${describeAsrTarget()}]`,
          };
        }
      }
    } else if (transcript !== 'off' && !info.hasAudio) {
      transcriptInfo = { segments: [], source: 'no-audio' };
    }
    // 一致性检查：台词落在"被判静音"的区间里 = 两种可能，轻声被吞了，或者 ASR 编的。
    const textInSilence = transcriptInfo?.source === 'asr'
      ? countTextInSilence(transcriptInfo.segments, silences)
      : 0;

    return {
      transcriptInfo: (transcriptInfo && subtitleNeedsLogin)
        ? { ...transcriptInfo, subtitleNeedsLogin: true }
        : transcriptInfo,
      textInSilence,
    };
  })();

  // 扫描结果按 (文件, 窗口, 阈值策略) 缓存：storyboard 之后的 zoom 能直接复用
  const key = cache ? await cacheKey({ input, start: winStart, end: winStart + winDur, threshold }) : null;
  // precomputed：批量模式下全片已经扫过一次，窗口直接复用那份切点与摘要，
  // 不再为每个窗口重新解码一遍（2 小时的片子能省掉 24 次重复扫描）。
  // 逐帧指纹只在"真的扫了"的那一次里拿得到（缓存存不下 Uint8Array），
  // 所以缓存命中 / precomputed 时它们是 null，tagCuts 会退化成不打标签。
  let scanMeans = null;
  let scanPrints = null;
  const scan = precomputed
    ? {
      cuts: (precomputed.cuts ?? []).filter((c) => c.t >= winStart && c.t < winStart + winDur),
      summary: precomputed.summary ?? { frames: 0, p90: 0, p99: 0 },
      threshold: precomputed.threshold ?? threshold,
      cached: false,
      reused: true,
    }
    : await withCache(key, async () => {
      const s = await scanShots({
        input, fps: info.fps, threshold, start: winStart, end: winStart + winDur,
        // 默认 0.35s：两刀之间短于它的合并成一刀。快闪素材（<0.35s 一个镜头）要显式调小，
        // 否则 3 秒 18 个镜头会被压成 4 刀 —— 实测过，这是"数不出快闪"的主因。
        minGap: scanGap, ffmpegPath, onProgress,
      });
      // **逐帧的 means / prints 不进缓存**：级联缓存走的是 JSON.stringify，
      // 而 prints 是 7500 个 Uint8Array —— 序列化后会变成 {"0":12,"1":34,…}，
      // 60 分钟片子直接几十 MB，而且读回来类型也丢了（判据会拿到坏数据）。
      // 它们只在本次调用里给 tagCuts 用，缓存命中时没有就算了（退化成不打标签）。
      // 但**黑场段要单独存下来**：means 只在扫描那一次存在，不存的话"黑场独占一格"
      // 只在第一次跑生效，第二次（命中缓存）黑场又并回内容格里 —— 同一支片子两次出图不一样。
      scanMeans = s.means;
      scanPrints = s.prints;
      return {
        cuts: s.cuts, stats: s.stats, frames: s.frames,
        threshold: s.threshold, degraded: s.degraded, summary: s.summary,
        darkRuns: detectDarkRuns(s.means, { fps: info.fps }),
      };
    }, { enabled: cache });
  if (cache && !scan.cached && !precomputed) await pruneStorage();
  mark('scan');

  // ---- 爆点细扫（见 refineBurstCuts 注释：粗扫看不见 0.35s 以下的刀）
  // **运行一开始就续命**。上一次运行结束时设的 idleMs 计时器，会在这一次运行的扫描阶段到点，
  // 把服务关掉 —— 等这次终于到转录那一步又得重新拉起（白等 30 秒）。续命一次就避免这种浪费。
  if (isOwned()) keepAlive();
  let cuts = scan.cuts;

  // ---- 极静素材（PPT / 代码录屏 / 固定机位）：绝对阈值会漏掉"只改了几个像素"的翻页。
  // 这类素材的分数中位数接近 0，一页 PPT 换页可能只有 3–8 分，压在任何合理绝对阈值下面。
  // 改用**相对基线**再找一次（和本地中位数比），只在确实更静的时候替换。
  // 用户反馈（野生的猛龙）：纯 PPT 视频上"阈值压到 0.08 也一条都检不出来，只能退回等间隔"。
  if (!precomputed && scan.stats.length > 20) {
    // 判据是**刀密度**，不是"画面静不静"：实测概念 PV / 沧野 / MAD 的中位分都是 0.9–1.1，
    // 和录屏素材（0.0–1.4）完全混在一起，用中位分根本分不开。
    // 能分开的是刀/秒：录屏 0.11–0.22，视频内容 0.40–0.49。
    const perSec = cuts.length / Math.max(1, winDur);
    if (perSec < 0.25) {
      // minAbs 4：实测 320×180 上"改一块约 3.5% 的画面"峰值只有 5.7 分、7.8% 才 11.8 分 ——
      // 绝对阈值 12~15 全都漏；而静止画面的噪声底只有 0.0–1.5，4 分足够把噪声挡在外面。
      const spikes = suppressClose(spikeCuts(scan.stats, { k: 4, minAbs: 4, halfWindow: 12 }), scanGap);
      if (spikes.length > cuts.length) cuts = spikes;
    }
  }

  let refinedBursts = [];
  if (refineBursts && !precomputed && !textOnly) {
    const r = refineCutsByWindow({ stats: scan.stats, coarseCuts: cuts, fps: info.fps, winStart, winDur });
    cuts = r.cuts;
    refinedBursts = r.refined;
  }

  // ---- 给每个切点打类型标签（flash / white / black / hardcut / dissolve / motion）。
  // **一个都不删**：删掉误检会让这段在插件眼里变成"完全静止"，反而丢了"这里一直在动"。
  // 标签只用于清单表述和下游降权，格位分配靠的是变化率积分（见 densityFromScore）。
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
  // ---- 硬字幕校正：只在明确要求、且转写来自 ASR 时才做
  let ocrReport = null;
  if (ocr && transcriptInfo?.source === 'asr' && (transcriptInfo.segments?.length ?? 0) > 0) {
    ocrReport = await correctByOnScreenSubs({
      input, winStart, winDur, ffmpegPath, segments: transcriptInfo.segments, remoteFrame,
      // URL 模式下 input 是下载的扫描副本（默认 360p）。scale=1280 放大不回细节，
      // 所以这份校正是"基于低清副本做的"，必须让清单说清楚，而不是假装和原流一样准。
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
  // 窗口口径：transcriptFile 可能给的是整片，不能拿整片 chars 去除以 winDur。
  const transcriptChars = relSegments.reduce((n, seg) => n + String(seg.text ?? '').length, 0);
  // 外部文本只做标记，不改变执行：注入扫描是证据，不是策略。
  // 标题也算外部文本（yt-dlp 的 title 会进清单），一并扫；它没有时间码，from/to 留 null。
  const externalSource = sourceInfo?.url ?? info.path ?? null;
  const suspectInjection = findInjection(
    [
      ...(sourceInfo?.title ? [{ text: sourceInfo.title }] : []),
      ...relSegments,
    ],
    { source: externalSource },
  );
  const speech = relSegments.length > 0
    ? speechCurve(relSegments, { duration: winDur })
    : null;

  // 声音事件只有在"话不密"的片子里才有信息量：
  // 口播片每句话的停顿都会触发（实测 299s 里 92 次），铺到密度曲线上等于把它压平。
  const speechRateForEvents = winDur > 0
    ? relSegments.reduce((n, seg) => n + seg.text.length, 0) / winDur : 0;
  const audioEvents = speechRateForEvents < 3
    ? [...allEvents]
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
      .slice(0, 12)
      .sort((a, b) => a.t - b.t)
    : [];

  // ---- 格数：放在台词与音频之后，是为了让"口播多不多 / 是不是音乐驱动"参与决策
  let cells = Math.max(0, Number(opts.cells) || 0);
  let sheets = Math.max(0, Number(opts.sheets) || 0);
  const autoPlan = cells === 0;
  // 和 suggest() 用同一个口径；下面写进 plan.inputs，方便复现判定。
  const speechRate = winDur > 0 ? transcriptChars / winDur : 0;
  let suggestion;
  if (cells === 0) {
    suggestion = suggest({
      duration: winDur,
      cuts: cuts.length,
      motion: scan.summary.p90,
      aspect: info.aspect,
      speechRate,
      hasSubtitle: info.hasSubtitle,
      meanLufs: audio?.mean,
      ...(planThresholds ? { thresholds: planThresholds } : {}),
    });
    cells = suggestion.cells;
    sheets = sheets || suggestion.sheets;
  }
  // 音乐驱动**只影响取帧**，不影响格数（格数走 rodt）。音乐片的信息全在画面上，
  // 所以把"摊开"的触发门槛压低：同样的段更容易摊、摊得更细。
  // 用 isMusicDriven 单独判一次，而不是只读 suggestion —— 显式指定 cells 时 suggestion 是空的，
  // 但"音乐片取帧更密"跟格数从哪来无关。
  const musicDriven = suggestion?.musicDriven === true
    || isMusicDriven({ meanLufs: audio?.mean, speechRate, thresholds: planThresholds ?? {} });
  sheets = sheets || 1;
  // ---- 格数**往上补满**
  // 5 格会排成 2×3（容量 6），右下留一个空格。空格和画面占的是同一张画布、同样的 token，
  // 所以空着是纯损失 —— 把每张图的格数补到布局容量，再按补后的数去取帧。
  // 往上补不往下砍：少一格等于少看一个瞬间，多一格只是多花一次取帧（约 0.3 s）。
  const fitted = fillLayout(cells, info.aspect);
  // 补过之后要能看出"你其实要了 5 格"：清单里两个数都给，否则模型会以为自己看的是 5 格。
  const filledFrom = fitted.cells > cells ? cells : null;
  cells = fitted.cells;
  // 本次实际输入 + 生效阈值。只记录，不做成十几个可配置旋钮。
  const planInfo = {
    cells, sheets, adaptive, pick, burn, minGap,
    ...(filledFrom ? { filledFrom } : {}),
    reason: suggestion?.reason ?? 'explicit',
    auto: autoPlan,
    inputs: {
      duration: +winDur.toFixed(2),
      scanThreshold: scan.threshold,
      meanLufs: Number.isFinite(audio?.mean) ? +audio.mean.toFixed(1) : null,
      speechRate: +speechRate.toFixed(2),
      motion: +(Number(scan.summary?.p90) || 0).toFixed(1),
      cuts: cuts.length,
      hasSubtitle: Boolean(info.hasSubtitle),
    },
    thresholds: { ...PLAN_THRESHOLDS, ...(planThresholds ?? {}) },
  };

  // 两条路：自适应按密度分配格位（快切区多给格），否则退回"并段到 k 格"
  mark('transcript');
  const relCuts = cuts.map((c) => c.t - winStart);
  // **积分采样点（假切点）**：扫描之后立刻算好，交给下面"格内取几帧 / 取在哪"用。
  // 它不进 `cuts` —— 清单里"切点 N 个"必须还是真切点，否则模型会以为那些地方有硬切。
  // 阈值就是 equivSeconds（每条采样点代表多少秒的平均变化量），音频驱动只改这一个数：
  // 音乐片信息全在画面上，所以每 4 秒等效变化就采一个点（默认 6 秒）。
  const sampleMarks = scan.stats?.length
    ? integralMarks({
      duration: winDur,
      series: scan.stats,
      cuts: cuts.map((c) => c.t),
      start: winStart,
      equivSeconds: musicDriven ? 4 : 6,
    })
    : [];
  planInfo.sampleMarks = sampleMarks.length;
  // 让 video_locate 能直接复用这次的转写，省掉一次 ASR
  if (transcriptInfo?.segments?.length) rememberSegments(input, transcriptInfo.segments);
  let cellRanges;
  if (adaptive && relCuts.length > 0) {
    // 密度来源：用**画面变化率**而不是切点计数（见 densityFromScore 的注释）。
    // 复用缓存时逐帧 stats 还在（它跟着扫描结果一起存），所以这条不会退化。
    // **黑场单独成段**：黑屏在分数上几乎是 0（前后都黑，没有"变化"），永远不会被当成切点，
    // 于是它和后面的 logo/正片挤在同一格里，而那一格取中点数 —— 正好落在黑里，整格纯黑。
    // 实测概念PV：片头 0–5.7s 全黑（亮度 1），0–37.6s 那一格的中点 18.8s 亮度是 0。
    // 现在把 ≥2 秒的黑场各切出来独占一格，片头/片尾的黑屏不再吞掉内容。
    // 黑场段是扫描时算好存进缓存的（见上面 darkRuns），不依赖本次有没有 means。
    const darkRuns = (Array.isArray(scan.darkRuns) ? scan.darkRuns : [])
      .filter((r) => r.to - r.from >= 2 && r.from < winDur);
    let segRanges;
    if (darkRuns.length > 0) {
      const parts = [];
      let cursor = 0;
      for (const d of darkRuns) {
        if (d.from > cursor + 0.5) parts.push({ from: cursor, to: d.from, dark: false });
        parts.push({ from: d.from, to: Math.min(d.to, winDur), dark: true });
        cursor = Math.min(d.to, winDur);
      }
      if (cursor < winDur - 0.5) parts.push({ from: cursor, to: winDur, dark: false });

      // 黑场**额外占格**，不从内容格数里扣 —— 否则 4 段黑场就把 4 格吃光，
      // 剩下 65 秒的内容挤成一格（实测踩过）。
      const contentTotal = cells * sheets;
      const countIn = (p2) => relCuts.filter((c) => c >= p2.from && c < p2.to).length;
      const allContentCuts = parts.filter((x) => !x.dark).reduce((n, p2) => n + countIn(p2), 0);

      segRanges = [];
      for (const p2 of parts) {
        if (p2.dark) {
          segRanges.push({ from: p2.from, to: p2.to, density: 0, dark: true });
          continue;
        }
        // 内容区按各自占的刀数比例分格，内部仍用 rodt
        const share = allContentCuts > 0
          ? Math.max(1, Math.round((contentTotal * countIn(p2)) / allContentCuts))
          : 1;
        const rs = planByRodt({
          duration: p2.to - p2.from,
          cuts: relCuts.filter((c) => c >= p2.from && c < p2.to).map((c) => c - p2.from),
          cells: share,
        });
        segRanges.push(...rs.map((r) => ({ from: r.from + p2.from, to: r.to + p2.from, density: r.density })));
      }
      segRanges.sort((a, b) => a.from - b.from);
    } else {
      // **rodt**：每格长度 = 常数 ÷ 该处的切点密度（B = K/A）。
      // 一分钟切 70 刀的地方一格 5 秒，一分钟才 18 刀的地方一格 24 秒 —— 实测相差 4.6~5.5 倍。
      // 而且因为用"累积切点等分"实现，每格的镜头数也顺带均匀（6~10 个），不用再单独约束。
      segRanges = planByRodt({ duration: winDur, cuts: relCuts, cells: cells * sheets });
    }
    cellRanges = segRanges
      .map((r) => ({ from: r.from + winStart, to: r.to + winStart, density: r.density, dark: r.dark === true }));
    // 黑场是从"内容格数"里抠出来的（每段独占一格），所以总段数会比原计划多。
    // 布局按 cells 分组，容量不够就会丢格 —— 这里把 cells 抬到实际段数。
    if (cellRanges.length > cells * sheets) {
      cells = Math.ceil(cellRanges.length / sheets);
    }
  } else {
    const segs = segmentsFromCuts(winDur, relCuts, 0.4, winStart);
    cellRanges = fitSegments(segs, cells * sheets, { minGap })
      .map(([a, b]) => ({ from: a, to: b, density: 1 }));
  }
  const groups = [];
  // **先排好画面，再按累计帧数切 sheet**（流程的最后一步）。
  // 一格不摊是 1 帧、摊 3×3 是 9 帧，格数一样但信息量差 9 倍，
  // 所以只能按"这一格贡献多少帧"来切，不能按格数均分。
  // 切的是格点边界（= 切点），上一张末尾切点就是下一张起点，天然衔接不断裂。
  if (!(Number(opts.sheets) > 0)) {
    // 调用方没指定张数 → 按累计帧数切（自适应）
    const kEst = cellRanges.map((r) => {
      const cs = cuts.filter((c) => c.t >= r.from && c.t < r.to);
      const marks = sampleMarks.filter((t) => t >= r.from && t < r.to);
      const cutScore = cs.length ? cs.reduce((a, c) => a + (c.score ?? 0), 0) / cs.length : Infinity;
      return chooseSubGrid({
        shots: cs.length + 1 + marks.length, cellW: 250, cellH: 140, dur: r.to - r.from, cutScore,
      });
    });
    groups.push(...planSheetsByFrames(
      cellRanges.map((r, i) => ({ ...r, k: kEst[i] })),
      { frameBudget: 64, maxCellsPerSheet: 16 },
    ));
    sheets = groups.length;
  } else {
    // 调用方显式指定了张数（测试、批量脚本）就尊重它，仍按格数均分
    for (let i = 0; i < sheets; i++) groups.push(cellRanges.slice(i * cells, (i + 1) * cells));
  }

  // textOnly：只重算"格 → 时间段 → 台词"，一帧都不解、一张图都不拼。
  // 用途：总览文本被宿主截断后，按 cellRange 分批把剩下的台词取回来（第二次调用命中缓存，几乎瞬时）。
  if (textOnly) {
    const cellsMeta = [];
    let n = 0;
    for (const group of groups) {
      const aligned = alignCells(group, transcriptInfo?.segments ?? []);
      group.forEach(({ from: a, to: b }, gi) => {
        n += 1;
        const t = aligned[gi] ?? null;
        cellsMeta.push({
          i: n,
          t_start: +a.toFixed(3),
          t_end: +b.toFixed(3),
          ...(t?.text ? { text: t.text, charsPerSec: t.charsPerSec } : {}),
        });
      });
    }
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
    // 哪些窗口被细扫过、粗扫/细扫各数出多少刀 —— 清单要据此说明"这段的镜头数可信"
    ...(refinedBursts.length ? { refinedBursts } : {}),
      totalDuration: +cellRanges.reduce((n2, r) => n2 + (r.to - r.from), 0).toFixed(3),
    };
  }

  const out = [];
  let index = 0;
  let fallbacks = 0;
  for (const [si, group] of groups.entries()) {
    if (group.length === 0) continue;
    const { cols, rows } = bestLayout(Math.max(1, group.length), info.aspect);
    // 有音频带时先扣掉条带占用的预算：layoutCanvas 与 composeSheet 必须用**同一个** budget，
    // 否则取帧尺寸和拼图尺寸不一致，图会变成斜条纹（踩过）
    const cellBudget = stripAudio ? Math.round(budget * 0.9) : budget;
    const { width, height, cellW, cellH } = layoutCanvas(cols, rows, info.aspect, cellBudget);
    const aligned = alignCells(group, transcriptInfo?.segments ?? []);
    const frames = [];
    const cellMeta = [];
    // 摊格子要额外取 k²−1 帧（4×4 就是 15 次 ffmpeg）。整张图最多多取 32 帧，
    // 否则一支全是快闪的片子会变成"每格取 16 张"，渲染时间翻十几倍。
    // 摊格子要额外取 k²−1 帧（4×4 就是 15 次 ffmpeg）。原来设 32，实测概念 PV 上
    // 41 个镜头只覆盖到 33 个 —— 有 10 个镜头（24%）压根没出现在图上。
    // 提到 48 就能全覆盖（画面 57 个、覆盖 41/41），代价约多 16 帧 × 并发 3 路 ≈ 0.3~0.5 秒。
    const subBudget = 48;
    // ---- 取帧：先算完所有格子的参数，再并发取帧，最后按顺序组装。
    // 原来是一格一格 await（9 格串行，短视频里占 60% 的时间）。ffmpeg 每次只解一帧，
    // 彼此没有依赖，并发 3 路就能把这部分压掉一半以上。
    const plan = [];
    for (const [gi, { from: a, to: b }] of group.entries()) {
      const cellCutList = cuts.filter((c) => c.t >= a && c.t < b);
      const cellCuts = cellCutList.length;
      // 本格里的积分采样点：它们和真切点一样是"分段边界"，所以合并成一份
      // `marks` 传给下面 —— 摊几×几看它有几个分段，每个分段取一帧。
      const cellMarks = sampleMarks.filter((t) => t >= a && t < b);
      const cutScore = cellCuts > 0
        ? cellCutList.reduce((n, c) => n + (c.score ?? 0), 0) / cellCuts
        : Infinity;
      // 段内逐帧分数的均值 —— 静止约 0.2、匀速摇镜 1.5~3。
      // 用来兜住"一个镜头但在动"的段，否则整段只取 1 帧，运动过程全丢。
      const cellStats = (scan.stats ?? []).filter((x) => x.t >= a && x.t < b);
      const meanMotion = cellStats.length
        ? cellStats.reduce((n2, x) => n2 + x.score, 0) / cellStats.length
        : 0;
      const want = chooseSubGrid({
        shots: cellCuts + 1 + cellMarks.length, cellW, cellH, dur: b - a, cutScore, meanMotion,
        // 音乐驱动：单镜头但有动静就摊（门槛 1.5 → 0.7）
        minMotion: musicDriven ? 0.7 : 1.5,
      });
      plan.push({
        gi, a, b, cellCuts,
        // 本格的分段边界（真切点 + 积分采样点），摊开时用它决定每个子帧落在哪一段里
        cutTimes: [...cellCutList.map((c) => c.t), ...cellMarks].sort((x, y) => x - y),
        sub: want, want, rate: (cellCuts + 1 + cellMarks.length) / Math.max(0.1, b - a),
      });
    }
    // 预算按「刀/秒」从高到低分配，**不按格序**。
    // 原来按序发，密集的那格要是排在后面就拿不到预算 —— 实测 MAD 9 格里最密的第 8 格
    // （1.51 刀/秒）正好排最后，能摊开纯属前面几格没抢。
    let budgetLeft = subBudget;
    for (const p of [...plan].sort((x, y) => y.rate - x.rate)) {
      let s = p.want;
      while (s > 1 && s * s - 1 > budgetLeft) s -= 1;   // 预算不够就降档，降不下去就整格
      if (s > 1) budgetLeft -= s * s - 1;
      p.sub = s;
    }

    const _ex0 = Date.now();
    const shots = await mapPool(plan, frameConcurrency, async ({ a, b, sub, cutTimes }) => {
      if (sub > 1) {
        // 快闪格：摊成 k×k，一张图交代 k² 个瞬间（token 不变）
        return extractSubTile({
          input, remote: remoteFrame, a, b, k: sub, cellW, cellH, ffmpegPath,
          shots: cutTimes,
        });
      }
      return extractFrameWithFallback({
        input, remote: remoteFrame, at: a, dur: b - a, cellW, cellH, ffmpegPath, pick,
      });
    });

    timing.extract = (timing.extract ?? 0) + (Date.now() - _ex0) / 1000;
    for (const [ki, { gi, a, b, cellCuts, sub }] of plan.entries()) {
      index += 1;
      const frame = shots[ki];
      if (frame.via === 'local-fallback') fallbacks += 1;
      frames.push({ buffer: frame.buffer, index });
      const text = aligned[gi] ?? null;
      cellMeta.push({
        i: index,
        sheet: si + 1,
        t_start: +a.toFixed(3),
        t_end: +b.toFixed(3),
        // 平铺格的画面是 k² 个瞬间，不存在"这一格的取帧时刻"；
        // 不写 t_frame，清单和 evidence 都不会给出误导性的 frame@。
        ...(sub > 1 ? { sub } : { t_frame: +frame.t.toFixed(3) }),
        // 黑场格：整段没有内容，清单要写明，否则模型会以为"这一格是空的、可能采样失败"
        ...(group[gi]?.dark ? { dark: true } : {}),
        ...(cellCuts > 0 ? { cuts: cellCuts } : {}),
        ...(frame.sharp !== undefined ? { sharp: +frame.sharp.toFixed(1) } : {}),
        ...(text?.text ? { text: text.text, charsPerSec: text.charsPerSec } : {}),
      });
    }
    let sheet = composeSheet({
      frames, cols, rows, cellAspect: info.aspect, budget: cellBudget, burn, badgeRatio,
    });
    if (stripAudio) {
      // 条带高度按"宽的 5.5%"会在大长条上失控（2476px 宽 → 136px 高，占掉 37% 画面），
      // 所以同时受格高的 40% 约束。
      const stripH = Math.max(24, Math.min(Math.round(width * 0.055), Math.round(cellH * 0.28)));
      sheet = addAudioStrip(sheet, {
        loudness: stripAudio, silences: stripAudio.silences, cuts: cuts.map((c) => c.t),
        window: { from: winStart, to: winStart + winDur }, stripH,
      });
    }
    out.push({
      sheet: si + 1, cols, rows, cellW, cellH,
      width: sheet.width, height: sheet.height, buffer: sheet.buffer, cells: cellMeta,
      ...(sheet.stripH ? { stripH: sheet.stripH } : {}),
      ...(encode ? { png: await encodePngBuffer(sheet.buffer, sheet.width, sheet.height, { ffmpegPath }) } : {}),
    });
  }

  const totalDuration = +cellRanges.reduce((n, r) => n + (r.to - r.from), 0).toFixed(3);

  // 记一笔"看过什么"：下次 probe 能告诉模型"这部片子你看过"，避免重新描述一遍。
  // 失败不影响结果（记忆是锦上添花）。
  // 必须 await：不 await 的话下一次 probe 可能读不到这一笔（实测踩到，少了一整段）
  await remember(info, {
    from: winStart, to: winStart + winDur, cells: cellRanges.length, cuts: cuts.length,
  }).catch(() => {});

  mark('frames');
  // 本次运行结束：如果是我们拉起的本地 ASR，安排它空闲后自动退出
  // （own 的才停 —— 别人启动的实例无权杀，杀了会打断正在用它的任务）
  if (asrLife?.owned || isOwned()) {
    const c = resolveAsrConfig();
    scheduleStop({
      owned: true, config: c, baseUrl: c.baseUrl,
      minIdleMs: Number.isFinite(asrIdleMs) ? asrIdleMs : undefined,
    });
  }

  // **这里是赋值，不是 return。**
  // 原来是 `return {`：函数当场结束，后面记 cell 表的 `saveCells()` 和 `return result`
  // 全成了死代码 —— 所以 0.4.4 的 cell 表**从来没写进去过**，
  // `video_zoom({ cellId })` 一直找不到格子，只能退回 from/to。
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
    // 链接来源的元信息（本地文件时没有这一段）。直链不在里面，那是临时凭证。
    ...(sourceInfo ? { source: sourceInfo } : {}),
    // 哪些窗口被细扫过、粗扫/细扫各数出多少刀 —— 清单要据此说明"这段的镜头数可信"
    ...(refinedBursts.length ? { refinedBursts } : {}),
    // 有高清直链却有格子落了回来 —— 要报，否则"这格怎么这么糊"没有解释
    ...(fallbacks > 0 ? { frameFallbacks: fallbacks } : {}),
    audio: stripAudio
      ? {
        ...stripAudio,
        events: allEvents,
        summary: describeAudio(stripAudio, winDur),
      }
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
        ...(transcriptInfo.error ? { error: transcriptInfo.error } : {}) }
      : null,
    plan: {
      ...planInfo,
      // 实际出片格数：minGap 会把"要 16 格"压成 8 格，清单必须两个数都给，
      // 否则首行写 16、末尾写 total 8，读起来像是出错了。
      produced: cellRanges.length,
      bursts: findBursts(relCuts, winDur).map((b) => ({
        from: +(b.from + winStart).toFixed(2), to: +(b.to + winStart).toFixed(2),
        shots: b.shots, density: b.density,
      })),
    },
    sheets: out,
    totalDuration,
  };

  // 记下"这一格 = 这段绝对时间"，供 video_zoom({ cellId }) 直接寻址（清单里的 t_start 是窗口相对值）。
  // 不 await：写失败不该影响出图，寻址会退回 from/to。
  if (!textOnly) {
    const cellTimes = [];
    for (const sheet of out) {
      for (const c of sheet.cells) {
        cellTimes.push({ i: c.i, from: c.t_start + winStart, to: c.t_end + winStart });
      }
    }
    // 必须 await：紧接着的 video_zoom({cellId}) 可能立刻来查；saveCells 自己吞写失败，
    // 不会影响出图。URL 输入还要拿原始 URL 当别名（此时 input 已是下载到本地的路径）。
    await saveCells([inputRaw, input].filter(Boolean), cellTimes);
  }

  return result;
}

/* ---- 兼容入口 ---------------------------------------------------------------
 * `./pipeline` 是 package.json 里公开的子路径（老版本把清单渲染也放在这里）。
 * 内部代码一律直接从 format.js / frames.js / scan.js 取；这一段只为不让已经
 * `import { formatManifest } from 'dsh-video-storyboard/pipeline'` 的调用方断掉。
 */
export {
  DETAIL_CHARS, buildEvidence, countTextInSilence, formatForDetail, formatManifest,
  formatProbe, formatRemoteProbe, formatTimeline, saveStoryboards, truncateAtSentence,
  withSheetSuffix,
} from './format.js';
export { chooseSubGrid } from './frames.js';
export { refineCutsByWindow } from './scan.js';

