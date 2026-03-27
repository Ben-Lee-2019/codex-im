const test = require("node:test");
const assert = require("node:assert/strict");

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { buildSubagentTranscriptCard } = require("../src/presentation/card/builders");
const {
  handleSubagentCardAction,
  resolveParentSessionPath,
} = require("../src/domain/subagent/subagent-service");

test("handleSubagentCardAction loads full transcript for session-backed subagent details", async () => {
  let taskPromise = null;
  let transcriptCardPayload = null;
  const runtime = {
    subagentCardByThreadId: new Map([
      ["sub-1", {
        threadId: "sub-1",
        source: "session",
        state: "completed",
        nickname: "Halley",
        role: "default",
        path: "",
        lastSummary: "short summary",
        historyMessages: [
          { role: "user", text: "prompt" },
          { role: "assistant", text: "short summary" },
        ],
        transcriptMessages: [],
        detailMessageId: "",
      }],
    ]),
    subagentMetadataByThreadId: new Map(),
    subagentSessionMetaByPath: new Map(),
    codex: {
      resumeThread: async () => ({
        result: {
          thread: {
            agentNickname: "Halley",
            agentRole: "default",
            status: {
              type: "idle",
            },
            turns: [
              {
                status: "completed",
                items: [
                  {
                    type: "userMessage",
                    content: "prompt",
                  },
                  {
                    type: "agentMessage",
                    text: "full answer\n\n| a | b |\n|---|---|\n| 1 | 2 |",
                  },
                ],
              },
            ],
          },
        },
      }),
    },
    runCardActionTask(promise) {
      taskPromise = Promise.resolve(promise);
    },
    buildCardToast(text) {
      return { kind: "toast", text };
    },
    buildCardResponse(payload) {
      return payload;
    },
    buildSubagentTranscriptCard(payload) {
      transcriptCardPayload = payload;
      return payload;
    },
    sendInteractiveCard: async () => ({
      data: {
        message_id: "detail-msg-1",
      },
    }),
    patchInteractiveCard: async () => {},
  };

  handleSubagentCardAction(runtime, {
    action: "view_detail",
    threadId: "sub-1",
  }, {
    chatId: "chat-1",
    messageId: "msg-1",
  });

  await taskPromise;

  assert.ok(transcriptCardPayload);
  assert.deepEqual(
    transcriptCardPayload.messages,
    [
      { role: "user", text: "prompt" },
      { role: "assistant", text: "full answer\n\n| a | b |\n|---|---|\n| 1 | 2 |" },
    ]
  );
  assert.deepEqual(
    runtime.subagentCardByThreadId.get("sub-1").transcriptMessages,
    [
      { role: "user", text: "prompt" },
      { role: "assistant", text: "full answer\n\n| a | b |\n|---|---|\n| 1 | 2 |" },
    ]
  );
});

test("handleSubagentCardAction hides inherited fork_context transcript prefix and keeps explicit interaction history", async () => {
  let taskPromise = null;
  let transcriptCardPayload = null;
  const runtime = {
    subagentCardByThreadId: new Map([
      ["sub-2", {
        threadId: "sub-2",
        source: "session",
        state: "completed",
        nickname: "Anscombe",
        role: "default",
        forkContext: true,
        path: "",
        lastSummary: "OK",
        historyMessages: [
          { role: "user", text: "请只回复：OK" },
          { role: "assistant", text: "OK" },
        ],
        detailMessages: [
          { role: "user", text: "请只回复：OK" },
          { role: "assistant", text: "OK" },
        ],
        transcriptMessages: [],
        detailMessageId: "",
      }],
    ]),
    subagentMetadataByThreadId: new Map(),
    subagentSessionMetaByPath: new Map(),
    codex: {
      resumeThread: async () => ({
        result: {
          thread: {
            agentNickname: "Anscombe",
            agentRole: "default",
            status: {
              type: "idle",
            },
            turns: [
              {
                status: "completed",
                items: [
                  {
                    type: "userMessage",
                    content: "你召唤一个新的subagent，让它回复OK，你不要让这个subagent死亡，把它作为长线subagent",
                  },
                  {
                    type: "agentMessage",
                    text: "我来新建一个长期保留的子代理，让它先回复 OK，并且不把它关掉，后面我们可以继续直接复用它。",
                  },
                  {
                    type: "userMessage",
                    content: "请只回复：OK",
                  },
                  {
                    type: "agentMessage",
                    text: "OK",
                  },
                ],
              },
            ],
          },
        },
      }),
    },
    runCardActionTask(promise) {
      taskPromise = Promise.resolve(promise);
    },
    buildCardToast(text) {
      return { kind: "toast", text };
    },
    buildCardResponse(payload) {
      return payload;
    },
    buildSubagentTranscriptCard(payload) {
      transcriptCardPayload = payload;
      return payload;
    },
    sendInteractiveCard: async () => ({
      data: {
        message_id: "detail-msg-2",
      },
    }),
    patchInteractiveCard: async () => {},
  };

  handleSubagentCardAction(runtime, {
    action: "view_detail",
    threadId: "sub-2",
  }, {
    chatId: "chat-1",
    messageId: "msg-2",
  });

  await taskPromise;

  assert.ok(transcriptCardPayload);
  assert.equal(transcriptCardPayload.forkContext, true);
  assert.deepEqual(
    transcriptCardPayload.messages,
    [
      { role: "user", text: "请只回复：OK" },
      { role: "assistant", text: "OK" },
    ]
  );
});

