/**
 * binaries.js — 解析 ffmpeg / ffprobe 可执行文件。
 *
 * 优先级：
 *  1. 显式环境变量（DSH_FFMPEG_PATH / FFMPEG_PATH，或 DSH_FFMPEG_DIR）
 *  2. DSH 自己的安装目录：$DSH_HOME/tools/ffmpeg/bin、$DSH_HOME/bin
 *  3. DSH 安装根目录下的 tools/ffmpeg/bin、bin（$DSH_HOME 的上一级）
 *  4. PATH 上的 ffmpeg / ffprobe
 *
 * DSH 桌面版常把媒体工具放在安装目录而不进 PATH；这个解析器让插件不必要求
 * 用户改系统 PATH。找不到时保留裸命令名，让底层报错原样暴露。
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const exeSuffix = (platform) => (platform === 'win32' ? '.exe' : '');

/**
 * @param {'ffmpeg'|'ffprobe'} name
 * @param {{env?:NodeJS.ProcessEnv, platform?:NodeJS.Platform}} [opts]
 * @returns {Array<{path:string, source:string, explicit:boolean}>}
 */
export function mediaCandidates(name, { env = process.env, platform = process.platform } = {}) {
  const upper = name.toUpperCase();
  const suffix = exeSuffix(platform);
  const fileName = name + suffix;
  const home = env.DSH_HOME
    || join(env.USERPROFILE || env.HOME || homedir(), '.dsh');
  const roots = [home, dirname(home)];
  const seen = new Set();
  const out = [];

  const add = (path, source, explicit = false) => {
    if (typeof path !== 'string' || path === '' || seen.has(path)) return;
    seen.add(path);
    out.push({ path, source, explicit });
  };

  // 显式覆盖：即使文件暂时不存在也尊重调用方，便于报出它自己配错的路径。
  add(env[`DSH_${upper}_PATH`], `env DSH_${upper}_PATH`, true);
  add(env[`${upper}_PATH`], `env ${upper}_PATH`, true);
  const dir = env[`DSH_${upper}_DIR`];
  if (typeof dir === 'string' && dir !== '') add(join(dir, fileName), `env DSH_${upper}_DIR`);

  for (const root of roots) {
    add(join(root, 'tools', 'ffmpeg', 'bin', fileName), `${root}/tools/ffmpeg/bin`);
    add(join(root, 'bin', fileName), `${root}/bin`);
  }
  return out;
}

/** 返回实际存在的第一个候选；没有则返回 null。 */
export function resolveMediaBinary(name, opts = {}) {
  for (const candidate of mediaCandidates(name, opts)) {
    if (candidate.explicit || existsSync(candidate.path)) return candidate.path;
  }
  return null;
}

/** 给错误信息用的“我试过哪些路径”，不包含任何密钥。 */
export function describeMediaSearch(name, opts = {}) {
  const candidates = mediaCandidates(name, opts);
  if (candidates.length === 0) return `no search paths for ${name}`;
  return `${name} not found; tried: ${candidates.map((c) => `${c.path} [${c.source}]`).join(', ')}; then PATH`;
}

export const DEFAULT_FFMPEG = resolveMediaBinary('ffmpeg') || 'ffmpeg';
export const DEFAULT_FFPROBE = resolveMediaBinary('ffprobe') || 'ffprobe';
