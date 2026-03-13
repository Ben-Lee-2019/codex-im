const path = require("path");
const { readConfig } = require("./config");
const { SessionStore } = require("./session-store");
const { CodexRpcClient } = require("./codex-rpc-client");
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
    this.pendingChatContextByThreadId = new Map();
    this.pendingChatContextByBindingKey = new Map();
    this.activeTurnIdByThreadId = new Map();
    this.pendingApprovalByThreadId = new Map();
    this.replyCardByRunKey = new Map();
    this.currentRunKeyByThreadId = new Map();
    this.replyFlushTimersByRunKey = new Map();
    this.pendingReactionByBindingKey = new Map();
    this.pendingReactionByThreadId = new Map();
    this.resumedThreadIds = new Set();
    this.codex.onMessage(this.handleCodexMessage.bind(this));
  }

  async start() {
    this.validateConfig();
    this.initializeFeishuSdk();
    await this.codex.connect();
    await this.codex.initialize();
    this.startLongConnection();
    console.log(`[codex-im] feishu-bot runtime ready for app ${maskSecret(this.config.feishu.appId)}`);
  }

  validateConfig() {
    if (!this.config.feishu.appId || !this.config.feishu.appSecret) {
      throw new Error("FEISHU_APP_ID and FEISHU_APP_SECRET are required for feishu-bot mode");
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
    });
    patchWsClientForCardCallbacks(this.wsClient);
  }

  startLongConnection() {
    const eventDispatcher = new this.lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (data) => {
        this.handleIncomingTextEvent(data).catch((error) => {
          console.error(`[codex-im] failed to process Feishu message: ${error.message}`);
        });
      },
      "card.action.trigger": async (data) => {
        try {
          return await this.handleCardAction(data);
        } catch (error) {
          console.error(`[codex-im] failed to process card action: ${error.message}`);
          return buildCardToast(`处理失败: ${error.message}`);
        }
      },
    });

    this.wsClient.start({ eventDispatcher });
    console.log("[codex-im] Feishu long connection started");
  }

  async handleIncomingTextEvent(event) {
    const normalized = normalizeFeishuTextEvent(event, this.config);
    if (!normalized) {
      return;
    }

    if (normalized.command === "stop") {
      await this.handleStopCommand(normalized);
      return;
    }
    if (normalized.command === "bind") {
      await this.handleBindCommand(normalized);
      return;
    }
    if (normalized.command === "where") {
      await this.handleWhereCommand(normalized);
      return;
    }
    if (normalized.command === "inspect_message") {
      await this.handleMessageCommand(normalized);
      return;
    }
    if (normalized.command === "help") {
      await this.handleHelpCommand(normalized);
      return;
    }
    if (normalized.command === "unknown_command") {
      await this.handleUnknownCommand(normalized);
      return;
    }
    if (normalized.command === "workspaces") {
      await this.handleWorkspacesCommand(normalized);
      return;
    }
    if (normalized.command === "use") {
      await this.handleUseCommand(normalized);
      return;
    }
    if (normalized.command === "new") {
      await this.handleNewCommand(normalized);
      return;
    }
    if (normalized.command === "approve" || normalized.command === "reject") {
      await this.handleApprovalCommand(normalized);
      return;
    }

    const bindingKey = this.sessionStore.buildBindingKey(normalized);
    const workspaceRoot = this.resolveWorkspaceRootForBinding(bindingKey);
    if (!workspaceRoot) {
      await this.sendTextMessage({
        chatId: normalized.chatId,
        replyToMessageId: normalized.messageId,
        text: "当前会话还未绑定工作目录。先发送 `/codex bind /绝对路径`。",
      });
      return;
    }
    const availableThreads = await this.refreshWorkspaceThreads(bindingKey, workspaceRoot, normalized);
    const selectedThreadId = this.resolveThreadIdForBinding(bindingKey, workspaceRoot);
    const threadId = selectedThreadId || availableThreads[0]?.id || null;
    if (!selectedThreadId && threadId) {
      this.sessionStore.setThreadIdForWorkspace(bindingKey, workspaceRoot, threadId, {
        workspaceId: normalized.workspaceId,
        chatId: normalized.chatId,
        threadKey: normalized.threadKey,
        senderId: normalized.senderId,
      });
    }

    this.pendingChatContextByBindingKey.set(bindingKey, normalized);
    if (threadId) {
      this.pendingChatContextByThreadId.set(threadId, normalized);
    }

    await this.addPendingReaction(bindingKey, normalized.messageId);

    try {
      const resolvedThreadId = await this.ensureThreadAndSendMessage({
        bindingKey,
        workspaceRoot,
        normalized,
        threadId,
      });
      this.movePendingReactionToThread(bindingKey, resolvedThreadId);
    } catch (error) {
      await this.clearPendingReactionForBinding(bindingKey);
      await this.sendTextMessage({
        chatId: normalized.chatId,
        replyToMessageId: normalized.messageId,
        text: `处理失败: ${error.message}`,
      });
      throw error;
    }
  }

  async ensureThreadAndSendMessage({ bindingKey, workspaceRoot, normalized, threadId }) {
    if (!threadId) {
      const createdThreadId = await this.createWorkspaceThread({
        bindingKey,
        workspaceRoot,
        normalized,
      });
      console.log(`[codex-im] turn/start first message thread=${createdThreadId}`);
      await this.codex.sendUserMessage({
        threadId: createdThreadId,
        text: normalized.text,
      });
      return createdThreadId;
    }

    try {
      await this.ensureThreadResumed(threadId);
      await this.codex.sendUserMessage({
        threadId,
        text: normalized.text,
      });
      console.log(`[codex-im] turn/start ok workspace=${workspaceRoot} thread=${threadId}`);
      return threadId;
    } catch (error) {
      if (!shouldRecreateThread(error)) {
        throw error;
      }

      console.warn(`[codex-im] stale thread detected, recreating workspace thread: ${threadId}`);
      this.resumedThreadIds.delete(threadId);
      this.sessionStore.clearThreadIdForWorkspace(bindingKey, workspaceRoot);
      const recreatedThreadId = await this.createWorkspaceThread({
        bindingKey,
        workspaceRoot,
        normalized,
      });
      console.log(`[codex-im] turn/start retry thread=${recreatedThreadId}`);
      await this.codex.sendUserMessage({
        threadId: recreatedThreadId,
        text: normalized.text,
      });
      return recreatedThreadId;
    }
  }

  async createWorkspaceThread({ bindingKey, workspaceRoot, normalized }) {
    const response = await this.codex.startThread({
      cwd: workspaceRoot,
    });
    console.log(`[codex-im] thread/start ok workspace=${workspaceRoot}`);

    const resolvedThreadId = extractThreadId(response);
    if (!resolvedThreadId) {
      throw new Error("thread/start did not return a thread id");
    }

    this.sessionStore.setThreadIdForWorkspace(bindingKey, workspaceRoot, resolvedThreadId, {
      workspaceId: normalized.workspaceId,
      chatId: normalized.chatId,
      threadKey: normalized.threadKey,
      senderId: normalized.senderId,
    });
    this.resumedThreadIds.add(resolvedThreadId);
    this.pendingChatContextByThreadId.set(resolvedThreadId, normalized);
    return resolvedThreadId;
  }

  async ensureThreadResumed(threadId) {
    const normalizedThreadId = typeof threadId === "string" ? threadId.trim() : "";
    if (!normalizedThreadId || this.resumedThreadIds.has(normalizedThreadId)) {
      return null;
    }

    const response = await this.codex.resumeThread({ threadId: normalizedThreadId });
    this.resumedThreadIds.add(normalizedThreadId);
    console.log(`[codex-im] thread/resume ok thread=${normalizedThreadId}`);
    return response;
  }

  resolveWorkspaceRootForBinding(bindingKey) {
    const active = this.sessionStore.getActiveWorkspaceRoot(bindingKey);
    return typeof active === "string" && active.trim() ? active.trim() : "";
  }

  resolveThreadIdForBinding(bindingKey, workspaceRoot) {
    return this.sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
  }

  async handleBindCommand(normalized) {
    const bindingKey = this.sessionStore.buildBindingKey(normalized);
    const rawWorkspaceRoot = extractBindPath(normalized.text);
    if (!rawWorkspaceRoot) {
      await this.sendTextMessage({
        chatId: normalized.chatId,
        replyToMessageId: normalized.messageId,
        text: "用法: `/codex bind /绝对路径`",
      });
      return;
    }

    const workspaceRoot = normalizeWorkspacePath(rawWorkspaceRoot);
    if (!isAbsoluteWorkspacePath(workspaceRoot)) {
      await this.sendTextMessage({
        chatId: normalized.chatId,
        replyToMessageId: normalized.messageId,
        text: "只支持绝对路径绑定。Windows 例如 `C:\\code\\repo`，macOS/Linux 例如 `/Users/name/repo`。",
      });
      return;
    }
    if (!isWorkspaceAllowed(workspaceRoot, this.config.workspaceAllowlist)) {
      await this.sendTextMessage({
        chatId: normalized.chatId,
        replyToMessageId: normalized.messageId,
        text: "该目录不在允许绑定的白名单中。",
      });
      return;
    }

    if (!fs.existsSync(workspaceRoot)) {
      await this.sendTextMessage({
        chatId: normalized.chatId,
        replyToMessageId: normalized.messageId,
        text: `目录不存在: ${workspaceRoot}`,
      });
      return;
    }

    const stats = fs.statSync(workspaceRoot);
    if (!stats.isDirectory()) {
      await this.sendTextMessage({
        chatId: normalized.chatId,
        replyToMessageId: normalized.messageId,
        text: `不是目录: ${workspaceRoot}`,
      });
      return;
    }

    this.sessionStore.setActiveWorkspaceRoot(bindingKey, workspaceRoot);
    await this.refreshWorkspaceThreads(bindingKey, workspaceRoot, normalized);
    const existingThreadId = this.resolveThreadIdForBinding(bindingKey, workspaceRoot);
    await this.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: existingThreadId
        ? `已切换到工作目录，并恢复原会话上下文:\n${workspaceRoot}`
        : `已绑定工作目录:\n${workspaceRoot}`,
    });
  }

  async handleWhereCommand(normalized) {
    await this.showStatusPanel(normalized);
  }

  async showStatusPanel(normalized, { replyToMessageId } = {}) {
    const bindingKey = this.sessionStore.buildBindingKey(normalized);
    const workspaceRoot = this.resolveWorkspaceRootForBinding(bindingKey);
    if (!workspaceRoot) {
      await this.sendTextMessage({
        chatId: normalized.chatId,
        replyToMessageId: replyToMessageId || normalized.messageId,
        text: "当前会话还没有绑定工作目录。",
      });
      return;
    }

    const threads = await this.refreshWorkspaceThreads(bindingKey, workspaceRoot, normalized);
    const threadId = this.resolveThreadIdForBinding(bindingKey, workspaceRoot)
      || threads[0]?.id
      || "";
    if (!this.resolveThreadIdForBinding(bindingKey, workspaceRoot) && threadId) {
      this.sessionStore.setThreadIdForWorkspace(bindingKey, workspaceRoot, threadId, {
        workspaceId: normalized.workspaceId,
        chatId: normalized.chatId,
        threadKey: normalized.threadKey,
        senderId: normalized.senderId,
      });
    }
    const currentThread = threads.find((thread) => thread.id === threadId) || null;
    const recentThreads = threads.filter((thread) => thread.id !== threadId).slice(0, 3);
    const status = this.describeWorkspaceStatus(threadId);
    await this.sendInteractiveCard({
      chatId: normalized.chatId,
      replyToMessageId: replyToMessageId || normalized.messageId,
      card: buildStatusPanelCard({
        workspaceRoot,
        threadId,
        currentThread,
        recentThreads,
        status,
      }),
    });
  }

  async handleMessageCommand(normalized) {
    const bindingKey = this.sessionStore.buildBindingKey(normalized);
    const workspaceRoot = this.resolveWorkspaceRootForBinding(bindingKey);
    if (!workspaceRoot) {
      await this.sendTextMessage({
        chatId: normalized.chatId,
        replyToMessageId: normalized.messageId,
        text: "当前会话还没有绑定工作目录。",
      });
      return;
    }

    const threads = await this.refreshWorkspaceThreads(bindingKey, workspaceRoot, normalized);
    let threadId = this.resolveThreadIdForBinding(bindingKey, workspaceRoot);
    if (!threadId && threads[0]?.id) {
      threadId = threads[0].id;
      this.sessionStore.setThreadIdForWorkspace(bindingKey, workspaceRoot, threadId, {
        workspaceId: normalized.workspaceId,
        chatId: normalized.chatId,
        threadKey: normalized.threadKey,
        senderId: normalized.senderId,
      });
    }

    if (!threadId) {
      await this.sendInfoCardMessage({
        chatId: normalized.chatId,
        replyToMessageId: normalized.messageId,
        text: `当前工作目录：\`${workspaceRoot}\`\n\n该目录还没有可查看的线程消息。`,
      });
      return;
    }

    const currentThread = threads.find((thread) => thread.id === threadId) || { id: threadId };
    this.resumedThreadIds.delete(threadId);
    const resumeResponse = await this.ensureThreadResumed(threadId);
    const recentMessages = extractRecentConversationFromResumeResponse(resumeResponse);

    await this.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: buildThreadMessagesSummary({
        workspaceRoot,
        thread: currentThread,
        recentMessages,
      }),
    });
  }

  async handleHelpCommand(normalized) {
    await this.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: buildHelpCardText(),
    });
  }

  async handleUnknownCommand(normalized) {
    await this.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: "无效的 Codex 命令。\n\n可使用 `/codex help` 查看命令教程。",
    });
  }

  async handleWorkspacesCommand(normalized) {
    await this.showThreadPicker(normalized);
  }

  async showThreadPicker(normalized, { replyToMessageId } = {}) {
    const bindingKey = this.sessionStore.buildBindingKey(normalized);
    const workspaceRoot = this.resolveWorkspaceRootForBinding(bindingKey);
    if (!workspaceRoot) {
      await this.sendTextMessage({
        chatId: normalized.chatId,
        replyToMessageId: replyToMessageId || normalized.messageId,
        text: "当前会话还未绑定工作目录。先发送 `/codex bind /绝对路径`。",
      });
      return;
    }

    const threads = await this.refreshWorkspaceThreads(bindingKey, workspaceRoot, normalized);
    const currentThreadId = this.resolveThreadIdForBinding(bindingKey, workspaceRoot) || threads[0]?.id || "";
    if (!threads.length) {
      await this.sendInfoCardMessage({
        chatId: normalized.chatId,
        replyToMessageId: replyToMessageId || normalized.messageId,
        text: `当前工作目录：\`${workspaceRoot}\`\n\n还没有可切换的历史线程。`,
      });
      return;
    }

    await this.sendInteractiveCard({
      chatId: normalized.chatId,
      replyToMessageId: replyToMessageId || normalized.messageId,
      card: buildThreadPickerCard({
        workspaceRoot,
        threads,
        currentThreadId,
      }),
    });
  }

  async handleNewCommand(normalized) {
    const bindingKey = this.sessionStore.buildBindingKey(normalized);
    const workspaceRoot = this.resolveWorkspaceRootForBinding(bindingKey);
    if (!workspaceRoot) {
      await this.sendTextMessage({
        chatId: normalized.chatId,
        replyToMessageId: normalized.messageId,
        text: "当前会话还未绑定工作目录。先发送 `/codex bind /绝对路径`。",
      });
      return;
    }

    try {
      const createdThreadId = await this.createWorkspaceThread({
        bindingKey,
        workspaceRoot,
        normalized,
      });
      await this.sendInfoCardMessage({
        chatId: normalized.chatId,
        replyToMessageId: normalized.messageId,
        text: `已创建新线程并切换到它:\n${workspaceRoot}\n\nthread: ${createdThreadId}`,
      });
      await this.showStatusPanel(normalized, { replyToMessageId: normalized.messageId });
    } catch (error) {
      await this.sendTextMessage({
        chatId: normalized.chatId,
        replyToMessageId: normalized.messageId,
        text: `创建新线程失败: ${error.message}`,
      });
    }
  }

  async handleUseCommand(normalized) {
    const threadId = extractUseThreadId(normalized.text);
    if (!threadId) {
      await this.sendTextMessage({
        chatId: normalized.chatId,
        replyToMessageId: normalized.messageId,
        text: "用法: `/codex use <threadId>`",
      });
      return;
    }

    await this.switchThreadById(normalized, threadId, { replyToMessageId: normalized.messageId });
  }

  async refreshWorkspaceThreads(bindingKey, workspaceRoot, normalized) {
    try {
      const threads = await this.listCodexThreadsForWorkspace(workspaceRoot);
      const currentThreadId = this.sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
      const shouldKeepCurrentThread = currentThreadId && this.resumedThreadIds.has(currentThreadId);
      if (currentThreadId && !shouldKeepCurrentThread && !threads.some((thread) => thread.id === currentThreadId)) {
        this.sessionStore.clearThreadIdForWorkspace(bindingKey, workspaceRoot);
      }
      return threads;
    } catch (error) {
      console.warn(`[codex-im] thread/list failed for workspace=${workspaceRoot}: ${error.message}`);
      return [];
    }
  }

  async listCodexThreadsForWorkspace(workspaceRoot) {
    const response = await this.codex.listThreads({
      cursor: null,
      limit: 100,
      sortKey: "updated_at",
    });
    const threads = extractThreadsFromListResponse(response);
    return threads.filter((thread) => pathMatchesWorkspaceRoot(thread.cwd, workspaceRoot));
  }

  describeWorkspaceStatus(threadId) {
    if (!threadId) {
      return { code: "idle", label: "空闲" };
    }
    if (this.pendingApprovalByThreadId.has(threadId)) {
      return { code: "approval", label: "等待授权" };
    }
    if (this.activeTurnIdByThreadId.has(threadId)) {
      return { code: "running", label: "运行中" };
    }
    return { code: "idle", label: "空闲" };
  }

  async switchThreadById(normalized, threadId, { replyToMessageId } = {}) {
    const bindingKey = this.sessionStore.buildBindingKey(normalized);
    const workspaceRoot = this.resolveWorkspaceRootForBinding(bindingKey);
    if (!workspaceRoot) {
      await this.sendTextMessage({
        chatId: normalized.chatId,
        replyToMessageId: replyToMessageId || normalized.messageId,
        text: "当前会话还未绑定工作目录。先发送 `/codex bind /绝对路径`。",
      });
      return;
    }

    const availableThreads = await this.refreshWorkspaceThreads(bindingKey, workspaceRoot, normalized);
    const selectedThread = availableThreads.find((thread) => thread.id === threadId) || null;
    if (!selectedThread) {
      await this.sendTextMessage({
        chatId: normalized.chatId,
        replyToMessageId: replyToMessageId || normalized.messageId,
        text: "指定线程当前不可用，请刷新后重试。",
      });
      return;
    }

    const resolvedWorkspaceRoot = selectedThread.cwd || workspaceRoot;
    this.sessionStore.setActiveWorkspaceRoot(bindingKey, resolvedWorkspaceRoot);
    this.sessionStore.setThreadIdForWorkspace(bindingKey, resolvedWorkspaceRoot, threadId, {
      workspaceId: normalized.workspaceId,
      chatId: normalized.chatId,
      threadKey: normalized.threadKey,
      senderId: normalized.senderId,
    });
    this.resumedThreadIds.delete(threadId);
    await this.ensureThreadResumed(threadId);
    await this.showStatusPanel(normalized, { replyToMessageId: replyToMessageId || normalized.messageId });
  }

  async handleStopCommand(normalized) {
    const bindingKey = this.sessionStore.buildBindingKey(normalized);
    const workspaceRoot = this.resolveWorkspaceRootForBinding(bindingKey);
    const threadId = workspaceRoot ? this.resolveThreadIdForBinding(bindingKey, workspaceRoot) : null;
    const turnId = threadId ? this.activeTurnIdByThreadId.get(threadId) || null : null;

    if (!threadId) {
      await this.sendTextMessage({
        chatId: normalized.chatId,
        replyToMessageId: normalized.messageId,
        text: "当前会话还没有可停止的运行任务。",
      });
      return;
    }

    try {
      await this.codex.sendRequest("turn/cancel", {
        threadId,
        turnId,
      });
      await this.sendTextMessage({
        chatId: normalized.chatId,
        replyToMessageId: normalized.messageId,
        text: "已发送停止请求。",
      });
    } catch (error) {
      await this.sendTextMessage({
        chatId: normalized.chatId,
        replyToMessageId: normalized.messageId,
        text: `停止失败: ${error.message}`,
      });
    }
  }

  async handleApprovalCommand(normalized) {
    const bindingKey = this.sessionStore.buildBindingKey(normalized);
    const workspaceRoot = this.resolveWorkspaceRootForBinding(bindingKey);
    const threadId = workspaceRoot ? this.resolveThreadIdForBinding(bindingKey, workspaceRoot) : null;
    const approval = threadId ? this.pendingApprovalByThreadId.get(threadId) || null : null;

    if (!threadId || !approval) {
      await this.sendTextMessage({
        chatId: normalized.chatId,
        replyToMessageId: normalized.messageId,
        text: "当前没有待处理的授权请求。",
      });
      return;
    }

    const decision = resolveApprovalDecision(normalized.command, approval.method, normalized.text);
    try {
      await this.codex.sendResponse(approval.requestId, decision);
      await this.markApprovalResolved(threadId, normalized.command === "approve" ? "approved" : "rejected");
      await this.sendTextMessage({
        chatId: normalized.chatId,
        replyToMessageId: normalized.messageId,
        text: normalized.command === "approve" ? "已批准本次请求。" : "已拒绝本次请求。",
      });
    } catch (error) {
      await this.sendTextMessage({
        chatId: normalized.chatId,
        replyToMessageId: normalized.messageId,
        text: `处理授权失败: ${error.message}`,
      });
    }
  }

  handleCodexMessage(message) {
    if (typeof message?.method === "string") {
      console.log(`[codex-im] codex event ${message.method}`);
    }
    trackRunningTurn(this.activeTurnIdByThreadId, message);
    trackPendingApproval(this.pendingApprovalByThreadId, message);
    trackRunKeyState(this.currentRunKeyByThreadId, this.activeTurnIdByThreadId, message);
    const outbound = mapCodexMessageToImEvent(message);
    if (!outbound) {
      return;
    }

    const threadId = outbound.payload?.threadId || "";
    if (!outbound.payload.turnId) {
      outbound.payload.turnId = this.activeTurnIdByThreadId.get(threadId) || "";
    }
    const context = this.pendingChatContextByThreadId.get(threadId);
    if (context) {
      outbound.payload.chatId = context.chatId;
      outbound.payload.threadKey = context.threadKey;
    }

    if (eventShouldClearPendingReaction(outbound.type)) {
      this.clearPendingReactionForThread(threadId).catch((error) => {
        console.error(`[codex-im] failed to clear pending reaction: ${error.message}`);
      });
    }

    this.deliverToFeishu(outbound).catch((error) => {
      console.error(`[codex-im] failed to deliver Feishu message: ${error.message}`);
    });
  }

  async deliverToFeishu(event) {
    if (event.type === "im.agent_reply") {
      await this.upsertAssistantReplyCard({
        threadId: event.payload.threadId,
        turnId: event.payload.turnId,
        chatId: event.payload.chatId,
        text: event.payload.text,
        state: "streaming",
      });
      return;
    }

    if (event.type === "im.run_state") {
      if (event.payload.state === "streaming") {
        await this.upsertAssistantReplyCard({
          threadId: event.payload.threadId,
          turnId: event.payload.turnId,
          chatId: event.payload.chatId,
          state: "streaming",
        });
      } else if (event.payload.state === "completed") {
        await this.upsertAssistantReplyCard({
          threadId: event.payload.threadId,
          turnId: event.payload.turnId,
          chatId: event.payload.chatId,
          state: "completed",
        });
      } else if (event.payload.state === "failed") {
        await this.upsertAssistantReplyCard({
          threadId: event.payload.threadId,
          turnId: event.payload.turnId,
          chatId: event.payload.chatId,
          state: "failed",
        });
      }
      return;
    }

    if (event.type === "im.approval_request") {
      const approval = this.pendingApprovalByThreadId.get(event.payload.threadId);
      if (!approval) {
        return;
      }
      approval.chatId = event.payload.chatId || approval.chatId || "";
      approval.replyToMessageId = this.pendingChatContextByThreadId.get(event.payload.threadId)?.messageId || approval.replyToMessageId || "";
      const response = await this.sendInteractiveApprovalCard({
        chatId: approval.chatId,
        approval,
        replyToMessageId: approval.replyToMessageId || "",
      });
      const messageId = extractCreatedMessageId(response);
      if (messageId) {
        approval.cardMessageId = messageId;
      }
    }
  }

  async sendTextMessage({ chatId, text, replyToMessageId = "", replyInThread = false }) {
    if (!chatId || !text) {
      return null;
    }

    if (replyToMessageId) {
      const replyMessage = resolveReplyMessageMethod(this.client);
      return replyMessage.call(this.client.im?.v1?.message || this.client.im?.message || this.client, {
        path: {
          message_id: normalizeMessageId(replyToMessageId),
        },
        data: {
          content: JSON.stringify({ text }),
          msg_type: "text",
          reply_in_thread: replyInThread,
        },
      });
    }

    const createMessage = resolveCreateMessageMethod(this.client);
    return createMessage.call(this.client.im?.v1?.message || this.client.im?.message || this.client, {
      params: {
        receive_id_type: "chat_id",
      },
      data: {
        receive_id: chatId,
        content: JSON.stringify({ text }),
        msg_type: "text",
      },
    });
  }

  async sendInfoCardMessage({ chatId, text, replyToMessageId = "", replyInThread = false }) {
    if (!chatId || !text) {
      return null;
    }

    return this.sendInteractiveCard({
      chatId,
      replyToMessageId,
      replyInThread,
      card: buildInfoCard(text),
    });
  }

  async sendInteractiveApprovalCard({ chatId, approval, replyToMessageId = "", replyInThread = false }) {
    if (!chatId || !approval) {
      return null;
    }

    return this.sendInteractiveCard({
      chatId,
      replyToMessageId,
      replyInThread,
      card: buildApprovalCard(approval),
    });
  }

  async updateInteractiveCard({ messageId, approval }) {
    if (!messageId || !approval) {
      return null;
    }

    const patchMessage = resolvePatchMessageMethod(this.client);
    return patchMessage.call(this.client.im?.v1?.message || this.client.im?.message || this.client, {
      path: {
        message_id: messageId,
      },
      data: {
        content: JSON.stringify(buildApprovalResolvedCard(approval)),
      },
    });
  }

  async sendInteractiveCard({ chatId, card, replyToMessageId = "", replyInThread = false }) {
    if (!chatId || !card) {
      return null;
    }

    if (replyToMessageId) {
      const replyMessage = resolveReplyMessageMethod(this.client);
      return replyMessage.call(this.client.im?.v1?.message || this.client.im?.message || this.client, {
        path: {
          message_id: normalizeMessageId(replyToMessageId),
        },
        data: {
          msg_type: "interactive",
          content: JSON.stringify(card),
          reply_in_thread: replyInThread,
        },
      });
    }

    const createMessage = resolveCreateMessageMethod(this.client);
    return createMessage.call(this.client.im?.v1?.message || this.client.im?.message || this.client, {
      params: {
        receive_id_type: "chat_id",
      },
      data: {
        receive_id: chatId,
        msg_type: "interactive",
        content: JSON.stringify(card),
      },
    });
  }

  async patchInteractiveCard({ messageId, card }) {
    if (!messageId || !card) {
      return null;
    }

    const patchMessage = resolvePatchMessageMethod(this.client);
    return patchMessage.call(this.client.im?.v1?.message || this.client.im?.message || this.client, {
      path: {
        message_id: messageId,
      },
      data: {
        content: JSON.stringify(card),
      },
    });
  }

  async handleCardAction(data) {
    try {
      console.log("[codex-im] card callback raw:", JSON.stringify(data));
    } catch {
      console.log("[codex-im] card callback raw: <unserializable>");
    }

    const action = extractCardAction(data);
    console.log("[codex-im] card callback parsed action:", action);
    if (!action) {
      return buildCardToast("无法识别卡片操作。");
    }

    if (action.kind === "approval") {
      const approval = this.pendingApprovalByThreadId.get(action.threadId);
      if (!approval || String(approval.requestId) !== String(action.requestId)) {
        return buildCardToast("该授权请求已失效。");
      }

      const chatId = approval.chatId || extractCardChatId(data);
      try {
        const resolution = action.decision === "approve" ? "approved" : "rejected";
        const resolvedApproval = {
          ...approval,
          resolution,
        };
        const decision = resolveApprovalDecision(
          action.decision,
          approval.method,
          action.scope === "session" ? "/codex approve session" : "/codex approve"
        );
        await this.codex.sendResponse(approval.requestId, decision);
        await this.markApprovalResolved(action.threadId, resolution);
        if (chatId) {
          await this.sendTextMessage({
            chatId,
            replyToMessageId: approval.cardMessageId || approval.replyToMessageId || "",
            text: action.decision === "approve" ? "已批准本次请求。" : "已拒绝本次请求。",
          });
        }
        return buildCardResponse({
          toast: action.decision === "approve" ? "已批准" : "已拒绝",
          card: buildApprovalResolvedCard(resolvedApproval),
        });
      } catch (error) {
        return buildCardToast(`处理失败: ${error.message}`);
      }
    }

    const normalized = normalizeCardActionContext(data, this.config);
    if (!normalized) {
      return buildCardToast("无法解析当前卡片上下文。");
    }

    try {
      if (action.kind === "panel") {
        if (action.action === "open_threads") {
          await this.showThreadPicker(normalized, { replyToMessageId: normalized.messageId });
          return buildCardToast("已打开线程列表");
        }
        if (action.action === "new_thread") {
          await this.handleNewCommand(normalized);
          return buildCardToast("已创建新线程");
        }
        if (action.action === "show_messages") {
          await this.handleMessageCommand(normalized);
          return buildCardToast("已显示最近消息");
        }
        if (action.action === "stop") {
          await this.handleStopCommand(normalized);
          return buildCardToast("已发送停止请求");
        }
        if (action.action === "status") {
          await this.showStatusPanel(normalized, { replyToMessageId: normalized.messageId });
          return buildCardToast("已刷新状态");
        }
      }

      if (action.kind === "thread") {
        if (action.action === "switch") {
          await this.switchThreadById(normalized, action.threadId, { replyToMessageId: normalized.messageId });
          return buildCardToast("已切换线程");
        }
        if (action.action === "messages") {
          await this.switchThreadById(normalized, action.threadId, { replyToMessageId: normalized.messageId });
          await this.handleMessageCommand(normalized);
          return buildCardToast("已显示线程消息");
        }
      }
    } catch (error) {
      return buildCardToast(`处理失败: ${error.message}`);
    }

    return buildCardToast("未支持的卡片操作。");
  }

  async markApprovalResolved(threadId, resolution) {
    const approval = this.pendingApprovalByThreadId.get(threadId);
    if (!approval) {
      return;
    }

    approval.resolution = resolution;
    this.pendingApprovalByThreadId.delete(threadId);

    if (approval.cardMessageId) {
      try {
        await this.updateInteractiveCard({
          messageId: approval.cardMessageId,
          approval,
        });
      } catch (error) {
        console.error(`[codex-im] failed to update approval card: ${error.message}`);
      }
    }
  }

  async upsertAssistantReplyCard({ threadId, turnId, chatId, text, state }) {
    if (!threadId || !chatId) {
      return;
    }

    const resolvedTurnId = turnId
      || this.activeTurnIdByThreadId.get(threadId)
      || extractTurnIdFromRunKey(this.currentRunKeyByThreadId.get(threadId) || "")
      || "";
    const runKey = buildRunKey(threadId, resolvedTurnId);
    const existing = this.replyCardByRunKey.get(runKey) || {
      messageId: "",
      chatId,
      replyToMessageId: "",
      text: "",
      state: "streaming",
      threadId,
      turnId: resolvedTurnId,
    };

    if (typeof text === "string" && text.trim()) {
      existing.text = mergeReplyText(existing.text, text.trim());
    }
    existing.chatId = chatId;
    existing.replyToMessageId = this.pendingChatContextByThreadId.get(threadId)?.messageId || existing.replyToMessageId || "";
    if (state) {
      existing.state = state;
    }
    if (resolvedTurnId) {
      existing.turnId = resolvedTurnId;
    }

    this.replyCardByRunKey.set(runKey, existing);
    this.currentRunKeyByThreadId.set(threadId, runKey);

    const shouldFlushImmediately = existing.state === "completed"
      || existing.state === "failed"
      || (!existing.messageId && typeof existing.text === "string" && existing.text.trim());
    await this.scheduleReplyCardFlush(runKey, { immediate: shouldFlushImmediately });
  }

  async scheduleReplyCardFlush(runKey, { immediate = false } = {}) {
    const entry = this.replyCardByRunKey.get(runKey);
    if (!entry) {
      return;
    }

    if (immediate) {
      this.clearReplyFlushTimer(runKey);
      await this.flushReplyCard(runKey);
      return;
    }

    if (this.replyFlushTimersByRunKey.has(runKey)) {
      return;
    }

    const timer = setTimeout(() => {
      this.replyFlushTimersByRunKey.delete(runKey);
      this.flushReplyCard(runKey).catch((error) => {
        console.error(`[codex-im] failed to flush reply card: ${error.message}`);
      });
    }, 300);
    this.replyFlushTimersByRunKey.set(runKey, timer);
  }

  clearReplyFlushTimer(runKey) {
    const timer = this.replyFlushTimersByRunKey.get(runKey);
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    this.replyFlushTimersByRunKey.delete(runKey);
  }

  async flushReplyCard(runKey) {
    const entry = this.replyCardByRunKey.get(runKey);
    if (!entry) {
      return;
    }

    const card = buildAssistantReplyCard({
      text: entry.text,
      state: entry.state,
    });

    if (!entry.messageId) {
      const response = await this.sendInteractiveCard({
        chatId: entry.chatId,
        card,
        replyToMessageId: entry.replyToMessageId,
      });
      entry.messageId = extractCreatedMessageId(response);
      if (!entry.messageId) {
        return;
      }
      this.replyCardByRunKey.set(runKey, entry);
      return;
    }

    await this.patchInteractiveCard({
      messageId: entry.messageId,
      card,
    });
  }

  async addPendingReaction(bindingKey, messageId) {
    if (!bindingKey || !messageId) {
      return;
    }

    await this.clearPendingReactionForBinding(bindingKey);

    const reaction = await this.createReaction({
      messageId,
      emojiType: "Typing",
    });
    this.pendingReactionByBindingKey.set(bindingKey, {
      messageId,
      reactionId: reaction.reactionId,
    });
  }

  movePendingReactionToThread(bindingKey, threadId) {
    if (!bindingKey || !threadId) {
      return;
    }

    const pending = this.pendingReactionByBindingKey.get(bindingKey);
    if (!pending) {
      return;
    }
    this.pendingReactionByBindingKey.delete(bindingKey);
    this.pendingReactionByThreadId.set(threadId, pending);
  }

  async clearPendingReactionForBinding(bindingKey) {
    const pending = this.pendingReactionByBindingKey.get(bindingKey);
    if (!pending) {
      return;
    }
    this.pendingReactionByBindingKey.delete(bindingKey);
    await this.deleteReaction(pending);
  }

  async clearPendingReactionForThread(threadId) {
    if (!threadId) {
      return;
    }
    const pending = this.pendingReactionByThreadId.get(threadId);
    if (!pending) {
      return;
    }
    this.pendingReactionByThreadId.delete(threadId);
    await this.deleteReaction(pending);
  }

  async createReaction({ messageId, emojiType }) {
    const createReaction = resolveCreateReactionMethod(this.client);
    const response = await createReaction.call(
      this.client.im?.v1?.messageReaction || this.client.im?.messageReaction || this.client,
      {
        path: {
          message_id: messageId,
        },
        data: {
          reaction_type: {
            emoji_type: emojiType,
          },
        },
      }
    );

    const reactionId = response?.data?.reaction_id || "";
    if (!reactionId) {
      throw new Error("Failed to add reaction: no reaction_id returned");
    }
    return { reactionId };
  }

  async deleteReaction({ messageId, reactionId }) {
    if (!messageId || !reactionId) {
      return;
    }

    const deleteReaction = resolveDeleteReactionMethod(this.client);
    await deleteReaction.call(
      this.client.im?.v1?.messageReaction || this.client.im?.messageReaction || this.client,
      {
        path: {
          message_id: messageId,
          reaction_id: reactionId,
        },
      }
    );
  }
}

