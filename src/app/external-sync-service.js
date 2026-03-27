const fs = require("fs");
const path = require("path");
const codexMessageUtils = require("../infra/codex/message-utils");

const EXTERNAL_SYNC_INTERVAL_MS = 2000;
const THREAD_LIST_PAGE_LIMIT = 200;
const THREAD_LIST_MAX_PAGES = 10;
const FEISHU_PROMPT_FINGERPRINT_TTL_MS = 15 * 60 * 1000;
const LIVE_DELIVERED_TURN_REPLAY_TTL_MS = 5 * 60 * 1000;
const SYNTHETIC_CONTINUE_PREFIX = "[internal reviewer continue]";
const SLURM_WAKEUP_PROMPT_RE = /^SLURM job \S+ is now RUNNING on node /i;
const EXTERNAL_SYNC_INVARIANT_ERROR = "ExternalSyncInvariantError";
const EXTERNAL_SYNC_DEBUG_LOG_PATH = process.env.CODEX_IM_EXTERNAL_SYNC_DEBUG_LOG
  || path.join(process.cwd(), "logs", "codex-im.external-sync.log");

function startExternalSessionSync(runtime) {
  scheduleExternalSessionSync(runtime, { immediate: false });
}

function scheduleExternalSessionSync(runtime, { immediate = false } = {}) {
  clearExternalSessionSyncTimer(runtime);
  const delayMs = immediate ? 0 : EXTERNAL_SYNC_INTERVAL_MS;
  runtime.externalSessionSyncTimer = setTimeout(() => {
    runtime.externalSessionSyncTimer = null;
    runExternalSessionSync(runtime).catch((error) => {
      reportExternalSyncFailure(error);
      if (isFatalExternalSyncError(error)) {
        throw error;
      }
      scheduleExternalSessionSync(runtime);
    });
  }, delayMs);
}

function clearExternalSessionSyncTimer(runtime) {
  if (!runtime.externalSessionSyncTimer) {
    return;
  }
  clearTimeout(runtime.externalSessionSyncTimer);
  runtime.externalSessionSyncTimer = null;
}

async function runExternalSessionSync(runtime) {
  if (runtime.externalSessionSyncInFlight) {
    scheduleExternalSessionSync(runtime);
    return;
  }

  runtime.externalSessionSyncInFlight = true;
  try {
    await syncExternalSessions(runtime);
  } finally {
    runtime.externalSessionSyncInFlight = false;
    scheduleExternalSessionSync(runtime);
  }
}

function reportExternalSyncFailure(error) {
  const normalizedError = error instanceof Error ? error : new Error(String(error || "unknown external sync failure"));
  const stack = normalizedError.stack || normalizedError.message;
  appendExternalSyncDebugLog({
    stage: "external_sync_failure",
    errorName: normalizedError.name || "Error",
    errorMessage: normalizedError.message || String(normalizedError),
    stack,
    ...(normalizedError.externalSyncContext && typeof normalizedError.externalSyncContext === "object"
      ? { context: normalizedError.externalSyncContext }
      : {}),
  });
  console.error(`[codex-im] external session sync failed:\n${stack}`);
}

async function syncExternalSessions(runtime) {
  const tracked = runtime.sessionStore.listTrackedWorkspaceThreads();
  if (!tracked.length) {
    return;
  }

  const selectedBindings = selectLatestTrackedBindings(tracked);
  if (!selectedBindings.length) {
    return;
  }

  const threads = await listThreadsPaginated(runtime);
  const threadById = new Map(threads.map((thread) => [thread.id, thread]));

  for (const trackedBinding of selectedBindings) {
    await syncTrackedBinding(runtime, trackedBinding, threadById.get(trackedBinding.threadId) || null);
  }
}

function selectLatestTrackedBindings(tracked) {
  const latestByThreadId = new Map();
  for (const entry of tracked) {
    const updatedAt = Date.parse(entry.deliveryContext?.updatedAt || "") || 0;
    const existing = latestByThreadId.get(entry.threadId) || null;
    const existingUpdatedAt = Date.parse(existing?.deliveryContext?.updatedAt || "") || 0;
    if (!existing || updatedAt >= existingUpdatedAt) {
      latestByThreadId.set(entry.threadId, entry);
    }
  }
  return Array.from(latestByThreadId.values());
}

