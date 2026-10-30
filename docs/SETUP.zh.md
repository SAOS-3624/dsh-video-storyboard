# 配置手册 · 让插件能读 B 站和网页链接

> 面向两类人：① 想用 URL 模式的本机用户；② 从 GitHub 克隆下来自己跑的人。
> 只用本地文件（`video_storyboard({ input: "D:/a.mp4" })`）的话，这份文档可以整篇跳过。

---

## 1. 需要装什么

| 依赖 | 本地文件模式 | URL 模式 | 说明 |
|---|---|---|---|
| **ffmpeg** | ✅ 必需 | ✅ 必需 | 7.0+，需在 `PATH` 上，或用 `DSH_FFMPEG_PATH` 指定 |
| **yt-dlp** | — | ✅ 必需 | 解析直链 + 拉低清全片；**不打包进插件** |
| **cookies.txt** | — | ✅ 必需 | 默认策略要求登录（见 §3） |

`ffmpeg` 的装法不在这里重复，见 `USAGE.zh.md`。

---

## 2. 安装 yt-dlp

### Windows

```powershell
pip install --user -U yt-dlp
```

⚠️ 脚本会装到 `%APPDATA%\Python\Python3xx\Scripts`，**这个目录通常不在 PATH 上**。插件会自动去这几个位置找：

1. `PATH` 上的 `yt-dlp` / `yt-dlp.exe`
2. `%APPDATA%\Python\Python3xx\Scripts\yt-dlp.exe`
3. `DSH_YTDLP_PATH` 指定的路径

都没有就会报错并附上安装命令——**不会静默降级成"没有这个功能"**。

其他两种装法：

```powershell
winget install yt-dlp                            # 单文件，进 PATH，推荐
# 或从 github.com/yt-dlp/yt-dlp/releases 下 yt-dlp.exe 放到任意目录并加进 PATH
```

### macOS / Linux

```bash
brew install yt-dlp        # macOS
pipx install yt-dlp        # 跨平台，隔离环境，推荐
sudo apt install yt-dlp    # Debian/Ubuntu（版本可能偏旧）
```

### 装多大

| 方式 | 体积 |
|---|---|
| `pip install` | **约 25 MB**（`yt_dlp/` 包） + 0.1 MB 启动器 |
| 单文件 `yt-dlp.exe` | 约 17 MB（自带 Python 运行时） |

**这是用户侧的依赖，不是插件的体积。** 插件本身的 `package.json` 依然是零依赖。

### 验证

```bash
yt-dlp --version          # 期望输出日期版本号，如 2026.10.26
```

---

## 3. 导出 cookies.txt

### 为什么必须导出，不能直接读浏览器

Chromium 127+ 启用了 **App-Bound Encryption**，`SESSDATA` 这类关键 cookie 的加密前缀是 `v20`，密钥绑定浏览器进程身份，必须通过 `IElevator` COM 接口才能解密。

实测（Windows 11 + Edge）：

| cookie | 加密前缀 | 普通进程能否解 |
|---|---|---|
| `enable_web_push` / `LIVE_BUVID` / `theme_style` | `v10` | ✅ |
| **`SESSDATA`** / `bili_jct` / `DedeUserID` / `buvid3` | **`v20`** | ❌ |

所以 `yt-dlp --cookies-from-browser chrome/edge` 会失败并报 `Failed to decrypt with DPAPI`。**这不是配置错误**，是机制变了。只能导出文件。

### 步骤

1. 浏览器装扩展 **Cookie-Editor**（作者 cgagnier，Chrome / Edge 商店都有）
2. 打开并登录 `example.com`
3. 点扩展图标 → 右下角 **Export** → 选 **Netscape**
4. 保存为 `cookies.txt`

拿到的应该是一个 **Netscape HTTP Cookie File**，长这样：

```
# Netscape HTTP Cookie File
.example.com	TRUE	/	FALSE	1799999999	<session-cookie-name>	<value>
.example.com	TRUE	/	FALSE	1799999999	<second-cookie>	<value>
```

⚠️ **这个文件等同于你的登录凭证**，不要提交进任何仓库。放进 `.secrets/` 或任何被 `.gitignore` 覆盖的位置。

### 放到哪

```bash
# 方式一：环境变量（推荐）
setx DSH_VIDEO_COOKIES "D:\deepseek\3-Life\.secrets\cookies.txt"

# 方式二：每次调用显式传
video_storyboard({ input: "...", cookies: "D:/.../cookies.txt" })
```

> 桌面版 DSH 读不到 `setx` 设的用户环境变量时，改走 `~/.dsh/asr.json` 同款文件配置思路——这一点和 ASR 的已知问题一致。

### 配置文件：桌面版必须用这个，别用 setx

