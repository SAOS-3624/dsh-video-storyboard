/**
 * watch-run.js — `video_watch` 的一次调用（不含宿主胶水，便于直接测）。
 *
 * 一次调用的全部逻辑：
 *   1. 拿到用户的播放位置（宿主给 / 从系统媒体控件读）
 *   2. 算出所在段，**先把这一段算出来**（用户的播放时间就是我们的计算时间）
 *   3. 还没到交付点 → 只回一行状态（几乎不花 token）
 *      到了交付点 → 回这一段的格子图 + 清单 + 陪看行为约束
 *
 * 关键取舍：交付点定在**段末前 lead 秒**，不是段末。用户正看着的时候插一句"这段快完了"，
 * 比卡在两段交界处更自然，也不打断。
 */

import {
  deliveryState, describeStatus, loadWatch, pickSession, probePlayback, saveWatch, segmentStart,
  sessionKey, WATCH_LEAD, WATCH_SEGMENT,
} from './watch.js';
import { describeLatency, recordLatency } from './latency.js';
import { estimate, makeAnchor } from './position.js';
import { resolvePlayingSource } from './resolve-playing.js';

// 模块级：latencyNote() 需要知道"这一轮从什么时候开始"
let tStartForNote = Date.now();

async function latencyNote() {
  const st = await recordLatency(Date.now() - tStartForNote);
  // 标定完成后就不再占 token 了
  return st.samples > 3 ? '' : `\n${describeLatency(st)}`;
}

