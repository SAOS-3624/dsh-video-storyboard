# 配置全解（一份真实可用的配置）

这份文档记录**实际在跑的配置**，不是示意。路径都是示例，换成你自己的即可。

---

## 1. 目录长什么样

```
D:/asr/                          # 语音服务目录（任意位置，建议独立）
├─ .venv/                        # Python 虚拟环境（sherpa-onnx 装在这里）
├─ models-sherpa/
│  ├─ model.int8.onnx            # paraformer-zh-2024-03-09  217 MB
│  ├─ tokens.txt
│  ├─ silero_vad.onnx            # 断句 629 KB
│  └─ punct/
│     ├─ model.onnx              # ct-transformer 标点 281 MB
│     └─ tokens.json
├─ server-sherpa.py              # 服务本体（OpenAI 兼容 + /shutdown）
└─ start-asr.cmd                 # 手动启动用（CRLF + 纯 ASCII）
```

## 2. `~/.dsh/asr.json`（语音）

```json
{
  "baseUrl": "http://127.0.0.1:8000/v1",
  "model": "paraformer-zh-2024-03-09",
  "language": "zh",
  "manage": {
    "start": ["D:/asr/.venv/Scripts/python.exe", "D:/asr/server-sherpa.py"],
    "idleMs": 5000,
    "waitMs": 60000
  }
}
```

| 字段 | 说明 |
|---|---|
| `baseUrl` | 指到**本机**（`127.0.0.1` / `localhost` / `[::1]`）时**不需要 key** |
| `manage.start` | 数组最稳：`[解释器, 脚本]`。写成 `.py` 也会自动补解释器；写成 `.cmd` 能跑但会闪黑框 |
| `manage.idleMs` | 最后一次运行结束后多久请服务退出。sherpa 冷启动 5 秒 → 设 **5000** 就够 |
| `manage.waitMs` | 等它 ready 的上限。模型首次加载约 2 秒，60 秒很宽松 |
| `hotwords` | **不建议写在全局**，见 §4 |

## 3. `~/.dsh/video.json`（视频）

```json
{
  "cookies": "D:/cookies/bili-cookies.txt",
  "scanHeight": 360,
  "zoomHeight": 1080
}
```

| 字段 | 说明 |
|---|---|
| `cookies` | 需要登录的视频才用（B 站 1080P+ / 会员 / 567）。普通视频留空即可 |
| `scanHeight` | 扫描用的低清版。360 足够判构图与切点，且下载快 |
| `zoomHeight` | `video_zoom` 回原流取的清晰度 |

## 4. 热词：按片子传，别写全局

```js
video_storyboard({ input: "lecture.mp4", hotwords: "位错 滑移 柏氏矢量 晶界" })
```

全局 `hotwords` 只在"我天天看同一类片"时才值得写。**学科不对时它是负偏置**——
拿摄影词（像差 焦段）去识别材料学讲座，只会把词往错的方向拉。

## 5. 实测数字（16 核 / 16 GB，Windows）

| 项目 | 数值 |
|---|---|
| sherpa 模型加载 | **1.9 s** |
| 插件侧冷启动（含进程创建） | **4–5 s** |
| FunASR 冷启动（对比） | 30 s |
| 45 秒音频转写 | 2.1 s |
| 21 分钟录屏，整片 | **89 s**（扫描 82 / 转写被扫描完全吞掉 / 取帧 3.4 / 音频 2.7） |
| 90 秒片，9 格 | **12 s**（取帧并发 8 路：13.3 → 4.0 s） |
| 模型体积 | sherpa 500 MB（含标点）/ FunASR 2.1 GB |

## 6. 三种启动方式

```jsonc
// ① 数组：最明确，不闪窗
"start": ["D:/asr/.venv/Scripts/python.exe", "D:/asr/server-sherpa.py"]

// ② 直接写脚本：自动补解释器（按同目录 .venv 找）
"start": "D:/asr/server-sherpa.py"

// ③ 批处理：留给手动双击，插件用会闪一个控制台窗口
"start": "D:/asr/start-asr.cmd"
```

> 批处理必须 **CRLF 行尾 + 纯 ASCII**。LF 行尾的 `.cmd` 会被 `cmd.exe` 当成命令逐片段执行，
> 屏幕上会出现 `'wo' 不是内部或外部命令` 这种莫名其妙的报错（我们踩过）。

## 7. 服务端要满足的契约

```
GET  /health                    → 200（拿不到就读 /v1/models）
POST /v1/audio/transcriptions   → OpenAI 兼容，返回 verbose_json
                                 { text, segments:[{start,end,text}] }
POST /shutdown                  → 返回后退出（不支持也行，插件会退回杀进程）
```

## 8. 排障对照

| 现象 | 多半是什么 | 怎么办 |
|---|---|---|
| `asr-failed · ECONNREFUSED` | 服务没起来 | 看 `manage.start` 是否写成了 `.py`（现已自动补解释器）、端口是否被占 |
| 转写空白但视频有说话 | 热词/模型不对，或确实没人说话 | 先看清单是 `asr-empty` 还是 `asr-failed`，两者含义不同 |
| `HTTP Error 567` | B 站风控（常伴"要登录"） | 导出 cookies.txt，或直接喂本地文件 |
| 说有 1080p 却只给 480p | cookies 过期会**降低**可见清晰度 | 插件会自动改探匿名并提示你重导 |
| 清单写 `!! NEEDS LOGIN` | 站点把字幕藏在登录后面 | 给 cookies；给不了就明说，不要从画面猜台词 |
