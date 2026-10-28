# Changelog

## [Unreleased]

### 头条：ASR 这三个 bug 是本轮最大的一块

三条都来自真实用户，都是"明明能用却被我们自己的规则挡住"：

1. **本机 ASR 被强制要 key**（0.4.2 修，@小观棋 报）—— 自己跑的 FunASR 不校验 Authorization，
   却被 `if (!key) return null` 一刀切跳过。本机地址现在不要求 key。
2. **服务只启不停**（0.4.1/0.4.2，用户三次死机的根因）—— 常驻吃 6.8 GB 提交额。
   现在按需拉起、10 分钟无新对话就请它退出，服务端另有 30 分钟空闲自退兜底。
3. **长片扫描期间被空闲计时器关掉**（本轮修）—— 计时器在"上一次运行结束"时设的，
   新一次运行扫描超过窗口就会白丢一次冷启动（30 秒）。运行入口即续命。

### Fixed

- **Bilibili's HTTP 567 now says what it is and tries once more.** 567 is their risk control, not a format
  problem — most often a video that needs a signed-in session (1080P+, 会员/付费) or a rate-limit. Before, the
  message was yt-dlp's raw text, which reads like a plugin bug.

  Now: one automatic retry with a browser User-Agent, `Referer: https://www.bilibili.com/`, and
  `--sleep-requests 1` (the retry only fires on 567/412, never on permanent errors); if it still fails, the
  error names both ways out — a cookies.txt, or download the file and pass a local path. `--retries 3
  --fragment-retries 5` also went into the base args, since CDN hiccups are routine.

### Performance

- **Transcription now runs while the scan runs.** It only needs the silence positions (from the 1–3 s audio
  pass), not the cut points, so it was always safe to start early — it just never was. A 21-minute screen
  recording went **202 s → 89 s** (scan 82 s, transcription finished inside it, frames 3.4 s). A 5-minute
  window: 31.7 s with `transcript` at 0.03 s, i.e. fully overlapped.

  Two things broke on the way and are fixed: the transcript block moved ahead of a `let asrLife` declaration
  (`Cannot access before initialization`, which silently turned the first measurement into `asr-failed` while
  still showing a fast time), and the block's `textInSilence` had to be returned rather than captured.

- **Frame extraction runs in parallel.** Nine cells used to be nine sequential ffmpeg calls (each one seeks
  and decodes a single frame). The loop is now plan → concurrent extract → assemble in order, at
  `frameConcurrency` (default half the cores, capped at 8). Measured on a 90 s clip with 9 cells: **13.3 s at
  1, 8.0 at 3, 6.5 at 5, 4.0 at 8**; whole run 18.0 → 12.2 s with transcription on. Cell order and the
  sub-tiled fast-cut cells are unchanged (verified visually).

  `result.timing` now carries per-phase seconds (`audio`/`scan`/`transcript`/`frames`) so the next slow
  report can start from numbers instead of guesses. Caveat: part of the 202 → 89 s is the OS file cache
  warming between the two runs — the honest structural gain is the ~58 s of transcription, not 113 s.

### Changed

- **The local ASR service now runs on sherpa-onnx by default.** Same HTTP contract, different runtime:
  **cold start 30 s → 5 s** (measured through the plugin, model load alone 1.9 s), models **2.1 GB → 500 MB**,
  no torch. The model also got newer: `paraformer-zh-2024-03-09` gets 「像差」 right without any hotword,
  where the old one needed one.

  What it costs: sherpa's paraformer has **no timestamp output and no hotword interface**. Timestamps are
  rebuilt by running VAD (silero) over the audio and recognizing each speech run, then splitting sentences by
  punctuation and distributing the run's duration by character count — honest to about a second, and the
  first version (hard-cutting every 15 s) **dropped words at the seams**, so the runs are no longer cut.

  Hotwords still work on the `funasr` backend (`ASR_BACKEND=funasr` in `start-asr.cmd`); on sherpa they are
  ignored and the `terms` table is the fallback.

### Added

- **Hotwords: a word list that biases decoding, so homophones stop winning.** `"hotwords": "像差 焦段 光圈"`
  in `asr.json`, sent as a `hotword` form field. seaco_paraformer supports it natively. Measured on a lens
  review: *"也就是所谓的**相差**"* → *"也就是所谓的**像差**"* with one word added, no other change.

  This matters more than swapping models: the transcription was already fluent, the misses were homophones
  (像差/相差) that no general model resolves without knowing the subject.

  Server-side: `start-asr.cmd` now takes `ASR_BACKEND=sherpa|funasr`; `sherpa` is the default.

