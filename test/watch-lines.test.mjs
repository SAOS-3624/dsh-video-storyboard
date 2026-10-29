/**
 * watch-lines.test.mjs — 预设台词。
 *
 * 预取解决了"建图的十秒"，但"想说什么"还要模型跑一轮。提前写好就没有那 2–4 秒延迟。
 * 关键守卫：**只写 5 分钟窗口**，中途不看了最多白写 2–3 段；没写就退回"到点再看图"。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadLine, saveLines, watchPath } from '../src/watch.js';

test('存了就能按段取回', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lines-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try {
    const n = await saveLines('a.mp4', [
      { from: 120, text: '他们开始布置场地了。' },
      { from: 240, text: '这里有个反转。' },
    ]);
    assert.equal(n, 2);
    assert.equal(await loadLine('a.mp4', 120), '他们开始布置场地了。');
    assert.equal(await loadLine('a.mp4', 240), '这里有个反转。');
    assert.equal(await loadLine('a.mp4', 360), null, '没写过的段要返回 null');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('同一段重写会覆盖（改了主意不该出现两句）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lines2-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try {
    await saveLines('b.mp4', [{ from: 120, text: '旧的' }]);
    await saveLines('b.mp4', [{ from: 120, text: '新的' }]);
    assert.equal(await loadLine('b.mp4', 120), '新的');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('空文本/非法段号不写入（别占着位置又念不出来）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lines3-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try {
    const n = await saveLines('c.mp4', [
      { from: 120, text: '   ' },
      { from: 'x', text: '有效文字' },
      { from: 240, text: '正常' },
    ]);
    assert.equal(n, 1);
    assert.equal(await loadLine('c.mp4', 240), '正常');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('台词存在会话状态里，和 spoken 不互相覆盖', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lines4-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try {
    await saveLines('d.mp4', [{ from: 120, text: '一句' }]);
    const raw = JSON.parse(await (await import('node:fs/promises')).readFile(watchPath(), 'utf8'));
    const sk = Object.keys(raw)[0];
    assert.ok(raw[sk].lines, '要有 lines');
    assert.ok('at' in raw[sk], '会话状态的其他字段不该被抹掉');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
