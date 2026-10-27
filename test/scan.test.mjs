import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assessMotionDegraded, autoThreshold, capCutsByScore, DEFAULT_THRESHOLD, frameToHsv,
  planAutoThreshold, rgbToHsv, scanSummary, scorePair, suppressClose, SCAN_W,
} from '../src/scan.js';

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

/* ---------------------------------------------------------------- RGB → HSV */

test('rgbToHsv: 六个纯色的色相（0-255 刻度）', () => {
  const cases = [
    [[255, 0, 0], 0],
    [[255, 255, 0], 42.5],
    [[0, 255, 0], 85],
    [[0, 255, 255], 127.5],
    [[0, 0, 255], 170],
    [[255, 0, 255], 212.5],
  ];
  for (const [[r, g, b], hue] of cases) {
    const [h, s, v] = rgbToHsv(r, g, b);
    assert.ok(near(h, hue, 1e-4), `rgb(${r},${g},${b}) hue=${h} 期望 ${hue}`);
    assert.ok(near(s, 255, 1e-4), '纯色饱和度应为 255');
    assert.ok(near(v, 255, 1e-4), '纯色明度应为 255');
  }
});

test('rgbToHsv: 灰阶没有色相与饱和度', () => {
  for (const g of [0, 64, 128, 255]) {
    const [h, s, v] = rgbToHsv(g, g, g);
    assert.equal(h, 0);
    assert.equal(s, 0);
    assert.ok(near(v, g, 1e-4));
  }
});

/* ---------------------------------------------------------------- 打分 */

test('scorePair: 同帧为 0', () => {
  const f = frameToHsv(new Uint8Array(SCAN_W * 4 * 3).fill(128));
  assert.equal(scorePair(f, f), 0);
});

test('scorePair: 黑→白只差明度 → 255/3', () => {
  const black = frameToHsv(new Uint8Array(12 * 3));
  const white = frameToHsv(new Uint8Array(12 * 3).fill(255));
  assert.ok(near(scorePair(black, white), 255 / 3, 1e-4));
});

test('scorePair: 红→绿只差色相 85 → 85/3', () => {
  const px = (r, g, b) => new Uint8Array([r, g, b, r, g, b]);
  assert.ok(near(scorePair(frameToHsv(px(255, 0, 0)), frameToHsv(px(0, 255, 0))), 85 / 3, 1e-4));
});

test('scorePair: 同亮度换色是 ffmpeg 的死角，本实现能抓住', () => {
  // teal(15,118,110) → green(21,128,61)：实测亮度差 0.8%，色相差 24/255
  const a = frameToHsv(new Uint8Array([15, 118, 110]));
  const b = frameToHsv(new Uint8Array([21, 128, 61]));
  const s = scorePair(a, b);
  const lumA = 0.299 * 15 + 0.587 * 118 + 0.114 * 110;
  const lumB = 0.299 * 21 + 0.587 * 128 + 0.114 * 61;
  assert.ok(Math.abs(lumA - lumB) / 255 < 0.02, '两色亮度几乎相同');
  assert.ok(s > 10, `HSV 分数应显著大于亮度差：${s.toFixed(1)}`);
});

test('scorePair: 长度不一致抛错', () => {
  assert.throws(() => scorePair(new Float32Array(3), new Float32Array(6)), RangeError);
});

/* ---------------------------------------------------------------- 切点抑制 */

test('suppressClose: 保留窗口内分数更高的那个', () => {
  const cuts = [{ t: 1.0, score: 30 }, { t: 1.1, score: 50 }, { t: 2.0, score: 20 }];
  const out = suppressClose(cuts, 0.35);
  assert.deepEqual(out.map((c) => c.t), [1.1, 2.0]);
});

test('suppressClose: 间隔足够时全部保留（且按时间排序）', () => {
  const out = suppressClose([{ t: 2, score: 30 }, { t: 1, score: 40 }], 0.35);
  assert.deepEqual(out.map((c) => c.t), [1, 2]);
});

test('默认阈值落在"能抓住同亮度换色"的区间', () => {
  assert.ok(DEFAULT_THRESHOLD >= 12 && DEFAULT_THRESHOLD <= 20, `实得 ${DEFAULT_THRESHOLD}`);
});

/* ---------------------------------------------------------------- 自适应阈值 */

test('autoThreshold: 静止素材（分数全在 3 以下）被 floor 兜住', () => {
  const scores = Array.from({ length: 1000 }, () => Math.random() * 2.5);
  const th = autoThreshold(scores, { duration: 251 });
  assert.ok(th >= 12 && th < 12.001, `实得 ${th}`);
});

test('autoThreshold: 目标速率约等于 1 个切点 / 1.5s', () => {
  const scores = Array.from({ length: 3000 }, () => Math.random() * 100);
  const th = autoThreshold(scores, { duration: 300 });     // 目标 200 个
  const above = scores.filter((v) => v > th).length;
  assert.ok(Math.abs(above - 200) < 60, `实得 ${above} 个，期望≈200`);
});

