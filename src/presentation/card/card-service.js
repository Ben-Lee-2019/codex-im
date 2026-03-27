const codexMessageUtils = require("../../infra/codex/message-utils");
const { ASSISTANT_REPLY_MAX_BYTES } = require("../../shared/assistant-markdown");
const messageNormalizers = require("../message/normalizers");
const reactionRepo = require("../../infra/feishu/reaction-repo");
const { formatFailureText } = require("../../shared/error-text");
const {
  buildApprovalCard,
  buildApprovalResolvedCard,
  buildAssistantDetailCard,
  buildAssistantReplyCard,
  buildCardResponse,
  buildReplyActionValue,
  buildInfoCard,
} = require("./builders");

const MAX_REPLY_DETAIL_ENTRIES = 1000;
const MAX_REPLY_DETAIL_ITEMS = 100;
const MAX_REPLY_DETAIL_SNAPSHOTS = 80;

async function sendInfoCardMessage(runtime, { chatId, text, replyToMessageId = "", replyInThread = false, kind = "info" }) {
  if (!chatId || !text) {
    return null;
  }

  return sendInteractiveCard(runtime, {
    chatId,
    replyToMessageId,
    replyInThread,
    card: buildInfoCard(text, { kind }),
  });
}

async function sendFeedbackByContext(runtime, normalized, { text, kind = "info", replyToMessageId = "" } = {}) {
  if (!normalized?.chatId || !text) {
    return null;
  }
  return sendInfoCardMessage(runtime, {
    chatId: normalized.chatId,
    replyToMessageId: replyToMessageId || normalized.messageId || "",
    text,
    kind,
  });
}

async function sendInteractiveApprovalCard(runtime, { chatId, approval, replyToMessageId = "", replyInThread = false }) {
  if (!chatId || !approval) {
    return null;
  }

  return sendInteractiveCard(runtime, {
    chatId,
    replyToMessageId,
    replyInThread,
    card: buildApprovalCard(approval),
  });
}

async function updateInteractiveCard(runtime, { messageId, approval }) {
  if (!messageId || !approval) {
    return null;
  }
  return patchInteractiveCard(runtime, {
    messageId,
    card: buildApprovalResolvedCard(approval),
  });
}

async function sendInteractiveCard(runtime, { chatId, card, replyToMessageId = "", replyInThread = false }) {
  if (!chatId || !card) {
    return null;
  }
  return runtime.requireFeishuAdapter().sendInteractiveCard({
    chatId,
    card,
    replyToMessageId,
    replyInThread,
  });
}

async function patchInteractiveCard(runtime, { messageId, card }) {
  if (!messageId || !card) {
    return null;
  }
  return runtime.requireFeishuAdapter().patchInteractiveCard({ messageId, card });
}

async function handleCardAction(runtime, data) {
  const action = messageNormalizers.extractCardAction(data);
  console.log(
    `[codex-im] card callback kind=${action?.kind || "-"} action=${action?.action || "-"} `
    + `thread=${action?.threadId || "-"} request=${action?.requestId || "-"} selected=${action?.selectedValue || "-"}`
  );
  if (!action) {
    runCardActionTask(runtime, sendCardActionFeedback(runtime, data, "无法识别卡片操作。", "error"));
    return buildCardResponse({});
  }

  if (action.kind === "approval") {
    runCardActionTask(runtime, runtime.handleApprovalCardActionAsync(action, data));
    return buildCardResponse({});
  }

  const normalized = messageNormalizers.normalizeCardActionContext(data, runtime.config);
  if (!normalized) {
    runCardActionTask(runtime, sendCardActionFeedback(runtime, data, "无法解析当前卡片上下文。", "error"));
    return buildCardResponse({});
  }

  try {
    const handled = runtime.dispatchCardAction(action, normalized);
    if (handled) {
      return handled;
    }
  } catch (error) {
    runCardActionTask(
      runtime,
      sendCardActionFeedbackByContext(runtime, normalized, formatFailureText("处理失败", error), "error")
    );
    return buildCardResponse({});
  }

  runCardActionTask(runtime, sendCardActionFeedbackByContext(runtime, normalized, "未支持的卡片操作。", "error"));
  return buildCardResponse({});
}

function queueCardActionWithFeedback(runtime, normalized, feedbackText, task) {
  runCardActionTask(runtime, (async () => {
    await sendCardActionFeedbackByContext(runtime, normalized, feedbackText, "progress");
    await task();
  })());
  return buildCardResponse({});
}

