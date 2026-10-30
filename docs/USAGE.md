# Install & usage (detailed)

For a first-time user. Every command is copy-pasteable; brackets explain *why*.
中文版：[USAGE.zh.md](./USAGE.zh.md)

---

## 0. In one line

Compress a video into **one numbered grid**: a timestamp range per cell, the transcript spoken inside it,
and an audio strip on the same axis — so a text-only model can look, cite "cell 5", and ask for a close-up.

One image is 384 tokens and holds 9–16 frames.

---

## 1. Requirements

| Need | Check | Note |
|---|---|---|
| Node ≥ 20 | `node --version` | uses built-in `fetch`, `node --test` |
| ffmpeg + ffprobe | `ffmpeg -version` | the only external dependency, not bundled |
| DSH (desktop or a normal profile) | — | the plugin runs in its tool layer |

If ffmpeg is not on `PATH`, the plugin also checks `$DSH_HOME/tools/ffmpeg/bin`,
`$DSH_HOME/bin`, then `<install-root>/tools/ffmpeg/bin` (the order used by DSH itself).
An explicit override always wins:

```bash
DSH_FFMPEG_PATH=D:/ffmpeg/bin/ffmpeg.exe
DSH_FFPROBE_PATH=D:/ffmpeg/bin/ffprobe.exe
```

---

## 2. Install

### 2.1 Desktop app (most people)

The desktop profile is **owned by the Electron app** — `dsh plugin` refuses it, so use the bundled script:

```bash
git clone https://github.com/SAOS-3624/dsh-video-storyboard.git
cd dsh-video-storyboard
node scripts/install-dev.mjs            # copy into the profile + register the bundle
```

Then **restart DSH** (the plugin tree is composed at process start).

- status: `node scripts/install-dev.mjs --check`
- remove: `node scripts/install-dev.mjs --remove`
- after editing the code: re-run the script **and** restart (it copies a snapshot, not a symlink)

> Why not a symlink: Node resolves bare specifiers (`@deepseek-ai/dsh-tools`) through the *real* path, so a
> symlink makes it walk up from the repo and never find the host package.

### 2.2 Normal profile

```bash
dsh plugin --profile web add dsh-video-storyboard
```

### 2.3 CLI only (no DSH)

```bash
node bin/storyboard.mjs your-video.mp4 --cells 9 --text
```
Everything under `bin/` runs standalone.

---

## 3. First run (3 minutes)

```bash
# 1) container metadata only — free, no image
node bin/storyboard.mjs your-video.mp4 --plan 30

# 2) one sheet + the text index
node bin/storyboard.mjs your-video.mp4 --cells 9 --out sheet.png --text

# 3) one window only (does not scan the whole file)
node bin/storyboard.mjs your-video.mp4 --from 120 --to 180 --cells 6 --text
```

Step 2 prints something like:

```
[probe] 1920x1080 24.00fps 299.41s audio
[scan] 7186 帧 → 141 个切点（阈值 16，自适应 28 个密集段）
[audio] mean -23.0 LUFS, peak -13.4 LUFS, 1 silence gaps (1.9s of 299s)
[sheet] sheet.png  1009x623  3x3  cell≈331x184  strip=55px

<storyboard ... grid="9 cells x 1 image(s)" ... cuts="141 (avg 2.1s)">
cell 1 (r1c1) = 00:00.00-00:33.10  cuts 9
    "…"
```

---

## 4. Which tool, when

| You want | Use |
|---|---|
| the shape of the clip | `video_storyboard` (3×3, one image) |
| what that sign at 3:12 says | `video_zoom({ from, to, cells: 4 })` |
| length / audio / subtitle tracks | `video_probe` (0 tokens) |
| a 2-hour film, start to finish | probe first, then pick structure or sequence |

**Two-stage is the intended usage**: 384 tokens for the shape, another 384 only where it matters.

---

## 5. Parameters

### video_probe

| param | default | note |
|---|---|---|
| `input` | required | absolute path |

Returns duration / resolution / fps / rotation / audio / subtitles **and two reading orders** — structure
(spoils the ending) vs sequence (never looks ahead).

### video_storyboard

| param | default | when to change |
|---|---|---|
| `input` | required | — |
| `from` / `to` | whole file | read a long film in windows; also the way to avoid spoilers |
| `cells` | auto | 1–16. More detail → 12/16; more clarity → 4/6 |
| `sheets` | auto | 1–4. Each image is ~384 tokens in DSH (host-dependent) |
| `pick` | `sharp` | change only if you want segment-mid or histogram-representative |
| `burn` | `index` | `none` turns the burned cell number off. Timecodes are never burned in — they live in the text at 0.01 s |
| `minGap` | 1.2 | drop to 0.4 so half-second shots get their own cell |
| `transcript` | `auto` | `off` for pure visual analysis |
| `transcriptFile` | — | SRT / JSON `[{start,end,text}]` / `{body:[{from,to,content}]}` (subtitle JSON in the `{body:[{from,to,content}]}` shape); skips subtitle extraction and ASR |
| `sourceHash` | `false` | also write the source SHA-256 into the manifest (reads the whole file) |
| `detail` | `med` | `low` 60 / `med` 120 / `high` 400 chars, cut on sentence boundaries |
| `cellRange` | — | `[14, 42]` renders only that slice of the index |
| `textOnly` | `false` | text only, no image (paging: ~0.8 s/page) |

