/**
 * watch-probe.js — 「现在放到第几秒了」：从 Windows 系统媒体控件（SMTC）读播放进度。
 *
 * 这是 watch 里唯一需要起子进程的地方（每次探测 ≈1 s），也是唯一跟 Windows 平台绑死的地方。
 * 单独成文件是为了让"要不要读系统媒体"和"台词怎么存"彻底分开 ——
 * 前者是操作系统集成，后者是纯文件 I/O，改一个不该碰到另一个。
 *
 * 不依赖任何播放器插件：任何接了 SMTC 的播放器（VLC / PotPlayer / 电影和电视 / Edge 播网页视频）
 * 都会被读到。
 */

import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findPython } from '../storyboard/python.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * SMTC 的播放状态枚举（`GlobalSystemMediaTransportControlsSessionPlaybackStatus`）：
 *   0 Closed · 1 Opened · 2 Changing · 3 Stopped · **4 Playing · 5 Paused**
 *
 * 我一开始把它写反了（以为 4=暂停），于是「正在播」被报成「暂停」——
 * 用户当场发现："我一直在播放啊"。**枚举值要按官方定义，不能凭印象。**
 */
export const PLAYBACK = {
  CLOSED: 0, OPENED: 1, CHANGING: 2, STOPPED: 3, PLAYING: 4, PAUSED: 5,
};

/**
 * 找一台能 `import winrt` 的 python（读系统媒体控件要用）。
 * 早期版本硬编码了开发机的 .venv —— 别人装上会永远读不到进度，所以统一走候选链 + 实际验证。
 */
export async function probePython({ config = {}, env = process.env } = {}) {
  return findPython('winrt.windows.media.control', { config, env });
}

export function describeStatus(code) {
  if (code === PLAYBACK.PLAYING) return 'playing';
  if (code === PLAYBACK.PAUSED) return 'paused';
  if (code === PLAYBACK.STOPPED) return 'stopped';
  if (code === PLAYBACK.CLOSED) return 'closed';
  return `status-${code}`;
}

/** 只在播放/暂停中的会话里挑 */
export function pickSession(sessions, { title = null, duration = null, input = null } = {}) {
  const live = (sessions ?? []).filter((s) => s.status === PLAYBACK.PLAYING || s.status === PLAYBACK.PAUSED);
  if (live.length === 0) return null;
  if (live.length === 1) return live[0];

  const stem = String(input ?? '').replace(/\.[^.]+$/, '').split(/[\\/]/).pop() ?? '';
  const score = (s) => {
    let n = 0;
    const t = String(s.title ?? '');
    if (title && t && (t.includes(title.slice(0, 8)) || title.includes(t.slice(0, 8)))) n += 3;
    if (stem && t && t.toLowerCase().includes(stem.toLowerCase().slice(0, 8))) n += 3;
    if (duration && Number.isFinite(s.dur) && Math.abs(s.dur - duration) <= 3) n += 2;
    return n;
  };
  const ranked = live.map((s) => ({ s, n: score(s) })).sort((a, b) => b.n - a.n);
  return ranked[0].n > 0 ? ranked[0].s : live[0];
}

/**
 * 读当前所有媒体会话。读不到返回 `{ok:false, error}` —— 上层据此说"读不到进度"，
 * 而不是假装知道用户在看到第几秒。
 */
let probeCache = { at: 0, value: null };

/**
 * 同一秒内重复探测没有意义（位置一直在动，但 1.5 秒内差不了多少），
 * 而每次探测要起一个 python 进程（≈1 s）。缓存一下，一轮唤醒只付一次。
 */
export async function probePlayback({
  python, timeoutMs = 8000, config = {}, env = process.env, maxAgeMs = 1500,
} = {}) {
  if (!python && probeCache.value && Date.now() - probeCache.at < maxAgeMs) return probeCache.value;
  const py = python ?? await probePython({ config, env });
  if (!py) return { ok: false, error: 'no-python-with-winrt (pip install winrt-runtime winrt-Windows.Media.Control winrt-Windows.Foundation)' };
  return new Promise((resolve) => {
    // windowsHide：不然每探一次进度就闪一个黑框。读取进度是高频动作，弹窗必须关掉。
    // PYTHONIOENCODING/PYTHONUTF8：双保险，防止某些 python 发行版忽略 reconfigure。
    execFile(py, [join(HERE, 'watch_smtc.py')], {
      timeout: timeoutMs,
      maxBuffer: 1 << 20,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    },
      (err, stdout) => {
        if (err) return resolve({ ok: false, error: String(err.message).slice(0, 160) });
        try {
          const parsed = JSON.parse(String(stdout ?? '').trim() || '{}');
          const base = parsed?.ok ? parsed : { ok: false, error: parsed?.error ?? 'bad-output' };
          /*
           * **`ok: true` 只说明"这次探测成功了"，不代表"有东西在播"。**
           *
           * winrt 在没有任何媒体会话时照样正常返回 `{ok:true, sessions:[]}`（实测）。
           * 上层若只看 `ok`，就会把"没人放片"读成"读到了位置"，然后拿一个空数组去
           * pickSession —— 拿到的永远是 null，但错误信息会退化成"探测失败"，指向错的方向。
           * 所以这里把两件事拆开：`ok` 只留"探测链路通不通"，`live` 专门说"有活儿会话"，
           * 并且在没有活会话时把 ok 一起收紧，让调用方不可能漏看。
           */
          const sessions = Array.isArray(base.sessions) ? base.sessions : [];
          const live = sessions.some((s) => s?.status === PLAYBACK.PLAYING
            || s?.status === PLAYBACK.PAUSED
            || s?.status === 'playing' || s?.status === 'paused');
          const value = base.ok && !live
            ? {
              ...base, ok: false, live: false, reason: 'no-active-session', error: 'no active media session',
            }
            : { ...base, live };
          probeCache = { at: Date.now(), value };
          return resolve(value);
        } catch {
          return resolve({ ok: false, live: false, error: 'unparsable' });
        }
      });
  });
}
