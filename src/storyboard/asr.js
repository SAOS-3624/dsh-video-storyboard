/**
 * asr.js — 台词层。三级降级（学 dsh-video-lens 的"additive"原则）：
 *
 *   1. 视频自带字幕轨 → 直接抽（零成本、最准）
 *   2. 用户配置了 OpenAI 兼容的 /audio/transcriptions → 调它（默认 SenseVoiceSmall）
 *   3. 都没有 → 返回 null，**绝不让整个分镜失败**
 *
 * 注意：ASR 只解释"人说了什么"，对纯音乐无能为力，也可能对音乐段落产生幻觉歌词。
 * 所以 transcribe 会跳过明显的非语音段（由静音检测给出）。
 */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { DEFAULT_FFMPEG } from './probe.js';

const run = promisify(execFile);

/**
 * 桌面版 DSH 的进程 env 由启动器决定：用户 setx 之后宿主进程里仍然没有 DSH_ASR_KEY
 * （实测 `ops_bash` 子进程继承了宿主的 DSH_* 变量，唯独没有这两个）。所以再给一条
 * 不依赖 env 的路 —— 读 $DSH_HOME/asr.json：
 *
 *   { "baseUrl": "http://127.0.0.1:8000/v1", "key": "local-key", "model": "...", "language": "zh" }
 *
 * 优先级：环境变量 > $DSH_HOME/asr.json > 内置默认（SiliconFlow）。
 */
function readConfigFile(env) {
  // DSH_HOME 一旦显式给了，就**只认它**：否则"指到一个空目录"会和"没指"完全等价，
  // 测试里想隔离本机配置根本做不到（实测：设了空 DSH_HOME 仍然读到了 ~/.dsh/asr.json）。
  const candidates = env.DSH_HOME
    ? [join(env.DSH_HOME, 'asr.json')]
    : [join(homedir(), '.dsh', 'asr.json')];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    // 文件存在但坏了：直接当成"没有配置"，不要再穿透到下一个候选，
    // 否则 $DSH_HOME 里的坏配置会被 ~/.dsh 的那份悄悄顶替掉，排查时看不出问题。
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      if (parsed && typeof parsed === 'object') return { ...parsed, path };
    } catch {
      return {};
    }
    return {};
  }
  return {};
}

/**
 * 解析 ASR 配置。优先级：**环境变量 > $DSH_HOME/asr.json > 内置默认**。
 *
 * 为什么要读文件：桌面版 DSH 的进程 env 由启动器决定，用户 setx 之后宿主进程里
 * 仍然读不到 `DSH_ASR_KEY`（实测 `ops_bash` 子进程继承了 DSH_* 变量，唯独没有这两个）。
 * 文件路径不依赖 env 传播，是更可靠的一层。
 *
 * @returns {{baseUrl:string, model:string, keyEnv:string, language:string, fileKey?:string, source:'env'|'file'|'default', configPath?:string}}
 */
/**
 * env 里的值可能带着引号。真实事故：Windows 上 `setx DSH_ASR_BASE_URL "http://127.0.0.1:8000/v1"`
 * 经过某些 shell 转发后，注册表里存的是 `"http://127.0.0.1:8000/v1"`（**引号是值的一部分**），
 * 于是 `fetch('"http://..."' + '/audio/transcriptions')` 直接
 * `ERR_INVALID_URL: Invalid URL`。这种错误看起来像"配置没生效"，其实是配置生效了但值坏了一点点。
 * 所以读 env 时统一剥掉首尾成对的引号与空白。
 */
/** baseUrl 指向本机时，ASR 不需要 key */
export function isLoopback(baseUrl) {
  try {
    const h = new URL(String(baseUrl)).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '0.0.0.0';
  } catch {
    return false;
  }
}

