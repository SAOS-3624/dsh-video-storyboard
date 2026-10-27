import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  SAMPLE_ABOVE_SEC, scanShotsMaybeSampled, uncoveredGaps,
} from '../src/scan-sampled.js';
import { DEFAULT_FFMPEG } from '../src/probe.js';

const run = promisify(execFile);
let hasFfmpeg = false;
try { await run(DEFAULT_FFMPEG, ['-version']); hasFfmpeg = true; } catch { /* 无 */ }

test('SAMPLE_ABOVE_SEC 默认 ≥1h', () => {
  assert.equal(SAMPLE_ABOVE_SEC, 3600);
});

test('uncoveredGaps: 抽样窗之间的未扫区间', () => {
  const gaps = uncoveredGaps(
    [{ from: 0, to: 30 }, { from: 300, to: 330 }],
    { from: 0, to: 600 },
  );
  assert.deepEqual(gaps, [
    { from: 30, to: 300 },
    { from: 330, to: 600 },
  ]);
});

async function makeFixture(dir) {
  const out = join(dir, 'f.mp4');
  const colors = ['0xff0000', '0x00ff00', '0x0000ff', '0xffff00'];
  const args = ['-hide_banner', '-v', 'error', '-y'];
  for (const c of colors) args.push('-f', 'lavfi', '-i', `color=c=${c}:s=160x90:r=10:d=1`);
  args.push(
    '-filter_complex', `${colors.map((_, i) => `[${i}]`).join('')}concat=n=4:v=1:a=0[v]`,
    '-map', '[v]', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', out,
  );
  await run(DEFAULT_FFMPEG, args);
  return out;
}

test('短窗口不抽样（无 degraded）', async (t) => {
  if (!hasFfmpeg) return t.skip('ffmpeg not on PATH');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-samp-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = await makeFixture(dir);
  const shots = await scanShotsMaybeSampled({
    input: file, fps: 10, threshold: 'auto', start: 0, end: 4,
    sampleAbove: 3600, ffmpegPath: DEFAULT_FFMPEG,
  });
  assert.equal(shots.degraded, undefined);
  assert.ok(shots.cuts.length >= 1);
});

test('强制 sampleAbove 触发 degraded + sample 元数据', async (t) => {
  if (!hasFfmpeg) return t.skip('ffmpeg not on PATH');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-samp-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = await makeFixture(dir);
  const shots = await scanShotsMaybeSampled({
    input: file, fps: 10, threshold: 'auto', start: 0, end: 4,
    sampleAbove: 2, sampleEvery: 1.5, sampleLen: 1.0,
    ffmpegPath: DEFAULT_FFMPEG,
  });
  assert.equal(shots.degraded, true);
  assert.ok(shots.sample);
  assert.ok(shots.sample.windows >= 2);
  assert.ok(shots.sample.coverage_ratio < 1);
  assert.equal(shots.summary.sampled, true);
  assert.ok(Array.isArray(shots.sample.unscanned_gaps));
  assert.ok(shots.sample.unscanned_gap_count >= 1);
});