async function syncTrackedBinding(runtime, trackedBinding, thread) {
  const deliveryContext = trackedBinding.deliveryContext || null;
  if (!deliveryContext?.chatId) {
    appendExternalSyncDebugLog({
      stage: "syncTrackedBinding:skip_no_chat",
      threadId: trackedBinding.threadId,
      workspaceRoot: trackedBinding.workspaceRoot,
    });
    return;
  }

  const deliveryMode = runtime.turnDeliveryModeByThreadId.get(trackedBinding.threadId) || "";
  if (shouldSkipLiveSessionSync(runtime, trackedBinding.threadId, thread, deliveryMode)) {
    appendExternalSyncDebugLog({
      stage: "syncTrackedBinding:skip_live_running",
      threadId: trackedBinding.threadId,
      workspaceRoot: trackedBinding.workspaceRoot,
      deliveryMode,
      threadStatus: thread?.statusType || "",
      hasActiveTurn: runtime.activeTurnIdByThreadId?.has(trackedBinding.threadId) === true,
    });
    return;
  }

  const sessionPath = normalizeIdentifier(
    thread?.path
    || trackedBinding.sessionSyncState?.sessionPath
    || runtime.threadSessionPathByThreadId.get(trackedBinding.threadId)
  );
  if (!sessionPath) {
    appendExternalSyncDebugLog({
      stage: "syncTrackedBinding:skip_no_session_path",
      threadId: trackedBinding.threadId,
      workspaceRoot: trackedBinding.workspaceRoot,
    });
    return;
  }
  runtime.threadSessionPathByThreadId.set(trackedBinding.threadId, sessionPath);

  const threadUpdatedAt = normalizeNonNegativeInteger(thread?.updatedAt, 0);
  const currentSyncState = trackedBinding.sessionSyncState || null;
  if (!currentSyncState) {
    clearPartialChunkTracking(runtime, trackedBinding.threadId);
    appendExternalSyncDebugLog({
      stage: "syncTrackedBinding:init_baseline",
      threadId: trackedBinding.threadId,
      workspaceRoot: trackedBinding.workspaceRoot,
      sessionPath,
      threadUpdatedAt,
    });
    await initializeSessionSyncBaseline(runtime, trackedBinding, {
      threadId: trackedBinding.threadId,
      sessionPath,
      threadUpdatedAt,
    });
    return;
  }

  if (isWorkspaceThreadSwitchSessionRollover(currentSyncState, trackedBinding.threadId, sessionPath)) {
    clearPartialChunkTracking(runtime, trackedBinding.threadId);
    appendExternalSyncDebugLog({
      stage: "syncTrackedBinding:reset_for_thread_switch",
      threadId: trackedBinding.threadId,
      workspaceRoot: trackedBinding.workspaceRoot,
      previousSessionPath: normalizeIdentifier(currentSyncState.sessionPath),
      nextSessionPath: sessionPath,
      previousReadOffset: normalizeNonNegativeInteger(currentSyncState.readOffset, 0),
    });
    await initializeSessionSyncBaseline(runtime, trackedBinding, {
      threadId: trackedBinding.threadId,
      sessionPath,
      threadUpdatedAt,
    });
    return;
  }

  let effectiveSyncState = currentSyncState;
  let sessionPathChanged = didSessionPathChange(currentSyncState, sessionPath);
  if (isSameThreadSessionRollover(currentSyncState, trackedBinding.threadId, sessionPath)) {
    clearPartialChunkTracking(runtime, trackedBinding.threadId);
    appendExternalSyncDebugLog({
      stage: "syncTrackedBinding:restart_for_same_thread_rollover",
      threadId: trackedBinding.threadId,
      workspaceRoot: trackedBinding.workspaceRoot,
      previousSessionPath: normalizeIdentifier(currentSyncState.sessionPath),
      nextSessionPath: sessionPath,
      previousReadOffset: normalizeNonNegativeInteger(currentSyncState.readOffset, 0),
      previousLastRecordKey: normalizeIdentifier(currentSyncState.lastRecordKey),
    });
    effectiveSyncState = {
      ...currentSyncState,
      sessionPath,
      readOffset: 0,
    };
    sessionPathChanged = false;
  }

  if (sessionPathChanged) {
    throw createExternalSyncInvariantError(
      `session path changed for thread ${trackedBinding.threadId}`,
      {
        threadId: trackedBinding.threadId,
        workspaceRoot: trackedBinding.workspaceRoot,
        previousSessionPath: normalizeIdentifier(currentSyncState.sessionPath),
        nextSessionPath: sessionPath,
        readOffset: normalizeNonNegativeInteger(currentSyncState.readOffset, 0),
        lastRecordKey: normalizeIdentifier(currentSyncState.lastRecordKey),
      }
    );
  }
  const offset = resolveReadableOffset(effectiveSyncState, sessionPath);
  const sessionFileExists = await checkFileExists(sessionPath);
  if (!sessionFileExists) {
    clearPartialChunkTracking(runtime, trackedBinding.threadId);
    appendExternalSyncDebugLog({
      stage: "syncTrackedBinding:missing_session_file",
      threadId: trackedBinding.threadId,
      workspaceRoot: trackedBinding.workspaceRoot,
      sessionPath,
      readOffset: offset,
    });
    runtime.sessionStore.clearSessionSyncStateForWorkspace(
      trackedBinding.bindingKey,
      trackedBinding.workspaceRoot
    );
    return;
  }
  const sessionFileSize = await readFileSize(sessionPath);
  if (shouldSkipTrackedBindingRead({
    deliveryMode,
    threadUpdatedAt,
    lastSeenThreadUpdatedAt: effectiveSyncState.lastSeenThreadUpdatedAt,
    readOffset: offset,
    sessionFileSize,
  })) {
    appendExternalSyncDebugLog({
      stage: "syncTrackedBinding:skip_no_growth",
      threadId: trackedBinding.threadId,
      workspaceRoot: trackedBinding.workspaceRoot,
      sessionPath,
      deliveryMode,
      threadUpdatedAt,
      lastSeenThreadUpdatedAt: effectiveSyncState.lastSeenThreadUpdatedAt,
      readOffset: offset,
      sessionFileSize,
    });
    return;
  }

  const preservedLastTurnId = sessionPathChanged ? "" : normalizeIdentifier(effectiveSyncState.lastTurnId);
  const sessionChunk = await readSessionChunk(sessionPath, offset);
  if (sessionChunk?.reason === "partial") {
    recordPartialChunkOrThrow(runtime, trackedBinding, {
      sessionPath,
      readOffset: offset,
      sessionFileSize,
    });
  } else {
    clearPartialChunkTracking(runtime, trackedBinding.threadId);
  }
  if (!sessionChunk?.hasCompleteLine) {
    appendExternalSyncDebugLog({
      stage: sessionChunk?.reason === "partial" ? "syncTrackedBinding:partial_chunk" : "syncTrackedBinding:empty_chunk",
      threadId: trackedBinding.threadId,
      workspaceRoot: trackedBinding.workspaceRoot,
      sessionPath,
      readOffset: offset,
      sessionFileSize,
    });
    runtime.sessionStore.setSessionSyncStateForWorkspace(
      trackedBinding.bindingKey,
      trackedBinding.workspaceRoot,
      {
        threadId: trackedBinding.threadId,
        sessionPath,
        readOffset: sessionChunk?.nextOffset ?? offset,
        lastRecordKey: sessionPathChanged ? "" : effectiveSyncState.lastRecordKey,
        lastTurnId: preservedLastTurnId,
        lastSeenThreadUpdatedAt: threadUpdatedAt || effectiveSyncState.lastSeenThreadUpdatedAt,
      }
    );
    return;
  }

  const timeline = parseMainThreadSessionChunkState(sessionChunk.text, {
    threadId: trackedBinding.threadId,
    lastRecordKey: sessionPathChanged ? "" : effectiveSyncState.lastRecordKey,
    initialTurnId: sessionPathChanged ? "" : effectiveSyncState.lastTurnId,
  });
  const timelineEntries = timeline.entries;
  const resolvedLastTurnId = normalizeIdentifier(timeline.lastTurnId)
    || preservedLastTurnId;
  const hasSuspiciousUnparsedTimelineChunk = (
    timelineEntries.length === 0
    && chunkContainsPotentialTimelineRecords(sessionChunk.text)
  );
  appendExternalSyncDebugLog({
    stage: "syncTrackedBinding:read_chunk",
    threadId: trackedBinding.threadId,
    workspaceRoot: trackedBinding.workspaceRoot,
    sessionPath,
    readOffset: offset,
    nextOffset: sessionChunk.nextOffset,
    sessionFileSize,
    timelineEntryCount: timelineEntries.length,
    suspiciousUnparsedTimelineChunk: hasSuspiciousUnparsedTimelineChunk,
    lastRecordKey: effectiveSyncState.lastRecordKey || "",
  });

  if (hasSuspiciousUnparsedTimelineChunk) {
    runtime.sessionStore.setSessionSyncStateForWorkspace(
      trackedBinding.bindingKey,
      trackedBinding.workspaceRoot,
      {
        threadId: trackedBinding.threadId,
        sessionPath,
        readOffset: offset,
        lastRecordKey: sessionPathChanged ? "" : effectiveSyncState.lastRecordKey,
        lastTurnId: resolvedLastTurnId,
        lastSeenThreadUpdatedAt: threadUpdatedAt || effectiveSyncState.lastSeenThreadUpdatedAt,
      }
    );
    appendExternalSyncDebugLog({
      stage: "syncTrackedBinding:hold_offset_for_suspicious_chunk",
      threadId: trackedBinding.threadId,
      workspaceRoot: trackedBinding.workspaceRoot,
      sessionPath,
      readOffset: offset,
      sessionFileSize,
    });
    return;
  }

  if (timelineEntries.length) {
    for (const entry of timelineEntries) {
      await applyTimelineEntry(runtime, trackedBinding, entry, thread);
    }
  }

  const lastEntry = timelineEntries[timelineEntries.length - 1] || null;
  runtime.sessionStore.setSessionSyncStateForWorkspace(
    trackedBinding.bindingKey,
    trackedBinding.workspaceRoot,
    {
      threadId: trackedBinding.threadId,
      sessionPath,
      readOffset: sessionChunk.nextOffset,
      lastRecordKey: lastEntry?.recordKey || (sessionPathChanged ? "" : effectiveSyncState.lastRecordKey) || "",
      lastTurnId: resolvedLastTurnId,
      lastSeenThreadUpdatedAt: threadUpdatedAt || effectiveSyncState.lastSeenThreadUpdatedAt,
    }
  );
  appendExternalSyncDebugLog({
    stage: "syncTrackedBinding:save_state",
    threadId: trackedBinding.threadId,
    workspaceRoot: trackedBinding.workspaceRoot,
    sessionPath,
    readOffset: sessionChunk.nextOffset,
    timelineEntryCount: timelineEntries.length,
    savedLastRecordKey: lastEntry?.recordKey || currentSyncState.lastRecordKey || "",
  });
}