export function cleanEnvValue(v) {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (t.length >= 2 && /^(["']).*\1$/.test(t)) return t.slice(1, -1).trim();
  return t;
}

/** 云端（非本机）且没给 key —— 这一种情况才必然跳过。`transcribe()` 的门就是这一句。 */
export function needsCloudKey(baseUrl, key) {
  return !key && !isLoopback(baseUrl);
}

/** 这次调用实际会用的 key：undefined = 走 env / asr.json；显式值（含 null / ''）= 调用方说了算。 */
export function effectiveAsrKey(cfg = ASR_DEFAULTS, apiKey) {
  return apiKey === undefined
    ? cleanEnvValue(process.env[cfg.keyEnv]) || cfg.fileKey
    : apiKey;
}

/**
 * 这次调用会不会真的转写。
 *
 * 判据不能只看"有没有 key"：0.4.1 起本机服务（127.0.0.1 / localhost / [::1] / 0.0.0.0）按设计
 * **不需要 key**，只看 key 就会把"本机 ASR 正在跑"误判成"没配 → 不会转写"。所以必须和
 * `transcribe()` 的门用同一句话，否则清单与实际行为会朝反方向偏差。
 */
export function canTranscribe(cfg = ASR_DEFAULTS, apiKey) {
  return !needsCloudKey(cfg.baseUrl, effectiveAsrKey(cfg, apiKey));
}

export function resolveAsrConfig(env = process.env) {
  const file = readConfigFile(env);
  const envBaseUrl = cleanEnvValue(env.DSH_ASR_BASE_URL);
  const envModel = cleanEnvValue(env.DSH_ASR_MODEL);
  const envLanguage = cleanEnvValue(env.DSH_ASR_LANG);
  const keyEnv = cleanEnvValue(env.DSH_ASR_KEY_ENV) || 'DSH_ASR_KEY';
  const fromEnv = Boolean(envBaseUrl || env[keyEnv]);
  return {
    baseUrl: envBaseUrl || file.baseUrl || 'https://api.siliconflow.cn/v1',
    model: envModel || file.model || 'FunAudioLLM/SenseVoiceSmall',
    keyEnv,
    language: envLanguage || file.language || 'zh',
    fileKey: typeof file.key === 'string' && file.key ? file.key : undefined,
    source: fromEnv ? 'env' : (file.baseUrl || file.key ? 'file' : 'default'),
    // 术语校正表：错误写法 → 正确写法
    terms: file.terms && typeof file.terms === 'object' ? file.terms : undefined,
    // 热词：空格分隔的一串词，交给 seaco_paraformer 解码时偏置
    hotwords: typeof file.hotwords === 'string' && file.hotwords.trim() ? file.hotwords.trim() : '',
    terms: file.terms && typeof file.terms === 'object' ? file.terms : undefined,
    // 生命周期托管：{ start, stop?, idleMs?, waitMs? } —— 见 asr-lifecycle.js
    manage: file.manage && typeof file.manage === 'object' ? file.manage : undefined,
    ...(file.path ? { configPath: file.path } : {}),
  };
}

export const ASR_DEFAULTS = resolveAsrConfig();

/** 一句话说明"我们在往哪儿发请求"，用于把错误信息变得可定位（永远不含 key） */
export function describeAsrTarget(cfg = ASR_DEFAULTS) {
  const where = cfg.source === 'file' && cfg.configPath ? `${cfg.source} (${cfg.configPath})` : cfg.source;
  return `${cfg.baseUrl} · model ${cfg.model} · config ${where}`;
}

/** 把 Node 的 fetch 错误展开成可读原因（fetch failed 本身什么都不说） */
export function explainFetchError(error) {
  const parts = [String(error?.message ?? error)];
  const cause = error?.cause;
  if (cause) {
    const code = cause.code || cause.errno || '';
    const msg = cause.message || String(cause);
    if (msg && msg !== parts[0]) parts.push(`${code ? `${code}: ` : ''}${msg}`.trim());
  }
  return parts.join(' — ');
}

const SRT_RE = /(\d+)\s*\n(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*\n([\s\S]*?)(?=\n\s*\n|\s*$)/g;

/** 解析 SRT 文本 → [{from,to,text}] */
export function parseSrt(text) {
  const out = [];
  const src = String(text).replace(/\r\n/g, '\n').trim();
  for (const m of src.matchAll(SRT_RE)) {
    const toSec = (h, mi, s, ms) => (+h) * 3600 + (+mi) * 60 + (+s) + (+ms) / 1000;
    const from = toSec(m[2], m[3], m[4], m[5]);
    const to = toSec(m[6], m[7], m[8], m[9]);
    const body = m[10].split('\n').map((l) => l.trim()).filter(Boolean).join(' ');
    if (body) out.push({ from, to, text: body });
  }
  return out;
}

/** 从容器里抽字幕轨（有就直接用，比 ASR 准且免费） */
export async function extractSubtitleTrack({ input, ffmpegPath = DEFAULT_FFMPEG, timeoutMs = 60_000 } = {}) {
  try {
    const { stdout } = await run(ffmpegPath, [
      '-hide_banner', '-v', 'error', '-nostdin', '-i', input,
      '-map', '0:s:0', '-f', 'srt', '-',
    ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: timeoutMs });
    const segments = parseSrt(stdout);
    return segments.length > 0 ? segments : null;
  } catch {
    return null;                                  // 没有字幕轨就是常态，不算错误
  }
}

/**
 * 调 OpenAI 兼容的转写接口。
 * @returns {Promise<{segments:Array<{from:number,to:number,text:string}>, model:string, language?:string}|null>}
 */
export async function transcribe({
  input, ffmpegPath = DEFAULT_FFMPEG, start = 0, end,
  baseUrl = ASR_DEFAULTS.baseUrl, model = ASR_DEFAULTS.model,
  hotwords = resolveAsrConfig().hotwords,
  apiKey,
  language = ASR_DEFAULTS.language,
  timeoutMs = 180_000,
} = {}) {
  // undefined = 走 env/文件；显式传 null 或 '' = 明确不要 key（测试与"关掉 ASR"都用这个）
  const key = effectiveAsrKey(ASR_DEFAULTS, apiKey);
  // **本机服务不该强制要 key**：自己跑的 FunASR / whisper.cpp / faster-whisper 服务
  // 通常不校验 Authorization，逼用户填一个假 key 只会让"能不能用"取决于文档写没写清。
  // 云端才必须 key（没有它必然 401）。
  if (needsCloudKey(baseUrl, key)) return null;    // 云端没配 key：跳过，不报错

  // 抽成 16k 单声道 wav（16k 是 ASR 的通用采样率，体积也可控）
  const args = [ffmpegPath, '-hide_banner', '-v', 'error', '-nostdin'];
  if (start > 0) args.push('-ss', String(start));
  if (end !== undefined) args.push('-t', String(Math.max(0.1, end - start)));
  args.push('-i', input, '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', '-');
  const { stdout } = await run(args[0], args.slice(1), {
    encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, timeout: timeoutMs,
  });
  if (stdout.length < 1024) return null;

  const form = new FormData();
  form.append('file', new Blob([stdout], { type: 'audio/wav' }), 'audio.wav');
  form.append('model', model);
  form.append('response_format', 'verbose_json');
  // 热词：专治同音字（实测"像差"会被识别成"相差"）。服务端不认识这个字段时会忽略，不会报错。
  if (hotwords) form.append('hotword', hotwords);
  if (language) form.append('language', language);

  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/audio/transcriptions`, {
    method: 'POST',
    headers: key ? { Authorization: `Bearer ${key}` } : {},
    body: form,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`ASR ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  const actualModel = typeof json.model === 'string' && json.model ? json.model : model;
  const raw = Array.isArray(json.segments) ? json.segments : [];
  const segments = raw.map((s) => ({
    from: +(Number(s.start) + start).toFixed(3),
    to: +(Number(s.end) + start).toFixed(3),
    text: String(s.text ?? '').trim(),
  })).filter((s) => s.text);

  if (segments.length === 0 && json.text) {
    // 没有分段信息：退化成"整段一句"，至少能放在对应的格子里
    return {
      segments: [{ from: start, to: end ?? start + 1, text: String(json.text).trim() }],
      model: actualModel, language: json.language ?? language,
    };
  }
  return { segments, model: actualModel, language: json.language ?? language };
}

/**
 * 把台词按时间重叠贴到每一格上。
 * 一句跨两格时两边都保留（宁可重复，也别让某一格"没话说"）。
 */
/** `10:09.4` —— 内联时间戳用，比 `00:10:09.40` 省一半字符 */
export function shortStamp(seconds) {
  const t = Math.max(0, Number(seconds) || 0);
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

/** 相邻两句之间出现这么长的静默，就认为格内存在一个"断点"，值得标出来 */
export const CELL_BREAK_GAP = 1.0;

/**
 * 把台词贴到格子上。
 *
 * **不再是简单 join。** 一格常常跨两三句，而 `join(' ')` 抹掉了每句自己的起点 ——
 * 模型只能拿 `cell.from` 当整段的锚点，结果整段被提前几十秒（实测被错位 30s）。
 *
 * 折中做法：只在**真有断点**的地方插内联时间戳（相邻句间隔 ≥ CELL_BREAK_GAP），
 * 而不是每句都插 —— 每句都插会让 120 字的台词预算被 `[10:09.4]` 吃掉四分之一。
 * 同时把 `lines`（每条带自己的 from/to）留给渲染层，将来要"一格多行"不必再改这里。
 */
export function alignCells(cells, segments) {
  return cells.map((cell) => {
    const hits = segments.filter((s) => s.to > cell.from && s.from < cell.to);
    const parts = [];
    for (let i = 0; i < hits.length; i++) {
      if (i > 0 && hits[i].from - hits[i - 1].to >= CELL_BREAK_GAP) {
        parts.push(`[${shortStamp(hits[i].from)}]`);
      }
      parts.push(hits[i].text);
    }
    const text = parts.join(' ').trim();
    const dur = Math.max(0.1, cell.to - cell.from);
    return {
      text,
      chars: text.length,
      charsPerSec: +(text.length / dur).toFixed(2),
      segments: hits.length,
      // 每句自己的时间轴：信息本来就有，之前被 join 丢掉了
      lines: hits.map((s) => ({
        from: +Number(s.from).toFixed(2),
        to: +Number(s.to).toFixed(2),
        text: s.text,
      })),
      // 格内存在断点时为 true —— 渲染层可以据此提示"这一格跨了两件事"
      broken: hits.length > 1 && hits.some((s, i) => i > 0 && s.from - hits[i - 1].to >= CELL_BREAK_GAP),
    };
  });
}

/**
 * 把 [start, end] 切成若干不超过 maxChunk 秒的请求窗口，**切点优先落在静音中间**。
 *
 * 为什么客户端也要切：实测 SEACO-Paraformer 单次请求 299s 会把时间码压早 13s
 * （约 4.5% 压缩，像是把停顿吃掉了）。这个行为和"服务端实现"无关，任何不认识的后端
 * 都可能这样，所以必须在**调用侧**给上限。
 *
 * 为什么切在静音而不是固定 45s：固定切会把词劈成两半（实测多出 2 个碎段），
 * 而静音处切开既不掉字，也不会让一句话跨请求。
 */
export function chunkWindows({ start, end, silences = [], maxChunk = 45, minChunk = 8 }) {
  const from0 = Number(start) || 0;
  const to0 = Number(end);
  if (!(to0 > from0)) throw new RangeError('end must be greater than start');
  const total = to0 - from0;
  if (total <= maxChunk) return [{ from: from0, to: to0 }];

  // 候选切点：静音中点；没有静音就用固定步长
  const mids = silences
    .map((s) => (Math.max(from0, s.from) + Math.min(to0, s.to)) / 2)
    .filter((m) => m > from0 && m < to0)
    .sort((a, b) => a - b);

  const windows = [];
  let cursor = from0;
  while (to0 - cursor > maxChunk) {
    const ideal = cursor + maxChunk;
    const lower = cursor + Math.max(minChunk, maxChunk * 0.5);
    const candidate = mids
      .filter((m) => m > lower && m <= ideal)
      .at(-1);
    const cut = candidate ?? ideal;
    windows.push({ from: cursor, to: cut });
    cursor = cut;
  }
  windows.push({ from: cursor, to: to0 });
  return windows;
}

/** 合并相邻段：同一个词被两次请求各识别一次时只留一个 */
export function mergeSegments(segments, { gap = 0.5 } = {}) {
  const sorted = [...segments].sort((a, b) => a.from - b.from || a.to - b.to);
  const out = [];
  for (const seg of sorted) {
    const last = out.at(-1);
    // 跨片重复：同一句在上一片的尾巴和这一片的开头各出现一次 → 合并成一条
    if (last && last.text === seg.text && seg.from <= last.to + gap) {
      last.to = Math.max(last.to, seg.to);
      continue;
    }
    out.push({ ...seg });
  }
  return out;
}

/**
 * 长音频转写：按 ≤maxChunk 秒切片、逐片调用、把片偏移加回去。
 * 片与片之间用静音对齐，所以不需要重叠（重叠还得去重，反而更容易出错）。
 */
export async function transcribeLong(options = {}) {
  const { start = 0, end, silences = [], maxChunk = 45, ...rest } = options;
  if (!(end > start)) throw new RangeError('end must be greater than start');
  const windows = chunkWindows({ start, end, silences, maxChunk });
  // 单窗口：transcribe 自己是 null 就 null，是空段就空段 —— 下面统一补 `empty` 标记
  if (windows.length === 1) {
    const only = await transcribe({ ...rest, start, end });
    return only ? { ...only, empty: only.segments.length === 0 } : null;
  }

  const all = [];
  let model = null;
  let language = null;
  let ran = 0;                                    // 真正跑起来的片数（云端没配 key 时会是 0）
  for (const win of windows) {
    const part = await transcribe({ ...rest, start: win.from, end: win.to });
    if (!part) continue;
    ran += 1;
    model = part.model ?? model;
    language = part.language ?? language;
    all.push(...part.segments);
  }
  // 一片都没跑起来 → 分两种，不能混为一谈：
  //  - 云端没配 key：ASR 根本没发生过 → null，上层走"没跑"分支；
  //  - 配了 key（或本机服务）却没听到任何字：那是**真的**"跑了但没结果" → 交给 `empty`，
  //    上层会写 asr-empty。绝不能反过来把"没跑"写成"跑了没听到话"（0.4.2 之前就是这么写的）。
  // 判据用**这次实际要发的地址**：调用方可以显式给 baseUrl（本机服务走这条路）。
  const target = { ...ASR_DEFAULTS, baseUrl: rest.baseUrl ?? ASR_DEFAULTS.baseUrl };
  if (ran === 0 && !canTranscribe(target, rest.apiKey)) return null;
  const merged = mergeSegments(all);
  return { segments: merged, model, language, chunks: windows.length, empty: merged.length === 0 };
}

/**
 * 过滤"疑似音乐段幻觉"。
 *
 * 背景（实测）：概念 PV 只有一句真台词，但 ASR 在纯音乐段吐出一条
 * `45.35–74.33`（29 秒、9 个字）的假句子。`alignCells` 按时间重叠贴，
 * 这一条会命中 5 个格子，把同一句垃圾复制五遍——比直接丢掉更糟。
 *
 * 两条判据：
 *  - **长时段 + 极低字/秒**：正常口播 2–6 字/秒（实测三条素材：5.60 / 2.07 / 0.32），
 *    超过 8 秒却不到 0.8 字/秒，几乎必然是音乐/噪声被"翻译"成了字；
 *  - **没有实义字符**：只剩标点或空白的段直接丢。
 *
 * 丢掉的段不贴到格子，但会在清单里报出来——过滤不能变成静默丢数据。
 */
export function filterSuspectSegments(segments, { minDur = 8, minCharsPerSec = 0.8 } = {}) {
  const kept = [];
  const dropped = [];
  for (const seg of segments ?? []) {
    const dur = Math.max(0.1, seg.to - seg.from);
    const text = String(seg.text ?? '').trim();
    const meaningful = text.replace(/[\s\p{P}\p{S}]/gu, '').length;
    if (meaningful === 0) {
      dropped.push({ ...seg, reason: 'punctuation-only', charsPerSec: 0 });
      continue;
    }
    const cps = meaningful / dur;
    if (dur > minDur && cps < minCharsPerSec) {
      dropped.push({ ...seg, reason: 'music-like', charsPerSec: +cps.toFixed(2) });
      continue;
    }
    kept.push(seg);
  }
  return { kept, dropped };
}

/**
 * 术语校正表。
 *
 * 实测 ASR 对专业名词必错（`彗差→绘插`、`八羽怪→巴与怪`、`沧野→苍野`、`收光圈→烧光圈`）。
 * 与其让模型自己猜，不如给一份用户词典做**确定性替换**，并把替换次数报出来（不静默改写原文）。
 *
 * 长词优先匹配，避免 `像散` 被 `像` 抢先替换掉。
 *
 * @param {Array<{text:string}>} segments
 * @param {Record<string,string>} terms 错误写法 → 正确写法
 * @returns {{segments:Array, replaced:number, touched:number}}
 */
export function applyTermMap(segments, terms) {
  const entries = Object.entries(terms ?? {})
    .filter(([from, to]) => typeof from === 'string' && from && typeof to === 'string');
  if (entries.length === 0) return { segments: segments ?? [], replaced: 0, touched: 0 };

  // 一次扫描、单遍替换：用"长词优先"的交替式正则，避免替换出来的新文本被后面的短词二次命中
  // （踩过：像散→像散(AST) 之后，"像"又把新文本里的"像"替换掉）
  const map = new Map(entries);
  const pattern = entries
    .map(([from]) => from)
    .sort((a, b) => b.length - a.length)
    .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const re = new RegExp(pattern, 'g');

  let replaced = 0;
  let touched = 0;
  const out = (segments ?? []).map((seg) => {
    const text = String(seg.text ?? '');
    let hit = false;
    const next = text.replace(re, (m) => {
      replaced += 1;
      hit = true;
      return map.get(m) ?? m;
    });
    if (!hit) return seg;
    touched += 1;
    return { ...seg, text: next };
  });
  return { segments: out, replaced, touched };
}

/** 语音密度曲线：每秒字数，按 bin 采样（供 planCellRanges 当第三条密度信号） */
export function speechCurve(segments, { duration, bin = 0.1 }) {
  const bins = Math.max(1, Math.ceil(duration / bin));
  const out = new Float64Array(bins);
  if (!segments?.length) return { bins, curve: out, mean: 0 };
  for (const s of segments) {
    const a = Math.max(0, Math.floor(s.from / bin));
    const b = Math.min(bins, Math.ceil(s.to / bin));
    const len = Math.max(1, b - a);
    const per = s.text.length / len;
    for (let i = a; i < b; i++) out[i] += per;
  }
  const mean = out.reduce((x, y) => x + y, 0) / bins;
  return { bins, curve: out, mean };
}
