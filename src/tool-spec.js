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
      adaptive: {
        type: 'boolean',
        description: 'Default true: distribute cells by local cut density, so a fast-cutting stretch gets ' +
          'more cells than a static one. Set false for evenly spaced cells across the window — more ' +
          'predictable when you want to compare two windows cell-by-cell.',
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
      planThresholds: {
        type: 'object',
        description: 'Override the content-classification thresholds for this call. Defaults -18 / 1 / 3 ' +
          'are tuned on one master; loudness varies by up to 9 LU across material, so pass your own when ' +
          'the auto plan misfires. The values actually used are always printed in the manifest.',
        properties: {
          musicLufs: { type: 'number', description: 'Louder than this + low speech rate = music-driven' },
          musicSpeechRate: { type: 'number', description: 'Below this chars/s counts as music-like' },
          speechRateCut: { type: 'number', description: 'Above this chars/s, give the transcript more weight' },
        },
        additionalProperties: false,
      },
      ocr: {
        type: 'boolean',
        description: 'Correct ASR text against burned-in on-screen subtitles (local OCR, no extra tokens). ' +
          'Defaults to true when detail=high. Only helps when the video actually has hard-coded subtitles; ' +
          'silently skipped otherwise.',
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
    timeoutMs: 300_000,
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
      from: { type: 'number', description: 'Window start in seconds. Required unless cellId is given.' },
      to: { type: 'number', description: 'Window end in seconds. Required unless cellId is given.' },
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
      transcriptFile: {
        type: 'string',
        description: 'Path to an existing transcript (SRT, or JSON with [{start,end,text}] / '
          + '[{from,to,text}] / Bilibili {body:[{from,to,content}]}). Skips the subtitle track and ASR.',
      },
      detail: {
        type: 'string',
        enum: ['low', 'med', 'high'],
        description: 'Characters of transcript per cell: low=60, med=120 (default), high=400.',
      },
      cellId: {
        type: 'integer',
        description: 'Zoom by cell number from the last storyboard of this same input (e.g. 3 = the cell ' +
          'labelled 3 in the sheet). Resolves to that cell\'s absolute time range, so you never copy ' +
          'timestamps by hand. Falls back to an error if no cell map is recorded — then pass from/to.',
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
      scanHeight: {
        type: 'integer',
        description: 'For http(s) links: which resolution the downloaded scan copy uses (default 360). ' +
          'Only matters when zoom has to fall back to the local copy because the direct URL expired — ' +
          'raising it makes that fallback sharper at the cost of a bigger download.',
      },
      ocr: {
        type: 'boolean',
        description: 'Force hard-subtitle OCR correction on/off. Default: on only when detail is "high" ' +
          '(it costs ~3 s of local OCR). Set false to keep the raw ASR text even at high detail.',
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
  if (args.adaptive !== undefined && typeof args.adaptive !== 'boolean') {
    problems.push('adaptive must be a boolean');
  }
  if (args.ocr !== undefined && typeof args.ocr !== 'boolean') {
    problems.push('ocr must be a boolean');
  }
  return problems;
}

/** video_zoom 的兜底校验 */
export function validateZoomArgs(args) {
  const problems = [];
  if (!args?.input || typeof args.input !== 'string') problems.push('input is required');
  const hasCell = args?.cellId !== undefined && args?.cellId !== null;
  if (!hasCell) {
    if (!(args?.from >= 0)) problems.push('from is required and must be >= 0 (or pass cellId)');
    if (!(args?.to > 0)) problems.push('to is required and must be > 0 (or pass cellId)');
  } else if (!Number.isInteger(args.cellId) || args.cellId < 1) {
    problems.push('cellId must be a positive integer');
  }
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
  if (args.transcript !== undefined && !['auto', 'off'].includes(args.transcript)) {
    problems.push("transcript must be 'auto' or 'off'");
  }
  if (args.transcriptFile !== undefined
    && (typeof args.transcriptFile !== 'string' || args.transcriptFile.trim() === '')) {
    problems.push('transcriptFile must be a non-empty path');
  }
  if (args.detail !== undefined && !['low', 'med', 'high'].includes(args.detail)) {
    problems.push("detail must be 'low', 'med' or 'high'");
  }
  if (args.ocr !== undefined && typeof args.ocr !== 'boolean') {
    problems.push('ocr must be a boolean');
  }
  if (args.scanHeight !== undefined
    && (!Number.isInteger(args.scanHeight) || args.scanHeight < 120 || args.scanHeight > 2160)) {
    problems.push('scanHeight must be an integer 120..2160');
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
      cookies: { type: 'string', description: 'cookies.txt path for login-gated sources.' },
      allowAnonymous: { type: 'boolean', description: 'Allow anonymous fetches for links.' },
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

export const WATCH_TOOL_NAME = 'video_watch';

/**
 * 一起看：按用户的播放进度一段段往下看。
 *
 * 宿主侧定时调它（建议每 15–30 秒一次）：
 *   - 还没到交付点 → 返回一行状态，几乎不花 token，也不打断
 *   - 到了交付点（段末前 lead 秒）→ 返回这一段的**格子图 + 清单**
 * 第一次调它会现场算（8–10 s），之后同一段直接命中，所以用户感知到的延迟是 0。
 */
export function watchToolSpec() {
  return {
    name: WATCH_TOOL_NAME,
    description: [
      'Watch a video together with the user, batch by batch, following their playback position. Each call',
      'returns ONE batch as a storyboard image plus transcript - exactly what they just watched - or one line',
      'of status if that batch is not due yet.',
      '',
      'Do not poll on a timer. Either block (see COLD START / step 4) or call once per delivered batch.',
      '',
      'COLD START (you know nothing about the session yet):',
      '  1. If you are not sure anything is playing, say so IN THE SAME MESSAGE ("I will wait for the video",',
      '     the tool cannot speak while it blocks) and call:',
      '       video_watch({ waitForVideo: true, maxWaitSec: 120 })',
      '  2. Look at the batch the user is already in - do not wait for it to end:',
      '       video_watch({ speakNow: true })',
      '  3. Write the lines for that batch (see LINES), then:',
      '       video_watch({ wait: true })',
      '  4. It returns when that batch is nearly over. Repeat from 3 forever. The conversation never ends',
      '     between batches: the blocking call IS the pause.',
      '',
      'SPEECH. Every result carries `speech: [{ at, text, state }]` - your lines with their timestamps.',
      'The plugin itself never speaks: whether those lines are read out loud depends on whether the host has',
      'a voice consumer attached (a companion plugin, a system speech service, or your own tooling). If one is',
      'attached, the plugin hands each line over at the right playback moment and does NOT wake you - that is',
      'the zero-token path. If none is attached, the loop wakes you at the batch boundary and YOU say it.',
      'So: write the lines either way; do not try to make yourself the only voice.',
      '',
      'LINES (you write them; whoever is attached speaks them):',
      '  video_watch({ input, lines: [',
      '    { from: 180, at: 191, text: "钓上来了，池子里那条比他想的配合。" },',
      '    { from: 180, at: 214, text: "他一直在说饿，从昨天晚饭就空着。" }',
      '  ]})',
      '  from = the batch the line belongs to (the window start the reply named).',
      '  At cold start you are usually already inside a batch: write only for the cells that are still',
      '  ahead of the playhead. A line whose "at" is already behind is dropped, not read out.',
      '  at   = the exact second to speak it: use the frame@ time of the cell, NEVER the cell start.',
      '         BETTER: pass a substring of the transcript instead of a number, e.g. at: "1/4螺口" —',
      '         the plugin looks up its real start time. Hand-written seconds go badly wrong:',
      '         one batch was 58 s early because the anchors were guessed instead of looked up,',
      '         and the user saw the words describe something that had not happened yet.',
      '         pick:"sharp" takes the frame from anywhere in the cell, so frame@ can sit 75 s after the',
      '         start - anchoring on the start makes every line fire early, ahead of the shot it describes.',
      '',
      'A line is spoken only while playback time and its "at" agree within a few seconds. Late lines are',
      'dropped, never read out, so rewriting a batch after the user has watched it is pointless; consumed',
      'lines are deleted, so a rewind cannot replay the same words.',
      '',
      'THE LOOP, as rules:',
      '  - ONE batch per call. Never build or read two batches in one step; batches are short so the picture',
      '    arrives fast, and fusing them only delays the first words.',
      '  - After an image arrives, write that window\'s lines immediately. The reply names the window,',
      '    e.g. "[buffer] ... write lines for this range: 03:00-06:00, 06:00-10:00".',
      '  - Then block. Do not end the turn, do not set a timer, do not spawn a background job.',
      '',
      'When an image arrives, say at most one sentence of your own about what changed; do not retell the plot',
      'the user just watched. Silence is a valid answer - there is no quota.',
      '',
      'Position comes from the browser (CDP) and the OS media session (SMTC), so it works for browser playback',
      'and for local files in VLC / PotPlayer / Movies & TV. If it cannot be read, pass cursor yourself -',
      'do not guess.',
      '',
      'EVERY result now carries a `browser:` line, and it is the honest answer to "is the browser open?":',
      '  browser: open :9333 <title> playing 03:20   -> a real tab with a <video>, read from the DOM',
      '  browser: CLOSED :9333                       -> nothing is listening; the position (if any) is NOT from a browser',
      '  browser: open :9333 but NO tab is holding a <video>',
      '  browser: NOT configured                     -> only the OS media session can be read',
      'A playback position alone does NOT prove the browser is open: SMTC is system-wide, so VLC, Movies & TV or',
      'a SECOND browser window (started without a debug port) will happily provide one. When the user asks whether',
      'their browser is open, answer from the `browser:` line - never infer it from the position.',
      'If the plugin had to start a browser itself, the line says so: that instance is a fresh window with its own',
      'profile and no video open, and it is NOT the one the user is watching in.',
      'To check the browser without building anything, call video_watch({ statusOnly: true }) - it now returns a',
      '`browser` object as well.',
    ].join('\n'),
    // 宿主的 parameters 是**扁平 DSL**：每个字段一项，required 写在字段上，不是 JSON Schema 外壳
    parameters: {
      input: {
        type: 'string',
        description: 'Local path or Bilibili URL being watched. Omit to auto-detect: the plugin reads the title '
          + 'and duration from the OS media session, looks for a local file with that name, then falls back to '
          + 'a Bilibili search verified by duration. Only ask the user when both fail.',
      },
      cursor: {
        type: 'number',
        description: 'Where the user is, in seconds. Omit to read it from the OS media session (SMTC).',
      },
      segment: {
        type: 'number',
        description: 'Steady-state batch length in seconds (default 300 = 5 minutes). This is what the batch '
          + 'length settles to after the ramp-up.',
      },
      ramp: {
        type: 'array',
        items: { type: 'json' },
        description: 'Ramp-up schedule in seconds, e.g. [60, 120, 180, 240]. The first batches are short so '
          + 'the user gets a first comment quickly instead of waiting a full 5 minutes; each batch is longer '
          + 'than the last, then segment applies. Pass [] for uniform batches. Default [60,120,180,240] -> 300.',
      },
      lead: {
        type: 'number',
        description: 'How many seconds before the segment end to deliver it (default 15).',
      },
      cells: {
        type: 'number',
        description: 'Cells per segment sheet (default 5). Each segment is one image.',
      },
      stopLoop: {
        type: 'boolean',
        description: 'Stop the background watch loop (it wakes the session on its own). Idempotent.',
      },
      waitForRefill: {
        type: 'boolean',
        description: 'Block until the line stock drops below refillBelow (i.e. it is time to look at the next '
          + 'segment and write again). Returns which segments are missing. This is the loop the model should '
          + 'sit in: look, write, optionally check the clock, wait for stock to run low, look again.',
      },
      waitUntil: {
        type: 'number',
        description: 'Block until playback reaches this many seconds. Use it to check on the timeline just '
          + 'before the next segment without busy-waiting.',
      },
      attachOnly: {
        type: 'boolean',
        description: 'OPTIONAL. When true the plugin NEVER starts a browser of its own: if no '
          + 'playback position can be read, it returns an error instead of launching one. Use this '
          + 'when the user watches in their own browser and does not want another instance opened. '
          + 'It also skips navigating or opening tabs.',
      },
      wakeOnLinesEmpty: {
        type: 'boolean',
        description: 'OPTIONAL, off by default. Wake once when the current segment runs out of '
          + 'pre-written lines, so you can look at the picture and write the next batch. Useful '
          + 'whenever a voice consumer is attached: it keeps speaking your script, and without this '
          + 'you would not notice the script ran dry until the user says something.',
      },
      refillBelow: {
        type: 'number',
        description: 'OPTIONAL and off by default (0). If you set it, the loop wakes you when fewer than N '
          + 'upcoming segments still have pre-written lines. Most models do not need this: segment boundaries '
          + 'plus wait: true already say when it is time to look again.',
      },
      nextLine: {
        type: 'boolean',
        description: 'Say exactly one pre-written line, then return. The call blocks until the line is due, so '
          + 'each call becomes one visible message in the conversation - that is the point: the user should see '
          + 'you actually speak, at the right moment, not a script printing six sentences at once.',
      },
      everySec: {
        type: 'number',
        description: 'Spacing for nextLine (default 10 s). After each line the next call waits this long.',
      },
      // 说话频率**不设默认值**：不同模型有不同性格，写死只会让它变木讷。
      // 由调用方自己决定每段写几句、间隔多久。
      speakEvery: {
        type: 'number',
        description: 'High-frequency mode in seconds: the loop wakes you every N seconds regardless of batch '
          + 'boundaries (10 is fine). Pair it with video_watch({ speakNow: true }) inside the wake. Use 0 for '
          + 'the normal one-comment-per-batch rhythm.',
      },
      speakNow: {
        type: 'boolean',
        description: 'Deliver the current batch immediately instead of waiting for its end. This is what the '
          + 'high-frequency wake asks you to call.',
      },
      waitForVideo: {
        type: 'boolean',
        description: 'If nothing is playing yet, block until a video appears (browser tab or OS media '
          + 'session), then continue. IMPORTANT: tell the user you are waiting BEFORE calling - this call '
          + 'cannot speak while it blocks. It reports how long it waited.',
      },
      wait: {
        type: 'boolean',
        description: 'Block this call until the batch is actually due, then return the segment. This is the '
          + 'alternative to being woken by a timer: the turn stays open, the tool returns by itself when it is '
          + 'time to speak (default false).',
      },
      maxWaitSec: {
        type: 'number',
        description: 'Upper bound for wait: how long this call may block (default 180, max 600).',
      },
      checkCookies: {
        type: 'boolean',
        description: 'Diagnose the Bilibili login: asks the site directly whether the cookie is signed in, and '
          + '(if input is a video URL) whether its subtitle track can be fetched. Use it when the transcript '
          + 'is ASR but you suspect the video has subtitles.',
      },
      testWake: {
        type: 'boolean',
        description: 'Try to wake this session once, right now, and report exactly what happened '
          + '(session id, whether sessionController exists, whether prompt succeeded). Use it to check the wake '
          + 'path end to end without waiting for a due point.',
      },
      statusOnly: {
        type: 'boolean',
        description: 'Return the loop state only (position, confidence, why it did or did not speak) without '
          + 'reading the video, plus a `browser` object (state: unconfigured | closed | no-video | watching | error). '
          + 'Use this to answer "is their browser actually open / are they still watching?" without spending a '
          + 'segment build - and use it instead of inferring the browser from a playback position.',
      },
      lines: {
        type: 'array',
        items: { type: 'json' },
        description: 'Pre-written lines: [{ from: <segment start in seconds>, at: <second this line belongs to>, '
          + 'text: "<one sentence>" }]. '
          + '"at" is the moment on the playback clock that this sentence describes — the script speaks the line '
          + 'when the playhead reaches it. Pin it to the moment the picture was actually taken: use the cell\'s '
          + 'frame@ time, NOT its start. pick:"sharp" searches the whole cell for the sharpest frame, so frame@ '
          + 'usually sits near the END of the cell (a 50 s cell can report frame@ 45 s in) — anchoring at the cell '
          + 'start makes every line fire 20-70 s early, ahead of the shot it describes. '
          + 'Without "at" the line fires when its segment starts, which is rarely what you want. '
          + 'Recommended order: look at the picture FIRST (speakNow: true), then read the transcript lines for '
          + 'that window, then write what you actually want to say. Writing from subtitles alone makes you talk '
          + 'about what is said instead of what is shown. '
          + 'The background loop reads each line out on position, so nothing has to be generated at that moment, '
          + 'and pausing the video pauses the script. Only write them for the prefetched window (lookahead, '
          + 'default 5 minutes).',
      },
      depth: {
        type: 'number',
        description: 'How many batches to keep ready, counted in segments. Legacy: use lookahead instead. '
          + 'The batch table starts at 1/2/3/4 minutes, so "2 segments" means only 2 minutes of headroom at the '
          + 'beginning — which is why the default is now a duration, not a count.',
      },
      idleTimeoutSec: {
        type: 'number',
        description: 'How long playback has to sit still before the tool gives up, in seconds. '
          + 'Default is twice the longest batch (a 5-minute batch means 10 minutes) - long enough that '
          + 'buffering is not mistaken for walking away, short enough that it stops holding the session. '
          + 'Applies to the blocking wait and to the background loop.',
      },
      lookahead: {
        type: 'number',
        description: 'How much *time* to keep ready ahead of the playhead, in seconds (default 300 = 5 minutes). '
          + 'Short batches at the start are compensated for automatically (a 1/2/3-minute ramp needs three or '
          + 'four segments to cover five minutes), so the buffer never silently shrinks to two minutes. '
          + 'The window rolls forward as the user keeps watching, so a film abandoned halfway does not pay '
          + 'for the rest of itself.',
      },
      prefetch: {
        type: 'boolean',
        description: 'Build the look-ahead window in the background from this call (on by default). '
          + 'Set false if you want this call to touch nothing but the current batch.',
      },
      title: {
        type: 'string',
        description: 'Video title, used to pick the right media session when several are playing.',
      },
      browserPort: {
        type: 'integer',
        description: 'Per-call CDP debug port for the browser holding the video (e.g. 9333). ' +
          'Overrides ~/.dsh/video.json and DSH_BROWSER_DEBUG_PORT for this call.',
      },
      say: {
        type: 'string',
        description: 'Say this NOW, in your own words. It is appended to the shared chat stream ' +
          '(the same timeline the user sees) and handed to whoever listens for speech, so it is ' +
          'spoken and displayed exactly like a scripted line. Use it to answer an interjection: the ' +
          'plugin cannot see your normal reply, so without this the chat box shows only the script.',
      },
      loop: {
        type: 'boolean',
        description: 'Default true: after this call, keep a background loop running so each new segment ' +
          'wakes the session on its own. Set false to drive everything by hand — you call video_watch ' +
          'again whenever you want the next segment, and nothing wakes you in between.',
      },
      detail: {
        type: 'string',
        enum: ['low', 'med', 'high'],
        description: 'How much transcript per cell in this segment: low=60 chars, med=120 (default), '
          + 'high=400 (quote-level, and it turns on hard-subtitle OCR correction). '
          + 'Same scale as video_storyboard — the picture does not get sharper, the text does. '
          + 'Raise cells instead if what you want is more pictures.',
      },
      ocr: {
        type: 'boolean',
        description: 'Correct the transcript against burned-in subtitles (local OCR, no tokens). '
          + 'Defaults to true when detail=high. Costs ~3 s per segment, so it is off otherwise.',
      },
      transcript: {
        type: 'string',
        enum: ['auto', 'off'],
        description: 'auto (default) transcribes each segment; off skips speech entirely.',
      },
      cookies: { type: 'string', description: 'cookies.txt path for login-gated sources.' },
      allowAnonymous: { type: 'boolean', description: 'Allow anonymous fetches for links.' },
    },
    // 和 zoom 同一套输出形态：图片在前、文本在后。没有这一段工具注册不起来。
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
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
    // 阻塞等待最长 600 s，工具超时必须比它宽，否则会被宿主先掐断
    timeoutMs: 900_000,
    isConcurrencySafe() {
      return false;    // 读同一个会话的指针，不能并发
    },
  };
}

export function validateWatchArgs(args) {
  const problems = [];
  // input 可省略 —— 省略时从系统媒体控件读"在播什么"，再反查源
  if (args?.input !== undefined && (typeof args.input !== 'string' || args.input.trim() === '')) {
    problems.push('input must be a non-empty path or URL when given (omit it to auto-detect)');
  }
  if (args?.cursor !== undefined && !(args.cursor >= 0)) problems.push('cursor must be >= 0');
  if (args?.segment !== undefined && !(args.segment >= 20)) problems.push('segment must be >= 20 seconds');
  if (args?.lead !== undefined && !(args.lead >= 0)) problems.push('lead must be >= 0');
  const seg = args?.segment ?? 120;
  const lead = args?.lead ?? 15;
  if (lead >= seg) problems.push('lead must be smaller than segment, otherwise every call delivers immediately');
  if (args?.cells !== undefined && (!Number.isInteger(args.cells) || args.cells < 1 || args.cells > 9)) {
    problems.push('cells must be an integer 1..9');
  }
  if (args?.detail !== undefined && !['low', 'med', 'high'].includes(args.detail)) {
    problems.push('detail must be one of low|med|high');
  }
  if (args?.browserPort !== undefined
    && (!Number.isInteger(args.browserPort) || args.browserPort < 1 || args.browserPort > 65535)) {
    problems.push('browserPort must be an integer 1..65535');
  }
  if (args?.loop !== undefined && typeof args.loop !== 'boolean') {
    problems.push('loop must be a boolean');
  }
  if (args?.say !== undefined && (typeof args.say !== 'string' || args.say.trim() === '')) {
    problems.push('say must be a non-empty string');
  }
  // 台词：at 必须在它所属的段里，否则这句永远不会到点（dueLine 只认 from <= 当前位置 的槽）
  if (Array.isArray(args?.lines)) {
    args.lines.forEach((l, i) => {
      if (!(Number(l?.from) >= 0)) {
        problems.push(`lines[${i}].from must be >= 0`);
      } else if (l?.at !== undefined && !(Number(l.at) >= Number(l.from))) {
        problems.push(`lines[${i}].at (${l.at}) must be >= its from (${l.from})`);
      }
    });
  }
  return problems;
}
