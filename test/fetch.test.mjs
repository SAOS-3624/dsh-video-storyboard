import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertFetchableUrl, discoverYtdlp, explainYtdlpError, fetchMedia, formatSelector, isHttpUrl,
  loadVideoConfig, mediaKey, normalizeUrl, pickVideoFormat, pruneMedia, resolveAuth, resolveDirectUrl,
  summariseInfo, unwrapSingle,
  __clearDirectCache,
} from '../src/fetch.js';

/* ---------------------------------------------------------------- 链接判别 */

test('isHttpUrl: 只认 http(s)，裸路径与 file:// 都不算', () => {
  assert.equal(isHttpUrl('https://www.bilibili.com/video/BV1xx'), true);
  assert.equal(isHttpUrl('http://example.com/a.mp4'), true);
  assert.equal(isHttpUrl('D:/videos/a.mp4'), false);
  assert.equal(isHttpUrl('C:\\videos\\a.mp4'), false);
  assert.equal(isHttpUrl('file:///c:/a.mp4'), false);
  assert.equal(isHttpUrl(undefined), false);
});

test('assertFetchableUrl: 拒绝内网与回环（防 SSRF）', () => {
  for (const bad of [
    'http://127.0.0.1/a', 'http://localhost/a', 'http://10.0.0.5/a',
    'http://192.168.1.1/a', 'http://172.16.0.1/a', 'http://169.254.169.254/latest/meta-data',
  ]) {
    assert.throws(() => assertFetchableUrl(bad), /private\/loopback|only http/, bad);
  }
  assert.equal(assertFetchableUrl('https://www.bilibili.com/video/BV1xx'), 'https://www.bilibili.com/video/BV1xx');
});

test('normalizeUrl: 去掉站外跟踪参数，但保留分P', () => {
  const a = normalizeUrl('https://www.bilibili.com/video/BV1xx?spm_id_from=333.999&vd_source=abc&p=2');
  assert.ok(!a.includes('spm_id_from'));
  assert.ok(!a.includes('vd_source'));
  assert.ok(a.includes('p=2'), '分P 必须保留，否则不同 P 会撞同一个缓存键');
});

test('normalizeUrl: 同一链接的两种写法得到同一个键', () => {
  const a = normalizeUrl('https://www.bilibili.com/video/BV1xx?spm_id_from=1');
  const b = normalizeUrl('https://WWW.bilibili.com/video/BV1xx');
  assert.equal(mediaKey(a, 360), mediaKey(b, 360));
});

test('mediaKey: 清晰度不同 → 键不同', () => {
  const u = 'https://example.com/v';
  assert.notEqual(mediaKey(u, 360), mediaKey(u, 1080));
});

/* ---------------------------------------------------------------- 格式选择 */

test('formatSelector: B 站是 DASH，必须 bv*+ba 而不是 b', () => {
  // 渐进式单文件优先（快、不用合流），拿不到再退 DASH
  assert.equal(formatSelector(360), 'b[height<=360]/bv*[height<=360]+ba/b[height<=360]/bv*+ba/b');
  assert.equal(formatSelector(1080, { withAudio: false }), 'b[height<=1080]/bv*[height<=1080]/bv*/b');
  assert.equal(formatSelector(0), 'bv*+ba/b');
});

test('formatSelector: 末尾必须留无筛选兜底（竖屏 height 是长边，会一个都匹配不到）', () => {
  // 9:16 视频在 yt-dlp 里是 360x640 / 480x852：height<=480 匹配不到任何格式
  assert.ok(formatSelector(480).endsWith('/bv*+ba/b'));
  assert.ok(formatSelector(480).startsWith('b[height<=480]'), '先试渐进式');
  assert.ok(formatSelector(480, { withAudio: false }).endsWith('/bv*/b'));
});

test('summariseInfo: 只统计有画面的轨道，高度去重升序', () => {
  const s = summariseInfo({
    title: 't', duration: 90.5,
    formats: [
      { vcodec: 'none', acodec: 'mp4a', height: null },
      { vcodec: 'avc1', height: 720 },
      { vcodec: 'avc1', height: 360 },
      { vcodec: 'avc1', height: 720 },
      { vcodec: 'avc1', height: 1080 },
    ],
  });
  assert.deepEqual(s.heights, [360, 720, 1080]);
  assert.equal(s.maxHeight, 1080);
  assert.equal(s.title, 't');
  assert.equal(s.duration, 90.5);
});

