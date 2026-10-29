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

// 默认 9333 而不是 9222：9222 是 Chrome DevTools 的惯例端口，容易被别的 Electron 应用占掉
// （实测这台机器上 WorkBuddy 自己就占着 9222，盲连会读到它的界面）。
const DEFAULT_PORT = 9333;

import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * 从 `~/.dsh/video.json` 读端口配置。
 *
 * 为什么要文件而不是只认环境变量：DSH 桌面版的宿主进程 env 由启动器决定，
 * 用户 `setx` 之后插件仍然读不到（这个坑今天已经踩过一次）。文件不依赖 env 传播。
 *
 *   { "browserPort": 9333 }
 */
/** `~/.dsh/video.json` 里的 launchBrowser（默认关：不要替用户随便开程序） */
export function configuredLaunch(env = process.env) {
  const home = env.DSH_HOME || join(env.USERPROFILE || env.HOME || homedir(), '.dsh');
  try {
    const cfg = JSON.parse(readFileSync(join(home, 'video.json'), 'utf8'));
    return cfg?.launchBrowser === true;
  } catch {
    return false;
  }
}

export function configuredPort(env = process.env) {
  const home = env.DSH_HOME || join(env.USERPROFILE || env.HOME || homedir(), '.dsh');
  try {
    const cfg = JSON.parse(readFileSync(join(home, 'video.json'), 'utf8'));
    const n = Number(cfg?.browserPort);
    if (Number.isFinite(n) && n > 0) return n;
    if (cfg?.browserPort === false || cfg?.browser === false) return null;
  } catch { /* 没有配置文件就是没开 */ }
  const fromEnv = Number(env.DSH_BROWSER_DEBUG_PORT);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : null;
}

/**
 * 这个地址像不像"某个视频的页面"？
 *
 * 为什么需要：B 站**首页**上就挂着自动播放的推荐视频，`document.querySelector('video')` 也有值。
 * 但 `https://www.bilibili.com/` 不是任何一条视频，拿去喂 yt-dlp 只会得到
 * "this site is not supported"。判定要卡在地址上，而不是"页面上有没有 <video>"。
 */
export function looksLikeVideoUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  if (url.startsWith('file://')) return true;
  if (/^https?:\/\//i.test(url)) {
    if (/bilibili\.com\/video\/(BV|av)/i.test(url)) return true;
    if (/bilibili\.com\/bangumi\/play\//i.test(url)) return true;
    if (/youtube\.com\/watch|youtu\.be\//i.test(url)) return true;
    if (/\.(mp4|m3u8|webm|mkv)(\?|$)/i.test(url)) return true;
  }
  return false;
}

/**
 * `file:///D:/a%20b.mp4` → `D:/a b.mp4`
 * 本地视频用浏览器打开时，页面地址就是这个视频的路径 —— 正好当 input 用，不必再问用户。
 */
export function fileUrlToPath(url) {
  if (typeof url !== 'string' || !url.startsWith('file://')) return null;
  try {
    const p = new URL(url).pathname;
    const decoded = decodeURIComponent(p);
    // Windows: /D:/x → D:/x
    return /^\/[a-z]:/i.test(decoded) ? decoded.slice(1) : decoded;
  } catch {
    return null;
  }
}

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

/**
 * 由**插件自己**把浏览器拉起来。
 *
 * 为什么不能靠外部脚本代劳：我这边的工具进程跑在一个 Job Object 里，
 * 它派生出去的子进程（哪怕 detached + unref）会随这个 job 一起被回收——
 * 实测两次：窗口开起来、7 秒后读得到、再 10 秒整个浏览器连同用户自己的 Edge 一起没了。
 * 而插件是跑在 DSH 里的长期进程，它 spawn 出去的浏览器才活得下来。
 *
 * 所以：想在"打开视频时自动就有端口"，只能是插件来起。
 */
export function launchBrowser({
  port = DEFAULT_PORT, url = '', profileDir = null, exe = null, taskScheduler = true,
} = {}) {
  const edge = exe
    ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  const profile = profileDir ?? join(homedir(), '.dsh', 'edge-watch');
  if (!existsSync(edge)) return { ok: false, reason: 'edge-not-found' };
  mkdirSync(profile, { recursive: true });
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    ...(url ? [url] : []),
  ];

  // **Windows 上走计划任务**：普通 spawn 出去的进程会留在调用者的 Job Object 里，
  // 调用方一退出就被回收（实测：窗口开起来、几秒后整个浏览器消失）。
  // 计划任务由 Task Scheduler 服务启动，不在那个 job 里，才能真正活下来。
  if (process.platform === 'win32' && taskScheduler !== false) {
    const task = `DSH-Edge-Watch-${port}`;
    const quoted = args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ');

    // 先试 schtasks.exe：最通用。某些安全策略会把它列为黑名单程序，
    // 那种情况下退回"直接 spawn"（活不长，但至少能看）。
    try {
      execFileSync('schtasks', ['/create', '/tn', task, '/tr', `"${edge}" ${quoted}`,
        '/sc', 'once', '/st', '23:59', '/f'], { stdio: 'ignore', windowsHide: true, timeout: 15_000 });
      execFileSync('schtasks', ['/run', '/tn', task], { stdio: 'ignore', windowsHide: true, timeout: 15_000 });
      return { ok: true, via: 'schtasks', task, port, profile };
    } catch { /* 没权限就往下走 */ }
  }

  try {
    const child = spawn(edge, args, { detached: true, stdio: 'ignore' });
    child.unref();
    return { ok: true, via: 'spawn', pid: child.pid, port, profile };
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e).slice(0, 120) };
  }
}

