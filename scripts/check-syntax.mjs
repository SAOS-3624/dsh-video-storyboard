// 跨平台语法检查：`node --check` 的批量版本。
//
// 为什么不用 bash 的 for 循环：Windows 上 npm 用 cmd.exe 跑 scripts，
// `for f in src/*.js; do ... done` 是 POSIX 语法，在那里会直接失败，
// 于是 `npm run check` 在 Windows 上等于不可用。
import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const DIRS = ['src', 'bin', 'scripts', 'examples'];
const EXT = /\.(mjs|js)$/;

// **必须递归**：src/tools/ 这种子目录里的文件不扫，等于给自己留了个"语法错了但 check 通过"的洞。
async function walk(dir) {
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(p));
    else if (e.isFile() && EXT.test(e.name)) out.push(p);
  }
  return out;
}

const files = [];
for (const dir of DIRS) files.push(...await walk(dir));

if (files.length === 0) {
  console.error('check: no source files found (run from the repo root)');
  process.exit(1);
}

const failures = [];
for (const file of files.sort()) {
  try {
    await run(process.execPath, ['--check', file]);
  } catch (err) {
    failures.push({ file, message: (err.stderr || err.message || '').trim() });
  }
}

if (failures.length > 0) {
  for (const f of failures) console.error(`✗ ${f.file}\n${f.message}\n`);
  console.error(`check: ${failures.length} of ${files.length} file(s) failed`);
  process.exit(1);
}

console.log(`check: ${files.length} file(s) ok`);
