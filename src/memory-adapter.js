/**
 * memory-adapter.js — 把分镜结果收成可追溯的 Video Episode（不写盘）。
 *
 * 对齐桌宠 `video_observation` episode 形态：content.summary + key_segments + evidence refs。
 * 长期画像仍由 memory_consolidator / interest_extract 决定；本层只提供证据与摘要。
 */

import { createHash } from 'node:crypto';

const tc = (t) => {
  const m = Math.floor(t / 60);
  return `${String(m).padStart(2, '0')}:${(t % 60).toFixed(2).padStart(5, '0')}`;
};

function flatCells(result) {
  if (Array.isArray(result.cells) && result.cells.length) return result.cells;
  const all = [];
  for (const sheet of result.sheets ?? []) {
    for (const c of sheet.cells ?? []) all.push(c);
  }
  return all;
}

function pickKeySegments(cells, { max = 5 } = {}) {
  const scored = cells.map((c) => {
    let score = 0;
    if (c.cuts) score += Number(c.cuts);
    if (c.text) score += Math.min(3, String(c.text).length / 40);
    if ((c.selection_reason ?? []).includes('salience')) score += 1.5;
    if ((c.selection_reason ?? []).includes('dialogue')) score += 1;
    return { c, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, max).filter((x) => x.score > 0).map(({ c, score }) => ({
    cell_id: c.cell_id ?? `cell_${String(c.i).padStart(4, '0')}`,
    start_ms: c.start_ms ?? Math.round((c.t_start ?? 0) * 1000),
    end_ms: c.end_ms ?? Math.round((c.t_end ?? 0) * 1000),
    t_start: c.t_start,
    t_end: c.t_end,
    reason: (c.selection_reason ?? []).slice(0, 3).join('+') || 'coverage',
    score: +score.toFixed(2),
    evidence_refs: [c.cell_id ?? `cell_${String(c.i).padStart(4, '0')}`],
    transcript_snippet: c.text ? String(c.text).slice(0, 120) : '',
  }));
}

function buildSummary(result, keySegments) {
  const dur = result.window?.duration ?? result.info?.duration ?? 0;
  const cuts = result.cuts?.length ?? 0;
  const chars = result.transcript?.chars ?? 0;
  const cps = result.transcript?.charsPerSec;
  const parts = [
    `本地分镜 ${tc(result.window?.from ?? 0)}–${tc(result.window?.to ?? dur)}`,
    `${result.plan?.cells ?? '?'} 格`,
    cuts ? `${cuts} 切点` : null,
    chars ? `台词 ${chars} 字` : null,
    cps != null ? `${cps} 字/秒` : null,
  ].filter(Boolean);
  let line = parts.join(' · ');
  if (keySegments[0]?.transcript_snippet) {
    line += `。关键段：${keySegments[0].transcript_snippet}`;
  } else if (keySegments[0]) {
    line += `。关键段 @ ${tc(keySegments[0].t_start)}`;
  }
  return line.slice(0, 280);
}

/**
 * @param {object} result runStoryboard 返回值
 * @param {object} [meta]  平台/标题等可选上下文
 */
export function buildEpisodeFromResult(result, meta = {}) {
  const cells = flatCells(result);
  const keySegments = pickKeySegments(cells);
  const path = result.info?.path ?? meta.path ?? '';
  const sourceSig = createHash('sha1')
    .update([path, result.info?.duration ?? 0, result.window?.from, result.window?.to].join('|'))
    .digest('hex')
    .slice(0, 16);

  return {
    at: Date.now() / 1000,
    memory_type: 'video_observation',
    status: 'episode',
    trigger: meta.trigger ?? 'storyboard',
    source: 'dsh-video-storyboard',
    video: {
      platform: meta.platform ?? 'local',
      video_id: meta.video_id ?? sourceSig,
      title: meta.title ?? (path ? String(path).split(/[/\\]/).pop() : 'local-video'),
      uploader: meta.uploader ?? '',
      url: meta.url ?? (path ? `file://${path}` : ''),
      duration_sec: result.info?.duration ?? 0,
      local_path: path,
      category: meta.category ?? '',
    },
    watch: {
      duration_sec: Math.round(result.window?.duration ?? 0),
      attention: meta.attention ?? 1,
      attention_state: meta.attention_state ?? 'storyboard',
      replay_count: 0,
    },
    content: {
      topics: meta.topics ?? [],
      entities: [],
      summary: buildSummary(result, keySegments),
      subtitle_snippet: keySegments.map((k) => k.transcript_snippet).filter(Boolean).join(' / ').slice(0, 240),
      onscreen_subtitle: '',
      visual_summary: '',
      key_segments: keySegments,
      plan_id: result.plan?.plan_id ?? null,
      strategy: result.plan?.strategy ?? null,
      analysis_status: result.status ?? result.analysis?.status ?? null,
    },
    evidence: {
      source_signature: sourceSig,
      window: result.window,
      cell_count: cells.length,
      cuts: result.cuts?.length ?? 0,
      transcript_source: result.transcript?.source ?? null,
      cache_hits: result.cache_hits ?? [],
      timing: result.timing ?? null,
    },
    interest_processed: false,
  };
}

/** 给模型/日志的短文本 */
export function formatEpisodeForMemory(episode) {
  if (!episode) return '';
  const v = episode.video ?? {};
  const c = episode.content ?? {};
  const keys = (c.key_segments ?? [])
    .slice(0, 3)
    .map((k) => `${tc((k.start_ms ?? 0) / 1000)} ${k.reason}`)
    .join('; ');
  return [
    `[video-episode] ${v.title || v.video_id}`,
    c.summary,
    keys ? `key: ${keys}` : null,
  ].filter(Boolean).join('\n');
}
