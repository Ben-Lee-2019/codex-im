const fs = require("fs");
const codexMessageUtils = require("../../infra/codex/message-utils");
const { formatFailureText } = require("../../shared/error-text");

const SUBAGENT_POLL_INTERVAL_MS = 1500;
const SUBAGENT_TERMINAL_GRACE_MS = 5000;
const THREAD_LIST_PAGE_LIMIT = 200;
const THREAD_LIST_MAX_PAGES = 10;
const SESSION_EVENT_GRACE_MS = 10 * 1000;

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
    parentSessionPath: runtime.threadSessionPathByThreadId.get(parentThreadId) || "",
  });

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
    pollSubagents(runtime, runKey).catch((error) => {
      console.error(`[codex-im] subagent poll failed: ${error.message}`);
    });
    return;
  }

  const timer = setTimeout(() => {
    runtime.subagentPollTimerByRunKey.delete(runKey);
    pollSubagents(runtime, runKey).catch((error) => {
      console.error(`[codex-im] subagent poll failed: ${error.message}`);
    });
  }, SUBAGENT_POLL_INTERVAL_MS);
  runtime.subagentPollTimerByRunKey.set(runKey, timer);
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
      state: "created",
      lastUpdatedAt: Number(thread.updatedAt || 0),
      lastSummary: "",
      nickname: thread.agentNickname || "",
      role: thread.agentRole || "",
      path: thread.path || "",
      detailMessageId: "",
      historyMessages: [],
      transcriptMessages: [],
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

  const transcriptMessages = normalizeConversationMessages(transcript.messages);
  const agentNickname = transcript.agentNickname || thread.agentNickname || cardState.nickname || "";
  const agentRole = transcript.agentRole || thread.agentRole || cardState.role || "";
  const summary = buildSubagentSummary(transcriptMessages, { state: "completed" });
  const shouldPatch = (
    cardState.state !== "completed"
    || cardState.lastSummary !== summary
    || Number(cardState.lastUpdatedAt || 0) !== Number(thread.updatedAt || 0)
  );
  if (shouldPatch) {
    await runtime.patchInteractiveCard({
      messageId: cardState.messageId,
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
  }

  const nextEntry = {
    ...cardState,
    state: "completed",
    lastUpdatedAt: Number(thread.updatedAt || 0),
    lastSummary: summary,
    nickname: agentNickname,
    role: agentRole,
    path: thread.path || cardState.path || "",
    transcriptMessages,
  };
  runtime.subagentCardByThreadId.set(thread.id, nextEntry);

  await syncOpenSubagentDetailCard(runtime, nextEntry, {
    state: "completed",
    messages: transcriptMessages,
    agentNickname,
    agentRole,
  });
}

async function showSubagentTranscript(runtime, normalized, threadId) {
  const threadEntry = runtime.subagentCardByThreadId.get(threadId) || { threadId };
  const metadata = await resolveSubagentMetadataFromThreadId(runtime, threadId, threadEntry.path || "");
  const display = await loadSubagentDisplay(runtime, {
    id: threadId,
    agentNickname: metadata.agentNickname || threadEntry.nickname || "",
    agentRole: metadata.agentRole || threadEntry.role || "",
  }, {
    state: threadEntry.state || "",
    fallbackMessages: buildStoredSubagentMessages(threadEntry),
    fallbackSummary: threadEntry.lastSummary || "",
    requireComplete: false,
  });
  const messages = display.messages.length ? display.messages : buildFallbackDetailMessages(threadEntry);
  const nextEntry = {
    ...threadEntry,
    nickname: display.agentNickname || metadata.agentNickname || threadEntry.nickname || "",
    role: display.agentRole || metadata.agentRole || threadEntry.role || "",
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
  const sessionPath = resolveParentSessionPath(runtime, tracker);
  if (!sessionPath) {
    return false;
  }

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

    const spawnResult = extractSpawnAgentResult(record);
    if (spawnResult) {
      await syncSessionBackedSubagent(runtime, tracker, {
        id: spawnResult.agentId,
        agentNickname: spawnResult.nickname,
        state: "created",
        summary: "",
        historyText: spawnResult.nickname
          ? `已创建子代理 ${spawnResult.nickname}。`
          : `已创建子代理 ${spawnResult.agentId}。`,
      });
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
    });
  }

  runtime.subagentTrackerByRunKey.set(tracker.runKey, tracker);
  return true;
}

