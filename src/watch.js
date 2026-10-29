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
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cacheDir } from './cache.js';
import { findPython } from './python.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 默认一段多长（秒）。120 s：60 分钟片 = 30 段，成本与连贯性的折中。 */
export const WATCH_SEGMENT = 120;
/** 提前多少秒交付：用户还在看，但这段快到尾巴了，此刻插话不打断。 */
export const WATCH_LEAD = 15;

const norm = (p) => String(p ?? '').replace(/\\/g, '/').toLowerCase();

/* ------------------------------------------------------------ 播放进度 */

/**
 * 找一台能 `import winrt` 的 python（读系统媒体控件要用）。
 * 早期版本硬编码了开发机的 .venv —— 别人装上会永远读不到进度，所以统一走候选链 + 实际验证。
 */
export async function probePython({ config = {}, env = process.env } = {}) {
  return findPython('winrt.windows.media.control', { config, env });
}

/**
 * 读当前所有媒体会话。读不到返回 `{ok:false, error}` —— 上层据此说"读不到进度"，
 * 而不是假装知道用户在看到第几秒。
 */
let probeCache = { at: 0, value: null };

/**
 * 同一秒内重复探测没有意义（位置一直在动，但 1.5 秒内差不了多少），
 * 而每次探测要起一个 python 进程（≈1 s）。缓存一下，一轮唤醒只付一次。
 */
export async function probePlayback({
  python, timeoutMs = 8000, config = {}, env = process.env, maxAgeMs = 1500,
} = {}) {
  if (!python && probeCache.value && Date.now() - probeCache.at < maxAgeMs) return probeCache.value;
  const py = python ?? await probePython({ config, env });
  if (!py) return { ok: false, error: 'no-python-with-winrt (pip install winrt-runtime winrt-Windows.Media.Control winrt-Windows.Foundation)' };
  return new Promise((resolve) => {
    // windowsHide：不然每探一次进度就闪一个黑框。读取进度是高频动作，弹窗必须关掉。
    // PYTHONIOENCODING/PYTHONUTF8：双保险，防止某些 python 发行版忽略 reconfigure。
    execFile(py, [join(HERE, 'watch_smtc.py')], {
      timeout: timeoutMs,
      maxBuffer: 1 << 20,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    },
      (err, stdout) => {
        if (err) return resolve({ ok: false, error: String(err.message).slice(0, 160) });
        try {
          const parsed = JSON.parse(String(stdout ?? '').trim() || '{}');
          const value = parsed?.ok ? parsed : { ok: false, error: parsed?.error ?? 'bad-output' };
          probeCache = { at: Date.now(), value };
          return resolve(value);
        } catch {
          return resolve({ ok: false, error: 'unparsable' });
        }
      });
  });
}

/**
 * SMTC 的播放状态枚举（`GlobalSystemMediaTransportControlsSessionPlaybackStatus`）：
 *   0 Closed · 1 Opened · 2 Changing · 3 Stopped · **4 Playing · 5 Paused**
 *
 * 我一开始把它写反了（以为 4=暂停），于是「正在播」被报成「暂停」——
 * 用户当场发现："我一直在播放啊"。**枚举值要按官方定义，不能凭印象。**
 */
export const PLAYBACK = { CLOSED: 0, OPENED: 1, CHANGING: 2, STOPPED: 3, PLAYING: 4, PAUSED: 5 };

export function describeStatus(code) {
  if (code === PLAYBACK.PLAYING) return 'playing';
  if (code === PLAYBACK.PAUSED) return 'paused';
  if (code === PLAYBACK.STOPPED) return 'stopped';
  if (code === PLAYBACK.CLOSED) return 'closed';
  return `status-${code}`;
}

