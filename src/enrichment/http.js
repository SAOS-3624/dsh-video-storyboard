/** 共享 HTTP 助手（enrichment 侧车）。 */

export function enrichAuthHeaders(key) {
  if (!key) return {};
  return { Authorization: `Bearer ${key}` };
}

export async function postJson(url, body, { key, timeoutMs = 120_000 } = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...enrichAuthHeaders(key),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
  if (!res.ok) {
    const msg = (json && (json.error || json.message)) || text.slice(0, 240);
    const err = new Error(`enrichment HTTP ${res.status}: ${msg}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}