async function initializeSessionSyncBaseline(runtime, trackedBinding, {
  threadId,
  sessionPath,
  threadUpdatedAt = 0,
}) {
  const fileSize = await readFileSize(sessionPath);
  runtime.sessionStore.setSessionSyncStateForWorkspace(trackedBinding.bindingKey, trackedBinding.workspaceRoot, {
    threadId,
    sessionPath,
    readOffset: fileSize,
    lastRecordKey: "",
    lastTurnId: "",
    lastSeenThreadUpdatedAt: threadUpdatedAt,
  });
}

async function applyTimelineEntry(runtime, trackedBinding, entry, thread) {
  if (!entry) {
    return;
  }

  const bindingKey = trackedBinding.bindingKey;
  const workspaceRoot = trackedBinding.workspaceRoot;
  const chatId = trackedBinding.deliveryContext?.chatId || "";
  if (!chatId) {
    return;
  }

  if (entry.kind === "user") {
    if (shouldSkipFeishuManagedUserMessage(runtime, trackedBinding.threadId, entry.text)) {
      return;
    }
    runtime.markThreadHasExternalUpdates?.(trackedBinding.threadId);
    const sourceKind = classifyExternalInputText(entry.text);
    runtime.externalSummaryLabelByThreadId.set(trackedBinding.threadId, sourceKind.title);
    await appendExternalInputCard(runtime, {
      chatId,
      title: sourceKind.title,
      text: entry.text,
    });
    return;
  }

  if (entry.kind === "assistant") {
    if (shouldSkipRecentLiveDeliveredAssistantReplay(runtime, {
      threadId: trackedBinding.threadId,
      turnId: entry.turnId,
    })) {
      appendExternalSyncDebugLog({
        stage: "syncTrackedBinding:skip_recent_live_assistant_replay",
        threadId: trackedBinding.threadId,
        workspaceRoot,
        turnId: entry.turnId,
      });
      return;
    }
    runtime.markThreadHasExternalUpdates?.(trackedBinding.threadId);
    await runtime.upsertAssistantReplyCard({
      threadId: trackedBinding.threadId,
      turnId: entry.turnId,
      itemId: entry.recordKey || "",
      chatId,
      text: entry.text,
      textMode: "replace",
      state: "streaming",
      deferFlush: false,
    });
    return;
  }

  if (entry.kind === "turn_state") {
    forgetRecentLiveDeliveredTurn(runtime, {
      threadId: trackedBinding.threadId,
      turnId: entry.turnId,
    });
    if (entry.turnId) {
      await runtime.upsertAssistantReplyCard({
        threadId: trackedBinding.threadId,
        turnId: entry.turnId,
        chatId,
        state: entry.state,
      });
    }
    await maybeHandleExternalTurnCompletedReview(runtime, {
      threadId: trackedBinding.threadId,
      turnId: entry.turnId,
      state: entry.state,
    });
  }
}

