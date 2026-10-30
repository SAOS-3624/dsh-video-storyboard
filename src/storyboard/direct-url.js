/**
 * direct-url.js — 高清直链：只给 zoom 取几帧用，不落盘、不留档。
 *
 * 从 fetch.js 拆出来的。它和 fetchMedia 是**两条完全不同的路**：
 * fetchMedia 要一份完整的本地低清片（几十 MB、可缓存、可重读）；
 * 这里只要一个带签名的临时 URI（2–6 帧、几次 HTTP seek 就作废）。
 *
 * 直链**只存在进程内存里**：落盘的凭证比多花 2.4 秒危险得多。
 */

import {
  DEFAULT_UA, discoverYtdlp, explainYtdlpError, formatSelector, resolveAuth, runProcess,
  summariseInfo, unwrapSingle,
} from './ytdlp.js';
import { assertFetchableUrl, normalizeUrl } from './url.js';

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

/** 从 `-J` 的结果里直接挑出 zoom 要用的那一档直链（不下载任何东西）。 */
export function directFromSummary(summary, height) {
  return directFromFormat(pickVideoFormat(summary?.formats, height));
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