function runCardActionTask(runtime, taskPromise) {
  Promise.resolve(taskPromise).catch((error) => {
    console.error(`[codex-im] async card action failed: ${error.message}`);
  });
}

async function sendCardActionFeedbackByContext(runtime, normalized, text, kind = "info") {
  await sendFeedbackByContext(runtime, normalized, { text, kind });
}

async function sendCardActionFeedback(runtime, data, text, kind = "info") {
  const normalized = messageNormalizers.normalizeCardActionContext(data, runtime.config);
  if (!normalized) {
    return;
  }
  await sendCardActionFeedbackByContext(runtime, normalized, text, kind);
}

async function upsertAssistantReplyCard(
  runtime,
  { threadId, turnId, itemId = "", chatId, text, textMode = "replace", state, deferFlush = false }
) {
  if (!threadId || !chatId) {
    return;
  }

  const resolvedTurnId = turnId
    || runtime.activeTurnIdByThreadId.get(threadId)
    || codexMessageUtils.extractTurnIdFromRunKey(runtime.currentRunKeyByThreadId.get(threadId) || "")
    || "";
  const preferredRunKey = codexMessageUtils.buildRunKey(threadId, resolvedTurnId);
  let runKey = preferredRunKey;
  let existing = runtime.replyCardByRunKey.get(runKey) || null;

  if (!existing) {
    const currentRunKey = runtime.currentRunKeyByThreadId.get(threadId) || "";
    const currentEntry = runtime.replyCardByRunKey.get(currentRunKey) || null;
    const shouldReuseCurrent = !!(
      currentEntry
      && currentEntry.state !== "completed"
      && currentEntry.state !== "failed"
      && (!resolvedTurnId || !currentEntry.turnId || currentEntry.turnId === resolvedTurnId)
    );
    if (shouldReuseCurrent) {
      runKey = currentRunKey;
      existing = currentEntry;
    }
  }

  if (!existing) {
    existing = {
      messageId: "",
      chatId,
      replyToMessageId: "",
      text: "",
      fullText: "",
      detailItems: [],
      detailSnapshots: [],
      state: "streaming",
      threadId,
      turnId: resolvedTurnId,
      itemId: "",
    };
  }

  const normalizedItemId = typeof itemId === "string" ? itemId.trim() : "";
  if (normalizedItemId && existing.itemId && existing.itemId !== normalizedItemId) {
    existing.text = "";
    existing.fullText = "";
  }
  if (normalizedItemId) {
    existing.itemId = normalizedItemId;
  }

  if (typeof text === "string" && text) {
    const detailItem = upsertReplyDetailItem(existing, {
      itemId: normalizedItemId,
      text,
      mode: textMode,
    });
    const previewText = typeof detailItem?.text === "string"
      ? detailItem.text.trim()
      : text.trim();
    if (previewText) {
      existing.text = previewText;
    }
    existing.fullText = typeof detailItem?.text === "string"
      ? detailItem.text
      : mergeReplyDetailText(existing.fullText, text, { mode: textMode });
  }
  existing.chatId = chatId;
  existing.replyToMessageId = runtime.pendingChatContextByThreadId.get(threadId)?.messageId || existing.replyToMessageId || "";
  if (state) {
    existing.state = state;
  }
  if (resolvedTurnId) {
    existing.turnId = resolvedTurnId;
  }

  runtime.setReplyCardEntry(runKey, existing);
  runtime.setCurrentRunKeyForThread(threadId, runKey);

  if (deferFlush && existing.state !== "completed" && existing.state !== "failed") {
    return;
  }

  const shouldFlushImmediately = existing.state === "completed"
    || existing.state === "failed"
    || (!existing.messageId && typeof existing.text === "string" && existing.text.trim());
  await scheduleReplyCardFlush(runtime, runKey, { immediate: shouldFlushImmediately });
}

async function scheduleReplyCardFlush(runtime, runKey, { immediate = false } = {}) {
  const entry = runtime.replyCardByRunKey.get(runKey);
  if (!entry) {
    return;
  }

  if (immediate) {
    clearReplyFlushTimer(runtime, runKey);
    await flushReplyCard(runtime, runKey);
    return;
  }

  if (runtime.replyFlushTimersByRunKey.has(runKey)) {
    return;
  }

  const timer = setTimeout(() => {
    runtime.replyFlushTimersByRunKey.delete(runKey);
    flushReplyCard(runtime, runKey).catch((error) => {
      console.error(`[codex-im] failed to flush reply card: ${error.message}`);
    });
  }, 300);
  runtime.replyFlushTimersByRunKey.set(runKey, timer);
}