function normalizeFeishuTextEvent(event, config) {
  const message = event?.message || {};
  const sender = event?.sender || {};
  if (message.message_type !== "text") {
    return null;
  }

  const text = parseFeishuMessageText(message.content);
  if (!text) {
    return null;
  }

  const command = parseCommand(text, config.feishuBotName);

  return {
    provider: "feishu",
    workspaceId: config.defaultWorkspaceId,
    chatId: message.chat_id || "",
    threadKey: message.root_id || "",
    senderId: sender?.sender_id?.open_id || sender?.sender_id?.user_id || "",
    messageId: message.message_id || "",
    text,
    command,
    receivedAt: new Date().toISOString(),
  };
}

function extractThreadId(response) {
  return response?.result?.threadId
    || response?.result?.thread?.id
    || response?.params?.threadId
    || null;
}

function mapCodexMessageToImEvent(message) {
  const method = message?.method;
  const params = message?.params || {};
  const threadId = extractThreadIdentifier(params);
  const turnId = extractTurnIdentifier(params);

  if (isAssistantMessageMethod(method, params)) {
    const text = extractAssistantText(params);
    if (!text) {
      return null;
    }
    return {
      type: "im.agent_reply",
      payload: {
        threadId,
        turnId,
        text,
      },
    };
  }

  if (method === "turn/started" || method === "turn/start") {
    return {
      type: "im.run_state",
      payload: {
        threadId,
        turnId,
        state: "streaming",
      },
    };
  }

  if (method === "turn/completed") {
    return {
      type: "im.run_state",
      payload: {
        threadId,
        turnId,
        state: "completed",
      },
    };
  }

  if (method === "turn/failed") {
    return {
      type: "im.run_state",
      payload: {
        threadId,
        turnId,
        state: "failed",
      },
    };
  }

  if (isApprovalRequestMethod(method)) {
    return {
      type: "im.approval_request",
      payload: {
        threadId,
        reason: params.reason || "",
        command: params.command || "",
      },
    };
  }

  return null;
}

