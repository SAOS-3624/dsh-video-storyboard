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

test('新颖度：补刀全是已有刀的重复 → 拒绝；真漏掉的 → 采纳', () => {
  // 实测一段静态屏幕录像：粗扫 6 刀，补刀 10 刀全部贴着粗扫（新颖度 0）
  const coarse = [63.5, 66.1, 70.2, 78.3, 122.0, 149.8];
  const dup = [65.1, 65.2, 65.2, 65.2, 66.6, 78.3, 121.9, 122.0, 149.7, 149.8];
  assert.equal(
    shouldTakeSpikes({ coarse: 6, spikes: 10, winDur: 151.2, spikeTimes: dup, coarseTimes: coarse }),
    false,
    '重复检测不该顶掉粗扫',
  );
  // 真正的"粗扫漏了翻页"：粗扫 2 刀，补刀 20 刀散布其间
  const few = [10, 90];
  const missed = [];
  for (let i = 0; i < 20; i += 1) missed.push(3 + i * 7.5);
  assert.equal(
    shouldTakeSpikes({ coarse: 2, spikes: 20, winDur: 200, spikeTimes: missed, coarseTimes: few }),
    true,
    '找到了新刀就该采纳',
  );
  // 不给时刻时跳过第 ③ 条（向后兼容）
  assert.equal(shouldTakeSpikes({ coarse: 2, spikes: 20, winDur: 200 }), true);
});
