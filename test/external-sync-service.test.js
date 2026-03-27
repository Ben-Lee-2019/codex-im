const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { upsertAssistantReplyCard } = require("../src/presentation/card/card-service");

const {
  classifyExternalInputText,
  finalizeIncompleteAssistantState,
  hasDeliveredAssistantTurn,
  maybeHandleExternalTurnCompletedReview,
  parseMainThreadSessionChunk,
  parseMainThreadSessionChunkState,
  shouldSkipLiveSessionSync,
  shouldSkipTrackedBindingRead,
  syncExternalSessions,
} = require("../src/app/external-sync-service");

function createSyncRuntime({
  thread,
  deliveryContext = {
    chatId: "chat-1",
    lastSourceMessageId: "msg-source",
    updatedAt: "2026-03-24T16:40:00.000Z",
  },
  sessionSyncState = null,
} = {}) {
  const bindingKey = "binding-1";
  const workspaceRoot = "/repo";
  const trackedBinding = {
    bindingKey,
    workspaceRoot,
    threadId: thread.id,
    deliveryContext,
  };
  const sessionSyncStateByWorkspace = new Map([
    [workspaceRoot, sessionSyncState ? { ...sessionSyncState } : null],
  ]);
  const replyDetailByMessageId = new Map();
  const assistantCardCalls = [];
  let sentMessageCounter = 0;

  const runtime = {
    codex: {
      listThreads: async () => ({
        result: {
          data: [{
            id: thread.id,
            cwd: workspaceRoot,
            updatedAt: thread.updatedAt,
            path: thread.path,
            status: {
              type: thread.statusType || "completed",
            },
          }],
          nextCursor: "",
        },
      }),
    },
    sessionStore: {
      listTrackedWorkspaceThreads: () => [{
        ...trackedBinding,
        sessionSyncState: sessionSyncStateByWorkspace.get(workspaceRoot),
      }],
      getDeliveryContextForWorkspace: () => deliveryContext,
      setSessionSyncStateForWorkspace: (_bindingKey, _workspaceRoot, nextState = {}) => {
        const previous = sessionSyncStateByWorkspace.get(workspaceRoot) || {};
        sessionSyncStateByWorkspace.set(workspaceRoot, {
          ...previous,
          ...nextState,
          threadId: nextState.threadId ?? previous.threadId ?? "",
        sessionPath: nextState.sessionPath ?? previous.sessionPath ?? "",
        readOffset: nextState.readOffset ?? previous.readOffset ?? 0,
        lastRecordKey: nextState.lastRecordKey ?? previous.lastRecordKey ?? "",
        lastTurnId: nextState.lastTurnId ?? previous.lastTurnId ?? "",
        lastSeenThreadUpdatedAt:
          nextState.lastSeenThreadUpdatedAt ?? previous.lastSeenThreadUpdatedAt ?? 0,
      });
      },
      clearSessionSyncStateForWorkspace: () => {
        sessionSyncStateByWorkspace.delete(workspaceRoot);
      },
    },
    turnDeliveryModeByThreadId: new Map(),
    activeTurnIdByThreadId: new Map(),
    threadSessionPathByThreadId: new Map(),
    recentFeishuPromptFingerprintsByThreadId: new Map(),
    recentLiveDeliveredTurnAtByRunKey: new Map(),
    externalSyncPartialChunkByThreadId: new Map(),
    replyDetailByMessageId,
    externalSummaryLabelByThreadId: new Map(),
    reviewChainByMainThreadId: new Map(),
    markThreadHasExternalUpdates: () => {},
    buildExternalInputCard: (payload) => payload,
    sendInteractiveCard: async () => ({
      data: {
        message_id: `msg-${++sentMessageCounter}`,
      },
    }),
    patchInteractiveCard: async () => {},
    linkReplyDetailAlias: () => {},
    upsertAssistantReplyCard: async (payload) => {
      assistantCardCalls.push(payload);
      if (payload.turnId && payload.text) {
        replyDetailByMessageId.set(`detail-${assistantCardCalls.length}`, {
          threadId: payload.threadId,
          turnId: payload.turnId,
        });
      }
    },
    handleMainTurnCompleted: async () => {},
  };

  return {
    runtime,
    assistantCardCalls,
    getSessionSyncState: () => sessionSyncStateByWorkspace.get(workspaceRoot),
  };
}

