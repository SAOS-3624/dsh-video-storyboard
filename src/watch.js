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
import { recallSegments } from './locate.js';
import { makeLagFn } from './speech.js';

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
 * 把槽位规范成 `[{ text, at }]`。兼容三种历史写法：
 *   字符串队列（最早的格式） / 单句 `{ text }` / 带 `at` 的队列。
 *
 * 注意：只认**队列项**上的 `at`（= 该念的时刻）。槽位上那个 `at` 是"什么时候写的"，
 * 拿它当念的时刻，整句会被推到几百年后。
 */
function slotItems(slot) {
  if (!slot) return [];
  const raw = Array.isArray(slot.queue) ? slot.queue : (slot.text ? [{ text: slot.text }] : []);
  return raw
    .map((it) => (typeof it === 'string'
      ? { text: it, at: null }
      : { text: String(it?.text ?? ''), at: Number.isFinite(it?.at) ? Number(it.at) : null }))
    .filter((x) => x.text);
}

const writeSlot = (lines, from, items) => {
  if (items.length > 0) lines[from] = { queue: items, savedAt: Date.now() };
  else delete lines[from];
};

/**
 * 预设台词：agent 提前写好，到点直接念，不用现场想。
 *
 * 每条可以带 `at`（绝对秒，位置轴上的时刻）：**到那个位置就念**，不由桶边界决定，
 * 也不由墙钟决定。不带 `at` 就按原来的口径——进入这一段时念。
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
    // `at` 除了秒数，还可以直接传**字幕原文片段**，这里去转写里查它的 from。
    // 为什么必须有这条路：模型凭印象写秒数会整段错 —— 实测把"1/4 螺口"挂在 189 秒，
    // 而字幕里它在 247 秒，提前了 58 秒，用户当场发现"台词对不上视频"。
    let at = Number(l?.at);
    if (typeof l?.at === 'string' && l.at.trim()) {
      const segs = recallSegments(input) ?? [];
      const q = l.at.trim();
      const hit = segs.find((x) => String(x.text ?? '').includes(q));
      at = hit ? Number(hit.from) : NaN;
      if (!hit) {
        // 查不到就明确说出来，别悄悄当成"没写 at"（那会让它落在段首，更错）
        console.warn(`[watch] line anchor not found in transcript: ${q}`);
      }
    }
    grouped.get(from).push({
      text: text.slice(0, 300),
      ...(Number.isFinite(at) ? { at } : {}),
    });
  }

  let n = 0;
  for (const [from, items] of grouped) {
    // **带 at 的按时刻合并**，不覆盖同段其它句子。
    // 以前这里是无条件覆盖，于是"后补一句收尾词"会把这一批已经写好的四句全冲掉 ——
    // 表现是台词凭空消失，而且没有任何提示。
    const withAt = items.filter((x) => x.at !== undefined);
    if (withAt.length > 0) {
      const merged = new Map();
      for (const it of slotItems(prev[from])) merged.set(it.at ?? null, it);
      for (const it of items) merged.set(it.at ?? null, it);   // 同一个 at = 改词
      const list = [...merged.values()].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
      writeSlot(prev, from, list);
    } else {
      // 老口径（不带 at）：这一段只有一句 / 一组，整段覆盖
      prev[from] = { queue: items, savedAt: Date.now() };
    }
    n += items.length;
  }
  st[sk] = { ...(st[sk] ?? {}), lines: prev, at: Date.now() };
  await saveWatch(st, env);
  return n;
}

/** 取某一段的预设台词（没有就 null） */
export async function loadLine(input, from, { env = process.env } = {}) {
  const st = await loadWatch(env);
  const hit = st[sessionKey(input)]?.lines?.[Number(from)];
  return slotItems(hit)[0]?.text ?? null;
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
  if (!lines) return null;
  const key = Number(from);
  const items = slotItems(lines[key]);
  if (items.length === 0) return null;
  const [hit, ...rest] = items;
  writeSlot(lines, key, rest);
  st[sk] = { ...(st[sk] ?? {}), lines, at: Date.now() };
  await saveWatch(st, env);
  return hit.text;
}

