/**
 * resolve-playing.js — 从「系统里正在播什么」反推出源在哪。
 *
 * 为什么要这个：陪看时用户只会说"我在看这个"，不会报路径。
 * SMTC 只给**标题 + 时长**，不给 URL / 文件路径，所以只能靠这两个线索去找：
 *
 *   1. 本地文件：在常见视频目录里按文件名找（标题通常就是文件名）
 *   2. B 站：用 yt-dlp 的 `bilisearch` 搜这个标题，再用**时长**校验
 *
 * 时长校验是关键：B 站同名的封面党/切片一大堆，只有时长对得上（±3 秒）才算找到。
 * 找不到就返回 null，让上层去问用户 —— 不猜。
 */

import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, join } from 'node:path';

import { discoverYtdlp } from './fetch.js';

const VIDEO_EXT = new Set(['.mp4', '.mkv', '.mov', '.avi', '.flv', '.webm', '.ts', '.m4v']);

/** 标题里常带的站点后缀，去掉之后才好搜 */
export function cleanTitle(title) {
  return String(title ?? '')
    .replace(/[_\-–—|]\s*哔哩哔哩.*$/u, '')
    .replace(/[_\-–—|]\s*bilibili.*$/iu, '')
    .replace(/^《(.+)》$/u, '$1')
    .trim();
}

/** 归一化：只留字母数字与汉字，去空格标点，用于宽松比较 */
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/**
 * 在常见目录里找同名视频文件。
 * 只扫一层（各目录的直接子文件），够用：没人会把片子藏在十层目录里。
 */
export async function findLocalByTitle(title, { env = process.env, maxFiles = 4000, roots: customRoots } = {}) {
  const key = norm(cleanTitle(title)).slice(0, 12);
  if (key.length < 4) return null;
  const roots = customRoots ?? [
    join(homedir(), 'Videos'),
    join(homedir(), 'Downloads'),
    join(homedir(), 'Desktop'),
    'D:/Movie', 'D:/Movies', 'D:/Video', 'D:/Videos',
    'D:/JiJiDown/Download', 'E:/Movie', 'E:/Video',
  ].filter(Boolean);

  let scanned = 0;
  for (const root of roots) {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue;                                   // 目录不存在很常见
    }
    for (const e of entries) {
      if (!e.isFile() || scanned >= maxFiles) continue;
      if (!VIDEO_EXT.has(extname(e.name).toLowerCase())) continue;
      scanned += 1;
      if (norm(basename(e.name, extname(e.name))).includes(key)) return join(root, e.name);
    }
  }
  return null;
}

/**
 * 用标题在 B 站搜，靠**时长**确认是哪一条。
 *
 * 搜索结果的条目**不含时长**（实测），所以只能：先用标题挑出前两条，
 * 再各解析一次拿时长，对得上（±3 s）才算找到。多花 2–4 秒，换"不认错片子"。
 */
export async function findBilibiliByTitle(title, duration, { env = process.env, timeoutMs = 90_000 } = {}) {
  const q = cleanTitle(title);
  if (!q || q.length < 4) return { ok: false, reason: 'title-too-short' };
  let tool;
  try {
    tool = await discoverYtdlp({ env });
  } catch {
    return { ok: false, reason: 'no-ytdlp' };
  }
  // 区分"被限流"和"真没这条"：前者换方式拿链接就行，后者说明不是 B 站源。
  // B 站对搜索接口会直接 412 / 弹验证码，一律当成"没搜到"会误导用户。
  let blocked = false;
  const run = (args, ms) => new Promise((resolve) => {
    execFile(tool.bin, [...(tool.prefix ?? []), ...args], { timeout: ms, maxBuffer: 8 << 20 },
      (err, stdout, stderr) => {
        if (err) {
          const msg = `${stderr ?? ''} ${err?.message ?? ''}`;
          if (/41[23]|banned|captcha|risk/i.test(msg)) blocked = true;
          return resolve(null);
        }
        resolve(String(stdout ?? ''));
      });
  });

  // 不能加 --flat-playlist：那样连标题都没有，等于没法筛
  const listOut = await run(['--no-warnings', '-J', '--playlist-end', '5', `bilisearch5:${q}`], timeoutMs);
  if (!listOut) return { ok: false, reason: blocked ? 'search-blocked' : 'search-failed' };
  let list;
  try {
    list = JSON.parse(listOut);
  } catch {
    return { ok: false, reason: 'search-failed' };
  }
  const entries = (list?.entries ?? []).filter((e) => e && (e.url || e.webpage_url || e.id));
  if (entries.length === 0) return { ok: false, reason: blocked ? 'search-blocked' : 'no-match' };

  const key = norm(q).slice(0, 10);
  const ranked = entries
    .map((e) => ({
      e,
      score: norm(e.title ?? '').includes(key) ? 2 : 0,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);

  const want = Number(duration);
  for (const { e } of ranked) {
    const url = e.webpage_url ?? e.url ?? (String(e.id ?? '').startsWith('BV')
      ? `https://www.bilibili.com/video/${e.id}` : null);
    if (!url) continue;
    // 搜索结果没有时长，单独解析一条才有
    const oneOut = await run(['--no-warnings', '-J', '--no-playlist', url], timeoutMs);
    if (!oneOut) continue;
    let one;
    try {
      one = JSON.parse(oneOut);
    } catch {
      continue;
    }
    const dur = Number(one?.duration) || 0;
    if (Number.isFinite(want) && want > 0 && Math.abs(dur - want) <= 3) {
      return { ok: true, url: one.webpage_url ?? url, title: one.title ?? '', duration: dur };
    }
  }
  return { ok: false, reason: blocked ? 'search-blocked' : 'no-match' };
}

/**
 * 先本地、再 B 站。找不到时**带上原因**，别只说"没找到"——
 * "被限流"和"根本不是 B 站"对用户来说是完全不同的两件事。
 */
export async function resolvePlayingSource({ title, duration, env = process.env } = {}) {
  const local = await findLocalByTitle(title, { env });
  if (local) return { kind: 'local', input: local, matchedBy: 'filename' };
  const remote = await findBilibiliByTitle(title, duration, { env });
  if (remote?.ok) {
    return { kind: 'url', input: remote.url, matchedBy: 'title+duration', title: remote.title };
  }
  return { kind: 'failed', reason: remote?.reason ?? 'no-match', title, duration };
}
