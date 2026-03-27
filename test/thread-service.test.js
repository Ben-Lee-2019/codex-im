const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  ensureThreadAndSendMessage,
  ensureThreadResumed,
  handleNewCommand,
  refreshWorkspaceThreads,
  resolveWorkspaceThreadState,
} = require("../src/domain/thread/thread-service");

function buildRuntime({
  currentThreadId = "",
  listThreadsImpl,
  sessionPath = "",
} = {}) {
  return {
    codex: {
      listThreads: listThreadsImpl,
    },
    sessionStore: {
      getThreadIdForWorkspace(bindingKey, workspaceRoot) {
        assert.equal(bindingKey, "binding-1");
        assert.equal(workspaceRoot, "/repo");
        return currentThreadId;
      },
    },
    threadSessionPathByThreadId: new Map(currentThreadId ? [[currentThreadId, sessionPath]] : []),
    resumedThreadIds: new Set(),
  };
}

function makeTempSessionFile(fileName = "thread.jsonl", content = '{"ok":1}\n') {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-im-thread-test-"));
  const sessionPath = path.join(tempDir, fileName);
  fs.writeFileSync(sessionPath, content);
  return sessionPath;
}

test("refreshWorkspaceThreads keeps the stored thread as a cached placeholder when thread/list is empty", async () => {
  const runtime = buildRuntime({
    currentThreadId: "thread-1",
    sessionPath: "/tmp/thread-1.jsonl",
    listThreadsImpl: async () => ({
      result: {
        data: [],
        nextCursor: "",
      },
    }),
  });

  const threads = await refreshWorkspaceThreads(runtime, "binding-1", "/repo", {});
  assert.equal(threads.length, 1);
  assert.equal(threads[0].id, "thread-1");
  assert.equal(threads[0].path, "/tmp/thread-1.jsonl");
  assert.equal(threads[0].cwd, "/repo");
});

test("refreshWorkspaceThreads keeps the stored thread as a cached placeholder when thread/list throws", async () => {
  const runtime = buildRuntime({
    currentThreadId: "thread-2",
    listThreadsImpl: async () => {
      throw new Error("rpc down");
    },
  });

  const threads = await refreshWorkspaceThreads(runtime, "binding-1", "/repo", {});
  assert.equal(threads.length, 1);
  assert.equal(threads[0].id, "thread-2");
  assert.equal(threads[0].statusType, "unknown");
});

test("ensureThreadAndSendMessage does not silently recreate a missing thread", async () => {
  let startThreadCalled = false;
  const sessionPath = makeTempSessionFile("thread-1.jsonl");
  const runtime = {
    codex: {
      listThreads: async () => ({ result: { data: [], nextCursor: "" } }),
      resumeThread: async () => ({ result: { thread: { path: sessionPath } } }),
      sendUserMessage: async () => {
        throw new Error("no rollout found for thread id thread-1");
      },
      startThread: async () => {
        startThreadCalled = true;
        return { result: { thread: { id: "thread-new" } } };
      },
    },
    config: {
      defaultCodexAccessMode: "default",
    },
    getCodexParamsForWorkspace() {
      return { model: "", effort: "" };
    },
    ensureLongModeForMainThread: async () => {},
    prepareTurnDelivery: async () => {},
    primeSessionSyncCursor: async () => {},
    rememberFeishuPromptFingerprint() {},
    recordAcceptedSend() {},
    setThreadBindingKey() {},
    setThreadWorkspaceRoot() {},
    turnDeliveryModeByThreadId: new Map(),
    resumedThreadIds: new Set(),
    threadSessionPathByThreadId: new Map(),
  };

  await assert.rejects(
    ensureThreadAndSendMessage(runtime, {
      bindingKey: "binding-1",
      workspaceRoot: "/repo",
      normalized: { provider: "feishu", text: "hello" },
      threadId: "thread-1",
      reviewSendOptions: {},
    }),
    /no rollout found for thread id thread-1/
  );
  assert.equal(startThreadCalled, false);
});

