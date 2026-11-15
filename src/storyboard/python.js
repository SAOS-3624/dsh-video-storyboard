/**
 * python.js — 找一台机器上的 Python（OCR 和读播放进度都要用它）。
 *
 * 为什么单独一个模块：这两件事都是"本地 Python 能力"（rapidocr / winrt），
 * 之前各自在 windows 上硬编码了 `D:/asr-local/.venv/Scripts/python.exe` ——
 * 那是开发机上的路径，**跟着包发出去会让别人的插件永远跳过这两项功能**。
 *
 * 顺序：显式配置 → 环境变量 → ASR 用过的解释器 → 常见安装目录 → PATH 上的 python3 / python。
 * 找不到就返回 null，调用方据此说"跳过"，不报错。
 *
 * **为什么要扫"常见安装目录"**：DSH 桌面版从 Finder / 程序坞启动时拿不到登录 shell 的 PATH
 * （macOS 上只有 `/usr/bin:/bin:/usr/sbin:/sbin`），Homebrew 的 `/opt/homebrew/bin` 不在里面。
 * 于是 `brew install python` 明明装好了，插件和设置页却都报"没有 Python"，让用户再装一遍。
 * 把 Homebrew / MacPorts / python.org / pyenv / asdf / conda 的默认目录列成候选，
 * "装在哪"就和"能不能找到"解耦了 —— 和 binaries.js 对 ffmpeg 的做法是同一个思路。
 */

import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const isFile = (path) => {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
};

function homeDir(env) {
  return env.HOME || env.USERPROFILE || homedir();
}

/**
 * 扫 `<root>/Python3xx` 这类版本目录 —— Windows 的 python.org 安装包就是这么放的。
 * 按目录名里的数字排（`Python312` 比 `Python38` 新），不能按字符串排：
 * 字符串里 "Python38" > "Python312"，3.8 会排到 3.12 前面。
 */
function versionedDirs(root, pattern) {
  const versionOf = (name) => {
    const digits = /(\d+)$/.exec(name);
    return digits ? Number(digits[1]) : 0;
  };
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && pattern.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => versionOf(b) - versionOf(a)) // 新版本优先
      .map((name) => join(root, name));
  } catch {
    return [];
  }
}

/**
 * 常见安装目录（**不依赖 PATH**，也不保证存在）。
 * 存在性在 pythonCandidates() 里过滤，所以这里可以放心列全。
 * @returns {string[]}
 */
export function pythonInstallDirs({ env = process.env, platform = process.platform } = {}) {
  const home = homeDir(env);
  const dirs = [];
  const add = (dir) => {
    if (typeof dir === 'string' && dir !== '' && !dirs.includes(dir)) dirs.push(dir);
  };
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    for (const dir of versionedDirs(join(local, 'Programs', 'Python'), /^Python3\d+$/i)) add(dir);
    for (const dir of versionedDirs('C:\\', /^Python3\d+$/i)) add(dir);
    if (env.ProgramFiles) for (const dir of versionedDirs(env.ProgramFiles, /^Python3\d+$/i)) add(dir);
    return dirs;
  }
  if (platform === 'darwin') {
    add('/opt/homebrew/bin');   // Apple Silicon 的 Homebrew
    add('/usr/local/bin');      // Intel Homebrew；python.org 安装包也在这儿放符号链接
    add('/opt/local/bin');      // MacPorts
    add('/Library/Frameworks/Python.framework/Versions/Current/bin'); // python.org 安装包
    add(join(home, 'miniconda3', 'bin'));
    add(join(home, 'anaconda3', 'bin'));
    add(join(home, '.pyenv', 'shims'));
    add(join(home, '.asdf', 'shims'));
    add(join(home, '.local', 'bin'));
    add('/usr/bin');            // 系统自带（Xcode CLT），最后兜底
    return dirs;
  }
  add('/usr/local/bin');
  add('/usr/bin');
  add(join(home, '.local', 'bin'));
  add(join(home, 'miniconda3', 'bin'));
  add(join(home, 'anaconda3', 'bin'));
  add(join(home, '.pyenv', 'shims'));
  add(join(home, '.asdf', 'shims'));
  add('/snap/bin');
  return dirs;
}

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

/**
 * @param {{config?:object, env?:NodeJS.ProcessEnv, platform?:NodeJS.Platform, probe?:(path:string)=>boolean}} [opts]
 * @returns {string[]} 候选解释器，按优先级
 */
export function pythonCandidates({ config = {}, env = process.env, platform = process.platform, probe = isFile } = {}) {
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
  // 常见安装目录里的绝对路径。只收真的存在的文件：候选链每多一个不存在的名字，
  // 探测时就多 spawn 一次 ENOENT，报错信息里也多一行噪音。
  const names = platform === 'win32' ? ['python.exe', 'python'] : ['python3', 'python'];
  for (const dir of pythonInstallDirs({ env, platform })) {
    for (const name of names) {
      const full = join(dir, name);
      if (probe(full)) push(full);
    }
  }
  // PATH 上的：Windows 通常叫 python（另有 py 启动器），类 Unix 叫 python3
  if (platform === 'win32') {
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
 *
 * **成功永久缓存，失败缓存 60 秒**（`FAIL_TTL_MS`）。
 * 原来是失败也永久记住 —— 于是"装完 rapidocr 必须重启整个 DSH 宿主"，
 * 否则永远报 `no-python-with-rapidocr`，而且报不出为什么（#39 的报告人在这上面花了不少时间）。
 * 留一个 60 秒的窗口，装完包最多等一分钟就自动恢复，不用重启；
 * 没装的机器每分钟最多重探一轮（每个候选一次 `python -c import`），摊在本就要跑几秒的取帧里可以忽略。
 */
const verified = new Map();
const FAIL_TTL_MS = 60_000;

export function findPython(module, { config = {}, env = process.env, timeoutMs = 4000 } = {}) {
  const key = String(module);
  const hit = verified.get(key);
  if (hit && (hit.cmd || Date.now() - hit.at < FAIL_TTL_MS)) {
    return Promise.resolve(hit.cmd);
  }
  const candidates = pythonCandidates({ config, env });
  const debug = env.DSH_OCR_DEBUG;
  return new Promise((resolve) => {
    let i = 0;
    const tried = [];
    const tryNext = () => {
      if (i >= candidates.length) {
        verified.set(key, { cmd: null, at: Date.now() });
        if (debug) {
          console.error(`[python] no interpreter can import ${key}; tried: ${tried.join(', ') || '(none)'}`,
            `— cached as missing for ${FAIL_TTL_MS / 1000}s`);
        }
        return resolve(null);
      }
      const cmd = candidates[i++];
      execFile(cmd, ['-c', `import ${module}`], { timeout: timeoutMs, windowsHide: true }, (err) => {
        if (err) {
          tried.push(cmd);
          return tryNext();
        }
        verified.set(key, { cmd, at: Date.now() });
        return resolve(cmd);
      });
    };
    tryNext();
  });
}

/** 清掉探测缓存（测试用） */
export function resetPythonCache() {
  verified.clear();
}
