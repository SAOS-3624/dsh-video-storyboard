import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { runInNewContext } from 'node:vm';

import { canTranscribe } from '../src/storyboard/asr.js';
import {
  lnnModelStatus, readAsrSettings, readVideoSettings, writeAsrSettings, writeVideoSettings,
} from '../src/settings/config.js';
import { createSettingsPage } from '../src/settings/server.js';

const home = () => mkdtempSync(join(tmpdir(), 'storyboard-settings-'));
const envOf = (dir) => ({ DSH_HOME: dir });

test('settings: ASR 写入、key 不回显、关闭后 canTranscribe 为 false', () => {
  const dir = home();
  const env = envOf(dir);
  const saved = writeAsrSettings({
    enabled: false,
    baseUrl: 'http://127.0.0.1:9999/v1',
    model: 'local-model',
    language: 'ja',
    key: 'secret-key',
  }, env);
  assert.equal(saved.enabled, false);
  assert.equal(saved.baseUrl, 'http://127.0.0.1:9999/v1');
  assert.equal(saved.hasKey, true);
  assert.equal(readAsrSettings({ ...env, DSH_ASR_ENABLED: '0' }).enabled, false, '环境变量关闭也要反映到页面');
  assert.equal(Object.hasOwn(saved, 'key'), false, 'API 状态不能带 key');
  const raw = JSON.parse(readFileSync(join(dir, 'asr.json'), 'utf8'));
  assert.equal(raw.key, 'secret-key');
  assert.equal(canTranscribe({ enabled: false, baseUrl: 'http://127.0.0.1:9999/v1', keyEnv: 'NOPE' }), false);
  assert.equal(canTranscribe({ enabled: true, baseUrl: 'http://127.0.0.1:9999/v1', keyEnv: 'NOPE' }), true);

  const cleared = writeAsrSettings({ clearKey: true }, env);
  assert.equal(cleared.hasKey, false);
  assert.equal(JSON.parse(readFileSync(join(dir, 'asr.json'), 'utf8')).key, undefined);
});

test('settings: 空 baseUrl 清回默认，非法 URL 拒绝写入', () => {
  const dir = home();
  const env = envOf(dir);
  writeAsrSettings({ baseUrl: 'https://example.com/v1' }, env);
  const blank = writeAsrSettings({ baseUrl: '' }, env);
  assert.equal(blank.baseUrl, '');
  assert.throws(() => writeAsrSettings({ baseUrl: 'ftp://example.com' }, env), /http\/https/);
  assert.throws(() => writeAsrSettings({ baseUrl: 'not a url' }, env), /合法 URL/);
});

