import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assessDegraded, autoThreshold, barFraction, cutBudget, cutsFromEvents, decideCuts,
  DEFAULT_THRESHOLD, detectGradual, frameToHsv, normalizeScores, quantile, rgbToHsv,
  scanSummary, scorePair, spikeCuts,
  suppressClose, SCAN_W,
} from '../src/storyboard/scan.js';

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

test('scorePair: 色相跨 0° 时按环形算（红色→品红不该算成巨变）', () => {
  // 0° 与 359°（255 刻度里是 0 与 254）只差 1，不该被当成差 254
  const one = (r, g, b) => frameToHsv(new Uint8Array([r, g, b]));
  const red = one(255, 0, 0);
  const wrap = scorePair(red, one(255, 0, 6));       // 极靠近 0° 的另一侧
  const across = scorePair(red, one(0, 0, 255));     // 240°，真实的远距离
  assert.ok(wrap < 2, `跨 0° 的分数应该很小，实得 ${wrap}`);
  // 红(0°) → 蓝(240°)：环形最短路径是 120°，折算 85/255 → 85/3 ≈ 28.3
  assert.ok(across > 20, `真正的远色相应该明显更大，实得 ${across}`);
});

test('scorePair: 近灰像素的色相噪声不该算成切点', () => {
  // 肉眼完全一样的两帧：色相被编码噪声甩到色环两端，但两者饱和度几乎为 0
  const one = (r, g, b) => frameToHsv(new Uint8Array([r, g, b]));
  const s1 = scorePair(one(128, 128, 127), one(128, 127, 128));
  assert.ok(s1 < 1, `近灰的变化应接近 0，实得 ${s1.toFixed(2)}`);
});

test('scorePair: 高饱和度的色相变化仍然要算', () => {
  const one = (r, g, b) => frameToHsv(new Uint8Array([r, g, b]));
  const s1 = scorePair(one(255, 0, 0), one(0, 255, 0));
  assert.ok(s1 > 20, `饱和色的换色必须还能抓到，实得 ${s1.toFixed(2)}`);
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
  assert.equal(autoThreshold(scores, { duration: 251 }), 12);
});

test('autoThreshold: 目标速率约等于 1 个切点 / 1.5s', () => {
  const scores = Array.from({ length: 3000 }, () => Math.random() * 100);
  const th = autoThreshold(scores, { duration: 300 });     // 目标 200 个
  const above = scores.filter((v) => v >= th).length;
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
  const cuts = scores.filter((v) => v >= th).length;
  assert.ok(cuts >= 20, `90s 快剪素材至少该有 20 个切点，实得 ${cuts}（th=${th}）`);
  // 关键：倍数法（3×p95=129）会给出 0 个切点，速率法必须给出一批
  assert.ok(cuts <= 200, `也不该泛滥，实得 ${cuts}`);
});

test('autoThreshold: 目标数上限为帧数的 25%', () => {
  const scores = Array.from({ length: 1000 }, () => Math.random() * 100);
  const th = autoThreshold(scores, { duration: 1e6 });   // 时长极长 → 目标被 25% 上限截住
  const above = scores.filter((v) => v >= th).length;
  assert.ok(above >= 200 && above <= 320, `实得 ${above}`);
});

test('autoThreshold: 短片自动收紧粒度（5s 的片子不该只给 3 个名额）', () => {
  const scores = Array.from({ length: 124 }, () => 0);
  [28.67, 29, 42.78, 57].forEach((v, i) => { scores[120 + i] = v; });
  const th = autoThreshold(scores, { duration: 5 });
  assert.ok(th <= 28, `阈值 ${th} 会把 28.67 的切点砍掉`);
  assert.equal(scores.filter((v) => v >= th).length, 4);
});

test('autoThreshold: 空输入不炸', () => {
  assert.equal(autoThreshold([]), 12);
  assert.equal(autoThreshold(undefined), 12);
});

