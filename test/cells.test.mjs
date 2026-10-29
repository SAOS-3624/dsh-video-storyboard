/**
 * cells.test.mjs — cellId 寻址 + 阈值可配。
 *
 * cellId 的意义：清单里的 t_start 是**窗口相对值**，模型抄数字换窗口就会错位。
 * 这里锁两件事：绝对时间被正确记下；找不到时**明确报错**而不是猜一个窗口。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { lookupCell, saveCells } from '../src/cells.js';
import { suggest } from '../src/plan.js';
import { validateZoomArgs } from '../src/tool-spec.js';

test('cells: 存了就能按 id 查回绝对时间', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cells-'));
  const env = { DSH_VIDEO_CACHE_DIR: dir };
  try {
    await saveCells('D:/v/a.mp4', [
      { i: 1, from: 0, to: 9.33 },
      { i: 2, from: 9.33, to: 19.17 },
    ], { env });
    const hit = await lookupCell('D:/v/a.mp4', 2, { env });
    assert.deepEqual(hit, { i: 2, from: 9.33, to: 19.17 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('cells: 路径大小写/斜杠不同也能命中（Windows 真实情况）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cells2-'));
  const env = { DSH_VIDEO_CACHE_DIR: dir };
  try {
    const sep = String.fromCharCode(92);   // 反斜杠：源码里写死容易被转义搞乱
    await saveCells(['D:', 'Videos', 'A.mp4'].join(sep), [{ i: 3, from: 1, to: 2 }], { env });
    assert.ok(await lookupCell('d:/videos/a.mp4', 3, { env }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('cells: 没记过就返回 null（调用方据此报错，不猜窗口）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cells3-'));
  const env = { DSH_VIDEO_CACHE_DIR: dir };
  try {
    assert.equal(await lookupCell('D:/v/none.mp4', 1, { env }), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('validateZoomArgs: 有 cellId 就不再强制 from/to；越界的 cellId 要拒', () => {
  assert.deepEqual(validateZoomArgs({ input: 'a.mp4', from: 12, to: 15 }), []);
  assert.deepEqual(validateZoomArgs({ input: 'a.mp4', cellId: 3 }), []);
  assert.ok(validateZoomArgs({ input: 'a.mp4' }).some((p) => /cellId/.test(p)));
  assert.ok(validateZoomArgs({ input: 'a.mp4', cellId: 0 }).some((p) => /cellId/.test(p)));
});

test('suggest: 阈值可覆盖，且覆盖真的改变分类结果', () => {
  // 同一份元数据：按默认阈值算音乐片（meanLufs -16 > -18 且 speechRate 0.5 < 1）
  const meta = { duration: 300, cuts: 40, speechRate: 0.5, meanLufs: -16, hasSubtitle: false };
  const a = suggest(meta);
  // 把 musicLufs 抬到 -10，就不该再判成音乐驱动
  const b = suggest({ ...meta, thresholds: { musicLufs: -10 } });
  assert.notEqual(a.reason, b.reason, '阈值覆盖必须真的影响判定');
  assert.ok(a.cells >= 9, '音乐片至少 9 格');
});
