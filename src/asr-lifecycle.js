/**
 * asr-lifecycle.js — 让本地 ASR 服务"用完就走"。
 *
 * 背景（2026-10-28，三次死机）：本地 ASR 服务常驻要吃约 6.8 GB 提交额度。
 * 这台 16 GB 的机器上，它和 Premiere / 大项目同时存在就会把提交上限撞穿，
 * 表现为 dwm 崩 0xc00001ad、桌面黑屏、整机卡死。
 *
 * 插件**不会**自己去拉起别人的服务 —— 除非用户在 `~/.dsh/asr.json` 里显式写了 `manage.start`。
 * 一旦写了，就按下面的契约办：
 *
 *   1. 转录前：端点活着 → 什么都不做（owned=false，不碰别人的进程）
 *   2. 端点死了 → 跑 manage.start，等它 ready（最多 waitMs）
 *   3. 本次运行结束 → 只有"是我们拉起来的"才安排停止；到点前又有请求就取消停止
 *
 * 关键设计：**只杀自己拉起来的那个**。别人（另一个插件、你自己开的窗口）启动的实例，
 * 我们无权杀 —— 杀了会把正在用它的任务打断。
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const SHELL_EXE = 'cmd.exe';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * `start` 写成 `.py` 时补上解释器。
 *
 * 真实事故：`"start": "D:/asr-local/server-sherpa.py"` —— Windows 上直接 spawn 一个 .py 什么也不会发生，
 * 于是每次转写都是 ECONNREFUSED，看起来像"自启没成功"。这里按 <脚本目录>/.venv 找解释器，找不到用 PATH 里的。
 */
function resolveScriptStart(start) {
  if (typeof start !== 'string' || !/\.py$/i.test(start)) return start;
  const dir = dirname(start);
  const candidates = process.platform === 'win32'
    ? [join(dir, '.venv', 'Scripts', 'python.exe')]
    : [join(dir, '.venv', 'bin', 'python')];
  for (const py of candidates) {
    if (existsSync(py)) return [py, start];
  }
  return [process.platform === 'win32' ? 'python' : 'python3', start];
}

/** 从 asr.json 的配置里取出生命周期设置（没有就返回 null，表示不托管） */
export function lifecycleConfig(config = {}) {
  const m = config?.manage;
  if (!m || typeof m !== 'object' || !m.start) return null;
  // start 可以是字符串（.cmd/.exe）或数组（[exe, ...args]）。
  // **数组更干净**：Windows 上起 .cmd 会闪一个控制台窗口，而且批处理对行尾/编码很敏感
  // （LF 行尾会让 cmd.exe 把注释片段当命令执行 —— 实测弹出一屏 "'wo' 不是内部或外部命令"）。
  const raw = Array.isArray(m.start) ? m.start.map(String) : String(m.start);
  const start = resolveScriptStart(raw);
  return {
    start,
    stop: m.stop ? String(m.stop) : null,
    waitMs: Number.isFinite(m.waitMs) ? m.waitMs : 120_000,
    // 默认 10 分钟：冷启动要 30 秒，2 分钟就关等于每次都要重付这 30 秒。
    // 语义是"最后一次运行结束后 10 分钟没有新运行就关"。
    idleMs: Number.isFinite(m.idleMs) ? m.idleMs : 600_000,
    healthPath: typeof m.healthPath === 'string' ? m.healthPath : '/health',
  };
}

/** 端点是否已经在应答（/health 不通就退到 /v1/models，兼容不支持 /health 的服务） */
export async function probeEndpoint(baseUrl, { fetchImpl = fetch, timeoutMs = 1500, healthPath = '/health' } = {}) {
  const root = String(baseUrl ?? '').replace(/\/v1\/?$/, '').replace(/\/$/, '');
  if (!root) return false;
  for (const path of [healthPath, '/v1/models']) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetchImpl(`${root}${path}`, { signal: ctrl.signal });
      clearTimeout(timer);
      if (res.ok) return true;
    } catch {
      /* 换下一个探测点 */
    }
  }
  return false;
}

/**
 * 让服务自己退出（POST /shutdown）。比按 pid 杀可靠得多 ——
 * Windows 上 start 出来的壳进程会先退出，真正的 pid 谁也拿不到。
 * 服务若不支持这个端点（返回 404），调用方再退回按端口杀。
 */
