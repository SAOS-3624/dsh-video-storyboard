/**
 * enrichment/config.js — DSH 可选增强层配置。
 *
 * 与 ASR 同套路：环境变量 > $DSH_HOME/video.json > ~/.dsh/video.json。
 * 未配置时全部关闭，零网络、零模型权重。
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { cleanEnvValue } from '../asr.js';

function readVideoConfigFile(env = process.env) {
  const candidates = [];
  if (env.DSH_HOME) candidates.push(join(env.DSH_HOME, 'video.json'));
  candidates.push(join(homedir(), '.dsh', 'video.json'));
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      if (parsed && typeof parsed === 'object') return { ...parsed, path };
    } catch {
      return { path, broken: true };
    }
  }
  return {};
}

function block(raw, defaults = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    enable: src.enable === true,
    baseUrl: typeof src.baseUrl === 'string' ? src.baseUrl.trim() : (defaults.baseUrl || ''),
    key: typeof src.key === 'string' ? src.key : (defaults.key || ''),
    timeoutMs: Math.max(5_000, Math.min(600_000, Number(src.timeoutMs) || defaults.timeoutMs || 120_000)),
    ...defaults.extra,
    ...Object.fromEntries(
      Object.entries(src).filter(([k]) => !['enable', 'baseUrl', 'key', 'timeoutMs'].includes(k)),
    ),
  };
}

/**
 * @returns {{
 *   source: string,
 *   configPath?: string,
 *   shots: object,
 *   diarization: object,
 *   audioUnderstand: object,
 * }}
 */
export function resolveEnrichmentConfig(env = process.env) {
  const file = readVideoConfigFile(env);
  const fileOk = file && !file.broken;

  const shotsUrl = cleanEnvValue(env.DSH_VIDEO_SHOTS_URL) || '';
  const diarizeUrl = cleanEnvValue(env.DSH_VIDEO_DIARIZE_URL) || '';
  const audioUrl = cleanEnvValue(env.DSH_VIDEO_AUDIO_URL) || '';
  const key = cleanEnvValue(env.DSH_VIDEO_ENRICH_KEY)
    || (fileOk && typeof file.key === 'string' ? file.key : '')
    || '';

  const shotsFile = fileOk ? file.shots : null;
  const diarFile = fileOk ? file.diarization : null;
  const audioFile = fileOk ? file.audioUnderstand : null;

  const shots = block(shotsFile, {
    baseUrl: shotsUrl,
    key,
    timeoutMs: 180_000,
    extra: { threshold: 0.5 },
  });
  if (shotsUrl) {
    shots.enable = true;
    shots.baseUrl = shotsUrl;
  }
  if (key && !shots.key) shots.key = key;
  if (!shots.baseUrl) shots.enable = false;

  const diarization = block(diarFile, {
    baseUrl: diarizeUrl || shots.baseUrl,
    key: key || shots.key,
    timeoutMs: 180_000,
  });
  if (diarizeUrl) {
    diarization.enable = true;
    diarization.baseUrl = diarizeUrl;
  }
  if (!diarization.baseUrl) diarization.enable = false;

  const audioUnderstand = block(audioFile, {
    baseUrl: audioUrl || shots.baseUrl,
    key: key || shots.key,
    timeoutMs: 120_000,
  });
  if (audioUrl) {
    audioUnderstand.enable = true;
    audioUnderstand.baseUrl = audioUrl;
  }
  if (!audioUnderstand.baseUrl) audioUnderstand.enable = false;

  const fromEnv = Boolean(shotsUrl || diarizeUrl || audioUrl || cleanEnvValue(env.DSH_VIDEO_ENRICH_KEY));
  return {
    source: fromEnv ? 'env' : (fileOk && file.path ? 'file' : 'default'),
    ...(file.path ? { configPath: file.path } : {}),
    shots,
    diarization,
    audioUnderstand,
  };
}

export function enrichmentEnabled(cfg = resolveEnrichmentConfig()) {
  return Boolean(
    cfg.shots?.enable || cfg.diarization?.enable || cfg.audioUnderstand?.enable,
  );
}
