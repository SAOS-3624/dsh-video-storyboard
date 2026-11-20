/**
 * test/shadow.test.mjs — 阴影对照的口径与"绝不拖垮导出"。
 *
 * 三块：
 *   ① `compareCuts` 的分歧率口径 —— 交接里给了四个自检点，这里逐条钉住
 *      （尤其是"两边都是 0 个切点 → 0，不是 NaN"）。
 *   ② `readSceneConfig` 的三档开关 —— 缺省必须是 `hsv`（行为与今天完全一致）。
 *   ③ `shadowPass` 的失败路径 —— **模型不存在时导出照常**，只留一行 `ok:false`。
 *
 * e2e 那几条要有 ffmpeg 与部署模型才跑（模型在 `bench/`，不进 npm 包，所以用 skip 兜住）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { DEFAULT_FFMPEG, probeVideo } from '../src/storyboard/probe.js';
import { scanShots } from '../src/storyboard/scan.js';
import { runStoryboard } from '../src/storyboard/pipeline.js';
import {
  compareCuts, loadLiquidModel, predictCuts, readSceneConfig, shadowPass, shadowLogPath, TOL_FRAMES,
} from '../src/storyboard/shadow.js';

const run = promisify(execFile);

/**
 * 全套测试都在**独立缓存目录**里跑：`shadowPass` 的默认日志、`saveCells` 的 cell 映射
 * 都落在 `cacheDir()` 下，不隔离就会往用户真实缓存里塞东西。
 * （node --test 每个文件一个进程，所以这个 env 不会串到别的测试。）
 */
process.env.DSH_VIDEO_CACHE_DIR = await mkdtemp(join(tmpdir(), 'dsh-shadow-cache-'));

/** 部署模型（bench 是本地目录，npm 包里没有 —— 缺了就让 e2e 跳过，不算失败）。 */
const DEPLOY_MODEL = 'bench/eval/train/out-deploy-cut/model-bbc-fold1.json';

let hasFfmpeg = false;
try {
  await run(DEFAULT_FFMPEG, ['-version']);
  hasFfmpeg = true;
} catch { hasFfmpeg = false; }

// ---------------------------------------------------------------- 分歧率口径

const seq = (n, step = 0.5) => Array.from({ length: n }, (_, i) => +(i * step).toFixed(3));

test('compareCuts: 100/100 全中 → 分歧率 0', () => {
  const r = compareCuts(seq(100), seq(100));
  assert.equal(r.agreed, 100);
  assert.equal(r.divergent, 0);
  assert.equal(r.divergenceRate, 0);
  assert.equal(r.onlyHsv.length, 0);
  assert.equal(r.onlyLiquid.length, 0);
});

test('compareCuts: 100 vs 102 中 96 → 0.050（不是 分歧点数/总点数 的另一种口径）', () => {
  const a = seq(100);
  // 前 96 刀对齐，之后各走各的：A 剩 4 个、B 剩 6 个
  const b = [...a.slice(0, 96), ...Array.from({ length: 6 }, (_, i) => +(50.1 + i * 0.5).toFixed(3))];
  const r = compareCuts(a, b);
  assert.equal(r.agreed, 96);
  assert.equal(r.cutsHsv, 100);
  assert.equal(r.cutsLiquid, 102);
  // 1 - 2*96/(100+102) = 0.0495 → 0.05
  assert.equal(r.divergenceRate, 0.05);
  // 恒等式：divergenceRate === divergent / 总点数
  assert.equal(r.divergent, 100 + 102 - 2 * 96);
});

test('compareCuts: 100/100 全错开 → 1.000', () => {
  const a = seq(100);
  const b = a.map((t) => +(t + 0.3).toFixed(3));    // 0.3s = 7.5 帧，远超 2 帧容差
  const r = compareCuts(a, b);
  assert.equal(r.agreed, 0);
  assert.equal(r.divergenceRate, 1);
});

