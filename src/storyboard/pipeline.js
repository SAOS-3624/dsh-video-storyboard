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
import {
  detectDarkRuns, packPrints, packedFps, refineCutsByWindow, scanShots, spikeCuts,
  suppressClose, unpackPrints,
} from './scan.js';
import { tagCuts } from './flash.js';
import { rememberSegments } from './locate.js';
import { ensureAsr, isOwned, keepAlive, scheduleStop } from './asr-lifecycle.js';
import { cachedTranscript, rememberTranscript } from './transcript-cache.js';
import { musicDrivenVerdict, readabilityOf, suggest, PLAN_THRESHOLDS } from './plan.js';
import { findBursts, integralMarks } from './density.js';
// 一张图会产生多少帧，切张与渲染共用同一个答案（见 measure.js 顶部说明）。
// 现在这个"答案"由 layout.planLayout() 一次量好并随 groups 一起返回，pipeline 不再自己调。
// 排布决策（几张 / 每张几格 / 时间轴怎么切）已经独立成 layout.js：纯算术、可单测。
import { planLayout } from './layout.js';
import { remember } from './memory.js';
import { analyzeAudio, analyzeRhythm, describeAudio, detectOnsets, hasAudibleSamples } from './audio.js';
import {
  alignCells, applyTermMap, asrBackendId, canTranscribe, describeAsrTarget, explainFetchError,
  extractSubtitleTrack, filterSuspectSegments, resolveAsrConfig, speechCurve, transcribeLong,
} from './asr.js';
import { fetchRemoteSubtitles } from './subtitles.js';
import { cacheKey, withCache } from './cache.js';
import { pruneStorage } from './storage.js';
import { saveCells } from './cells.js';
import { ffmpegVersion, sha256File } from './provenance.js';
import { findInjection } from './injection.js';
import { addAudioStrip, addSheetHeader, clock, composeSheet, encodePngBuffer } from './sheet.js';
import { extractFrameWithFallback, extractSubTile, mapPool } from './frames.js';
import { correctByOnScreenSubs } from './ocr-subs.js';
import { countTextInSilence } from './format.js';

export const PICK_MODES = ['sharp', 'mid', 'thumb'];// 只有两种：时间码不烧进画面 —— 它占像素、压缩后先糊，而清单里已经有 0.01 秒精度的时间。
// （历史上 `index+time` 在参数表里但从没实现过，等于一个会静默失效的选项。）
export const BURN_MODES = ['index', 'none'];

