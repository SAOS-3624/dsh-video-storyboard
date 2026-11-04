# 安装（从零开始）

> 目标：从一台**什么都没装**的机器，到能跑出第一张分镜图。
> 全程大约 10 分钟，其中 8 分钟是等下载。

---

## 0. 先看要装什么

| 依赖 | 必须吗 | 干什么 | 不装会怎样 |
|---|---|---|---|
| **DSH 桌面版** | 必须 | 宿主 | 插件没地方跑 |
| **Node.js ≥ 20** | 必须 | 插件本身 | — |
| **ffmpeg + ffprobe** | **必须** | 解码、取帧、量响度 | 装完也用不了，第一步就报错 |
| **yt-dlp** | 可选 | 贴 B 站/YouTube 链接时才要 | 本地文件照常能用 |
| **ASR 服务** | 可选 | 出字幕/台词 | 能出图，但清单里没有台词 |
| **OCR 引擎** | 可选 | 用画面硬字幕校正 ASR、找字幕带 | 不影响出图，硬字幕一条也读不到 |

**只有 ffmpeg 是硬性的。** 其余三个不装都能用，只是少一块能力。

---

## 1. 装 ffmpeg（唯一必须的那一步）

### Windows

```powershell
winget install Gyan.FFmpeg
```

装完**关掉所有终端再开一个新的**（PATH 要重新读），然后验证：

```powershell
ffmpeg -version
ffprobe -version
```

两条都能打印版本号才算成功。

> 如果 `winget` 用不了，去 https://www.gyan.dev/ffmpeg/builds/ 下 `ffmpeg-release-essentials.zip`，
> 解压后把 `bin` 目录加进系统 PATH，同样要重开终端。

### macOS

```bash
brew install ffmpeg
```

### Linux

```bash
sudo apt install ffmpeg     # Debian/Ubuntu
sudo dnf install ffmpeg     # Fedora
```

### 验证（三平台通用）

```bash
ffmpeg -version | head -1
ffprobe -version | head -1
```

**两条都要有输出。** 只有 `ffmpeg` 没有 `ffprobe` 的情况真实存在（某些精简包），插件会明确报出来。

### 装了却报 "not found"？先分清是哪一种

插件按这个顺序找：`DSH_FFMPEG_PATH` / `FFMPEG_PATH` → `DSH_FFMPEG_DIR` →
`$DSH_HOME/tools/ffmpeg/bin` → `$DSH_HOME/bin` → `$DSH_HOME` 的上一级 → **会话工作区** →
`PATH`。报错信息现在会区分两种情况：

| 报错里写的是什么 | 意思 | 怎么办 |
|---|---|---|
| 只列路径，没有附注 | 这些位置都没有这个文件 | 装 ffmpeg，或设 `DSH_FFMPEG_PATH` |
| `(exists but this process cannot read it: EACCES)` | **文件在，但插件进程读不到** —— DSH 桌面版的 `workspace-write` 沙箱只放行会话工作区 | 把 `ffmpeg.exe` / `ffprobe.exe` 拷进会话工作区的 `tools/ffmpeg/bin/`，或设 `DSH_FFMPEG_PATH` 指到能读的位置 |

沙箱受限时（Windows 桌面版 `workspace-write`）这些也可能一起被挡，需要一并指到工作区：

```powershell
setx DSH_FFMPEG_PATH     "C:\...\default-workspace\tools\ffmpeg\bin\ffmpeg.exe"
setx DSH_FFPROBE_PATH    "C:\...\default-workspace\tools\ffmpeg\bin\ffprobe.exe"
setx DSH_VIDEO_CACHE_DIR "C:\...\default-workspace\.video-cache"
setx DSH_VIDEO_MEDIA_DIR "C:\...\default-workspace\.video-media"
```

> `setx` 写的是用户环境变量，**桌面版进程可能读不到**（它继承了启动时的环境）。
> 改完要彻底退出 DSH 再启动（托盘也要退）。实在不行把二进制直接放到会话工作区的
> `tools/ffmpeg/bin/` 下 —— 那个位置默认就在搜索顺序里，不用设任何变量。

---

## 2. 装 yt-dlp（只有贴链接才需要）

```bash
pip install --user -U yt-dlp
```

Windows 上它会装到：

```
C:\Users\<你>\AppData\Roaming\Python\Python3xx\Scripts\yt-dlp.exe
```

**这个目录默认不在 PATH 上，但插件会自动扫到它**，不用手动加 PATH。

验证：

```bash
python -m yt_dlp --version      # 走模块，不依赖 PATH
```

