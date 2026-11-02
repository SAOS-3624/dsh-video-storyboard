# ASR endpoint contract

The transcript layer is provider-agnostic: it speaks the OpenAI `/audio/transcriptions` dialect, so a
local FunASR/SenseVoice server, SiliconFlow, whisper-server or speaches all work without code changes.

## Request

```
POST {DSH_ASR_BASE_URL}/audio/transcriptions
Authorization: Bearer {DSH_ASR_KEY}
Content-Type: multipart/form-data

file            = 16 kHz mono WAV (extracted by this plugin via ffmpeg)
model           = whatever you configured (e.g. FunAudioLLM/SenseVoiceSmall)
response_format = verbose_json
language        = zh (override with DSH_ASR_LANG)
```

Requests are **chunked to ≤45 s** by the client (`transcribeLong`), with cut points snapped to the
midpoint of a silence gap when one is available.

## Response

```json
{
  "text": "optional whole-text field",
  "model": "paraformer-zh",
  "language": "zh",
  "segments": [
    { "start": 0.0, "end": 1.24, "text": "第一句" },
    { "start": 1.24, "end": 2.90, "text": "第二句" }
  ]
}
```

Three rules that matter:

1. **`start`/`end` are relative to the audio you uploaded**, not to the whole video. The client adds the
   window offset. Returning absolute times is the most common mistake and it silently shifts every cell.
2. **Missing `segments` degrades to one segment** covering the request. It runs, but every line lands on
   one cell.
3. **Non-2xx must actually be non-2xx.** The client distinguishes `asr-failed` from `no-audio` by status.

`model` is echoed back if present (so the manifest shows the real model rather than the one requested).

## Two failure modes you will hit

### 1. Timestamp drift on long requests

Measured on SEACO-Paraformer: one 299 s request shifted every timestamp **13 s early** (≈4.5 %
compression — pauses get eaten). 135 segments became 137 after chunking, and the mean |Δstart| went
from seconds to **0.02 s**.

The client already chunks, so a server that also chunks is harmless (the server threshold is never
reached). If you implement your own chunking, cut at **silence**, not at a fixed second count — fixed
cuts split words (the 2 extra segments above).

### 2. ASR invents words over music

On a music-driven PV with exactly one spoken line, one request produced a fake 29 s segment. Because
cells are filled by time overlap, that one fake line landed in **five cells** — the same garbage quoted
five times.

`filterSuspectSegments` drops:

| rule | condition | example |
|---|---|---|
| `punctuation-only` | no meaningful characters after stripping punctuation | `。` |
| `music-like` | duration > 8 s **and** < 0.8 chars/s | 29 s / 9 chars |

Normal speech is 2–6 chars/s, so a real long sentence is never dropped. Dropped segments are **reported
in the tool output**, never silently discarded.

## Checking your setup

```bash
# 1) is the server alive? (use a direct fetch — curl may go through a proxy and lie with 502)
node -e "fetch('http://127.0.0.1:8000/health').then(r=>console.log(r.status))"

# 2) does the plugin's client work? (no server needed — spins a fake one)
node --test test/asr-local.test.mjs

# 3) end to end on 12 seconds of audio
node bin/asr-check.mjs video.mp4 --from 100 --seconds 12
```

Config resolution order: **env vars → `$DSH_HOME/asr.json` → built-in defaults**.

```json
// C:\Users\<you>\.dsh\asr.json
{ "baseUrl": "http://127.0.0.1:8000/v1", "key": "dummy-key", "language": "zh" }
```

The file path exists because a Windows DSH host process often cannot see user environment variables
its launcher never inherited.

## The host `speechToText` path (desktop build)

When the DSH desktop build exposes a `speechToText` service, this plugin prefers it over any HTTP
endpoint — no key, no network, no model download of our own. It is a **different contract**, and it is
stricter than HTTP:

The host's `validateWave()` (`dsh-experimental-speech-to-text/lib/types/wave.js`, called by the
SenseVoice worker) accepts **canonical** 16 kHz mono PCM16 only:

- `RIFF` size **must equal** `len - 8`
- the `data` chunk **must sit at byte offset 36**
- `data` size **must equal** `len - 44`

`ffmpeg … -f wav -` (writing to a pipe) violates two of those three by construction:

1. a pipe cannot seek, so `RIFF size` / `data size` stay `0xFFFFFFFF`;
2. ffmpeg also emits a `LIST/INFO` (`ISFT=Lavf…`) chunk by default, pushing `data` from 36 to 70.

The host then throws `Audio must be a canonical 16 kHz mono PCM16 WAV recording`, which surfaces as
`transcript="asr-failed"` — with no hint about the header. This is **not** a macOS quirk: the same code
ships in the Windows build, it simply never fires there if you use an HTTP endpoint instead.

`host-asr.js` therefore re-writes the header in memory (`canonicalizeWav()`): walk the RIFF chunks,
keep only `fmt ` + `data`, re-emit a 44-byte header with the lengths we can now compute. No temp file,
no extra I/O, identical on every platform. If the output ever stops being parseable it **throws**
rather than silently transcribing nothing.

If you touch that file, run `node --test test/host-asr.test.mjs` — the test re-implements the host's
`validateWave()` byte for byte, so a regression fails locally instead of on a user's machine.
