/**
 * render.js — 根据既有分析 + 分镜计划取帧拼图。不再重新扫描/ASR。
 */

import { bestLayout } from './plan.js';
import { alignCells } from './asr.js';
import {
  addAudioStrip, composeSheet, encodePngBuffer, extractFrameRaw, extractSharpest, layoutCanvas,
} from './sheet.js';
import { DEFAULT_FFMPEG } from './probe.js';

/**
 * @param {string} input
 * @param {import('./analyze.js').VideoAnalysisAsset} analysis
 * @param {import('./plan-storyboard.js').StoryboardPlan} plan
 * @param {object} [opts]
 */
export async function renderStoryboard(input, analysis, plan, opts = {}) {
  const {
    audioStrip = true,
    badgeRatio = 0.15,
    budget = 640_000,
    encode = true,
    ffmpegPath = DEFAULT_FFMPEG,
  } = opts;

  const { info, window, shots, audio, transcript } = analysis;
  const { groups, pick, burn } = plan;
  const winStart = window.from;
  const winDur = window.duration;
  const stripAudio = audioStrip !== false ? audio : null;
  const cuts = shots?.cuts ?? [];

  const out = [];
  let index = 0;
  for (const [si, group] of groups.entries()) {
    if (group.length === 0) continue;
    const { cols, rows } = bestLayout(Math.max(1, group.length), info.aspect);
    const cellBudget = stripAudio ? Math.round(budget * 0.9) : budget;
    const { width, cellW, cellH } = layoutCanvas(cols, rows, info.aspect, cellBudget);
    const aligned = alignCells(group, transcript?.segments ?? []);
    const frames = [];
    const cellMeta = [];
    for (const [gi, { from: a, to: b }] of group.entries()) {
      index += 1;
      const planned = plan.cells_meta[index - 1];
      const focusAt = Number.isFinite(planned?.t_representative)
        ? Number(planned.t_representative)
        : (Number.isFinite(planned?.representative_ms)
          ? planned.representative_ms / 1000
          : undefined);
      let frame;
      if (pick === 'sharp') {
        frame = await extractSharpest({
          input, at: a, dur: b - a, cellW, cellH, ffmpegPath, focusAt,
        });
      } else if (pick === 'thumb') {
        frame = await extractFrameRaw({
          input, at: a, dur: b - a, cellW, cellH, ffmpegPath, mode: 'thumb',
        });
      } else {
        const midAt = Number.isFinite(focusAt) ? focusAt : a + (b - a) / 2;
        frame = await extractFrameRaw({
          input, at: midAt, cellW, cellH, ffmpegPath, mode: 'mid',
        });
      }
      frames.push({ buffer: frame.buffer, index, t: frame.t });
      const text = aligned[gi] ?? null;
      const cellCuts = cuts.filter((c) => c.t >= a && c.t < b).length;
      cellMeta.push({
        i: index,
        cell_id: planned?.cell_id ?? `cell_${String(index).padStart(4, '0')}`,
        sheet: si + 1,
        t_start: +a.toFixed(3),
        t_end: +b.toFixed(3),
        start_ms: planned?.start_ms ?? Math.round(a * 1000),
        end_ms: planned?.end_ms ?? Math.round(b * 1000),
        t_frame: +frame.t.toFixed(3),
        representative_ms: Math.round(frame.t * 1000),
        ...(Number.isFinite(focusAt) ? { planned_representative_ms: Math.round(focusAt * 1000) } : {}),
        ...(planned?.selection_reason ? { selection_reason: planned.selection_reason } : {}),
        ...(cellCuts > 0 ? { cuts: cellCuts } : {}),
        ...(frame.sharp !== undefined ? { sharp: +frame.sharp.toFixed(1) } : {}),
        ...(text?.text ? { text: text.text, charsPerSec: text.charsPerSec } : {}),
        ...(text?.speakers?.length ? { speakers: text.speakers } : {}),
        ...(text?.emotions?.length ? { emotions: text.emotions } : {}),
      });
    }
    let sheet = composeSheet({
      frames, cols, rows, cellAspect: info.aspect, budget: cellBudget, burn, badgeRatio,
    });
    if (stripAudio) {
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

  return {
    sheets: out,
    totalDuration: +plan.cells_meta.reduce((n, c) => n + (c.t_end - c.t_start), 0).toFixed(3),
  };
}

/**
 * textOnly：只把计划里的格对齐台词，不解帧。
 */
export function materializeTextCells(analysis, plan) {
  const cellsMeta = [];
  let n = 0;
  for (const group of plan.groups) {
    const aligned = alignCells(group, analysis.transcript?.segments ?? []);
    group.forEach(({ from: a, to: b }, gi) => {
      n += 1;
      const planned = plan.cells_meta[n - 1];
      const t = aligned[gi] ?? null;
      cellsMeta.push({
        i: n,
        cell_id: planned?.cell_id ?? `cell_${String(n).padStart(4, '0')}`,
        t_start: +a.toFixed(3),
        t_end: +b.toFixed(3),
        start_ms: planned?.start_ms ?? Math.round(a * 1000),
        end_ms: planned?.end_ms ?? Math.round(b * 1000),
        ...(planned?.selection_reason ? { selection_reason: planned.selection_reason } : {}),
        ...(t?.text ? { text: t.text, charsPerSec: t.charsPerSec } : {}),
        ...(t?.speakers?.length ? { speakers: t.speakers } : {}),
        ...(t?.emotions?.length ? { emotions: t.emotions } : {}),
      });
    });
  }
  return cellsMeta;
}
