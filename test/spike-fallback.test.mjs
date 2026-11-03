/**
 * spike-fallback.test.mjs — 「极静素材补刀」该不该顶掉粗扫的守卫。
 *
 * 这条判据以前是 `spikes.length > cuts.length`，实测在纪录片上把 503 刀换成 8792 刀。
 * 现在多了密度上限，这里锁住三个场景：正常翻页要采纳、长片噪声要拒绝、本来就更少要拒绝。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldTakeSpikes } from '../src/storyboard/pipeline.js';

test('补的比原来少 → 不采纳（本来就没必要）', () => {
  assert.equal(shouldTakeSpikes({ coarse: 50, spikes: 30, winDur: 600 }), false);
  assert.equal(shouldTakeSpikes({ coarse: 50, spikes: 50, winDur: 600 }), false);
});

test('PPT/代码录屏：粗扫漏了翻页，补出来且密度合理 → 采纳', () => {
  // 10 分钟的录屏，粗扫 2 刀，补出 30 刀（每 20 秒一次翻页）
  assert.equal(shouldTakeSpikes({ coarse: 2, spikes: 30, winDur: 600 }), true);
});

test('长纪录片：补出几千刀 → 密度超标，拒绝', () => {
  // BBC 第一集的真实数字：503 刀 → 8792 刀，2952 秒
  assert.equal(shouldTakeSpikes({ coarse: 503, spikes: 8792, winDur: 2952 }), false);
  // 边界：正好 0.3 刀/秒 采纳，超过就拒绝
  assert.equal(shouldTakeSpikes({ coarse: 1, spikes: 300, winDur: 1000 }), true);
  assert.equal(shouldTakeSpikes({ coarse: 1, spikes: 301, winDur: 1000 }), false);
});

test('winDur 缺失/为 0 时不炸（按极短处理，一律拒绝超密的）', () => {
  assert.equal(shouldTakeSpikes({ coarse: 1, spikes: 10, winDur: 0 }), false);
  assert.equal(shouldTakeSpikes({}), false);
});