function extractAssistantText(params) {
  const eventObject = envelopeEventObject(params);
  const itemObject = params?.item && typeof params.item === "object" ? params.item : null;

  const directCandidates = [
    params?.delta,
    params?.textDelta,
    params?.text_delta,
    params?.text,
    typeof params?.message === "string" ? params.message : "",
    params?.summary,
    params?.part,
    eventObject?.delta,
    eventObject?.text,
    typeof eventObject?.message === "string" ? eventObject.message : "",
    eventObject?.summary,
    itemObject?.delta,
    itemObject?.text,
    typeof itemObject?.message === "string" ? itemObject.message : "",
    itemObject?.summary,
  ];

  for (const candidate of directCandidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  const contentObjects = [
    params?.content,
    params?.message?.content,
    itemObject?.content,
    eventObject?.content,
  ];

  for (const content of contentObjects) {
    const extracted = extractTextFromContent(content);
    if (extracted) {
      return extracted;
    }
  }

  return "";
}

function parseFeishuMessageText(rawContent) {
  try {
    const parsed = JSON.parse(rawContent || "{}");
    return typeof parsed.text === "string" ? parsed.text.trim() : "";
  } catch {
    return "";
  }
}

function parseCommand(text, botName) {
  const normalized = text.trim().toLowerCase();
  const alias = (botName || "codex").trim().toLowerCase();
  const prefixes = ["/codex ", `/@${alias} `];
  const exactPrefixes = ["/codex", `/@${alias}`];

  if (normalized === "/codex stop" || normalized === `/@${alias} stop`) {
    return "stop";
  }
  if (normalized === "/codex where" || normalized === `/@${alias} where`) {
    return "where";
  }
  if (normalized === "/codex message" || normalized === `/@${alias} message`) {
    return "inspect_message";
  }
  if (normalized === "/codex help" || normalized === `/@${alias} help`) {
    return "help";
  }
  if (normalized === "/codex workspaces" || normalized === `/@${alias} workspaces`) {
    return "workspaces";
  }
  if (normalized.startsWith("/codex use ") || normalized.startsWith(`/@${alias} use `)) {
    return "use";
  }
  if (normalized === "/codex new" || normalized === `/@${alias} new`) {
    return "new";
  }
  if (normalized.startsWith("/codex bind ") || normalized.startsWith(`/@${alias} bind `)) {
    return "bind";
  }
  if (
    normalized === "/codex approve"
    || normalized === `/@${alias} approve`
    || normalized === "/codex approve session"
    || normalized === `/@${alias} approve session`
  ) {
    return "approve";
  }
  if (normalized === "/codex reject" || normalized === `/@${alias} reject`) {
    return "reject";
  }
  if (prefixes.some((prefix) => normalized.startsWith(prefix))) {
    return "unknown_command";
  }
  if (exactPrefixes.includes(normalized)) {
    return "unknown_command";
  }
  if (text.trim()) {
    return "message";
  }

  return "";
}

function resolveCreateMessageMethod(client) {
  const fn = client?.im?.v1?.message?.create || client?.im?.message?.create;
  if (typeof fn !== "function") {
    throw new Error("Unsupported Feishu SDK shape: missing message.create");
  }
  return fn;
}

function resolveReplyMessageMethod(client) {
  const fn = client?.im?.v1?.message?.reply || client?.im?.message?.reply;
  if (typeof fn !== "function") {
    throw new Error("Unsupported Feishu SDK shape: missing message.reply");
  }
  return fn;
}

function resolvePatchMessageMethod(client) {
  const fn = client?.im?.v1?.message?.patch || client?.im?.message?.patch;
  if (typeof fn !== "function") {
    throw new Error("Unsupported Feishu SDK shape: missing message.patch");
  }
  return fn;
}

function normalizeMessageId(messageId) {
  const normalized = typeof messageId === "string" ? messageId.trim() : "";
  if (!normalized) {
    return "";
  }
  return normalized.split(":")[0];
}

function isAssistantMessageMethod(method, params) {
  if (method === "item/agentMessage/delta"
    || method === "codex/event/agent_message_content_delta"
    || method === "codex/event/agent_message_delta"
    || method === "codex/event/agent_message"
    || method === "agent/message") {
    return true;
  }

  if (method === "message/created" || method === "item/completed" || method === "codex/event/item_completed") {
    return looksLikeAssistantPayload(params);
  }

  return false;
}

function looksLikeAssistantPayload(params) {
  const eventObject = envelopeEventObject(params);
  const itemObject = params?.item && typeof params.item === "object" ? params.item : null;
  const candidates = [
    params?.type,
    params?.item?.type,
    params?.role,
    params?.source,
    params?.author,
    itemObject?.type,
    itemObject?.role,
    itemObject?.source,
    itemObject?.author,
    eventObject?.type,
    eventObject?.role,
    eventObject?.source,
    eventObject?.author,
    eventObject?.item?.type,
    eventObject?.item?.role,
    eventObject?.item?.source,
    eventObject?.item?.author,
  ]
    .map((value) => (typeof value === "string" ? value.trim().toLowerCase() : ""))
    .filter(Boolean);

  if (candidates.some((value) => value.includes("user"))) {
    return false;
  }

  return (
    candidates.some((value) => value.includes("assistant") || value.includes("agent"))
  );
}

function resolveCreateReactionMethod(client) {
  const fn = client?.im?.v1?.messageReaction?.create || client?.im?.messageReaction?.create;
  if (typeof fn !== "function") {
    throw new Error("Unsupported Feishu SDK shape: missing messageReaction.create");
  }
  return fn;
}

function resolveDeleteReactionMethod(client) {
  const fn = client?.im?.v1?.messageReaction?.delete || client?.im?.messageReaction?.delete;
  if (typeof fn !== "function") {
    throw new Error("Unsupported Feishu SDK shape: missing messageReaction.delete");
  }
  return fn;
}

function trackRunningTurn(activeTurnIdByThreadId, message) {
  const method = message?.method;
  const params = message?.params || {};
  const threadId = params.threadId || params.thread_id || params.turn?.threadId || params.turn?.thread_id;
  const turnId = params.turnId || params.turn_id || params.turn?.id;

  if (!threadId) {
    return;
  }

  if ((method === "turn/started" || method === "turn/start") && turnId) {
    activeTurnIdByThreadId.set(threadId, turnId);
    return;
  }

  if (method === "turn/completed" || method === "turn/failed" || method === "turn/cancelled") {
    activeTurnIdByThreadId.delete(threadId);
  }
}

function trackPendingApproval(pendingApprovalByThreadId, message) {
  const method = message?.method;
  const params = message?.params || {};
  const threadId = params.threadId || params.thread_id || "";

  if (isApprovalRequestMethod(method) && threadId && message?.id != null) {
    pendingApprovalByThreadId.set(threadId, {
      requestId: message.id,
      method,
      threadId,
      reason: params.reason || "",
      command: params.command || "",
      chatId: "",
      replyToMessageId: "",
      resolution: "",
      cardMessageId: "",
    });
    return;
  }

  if (method === "turn/completed" || method === "turn/failed" || method === "turn/cancelled") {
    pendingApprovalByThreadId.delete(threadId);
  }
}

function trackRunKeyState(currentRunKeyByThreadId, activeTurnIdByThreadId, message) {
  const method = message?.method;
  const params = message?.params || {};
  const threadId = params.threadId || params.thread_id || params.turn?.threadId || params.turn?.thread_id || "";
  const turnId = params.turnId || params.turn_id || params.turn?.id || activeTurnIdByThreadId.get(threadId) || "";
  if (!threadId) {
    return;
  }

  if ((method === "turn/started" || method === "turn/start") && turnId) {
    currentRunKeyByThreadId.set(threadId, buildRunKey(threadId, turnId));
    return;
  }

  if (method === "turn/completed" || method === "turn/failed" || method === "turn/cancelled") {
    if (turnId) {
      currentRunKeyByThreadId.set(threadId, buildRunKey(threadId, turnId));
    }
  }
}

function isApprovalRequestMethod(method) {
  if (typeof method !== "string" || !method) {
    return false;
  }

  return (
    method === "item/commandExecution/requestApproval"
    || method === "item/fileChange/requestApproval"
    || method.endsWith("requestApproval")
    || method === "approval/requested"
  );
}

function resolveApprovalDecision(command, method, rawText) {
  if (command !== "approve") {
    return "decline";
  }

  const normalizedMethod = typeof method === "string" ? method.trim() : "";
  const normalizedText = typeof rawText === "string" ? rawText.trim().toLowerCase() : "";
  const isCommandApproval = normalizedMethod === "item/commandExecution/requestApproval"
    || normalizedMethod === "item/command_execution/request_approval";
  const wantsSession = normalizedText === "/codex approve session"
    || normalizedText.endsWith(" approve session");

  if (isCommandApproval && wantsSession) {
    return "acceptForSession";
  }

  return "accept";
}

function buildApprovalCard(approval) {
  const requestType = approval?.method && approval.method.includes("command") ? "命令执行" : "敏感操作";
  return {
    schema: "2.0",
    config: {
      wide_screen_mode: true,
      enable_forward: true,
      update_multi: true,
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: [
            "## Codex 请求授权",
            `**请求类型**：${requestType}`,
            approval.reason ? `**原因**：${escapeLarkMd(approval.reason)}` : "",
            approval.command ? `**将执行的内容**：\n\`\`\`\n${approval.command}\n\`\`\`` : "",
            "**处理方式**：",
            "- 本次允许：只放行这一次",
            "- 本会话允许：当前会话后续同类请求继续放行",
            "- 拒绝：本次不执行",
          ].filter(Boolean).join("\n\n"),
        },
        {
          tag: "button",
          text: { tag: "plain_text", content: "本次允许" },
          type: "primary",
          value: {
            kind: "approval",
            decision: "approve",
            scope: "once",
            requestId: approval.requestId,
            threadId: approval.threadId,
          },
        },
        {
          tag: "button",
          text: { tag: "plain_text", content: "本会话允许" },
          value: {
            kind: "approval",
            decision: "approve",
            scope: "session",
            requestId: approval.requestId,
            threadId: approval.threadId,
          },
        },
        {
          tag: "button",
          text: { tag: "plain_text", content: "拒绝" },
          type: "danger",
          value: {
            kind: "approval",
            decision: "reject",
            scope: "once",
            requestId: approval.requestId,
            threadId: approval.threadId,
          },
        },
      ],
    },
  };
}

