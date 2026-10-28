import test from 'node:test';
import assert from 'node:assert/strict';

import { __resetLifecycle, ensureAsr, isOwned, keepAlive, lifecycleConfig, portOf, probeEndpoint, scheduleStop, stopViaHttp } from '../src/asr-lifecycle.js';

test('lifecycleConfig: 没配 manage.start 就不托管', () => {
  assert.equal(lifecycleConfig({}), null);
  assert.equal(lifecycleConfig({ manage: {} }), null);
  const c = lifecycleConfig({ manage: { start: 'x.cmd' } });
  assert.equal(c.start, 'x.cmd');
  assert.equal(c.idleMs, 600_000, '默认 10 分钟：冷启动 30 秒，关太早等于每次重付');
});

test('probeEndpoint: /health 不通时退到 /v1/models', async () => {
  const calls = [];
  const fake = async (url) => {
    calls.push(url);
    if (url.endsWith('/health')) throw new Error('ECONNREFUSED');
    return { ok: true };
  };
  assert.equal(await probeEndpoint('http://127.0.0.1:8000/v1', { fetchImpl: fake }), true);
  assert.deepEqual(calls, ['http://127.0.0.1:8000/health', 'http://127.0.0.1:8000/v1/models']);
});

test('probeEndpoint: 两个都不通就是不可用', async () => {
  const fake = async () => { throw new Error('down'); };
  assert.equal(await probeEndpoint('http://127.0.0.1:8000/v1', { fetchImpl: fake }), false);
});

test('ensureAsr: 端点已经在跑 → 不启动、不算自己拥有', async () => {
  __resetLifecycle();
  let spawned = 0;
  const r = await ensureAsr({
    baseUrl: 'http://127.0.0.1:8000/v1',
    config: { manage: { start: 'x.cmd' } },
    fetchImpl: async () => ({ ok: true }),
    spawnImpl: () => { spawned += 1; return { pid: 1, unref() {} }; },
  });
  assert.equal(r.owned, false);
  assert.equal(spawned, 0, '别人已经在跑，不该再起一个');
});

test('ensureAsr: 端点死了 → 启动，并在 ready 后返回 owned=true', async () => {
  __resetLifecycle();
  let spawned = 0;
  let alive = false;
  const r = await ensureAsr({
    baseUrl: 'http://127.0.0.1:8000/v1',
    config: { manage: { start: 'x.cmd', waitMs: 5000 } },
    fetchImpl: async () => { if (!alive) throw new Error('down'); return { ok: true }; },
    spawnImpl: () => { spawned += 1; alive = true; return { pid: 4242, unref() {} }; },
  });
  assert.equal(spawned, 1);
  assert.equal(r.owned, true);
});

test('scheduleStop: 只停自己拥有的那个，别人启动的一律不碰', () => {
  __resetLifecycle();
  let killed = 0;
  assert.equal(scheduleStop({ owned: false, config: { manage: { start: 'x' } }, killImpl: () => { killed += 1; } }), false);
  assert.equal(scheduleStop({ owned: true, config: {}, killImpl: () => { killed += 1; } }), false, '没配置就不托管');
  assert.equal(killed, 0);
});

test('scheduleStop: 到点才停；中途 keepAlive 会取消', async () => {
  __resetLifecycle();
  let killed = 0;
  const ok = scheduleStop({
    owned: true,
    config: { manage: { start: 'x', idleMs: 30 } },
    killImpl: () => { killed += 1; },
  });
  assert.equal(ok, true);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(killed, 1, '空闲到点应该停');

  scheduleStop({ owned: true, config: { manage: { start: 'x', idleMs: 30 } }, killImpl: () => { killed += 1; } });
  keepAlive();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(killed, 1, 'keepAlive 之后不该再停');
});

