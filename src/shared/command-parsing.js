function extractBindPath(text) {
  return extractCommandArgument(text, "/codex bind ");
}

function extractPwdValue(text) {
  return extractSlashCommandArgument(text, "/pwd");
}

function extractLsValue(text) {
  return extractSlashCommandArgument(text, "/ls");
}

function extractMkdirValue(text) {
  return extractSlashCommandArgument(text, "/mkdir");
}

function extractSwitchThreadId(text) {
  return extractCommandArgument(text, "/codex switch ");
}

function extractRemoveWorkspacePath(text) {
  return extractCommandArgument(text, "/codex remove ");
}

function extractSendPath(text) {
  return extractCommandArgument(text, "/codex send ");
}

function extractModelValue(text) {
  return extractCommandArgument(text, "/codex model ");
}

function extractEffortValue(text) {
  return extractCommandArgument(text, "/codex effort ");
}

function extractSlashCommandArgument(text, command) {
  const trimmed = String(text || "").trim();
  const normalizedCommand = String(command || "").trim().toLowerCase();
  if (!trimmed || !normalizedCommand) {
    return "";
  }

  const normalizedText = trimmed.toLowerCase();
  if (normalizedText === normalizedCommand) {
    return "";
  }
  if (normalizedText.startsWith(`${normalizedCommand} `)) {
    return trimmed.slice(normalizedCommand.length).trim();
  }
  return "";
}

function extractCommandArgument(text, prefix) {
  const trimmed = String(text || "").trim();
  const normalizedPrefix = String(prefix || "").toLowerCase();
  if (trimmed.toLowerCase().startsWith(normalizedPrefix)) {
    return trimmed.slice(normalizedPrefix.length).trim();
  }
  return "";
}

function splitCommandLine(input) {
  const tokens = [];
  let current = "";
  let quote = null;
  let escaped = false;

  for (const char of String(input || "")) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (current) {
    tokens.push(current);
  }
  return tokens;
}

module.exports = {
  extractBindPath,
  extractLsValue,
  extractEffortValue,
  extractMkdirValue,
  extractModelValue,
  extractPwdValue,
  extractRemoveWorkspacePath,
  extractSendPath,
  extractSwitchThreadId,
  splitCommandLine,
};