test('compareCuts: 两边都是 0 个切点 → 0，不是 NaN', () => {
  const r = compareCuts([], []);
  assert.equal(r.divergenceRate, 0);
  assert.ok(Number.isFinite(r.divergenceRate), 'NaN 会让那一行日志整个废掉');
});

test('compareCuts: 一对一 —— 一个点只能用一次', () => {
  // 两个 hsv 切点都落在同一个 liquid 切点的容差里 → 只算一致 1 个
  const r = compareCuts([1.0, 1.04], [1.02], { fps: 25 });
  assert.equal(r.agreed, 1);
  assert.equal(r.onlyHsv.length, 1);
  assert.equal(r.onlyLiquid.length, 0);
});

test('compareCuts: 容差按帧换算（2 帧在 25fps 是 0.08s、30fps 是 0.067s）', () => {
  assert.equal(TOL_FRAMES, 2, '要和 datasets.mjs 的 TOL_FRAMES 同一个数');
  assert.equal(compareCuts([1.0], [1.08], { fps: 25 }).agreed, 1, '正好 2 帧算一致');
  assert.equal(compareCuts([1.0], [1.09], { fps: 25 }).agreed, 0, '超 2 帧就不算');
  assert.equal(compareCuts([1.0], [1.06], { fps: 30 }).agreed, 1);
  assert.equal(compareCuts([1.0], [1.07], { fps: 30 }).agreed, 0);
});

test('compareCuts: 输入乱序也照算（切点表没保证有序）', () => {
  const r = compareCuts([5, 1, 3], [3.01, 1.01, 5.01], { fps: 25 });
  assert.equal(r.agreed, 3);
  assert.equal(r.divergenceRate, 0);
});

// ---------------------------------------------------------------- 三档开关

test('readSceneConfig: 什么都没配 → hsv（默认行为与今天完全一致）', () => {
  const c = readSceneConfig({}, { env: { DSH_HOME: 'X:/nope' } });
  assert.equal(c.mode, 'hsv');
  assert.equal(c.model, null);
  assert.equal(c.note, null);
});

test('readSceneConfig: shadow + 模型路径 + stride', () => {
  const c = readSceneConfig(
    { sceneDetector: ' SHADOW ', liquidModel: ' D:/m.json ', shadowStride: 3 },
    { env: { DSH_HOME: 'X:/nope' } },
  );
  assert.equal(c.mode, 'shadow');
  assert.equal(c.model, 'D:/m.json');
  assert.equal(c.stride, 3);
});

test('readSceneConfig: 认不出来的值退回 hsv，但留下 note（不许静默）', () => {
  const c = readSceneConfig({ sceneDetector: 'lnn' }, { env: { DSH_HOME: 'X:/nope' } });
  assert.equal(c.mode, 'hsv');
  assert.match(c.note, /不认识/);
});

test('readSceneConfig: stride 夹到 [1, 60]', () => {
  const env = { DSH_HOME: 'X:/nope' };
  assert.equal(readSceneConfig({ shadowStride: 0 }, { env }).stride, 1);
  assert.equal(readSceneConfig({ shadowStride: -9 }, { env }).stride, 1);
  assert.equal(readSceneConfig({ shadowStride: 999 }, { env }).stride, 60);
});

test('shadowLogPath: 默认落在 cacheDir 下的 shadow-cuts.jsonl', () => {
  const p = shadowLogPath({ DSH_VIDEO_CACHE_DIR: 'X:/cache' });
  assert.equal(p, join('X:/cache', 'shadow-cuts.jsonl'));
});

// ---------------------------------------------------------------- 失败路径

