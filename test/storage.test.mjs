/**
 * storage.test.mjs — 磁盘缓存只有一个总预算（默认 300 MB）。
 *
 * 守两件事：
 *   1. 媒体和 JSON 加起来不超过预算（以前是 50 MB + 300 MB 两个独立盖子）；
 *   2. 状态文件（台词/看过/cell 映射/延迟标定）永远不被裁掉。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PROTECTED_FILES, pruneCache } from '../src/cache.js';
import { pruneStorage, storageUsage, STORAGE_BUDGET_BYTES } from '../src/storage.js';

const fill = async (path, bytes) => writeFile(path, Buffer.alloc(bytes, 1));

const mk = async () => {
  const root = await mkdtemp(join(tmpdir(), 'storage-'));
  const dir = join(root, 'cache');
  const media = join(root, 'media');
  await mkdir(dir, { recursive: true });
  await mkdir(media, { recursive: true });
  return { root, dir, media };
};

/** 把 mtime 拉开，让"从旧到新"的顺序确定 */
const age = async (path, minutesAgo) => {
  const t = new Date(Date.now() - minutesAgo * 60_000);
  await utimes(path, t, t);
};

test('默认预算是 300 MB', () => {
  assert.equal(STORAGE_BUDGET_BYTES, 300 * 1024 * 1024);
});

test('媒体和 JSON 一起算，超了就删，按最旧的先删', async () => {
  const { root, dir, media } = await mk();
  try {
    // JSON：三个 100 KB
    for (const [i, name] of ['a', 'b', 'c'].entries()) {
      const p = join(dir, `${name}.json`);
      await fill(p, 100 * 1024);
      await age(p, 30 - i * 10);           // a 最旧
    }
    // 媒体：两条视频，各 400 KB
    for (const [i, name] of ['old', 'new'].entries()) {
      await mkdir(join(media, name), { recursive: true });
      const p = join(media, name, 'video.mp4');
      await fill(p, 400 * 1024);
      await age(p, 20 - i * 10);           // old 更旧
    }

    const before = await storageUsage({ dir, media });
    assert.ok(before.total > 500 * 1024, `准备数据应有 ~1.1MB，实得 ${before.total}`);

    const r = await pruneStorage({ dir, media, budgetBytes: 700 * 1024 });
    assert.ok(r.total <= 700 * 1024, `裁剪后应 ≤ 700KB，实得 ${r.total}`);
    assert.ok(r.removedMedia >= 1, '应该先删媒体');

    const left = await readdir(media);
    assert.deepEqual(left, ['new'], '先删最旧的那条视频');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('状态文件不会被当成缓存删掉', async () => {
  const { root, dir } = await mk();
  try {
    for (const name of PROTECTED_FILES) {
      await fill(join(dir, name), 10 * 1024);
      await age(join(dir, name), 500);     // 故意做得很旧：按 mtime 早该被删
    }
    await fill(join(dir, 'scan1.json'), 200 * 1024);
    await age(join(dir, 'scan1.json'), 10);

    const r = await pruneStorage({ dir, media: join(root, 'nope'), budgetBytes: 1 });
    assert.ok(r.json <= 1, '预算为 1 字节时，可裁的 JSON 应该被清空');
    const left = await readdir(dir);
    for (const name of PROTECTED_FILES) {
      assert.ok(left.includes(name), `${name} 不该被删`);
    }
    assert.ok(!left.includes('scan1.json'), '普通缓存应该被删');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('pruneCache 自己也不会碰 watch.json', async () => {
  const { root, dir } = await mk();
  try {
    await fill(join(dir, 'watch.json'), 4 * 1024);
    await age(join(dir, 'watch.json'), 999);
    await fill(join(dir, 'x.json'), 50 * 1024);
    await age(join(dir, 'x.json'), 999);
    const r = await pruneCache({ dir, maxBytes: 0 });
    assert.equal(r.removed, 1, '只该删掉 x.json');
    const left = await readdir(dir);
    assert.deepEqual(left, ['watch.json']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
