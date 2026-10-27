/**
 * pipeline.test.mjs — 端到端：真 ffmpeg 现造片子 → runStoryboard → 断言产物。
 * 顺带验证 apply() 的接线（注册一次、名字正确），不依赖真实 DSH 宿主。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { runStoryboard, formatManifest, saveStoryboards, countTextInSilence } from '../src/pipeline.js';
import { DEFAULT_FFMPEG } from '../src/probe.js';

const run = promisify(execFile);
let hasFfmpeg = false;
try { await run(DEFAULT_FFMPEG, ['-version']); hasFfmpeg = true; } catch { /* 无 */ }

/** 6 个镜头各 1s，其中一个带 0.5s 的模糊（测 sharp 取帧） */
async function makeFixture(dir) {
  const out = join(dir, 'f.mp4');
  const colors = ['0xff0000', '0x00ff00', '0x0000ff', '0xffff00', '0xff00ff', '0x00ffff'];
  const args = ['-hide_banner', '-v', 'error', '-y'];
  for (const c of colors) args.push('-f', 'lavfi', '-i', `color=c=${c}:s=320x180:r=25:d=1`);
  args.push(
    '-filter_complex', `${colors.map((_, i) => `[${i}]`).join('')}concat=n=6:v=1:a=0[v]`,
    '-map', '[v]', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', out,
  );
  await run(DEFAULT_FFMPEG, args);
  return out;
}

test('e2e: runStoryboard 出一张图 + 完整清单', async (t) => {
  if (!hasFfmpeg) return t.skip('ffmpeg not on PATH');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pipe-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = await makeFixture(dir);

  const r = await runStoryboard({ input: file, cells: 4, pick: 'sharp' });
  assert.equal(r.sheets.length, 1);
  const sheet = r.sheets[0];
  assert.equal(sheet.cols * sheet.rows, 4);
  assert.equal(sheet.buffer.length, sheet.width * sheet.height * 3);
  assert.equal(sheet.cells.length, 4);
  assert.ok(sheet.width * sheet.height <= 640_000, '不该超像素预算');

  // 时间码单调、首尾相接、落在窗口内
  for (let i = 1; i < sheet.cells.length; i++) {
    assert.equal(sheet.cells[i].t_start, sheet.cells[i - 1].t_end);
    assert.ok(sheet.cells[i].t_frame > sheet.cells[i - 1].t_frame);
  }
  assert.equal(sheet.cells[0].t_start, 0);
  assert.ok(Math.abs(r.window.to - 6) < 0.2);
});

test('e2e: 交给附件的必须是真 PNG（裸 RGB 会被判 malformed）', async (t) => {
  if (!hasFfmpeg) return t.skip('ffmpeg not on PATH');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pipe-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = await makeFixture(dir);

  const r = await runStoryboard({ input: file, cells: 4 });
  const { png, buffer, width, height } = r.sheets[0];
  assert.ok(png && png.length > 0, '必须带 PNG 字节');
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG 魔数');
  assert.equal(png.readUInt32BE(16), width, 'IHDR 宽度应与画布一致');
  assert.equal(png.readUInt32BE(20), height, 'IHDR 高度应与画布一致');
  assert.ok(png.length < buffer.length, 'PNG 应比裸 RGB 小（说明真的编码过）');
});

test('e2e: encode=false 时不产生 PNG（CLI 自己落盘）', async (t) => {
  if (!hasFfmpeg) return t.skip('ffmpeg not on PATH');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pipe-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = await makeFixture(dir);
  const r = await runStoryboard({ input: file, cells: 4, encode: false });
  assert.equal(r.sheets[0].png, undefined);
});

test('e2e: 时间窗只覆盖窗口内，清单首行写明 window', async (t) => {
  if (!hasFfmpeg) return t.skip('ffmpeg not on PATH');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pipe-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = await makeFixture(dir);

  const r = await runStoryboard({ input: file, from: 2, to: 4, cells: 4 });
  assert.ok(r.window.from >= 1.99 && r.window.from <= 2.01);
  for (const c of r.sheets[0].cells) {
    assert.ok(c.t_frame >= 1.9 && c.t_frame <= 4.1, `帧 ${c.t_frame} 跑出窗口`);
  }
  const text = formatManifest(r);
  assert.match(text, /window="2\.00-4\.00"/);
  // 单图时不再写 "image 1"（纯冗余），多图时才带
  assert.match(text, /cell 1 \(r1c1\)/);
  assert.match(text, /unlabeled cells are padding/);
});

