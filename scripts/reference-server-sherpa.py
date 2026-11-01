#!/usr/bin/env python3
"""reference-server-sherpa.py — 一个最小可用的本机 ASR 服务（sherpa-onnx 2.x）。

这是 `docs/CONFIG.zh.md` §7.1「自己写」那条路的**参考实现**，不是运行时依赖：
`package.json` 的 `files` 不含 `scripts/`，所以它不会被装进 node_modules，只是给人复制出去用的。

它满足 `docs/asr-contract.md` 的客户端契约：

    GET  /health                     → 200
    GET  /v1/models                  → {"object":"list","data":[{"id":...}]}
    POST /v1/audio/transcriptions    → OpenAI 兼容，返回 verbose_json
    POST /shutdown                   → 200 之后退出（插件按 idleMs 调它）

设计上只依赖两样东西：**Python 标准库 + numpy + sherpa-onnx**（不引 web 框架）。
换模型（paraformer / sense-voice / whisper …）只需要改 `Engine` 里的一行工厂调用。

---------------------------------------------------------------------------
装（干净环境，Linux / macOS / Windows 都一样）：

    python3 -m venv .venv
    .venv/bin/pip install sherpa-onnx numpy        # Windows: .venv\\Scripts\\pip

拿模型（HuggingFace，约 500 MB）：

    base=https://huggingface.co/csukuangfj
    curl -LO $base/sherpa-onnx-paraformer-zh-2024-03-09/resolve/main/model.int8.onnx
    curl -LO $base/sherpa-onnx-paraformer-zh-2024-03-09/resolve/main/tokens.txt
    curl -LO https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx
    mkdir -p punct
    curl -L  $base/sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12/resolve/main/model.onnx -o punct/model.onnx

跑（模型路径可配置 —— 目录里按已知文件名自动发现，也可逐个显式指定）：

    .venv/bin/python reference-server-sherpa.py --models ~/asr/models-sherpa
    .venv/bin/python reference-server-sherpa.py --models . --port 8000 --check   # 只验模型能加载

验：

    curl -s localhost:8000/health
    curl -s -X POST localhost:8000/shutdown

配 `~/.dsh/asr.json`（本机地址不需要 key）：

    { "baseUrl": "http://127.0.0.1:8000/v1", "model": "paraformer-zh-2024-03-09", "language": "zh",
      "manage": { "start": ["/path/to/.venv/bin/python", "/path/to/reference-server-sherpa.py"],
                  "idleMs": 5000, "waitMs": 60000 } }

---------------------------------------------------------------------------
两条「降级但不断链」的边界（review 口径）：

1. **标点失败 → 照常 200 + 不带标点的文本。** ct-transformer 是可选的装饰环节，
   它挂了不该让整条台词链变成 `asr-failed`，更不该返回 500。
2. **VAD 失败 → 退回整段一次识别。** 没有 VAD 只是时间码变粗（一段覆盖整个请求），
   不是没有台词。

另：`/shutdown` 不实现也不会让客户端卡住（插件等不到就退回杀进程），但这里实现了，
并且在 SIGINT / SIGTERM 下也会干净退出。
"""

from __future__ import annotations

import argparse
import email
import email.policy
import io
import json
import os
import signal
import sys
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np

SAMPLE_RATE = 16000          # 插件永远发 16 kHz 单声道 16-bit
MAX_UPLOAD_MB = 200          # 45 秒 @16k mono ≈ 1.4 MB；留足余量，防误传大文件占内存

log_lock = threading.Lock()

# 日志一律走 stderr，并且显式设成 UTF-8：Windows 控制台默认 cp936，
# 非中文环境下打印带 accent 的路径会直接 UnicodeEncodeError 把服务带崩。
try:
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, ValueError):
    pass


def log(msg: str) -> None:
    with log_lock:
        print(f"[asr] {msg}", file=sys.stderr, flush=True)


# --------------------------------------------------------------------- 模型发现
def discover(models_dir: Path) -> dict[str, Path | None]:
    """在一个模型目录里按已知文件名找四件套。

    兼容两种摆法（都是文档里实际出现过的）：
      models/  model.int8.onnx | model.onnx, tokens.txt, silero_vad.onnx, punct/model.onnx
      models/  paraformer-zh/model.int8.onnx, paraformer-zh/tokens.txt, punct/model.onnx …
    也就是：先看根目录，再看一层子目录，谁的目录里同时有 onnx + tokens.txt 就认谁。
    """
    def first(*cands: Path) -> Path | None:
        for c in cands:
            if c.is_file():
                return c
        return None

    dirs = [models_dir]
    try:
        dirs += [p for p in sorted(models_dir.iterdir()) if p.is_dir()]
    except OSError:
        pass

    para = tokens = None
    for d in dirs:
        p = first(d / "model.int8.onnx", d / "model.onnx")
        t = first(d / "tokens.txt")
        if p and t:
            para, tokens = p, t
            break

    vad = first(models_dir / "silero_vad.onnx", models_dir / "vad" / "silero_vad.onnx")
    punct = first(models_dir / "punct" / "model.onnx", models_dir / "punct.onnx",
                  models_dir / "ct-transformer" / "model.onnx")
    return {"paraformer": para, "tokens": tokens, "vad": vad, "punct": punct}


