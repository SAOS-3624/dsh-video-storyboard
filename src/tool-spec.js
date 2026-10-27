/**
 * tool-spec.js — 工具定义（**不含 execute**）。
 *
 * 单独抽出来是为了让 test/contract.test.mjs 能把同一份 spec 丢给宿主真实的
 * `defineTool` 编译一遍。这一步必须做：schema 用了宿主不认的关键字时，
 * `ctx.tools.register()` 会在 apply() 阶段抛错，整棵插件树（连带应用）都起不来。
 *
 * 宿主支持的子集（见 @deepseek-ai/dsh-tools 的 ValueSchemaSpec）：
 *   string / number / integer / boolean / null / array(items) / object(properties, additionalProperties) / json / oneOf
 * **不支持** minimum、maximum、pattern、maxItems、minLength、format 等注解式约束。
 * 所以取值范围（比如 cells 1..16）写在 description 里，由 execute 兜底校验。
 */

export const TOOL_NAME = 'video_storyboard';
export const ZOOM_TOOL_NAME = 'video_zoom';
export const PROBE_TOOL_NAME = 'video_probe';

export function storyboardToolSpec() {
  return {
    name: TOOL_NAME,
    description: [
      'Turn a local video into ONE addressable storyboard image (a numbered grid of frames)',
      'plus a text index of every cell, so you can look at the video yourself instead of guessing.',
      '',
      'Each cell is one content segment (shot-aware), sampled at its sharpest frame, with the cell',
      'number burned into the top-left corner. The text lists "cell k (r2c3) = 00:12.76-00:31.40"',
      'so you can cite a moment or ask for a close-up later with video_zoom.',
      '',
      'Use it like this:',
      '- Whole short clip: video_storyboard({ input })',
      '- Long film, read in slices: video_storyboard({ input, from: 600, to: 900 })',
      '- Wide shot of a long film: video_storyboard({ input, cells: 16, sheets: 2 })',
      '',
      'Cell count is chosen automatically from duration and how fast the picture changes',
      '(fast-cut content gets more cells). Pass cells/sheets only if you want to override.',
    ].join('\n'),
    parameters: {
      input: {
        type: 'string',
        required: true,
        description: 'Absolute path to a video file readable by ffmpeg (mp4/mov/mkv/webm...).',
      },
      from: {
        type: 'number',
        description: 'Window start in seconds (default 0). Only this window is scanned and sampled.',
      },
      to: {
        type: 'number',
        description: 'Window end in seconds (default: end of file).',
      },
      cells: {
        type: 'integer',
        description: 'Cells per image, 1-16 (default: auto). More cells = more coverage but smaller each.',
      },
      sheets: {
        type: 'integer',
        description: 'How many images to return, 1-4 (default: auto). Each extra image costs another 384 tokens.',
      },
      pick: {
        type: 'string',
        enum: ['sharp', 'mid', 'thumb'],
        description: 'Frame selection inside a segment. Default "sharp" (Laplacian variance) avoids blurred transition frames.',
      },
      burn: {
        type: 'string',
        enum: ['index', 'index+time', 'none'],
        description: 'What to burn into each cell. Default "index". "index+time" adds a timestamp but is hard to read at small cell sizes.',
      },
      minGap: {
        type: 'number',
        description: 'Minimum spacing between sampled frames in seconds (default 1.2). Short shots get merged, not sampled twice.',
      },
      transcript: {
        type: 'string',
        enum: ['auto', 'off'],
        description: 'Default "auto": use the embedded subtitle track if present, otherwise ASR when configured. "off" skips speech entirely.',
      },
      enrichment: {
        type: 'string',
        enum: ['auto', 'off'],
        description: 'Optional DSH enrichment sidecar (~/.dsh/video.json): remote shot detector (TransNet-class), ' +
          'speaker diarization, emotion/events. Default "auto" uses the sidecar only when configured; ' +
          '"off" keeps the built-in HSV+loudness path. Failures never break the storyboard.',
      },
      detail: {
        type: 'string',
        enum: ['low', 'med', 'high'],
        description: 'How many characters of transcript per cell: low=60 (is this stretch about X?), ' +
          'med=120 (default), high=400 (quote-level). Truncation lands on a sentence boundary. ' +
          'Use cellRange + textOnly to read one cell in full.',
      },
      cellRange: {
        type: 'array',
        items: { type: 'integer' },
        description: 'Only render cells [first, last] (1-based, inclusive) in the text index. ' +
          'For a 2-hour film the full 64-cell index is ~75 KB, which can exceed one tool result — ' +
          'the index says where it stopped and which cellRange to ask for next.',
      },
      textOnly: {
        type: 'boolean',
        description: 'Return only the text index (respecting cellRange) — no image is produced and no ' +
          'frame is decoded. Use it to page through a long film after the first visual pass; the scan is cached.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true, description: 'The addressable cell index for the model.' },
          images: {
            type: 'array',
            required: true,
            items: { type: 'json' },
            description: 'Committed image attachments, one per storyboard sheet.',
          },
        },
      },
      render(args, value) {
        return [
          ...value.images.map((attachment) => ({ type: 'image', attachment })),
          { type: 'text', text: value.text },
        ];
      },
    },
    timeoutMs: 900_000,
    isConcurrencySafe() {
      return true;
    },
  };
}

