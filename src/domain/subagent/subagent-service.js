const fs = require("fs");
const codexMessageUtils = require("../../infra/codex/message-utils");
const { formatFailureText } = require("../../shared/error-text");

const SUBAGENT_POLL_INTERVAL_MS = 1500;
const SUBAGENT_TERMINAL_GRACE_MS = 5000;
const THREAD_LIST_PAGE_LIMIT = 200;
const THREAD_LIST_MAX_PAGES = 10;
const SESSION_EVENT_GRACE_MS = 10 * 1000;
const SUBAGENT_DEBUG_LOG = process.env.CODEX_IM_SUBAGENT_LOG || "/tmp/codex-im-subagent.log";

function handleCodexLifecycleEvent(runtime, message) {
  const method = typeof message?.method === "string" ? message.method : "";
  const params = message?.params || {};
  const threadId = normalizeIdentifier(params?.threadId);
  const turnId = normalizeIdentifier(params?.turnId || params?.turn?.id);
  if (!threadId || !turnId) {
    return;
  }

  const hasParentContext = runtime.pendingChatContextByThreadId.has(threadId);
  if ((method === "turn/started" || method === "turn/start") && hasParentContext) {
    startTrackingForParentTurn(runtime, {
      parentThreadId: threadId,
      turnId,
    });
    return;
  }

  if (method === "turn/completed" || method === "turn/failed" || method === "turn/cancelled") {
    markParentTurnTerminal(runtime, threadId, turnId);
  }
}

function handleSubagentCardAction(runtime, action, normalized) {
  if (!action?.threadId) {
    return runtime.buildCardToast("未读取到子代理线程。");
  }
  if (action.action !== "view_detail") {
    return runtime.buildCardToast("未支持的子代理操作。");
  }

  runtime.runCardActionTask(showSubagentTranscript(runtime, normalized, action.threadId));
  return runtime.buildCardResponse({});
}

function startTrackingForParentTurn(runtime, { parentThreadId, turnId }) {
  const runKey = codexMessageUtils.buildRunKey(parentThreadId, turnId);
  if (runtime.subagentTrackerByRunKey.has(runKey)) {
    return;
  }

  const context = runtime.pendingChatContextByThreadId.get(parentThreadId);
  if (!context?.chatId) {
    return;
  }

  runtime.subagentTrackerByRunKey.set(runKey, {
    runKey,
    parentThreadId,
    turnId,
    chatId: context.chatId,
    replyToMessageId: context.messageId || "",
    startedAtMs: Date.now(),
    startedAtSec: Math.max(0, Math.floor(Date.now() / 1000) - 2),
    terminalSeenAtMs: 0,
    discoveredThreadIds: new Set(),
    processedSessionEventKeys: new Set(),
    sessionToolCallByCallId: new Map(),
    parentSessionPath: runtime.threadSessionPathByThreadId.get(parentThreadId) || "",
  });

  debugSubagent(`track start runKey=${runKey} parentThread=${parentThreadId}`);
  scheduleSubagentPoll(runtime, runKey, { immediate: true });
}

function markParentTurnTerminal(runtime, parentThreadId, turnId) {
  const runKey = codexMessageUtils.buildRunKey(parentThreadId, turnId);
  const tracker = runtime.subagentTrackerByRunKey.get(runKey);
  if (!tracker) {
    return;
  }
  if (!tracker.terminalSeenAtMs) {
    tracker.terminalSeenAtMs = Date.now();
  }
  runtime.subagentTrackerByRunKey.set(runKey, tracker);
  scheduleSubagentPoll(runtime, runKey, { immediate: true });
}

function scheduleSubagentPoll(runtime, runKey, { immediate = false } = {}) {
  clearSubagentPollTimer(runtime, runKey);
  if (immediate) {
    void runSubagentPoll(runtime, runKey);
    return;
  }

  const timer = setTimeout(() => {
    runtime.subagentPollTimerByRunKey.delete(runKey);
    void runSubagentPoll(runtime, runKey);
  }, SUBAGENT_POLL_INTERVAL_MS);
  runtime.subagentPollTimerByRunKey.set(runKey, timer);
}

async function runSubagentPoll(runtime, runKey) {
  try {
    await pollSubagents(runtime, runKey);
  } catch (error) {
    console.error(`[codex-im] subagent poll failed: ${error.message}`);
    debugSubagent(`poll failed runKey=${runKey} error=${error.stack || error.message}`);
    if (runtime.subagentTrackerByRunKey.has(runKey)) {
      scheduleSubagentPoll(runtime, runKey);
    }
  }
}

function clearSubagentPollTimer(runtime, runKey) {
  const timer = runtime.subagentPollTimerByRunKey.get(runKey);
  if (!timer) {
    return;
  }
  clearTimeout(timer);
  runtime.subagentPollTimerByRunKey.delete(runKey);
}

async function pollSubagents(runtime, runKey) {
  const tracker = runtime.subagentTrackerByRunKey.get(runKey);
  if (!tracker) {
    return;
  }

  debugSubagent(`poll runKey=${runKey}`);
  const handledFromSession = await syncSubagentsFromParentSession(runtime, tracker);
  if (!handledFromSession) {
    const threads = await listThreadsPaginated(runtime);
    const subagentThreads = [];
    for (const thread of threads) {
      if (!isSubagentSourceKind(thread?.sourceKind)) {
        continue;
      }

      const metadata = await resolveSubagentThreadMetadata(runtime, thread);
      if (!metadata.parentThreadId || metadata.parentThreadId !== tracker.parentThreadId) {
        continue;
      }
      if (Number(thread.createdAt || 0) && Number(thread.createdAt) < tracker.startedAtSec) {
        continue;
      }
      subagentThreads.push({
        ...thread,
        ...metadata,
      });
    }

    subagentThreads.sort((left, right) => {
      const leftTime = Number(left.createdAt || left.updatedAt || 0);
      const rightTime = Number(right.createdAt || right.updatedAt || 0);
      return leftTime - rightTime;
    });

    for (const thread of subagentThreads) {
      await syncSubagentThread(runtime, tracker, thread);
    }
  }

  if (shouldStopTracking(tracker)) {
    stopTracking(runtime, runKey);
    return;
  }

  scheduleSubagentPoll(runtime, runKey);
}

