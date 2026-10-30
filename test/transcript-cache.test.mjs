/**
 * transcript-cache.test.mjs — ASR 转一次，后面任何子窗口都该免费复用。
 *
 * 守两条：① 只有**完整覆盖**才算命中（半段转写被当成完整结果 = 模型以为这段没台词）；
 * ② 后端换了（模型/切片长度/热词）就不能复用，否则会拿旧模型的错字当新结果。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { cachedTranscript, rememberTranscript } from '../src/storyboard/transcript-cache.js';

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tc-'));
  const prev = process.env.DSH_VIDEO_CACHE_DIR;
  process.env.DSH_VIDEO_CACHE_DIR = dir;
  t.after(async () => {
    if (prev === undefined) delete process.env.DSH_VIDEO_CACHE_DIR;
    else process.env.DSH_VIDEO_CACHE_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  });
  const file = join(dir, 'a.mp4');
  await writeFile(file, 'not really a video');
  return file;
}

test('按片缓存：窗口被完整覆盖才命中，切出来的句子夹在窗口内', async (t) => {
  const file = await setup(t);
  await rememberTranscript(file, {
    from: 0, to: 120,
    segments: [
      { from: 10, to: 12, text: '一' },
      { from: 50, to: 55, text: '二' },
      { from: 100, to: 102, text: '三' },
    ],
    backend: 'b1',
  });

  const hit = await cachedTranscript(file, { from: 48, to: 60, backend: 'b1' });
  assert.ok(hit, '0-120 应覆盖 48-60');
  assert.equal(hit.segments.length, 1);
  assert.equal(hit.segments[0].text, '二');
  assert.equal(hit.segments[0].from, 50, '句子起点在窗口内，不该被裁');

  const clipped = await cachedTranscript(file, { from: 52, to: 60, backend: 'b1' });
  assert.equal(clipped.segments[0].from, 52, '跨越窗口起点的句子要裁到窗口内');

  assert.equal(await cachedTranscript(file, { from: 0, to: 200, backend: 'b1' }), null,
    '窗口超出已转写范围就不算命中 —— 不能用半段结果冒充整段');
  assert.equal(await cachedTranscript(file, { from: 0, to: 120, backend: 'b2' }), null,
    '换后端不能复用');
});

test('按片缓存：新段包含旧段时不留重复句子', async (t) => {
  const file = await setup(t);
  await rememberTranscript(file, {
    from: 0, to: 60, segments: [{ from: 1, to: 2, text: '旧' }], backend: 'b1',
  });
  await rememberTranscript(file, {
    from: 0, to: 120, segments: [{ from: 1, to: 2, text: '新' }], backend: 'b1',
  });
  const hit = await cachedTranscript(file, { from: 0, to: 120, backend: 'b1' });
  assert.equal(hit.segments[0].text, '新');
});