test("ensureThreadAndSendMessage rejects when no thread is selected instead of auto-creating one", async () => {
  let startThreadCalled = false;
  const runtime = {
    codex: {
      startThread: async () => {
        startThreadCalled = true;
        return { result: { thread: { id: "thread-new" } } };
      },
    },
    config: {
      defaultCodexAccessMode: "default",
    },
    getCodexParamsForWorkspace() {
      return { model: "", effort: "" };
    },
    turnDeliveryModeByThreadId: new Map(),
  };

  await assert.rejects(
    ensureThreadAndSendMessage(runtime, {
      bindingKey: "binding-1",
      workspaceRoot: "/repo",
      normalized: { provider: "feishu", text: "hello" },
      threadId: "",
      reviewSendOptions: {},
    }),
    /不会自动新建/
  );
  assert.equal(startThreadCalled, false);
});

test("handleNewCommand sends only the creation info card without opening the status panel", async () => {
  const sentInfoCards = [];
  let statusPanelCalled = false;
  let persistedThread = null;
  const runtime = {
    codex: {
      startThread: async () => ({
        result: {
          thread: {
            id: "thread-new",
            path: "/tmp/thread-new.jsonl",
          },
        },
      }),
    },
    sessionStore: {
      buildBindingKey() {
        return "binding-1";
      },
      setThreadIdForWorkspace(bindingKey, workspaceRoot, threadId) {
        persistedThread = { bindingKey, workspaceRoot, threadId };
      },
    },
    resolveWorkspaceRootForBinding() {
      return "/repo";
    },
    sendInfoCardMessage: async (payload) => {
      sentInfoCards.push(payload);
    },
    showStatusPanel: async () => {
      statusPanelCalled = true;
    },
    resumedThreadIds: new Set(),
    threadSessionPathByThreadId: new Map(),
    freshThreadIds: new Set(),
    placeholderThreadIds: new Set(),
    setPendingThreadContext() {},
    setThreadBindingKey() {},
    setThreadWorkspaceRoot() {},
  };

  await handleNewCommand(runtime, {
    chatId: "chat-1",
    messageId: "msg-1",
  });

  assert.deepEqual(persistedThread, {
    bindingKey: "binding-1",
    workspaceRoot: "/repo",
    threadId: "thread-new",
  });
  assert.deepEqual(sentInfoCards, [{
    chatId: "chat-1",
    replyToMessageId: "msg-1",
    text: "已创建新线程并切换到它:\n/repo\n\nthread: thread-new",
  }]);
  assert.equal(statusPanelCalled, false);
});

test("resolveWorkspaceThreadState preserves a visible stored thread even if selection logic returns empty", async () => {
  let cleared = false;
  const runtime = {
    codex: {
      listThreads: async () => ({
        result: {
          data: [{
            id: "thread-1",
            cwd: "/repo",
            createdAt: 1,
            updatedAt: 2,
            source: "vscode",
          }],
          nextCursor: "",
        },
      }),
    },
    sessionStore: {
      getThreadIdForWorkspace() {
        return "thread-1";
      },
      clearThreadIdForWorkspace() {
        cleared = true;
      },
      setThreadIdForWorkspace() {
        throw new Error("should not rewrite selected thread");
      },
    },
    resolveThreadIdForBinding() {
      return "thread-1";
    },
    resolveConversationThreadSelection() {
      return {
        selectedThreadId: "",
        threadId: "",
      };
    },
    reviewerMainThreadIdByReviewerThreadId: new Map(),
    isReviewerThreadId() {
      return false;
    },
    setThreadBindingKey() {},
    setThreadWorkspaceRoot() {},
    threadSessionPathByThreadId: new Map(),
    resumedThreadIds: new Set(),
  };

  const result = await resolveWorkspaceThreadState(runtime, {
    bindingKey: "binding-1",
    workspaceRoot: "/repo",
    normalized: { text: "hello" },
    autoSelectThread: true,
  });

  assert.equal(result.threadId, "thread-1");
  assert.equal(result.selectedThreadId, "thread-1");
  assert.equal(cleared, false);
});

