/**
 * tts.js — 让**脚本**把台词念出来，不经过模型。
 *
 * 为什么要这一层：台词是提前写好的，让模型"等到点、再输出一遍"纯属浪费——
 * 等待期间模型被占着，输出还要花 token，而它说的每一个字早在几分钟前就定好了。
 *
 * 把这件事交给系统 TTS 之后：
 *   - 时间点由脚本守着（毫秒级，比模型自觉准）
 *   - 说话不花 token、不占上下文
 *   - 模型的时间全部留给"看画面、想点什么"——那才是它真正值钱的部分
 *
 * 走 Windows 自带的 SAPI（`SAPI.SpVoice`）。中文声音本机已装：
 *   Microsoft Huihui Desktop / Microsoft Yaoyao / Microsoft Kangkang
 * 注意：**不要用 Add-Type**（安全策略会拦），用 COM 对象即可。
 */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

/** 本机常见的中文声音，按偏好排序 */
export const PREFERRED_VOICES = [
  'Microsoft Huihui Desktop',
  'Microsoft Yaoyao',
  'Microsoft Kangkang',
  'Microsoft Huihui',
];

/**
 * 把文本转成 PowerShell 单引号字面量。
 * 单引号字符串里唯一需要处理的就是单引号本身：写两遍。
 * 换行/反引号/美元符号在单引号里都是字面量，不用管。
 */
export function psLiteral(text) {
  return `'${String(text ?? '').replace(/'/g, "''")}'`;
}

/** 生成"念一句"的 PowerShell 命令（不执行，便于测试与排查） */
export function buildSpeakCommand({ text, voice = null, rate = 0, volume = 100 } = {}) {
  const parts = [
    '$v = New-Object -ComObject SAPI.SpVoice',
    `$v.Rate = ${Number.isFinite(rate) ? Math.max(-10, Math.min(10, rate)) : 0}`,
    `$v.Volume = ${Number.isFinite(volume) ? Math.max(0, Math.min(100, volume)) : 100}`,
  ];
  if (voice) {
    // 选声音失败不该影响念内容，所以吞掉异常
    parts.push(`try { $v.Voice = $v.GetVoices() | Where-Object { $_.GetDescription() -like ${psLiteral(`*${voice}*`)} } | Select-Object -First 1 } catch { }`);
  }
  parts.push(`$null = $v.Speak(${psLiteral(text)})`);
  return parts.join('; ');
}

/**
 * 把"人话里的音色"映射成 edge-tts 的 Neural 名。
 *
 * 为什么要映射：`voice` 原来只认 SAPI 的 `GetDescription()` 片段（Huihui / Yaoyao / Kangkang），
 * 传 `zh-CN-XiaoxuanNeural` 进去匹配不到任何 SAPI 声音，**静默回落到系统默认** ——
 * 于是"传了等于没传"，用户听到的永远是同一个声音。
 */
const EDGE_VOICE_MAP = [
  [/huihui/i, 'zh-CN-XiaoxuanNeural'],      // 默认音色 -> 用户点名的 Xiaoxuan
  [/yaoyao/i, 'zh-CN-XiaoyiNeural'],
  [/kangkang/i, 'zh-CN-YunjianNeural'],
  [/xiaoxuan/i, 'zh-CN-XiaoxuanNeural'],
  [/xiaoxiao/i, 'zh-CN-XiaoxiaoNeural'],
  [/yunxi/i, 'zh-CN-YunxiNeural'],
  [/yunjian/i, 'zh-CN-YunjianNeural'],
];

export function edgeVoiceFor(voice, env = process.env) {
  const cfg = configuredDshTts(env);
  const fallback = cfg?.voice || 'zh-CN-XiaoxiaoNeural';
  const s = String(voice ?? '').trim();
  if (!s) return fallback;
  if (/^[a-z]{2,3}-[A-Z]{2}-[A-Za-z]+Neural$/.test(s)) return s;   // 已经是 neural 名
  for (const [re, v] of EDGE_VOICE_MAP) if (re.test(s)) return v;
  return fallback;
}

