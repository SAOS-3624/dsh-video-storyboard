/**
 * chat-view.js — 聊天框的两个页面（纯字符串，没有逻辑）。
 *
 *   WIDGET_PAGE  胶囊版：只有输入框 + 「↑」置顶按钮，配合独立小窗用
 *   CHAT_PAGE    完整版：消息列表 + 输入框 + 置顶按钮
 *
 * 单独成文件是因为这两块**每次都要连着贴**（模板里一句 JS 都不能有语法错，否则页面全白，
 * 而错误只在浏览器控制台里，服务端「200 OK」一切正常）。它和 HTTP 路由混在一起时，
 * 改一个 padding 要翻服务代码，改路由又要跨过两百行 HTML。
 *
 * `__PORT__` 由 `chatServer.js` 在返回前替换成真实端口 —— 页面和 API 必须同源，
 * 写死 9377 的话换了端口输入框就发不出去。
 */

/** 胶囊版：只有一个输入框，配合独立小窗用 */
export const WIDGET_PAGE = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>陪看</title>
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
export const CHAT_PAGE = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>陪看</title>
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
    var who=m.role==="user"?"我":(m.role==="line"?"剧本"+(m.t!=null?" "+fmt(m.t):""):"陪看");
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

/** 把模板里的 `__PORT__` 换成真实端口 */
export function renderPage(template, port) {
  return String(template).replace(/__PORT__/g, String(port));
}
