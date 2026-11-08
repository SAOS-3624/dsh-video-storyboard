/**
 * settings/server.js — 插件自己的本机设置页与 API。
 *
 * 页面本体仍是独立 HTML，供工具返回的 URL 直接打开；DSH 里的设置页由
 * lib/client.js 用原生 React 表单渲染，直接调用同一套 API，不再套 iframe。
 *
 * 安全边界：
 *  - 只有本机 webServer 存在时才注册；
 *  - 页面 URL 带 32 字节随机 token，API 同时校验 header；
 *  - API 只接受 JSON、限制 body 大小、不返回 key；
 *  - 不做“一键安装”，避免把任意命令执行暴露给浏览器。
 */

import { checkEnvironment } from './deps.js';
import { configPaths, readAsrSettings, readVideoSettings, writeAsrSettings, writeVideoSettings } from './config.js';
import { settingsPage } from './page.js';
import { settingsToken } from './token.js';

const PAGE_PATH = '/dsh-video-storyboard/settings';
const API_PREFIX = PAGE_PATH + '/api';
const MAX_BODY = 64 * 1024;
const INDEX_GLOBAL = '__DSH_VIDEO_STORYBOARD_SETTINGS__';

export const SETTINGS_TOOL_NAME = 'video_storyboard_settings';

/**
 * 设置页工具的**契约部分**（name / description / parameters / output）。
 *
 * 单独抽出来只为一件事：它是**第六个**工具，schema 同样每轮重发。
 * `test/manifest.test.mjs` 的体积守门要能称到它 —— 建工具对象需要 webServer，
 * 测试里造不出来；契约在这里就可以直接 `JSON.stringify`。
 */
export function settingsToolSpec() {
  return {
    name: SETTINGS_TOOL_NAME,
    // 描述只说"能干什么、回什么"。**别写 GUI 里还有一份同样的设置页** ——
    // 那是给人看的，模型每轮要为这句话付一次钱。
    description: 'Open the local settings page (ASR on/off, API key, endpoint/model/language, '
      + 'browser port, read-only dependency check). Returns a tokenized local URL; '
      + 'secrets are never returned.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', required: true },
          available: { type: 'boolean', required: true },
          text: { type: 'string', required: true },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: value.text }];
      },
    },
  };
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sameToken(actual, expected) {
  if (typeof actual !== 'string' || actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体太大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

function statePayload(ctx, env) {
  return {
    asr: readAsrSettings(env),
    video: readVideoSettings(env),
    paths: configPaths(env),
  };
}

/**
 * @param {{ ctx: object, env?: NodeJS.ProcessEnv, log?: Function }} options
 * @returns {null | { url: string, tool: object, dispose: () => void }}
 */
export function createSettingsPage({ ctx, env = process.env, log = () => {} } = {}) {
  const webServer = ctx?.get?.('webServer');
  if (!webServer || typeof webServer.register !== 'function') return null;
  const token = settingsToken(env);
  let disposed = false;

  const handle = async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (url.pathname === PAGE_PATH) {
        if (!sameToken(url.searchParams.get('token'), token)) return json(res, 403, { error: 'token 无效' });
        const html = settingsPage();
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'",
        });
        res.end(html);
        return;
      }
      if (!url.pathname.startsWith(API_PREFIX + '/')) return json(res, 404, { error: 'not found' });
      if (!sameToken(req.headers['x-settings-token'], token)) return json(res, 401, { error: 'token 无效' });

      const action = url.pathname.slice(API_PREFIX.length);
      if (req.method === 'GET' && action === '/state') {
        return json(res, 200, statePayload(ctx, env));
      }
      if (req.method === 'POST' && action === '/save') {
        const body = await readBody(req);
        if (!body || typeof body !== 'object') throw new Error('请求体必须是对象');
        if (body.asr !== undefined) writeAsrSettings(body.asr, env);
        if (body.video !== undefined) writeVideoSettings(body.video, env);
        return json(res, 200, statePayload(ctx, env));
      }
      if (req.method === 'POST' && action === '/check') {
        return json(res, 200, { checks: await checkEnvironment(ctx, env) });
      }
      return json(res, 404, { error: 'not found' });
    } catch (e) {
      const message = String(e?.message ?? e).slice(0, 300);
      if (!res.headersSent) json(res, 400, { error: message });
      else res.end();
    }
  };

  let routeDispose = null;
  try {
    routeDispose = webServer.register({ kind: 'prefix', path: PAGE_PATH, handler: handle });
  } catch (e) {
    // 路由被占或 webServer 正在关闭时不拖垮插件；工具会给出 null。
    log('[dsh-video-storyboard] settings page unavailable: ' + String(e?.message ?? e));
    return null;
  }

  const origin = webServer.getOrigin?.() || ('http://127.0.0.1:' + webServer.port);
  const url = origin + PAGE_PATH + '?token=' + token;

  // The DSH settings tab runs in the same browser origin; hand it the tokenized
  // URL through the boot injection table instead of adding a second API.
  let offIndex = null;
  if (typeof ctx.on === 'function') {
    try {
      offIndex = ctx.on('webserver/index-inject', (table) => {
        table.push({ kind: 'global', name: INDEX_GLOBAL, value: { url } });
      });
    } catch (e) {
      log('[dsh-video-storyboard] settings index injection unavailable: ' + String(e?.message ?? e));
    }
  }

  const tool = {
    ...settingsToolSpec(),
    timeoutMs: 10_000,
    isConcurrencySafe() { return true; },
    async execute() {
      if (disposed) throw new Error('settings page is no longer available');
      return {
        url,
        available: true,
        text: [
          '视频分镜设置页：',
          url,
          '在浏览器打开；页面里的 API 用这个 URL 的 token 校验，不要把它发给别人。',
          '设置保存到 asr.json / video.json，下一次工具调用生效。',
        ].join('\n'),
      };
    },
  };

  return {
    url,
    tool,
    dispose() {
      if (disposed) return;
      disposed = true;
      try { offIndex?.(); } catch { /* ignore */ }
      try { routeDispose?.(); } catch { /* ignore */ }
    },
  };
}
