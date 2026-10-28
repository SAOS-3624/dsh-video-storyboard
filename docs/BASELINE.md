# Baseline

Four clips, measured end to end on one machine (Windows, CPU only, ffmpeg 7.x, 1080p sources).
Everything below is **measured**, not estimated. Re-run any row with:

```bash
node bin/storyboard.mjs "<file>" --cells 0 --transcript auto --out /tmp/s.png --manifest /tmp/m.json
```

## Content profile

`chars/sec` is computed over the **whole transcript** (not the text inside cells). It turned out to be the
single most useful number for telling content types apart.

| clip | length | cuts | silences | mean loudness | transcript segs | chars | **chars/sec** | auto grid | classified |
|---|---|---|---|---|---|---|---|---|---|
| talking-head tutorial | 299 s | 141 | 1 (1.9 s) | −23.0 LUFS | 136 | 1673 | **5.59** | 9 × 1 | speech |
| narrative animation | 1090 s | 408 | 11 (25.8 s) | −21.4 LUFS | 221 | 2235 | **2.05** | 16 × 2 | narrative |
| concept PV | 90 s | 42 | 3 | −14.2 LUFS | 1 | 14 | **0.16** | 9 × 1 | **music** |
| official PV | 92 s | 44 | 1 | −18.4 LUFS | 8 | 69 | **0.75** | 9 × 1 | near-music |

**Loudness and speech rate move in opposite directions**: the music-driven PV is the *loudest* and says the
*least*; the tutorial is the quietest and says the most. That is why `suggest()` now uses both:

```
musicDriven = meanLufs > −18 dB  &&  charsPerSec < 1
```

It fires on the concept PV (0.16 / −14.2) and stays quiet on the other three — including the official PV,
which has narration at 0.75 chars/s but sits just below the loudness gate at −18.4.

> This gate is a heuristic with a narrow band, not a classifier. Its only job is to stop the tool from
> spending cells on dialogue that does not exist.

## Grid choice

Auto grid comes from motion p90 first, then two corrections:

| clip | p90 | duration-only | after speech rule | chosen |
|---|---|---|---|---|
| tutorial 299 s | 7.9 | 16 | ×0.6 → 9 (speech carries the info) | 9 × 1 |
| animation 1090 s | 15.0 | 16 | — | 16 × 2 |
| concept PV 90 s | 26.1 | 9 | music floor 9 | 9 × 1 |

## Cost per call

| what | measured |
|---|---|
| one image (9–16 cells) | **384 tokens** |
| 5-min clip, first call | 13.4 s (scan 6–9 s + frames + audio strip) |
| same clip, second call | **3.6 s** (scan cached) |
| 18-min film, 16×4 (64 cells) | 94.8 s |
| `textOnly` page after the first call | **0.8 s** |
| scan throughput | 22–47× realtime (1080p, decode-bound) |

## How the token numbers are counted

Two different currencies get added up above, and they are not measured the same way:

- **Images.** The host charges a flat **384 tokens per image result**, whatever it contains — a 9-cell grid
  and a 16-cell grid cost the same. So `sheets × 384` is the image bill, and putting more cells on one sheet
  is the whole point: 16 cells in one image is 384 tokens, not 16 × 384.
- **The text index.** This one is ordinary text and is paid by length: roughly **1.3–1.8 Chinese characters
  per token**, quoted here as `chars ÷ 1.5`. It only matters at the margins (`detail`, `cellRange`) — the
  index of a 16-cell sheet is ~1–2 k characters, i.e. a few hundred tokens.
- **Nothing else is billed.** `video_probe` reads container headers and costs no image tokens; scanning
  (the expensive part in wall-clock time) is local ffmpeg work and costs no tokens at all.

`docs/BASELINE.md` reports wall-clock and tokens separately for this reason: the scan is what makes the tool
feel slow, and the tokens are what makes it cheap to run repeatedly.

Reproduce on your own footage with `npm run bench -- <file|url>` (it prints both tables and can dump JSON):

    node scripts/bench.mjs lecture.mp4 --json bench-lecture.json

## What 88 frames buys on a 2 h 35 m film

On a feature-length file, 64 cells covers 0.04 % of ~220 000 frames. That is enough to judge structure,
art direction and pacing, and **not** enough to claim every shot was seen. `video_zoom` exists for the
second pass; `--from/--to` exists so a long film is read in windows instead of one scan.

## Reproducing the table

The four clips are commercial/anime material and are **not** in this repo. To reproduce the shape of the
table on your own footage, any 1080p file works — the numbers that matter (`chars/sec`, LUFS, cuts per
minute) are all printed by the CLI.
