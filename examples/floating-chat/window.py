#!/usr/bin/env python3
"""floating-chat — 一个**独立悬浮**的陪看聊天窗，不需要浏览器。

为什么不用浏览器：浏览器那条路（`documentPictureInPicture`）能置顶，但要先开一个标签页；
而且它只是"把标签页搬进小窗"，关掉标签页就没了。这里是真·独立进程的原生窗口。

读的是同一份 `chat.jsonl`（插件写的统一文本流：剧本台词 / 插话 / 你自己的话），
写回去的也是同一份 —— 所以浏览器那个框开着也不会冲突，两个前端看的是同一条时间线。

用法（**必须用带 tkinter 的 Python**，Windows 商店版自带）：

    pythonw examples/floating-chat/window.py        # 无控制台
    python  examples/floating-chat/window.py        # 有控制台，方便看报错

窗口：无边框、置顶、半透明、按住顶部拖动；回车发送；Esc 关闭。

依赖：标准库 tkinter（不装任何第三方包）。
"""

import json
import os
import sys
import time

try:
    import tkinter as tk
    from tkinter import font as tkfont
except Exception as exc:  # pragma: no cover - 环境问题，直接说清楚
    sys.stderr.write(
        "这个 Python 没有 tkinter，换一个。\n"
        "  Windows 商店版 Python 自带；也可以用 python.org 的官方安装包（勾选 tcl/tk）。\n"
        f"  当前解释器：{sys.executable}\n  错误：{exc}\n"
    )
    raise SystemExit(2)

# ---------------------------------------------------------------- 数据

ROLE_STYLE = {
    "line": ("#e8c98a", "#1c1a17", "剧本"),
    "assistant": ("#cdd9e5", "#242424", "陪看"),
    "user": ("#9fc4e8", "#26384a", "我"),
}


def cache_dir():
    d = os.environ.get("DSH_VIDEO_CACHE_DIR")
    if d:
        return d
    local = os.environ.get("LOCALAPPDATA")
    if os.name == "nt" and local:
        return os.path.join(local, "dsh-video-storyboard", "cache")
    return os.path.join(os.environ.get("XDG_CACHE_HOME") or os.path.expanduser("~/.cache"),
                        "dsh-video-storyboard")


CHAT_FILE = os.path.join(cache_dir(), "chat.jsonl")


def read_entries():
    try:
        with open(CHAT_FILE, "r", encoding="utf-8") as f:
            return [json.loads(line) for line in f if line.strip()]
    except FileNotFoundError:
        return []
    except Exception:
        return []          # 半行/坏行：下一拍再读，不打断


def append_user(text):
    os.makedirs(os.path.dirname(CHAT_FILE), exist_ok=True)
    with open(CHAT_FILE, "a", encoding="utf-8") as f:
        f.write(json.dumps({"role": "user", "text": text, "at": int(time.time() * 1000)},
                           ensure_ascii=False) + "\n")


def mmss(t):
    try:
        s = max(0.0, float(t))
    except (TypeError, ValueError):
        return ""
    return f"{int(s // 60):02d}:{s % 60:04.1f}"


# ---------------------------------------------------------------- 窗口