test('autoThreshold: 同样分布，时长越长阈值越高（速率法自洽）', () => {
  const scores = Array.from({ length: 1000 }, (_, i) => i / 10);   // 0..100 均匀
  const short = autoThreshold(scores, { duration: 40 });
  const long = autoThreshold(scores, { duration: 400 });
  assert.ok(short > long, `short=${short} 应大于 long=${long}`);
});

test('autoThreshold: 快剪素材不会被推到切点带里（3×p95 的死因）', () => {
  // 复刻概念 PV：p90=26、p95=43、p99=85，大量帧本身就是切点
  const scores = [];
  for (let i = 0; i < 2160; i++) scores.push(Math.random() * 26);
  for (let i = 0; i < 216; i++) scores.push(26 + Math.random() * 60);
  for (let i = 0; i < 100; i++) scores.push(85 + Math.random() * 40);
  const th = autoThreshold(scores, { duration: 90 });
  const cuts = scores.filter((v) => v > th).length;
  assert.ok(cuts >= 20, `90s 快剪素材至少该有 20 个切点，实得 ${cuts}（th=${th}）`);
  // 对照：倍数法（3×p95=129）会给出 0 个切点，速率法必须给出一批
  assert.ok(cuts <= 200, `也不该泛滥，实得 ${cuts}`);
});

test('autoThreshold: 目标数上限为帧数的 25%', () => {
  const scores = Array.from({ length: 1000 }, () => Math.random() * 100);
  const th = autoThreshold(scores, { duration: 1e6 });   // 时长极长 → 目标被 25% 上限截住
  const above = scores.filter((v) => v > th).length;
  assert.ok(above >= 200 && above <= 320, `实得 ${above}`);
});

test('autoThreshold: 短片自动收紧粒度（5s 的片子不该只给 3 个名额）', () => {
  const scores = Array.from({ length: 124 }, () => 0);
  [28.67, 29, 42.78, 57].forEach((v, i) => { scores[120 + i] = v; });
  const th = autoThreshold(scores, { duration: 5 });
  assert.ok(th <= 28, `阈值 ${th} 会把 28.67 的切点砍掉`);
  assert.equal(scores.filter((v) => v > th).length, 4);
});

test('autoThreshold: 空输入不炸', () => {
  assert.equal(autoThreshold([]), 12);
  assert.equal(autoThreshold(undefined), 12);
});

test('autoThreshold: 同分整簇不会因 >= 被整批带进', () => {
  const scores = Array.from({ length: 200 }, () => 10)
    .concat(Array.from({ length: 100 }, () => 40))
    .concat([80, 90, 95, 99]);
  const { threshold, target } = planAutoThreshold(scores, { duration: 40, minGap: 1.5 });
  assert.ok(threshold > 40 && threshold < 41, `th=${threshold}`);
  const above = scores.filter((v) => v > threshold);
  assert.ok(above.length <= target + 5, `> 过滤后 ${above.length}，target=${target}`);
  assert.ok(!above.includes(40), '恰好等于分位的同分簇应被挡在门外');
});

test('capCutsByScore: suppressClose 后仍超 target 时按分截断', () => {
  const cuts = [
    { t: 1, score: 20 }, { t: 2, score: 50 }, { t: 3, score: 30 },
    { t: 4, score: 80 }, { t: 5, score: 10 },
  ];
  const out = capCutsByScore(cuts, 2);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((c) => c.t), [2, 4]);
});

test('assessMotionDegraded: 中位镜头极短 + 高分帧多 → motion', () => {
  const stats = [];
  for (let i = 0; i < 100; i++) {
    stats.push({ t: i * 0.1, score: i % 5 === 0 ? 40 : 35 });
  }
  const cuts = stats.filter((_, i) => i % 2 === 0).map((s) => ({ t: s.t, score: s.score }));
  const r = assessMotionDegraded(stats, cuts, { duration: 10 });
  assert.equal(r.degraded, 'motion');
  assert.ok(r.median_shot_sec < 0.5);
});

test('assessMotionDegraded: 正常间隔素材不标 motion', () => {
  const stats = Array.from({ length: 100 }, (_, i) => ({
    t: i * 0.2, score: i === 50 ? 40 : 5,
  }));
  const cuts = [{ t: 5, score: 40 }, { t: 12, score: 40 }];
  const r = assessMotionDegraded(stats, cuts, { duration: 20 });
  assert.equal(r.degraded, false);
});

test('scanSummary: 分位数正确且升序', () => {
  const scores = Array.from({ length: 100 }, (_, i) => i);
  const s = scanSummary(scores);
  assert.equal(s.p50, 50);
  assert.equal(s.p90, 90);
  assert.equal(s.max, 99);
  assert.deepEqual(scanSummary([]), { p50: 0, p90: 0, p95: 0, p99: 0, max: 0, frames: 0 });
});