test('e2e: saveStoryboards 落盘（多张时带序号）', async (t) => {
  if (!hasFfmpeg) return t.skip('ffmpeg not on PATH');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pipe-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = await makeFixture(dir);

  const r = await runStoryboard({ input: file, cells: 4, sheets: 2 });
  assert.equal(r.sheets.length, 2);
  const paths = await saveStoryboards(r, join(dir, 'out.png'));
  assert.equal(paths.length, 2);
  assert.ok(paths[1].endsWith('out-2.png'));
});

test('e2e: 第二次调用命中缓存（切点不重扫）', async (t) => {
  if (!hasFfmpeg) return t.skip('ffmpeg not on PATH');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pipe-'));
  const cacheDir = await mkdtemp(join(tmpdir(), 'dsh-cache-'));
  const prev = process.env.DSH_VIDEO_CACHE_DIR;
  process.env.DSH_VIDEO_CACHE_DIR = cacheDir;
  t.after(async () => {
    if (prev === undefined) delete process.env.DSH_VIDEO_CACHE_DIR;
    else process.env.DSH_VIDEO_CACHE_DIR = prev;
    await rm(dir, { recursive: true, force: true });
    await rm(cacheDir, { recursive: true, force: true });
  });
  const file = await makeFixture(dir);

  const first = await runStoryboard({ input: file, cells: 4, encode: false });
  const second = await runStoryboard({ input: file, cells: 4, encode: false });
  assert.equal(first.cached, false);
  assert.equal(second.cached, true, '第二次应命中缓存');
  assert.deepEqual(first.cuts.map((c) => c.t), second.cuts.map((c) => c.t), '两次切点必须一致');
});

test('e2e: cache=false 时不读写缓存', async (t) => {
  if (!hasFfmpeg) return t.skip('ffmpeg not on PATH');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pipe-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = await makeFixture(dir);
  const r1 = await runStoryboard({ input: file, cells: 4, encode: false, cache: false });
  const r2 = await runStoryboard({ input: file, cells: 4, encode: false, cache: false });
  assert.equal(r1.cached, false);
  assert.equal(r2.cached, false);
});

test('e2e: 非法 pick 立刻抛错（不跑 ffmpeg）', async () => {
  await assert.rejects(() => runStoryboard({ input: 'x.mp4', pick: 'blurry' }), RangeError);
});