function clearReplyFlushTimer(runtime, runKey) {
  const timer = runtime.replyFlushTimersByRunKey.get(runKey);
  if (!timer) {
    return;
  }
  clearTimeout(timer);
  runtime.replyFlushTimersByRunKey.delete(runKey);
}

async function flushReplyCard(runtime, runKey) {
  const entry = runtime.replyCardByRunKey.get(runKey);
  if (!entry) {
    return;
  }

  if (shouldSuppressEmptyCompletedReplyCard(entry)) {
    runtime.disposeReplyRunState(runKey, entry.threadId);
    return;
  }

  captureReplySnapshot(entry);

  const card = buildAssistantReplyCard({
    text: entry.text,
    state: entry.state,
    detailAction: buildReplyActionValue("show_full"),
  });

  if (!entry.messageId) {
    const response = await sendInteractiveCard(runtime, {
      chatId: entry.chatId,
      card,
      replyToMessageId: entry.replyToMessageId,
    });
    entry.messageId = codexMessageUtils.extractCreatedMessageId(response);
    if (!entry.messageId) {
      return;
    }
    runtime.setReplyCardEntry(runKey, entry);
    rememberReplyDetail(runtime, entry.messageId, entry);
    await syncOpenReplyDetailCard(runtime, entry.messageId);
    runtime.clearPendingReactionForThread(entry.threadId).catch((error) => {
      console.error(`[codex-im] failed to clear pending reaction after first reply card: ${error.message}`);
    });
    if (entry.state === "completed" || entry.state === "failed") {
      runtime.disposeReplyRunState(runKey, entry.threadId);
    }
    return;
  }

  await patchInteractiveCard(runtime, {
    messageId: entry.messageId,
    card,
  });
  rememberReplyDetail(runtime, entry.messageId, entry);
  await syncOpenReplyDetailCard(runtime, entry.messageId);

  if (entry.state === "completed" || entry.state === "failed") {
    runtime.disposeReplyRunState(runKey, entry.threadId);
  }
}

function shouldSuppressEmptyCompletedReplyCard(entry) {
  return entry?.state === "completed"
    && !normalizeReplyMessageId(entry?.messageId)
    && !hasReplyRenderableContent(entry);
}

function hasReplyRenderableContent(entry) {
  if (!entry || typeof entry !== "object") {
    return false;
  }

  if (normalizeReplyDetailSnapshots(entry.detailSnapshots).length) {
    return true;
  }
  if (normalizeReplyDetailItems(entry.detailItems).length) {
    return true;
  }
  if (typeof entry.fullText === "string" && entry.fullText.trim()) {
    return true;
  }
  if (typeof entry.previewText === "string" && entry.previewText.trim()) {
    return true;
  }
  return typeof entry.text === "string" && entry.text.trim().length > 0;
}

async function showAssistantReplyDetail(runtime, normalized) {
  const messageId = normalizeReplyMessageId(normalized?.messageId);
  const detail = messageId ? runtime.replyDetailByMessageId.get(messageId) || null : null;
  if (!detail) {
    await sendFeedbackByContext(runtime, normalized, {
      text: "当前还没有可查看的完整输出，请稍后再试。",
      kind: "error",
    });
    return;
  }

  const content = resolveReplyDetailContent(detail);
  if (!content) {
    await sendFeedbackByContext(runtime, normalized, {
      text: "当前还没有可查看的完整输出，请稍后再试。",
      kind: "error",
    });
    return;
  }

  if (Buffer.byteLength(content, "utf8") > ASSISTANT_REPLY_MAX_BYTES) {
    await runtime.sendFileMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      replyInThread: true,
      fileName: buildReplyDetailFileName(detail),
      fileBuffer: Buffer.from(content, "utf8"),
    });
    return;
  }

  const card = buildAssistantDetailCard({
    text: content,
    state: detail.state,
  });
  if (detail.detailMessageId) {
    await patchInteractiveCard(runtime, {
      messageId: detail.detailMessageId,
      card,
    });
    return;
  }

  const response = await sendInteractiveCard(runtime, {
    chatId: normalized.chatId,
    replyToMessageId: normalized.messageId,
    replyInThread: true,
    card,
  });
  const detailMessageId = codexMessageUtils.extractCreatedMessageId(response);
  if (!detailMessageId) {
    return;
  }
  runtime.replyDetailByMessageId.set(messageId, {
    ...detail,
    detailMessageId,
  });
}