function hasDeliveredAssistantTurn(runtime, threadId, turnId = "") {
  const normalizedThreadId = normalizeIdentifier(threadId);
  const normalizedTurnId = normalizeIdentifier(turnId);
  if (!normalizedThreadId || !normalizedTurnId) {
    return false;
  }

  for (const detail of runtime.replyDetailByMessageId.values()) {
    if (detail?.threadId === normalizedThreadId && detail?.turnId === normalizedTurnId) {
      return true;
    }
  }
  return false;
}

function shouldSkipRecentLiveDeliveredAssistantReplay(runtime, { threadId, turnId } = {}) {
  const runKey = codexMessageUtils.buildRunKey(
    normalizeIdentifier(threadId),
    normalizeIdentifier(turnId)
  );
  if (!runKey || !(runtime.recentLiveDeliveredTurnAtByRunKey instanceof Map)) {
    return false;
  }

  pruneRecentLiveDeliveredTurns(runtime);
  return runtime.recentLiveDeliveredTurnAtByRunKey.has(runKey);
}

function forgetRecentLiveDeliveredTurn(runtime, { threadId, turnId } = {}) {
  const runKey = codexMessageUtils.buildRunKey(
    normalizeIdentifier(threadId),
    normalizeIdentifier(turnId)
  );
  if (!runKey || !(runtime.recentLiveDeliveredTurnAtByRunKey instanceof Map)) {
    return;
  }
  runtime.recentLiveDeliveredTurnAtByRunKey.delete(runKey);
}

function pruneRecentLiveDeliveredTurns(runtime) {
  const entries = runtime.recentLiveDeliveredTurnAtByRunKey;
  if (!(entries instanceof Map) || entries.size === 0) {
    return;
  }

  const threshold = Date.now() - LIVE_DELIVERED_TURN_REPLAY_TTL_MS;
  for (const [runKey, deliveredAtMs] of entries.entries()) {
    if (typeof deliveredAtMs !== "number" || deliveredAtMs < threshold) {
      entries.delete(runKey);
    }
  }
}

async function finalizeIncompleteAssistantState(runtime, trackedBinding, timelineEntries, thread) {
  if (thread?.statusType === "running") {
    return;
  }

  const lastAssistantEntry = [...timelineEntries].reverse().find((entry) => entry.kind === "assistant") || null;
  if (!lastAssistantEntry?.turnId) {
    return;
  }

  const hasTerminalState = timelineEntries.some((entry) => (
    entry.kind === "turn_state" && entry.turnId === lastAssistantEntry.turnId
  ));
  if (hasTerminalState) {
    return;
  }

  await runtime.upsertAssistantReplyCard({
    threadId: trackedBinding.threadId,
    turnId: lastAssistantEntry.turnId,
    chatId: trackedBinding.deliveryContext?.chatId || "",
    state: "completed",
  });
  await maybeHandleExternalTurnCompletedReview(runtime, {
    threadId: trackedBinding.threadId,
    turnId: lastAssistantEntry.turnId,
    state: "completed",
  });
}

async function appendExternalInputCard(runtime, { chatId, title, text }) {
  if (!chatId || !text) {
    return null;
  }

  return runtime.sendInteractiveCard({
    chatId,
    card: runtime.buildExternalInputCard({
      title,
      text,
    }),
  });
}

