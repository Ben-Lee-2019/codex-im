const { readConfig } = require("../infra/config/config");
const { SessionStore } = require("../infra/storage/session-store");
const { CodexRpcClient } = require("../infra/codex/rpc-client");
const {
  buildCardResponse,
  buildCardToast,
  buildEffortInfoText,
  buildEffortListText,
  buildEffortValidationErrorText,
  buildGpuJobListCard,
  buildGpuMonitorCard,
  buildSubagentStatusCard,
  buildSubagentTranscriptCard,
  buildHelpCardText,
  buildModelInfoText,
  buildModelListText,
  buildModelValidationErrorText,
  buildStatusPanelCard,
  buildThreadMessagesSummary,
  buildThreadPickerCard,
  buildWorkspaceBindingsCard,
  listBoundWorkspaces,
} = require("../presentation/card/builders");
const {
  addPendingReaction,
  clearPendingReactionForBinding,
  clearPendingReactionForThread,
  disposeReplyRunState,
  handleCardAction,
  movePendingReactionToThread,
  patchInteractiveCard,
  queueCardActionWithFeedback,
  runCardActionTask,
  sendCardActionFeedback,
  sendCardActionFeedbackByContext,
  sendInfoCardMessage,
  sendInteractiveApprovalCard,
  sendInteractiveCard,
  showAssistantReplyDetail,
  updateInteractiveCard,
  upsertAssistantReplyCard,
} = require("../presentation/card/card-service");
const {
  FeishuClientAdapter,
  patchWsClientForCardCallbacks,
} = require("../infra/feishu/client-adapter");
const runtimeCommands = require("./command-dispatcher");
const approvalRuntime = require("../domain/approval/approval-service");
const gpuRuntime = require("../domain/gpu/gpu-service");
const subagentRuntime = require("../domain/subagent/subagent-service");
const runtimeState = require("../domain/session/binding-context");
const threadRuntime = require("../domain/thread/thread-service");
const workspaceRuntime = require("../domain/workspace/workspace-service");
const eventsRuntime = require("./codex-event-service");
const approvalPolicyRuntime = require("../domain/approval/approval-policy");
const appDispatcher = require("./dispatcher");
const { extractModelCatalogFromListResponse } = require("../shared/model-catalog");
const fs = require("fs");

class FeishuBotRuntime {
  constructor(config = readConfig()) {
    this.config = config;
    this.sessionStore = new SessionStore({ filePath: config.sessionsFile });
    this.codex = new CodexRpcClient({
      endpoint: config.codexEndpoint,
      env: process.env,
      codexCommand: config.codexCommand,
    });
    this.lark = null;
    this.client = null;
    this.wsClient = null;
    this.feishuAdapter = null;
    this.pendingChatContextByThreadId = new Map();
    this.pendingChatContextByBindingKey = new Map();
    this.activeTurnIdByThreadId = new Map();
    this.pendingApprovalByThreadId = new Map();
    this.replyCardByRunKey = new Map();
    this.replyDetailByMessageId = new Map();
    this.currentRunKeyByThreadId = new Map();
    this.replyFlushTimersByRunKey = new Map();
    this.pendingReactionByBindingKey = new Map();
    this.pendingReactionByThreadId = new Map();
    this.bindingKeyByThreadId = new Map();
    this.workspaceRootByThreadId = new Map();
    this.threadSessionPathByThreadId = new Map();
    this.approvalAllowlistByWorkspaceRoot = new Map();
    this.inFlightApprovalRequestKeys = new Set();
    this.resumedThreadIds = new Set();
    this.gpuMonitorByChatId = new Map();
    this.gpuMonitorTimerByChatId = new Map();
    this.subagentTrackerByRunKey = new Map();
    this.subagentPollTimerByRunKey = new Map();
    this.subagentCardByThreadId = new Map();
    this.subagentMetadataByThreadId = new Map();
    this.subagentSessionMetaByPath = new Map();
    this.codex.onMessage((message) => appDispatcher.onCodexMessage(this, message));
  }

