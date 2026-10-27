# 架构（V2）

**一份分析资产 · 两阶段视觉 · 三个工具**

## 外部工具（不变）

| 工具 | 职责 |
|---|---|
| `video_probe` | 容器头 + 读法建议（0 图 token） |
| `video_storyboard` | 总览 / 窗口 / `textOnly` 翻页 |
| `video_zoom` | 局部细看（`mode: temporal\|spatial`），优先切片父 VAA |

## 内部三阶段

```text
analyzeVideo  →  Video Analysis Asset（VAA）
planStoryboard →  StoryboardPlan（唯一时间轴真相）
renderStoryboard →  PNG（只解所需帧）
runStoryboard   →  编排门面（可注入 analysis）
```

### VAA

- probe / shots / audio / transcript / speech / fingerprints(aHash) / status / timing / cache_*
- 超长窗口（≥1h）：`scanShotsMaybeSampled` 抽样扫切点，标 `degraded`
- L1 磁盘缓存：`artifactKey({ kind })` 分 shots、audio、transcript；命中刷新 mtime（LRU）
- 进程内 `vaa-store`：同会话 zoom 切片复用

### 规划策略

- **`coverage`（默认）**：候选帧（切点+音频+台词+均匀）→ 评分 → 先时间桶覆盖，再显著性×时间/镜头/aHash 新颖性加密
- **`density`**：旧密度积分等分（兼容）

### Memory

- `buildEpisodeFromResult` → 与桌宠 `video_observation` episode 同形
- CLI `--episode out.json`
- Python：`storyboard_bridge`；`episode_write` 先落盘再 **异步** enrich（`async_enrich`，不堵观察 tick）
- 桌宠检测 `file://` / 播放器标题栏路径 → `session.local_path`；注入层可带出 `key_segments`

## 不做的事

- 不把每张宫格/每句 ASR 直接写入长期画像
- 不暴露 analyze/plan/render 为独立 DSH 工具（避免 Agent 管流程）