function buildAssistantReplyCard({ text, state }) {
  const normalizedState = state || "streaming";
  const content = typeof text === "string" && text.trim()
    ? text.trim()
    : normalizedState === "failed"
      ? "执行失败"
      : "思考中";

  return {
    schema: "2.0",
    config: {
      wide_screen_mode: true,
      update_multi: true,
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: escapeCardMarkdown(content),
        },
      ],
    },
  };
}

function buildInfoCard(text) {
  return {
    schema: "2.0",
    config: {
      wide_screen_mode: true,
      update_multi: true,
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: escapeCardMarkdown(String(text || "").trim()),
        },
      ],
    },
  };
}

function buildStatusPanelCard({ workspaceRoot, threadId, currentThread, recentThreads, status }) {
  const elements = [
    {
      tag: "markdown",
      content: [
        "## 项目状态",
        `**当前项目**：\`${escapeCardMarkdown(workspaceRoot)}\``,
        `**当前线程**：${threadId ? formatThreadLabel(currentThread || { id: threadId }) : "未创建"}`,
        `**当前状态**：${status?.label || "空闲"}`,
      ].join("\n\n"),
    },
    {
      tag: "button",
      text: { tag: "plain_text", content: "切换线程" },
      type: "primary",
      value: buildPanelActionValue("open_threads"),
    },
    {
      tag: "button",
      text: { tag: "plain_text", content: "新建线程" },
      value: buildPanelActionValue("new_thread"),
    },
    {
      tag: "button",
      text: { tag: "plain_text", content: "最近消息" },
      value: buildPanelActionValue("show_messages"),
    },
    {
      tag: "button",
      text: { tag: "plain_text", content: "停止任务" },
      type: "danger",
      value: buildPanelActionValue("stop"),
    },
    { tag: "hr" },
  ];

  if (recentThreads?.length) {
    elements.push({
      tag: "markdown",
      content: `**最近线程**（${recentThreads.length}）`,
      text_size: "normal",
    });
    elements.push({
      tag: "markdown",
      content: recentThreads
        .map((thread, index) => `${index + 1}. ${formatThreadLabel(thread)}\n${summarizeThreadPreview(thread)}`)
        .join("\n\n"),
      text_size: "notation",
    });
  } else {
    elements.push({
      tag: "markdown",
      content: "**最近线程**\n\n暂无历史线程",
      text_size: "normal",
    });
  }

  return {
    schema: "2.0",
    config: {
      wide_screen_mode: true,
      update_multi: true,
    },
    body: {
      elements,
    },
  };
}

