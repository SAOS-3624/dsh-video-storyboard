/**
 * subtitle-failed.test.mjs — 「抓站点字幕失败了」必须和「没配 ASR」分得开（issue #86）。
 *
 * 病：`subtitles.js` 的 `fetchOnce()` 会返回 `no-ytdlp` / `no-subs` / `failed` / `needs-login`，
 * 但只有 `needs-login` 会被单独提示。其余几种一路掉到 `transcript="no-key"`，
 * 而 `no-key` 的含义是"没配 ASR、压根没尝试" —— 用户看到它就去配 ASR，
 * 可实际要修的是 yt-dlp。
 *
 * 判定收在 `subtitleMissSource()`（纯函数）和 `memoizable()`（纯函数）里，
 * 这里直接把四种 reason 都咬一遍。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { subtitleMissSource } from '../src/storyboard/transcript-pass.js';
import { memoizable } from '../src/storyboard/subtitles.js';

test('no-ytdlp：尝试过但工具不在 → subtitle-failed，不是 no-key', () => {
  const got = subtitleMissSource({ remote: { ok: false, reason: 'no-ytdlp' }, willTranscribe: false });
  assert.equal(got.source, 'subtitle-failed');
  assert.equal(got.reason, 'no-ytdlp');
});

test('failed：带 detail 一起透出去（stderr 末段是唯一线索）', () => {
  const got = subtitleMissSource({
    remote: { ok: false, reason: 'failed', detail: 'ENOSPC: no space left on device' },
    willTranscribe: false,
  });
  assert.equal(got.source, 'subtitle-failed');
  assert.equal(got.reason, 'failed');
  assert.match(got.detail, /ENOSPC/);
  assert.ok(got.detail.length <= 300, '清单里不该塞一坨 stderr');
});

test('no-subs：这条片子确实没有站点字幕 → 仍然是 no-key（别把结论说成故障）', () => {
  const got = subtitleMissSource({ remote: { ok: false, reason: 'no-subs' }, willTranscribe: false });
  assert.equal(got.source, 'no-key');
});

test('needs-login：由 subtitleNeedsLogin 单独提示，这里维持 no-key', () => {
  const got = subtitleMissSource({ remote: { ok: false, reason: 'needs-login' }, willTranscribe: false });
  assert.equal(got.source, 'no-key');
});

test('会跑 ASR 时不下结论（字幕没抓到只是背景信息）', () => {
  assert.equal(subtitleMissSource({ remote: { ok: false, reason: 'no-ytdlp' }, willTranscribe: true }), null);
  assert.equal(subtitleMissSource({ remote: null, willTranscribe: true }), null);
});

test('没有远程字幕这一步（本地文件 / 显式关掉）→ no-key', () => {
  assert.equal(subtitleMissSource({ remote: null, willTranscribe: false }).source, 'no-key');
  assert.equal(subtitleMissSource({}).source, 'no-key');
});

// ---- memo：只有"结论不会变"的才缓存 ----

test('memo：成功和"确实没字幕"记住，环境类失败不记', () => {
  assert.equal(memoizable({ ok: true, segments: [] }), true);
  assert.equal(memoizable({ ok: false, reason: 'no-subs' }), true, '这条片子没字幕是结论，不随环境变');

  assert.equal(memoizable({ ok: false, reason: 'no-ytdlp' }), false, '装上 yt-dlp 就该重试');
  assert.equal(memoizable({ ok: false, reason: 'failed' }), false, '临时目录写不进去是瞬时的');
  assert.equal(memoizable({ ok: false, reason: 'needs-login' }), false, '登录完就该重试');
  assert.equal(memoizable(null), false);
});
