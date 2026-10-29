# 陪看配置（一起看电影）

> 这份文档只为了一件事：**让它稳定认出你在看什么、看到第几秒**。
> 配好一次，之后打开视频就行，不用贴链接、不用搜索。

---

## 一、为什么不配也能用，但会不准

Windows 的媒体控件（SMTC）会给"正在播放"的位置，但有三个毛病：

| 毛病 | 实测 |
|---|---|
| 只在事件时刷新 | 起播/暂停/拖动/切集才刷新，两次刷新隔过 **143 秒、216 秒** |
| 只给标题，不给地址 | 想拿视频必须靠标题去搜 |
| 很多播放器/网页根本不接 | 抖音、视频号常常完全不报 |

于是插件只能"猜"：拿标题去 B 站搜，再按时长核对。**猜不中就说不出话。**

---

## 二、开一个调试端口，这些问题就都没了

浏览器里的那个 `<video>` 元素知道**一切**：

```js
document.querySelector('video').currentTime   // 秒，毫秒级
location.href                                  // 页面地址 = 视频地址
```

插件通过 CDP（Chrome DevTools Protocol）读它，一次往返约 **20 毫秒**。

### 怎么开

**① 关掉所有 Edge 窗口**（重要：不关的话新参数会被已有实例吞掉，只是多开一个标签）

**② 用带端口的参数启动**

```bash
# Windows
"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" --remote-debugging-port=9333
```

或者双击仓库里的 [`scripts/start-edge-debug.cmd`](../scripts/start-edge-debug.cmd)。

**③ 告诉插件端口** —— 写文件（推荐）：

```jsonc
// %USERPROFILE%\.dsh\video.json
{ "browserPort": 9333 }
```

**④ 重启 DSH 一次**（插件树在进程启动时组合）。

---

## 三、三个必须知道的坑

### 1. 端口别用 9222

9222 是 Chrome DevTools 的惯例端口，**会被别的 Electron 应用占掉**。
实测这台机器上 WorkBuddy 自己就占着 9222，而且它的界面里**也有一个 `<video>`**——
盲连就会把宿主的界面当成你在看的片子。

插件默认用 **9333**，并且会跳过 `app.asar` / `devtools://` 这类页面。

### 2. 配置写文件，不要指望 `setx`

```bash
setx DSH_BROWSER_DEBUG_PORT 9333    # ❌ 对 DSH 桌面版无效
```

桌面版 DSH 的宿主进程 env 由启动器决定，`setx` 之后**插件仍然读不到**。
（ASR 的 key 也踩过一模一样的坑。）所以配置一律走 `~/.dsh/video.json`。

环境变量仍然认，只是排在文件后面。

### 3. 为什么"又开了一个 Edge"？

**调试端口只能在启动时打开，运行中无法开启**（这是 Chromium 的安全设计，
否则任何本机程序都能读你的页面）。而 Edge 不允许同一个 profile 同时开两个实例，
所以"不想重启现有窗口"就只能用另一个 `--user-data-dir` 开第二个实例——
看起来像另一个浏览器，而且**没有你的登录态**（公开视频仍可匿名看）。

想要一个窗口搞定，就选"关掉重启"那条路。

---

## 四、本地视频也能一起看

调试端口开着的话，**把本地文件拖进浏览器**就行：

```
source: browser-file → 记忆管理局 概念PV.mp4
watch 00:28 (browser, playing)
```

页面地址是 `file:///D:/...`，插件还原成本地路径直接当输入：
**不下载、不搜索、不问你要路径**，位置同样是毫秒级。

---

## 五、不用 AI 时会不会有开销

| 状态 | 开销 |
|---|---|
| DSH 没开 | **零**（插件不运行） |
| DSH 开着、没在陪看 | **零**（没有循环、没有轮询） |
| 陪看中 | 每 2 秒一次**本地**比较（纯算术）；每 15 秒读一次位置（CDP ≈20 ms，SMTC ≈1 s） |
| 浏览器带端口开着，但没在陪看 | 接近零（只是端口在监听，没有连接就没有流量） |

**会不会忘了关？** 不会一直转下去，有四个自动停：

```
视频播完        → 停（video-ended）
换片了          → 停（video-changed，等下一次重新开始）
读了 10 分钟没有可信位置 → 停（position-unreadable），中途会先问你一次
浏览器/SMTC 都没源 5 分钟 → 停（no-source）
```

想手动停：`video_watch({ stopLoop: true })`。

---

## 六、排查

```js
video_watch({ statusOnly: true })
```

返回里看两个字段：

- `confidence`：`browser`（最准）/ `fresh` / `extrapolated`（推算）/ `unknown` / `none`
- `reason`：为什么没说 —— `not-due` / `extrapolated-not-confirmed` / `paused` / `position-unknown` …

`confidence: smtc` 之外的 `extrapolated` 说明端口没开，正在靠推算。想稳就按第二节配一次。
