import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ffmpegVersion, sha256File } from '../src/storyboard/provenance.js';
import { DEFAULT_FFMPEG } from '../src/storyboard/probe.js';

test('sha256File: hashes file bytes', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-prov-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'hello.txt');
  await writeFile(file, 'hello', 'utf8');
  assert.equal(
    await sha256File(file),
    '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
  );
});

test('ffmpegVersion: reports a version token when ffmpeg exists', async (t) => {
  const version = await ffmpegVersion(DEFAULT_FFMPEG);
  if (!version) return t.skip('ffmpeg not available');
  assert.match(version, /^\d+(\.\d+)+/);
});
