/**
 * frames.test.mjs — 取帧层的并发工具 + 批量取帧的**帧号算术**。
 *
 * 2026-11-01：格内摊开（chooseSubGrid / subTileTimes / splitByWeight / extractSubTile）整个被删除，
 * 由"档位 + 可变网格"取代 —— 一个镜头就是一格，不再在一格里再切 k×k。
 *
 * 同日加了批量取帧（一次 ffmpeg 用 select 取多帧，见 frames.js 的文件头）。
 * 它真正会错的地方只有两处算术：**帧号**和**裁切**。下面把这两个纯函数钉死，
 * 因为错一帧 / 多裁一圈在成图上都看不出来，只有对着逐帧路径逐字节比才发现。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { boxResize, frameAt, frameIndexOf, mapPool } from '../src/storyboard/frames.js';

test('mapPool: 保持输出顺序（并发完成顺序无关）', async () => {
  const items = [30, 1, 20, 5, 10];
  const out = await mapPool(items, 3, async (ms, i) => {
    await new Promise((r) => setTimeout(r, ms));
    return i;
  });
  assert.deepEqual(out, [0, 1, 2, 3, 4]);
});

test('mapPool: 并发上限真的生效（同时最多 limit 个在跑）', async () => {
  let running = 0;
  let peak = 0;
  await mapPool(Array.from({ length: 12 }, (_, i) => i), 4, async () => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 5));
    running -= 1;
  });
  assert.equal(peak, 4);
});

test('mapPool: 空数组直接返回空（不能挂住）', async () => {
  assert.deepEqual(await mapPool([], 4, async () => 1), []);
});

test('mapPool: 任何一个失败就整体失败（不能静默少一格）', async () => {
  await assert.rejects(
    () => mapPool([1, 2, 3], 2, async (v) => {
      if (v === 2) throw new Error('boom');
      return v;
    }),
    /boom/,
  );
});

/* ---------------------------------------------------------------- 帧号算术 */

test('frameAt: 与 `-ss` 的"第一个 ≥ t 的帧"同义（ceil）', () => {
  assert.equal(frameAt(0, 25), 0);
  assert.equal(frameAt(3.0, 25), 75);
  assert.equal(frameAt(3.04, 25), 76);
  assert.equal(frameAt(3.02, 25), 76);
  assert.equal(frameAt(3.5, 25), 88);
  assert.equal(frameAt(7.98, 25), 200);
});

test('frameAt: 帧边界上的浮点误差不能让它多跳一帧', () => {
  // 199/25 在 double 里是 7.96 还是 7.959999…？两种都要落在 199
  for (const k of [1, 3, 7, 25, 199, 1000, 5305]) {
    assert.equal(frameAt(k / 25, 25), k, `k=${k}`);
  }
});

test('frameIndexOf: 用绝对帧号之差，不是"秒数 × fps"', () => {
  const fps = 25;
  // 真实事故：lo=12.345（不在帧边界）、at=16.0
  //   相对算法 ceil((16-12.345)*25) = 92 → 帧 401（16.04s）  ❌
  //   绝对差  ceil(16*25) - ceil(12.345*25) = 400-309 = 91 → 帧 400（16.00s） ✅
  assert.equal(frameIndexOf(16.0, 12.345, 25), 91);
  assert.equal(frameAt(16.0, fps) - frameAt(12.345, fps), 91);
  // 同一个 lo 上的所有点都必须自洽：lo+k/fps 反算回来还是 k
  for (const lo of [12.345, 80.12, 0, 41.0]) {
    const k0 = frameAt(lo, fps);
    for (const d of [0, 1, 7, 50, 478]) {
      const at = (k0 + d) / fps;
      assert.equal(frameIndexOf(at, lo, fps), d, `lo=${lo} d=${d}`);
    }
  }
});

/* ---------------------------------------------------------------- 盒式缩放 */

const rgb = (rows) => Buffer.from(rows.flat(2));

test('boxResize: 同尺寸原样返回（不复制、不改内容）', () => {
  const src = rgb([[[1, 2, 3], [4, 5, 6]]]);
  assert.equal(boxResize(src, 2, 1, 2, 1), src);
});

test('boxResize: 2×2 → 1×1 取四点平均', () => {
  const src = rgb([
    [[10, 20, 30], [20, 40, 60]],
    [[30, 60, 90], [40, 80, 120]],
  ]);
  assert.deepEqual([...boxResize(src, 2, 2, 1, 1)], [25, 50, 75]);
});

test('boxResize: 比例不同时**居中裁切**（cover），不是拉伸', () => {
  // 4×2（2:1）→ 1×1（1:1）：应该只取中间那一列，而不是四列平均
  const src = rgb([
    [[0, 0, 0], [0, 0, 0], [200, 200, 200], [0, 0, 0]],
    [[0, 0, 0], [0, 0, 0], [200, 200, 200], [0, 0, 0]],
  ]);
  // 2:1 → 1:1 需要裁宽度：cw = round(2*1) = 2，cx = (4-2)/2 = 1 → 取第 1、2 列
  // 第 1 列是 0，第 2 列是 200 → 平均 100
  assert.deepEqual([...boxResize(src, 4, 2, 1, 1)], [100, 100, 100]);
});

test('boxResize: 竖向裁切（目标更宽）同样居中', () => {
  // 1×4 源 → 4×1 目标是极端比例（真实格子都在 1.5–2.4 之间），这里只验裁切是"取中间"：
  // ch = max(1, round(1/4)) = 1，cy = floor((4-1)/2) = 1 → 取第 2 行
  const src = rgb([[[0, 0, 0]], [[50, 50, 50]], [[200, 200, 200]], [[0, 0, 0]]]);
  const out = boxResize(src, 1, 4, 4, 1);
  assert.equal(out.length, 4 * 1 * 3);
  // 水平方向只有 1 个源像素 → 每一列都是同一行的值
  assert.deepEqual([...out.subarray(0, 3)], [50, 50, 50]);
});

test('boxResize: 平均是整数取整，不越界（0..255）', () => {
  const src = Buffer.alloc(8 * 8 * 3, 255);
  const out = boxResize(src, 8, 8, 3, 3);
  assert.equal(out.length, 3 * 3 * 3);
  for (const v of out) assert.ok(v >= 0 && v <= 255);
  assert.deepEqual([...out.subarray(0, 3)], [255, 255, 255]);
});
