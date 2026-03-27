const fs = require("fs");
const path = require("path");
const {
  isAbsoluteWorkspacePath,
  isWorkspaceAllowed,
  normalizeWorkspacePath,
  pathMatchesWorkspaceRoot,
} = require("../../shared/workspace-paths");
const {
  extractBindPath,
  extractEffortValue,
  extractModelValue,
  extractRemoveWorkspacePath,
  extractSendPath,
} = require("../../shared/command-parsing");
const {
  extractModelCatalogFromListResponse,
  findModelByQuery,
  normalizeText,
  resolveEffectiveModelForEffort,
} = require("../../shared/model-catalog");
const codexMessageUtils = require("../../infra/codex/message-utils");
const { formatFailureText } = require("../../shared/error-text");

const MAX_FEISHU_UPLOAD_FILE_BYTES = 30 * 1024 * 1024;

async function resolveWorkspaceContext(
  runtime,
  normalized,
  {
    replyToMessageId = "",
    missingWorkspaceText = "当前会话还没有绑定项目。",
  } = {}
) {
  const replyTarget = runtime.resolveReplyToMessageId(normalized, replyToMessageId);
  const { bindingKey, workspaceRoot } = runtime.getBindingContext(normalized);
  if (!workspaceRoot) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: replyTarget,
      text: missingWorkspaceText,
    });
    return null;
  }

  runtime.sessionStore.setDeliveryContextForWorkspace(bindingKey, workspaceRoot, {
    chatId: normalized.chatId,
    threadKey: normalized.threadKey,
    lastSourceMessageId: replyTarget,
  });

  return { bindingKey, workspaceRoot, replyTarget };
}

async function handleBindCommand(runtime, normalized) {
  const bindingKey = runtime.sessionStore.buildBindingKey(normalized);
  const rawWorkspaceRoot = extractBindPath(normalized.text);
  if (!rawWorkspaceRoot) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: "用法: `/codex bind /绝对路径`",
    });
    return;
  }

  const workspaceRoot = normalizeWorkspacePath(rawWorkspaceRoot);
  if (!isAbsoluteWorkspacePath(workspaceRoot)) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: "只支持绝对路径绑定。Windows 例如 `C:\\code\\repo`，macOS/Linux 例如 `/Users/name/repo`。",
    });
    return;
  }
  if (!isWorkspaceAllowed(workspaceRoot, runtime.config.workspaceAllowlist)) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: "该项目不在允许绑定的白名单中。",
    });
    return;
  }

  const workspaceStats = await runtime.resolveWorkspaceStats(workspaceRoot);
  if (!workspaceStats.exists) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: `项目不存在: ${workspaceRoot}`,
    });
    return;
  }

  if (!workspaceStats.isDirectory) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: `路径非法: ${workspaceRoot}`,
    });
    return;
  }

  applyDefaultCodexParamsOnBind(runtime, bindingKey, workspaceRoot);
  runtime.sessionStore.setActiveWorkspaceRoot(bindingKey, workspaceRoot);
  await runtime.refreshWorkspaceThreads(bindingKey, workspaceRoot, normalized);
  const existingThreadId = runtime.resolveThreadIdForBinding(bindingKey, workspaceRoot);
  await showStatusPanel(runtime, normalized, {
    replyToMessageId: normalized.messageId,
    noticeText: existingThreadId
      ? "已切换到项目，并恢复原会话上下文。"
      : "已绑定项目。",
  });
}

async function handleWhereCommand(runtime, normalized) {
  await showStatusPanel(runtime, normalized);
}