function buildThreadPickerCard({ workspaceRoot, threads, currentThreadId }) {
  const elements = [
    {
      tag: "markdown",
      content: `## 线程列表\n\n**当前项目**：\`${escapeCardMarkdown(workspaceRoot)}\``,
    },
  ];

  threads.slice(0, 8).forEach((thread, index) => {
    if (index > 0) {
      elements.push({ tag: "hr" });
    }
    const isCurrent = thread.id === currentThreadId;
    elements.push({
      tag: "markdown",
      content: [
        `${isCurrent ? "**当前线程**" : "**历史线程**"}${isCurrent ? " · `当前`" : ""}`,
        `${formatThreadLabel(thread)}`,
        summarizeThreadPreview(thread),
      ].filter(Boolean).join("\n\n"),
      text_size: isCurrent ? "normal" : "notation",
    });
    elements.push({
      tag: "button",
      text: { tag: "plain_text", content: isCurrent ? "继续这个线程" : "继续这个线程" },
      type: isCurrent ? "default" : "primary",
      value: buildThreadActionValue("switch", thread.id),
    });
    elements.push({
      tag: "button",
      text: { tag: "plain_text", content: "查看最近消息" },
      value: buildThreadActionValue("messages", thread.id),
    });
  });

  elements.push(
    { tag: "hr" },
    {
      tag: "button",
      text: { tag: "plain_text", content: "新建线程" },
      value: buildPanelActionValue("new_thread"),
    },
    {
      tag: "button",
      text: { tag: "plain_text", content: "返回状态面板" },
      value: buildPanelActionValue("status"),
    }
  );

  return {
    schema: "2.0",
    config: {
      wide_screen_mode: true,
      update_multi: true,
    },
    body: {
      elements,
    },
  };
}