**DSH 桌面版读不到用户 `setx` 设的环境变量**（ASR 那边已经踩过同一个坑）。你在终端里配好了
`DSH_VIDEO_COOKIES`，插件里依然说"没有 cookie"——不是它没读，是它读不到。

所以配置写进文件：

```json
// ~/.dsh/video.json
{
  "cookies": "D:/path/to/cookies.txt",
  "scanHeight": 360,
  "zoomHeight": 1080
}
```

优先级：**工具参数 > 环境变量 > `~/.dsh/video.json`**。

没有 cookie 也**不会报错**了：插件先用匿名地址探一次，能拿到目标档就照常跑（很多视频匿名
本来就有 1080p），拿不到才在结果里标 `degraded` 并给一条说明。

### 有效期

`SESSDATA` 通常几个月。过期后 yt-dlp 会报 `Sign in` / `login` 相关文案，插件会识别并提示"重新导出"，不会抛原始 stderr。

---

## 4. 环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `DSH_YTDLP_PATH` | 自动发现 | yt-dlp 可执行文件路径 |
| `DSH_VIDEO_COOKIES` | 无 | cookies.txt 路径 |
| `DSH_VIDEO_MEDIA_DIR` | `os.tmpdir()/dsh-video-storyboard/media` | 低清全片落盘位置 |
| `DSH_VIDEO_MEDIA_MAX_MB` | `300` | 媒体缓存上限，超了按 mtime 从旧删 |
| `DSH_FFMPEG_PATH` | `ffmpeg` | ffmpeg 路径（沿用 0.2.x） |

---

## 5. 验证顺序

按这个顺序走，出问题能立刻定位到哪一环。

```bash
# ① yt-dlp 在不在、版本对不对
yt-dlp --version

# ② 能不能解析出格式列表（这一步不需要下载、不需要 cookie）
yt-dlp -F "<a URL you are allowed to download>"

# ③ 能不能拿到直链（解析开销约 2.6s）
yt-dlp -g -f "bv*[height<=360]/b" "<same URL>"

# ④ 真下载一条 360P（约 3 MB / 3s）
yt-dlp -f "bv*[height<=360]+ba/b[height<=360]" -o "test.%(ext)s" \
  "<same URL>"

# ⑤ 带 cookie 拿 1080P（验证登录态真的生效）
yt-dlp --cookies "$DSH_VIDEO_COOKIES" -F "同上"   # 看列表里有没有 1920x1080
```

### 格式选择器必须用 DASH 语法

B 站的 yt-dlp extractor 给的是 **DASH 分轨**（video only + audio only），不是单段 mp4。所以：

```bash
-f "b[height<=360]"              # ❌ 报 Requested format is not available
-f "bv*[height<=360]+ba"         # ✅ 视频轨 + 最佳音频轨
-f "bv*[height<=360]"            # ✅ 只要视频轨（zoom 用，省一半带宽）
```

> **每个站点、每个视频的可下载档位差别很大**，取决于站点、视频本身和你的登录状态。
> 所以配了 cookie 文件时默认走 cookie：这能消除"以为拿到高清、实际是 360P"的失败模式。
> 拿不准就先 `yt-dlp -F` 看一眼，别信标题里的分辨率。

---

## 6. 故障对照

| 现象 | 真实原因 | 处理 |
|---|---|---|
| `yt-dlp not found` | 装在 `%APPDATA%\Python\...\Scripts` 但不在 PATH | 设 `DSH_YTDLP_PATH` |
| `Requested format is not available` | 用了 `b[height<=N]` 单段语法 | 改 `bv*[height<=N]+ba` |
| `Failed to decrypt with DPAPI` | 试图读浏览器 cookie（v20 加密） | 按 §3 导出 cookies.txt |
| `Sign in to confirm` / `login required` | cookie 过期或没传 | 重新导出；检查 `DSH_VIDEO_COOKIES` |
| `HTTP Error 412` | B 站风控（请求过密/无 UA） | 降低频率；确认带了 UA |
| 下载卡在 0% | 网络或 CDN 节点问题 | 重试；检查是否需要代理 |
| 竖屏视频被拉扁 | 旋转元数据未归一 | 这是 0.2.x 已修复的，报 bug |
| 媒体目录占满 | 300 MB 上限内正常滚动 | 调 `DSH_VIDEO_MEDIA_MAX_MB` 或清空目录 |
| 直链 2 小时后失效 | B 站签名 URL 有时效 | 插件会自动重解析一次；持续失败则回落低清 |

---

## 7. 隐私与合规

- 视频内容只落本机临时目录，**不上传、不分发**
- cookies.txt 只按路径传给 yt-dlp 子进程，**不写进返回值、日志、manifest**
- 直链是带签名的临时凭证，缓存 90 分钟后失效即弃，不进持久层
- 只用于你有权处理的素材；插件不内置下载器、不内置搜索、不缓存分发内容