class FloatChat:
    def __init__(self):
        self.root = tk.Tk()
        self.root.title("陪看")
        self.root.overrideredirect(True)                 # 无边框
        self.root.attributes("-topmost", True)           # 置顶
        self.root.attributes("-alpha", 0.94)             # 半透明
        self.root.configure(bg="#161616")

        w, h = 470, 520
        sw = self.root.winfo_screenwidth()
        sh = self.root.winfo_screenheight()
        self.root.geometry(f"{w}x{h}+{sw - w - 40}+{sh - h - 90}")

        self.family = self._pick_font()
        self._build()
        self.seen = 0
        self.poll()

        self.root.bind("<Escape>", lambda _e: self.close())
        self.root.after(200, lambda: self.entry.focus_force())

    def _pick_font(self):
        families = set(tkfont.families())
        for name in ("Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC",
                     "Noto Sans CJK SC", "WenQuanYi Micro Hei"):
            if name in families:
                return name
        return "TkDefaultFont"

    def _build(self):
        head = tk.Frame(self.root, bg="#101010", height=30)
        head.pack(fill="x")
        head.pack_propagate(False)

        title = tk.Label(head, text="陪看", bg="#101010", fg="#d8d8d8",
                         font=(self.family, 10, "bold"))
        title.pack(side="left", padx=10)

        self.hint = tk.Label(head, text="", bg="#101010", fg="#6f6f6f",
                             font=(self.family, 9))
        self.hint.pack(side="left", padx=4)

        for text, cmd in (("✕", self.close), ("▾", self.toggle_collapse)):
            b = tk.Label(head, text=text, bg="#101010", fg="#888",
                         font=(self.family, 11), padx=8, cursor="hand2")
            b.pack(side="right")
            b.bind("<Button-1>", lambda _e, c=cmd: c())

        # 拖动
        for widget in (head, title, self.hint):
            widget.bind("<Button-1>", self._drag_start)
            widget.bind("<B1-Motion>", self._drag_move)

        self.body = tk.Frame(self.root, bg="#161616")
        self.body.pack(fill="both", expand=True)

        self.text = tk.Text(self.body, bg="#161616", fg="#ddd", wrap="word",
                            font=(self.family, 10), bd=0, padx=10, pady=8,
                            insertwidth=0, highlightthickness=0)
        self.text.pack(fill="both", expand=True)
        self.text.configure(state="disabled")

        self.text.tag_configure("line", foreground="#e8c98a", lmargin1=8, lmargin2=8,
                                spacing1=6, spacing3=2)
        self.text.tag_configure("assistant", foreground="#cdd9e5", lmargin1=8, lmargin2=8,
                                spacing1=6, spacing3=2)
        self.text.tag_configure("user", foreground="#9fc4e8", justify="right",
                                lmargin1=8, rmargin=8, spacing1=6, spacing3=2)
        self.text.tag_configure("meta", foreground="#6a6a6a", font=(self.family, 8))

        bar = tk.Frame(self.root, bg="#161616")
        bar.pack(fill="x", padx=8, pady=(0, 8))

        self.entry = tk.Entry(bar, bg="#202020", fg="#eee", insertbackground="#eee",
                              relief="flat", font=(self.family, 10))
        self.entry.pack(side="left", fill="x", expand=True, ipady=7, padx=(0, 6))
        self.entry.bind("<Return>", self._send)

        send = tk.Label(bar, text="发送", bg="#3a6ea5", fg="#fff",
                        font=(self.family, 10), padx=12, cursor="hand2")
        send.pack(side="left", ipady=6)
        send.bind("<Button-1>", lambda _e: self._send())

        self.bar = bar

    # ---- 拖动 ----
    def _drag_start(self, event):
        self._dx, self._dy = event.x_root - self.root.winfo_x(), event.y_root - self.root.winfo_y()

    def _drag_move(self, event):
        self.root.geometry(f"+{event.x_root - self._dx}+{event.y_root - self._dy}")

    # ---- 交互 ----
    def toggle_collapse(self):
        if self.body.winfo_ismapped():
            self.body.pack_forget()
            self.root.geometry("470x30")
        else:
            self.body.pack(fill="both", expand=True)
            self.root.geometry("470x520")

    def close(self):
        self.root.destroy()

    def _send(self, _event=None):
        text = self.entry.get().strip()
        if not text:
            return
        self.entry.delete(0, "end")
        try:
            append_user(text)
        except Exception as exc:
            self._append("meta", f"写不进去：{exc}\n")
            return
        self.poll()      # 立刻回显，不等下一拍

    # ---- 轮询 ----
    def _append(self, tag, body, meta=None):
        self.text.configure(state="normal")
        if meta:
            self.text.insert("end", meta + "\n", "meta")
        self.text.insert("end", body + "\n", tag)
        self.text.configure(state="disabled")
        self.text.see("end")

    def poll(self):
        try:
            entries = read_entries()
            if len(entries) > self.seen:
                for e in entries[self.seen:]:
                    role = e.get("role") if e.get("role") in ROLE_STYLE else "assistant"
                    _fg, _bg, who = ROLE_STYLE[role]
                    stamp = mmss(e.get("t")) if e.get("t") is not None else ""
                    label = who + (f" {stamp}" if stamp else "") + (" · 会念" if e.get("say") else "")
                    self._append(role, str(e.get("text") or ""), label)
                self.seen = len(entries)
                self.hint.configure(text=f"{self.seen} 条")
            elif len(entries) < self.seen:
                self.seen = 0      # 文件被清空/重建
        except Exception:
            pass
        self.root.after(400, self.poll)


if __name__ == "__main__":
    if not os.path.exists(CHAT_FILE):
        os.makedirs(os.path.dirname(CHAT_FILE), exist_ok=True)
    FloatChat().root.mainloop()

