#!/usr/bin/env node
/**
 * scripts/bench.mjs — 在**你自己**的片子上复现 BASELINE.md 那张表。
 *
 * 仓库里没有那四支商业/动画样片，所以别人只能信数字、没法验数字。这个脚本把
 * 成本表拆成三个可测的量：解码扫描（随片长与码率变）、出图（随格数变）、
 * 文本清单（随台词密度变），逐个计时，并顺手给出一次性写清单的字符数。
 *
 *   node scripts/bench.mjs <本地文件 | http(s) 链接> [--json out.json] [--no-zoom]
 *
 * 输出 human 表格 + 可选 JSON（便于贴进 issue 或对比两次改动）。
 */
import { writeFileSync } from 'node:fs';
import { probeVideo } from '../src/probe.js';
import { runStoryboard, formatManifest, formatProbe } from '../src/pipeline.js';

/** BASELINE 里的 "one image = 384 tokens" 是宿主给任何图片结果的固定估价。 */
const TOKENS_PER_IMAGE = 384;
/** 中文正文的经验值：~1.3–1.8 字/token，取中间值估算，仅用于横向比较。 */
const CHARS_PER_TOKEN = 1.5;

const argv = process.argv.slice(2);
const input = argv.find((a) => !a.startsWith('--'));
const jsonOut = (() => {
  const i = argv.indexOf('--json');
  return i >= 0 ? argv[i + 1] : null;
})();
const withZoom = !argv.includes('--no-zoom');

if (!input) {
  console.error('usage: node scripts/bench.mjs <video|url> [--json out.json] [--no-zoom]');
  process.exit(2);
}

const ms = (t0) => Math.round((Number(process.hrtime.bigint() - t0) / 1e6) * 10) / 10;
const hrtime = () => process.hrtime.bigint();
const fmt = (n) => (Number.isFinite(n) ? n.toLocaleString('en-US') : '—');

const rows = [];
const record = (what, took, detail) => {
  rows.push({ what, ms: took, detail });
  console.log(`${what.padEnd(26)} ${String(took).padStart(9)} ms   ${detail}`);
};

console.log(`\n# ${input}`);
const tProbe = hrtime();
const info = await probeVideo(input);
record('probe (header only)', ms(tProbe), `duration=${info.duration}s  ${info.width}x${info.height}  ${info.fps}fps`);

const tScan = hrtime();
const result = await runStoryboard({ input });
const scanMs = ms(tScan);

const sheets = result.sheets ?? [];
const cells = sheets.reduce((n, s) => n + (s.cells?.length ?? 0), 0);
const pngBytes = sheets.reduce((n, s) => n + (s.buffer?.length ?? 0), 0);
const cuts = result.cuts?.length ?? result.window?.cuts ?? 0;
const dur = result.window?.duration ?? info.duration;
record('storyboard (whole file)', scanMs,
  `${sheets.length} sheet(s) / ${cells} cells / ${cuts} cuts / ${(pngBytes / 1024).toFixed(0)} KB png`);

// 第二次调用走缓存 —— 这就是"翻页看细节"的真实成本。
const tAgain = hrtime();
const again = await runStoryboard({ input, textOnly: true }).catch(() => null);
const againMs = ms(tAgain);
if (again) {
  const chars = formatManifest(again).length;
  record('storyboard again (cached)', againMs, `textOnly, ${fmt(chars)} chars`);
}

if (withZoom && dur > 6) {
  const from = Math.max(0, Math.min(dur / 2, dur - 6));
  const tZoom = hrtime();
  const zoom = await runStoryboard({ input, from, to: from + 6, cells: 6 });
  record('zoom (6 s window, 6 cells)', ms(tZoom),
    `${zoom.sheets?.[0]?.cellW ?? '?'}x${zoom.sheets?.[0]?.cellH ?? '?'} per cell`);
}

const manifestChars = formatManifest(result).length;
const imageTokens = sheets.length * TOKENS_PER_IMAGE;
const textTokens = Math.ceil(manifestChars / CHARS_PER_TOKEN);

console.log('\n## cost per call (this file)');
console.log(`| what | measured |`);
console.log(`|---|---|`);
console.log(`| one image | ${TOKENS_PER_IMAGE} tokens (host estimate, independent of cell count) |`);
console.log(`| images this call | ${sheets.length} → **${imageTokens} tokens** |`);
console.log(`| text index | ${fmt(manifestChars)} chars ≈ ${fmt(textTokens)} tokens (÷${CHARS_PER_TOKEN}, rough) |`);
console.log(`| total, first call | ≈ **${fmt(imageTokens + textTokens)} tokens** |`);
console.log(`| scan throughput | ${(dur / (scanMs / 1000)).toFixed(1)}× realtime |`);

if (jsonOut) {
  writeFileSync(jsonOut, `${JSON.stringify({
    input,
    probe: { ms: rows[0].ms, duration: info.duration, width: info.width, height: info.height, fps: info.fps },
    storyboard: { ms: scanMs, sheets: sheets.length, cells, cuts, pngBytes },
    cachedAgain: again ? { ms: againMs } : null,
    manifestChars,
    tokens: { perImage: TOKENS_PER_IMAGE, images: imageTokens, text: textTokens },
    rows,
    probeText: formatProbe(info),
  }, null, 2)}\n`);
  console.log(`\njson -> ${jsonOut}`);
}