export async function stopViaHttp(baseUrl, { fetchImpl = fetch, timeoutMs = 3000 } = {}) {
  const root = String(baseUrl ?? '').replace(/\/v1\/?$/, '').replace(/\/$/, '');
  if (!root) return false;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetchImpl(`${root}/shutdown`, { method: 'POST', signal: ctrl.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

/** 从 baseUrl 里抠出端口（默认 80/443） */
export function portOf(baseUrl) {
  try {
    const u = new URL(String(baseUrl).replace(/\/v1\/?$/, ''));
    return Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
  } catch {
    return 8000;
  }
}

/**
 * 找出监听这个端口的进程号。
 *
 * 为什么需要：Windows 上 `start /b script.cmd` 会**立刻退出**，我们手上那个 pid 是壳的，
 * 壳一退就没了句柄 —— 而真正吃内存的 python 还在。只能按端口反查。
 */
export async function findPidByPort(port, { execImpl } = {}) {
  const run = execImpl ?? (await import('node:child_process')).execFile;
  const cmdline = process.platform === 'win32'
    ? ['netstat', ['-ano', '-p', 'tcp']]
    : ['lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']];
  return await new Promise((resolve) => {
    run(cmdline[0], cmdline[1], { timeout: 4000 }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      if (process.platform === 'win32') {
        const line = stdout.split(/\r?\n/).find((l) => new RegExp(`[:.]${port}\\s.*LISTENING`, 'i').test(l));
        const m = line && line.trim().match(/(\d+)\s*$/);
        resolve(m ? Number(m[1]) : null);
      } else {
        resolve(Number(stdout.trim().split(/\s+/)[0]) || null);
      }
    });
  });
}

/* 只保留一个"待停止"的定时器：连续几次调用应该共用一个实例，而不是起了又杀 */
let pendingStop = null;
let ownedChild = null;

/** 取消即将发生的停止（同一会话里连续调用时，不该把服务杀了重开） */
export function keepAlive() {
  if (pendingStop) {
    clearTimeout(pendingStop);
    pendingStop = null;
  }
}

/**
 * 确保 ASR 可用。返回 { owned, started }：
 *  - owned=true 表示**这个进程是我们拉起来的**，运行结束可以停
 *  - owned=false 表示它本来就在跑，不碰
 */
export async function ensureAsr({
  baseUrl, config, env = process.env, spawnImpl, fetchImpl = fetch, log = () => {},
} = {}) {
  const life = lifecycleConfig(config);
  const alive = await probeEndpoint(baseUrl, { fetchImpl, healthPath: life?.healthPath });
  if (alive) {
    keepAlive();
    return { owned: false, started: false };
  }
  if (!life) return { owned: false, started: false, reason: 'no manage.start configured' };

  log(`starting local ASR: ${Array.isArray(life.start) ? life.start.join(' ') : life.start}`);
  let child;
  if (Array.isArray(life.start)) {
    // 直接起 exe：windowsHide 才会真的不建控制台窗口，也不受批处理编码影响
    child = spawnImpl(life.start[0], life.start.slice(1), {
      detached: true, stdio: 'ignore', windowsHide: true, env,
    });
  } else {
    const isBatch = /\.(cmd|bat)$/i.test(life.start);
    child = process.platform === 'win32' && isBatch
      ? spawnImpl(SHELL_EXE, ['/c', 'start', '', '/b', life.start], {
        detached: true, stdio: 'ignore', windowsHide: true, env,
      })
      : spawnImpl(life.start, [], {
        shell: true, detached: true, stdio: 'ignore', windowsHide: true, env,
      });
  }
  child.unref?.();
  ownedChild = child;

  const deadline = Date.now() + life.waitMs;
  while (Date.now() < deadline) {
    await sleep(1000);
    if (await probeEndpoint(baseUrl, { fetchImpl, healthPath: life.healthPath })) {
      log('local ASR is ready');
      keepAlive();
      // 壳进程可能已经退了，按端口找出真正在听的那个
      const real = await findPidByPort(portOf(baseUrl ?? ''));
      if (real) ownedChild = { pid: real };
      return { owned: true, started: true, pid: real ?? child.pid };
    }
  }
  return { owned: true, started: true, pid: child.pid, timedOut: true };
}

/**
 * 运行结束后安排停止。只有 owned 的实例才会被停。
 * 到点前如果又来了请求（keepAlive），这次停止会被取消。
 */
export function scheduleStop({ owned, config, killImpl, baseUrl, minIdleMs } = {}) {
  if (!owned) return false;
  const life = lifecycleConfig(config);
  if (!life) return false;
  // 陪看这类"持续调用"的场景要临时放宽空闲窗口：否则每段之间服务就被关了，
  // 下一段又要冷启动（实测 5 s，用户感知为"每次都要等"）。
  if (Number.isFinite(minIdleMs) && minIdleMs > life.idleMs) life.idleMs = minIdleMs;
  keepAlive();
  const pid = ownedChild?.pid;
  pendingStop = setTimeout(() => {
    pendingStop = null;
    try {
      if (killImpl) killImpl(pid, life);
      else if (baseUrl && life.quietShutdown !== false) {
        // 首选：请它自己退出（服务端 /shutdown）；不支持时再按端口杀
        stopViaHttp(baseUrl).then((ok) => {
          if (ok || !pid) return;
          if (process.platform === 'win32') {
            import('node:child_process')
              .then(({ execFile }) => execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => {}))
              .catch(() => {});
          } else { try { process.kill(pid, 'SIGTERM'); } catch { /* 已退出 */ } }
        }).catch(() => {});
      } else if (pid) {
        if (process.platform === 'win32') {
          // 连子树一起杀；start /b 起的 python 不在我们的句柄里，只能靠 /T
          import('node:child_process')
            .then(({ execFile }) => execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => {}))
            .catch(() => {});
        } else {
          try { process.kill(pid, 'SIGTERM'); } catch { /* 已退出 */ }
        }
      }
    } catch {
      /* 已经不在了 */
    }
    ownedChild = null;
  }, life.idleMs);
  pendingStop.unref?.();
  return true;
}

/** 测试用：清掉内部状态 */
export function __resetLifecycle() {
  keepAlive();
  ownedChild = null;
}

/** 当前是否有"我们拉起的"实例还活着（用于运行开始时决定要不要续命） */
export function isOwned() {
  return Boolean(ownedChild?.pid);
}

