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

import { DETAIL_CHARS, runStoryboard, formatManifest, formatProbe } from './pipeline.js';
import { probeVideo } from './probe.js';
import {
  storyboardToolSpec, zoomToolSpec, probeToolSpec, validateToolArgs, validateZoomArgs,
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
      enrichment: args.enrichment ?? 'auto',
      textOnly: args.textOnly === true,
      detail: args.detail ?? 'med',
    }, validateToolArgs(args), args.cellRange ?? null),
  });

  const zoom = defineTool({
    ...zoomToolSpec(),
    execute: (args) => {
      const mode = args.mode ?? 'temporal';
      return runAndAttach(ctx, {
        input: args.input,
        from: args.from,
        to: args.to,
        // spatial：少格看清单帧；temporal：多采样看清动作顺序
        cells: args.cells ?? (mode === 'spatial' ? 4 : 6),
        sheets: 1,
        pick: args.pick ?? 'sharp',
        burn: args.burn ?? 'index',
        minGap: args.minGap ?? (mode === 'temporal' ? 0.4 : 1.2),
        transcript: args.transcript ?? 'auto',
        strategy: 'coverage',
        zoomMode: mode,
        reuseAnalysis: true,
        // 有父 VAA 时切片后仍可用 coverage；无切点时退回均分
        adaptive: true,
      }, validateZoomArgs(args));
    },
  });

  // 只读容器头，不花图片 token —— 让模型在第一次出图前先知道"多长、按什么粒度读"
  const probe = defineTool({
    ...probeToolSpec(),
    async execute(args) {
      if (!args?.input) throw new Error('input is required');
      const info = { ...(await probeVideo(args.input)), path: args.input };
      return { text: formatProbe(info) };
    },
  });

  const disposers = [
    ctx.tools.register(storyboard),
    ctx.tools.register(zoom),
    ctx.tools.register(probe),
  ];
  return () => {
    for (const dispose of disposers.reverse()) dispose?.();
  };
}