### Fixed

- **A partial download was wiped on failure, so every retry started from zero.** On a flaky connection the
  media directory was removed (`rm -rf`) whenever yt-dlp exited non-zero — including the `.part` file that is
  the whole point of resuming. Reported as "下到一半直接清零重新开始，而且下得更慢". Now the directory is
  kept and `--continue` is explicit; stale parts are pruned by age instead.

- **Progressive streams were never tried, so every Bilibili download was a DASH pair plus a merge.** The
  selector jumped straight to `bv*+ba`. It now tries `b[height<=N]` (one file, no merge) first and falls back
  to DASH — the scan copy only needs 360p, and a single stream is both faster and less to write.

- **A slide deck that "looks the same on every page" produced no cuts at all.** With an absolute threshold,
  a page turn that only changes a few characters scores 3–8 and disappears under any sane floor, so the
  result fell back to equal intervals. Very static films (median score < 3 **and** fewer than 0.1 cuts/s) now
  re-read with the relative-baseline detector (`spikeCuts`), which compares each frame with its local
  neighbourhood instead of a global number. Measured: a slide where a small block appears went 0 → 1 cut;
  the concept PV stayed at 44 (the guard is what keeps it from doubling — without the rate condition it went
  44 → 88).

  The absolute floor is 4, measured: on a 320×180 capture, changing ~3.5 % of the frame peaks at **5.7** and
  ~8 % at **11.8** — both under any sane threshold (12–15), while a still frame's noise floor is 0.0–1.5.
  Below ~1.5 % area the change is 1.6 and nothing can call that a cut; that limit is documented rather than
  papered over.

  An e2e test builds exactly that fixture (a block appearing at t=2 on an otherwise still frame) and asserts
  the cut is found — the guard for "the function exists, the unit test is green, and nothing calls it".

### Changed

- **The idle window is now 10 minutes, and the backstop moved to 30.** Cold start costs 30 s, so a 2-minute
  window meant re-paying it constantly. The rule is now literally "10 minutes after the last run, with no new
  run in between, stop it". `manage.idleMs` still overrides per machine. The server's own `ASR_IDLE_EXIT_S`
  went from 600 s to 1800 s — a backstop must be *longer* than the caller's timer, otherwise it closes an
  instance that is still in use.

### Fixed

- **A long scan could let the idle timer shut the service down mid-run.** The timer is set when a run ends,
  so a *new* run that spends more than `idleMs` scanning (before it ever asks for a transcript) would find the
  endpoint dead and pay the 30 s cold start again. Any new run now renews the lease at entry, and the timer is
  re-armed on exit even when that run never touched ASR.

  The failure mode was a wasted restart, never a wrong result: the endpoint is probed before transcribing, and
  a dead one is started before the request goes out.

### 为什么"相对基线"之前没生效

`spikeCuts()` 是 9adba94 就写好的，单测也一直是绿的 —— 但 `pipeline.js` **从来没有调用过它**。
函数躺在 scan.js 里六个小时，纯 PPT 视频照样一条切点都找不到。这和 0.4.1 里 `video_locate` 漏 import
是同一类错误：**代码存在、测试通过、路径没接上**。

现在两处都有端到端测试守着（`e2e: 极静素材`、`locate.execute` 实际调用），这类"没接线"会红。

## [0.4.2] — 2026-10-28

0.4.1 shipped a broken tool and a key requirement nobody could justify. Both reported within an hour.

### Fixed

- **`video_locate` crashed on every call** in 0.4.1: `src/index.js` used `recallSegments` / `matchSegments` /
  `formatMatches` without importing `./locate.js`, so the tool threw `ReferenceError` the moment it ran.
  The registration test exercised storyboard and zoom but never locate — it does now, and that is the guard
  for this exact class of mistake. Reported by @盲目吃鱼豹豹 with the one-line patch.

- **A local ASR service no longer needs a `key`.** Any transcription without a key was skipped outright, so
  self-hosted FunASR users were told "configure a key to actually listen" while their service was running fine
  two ports away. Loopback base URLs (`127.0.0.1` / `localhost` / `[::1]`) now send no `Authorization` header
  and are not gated on a key. Cloud endpoints still require one — without it we skip rather than 401.
  Reported by @小观棋.

