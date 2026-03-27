const {
  extractErrorMessage,
  formatFailureText,
} = require("../../shared/error-text");
const slurmClient = require("../../infra/slurm/slurm-client");

const GPU_MONITOR_INTERVAL_MS = 2 * 1000;
const GPU_MONITOR_MAX_DURATION_MS = 10 * 60 * 1000;

function handleGpuCardAction(runtime, action, normalized) {
  if (!action?.action) {
    return runtime.buildCardToast("无法识别 GPU 操作。");
  }

  if (action.action === "view_job" && !normalizeJobId(action.jobId)) {
    return runtime.buildCardToast("未读取到有效作业 ID。");
  }

  const feedback = action.action === "view_job"
    ? "正在读取 GPU 信息..."
    : action.action === "stop_monitor"
      ? "正在停止 GPU 监控..."
      : action.action === "back_to_job_list"
        ? "正在返回作业列表..."
        : "";

  runtime.runCardActionTask((async () => {
    if (action.action === "view_job") {
      await openGpuMonitor(runtime, normalized, {
        jobId: action.jobId,
        messageId: normalized.messageId,
      });
      return;
    }

    if (action.action === "stop_monitor") {
      await stopGpuMonitorForChat(runtime, normalized.chatId, {
        resolutionText: "监控已停止。",
        expectedMessageId: normalized.messageId,
      });
      return;
    }

    if (action.action === "back_to_job_list") {
      await stopGpuMonitorForChat(runtime, normalized.chatId, {
        suppressPatch: true,
        expectedMessageId: normalized.messageId,
      });
      await showGpuJobList(runtime, normalized, {
        patchMessageId: normalized.messageId,
        noticeText: "已返回作业列表。",
      });
      return;
    }

    throw new Error("未支持的 GPU 操作");
  })().catch((error) => {
    runtime.sendCardActionFeedbackByContext(normalized, formatFailureText("处理失败", error), "error");
  }));

  return feedback ? runtime.buildCardToast(feedback) : runtime.buildCardResponse({});
}

async function showGpuJobList(runtime, normalized, { replyToMessageId = "", patchMessageId = "", noticeText = "" } = {}) {
  try {
    const userName = slurmClient.getCurrentUsername();
    const jobs = await slurmClient.listRunningGpuJobsForUser(userName);
    const card = runtime.buildGpuJobListCard({
      jobs,
      userName,
      noticeText,
    });
    if (patchMessageId) {
      await runtime.patchInteractiveCard({
        messageId: patchMessageId,
        card,
      });
      return;
    }

    await runtime.sendInteractiveCard({
      chatId: normalized.chatId,
      replyToMessageId: replyToMessageId || normalized.messageId,
      card,
    });
  } catch (error) {
    if (patchMessageId) {
      await runtime.patchInteractiveCard({
        messageId: patchMessageId,
        card: runtime.buildGpuMonitorCard({
          job: {
            jobId: "",
            jobName: "GPU 作业列表",
            runTime: "",
            nodeList: "",
          },
          gpuLines: [],
          updatedAtText: "",
          statusText: formatFailureText("查询作业失败", error),
          state: "terminal",
        }),
      });
      return;
    }
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: replyToMessageId || normalized.messageId,
      text: formatFailureText("查询作业失败", error),
    });
  }
}

async function openGpuMonitor(runtime, normalized, { jobId, messageId }) {
  const normalizedJobId = normalizeJobId(jobId);
  if (!normalizedJobId || !messageId) {
    throw new Error("监控参数不完整");
  }

  const activeMonitor = runtime.gpuMonitorByChatId.get(normalized.chatId) || null;
  if (activeMonitor && activeMonitor.messageId !== messageId) {
    await stopGpuMonitorForChat(runtime, normalized.chatId, {
      resolutionText: "已切换到其他作业监控。",
    });
  }

  const userName = slurmClient.getCurrentUsername();
  let job;
  try {
    job = await slurmClient.getJobDetails(normalizedJobId, { userName });
  } catch (error) {
    await runtime.patchInteractiveCard({
      messageId,
      card: runtime.buildGpuMonitorCard({
        job: buildFallbackJobSummary(normalizedJobId),
        gpuLines: [],
        updatedAtText: "",
        statusText: "作业已结束或不可见。",
        state: "terminal",
      }),
    });
    return;
  }

  const validationError = validateMonitorableJob(job, userName);
  if (validationError) {
    await runtime.patchInteractiveCard({
      messageId,
      card: runtime.buildGpuMonitorCard({
        job,
        gpuLines: [],
        updatedAtText: "",
        statusText: validationError,
        state: "terminal",
      }),
    });
    return;
  }

  const monitorId = `${normalizedJobId}:${Date.now()}`;
  const entry = {
    monitorId,
    chatId: normalized.chatId,
    messageId,
    jobId: normalizedJobId,
    userName,
    startedAt: Date.now(),
    expiresAt: Date.now() + GPU_MONITOR_MAX_DURATION_MS,
    job,
    lastGpuLines: [],
    lastUpdatedAt: "",
    lastError: "",
  };
  runtime.gpuMonitorByChatId.set(normalized.chatId, entry);

  await runtime.patchInteractiveCard({
    messageId,
    card: runtime.buildGpuMonitorCard({
      job,
      gpuLines: [],
      updatedAtText: "",
      statusText: "正在读取 GPU 信息...",
      state: "active",
    }),
  });

  await refreshGpuMonitor(runtime, normalized.chatId, monitorId, {
    initialJob: job,
  });
}

