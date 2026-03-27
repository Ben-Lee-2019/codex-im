const { filterThreadsByWorkspaceRoot } = require("../../shared/workspace-paths");
const { extractSwitchThreadId } = require("../../shared/command-parsing");
const codexMessageUtils = require("../../infra/codex/message-utils");
const fs = require("fs");

const THREAD_SOURCE_KINDS = new Set([
  "app",
  "cli",
  "vscode",
  "exec",
  "appServer",
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
  "unknown",
]);

async function resolveWorkspaceThreadState(runtime, {
  bindingKey,
  workspaceRoot,
  normalized,
  autoSelectThread = true,
}) {
  const threads = await refreshWorkspaceThreads(runtime, bindingKey, workspaceRoot, normalized);
  const storedThreadId = runtime.resolveThreadIdForBinding(bindingKey, workspaceRoot);
  const selection = runtime.resolveConversationThreadSelection({
    threads,
    selectedThreadId: storedThreadId,
    reviewerMainThreadIdByReviewerThreadId: runtime.reviewerMainThreadIdByReviewerThreadId,
  });
  let selectedThreadId = selection.selectedThreadId;
  let threadId = autoSelectThread ? selection.threadId : selectedThreadId;
  const storedPlaceholderThread = storedThreadId
    ? threads.find((thread) => thread.id === storedThreadId && thread.isPlaceholder) || null
    : null;
  if (storedPlaceholderThread && !runtime.isReviewerThreadId(storedThreadId)) {
    const isFreshPlaceholder = runtime.freshThreadIds?.has(storedThreadId) === true;
    const placeholderIsReachable = isFreshPlaceholder || await probePlaceholderThread(runtime, storedThreadId);
    if (placeholderIsReachable) {
      selectedThreadId = storedThreadId;
      threadId = storedThreadId;
    } else {
      selectedThreadId = "";
      threadId = autoSelectThread ? "" : selectedThreadId;
    }
  }
  const hasVisibleStoredThread = !!storedThreadId && threads.some(
    (thread) => thread.id === storedThreadId && !thread.isPlaceholder
  );
  if (hasVisibleStoredThread && !runtime.isReviewerThreadId(storedThreadId)) {
    selectedThreadId = storedThreadId;
    threadId = storedThreadId;
  }
  if (storedThreadId && storedThreadId !== selectedThreadId) {
    if (selectedThreadId) {
      runtime.sessionStore.setThreadIdForWorkspace(
        bindingKey,
        workspaceRoot,
        selectedThreadId,
        codexMessageUtils.buildBindingMetadata(normalized)
      );
    } else {
      runtime.sessionStore.clearThreadIdForWorkspace(bindingKey, workspaceRoot);
    }
  }
  if (!selectedThreadId && threadId) {
    runtime.sessionStore.setThreadIdForWorkspace(
      bindingKey,
      workspaceRoot,
      threadId,
      codexMessageUtils.buildBindingMetadata(normalized)
    );
  }
  if (threadId) {
    runtime.setThreadBindingKey(threadId, bindingKey);
    runtime.setThreadWorkspaceRoot(threadId, workspaceRoot);
    const resolvedThread = threads.find((thread) => thread.id === threadId) || null;
    if (resolvedThread?.isPlaceholder) {
      runtime.placeholderThreadIds?.add(threadId);
    } else {
      runtime.placeholderThreadIds?.delete(threadId);
    }
  }
  appendThreadDebugLog({
    stage: "resolveWorkspaceThreadState",
    bindingKey,
    workspaceRoot,
    text: normalizeDebugText(normalized?.text),
    storedThreadId,
    threadIds: threads.map((thread) => thread.id),
    selectedThreadId,
    resolvedThreadId: threadId,
    hasVisibleStoredThread,
  });
  return { threads, threadId, selectedThreadId: selectedThreadId || threadId };
}

async function probePlaceholderThread(runtime, threadId) {
  const normalizedThreadId = typeof threadId === "string" ? threadId.trim() : "";
  if (!normalizedThreadId || typeof runtime.codex?.resumeThread !== "function") {
    return false;
  }

  try {
    const { response, sessionPath } = await resumeThreadWithSessionValidation(runtime, normalizedThreadId);
    appendThreadDebugLog({
      stage: "resolveWorkspaceThreadState:placeholder_probe_ok",
      threadId: normalizedThreadId,
      sessionPath,
    });
    return true;
  } catch (error) {
    appendThreadDebugLog({
      stage: "resolveWorkspaceThreadState:placeholder_probe_failed",
      threadId: normalizedThreadId,
      error: String(error?.message || error),
    });
    return false;
  }
}