test('summariseInfo: 没有任何画面轨道时 maxHeight 为 null，不臆造', () => {
  const s = summariseInfo({ formats: [{ vcodec: 'none', acodec: 'mp4a' }] });
  assert.deepEqual(s.heights, []);
  assert.equal(s.maxHeight, null);
});

test('unwrapSingle: 播放列表取第一个条目，空列表明确报错', () => {
  assert.deepEqual(unwrapSingle({ _type: 'playlist', entries: [{ id: 'a' }] }, 'u'), { id: 'a' });
  assert.deepEqual(unwrapSingle({ id: 'b' }, 'u'), { id: 'b' });
  assert.throws(() => unwrapSingle({ _type: 'playlist', entries: [] }, 'u'), /no playable entry/);
});

/* ---------------------------------------------------------------- 认证 */

test('resolveAuth: 没 cookie 不阻断，返回 anonymous + 一条告警', async () => {
  // 早期版本在这里直接抛错。实测反例：BV1BK411Q7ys 匿名就有 1080p，硬拦只会
  // 让模型白跑好几轮排查。现在改成"先探再判断"。
  const auth = await resolveAuth({ env: { DSH_HOME: tmpdir() }, config: {} });
  assert.equal(auth.kind, 'anonymous');
  assert.equal(auth.cookiesPath, null);
  assert.match(auth.warning, /not guaranteed/);
  assert.match(auth.warning, /video\.json/);
});

test('resolveAuth: allowAnonymous 表示"我知道是匿名，别提醒我"', async () => {
  const auth = await resolveAuth({ env: {}, config: {}, allowAnonymous: true });
  assert.equal(auth.kind, 'anonymous');
  assert.equal(auth.warning, null, '显式认了匿名就不该再唠叨');
});

test('resolveAuth: 指向不存在的 cookie 文件时直接报错，不悄悄转匿名', async () => {
  await assert.rejects(() => resolveAuth({ cookies: join(tmpdir(), 'no-such-cookies.txt'), env: {}, config: {} }),
    /cookies file not found/);
});

test('loadVideoConfig: 读不到时返回空对象，不抛错', async () => {
  const config = await loadVideoConfig({ env: { DSH_HOME: join(tmpdir(), 'definitely-no-dsh-home') } });
  assert.deepEqual(config, {});
});

