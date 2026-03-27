const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { SessionStore } = require("../src/infra/storage/session-store");

function createTempStore() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-im-session-store-"));
  const filePath = path.join(tempDir, "sessions.json");
  return {
    tempDir,
    store: new SessionStore({ filePath }),
  };
}

test("SessionStore persists long-mode metadata and reviewer lookups", () => {
  const { tempDir, store } = createTempStore();

  try {
    store.setThreadIdForWorkspace("binding-1", "/repo", "main-1");
    store.setLongModeForThread("binding-1", "main-1", {
      enabled: true,
      reviewerThreadId: "reviewer-1",
    });

    const reloaded = new SessionStore({
      filePath: path.join(tempDir, "sessions.json"),
    });
    const longMode = reloaded.getLongModeForThread("binding-1", "main-1");
    const reverse = reloaded.findMainThreadIdByReviewerThreadId("reviewer-1");

    assert.equal(longMode.enabled, true);
    assert.equal(longMode.reviewerThreadId, "reviewer-1");
    assert.ok(longMode.createdAt);
    assert.ok(longMode.updatedAt);
    assert.equal(reverse.bindingKey, "binding-1");
    assert.equal(reverse.mainThreadId, "main-1");
    assert.equal(reverse.reviewerThreadId, "reviewer-1");
    assert.equal(reloaded.getThreadIdForWorkspace("binding-1", "/repo"), "main-1");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("SessionStore persists delivery context, session sync state, and summary card state", () => {
  const { tempDir, store } = createTempStore();

  try {
    store.setThreadIdForWorkspace("binding-1", "/repo", "thread-1");
    store.setDeliveryContextForWorkspace("binding-1", "/repo", {
      chatId: "chat-1",
      threadKey: "root-1",
      lastSourceMessageId: "message-1",
    });
    store.setSessionSyncStateForWorkspace("binding-1", "/repo", {
      threadId: "thread-1",
      sessionPath: "/tmp/thread-1.jsonl",
      readOffset: 128,
      lastRecordKey: "record-1",
      lastTurnId: "turn-1",
      lastSeenThreadUpdatedAt: 42,
    });
    store.setSummaryCardStateForWorkspace("binding-1", "/repo", {
      messageId: "summary-1",
      threadId: "thread-1",
      turnId: "turn-1",
      state: "streaming",
    });

    const reloaded = new SessionStore({
      filePath: path.join(tempDir, "sessions.json"),
    });

    assert.deepEqual(reloaded.getDeliveryContextForWorkspace("binding-1", "/repo"), {
      chatId: "chat-1",
      threadKey: "root-1",
      lastSourceMessageId: "message-1",
      updatedAt: reloaded.getDeliveryContextForWorkspace("binding-1", "/repo").updatedAt,
    });
    assert.deepEqual(reloaded.getSessionSyncStateForWorkspace("binding-1", "/repo"), {
      threadId: "thread-1",
      sessionPath: "/tmp/thread-1.jsonl",
      readOffset: 128,
      lastRecordKey: "record-1",
      lastTurnId: "turn-1",
      lastSeenThreadUpdatedAt: 42,
      updatedAt: reloaded.getSessionSyncStateForWorkspace("binding-1", "/repo").updatedAt,
    });
    assert.deepEqual(reloaded.getSummaryCardStateForWorkspace("binding-1", "/repo"), {
      messageId: "summary-1",
      threadId: "thread-1",
      turnId: "turn-1",
      state: "streaming",
      updatedAt: reloaded.getSummaryCardStateForWorkspace("binding-1", "/repo").updatedAt,
    });

    const tracked = reloaded.findTrackedBindingsByThreadId("thread-1");
    assert.equal(tracked.length, 1);
    assert.equal(tracked[0].bindingKey, "binding-1");
    assert.equal(tracked[0].workspaceRoot, "/repo");
    assert.equal(tracked[0].deliveryContext.chatId, "chat-1");
    assert.equal(tracked[0].sessionSyncState.sessionPath, "/tmp/thread-1.jsonl");
    assert.equal(tracked[0].summaryCardState.messageId, "summary-1");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("SessionStore persists waiting_external review chains for long-mode wakeups", () => {
  const { tempDir, store } = createTempStore();

  try {
    store.setThreadIdForWorkspace("binding-1", "/repo", "main-1");
    store.setWaitingExternalReviewForThread("binding-1", "main-1", {
      id: "chain-1",
      workspaceRoot: "/repo",
      reviewerThreadId: "reviewer-1",
      chatId: "chat-1",
      replyToMessageId: "message-1",
      userText: "measure first, then wait for reviewer follow-up",
      continueCount: 2,
      bypassAfterLimit: false,
      latestMainTurnId: "turn-7",
      lastReviewRequestedTurnId: "turn-7",
    });

    const reloaded = new SessionStore({
      filePath: path.join(tempDir, "sessions.json"),
    });
    const waiting = reloaded.getWaitingExternalReviewForThread("binding-1", "main-1");
    const listed = reloaded.listWaitingExternalReviewEntries();

    assert.deepEqual(waiting, {
      id: "chain-1",
      workspaceRoot: "/repo",
      reviewerThreadId: "reviewer-1",
      chatId: "chat-1",
      replyToMessageId: "message-1",
      userText: "measure first, then wait for reviewer follow-up",
      continueCount: 2,
      bypassAfterLimit: false,
      latestMainTurnId: "turn-7",
      lastReviewRequestedTurnId: "turn-7",
      createdAt: waiting.createdAt,
      updatedAt: waiting.updatedAt,
    });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].bindingKey, "binding-1");
    assert.equal(listed[0].mainThreadId, "main-1");
    assert.equal(listed[0].reviewerThreadId, "reviewer-1");

    reloaded.clearWaitingExternalReviewForThread("binding-1", "main-1");
    assert.equal(reloaded.getWaitingExternalReviewForThread("binding-1", "main-1"), null);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("SessionStore keeps p2p replies on sender binding and only uses thread binding when it already exists", () => {
  const { tempDir, store } = createTempStore();

  try {
    store.setThreadIdForWorkspace("default:chat-1:sender:user-1", "/repo", "thread-1");

    assert.equal(
      store.buildBindingKey({
        workspaceId: "default",
        chatId: "chat-1",
        chatType: "p2p",
        threadKey: "root-1",
        senderId: "user-1",
        messageId: "message-2",
      }),
      "default:chat-1:sender:user-1"
    );

    assert.equal(
      store.buildBindingKey({
        workspaceId: "default",
        chatId: "chat-1",
        chatType: "",
        threadKey: "root-1",
        senderId: "user-1",
        messageId: "message-2",
      }),
      "default:chat-1:sender:user-1"
    );

    store.setThreadIdForWorkspace("default:chat-1:thread:root-1", "/repo", "thread-2");
    assert.equal(
      store.buildBindingKey({
        workspaceId: "default",
        chatId: "chat-1",
        chatType: "group",
        threadKey: "root-new",
        senderId: "user-1",
        messageId: "message-3",
      }),
      "default:chat-1:sender:user-1"
    );

    assert.equal(
      store.buildBindingKey({
        workspaceId: "default",
        chatId: "chat-1",
        chatType: "group",
        threadKey: "root-1",
        senderId: "user-1",
        messageId: "message-2",
      }),
      "default:chat-1:thread:root-1"
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("SessionStore keeps the first group reply thread binding when no prior sender context exists", () => {
  const { tempDir, store } = createTempStore();

  try {
    assert.equal(
      store.buildBindingKey({
        workspaceId: "default",
        chatId: "chat-3",
        chatType: "group",
        threadKey: "root-1",
        senderId: "user-3",
        messageId: "message-1",
      }),
      "default:chat-3:thread:root-1"
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
