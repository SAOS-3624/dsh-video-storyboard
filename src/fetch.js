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

import {
  access, mkdir, readdir, rename, rm, stat, writeFile,
} from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { DEFAULT_FFMPEG, probeVideo } from './probe.js';
import {
  DEFAULT_UA, discoverYtdlp, explainYtdlpError, formatSelector, resolveAuth, runProcess,
  summariseInfo, unwrapSingle,
} from './ytdlp.js';
import {
  fileExists, freeBytes, mediaDir, mediaKey, mediaMaxBytes, pruneMedia,
} from './media-store.js';
import { assertFetchableUrl, isHttpUrl, normalizeUrl } from './url.js';
import { directFromSummary, recallDirect, rememberDirect } from './direct-url.js';

/**
 * 下载目录里出现 `video.*` 的不一定是画面轨：B 站的 DASH 源会给出 `video.f30280.m4a`
 * 这种纯音频轨。文件名不能当容器证据（PR #8 的教训），但**扩展名足以判断"这是不是音频"**——
 * 把 m4a 改名成 video.mp4 才是真正的静默坏数据，宁可在这里报错。
 */
const AUDIO_EXTS = new Set(['.m4a', '.m4b', '.mp3', '.aac', '.opus', '.ogg', '.oga', '.wav', '.flac', '.weba']);

