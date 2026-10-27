/**
 * pipeline.js — 端到端编排门面。
 *
 * 内部三阶段（可单独调用、单独测、单独缓存）：
 *   analyzeVideo → planStoryboard → renderStoryboard
 *
 * CLI 与 DSH 工具仍只调 `runStoryboard`，避免两份实现漂移。
 * 本模块也保留 formatManifest / formatProbe 等面向模型的文本视图。
 */

import { DEFAULT_FFMPEG, DEFAULT_FFPROBE } from './probe.js';
import { analyzeVideo, sliceAnalysis, summarizeTranscript } from './analyze.js';
import { planStoryboard } from './plan-storyboard.js';
import { materializeTextCells, renderStoryboard } from './render.js';
import { encodeRaw } from './sheet.js';
import { findCoveringAnalysis, putAnalysis } from './vaa-store.js';

export { analyzeVideo, sliceAnalysis, summarizeTranscript, resolveWindow } from './analyze.js';
export { planStoryboard } from './plan-storyboard.js';
export { renderStoryboard, materializeTextCells } from './render.js';
export { buildEpisodeFromResult, formatEpisodeForMemory } from './memory-adapter.js';

export const PICK_MODES = ['sharp', 'mid', 'thumb'];
export const BURN_MODES = ['index', 'index+time', 'none'];

/**
 * @param {object} opts  与旧版 runStoryboard 参数兼容
 * @param {'coverage'|'density'} [opts.strategy]
 * @param {'temporal'|'spatial'|null} [opts.zoomMode]
 * @param {boolean} [opts.reuseAnalysis=true]  zoom 时尝试切片父窗口 VAA
 */
