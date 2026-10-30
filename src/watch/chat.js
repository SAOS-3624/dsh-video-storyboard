/**
 * chat.js — 陪看的"外部聊天框"：一个 localhost 页面 + 一个 jsonl 文件。
 *
 * ## 为什么需要它
 *
 * 阻塞等待期间，**宿主的输入框不能实时把话送到模型手里**。实测（WorkBuddy）：
 * 用户 03:05:35 发的消息，写进会话文件时排在我 03:05:52 那条回复**之后** —— 事后补写。
 * 42 秒的文件大小监控里一个字节都没长。所以"发消息打断阻塞"在宿主这一层不成立。
 *
 * 而这里的 jsonl 是我们自己 append 的，**写盘即时**：阻塞循环每 500ms 读一次就能看见。
 * 这是唯一真正"边等边能听见"的通道。
 *
 * ## 两条入口共用
 *
 * CLI（`watch.mjs`）和 DSH 插件（`video_watch`）都读同一个文件、同一套 watcher，
 * 文件落在 `cacheDir()` 下。谁先起服务谁占端口，另一个复用。
 *
 * DSH 那边之所以也要：它的阻塞一遇到 `paused` 就会返回，用户想"不暂停视频、只说一句"
 * 就没有别的入口了。
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

import { cacheDir } from '../storyboard/cache.js';
import { emitSpeech, onSpeech } from './voice.js';

export const DEFAULT_CHAT_PORT = 9377;

/** 聊天记录（jsonl，一行一条 {role, text, at}） */
export function chatFile(env = process.env) {
  return join(cacheDir(env), 'chat.jsonl');
}

