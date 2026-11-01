#!/usr/bin/env node
/**
 * storyboard — CLI 薄壳，真正的逻辑全在 src/storyboard/pipeline.js（与 DSH 工具同一份实现）。
 *
 *   node bin/storyboard.mjs <video> [--frames N] [--max-sheets N] [--strategy full|standard|compact|skim|brief]
 *                                   [--from 0] [--to 300] [--segment 300] [--budget 640000]
 *                                   [--pick sharp|mid|thumb] [--burn index|none]
 *                                   [--threshold auto|15] [--scan-gap 0]
 *                                   [--transcript auto|off] [--detail low|med|high]
 *                                   [--out sheet.png] [--manifest m.json] [--plan 300] [--text]
 */
import { writeFile } from 'node:fs/promises';

import { args as parse } from './_args.mjs';
import { probeVideo } from '../src/storyboard/probe.js';
import { planWindows } from '../src/storyboard/plan.js';
import { isHttpUrl } from '../src/storyboard/url.js';
import { resolveInput } from '../src/storyboard/fetch.js';
import {
  DETAIL_CHARS, formatManifest, formatPlanPreview, formatTimeline, runStoryboard, saveStoryboards,
} from '../src/storyboard/pipeline.js';
import { boardGeometry } from '../src/storyboard/board.js';
import { cliOcr, manifestFromCli, runOptionsFromCli } from '../src/storyboard/cli-options.js';

const opt = parse(process.argv.slice(2), {
  frames: 0, 'max-frames': 0, 'max-sheets': 0, 'tier-map': null, from: 0, to: 0, threshold: 'auto',
  'scan-gap': 0, integral: null, 'integral-seconds': 0,
  strategy: null, pick: 'mid', burn: 'index', transcript: 'auto',
  out: 'storyboard.png', manifest: null, plan: 0, 'text-only': false, 'cell-range': null,
  // 只预演：回报切点数与每档要几张图，不出图（与工具的 dryRun 同一条路径）
  'dry-run': false,
  batch: 0, detail: 'med',
  // scan-height 默认 0 = 按格子最大尺寸推（1 档整幅 800×450，720p 已是 2.5 倍超采样）
  cookies: null, 'allow-anonymous': false, 'scan-height': 0, 'zoom-height': 1080,
  'transcript-file': null, 'source-hash': false, quality: 'medium',
});
const input = opt._[0];
// 不认识的开关要喊一声：0.6 删了 --cells / --sheets / --need，而外面的教程、脚本还是老写法，
// 静默忽略会让人以为参数生效了（"我明明写了 --cells 9，怎么格子数还是 auto 挑的"）。
if (opt.$unknown?.length) {
  console.error(`[warn] 未识别的参数：${opt.$unknown.map((k) => `--${k}`).join(' ')}（已忽略）。`
    + ' 0.6 起没有 --cells/--sheets/--need，改用 --frames N / --strategy auto|compact|standard|skim|full，'
    + '先加 --dry-run 可以只报代价不出图。');
}
if (!input) {
  console.error('usage: node bin/storyboard.mjs <video-or-url> [--frames N] [--max-sheets N] [--from 0] [--to 300] ...');
  process.exit(2);
}

// 链接：先换成本地文件（本地路径原样返回）。下载一次低清，后面都是本地操作。
const fetchOptions = {
  cookies: opt.cookies ?? undefined,
  allowAnonymous: opt['allow-anonymous'] === true,
  // 扫描副本只要覆盖最大格子（800×450）就够了，1080p 是浪费带宽
  scanHeight: Number(opt['scan-height'])
    || (opt.quality === 'low' ? 360 : opt.quality === 'high' ? 1080 : 720),
  zoomHeight: Number(opt['zoom-height']) || 1080,
};
let localPath = input;
let sourceInfo = null;
if (isHttpUrl(input)) {
  try {
    const resolved = await resolveInput(input, fetchOptions);
    localPath = resolved.path;
    sourceInfo = resolved.source;
    console.error(`[fetch] ${sourceInfo.cached ? 'cached' : 'downloaded'} ${(sourceInfo.bytes / 1048576).toFixed(1)}MB ` +
      `→ ${sourceInfo.scanActual ?? '?'}p (source max ${sourceInfo.maxAvailable ?? '?'}p, auth=${sourceInfo.auth})`);
  } catch (error) {
    console.error(`取流失败：${error.message}`);
    process.exit(1);
  }
}

const info = await probeVideo(localPath).catch((error) => {
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
      `(${w.duration.toFixed(0)}s)  实际帧数由切点决定  ≈${w.approxTokens} tok`);
  }
  console.log('\n逐段跑：node bin/storyboard.mjs <video> --from A --to B');
  process.exit(0);
}

