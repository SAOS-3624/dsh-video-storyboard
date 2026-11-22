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
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { DEFAULT_FFMPEG, probeVideo } from '../src/storyboard/probe.js';
import { scanShots } from '../src/storyboard/scan.js';
import { runStoryboard } from '../src/storyboard/pipeline.js';
import {
  compareCuts, liquidDecision, loadLiquidModel, normalizeSceneDetector, openFrameTap, predictCuts,
  readSceneConfig, sceneAlgorithmLabel, shadowPass, shadowLogPath, TOL_FRAMES,
} from '../src/storyboard/shadow.js';
import {
  bucketOf, parseShadowLog, summarizeShadow, verdictOf,
} from '../src/storyboard/shadow-report.js';

const run = promisify(execFile);

/**
 * 全套测试都在**独立缓存目录**里跑：`shadowPass` 的默认日志、`saveCells` 的 cell 映射
 * 都落在 `cacheDir()` 下，不隔离就会往用户真实缓存里塞东西。
 * （node --test 每个文件一个进程，所以这个 env 不会串到别的测试。）
 */
process.env.DSH_VIDEO_CACHE_DIR = await mkdtemp(join(tmpdir(), 'dsh-shadow-cache-'));

/** 部署模型（bench 是本地目录，npm 包里没有 —— 缺了就让 e2e 跳过，不算失败）。 */
const DEPLOY_MODEL = 'bench/eval/legacy/out/deploy-joint-v4/model-bbc-fold1.json';

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

test('readSceneConfig: 什么都没配 → 默认算法（lnn）', () => {
  const c = readSceneConfig({}, { env: { DSH_HOME: 'X:/nope' } });
  assert.equal(c.mode, 'liquid', '默认是 lnn（内部名 liquid），见 DEFAULT_SCENE_DETECTOR');
  assert.equal(c.model, null, '模型路径不填 = 用内置模型');
  assert.equal(c.note, null);
});