async function showStatusPanel(runtime, normalized, { replyToMessageId, noticeText = "" } = {}) {
  const workspaceContext = await resolveWorkspaceContext(runtime, normalized, { replyToMessageId });
  if (!workspaceContext) {
    return;
  }
  const { bindingKey, workspaceRoot, replyTarget } = workspaceContext;

  const { threads, threadId } = await runtime.resolveWorkspaceThreadState({
    bindingKey,
    workspaceRoot,
    normalized,
    autoSelectThread: true,
  });
  const displayThreads = threads.map((thread) => runtime.decorateThreadForDisplay(thread));
  const currentThread = displayThreads.find((thread) => thread.id === threadId) || null;
  const recentThreads = currentThread
    ? displayThreads.filter((thread) => thread.id !== threadId).slice(0, 2)
    : displayThreads.slice(0, 3);
  const status = runtime.describeWorkspaceStatus(threadId);
  const codexParams = runtime.getCodexParamsForWorkspace(bindingKey, workspaceRoot);
  const longModeRecord = threadId ? runtime.getLongModeRecord(threadId) : null;
  const availableCatalog = runtime.sessionStore.getAvailableModelCatalog();
  const availableModels = Array.isArray(availableCatalog?.models) ? availableCatalog.models : [];
  const modelOptions = buildModelSelectOptions(availableModels);
  const effortOptions = buildEffortSelectOptions(availableModels, codexParams?.model || "");
  await runtime.sendInteractiveCard({
    chatId: normalized.chatId,
    replyToMessageId: replyTarget,
    card: runtime.buildStatusPanelCard({
      workspaceRoot,
      codexParams,
      modelOptions,
      effortOptions,
      threadId,
      currentThread,
      recentThreads,
      totalThreadCount: threads.length,
      status,
      longModeEnabled: longModeRecord?.enabled === true,
      noticeText,
    }),
  });
}

async function handleMessageCommand(runtime, normalized) {
  await runtime.inspectThreadMessages(normalized, "", {
    replyToMessageId: normalized.messageId,
  });
}

async function handleHelpCommand(runtime, normalized) {
  await runtime.sendInfoCardMessage({
    chatId: normalized.chatId,
    replyToMessageId: normalized.messageId,
    text: runtime.buildHelpCardText(),
  });
}

async function handleUnknownCommand(runtime, normalized) {
  await runtime.sendInfoCardMessage({
    chatId: normalized.chatId,
    replyToMessageId: normalized.messageId,
    text: "无效的 Codex 命令。\n\n可使用 `/codex help` 查看命令教程。",
  });
}

async function handleSendCommand(runtime, normalized) {
  const workspaceContext = await resolveWorkspaceContext(runtime, normalized, {
    replyToMessageId: normalized.messageId,
  });
  if (!workspaceContext) {
    return;
  }
  const { workspaceRoot } = workspaceContext;

  const requestedPath = extractSendPath(normalized.text);
  if (!requestedPath) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: "用法: `/codex send <当前项目下的相对文件路径>`",
    });
    return;
  }

  const resolvedTarget = resolveWorkspaceSendTarget(workspaceRoot, requestedPath);
  if (resolvedTarget.errorText) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: resolvedTarget.errorText,
    });
    return;
  }

  let fileStats;
  try {
    fileStats = await fs.promises.stat(resolvedTarget.filePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      await runtime.sendInfoCardMessage({
        chatId: normalized.chatId,
        replyToMessageId: normalized.messageId,
        text: `文件不存在: ${resolvedTarget.displayPath}`,
      });
      return;
    }
    throw error;
  }

  if (!fileStats.isFile()) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: `只支持发送文件，不支持目录: ${resolvedTarget.displayPath}`,
    });
    return;
  }

  if (fileStats.size <= 0) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: `文件为空，无法发送: ${resolvedTarget.displayPath}`,
    });
    return;
  }

  if (fileStats.size > MAX_FEISHU_UPLOAD_FILE_BYTES) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: `文件过大，飞书当前只支持发送 30MB 以内文件: ${resolvedTarget.displayPath}`,
    });
    return;
  }

  try {
    const fileBuffer = await fs.promises.readFile(resolvedTarget.filePath);
    await runtime.sendFileMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      fileName: path.basename(resolvedTarget.filePath),
      fileBuffer,
    });
    console.log(`[codex-im] file/send ok workspace=${workspaceRoot} path=${resolvedTarget.displayPath}`);
  } catch (error) {
    console.warn(
      `[codex-im] file/send failed workspace=${workspaceRoot} path=${resolvedTarget.displayPath}: ${error.message}`
    );
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: formatFailureText("发送文件失败", error),
    });
  }
}

