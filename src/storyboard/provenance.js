/**
 * provenance.js — best-effort source and tool provenance.
 *
 * Both helpers are deliberately failure-tolerant: provenance is metadata, not a
 * reason to fail a render. The version is cached per binary path; hashing a large
 * file is opt-in at the pipeline level because it costs a full read.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const versionCache = new Map();

/** Full-file SHA-256 as lowercase hex. Rejects if the file cannot be read. */
export async function sha256File(path) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

/** First token after "ffmpeg version", e.g. "6.1.1"; null when unavailable. */
export async function ffmpegVersion(ffmpegPath = 'ffmpeg') {
  if (versionCache.has(ffmpegPath)) return versionCache.get(ffmpegPath);
  let version = null;
  try {
    const { stdout } = await run(ffmpegPath, ['-version'], {
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
    const line = String(stdout).split(/\r?\n/).find((l) => l.startsWith('ffmpeg version '));
    if (line) version = line.slice('ffmpeg version '.length).trim().split(/\s+/)[0] || null;
  } catch {
    version = null;
  }
  versionCache.set(ffmpegPath, version);
  return version;
}