或者直接跑一次链接下载试试（第 5 步有）。

> 装不上就用 `winget install yt-dlp`（Windows）或 `brew install yt-dlp`（macOS）。
> 实在没有也能用：把视频下载到本地，直接喂文件路径。

---

## 3. 装 ASR 服务（可选，但只要台词就得配）

> **不配也能跑**：清单里会写 `transcript: none`，图照出，只是没有台词。
> 这**不是**"这条片子没声音"，也不是画质/分镜出了问题。

免费路线有两条，**选一条就行**，都是不联网、约 15 分钟。两条都只提供"模型 + 推理库"，
那个 OpenAI 兼容的 HTTP 服务要你自己起（契约见 [`asr-contract.md`](./asr-contract.md)）。

**A. sherpa-onnx（体积小、冷启动快，推荐）**

```bash
# 需要 Python 3.9+
pip install sherpa-onnx
```

模型从 sherpa-onnx 官方模型库下两个就够：

- `paraformer-zh-2024-03-09`（约 217 MB，中文识别 + `tokens.txt`）
- `silero_vad.onnx`（约 629 KB，断句）

地址在 <https://k2-fsa.github.io/sherpa/onnx/pretrained_models/index.html>。
标点模型可选（`ct-transformer`，281 MB），不加就只有裸文本。

**B. FunASR（生态成熟，模型大一些，约 2.1 GB）**

```bash
pip install funasr modelscope
```

它自带的 `funasr-server` 就是 OpenAI 兼容的 `/audio/transcriptions`，不用自己写。

**两条路线落地方式一样** —— 服务起好后写 `~/.dsh/asr.json`：

```json
{
  "baseUrl": "http://127.0.0.1:8000/v1",
  "key": "local",
  "model": "paraformer-zh",
  "language": "zh"
}
```

指到 `127.0.0.1` / `localhost` 时 `key` 随便填，插件不会用它。
想让插件顺手帮你启停服务（冷启动约 2 秒），加 `manage.start`，见
[`CONFIG.zh.md`](./CONFIG.zh.md) §2。**实测体积与冷启动时间也在那份文档里**（§7）。

**C. 云端 / 现成的 OpenAI 兼容 API（要 key）**

```json
{
  "baseUrl": "https://api.openai.com/v1",
  "key": "sk-...",
  "model": "whisper-1"
}
```

**D. 不装 ASR 也能有台词：读站点的 CC 字幕**

B 站这类站点本身就带字幕，给它一份 cookies 就不用装 ASR，也不用花 token：

1. 浏览器装 **Cookie-Editor**（Chrome / Edge 都有），登录 B 站；
2. 点扩展 → **Export** → 选 **Netscape** → 存成 `bili-cookies.txt`（放仓库外，比如 `~/.secrets/`）；
3. 写进 `~/.dsh/video.json`：

```json
{ "cookies": "C:/Users/<你>/.secrets/bili-cookies.txt" }
```

验证：跑一次 B 站链接的 `video_storyboard`，清单里出现 `transcript: site-cc:zh-CN`
（或 `site-cc`）就说明读到了。**cookie 等同于登录凭证，别提交进任何仓库**；
Chromium 127+ 有 App-Bound Encryption，`--cookies-from-browser` 会失败，必须导出文件。

> 已经有字幕文件？不用 ASR —— 用 `transcriptFile` 直接喂 SRT/JSON，见 [USAGE.zh.md](USAGE.zh.md)。

---

## 3.5 装 OCR（可选）

**插件不带 OCR 引擎。** 模型 300MB 上下、还要一个 Python 环境，打进 npm 包对只想要分镜的人是纯负担。
所以这一块和 ffmpeg 一个待遇：**你自己装，插件负责调用**。

什么时候需要它：

- 想读**硬字幕**（烧在画面里的字）—— PV、唱歌、双语艺术字，ASR 转不出来的那些；
- 开了 `detail: high`，想用画面字幕把 ASR 听错的专有名词纠正回来。

### 装

```bash
# 1) 独立环境。别装进 ASR 用的那个 venv —— 两个模型的依赖会打架
python -m venv D:/ocr-local/.venv

# 2) 模型包 + 推理后端，两个都要
D:/ocr-local/.venv/Scripts/python.exe -m pip install rapidocr onnxruntime
```

首装约 300MB，之后完全离线（模型落在 `Lib/site-packages/rapidocr/models/`）。

> ⚠️ **不要照老教程装 `rapidocr-onnxruntime`。** 那个包把 `requires-python` 写死在 `<3.13`，
> 在新一点的 Python 上直接 `No matching distribution found`。新版包叫 `rapidocr`，
> import 名和返回结构都变了，插件两个都认（先试新的）。

