/**
 * static-longshot.test.mjs — 切点撑不起密度时，按时间兜底（issue #87）。
 *
 * 病：密度只由切点推。一段 PPT / 课件 / 单机位讲座可能全片只有 1 个切点，于是整段被
 * 当成"一个镜头"，钉死 1 帧/格、一格 40 秒 —— 中间翻过去的页面全看不见，清单也不吭声。
 * 用户实测：164.5 秒的幻灯片讲解只出 4 格，每格 41 秒。
 *
 * 修法：只在"这个窗口 ≤1 个真切点且段长超过 30 秒"时，按时间切开（封顶 8 帧），
 * 并在清单里明说"这段的密度是兜底出来的"。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  STATIC_SHOT_MAX_FRAMES, STATIC_SHOT_MAX_SEC, needsTimeFloor, splitStaticShots,
} from '../src/storyboard/tiers.js';
import { formatManifest, runStoryboard } from '../src/storyboard/pipeline.js';
import { DEFAULT_FFMPEG } from '../src/storyboard/probe.js';

const run = promisify(execFile);
let hasFfmpeg = false;
try { await run(DEFAULT_FFMPEG, ['-version']); hasFfmpeg = true; } catch { /* 无 ffmpeg 就跳过 e2e */ }

// ---- 纯函数 ----

test('needsTimeFloor：只在"几乎没有切点 + 有超长段 + 够长"时生效', () => {
  const long = [{ from: 0, to: 164, cut: false, via: 'start' }];
  assert.equal(needsTimeFloor({ segs: long, duration: 164 }), true, '1 个切点都没有的长片要兜底');

  assert.equal(needsTimeFloor({ segs: long, duration: 40 }), false, '40 秒的短窗口不插手');
  assert.equal(needsTimeFloor({
    segs: [{ from: 0, to: 20, cut: false }, { from: 20, to: 40, cut: false }], duration: 90,
  }), false, '没有超长段就不需要切');

  // 3 个真切点 = 密度算得出来，不插手
  const multi = [
    { from: 0, to: 60, cut: false }, { from: 60, to: 120, cut: true },
    { from: 120, to: 180, cut: true }, { from: 180, to: 240, cut: true },
  ];
  assert.equal(needsTimeFloor({ segs: multi, duration: 240 }), false);
});

test('splitStaticShots：切成 ≤30 秒，不越过封顶，总时长不变', () => {
  const segs = [{ from: 0, to: 164.54, t: 82.27, cut: false, via: 'start' }];
  const out = splitStaticShots(segs);

  assert.ok(out.length > 1, '一整个长镜头要被切开');
  assert.ok(out.length <= STATIC_SHOT_MAX_FRAMES, `帧数 ${out.length} 超了封顶`);
  for (const s of out) {
    assert.ok(s.to - s.from <= STATIC_SHOT_MAX_SEC + 1e-6,
      `段 ${s.from}-${s.to} 还是超过 ${STATIC_SHOT_MAX_SEC}s`);
  }
  const total = out.reduce((n, s) => n + (s.to - s.from), 0);
  assert.ok(Math.abs(total - 164.54) < 1e-6, '切开不能改总时长');
  // 只有第一段继承"这是个切点"的标记，切出来的假边界不能变成切点
  assert.equal(out.filter((s) => s.cut).length, 0);
  assert.ok(out.every((s) => s.via === 'time'));
  // 入参不许被改
  assert.equal(segs.length, 1);
});

test('splitStaticShots：cap 更小时听 cap（调用方给了 maxFrames 就按他的来）', () => {
  const segs = [{ from: 0, to: 600, cut: false }];
  const out = splitStaticShots(segs, { cap: 3 });
  assert.equal(out.length, 3);
  assert.ok(Math.abs(out.reduce((n, s) => n + (s.to - s.from), 0) - 600) < 1e-6);
});

test('splitStaticShots：全是短段时原样返回', () => {
  const segs = [{ from: 0, to: 10 }, { from: 10, to: 20 }];
  const out = splitStaticShots(segs);
  assert.equal(out.length, 2);
  assert.deepEqual(out, segs);
});

// ---- 端到端：一条 100 秒的单镜头片子 ----

async function makeStaticFixture(dir, seconds = 100) {
  const out = join(dir, 'static.mp4');
  await run(DEFAULT_FFMPEG, [
    '-hide_banner', '-v', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=0x2a3b4c:s=320x180:r=5:d=${seconds}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', out,
  ]);
  return out;
}

test('e2e: 无切点的长片按时间兜底，清单里说清楚', async (t) => {
  if (!hasFfmpeg) return t.skip('ffmpeg not on PATH');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-static-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = await makeStaticFixture(dir);

  const r = await runStoryboard({ input: file, encode: false });

  assert.ok(r.plan?.staticLongshot, '100 秒零切点应该标记 staticLongshot');
  assert.ok(r.plan.staticLongshot.frames > 1, '要真的多切几帧出来');

  const cells = r.sheets.flatMap((s) => s.cells);
  assert.ok(cells.length > 1, `只有 ${cells.length} 格 —— 又被当成"一个镜头"了`);

  const text = formatManifest(r, { maxChars: 200_000 });
  assert.match(text, /static-longshot fallback/, '清单要说明这段是兜底采样');
  assert.match(text, /video_zoom/, '要给出"看清某一页"的改法');
});

test('e2e: 多切点的片子不被兜底动到', async (t) => {
  if (!hasFfmpeg) return t.skip('ffmpeg not on PATH');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-static-multi-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const out = join(dir, 'cuts.mp4');
  const args = ['-hide_banner', '-v', 'error', '-y'];
  const colors = ['0xffffff', '0x000000', '0xff0000', '0x00ff00', '0x0000ff', '0xffff00'];
  for (const c of colors) args.push('-f', 'lavfi', '-i', `color=c=${c}:s=320x180:r=5:d=12`);
  args.push(
    '-filter_complex', `${colors.map((_, i) => `[${i}:v]`).join('')}concat=n=${colors.length}:v=1:a=0[v]`,
    '-map', '[v]', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', out,
  );
  await run(DEFAULT_FFMPEG, args);

  const r = await runStoryboard({ input: out, encode: false });
  assert.equal(r.plan?.staticLongshot, undefined, '5 个切点的片子本来就算得出密度，不许兜底');
});