/**
 * 第二个工具：一段的近距离重看。与 storyboard 共用管线，只是把窗口收窄、格数调少，
 * 于是每格能分到接近原生分辨率的像素。
 */
export function zoomToolSpec() {
  return {
    name: ZOOM_TOOL_NAME,
    description: [
      'Re-read a short window of a video at higher per-cell resolution.',
      '',
      'Use it after video_storyboard when one cell needs a closer look: "what exactly is on screen',
      'at 01:12-01:20?" A zoom returns ONE image with few, large cells (default 6), so faces,',
      'subtitles and on-screen text become legible — things a 16-cell overview cannot show.',
      '',
      'Keep the window short (a few seconds to a minute). For another wide pass use video_storyboard.',
      'Costs one image (~384 tokens), like any other tool result with one image.',
    ].join('\n'),
    parameters: {
      input: { type: 'string', required: true, description: 'Absolute path to the video file.' },
      from: { type: 'number', required: true, description: 'Window start in seconds.' },
      to: { type: 'number', required: true, description: 'Window end in seconds.' },
      cells: {
        type: 'integer',
        description: 'Cells for this window, 1-9 (default 6). Fewer cells = bigger each.',
      },
      pick: {
        type: 'string',
        enum: ['sharp', 'mid', 'thumb'],
        description: 'Frame selection inside each cell. Default "sharp".',
      },
      burn: {
        type: 'string',
        enum: ['index', 'index+time', 'none'],
        description: 'What to burn into each cell. Default "index".',
      },
      transcript: {
        type: 'string',
        enum: ['auto', 'off'],
        description: 'Include subtitle/ASR text for this window. Default "auto".',
      },
      minGap: {
        type: 'number',
        description: 'Minimum spacing between cells in seconds (default 1.2). Lower it to 0.3-0.5 ' +
          'when re-reading a fast-cut montage so short shots get their own cell instead of being merged.',
      },
      mode: {
        type: 'string',
        enum: ['temporal', 'spatial'],
        description: 'temporal (default): denser time samples for action order. ' +
          'spatial: fewer larger cells to read faces/UI. Reuses prior storyboard analysis when the ' +
          'window is covered — no re-scan / re-ASR.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true, description: 'Cell index for this window.' },
          images: { type: 'array', required: true, items: { type: 'json' } },
        },
      },
      render(args, value) {
        return [
          ...value.images.map((attachment) => ({ type: 'image', attachment })),
          { type: 'text', text: value.text },
        ];
      },
    },
    timeoutMs: 300_000,
    isConcurrencySafe() {
      return true;
    },
  };
}