async function maybeHandleExternalTurnCompletedReview(runtime, {
  threadId,
  turnId = "",
  state = "",
}) {
  const normalizedThreadId = normalizeIdentifier(threadId);
  const normalizedTurnId = normalizeIdentifier(turnId);
  if (!normalizedThreadId || !normalizedTurnId || state !== "completed") {
    return;
  }

  const chain = runtime.reviewChainByMainThreadId?.get(normalizedThreadId) || null;
  if (!chain) {
    return;
  }

  if (normalizeIdentifier(chain.lastReviewRequestedTurnId) === normalizedTurnId) {
    return;
  }

  await runtime.handleMainTurnCompleted({
    threadId: normalizedThreadId,
    turnId: normalizedTurnId,
  });
}

function rememberFeishuPromptFingerprint(runtime, { threadId, text }) {
  const normalizedThreadId = normalizeIdentifier(threadId);
  const normalizedText = normalizeTimelineText(text);
  if (!normalizedThreadId || !normalizedText) {
    return;
  }

  pruneFeishuPromptFingerprints(runtime, normalizedThreadId);
  const existing = runtime.recentFeishuPromptFingerprintsByThreadId.get(normalizedThreadId) || [];
  existing.push({
    text: normalizedText,
    createdAtMs: Date.now(),
  });
  runtime.recentFeishuPromptFingerprintsByThreadId.set(normalizedThreadId, existing.slice(-20));
}

function shouldSkipFeishuManagedUserMessage(runtime, threadId, text) {
  const normalizedThreadId = normalizeIdentifier(threadId);
  const normalizedText = normalizeTimelineText(text);
  if (!normalizedThreadId || !normalizedText) {
    return false;
  }

  pruneFeishuPromptFingerprints(runtime, normalizedThreadId);
  const fingerprints = runtime.recentFeishuPromptFingerprintsByThreadId.get(normalizedThreadId) || [];
  const matchIndex = fingerprints.findIndex((fingerprint) => fingerprint.text === normalizedText);
  if (matchIndex < 0) {
    return false;
  }

  fingerprints.splice(matchIndex, 1);
  if (fingerprints.length) {
    runtime.recentFeishuPromptFingerprintsByThreadId.set(normalizedThreadId, fingerprints);
  } else {
    runtime.recentFeishuPromptFingerprintsByThreadId.delete(normalizedThreadId);
  }
  return true;
}

function pruneFeishuPromptFingerprints(runtime, threadId) {
  const normalizedThreadId = normalizeIdentifier(threadId);
  if (!normalizedThreadId) {
    return;
  }

  const fingerprints = runtime.recentFeishuPromptFingerprintsByThreadId.get(normalizedThreadId) || [];
  const threshold = Date.now() - FEISHU_PROMPT_FINGERPRINT_TTL_MS;
  const next = fingerprints.filter((fingerprint) => fingerprint.createdAtMs >= threshold);
  if (next.length) {
    runtime.recentFeishuPromptFingerprintsByThreadId.set(normalizedThreadId, next);
  } else {
    runtime.recentFeishuPromptFingerprintsByThreadId.delete(normalizedThreadId);
  }
}

async function primeSessionSyncCursor(runtime, { bindingKey, workspaceRoot, threadId, sessionPath = "" }) {
  const normalizedThreadId = normalizeIdentifier(threadId);
  if (!bindingKey || !workspaceRoot || !normalizedThreadId) {
    return;
  }

  const resolvedSessionPath = normalizeIdentifier(
    sessionPath
    || runtime.threadSessionPathByThreadId.get(normalizedThreadId)
    || runtime.sessionStore.getSessionSyncStateForWorkspace(bindingKey, workspaceRoot)?.sessionPath
  );
  if (!resolvedSessionPath) {
    return;
  }

  const fileSize = await readFileSize(resolvedSessionPath);
  runtime.sessionStore.setSessionSyncStateForWorkspace(bindingKey, workspaceRoot, {
    threadId: normalizedThreadId,
    sessionPath: resolvedSessionPath,
    readOffset: fileSize,
  });
}

async function advanceSessionSyncCursorToEof(runtime, { threadId }) {
  const trackedBindings = runtime.sessionStore.findTrackedBindingsByThreadId(threadId);
  for (const tracked of trackedBindings) {
    await primeSessionSyncCursor(runtime, {
      bindingKey: tracked.bindingKey,
      workspaceRoot: tracked.workspaceRoot,
      threadId,
      sessionPath: tracked.sessionSyncState?.sessionPath,
    });
    runtime.sessionStore.setSessionSyncStateForWorkspace(tracked.bindingKey, tracked.workspaceRoot, {
      threadId,
      lastSeenThreadUpdatedAt: Math.floor(Date.now() / 1000),
    });
  }
}

async function readSessionChunk(sessionPath, offset) {
  const fileHandle = await fs.promises.open(sessionPath, "r");
  try {
    const stats = await fileHandle.stat();
    const safeOffset = Math.min(Math.max(0, offset), stats.size);
    const remainingBytes = stats.size - safeOffset;
    if (remainingBytes <= 0) {
      return {
        text: "",
        nextOffset: safeOffset,
        hasCompleteLine: false,
        reason: "eof",
      };
    }

    const buffer = Buffer.alloc(remainingBytes);
    const readResult = await fileHandle.read(buffer, 0, remainingBytes, safeOffset);
    const rawChunk = buffer.slice(0, readResult.bytesRead).toString("utf8");
    const lastNewlineIndex = rawChunk.lastIndexOf("\n");
    if (lastNewlineIndex < 0) {
      return {
        text: "",
        nextOffset: safeOffset,
        hasCompleteLine: false,
        reason: "partial",
      };
    }
    const safeChunk = rawChunk.slice(0, lastNewlineIndex + 1);
    return {
      text: safeChunk,
      nextOffset: safeOffset + Buffer.byteLength(safeChunk, "utf8"),
      hasCompleteLine: true,
      reason: "ready",
    };
  } finally {
    await fileHandle.close();
  }
}