test('scanSummary: 分位数正确且升序', () => {
  const scores = Array.from({ length: 100 }, (_, i) => i);
  const s = scanSummary(scores);
  assert.equal(s.p50, 50);
  assert.equal(s.p90, 90);
  assert.equal(s.max, 99);
  assert.deepEqual(scanSummary([]), { p50: 0, p90: 0, p95: 0, p99: 0, max: 0, frames: 0 });
});

test('assessDegraded: 运镜被切碎时标成 motion', () => {
  // 30 秒 100 刀（中位 0.3s）+ 40% 帧超阈值 → 典型的匀速运镜被逐帧切
  assert.equal(assessDegraded({ span: 30, cuts: 100, hotRatio: 0.4 }), 'motion');
});

test('assessDegraded: 正常剪辑不标', () => {
  assert.equal(assessDegraded({ span: 30, cuts: 15, hotRatio: 0.4 }), null);   // 中位 2s
  assert.equal(assessDegraded({ span: 30, cuts: 100, hotRatio: 0.1 }), null);  // 高分帧很少
  assert.equal(assessDegraded({ span: 0, cuts: 5, hotRatio: 0.9 }), null);
  assert.equal(assessDegraded({ span: 30, cuts: 0, hotRatio: 0.9 }), null);
});

test('quantile: 取低分位用于"这片就是很快"的阈值', () => {
  const scores = [3, 26, 30, 36, 39, 39, 50, 52, 55, 57, 60, 61, 62, 63, 77, 78, 89];
  assert.equal(quantile(scores, 0.10), 26);
  assert.equal(quantile(scores, 0.50), 55);
  assert.equal(quantile([], 0.1), 0);
});

test('decideCuts: 同一份逐帧分数可以用不同间隔重判（细判不需要重读视频）', () => {
  // 每两帧一刀（25fps 下 0.04s 一个镜头），分数 70，「不动」的帧是 5
  const stats = Array.from({ length: 50 }, (_, i) => ({ t: i / 25, score: i % 2 ? 70 : 5 }));
  // 关掉自适应半径：这条测的是 minGap 这个旋钮本身有没有用
  const coarse = decideCuts(stats, { threshold: 'auto-low', minGap: 0.35, duration: 2, adaptiveGap: false });
  const fine = decideCuts(stats, { threshold: 'auto-low', minGap: 1.02 / 25, duration: 2, adaptiveGap: false });
  assert.ok(coarse.cuts.length <= 5, `粗间隔应该把密刀并掉，实得 ${coarse.cuts.length}`);
  assert.ok(fine.cuts.length >= 20, `一帧间隔应数出几乎每一刀，实得 ${fine.cuts.length}`);
});

test('decideCuts: 自适应半径 —— 0.32s 的快剪不再被"隔一刀留一刀"', () => {
  // 复刻实测：12 镜 / 每镜 8 帧 / 25fps，切点处 20 分，镜头内 3 分
  const stats = [];
  for (let i = 0; i < 96; i++) stats.push({ t: i / 25, score: i % 8 === 0 && i > 0 ? 20 : 3 });
  const auto = decideCuts(stats, { threshold: 12, minGap: 0.35, duration: 3.84 });
  const fixed = decideCuts(stats, { threshold: 12, minGap: 0.35, duration: 3.84, adaptiveGap: false });
  assert.ok(fixed.cuts.length <= 6, `固定半径下本来就只能数出一半，实得 ${fixed.cuts.length}`);
  assert.ok(auto.cuts.length >= 11, `自适应半径应该把 11 刀全数出来，实得 ${auto.cuts.length}`);
  // 位置也要对：不能只多报，还得报在真切点上
  const drift = auto.cuts.filter((c) => Math.abs(c.t * 25 % 8) > 1.5 && Math.abs((c.t * 25) % 8) < 6.5);
  assert.equal(drift.length, 0, `不该有偏离切点的刀：${drift.map((c) => c.t.toFixed(2)).join(',')}`);
});