/**
 * **到点的那一句**：在所有已写好的台词里，找 `at` 最小且已经到点的那一条，念掉它。
 *
 * 为什么需要它：剧本是按"段"写的，但说话的时刻是**位置**上的一个点。
 * 拿段边界当触发点，一段里写四句就会在段首连着说完、然后整整一分钟没词 ——
 * 听起来就是"比我看到的快很多"（实测日志：02:26 / 02:38 / 02:50 … 每 12 秒一句，
 * 而画面是一分钟才跨一个内容段）。
 *
 * 这里按 `at` 触发：位置到哪，就说到哪。暂停时位置不动，也就不会继续说。
 * 不带 `at` 的老台词按"进入这一段"处理，并在段内均匀铺开（每条占 1/k 段）。
 * 迟到超过 `lateSec`（默认 3 秒）的词直接作废：位置跳过去了，那句描述的画面已经不在。
 * 只认"两个时间大致相等"——早一点不发，晚太多也不要。
 *
 * @param {number} pos  当前播放位置（秒）
 * @param {{ size?: number, lateSec?: number }} [o] 当前段长（给没写 at 的台词分位）、迟到宽限
 */
export async function dueLine(input, pos, { size = 0, lateSec = 3, env = process.env } = {}) {
  const now = Number(pos);
  if (!Number.isFinite(now)) return null;
  const st = await loadWatch(env);
  const sk = sessionKey(input);
  const lines = st[sk]?.lines;
  if (!lines) return null;

  // 台词要往后挪多久：`at` 对齐的是"这句话开始说的时刻"，直接开口会跟原声抢话。
  // 字幕在 locate 的记忆层里（跑分镜时顺手记下的），拿不到就退化成不延迟。
  const lagOf = makeLagFn(recallSegments(input) ?? []);
  // 真正可以开口的时刻。没写 at 的老台词不参与（它们按"进入这一段"处理）。
  const dueAt = (at) => (at === null || !Number.isFinite(Number(at)) ? -Infinity : Number(at) + lagOf(at));

  let best = null;
  let dirty = false;
  for (const [key, slot] of Object.entries(lines)) {
    const from = Number(key);
    // 未来段落的词不参与：写 360s 的词不该在 150s 就被念出来
    if (!(from <= now)) continue;
    let items = slotItems(slot);
    // **把"没写 at"的台词当场钉死**：一旦有了段长，就把它们均匀铺进这一段并存回去。
    // 不能每次读都现算：念掉一条之后队列长度变了，后面几条的时刻会跟着往前跳
    // （实测：四句 60 秒的稿子，念掉第一句后第二句的时刻从 135 变成 120，于是连珠炮）。
    if (size > 0 && items.some((x) => x.at === null)) {
      const n = items.length;
      items = items.map((x, i) => (x.at === null ? { ...x, at: from + (i * size) / n } : x));
      dirty = true;
    }
    // **迟到就作废**：位置跳过去了（拖进度条 / 快进），那句描述的画面已经不在银幕上，
    // 补念出来只会和画面对不上。停顿几秒内的正常延迟仍然会念。
    // 判断用"该开口的时刻"（at + 后延），否则加了延以后正常的一句也会被当成迟到删掉。
    const kept = items.filter((x) => !(dueAt(x.at) < now - lateSec));
    if (kept.length !== items.length) {
      items = kept;
      dirty = true;
    }
    if (dirty) writeSlot(lines, from, items);
    items.forEach((item, i) => {
      if (dueAt(item.at) > now) return;
      if (!best || item.at < best.at) best = { from, index: i, at: item.at, text: item.text };
    });
  }
  if (!best) {
    if (dirty) {
      st[sk] = { ...(st[sk] ?? {}), lines, at: Date.now() };
      await saveWatch(st, env);
    }
    return null;
  }

  const items = slotItems(lines[best.from]);
  writeSlot(lines, best.from, items.slice(0, best.index).concat(items.slice(best.index + 1)));
  st[sk] = { ...(st[sk] ?? {}), lines, at: Date.now() };
  await saveWatch(st, env);
  return best.text;
}

/** 这一段还有没有台词（给"余量不足就叫醒模型"用） */
export async function hasLine(input, from, { env = process.env } = {}) {
  const st = await loadWatch(env);
  return slotItems(st[sessionKey(input)]?.lines?.[Number(from)]).length > 0;
}

/** 库存概览：已经写好台词的段有哪些（诊断用） */
export async function linesOverview(input, { env = process.env } = {}) {
  const st = await loadWatch(env);
  const lines = st[sessionKey(input)]?.lines ?? {};
  return Object.entries(lines)
    .map(([from, slot]) => {
      const items = slotItems(slot);
      return { from: Number(from), count: items.length, ats: items.map((x) => x.at).filter((x) => x !== null) };
    })
    .filter((x) => x.count > 0)
    .sort((a, b) => a.from - b.from);
}
