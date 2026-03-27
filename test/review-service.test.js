const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildReviewerRequestPrompt,
  buildSyntheticContinueText,
  handleMainTurnCompleted,
  handleSuppressedCodexMessage,
  hydratePersistedLongMode,
  parseReviewerVerdict,
  resolveConversationThreadSelection,
} = require("../src/domain/review/review-service");

test("parseReviewerVerdict handles done", () => {
  assert.deepEqual(parseReviewerVerdict("done"), {
    kind: "done",
    note: "",
  });
});

test("parseReviewerVerdict handles continue notes", () => {
  assert.deepEqual(parseReviewerVerdict("continue: rerun the validation suite"), {
    kind: "continue",
    note: "rerun the validation suite",
  });
});

test("parseReviewerVerdict handles wait_external notes", () => {
  assert.deepEqual(parseReviewerVerdict("wait_external: slurm wakeup already queued"), {
    kind: "wait_external",
    note: "slurm wakeup already queued",
  });
});

test("parseReviewerVerdict falls back to needs_human on malformed output", () => {
  assert.deepEqual(parseReviewerVerdict("please continue"), {
    kind: "needs_human",
    note: "malformed reviewer response",
  });
});

test("buildSyntheticContinueText adds the internal prefix", () => {
  assert.match(
    buildSyntheticContinueText("finish the remaining plots"),
    /^\[internal reviewer continue\] finish the remaining plots$/
  );
});

test("buildReviewerRequestPrompt keeps the full latest assistant reply", () => {
  const longReply = "A".repeat(5000);
  const prompt = buildReviewerRequestPrompt({
    mainThreadId: "main-1",
    userText: "finish all required sections",
    continueCount: 3,
  }, {
    latestAssistantReply: longReply,
  });

  assert.match(prompt, new RegExp(`Latest main assistant reply \\(all assistant messages from this main-thread turn\\):\\n${longReply}`));
  assert.equal(prompt.includes("A".repeat(5000)), true);
});

test("buildReviewerRequestPrompt includes the reviewer charter in the same prompt", () => {
  const latestReply = "final complete answer";
  const prompt = buildReviewerRequestPrompt({
    mainThreadId: "main-1",
    userText: "finish all required sections",
    continueCount: 1,
  }, {
    latestAssistantReply: latestReply,
  });

  assert.match(prompt, /You are the companion reviewer for a long-running Codex main thread\./);
  assert.match(prompt, /Main thread id: main-1/);
});

test("buildReviewerRequestPrompt documents the wait_external verdict for planned wakeups", () => {
  const prompt = buildReviewerRequestPrompt({
    mainThreadId: "main-1",
    userText: "finish the GPU run after the cluster wakes you up",
    continueCount: 0,
  }, {
    latestAssistantReply: "Submitted the wakeup job and will now stay idle until it resumes me.",
  });

  assert.match(prompt, /wait_external: <short note>/);
  assert.match(prompt, /prefer wait_external over continue/i);
});

test("resolveConversationThreadSelection remaps reviewer selections to the paired main thread", () => {
  const reviewerMap = new Map([["reviewer-1", "main-1"]]);
  const selection = resolveConversationThreadSelection({
    threads: [
      { id: "reviewer-1" },
      { id: "main-1" },
      { id: "main-2" },
    ],
    selectedThreadId: "reviewer-1",
    reviewerMainThreadIdByReviewerThreadId: reviewerMap,
  });

  assert.deepEqual(selection, {
    selectedThreadId: "main-1",
    threadId: "main-1",
  });
});

test("resolveConversationThreadSelection avoids auto-selecting reviewer-only threads", () => {
  const reviewerMap = new Map([["reviewer-1", "main-1"]]);
  const selection = resolveConversationThreadSelection({
    threads: [
      { id: "reviewer-1" },
    ],
    selectedThreadId: "",
    reviewerMainThreadIdByReviewerThreadId: reviewerMap,
  });

  assert.deepEqual(selection, {
    selectedThreadId: "",
    threadId: "",
  });
});

test("resolveConversationThreadSelection does not auto-select a main thread when nothing is selected", () => {
  const selection = resolveConversationThreadSelection({
    threads: [
      { id: "main-1" },
      { id: "main-2" },
    ],
    selectedThreadId: "",
    reviewerMainThreadIdByReviewerThreadId: new Map(),
  });

  assert.deepEqual(selection, {
    selectedThreadId: "",
    threadId: "",
  });
});

