/**
 * voice.js — 声音接口的对外门面。
 *
 * 这里**不放实现**，只转发两件本来就不相干的事：
 *
 *   speech-bus.js      说 Events 怎么发、谁在听、几个会出声（纯内存，无 I/O）
 *   voice-adapter.js   怎么按路径挂一个外部引擎（读配置、import、挂/卸）
 *
 * 为什么保留这个文件：调用方（watch-loop / watch-run / handler / chat / index 和一批测试）
 * 都从 `./voice.js` 取东西，门面留着就不用把一次结构调整扩散成一圈 import 改动。
 *
 * 想看设计动机（为什么引擎不在核心里），读 `speech-bus.js` 的文件头。
 */

export {
  SPEECH_EVENT_FIELDS,
  __resetSpeech,
  emitSpeech,
  lastSpeech,
  onSpeech,
  speechEvents,
  speechObservers,
  speechSubscribers,
} from './speech-bus.js';

export {
  attachConfiguredVoice,
  attachedAdapters,
  configuredVoiceAdapter,
  detachAdapters,
  loadVoiceAdapter,
} from './voice-adapter.js';
