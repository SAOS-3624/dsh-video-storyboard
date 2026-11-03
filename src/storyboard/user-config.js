/**
 * user-config.js — 核心读取 ~/.dsh/video.json 的轻量入口。
 *
 * 设置页有自己的一份读写层（settings/config.js）；核心模块不能反过来依赖设置页，
 * 否则 settings -> asr -> core 的圈会绕回来。这里只读、只关心路径类字段。
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function dshHome(env = process.env) {
  return env.DSH_HOME || join(env.USERPROFILE || env.HOME || homedir(), '.dsh');
}

export function videoConfigPath(env = process.env) {
  return join(dshHome(env), 'video.json');
}

/** 坏文件/非对象都按空配置处理；核心不应该因为设置文件损坏而拒绝工作。 */
export function readVideoFile(env = process.env) {
  const path = videoConfigPath(env);
  if (!existsSync(path)) return {};
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

export function configuredText(data, key) {
  const value = data && data[key];
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

/**
 * 按 `"a.b.c"` 路径读一个数字；不存在/非数字/越界都返回 null。
 * 嵌套路径是为了 `storyboard.cutFloor` 这种分组字段（和 `storyboard.auto` 同一层）。
 */
export function configuredNumber(data, path, { min = -Infinity, max = Infinity } = {}) {
  const raw = String(path).split('.')
    .reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), data);
  const n = Number(raw);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}