test('settings: video.json 端口与 launchBrowser 合并写入', () => {
  const dir = home();
  const env = envOf(dir);
  writeFileSync(join(dir, 'video.json'), JSON.stringify({ custom: true }));
  const saved = writeVideoSettings({ browserPort: 9333, launchBrowser: true }, env);
  assert.equal(saved.browserPort, 9333);
  assert.equal(saved.launchBrowser, true);
  const raw = JSON.parse(readFileSync(join(dir, 'video.json'), 'utf8'));
  assert.equal(raw.custom, true, '未知字段必须保留');
  assert.equal(raw.browserPort, 9333);
  const off = writeVideoSettings({ browserPort: false }, env);
  assert.equal(off.browserPort, null);
  assert.throws(() => writeVideoSettings({ browserPort: 70000 }, env), /65535/);

  const full = writeVideoSettings({
    cookies: '  C:\\Users\\me\\.dsh\\cookies.txt  ',
    storyboardAuto: false,
  }, env);
  assert.equal(full.cookies, 'C:\\Users\\me\\.dsh\\cookies.txt');
  assert.equal(full.storyboardAuto, false);
  const raw2 = JSON.parse(readFileSync(join(dir, 'video.json'), 'utf8'));
  assert.equal(raw2.custom, true);
  assert.equal(raw2.storyboard.auto, false);
  assert.equal(writeVideoSettings({ storyboardAuto: true }, env).storyboardAuto, true);
  assert.throws(() => writeVideoSettings({ cookies: 42 }, env), /cookies 必须是字符串/);

  // cutFloor：与 storyboardAuto 共用一个 storyboard 对象，**互不覆盖**（这是最容易写错的地方）
  assert.equal(writeVideoSettings({ cutFloor: 60 }, env).cutFloor, 60);
  const withBoth = JSON.parse(readFileSync(join(dir, 'video.json'), 'utf8'));
  assert.equal(withBoth.storyboard.cutFloor, 60);
  assert.equal(withBoth.storyboard.auto, true, '设置 cutFloor 不能把 auto 冲掉');
  assert.equal(writeVideoSettings({ storyboardAuto: false }, env).cutFloor, 60,
    '设置 auto 也不能把 cutFloor 冲掉');
  assert.equal(readVideoSettings(env).cutFloor, 60);
  // 越界要报错；传 0 / 空串表示"清掉，恢复内核默认"
  assert.throws(() => writeVideoSettings({ cutFloor: 256 }, env), /1-255/);
  assert.throws(() => writeVideoSettings({ cutFloor: 12.5 }, env), /1-255/);
  assert.equal(writeVideoSettings({ cutFloor: 0 }, env).cutFloor, null);
  assert.equal(readVideoSettings(env).storyboardAuto, false, '清 cutFloor 不能顺带把 auto 重置');

  // tierMap：非整数键/值必须直接拒绝，不能把 NaN 写进文件（issue #83）
  assert.throws(() => writeVideoSettings({ tierMap: { foo: 1 } }, env), /tierMap 的档位必须是 1-8 的整数/);
  assert.throws(() => writeVideoSettings({ tierMap: { 1: 'bar' } }, env), /tierMap 的目标档位必须是 1-8 的整数/);
  assert.deepEqual(writeVideoSettings({ tierMap: { 1: 3, 5: 4 } }, env).tierMap, { 1: 3, 5: 4 });

  const overridden = readVideoSettings({
    ...env,
    DSH_VIDEO_COOKIES: 'D:/env/cookies.txt',
    DSH_STORYBOARD_AUTO: '0',
  });
  assert.deepEqual(overridden.envOverrides, ['DSH_VIDEO_COOKIES', 'DSH_STORYBOARD_AUTO']);
});

function fakeWeb() {
  let handler = null;
  let inject = null;
  const webServer = {
    port: 3080,
    register(route) { handler = route.handler; return () => { handler = null; }; },
    getOrigin() { return 'http://127.0.0.1:3080'; },
  };
  const ctx = {
    get: () => webServer,
    on(event, callback) {
      if (event === 'webserver/index-inject') inject = callback;
      return () => { inject = null; };
    },
  };
  return {
    webServer,
    ctx,
    handler: () => handler,
    injections() { const table = []; inject?.(table); return table; },
  };
}

function response() {
  const out = { status: 0, headers: {}, body: '' };
  return {
    out,
    headersSent: false,
    writeHead(status, headers) { out.status = status; out.headers = headers || {}; this.headersSent = true; },
    end(body = '') { out.body = String(body); },
  };
}

async function invoke(handler, { method = 'GET', url = '/', headers = {}, body } = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
  req.method = method;
  req.url = url;
  req.headers = headers;
  const res = response();
  await handler(req, res);
  return res.out;
}

