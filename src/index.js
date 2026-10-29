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
import { DEFAULT_RAMP, DEFAULT_SEGMENT } from './batches.js';
import { configuredLaunch, configuredPort } from './browser-time.js';
import { checkBiliLogin, fetchRemoteSubtitles } from './subtitles.js';
import { listVoices, speak as speakAloud } from './tts.js';
import { makeBuilder, runWatchPass } from './watch-run.js';
import {
  DEFAULT_LOOKAHEAD, loopStatus, startWatchLoop, stopWatchLoop,
} from './watch-loop.js';
import { wakeSession } from './timer.js';
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
      // 只看钟的状态，不读进度、不出图 —— 排查"它为什么不说话"时用
      if (args.statusOnly === true) return { text: JSON.stringify(loopStatus()), images: [] };
      // 看这台机器有哪些声音（TTS 用）
      if (args.listVoices === true) return { text: JSON.stringify(await listVoices()), images: [] };

      // 立刻念一句（脚本发声，不经过模型）：配合 nextLine 之外的"单发"场景
      if (args.speakAloud === true) {
        const text = String(args.text ?? '').trim();
        if (!text) return { text: JSON.stringify({ ok: false, reason: 'empty-text' }), images: [] };
        const r = await speakAloud(text, { voice: args.voice ?? undefined, rate: args.rate ?? 0 });
        return { text: JSON.stringify(r), images: [] };
      }

      // 检查 B 站登录态与字幕可用性：这一条能立刻回答"为什么还在用 ASR"
      if (args.checkCookies === true) {
        const login = await checkBiliLogin({ cookies: args.cookies });
        const url = typeof args.input === 'string' && /^https?:/i.test(args.input) ? args.input : null;
        const subs = url ? await fetchRemoteSubtitles({ url, cookies: args.cookies }) : null;
        return {
          text: JSON.stringify({
            login,
            subtitles: subs ? { ok: subs.ok, reason: subs.reason, count: subs.segments?.length ?? 0, lang: subs.lang } : 'pass a video URL in input to check subtitles',
          }),
          images: [],
        };
      }
      // 立刻试一次唤醒，把结果原样报出来。这一条能 5 秒内回答"loop 到底叫不叫得醒我"。
      if (args.testWake === true) {
        const r = await wakeSession(ctx, {
          sessionId: lastSessionId,
          text: '[一起看] 这是一次唤醒连通性测试，收到就不用回复内容，回一句"收到"即可。',
        });
        return {
          text: JSON.stringify({
            sessionId: lastSessionId ?? null,
            hasSessionController: Boolean(ctx?.sessionController),
            hasPrompt: typeof ctx?.sessionController?.prompt === 'function',
            ...r,
          }),
          images: [],
        };
      }
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
        // 余量按**时间**算（默认 5 分钟）：开头段短就多备几段。
        // 以前固定"两段"，在 1/2/3 分钟的阶梯上最前面只等于 2 分钟 —— 不够保险。
        // depth 只在调用方显式给了的时候才按段数算（旧口径，一般不要用）。
        const lookahead = args.lookahead === undefined
          ? DEFAULT_LOOKAHEAD
          : Math.max(0, Number(args.lookahead) || 0);
        const depth = Number(args.depth) >= 1 ? Math.floor(Number(args.depth)) : null;
        const speakEvery = Math.max(0, Number(args.speakEvery) || 0);
        // tts: true → 到点由脚本念台词，不叫醒模型（省 token、也没有等待）
        const tts = args.tts === true
          ? { enabled: true, voice: args.voice ?? undefined, rate: args.rate ?? 0 }
          : null;
        // 台词库存的"补词判定"**默认关闭**：
        // 分段 + 阻塞等待已经足够知道"该看下一段了"，再加一层库存判断反而会把模型叫得太频繁，
        // 而且有些模型本来就不爱说话 —— 不该逼它产出台词。
        const refillBelow = args.refillBelow === undefined ? 0 : Math.max(0, Number(args.refillBelow) || 0);
        startWatchLoop({
          ctx, sessionId: lastSessionId, input: r.input,
          cursor: r.cursor, status: r.status,
          // 段长 / 阶梯 / 余量交给循环：之后它自己往前滚、自己补建
          segment, ramp, lookahead, depth, speakEvery, tts, refillBelow,
          // 循环负责"什么时候建"，这里给它"怎么建"
          deps: {
            browserPort,
            build: makeBuilder({
              input: r.input, args: callArgs, runStoryboard, formatManifest, cache: watchCache,
            }),
          },
          log: () => {},
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

  // **disposers 必须在最前面声明**：它以前声明在 ctx.on 之后，于是 `disposers.push(off)`
  // 撞上 const 的暂时性死区，抛 ReferenceError，又被下面的 catch 静默吞掉 ——
  // 监听器注册成功了，解绑函数却从来没登记过（插件卸载时不会解绑，而且没人知道出过错）。
  const disposers = [];

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
    } catch (e) {
      // 拿不到就退化成"只能手动触发"，但要说出来 —— 静默失败是这类 bug 的温床
      try {
        ctx?.logger?.warn?.(`[dsh-video-storyboard] session/event hook failed: ${e?.message ?? e}`);
      } catch { /* 日志都没有就只能算了 */ }
    }
  }

  disposers.push(
    ctx.tools.register(storyboard),
    ctx.tools.register(zoom),
    ctx.tools.register(probe),
    ctx.tools.register(locate),
    ctx.tools.register(watch),
  );
  return () => {
    for (const dispose of disposers.reverse()) dispose?.();
  };
}