function buildWorkspacesCard({ items, runtimeThreadsByWorkspaceRoot }) {
  const elements = [
    {
      tag: "markdown",
      content: "**工作目录**",
    },
  ];

  items.forEach((item, index) => {
    const runtimeThreads = runtimeThreadsByWorkspaceRoot.get(item.workspaceRoot) || [];
    const latestThread = runtimeThreads[0] || null;
    const currentThread = runtimeThreads.find((thread) => thread.id === item.currentThreadId) || null;
    const historicalThreads = runtimeThreads.filter((thread) => thread.id !== item.currentThreadId);

    if (index > 0) {
      elements.push({
        tag: "hr",
      });
    }

    elements.push({
      tag: "markdown",
      content: item.isActive ? "**当前目录** · `当前`" : "**已记录目录**",
      text_size: "normal",
    });

    elements.push({
      tag: "markdown",
      content: `\`${escapeCardMarkdown(item.workspaceRoot)}\``,
      text_size: "notation",
    });

    if (item.currentThreadId && currentThread) {
      elements.push({
        tag: "markdown",
        content: `当前线程：${formatThreadLabel(currentThread)}`,
        text_size: "notation",
      });
    } else if (item.currentThreadId) {
      elements.push({
        tag: "markdown",
        content: `当前线程：\`${escapeCardMarkdown(item.currentThreadId)}\``,
        text_size: "notation",
      });
    } else if (latestThread) {
      elements.push({
        tag: "markdown",
        content: `默认复用：${formatThreadLabel(latestThread)}`,
        text_size: "notation",
      });
    } else {
      elements.push({
        tag: "markdown",
        content: "当前线程：未创建",
        text_size: "notation",
      });
    }

    if (historicalThreads.length) {
      elements.push({
        tag: "markdown",
        content: `历史线程（${historicalThreads.length}）`,
        text_size: "notation",
      });
      elements.push({
        tag: "markdown",
        content: historicalThreads
          .slice(0, 6)
          .map((thread) => `- ${formatThreadLabel(thread)}`)
          .join("\n"),
        text_size: "notation",
      });
    } else {
      elements.push({
        tag: "markdown",
        content: "历史线程：空",
        text_size: "notation",
      });
    }
  });

  return {
    schema: "2.0",
    config: {
      wide_screen_mode: true,
      update_multi: true,
    },
    body: {
      elements,
    },
  };
}

function buildHelpCardText() {
  const sections = [
    [
      "**直接对话**",
      "绑定目录后，直接发普通消息即可继续当前线程。",
    ],
    [
      "**绑定工作目录**",
      "`/codex bind /绝对路径`",
      "把当前飞书会话绑定到一个本地项目目录。",
    ],
    [
      "**查看当前状态**",
      "`/codex where`",
      "查看当前绑定的工作目录和正在使用的线程。",
    ],
    [
      "**查看最近消息**",
      "`/codex message`",
      "查看当前线程最近几轮对话。",
    ],
    [
      "**查看可用历史线程**",
      "`/codex workspaces`",
      "查看当前目录下 Codex runtime 可见的历史线程。",
    ],
    [
      "**切换到指定线程**",
      "`/codex use <threadId>`",
      "切换到某条历史线程，并回显最近几轮对话。",
    ],
    [
      "**新建线程**",
      "`/codex new`",
      "在当前工作目录下创建一条新线程并切换过去。",
    ],
    [
      "**中断运行**",
      "`/codex stop`",
      "停止当前线程里正在执行的任务。",
    ],
    [
      "**审批命令**",
      "`/codex approve`\n`/codex approve session`\n`/codex reject`",
      "用于处理 Codex 发起的审批请求。",
    ],
  ];

  return [
    "**Codex IM 使用说明**",
    sections.map((section) => section.join("\n")).join("\n\n"),
  ].join("\n\n");
}

