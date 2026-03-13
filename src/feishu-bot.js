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

    if (await this.dispatchTextCommand(normalized)) {
      return;
    }

    const bindingKey = this.sessionStore.buildBindingKey(normalized);
    const workspaceRoot = this.resolveWorkspaceRootForBinding(bindingKey);
    if (!workspaceRoot) {
      await this.sendInfoCardMessage({
        chatId: normalized.chatId,
        replyToMessageId: normalized.messageId,
        text: "当前会话还未绑定项目。先发送 `/codex bind /绝对路径`。",
      });
      return;
    }
    const availableThreads = await this.refreshWorkspaceThreads(bindingKey, workspaceRoot, normalized);
    const selectedThreadId = this.resolveThreadIdForBinding(bindingKey, workspaceRoot);
    const threadId = selectedThreadId || availableThreads[0]?.id || null;
    if (!selectedThreadId && threadId) {
      this.sessionStore.setThreadIdForWorkspace(
        bindingKey,
        workspaceRoot,
        threadId,
        buildBindingMetadata(normalized)
      );
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
      await this.sendInfoCardMessage({
        chatId: normalized.chatId,
        replyToMessageId: normalized.messageId,
        text: `处理失败: ${error.message}`,
      });
      throw error;
    }
  }

  async dispatchTextCommand(normalized) {
    const commandHandlers = {
      stop: () => this.handleStopCommand(normalized),
      bind: () => this.handleBindCommand(normalized),
      where: () => this.handleWhereCommand(normalized),
      inspect_message: () => this.handleMessageCommand(normalized),
      help: () => this.handleHelpCommand(normalized),
      unknown_command: () => this.handleUnknownCommand(normalized),
      workspace: () => this.handleWorkspacesCommand(normalized),
      switch: () => this.handleSwitchCommand(normalized),
      remove: () => this.handleRemoveCommand(normalized),
      new: () => this.handleNewCommand(normalized),
      approve: () => this.handleApprovalCommand(normalized),
      reject: () => this.handleApprovalCommand(normalized),
    };

    const handler = commandHandlers[normalized.command];
    if (!handler) {
      return false;
    }

    await handler();
    return true;
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

    this.sessionStore.setThreadIdForWorkspace(
      bindingKey,
      workspaceRoot,
      resolvedThreadId,
      buildBindingMetadata(normalized)
    );
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
      await this.sendInfoCardMessage({
        chatId: normalized.chatId,
        replyToMessageId: normalized.messageId,
        text: "用法: `/codex bind /绝对路径`",
      });
      return;
    }

    const workspaceRoot = normalizeWorkspacePath(rawWorkspaceRoot);
    if (!isAbsoluteWorkspacePath(workspaceRoot)) {
      await this.sendInfoCardMessage({
        chatId: normalized.chatId,
        replyToMessageId: normalized.messageId,
        text: "只支持绝对路径绑定。Windows 例如 `C:\\code\\repo`，macOS/Linux 例如 `/Users/name/repo`。",
      });
      return;
    }
    if (!isWorkspaceAllowed(workspaceRoot, this.config.workspaceAllowlist)) {
      await this.sendInfoCardMessage({
        chatId: normalized.chatId,
        replyToMessageId: normalized.messageId,
        text: "该项目不在允许绑定的白名单中。",
      });
      return;
    }

    if (!fs.existsSync(workspaceRoot)) {
      await this.sendInfoCardMessage({
        chatId: normalized.chatId,
        replyToMessageId: normalized.messageId,
        text: `项目不存在: ${workspaceRoot}`,
      });
      return;
    }

    const stats = fs.statSync(workspaceRoot);
    if (!stats.isDirectory()) {
      await this.sendInfoCardMessage({
        chatId: normalized.chatId,
        replyToMessageId: normalized.messageId,
        text: `路径非法: ${workspaceRoot}`,
      });
      return;
    }

    this.sessionStore.setActiveWorkspaceRoot(bindingKey, workspaceRoot);
    await this.refreshWorkspaceThreads(bindingKey, workspaceRoot, normalized);
    const existingThreadId = this.resolveThreadIdForBinding(bindingKey, workspaceRoot);
    await this.showStatusPanel(normalized, {
      replyToMessageId: normalized.messageId,
      noticeText: existingThreadId
        ? "已切换到项目，并恢复原会话上下文。"
        : "已绑定项目。",
    });
  }

  async handleWhereCommand(normalized) {
    await this.showStatusPanel(normalized);
  }

  async showStatusPanel(normalized, { replyToMessageId, noticeText = "" } = {}) {
    const replyTarget = this.resolveReplyToMessageId(normalized, replyToMessageId);
    const { bindingKey, workspaceRoot } = this.getBindingContext(normalized);
    if (!workspaceRoot) {
      await this.sendInfoCardMessage({
        chatId: normalized.chatId,
        replyToMessageId: replyTarget,
        text: "当前会话还没有绑定项目。",
      });
      return;
    }

    const threads = await this.refreshWorkspaceThreads(bindingKey, workspaceRoot, normalized);
    const selectedThreadId = this.resolveThreadIdForBinding(bindingKey, workspaceRoot);
    const threadId = selectedThreadId || threads[0]?.id || "";
    if (!selectedThreadId && threadId) {
      this.sessionStore.setThreadIdForWorkspace(
        bindingKey,
        workspaceRoot,
        threadId,
        buildBindingMetadata(normalized)
      );
    }
    const currentThread = threads.find((thread) => thread.id === threadId) || null;
    const recentThreads = currentThread
      ? threads.filter((thread) => thread.id !== threadId).slice(0, 2)
      : threads.slice(0, 3);
    const status = this.describeWorkspaceStatus(threadId);
    await this.sendInteractiveCard({
      chatId: normalized.chatId,
      replyToMessageId: replyTarget,
      card: buildStatusPanelCard({
        workspaceRoot,
        threadId,
        currentThread,
        recentThreads,
        totalThreadCount: threads.length,
        status,
        noticeText,
      }),
    });
  }

  async handleMessageCommand(normalized) {
    const bindingKey = this.sessionStore.buildBindingKey(normalized);
    const workspaceRoot = this.resolveWorkspaceRootForBinding(bindingKey);
    if (!workspaceRoot) {
      await this.sendInfoCardMessage({
        chatId: normalized.chatId,
        replyToMessageId: normalized.messageId,
        text: "当前会话还没有绑定项目。",
      });
      return;
    }

    const threads = await this.refreshWorkspaceThreads(bindingKey, workspaceRoot, normalized);
    let threadId = this.resolveThreadIdForBinding(bindingKey, workspaceRoot);
    if (!threadId && threads[0]?.id) {
      threadId = threads[0].id;
      this.sessionStore.setThreadIdForWorkspace(
        bindingKey,
        workspaceRoot,
        threadId,
        buildBindingMetadata(normalized)
      );
    }

    if (!threadId) {
      await this.sendInfoCardMessage({
        chatId: normalized.chatId,
        replyToMessageId: normalized.messageId,
        text: `当前项目：\`${workspaceRoot}\`\n\n该项目还没有可查看的线程消息。`,
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

  async handleWorkspacesCommand(normalized, { replyToMessageId } = {}) {
    const bindingKey = this.sessionStore.buildBindingKey(normalized);
    const binding = this.sessionStore.getBinding(bindingKey) || {};
    const items = listBoundWorkspaces(binding);
    const replyTarget = this.resolveReplyToMessageId(normalized, replyToMessageId);
    if (!items.length) {
      await this.sendInfoCardMessage({
        chatId: normalized.chatId,
        replyToMessageId: replyTarget,
        text: "当前会话还没有已绑定项目。先发送 `/codex bind /绝对路径`。",
      });
      return;
    }

    await this.sendInteractiveCard({
      chatId: normalized.chatId,
      replyToMessageId: replyTarget,
      card: buildWorkspaceBindingsCard(items),
    });
  }

  async showThreadPicker(normalized, { replyToMessageId } = {}) {
    const replyTarget = this.resolveReplyToMessageId(normalized, replyToMessageId);
    const { bindingKey, workspaceRoot } = this.getBindingContext(normalized);
    if (!workspaceRoot) {
      await this.sendInfoCardMessage({
        chatId: normalized.chatId,
        replyToMessageId: replyTarget,
        text: "当前会话还未绑定项目。先发送 `/codex bind /绝对路径`。",
      });
      return;
    }

    const threads = await this.refreshWorkspaceThreads(bindingKey, workspaceRoot, normalized);
    const currentThreadId = this.resolveThreadIdForBinding(bindingKey, workspaceRoot) || threads[0]?.id || "";
    if (!threads.length) {
      await this.sendInfoCardMessage({
        chatId: normalized.chatId,
        replyToMessageId: replyTarget,
        text: `当前项目：\`${workspaceRoot}\`\n\n还没有可切换的历史线程。`,
      });
      return;
    }

    await this.sendInteractiveCard({
      chatId: normalized.chatId,
      replyToMessageId: replyTarget,
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
      await this.sendInfoCardMessage({
        chatId: normalized.chatId,
        replyToMessageId: normalized.messageId,
        text: "当前会话还未绑定项目。先发送 `/codex bind /绝对路径`。",
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
      await this.sendInfoCardMessage({
        chatId: normalized.chatId,
        replyToMessageId: normalized.messageId,
        text: `创建新线程失败: ${error.message}`,
      });
    }
  }

  async handleSwitchCommand(normalized) {
    const threadId = extractSwitchThreadId(normalized.text);
    if (!threadId) {
      await this.sendInfoCardMessage({
        chatId: normalized.chatId,
        replyToMessageId: normalized.messageId,
        text: "用法: `/codex switch <threadId>`",
      });
      return;
    }

    await this.switchThreadById(normalized, threadId, { replyToMessageId: normalized.messageId });
  }

  async handleRemoveCommand(normalized) {
    const workspaceRoot = extractRemoveWorkspacePath(normalized.text);
    if (!workspaceRoot) {
      await this.sendInfoCardMessage({
        chatId: normalized.chatId,
        replyToMessageId: normalized.messageId,
        text: "用法: `/codex remove /绝对路径`",
      });
      return;
    }

    if (!isAbsoluteWorkspacePath(workspaceRoot)) {
      await this.sendInfoCardMessage({
        chatId: normalized.chatId,
        replyToMessageId: normalized.messageId,
        text: "路径必须是绝对路径。",
      });
      return;
    }

    await this.removeWorkspaceByPath(normalized, workspaceRoot, {
      replyToMessageId: normalized.messageId,
    });
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
    const allThreads = [];
    const seenThreadIds = new Set();
    let cursor = null;

    for (let page = 0; page < 10; page += 1) {
      const response = await this.codex.listThreads({
        cursor,
        limit: 200,
        sortKey: "updated_at",
      });
      const pageThreads = extractThreadsFromListResponse(response);
      for (const thread of pageThreads) {
        if (seenThreadIds.has(thread.id)) {
          continue;
        }
        seenThreadIds.add(thread.id);
        allThreads.push(thread);
      }

      const nextCursor = extractThreadListCursor(response);
      if (!nextCursor || nextCursor === cursor) {
        break;
      }
      cursor = nextCursor;
      if (pageThreads.length === 0) {
        break;
      }
    }

    return allThreads.filter((thread) => pathMatchesWorkspaceRoot(thread.cwd, workspaceRoot));
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
    const replyTarget = this.resolveReplyToMessageId(normalized, replyToMessageId);
    const { bindingKey, workspaceRoot } = this.getBindingContext(normalized);
    if (!workspaceRoot) {
      await this.sendInfoCardMessage({
        chatId: normalized.chatId,
        replyToMessageId: replyTarget,
        text: "当前会话还未绑定项目。先发送 `/codex bind /绝对路径`。",
      });
      return;
    }

    const currentThreadId = this.resolveThreadIdForBinding(bindingKey, workspaceRoot);
    if (currentThreadId && currentThreadId === threadId) {
      await this.sendInfoCardMessage({
        chatId: normalized.chatId,
        replyToMessageId: replyTarget,
        text: "已经是当前线程，无需切换。",
      });
      return;
    }

    const availableThreads = await this.refreshWorkspaceThreads(bindingKey, workspaceRoot, normalized);
    const selectedThread = availableThreads.find((thread) => thread.id === threadId) || null;
    if (!selectedThread) {
      await this.sendInfoCardMessage({
        chatId: normalized.chatId,
        replyToMessageId: replyTarget,
        text: "指定线程当前不可用，请刷新后重试。",
      });
      return;
    }

    const resolvedWorkspaceRoot = selectedThread.cwd || workspaceRoot;
    this.sessionStore.setActiveWorkspaceRoot(bindingKey, resolvedWorkspaceRoot);
    this.sessionStore.setThreadIdForWorkspace(
      bindingKey,
      resolvedWorkspaceRoot,
      threadId,
      buildBindingMetadata(normalized)
    );
    this.resumedThreadIds.delete(threadId);
    await this.ensureThreadResumed(threadId);
    await this.showStatusPanel(normalized, { replyToMessageId: replyTarget });
  }

  async handleStopCommand(normalized) {
    const bindingKey = this.sessionStore.buildBindingKey(normalized);
    const workspaceRoot = this.resolveWorkspaceRootForBinding(bindingKey);
    const threadId = workspaceRoot ? this.resolveThreadIdForBinding(bindingKey, workspaceRoot) : null;
    const turnId = threadId ? this.activeTurnIdByThreadId.get(threadId) || null : null;

    if (!threadId) {
      await this.sendInfoCardMessage({
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
      await this.sendInfoCardMessage({
        chatId: normalized.chatId,
        replyToMessageId: normalized.messageId,
        text: "已发送停止请求。",
      });
    } catch (error) {
      await this.sendInfoCardMessage({
        chatId: normalized.chatId,
        replyToMessageId: normalized.messageId,
        text: `停止失败: ${error.message}`,
      });
    }
  }

  async handleApprovalCommand(normalized) {
    const { threadId } = this.getCurrentThreadContext(normalized);
    const approval = threadId ? this.pendingApprovalByThreadId.get(threadId) || null : null;

    if (!threadId || !approval) {
      await this.sendInfoCardMessage({
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
      await this.sendInfoCardMessage({
        chatId: normalized.chatId,
        replyToMessageId: normalized.messageId,
        text: normalized.command === "approve" ? "已批准本次请求。" : "已拒绝本次请求。",
      });
    } catch (error) {
      await this.sendInfoCardMessage({
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

    if (eventShouldClearPendingReaction(outbound)) {
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
        deferFlush: !this.config.feishuStreamingOutput,
      });
      return;
    }

    if (event.type === "im.run_state") {
      if (event.payload.state === "streaming") {
        if (!this.config.feishuStreamingOutput) {
          return;
        }
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

  async sendInfoCardMessage({ chatId, text, replyToMessageId = "", replyInThread = false, kind = "info" }) {
    if (!chatId || !text) {
      return null;
    }

    return this.sendInteractiveCard({
      chatId,
      replyToMessageId,
      replyInThread,
      card: buildInfoCard(text, { kind }),
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
      this.runCardActionTask(this.sendCardActionFeedback(data, "无法识别卡片操作。", "error"));
      return buildCardResponse({});
    }

    if (action.kind === "approval") {
      this.runCardActionTask((async () => {
        await this.sendCardActionFeedback(data, "正在处理授权...", "progress");
        await this.handleApprovalCardActionAsync(action, data);
      })());
      return buildCardResponse({});
    }

    const normalized = normalizeCardActionContext(data, this.config);
    if (!normalized) {
      this.runCardActionTask(this.sendCardActionFeedback(data, "无法解析当前卡片上下文。", "error"));
      return buildCardResponse({});
    }

    try {
      const handled = this.dispatchCardAction(action, normalized);
      if (handled) {
        return handled;
      }
    } catch (error) {
      this.runCardActionTask(this.sendCardActionFeedbackByContext(normalized, `处理失败: ${error.message}`, "error"));
      return buildCardResponse({});
    }

    this.runCardActionTask(this.sendCardActionFeedbackByContext(normalized, "未支持的卡片操作。", "error"));
    return buildCardResponse({});
  }

  dispatchCardAction(action, normalized) {
    if (action.kind === "panel") {
      return this.handlePanelCardAction(action, normalized);
    }
    if (action.kind === "thread") {
      return this.handleThreadCardAction(action, normalized);
    }
    if (action.kind === "workspace") {
      return this.handleWorkspaceCardAction(action, normalized);
    }
    return null;
  }

  handlePanelCardAction(action, normalized) {
    const handlers = {
      open_threads: {
        feedback: "正在打开线程列表...",
        run: () => this.showThreadPicker(normalized, { replyToMessageId: normalized.messageId }),
      },
      new_thread: {
        feedback: "正在创建新线程...",
        run: () => this.handleNewCommand(normalized),
      },
      show_messages: {
        feedback: "正在获取最近消息...",
        run: () => this.handleMessageCommand(normalized),
      },
      stop: {
        feedback: "正在发送停止请求...",
        run: () => this.handleStopCommand(normalized),
      },
      status: {
        feedback: "正在刷新状态...",
        run: () => this.showStatusPanel(normalized, { replyToMessageId: normalized.messageId }),
      },
    };

    const handler = handlers[action.action];
    if (!handler) {
      return null;
    }

    return this.queueCardActionWithFeedback(normalized, handler.feedback, handler.run);
  }

  handleThreadCardAction(action, normalized) {
    const { threadId: currentThreadId } = this.getCurrentThreadContext(normalized);

    if (action.action === "switch") {
      if (currentThreadId && currentThreadId === action.threadId) {
        this.runCardActionTask(this.sendCardActionFeedbackByContext(normalized, "已经是当前线程，无需切换。", "info"));
        return buildCardResponse({});
      }

      return this.queueCardActionWithFeedback(normalized, "正在切换线程...", () => (
        this.switchThreadById(normalized, action.threadId, { replyToMessageId: normalized.messageId })
      ));
    }

    if (action.action === "messages") {
      if (!currentThreadId || currentThreadId !== action.threadId) {
        this.runCardActionTask(this.sendCardActionFeedbackByContext(normalized, "非当前线程，请先切换到该线程。", "error"));
        return buildCardResponse({});
      }

      return this.queueCardActionWithFeedback(normalized, "正在获取最近消息...", () => this.handleMessageCommand(normalized));
    }

    return null;
  }

  handleWorkspaceCardAction(action, normalized) {
    if (action.action === "status") {
      return this.queueCardActionWithFeedback(normalized, "正在查看线程列表...", () => (
        this.showStatusPanel(normalized, { replyToMessageId: normalized.messageId })
      ));
    }

    if (action.action === "remove") {
      return this.queueCardActionWithFeedback(normalized, "正在移除项目...", () => (
        this.removeWorkspaceByPath(normalized, action.workspaceRoot, { replyToMessageId: normalized.messageId })
      ));
    }

    if (action.action !== "switch") {
      return null;
    }

    const { workspaceRoot: currentWorkspaceRoot } = this.getBindingContext(normalized);
    const targetWorkspaceRoot = normalizeWorkspacePath(action.workspaceRoot);
    if (currentWorkspaceRoot && targetWorkspaceRoot && currentWorkspaceRoot === targetWorkspaceRoot) {
      this.runCardActionTask(this.sendCardActionFeedbackByContext(normalized, "已经是当前项目，无需切换。", "info"));
      return buildCardResponse({});
    }

    return this.queueCardActionWithFeedback(normalized, "正在切换项目...", () => (
      this.switchWorkspaceByPath(normalized, action.workspaceRoot, { replyToMessageId: normalized.messageId })
    ));
  }

  queueCardActionWithFeedback(normalized, feedbackText, task) {
    this.runCardActionTask((async () => {
      await this.sendCardActionFeedbackByContext(normalized, feedbackText, "progress");
      await task();
    })());
    return buildCardResponse({});
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

  runCardActionTask(taskPromise) {
    Promise.resolve(taskPromise).catch((error) => {
      console.error(`[codex-im] async card action failed: ${error.message}`);
    });
  }

  async handleApprovalCardActionAsync(action, data) {
    const approval = this.pendingApprovalByThreadId.get(action.threadId);
    if (!approval || String(approval.requestId) !== String(action.requestId)) {
      await this.sendCardActionFeedback(data, "该授权请求已失效。", "error");
      return;
    }

    const chatId = approval.chatId || extractCardChatId(data);
    try {
      const resolution = action.decision === "approve" ? "approved" : "rejected";
      const decision = resolveApprovalDecision(
        action.decision,
        approval.method,
        action.scope === "session" ? "/codex approve session" : "/codex approve"
      );
      await this.codex.sendResponse(approval.requestId, decision);
      await this.markApprovalResolved(action.threadId, resolution);
      if (chatId) {
        await this.sendInfoCardMessage({
          chatId,
          replyToMessageId: approval.cardMessageId || approval.replyToMessageId || "",
          text: action.decision === "approve" ? "已批准本次请求。" : "已拒绝本次请求。",
          kind: "success",
        });
      }
    } catch (error) {
      await this.sendCardActionFeedback(data, `处理失败: ${error.message}`, "error");
    }
  }

  async sendCardActionFeedbackByContext(normalized, text, kind = "info") {
    if (!normalized?.chatId || !text) {
      return;
    }
    await this.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId || "",
      text,
      kind,
    });
  }

  async sendCardActionFeedback(data, text, kind = "info") {
    const normalized = normalizeCardActionContext(data, this.config);
    if (!normalized) {
      return;
    }
    await this.sendCardActionFeedbackByContext(normalized, text, kind);
  }

  async switchWorkspaceByPath(normalized, workspaceRoot, { replyToMessageId } = {}) {
    const targetWorkspaceRoot = normalizeWorkspacePath(workspaceRoot);
    if (!targetWorkspaceRoot) {
      await this.sendInfoCardMessage({
        chatId: normalized.chatId,
        replyToMessageId: replyToMessageId || normalized.messageId,
        text: "目标项目无效，请刷新后重试。",
      });
      return;
    }

    const bindingKey = this.sessionStore.buildBindingKey(normalized);
    const currentWorkspaceRoot = this.resolveWorkspaceRootForBinding(bindingKey);
    if (currentWorkspaceRoot && currentWorkspaceRoot === targetWorkspaceRoot) {
      await this.sendInfoCardMessage({
        chatId: normalized.chatId,
        replyToMessageId: replyToMessageId || normalized.messageId,
        text: "已经是当前项目，无需切换。",
      });
      return;
    }

    const binding = this.sessionStore.getBinding(bindingKey) || {};
    const items = listBoundWorkspaces(binding);
    if (!items.some((item) => item.workspaceRoot === targetWorkspaceRoot)) {
      await this.sendInfoCardMessage({
        chatId: normalized.chatId,
        replyToMessageId: replyToMessageId || normalized.messageId,
        text: "该项目未绑定到当前会话，请先执行 `/codex bind /绝对路径`。",
      });
      return;
    }

    this.sessionStore.setActiveWorkspaceRoot(bindingKey, targetWorkspaceRoot);
    const threads = await this.refreshWorkspaceThreads(bindingKey, targetWorkspaceRoot, normalized);
    const selectedThreadId = this.resolveThreadIdForBinding(bindingKey, targetWorkspaceRoot);
    const threadId = selectedThreadId || threads[0]?.id || "";
    if (!selectedThreadId && threadId) {
      this.sessionStore.setThreadIdForWorkspace(
        bindingKey,
        targetWorkspaceRoot,
        threadId,
        buildBindingMetadata(normalized)
      );
    }

    await this.handleWorkspacesCommand(normalized, {
      replyToMessageId: replyToMessageId || normalized.messageId,
    });
  }

  async removeWorkspaceByPath(normalized, workspaceRoot, { replyToMessageId } = {}) {
    const targetWorkspaceRoot = normalizeWorkspacePath(workspaceRoot);
    if (!targetWorkspaceRoot) {
      await this.sendInfoCardMessage({
        chatId: normalized.chatId,
        replyToMessageId: replyToMessageId || normalized.messageId,
        text: "目标项目无效，请刷新后重试。",
      });
      return;
    }

    const bindingKey = this.sessionStore.buildBindingKey(normalized);
    const currentWorkspaceRoot = this.resolveWorkspaceRootForBinding(bindingKey);
    if (currentWorkspaceRoot && currentWorkspaceRoot === targetWorkspaceRoot) {
      await this.sendInfoCardMessage({
        chatId: normalized.chatId,
        replyToMessageId: replyToMessageId || normalized.messageId,
        text: "当前项目不支持移除，请先切换到其他项目。",
      });
      return;
    }

    const binding = this.sessionStore.getBinding(bindingKey) || {};
    const items = listBoundWorkspaces(binding);
    if (!items.some((item) => item.workspaceRoot === targetWorkspaceRoot)) {
      await this.sendInfoCardMessage({
        chatId: normalized.chatId,
        replyToMessageId: replyToMessageId || normalized.messageId,
        text: "该项目未绑定到当前会话，无需移除。",
      });
      return;
    }

    this.sessionStore.removeWorkspace(bindingKey, targetWorkspaceRoot);
    await this.handleWorkspacesCommand(normalized, {
      replyToMessageId: replyToMessageId || normalized.messageId,
    });
  }

  async upsertAssistantReplyCard({ threadId, turnId, chatId, text, state, deferFlush = false }) {
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

    if (deferFlush && existing.state !== "completed" && existing.state !== "failed") {
      return;
    }

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
      this.clearPendingReactionForThread(entry.threadId).catch((error) => {
        console.error(`[codex-im] failed to clear pending reaction after first reply card: ${error.message}`);
      });
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

  const command = parseCommand(text);

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

function buildBindingMetadata(normalized) {
  return {
    workspaceId: normalized.workspaceId,
    chatId: normalized.chatId,
    threadKey: normalized.threadKey,
    senderId: normalized.senderId,
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

function parseCommand(text) {
  const normalized = text.trim().toLowerCase();
  const prefixes = ["/codex "];
  const exactPrefixes = ["/codex"];

  const exactCommands = {
    stop: ["stop"],
    where: ["where"],
    inspect_message: ["message"],
    help: ["help"],
    workspace: ["workspace"],
    remove: ["remove"],
    new: ["new"],
    approve: ["approve", "approve session"],
    reject: ["reject"],
  };
  for (const [command, suffixes] of Object.entries(exactCommands)) {
    if (matchesExactCommand(normalized, suffixes)) {
      return command;
    }
  }

  if (matchesPrefixCommand(normalized, "switch")) {
    return "switch";
  }
  if (matchesPrefixCommand(normalized, "remove")) {
    return "remove";
  }
  if (matchesPrefixCommand(normalized, "bind")) {
    return "bind";
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

function matchesExactCommand(text, suffixes) {
  return suffixes.some((suffix) => (
    text === `/codex ${suffix}`
  ));
}

function matchesPrefixCommand(text, command) {
  return text.startsWith(`/codex ${command} `);
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
            "## Codex 授权请求",
            `**请求类型**：${requestType}`,
            approval.reason ? `**原因**：${escapeLarkMd(approval.reason)}` : "",
            approval.command ? `**将执行的内容**：\n\`\`\`\n${approval.command}\n\`\`\`` : "",
            "请选择处理方式：",
          ].filter(Boolean).join("\n\n"),
        },
        {
          tag: "column_set",
          flex_mode: "none",
          columns: [
            {
              tag: "column",
              width: "weighted",
              weight: 1,
              elements: [
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
              ],
            },
            {
              tag: "column",
              width: "weighted",
              weight: 1,
              elements: [
                {
                  tag: "button",
                  text: { tag: "plain_text", content: "会话允许" },
                  value: {
                    kind: "approval",
                    decision: "approve",
                    scope: "session",
                    requestId: approval.requestId,
                    threadId: approval.threadId,
                  },
                },
              ],
            },
            {
              tag: "column",
              width: "weighted",
              weight: 1,
              elements: [
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
          ],
        },
        {
          tag: "markdown",
          content: "`会话允许` 仅对当前会话生效。",
          text_size: "notation",
        },
      ],
    },
  };
}

function buildAssistantReplyCard({ text, state }) {
  const normalizedState = state || "streaming";
  const stateLabel = normalizedState === "failed"
    ? " · 🔴 执行失败"
    : normalizedState === "completed"
      ? ""
      : " · 🟡 处理中";
  const content = typeof text === "string" && text.trim()
    ? text.trim()
    : normalizedState === "failed"
      ? "执行失败"
      : normalizedState === "completed"
        ? "执行完成"
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
          content: `**🤖 Codex**${stateLabel}`,
          text_size: "notation",
        },
        { tag: "hr" },
        {
          tag: "markdown",
          content: escapeCardMarkdown(content),
          text_size: "normal",
        },
      ],
    },
  };
}

function buildInfoCard(text, { kind = "info" } = {}) {
  const normalizedText = String(text || "").trim();
  const title = kind === "progress"
    ? "⏳ 处理中"
    : kind === "success"
      ? "✅ 已完成"
      : kind === "error"
        ? "❌ 处理失败"
        : "💬 提示";
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
          content: `**${title}**\n\n${escapeCardMarkdown(normalizedText)}`,
          text_size: "normal",
        },
      ],
    },
  };
}

function buildStatusPanelCard({
  workspaceRoot,
  threadId,
  currentThread,
  recentThreads,
  totalThreadCount,
  status,
  noticeText = "",
}) {
  const isRunning = status?.code === "running";
  const currentThreadStatusText = status?.code === "running"
    ? "🟡 运行中"
    : status?.code === "approval"
      ? "🟠 等待授权"
      : "";
  const shouldShowAllThreadsButton = Number(totalThreadCount || 0) > 3;
  const threadRows = [];
  const current = threadId ? (currentThread || { id: threadId }) : null;
  if (current) {
    threadRows.push({
      isCurrent: true,
      thread: current,
      label: "当前线程",
      buttonText: "当前",
      buttonType: "default",
    });
  }
  for (const thread of (recentThreads || [])) {
    threadRows.push({
      isCurrent: false,
      thread,
      label: "历史线程",
      buttonText: "切换",
      buttonType: "primary",
    });
  }

  const elements = [];
  if (typeof noticeText === "string" && noticeText.trim()) {
    elements.push({
      tag: "markdown",
      content: `✅ ${escapeCardMarkdown(noticeText.trim())}`,
      text_size: "notation",
    });
  }

  elements.push({
      tag: "column_set",
      flex_mode: "none",
      columns: [
        {
          tag: "column",
          width: "weighted",
          weight: 5,
          vertical_align: "top",
          elements: [
            {
              tag: "markdown",
              content: [
                `**当前项目**：\`${escapeCardMarkdown(workspaceRoot)}\``,
              ].join(""),
            },
          ],
        },
        {
          tag: "column",
          width: "auto",
          vertical_align: "top",
          elements: [
            {
              tag: "button",
              text: { tag: "plain_text", content: "新建" },
              value: buildPanelActionValue("new_thread"),
            },
          ],
        },
      ],
    }
  );
  elements.push({ tag: "hr" });

  if (threadRows.length) {
    elements.push({
      tag: "markdown",
      content: `**线程列表**（${threadRows.length}）`,
      text_size: "notation",
    });
    threadRows.forEach((row, index) => {
      if (index > 0) {
        elements.push({ tag: "hr" });
      }
      elements.push({
        tag: "column_set",
        flex_mode: "none",
        columns: [
          {
            tag: "column",
            width: "weighted",
            weight: 5,
            vertical_align: "top",
            elements: [
              {
                tag: "markdown",
                content: [
                  `${row.label === "当前线程" ? "🟢 当前" : "⚪ 历史"} · **${formatThreadLabel(row.thread)}**${row.isCurrent && currentThreadStatusText ? ` · ${currentThreadStatusText}` : ""}`,
                  formatThreadIdLine(row.thread),
                  summarizeThreadPreview(row.thread),
                ].filter(Boolean).join("\n"),
                text_size: "notation",
              },
            ],
          },
          {
            tag: "column",
            width: "auto",
            vertical_align: "center",
            elements: [
              ...(row.isCurrent
                ? [
                  {
                    tag: "column_set",
                    flex_mode: "none",
                    columns: [
                      {
                        tag: "column",
                        width: "auto",
                        elements: [
                          {
                            tag: "button",
                            text: { tag: "plain_text", content: "最近消息" },
                            type: "primary",
                            value: buildThreadActionValue("messages", row.thread.id),
                          },
                        ],
                      },
                      {
                        tag: "column",
                        width: "auto",
                        elements: [
                          {
                            tag: "button",
                            text: { tag: "plain_text", content: row.buttonText },
                            type: row.buttonType,
                            disabled: true,
                          },
                        ],
                      },
                    ],
                  },
                ]
                : [
                  {
                    tag: "button",
                    text: { tag: "plain_text", content: row.buttonText },
                    type: row.buttonType,
                    value: buildThreadActionValue("switch", row.thread.id),
                  },
                ]),
            ],
          },
        ],
      });
    });
  } else {
    elements.push({
      tag: "markdown",
      content: "**线程列表**\n暂无历史线程",
      text_size: "notation",
    });
  }

  const footerColumns = [];
  if (shouldShowAllThreadsButton) {
    footerColumns.push({
      tag: "column",
      width: "weighted",
      weight: 1,
      elements: [
        {
          tag: "button",
          text: { tag: "plain_text", content: "全部线程" },
          value: buildPanelActionValue("open_threads"),
        },
      ],
    });
  }
  if (isRunning) {
    footerColumns.push({
      tag: "column",
      width: "weighted",
      weight: 1,
      elements: [
        {
          tag: "button",
          text: { tag: "plain_text", content: "停止" },
          type: "danger",
          value: buildPanelActionValue("stop"),
        },
      ],
    });
  }
  if (footerColumns.length) {
    elements.push(
      { tag: "hr" },
      {
        tag: "column_set",
        flex_mode: "none",
        columns: footerColumns,
      }
    );
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
      content: `**当前项目**：\`${escapeCardMarkdown(workspaceRoot)}\``,
    },
    { tag: "hr" },
    {
      tag: "markdown",
      content: `**线程列表**（${Math.min(threads.length, 8)}）`,
      text_size: "notation",
    },
  ];

  threads.slice(0, 8).forEach((thread, index) => {
    if (index > 0) {
      elements.push({ tag: "hr" });
    }
    const isCurrent = thread.id === currentThreadId;
    elements.push({
      tag: "column_set",
      flex_mode: "none",
      columns: [
        {
          tag: "column",
          width: "weighted",
          weight: 5,
          vertical_align: "top",
          elements: [
            {
              tag: "markdown",
              content: [
                `${isCurrent ? "🟢 当前" : "⚪ 历史"} · **${formatThreadLabel(thread)}**`,
                formatThreadIdLine(thread),
                summarizeThreadPreview(thread),
              ].filter(Boolean).join("\n"),
              text_size: "notation",
            },
          ],
        },
        {
          tag: "column",
          width: "auto",
          vertical_align: "center",
          elements: [
            ...(isCurrent
              ? [
                {
                  tag: "column_set",
                  flex_mode: "none",
                  columns: [
                    {
                      tag: "column",
                      width: "auto",
                      elements: [
                        {
                          tag: "button",
                          text: { tag: "plain_text", content: "最近消息" },
                          type: "primary",
                          value: buildThreadActionValue("messages", thread.id),
                        },
                      ],
                    },
                    {
                      tag: "column",
                      width: "auto",
                      elements: [
                        {
                          tag: "button",
                          text: { tag: "plain_text", content: "当前" },
                          type: "default",
                          disabled: true,
                        },
                      ],
                    },
                  ],
                },
              ]
              : [
                {
                  tag: "button",
                  text: { tag: "plain_text", content: "切换" },
                  type: "primary",
                  value: buildThreadActionValue("switch", thread.id),
                },
              ]),
          ],
        },
      ],
    });
  });

  elements.push(
    { tag: "hr" },
    {
      tag: "button",
      text: { tag: "plain_text", content: "新建线程" },
      value: buildPanelActionValue("new_thread"),
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

function buildHelpCardText() {
  const sections = [
    [
      "**直接对话**",
      "绑定项目后，直接发普通消息即可继续当前线程。",
    ],
    [
      "**绑定项目**",
      "`/codex bind /绝对路径`",
      "把当前飞书会话绑定到一个本地项目。",
    ],
    [
      "**查看当前状态**",
      "`/codex where`",
      "查看当前绑定的项目和正在使用的线程。",
    ],
    [
      "**查看最近消息**",
      "`/codex message`",
      "查看当前线程最近几轮对话。",
    ],
    [
      "**查看可用历史线程**",
      "`/codex workspace`",
      "查看当前项目下 Codex runtime 可见的历史线程。",
    ],
    [
      "**移除会话项目绑定**",
      "`/codex remove /绝对路径`",
      "从当前飞书会话中移除指定项目（不能移除当前项目）。",
    ],
    [
      "**切换到指定线程**",
      "`/codex switch <threadId>`",
      "按线程 ID 切换到指定线程。",
    ],
    [
      "**新建线程**",
      "`/codex new`",
      "在当前项目下创建一条新线程并切换过去。",
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

function listBoundWorkspaces(binding) {
  const activeWorkspaceRoot = String(binding?.activeWorkspaceRoot || "").trim();
  const threadIdByWorkspaceRoot = binding?.threadIdByWorkspaceRoot
    && typeof binding.threadIdByWorkspaceRoot === "object"
    ? binding.threadIdByWorkspaceRoot
    : {};
  const workspaceRoots = new Set(Object.keys(threadIdByWorkspaceRoot));
  if (activeWorkspaceRoot) {
    workspaceRoots.add(activeWorkspaceRoot);
  }

  return [...workspaceRoots]
    .map((workspaceRoot) => String(workspaceRoot || "").trim())
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right))
    .map((workspaceRoot) => ({
      workspaceRoot,
      isActive: workspaceRoot === activeWorkspaceRoot,
      threadId: String(threadIdByWorkspaceRoot[workspaceRoot] || "").trim(),
    }));
}

function buildWorkspaceBindingsCard(items) {
  const elements = [
    {
      tag: "markdown",
      content: `**会话绑定项目**（${items.length}）`,
      text_size: "normal",
    },
  ];

  items.forEach((item, index) => {
    if (index > 0) {
      elements.push({ tag: "hr" });
    }
    elements.push({
      tag: "column_set",
      flex_mode: "none",
      columns: [
        {
          tag: "column",
          width: "weighted",
          weight: 5,
          vertical_align: "top",
          elements: [
            {
              tag: "markdown",
              content: [
                `${item.isActive ? "🟢 当前项目" : "⚪ 已绑定项目"}`,
                `\`${escapeCardMarkdown(item.workspaceRoot)}\``,
                item.threadId ? "" : "线程：未关联",
              ].filter(Boolean).join("\n"),
              text_size: "notation",
            },
          ],
        },
        {
          tag: "column",
          width: "auto",
          vertical_align: "center",
          elements: item.isActive
            ? [
              {
                tag: "column_set",
                flex_mode: "none",
                columns: [
                  {
                    tag: "column",
                    width: "auto",
                    elements: [
                      {
                        tag: "button",
                        text: { tag: "plain_text", content: "线程列表" },
                        type: "primary",
                        value: buildWorkspaceActionValue("status", item.workspaceRoot),
                      },
                    ],
                  },
                  {
                    tag: "column",
                    width: "auto",
                    elements: [
                      {
                        tag: "button",
                        text: { tag: "plain_text", content: "当前" },
                        type: "default",
                        disabled: true,
                      },
                    ],
                  },
                ],
              },
            ]
            : [
              {
                tag: "column_set",
                flex_mode: "none",
                columns: [
                  {
                    tag: "column",
                    width: "auto",
                    elements: [
                      {
                        tag: "button",
                        text: { tag: "plain_text", content: "移除" },
                        type: "default",
                        value: buildWorkspaceActionValue("remove", item.workspaceRoot),
                      },
                    ],
                  },
                  {
                    tag: "column",
                    width: "auto",
                    elements: [
                      {
                        tag: "button",
                        text: { tag: "plain_text", content: "切换" },
                        type: "primary",
                        value: buildWorkspaceActionValue("switch", item.workspaceRoot),
                      },
                    ],
                  },
                ],
              },
            ],
        },
      ],
    });
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

function buildThreadMessagesSummary({ workspaceRoot, thread, recentMessages }) {
  const sections = [
    `项目：\`${workspaceRoot}\``,
    `当前线程：${formatThreadLabel(thread)}`,
    "***",
    "**对话记录**",
  ];

  if (!Array.isArray(recentMessages) || recentMessages.length === 0) {
    sections.push("空");
    return sections.join("\n\n");
  }

  const normalizedTranscript = recentMessages.map((message) => (
    message.role === "user"
      ? `😄 **你**\n> ${escapeCardMarkdown(message.text).replace(/\n/g, "\n> ")}`
      : `🤖 <font color='blue'>**Codex**</font>\n> ${escapeCardMarkdown(message.text).replace(/\n/g, "\n> ")}`
  ));
  sections.push(normalizedTranscript.join("\n\n---\n\n"));
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
            `## Codex 授权请求 <font color='${colorText}'>${resolutionLabel}</font>`,
            approval.reason ? `**原因**: ${escapeLarkMd(approval.reason)}` : "",
            approval.command ? `**命令**:\n\`\`\`\n${approval.command}\n\`\`\`` : "",
            `结果：${resolutionLabel}`,
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

function extractThreadListCursor(response) {
  const cursorCandidates = [
    response?.result?.next_cursor,
    response?.result?.nextCursor,
    response?.result?.cursor,
    response?.cursor,
    response?.next_cursor,
    response?.nextCursor,
  ];

  for (const candidate of cursorCandidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  return "";
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

function formatThreadLabel(thread) {
  if (!thread) {
    return "";
  }

  const title = typeof thread.title === "string" ? thread.title.trim() : "";
  if (!title) {
    return "未命名线程";
  }
  return truncateDisplayText(title, 50);
}

function formatThreadIdLine(thread) {
  const threadId = normalizeIdentifier(thread?.id || thread?.threadId || thread?.thread_id);
  if (!threadId) {
    return "";
  }
  return `线程ID：\`${escapeCardMarkdown(threadId)}\``;
}

function truncateDisplayText(text, maxLength) {
  const input = String(text || "");
  const chars = Array.from(input);
  if (!Number.isFinite(maxLength) || maxLength <= 0 || chars.length <= maxLength) {
    return input;
  }
  return `${chars.slice(0, maxLength).join("")}...`;
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
  if (value.kind === "workspace") {
    return {
      kind: value.kind,
      action: value.action || "",
      workspaceRoot: value.workspaceRoot || "",
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

function buildWorkspaceActionValue(action, workspaceRoot) {
  return {
    kind: "workspace",
    action,
    workspaceRoot,
  };
}

function summarizeThreadPreview(thread) {
  const updated = formatRelativeTimestamp(thread?.updatedAt);
  return updated ? `更新时间：${updated}` : "更新时间：未知";
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

function eventShouldClearPendingReaction(event) {
  if (!event || typeof event !== "object") {
    return false;
  }

  if (event.type === "im.run_state") {
    const state = String(event.payload?.state || "").toLowerCase();
    return state === "completed" || state === "failed";
  }

  if (event.type === "im.approval_request") {
    return true;
  }

  return false;
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

  const fromFileUri = extractPathFromFileUri(normalized);
  const rawPath = fromFileUri || normalized;
  const withForwardSlashes = rawPath.replace(/\\/g, "/").replace(/^\/\/\?\//, "");
  const normalizedDrivePrefix = /^\/[A-Za-z]:\//.test(withForwardSlashes)
    ? withForwardSlashes.slice(1)
    : withForwardSlashes;

  if (/^[A-Za-z]:\/$/.test(normalizedDrivePrefix)) {
    return normalizedDrivePrefix;
  }
  if (/^[A-Za-z]:\//.test(normalizedDrivePrefix)) {
    return normalizedDrivePrefix.replace(/\/+$/g, "");
  }
  return normalizedDrivePrefix.replace(/\/+$/g, "");
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
  const compareCandidate = shouldComparePathCaseInsensitive(normalizedCandidate)
    ? normalizedCandidate.toLowerCase()
    : normalizedCandidate;
  const compareWorkspaceRoot = shouldComparePathCaseInsensitive(normalizedWorkspaceRoot)
    ? normalizedWorkspaceRoot.toLowerCase()
    : normalizedWorkspaceRoot;
  return (
    compareCandidate === compareWorkspaceRoot
    || compareCandidate.startsWith(`${compareWorkspaceRoot}/`)
  );
}

function shouldComparePathCaseInsensitive(pathValue) {
  return isWindowsStylePath(pathValue);
}

function extractPathFromFileUri(value) {
  const input = String(value || "").trim();
  if (!/^file:\/\//i.test(input)) {
    return "";
  }

  try {
    const parsed = new URL(input);
    if (parsed.protocol !== "file:") {
      return "";
    }
    const pathname = decodeURIComponent(parsed.pathname || "");
    const withHost = parsed.host && parsed.host !== "localhost"
      ? `//${parsed.host}${pathname}`
      : pathname;
    return withHost;
  } catch {
    return "";
  }
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
  if (trimmed.toLowerCase().startsWith(bindPrefix)) {
    return trimmed.slice(bindPrefix.length).trim();
  }
  return "";
}

function extractSwitchThreadId(text) {
  const trimmed = String(text || "").trim();
  const switchPrefix = "/codex switch ";
  if (trimmed.toLowerCase().startsWith(switchPrefix)) {
    return trimmed.slice(switchPrefix.length).trim();
  }
  return "";
}

function extractRemoveWorkspacePath(text) {
  const trimmed = String(text || "").trim();
  const removePrefix = "/codex remove ";
  if (trimmed.toLowerCase().startsWith(removePrefix)) {
    return trimmed.slice(removePrefix.length).trim();
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

module.exports = { FeishuBotRuntime };
