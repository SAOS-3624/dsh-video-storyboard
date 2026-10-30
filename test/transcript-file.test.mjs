import test from 'node:test';
import assert from 'node:assert/strict';

import {
  loadTranscriptFile, parseJsonTranscript, parseSrt, parseTimecode, parseTranscript, stripMarkup,
} from '../src/storyboard/transcript-file.js';

/* ---------------------------------------------------------------- 时间码 */

test('parseTimecode: HH:MM:SS,mmm / 点号 / MM:SS / 纯秒', () => {
  assert.equal(parseTimecode('00:01:02,500'), 62.5);
  assert.equal(parseTimecode('00:01:02.500'), 62.5);
  assert.equal(parseTimecode('01:02.5'), 62.5);
  assert.equal(parseTimecode('62.5'), 62.5);
  assert.equal(parseTimecode('1:00:00,000'), 3600);
});

test('stripMarkup: 去掉富文本标记但保留文字', () => {
  assert.equal(stripMarkup('<i>斜体</i>'), '斜体');
  assert.equal(stripMarkup('<font color="#FFFFFF">白字</font>'), '白字');
  assert.equal(stripMarkup('{\\an8}顶部'), '顶部');
  assert.equal(stripMarkup('a&nbsp;&amp;&nbsp;b'), 'a & b');
});

/* ---------------------------------------------------------------- SRT */

const SRT = `1
00:00:01,000 --> 00:00:03,500
第一句台词

2
00:00:03,500 --> 00:00:06,000
第二句
跨了两行

3
00:00:07,000 --> 00:00:09,000
<i>第三句</i>
`;

test('parseSrt: 序号/时间码/多行正文都能吃', () => {
  const segs = parseSrt(SRT);
  assert.equal(segs.length, 3);
  assert.deepEqual(segs[0], { from: 1, to: 3.5, text: '第一句台词' });
  assert.equal(segs[1].text, '第二句 跨了两行');
  assert.equal(segs[2].text, '第三句');
});

test('parseSrt: 没有序号、CRLF、尾随坐标后缀都不影响', () => {
  const messy = '00:00:01,000 --> 00:00:02,000 X1:100 X2:200\r\n正文\r\n';
  const segs = parseSrt(messy);
  assert.equal(segs.length, 1);
  assert.deepEqual(segs[0], { from: 1, to: 2, text: '正文' });
});

test('parseSrt: 空正文的块被丢掉，不产生空台词', () => {
  const segs = parseSrt('1\n00:00:01,000 --> 00:00:02,000\n\n\n2\n00:00:03,000 --> 00:00:04,000\n有内容\n');
  assert.equal(segs.length, 1);
  assert.equal(segs[0].text, '有内容');
});

/* ---------------------------------------------------------------- JSON */

test('parseJsonTranscript: B 站 body/from/to/content', () => {
  const payload = {
    font_size: 0.4,
    body: [
      { from: 0.0, to: 2.5, content: '开场白' },
      { from: 2.5, to: 5.0, content: '第二句' },
    ],
  };
  const segs = parseJsonTranscript(payload);
  assert.equal(segs.length, 2);
  assert.deepEqual(segs[0], { from: 0, to: 2.5, text: '开场白' });
});

test('parseJsonTranscript: 通用数组 start/end/text 与 from/to/text 都认', () => {
  assert.deepEqual(
    parseJsonTranscript([{ start: 1, end: 2, text: 'a' }]),
    [{ from: 1, to: 2, text: 'a' }],
  );
  assert.deepEqual(
    parseJsonTranscript([{ from: 3, to: 4, text: 'b' }]),
    [{ from: 3, to: 4, text: 'b' }],
  );
});

test('parseJsonTranscript: whisper verbose_json 的 segments 布局', () => {
  const segs = parseJsonTranscript({ segments: [{ start: 0.5, end: 1.5, text: 'hi' }] });
  assert.deepEqual(segs, [{ from: 0.5, to: 1.5, text: 'hi' }]);
});

test('parseJsonTranscript: 缺字段或时间非数字的条目被跳过', () => {
  const segs = parseJsonTranscript([
    { start: 1, end: 2, text: 'ok' },
    { start: 'x', end: 2, text: 'bad' },
    { start: 3, end: 4 },
  ]);
  assert.equal(segs.length, 1);
});

test('parseJsonTranscript: 认不出布局时明确报错', () => {
  assert.throws(() => parseJsonTranscript({ foo: 1 }), /unrecognised transcript JSON/);
});

/* ---------------------------------------------------------------- 入口 */

test('parseTranscript: 按内容判 JSON，按箭头行判 SRT', () => {
  assert.equal(parseTranscript('[{ "start":0,"end":1,"text":"a" }]').format, 'json');
  assert.equal(parseTranscript(SRT, 'x.srt').format, 'srt');
});

test('parseTranscript: 坏 JSON 报的是 JSON 错，不是"没有时间码"', () => {
  assert.throws(() => parseTranscript('{oops}', 'x.json'), /not valid JSON/);
});

test('parseTranscript: 既不是 JSON 也没有 --> 时报错', () => {
  assert.throws(() => parseTranscript('这是一段没有时间码的纯文本'), /could not find any timed text/);
});

test('loadTranscriptFile: 读盘 + 按起点排序', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(join(tmpdir(), 'tf-'));
  try {
    const path = join(dir, 'x.json');
    await writeFile(path, JSON.stringify([
      { start: 5, end: 6, text: '后' },
      { start: 1, end: 2, text: '前' },
    ]), 'utf8');
    const { segments, format } = await loadTranscriptFile(path);
    assert.equal(format, 'json');
    assert.deepEqual(segments.map((s) => s.text), ['前', '后']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