test("hydratePersistedLongMode restores waiting_external review chains", () => {
  const runtime = {
    sessionStore: {
      listLongModeEntries: () => [{
        bindingKey: "binding-1",
        mainThreadId: "main-1",
        enabled: true,
        reviewerThreadId: "reviewer-1",
        createdAt: "2026-03-25T00:00:00.000Z",
        updatedAt: "2026-03-25T00:00:00.000Z",
      }],
      listWaitingExternalReviewEntries: () => [{
        bindingKey: "binding-1",
        mainThreadId: "main-1",
        id: "chain-1",
        workspaceRoot: "/repo",
        reviewerThreadId: "reviewer-1",
        chatId: "chat-1",
        replyToMessageId: "message-1",
        userText: "finish the measurement after wake-up",
        continueCount: 1,
        bypassAfterLimit: false,
        latestMainTurnId: "turn-1",
        lastReviewRequestedTurnId: "turn-1",
        createdAt: "2026-03-25T00:00:00.000Z",
        updatedAt: "2026-03-25T00:00:00.000Z",
      }],
    },
    longModeByMainThreadId: new Map(),
    reviewerMainThreadIdByReviewerThreadId: new Map(),
    reviewChainByMainThreadId: new Map(),
  };

  hydratePersistedLongMode(runtime);

  assert.deepEqual(runtime.longModeByMainThreadId.get("main-1"), {
    bindingKey: "binding-1",
    enabled: true,
    reviewerThreadId: "reviewer-1",
    createdAt: "2026-03-25T00:00:00.000Z",
    updatedAt: "2026-03-25T00:00:00.000Z",
  });
  assert.deepEqual(runtime.reviewChainByMainThreadId.get("main-1"), {
    id: "chain-1",
    bindingKey: "binding-1",
    workspaceRoot: "/repo",
    mainThreadId: "main-1",
    reviewerThreadId: "reviewer-1",
    chatId: "chat-1",
    replyToMessageId: "message-1",
    userText: "finish the measurement after wake-up",
    continueCount: 1,
    bypassAfterLimit: false,
    latestMainTurnId: "turn-1",
    lastReviewRequestedTurnId: "turn-1",
    status: "waiting_external",
    createdAt: "2026-03-25T00:00:00.000Z",
    updatedAt: "2026-03-25T00:00:00.000Z",
  });
});