function resolveParentSessionPath(runtime, tracker) {
  const fromTracker = normalizeIdentifier(tracker?.parentSessionPath);
  if (fromTracker) {
    return fromTracker;
  }
  const fromRuntime = normalizeIdentifier(runtime.threadSessionPathByThreadId.get(tracker.parentThreadId) || "");
  if (fromRuntime) {
    tracker.parentSessionPath = fromRuntime;
  }
  return fromRuntime;
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
  const text = Array.isArray(payload?.content) ? JSON.stringify(payload.content[0] || {}) : "";
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

function extractSpawnAgentResult(record) {
  const payload = record?.payload || {};
  if (payload?.type !== "function_call_output") {
    return null;
  }
  if (typeof payload.output !== "string" || !payload.output.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(payload.output);
    const agentId = normalizeIdentifier(parsed?.agent_id);
    if (!agentId) {
      return null;
    }
    return {
      agentId,
      nickname: normalizeIdentifier(parsed?.nickname),
    };
  } catch {
    return null;
  }
}

function extractSubagentNotification(record) {
  const payload = record?.payload || {};
  if (payload?.type !== "message" || payload?.role !== "user") {
    return null;
  }
  const content = Array.isArray(payload?.content) ? payload.content : [];
  const text = normalizeIdentifier(content[0]?.text);
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
  const historyMessages = appendHistoryMessage(existing?.historyMessages, subagent.historyText);
  const nextState = chooseSessionBackedState(existing?.state, subagent.state);
  const threadLike = {
    id: subagent.id,
    agentNickname: subagent.agentNickname || existing?.nickname || "",
    agentRole: subagent.agentRole || existing?.role || "",
  };
  const shouldAttemptTranscript = (
    nextState === "completed"
    || nextState === "errored"
    || !!existing?.detailMessageId
    || !!existing?.transcriptMessages?.length
  );
  const display = shouldAttemptTranscript
    ? await loadSubagentDisplay(runtime, threadLike, {
      state: nextState,
      fallbackMessages: historyMessages,
      fallbackSummary: subagent.summary || existing?.lastSummary || "",
      requireComplete: false,
    })
    : {
      agentNickname: threadLike.agentNickname,
      agentRole: threadLike.agentRole,
      messages: normalizeConversationMessages(historyMessages),
      transcriptMessages: Array.isArray(existing?.transcriptMessages) ? existing.transcriptMessages : [],
      summary: buildSubagentSummary(historyMessages, {
        state: nextState,
        fallbackSummary: subagent.summary || existing?.lastSummary || "",
      }),
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
      state: nextState,
      lastUpdatedAt: Date.now(),
      lastSummary: nextSummary,
      nickname: nextNickname,
      role: nextRole,
      path: "",
      source: "session",
      historyMessages,
      transcriptMessages,
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
    await runtime.patchInteractiveCard({
      messageId: existing.messageId,
      card: runtime.buildSubagentStatusCard({
        thread: nextThreadLike,
        state: nextState,
        summary: nextSummary,
      }),
    });
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
    transcriptMessages,
  };
  runtime.subagentCardByThreadId.set(subagent.id, nextEntry);

  await syncOpenSubagentDetailCard(runtime, nextEntry, {
    state: nextState,
    messages: display.messages.length ? display.messages : buildFallbackDetailMessages(nextEntry),
    agentNickname: nextNickname,
    agentRole: nextRole,
  });
}

function appendHistoryMessage(historyMessages, text) {
  const normalizedText = normalizeIdentifier(text);
  const next = Array.isArray(historyMessages) ? historyMessages.slice() : [];
  if (!normalizedText) {
    return next;
  }
  const previous = next[next.length - 1];
  if (previous?.text === normalizedText) {
    return next;
  }
  next.push({
    role: "assistant",
    text: normalizedText,
  });
  return next;
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
} = {}) {
  const transcript = await tryLoadSubagentTranscript(runtime, thread);
  const transcriptMessages = normalizeConversationMessages(transcript?.messages);
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
  await runtime.patchInteractiveCard({
    messageId: threadEntry.detailMessageId,
    card: runtime.buildSubagentTranscriptCard({
      threadId: threadEntry.threadId || "",
      agentNickname: detail.agentNickname || threadEntry.nickname || "",
      agentRole: detail.agentRole || threadEntry.role || "",
      state: detail.state || threadEntry.state || "",
      messages: Array.isArray(detail.messages) && detail.messages.length
        ? detail.messages
        : buildFallbackDetailMessages(threadEntry),
    }),
  });
}

function buildStoredSubagentMessages(threadEntry) {
  if (Array.isArray(threadEntry?.transcriptMessages) && threadEntry.transcriptMessages.length) {
    return threadEntry.transcriptMessages;
  }
  if (Array.isArray(threadEntry?.historyMessages) && threadEntry.historyMessages.length) {
    return threadEntry.historyMessages;
  }
  return [];
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
  if (thread.parentThreadId && (thread.agentNickname || thread.agentRole)) {
    return {
      parentThreadId: thread.parentThreadId,
      agentNickname: thread.agentNickname || "",
      agentRole: thread.agentRole || "",
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
    : { parentThreadId: "", agentNickname: "", agentRole: "", path: sessionPath };
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
      path: normalizedPath,
    };
    runtime.subagentSessionMetaByPath.set(normalizedPath, fallback);
    return fallback;
  }
}

function normalizeIdentifier(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
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
};