### 让插件找到它

写进 `~/.dsh/video.json`（桌面版宿主读不到 `setx` 的环境变量，所以只能写文件）：

```json
{
  "ocr": { "python": "D:/ocr-local/.venv/Scripts/python.exe" }
}
```

不写这一行也行，插件会依次试：`DSH_OCR_PYTHON` → `asr.json` 里的那个 Python → PATH 上的 `python`。

### 验证

```bash
D:/ocr-local/.venv/Scripts/python.exe -c "from rapidocr import RapidOCR; print('ok')"
```

或者直接在清单里看：跑一次 `detail: high`，出现 `on-screen subs: spot-checked N lines`
就是通了；`skipped (no-python-with-rapidocr)` 说明还没找到解释器。

**装完不用重启**：插件对"找不到"的结果只缓存 60 秒，最多等一分钟自动生效。
还不生效就带 `DSH_OCR_DEBUG=1` 再跑一次，stderr 会列出试过哪些解释器。

---

## 4. 装插件

两条路，**先看 A**。区别只有一个：A 装的是 npm 上的发行版，B 装的是你手上的源码（改代码用）。

### A. 从 npm 装（推荐，仅 `web` 这类普通 profile）

```bash
dsh plugin --profile web add dsh-video-storyboard
```

**装完必须重启 DSH。**

> **桌面版（Electron）的 `desktop` profile 不归这条命令管**，`dsh plugin` 会直接拒绝 ——
> 桌面版走下面的 B。
>
> 卸载：`dsh plugin --profile web remove dsh-video-storyboard`
>
> `dsh plugin` 把参数原样转给 pnpm，所以 `add` / `remove` / `update` 都是 pnpm 的用法。

### B. 从源码装（改代码 / 跑未发布版本）

```bash
git clone https://github.com/SAOS-3624/dsh-video-storyboard.git
cd dsh-video-storyboard
node scripts/install-dev.mjs
```

脚本会把插件装进 DSH 的插件目录并打好配置。同样**装完必须重启 DSH**。

> 注意：`install-dev.mjs` 是**把目录复制过去**，之后改源码要重跑一次才会生效。

---

## 5. 自检：跑第一张图

```bash
# 本地文件
node bin/storyboard.mjs 你的视频.mp4 --strategy auto --out test.png

# 或者贴一个链接（需要第 2 步的 yt-dlp）
node bin/storyboard.mjs "https://example.com/some-video" --strategy auto --out test.png

# 只想知道会花多少钱（不出图、不转写）
node bin/storyboard.mjs 你的视频.mp4 --dry-run
```

成功的标志是最后几行长这样：

```
[fetch] downloaded 4.2MB → 360p
[probe] 640x360 29.97fps 67.71s audio
[scan] 2028 帧 → 40 个切点（阈值 40，自适应 2 个密集段）
[plan] 9 格 × 1 张
[sheet] test.png  1009x620  3x3  cell≈331x184
[done] 30817ms
```

打开 `test.png`，应该是一张宫格图。

---

## 6. 装不上时看这张表

| 报错 | 原因 | 怎么办 |
|---|---|---|
| `ffmpeg not found` | 没装，或装了但进程读不到（沙箱） | 按第 1 节的表分清属于哪种；要么设 `DSH_FFMPEG_PATH` 指到绝对路径，要么把二进制拷进会话工作区 |
| `ffprobe not found` | 只装了 ffmpeg 主程序 | 装完整包（gyan.dev 的 essentials 版含 ffprobe） |
| `yt-dlp not found` | 没装 yt-dlp，或在 PATH 之外且没扫到 | `pip install --user -U yt-dlp`；或设 `DSH_YTDLP_PATH` 指向 exe |
| `Requested format is not available` | 视频只有 DASH 流 | 0.4.0 已修；旧版本升级即可 |
| `transcript: none` | 没配 ASR | 正常，不影响出图；要台词就配第 3 步 |
| `no video stream` | 下到的是纯音频（部分付费内容） | 换一个视频，或用 `--cookies` 走登录 |
| 装完 DSH 里看不到工具 | 没重启 | 重启 DSH |

---

## 7. 一句话版本

```bash
winget install Gyan.FFmpeg                        # 必须
pip install --user -U yt-dlp                      # 贴链接才需要
dsh plugin --profile web add dsh-video-storyboard # 装插件（桌面版/改代码用 install-dev.mjs）
# 重启 DSH
```
