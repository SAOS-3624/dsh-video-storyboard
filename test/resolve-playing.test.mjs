/**
 * resolve-playing.test.mjs — 从"系统里在播什么"反推源。
 *
 * 这一层的唯一职责是**别认错**：认错一次，后面每一段都是错的。
 * 所以本地按文件名找、B 站按标题+时长找，找不到就返回 null 让上层去问。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cleanTitle, findLocalByTitle } from '../src/resolve-playing.js';

test('cleanTitle: 去掉站点后缀《》包着的书名号', () => {
  assert.equal(
    cleanTitle('熬夜32小时，我们苟进了AI大逃杀决赛圈！？_哔哩哔哩_bilibili'),
    '熬夜32小时，我们苟进了AI大逃杀决赛圈！？',
  );
  assert.equal(cleanTitle('标题 - bilibili'), '标题');
  assert.equal(cleanTitle('《某部电影》'), '某部电影');
  assert.equal(cleanTitle('普通标题'), '普通标题');
});

test('findLocalByTitle: 按文件名宽松命中（忽略标点空白大小写）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'resolve-'));
  try {
    await writeFile(join(dir, '记忆管理局 概念PV - 1.pv线上上传版更新(Av549304933,P1).mp4'), '');
    const hit = await findLocalByTitle('记忆管理局概念PV', { roots: [dir] });
    assert.ok(hit && hit.endsWith('.mp4'), `应命中本地文件，实得 ${hit}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('findLocalByTitle: 找不到就 null（不猜）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'resolve2-'));
  try {
    assert.equal(await findLocalByTitle('完全不存在的片子名', { roots: [dir] }), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('findLocalByTitle: 标题太短（<4 字）不搜，避免乱认', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'resolve3-'));
  try {
    await writeFile(join(dir, 'ab.mp4'), '');
    assert.equal(await findLocalByTitle('ab', { roots: [dir] }), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