test('readSceneConfig: 显式 hsv 才关掉模型', () => {
  const c = readSceneConfig({ sceneDetector: 'hsv' }, { env: { DSH_HOME: 'X:/nope' } });
  assert.equal(c.mode, 'hsv');
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

test('readSceneConfig: 认不出来的值退回默认，但留下 note（不许静默）', () => {
  // 别拿 lnn 当反例：它是 liquid 的合法别名（见文件末尾「取帧算法的对外名字」那一组）
  const c = readSceneConfig({ sceneDetector: 'canny' }, { env: { DSH_HOME: 'X:/nope' } });
  assert.equal(c.mode, 'liquid', '认不出来 = 和没配一样，走默认');
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

test('shadowPass: 显式给了错的模型路径 → ok:false，导出照常', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-shadow-'));
  try {
    /**
     * ⚠️ 别再用 `modelPath: null` 当反例 —— 现在 null = 用**内置模型**
     * （`BUNDLED_MODEL`），那是"设置页里选 lnn 就能用"的前提。
     * 要测失败路径得显式给一个不存在的路径。
     */
    const r = await shadowPass({
      input: 'nope.mp4', fps: 25, cuts: [], modelPath: 'X:/no-such-model.json', logPath: join(dir, 'l.jsonl'),
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /模型文件不存在/);
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
    // 基线必须**显式**是 hsv：默认已经改成 lnn，不传就不是纯像素差分那一版了
    const plain = await runStoryboard({ ...common, sceneDetector: 'hsv' });
    const log = join(dir, 'shadow-cuts.jsonl');
    const shadowed = await runStoryboard({
      ...common, sceneDetector: 'shadow', liquidModel: DEPLOY_MODEL, shadowLog: log,
    });

    // ① hsv 那一跑，清单里既没有 sceneDetector 也没有 shadow（hsv 的输出一个字都不多）
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

// ---------------------------------------------------------------- 日志汇总

/** 造一条日志记录（v1 口径）。 */
const rec = (over = {}) => ({
  v: 1,
  ts: '2026-11-20T11:00:00.000Z',
  video: 'a.mp4',
  fps: 25,
  cutsHsv: 10,
  cutsLiquid: 10,
  agreed: 9,
  divergenceRate: 0.1,
  ok: true,
  ...over,
});

test('parseShadowLog: 坏行跳过，好行照收', () => {
  const text = [
    JSON.stringify(rec()),
    '{"broken":',                    // 写到一半被掐断的行
    '',
    JSON.stringify(rec({ video: 'b.mp4' })),
  ].join('\n');
  const rows = parseShadowLog(text);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.video), ['a.mp4', 'b.mp4']);
});

test('summarizeShadow: 0/0 与失败行都不算有效读数', () => {
  const s = summarizeShadow([
    rec(),
    rec({ cutsHsv: 0, cutsLiquid: 0, agreed: 0, divergenceRate: 0 }),  // 录屏：看着"完全一致"，其实没信息
    rec({ ok: false, error: '模型文件不存在' }),
    rec({ v: undefined }),                                            // 旧口径
  ]);
  assert.equal(s.totals.records, 4);
  assert.equal(s.totals.usable, 1, '只有第一条能拿来判断');
  assert.equal(s.totals.failed, 1);
  assert.match(s.rows[1].flags.join(), /0 刀/);
  assert.match(s.rows[3].flags.join(), /旧口径/);
});

test('summarizeShadow: 加权分歧率按刀数加权，不是若干百分比取平均', () => {
  // 两段：100 刀那段落 10%，1 刀那段落 100% —— 平均会是 55%，加权是 ~11.9%
  const s = summarizeShadow([
    rec({ cutsHsv: 50, cutsLiquid: 50, agreed: 45, divergenceRate: 0.1 }),
    rec({ cutsHsv: 1, cutsLiquid: 1, agreed: 0, divergenceRate: 1 }),
  ]);
  assert.equal(s.totals.sumHsv, 51);
  assert.equal(s.totals.sumAgreed, 45);
  assert.equal(s.totals.rate, +(1 - 90 / 102).toFixed(3));
  assert.equal(s.totals.rate, 0.118);
});

test('verdictOf: 三档 + 读数不够四档都说清楚', () => {
  assert.equal(verdictOf({ usable: 0 }).level, 'insufficient');
  const few = verdictOf({ usable: 5, rate: 0.05 });
  assert.equal(few.level, 'insufficient');
  assert.match(few.text, /5 条/);

  // 每段 20/20 刀、只对一半 → 加权分歧率正好 0.5，稳稳落在 >15%
  const many = (agreed) => Array.from({ length: 20 }, () => rec({
    cutsHsv: 20, cutsLiquid: 20, agreed, divergenceRate: 1 - (2 * agreed) / 40, v: 1,
  }));
  const good = summarizeShadow(many(19));       // 1 - 38/40 = 0.05
  assert.equal(good.totals.usable, 20);
  assert.equal(good.totals.rate, 0.05);
  assert.equal(good.verdict.level, 'promising', `rate=${good.totals.rate}`);

  const bad = summarizeShadow(many(10));        // 1 - 20/40 = 0.5
  assert.equal(bad.totals.rate, 0.5);
  assert.equal(bad.verdict.level, 'risky');
});

test('bucketOf / BUCKETS: 边界落在右侧桶（3% 算 3~8%）', () => {
  assert.equal(bucketOf(0.029), '<3%');
  assert.equal(bucketOf(0.03), '3~8%');
  assert.equal(bucketOf(0.08), '8~15%');
  assert.equal(bucketOf(0.15), '>15%');
  assert.equal(bucketOf(null), null);
});

// ---------------------------------------------------------------- liquid 接管

/** 造一个偏置模型（`w_cut=0, b_cut=bias`）：-30 ≈ 一刀不出，+6 ≈ 见帧就报。 */
async function makeBiasedModel(dir, bias) {
  const raw = JSON.parse(await readFile(DEPLOY_MODEL, 'utf8'));
  const n = raw.params.w_cut.length;
  raw.params.w_cut = new Array(n).fill(0);
  raw.params.b_cut = [bias];
  const out = join(dir, `model-bias${bias}.json`);
  await writeFile(out, JSON.stringify(raw), 'utf8');
  return out;
}

test('liquidDecision: 跑挂 / 0 刀 / 刀数不到 40% 都不许接管', () => {
  assert.deepEqual(liquidDecision({ ok: true, cutsHsv: 10, cutsLiquid: 10 }), { accept: true, reason: null });
  // 模型比 hsv 多（补了 hsv 漏的刀）也照收
  assert.equal(liquidDecision({ ok: true, cutsHsv: 10, cutsLiquid: 14 }).accept, true);
  // hsv 一个都没出、模型出了 → 也该收
  assert.equal(liquidDecision({ ok: true, cutsHsv: 0, cutsLiquid: 3 }).accept, true);

  const fail = liquidDecision({ ok: false, error: '模型文件不存在' });
  assert.equal(fail.accept, false);
  assert.match(fail.reason, /模型没跑成/);

  const zero = liquidDecision({ ok: true, cutsHsv: 213, cutsLiquid: 0 });
  assert.equal(zero.accept, false);
  assert.match(zero.reason, /0 刀/);

  const both = liquidDecision({ ok: true, cutsHsv: 0, cutsLiquid: 0 });
  assert.equal(both.accept, false, '两边都没出点就别换，换了也没有区别');

  // 39% 拒、40% 收（边界按 >= 算）
  assert.equal(liquidDecision({ ok: true, cutsHsv: 100, cutsLiquid: 39 }).accept, false);
  assert.equal(liquidDecision({ ok: true, cutsHsv: 100, cutsLiquid: 40 }).accept, true);
});

test('e2e: liquid 接管 —— 边界真的来自模型，不是 hsv', async (t) => {
  if (!hasFfmpeg) return t.skip('ffmpeg not on PATH');
  if (!existsSync(DEPLOY_MODEL)) return t.skip(`部署模型不在：${DEPLOY_MODEL}`);

  const dir = await mkdtemp(join(tmpdir(), 'dsh-liquid-'));
  try {
    const file = await makeColorFixture(dir);
    const base = {
      input: file, transcript: 'off', cache: false, audioStrip: false, encode: true,
    };
    const plain = await runStoryboard({ ...base });
    const log = join(dir, 'shadow-cuts.jsonl');

    // ① 真模型：接管，且刀数就等于模型那侧（hsv 那侧只是对照）
    const r = await runStoryboard({
      ...base, sceneDetector: 'liquid', liquidModel: DEPLOY_MODEL, shadowLog: log,
    });
    assert.equal(r.sceneDetector.requested, 'liquid');
    assert.equal(r.sceneDetector.applied, 'liquid', r.sceneDetector.note);
    assert.equal(r.shadow.ok, true);
    assert.equal(r.cuts.length, r.shadow.cutsLiquid);
    // 模型在纯色片上出的是 1/2/3/4 秒 —— 每个切点都落在整数秒附近
    for (const c of r.cuts) {
      assert.ok(Math.abs(c.t - Math.round(c.t)) < 0.2, `切点 ${c.t} 不像来自模型`);
    }
    assert.equal(JSON.parse((await readFile(log, 'utf8')).trim()).ok, true);

    /**
     * ② 偏置模型（见帧就报）：刀数必须跟着模型走。
     *
     * 这条才是"边界真的换了"的证据 —— ① 里模型和 hsv 恰好都是 4 刀，说明不了问题。
     * ⚠️ 别断言"格数 = 刀数 + 1"：`fillGaps` 会把一屏内的段重新等分去填满，
     * 那是排布的事（hsv 跑同一段也是 4 个格子），跟切点无关。
     */
    const many = await makeBiasedModel(dir, 6);
    const r2 = await runStoryboard({
      ...base, sceneDetector: 'liquid', liquidModel: many, shadowLog: join(dir, 'b.jsonl'),
    });
    assert.equal(r2.sceneDetector.applied, 'liquid', r2.sceneDetector.note);
    assert.ok(r2.shadow.cutsLiquid >= 10, `偏置模型应该出很多刀，实际 ${r2.shadow.cutsLiquid}`);
    assert.equal(r2.cuts.length, r2.shadow.cutsLiquid);
    assert.notEqual(r2.cuts.length, plain.cuts.length, '刀数必须与 hsv 不同，否则模型没真的接管');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('e2e: liquid 模型不出点时兜回 hsv，导出照常、清单写明原因', async (t) => {
  if (!hasFfmpeg) return t.skip('ffmpeg not on PATH');
  if (!existsSync(DEPLOY_MODEL)) return t.skip(`部署模型不在：${DEPLOY_MODEL}`);

  const dir = await mkdtemp(join(tmpdir(), 'dsh-liquid-zero-'));
  try {
    const file = await makeColorFixture(dir);
    const broken = await makeBiasedModel(dir, -30);      // sigmoid(-30) ≈ 0 → 一刀不出
    const r = await runStoryboard({
      input: file, transcript: 'off', cache: false, audioStrip: false, encode: true,
      sceneDetector: 'liquid', liquidModel: broken, shadowLog: join(dir, 'l.jsonl'),
    });
    assert.equal(r.sceneDetector.applied, 'hsv');
    assert.match(r.sceneDetector.note, /0 刀/);
    assert.ok(r.cuts.length > 0, '退回 hsv 之后刀还得在');
    assert.equal(r.sheets.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('e2e: liquid 模型文件不存在 → 退回 hsv，导出照常', async (t) => {
  if (!hasFfmpeg) return t.skip('ffmpeg not on PATH');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-liquid-miss-'));
  try {
    const file = await makeColorFixture(dir);
    const r = await runStoryboard({
      input: file, transcript: 'off', cache: false, audioStrip: false, encode: true,
      sceneDetector: 'liquid', liquidModel: join(dir, 'nope.json'), shadowLog: join(dir, 'l.jsonl'),
    });
    assert.equal(r.sceneDetector.applied, 'hsv');
    assert.match(r.sceneDetector.note, /模型没跑成/);
    assert.ok(r.sheets.length >= 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('capToOneSheet: 只有 brief（一图）档才合并，合并量记在 trace 里', async () => {
  const { capToOneSheet } = await import('../src/storyboard/cuts.js');
  // 120 刀、每 0.1 秒一个 —— 任何策略都装不进一屏，但只有 brief 会动手
  const many = Array.from({ length: 120 }, (_, i) => ({ t: +(i * 0.1).toFixed(2), score: 90 }));

  const plain = capToOneSheet(many, { strategy: 'compact', capGap: 0 });
  assert.equal(plain.cuts.length, 120);
  assert.equal(plain.trace, null);

  const brief = capToOneSheet(many, { strategy: 'brief', capGap: 0 });
  assert.ok(brief.cuts.length < 120, 'brief 要把刀压进一屏');
  assert.ok(brief.cuts.length + 1 <= 56, `一屏最多 56 格，实际 ${brief.cuts.length + 1}`);
  assert.match(brief.trace, /^merge:120->\d+@[\d.]+s$/);
  // 合并只是删点，不改时间戳
  for (const c of brief.cuts) assert.ok(many.some((m) => m.t === c.t));
});

test('接线：video.json 的 sceneDetector/liquidModel 会变成 runStoryboard 的入参', async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { boardOptions } = await import('../src/storyboard/board.js');
  const { runOptionsFromCli } = await import('../src/storyboard/cli-options.js');

  const home = await mkdtemp(join(tmpdir(), 'dsh-scene-cfg-'));
  const prev = process.env.DSH_HOME;
  try {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'video.json'), JSON.stringify({
      sceneDetector: 'liquid',
      liquidModel: 'D:/models/x.json',
      shadowStride: 2,
    }), 'utf8');
    process.env.DSH_HOME = home;

    // 工具路径（board）：默认 kind 也要带上——三条工具入口共用同一份 options
    const o = boardOptions({ input: 'a.mp4' }, { kind: 'board' });
    assert.equal(o.sceneDetector, 'liquid');
    assert.equal(o.liquidModel, 'D:/models/x.json');
    assert.equal(o.shadowStride, 2);
    assert.ok(o.shadowLog, '日志路径要显式传下去，别让下游再猜一次');

    /**
     * 没配时带的是**默认算法**（lnn → 内部名 liquid）。
     *
     * 这条以前断言的是"一个字段都不塞"（当时默认 hsv，塞了就等于改了行为）。
     * 2026-11-22 默认改成 lnn 之后，"什么都不配"本身就是要开模型，所以必须显式往下传 ——
     * 否则 `runStoryboard` 那头还得自己再猜一次默认值，两处迟早会漂。
     */
    writeFileSync(join(home, 'video.json'), JSON.stringify({}), 'utf8');
    const plain = boardOptions({ input: 'a.mp4' }, { kind: 'board' });
    assert.equal(plain.sceneDetector, 'liquid', '空配置 = 默认 lnn');
    assert.equal('liquidModel' in plain, false, '模型路径没配就往下传空，由 shadow 兜内置模型');
    assert.ok(plain.shadowLog, '日志路径要显式传下去');

    // 显式写 hsv 才是"关掉模型"，而且此时才回到"不多塞字段"的老形态
    writeFileSync(join(home, 'video.json'), JSON.stringify({ sceneDetector: 'hsv' }), 'utf8');
    const off = boardOptions({ input: 'a.mp4' }, { kind: 'board' });
    assert.equal('sceneDetector' in off, false, '显式 hsv = 与改动前逐字节一致');
    assert.equal('liquidModel' in off, false);
    assert.equal('shadowLog' in off, false);

    // CLI 路径：显式开关才透传（CLI 一贯不读 video.json 的 storyboard.*）
    const cli = runOptionsFromCli({
      opt: { scene: 'liquid', model: 'D:/m.json', 'shadow-stride': 3, 'shadow-log': 'D:/l.jsonl' },
      geom: { budget: 1000, maxCanvasSide: 800 },
      input: 'a.mp4',
      fetchOptions: {},
    });
    assert.equal(cli.sceneDetector, 'liquid');
    assert.equal(cli.liquidModel, 'D:/m.json');
    assert.equal(cli.shadowStride, 3);
    assert.equal(cli.shadowLog, 'D:/l.jsonl');
    const bare = runOptionsFromCli({ opt: {}, geom: { budget: 1000, maxCanvasSide: 800 }, input: 'a.mp4', fetchOptions: {} });
    assert.equal('sceneDetector' in bare, false, '没给 --scene 就该和以前完全一样');
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
    await rm(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 帧复用（帧出口）

/**
 * 帧复用是"扫描顺便把帧喂给模型"的那条路（`shadow.openFrameTap`）。
 * 它省掉了模型那一遍的**整次解码**（实测 60s 素材 6779ms → 1522ms），
 * 但踩坏任何一条保证都会很难查，所以这里把四条钉住：
 *
 *   ① 默认开（`shadowFrames` 缺省 = `tap`），写 `decode` 才是老行为；
 *   ② 模型加载失败不抛错，`onFrame` 为 null，扫描照常；
 *   ③ 喂过帧 → `framesFrom: 'tap'`，且切点与"自己解码"**逐点相同**；
 *   ④ 一帧都没喂（缓存命中的样子）→ 自动退回自己解码；
 *   ⑤ 回调抛错 → 扫描照常跑完，`tapError` 记下原因。
 */

test('readSceneConfig: shadowFrames 缺省 tap，只有显式 decode 才回退', () => {
  const env = { DSH_HOME: 'X:/nope' };
  assert.equal(readSceneConfig({}, { env }).frames, 'tap');
  assert.equal(readSceneConfig({ sceneDetector: 'shadow' }, { env }).frames, 'tap');
  assert.equal(readSceneConfig({ shadowFrames: 'decode' }, { env }).frames, 'decode');
  assert.equal(readSceneConfig({ shadowFrames: 'DECODE' }, { env }).frames, 'decode');
  // 认不出来的值不许当成 decode（静默变慢 = 看起来"优化没生效"）
  assert.equal(readSceneConfig({ shadowFrames: 'nope' }, { env }).frames, 'tap');
});

test('openFrameTap: 模型不存在 → 不抛错、onFrame 为 null、result 为 null', async () => {
  const tap = await openFrameTap({ modelPath: 'X:/definitely-not-here.json', fps: 25 });
  assert.equal(tap.md, null);
  assert.equal(tap.onFrame, null);
  assert.equal(tap.result(), null);
  assert.ok(tap.error && /模型文件不存在/.test(tap.error), `error=${tap.error}`);
});

test('e2e: 帧复用 —— 切点与自己解码逐点相同，且确实没再解码', async (t) => {
  if (!hasFfmpeg) return t.skip('ffmpeg not on PATH');
  if (!existsSync(DEPLOY_MODEL)) return t.skip(`部署模型不在：${DEPLOY_MODEL}`);

  const dir = await mkdtemp(join(tmpdir(), 'dsh-tap-'));
  try {
    const file = await makeColorFixture(dir);          // 5 段纯色各 1s
    const md = await loadLiquidModel(DEPLOY_MODEL);
    // 窗口必须与下面扫描那段**完全一致**：不然比的是两段不同的时间轴
    const win = { input: file, fps: 25, start: 0, end: 4 };

    // 基线：模型自己解一遍
    const plain = await predictCuts({ ...win, md });
    assert.equal(plain.framesFrom, 'decode');
    assert.equal(plain.sampled, 100);

    // 帧复用：扫描顺便喂
    const tap = await openFrameTap({ modelPath: DEPLOY_MODEL, fps: 25 });
    const scan = await scanShots({
      input: file, fps: 25, threshold: 15, start: 0, end: 4, minGap: 0.35,
      ffmpegPath: DEFAULT_FFMPEG, scoreMode: 'mc', onFrame: tap.onFrame,
    });
    assert.equal(scan.tapError, null, `帧出口被关掉了：${scan.tapError}`);
    assert.equal(tap.seen, scan.frames, '帧出口应当看到每一帧（stride=1）');

    const reused = await predictCuts({ ...win, md: tap.md, tapped: tap.result() });
    assert.equal(reused.framesFrom, 'tap');
    assert.equal(reused.sampled, plain.sampled);
    assert.deepEqual(reused.predCuts, plain.predCuts, '两条路的切点必须逐点相同');

    // ④ 一帧都没喂（= 扫描命中缓存）→ 必须自己解码，而不是报"0 帧"
    const empty = await openFrameTap({ modelPath: DEPLOY_MODEL, fps: 25 });
    assert.equal(empty.result(), null);
    const fallback = await predictCuts({ ...win, md: empty.md, tapped: empty.result() });
    assert.equal(fallback.framesFrom, 'decode');
    assert.deepEqual(fallback.predCuts, plain.predCuts);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('e2e: 帧出口回调抛错 → 扫描照常跑完，tapError 记原因', async (t) => {
  if (!hasFfmpeg) return t.skip('ffmpeg not on PATH');

  const dir = await mkdtemp(join(tmpdir(), 'dsh-tap-boom-'));
  try {
    const file = await makeColorFixture(dir);
    let calls = 0;
    const s = await scanShots({
      input: file, fps: 25, threshold: 15, start: 0, end: 4, minGap: 0.35,
      ffmpegPath: DEFAULT_FFMPEG, scoreMode: 'mc',
      onFrame: () => { calls += 1; throw new Error('模型这边炸了'); },
    });
    // 抛错只关掉出口，扫描的产出一个都不能少
    assert.equal(calls, 1, '第一帧抛错后就不该再调');
    assert.equal(s.tapError, '模型这边炸了');
    assert.equal(s.frames, 100);
    assert.ok(s.cuts.length >= 3, `hsv 那侧仍应出点，实际 ${s.cuts.length}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 取帧算法的对外名字

/**
 * 设置页、清单里都说 **`lnn`**；内部实现叫 `liquid`。这层映射只该有一处
 * （`normalizeSceneDetector`）—— 以前 pipeline 里是手写的 `=== 'liquid'` 判断，
 * 加别名时漏改一处就会"选了 lnn 却还是 hsv"，而且看不出来。
 */
test('取帧算法：lnn 是 liquid 的别名，且认得大小写与空白', () => {
  assert.equal(normalizeSceneDetector('lnn'), 'liquid');
  assert.equal(normalizeSceneDetector(' LNN '), 'liquid');
  assert.equal(normalizeSceneDetector('liquid'), 'liquid');
  assert.equal(normalizeSceneDetector('hsv'), 'hsv');
  assert.equal(normalizeSceneDetector('shadow'), 'shadow');
  // 认不出来的值走**默认**（lnn）：写错字和没写对用户是同一件事
  assert.equal(normalizeSceneDetector('canny'), 'liquid');
  assert.equal(normalizeSceneDetector(''), 'liquid', '空值 = 默认算法，不再是 hsv');
  assert.equal(normalizeSceneDetector(undefined), 'liquid');
});

test('取帧算法：清单里显示 lnn，不显示内部名 liquid', () => {
  assert.equal(sceneAlgorithmLabel('liquid'), 'lnn');
  assert.equal(sceneAlgorithmLabel('hsv'), 'hsv');
  assert.equal(sceneAlgorithmLabel('shadow'), 'shadow');
});

test('readSceneConfig: sceneDetector 写 lnn 也能开模型', () => {
  const c = readSceneConfig({ sceneDetector: 'lnn' }, { env: { DSH_HOME: 'X:/nope' } });
  assert.equal(c.mode, 'liquid');
  assert.equal(c.note, null);
});

test('内置模型：没配路径时 loadLiquidModel 用它，且路径是真实的', async () => {
  const md = await loadLiquidModel(null);
  assert.ok(md.path.endsWith('lnn-model.json'), md.path);
  assert.ok(md.model.heads.includes('cut'));
  assert.equal(md.model.dim, md.dim);
});
