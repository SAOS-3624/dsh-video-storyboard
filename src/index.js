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
import { isHttpUrl, probeUrl, resolveDirectUrl, resolveInput } from './fetch.js';
import {
  storyboardToolSpec, zoomToolSpec, probeToolSpec, locateToolSpec, validateToolArgs, validateZoomArgs,
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
        from: args.from,
        to: args.to,
        cells: args.cells ?? 6,
        sheets: 1,
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

  const disposers = [
    ctx.tools.register(storyboard),
    ctx.tools.register(zoom),
    ctx.tools.register(probe),
    ctx.tools.register(locate),
  ];
  return () => {
    for (const dispose of disposers.reverse()) dispose?.();
  };
}
