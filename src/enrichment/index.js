/**
 * DSH 可选增强层入口：远程镜头检测 / 说话人 / 情绪事件。
 * 全部 fail-open：任何失败都不阻断分镜主路径。
 */

export { resolveEnrichmentConfig, enrichmentEnabled } from './config.js';
export { detectShotsRemote, mergeShotCuts } from './shots-remote.js';
export { diarizeRemote, attachSpeakers } from './diarize.js';
export {
  parseSenseVoiceTags, enrichTranscriptEmotions, understandAudioRemote,
} from './audio-understand.js';

import { resolveEnrichmentConfig } from './config.js';
import { detectShotsRemote, mergeShotCuts } from './shots-remote.js';
import { diarizeRemote, attachSpeakers } from './diarize.js';
import { enrichTranscriptEmotions, understandAudioRemote } from './audio-understand.js';

/**
 * 在 HSV 扫描之后尝试远程切点；失败则原样返回。
 */
export async function maybeEnrichShots(hsvShots, {
  input, from, to, fps, enrichment, minGap = 0.35,
} = {}) {
  const cfg = enrichment || resolveEnrichmentConfig();
  if (!cfg.shots?.enable || !cfg.shots.baseUrl) {
    return { shots: hsvShots, enrichment: null };
  }
  try {
    const remote = await detectShotsRemote({
      input, from, to, fps,
      threshold: cfg.shots.threshold ?? 0.5,
      baseUrl: cfg.shots.baseUrl,
      key: cfg.shots.key,
      timeoutMs: cfg.shots.timeoutMs,
    });
    if (!remote || !remote.cuts?.length) {
      return {
        shots: hsvShots,
        enrichment: { shots: { ok: false, reason: 'empty', model: remote?.model } },
      };
    }
    const merged = mergeShotCuts(hsvShots.cuts, remote.cuts, { minGap });
    return {
      shots: {
        ...hsvShots,
        cuts: merged,
        backend: 'hsv+remote',
        remote_model: remote.model,
        remote_cuts: remote.cuts.length,
        ...(remote.degraded ? { remote_degraded: true } : {}),
      },
      enrichment: {
        shots: {
          ok: true,
          model: remote.model,
          cuts: remote.cuts.length,
          merged: merged.length,
        },
      },
    };
  } catch (error) {
    return {
      shots: hsvShots,
      enrichment: { shots: { ok: false, error: String(error?.message || error).slice(0, 200) } },
    };
  }
}

/**
 * 台词后处理：SenseVoice 标签 → 远程 diarize → 远程 audio understand。
 */
export async function maybeEnrichSpeech({
  input, from, to, transcriptInfo, enrichment, ffmpegPath,
} = {}) {
  const cfg = enrichment || resolveEnrichmentConfig();
  const report = {};
  let info = transcriptInfo ? { ...transcriptInfo } : null;
  let segments = info?.segments ? [...info.segments] : [];

  if (segments.length) {
    const emo = enrichTranscriptEmotions(segments);
    segments = emo.segments;
    if (emo.tagged) report.sensevoice_tags = emo.tagged;
  }

  if (cfg.diarization?.enable && cfg.diarization.baseUrl) {
    try {
      const dia = await diarizeRemote({
        input, from, to,
        baseUrl: cfg.diarization.baseUrl,
        key: cfg.diarization.key,
        timeoutMs: cfg.diarization.timeoutMs,
        ffmpegPath,
      });
      if (dia?.segments?.length) {
        const attached = attachSpeakers(segments, dia.segments);
        segments = attached.segments;
        report.diarization = {
          ok: true,
          model: dia.model,
          speakers: dia.speakers,
          labeled: attached.labeled,
        };
      } else {
        report.diarization = { ok: false, reason: 'empty' };
      }
    } catch (error) {
      report.diarization = { ok: false, error: String(error?.message || error).slice(0, 200) };
    }
  }

  let audioSpans = null;
  if (cfg.audioUnderstand?.enable && cfg.audioUnderstand.baseUrl) {
    try {
      const und = await understandAudioRemote({
        input, from, to,
        baseUrl: cfg.audioUnderstand.baseUrl,
        key: cfg.audioUnderstand.key,
        timeoutMs: cfg.audioUnderstand.timeoutMs,
        ffmpegPath,
      });
      if (und?.spans?.length) {
        audioSpans = und;
        report.audio_understand = { ok: true, model: und.model, spans: und.spans.length };
        // 把 span 情绪并回无 emotion 的台词段
        segments = segments.map((seg) => {
          if (seg.emotion) return seg;
          const mid = (seg.from + seg.to) / 2;
          const hit = und.spans.find((s) => mid >= s.from && mid < s.to && s.emotion);
          return hit ? { ...seg, emotion: hit.emotion } : seg;
        });
      } else {
        report.audio_understand = { ok: false, reason: 'empty' };
      }
    } catch (error) {
      report.audio_understand = { ok: false, error: String(error?.message || error).slice(0, 200) };
    }
  }

  if (info) info = { ...info, segments };
  return { transcriptInfo: info, audioSpans, report };
}