test('decideCuts: 一帧之内的两帧同属一刀（不能算成两个切点）', () => {
  // 硬切常常横跨两帧：第 40、41 帧都在阈值之上
  const stats = Array.from({ length: 100 }, (_, i) => ({
    t: i / 25, score: i === 40 || i === 41 ? 60 : 2,
  }));
  const r = decideCuts(stats, { threshold: 12, minGap: 0.35, duration: 4 });
  assert.equal(r.cuts.length, 1, `同一刀横跨两帧应只报一个，实得 ${r.cuts.length}`);
  assert.equal(r.cuts[0].score, 60);
});

test('decideCuts: auto-low 用本段自己的低分位，不会被全片平均带偏', () => {
  const flat = Array.from({ length: 40 }, (_, i) => ({ t: i / 25, score: 30 }));
  const r = decideCuts(flat, { threshold: 'auto-low', minGap: 1.02 / 25, duration: 1.6 });
  // 全段同分：阈值取到同分本身，严格大于挡掉整簇 —— 不该报出一堆假刀
  assert.ok(r.cuts.length <= 1, `同分帧不该整簇进来，实得 ${r.cuts.length}`);
});

/* ---------------------------------------------------------------- 相对基线找切 */

test('spikeCuts: PPT 型（基线接近 0，小改动也要抓到）', () => {
  // 平时 0.3，第 50 帧出现一个 6 分的改动 —— 固定阈值 15 会漏掉，相对基线是 20 倍
  const stats = Array.from({ length: 100 }, (_, i) => ({ t: i / 12, score: i === 50 ? 6 : 0.3 }));
  const cuts = spikeCuts(stats, { k: 3, minAbs: 1 });
  assert.equal(cuts.length, 1);
  assert.equal(cuts[0].t, 50 / 12);
  assert.ok(cuts[0].ratio >= 10, `相对基线倍数应很大，实得 ${cuts[0].ratio}`);
});

test('spikeCuts: 匀速运镜（基线高但平稳）不该报刀', () => {
  const stats = Array.from({ length: 100 }, (_, i) => ({ t: i / 12, score: 20 + (i % 3) * 0.4 }));
  assert.equal(spikeCuts(stats, { k: 3, minAbs: 6 }).length, 0);
});

test('spikeCuts: 运镜里插一刀仍然能挑出来', () => {
  const stats = Array.from({ length: 100 }, (_, i) => ({ t: i / 12, score: i === 40 ? 70 : 20 }));
  const cuts = spikeCuts(stats, { k: 3, minAbs: 6 });
  assert.equal(cuts.length, 1);
  assert.equal(cuts[0].t, 40 / 12);
});

/* ---------------------------------------------------------------- 分数归一（暗场 / 黑边） */

test('normalizeScores: 亮画面一个字节都不动（老口径、老阈值全保留）', () => {
  const stats = [{ t: 1, score: 25 }, { t: 2, score: 12.2 }];
  const means = [0, 200, 224];        // stats[i] 对应 means[i+1]
  assert.deepEqual(normalizeScores(stats, means), stats);
});

test('normalizeScores: 暗场按 3 倍放大（上限），一次真剪辑才够得着门槛 12', () => {
  // 实测暗场：V 均值 42、每刀 3.9–5.6 分 —— 常数门槛 12 全漏
  const stats = [{ t: 1, score: 5 }, { t: 2, score: 5.6 }];
  const out = normalizeScores(stats, [0, 42, 42]);
  assert.ok(out[0].score > 12, `5 分 ×3 应该过门槛，实得 ${out[0].score}`);
  assert.equal(out[0].gain, 3, '增益封顶 3 倍，不能无限放大噪声');
  assert.equal(out[1].score, 16.800000000000004 > 0 ? out[1].score : 0);
});

test('normalizeScores: 黑边按占比除回来（2.39:1 遮幅 ≈ 25%）', () => {
  // 黑边上的差恒为 0，等于把真变化按 0.744 打折
  const out = normalizeScores([{ t: 1, score: 11.8 }], [0, 169], { barFrac: 0.256 });
  assert.ok(Math.abs(out[0].score - 11.8 / 0.744) < 0.01, `实得 ${out[0].score}`);
});

