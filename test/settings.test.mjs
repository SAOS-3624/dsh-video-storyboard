import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { canTranscribe } from '../src/storyboard/asr.js';
import {
  readAsrSettings, readVideoSettings, writeAsrSettings, writeVideoSettings,
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
});

function fakeWeb() {
  let handler = null;
  const webServer = {
    port: 3080,
    register(route) { handler = route.handler; return () => { handler = null; }; },
    getOrigin() { return 'http://127.0.0.1:3080'; },
  };
  return { webServer, handler: () => handler };
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
  const page = createSettingsPage({ ctx: { get: () => web.webServer }, env });
  assert.ok(page, '有 webServer 时应注册');
  const token = new URL(page.url).searchParams.get('token');
  assert.match(page.url, /^http:\/\/127\.0\.0\.1:3080\/dsh-video-storyboard\/settings\?token=/);

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
    body: JSON.stringify({ asr: { enabled: true, baseUrl: 'http://127.0.0.1:9999/v1', key: 'secret' }, video: { browserPort: 9333 } }),
  });
  assert.equal(saved.status, 200);
  const state = JSON.parse(saved.body);
  assert.equal(state.asr.hasKey, true);
  assert.equal(JSON.stringify(state).includes('secret'), false, '响应里不能出现 key 明文');
  assert.equal(readFileSync(join(dir, 'asr.json'), 'utf8').includes('secret'), true);
  assert.equal(existsSync(join(dir, 'video.json')), true);
  assert.equal(page.tool.name, 'video_storyboard_settings');
  const result = await page.tool.execute();
  assert.equal(result.available, true);
  assert.equal(result.url, page.url);
});

test('settings server: 没有 webServer 时返回 null', () => {
  assert.equal(createSettingsPage({ ctx: { get: () => undefined }, env: { DSH_HOME: home() } }), null);
});
