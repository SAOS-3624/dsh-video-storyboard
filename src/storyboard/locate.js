/**
 * locate.js — 把"那句话在第几分钟"变成一次文本查询。
 *
 * 为什么需要：模型想知道一句台词的位置时，现在只有两条路 —— 通读清单（贵、且清单有分页），
 * 或者整段 zoom 再看一遍（384 token）。而这句话其实**已经在转写结果里了**，本来就该零成本。
 *
 * 这里只做匹配，不碰 ffmpeg、不出图。返回的时间段可以直接喂给 video_zoom。
 */

/** 归一化：去标点空白、转小写。中文按字比，英文按词比，两种都能用 */
const norm = (s) => String(s ?? '')
  .toLowerCase()
  .replace(/[\s\u3000]+/g, '')
  .replace(/[，。！？、；：""''（）《》…—,.!?;:"'()<>[\]{}~`]/g, '');

/** 最长公共子串长度（归一化后按字符） */
function lcsLength(a, b) {
  if (!a || !b) return 0;
  const m = a.length;
  const n = b.length;
  let prev = new Uint16Array(n + 1);
  let cur = new Uint16Array(n + 1);
  let best = 0;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : 0;
      if (cur[j] > best) best = cur[j];
    }
    const tmp = prev; prev = cur; cur = tmp;
    cur.fill(0);
  }
  return best;
}

/**
 * 在一组带时间码的片段里找最像 query 的几段。
 *
 * 打分 = 最长公共子串 / query 长度；完全包含再加一档，避免"包含查询词的短句"输给"更长的相似句"。
 *
 * @param {Array<{from:number,to:number,text:string}>} segments
 * @param {string} query
 * @param {{max?:number, minScore?:number}} opts
 */
export function matchSegments(segments, query, { max = 5, minScore = 0.34 } = {}) {
  const q = norm(query);
  if (!q || !Array.isArray(segments) || segments.length === 0) return [];
  const scored = [];
  for (const seg of segments) {
    const t = norm(seg.text);
    if (!t) continue;
    const lcs = lcsLength(t, q);
    const score = lcs / q.length;
    const exact = t.includes(q) ? 0.25 : 0;
    const total = Math.min(1, score + exact);
    if (total >= minScore) {
      scored.push({
        from: +Number(seg.from).toFixed(2),
        to: +Number(seg.to).toFixed(2),
        text: String(seg.text).trim(),
        score: +total.toFixed(2),
      });
    }
  }
  // 同分时**短句优先**：查询"记忆管理局"时，"记忆管理局"（整句就是它）比
  // "记忆管理局的人来了"（只是包含）更可能是用户想找的那一句。
  return scored
    .sort((a, b) => b.score - a.score || a.text.length - b.text.length || a.from - b.from)
    .slice(0, max);
}

/* ---------------------------------------------------------------- 转写缓存 */

/** 同进程内按路径缓存最近一次的转写 —— storyboard 之后紧接着 locate 是最常见的顺序 */
const recent = new Map();
const MAX_ENTRIES = 4;

export function rememberSegments(path, segments) {
  if (!path || !Array.isArray(segments) || segments.length === 0) return;
  recent.delete(path);
  recent.set(path, segments);
  while (recent.size > MAX_ENTRIES) recent.delete(recent.keys().next().value);
}

export function recallSegments(path) {
  return recent.get(path) ?? null;
}

export function forgetSegments() {
  recent.clear();
}

/**
 * 把匹配结果格式化成一段给模型看的文字。
 * 刻意**不写**"应该是第 3 分钟"这种结论 —— 只给时间码和原文，判断留给模型。
 */
export function formatMatches(query, matches, { total = 0 } = {}) {
  if (matches.length === 0) {
    return `no line matched "${query}"` + (total ? ` among ${total} transcript segments` : '') +
      '. Try shorter keywords, or a phrase that appears verbatim.';
  }
  const lines = matches.map((m) => `  ${tc(m.from)}-${tc(m.to)}  (${m.score.toFixed(2)})  "${m.text}"`);
  return [
    `matches for "${query}" (${matches.length} of ${total} segments):`,
    ...lines,
    'Feed any of these windows to video_zoom({ from, to }) — no need to re-read the whole film.',
  ].join('\n');
}

const tc = (t) => {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
};
