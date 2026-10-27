# dsh-video-enrichment

DeepSeek Harness **sidecar** for `dsh-video-storyboard` optional enrichment:

| Route | Purpose |
|---|---|
| `POST /v1/shots/detect` | TransNet-class shot / gradual transitions |
| `POST /v1/audio/diarize` | Speaker labels |
| `POST /v1/audio/understand` | Emotion / audio-event spans |

Contract: [`docs/enrichment-contract.md`](../../docs/enrichment-contract.md).

## Quick start (stub backends — no GPU)

```bash
cd extras/dsh-video-enrichment
python -m venv .venv
# Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn server:app --host 127.0.0.1 --port 8765
```

Write `~/.dsh/video.json`:

```json
{
  "key": "local",
  "shots": { "enable": true, "baseUrl": "http://127.0.0.1:8765/v1", "threshold": 0.4 },
  "diarization": { "enable": true, "baseUrl": "http://127.0.0.1:8765/v1" },
  "audioUnderstand": { "enable": true, "baseUrl": "http://127.0.0.1:8765/v1" }
}
```

Then in DSH:

```text
video_storyboard({ input: "D:/clip.mp4", enrichment: "auto" })
```

Stub mode still returns valid JSON so wiring can be verified; cut quality improves only after optional deps below.

## Optional: TransNet V2

```bash
pip install -r requirements-transnet.txt
# place weights or set TRANSNET_WEIGHTS=/path/to/transnetv2-weights
set DSH_ENRICH_SHOTS_BACKEND=transnet   # Windows
```

## Optional: pyannote diarization

```bash
pip install -r requirements-diarize.txt
set HF_TOKEN=hf_xxx
set DSH_ENRICH_DIARIZE_BACKEND=pyannote
```

## Health

`GET http://127.0.0.1:8765/health` → `{ "ok": true, "backends": { ... } }`