test('shadowPass: 模型路径不存在 → ok:false，**不抛**，导出不受影响', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-shadow-'));
  try {
    const log = join(dir, 'shadow-cuts.jsonl');
    const r = await shadowPass({
      input: 'nope.mp4', fps: 25, cuts: [], modelPath: join(dir, 'missing.json'), logPath: log,
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /不存在/);
    const line = (await readFile(log, 'utf8')).trim();
    assert.equal(line.split('\n').length, 1, '一次失败只留一行');
    assert.equal(JSON.parse(line).ok, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('shadowPass: 没配模型 → ok:false，提示要配 liquidModel', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-shadow-'));
  try {
    const r = await shadowPass({
      input: 'nope.mp4', fps: 25, cuts: [], modelPath: null, logPath: join(dir, 'l.jsonl'),
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /liquidModel/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- e2e

const COLORS = ['0xff0000', '0x00ff00', '0x0000ff', '0xffff00', '0xff00ff'];

/** 现造测试片：5 个纯色镜头各 1s（和 e2e.scan 同一套做法，仓库里不放二进制）。 */
async function makeColorFixture(dir) {
  const out = join(dir, 'fixture.mp4');
  const args = ['-hide_banner', '-v', 'error', '-y'];
  for (const c of COLORS) args.push('-f', 'lavfi', '-i', `color=c=${c}:s=320x180:r=25:d=1`);
  args.push(
    '-filter_complex', `${COLORS.map((_, i) => `[${i}]`).join('')}concat=n=${COLORS.length}:v=1:a=0[v]`,
    '-map', '[v]', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', out,
  );
  await run(DEFAULT_FFMPEG, args);
  return out;
}

test('e2e: 5 个纯色镜头 → shadowPass 出一行 ok:true，切点数与 hsv 各自独立记', async (t) => {
  if (!hasFfmpeg) return t.skip('ffmpeg not on PATH');
  if (!existsSync(DEPLOY_MODEL)) return t.skip(`部署模型不在：${DEPLOY_MODEL}`);

  const dir = await mkdtemp(join(tmpdir(), 'dsh-shadow-e2e-'));
  try {
    const file = await makeColorFixture(dir);
    const info = await probeVideo(file);
    const { cuts } = await scanShots({ input: file, fps: info.fps });

    const log = join(dir, 'shadow-cuts.jsonl');
    const r = await shadowPass({
      input: file, fps: info.fps, start: 0, end: info.duration,
      duration: info.duration, frames: Math.round(info.duration * info.fps),
      cuts, thetaHsv: 80, modelPath: DEPLOY_MODEL, logPath: log,
    });

    assert.equal(r.ok, true, `shadow 失败：${r.error}`);
    assert.equal(r.cutsHsv, cuts.length, 'hsv 那侧的刀数必须就是扫描结果，一个不多一个不少');
    assert.ok(r.cutsLiquid >= 0);
    assert.ok(r.divergenceRate >= 0 && r.divergenceRate <= 1);
    assert.equal(r.stride, 1);
    assert.ok(Array.isArray(r.onlyHsv) && r.onlyHsv.length <= 10, '时间戳只留前 10 个');

    const lines = (await readFile(log, 'utf8')).trim().split('\n');
    assert.equal(lines.length, 1);
    const rec = JSON.parse(lines[0]);
    assert.equal(rec.ok, true);
    assert.equal(rec.fps, info.fps);
    assert.ok(rec.msFeature >= 0 && rec.msForward >= 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('e2e: 开 shadow 不改变任何输出 —— 切点与 PNG 都和 hsv 逐字节相同', async (t) => {
  if (!hasFfmpeg) return t.skip('ffmpeg not on PATH');
  if (!existsSync(DEPLOY_MODEL)) return t.skip(`部署模型不在：${DEPLOY_MODEL}`);

  const dir = await mkdtemp(join(tmpdir(), 'dsh-shadow-pipe-'));
  try {
    const file = await makeColorFixture(dir);
    // 共用参数：不转写、不读缓存、不出音频条 —— 只留下"切点 → 取帧 → 拼图"这条主干
    const common = {
      input: file, transcript: 'off', cache: false, audioStrip: false, encode: true,
    };
    const plain = await runStoryboard({ ...common });
    const log = join(dir, 'shadow-cuts.jsonl');
    const shadowed = await runStoryboard({
      ...common, sceneDetector: 'shadow', liquidModel: DEPLOY_MODEL, shadowLog: log,
    });

    // ① 默认那一跑，清单里既没有 sceneDetector 也没有 shadow（默认配置的输出一个字都不多）
    assert.equal(plain.shadow, undefined);
    assert.equal(plain.sceneDetector, undefined);

    // ② 切点一个不差
    assert.deepEqual(
      shadowed.cuts.map((c) => c.t),
      plain.cuts.map((c) => c.t),
      'shadow 只许看，不许动切点',
    );

    // ③ 图逐字节相同 —— 这是"出问题把配置改回 hsv 就行"的回滚保证
    assert.equal(shadowed.sheets.length, plain.sheets.length);
    for (let i = 0; i < plain.sheets.length; i += 1) {
      assert.ok(
        plain.sheets[i].png.equals(shadowed.sheets[i].png),
        `第 ${i + 1} 张图和 hsv 跑出来的不是同一份字节`,
      );
    }

    // ④ 日志一行、ok:true、刀数和 hsv 那侧对得上
    assert.equal(shadowed.shadow.ok, true, `shadow 失败：${shadowed.shadow.error}`);
    assert.equal(shadowed.shadow.cutsHsv, shadowed.cuts.length);
    const lines = (await readFile(log, 'utf8')).trim().split('\n');
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).ok, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('e2e: 纯文本/预演模式下不跑 shadow（那是"先看刀数"的轻量入口）', async (t) => {
  if (!hasFfmpeg) return t.skip('ffmpeg not on PATH');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-shadow-text-'));
  try {
    const file = await makeColorFixture(dir);
    const log = join(dir, 'shadow-cuts.jsonl');
    const r = await runStoryboard({
      input: file, transcript: 'off', cache: false, textOnly: true,
      sceneDetector: 'shadow', liquidModel: DEPLOY_MODEL, shadowLog: log,
    });
    assert.deepEqual(r.shadow, { ok: false, skipped: 'text-only' });
    assert.equal(existsSync(log), false, '跳过的跑法不该往日志里塞噪声');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('e2e: sceneDetector=liquid 还没实现 → 按 hsv 跑，并在清单里说明', async (t) => {
  if (!hasFfmpeg) return t.skip('ffmpeg not on PATH');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-shadow-liquid-'));
  try {
    const file = await makeColorFixture(dir);
    const r = await runStoryboard({
      input: file, transcript: 'off', cache: false, textOnly: true, sceneDetector: 'liquid',
    });
    assert.equal(r.sceneDetector.applied, 'hsv');
    assert.match(r.sceneDetector.note, /liquid 还没实现/);
    assert.equal(r.shadow, undefined, '未实现的档位绝不能产出半真半假的日志');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('e2e: 窗口起点不为 0 时，时间基准必须对齐（hsv 是绝对时间、模型是窗口相对）', async (t) => {
  if (!hasFfmpeg) return t.skip('ffmpeg not on PATH');
  if (!existsSync(DEPLOY_MODEL)) return t.skip(`部署模型不在：${DEPLOY_MODEL}`);

  const dir = await mkdtemp(join(tmpdir(), 'dsh-shadow-offset-'));
  try {
    const file = await makeColorFixture(dir);
    const md = await loadLiquidModel(DEPLOY_MODEL);
    const start = 1;
    const end = 5;
    const p = await predictCuts({ input: file, fps: 25, start, end, md });
    assert.ok(p.predCuts.length > 0, '纯色片上模型应该能出点，否则这条测试没意义');

    // 把模型的窗口相对切点**加回窗口起点**，当成管网线给出的绝对切点 —— 必须完全一致
    const absCuts = p.predCuts.map((x) => x + start);
    const r = await shadowPass({
      input: file, fps: 25, start, end, cuts: absCuts, modelPath: DEPLOY_MODEL,
      logPath: join(dir, 'l.jsonl'),
    });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.agreed, p.predCuts.length, '差一个 start 就会变成 0 个一致');
    assert.equal(r.divergenceRate, 0);
    // 落进日志的时间是窗口相对：加回 window.from 才是绝对时间
    for (const x of [...r.onlyHsv, ...r.onlyLiquid]) assert.ok(x < end - start + 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
