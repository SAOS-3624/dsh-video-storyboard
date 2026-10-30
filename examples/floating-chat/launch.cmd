@echo off
rem 双击启动悬浮聊天窗。用 pythonw 是为了不留黑框。
rem 找不到带 tkinter 的 Python 时，改成用 python 跑同一份文件，就能看到具体报错。
start "" pythonw "%~dp0window.py"