export async function runStoryboard(opts) {
  const {
    input,
    from = 0,
    to,
    threshold = 'auto',
    minGap = 1.2,
    adaptive = true,
    pick = 'sharp',
    burn = 'index',
    transcript = 'auto',
    audioStrip = true,
    asrMaxChunk = 45,
    cache = true,
    textOnly = false,
    strategy = 'coverage',
    zoomMode = null,
    reuseAnalysis = true,
    fingerprints = true,
    precomputed = null,
    analysis: injectedAnalysis = null,
    badgeRatio = 0.15,
    budget = 640_000,
    encode = true,
    ffmpegPath = DEFAULT_FFMPEG,
    ffprobePath = DEFAULT_FFPROBE,
    onProgress,
    cells = 0,
    sheets = 0,
  } = opts;
  if (!input) throw new Error('input is required');
  if (!PICK_MODES.includes(pick)) throw new RangeError(`pick must be one of ${PICK_MODES.join('/')}`);
  if (!BURN_MODES.includes(burn)) throw new RangeError(`burn must be one of ${BURN_MODES.join('/')}`);

  // textOnly 仍需要台词；音频条不需要时也可跳过完整响度，但 ASR 切片依赖静音 → wantAudio 跟 transcript 走
  const wantAudio = Boolean(
    (audioStrip !== false && !textOnly) || transcript !== 'off',
  );

  let analysis = injectedAnalysis;
  if (!analysis && reuseAnalysis) {
    const winStart = Math.max(0, Number(from) || 0);
    const winEnd = Number(to) > 0 ? Number(to) : Infinity;
    if (Number.isFinite(winEnd) && winEnd > winStart) {
      const parent = await findCoveringAnalysis(input, winStart, winEnd);
      if (parent) {
        try { analysis = sliceAnalysis(parent, winStart, winEnd); } catch { /* 回落重分析 */ }
      }
    }
  }
  if (!analysis) {
    analysis = await analyzeVideo({
      input, from, to, threshold, transcript, wantAudio, cache, precomputed,
      asrMaxChunk, fingerprints, enrichment: opts.enrichment ?? 'auto',
      ffmpegPath, ffprobePath, onProgress,
    });
  }
  await putAnalysis(analysis);

  const plan = planStoryboard(analysis, {
    cells, sheets, adaptive, minGap, pick, burn, strategy, zoomMode,
  });

  const transcriptSummary = summarizeTranscript(analysis.transcript, analysis.window.duration);
  // 一致性检查：台词落在「被判静音」的区间里 = 轻声被 -40 dB 门限吞了，或 ASR 编的。
  const textInSilence = transcriptSummary?.source === 'asr'
    ? countTextInSilence(analysis.transcript?.segments ?? [], analysis.audio?.silences ?? [])
    : 0;
  if (transcriptSummary && textInSilence > 0) {
    transcriptSummary.textInSilence = textInSilence;
  }
  const planOut = {
    cells: plan.cells,
    sheets: plan.sheets,
    adaptive: plan.adaptive,
    pick: plan.pick,
    burn: plan.burn,
    minGap: plan.minGap,
    effective_min_gap: plan.effective_min_gap,
    cuts_uncertain: plan.cuts_uncertain,
    strategy: plan.strategy,
    zoomMode: plan.zoomMode,
    plan_id: plan.plan_id,
    reason: plan.reason,
    bursts: plan.bursts,
  };

  const degradedKind = analysis.shots?.degraded_kind
    ?? (analysis.shots?.degraded === 'motion' ? 'motion'
      : analysis.shots?.degraded ? 'sampled' : null);
  const shotHonesty = {
    degraded: Boolean(analysis.shots?.degraded),
    degraded_kind: degradedKind,
    motion: analysis.shots?.motion ?? null,
    sample: analysis.shots?.sample ?? null,
    status_shots: analysis.status?.shots ?? null,
  };

  if (textOnly) {
    const cellsMeta = materializeTextCells(analysis, plan);
    return {
      info: analysis.info,
      window: analysis.window,
      cuts: analysis.shots.cuts,
      summary: analysis.shots.summary,
      threshold: analysis.shots.threshold,
      cached: Boolean(analysis.shots.cached),
      ...shotHonesty,
      analysis,
      audio: null,
      transcript: transcriptSummary
        ? { source: transcriptSummary.source, model: transcriptSummary.model,
          segments: transcriptSummary.segments,
          ...(transcriptSummary.textInSilence
            ? { textInSilence: transcriptSummary.textInSilence } : {}) }
        : null,
      plan: planOut,
      sheets: [],
      cells: cellsMeta,
      textOnly: true,
      totalDuration: +plan.cells_meta.reduce((n, c) => n + (c.t_end - c.t_start), 0).toFixed(3),
      status: analysis.status,
      timing: analysis.timing,
      cache_hits: analysis.cache_hits,
      cache_misses: analysis.cache_misses,
      enrichment: analysis.enrichment,
      shots_backend: analysis.shots?.backend ?? null,
    };
  }

  const rendered = await renderStoryboard(input, analysis, plan, {
    audioStrip, badgeRatio, budget, encode, ffmpegPath,
  });

  return {
    info: analysis.info,
    window: analysis.window,
    cuts: analysis.shots.cuts,
    summary: analysis.shots.summary,
    threshold: analysis.shots.threshold,
    cached: Boolean(analysis.shots.cached),
    ...shotHonesty,
    analysis,
    audio: audioStrip !== false && analysis.audio
      ? {
        ...analysis.audio,
        events: analysis.audio.events,
        summary: analysis.audio.summary,
      }
      : null,
    transcript: transcriptSummary,
    plan: planOut,
    sheets: rendered.sheets,
    totalDuration: rendered.totalDuration,
    status: analysis.status,
    timing: analysis.timing,
    cache_hits: analysis.cache_hits,
    cache_misses: analysis.cache_misses,
    enrichment: analysis.enrichment,
    shots_backend: analysis.shots?.backend ?? null,
  };
}

/** 把结果编码成 PNG 落盘（CLI 用；插件走附件服务，不落盘） */
export async function saveStoryboards(result, outPath, { ffmpegPath = DEFAULT_FFMPEG, quality } = {}) {
  const paths = [];
  for (const s of result.sheets) {
    const path = result.sheets.length === 1
      ? outPath
      : outPath.replace(/\.png$/i, `-${s.sheet}.png`);
    await encodeRaw(s.buffer, s.width, s.height, path, { ffmpegPath, quality });
    paths.push(path);
  }
  return paths;
}