function buildThreadMessagesSummary({ workspaceRoot, thread, recentMessages }) {
  const sections = [
    "最近对话",
    `工作目录：\`${workspaceRoot}\``,
    `当前线程：${formatThreadLabel(thread)}`,
    "***",
    "**对话记录**",
  ];

  if (!Array.isArray(recentMessages) || recentMessages.length === 0) {
    sections.push("最近对话：空");
    return sections.join("\n\n");
  }

  const normalizedTranscript = recentMessages.map((message) => (
    message.role === "user"
      ? `😄 **你**\n> ${escapeCardMarkdown(message.text).replace(/\n/g, "\n> ")}`
      : `🤖 <font color='blue'>**Codex**</font>\n> ${escapeCardMarkdown(message.text).replace(/\n/g, "\n> ")}`
  ));
  sections.push(normalizedTranscript.join("\n\n"));
  return sections.join("\n\n");
}

function buildRunKey(threadId, turnId) {
  return `${threadId}:${turnId || "pending"}`;
}

function extractTurnIdFromRunKey(runKey) {
  if (!runKey || !runKey.includes(":")) {
    return "";
  }
  return runKey.slice(runKey.indexOf(":") + 1);
}

function mergeReplyText(previousText, nextText) {
  if (!previousText) {
    return nextText;
  }
  if (!nextText) {
    return previousText;
  }
  if (nextText.startsWith(previousText)) {
    return nextText;
  }
  if (previousText.startsWith(nextText)) {
    return previousText;
  }
  return nextText;
}


function buildApprovalResolvedCard(approval) {
  const resolutionLabel = approval.resolution === "approved" ? "已批准" : "已拒绝";
  const colorText = approval.resolution === "approved" ? "green" : "red";
  return {
    schema: "2.0",
    config: {
      wide_screen_mode: true,
      enable_forward: true,
      update_multi: true,
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: [
            `## Codex 请求授权 <font color='${colorText}'>${resolutionLabel}</font>`,
            approval.reason ? `**原因**: ${escapeLarkMd(approval.reason)}` : "",
            approval.command ? `**命令**:\n\`\`\`\n${approval.command}\n\`\`\`` : "",
            `处理结果: ${resolutionLabel}`,
          ].filter(Boolean).join("\n\n"),
        },
      ],
    },
  };
}

function extractCreatedMessageId(response) {
  return response?.data?.message_id || response?.data?.message?.message_id || "";
}

function extractThreadsFromListResponse(response) {
  const candidates = [
    response?.result?.data,
    response?.result?.threads,
    response?.result?.items,
    response?.data,
    response?.threads,
    response?.items,
  ];

  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) {
      continue;
    }

    return candidate
      .map((thread) => ({
        id: normalizeIdentifier(thread?.id || thread?.threadId || thread?.thread_id),
        cwd: normalizeWorkspacePath(thread?.cwd || thread?.thread?.cwd || ""),
        title: extractThreadDisplayName(thread),
        updatedAt: thread?.updated_at || thread?.updatedAt || 0,
      }))
      .filter((thread) => thread.id);
  }

  return [];
}

