/**
 * watch-modes.js — `video_watch` 的三种**替代入口**（都会先阻塞、再返回）。
 *
 * 从 watch-run.js 拆出来的 0.4 / 0.5 两步。它们和"交付一段"是并列关系，
 * 不是流程的一部分：命中就直接返回，后面的取图逻辑一行都不跑。
 *
 *   waitUntil     等到播放进度到某个秒数（下一段之前核对时间）
 *   waitForRefill 等到台词库存低于 refillBelow 段（知道"该看下一段了"）
 *   nextLine      一次只给一句台词，阻塞到该说这句的时刻
 *
 * 三者的共同点：**用条件阻塞，而不是定时器**。返回 null 表示"这一轮不是这几种模式"。
 */

import { consumeLine, dueLine, hasLine, loadWatch, saveWatch, sessionKey } from './watch.js';
import { mmss } from './time.js';
import { readPositionOrNull } from './watch-browser.js';

export async function runWatchMode({ args, input, plan, browserPort, readBrowser }) {
  // ---- 0.4 两种"阻塞到条件成立"的等待（模型侧的节奏由它自己掌握）
  //
  // 用户描述的模型循环：
  //   看视频 → 写台词 → （可选）阻塞到某个时间点核对进度 → 阻塞到"上一段余量用完" → 再看视频 …
  //
  // 这两种等待都不是定时器，而是**条件**：
  //   waitUntil    : 等到播放进度到某个秒数（用来在下一段之前核对时间）
  //   waitForRefill: 等到台词库存低于 refillBelow 段（用来知道"该看下一段了"）
  if (args.waitUntil !== undefined || args.waitForRefill === true) {
    const capSec = Math.min(900, Math.max(5, Number(args.maxWaitSec) || 300));
    const deadline = Date.now() + capSec * 1000;
    const below = Math.max(1, Number(args.refillBelow) || 2);
    let last = null;
    while (Date.now() < deadline) {
      const b = await readPositionOrNull(readBrowser, browserPort);
      last = b?.pos ?? null;
      if (b?.ended) break;
      if (b?.paused) break;

      if (args.waitForRefill === true && last !== null) {
        const idx = plan.indexAt(last);
        let stocked = 0;
        for (let i = idx + 1; i <= idx + below; i += 1) {
          const seg = plan.from(i, 1)[0];
          if (!seg) break;
          if (await hasLine(input, seg.from).catch(() => false)) stocked += 1;
        }
        if (stocked < below) {
          const missing = plan.from(idx + 1, below).filter((x) => x);
          return {
            ok: true, reason: 'refill-needed', at: last,
            text: `库存不足（现在 ${mmss(last)}）：${missing.map((m) => `${mmss(m.from)}–${mmss(m.to)}`).join('、')}`
              + '\n去看画面，用 lines: [...] 补上。',
            images: [],
          };
        }
      }

      if (Number.isFinite(Number(args.waitUntil)) && last !== null && last >= Number(args.waitUntil)) {
        return {
          ok: true, reason: 'reached', at: last,
          text: `到 ${mmss(last)} 了（目标 ${mmss(Number(args.waitUntil))}）。`,
          images: [],
        };
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    return {
      ok: true, reason: 'wait-timeout', at: last,
      text: `等到封顶（${capSec}s）也没等到条件成立，现在 ${last !== null ? mmss(last) : '读不到位置'}。`,
      images: [],
    };
  }

  // ---- 0.5 逐句模式（nextLine）
  // 一次调用只返回**一句**台词，并且阻塞到该说这句的时刻。
  // 这样每次工具返回 = 一条真实消息，会话里能看见"它到点说了一句"，
  // 而不是一口气把六句打印出来（那是脚本，不像陪看）。
  if (args.nextLine === true) {
    const everySec = Math.min(300, Math.max(3, Number(args.everySec) || 10));
    const st = await loadWatch();
    const key = sessionKey(input);
    const lastAt = Number(st[key]?.lastLineAt) || 0;
    const due = lastAt + everySec * 1000;
    let waited = 0;
    // 阻塞到点；中途暂停/视频结束就提前返回，让模型能说话
    while (Date.now() < due) {
      await new Promise((r) => setTimeout(r, 1000));
      waited += 1;
      const b = await readPositionOrNull(readBrowser, browserPort);
      if (b?.paused) break;
      if (b?.ended) break;
      if (waited > 600) break;
    }
    const b = await readPositionOrNull(readBrowser, browserPort);
    const pos = b?.pos ?? null;
    const plan2 = plan;
    const seg = pos !== null ? plan2.segmentAt(pos) : { from: 0, to: 0 };
    // 先问"到点了没有"：带 at 的台词只在它的时刻之后才发，否则同样的词会在段首提前跑出来。
    // **这里不做迟到作废**（lateSec: Infinity）：逐句模式下是模型主动来要下一句，
    // 位置停着不动也该把欠着的那句给它，而不是因为"晚了 30 秒"就丢掉。
    const line = (Number.isFinite(pos)
      ? await dueLine(input, pos, { size: seg.size ?? 0, lateSec: Infinity }).catch(() => null)
      : null)
      ?? await consumeLine(input, seg.from).catch(() => null);

    // **必须重新读一次状态再写**：consumeLine 内部已经保存过（把队列推进了一格），
    // 如果拿上面那份旧 st 覆盖回去，队列会退回原样 —— 表现就是同一句被反复返回。
    const st2 = await loadWatch();
    st2[key] = { ...(st2[key] ?? {}), lastLineAt: Date.now(), at: Date.now() };
    await saveWatch(st2).catch(() => {});

    if (!line) {
      return {
        ok: true,
        speaking: false,
        reason: 'no-line',
        text: `[${pos !== null ? mmss(pos) : '??:??'}] （这一段没有预设台词了）`
          + '\nLook at the picture with speakNow: true and say one sentence of your own, '
          + 'or write the next lines with lines: [...]',
        images: [],
      };
    }
    return {
      ok: true,
      speaking: true,
      at: pos,
      text: `[${pos !== null ? mmss(pos) : '??:??'}] ${line}`,
      images: [],
    };
  }

  return null;
}
