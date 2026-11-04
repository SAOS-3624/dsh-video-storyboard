/**
 * binaries.js — 解析 ffmpeg / ffprobe 可执行文件。
 *
 * 优先级：
 *  1. 显式环境变量（DSH_FFMPEG_PATH / FFMPEG_PATH，或 DSH_FFMPEG_DIR）
 *  2. DSH 自己的安装目录：$DSH_HOME/tools/ffmpeg/bin、$DSH_HOME/bin
 *  3. DSH 安装根目录下的 tools/ffmpeg/bin、bin（$DSH_HOME 的上一级）
 *  4. 会话工作区下的 tools/ffmpeg/bin（沙箱只放行工作区时的落点）
 *  5. PATH 上的 ffmpeg / ffprobe
 *
 * DSH 桌面版常把媒体工具放在安装目录而不进 PATH；这个解析器让插件不必要求
 * 用户改系统 PATH。找不到时保留裸命令名，让底层报错原样暴露。
 *
 * **为什么要区分"不存在"和"读不到"**：`existsSync()` 把所有错误都吞成 `false`，
 * 于是在 workspace-write 沙箱里（进程只能看见工作区 + 自己的 node_modules）
 * `$HOME/.dsh/tools/ffmpeg/bin/ffprobe.exe` 明明存在、也能手动跑，插件却报
 * "not found" —— 用户会去反复重装 ffmpeg，而真正该做的是把路径指进工作区
 * 或设 DSH_FFPROBE_PATH（issue #76）。所以这里改用 statSync 并保留 errno。
 */
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const exeSuffix = (platform) => (platform === 'win32' ? '.exe' : '');

/** 探一个候选：区分"没有"和"有但进程读不到"。 */
export function probeBinary(path) {
  try {
    return statSync(path).isFile() ? { ok: true, code: 'OK' } : { ok: false, code: 'EISDIR' };
  } catch (err) {
    return { ok: false, code: err?.code || 'UNKNOWN' };
  }
}

const DENIED = new Set(['EACCES', 'EPERM']);

/**
 * @param {'ffmpeg'|'ffprobe'} name
 * @param {{env?:NodeJS.ProcessEnv, platform?:NodeJS.Platform, cwd?:string}} [opts]
 * @returns {Array<{path:string, source:string, explicit:boolean}>}
 */
export function mediaCandidates(name, { env = process.env, platform = process.platform, cwd } = {}) {
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

  // 沙箱里唯一稳定可读的地方就是会话工作区。用户把 ffmpeg 拷进工作区后
  // 不用再设环境变量也能被找到（issue #76 的绕法固化下来）。
  const workspace = env.DSH_WORKSPACE || cwd || process.cwd();
  add(join(workspace, 'tools', 'ffmpeg', 'bin', fileName), `workspace ${join(workspace, 'tools', 'ffmpeg', 'bin')}`);
  add(join(workspace, '.tools', 'ffmpeg', 'bin', fileName), `workspace ${join(workspace, '.tools', 'ffmpeg', 'bin')}`);

  return out;
}

/** 返回实际存在的第一个候选；没有则返回 null。 */
export function resolveMediaBinary(name, opts = {}) {
  const probe = opts.probe || probeBinary;
  for (const candidate of mediaCandidates(name, opts)) {
    if (candidate.explicit || probe(candidate.path).ok) return candidate.path;
  }
  return null;
}

/**
 * 给错误信息用的"我试过哪些路径"，不包含任何密钥。
 * 读不到的候选会标注原因 —— 这是"文件不存在"和"沙箱挡住了"的唯一区分点。
 */
export function describeMediaSearch(name, opts = {}) {
  const probe = opts.probe || probeBinary;
  const candidates = mediaCandidates(name, opts);
  if (candidates.length === 0) return `no search paths for ${name}`;
  let denied = false;
  const parts = candidates.map((c) => {
    const result = c.explicit ? { ok: true, code: 'OK' } : probe(c.path);
    if (result.ok) return `${c.path} [${c.source}]`;
    if (DENIED.has(result.code)) {
      denied = true;
      return `${c.path} [${c.source}] (exists but this process cannot read it: ${result.code})`;
    }
    return `${c.path} [${c.source}]`;
  });
  let text = `${name} not found; tried: ${parts.join(', ')}; then PATH`;
  if (denied) {
    text += '. A file is there but unreadable — if DSH runs in a sandbox, copy the binaries '
      + `into the session workspace and set DSH_${name.toUpperCase()}_PATH to the full path `
      + '(tools/ffmpeg/bin inside the workspace is also searched).';
  }
  return text;
}

export const DEFAULT_FFMPEG = resolveMediaBinary('ffmpeg') || 'ffmpeg';
export const DEFAULT_FFPROBE = resolveMediaBinary('ffprobe') || 'ffprobe';