const tc = (t) => {
  const m = Math.floor(t / 60);
  return `${String(m).padStart(2, '0')}:${(t % 60).toFixed(2).padStart(5, '0')}`;
};

/** manifest 顶栏 shots= 属性；区分抽样降级 vs 运镜误切 */
function shotDegradedAttr(result) {
  const kind = result.degraded_kind
    ?? (result.degraded === 'motion' ? 'motion' : null);
  const status = String(result.status_shots || '');
  if (kind === 'motion' || status.includes('motion')) return ' shots="degraded-motion"';
  if (kind === 'sampled+motion') return ' shots="sampled+motion"';
  if (result.degraded || status === 'degraded' || status === 'cached-degraded'
    || kind === 'sampled') {
    return ' shots="sampled-degraded"';
  }
  return '';
}

function isMotionDegraded(result) {
  const kind = String(result.degraded_kind || result.degraded || '');
  const status = String(result.status_shots || '');
  return kind.includes('motion') || status.includes('motion');
}

/**
 * 数一下有多少句台词落在「被判静音」的区间里。
 *
 * 两种成因都值得知道：**轻声说话被 -40 dB 阈值吞了**，或者 **ASR 在静音段编了字**。
 * 纯内存比较（句子数 × 静音段数），不额外跑 ffmpeg。
 *
 * @param {Array<{from:number,to:number}>} segments
 * @param {Array<{from:number,to:number}>} silences
 * @param {number} ratio 句子有多大比例压在静音里才算（默认 0.6）
 */
export function countTextInSilence(segments, silences, ratio = 0.6) {
  if (!segments?.length || !silences?.length) return 0;
  let n = 0;
  for (const seg of segments) {
    const dur = Math.max(0.01, seg.to - seg.from);
    let overlap = 0;
    for (const gap of silences) {
      const a = Math.max(seg.from, gap.from);
      const b = Math.min(seg.to, gap.to);
      if (b > a) overlap += b - a;
    }
    if (overlap / dur > ratio) n += 1;
  }
  return n;
}

/** 长于此时长（分钟）时给出完整 STRUCTURE / SEQUENCE 菜单 */
export const PROBE_DUAL_MODE_MINUTES = 8;

/**
 * video_probe 的文本：容器信息 + 一个"该怎么读"的建议。
 * 不扫描、不取帧，只花 ffprobe 的时间（几毫秒）。
 */
export function formatProbe(info) {
  const mins = info.duration / 60;
  const lines = [
    `<video path="${info.path ?? ''}" duration="${info.duration.toFixed(2)}" ` +
      `size="${info.width}x${info.height}" fps="${info.fps.toFixed(2)}" ` +
      `aspect="${info.aspect.toFixed(3)}" rotation="${info.rotation}" ` +
      `video="${info.videoCodec}" container="${info.container}" ` +
      `audio="${info.hasAudio ? (info.audioCodec ?? 'yes') : 'no'}" ` +
      `subtitles="${info.hasSubtitle ? 'yes' : 'no'}" />`,
  ];
  if (mins > PROBE_DUAL_MODE_MINUTES) {
    const estCells = Math.min(16, Math.max(4, Math.round(info.duration / 40)));
    const estSheets = Math.min(4, Math.ceil(info.duration / 300));
    lines.push(`one-shot overview would be about ${estCells} cells x ${estSheets} image(s) ` +
      '(duration-only estimate; cut density can change it).');
    lines.push('Two ways to read this, pick by what you need:');
    lines.push(`  • STRUCTURE (spoils the ending): one wide pass — ` +
      `video_storyboard({ input, cells: 16, sheets: 4 }) → whole film in 4 images, ` +
      `then open the 2-3 sections that look interesting. ~${(info.duration / 30).toFixed(0)} s of CPU.`);
    lines.push(`  • SEQUENCE (no spoilers, like watching it): ` +
      `video_storyboard({ input, from: 0, to: 300 }) then 300-600, 600-900 … one window at a time, ` +
      `never looking ahead. About ${Math.max(1, Math.ceil(info.duration / 300))} windows; ` +
      'each window scan is cached, so re-reading a stretch is free. ' +
      'For very long films prefer CLI `--plan 300` / batch windows snapped to cuts.');
  } else if (mins < 1) {
    lines.push(`under a minute (${info.duration.toFixed(0)}s): one call is enough.`);
  } else {
    lines.push(`Medium (${mins.toFixed(0)} min): one overview call usually works. ` +
      'Following a story rather than analysing structure? Prefer `from`/`to` windows ' +
      '(SEQUENCE) so later scenes are not on screen early.');
  }
  if (!info.hasAudio) lines.push('no audio track: transcript will be empty, the grid is visual only.');
  else if (!info.hasSubtitle) {
    lines.push('no subtitle track: transcript (if any) must come from ASR; ' +
      'without an ASR endpoint the grid is visual-only (loudness/cuts still work).');
  }
  return lines.join('\n');
}