/**
 * 把 URL 变成一份可以喂给现有管线的本地文件，并把"这条链接能拿到什么"记下来。
 *
 * @param {string} input  http(s) 链接
 * @param {object} opts
 * @param {number} [opts.scanHeight=360]   落盘用的清晰度上限
 * @param {number} [opts.zoomHeight=1080]  只记录，供 zoom 用
 * @param {string} [opts.cookies]
 * @param {boolean} [opts.allowAnonymous=false]
 * @param {string} [opts.ffmpegPath]  传给 yt-dlp 的 ffmpeg 路径（合流用）
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
    // yt-dlp 自己不会去 DSH 的 bin 目录找 ffmpeg；不告诉它路径时，DASH 的 `+ba` 合流
    // 会静默失败，只留下 video.<id>.mp4 和 audio.<id>.m4a 两个文件。见 issue #18。
    ffmpegPath = DEFAULT_FFMPEG,
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
  if (await fileExists(target)) {
    const st = await stat(target);
    if (st.size > 0) {
      let meta = null;
      try {
        meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'));
      } catch { /* 老缓存没有 meta，退回最小信息 */ }
      // 旧版本（或无 ffmpeg 的环境）可能把 video-only 的 mp4 缓存下来。
      // 只修下载参数还不够：同一条链接再跑一次会直接命中这份坏缓存，用户按清单提示
      // "装好 ffmpeg 再试"也仍然是无声的。用当时可用的 ffmpeg 路径做一次失效重试；
      // 如果同一个 ffmpeg 仍然合不上，就把 audioMergeRetry 记进 meta，避免每次重下。
      const staleMerge = Boolean(
        meta?.audioMissing && isAbsolute(ffmpegPath) && meta.audioMergeRetry !== ffmpegPath,
      );
      if (staleMerge) {
        onProgress?.({ phase: 'cache-invalid', path: target, reason: 'audio-missing' });
        await rm(target, { force: true }).catch(() => {});
        await rm(join(dir, 'meta.json'), { force: true }).catch(() => {});
      } else {
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
  }

  // ---- 解析
  onProgress?.({ phase: 'resolve', url });
  const { summary, authKind, warning: authNote, raw: info } = await probeSummary({ url, auth, tool, env, run });

  // 顺手把 zoom 要用的高清直链挑出来并记住 —— formats 已经在手里了，这一步零成本。
  // 否则 zoom 会再跑一次 `-J`（2.4 s），而它每次都紧跟在这个调用后面。
  const zoomDirect = directFromSummary(summary, zoomHeight);
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
    // DSH 桌面版常把 ffmpeg 放在 $DSH_HOME/bin 而不进 PATH；yt-dlp 只认 PATH 或这个参数。
    ...(isAbsolute(ffmpegPath) ? ['--ffmpeg-location', ffmpegPath] : []),
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
  // 合流失败时 yt-dlp 会留下 video.<id>.mp4 + video.<id>.m4a 两个文件，而这里选了 mp4。
  // 把原因记下来，清单才能说"装 ffmpeg"，而不是误导用户再去换 cookies。
  const companionAudio = audioMissing
    ? (await readdir(dir).catch(() => [])).filter((name) => {
      if (!name.startsWith('video.') || /\.(part|ytdl|temp)$/i.test(name)) return false;
      const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
      return AUDIO_EXTS.has(ext);
    })
    : [];

  const source = {
    kind: 'url',
    ...(audioMissing ? { audioMissing: true } : {}),
    ...(audioMissing && companionAudio.length > 0 ? { audioMissingReason: 'unmerged-dash' } : {}),
    // 让下一次命中知道"这份坏缓存已经用哪个 ffmpeg 重试过"；换了 ffmpeg 才值得再试。
    ...(audioMissing && isAbsolute(ffmpegPath) ? { audioMergeRetry: ffmpegPath } : {}),
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
    auth: authKind,
    // 站点自己声明的登录门槛（subtitle / paywalled）—— 清单据此要求用户提供 cookies
    ...(Array.isArray(summary.loginGates) && summary.loginGates.length > 0
      ? { needLogin: summary.loginGates } : {}),
    // 只有"匿名 + 确实拿不到目标档"才说一句。匿名但够高清时闭嘴 ——
    // 早期版本无条件报错，实测把"匿名本来就有 1080P"的视频也拦了，纯属帮倒忙。
    ...((authKind === 'anonymous' && zoomTarget < zoomHeight) || authNote
      ? { authWarning: authNote ?? auth.warning } : {}),
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

/* ------------------------------------------------------------------ 只探测不下载 */

/**
 * 链接版的 probe：只跑 `-J`，**不下载**。
 * 让模型在花掉 7 MB 和 10 秒之前，先知道"这条多长、最高能到多少"。
 * @returns {Promise<{url:string, title:string|null, duration:number|null,
 *                    heights:number[], maxHeight:number|null, auth:string}>}
 */

/**
 * 带 cookies 探测，并处理"有 cookies 反而更少"的真实事故：
 * 过期/低权限的 SESSDATA 会让 B 站降级，实测同一支视频带 cookies 只有 480p、匿名却有 1080p。
 * 只在 maxHeight ≤ 720 时多探一次（可疑才付这 3–5 秒）。
 *
 * @returns {{summary:object, authKind:string, warning?:string}}
 */
async function probeSummary({ url, auth, tool, env, run }) {
  const args = ['-J', '--no-warnings', '--no-playlist'];
  const out = {};
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
  const raw = unwrapSingle(info, url);
  if (!auth.cookiesPath || !(summary.maxHeight > 0 && summary.maxHeight <= 720)) {
    return { summary, authKind: auth.kind, raw };
  }
  try {
    const anon = await run(tool, ['-J', '--no-warnings', '--no-playlist', url], { timeoutMs: 90_000 });
    if (anon.code !== 0) return { summary, authKind: auth.kind, raw };
    const anonInfo = unwrapSingle(JSON.parse(anon.stdout), url);
    const a = summariseInfo(anonInfo);
    if (a.maxHeight <= summary.maxHeight) return { summary, authKind: auth.kind, raw };
    return {
      summary: { ...a, title: a.title || summary.title },
      raw: anonInfo,
      authKind: 'anonymous',
      warning: 'cookies 只允许 ' + summary.maxHeight + 'p，匿名反而能拿到 ' + a.maxHeight + 'p' +
        ' —— SESSDATA 可能过期或权限不足，建议重新导出 cookies.txt',
    };
  } catch {
    return { summary, authKind: auth.kind, raw };   // 匿名探失败不影响主结果
  }
}

export async function probeUrl(input, opts = {}) {
  const {
    cookies, allowAnonymous = false, env = process.env, ytdlp, run = runProcess,
  } = opts;

  const url = assertFetchableUrl(input);
  const auth = await resolveAuth({ cookies, allowAnonymous, env });
  const tool = ytdlp || await discoverYtdlp({ env, run });

  const { summary, authKind, warning } = await probeSummary({ url, auth, tool, env, run });
  return {
    url,
    title: summary.title,
    duration: summary.duration,
    heights: summary.heights,
    maxHeight: summary.maxHeight,
    auth: authKind,
    ...(Array.isArray(summary.loginGates) && summary.loginGates.length > 0
      ? { needLogin: summary.loginGates } : {}),
    ...(warning ? { authWarning: warning } : {}),
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