test('normalizeScores: 没有亮度序列时保持原样（不猜）', () => {
  const stats = [{ t: 1, score: 5 }];
  assert.deepEqual(normalizeScores(stats, undefined), stats);
});

test('barFraction: 上下各 12% 黑边 → 0.24', () => {
  const h = 36;
  const rowV = Array.from({ length: h }, (_, y) => (y < 4 || y >= 32 ? 0 : 200));
  const rowVMax = Array.from({ length: h }, (_, y) => (y < 4 || y >= 32 ? 0 : 240));
  assert.equal(barFraction({ rowV, rowVMax, frames: 100 }), +(8 / h).toFixed(3));
});

test('barFraction: 片头黑场不算黑边（后来亮了）', () => {
  // fadeclips：前 2 秒全黑，但同一窗里后来亮了 → 累计均值和峰值都会上去
  const rowV = Array.from({ length: 36 }, () => 120);
  const rowVMax = Array.from({ length: 36 }, () => 244);
  assert.equal(barFraction({ rowV, rowVMax, frames: 200 }), 0);
});

test('barFraction: 整段全黑（片尾黑场）不做补偿', () => {
  const rowV = Array.from({ length: 36 }, () => 0);
  const rowVMax = Array.from({ length: 36 }, () => 2);
  assert.equal(barFraction({ rowV, rowVMax, frames: 200 }), 0);
});

/* ---------------------------------------------------------------- 事件聚类 / 自适应半径 */

test('cutsFromEvents: 同一刀横跨两帧只算一次', () => {
  const above = [{ t: 1.60, score: 40 }, { t: 1.64, score: 55 }, { t: 3.00, score: 30 }];
  const cuts = cutsFromEvents(above, 0.04, { minGap: 0.35 });
  assert.deepEqual(cuts.map((c) => c.t), [1.64, 3.0]);
  assert.equal(cuts[0].score, 55);
});

test('cutsFromEvents: 0.32s 的快剪不会被成对合并', () => {
  // 实测 12 镜 0.32s：固定 0.35 窗口只数出 5 刀（隔一刀留一刀）
  const above = Array.from({ length: 11 }, (_, i) => ({ t: 0.32 * (i + 1), score: 20 }));
  const adaptive = cutsFromEvents(above, 0.04, { minGap: 0.35 });
  const fixed = cutsFromEvents(above, 0.04, { minGap: 0.35, adaptive: false });
  assert.equal(adaptive.length, 11);
  assert.ok(fixed.length <= 6, `固定半径本来就只能数出一半，实得 ${fixed.length}`);
});

test('cutsFromEvents: 正常间隔时 minGap 照旧生效', () => {
  const above = [{ t: 1.0, score: 40 }, { t: 1.2, score: 50 }, { t: 4.0, score: 30 }, { t: 4.15, score: 20 }];
  assert.deepEqual(cutsFromEvents(above, 0.04, { minGap: 0.35 }).map((c) => c.t), [1.2, 4.0]);
});

/* ---------------------------------------------------------------- 渐变转场 */

const lin = (from, to, step, fn) => {
  const out = [];
  for (let t = from; t <= to + 1e-9; t += step) out.push({ t: +t.toFixed(3), score: fn(t) });
  return out;
};

test('detectGradual: 1s 叠化（长时差高、帧差低、前后安静）被找到，位置在转场中心', () => {
  const frame = lin(0, 9, 0.04, (t) => (t > 2 && t < 3 ? 4 : 2));
  const long = lin(0, 9, 0.04, (t) => (t > 2.1 && t < 3.5 ? 22 : 4));
  const g = detectGradual(long, frame, { threshold: 12, lagSec: 0.4 });
  assert.equal(g.length, 1);
  assert.ok(Math.abs(g[0].t - 2.5) < 0.25, `转场中心应在 2.5 附近，实得 ${g[0].t}`);
  assert.equal(g[0].kind, 'gradual');
});

test('detectGradual: 匀速运镜（前后同样吵）不报', () => {
  const frame = lin(0, 9, 0.04, (t) => (t > 1 && t < 8 ? 12 : 3));
  const long = lin(0, 9, 0.04, (t) => (t > 1 && t < 8 ? 22 : 4));
  assert.equal(detectGradual(long, frame, { threshold: 12, lagSec: 0.4 }).length, 0);
});