async function readFileSize(sessionPath) {
  try {
    const stats = await fs.promises.stat(sessionPath);
    return normalizeNonNegativeInteger(stats.size, 0);
  } catch {
    return 0;
  }
}

async function checkFileExists(sessionPath) {
  try {
    await fs.promises.access(sessionPath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function listThreadsPaginated(runtime) {
  const threads = [];
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
      threads.push(thread);
    }

    const nextCursor = codexMessageUtils.extractThreadListCursor(response);
    if (!nextCursor || nextCursor === cursor || pageThreads.length === 0) {
      break;
    }
    cursor = nextCursor;
  }

  return threads;
}

function parseMainThreadSessionChunkState(rawChunk, {
  threadId = "",
  lastRecordKey = "",
  initialTurnId = "",
} = {}) {
  const lines = String(rawChunk || "").split(/\r?\n/).filter(Boolean);
  const entries = [];
  let currentTurnId = normalizeIdentifier(initialTurnId);
  const normalizedLastRecordKey = normalizeIdentifier(lastRecordKey);

  for (const line of lines) {
    const record = parseJsonLine(line);
    if (!record) {
      continue;
    }

    currentTurnId = updateCurrentTurnId(currentTurnId, record);
    const recordKey = buildMainSessionRecordKey(record, currentTurnId);
    const entry = extractTimelineEntry(record, currentTurnId, threadId);
    if (!entry) {
      continue;
    }

    entries.push({
      ...entry,
      recordKey,
    });
  }

  if (!normalizedLastRecordKey) {
    return { entries, lastTurnId: currentTurnId };
  }

  const lastSeenIndex = entries.findIndex((entry) => entry.recordKey === normalizedLastRecordKey);
  if (lastSeenIndex < 0) {
    return { entries, lastTurnId: currentTurnId };
  }

  return {
    entries: entries.slice(lastSeenIndex + 1),
    lastTurnId: currentTurnId,
  };
}

function parseMainThreadSessionChunk(rawChunk, options = {}) {
  return parseMainThreadSessionChunkState(rawChunk, options).entries;
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function chunkContainsPotentialTimelineRecords(rawChunk) {
  const lines = String(rawChunk || "").split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    const record = parseJsonLine(line);
    if (record && recordLooksLikePotentialTimelineRecord(record)) {
      return true;
    }

    if (record) {
      continue;
    }

    const normalizedLine = normalizeTimelineText(line);
    if (normalizedLine.includes('"type":"user_message"')) {
      return true;
    }
    if (normalizedLine.includes('"type":"task_complete"')) {
      return true;
    }
    if (normalizedLine.includes('"type":"task_failed"') || normalizedLine.includes('"type":"task_cancelled"')) {
      return true;
    }
    if (normalizedLine.includes('"type":"message"') && normalizedLine.includes('"role":"assistant"')) {
      return true;
    }
  }
  return false;
}

function recordLooksLikePotentialTimelineRecord(record) {
  const payload = record?.payload || {};
  if (record?.type === "response_item" && payload?.type === "message") {
    return normalizeIdentifier(payload?.role).toLowerCase() === "assistant";
  }

  if (record?.type !== "event_msg") {
    return false;
  }

  const eventType = normalizeIdentifier(payload?.type).toLowerCase();
  return eventType === "user_message"
    || eventType === "task_complete"
    || eventType === "task_failed"
    || eventType === "task_cancelled";
}

function updateCurrentTurnId(previousTurnId, record) {
  const payload = record?.payload || {};
  const taskTurnId = normalizeIdentifier(payload?.turn_id);
  const contextTurnId = normalizeIdentifier(payload?.turn_id);
  if (record?.type === "event_msg" && taskTurnId) {
    return taskTurnId;
  }
  if (record?.type === "turn_context" && contextTurnId) {
    return contextTurnId;
  }
  return previousTurnId;
}

function buildMainSessionRecordKey(record, currentTurnId = "") {
  const payload = record?.payload || {};
  return [
    record?.timestamp || "",
    record?.type || "",
    payload?.type || "",
    payload?.role || "",
    currentTurnId,
    extractSessionMessageText(payload) || normalizeIdentifier(payload?.message),
  ].join("|");
}

function extractTimelineEntry(record, currentTurnId, threadId) {
  const payload = record?.payload || {};

  if (record?.type === "response_item" && payload?.type === "message") {
    const role = normalizeIdentifier(payload?.role).toLowerCase();
    if (role === "assistant") {
      const text = extractSessionMessageText(payload);
      if (!text) {
        return null;
      }
      return {
        kind: "assistant",
        threadId,
        turnId: normalizeIdentifier(currentTurnId),
        text,
        timestamp: normalizeIdentifier(record?.timestamp),
      };
    }
    return null;
  }

  if (record?.type === "event_msg") {
    const eventType = normalizeIdentifier(payload?.type).toLowerCase();
    if (eventType === "user_message") {
      const text = normalizeIdentifier(payload?.message);
      if (!text) {
        return null;
      }
      return {
        kind: "user",
        threadId,
        turnId: normalizeIdentifier(payload?.turn_id || currentTurnId),
        text,
        timestamp: normalizeIdentifier(record?.timestamp),
      };
    }
    if (eventType === "task_complete") {
      return {
        kind: "turn_state",
        threadId,
        turnId: normalizeIdentifier(payload?.turn_id || currentTurnId),
        state: "completed",
        timestamp: normalizeIdentifier(record?.timestamp),
      };
    }
    if (eventType === "task_failed" || eventType === "task_cancelled") {
      return {
        kind: "turn_state",
        threadId,
        turnId: normalizeIdentifier(payload?.turn_id || currentTurnId),
        state: "failed",
        timestamp: normalizeIdentifier(record?.timestamp),
      };
    }
  }

  return null;
}

function extractSessionMessageText(payload) {
  const content = Array.isArray(payload?.content) ? payload.content : [];
  const parts = [];
  for (const entry of content) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const entryType = normalizeIdentifier(entry.type).toLowerCase();
    if (entryType === "input_text" || entryType === "output_text") {
      const text = normalizeIdentifier(entry.text);
      if (text) {
        parts.push(text);
      }
    }
  }

  return parts.join("\n\n").trim();
}

