import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  analyzeAudio, detectOnsets, detectSilence, measureLoudness, parseSilenceLog,
} from '../src/audio.js';
import { alignCells, parseSrt, speechCurve } from '../src/asr.js';
import { DEFAULT_FFMPEG } from '../src/probe.js';
import { addAudioStrip, composeSheet, layoutCanvas, STRIP_BAR, STRIP_SEP } from '../src/sheet.js';

const run = promisify(execFile);
let hasFfmpeg = false;
try { await run(DEFAULT_FFMPEG, ['-version']); hasFfmpeg = true; } catch { /* 无 */ }

/* ---------------------------------------------------------------- SRT */

const SRT = `1
00:00:01,000 --> 00:00:03,500
第一句台词

2
00:00:04,000 --> 00:00:06,000
第二句
跨行的话

`;

test('parseSrt: 时间码与多行正文', () => {
  const segs = parseSrt(SRT);
  assert.equal(segs.length, 2);
  assert.deepEqual(segs[0], { from: 1, to: 3.5, text: '第一句台词' });
  assert.equal(segs[1].text, '第二句 跨行的话');
});

test('parseSrt: 空文本不返回', () => {
  assert.deepEqual(parseSrt('1\n00:00:01,000 --> 00:00:02,000\n\n'), []);
});

/* ---------------------------------------------------------------- 对齐 */

test('alignCells: 一句跨两格时两边都保留，并给出字数速率', () => {
  const cells = [{ from: 0, to: 3 }, { from: 3, to: 6 }];
  const segs = [{ from: 2, to: 4, text: '跨格的一句' }];
  const out = alignCells(cells, segs);
  assert.equal(out[0].text, '跨格的一句');
  assert.equal(out[1].text, '跨格的一句');
  assert.equal(out[0].chars, 5);
  assert.ok(out[0].charsPerSec > 1);
});

test('alignCells: 没台词的格子 text 为空（不是 undefined）', () => {
  const out = alignCells([{ from: 0, to: 2 }], []);
  assert.equal(out[0].text, '');
  assert.equal(out[0].chars, 0);
});

test('speechCurve: 有台词处曲线更高', () => {
  const { curve, mean } = speechCurve(
    [{ from: 0, to: 2, text: '一二三四五六七八九十' }, { from: 8, to: 10, text: '一二三四五六七八九十' }],
    { duration: 10 },
  );
  assert.ok(mean > 0);
  assert.equal(curve[50], 0, '第 5 秒没有台词');       // bin = 0.1s，索引 = 秒 × 10
  assert.ok(curve[10] > 0, '第 1 秒有台词');
  assert.ok(curve[10] > curve[50], '有台词处必须高于无台词处');
});

test('speechCurve: 没有台词时 mean=0（不会污染密度）', () => {
  const { mean } = speechCurve([], { duration: 10 });
  assert.equal(mean, 0);
});

/* ---------------------------------------------------------------- 条带绘制 */

test('addAudioStrip: 画布变高，顶部内容不变，条带里有色块', () => {
  const { cellW, cellH } = layoutCanvas(2, 2, 16 / 9, 80_000);
  const sheet = composeSheet({
    frames: [{ buffer: Buffer.alloc(cellW * cellH * 3, 200), index: 1 }],
    cols: 2, rows: 2, cellAspect: 16 / 9, budget: 80_000,
  });
  const solid = 40;
  const loudness = { series: Array.from({ length: solid }, (_, i) => -40 + (i % 10) * 2), step: 0.1 };
  const out = addAudioStrip(sheet, {
    loudness, silences: [{ from: 1, to: 2 }], cuts: [0.5, 1.5],
    window: { from: 0, to: 4 }, stripH: 20,
  });
  assert.equal(out.height, sheet.height + 20);
  assert.equal(out.buffer.length, out.width * out.height * 3);
  // 顶部像素原样保留
  assert.deepEqual([...out.buffer.subarray(0, 3)], [...sheet.buffer.subarray(0, 3)]);
  // 条带里应有青色条
  let teal = 0;
  let sep = 0;
  for (let y = sheet.height; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      const i = (y * out.width + x) * 3;
      if (out.buffer[i] === STRIP_BAR[0] && out.buffer[i + 1] === STRIP_BAR[1]) teal++;
      if (y === sheet.height && out.buffer[i] === STRIP_SEP[0]) sep++;
    }
  }
  assert.ok(teal > 100, `条带里应有青色响度条，实得 ${teal}`);
  assert.ok(sep > out.width * 0.9, '顶部应有分隔线');
});

/* ---------------------------------------------------------------- e2e（真 ffmpeg） */

