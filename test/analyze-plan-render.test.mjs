/**
 * 分析 / 规划 / 出图三阶段解耦的回归：同一份 VAA 可反复规划，换参数不重扫。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { analyzeVideo } from '../src/analyze.js';
import { planStoryboard } from '../src/plan-storyboard.js';
import { materializeTextCells, renderStoryboard } from '../src/render.js';
import { runStoryboard } from '../src/pipeline.js';
import { artifactKey } from '../src/cache.js';
import { clearAnalysisStore, putAnalysis } from '../src/vaa-store.js';
import { DEFAULT_FFMPEG } from '../src/probe.js';

const run = promisify(execFile);
let hasFfmpeg = false;
try { await run(DEFAULT_FFMPEG, ['-version']); hasFfmpeg = true; } catch { /* 无 */ }

async function makeFixture(dir) {
  const out = join(dir, 'f.mp4');
  const colors = ['0xff0000', '0x00ff00', '0x0000ff', '0xffff00'];
  const args = ['-hide_banner', '-v', 'error', '-y'];
  for (const c of colors) args.push('-f', 'lavfi', '-i', `color=c=${c}:s=320x180:r=25:d=1`);
  args.push(
    '-filter_complex', `${colors.map((_, i) => `[${i}]`).join('')}concat=n=4:v=1:a=0[v]`,
    '-map', '[v]', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', out,
  );
  await run(DEFAULT_FFMPEG, args);
  return out;
}

test('artifactKey: 同文件不同 kind / 参数 → 不同键', async (t) => {
  if (!hasFfmpeg) return t.skip('ffmpeg not on PATH');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-vaa-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = await makeFixture(dir);
  const a = await artifactKey({ input: file, kind: 'shots', start: 0, end: 4, params: { threshold: 'auto' } });
  const b = await artifactKey({ input: file, kind: 'audio', start: 0, end: 4, params: { threshold: 'auto' } });
  const c = await artifactKey({ input: file, kind: 'shots', start: 0, end: 4, params: { threshold: 12 } });
  assert.ok(a && b && c);
  assert.notEqual(a, b);
  assert.notEqual(a, c);
});

test('三阶段：analyze 一次，plan 两次参数不同，cell_id 稳定且可复用 analysis', async (t) => {
  if (!hasFfmpeg) return t.skip('ffmpeg not on PATH');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-vaa-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = await makeFixture(dir);

  const analysis = await analyzeVideo({
    input: file, transcript: 'off', wantAudio: false, cache: false, fingerprints: false,
  });
  assert.equal(analysis.schema_version, 1);
  assert.ok(analysis.shots.cuts.length >= 2, '应有切点');
  assert.ok(analysis.timing.shot_scan_ms >= 0);

  const planA = planStoryboard(analysis, { cells: 4, sheets: 1, adaptive: true });
  assert.equal(planA.cells_meta.length, 4);
  assert.equal(planA.cells_meta[0].cell_id, 'cell_0001');
  assert.ok(Number.isInteger(planA.cells_meta[0].start_ms));

  const planB = planStoryboard(analysis, { cells: 2, sheets: 1, adaptive: false, minGap: 0.4 });
  assert.equal(planB.cells_meta.length, 2);
  assert.notEqual(planA.plan_id, planB.plan_id);

  const textCells = materializeTextCells(analysis, planA);
  assert.equal(textCells.length, 4);
  assert.equal(textCells[0].cell_id, 'cell_0001');

  const rendered = await renderStoryboard(file, analysis, planA, { encode: false, audioStrip: false });
  assert.equal(rendered.sheets.length, 1);
  assert.equal(rendered.sheets[0].cells[0].cell_id, 'cell_0001');
});

test('runStoryboard 接受注入的 analysis，不再二次扫描', async (t) => {
  if (!hasFfmpeg) return t.skip('ffmpeg not on PATH');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-vaa-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = await makeFixture(dir);

  const analysis = await analyzeVideo({
    input: file, transcript: 'off', wantAudio: false, cache: false, fingerprints: false,
  });
  // 污染切点：若管线自己又扫一遍，会找回真实切点
  const poisoned = {
    ...analysis,
    shots: { ...analysis.shots, cuts: [{ t: 99 }], summary: { frames: 0, p90: 0 }, cached: false },
  };
  const r = await runStoryboard({
    input: file, cells: 2, transcript: 'off', encode: false,
    analysis: poisoned, adaptive: false,
  });
  assert.equal(r.cuts.length, 1);
  assert.equal(r.cuts[0].t, 99);
  assert.ok(r.plan.plan_id);
  assert.ok(r.timing);
});

test('zoom 子窗口切片复用父 VAA（不重扫）', async (t) => {
  if (!hasFfmpeg) return t.skip('ffmpeg not on PATH');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-vaa-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = await makeFixture(dir);
  clearAnalysisStore();

  const parent = await analyzeVideo({
    input: file, transcript: 'off', wantAudio: false, cache: false, fingerprints: false,
  });
  // 污染：若 zoom 重扫会丢掉假切点
  parent.shots = {
    ...parent.shots,
    cuts: [{ t: 0.5 }, { t: 1.5 }, { t: 2.5 }, { t: 3.5 }],
    summary: { frames: 0, p90: 0 },
  };
  const key = await putAnalysis(parent);
  assert.ok(key);

  const z = await runStoryboard({
    input: file, from: 1, to: 3, cells: 2, sheets: 1,
    transcript: 'off', encode: false, audioStrip: false,
    reuseAnalysis: true, adaptive: false, zoomMode: 'temporal',
  });
  assert.ok(z.analysis.shots.sliced || z.analysis.cache_hits?.includes('slice'));
  assert.ok(z.analysis.shots.cuts.every((c) => c.t >= 1 && c.t < 3));
  assert.equal(z.window.from, 1);
  assert.equal(z.plan.zoomMode, 'temporal');
});
