/**
 * ytdlp.js — 「怎么调 yt-dlp」：找到它、跑它、读它的配置、翻译它的报错。
 *
 * 从 fetch.js 拆出来的。这一层只跟 yt-dlp 这个外部程序的**方言**打交道：
 * `-J` 的 JSON 长什么样、`-f` 选择器怎么写、失败时的 stderr 该怎么翻译成中文提示、
 * cookies 从哪儿来。它不知道"扫描清晰度""直链""分镜"这些东西。
 *
 * 好处是可替换：将来换成别的下载器，只需要另写一份同样五个函数，fetch.js 不用动。
 */

import { spawn } from 'node:child_process';
// `readdir` 必须在这里导入：findPipScript() 用它扫 `%APPDATA%\Python\Python3xx\Scripts`，
// 少了它 `readdir` 是 undefined → 抛 ReferenceError → 被 `catch { continue }` 吞掉 →
// 整个函数**静默返回 null**。症状是 Windows 上 pip 装的 yt-dlp 一律"找不到"，
// 而 PATH 和 DSH_YTDLP_PATH 两条路都能用，所以很难往"代码少了 import"上想（2026-10-30 踩到）。
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { fileExists } from './media-store.js';
import { delimiter, join } from 'node:path';

export const COOKIES_ENV = 'DSH_VIDEO_COOKIES';

/** 与 DSH 默认一致的浏览器 UA —— C站 CDN 对空 UA 直接 403 */
export const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const INSTALL_HINT = [
  'yt-dlp not found. Install one of:',
  '  pip install --user -U yt-dlp        (Windows/macOS/Linux)',
  '  winget install yt-dlp               (Windows)',
  '  brew install yt-dlp                 (macOS)',
  'Then either put it on PATH or set DSH_YTDLP_PATH to the executable.',
].join('\n');

/* ------------------------------------------------------------------ yt-dlp 发现 */

/** PATH 上找可执行文件（手写一份，避免依赖 which 包） */
async function findOnPath(name, env = process.env) {
  const dirs = (env.PATH || env.Path || '').split(delimiter).filter(Boolean);
  const exts = process.platform === 'win32'
    ? (env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean)
    : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (await fileExists(candidate)) return candidate;
    }
  }
  return null;
}

