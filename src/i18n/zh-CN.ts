import type { MessageKey } from "./en";

/**
 * Simplified Chinese (zh-CN).
 *
 * Typed as `Partial` on purpose: a translation is allowed to lag behind
 * English, and any key missing here falls back to the English message rather
 * than blocking a change to the source language. Keys are checked against
 * `MessageKey`, so a stale or misspelled key is a build error.
 */
export const zhCN: Partial<Record<MessageKey, string>> = {
  "settings.appLanguage.label": "界面语言",
  "settings.appLanguage.title": "应用界面本身使用的语言",

  "controls.capture.capturing": "录制中",
  "controls.capture.starting": "启动中",
  "controls.capture.saving": "保存中",
  "controls.capture.discarding": "丢弃中",

  "controls.microphone.systemDefault": "系统默认",
  "controls.microphone.heading": "麦克风",
  "controls.microphone.choose": "选择麦克风",
  "controls.microphone.group": "音频输入",
  "controls.microphone.selected": "已选择",
  "controls.microphone.using": "正在使用 {device}",
  "controls.microphone.next": "下次使用：{device}",
  "controls.microphone.on": "开",
  "controls.microphone.off": "关",
  "controls.microphone.starting": "启动中",
  "controls.microphone.stopping": "停止中",
  "controls.microphone.retry": "重试",
  "controls.microphone.muteAria": "将 {device} 静音。旁白按{language}转写。",
  "controls.microphone.unmuteAria": "取消 {device} 静音，以{language}录制旁白",
  "controls.microphone.retryAria": "重试麦克风。{error}",
  "controls.microphone.muteTitle": "将 {device} 静音 · {language} 转写",
  "controls.microphone.unmuteTitle": "取消 {device} 静音 · {language} 转写",

  "controls.terminal.label": "终端",
  "controls.terminal.opening": "打开中",
  "controls.terminal.title": "打开一个仅随本次录制捕获的终端",
  "controls.terminal.openAria": "打开录制终端",
  "controls.terminal.focusAria": "聚焦录制终端。{state}",

  "controls.discard.action": "丢弃",
  "controls.discard.title": "要丢弃这段录制吗？",
  "controls.discard.description":
    "屏幕录像、活动记录、终端输出和语音片段都将被永久删除。",
  "controls.discard.keep": "继续录制",
  "controls.discard.confirm": "丢弃录制",
  "controls.discard.pending": "正在丢弃…",

  "controls.terminalConfirm.title": "仍有终端命令在运行",
  "controls.terminalConfirm.description":
    "关闭录制会终止该命令，并将其输出保存为「已中断」。",
  "controls.terminalConfirm.discard": "关闭终端并丢弃",
  "controls.terminalConfirm.save": "关闭终端并保存",

  "controls.done.action": "完成",
  "controls.done.pending": "正在保存…",

  "controls.error.microphoneChange": "无法更改麦克风状态。",
  "controls.error.microphoneSwitch": "无法切换麦克风设备。",
  "controls.error.stop": "无法停止录制。",
  "controls.error.discard": "无法丢弃录制。",
};
