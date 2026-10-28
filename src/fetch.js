/**
 * fetch.js — 「URL → 本地文件」的那一层，以及 zoom 用的高清直链。
 *
 * 设计前提（都在真机上量过，不是推测）：
 *
 *  1. **必须落盘一份低清全片**。`pick:'sharp'` 每段要 3 个候选帧，9 段就是 27 次随机 seek。
 *     实测同一条视频：本地 27 次 9.6s，HTTP 直链 51.8s。那 7MB 是"后面随便跳"的入场费。
 *  2. **高清只在 zoom 时取帧**，一次 2–6 帧，不落盘。
 *  3. **必须登录**。同一条视频匿名只有 480P、登录有 1080P，而且**那一档根本不在列表里**——
 *     模型不会收到任何信号，只会以为自己看的是高清。所以默认拒绝无 cookie 调用。
 *  4. 插件**不打包 yt-dlp**，只调用用户自己装的那个（`docs/设计 §9.5` 已拍板）。
 *
 * 这一层只负责"把东西弄到本地"和"记下能拿到什么"，不碰扫描/取帧。
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { probeVideo } from './probe.js';

export const COOKIES_ENV = 'DSH_VIDEO_COOKIES';
export const MEDIA_ENV = 'DSH_VIDEO_MEDIA_DIR';
export const MEDIA_MAX_MB_ENV = 'DSH_VIDEO_MEDIA_MAX_MB';
export const DEFAULT_MEDIA_MAX_MB = 300;

/** 与 DSH 默认一致的浏览器 UA —— B 站 CDN 对空 UA 直接 403 */
export const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const INSTALL_HINT = [
  'yt-dlp not found. Install one of:',
  '  pip install --user -U yt-dlp        (Windows/macOS/Linux)',
  '  winget install yt-dlp               (Windows)',
  '  brew install yt-dlp                 (macOS)',
  'Then either put it on PATH or set DSH_YTDLP_PATH to the executable.',
].join('\n');

/**
 * 下载目录里出现 `video.*` 的不一定是画面轨：B 站的 DASH 源会给出 `video.f30280.m4a`
 * 这种纯音频轨。文件名不能当容器证据（PR #8 的教训），但**扩展名足以判断"这是不是音频"**——
 * 把 m4a 改名成 video.mp4 才是真正的静默坏数据，宁可在这里报错。
 */
const AUDIO_EXTS = new Set(['.m4a', '.m4b', '.mp3', '.aac', '.opus', '.ogg', '.oga', '.wav', '.flac', '.weba']);

/* ------------------------------------------------------------------ 输入判别 */

