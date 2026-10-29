/**
 * browser-time.js — 直接从浏览器里读 `video.currentTime`，毫秒级准。
 *
 * 为什么需要：Windows 的 SMTC 只在**事件时**刷新（起播/暂停/拖动/切集），
 * 连续播放期间能几分钟不动。实测两次刷新隔过 143 s、216 s —— 那段时间里
 * "用户看到第几秒"只能靠墙钟外推，暂停/缓冲一插进来就错。
 *
 * 浏览器里那个 `<video>` 元素的 `currentTime` 是**真的**，只要浏览器开了调试端口：
 *
 *   msedge.exe --remote-debugging-port=9222
 *
 * 然后走 CDP（Chrome DevTools Protocol）：
 *   GET  http://127.0.0.1:9222/json        → 找到页面目标
 *   WS   Runtime.evaluate                  → 读 currentTime / paused / duration / location.href
 *
 * 顺带的好处：**拿得到当前网页地址**，源解析不用再靠标题猜。
 *
 * 没有调试端口就返回 null，调用方退回 SMTC。不报错、不打扰。
 */

const DEFAULT_PORT = 9222;

/** 列出调试端口暴露的页面目标 */
export async function listTargets({ port = DEFAULT_PORT, timeoutMs = 1200 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: ac.signal });
    if (!res.ok) return null;
    const list = await res.json();
    return Array.isArray(list) ? list : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 挑一个"正在放视频"的页面：优先 bilibili，其次任何带 video 的页面 */
export function pickVideoTarget(targets) {
  const pages = (targets ?? []).filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (pages.length === 0) return null;
  const scored = pages.map((t) => {
    let n = 0;
    if (/bilibili\.com/i.test(t.url ?? '')) n += 3;
    if (/\/video\//i.test(t.url ?? '')) n += 2;
    if (/\.(mp4|mkv|webm|m3u8)/i.test(t.url ?? '')) n += 2;
    return { t, n };
  }).sort((a, b) => b.n - a.n);
  return scored[0].n > 0 ? scored[0].t : pages[0];
}

/** 在某个页面里求值一次（一条 CDP 往返，约 10–30 ms） */
export function evaluate(wsUrl, expression, { timeoutMs = 1500 } = {}) {
  return new Promise((resolve) => {
    let ws;
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      try { ws?.close(); } catch { /* 已关 */ }
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      clearTimeout(timer);
      return resolve(null);
    }
    ws.onopen = () => {
      ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: false },
      }));
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data));
        if (msg.id !== 1) return;
        clearTimeout(timer);
        finish(msg.result?.result?.value ?? null);
      } catch {
        clearTimeout(timer);
        finish(null);
      }
    };
    ws.onerror = () => { clearTimeout(timer); finish(null); };
    ws.onclose = () => { clearTimeout(timer); finish(null); };
  });
}

const SNAPSHOT_EXPR = `(() => {
  const v = document.querySelector('video');
  if (!v) return null;
  return {
    pos: v.currentTime,
    dur: Number.isFinite(v.duration) ? v.duration : null,
    paused: v.paused,
    ended: v.ended,
    url: location.href,
    title: document.title,
  };
})()`;

/**
 * 读浏览器里的真实播放位置。
 * @returns {Promise<null | {pos:number, dur:number|null, paused:boolean, url:string, title:string, port:number}>}
 */
export async function readBrowserPosition({ port = DEFAULT_PORT, timeoutMs = 1500, maxPages = 8 } = {}) {
  const targets = await listTargets({ port, timeoutMs });
  if (!targets) return null;
  const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)
    // **跳过 Electron 宿主自己的页面**：WorkBuddy / VSCode 这类应用也会开调试端口，
    // 页面里还有 <video>（实测 WorkBuddy 的 9222 上就有一个 5 秒的 video）。
    // 不排除的话会读到宿主自己的界面元素，而不是用户在看的那支片子。
    .filter((t) => {
      const u = t.url ?? '';
      return !u.includes('app.asar') && !u.startsWith('devtools:') && !u.includes('vscode');
    });
  if (pages.length === 0) return null;

  // **挨个问 "你这儿有 video 吗"**，而不是靠 URL 猜。
  // 实测踩过：同一台浏览器开着 7 个页面，靠 URL 打分选中了没有视频的那个，
  // 于是永远读到 -1 —— 而 B 站页面好好的。URL 只能用来排序，不能用来判断。
  const ordered = [
    ...pages.filter((t) => /bilibili\.com|\/video\//i.test(t.url ?? '')),
    ...pages.filter((t) => !/bilibili\.com|\/video\//i.test(t.url ?? '')),
  ].slice(0, maxPages);

  let best = null;
  for (const t of ordered) {
    const snap = await evaluate(t.webSocketDebuggerUrl, SNAPSHOT_EXPR, { timeoutMs });
    if (!snap || typeof snap.pos !== 'number') continue;
    const cand = { ...snap, port };
    // 正在播的优先；暂停的也能用，但排在后面
    if (!snap.paused && !snap.ended) return cand;
    if (!best) best = cand;
  }
  return best;
}

/** 调试端口开没开（用于给用户一句明确的提示，而不是让功能悄悄退化） */
export async function hasDebugPort({ port = DEFAULT_PORT } = {}) {
  return (await listTargets({ port })) !== null;
}