test("handleSubagentCardAction falls back to explicit interaction history when fork_context anchor is missing", async () => {
  let taskPromise = null;
  let transcriptCardPayload = null;
  const runtime = {
    subagentCardByThreadId: new Map([
      ["sub-3", {
        threadId: "sub-3",
        source: "session",
        state: "completed",
        nickname: "Halley",
        role: "default",
        forkContext: true,
        path: "",
        lastSummary: "short summary",
        historyMessages: [
          { role: "user", text: "请只回复：OK" },
          { role: "assistant", text: "OK" },
        ],
        detailMessages: [
          { role: "user", text: "请只回复：OK" },
          { role: "assistant", text: "OK" },
        ],
        transcriptMessages: [],
        detailMessageId: "",
      }],
    ]),
    subagentMetadataByThreadId: new Map(),
    subagentSessionMetaByPath: new Map(),
    codex: {
      resumeThread: async () => ({
        result: {
          thread: {
            agentNickname: "Halley",
            agentRole: "default",
            status: {
              type: "idle",
            },
            turns: [
              {
                status: "completed",
                items: [
                  {
                    type: "userMessage",
                    content: "别的上下文",
                  },
                  {
                    type: "agentMessage",
                    text: "别的回复",
                  },
                ],
              },
            ],
          },
        },
      }),
    },
    runCardActionTask(promise) {
      taskPromise = Promise.resolve(promise);
    },
    buildCardToast(text) {
      return { kind: "toast", text };
    },
    buildCardResponse(payload) {
      return payload;
    },
    buildSubagentTranscriptCard(payload) {
      transcriptCardPayload = payload;
      return payload;
    },
    sendInteractiveCard: async () => ({
      data: {
        message_id: "detail-msg-3",
      },
    }),
    patchInteractiveCard: async () => {},
  };

  handleSubagentCardAction(runtime, {
    action: "view_detail",
    threadId: "sub-3",
  }, {
    chatId: "chat-1",
    messageId: "msg-3",
  });

  await taskPromise;

  assert.ok(transcriptCardPayload);
  assert.deepEqual(
    transcriptCardPayload.messages,
    [
      { role: "user", text: "请只回复：OK" },
      { role: "assistant", text: "OK" },
    ]
  );
});

test("buildSubagentTranscriptCard shows fork_context badge only in detail metadata", () => {
  const card = buildSubagentTranscriptCard({
    threadId: "sub-4",
    agentNickname: "Halley",
    agentRole: "default",
    state: "completed",
    forkContext: true,
    messages: [
      { role: "user", text: "请只回复：OK" },
      { role: "assistant", text: "OK" },
    ],
  });

  assert.match(card.body.elements[1].content, /fork_context=true/);
  assert.match(card.body.elements[1].content, /继承上下文已隐藏/);
});

test("resolveParentSessionPath discards stale cached paths that belong to another thread", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-im-subagent-parent-path-"));
  try {
    const stalePath = path.join(tempDir, "rollout-2026-03-27T00-19-19-parent-old.jsonl");
    const freshPath = path.join(tempDir, "rollout-2026-03-27T01-18-23-parent-new.jsonl");
    fs.writeFileSync(stalePath, `${JSON.stringify({
      type: "session_meta",
      payload: { id: "parent-old" },
    })}\n`);
    fs.writeFileSync(freshPath, `${JSON.stringify({
      type: "session_meta",
      payload: { id: "parent-new" },
    })}\n`);

    const runtime = {
      threadSessionPathByThreadId: new Map([["parent-new", stalePath]]),
      subagentTrackerByRunKey: new Map(),
      codex: {
        resumeThread: async () => ({
          result: {
            thread: {
              path: freshPath,
            },
          },
        }),
      },
    };
    const tracker = {
      runKey: "parent-new:turn-1",
      parentThreadId: "parent-new",
      parentSessionPath: stalePath,
    };
    runtime.subagentTrackerByRunKey.set(tracker.runKey, tracker);

    const resolved = await resolveParentSessionPath(runtime, tracker);

    assert.equal(resolved, freshPath);
    assert.equal(runtime.threadSessionPathByThreadId.get("parent-new"), freshPath);
    assert.equal(runtime.subagentTrackerByRunKey.get("parent-new:turn-1").parentSessionPath, freshPath);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
