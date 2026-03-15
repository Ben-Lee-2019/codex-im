const { normalizeWorkspacePath } = require("./workspace-paths");

function normalizeFeishuTextEvent(event, config) {
  const message = event?.message || {};
  const sender = event?.sender || {};
  if (message.message_type !== "text") {
    return null;
  }

  const text = parseFeishuMessageText(message.content);
  if (!text) {
    return null;
  }

  const command = parseCommand(text);

  return {
    provider: "feishu",
    workspaceId: config.defaultWorkspaceId,
    chatId: message.chat_id || "",
    threadKey: message.root_id || "",
    senderId: sender?.sender_id?.open_id || sender?.sender_id?.user_id || "",
    messageId: message.message_id || "",
    text,
    command,
    receivedAt: new Date().toISOString(),
  };
}

function buildBindingMetadata(normalized) {
  return {
    workspaceId: normalized.workspaceId,
    chatId: normalized.chatId,
    threadKey: normalized.threadKey,
    senderId: normalized.senderId,
  };
}

function extractThreadId(response) {
  return response?.result?.thread?.id || null;
}

function mapCodexMessageToImEvent(message) {
  const method = message?.method;
  const params = message?.params || {};
  const threadId = extractThreadIdentifier(params);
  const turnId = extractTurnIdentifier(params);

  if (isAssistantMessageMethod(method, params)) {
    const text = extractAssistantText(params);
    if (!text) {
      return null;
    }
    return {
      type: "im.agent_reply",
      payload: {
        threadId,
        turnId,
        text,
      },
    };
  }

  if (method === "turn/started" || method === "turn/start") {
    return {
      type: "im.run_state",
      payload: {
        threadId,
        turnId,
        state: "streaming",
      },
    };
  }

  if (method === "turn/completed") {
    return {
      type: "im.run_state",
      payload: {
        threadId,
        turnId,
        state: "completed",
      },
    };
  }

  if (method === "turn/failed") {
    return {
      type: "im.run_state",
      payload: {
        threadId,
        turnId,
        state: "failed",
      },
    };
  }

  if (isApprovalRequestMethod(method)) {
    return {
      type: "im.approval_request",
      payload: {
        threadId,
        reason: params.reason || "",
        command: params.command || "",
      },
    };
  }

  return null;
}

function trackRunningTurn(activeTurnIdByThreadId, message) {
  const method = message?.method;
  const params = message?.params || {};
  const threadId = extractTrackThreadId(params);
  const turnId = extractTrackTurnId(params);

  if (!threadId) {
    return;
  }

  if ((method === "turn/started" || method === "turn/start") && turnId) {
    activeTurnIdByThreadId.set(threadId, turnId);
    return;
  }

  if (method === "turn/completed" || method === "turn/failed" || method === "turn/cancelled") {
    activeTurnIdByThreadId.delete(threadId);
  }
}

function trackPendingApproval(pendingApprovalByThreadId, message) {
  const method = message?.method;
  const params = message?.params || {};
  const threadId = extractTrackThreadId(params);

  if (isApprovalRequestMethod(method) && threadId && message?.id != null) {
    pendingApprovalByThreadId.set(threadId, {
      requestId: message.id,
      method,
      threadId,
      reason: params.reason || "",
      command: params.command || "",
      chatId: "",
      replyToMessageId: "",
      resolution: "",
      cardMessageId: "",
    });
    return;
  }

  if (method === "turn/completed" || method === "turn/failed" || method === "turn/cancelled") {
    pendingApprovalByThreadId.delete(threadId);
  }
}

function trackRunKeyState(currentRunKeyByThreadId, activeTurnIdByThreadId, message) {
  const method = message?.method;
  const params = message?.params || {};
  const threadId = extractTrackThreadId(params);
  const turnId = extractTrackTurnId(params) || activeTurnIdByThreadId.get(threadId) || "";
  if (!threadId) {
    return;
  }

  if ((method === "turn/started" || method === "turn/start") && turnId) {
    currentRunKeyByThreadId.set(threadId, buildRunKey(threadId, turnId));
    return;
  }

  if (method === "turn/completed" || method === "turn/failed" || method === "turn/cancelled") {
    if (turnId) {
      currentRunKeyByThreadId.set(threadId, buildRunKey(threadId, turnId));
    }
  }
}

function isApprovalRequestMethod(method) {
  if (typeof method !== "string" || !method) {
    return false;
  }

  return (
    method === "item/commandExecution/requestApproval"
    || method === "item/fileChange/requestApproval"
    || method.endsWith("requestApproval")
    || method === "approval/requested"
  );
}

function resolveApprovalDecision(command, method, rawText) {
  if (command !== "approve") {
    return "decline";
  }

  const normalizedMethod = typeof method === "string" ? method.trim() : "";
  const normalizedText = typeof rawText === "string" ? rawText.trim().toLowerCase() : "";
  const isCommandApproval = isCommandApprovalMethod(normalizedMethod);
  const wantsSession = normalizedText === "/codex approve session"
    || normalizedText.endsWith(" approve session");

  if (isCommandApproval && wantsSession) {
    return "acceptForSession";
  }

  return "accept";
}

