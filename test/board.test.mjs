/**
 * board.test.mjs — 几个入口的参数只在一处定义。
 *
 * 这条测试守的是"功能漂移"：storyboard 有 detail、别人没有，就是各自手写默认值的后果。
 * 现在只要 boardOptions 的每种 kind 都正确，各入口自然一致。
 *
 * `kind: 'watch'` 这一档留在本包里，因为 `dsh-watch-together` 就是调它来拿默认值的 ——
 * 那边不再重复一遍这些数字，改这里就等于改那边。所以这里要盯着它。
 *
 * 2026-11-01：cells/sheets/need/maxPerSheet/adaptive 全部删除，换成
 * **maxFrames（帧数上限）+ strategy（升降档）+ budget（画布像素，<=640k）** 三个旋钮。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_BUDGET, boardGeometry, boardOptions, charsForDetail, DETAIL_CHARS, ocrFor,
} from '../src/storyboard/board.js';

test('board: 全片概览的默认值', () => {
  const o = boardOptions({ input: 'a.mp4' }, { kind: 'board' });
  assert.equal(o.maxFrames, 0, '0 = 不封顶：帧数由切点决定');
  assert.equal(o.strategy, 'compact', '默认紧凑（0.6.0 起，性价比最高）');
  assert.equal(o.detail, 'med');
  assert.equal(o.ocr, false);
  // 800×800 / 384 token 是 DS 的视觉上限，再大只会被缩回去
  assert.equal(o.budget, MAX_BUDGET);
  assert.equal(o.maxCanvasSide, 800);
  assert.equal(o.fetchOptions.scanHeight, 720, '最大格子 800×450，720p 已是 2.5 倍超采样');
  assert.equal(o.fetchOptions.zoomHeight, undefined, 'board 不需要高清直链');
  assert.equal(o.cells, undefined, 'cells 这个旋钮已经不存在了');
});

test('zoom: 少帧大图、quality 策略、带回高清清晰度', () => {
  const o = boardOptions({ input: 'a.mp4', from: 12, to: 15 }, { kind: 'zoom' });
  assert.equal(o.from, 12);
  assert.equal(o.to, 15);
  assert.equal(o.maxFrames, 9, 'zoom 默认 9 帧 = 3×3 满格');
  assert.equal(o.strategy, 'full');
  // 实际档位由 uniformTier:'auto' 覆盖成 ceil(sqrt(n))，保证一张图铺满 √n×√n
  assert.equal(o.uniformTier, 'auto');
  assert.equal(o.minFrames, 4, '长镜头窗口至少等分到 4 帧');
  assert.equal(o.fetchOptions.zoomHeight, 1080);
  assert.equal(o.fetchOptions.scanHeight, 360, 'zoom 仍要本地低清兜底');
});

test('watch: 5 帧、均衡策略', () => {
  const o = boardOptions({ input: 'a.mp4', from: 120, to: 240 }, { kind: 'watch' });
  assert.equal(o.maxFrames, 5);
  assert.equal(o.strategy, 'compact', '0.6.0 起默认是紧凑档');
});

test('detail 是同一个刻度：60 / 120 / 400，未知档位退回 med', () => {
  assert.deepEqual({ ...DETAIL_CHARS }, { low: 60, med: 120, high: 400 });
  assert.equal(charsForDetail('low'), 60);
  assert.equal(charsForDetail('high'), 400);
  assert.equal(charsForDetail('nonsense'), 120);
});

test('ocr 的开启规则只有一条：detail=high 才默认开', () => {
  assert.equal(ocrFor({}, 'med'), false);
  assert.equal(ocrFor({}, 'high'), true);
  assert.equal(ocrFor({ ocr: false }, 'high'), false, '显式关掉要生效');
  assert.equal(ocrFor({ ocr: true }, 'low'), true, '显式打开也要生效');
});

test('watch 现在也吃 detail / ocr（以前这两个参数只存在于 storyboard）', () => {
  const o = boardOptions({ input: 'a.mp4', detail: 'high' }, { kind: 'watch' });
  assert.equal(o.detail, 'high');
  assert.equal(o.ocr, true, 'detail=high 自动开硬字幕校正');
});

test('board 独有的参数不会漏到别的入口', () => {
  const args = { input: 'a.mp4', hotwords: '菠萝', textOnly: true };
  const b = boardOptions(args, { kind: 'board' });
  assert.equal(b.hotwords, '菠萝');
  assert.equal(b.textOnly, true);
  const w = boardOptions(args, { kind: 'watch' });
  // 热词是转写参数，陪看也要（它同样跑 ASR）；textOnly 只属于 board 的分页机制
  assert.equal(w.hotwords, '菠萝');
  assert.equal(w.textOnly, undefined);
});

test('board: 陪看那一档的默认值（dsh-watch-together 依赖它）', () => {
  const w = boardOptions({}, { kind: 'watch' });
  assert.equal(w.maxFrames, 5, '陪看每段默认 5 帧');
  // 显式给了 maxFrames 就用给的
  assert.equal(boardOptions({ maxFrames: 9 }, { kind: 'watch' }).maxFrames, 9);
  assert.equal(boardOptions({ maxFrames: 0 }, { kind: 'watch' }).maxFrames, 5, '0 等于没给');
});

test('budget 被夹在 64k..640k：超过 800x800 的请求不再是"更大更清楚"', () => {
  assert.equal(boardOptions({ input: 'a.mp4', budget: 9_999_999 }, { kind: 'board' }).budget, MAX_BUDGET);
  assert.equal(boardOptions({ input: 'a.mp4', budget: 1000 }, { kind: 'board' }).budget, 64_000);
  assert.equal(boardGeometry({}).budget, 640_000);
});

test('未知 strategy 退回默认，不抛（工具参数是模型填的，容错优先）', () => {
  assert.equal(boardOptions({ input: 'a.mp4', strategy: 'turbo' }, { kind: 'board' }).strategy, 'compact');
  // 旧名在 board 层就归一化（frugal → compact）
  assert.equal(boardOptions({ input: 'a.mp4', strategy: 'frugal' }, { kind: 'board' }).strategy, 'compact');
});
