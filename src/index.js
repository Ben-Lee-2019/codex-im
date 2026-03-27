const path = require("path");
const os = require("os");
const fs = require("fs");
const dotenv = require("dotenv");

const { readConfig } = require("./infra/config/config");
const { FeishuBotRuntime } = require("./app/feishu-bot-runtime");

const FATAL_LOG_PATH = process.env.CODEX_IM_FATAL_LOG
  || path.join(process.cwd(), "logs", "codex-im.fatal.log");

function loadEnv() {
  ensureDefaultConfigDirectory();

  const envCandidates = [
    path.join(process.cwd(), ".env"),
    path.join(os.homedir(), ".codex-im", ".env"),
  ];

  for (const envPath of envCandidates) {
    if (!fs.existsSync(envPath)) {
      continue;
    }
    dotenv.config({ path: envPath });
    return;
  }

  dotenv.config();
}

function ensureDefaultConfigDirectory() {
  const defaultConfigDir = path.join(os.homedir(), ".codex-im");
  fs.mkdirSync(defaultConfigDir, { recursive: true });
}

function ensureLogParentDirectory(filePath) {
  const parentDirectory = path.dirname(filePath);
  fs.mkdirSync(parentDirectory, { recursive: true });
}

function appendFatalLog(kind, error) {
  const normalizedError = error instanceof Error ? error : new Error(String(error || "unknown fatal error"));
  const stack = normalizedError.stack || normalizedError.message;
  const record = `[${new Date().toISOString()}] ${kind}\n${stack}\n`;
  try {
    ensureLogParentDirectory(FATAL_LOG_PATH);
    fs.appendFileSync(FATAL_LOG_PATH, record);
  } catch {}
}

function registerFatalHandlers() {
  process.on("uncaughtException", (error) => {
    appendFatalLog("uncaughtException", error);
    console.error(`[codex-im] uncaught exception: ${error?.stack || error?.message || error}`);
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    const error = reason instanceof Error ? reason : new Error(String(reason || "unhandled rejection"));
    appendFatalLog("unhandledRejection", error);
    console.error(`[codex-im] unhandled rejection: ${error.stack || error.message}`);
    process.exit(1);
  });
}

async function main() {
  loadEnv();
  registerFatalHandlers();
  const config = readConfig();

  if (!config.mode || config.mode === "feishu-bot") {
    const runtime = new FeishuBotRuntime(config);
    await runtime.start();
    return;
  }

  console.error("Usage: codex-im [feishu-bot]");
  process.exit(1);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[codex-im] ${error.message}`);
    process.exit(1);
  });
}

module.exports = { main };
