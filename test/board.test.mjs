/**
 * board.test.mjs — 几个入口的参数只在一处定义。
 *
 * 这条测试守的是"功能漂移"：storyboard 有 detail、别人没有，就是各自手写默认值的后果。
 * 现在只要 boardOptions 的每种 kind 都正确，各入口自然一致。
 *
 * `kind: 'watch'` 这一档留在本包里，因为 `dsh-watch-together` 就是调它来拿默认值的 ——
 * 那边不再重复一遍这些数字，改这里就等于改那边。所以这里要盯着它。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { boardOptions, charsForDetail, DETAIL_CHARS, ocrFor } from '../src/storyboard/board.js';

test('board: 全片概览的默认值', () => {
  const o = boardOptions({ input: 'a.mp4' }, { kind: 'board' });
  assert.equal(o.cells, 0, '0 = 交给 plan.js 按密度建议');
  assert.equal(o.sheets, 0);
  assert.equal(o.minGap, 1.2);
  assert.equal(o.adaptive, true);
  assert.equal(o.detail, 'med');
  assert.equal(o.ocr, false);
  // 默认抬到 medium：640k 的 9 格只有 331×184，是这次"AI 看的东西太糊"的直接原因。
  assert.equal(o.budget, 1_200_000, '默认预算 1.2M：9 格 421×237');
  assert.equal(o.need, 'scene');
  assert.equal(o.maxPerSheet, 12, '1.2M + scene 的格数上限是 12（394×220，摊开仍有 197×110）');
  assert.equal(o.fetchOptions.scanHeight, 720, '1.2M 预算配 720p：0.5.3 的默认不能借预算之名降回去');
  assert.equal(o.fetchOptions.zoomHeight, undefined, 'board 不需要高清直链');
});

test('zoom: 少格大图、不按密度挪格、带回高清清晰度', () => {
  const o = boardOptions({ input: 'a.mp4', from: 12, to: 15 }, { kind: 'zoom' });
  assert.equal(o.from, 12);
  assert.equal(o.to, 15);
  assert.equal(o.cells, 6);
  assert.equal(o.sheets, 1);
  assert.equal(o.adaptive, false);
  assert.equal(o.fetchOptions.zoomHeight, 1080);
  assert.equal(o.fetchOptions.scanHeight, 360, 'zoom 仍要本地低清兜底');
});

test('watch: 5 格、minGap 0.5、关自适应', () => {
  const o = boardOptions({ input: 'a.mp4', from: 120, to: 240 }, { kind: 'watch' });
  assert.equal(o.cells, 5);
  assert.equal(o.sheets, 1);
  assert.equal(o.minGap, 0.5);
  assert.equal(o.adaptive, false);
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
  const args = { input: 'a.mp4', hotwords: '菠萝', textOnly: true, planThresholds: { musicLufs: -20 } };
  const b = boardOptions(args, { kind: 'board' });
  assert.equal(b.hotwords, '菠萝');
  assert.equal(b.textOnly, true);
  assert.deepEqual(b.planThresholds, { musicLufs: -20 });
  const w = boardOptions(args, { kind: 'watch' });
  assert.equal(w.hotwords, undefined);
  assert.equal(w.textOnly, undefined);
});

test('board: 陪看那一档的默认值（dsh-watch-together 依赖它）', () => {
  const w = boardOptions({}, { kind: 'watch' });
  assert.equal(w.cells, 5, '陪看每段默认 5 格');
  assert.equal(w.sheets, 1);
  assert.equal(w.minGap, 0.5, '陪看窗口短，格子要更密');
  assert.equal(w.adaptive, false, '窗口本来就短，均分比按密度挪格好预测');
  // 显式给了 cells 就用给的
  assert.equal(boardOptions({ cells: 9 }, { kind: 'watch' }).cells, 9);
  assert.equal(boardOptions({ cells: 0 }, { kind: 'watch' }).cells, 5, '0 等于没给');
});