async function handleModelCommand(runtime, normalized) {
  const workspaceContext = await resolveCodexSettingWorkspaceContext(runtime, normalized);
  if (!workspaceContext) {
    return;
  }
  const { bindingKey, workspaceRoot } = workspaceContext;

  const rawModel = extractModelValue(normalized.text);
  if (!rawModel) {
    const current = runtime.getCodexParamsForWorkspace(bindingKey, workspaceRoot);
    const availableModelsResult = await loadAvailableModels(runtime, {
      forceRefresh: false,
    });
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: runtime.buildModelInfoText(workspaceRoot, current, availableModelsResult),
    });
    return;
  }

  const modelUpdateDirective = parseUpdateDirective(rawModel);
  if (modelUpdateDirective) {
    const availableModelsResult = await loadAvailableModels(runtime, {
      forceRefresh: true,
    });
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: runtime.buildModelListText(workspaceRoot, availableModelsResult, {
        refreshed: true,
      }),
    });
    return;
  }

  const availableModelsResult = await loadAvailableModelsForSetting(runtime, normalized, {
    settingType: "model",
  });
  if (!availableModelsResult) {
    return;
  }

  const resolvedModel = resolveRequestedModel(availableModelsResult.models, rawModel);
  if (!resolvedModel) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: runtime.buildModelValidationErrorText(workspaceRoot, rawModel, availableModelsResult.models),
    });
    return;
  }

  const current = runtime.getCodexParamsForWorkspace(bindingKey, workspaceRoot);
  runtime.sessionStore.setCodexParamsForWorkspace(bindingKey, workspaceRoot, {
    model: resolvedModel,
    effort: current.effort || "",
  });
  await runtime.showStatusPanel(normalized, {
    replyToMessageId: normalized.messageId,
    noticeText: `已设置模型：${resolvedModel}`,
  });
}

async function handleEffortCommand(runtime, normalized) {
  const workspaceContext = await resolveCodexSettingWorkspaceContext(runtime, normalized);
  if (!workspaceContext) {
    return;
  }
  const { bindingKey, workspaceRoot } = workspaceContext;

  const rawEffort = extractEffortValue(normalized.text);
  if (!rawEffort) {
    const current = runtime.getCodexParamsForWorkspace(bindingKey, workspaceRoot);
    const availableModelsResult = await loadAvailableModels(runtime, {
      forceRefresh: false,
    });
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: runtime.buildEffortInfoText(workspaceRoot, current, availableModelsResult),
    });
    return;
  }

  const availableModelsResult = await loadAvailableModelsForSetting(runtime, normalized, {
    settingType: "effort",
  });
  if (!availableModelsResult) {
    return;
  }

  const current = runtime.getCodexParamsForWorkspace(bindingKey, workspaceRoot);
  const effectiveModel = resolveEffectiveModelForEffort(availableModelsResult.models, current.model);
  if (!effectiveModel) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: "当前无法确定模型，请先执行 `/codex model` 并设置模型后再设置推理强度。",
    });
    return;
  }

  const resolvedEffort = resolveRequestedEffort(effectiveModel, rawEffort);
  if (!resolvedEffort) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: runtime.buildEffortValidationErrorText(workspaceRoot, effectiveModel, rawEffort),
    });
    return;
  }

  runtime.sessionStore.setCodexParamsForWorkspace(bindingKey, workspaceRoot, {
    model: current.model || "",
    effort: resolvedEffort,
  });
  await runtime.showStatusPanel(normalized, {
    replyToMessageId: normalized.messageId,
    noticeText: `已设置推理强度：${resolvedEffort}`,
  });
}

async function handleWorkspacesCommand(runtime, normalized, { replyToMessageId } = {}) {
  const bindingKey = runtime.sessionStore.buildBindingKey(normalized);
  const binding = runtime.sessionStore.getBinding(bindingKey) || {};
  const items = runtime.listBoundWorkspaces(binding);
  const replyTarget = runtime.resolveReplyToMessageId(normalized, replyToMessageId);
  if (!items.length) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: replyTarget,
      text: "当前会话还没有已绑定项目。先发送 `/codex bind /绝对路径`。",
    });
    return;
  }

  await runtime.sendInteractiveCard({
    chatId: normalized.chatId,
    replyToMessageId: replyTarget,
    card: runtime.buildWorkspaceBindingsCard(items),
  });
}