async function refreshGpuMonitor(runtime, chatId, monitorId, { initialJob = null } = {}) {
  const monitor = runtime.gpuMonitorByChatId.get(chatId);
  if (!monitor || monitor.monitorId !== monitorId) {
    return;
  }

  if (Date.now() >= monitor.expiresAt) {
    await stopGpuMonitorForChat(runtime, chatId, {
      resolutionText: "监控已自动结束（已达到 10 分钟上限）。",
      expectedMonitorId: monitorId,
    });
    return;
  }

  let job = initialJob;
  if (!job) {
    try {
      job = await slurmClient.getJobDetails(monitor.jobId, { userName: monitor.userName });
    } catch {
      await stopGpuMonitorForChat(runtime, chatId, {
        resolutionText: "作业已结束或不可见。",
        expectedMonitorId: monitorId,
      });
      return;
    }
  }

  const validationError = validateMonitorableJob(job, monitor.userName);
  if (validationError) {
    await stopGpuMonitorForChat(runtime, chatId, {
      resolutionText: validationError,
      expectedMonitorId: monitorId,
      job,
    });
    return;
  }

  monitor.job = job;
  runtime.gpuMonitorByChatId.set(chatId, monitor);

  try {
    const gpuSnapshots = await slurmClient.queryJobGpuSnapshot(monitor.jobId, {
      allowedGpuIds: job.assignedGpuIds,
      userName: monitor.userName,
    });
    const gpuLines = gpuSnapshots.map((item) => formatCompactGpuLine(item));
    monitor.lastGpuLines = gpuLines;
    monitor.lastUpdatedAt = new Date().toISOString();
    monitor.lastError = "";

    if (!isActiveMonitor(runtime, chatId, monitorId)) {
      return;
    }

    await runtime.patchInteractiveCard({
      messageId: monitor.messageId,
      card: runtime.buildGpuMonitorCard({
        job,
        gpuLines,
        updatedAtText: formatMonitorTimestamp(monitor.lastUpdatedAt),
        statusText: "",
        state: "active",
      }),
    });
  } catch (error) {
    monitor.lastError = extractErrorMessage(error);
    if (!monitor.lastUpdatedAt) {
      monitor.lastUpdatedAt = new Date().toISOString();
    }

    if (!isActiveMonitor(runtime, chatId, monitorId)) {
      return;
    }

    await runtime.patchInteractiveCard({
      messageId: monitor.messageId,
      card: runtime.buildGpuMonitorCard({
        job,
        gpuLines: monitor.lastGpuLines,
        updatedAtText: formatMonitorTimestamp(monitor.lastUpdatedAt),
        statusText: `刷新失败：${monitor.lastError}（将继续重试）`,
        state: "active",
      }),
    });
  }

  runtime.gpuMonitorByChatId.set(chatId, monitor);
  scheduleNextGpuRefresh(runtime, chatId, monitorId);
}

