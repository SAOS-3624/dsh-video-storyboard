import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CACHE_VERSION, cacheKey, pruneCache, readCache, withCache, writeCache } from '../src/cache.js';

const withTemp = async (fn) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cache-'));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
};

test('cacheKey: 同输入稳定，窗口/阈值不同则不同', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-key-'));
  const file = join(dir, 'a.mp4');
  await writeFile(file, 'x'.repeat(1024));
  try {
    const a = await cacheKey({ input: file, start: 0, end: 100, threshold: 'auto' });
    const b = await cacheKey({ input: file, start: 0, end: 100, threshold: 'auto' });
    const c = await cacheKey({ input: file, start: 0, end: 200, threshold: 'auto' });
    const d = await cacheKey({ input: file, start: 0, end: 100, threshold: 15 });
    assert.equal(a, b);
    assert.notEqual(a, c, '窗口不同必须是不同的键');
    assert.notEqual(a, d, '阈值不同必须是不同的键');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('cacheKey: 文件不存在时返回 null（不缓存，也不报错）', async () => {
  assert.equal(await cacheKey({ input: join(tmpdir(), 'nope-9f2a.mp4') }), null);
});

test('读写往返', async () => {
  await withTemp(async (dir) => {
    await writeCache('abc', { value: { cuts: 3 } }, { dir });
    const hit = await readCache('abc', { dir });
    assert.deepEqual(hit.value, { cuts: 3 });
    // 别写死版本号：版本是用来失效旧缓存的，断言成常量会让每次升版都要改测试
    assert.equal(hit.v, CACHE_VERSION);
  });
});

test('读到坏 JSON 返回 null（fail-open）', async () => {
  await withTemp(async (dir) => {
    await writeFile(join(dir, 'bad.json'), '{ not json', 'utf8');
    assert.equal(await readCache('bad', { dir }), null);
  });
});

test('withCache: 第二次不调 producer', async () => {
  await withTemp(async (dir) => {
    let calls = 0;
    const producer = async () => { calls += 1; return { cuts: [1, 2] }; };
    const first = await withCache('k1', producer, { dir });
    const second = await withCache('k1', producer, { dir });
    assert.equal(calls, 1, 'producer 只应执行一次');
    assert.equal(first.cached, false);
    assert.equal(second.cached, true);
    assert.deepEqual(second.cuts, [1, 2]);
  });
});

test('pruneCache: 超预算时删最旧的', async () => {
  await withTemp(async (dir) => {
    for (let i = 0; i < 5; i++) {
      await writeCache(`f${i}`, { value: { pad: 'x'.repeat(1000) } }, { dir });
    }
    const before = (await readdir(dir)).length;
    const result = await pruneCache({ dir, maxBytes: 2500 });
    const after = (await readdir(dir)).length;
    assert.ok(after < before, `应删掉一些，${before} → ${after}`);
    assert.ok(result.removed > 0);
    assert.ok(result.bytes <= 2500, `剩余 ${result.bytes} 应 <= 2500`);
  });
});

test('pruneCache: 目录不存在时不炸', async () => {
  const r = await pruneCache({ dir: join(tmpdir(), 'no-such-dir-8f1a') });
  assert.equal(r.removed, 0);
});