function shouldStopTracking(tracker) {
  if (!tracker?.terminalSeenAtMs) {
    return false;
  }
  return Date.now() - tracker.terminalSeenAtMs >= SUBAGENT_TERMINAL_GRACE_MS;
}

function stopTracking(runtime, runKey) {
  clearSubagentPollTimer(runtime, runKey);
  runtime.subagentTrackerByRunKey.delete(runKey);
}

async function syncSubagentThread(runtime, tracker, thread) {
  const existing = runtime.subagentCardByThreadId.get(thread.id) || null;
  const nextForkContext = resolveSubagentForkContext(thread.forkContext, existing?.forkContext);
  const detailMessages = appendDetailMessages(existing?.detailMessages, []);

  if (!existing) {
    const response = await runtime.sendInteractiveCard({
      chatId: tracker.chatId,
      replyToMessageId: tracker.replyToMessageId,
      card: runtime.buildSubagentStatusCard({
        thread,
        state: "created",
      }),
    });
    const messageId = codexMessageUtils.extractCreatedMessageId(response);
    runtime.subagentCardByThreadId.set(thread.id, {
      messageId,
      threadId: thread.id,
      parentRunKey: tracker.runKey,
      chatId: tracker.chatId,
      replyToMessageId: tracker.replyToMessageId,
      state: "created",
      lastUpdatedAt: Number(thread.updatedAt || 0),
      lastSummary: "",
      nickname: thread.agentNickname || "",
      role: thread.agentRole || "",
      path: thread.path || "",
      detailMessageId: "",
      historyMessages: [],
      detailMessages,
      transcriptMessages: [],
      forkContext: nextForkContext,
    });
  }

  tracker.discoveredThreadIds.add(thread.id);
  runtime.subagentTrackerByRunKey.set(tracker.runKey, tracker);

  const shouldInspectTranscript = thread.statusType !== "running" || !!tracker.terminalSeenAtMs;
  if (!shouldInspectTranscript) {
    return;
  }

  const transcript = await tryLoadSubagentTranscript(runtime, thread);
  if (!transcript?.isComplete) {
    return;
  }
  const cardState = runtime.subagentCardByThreadId.get(thread.id);
  if (!cardState?.messageId) {
    return;
  }

  const transcriptMessages = filterSubagentTranscriptMessages(
    normalizeConversationMessages(transcript.messages),
    detailMessages,
    { forkContext: nextForkContext }
  );
  const agentNickname = transcript.agentNickname || thread.agentNickname || cardState.nickname || "";
  const agentRole = transcript.agentRole || thread.agentRole || cardState.role || "";
  const summary = buildSubagentSummary(
    transcriptMessages.length ? transcriptMessages : detailMessages,
    {
      state: "completed",
      fallbackSummary: cardState.lastSummary || "",
    }
  );
  const shouldPatch = (
    cardState.state !== "completed"
    || cardState.lastSummary !== summary
    || Number(cardState.lastUpdatedAt || 0) !== Number(thread.updatedAt || 0)
  );
  if (shouldPatch) {
    const messageId = await patchOrResendSubagentStatusCard(runtime, {
      existingMessageId: cardState.messageId,
      chatId: cardState.chatId || tracker.chatId || "",
      replyToMessageId: cardState.replyToMessageId || tracker.replyToMessageId || "",
      card: runtime.buildSubagentStatusCard({
        thread: {
          ...thread,
          agentNickname,
          agentRole,
        },
        state: "completed",
        summary,
      }),
    });
    if (messageId) {
      cardState.messageId = messageId;
    }
  }

  const nextEntry = {
    ...cardState,
    state: "completed",
    lastUpdatedAt: Number(thread.updatedAt || 0),
    lastSummary: summary,
    nickname: agentNickname,
    role: agentRole,
    path: thread.path || cardState.path || "",
    detailMessages,
    transcriptMessages,
    forkContext: nextForkContext,
  };
  runtime.subagentCardByThreadId.set(thread.id, nextEntry);

  await syncOpenSubagentDetailCard(runtime, nextEntry, {
    state: "completed",
    messages: transcriptMessages.length ? transcriptMessages : detailMessages,
    agentNickname,
    agentRole,
    forkContext: nextForkContext,
  });
}