# --------------------------------------------------------------------- 引擎
class Engine:
    """三件模型 + 一把锁。

    sherpa-onnx 的 pybind 对象不是线程安全的，而 HTTP 服务是多线程的 ——
    用一把锁把「解码」整段串起来，比给每个请求建一个 recognizer 省内存得多。
    """

    def __init__(self, paths: dict[str, Path | None], model_name: str, threads: int | None = None):
        try:
            import sherpa_onnx
        except ImportError as exc:  # 最可能的原因：忘了在 venv 里装
            raise SystemExit(
                f"import sherpa_onnx failed: {exc}\n"
                "  fix: pip install sherpa-onnx numpy   (装进你给 asr.json 的那个解释器)"
            ) from exc

        self.so = sherpa_onnx
        self.model_name = model_name
        self.lock = threading.Lock()
        self._punct_broken = False
        self._vad_broken = False

        para, tokens = paths.get("paraformer"), paths.get("tokens")
        if not para or not tokens:
            raise SystemExit(
                "paraformer model / tokens.txt not found.\n"
                f"  looked in: {para.parent if para else '(no dir)'}\n"
                "  pass --models <dir> or --paraformer/--tokens explicitly"
            )

        num_threads = threads or max(1, (os.cpu_count() or 4) // 2)
        log(f"paraformer: {para}  (threads={num_threads})")
        self.recognizer = sherpa_onnx.OfflineRecognizer.from_paraformer(
            paraformer=str(para),
            tokens=str(tokens),
            num_threads=num_threads,
            sample_rate=SAMPLE_RATE,
            feature_dim=80,
            decoding_method="greedy_search",
            debug=False,
            provider="cpu",
        )

        # 标点：可选。装不上就记一笔，后面逐句跳过后处理（不 raise）。
        self.punct = None
        punct = paths.get("punct")
        if punct:
            try:
                log(f"punctuation: {punct}")
                self.punct = sherpa_onnx.OfflinePunctuation(
                    sherpa_onnx.OfflinePunctuationConfig(
                        model=sherpa_onnx.OfflinePunctuationModelConfig(
                            ct_transformer=str(punct), num_threads=1, provider="cpu"
                        )
                    )
                )
            except Exception as exc:                       # noqa: BLE001 —— 装饰环节，绝不致命
                log(f"punctuation model failed to load, continuing without it: {exc}")
                self._punct_broken = True
        else:
            log("no punctuation model -- transcripts come back unpunctuated (still HTTP 200)")

        # VAD：可选。坏了就整段识别（时间码变粗，但不是没有台词）。
        self.vad = None
        self.vad_window = 512
        vad = paths.get("vad")
        if vad:
            try:
                log(f"vad: {vad}")
                cfg = sherpa_onnx.VadModelConfig(
                    silero_vad=sherpa_onnx.SileroVadModelConfig(
                        model=str(vad),
                        threshold=0.5,
                        min_silence_duration=0.35,
                        min_speech_duration=0.15,
                        max_speech_duration=20,
                    ),
                    sample_rate=SAMPLE_RATE,
                    num_threads=1,
                    provider="cpu",
                    debug=False,
                )
                self.vad_window = cfg.silero_vad.window_size
                self.vad = sherpa_onnx.VoiceActivityDetector(cfg, buffer_size_in_seconds=120)
            except Exception as exc:                       # noqa: BLE001
                log(f"vad model failed to load, falling back to whole-file: {exc}")
                self._vad_broken = True
                self.vad = None

        log("engine ready")

    # -- 切句 --------------------------------------------------------------
    def speech_spans(self, samples: np.ndarray) -> list[tuple[int, int]]:
        if self.vad is None:
            return [(0, len(samples))]
        try:
            spans: list[tuple[int, int]] = []
            window = self.vad_window
            for i in range(0, len(samples), window):
                chunk = samples[i:i + window]
                if len(chunk) < window:
                    chunk = np.pad(chunk, (0, window - len(chunk)))
                self.vad.accept_waveform(chunk)
            self.vad.flush()
            while not self.vad.empty():
                seg = self.vad.front
                spans.append((int(seg.start), int(seg.start) + len(seg.samples)))
                self.vad.pop()
            return spans
        except Exception as exc:                            # noqa: BLE001
            # 只降级一次：之后这个进程都不再用 VAD，免得每个请求都炸一遍
            log(f"vad failed at runtime, disabling it for this process: {exc}")
            self._vad_broken = True
            self.vad = None
            return [(0, len(samples))]

    # -- 识别 --------------------------------------------------------------
    def _add_punct(self, text: str) -> str:
        if self.punct is None or self._punct_broken:
            return text
        try:
            # sherpa-onnx 2.x 叫 add_punctuation；1.x 叫 add_punct。
            # 网上能搜到的示例几乎全是 1.x 的，照抄会 AttributeError —— 两个都认。
            fn = getattr(self.punct, "add_punctuation", None) or getattr(self.punct, "add_punct", None)
            if fn is None:
                raise AttributeError("OfflinePunctuation has neither add_punctuation nor add_punct")
            return (fn(text) or "").strip() or text
        except Exception as exc:                            # noqa: BLE001
            log(f"punctuation failed (continuing without it): {exc}")
            self._punct_broken = True                       # 只报一次，别刷屏
            return text

    def _decode(self, samples: np.ndarray, start: int, end: int) -> dict | None:
        part = samples[start:end]
        if len(part) < SAMPLE_RATE * 0.12:                  # <120ms 基本是噪声
            return None
        stream = self.recognizer.create_stream()
        stream.accept_waveform(SAMPLE_RATE, part)
        self.recognizer.decode_stream(stream)
        text = (stream.result.text or "").strip()
        if not text:
            return None
        return {
            # 时间相对**本次上传的音频**，不是整片 —— 客户端自己加窗口偏移。
            "start": round(start / SAMPLE_RATE, 2),
            "end": round(end / SAMPLE_RATE, 2),
            "text": self._add_punct(text),
        }

    def transcribe(self, samples: np.ndarray) -> list[dict]:
        with self.lock:
            spans = self.speech_spans(samples)
            segments = []
            for start, end in spans:
                seg = self._decode(samples, start, min(end, len(samples)))
                if seg:
                    segments.append(seg)
            # 兜底：VAD 判定全静音，但这段确实有声音（纯音乐里的轻语、气声）
            if not segments and len(samples) > SAMPLE_RATE * 0.3:
                seg = self._decode(samples, 0, len(samples))
                if seg:
                    segments.append(seg)
            return segments


# --------------------------------------------------------------------- 上传解析
def parse_multipart(content_type: str, body: bytes) -> tuple[dict[str, str], dict[str, tuple[str, bytes]]]:
    """用标准库解 multipart/form-data —— 只为一个 endpoint 引 Flask/FastAPI 不划算。"""
    header = f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode()
    msg = email.message_from_bytes(header + body, policy=email.policy.default)
    fields: dict[str, str] = {}
    files: dict[str, tuple[str, bytes]] = {}
    for part in msg.iter_parts():
        name = part.get_param("name", header="content-disposition")
        if not name:
            continue
        data = part.get_payload(decode=True) or b""
        filename = part.get_filename()
        if filename is not None:
            files[name] = (filename, data)
        else:
            fields[name] = data.decode("utf-8", "replace")
    return fields, files


def wav_to_float(raw: bytes) -> np.ndarray:
    """16-bit PCM WAV → float32 mono 16 kHz。插件永远发这个格式，其余情况尽量容忍。"""
    with wave.open(io.BytesIO(raw), "rb") as wf:
        channels, width, rate = wf.getnchannels(), wf.getsampwidth(), wf.getframerate()
        frames = wf.readframes(wf.getnframes())
    if width != 2:
        raise ValueError(f"expected 16-bit PCM, got {width * 8}-bit")
    data = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
    if channels > 1:
        data = data.reshape(-1, channels).mean(axis=1)
    if rate != SAMPLE_RATE:
        # 客户端本来就会先转成 16 kHz；真走到这里就线性重采样，宁可略糊也别报错
        n = max(1, int(round(len(data) * SAMPLE_RATE / rate)))
        idx = np.linspace(0, len(data) - 1, n)
        data = np.interp(idx, np.arange(len(data)), data).astype(np.float32)
    return data


# --------------------------------------------------------------------- HTTP
class Handler(BaseHTTPRequestHandler):
    engine: Engine | None = None
    httpd: ThreadingHTTPServer | None = None
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):                      # 默认会往 stdout 打，改走 stderr
        log(fmt % args)

    def _json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):                                       # noqa: N802 —— BaseHTTPRequestHandler 的约定
        if self.path.startswith("/health"):
            self._json(200, {"status": "ok", "model": self.engine.model_name})
        elif self.path.startswith("/v1/models"):
            self._json(200, {"object": "list", "data": [
                {"id": self.engine.model_name, "object": "model", "owned_by": "local"},
            ]})
        else:
            self._json(404, {"error": {"message": "not found", "type": "invalid_request_error"}})

    def do_POST(self):                                      # noqa: N802
        if self.path.startswith("/shutdown"):
            self._json(200, {"status": "shutting down"})
            # 在另一个线程里收摊：这里直接 shutdown() 会和当前请求线程互相等
            threading.Thread(target=self.httpd.shutdown, daemon=True).start()
            return

        if not self.path.startswith("/v1/audio/transcriptions"):
            self._json(404, {"error": {"message": "not found", "type": "invalid_request_error"}})
            return

        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length > MAX_UPLOAD_MB * 1024 * 1024:
                self._json(413, {"error": {"message": f"upload over {MAX_UPLOAD_MB} MB", "type": "invalid_request_error"}})
                return
            body = self.rfile.read(length)
            fields, files = parse_multipart(self.headers.get("Content-Type", ""), body)
            if "file" not in files:
                self._json(400, {"error": {"message": "missing 'file' field", "type": "invalid_request_error"}})
                return
            samples = wav_to_float(files["file"][1])
            segments = self.engine.transcribe(samples)
        except (ValueError, wave.Error, EOFError) as exc:   # 客户端给的不是 16-bit WAV
            self._json(400, {"error": {"message": str(exc), "type": "invalid_request_error"}})
            return
        except Exception as exc:                            # noqa: BLE001 —— 失败必须是真失败
            log(f"transcription failed: {exc!r}")
            self._json(500, {"error": {"message": str(exc), "type": "server_error"}})
            return

        if fields.get("response_format") == "text":
            text = "".join(s["text"] for s in segments).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(text)))
            self.end_headers()
            self.wfile.write(text)
            return

        self._json(200, {
            "text": "".join(s["text"] for s in segments),
            "model": self.engine.model_name,
            "language": fields.get("language") or "zh",
            "duration": round(sum(s["end"] - s["start"] for s in segments), 2),
            "segments": segments,
        })


