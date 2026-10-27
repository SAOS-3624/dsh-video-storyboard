# DSH video enrichment contract

Optional **sidecar** endpoints for capabilities that need deep models (TransNet-class shot detection, speaker diarization, emotion/events). The Node plugin never ships weights — same philosophy as ASR.

Config resolution: **env → `$DSH_HOME/video.json` → `~/.dsh/video.json`**.

```json
{
  "key": "local-key",
  "shots": { "enable": true, "baseUrl": "http://127.0.0.1:8765/v1", "threshold": 0.5 },
  "diarization": { "enable": true, "baseUrl": "http://127.0.0.1:8765/v1" },
  "audioUnderstand": { "enable": true, "baseUrl": "http://127.0.0.1:8765/v1" }
}
```

Env overrides: `DSH_VIDEO_SHOTS_URL`, `DSH_VIDEO_DIARIZE_URL`, `DSH_VIDEO_AUDIO_URL`, `DSH_VIDEO_ENRICH_KEY`.

Tool arg: `enrichment: "auto"|"off"` (default `auto`).

Failures are **fail-open**: HSV / loudness / ASR still work; the manifest reports what was skipped.

---

## 1. Shot detection — `POST /v1/shots/detect`

```json
{
  "path": "C:/Videos/film.mp4",
  "from": 0,
  "to": 600,
  "fps_hint": 24,
  "threshold": 0.5
}
```

Response:

```json
{
  "model": "transnetv2",
  "degraded": false,
  "cuts": [
    { "t": 12.40, "score": 0.97, "kind": "cut" },
    { "t": 48.10, "score": 0.81, "kind": "dissolve" }
  ]
}
```

- `t` is **absolute seconds in the source file**
- `kind` optional: `cut` | `dissolve` | `wipe` | …
- Plugin merges remote cuts with HSV cuts (remote wins on near-duplicates)

---

## 2. Diarization — `POST /v1/audio/diarize`

Multipart: `file` = 16 kHz mono WAV (plugin extracts the window), optional form fields `from` / `to`.

Response times are **relative to the uploaded WAV** (plugin adds window offset):

```json
{
  "model": "pyannote",
  "segments": [
    { "from": 0.0, "to": 3.2, "speaker": "SPEAKER_00" },
    { "from": 3.2, "to": 7.8, "speaker": "SPEAKER_01" }
  ]
}
```

---

## 3. Audio understand — `POST /v1/audio/understand`

Same multipart WAV as diarize.

```json
{
  "model": "sensevoice-events",
  "spans": [
    { "from": 0.0, "to": 4.0, "emotion": "HAPPY", "event": "Speech", "confidence": 0.82 },
    { "from": 4.0, "to": 12.0, "event": "Music" }
  ]
}
```

Additionally, if ASR text already contains SenseVoice tags (`<|HAPPY|>`), the plugin strips them into `emotion` / `event` **without** calling this endpoint.

---

## Reference sidecar

See [`extras/dsh-video-enrichment/`](../extras/dsh-video-enrichment/README.md) — a FastAPI server that implements these three routes. Optional extras:

| Feature | Extra install |
|---|---|
| TransNet V2 cuts | `pip install -r requirements-transnet.txt` (+ weights) |
| Pyannote speakers | `pip install -r requirements-diarize.txt` + `HF_TOKEN` |
| Emotion/events | SenseVoice ASR tags (free) or sidecar heuristic |

Default install runs **stub/heuristic** backends so DSH wiring can be tested without GPUs.