async function addPendingReaction(runtime, bindingKey, messageId) {
  if (!bindingKey || !messageId) {
    return;
  }

  await clearPendingReactionForBinding(runtime, bindingKey);

  const reaction = await createReaction(runtime, {
    messageId,
    emojiType: "Typing",
  });
  runtime.pendingReactionByBindingKey.set(bindingKey, {
    messageId,
    reactionId: reaction.reactionId,
  });
}

function movePendingReactionToThread(runtime, bindingKey, threadId) {
  if (!bindingKey || !threadId) {
    return;
  }

  const pending = runtime.pendingReactionByBindingKey.get(bindingKey);
  if (!pending) {
    return;
  }
  runtime.pendingReactionByBindingKey.delete(bindingKey);
  runtime.pendingReactionByThreadId.set(threadId, pending);
}

async function clearPendingReactionForBinding(runtime, bindingKey) {
  const pending = runtime.pendingReactionByBindingKey.get(bindingKey);
  if (!pending) {
    return;
  }
  runtime.pendingReactionByBindingKey.delete(bindingKey);
  await deleteReaction(runtime, pending);
}

async function clearPendingReactionForThread(runtime, threadId) {
  if (!threadId) {
    return;
  }
  const pending = runtime.pendingReactionByThreadId.get(threadId);
  if (!pending) {
    return;
  }
  runtime.pendingReactionByThreadId.delete(threadId);
  await deleteReaction(runtime, pending);
}

async function createReaction(runtime, { messageId, emojiType }) {
  return reactionRepo.createReaction(runtime.requireFeishuAdapter(), { messageId, emojiType });
}

async function deleteReaction(runtime, { messageId, reactionId }) {
  await reactionRepo.deleteReaction(runtime.requireFeishuAdapter(), { messageId, reactionId });
}

function disposeReplyRunState(runtime, runKey, threadId) {
  if (runKey) {
    clearReplyFlushTimer(runtime, runKey);
    runtime.replyCardByRunKey.delete(runKey);
  }
  if (threadId && runtime.currentRunKeyByThreadId.get(threadId) === runKey) {
    runtime.currentRunKeyByThreadId.delete(threadId);
  }
}

function mergeReplyDetailText(previousText, nextText, { mode = "replace" } = {}) {
  const previous = typeof previousText === "string" ? previousText : "";
  const next = typeof nextText === "string" ? nextText : "";
  if (!next) {
    return previous;
  }
  if (!previous) {
    return next;
  }
  if (next === previous) {
    return previous;
  }
  if (next.startsWith(previous) || next.includes(previous)) {
    return next;
  }
  if (previous.startsWith(next) || previous.includes(next)) {
    return previous;
  }

  const overlap = findTextOverlap(previous, next);
  if (overlap > 0) {
    return `${previous}${next.slice(overlap)}`;
  }

  if (mode === "append") {
    return `${previous}${next}`;
  }

  return next.length >= previous.length ? next : previous;
}

function findTextOverlap(previous, next) {
  const maxOverlap = Math.min(previous.length, next.length);
  for (let length = maxOverlap; length > 0; length -= 1) {
    if (previous.endsWith(next.slice(0, length))) {
      return length;
    }
  }
  return 0;
}

function rememberReplyDetail(runtime, messageId, entry) {
  const normalizedMessageId = normalizeReplyMessageId(messageId);
  if (!normalizedMessageId || !entry) {
    return;
  }
  const previous = runtime.replyDetailByMessageId.get(normalizedMessageId) || null;

  if (runtime.replyDetailByMessageId.has(normalizedMessageId)) {
    runtime.replyDetailByMessageId.delete(normalizedMessageId);
  }
  runtime.replyDetailByMessageId.set(normalizedMessageId, {
    fullText: resolveReplyDetailContent(entry),
    previewText: typeof entry.text === "string" ? entry.text : "",
    detailItems: cloneReplyDetailItems(entry.detailItems),
    detailSnapshots: cloneReplyDetailSnapshots(entry.detailSnapshots),
    state: entry.state || "streaming",
    threadId: entry.threadId || "",
    turnId: entry.turnId || "",
    updatedAt: new Date().toISOString(),
    detailMessageId: normalizeReplyMessageId(previous?.detailMessageId || ""),
  });
  while (runtime.replyDetailByMessageId.size > MAX_REPLY_DETAIL_ENTRIES) {
    const oldestMessageId = runtime.replyDetailByMessageId.keys().next().value;
    if (!oldestMessageId) {
      break;
    }
    runtime.replyDetailByMessageId.delete(oldestMessageId);
  }
}

