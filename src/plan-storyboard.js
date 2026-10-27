/**
 * plan-storyboard.js — 分镜计划层（纯决策，零 ffmpeg）。
 *
 * 策略：
 *   - `coverage`（默认，adaptive）：候选帧 + 覆盖约束 + 新颖性
 *   - `density`：旧密度积分等分（兼容）
 *   - fit-segments：adaptive=false / 无切点时
 */

import { suggest } from './plan.js';
import { findBursts, planCellRanges } from './density.js';
import { fitSegments, resolveEffectiveMinGap, segmentsFromCuts } from './segments.js';
import {
  buildCandidates, representativesToRanges, scoreCandidates, selectWithCoverage,
} from './candidates.js';
import { attachFingerprints } from './fingerprints.js';

const secToMs = (s) => Math.round(Number(s) * 1000);

/**
 * @param {import('./analyze.js').VideoAnalysisAsset} analysis
 * @param {object} opts
 * @param {'coverage'|'density'} [opts.strategy]
 */
export function planStoryboard(analysis, opts = {}) {
  if (!analysis?.info || !analysis?.window) {
    throw new TypeError('planStoryboard requires a Video Analysis Asset');
  }
  const {
    cells: cellsOpt = 0,
    sheets: sheetsOpt = 0,
    adaptive = true,
    minGap = 1.2,
    pick = 'sharp',
    burn = 'index',
    strategy = 'coverage',
    zoomMode = null, // 'temporal' | 'spatial' | null
  } = opts;

  const { info, window, shots, audio, transcript, speech } = analysis;
  const winStart = window.from;
  const winDur = window.duration;
  const relCuts = (shots?.cuts ?? []).map((c) => c.t - winStart);

  const relSegments = (transcript?.segments ?? [])
    .map((seg) => ({ ...seg, from: seg.from - winStart, to: seg.to - winStart }))
    .filter((seg) => seg.to > 0 && seg.from < winDur);

  let cells = Math.max(0, Number(cellsOpt) || 0);
  let sheets = Math.max(0, Number(sheetsOpt) || 0);
  let suggestion;
  if (cells === 0) {
    const speechChars = relSegments.reduce((n, seg) => n + String(seg.text ?? '').length, 0);
    const speechRate = winDur > 0 ? speechChars / winDur : 0;
    suggestion = suggest({
      duration: winDur,
      cuts: relCuts.length,
      motion: shots?.summary?.p90 ?? 0,
      aspect: info.aspect,
      speechRate,
      hasSubtitle: info.hasSubtitle,
      meanLufs: audio?.mean,
    });
    cells = suggestion.cells;
    sheets = sheets || suggestion.sheets;
  }
  sheets = sheets || 1;

  // zoom temporal：更密采样；spatial：少格（调用方通常已设 cells）
  const requestedMinGap = zoomMode === 'temporal'
    ? Math.min(minGap, 0.4)
    : minGap;

  const speechRateForEvents = winDur > 0
    ? relSegments.reduce((n, seg) => n + String(seg.text ?? '').length, 0) / winDur : 0;
  const audioEvents = speechRateForEvents < 3
    ? [...(audio?.eventsRel ?? [])]
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
      .slice(0, 12)
      .sort((a, b) => a.t - b.t)
    : [];

  const totalCells = cells * sheets;
  let cellRanges;
  let strategyUsed = 'fit-segments';
  /** 素材粒度钳制后的真实间隔（写入 manifest，避免报告 2.0 实际 0.54） */
  let effectiveMinGap = requestedMinGap;

  if (adaptive && relCuts.length > 0 && strategy === 'coverage') {
    strategyUsed = 'coverage';
    let candidates = buildCandidates({
      duration: winDur,
      cuts: relCuts,
      audioEvents,
      dialogue: relSegments,
    });
    candidates = attachFingerprints(candidates, analysis.fingerprints, winStart);
    const scored = scoreCandidates(candidates, {
      duration: winDur,
      cuts: relCuts,
      speechRate: speechRateForEvents,
      meanLufs: audio?.mean,
    });
    const minTemporalGap = Math.min(requestedMinGap, winDur / Math.max(totalCells * 2, 1));
    effectiveMinGap = +minTemporalGap.toFixed(4);
    const selected = selectWithCoverage(scored, {
      k: totalCells,
      duration: winDur,
      minTemporalGap,
      coverageRatio: zoomMode === 'temporal' ? 0.35 : 0.5,
    });
    cellRanges = representativesToRanges(selected, winDur)
      .map((r) => ({
        from: r.from + winStart,
        to: r.to + winStart,
        density: r.density,
        reasons: r.reasons,
        representative: r.representative + winStart,
      }));
  } else if (adaptive && relCuts.length > 0) {
    strategyUsed = 'density';
    const segsForGrain = segmentsFromCuts(winDur, relCuts, 0.4, 0);
    effectiveMinGap = resolveEffectiveMinGap(segsForGrain, requestedMinGap, {
      cells: totalCells, duration: winDur,
    });
    cellRanges = planCellRanges({
      duration: winDur, cuts: relCuts, cells: totalCells,
      speech, audioEvents, minGap: requestedMinGap,
    }).map((r) => ({ from: r.from + winStart, to: r.to + winStart, density: r.density, reasons: ['density'] }));
  } else {
    strategyUsed = adaptive ? 'uniform-no-cuts' : 'fit-segments';
    const segs = segmentsFromCuts(winDur, relCuts, 0.4, winStart);
    // fitSegments 只做素材粒度钳制（不含 cells 上限），与 resolveEffectiveMinGap 默认同口径
    effectiveMinGap = resolveEffectiveMinGap(segs, requestedMinGap);
    cellRanges = fitSegments(segs, totalCells, { minGap: requestedMinGap })
      .map(([a, b]) => ({ from: a, to: b, density: 1, reasons: [strategyUsed] }));
  }

  const cutsUncertain = Boolean(
    analysis.shots?.degraded === 'motion'
    || String(analysis.shots?.degraded_kind || '').includes('motion')
    || (requestedMinGap > 0 && Math.abs(requestedMinGap - effectiveMinGap) > 0.049),
  );

  const groups = [];
  for (let i = 0; i < sheets; i++) groups.push(cellRanges.slice(i * cells, (i + 1) * cells));

  const cells_meta = [];
  let index = 0;
  for (let si = 0; si < groups.length; si++) {
    for (const r of groups[si]) {
      index += 1;
      const selection_reason = [...(r.reasons ?? [strategyUsed])];
      if (r.density > 1.2) selection_reason.push('high-density');
      cells_meta.push({
        cell_id: `cell_${String(index).padStart(4, '0')}`,
        index,
        sheet: si + 1,
        start_ms: secToMs(r.from),
        end_ms: secToMs(r.to),
        t_start: +r.from.toFixed(3),
        t_end: +r.to.toFixed(3),
        ...(r.representative != null ? {
          representative_ms: secToMs(r.representative),
          t_representative: +Number(r.representative).toFixed(3),
        } : {}),
        density: r.density ?? 1,
        selection_reason,
      });
    }
  }

  const bursts = findBursts(relCuts, winDur).map((b) => ({
    from: +(b.from + winStart).toFixed(2),
    to: +(b.to + winStart).toFixed(2),
    shots: b.shots,
  }));

  const plan_id = [
    'plan', strategyUsed[0],
    Math.round(winStart * 100), Math.round((winStart + winDur) * 100),
    cells, sheets, adaptive ? 'a' : 'f', Math.round(effectiveMinGap * 100),
  ].join('_');

  return {
    plan_id,
    window: { ...window },
    cells,
    sheets,
    adaptive,
    minGap: requestedMinGap,
    effective_min_gap: effectiveMinGap,
    cuts_uncertain: cutsUncertain,
    pick,
    burn,
    strategy: strategyUsed,
    zoomMode,
    reason: suggestion?.reason ?? 'explicit',
    cells_meta,
    groups,
    bursts,
    suggestion: suggestion ?? null,
  };
}