/** 只在播放/暂停中的会话里挑 */
export function pickSession(sessions, { title = null, duration = null, input = null } = {}) {
  const live = (sessions ?? []).filter((s) => s.status === PLAYBACK.PLAYING || s.status === PLAYBACK.PAUSED);
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
    // 只留最近 20 个源：不然看几十部片子之后这个文件会无限长
    const keys = Object.keys(state).sort((a, b) => (state[b]?.at ?? 0) - (state[a]?.at ?? 0));
    const pruned = {};
    for (const k of keys.slice(0, 20)) pruned[k] = state[k];
    await mkdir(cacheDir(env), { recursive: true });
    await writeFile(watchPath(env), JSON.stringify(pruned), 'utf8');
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

/* ------------------------------------------------------------ 预设台词 */

/**
 * 预设台词：agent 提前写好"这一段该说的一句"，到点直接念，不用现场想。
 *
 * 为什么存在：预取解决了"建图的十秒"，但"想说什么"还要模型跑一轮（2–4 秒）。
 * 提前写好就没有这一段延迟，而且**窗口只有 5 分钟**——中途不看了最多白写 2–3 段。
 */
export async function saveLines(input, lines, { env = process.env } = {}) {
  if (!Array.isArray(lines) || lines.length === 0) return 0;
  const st = await loadWatch(env);
  const sk = sessionKey(input);
  const prev = st[sk]?.lines ?? {};

  // 同一次调用里，同一个 from 出现多次 = 这一段要连说几句（按给定顺序）；
  // 只出现一次 = 覆盖这一段原有的稿子（改了主意不该留下旧句）。
  const grouped = new Map();
  for (const l of lines) {
    const from = Number(l?.from);
    const text = String(l?.text ?? '').trim();
    if (!Number.isFinite(from) || !text) continue;
    if (!grouped.has(from)) grouped.set(from, []);
    grouped.get(from).push(text.slice(0, 300));
  }

  let n = 0;
  for (const [from, texts] of grouped) {
    prev[from] = texts.length > 1
      ? { queue: texts, at: Date.now() }
      : { text: texts[0], at: Date.now() };
    n += texts.length;
  }
  st[sk] = { ...(st[sk] ?? {}), lines: prev, at: Date.now() };
  await saveWatch(st, env);
  return n;
}

/** 取某一段的预设台词（没有就 null） */
export async function loadLine(input, from, { env = process.env } = {}) {
  const st = await loadWatch(env);
  const hit = st[sessionKey(input)]?.lines?.[Number(from)];
  return hit?.text ?? null;
}

/**
 * 念完就删。
 *
 * 为什么必须删：用户倒回去重看时，如果这句还留着，会被**一模一样地再说一遍** —— 太假了。
 * 删掉之后同一段再遇到，会退回"到点再看一眼图"，说出来的话至少是新的。
 */
export async function consumeLine(input, from, { env = process.env } = {}) {
  const st = await loadWatch(env);
  const sk = sessionKey(input);
  const lines = st[sk]?.lines;
  if (!lines || !lines[Number(from)]) return null;
  const slot = lines[Number(from)];
  let text = null;
  if (Array.isArray(slot.queue) && slot.queue.length > 0) {
    // 队列里有就取第一条，取完还有就留着，取完最后一条才删
    text = slot.queue[0];
    if (slot.queue.length > 1) {
      lines[Number(from)] = { queue: slot.queue.slice(1), at: Date.now() };
    } else {
      delete lines[Number(from)];
    }
  } else {
    text = slot.text ?? null;
    delete lines[Number(from)];
  }
  st[sk] = { ...(st[sk] ?? {}), lines, at: Date.now() };
  await saveWatch(st, env);
  return text;
}

/** 这一段还有没有台词（给"余量不足就叫醒模型"用） */
export async function hasLine(input, from, { env = process.env } = {}) {
  const st = await loadWatch(env);
  const slot = st[sessionKey(input)]?.lines?.[Number(from)];
  if (!slot) return false;
  if (Array.isArray(slot.queue)) return slot.queue.length > 0;
  return Boolean(slot.text);
}

/** 库存概览：已经写好台词的段有哪些（诊断用） */
export async function linesOverview(input, { env = process.env } = {}) {
  const st = await loadWatch(env);
  const lines = st[sessionKey(input)]?.lines ?? {};
  return Object.entries(lines).map(([from, slot]) => ({
    from: Number(from),
    count: Array.isArray(slot.queue) ? slot.queue.length : (slot.text ? 1 : 0),
  })).filter((x) => x.count > 0).sort((a, b) => a.from - b.from);
}