async function stopGpuMonitorForChat(
  runtime,
  chatId,
  {
    resolutionText = "",
    suppressPatch = false,
    expectedMessageId = "",
    expectedMonitorId = "",
    job = null,
  } = {}
) {
  const monitor = runtime.gpuMonitorByChatId.get(chatId) || null;
  if (!monitor) {
    return false;
  }
  if (expectedMessageId && monitor.messageId !== expectedMessageId) {
    return false;
  }
  if (expectedMonitorId && monitor.monitorId !== expectedMonitorId) {
    return false;
  }

  clearGpuMonitorTimer(runtime, chatId);
  runtime.gpuMonitorByChatId.delete(chatId);

  if (suppressPatch) {
    return true;
  }

  await runtime.patchInteractiveCard({
    messageId: monitor.messageId,
    card: runtime.buildGpuMonitorCard({
      job: job || monitor.job || buildFallbackJobSummary(monitor.jobId),
      gpuLines: monitor.lastGpuLines,
      updatedAtText: formatMonitorTimestamp(monitor.lastUpdatedAt),
      statusText: resolutionText || "监控已结束。",
      state: "terminal",
    }),
  });
  return true;
}

function scheduleNextGpuRefresh(runtime, chatId, monitorId) {
  clearGpuMonitorTimer(runtime, chatId);
  const timer = setTimeout(() => {
    runtime.gpuMonitorTimerByChatId.delete(chatId);
    refreshGpuMonitor(runtime, chatId, monitorId).catch((error) => {
      console.error(`[codex-im] gpu monitor refresh failed: ${error.message}`);
    });
  }, GPU_MONITOR_INTERVAL_MS);
  runtime.gpuMonitorTimerByChatId.set(chatId, timer);
}

function clearGpuMonitorTimer(runtime, chatId) {
  const timer = runtime.gpuMonitorTimerByChatId.get(chatId);
  if (!timer) {
    return;
  }
  clearTimeout(timer);
  runtime.gpuMonitorTimerByChatId.delete(chatId);
}

function isActiveMonitor(runtime, chatId, monitorId) {
  const active = runtime.gpuMonitorByChatId.get(chatId);
  return !!(active && active.monitorId === monitorId);
}

function validateMonitorableJob(job, expectedUserName) {
  if (!job) {
    return "作业不存在。";
  }
  if (expectedUserName && job.userName && job.userName !== expectedUserName) {
    return "该作业不属于当前用户。";
  }
  if (job.state !== "RUNNING") {
    return "作业当前不在运行中。";
  }
  if (Number(job.numNodes || 0) > 1) {
    return "多节点作业暂不支持。";
  }
  if (!Array.isArray(job.assignedGpuIds) || !job.assignedGpuIds.length) {
    return "未读取到该作业分配的 GPU 信息。";
  }
  return "";
}

function computeColumnWidths(header, rows) {
  return header.map((label, columnIndex) => {
    const rowWidths = rows.map((row) => String(row[columnIndex] || "").length);
    return Math.max(label.length, ...rowWidths);
  });
}

function formatRow(row, widths) {
  return row.map((value, index) => String(value || "").padEnd(widths[index], " ")).join(" ");
}

function formatCompactGpuLine(snapshot) {
  const gpuId = Number.isInteger(snapshot?.index) ? snapshot.index : 0;
  const model = compactGpuName(snapshot?.name || "");
  const powerDraw = formatNumber(snapshot?.powerDraw);
  const powerLimit = formatNumber(snapshot?.powerLimit);
  const memoryUsed = formatInteger(snapshot?.memoryUsed);
  const memoryTotal = formatInteger(snapshot?.memoryTotal);
  const utilization = formatInteger(snapshot?.utilization);
  return `${gpuId} ${model} ${powerDraw}/${powerLimit}W ${memoryUsed}/${memoryTotal}MiB ${utilization}%`;
}

function compactGpuName(value) {
  const normalized = String(value || "").replace(/^NVIDIA\s+/i, "").trim();
  if (!normalized) {
    return "GPU";
  }
  return normalized.split(/\s+/)[0].toUpperCase();
}

function formatMonitorTimestamp(value) {
  const timestamp = Date.parse(String(value || ""));
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return "";
  }
  return new Date(timestamp).toISOString().replace("T", " ").slice(0, 19);
}

function buildFallbackJobSummary(jobId) {
  return {
    jobId: normalizeJobId(jobId),
    jobName: "未知作业",
    runTime: "",
    nodeList: "",
  };
}

function truncateText(value, limit) {
  const text = String(value || "");
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, Math.max(0, limit - 3))}...`;
}

function normalizeJobId(value) {
  const normalized = String(value || "").trim();
  return /^\d+$/.test(normalized) ? normalized : "";
}

function formatNumber(value) {
  const parsed = Number.parseFloat(String(value || ""));
  return Number.isFinite(parsed) ? Math.round(parsed) : 0;
}

function formatInteger(value) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

module.exports = {
  handleGpuCardAction,
  stopGpuMonitorForChat,
};