function createIntegratedReplyCardRuntime({
  thread,
  deliveryContext = {
    chatId: "chat-1",
    lastSourceMessageId: "msg-source",
    updatedAt: "2026-03-24T16:40:00.000Z",
  },
  sessionSyncState = null,
} = {}) {
  const { runtime, getSessionSyncState } = createSyncRuntime({
    thread,
    deliveryContext,
    sessionSyncState,
  });
  const assistantSentCards = [];
  const assistantPatchedCards = [];

  runtime.currentRunKeyByThreadId = new Map();
  runtime.pendingChatContextByThreadId = new Map();
  runtime.pendingReactionByThreadId = new Map();
  runtime.replyCardByRunKey = new Map();
  runtime.replyFlushTimersByRunKey = new Map();
  runtime.setReplyCardEntry = function setReplyCardEntry(runKey, entry) {
    this.replyCardByRunKey.set(runKey, entry);
  };
  runtime.setCurrentRunKeyForThread = function setCurrentRunKeyForThread(threadId, runKey) {
    this.currentRunKeyByThreadId.set(threadId, runKey);
  };
  runtime.disposeReplyRunState = function disposeReplyRunState(runKey, threadId) {
    this.replyCardByRunKey.delete(runKey);
    if (this.currentRunKeyByThreadId.get(threadId) === runKey) {
      this.currentRunKeyByThreadId.delete(threadId);
    }
  };
  runtime.clearPendingReactionForThread = async () => {};
  runtime.requireFeishuAdapter = () => ({
    sendInteractiveCard: async (payload) => {
      assistantSentCards.push(payload);
      return {
        data: {
          message_id: `assistant-msg-${assistantSentCards.length}`,
        },
      };
    },
    patchInteractiveCard: async (payload) => {
      assistantPatchedCards.push(payload);
      return {};
    },
  });
  runtime.upsertAssistantReplyCard = async (payload) => upsertAssistantReplyCard(runtime, payload);

  return {
    runtime,
    assistantSentCards,
    assistantPatchedCards,
    getSessionSyncState,
  };
}

test("classifyExternalInputText recognizes synthetic continue and slurm wakeup prompts", () => {
  assert.deepEqual(
    classifyExternalInputText("[internal reviewer continue] finish the remaining work."),
    {
      kind: "synthetic_continue",
      title: "🧠 Long · 自动继续",
    }
  );

  assert.deepEqual(
    classifyExternalInputText("SLURM job 123 is now RUNNING on node gh103.\n\nContinue the existing work."),
    {
      kind: "slurm_wakeup",
      title: "⚙️ 系统 · 外部唤醒",
    }
  );

  assert.deepEqual(
    classifyExternalInputText("我现在在电脑上和你说话"),
    {
      kind: "external_user",
      title: "👤 用户 · 外部输入",
    }
  );
});

test("parseMainThreadSessionChunk extracts user, assistant, and terminal turn records", () => {
  const chunk = [
    JSON.stringify({
      timestamp: "2026-03-23T07:59:59.900Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "# AGENTS.md instructions for /repo",
          },
        ],
      },
    }),
    JSON.stringify({
      timestamp: "2026-03-23T08:00:00.000Z",
      type: "event_msg",
      payload: {
        type: "task_started",
        turn_id: "turn-1",
      },
    }),
    JSON.stringify({
      timestamp: "2026-03-23T08:00:00.100Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "[internal reviewer continue] finish the remaining work.",
          },
        ],
      },
    }),
    JSON.stringify({
      timestamp: "2026-03-23T08:00:00.101Z",
      type: "event_msg",
      payload: {
        type: "user_message",
        message: "[internal reviewer continue] finish the remaining work.",
      },
    }),
    JSON.stringify({
      timestamp: "2026-03-23T08:00:01.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "Working on the remaining steps now.",
          },
        ],
      },
    }),
    JSON.stringify({
      timestamp: "2026-03-23T08:00:02.000Z",
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: "turn-1",
      },
    }),
    "",
  ].join("\n");

  const entries = parseMainThreadSessionChunk(chunk, {
    threadId: "thread-1",
  });

  assert.deepEqual(
    entries.map((entry) => ({
      kind: entry.kind,
      threadId: entry.threadId,
      turnId: entry.turnId,
      text: entry.text || "",
      state: entry.state || "",
    })),
    [
      {
        kind: "user",
        threadId: "thread-1",
        turnId: "turn-1",
        text: "[internal reviewer continue] finish the remaining work.",
        state: "",
      },
      {
        kind: "assistant",
        threadId: "thread-1",
        turnId: "turn-1",
        text: "Working on the remaining steps now.",
        state: "",
      },
      {
        kind: "turn_state",
        threadId: "thread-1",
        turnId: "turn-1",
        text: "",
        state: "completed",
      },
    ]
  );
  assert.ok(entries.every((entry) => entry.recordKey));
});

