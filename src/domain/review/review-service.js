const codexMessageUtils = require("../../infra/codex/message-utils");
const { extractLongValue } = require("../../shared/command-parsing");
const { formatFailureText } = require("../../shared/error-text");

const REVIEW_LOOP_LIMIT = 10;
const REVIEW_REQUEST_TURN_LIMIT = 8;
const REVIEW_REQUEST_MAX_MESSAGES = 16;
const SYNTHETIC_CONTINUE_PREFIX = "[internal reviewer continue]";
const REVIEWER_MODEL = "gpt-5.4";
const REVIEWER_EFFORT = "medium";

function hydratePersistedLongMode(runtime) {
  const entries = runtime.sessionStore.listLongModeEntries();
  for (const entry of entries) {
    runtime.longModeByMainThreadId.set(entry.mainThreadId, {
      bindingKey: entry.bindingKey,
      enabled: entry.enabled === true,
      reviewerThreadId: normalizeIdentifier(entry.reviewerThreadId),
      createdAt: normalizeIdentifier(entry.createdAt),
      updatedAt: normalizeIdentifier(entry.updatedAt),
    });
    if (entry.reviewerThreadId) {
      runtime.reviewerMainThreadIdByReviewerThreadId.set(entry.reviewerThreadId, entry.mainThreadId);
    }
  }

  const waitingExternalEntries = typeof runtime.sessionStore.listWaitingExternalReviewEntries === "function"
    ? runtime.sessionStore.listWaitingExternalReviewEntries()
    : [];
  for (const entry of waitingExternalEntries) {
    if (!entry.mainThreadId || !entry.reviewerThreadId) {
      continue;
    }
    const longModeRecord = runtime.longModeByMainThreadId.get(entry.mainThreadId) || null;
    if (!longModeRecord?.enabled) {
      continue;
    }
    runtime.reviewChainByMainThreadId.set(entry.mainThreadId, {
      id: normalizeIdentifier(entry.id) || createReviewChainId(entry.mainThreadId),
      bindingKey: entry.bindingKey,
      workspaceRoot: normalizeIdentifier(entry.workspaceRoot),
      mainThreadId: entry.mainThreadId,
      reviewerThreadId: normalizeIdentifier(entry.reviewerThreadId),
      chatId: normalizeIdentifier(entry.chatId),
      replyToMessageId: normalizeIdentifier(entry.replyToMessageId),
      userText: normalizeIdentifier(entry.userText),
      continueCount: normalizeNonNegativeInteger(entry.continueCount, 0),
      bypassAfterLimit: entry.bypassAfterLimit === true,
      latestMainTurnId: normalizeIdentifier(entry.latestMainTurnId),
      lastReviewRequestedTurnId: normalizeIdentifier(entry.lastReviewRequestedTurnId),
      status: "waiting_external",
      createdAt: normalizeIdentifier(entry.createdAt),
      updatedAt: normalizeIdentifier(entry.updatedAt),
    });
  }
}

async function handleLongCommand(runtime, normalized) {
  const rawValue = extractLongValue(normalized.text);
  if (!rawValue) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: "用法：`/codex long <prompt>`\n或：`/codex long off`",
    });
    return;
  }

  const workspaceContext = await runtime.resolveWorkspaceContext(normalized, {
    replyToMessageId: normalized.messageId,
    missingWorkspaceText: "当前会话还未绑定项目。先发送 `/codex bind /绝对路径`。",
  });
  if (!workspaceContext) {
    return;
  }
  const { bindingKey, workspaceRoot } = workspaceContext;
  const normalizedValue = rawValue.trim();

  if (normalizedValue.toLowerCase() === "off") {
    const { threadId } = await runtime.resolveWorkspaceThreadState({
      bindingKey,
      workspaceRoot,
      normalized,
      autoSelectThread: true,
    });
    if (!threadId) {
      await runtime.sendInfoCardMessage({
        chatId: normalized.chatId,
        replyToMessageId: normalized.messageId,
        text: "当前项目还没有可关闭 long 模式的主线程。",
      });
      return;
    }
    if (isReviewerThreadId(runtime, threadId)) {
      await runtime.sendInfoCardMessage({
        chatId: normalized.chatId,
        replyToMessageId: normalized.messageId,
        text: "Reviewer 线程是只读的，不能在它上面关闭 long 模式。请切回主线程后再执行。",
      });
      return;
    }

    disableLongModeForThread(runtime, bindingKey, threadId);
    await runtime.showStatusPanel(normalized, {
      replyToMessageId: normalized.messageId,
      noticeText: "已关闭当前线程的 long 模式。",
    });
    return;
  }

  const promptNormalized = {
    ...normalized,
    text: normalizedValue,
    command: "message",
  };

  const { threadId } = await runtime.resolveWorkspaceThreadState({
    bindingKey,
    workspaceRoot,
    normalized: promptNormalized,
    autoSelectThread: true,
  });

  runtime.setPendingBindingContext(bindingKey, promptNormalized);
  if (threadId) {
    runtime.setPendingThreadContext(threadId, promptNormalized);
  }

  await runtime.addPendingReaction(bindingKey, normalized.messageId);

  try {
    const resolvedThreadId = await runtime.ensureThreadAndSendMessage({
      bindingKey,
      workspaceRoot,
      normalized: promptNormalized,
      threadId,
      reviewSendOptions: {
        enableLongModeForMainThread: true,
      },
    });
    runtime.movePendingReactionToThread(bindingKey, resolvedThreadId);
  } catch (error) {
    await runtime.clearPendingReactionForBinding(bindingKey);
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: formatFailureText("处理 long 模式请求失败", error),
    });
    throw error;
  }
}

