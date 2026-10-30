import test from 'node:test';
import assert from 'node:assert/strict';

import { isLoopback,
  alignCells, CELL_BREAK_GAP, chunkWindows, mergeSegments, shortStamp, transcribeLong,
} from '../src/storyboard/asr.js';

/* ---------------------------------------------------------------- 空结果的诚实度 */

test('transcribeLong: 没配 key 时返回 null（而不是空壳对象）', async () => {
  const long = await transcribeLong({
    input: 'nope.mp4', start: 0, end: 300, apiKey: null, baseUrl: 'https://api.example.com/v1',
  });
  assert.equal(long, null, '多窗口、每段都拿不到 key → 整段应该是 null');
});

test('transcribeLong: 窗口不足时不该抛（end > start 才走 ASR）', async () => {
  await assert.rejects(
    () => transcribeLong({ input: 'nope.mp4', start: 10, end: 10, apiKey: null }),
    /end must be greater than start/,
  );
});

/* ---------------------------------------------------------------- 切片与合并 */

test('chunkWindows: 切点落在静音中点，且不跨太长', () => {
  const windows = chunkWindows({ start: 0, end: 120, silences: [{ from: 41, to: 45 }], maxChunk: 45 });
  assert.ok(windows.length >= 3);
  for (const w of windows) assert.ok(w.to - w.from <= 46, `窗口过长: ${w.from}-${w.to}`);
  // 40–45 附近应该有一刀落在静音区间里
  const near = windows.some((w) => w.to > 41 && w.to < 45);
  assert.ok(near, `切点应吸附到静音中点附近，实得 ${windows.map((w) => w.to).join(',')}`);
});

test('mergeSegments: 跨片重复的同一句只留一条', () => {
  // 同一句在上一片结尾、下一片开头各出现一次（切片边界造成的重复）
  const merged = mergeSegments([
    { from: 0, to: 5, text: '同一句话' },
    { from: 4.8, to: 9, text: '同一句话' },
    { from: 20, to: 25, text: '另一句' },
  ]);
  assert.equal(merged.length, 2, '重复句应被合并成一条');
  assert.equal(merged[0].to, 9, '保留更晚的结束时间');
  assert.equal(merged[1].text, '另一句');
});

test('mergeSegments: 不同句子即使时间重叠也不合并', () => {
  const merged = mergeSegments([
    { from: 0, to: 5, text: '甲' },
    { from: 4, to: 9, text: '乙' },
  ]);
  assert.equal(merged.length, 2);
});

/* ---------------------------------------------------------------- 台词贴格（时间戳不再被 join 丢掉） */

const seg = (from, to, text) => ({ from, to, text });

test('shortStamp: m:ss.s，分钟不进位到小时', () => {
  assert.equal(shortStamp(0), '0:00.0');
  assert.equal(shortStamp(9.4), '0:09.4');
  assert.equal(shortStamp(609.42), '10:09.4');
  assert.equal(shortStamp(3725.5), '62:05.5');
});

test('alignCells: 格内两句连续时保持一句流畅的话，不插时间戳', () => {
  const [cell] = alignCells(
    [{ from: 0, to: 10 }],
    [seg(0, 3, '前半句'), seg(3.2, 6, '后半句')],
  );
  assert.equal(cell.text, '前半句 后半句');
  assert.equal(cell.broken, false);
  assert.equal(cell.segments, 2);
});

test('alignCells: 格内出现明显断点时插内联时间戳（这正是错位 30 秒的根源）', () => {
  // 复刻实测场景：格 09:38.9–10:20.5 里，10:09.4 才是"第六，歌曲"的真正起点
  const [cell] = alignCells(
    [{ from: 578.9, to: 620.5 }],
    [seg(578.9, 600.0, '…这类海洋巨怪视频。'), seg(609.4, 620.5, '第六，歌曲说爱请…')],
  );
  assert.equal(cell.broken, true);
  assert.match(cell.text, /\[10:09\.4\] 第六，歌曲/);
  // 第一句不加前缀（它是格的起点，前缀冗余）
  assert.ok(!cell.text.startsWith('['), `首句不该带前缀: ${cell.text}`);
});

test('alignCells: 断点阈值边界——刚好低于阈值不插，达到才插', () => {
  const tight = alignCells([{ from: 0, to: 10 }], [seg(0, 3, 'a'), seg(3 + CELL_BREAK_GAP - 0.01, 6, 'b')])[0];
  assert.equal(tight.broken, false);
  const loose = alignCells([{ from: 0, to: 10 }], [seg(0, 3, 'a'), seg(3 + CELL_BREAK_GAP, 6, 'b')])[0];
  assert.equal(loose.broken, true);
});

test('alignCells: lines 保留每句自己的时间轴（信息本来就在 hits 上）', () => {
  const [cell] = alignCells(
    [{ from: 0, to: 10 }],
    [seg(1, 2, 'a'), seg(5, 6, 'b')],
  );
  assert.deepEqual(cell.lines, [
    { from: 1, to: 2, text: 'a' },
    { from: 5, to: 6, text: 'b' },
  ]);
});

test('alignCells: 没有台词命中时，text 为空且 broken 不为真', () => {
  const [cell] = alignCells([{ from: 0, to: 10 }], []);
  assert.equal(cell.text, '');
  assert.equal(cell.broken, false);
  assert.deepEqual(cell.lines, []);
});

test('isLoopback: 本机服务不需要 key', () => {
  assert.equal(isLoopback('http://127.0.0.1:8000/v1'), true);
  assert.equal(isLoopback('http://localhost:8000/v1'), true);
  assert.equal(isLoopback('http://[::1]:8000/v1'), true);
  assert.equal(isLoopback('https://api.siliconflow.cn/v1'), false);
  assert.equal(isLoopback('not a url'), false);
});