test("parseMainThreadSessionChunk preserves the full synced user message", () => {
  const chunk = [
    JSON.stringify({
      timestamp: "2026-03-24T15:00:00.000Z",
      type: "event_msg",
      payload: {
        type: "task_started",
        turn_id: "turn-3",
      },
    }),
    JSON.stringify({
      timestamp: "2026-03-24T15:00:00.100Z",
      type: "event_msg",
      payload: {
        type: "user_message",
        message: [
          "[internal reviewer continue] finish the remaining work.",
          "",
          "extra context line 1",
          "extra context line 2",
        ].join("\n"),
      },
    }),
    "",
  ].join("\n");

  const entries = parseMainThreadSessionChunk(chunk, {
    threadId: "thread-main",
  });

  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, "user");
  assert.equal(
    entries[0].text,
    [
      "[internal reviewer continue] finish the remaining work.",
      "",
      "extra context line 1",
      "extra context line 2",
    ].join("\n")
  );
});

test("parseMainThreadSessionChunkState keeps turn id continuity across chunk boundaries", () => {
  const chunk = [
    JSON.stringify({
      timestamp: "2026-03-24T16:42:05.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "continued answer",
          },
        ],
      },
    }),
    JSON.stringify({
      timestamp: "2026-03-24T16:42:06.000Z",
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: "turn-2",
      },
    }),
    "",
  ].join("\n");

  const result = parseMainThreadSessionChunkState(chunk, {
    threadId: "thread-1",
    initialTurnId: "turn-2",
  });

  assert.equal(result.lastTurnId, "turn-2");
  assert.deepEqual(
    result.entries.map((entry) => ({ kind: entry.kind, turnId: entry.turnId, text: entry.text || "", state: entry.state || "" })),
    [
      { kind: "assistant", turnId: "turn-2", text: "continued answer", state: "" },
      { kind: "turn_state", turnId: "turn-2", text: "", state: "completed" },
    ]
  );
});

test("parseMainThreadSessionChunk preserves multiple assistant messages in the same turn", () => {
  const chunk = [
    JSON.stringify({
      timestamp: "2026-03-24T15:10:00.000Z",
      type: "event_msg",
      payload: {
        type: "task_started",
        turn_id: "turn-4",
      },
    }),
    JSON.stringify({
      timestamp: "2026-03-24T15:10:00.100Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "A",
          },
        ],
      },
    }),
    JSON.stringify({
      timestamp: "2026-03-24T15:10:01.100Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "B",
          },
        ],
      },
    }),
    "",
  ].join("\n");

  const entries = parseMainThreadSessionChunk(chunk, {
    threadId: "thread-4",
  });

  assert.deepEqual(
    entries.map((entry) => ({ kind: entry.kind, text: entry.text, turnId: entry.turnId })),
    [
      { kind: "assistant", text: "A", turnId: "turn-4" },
      { kind: "assistant", text: "B", turnId: "turn-4" },
    ]
  );
  assert.notEqual(entries[0].recordKey, entries[1].recordKey);
});

test("parseMainThreadSessionChunk skips the previously synced record key", () => {
  const firstRecord = JSON.stringify({
    timestamp: "2026-03-23T08:10:00.000Z",
    type: "event_msg",
    payload: {
      type: "task_started",
      turn_id: "turn-2",
    },
  });
  const secondRecord = JSON.stringify({
    timestamp: "2026-03-23T08:10:00.100Z",
    type: "event_msg",
    payload: {
      type: "user_message",
      message: "我现在在电脑上和你说话",
    },
  });

  const baseline = parseMainThreadSessionChunk([firstRecord, secondRecord, ""].join("\n"), {
    threadId: "thread-2",
  });
  const entries = parseMainThreadSessionChunk([firstRecord, secondRecord, ""].join("\n"), {
    threadId: "thread-2",
    lastRecordKey: baseline[baseline.length - 1].recordKey,
  });

  assert.deepEqual(entries, []);
});

test("shouldSkipTrackedBindingRead does not skip same-second thread updates", () => {
  assert.equal(
    shouldSkipTrackedBindingRead({
      deliveryMode: "live",
      threadUpdatedAt: 42,
      lastSeenThreadUpdatedAt: 42,
    }),
    false
  );

  assert.equal(
    shouldSkipTrackedBindingRead({
      deliveryMode: "live",
      threadUpdatedAt: 41,
      lastSeenThreadUpdatedAt: 42,
      readOffset: 100,
      sessionFileSize: 100,
    }),
    true
  );
});

test("shouldSkipTrackedBindingRead does not skip when the session file has grown", () => {
  assert.equal(
    shouldSkipTrackedBindingRead({
      deliveryMode: "live",
      threadUpdatedAt: 41,
      lastSeenThreadUpdatedAt: 42,
      readOffset: 100,
      sessionFileSize: 140,
    }),
    false
  );
});