test("handleMainTurnCompleted recreates a missing reviewer thread before re-queueing review", async () => {
  const resumeCalls = [];
  const sendCalls = [];
  const persistedLongMode = new Map([
    ["main-1", {
      enabled: true,
      reviewerThreadId: "reviewer-old",
      createdAt: "2026-03-24T00:00:00.000Z",
      updatedAt: "2026-03-24T00:00:00.000Z",
    }],
  ]);
  const runtime = {
    codex: {
      resumeThread: async ({ threadId }) => {
        resumeCalls.push(threadId);
        return {
          result: {
            thread: {
              turns: [
                {
                  items: [
                    { type: "userMessage", content: "finish all required sections" },
                    { type: "agentMessage", text: "I stopped after the benchmark." },
                  ],
                },
              ],
            },
          },
        };
      },
      startThread: async () => ({
        result: {
          thread: {
            id: "reviewer-new",
            path: "/tmp/reviewer-new.jsonl",
          },
        },
      }),
      sendUserMessage: async (payload) => {
        sendCalls.push(payload);
      },
    },
    config: {
      defaultCodexAccessMode: "default",
    },
    getCodexParamsForWorkspace() {
      return { model: "", effort: "" };
    },
    ensureThreadResumed: async (threadId) => {
      if (runtime.freshThreadIds.has(threadId) || runtime.placeholderThreadIds.has(threadId)) {
        return null;
      }
      assert.equal(threadId, "reviewer-old");
      throw new Error("thread not found: reviewer-old");
    },
    setThreadBindingKey() {},
    setThreadWorkspaceRoot() {},
    sessionStore: {
      setLongModeForThread(_bindingKey, mainThreadId, nextState) {
        const previous = persistedLongMode.get(mainThreadId) || {};
        persistedLongMode.set(mainThreadId, {
          ...previous,
          ...nextState,
          createdAt: previous.createdAt || "2026-03-24T00:00:00.000Z",
          updatedAt: "2026-03-25T00:00:00.000Z",
        });
      },
      getLongModeForThread(_bindingKey, mainThreadId) {
        return persistedLongMode.get(mainThreadId) || null;
      },
    },
    longModeByMainThreadId: new Map([
      ["main-1", {
        bindingKey: "binding-1",
        enabled: true,
        reviewerThreadId: "reviewer-old",
        createdAt: "2026-03-24T00:00:00.000Z",
        updatedAt: "2026-03-24T00:00:00.000Z",
      }],
    ]),
    threadSessionPathByThreadId: new Map(),
    resumedThreadIds: new Set(),
    freshThreadIds: new Set(),
    placeholderThreadIds: new Set(),
    activeTurnIdByThreadId: new Map(),
    reviewerBootstrapPendingThreadIds: new Set(),
    pendingReviewDispatchByReviewerThreadId: new Map(),
    reviewAwaitingVerdictByReviewerThreadId: new Map(),
    reviewChainByMainThreadId: new Map([
      ["main-1", {
        id: "chain-1",
        bindingKey: "binding-1",
        workspaceRoot: "/repo",
        mainThreadId: "main-1",
        reviewerThreadId: "reviewer-old",
        chatId: "chat-1",
        replyToMessageId: "message-1",
        userText: "finish all required sections",
        continueCount: 0,
        bypassAfterLimit: false,
        latestMainTurnId: "turn-1",
        lastReviewRequestedTurnId: "",
        status: "running_main",
        createdAt: "2026-03-24T00:00:00.000Z",
        updatedAt: "2026-03-24T00:00:00.000Z",
      }],
    ]),
    reviewerMainThreadIdByReviewerThreadId: new Map([
      ["reviewer-old", "main-1"],
    ]),
  };

  await handleMainTurnCompleted(runtime, {
    threadId: "main-1",
    turnId: "turn-2",
  });

  assert.equal(runtime.reviewChainByMainThreadId.get("main-1").reviewerThreadId, "reviewer-new");
  assert.equal(runtime.reviewChainByMainThreadId.get("main-1").status, "awaiting_reviewer");
  assert.equal(runtime.reviewChainByMainThreadId.get("main-1").lastReviewRequestedTurnId, "turn-2");
  assert.equal(runtime.reviewerMainThreadIdByReviewerThreadId.get("reviewer-old"), undefined);
  assert.equal(runtime.reviewerMainThreadIdByReviewerThreadId.get("reviewer-new"), "main-1");
  assert.equal(runtime.reviewerBootstrapPendingThreadIds.has("reviewer-new"), false);
  assert.equal(runtime.pendingReviewDispatchByReviewerThreadId.size, 0);
  assert.deepEqual(runtime.reviewAwaitingVerdictByReviewerThreadId.get("reviewer-new"), {
    chainId: "chain-1",
    mainThreadId: "main-1",
    turnId: "",
  });
  assert.deepEqual(resumeCalls, ["main-1", "main-1"]);
  assert.deepEqual(sendCalls.map((payload) => payload.threadId), ["reviewer-new"]);
  assert.match(sendCalls[0].text, /You are the companion reviewer/);
  assert.equal(sendCalls[0].model, "gpt-5.4");
  assert.equal(sendCalls[0].effort, "medium");
  assert.equal(runtime.freshThreadIds.has("reviewer-new"), false);
  assert.equal(runtime.placeholderThreadIds.has("reviewer-new"), false);
});

test("handleMainTurnCompleted resumes the reviewer thread before dispatching review", async () => {
  const calls = [];
  const runtime = {
    codex: {
      resumeThread: async ({ threadId }) => {
        calls.push(`resume-main:${threadId}`);
        return {
          result: {
            thread: {
              turns: [
                {
                  items: [
                    { type: "userMessage", content: "finish all required sections" },
                    { type: "agentMessage", text: "I stopped after the benchmark." },
                  ],
                },
              ],
            },
          },
        };
      },
      sendUserMessage: async (payload) => {
        calls.push(`send-review:${payload.threadId}`);
      },
    },
    config: {
      defaultCodexAccessMode: "default",
    },
    getCodexParamsForWorkspace() {
      return { model: "", effort: "" };
    },
    ensureThreadResumed: async (threadId) => {
      calls.push(`resume-reviewer:${threadId}`);
    },
    setThreadBindingKey() {},
    setThreadWorkspaceRoot() {},
    threadSessionPathByThreadId: new Map(),
    activeTurnIdByThreadId: new Map(),
    reviewerBootstrapPendingThreadIds: new Set(),
    pendingReviewDispatchByReviewerThreadId: new Map(),
    reviewAwaitingVerdictByReviewerThreadId: new Map(),
    reviewChainByMainThreadId: new Map([
      ["main-1", {
        id: "chain-1",
        bindingKey: "binding-1",
        workspaceRoot: "/repo",
        mainThreadId: "main-1",
        reviewerThreadId: "reviewer-1",
        chatId: "chat-1",
        replyToMessageId: "message-1",
        userText: "finish all required sections",
        continueCount: 0,
        bypassAfterLimit: false,
        latestMainTurnId: "turn-1",
        lastReviewRequestedTurnId: "",
        status: "running_main",
        createdAt: "2026-03-24T00:00:00.000Z",
        updatedAt: "2026-03-24T00:00:00.000Z",
      }],
    ]),
    reviewerMainThreadIdByReviewerThreadId: new Map([
      ["reviewer-1", "main-1"],
    ]),
  };

  await handleMainTurnCompleted(runtime, {
    threadId: "main-1",
    turnId: "turn-2",
  });

  assert.deepEqual(calls, [
    "resume-main:main-1",
    "resume-reviewer:reviewer-1",
    "send-review:reviewer-1",
  ]);
});

