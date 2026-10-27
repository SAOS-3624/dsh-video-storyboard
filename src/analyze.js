/**
 * analyze.js — 视频分析资产（VAA）的生产层。
 *
 * 只负责：探测 / 切点 / 音频 / 台词。不做格位规划，不出图。
 * 这样 storyboard 与 zoom、textOnly 翻页都能复用同一份分析结果，而不是各跑一遍解码。
 *
 * 对外形态见 `VideoAnalysisAsset`（JSDoc）。缓存按 artifact 分层：shots / audio / transcript。
 */

import { probeVideo, DEFAULT_FFMPEG, DEFAULT_FFPROBE } from './probe.js';
import { scanShotsMaybeSampled } from './scan-sampled.js';
import { analyzeAudio, describeAudio, detectOnsets } from './audio.js';
import {
  ASR_DEFAULTS, applyTermMap, describeAsrTarget, explainFetchError, extractSubtitleTrack,
  filterSuspectSegments, resolveAsrConfig, speechCurve, transcribeLong,
} from './asr.js';
import { artifactKey, pruneCache, withCache } from './cache.js';
import { sampleFingerprints } from './fingerprints.js';
import {
  enrichmentEnabled, maybeEnrichShots, maybeEnrichSpeech, resolveEnrichmentConfig,
} from './enrichment/index.js';

export const VAA_SCHEMA_VERSION = 1;
export const SHOT_ALGO_VERSION = 'shot-scan-v3';
export const AUDIO_ALGO_VERSION = 'audio-ebur128-v1';
export const TRANSCRIPT_ALGO_VERSION = 'transcript-v2';

/**
 * @typedef {object} VideoAnalysisAsset
 * @property {number} schema_version
 * @property {object} info                 probe 结果（含 path）
 * @property {{from:number,to:number,duration:number}} window
 * @property {{cuts:Array,summary:object,threshold:*,cached?:boolean,reused?:boolean}} shots
 * @property {object|null} audio           含 silences / events(绝对) / eventsRel(相对窗口)
 * @property {object|null} transcript      完整 segments；失败时仍带 source/error
 * @property {object|null} speech          speechCurve（相对窗口），供密度规划
 * @property {Array<{t:number,hash:string}>} [fingerprints]
 * @property {string[]} cache_hits
 * @property {string[]} cache_misses
 * @property {{probe_ms:number,shot_scan_ms:number,audio_ms:number,asr_ms:number,fingerprint_ms?:number}} timing
 */

/**
 * 解析窗口到合法区间。
 * @returns {{winStart:number,winEnd:number,winDur:number}}
 */
export function resolveWindow(info, from = 0, to) {
  const winStart = Math.max(0, Math.min(Number(from) || 0, Math.max(0, info.duration - 0.2)));
  const winEnd = Math.min(info.duration, Number(to) > 0 ? Number(to) : info.duration);
  return { winStart, winEnd, winDur: Math.max(0.2, winEnd - winStart) };
}

/**
 * 生产一份可复用的 Video Analysis Asset。
 *
 * @param {object} opts
 * @param {string} opts.input
 * @param {number} [opts.from]
 * @param {number} [opts.to]
 * @param {number|'auto'} [opts.threshold]
 * @param {'auto'|'off'} [opts.transcript]
 * @param {boolean} [opts.wantAudio]  需要响度条/静音时为 true；台词切片也依赖静音
 * @param {boolean} [opts.cache]
 * @param {object|null} [opts.precomputed]  批量模式注入的全片扫描
 * @param {object|null} [opts.probe]       已有 probe 结果（跳过重复探测）
 * @param {number} [opts.asrMaxChunk]
 * @param {'auto'|'off'} [opts.enrichment]  远程 TransNet/说话人/情绪；默认 auto（有 ~/.dsh/video.json 才启用）
 */
