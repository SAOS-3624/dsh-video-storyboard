/**
 * examples/voice-edge-tts — 一个**能出声**的声音适配器，给调试和自用。
 *
 * `src/` 里没有任何一行 import 它。核心只发事件（见 `src/voice.js`），
 * 这个文件订阅事件、把台词念出来，并且在 **stderr 打一行时间码**：
 * 调试时最想知道的就是"这句话到底是第几秒吐出来的"。
 *
 * ## 启用
 *
 * ```json
 * // ~/.dsh/voice.json
 * { "adapter": "D:/deepseek/3-Life/dsh-video-storyboard/examples/voice-edge-tts/index.mjs" }
 * ```
 *
 * 或者环境变量：`DSH_VOICE_ADAPTER=<同样的路径>`。
 * 不配就是"没人接声音"，到点的台词照旧叫醒模型由模型自己说 —— 功能完整，只是安静。
 *
 * ## 依赖（都可选，缺了逐级降级）
 *
 * | 缺什么 | 后果 |
 * |---|---|
 * | `edge-tts`（`pip install edge-tts`） | 退回 Windows 系统声音（SAPI） |
 * | `ffplay`（ffmpeg 自带） | 合成出来的 mp3 放不出来，只打日志 |
 * | 两个都没有 | 只打日志，不影响陪看 |
 *
 * 音色 / 引擎路径从 `~/.dsh/tts.json` 读（`voice` / `edgeTts` / `rate`）——
 * **那是适配器自己的配置，核心完全不看**。
 */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const run = (bin, args, timeoutMs = 60_000) => new Promise((resolve) => {
  execFile(bin, args, { timeout: timeoutMs, windowsHide: true }, (err) => resolve(!err));
});

function config() {
  const home = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || homedir(), '.dsh');
  try {
    return JSON.parse(readFileSync(join(home, 'tts.json'), 'utf8')) ?? {};
  } catch {
    return {};
  }
}

/** edge-tts 可执行文件：配置点名 → 环境变量 → 常见 venv → PATH */
function edgeBin(cfg) {
  const home = process.env.USERPROFILE || process.env.HOME || homedir();
  const win = process.platform === 'win32';
  const cands = [
    cfg.edgeTts,
    process.env.DSH_TTS_BIN,
    win ? join(home, '.dsh', 'tts-venv', 'Scripts', 'edge-tts.exe') : join(home, '.dsh', 'tts-venv', 'bin', 'edge-tts'),
    win ? join(home, '.workbuddy', 'binaries', 'python', 'envs', 'tts', 'Scripts', 'edge-tts.exe')
      : join(home, '.workbuddy', 'binaries', 'python', 'envs', 'tts', 'bin', 'edge-tts'),
  ].filter(Boolean);
  for (const c of cands) {
    try { if (existsSync(c)) return c; } catch { /* 下一个 */ }
  }
  for (const dir of String(process.env.PATH ?? '').split(win ? ';' : ':')) {
    if (!dir) continue;
    for (const ext of (win ? ['.exe', '.cmd', ''] : [''])) {
      const p = join(dir, `edge-tts${ext}`);
      try { if (existsSync(p)) return p; } catch { /* 下一个 */ }
    }
  }
  return null;
}

async function speakEdge(text, { bin, voice, rate }) {
  const out = join(tmpdir(), `voice-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.mp3`);
  const pct = Math.round(Math.max(-10, Math.min(10, Number(rate) || 0)) * 3);
  const args = ['--voice', voice, '--text', text, '--write-media', out];
  if (pct) args.push(`--rate=${pct > 0 ? '+' : ''}${pct}%`);
  if (!(await run(bin, args))) return { ok: false, reason: 'synth-failed' };
  try {
    if (statSync(out).size < 800) return { ok: false, reason: 'empty-audio' };
  } catch { return { ok: false, reason: 'stat-failed' }; }
  const played = await run('ffplay', ['-nodisp', '-autoexit', '-loglevel', 'quiet', out], 90_000);
  try { unlinkSync(out); } catch { /* 删不掉就留着 */ }
  return played ? { ok: true, engine: 'edge-tts' } : { ok: false, reason: 'play-failed' };
}

/** Windows 系统声音。Linux/macOS 会失败，失败就当没这个引擎。 */
function speakSapi(text, rate) {
  const lit = `'${String(text ?? '').replace(/'/g, "''")}'`;
  const cmd = `$v = New-Object -ComObject SAPI.SpVoice; $v.Rate = ${Math.max(-10, Math.min(10, Number(rate) || 0))}; $null = $v.Speak(${lit})`;
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd],
      { timeout: 60_000, windowsHide: true }, (err) => resolve(!err));
  });
}

const mmss = (t) => {
  const s = Math.max(0, Number(t) || 0);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${(s % 60).toFixed(1).padStart(4, '0')}`;
};

/**
 * 适配器入口。核心调用它，把接口递进来。
 *
 * @param {{onSpeech:Function, speechSubscribers:Function}} api
 * @returns {() => void} detach
 */
export function attach(api) {
  const cfg = config();
  const voice = cfg.voice || 'zh-CN-XiaoxuanNeural';
  const rate = Number(cfg.rate) || 0;
  const bin = edgeBin(cfg);
  let chain = Promise.resolve();            // 串行：两句绝不重叠着念

  if (!bin) console.error('[voice] edge-tts 没找到，退回系统声音');

  const off = api.onSpeech((e) => {
    if (e.state !== 'due') return;
    // **先打日志再念**：调试时关心的是"它什么时候吐字"，不是"有没有声"
    console.error(`[voice ${mmss(e.at)}] ${e.text}`);
    chain = chain.then(async () => {
      if (bin) {
        const r = await speakEdge(e.text, { bin, voice, rate });
        if (r.ok) return;
        console.error(`[voice] edge-tts 失败（${r.reason}），退回系统声音`);
      }
      if (!(await speakSapi(e.text, rate))) console.error('[voice] 系统声音也不可用，只打日志');
    }).catch((err) => console.error(`[voice] ${err?.message ?? err}`));
  });

  console.error(`[voice] 已接上（engine=${bin ? 'edge-tts' : 'sapi'}，voice=${voice}）`);
  return () => off();
}

export default attach;