function buildApprovalResponsePayload(decision, method) {
  const normalizedMethod = String(method || "").toLowerCase();
  if (normalizedMethod.includes("requestapproval")) {
    return { decision };
  }
  return decision;
}

function buildRunKey(threadId, turnId) {
  return `${threadId}:${turnId || "pending"}`;
}

function extractTurnIdFromRunKey(runKey) {
  if (!runKey || !runKey.includes(":")) {
    return "";
  }
  return runKey.slice(runKey.indexOf(":") + 1);
}

function extractCreatedMessageId(response) {
  return response?.data?.message_id || "";
}

function extractThreadsFromListResponse(response) {
  const threads = response?.result?.data;
  if (!Array.isArray(threads)) {
    return [];
  }

  return threads
    .map((thread) => ({
      id: normalizeIdentifier(thread?.id),
      cwd: normalizeWorkspacePath(thread?.cwd),
      title: normalizeIdentifier(thread?.name) || normalizeIdentifier(thread?.preview),
      updatedAt: Number(thread?.updatedAt || 0),
      sourceKind: extractThreadSourceKind(thread),
    }))
    .filter((thread) => thread.id);
}

function extractThreadListCursor(response) {
  return typeof response?.result?.nextCursor === "string" ? response.result.nextCursor : "";
}

function extractRecentConversationFromResumeResponse(response, turnLimit = 3) {
  const turns = response?.result?.thread?.turns;
  if (!Array.isArray(turns) || !turns.length) {
    return [];
  }

  const recentTurns = turns.slice(-turnLimit);
  const messages = [];

  for (const turn of recentTurns) {
    const items = Array.isArray(turn?.items) ? turn.items : [];
    for (const item of items) {
      const normalized = normalizeResumedConversationItem(item);
      if (normalized) {
        messages.push(normalized);
      }
    }
  }

  return dedupeRecentConversationMessages(messages).slice(-6);
}

function extractCardAction(data) {
  const action = data?.action || {};
  const value = action.value || {};
  if (!value.kind) {
    console.log("[codex-im] card callback action missing kind", {
      action,
      hasValue: !!action.value,
    });
    return null;
  }
  if (value.kind === "approval") {
    return {
      kind: value.kind,
      decision: value.decision,
      scope: value.scope || "once",
      requestId: value.requestId,
      threadId: value.threadId,
    };
  }
  if (value.kind === "panel") {
    return {
      kind: value.kind,
      action: value.action || "",
    };
  }
  if (value.kind === "thread") {
    return {
      kind: value.kind,
      action: value.action || "",
      threadId: value.threadId || "",
    };
  }
  if (value.kind === "workspace") {
    return {
      kind: value.kind,
      action: value.action || "",
      workspaceRoot: value.workspaceRoot || "",
    };
  }
  return null;
}

function normalizeCardActionContext(data, config) {
  const messageId = normalizeIdentifier(data?.context?.open_message_id);
  const chatId = extractCardChatId(data);
  const senderId = normalizeIdentifier(data?.operator?.open_id);

  if (!chatId || !messageId || !senderId) {
    console.log("[codex-im] card callback missing required context", {
      context_open_message_id: data?.context?.open_message_id,
      context_open_chat_id: data?.context?.open_chat_id,
      operator_open_id: data?.operator?.open_id,
    });
    return null;
  }
  return {
    provider: "feishu",
    workspaceId: config.defaultWorkspaceId,
    chatId,
    threadKey: "",
    senderId,
    messageId,
    text: "",
    command: "",
    receivedAt: new Date().toISOString(),
  };
}

function eventShouldClearPendingReaction(event) {
  if (!event || typeof event !== "object") {
    return false;
  }

  if (event.type === "im.run_state") {
    const state = String(event.payload?.state || "").toLowerCase();
    return state === "completed" || state === "failed";
  }

  if (event.type === "im.approval_request") {
    return true;
  }

  return false;
}

function extractAssistantText(params) {
  const eventObject = envelopeEventObject(params);
  const directText = [
    params?.delta,
    eventObject?.delta,
    params?.item?.text,
    eventObject?.message,
  ];
  for (const value of directText) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  const contentObjects = [
    params?.item?.content,
    eventObject?.item?.content,
    params?.content,
    eventObject?.content,
  ];
  for (const content of contentObjects) {
    const extracted = extractTextFromContent(content);
    if (extracted) {
      return extracted;
    }
  }

  return "";
}

function parseFeishuMessageText(rawContent) {
  try {
    const parsed = JSON.parse(rawContent || "{}");
    return typeof parsed.text === "string" ? parsed.text.trim() : "";
  } catch {
    return "";
  }
}

function extractTrackThreadId(params) {
  return normalizeIdentifier(params?.threadId);
}

function extractTrackTurnId(params) {
  return normalizeIdentifier(params?.turnId || params?.turn?.id);
}

