import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pythonCandidates, pythonInstallDirs } from '../src/storyboard/python.js';
import { pythonStatus } from '../src/settings/deps.js';

const tmp = (prefix = 'storyboard-py-') => mkdtempSync(join(tmpdir(), prefix));
const only = (paths) => (path) => paths.includes(path);

test('pythonInstallDirs: macOS 先 Homebrew，系统 Python 最后兜底', () => {
  const dirs = pythonInstallDirs({ env: { HOME: '/Users/me' }, platform: 'darwin' });
  assert.equal(dirs[0], '/opt/homebrew/bin', 'Apple Silicon 的 Homebrew 必须排第一');
  assert.ok(dirs.includes('/usr/local/bin'), 'Intel Homebrew / python.org 符号链接');
  assert.ok(dirs.includes('/Users/me/.pyenv/shims'));
  assert.ok(dirs.includes('/Users/me/miniconda3/bin'));
  assert.equal(dirs.at(-1), '/usr/bin', '系统自带的那份只当兜底');
  assert.equal(new Set(dirs).size, dirs.length, '不能有重复目录');
});

test('pythonInstallDirs: Linux 覆盖 /usr/local/bin、/usr/bin 和 ~/.local/bin', () => {
  const dirs = pythonInstallDirs({ env: { HOME: '/home/me' }, platform: 'linux' });
  assert.deepEqual(dirs.slice(0, 3), ['/usr/local/bin', '/usr/bin', '/home/me/.local/bin']);
  assert.ok(dirs.includes('/home/me/.pyenv/shims'));
});

test('pythonInstallDirs: Windows 扫版本目录，按版本号从新到旧', () => {
  const root = tmp();
  const programs = join(root, 'Programs', 'Python');
  for (const name of ['Python38', 'Python312', 'Python27', 'not-python']) {
    mkdirSync(join(programs, name), { recursive: true });
  }
  const dirs = pythonInstallDirs({ env: { LOCALAPPDATA: root }, platform: 'win32' });
  assert.deepEqual(dirs, [join(programs, 'Python312'), join(programs, 'Python38')],
    '3.12 要排在 3.8 前面，且 Python2 不算');
});

test('pythonCandidates: 显式配置 > 环境变量 > asr.json > 常见目录 > PATH', () => {
  const home = tmp();
  const asr = join(home, 'asr-python');
  writeFileSync(asr, '');
  writeFileSync(join(home, 'asr.json'), JSON.stringify({ manage: { start: [asr] } }));
  const brew = '/opt/homebrew/bin/python3';
  const intel = '/usr/local/bin/python3';

  const cands = pythonCandidates({
    config: { ocr: { python: '/custom/python3' } },
    env: { HOME: home, DSH_HOME: home, DSH_OCR_PYTHON: '/env/python3' },
    platform: 'darwin',
    probe: only([brew, intel]),
  });

  assert.deepEqual(cands, ['/custom/python3', '/env/python3', asr, brew, intel, 'python3', 'python']);
});

test('pythonCandidates: 只收真实存在的绝对路径，PATH 名字始终保留', () => {
  const cands = pythonCandidates({
    env: { HOME: '/Users/me' },
    platform: 'darwin',
    probe: () => false,
  });
  assert.deepEqual(cands, ['python3', 'python'], '一个都不存在时只剩 PATH 候选，不该塞一堆 ENOENT');
});

test('pythonCandidates: Windows 用 python.exe，PATH 上保留 python 和 py', () => {
  const root = tmp();
  const dir = join(root, 'Programs', 'Python', 'Python312');
  mkdirSync(dir, { recursive: true });
  const exe = join(dir, 'python.exe');
  const cands = pythonCandidates({
    env: { LOCALAPPDATA: root },
    platform: 'win32',
    probe: only([exe]),
  });
  assert.deepEqual(cands, [exe, 'python', 'py']);
});

test('pythonStatus: 找到 python3 时带上版本和路径', { skip: process.platform === 'win32' }, async () => {
  const dir = tmp();
  const fake = join(dir, 'python3');
  writeFileSync(fake, '#!/bin/sh\necho "Python 3.12.4"\n');
  chmodSync(fake, 0o755);

  const status = await pythonStatus({}, { candidates: [fake] });
  assert.equal(status.ok, true);
  assert.match(status.detail, /Python 3\.12\.4/);
  assert.equal(status.command, fake);
});

test('pythonStatus: Python 2 不算"装好了"', { skip: process.platform === 'win32' }, async () => {
  const dir = tmp();
  const fake = join(dir, 'python');
  writeFileSync(fake, '#!/bin/sh\necho "Python 2.7.18"\n');
  chmodSync(fake, 0o755);

  const status = await pythonStatus({}, { candidates: [fake] });
  assert.equal(status.ok, false, 'rapidocr 只支持 3.8+，把 python2 当成可用会误导用户');
});

test('pythonStatus: 一个都没有时报未找到，并说明试过几个', async () => {
  const status = await pythonStatus({}, { candidates: ['definitely-not-a-python-xyz', 'nope-python-xyz'] });
  assert.equal(status.ok, false);
  assert.match(status.detail, /未找到/);
  assert.match(status.detail, /2 个解释器/);
});
