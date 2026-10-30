#!/usr/bin/env node
/**
 * doctor — 装完之后先跑这个。**一条命令看清"缺什么、去哪儿补"**。
 *
 *   node bin/doctor.mjs
 *
 * 为什么要有它：用户反馈里一半以上不是 bug，是"不知道要配 ASR / 装了 ffmpeg 但宿主没重启 /
 * yt-dlp 找不到 ffmpeg 于是静默下成无声片"。这些都不是错误信息能说清的，
 * 得把它们摆在一屏里，每条后面直接跟"你要做什么"。
 *
 * 退出码：0 全绿 / 1 有硬伤（不给下一步就没法用）。
 */
import { access, mkdir, stat, writeFile, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';

import { DEFAULT_FFMPEG, DEFAULT_FFPROBE, mediaCandidates } from '../src/storyboard/binaries.js';
import { canTranscribe, describeAsrTarget, resolveAsrConfig } from '../src/storyboard/asr.js';
import { mediaDir } from '../src/storyboard/media-store.js';
import { discoverYtdlp } from '../src/storyboard/ytdlp.js';
import { execFile } from 'node:child_process';

const ok = (m) => console.log(`  ✅ ${m}`);
const warn = (m) => console.log(`  ⚠️  ${m}`);
const bad = (m) => console.log(`  ❌ ${m}`);
console.log(''); // 视觉留白，宿主里一行标题太挤

function run(bin, args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
      resolve({ code: error ? (error.code ?? 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

async function exists(p) {
  try { await access(p, constants.X_OK); return true; } catch { return false; }
}

let hardFail = 0;

/* ------------------------------------------------------------------ 1. ffmpeg */

console.log('1) 视频引擎 ffmpeg / ffprobe');
for (const [name, bin] of [['ffmpeg', DEFAULT_FFMPEG], ['ffprobe', DEFAULT_FFPROBE]]) {
  // 用"真跑一次"判断，而不是 access(X_OK)：解析结果可能只是一个裸名字（靠 PATH 找），
  // 那时 access('ffmpeg') 必然失败，但实际是能跑的。
  const r = await run(bin, ['-version']);
  if (r.code === 0 && r.stdout) {
    const v = r.stdout.split('\n')[0].replace(/\s+/g, ' ').trim();
    ok(`${name}: ${bin}`);
    console.log(`     ${v.slice(0, 78)}`);
  } else {
    bad(`${name} 跑不起来（试过：${bin}）`);
    console.log(mediaCandidates(name).map((c) => `       - ${c.path}`).join('\n'));
    console.log('     → 装一个：winget install Gyan.FFmpeg  /  brew install ffmpeg');
    console.log('       已有的话设 DSH_FFMPEG_PATH 指到可执行文件。装完**重启 DSH**。');
    hardFail += 1;
  }
}

/* ------------------------------------------------------------------ 2. yt-dlp */

console.log('\n2) 链接下载 yt-dlp（只处理"贴网址"时才需要）');
const tool = await discoverYtdlp().catch((e) => ({ error: e }));
if (tool?.error || !tool?.bin) {
  warn('没找到 yt-dlp —— 本地文件照常用，贴 B 站/YouTube 链接会失败');
  console.log('     → pip install --user -U yt-dlp   （或 winget install yt-dlp）');
  console.log('       装完设 DSH_YTDLP_PATH 指到 yt-dlp.exe，然后**重启 DSH**');
} else {
  const r = await run(tool.bin, ['--version']);
  ok(`yt-dlp: ${tool.bin} (${(r.stdout || '?').trim()})`);
  // yt-dlp 合流音视频要 ffmpeg；找不到时它**不报错**，直接给一个没声音的 mp4。
  const ff = DEFAULT_FFMPEG;
  if (ff.includes('/') || ff.includes('\\')) {
    ok(`合流用的 ffmpeg 会以 --ffmpeg-location 传给 yt-dlp（${ff}）`);
  } else {
    warn('ffmpeg 只在 PATH 上（没解析出绝对路径）。yt-dlp 找不到它时会静默下成无声片。');
    console.log('     → 如果下面第 1 步是绿的就没问题；否则先把 ffmpeg 装好');
  }
}

/* ------------------------------------------------------------------ 3. ASR */

console.log('\n3) 台词转写 ASR（只影响"听声音"，不影响出图）');
const cfg = resolveAsrConfig();
console.log(`     目标：${describeAsrTarget()}`);
if (canTranscribe(cfg)) {
  // 本机服务不需要 key，但要能连上；云端要 key，也顺手探一下
  const probeUrl = `${cfg.baseUrl.replace(/\/+$/, '')}/models`;
  const reachable = await fetch(probeUrl, { signal: AbortSignal.timeout(3000) })
    .then((r) => r.ok || r.status < 500).catch(() => false);
  if (reachable) ok('ASR 端点可达，会自动转写');
  else {
    warn(`连不上 ${probeUrl}（3 秒超时）`);
    console.log('     → 本机服务没起来？先启动它（例如 D:\\asr-local\\start-asr.cmd）');
    console.log('       远端服务：检查 ~/.dsh/asr.json 里的 baseUrl');
  }
} else {
  warn('没有可用的 ASR：视频**能出图**，但清单里没有台词（"听不见声音"就是这个）');
  console.log('     → 二选一：');
  console.log('       ① 本机服务（免费、不联网）：装 funasr 后跑起来，在 ~/.dsh/asr.json 写');
  console.log('          { "baseUrl": "http://127.0.0.1:8000/v1" }');
  console.log('       ② 云端（要 key）：在 ~/.dsh/asr.json 写');
  console.log('          { "key": "sk-...", "baseUrl": "https://api.siliconflow.cn/v1",');
  console.log('            "model": "FunAudioLLM/SenseVoiceSmall" }');
  console.log('       改完不用重启（0.5.0 起按文件 mtime 热加载）');
}

/* ------------------------------------------------------------------ 4. 缓存目录 */

console.log('\n4) 缓存目录（下载的视频、扫描结果都在这儿）');
const dir = mediaDir();
try {
  await mkdir(dir, { recursive: true });
  const probeFile = join(dir, '.doctor-write-test');
  await writeFile(probeFile, 'ok');
  await rm(probeFile, { force: true });
  ok(`可写：${dir}`);
} catch (e) {
  bad(`不可写：${dir}（${e.message}）`);
  console.log('     → 设 DSH_VIDEO_MEDIA_DIR 换一个目录');
  hardFail += 1;
}

/* ------------------------------------------------------------------ 5. 一次自检 */

console.log('\n5) 建议的下一步');
console.log('  · 随便找一个本地视频跑一遍：');
console.log('      node bin/storyboard.mjs "D:/某个视频.mp4" --out test.png --manifest test.json');
console.log('  · 只想验台词链路（十几秒音频，便宜）：');
console.log('      node bin/asr-check.mjs "D:/某个视频.mp4"');
console.log('  · 完整教程：docs/入门-五分钟.zh.md   常见问题：docs/FAQ.zh.md');

console.log('');
if (hardFail > 0) {
  console.log(`有 ${hardFail} 项没配好，按上面的箭头补完再重启 DSH。`);
  process.exit(1);
}
console.log('全部就绪。');