async function showSubagentTranscript(runtime, normalized, threadId) {
  const threadEntry = runtime.subagentCardByThreadId.get(threadId) || { threadId };
  const metadata = await resolveSubagentMetadataFromThreadId(runtime, threadId, threadEntry.path || "");
  const nextForkContext = resolveSubagentForkContext(metadata.forkContext, threadEntry.forkContext);
  const display = await loadSubagentDisplay(runtime, {
    id: threadId,
    agentNickname: metadata.agentNickname || threadEntry.nickname || "",
    agentRole: metadata.agentRole || threadEntry.role || "",
  }, {
    state: threadEntry.state || "",
    fallbackMessages: buildStoredSubagentMessages(threadEntry),
    fallbackSummary: threadEntry.lastSummary || "",
    requireComplete: false,
    forkContext: nextForkContext,
    explicitMessages: Array.isArray(threadEntry.detailMessages) ? threadEntry.detailMessages : [],
  });
  const messages = display.messages.length ? display.messages : buildFallbackDetailMessages(threadEntry);
  const nextEntry = {
    ...threadEntry,
    nickname: display.agentNickname || metadata.agentNickname || threadEntry.nickname || "",
    role: display.agentRole || metadata.agentRole || threadEntry.role || "",
    forkContext: nextForkContext,
    transcriptMessages: display.transcriptMessages.length
      ? display.transcriptMessages
      : Array.isArray(threadEntry.transcriptMessages) ? threadEntry.transcriptMessages : [],
  };
  const card = runtime.buildSubagentTranscriptCard({
    threadId,
    agentNickname: nextEntry.nickname,
    agentRole: nextEntry.role,
    state: threadEntry.state || "",
    messages,
    forkContext: nextForkContext,
  });

  if (nextEntry.detailMessageId) {
    await runtime.patchInteractiveCard({
      messageId: nextEntry.detailMessageId,
      card,
    });
    runtime.subagentCardByThreadId.set(threadId, nextEntry);
    return;
  }

  const response = await runtime.sendInteractiveCard({
    chatId: normalized.chatId,
    replyToMessageId: normalized.messageId,
    replyInThread: true,
    card,
  });
  runtime.subagentCardByThreadId.set(threadId, {
    ...nextEntry,
    detailMessageId: codexMessageUtils.extractCreatedMessageId(response) || "",
  });
}

async function syncSubagentsFromParentSession(runtime, tracker) {
  const sessionPath = await resolveParentSessionPath(runtime, tracker);
  if (!sessionPath) {
    debugSubagent(`session path missing runKey=${tracker.runKey}`);
    return false;
  }
  debugSubagent(`session path runKey=${tracker.runKey} path=${sessionPath}`);

  let raw;
  try {
    raw = await fs.promises.readFile(sessionPath, "utf8");
  } catch (error) {
    console.warn(`[codex-im] failed to read parent session ${sessionPath}: ${error.message}`);
    return false;
  }

  const lines = String(raw || "").split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    const record = parseJsonLine(line);
    if (!record || !isRelevantSessionRecord(record, tracker)) {
      continue;
    }

    const recordKey = buildSessionRecordKey(record);
    if (tracker.processedSessionEventKeys.has(recordKey)) {
      continue;
    }
    tracker.processedSessionEventKeys.add(recordKey);

    const toolCall = extractSessionToolCall(record);
    if (toolCall?.callId) {
      tracker.sessionToolCallByCallId.set(toolCall.callId, toolCall);

      const sendInputUpdate = extractSendInputUpdate(toolCall);
      if (sendInputUpdate) {
        await syncSessionBackedSubagent(runtime, tracker, sendInputUpdate);
      }
      continue;
    }

    const toolOutput = extractSessionToolOutput(record, tracker);
    if (toolOutput?.name === "spawn_agent") {
      const spawnUpdate = extractSpawnAgentUpdate(toolOutput);
      if (spawnUpdate) {
        await syncSessionBackedSubagent(runtime, tracker, spawnUpdate);
      }
      continue;
    }
    if (toolOutput?.name === "wait_agent") {
      const waitUpdates = extractWaitAgentUpdates(toolOutput);
      for (const waitUpdate of waitUpdates) {
        await syncSessionBackedSubagent(runtime, tracker, waitUpdate);
      }
      continue;
    }
    if (toolOutput?.name === "close_agent") {
      const closeUpdate = extractCloseAgentUpdate(toolOutput);
      if (closeUpdate) {
        await syncSessionBackedSubagent(runtime, tracker, closeUpdate);
      }
      continue;
    }

    const notification = extractSubagentNotification(record);
    if (!notification) {
      continue;
    }

    const normalizedStatus = normalizeNotificationStatus(notification.status);
    await syncSessionBackedSubagent(runtime, tracker, {
      id: notification.agentId,
      agentNickname: notification.nickname || "",
      agentRole: notification.role || "",
      state: normalizedStatus.state,
      summary: normalizedStatus.summary,
      historyText: normalizedStatus.historyText,
      detailEntries: normalizedStatus.historyText
        ? [{ role: "assistant", text: normalizedStatus.historyText }]
        : [],
    });
  }

  runtime.subagentTrackerByRunKey.set(tracker.runKey, tracker);
  return true;
}

async function resolveParentSessionPath(runtime, tracker) {
  const fromTracker = normalizeIdentifier(tracker?.parentSessionPath);
  if (fromTracker && await doesSessionPathBelongToThread(fromTracker, tracker.parentThreadId)) {
    return fromTracker;
  }
  if (fromTracker) {
    debugSubagent(`discard stale tracker session path runKey=${tracker.runKey} path=${fromTracker}`);
    tracker.parentSessionPath = "";
    runtime.subagentTrackerByRunKey.set(tracker.runKey, tracker);
  }
  const fromRuntime = normalizeIdentifier(runtime.threadSessionPathByThreadId.get(tracker.parentThreadId) || "");
  if (fromRuntime && await doesSessionPathBelongToThread(fromRuntime, tracker.parentThreadId)) {
    tracker.parentSessionPath = fromRuntime;
    runtime.subagentTrackerByRunKey.set(tracker.runKey, tracker);
    return fromRuntime;
  }
  if (fromRuntime) {
    debugSubagent(`discard stale runtime session path thread=${tracker.parentThreadId} path=${fromRuntime}`);
    runtime.threadSessionPathByThreadId.delete(tracker.parentThreadId);
  }

  try {
    const response = await runtime.codex.resumeThread({ threadId: tracker.parentThreadId });
    const resumedPath = codexMessageUtils.extractThreadPath(response);
    if (resumedPath && await doesSessionPathBelongToThread(resumedPath, tracker.parentThreadId)) {
      tracker.parentSessionPath = resumedPath;
      runtime.threadSessionPathByThreadId.set(tracker.parentThreadId, resumedPath);
      runtime.subagentTrackerByRunKey.set(tracker.runKey, tracker);
      return resumedPath;
    }
  } catch (error) {
    console.warn(`[codex-im] failed to recover parent session path for ${tracker.parentThreadId}: ${error.message}`);
  }

  return "";
}