function classifyExternalInputText(text) {
  const normalizedText = normalizeTimelineText(text);
  if (normalizedText.startsWith(SYNTHETIC_CONTINUE_PREFIX.toLowerCase())) {
    return {
      kind: "synthetic_continue",
      title: "🧠 Long · 自动继续",
    };
  }
  if (SLURM_WAKEUP_PROMPT_RE.test(String(text || ""))) {
    return {
      kind: "slurm_wakeup",
      title: "⚙️ 系统 · 外部唤醒",
    };
  }
  return {
    kind: "external_user",
    title: "👤 用户 · 外部输入",
  };
}

function resolveReadableOffset(syncState, sessionPath) {
  if (!syncState) {
    return 0;
  }
  return normalizeNonNegativeInteger(syncState?.readOffset, 0);
}

function didSessionPathChange(syncState, sessionPath) {
  const previousSessionPath = normalizeIdentifier(syncState?.sessionPath);
  const nextSessionPath = normalizeIdentifier(sessionPath);
  return !!previousSessionPath && !!nextSessionPath && previousSessionPath !== nextSessionPath;
}

function isWorkspaceThreadSwitchSessionRollover(syncState, trackedThreadId, nextSessionPath) {
  const normalizedTrackedThreadId = normalizeIdentifier(trackedThreadId);
  const previousSessionPath = normalizeIdentifier(syncState?.sessionPath);
  const normalizedNextSessionPath = normalizeIdentifier(nextSessionPath);
  if (!normalizedTrackedThreadId || !previousSessionPath || !normalizedNextSessionPath) {
    return false;
  }
  if (previousSessionPath === normalizedNextSessionPath) {
    return false;
  }

  const previousPathThreadId = extractThreadIdFromSessionPath(previousSessionPath);
  const nextPathThreadId = extractThreadIdFromSessionPath(normalizedNextSessionPath);
  return !!previousPathThreadId
    && !!nextPathThreadId
    && previousPathThreadId !== normalizedTrackedThreadId
    && nextPathThreadId === normalizedTrackedThreadId;
}

function isSameThreadSessionRollover(syncState, trackedThreadId, nextSessionPath) {
  const normalizedTrackedThreadId = normalizeIdentifier(trackedThreadId);
  const previousSessionPath = normalizeIdentifier(syncState?.sessionPath);
  const normalizedNextSessionPath = normalizeIdentifier(nextSessionPath);
  if (!normalizedTrackedThreadId || !previousSessionPath || !normalizedNextSessionPath) {
    return false;
  }
  if (previousSessionPath === normalizedNextSessionPath) {
    return false;
  }

  const previousPathThreadId = extractThreadIdFromSessionPath(previousSessionPath);
  const nextPathThreadId = extractThreadIdFromSessionPath(normalizedNextSessionPath);
  return previousPathThreadId === normalizedTrackedThreadId
    && nextPathThreadId === normalizedTrackedThreadId;
}

function shouldSkipTrackedBindingRead({
  deliveryMode = "",
  threadUpdatedAt = 0,
  lastSeenThreadUpdatedAt = 0,
  readOffset = 0,
  sessionFileSize = 0,
} = {}) {
  if (deliveryMode === "session") {
    return false;
  }
  if (threadUpdatedAt <= 0) {
    return false;
  }
  if (threadUpdatedAt >= normalizeNonNegativeInteger(lastSeenThreadUpdatedAt, 0)) {
    return false;
  }
  return normalizeNonNegativeInteger(sessionFileSize, 0) <= normalizeNonNegativeInteger(readOffset, 0);
}

function shouldSkipLiveSessionSync(runtime, threadId, thread, deliveryMode = "") {
  if (deliveryMode !== "live") {
    return false;
  }

  if (runtime.activeTurnIdByThreadId?.has(threadId)) {
    return true;
  }

  return normalizeIdentifier(thread?.statusType).toLowerCase() === "running";
}

