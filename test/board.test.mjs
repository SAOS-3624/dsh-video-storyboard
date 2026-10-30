/**
 * board.test.mjs — 三个入口的参数只在一处定义。
 *
 * 这条测试守的是"功能漂移"：storyboard 有 detail、watch 没有，就是各自手写默认值的后果。
 * 现在只要 boardOptions 的每种 kind 都正确，三个入口自然一致。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { boardOptions, charsForDetail, DETAIL_CHARS, ocrFor } from '../src/storyboard/board.js';
import { runWatchPass } from '../src/watch/watch-run.js';

test('board: 全片概览的默认值', () => {
  const o = boardOptions({ input: 'a.mp4' }, { kind: 'board' });
  assert.equal(o.cells, 0, '0 = 交给 plan.js 按密度建议');
  assert.equal(o.sheets, 0);
  assert.equal(o.minGap, 1.2);
  assert.equal(o.adaptive, true);
  assert.equal(o.detail, 'med');
  assert.equal(o.ocr, false);
  assert.equal(o.fetchOptions.scanHeight, 360);
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

test('陪看把 detail 透传进管线，并按档位收紧清单预算', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'board-watch-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try {
    const seen = {};
    const deps = {
      cache: new Map(),
      saveImage: async ({ data }) => data,
      runStoryboard: async (opts) => {
        seen.opts = opts;
        return { sheets: [{ png: Buffer.from('x'), cells: [] }] };
      },
      formatManifest: (result, opts) => { seen.fmt = opts; return 'm'; },
      probe: async () => ({ ok: true, sessions: [] }),
    };

    await runWatchPass(
      { input: 'w.mp4', cursor: 106, segment: 120, lead: 15, detail: 'high' },
      deps,
    );
    assert.equal(seen.opts.detail, 'high', 'detail 必须传进 runStoryboard');
    assert.equal(seen.opts.ocr, true);
    assert.equal(seen.opts.minGap, 0.5, '陪看的 minGap 仍由 board.js 决定');
    assert.equal(seen.fmt.maxCellChars, 400, '清单每格字数跟着 detail 走');
    assert.equal(seen.fmt.maxChars, 6000, 'high 档位给更大的总预算');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