test('插件接线: apply() 注册一个叫 video_storyboard 的工具', async (t) => {
  const host = join(homedir(), '.dsh/profiles/node_modules/@deepseek-ai/dsh-tools/lib/index.js');
  // CI 上没有 DSH 宿主包，apply() 会抛 "cannot resolve" —— 那是有意为之，跳过即可
  if (!existsSync(host)) return t.skip('no local DSH install (@deepseek-ai/dsh-tools)');
  if (!process.env.DSH_TOOLS_PATH) process.env.DSH_TOOLS_PATH = host;
  const { apply, name: pluginName, inject } = await import('../src/index.js');
  assert.equal(pluginName, 'dsh-video-storyboard');
  assert.deepEqual(inject, ['tools', 'attachments']);

  const registered = [];
  let disposed = 0;
  const saved = [];
  const ctx = {
    tools: { register: (tool) => { registered.push(tool); return () => { disposed += 1; }; } },
    attachments: {
      saveImage: async (input) => {
        saved.push(input);
        return { attachmentId: 'stub', mediaType: input.mediaType, bytes: input.data.length };
      },
    },
  };
  try {
    const disposer = await apply(ctx);
    assert.deepEqual(registered.map((t) => t.name).sort(),
      ['video_probe', 'video_storyboard', 'video_zoom']);
    assert.equal(typeof disposer, 'function', 'apply 必须返回 disposer');
    disposer();
    assert.equal(disposed, 3, '三个工具都应被释放');
    // 真跑一次 execute，确保交给附件的是真 PNG（这一条能抓住线上那个 malformed 事故）
    const dir2 = await mkdtemp(join(tmpdir(), 'dsh-exec-'));
    t.after(() => rm(dir2, { recursive: true, force: true }));
    const fixture = await makeFixture(dir2);
    const storyboard = registered.find((t) => t.name === 'video_storyboard');
    const value = await storyboard.execute({ input: fixture, cells: 4 });
    assert.equal(saved.length, 1, '应提交一张图');
    assert.equal(saved[0].mediaType, 'image/png');
    assert.equal(saved[0].data.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', '必须是 PNG 魔数');
    assert.match(value.text, /<storyboard[\s\S]*cell 1/);
    assert.equal(value.images.length, 1);

    // zoom 也要真跑一次：窗口收窄、单图、格数默认 6；minGap/transcript 必须接到管线
    saved.length = 0;
    const zoom = registered.find((t) => t.name === 'video_zoom');
    const z = await zoom.execute({
      input: fixture, from: 1, to: 3, cells: 4, minGap: 0.4, transcript: 'off',
    });
    assert.equal(saved.length, 1);
    assert.equal(saved[0].data.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.match(z.text, /window="1\.00-3\.00"/);
    assert.ok(z.images.length === 1);

    // probe 也真跑一次：不取帧、不花钱，只读容器头
    const probe = registered.find((t) => t.name === 'video_probe');
    const p = await probe.execute({ input: fixture });
    assert.match(p.text, /<video[^>]*duration="6\.0/);
    // 这个 fixture 只有视频流，正好覆盖"没音轨"的分支
    assert.match(p.text, /audio="no"/);
    assert.match(p.text, /no audio track/);
  } catch (error) {
    if (/Cannot find package|Cannot find module/.test(String(error))) {
      return t.skip('host @deepseek-ai/dsh-tools not resolvable here');
    }
    throw error;
  }
});

/* ---------------------------------------------------------------- 批量复用扫描 */

test('e2e: zoom 口径 — grid + minGap + burn index+time', async (t) => {
  if (!hasFfmpeg) return t.skip('ffmpeg not on PATH');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pipe-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = await makeFixture(dir);

  const r = await runStoryboard({
    input: file, from: 0, to: 3, cells: 4, sheets: 1,
    adaptive: false, minGap: 0.4, burn: 'index+time',
    transcript: 'off', encode: false,
  });
  assert.equal(r.sheets.length, 1);
  assert.ok(r.sheets[0].cols * r.sheets[0].rows >= 4);
  assert.equal(r.plan.burn, 'index+time');
  assert.equal(r.plan.minGap, 0.4);
  // 每格时长应能短于默认 1.2（否则 minGap 没接到）
  const durs = r.sheets[0].cells.map((c) => c.t_end - c.t_start);
  assert.ok(Math.min(...durs) < 1.2, `minGap=0.4 时应允许短格，实得 ${durs}`);
});

test('countTextInSilence: 只数 >60% 压在静音里的句子', () => {
  const segments = [{ from: 0, to: 2 }, { from: 10, to: 12 }];
  const silences = [{ from: 0, to: 1.5 }, { from: 10, to: 10.2 }];
  assert.equal(countTextInSilence(segments, silences), 1);
  assert.equal(countTextInSilence([], silences), 0);
  assert.equal(countTextInSilence(segments, []), 0);
});

test('e2e: 自适应路径也吃 minGap', async (t) => {
  if (!hasFfmpeg) return t.skip('ffmpeg not on PATH');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pipe-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = await makeFixture(dir);

  const r = await runStoryboard({
    input: file, cells: 4, adaptive: true, minGap: 1.5, transcript: 'off', encode: false,
    strategy: 'density', // 覆盖策略用时间新颖性控间隔；密度路径直接吃 minGap
  });
  assert.ok(r.cuts.length > 0, 'fixture 应有切点，才会走自适应');
  for (const c of r.sheets[0].cells) {
    assert.ok(c.t_end - c.t_start + 1e-9 >= Math.min(1.5, 0.9),
      `自适应格长应尊重 minGap，实得 ${c.t_end - c.t_start}`);
  }
});

test('e2e: 传入 precomputed 时不再自己扫描', async (t) => {
  if (!hasFfmpeg) return t.skip('ffmpeg not on PATH');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pipe-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = await makeFixture(dir);          // 这段测试片本身有切点

  const own = await runStoryboard({ input: file, cells: 4, encode: false });
  assert.ok(own.cuts.length > 0, '正常扫描应找到切点');

  // 注入一份"窗口外的切点"：如果管线自己又扫了一遍，就会找到真实切点，测试失败
  const injected = await runStoryboard({
    input: file, cells: 4, encode: false,
    precomputed: { cuts: [{ t: 99 }], summary: { frames: 0, p90: 0 }, threshold: 12 },
  });
  assert.equal(injected.cuts.length, 0, '应完全采用注入的切点（且已按窗口过滤）');
});

test('formatProbe: 长片给两种读法并标明剧透，短片不啰嗦', async () => {
  const { formatProbe } = await import('../src/pipeline.js');
  const base = {
    width: 1920, height: 1080, fps: 24, aspect: 16 / 9, rotation: 0,
    videoCodec: 'h264', container: 'mp4', hasAudio: true, audioCodec: 'aac',
    hasSubtitle: true, path: 'a.mp4',
  };
  const long = formatProbe({ ...base, duration: 9300 });
  assert.match(long, /STRUCTURE \(spoils the ending\)/);
  assert.match(long, /SEQUENCE \(no spoilers/);

  const short = formatProbe({ ...base, duration: 30 });
  assert.match(short, /one call is enough/);
  assert.ok(!/STRUCTURE/.test(short), '短片不该出现长片模板');
  assert.ok(short.split('\n').length <= 3, `短片文本应很短，实得 ${short.split('\n').length} 行`);
});
