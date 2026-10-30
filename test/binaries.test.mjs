import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  describeMediaSearch, mediaCandidates, resolveMediaBinary,
} from '../src/storyboard/binaries.js';

function touch(path) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, 'not really an executable');
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-bin-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('binaries: 显式环境变量优先，即使文件不存在', () => {
  const path = join(tmpdir(), 'configured-ffmpeg');
  assert.equal(resolveMediaBinary('ffmpeg', {
    env: { DSH_FFMPEG_PATH: path }, platform: 'linux',
  }), path);
});

test('binaries: 先找 $DSH_HOME/tools/ffmpeg/bin，再找 $DSH_HOME/bin', (t) => {
  const home = fixture(t);
  const tools = join(home, 'tools', 'ffmpeg', 'bin', 'ffmpeg');
  const bin = join(home, 'bin', 'ffmpeg');
  touch(bin);
  touch(tools);

  const found = resolveMediaBinary('ffmpeg', {
    env: { DSH_HOME: home }, platform: 'linux',
  });
  assert.equal(found, tools);
  assert.ok(mediaCandidates('ffmpeg', {
    env: { DSH_HOME: home }, platform: 'linux',
  }).some((c) => c.path === bin));
});

test('binaries: 支持 DSH 安装根目录（$DSH_HOME 的上一级）', (t) => {
  const root = fixture(t);
  const home = join(root, '.dsh-home');
  const installRoot = join(root, 'app');
  const path = join(installRoot, 'tools', 'ffmpeg', 'bin', 'ffmpeg');
  touch(path);

  const found = resolveMediaBinary('ffmpeg', {
    env: { DSH_HOME: join(installRoot, '.dsh-home') }, platform: 'linux',
  });
  assert.equal(found, path);
});

test('binaries: Windows 使用 .exe 后缀', (t) => {
  const home = fixture(t);
  const path = join(home, 'bin', 'ffmpeg.exe');
  touch(path);

  assert.equal(resolveMediaBinary('ffmpeg', {
    env: { DSH_HOME: home }, platform: 'win32',
  }), path);
});

test('binaries: 找不到时回退裸命令，并在描述里列出搜索路径', (t) => {
  const home = fixture(t);
  assert.equal(resolveMediaBinary('ffprobe', {
    env: { DSH_HOME: home }, platform: 'linux',
  }), null);
  const text = describeMediaSearch('ffprobe', {
    env: { DSH_HOME: home }, platform: 'linux',
  });
  assert.match(text, /ffprobe not found; tried:/);
  assert.match(text, /tools\/ffmpeg\/bin/);
});