/** 是不是 http(s) 链接。其它一切（含 file://、裸路径）都按本地文件处理。 */
export function isHttpUrl(value) {
  if (typeof value !== 'string') return false;
  if (!/^https?:\/\//i.test(value.trim())) return false;
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

const PRIVATE_HOST = [
  /^localhost$/i,
  /^127\./,
  /^0\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^\[?::1\]?$/,
  /^\[?f[cd][0-9a-f]{2}:/i,
];

/**
 * 允许的链接：只放 http(s)，且**拒绝内网地址**。
 * 理由不是洁癖 —— yt-dlp 会把链接交给 ffmpeg，一个 169.254.169.254 就能把云元数据读出来。
 */
export function assertFetchableUrl(raw) {
  const value = String(raw).trim();
  if (!isHttpUrl(value)) {
    throw new Error('only http(s) links are fetched; for a local file pass the path directly');
  }
  const { hostname } = new URL(value);
  if (PRIVATE_HOST.some((re) => re.test(hostname))) {
    throw new Error(`refusing to fetch a private/loopback host: ${hostname}`);
  }
  return value;
}

/**
 * 归一化链接，用来做缓存键。
 * 去掉站外跟踪参数（B 站会带一长串 spm_id_from），但**保留 `p`**（分P），否则不同 P 会撞同一个键。
 */
export function normalizeUrl(raw) {
  try {
    const url = new URL(String(raw).trim());
    url.hash = '';
    const drop = [];
    for (const key of url.searchParams.keys()) {
      if (/^(spm_id_from|vd_source|share_source|share_medium|share_plat|share_tag|timestamp|unique_k|from_source|from_spmid|bbid|ts)$/i.test(key)) {
        drop.push(key);
      }
    }
    for (const key of drop) url.searchParams.delete(key);
    url.hostname = url.hostname.toLowerCase();
    return url.toString();
  } catch {
    return String(raw).trim();
  }
}

/* ------------------------------------------------------------------ yt-dlp 发现 */

async function exists(path) {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/** PATH 上找可执行文件（手写一份，避免依赖 which 包） */
async function findOnPath(name, env = process.env) {
  const dirs = (env.PATH || env.Path || '').split(delimiter).filter(Boolean);
  const exts = process.platform === 'win32'
    ? (env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean)
    : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (await exists(candidate)) return candidate;
    }
  }
  return null;
}

/** pip 在 Windows 上把脚本放在 %APPDATA%\Python\Python3xx\Scripts，通常不在 PATH 上 */
async function findPipScript(env = process.env) {
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
    if (await exists(direct)) return direct;
    // %APPDATA%\Python\Python313\Scripts\yt-dlp.exe
    let children = [];
    try {
      children = await readdir(root);
    } catch {
      continue;
    }
    for (const child of children) {
      const candidate = join(root, child, 'Scripts', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
      if (await exists(candidate)) return candidate;
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
    if (!(await exists(path))) {
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
    return 'Bilibili refused this request (HTTP 567) — that is their risk control, not a plugin bug. ' +
      'It usually means the video needs a signed-in session (1080P+, 会员/付费, or a fresh rate-limit). ' +
      'Fix: export cookies.txt (README "needs a signed-in video" / docs/SETUP.md §3) and point ' +
      'DSH_VIDEO_COOKIES at it, or download the file yourself and pass a local path. ' +
      'Anonymous 360P usually still works on ordinary videos.';
  }
  if (/HTTP Error 412/i.test(text)) {
    return 'HTTP 412: the site rate-limited this request. Wait a moment and retry.';
  }
  if (/Requested format is not available|No video formats found/i.test(text)) {
    return 'no usable format matched the selector: Bilibili serves DASH tracks, ' +
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
  return {
    title: typeof info?.title === 'string' ? info.title : null,
    duration: Number.isFinite(Number(info?.duration)) ? Number(info.duration) : null,
    heights,
    maxHeight: heights.length > 0 ? heights.at(-1) : null,
    formats,
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

/** 选出"能覆盖到 h 的最省参数"的格式串。B 站是 DASH，所以必须是 bv*+ba。 */
export function formatSelector(height, { withAudio = true } = {}) {
  const cap = Number.isFinite(height) && height > 0 ? `[height<=${Math.round(height)}]` : '';
  // **优先渐进式单文件**（B 站的 `b`）：一个文件、不用合流，比 `bv*+ba` 快得多，也省一次落盘。
  // 渐进式最高一般只到 720p，但扫描只用 360p，够；拿不到再退回 DASH。
  if (!cap) return withAudio ? 'bv*+ba/b' : 'bv*/b';
  return withAudio
    ? `b${cap}/bv*${cap}+ba/b${cap}/bv*+ba/b`
    : `b${cap}/bv*${cap}/bv*/b`;
}

/** 旧的选法，保留给测试对照：只走 DASH 优先 */
function dashFirstSelector(height, { withAudio = true } = {}) {
  const cap = Number.isFinite(height) && height > 0 ? `[height<=${Math.round(height)}]` : '';
  // **末尾必须留一个不带筛选的兜底**。竖屏视频在 yt-dlp 里是 360x640 / 480x852 ——
  // `height` 是长边，`height<=480` 一个都匹配不到，整条链路直接报
  // "Requested format is not available"（实测 BV1BjxM69EHh 就是这样挂的）。
  if (!cap) return withAudio ? 'bv*+ba/b' : 'bv*/b';
  if (!withAudio) return `bv*${cap}/b${cap}/bv*/b`;
  return `bv*${cap}+ba/b${cap}/bv*+ba/b`;
}

/* ------------------------------------------------------------------ 媒体缓存 */

export function mediaDir(env = process.env) {
  return env[MEDIA_ENV] || join(tmpdir(), 'dsh-video-storyboard', 'media');
}

export function mediaMaxBytes(env = process.env) {
  const mb = Number(env[MEDIA_MAX_MB_ENV]);
  return (Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_MEDIA_MAX_MB) * 1024 * 1024;
}

/** 缓存键：归一化链接 + 落盘清晰度。**路径必须稳定**，否则下游的 sha1(路径+窗口) 会全部失效。 */
export function mediaKey(normalizedUrl, height) {
  return createHash('sha1').update(`${normalizedUrl}|${height}`).digest('hex').slice(0, 20);
}

async function dirSize(dir) {
  let total = 0;
  let newest = 0;
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return { total: 0, newest: 0 };
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    try {
      const st = await stat(path);
      total += st.size;
      newest = Math.max(newest, st.mtimeMs);
    } catch { /* 忽略 */ }
  }
  return { total, newest };
}

/**
 * 超限就**按 mtime 从旧到新**删整个 `<key>/` 目录。
 * 单个目录一起删，不留半个视频——否则下次会命中一个没有 video.mp4 的空壳。
 */
export async function pruneMedia({ dir = mediaDir(), maxBytes = mediaMaxBytes() } = {}) {
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return { removed: 0, bytes: 0 };
  }
  const dirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(dir, entry.name);
    const { total, newest } = await dirSize(path);
    if (total > 0) dirs.push({ path, size: total, at: newest });
  }
  dirs.sort((a, b) => a.at - b.at);
  let total = dirs.reduce((n, d) => n + d.size, 0);
  let removed = 0;
  for (const d of dirs) {
    if (total <= maxBytes) break;
    try {
      await rm(d.path, { recursive: true, force: true });
      total -= d.size;
      removed += 1;
    } catch { /* 忽略 */ }
  }
  return { removed, bytes: total };
}

/* ------------------------------------------------------------------ 主入口 */

/** 磁盘剩余空间（字节）。拿不到就返回 null，由调用方决定是否放行。 */
async function freeBytes() {
  try {
    const { statfs } = await import('node:fs/promises');
    const s = await statfs(tmpdir());
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

/**
 * 把 URL 变成一份可以喂给现有管线的本地文件，并把"这条链接能拿到什么"记下来。
 *
 * @param {string} input  http(s) 链接
 * @param {object} opts
 * @param {number} [opts.scanHeight=360]   落盘用的清晰度上限
 * @param {number} [opts.zoomHeight=1080]  只记录，供 zoom 用
 * @param {string} [opts.cookies]
 * @param {boolean} [opts.allowAnonymous=false]
 * @param {{bin:string,prefix:string[]}} [opts.ytdlp]  测试注入，正常走发现逻辑
 * @param {(p:object)=>void} [opts.onProgress]
 * @returns {Promise<{path:string, source:object}>}
 */
export async function fetchMedia(input, opts = {}) {
  const {
    scanHeight = 360,
    zoomHeight = 1080,
    cookies,
    allowAnonymous = false,
    env = process.env,
    ytdlp,
    onProgress,
    run = runProcess,
  } = opts;

  const url = assertFetchableUrl(input);
  const normalized = normalizeUrl(url);
  const auth = await resolveAuth({ cookies, allowAnonymous, env });
  const tool = ytdlp || await discoverYtdlp({ env, run });

  const key = mediaKey(normalized, scanHeight);
  const dir = join(mediaDir(env), key);
  const target = join(dir, 'video.mp4');

  // ---- 命中：连 meta.json 一起读回来，否则 source 会缺 maxAvailable/zoomTarget
  if (await exists(target)) {
    const st = await stat(target);
    if (st.size > 0) {
      let meta = null;
      try {
        meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'));
      } catch { /* 老缓存没有 meta，退回最小信息 */ }
      const cachedDirect = recallDirect(normalized, zoomHeight);
      onProgress?.({ phase: 'cache-hit', path: target });
      return {
        path: target,
        frameSource: cachedDirect
          ? { uri: cachedDirect.url, userAgent: cachedDirect.userAgent, referer: cachedDirect.referer, height: cachedDirect.height, expiresAt: cachedDirect.expiresAt }
          : null,
        source: {
          kind: 'url',
          url,
          bytes: st.size,
          scanHeight,
          ...(meta ?? {}),
          // `cached` 必须排在展开之后：meta.json 里存的是写入那一刻的 false，会把这里覆盖掉
          cached: true,
        },
      };
    }
  }

  // ---- 解析
  onProgress?.({ phase: 'resolve', url });
  const probeArgs = ['-J', '--no-warnings', '--no-playlist'];
  if (auth.cookiesPath) probeArgs.push('--cookies', auth.cookiesPath);
  probeArgs.push(url);
  const probed = await run(tool, probeArgs, { timeoutMs: 90_000 });
  if (probed.code !== 0) throw new Error(explainYtdlpError(probed.stderr, probed.code));

  let info;
  try {
    info = JSON.parse(probed.stdout);
  } catch {
    throw new Error('yt-dlp returned unparsable JSON while resolving this link');
  }
  const summary = summariseInfo(unwrapSingle(info, url));

  // 顺手把 zoom 要用的高清直链挑出来并记住 —— formats 已经在手里了，这一步零成本。
  // 否则 zoom 会再跑一次 `-J`（2.4 s），而它每次都紧跟在这个调用后面。
  const zoomChosen = pickVideoFormat(summary.formats, zoomHeight);
  const zoomDirect = directFromFormat(zoomChosen);
  if (zoomDirect) rememberDirect(normalized, zoomHeight, zoomDirect);

  // ---- 空间检查（下载前，按估算大小拒绝，不静默降质）
  const wantHeight = summary.heights.length > 0
    ? summary.heights.filter((h) => h <= scanHeight).at(-1) ?? summary.heights[0]
    : null;
  const wanted = Number.isFinite(Number(info?.filesize_approx))
    ? Number(info.filesize_approx)
    : null;
  if (wanted) {
    const free = await freeBytes();
    if (free !== null && wanted * 1.5 > free) {
      throw new Error(
        `not enough disk space: need about ${(wanted / 1048576).toFixed(0)} MB ` +
        `(+50% headroom), only ${(free / 1048576).toFixed(0)} MB free`,
      );
    }
  }

  // ---- 下载
  await mkdir(dir, { recursive: true });
  onProgress?.({ phase: 'download', height: wantHeight });
  const dlArgs = [
    '-f', formatSelector(scanHeight),
    // 按"短边"就近取：竖屏视频的 res 是宽（360/480/720），不是 height。
    ...(Number.isFinite(scanHeight) && scanHeight > 0 ? ['-S', `res:${Math.round(scanHeight)}`] : []),
    '--no-warnings', '--no-playlist', '--no-progress',
    // 断点续传：网络抖了下次接着下，而不是从头再来
    '--continue',
    // CDN 抖动很常见（B 站尤其），默认只重试 10 次整包，分片不重试
    '--retries', '3', '--fragment-retries', '5',
    '--merge-output-format', 'mp4',
    '-o', join(dir, 'video.%(ext)s'),
  ];
  if (auth.cookiesPath) dlArgs.push('--cookies', auth.cookiesPath);
  dlArgs.push(url);

  let downloaded = await run(tool, dlArgs, { timeoutMs: 600_000 });

  // B 站风控（567）/ 限流（412）：带浏览器头 + Referer 再试一次。
  // 不去猜它的风控算法，只给它一眼看得出是"浏览器在看网页"的请求。
  if (downloaded.code !== 0 && /HTTP Error (?:567|412)/i.test(downloaded.stderr ?? '')) {
    const retryArgs = dlArgs.slice(0, -1).concat([
      '--add-header', 'Referer:https://www.bilibili.com/',
      '--user-agent',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
        'Chrome/124.0.0.0 Safari/537.36',
      '--sleep-requests', '1',
      dlArgs[dlArgs.length - 1],
    ]);
    downloaded = await run(tool, retryArgs, { timeoutMs: 600_000 });
  }

  if (downloaded.code !== 0) {
    // **不要删目录**：yt-dlp 的 .part 是断点续传的本钱。
    // 原来这里 `rm -rf` 掉整个缓存目录，于是网络一抖就"下到一半清零、从头再来"——
    // 用户实测表现为"越下越慢"（繁星-夏夜反馈）。残留的 .part 由 pruneMedia 按时间清。
    throw new Error(explainYtdlpError(downloaded.stderr, downloaded.code));
  }
  // yt-dlp 有时会把 DASH 流写成 video.f100022.mp4（格式 id 进了文件名），
  // 而不是 --merge-output-format 期望的 video.mp4。文件名不是容器判定的依据：
  // 取目录里实际产出、最大的那个视频文件，收敛到稳定的 video.mp4 再交给管线。
  let st = await stat(target).catch(() => null);
  if (!st || st.size === 0) {
    const candidates = [];
    const audioOnly = [];
    for (const name of await readdir(dir).catch(() => [])) {
      if (!name.startsWith('video.') || /\.(part|ytdl|temp)$/i.test(name)) continue;
      const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
      try {
        const info = await stat(join(dir, name));
        if (!info.isFile() || info.size === 0) continue;
        if (AUDIO_EXTS.has(ext)) { audioOnly.push(name); continue; }
        candidates.push({ path: join(dir, name), size: info.size, ext });
      } catch { /* 半成品被并发删除 */ }
    }
    if (candidates.length === 0) {
      if (audioOnly.length > 0) {
        throw new Error(
          `yt-dlp produced audio only (${audioOnly.join(', ')}): ` +
          'this link gave no video stream to scan. Try again without --allow-anonymous, ' +
          'or pass a local file path.',
        );
      }
      throw new Error('yt-dlp reported success but produced no file');
    }
    candidates.sort((a, b) => {
      const amp = a.ext === '.mp4' ? 1 : 0;
      const bmp = b.ext === '.mp4' ? 1 : 0;
      return bmp - amp || b.size - a.size;
    });
    await rm(target, { force: true });
    await rename(candidates[0].path, target);
    st = await stat(target);
  }
  // 目标清晰度：请求的和实际能给的取小 —— 这正是"片源判断"要留在清单里的东西
  const zoomTarget = summary.heights.length > 0
    ? Math.min(zoomHeight, summary.maxHeight ?? zoomHeight)
    : zoomHeight;

  // 匿名/低档位拿到的副本可能**没有音轨**（B 站最低档只有画面），
  // 于是整条音频链沉默（transcript=no-audio、meanLufs=null），用户以为是插件坏了。
  // 这里明确区分"源本来就没声音"和"这次下载的副本没声音"（xingyueDanYang 报的观察）。
  const sourceHasAudio = (summary.formats ?? []).some((f) => f.acodec && f.acodec !== 'none');
  const localInfo = await probeVideo(target).catch(() => null);
  const audioMissing = Boolean(localInfo && !localInfo.hasAudio && sourceHasAudio);

  const source = {
    kind: 'url',
    ...(audioMissing ? { audioMissing: true } : {}),
    url,
    cached: false,
    bytes: st.size,
    scanHeight,
    scanActual: wantHeight,
    maxAvailable: summary.maxHeight,
    availableHeights: summary.heights,
    zoomTarget,
    title: summary.title,
    duration: summary.duration,
    auth: auth.kind,
    // 只有"匿名 + 确实拿不到目标档"才说一句。匿名但够高清时闭嘴 ——
    // 早期版本无条件报错，实测把"匿名本来就有 1080P"的视频也拦了，纯属帮倒忙。
    ...(auth.kind === 'anonymous' && zoomTarget < zoomHeight ? { authWarning: auth.warning } : {}),
    ...(zoomTarget < zoomHeight ? { degraded: [`source-max-${summary.maxHeight ?? '?'}p`] } : {}),
  };

  // 落一份元信息，让"第二次看同一条链接"不用再解析（-J 要 2.4 s）。
  // 里面**没有直链**：那是带签名的凭证，只活在进程内存里。
  await writeFile(join(dir, 'meta.json'), JSON.stringify(source, null, 0), 'utf8').catch(() => {});

  await pruneMedia({ dir: mediaDir(env), maxBytes: mediaMaxBytes(env) });
  onProgress?.({ phase: 'done', bytes: st.size });

  return {
    path: target,
    // frameSource 只进管线，**不进 manifest** —— 直链是带签名的临时凭证
    frameSource: zoomDirect
      ? { uri: zoomDirect.url, userAgent: zoomDirect.userAgent, referer: zoomDirect.referer, height: zoomDirect.height, expiresAt: zoomDirect.expiresAt }
      : null,
    source,
  };
}

/* ------------------------------------------------------------------ 直链 */

/**
 * 直链是有签名的临时凭证，只在进程内存里留一会儿。
 * 为什么值得记：storyboard 已经跑过一次 `-J`（2.4 s），zoom 紧接着再来一次纯属浪费；
 * 而且 zoom 之后往往还有第二个 zoom。
 * 过期就丢——**绝不落盘**，落盘的凭证比多花 2.4 秒危险得多。
 */
const directCache = new Map();

export function rememberDirect(normalizedUrl, height, info) {
  directCache.set(`${normalizedUrl}|${height}`, { ...info, storedAt: Date.now() });
  // 顺手清掉过期的，避免长会话里无限膨胀
  if (directCache.size > 64) {
    const now = Date.now();
    for (const [key, value] of directCache) {
      if (value.expiresAt && value.expiresAt - now < 10 * 60 * 1000) directCache.delete(key);
    }
  }
}

export function recallDirect(normalizedUrl, height, { marginMs = 10 * 60 * 1000 } = {}) {
  const hit = directCache.get(`${normalizedUrl}|${height}`);
  if (!hit) return null;
  if (hit.expiresAt && hit.expiresAt - Date.now() < marginMs) {
    directCache.delete(`${normalizedUrl}|${height}`);
    return null;
  }
  return hit;
}

export function __clearDirectCache() {
  directCache.clear();
}

/** 从 yt-dlp 的 formats 里挑一条不超过 height 的最好画面轨 */
export function pickVideoFormat(formats, height) {
  const video = formats.filter((f) => f.vcodec && f.vcodec !== 'none');
  if (video.length === 0) return null;
  // **按短边比，不按 height**：竖屏视频的 height 是长边（1080x1920），用 height<=1080 会把
  // 1080x1920 排除、退到 480x852 —— 清单写着 1080p，实际给的是 852（issue #9）。
  const short = (f) => Math.min(f.height ?? 0, f.width ?? 0) || (f.height ?? 0);
  const below = video
    .filter((f) => !f.height || short(f) <= height)
    .sort((a, b) => short(b) - short(a) || (b.tbr ?? 0) - (a.tbr ?? 0));
  return below[0] ?? [...video].sort((a, b) => short(a) - short(b))[0];
}

function directFromFormat(chosen) {
  if (!chosen?.url) return null;
  const deadline = Number(chosen.url.match(/[?&]deadline=(\d+)/)?.[1]);
  return {
    url: chosen.url,
    height: chosen.height ?? null,
    userAgent: chosen.http_headers?.['User-Agent'] || DEFAULT_UA,
    referer: chosen.http_headers?.Referer || null,
    // B 站直链带 deadline（约 2 小时）；拿不到就按 90 分钟算，宁可早重解析
    expiresAt: Number.isFinite(deadline) && deadline > 0 ? deadline * 1000 : Date.now() + 90 * 60 * 1000,
  };
}

/**
 * 拿一条**只含画面**的高清直链（zoom 用），不落盘。
 * 先查进程内缓存（storyboard 那次 `-J` 已经顺手记下了），miss 才真解析。
 *
 * @returns {Promise<{url:string, height:number, userAgent:string, referer:string|null, expiresAt:number}>}
 */
export async function resolveDirectUrl(input, opts = {}) {
  const {
    height = 1080,
    cookies,
    allowAnonymous = false,
    env = process.env,
    ytdlp,
    run = runProcess,
    useCache = true,
  } = opts;

  const url = assertFetchableUrl(input);
  const normalized = normalizeUrl(url);
  if (useCache) {
    const hit = recallDirect(normalized, height);
    if (hit) return hit;
  }

  const auth = await resolveAuth({ cookies, allowAnonymous, env });
  const tool = ytdlp || await discoverYtdlp({ env, run });

  const args = ['-J', '--no-warnings', '--no-playlist'];
  if (auth.cookiesPath) args.push('--cookies', auth.cookiesPath);
  args.push(url);

  const probed = await run(tool, args, { timeoutMs: 90_000 });
  if (probed.code !== 0) throw new Error(explainYtdlpError(probed.stderr, probed.code));

  let info;
  try {
    info = JSON.parse(probed.stdout);
  } catch {
    throw new Error('yt-dlp returned unparsable JSON while resolving a direct URL');
  }
  const summary = summariseInfo(unwrapSingle(info, url));
  if (!summary.formats.length) throw new Error('no video formats available for this link');

  const chosen = pickVideoFormat(summary.formats, height);
  const direct = directFromFormat(chosen);
  if (!direct) throw new Error('the selected format has no direct URL');

  rememberDirect(normalized, height, direct);
  return direct;
}

/* ------------------------------------------------------------------ 只探测不下载 */

/**
 * 链接版的 probe：只跑 `-J`，**不下载**。
 * 让模型在花掉 7 MB 和 10 秒之前，先知道"这条多长、最高能到多少"。
 * @returns {Promise<{url:string, title:string|null, duration:number|null,
 *                    heights:number[], maxHeight:number|null, auth:string}>}
 */
export async function probeUrl(input, opts = {}) {
  const {
    cookies, allowAnonymous = false, env = process.env, ytdlp, run = runProcess,
  } = opts;

  const url = assertFetchableUrl(input);
  const auth = await resolveAuth({ cookies, allowAnonymous, env });
  const tool = ytdlp || await discoverYtdlp({ env, run });

  const args = ['-J', '--no-warnings', '--no-playlist'];
  if (auth.cookiesPath) args.push('--cookies', auth.cookiesPath);
  args.push(url);

  const probed = await run(tool, args, { timeoutMs: 90_000 });
  if (probed.code !== 0) throw new Error(explainYtdlpError(probed.stderr, probed.code));

  let info;
  try {
    info = JSON.parse(probed.stdout);
  } catch {
    throw new Error('yt-dlp returned unparsable JSON while probing this link');
  }
  const summary = summariseInfo(unwrapSingle(info, url));
  return {
    url,
    title: summary.title,
    duration: summary.duration,
    heights: summary.heights,
    maxHeight: summary.maxHeight,
    auth: auth.kind,
  };
}

/* ------------------------------------------------------------------ 统一入口 */

/**
 * pipeline 唯一要调的函数：本地路径原样返回，链接则换成本地文件。
 * @returns {Promise<{path:string, source:object|null, frameSource:object|null}>}
 */
export async function resolveInput(input, opts = {}) {
  if (!isHttpUrl(input)) return { path: input, source: null, frameSource: null };
  const { path, source, frameSource } = await fetchMedia(input, opts);
  return { path, source, frameSource };
}

/* 供测试/诊断用：写一条最小的媒体记录，不跑 yt-dlp */
export async function __writeFixtureMedia(path, bytes) {
  await writeFile(path, bytes);
}