/** 三档台词预算（字符）：low 只判断"这段在讲什么"，high 要能引用原话 */
export const DETAIL_CHARS = { low: 60, med: 120, high: 400 };

/**
 * 在**句末**截断，而不是从第 N 个字符硬切。
 */
export function truncateAtSentence(text, limit) {
  const src = String(text ?? '');
  if (!(limit > 0) || src.length <= limit) return src;
  const room = Math.max(1, limit - 1);
  const head = src.slice(0, room);
  const re = /[。！？；…!?;]|\.(?=\s|$)/g;
  let best = -1;
  let m;
  while ((m = re.exec(head)) !== null) {
    if (m.index + 1 >= Math.floor(room * 0.5)) best = m.index + 1;
  }
  if (best > 0) return `${src.slice(0, best)}…`;
  return `${head.trimEnd()}…`;
}

/**
 * 多窗口批处理的汇总表（Markdown）。
 */
export function formatTimeline(rows, { title = 'batch timeline' } = {}) {
  const total = rows.reduce((n, r) => n + (r.to - r.from), 0);
  const totalCells = rows.reduce((n, r) => n + r.cells, 0);
  const totalChars = rows.reduce((n, r) => n + (r.chars ?? 0), 0);
  const lines = [
    `# ${title}`,
    '',
    `- windows: **${rows.length}** · total ${tc(total)} · cells ${totalCells} · transcript ${totalChars} chars`,
    `- tokens: ${rows.length} image(s) ≈ **${rows.length * 384}** (one image per window)`,
    '',
    '| # | window | cells | cuts | chars | image |',
    '|---|---|---|---|---|---|',
  ];
  for (const r of rows) {
    lines.push(`| ${r.index} | ${tc(r.from)}–${tc(r.to)} | ${r.cells} | ${r.cuts} | ${r.chars ?? 0} | \`${r.image}\` |`);
  }
  return lines.join('\n');
}

/**
 * 把结果渲染成给模型看的文本清单。分镜计划是唯一时间轴真相；本函数只读派生视图。
 */