test('resolveAuth: ~/.dsh/video.json 里的 cookies 会被用上（桌面版读不到 setx 变量）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cfg-'));
  try {
    const cookies = join(root, 'ck.txt');
    await writeFile(cookies, '# Netscape\n', 'utf8');
    await writeFile(join(root, 'video.json'), JSON.stringify({ cookies }), 'utf8');
    const auth = await resolveAuth({ env: { DSH_HOME: root } });
    assert.equal(auth.kind, 'cookies');
    assert.equal(auth.cookiesPath, cookies);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolveAuth: 环境变量优先于配置文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cfg2-'));
  try {
    const fromFile = join(root, 'a.txt');
    const fromEnv = join(root, 'b.txt');
    await writeFile(fromFile, '# Netscape\n', 'utf8');
    await writeFile(fromEnv, '# Netscape\n', 'utf8');
    await writeFile(join(root, 'video.json'), JSON.stringify({ cookies: fromFile }), 'utf8');
    const auth = await resolveAuth({ env: { DSH_HOME: root, DSH_VIDEO_COOKIES: fromEnv } });
    assert.equal(auth.cookiesPath, fromEnv);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/* ---------------------------------------------------------------- 错误翻译 */

test('explainYtdlpError: 四种常见失败各自给出可执行的结论', () => {
  assert.match(explainYtdlpError('ERROR: Failed to decrypt with DPAPI'), /App-Bound/);
  assert.match(explainYtdlpError('ERROR: Sign in to confirm you are not a bot'), /SESSDATA may also have expired/);
  assert.match(explainYtdlpError('ERROR: HTTP Error 412: Precondition Failed'), /rate-limited/);
  assert.match(explainYtdlpError('ERROR: Requested format is not available'), /DASH tracks/);
});

test('explainYtdlpError: 认不出的错误保留最后三行，不吞', () => {
  const msg = explainYtdlpError('line1\nline2\nline3\nline4', 3);
  assert.match(msg, /exited 3/);
  assert.match(msg, /line4/);
});

/* ---------------------------------------------------------------- 端到端（假 yt-dlp） */

const FAKE_SOURCE = `
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('9999.01.01'); process.exit(0); }
if (process.env.FAKE_FAIL === '1') {
  console.error('ERROR: Sign in to confirm you are not a bot');
  process.exit(1);
}
if (args.includes('-J')) {
  console.log(JSON.stringify({
    title: 'fake video', duration: 60,
    filesize_approx: 1024 * 1024,
    formats: [
      { vcodec: 'none', acodec: 'mp4a', url: 'https://cdn/audio.m4a' },
      { vcodec: 'avc1', height: 360, tbr: 300, url: 'https://cdn/v360.mp4', http_headers: { Referer: 'https://www.bilibili.com/' } },
      { vcodec: 'avc1', height: 720, tbr: 900, url: 'https://cdn/v720.mp4' },
      { vcodec: 'avc1', height: 1080, tbr: 1500, url: 'https://cdn/v1080.mp4?deadline=1793121239' },
    ],
  }));
  process.exit(0);
}
const outAt = args.indexOf('-o');
if (outAt !== -1) {
  const real = args[outAt + 1].replace('%(ext)s', process.env.FAKE_EXT || 'mp4');
  mkdirSync(dirname(real), { recursive: true });
  writeFileSync(real, Buffer.alloc(2048, 7));
}
console.log('[download] 100%');
`;

async function makeHarness() {
  // 直链缓存是模块级的，测试之间必须隔离 —— 否则上一条用例记住的 URL 会被下一条命中
  __clearDirectCache();
  const root = await mkdtemp(join(tmpdir(), 'dsh-fetch-'));
  const fake = join(root, 'fake-ytdlp.mjs');
  await writeFile(fake, FAKE_SOURCE, 'utf8');
  const media = join(root, 'media');
  const cookies = join(root, 'cookies.txt');
  await writeFile(cookies, '# Netscape HTTP Cookie File\n.bilibili.com\tTRUE\t/\tFALSE\t1\tSESSDATA\tx\n', 'utf8');
  const ytdlp = { bin: process.execPath, prefix: [fake] };
  // DSH_HOME 指向临时目录：否则 resolveAuth 会去读真实的 ~/.dsh/video.json，
  // 让测试结果依赖这台机器上配了什么
  const env = { DSH_VIDEO_MEDIA_DIR: media, DSH_VIDEO_MEDIA_MAX_MB: '300', DSH_HOME: root };
  return { root, media, cookies, ytdlp, env, fake, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('fetchMedia: 解析 → 下载 → 第二次命中缓存', async () => {
  const h = await makeHarness();
  try {
    const first = await fetchMedia('https://www.bilibili.com/video/BV1xx', {
      ytdlp: h.ytdlp, env: h.env, cookies: h.cookies,
    });
    assert.equal(first.source.cached, false);
    assert.equal(first.source.maxAvailable, 1080);
    assert.deepEqual(first.source.availableHeights, [360, 720, 1080]);
    assert.equal(first.source.auth, 'cookies');
    assert.equal(first.source.scanActual, 360);
    assert.equal(first.source.zoomTarget, 1080);
    assert.equal(first.source.degraded, undefined, '能拿到 1080 就不该标降级');
    assert.equal((await stat(first.path)).size, 2048);

    const second = await fetchMedia('https://www.bilibili.com/video/BV1xx', {
      ytdlp: h.ytdlp, env: h.env, cookies: h.cookies,
    });
    assert.equal(second.source.cached, true, '同一条链接第二次必须命中，否则下游缓存全部失效');
    assert.equal(second.path, first.path, '路径必须稳定');
  } finally {
    await h.cleanup();
  }
});

test('fetchMedia: DASH 产出 video.f100022.mp4 时收敛到 video.mp4', async () => {
  const h = await makeHarness();
  const prev = process.env.FAKE_EXT;
  process.env.FAKE_EXT = 'f100022.mp4';
  try {
    const r = await fetchMedia('https://www.bilibili.com/video/BV1dash', {
      ytdlp: h.ytdlp, env: h.env, cookies: h.cookies, scanHeight: 360,
    });
    assert.equal(r.path.endsWith('video.mp4'), true, '最终路径必须是稳定的 video.mp4');
    assert.equal((await stat(r.path)).size, 2048);
    assert.equal(r.source.bytes, 2048);
    assert.ok(!(await readdir(h.media, { recursive: true })).some((n) => String(n).includes('f100022')));
  } finally {
    if (prev === undefined) delete process.env.FAKE_EXT; else process.env.FAKE_EXT = prev;
    await h.cleanup();
  }
});

test('fetchMedia: 只有音频轨时报清楚的错，不把 m4a 改名成 video.mp4', async () => {
  const h = await makeHarness();
  const prev = process.env.FAKE_EXT;
  process.env.FAKE_EXT = 'm4a';
  try {
    await assert.rejects(
      () => fetchMedia('https://www.bilibili.com/video/BV1audio', {
        ytdlp: h.ytdlp, env: h.env, cookies: h.cookies, scanHeight: 360,
      }),
      /audio only.*video\.m4a/s,
    );
    // 缓存目录里不能留下一个假的 video.mp4
    const left = await readdir(h.media, { recursive: true }).catch(() => []);
    assert.equal(left.some((n) => String(n).endsWith('video.mp4')), false);
  } finally {
    if (prev === undefined) delete process.env.FAKE_EXT; else process.env.FAKE_EXT = prev;
    await h.cleanup();
  }
});

test('fetchMedia: 源最高只有 720 时，标 source-max-720p 而不是假装成功', async () => {
  const h = await makeHarness();
  try {
    const fake720 = join(h.root, 'fake720.mjs');
    await writeFile(fake720, FAKE_SOURCE.replace(
      /\{ vcodec: 'avc1', height: 1080[^}]*\},?\s*/,
      '',
    ), 'utf8');
    const { source } = await fetchMedia('https://example.com/v', {
      ytdlp: { bin: process.execPath, prefix: [fake720] }, env: h.env, cookies: h.cookies, zoomHeight: 1080,
    });
    assert.equal(source.maxAvailable, 720);
    assert.equal(source.zoomTarget, 720);
    assert.deepEqual(source.degraded, ['source-max-720p']);
  } finally {
    await h.cleanup();
  }
});

test('fetchMedia: yt-dlp 失败时清理半成品目录，不留空壳', async () => {
  const h = await makeHarness();
  try {
    const failing = join(h.root, 'fail.mjs');
    await writeFile(failing, FAKE_SOURCE, 'utf8');
    const prev = process.env.FAKE_FAIL;
    process.env.FAKE_FAIL = '1';
    try {
      await assert.rejects(
        () => fetchMedia('https://example.com/v', {
          ytdlp: { bin: process.execPath, prefix: [failing] }, env: h.env, cookies: h.cookies,
        }),
        /SESSDATA may also have expired/,
      );
    } finally {
      if (prev === undefined) delete process.env.FAKE_FAIL; else process.env.FAKE_FAIL = prev;
    }
    const left = await readdir(h.media).catch(() => []);
    assert.deepEqual(left, [], '失败后不该留下半个视频目录');
  } finally {
    await h.cleanup();
  }
});

test('fetchMedia: 非 http 链接直接拒绝', async () => {
  await assert.rejects(() => fetchMedia('D:/a.mp4', {}), /only http\(s\) links/);
});

/* ---------------------------------------------------------------- 直链 */

test('resolveDirectUrl: 只要画面、按上限取最高档、解析 deadline', async () => {
  const h = await makeHarness();
  try {
    const direct = await resolveDirectUrl('https://example.com/v', {
      ytdlp: h.ytdlp, env: h.env, cookies: h.cookies, height: 1080,
    });
    assert.equal(direct.url, 'https://cdn/v1080.mp4?deadline=1793121239');
    assert.equal(direct.height, 1080);
    assert.equal(direct.expiresAt, 1793121239 * 1000);
    assert.ok(direct.userAgent.includes('Mozilla'), '不带 UA 会被 CDN 403');
  } finally {
    await h.cleanup();
  }
});

test('resolveDirectUrl: 上限 720 时不会越级拿 1080', async () => {
  const h = await makeHarness();
  try {
    const direct = await resolveDirectUrl('https://example.com/v', {
      ytdlp: h.ytdlp, env: h.env, cookies: h.cookies, height: 720,
    });
    assert.equal(direct.height, 720);
    assert.equal(direct.url, 'https://cdn/v720.mp4');
  } finally {
    await h.cleanup();
  }
});

/* ---------------------------------------------------------------- 缓存淘汰 */

test('pruneMedia: 超限时按 mtime 从旧删，且整个目录一起删', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-prune-'));
  try {
    const dir = join(root, 'media');
    const old = join(dir, 'old');
    const fresh = join(dir, 'fresh');
    await mkdir(old, { recursive: true });
    await mkdir(fresh, { recursive: true });
    await writeFile(join(old, 'video.mp4'), Buffer.alloc(1024, 1));
    await writeFile(join(old, 'extra.bin'), Buffer.alloc(1024, 1));
    await writeFile(join(fresh, 'video.mp4'), Buffer.alloc(1024, 2));

    const past = new Date(Date.now() - 86_400_000);
    await utimes(join(old, 'video.mp4'), past, past);
    await utimes(join(old, 'extra.bin'), past, past);

    // 上限 1.5KB：两个目录共 3KB，必须删掉最旧的那个
    const result = await pruneMedia({ dir, maxBytes: 1536 });
    assert.equal(result.removed, 1);
    const left = await readdir(dir);
    assert.deepEqual(left, ['fresh'], '旧目录应被整个删掉，不能只删里面的文件');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('pruneMedia: 上限够用时一个都不删', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-prune2-'));
  try {
    const dir = join(root, 'media');
    await mkdir(join(dir, 'a'), { recursive: true });
    await writeFile(join(dir, 'a', 'video.mp4'), Buffer.alloc(100, 1));
    const result = await pruneMedia({ dir, maxBytes: 1024 * 1024 });
    assert.equal(result.removed, 0);
    assert.deepEqual(await readdir(dir), ['a']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/* ---------------------------------------------------------------- 发现 */

test('discoverYtdlp: 全都没有时抛带安装指引的错', async () => {
  await assert.rejects(
    () => discoverYtdlp({ env: { PATH: join(tmpdir(), 'definitely-empty-dir') }, run: async () => { throw new Error('nope'); } }),
    (error) => {
      assert.equal(error.code, 'YTDLP_MISSING');
      assert.match(error.message, /pip install --user -U yt-dlp/);
      return true;
    },
  );
});

test('discoverYtdlp: 文件存在但跑不起来不算找到（警惕残缺安装）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-disc-'));
  try {
    const bin = join(dir, 'yt-dlp');
    await writeFile(bin, 'not really an executable', 'utf8');
    await assert.rejects(
      () => discoverYtdlp({ env: { DSH_YTDLP_PATH: bin, PATH: dir }, run: async () => { throw new Error('bad'); } }),
      /yt-dlp not found/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('fetchMedia: 匿名但源本来就有 1080p 时，不产生任何告警（DSH 踩过的假警报）', async () => {
  const h = await makeHarness();
  try {
    const { source } = await fetchMedia('https://www.bilibili.com/video/BV1xx', {
      ytdlp: h.ytdlp, env: h.env,           // 故意不给 cookies
    });
    assert.equal(source.auth, 'anonymous');
    assert.equal(source.maxAvailable, 1080);
    assert.equal(source.authWarning, undefined, '匿名够高清就一个字都不该多说');
    assert.equal(source.degraded, undefined);
  } finally {
    await h.cleanup();
  }
});

test('fetchMedia: 匿名且源只到 360p 时，既标 degraded 也说明是匿名所致', async () => {
  const h = await makeHarness();
  try {
    const fakeLow = join(h.root, 'fake-low.mjs');
    await writeFile(fakeLow, FAKE_SOURCE.replace(
      /\{ vcodec: 'avc1', height: (720|1080)[^}]*\},?\s*/g,
      '',
    ), 'utf8');
    const { source } = await fetchMedia('https://example.com/v', {
      ytdlp: { bin: process.execPath, prefix: [fakeLow] }, env: h.env,
    });
    assert.equal(source.maxAvailable, 360);
    assert.deepEqual(source.degraded, ['source-max-360p']);
    assert.match(source.authWarning, /anonymous/);
  } finally {
    await h.cleanup();
  }
});

test('pickVideoFormat: 竖屏按短边选，不会被 height 卡掉 1080x1920', () => {
  // issue #9：竖屏的 height 是长边，用 height<=1080 会把 1080x1920 排除、退到 480x852
  const formats = [
    { vcodec: 'h264', width: 360, height: 640, tbr: 500 },
    { vcodec: 'h264', width: 480, height: 852, tbr: 800 },
    { vcodec: 'h264', width: 720, height: 1280, tbr: 1800 },
    { vcodec: 'h264', width: 1080, height: 1920, tbr: 4000 },
  ];
  assert.equal(pickVideoFormat(formats, 1080).width, 1080, '应选到 1080x1920');
  assert.equal(pickVideoFormat(formats, 480).width, 480);
});

test('explainYtdlpError: 567 要说清是 B 站风控，并给出两条出路', () => {
  const msg = explainYtdlpError('ERROR: unable to download video data: HTTP Error 567: ');
  assert.match(msg, /risk control/, '必须说清这不是插件的锅');
  assert.match(msg, /cookies/i, '给 cookies 这条路');
  assert.match(msg, /local path/i, '给本地文件这条路');
});

test('explainYtdlpError: 412 是限流，不是登录问题', () => {
  const msg = explainYtdlpError('ERROR: HTTP Error 412: Precondition Failed');
  assert.match(msg, /rate-limited/);
  assert.doesNotMatch(msg, /567/);
});