async function ensureThreadAndSendMessage(runtime, {
  bindingKey,
  workspaceRoot,
  normalized,
  threadId,
  reviewSendOptions = {},
}) {
  const codexParams = runtime.getCodexParamsForWorkspace(bindingKey, workspaceRoot);
  const deliveryMode = resolveTurnDeliveryMode(normalized);

  if (!threadId) {
    appendThreadDebugLog({
      stage: "ensureThreadAndSendMessage:missing_thread",
      bindingKey,
      workspaceRoot,
      text: normalizeDebugText(normalized?.text),
      requestedThreadId: "",
    });
    throw new Error("当前会话没有已选中的 Codex 线程；不会自动新建。请先发送 `/codex new` 或 `/codex switch <threadId>`。");
  }

  try {
    appendThreadDebugLog({
      stage: "ensureThreadAndSendMessage:resume",
      bindingKey,
      workspaceRoot,
      text: normalizeDebugText(normalized?.text),
      requestedThreadId: threadId,
    });
    await runtime.refreshCodexClientIfThreadStale?.({ threadId });
    await ensureThreadResumed(runtime, threadId);
    if (reviewSendOptions.enableLongModeForMainThread) {
      await runtime.ensureLongModeForMainThread({
        bindingKey,
        workspaceRoot,
        mainThreadId: threadId,
      });
    }
    await prepareTurnDelivery(runtime, {
      bindingKey,
      workspaceRoot,
      threadId,
      normalized,
      deliveryMode,
    });
    try {
      const outgoingText = buildOutgoingUserText(normalized);
      await runtime.codex.sendUserMessage({
        threadId,
        text: outgoingText,
        model: codexParams.model || null,
        effort: codexParams.effort || null,
        accessMode: runtime.config.defaultCodexAccessMode,
        workspaceRoot,
      });
    } catch (error) {
      runtime.turnDeliveryModeByThreadId.delete(threadId);
      throw error;
    }
    runtime.recordAcceptedSend({
      bindingKey,
      workspaceRoot,
      threadId,
      normalized,
      reviewSendOptions,
    });
    runtime.clearThreadExternalUpdates?.(threadId);
    runtime.freshThreadIds?.delete(threadId);
    runtime.placeholderThreadIds?.delete(threadId);
    console.log(`[codex-im] turn/start ok workspace=${workspaceRoot} thread=${threadId}`);
    runtime.setThreadBindingKey(threadId, bindingKey);
    runtime.setThreadWorkspaceRoot(threadId, workspaceRoot);
    return threadId;
  } catch (error) {
    appendThreadDebugLog({
      stage: "ensureThreadAndSendMessage:error",
      bindingKey,
      workspaceRoot,
      text: normalizeDebugText(normalized?.text),
      requestedThreadId: threadId,
      error: String(error?.message || error),
    });
    runtime.turnDeliveryModeByThreadId.delete(threadId);
    throw error;
  }
}

async function prepareTurnDelivery(runtime, {
  bindingKey,
  workspaceRoot,
  threadId,
  normalized,
  deliveryMode,
}) {
  const normalizedThreadId = typeof threadId === "string" ? threadId.trim() : "";
  if (!bindingKey || !workspaceRoot || !normalizedThreadId) {
    return;
  }

  runtime.turnDeliveryModeByThreadId.set(normalizedThreadId, deliveryMode);
  if (deliveryMode === "live") {
    runtime.rememberFeishuPromptFingerprint({
      threadId: normalizedThreadId,
      text: normalized?.text || "",
    });
  }

  await runtime.primeSessionSyncCursor({
    bindingKey,
    workspaceRoot,
    threadId: normalizedThreadId,
    sessionPath: runtime.threadSessionPathByThreadId.get(normalizedThreadId) || "",
  });
}

function resolveTurnDeliveryMode(normalized) {
  return normalized?.provider === "feishu" ? "live" : "session";
}

function buildOutgoingUserText(normalized) {
  return typeof normalized?.text === "string" ? normalized.text : "";
}