test('settings server: 页面 token、API token、保存后不回显 key', async () => {
  const dir = home();
  const env = envOf(dir);
  const web = fakeWeb();
  const page = createSettingsPage({ ctx: web.ctx, env });
  assert.ok(page, '有 webServer 时应注册');
  const token = new URL(page.url).searchParams.get('token');
  assert.match(page.url, /^http:\/\/127\.0\.0\.1:3080\/dsh-video-storyboard\/settings\?token=/);
  const table = web.injections();
  assert.equal(table[0].name, '__DSH_VIDEO_STORYBOARD_SETTINGS__');
  assert.equal(table[0].value.url, page.url, '设置 tab 必须拿到同一个带 token 的 URL');

  const forbidden = await invoke(web.handler(), { url: '/dsh-video-storyboard/settings?token=wrong' });
  assert.equal(forbidden.status, 403);
  const html = await invoke(web.handler(), { url: '/dsh-video-storyboard/settings?token=' + token });
  assert.equal(html.status, 200);
  assert.match(html.body, /视频分镜 · 设置/);

  const api = (action, options = {}) => invoke(web.handler(), {
    ...options,
    url: '/dsh-video-storyboard/settings/api' + action,
    headers: { 'x-settings-token': token, ...(options.headers || {}) },
  });
  const unauth = await api('/state', { headers: { 'x-settings-token': 'nope' } });
  assert.equal(unauth.status, 401);

  const saved = await api('/save', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      asr: { enabled: true, baseUrl: 'http://127.0.0.1:9999/v1', key: 'secret' },
      video: { browserPort: 9333, cookies: 'C:\\tmp\\cookies.txt', storyboardAuto: false },
    }),
  });
  assert.equal(saved.status, 200);
  const state = JSON.parse(saved.body);
  assert.equal(state.asr.hasKey, true);
  assert.equal(JSON.stringify(state).includes('secret'), false, '响应里不能出现 key 明文');
  assert.equal(readFileSync(join(dir, 'asr.json'), 'utf8').includes('secret'), true);
  assert.equal(existsSync(join(dir, 'video.json')), true);
  assert.equal(state.video.cookies, 'C:\\tmp\\cookies.txt');
  assert.equal(state.video.storyboardAuto, false);
  const checked = await api('/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(checked.status, 200);
  const checks = JSON.parse(checked.body).checks;
  for (const id of ['ffmpeg', 'ytdlp', 'python']) {
    const row = checks.find((c) => c.id === id);
    assert.match(row.downloadUrl, /^https:\/\//, id + ' 需要官方下载地址');
  }
  assert.equal(page.tool.name, 'video_storyboard_settings');
  const result = await page.tool.execute();
  assert.equal(result.available, true);
  assert.equal(result.url, page.url);
});

test('settings: client bundle 只在组合包页面注册，不占用设置 tab', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.dsh.client.platform, 'web');
  assert.equal(pkg.exports['./client'], './lib/client.js');
  let handoff = null;
  const clientSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  assert.equal(clientSource.includes('iframe'), false, '设置页必须是原生表单，不能套 iframe');
  const sandbox = { window: { __ModuleLoader__: { load: (h) => { handoff = h; } } }, globalThis: {}, console };
  runInNewContext(clientSource, sandbox);
  const mod = handoff.factory(() => ({ createElement: () => ({}) }));
  const registered = [];
  mod.apply({ slots: { inject(_name, callback) { callback(); }, register(options, component) { registered.push({ options, component }); } } });
  assert.equal(registered.some((entry) => entry.options.name === 'settings.plugins.tab'), false);
  const bundle = registered.find((entry) => entry.options.name === 'plugins.bundle.config');
  assert.equal(bundle.options.key, 'dsh-video-storyboard');
  assert.equal(bundle.component({ view: 'summary' }), null);
});

test('settings server: 没有 webServer 时返回 null', () => {
  assert.equal(createSettingsPage({ ctx: { get: () => undefined }, env: { DSH_HOME: home() } }), null);
});

// ---------------------------------------------------------------- 取帧算法（hsv / lnn）

/**
 * 设置页上那一个下拉。三件事必须钉住：
 *   ① 默认 `lnn`，而且写 `lnn` **删键**（文件里不留冗余默认值）；写 `hsv` 才落盘；
 *   ② 对外只说 `lnn`，老名字 `liquid` 收到也当 lnn（删键）；
 *   ③ 内置模型能不能用要能报出来 —— 否则用户选了 lnn、实际退回 hsv，界面上看着"已开启"。
 */
