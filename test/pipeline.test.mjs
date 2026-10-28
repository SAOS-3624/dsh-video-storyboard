/**
 * pipeline.test.mjs — 端到端：真 ffmpeg 现造片子 → runStoryboard → 断言产物。
 * 顺带验证 apply() 的接线（注册一次、名字正确），不依赖真实 DSH 宿主。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { runStoryboard, formatManifest, saveStoryboards } from '../src/pipeline.js';
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

  const r = await runStoryboard({ input: file, cells: 4, pick: 'sharp', sourceHash: true });
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

  const text = formatManifest(r);
  assert.match(text, new RegExp(`cell="${sheet.cellW}x${sheet.cellH}"`));
  assert.match(text, /tokens="384 \(DSH estimate\)"/);
  assert.match(text, /ffmpeg="[^"]+"/);
  assert.match(text, /sha256="[0-9a-f]{64}"/);
  assert.match(text, /plan: explicit 4 cells/);
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
      ['video_locate', 'video_probe', 'video_storyboard', 'video_zoom']);
    assert.equal(typeof disposer, 'function', 'apply 必须返回 disposer');
    disposer();
    assert.equal(disposed, 4, '四个工具都应被释放');
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

    // locate 也要真跑一次：这条测试就是 issue 里那个 ReferenceError 的回归守卫
    // （0.4.1 漏了 `import ... from './locate.js'`，工具一调就崩，而测试当时没覆盖到）
    const locate = registered.find((t) => t.name === 'video_locate');
    const lv = await locate.execute({ input: fixture, query: '测试' });
    assert.equal(typeof lv.text, 'string');
    assert.ok(lv.text.length > 10, 'locate 必须返回一段可读文本');

    // zoom 也要真跑一次：窗口收窄、单图、格数默认 6
    saved.length = 0;
    const zoom = registered.find((t) => t.name === 'video_zoom');
    const z = await zoom.execute({ input: fixture, from: 1, to: 3 });
    assert.equal(saved.length, 1);
    assert.equal(saved[0].data.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.match(z.text, /window="1\.00-3\.00"/);

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
  const long = await formatProbe({ ...base, duration: 9300 });
  assert.match(long, /STRUCTURE \(spoils the ending\)/);
  assert.match(long, /SEQUENCE \(no spoilers/);

  const short = await formatProbe({ ...base, duration: 30 });
  assert.match(short, /one call is enough/);
  assert.ok(!/STRUCTURE/.test(short), '短片不该出现长片模板');
  assert.ok(short.split('\n').length <= 3, `短片文本应很短，实得 ${short.split('\n').length} 行`);
});

/* ---------------------------------------------------------------- 外挂转写 */