test("shouldSkipLiveSessionSync only skips while the live turn is still running", () => {
  assert.equal(
    shouldSkipLiveSessionSync({
      activeTurnIdByThreadId: new Map([["thread-1", "turn-1"]]),
    }, "thread-1", { statusType: "completed" }, "live"),
    true
  );

  assert.equal(
    shouldSkipLiveSessionSync({
      activeTurnIdByThreadId: new Map(),
    }, "thread-1", { statusType: "running" }, "live"),
    true
  );

  assert.equal(
    shouldSkipLiveSessionSync({
      activeTurnIdByThreadId: new Map(),
    }, "thread-1", { statusType: "completed" }, "live"),
    false
  );
});

test("hasDeliveredAssistantTurn detects already delivered reply cards for a turn", () => {
  const runtime = {
    replyDetailByMessageId: new Map([
      ["msg-1", {
        threadId: "thread-1",
        turnId: "turn-1",
      }],
    ]),
  };

  assert.equal(hasDeliveredAssistantTurn(runtime, "thread-1", "turn-1"), true);
  assert.equal(hasDeliveredAssistantTurn(runtime, "thread-1", "turn-2"), false);
  assert.equal(hasDeliveredAssistantTurn(runtime, "thread-2", "turn-1"), false);
});

test("maybeHandleExternalTurnCompletedReview re-dispatches long review after external completion", async () => {
  const calls = [];
  const runtime = {
    reviewChainByMainThreadId: new Map([
      ["thread-1", {
        latestMainTurnId: "turn-2",
        lastReviewRequestedTurnId: "",
      }],
    ]),
    handleMainTurnCompleted: async (payload) => {
      calls.push(payload);
    },
  };

  await maybeHandleExternalTurnCompletedReview(runtime, {
    threadId: "thread-1",
    turnId: "turn-2",
    state: "completed",
  });

  assert.deepEqual(calls, [{
    threadId: "thread-1",
    turnId: "turn-2",
  }]);
});

test("maybeHandleExternalTurnCompletedReview skips duplicate completed turns", async () => {
  const calls = [];
  const runtime = {
    reviewChainByMainThreadId: new Map([
      ["thread-1", {
        latestMainTurnId: "turn-2",
        lastReviewRequestedTurnId: "turn-2",
      }],
    ]),
    handleMainTurnCompleted: async (payload) => {
      calls.push(payload);
    },
  };

  await maybeHandleExternalTurnCompletedReview(runtime, {
    threadId: "thread-1",
    turnId: "turn-2",
    state: "completed",
  });

  assert.deepEqual(calls, []);
});

test("finalizeIncompleteAssistantState re-dispatches long review when external output stops without a terminal event", async () => {
  const reviewCalls = [];
  const assistantCardCalls = [];
  const runtime = {
    reviewChainByMainThreadId: new Map([
      ["thread-1", {
        latestMainTurnId: "turn-1",
      }],
    ]),
    replyDetailByMessageId: new Map(),
    externalSummaryLabelByThreadId: new Map(),
    upsertAssistantReplyCard: async (payload) => {
      assistantCardCalls.push(payload);
    },
    handleMainTurnCompleted: async (payload) => {
      reviewCalls.push(payload);
    },
  };

  await finalizeIncompleteAssistantState(runtime, {
    bindingKey: "binding-1",
    workspaceRoot: "/repo",
    threadId: "thread-1",
    deliveryContext: {
      chatId: "chat-1",
    },
  }, [
    {
      kind: "assistant",
      turnId: "turn-2",
      text: "I will stop here and sleep.",
    },
  ], {
    statusType: "completed",
  });

  assert.deepEqual(assistantCardCalls, [{
    threadId: "thread-1",
    turnId: "turn-2",
    chatId: "chat-1",
    state: "completed",
  }]);
  assert.deepEqual(reviewCalls, [{
    threadId: "thread-1",
    turnId: "turn-2",
  }]);
});