async function showThreadPicker(runtime, normalized, { replyToMessageId } = {}) {
  const replyTarget = runtime.resolveReplyToMessageId(normalized, replyToMessageId);
  const { bindingKey, workspaceRoot } = runtime.getBindingContext(normalized);
  if (!workspaceRoot) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: replyTarget,
      text: "当前会话还未绑定项目。先发送 `/codex bind /绝对路径`。",
    });
    return;
  }

  const threads = await runtime.refreshWorkspaceThreads(bindingKey, workspaceRoot, normalized);
  const selection = runtime.resolveConversationThreadSelection({
    threads,
    selectedThreadId: runtime.resolveThreadIdForBinding(bindingKey, workspaceRoot),
    reviewerMainThreadIdByReviewerThreadId: runtime.reviewerMainThreadIdByReviewerThreadId,
  });
  const currentThreadId = selection.threadId;
  if (!threads.length) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: replyTarget,
      text: `当前项目：\`${workspaceRoot}\`\n\n还没有可切换的历史线程。`,
    });
    return;
  }

  await runtime.sendInteractiveCard({
    chatId: normalized.chatId,
    replyToMessageId: replyTarget,
    card: runtime.buildThreadPickerCard({
      workspaceRoot,
      threads: threads.map((thread) => runtime.decorateThreadForDisplay(thread)),
      currentThreadId,
    }),
  });
}

async function handleRemoveCommand(runtime, normalized) {
  const workspaceRoot = extractRemoveWorkspacePath(normalized.text);
  if (!workspaceRoot) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: "用法: `/codex remove /绝对路径`",
    });
    return;
  }

  if (!isAbsoluteWorkspacePath(workspaceRoot)) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: "路径必须是绝对路径。",
    });
    return;
  }

  await removeWorkspaceByPath(runtime, normalized, workspaceRoot, {
    replyToMessageId: normalized.messageId,
  });
}

async function switchWorkspaceByPath(runtime, normalized, workspaceRoot, { replyToMessageId } = {}) {
  const targetWorkspaceRoot = normalizeWorkspacePath(workspaceRoot);
  if (!targetWorkspaceRoot) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: replyToMessageId || normalized.messageId,
      text: "目标项目无效，请刷新后重试。",
    });
    return;
  }

  const bindingKey = runtime.sessionStore.buildBindingKey(normalized);
  const currentWorkspaceRoot = runtime.resolveWorkspaceRootForBinding(bindingKey);
  if (currentWorkspaceRoot && currentWorkspaceRoot === targetWorkspaceRoot) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: replyToMessageId || normalized.messageId,
      text: "已经是当前项目，无需切换。",
    });
    return;
  }

  const binding = runtime.sessionStore.getBinding(bindingKey) || {};
  const items = runtime.listBoundWorkspaces(binding);
  if (!items.some((item) => item.workspaceRoot === targetWorkspaceRoot)) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: replyToMessageId || normalized.messageId,
      text: "该项目未绑定到当前会话，请先执行 `/codex bind /绝对路径`。",
    });
    return;
  }

  runtime.sessionStore.setActiveWorkspaceRoot(bindingKey, targetWorkspaceRoot);
  await runtime.resolveWorkspaceThreadState({
    bindingKey,
    workspaceRoot: targetWorkspaceRoot,
    normalized,
    autoSelectThread: true,
  });

  await handleWorkspacesCommand(runtime, normalized, {
    replyToMessageId: replyToMessageId || normalized.messageId,
  });
}

async function removeWorkspaceByPath(runtime, normalized, workspaceRoot, { replyToMessageId } = {}) {
  const targetWorkspaceRoot = normalizeWorkspacePath(workspaceRoot);
  if (!targetWorkspaceRoot) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: replyToMessageId || normalized.messageId,
      text: "目标项目无效，请刷新后重试。",
    });
    return;
  }

  const bindingKey = runtime.sessionStore.buildBindingKey(normalized);
  const currentWorkspaceRoot = runtime.resolveWorkspaceRootForBinding(bindingKey);
  if (currentWorkspaceRoot && currentWorkspaceRoot === targetWorkspaceRoot) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: replyToMessageId || normalized.messageId,
      text: "当前项目不支持移除，请先切换到其他项目。",
    });
    return;
  }

  const binding = runtime.sessionStore.getBinding(bindingKey) || {};
  const items = runtime.listBoundWorkspaces(binding);
  if (!items.some((item) => item.workspaceRoot === targetWorkspaceRoot)) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: replyToMessageId || normalized.messageId,
      text: "该项目未绑定到当前会话，无需移除。",
    });
    return;
  }

  runtime.sessionStore.removeWorkspace(bindingKey, targetWorkspaceRoot);
  await handleWorkspacesCommand(runtime, normalized, {
    replyToMessageId: replyToMessageId || normalized.messageId,
  });
}

