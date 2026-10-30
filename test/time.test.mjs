/**
 * time.test.mjs — mm:ss 只有一份实现。
 *
 * 之前有两份，边界写法不同：59.6 秒，一份写 "01:00"，另一份写 "00:60"。
 * 后者是个不存在的时刻，用户会以为时间点算错了。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { mmss } from '../src/watch/time.js';

test('mmss: 常规值', () => {
  assert.equal(mmss(0), '00:00');
  assert.equal(mmss(9), '00:09');
  assert.equal(mmss(75), '01:15');
  assert.equal(mmss(575), '09:35');
});

test('mmss: 不会写出 00:60（进位到下一分钟）', () => {
  assert.equal(mmss(59.6), '01:00');
  assert.equal(mmss(119.7), '02:00');
});

test('mmss: 负数与脏值当 0', () => {
  assert.equal(mmss(-5), '00:00');
  assert.equal(mmss(undefined), '00:00');
  assert.equal(mmss('abc'), '00:00');
});

test('mmss: 超过一小时不封顶（两小时的片子写 128:07）', () => {
  assert.equal(mmss(7687), '128:07');
});
