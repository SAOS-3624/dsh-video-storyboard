import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { declaredBytes, downloadResumable, muxStreams, pickAudioFormat } from '../src/resume.js';

/* ---- 工具 ---- */

/** 起一个只听 127.0.0.1 的临时服务器，跑完就关 */
async function withServer(handler, fn) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function withWorkdir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'resume-test-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 发一半就掐断连接 —— 模拟 B 站 CDN 的 `Remote end closed connection` */
function truncateAfter(res, body, half) {
  res.writeHead(200, { 'content-length': body.length });
  res.write(body.subarray(0, half), () => {
    setTimeout(() => res.socket.destroy(), 20);
  });
}

const PAYLOAD = Buffer.alloc(64 * 1024, 7);

/* ---- pickAudioFormat ---- */

test('pickAudioFormat 只挑纯声音轨，按码率从高到低', () => {
  const formats = [
    { vcodec: 'avc1', acodec: 'mp4a', tbr: 900 },
    { vcodec: 'none', acodec: 'mp4a', abr: 64, format_id: '30216' },
    { vcodec: 'none', acodec: 'mp4a', abr: 192, format_id: '30280' },
    { vcodec: 'none', acodec: 'none' },
    { vcodec: 'none', acodec: 'mp4a', tbr: 132 },
  ];
  assert.equal(pickAudioFormat(formats).format_id, '30280');
  assert.equal(pickAudioFormat([]), null);
  assert.equal(pickAudioFormat([{ vcodec: 'avc1', acodec: 'mp4a' }]), null);
});

test('declaredBytes 先看 filesize，再看 filesize_approx，都没有就 null', () => {
  assert.equal(declaredBytes({ filesize: 2048, filesize_approx: 1024 }), 2048);
  assert.equal(declaredBytes({ filesize_approx: 1024 }), 1024);
  assert.equal(declaredBytes({}), null);
  assert.equal(declaredBytes(null), null);
});

/* ---- downloadResumable ---- */

test('downloadResumable 一把下完，并按 content-length 推断总长', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'content-length': PAYLOAD.length });
      res.end(PAYLOAD);
    },
    (base) => withWorkdir(async (dir) => {
      const dest = join(dir, 'a.bin');
      const result = await downloadResumable({ url: `${base}/v`, dest });
      assert.equal(result.bytes, PAYLOAD.length);
      assert.equal(result.total, PAYLOAD.length);
      assert.deepEqual(await readFile(dest), PAYLOAD);
    }),
  );
});

test('downloadResumable 以服务器给的总长为准，不被偏大的 filesize 误判成"没下完"', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'content-length': PAYLOAD.length });
      res.end(PAYLOAD);
    },
    (base) => withWorkdir(async (dir) => {
      // 实测 B 站的 filesize 与真实字节数有几十上百字节的出入，拿它当硬校验会误报
      const dest = join(dir, 'f.bin');
      const result = await downloadResumable({ url: `${base}/v`, dest, expectedBytes: PAYLOAD.length + 5000 });
      assert.equal(result.total, PAYLOAD.length);
      assert.equal(result.bytes, PAYLOAD.length);
    }),
  );
});

test('downloadResumable 第一轮被掐断，第二轮带 Range 续上', async () => {
  let seenRange = null;
  await withServer(
    (req, res) => {
      const range = req.headers.range;
      if (!range) return truncateAfter(res, PAYLOAD, PAYLOAD.length / 2);
      seenRange = range;
      const start = Number(/bytes=(\d+)-/.exec(range)[1]);
      res.writeHead(206, {
        'content-length': PAYLOAD.length - start,
        'content-range': `bytes ${start}-${PAYLOAD.length - 1}/${PAYLOAD.length}`,
      });
      res.end(PAYLOAD.subarray(start));
    },
    (base) => withWorkdir(async (dir) => {
      const dest = join(dir, 'b.bin');
      const result = await downloadResumable({ url: `${base}/v`, dest, rounds: 4 });
      assert.equal(seenRange, `bytes=${PAYLOAD.length / 2}-`);
      assert.equal(result.bytes, PAYLOAD.length);
      assert.equal(result.rounds, 2);
      assert.deepEqual(await readFile(dest), PAYLOAD);
    }),
  );
});

test('downloadResumable 服务器不认 Range 时从头重来，不拼出重复内容', async () => {
  let hits = 0;
  await withServer(
    (req, res) => {
      hits += 1;
      // 第一轮：发一半掐断；之后：**无视 Range**，老老实实整份 200
      if (hits === 1) return truncateAfter(res, PAYLOAD, PAYLOAD.length / 2);
      res.writeHead(200, { 'content-length': PAYLOAD.length });
      res.end(PAYLOAD);
    },
    (base) => withWorkdir(async (dir) => {
      const dest = join(dir, 'c.bin');
      const result = await downloadResumable({ url: `${base}/v`, dest, rounds: 4 });
      assert.equal(hits, 2);
      assert.equal(result.bytes, PAYLOAD.length);
      assert.deepEqual(await readFile(dest), PAYLOAD);
    }),
  );
});

test('downloadResumable 连续两轮零进展就停，不把超时预算耗光', async () => {
  let hits = 0;
  await withServer(
    (req, res) => {
      hits += 1;
      res.writeHead(206, {
        'content-length': 0,
        'content-range': `bytes 0-0/${PAYLOAD.length}`,
      });
      res.end();
    },
    (base) => withWorkdir(async (dir) => {
      const dest = join(dir, 'd.bin');
      await assert.rejects(
        downloadResumable({ url: `${base}/v`, dest, rounds: 10 }),
        /incomplete download after \d+ rounds/,
      );
      assert.equal(hits, 2);
    }),
  );
});

test('downloadResumable 遇到 403 立刻失败，不重试', async () => {
  let hits = 0;
  await withServer(
    (req, res) => {
      hits += 1;
      res.writeHead(403, { 'content-length': 0 });
      res.end();
    },
    (base) => withWorkdir(async (dir) => {
      await assert.rejects(
        downloadResumable({ url: `${base}/v`, dest: join(dir, 'e.bin'), rounds: 6 }),
        /HTTP 403/,
      );
      assert.equal(hits, 1);
    }),
  );
});

test('downloadResumable 拒绝非 http(s) 地址', async () => {
  await assert.rejects(downloadResumable({ url: 'file:///etc/passwd', dest: '/tmp/x' }), /not an http/);
});

/* ---- muxStreams ---- */

test('muxStreams 找不到 ffmpeg 时报错，而不是静默产出空文件', async () => {
  await withWorkdir(async (dir) => {
    const video = join(dir, 'v.mp4');
    await assert.rejects(
      muxStreams({ video, out: join(dir, 'o.mp4'), ffmpegPath: join(dir, 'no-such-ffmpeg') }),
      /failed to spawn|ENOENT/,
    );
    const st = await stat(join(dir, 'o.mp4')).catch(() => null);
    assert.equal(st, null);
  });
});
