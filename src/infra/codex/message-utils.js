const { normalizeWorkspacePath } = require("../../shared/workspace-paths");

const APPROVAL_COMMAND_KEYS = [
  "proposedExecpolicyAmendment",
  "argv",
  "args",
  "command",
  "cmd",
  "exec",
  "shellCommand",
  "script",
];

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

function extractThreadPath(response) {
  return normalizeIdentifier(response?.result?.thread?.path);
}

function mapCodexMessageToImEvent(message) {
  const method = message?.method;
  const params = message?.params || {};
  const threadId = extractThreadIdentifier(params);
  const turnId = extractTurnIdentifier(params);

  if (isAssistantMessageMethod(method, params)) {
    const assistantText = extractAssistantText(method, params);
    if (!assistantText.text) {
      return null;
    }
    return {
      type: "im.agent_reply",
      payload: {
        threadId,
        turnId,
        itemId: normalizeIdentifier(params?.itemId || params?.item?.id),
        text: assistantText.text,
        textMode: assistantText.mode,
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
    const turnStatus = normalizeIdentifier(params?.turn?.status).toLowerCase();
    const isFailed = turnStatus === "failed" || !!params?.turn?.error || !!params?.error;
    if (isFailed) {
      return {
        type: "im.run_state",
        payload: {
          threadId,
          turnId,
          state: "failed",
          text: extractTurnFailureText(params),
        },
      };
    }
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
        text: extractTurnFailureText(params),
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
  const commandTokens = extractApprovalCommandTokens(params);

  if (isApprovalRequestMethod(method) && threadId && message?.id != null) {
    pendingApprovalByThreadId.set(threadId, {
      requestId: message.id,
      method,
      threadId,
      reason: params.reason || "",
      command: extractApprovalDisplayCommand(params, commandTokens),
      commandTokens,
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
  return typeof method === "string" && method.endsWith("requestApproval");
}

function buildApprovalResponsePayload(decision) {
  return { decision };
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
      createdAt: Number(thread?.createdAt || 0),
      updatedAt: Number(thread?.updatedAt || 0),
      sourceKind: extractThreadSourceKind(thread),
      parentThreadId: extractParentThreadId(thread),
      statusType: normalizeIdentifier(thread?.status?.type).toLowerCase() || "unknown",
      path: normalizeIdentifier(thread?.path),
      agentNickname: normalizeIdentifier(thread?.agentNickname),
      agentRole: normalizeIdentifier(thread?.agentRole),
    }))
    .filter((thread) => thread.id);
}

function extractThreadListCursor(response) {
  return typeof response?.result?.nextCursor === "string" ? response.result.nextCursor : "";
}

function extractRecentConversationFromResumeResponse(response, turnLimit = 3) {
  return extractConversationFromResumeResponse(response, { turnLimit }).slice(-6);
}

function extractConversationFromResumeResponse(response, { turnLimit = Infinity } = {}) {
  const turns = response?.result?.thread?.turns;
  if (!Array.isArray(turns) || !turns.length) {
    return [];
  }

  const recentTurns = Number.isFinite(turnLimit)
    ? turns.slice(-Math.max(1, turnLimit))
    : turns;
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

  return dedupeRecentConversationMessages(messages);
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

function extractAssistantText(method, params) {
  const mode = method === "item/agentMessage/delta" ? "append" : "replace";
  const directText = [
    params?.delta,
    params?.item?.text,
  ];
  for (const value of directText) {
    if (typeof value === "string" && value.length > 0) {
      return { text: value, mode };
    }
  }

  const contentObjects = [
    params?.item?.content,
    params?.content,
  ];
  for (const content of contentObjects) {
    const extracted = extractTextFromContentRaw(content);
    if (extracted) {
      return { text: extracted, mode };
    }
  }

  return { text: "", mode };
}

function extractTurnFailureText(params) {
  const errorObj = params?.turn?.error || params?.error || {};
  const rawMessage = normalizeIdentifier(errorObj?.message);
  const parsed = parseEmbeddedErrorMessage(rawMessage);
  const detail = normalizeIdentifier(parsed?.detail || parsed?.message || parsed?.error);
  if (detail) {
    return `执行失败：${detail}`;
  }
  if (rawMessage) {
    return `执行失败：${rawMessage}`;
  }
  return "执行失败";
}

function parseEmbeddedErrorMessage(raw) {
  const message = normalizeIdentifier(raw);
  if (!message) {
    return null;
  }
  if (!(message.startsWith("{") && message.endsWith("}"))) {
    return null;
  }
  try {
    const parsed = JSON.parse(message);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function extractTrackThreadId(params) {
  return normalizeIdentifier(params?.threadId);
}

function extractTrackTurnId(params) {
  return normalizeIdentifier(params?.turnId || params?.turn?.id);
}

function isAssistantMessageMethod(method, params) {
  if (method === "item/agentMessage/delta") {
    return true;
  }

  if (method === "item/completed") {
    return looksLikeAssistantPayload(params);
  }

  return false;
}

function looksLikeAssistantPayload(params) {
  const itemType = typeof params?.item?.type === "string"
    ? params.item.type.trim().toLowerCase()
    : "";
  return itemType === "agentmessage";
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

function isWorkspaceApprovalCommand(rawText) {
  const normalizedText = typeof rawText === "string" ? rawText.trim().toLowerCase() : "";
  return (
    normalizedText === "/codex approve workspace"
    || normalizedText.endsWith(" approve workspace")
  );
}

function extractApprovalCommandTokens(params) {
  return normalizeCommandTokens(extractTokens(params));
}

function matchesCommandPrefix(command, allowlist) {
  const normalizedCommand = normalizeCommandTokens(command);
  if (!normalizedCommand.length || !Array.isArray(allowlist)) {
    return false;
  }

  return allowlist.some((prefix) => {
    const normalizedPrefix = normalizeCommandTokens(prefix);
    if (!normalizedPrefix.length || normalizedPrefix.length > normalizedCommand.length) {
      return false;
    }

    for (let index = 0; index < normalizedPrefix.length; index += 1) {
      if (normalizedPrefix[index] !== normalizedCommand[index]) {
        return false;
      }
    }
    return true;
  });
}

function normalizeCommandTokens(tokens) {
  if (!Array.isArray(tokens)) {
    return [];
  }
  return tokens
    .map((token) => (typeof token === "string" ? token.trim() : ""))
    .filter(Boolean);
}

function buildApprovalCommandPreview(tokens) {
  const normalized = normalizeCommandTokens(tokens);
  if (!normalized.length) {
    return "";
  }
  return normalized.map((token) => (token.includes(" ") ? JSON.stringify(token) : token)).join(" ");
}

function extractApprovalDisplayCommand(params, commandTokens) {
  const rawCommand = params?.command;
  if (typeof rawCommand === "string" && rawCommand.trim()) {
    return rawCommand.trim();
  }
  if (Array.isArray(rawCommand)) {
    const normalized = normalizeCommandTokens(rawCommand);
    if (normalized.length) {
      return normalized.map((token) => (token.includes(" ") ? JSON.stringify(token) : token)).join(" ");
    }
  }
  return buildApprovalCommandPreview(commandTokens);
}

function extractTokens(value) {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.every((entry) => typeof entry === "string")
      ? value.map((entry) => entry.trim()).filter(Boolean)
      : [];
  }
  if (typeof value === "string") {
    return splitCommandLine(value);
  }
  if (typeof value !== "object") {
    return [];
  }

  const objectValue = value;
  for (const key of APPROVAL_COMMAND_KEYS) {
    const tokens = extractTokens(objectValue[key]);
    if (tokens.length) {
      return tokens;
    }
  }

  for (const [key, nested] of Object.entries(objectValue)) {
    const normalized = key.toLowerCase();
    if (normalized.includes("execpolicy") || normalized.includes("exec_policy")) {
      const tokens = extractTokens(nested);
      if (tokens.length) {
        return tokens;
      }
    }
  }

  return [];
}

function splitCommandLine(input) {
  const tokens = [];
  let current = "";
  let quote = null;
  let escaped = false;

  for (const char of String(input || "")) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (current) {
    tokens.push(current);
  }
  return tokens;
}


function extractThreadSourceKind(thread) {
  const source = thread?.source;
  if (typeof source === "string" && source.trim()) {
    return source.trim();
  }
  if (!source || typeof source !== "object") {
    return "unknown";
  }

  const keys = Object.keys(source).filter(Boolean);
  if (!keys.length) {
    return "unknown";
  }
  return normalizeIdentifier(keys[0]) || "unknown";
}

function extractParentThreadId(thread) {
  const direct = normalizeIdentifier(
    thread?.source?.subAgent?.thread_spawn?.parent_thread_id
    || thread?.source?.subagent?.thread_spawn?.parent_thread_id
  );
  if (direct) {
    return direct;
  }

  const source = thread?.source;
  if (!source || typeof source !== "object") {
    return "";
  }

  for (const nested of Object.values(source)) {
    const candidate = normalizeIdentifier(nested?.thread_spawn?.parent_thread_id);
    if (candidate) {
      return candidate;
    }
  }
  return "";
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

function extractThreadIdentifier(params) {
  return normalizeIdentifier(params?.threadId);
}

function extractTurnIdentifier(params) {
  return normalizeIdentifier(params?.turnId || params?.turn?.id);
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

function extractTextFromContentRaw(content) {
  if (typeof content === "string" && content.length > 0) {
    return content;
  }

  if (!content) {
    return "";
  }

  if (Array.isArray(content)) {
    const parts = [];
    for (const entry of content) {
      if (typeof entry === "string" && entry.length > 0) {
        parts.push(entry);
        continue;
      }
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const entryType = String(entry.type || "").toLowerCase();
      if (entryType === "text" && typeof entry.text === "string" && entry.text.length > 0) {
        parts.push(entry.text);
      }
    }
    return parts.join("\n");
  }

  if (typeof content !== "object") {
    return "";
  }

  if (typeof content.text === "string" && content.text.length > 0) {
    return content.text;
  }

  return "";
}

module.exports = {
  buildApprovalResponsePayload,
  buildBindingMetadata,
  buildRunKey,
  eventShouldClearPendingReaction,
  extractConversationFromResumeResponse,
  extractCreatedMessageId,
  extractThreadId,
  extractThreadPath,
  extractThreadListCursor,
  extractThreadsFromListResponse,
  extractTurnIdFromRunKey,
  extractRecentConversationFromResumeResponse,
  isCommandApprovalMethod,
  isWorkspaceApprovalCommand,
  mapCodexMessageToImEvent,
  matchesCommandPrefix,
  normalizeCommandTokens,
  trackPendingApproval,
  trackRunKeyState,
  trackRunningTurn,
};