/** pip 在 Windows 上把脚本放在 %APPDATA%\Python\Python3xx\Scripts，通常不在 PATH 上 */
export async function findPipScript(env = process.env) {
  const roots = [];
  if (process.platform === 'win32' && env.APPDATA) {
    roots.push(join(env.APPDATA, 'Python'));
  }
  roots.push(join(homedir(), '.local', 'bin'));
  if (process.platform === 'darwin') {
    roots.push('/opt/homebrew/bin', '/usr/local/bin');
  }
  for (const root of roots) {
    const direct = join(root, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
    if (await fileExists(direct)) return direct;
    // %APPDATA%\Python\Python313\Scripts\yt-dlp.exe
    let children = [];
    try {
      children = await readdir(root);
    } catch {
      continue;
    }
    for (const child of children) {
      const candidate = join(root, child, 'Scripts', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
      if (await fileExists(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * 找一个能跑的 yt-dlp，并**真的执行一次 `--version`** —— 存在但跑不起来（残缺安装、
 * 架构不对）比不存在更坑，所以不能只看文件在不在。
 * @returns {Promise<{bin:string, prefix:string[], version:string}>}
 */
export async function discoverYtdlp({ env = process.env, run = runProcess } = {}) {
  const explicit = env.DSH_YTDLP_PATH;
  const candidates = [];
  if (explicit) candidates.push(explicit);
  candidates.push(await findOnPath('yt-dlp', env));
  candidates.push(await findPipScript(env));

  const tried = [];
  for (const candidate of candidates.filter(Boolean)) {
    tried.push(candidate);
    try {
      const { stdout } = await run({ bin: candidate, prefix: [] }, ['--version'], { timeoutMs: 20_000 });
      const version = stdout.trim().split('\n')[0].trim();
      if (version) return { bin: candidate, prefix: [], version };
    } catch {
      /* 试下一个 */
    }
  }
  const error = new Error(INSTALL_HINT);
  error.code = 'YTDLP_MISSING';
  error.tried = tried;
  throw error;
}

/* ------------------------------------------------------------------ 子进程 */

/**
 * 跑一个子进程。**argv 数组，永不经过 shell** —— 链接里带 `&&` 也不会被执行。
 * @returns {Promise<{stdout:string, stderr:string, code:number}>}
 */
export function runProcess({ bin, prefix = [] }, args, { timeoutMs = 120_000, signal } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, [...prefix, ...args], { stdio: ['ignore', 'pipe', 'pipe'], signal });
    } catch (error) {
      reject(new Error(`failed to spawn ${bin}: ${error.message}`));
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`yt-dlp timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`failed to run ${bin}: ${error.message}`));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 0 });
    });
  });
}

/* ------------------------------------------------------------------ 配置 */

export const CONFIG_FILE = 'video.json';

/**
 * 读 `~/.dsh/video.json`。
 *
 * 为什么必须有这个：**DSH 桌面版读不到用户 `setx` 设的环境变量**（ASR 那边已经踩过一次，
 * 所以 asr.json 存在）。只靠 env 的话，用户在终端里配好了、插件里依然是"没有 cookie"。
 * 配置文件是唯一可靠的通道。
 */
export async function loadVideoConfig({ env = process.env } = {}) {
  const home = env.DSH_HOME || join(homedir(), '.dsh');
  try {
    const raw = JSON.parse(await readFile(join(home, CONFIG_FILE), 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

/* ------------------------------------------------------------------ 认证 */

/**
 * 认证来源：显式参数 > 环境变量 > `~/.dsh/video.json`。
 *
 * **没有 cookie 不再阻断。** 早期版本直接抛错，结果在真实使用里被证明是错的：
 * 同一条视频匿名可能已经有 1080P（实测 `BV1BK411Q7ys` 就是这样），硬拦只会让模型
 * 花好几轮去排查一个不存在的问题。现在改成"先探再判断"——
 * 匿名能拿到目标档就照常走，拿不到才在结果里标 `degraded` 并给一条警告。
 *
 * @returns {{kind:'cookies'|'anonymous', cookiesPath:string|null, warning:string|null}}
 */
export async function resolveAuth({ cookies, allowAnonymous = false, env = process.env, config = null } = {}) {
  const cfg = config ?? await loadVideoConfig({ env });
  const path = cookies || env[COOKIES_ENV] || cfg.cookies;
  if (path) {
    if (!(await fileExists(path))) {
      throw new Error(
        `cookies file not found: ${path}\n` +
        `fix ${COOKIES_ENV} or the "cookies" field in ~/.dsh/${CONFIG_FILE}`,
      );
    }
    return { kind: 'cookies', cookiesPath: path, warning: null };
  }
  return {
    kind: 'anonymous',
    cookiesPath: null,
    // allowAnonymous 现在的含义是"我知道是匿名，别提醒我"，而不是"允许匿名"
    warning: allowAnonymous
      ? null
      : 'anonymous: resolution is not guaranteed (no cookies in DSH_VIDEO_COOKIES or ~/.dsh/video.json)',
  };
}

/** 把 yt-dlp 的 stderr 翻译成人能看懂的结论，不把原始日志倒给用户 */
export function explainYtdlpError(stderr, code = 1) {
  const text = String(stderr || '');
  if (/Failed to decrypt|DPAPI|App-Bound/i.test(text)) {
    return 'cookie decryption failed: Chromium 127+ uses App-Bound Encryption (v20), ' +
      'which yt-dlp cannot read. Export cookies.txt with a browser extension instead of using --cookies-from-browser.';
  }
  if (/Sign in to confirm|login required|需要登录|Please log in/i.test(text)) {
    return 'this video needs a signed-in session. Export cookies.txt and set DSH_VIDEO_COOKIES ' +
      '(or "cookies" in ~/.dsh/video.json) — SESSDATA may also have expired. See docs/SETUP.md.';
  }
  if (/HTTP Error 567/i.test(text)) {
    return 'C站 refused this request (HTTP 567) — that is their risk control, not a plugin bug. ' +
      'It usually means the video needs a signed-in session (1080P+, 会员/付费, or a fresh rate-limit). ' +
      'Fix: export cookies.txt (README "needs a signed-in video" / docs/SETUP.md §3) and point ' +
      'DSH_VIDEO_COOKIES at it, or download the file yourself and pass a local path. ' +
      'Anonymous 360P usually still works on ordinary videos.';
  }
  if (/HTTP Error 412/i.test(text)) {
    return 'HTTP 412: the site rate-limited this request. Wait a moment and retry.';
  }
  if (/Requested format is not available|No video formats found/i.test(text)) {
    return 'no usable format matched the selector: C站 serves DASH tracks, ' +
      'use "bv*[height<=N]+ba" rather than "b[height<=N]".';
  }
  if (/Unsupported URL/i.test(text)) {
    return 'this site is not supported by the installed yt-dlp build.';
  }
  const tail = text.trim().split('\n').slice(-3).join(' | ');
  return `yt-dlp exited ${code}${tail ? `: ${tail}` : ''}`;
}

/* ------------------------------------------------------------------ 解析 */

const HEIGHT_KEYS = ['height'];

/**
 * 一次 `-J` 拿到全部需要的元信息。
 * 为什么不用 `-F`：`-F` 是人读的表格，要正则去啃；`-J` 是结构化 JSON，而且和 `-g`
 * 一样快（实测 2.4s vs 2.6s），顺带把 title/duration 也带回来。
 */
export function summariseInfo(info) {
  const formats = Array.isArray(info?.formats) ? info.formats : [];
  const video = formats.filter((f) => f && f.vcodec && f.vcodec !== 'none');
  const heights = [...new Set(video.map((f) => Number(f[HEIGHT_KEYS[0]])).filter((h) => Number.isFinite(h) && h > 0))]
    .sort((a, b) => a - b);
  // 站点自己说了"登录才给"的字段（C站实测会返回 need_login_subtitle / is_upower_*）。
  // 这些不是"没有"，是"不登录不给" —— 必须区分开，否则清单会把"要登录"说成"这视频没有"。
  const loginGates = [];
  if (info?.need_login_subtitle === true) loginGates.push('subtitle');
  if (info?.is_upower_exclusive === true || info?.is_upower_play === true) loginGates.push('paywalled');
  return {
    title: typeof info?.title === 'string' ? info.title : null,
    duration: Number.isFinite(Number(info?.duration)) ? Number(info.duration) : null,
    heights,
    maxHeight: heights.length > 0 ? heights.at(-1) : null,
    formats,
    loginGates,
  };
}

/**
 * `-J` 对播放列表会返回 `{_type:'playlist', entries:[...]}`，取第一个条目。
 * 多 P 视频显式带 `p` 参数时 yt-dlp 自己就给单个条目，所以这里只是兜底。
 */
export function unwrapSingle(info, url) {
  if (!info || info._type !== 'playlist') return info;
  const entries = Array.isArray(info.entries) ? info.entries.filter(Boolean) : [];
  if (entries.length === 0) throw new Error(`no playable entry found at ${url}`);
  return entries[0];
}

/** 选出"能覆盖到 h 的最省参数"的格式串。C站是 DASH，所以必须是 bv*+ba。 */
export function formatSelector(height, { withAudio = true } = {}) {
  const cap = Number.isFinite(height) && height > 0 ? `[height<=${Math.round(height)}]` : '';
  // **优先渐进式单文件**（C站的 `b`）：一个文件、不用合流，比 `bv*+ba` 快得多，也省一次落盘。
  // 渐进式最高一般只到 720p，但扫描只用 360p，够；拿不到再退回 DASH。
  // C站有些版本会把 video-only 的 mp4 也塞进 `b`，所以要求它必须带音轨；
  // 拿不到就落到 `bv*+ba`（需要 ffmpeg 合流，fetchMedia 会把 DSH 的 ffmpeg 位置传给 yt-dlp）。
  // 末尾的 /b 是给真正没有音轨的素材留的：bv*+ba 选不到音频时会失败，
  // 不能因为"要求音轨"连一个无声视频都下不下来。
  if (!cap) return withAudio ? 'bv*+ba/b[acodec!=none]/b' : 'bv*/b';
  return withAudio
    ? `b${cap}[acodec!=none]/bv*${cap}+ba/b${cap}[acodec!=none]/bv*+ba/b`
    : `b${cap}/bv*${cap}/bv*/b`;
}