module.exports = {
  handleBindCommand,
  handleEffortCommand,
  handleHelpCommand,
  handleMessageCommand,
  handleModelCommand,
  handleRemoveCommand,
  handleSendCommand,
  handleUnknownCommand,
  handleWhereCommand,
  handleWorkspacesCommand,
  removeWorkspaceByPath,
  resolveWorkspaceContext,
  showStatusPanel,
  showThreadPicker,
  switchWorkspaceByPath,
  validateDefaultCodexParamsConfig,
};

function resolveWorkspaceSendTarget(workspaceRoot, requestedPath) {
  const normalizedInput = normalizeWorkspacePath(requestedPath);
  if (!normalizedInput) {
    return { errorText: "用法: `/codex send <当前项目下的相对文件路径>`" };
  }
  if (isAbsoluteWorkspacePath(normalizedInput)) {
    return { errorText: "只支持当前项目下的相对路径，不支持绝对路径。" };
  }

  const filePath = path.resolve(workspaceRoot, requestedPath);
  const normalizedResolvedPath = normalizeWorkspacePath(filePath);
  if (!pathMatchesWorkspaceRoot(normalizedResolvedPath, workspaceRoot)) {
    return { errorText: "文件路径超出了当前项目根目录。" };
  }

  return {
    filePath,
    displayPath: normalizeWorkspacePath(path.relative(workspaceRoot, filePath)) || path.basename(filePath),
  };
}

function parseUpdateDirective(value) {
  const normalized = String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (normalized === "update") {
    return { forceRefresh: true };
  }
  return null;
}

function applyDefaultCodexParamsOnBind(runtime, bindingKey, workspaceRoot) {
  const current = runtime.sessionStore.getCodexParamsForWorkspace(bindingKey, workspaceRoot);
  if (current.model || current.effort) {
    return;
  }

  const availableCatalog = runtime.sessionStore.getAvailableModelCatalog();
  const availableModels = Array.isArray(availableCatalog?.models) ? availableCatalog.models : [];
  const validatedDefaults = validateDefaultCodexParamsConfig(runtime, availableModels);
  const defaultModel = validatedDefaults.model;
  const defaultEffort = validatedDefaults.effort;
  if (!defaultModel && !defaultEffort) {
    return;
  }

  runtime.sessionStore.setCodexParamsForWorkspace(bindingKey, workspaceRoot, {
    model: defaultModel,
    effort: defaultEffort,
  });
}

function validateDefaultCodexParamsConfig(runtime, modelsInput) {
  const models = Array.isArray(modelsInput) ? modelsInput : [];
  const rawModel = normalizeText(runtime.config.defaultCodexModel);
  const rawEffort = normalizeEffort(runtime.config.defaultCodexEffort);
  const result = { model: "", effort: "" };
  if (!rawModel && !rawEffort) {
    return result;
  }
  if (!models.length) {
    return result;
  }

  if (rawModel) {
    result.model = resolveRequestedModel(models, rawModel);
  }

  if (rawEffort) {
    const effectiveModel = resolveEffectiveModelForEffort(models, result.model || rawModel);
    if (effectiveModel) {
      result.effort = resolveRequestedEffort(effectiveModel, rawEffort);
    }
  }

  return result;
}

async function resolveCodexSettingWorkspaceContext(runtime, normalized) {
  return resolveWorkspaceContext(runtime, normalized, {
    replyToMessageId: normalized.messageId,
    missingWorkspaceText: "当前会话还未绑定项目。先发送 `/codex bind /绝对路径`。",
  });
}

function normalizeEffort(value) {
  return String(value || "").trim().toLowerCase();
}

