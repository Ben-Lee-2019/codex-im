const PANEL_ACTION_CONFIG = Object.freeze({
  open_threads: Object.freeze({
    feedback: "正在打开线程列表...",
  }),
  new_thread: Object.freeze({
    feedback: "正在创建新线程...",
  }),
  show_messages: Object.freeze({
    feedback: "正在获取最近消息...",
  }),
  stop: Object.freeze({
    feedback: "正在发送停止请求...",
  }),
  status: Object.freeze({
    feedback: "正在刷新状态...",
  }),
  set_model: Object.freeze({
    command: "model",
    feedback: "正在设置模型...",
    missingValueText: "未读取到模型选择值，请重新选择。",
  }),
  set_effort: Object.freeze({
    command: "effort",
    feedback: "正在设置推理强度...",
    missingValueText: "未读取到推理强度选择值，请重新选择。",
  }),
});

const THREAD_ACTION_CONFIG = Object.freeze({
  switch: Object.freeze({
    feedback: "正在切换线程...",
    alreadyCurrentText: "已经是当前线程，无需切换。",
  }),
  inspect: Object.freeze({
    feedback: "正在获取线程消息...",
  }),
  messages: Object.freeze({
    feedback: "正在获取最近消息...",
    notCurrentText: "非当前线程，请先切换到该线程。",
  }),
});

const REPLY_ACTION_CONFIG = Object.freeze({
  show_full: Object.freeze({
    feedback: "",
    emptyText: "当前还没有可查看的完整输出，请稍后再试。",
  }),
});

const WORKSPACE_ACTION_CONFIG = Object.freeze({
  status: Object.freeze({
    feedback: "正在查看线程列表...",
  }),
  remove: Object.freeze({
    feedback: "正在移除项目...",
  }),
  switch: Object.freeze({
    feedback: "正在切换项目...",
    alreadyCurrentText: "已经是当前项目，无需切换。",
  }),
});

module.exports = {
  PANEL_ACTION_CONFIG,
  REPLY_ACTION_CONFIG,
  THREAD_ACTION_CONFIG,
  WORKSPACE_ACTION_CONFIG,
};