  async start() {
    this.validateConfig();
    this.initializeFeishuSdk();
    await this.codex.connect();
    await this.codex.initialize();
    await this.refreshAvailableModelCatalogAtStartup();
    this.startLongConnection();
    console.log(`[codex-im] feishu-bot runtime ready for app ${maskSecret(this.config.feishu.appId)}`);
  }

  validateConfig() {
    if (!this.config.feishu.appId || !this.config.feishu.appSecret) {
      throw new Error("FEISHU_APP_ID and FEISHU_APP_SECRET are required for feishu-bot mode");
    }
    if (!String(this.config.defaultCodexModel || "").trim()) {
      throw new Error("CODEX_IM_DEFAULT_CODEX_MODEL is required");
    }
    if (!String(this.config.defaultCodexEffort || "").trim()) {
      throw new Error("CODEX_IM_DEFAULT_CODEX_EFFORT is required");
    }
    if (!String(this.config.defaultCodexAccessMode || "").trim()) {
      throw new Error(
        "CODEX_IM_DEFAULT_CODEX_ACCESS_MODE is required and must be one of: default, full-access"
      );
    }
  }

  initializeFeishuSdk() {
    try {
      // Official SDK: https://github.com/larksuite/node-sdk
      this.lark = require("@larksuiteoapi/node-sdk");
    } catch {
      throw new Error(
        "Missing @larksuiteoapi/node-sdk. Run `npm install` in codex-im before starting feishu-bot mode."
      );
    }

    this.client = new this.lark.Client({
      appId: this.config.feishu.appId,
      appSecret: this.config.feishu.appSecret,
      appType: this.lark.AppType.SelfBuild,
      domain: this.lark.Domain.Feishu,
      loggerLevel: this.lark.LoggerLevel.info,
    });

    this.wsClient = new this.lark.WSClient({
      appId: this.config.feishu.appId,
      appSecret: this.config.feishu.appSecret,
      appType: this.lark.AppType.SelfBuild,
      domain: this.lark.Domain.Feishu,
      loggerLevel: this.lark.LoggerLevel.info,
      wsConfig: {
        PingInterval: 30,
        PingTimeout: 5,
      },
    });
    this.feishuAdapter = new FeishuClientAdapter(this.client);
    patchWsClientForCardCallbacks(this.wsClient);
  }

  startLongConnection() {
    const eventDispatcher = new this.lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (data) => {
        appDispatcher.onFeishuTextEvent(this, data).catch((error) => {
          console.error(`[codex-im] failed to process Feishu message: ${error.message}`);
        });
      },
      "card.action.trigger": async (data) => appDispatcher.onFeishuCardAction(this, data),
    });

    this.wsClient.start({ eventDispatcher });
    console.log("[codex-im] Feishu long connection started");
  }

  async refreshAvailableModelCatalogAtStartup() {
    const response = await this.codex.listModels();
    const models = extractModelCatalogFromListResponse(response);
    if (!models.length) {
      throw new Error("model/list returned no models at startup");
    }
    this.sessionStore.setAvailableModelCatalog(models);
    const validatedDefaults = workspaceRuntime.validateDefaultCodexParamsConfig(this, models);
    if (!validatedDefaults.model) {
      throw new Error(`Invalid CODEX_IM_DEFAULT_CODEX_MODEL: ${this.config.defaultCodexModel}`);
    }
    if (!validatedDefaults.effort) {
      throw new Error(
        `Invalid CODEX_IM_DEFAULT_CODEX_EFFORT: ${this.config.defaultCodexEffort} for model ${validatedDefaults.model}`
      );
    }
    console.log(`[codex-im] model catalog refreshed at startup: ${models.length} entries`);
  }

  resolveReplyToMessageId(normalized, replyToMessageId = "") {
    return replyToMessageId || normalized.messageId;
  }

  getBindingContext(normalized) {
    const bindingKey = this.sessionStore.buildBindingKey(normalized);
    const workspaceRoot = this.resolveWorkspaceRootForBinding(bindingKey);
    return { bindingKey, workspaceRoot };
  }

  getCurrentThreadContext(normalized) {
    const { bindingKey, workspaceRoot } = this.getBindingContext(normalized);
    const threadId = workspaceRoot ? this.resolveThreadIdForBinding(bindingKey, workspaceRoot) : "";
    return { bindingKey, workspaceRoot, threadId };
  }

  requireFeishuAdapter() {
    if (!this.feishuAdapter) {
      throw new Error("Feishu adapter is not initialized");
    }
    return this.feishuAdapter;
  }

  async resolveWorkspaceStats(workspaceRoot) {
    try {
      const stats = await fs.promises.stat(workspaceRoot);
      return {
        exists: true,
        isDirectory: stats.isDirectory(),
      };
    } catch (error) {
      if (error?.code === "ENOENT") {
        return { exists: false, isDirectory: false };
      }
      throw error;
    }
  }
}

