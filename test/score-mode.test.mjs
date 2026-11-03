/**
 * score-mode.test.mjs — 两个可选打分口径的守卫。
 *
 * 这两条路径默认关闭（`scoreMode: 'abs'`），但一旦有人打开，出错的方式很隐蔽：
 * 邻域搜索写错会让"平移"也被算成换场景（正是它要解决的问题），归一化写错会让阈值失去意义。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { mcRatioScore, zScores } from '../src/storyboard/scan.js';

const W = 8;
const H = 6;
const N = W * H;

/** 造一帧 HSV：底色 + 可选竖条纹 */
function frame({ hue = 10, stripe = false, offset = 0 } = {}) {
  const a = new Float32Array(N * 3);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const i = (y * W + x) * 3;
      const on = stripe && ((x + offset) % 2 === 0);
      a[i] = on ? 240 : hue;
      a[i + 1] = 200;
      a[i + 2] = on ? 240 : 120;
    }
  }
  return a;
}

test('mcRatioScore：同一帧比对，一个格子都不该"变"', () => {
  const a = frame({});
  assert.equal(mcRatioScore(a, frame({}), W, H), 0);
});

test('mcRatioScore：整屏换色 → 全部判为变化', () => {
  // 色相按环形处理，10 与 240 只差 25°（相邻），要取真正隔开的两端
  const ratio = mcRatioScore(frame({ hue: 10 }), frame({ hue: 130 }), W, H);
  assert.equal(ratio, 1, `应全部记为变化，实际 ${ratio}`);
});

test('mcRatioScore：整体平移一格应被邻域吸收（运动补偿的本意）', () => {
  const a = frame({ stripe: true, offset: 0 });
  const b = frame({ stripe: true, offset: 1 });
  // 不搜索 = 纯逐格差：一半格子变了
  const noSearch = mcRatioScore(a, b, W, H, { radius: 0 });
  assert.ok(noSearch > 0.4, `无搜索时应大片判为变化，实际 ${noSearch}`);
  // 半径 1 的搜索：每格都能在邻域找到同色格 → 不该再判为变化
  const searched = mcRatioScore(a, b, W, H, { radius: 1 });
  assert.equal(searched, 0, `平移应被吸收，实际 ${searched}`);
});

test('zScores：平稳序列的 z 很小，孤立尖峰很大', () => {
  const flat = new Array(400).fill(5);
  const zf = zScores(flat, 300);
  for (let i = 0; i < flat.length; i += 1) {
    assert.ok(Math.abs(zf[i]) <= 1.5, `平稳序列不该有大 z，第 ${i} 帧 ${zf[i]}`);
  }
  // 中间插一个尖峰
  const spiked = flat.slice();
  spiked[200] = 120;
  const zs = zScores(spiked, 300);
  assert.ok(zs[200] > 3, `尖峰应明显高于噪声，实际 ${zs[200]}`);
  assert.ok(zs[100] < 1.5, `尖峰之外的帧不该被带偏，实际 ${zs[100]}`);
});

test('zScores：全零序列不产生 NaN/Infinity', () => {
  const z = zScores(new Array(50).fill(0), 10);
  for (const v of z) assert.ok(Number.isFinite(v), `出现非有限值 ${v}`);
});

// ---- 尖峰门（decideCuts 用，按密度门控） ----
import { applySpikeGate } from '../src/storyboard/scan.js';

const flat = (n, v = 5, dt = 0.04) => Array.from({ length: n }, (_, i) => ({ t: i * dt, score: v }));

test('尖峰门：孤立尖峰保留，运动平台被砍掉', () => {
  const dt = 0.04;
  // ① 孤立尖峰：第 100 帧 200 分，左右都是 5
  const a = flat(200);
  a[100].score = 200;
  const cuts = [{ t: a[100].t, score: 200 }];
  assert.equal(applySpikeGate(cuts, a, dt).length, 1, '孤立尖峰应保留');

  // ② 运动平台：连续 10 帧都是 60，代表帧的邻域一样高
  const b = flat(200);
  for (let i = 95; i < 105; i += 1) b[i].score = 60;
  const motion = [{ t: b[100].t, score: 60 }];
  assert.equal(applySpikeGate(motion, b, dt).length, 0, '运动平台应被砍掉');

  // ③ 邻域全 0 时不能"因为分母是 0 就全放过"——floor 兜住
  const c = flat(200, 0);
  c[100].score = 3;
  assert.equal(applySpikeGate([{ t: c[100].t, score: 3 }], c, dt).length, 0, '低于 floor 的弱尖峰不放行');
});

test('尖峰门：空输入不炸；k=0 等于不设比值门槛（任何正分都过）', () => {
  assert.deepEqual(applySpikeGate([], [], 0.04), []);
  const s = flat(10);
  assert.equal(applySpikeGate([{ t: 0.2, score: 5 }], s, 0.04, { k: 0 }).length, 1);
  // 关掉整道门由调用方负责（decideCuts 的 spikeK=0 直接不调用），这里只守函数本身
});