test('transcriptFile: 给了转写就不跑 ASR，没有音轨也能用', { skip: !hasFfmpeg }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tf-pipe-'));
  try {
    const file = await makeFixture(dir);
    const srt = join(dir, 'a.srt');
    await writeFile(srt, '1\n00:00:00,500 --> 00:00:02,000\n来自文件的第一句\n\n' +
      '2\n00:00:02,000 --> 00:00:04,000\n第二句\n', 'utf8');
    const r = await runStoryboard({ input: file, cells: 4, transcriptFile: srt, cache: false });
    assert.equal(r.transcript.source, 'file');
    assert.equal(r.transcript.segments, 2);
    assert.equal(r.transcript.chars, 11);
    assert.equal(r.transcript.model, 'file:srt');
    // 关键：fixture 没有音轨，旧逻辑会走 no-audio；显式文件必须压过它
    assert.match(formatManifest(r), /来自文件的第一句/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('transcriptFile: 窗口统计只算窗口内的台词，不把整片字数除以窗口', { skip: !hasFfmpeg }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tf-window-'));
  try {
    const file = await makeFixture(dir);
    const srt = join(dir, 'long.srt');
    await writeFile(srt, '1\n00:00:00,000 --> 00:00:02,000\n' + '甲'.repeat(60) + '\n\n' +
      '2\n00:00:02,000 --> 00:00:04,000\n甲乙丙丁\n', 'utf8');
    const r = await runStoryboard({
      input: file, from: 2, to: 4, cells: 4, transcriptFile: srt, cache: false,
    });
    assert.equal(r.transcript.segments, 1, '窗口内只应剩第二段');
    assert.equal(r.transcript.chars, 4, '不能把窗口外的 60 字算进来');
    assert.equal(r.transcript.charsPerSec, 2, '4 字 / 2 秒');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('transcriptFile: 文件不存在时标 file-failed，不让整次调用失败', { skip: !hasFfmpeg }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tf-pipe2-'));
  try {
    const file = await makeFixture(dir);
    const r = await runStoryboard({
      input: file, cells: 4, transcriptFile: join(dir, 'nope.srt'), cache: false,
    });
    assert.equal(r.transcript.source, 'file-failed');
    assert.match(r.transcript.error, /ENOENT|no such file/i);
    assert.ok(r.sheets.length > 0, '台词失败不该影响出图');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('formatRemoteProbe: 说明"什么还没下载"和下一步', async () => {
  const { formatRemoteProbe } = await import('../src/pipeline.js');
  const text = formatRemoteProbe({
    url: 'https://www.bilibili.com/video/BV1xx', title: '示例', duration: 90,
    heights: [360, 480, 720, 1080], maxHeight: 1080, auth: 'cookies',
  });
  assert.match(text, /available: 360p, 480p, 720p, 1080p \(max 1080p\)/);
  assert.match(text, /nothing was downloaded yet/);
  assert.match(text, /video_zoom then reads the original stream at 1080p/);
});

test('formatRemoteProbe: 匿名时明确警告分辨率不保证', async () => {
  const { formatRemoteProbe } = await import('../src/pipeline.js');
  const text = formatRemoteProbe({
    url: 'https://x/y', title: null, duration: 10, heights: [360], maxHeight: 360, auth: 'anonymous',
  });
  assert.match(text, /auth: anonymous \(resolution not guaranteed\)/);
});

/* ---------------------------------------------------------------- 逐窗口重判 */

const fps25 = 25;
// 每 4 帧一刀（25fps 下 6.25 刀/秒）—— 这是快闪的常见密度；每 2 帧一刀会稠到
// 和运镜无法区分（degraded 会判 motion），那不是这个测试要验证的东西。
const gapFrames = (n, score, from = 0) => Array.from({ length: n }, (_, i) => ({
  t: from + i / fps25, score: i % 4 === 3 ? score : 3,
}));
const smooth = (n, score, from = 0) => Array.from({ length: n }, (_, i) => ({
  t: from + i / fps25, score,
}));

test('refineCutsByWindow: 快闪窗口被细判，运镜窗口保持粗判', async () => {
  const { refineCutsByWindow } = await import('../src/pipeline.js');
  // 0-2s：每两帧一刀、分数 70（真剪辑）；2-4s：每帧都在变但只有 15 分（运镜）
  const stats = [...gapFrames(50, 70, 0), ...smooth(50, 15, 2)];
  const coarse = [{ t: 0.5, score: 70 }, { t: 4.9, score: 15 }];
  const r = refineCutsByWindow({ stats, fps: fps25, coarseCuts: coarse, winStart: 0, winDur: 4, winSec: 2 });
  const inFlash = r.cuts.filter((c) => c.t < 2).length;
  const inPan = r.cuts.filter((c) => c.t >= 2).length;
  assert.ok(inFlash >= 10, `快闪窗口应细判出很多刀，实得 ${inFlash}`);
  assert.ok(inPan <= 2, `运镜窗口不该被细判，实得 ${inPan}`);
  assert.equal(r.refined.length, 1);
  assert.equal(r.refined[0].from, 0);
});

test('refineCutsByWindow: 分数不够大时不采纳（宁可少报）', async () => {
  const { refineCutsByWindow } = await import('../src/pipeline.js');
  // 同样密，但每刀只有 20 分 —— 低于 25 的门槛
  const stats = gapFrames(50, 20, 0);
  const coarse = [{ t: 0.5, score: 20 }];
  const r = refineCutsByWindow({ stats, fps: fps25, coarseCuts: coarse, winStart: 0, winDur: 2, winSec: 2 });
  assert.equal(r.refined.length, 0, '不该采纳');
  assert.equal(r.cuts.length, 1, '应保留粗判结果');
});

/* ---------------------------------------------------------------- 子格摊开 */

test('chooseSubGrid: 按密度决定，不看镜头数', async () => {
  const { chooseSubGrid } = await import('../src/pipeline.js');
  // 15 秒 5 个镜头（0.33/s）是正常叙事节奏，不该摊
  assert.equal(chooseSubGrid({ shots: 5, dur: 15, cellW: 499, cellH: 278 }), 1);
  // 同样 5 个镜头挤在 3 秒里（1.7/s）就是快闪，该摊
  assert.ok(chooseSubGrid({ shots: 5, dur: 3, cellW: 499, cellH: 278 }) >= 2);
});

test('chooseSubGrid: 子帧小于 100×56 就降档，3×3 布局不切 4×4', async () => {
  const { chooseSubGrid } = await import('../src/pipeline.js');
  // 331/4 = 82 < 100 → 最多 3×3
  assert.equal(chooseSubGrid({ shots: 20, dur: 5, cellW: 331, cellH: 184 }), 3);
  // 499/4 = 124 ≥ 100 → 允许 4×4
  assert.equal(chooseSubGrid({ shots: 20, dur: 5, cellW: 499, cellH: 278 }), 4);
  // 太小的格子完全不摊
  assert.equal(chooseSubGrid({ shots: 20, dur: 5, cellW: 180, cellH: 100 }), 1);
});

test('chooseSubGrid: 镜头少到不值得摊时保持整格', async () => {
  const { chooseSubGrid } = await import('../src/pipeline.js');
  assert.equal(chooseSubGrid({ shots: 2, dur: 1, cellW: 499, cellH: 278 }), 1);
});

test('e2e: 平铺格不写 t_frame，清单也不出现 frame@', async (t) => {
  if (!hasFfmpeg) return t.skip('ffmpeg not on PATH');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pipe-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = await makeFixture(dir);
  const cuts = Array.from({ length: 9 }, (_, i) => ({ t: 0.2 + i * 0.2, score: 50 }));
  const r = await runStoryboard({
    input: file, from: 0, to: 2, cells: 1, encode: false,
    precomputed: { cuts, summary: { p90: 50 }, threshold: 5 },
  });
  const cell = r.sheets[0].cells[0];
  assert.ok(cell.sub >= 2, '这一格应被摊开');
  assert.equal(cell.t_frame, undefined, '平铺格没有单一取帧时刻');
  const text = formatManifest(r);
  assert.ok(!/frame@/.test(text), '平铺格不该写 frame@');
});

/**
 * 极静素材的回归守卫。
 *
 * 这条测试是"函数写了但没接线"这类错误的护栏：spikeCuts 在 9adba94 就写好了、单测也绿，
 * 但 pipeline 从来没调用它 —— 于是纯 PPT 视频一条切点都找不到（用户实测）。
 * 这里造一段"几乎不动、只在第 2 秒出现一个小方块"的素材：绝对阈值看不见，相对基线能看见。
 */
test('e2e: 极静素材（PPT 型）也能找到那一刀', async (t) => {
  if (!hasFfmpeg) return t.skip('ffmpeg not on PATH');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-static-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const out = join(dir, 'static.mp4');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  await promisify(execFile)('ffmpeg', [
    '-hide_banner', '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=0x101010:s=320x180:r=25:d=6',
    // 第 2 秒出现一块约 8% 的画面（相当于 PPT 上换了一段字）。
    // 实测这一档峰值只有 ~12 分，绝对阈值 12~15 会漏；相对基线能看见。
    '-vf', "drawbox=x=160:y=80:w=90:h=50:color=0xffee66:t=fill:enable='gte(t,2)'",
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', out,
  ]);
  const r = await runStoryboard({ input: out, cells: 2, encode: false, transcript: 'off', cache: false });
  assert.ok(r.cuts.length >= 1, `极静素材上的小改动应该被抓到，实得 ${r.cuts.length} 刀`);
  assert.ok(r.cuts.some((c) => Math.abs(c.t - 2) < 0.6), `切点应落在 2 秒附近，实得 ${r.cuts.map((c) => c.t.toFixed(2))}`);
});