### video_zoom

| param | default | note |
|---|---|---|
| `input` / `from` / `to` | required | shorter window → larger cells |
| `cells` | 6 | 1–9; 3–4 for subtitles and faces |
| `minGap` | 1.2 | 0.3–0.4 to stop short shots being merged |
| `sourceHash` | `false` | also write the source SHA-256 into the manifest |

---

## 6. Workflows

**A. Short clip, structure**
```js
video_storyboard({ input, cells: 9 })
video_zoom({ input, from: 12, to: 18 })
```

**B. Long film, sequential (no spoilers)**
```js
video_probe({ input })
video_storyboard({ input, from: 0,   to: 300 })
video_storyboard({ input, from: 300, to: 600 })
// …5 minutes at a time, never looking ahead
```
Each window's scan is cached, so re-reading a stretch later is free.

**C. Long film, structural (indexing)**
```js
video_storyboard({ input, cells: 16, sheets: 4 })
video_storyboard({ input, from: 600, to: 900 })     // open only what looks interesting
```

**D. Fast-cut montage**
```js
video_storyboard({ input, from: 42, to: 50, cells: 12 })          // read the density (cuts N per cell)
video_zoom({ input, from: 43, to: 46, cells: 6, minGap: 0.4 })    // then cut on real shots
```

**E. Quote-level transcript**
```js
video_storyboard({ input, cells: 9, detail: 'low' })              // cheap overview
video_storyboard({ input, cells: 9, textOnly: true, cellRange: [4, 6], detail: 'high' })
```

**F. Batch a whole film (CLI)**
```bash
node bin/storyboard.mjs film.mp4 --batch 300 --out film.png
# → film-w01.png … film-w24.png + film-timeline.md
```
Window boundaries snap to real cuts (one scan up front), so a window never ends mid-sentence.

---

## 7. Transcript backend (optional)

Env vars, or a file (a desktop host may not inherit your `setx`):

```json
// C:\Users\<you>\.dsh\asr.json
{
  "baseUrl": "http://127.0.0.1:8000/v1",
  "key": "local",
  "language": "zh",
  "terms": { "绘插": "彗差" }
}
```

Precedence: **env > `$DSH_HOME/asr.json` > built-in default**. `terms` is a correction dictionary applied
single-pass (longest match first); the replacement count is reported.

Without any of it: embedded subtitles are used if present, otherwise the text layer is skipped and the
sheet still renders.

---

## 8. Cache

- `%LOCALAPPDATA%\dsh-video-storyboard\cache` (Windows) / `~/.cache/...` elsewhere
- key = `(path, size, mtime, window, threshold)` — **no content hash** (reading 2 GB is slower than rescanning)
- 50 MB cap, LRU
- move it: `DSH_VIDEO_CACHE_DIR=D:/dsh-cache`; disable: `cache: false`

---

## 9. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `ffmpeg exited ...` | ffmpeg not on PATH | set `DSH_FFMPEG_PATH` |
| `transcript="asr-failed"` | endpoint down / 401 / service not running | read the error line — it includes `ECONNREFUSED` or `401` |
| all text lands in one cell | backend returns no `segments` | enable VAD segmentation server-side (see docs/asr-contract.md) |
| mush | too many cells, or 4K source | fewer `cells`, or `video_zoom` on the section |
| `text stopped at cell N` | index exceeded one tool result | continue with `cellRange`, as the message says |
| timestamps shifted by seconds | backend merged a long request | client already chunks to ≤45 s; check the server |
| few grey blocks | −40 dB / 0.6 s absolute threshold | noisy footage is under-detected — known limit |

---

## 10. Cost

| item | amount |
|---|---|
| one image (9–16 cells) | **384 tokens** |
| text index, 9 cells (med) | ~250 tokens |
| text index, 64 cells (med) | ~3,800 tokens |
| first scan of a 5-minute clip | 6–13 s |
| same file, second call | 3.6 s (cached) |
| `textOnly` page | 0.8 s |

Chinese transcript is usually more expensive than the image: `detail` and `cellRange` are the real knobs.

---

## 11. CLI without DSH

```bash
node bin/scan-video.mjs film.mp4 9        # threshold tuning: cuts / scores / segments / peaks
node bin/scan-stats.mjs film.mp4          # score distribution (look before choosing a threshold)
node bin/asr-check.mjs film.mp4 --from 100 --seconds 12   # verify the ASR path alone
```
