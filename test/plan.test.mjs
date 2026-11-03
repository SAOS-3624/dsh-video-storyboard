/**
 * plan.test.mjs — 窗口规划（CLI 的 --plan / --batch 用）。
 *
 * 2026-11-01：这个文件原来测的是"格数建议 / 布局 / 可读性 / 音乐驱动判定"，
 * 那些都被 tiers.js（档位）与 pack.js（排布）取代了。现在只剩窗口切分。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { PLAN_IMAGE_TOKENS, planWindows, snapCells } from '../src/storyboard/plan.js';

test('planWindows: 按 step 切满全片，最后一个窗口吸收尾巴', () => {
  const p = planWindows(650, 300);
  // 300 + 300 + 50（尾巴 50s > 30s 保留，不并）
  assert.equal(p.total, 3);
  assert.equal(p.windows[0].from, 0);
  assert.equal(p.windows[0].to, 300);
  assert.equal(p.windows.at(-1).to, 650, '最后一个窗口必须覆盖到片尾');
  assert.equal(p.covered, 650);
  assert.equal(p.stepAdjusted, false);
});

test('planWindows: 尾巴太短就并进前一个窗口', () => {
  // 92s / 30s = 4 段，尾巴 2s —— 为 2 秒单独出图是纯浪费
  const p = planWindows(92, 30);
  assert.ok(p.total <= 4);
  assert.equal(p.windows.at(-1).to, 92);
});

test('planWindows: 段数超上限时把每段拉长，而不是砍掉尾巴', () => {
  const p = planWindows(7200, 60, { maxWindows: 12 });
  assert.equal(p.total, 12);
  assert.equal(p.stepAdjusted, true);
  assert.equal(p.windows.at(-1).to, 7200, '必须仍然覆盖全片');
});

test('planWindows: 边界吸附到剪辑点，但不会把窗口压得太短', () => {
  const p = planWindows(600, 300, { boundaries: [296, 297.5, 598] });
  assert.ok(p.snapped >= 1);
  assert.ok(p.windows[0].to <= 300);
  for (const w of p.windows) assert.ok(w.duration > 30);
});

test('planWindows: 非法输入直接抛（不要静默返回空窗口）', () => {
  assert.throws(() => planWindows(0, 300), RangeError);
  assert.throws(() => planWindows(100, 0), RangeError);
});

test('snapCells: 粗估档位只给预览用，输入乱也给一个整数', () => {
  assert.equal(snapCells(0), 4);
  assert.equal(snapCells(8), 9);
  assert.ok(Number.isInteger(snapCells(13)));
  // 默认画布宽度对齐到 42px 计费格后是 798×449 = 222（800×450 会多算一整列 = 233，
  // 旧口径的 384 更早就过期了）。这个数必须从 fitCanvas 现算，不能写死。
  assert.equal(PLAN_IMAGE_TOKENS, 222);
});
