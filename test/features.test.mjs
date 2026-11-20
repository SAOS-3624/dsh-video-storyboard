/**
 * features.test.mjs — 14 维特征的行为对拍。
 *
 * 重点不是"算得对"（那是数学），是**语义对**：同一个物理事件必须落在同一维上，
 * 否则后面训练出来的东西无法解释，也没法在线上排查。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FEATURES, DIM, createFeatures, BLK_W, BLK_H, HUE_BINS, SV_BINS,
} from '../src/storyboard/features.js';

const W = 64;
const H = 36;

function solid(hue = 0, sat = 0, val = 100) {
  const a = new Float32Array(W * H * 3);
  for (let i = 0; i < W * H; i += 1) {
    a[i * 3] = hue;
    a[i * 3 + 1] = sat;
    a[i * 3 + 2] = val;
  }
  return a;
}

/** 只改一个块（6×4 网格里的第 bx,by 块）的 V。 */
function patchBlock(base, bx, by, val) {
  const a = new Float32Array(base);
  // 必须用和 analyze() **完全相同的映射** `x*BLK_W/W`。
  // 早先用 `bx*W/BLK_W` 反推边界，在 64/6 这种除不尽的尺寸上会跨到隔壁块，
  // 于是"只改一块"实际改了两块，测试假失败。
  for (let y = 0; y < H; y += 1) {
    if (Math.floor((y * BLK_H) / H) !== by) continue;
    for (let x = 0; x < W; x += 1) {
      if (Math.floor((x * BLK_W) / W) !== bx) continue;
      a[(y * W + x) * 3 + 2] = val;
    }
  }
  return a;
}

const idx = (name) => FEATURES.indexOf(name);
const get = (x, name) => x[idx(name)];

/**
 * **顺序即契约**：老权重、老缓存、报告里的列名全按它对齐。
 *
 * 曾经试过在末尾追加 24 维绝对块亮度（v4），想补上"此刻画面里有什么"这层静态信息，
 * 实测对切点零收益（LR 85.9→85.8，CfC 96.4→96.1），已撤。原因见 `features.js` 的注释：
 * 切点是"变化"任务，静态构图对它没有信息量。
 */
test('特征表：14 维，顺序即契约', () => {
  assert.equal(DIM, 14);
  assert.deepEqual(FEATURES, [
    's_adj', 's_long', 's_mc', 'v_mean', 'fp_dist',
    'blk_mean', 'blk_std', 'blk_max', 'blk_frac',
    'hist_h', 'hist_sv', 'bar', 'dt', 'age',
  ]);
});

test('第一帧：所有差分量都是 0，不产生 NaN', () => {
  const f = createFeatures({ w: W, h: H, fps: 12 });
  const x = f.push(solid(0, 0, 100), 0);
  for (const name of ['s_adj', 's_long', 'fp_dist', 'blk_mean', 'blk_std', 'blk_max', 'blk_frac', 'hist_h', 'hist_sv']) {
    assert.equal(get(x, name), 0, `${name} 应为 0`);
  }
  // 返回的是 Float32Array，1/12 存进去会被截断到 float32 —— 必须用近似比较
  assert.ok(Math.abs(get(x, 'v_mean') - 100) < 1e-6);
  assert.ok(Math.abs(get(x, 'dt') - 1 / 12) < 1e-6, `dt=${get(x, 'dt')}`);
  assert.ok(get(x, 'age') > 5, 'age 初始应该很大，别让第一帧就被不应期压住');
});

test('相同两帧：差分量全 0', () => {
  const f = createFeatures({ w: W, h: H });
  const a = solid(30, 40, 120);
  f.push(a, 0);
  const x = f.push(a, 0.1);
  for (const name of ['s_adj', 's_long', 'fp_dist', 'blk_mean', 'blk_std', 'blk_max', 'hist_h', 'hist_sv']) {
    assert.equal(get(x, name), 0, `${name} 应为 0`);
  }
});

test('全屏变亮：blk_frac = 1（每一块都变了）', () => {
  const f = createFeatures({ w: W, h: H });
  f.push(solid(0, 0, 50), 0);
  const x = f.push(solid(0, 0, 200), 0.1);
  assert.equal(get(x, 'blk_frac'), 1);
  assert.ok(get(x, 'blk_mean') > 100);
  assert.equal(get(x, 'blk_std'), 0, '均匀变化时各块一致，方差为 0');
});

/**
 * **这一条是补的：`s_adj` / `s_long` 曾经恒为 0，12 条单测全绿。**
 *
 * 原来只测了"第一帧"和"相同两帧"—— 两种情况本来就该是 0，于是"根本没写进数组"
 * 和"算出来正好是 0"在断言上完全无法区分。缺的是**非零**那半。
 *
 * 后果不是"分数低一点"：`q` 头的 teacher 是 `acc += s_adj`，累加一列 0 得到恒定目标，
 * 整条"自涌现积分取帧"的路就是这么哑掉的。
 */
test('差分量必须真的写进数组：变亮 → s_adj 非零，且与变化幅度同向', () => {
  const small = createFeatures({ w: W, h: H });
  small.push(solid(0, 0, 50), 0);
  const a = small.push(solid(0, 0, 60), 0.1);

  const big = createFeatures({ w: W, h: H });
  big.push(solid(0, 0, 50), 0);
  const b = big.push(solid(0, 0, 200), 0.1);

  assert.ok(get(a, 's_adj') > 0, `小幅变化 s_adj 应 > 0，实际 ${get(a, 's_adj')}`);
  assert.ok(get(b, 's_adj') > get(a, 's_adj') * 3,
    `大幅变化应显著更大：${get(b, 's_adj')} vs ${get(a, 's_adj')}`);
});