async function createWorkspaceThread(runtime, { bindingKey, workspaceRoot, normalized }) {
  const response = await runtime.codex.startThread({
    cwd: workspaceRoot,
  });
  console.log(`[codex-im] thread/start ok workspace=${workspaceRoot}`);

  const resolvedThreadId = codexMessageUtils.extractThreadId(response);
  if (!resolvedThreadId) {
    throw new Error("thread/start did not return a thread id");
  }
  const sessionPath = codexMessageUtils.extractThreadPath(response);

  runtime.sessionStore.setThreadIdForWorkspace(
    bindingKey,
    workspaceRoot,
    resolvedThreadId,
    codexMessageUtils.buildBindingMetadata(normalized)
  );
  runtime.resumedThreadIds.add(resolvedThreadId);
  runtime.freshThreadIds?.add(resolvedThreadId);
  runtime.placeholderThreadIds?.add(resolvedThreadId);
  runtime.setPendingThreadContext(resolvedThreadId, normalized);
  runtime.setThreadBindingKey(resolvedThreadId, bindingKey);
  runtime.setThreadWorkspaceRoot(resolvedThreadId, workspaceRoot);
  if (sessionPath) {
    runtime.threadSessionPathByThreadId.set(resolvedThreadId, sessionPath);
  }
  return resolvedThreadId;
}

async function ensureThreadResumed(runtime, threadId) {
  const normalizedThreadId = typeof threadId === "string" ? threadId.trim() : "";
  if (!normalizedThreadId) {
    return null;
  }
  if (runtime.freshThreadIds?.has(normalizedThreadId) || runtime.placeholderThreadIds?.has(normalizedThreadId)) {
    return null;
  }

  const { response, sessionPath } = await resumeThreadWithSessionValidation(runtime, normalizedThreadId);
  console.log(`[codex-im] thread/resume ok thread=${normalizedThreadId}`);
  return response;
}

async function resumeThreadWithSessionValidation(runtime, threadId) {
  const normalizedThreadId = typeof threadId === "string" ? threadId.trim() : "";
  if (!normalizedThreadId) {
    return { response: null, sessionPath: "" };
  }

  let response = await runtime.codex.resumeThread({ threadId: normalizedThreadId });
  runtime.resumedThreadIds?.add(normalizedThreadId);
  let sessionPath = codexMessageUtils.extractThreadPath(response);
  if (sessionPath) {
    runtime.threadSessionPathByThreadId.set(normalizedThreadId, sessionPath);
  }

  const sanitized = sessionPath
    ? await sanitizeSessionFileIfNeeded(sessionPath, {
      threadId: normalizedThreadId,
    })
    : false;
  if (sanitized) {
    response = await runtime.codex.resumeThread({ threadId: normalizedThreadId });
    sessionPath = codexMessageUtils.extractThreadPath(response);
    if (sessionPath) {
      runtime.threadSessionPathByThreadId.set(normalizedThreadId, sessionPath);
    }
  }

  return { response, sessionPath };
}

async function handleNewCommand(runtime, normalized) {
  const bindingKey = runtime.sessionStore.buildBindingKey(normalized);
  const workspaceRoot = runtime.resolveWorkspaceRootForBinding(bindingKey);
  if (!workspaceRoot) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: "当前会话还未绑定项目。先发送 `/codex bind /绝对路径`。",
    });
    return;
  }

  try {
    const createdThreadId = await createWorkspaceThread(runtime, {
      bindingKey,
      workspaceRoot,
      normalized,
    });
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: `已创建新线程并切换到它:\n${workspaceRoot}\n\nthread: ${createdThreadId}`,
    });
  } catch (error) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: `创建新线程失败: ${error.message}`,
    });
  }
}

async function handleSwitchCommand(runtime, normalized) {
  const threadId = extractSwitchThreadId(normalized.text);
  if (!threadId) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: "用法: `/codex switch <threadId>`",
    });
    return;
  }

  await switchThreadById(runtime, normalized, threadId, { replyToMessageId: normalized.messageId });
}

