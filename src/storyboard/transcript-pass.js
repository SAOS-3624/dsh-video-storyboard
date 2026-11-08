/**
 * transcript-pass.js — "这一段的字从哪来"，从 pipeline 里抽出来的**一次独立调用**。
 *
 * 为什么单独成文件：它有两个完全不同的调用方。
 *
 *   1. `runStoryboard`（pipeline.js）：照旧，转写和扫描并行，最后一起用；
 *   2. 陪看的**字幕轨**（dsh-watch-together）：只要字，不要图。
 *      字幕的生产速度是画面的 10 倍以上（实测 ASR RTF 0.019），所以它可以先跑，
 *      跑到"未来五分钟"就停 —— 用户下一次提问时，模型手上已经有一整段台词了。
 *
 * 抽出来的只有"决定用哪一路"，取哪几个字的判断一条都没改（四条优先级：
 * 显式 transcriptFile > 站点 CC 字幕 > 内嵌字幕轨 > 本地 ASR）。
 *
 * ## 为什么 `prefetchTranscript` 要自己 resolve 一遍输入
 *
 * 陪看手里可能是一个页面 URL。转写要读音频，所以必须先把媒体落到本地 —— 走的是
 * 同一个 `resolveInput`（下载缓存按 mediaKey 复用）。第一次由画面轨下载、字幕轨直接命中，
 * 不会重复下载：陪看的第一段一定在起钟之前就建好了。
 */

import {
  applyTermMap, asrBackendId, canTranscribe, describeAsrTarget, explainFetchError,
  extractSubtitleTrack, filterSuspectSegments, resolveAsrConfig, transcribeLong,
} from './asr.js';
import { ensureAsr } from './asr-lifecycle.js';
import { cacheKey, withCache } from './cache.js';
import { resolveInput } from './fetch.js';
import { countTextInSilence } from './format.js';
import { probeVideo, DEFAULT_FFPROBE } from './probe.js';
import { fetchRemoteSubtitles } from './subtitles.js';
import { loadTranscriptFile } from './transcript-file.js';
import { cachedTranscript, rememberTranscript } from './transcript-cache.js';

/** 预取时多要 10 秒：段边界常落在句子中间，宽一点让"完整覆盖"判据吸收掉 */
const PREFETCH_TAIL_SEC = 10;

const cutRange = (segments, from, to) => (Array.isArray(segments) ? segments : [])
  .filter((s) => Number(s.to) > from && Number(s.from) < to);

/**
 * 站点字幕没拿到、又不会跑 ASR 时，`source` 该写什么（纯函数，好测）。
 *
 * `no-key` 的含义是"**没尝试**"（没配 ASR）。而 `no-ytdlp` / `failed` 是"**尝试了、但抓字幕
 * 这一步坏了**"—— 两者对用户是完全相反的动作：一个去配听音服务，一个去修 yt-dlp。
 * 以前它们长得一模一样，只能靠猜（issue #86）。
 *
 * `no-subs` 不算坏：那确实是"这条片子没有站点字幕"，写 `no-key` 是对的。
 *
 * @param {{remote?:{ok?:boolean,reason?:string,detail?:string}|null, willTranscribe?:boolean}} o
 * @returns {{source:string, reason?:string, detail?:string}|null} `null` = 交给 ASR，别下结论
 */
export function subtitleMissSource({ remote = null, willTranscribe = false } = {}) {
  if (willTranscribe) return null;
  if (remote && !remote.ok && (remote.reason === 'no-ytdlp' || remote.reason === 'failed')) {
    return {
      source: 'subtitle-failed',
      reason: String(remote.reason),
      ...(remote.detail ? { detail: String(remote.detail).slice(0, 300) } : {}),
    };
  }
  return { source: 'no-key' };
}

/**
 * 这一窗口的字从哪来（**决定，不扫图、不取帧**）。
 *
 * @returns {Promise<{transcriptInfo:object|null, textInSilence:number,
 *   asrSeconds:number|null, asrCached:boolean|null, asrLife:object|null}>}
 */
