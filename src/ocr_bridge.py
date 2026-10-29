"""OCR 桥：给 Node 侧调用，负责"找字幕带 + 只识别"。

为什么要单独一个 Python 脚本：OCR 生态（rapidocr / PaddleOCR）都在 Python 侧，
而插件是 Node。走一次 subprocess 换 JSON，比在 Node 里重造一套中文 OCR 现实得多。

两个模式：
  detect  全图检测 2–3 帧，找出"字幕带"（宽、居中、置信度够的文字行的 y 区间）
  read    已知字幕带，只跑识别（不做检测）—— 实测 3108 ms/帧 → 261 ms/帧

输出一律是 JSON，失败也返回 {"ok": false, "error": ...}，不抛栈给 Node。
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


def _engine():
    try:
        from rapidocr_onnxruntime import RapidOCR
    except Exception as e:            # noqa: BLE001
        _fail(f"rapidocr_onnxruntime not installed: {e}")
    return RapidOCR


def detect(paths):
    RapidOCR = _engine()
    ocr = RapidOCR()
    from PIL import Image

    boxes = []
    width = height = None
    for p in paths:
        im = Image.open(p)
        width, height = im.size
        res, _ = ocr(p)
        for item in res or []:
            box, txt, conf = item[0], str(item[1]), float(item[2])
            xs = [float(pt[0]) for pt in box]
            ys = [float(pt[1]) for pt in box]
            w = max(xs) - min(xs)
            # 字幕的特征：宽（占画面 35% 以上）、居中、置信度不太低
            if w / width < 0.35 or conf < 0.55:
                continue
            boxes.append({"y0": min(ys), "y1": max(ys), "w": w, "text": txt, "conf": round(conf, 3)})

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
        "size": [width, height],
        "band": [round(band[0], 4), round(band[1], 4)],
        "boxes": boxes[:12],
        "detected": bool(boxes),
    }, ensure_ascii=False))


def read(paths):
    RapidOCR = _engine()
    ocr = RapidOCR(use_det=False, use_cls=False, use_rec=True)

    out = []
    for p in paths:
        try:
            res, _ = ocr(p)
            texts = [str(x[1]) for x in (res or [])]
            confs = [float(x[2]) for x in (res or [])]
            out.append({
                "text": " ".join(texts).strip(),
                "conf": round(sum(confs) / len(confs), 3) if confs else 0.0,
            })
        except Exception as e:        # noqa: BLE001
            out.append({"text": "", "conf": 0.0, "error": str(e)[:120]})
    print(json.dumps({"ok": True, "items": out}, ensure_ascii=False))


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
