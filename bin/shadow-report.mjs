#!/usr/bin/env node
/**
 * shadow-report — 把 `shadow-cuts.jsonl` 读成一张表 + 一句结论。
 *
 *   node bin/shadow-report.mjs [--log <path>] [--json] [--montage <dir>] [--max 6]
 *
 * 默认读 `cacheDir()/shadow-cuts.jsonl`（shadow 模式的日志）。
 *
 * `--montage <dir>`：给每条**有分歧**的记录抽几个 `onlyHsv` 点，导出"切点前后各一帧"的
 * 对照图（`<dir>/<素材名>-onlyHsv.png`）。这是判 ">15% 是不是假切点" 的最快办法 ——
 * 闪白/字幕卡/元素进场一眼就能认出来。需要日志里带 `path`（新日志有），旧日志会跳过。
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { args as parse } from './_args.mjs';
import { DEFAULT_FFMPEG } from '../src/storyboard/probe.js';
import { shadowLogPath } from '../src/storyboard/shadow.js';
import { parseShadowLog, summarizeShadow } from '../src/storyboard/shadow-report.js';

const run = promisify(execFile);

/* ------------------------------------------------------------------ 工具 */

/** 终端里中文占两格，按显示宽度补空格才能对齐。 */
const width = (s) => [...String(s)].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2E80 ? 2 : 1), 0);
const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - width(s)));
/** 按**显示宽度**截断：`slice` 数的是字符数，中文名会溢出把整列挤歪。 */
function clip(s, n) {
  let out = '';
  let w = 0;
  for (const ch of String(s)) {
    const cw = ch.charCodeAt(0) > 0x2E80 ? 2 : 1;
    if (w + cw + 2 > n) return `${out}…`;
    out += ch;
    w += cw;
  }
  return out;
}
const pct = (v) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(1)}%`);

const opt = parse(process.argv.slice(2), {
  log: null, json: false, montage: null, max: 6,
});
const logPath = opt.log || shadowLogPath();
if (!existsSync(logPath)) {
  console.error(`没有日志：${logPath}\n（先把 ~/.dsh/video.json 的 sceneDetector 设成 shadow，或加 --log）`);
  process.exit(2);
}

const records = parseShadowLog(await readFile(logPath, 'utf8'));
const summary = summarizeShadow(records);

if (opt.json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(renderTable(summary, { logPath }));
}

if (opt.montage) await writeMontages(summary, records, { dir: String(opt.montage), max: Math.max(1, Number(opt.max) || 6) });

/* ------------------------------------------------------------------ 表格 */

function renderTable(s, { logPath }) {
  const lines = [];
  lines.push(`日志：${logPath}`);
  lines.push('');
  const head = [pad('时间', 17), pad('素材', 24), pad('窗口', 15), pad('hsv', 5), pad('liquid', 7), pad('一致', 5), pad('分歧率', 7), '标记'];
  lines.push(head.join(' '));
  lines.push('-'.repeat(96));
  for (const r of s.rows) {
    const w = r.window?.from !== undefined && r.window?.to !== null
      ? `${Number(r.window.from).toFixed(0)}–${Number(r.window.to).toFixed(0)}s`
      : '—';
    const ts = r.ts ? String(r.ts).slice(5, 19).replace('T', ' ') : '—';
    lines.push([
      pad(ts, 17),
      pad(clip(r.video ?? '—', 24), 24),
      pad(w, 15),
      pad(r.ok ? r.cutsHsv : '—', 5),
      pad(r.ok ? r.cutsLiquid : '—', 7),
      pad(r.ok ? r.agreed : '—', 5),
      pad(r.ok ? pct(r.divergenceRate) : '—', 7),
      r.flags.length ? `! ${r.flags.join(' / ')}` : '',
    ].join(' '));
  }
  lines.push('-'.repeat(96));
  const t = s.totals;
  lines.push(`记录 ${t.records} 条 · 有效 ${t.usable} 条${t.failed ? ` · 失败 ${t.failed} 条` : ''}`);
  lines.push(`加权分歧率 ${pct(t.rate)}（Σhsv ${t.sumHsv} / Σliquid ${t.sumLiquid} / Σ一致 ${t.sumAgreed}）`);
  lines.push(`分布：${Object.entries(s.buckets).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  lines.push('');
  lines.push(`结论〔${s.verdict.level}〕${s.verdict.text}`);
  return lines.join('\n');
}

/* ------------------------------------------------------------------ 抽样图 */

/**
 * 给"有分歧"的记录抽 `onlyHsv` 点，导出前后帧对照图。
 *
 * 为什么只抽 onlyHsv：`>15%` 时最需要回答的问题是"**hsv 多出来的这些刀是不是假切点**"，
 * 而不是"模型漏了什么"（模型漏的通常是它没见过的素材类型，看一张也就知道了）。
 */
async function writeMontages(s, records, { dir, max }) {
  await mkdir(dir, { recursive: true });
  let made = 0;
  for (const row of s.rows) {
    const rec = records.find((x) => x.ts === row.ts && x.video === row.video);
    const only = Array.isArray(rec?.onlyHsv) ? rec.onlyHsv : [];
    const input = rec?.path;
    if (!only.length) continue;
    if (!input || !existsSync(input)) {
      console.log(`[montage] 跳过 ${row.video}：日志里没有可用的 path（旧日志）；用 --log 换新日志或手动抽帧`);
      continue;
    }
    const from = Number(rec.window?.from) || 0;
    const times = only.slice(0, max);
    const tiles = [];
    let k = 0;
    for (const rel of times) {
      k += 1;
      const t = from + Number(rel);
      for (const [suffix, at] of [['a', Math.max(0, t - 0.12)], ['b', t + 0.12]]) {
        const png = join(dir, `.t${k}${suffix}.png`);
        await run(DEFAULT_FFMPEG, [
          '-hide_banner', '-v', 'error', '-y', '-ss', String(at), '-i', input,
          '-frames:v', '1', '-vf', 'scale=480:270', png,
        ]);
        tiles.push(png);
      }
    }
    const out = join(dir, `${String(row.video).replace(/\.[^.]+$/, '')}-onlyHsv.png`);
    const n = times.length;
    const inputs = tiles.flatMap((p) => ['-i', p]);
    /**
     * 拼图：上排=切点前、下排=切点后。
     * `hstack` 的 `inputs` 最小是 2 —— 只有一个点时直接竖着拼，否则 ffmpeg 会报
     * `Value 1 for parameter 'inputs' out of range`。
     */
    const filter = n === 1
      ? '[0][1]vstack=inputs=2[v]'
      : `${tiles.slice(0, n).map((_, i) => `[${i}]`).join('')}hstack=inputs=${n}[t];`
        + `${tiles.slice(n).map((_, i) => `[${n + i}]`).join('')}hstack=inputs=${n}[b];`
        + '[t][b]vstack=inputs=2[v]';
    await run(DEFAULT_FFMPEG, [
      '-hide_banner', '-v', 'error', '-y', ...inputs,
      '-filter_complex', filter, '-map', '[v]', out,
    ]);
    for (const p of tiles) await rm(p, { force: true });
    made += 1;
    console.log(`[montage] ${out}  （${n} 个 onlyHsv 点，上排=切点前 / 下排=切点后）`);
  }
  if (!made) console.log('[montage] 没有可抽的样本（没有 onlyHsv，或日志里没有 path）');
}