test("syncExternalSessions skips replaying assistant text for a recently live-delivered turn", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-im-external-sync-live-dedupe-"));
  try {
    const sessionPath = path.join(tempDir, "thread-1.jsonl");
    fs.writeFileSync(sessionPath, [
      JSON.stringify({
        timestamp: "2026-03-25T11:24:00.000Z",
        type: "event_msg",
        payload: {
          type: "task_started",
          turn_id: "turn-1",
        },
      }),
      JSON.stringify({
        timestamp: "2026-03-25T11:24:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: "已提交 A100 唤醒作业，job_id 是 4913971。",
            },
          ],
        },
      }),
      JSON.stringify({
        timestamp: "2026-03-25T11:24:02.000Z",
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "turn-1",
        },
      }),
      "",
    ].join("\n"));

    const { runtime, assistantCardCalls } = createSyncRuntime({
      thread: {
        id: "thread-1",
        updatedAt: 200,
        path: sessionPath,
        statusType: "completed",
      },
      sessionSyncState: {
        threadId: "thread-1",
        sessionPath,
        readOffset: 0,
        lastSeenThreadUpdatedAt: 0,
      },
    });

    runtime.replyDetailByMessageId.set("detail-live", {
      threadId: "thread-1",
      turnId: "turn-1",
    });
    runtime.recentLiveDeliveredTurnAtByRunKey.set("thread-1:turn-1", Date.now());

    await syncExternalSessions(runtime);

    assert.deepEqual(assistantCardCalls, [{
      threadId: "thread-1",
      turnId: "turn-1",
      chatId: "chat-1",
      state: "completed",
    }]);
    assert.equal(runtime.recentLiveDeliveredTurnAtByRunKey.has("thread-1:turn-1"), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("syncExternalSessions holds the cursor when a suspicious timeline chunk cannot be parsed yet", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-im-external-sync-suspicious-"));
  try {
    const sessionPath = path.join(tempDir, "thread-1.jsonl");
    fs.writeFileSync(sessionPath, [
      JSON.stringify({
        timestamp: "2026-03-25T11:24:00.000Z",
        type: "event_msg",
        payload: {
          type: "task_started",
          turn_id: "turn-1",
        },
      }),
      '{"timestamp":"2026-03-25T11:24:01.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"broken"',
      "",
    ].join("\n"));

    const { runtime, assistantCardCalls, getSessionSyncState } = createSyncRuntime({
      thread: {
        id: "thread-1",
        updatedAt: 200,
        path: sessionPath,
        statusType: "completed",
      },
      sessionSyncState: {
        threadId: "thread-1",
        sessionPath,
        readOffset: 0,
        lastSeenThreadUpdatedAt: 0,
      },
    });

    await syncExternalSessions(runtime);

    assert.deepEqual(assistantCardCalls, []);
    assert.equal(getSessionSyncState().readOffset, 0);

    fs.writeFileSync(sessionPath, [
      JSON.stringify({
        timestamp: "2026-03-25T11:24:00.000Z",
        type: "event_msg",
        payload: {
          type: "task_started",
          turn_id: "turn-1",
        },
      }),
      JSON.stringify({
        timestamp: "2026-03-25T11:24:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: "Recovered assistant output.",
            },
          ],
        },
      }),
      JSON.stringify({
        timestamp: "2026-03-25T11:24:02.000Z",
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "turn-1",
        },
      }),
      "",
    ].join("\n"));

    await syncExternalSessions(runtime);

    assert.deepEqual(assistantCardCalls, [
      {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "2026-03-25T11:24:01.000Z|response_item|message|assistant|turn-1|Recovered assistant output.",
        chatId: "chat-1",
        text: "Recovered assistant output.",
        textMode: "replace",
        state: "streaming",
        deferFlush: false,
      },
      {
        threadId: "thread-1",
        turnId: "turn-1",
        chatId: "chat-1",
        state: "completed",
      },
    ]);
    assert.equal(getSessionSyncState().readOffset > 0, true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("syncExternalSessions resets baseline when the workspace switches to a different thread session file", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-im-external-sync-"));
  try {
    const newSessionPath = path.join(tempDir, "rollout-2026-03-25T02-17-48-019d23a4-6292-7db1-8a89-f7fabf95ae03.jsonl");
    fs.writeFileSync(newSessionPath, [
      JSON.stringify({
        timestamp: "2026-03-24T16:41:00.000Z",
        type: "event_msg",
        payload: {
          type: "task_started",
          turn_id: "turn-1",
        },
      }),
      JSON.stringify({
        timestamp: "2026-03-24T16:41:02.000Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "SLURM job 4880938 is now RUNNING on node ga010.\n\nContinue the existing work.",
        },
      }),
      JSON.stringify({
        timestamp: "2026-03-24T16:41:05.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: "Recovered work from the resumed session.",
            },
          ],
        },
      }),
      JSON.stringify({
        timestamp: "2026-03-24T16:41:06.000Z",
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "turn-1",
        },
      }),
      "",
    ].join("\n"));

    const { runtime, assistantCardCalls, getSessionSyncState } = createSyncRuntime({
      thread: {
        id: "019d23a4-6292-7db1-8a89-f7fabf95ae03",
        path: newSessionPath,
        updatedAt: 100,
        statusType: "completed",
      },
      sessionSyncState: {
        threadId: "019d23a4-6292-7db1-8a89-f7fabf95ae03",
        sessionPath: path.join(tempDir, "rollout-2026-03-25T01-44-22-019d2385-c46b-77a2-9a2a-cfc954a3c133.jsonl"),
        readOffset: 999999,
        lastRecordKey: "old-record",
        lastSeenThreadUpdatedAt: 0,
      },
    });

    await syncExternalSessions(runtime);

    assert.deepEqual(assistantCardCalls, []);
    assert.equal(getSessionSyncState().sessionPath, newSessionPath);
    assert.equal(getSessionSyncState().readOffset, fs.statSync(newSessionPath).size);
    assert.equal(getSessionSyncState().lastRecordKey, "");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("parseMainThreadSessionChunk skips entries up to the last seen record key", () => {
  const rawChunk = [
    JSON.stringify({
      timestamp: "2026-03-24T16:41:00.000Z",
      type: "event_msg",
      payload: {
        type: "user_message",
        message: "old prompt",
      },
    }),
    JSON.stringify({
      timestamp: "2026-03-24T16:41:05.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "old answer",
          },
        ],
      },
    }),
    JSON.stringify({
      timestamp: "2026-03-24T16:41:06.000Z",
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: "turn-old",
      },
    }),
    JSON.stringify({
      timestamp: "2026-03-24T16:42:00.000Z",
      type: "event_msg",
      payload: {
        type: "user_message",
        message: "new prompt",
      },
    }),
    JSON.stringify({
      timestamp: "2026-03-24T16:42:05.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "new answer",
          },
        ],
      },
    }),
    JSON.stringify({
      timestamp: "2026-03-24T16:42:06.000Z",
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: "turn-new",
      },
    }),
  ].join("\n");

  const allEntries = parseMainThreadSessionChunk(rawChunk, {
    threadId: "thread-1",
  });
  const resumedEntries = parseMainThreadSessionChunk(rawChunk, {
    threadId: "thread-1",
    lastRecordKey: allEntries[2].recordKey,
  });

  assert.deepEqual(
    resumedEntries.map((entry) => ({ kind: entry.kind, text: entry.text || "", state: entry.state || "" })),
    [
      { kind: "user", text: "new prompt", state: "" },
      { kind: "assistant", text: "new answer", state: "" },
      { kind: "turn_state", text: "", state: "completed" },
    ]
  );
});

