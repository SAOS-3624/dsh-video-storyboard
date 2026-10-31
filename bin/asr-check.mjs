#!/usr/bin/env node
/**
 * asr-check — 在真机上验一次台词链路，只花十几秒音频的钱。
 *
 *   node bin/asr-check.mjs <video> [--from 60] [--seconds 12]
 *
 * 顺序：字幕轨 → ASR。
 * 「这次会不会真转写」用 `canTranscribe()` 判 —— 和 `video_storyboard` 同一句话：
 * 本机地址（127.0.0.1 / localhost / [::1]）按设计**不需要 key**，只有云端才要。
 * 配了 `manage.start` 就先把托管服务拉起来，连不上时给人话而不是抛栈。
 */
import { args as parse } from './_args.mjs';
import { probeVideo } from '../src/storyboard/probe.js';
import {
  canTranscribe, describeAsrTarget, effectiveAsrKey, explainFetchError, extractSubtitleTrack,
  filterSuspectSegments, resolveAsrConfig, transcribeLong,
} from '../src/storyboard/asr.js';
import { ensureAsr, isOwned, scheduleStop } from '../src/storyboard/asr-lifecycle.js';
import { analyzeAudio } from '../src/storyboard/audio.js';

const opt = parse(process.argv.slice(2), { from: 0, seconds: 12 });
const input = opt._[0];
if (!input) {
  console.error('usage: node bin/asr-check.mjs <video> [--from 60] [--seconds 12]');
  process.exit(2);
}
const from = Number(opt.from) || 0;
const seconds = Number(opt.seconds) || 12;

const info = await probeVideo(input);
console.log(`[probe] ${info.width}x${info.height} ${info.duration.toFixed(1)}s  ` +
  `${info.hasAudio ? 'audio' : 'NO AUDIO'}${info.hasSubtitle ? ' + 字幕轨' : ''}`);
if (!info.hasAudio) {
  console.log('这个文件没有音轨，台词链路无事可做。');
  process.exit(0);
}

// 1) 字幕轨
if (info.hasSubtitle) {
  const subs = await extractSubtitleTrack({ input });
  if (subs?.length) {
    console.log(`[subtitle] 抽到 ${subs.length} 条字幕，前 3 条：`);
    for (const s of subs.slice(0, 3)) console.log(`  ${s.from.toFixed(1)}–${s.to.toFixed(1)}  ${s.text}`);
    console.log('\n有字幕轨时根本不用调 ASR —— 这条路径是免费且最准的。');
    process.exit(0);
  }
  console.log('[subtitle] 声明了字幕轨但抽不出来，回退到 ASR');
}

// 2) ASR 配置：判据必须和工具**同一句话**（`canTranscribe`），别再自己看"有没有 key"
//
// issue #41：这里原来只看 `ASR_DEFAULTS.fileKey || process.env[keyEnv]`，
// 于是把"本机 127.0.0.1:8000 正在跑、按设计不需要 key"误判成"没配 → 不会转写"，
// 而 `video_storyboard` 用 canTranscribe 判得对 —— 同一个环境，脚本说不能跑、工具能跑。
// 顺带：这个脚本从不 import asr-lifecycle，`manage.start` 配了也不会拉起服务，
// 而 `doctor.mjs` 第 5 步恰恰把它推给正在排障的人。
const asrCfg = resolveAsrConfig();
const apiKey = effectiveAsrKey(asrCfg);
console.log(`[asr] ${describeAsrTarget(asrCfg)}`);
if (!canTranscribe(asrCfg, apiKey)) {
  console.log(`\n这是云端地址（${asrCfg.baseUrl}），但没有配 key —— 这次不会真转写。设置后重跑：`);
  console.log('  Windows PowerShell:  $env:' + asrCfg.keyEnv + ' = "sk-..."');
  console.log('  Git Bash / WSL:      export ' + asrCfg.keyEnv + '=sk-...');
  console.log('可选：DSH_ASR_BASE_URL / DSH_ASR_MODEL / DSH_ASR_LANG（默认 zh）');
  console.log('      自建 funasr-server 也可以，只要它兼容 OpenAI 的 /audio/transcriptions。');
  process.exit(1);
}
if (!apiKey) {
  console.log('[asr] 本机地址，不需要 key（和 video_storyboard 同一判据）');
}

// 2.5) 本地托管的服务可能要临时拉起（只有 asr.json 配了 manage.start 才会）
let asrLife = null;
try {
  asrLife = await ensureAsr({ baseUrl: asrCfg.baseUrl, config: asrCfg });
  if (asrLife?.started) console.log('[asr] 已按 manage.start 拉起本机服务');
} catch (e) {
  if (process.env.DSH_ASR_DEBUG) console.error('[asr-lifecycle]', e?.message ?? e);
}

// 3) 真调一次
const t0 = Date.now();
console.log(`[asr] 转写 ${from}s–${from + seconds}s（≈${(seconds * 31.25).toFixed(0)}KB @16k 单声道）…`);
// 走和工具同一套切片逻辑（>45s 会自动切成多请求，切点优先落在静音）
const { silences } = (await analyzeAudio({ input, start: from, end: from + seconds })) ?? { silences: [] };
let result = null;
try {
  result = await transcribeLong({
    input, start: from, end: from + seconds, silences, maxChunk: 45,
    // apiKey 显式传：不传的话 transcribe 会再解析一次，键和实参可能不是同一份
    apiKey, language: asrCfg.language,
  });
} catch (error) {
  // 排障脚本最不该吐未捕获异常。连不上是最常见的一种，给一句人话 + 具体地址。
  console.error(`\n[asr] 请求失败：${explainFetchError(error).slice(0, 400)}`);
  if (/ECONNREFUSED|ENOTFOUND|fetch failed/i.test(String(error?.message ?? error) + String(error?.cause?.code ?? ''))) {
    console.error(`      ${asrCfg.baseUrl} 上没有服务在听。本机服务先跑 start-asr.cmd，`);
    console.error('      或在 ~/.dsh/asr.json 里配 manage.start，让插件按需拉起。');
  }
  process.exit(1);
} finally {
  // 我们拉起的才安排空闲退出（别人启动的实例无权杀）
  if (asrLife?.owned || isOwned()) {
    scheduleStop({ owned: true, config: asrCfg, baseUrl: asrCfg.baseUrl });
  }
}
const ms = Date.now() - t0;
if (!result) {
  console.log('没有返回内容（音频可能全是静音）。');
  process.exit(0);
}
console.log(`[asr] ${ms}ms，${result.segments.length} 段` +
  `${result.chunks ? `（${result.chunks} 片）` : ''}，model=${result.model}`);
for (const s of result.segments) {
  console.log(`  ${s.from.toFixed(2)}–${s.to.toFixed(2)}  ${s.text}`);
}
const { kept, dropped } = filterSuspectSegments(result.segments);
const chars = kept.reduce((n, s) => n + s.text.length, 0);
if (dropped.length > 0) {
  console.log(`\n[过滤] ${dropped.length} 段疑似非语音（音乐/噪声），已忽略：`);
  for (const d of dropped.slice(0, 5)) {
    console.log(`  ${d.from.toFixed(2)}–${d.to.toFixed(2)}  ${d.charsPerSec} 字/秒  ${d.reason}  "${d.text.slice(0, 20)}"`);
  }
}
console.log(`\n[统计] ${chars} 字 / ${seconds}s = ${(chars / seconds).toFixed(2)} 字/秒`);
console.log('[提示] 这些时间码会按重叠贴到分镜格子上；字/秒也会作为第三条密度信号。');