async function ensureLongModeForMainThread(runtime, {
  bindingKey,
  workspaceRoot,
  mainThreadId,
}) {
  const existing = getLongModeRecord(runtime, mainThreadId);
  if (existing?.reviewerThreadId) {
    persistLongModeRecord(runtime, bindingKey, mainThreadId, {
      ...existing,
      bindingKey,
      enabled: true,
    });
    return getLongModeRecord(runtime, mainThreadId);
  }

  const reviewerThreadId = await createReviewerThread(runtime, {
    bindingKey,
    workspaceRoot,
    mainThreadId,
  });
  persistLongModeRecord(runtime, bindingKey, mainThreadId, {
    bindingKey,
    enabled: true,
    reviewerThreadId,
  });
  return getLongModeRecord(runtime, mainThreadId);
}

function disableLongModeForThread(runtime, bindingKey, mainThreadId) {
  const existing = getLongModeRecord(runtime, mainThreadId);
  if (!existing) {
    return null;
  }
  terminateReviewChain(runtime, mainThreadId);
  persistLongModeRecord(runtime, bindingKey, mainThreadId, {
    ...existing,
    bindingKey,
    enabled: false,
  });
  return getLongModeRecord(runtime, mainThreadId);
}

function recordAcceptedSend(runtime, {
  bindingKey,
  workspaceRoot,
  threadId,
  normalized,
  reviewSendOptions = {},
}) {
  if (!threadId) {
    return;
  }

  const longModeRecord = getLongModeRecord(runtime, threadId);
  const isSyntheticContinue = reviewSendOptions.isSyntheticContinue === true;
  if (!isSyntheticContinue && !longModeRecord?.enabled) {
    return;
  }

  if (isSyntheticContinue) {
    const chain = runtime.reviewChainByMainThreadId.get(threadId);
    if (!chain || chain.id !== reviewSendOptions.chainId) {
      return;
    }
    chain.status = "running_main";
    chain.updatedAt = new Date().toISOString();
    runtime.reviewChainByMainThreadId.set(threadId, chain);
    return;
  }

  terminateReviewChain(runtime, threadId);
  const chain = {
    id: createReviewChainId(threadId),
    bindingKey,
    workspaceRoot,
    mainThreadId: threadId,
    reviewerThreadId: longModeRecord.reviewerThreadId,
    chatId: normalizeIdentifier(normalized.chatId),
    replyToMessageId: normalizeIdentifier(normalized.messageId),
    userText: normalizeIdentifier(normalized.text),
    continueCount: 0,
    bypassAfterLimit: false,
    latestMainTurnId: "",
    lastReviewRequestedTurnId: "",
    status: "running_main",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  runtime.reviewChainByMainThreadId.set(threadId, chain);
}

function handleCodexLifecycleEvent(runtime, message) {
  const method = normalizeIdentifier(message?.method);
  const params = message?.params || {};
  const threadId = normalizeIdentifier(params?.threadId);
  const turnId = normalizeIdentifier(params?.turnId || params?.turn?.id);
  if (!threadId) {
    return;
  }

  if (isReviewerThreadId(runtime, threadId)) {
    const awaiting = runtime.reviewAwaitingVerdictByReviewerThreadId.get(threadId);
    if (awaiting && (method === "turn/started" || method === "turn/start") && turnId) {
      runtime.reviewAwaitingVerdictByReviewerThreadId.set(threadId, {
        ...awaiting,
        turnId,
      });
    }
    return;
  }

  const chain = runtime.reviewChainByMainThreadId.get(threadId);
  if (!chain) {
    return;
  }

  if ((method === "turn/started" || method === "turn/start") && turnId) {
    chain.latestMainTurnId = turnId;
    chain.updatedAt = new Date().toISOString();
    runtime.reviewChainByMainThreadId.set(threadId, chain);
    runtime.pendingSyntheticContinueChainIdByMainThreadId.delete(threadId);
    return;
  }

  if (method === "turn/completed" && turnId) {
    chain.latestMainTurnId = turnId;
    chain.updatedAt = new Date().toISOString();
    runtime.reviewChainByMainThreadId.set(threadId, chain);
    return;
  }

  if (method === "turn/failed" || method === "turn/cancelled") {
    terminateReviewChain(runtime, threadId);
  }
}

function shouldSuppressUserDelivery(runtime, message) {
  const threadId = normalizeIdentifier(message?.params?.threadId);
  return !!threadId && isReviewerThreadId(runtime, threadId);
}

async function handleSuppressedCodexMessage(runtime, message) {
  const method = normalizeIdentifier(message?.method);
  const params = message?.params || {};
  const threadId = normalizeIdentifier(params?.threadId);
  const turnId = normalizeIdentifier(params?.turnId || params?.turn?.id);
  if (!threadId || !isReviewerThreadId(runtime, threadId)) {
    return;
  }

  if (method === "turn/completed" || method === "turn/failed" || method === "turn/cancelled") {
    await handleReviewerTerminal(runtime, {
      reviewerThreadId: threadId,
      turnId,
      method,
    });
  }
}

async function handleMainTurnCompleted(runtime, { threadId, turnId }) {
  const chain = runtime.reviewChainByMainThreadId.get(threadId);
  if (!chain) {
    return;
  }

  const normalizedTurnId = normalizeIdentifier(turnId);
  if (normalizedTurnId && normalizeIdentifier(chain.lastReviewRequestedTurnId) === normalizedTurnId) {
    return;
  }

  chain.latestMainTurnId = normalizedTurnId || chain.latestMainTurnId;
  chain.updatedAt = new Date().toISOString();
  runtime.reviewChainByMainThreadId.set(threadId, chain);

  if (chain.bypassAfterLimit) {
    terminateReviewChain(runtime, threadId);
    return;
  }

  const previousStatus = chain.status;
  const previousLastReviewRequestedTurnId = normalizeIdentifier(chain.lastReviewRequestedTurnId);

  try {
    await dispatchOrQueueReview(runtime, chain);
  } catch (error) {
    chain.status = previousStatus;
    chain.lastReviewRequestedTurnId = previousLastReviewRequestedTurnId;
    chain.updatedAt = new Date().toISOString();
    runtime.reviewChainByMainThreadId.set(threadId, chain);
    if (previousStatus === "waiting_external") {
      persistWaitingExternalReview(runtime, chain);
    }
    throw error;
  }

  chain.lastReviewRequestedTurnId = normalizedTurnId || previousLastReviewRequestedTurnId;
  chain.updatedAt = new Date().toISOString();
  runtime.reviewChainByMainThreadId.set(threadId, chain);
  clearPersistedWaitingExternalReview(runtime, chain.bindingKey, threadId);
}

function resolveConversationThreadSelection({
  threads,
  selectedThreadId,
  reviewerMainThreadIdByReviewerThreadId,
}) {
  const normalizedThreads = Array.isArray(threads) ? threads : [];
  const reviewerMap = reviewerMainThreadIdByReviewerThreadId instanceof Map
    ? reviewerMainThreadIdByReviewerThreadId
    : new Map();
  const visibleThreadIds = new Set(normalizedThreads.map((thread) => normalizeIdentifier(thread?.id)).filter(Boolean));

  let correctedSelectedThreadId = normalizeIdentifier(selectedThreadId);
  if (correctedSelectedThreadId && reviewerMap.has(correctedSelectedThreadId)) {
    correctedSelectedThreadId = normalizeIdentifier(reviewerMap.get(correctedSelectedThreadId));
  }
  if (!visibleThreadIds.has(correctedSelectedThreadId) || reviewerMap.has(correctedSelectedThreadId)) {
    correctedSelectedThreadId = "";
  }

  return {
    selectedThreadId: correctedSelectedThreadId,
    threadId: correctedSelectedThreadId,
  };
}

function decorateThreadForDisplay(runtime, thread) {
  const normalizedThread = thread && typeof thread === "object" ? thread : {};
  const threadId = normalizeIdentifier(normalizedThread.id);
  const reviewerMainThreadId = runtime.reviewerMainThreadIdByReviewerThreadId.get(threadId) || "";
  const longModeRecord = getLongModeRecord(runtime, threadId);

  return {
    ...normalizedThread,
    isReviewer: !!reviewerMainThreadId,
    reviewerMainThreadId,
    isReadOnlyReviewer: !!reviewerMainThreadId,
    longModeEnabled: longModeRecord?.enabled === true,
    reviewerThreadId: normalizeIdentifier(longModeRecord?.reviewerThreadId),
  };
}

function isReviewerThreadId(runtime, threadId) {
  return runtime.reviewerMainThreadIdByReviewerThreadId.has(normalizeIdentifier(threadId));
}

async function dispatchOrQueueReview(runtime, chain) {
  if (!chain?.reviewerThreadId) {
    throw new Error("missing reviewer thread");
  }
  if (shouldQueueReview(runtime, chain.reviewerThreadId)) {
    runtime.pendingReviewDispatchByReviewerThreadId.set(chain.reviewerThreadId, {
      chainId: chain.id,
      mainThreadId: chain.mainThreadId,
    });
    chain.status = "queued_review";
    chain.updatedAt = new Date().toISOString();
    runtime.reviewChainByMainThreadId.set(chain.mainThreadId, chain);
    return;
  }

  try {
    await sendReviewRequest(runtime, chain);
  } catch (error) {
    if (!await tryRecoverMissingReviewerThread(runtime, chain, error)) {
      throw error;
    }
    await dispatchOrQueueReview(runtime, chain);
  }
}

function shouldQueueReview(runtime, reviewerThreadId) {
  return runtime.reviewerBootstrapPendingThreadIds.has(reviewerThreadId)
    || runtime.activeTurnIdByThreadId.has(reviewerThreadId)
    || runtime.reviewAwaitingVerdictByReviewerThreadId.has(reviewerThreadId);
}

async function sendReviewRequest(runtime, chain) {
  const resumeResponse = await runtime.codex.resumeThread({ threadId: chain.mainThreadId });
  const latestAssistantReply = extractLatestTurnAssistantReply(resumeResponse);
  const reviewPrompt = buildReviewerRequestPrompt(chain, { latestAssistantReply });

  runtime.reviewAwaitingVerdictByReviewerThreadId.set(chain.reviewerThreadId, {
    chainId: chain.id,
    mainThreadId: chain.mainThreadId,
    turnId: "",
  });

  chain.status = "awaiting_reviewer";
  chain.updatedAt = new Date().toISOString();
  runtime.reviewChainByMainThreadId.set(chain.mainThreadId, chain);

  try {
    runtime.setThreadBindingKey?.(chain.reviewerThreadId, chain.bindingKey);
    runtime.setThreadWorkspaceRoot?.(chain.reviewerThreadId, chain.workspaceRoot);
    await runtime.ensureThreadResumed?.(chain.reviewerThreadId);
    await runtime.codex.sendUserMessage({
      threadId: chain.reviewerThreadId,
      text: reviewPrompt,
      model: REVIEWER_MODEL,
      effort: REVIEWER_EFFORT,
      accessMode: runtime.config.defaultCodexAccessMode,
      workspaceRoot: chain.workspaceRoot,
    });
    runtime.freshThreadIds?.delete(chain.reviewerThreadId);
    runtime.placeholderThreadIds?.delete(chain.reviewerThreadId);
  } catch (error) {
    runtime.reviewAwaitingVerdictByReviewerThreadId.delete(chain.reviewerThreadId);
    throw error;
  }
}

async function handleReviewerTerminal(runtime, {
  reviewerThreadId,
  turnId,
  method,
}) {
  const awaiting = runtime.reviewAwaitingVerdictByReviewerThreadId.get(reviewerThreadId) || null;
  const hasAwaitingVerdict = !!awaiting;

  if (!hasAwaitingVerdict && runtime.reviewerBootstrapPendingThreadIds.has(reviewerThreadId)) {
    runtime.reviewerBootstrapPendingThreadIds.delete(reviewerThreadId);
    await flushPendingReviewDispatch(runtime, reviewerThreadId);
    return;
  }

  if (!awaiting) {
    await flushPendingReviewDispatch(runtime, reviewerThreadId);
    return;
  }

  if (awaiting.turnId && turnId && awaiting.turnId !== turnId) {
    return;
  }

  runtime.reviewAwaitingVerdictByReviewerThreadId.delete(reviewerThreadId);
  const chain = runtime.reviewChainByMainThreadId.get(awaiting.mainThreadId) || null;
  if (!chain || chain.id !== awaiting.chainId) {
    await flushPendingReviewDispatch(runtime, reviewerThreadId);
    return;
  }

  if (method !== "turn/completed") {
    await resolveChainAsNeedsHuman(runtime, chain, "reviewer turn did not complete cleanly");
    await flushPendingReviewDispatch(runtime, reviewerThreadId);
    return;
  }

  const resumeResponse = await runtime.codex.resumeThread({ threadId: reviewerThreadId });
  const recentMessages = codexMessageUtils.extractConversationFromResumeResponse(resumeResponse, {
    turnLimit: 2,
  });
  const latestAssistantReply = findLatestAssistantReply(recentMessages);
  const verdict = parseReviewerVerdict(latestAssistantReply);
  await applyReviewerVerdict(runtime, chain, verdict);
  await flushPendingReviewDispatch(runtime, reviewerThreadId);
}

async function applyReviewerVerdict(runtime, chain, verdict) {
  if (!chain) {
    return;
  }

  if (verdict.kind === "continue") {
    chain.continueCount += 1;
    if (chain.continueCount >= REVIEW_LOOP_LIMIT) {
      chain.bypassAfterLimit = true;
    }
    chain.status = "running_main";
    chain.updatedAt = new Date().toISOString();
    runtime.reviewChainByMainThreadId.set(chain.mainThreadId, chain);
    try {
      await sendSyntheticContinue(runtime, chain, verdict.note);
    } catch (error) {
      await resolveChainAsNeedsHuman(runtime, chain, `synthetic continue failed: ${error.message}`);
    }
    return;
  }

  if (verdict.kind === "done") {
    await sendReviewerVerdictCard(runtime, chain, {
      tag: "done",
      note: verdict.note,
    });
    terminateReviewChain(runtime, chain.mainThreadId);
    return;
  }

  if (verdict.kind === "wait_external") {
    chain.status = "waiting_external";
    chain.updatedAt = new Date().toISOString();
    runtime.reviewChainByMainThreadId.set(chain.mainThreadId, chain);
    persistWaitingExternalReview(runtime, chain);
    await finalizeMainReplyCardForWaitExternal(runtime, chain);
    await sendReviewerVerdictCard(runtime, chain, {
      tag: "wait_external",
      note: verdict.note,
    });
    return;
  }

  await resolveChainAsNeedsHuman(runtime, chain, verdict.note || "reviewer response was not actionable");
}

async function resolveChainAsNeedsHuman(runtime, chain, note) {
  await sendReviewerVerdictCard(runtime, chain, {
    tag: "needs_human",
    note,
  });
  terminateReviewChain(runtime, chain.mainThreadId);
}

async function sendSyntheticContinue(runtime, chain, note) {
  const syntheticNormalized = {
    provider: "review",
    workspaceId: "internal",
    chatId: chain.chatId,
    threadKey: "",
    senderId: "reviewer",
    messageId: chain.replyToMessageId,
    text: buildSyntheticContinueText(note),
    command: "message",
    receivedAt: new Date().toISOString(),
  };
  runtime.pendingSyntheticContinueChainIdByMainThreadId.set(chain.mainThreadId, chain.id);
  runtime.setPendingThreadContext(chain.mainThreadId, syntheticNormalized);
  await runtime.ensureThreadAndSendMessage({
    bindingKey: chain.bindingKey,
    workspaceRoot: chain.workspaceRoot,
    normalized: syntheticNormalized,
    threadId: chain.mainThreadId,
    reviewSendOptions: {
      isSyntheticContinue: true,
      chainId: chain.id,
    },
  });
}

async function createReviewerThread(runtime, {
  bindingKey,
  workspaceRoot,
  mainThreadId,
}) {
  const reviewerThread = await runtime.codex.startThread({ cwd: workspaceRoot });
  const reviewerThreadId = codexMessageUtils.extractThreadId(reviewerThread);
  if (!reviewerThreadId) {
    throw new Error("无法为 long 模式创建 reviewer 线程。");
  }

  const sessionPath = codexMessageUtils.extractThreadPath(reviewerThread);
  runtime.setThreadBindingKey(reviewerThreadId, bindingKey);
  runtime.setThreadWorkspaceRoot(reviewerThreadId, workspaceRoot);
  runtime.resumedThreadIds?.add(reviewerThreadId);
  runtime.freshThreadIds?.add(reviewerThreadId);
  runtime.placeholderThreadIds?.add(reviewerThreadId);
  if (sessionPath) {
    runtime.threadSessionPathByThreadId.set(reviewerThreadId, sessionPath);
  }
  return reviewerThreadId;
}

async function tryRecoverMissingReviewerThread(runtime, chain, error) {
  if (!chain || !isMissingReviewerThreadError(error)) {
    return false;
  }

  const previousReviewerThreadId = normalizeIdentifier(chain.reviewerThreadId);
  if (!previousReviewerThreadId) {
    return false;
  }

  console.warn(
    `[codex-im] reviewer thread missing for main=${chain.mainThreadId}; recreating reviewer thread`
  );
  runtime.reviewerBootstrapPendingThreadIds.delete(previousReviewerThreadId);
  clearReviewerReferences(runtime, chain);

  const longModeRecord = getLongModeRecord(runtime, chain.mainThreadId) || {
    bindingKey: chain.bindingKey,
    enabled: true,
    reviewerThreadId: previousReviewerThreadId,
  };
  const reviewerThreadId = await createReviewerThread(runtime, {
    bindingKey: chain.bindingKey,
    workspaceRoot: chain.workspaceRoot,
    mainThreadId: chain.mainThreadId,
  });
  persistLongModeRecord(runtime, chain.bindingKey, chain.mainThreadId, {
    ...longModeRecord,
    bindingKey: chain.bindingKey,
    enabled: true,
    reviewerThreadId,
  });
  chain.reviewerThreadId = reviewerThreadId;
  chain.status = "running_main";
  chain.updatedAt = new Date().toISOString();
  runtime.reviewChainByMainThreadId.set(chain.mainThreadId, chain);
  return true;
}

async function flushPendingReviewDispatch(runtime, reviewerThreadId) {
  const pending = runtime.pendingReviewDispatchByReviewerThreadId.get(reviewerThreadId) || null;
  if (!pending) {
    return;
  }
  runtime.pendingReviewDispatchByReviewerThreadId.delete(reviewerThreadId);
  const chain = runtime.reviewChainByMainThreadId.get(pending.mainThreadId) || null;
  if (!chain || chain.id !== pending.chainId) {
    return;
  }
  await dispatchOrQueueReview(runtime, chain);
}

function terminateReviewChain(runtime, mainThreadId) {
  const normalizedMainThreadId = normalizeIdentifier(mainThreadId);
  if (!normalizedMainThreadId) {
    return;
  }

  const chain = runtime.reviewChainByMainThreadId.get(normalizedMainThreadId) || null;
  const bindingKey = normalizeIdentifier(chain?.bindingKey)
    || normalizeIdentifier(getLongModeRecord(runtime, normalizedMainThreadId)?.bindingKey);
  if (chain?.reviewerThreadId) {
    clearReviewerReferences(runtime, chain);
  }
  clearPersistedWaitingExternalReview(runtime, bindingKey, normalizedMainThreadId);
  runtime.reviewChainByMainThreadId.delete(normalizedMainThreadId);
  runtime.pendingSyntheticContinueChainIdByMainThreadId.delete(normalizedMainThreadId);
}

function clearReviewerReferences(runtime, chain) {
  const reviewerThreadId = normalizeIdentifier(chain?.reviewerThreadId);
  if (!reviewerThreadId) {
    return;
  }

  const queued = runtime.pendingReviewDispatchByReviewerThreadId.get(reviewerThreadId);
  if (queued?.chainId === chain.id) {
    runtime.pendingReviewDispatchByReviewerThreadId.delete(reviewerThreadId);
  }
  const awaiting = runtime.reviewAwaitingVerdictByReviewerThreadId.get(reviewerThreadId);
  if (awaiting?.chainId === chain.id) {
    runtime.reviewAwaitingVerdictByReviewerThreadId.delete(reviewerThreadId);
  }
}

function persistLongModeRecord(runtime, bindingKey, mainThreadId, entry) {
  const previous = runtime.longModeByMainThreadId.get(mainThreadId) || null;
  runtime.sessionStore.setLongModeForThread(bindingKey, mainThreadId, {
    enabled: entry.enabled === true,
    reviewerThreadId: entry.reviewerThreadId,
  });

  const stored = runtime.sessionStore.getLongModeForThread(bindingKey, mainThreadId);
  if (previous?.reviewerThreadId && previous.reviewerThreadId !== stored?.reviewerThreadId) {
    runtime.reviewerMainThreadIdByReviewerThreadId.delete(previous.reviewerThreadId);
  }
  runtime.longModeByMainThreadId.set(mainThreadId, {
    bindingKey,
    enabled: stored?.enabled === true,
    reviewerThreadId: normalizeIdentifier(stored?.reviewerThreadId),
    createdAt: normalizeIdentifier(stored?.createdAt),
    updatedAt: normalizeIdentifier(stored?.updatedAt),
  });
  if (stored?.reviewerThreadId) {
    runtime.reviewerMainThreadIdByReviewerThreadId.set(stored.reviewerThreadId, mainThreadId);
  }
}

function getLongModeRecord(runtime, mainThreadId) {
  return runtime.longModeByMainThreadId.get(normalizeIdentifier(mainThreadId)) || null;
}

async function sendReviewerVerdictCard(runtime, chain, {
  tag,
  note = "",
}) {
  if (!chain?.chatId || !tag) {
    return;
  }

  await runtime.sendInteractiveCard({
    chatId: chain.chatId,
    replyToMessageId: chain.replyToMessageId,
    card: runtime.buildReviewVerdictCard({
      tag,
      note,
      mainThreadId: chain.mainThreadId,
      reviewerThreadId: chain.reviewerThreadId,
    }),
  });
}

async function finalizeMainReplyCardForWaitExternal(runtime, chain) {
  const threadId = normalizeIdentifier(chain?.mainThreadId);
  const chatId = normalizeIdentifier(chain?.chatId);
  if (!threadId || !chatId) {
    return;
  }

  try {
    await runtime.upsertAssistantReplyCard({
      threadId,
      turnId: normalizeIdentifier(chain?.latestMainTurnId),
      chatId,
      state: "completed",
    });
  } catch (error) {
    console.error(`[codex-im] failed to finalize wait_external reply card: ${error.message}`);
  }
}

function parseReviewerVerdict(text) {
  const normalizedText = String(text || "").trim();
  if (!normalizedText) {
    return { kind: "needs_human", note: "empty reviewer response" };
  }

  const firstLine = normalizedText.split("\n").find((line) => String(line || "").trim()) || "";
  const normalizedLine = firstLine.trim();
  const lower = normalizedLine.toLowerCase();
  if (lower === "done") {
    return { kind: "done", note: "" };
  }
  if (lower.startsWith("continue:")) {
    const note = normalizedLine.slice("continue:".length).trim();
    return {
      kind: "continue",
      note: note || "finish the remaining work before stopping.",
    };
  }
  if (lower.startsWith("wait_external:")) {
    return {
      kind: "wait_external",
      note: normalizedLine.slice("wait_external:".length).trim() || "waiting for the planned external resume",
    };
  }
  if (lower.startsWith("needs_human:")) {
    return {
      kind: "needs_human",
      note: normalizedLine.slice("needs_human:".length).trim() || "reviewer requested human input",
    };
  }
  return {
    kind: "needs_human",
    note: "malformed reviewer response",
  };
}

function buildSyntheticContinueText(note) {
  const normalizedNote = normalizeIdentifier(note);
  return normalizedNote
    ? `${SYNTHETIC_CONTINUE_PREFIX} ${normalizedNote}`
    : `${SYNTHETIC_CONTINUE_PREFIX} continue working until the user request is fully completed.`;
}

function buildReviewerRequestPrompt(chain, { latestAssistantReply }) {
  const currentUserRequest = normalizeIdentifier(chain?.userText) || "(missing)";
  const normalizedLatestAssistantReply = normalizeIdentifier(latestAssistantReply) || "(missing)";

  return [
    "You are the companion reviewer for a long-running Codex main thread.",
    `Main thread id: ${normalizeIdentifier(chain?.mainThreadId) || "(missing)"}`,
    "Do not do the work yourself. Judge only whether the current user request is fully completed from the provided goal, evidence, latest assistant reply, and current state.",
    "",
    "Review the latest completion attempt for the long-running main thread.",
    "Decide whether the current user request is fully completed.",
    "",
    "Current user request:",
    currentUserRequest,
    "",
    "Latest main assistant reply (all assistant messages from this main-thread turn):",
    normalizedLatestAssistantReply,
    "",
    "Answer with a first line that starts with exactly one of:",
    "done",
    "continue: <short instruction>",
    "wait_external: <short note>",
    "needs_human: <short note>",
    "Use continue when requested work is still unfinished and the main thread should actively keep working now.",
    "Use wait_external when the main thread has intentionally queued a planned external resume or wake-up, such as a SLURM wakeup job, and should stay idle until that resume happens. Do not use continue for planned waiting.",
    "Use needs_human only when real human input, a risky decision, or an external blocker is required. Keep the note short.",
    "If the main thread has already scheduled a planned external resume or wake-up, such as a SLURM wakeup job, prefer wait_external over continue.",
  ].join("\n");
}

function extractLatestTurnAssistantReply(resumeResponse) {
  const recentMessages = codexMessageUtils.extractConversationFromResumeResponse(resumeResponse, {
    turnLimit: 1,
  });

  return findLatestAssistantReply(recentMessages, { includeAllAssistantMessages: true });
}

function findLatestAssistantReply(messages, { includeAllAssistantMessages = false } = {}) {
  if (!Array.isArray(messages)) {
    return "";
  }

  if (includeAllAssistantMessages) {
    return messages
      .filter((message) => message?.role === "assistant")
      .map((message) => normalizeIdentifier(message?.text))
      .filter(Boolean)
      .join("\n\n");
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant" && normalizeIdentifier(message?.text)) {
      return message.text.trim();
    }
  }
  return "";
}