// 子帧预算的算法随"量帧数"一起搬到了 measure.js（切张与渲染共用同一个口径）。
// 这里只做兼容再导出：`./pipeline` 是公开子路径，老调用方可能还在直接 import 它们。
export { SUB_BUDGET, SUB_BUDGET_MAX, subBudgetFor } from './measure.js';

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
    // 摊开优先：少几格、每格更大，好让 2×2 / 3×3 排得下（见 plan.suggest 里的 tileFirst）
    tileFirst = false,
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
    // 出图几何：像素预算 / 每张格数上限 / 目标可读性（need 只影响自动排格的上限）。
    // 三个值由 board.js 的 boardGeometry() 算好传进来，管线不再自己解释 size 档位。
    budget = 640_000,
    // **0 = 交给 layout 按 budget + need 推**（和 boardGeometry 走同一个 plan.maxCellsForNeed）。
    // 以前这里写死 16：于是"直接调 runStoryboard"和"走 CLI / DSH 工具"对同一个 budget
    // 给出两种几何（32 格 341×189 vs 24 格 394×220）—— 同一件事两个口径，正是要收掉的。
    maxPerSheet = 0,
    need = 'scene',
    // 只传 from 时自动推下一段：segment 秒。0 = 看到片尾（短片默认）。
    segment = 0,
    // 只取一帧（cells:1 的语义）：不做格内摊开。清单说 1 格就必须是 1 帧。
    noTile = false,
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
  /**
   * 窗口终点。三种情况，按优先级：
   *  1. 显式 `to` —— 调用方说了算；
   *  2. 给了 `segment`（或 from>0 但没给 to）—— 按固定长度推下一段。
   *     这是给 SEQUENCE 用的：只传 from，不用自己记"下一段从哪开始"；
   *  3. 都没有 —— 看到片尾（短片/整片概览）。
   *
   * 旧行为是"from>0 且没 to → 看到片尾"：2 小时的片子传了 from:600 就等于
   * 悄悄把剩下 110 分钟全扫了，扫描和 ASR 都按整段算，一次调用能烧十几分钟。
   */
  const segSec = Number(segment) > 0
    ? Math.max(1, Math.round(Number(segment)))
    : (winStart > 0 ? 300 : 0);
  const autoWindow = !(Number(to) > 0) && segSec > 0;
  const winEnd = Math.min(
    info.duration,
    Number(to) > 0 ? Number(to) : (autoWindow ? winStart + segSec : info.duration),
  );
  const winDur = Math.max(0.2, winEnd - winStart);

  // 分阶段计时：只有真跑的时候才知道慢在哪。结果里带 timing，不额外开销（Date.now 级别）
  // 本地 ASR 的生命周期句柄：只有"我们拉起来的"那个才会在结束时被停。
  // 必须声明在转写块之前 —— 转写现在跑在扫描之前（并行），拿不到后面声明的变量。
  let asrLife = null;
  // ASR 的耗时与命中情况（清单的成本行要用）：null = 这次没转写
  let asrSeconds = null;
  let asrCached = null;

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
          //
          // **后端身份必须和实参同源**（issue #38）：没传 hotwords 时，实际用的是 asr.json 里的值，
          // 旧键却写 '' —— 改了热词仍命中旧缓存。现在先把 hotwords/language 解析成这一次真正要用的值，
          // 键和 `transcribeLong()` 的入参都用它。
          // 前缀 `asr2|` 让旧缓存（以及 transcript-cache 里的旧后端身份）自然作废，不需要用户手清。
          const asrCfg = resolveAsrConfig();
          const asrHotwords = hotwords !== undefined ? hotwords : asrCfg.hotwords;
          const asrBackend = asrBackendId({
            baseUrl: asrCfg.baseUrl, model: asrCfg.model, language: asrCfg.language,
            maxChunk: asrMaxChunk, transcript, hotwords: asrHotwords,
          });
          const asrCacheKey = await cacheKey({
            input, start: winStart, end: winStart + winDur, threshold: asrBackend,
          });
          // **先看按片缓存**：只要已有一段完整覆盖这个窗口，就直接切出来用。
          // 这一层和上面的 cacheKey 不重复：那个键含窗口，zoom 到已转写段里的 20 秒会 miss；
          // 这里存的是绝对时间，覆盖住就给，不再把同一段语音转第二遍。
          const covered = cache
            ? await cachedTranscript(input, { from: winStart, to: winStart + winDur, backend: asrBackend })
              .catch(() => null)
            : null;
          // 本地 ASR 可能要临时拉起（用完就停）—— 只在 asr.json 配了 manage.start 时才托管。
          // 命中按片缓存时**不拉起**：省一次模型加载，也不会白占几 GB。
          if (!covered) {
            // `spawnImpl` 不要在这里传：这个文件从来没导入过 spawn，
            // 传 `spawnImpl: spawn` 等于每跑一次就 ReferenceError 一次，被下面的 catch 吞成
            // "asr-failed · spawn is not defined" —— 转写于是永远是空的。默认值在 asr-lifecycle 里。
            asrLife = await ensureAsr({ baseUrl: asrCfg.baseUrl, config: asrCfg })
              .catch((e) => { if (process.env.DSH_ASR_DEBUG) console.error('[asr-lifecycle]', e.message); return null; });
          }
          // 记下 ASR 花了几秒：清单要报"这次转写花了 3 分 12 秒 / 命中缓存 0 秒"。
          // 只报 CPU 秒数没有意义（用户原话：成本该报成"图数×token + ASR 秒数"）。
          const asrStart = Date.now();
          const asr = covered
            ? { segments: covered.segments, empty: covered.segments.length === 0, cached: true }
            : await withCache(asrCacheKey, () => transcribeLong({
              input, ffmpegPath, start: winStart, end: winStart + winDur,
              // apiKey 必须传：否则关掉 ASR 只能靠"没 key"，而本机服务不需要 key
              silences, maxChunk: asrMaxChunk, apiKey: asrKey,
              // 显式传解析后的值：不传的话 transcribe 会再解析一次，键和实参可能不是同一份
              hotwords: asrHotwords, language: asrCfg.language,
            }), { enabled: cache });
          asrSeconds = covered ? 0 : +((Date.now() - asrStart) / 1000).toFixed(1);
          asrCached = asr?.cached === true;
          if (asr && !covered && cache && asr.segments?.length) {
            // 落盘成"绝对时间的一段"，下次任何子窗口都能切出来（不用再跑 ASR）
            await rememberTranscript(input, {
              from: winStart, to: winStart + winDur, segments: asr.segments, backend: asrBackend,
            }).catch(() => {});
          }
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
    } else if (transcript === 'off') {
      // **主动关掉**也要有自己的标签。旧版这里什么都不留，清单于是和"没字幕轨、ASR 没跑成"
      // 长得一模一样，模型只能猜"这片子是不是没人说话"。
      transcriptInfo = { segments: [], source: 'off' };
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
  // 键里要带 scanGap：判定用到了它（近邻合并），否则换参数会命中旧配置的切点
  const key = cache ? await cacheKey({
    input, start: winStart, end: winStart + winDur, threshold, minGap: scanGap,
  }) : null;
  // precomputed：批量模式下全片已经扫过一次，窗口直接复用那份切点与摘要，
  // 不再为每个窗口重新解码一遍（2 小时的片子能省掉 24 次重复扫描）。
  // **逐帧的 means 不进缓存**（级联缓存走 JSON.stringify，塞不下也别扭），
  // 所以 `tagCuts` 只有"这一趟真的扫了"才会打标签。
  // prints 则**会**进缓存，但存的是 `printPack`（8 fps 抽稀 + base64，见 scan.packPrints）——
  // 于是缓存命中时 `frameDiv` 判据照跑，只是采样率与冷跑不同（交接文档 §9.1 有实测差异）。
  let scanMeans = null;
  let scanPrints = null;
  // 指纹序列的**实际帧率**：真扫时是 info.fps，从缓存读回的是抽稀后的（info.fps / step）。
  // 这根数直接决定"时刻 → 下标"的换算，算错整条时间轴就偏了。
  let printFps = 0;
  const scan = precomputed
    ? {
      cuts: (precomputed.cuts ?? []).filter((c) => c.t >= winStart && c.t < winStart + winDur),
      summary: precomputed.summary ?? { frames: 0, p90: 0, p99: 0 },
      threshold: precomputed.threshold ?? threshold,
      cached: false,
      reused: true,
      // batch 模式下 precomputed 是 scanShots 的完整返回，指纹就在里面（整片坐标，offset=0）
      ...(Array.isArray(precomputed.prints) ? { printsRaw: precomputed.prints } : {}),
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
      // **抽稀版要存**（8fps + base64，see scan.packPrints）：`frameDiv` 判据全靠它。
      // 但它只解决了"有没有"，没解决"一样不一样"：逐帧 vs 8fps 会给出不同的 frameDiv，
      // 所以冷跑和缓存命中仍可能摊出不同的 k（交接文档 §9.1，实测 PV 28 帧 vs 23 帧）。
      scanMeans = s.means;
      scanPrints = s.prints;
      return {
        cuts: s.cuts, stats: s.stats, frames: s.frames,
        threshold: s.threshold, degraded: s.degraded, summary: s.summary,
        darkRuns: detectDarkRuns(s.means, { fps: info.fps }),
        printPack: s.prints?.length ? packPrints(s.prints, info.fps) : null,
      };
    }, { enabled: cache });
  // 三个来源收口成一份：真扫（内存里已有）> 缓存读回（解包）> precomputed（batch，整片坐标）
  if (scanPrints?.length) {
    printFps = info.fps;
  } else if (scan.printPack) {
    scanPrints = unpackPrints(scan.printPack);
    printFps = packedFps(scan.printPack, info.fps);
  } else if (scan.printsRaw) {
    scanPrints = scan.printsRaw;
    printFps = info.fps;
  }
  // **统一采样率：三条来路必须落到同一份指纹上。**
  // 真扫 / precomputed 拿到的是**逐帧**（fps = info.fps），缓存读回的是 `packPrints` 的 **8 fps**。
  // `frameDiversityOf` 用 `round((t-offset)*fps)` 寻址，两者算出的下标最多差 1.5 帧 ——
  // 快剪段里差一帧，`frameDiv` 就能从 76 掉到 52（跨过 `FRAME_DIV_MID=70`）→ k 从 3 变 2。
  // 实测（记管MAD02 / 概念 PV）：冷跑 126 帧 `{1:3,2:15,3:7}`、缓存命中 121 帧 `{1:3,2:16,3:6}`；
  // PV 28 帧 vs 23 帧。**同一部片、同一组参数，第一次跑和第二次跑出图不同。**
  //
  // 修法：真扫这边**当场按缓存的口径抽稀一遍再解回来**，两条路从此逐字节一致。
  // 为什么以 8 fps 为准（而不是把缓存提到逐帧）：PRINT_FPS=8 是为了缓存体积（见 scan.packPrints），
  // 而 0.125 s 一帧在最短格（0.5 s）里也还分得开 4 张 —— 精度够，体积不炸。
  if (scanPrints?.length) {
    const packed = packPrints(scanPrints, printFps || info.fps);
    const unpacked = packed ? unpackPrints(packed) : null;
    if (unpacked?.length) {
      scanPrints = unpacked;
      printFps = packedFps(packed, printFps || info.fps);
    }
  }
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
    // 把粗扫的阈值也传下去：细扫的刀不能比它低太多（否则 2–4 分的抖动会混进来）
    const r = refineCutsByWindow({
      stats: scan.stats, coarseCuts: cuts, fps: info.fps, winStart, winDur,
      coarseThreshold: scan.threshold ?? 0,
    });
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
  // 显式给了格数就不问 suggest()（它的建议只在自动档用）。
  const explicitCells = Math.max(0, Number(opts.cells) || 0);
  const explicitSheets = Math.max(0, Number(opts.sheets) || 0);
  // 和 suggest() 用同一个口径；下面写进 plan.inputs，方便复现判定。
  const speechRate = winDur > 0 ? transcriptChars / winDur : 0;
  // 「有没有台词」是**有没有拿到转写结果**，不是"转出来几个字"：
  // 跑了 ASR 但一个字没转出来，那是"这片子确实没台词"，结论有效；
  // 没跑 ASR（--transcript off）才是"不知道"，才需要去听音频。
  // transcript:'off' 是一个明确结果（"没听"），不是"没有台词" —— 不能拿它当"这片子没人说话"的证据。
  const hasSpeech = transcriptInfo != null && transcriptInfo.source !== 'off';
  // 没有台词数据时才去听节奏（多一次音频解码，只在需要时付这个成本）。
  const rhythm = !hasSpeech && info.hasAudio && !textOnly
    ? await analyzeRhythm({ input, ffmpegPath, start: winStart, end: winStart + winDur })
    : null;
  // 判定结果连**依据**一起带出来：清单要写清"因为什么这么判"，模型才可能推翻它。
  const verdict = musicDrivenVerdict({
    meanLufs: audio?.mean, speechRate, hasSpeech, rhythm, thresholds: planThresholds ?? {},
  });
  let suggestion;
  if (explicitCells === 0) {
    suggestion = suggest({
      duration: winDur,
      cuts: cuts.length,
      motion: scan.summary.p90,
      aspect: info.aspect,
      speechRate,
      hasSubtitle: info.hasSubtitle,
      hasSpeech,
      rhythm,
      tileFirst,
      maxPerSheet,
      budget,
      need,
      meanLufs: audio?.mean,
      ...(planThresholds ? { thresholds: planThresholds } : {}),
    });
  }
  // 音乐驱动**只影响取帧**，不影响格数（格数走 rodt）。音乐片的信息全在画面上，
  // 所以把"摊开"的触发门槛压低：同样的段更容易摊、摊得更细。
  // 用 verdict 而不是只读 suggestion —— 显式指定 cells 时 suggestion 是空的，
  // 但"音乐片取帧更密"跟格数从哪来无关。
  const musicDriven = suggestion?.musicDriven === true || verdict.musicDriven;
  // 排布过程的"为什么变成这样"：由 layout.planLayout() 逐条追加（补满、裁暗场、并尾、重切）。
  const trace = [];

  // 两条路：自适应按密度分配格位（快切区多给格），否则退回"并段到 k 格"
  mark('transcript');
  const relCuts = cuts.map((c) => c.t - winStart);
  // **积分采样点（假切点）**：扫描之后立刻算好，交给下面"格内取几帧 / 取在哪"用。
  // 它不进 `cuts` —— 清单里"切点 N 个"必须还是真切点，否则模型会以为那些地方有硬切。
  // 阈值就是 equivSeconds（每条采样点代表多少秒的平均变化量）。
  //
  // **音乐驱动原本设 4（比默认 6 更密），2026-10-30 反过来了**：实测正式 PV 第 2 格
  // 只有 3.0 秒却塞了 7 个真切点 + 2 个采样点 → k=3 → 9 帧，平均 **0.3 秒一张**。
  // 3 秒里 8 个镜头本来就长得像，多采出来的点全变成"相似帧"，把预算从别处抢走。
  // 采样点只在**真切点之间**补洞，不该在已经切得很碎的地方再加密度。
  const sampleMarks = scan.stats?.length
    ? integralMarks({
      duration: winDur,
      series: scan.stats,
      cuts: cuts.map((c) => c.t),
      start: winStart,
      equivSeconds: musicDriven ? 8 : 6,
    })
    : [];
  // 让 video_locate 能直接复用这次的转写，省掉一次 ASR
  if (transcriptInfo?.segments?.length) rememberSegments(input, transcriptInfo.segments);
  // 黑场段（≥2s）在预算里**额外占格**，所以要先数清楚：算"内容格数"时必须把它扣掉，
  // 否则 12 内容 + 1 黑场 = 13 格 → 排成 4×4 会空 3 个黑位（实测「中国剑」就是这样）。
  const darkRuns = (Array.isArray(scan.darkRuns) ? scan.darkRuns : [])
    .filter((r) => r.to - r.from >= 2 && r.from < winDur);

  // ---- 排布：几张图、每张几格、时间轴怎么切。
  // 整段决策（黑场占格 / 补满布局 / 按帧切张 / 再补满）已经搬到 layout.js —— 那是纯算术，
  // 可以单独单测；这里只负责把"已经算好的输入"交过去，再把结果接回来。
  const layout = planLayout({
    winStart, winDur, relCuts,
    p90: Number(scan.summary?.p90) || 0,
    darkRuns,
    stats: scan.stats ?? [],
    adaptive, minGap,
    cellsIn: opts.cells, sheetsIn: opts.sheets, maxPerSheet,
    suggestion,
    aspect: info.aspect, budget, need,
    audioStrip: Boolean(stripAudio), musicDriven,
    cuts, sampleMarks,
    // **逐帧指纹的上下文**：`scanPrints` 有三个来源（见上面 438-446 行）——
    // 真扫（逐帧）、缓存命中（`printPack` 解出来的 **8 fps 抽稀版**）、precomputed（整片坐标）。
    // 三者的 fps 不同，所以必须带 `printFps`，不能一律用 `info.fps`：
    // offset 是窗口起点（prints[0] 对应 winStart）；拿原 fps 去寻址抽稀序列会越界，
    // frameDiv 整片变 null，而现象只是"判据悄悄失效"。
    printCtx: { prints: scanPrints, fps: printFps || info.fps, printOffset: winStart },
    noTile, trace,
  });
  const { cellRanges, groups, noTiling } = layout;

  // 指纹完全拿不到时（precomputed 没带 prints / 旧缓存没有 printPack），`frameDiv` 那几条判据
  // 会自动退回 meanMotion。**必须写出来**：否则摊开方式的差异在清单上完全看不出来。
  // 注意：**缓存命中时不算"拿不到"** —— 它会给出 8 fps 的抽稀指纹，判据照跑，
  // 但数值与冷跑（逐帧）不同，同一部片两次跑可能给出不同的 k（见交接文档 §9.1）。
  // 放在 planLayout 之后 push：trace 的顺序就是"补满 → 裁暗场 → 并尾 → 重切"的真实顺序。
  if (!scanPrints) trace.push('no-prints:frameDiv-off');

  // 本次实际输入 + 生效阈值。只记录，不做成十几个可配置旋钮。
  // 格数/张数用的是**最终生效值**：清单和 manifest 读的是它们 —— 不刷就会报 12 格 1 张、
  // 而实际出了 25 格 2 张（2026-10-30 对比测试踩到，报告里对不上账）。
  // 多张时取"最多那张的格数"（真正的每张格数在 sheets[].cells 里，这里只给个量级）。
  const planInfo = {
    cells: groups.length > 1 ? Math.max(...groups.map((g) => g.length)) : cellRanges.length,
    sheets: groups.length,
    adaptive, pick, burn, minGap,
    // 几何：清单据此报"每格多大、能看清到什么程度、这一张多少钱"。
    // `maxPerSheet` 报**实际生效的上限**（调用方没指定时是按 budget+need 推出来的那个），
    // 否则清单里会写一个没被用上的数。
    budget, need, maxPerSheet: layout.perSheetCap,
    ...(noTiling ? { noTiling: true } : {}),
    ...(tileFirst ? { tileFirst: true } : {}),
    ...(layout.filledFrom ? { filledFrom: layout.filledFrom } : {}),
    reason: suggestion?.reason ?? 'explicit',
    auto: layout.autoPlan,
    // **判定的依据也交出去**。只给一个 musicDriven:true/false，模型没法判断该不该信；
    // 给到"因为包络主导 4 Hz"或"因为 0.12 字/秒"，它就能自己复核。
    musicDriven,
    musicBasis: verdict.basis,
    musicDetail: verdict.detail,
    inputs: {
      duration: +winDur.toFixed(2),
      scanThreshold: scan.threshold,
      meanLufs: Number.isFinite(audio?.mean) ? +audio.mean.toFixed(1) : null,
      speechRate: +speechRate.toFixed(2),
      hasSpeech,
      rhythm: rhythm && Number.isFinite(rhythm.peakHz)
        ? { peakHz: rhythm.peakHz, rhythmRatio: rhythm.rhythmRatio, windows: rhythm.windows }
        : null,
      motion: +(Number(scan.summary?.p90) || 0).toFixed(1),
      cuts: cuts.length,
      hasSubtitle: Boolean(info.hasSubtitle),
    },
    thresholds: { ...PLAN_THRESHOLDS, ...(planThresholds ?? {}) },
    sampleMarks: sampleMarks.length,
    requested: layout.requested,
    trace,
    // **planner 认为会出多少帧**。渲染时必须与这个数一致（同一个 measureGroup 得出的），
    // 所以它是一个可验收的量：清单里 Σ(cell.sub²) 应该正好等于它。
    frames: layout.frames,
  };

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
    // **同一份测量**：布局、每格的 k、总帧数都是 planLayout 里量过的那一份，直接取。
    // 以前这里是"算 frames 时量一遍、渲染前再量一遍"，参数一模一样 —— 纯白算；
    // 而一旦两处参数漂移（漏传 printCtx / need），切张的 k 就和渲染的 k 不同。
    const measured = layout.measurements[si];
    // cellBudget 也要用 measure 那个：composeSheet 与 layoutCanvas 必须是同一个预算，
    // 差 10% 会让取帧尺寸和拼图尺寸不一致（图会变成斜条纹）。
    const { cols, rows, width, height, cellW, cellH, cellBudget } = measured;
    const aligned = alignCells(group, transcriptInfo?.segments ?? []);
    const frames = [];
    const cellMeta = [];
    // ---- 取帧：先算完所有格子的参数，再并发取帧，最后按顺序组装。
    // 原来是一格一格 await（9 格串行，短视频里占 60% 的时间）。ffmpeg 每次只解一帧，
    // 彼此没有依赖，并发 3 路就能把这部分压掉一半以上。
    const plan = measured.cells.map((c, gi) => ({
      gi, a: c.from, b: c.to, cellCuts: c.cellCuts,
      cutTimes: c.cutTimes, sub: c.k, want: c.want, rate: c.rate,
    }));

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
        // 格内平均画面变化（0–255 的分数）：诊断"为什么这格摊 3×3 而那格只摊 2×2"
        ...(Number.isFinite(measured.cells[gi]?.meanMotion)
          ? { meanMotion: measured.cells[gi].meanMotion } : {}),
        // **摊开的 4 张到底差多少**（16×9 指纹两两平均差）。这是"该不该摊"的直接证据，
        // 比 meanMotion 可信（后者测的是段内运动，方向常相反）。不报的话，
        // 模型看到一格只给整帧会以为是漏采，实际上是因为那 4 张本来就一样。
        ...(Number.isFinite(measured.cells[gi]?.frameDiv)
          ? { frameDiv: measured.cells[gi].frameDiv } : {}),
        ...(frame.sharp !== undefined ? { sharp: +frame.sharp.toFixed(1) } : {}),
        ...(text?.text ? { text: text.text, charsPerSec: text.charsPerSec } : {}),
      });
    }
    let sheet = composeSheet({
      frames, cols, rows, cellAspect: info.aspect, budget: cellBudget, burn, badgeRatio,
    });
    // 抬头：这张覆盖哪一段、一共几张。多张图时模型很容易把它们串成一条时间轴，
    // 而格子里只有全局递增的序号（第 12 格像"一张长图的第 12 格"）。烧在图上最省 token。
    const sheetFrom = group[0]?.from ?? winStart;
    const sheetTo = group.at(-1)?.to ?? winStart + winDur;
    sheet = addSheetHeader(sheet, {
      text: `${clock(sheetFrom)}-${clock(sheetTo)} ${si + 1}/${groups.length}`,
    });
    // 条带只在**有东西可画**时才画：整段静音 / 响度测不出来时，它就是一块空白，
    // 白占一条 71px 的画布（圆圈不卷反馈"没台词时那条 strip 是空的"）。
    // 判据用响度本身，而不是"有没有台词"—— 没配 ASR 但有对白的片子，波形仍然有用。
    const stripHasSignal = hasAudibleSamples(stripAudio);
    if (stripHasSignal) {
      // 条带高度按"宽的 5.5%"会在大长条上失控（2476px 宽 → 136px 高，占掉 37% 画面），
      // 所以同时受格高的 40% 约束。
      const stripH = Math.max(24, Math.min(Math.round(width * 0.055), Math.round(cellH * 0.28)));
      sheet = addAudioStrip(sheet, {
        loudness: stripAudio, silences: stripAudio.silences, cuts: cuts.map((c) => c.t),
        window: { from: winStart, to: winStart + winDur }, stripH,
      });
    } else if (stripAudio) {
      // 说清楚"为什么没有条带"，免得被当成渲染失败
      trace.push('strip:skipped (no audible samples)');
    }
    out.push({
      sheet: si + 1, cols, rows, cellW, cellH,
      width: sheet.width, height: sheet.height, buffer: sheet.buffer, cells: cellMeta,
      ...(sheet.headerH ? { headerH: sheet.headerH } : {}),
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
        ...(asrSeconds !== null ? { asrSeconds, asrCached: asrCached === true } : {}),
        ...(transcriptInfo.error ? { error: transcriptInfo.error } : {}) }
      : null,
    plan: {
      ...planInfo,
      // **每格实际多大、能看清到什么程度**：清单的头等大事。
      // 旧清单只报 image= 和 cell=，模型得自己做除法才知道 286×118 已经读不了字。
      ...(out[0] ? {
        cell: {
          w: out[0].cellW, h: out[0].cellH,
          readability: readabilityOf(out[0].cellW, out[0].cellH),
        },
        // **摊开之后的真实尺寸**。`cell=` 报的是"一个大格"，模型看到 341×189 就默认能认脸；
        // 可一格摊 2×2 时，它真正看到的是 4 张 170×94 —— 那只能分辨"是不是同一个镜头"。
        // 不报这个数，模型会按 cell 的高估去描述画面，说出来的东西就是编的。
        //
        // **必须跨所有张取最坏**，不能只看 out[0]：多张时第一张常是最"密"的那张，
        // 而第二/第三张格子更大、更容易摊到 3×3 / 4×4。实测 1.2M + maxPerSheet 12：
        // 第 1 张全是 2×2（197×110），第 2 张有 4 格 3×3（131×73）—— 只报第一张的话，
        // 清单会写"197×110 能分辨镜头"，而模型手上那 4 格其实是 131×73 的色块。
        ...(() => {
          let worst = null;
          for (const s of out) {
            for (const c of s.cells ?? []) {
              const k = c.sub ?? 1;
              if (k <= 1) continue;
              const w = Math.floor(s.cellW / k);
              const h = Math.floor(s.cellH / k);
              if (!worst || w * h < worst.w * worst.h) worst = { k, w, h };
            }
          }
          if (!worst) return {};
          return {
            sub: { k: worst.k, w: worst.w, h: worst.h, readability: readabilityOf(worst.w, worst.h) },
          };
        })(),
      } : {}),
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
    // SEQUENCE 的进度：只传 from 时，调用方不用自己记"下一段从哪开始"。
    // index/total 用固定 segment 推，最后一段可能短于 segment。
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
  // **t_start 本来就是绝对时间**：`planRanges()` 的两条路都把 winStart 加过了
  // （密度分支 `r.from + winStart`、切点分支 `segmentsFromCuts(..., winStart)`），
  // 这里再加一次就是 issue #37 —— 第 5 格会变成 102.71s 而不是 52.71s，zoom 直接跳错位置。
  // 不 await：写失败不该影响出图，寻址会退回 from/to。
  if (!textOnly) {
    const cellTimes = [];
    for (const sheet of out) {
      for (const c of sheet.cells) {
        cellTimes.push({ i: c.i, from: c.t_start, to: c.t_end });
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