async function refreshWorkspaceThreads(runtime, bindingKey, workspaceRoot, normalized) {
  try {
    const threads = await listCodexThreadsForWorkspace(runtime, workspaceRoot);
    const currentThreadId = runtime.sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
    if (!currentThreadId || threads.some((thread) => thread.id === currentThreadId)) {
      appendThreadDebugLog({
        stage: "refreshWorkspaceThreads:list",
        bindingKey,
        workspaceRoot,
        text: normalizeDebugText(normalized?.text),
        currentThreadId,
        threadIds: threads.map((thread) => thread.id),
      });
      return threads;
    }

    appendThreadDebugLog({
      stage: "refreshWorkspaceThreads:placeholder",
      bindingKey,
      workspaceRoot,
      text: normalizeDebugText(normalized?.text),
      currentThreadId,
      threadIds: threads.map((thread) => thread.id),
    });
    return [
      {
        id: currentThreadId,
        cwd: workspaceRoot,
        title: currentThreadId,
        createdAt: 0,
        updatedAt: 0,
        sourceKind: "unknown",
        parentThreadId: "",
        statusType: "unknown",
        path: runtime.threadSessionPathByThreadId.get(currentThreadId) || "",
        agentNickname: "",
        agentRole: "",
        isPlaceholder: true,
      },
      ...threads,
    ];
  } catch (error) {
    console.warn(`[codex-im] thread/list failed for workspace=${workspaceRoot}: ${error.message}`);
    const currentThreadId = runtime.sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
    appendThreadDebugLog({
      stage: "refreshWorkspaceThreads:error",
      bindingKey,
      workspaceRoot,
      text: normalizeDebugText(normalized?.text),
      currentThreadId,
      error: String(error?.message || error),
    });
    if (!currentThreadId) {
      return [];
    }
    return [{
      id: currentThreadId,
      cwd: workspaceRoot,
      title: currentThreadId,
      createdAt: 0,
      updatedAt: 0,
      sourceKind: "unknown",
      parentThreadId: "",
      statusType: "unknown",
      path: runtime.threadSessionPathByThreadId.get(currentThreadId) || "",
      agentNickname: "",
      agentRole: "",
      isPlaceholder: true,
    }];
  }
}

function appendThreadDebugLog(payload) {
  const logPath = "/tmp/codex-im-thread-debug.log";
  const record = {
    timestamp: new Date().toISOString(),
    ...payload,
  };
  try {
    fs.appendFileSync(logPath, `${JSON.stringify(record)}\n`);
  } catch {}
}

function normalizeDebugText(text) {
  const normalized = typeof text === "string" ? text.trim().replace(/\s+/g, " ") : "";
  return normalized.slice(0, 160);
}

async function sanitizeSessionFileIfNeeded(sessionPath, { threadId = "" } = {}) {
  const normalizedSessionPath = typeof sessionPath === "string" ? sessionPath.trim() : "";
  if (!normalizedSessionPath) {
    return false;
  }

  const raw = await fs.promises.readFile(normalizedSessionPath);
  const nulCount = countNulBytes(raw);
  if (!nulCount) {
    return false;
  }

  const sanitized = Buffer.from(raw.filter((byte) => byte !== 0));
  const tempPath = `${normalizedSessionPath}.sanitize-${process.pid}-${Date.now()}`;
  await fs.promises.writeFile(tempPath, sanitized);
  await fs.promises.rename(tempPath, normalizedSessionPath);
  appendThreadDebugLog({
    stage: "sanitizeSessionFileIfNeeded",
    threadId,
    sessionPath: normalizedSessionPath,
    nulCount,
    originalBytes: raw.length,
    sanitizedBytes: sanitized.length,
  });
  return true;
}

function countNulBytes(buffer) {
  if (!buffer || typeof buffer.length !== "number") {
    return 0;
  }
  let count = 0;
  for (const byte of buffer) {
    if (byte === 0) {
      count += 1;
    }
  }
  return count;
}

async function listCodexThreadsForWorkspace(runtime, workspaceRoot) {
  const allThreads = await listCodexThreadsPaginated(runtime);
  const sourceFiltered = allThreads.filter((thread) => isSupportedThreadSourceKind(thread?.sourceKind));
  return filterThreadsByWorkspaceRoot(sourceFiltered, workspaceRoot);
}

async function listCodexThreadsPaginated(runtime) {
  const allThreads = [];
  const seenThreadIds = new Set();
  let cursor = null;

  for (let page = 0; page < 10; page += 1) {
    const response = await runtime.codex.listThreads({
      cursor,
      limit: 200,
      sortKey: "updated_at",
    });
    const pageThreads = codexMessageUtils.extractThreadsFromListResponse(response);
    for (const thread of pageThreads) {
      if (seenThreadIds.has(thread.id)) {
        continue;
      }
      seenThreadIds.add(thread.id);
      allThreads.push(thread);
    }

    const nextCursor = codexMessageUtils.extractThreadListCursor(response);
    if (!nextCursor || nextCursor === cursor) {
      break;
    }
    cursor = nextCursor;
    if (pageThreads.length === 0) {
      break;
    }
  }

  return allThreads;
}

function describeWorkspaceStatus(runtime, threadId) {
  if (!threadId) {
    return { code: "idle", label: "空闲" };
  }
  if (runtime.pendingApprovalByThreadId.has(threadId)) {
    return { code: "approval", label: "等待授权" };
  }
  if (runtime.activeTurnIdByThreadId.has(threadId)) {
    return { code: "running", label: "运行中" };
  }
  return { code: "idle", label: "空闲" };
}

