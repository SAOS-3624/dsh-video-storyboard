/**
 * settings/config.js — 设置页读写的那几个 JSON 文件。
 *
 * 这里刻意不碰 ASR 的运行逻辑：asr.json 本来就会被 asr.js 按 mtime 热读，
 * video.json 也已经被 browser-time.js 读取。设置页只负责“把用户填的值安全地写进去”。
 *
 * key 只写不读：GET 永远不返回明文，POST 里空字符串表示“保持原值”。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveAsrConfig } from '../storyboard/asr.js';

const MAX_TEXT = 200;

/** $DSH_HOME 或 ~/.dsh（与 asr.js 的约定一致） */
export function dshHome(env = process.env) {
  return env.DSH_HOME || join(env.USERPROFILE || env.HOME || homedir(), '.dsh');
}

export function asrConfigPath(env = process.env) {
  return join(dshHome(env), 'asr.json');
}

export function videoConfigPath(env = process.env) {
  return join(dshHome(env), 'video.json');
}

/** 读一个 JSON 对象；坏文件返回 {} 并留下人话错误。 */
function readObject(path) {
  if (!existsSync(path)) return { data: {}, error: null, exists: false };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { data: {}, error: '配置文件不是 JSON 对象', exists: true };
    }
    return { data: raw, error: null, exists: true };
  } catch (e) {
    return { data: {}, error: `JSON 解析失败：${e?.message ?? e}`, exists: true };
  }
}

/** 原子写；父目录不存在就建。0o600 在 Windows 上不保证 ACL，但至少不是可执行位。 */
function writeObject(path, data) {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    // 用 mode 0o600；Windows 会忽略一部分位，但不会把文件变成可执行。
    writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, path);
  } finally {
    if (existsSync(tmp)) rmSync(tmp, { force: true });
  }
}

function text(value, field) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`${field} 必须是字符串`);
  const v = value.trim();
  if (v.length > MAX_TEXT) throw new Error(`${field} 太长（最多 ${MAX_TEXT} 字）`);
  return v;
}

function bool(value, field) {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`${field} 必须是布尔值`);
  return value;
}