/** 等端口起来（最多等 timeoutMs），返回是否起来了 */
export async function waitForPort(port, { timeoutMs = 8000, stepMs = 400 } = {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    // eslint-disable-next-line no-await-in-loop
    if ((await listTargets({ port, timeoutMs: 600 })) !== null) return true;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
}

/** 调试端口开没开（用于给用户一句明确的提示，而不是让功能悄悄退化） */
export async function hasDebugPort({ port = DEFAULT_PORT } = {}) {
  return (await listTargets({ port })) !== null;
}

/**
 * 从浏览器里直接读 cookie，转成 Netscape 格式给 yt-dlp 用。
 *
 * 为什么比"手动导出"好：用户要做的只有一件事——**在带端口的那个窗口里登录一次**。
 * 之后插件自己去要 cookie，不需要他找扩展、找文件、找路径。
 *
 * 走的是 CDP 的浏览器级端点（/json/version → Storage.getCookies），能拿到全部 cookie，
 * 不受当前页面域限制。
 */
export async function readBrowserCookies({ port = DEFAULT_PORT, timeoutMs = 4000 } = {}) {
  let wsUrl;
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: ac.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const v = await res.json();
    wsUrl = v?.webSocketDebuggerUrl;
  } catch {
    return null;
  }
  if (!wsUrl) return null;

  const cookies = await new Promise((resolve) => {
    let ws;
    let done = false;
    const finish = (v) => { if (done) return; done = true; try { ws?.close(); } catch { /* 已关 */ } resolve(v); };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try { ws = new WebSocket(wsUrl); } catch { clearTimeout(timer); return resolve(null); }
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Storage.getCookies' }));
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data));
        if (msg.id !== 1) return;
        clearTimeout(timer);
        finish(msg.result?.cookies ?? null);
      } catch { clearTimeout(timer); finish(null); }
    };
    ws.onerror = () => { clearTimeout(timer); finish(null); };
    ws.onclose = () => { clearTimeout(timer); finish(null); };
  });
  return Array.isArray(cookies) ? cookies : null;
}

/** cookie 数组 → Netscape cookies.txt 文本（yt-dlp 认这个格式） */
export function cookiesToNetscape(cookies) {
  const lines = ['# Netscape HTTP Cookie File', '# generated from the debug-port browser', ''];
  for (const c of cookies ?? []) {
    if (!c?.name || !c?.domain) continue;
    const domain = c.domain.startsWith('.') ? c.domain : c.domain;
    const includeSub = c.domain.startsWith('.') ? 'TRUE' : 'FALSE';
    const expires = Number.isFinite(c.expires) && c.expires > 0 ? Math.floor(c.expires) : 0;
    const secure = c.secure ? 'TRUE' : 'FALSE';
    lines.push([domain, includeSub, c.path ?? '/', secure, expires, c.name, c.value ?? ''].join('\t'));
  }
  return `${lines.join('\n')}\n`;
}

/** 把浏览器 cookie 落盘，返回文件路径（失败返回 null） */
export async function writeBrowserCookiesFile({ port = DEFAULT_PORT, dir = null } = {}) {
  const cookies = await readBrowserCookies({ port });
  if (!cookies || cookies.length === 0) return null;
  const target = dir ?? join(homedir(), '.dsh', 'bili-cookies-from-browser.txt');
  try {
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, cookiesToNetscape(cookies), 'utf8');
    return target;
  } catch {
    return null;
  }
}
