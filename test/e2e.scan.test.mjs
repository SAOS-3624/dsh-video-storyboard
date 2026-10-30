import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { DEFAULT_FFMPEG, probeVideo } from '../src/storyboard/probe.js';
import { scanShots } from '../src/storyboard/scan.js';
import { segmentsFromCuts } from '../src/storyboard/segments.js';

const run = promisify(execFile);

let hasFfmpeg = false;
try {
  await run(DEFAULT_FFMPEG, ['-version']);
  hasFfmpeg = true;
} catch {
  hasFfmpeg = false;
}

const COLORS = ['0xff0000', '0x00ff00', '0x0000ff', '0xffff00', '0xff00ff'];

/** 现造测试片：5 个纯色镜头各 1s。仓库里不放二进制。 */
async function makeColorFixture(dir, colors = COLORS, dur = 1) {
  const out = join(dir, 'fixture.mp4');
  const args = ['-hide_banner', '-v', 'error', '-y'];
  for (const c of colors) args.push('-f', 'lavfi', '-i', `color=c=${c}:s=320x180:r=25:d=${dur}`);
  args.push(
    '-filter_complex', `${colors.map((_, i) => `[${i}]`).join('')}concat=n=${colors.length}:v=1:a=0[v]`,
    '-map', '[v]', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', out,
  );
  await run(DEFAULT_FFMPEG, args);
  return out;
}

async function withFixture(t, fn, opts) {
  if (!hasFfmpeg) {
    t.skip('ffmpeg not on PATH');
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), 'dsh-scan-'));
  try {
    const file = await makeColorFixture(dir, opts?.colors, opts?.dur);
    await fn(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('e2e: 5 个纯色镜头 → 4 个切点，零误检，分离度足够', async (t) => {
  await withFixture(t, async (file) => {
    const info = await probeVideo(file);
    assert.ok(Math.abs(info.duration - 5) < 0.2, `duration=${info.duration}`);
    assert.equal(info.width, 320);
    assert.equal(info.height, 180);
    assert.equal(info.hasAudio, false);

    const { cuts, stats, frames } = await scanShots({ input: file, fps: info.fps });
    assert.ok(frames >= 120 && frames <= 130, `frames=${frames}`);
    assert.equal(cuts.length, 4, `切点数 ${cuts.length}：${JSON.stringify(cuts)}`);

    const expected = [1, 2, 3, 4];
    cuts.forEach((c, i) => {
      assert.ok(Math.abs(c.t - expected[i]) < 0.12, `第 ${i + 1} 个切点 ${c.t} 偏离 ${expected[i]}`);
    });

    // 切点分数必须明显高于背景帧，否则说明阈值只是"刚刚好"，换素材就崩
    const isCut = (s) => cuts.some((c) => Math.abs(c.t - s.t) < 1e-9);
    const bgMax = Math.max(...stats.filter((s) => !isCut(s)).map((s) => s.score));
    const cutMin = Math.min(...cuts.map((c) => c.score));
    assert.ok(cutMin > bgMax * 2, `分离度不足：cutMin=${cutMin.toFixed(1)} bgMax=${bgMax.toFixed(1)}`);
  });
});

test('e2e: 单色视频零切点（不误检）', async (t) => {
  await withFixture(t, async (file) => {
    const info = await probeVideo(file);
    const { cuts } = await scanShots({ input: file, fps: info.fps });
    assert.deepEqual(cuts, []);
  }, { colors: ['0x336699'], dur: 3 });
});

test('e2e: 切点串起来后，段与段首尾相接、总时长不变', async (t) => {
  await withFixture(t, async (file) => {
    const info = await probeVideo(file);
    const { cuts } = await scanShots({ input: file, fps: info.fps });
    const segs = segmentsFromCuts(info.duration, cuts.map((c) => c.t));
    assert.equal(segs.length, 5, '5 个镜头应得 5 段');
    assert.equal(segs[0][0], 0);
    assert.ok(Math.abs(segs.at(-1)[1] - info.duration) < 1e-6);
    for (let i = 1; i < segs.length; i++) assert.equal(segs[i][0], segs[i - 1][1]);
    // 每段应接近 1s（等长镜头）
    for (const s of segs) assert.ok(Math.abs(s[1] - s[0] - 1) < 0.15, `段长 ${(s[1] - s[0]).toFixed(2)}`);
  });
});

test('e2e: threshold="auto" 也能拿到同一组切点，并回报实际用的阈值', async (t) => {
  await withFixture(t, async (file) => {
    const info = await probeVideo(file);
    const auto = await scanShots({ input: file, fps: info.fps, threshold: 'auto' });
    assert.equal(auto.cuts.length, 4, `auto 模式切点数 ${auto.cuts.length}`);
    assert.ok(auto.threshold >= 12 && auto.threshold <= 60, `阈值 ${auto.threshold}`);
    const fixed = await scanShots({ input: file, fps: info.fps, threshold: 15 });
    assert.deepEqual(auto.cuts.map((c) => c.t), fixed.cuts.map((c) => c.t), 'auto 与手动应一致（该片噪声极低）');
  });
});

test('scanShots: fps 非法时立刻抛错（不会白跑一遍解码）', () => {
  assert.throws(() => scanShots({ input: 'x.mp4', fps: 0 }), RangeError);
});

test('scanShots: 文件不存在时给出可读错误', async (t) => {
  if (!hasFfmpeg) return t.skip('ffmpeg not on PATH');
  await assert.rejects(
    () => scanShots({ input: join(tmpdir(), 'definitely-not-here-9f2a.mp4'), fps: 25 }),
    /ffmpeg exited/,
  );
});