export function formatManifest(result, {
  maxCellChars = 120, maxChars = 24_000, cellRange = null,
} = {}) {
  const { info, window: win, plan } = result;
  const hasSheets = Boolean(result.sheets?.length);
  const sheet0 = result.sheets?.[0];

  const all = [];
  if (hasSheets) {
    for (const sheet of result.sheets) {
      for (const c of sheet.cells) all.push({ ...c, cols: sheet.cols, sheet: sheet.sheet });
    }
  } else if (Array.isArray(result.cells)) {
    for (const c of result.cells) all.push(c);
  }
  const total = all.length;
  const [lo, hi] = Array.isArray(cellRange) && cellRange.length === 2
    ? [Math.max(1, cellRange[0]), Math.min(total, cellRange[1])]
    : [1, total];
  const picked = all.filter((c) => c.i >= lo && c.i <= hi);

  const avgCut = result.cuts?.length
    ? (result.window.duration / Math.max(1, result.cuts.length)).toFixed(1)
    : null;
  const lines = [
    `<storyboard path="${info.path ?? 'video'}" duration="${info.duration.toFixed(2)}" ` +
      `window="${win.from.toFixed(2)}-${win.to.toFixed(2)}" ` +
      `image="${hasSheets ? `${sheet0.width}x${sheet0.height}` : 'none (text only)'}" ` +
      `grid="${plan.cells} cells x ${plan.sheets} image(s)" burn="${plan.burn}"` +
      `${plan.strategy ? ` strategy="${plan.strategy}"` : ''}` +
      `${plan.minGap != null ? ` minGap="${plan.minGap}"` : ''}` +
      `${plan.effective_min_gap != null && plan.effective_min_gap !== plan.minGap
        ? ` effectiveMinGap="${plan.effective_min_gap}"` : ''}` +
      `${plan.cuts_uncertain ? ' cutsUncertain="true"' : ''}` +
      `${plan.zoomMode ? ` zoomMode="${plan.zoomMode}"` : ''}` +
      `${plan.plan_id ? ` plan="${plan.plan_id}"` : ''}` +
      `${result.audio ? ` footer="audio-strip(${sheet0?.stripH ?? 0}px)"` : ''}` +
      `${result.transcript?.source ? ` transcript="${result.transcript.source}"` : ''}` +
      `${shotDegradedAttr(result)}` +
      (cellRange ? ` cells="${lo}-${hi} of ${total}"` : '') +
      (result.cuts?.length ? ` cuts="${result.cuts.length} (avg ${avgCut}s)"` : '') + '>',
  ];
  lines.push('Cell indices are burned into the grid image; exact timecodes live in this text ' +
    '(burn=index by design — do not rely on reading times off pixels).');
  if (plan.effective_min_gap != null && plan.minGap != null
    && Math.abs(plan.minGap - plan.effective_min_gap) > 0.049) {
    lines.push(
      `NOTE: requested minGap=${plan.minGap}s was clamped to effectiveMinGap=${plan.effective_min_gap}s ` +
      'by shot grain / cell budget — do not assume cells are spaced at the requested gap.',
    );
  }
  if (plan.cuts_uncertain || isMotionDegraded(result)) {
    const med = result.motion?.median_shot_sec;
    lines.push(
      `WARNING: cut list may be UNRELIABLE` +
      (isMotionDegraded(result)
        ? ' (degraded: motion — continuous camera/motion scored like cuts'
          + (med != null ? `; median shot ≈${med}s` : '') + ')'
        : ' (minGap was softened or scan degraded)') +
      ' — treat cut counts as pacing hints, not hard edit boundaries.',
    );
  }
  const sampledDegraded = Boolean(result.sample)
    || result.degraded_kind === 'sampled'
    || result.degraded_kind === 'sampled+motion'
    || result.status_shots === 'degraded'
    || result.status_shots === 'cached-degraded'
    || (result.degraded === true && !isMotionDegraded(result));
  if (sampledDegraded) {
    const cov = result.sample?.coverage_ratio;
    const gaps = result.sample?.unscanned_gap_count;
    lines.push(
      `WARNING: shot scan is SAMPLED/DEGRADED` +
      (cov != null ? ` (coverage≈${Math.round(cov * 100)}%)` : '') +
      (gaps != null ? `, ${gaps} unscanned gap(s)` : '') +
      ' — cut ticks outside sampled windows are UNKNOWN. ' +
      'Do not treat this cut list as a full-film edit decision. ' +
      'Re-read interesting ranges with a shorter `from`/`to` window for a full scan.',
    );
    const shown = (result.sample?.unscanned_gaps ?? []).slice(0, 4);
    if (shown.length) {
      lines.push('unscanned examples: ' +
        shown.map((g) => `${tc(g.from)}-${tc(g.to)}`).join(', ') +
        ((result.sample?.unscanned_gap_count ?? 0) > shown.length ? ', …' : ''));
    }
  }
  if (result.audio) {
    lines.push('footer strip shares the timeline (pacing cues, not emotion labels): ' +
      'teal bars = loudness (taller = louder), dark blocks = silence, yellow ticks = cut points ' +
      '(ticks may be thinned when cuts are dense — trust the cuts= count above).');
    if (result.audio.summary) {
      lines.push(`audio summary: ${result.audio.summary}`);
    } else if (Number.isFinite(result.audio.dynamic) || result.audio.silences?.length) {
      const quiet = result.audio.silences?.length ?? 0;
      const quietTime = (result.audio.silences ?? [])
        .reduce((s, r) => s + Math.max(0, (r.to ?? 0) - (r.from ?? 0)), 0);
      const bits = [];
      if (Number.isFinite(result.audio.dynamic)) bits.push(`${result.audio.dynamic} dB dynamic range`);
      if (quiet) bits.push(`${quiet} silence gap(s) (${quietTime.toFixed(1)}s)`);
      if (bits.length) lines.push(`audio summary: ${bits.join(', ')}`);
    }
  }
  if (result.audio?.events?.length && result.audio.events.length <= 20) {
    const list = [...result.audio.events]
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
      .slice(0, 6)
      .map((e) => `${tc(e.t)} ${e.kind === 'rise' ? '+' : ''}${e.delta}dB`).join(', ');
    lines.push(`audio events (${result.audio.events.length}): ${list}` +
      (result.audio.events.length > 6 ? ', …' : '') +
      ' — the picture may be static here; the change is in the sound.');
  }
  const bursts = Array.isArray(plan.bursts) ? plan.bursts : [];
  if (bursts.length) {
    const top = [...bursts]
      .sort((a, b) => (b.density ?? 0) - (a.density ?? 0))
      .slice(0, 4);
    lines.push(`cut bursts (fast montage): ${top.map((b) =>
      `${tc(b.from)}-${tc(b.to)} ~${b.shots ?? '?'} shots @ dens ${b.density ?? '?'}`).join('; ')}` +
      (bursts.length > top.length ? '; …' : '') +
      `. If yellow ticks look dense here, call video_zoom({ from, to, minGap: 0.4, mode: "temporal" }) ` +
      'or layout:"strip" to raise slice frequency.');
  } else if (result.cuts?.length && avgCut != null && Number(avgCut) < 1.2) {
    lines.push(`cut rate is high (avg ${avgCut}s). Consider video_zoom with minGap: 0.4 ` +
      '(or lower) on the busiest window to catch montage detail.');
  }

  let used = lines.join('\n').length;
  let stoppedAt = null;
  for (const c of picked) {
    const pos = (c.i - 1) % plan.cells;
    const where = typeof c.cols === 'number'
      ? ` (r${Math.floor(pos / c.cols) + 1}c${(pos % c.cols) + 1}` +
        `${result.sheets.length > 1 ? `, image ${c.sheet}` : ''})`
      : '';
    const text = truncateAtSentence(c.text, maxCellChars);
    const who = Array.isArray(c.speakers) && c.speakers.length
      ? ` [${c.speakers.join(',')}]`
      : '';
    const mood = Array.isArray(c.emotions) && c.emotions.length
      ? ` {${c.emotions.join(',')}}`
      : '';
    const head = `cell ${c.i}${where} = ${tc(c.t_start)}-${tc(c.t_end)}` +
      (c.cuts ? `  cuts ${c.cuts}` : '') + who + mood;
    const body = text ? `${head}\n    "${text}"` : head;
    if (used + body.length + 1 > maxChars) { stoppedAt = c.i - 1; break; }
    lines.push(body);
    used += body.length + 1;
  }

  if (stoppedAt !== null) {
    lines.push(`[text stopped at cell ${stoppedAt} of ${hi} — ` +
      `call again with cellRange: [${stoppedAt + 1}, ${hi}] and textOnly: true to read the rest]`);
  }
  if (result.transcript?.source === 'asr') {
    lines.push('transcript is ASR output (not a subtitle track): technical terms and names may be ' +
      'misheard — cross-check against on-screen text before quoting them.');
    if (result.transcript.termsFixed > 0) {
      lines.push(`${result.transcript.termsFixed} term(s) corrected by the local dictionary (DSH_ASR_TERMS / asr.json "terms")`);
    }
    if (result.transcript.textInSilence > 0) {
      lines.push(`${result.transcript.textInSilence} line(s) of text sit inside a detected silence — ` +
        'either the speech is below the -40 dB gate, or the ASR invented it');
    }
    if (result.transcript.suspect > 0) {
      const detail = (result.transcript.suspectDetail ?? [])
        .map((d) => `${d.from}-${d.to}s (${d.charsPerSec} chars/s, ${d.reason})`).join(', ');
      lines.push(`${result.transcript.suspect} segment(s) ignored as non-speech: ${detail}` +
        (result.transcript.suspect > 3 ? ', …' : ''));
    }
  }
  if (result.transcript?.source === 'asr-failed') {
    lines.push(`transcript unavailable: ${result.transcript.error ?? 'ASR call failed'} — ` +
      'treat this pass as visual-only (grid + audio strip + cuts); do not invent dialogue.');
  }
  if (result.transcript?.source === 'no-audio') lines.push('no audio track: grid is visual only');
  if (!result.transcript?.source) {
    lines.push('no transcript attached: visual-only pass (rely on grid, loudness/silence, and cut ticks).');
  }
  if (result.shots_backend === 'hsv+remote' || result.enrichment?.shots?.ok) {
    lines.push(
      `shot backend: HSV + remote detector` +
      (result.enrichment?.shots?.model ? ` (${result.enrichment.shots.model})` : '') +
      ' — gradual transitions (dissolve/wipe) may be present; still verify dense montage with video_zoom.',
    );
  }
  if (result.enrichment?.diarization?.ok) {
    const sp = result.enrichment.diarization.speakers ?? [];
    lines.push(
      `speakers labeled: ${sp.join(', ') || 'yes'}` +
      (result.enrichment.diarization.model ? ` via ${result.enrichment.diarization.model}` : '') +
      ' — cell lines may show [SPEAKER_xx].',
    );
  }
  if (result.enrichment?.audio_understand?.ok || result.enrichment?.sensevoice_tags) {
    lines.push(
      'emotion/event tags present' +
      (result.enrichment?.audio_understand?.model
        ? ` (audio model ${result.enrichment.audio_understand.model})`
        : ' (from SenseVoice-style ASR tags)') +
      ' — cell lines may show {HAPPY}/{SAD}/…; these are cues, not plot facts.',
    );
  }
  if (result.audio?.understand?.spans?.length) {
    const top = result.audio.understand.spans.slice(0, 5).map((s) => {
      const bits = [tc(s.from) + '-' + tc(s.to)];
      if (s.emotion) bits.push(s.emotion);
      if (s.event) bits.push(s.event);
      return bits.join(' ');
    });
    lines.push(`audio understand spans: ${top.join('; ')}` +
      (result.audio.understand.spans.length > 5 ? '; …' : ''));
  }
  const enrichFails = ['shots', 'diarization', 'audio_understand']
    .filter((k) => result.enrichment?.[k] && result.enrichment[k].ok === false);
  if (enrichFails.length) {
    lines.push('enrichment skipped/failed (HSV/ASR still valid): ' +
      enrichFails.map((k) => `${k}=${result.enrichment[k].error || result.enrichment[k].reason || 'no'}`).join('; '));
  }
  lines.push(`total ${picked.length} of ${total} cells shown` +
    (hasSheets ? '; unlabeled cells are padding, not content.' : '.'));
  lines.push('</storyboard>');
  return lines.join('\n');
}
