/**
 * 远程镜头边界检测（TransNet V2 等）客户端。
 * 契约见 docs/enrichment-contract.md · POST /v1/shots/detect
 */

import { postJson } from './http.js';

/**
 * @returns {Promise<{cuts:Array<{t:number,score:number,kind?:string}>, model:string, degraded?:boolean, source:string}|null>}
 */
export async function detectShotsRemote({
  input,
  from = 0,
  to,
  fps,
  threshold = 0.5,
  baseUrl,
  key,
  timeoutMs = 180_000,
} = {}) {
  if (!baseUrl || !input) return null;
  const root = String(baseUrl).replace(/\/$/, '');
  const json = await postJson(`${root}/shots/detect`, {
    path: input,
    from,
    to,
    fps_hint: fps,
    threshold,
  }, { key, timeoutMs });

  const cuts = Array.isArray(json?.cuts)
    ? json.cuts
      .map((c) => ({
        t: +Number(c.t ?? c.time ?? c.timestamp),
        score: Number.isFinite(Number(c.score)) ? +Number(c.score) : 1,
        ...(c.kind || c.type ? { kind: String(c.kind || c.type) } : {}),
      }))
      .filter((c) => Number.isFinite(c.t) && c.t >= from && (to == null || c.t < to))
      .sort((a, b) => a.t - b.t)
    : [];

  return {
    cuts,
    model: String(json?.model || 'remote-shots'),
    degraded: Boolean(json?.degraded),
    source: 'remote',
    raw_scenes: Array.isArray(json?.scenes) ? json.scenes.length : undefined,
  };
}

/** HSV 切点与远程切点合并：远程优先，近邻去重保留高分。 */
export function mergeShotCuts(hsvCuts, remoteCuts, { minGap = 0.35 } = {}) {
  const tagged = [
    ...(hsvCuts || []).map((c) => ({ ...c, _src: 'hsv' })),
    ...(remoteCuts || []).map((c) => ({ ...c, _src: 'remote' })),
  ].sort((a, b) => a.t - b.t);

  const kept = [];
  for (const cut of tagged) {
    const last = kept[kept.length - 1];
    if (last && cut.t - last.t < minGap) {
      // 近邻冲突：优先 remote；同来源比分数
      const preferRemote = cut._src === 'remote' && last._src !== 'remote';
      const preferScore = cut.score > last.score && !(last._src === 'remote' && cut._src !== 'remote');
      if (preferRemote || preferScore) kept[kept.length - 1] = cut;
    } else {
      kept.push(cut);
    }
  }
  return kept.map(({ _src, ...rest }) => ({
    ...rest,
    ...(rest.kind ? {} : (_src === 'remote' ? { kind: rest.kind || 'cut' } : {})),
  }));
}
