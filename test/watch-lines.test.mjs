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

import { dueLine, loadLine, linesOverview, saveLines, watchPath } from '../src/watch/watch.js';

/**
 * 台词怎么"到点"是这一轮最贵的教训：
 * 按段触发（段首一口气说完）听起来就是"嘴比画面快很多"，
 * 按墙钟触发更糟 —— 暂停也继续说。只认位置。
 */
test('dueLine: 没到 at 就不给，到了才给，且只给一次', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'due-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try {
    await saveLines('b.mp4', [
      { from: 120, at: 150, text: 'A' },
      { from: 120, at: 171, text: 'B' },
    ]);
    assert.equal(await dueLine('b.mp4', 149, { size: 60 }), null, '差一秒都不给');
    assert.equal(await dueLine('b.mp4', 150, { size: 60 }), 'A');
    assert.equal(await dueLine('b.mp4', 160, { size: 60 }), null, '下一句还没到');
    assert.equal(await dueLine('b.mp4', 171, { size: 60 }), 'B');
    assert.equal(await dueLine('b.mp4', 200, { size: 60 }), null, '念过就没了');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('dueLine: 未来段落的词不该提前念（写 240s 的词，150s 时不许开口）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'due2-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try {
    await saveLines('c.mp4', [{ from: 240, at: 252, text: '还早' }]);
    assert.equal(await dueLine('c.mp4', 150, { size: 60 }), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('dueLine: 位置停在原地时不会把后面的词提前掏空', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'due3-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try {
    await saveLines('d.mp4', [
      { from: 120, at: 150, text: 'A' },
      { from: 120, at: 171, text: 'B' },
      { from: 120, at: 195, text: 'C' },
    ]);
    assert.equal(await dueLine('d.mp4', 150, { size: 60 }), 'A');
    // 停在 150 反复问：只该 null，不该把 B、C 也吐出来（这是"暂停还在念"的真因）
    for (let i = 0; i < 5; i += 1) {
      assert.equal(await dueLine('d.mp4', 150, { size: 60 }), null);
    }
    assert.equal((await linesOverview('d.mp4'))[0].count, 2, 'B、C 还在库存里');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('dueLine: 没写 at 的老台词，按段首算，并在段内均匀铺开', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'due4-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try {
    await saveLines('e.mp4', [
      { from: 120, text: '一' },
      { from: 120, text: '二' },
      { from: 120, text: '三' },
      { from: 120, text: '四' },
    ]);
    // 60 秒一段、四句 → 段首、+15、+30、+45
    assert.equal(await dueLine('e.mp4', 120, { size: 60 }), '一');
    assert.equal(await dueLine('e.mp4', 130, { size: 60 }), null, '15 秒前不该轮到第二句');
    assert.equal(await dueLine('e.mp4', 135, { size: 60 }), '二');
    assert.equal(await dueLine('e.mp4', 151, { size: 60 }), '三');
    assert.equal(await dueLine('e.mp4', 165, { size: 60 }), '四');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('dueLine: 迟到几秒照念，迟到太多直接作废（拖进度条之后不追着说旧画面）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'due5-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try {
    await saveLines('g.mp4', [
      { from: 120, at: 150, text: '旧' },
      { from: 120, at: 200, text: '稍晚' },
    ]);
    // 停在 152：迟到 2 秒，还在宽限（lateSec 3）里，照念
    assert.equal(await dueLine('g.mp4', 152, { size: 60 }), '旧');
    // 跳到 260：200 那句迟到 60 秒，作废；库存清空
    assert.equal(await dueLine('g.mp4', 260, { size: 60 }), null);
    assert.equal((await linesOverview('g.mp4')).length, 0, '迟到的词应被丢弃，而不是攒着连珠炮');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

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

test('后补的带 at 台词不会冲掉同段已有的（台词凭空消失的那个 bug）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'due6-'));
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  try {
    await saveLines('h.mp4', [
      { from: 1500, at: 1525, text: 'A' },
      { from: 1500, at: 1565, text: 'B' },
    ]);
    // 后来只想补一句收尾词
    await saveLines('h.mp4', [{ from: 1500, at: 1778, text: 'C' }]);
    const rows = await linesOverview('h.mp4');
    assert.equal(rows[0].count, 3, 'A、B 必须还在');
    assert.deepEqual(rows[0].ats, [1525, 1565, 1778]);
    // 同一个 at 再写一次 = 改词，不是新增
    await saveLines('h.mp4', [{ from: 1500, at: 1565, text: 'B2' }]);
    const again = await linesOverview('h.mp4');
    assert.equal(again[0].count, 3);
    assert.equal(await dueLine('h.mp4', 1565, { size: 300 }), 'B2');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
