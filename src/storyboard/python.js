/**
 * python.js — 找一台机器上的 Python（OCR 和读播放进度都要用它）。
 *
 * 为什么单独一个模块：这两件事都是"本地 Python 能力"（rapidocr / winrt），
 * 之前各自在 windows 上硬编码了 `D:/asr-local/.venv/Scripts/python.exe` ——
 * 那是开发机上的路径，**跟着包发出去会让别人的插件永远跳过这两项功能**。
 *
 * 顺序：显式配置 → 环境变量 → PATH 上的 python / python3。
 * 找不到就返回 null，调用方据此说"跳过"，不报错。
 */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 从 ~/.dsh/asr.json 里挖出 ASR 用的那个 python（有就当作候选） */
function asrPython(env = process.env) {
  const home = env.DSH_HOME || join(env.USERPROFILE || env.HOME || homedir(), '.dsh');
  try {
    const cfg = JSON.parse(readFileSync(join(home, 'asr.json'), 'utf8'));
    const start = Array.isArray(cfg?.manage?.start) ? cfg.manage.start[0] : cfg?.manage?.start;
    if (typeof start === 'string' && /python(\.exe)?$/i.test(start) && existsSync(start)) return start;
  } catch { /* 没有配置就算了 */ }
  return null;
}

/** @returns {string[]} 候选解释器，按优先级 */
export function pythonCandidates({ config = {}, env = process.env } = {}) {
  const out = [];
  const push = (v) => {
    if (typeof v === 'string' && v.trim() && !out.includes(v.trim())) out.push(v.trim());
  };
  push(config?.ocr?.python);          // 老配置项，保留兼容
  push(config?.python);
  push(env.DSH_PYTHON);
  push(env.DSH_OCR_PYTHON);
  push(env.DSH_WATCH_PYTHON);
  // 用户已经为 ASR 配过一个 venv python —— 说明那台机器上"本地 Python 能力"装在这里的可能性最高。
  // 复用它的好处：不需要再教用户多配一个环境变量。
  push(asrPython(env));
  // PATH 上的：Windows 通常叫 python，类 Unix 叫 python3
  if (process.platform === 'win32') {
    push('python');
    push('py');
  } else {
    push('python3');
    push('python');
  }
  return out;
}

/**
 * 依次试候选解释器，返回第一个能跑通 `-c "import <module>"` 的。
 * 结果进程内缓存：一次启动只会探一次。
 */
const verified = new Map();

export function findPython(module, { config = {}, env = process.env, timeoutMs = 4000 } = {}) {
  const key = String(module);
  if (verified.has(key)) return Promise.resolve(verified.get(key));
  const candidates = pythonCandidates({ config, env });
  return new Promise((resolve) => {
    let i = 0;
    const tryNext = () => {
      if (i >= candidates.length) {
        verified.set(key, null);
        return resolve(null);
      }
      const cmd = candidates[i++];
      execFile(cmd, ['-c', `import ${module}`], { timeout: timeoutMs, windowsHide: true }, (err) => {
        if (err) return tryNext();
        verified.set(key, cmd);
        return resolve(cmd);
      });
    };
    tryNext();
  });
}

/** 清掉探测缓存（测试用） */
export function __resetPythonCache() {
  verified.clear();
}