test('长时差：渐变在相邻帧上看不见，s_long 才抓得到', () => {
  const fps = 10;
  const f = createFeatures({ w: W, h: H, fps, longSec: 0.4 });   // lag = 4 帧
  // 每帧只加 3 个 V，4 帧累计 12 —— 相邻帧差很小，隔 0.4s 就明显了
  const seq = [];
  for (let i = 0; i < 8; i += 1) seq.push(solid(0, 0, 60 + i * 3));
  let x = f.push(seq[0], 0);
  for (let i = 1; i < seq.length; i += 1) x = f.push(seq[i], i / fps);

  assert.ok(get(x, 's_adj') > 0, '相邻帧差应可见');
  assert.ok(get(x, 's_long') > get(x, 's_adj') * 3,
    `0.4s 的累计变化应远大于单帧：s_long=${get(x, 's_long')} s_adj=${get(x, 's_adj')}`);
});

test('单块变化：blk_max 大但 blk_frac 小 —— 这是"局部换"与"全局闪"的分界', () => {
  const f = createFeatures({ w: W, h: H });
  const base = solid(0, 0, 50);
  f.push(base, 0);
  const x = f.push(patchBlock(base, 2, 1, 250), 0.1);
  assert.ok(get(x, 'blk_max') > 150, `blk_max=${get(x, 'blk_max')}`);
  assert.ok(get(x, 'blk_frac') <= 1 / (BLK_W * BLK_H) + 1e-6, `blk_frac=${get(x, 'blk_frac')}`);
  assert.ok(get(x, 'blk_std') > 10, '一块突出，方差必然被拉开');
});

test('同亮度换色：hist_h 抓得到，v_mean 不动', () => {
  const f = createFeatures({ w: W, h: H });
  f.push(solid(10, 200, 150), 0);
  const x = f.push(solid(200, 200, 150), 0.1);
  assert.equal(get(x, 'v_mean'), 150);
  assert.ok(get(x, 'hist_h') > 0.9, `hist_h=${get(x, 'hist_h')}，色相整个换了一边应该是 ~1`);
  assert.equal(get(x, 'blk_mean'), 0, 'V 没变，块级变化为 0 —— 这正是 scdet 失明的地方');
});

test('同色相换明暗：hist_sv 抓得到，hist_h 不动', () => {
  const f = createFeatures({ w: W, h: H });
  f.push(solid(90, 200, 40), 0);
  const x = f.push(solid(90, 200, 220), 0.1);
  assert.ok(get(x, 'hist_sv') > 0.5, `hist_sv=${get(x, 'hist_sv')}`);
  assert.ok(get(x, 'hist_h') < 0.05, `hist_h=${get(x, 'hist_h')}，色相没动`);
});

test('黑边：上下压黑时 bar 接近 1', () => {
  const f = createFeatures({ w: W, h: H });
  const a = solid(0, 0, 180);
  // 上下各 4 行压黑（h=36 时 edge=3，所以 4 行足够）
  for (let y = 0; y < 4; y += 1) {
    for (let x = 0; x < W; x += 1) {
      a[(y * W + x) * 3 + 2] = 0;
      a[((H - 1 - y) * W + x) * 3 + 2] = 0;
    }
  }
  const x = f.push(a, 0);
  assert.equal(get(x, 'bar'), 1);
});

test('dt 随采样间隔走，并夹在合理范围', () => {
  const f = createFeatures({ w: W, h: H, fps: 12 });
  f.push(solid(), 0);
  assert.ok(Math.abs(get(f.push(solid(), 0.5), 'dt') - 0.5) < 1e-6);
  // 间隔太小时钳到 1/(fps*4)
  assert.ok(Math.abs(get(f.push(solid(), 0.505), 'dt') - 1 / 48) < 1e-6, `dt=${get(f.push(solid(), 0.505), 'dt')}`);
  // 间隔太大时钳到 1.0
  assert.ok(Math.abs(get(f.push(solid(), 9), 'dt') - 1.0) < 1e-6);
});

test('discharge 把 age 归零', () => {
  const f = createFeatures({ w: W, h: H });
  f.push(solid(), 0);
  f.push(solid(), 2);
  assert.ok(Math.abs(get(f.push(solid(), 3), 'age') - 13) < 1e-5, '初始 AGE_INIT=10，3 秒后是 13');
  f.discharge(3);
  assert.ok(Math.abs(get(f.push(solid(), 3.5), 'age') - 0.5) < 1e-6);
});

test('返回的是复用缓冲：调用方必须立刻消费', () => {
  const f = createFeatures({ w: W, h: H });
  const a = f.push(solid(0, 0, 10), 0);
  const b = f.push(solid(0, 0, 20), 0.1);
  assert.equal(a, b, '同一个 Float32Array —— 这是刻意的，避免每帧分配');
});

test('尺寸不对要抛错，不要静默算出垃圾', () => {
  const f = createFeatures({ w: W, h: H });
  assert.throws(() => f.push(new Float32Array(100), 0), /帧长度/);
  assert.throws(() => createFeatures({ w: 0, h: 0 }), /w\/h/);
});
