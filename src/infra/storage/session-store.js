const fs = require("fs");
const path = require("path");
const { normalizeModelCatalog } = require("../../shared/model-catalog");
const DEBUG_LOG_PATH = "/tmp/codex-im-thread-debug.log";

class SessionStore {
  constructor({ filePath }) {
    this.filePath = filePath;
    this.state = createEmptyState();
    this.ensureParentDirectory();
    this.load();
  }

  ensureParentDirectory() {
    const parentDirectory = path.dirname(this.filePath);
    fs.mkdirSync(parentDirectory, { recursive: true });
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && parsed.bindings) {
        this.state = {
          ...createEmptyState(),
          ...parsed,
          bindings: parsed.bindings || {},
          approvalCommandAllowlistByWorkspaceRoot: parsed.approvalCommandAllowlistByWorkspaceRoot || {},
          availableModelCatalog: parsed.availableModelCatalog || {
            models: [],
            updatedAt: "",
          },
        };
      }
    } catch {
      this.state = createEmptyState();
    }
  }

  save() {
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
  }

  getBinding(bindingKey) {
    return this.state.bindings[bindingKey] || null;
  }

  getLongModeForThread(bindingKey, threadId) {
    const normalizedThreadId = normalizeValue(threadId);
    if (!normalizedThreadId) {
      return null;
    }

    const binding = this.getBinding(bindingKey) || {};
    const entry = getLongModeMap(binding)[normalizedThreadId];
    if (!entry || typeof entry !== "object") {
      return null;
    }

    return {
      enabled: entry.enabled === true,
      reviewerThreadId: normalizeValue(entry.reviewerThreadId),
      createdAt: normalizeValue(entry.createdAt),
      updatedAt: normalizeValue(entry.updatedAt),
    };
  }

  setLongModeForThread(bindingKey, threadId, {
    enabled = false,
    reviewerThreadId = "",
  } = {}) {
    const normalizedThreadId = normalizeValue(threadId);
    if (!normalizedThreadId) {
      return this.getBinding(bindingKey);
    }

    const current = this.getBinding(bindingKey) || {};
    const longModeByThreadId = getLongModeMap(current);
    const previous = longModeByThreadId[normalizedThreadId];
    longModeByThreadId[normalizedThreadId] = {
      enabled: enabled === true,
      reviewerThreadId: normalizeValue(reviewerThreadId) || normalizeValue(previous?.reviewerThreadId),
      createdAt: normalizeValue(previous?.createdAt) || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    return this.updateBinding(bindingKey, {
      ...current,
      longModeByThreadId,
    });
  }

  listLongModeEntries() {
    const entries = [];
    for (const [bindingKey, binding] of Object.entries(this.state.bindings || {})) {
      const longModeByThreadId = getLongModeMap(binding);
      for (const [mainThreadId, rawEntry] of Object.entries(longModeByThreadId)) {
        if (!mainThreadId || !rawEntry || typeof rawEntry !== "object") {
          continue;
        }
        entries.push({
          bindingKey,
          mainThreadId,
          enabled: rawEntry.enabled === true,
          reviewerThreadId: normalizeValue(rawEntry.reviewerThreadId),
          createdAt: normalizeValue(rawEntry.createdAt),
          updatedAt: normalizeValue(rawEntry.updatedAt),
        });
      }
    }
    return entries;
  }

  findMainThreadIdByReviewerThreadId(reviewerThreadId) {
    const normalizedReviewerThreadId = normalizeValue(reviewerThreadId);
    if (!normalizedReviewerThreadId) {
      return null;
    }

    for (const entry of this.listLongModeEntries()) {
      if (entry.reviewerThreadId === normalizedReviewerThreadId) {
        return entry;
      }
    }

    return null;
  }

  getWaitingExternalReviewForThread(bindingKey, threadId) {
    const normalizedThreadId = normalizeValue(threadId);
    if (!normalizedThreadId) {
      return null;
    }

    const binding = this.getBinding(bindingKey) || {};
    const entry = getWaitingExternalReviewMap(binding)[normalizedThreadId];
    return normalizeWaitingExternalReview(entry);
  }

  setWaitingExternalReviewForThread(bindingKey, threadId, review = {}) {
    const normalizedThreadId = normalizeValue(threadId);
    if (!normalizedThreadId) {
      return this.getBinding(bindingKey);
    }

    const current = this.getBinding(bindingKey) || {};
    const waitingExternalReviewByThreadId = getWaitingExternalReviewMap(current);
    const previous = normalizeWaitingExternalReview(waitingExternalReviewByThreadId[normalizedThreadId]) || {};
    waitingExternalReviewByThreadId[normalizedThreadId] = {
      id: normalizeValue(review.id) || previous.id || "",
      workspaceRoot: normalizeValue(review.workspaceRoot) || previous.workspaceRoot || "",
      reviewerThreadId: normalizeValue(review.reviewerThreadId) || previous.reviewerThreadId || "",
      chatId: normalizeValue(review.chatId) || previous.chatId || "",
      replyToMessageId: normalizeValue(review.replyToMessageId) || previous.replyToMessageId || "",
      userText: normalizeValue(review.userText) || previous.userText || "",
      continueCount: normalizeNonNegativeInteger(review.continueCount, previous.continueCount || 0),
      bypassAfterLimit: review.bypassAfterLimit === true || previous.bypassAfterLimit === true,
      latestMainTurnId: normalizeValue(review.latestMainTurnId) || previous.latestMainTurnId || "",
      lastReviewRequestedTurnId: normalizeValue(review.lastReviewRequestedTurnId) || previous.lastReviewRequestedTurnId || "",
      createdAt: normalizeValue(previous.createdAt) || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    return this.updateBinding(bindingKey, {
      ...current,
      waitingExternalReviewByThreadId,
    });
  }

  clearWaitingExternalReviewForThread(bindingKey, threadId) {
    const normalizedThreadId = normalizeValue(threadId);
    if (!normalizedThreadId) {
      return this.getBinding(bindingKey);
    }

    const current = this.getBinding(bindingKey) || {};
    const waitingExternalReviewByThreadId = getWaitingExternalReviewMap(current);
    delete waitingExternalReviewByThreadId[normalizedThreadId];

    return this.updateBinding(bindingKey, {
      ...current,
      waitingExternalReviewByThreadId,
    });
  }

  listWaitingExternalReviewEntries() {
    const entries = [];
    for (const [bindingKey, binding] of Object.entries(this.state.bindings || {})) {
      const waitingExternalReviewByThreadId = getWaitingExternalReviewMap(binding);
      for (const [mainThreadId, rawEntry] of Object.entries(waitingExternalReviewByThreadId)) {
        const entry = normalizeWaitingExternalReview(rawEntry);
        if (!mainThreadId || !entry) {
          continue;
        }
        entries.push({
          bindingKey,
          mainThreadId,
          ...entry,
        });
      }
    }
    return entries;
  }

  getActiveWorkspaceRoot(bindingKey) {
    return this.state.bindings[bindingKey]?.activeWorkspaceRoot || "";
  }

  setActiveWorkspaceRoot(bindingKey, workspaceRoot) {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    const current = this.getBinding(bindingKey) || { threadIdByWorkspaceRoot: {} };
    const threadIdByWorkspaceRoot = getThreadMap(current);
    if (normalizedWorkspaceRoot && !(normalizedWorkspaceRoot in threadIdByWorkspaceRoot)) {
      threadIdByWorkspaceRoot[normalizedWorkspaceRoot] = "";
    }

    return this.updateBinding(bindingKey, {
      ...current,
      activeWorkspaceRoot: normalizedWorkspaceRoot,
      threadIdByWorkspaceRoot,
    });
  }

  getThreadIdForWorkspace(bindingKey, workspaceRoot) {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return "";
    }
    const selectedThreadId = this.state.bindings[bindingKey]?.threadIdByWorkspaceRoot?.[normalizedWorkspaceRoot] || "";
    const reviewerEntry = this.findMainThreadIdByReviewerThreadId(selectedThreadId);
    if (!reviewerEntry) {
      return selectedThreadId;
    }
    return reviewerEntry.mainThreadId || "";
  }

  setThreadIdForWorkspace(bindingKey, workspaceRoot, threadId, extra = {}) {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return this.getBinding(bindingKey);
    }

    const current = this.getBinding(bindingKey) || {};
    const threadIdByWorkspaceRoot = {
      ...getThreadMap(current),
      [normalizedWorkspaceRoot]: threadId,
    };

    return this.updateBinding(bindingKey, {
      ...current,
      ...extra,
      activeWorkspaceRoot: normalizedWorkspaceRoot,
      threadIdByWorkspaceRoot,
    });
  }

  clearThreadIdForWorkspace(bindingKey, workspaceRoot) {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return this.getBinding(bindingKey);
    }

    const current = this.getBinding(bindingKey) || {};
    const threadIdByWorkspaceRoot = {
      ...getThreadMap(current),
      [normalizedWorkspaceRoot]: "",
    };

    return this.updateBinding(bindingKey, {
      ...current,
      threadIdByWorkspaceRoot,
    });
  }

  getCodexParamsForWorkspace(bindingKey, workspaceRoot) {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return { model: "", effort: "" };
    }
    const raw = this.state.bindings[bindingKey]?.codexParamsByWorkspaceRoot?.[normalizedWorkspaceRoot];
    if (!raw || typeof raw !== "object") {
      return { model: "", effort: "" };
    }
    return {
      model: normalizeValue(raw.model),
      effort: normalizeValue(raw.effort),
    };
  }

  setCodexParamsForWorkspace(bindingKey, workspaceRoot, { model, effort }) {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return this.getBinding(bindingKey);
    }

    const current = this.getBinding(bindingKey) || {};
    const codexParamsByWorkspaceRoot = {
      ...getCodexParamsMap(current),
      [normalizedWorkspaceRoot]: {
        model: normalizeValue(model),
        effort: normalizeValue(effort),
      },
    };

    return this.updateBinding(bindingKey, {
      ...current,
      codexParamsByWorkspaceRoot,
    });
  }

  getDeliveryContextForWorkspace(bindingKey, workspaceRoot) {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return null;
    }

    const raw = getDeliveryContextMap(this.getBinding(bindingKey))[normalizedWorkspaceRoot];
    return normalizeDeliveryContext(raw);
  }

  setDeliveryContextForWorkspace(bindingKey, workspaceRoot, {
    chatId = "",
    threadKey = "",
    lastSourceMessageId = "",
  } = {}) {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return this.getBinding(bindingKey);
    }

    const current = this.getBinding(bindingKey) || {};
    const deliveryContextByWorkspaceRoot = getDeliveryContextMap(current);
    deliveryContextByWorkspaceRoot[normalizedWorkspaceRoot] = {
      chatId: normalizeValue(chatId),
      threadKey: normalizeValue(threadKey),
      lastSourceMessageId: normalizeValue(lastSourceMessageId),
      updatedAt: new Date().toISOString(),
    };

    return this.updateBinding(bindingKey, {
      ...current,
      deliveryContextByWorkspaceRoot,
    });
  }

  getSessionSyncStateForWorkspace(bindingKey, workspaceRoot) {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return null;
    }

    const raw = getSessionSyncMap(this.getBinding(bindingKey))[normalizedWorkspaceRoot];
    return normalizeSessionSyncState(raw);
  }

  setSessionSyncStateForWorkspace(bindingKey, workspaceRoot, nextState = {}) {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return this.getBinding(bindingKey);
    }

    const current = this.getBinding(bindingKey) || {};
    const sessionSyncByWorkspaceRoot = getSessionSyncMap(current);
    const previous = normalizeSessionSyncState(sessionSyncByWorkspaceRoot[normalizedWorkspaceRoot]) || {};
    sessionSyncByWorkspaceRoot[normalizedWorkspaceRoot] = {
      ...previous,
      threadId: normalizeValue(nextState.threadId) || previous.threadId || "",
      sessionPath: normalizeValue(nextState.sessionPath) || previous.sessionPath || "",
      readOffset: normalizeNonNegativeInteger(nextState.readOffset, previous.readOffset || 0),
      lastRecordKey: normalizeValue(nextState.lastRecordKey) || previous.lastRecordKey || "",
      lastTurnId: normalizeValue(nextState.lastTurnId) || previous.lastTurnId || "",
      lastSeenThreadUpdatedAt: normalizeNonNegativeInteger(
        nextState.lastSeenThreadUpdatedAt,
        previous.lastSeenThreadUpdatedAt || 0
      ),
      updatedAt: new Date().toISOString(),
    };

    return this.updateBinding(bindingKey, {
      ...current,
      sessionSyncByWorkspaceRoot,
    });
  }

  clearSessionSyncStateForWorkspace(bindingKey, workspaceRoot) {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return this.getBinding(bindingKey);
    }

    const current = this.getBinding(bindingKey) || {};
    const sessionSyncByWorkspaceRoot = getSessionSyncMap(current);
    delete sessionSyncByWorkspaceRoot[normalizedWorkspaceRoot];

    return this.updateBinding(bindingKey, {
      ...current,
      sessionSyncByWorkspaceRoot,
    });
  }

  getSummaryCardStateForWorkspace(bindingKey, workspaceRoot) {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return null;
    }

    const raw = getSummaryCardStateMap(this.getBinding(bindingKey))[normalizedWorkspaceRoot];
    return normalizeSummaryCardState(raw);
  }

  setSummaryCardStateForWorkspace(bindingKey, workspaceRoot, nextState = {}) {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return this.getBinding(bindingKey);
    }

    const current = this.getBinding(bindingKey) || {};
    const summaryCardStateByWorkspaceRoot = getSummaryCardStateMap(current);
    const previous = normalizeSummaryCardState(summaryCardStateByWorkspaceRoot[normalizedWorkspaceRoot]) || {};
    summaryCardStateByWorkspaceRoot[normalizedWorkspaceRoot] = {
      ...previous,
      messageId: normalizeValue(nextState.messageId) || previous.messageId || "",
      threadId: normalizeValue(nextState.threadId) || previous.threadId || "",
      turnId: normalizeValue(nextState.turnId) || previous.turnId || "",
      state: normalizeValue(nextState.state) || previous.state || "",
      updatedAt: new Date().toISOString(),
    };

    return this.updateBinding(bindingKey, {
      ...current,
      summaryCardStateByWorkspaceRoot,
    });
  }

  clearSummaryCardStateForWorkspace(bindingKey, workspaceRoot) {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return this.getBinding(bindingKey);
    }

    const current = this.getBinding(bindingKey) || {};
    const summaryCardStateByWorkspaceRoot = getSummaryCardStateMap(current);
    delete summaryCardStateByWorkspaceRoot[normalizedWorkspaceRoot];

    return this.updateBinding(bindingKey, {
      ...current,
      summaryCardStateByWorkspaceRoot,
    });
  }

  listTrackedWorkspaceThreads() {
    const entries = [];
    for (const [bindingKey, binding] of Object.entries(this.state.bindings || {})) {
      const threadIdByWorkspaceRoot = getThreadMap(binding);
      for (const [workspaceRoot, rawThreadId] of Object.entries(threadIdByWorkspaceRoot)) {
        const threadId = normalizeValue(rawThreadId);
        if (!workspaceRoot || !threadId) {
          continue;
        }

        entries.push({
          bindingKey,
          workspaceRoot,
          threadId,
          deliveryContext: normalizeDeliveryContext(getDeliveryContextMap(binding)[workspaceRoot]),
          sessionSyncState: normalizeSessionSyncState(getSessionSyncMap(binding)[workspaceRoot]),
          summaryCardState: normalizeSummaryCardState(getSummaryCardStateMap(binding)[workspaceRoot]),
        });
      }
    }
    return entries;
  }

  findTrackedBindingsByThreadId(threadId) {
    const normalizedThreadId = normalizeValue(threadId);
    if (!normalizedThreadId) {
      return [];
    }

    return this.listTrackedWorkspaceThreads()
      .filter((entry) => entry.threadId === normalizedThreadId)
      .sort((left, right) => {
        const leftUpdatedAt = Date.parse(left.deliveryContext?.updatedAt || "") || 0;
        const rightUpdatedAt = Date.parse(right.deliveryContext?.updatedAt || "") || 0;
        return rightUpdatedAt - leftUpdatedAt;
      });
  }

  getApprovalCommandAllowlistForWorkspace(workspaceRoot) {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return [];
    }
    const allowlist = this.state.approvalCommandAllowlistByWorkspaceRoot?.[normalizedWorkspaceRoot];
    if (!Array.isArray(allowlist)) {
      return [];
    }
    return normalizeCommandAllowlist(allowlist);
  }

  getAvailableModelCatalog() {
    const raw = this.state.availableModelCatalog;
    if (!raw || typeof raw !== "object") {
      return null;
    }
    const models = normalizeModelCatalog(raw.models);
    if (!models.length) {
      return null;
    }
    const updatedAt = normalizeValue(raw.updatedAt);
    return {
      models,
      updatedAt,
    };
  }

  setAvailableModelCatalog(models) {
    const normalizedModels = normalizeModelCatalog(models);
    if (!normalizedModels.length) {
      return null;
    }

    this.state.availableModelCatalog = {
      models: normalizedModels,
      updatedAt: new Date().toISOString(),
    };
    this.save();
    return this.state.availableModelCatalog;
  }

  rememberApprovalCommandPrefixForWorkspace(workspaceRoot, commandTokens) {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    const normalizedTokens = normalizeCommandTokens(commandTokens);
    if (!normalizedWorkspaceRoot || !normalizedTokens.length) {
      return null;
    }

    const currentAllowlist = this.getApprovalCommandAllowlistForWorkspace(normalizedWorkspaceRoot);
    const exists = currentAllowlist.some((prefix) => (
      prefix.length === normalizedTokens.length
      && prefix.every((token, index) => token === normalizedTokens[index])
    ));
    if (exists) {
      return currentAllowlist;
    }

    this.state.approvalCommandAllowlistByWorkspaceRoot = {
      ...(this.state.approvalCommandAllowlistByWorkspaceRoot || {}),
      [normalizedWorkspaceRoot]: [...currentAllowlist, normalizedTokens],
    };
    this.save();
    return this.state.approvalCommandAllowlistByWorkspaceRoot[normalizedWorkspaceRoot];
  }

  removeWorkspace(bindingKey, workspaceRoot) {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return this.getBinding(bindingKey);
    }

    const current = this.getBinding(bindingKey) || {};
    const threadIdByWorkspaceRoot = getThreadMap(current);
    const codexParamsByWorkspaceRoot = getCodexParamsMap(current);
    const deliveryContextByWorkspaceRoot = getDeliveryContextMap(current);
    const sessionSyncByWorkspaceRoot = getSessionSyncMap(current);
    const summaryCardStateByWorkspaceRoot = getSummaryCardStateMap(current);
    const waitingExternalReviewByThreadId = getWaitingExternalReviewMap(current);
    const hasWorkspaceEntry = Object.prototype.hasOwnProperty.call(
      threadIdByWorkspaceRoot,
      normalizedWorkspaceRoot
    );
    const activeWorkspaceRoot = normalizeValue(current.activeWorkspaceRoot);
    if (!hasWorkspaceEntry && activeWorkspaceRoot !== normalizedWorkspaceRoot) {
      return current;
    }

    delete threadIdByWorkspaceRoot[normalizedWorkspaceRoot];
    delete codexParamsByWorkspaceRoot[normalizedWorkspaceRoot];
    delete deliveryContextByWorkspaceRoot[normalizedWorkspaceRoot];
    delete sessionSyncByWorkspaceRoot[normalizedWorkspaceRoot];
    delete summaryCardStateByWorkspaceRoot[normalizedWorkspaceRoot];

    for (const [mainThreadId, rawEntry] of Object.entries(waitingExternalReviewByThreadId)) {
      if (normalizeValue(rawEntry?.workspaceRoot) === normalizedWorkspaceRoot) {
        delete waitingExternalReviewByThreadId[mainThreadId];
      }
    }

    const nextActiveWorkspaceRoot = activeWorkspaceRoot === normalizedWorkspaceRoot
      ? (Object.keys(threadIdByWorkspaceRoot).sort((left, right) => left.localeCompare(right))[0] || "")
      : activeWorkspaceRoot;

    return this.updateBinding(bindingKey, {
      ...current,
      activeWorkspaceRoot: nextActiveWorkspaceRoot,
      codexParamsByWorkspaceRoot,
      deliveryContextByWorkspaceRoot,
      sessionSyncByWorkspaceRoot,
      summaryCardStateByWorkspaceRoot,
      waitingExternalReviewByThreadId,
      threadIdByWorkspaceRoot,
    });
  }

  updateBinding(bindingKey, nextBinding) {
    this.state.bindings[bindingKey] = {
      ...nextBinding,
      updatedAt: new Date().toISOString(),
    };
    this.save();
    return this.state.bindings[bindingKey];
  }

  buildBindingKey({ workspaceId, chatId, chatType, threadKey, senderId, messageId }) {
    const normalizedThreadKey = normalizeValue(threadKey);
    const normalizedMessageId = normalizeValue(messageId);
    const normalizedChatType = normalizeValue(chatType).toLowerCase();
    const normalizedSenderId = normalizeValue(senderId);
    const hasStableThreadKey = normalizedThreadKey && normalizedThreadKey !== normalizedMessageId;
    const senderBindingKey = `${workspaceId}:${chatId}:sender:${normalizedSenderId}`;

    if (normalizedChatType === "p2p") {
      appendBindingDebugLog({
        workspaceId,
        chatId,
        chatType: normalizedChatType,
        threadKey: normalizedThreadKey,
        senderId: normalizedSenderId,
        messageId: normalizedMessageId,
        selectedBindingKey: senderBindingKey,
        reason: "p2p_sender",
      });
      return senderBindingKey;
    }

    if (hasStableThreadKey) {
      const threadBindingKey = `${workspaceId}:${chatId}:thread:${normalizedThreadKey}`;
      if (this.state.bindings[threadBindingKey]) {
        appendBindingDebugLog({
          workspaceId,
          chatId,
          chatType: normalizedChatType,
          threadKey: normalizedThreadKey,
          senderId: normalizedSenderId,
          messageId: normalizedMessageId,
          selectedBindingKey: threadBindingKey,
          reason: "existing_thread_binding",
        });
        return threadBindingKey;
      }
      if (this.state.bindings[senderBindingKey]) {
        appendBindingDebugLog({
          workspaceId,
          chatId,
          chatType: normalizedChatType,
          threadKey: normalizedThreadKey,
          senderId: normalizedSenderId,
          messageId: normalizedMessageId,
          selectedBindingKey: senderBindingKey,
          reason: "fallback_sender_binding",
        });
        return senderBindingKey;
      }
      appendBindingDebugLog({
        workspaceId,
        chatId,
        chatType: normalizedChatType,
        threadKey: normalizedThreadKey,
        senderId: normalizedSenderId,
        messageId: normalizedMessageId,
        selectedBindingKey: threadBindingKey,
        reason: "new_thread_binding",
      });
      return threadBindingKey;
    }
    appendBindingDebugLog({
      workspaceId,
      chatId,
      chatType: normalizedChatType,
      threadKey: normalizedThreadKey,
      senderId: normalizedSenderId,
      messageId: normalizedMessageId,
      selectedBindingKey: senderBindingKey,
      reason: "default_sender_binding",
    });
    return senderBindingKey;
  }

}

function normalizeValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function createEmptyState() {
  return {
    bindings: {},
    approvalCommandAllowlistByWorkspaceRoot: {},
    availableModelCatalog: {
      models: [],
      updatedAt: "",
    },
  };
}

function getThreadMap(binding) {
  return { ...(binding?.threadIdByWorkspaceRoot || {}) };
}

function getCodexParamsMap(binding) {
  return { ...(binding?.codexParamsByWorkspaceRoot || {}) };
}

function getLongModeMap(binding) {
  return { ...(binding?.longModeByThreadId || {}) };
}

function getDeliveryContextMap(binding) {
  return { ...(binding?.deliveryContextByWorkspaceRoot || {}) };
}

function getWaitingExternalReviewMap(binding) {
  return { ...(binding?.waitingExternalReviewByThreadId || {}) };
}

function getSessionSyncMap(binding) {
  return { ...(binding?.sessionSyncByWorkspaceRoot || {}) };
}

function getSummaryCardStateMap(binding) {
  return { ...(binding?.summaryCardStateByWorkspaceRoot || {}) };
}

function normalizeDeliveryContext(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const chatId = normalizeValue(raw.chatId);
  if (!chatId) {
    return null;
  }
  return {
    chatId,
    threadKey: normalizeValue(raw.threadKey),
    lastSourceMessageId: normalizeValue(raw.lastSourceMessageId),
    updatedAt: normalizeValue(raw.updatedAt),
  };
}