function createReviewChainId(mainThreadId) {
  return `${mainThreadId}:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`;
}

function persistWaitingExternalReview(runtime, chain) {
  if (
    !chain
    || chain.status !== "waiting_external"
    || typeof runtime.sessionStore?.setWaitingExternalReviewForThread !== "function"
  ) {
    return;
  }

  runtime.sessionStore.setWaitingExternalReviewForThread(chain.bindingKey, chain.mainThreadId, {
    id: chain.id,
    workspaceRoot: chain.workspaceRoot,
    reviewerThreadId: chain.reviewerThreadId,
    chatId: chain.chatId,
    replyToMessageId: chain.replyToMessageId,
    userText: chain.userText,
    continueCount: chain.continueCount,
    bypassAfterLimit: chain.bypassAfterLimit,
    latestMainTurnId: chain.latestMainTurnId,
    lastReviewRequestedTurnId: chain.lastReviewRequestedTurnId,
  });
}

function clearPersistedWaitingExternalReview(runtime, bindingKey, mainThreadId) {
  if (
    !bindingKey
    || !mainThreadId
    || typeof runtime.sessionStore?.clearWaitingExternalReviewForThread !== "function"
  ) {
    return;
  }

  runtime.sessionStore.clearWaitingExternalReviewForThread(bindingKey, mainThreadId);
}

function normalizeNonNegativeInteger(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return fallback;
  }
  return Math.floor(numeric);
}

function normalizeIdentifier(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function isMissingReviewerThreadError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return message.includes("thread not found");
}

module.exports = {
  buildReviewerRequestPrompt,
  buildSyntheticContinueText,
  decorateThreadForDisplay,
  disableLongModeForThread,
  ensureLongModeForMainThread,
  getLongModeRecord,
  handleCodexLifecycleEvent,
  handleLongCommand,
  handleMainTurnCompleted,
  handleSuppressedCodexMessage,
  hydratePersistedLongMode,
  isReviewerThreadId,
  parseReviewerVerdict,
  recordAcceptedSend,
  resolveConversationThreadSelection,
  shouldSuppressUserDelivery,
};