test("resolveWorkspaceThreadState clears a stored placeholder thread instead of selecting it", async () => {
  let cleared = false;
  const runtime = {
    codex: {
      listThreads: async () => ({
        result: {
          data: [],
          nextCursor: "",
        },
      }),
      resumeThread: async () => {
        throw new Error("thread not found");
      },
    },
    sessionStore: {
      getThreadIdForWorkspace() {
        return "thread-stale";
      },
      clearThreadIdForWorkspace() {
        cleared = true;
      },
      setThreadIdForWorkspace() {
        throw new Error("should not write a replacement thread");
      },
    },
    resolveThreadIdForBinding() {
      return "thread-stale";
    },
    resolveConversationThreadSelection() {
      return {
        selectedThreadId: "thread-stale",
        threadId: "thread-stale",
      };
    },
    reviewerMainThreadIdByReviewerThreadId: new Map(),
    isReviewerThreadId() {
      return false;
    },
    setThreadBindingKey() {},
    setThreadWorkspaceRoot() {},
    threadSessionPathByThreadId: new Map([["thread-stale", "/tmp/thread-stale.jsonl"]]),
    resumedThreadIds: new Set(),
    placeholderThreadIds: new Set(),
  };

  const result = await resolveWorkspaceThreadState(runtime, {
    bindingKey: "binding-1",
    workspaceRoot: "/repo",
    normalized: { text: "hello" },
    autoSelectThread: true,
  });

  assert.equal(result.threadId, "");
  assert.equal(result.selectedThreadId, "");
  assert.equal(cleared, true);
});

test("resolveWorkspaceThreadState keeps a fresh placeholder thread selected", async () => {
  let cleared = false;
  const runtime = {
    codex: {
      listThreads: async () => ({
        result: {
          data: [],
          nextCursor: "",
        },
      }),
    },
    sessionStore: {
      getThreadIdForWorkspace() {
        return "thread-fresh";
      },
      clearThreadIdForWorkspace() {
        cleared = true;
      },
      setThreadIdForWorkspace() {
        throw new Error("should not rewrite selected thread");
      },
    },
    resolveThreadIdForBinding() {
      return "thread-fresh";
    },
    resolveConversationThreadSelection() {
      return {
        selectedThreadId: "thread-fresh",
        threadId: "thread-fresh",
      };
    },
    reviewerMainThreadIdByReviewerThreadId: new Map(),
    isReviewerThreadId() {
      return false;
    },
    setThreadBindingKey() {},
    setThreadWorkspaceRoot() {},
    threadSessionPathByThreadId: new Map([["thread-fresh", "/tmp/thread-fresh.jsonl"]]),
    resumedThreadIds: new Set(),
    placeholderThreadIds: new Set(["thread-fresh"]),
    freshThreadIds: new Set(["thread-fresh"]),
  };

  const result = await resolveWorkspaceThreadState(runtime, {
    bindingKey: "binding-1",
    workspaceRoot: "/repo",
    normalized: { text: "hello" },
    autoSelectThread: true,
  });

  assert.equal(result.threadId, "thread-fresh");
  assert.equal(result.selectedThreadId, "thread-fresh");
  assert.equal(cleared, false);
});

test("resolveWorkspaceThreadState keeps a restored placeholder thread when resume probe succeeds", async () => {
  let cleared = false;
  const sessionPath = makeTempSessionFile("thread-restored.jsonl");
  const runtime = {
    codex: {
      listThreads: async () => ({
        result: {
          data: [],
          nextCursor: "",
        },
      }),
      resumeThread: async () => ({
        result: {
          thread: {
            path: sessionPath,
          },
        },
      }),
    },
    sessionStore: {
      getThreadIdForWorkspace() {
        return "thread-restored";
      },
      clearThreadIdForWorkspace() {
        cleared = true;
      },
      setThreadIdForWorkspace() {
        throw new Error("should not rewrite selected thread");
      },
    },
    resolveThreadIdForBinding() {
      return "thread-restored";
    },
    resolveConversationThreadSelection() {
      return {
        selectedThreadId: "thread-restored",
        threadId: "thread-restored",
      };
    },
    reviewerMainThreadIdByReviewerThreadId: new Map(),
    isReviewerThreadId() {
      return false;
    },
    setThreadBindingKey() {},
    setThreadWorkspaceRoot() {},
    threadSessionPathByThreadId: new Map(),
    resumedThreadIds: new Set(),
    placeholderThreadIds: new Set(["thread-restored"]),
    freshThreadIds: new Set(),
  };

  const result = await resolveWorkspaceThreadState(runtime, {
    bindingKey: "binding-1",
    workspaceRoot: "/repo",
    normalized: { text: "hello" },
    autoSelectThread: true,
  });

  assert.equal(result.threadId, "thread-restored");
  assert.equal(result.selectedThreadId, "thread-restored");
  assert.equal(cleared, false);
  assert.equal(runtime.threadSessionPathByThreadId.get("thread-restored"), sessionPath);
});