async function doesSessionPathBelongToThread(sessionPath, threadId) {
  const normalizedPath = normalizeIdentifier(sessionPath);
  const normalizedThreadId = normalizeIdentifier(threadId);
  if (!normalizedPath || !normalizedThreadId) {
    return false;
  }

  if (normalizedPath.includes(normalizedThreadId)) {
    return true;
  }

  try {
    const fileHandle = await fs.promises.open(normalizedPath, "r");
    try {
      const buffer = Buffer.alloc(4096);
      const { bytesRead } = await fileHandle.read(buffer, 0, buffer.length, 0);
      const firstChunk = buffer.slice(0, bytesRead).toString("utf8");
      const firstLine = firstChunk.split(/\r?\n/, 1)[0] || "";
      const record = firstLine ? JSON.parse(firstLine) : null;
      return normalizeIdentifier(record?.payload?.id) === normalizedThreadId;
    } finally {
      await fileHandle.close();
    }
  } catch {
    return false;
  }
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function isRelevantSessionRecord(record, tracker) {
  const timestampMs = Date.parse(String(record?.timestamp || ""));
  if (!Number.isFinite(timestampMs)) {
    return false;
  }
  return timestampMs >= Math.max(0, tracker.startedAtMs - SESSION_EVENT_GRACE_MS);
}

function buildSessionRecordKey(record) {
  const payload = record?.payload || {};
  const text = Array.isArray(payload?.content) ? JSON.stringify(payload.content) : "";
  return [
    record?.timestamp || "",
    record?.type || "",
    payload?.type || "",
    payload?.call_id || "",
    payload?.name || "",
    text,
    payload?.output || "",
  ].join("|");
}

function extractSessionToolCall(record) {
  const payload = record?.payload || {};
  if (payload?.type !== "function_call") {
    return null;
  }
  const callId = normalizeIdentifier(payload.call_id);
  const name = normalizeIdentifier(payload.name);
  if (!callId || !name) {
    return null;
  }
  return {
    callId,
    name,
    args: parseToolArguments(payload.arguments),
  };
}

function extractSessionToolOutput(record, tracker) {
  const payload = record?.payload || {};
  if (payload?.type !== "function_call_output") {
    return null;
  }
  const callId = normalizeIdentifier(payload.call_id);
  if (!callId) {
    return null;
  }
  const toolCall = tracker?.sessionToolCallByCallId?.get(callId);
  return {
    callId,
    name: normalizeIdentifier(toolCall?.name),
    args: toolCall?.args || {},
    output: typeof payload.output === "string" ? payload.output : "",
  };
}

function parseToolArguments(rawArguments) {
  if (typeof rawArguments !== "string" || !rawArguments.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(rawArguments);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function extractSpawnAgentUpdate(toolOutput) {
  const parsed = parseToolOutputJson(toolOutput?.output);
  const agentId = normalizeIdentifier(parsed?.agent_id);
  if (!agentId) {
    return null;
  }

  const nickname = normalizeIdentifier(parsed?.nickname);
  const prompt = extractToolCallText(toolOutput?.args);
  return {
    id: agentId,
    agentNickname: nickname,
    agentRole: normalizeIdentifier(toolOutput?.args?.agent_type),
    state: "created",
    forkContext: toolOutput?.args?.fork_context === true,
    summary: "",
    historyEntries: prompt
      ? [{ role: "user", text: prompt }]
      : [{
        role: "assistant",
        text: nickname ? `已创建子代理 ${nickname}。` : `已创建子代理 ${agentId}。`,
      }],
    detailEntries: prompt ? [{ role: "user", text: prompt }] : [],
  };
}

function extractSendInputUpdate(toolCall) {
  if (toolCall?.name !== "send_input") {
    return null;
  }
  const agentId = normalizeIdentifier(toolCall?.args?.id);
  const messageText = extractToolCallText(toolCall?.args);
  if (!agentId || !messageText) {
    return null;
  }
  return {
    id: agentId,
    state: "running",
    summary: "",
    historyEntries: [{ role: "user", text: messageText }],
    detailEntries: [{ role: "user", text: messageText }],
  };
}

function extractWaitAgentUpdates(toolOutput) {
  const parsed = parseToolOutputJson(toolOutput?.output);
  const statuses = parsed?.status;
  if (!statuses || typeof statuses !== "object") {
    return [];
  }

  return Object.entries(statuses)
    .map(([rawAgentId, status]) => {
      const agentId = normalizeIdentifier(rawAgentId);
      if (!agentId) {
        return null;
      }
      const normalizedStatus = normalizeNotificationStatus(status);
      return {
        id: agentId,
        state: normalizedStatus.state,
        summary: normalizedStatus.summary,
        historyEntries: normalizedStatus.historyText
          ? [{ role: "assistant", text: normalizedStatus.historyText }]
          : [],
        detailEntries: normalizedStatus.historyText
          ? [{ role: "assistant", text: normalizedStatus.historyText }]
          : [],
      };
    })
    .filter(Boolean);
}

function extractCloseAgentUpdate(toolOutput) {
  const agentId = normalizeIdentifier(toolOutput?.args?.id);
  if (!agentId) {
    return null;
  }
  return {
    id: agentId,
    state: "shutdown",
    summary: "",
    historyEntries: [{ role: "assistant", text: "子代理已关闭。" }],
    detailEntries: [{ role: "assistant", text: "子代理已关闭。" }],
  };
}

function parseToolOutputJson(rawOutput) {
  if (typeof rawOutput !== "string" || !rawOutput.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(rawOutput);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function extractToolCallText(args) {
  const directText = normalizeIdentifier(args?.message);
  const itemTexts = Array.isArray(args?.items)
    ? args.items
      .map((item) => (
        normalizeIdentifier(item?.text)
        || normalizeIdentifier(item?.name)
        || normalizeIdentifier(item?.path)
      ))
      .filter(Boolean)
    : [];
  return [directText, ...itemTexts].filter(Boolean).join("\n\n");
}

function extractSubagentNotification(record) {
  const payload = record?.payload || {};
  if (payload?.type !== "message" || payload?.role !== "user") {
    return null;
  }
  const content = Array.isArray(payload?.content) ? payload.content : [];
  const text = content
    .map((entry) => normalizeIdentifier(entry?.text))
    .find((value) => value.includes("<subagent_notification>")) || "";
  if (!text.includes("<subagent_notification>")) {
    return null;
  }

  const match = text.match(/<subagent_notification>\s*([\s\S]*?)\s*<\/subagent_notification>/);
  if (!match) {
    return null;
  }

  try {
    const parsed = JSON.parse(match[1]);
    const agentId = normalizeIdentifier(parsed?.agent_id);
    if (!agentId) {
      return null;
    }
    return {
      agentId,
      status: parsed?.status,
      nickname: normalizeIdentifier(parsed?.nickname),
      role: normalizeIdentifier(parsed?.role),
    };
  } catch {
    return null;
  }
}

function normalizeNotificationStatus(status) {
  if (typeof status === "string") {
    if (status.trim().toLowerCase() === "shutdown") {
      return {
        state: "shutdown",
        summary: "",
        historyText: "子代理已关闭。",
      };
    }
    return {
      state: "running",
      summary: "",
      historyText: `子代理状态更新：${status.trim()}`,
    };
  }

  const normalized = status && typeof status === "object" ? status : {};
  if (typeof normalized.completed === "string" && normalized.completed.trim()) {
    return {
      state: "completed",
      summary: normalized.completed.trim(),
      historyText: normalized.completed.trim(),
    };
  }
  if (typeof normalized.errored === "string" && normalized.errored.trim()) {
    return {
      state: "errored",
      summary: normalized.errored.trim(),
      historyText: `执行失败：${normalized.errored.trim()}`,
    };
  }

  return {
    state: "running",
    summary: "",
    historyText: "子代理状态已更新。",
  };
}

async function syncSessionBackedSubagent(runtime, tracker, subagent) {
  const existing = runtime.subagentCardByThreadId.get(subagent.id) || null;
  const historyMessages = appendHistoryEntries(existing?.historyMessages, buildHistoryEntries(subagent));
  const detailMessages = appendDetailMessages(existing?.detailMessages, buildDetailEntries(subagent));
  const nextState = chooseSessionBackedState(existing?.state, subagent.state);
  const nextForkContext = resolveSubagentForkContext(subagent.forkContext, existing?.forkContext);
  const threadLike = {
    id: subagent.id,
    agentNickname: subagent.agentNickname || existing?.nickname || "",
    agentRole: subagent.agentRole || existing?.role || "",
    forkContext: nextForkContext,
  };
  const fallbackDisplay = {
    agentNickname: threadLike.agentNickname,
    agentRole: threadLike.agentRole,
    messages: normalizeConversationMessages(detailMessages),
    transcriptMessages: Array.isArray(existing?.transcriptMessages) ? existing.transcriptMessages : [],
    summary: buildSubagentSummary(historyMessages, {
      state: nextState,
      fallbackSummary: subagent.summary || existing?.lastSummary || "",
    }),
  };
  const shouldLoadTranscript = nextState === "completed" || nextState === "errored" || nextState === "shutdown";
  const resolvedDisplay = shouldLoadTranscript
    ? await loadSubagentDisplay(runtime, threadLike, {
      state: nextState,
      fallbackMessages: detailMessages,
      fallbackSummary: subagent.summary || existing?.lastSummary || "",
      requireComplete: false,
      forkContext: nextForkContext,
      explicitMessages: detailMessages,
    })
    : fallbackDisplay;
  const display = {
    agentNickname: resolvedDisplay.agentNickname || fallbackDisplay.agentNickname,
    agentRole: resolvedDisplay.agentRole || fallbackDisplay.agentRole,
    messages: resolvedDisplay.messages.length ? resolvedDisplay.messages : fallbackDisplay.messages,
    transcriptMessages: resolvedDisplay.transcriptMessages.length
      ? resolvedDisplay.transcriptMessages
      : fallbackDisplay.transcriptMessages,
    summary: resolvedDisplay.summary || fallbackDisplay.summary,
  };
  const nextSummary = display.summary;
  const transcriptMessages = display.transcriptMessages.length
    ? display.transcriptMessages
    : Array.isArray(existing?.transcriptMessages) ? existing.transcriptMessages : [];
  const nextNickname = display.agentNickname || threadLike.agentNickname;
  const nextRole = display.agentRole || threadLike.agentRole;
  const nextThreadLike = {
    ...threadLike,
    agentNickname: nextNickname,
    agentRole: nextRole,
  };

  if (!existing) {
    const response = await runtime.sendInteractiveCard({
      chatId: tracker.chatId,
      replyToMessageId: tracker.replyToMessageId,
      card: runtime.buildSubagentStatusCard({
        thread: nextThreadLike,
        state: nextState,
        summary: nextSummary,
      }),
    });
    runtime.subagentCardByThreadId.set(subagent.id, {
      messageId: codexMessageUtils.extractCreatedMessageId(response),
      threadId: subagent.id,
      parentRunKey: tracker.runKey,
      chatId: tracker.chatId,
      replyToMessageId: tracker.replyToMessageId,
      state: nextState,
      lastUpdatedAt: Date.now(),
      lastSummary: nextSummary,
      nickname: nextNickname,
      role: nextRole,
      path: "",
      source: "session",
      historyMessages,
      detailMessages,
      transcriptMessages,
      forkContext: nextForkContext,
      detailMessageId: "",
    });
    return;
  }

  const shouldPatch = (
    existing.state !== nextState
    || existing.lastSummary !== nextSummary
    || historyMessages.length !== (existing.historyMessages || []).length
    || existing.nickname !== nextNickname
    || existing.role !== nextRole
  );
  if (shouldPatch && existing.messageId) {
    const messageId = await patchOrResendSubagentStatusCard(runtime, {
      existingMessageId: existing.messageId,
      chatId: existing.chatId || tracker.chatId || "",
      replyToMessageId: existing.replyToMessageId || tracker.replyToMessageId || "",
      card: runtime.buildSubagentStatusCard({
        thread: nextThreadLike,
        state: nextState,
        summary: nextSummary,
      }),
    });
    if (messageId) {
      existing.messageId = messageId;
    }
  }

  const nextEntry = {
    ...existing,
    state: nextState,
    lastUpdatedAt: Date.now(),
    lastSummary: nextSummary,
    nickname: nextNickname,
    role: nextRole,
    source: "session",
    historyMessages,
    detailMessages,
    transcriptMessages,
    forkContext: nextForkContext,
  };
  runtime.subagentCardByThreadId.set(subagent.id, nextEntry);

  await syncOpenSubagentDetailCard(runtime, nextEntry, {
    state: nextState,
    messages: display.messages.length ? display.messages : buildFallbackDetailMessages(nextEntry),
    agentNickname: nextNickname,
    agentRole: nextRole,
    forkContext: nextForkContext,
  });
}

function buildHistoryEntries(subagent) {
  if (Array.isArray(subagent?.historyEntries)) {
    return subagent.historyEntries;
  }
  const normalizedText = normalizeIdentifier(subagent?.historyText);
  if (!normalizedText) {
    return [];
  }
  return [{ role: "assistant", text: normalizedText }];
}

function buildDetailEntries(subagent) {
  if (Array.isArray(subagent?.detailEntries)) {
    return subagent.detailEntries;
  }
  return buildHistoryEntries(subagent);
}

function appendHistoryEntries(historyMessages, entries) {
  const next = normalizeConversationMessages(historyMessages);
  const normalizedEntries = normalizeConversationMessages(entries);
  if (!normalizedEntries.length) {
    return next;
  }

  for (const entry of normalizedEntries) {
    const previous = next[next.length - 1];
    if (previous?.role === entry.role && previous?.text === entry.text) {
      continue;
    }
    next.push(entry);
  }
  return next;
}

function appendDetailMessages(detailMessages, entries) {
  return appendHistoryEntries(detailMessages, entries);
}

function chooseSessionBackedState(previousState, nextState) {
  const previous = normalizeIdentifier(previousState).toLowerCase();
  const next = normalizeIdentifier(nextState).toLowerCase();
  if (!next) {
    return previous || "created";
  }
  if ((previous === "completed" || previous === "errored") && next === "shutdown") {
    return previous;
  }
  return next;
}

function buildFallbackDetailMessages(threadEntry) {
  const summary = normalizeIdentifier(threadEntry?.lastSummary);
  if (summary) {
    return [{ role: "assistant", text: summary }];
  }
  const state = normalizeIdentifier(threadEntry?.state).toLowerCase();
  if (state === "shutdown") {
    return [{ role: "assistant", text: "子代理已关闭。" }];
  }
  if (state === "errored") {
    return [{ role: "assistant", text: "子代理执行失败。" }];
  }
  return [{ role: "assistant", text: "暂无可显示的子代理详情。" }];
}

async function loadSubagentTranscript(runtime, thread) {
  const response = await runtime.codex.resumeThread({ threadId: thread.id });
  const resumedThread = response?.result?.thread || {};
  const turns = Array.isArray(resumedThread?.turns) ? resumedThread.turns : [];
  const lastTurn = turns[turns.length - 1] || null;
  const threadStatusType = normalizeIdentifier(resumedThread?.status?.type).toLowerCase();
  const lastTurnStatus = normalizeIdentifier(lastTurn?.status).toLowerCase();
  const isComplete = (
    threadStatusType === "idle"
    || lastTurnStatus === "completed"
    || lastTurnStatus === "failed"
    || lastTurnStatus === "cancelled"
  );
  return {
    agentNickname: normalizeIdentifier(resumedThread.agentNickname) || normalizeIdentifier(thread.agentNickname),
    agentRole: normalizeIdentifier(resumedThread.agentRole) || normalizeIdentifier(thread.agentRole),
    isComplete,
    messages: codexMessageUtils.extractConversationFromResumeResponse(response, {
      turnLimit: Infinity,
    }),
  };
}

async function tryLoadSubagentTranscript(runtime, thread) {
  try {
    return await loadSubagentTranscript(runtime, thread);
  } catch (error) {
    console.warn(`[codex-im] failed to load subagent transcript ${thread?.id || "-"}: ${error.message}`);
    return null;
  }
}

async function loadSubagentDisplay(runtime, thread, {
  state = "",
  fallbackMessages = [],
  fallbackSummary = "",
  requireComplete = false,
  forkContext = false,
  explicitMessages = [],
} = {}) {
  const transcript = await tryLoadSubagentTranscript(runtime, thread);
  const transcriptMessages = filterSubagentTranscriptMessages(
    normalizeConversationMessages(transcript?.messages),
    explicitMessages,
    { forkContext }
  );
  const canUseTranscript = transcriptMessages.length > 0 && (!requireComplete || !!transcript?.isComplete);
  const messages = canUseTranscript
    ? transcriptMessages
    : normalizeConversationMessages(fallbackMessages);

  return {
    agentNickname: normalizeIdentifier(transcript?.agentNickname || thread?.agentNickname),
    agentRole: normalizeIdentifier(transcript?.agentRole || thread?.agentRole),
    messages,
    transcriptMessages,
    summary: buildSubagentSummary(messages, { state, fallbackSummary }),
  };
}

async function syncOpenSubagentDetailCard(runtime, threadEntry, detail) {
  if (!threadEntry?.detailMessageId || !detail) {
    return;
  }
  try {
    await runtime.patchInteractiveCard({
      messageId: threadEntry.detailMessageId,
      card: runtime.buildSubagentTranscriptCard({
        threadId: threadEntry.threadId || "",
        agentNickname: detail.agentNickname || threadEntry.nickname || "",
        agentRole: detail.agentRole || threadEntry.role || "",
        state: detail.state || threadEntry.state || "",
        forkContext: detail.forkContext === true || threadEntry.forkContext === true,
        messages: Array.isArray(detail.messages) && detail.messages.length
          ? detail.messages
          : buildFallbackDetailMessages(threadEntry),
      }),
    });
  } catch (error) {
    console.warn(`[codex-im] failed to patch subagent detail card ${threadEntry.threadId || "-"}: ${error.message}`);
  }
}

function buildStoredSubagentMessages(threadEntry) {
  if (Array.isArray(threadEntry?.transcriptMessages) && threadEntry.transcriptMessages.length) {
    return threadEntry.transcriptMessages;
  }
  if (Array.isArray(threadEntry?.detailMessages) && threadEntry.detailMessages.length) {
    return threadEntry.detailMessages;
  }
  if (Array.isArray(threadEntry?.historyMessages) && threadEntry.historyMessages.length) {
    return threadEntry.historyMessages;
  }
  return [];
}

function filterSubagentTranscriptMessages(transcriptMessages, explicitMessages, { forkContext = false } = {}) {
  const normalizedTranscriptMessages = normalizeConversationMessages(transcriptMessages);
  if (!forkContext) {
    return normalizedTranscriptMessages;
  }

  const normalizedExplicitMessages = normalizeConversationMessages(explicitMessages);
  const firstExplicitUserText = normalizedExplicitMessages.find((message) => message.role === "user")?.text || "";
  if (!firstExplicitUserText) {
    return [];
  }

  const anchorIndex = normalizedTranscriptMessages.findIndex((message) => (
    message.role === "user" && message.text === firstExplicitUserText
  ));
  if (anchorIndex < 0) {
    return [];
  }

  return normalizedTranscriptMessages.slice(anchorIndex);
}

function resolveSubagentForkContext(nextValue, previousValue = false) {
  if (nextValue === true) {
    return true;
  }
  if (previousValue === true) {
    return true;
  }
  if (nextValue === false) {
    return false;
  }
  return false;
}

function buildSubagentSummary(messages, { state = "", fallbackSummary = "" } = {}) {
  const summaryMessages = selectSummaryMessages(messages);
  if (summaryMessages.length) {
    return summaryMessages
      .slice(-4)
      .map((message) => {
        const label = message.role === "assistant" ? "**子代理回复**" : "**主代理指令**";
        const limit = message.role === "assistant" ? 140 : 220;
        return `${label}：${truncateText(message.text, limit)}`;
      })
      .join("\n");
  }

  const fallback = normalizeIdentifier(fallbackSummary);
  if (fallback) {
    return truncateText(fallback, 600);
  }

  const normalizedState = normalizeIdentifier(state).toLowerCase();
  if (normalizedState === "created" || normalizedState === "running") {
    return "";
  }
  if (normalizedState === "errored") {
    return "子代理执行失败。";
  }
  if (normalizedState === "shutdown") {
    return "子代理已关闭。";
  }
  return "子代理已完成。";
}

function selectSummaryMessages(messages) {
  const normalizedMessages = normalizeConversationMessages(messages);
  const meaningful = normalizedMessages.filter((message) => !isSubagentMetaMessage(message));
  return meaningful.length ? meaningful : normalizedMessages;
}

function normalizeConversationMessages(messages) {
  if (!Array.isArray(messages)) {
    return [];
  }
  return messages
    .map((message) => {
      const role = message?.role === "assistant" ? "assistant" : "user";
      const text = normalizeIdentifier(message?.text);
      if (!text) {
        return null;
      }
      return { role, text };
    })
    .filter(Boolean);
}

function isSubagentMetaMessage(message) {
  if (message?.role !== "assistant") {
    return false;
  }
  const text = normalizeIdentifier(message?.text);
  if (!text) {
    return false;
  }
  return (
    text.startsWith("已创建子代理 ")
    || text.startsWith("子代理状态更新：")
    || text === "子代理状态已更新。"
    || text === "子代理已关闭。"
  );
}

async function listThreadsPaginated(runtime) {
  const allThreads = [];
  const seenThreadIds = new Set();
  let cursor = null;

  for (let page = 0; page < THREAD_LIST_MAX_PAGES; page += 1) {
    const response = await runtime.codex.listThreads({
      cursor,
      limit: THREAD_LIST_PAGE_LIMIT,
      sortKey: "updated_at",
    });
    const pageThreads = codexMessageUtils.extractThreadsFromListResponse(response);
    for (const thread of pageThreads) {
      if (!thread?.id || seenThreadIds.has(thread.id)) {
        continue;
      }
      seenThreadIds.add(thread.id);
      allThreads.push(thread);
    }

    const nextCursor = codexMessageUtils.extractThreadListCursor(response);
    if (!nextCursor || nextCursor === cursor || pageThreads.length === 0) {
      break;
    }
    cursor = nextCursor;
  }

  return allThreads;
}

function isSubagentSourceKind(sourceKind) {
  const normalized = normalizeIdentifier(sourceKind).toLowerCase();
  return normalized.startsWith("subagent");
}

async function resolveSubagentThreadMetadata(runtime, thread) {
  if (thread.parentThreadId && (thread.agentNickname || thread.agentRole || typeof thread.forkContext === "boolean")) {
    return {
      parentThreadId: thread.parentThreadId,
      agentNickname: thread.agentNickname || "",
      agentRole: thread.agentRole || "",
      forkContext: thread.forkContext === true,
      path: thread.path || "",
    };
  }
  return resolveSubagentMetadataFromThreadId(runtime, thread.id, thread.path || "");
}

async function resolveSubagentMetadataFromThreadId(runtime, threadId, sessionPath = "") {
  const cached = runtime.subagentMetadataByThreadId.get(threadId);
  if (cached && (cached.parentThreadId || cached.agentNickname || cached.agentRole || !sessionPath)) {
    return cached;
  }

  const parsed = sessionPath
    ? await readSubagentSessionMeta(runtime, sessionPath)
    : { parentThreadId: "", agentNickname: "", agentRole: "", forkContext: false, path: sessionPath };
  runtime.subagentMetadataByThreadId.set(threadId, parsed);
  return parsed;
}

async function readSubagentSessionMeta(runtime, sessionPath) {
  const normalizedPath = normalizeIdentifier(sessionPath);
  if (!normalizedPath) {
    return {
      parentThreadId: "",
      agentNickname: "",
      agentRole: "",
      forkContext: false,
      path: "",
    };
  }

  const cached = runtime.subagentSessionMetaByPath.get(normalizedPath);
  if (cached) {
    return cached;
  }

  try {
    const raw = await fs.promises.readFile(normalizedPath, "utf8");
    const firstLine = String(raw || "").split(/\r?\n/, 1)[0] || "";
    const parsed = firstLine ? JSON.parse(firstLine) : null;
    const payload = parsed?.payload || {};
    const source = payload?.source || {};
    const threadSpawn = source?.subagent?.thread_spawn || source?.subAgent?.thread_spawn || {};
    const meta = {
      parentThreadId: normalizeIdentifier(threadSpawn.parent_thread_id),
      agentNickname: normalizeIdentifier(payload.agent_nickname || threadSpawn.agent_nickname),
      agentRole: normalizeIdentifier(payload.agent_role || threadSpawn.agent_role),
      forkContext: normalizeIdentifier(payload.forked_from_id).length > 0,
      path: normalizedPath,
    };
    runtime.subagentSessionMetaByPath.set(normalizedPath, meta);
    return meta;
  } catch (error) {
    console.warn(`[codex-im] failed to read subagent session meta ${normalizedPath}: ${error.message}`);
    const fallback = {
      parentThreadId: "",
      agentNickname: "",
      agentRole: "",
      forkContext: false,
      path: normalizedPath,
    };
    runtime.subagentSessionMetaByPath.set(normalizedPath, fallback);
    return fallback;
  }
}

async function patchOrResendSubagentStatusCard(runtime, {
  existingMessageId = "",
  chatId = "",
  replyToMessageId = "",
  card,
}) {
  if (!card) {
    return existingMessageId || "";
  }

  if (existingMessageId) {
    try {
      await runtime.patchInteractiveCard({
        messageId: existingMessageId,
        card,
      });
      return existingMessageId;
    } catch (error) {
      console.warn(`[codex-im] failed to patch subagent status card ${existingMessageId}: ${error.message}`);
    }
  }

  if (!chatId) {
    return existingMessageId || "";
  }

  try {
    const response = await runtime.sendInteractiveCard({
      chatId,
      replyToMessageId,
      card,
    });
    return codexMessageUtils.extractCreatedMessageId(response) || existingMessageId || "";
  } catch (error) {
    console.warn(`[codex-im] failed to resend subagent status card: ${error.message}`);
    return existingMessageId || "";
  }
}

function normalizeIdentifier(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function debugSubagent(text) {
  try {
    fs.appendFileSync(SUBAGENT_DEBUG_LOG, `[${new Date().toISOString()}] ${text}\n`, "utf8");
  } catch {}
}

function truncateText(value, limit) {
  const text = String(value || "").trim();
  if (!text || text.length <= limit) {
    return text;
  }
  return `${text.slice(0, Math.max(0, limit - 3))}...`;
}

module.exports = {
  handleCodexLifecycleEvent,
  handleSubagentCardAction,
  resolveParentSessionPath,
};
