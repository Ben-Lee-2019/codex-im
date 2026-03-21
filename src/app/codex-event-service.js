const codexMessageUtils = require("../infra/codex/message-utils");
const { formatFailureText } = require("../shared/error-text");
const subagentRuntime = require("../domain/subagent/subagent-service");

async function handleStopCommand(runtime, normalized) {
  const bindingKey = runtime.sessionStore.buildBindingKey(normalized);
  const workspaceRoot = runtime.resolveWorkspaceRootForBinding(bindingKey);
  const threadId = workspaceRoot ? runtime.resolveThreadIdForBinding(bindingKey, workspaceRoot) : null;
  const turnId = threadId ? runtime.activeTurnIdByThreadId.get(threadId) || null : null;

  if (!threadId) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: "当前会话还没有可停止的运行任务。",
    });
    return;
  }

  try {
    await runtime.codex.sendRequest("turn/cancel", {
      threadId,
      turnId,
    });
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: "已发送停止请求。",
    });
  } catch (error) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: formatFailureText("停止失败", error),
    });
  }
}

function handleCodexMessage(runtime, message) {
  if (typeof message?.method === "string") {
    console.log(`[codex-im] codex event ${message.method}`);
  }
  codexMessageUtils.trackRunningTurn(runtime.activeTurnIdByThreadId, message);
  codexMessageUtils.trackPendingApproval(runtime.pendingApprovalByThreadId, message);
  codexMessageUtils.trackRunKeyState(runtime.currentRunKeyByThreadId, runtime.activeTurnIdByThreadId, message);
  subagentRuntime.handleCodexLifecycleEvent(runtime, message);
  runtime.pruneRuntimeMapSizes();
  const outbound = codexMessageUtils.mapCodexMessageToImEvent(message);
  if (!outbound) {
    return;
  }

  const threadId = outbound.payload?.threadId || "";
  if (!outbound.payload.turnId) {
    outbound.payload.turnId = runtime.activeTurnIdByThreadId.get(threadId) || "";
  }
  const context = runtime.pendingChatContextByThreadId.get(threadId);
  if (context) {
    outbound.payload.chatId = context.chatId;
    outbound.payload.threadKey = context.threadKey;
  }

  if (codexMessageUtils.eventShouldClearPendingReaction(outbound)) {
    runtime.clearPendingReactionForThread(threadId).catch((error) => {
      console.error(`[codex-im] failed to clear pending reaction: ${error.message}`);
    });
  }

  const shouldCleanupThreadState = isTerminalTurnMessage(message);
  runtime.deliverToFeishu(outbound)
    .catch((error) => {
      console.error(`[codex-im] failed to deliver Feishu message: ${error.message}`);
    })
    .finally(() => {
      if (!shouldCleanupThreadState || !threadId) {
        return;
      }
      runtime.clearPendingReactionForThread(threadId).catch((error) => {
        console.error(`[codex-im] failed to clear pending reaction: ${error.message}`);
      });
      runtime.cleanupThreadRuntimeState(threadId);
    });
}

async function deliverToFeishu(runtime, event) {
  if (event.type === "im.agent_reply") {
    await runtime.upsertAssistantReplyCard({
      threadId: event.payload.threadId,
      turnId: event.payload.turnId,
      itemId: event.payload.itemId || "",
      chatId: event.payload.chatId,
      text: event.payload.text,
      textMode: event.payload.textMode || "replace",
      state: "streaming",
      deferFlush: !runtime.config.feishuStreamingOutput,
    });
    return;
  }

  if (event.type === "im.run_state") {
    if (event.payload.state === "streaming") {
      if (!runtime.config.feishuStreamingOutput) {
        return;
      }
      await runtime.upsertAssistantReplyCard({
        threadId: event.payload.threadId,
        turnId: event.payload.turnId,
        chatId: event.payload.chatId,
        state: "streaming",
      });
    } else if (event.payload.state === "completed") {
      await runtime.upsertAssistantReplyCard({
        threadId: event.payload.threadId,
        turnId: event.payload.turnId,
        chatId: event.payload.chatId,
        state: "completed",
      });
    } else if (event.payload.state === "failed") {
      await runtime.upsertAssistantReplyCard({
        threadId: event.payload.threadId,
        turnId: event.payload.turnId,
        chatId: event.payload.chatId,
        text: event.payload.text || "执行失败",
        textMode: "append",
        state: "failed",
      });
    }
    return;
  }

  if (event.type === "im.approval_request") {
    const approval = runtime.pendingApprovalByThreadId.get(event.payload.threadId);
    if (!approval) {
      return;
    }
    const autoApproved = await runtime.tryAutoApproveRequest(event.payload.threadId, approval);
    if (autoApproved) {
      return;
    }
    approval.chatId = event.payload.chatId || approval.chatId || "";
    approval.replyToMessageId = runtime.pendingChatContextByThreadId.get(event.payload.threadId)?.messageId || approval.replyToMessageId || "";
    const response = await runtime.sendInteractiveApprovalCard({
      chatId: approval.chatId,
      approval,
      replyToMessageId: approval.replyToMessageId || "",
    });
    const messageId = codexMessageUtils.extractCreatedMessageId(response);
    if (messageId) {
      approval.cardMessageId = messageId;
    }
  }
}

function isTerminalTurnMessage(message) {
  const method = typeof message?.method === "string" ? message.method : "";
  return method === "turn/completed" || method === "turn/failed" || method === "turn/cancelled";
}

module.exports = {
  deliverToFeishu,
  handleCodexMessage,
  handleStopCommand,
};