/** 真正念出来（异步，等它念完再 resolve；失败不抛，返回原因） */
export async function speak(text, {
  voice = PREFERRED_VOICES[0], rate = 0, volume = 100, timeoutMs = 30_000,
  dryRun = false, engine = null,
} = {}) {
  // **edge-tts 优先**：SAPI 那三个中文声音是十年前的拼接合成，一听就是导航软件。
  // 合成或播放失败（多半是断网 / 没装）才退回 SAPI —— 念台词不能因此哑掉。
  // dryRun 不进这条路：它要的是"生成的命令长什么样"，那是 SAPI 的概念。
  if (!dryRun && engine !== 'sapi') {
    const exe = defaultEdgeTtsBin();
    if (exe) {
      const r = await speakViaEdgeTts(text, {
        voice: edgeVoiceFor(voice), bin: exe, rate, timeoutMs: Math.max(timeoutMs, 60_000),
      });
      if (r.ok) return r;
    }
  }

  const command = buildSpeakCommand({ text, voice, rate, volume });
  if (dryRun) return { ok: true, dryRun: true, command };
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', command],
      { timeout: timeoutMs, windowsHide: true }, (err, _stdout, stderr) => {
        if (err) resolve({ ok: false, reason: String(stderr || err.message).slice(0, 200) });
        else resolve({ ok: true, engine: 'sapi' });
      });
  });
}


/* ------------------------------------------------- DSH TTS 插件（edge-tts） */

/**
 * DSH 里装的那个 `@memef1f1y/dsh-plugin-tts` 走的是 **edge-tts**，音色比本机 SAPI 好太多
 * （`zh-CN-XiaoxuanNeural` 这类神经音色，不是 Huihui 那种机械声）。
 *
 * 它把接口挂在 DSH 的 webServer 上：
 *   POST {endpoint}/dsh-tts-api/speak  { text, voice, provider }
 *   → 短文本：**直接回音频字节流**（mp3，实测 content-type 为空）
 *   → 长文本：回 { url }，分块在后台合成
 * 两种都要处理，只看 content-type 会判断错（实测就是空的）。
 *
 * 所以这里能做的是：要到 url，然后用 ffplay 播。拿不到就安静地退回 SAPI —— 念台词这件事
 * 不能因为"音色插件没开"就整个哑掉。
 *
 * 配置（任选其一，DSH_HOME 默认 ~/.dsh）：
 *   ~/.dsh/tts.json     { "endpoint": "http://127.0.0.1:PORT", "voice": "zh-CN-XiaoxuanNeural" }
 *   ~/.dsh/video.json   { "tts": { "endpoint": "...", "voice": "..." } }
 */
export function configuredDshTts(env = process.env) {
  const home = env.DSH_HOME || join(env.USERPROFILE || env.HOME || homedir(), '.dsh');
  try {
    const j = JSON.parse(readFileSync(join(home, 'tts.json'), 'utf8'));
    if (j?.endpoint) return j;
  } catch { /* 没有就试下一个 */ }
  try {
    const j = JSON.parse(readFileSync(join(home, 'video.json'), 'utf8'));
    if (j?.tts?.endpoint) return j.tts;
  } catch { /* 没有就算了 */ }
  return null;
}

/** 这个端点上有没有 DSH 的 tts 接口（空 body 会返回 400，但路由存在就说明找对了） */
export async function dshTtsAlive(endpoint, timeoutMs = 1500) {
  if (!endpoint) return false;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(`${endpoint.replace(/\/+$/, '')}/dsh-tts-api/speak`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: ac.signal,
    });
    // 400 = 路由在、只是文本为空；其他 2xx 也算活着
    return r.ok || r.status === 400;
  } catch { return false; } finally { clearTimeout(timer); }
}

/** 用 DSH 的 tts 插件念一句（返回 {ok, url} 或 {ok:false, reason}） */
export async function speakViaDsh(text, {
  endpoint, voice = 'zh-CN-XiaoxuanNeural', provider = 'edge-tts', timeoutMs = 45_000, dryRun = false,
} = {}) {
  if (!endpoint) return { ok: false, reason: 'no-endpoint' };
  const base = endpoint.replace(/\/+$/, '');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let url = null;
  let tmpFile = null;
  try {
    const r = await fetch(`${base}/dsh-tts-api/speak`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, voice, provider }),
      signal: ac.signal,
    });
    if (!r.ok) return { ok: false, reason: `http-${r.status}` };
    const buf = Buffer.from(await r.arrayBuffer());
    // 短文本直接回音频字节（content-type 可能是空的），长文本才回 { url }
    const looksJson = buf.length > 1 && buf.length < 8192 && buf[0] === 0x7b;   // '{'
    if (looksJson) {
      const j = JSON.parse(buf.toString('utf8'));
      url = j?.url ? (String(j.url).startsWith('http') ? j.url : base + j.url) : null;
    } else if (buf.length > 512) {
      const tmp = join(tmpdir(), `dsh-tts-${Date.now()}.mp3`);
      writeFileSync(tmp, buf);
      url = tmp;
      tmpFile = tmp;
    }
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e).slice(0, 120) };
  } finally { clearTimeout(timer); }

  if (!url) return { ok: false, reason: 'no-url' };
  if (dryRun) return { ok: true, url, dryRun: true };

  // 播：ffplay 不占窗口、放完自己退。没有 ffplay 就交给系统默认播放器
  const played = await new Promise((resolve) => {
    execFile('ffplay', ['-nodisp', '-autoexit', '-loglevel', 'quiet', url],
      { timeout: timeoutMs + 30_000, windowsHide: true }, (err) => resolve(!err));
  });
  if (played) return { ok: true, url, engine: 'dsh-tts', tmp: tmpFile };

  try {
    execFile('cmd', ['/c', 'start', '', url], { windowsHide: true }, () => {});
    return { ok: true, url, engine: 'dsh-tts-shell', note: 'ffplay 不可用，交给系统播放器' };
  } catch (e) {
    return { ok: false, reason: `play-failed: ${String(e?.message ?? e).slice(0, 80)}`, url };
  }
}


