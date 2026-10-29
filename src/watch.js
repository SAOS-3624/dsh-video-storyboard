/**
 * watch.js — 「一起看」：按用户的播放进度，一段一段地把片看下去。
 *
 * 核心不是"多调几次 storyboard"，而是**预取**：
 *   用户在看第 N 段时，插件已经把这一段算完了（8–10 s）；
 *   等用户快看完这一段（remaining ≤ lead），才把图和清单交出去。
 *   于是用户感知到的延迟是 0 —— 计算发生在他在看的时候。
 *
 * 播放进度从 Windows 系统媒体控件（SMTC）读，不依赖任何播放器插件：
 * 任何接了 SMTC 的播放器（VLC / PotPlayer / 电影和电视 / Edge 播网页视频）都会被读到。
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cacheDir } from './cache.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 默认一段多长（秒）。120 s：60 分钟片 = 30 段，成本与连贯性的折中。 */
export const WATCH_SEGMENT = 120;
/** 提前多少秒交付：用户还在看，但这段快到尾巴了，此刻插话不打断。 */
export const WATCH_LEAD = 15;

const norm = (p) => String(p ?? '').replace(/\\/g, '/').toLowerCase();

/* ------------------------------------------------------------ 播放进度 */

export function probePython(config = {}, env = process.env) {
  const configured = config?.ocr?.python || env.DSH_OCR_PYTHON || env.DSH_WATCH_PYTHON;
  if (configured && existsSync(configured)) return configured;
  const guesses = process.platform === 'win32'
    ? ['D:/asr-local/.venv/Scripts/python.exe']
    : ['/usr/bin/python3', '/usr/local/bin/python3'];
  return guesses.find((p) => existsSync(p)) ?? null;
}

/**
 * 读当前所有媒体会话。读不到返回 `{ok:false, error}` —— 上层据此说"读不到进度"，
 * 而不是假装知道用户在看到第几秒。
 */
export function probePlayback({ python = probePython(), timeoutMs = 8000 } = {}) {
  if (!python) return Promise.resolve({ ok: false, error: 'no-python-with-winrt' });
  return new Promise((resolve) => {
    execFile(python, [join(HERE, 'watch_smtc.py')], { timeout: timeoutMs, maxBuffer: 1 << 20 },
      (err, stdout) => {
        if (err) return resolve({ ok: false, error: String(err.message).slice(0, 160) });
        try {
          const parsed = JSON.parse(String(stdout ?? '').trim() || '{}');
          return resolve(parsed?.ok ? parsed : { ok: false, error: parsed?.error ?? 'bad-output' });
        } catch {
          return resolve({ ok: false, error: 'unparsable' });
        }
      });
  });
}

/** 只在播放/暂停中的会话里挑（4 = paused，5 = playing） */
export function pickSession(sessions, { title = null, duration = null, input = null } = {}) {
  const live = (sessions ?? []).filter((s) => s.status === 4 || s.status === 5);
  if (live.length === 0) return null;
  if (live.length === 1) return live[0];

  const stem = String(input ?? '').replace(/\.[^.]+$/, '').split(/[\\/]/).pop() ?? '';
  const score = (s) => {
    let n = 0;
    const t = String(s.title ?? '');
    if (title && t && (t.includes(title.slice(0, 8)) || title.includes(t.slice(0, 8)))) n += 3;
    if (stem && t && t.toLowerCase().includes(stem.toLowerCase().slice(0, 8))) n += 3;
    if (duration && Number.isFinite(s.dur) && Math.abs(s.dur - duration) <= 3) n += 2;
    return n;
  };
  const ranked = live.map((s) => ({ s, n: score(s) })).sort((a, b) => b.n - a.n);
  return ranked[0].n > 0 ? ranked[0].s : live[0];
}

/* ------------------------------------------------------------ 段与状态 */

export const segmentStart = (cursor, size = WATCH_SEGMENT) => Math.floor(Math.max(0, cursor) / size) * size;

/**
 * 一个"陪看会话"的状态。存盘是为了宿主重启后接着看，不必重头。
 * 只记**指针**，不记内容：内容和图都在分镜缓存里，重复算一遍也就 8 s。
 */
export function watchPath(env = process.env) {
  return join(cacheDir(env), 'watch.json');
}

export async function loadWatch(env = process.env) {
  try {
    return JSON.parse(await readFile(watchPath(env), 'utf8'));
  } catch {
    return {};
  }
}

export async function saveWatch(state, env = process.env) {
  try {
    await mkdir(cacheDir(env), { recursive: true });
    await writeFile(watchPath(env), JSON.stringify(state), 'utf8');
  } catch { /* 存不下就算了，最多重启后重算一段 */ }
}

export function sessionKey(input) {
  return norm(input);
}

/**
 * 这一段该不该说话了。
 *
 * 交付点刻意放在**段末前 lead 秒**，不是段末：
 * 用户正看着的时候插一句"这段快完了"，比卡在切换点更自然。
 */
export function deliveryState({ cursor, segment, size = WATCH_SEGMENT, lead = WATCH_LEAD }) {
  const end = segment + size;
  const remaining = end - cursor;
  return {
    segmentEnd: end,
    remaining: +remaining.toFixed(1),
    due: remaining <= lead,
    // 已经越界（用户看到下一段去了）也算该说，否则这段永远不会交付
    overdue: remaining <= 0,
  };
}