function parseCommand(text) {
  const normalized = text.trim().toLowerCase();
  const prefixes = ["/codex "];
  const exactPrefixes = ["/codex"];

  const exactCommands = {
    stop: ["stop"],
    where: ["where"],
    inspect_message: ["message"],
    help: ["help"],
    workspace: ["workspace"],
    remove: ["remove"],
    new: ["new"],
    approve: ["approve", "approve session"],
    reject: ["reject"],
  };
  for (const [command, suffixes] of Object.entries(exactCommands)) {
    if (matchesExactCommand(normalized, suffixes)) {
      return command;
    }
  }

  if (matchesPrefixCommand(normalized, "switch")) {
    return "switch";
  }
  if (matchesPrefixCommand(normalized, "remove")) {
    return "remove";
  }
  if (matchesPrefixCommand(normalized, "bind")) {
    return "bind";
  }
  if (prefixes.some((prefix) => normalized.startsWith(prefix))) {
    return "unknown_command";
  }
  if (exactPrefixes.includes(normalized)) {
    return "unknown_command";
  }
  if (text.trim()) {
    return "message";
  }

  return "";
}

function matchesExactCommand(text, suffixes) {
  return suffixes.some((suffix) => (
    text === `/codex ${suffix}`
  ));
}

function matchesPrefixCommand(text, command) {
  return text.startsWith(`/codex ${command} `);
}

function isAssistantMessageMethod(method, params) {
  if (
    method === "item/agentMessage/delta"
    || method === "codex/event/agent_message_content_delta"
    || method === "codex/event/agent_message_delta"
    || method === "codex/event/agent_message"
  ) {
    return true;
  }

  if (method === "item/completed" || method === "codex/event/item_completed") {
    return looksLikeAssistantPayload(params);
  }

  return false;
}

function looksLikeAssistantPayload(params) {
  const eventObject = envelopeEventObject(params);
  const typeValues = [
    params?.item?.type,
    eventObject?.item?.type,
  ];
  return typeValues.some((value) => {
    const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
    return normalized === "agentmessage";
  });
}

function isCommandApprovalMethod(method) {
  const normalizedMethod = String(method || "").trim().toLowerCase();
  if (!normalizedMethod) {
    return false;
  }

  const compact = normalizedMethod.replace(/[^a-z]/g, "");
  return (
    compact.includes("commandexecutionrequestapproval")
    || compact.includes("commandrequestapproval")
  );
}


function extractThreadSourceKind(thread) {
  return normalizeIdentifier(thread?.source) || "unknown";
}

function dedupeRecentConversationMessages(messages) {
  const deduped = [];
  for (const message of messages) {
    const previous = deduped[deduped.length - 1];
    if (previous && previous.role === message.role && previous.text === message.text) {
      continue;
    }
    deduped.push(message);
  }
  return deduped;
}

function normalizeResumedConversationItem(item) {
  if (!item || typeof item !== "object") {
    return null;
  }

  const itemType = String(item.type || "").toLowerCase();
  if (itemType === "usermessage") {
    const text = extractTextFromContent(item.content);
    return text ? { role: "user", text } : null;
  }

  if (itemType === "agentmessage") {
    const text = extractTextFromContent(item.text);
    return text ? { role: "assistant", text } : null;
  }

  return null;
}

function extractCardChatId(data) {
  return normalizeIdentifier(data?.context?.open_chat_id);
}

function envelopeEventObject(params) {
  return params?.msg && typeof params.msg === "object" ? params.msg : null;
}

function extractThreadIdentifier(params) {
  return normalizeIdentifier(
    params?.threadId
      || params?.msg?.thread_id
  );
}

function extractTurnIdentifier(params) {
  return normalizeIdentifier(
    params?.turnId
      || params?.turn?.id
      || params?.msg?.turn_id
  );
}

function normalizeIdentifier(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function extractTextFromContent(content) {
  if (typeof content === "string" && content.trim()) {
    return content.trim();
  }

  if (!content) {
    return "";
  }

  if (Array.isArray(content)) {
    const parts = [];
    for (const entry of content) {
      if (typeof entry === "string" && entry.trim()) {
        parts.push(entry.trim());
        continue;
      }
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const entryType = String(entry.type || "").toLowerCase();
      if (entryType === "text" && typeof entry.text === "string" && entry.text.trim()) {
        parts.push(entry.text.trim());
      }
    }
    return parts.join("\n").trim();
  }

  if (typeof content !== "object") {
    return "";
  }

  if (typeof content.text === "string" && content.text.trim()) {
    return content.text.trim();
  }

  return "";
}

module.exports = {
  buildApprovalResponsePayload,
  buildBindingMetadata,
  buildRunKey,
  eventShouldClearPendingReaction,
  extractCardAction,
  extractCreatedMessageId,
  extractThreadId,
  extractThreadListCursor,
  extractThreadsFromListResponse,
  extractTurnIdFromRunKey,
  extractRecentConversationFromResumeResponse,
  isApprovalRequestMethod,
  mapCodexMessageToImEvent,
  normalizeCardActionContext,
  normalizeFeishuTextEvent,
  resolveApprovalDecision,
  trackPendingApproval,
  trackRunKeyState,
  trackRunningTurn,
};