/**
 * 第三个工具：只读容器头，几毫秒。让模型在花掉第一张图的 384 token 之前，
 * 先知道"多长、多大、有没有音轨/字幕、按什么粒度读"。
 */
export function probeToolSpec() {
  return {
    name: PROBE_TOOL_NAME,
    description: [
      'Read a video\'s container metadata without decoding a single frame: duration, resolution,',
      'frame rate, rotation, audio track, subtitle tracks, and a suggested reading plan.',
      '',
      'Call this FIRST when you do not already know how long the file is. It costs no image tokens.',
      'Then either video_storyboard (overview, or a window) or video_zoom (close-up).',
    ].join('\n'),
    parameters: {
      input: { type: 'string', required: true, description: 'Absolute path to the video file.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true, description: 'Metadata plus a suggested reading plan.' },
        },
      },
      render(args, value) {
        return [{ type: 'text', text: value.text }];
      },
    },
    timeoutMs: 30_000,
    isConcurrencySafe() {
      return true;
    },
  };
}

/** execute 内部兜底校验（schema 子集不支持 minimum/maximum，只能在这里挡） */
export function validateToolArgs(args) {
  const problems = [];
  if (!args?.input || typeof args.input !== 'string') problems.push('input is required');
  if (args.cells !== undefined && (!Number.isInteger(args.cells) || args.cells < 1 || args.cells > 16)) {
    problems.push('cells must be an integer 1..16');
  }
  if (args.sheets !== undefined && (!Number.isInteger(args.sheets) || args.sheets < 1 || args.sheets > 4)) {
    problems.push('sheets must be an integer 1..4');
  }
  if (args.from !== undefined && args.from < 0) problems.push('from must be >= 0');
  if (args.to !== undefined && args.from !== undefined && args.to <= args.from) {
    problems.push('to must be greater than from');
  }
  if (args.minGap !== undefined && !(args.minGap >= 0)) problems.push('minGap must be >= 0');
  if (args.transcript !== undefined && !['auto', 'off'].includes(args.transcript)) {
    problems.push("transcript must be 'auto' or 'off'");
  }
  if (args.enrichment !== undefined && !['auto', 'off'].includes(args.enrichment)) {
    problems.push("enrichment must be 'auto' or 'off'");
  }
  if (args.cellRange !== undefined) {
    const r = args.cellRange;
    if (!Array.isArray(r) || r.length !== 2 || r.some((v) => !Number.isInteger(v))) {
      problems.push('cellRange must be two integers: [first, last]');
    } else if (r[0] < 1 || r[1] < r[0]) {
      problems.push('cellRange must satisfy 1 <= first <= last');
    }
  }
  if (args.textOnly !== undefined && typeof args.textOnly !== 'boolean') {
    problems.push('textOnly must be a boolean');
  }
  if (args.detail !== undefined && !['low', 'med', 'high'].includes(args.detail)) {
    problems.push("detail must be 'low', 'med' or 'high'");
  }
  return problems;
}

/** video_zoom 的兜底校验 */
export function validateZoomArgs(args) {
  const problems = [];
  if (!args?.input || typeof args.input !== 'string') problems.push('input is required');
  if (!(args?.from >= 0)) problems.push('from is required and must be >= 0');
  if (!(args?.to > 0)) problems.push('to is required and must be > 0');
  if (args?.from !== undefined && args?.to !== undefined && args.to <= args.from) {
    problems.push('to must be greater than from');
  }
  if (args.cells !== undefined && (!Number.isInteger(args.cells) || args.cells < 1 || args.cells > 9)) {
    problems.push('cells must be an integer 1..9');
  }
  if (args.minGap !== undefined && !(args.minGap >= 0)) problems.push('minGap must be >= 0');
  if (args.mode !== undefined && !['temporal', 'spatial'].includes(args.mode)) {
    problems.push("mode must be 'temporal' or 'spatial'");
  }
  return problems;
}
