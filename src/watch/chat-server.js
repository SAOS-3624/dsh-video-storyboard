/**
 * chat-server.js — 聊天框的 localhost 服务：两条页面路由 + 两个 API + 生命周期。
 *
 * 路由一共四条，没有第五条：
 *   GET  /              完整版页面（消息列表 + 输入框）
 *   GET  /widget        胶囊版（只有输入框）
 *   GET  /api/messages  自 `since` 起的增量，给页面每 600ms 轮询
 *   POST /api/say       用户说的话，写进流并回调 onUser
 *
 * 页面内容在 `chat-view.js`，流在 `chat-store.js`。这里只做"收请求、派给谁"。
 * CLI（`watch.mjs`）和 DSH 插件（`watch_together`）都读同一个文件、同一套 watcher，
 * 谁先起服务谁占端口，另一个复用（`chatAlive` 判）。
 */

import { createServer } from 'node:http';

import { CHAT_PAGE, WIDGET_PAGE, renderPage } from './chat-view.js';
import { appendChat, readChat } from './chat-store.js';

export const DEFAULT_CHAT_PORT = 9377;

/**
 * 起聊天服务（localhost）。返回 { port, server, close }，调用方决定常驻还是用完就关。
 *
 * @param {{ port?: number, env?: object, onUser?: (text:string)=>void, log?: Function }} o
 */
export async function startChatServer({
  port = DEFAULT_CHAT_PORT, env = process.env, onUser = null, log = null,
} = {}) {
  const page = renderPage(CHAT_PAGE, port);
  const widget = renderPage(WIDGET_PAGE, port);

  const server = createServer((req, res) => {
    let u;
    try { u = new URL(req.url, 'http://127.0.0.1'); } catch { res.writeHead(400); res.end(); return; }

    if (u.pathname === '/' || u.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page);
      return;
    }
    if (u.pathname === '/widget') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(widget);
      return;
    }
    if (u.pathname === '/api/messages') {
      const since = Math.max(0, Number(u.searchParams.get('since')) || 0);
      const all = readChat(env);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ total: all.length, msgs: all.slice(since) }));
      return;
    }
    if (u.pathname === '/api/say' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 8000) req.destroy(); });
      req.on('end', () => {
        try {
          const j = JSON.parse(body);
          const text = String(j?.text ?? '').trim().slice(0, 500);
          if (text) {
            appendChat('user', text, {}, env);
            log?.(`[用户] ${text}`);
            onUser?.(text);
          }
        } catch { /* 坏请求就算了 */ }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  return { port, server, close: () => new Promise((r) => server.close(() => r())) };
}

/**
 * 把聊天框**准备好**（幂等）：服务没起来就起，起来了就什么都不做。
 *
 * 为什么需要它：第一次调用要绑端口 + 可能要开标签页，是异步的；而调用方（`watch_together`
 * 进入阻塞之前）只想要一句 `void ensureChatSession(port)` —— 起不来也不该让陪看失败，
 * 所以这里把异常吞掉，只留一个失败的 promise。
 */
let chatSession = null;
export function ensureChatSession(port = DEFAULT_CHAT_PORT) {
  if (!chatSession) {
    chatSession = startChatServer({ port }).catch(() => null);
  }
  return chatSession;
}

/** 把已经起好的那个服务关掉（测试/退出用） */
export async function closeChatSession() {
  const s = chatSession;
  chatSession = null;
  if (s) {
    try { const r = await s; await r?.close?.(); } catch { /* 关不掉就算了 */ }
  }
}

/** 这个端口上有没有已经跑着的聊天服务 */
export async function chatAlive(port = DEFAULT_CHAT_PORT, timeoutMs = 1200) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/messages?since=0`, { signal: ac.signal });
    return r.ok;
  } catch { return false; } finally { clearTimeout(timer); }
}