### Docs

- New README section on subtitles and ASR: which models we actually use (`paraformer-zh` + `fsmn-vad` +
  `ct-punc` locally, `FunAudioLLM/SenseVoiceSmall` by default in the cloud), three ways to configure it
  (local service / any OpenAI-compatible cloud / a finished SRT), the `/health` + `/shutdown` contract a
  self-hosted server must honour, and the env vars.

## [0.4.1] — 2026-10-28

### Added

- **The local ASR service can now be started on demand and stopped when the run ends.** Three hosts crashed
  on 2026-10-28 because that service sat resident at ~6.8 GB of commit charge while Premiere was open.

  Opt-in via `~/.dsh/asr.json`:

  ```json
  "manage": { "start": "D:/asr-local/start-asr.cmd", "idleMs": 120000, "waitMs": 180000 }
  ```

  With `manage.start` set: if the endpoint is down when a transcript is needed, it is started and awaited;
  when the run finishes the plugin stops **the instance it started** after `idleMs` of quiet. An instance
  someone else started is never touched — killing that would break whatever is using it.

  The server also grew its own backstop: `ASR_IDLE_EXIT_S` (default 600 s, `start-asr.cmd` sets it) makes it
  exit on its own when nothing calls it, so even a manually launched copy cannot sit there forever.

  Measured end to end with the service down: one storyboard call took 42.2 s and came back with
  `transcript: asr` instead of `asr-failed`. Cold start alone is **30.3 s** (spawn → `/health` ok); a warm
  call adds nothing.

  Stopping through a pid was the wrong idea: `start /b` returns a shell that exits immediately, so the pid we
  held was already dead while python kept the memory. The service now exposes `POST /shutdown` and the plugin
  asks it to exit — verified: request returns `true`, endpoint is gone 1.5 s later, and the idle timer stops it
  on schedule (alive at 2 s, dead at 5 s with `idleMs: 3000`).

## [0.4.1] — 2026-10-28

Same story as 0.4.0, one level down: a broken thing that was invisible because it failed quietly.

### Fixed

- **A downloaded copy with no audio track said "no audio in the source".** On an anonymous Bilibili URL the
  lowest track is video-only, so the whole audio path went silent — `transcript=no-audio`, empty envelope,
  `meanLufs=null` — and the manifest implied the video itself had no sound. It now probes the downloaded file,
  compares it with the formats the source advertised, and says which of the two it is:
  *"no audio in this copy: the downloaded track is silent while the source has audio. Pass cookies, or download
  locally"*. Reported by @xingyueDanYang with a reproduction.

### Added

- **`video_locate` — a phrase to a timestamp, with no frame decode.** It matches against the transcript
  already produced by `video_storyboard` (or runs ASR once if there is none) and returns timestamped lines
  best-first, ready to feed into `video_zoom`. Matching ignores punctuation, scores by longest common
  substring, and prefers the shorter line on a tie ("记忆管理局" beats "记忆管理局的人来了"). Measured
  **1 ms** on a 90 s clip. Note: needs speech — a music-only film has one empty segment and matches nothing.

- **`<name>.evidence.json` next to every sheet.** Per cell: from/to, the frame timestamp, cut count, chars,
  text. The manifest is prose for the model; this is for whoever has to verify it later without re-running.

- **Manifest says the sheet is already in context** (one line, ~100 chars). Re-reading the same film used to
  cost another 384 tokens per question; now the model is told to cite cells by number instead.
  Net: +138 characters always, −384 per avoided re-read.

### Fixed

