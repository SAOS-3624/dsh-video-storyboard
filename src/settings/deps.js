/**
 * settings/deps.js — 设置页的“环境自检”。只读、不安装、不下载。
 *
 * 插件不替用户装 ffmpeg/yt-dlp：那是宿主机器的软件，静默下载既慢又不可审计。
 * 这里只回答“在不在、版本是多少”，把安装命令和官方链接留给页面。
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { DEFAULT_FFMPEG, DEFAULT_FFPROBE } from '../storyboard/probe.js';
import { discoverYtdlp } from '../storyboard/ytdlp.js';
import { dshHome, readVideoSettings } from './config.js';

const run = promisify(execFile);
const TIMEOUT = 2500;

async function version(command, args) {
  try {
    const { stdout, stderr } = await run(command, args, { timeout: TIMEOUT, windowsHide: true, maxBuffer: 64 * 1024 });
    const text = String(stdout || stderr).trim().split(/\r?\n/)[0].slice(0, 120);
    return { ok: true, detail: text || '已安装' };
  } catch (e) {
    return { ok: false, detail: e?.code === 'ENOENT' ? '未找到' : String(e?.message ?? e).slice(0, 120) };
  }
}

async function firstOf(list) {
  const errors = [];
  for (const [command, args] of list) {
    const r = await version(command, args);
    if (r.ok) return { ...r, command };
    errors.push(r.detail);
  }
  return { ok: false, detail: errors[0] || '未找到' };
}

function portOpen(port, timeoutMs = 450) {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    const done = (value) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

function downloadFor(id, platform = process.platform) {
  const win = platform === 'win32';
  switch (id) {
    case 'ffmpeg':
    case 'ffprobe':
      return {
        downloadUrl: win
          ? 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'
          : 'https://ffmpeg.org/download.html',
        downloadLabel: win ? '下载 FFmpeg zip' : '下载 FFmpeg',
      };
    case 'ytdlp':
      return {
        downloadUrl: win
          ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
          : 'https://github.com/yt-dlp/yt-dlp/releases/latest',
        downloadLabel: win ? '下载 yt-dlp.exe' : '下载 yt-dlp',
      };
    case 'python':
      return {
        downloadUrl: win ? 'https://www.python.org/downloads/windows/' : 'https://www.python.org/downloads/',
        downloadLabel: '下载 Python',
      };
    case 'speech':
      return {
        downloadUrl: 'https://huggingface.co/FunAudioLLM/SenseVoiceSmall',
        downloadLabel: '模型页面',
      };
    default:
      return {};
  }
}

function hostSpeech(ctx, env) {
  const service = ctx?.get?.('speechToText');
  if (!service) return { ok: false, detail: '宿主未提供 speechToText（仍可走 HTTP ASR）' };
  const snap = service.snapshot?.();
  const id = snap?.selection?.providerId;
  const provider = snap?.providers?.find((p) => p.id === id);
  if (!provider) return { ok: false, detail: '没有选中的本地语音提供方' };
  const phase = provider.preparation?.phase;
  const model = join(dshHome(env), 'speech-to-text', 'sensevoice', 'models', 'sensevoice-onnx', 'model.int8.onnx');
  return {
    ok: phase === 'ready' || phase === 'standby',
    detail: `${provider.id} · ${phase ?? '未准备'} · 模型${existsSync(model) ? '已下载' : '未下载'}`,
  };
}

/**
 * yt-dlp 在哪 —— **必须和真正跑的时候用同一个发现逻辑**，否则设置页会撒谎。
 *
 * 以前这里只 `spawn('yt-dlp')` 裸命令；而实际运行时 `discoverYtdlp()` 除了 PATH，
 * 还会扫 pip 的 Scripts 目录（`%APPDATA%\\Python\\Python3XX\\Scripts`）。
 * 结果是"pip 装好、实际能用，但 UI 写着未找到"，用户以为自己没装（社区实报）。
 */
async function ytdlpStatus(env) {
  try {
    const found = await discoverYtdlp({ env });
    return { ok: true, detail: found.version ? `${found.version} · ${found.bin}` : String(found.bin) };
  } catch (e) {
    const tried = Array.isArray(e?.tried) && e.tried.length ? `，试过 ${e.tried.length} 处` : '';
    return { ok: false, detail: `未找到（PATH 与 pip 的 Scripts 目录都没有${tried}）` };
  }
}

/** @returns {Promise<Array<{id:string,label:string,ok:boolean,detail:string}>>} */
export async function checkEnvironment(ctx, env = process.env) {
  const python = await firstOf([['python', ['--version']], ['py', ['--version']]]);
  const ytdlp = await ytdlpStatus(env);
  const ffmpeg = await version(DEFAULT_FFMPEG, ['-version']);
  const ffprobe = await version(DEFAULT_FFPROBE, ['-version']);
  const speech = hostSpeech(ctx, env);
  const video = readVideoSettings(env);
  const port = video.browserPort;
  const browser = port ? await portOpen(port) : { ok: false, detail: '未配置 browserPort' };
  const rows = [
    { id: 'ffmpeg', label: 'ffmpeg', ...ffmpeg },
    { id: 'ffprobe', label: 'ffprobe', ...ffprobe },
    { id: 'ytdlp', label: 'yt-dlp', ...ytdlp },
    { id: 'python', label: 'Python', ...python },
    { id: 'speech', label: '本地 ASR（SenseVoice）', ...speech },
    {
      id: 'browser',
      label: `浏览器调试端口 :${port ?? '未配置'}`,
      ok: Boolean(browser.ok),
      detail: browser.ok ? '可连接' : browser.detail,
    },
  ];
  return rows.map((row) => ({ ...row, ...downloadFor(row.id) }));
}
