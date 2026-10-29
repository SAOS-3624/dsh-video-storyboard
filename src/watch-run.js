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
  deliveryState, loadWatch, pickSession, probePlayback, saveWatch, segmentStart, sessionKey,
  WATCH_LEAD, WATCH_SEGMENT,
} from './watch.js';

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
  } = deps;
  const size = Number(args.segment) > 0 ? Number(args.segment) : WATCH_SEGMENT;
  const lead = args.lead !== undefined ? Number(args.lead) : WATCH_LEAD;

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
  if (!Number.isFinite(cursor)) {
    const probe = await probePlayback();
    const pick = probe.ok ? pickSession(probe.sessions, { input: args.input, title: args.title ?? null }) : null;
    if (!pick) {
      return {
        ok: false,
        text: `cannot read your playback position (${probe.error ?? 'no active media session'}).\n`
          + 'Tell me how far you are (e.g. "我看到 12:30 了") and call again with cursor: 750. '
          + 'I will not guess — a wrong cursor makes every later segment wrong too.',
        images: [],
      };
    }
    cursor = pick.pos;
    note = ` (${pick.app}, ${pick.status === 5 ? 'playing' : 'paused'})`;
  }

  const segStart = segmentStart(cursor, size);
  const d = deliveryState({ cursor, segment: segStart, size, lead });
  const key = `${sessionKey(args.input)}|${segStart}`;

  // ---- 2. 预取这一段
  let entry = cache.get(key);
  let builtMs = 0;
  if (!entry?.png) {
    const t0 = Date.now();
    const r = await runStoryboard({
      input: args.input,
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

  const head = `watch ${mmss(cursor)}${note} · segment ${mmss(segStart)}–${mmss(segStart + size)}`
    + ` · ${Math.max(0, d.remaining)}s left`
    + (builtMs ? ` · built in ${(builtMs / 1000).toFixed(1)}s` : ' · ready');

  // ---- 3. 还没到交付点：保持安静
  if (!d.due) {
    return {
      ok: true,
      speaking: false,
      text: `${head}\nnot yet — keep watching. I will speak near ${mmss(segStart + size - lead)}.`,
      images: [],
    };
  }

  // ---- 4. 到点：交付（同一段不重复说）
  const st = await loadWatch();
  const sk = sessionKey(args.input);
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
    cursor,
    segment: segStart,
    text: `${head}\n${guidance}\n\n${entry.manifest}`,
    images,
  };
}