const mmss = (sec) => {
  const s = Math.max(0, Math.round(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * @param {object} args  工具参数
 * @param {object} deps  { saveImage, resolveInput, runStoryboard, formatManifest, cache }
 */
export async function runWatchPass(args, deps) {
  const {
    saveImage, runStoryboard, formatManifest, cache = new Map(),
    probe = probePlayback,
  } = deps;
  // 从"开始读进度"到"结果返回"的耗时 —— 这就是本机延迟的实测值，用来做提前量标定
  const tStart = Date.now();
  tStartForNote = tStart;
  const size = Number(args.segment) > 0 ? Number(args.segment) : WATCH_SEGMENT;
  const lead = args.lead !== undefined ? Number(args.lead) : WATCH_LEAD;

  // ---- 0. 源：没给 input 就自己从"系统里在播什么"反推
  // 用户只会说"我在看这个"，不会报路径。SMTC 给标题和时长，够我们去找。
  let input = args.input;
  let resolved = null;
  let activeSession = null;
  const stateEarly = await loadWatch();
  const titleKey = (t) => String(t ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '').slice(0, 40);
  if (!input) {
    const p0 = await probe();
    activeSession = p0.ok ? pickSession(p0.sessions, {}) : null;
    if (!activeSession?.title) {
      return {
        ok: false,
        text: `no video is playing right now (${p0.error ?? 'no active media session'}).\n`
          + 'Play something, or pass input yourself (path or link).',
        images: [],
      };
    }
    // 记住上一次为这个标题找到的源：搜索接口会限流，重复搜没意义，也慢（11 秒）。
    const cachedInput = stateEarly.sources?.[titleKey(activeSession.title)];
    if (cachedInput) {
      input = cachedInput;
      resolved = { input: cachedInput, matchedBy: 'remembered' };
    } else {
      resolved = await resolvePlayingSource({ title: activeSession.title, duration: activeSession.dur });
      if (resolved) {
        stateEarly.sources = {
          ...(stateEarly.sources ?? {}),
          [titleKey(activeSession.title)]: resolved.input,
        };
        await saveWatch(stateEarly);
      }
    }
    if (!resolved) {
      return {
        ok: false,
        text: `you are watching "${activeSession.title}" (${Math.round(activeSession.dur)}s), but I could not`
          + ' find the source: no local file with that name, and the Bilibili search did not turn up a match'
          + ' with the same duration.\nSend me the link or the file path once — I will remember it for this'
          + ' title and stop asking.',
        images: [],
      };
    }
    input = resolved.input;
  }

  // ---- 1. 播放位置
  // 用户很可能直接说"12:30"，数字里带冒号解析成 NaN 就白跑一次探测，这里先认一下
  const parseCursor = (v) => {
    if (typeof v === 'number') return v;
    if (typeof v !== 'string') return NaN;
    const m = v.trim().match(/^(\d+):(\d{1,2}(?:\.\d+)?)$/);
    if (m) return Number(m[1]) * 60 + Number(m[2]);
    return Number(v);
  };
  let cursor = parseCursor(args.cursor);
  let note = '';
  let confidence = Number.isFinite(cursor) ? 'given' : null;
  if (!Number.isFinite(cursor)) {
    const probeRes = await probe();
    const pick = probeRes.ok
      ? pickSession(probeRes.sessions, { input, title: args.title ?? activeSession?.title ?? null })
      : null;
    if (!pick) {
      return {
        ok: false,
        text: `cannot read your playback position (${probeRes.error ?? 'no active media session'}).\n`
          + 'Tell me how far you are (e.g. "我看到 12:30 了") and call again with cursor: 750. '
          + 'I will not guess — a wrong cursor makes every later segment wrong too.',
        images: [],
      };
    }
    // **不能把 SMTC 的冻结值当实时值**：Edge 只在起播/暂停/拖动时刷新，
    // 实测两次刷新隔过 143 秒。所以先问"这个值有多旧"，再决定信不信。
    const est = estimate(makeAnchor(pick, Date.now()));
    confidence = est.confidence;

    if (est.confidence === 'unknown') {
      return {
        ok: false,
        confidence,
        text: `your playback position is unreadable right now: SMTC last updated `
          + `${Math.round(est.staleMs / 1000)}s ago (${est.why}), so I cannot tell whether you are at `
          + `${mmss(pick.pos)} or further.\n`
          + 'Tell me where you are and pass cursor (e.g. cursor: 750 or "12:30"). '
          + 'I will not extrapolate that far — a wrong position makes every later segment wrong.',
        images: [],
      };
    }

    cursor = est.pos;
    note = ` (${pick.app}, ${describeStatus(pick.status)}`
      + `${est.confidence === 'extrapolated' ? `, measured ${Math.round(est.staleMs / 1000)}s ago` : ''})`;
  }

  const segStart = segmentStart(cursor, size);
  const d = deliveryState({ cursor, segment: segStart, size, lead });
  const key = `${sessionKey(input)}|${segStart}`;

  // ---- 2. 预取这一段
  let entry = cache.get(key);
  let builtMs = 0;
  if (!entry?.png) {
    const t0 = Date.now();
    const r = await runStoryboard({
      input,
      from: segStart,
      to: segStart + size,
      cells: Number(args.cells) > 0 ? Number(args.cells) : 5,
      sheets: 1,
      pick: 'sharp',
      burn: 'index',
      minGap: 0.5,
      // 爆点细扫**保留**（默认就是 true）。
      // 我一度把它关了"省时间"，但那是测错了：9.2s vs 5.0s 的差其实来自 ASR 冷启动，
      // 交替复跑（transcript off）两次都是 4.5–4.6s，几乎没差；而它多找到 3 刀（40 vs 37），
      // 直接影响快闪段落要不要摊成 2×2/3×3 —— 对音乐视频/动作片是实打实的画质。
      transcript: args.transcript ?? 'auto',
      // 陪看是持续调用：让本地 ASR 活过整段，别每段都冷启动一次（实测每段多 5 s）
      asrIdleMs: size * 1000 + 30_000,
      adaptive: false,
      cookies: args.cookies,
      allowAnonymous: args.allowAnonymous === true,
    });
    entry = {
      png: r.sheets?.[0]?.png ?? null,
      manifest: formatManifest(r, { maxChars: 2600, maxCellChars: 80 }),
      cells: r.sheets?.[0]?.cells?.length ?? 0,
    };
    cache.set(key, entry);
    // 每段一张 PNG，一部电影会有几十段。只留最近 8 段（前后各几段够回看），别把内存吃掉。
    while (cache.size > 8) cache.delete(cache.keys().next().value);
    builtMs = Date.now() - t0;
  }

  const measuredAt = new Date().toTimeString().slice(0, 8);
  const found = resolved ? ` · source: ${resolved.matchedBy} → ${String(input).split(/[\\/]/).pop()}` : '';
  // **进度必须带"什么时候测的"**：用户看到这句话时可能已经过了几分钟。
  // 之前只写 `watch 08:28`，用户五分钟后再看会以为算错了——那是我把"测量时刻"说成了"现在"。
  const head = `watch ${mmss(cursor)} @ ${measuredAt}${note}${found} `
    + `· segment ${mmss(segStart)}–${mmss(segStart + size)}`
    + ` · ${Math.max(0, d.remaining)}s left`
    + (builtMs ? ` · built in ${(builtMs / 1000).toFixed(1)}s` : ' · ready');

  // ---- 3. 还没到交付点：保持安静
  if (!d.due) {
    return {
      ok: true,
      speaking: false,
      confidence,
      status: note.includes('paused') ? 'paused' : 'playing',
      input,
      size,
      cursor,
      measuredAt,
      segment: segStart,
      text: `${head}\nnot yet — keep watching. I will speak near ${mmss(segStart + size - lead)}.`
        + await latencyNote(),
      images: [],
    };
  }

  // ---- 4. 到点：交付（同一段不重复说）
  const st = await loadWatch();
  const sk = sessionKey(input);
  // 旧格式是数组，新格式是 {segStart: 说得有多久了}。倒回去重看同一段时，
  // 隔了 10 分钟以上允许重说一次 —— 否则"我刚才没听清，再看一遍"就永远得不到回应。
  const rawSpoken = st[sk]?.spoken ?? {};
  const spoken = Array.isArray(rawSpoken)
    ? Object.fromEntries(rawSpoken.map((k) => [k, Date.now() - 11 * 60_000]))
    : rawSpoken;
  const REPEAT_AFTER_MS = 10 * 60_000;
  if (spoken[segStart] && Date.now() - spoken[segStart] < REPEAT_AFTER_MS) {
    return {
      ok: true,
      speaking: false,
      text: `${head}\nalready spoke for this segment — not repeating it.`,
      images: [],
    };
  }
  const nextSpoken = { ...spoken, [segStart]: Date.now() };
  // 只留最近 60 段，别让状态文件无限长
  const keptKeys = Object.keys(nextSpoken)
    .sort((a, b) => nextSpoken[b] - nextSpoken[a])
    .slice(0, 60);
  st[sk] = {
    ...(st[sk] ?? {}),
    spoken: Object.fromEntries(keptKeys.map((k) => [k, nextSpoken[k]])),
    at: Date.now(),
  };
  await saveWatch(st);

  const images = entry.png ? [await saveImage({ data: entry.png, name: `watch-${segStart}.png` })] : [];
  const guidance = [
    `[together-watch] The user just watched ${mmss(segStart)}–${mmss(segStart + size)} (now at ${mmss(cursor)}).`,
    'They watched it themselves — do NOT retell the plot.',
    'Default: one sentence about what changed or what is worth noticing, then stop.',
    'Say more only if they ask, or if something genuinely deserves one callout.',
    'If nothing is worth saying, say almost nothing.',
  ].join('\n');

  return {
    ok: true,
    speaking: true,
    confidence,
    status: note.includes('paused') ? 'paused' : 'playing',
    input,
    size,
    cursor,
    measuredAt,
    segment: segStart,
    text: `${head}\n${guidance}${await latencyNote()}\n\n${entry.manifest}`,
    images,
  };
}