// --batch <秒>：把整片按固定步长切成若干窗口，逐个出图，最后写一张时间线表。
// 一部 2 小时半的电影手工敲 24 次 --from/--to 不现实，这是给长片用的入口。
const batchStep = Number(opt.batch) || 0;
if (batchStep > 0) {
  // 先全片扫一遍拿切点，让窗口边界落在剪辑点上（而不是钟表上）。
  let boundaries = [];
  let precomputed = null;
  if (opt.snap !== false) {
    const { scanShots } = await import('../src/storyboard/scan.js');
    console.log('[batch] 全片扫描切点（用于窗口对齐，可加 --no-snap 跳过）…');
    precomputed = await scanShots({ input: localPath, fps: info.fps, threshold: 'auto' });
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
      input: localPath, from: w.from, to: w.to,
      threshold: opt.threshold === 'auto' ? 'auto' : Number(opt.threshold),
      maxFrames: Number(opt.frames) || 96,
      strategy: opt.strategy ?? undefined,
      pick: String(opt.pick), burn: String(opt.burn), transcript: String(opt.transcript),
      ocr: cliOcr(opt),
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
      `${cells.length} 帧 ${r.plan.sheets} 张  → ${image}  (${Date.now() - t0}ms)`);
  }
  const md = formatTimeline(rows, { title: `${info.path ?? input} — ${planW.total} windows @ ${batchStep}s` });
  const mdPath = `${base}-timeline.md`;
  await writeFile(mdPath, `${md}\n`, 'utf8');
  console.log(`\n${md}`);
  console.log(`[batch] 汇总写入 ${mdPath}  总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  process.exit(0);
}

const textOnly = Boolean(opt['text-only']);
const cellRange = (() => {
  const raw = opt['cell-range'];
  if (!raw) return null;
  const m = String(raw).match(/^(\d+)-(\d+)$/);
  return m ? [Number(m[1]), Number(m[2])] : null;
})();
const t0 = Date.now();
const geom = boardGeometry(opt);
const r = await runStoryboard(runOptionsFromCli({
  opt,
  geom,
  input,
  fetchOptions,
  textOnly,
}));

console.log(`[probe] ${info.width}x${info.height} ${info.fps.toFixed(2)}fps ${info.duration.toFixed(2)}s` +
  `${info.hasAudio ? ' audio' : ''}${info.hasSubtitle ? ' subtitle' : ''}` +
  (r.window.from > 0 || r.window.to < info.duration
    ? `  window=${r.window.from.toFixed(1)}..${r.window.to.toFixed(1)}s` : ''));
const tierText = Object.entries(r.plan.tiers ?? {})
  .sort((a, b) => Number(a[0]) - Number(b[0]))
  .map(([k, v]) => `1/${k}×${v}`).join(' ');
console.log(`[scan] ${r.summary.frames} 帧 → ${r.cuts.length} 个切点（阈值 ${r.threshold}）`);
console.log(`[plan] ${r.plan.produced} 帧 → ${r.plan.sheets} 张（策略 ${r.plan.strategy}，档位 ${tierText}，` +
  `积分点 ${r.plan.sampleMarks}，占用 ${r.plan.fill}%）`);
if (r.audio) console.log(`[audio] ${r.audio.summary}`);
if (r.transcript) {
  console.log(`[transcript] ${r.transcript.source}${r.transcript.model ? ` (${r.transcript.model})` : ''}` +
    `${r.transcript.segments ? `，${r.transcript.segments} 段` : ''}` +
    `${r.transcript.error ? `  ⚠️ ${r.transcript.error}` : ''}`);
}

// 预演：一张图都没有，直接打文本走人（--out 不写文件，避免留下半个结果）
if (r.planOnly) {
  console.log(`\n${formatPlanPreview(r)}`);
  process.exit(0);
}

const paths = await saveStoryboards(r, opt.out, { quality: 4 });
for (const [i, sheet] of r.sheets.entries()) {
  console.log(`[sheet] ${paths[i]}  ${sheet.width}x${sheet.height}  ${sheet.cells.length} 帧` +
    `  cell>=${sheet.cellW}x${sheet.cellH}${sheet.stripH ? `  strip=${sheet.stripH}px` : ''}`);
}
console.log(`[done] ${Date.now() - t0}ms`);

if (opt.manifest) {
  const payload = manifestFromCli({ input, r });
  await writeFile(opt.manifest, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`[manifest] ${opt.manifest}`);
}

if (opt.text) {
  console.log(`\n${formatManifest(r, {
    cellRange, maxCellChars: DETAIL_CHARS[String(opt.detail)] ?? DETAIL_CHARS.med,
  })}`);
}