test('取帧算法：lnn 是默认值，写 lnn 等于删键；写 hsv 才落盘', () => {
  const dir = home();
  const env = envOf(dir);
  assert.equal(readVideoSettings(env).sceneDetector, 'lnn', '没配就是 lnn');
  // 写默认值 → 键消失（不是写一个 "lnn" 进去）
  assert.equal(writeVideoSettings({ sceneDetector: 'lnn' }, env).sceneDetector, 'lnn');
  assert.equal('sceneDetector' in JSON.parse(readFileSync(join(dir, 'video.json'), 'utf8')), false);
  // 写 hsv → 必须落盘（那是从默认退回去的选项，读不回来就等于没生效）
  assert.equal(writeVideoSettings({ sceneDetector: 'hsv' }, env).sceneDetector, 'hsv');
  assert.equal(JSON.parse(readFileSync(join(dir, 'video.json'), 'utf8')).sceneDetector, 'hsv');
});

test('取帧算法：老名字 liquid 当 lnn 处理；认不出来的值要报错', () => {
  const dir = home();
  const env = envOf(dir);
  assert.equal(writeVideoSettings({ sceneDetector: 'hsv' }, env).sceneDetector, 'hsv');
  assert.equal(writeVideoSettings({ sceneDetector: 'liquid' }, env).sceneDetector, 'lnn');
  assert.equal('sceneDetector' in JSON.parse(readFileSync(join(dir, 'video.json'), 'utf8')), false,
    'liquid 等于 lnn，等于默认，所以删键');
  assert.throws(() => writeVideoSettings({ sceneDetector: 'canny' }, env), /只能是 lnn 或 hsv/);
});

test('取帧算法：内置 LNN 模型必须可用（版本对得上、有 cut 头）', () => {
  const s = lnnModelStatus();
  assert.equal(s.ready, true, `内置模型不可用：${s.reason}`);
  assert.ok(s.path.endsWith('lnn-model.json'), s.path);
  // 设置页要能读到这个状态
  assert.equal(readVideoSettings(envOf(home())).lnnModel.ready, true);
});

// ---------------------------------------------------------------- 自动保存的依赖数组

/**
 * issue #97：档位策略/自定义映射表改完不保存 —— 改完只动本地 state，
 * 自动保存的 `useEffect` 依赖数组里没有这两个字段 → effect 不重跑 → `save()` 不被调用
 * → `video.json` 根本没写盘。
 *
 * 这里钉一条结构性不变量：**`save()` 读到的每个表单字段，都必须在依赖数组里出现**。
 * 以前是手抄清单，加了字段忘了加依赖就会静默丢掉那个字段的保存。
 */
test('设置页：自动保存的依赖数组覆盖 save() 提交的每个字段（#97）', () => {
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  const saveAt = src.indexOf('async function save()');
  assert.ok(saveAt > 0, '找不到 save()');
  const saveBody = src.slice(saveAt, src.indexOf('useEffect(', saveAt));
  const submitted = new Set(
    [...saveBody.matchAll(/\bcurrent\.([A-Za-z0-9_]+)/g)].map((m) => m[1]),
  );
  // key / clearKey 走 ref 提交（不在 form 里），不参与自动保存
  const viaRef = new Set(['key', 'clearKey']);
  const want = [...submitted].filter((f) => !viaRef.has(f));
  assert.ok(want.includes('strategy') && want.includes('tierMap'), 'save() 应该提交 strategy / tierMap');

  const effectAt = src.indexOf('void save(); }, 600);');
  assert.ok(effectAt > 0, '找不到自动保存的 useEffect');
  const depsText = src.slice(effectAt, src.indexOf(']);', effectAt));
  const deps = new Set(
    [...depsText.matchAll(/form\s*&&\s*form\.([A-Za-z0-9_]+)/g)].map((m) => m[1]),
  );
  for (const field of want) {
    assert.ok(deps.has(field), `save() 提交了 ${field}，但依赖数组里没有 form.${field} —— 改它不会触发保存`);
  }
  // tierMap 是对象，必须比序列化值，否则每次渲染都是新引用 → 无限自动保存
  assert.match(depsText, /JSON\.stringify\(form\.tierMap\)/, 'tierMap 要用 JSON.stringify 当依赖');
});
