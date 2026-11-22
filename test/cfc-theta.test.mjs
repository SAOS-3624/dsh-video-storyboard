/**
 * cfc-theta.test.mjs — 自适应阈值 `pickTheta` 的语义测试。
 *
 * 它回答的是一个很具体的问题：**同一条概率序列，阈值该定在哪**。
 * 重点不是"算得快"，是三条语义：
 *   1. 安静的片子，阈值贴地板（不然会把噪声当刀）；
 *   2. 吵的片子，阈值跟着抬（不然整段都会过线）；
 *   3. **局部**吵也要跟着抬 —— 慢片里夹一段快剪时，那一段不能整段被切开。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { pickTheta } from '../src/storyboard/cfc.js';

const FPS = 25;

/** 造一条概率序列：平时 base，每隔 gap 帧给一个 peak（模拟一刀）。 */
function series({ frames, base, peaks = [], peak = 0.99 }) {
  const p = new Float32Array(frames).fill(base);
  for (const f of peaks) p[f] = peak;
  return p;
}

test('空序列 / 全零：落在下限，不返回 NaN', () => {
  assert.equal(pickTheta(new Float32Array(0)), 0.5);
  assert.equal(pickTheta(series({ frames: 1000, base: 0 })), 0.5);
});

test('安静的片子：噪声 p95 极低 → 阈值贴地板（0.5）', () => {
  // 每 300 帧一刀（12 秒一镜），其余帧几乎为 0
  const peaks = [];
  for (let f = 300; f < 3000; f += 300) peaks.push(f);
  const p = series({ frames: 3000, base: 0.01, peaks });
  assert.equal(pickTheta(p, { fps: FPS }), 0.5);
});

test('吵的片子：噪声 p95 高 → 阈值跟着抬，且高于安静片', () => {
  const quiet = series({ frames: 3000, base: 0.01 });
  const noisy = series({ frames: 3000, base: 0.8 });
  const tq = pickTheta(quiet, { fps: FPS });
  const tn = pickTheta(noisy, { fps: FPS });
  assert.ok(tn > tq, `吵的应该更高：${tn} vs ${tq}`);
  assert.ok(tn >= 0.8, `噪声 0.8 时阈值不该低于它：${tn}`);
});

test('单调：噪声越高，阈值不降', () => {
  let prev = -1;
  for (const base of [0.0, 0.1, 0.3, 0.5, 0.8, 0.95]) {
    const t = pickTheta(series({ frames: 4000, base }), { fps: FPS });
    assert.ok(t >= prev, `base=${base} 时 ${t} < ${prev}`);
    prev = t;
  }
});

test('上限夹住：噪声 1.0 也不会把 θ 抬到 1（否则一刀都出不来）', () => {
  const t = pickTheta(series({ frames: 2000, base: 1 }), { fps: FPS });
  assert.equal(t, 0.95);
});

test('局部：慢片里夹一段快剪，阈值按最吵那段定', () => {
  // 0~30s 安静（p95≈0.01），30~60s 吵（0.85），之后又安静
  const frames = 150 * FPS;
  const p = new Float32Array(frames).fill(0.01);
  for (let f = 30 * FPS; f < 60 * FPS; f += 1) p[f] = 0.85;
  const t = pickTheta(p, { fps: FPS });
  assert.ok(t >= 0.85, `应该按最吵那段（0.85）定，实际 ${t}`);
});

test('短于一个窗口：整段一起算，不崩', () => {
  const p = series({ frames: 100, base: 0.7 });
  const t = pickTheta(p, { fps: FPS });
  assert.ok(Number.isFinite(t) && t >= 0.5 && t <= 0.95);
});

test('k 与 clamp 可调，且真的生效', () => {
  const p = series({ frames: 2000, base: 0.4 });
  const a = pickTheta(p, { fps: FPS, k: 1.0 });
  const b = pickTheta(p, { fps: FPS, k: 1.5 });
  assert.ok(b > a, 'k 变大阈值应该变大');
  assert.equal(pickTheta(p, { fps: FPS, k: 9, hi: 0.97 }), 0.97);
  assert.equal(pickTheta(p, { fps: FPS, lo: 0.6, hi: 0.6 }), 0.6);
});
