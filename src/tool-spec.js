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
export const LOCATE_TOOL_NAME = 'video_locate';

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
        description: 'Local absolute path (mp4/mov/mkv/webm...), or an http(s) link such as a Bilibili ' +
          'video URL. Links are downloaded once at low resolution for scanning; video_zoom re-reads ' +
          'the original stream at high resolution.',
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
        description: 'How many images to return, 1-4 (default: auto). Each extra image costs another ~384 tokens in DSH (host-dependent).',
      },
      pick: {
        type: 'string',
        enum: ['sharp', 'mid', 'thumb'],
        description: 'Frame selection inside a segment. Default "sharp" (Laplacian variance) avoids blurred transition frames.',
      },
      burn: {
        type: 'string',
        enum: ['index', 'none'],
        description: 'What to burn into each cell. Default "index" (the cell number, so the model can cite ' +
          '"cell 5"). Timecodes are never burned in - they live in the text at 0.01 s precision, and pixels ' +
          'spent on a timecode are pixels lost from the frame.',
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
      transcriptFile: {
        type: 'string',
        description: 'Path to an existing transcript (SRT, or JSON with [{start,end,text}] / ' +
          '[{from,to,text}] / Bilibili {body:[{from,to,content}]}). When given, the subtitle track ' +
          'and ASR are both skipped — use this when the site already has captions.',
      },
      hotwords: {
        type: 'string',
        description: 'Space-separated terms to bias this run\'s transcription (e.g. "位错 滑移 柏氏矢量"). ' +
          'Overrides asr.json for this call only. Use it when the subject has its own vocabulary — a global ' +
          'list from another subject is a negative bias, not a neutral default.',
      },
      scanHeight: {
        type: 'integer',
        description: 'For http(s) links: which resolution to download for scanning (default 360). ' +
          'Scanning only needs structure — it gets downscaled to 64x36 — so a low tier is both ' +
          'faster and 15x smaller. Close-ups go through video_zoom instead.',
      },
      cookies: {
        type: 'string',
        description: 'Path to a Netscape cookies.txt for http(s) links. Falls back to DSH_VIDEO_COOKIES. ' +
          'Required by default: without a signed-in session the available resolution is unpredictable ' +
          'and a 1080p tier can simply be absent from the format list.',
      },
      allowAnonymous: {
        type: 'boolean',
        description: 'Anonymous fetching is always allowed. Set this to true to suppress the ' +
          '"resolution not guaranteed" note when you already know this source is fine without cookies.',
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
      sourceHash: {
        type: 'boolean',
        description: 'Also compute the source file SHA-256 and put it in the manifest. Off by default: ' +
          'it reads the whole file, so on a multi-GB video it adds real I/O.',
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
      'Costs one image (~384 tokens in DSH, host-dependent), like any other tool result with one image.',
    ].join('\n'),
    parameters: {
      input: {
        type: 'string',
        required: true,
        description: 'Local absolute path, or the same http(s) link you passed to video_storyboard. ' +
          'A link is re-read from the original stream at high resolution, so cells here can be ' +
          'sharper than the storyboard even when the scan itself used a low tier.',
      },
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
        enum: ['index', 'none'],
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
      zoomHeight: {
        type: 'integer',
        description: 'For http(s) links: which resolution to read the original stream at (default 1080). ' +
          'One frame only — cheaper than downloading. Never exceeds what the source itself offers.',
      },
      cookies: {
        type: 'string',
        description: 'Path to a Netscape cookies.txt. Falls back to DSH_VIDEO_COOKIES.',
      },
      allowAnonymous: {
        type: 'boolean',
        description: 'Anonymous reading is always allowed. Set this to true to suppress the warning note.',
      },
      sourceHash: {
        type: 'boolean',
        description: 'Also compute the source file SHA-256 and put it in the manifest. Off by default.',
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
      input: {
        type: 'string',
        required: true,
        description: 'Local absolute path, or an http(s) link. For a link this resolves metadata ' +
          'only (no download): title, duration, and the resolutions the source actually offers.',
      },
      cookies: {
        type: 'string',
        description: 'Path to a Netscape cookies.txt. Falls back to DSH_VIDEO_COOKIES.',
      },
      allowAnonymous: {
        type: 'boolean',
        description: 'Anonymous probing is always allowed. Set this to true to suppress the warning note.',
      },
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
  if (args.sourceHash !== undefined && typeof args.sourceHash !== 'boolean') {
    problems.push('sourceHash must be a boolean');
  }
  if (args.detail !== undefined && !['low', 'med', 'high'].includes(args.detail)) {
    problems.push("detail must be 'low', 'med' or 'high'");
  }
  if (args.transcriptFile !== undefined
    && (typeof args.transcriptFile !== 'string' || args.transcriptFile.trim() === '')) {
    problems.push('transcriptFile must be a non-empty path');
  }
  if (args.scanHeight !== undefined
    && (!Number.isInteger(args.scanHeight) || args.scanHeight < 120 || args.scanHeight > 2160)) {
    problems.push('scanHeight must be an integer 120..2160');
  }
  if (args.cookies !== undefined && (typeof args.cookies !== 'string' || args.cookies.trim() === '')) {
    problems.push('cookies must be a non-empty path');
  }
  if (args.allowAnonymous !== undefined && typeof args.allowAnonymous !== 'boolean') {
    problems.push('allowAnonymous must be a boolean');
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
  if (args.zoomHeight !== undefined
    && (!Number.isInteger(args.zoomHeight) || args.zoomHeight < 120 || args.zoomHeight > 2160)) {
    problems.push('zoomHeight must be an integer 120..2160');
  }
  if (args.cookies !== undefined && (typeof args.cookies !== 'string' || args.cookies.trim() === '')) {
    problems.push('cookies must be a non-empty path');
  }
  if (args.allowAnonymous !== undefined && typeof args.allowAnonymous !== 'boolean') {
    problems.push('allowAnonymous must be a boolean');
  }
  if (args.sourceHash !== undefined && typeof args.sourceHash !== 'boolean') {
    problems.push('sourceHash must be a boolean');
  }
  return problems;
}

/**
 * video_locate — 纯文本的"那句话在第几分钟"。
 *
 * 刻意不读帧、不出图：定位靠的是转写文本，本来就在手里。
 * 模型拿到时间窗之后自己去 video_zoom，省掉一次整段的重新取帧。
 */
export function locateToolSpec() {
  return {
    name: LOCATE_TOOL_NAME,
    description: [
      'Find where a phrase is spoken in a video: returns timestamped transcript lines that match,',
      'best first. Text only - no frame decode, no image, no tokens spent on pixels.',
      '',
      'Use this when you know roughly what was said but not when ("where does it mention X").',
      'Then pass the returned from/to window to video_zoom to see that moment.',
      '',
      'Needs a transcript. If video_storyboard already ran on this file in this session, its',
      'transcript is reused; otherwise ASR runs for the requested window (slow if the window is long).',
    ].join('\n'),
    parameters: {
      input: {
        type: 'string',
        required: true,
        description: 'Local absolute path or http(s) link. Must be the same string used for ' +
          'video_storyboard if you want its transcript reused.',
      },
      query: {
        type: 'string',
        required: true,
        description: 'The phrase to look for. Chinese and English both work; punctuation and spacing ' +
          'are ignored. Long quotes match better than single characters.',
      },
      from: { type: 'number', description: 'Only search after this second. Default: start of file.' },
      to: { type: 'number', description: 'Only search before this second. Default: end of file.' },
      max: { type: 'number', description: 'How many matches to return, 1-20. Default 5.' },
      transcriptFile: {
        type: 'string',
        description: 'Path to an existing SRT/JSON transcript. Skips ASR entirely.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true, description: 'Timestamped matching lines, best first.' },
        },
      },
      render(args, value) {
        return [{ type: 'text', text: value.text }];
      },
    },
    timeoutMs: 120_000,
    isConcurrencySafe() {
      return true;
    },
  };
}