test("ensureThreadResumed refreshes thread state even when the thread was resumed before", async () => {
  let resumeCalls = 0;
  const sessionPath = makeTempSessionFile("thread-1.jsonl");
  const runtime = {
    codex: {
      resumeThread: async () => {
        resumeCalls += 1;
        return { result: { thread: { path: sessionPath } } };
      },
    },
    resumedThreadIds: new Set(["thread-1"]),
    threadSessionPathByThreadId: new Map(),
  };

  await ensureThreadResumed(runtime, "thread-1");
  assert.equal(resumeCalls, 1);
  assert.equal(runtime.threadSessionPathByThreadId.get("thread-1"), sessionPath);
});

test("ensureThreadResumed skips resume for a newly created thread before its first turn", async () => {
  let resumeCalls = 0;
  const runtime = {
    codex: {
      resumeThread: async () => {
        resumeCalls += 1;
        return { result: { thread: { path: "/tmp/thread-1.jsonl" } } };
      },
    },
    freshThreadIds: new Set(["thread-1"]),
    resumedThreadIds: new Set(),
    threadSessionPathByThreadId: new Map(),
  };

  await ensureThreadResumed(runtime, "thread-1");
  assert.equal(resumeCalls, 0);
});

test("ensureThreadResumed skips resume for placeholder threads restored from storage", async () => {
  let resumeCalls = 0;
  const runtime = {
    codex: {
      resumeThread: async () => {
        resumeCalls += 1;
        return { result: { thread: { path: "/tmp/thread-1.jsonl" } } };
      },
    },
    placeholderThreadIds: new Set(["thread-1"]),
    freshThreadIds: new Set(),
    resumedThreadIds: new Set(),
    threadSessionPathByThreadId: new Map(),
  };

  await ensureThreadResumed(runtime, "thread-1");
  assert.equal(resumeCalls, 0);
});

test("ensureThreadResumed sanitizes corrupted session files and re-resumes", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-im-thread-test-"));
  const sessionPath = path.join(tempDir, "thread-corrupted.jsonl");
  fs.writeFileSync(sessionPath, Buffer.from('{"ok":1}\n\0\0{"ok":2}\n', "utf8"));

  let resumeCalls = 0;
  const runtime = {
    codex: {
      resumeThread: async () => {
        resumeCalls += 1;
        return { result: { thread: { path: sessionPath } } };
      },
    },
    resumedThreadIds: new Set(),
    threadSessionPathByThreadId: new Map(),
  };

  await ensureThreadResumed(runtime, "thread-1");

  assert.equal(resumeCalls, 2);
  assert.equal(fs.readFileSync(sessionPath).includes(0), false);
  assert.equal(runtime.threadSessionPathByThreadId.get("thread-1"), sessionPath);
});

