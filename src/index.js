/**
 * index.js — DSH 插件入口。注册两个工具：
 *   video_storyboard  全片（或一段）的概览宫格
 *   video_zoom        某一段的近距离重看（格少、每格大）
 *
 * 契约要点（都是对着 @deepseek-ai/dsh-tools 的类型定义核对的）：
 *  - `apply` 返回 disposer（把所有 `ctx.tools.register()` 的返回值串起来）
 *  - `execute` 返回**规范值**（要过 output.schema）
 *  - `output.render(args, value)` 把规范值渲染成 ContentBlock[]，图片块是
 *    `{ type: 'image', attachment: ImageAttachmentRef }`，ref 必须由
 *    `ctx.attachments.saveImage()` 提交过后才能拿到（不能自己编）
 *  - saveImage 要的是**真正编码后的字节**（PNG/JPEG），不是裸 RGB —— 它会解码校验
 */

import { DETAIL_CHARS, runStoryboard, formatManifest, formatProbe, formatRemoteProbe } from './pipeline.js';
import { probeVideo } from './probe.js';
import { formatMatches, matchSegments, recallSegments } from './locate.js';
import { lookupCell } from './cells.js';
import { runWatchPass } from './watch-run.js';
import { loopStatus, startWatchLoop, stopWatchLoop } from './watch-loop.js';
import { isHttpUrl, probeUrl, resolveDirectUrl, resolveInput } from './fetch.js';
import {
  storyboardToolSpec, zoomToolSpec, probeToolSpec, locateToolSpec, watchToolSpec,
  validateToolArgs, validateZoomArgs, validateWatchArgs,
} from './tool-spec.js';

export const name = 'dsh-video-storyboard';
export const inject = ['tools', 'attachments'];

/**
 * 解析宿主的 dsh-tools。正常安装时裸包名就能解析；本地开发/测试时
 * 用 DSH_TOOLS_PATH 指向安装里的 lib/index.js。
 */
async function loadDefineTool() {
  try {
    const mod = await import('@deepseek-ai/dsh-tools');
    if (mod?.defineTool) return mod.defineTool;
  } catch {
    /* 落到环境变量 */
  }
  const override = process.env.DSH_TOOLS_PATH;
  if (override) {
    const { pathToFileURL } = await import('node:url');
    const mod = await import(pathToFileURL(override).href);
    if (mod?.defineTool) return mod.defineTool;
  }
  throw new Error('cannot resolve @deepseek-ai/dsh-tools (set DSH_TOOLS_PATH for local dev)');
}

/** 跑一次管线，把每张图提交成附件，返回规范值 { images, text } */
async function runAndAttach(ctx, options, problems, cellRange) {
  if (problems.length > 0) throw new Error(`invalid arguments: ${problems.join('; ')}`);
  const result = await runStoryboard(options);
  const images = [];
  for (const sheet of result.sheets) {
    images.push(await ctx.attachments.saveImage({
      data: sheet.png,
      mediaType: 'image/png',
      name: `storyboard-${sheet.sheet}.png`,
    }));
  }
  // 预算：单次工具结果有上限，超出会被宿主折进磁盘（模型常常不会去读）。
  // 24k 字符 ≈ 一张 16 格图的完整清单还有余量；超了就在 cell 边界截断并给出续读方式。
  return {
    images,
    text: formatManifest(result, {
      cellRange,
      maxCellChars: DETAIL_CHARS[options.detail] ?? DETAIL_CHARS.med,
    }),
  };
}

export async function apply(ctx) {
  try {
    return await registerAll(ctx);
  } catch (e) {
    // **最坏的情况是插件不能用，不是应用起不来**。
    // 真实事故：我在 apply 里加了一次 ctx 探测，`Object.keys(ctx)` 在 cordis 上下文上抛错，
    // 整个 DSH 直接崩在启动阶段（"The application could not start"）。
    // 从那以后，apply 的异常一律吞掉并记录，交回一个空 disposer。
    try {
      ctx?.logger?.error?.(`[dsh-video-storyboard] failed to load: ${e?.stack ?? e}`);
    } catch { /* 连日志都写不了就算了 */ }
    // DSH_VIDEO_DEBUG=1 时把错误抛出去 —— 否则"插件静默不工作"很难查
    if (process.env.DSH_VIDEO_DEBUG) throw e;
    return () => {};
  }
}

