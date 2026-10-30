/**
 * time.js — 秒数怎么写成 mm:ss，只有一份实现。
 *
 * 以前有两份，而且**近边界时写出来不一样**：
 *   watch-run  : round(sec) 再取余 → 59.6 秒写成 "01:00"
 *   watch-loop : floor(分) + round(秒) → 59.6 秒写成 "00:60"（不存在的时刻）
 * 同一件事写两遍，就会长出两种答案。统一成"先四舍五入到整秒，再拆分"。
 */

/** 秒 → "mm:ss"（负数当 0；分钟不封顶，两小时的片子会写成 "128:07"） */
export function mmss(sec) {
  const total = Math.max(0, Math.round(Number(sec) || 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