test("ensureThreadAndSendMessage refreshes the Codex client before resuming threads with external updates", async () => {
  const calls = [];
  const sessionPath = makeTempSessionFile("thread-1.jsonl");
  const runtime = {
    codex: {
      resumeThread: async () => {
        calls.push("resume");
        return { result: { thread: { path: sessionPath } } };
      },
      sendUserMessage: async () => {
        calls.push("send");
      },
    },
    config: {
      defaultCodexAccessMode: "default",
    },
    getCodexParamsForWorkspace() {
      return { model: "", effort: "" };
    },
    ensureLongModeForMainThread: async () => {},
    primeSessionSyncCursor: async () => {},
    rememberFeishuPromptFingerprint() {},
    recordAcceptedSend() {},
    refreshCodexClientIfThreadStale: async () => {
      calls.push("refresh");
    },
    clearThreadExternalUpdates(threadId) {
      calls.push(`clear:${threadId}`);
    },
    setThreadBindingKey() {},
    setThreadWorkspaceRoot() {},
    turnDeliveryModeByThreadId: new Map(),
    resumedThreadIds: new Set(),
    threadSessionPathByThreadId: new Map(),
    freshThreadIds: new Set(),
    placeholderThreadIds: new Set(),
  };

  await ensureThreadAndSendMessage(runtime, {
    bindingKey: "binding-1",
    workspaceRoot: "/repo",
    normalized: { provider: "feishu", text: "hello" },
    threadId: "thread-1",
    reviewSendOptions: {},
  });

  assert.deepEqual(calls, ["refresh", "resume", "send", "clear:thread-1"]);
});

test("ensureThreadAndSendMessage keeps outbound main-thread prompts unchanged", async () => {
  let sentPayload = null;
  const sessionPath = makeTempSessionFile("thread-main.jsonl");
  const runtime = {
    codex: {
      resumeThread: async () => ({ result: { thread: { path: sessionPath } } }),
      sendUserMessage: async (payload) => {
        sentPayload = payload;
      },
    },
    config: {
      defaultCodexAccessMode: "default",
    },
    getCodexParamsForWorkspace() {
      return { model: "", effort: "" };
    },
    ensureLongModeForMainThread: async () => {},
    primeSessionSyncCursor: async () => {},
    rememberFeishuPromptFingerprint() {},
    recordAcceptedSend() {},
    refreshCodexClientIfThreadStale: async () => {},
    clearThreadExternalUpdates() {},
    setThreadBindingKey() {},
    setThreadWorkspaceRoot() {},
    turnDeliveryModeByThreadId: new Map(),
    resumedThreadIds: new Set(),
    threadSessionPathByThreadId: new Map(),
    freshThreadIds: new Set(),
    placeholderThreadIds: new Set(),
    isReviewerThreadId() {
      return false;
    },
  };

  await ensureThreadAndSendMessage(runtime, {
    bindingKey: "binding-1",
    workspaceRoot: "/repo",
    normalized: { provider: "feishu", text: "please request one A100 and use slurm wakeup" },
    threadId: "thread-main",
    reviewSendOptions: {},
  });

  assert.ok(sentPayload);
  assert.equal(sentPayload.text, "please request one A100 and use slurm wakeup");
});

test("ensureThreadAndSendMessage keeps reviewer-thread prompts unchanged", async () => {
  let sentPayload = null;
  const sessionPath = makeTempSessionFile("thread-reviewer.jsonl");
  const runtime = {
    codex: {
      resumeThread: async () => ({ result: { thread: { path: sessionPath } } }),
      sendUserMessage: async (payload) => {
        sentPayload = payload;
      },
    },
    config: {
      defaultCodexAccessMode: "default",
    },
    getCodexParamsForWorkspace() {
      return { model: "", effort: "" };
    },
    ensureLongModeForMainThread: async () => {},
    primeSessionSyncCursor: async () => {},
    rememberFeishuPromptFingerprint() {},
    recordAcceptedSend() {},
    refreshCodexClientIfThreadStale: async () => {},
    clearThreadExternalUpdates() {},
    setThreadBindingKey() {},
    setThreadWorkspaceRoot() {},
    turnDeliveryModeByThreadId: new Map(),
    resumedThreadIds: new Set(),
    threadSessionPathByThreadId: new Map(),
    freshThreadIds: new Set(),
    placeholderThreadIds: new Set(),
    isReviewerThreadId(threadId) {
      return threadId === "thread-reviewer";
    },
  };

  await ensureThreadAndSendMessage(runtime, {
    bindingKey: "binding-1",
    workspaceRoot: "/repo",
    normalized: { provider: "review", text: "continue the existing work" },
    threadId: "thread-reviewer",
    reviewSendOptions: {},
  });

  assert.ok(sentPayload);
  assert.equal(sentPayload.text, "continue the existing work");
});