function linkReplyDetailAlias(runtime, { aliasMessageId, sourceMessageId }) {
  const normalizedAliasMessageId = normalizeReplyMessageId(aliasMessageId);
  const normalizedSourceMessageId = normalizeReplyMessageId(sourceMessageId);
  if (!normalizedAliasMessageId || !normalizedSourceMessageId) {
    return;
  }

  const source = runtime.replyDetailByMessageId.get(normalizedSourceMessageId) || null;
  if (!source) {
    return;
  }

  const previous = runtime.replyDetailByMessageId.get(normalizedAliasMessageId) || null;
  runtime.replyDetailByMessageId.set(normalizedAliasMessageId, {
    ...source,
    detailMessageId: normalizeReplyMessageId(previous?.detailMessageId || ""),
  });
}

async function syncOpenReplyDetailCard(runtime, sourceMessageId) {
  const normalizedMessageId = normalizeReplyMessageId(sourceMessageId);
  if (!normalizedMessageId) {
    return;
  }

  const detail = runtime.replyDetailByMessageId.get(normalizedMessageId) || null;
  if (!detail?.detailMessageId) {
    return;
  }

  const content = resolveReplyDetailContent(detail);
  if (!content || Buffer.byteLength(content, "utf8") > ASSISTANT_REPLY_MAX_BYTES) {
    return;
  }

  await patchInteractiveCard(runtime, {
    messageId: detail.detailMessageId,
    card: buildAssistantDetailCard({
      text: content,
      state: detail.state,
    }),
  });
}

function resolveReplyDetailContent(entry) {
  if (!entry || typeof entry !== "object") {
    return "";
  }
  const detailSnapshots = normalizeReplyDetailSnapshots(entry.detailSnapshots);
  if (detailSnapshots.length) {
    return detailSnapshots[detailSnapshots.length - 1].text;
  }
  const detailItems = normalizeReplyDetailItems(entry.detailItems);
  if (detailItems.length) {
    return detailItems[detailItems.length - 1].text;
  }
  const fullText = typeof entry.fullText === "string" ? entry.fullText : "";
  if (fullText) {
    return fullText;
  }
  const previewText = typeof entry.previewText === "string"
    ? entry.previewText
    : typeof entry.text === "string"
      ? entry.text
      : "";
  if (previewText) {
    return previewText;
  }
  if (entry.state === "failed") {
    return "执行失败";
  }
  if (entry.state === "completed") {
    return "执行完成";
  }
  return "";
}

function buildReplyDetailFileName(detail) {
  const threadSuffix = normalizeFileFragment(detail?.threadId).slice(-8) || "reply";
  const turnSuffix = normalizeFileFragment(detail?.turnId).slice(-8) || "turn";
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `codex-output-${threadSuffix}-${turnSuffix}-${timestamp}.md`;
}

function normalizeFileFragment(value) {
  return String(value || "").replace(/[^a-zA-Z0-9_-]+/g, "");
}

function normalizeReplyMessageId(messageId) {
  return typeof messageId === "string" && messageId.trim()
    ? messageId.trim().split(":")[0]
    : "";
}

function captureReplySnapshot(entry) {
  if (!entry || typeof entry !== "object") {
    return;
  }

  if (!Array.isArray(entry.detailSnapshots)) {
    entry.detailSnapshots = [];
  }

  const text = resolveSnapshotText(entry);
  if (!text) {
    return;
  }

  const previous = entry.detailSnapshots[entry.detailSnapshots.length - 1] || null;
  if (previous && previous.text === text && previous.state === (entry.state || "streaming")) {
    return;
  }

  entry.detailSnapshots.push({
    text,
    state: entry.state || "streaming",
    updatedAt: new Date().toISOString(),
  });
  while (entry.detailSnapshots.length > MAX_REPLY_DETAIL_SNAPSHOTS) {
    entry.detailSnapshots.shift();
  }
}

