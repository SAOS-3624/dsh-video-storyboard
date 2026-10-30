/**
 * watch/handler.js — `video_watch` 的 execute：单发命令分流 → 一次陪看调用 → 起循环。
 *
 * 三段彼此独立，顺序也不能换：
 *   1. 单发命令（watch-actions.js）：一问一答就结束，一行都不进主流程；
 *   2. 一次陪看调用（watch-run.js）：读位置、建这一段、到点交付；
 *   3. 起循环（watch-loop.js）：从这里往后每段到点自己叫醒。
 *
 * 本文件只负责"把宿主的 ctx 和机器配置接上去"，不做业务判断。
 *
 * 放在 `watch/` 里而不是 `tools/`：陪看要单独成包，**schema + handler + 注册**必须在一处，
 * 否则拆的时候还得去别人家目录里捡文件。它唯一跨出去的那条线是
 * `storyboard/`（建段、出清单），那是允许的依赖方向。
 */

import { DEFAULT_RAMP, DEFAULT_SEGMENT } from './batches.js';
import { configuredLaunch, configuredPort } from '../storyboard/browser-time.js';
import { ensureChatSession } from './chat.js';
import { formatManifest } from '../storyboard/format.js';
import { runStoryboard } from '../storyboard/pipeline.js';
import { validateWatchArgs } from './tool-spec.js';
import { makeBuilder, runWatchPass } from './watch-run.js';
import { runWatchAction } from './watch-actions.js';
import { DEFAULT_LOOKAHEAD, startWatchLoop } from './watch-loop.js';

/**
 * @param {object} ctx   宿主上下文（存图用）
 * @param {object} args  工具参数
 * @param {{sessionId?: string|null, cache?: Map}} deps
 *   sessionId 来自 session/event 钩子；没有它就不起循环（除非已有声音订阅者，见 voice.js）。
 *   cache 由外层持有 —— 一次会话里跨多次调用复用同一批已建好的段。
 */
export async function execute(ctx, args, { sessionId = null, cache = new Map() } = {}) {
  const problems = validateWatchArgs(args);

  // 即将进入阻塞：把聊天框支起来（第一次会起服务 + 开标签，之后什么都不做）
  if (args.wait === true) void ensureChatSession(args.browserPort ?? configuredPort());

  // 单发命令（status / voices / speak / cookies / wake / stop）在这里分流
  const quick = await runWatchAction(args, {
    ctx, sessionId, browserPort: args.browserPort ?? configuredPort(),
  });
  if (quick) return quick;

  if (problems.length > 0) throw new Error(`invalid arguments: ${problems.join('; ')}`);
  // 批次表的默认值在这里定一次，工具和循环共用同一份（否则两边段边界会各算各的）
  const segment = Number(args.segment) > 0 ? Number(args.segment) : DEFAULT_SEGMENT;
  const ramp = args.ramp === undefined ? [...DEFAULT_RAMP] : args.ramp;
  const callArgs = { ...args, segment, ramp };

  // 机器配置只在这里读一次，然后显式传给库层
  const browserPort = args.browserPort ?? configuredPort() ?? undefined;
  const autoLaunch = configuredLaunch();

  const r = await runWatchPass(callArgs, {
    browserPort, autoLaunch,
    cache,
    runStoryboard,
    formatManifest,
    saveImage: async ({ data, name }) => ctx.attachments.saveImage({
      data, mediaType: 'image/png', name,
    }),
  });

  // 起陪看循环：从这里往后每 120 秒一段，到点自己叫醒。
  // 没有会话 id 就不起（只是不会自动说话，工具本身照常可用）。
  // **有没有人接声音不影响这里**：循环里只在有订阅者时才把台词交出去（见 voice.js），
  // 没订阅者就照旧叫醒模型，两条路都不需要核心自带引擎。
  const canLoop = Boolean(sessionId);
  if (args.loop !== false && canLoop && Number.isFinite(r.cursor)) {
    const size = r.size ?? 120;
    // 余量按**时间**算（默认 5 分钟）：开头段短就多备几段。
    // 以前固定"两段"，在 1/2/3 分钟的阶梯上最前面只等于 2 分钟 —— 不够保险。
    // depth 只在调用方显式给了的时候才按段数算（旧口径，一般不要用）。
    const lookahead = args.lookahead === undefined
      ? DEFAULT_LOOKAHEAD
      : Math.max(0, Number(args.lookahead) || 0);
    const depth = Number(args.depth) >= 1 ? Math.floor(Number(args.depth)) : null;
    const speakEvery = Math.max(0, Number(args.speakEvery) || 0);
    // 台词库存的"补词判定"**默认关闭**：
    // 分段 + 阻塞等待已经足够知道"该看下一段了"，再加一层库存判断反而会把模型叫得太频繁，
    // 而且有些模型本来就不爱说话 —— 不该逼它产出台词。
    const refillBelow = args.refillBelow === undefined ? 0 : Math.max(0, Number(args.refillBelow) || 0);
    startWatchLoop({
      ctx, sessionId, input: r.input,
      cursor: r.cursor, status: r.status,
      // 段长 / 阶梯 / 余量交给循环：之后它自己往前滚、自己补建
      segment, ramp, lookahead, depth, speakEvery, refillBelow,
      // 循环负责"什么时候建"，这里给它"怎么建"
      deps: {
        browserPort,
        build: makeBuilder({
          input: r.input, args: callArgs, runStoryboard, formatManifest, cache,
        }),
      },
      log: () => {},
    });
  }
  return { text: r.text, images: r.images };
}

