const { spawn } = require("child_process");
const os = require("os");
const WebSocket = require("ws");

class CodexRpcClient {
  constructor({ endpoint = "", env = process.env, codexCommand = "" }) {
    this.endpoint = endpoint;
    this.env = env;
    this.codexCommand = codexCommand || resolveDefaultCodexCommand(env);
    this.mode = endpoint ? "websocket" : "spawn";
    this.socket = null;
    this.child = null;
    this.stdoutBuffer = "";
    this.pending = new Map();
    this.isReady = false;
    this.messageListeners = new Set();
  }

  async connect() {
    if (this.mode === "websocket") {
      await this.connectWebSocket();
      return;
    }

    await this.connectSpawn();
  }

  async connectSpawn() {
    const commandCandidates = buildCodexCommandCandidates(this.codexCommand);
    let child = null;
    let lastError = null;
    let selectedCommand = "";

    for (const command of commandCandidates) {
      try {
        const spawnSpec = buildSpawnSpec(command);
        child = spawn(spawnSpec.command, spawnSpec.args, {
          env: { ...this.env },
          stdio: ["pipe", "pipe", "pipe"],
          shell: false,
        });
        selectedCommand = command;
        child.once("spawn", () => {
          console.log(`[codex-im] spawned Codex app-server via ${spawnSpec.command} ${spawnSpec.args.join(" ")}`);
        });
        break;
      } catch (error) {
        lastError = error;
        if (error?.code !== "ENOENT" && error?.code !== "EINVAL") {
          throw error;
        }
      }
    }

    if (!child) {
      const attempted = commandCandidates.join(", ");
      const detail = lastError?.message ? `: ${lastError.message}` : "";
      throw new Error(`Unable to spawn Codex app-server. Tried ${attempted}${detail}. You can override with CODEX_IM_CODEX_COMMAND.`);
    }

    this.child = child;

    child.on("error", (error) => {
      this.isReady = false;
      console.error(`[codex-im] failed to spawn Codex app-server via ${selectedCommand || this.codexCommand}: ${error.message}`);
    });

    child.stdout.on("data", (chunk) => {
      this.stdoutBuffer += chunk.toString("utf8");
      const lines = this.stdoutBuffer.split("\n");
      this.stdoutBuffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        this.handleIncoming(trimmed);
      }
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8").trim();
      if (text) {
        console.error(`[codex-im] codex stderr: ${text}`);
      }
    });

    child.on("close", (code) => {
      this.isReady = false;
      console.error(`[codex-im] codex app-server exited with code ${code}`);
    });
  }

  async connectWebSocket() {
    await new Promise((resolve, reject) => {
      const socket = new WebSocket(this.endpoint);
      this.socket = socket;

      socket.on("open", () => resolve());
      socket.on("error", (error) => reject(error));
      socket.on("message", (chunk) => {
        const message = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        if (message.trim()) {
          this.handleIncoming(message);
        }
      });
      socket.on("close", () => {
        this.isReady = false;
      });
    });
  }

  onMessage(listener) {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  async initialize() {
    if (this.isReady) {
      return;
    }

    await this.sendRequest("initialize", {
      clientInfo: {
        name: "codex_im_mac_agent",
        title: "Codex IM Mac Agent",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    await this.sendNotification("initialized", null);
    this.isReady = true;
  }

  async sendUserMessage({ threadId, text }) {
    const input = buildTurnInputPayload(text);

    if (!threadId) {
      return this.sendRequest("thread/start", {
        input,
      });
    }

    return this.sendRequest("turn/start", {
      threadId,
      input,
    });
  }

  async startThread({ cwd }) {
    const params = {};
    if (typeof cwd === "string" && cwd.trim()) {
      params.cwd = cwd.trim();
    }
    return this.sendRequest("thread/start", params);
  }

  async resumeThread({ threadId }) {
    const normalizedThreadId = typeof threadId === "string" ? threadId.trim() : "";
    if (!normalizedThreadId) {
      throw new Error("thread/resume requires a non-empty threadId");
    }
    return this.sendRequest("thread/resume", {
      threadId: normalizedThreadId,
    });
  }

  async listThreads({ cursor = null, limit = 100, sortKey = "updated_at", sourceKinds = null } = {}) {
    const params = {
      limit,
      sortKey,
    };

    if (typeof cursor === "string" && cursor.trim()) {
      params.cursor = cursor.trim();
    } else if (cursor != null) {
      params.cursor = cursor;
    }

    if (Array.isArray(sourceKinds) && sourceKinds.length > 0) {
      params.sourceKinds = sourceKinds;
    }

    return this.sendRequest("thread/list", params);
  }

  async sendRequest(method, params) {
    const id = createRequestId();
    const payload = JSON.stringify({ id, method, params });

    const responsePromise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });

    this.sendRaw(payload);
    return responsePromise;
  }

  async sendNotification(method, params) {
    this.sendRaw(JSON.stringify({ method, params }));
  }

  async sendResponse(id, result) {
    this.sendRaw(JSON.stringify({ id, result }));
  }

  sendRaw(payload) {
    if (this.mode === "websocket") {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
        throw new Error("Codex websocket is not connected");
      }
      this.socket.send(payload);
      return;
    }

    if (!this.child || !this.child.stdin.writable) {
      throw new Error("Codex process stdin is not writable");
    }
    this.child.stdin.write(`${payload}\n`);
  }

  handleIncoming(rawMessage) {
    const parsed = tryParseJson(rawMessage);
    if (!parsed) {
      return;
    }

    if (parsed && parsed.id != null && this.pending.has(String(parsed.id))) {
      const { resolve, reject } = this.pending.get(String(parsed.id));
      this.pending.delete(String(parsed.id));
      if (parsed.error) {
        reject(new Error(parsed.error.message || "Codex RPC request failed"));
        return;
      }
      resolve(parsed);
      return;
    }

    for (const listener of this.messageListeners) {
      listener(parsed);
    }
  }
}

function createRequestId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function tryParseJson(rawMessage) {
  try {
    return JSON.parse(rawMessage);
  } catch {
    return null;
  }
}

function resolveDefaultCodexCommand(env = process.env) {
  const explicit = String(env.CODEX_IM_CODEX_COMMAND || "").trim();
  if (explicit) {
    return explicit;
  }
  return "codex";
}

function buildCodexCommandCandidates(configuredCommand) {
  const explicit = String(configuredCommand || "").trim();
  if (explicit) {
    if (os.platform() !== "win32") {
      return [explicit];
    }

    const candidates = [explicit];
    if (!/\.(cmd|exe|bat)$/i.test(explicit)) {
      candidates.push(`${explicit}.cmd`, `${explicit}.exe`, `${explicit}.bat`);
    }
    return [...new Set(candidates)];
  }

  if (os.platform() === "win32") {
    return ["codex", "codex.cmd", "codex.exe", "codex.bat"];
  }

  return ["codex"];
}

function buildSpawnSpec(command) {
  if (os.platform() === "win32") {
    return {
      command: "cmd.exe",
      args: ["/c", command, "app-server"],
    };
  }

  return {
    command,
    args: ["app-server"],
  };
}

function buildTurnInputPayload(text) {
  const normalizedText = typeof text === "string" ? text.trim() : "";
  const items = [];

  if (normalizedText) {
    items.push({
      type: "text",
      text: normalizedText,
    });
  }

  return items;
}

module.exports = { CodexRpcClient };