test('portOf: 从 baseUrl 抠端口，没有端口用协议默认', () => {
  assert.equal(portOf('http://127.0.0.1:8000/v1'), 8000);
  assert.equal(portOf('http://example.com/v1'), 80);
  assert.equal(portOf('https://example.com/v1'), 443);
});

test('stopViaHttp: 服务支持 /shutdown 时返回 true，拒绝时返回 false', async () => {
  const ok = await stopViaHttp('http://127.0.0.1:8000/v1', { fetchImpl: async () => ({ ok: true }) });
  assert.equal(ok, true);
  const bad = await stopViaHttp('http://127.0.0.1:8000/v1', { fetchImpl: async () => ({ ok: false }) });
  assert.equal(bad, false);
  const dead = await stopViaHttp('http://127.0.0.1:8000/v1', { fetchImpl: async () => { throw new Error('down'); } });
  assert.equal(dead, false);
});

test('isOwned: 只有我们拉起的实例才算自己拥有', async () => {
  __resetLifecycle();
  assert.equal(isOwned(), false);

  let n = 0;
  await ensureAsr({
    baseUrl: 'http://127.0.0.1:8000/v1',
    config: { manage: { start: 'x.cmd', waitMs: 3000 } },
    // probeEndpoint 会先试 /health 再试 /v1/models，所以前两次都失败才算端点没起
    fetchImpl: async () => { n += 1; if (n <= 2) throw new Error('down'); return { ok: true }; },
    spawnImpl: () => ({ pid: 777, unref() {} }),
  });
  assert.equal(isOwned(), true, '拉起之后应该被记为"我们拥有的"');

  __resetLifecycle();
  await ensureAsr({
    baseUrl: 'http://127.0.0.1:8000/v1',
    config: { manage: { start: 'x.cmd' } },
    fetchImpl: async () => ({ ok: true }),
    spawnImpl: () => { throw new Error('should not spawn'); },
  });
  assert.equal(isOwned(), false, '别人已经在跑，不该记成我们拥有');
});

test('lifecycleConfig: start 支持数组（直接起 exe，不经过 .cmd）', () => {
  const c = lifecycleConfig({ manage: { start: ['C:/py.exe', 'srv.py'] } });
  assert.deepEqual(c.start, ['C:/py.exe', 'srv.py']);
  const s = lifecycleConfig({ manage: { start: 'a.cmd' } });
  assert.equal(s.start, 'a.cmd');
});

test('ensureAsr: 数组形式按 [exe, ...args] 起进程，且隐藏窗口', async () => {
  __resetLifecycle();
  const calls = [];
  let n = 0;
  await ensureAsr({
    baseUrl: 'http://127.0.0.1:8000/v1',
    config: { manage: { start: ['C:/py.exe', 'srv.py'], waitMs: 3000 } },
    fetchImpl: async () => { n += 1; if (n <= 2) throw new Error('down'); return { ok: true }; },
    spawnImpl: (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { pid: 99, unref() {} }; },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'C:/py.exe');
  assert.deepEqual(calls[0].args, ['srv.py']);
  assert.equal(calls[0].opts.windowsHide, true, '必须隐藏窗口，否则会弹一个 cmd 黑框');
});

test('lifecycleConfig: start 直接写成 .py 时自动补解释器（否则 spawn 什么也不会发生）', () => {
  const c = lifecycleConfig({ manage: { start: 'D:/asr-local/server-sherpa.py' } });
  assert.ok(Array.isArray(c.start), '.py 应该被包成 [python, script]');
  assert.equal(c.start.length, 2);
  // 解释器在不同平台上叫 python / python.exe / python3 —— 只要求它是个 python
  assert.match(c.start[0], /python(3|\.exe)?$/i, `unexpected interpreter: ${c.start[0]}`);
  assert.equal(c.start[1], 'D:/asr-local/server-sherpa.py');
  // 非 .py 保持原样
  assert.equal(lifecycleConfig({ manage: { start: 'x.cmd' } }).start, 'x.cmd');
});
