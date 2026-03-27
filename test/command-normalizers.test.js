const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizeFeishuTextEvent } = require("../src/presentation/message/normalizers");
const { extractLongValue } = require("../src/shared/command-parsing");

function buildTextEvent(text, overrides = {}) {
  return {
    message: {
      message_type: "text",
      content: JSON.stringify({ text }),
      chat_id: "chat-1",
      chat_type: "p2p",
      root_id: "",
      message_id: "message-1",
      ...overrides.message,
    },
    sender: {
      sender_id: {
        open_id: "user-1",
      },
      ...overrides.sender,
    },
  };
}

test("normalizeFeishuTextEvent recognizes /codex long with prompt", () => {
  const normalized = normalizeFeishuTextEvent(buildTextEvent("/codex long run until the benchmark is green"), {
    defaultWorkspaceId: "default",
  });

  assert.equal(normalized.command, "long");
  assert.equal(extractLongValue(normalized.text), "run until the benchmark is green");
});

test("normalizeFeishuTextEvent recognizes /codex long off", () => {
  const normalized = normalizeFeishuTextEvent(buildTextEvent("/codex long off"), {
    defaultWorkspaceId: "default",
  });

  assert.equal(normalized.command, "long");
  assert.equal(extractLongValue(normalized.text), "off");
});

test("normalizeFeishuTextEvent no longer reserves removed slash commands", () => {
  const removedCommands = ["/pwd", "/mkdir demo", "/sq", "/gpu", "/ls", "/ls src"];

  for (const text of removedCommands) {
    const normalized = normalizeFeishuTextEvent(buildTextEvent(text), {
      defaultWorkspaceId: "default",
    });

    assert.equal(normalized.command, "message");
  }
});

test("normalizeFeishuTextEvent records p2p chat type for reply-thread fallback", () => {
  const normalized = normalizeFeishuTextEvent(buildTextEvent("你好", {
    message: {
      root_id: "root-1",
      message_id: "message-2",
    },
  }), {
    defaultWorkspaceId: "default",
  });

  assert.equal(normalized.chatType, "p2p");
  assert.equal(normalized.threadKey, "root-1");
});
