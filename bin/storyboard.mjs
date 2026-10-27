#!/usr/bin/env node
/**
 * storyboard — CLI 薄壳，真正的逻辑全在 src/pipeline.js（与 DSH 工具同一份实现）。
 *
 *   node bin/storyboard.mjs <video> [--cells 9] [--sheets 1] [--from 0] [--to 300]
 *                                   [--pick sharp|mid|thumb] [--burn index|index+time|none]
 *                                   [--threshold auto|15] [--min-gap 1.2]
 *                                   [--transcript auto|off] [--no-adaptive] [--badge 0.15]
 *                                   [--out sheet.png] [--manifest m.json] [--plan 300] [--text]
 */
import { writeFile } from 'node:fs/promises';

import { args as parse } from './_args.mjs';
import { probeVideo } from '../src/probe.js';
import { planWindows } from '../src/plan.js';
import {
  DETAIL_CHARS, buildEpisodeFromResult, formatManifest, formatTimeline, runStoryboard, saveStoryboards,
} from '../src/pipeline.js';

const opt = parse(process.argv.slice(2), {
  cells: 0, sheets: 0, from: 0, to: 0, threshold: 'auto', 'min-gap': 1.2,
  pick: 'sharp', burn: 'index', badge: 0.15, transcript: 'auto',
  out: 'storyboard.png', manifest: null, plan: 0, 'text-only': false, 'cell-range': null,
  batch: 0, detail: 'med', strategy: 'coverage', episode: null,
  fingerprints: true,
});
const input = opt._[0];
if (!input) {
  console.error('usage: node bin/storyboard.mjs <video> [--cells 9] [--from 0] [--to 300] ...');
  process.exit(2);
}

const info = await probeVideo(input).catch((error) => {
  console.error(`探测失败：${error.message}`);
  process.exit(1);
});

// --plan：只算分段，不渲染
if (Number(opt.plan) > 0) {
  const p = planWindows(info.duration, Number(opt.plan));
  console.log(`[plan] ${info.duration.toFixed(0)}s → ${p.total} 段（每段 ≈${p.step.toFixed(0)}s），` +
    `预计 ${p.total} 张图 ≈ ${p.approxTokens} token` +
    `${p.stepAdjusted ? `  ⚠️ 段数超上限，已把每段从 ${p.requestedStep}s 拉长以保证覆盖全片` : ''}`);
  for (const w of p.windows) {
    console.log(`  ${String(w.index).padStart(2)}. ${w.from.toFixed(0).padStart(5)}–${w.to.toFixed(0).padStart(5)}s  ` +
      `(${w.duration.toFixed(0)}s)  ${w.cells} 格 ×${w.images}  ≈${w.approxTokens} tok`);
  }
  console.log('\n逐段跑：node bin/storyboard.mjs <video> --from A --to B');
  process.exit(0);
}