export async function analyzeVideo(opts) {
  const {
    input,
    from = 0,
    to,
    threshold = 'auto',
    transcript = 'auto',
    wantAudio = true,
    cache = true,
    precomputed = null,
    probe = null,
    asrMaxChunk = 45,
    fingerprints: wantFingerprints = true,
    sampleAbove,
    enrichment: enrichmentMode = 'auto',
    ffmpegPath = DEFAULT_FFMPEG,
    ffprobePath = DEFAULT_FFPROBE,
    onProgress,
  } = opts;
  if (!input) throw new Error('input is required');

  const timing = { probe_ms: 0, shot_scan_ms: 0, audio_ms: 0, asr_ms: 0, fingerprint_ms: 0 };
  const cache_hits = [];
  const cache_misses = [];

  const t0 = Date.now();
  const info = probe
    ? { ...probe, path: probe.path ?? input }
    : { ...(await probeVideo(input, { ffprobePath })), path: input };
  timing.probe_ms = Date.now() - t0;

  const { winStart, winEnd, winDur } = resolveWindow(info, from, to);
  const window = { from: winStart, to: winStart + winDur, duration: winDur };

  // ---- shots
  let shots;
  const tScan = Date.now();
  if (precomputed) {
    shots = {
      cuts: (precomputed.cuts ?? []).filter((c) => c.t >= winStart && c.t < winStart + winDur),
      summary: precomputed.summary ?? { frames: 0, p90: 0, p99: 0 },
      threshold: precomputed.threshold ?? threshold,
      cached: false,
      reused: true,
    };
  } else {
    const key = cache
      ? await artifactKey({
        input, kind: 'shots', start: winStart, end: winStart + winDur,
        params: { threshold, algo: SHOT_ALGO_VERSION },
      })
      : null;
    shots = await withCache(key, () => scanShotsMaybeSampled({
      input, fps: info.fps, threshold, start: winStart, end: winStart + winDur,
      ffmpegPath, onProgress, sampleAbove,
    }), { enabled: cache });
    if (shots.cached) cache_hits.push('shots');
    else cache_misses.push(shots.degraded ? 'shots:sampled' : 'shots');
    if (cache && !shots.cached) await pruneCache();
  }
  timing.shot_scan_ms = Date.now() - tScan;

  const enrichCfg = enrichmentMode === 'off' ? null : resolveEnrichmentConfig();
  const wantEnrich = enrichmentMode !== 'off' && enrichCfg && enrichmentEnabled(enrichCfg);
  /** @type {object} */
  let enrichmentReport = {};
  if (wantEnrich && !precomputed) {
    const tEn = Date.now();
    const en = await maybeEnrichShots(shots, {
      input, from: winStart, to: winStart + winDur, fps: info.fps,
      enrichment: enrichCfg, minGap: 0.35,
    });
    shots = en.shots;
    if (en.enrichment) enrichmentReport = { ...enrichmentReport, ...en.enrichment };
    timing.enrichment_shots_ms = Date.now() - tEn;
  }

  // ---- audio（台词切片需要静音；条带需要响度序列）
  const needAudio = Boolean(info.hasAudio && wantAudio);
  let audio = null;
  if (needAudio) {
    const tAudio = Date.now();
    const audioKey = cache
      ? await artifactKey({
        input, kind: 'audio', start: winStart, end: winStart + winDur,
        params: { algo: AUDIO_ALGO_VERSION },
      })
      : null;
    const raw = await withCache(audioKey, () => analyzeAudio({
      input, ffmpegPath, start: winStart, end: winStart + winDur,
    }), { enabled: cache });
    if (raw?.cached) cache_hits.push('audio');
    else if (audioKey) cache_misses.push('audio');
    if (raw) {
      const { cached: _c, ...loudness } = raw;
      const eventsRel = detectOnsets(loudness);
      const events = eventsRel.map((e) => ({ ...e, t: +(e.t + winStart).toFixed(2) }));
      audio = {
        ...loudness,
        events,
        eventsRel,
        summary: describeAudio(loudness, winDur),
      };
    }
    timing.audio_ms = Date.now() - tAudio;
  }

  // ---- transcript
  let transcriptInfo = null;
  if (transcript !== 'off' && info.hasAudio) {
    const tAsr = Date.now();
    const subtitle = info.hasSubtitle
      ? await extractSubtitleTrack({ input, ffmpegPath })
      : null;
    if (subtitle) {
      transcriptInfo = { segments: subtitle, source: 'subtitle', model: 'embedded' };
      cache_hits.push('transcript:subtitle');
    } else {
      try {
        const asrCfg = resolveAsrConfig();
        const asrKey = cache
          ? await artifactKey({
            input, kind: 'transcript', start: winStart, end: winStart + winDur,
            params: {
              algo: TRANSCRIPT_ALGO_VERSION,
              baseUrl: asrCfg.baseUrl ?? ASR_DEFAULTS.baseUrl,
              model: asrCfg.model ?? ASR_DEFAULTS.model,
              chunk: asrMaxChunk,
            },
          })
          : null;
        const asr = await withCache(asrKey, () => transcribeLong({
          input, ffmpegPath, start: winStart, end: winStart + winDur,
          silences: audio?.silences ?? [], maxChunk: asrMaxChunk,
        }), { enabled: cache });
        if (asr?.cached) cache_hits.push('transcript');
        else if (asrKey) cache_misses.push('transcript');
        if (asr) {
          const { cached: _c, ...body } = asr;
          const { kept, dropped } = filterSuspectSegments(body.segments);
          const { segments: fixed, replaced } = applyTermMap(kept, asrCfg.terms);
          transcriptInfo = {
            ...(replaced > 0 ? { termsFixed: replaced } : {}),
            ...body,
            source: 'asr',
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
          error: `${explainFetchError(error).slice(0, 300)}  [${describeAsrTarget()}]`,
        };
      }
    }
    timing.asr_ms = Date.now() - tAsr;
  } else if (transcript !== 'off' && !info.hasAudio) {
    transcriptInfo = { segments: [], source: 'no-audio' };
  }

  if (wantEnrich && info.hasAudio) {
    const tSp = Date.now();
    try {
      const en = await maybeEnrichSpeech({
        input, from: winStart, to: winStart + winDur,
        transcriptInfo, enrichment: enrichCfg, ffmpegPath,
      });
      transcriptInfo = en.transcriptInfo;
      if (en.report) enrichmentReport = { ...enrichmentReport, ...en.report };
      if (en.audioSpans?.spans?.length) {
        audio = {
          ...(audio || {}),
          understand: {
            model: en.audioSpans.model,
            spans: en.audioSpans.spans,
          },
        };
      }
    } catch (error) {
      enrichmentReport.speech = {
        ok: false,
        error: String(error?.message || error).slice(0, 200),
      };
    }
    timing.enrichment_speech_ms = Date.now() - tSp;
  }

  const relSegments = (transcriptInfo?.segments ?? [])
    .map((seg) => ({ ...seg, from: seg.from - winStart, to: seg.to - winStart }))
    .filter((seg) => seg.to > 0 && seg.from < winDur);
  const speech = relSegments.length > 0
    ? speechCurve(relSegments, { duration: winDur })
    : null;

  // ---- 轻量 aHash（规划新颖性）；失败不影响主流程
  let fingerprintList = [];
  if (wantFingerprints) {
    const tFp = Date.now();
    try {
      const cutTs = (shots.cuts ?? []).map((c) => c.t);
      const step = Math.max(2, winDur / 24);
      const uniform = [];
      for (let t = winStart + step / 2; t < winStart + winDur; t += step) uniform.push(t);
      fingerprintList = await sampleFingerprints(input, [...cutTs, ...uniform], {
        ffmpegPath, max: 40, concurrency: 3,
      });
    } catch {
      fingerprintList = [];
    }
    timing.fingerprint_ms = Date.now() - tFp;
  }

  const status = buildAnalysisStatus({
    info, shots, audio, transcript: transcriptInfo, wantAudio, transcriptMode: transcript,
  });
  const shotKind = String(shots?.degraded_kind || shots?.degraded || '');
  if (shotKind.includes('motion')) {
    status.shots = shots.cached ? 'cached-degraded-motion' : 'degraded-motion';
  } else if (shots?.degraded) {
    status.shots = shots.cached ? 'cached-degraded' : 'degraded';
  }

  /** @type {VideoAnalysisAsset} */
  return {
    schema_version: VAA_SCHEMA_VERSION,
    info,
    window,
    shots,
    audio,
    transcript: transcriptInfo,
    speech,
    fingerprints: fingerprintList,
    enrichment: Object.keys(enrichmentReport).length ? enrichmentReport : null,
    status,
    cache_hits,
    cache_misses,
    timing,
  };
}

/** 细分失败/降级状态，避免调用方各自猜测 */
export function buildAnalysisStatus({
  info, shots, audio, transcript, wantAudio = true, transcriptMode = 'auto',
} = {}) {
  return {
    probe: info ? 'ok' : 'missing',
    shots: shots?.reused ? 'reused' : shots?.cached ? 'cached' : shots ? 'ok' : 'missing',
    audio: !info?.hasAudio ? 'no-track'
      : !wantAudio ? 'skipped'
        : !audio ? 'failed'
          : audio.samples === 0 ? 'silence-only' : 'ok',
    transcript: transcriptMode === 'off' ? 'off'
      : !info?.hasAudio ? 'no-audio'
        : !transcript ? 'skipped'
          : transcript.source === 'subtitle' ? 'subtitle'
            : transcript.source === 'asr' ? 'asr'
              : transcript.source === 'asr-failed' ? 'asr-failed'
                : transcript.source === 'no-audio' ? 'no-audio'
                  : String(transcript.source || 'unknown'),
  };
}

/**
 * 从父窗口 VAA 切出子窗口（zoom 复用）。不重新解码。
 * 要求 [from,to] ⊆ parent.window（允许 50ms 边界误差）。
 */
export function sliceAnalysis(parent, from, to) {
  if (!parent?.window || !parent?.info) {
    throw new TypeError('sliceAnalysis requires a parent VideoAnalysisAsset');
  }
  const { winStart, winEnd, winDur } = resolveWindow(parent.info, from, to);
  const p0 = parent.window.from;
  const p1 = parent.window.from + parent.window.duration;
  if (winStart < p0 - 0.05 || winEnd > p1 + 0.05) {
    throw new RangeError(
      `slice [${winStart}, ${winEnd}] is outside parent window [${p0}, ${p1}]`,
    );
  }

  const cuts = (parent.shots?.cuts ?? []).filter((c) => c.t >= winStart && c.t < winEnd);
  const events = (parent.audio?.events ?? []).filter((e) => e.t >= winStart && e.t <= winEnd);
  const eventsRel = events.map((e) => ({ ...e, t: +(e.t - winStart).toFixed(2) }));
  const silences = (parent.audio?.silences ?? [])
    .map((s) => ({
      from: Math.max(s.from, winStart),
      to: Math.min(s.to, winEnd),
    }))
    .filter((s) => s.to > s.from);

  let audio = null;
  if (parent.audio) {
    // 响度序列按窗口相对采样粗切（step 默认 0.1）
    const step = parent.audio.step ?? 0.1;
    const i0 = Math.max(0, Math.floor((winStart - p0) / step));
    const i1 = Math.min(parent.audio.series?.length ?? 0, Math.ceil((winEnd - p0) / step));
    const series = Array.isArray(parent.audio.series) ? parent.audio.series.slice(i0, i1) : [];
    audio = {
      ...parent.audio,
      series,
      samples: series.length,
      silences,
      events,
      eventsRel,
      sliced: true,
    };
  }

  const segments = (parent.transcript?.segments ?? [])
    .filter((s) => s.to > winStart && s.from < winEnd)
    .map((s) => ({
      ...s,
      from: Math.max(s.from, winStart),
      to: Math.min(s.to, winEnd),
    }));
  const transcript = parent.transcript
    ? { ...parent.transcript, segments, sliced: true }
    : null;

  const relSegments = segments
    .map((seg) => ({ ...seg, from: seg.from - winStart, to: seg.to - winStart }))
    .filter((seg) => seg.to > 0 && seg.from < winDur);
  const speech = relSegments.length > 0
    ? speechCurve(relSegments, { duration: winDur })
    : null;

  return {
    schema_version: VAA_SCHEMA_VERSION,
    info: parent.info,
    window: { from: winStart, to: winStart + winDur, duration: winDur },
    shots: {
      cuts,
      summary: parent.shots?.summary ?? { frames: 0, p90: 0, p99: 0 },
      threshold: parent.shots?.threshold,
      cached: true,
      reused: true,
      sliced: true,
    },
    audio,
    transcript,
    speech,
    status: {
      ...buildAnalysisStatus({
        info: parent.info, shots: { reused: true }, audio, transcript,
        wantAudio: Boolean(audio), transcriptMode: transcript ? 'auto' : 'off',
      }),
      shots: 'sliced',
      parent_window: { from: p0, to: p1 },
    },
    cache_hits: [...(parent.cache_hits ?? []), 'slice'],
    cache_misses: [],
    timing: { probe_ms: 0, shot_scan_ms: 0, audio_ms: 0, asr_ms: 0, sliced: true },
  };
}

/** 清单/返回值用的精简 transcript 摘要（不含完整 segments） */
export function summarizeTranscript(transcriptInfo, winDur) {
  if (!transcriptInfo) return null;
  const segs = transcriptInfo.segments ?? [];
  const chars = segs.reduce((n, seg) => n + String(seg.text ?? '').length, 0);
  return {
    source: transcriptInfo.source,
    model: transcriptInfo.model ?? null,
    segments: segs.length,
    chars,
    charsPerSec: +(chars / Math.max(1, winDur)).toFixed(2),
    ...(transcriptInfo.chunks ? { chunks: transcriptInfo.chunks } : {}),
    ...(transcriptInfo.suspect ? {
      suspect: transcriptInfo.suspect, suspectDetail: transcriptInfo.suspectDetail,
    } : {}),
    ...(transcriptInfo.termsFixed ? { termsFixed: transcriptInfo.termsFixed } : {}),
    ...(transcriptInfo.error ? { error: transcriptInfo.error } : {}),
  };
}
