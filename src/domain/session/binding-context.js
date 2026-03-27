const MAX_PENDING_BINDING_CONTEXT_ENTRIES = 300;
const MAX_PENDING_THREAD_CONTEXT_ENTRIES = 500;
const MAX_REPLY_CARD_ENTRIES = 500;
const MAX_THREAD_CONTEXT_CACHE_ENTRIES = 500;

function resolveWorkspaceRootForBinding(runtime, bindingKey) {
  const active = runtime.sessionStore.getActiveWorkspaceRoot(bindingKey);
  return typeof active === "string" && active.trim() ? active.trim() : "";
}

function resolveThreadIdForBinding(runtime, bindingKey, workspaceRoot) {
  return runtime.sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
}

function setThreadBindingKey(runtime, threadId, bindingKey) {
  if (!threadId || !bindingKey) {
    return;
  }
  setBoundedMapEntry(runtime, runtime.bindingKeyByThreadId, threadId, bindingKey, MAX_THREAD_CONTEXT_CACHE_ENTRIES);
}

function setThreadWorkspaceRoot(runtime, threadId, workspaceRoot) {
  if (!threadId || !workspaceRoot) {
    return;
  }
  setBoundedMapEntry(
    runtime,
    runtime.workspaceRootByThreadId,
    threadId,
    workspaceRoot,
    MAX_THREAD_CONTEXT_CACHE_ENTRIES
  );
}

function setPendingBindingContext(runtime, bindingKey, normalized) {
  if (!bindingKey || !normalized) {
    return;
  }
  setBoundedMapEntry(
    runtime,
    runtime.pendingChatContextByBindingKey,
    bindingKey,
    normalized,
    MAX_PENDING_BINDING_CONTEXT_ENTRIES
  );
}

function setPendingThreadContext(runtime, threadId, normalized) {
  if (!threadId || !normalized) {
    return;
  }
  setBoundedMapEntry(
    runtime,
    runtime.pendingChatContextByThreadId,
    threadId,
    normalized,
    MAX_PENDING_THREAD_CONTEXT_ENTRIES
  );
}

function setReplyCardEntry(runtime, runKey, entry) {
  if (!runKey || !entry) {
    return;
  }
  if (runtime.replyCardByRunKey.has(runKey)) {
    runtime.replyCardByRunKey.delete(runKey);
  }
  runtime.replyCardByRunKey.set(runKey, entry);
  while (runtime.replyCardByRunKey.size > MAX_REPLY_CARD_ENTRIES) {
    const oldestRunKey = runtime.replyCardByRunKey.keys().next().value;
    if (!oldestRunKey) {
      break;
    }
    const oldestEntry = runtime.replyCardByRunKey.get(oldestRunKey) || null;
    runtime.disposeReplyRunState(oldestRunKey, oldestEntry?.threadId || "");
  }
}

function setCurrentRunKeyForThread(runtime, threadId, runKey) {
  if (!threadId || !runKey) {
    return;
  }
  setBoundedMapEntry(
    runtime,
    runtime.currentRunKeyByThreadId,
    threadId,
    runKey,
    MAX_THREAD_CONTEXT_CACHE_ENTRIES
  );
}

function setBoundedMapEntry(runtime, map, key, value, limit) {
  if (!map || !key) {
    return;
  }
  if (map.has(key)) {
    map.delete(key);
  }
  map.set(key, value);
  while (map.size > limit) {
    const oldestKey = map.keys().next().value;
    if (!oldestKey) {
      break;
    }
    map.delete(oldestKey);
  }
}

function resolveBindingKeyForThread(runtime, threadId) {
  if (!threadId) {
    return "";
  }

  const fromMap = runtime.bindingKeyByThreadId.get(threadId) || "";
  if (fromMap) {
    return fromMap;
  }

  const context = runtime.pendingChatContextByThreadId.get(threadId);
  if (!context) {
    return "";
  }

  const resolved = runtime.sessionStore.buildBindingKey(context);
  setThreadBindingKey(runtime, threadId, resolved);
  return resolved;
}

function resolveWorkspaceRootForThread(runtime, threadId) {
  if (!threadId) {
    return "";
  }

  const fromMap = runtime.workspaceRootByThreadId.get(threadId) || "";
  if (fromMap) {
    return fromMap;
  }

  const bindingKey = resolveBindingKeyForThread(runtime, threadId);
  const workspaceRoot = resolveWorkspaceRootForBinding(runtime, bindingKey);
  if (workspaceRoot) {
    setThreadWorkspaceRoot(runtime, threadId, workspaceRoot);
  }
  return workspaceRoot;
}

function cleanupThreadRuntimeState(runtime, threadId) {
  if (!threadId) {
    return;
  }

  runtime.pendingApprovalByThreadId.delete(threadId);
  runtime.activeTurnIdByThreadId.delete(threadId);
  runtime.pendingChatContextByThreadId.delete(threadId);
  runtime.bindingKeyByThreadId.delete(threadId);
  runtime.turnDeliveryModeByThreadId.delete(threadId);
  runtime.workspaceRootByThreadId.delete(threadId);
  runtime.threadSessionPathByThreadId.delete(threadId);
  runtime.threadHasExternalUpdatesByThreadId?.delete(threadId);
  runtime.freshThreadIds?.delete(threadId);
  runtime.placeholderThreadIds?.delete(threadId);

  for (const [runKey, entry] of runtime.replyCardByRunKey.entries()) {
    if (entry?.threadId === threadId) {
      runtime.disposeReplyRunState(runKey, threadId);
    }
  }
}

function pruneRuntimeMapSizes(runtime) {
  pruneMapToLimit(runtime.activeTurnIdByThreadId, MAX_THREAD_CONTEXT_CACHE_ENTRIES);
  pruneMapToLimit(runtime.currentRunKeyByThreadId, MAX_THREAD_CONTEXT_CACHE_ENTRIES);
}

function pruneMapToLimit(map, limit) {
  if (!map || map.size <= limit) {
    return;
  }
  while (map.size > limit) {
    const oldestKey = map.keys().next().value;
    if (!oldestKey) {
      break;
    }
    map.delete(oldestKey);
  }
}

module.exports = {
  cleanupThreadRuntimeState,
  pruneRuntimeMapSizes,
  resolveThreadIdForBinding,
  resolveWorkspaceRootForBinding,
  resolveWorkspaceRootForThread,
  setCurrentRunKeyForThread,
  setPendingBindingContext,
  setPendingThreadContext,
  setReplyCardEntry,
  setThreadBindingKey,
  setThreadWorkspaceRoot,
};
