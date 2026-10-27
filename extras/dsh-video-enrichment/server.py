#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""DSH video enrichment sidecar — implements docs/enrichment-contract.md."""

from __future__ import annotations

import os
import subprocess
import tempfile
from pathlib import Path
from typing import Any

import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

app = FastAPI(title="dsh-video-enrichment", version="0.1.0")

SHOTS_BACKEND = os.environ.get("DSH_ENRICH_SHOTS_BACKEND", "stub").strip().lower()
DIARIZE_BACKEND = os.environ.get("DSH_ENRICH_DIARIZE_BACKEND", "stub").strip().lower()
AUDIO_BACKEND = os.environ.get("DSH_ENRICH_AUDIO_BACKEND", "stub").strip().lower()


class ShotsRequest(BaseModel):
    path: str
    from_: float = Field(0, alias="from")
    to: float | None = None
    fps_hint: float | None = None
    threshold: float = 0.5

    model_config = {"populate_by_name": True}


def _ffprobe_duration(path: str) -> float:
    try:
        out = subprocess.check_output(
            [
                "ffprobe", "-v", "error", "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1", path,
            ],
            text=True,
            timeout=30,
        ).strip()
        return max(0.1, float(out))
    except Exception:
        return 60.0


def _stub_cuts(start: float, end: float, threshold: float) -> list[dict[str, Any]]:
    """Deterministic placeholder cuts so DSH wiring can be tested without TransNet."""
    span = max(1.0, end - start)
    step = max(2.0, min(12.0, span / 8))
    cuts = []
    t = start + step
    while t < end - 0.5:
        kind = "dissolve" if (int(t * 10) % 7 == 0) else "cut"
        score = 0.55 + (0.4 * (0.5 + 0.5 * np.sin(t)))
        if score >= threshold * 0.5:
            cuts.append({"t": round(float(t), 3), "score": round(float(score), 3), "kind": kind})
        t += step
    return cuts


def _transnet_cuts(path: str, start: float, end: float, threshold: float) -> list[dict[str, Any]] | None:
    try:
        from transnetv2 import TransNetV2  # type: ignore
    except Exception:
        return None
    weights = os.environ.get("TRANSNET_WEIGHTS")
    model = TransNetV2(model_dir=weights) if weights else TransNetV2()
    # Official API predicts whole file; we filter the window afterwards.
    _frames, single, _all_pred = model.predict_video(path)
    scenes = model.predictions_to_scenes(single)
    fps = float(os.environ.get("TRANSNET_FPS_FALLBACK", "25"))
    cuts: list[dict[str, Any]] = []
    for a, b in scenes:
        t = float(a) / fps
        if t < start or t >= end:
            continue
        # scene boundary ≈ cut; gradual not distinguished by scenes list
        cuts.append({"t": round(t, 3), "score": 0.9, "kind": "cut"})
    # Also mark high single-frame predictions inside window as soft transitions
    for i, p in enumerate(single):
        t = float(i) / fps
        if t < start or t >= end:
            continue
        if float(p) >= threshold and (not cuts or abs(cuts[-1]["t"] - t) > 0.35):
            cuts.append({"t": round(t, 3), "score": round(float(p), 3), "kind": "dissolve"})
    cuts.sort(key=lambda c: c["t"])
    return cuts


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "backends": {
            "shots": SHOTS_BACKEND,
            "diarize": DIARIZE_BACKEND,
            "audio": AUDIO_BACKEND,
        },
    }


@app.post("/v1/shots/detect")
def shots_detect(body: ShotsRequest) -> JSONResponse:
    path = body.path
    if not path or not Path(path).is_file():
        raise HTTPException(400, f"path not found: {path}")
    start = max(0.0, float(body.from_ or 0))
    end = float(body.to) if body.to is not None else _ffprobe_duration(path)
    if end <= start:
        raise HTTPException(400, "to must be > from")

    model = "stub-shots"
    degraded = True
    cuts: list[dict[str, Any]]
    if SHOTS_BACKEND == "transnet":
        got = _transnet_cuts(path, start, end, float(body.threshold))
        if got is not None:
            cuts = got
            model = "transnetv2"
            degraded = False
        else:
            cuts = _stub_cuts(start, end, float(body.threshold))
            model = "stub-shots (transnet import failed)"
    else:
        cuts = _stub_cuts(start, end, float(body.threshold))

    return JSONResponse({
        "model": model,
        "degraded": degraded,
        "cuts": cuts,
    })


@app.post("/v1/audio/diarize")
async def audio_diarize(
    file: UploadFile = File(...),
    from_: float = Form(0, alias="from"),
    to: float | None = Form(None),
) -> JSONResponse:
    raw = await file.read()
    if len(raw) < 1024:
        raise HTTPException(400, "empty audio")

    if DIARIZE_BACKEND == "pyannote":
        try:
            segments = _pyannote_diarize(raw)
            return JSONResponse({"model": "pyannote", "segments": segments})
        except Exception as exc:
            return JSONResponse(
                {"model": "stub-diarize", "segments": _stub_diarize(raw), "warning": str(exc)[:200]},
            )

    return JSONResponse({"model": "stub-diarize", "segments": _stub_diarize(raw)})


def _stub_diarize(wav_bytes: bytes) -> list[dict[str, Any]]:
    # Rough duration from WAV size (16k mono s16le ≈ 32000 bytes/s + 44 header)
    dur = max(1.0, (len(wav_bytes) - 44) / 32000.0)
    mid = dur / 2
    return [
        {"from": 0.0, "to": round(mid, 3), "speaker": "SPEAKER_00"},
        {"from": round(mid, 3), "to": round(dur, 3), "speaker": "SPEAKER_01"},
    ]


def _pyannote_diarize(wav_bytes: bytes) -> list[dict[str, Any]]:
    token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_TOKEN")
    if not token:
        raise RuntimeError("HF_TOKEN required for pyannote")
    from pyannote.audio import Pipeline  # type: ignore

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        tmp.write(wav_bytes)
        tmp_path = tmp.name
    try:
        pipeline = Pipeline.from_pretrained(
            "pyannote/speaker-diarization-3.1",
            use_auth_token=token,
        )
        diar = pipeline(tmp_path)
        out: list[dict[str, Any]] = []
        for turn, _, speaker in diar.itertracks(yield_label=True):
            out.append({
                "from": round(float(turn.start), 3),
                "to": round(float(turn.end), 3),
                "speaker": str(speaker),
            })
        return out
    finally:
        Path(tmp_path).unlink(missing_ok=True)


@app.post("/v1/audio/understand")
async def audio_understand(
    file: UploadFile = File(...),
    from_: float = Form(0, alias="from"),
    to: float | None = Form(None),
) -> JSONResponse:
    raw = await file.read()
    if len(raw) < 1024:
        raise HTTPException(400, "empty audio")
    dur = max(1.0, (len(raw) - 44) / 32000.0)
    # Heuristic stub: first third speech/neutral, rest music — replace with real model later
    spans = [
        {"from": 0.0, "to": round(dur * 0.35, 3), "emotion": "NEUTRAL", "event": "Speech", "confidence": 0.4},
        {"from": round(dur * 0.35, 3), "to": round(dur, 3), "event": "Music", "confidence": 0.35},
    ]
    return JSONResponse({"model": f"{AUDIO_BACKEND}-audio", "spans": spans})


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("PORT", "8765")))