# --------------------------------------------------------------------- main
def main() -> int:
    ap = argparse.ArgumentParser(description="Reference local ASR server for dsh-video-storyboard")
    ap.add_argument("--models", default=os.environ.get("SHERPA_MODELS"),
                    help="directory holding the models (auto-discovers known filenames)")
    ap.add_argument("--paraformer", help="override: paraformer onnx path")
    ap.add_argument("--tokens", help="override: tokens.txt path")
    ap.add_argument("--punct", help="override: punctuation onnx path ('' to disable)")
    ap.add_argument("--vad", help="override: silero_vad.onnx path ('' to disable)")
    ap.add_argument("--host", default=os.environ.get("ASR_HOST", "127.0.0.1"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("ASR_PORT", "8000")))
    ap.add_argument("--threads", type=int, default=None, help="onnxruntime threads (default: cpu/2)")
    ap.add_argument("--model-name", default="paraformer-zh-2024-03-09",
                    help="name echoed back in the response / shown by /v1/models")
    ap.add_argument("--check", action="store_true", help="load the models, print a summary, exit")
    args = ap.parse_args()

    if not args.models and not args.paraformer:
        ap.error("need --models <dir>, or explicit --paraformer/--tokens")

    found: dict[str, Path | None] = {"paraformer": None, "tokens": None, "vad": None, "punct": None}
    if args.models:
        found = discover(Path(args.models).expanduser())
    for key, override in (("paraformer", args.paraformer), ("tokens", args.tokens),
                          ("punct", args.punct), ("vad", args.vad)):
        if override is None:
            continue
        found[key] = Path(override).expanduser() if override else None

    engine = Engine(found, args.model_name, args.threads)

    if args.check:
        log("--check: models loaded successfully")
        for key, val in found.items():
            log(f"  {key:10s} {val if val else '(disabled / not found)'}")
        return 0

    handler = type("BoundHandler", (Handler,), {"engine": engine})
    httpd = ThreadingHTTPServer((args.host, args.port), handler)
    handler.httpd = httpd

    def _stop(signum, _frame):                              # Ctrl+C / docker stop / taskkill
        log(f"signal {signum}, shutting down")
        threading.Thread(target=httpd.shutdown, daemon=True).start()

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            signal.signal(sig, _stop)
        except (ValueError, AttributeError):                # 某些平台/线程场景下装不上，不影响服务
            pass

    log(f"listening on http://{args.host}:{args.port}  (POST /shutdown to exit)")
    try:
        httpd.serve_forever()
    finally:
        httpd.server_close()
        log("bye")
    return 0


if __name__ == "__main__":
    sys.exit(main())
