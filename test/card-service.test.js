const test = require("node:test");
const assert = require("node:assert/strict");

const { upsertAssistantReplyCard } = require("../src/presentation/card/card-service");

function createCardRuntime() {
  const sentCards = [];
  const patchedCards = [];
  const runtime = {
    activeTurnIdByThreadId: new Map(),
    currentRunKeyByThreadId: new Map(),
    pendingChatContextByThreadId: new Map(),
    pendingReactionByThreadId: new Map(),
    replyCardByRunKey: new Map(),
    replyDetailByMessageId: new Map(),
    replyFlushTimersByRunKey: new Map(),
    setReplyCardEntry(runKey, entry) {
      this.replyCardByRunKey.set(runKey, entry);
    },
    setCurrentRunKeyForThread(threadId, runKey) {
      this.currentRunKeyByThreadId.set(threadId, runKey);
    },
    disposeReplyRunState(runKey, threadId) {
      this.replyCardByRunKey.delete(runKey);
      if (this.currentRunKeyByThreadId.get(threadId) === runKey) {
        this.currentRunKeyByThreadId.delete(threadId);
      }
    },
    clearPendingReactionForThread: async () => {},
    requireFeishuAdapter() {
      return {
        sendInteractiveCard: async (payload) => {
          sentCards.push(payload);
          return {
            data: {
              message_id: `msg-${sentCards.length}`,
            },
          };
        },
        patchInteractiveCard: async (payload) => {
          patchedCards.push(payload);
          return {};
        },
      };
    },
  };

  return {
    runtime,
    sentCards,
    patchedCards,
  };
}

test("upsertAssistantReplyCard suppresses empty completed cards", async () => {
  const { runtime, sentCards } = createCardRuntime();

  await upsertAssistantReplyCard(runtime, {
    threadId: "thread-1",
    turnId: "turn-1",
    chatId: "chat-1",
    state: "completed",
  });

  assert.equal(sentCards.length, 0);
  assert.equal(runtime.replyCardByRunKey.size, 0);
  assert.equal(runtime.currentRunKeyByThreadId.size, 0);
});

test("upsertAssistantReplyCard still sends completed cards when output exists", async () => {
  const { runtime, sentCards } = createCardRuntime();

  await upsertAssistantReplyCard(runtime, {
    threadId: "thread-1",
    turnId: "turn-1",
    chatId: "chat-1",
    text: "Benchmark finished successfully.",
    state: "completed",
  });

  assert.equal(sentCards.length, 1);
  assert.equal(runtime.replyDetailByMessageId.size, 1);
  assert.equal(runtime.replyCardByRunKey.size, 0);
});