function attachRuntimeForwarders() {
  const proto = FeishuBotRuntime.prototype;

  const plainForwarders = {
    buildCardResponse,
    buildCardToast,
    buildEffortInfoText,
    buildEffortListText,
    buildEffortValidationErrorText,
    buildGpuJobListCard,
    buildGpuMonitorCard,
    buildSubagentStatusCard,
    buildSubagentTranscriptCard,
    buildHelpCardText,
    buildModelInfoText,
    buildModelListText,
    buildModelValidationErrorText,
    buildStatusPanelCard,
    buildThreadMessagesSummary,
    buildThreadPickerCard,
    buildWorkspaceBindingsCard,
    listBoundWorkspaces,
  };

  for (const [methodName, fn] of Object.entries(plainForwarders)) {
    proto[methodName] = function forwardedPlain(...args) {
      return fn(...args);
    };
  }

  const runtimeFirstForwarders = {
    dispatchTextCommand: runtimeCommands.dispatchTextCommand,
    resolveWorkspaceContext: workspaceRuntime.resolveWorkspaceContext,
    resolveWorkspaceThreadState: threadRuntime.resolveWorkspaceThreadState,
    ensureThreadAndSendMessage: threadRuntime.ensureThreadAndSendMessage,
    ensureThreadResumed: threadRuntime.ensureThreadResumed,
    resolveWorkspaceRootForBinding: runtimeState.resolveWorkspaceRootForBinding,
    resolveThreadIdForBinding: runtimeState.resolveThreadIdForBinding,
    setThreadBindingKey: runtimeState.setThreadBindingKey,
    setThreadWorkspaceRoot: runtimeState.setThreadWorkspaceRoot,
    setPendingBindingContext: runtimeState.setPendingBindingContext,
    setPendingThreadContext: runtimeState.setPendingThreadContext,
    setReplyCardEntry: runtimeState.setReplyCardEntry,
    setCurrentRunKeyForThread: runtimeState.setCurrentRunKeyForThread,
    resolveWorkspaceRootForThread: runtimeState.resolveWorkspaceRootForThread,
    rememberApprovalPrefixForWorkspace: approvalPolicyRuntime.rememberApprovalPrefixForWorkspace,
    shouldAutoApproveRequest: approvalPolicyRuntime.shouldAutoApproveRequest,
    tryAutoApproveRequest: approvalPolicyRuntime.tryAutoApproveRequest,
    applyApprovalDecision: approvalRuntime.applyApprovalDecision,
    handleBindCommand: workspaceRuntime.handleBindCommand,
    handleWhereCommand: workspaceRuntime.handleWhereCommand,
    showStatusPanel: workspaceRuntime.showStatusPanel,
    handleMessageCommand: workspaceRuntime.handleMessageCommand,
    handleHelpCommand: workspaceRuntime.handleHelpCommand,
    handleUnknownCommand: workspaceRuntime.handleUnknownCommand,
    handleWorkspacesCommand: workspaceRuntime.handleWorkspacesCommand,
    showThreadPicker: workspaceRuntime.showThreadPicker,
    handleNewCommand: threadRuntime.handleNewCommand,
    handleSwitchCommand: threadRuntime.handleSwitchCommand,
    handleRemoveCommand: workspaceRuntime.handleRemoveCommand,
    handleSendCommand: workspaceRuntime.handleSendCommand,
    handleModelCommand: workspaceRuntime.handleModelCommand,
    handleEffortCommand: workspaceRuntime.handleEffortCommand,
    handlePwdCommand: workspaceRuntime.handlePwdCommand,
    handleLsCommand: workspaceRuntime.handleLsCommand,
    handleMkdirCommand: workspaceRuntime.handleMkdirCommand,
    handleGpuCommand: gpuRuntime.handleGpuCommand,
    handleSqCommand: gpuRuntime.handleSqCommand,
    refreshWorkspaceThreads: threadRuntime.refreshWorkspaceThreads,
    describeWorkspaceStatus: threadRuntime.describeWorkspaceStatus,
    switchThreadById: threadRuntime.switchThreadById,
    handleStopCommand: eventsRuntime.handleStopCommand,
    handleApprovalCommand: approvalRuntime.handleApprovalCommand,
    deliverToFeishu: eventsRuntime.deliverToFeishu,
    sendInfoCardMessage,
    sendInteractiveApprovalCard,
    updateInteractiveCard,
    sendInteractiveCard,
    patchInteractiveCard,
    handleCardAction,
    dispatchCardAction: runtimeCommands.dispatchCardAction,
    handleGpuCardAction: gpuRuntime.handleGpuCardAction,
    handleSubagentCardAction: subagentRuntime.handleSubagentCardAction,
    handlePanelCardAction: runtimeCommands.handlePanelCardAction,
    handleReplyCardAction: runtimeCommands.handleReplyCardAction,
    handleThreadCardAction: runtimeCommands.handleThreadCardAction,
    handleWorkspaceCardAction: runtimeCommands.handleWorkspaceCardAction,
    queueCardActionWithFeedback,
    runCardActionTask,
    handleApprovalCardActionAsync: approvalRuntime.handleApprovalCardActionAsync,
    sendCardActionFeedbackByContext,
    sendCardActionFeedback,
    switchWorkspaceByPath: workspaceRuntime.switchWorkspaceByPath,
    removeWorkspaceByPath: workspaceRuntime.removeWorkspaceByPath,
    showAssistantReplyDetail,
    upsertAssistantReplyCard,
    addPendingReaction,
    movePendingReactionToThread,
    clearPendingReactionForBinding,
    clearPendingReactionForThread,
    disposeReplyRunState,
    cleanupThreadRuntimeState: runtimeState.cleanupThreadRuntimeState,
    pruneRuntimeMapSizes: runtimeState.pruneRuntimeMapSizes,
  };

  for (const [methodName, fn] of Object.entries(runtimeFirstForwarders)) {
    proto[methodName] = function forwardedRuntimeFirst(...args) {
      return fn(this, ...args);
    };
  }

  proto.getCodexParamsForWorkspace = function getCodexParamsForWorkspace(bindingKey, workspaceRoot) {
    return this.sessionStore.getCodexParamsForWorkspace(bindingKey, workspaceRoot);
  };
}

attachRuntimeForwarders();

FeishuBotRuntime.prototype.sendFileMessage = function sendFileMessage(args) {
  return this.requireFeishuAdapter().sendFileMessage(args);
};

function maskSecret(value) {
  if (!value) {
    return "";
  }
  if (value.length <= 6) {
    return "***";
  }
  return `${value.slice(0, 3)}***${value.slice(-3)}`;
}

module.exports = { FeishuBotRuntime };