export async function resolveTranscript({
  input, info, sourceInfo = null, fetchOptions = null,
  transcript = 'auto', transcriptFile = null,
  winStart = 0, winDur = 0, silences = [],
  ffmpegPath, hotwords, asrKey, asrMaxChunk = 45, cache = true, hostAsr = null,
}) {
  // 这次调用到底会不会真的转写：宿主 speechToText / 本机 HTTP 服务 / 云端 key 都算。
  // 判据必须和实际要走的门同源（见 asr.js 的 canTranscribe），否则清单会和实际行为相反。
  const willTranscribe = () => Boolean(hostAsr) || canTranscribe(resolveAsrConfig(), asrKey);
  let transcriptInfo = null;
  // 站点有字幕轨但要登录 —— 清单要说明"现在用的是 ASR，不是这视频没字幕"
  let subtitleNeedsLogin = false;
  let asrSeconds = null;
  let asrCached = null;
  let asrLife = null;

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
    /**
     * **抓字幕这一步自己坏了**（跟"这视频没字幕"是两件事）。
     *
     * `fetchOnce` 的四种 reason 里，只有 `needs-login` 以前会被单独提示；
     * `no-ytdlp` / `failed` 全都一路掉到 `no-key`，而 `no-key` 的含义是
     * "没配 ASR、压根没尝试转写" —— 用户看到它就去配 ASR，方向完全错（issue #86）。
     * 判定收在 `subtitleMissSource()` 里（纯函数，单测直接咬）。
     */
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
      transcriptInfo = { segments: [], ...subtitleMissSource({ remote, willTranscribe: false }) };
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
        // 宿主本地 provider 与云端 HTTP 必须使用不同缓存身份，否则会串用彼此的句子。
        const asrBackend = hostAsr
          ? `asr2|host:speechToText|${asrCfg.language}|${asrMaxChunk}`
          : asrBackendId({
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
        if (!covered && !hostAsr) {
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
          : await withCache(asrCacheKey, () => (hostAsr
            ? hostAsr({
              input, ffmpegPath, start: winStart, end: winStart + winDur,
              silences, maxChunk: asrMaxChunk, language: asrCfg.language,
            })
            : transcribeLong({
              input, ffmpegPath, start: winStart, end: winStart + winDur,
              // apiKey 必须传：否则关掉 ASR 只能靠"没 key"，而本机服务不需要 key
              silences, maxChunk: asrMaxChunk, apiKey: asrKey,
              // 显式传解析后的值：不传的话 transcribe 会再解析一次，键和实参可能不是同一份
              hotwords: asrHotwords, language: asrCfg.language,
            })), { enabled: cache });
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
          error: `${explainFetchError(error).slice(0, 300)}  [${hostAsr ? 'host speechToText' : describeAsrTarget()}]`,
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
    asrSeconds,
    asrCached,
    asrLife,
  };
}

/**
 * **只转写、不扫图**：陪看的字幕轨用。
 *
 * 和 `resolveTranscript` 的区别只有两点：
 *   · 自己做一次 `resolveInput`（页面 URL 要先落成本地媒体），并 probe 一次拿 hasAudio；
 *   · 窗口往后多要 10 秒（`PREFETCH_TAIL_SEC`），段边界落在句子中间时也能被"完整覆盖"判据吸收。
 *
 * **不写 media/transcript 之外的东西**：不建图、不碰 cells、不占内存里的帧。
 *
 * @returns {Promise<{ok:boolean, source:string, segments:Array, seconds:number,
 *   reason?:string, cached?:boolean}>}
 */
export async function prefetchTranscript({
  input, from, to,
  ffmpegPath, ffprobePath = DEFAULT_FFPROBE,
  hotwords, asrKey, asrMaxChunk = 45, timeoutMs = 30_000,
  fetchOptions = null, cookies = null, siteSubtitles = true, cache = true,
}) {
  const start = Math.max(0, Number(from) || 0);
  const end = Math.max(start + 0.5, Number(to) || 0);
  const t0 = Date.now();
  const done = (r) => ({ ...r, seconds: +((Date.now() - t0) / 1000).toFixed(1) });

  // 1) 站点字幕：有就是秒回，还比 ASR 准
  if (siteSubtitles && /^https?:/i.test(String(input ?? ''))) {
    const remote = await fetchRemoteSubtitles({ url: input, cookies }).catch(() => null);
    if (remote?.ok && remote.segments?.length) {
      const segs = cutRange(remote.segments, start, end);
      if (segs.length > 0) {
        return done({ ok: true, source: 'subtitle', segments: segs, cached: false });
      }
    }
  }

  // 2) 本地媒体（页面 URL 会在这里下载/复用，和画面轨同一个 mediaKey）
  // cookies 是 prefetch 的独立参数（站点 CC 已经用了）；下载也要用它，否则登录片在
  // 这一步退成匿名请求，可能直接失败或拿到低清源。
  const fetchOpts = { ...(fetchOptions ?? {}) };
  if (cookies) fetchOpts.cookies = cookies;
  const { path: media } = await resolveInput(input, fetchOpts);
  const info = await probeVideo(media, { ffprobePath });
  if (!info.hasAudio) return done({ ok: false, source: 'no-audio', segments: [], reason: 'no-audio' });

  // 3) 内嵌字幕：和 resolveTranscript 同一级（站点 CC → 内嵌字幕 → 缓存 → ASR）。
  // 以前这里直接跳去 canTranscribe()，本地带字幕的片子因此在没有 ASR key 时被误报 no-key。
  if (info.hasSubtitle) {
    const subtitle = await extractSubtitleTrack({ input: media, ffmpegPath }).catch(() => null);
    if (subtitle) {
      const segs = cutRange(subtitle, start, end);
      return done({
        ok: segs.length > 0,
        source: 'subtitle',
        segments: segs,
        cached: false,
        ...(segs.length > 0 ? {} : { reason: 'subtitle-empty' }),
      });
    }
  }

  const asrCfg = resolveAsrConfig();
  if (!canTranscribe(asrCfg, asrKey)) {
    return done({ ok: false, source: 'no-key', segments: [], reason: 'no-key' });
  }
  const backend = asrBackendId({
    baseUrl: asrCfg.baseUrl, model: asrCfg.model, language: asrCfg.language,
    maxChunk: asrMaxChunk, transcript: 'auto',
    hotwords: hotwords !== undefined ? hotwords : asrCfg.hotwords,
  });
  // 窗口往后多要 10 秒，存的是**宽的那一段**；之后任何子窗口都能被它覆盖
  const asrTo = end + PREFETCH_TAIL_SEC;

  const covered = cache
    ? await cachedTranscript(media, { from: start, to: asrTo, backend }).catch(() => null)
    : null;
  let raw = covered?.segments ?? null;
  let cached = Boolean(covered);
  if (!raw) {
    await ensureAsr({ baseUrl: asrCfg.baseUrl, config: asrCfg }).catch(() => null);
    const key = cache ? await cacheKey({ input: media, start, end: asrTo, threshold: backend }) : null;
    // **异常必须在这里收住**：调用方（陪看的字幕轨）靠 `ok:false + reason` 决定要不要重试、
    // 要不要把这一段拉黑。让它往上抛的话，循环只能 `.catch(()=>null)`，失败原因就没了，
    // 于是一个挂掉的 ASR 服务会被每一拍重新撞一次（"连续失败 3 次拉黑"永远数不到 3）。
    let asr = null;
    let failure = null;
    try {
      // **总时限**：`transcribe` 里的 AbortSignal 只管单次请求，而"端口能连上、就是不回话"
      // 会让 fetch 在 socket 上卡很久（实测 bad port 60 s）。字幕轨的全部价值就是"比画面先到"，
      // 卡 60 秒等于这一轨失效 —— 而且这 60 秒是**每一拍**都要付的。
      // 超时按"这次没转成"处理：不拉黑、不算错，下一拍还能再试。
      asr = await withCache(key, () => Promise.race([
        transcribeLong({
          input: media, ffmpegPath, start, end: asrTo,
          silences: [], maxChunk: asrMaxChunk, apiKey: asrKey,
          hotwords: hotwords !== undefined ? hotwords : asrCfg.hotwords,
          language: asrCfg.language,
          timeoutMs,
        }),
        new Promise((_, reject) => {
          const t = setTimeout(() => reject(new Error(`timeout after ${timeoutMs} ms`)), timeoutMs);
          t.unref?.();
        }),
      ]), { enabled: cache });
    } catch (error) {
      failure = explainFetchError(error).slice(0, 200);
    }
    if (failure) {
      return done({ ok: false, source: 'asr-failed', segments: [], reason: failure });
    }
    raw = asr?.segments ?? [];
    cached = asr?.cached === true;
    if (cache && raw.length > 0) {
      await rememberTranscript(media, { from: start, to: asrTo, segments: raw, backend }).catch(() => {});
    }
  }
  // 和 pipeline 同一套后处理：幻觉句过滤 + 用户词典。缓存里存的是**原始**句子，
  // 所以两条路径读出来之后各过滤一次，结果一致。
  const { kept } = filterSuspectSegments(raw);
  const { segments: fixed } = applyTermMap(kept, asrCfg.terms);
  const segments = cutRange(fixed, start, end);
  return done({
    ok: segments.length > 0,
    source: segments.length > 0 ? (cached ? 'cache' : 'asr') : 'asr-empty',
    segments,
    cached,
    ...(segments.length > 0 ? {} : { reason: 'asr-empty' }),
  });
}