test("handleMainTurnCompleted restores a waiting_external chain when reviewer dispatch fails", async () => {
  const resumeCalls = [];
  const sendCalls = [];
  const persistedWaitingExternal = [];
  const runtime = {
    codex: {
      resumeThread: async ({ threadId }) => {
        resumeCalls.push(threadId);
        return {
          result: {
            thread: {
              turns: [
                {
                  items: [
                    { type: "userMessage", content: "finish all required sections" },
                    { type: "agentMessage", text: "I stopped after the benchmark." },
                  ],
                },
              ],
            },
          },
        };
      },
      sendUserMessage: async (payload) => {
        sendCalls.push(payload);
      },
    },
    config: {
      defaultCodexAccessMode: "default",
    },
    getCodexParamsForWorkspace() {
      return { model: "", effort: "" };
    },
    ensureThreadResumed: async (threadId) => {
      assert.equal(threadId, "reviewer-1");
      throw new Error("Codex RPC client transport closed");
    },
    setThreadBindingKey() {},
    setThreadWorkspaceRoot() {},
    threadSessionPathByThreadId: new Map(),
    activeTurnIdByThreadId: new Map(),
    reviewerBootstrapPendingThreadIds: new Set(),
    pendingReviewDispatchByReviewerThreadId: new Map(),
    reviewAwaitingVerdictByReviewerThreadId: new Map(),
    sessionStore: {
      setWaitingExternalReviewForThread: (bindingKey, mainThreadId, review) => {
        persistedWaitingExternal.push({ bindingKey, mainThreadId, review });
      },
    },
    reviewChainByMainThreadId: new Map([
      ["main-1", {
        id: "chain-1",
        bindingKey: "binding-1",
        workspaceRoot: "/repo",
        mainThreadId: "main-1",
        reviewerThreadId: "reviewer-1",
        chatId: "chat-1",
        replyToMessageId: "message-1",
        userText: "finish all required sections",
        continueCount: 0,
        bypassAfterLimit: false,
        latestMainTurnId: "turn-1",
        lastReviewRequestedTurnId: "",
        status: "waiting_external",
        createdAt: "2026-03-24T00:00:00.000Z",
        updatedAt: "2026-03-24T00:00:00.000Z",
      }],
    ]),
  };

  await assert.rejects(
    handleMainTurnCompleted(runtime, {
      threadId: "main-1",
      turnId: "turn-2",
    }),
    /Codex RPC client transport closed/
  );

  assert.equal(runtime.reviewChainByMainThreadId.get("main-1").status, "waiting_external");
  assert.equal(runtime.reviewChainByMainThreadId.get("main-1").latestMainTurnId, "turn-2");
  assert.equal(runtime.reviewChainByMainThreadId.get("main-1").lastReviewRequestedTurnId, "");
  assert.equal(runtime.pendingReviewDispatchByReviewerThreadId.size, 0);
  assert.equal(runtime.reviewAwaitingVerdictByReviewerThreadId.size, 0);
  assert.deepEqual(resumeCalls, ["main-1"]);
  assert.equal(sendCalls.length, 0);
  assert.equal(persistedWaitingExternal.length, 1);
  assert.equal(persistedWaitingExternal[0].review.latestMainTurnId, "turn-2");
});

