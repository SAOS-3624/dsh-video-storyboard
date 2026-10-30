# TTS 与 video_watch 解耦建议

> 状态：设计提案，未实现；不改变当前行为。
> 关联 issue：#27

## 结论

建议解耦，但**不建议把 TTS 塞进另一个“大核心”**：

- video_watch 只负责播放位置、批次调度和**带时间戳的文字流**；
- TTS 作为可选适配器/插件，消费这条文字流，自己负责语音引擎、音色、播放和配置；
- 不把 TTS 变成 video_watch 的必选依赖，也不要求每个用户安装 edge-tts/ffplay。

本文只讨论 TTS 解耦；video_watch 整体是否拆成独立插件/仓库，另议。

## 现状

当前 video_watch 同时承担两件事：

1. 视频语义：读播放位置、维护批次、生成格子和台词；
2. 语音输出：tts: true 时由 src/tts.js 调 edge-tts 或 Windows SAPI，
   src/watch-loop.js 到点直接 speak()；speakAloud、listVoices、nextLine
   也都在同一个工具 schema 里。

这带来几个问题：

- **安装面变大**：只想看分镜/定位的用户，也会带上语音相关代码和平台分支；
- **CI 变复杂**：语音依赖本机 SAPI/ffplay，很多环境只能跳过；
- **边界不清**：视频工具的输出应该先是文字和 timing，音频播放是下游消费者；
- **难以替换引擎**：换 TTS 引擎会牵动 video_watch 的参数和生命周期。

好消息是时间戳文本已经存在：lines 里的 { from, at, text } 就是 TTS 真正需要的接口。

## 目标结构

~~~text
播放位置
   │
   ▼
video_watch（core）
   │  产出 TimedLine { segment, from, at, text }
   ├──────────────► 模型/用户可读文字
   │
   ▼
voice adapter（可选插件）
   │  订阅文字流，按 at 播放
   ▼
edge-tts / SAPI / 其他引擎
~~~

建议的职责边界：

| 层 | 负责 | 不负责 |
|---|---|---|
| core video_watch | 位置、批次、台词时间轴、文字输出 | 音频、音色、语音引擎 |
| voice adapter | 订阅台词、TTS、音量/语速、失败回退 | 视频抽帧、转写、批次调度 |
| host / OS | 播放位置、媒体会话、音频输出 | 视频语义 |

### 接口草案

具体传输方式可以再定：优先使用宿主 service/event；如果宿主能力不够，再让独立包依赖 core 的公开 API。关键是**不要通过模型 token 转发每一句台词**。

~~~js
// core 产出的最小结构
{
  segment: 3,
  from: 240,
  at: 263.5,
  text: "这一段的台词",
}
~~~

core 只需要保证：

- at 是相对播放时钟的秒数；
- 暂停/拖动后，迟到或重复的台词有明确处理；
- 一句台词最多投递一次（或者提供可去重的 id）；
- 不依赖 TTS 是否安装。

voice adapter 负责：

- 选择 edge-tts / SAPI / 其他引擎；
- 维护音色、语速、音量、失败回退；
- 在暂停/seek/退出时停止或重排；
- 自己的配置文件（例如沿用 ~/.dsh/tts.json 或迁移到自己的命名空间）。

## 用户 API 的变化

建议逐步演进，不一次性破坏：

- **core**：video_watch 保留 lines 输入结构（from/at/text），并把台词时间轴作为输出/事件暴露；
  移除或冻结 tts、speakAloud、listVoices、nextLine、voice、rate；
- **voice adapter**：提供独立入口，例如 video_narrate / dsh-video-tts（名字待定），
  订阅 core 的台词流并播放；
- 旧的 video_watch({ tts: true }) 在一个 minor 版本里保留兼容层，
  内部转发给 adapter；下个 major 再移除。

这样现有用户不会立刻坏，维护者也能先验证新边界。

## 迁移步骤

### Phase 0：只写契约

- 确定 TimedLine 事件/API；
- 明确暂停、seek、重复投递、退出时的语义；
- 不移动 src/tts.js，不改变行为。

### Phase 1：core 去语音化

- video_watch 不再直接调用 speak()；
- lifecycle/watch-loop 只发台词事件；
- TTS 实现移到可选包/同仓库子包；
- 旧的 tts 参数先保留，标记 deprecated。

### Phase 2：adapter 独立

- 独立包消费事件并播放；
- edge-tts/SAPI/ffplay 依赖只出现在 adapter；
- core 的 CI 不再需要音频环境；
- 配置、文档、安装说明拆开。

### Phase 3：清理

- 下个 major 移除 core 的 TTS 参数；
- 更新 docs/WATCH.zh.md 的 TTS 章节为“可选插件”说明；
- 保留迁移提示。

## 验收标准

- 不安装 TTS/音频依赖时，core 全部工具和测试正常；
- core 代码不再 import src/tts.js；
- 收到台词后，adapter 在 at 附近播放，暂停/seek 行为有测试；
- 同一句不重复、不丢失；
- 旧 tts: true 在兼容期内仍可用，且有 deprecation 提示；
- 文档明确“没有语音引擎时 core 仍然可用”。

## 风险 / 待定

- DSH 宿主的跨插件事件/service 能力是否足够；如果不够，独立包如何拿到 core 的会话？
- 后台 loop 的所有权：core 继续调度，还是 adapter 自己驱动？
- 新旧插件的版本兼容矩阵；
- 用户是否需要同时安装两个插件，安装体验是否变差；
- 是否把 video_watch 整体拆出去：这是另一个更大的决定，建议先完成 TTS 解耦再评估。

## 建议

先做**同仓库的可选 TTS 适配层**，验证事件接口和安装体验；稳定后再决定是否独立仓库。
不建议现在把整个 video_watch 和 TTS 一起大拆，否则重构和功能迭代会互相拖累。