// --batch <秒>：把整片按固定步长切成若干窗口，逐个出图，最后写一张时间线表。
// 一部 2 小时半的电影手工敲 24 次 --from/--to 不现实，这是给长片用的入口。
const batchStep = Number(opt.batch) || 0;
if (batchStep > 0) {
  // 先全片扫一遍拿切点，让窗口边界落在剪辑点上（而不是钟表上）。
  // 2 小时片约 25s，相对于几十个窗口的渲染时间可以忽略。
  let boundaries = [];
  let precomputed = null;
  if (opt.snap !== false) {
    const { scanShots } = await import('../src/scan.js');
    console.log('[batch] 全片扫描切点（用于窗口对齐，可加 --no-snap 跳过）…');
    // 这一遍的切点也直接喂给每个窗口，省掉"每个窗口各扫一遍"的重复解码
    precomputed = await scanShots({ input, fps: info.fps, threshold: 'auto' });
    boundaries = precomputed.cuts.map((c) => c.t);
    console.log(`[batch] 切点 ${boundaries.length} 个（窗口内复用，不再重复扫描）`);
  }
  const planW = planWindows(info.duration, batchStep, { boundaries });
  if (planW.snapped) console.log(`[batch] ${planW.snapped} 个窗口边界吸附到剪辑点`);
  const base = String(opt.out).replace(/\.png$/i, '');
  const rows = [];
  const t0 = Date.now();
  for (const w of planW.windows) {
    const r = await runStoryboard({
      input, from: w.from, to: w.to, cells: 0, sheets: 0,
      threshold: opt.threshold === 'auto' ? 'auto' : Number(opt.threshold),
      pick: String(opt.pick), burn: String(opt.burn), transcript: String(opt.transcript),
      precomputed,
    });
    const image = `${base}-w${String(w.index).padStart(2, '0')}.png`;
    await saveStoryboards(r, image, { quality: 4 });
    const cells = r.sheets.flatMap((sh) => sh.cells);
    rows.push({
      index: w.index, from: w.from, to: w.to,
      cells: cells.length, cuts: r.cuts.length,
      chars: r.transcript?.chars ?? 0, image,
    });
    console.log(`[batch] ${w.index}/${planW.total}  ${w.from.toFixed(0)}–${w.to.toFixed(0)}s  ` +
      `${cells.length} 格  → ${image}  (${Date.now() - t0}ms)`);
  }
  const md = formatTimeline(rows, { title: `${info.path ?? input} — ${planW.total} windows @ ${batchStep}s` });
  const mdPath = `${base}-timeline.md`;
  await writeFile(mdPath, `${md}\n`, 'utf8');
  console.log(`\n${md}`);
  console.log(`[batch] 汇总写入 ${mdPath}  总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  process.exit(0);
}

const adaptive = !process.argv.includes('--no-adaptive');
const textOnly = Boolean(opt['text-only']);
const wantFingerprints = opt.fingerprints !== false
  && !process.argv.includes('--no-fingerprints');
const cellRange = (() => {
  const raw = opt['cell-range'];
  if (!raw) return null;
  const m = String(raw).match(/^(\d+)-(\d+)$/);
  return m ? [Number(m[1]), Number(m[2])] : null;
})();
const t0 = Date.now();
const r = await runStoryboard({
  input,
  from: Number(opt.from) || 0,
  to: Number(opt.to) || 0,
  cells: Number(opt.cells) || 0,
  sheets: Number(opt.sheets) || 0,
  threshold: opt.threshold === 'auto' ? 'auto' : Number(opt.threshold),
  minGap: Number(opt['min-gap']) || 0,
  pick: String(opt.pick),
  burn: String(opt.burn),
  badgeRatio: Number(opt.badge) || 0.15,
  transcript: String(opt.transcript),
  adaptive,
  textOnly,
  strategy: String(opt.strategy || 'coverage'),
  fingerprints: wantFingerprints,
});

console.log(`[probe] ${info.width}x${info.height} ${info.fps.toFixed(2)}fps ${info.duration.toFixed(2)}s` +
  `${info.hasAudio ? ' audio' : ''}${info.hasSubtitle ? ' subtitle' : ''}` +
  (r.window.from > 0 || r.window.to < info.duration
    ? `  window=${r.window.from.toFixed(1)}..${r.window.to.toFixed(1)}s` : ''));
console.log(`[scan] ${r.summary.frames} 帧 → ${r.cuts.length} 个切点（阈值 ${r.threshold}，` +
  `${r.plan.adaptive ? `自适应 ${r.plan.bursts.length} 个密集段` : '均匀分配'}）`);
console.log(`[plan] ${r.plan.cells} 格 × ${r.plan.sheets} 张 · ${r.plan.strategy ?? '?'} — ${r.plan.reason}`);
if (r.status) console.log(`[status] shots=${r.status.shots} audio=${r.status.audio} transcript=${r.status.transcript}`);
if (r.audio) console.log(`[audio] ${r.audio.summary}`);
if (r.transcript) {
  console.log(`[transcript] ${r.transcript.source}${r.transcript.model ? ` (${r.transcript.model})` : ''}` +
    `${r.transcript.segments ? `，${r.transcript.segments} 段` : ''}` +
    `${r.transcript.error ? `  ⚠️ ${r.transcript.error}` : ''}`);
}

if (!textOnly) {
  const paths = await saveStoryboards(r, opt.out, { quality: 4 });
  for (const [i, sheet] of r.sheets.entries()) {
    console.log(`[sheet] ${paths[i]}  ${sheet.width}x${sheet.height}  ${sheet.cols}x${sheet.rows}` +
      `  cell≈${sheet.cellW}x${sheet.cellH}${sheet.stripH ? `  strip=${sheet.stripH}px` : ''}`);
  }
}
console.log(`[done] ${Date.now() - t0}ms` +
  (r.timing ? `  (scan ${r.timing.shot_scan_ms}ms / audio ${r.timing.audio_ms}ms / asr ${r.timing.asr_ms}ms)` : ''));

if (opt.manifest) {
  const payload = {
    input, window: r.window, threshold: r.threshold, summary: r.summary,
    status: r.status, timing: r.timing,
    audio: r.audio ? { mean: r.audio.mean, peak: r.audio.peak, silences: r.audio.silences } : null,
    transcript: r.transcript,
    plan: {
      cells: r.plan.cells, sheets: r.plan.sheets, adaptive: r.plan.adaptive,
      strategy: r.plan.strategy, plan_id: r.plan.plan_id, bursts: r.plan.bursts,
    },
    sheets: r.sheets.map((s) => ({
      sheet: s.sheet, cols: s.cols, rows: s.rows, width: s.width, height: s.height,
      stripH: s.stripH ?? null, cells: s.cells,
    })),
    cells: r.cells ?? null,
  };
  await writeFile(opt.manifest, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`[manifest] ${opt.manifest}`);
}

if (opt.episode) {
  const episode = buildEpisodeFromResult(r, {
    trigger: 'cli',
    path: input,
    platform: 'local',
  });
  await writeFile(String(opt.episode), `${JSON.stringify(episode, null, 2)}\n`, 'utf8');
  console.log(`[episode] ${opt.episode}`);
}

if (opt.text || textOnly) {
  console.log(`\n${formatManifest(r, {
    cellRange, maxCellChars: DETAIL_CHARS[String(opt.detail)] ?? DETAIL_CHARS.med,
  })}`);
}