test("handleMainTurnCompleted retries the same completed turn after a transient reviewer dispatch failure", async () => {
  const calls = [];
  let shouldFailReviewerResume = true;
  const runtime = {
    codex: {
      resumeThread: async ({ threadId }) => {
        calls.push(`resume-main:${threadId}`);
        return {
          result: {
            thread: {
              turns: [
                {
                  items: [
                    { type: "userMessage", content: "finish all required sections" },
                    { type: "agentMessage", text: "I stopped after the benchmark." },
                  ],
                },
              ],
            },
          },
        };
      },
      sendUserMessage: async (payload) => {
        calls.push(`send-review:${payload.threadId}`);
      },
    },
    config: {
      defaultCodexAccessMode: "default",
    },
    getCodexParamsForWorkspace() {
      return { model: "", effort: "" };
    },
    ensureThreadResumed: async (threadId) => {
      calls.push(`resume-reviewer:${threadId}`);
      if (shouldFailReviewerResume) {
        shouldFailReviewerResume = false;
        throw new Error("Codex RPC client transport closed");
      }
    },
    setThreadBindingKey() {},
    setThreadWorkspaceRoot() {},
    threadSessionPathByThreadId: new Map(),
    activeTurnIdByThreadId: new Map(),
    reviewerBootstrapPendingThreadIds: new Set(),
    pendingReviewDispatchByReviewerThreadId: new Map(),
    reviewAwaitingVerdictByReviewerThreadId: new Map(),
    sessionStore: {
      setWaitingExternalReviewForThread() {},
      clearWaitingExternalReviewForThread() {},
    },
    reviewChainByMainThreadId: new Map([
      ["main-1", {
        id: "chain-1",
        bindingKey: "binding-1",
        workspaceRoot: "/repo",
        mainThreadId: "main-1",
        reviewerThreadId: "reviewer-1",
        chatId: "chat-1",
        replyToMessageId: "message-1",
        userText: "finish all required sections",
        continueCount: 0,
        bypassAfterLimit: false,
        latestMainTurnId: "turn-1",
        lastReviewRequestedTurnId: "",
        status: "waiting_external",
        createdAt: "2026-03-24T00:00:00.000Z",
        updatedAt: "2026-03-24T00:00:00.000Z",
      }],
    ]),
  };

  await assert.rejects(
    handleMainTurnCompleted(runtime, {
      threadId: "main-1",
      turnId: "turn-2",
    }),
    /Codex RPC client transport closed/
  );

  await handleMainTurnCompleted(runtime, {
    threadId: "main-1",
    turnId: "turn-2",
  });

  assert.deepEqual(calls, [
    "resume-main:main-1",
    "resume-reviewer:reviewer-1",
    "resume-main:main-1",
    "resume-reviewer:reviewer-1",
    "send-review:reviewer-1",
  ]);
  assert.equal(runtime.reviewChainByMainThreadId.get("main-1").lastReviewRequestedTurnId, "turn-2");
});

test("handleSuppressedCodexMessage seals the main reply card on wait_external", async () => {
  const verdictCards = [];
  const replyCardCalls = [];
  const runtime = {
    codex: {
      resumeThread: async ({ threadId }) => {
        assert.equal(threadId, "reviewer-1");
        return {
          result: {
            thread: {
              turns: [
                {
                  items: [
                    { type: "agentMessage", text: "wait_external: slurm wakeup already queued" },
                  ],
                },
              ],
            },
          },
        };
      },
    },
    reviewAwaitingVerdictByReviewerThreadId: new Map([
      ["reviewer-1", {
        chainId: "chain-1",
        mainThreadId: "main-1",
        turnId: "review-turn-1",
      }],
    ]),
    reviewerBootstrapPendingThreadIds: new Set(),
    pendingReviewDispatchByReviewerThreadId: new Map(),
    reviewerMainThreadIdByReviewerThreadId: new Map([
      ["reviewer-1", "main-1"],
    ]),
    reviewChainByMainThreadId: new Map([
      ["main-1", {
        id: "chain-1",
        bindingKey: "binding-1",
        workspaceRoot: "/repo",
        mainThreadId: "main-1",
        reviewerThreadId: "reviewer-1",
        chatId: "chat-1",
        replyToMessageId: "msg-1",
        userText: "finish the benchmark, then sleep until wakeup",
        continueCount: 0,
        bypassAfterLimit: false,
        latestMainTurnId: "main-turn-1",
        lastReviewRequestedTurnId: "main-turn-1",
        status: "awaiting_reviewer",
        createdAt: "2026-03-24T00:00:00.000Z",
        updatedAt: "2026-03-24T00:00:00.000Z",
      }],
    ]),
    upsertAssistantReplyCard: async (payload) => {
      replyCardCalls.push(payload);
    },
    sendInteractiveCard: async (payload) => {
      verdictCards.push(payload);
      return {};
    },
    buildReviewVerdictCard(payload) {
      return payload;
    },
  };

  await handleSuppressedCodexMessage(runtime, {
    method: "turn/completed",
    params: {
      threadId: "reviewer-1",
      turnId: "review-turn-1",
      turn: {
        id: "review-turn-1",
      },
    },
  });

  assert.deepEqual(replyCardCalls, [{
    threadId: "main-1",
    turnId: "main-turn-1",
    chatId: "chat-1",
    state: "completed",
  }]);
  assert.equal(runtime.reviewChainByMainThreadId.get("main-1").status, "waiting_external");
  assert.equal(verdictCards.length, 1);
});

