const test = require("node:test");
const assert = require("node:assert/strict");

const { handleCodexMessage } = require("../src/app/codex-event-service");

test("handleCodexMessage finalizes session-backed reply cards on turn completion", async () => {
  const replyCardCalls = [];
  const reviewCalls = [];
  const cleanedThreadIds = [];
  const clearedReactions = [];

  const runtime = {
    activeTurnIdByThreadId: new Map([["thread-1", "turn-1"]]),
    pendingApprovalByThreadId: new Map(),
    currentRunKeyByThreadId: new Map(),
    pendingChatContextByThreadId: new Map([
      ["thread-1", {
        chatId: "chat-1",
        threadKey: "feishu-thread-1",
        messageId: "source-msg-1",
      }],
    ]),
    turnDeliveryModeByThreadId: new Map([["thread-1", "session"]]),
    subagentTrackerByRunKey: new Map(),
    reviewChainByMainThreadId: new Map(),
    pruneRuntimeMapSizes() {},
    handleReviewLifecycleEvent() {},
    shouldSuppressReviewThreadDelivery() {
      return false;
    },
    handleReviewSuppressedMessage: async () => {},
    upsertAssistantReplyCard: async (payload) => {
      replyCardCalls.push(payload);
    },
    handleMainTurnCompleted: async (payload) => {
      reviewCalls.push(payload);
    },
    clearPendingReactionForThread: async (threadId) => {
      clearedReactions.push(threadId);
    },
    cleanupThreadRuntimeState(threadId) {
      cleanedThreadIds.push(threadId);
    },
  };

  handleCodexMessage(runtime, {
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      turn: {
        id: "turn-1",
        status: "completed",
      },
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(replyCardCalls, [{
    threadId: "thread-1",
    turnId: "turn-1",
    chatId: "chat-1",
    state: "completed",
  }]);
  assert.deepEqual(reviewCalls, [{
    threadId: "thread-1",
    turnId: "turn-1",
  }]);
  assert.deepEqual(clearedReactions, ["thread-1"]);
  assert.deepEqual(cleanedThreadIds, ["thread-1"]);
});