function resolveSnapshotText(entry) {
  if (!entry || typeof entry !== "object") {
    return "";
  }
  const detailItems = normalizeReplyDetailItems(entry.detailItems);
  if (detailItems.length > 1) {
    return detailItems.map((item) => item.text).join("\n\n");
  }
  if (detailItems.length === 1) {
    return detailItems[0].text;
  }
  const fullText = typeof entry.fullText === "string" ? entry.fullText.trim() : "";
  if (fullText) {
    return fullText;
  }
  const previewText = typeof entry.text === "string" ? entry.text.trim() : "";
  return previewText;
}

function upsertReplyDetailItem(entry, { itemId = "", text = "", mode = "replace" } = {}) {
  if (!entry || typeof text !== "string" || !text) {
    return null;
  }

  if (!Array.isArray(entry.detailItems)) {
    entry.detailItems = [];
  }

  const normalizedItemId = normalizeReplyItemId(itemId);
  let detailItem = normalizedItemId
    ? entry.detailItems.find((candidate) => candidate.itemId === normalizedItemId) || null
    : entry.detailItems[entry.detailItems.length - 1] || null;

  if (!detailItem) {
    detailItem = {
      itemId: normalizedItemId || `assistant-${entry.detailItems.length + 1}`,
      text: "",
    };
    entry.detailItems.push(detailItem);
    while (entry.detailItems.length > MAX_REPLY_DETAIL_ITEMS) {
      entry.detailItems.shift();
    }
  }

  detailItem.text = mergeReplyDetailText(detailItem.text, text, { mode });
  return detailItem;
}

function normalizeReplyItemId(itemId) {
  return typeof itemId === "string" && itemId.trim() ? itemId.trim() : "";
}

function normalizeReplyDetailItems(detailItems) {
  if (!Array.isArray(detailItems)) {
    return [];
  }
  return detailItems
    .filter((item) => item && typeof item === "object")
    .map((item) => ({
      itemId: normalizeReplyItemId(item.itemId),
      text: typeof item.text === "string" ? item.text.trim() : "",
    }))
    .filter((item) => item.text);
}

function cloneReplyDetailItems(detailItems) {
  return normalizeReplyDetailItems(detailItems).map((item) => ({ ...item }));
}

function formatReplyDetailItems(detailItems) {
  const lastIndex = detailItems.length - 1;
  return detailItems.map((item, index) => {
    const title = index === lastIndex ? "**最终输出**" : `**过程 ${index + 1}**`;
    return [
      title,
      "",
      item.text,
    ].join("\n");
  }).join("\n\n---\n\n");
}

function normalizeReplyDetailSnapshots(detailSnapshots) {
  if (!Array.isArray(detailSnapshots)) {
    return [];
  }
  return detailSnapshots
    .filter((snapshot) => snapshot && typeof snapshot === "object")
    .map((snapshot) => ({
      text: typeof snapshot.text === "string" ? snapshot.text.trim() : "",
      state: typeof snapshot.state === "string" ? snapshot.state.trim() : "streaming",
      updatedAt: typeof snapshot.updatedAt === "string" ? snapshot.updatedAt.trim() : "",
    }))
    .filter((snapshot) => snapshot.text);
}

function cloneReplyDetailSnapshots(detailSnapshots) {
  return normalizeReplyDetailSnapshots(detailSnapshots).map((snapshot) => ({ ...snapshot }));
}

function formatReplyDetailSnapshots(detailSnapshots) {
  const lastIndex = detailSnapshots.length - 1;
  return detailSnapshots.map((snapshot, index) => {
    const title = index === lastIndex ? "**最终快照**" : `**流式快照 ${index + 1}**`;
    return [
      title,
      "",
      snapshot.text,
    ].join("\n");
  }).join("\n\n---\n\n");
}


module.exports = {
  addPendingReaction,
  clearPendingReactionForBinding,
  clearPendingReactionForThread,
  disposeReplyRunState,
  handleCardAction,
  movePendingReactionToThread,
  patchInteractiveCard,
  queueCardActionWithFeedback,
  runCardActionTask,
  sendCardActionFeedback,
  sendCardActionFeedbackByContext,
  sendInfoCardMessage,
  sendInteractiveApprovalCard,
  sendInteractiveCard,
  showAssistantReplyDetail,
  linkReplyDetailAlias,
  updateInteractiveCard,
  upsertAssistantReplyCard,
};