test("syncExternalSessions replays a same-thread resumed session file and re-dispatches review", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-im-external-sync-"));
  try {
    const previousSessionPath = path.join(tempDir, "rollout-2026-03-25T01-44-22-019d23a4-6292-7db1-8a89-f7fabf95ae03.jsonl");
    const nextSessionPath = path.join(tempDir, "rollout-2026-03-25T02-17-48-019d23a4-6292-7db1-8a89-f7fabf95ae03.jsonl");
    const previousChunk = [
      JSON.stringify({
        timestamp: "2026-03-24T16:41:00.000Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          turn_id: "turn-old",
          message: "queued wakeup",
        },
      }),
      JSON.stringify({
        timestamp: "2026-03-24T16:41:05.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: "waiting for wakeup",
            },
          ],
        },
      }),
      JSON.stringify({
        timestamp: "2026-03-24T16:41:06.000Z",
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "turn-old",
        },
      }),
      "",
    ].join("\n");
    fs.writeFileSync(previousSessionPath, previousChunk);

    const previousEntries = parseMainThreadSessionChunk(previousChunk, {
      threadId: "019d23a4-6292-7db1-8a89-f7fabf95ae03",
    });

    fs.writeFileSync(nextSessionPath, [
      previousChunk.trimEnd(),
      JSON.stringify({
        timestamp: "2026-03-24T16:42:00.000Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          turn_id: "turn-new",
          message: "SLURM job 4926451 is now RUNNING on node gh106.\n\nContinue the existing work.",
        },
      }),
      JSON.stringify({
        timestamp: "2026-03-24T16:42:05.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: "Recovered work from the resumed session.",
            },
          ],
        },
      }),
      JSON.stringify({
        timestamp: "2026-03-24T16:42:06.000Z",
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "turn-new",
        },
      }),
      "",
    ].join("\n"));

    const reviewCalls = [];
    const { runtime, assistantCardCalls, getSessionSyncState } = createSyncRuntime({
      thread: {
        id: "019d23a4-6292-7db1-8a89-f7fabf95ae03",
        path: nextSessionPath,
        updatedAt: 100,
        statusType: "completed",
      },
      sessionSyncState: {
        threadId: "019d23a4-6292-7db1-8a89-f7fabf95ae03",
        sessionPath: previousSessionPath,
        readOffset: fs.statSync(previousSessionPath).size,
        lastRecordKey: previousEntries[previousEntries.length - 1].recordKey,
        lastSeenThreadUpdatedAt: 0,
      },
    });
    runtime.reviewChainByMainThreadId.set("019d23a4-6292-7db1-8a89-f7fabf95ae03", {
      latestMainTurnId: "turn-old",
      lastReviewRequestedTurnId: "turn-old",
    });
    runtime.handleMainTurnCompleted = async (payload) => {
      reviewCalls.push(payload);
    };

    await syncExternalSessions(runtime);

    assert.deepEqual(assistantCardCalls, [
      {
        threadId: "019d23a4-6292-7db1-8a89-f7fabf95ae03",
        turnId: "turn-new",
        itemId: "2026-03-24T16:42:05.000Z|response_item|message|assistant|turn-new|Recovered work from the resumed session.",
        chatId: "chat-1",
        text: "Recovered work from the resumed session.",
        textMode: "replace",
        state: "streaming",
        deferFlush: false,
      },
      {
        threadId: "019d23a4-6292-7db1-8a89-f7fabf95ae03",
        turnId: "turn-new",
        chatId: "chat-1",
        state: "completed",
      },
    ]);
    assert.deepEqual(reviewCalls, [{
      threadId: "019d23a4-6292-7db1-8a89-f7fabf95ae03",
      turnId: "turn-new",
    }]);
    assert.equal(getSessionSyncState().sessionPath, nextSessionPath);
    assert.equal(getSessionSyncState().readOffset, fs.statSync(nextSessionPath).size);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("syncExternalSessions opens a fresh assistant card for the next external turn in the same thread", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-im-external-sync-next-turn-"));
  try {
    const sessionPath = path.join(tempDir, "thread-1.jsonl");
    fs.writeFileSync(sessionPath, [
      JSON.stringify({
        timestamp: "2026-03-24T16:48:00.000Z",
        type: "event_msg",
        payload: {
          type: "task_started",
          turn_id: "turn-1",
        },
      }),
      JSON.stringify({
        timestamp: "2026-03-24T16:48:00.100Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "first question",
        },
      }),
      JSON.stringify({
        timestamp: "2026-03-24T16:48:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: "first answer",
            },
          ],
        },
      }),
      JSON.stringify({
        timestamp: "2026-03-24T16:48:02.000Z",
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "turn-1",
        },
      }),
      JSON.stringify({
        timestamp: "2026-03-24T16:49:00.000Z",
        type: "event_msg",
        payload: {
          type: "task_started",
          turn_id: "turn-2",
        },
      }),
      JSON.stringify({
        timestamp: "2026-03-24T16:49:00.100Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "second question",
        },
      }),
      "",
    ].join("\n"));

    const {
      runtime,
      assistantSentCards,
      assistantPatchedCards,
      getSessionSyncState,
    } = createIntegratedReplyCardRuntime({
      thread: {
        id: "thread-1",
        updatedAt: 100,
        path: sessionPath,
        statusType: "completed",
      },
      sessionSyncState: {
        threadId: "thread-1",
        sessionPath,
        readOffset: 0,
        lastRecordKey: "",
        lastTurnId: "",
        lastSeenThreadUpdatedAt: 0,
      },
    });

    await syncExternalSessions(runtime);

    assert.equal(assistantSentCards.length, 1);
    assert.equal(assistantPatchedCards.length, 1);
    assert.equal(getSessionSyncState().lastTurnId, "turn-2");

    fs.appendFileSync(sessionPath, [
      JSON.stringify({
        timestamp: "2026-03-24T16:49:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: "second answer",
            },
          ],
        },
      }),
      JSON.stringify({
        timestamp: "2026-03-24T16:49:02.000Z",
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "turn-2",
        },
      }),
      "",
    ].join("\n"));

    await syncExternalSessions(runtime);

    assert.equal(assistantSentCards.length, 2);
    assert.equal(assistantPatchedCards.length, 2);
    assert.equal(assistantPatchedCards[1].messageId, "assistant-msg-2");
    assert.equal(runtime.replyDetailByMessageId.get("assistant-msg-2").turnId, "turn-2");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("syncExternalSessions keeps one assistant card for multiple assistant updates within the same turn", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-im-external-sync-same-turn-"));
  try {
    const sessionPath = path.join(tempDir, "thread-1.jsonl");
    fs.writeFileSync(sessionPath, [
      JSON.stringify({
        timestamp: "2026-03-24T16:58:00.000Z",
        type: "event_msg",
        payload: {
          type: "task_started",
          turn_id: "turn-1",
        },
      }),
      JSON.stringify({
        timestamp: "2026-03-24T16:58:00.100Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "same question",
        },
      }),
      JSON.stringify({
        timestamp: "2026-03-24T16:58:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: "first step",
            },
          ],
        },
      }),
      "",
    ].join("\n"));

    const {
      runtime,
      assistantSentCards,
      assistantPatchedCards,
    } = createIntegratedReplyCardRuntime({
      thread: {
        id: "thread-1",
        updatedAt: 100,
        path: sessionPath,
        statusType: "completed",
      },
      sessionSyncState: {
        threadId: "thread-1",
        sessionPath,
        readOffset: 0,
        lastRecordKey: "",
        lastTurnId: "",
        lastSeenThreadUpdatedAt: 0,
      },
    });

    await syncExternalSessions(runtime);

    assert.equal(assistantSentCards.length, 1);
    assert.equal(assistantPatchedCards.length, 0);

    fs.appendFileSync(sessionPath, [
      JSON.stringify({
        timestamp: "2026-03-24T16:58:05.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: "second step",
            },
          ],
        },
      }),
      JSON.stringify({
        timestamp: "2026-03-24T16:58:10.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: "final step",
            },
          ],
        },
      }),
      JSON.stringify({
        timestamp: "2026-03-24T16:58:11.000Z",
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "turn-1",
        },
      }),
      "",
    ].join("\n"));

    await syncExternalSessions(runtime);

    assert.equal(assistantSentCards.length, 1);
    assert.equal(assistantPatchedCards.length, 1);
    assert.ok(assistantPatchedCards.every((payload) => payload.messageId === "assistant-msg-1"));
    assert.equal(runtime.replyDetailByMessageId.get("assistant-msg-1").turnId, "turn-1");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("syncExternalSessions fails fast after the same unterminated JSONL tail repeats", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-im-external-sync-"));
  try {
    const sessionPath = path.join(tempDir, "partial-session.jsonl");
    fs.writeFileSync(sessionPath, JSON.stringify({
      timestamp: "2026-03-24T16:43:21.058Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "Final message is still being flushed",
          },
        ],
      },
    }));

    const { runtime, assistantCardCalls, getSessionSyncState } = createSyncRuntime({
      thread: {
        id: "thread-1",
        path: sessionPath,
        updatedAt: 100,
        statusType: "completed",
      },
      sessionSyncState: {
        threadId: "thread-1",
        sessionPath,
        readOffset: 0,
        lastRecordKey: "",
        lastSeenThreadUpdatedAt: 0,
      },
    });

    await syncExternalSessions(runtime);

    assert.deepEqual(assistantCardCalls, []);
    assert.equal(getSessionSyncState().readOffset, 0);
    assert.equal(getSessionSyncState().sessionPath, sessionPath);

    await assert.rejects(
      syncExternalSessions(runtime),
      (error) => {
        assert.equal(error.name, "ExternalSyncInvariantError");
        assert.match(error.message, /partial chunk/i);
        assert.equal(error.externalSyncContext.threadId, "thread-1");
        assert.equal(error.externalSyncContext.sessionPath, sessionPath);
        assert.match(error.externalSyncContext.preview, /Final message is still being flushed/);
        return true;
      }
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("syncExternalSessions does not fail fast on repeated NUL-only partial chunks", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-im-external-sync-"));
  try {
    const sessionPath = path.join(tempDir, "nul-corrupted-session.jsonl");
    fs.writeFileSync(sessionPath, Buffer.concat([
      Buffer.from('{"timestamp":"2026-03-24T16:43:21.058Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"preface"}]}}\n', "utf8"),
      Buffer.alloc(64, 0),
    ]));

    const { runtime, assistantCardCalls, getSessionSyncState } = createSyncRuntime({
      thread: {
        id: "thread-1",
        path: sessionPath,
        updatedAt: 100,
        statusType: "completed",
      },
      sessionSyncState: {
        threadId: "thread-1",
        sessionPath,
        readOffset: fs.readFileSync(sessionPath).indexOf(0x0a) + 1,
        lastRecordKey: "already-read",
        lastSeenThreadUpdatedAt: 0,
      },
    });

    await syncExternalSessions(runtime);
    await syncExternalSessions(runtime);

    assert.deepEqual(assistantCardCalls, []);
    assert.equal(fs.readFileSync(sessionPath).includes(0), true);
    assert.equal(getSessionSyncState().sessionPath, sessionPath);
    assert.equal(getSessionSyncState().readOffset > 0, true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
