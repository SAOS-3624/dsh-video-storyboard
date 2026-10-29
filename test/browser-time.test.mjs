/**
 * browser-time.test.mjs — 从浏览器读真实播放位置。
 *
 * 这条是给"SMTC 刷新太稀疏"兜底的：浏览器里的 `currentTime` 是毫秒级真值。
 * 但它是**显式开启**的（要带 --remote-debugging-port 启动），而且必须排除宿主自己的页面。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { hasDebugPort, listTargets, pickVideoTarget, readBrowserPosition } from '../src/browser-time.js';

test('端口没开就返回 null（不抛错，不打扰）', async () => {
  const port = 6553;                       // 没人监听
  assert.equal(await listTargets({ port, timeoutMs: 400 }), null);
  assert.equal(await hasDebugPort({ port }), false);
  assert.equal(await readBrowserPosition({ port, timeoutMs: 400 }), null);
});

test('挑目标时 bilibili 页面优先', () => {
  const targets = [
    { type: 'page', id: 'a', url: 'https://example.com/', webSocketDebuggerUrl: 'ws://a' },
    { type: 'page', id: 'b', url: 'https://www.bilibili.com/video/BV1xx', webSocketDebuggerUrl: 'ws://b' },
    { type: 'background_page', id: 'c', url: 'https://x/', webSocketDebuggerUrl: 'ws://c' },
  ];
  assert.equal(pickVideoTarget(targets).id, 'b');
});

test('没有页面目标就 null（不是抛错）', () => {
  assert.equal(pickVideoTarget([]), null);
  assert.equal(pickVideoTarget([{ type: 'service_worker', url: 'x' }]), null);
});