test("handleSuppressedCodexMessage fails fast when the reviewer thread disappears", async () => {
  const runtime = {
    codex: {
      resumeThread: async ({ threadId }) => {
        assert.equal(threadId, "reviewer-1");
        throw new Error("thread not found: reviewer-1");
      },
    },
    reviewAwaitingVerdictByReviewerThreadId: new Map([
      ["reviewer-1", {
        chainId: "chain-1",
        mainThreadId: "main-1",
        turnId: "review-turn-1",
      }],
    ]),
    reviewerBootstrapPendingThreadIds: new Set(),
    pendingReviewDispatchByReviewerThreadId: new Map(),
    reviewerMainThreadIdByReviewerThreadId: new Map([
      ["reviewer-1", "main-1"],
    ]),
    reviewChainByMainThreadId: new Map([
      ["main-1", {
        id: "chain-1",
        bindingKey: "binding-1",
        workspaceRoot: "/repo",
        mainThreadId: "main-1",
        reviewerThreadId: "reviewer-1",
        chatId: "chat-1",
        replyToMessageId: "msg-1",
        userText: "finish the benchmark, then sleep until wakeup",
        continueCount: 0,
        bypassAfterLimit: false,
        latestMainTurnId: "main-turn-1",
        lastReviewRequestedTurnId: "main-turn-1",
        status: "awaiting_reviewer",
        createdAt: "2026-03-24T00:00:00.000Z",
        updatedAt: "2026-03-24T00:00:00.000Z",
      }],
    ]),
  };

  await assert.rejects(
    handleSuppressedCodexMessage(runtime, {
      method: "turn/completed",
      params: {
        threadId: "reviewer-1",
        turnId: "review-turn-1",
        turn: {
          id: "review-turn-1",
        },
      },
    }),
    /thread not found: reviewer-1/
  );

  assert.equal(runtime.reviewChainByMainThreadId.get("main-1").reviewerThreadId, "reviewer-1");
  assert.equal(runtime.reviewAwaitingVerdictByReviewerThreadId.size, 0);
});

test("handleMainTurnCompleted skips duplicate reviewer dispatch for the same completed turn", async () => {
  let resumeCalls = 0;
  const runtime = {
    codex: {
      resumeThread: async () => {
        resumeCalls += 1;
        return { result: { thread: { turns: [] } } };
      },
      sendUserMessage: async () => {
        throw new Error("should not send duplicate reviewer request");
      },
    },
    config: {
      defaultCodexAccessMode: "default",
    },
    getCodexParamsForWorkspace() {
      return { model: "", effort: "" };
    },
    reviewChainByMainThreadId: new Map([
      ["main-1", {
        id: "chain-1",
        bindingKey: "binding-1",
        workspaceRoot: "/repo",
        mainThreadId: "main-1",
        reviewerThreadId: "reviewer-1",
        chatId: "chat-1",
        replyToMessageId: "message-1",
        userText: "finish all required sections",
        continueCount: 0,
        bypassAfterLimit: false,
        latestMainTurnId: "turn-2",
        lastReviewRequestedTurnId: "turn-2",
        status: "awaiting_reviewer",
        createdAt: "2026-03-24T00:00:00.000Z",
        updatedAt: "2026-03-24T00:00:00.000Z",
      }],
    ]),
    reviewerBootstrapPendingThreadIds: new Set(),
    pendingReviewDispatchByReviewerThreadId: new Map(),
    reviewAwaitingVerdictByReviewerThreadId: new Map(),
  };

  await handleMainTurnCompleted(runtime, {
    threadId: "main-1",
    turnId: "turn-2",
  });

  assert.equal(resumeCalls, 0);
  assert.equal(runtime.reviewChainByMainThreadId.get("main-1").status, "awaiting_reviewer");
});
