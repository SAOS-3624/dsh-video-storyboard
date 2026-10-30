/**
 * injection.js — flagging, not policing: external transcript text is data.
 *
 * A video description/subtitle/comment can contain sentences addressed to the
 * model ("stop the run", "do not call tools"). The plugin must still finish the
 * storyboard; this scanner only records high-confidence, instruction-shaped
 * snippets so the manifest can say "this was data, not a command".
 *
 * Deliberately conservative: ordinary speech is full of "停" and "不要", so the
 * patterns require an imperative + an agent/tool/output object. False negatives
 * are preferable to turning normal dialogue into a security alert.
 */

const MAX_QUOTE = 240;

export const INJECTION_PATTERNS = Object.freeze([
  {
    id: 'ignore-previous',
    re: /\b(ignore|disregard|forget)\b[^.\n]{0,40}\b(previous|prior|above)\b[^.\n]{0,22}\b(instructions?|rules?|prompts?)\b/i,
  },
  {
    id: 'system-prompt',
    re: /\b(system|developer)\s+(prompt|message|instructions?)\b/i,
  },
  {
    id: 'stop-the-agent',
    re: /(立即|马上|现在|务必|必须)[^。！？\n]{0,14}(停止|终止|中断|结束)[^。！？\n]{0,20}(本轮|当前|这一轮|对话|任务|搜索|检索|回复|输出|生成|调用|冲刷)/,
  },
  {
    id: 'forbid-tools',
    re: /(禁止|不准|不得|不要|别)[^。！？\n]{0,14}(继续|调用|使用|生成|回复|检索|搜索|输出)[^。！？\n]{0,20}(工具|回复|留言|评论|内容|搜索|检索|条目)/,
  },
  {
    id: 'stop-search',
    re: /(不要|别|禁止)[^。！？\n]{0,10}(再)?(检索|搜索|读取|返回|列出)[^。！？\n]{0,18}(评论|结果|条目|内容|帖子)/,
  },
  {
    id: 'prompt-markup',
    re: /<\/?(system|assistant|tool|instructions?)>|\[INST\]|<\|im_start\|>/i,
  },
]);

/**
 * @param {Array<{text?:string,from?:number,to?:number}>} segments
 * @param {{source?:string, max?:number}} [opts]
 * @returns {Array<{from:number|null,to:number|null,pattern:string,quote:string,source:string|null}>}
 */
export function findInjection(segments, { source = null, max = 5 } = {}) {
  const out = [];
  const seen = new Set();
  for (const seg of Array.isArray(segments) ? segments : []) {
    const text = String(seg?.text ?? '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const pattern = INJECTION_PATTERNS.find((p) => p.re.test(text));
    if (!pattern) continue;
    const quote = text.length > MAX_QUOTE ? `${text.slice(0, MAX_QUOTE)}…` : text;
    if (seen.has(quote)) continue;
    seen.add(quote);
    out.push({
      // 标题这类没有时间码的文本要留 null，不能被 Number(null)=0 变成"第 0 秒"
      from: toNumberOrNull(seg.from),
      to: toNumberOrNull(seg.to),
      pattern: pattern.id,
      quote,
      source,
    });
    if (out.length >= max) break;
  }
  return out;
}

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