function normalizeTimelineText(text) {
  return normalizeIdentifier(text)
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeIdentifier(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function normalizeNonNegativeInteger(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return fallback;
  }
  return Math.floor(numeric);
}

function appendExternalSyncDebugLog(payload) {
  if (!isTruthyEnv(process.env.CODEX_IM_EXTERNAL_SYNC_DEBUG_LOG_ENABLED)) {
    return;
  }
  const record = {
    timestamp: new Date().toISOString(),
    ...payload,
  };
  try {
    fs.appendFileSync(EXTERNAL_SYNC_DEBUG_LOG_PATH, `${JSON.stringify(record)}\n`);
  } catch {}
}

function isTruthyEnv(value) {
  if (typeof value !== "string") {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function recordPartialChunkOrThrow(runtime, trackedBinding, {
  sessionPath = "",
  readOffset = 0,
  sessionFileSize = 0,
} = {}) {
  const threadId = normalizeIdentifier(trackedBinding?.threadId);
  if (!threadId) {
    return;
  }

  if (!(runtime.externalSyncPartialChunkByThreadId instanceof Map)) {
    runtime.externalSyncPartialChunkByThreadId = new Map();
  }

  const signature = [
    normalizeIdentifier(sessionPath),
    normalizeNonNegativeInteger(readOffset, 0),
    normalizeNonNegativeInteger(sessionFileSize, 0),
  ].join("|");
  const previous = runtime.externalSyncPartialChunkByThreadId.get(threadId) || null;
  if (!previous || previous.signature !== signature) {
    runtime.externalSyncPartialChunkByThreadId.set(threadId, {
      signature,
      seenCount: 1,
    });
    return;
  }

  const preview = readChunkPreviewForDebug(sessionPath, readOffset);
  if (previewLooksLikeOnlyNulPadding(preview)) {
    runtime.externalSyncPartialChunkByThreadId.set(threadId, {
      signature,
      seenCount: normalizeNonNegativeInteger(previous.seenCount, 1) + 1,
    });
    appendExternalSyncDebugLog({
      stage: "syncTrackedBinding:partial_chunk_nul_padding",
      threadId,
      workspaceRoot: normalizeIdentifier(trackedBinding?.workspaceRoot),
      sessionPath: normalizeIdentifier(sessionPath),
      readOffset: normalizeNonNegativeInteger(readOffset, 0),
      sessionFileSize: normalizeNonNegativeInteger(sessionFileSize, 0),
    });
    return;
  }

  const seenCount = normalizeNonNegativeInteger(previous.seenCount, 1) + 1;
  runtime.externalSyncPartialChunkByThreadId.set(threadId, {
    signature,
    seenCount,
  });
  if (seenCount < 2) {
    return;
  }

  throw createExternalSyncInvariantError(
    `session sync stalled on the same partial chunk for thread ${threadId}`,
    {
      threadId,
      workspaceRoot: normalizeIdentifier(trackedBinding?.workspaceRoot),
      sessionPath: normalizeIdentifier(sessionPath),
      readOffset: normalizeNonNegativeInteger(readOffset, 0),
      sessionFileSize: normalizeNonNegativeInteger(sessionFileSize, 0),
      preview,
    }
  );
}

function clearPartialChunkTracking(runtime, threadId) {
  const normalizedThreadId = normalizeIdentifier(threadId);
  if (!normalizedThreadId || !(runtime.externalSyncPartialChunkByThreadId instanceof Map)) {
    return;
  }
  runtime.externalSyncPartialChunkByThreadId.delete(normalizedThreadId);
}

function readChunkPreviewForDebug(sessionPath, readOffset) {
  const normalizedSessionPath = normalizeIdentifier(sessionPath);
  if (!normalizedSessionPath) {
    return "";
  }

  try {
    const raw = fs.readFileSync(normalizedSessionPath);
    const offset = Math.min(Math.max(0, normalizeNonNegativeInteger(readOffset, 0)), raw.length);
    return raw.subarray(offset, Math.min(raw.length, offset + 400)).toString("utf8");
  } catch (error) {
    return `<failed to read chunk preview: ${error.message}>`;
  }
}

function extractThreadIdFromSessionPath(sessionPath) {
  const normalizedSessionPath = normalizeIdentifier(sessionPath);
  if (!normalizedSessionPath) {
    return "";
  }

  const match = normalizedSessionPath.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  return normalizeIdentifier(match?.[1]);
}

function previewLooksLikeOnlyNulPadding(preview) {
  if (typeof preview !== "string" || !preview.length) {
    return false;
  }
  return preview.replace(/\u0000/g, "").trim().length === 0;
}

function createExternalSyncInvariantError(message, context = {}) {
  const error = new Error(message);
  error.name = EXTERNAL_SYNC_INVARIANT_ERROR;
  error.externalSyncContext = context;
  return error;
}

function isFatalExternalSyncError(error) {
  return normalizeIdentifier(error?.name) === EXTERNAL_SYNC_INVARIANT_ERROR;
}

module.exports = {
  advanceSessionSyncCursorToEof,
  classifyExternalInputText,
  finalizeIncompleteAssistantState,
  hasDeliveredAssistantTurn,
  maybeHandleExternalTurnCompletedReview,
  parseMainThreadSessionChunk,
  parseMainThreadSessionChunkState,
  primeSessionSyncCursor,
  rememberFeishuPromptFingerprint,
  shouldSkipTrackedBindingRead,
  shouldSkipLiveSessionSync,
  startExternalSessionSync,
  syncExternalSessions,
};
