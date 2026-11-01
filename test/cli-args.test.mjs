/**
 * cli-args.test.mjs —— 参数解析必须把「不认识的开关」交出来。
 *
 * 背景：0.6 删掉了 `--cells` / `--sheets` / `--need`，但教程和用户脚本里还留着老写法。
 * 解析器照收不误、谁都不看，于是 `--cells 9` 静默变成「参数没生效」，用户只会觉得
 * 「格子数怎么不受控」。这里钉住 `$unknown`，让 CLI 能当场喊一声。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { args } from '../bin/_args.mjs';

const DEFAULTS = { frames: 0, strategy: null, 'dry-run': false };

test('args: 认识的长在 defaults 上，不进 $unknown', () => {
  const o = args(['a.mp4', '--frames', '16', '--dry-run'], DEFAULTS);
  assert.deepEqual(o._, ['a.mp4']);
  assert.equal(o.frames, '16');
  assert.equal(o['dry-run'], true);
  assert.deepEqual(o.$unknown, []);
});

test('args: 0.6 已删的 --cells 要被记下来', () => {
  const o = args(['a.mp4', '--cells', '9'], DEFAULTS);
  assert.deepEqual(o.$unknown, ['cells']);
  // 照收但不该被任何下游当真：值还在，只是没人读
  assert.equal(o.cells, '9');
});

test('args: 多个未知开关全部列出，裸参不影响判断', () => {
  const o = args(['--cells', '9', 'a.mp4', '--need', '5', '--frames', '16'], DEFAULTS);
  assert.deepEqual(o.$unknown, ['cells', 'need']);
  assert.deepEqual(o._, ['a.mp4']);
});

test('args: 带 = 的写法不在支持范围内（会当成值），至少不能崩', () => {
  const o = args(['--frames=16'], DEFAULTS);
  assert.deepEqual(o.$unknown, ['frames=16']);
});