async function makeAudioFixture(dir) {
  const out = join(dir, 'a.m4a');
  await run(DEFAULT_FFMPEG, ['-hide_banner', '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono:duration=1.5',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-filter_complex', '[0][1][2]concat=n=3:v=0:a=1[a]', '-map', '[a]',
    '-c:a', 'aac', out]);
  return out;
}

test('e2e: 从音频里量出响度与静音段', async (t) => {
  if (!hasFfmpeg) return t.skip('ffmpeg not on PATH');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-audio-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = await makeAudioFixture(dir);

  const loud = await measureLoudness({ input: file });
  assert.ok(loud.samples > 40, `应有足够采样点，实得 ${loud.samples}`);
  assert.ok(loud.mean > -40 && loud.mean < 0, `平均响度 ${loud.mean}`);

  const sil = await detectSilence({ input: file, noise: -40, minDur: 0.6 });
  assert.equal(sil.length, 1, `应找到 1 段静音，实得 ${JSON.stringify(sil)}`);
  assert.ok(sil[0].from > 1.5 && sil[0].from < 2.5, `静音起点 ${sil[0].from}`);
  assert.ok(sil[0].to > 3.0 && sil[0].to < 4.0, `静音终点 ${sil[0].to}`);

  const audio = await analyzeAudio({ input: file });
  assert.equal(audio.source, 'ebur128');
  assert.equal(audio.silences.length, 1);
});

/* ---------------------------------------------------------------- 声音事件 */

/** 造一条 10 秒 100ms 的响度序列：2–4s 突然变响，7s 突然变安静 */
function fakeLoudness() {
  const series = [];
  for (let i = 0; i < 100; i++) {
    const t = i / 10;
    let v = -30;
    if (t >= 2 && t < 4) v = -15;      // 突然 +15dB
    if (t >= 4 && t < 7) v = -28;
    if (t >= 7) v = -70;               // 跌到静音
    series.push(v);
  }
  return { series, step: 0.1 };
}

test('parseSilenceLog: 缺 silence_end 时不把 start 加两遍', () => {
  const log = 'silence_start: 1.20\nsilence_end: 2.50\nsilence_start: 4.00\n';
  const full = parseSilenceLog(log, { start: 600, end: 650, minDur: 0.6 });
  assert.equal(full.length, 2);
  assert.deepEqual(full[0], { from: 601.2, to: 602.5 });
  // 缺 end：截到窗口终点，而不是 2*start + …
  assert.deepEqual(full[1], { from: 604, to: 650 });

  // from = 1 + 100 = 101；缺 end → from + minDur = 101.6（绝不是 201.6）
  const noWindow = parseSilenceLog('silence_start: 1.00\n', { start: 100, minDur: 0.6 });
  assert.deepEqual(noWindow, [{ from: 101, to: 101.6 }]);
});

test('detectOnsets: offset 平移成绝对时间', () => {
  const ev = detectOnsets(fakeLoudness(), { offset: 600 });
  const rise = ev.find((e) => e.kind === 'rise');
  assert.ok(rise && Math.abs(rise.t - 602) < 0.7, `rise 应在 602 附近，实得 ${rise?.t}`);
});

test('detectOnsets: 抓到突然变响与突然安静', () => {
  const ev = detectOnsets(fakeLoudness());
  assert.ok(ev.length >= 2, `应至少两个事件，实得 ${JSON.stringify(ev)}`);
  const rise = ev.find((e) => e.kind === 'rise');
  assert.ok(rise && Math.abs(rise.t - 2) < 0.7, `rise 应落在 2s 附近，实得 ${rise?.t}`);
  assert.ok(rise.delta >= 6);
  // 这条序列里有两个 drop（4s 从 -15 掉到 -28，7s 掉进静音），两个都算对
  const dropAt7 = ev.find((e) => e.kind === 'drop' && Math.abs(e.t - 7) < 0.7);
  assert.ok(dropAt7, `7s 附近应有一个 drop，实得 ${JSON.stringify(ev)}`);
  assert.ok(dropAt7.delta <= -12);
});

test('detectOnsets: 平稳音频不出事件', () => {
  const flat = { series: Array(100).fill(-25), step: 0.1 };
  assert.deepEqual(detectOnsets(flat), []);
});

test('detectOnsets: 相邻事件合并（不把渐强拆成一串）', () => {
  const series = Array.from({ length: 60 }, (_, i) => (i < 10 ? -40 : -20 + (i % 3)));
  const ev = detectOnsets({ series, step: 0.1 }, { minGap: 1.5 });
  const gaps = ev.slice(1).map((e, i) => e.t - ev[i].t);
  for (const g of gaps) assert.ok(g >= 1.5, `事件间隔应 ≥ minGap，实得 ${g}`);
});

test('detectOnsets: 空输入不炸', () => {
  assert.deepEqual(detectOnsets({ series: [], step: 0.1 }), []);
  assert.deepEqual(detectOnsets(undefined), []);
});
