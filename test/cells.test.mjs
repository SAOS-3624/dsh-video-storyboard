/**
 * cells.test.mjs — cellId 寻址 + 阈值可配。
 *
 * cellId 的意义：模型不该自己抄时间码，换窗口就会错位。
 * 这里锁三件事：**绝对时间**被正确记下（issue #37：t_start 本来就是绝对时间，不能再加窗口起点）；
 * 旧版本的脏表不参与寻址；找不到时明确返回 null，而不是猜一个窗口。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { lookupCell, saveCells } from '../src/storyboard/cells.js';
import { suggest } from '../src/storyboard/plan.js';
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

test('cells: 旧版脏表（没有 v）不参与寻址 —— issue #37 的窗口起点被加过两次', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cells4-'));
  const env = { DSH_VIDEO_CACHE_DIR: dir };
  try {
    // 模拟 0.5.3 及以前写下的表：没有 v，from 已经是错的
    await writeFile(join(dir, 'cells.json'), JSON.stringify({
      'd:/v/old.mp4': { at: 1, cells: [{ i: 5, from: 102.71, to: 110 }] },
    }), 'utf8');
    assert.equal(await lookupCell('D:/v/old.mp4', 5, { env }), null,
      '旧表的绝对时间不可信，宁可退回 from/to');
    // 新表照常命中
    await saveCells('D:/v/old.mp4', [{ i: 5, from: 52.71, to: 60 }], { env });
    assert.deepEqual(await lookupCell('D:/v/old.mp4', 5, { env }), { i: 5, from: 52.71, to: 60 });
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
  assert.equal(a.musicDriven, true, '默认阈值下应判成音乐驱动');
  assert.equal(b.musicDriven, undefined, '抬高阈值后不该再判成音乐驱动');
  // 判定结果只影响取帧，不该反过来改格数（旧规则会强制 9 格）
  assert.equal(a.cells, b.cells, '音乐判定不该改格数');
});