function normalizeSessionSyncState(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const threadId = normalizeValue(raw.threadId);
  if (!threadId) {
    return null;
  }
  return {
    threadId,
    sessionPath: normalizeValue(raw.sessionPath),
    readOffset: normalizeNonNegativeInteger(raw.readOffset, 0),
    lastRecordKey: normalizeValue(raw.lastRecordKey),
    lastTurnId: normalizeValue(raw.lastTurnId),
    lastSeenThreadUpdatedAt: normalizeNonNegativeInteger(raw.lastSeenThreadUpdatedAt, 0),
    updatedAt: normalizeValue(raw.updatedAt),
  };
}

function normalizeSummaryCardState(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const messageId = normalizeValue(raw.messageId);
  if (!messageId) {
    return null;
  }
  return {
    messageId,
    threadId: normalizeValue(raw.threadId),
    turnId: normalizeValue(raw.turnId),
    state: normalizeValue(raw.state),
    updatedAt: normalizeValue(raw.updatedAt),
  };
}

function normalizeWaitingExternalReview(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const reviewerThreadId = normalizeValue(raw.reviewerThreadId);
  const workspaceRoot = normalizeValue(raw.workspaceRoot);
  if (!reviewerThreadId || !workspaceRoot) {
    return null;
  }

  return {
    id: normalizeValue(raw.id),
    workspaceRoot,
    reviewerThreadId,
    chatId: normalizeValue(raw.chatId),
    replyToMessageId: normalizeValue(raw.replyToMessageId),
    userText: normalizeValue(raw.userText),
    continueCount: normalizeNonNegativeInteger(raw.continueCount, 0),
    bypassAfterLimit: raw.bypassAfterLimit === true,
    latestMainTurnId: normalizeValue(raw.latestMainTurnId),
    lastReviewRequestedTurnId: normalizeValue(raw.lastReviewRequestedTurnId),
    createdAt: normalizeValue(raw.createdAt),
    updatedAt: normalizeValue(raw.updatedAt),
  };
}

function normalizeNonNegativeInteger(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return fallback;
  }
  return Math.floor(numeric);
}

function normalizeCommandTokens(tokens) {
  if (!Array.isArray(tokens)) {
    return [];
  }
  return tokens
    .map((token) => (typeof token === "string" ? token.trim() : ""))
    .filter(Boolean);
}

function normalizeCommandAllowlist(allowlist) {
  if (!Array.isArray(allowlist)) {
    return [];
  }
  return allowlist
    .map((tokens) => normalizeCommandTokens(tokens))
    .filter((tokens) => tokens.length > 0);
}

function appendBindingDebugLog(record) {
  try {
    fs.appendFileSync(DEBUG_LOG_PATH, `${JSON.stringify({
      timestamp: new Date().toISOString(),
      stage: "buildBindingKey",
      ...record,
    })}\n`);
  } catch {}
}

module.exports = { SessionStore };
