import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describeMemory, memoryPath, recall, remember } from '../src/storyboard/memory.js';

async function withTempEnv(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mem-'));
  const env = { DSH_VIDEO_CACHE_DIR: dir };
  try {
    return await fn(env, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('memory: 没看过时不产生任何提示', async () => {
  await withTempEnv(async (env) => {
    const info = { path: 'D:/v/a.mp4', duration: 100 };
    assert.equal(await describeMemory(info, { env }), null);
  });
});

test('memory: 记一次之后能回放，且区分窗口', async () => {
  await withTempEnv(async (env, dir) => {
    const info = { path: 'D:/v/a.mp4', duration: 100 };
    await remember(info, { from: 0, to: 30, cells: 9, cuts: 12 }, { env });
    await remember(info, { from: 30, to: 60, cells: 9, cuts: 20 }, { env });

    const m = await recall(info, { env });
    assert.equal(m.windows, 2);
    assert.equal(m.entries.length, 2);

    const text = await describeMemory(info, { env });
    assert.match(text, /2 window\(s\) analysed before/);
    assert.match(text, /cite that instead of describing it again/);
    assert.ok(memoryPath(env).startsWith(dir));
  });
});

test('memory: 路径大小写与分隔符归一化（同一个文件不该算两份）', async () => {
  await withTempEnv(async (env) => {
    await remember({ path: 'D:\\V\\A.MP4', duration: 10 }, { from: 0, to: 5, cells: 4, cuts: 1 }, { env });
    const m = await recall({ path: 'd:/v/a.mp4', duration: 10 }, { env });
    assert.equal(m.entries.length, 1, '反斜杠 + 大小写不同的同一路径应命中');
  });
});

test('memory: 不同文件互不影响', async () => {
  await withTempEnv(async (env) => {
    await remember({ path: 'D:/v/a.mp4', duration: 10 }, { from: 0, to: 5, cells: 4, cuts: 1 }, { env });
    assert.equal(await describeMemory({ path: 'D:/v/b.mp4', duration: 10 }, { env }), null);
  });
});

test('memory: 写不进去也不抛（缓存目录不可写）', async () => {
  const env = { DSH_VIDEO_CACHE_DIR: 'Z:/definitely/not/here' };
  await remember({ path: 'D:/v/a.mp4', duration: 10 }, { from: 0, to: 5, cells: 4, cuts: 1 }, { env });
  assert.equal(await describeMemory({ path: 'D:/v/a.mp4', duration: 10 }, { env }), null);
});
