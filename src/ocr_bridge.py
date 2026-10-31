"""OCR 桥：给 Node 侧调用，负责"找字幕带 + 只识别"。

为什么要单独一个 Python 脚本：OCR 生态（rapidocr / PaddleOCR）都在 Python 侧，
而插件是 Node。走一次 subprocess 换 JSON，比在 Node 里重造一套中文 OCR 现实得多。

两个模式：
  detect  全图检测 2–3 帧，找出"字幕带"（宽、居中、置信度够的文字行的 y 区间）
  read    已知字幕带，只跑识别（不做检测）—— 实测 3108 ms/帧 → 261 ms/帧

输出一律是 JSON，失败也返回 {"ok": false, "error": ...}，不抛栈给 Node。

## 两个包，两套 API（这是最容易踩的一脚）

  rapidocr              3.x   Python >=3.8    engine(img, use_det=False) → RapidOCROutput / TextRecOutput
  rapidocr_onnxruntime  1.x   Python <3.13    engine(img) → (list, elapse)

1.x 在 Python 3.13 上**根本装不上**（requires_python 写死 <3.13），所以新机器只能用 3.x，
而 3.x 的构造参数只剩 `config_path` / `params`，`RapidOCR(use_det=False)` 会直接 TypeError。
两边的返回形状也不一样，下面 `_rows()` 把它们压成同一种。
"""

import json
import sys

# 同 watch_smtc.py：Windows 默认 cp936，中文会变乱码
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:                       # noqa: BLE001
    pass


def _fail(msg):
    print(json.dumps({"ok": False, "error": str(msg)}, ensure_ascii=False))
    sys.exit(0)


def _load():
    """返回 (RapidOCR, 包名)。新包优先 —— 它是唯一还支持 Python 3.13 的那个。"""
    try:
        from rapidocr import RapidOCR
        return RapidOCR, "rapidocr"
    except Exception:                   # noqa: BLE001
        pass
    try:
        from rapidocr_onnxruntime import RapidOCR
        return RapidOCR, "rapidocr-onnxruntime"
    except Exception as e:              # noqa: BLE001
        _fail(f"no OCR engine installed (need `pip install rapidocr onnxruntime`): {e}")


def _box(b):
    """统一成 [[x,y]*4]；numpy 数组先降到 list。拿不到就 None。"""
    if b is None:
        return None
    if hasattr(b, "tolist"):
        b = b.tolist()
    try:
        return [[float(p[0]), float(p[1])] for p in b]
    except Exception:                   # noqa: BLE001
        return None


def _rows(res):
    """把各版本的返回值压成 [(box|None, text, conf), ...]。

    3.8+：RapidOCROutput / TextRecOutput，字段是 .txts / .scores / .boxes
    1.x ：engine() 返回 (result, elapse)，result 是 [[box, text, conf], ...]
    """
    if isinstance(res, tuple):          # 1.x 的 (result, elapse)
        res = res[0] if len(res) == 2 else res

    txts = getattr(res, "txts", None)
    if txts is None:
        out = []
        for item in res or []:
            if isinstance(item, (list, tuple)) and len(item) >= 3:
                out.append((_box(item[0]), str(item[1]), float(item[2])))
        return out

    scores = getattr(res, "scores", None)
    boxes = getattr(res, "boxes", None)
    out = []
    for i, t in enumerate(txts):
        conf = float(scores[i]) if scores is not None and i < len(scores) else 0.0
        box = _box(boxes[i]) if boxes is not None and i < len(boxes) else None
        out.append((box, str(t), conf))
    return out


def _make(RapidOCR, engine_name, read_only=False):
    """read_only 只是少算一步检测；3.x 用 per-call 参数，1.x 只能走构造参数。"""
    if read_only and engine_name == "rapidocr-onnxruntime":
        try:
            return RapidOCR(use_det=False, use_cls=False, use_rec=True)
        except Exception:               # noqa: BLE001
            return RapidOCR()
    return RapidOCR()