async function loadAvailableModelsForSetting(runtime, normalized, { settingType }) {
  const availableModelsResult = await loadAvailableModels(runtime, {
    forceRefresh: false,
  });
  if (!availableModelsResult.error) {
    return availableModelsResult;
  }
  const isEffort = settingType === "effort";
  const actionLabel = isEffort ? "推理强度" : "模型";
  const listCommand = isEffort ? "/codex effort" : "/codex model";
  await runtime.sendInfoCardMessage({
    chatId: normalized.chatId,
    replyToMessageId: normalized.messageId,
    text: [
      `无法设置${actionLabel}：${availableModelsResult.error}`,
      "",
      `请先执行 \`${listCommand}\`，确认可用${actionLabel}后重试。`,
    ].join("\n"),
  });
  return null;
}

async function loadAvailableModels(runtime, { forceRefresh = false } = {}) {
  const cached = runtime.sessionStore.getAvailableModelCatalog();
  if (!forceRefresh && cached?.models?.length) {
    return {
      models: cached.models,
      error: "",
      source: "cache",
      updatedAt: cached.updatedAt || "",
    };
  }

  try {
    const response = await runtime.codex.listModels();
    const models = extractModelCatalogFromListResponse(response);
    if (!models.length) {
      if (cached?.models?.length) {
        return {
          models: cached.models,
          error: "",
          source: "cache",
          updatedAt: cached.updatedAt || "",
          warning: "Codex 未返回模型列表，已回退本地缓存。",
        };
      }
      return {
        models: [],
        error: "Codex 未返回可用模型列表。",
        source: forceRefresh ? "refresh" : "live",
        updatedAt: "",
      };
    }
    const saved = runtime.sessionStore.setAvailableModelCatalog(models);
    return {
      models,
      error: "",
      source: forceRefresh ? "refresh" : "live",
      updatedAt: saved?.updatedAt || new Date().toISOString(),
    };
  } catch (error) {
    if (cached?.models?.length) {
      return {
        models: cached.models,
        error: "",
        source: "cache",
        updatedAt: cached.updatedAt || "",
        warning: `拉取失败，已回退本地缓存：${error?.message || "未知错误"}`,
      };
    }
    return {
      models: [],
      error: error?.message || "获取模型列表失败。",
      source: forceRefresh ? "refresh" : "live",
      updatedAt: "",
    };
  }
}

function resolveRequestedModel(models, rawInput) {
  const matched = findModelByQuery(models, rawInput);
  return matched?.model || matched?.id || "";
}

function resolveRequestedEffort(modelEntry, rawEffort) {
  if (!modelEntry) {
    return "";
  }
  const query = normalizeEffort(rawEffort);
  if (!query) {
    return "";
  }
  const availableEfforts = listModelEfforts(modelEntry, { withDefaultFallback: true });
  for (const effort of availableEfforts) {
    if (normalizeEffort(effort) === query) {
      return effort;
    }
  }
  return "";
}

function buildModelSelectOptions(models) {
  if (!Array.isArray(models) || !models.length) {
    return [];
  }
  return models
    .map((item) => normalizeText(item?.model))
    .filter(Boolean)
    .slice(0, 100)
    .map((model) => ({
      label: model,
      value: model,
    }));
}

function buildEffortSelectOptions(models, currentModel) {
  const effectiveModel = resolveEffectiveModelForEffort(models, currentModel);
  if (!effectiveModel) {
    return [];
  }
  const supported = listModelEfforts(effectiveModel, { withDefaultFallback: true });
  const options = [];
  const seen = new Set();
  for (const effort of supported) {
    const normalized = normalizeText(effort);
    if (!normalized) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    options.push({
      label: normalized,
      value: normalized,
    });
  }
  return options.slice(0, 20);
}

function listModelEfforts(modelEntry, { withDefaultFallback = false } = {}) {
  const supported = Array.isArray(modelEntry?.supportedReasoningEfforts)
    ? modelEntry.supportedReasoningEfforts
    : [];
  if (supported.length) {
    return supported;
  }
  if (!withDefaultFallback) {
    return [];
  }
  const defaultEffort = normalizeText(modelEntry?.defaultReasoningEffort);
  return defaultEffort ? [defaultEffort] : [];
}