function extractThreadDisplayName(thread) {
  const candidates = [
    thread?.title,
    thread?.name,
    thread?.preview,
    thread?.thread?.title,
    thread?.thread?.name,
    thread?.thread?.preview,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  return "";
}

function extractRecentConversationFromResumeResponse(response, turnLimit = 3) {
  const turns = response?.result?.thread?.turns;
  if (!Array.isArray(turns) || !turns.length) {
    return [];
  }

  const recentTurns = turns.slice(-turnLimit);
  const messages = [];

  for (const turn of recentTurns) {
    const userMessage = extractResumeTurnUserInput(turn);
    if (userMessage) {
      messages.push(userMessage);
    }

    const items = Array.isArray(turn?.items) ? turn.items : [];
    for (const item of items) {
      const normalized = normalizeResumedConversationItem(item);
      if (normalized) {
        messages.push(normalized);
      }
    }
  }

  return dedupeRecentConversationMessages(messages).slice(-6);
}

function extractResumeTurnUserInput(turn) {
  if (!turn || typeof turn !== "object") {
    return null;
  }

  const text = extractTextFromContent(turn.input);
  if (!text) {
    return null;
  }

  return {
    role: "user",
    text,
  };
}

function dedupeRecentConversationMessages(messages) {
  const deduped = [];
  for (const message of messages) {
    const previous = deduped[deduped.length - 1];
    if (previous && previous.role === message.role && previous.text === message.text) {
      continue;
    }
    deduped.push(message);
  }
  return deduped;
}

function normalizeResumedConversationItem(item) {
  if (!item || typeof item !== "object") {
    return null;
  }

  const itemType = String(item.type || item.kind || "").toLowerCase();
  if (itemType === "usermessage") {
    const text = extractTextFromResumeUserMessage(item);
    return text ? { role: "user", text } : null;
  }

  if (itemType === "agentmessage") {
    const text = extractTextFromResumeAgentMessage(item);
    return text ? { role: "assistant", text } : null;
  }

  const role = String(
    item.role
      || item.author
      || item.payload?.role
      || item.payload?.author
      || item.payload?.source
      || item.source
      || ""
  ).toLowerCase();
  const contentTypes = collectResumeContentTypes(item);
  const text = extractTextFromContent(
    item.text
      || item.message
      || item.content
      || item.payload?.content
      || item.payload?.text
      || item.payload?.message
  );

  if (!text) {
    return null;
  }

  const normalizedRole = resolveResumeItemRole({ itemType, role, contentTypes });

  if (!normalizedRole) {
    return null;
  }

  return {
    role: normalizedRole,
    text,
  };
}

function collectResumeContentTypes(item) {
  const content = [];

  if (Array.isArray(item?.content)) {
    content.push(...item.content);
  }
  if (Array.isArray(item?.payload?.content)) {
    content.push(...item.payload.content);
  }

  return content
    .map((entry) => String(entry?.type || "").toLowerCase())
    .filter(Boolean);
}

function resolveResumeItemRole({ itemType, role, contentTypes }) {
  const isAssistant = (
    role.includes("assistant")
    || role.includes("agent")
    || itemType.includes("assistant")
    || itemType.includes("agent")
    || contentTypes.some((type) => (
      type.includes("output_text")
      || type.includes("assistant")
      || type.includes("agent")
    ))
  );
  if (isAssistant) {
    return "assistant";
  }

  const isUser = (
    role.includes("user")
    || itemType.includes("user")
    || contentTypes.some((type) => (
      type.includes("input_text")
      || type === "user_message"
      || type === "user"
      || type === "text"
    ))
  );
  if (isUser) {
    return "user";
  }

  if (itemType === "message") {
    return "assistant";
  }

  return "";
}

function extractTextFromResumeUserMessage(item) {
  const content = Array.isArray(item?.content) ? item.content : [];
  if (content.length) {
    const parts = [];
    for (const entry of content) {
      const entryType = String(entry?.type || "").toLowerCase();
      if (entryType === "text" && typeof entry?.text === "string" && entry.text.trim()) {
        parts.push(entry.text.trim());
        continue;
      }
      if (entryType === "skill") {
        const skillName = typeof entry?.name === "string" ? entry.name.trim() : "";
        if (skillName) {
          parts.push(`$${skillName}`);
        }
      }
    }
    const joined = parts.join(" ").trim();
    if (joined) {
      return joined;
    }
  }

  return extractTextFromContent(item?.text || item?.message || item?.payload?.text || item?.payload?.message);
}

function extractTextFromResumeAgentMessage(item) {
  return extractTextFromContent(
    item?.text
      || item?.message
      || item?.content
      || item?.payload?.text
      || item?.payload?.message
      || item?.payload?.content
  );
}

function buildThreadSwitchSummary({ workspaceRoot, thread, recentMessages }) {
  const sections = [
    "已切换到指定线程",
    `工作目录：\`${workspaceRoot}\``,
    `当前线程：${formatThreadLabel(thread)}`,
  ];

  if (!Array.isArray(recentMessages) || recentMessages.length === 0) {
    sections.push("最近对话：空");
    return sections.join("\n\n");
  }

  const transcript = recentMessages.map((message) => (
    `${message.role === "user" ? "**你**" : "**Codex**"}：${escapeCardMarkdown(message.text)}`
  ));
  sections.push(`最近对话\n\n${transcript.join("\n\n")}`);
  return sections.join("\n\n");
}

function formatThreadLabel(thread) {
  if (!thread) {
    return "";
  }

  const title = typeof thread.title === "string" ? thread.title.trim() : "";
  const id = typeof thread.id === "string" ? thread.id.trim() : "";
  if (title && id) {
    return `${title} (\`${id}\`)`;
  }
  return title || (id ? `\`${id}\`` : "");
}

function extractCardAction(data) {
  const action = data?.action || {};
  const value = action.value || {};
  if (!value.kind) {
    console.log("[codex-im] card callback action missing kind", {
      action,
      hasValue: !!action.value,
    });
    return null;
  }
  if (value.kind === "approval") {
    return {
      kind: value.kind,
      decision: value.decision,
      scope: value.scope || "once",
      requestId: value.requestId,
      threadId: value.threadId,
    };
  }
  if (value.kind === "panel") {
    return {
      kind: value.kind,
      action: value.action || "",
    };
  }
  if (value.kind === "thread") {
    return {
      kind: value.kind,
      action: value.action || "",
      threadId: value.threadId || "",
    };
  }
  return null;
}

function normalizeCardActionContext(data, config) {
  const openMessageId = data?.context?.open_message_id
    || data?.context?.openMessageId
    || data?.open_message_id
    || data?.openMessageId
    || data?.message_id
    || "card-action";
  const chatId = extractCardChatId(data);
  if (!chatId) {
    console.log("[codex-im] card callback missing chatId", {
      context_open_message_id: data?.context?.open_message_id,
      context_open_chat_id: data?.context?.open_chat_id,
      open_message_id: data?.open_message_id,
      open_chat_id: data?.open_chat_id,
      message_id: data?.message_id,
      chat_id: data?.chat_id,
    });
    return null;
  }
  return {
    provider: "feishu",
    workspaceId: config.defaultWorkspaceId,
    chatId,
    threadKey: "",
    senderId: data?.operator?.open_id || data?.operator?.operator_id?.open_id || data?.user_id || "",
    messageId: openMessageId,
    text: "",
    command: "",
    receivedAt: new Date().toISOString(),
  };
}

function buildPanelActionValue(action) {
  return {
    kind: "panel",
    action,
  };
}

function buildThreadActionValue(action, threadId) {
  return {
    kind: "thread",
    action,
    threadId,
  };
}

function summarizeThreadPreview(thread) {
  const updated = formatRelativeTimestamp(thread?.updatedAt);
  const title = thread?.title ? "点击继续该线程" : "无摘要";
  return [updated ? `更新时间：${updated}` : "", title].filter(Boolean).join("\n");
}

function formatRelativeTimestamp(value) {
  const timestamp = Number(value || 0);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return "";
  }
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - timestamp));
  if (seconds < 60) {
    return `${seconds} 秒前`;
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)} 分钟前`;
  }
  if (seconds < 86400) {
    return `${Math.floor(seconds / 3600)} 小时前`;
  }
  return `${Math.floor(seconds / 86400)} 天前`;
}

function extractCardChatId(data) {
  return data?.context?.open_chat_id
    || data?.context?.openChatId
    || data?.open_chat_id
    || data?.openChatId
    || data?.chat_id
    || "";
}

function buildCardToast(text) {
  return buildCardResponse({ toast: text });
}

function buildCardResponse({ toast, card }) {
  const response = {};
  if (toast) {
    response.toast = {
      type: "info",
      content: toast,
    };
  }
  if (card) {
    response.card = {
      type: "raw",
      data: card,
    };
  }
  return response;
}

function patchWsClientForCardCallbacks(wsClient) {
  if (!wsClient || typeof wsClient.handleEventData !== "function") {
    return;
  }

  const originalHandleEventData = wsClient.handleEventData.bind(wsClient);
  wsClient.handleEventData = (data) => {
    const headers = Array.isArray(data?.headers) ? data.headers : [];
    const messageType = headers.find((header) => header?.key === "type")?.value;
    if (messageType === "card") {
      const patchedData = {
        ...data,
        headers: headers.map((header) => (
          header?.key === "type" ? { ...header, value: "event" } : header
        )),
      };
      return originalHandleEventData(patchedData);
    }
    return originalHandleEventData(data);
  };
}

function eventShouldClearPendingReaction(eventType) {
  return eventType === "im.agent_reply" || eventType === "im.run_state";
}

function envelopeEventObject(params) {
  if (!params || typeof params !== "object") {
    return null;
  }
  if (params.msg && typeof params.msg === "object") {
    return params.msg;
  }
  if (params.event && typeof params.event === "object") {
    return params.event;
  }
  return null;
}

function extractThreadIdentifier(params) {
  const eventObject = envelopeEventObject(params);
  return normalizeIdentifier(
    params?.threadId
      || params?.thread_id
      || params?.turn?.threadId
      || params?.turn?.thread_id
      || params?.item?.threadId
      || params?.item?.thread_id
      || eventObject?.threadId
      || eventObject?.thread_id
      || eventObject?.turn?.threadId
      || eventObject?.turn?.thread_id
      || eventObject?.item?.threadId
      || eventObject?.item?.thread_id
  );
}

function extractTurnIdentifier(params) {
  const eventObject = envelopeEventObject(params);
  return normalizeIdentifier(
    params?.turnId
      || params?.turn_id
      || params?.turn?.id
      || params?.item?.turnId
      || params?.item?.turn_id
      || eventObject?.turnId
      || eventObject?.turn_id
      || eventObject?.turn?.id
      || eventObject?.item?.turnId
      || eventObject?.item?.turn_id
  );
}

function normalizeIdentifier(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function normalizeWorkspacePath(value) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return "";
  }

  const withForwardSlashes = normalized.replace(/\\/g, "/");
  if (/^[A-Za-z]:\/$/.test(withForwardSlashes)) {
    return withForwardSlashes;
  }
  if (/^[A-Za-z]:\//.test(withForwardSlashes)) {
    return withForwardSlashes.replace(/\/+$/g, "");
  }
  return withForwardSlashes.replace(/\/+$/g, "");
}

function isAbsoluteWorkspacePath(workspaceRoot) {
  const normalized = normalizeWorkspacePath(workspaceRoot);
  if (!normalized) {
    return false;
  }
  if (/^[A-Za-z]:\//.test(normalized)) {
    return true;
  }
  return path.posix.isAbsolute(normalized);
}

function pathMatchesWorkspaceRoot(candidatePath, workspaceRoot) {
  const normalizedCandidate = normalizeWorkspacePath(candidatePath);
  const normalizedWorkspaceRoot = normalizeWorkspacePath(workspaceRoot);
  if (!normalizedCandidate || !normalizedWorkspaceRoot) {
    return false;
  }
  return normalizedCandidate === normalizedWorkspaceRoot;
}

function extractTextFromContent(content) {
  if (!content) {
    return "";
  }

  if (typeof content === "string" && content.trim()) {
    return content.trim();
  }

  if (Array.isArray(content)) {
    const parts = [];
    for (const item of content) {
      const extracted = extractTextFromContent(item);
      if (extracted) {
        parts.push(extracted);
      }
    }
    return parts.join("\n").trim();
  }

  if (typeof content === "object") {
    if (typeof content.message === "string" && content.message.trim()) {
      return content.message.trim();
    }
    if (typeof content.delta === "string" && content.delta.trim()) {
      return content.delta.trim();
    }
    if (typeof content.text === "string" && content.text.trim()) {
      return content.text.trim();
    }
    if (typeof content.summary === "string" && content.summary.trim()) {
      return content.summary.trim();
    }
    if (typeof content.content === "string" && content.content.trim()) {
      return content.content.trim();
    }
    if (content.data && typeof content.data === "object") {
      const extractedFromData = extractTextFromContent(content.data);
      if (extractedFromData) {
        return extractedFromData;
      }
    }
    if (Array.isArray(content.content)) {
      return extractTextFromContent(content.content);
    }
  }

  return "";
}

function shouldRecreateThread(error) {
  const message = String(error?.message || "").toLowerCase();
  return message.includes("thread not found") || message.includes("unknown thread");
}

function escapeLarkMd(text) {
  return String(text || "").replace(/[\\`*_{}[\]()#+\-.!|>]/g, "\\$&");
}

function escapeCardMarkdown(text) {
  return String(text || "").replace(/\u0000/g, "");
}

function extractBindPath(text) {
  const trimmed = String(text || "").trim();
  const bindPrefix = "/codex bind ";
  const mentionBindMatch = trimmed.match(/^\/@[^ ]+\s+bind\s+(.+)$/i);
  if (trimmed.toLowerCase().startsWith(bindPrefix)) {
    return trimmed.slice(bindPrefix.length).trim();
  }
  if (mentionBindMatch) {
    return mentionBindMatch[1].trim();
  }
  return "";
}

function extractUseThreadId(text) {
  const trimmed = String(text || "").trim();
  const usePrefix = "/codex use ";
  const mentionUseMatch = trimmed.match(/^\/@[^ ]+\s+use\s+(.+)$/i);
  if (trimmed.toLowerCase().startsWith(usePrefix)) {
    return trimmed.slice(usePrefix.length).trim();
  }
  if (mentionUseMatch) {
    return mentionUseMatch[1].trim();
  }
  return "";
}

function isWorkspaceAllowed(workspaceRoot, allowlist) {
  if (!Array.isArray(allowlist) || allowlist.length === 0) {
    return true;
  }

  const normalizedWorkspaceRoot = normalizeWorkspacePath(workspaceRoot);
  const compareWorkspaceRoot = isWindowsStylePath(normalizedWorkspaceRoot)
    ? normalizedWorkspaceRoot.toLowerCase()
    : normalizedWorkspaceRoot;

  return allowlist.some((allowedRoot) => {
    const normalizedAllowedRoot = normalizeWorkspacePath(allowedRoot);
    const compareAllowedRoot = isWindowsStylePath(normalizedAllowedRoot)
      ? normalizedAllowedRoot.toLowerCase()
      : normalizedAllowedRoot;
    return compareWorkspaceRoot === compareAllowedRoot
      || compareWorkspaceRoot.startsWith(`${compareAllowedRoot}/`);
  });
}

function isWindowsStylePath(value) {
  return /^[A-Za-z]:\//.test(String(value || ""));
}

function maskSecret(value) {
  if (!value) {
    return "";
  }
  if (value.length <= 6) {
    return "***";
  }
  return `${value.slice(0, 3)}***${value.slice(-3)}`;
}

module.exports = { FeishuBotRuntime, normalizeFeishuTextEvent };
