/**
 * subtitles.js — 直接从站点拿字幕轨（B 站的 CC），不去猜、也不本地转写。
 *
 * 为什么需要：B 站视频的字幕是**单独的轨道**，下载下来的 mp4 里通常没有，
 * 所以 `extractSubtitleTrack`（读容器内嵌流）对它永远是 null，于是白白退回 ASR。
 * 而字幕轨是作者自己写的准确文本，比 ASR 好得多：不烧 CPU、不错字、还带准确时间码。
 *
 * 坑：B 站字幕**要登录**。没登录时 yt-dlp 只给 danmaku，并且明确警告
 * "Subtitles are only available when logged in"。所以这里要把"没有字幕"和
 * "有字幕但要登录"分开——前者换 ASR 就行，后者得让用户补 cookies。
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { discoverYtdlp } from './fetch.js';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { parseSrt } from './asr.js';

/** 优先中文字幕，其次英文；B 站常见的就是这几个 id */
const LANGS = ['zh-Hans', 'zh-CN', 'zh', 'ai-zh', 'en', 'en-US'];

const run = (bin, args, opts) => new Promise((resolve) => {
  execFile(bin, args, opts, (err, stdout, stderr) => resolve({
    ok: !err, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), err,
  }));
});

/**
 * @returns {Promise<{ok:true, segments:Array, lang:string, file:string}
 *   | {ok:false, reason:'no-ytdlp'|'needs-login'|'no-subs'|'failed', detail?:string}>}
 */
/** 没显式给 cookies 时，从 ~/.dsh/video.json 里读（和端口配置同一个文件） */
function configuredCookies(env = process.env) {
  const home = env.DSH_HOME || join(env.USERPROFILE || env.HOME || homedir(), '.dsh');
  try {
    const cfg = JSON.parse(readFileSync(join(home, 'video.json'), 'utf8'));
    if (typeof cfg?.cookies === 'string' && existsSync(cfg.cookies)) return cfg.cookies;
  } catch { /* 没配就算了 */ }
  return null;
}

/** 同一支视频只试一次：失败（尤其 needs-login）就别每次调用都白等 5 秒 */
const memo = new Map();

export async function fetchRemoteSubtitles({
  url, cookies = null, timeoutMs = 90_000, langs = LANGS,
} = {}) {
  if (!url) return { ok: false, reason: 'failed', detail: 'no url' };
  const jar = cookies ?? configuredCookies();
  const key = `${url}|${jar ? 'ck' : 'anon'}`;
  if (memo.has(key)) return memo.get(key);
  const result = await fetchOnce({ url, cookies: jar, timeoutMs, langs });
  memo.set(key, result);
  return result;
}

async function fetchOnce({ url, cookies, timeoutMs, langs }) {
  let tool;
  try {
    tool = await discoverYtdlp({});
  } catch {
    return { ok: false, reason: 'no-ytdlp' };
  }

  const dir = await mkdtemp(join(tmpdir(), 'dsh-subs-'));
  try {
    const args = [
      '--skip-download', '--write-subs', '--write-auto-subs',
      '--sub-format', 'srt', '--sub-langs', langs.join(','),
      '--convert-subs', 'srt', '--ignore-errors',
      '-o', join(dir, '%(id)s.%(ext)s'),
      ...(cookies && existsSync(cookies) ? ['--cookies', cookies] : []),
      url,
    ];
    const { stdout, stderr } = await run(tool.bin, [...(tool.prefix ?? []), ...args],
      { timeout: timeoutMs, maxBuffer: 8 << 20 });

    const combined = `${stdout}\n${stderr}`;
    // 有字幕但要登录：这是最容易被误判成"没有字幕"的一种
    if (/subtitles are only available when logged in/i.test(combined)) {
      return { ok: false, reason: 'needs-login' };
    }

    const files = (await readdir(dir)).filter((f) => f.endsWith('.srt'));
    if (files.length === 0) return { ok: false, reason: 'no-subs' };

    // 多个语言时按 LANGS 顺序优先
    const rank = (f) => {
      const i = langs.findIndex((l) => f.includes(`.${l}.`));
      return i === -1 ? langs.length : i;
    };
    files.sort((a, b) => rank(a) - rank(b));
    const file = join(dir, files[0]);
    const segments = parseSrt(await readFile(file, 'utf8'));
    if (segments.length === 0) return { ok: false, reason: 'no-subs' };
    return { ok: true, segments, lang: files[0].split('.').slice(-2)[0], file };
  } catch (e) {
    return { ok: false, reason: 'failed', detail: String(e?.message ?? e).slice(0, 120) };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * 验证 B 站 cookie 到底有没有登录。
 *
 * 为什么需要：`needs-login` 有两种可能——「cookie 没配」和「cookie 配了但过期了」。
 * 光看 yt-dlp 的警告分不出来，而这两种对用户是完全不同的动作（去配 / 去重新导出）。
 * 直接问 B 站自己的 nav 接口最干脆：`code: -101` 就是没登录。
 */
export async function checkBiliLogin({ cookies = null, timeoutMs = 15_000 } = {}) {
  const jarPath = cookies ?? configuredCookies();
  if (!jarPath) return { ok: false, reason: 'no-cookies-file' };

  let jar;
  try {
    jar = await readFile(jarPath, 'utf8');
  } catch {
    return { ok: false, reason: 'cookies-unreadable', path: jarPath };
  }
  const keep = new Set(['SESSDATA', 'bili_jct', 'DedeUserID', 'buvid3']);
  const pairs = [];
  for (const line of jar.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const f = line.split('\t');
    if (f.length >= 7 && keep.has(f[5])) pairs.push(`${f[5]}=${f[6]}`);
  }
  if (!pairs.some((p) => p.startsWith('SESSDATA='))) {
    return { ok: false, reason: 'no-sessdata', path: jarPath };
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch('https://api.bilibili.com/x/web-interface/nav', {
      headers: {
        Cookie: pairs.join('; '),
        'User-Agent': 'Mozilla/5.0',
        Referer: 'https://www.bilibili.com/',
      },
      signal: ac.signal,
    });
    const body = await res.json();
    const d = body?.data ?? {};
    return {
      ok: Boolean(d.isLogin),
      reason: d.isLogin ? 'logged-in' : 'not-logged-in',
      code: body?.code,
      uname: d.uname ?? null,
      vip: d.vipStatus === 1,
      path: jarPath,
    };
  } catch (e) {
    return { ok: false, reason: 'request-failed', detail: String(e?.message ?? e).slice(0, 100) };
  } finally {
    clearTimeout(timer);
  }
}