async function switchThreadById(runtime, normalized, threadId, { replyToMessageId } = {}) {
  const replyTarget = runtime.resolveReplyToMessageId(normalized, replyToMessageId);
  const { bindingKey, workspaceRoot } = runtime.getBindingContext(normalized);
  if (!workspaceRoot) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: replyTarget,
      text: "当前会话还未绑定项目。先发送 `/codex bind /绝对路径`。",
    });
    return;
  }

  const currentThreadId = runtime.resolveThreadIdForBinding(bindingKey, workspaceRoot);
  if (currentThreadId && currentThreadId === threadId) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: replyTarget,
      text: "已经是当前线程，无需切换。",
    });
    return;
  }

  const availableThreads = await refreshWorkspaceThreads(runtime, bindingKey, workspaceRoot, normalized);
  const selectedThread = availableThreads.find((thread) => thread.id === threadId) || null;
  if (!selectedThread) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: replyTarget,
      text: "指定线程当前不可用，请刷新后重试。",
    });
    return;
  }
  if (runtime.isReviewerThreadId(threadId)) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: replyTarget,
      text: "Reviewer 线程是只读的，可以查看记录，但不能切换成当前对话线程。",
    });
    return;
  }

  const resolvedWorkspaceRoot = selectedThread.cwd || workspaceRoot;
  runtime.sessionStore.setActiveWorkspaceRoot(bindingKey, resolvedWorkspaceRoot);
  runtime.sessionStore.setThreadIdForWorkspace(
    bindingKey,
    resolvedWorkspaceRoot,
    threadId,
    codexMessageUtils.buildBindingMetadata(normalized)
  );
  runtime.setThreadBindingKey(threadId, bindingKey);
  runtime.setThreadWorkspaceRoot(threadId, resolvedWorkspaceRoot);
  runtime.resumedThreadIds.delete(threadId);
  runtime.freshThreadIds?.delete(threadId);
  runtime.placeholderThreadIds?.delete(threadId);
  await ensureThreadResumed(runtime, threadId);
  await runtime.showStatusPanel(normalized, { replyToMessageId: replyTarget });
}

async function inspectThreadMessages(runtime, normalized, threadId, { replyToMessageId } = {}) {
  const replyTarget = runtime.resolveReplyToMessageId(normalized, replyToMessageId);
  const { bindingKey, workspaceRoot } = runtime.getBindingContext(normalized);
  if (!workspaceRoot) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: replyTarget,
      text: "当前会话还未绑定项目。先发送 `/codex bind /绝对路径`。",
    });
    return;
  }

  const threads = await refreshWorkspaceThreads(runtime, bindingKey, workspaceRoot, normalized);
  const targetThreadId = typeof threadId === "string" && threadId.trim()
    ? threadId.trim()
    : runtime.resolveThreadIdForBinding(bindingKey, workspaceRoot);
  if (!targetThreadId) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: replyTarget,
      text: `当前项目：\`${workspaceRoot}\`\n\n该项目还没有可查看的线程消息。`,
    });
    return;
  }

  const targetThread = threads.find((thread) => thread.id === targetThreadId) || { id: targetThreadId };
  runtime.resumedThreadIds.delete(targetThreadId);
  runtime.freshThreadIds?.delete(targetThreadId);
  runtime.placeholderThreadIds?.delete(targetThreadId);
  const resumeResponse = await runtime.codex.resumeThread({ threadId: targetThreadId });
  runtime.resumedThreadIds.add(targetThreadId);
  const recentMessages = codexMessageUtils.extractRecentConversationFromResumeResponse(resumeResponse);
  const displayThread = runtime.decorateThreadForDisplay(targetThread);

  await runtime.sendInfoCardMessage({
    chatId: normalized.chatId,
    replyToMessageId: replyTarget,
    text: runtime.buildThreadMessagesSummary({
      workspaceRoot,
      thread: displayThread,
      recentMessages,
    }),
  });
}

function isSupportedThreadSourceKind(sourceKind) {
  const normalized = typeof sourceKind === "string" && sourceKind.trim() ? sourceKind.trim() : "unknown";
  return THREAD_SOURCE_KINDS.has(normalized);
}

module.exports = {
  createWorkspaceThread,
  describeWorkspaceStatus,
  ensureThreadAndSendMessage,
  ensureThreadResumed,
  handleNewCommand,
  handleSwitchCommand,
  inspectThreadMessages,
  refreshWorkspaceThreads,
  resolveWorkspaceThreadState,
  switchThreadById,
};