test('detectGradual: 已经报过的硬切不重复', () => {
  const frame = lin(0, 9, 0.04, () => 2);
  const long = lin(0, 9, 0.04, (t) => (t > 2.0 && t < 2.4 ? 25 : 3));
  assert.equal(detectGradual(long, frame, { threshold: 12, lagSec: 0.4, cuts: [2.0] }).length, 0);
});

test('detectGradual: 单帧尖峰（某一帧抖了一下）不算过渡', () => {
  const frame = lin(0, 9, 0.04, () => 2);
  const long = lin(0, 9, 0.04, (t) => (Math.abs(t - 3) < 0.02 ? 30 : 3));
  assert.equal(detectGradual(long, frame, { threshold: 12, lagSec: 0.4 }).length, 0);
});

/* ---------------------------------------------------------------- 速率预算 */

test('cutBudget: 目标数与间隔', () => {
  const scores = Array.from({ length: 1000 }, () => 5);
  const b = cutBudget(scores, { duration: 300 });
  assert.equal(b.gap, 1.5);
  assert.equal(b.target, 200);
  assert.equal(b.total, 300);
  // 短片收紧粒度：5s 的片子不该只给 3 个名额
  assert.equal(cutBudget(scores, { duration: 5 }).gap, 0.5);
});

/* ---------------------------------------------------------------- 伪切点（spread / 持续运动） */

const mkFrame = (w, h, fn) => {
  const f = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 3;
    const [hh, ss, vv] = fn(x, y);
    f[i] = hh; f[i + 1] = ss; f[i + 2] = vv;
  }
  return f;
};

test('scorePairDetail: 整幅都换 → spread ≈ 1；只换中间一小块 → spread 很小', async () => {
  const { scorePairDetail } = await import('../src/storyboard/scan.js');
  const w = 64; const h = 36;
  const a = mkFrame(w, h, () => [20, 200, 100]);
  const all = mkFrame(w, h, () => [120, 200, 100]);          // 整幅换色（真剪辑）
  const local = mkFrame(w, h, (x, y) => (
    x > w / 3 && x < (2 * w) / 3 && y > h / 3 && y < (2 * h) / 3 ? [200, 200, 220] : [20, 200, 100]
  ));                                                        // 只有中间 1/9 变了（局部换画）

  const whole = scorePairDetail(a, all, { width: w, height: h });
  const part = scorePairDetail(a, local, { width: w, height: h });
  assert.ok(whole.spread > 0.95, `整幅变化应该摊满，实得 ${whole.spread}`);
  assert.ok(part.spread < 0.3, `局部变化不该摊开，实得 ${part.spread}`);
  // 分数本身分不开这两件事：局部那块改得更猛，分数反而更高
  assert.ok(part.score > 0, '局部变化也有分数');
});

test('decideCuts: 持续在动（甩镜/匀速摇镜）不报刀 —— 前后邻域同样吵', () => {
  // 30 帧里每帧都在 25–30 分：这不是剪辑，是镜头在甩
  const stats = Array.from({ length: 40 }, (_, i) => ({
    t: i / 25, score: i > 4 && i < 34 ? 26 + (i % 3) : 1,
  }));
  const r = decideCuts(stats, { threshold: 18, minGap: 0.35, duration: 1.6 });
  assert.equal(r.cuts.length, 0, `持续运动不该报刀，实得 ${r.cuts.length}`);
});

test('decideCuts: 一抹安静里的孤立跳变照样报刀（护栏不能把真刀也挡了）', () => {
  const stats = Array.from({ length: 60 }, (_, i) => ({
    t: i / 25, score: i === 30 ? 70 : 2,
  }));
  const r = decideCuts(stats, { threshold: 18, minGap: 0.35, duration: 2.4 });
  assert.equal(r.cuts.length, 1);
  assert.equal(r.cuts[0].t, 30 / 25);
});