def _run(ocr, engine_name, path, read_only=False):
    if read_only and engine_name == "rapidocr":
        return ocr(path, use_det=False, use_cls=False)
    return ocr(path)


def detect(paths):
    RapidOCR, engine_name = _load()
    ocr = _make(RapidOCR, engine_name)
    from PIL import Image

    # 字幕候选分两档：**画面下半部分**的优先，下半屏一个都没有才退回全帧。
    #
    # 判据的实测依据（1280×720，同一支片的两类帧）：
    #
    #   双语字幕帧   中文 w=26.4% h=7.6% cy=91% conf=1.00
    #                英文 w=30.4% h=6.2% cy=97% conf=0.99
    #   画面大字帧   w=18–28% h=31–83% cy=40–84% conf=0.6–1.0
    #
    # 于是两条结论：
    #   · **宽度门槛不能是 35%**（那是照着"平台推广横幅"定的），真字幕只有 26–30%，
    #     原判据在这一帧上两条全砍，band 直接落回兜底 —— #39 报告人看到的 [0,1] 也是这个来源。
    #   · **真正能分开字幕和画面元素的是高度**：字幕是扁的一条（6–8%），
    #     画面里的大字/海报字是 31–83%。卡 15% 比卡宽度可靠得多。
    lower, every = [], []
    width = height = None
    for p in paths:
        im = Image.open(p)
        width, height = im.size
        for box, txt, conf in _rows(_run(ocr, engine_name, p)):
            if not box:
                continue
            xs = [pt[0] for pt in box]
            ys = [pt[1] for pt in box]
            w = max(xs) - min(xs)
            h = max(ys) - min(ys)
            # 字幕的特征：够宽、扁、置信度不太低
            if w / width < 0.18 or conf < 0.55:
                continue
            if h / height > 0.15:
                continue
            b = {"y0": min(ys), "y1": max(ys), "w": w, "text": txt, "conf": round(conf, 3)}
            every.append(b)
            if (b["y0"] + b["y1"]) / 2 / height >= 0.5:
                lower.append(b)

    boxes = lower or every

    if boxes:
        y0 = min(b["y0"] for b in boxes)
        y1 = max(b["y1"] for b in boxes)
        pad = (y1 - y0) * 0.6 + 8
        band = [max(0.0, (y0 - pad) / height), min(1.0, (y1 + pad) / height)]
    else:
        # 没找到也不失败：给中下区域兜底，让调用方决定要不要信
        band = [0.42, 0.68]

    print(json.dumps({
        "ok": True,
        "engine": engine_name,
        "size": [width, height],
        "band": [round(band[0], 4), round(band[1], 4)],
        "boxes": boxes[:12],
        "dropped": max(0, len(every) - len(lower)) if lower else 0,
        "detected": bool(boxes),
    }, ensure_ascii=False))


def read(paths):
    RapidOCR, engine_name = _load()
    ocr = _make(RapidOCR, engine_name, read_only=True)

    out = []
    for p in paths:
        try:
            rows = _rows(_run(ocr, engine_name, p, read_only=True))
            texts = [t for _, t, _ in rows if t]
            confs = [c for _, t, c in rows if t]
            out.append({
                "text": " ".join(texts).strip(),
                "conf": round(sum(confs) / len(confs), 3) if confs else 0.0,
            })
        except Exception as e:          # noqa: BLE001
            out.append({"text": "", "conf": 0.0, "error": str(e)[:120]})
    print(json.dumps({"ok": True, "engine": engine_name, "items": out}, ensure_ascii=False))


if __name__ == "__main__":
    if len(sys.argv) < 3:
        _fail("usage: ocr_bridge.py detect|read <image> [<image> ...]")
    mode, imgs = sys.argv[1], sys.argv[2:]
    if mode == "detect":
        detect(imgs)
    elif mode == "read":
        read(imgs)
    else:
        _fail(f"unknown mode: {mode}")