- **Vertical `video_zoom` picked the wrong track** (issue #9). `pickVideoFormat` filtered on `height`, which
  on a 9:16 video is the *long* edge, so 1080x1920 was excluded and it fell back to 480x852 — while the
  manifest claimed 1080p. It now compares the short edge.

- **Tiled sub-frames bypassed the high-resolution direct link** (issue #9). `extractSubTile` read
  `remote.url` / `remote.headers`, but the object carries `{uri, http:{userAgent, referer}}`, so every tile
  silently fell back to the local 360p copy without counting a `frameFallback`. Now it uses the real fields,
  falls back per tile on failure, and reports the fallback.

- **Tiled cells no longer emit `frame@`.** A k×k cell contains k² moments; the old midpoint timestamp was
  not the moment its picture was taken. The evidence sidecar records `frame_at: null` for those cells.

## [0.4.0] — 2026-10-28

The release where fast cuts finally count. Three things were true before this version and are not any more:

1. **A shot shorter than 0.35 s could not be seen at all** — the scanner merged it away. Montage lives
   entirely below that line, so every count on a fast-cut film was a floor, not a count.
2. **A cell covering a montage showed exactly one frame.** The number "22 shots" was in the text and
   nowhere in the picture.
3. **Vertical video could not be downloaded.** Every portrait URL from Bilibili died on the format selector.

Measured across ten content types (slide recording, surveillance, 2D animation, 3D short, studio news,
handheld vlog, mobile-game ad, anime mashup, concept PV, 51-minute documentary), the per-second cut count
went from a suspiciously uniform 0.22–0.27 to the range the content actually has: 0.08 for a slide deck,
1.18 for a mashup.

### Fixed

- **Vertical Bilibili videos could not be downloaded at all.** yt-dlp reports a 9:16 video's formats as
  360x640 / 480x852 / 720x1280, so `height` is the *long* edge and `bv*[height<=480]+ba/b[height<=480]`
  matched nothing: every request ended in `Requested format is not available`. The selector now ends with an
  unfiltered fallback (`.../bv*+ba/b`) and sorts by `res:` (yt-dlp's short-edge metric), so a portrait video
  picks 480x852 instead of failing. Found by running the cross-domain test set (BV1BjxM69EHh).

- **A cut-on-every-frame edit was counted as 9 shots when there were 23 — and could be dismissed as camera
  motion.** Two causes: the one-frame gap was `1.02 / fps`, i.e. *longer* than a frame, so adjacent frames
  merged; and `degraded: 'motion'` fired on any window with a short median shot and many high-scoring frames,
  which is exactly what a per-frame flash looks like.

  The gap is now chosen per window: `1.02 / fps` normally, `0.9 / fps` when the window's mean score says
  nearly every frame changed. And `motion` now also requires a *smooth* score series (`cv < 0.4`) — a steady
  pan varies a little every frame, a flash alternates wildly. Measured: per-frame clip 9 → **21** (true 23),
  concept PV unchanged at 48, talking head 122 → 124.

- The target-count cap added in 0.2.2 was applied even when the caller passed an explicit `threshold`.
  The cap exists to stop tied frames from dragging in a cluster; applying it to an explicit threshold
  overrode the caller's decision, so fast material could not be counted at all. Measured on a synthetic
  3 s / 18-shot clip: `threshold: 5` returned 4 cuts instead of 16.

### Changed

- Sub-dividing a cell now also requires the cuts inside it to be *strong* (mean score ≥ 30), not just
  frequent. A 2D line-art animation hits 0.7 shots/s with cuts that are almost invisible frame to frame,
  so tiling produced nine nearly identical sub-frames — measured on a RETAS demo and on a mobile-game ad.
  Real montages are unaffected (concept PV still tiles 4×4, the 108-anime mashup tiles four cells).

### Added

- **Fast cells are tiled into k×k sub-frames.** A cell covering a montage used to show one representative
  frame, so "this stretch flashed nine times" was a number in the text and nothing else. When a cell's shot
  density is high (≥ 0.7 shots/s, i.e. average shot ≤ 1.4 s) it is now rendered as a k×k contact sheet —
  k = ceil(√shots), capped at 4 and by k×k sub-frame size ≥ 100×56 px. **Token cost is unchanged**: it is
  still one image.

  Measured on the concept PV at `cells: 6`: the three montage cells became 4×4 (16 frames each) while the
  slow cells stayed full size, and the credits frame stayed readable. The talking-head clip's cells sit at
  0.4–0.6 shots/s, so nothing is tiled there — the density gate is what keeps this from shredding ordinary
  narrative pacing.

  Two guards from measurement: sub-frames below 100×56 stop being distinguishable (110×61 was the floor in
  the tiling experiment), and tiling costs k²−1 extra frame extractions, so each sheet has a budget of 32
  extra frames and steps down k rather than blowing up render time.

- **Cuts are now re-read per 2-second window instead of per "burst".** The earlier version only refined
  windows that `findBursts` flagged, which fails exactly where it is needed most: when the whole film is
  fast there is no burst, so nothing is refined at all (a 3 s / 18-shot clip returned 4 cuts). The window
  test asks a local question instead — *can the coarse gap see what is in this window* — so it does not
  depend on the film's average.

  Both decisions run on the same per-frame scores, so this costs no extra decode (1.4 s vs 5 s when it was a
  second ffmpeg pass). Adopt the fine reading only when it finds more cuts, is not classified `motion`, and
  its cuts average ≥ 25 in score (real cuts average 59, a slow pan 18).

  Measured: the all-fast synthetic clip **4 → 16 cuts** (true 17); the 12 s / 3 s / 10 s mix refines only the
  flash; the concept PV goes 40 → 48 and the talking head 121 → 122, i.e. it now also catches real cuts the
  0.35 s gap was merging (spot-checked one: 84.75 s really is a hard cut from the title card to the credits).

- `video_storyboard({ scanGap })` — the minimum spacing between detected cuts, default 0.35 s. It is a
  different knob from `minGap` (which merges cells). Fast material needs it: the same 3 s / 18-shot clip
  yields **3 cuts at the default** and **16 cuts at `scanGap: 0.12`**. Until this, the scanner had no way
  to observe anything under ~0.35 s per shot, which is exactly the range montage lives in.

## [0.3.2] — 2026-10-28

### Fixed

- URL input now accepts yt-dlp's DASH output names such as `video.f100022.mp4`. The downloader
  previously required the exact name `video.mp4` and failed with
  `unexpected container: ... (expected mp4)` even though the file was a valid video. The file
  is now renamed to the stable `video.mp4` before probing, so the cache and pipeline keep one
  path contract. (Reported by @xingyueDanYang on `BV16VxM6dEeb`; fix from PR #8 by
  @ggfgfgf-on.)
- A download that produced **audio only** (`video.f30280.m4a`) is now rejected with an explicit
  message instead of being renamed to `video.mp4`. The rename-by-file-name step above made this
  failure mode possible: a valid file name is not a valid video stream.

### Security

- Transcript text is treated as untrusted data. Segments that look like instructions addressed
  to the agent (for example "ignore previous instructions" or "stop the run / do not call tools")
  are reported in `manifest.transcript.suspectInjection` with source, timestamp and a bounded
  quote. The run continues; the manifest line explicitly says this is data, not a command.
  This is evidence, not a content filter: false negatives are preferable to flagging ordinary
  dialogue. (Reported by @xingyueDanYang.)
- The video **title** is scanned too — it is external text that lands in the manifest, and it has
  no timecode, so its `from`/`to` stay `null` instead of collapsing to second 0.

## [0.3.1] — 2026-10-28

### Host ffmpeg discovery

`ffmpeg` / `ffprobe` are now resolved in this order: explicit `DSH_FFMPEG_PATH` /
`DSH_FFPROBE_PATH` (or `FFMPEG_PATH` / `FFPROBE_PATH`), then `$DSH_HOME/tools/ffmpeg/bin`,
`$DSH_HOME/bin`, the install-root `tools/ffmpeg/bin`, and finally `PATH`. A DSH install can
therefore carry its own ffmpeg without every plugin re-implementing the lookup. Missing binaries
still fail with a message that lists every path that was tried.

### Manifest provenance

The text manifest now records what produced the image, not just the timing:

- `cell="WxH"` — the actual cell size, so a reader can tell whether subtitles were legible.
- `tokens="N (DSH estimate)"` — explicitly an estimate; the host owns the real token count.
- `ffmpeg="..."` — the ffmpeg build that decoded the frames.
- `sha256="..."` — optional source hash, only with `sourceHash: true` / `--source-hash`; it reads
  the whole file, so it is off by default. For a URL input it hashes the downloaded scan copy,
  not the remote stream; the `source:` line still identifies the URL.
- one `plan:` line with the measured inputs (`duration`, `scanThreshold`, `meanLufs`,
  `speechRate`, `motion`, `cuts`, `hasSubtitle`) and the effective thresholds from
  `PLAN_THRESHOLDS`. This is diagnostic output, not a new set of knobs.

The JSON manifest (CLI `--manifest`) carries the same `provenance` and full `plan` object.

### Fixes

- Window-scoped transcript stats now count only the segments inside the window. A whole-film
  `transcriptFile` previously divided the full character count by the window duration, which made
  `charsPerSec` and the auto-plan's speech-rate classification wrong for every clipped window.
- `video_zoom` now forwards `transcript` (and `sourceHash`) instead of silently falling back to
  the pipeline defaults.

## [0.3.0] — 2026-10-28

**A URL is now a valid input.** Paste a Bilibili link (or anything yt-dlp supports) instead of a local
path. Two decisions make this different from "download the video, then analyse it".

### Two-tier fetching

Scanning only needs structure — it gets downscaled to 64x36 — so it reads a 360p copy of the whole file
(~7 MB per 5 min). Close-ups go back to the original stream, one frame at a time, and never touch disk.

Why the low-res copy is downloaded at all instead of streamed: `pick:"sharp"` needs 3 candidate frames
per segment, 27 random seeks for a 9-cell grid. Local: 9.6 s. Over HTTP: 51.8 s. Seven megabytes buys
the right to jump around. Pure streaming would have been ~3.5x slower end to end.

### `transcriptFile` — skip ASR when the source already has captions

Accepts SRT, a plain `[{start,end,text}]` array, or Bilibili's `{body:[{from,to,content}]}`, detected
automatically. On a 90 s clip this took a run from 16.9 s to **5.1 s**. It also works on files with no
audio track, where the old logic fell through to `no-audio`.

### Auth: probe first, complain only when it actually matters

The first cut of this release hard-failed when no cookies were configured. Real use proved that wrong:
`BV1BK411Q7ys` lists 360/480/720/1080 even anonymously, while `BV1fq4y1u7nC` tops out at 480p. Per-video
and unpredictable, so refusing outright just made the agent hunt for a cookie it did not need.

Now the plugin probes first and proceeds if the source already offers the target tier; only when it
cannot does it record `degraded` plus a one-line note. The result always carries `auth`,
`maxAvailable` and `availableHeights`, so nothing is hidden.

Reading the browser's cookie jar is still not an option: Chromium 127+ stores `SESSDATA` with App-Bound
Encryption (`v20`), which no external process can decrypt. `docs/SETUP.md` documents the file export.

### Config moves to `~/.dsh/video.json`

DSH Desktop cannot read environment variables set with `setx` — the ASR side already learned this the
hard way. Precedence is now **tool argument > env var > `~/.dsh/video.json`**.

```json
{ "cookies": "D:/path/to/bili-cookies.txt", "scanHeight": 360, "zoomHeight": 1080 }
```

### Source capability, measured once

A single `yt-dlp -J` (2.4 s, same cost as `-g`) returns every format, so `maxAvailable` /
`availableHeights` are known before anything is downloaded and the zoom target is clamped to what the
source actually has. Degradation is reported as `source-max-Np` (the video's own ceiling),
`auth-limit` (a tier exists but this identity cannot reach it) or `fetch-degraded-Np` (the fetch
succeeded but returned less) — three different situations that used to collapse into one vague field.

### Manifest fixes for a real misread

A model read a cell whose picture came from the cell's *end* as if it belonged to the cell's *start*,
and shifted a whole segment 30 seconds early. Both causes were ours:

- `alignCells` joined every ASR line with a space, discarding each line's own `from`. A cell spanning
  09:38.9–10:20.5 that contained a real break at 10:09.4 looked like one continuous sentence. A
  `[10:09.4]` marker is now inserted **at breaks only** (gap >= 1 s); stamping every line would eat a
  quarter of the 120-character budget for nothing. Cells also carry `lines` and a `broken` flag.
- The per-cell line never said when the frame was taken. `t_frame` was already in the data — it is now
  rendered as `frame@01:13.59`, **only for `pick:"sharp"`** (mid is derivable; sharp's 3-candidate pick
  is not). One line above the cells states that `frame@` is not the cell start.

### Not done, deliberately

Title-card detection. Probed with `blackdetect` on two real files: 8 minutes of an anime feature
contains 10 black spans, 9 of them 0.3–1.7 s transitions. Without footage that actually has
chapter cards there is no way to validate a detector, and a list of 10 mostly-wrong markers costs
characters while teaching the model to distrust the index.

### New parameters

`transcriptFile`, `scanHeight` (360), `zoomHeight` (1080), `cookies`, `allowAnonymous` (now: suppress
the warning, does not gate the fetch) — on the relevant tools.

### Numbers

| What | Time |
|---|---|
| `yt-dlp -J` (formats + metadata) | 2.4 s |
| Download 360p, 4.5 MB | 4.5 s |
| Scan + 9 cells (90 s clip) | 9.1 s |
| Full run with ASR | 16.9 s |
| Full run with `transcriptFile` | **5.1 s** |
| 6-cell zoom re-read at 1080p | 5.3 s, 0 fallbacks |

Tests 216 -> **273**. CI needs no network, no yt-dlp binary and no real cookies (a fake yt-dlp script
covers the fetch path).

### Also

`docs/SETUP.md` + `SETUP.zh.md`: yt-dlp install, cookie export, environment variables, five-step
verification, failure table. `bin/storyboard.mjs` accepts a URL plus `--cookies` / `--scan-height` /
`--transcript-file`.


## [0.2.2] — 2026-10-27

Three things, all of them about *not* wasting the reader's attention.

**`layout: 'strip'` is gone.** It was never worth its surface area: at equal cell count a grid canvas keeps
a normal aspect ratio, so the cells are actually **bigger**, and the burned-in indices already settle the
reading order. Removed the parameter, the 8:1 aspect guard and every doc mention.
*Breaking for anyone who passed it — hence the version note below.*

**Transcript vs silence consistency.** A line that sits >60 % inside a detected silence is counted and
reported: either the speech is under the −40 dB gate, or the ASR invented it. Pure in-memory comparison —
measured **0.009 ms** for 222 lines × 11 gaps, no extra ffmpeg call, one line in the text block when non-zero.

**A real manual.** `docs/USAGE.md` + `docs/USAGE.zh.md`: three install paths, a 3-minute first run, every
parameter of all three tools, six workflows, transcript backend config, cache, a troubleshooting table built
from failures we actually hit, and a cost table.

> Versioning note: removing a parameter is technically a breaking change (0.3.0). It is released as 0.2.2
> because the parameter had existed for under an hour and nobody could have depended on it.

## [0.2.1] — 2026-10-27

Everything since 0.2.0, as one patch release (the whole set is polish and a few parameters, no
architectural change).

**"How fast is this cut?" is now a number in the text, not something the model has to count.**

- Every cell line carries `cuts N` when that cell contains shot changes, and the header carries
  `cuts="141 (avg 2.1s)"`. The yellow ticks on the footer strip already show *where*; this says *how many*.
- `video_zoom` accepts `minGap` — re-read a fast-cut montage with `minGap: 0.4` and 0.3 s shots get their
  own cell instead of being merged into a neighbour.
- `video_zoom` accepts `layout: 'strip'` — one row of cells for a short window of continuous motion.
  Falls back to a grid if the strip would exceed 12:1 (vision encoders resize by the long edge, so an
  18:1 strip leaves every cell ~100 px wide).
- `--batch` now scans once for cut points and **snaps window boundaries to real cuts** (`--no-snap` to
  disable). A 92 s clip at 30 s windows lands on 0–30.88 / 30.88–59.88 / 59.88–92 instead of the clock.
- Audio strip height is capped by cell height, so a 2476 px-wide strip layout no longer gets a 136 px
  footer eating 37 % of the image.

**Text index diet.** Measured on a 9-cell run: 2,892 → **2,171 characters (-25 %)**, with no
information lost that the model can actually use.

- per-cell transcript cap 180 → 120 chars (page with `cellRange` if you need the rest)
- `sharp 479.7` removed from the text index — a bare number the model cannot interpret; still in the JSON
  manifest
- `image 1` dropped when there is only one sheet (it is pure redundancy); kept for multi-sheet

**`detail: low | med | high`** — transcript budget per cell, and truncation now lands on a
sentence boundary instead of cutting mid-word.

Measured on a 9-cell run: `low` 1,521 chars · `med` 1,915 · `high` 3,031. Note that med is *cheaper*
than the old hard-cut 120 (2,171) even though the budget is the same, because stopping at the last
sentence end usually costs fewer characters than filling the quota.

**`detail: low|med|high`** — transcript budget per cell (60/120/400), and truncation lands on a
sentence boundary. Measured on 9 cells: 1,521 / 1,915 / 3,031 characters — `med` is 12 % cheaper than
the old hard cut at the same budget.

**Read order is explicit.** `video_probe` offers STRUCTURE (overview, spoils the ending) and SEQUENCE
(window by window, never looks ahead) and refuses to choose.

**Speed.** `--batch` reuses one full scan across windows (17.0 s → 9.0 s on a 92 s clip); `video_zoom`
takes `minGap` and `layout: 'strip'`; audio strip height is capped by cell height.

**Removed `layout: 'strip'`.** It was never worth its surface area: at equal cell count a grid canvas has a
normal aspect ratio, so the cells are *bigger*, and the burned indices already settle the reading order. One
fewer parameter to explain.

**Transcript vs silence consistency.** A line that sits (>60 %) inside a detected silence is counted and
reported: either the speech is below the −40 dB gate, or the ASR invented it. Pure in-memory comparison —
measured **0.009 ms** for 222 lines × 11 gaps, no extra ffmpeg call.

**Cut points are listed when they fit.** A window with ≤ 24 cuts now prints
`cut points (3): 00:12.75, 00:16.13, 00:44.50` — exact times, because the strip can only be read to
±2–4 s. Busy windows still get counts only, so an overview does not pay for a 141-entry list.

**Silence blocks stay a backdrop.** Tried drawing them as an occluder (bars skipped inside silence); it
looked like the waveform was chopped into solid grey bars, so it was reverted — grey is a backdrop *behind*
the bars. The wording now says what a short bar actually means: "quiet for this film", not "silent".

Tests 174 → **186**.

## [0.2.0] — 2026-10-27

**Text side now has a budget and paging.** A 2 h 35 min film produced a 75 KB index; the host folded 44 %
of it into a disk overflow file that the model never read, so 44 minutes of dialogue were effectively lost.

- `cellRange: [first, last]` — render only that slice of the index.
- `textOnly: true` — return the index with **no image and no frame decode**; combined with the scan cache
  it is ~0.8 s per page after the first call.
- Per-cell transcript is capped at 180 chars by default (an overview needs "what is this stretch about";
  ask for the cell range if you need the full text).
- When the index exceeds its budget it now stops **on a cell boundary** and says which `cellRange` to
  request next, instead of being silently folded into a file.
- ASR results are cached by (file, window, endpoint, chunk size) — paging no longer re-runs recognition.

**New: `video_probe`.** Container metadata in milliseconds — duration, resolution, rotation, audio and
subtitle tracks — plus a suggested reading plan. Costs no image tokens, so the model can decide *how* to
read a file before spending its first 384.

**Content-type routing.** `suggest()` now sees speech rate and loudness, not just duration and motion:
`meanLufs > −18 && charsPerSec < 1` marks a music-driven clip, which keeps the cell floor at 9 instead of
letting the "dialogue carries the info" rule shrink it. Measured: concept PV 0.16 chars/s @ −14.2 LUFS
fires; the tutorial at 5.59 chars/s and the narrative film at 2.05 do not.

**Term dictionary.** `~/.dsh/asr.json` accepts `"terms": {"绘插": "彗差"}` — deterministic replacement over
ASR output, single-pass (longest match first, no substring re-entry), with the replacement count reported.

**Baseline.** `docs/BASELINE.md`: four clips measured end to end, plus the finding that loudness and speech
rate move in opposite directions.

## [0.1.0] — 2026-10-27

First working release.

**Tools**
- `video_storyboard` — one addressable grid per clip: burned-in indices, per-cell timestamp ranges,
  per-cell transcript, footer audio strip.
- `video_zoom` — re-read a short window with fewer, larger cells.

**Sampling**
- HSV-weighted shot detection with a rate-based adaptive threshold (`3×p95` produced zero cuts on
  fast-cut anime; targeting ≈1 cut per 1.5 s fixed it).
- Cell placement follows local cut density; the timeline stays fully covered at a fixed token cost.
- `--pick sharp` selects the frame with the highest Laplacian variance.
- Segment merging honours a minimum gap that never exceeds the material's own granularity.

**Audio**
- EBU R128 loudness + silence detection, drawn as a strip on the same time axis as the cells.
- Transcript: embedded subtitle track → OpenAI-compatible ASR → skip. Long windows are chunked
  client-side (cut points snapped to silence) after a 299 s request was found to shift every
  timestamp 13 s early.
- Non-speech segments (ASR inventing words over music) are filtered and reported, never silently dropped.

**Engineering**
- Zero image library, zero font dependency; PNG is produced through ffmpeg's `image2pipe`.
- Scan cache keyed by file + window + threshold (5-min clip: 13.4 s → 3.6 s on the second call).
- Tool schema is verified against the host's real `defineTool` / `validateArgs`.
- 154 tests: unit + ffmpeg end-to-end + host contract.

[0.1.0]: https://github.com/SAOS-3624/dsh-video-storyboard/releases/tag/v0.1.0