/* ------------------------------------------------------- edge-tts（推荐） */

/**
 * 直接调微软的 edge-tts（`zh-CN-XiaoxiaoNeural` 这类神经音色）。
 *
 * 为什么不用 SAPI：SAPI 那三个中文声音（Huihui / Yaoyao / Kangkang）是十年前的拼接合成，
 * 一听就是导航软件；edge-tts 是神经端到端，语气和断句都自然得多。
 *
 * 为什么不用 DSH 那个 tts 插件的 HTTP 接口：实测它在 `127.0.0.1:4310` 上回 184 字节、
 * 31 毫秒——既不是音频（1 秒的 mp3 至少几 KB），也不是 `{url}`。那个端点不是给外部调的。
 *
 * 依赖：`pip install edge-tts`（在独立 venv 里），播放用 ffplay。
 * 拿不到就安静退回 SAPI —— 念台词不能因为音色插件没装就哑掉。
 */
export function defaultEdgeTtsBin(env = process.env) {
  const cfg = configuredDshTts(env);
  if (cfg?.edgeTts && existsSync(cfg.edgeTts)) return cfg.edgeTts;
  const guess = join(env.USERPROFILE || homedir(),
    '.workbuddy', 'binaries', 'python', 'envs', 'tts', 'Scripts', 'edge-tts.exe');
  return existsSync(guess) ? guess : null;
}

/** 用 edge-tts 念一句：合成到临时 mp3，用 ffplay 播，播完删掉 */
export async function speakViaEdgeTts(text, {
  voice = 'zh-CN-XiaoxiaoNeural', bin = null, rate = 0, timeoutMs = 60_000, dryRun = false,
} = {}) {
  const exe = bin || defaultEdgeTtsBin();
  if (!exe) return { ok: false, reason: 'edge-tts-not-installed' };
  const out = join(tmpdir(), `edge-tts-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.mp3`);
  // 语速：edge-tts 用百分比（-10% ~ +50%），我们的 rate 是 SAPI 的 -10..10
  const pct = Math.round(Math.max(-10, Math.min(10, Number(rate) || 0)) * 3);
  const args = ['--voice', voice, '--text', text, '--write-media', out];
  if (pct) args.push(`--rate=${pct > 0 ? '+' : ''}${pct}%`);

  if (dryRun) return { ok: true, dryRun: true, args, exe };

  const made = await new Promise((resolve) => {
    execFile(exe, args, { timeout: timeoutMs, windowsHide: true }, (err) => resolve(!err));
  });
  if (!made) return { ok: false, reason: 'synth-failed' };
  try {
    if (!existsSync(out) || statSync(out).size < 800) return { ok: false, reason: 'empty-audio' };
  } catch { return { ok: false, reason: 'stat-failed' }; }

  const played = await new Promise((resolve) => {
    execFile('ffplay', ['-nodisp', '-autoexit', '-loglevel', 'quiet', out],
      { timeout: timeoutMs + 30_000, windowsHide: true }, (err) => resolve(!err));
  });
  try { unlinkSync(out); } catch { /* 删不掉就留着 */ }
  if (!played) return { ok: false, reason: 'play-failed' };
  return { ok: true, engine: 'edge-tts', voice };
}

/** 列出本机可用声音（从注册表读，不实例化 COM） */
export function listVoices() {
  const ps = [
    "$out = @()",
    "foreach ($p in @('HKLM:\\SOFTWARE\\Microsoft\\Speech\\Voices\\Tokens','HKLM:\\SOFTWARE\\Microsoft\\Speech_OneCore\\Voices\\Tokens')) {",
    "  if (Test-Path $p) { Get-ChildItem $p | ForEach-Object { $out += (Get-ItemProperty $_.PSPath).'(default)' } }",
    '}',
    '$out | Sort-Object -Unique',
  ].join('; ');
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { timeout: 15_000, windowsHide: true }, (err, stdout) => {
        if (err) return resolve([]);
        resolve(String(stdout).split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
      });
  });
}
