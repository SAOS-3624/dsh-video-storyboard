/**
 * site-subtitles.test.mjs — 站点字幕"是不是这条片子的"（issue #99）。
 *
 * 背景：B 站 ai-zh 轨有竞态，会返回**别的视频**的字幕，而清单里写着
 * `transcript-model="site-cc:ai-zh"`，看起来完全正常 —— 模型于是照着别人的台词讲这条片子。
 * 静默的错误数据比"没有字幕"危险得多：后者让人去配 ASR，前者只让人抄错。
 *
 * 判据只有时长（137 秒的片子不可能有 421 秒的字幕）。**不做内容匹配**：片名与台词
 * 本来可以毫无字面关系，误伤比漏判更糟。已知边界是抓不到"短但无关"那一档，见文件末尾。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { siteSubtitlesBelong } from '../src/storyboard/transcript-pass.js';

/** 造一段字幕：n 条，最后一条止于 lastTo */
const segs = (n, lastTo) => Array.from({ length: n }, (_, i) => ({
  from: (lastTo / n) * i,
  to: (lastTo / n) * (i + 1),
  text: `s${i}`,
}));

test('issue #99 的真实样本：137 秒的片子拿到止于 421 秒的字幕 → 拒绝', () => {
  const v = siteSubtitlesBelong(segs(229, 421), 137);
  assert.equal(v.ok, false);
  assert.equal(v.judged, true);
  assert.equal(v.lastTo, 421);
  assert.ok(v.ratio > 3 && v.ratio < 3.1);
});

test('对照样本：265 秒的片子拿到止于 247.9 秒的字幕 → 正常采用', () => {
  const v = siteSubtitlesBelong(segs(123, 247.9), 265);
  assert.equal(v.ok, true);
  assert.equal(v.judged, true);
});

test('容限边界：1.2x 放行（片尾容忍），1.31x 拒绝，正好 1.3x 放行', () => {
  assert.equal(siteSubtitlesBelong(segs(10, 72), 60).ok, true);        // 1.20x
  assert.equal(siteSubtitlesBelong(segs(10, 131), 100).ok, false);     // 1.31x
  assert.equal(siteSubtitlesBelong(segs(10, 130), 100).ok, true);      // 1.30x（<= 放行）
});

test('时长未知 / 空字幕 → 不判断，一律放行（宁可放行也不做无根据的拒绝）', () => {
  assert.deepEqual(
    { ok: siteSubtitlesBelong(segs(5, 99), 0).ok, judged: siteSubtitlesBelong(segs(5, 99), 0).judged },
    { ok: true, judged: false },
  );
  assert.equal(siteSubtitlesBelong(segs(5, 99), undefined).judged, false);
  assert.equal(siteSubtitlesBelong([], 137).judged, false);
  assert.equal(siteSubtitlesBelong(null, 137).judged, false);
});

test('字段坏掉不会把判据算成 NaN：缺 to / 字符串 to 都按"没有时间"处理', () => {
  // 一条都没有合法 to → 不判断（不是"ratio=NaN → 拒绝"）
  assert.equal(siteSubtitlesBelong([{ from: 0 }, { to: 'x' }], 100).judged, false);
  // 有一部分合法 → 用合法的最大值
  assert.equal(siteSubtitlesBelong([{ to: '500' }, { to: 3 }], 100).ok, false);
});

test('已知边界：短但无关的那一档抓不到（把它写下来，别让后来的人以为这闸是全的）', () => {
  // 报告人第二次拿到的是 20 条 / 51 秒的完全无关内容，短于本片 137 秒 —— 时长判据放行。
  // 这一条**故意**断言为 true：不是 bug，是判据的已知上限。
  const v = siteSubtitlesBelong(segs(20, 51), 137);
  assert.equal(v.ok, true, '时长比本片短不是拒的理由 —— 片尾没台词也会这样');
  assert.equal(v.judged, true);
});