export function readChat(env = process.env) {
  try {
    return readFileSync(chatFile(env), 'utf8').trim().split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

/**
 * 追加一条到统一流。
 *
 * `at` 是**墙钟毫秒**（什么时候写进来的）；`t` 是**播放位置秒**（这句对应视频的哪一刻）——
 * 两者别混：`at` 用来排序，`t` 用来和画面比对。
 *
 * @param {'line'|'assistant'|'user'} role
 * @param {string} text
 * @param {{ t?: number|null, say?: boolean }} [meta] `say` = 这条要不要念出来
 */
export function appendChat(role, text, meta = {}, env = process.env) {
  const dir = cacheDir(env);
  try { mkdirSync(dir, { recursive: true }); } catch { /* 已存在 */ }
  const entry = {
    role,
    text: String(text).slice(0, 2000),
    at: Date.now(),
    ...(Number.isFinite(meta?.t) ? { t: +Number(meta.t).toFixed(2) } : {}),
    ...(meta?.say === true ? { say: true } : {}),
  };
  appendFileSync(chatFile(env), `${JSON.stringify(entry)}\n`, 'utf8');
  return entry;
}

/**
 * 把"到点的台词"写进统一流 —— 这样聊天框里能看见剧本，声音也有得念。
 *
 * 只在 `state === 'due'` 时写：`scheduled` 是清单，不是"这句话现在说出来"。
 * 订阅时带 `voice: false` —— 聊天框只是**看**，它不该让循环以为"有人会念"。
 */
export function attachSpeechToChat({ env = process.env, onEntry = null } = {}) {
  return onSpeech((e) => {
    if (e.state !== 'due') return;
    // 插话那句是**先写流再广播**的（appendAssistantSay），这里再写就重复了
    if (e.origin === 'chat') return;
    const text = String(e.text ?? '').trim();
    if (!text) return;
    const entry = appendChat('line', text, { t: e.at, say: true }, env);
    try { onEntry?.(entry); } catch { /* 展示层的事，别影响写盘 */ }
  }, { voice: false });
}

/** 模型插话时说的那一句：写进流 + 交给声音（同一条事件，两个消费者各取所需） */
export function appendAssistantSay(text, { t = null, env = process.env } = {}) {
  const clean = String(text ?? '').trim();
  if (!clean) return null;
  const entry = appendChat('assistant', clean, { t, say: true }, env);
  // `origin: 'chat'` 告诉展示层的订阅者"这条已经在流里了，别再写第二遍"
  emitSpeech({ at: t, text: clean, state: 'due', origin: 'chat' });
  return entry;
}

/**
 * 盯"新来的用户消息"。
 *
 * 以创建时刻的条数为基线，之后只看增量 —— 历史消息一条都不会被误判成新插话。
 * 同一批里如果有多条，先返回最早那条（模型回完话再来取剩下的）。
 */
export function makeChatWatcher(env = process.env) {
  let seen = readChat(env).length;
  return function poll() {
    const all = readChat(env);
    if (all.length <= seen) return null;
    const fresh = all.slice(seen);
    seen = all.length;
    const u = fresh.find((m) => m.role === 'user' && String(m.text ?? '').trim());
    return u ? { text: u.text, at: u.at } : null;
  };
}

/** 胶囊版：只有一个输入框，配合独立小窗用 */
const WIDGET_PAGE = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>陪看</title>
<style>
html,body{margin:0;height:100%;background:#1b1b1b;overflow:hidden;font-family:system-ui,sans-serif}
form{height:100%;display:flex;align-items:center;padding:0 8px;gap:6px}
input{flex:1;height:42px;background:#262626;border:1px solid #3a3a3a;color:#eee;border-radius:21px;padding:0 16px;font-size:15px;outline:none}
input:focus{border-color:#4a8cd0;background:#2a2a2a}
input::placeholder{color:#666}
#pop{width:42px;height:42px;padding:0;border:0;border-radius:21px;background:#2f4a66;color:#dfe9f5;font-size:17px;cursor:pointer}
</style></head><body>
<form id="f"><input id="i" placeholder="说点什么…（回车发送）" autocomplete="off">
<button type="button" id="pop" title="浮到最上层（画中画小窗）">↑</button></form>
<script>
(function(){
  var SEND="http://127.0.0.1:__PORT__/api/say";
  var f=document.getElementById("f"), i=document.getElementById("i");
  function send(){var v=i.value.trim();if(!v)return;i.value="";
    fetch(SEND,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({text:v})}).catch(function(){});}
  f.addEventListener("submit",function(e){e.preventDefault();send();});
  var pip=null;
  document.getElementById("pop").addEventListener("click",function(){
    if(pip){try{pip.focus();}catch(e){}return;}
    if(!("documentPictureInPicture" in window)){alert("这个浏览器不支持置顶小窗，需要 Edge/Chrome 116+");return;}
    documentPictureInPicture.requestWindow({width:440,height:92}).then(function(w){
      pip=w;
      var st=w.document.createElement("style");st.textContent=document.querySelector("style").textContent;
      w.document.head.appendChild(st);
      w.document.body.style.cssText="margin:0;height:100vh;overflow:hidden";
      w.document.body.appendChild(f);i.focus();
      w.addEventListener("pagehide",function(){document.body.appendChild(f);pip=null;i.focus();});
    }).catch(function(e){pip=null;alert("悬浮失败: "+e.message);});
  });
  i.focus();
})();
</script></body></html>`;

/** 完整版：消息列表 + 输入框 */
const CHAT_PAGE = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>陪看</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{background:#161616;color:#e0e0e0;font:16px/1.65 system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;padding:14px;max-width:680px}
#log{height:calc(100vh - 140px);overflow-y:auto;padding-bottom:8px}
.m{margin:8px 0;padding:9px 12px;border-radius:10px;white-space:pre-wrap;word-break:break-word}
.u{background:#26384a;margin-left:44px}
.a{background:#242424;margin-right:44px}
.l{background:#1c1a17;border-left:3px solid #7a5a2a;margin-right:44px}
.t{font-size:11px;opacity:.45;margin-bottom:3px}
form{display:flex;gap:8px;margin-top:10px}
input{flex:1;padding:11px;background:#202020;border:1px solid #3a3a3a;color:#eee;border-radius:9px;font-size:16px;outline:none}
input:focus{border-color:#4a7ab5}
#send{padding:11px 18px;background:#3a6ea5;color:#fff;border:0;border-radius:9px;font-size:15px}
#pop{padding:11px 14px;background:#2f4a66;color:#dfe9f5;border:0;border-radius:9px;font-size:15px}
</style></head><body>
<div id="log"></div>
<form id="f"><input id="i" placeholder="说点什么…（回车发送）" autocomplete="off">
<button type="button" id="pop" title="浮到最上层（画中画小窗）">↑</button>
<button type="submit" id="send">发送</button></form>
<script>
(function(){
  var BASE="http://127.0.0.1:__PORT__";
  var f=document.getElementById("f"), i=document.getElementById("i"), log=document.getElementById("log");
  function esc(s){return String(s).replace(/[<>&]/g,function(c){return {"<":"&lt;",">":"&gt;","&":"&amp;"}[c];});}
  function fmt(s){s=Math.max(0,Number(s)||0);return ("0"+Math.floor(s/60)).slice(-2)+":"+("0"+(s%60).toFixed(1)).slice(-4);}
  function add(m){
    var kind=m.role==="user"?"u":(m.role==="line"?"l":"a");
    var who=m.role==="user"?"我":(m.role==="line"?"剧本"+(m.t!=null?" "+fmt(m.t)):"陪看");
    var d=document.createElement("div");d.className="m "+kind;
    d.innerHTML="<div class=t>"+who+(m.say?" · 会念":'')+"</div>"+esc(m.text);
    log.appendChild(d);log.scrollTop=log.scrollHeight;}
  function send(){var v=i.value.trim();if(!v)return;i.value="";
    fetch(BASE+"/api/say",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({text:v})}).catch(function(){});}
  f.addEventListener("submit",function(e){e.preventDefault();send();});
  var n=0;
  function poll(){
    fetch(BASE+"/api/messages?since="+n+"&t="+Date.now()).then(function(r){return r.json();}).then(function(j){
      for(var k=0;k<j.msgs.length;k++)add(j.msgs[k]);
      n=j.total;setTimeout(poll,600);
    }).catch(function(){setTimeout(poll,1500);});
  }
  var pip=null;
  document.getElementById("pop").addEventListener("click",function(){
    if(pip){try{pip.focus();}catch(e){}return;}
    if(!("documentPictureInPicture" in window)){alert("这个浏览器不支持置顶小窗，需要 Edge/Chrome 116+");return;}
    documentPictureInPicture.requestWindow({width:440,height:92}).then(function(w){
      pip=w;
      var st=w.document.createElement("style");st.textContent=document.querySelector("style").textContent;
      w.document.head.appendChild(st);
      w.document.body.style.cssText="margin:0;height:100vh;overflow:hidden";
      w.document.body.appendChild(f);i.focus();
      w.addEventListener("pagehide",function(){document.body.appendChild(f);pip=null;i.focus();});
    }).catch(function(e){pip=null;alert("悬浮失败: "+e.message);});
  });
  poll();i.focus();
})();
</script></body></html>`;

/**
 * 起聊天服务（localhost）。返回 { port, close }，调用方决定常驻还是用完就关。
 *
 * @param {{ port?: number, env?: object, onUser?: (text:string)=>void, log?: Function }} o
 */
export async function startChatServer({ port = DEFAULT_CHAT_PORT, env = process.env, onUser = null, log = null } = {}) {
  const page = CHAT_PAGE.replace(/__PORT__/g, String(port));
  const widget = WIDGET_PAGE.replace(/__PORT__/g, String(port));

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
 * 为什么需要它：第一次调用要绑端口 + 可能要开标签页，是异步的；而调用方（`video_watch`
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