async function registerAll(ctx) {
  const defineTool = await loadDefineTool();

  const storyboard = defineTool({
    ...storyboardToolSpec(),
    execute: (args) => runAndAttach(ctx, {
      input: args.input,
      from: args.from ?? 0,
      to: args.to ?? 0,
      cells: args.cells ?? 0,
      sheets: args.sheets ?? 0,
      pick: args.pick ?? 'sharp',
      burn: args.burn ?? 'index',
      minGap: args.minGap ?? 1.2,
      transcript: args.transcript ?? 'auto',
      transcriptFile: args.transcriptFile,
      // 这一次的热词（覆盖 asr.json）。学科不对时的负偏置，比不传更糟。
      ...(typeof args.hotwords === 'string' ? { hotwords: args.hotwords } : {}),
      sourceHash: args.sourceHash === true,
      textOnly: args.textOnly === true,
      detail: args.detail ?? 'med',
      // detail=high 表示"要能引用原话"，这时才值得用硬字幕校正（本地 OCR，不花 token）
      ocr: args.ocr === true || (args.ocr !== false && (args.detail ?? 'med') === 'high'),
      ...(args.planThresholds && typeof args.planThresholds === 'object'
        ? { planThresholds: args.planThresholds } : {}),
      fetchOptions: {
        cookies: args.cookies,
        allowAnonymous: args.allowAnonymous === true,
        scanHeight: args.scanHeight ?? 360,
      },
    }, validateToolArgs(args), args.cellRange ?? null),
  });

  const zoom = defineTool({
    ...zoomToolSpec(),
    async execute(args) {
      const problems = validateZoomArgs(args);
      if (problems.length > 0) throw new Error(`invalid arguments: ${problems.join('; ')}`);

      // cellId → 该格的绝对时间区间（上一次分镜落下的表）。
      // 找不到就明确报错并指路，而不是悄悄退回一个"猜的"窗口。
      let from = args.from;
      let to = args.to;
      if (args.cellId !== undefined && args.cellId !== null) {
        const hit = await lookupCell(args.input, args.cellId);
        if (!hit) {
          throw new Error(`no cell map recorded for this input (cellId ${args.cellId}). ` +
            'Run video_storyboard on it first, or pass from/to.');
        }
        from = hit.from;
        to = hit.to;
      }
      const fetchOptions = {
        cookies: args.cookies,
        allowAnonymous: args.allowAnonymous === true,
        // zoom 需要本地那份低清做兜底，所以这里也要提供落盘清晰度
        scanHeight: 360,
        zoomHeight: args.zoomHeight ?? 1080,
      };
      // 链接模式下先设法拿到高清直链：stroryboard 那次 `-J` 通常已经记下了，
      // 这里多半是内存命中；实在没有才真的再解析一次（2.4 s）。
      let frameSource = null;
      if (isHttpUrl(args.input)) {
        try {
          const resolved = await resolveInput(args.input, fetchOptions);
          frameSource = resolved.frameSource
            ?? await resolveDirectUrl(args.input, { ...fetchOptions, height: fetchOptions.zoomHeight });
        } catch {
          /* 直链拿不到就退回本地低清：糊一点，但整次调用不该失败 */
        }
      }
      const result = await runStoryboard({
        input: args.input,
        from,
        to,
        cells: args.cells ?? 6,
        sheets: 1,
        // **必须显式传**：runStoryboard 的默认值是 1.2，不传就永远是 1.2 ——
        // zoom 恰恰是最需要小间隔的场合（把半秒镜头拆成独立格）。真实反馈：
        // `video_zoom({ minGap: 0.4 })` 要 4 格只出 2 格，而 tool-spec 声明了、validate 也校验了，中间断了。
        minGap: args.minGap ?? 1.2,
        pick: args.pick ?? 'sharp',
        burn: args.burn ?? 'index',
        transcript: args.transcript ?? 'auto',
        sourceHash: args.sourceHash === true,
        // 近距离重看时不再按密度挪格：窗口本来就短，均分更好预测
        adaptive: false,
        frameSource,
        fetchOptions,
      });
      const images = [];
      for (const sheet of result.sheets) {
        images.push(await ctx.attachments.saveImage({
          data: sheet.png,
          mediaType: 'image/png',
          name: `storyboard-${sheet.sheet}.png`,
        }));
      }
      return { images, text: formatManifest(result, { maxCellChars: DETAIL_CHARS.med }) };
    },
  });

  // ---- 一起看：按用户的播放进度一段段往下看（预取 + 到点交付）
  // 具体逻辑在 watch-run.js，这里只做参数校验 + 把宿主的能力（存图、跑分镜）递进去。
  const watchCache = new Map();
  const watch = defineTool({
    ...watchToolSpec(),
    async execute(args) {
      const problems = validateWatchArgs(args);
      if (args.stopLoop === true) return { text: JSON.stringify(stopWatchLoop('requested')), images: [] };
      if (problems.length > 0) throw new Error(`invalid arguments: ${problems.join('; ')}`);
      const r = await runWatchPass(args, {
        cache: watchCache,
        runStoryboard,
        formatManifest,
        saveImage: async ({ data, name }) => ctx.attachments.saveImage({
          data, mediaType: 'image/png', name,
        }),
      });

      // 起陪看循环：从这里往后每 120 秒一段，到点自己叫醒。
      // 没有会话 id 就不起（只是不会自动说话，工具本身照常可用）。
      if (args.loop !== false && lastSessionId && Number.isFinite(r.cursor)) {
        const size = r.size ?? 120;
        const startSeg = r.segment ?? 0;
        // **只往后看 lookahead 秒**（默认 5 分钟），不是整片。
        // 用户随时可能不看了——排到两小时之后就是在白算。滚动的：用户每看一段，
        // 下一次调用把窗口再往前推一段。
        const lookahead = Number.isFinite(Number(args.lookahead)) ? Number(args.lookahead) : 300;
        const count = Math.max(1, Math.ceil(lookahead / size));
        const segments = Array.from({ length: count }, (_, i) => {
          const from = startSeg + (i + 1) * size;
          return { from, to: from + size, sayAt: from + size - 15 };
        });
        startWatchLoop({
          ctx, sessionId: lastSessionId, input: r.input, segments,
          cursor: r.cursor, log: () => {},
        });
      }
      return { text: r.text, images: r.images };
    },
  });

  // 只读容器头，不花图片 token —— 让模型在第一次出图前先知道"多长、按什么粒度读"
  const probe = defineTool({
    ...probeToolSpec(),
    async execute(args) {
      if (!args?.input) throw new Error('input is required');
      const fetchOptions = { cookies: args.cookies, allowAnonymous: args.allowAnonymous === true };
      // 链接只解析、不下载：probe 的价值是"便宜"，下载 7 MB 就失去意义了
      if (isHttpUrl(args.input)) {
        const remote = await probeUrl(args.input, fetchOptions);
        return { text: formatRemoteProbe(remote) };
      }
      const info = { ...(await probeVideo(args.input)), path: args.input };
      return { text: await formatProbe(info) };
    },
  });

  // 纯文本定位：不读帧、不出图，靠已有的转写回答"那句话在第几分钟"
  const locate = defineTool({
    ...locateToolSpec(),
    async execute(args) {
      if (!args?.input) throw new Error('input is required');
      if (!args?.query) throw new Error('query is required');
      const max = Math.min(20, Math.max(1, Number(args.max) || 5));
      const resolved = await resolveInput(args.input, {
        cookies: args.cookies, allowAnonymous: args.allowAnonymous === true,
      });
      let segments = recallSegments(resolved.path);
      if (!segments) {
        // 没有现成转写就补跑一次（只出文本、不出图）：复用 storyboard 的全套配置，
        // 跑完它会自己把转写塞进 locate 的缓存里
        await runStoryboard({
          input: resolved.path, from: args.from, to: args.to, cells: 1,
          transcriptFile: args.transcriptFile, textOnly: true, encode: false,
        });
        segments = recallSegments(resolved.path);
      }
      if (!segments || segments.length === 0) {
        return { text: 'no transcript available for this file: run video_storyboard first, ' +
          'or pass transcriptFile. Without a transcript there is nothing to match on.' };
      }
      const lo = Number.isFinite(args.from) ? args.from : 0;
      const hi = Number.isFinite(args.to) ? args.to : Infinity;
      const inWindow = segments.filter((x) => x.to >= lo && x.from <= hi);
      const matches = matchSegments(inWindow, args.query, { max });
      return { text: formatMatches(args.query, matches, { total: inWindow.length }) };
    },
  });

  // 当前会话：从 session/event 里拿（`session.header.id`）。这是 dsh-fish 的做法，
  // 比反射 ctx 安全得多 —— 反射会把整个应用搞崩（见 apply 的注释）。
  let lastSessionId = null;
  if (typeof ctx.on === 'function') {
    try {
      const off = ctx.on('session/event', (session) => {
        const id = session?.header?.id ?? session?.id;
        if (id) lastSessionId = id;
      });
      if (typeof off === 'function') disposers.push(off);
    } catch { /* 拿不到就退化成"只能手动触发" */ }
  }

  const disposers = [
    ctx.tools.register(storyboard),
    ctx.tools.register(zoom),
    ctx.tools.register(probe),
    ctx.tools.register(locate),
    ctx.tools.register(watch),
  ];
  return () => {
    for (const dispose of disposers.reverse()) dispose?.();
  };
}