function validBaseUrl(value) {
  if (!value) return '';
  let u;
  try { u = new URL(value); } catch { throw new Error('baseUrl 不是合法 URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('baseUrl 只支持 http/https');
  return value.replace(/\/+$/, '');
}

/** 设置页需要的 ASR 状态；绝不返回 key 明文。 */
export function readAsrSettings(env = process.env) {
  const path = asrConfigPath(env);
  const raw = readObject(path);
  const effective = resolveAsrConfig(env);
  const envKey = Boolean(env.DSH_ASR_KEY);
  return {
    path,
    exists: raw.exists,
    error: raw.error,
    enabled: effective.enabled !== false,
    baseUrl: typeof raw.data.baseUrl === 'string' ? raw.data.baseUrl : '',
    model: typeof raw.data.model === 'string' ? raw.data.model : '',
    language: typeof raw.data.language === 'string' ? raw.data.language : '',
    hasKey: Boolean(raw.data.key),
    keyFromEnv: envKey,
    effective: {
      enabled: effective.enabled !== false,
      baseUrl: effective.baseUrl,
      model: effective.model,
      language: effective.language,
      source: effective.source,
    },
    envOverrides: ['DSH_ASR_BASE_URL', 'DSH_ASR_MODEL', 'DSH_ASR_LANG', 'DSH_ASR_KEY', 'DSH_ASR_ENABLED']
      .filter((k) => env[k] !== undefined && env[k] !== ''),
  };
}

/** 写入设置页字段；未知字段原样保留。 */
export function writeAsrSettings(patch = {}, env = process.env) {
  const path = asrConfigPath(env);
  const { data } = readObject(path);
  const next = { ...data };
  const enabled = bool(patch.enabled, 'enabled');
  const baseUrl = text(patch.baseUrl, 'baseUrl');
  const model = text(patch.model, 'model');
  const language = text(patch.language, 'language');
  if (enabled !== undefined) next.enabled = enabled;
  if (baseUrl !== undefined) next.baseUrl = validBaseUrl(baseUrl);
  if (model !== undefined) next.model = model;
  if (language !== undefined) next.language = language;
  if (patch.clearKey === true) delete next.key;
  else if (typeof patch.key === 'string' && patch.key.trim()) next.key = patch.key.trim();
  writeObject(path, next);
  return readAsrSettings(env);
}

export function readVideoSettings(env = process.env) {
  const path = videoConfigPath(env);
  const raw = readObject(path);
  const p = Number(raw.data.browserPort);
  const storyboard = raw.data.storyboard;
  return {
    path,
    exists: raw.exists,
    error: raw.error,
    browserPort: Number.isFinite(p) && p > 0 ? p : null,
    launchBrowser: raw.data.launchBrowser === true,
    cookies: typeof raw.data.cookies === 'string' ? raw.data.cookies : '',
    storyboardAuto: !(storyboard && typeof storyboard === 'object' && storyboard.auto === false),
    // 全局默认切点门槛；null = 没设，走内核默认（mc:80）
    cutFloor: (() => {
      const n = Number(storyboard && typeof storyboard === 'object' ? storyboard.cutFloor : NaN);
      return Number.isInteger(n) && n >= 1 && n <= 255 ? n : null;
    })(),
    /** 默认档位策略；null = 没设，走内核默认（自动选档或 compact）。 */
    strategy: (() => {
      const v = storyboard && typeof storyboard === 'object' ? String(storyboard.strategy ?? '').trim() : '';
      return v || null;
    })(),
    /**
     * 逐档映射：`{ 1: 3, 5: 4 }` 这种**只写非恒等项**的对象。
     *
     * 恒等（`3: 3`）不写进文件 —— 写了也没用，只是让用户下次打开看不懂自己上次改了什么。
     */
    tierMap: (() => {
      const m = storyboard && typeof storyboard === 'object' ? storyboard.tierMap : null;
      if (!m || typeof m !== 'object' || Array.isArray(m)) return {};
      const out = {};
      for (const [k, v] of Object.entries(m)) {
        const from = Number(k);
        const to = Number(v);
        if (Number.isInteger(from) && from >= 1 && from <= 8
          && Number.isInteger(to) && to >= 1 && to <= 8 && from !== to) {
          out[from] = to;
        }
      }
      return out;
    })(),
    /**
     * 会话里最多留多少张图 / 多少 MB（`image/offload` 的两个上限）。
     * null = 没设，走插件默认（200 张 / 300 MB）；0 = 这一维不限。
     * 这是**省完之后停在哪**，不是"一到就省"—— 实际会涨到 1.5 倍才动手（见 src/index.js）。
     */
    imageTrigger: (() => {
      const n = Number(raw.data.imageTrigger);
      return Number.isInteger(n) && n >= 0 && n <= 2000 ? n : null;
    })(),
    imageKeep: (() => {
      const n = Number(raw.data.imageKeep);
      return Number.isInteger(n) && n >= 0 && n <= 2000 ? n : null;
    })(),
    envOverrides: ['DSH_VIDEO_COOKIES', 'DSH_STORYBOARD_AUTO']
      .filter((k) => env[k] !== undefined && env[k] !== ''),
  };
}

export function writeVideoSettings(patch = {}, env = process.env) {
  const path = videoConfigPath(env);
  const { data } = readObject(path);
  const next = { ...data };
  if (patch.browserPort !== undefined) {
    if (patch.browserPort === false || patch.browserPort === 0 || patch.browserPort === null || patch.browserPort === '') {
      next.browserPort = false;
    } else {
      const port = Number(patch.browserPort);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('browserPort 必须是 1-65535 的整数');
      next.browserPort = port;
    }
  }
  const launch = bool(patch.launchBrowser, 'launchBrowser');
  if (launch !== undefined) next.launchBrowser = launch;
  const cookies = text(patch.cookies, 'cookies');
  if (cookies !== undefined) {
    if (cookies) next.cookies = cookies;
    else delete next.cookies;
  }
  const storyboardAuto = bool(patch.storyboardAuto, 'storyboardAuto');
  const sbPrev = next.storyboard && typeof next.storyboard === 'object' && !Array.isArray(next.storyboard)
    ? next.storyboard
    : {};
  if (storyboardAuto !== undefined) next.storyboard = { ...sbPrev, ...(next.storyboard ?? {}), auto: storyboardAuto };
  if (patch.cutFloor !== undefined) {
    const base = next.storyboard && typeof next.storyboard === 'object' && !Array.isArray(next.storyboard)
      ? next.storyboard
      : {};
    // 空 / 0 = 清掉这项，恢复内核默认
    if (patch.cutFloor === '' || patch.cutFloor === null || Number(patch.cutFloor) === 0) {
      const { cutFloor: _drop, ...rest } = base;
      next.storyboard = rest;
    } else {
      const n = Number(patch.cutFloor);
      if (!Number.isInteger(n) || n < 1 || n > 255) throw new Error('cutFloor 必须是 1-255 的整数');
      next.storyboard = { ...base, cutFloor: n };
    }
  }

  /**
   * 会话图片省略的两个上限（顶层键，和 `mediaMaxMb` 同级）。
   *
   * `0` 是**有意义的取值**（这一维不限），所以不能像 cutFloor 那样把 0 当"清掉"；
   * 空串 / null 才是"恢复默认"（删键，走插件默认 200 张 / 300 MB）。
   */
  for (const key of ['imageTrigger', 'imageKeep']) {
    if (patch[key] === undefined) continue;
    if (patch[key] === '' || patch[key] === null) {
      delete next[key];
      continue;
    }
    const n = Number(patch[key]);
    if (!Number.isInteger(n) || n < 0 || n > 2000) throw new Error(`${key} 必须是 0-2000 的整数`);
    next[key] = n;
  }

  /**
   * 触发线必须大于留底 —— 否则一到线就想省，结果发现"本来就不该省"。
   * 这里**直接拒绝**而不是自动夹住：设置页正在编辑，用户需要知道是哪两个数打架。
   * （插件加载时的 tuning.js 那条路是"夹住 + warn"，因为那时用户不在场。）
   */
  {
    const t = next.imageTrigger === undefined ? 300 : Number(next.imageTrigger);
    const k = next.imageKeep === undefined ? 100 : Number(next.imageKeep);
    if (Number.isInteger(t) && Number.isInteger(k) && t > 0 && k >= t) {
      throw new Error(`保留张数（${k}）必须小于触发线（${t}）`);
    }
  }
  /**
   * 默认档位策略 / 逐档映射。
   *
   * 空值（`''` / `{}`）是**清掉这一项**：设置页把它切回"不指定"时要能真的删掉，
   * 否则文件里留一个空对象，下次读出来还得再判一次。
   */
  if (patch.strategy !== undefined) {
    const base = next.storyboard && typeof next.storyboard === 'object' && !Array.isArray(next.storyboard)
      ? next.storyboard : {};
    const v = String(patch.strategy ?? '').trim();
    if (!v) {
      const { strategy: _drop, ...rest } = base;
      next.storyboard = rest;
    } else {
      next.storyboard = { ...base, strategy: v };
    }
  }
  if (patch.tierMap !== undefined) {
    const base = next.storyboard && typeof next.storyboard === 'object' && !Array.isArray(next.storyboard)
      ? next.storyboard : {};
    const raw = patch.tierMap;
    const clean = {};
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [k, v] of Object.entries(raw)) {
        const from = Number(k);
        const to = Number(v);
        if (!Number.isInteger(from) || from < 1 || from > 8) {
          throw new Error(`tierMap 的档位必须是 1-8 的整数（收到 ${k}）`);
        }
        if (!Number.isInteger(to) || to < 1 || to > 8) {
          throw new Error(`tierMap 的目标档位必须是 1-8 的整数（收到 ${v}）`);
        }
        if (from !== to) clean[from] = to;
      }
    }
    if (Object.keys(clean).length === 0) {
      const { tierMap: _drop, ...rest } = base;
      next.storyboard = rest;
    } else {
      next.storyboard = { ...base, tierMap: clean };
    }
  }

  writeObject(path, next);
  return readVideoSettings(env);
}

/** 页面展示文件路径，但不把整个文件内容送给浏览器。 */
export function configPaths(env = process.env) {
  return { asr: asrConfigPath(env), video: videoConfigPath(env), home: dshHome(env) };
}
