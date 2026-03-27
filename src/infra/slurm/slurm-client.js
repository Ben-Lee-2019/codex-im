const os = require("os");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const DEFAULT_TIMEOUT_MS = 10 * 1000;
const GPU_QUERY_TIMEOUT_MS = 15 * 1000;
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const CACHE_DIRECTORY = process.env.CODEX_IM_SLURM_CACHE_DIR || "/tmp/codex-im-slurm-cache";
const CACHE_PREFERRED = /^(1|true|yes|on)$/i.test(String(process.env.CODEX_IM_SLURM_CACHE_PREFERRED || ""));

function getCurrentUsername() {
  const envUser = normalizeText(process.env.USER || process.env.LOGNAME || "");
  if (envUser) {
    return envUser;
  }
  try {
    return normalizeText(os.userInfo()?.username || "");
  } catch {
    return "";
  }
}

async function listUserJobs(userName) {
  const normalizedUser = normalizeText(userName);
  if (!normalizedUser) {
    throw new Error("无法确定当前系统用户名");
  }

  const cache = loadCache(normalizedUser);
  if (CACHE_PREFERRED && cache?.squeueStdout) {
    return parseSqueueOutput(cache.squeueStdout);
  }

  try {
    const stdout = await execCommand("squeue", [
      "-h",
      "-u",
      normalizedUser,
      "-o",
      "%i\t%t\t%j\t%M\t%R",
    ]);
    return parseSqueueOutput(stdout);
  } catch (error) {
    if (cache?.squeueStdout) {
      return parseSqueueOutput(cache.squeueStdout);
    }
    throw error;
  }
}

async function listRunningGpuJobsForUser(userName) {
  const normalizedUser = normalizeText(userName);
  const jobs = await listUserJobs(normalizedUser);
  const runningJobs = jobs.filter((job) => job.state === "R");
  if (!runningJobs.length) {
    return [];
  }

  const detailedJobs = await Promise.all(runningJobs.map(async (job) => {
    try {
      const detail = await getJobDetails(job.jobId, { userName: normalizedUser });
      if (!detail.hasGpuAllocation || detail.state !== "RUNNING") {
        return null;
      }
      if (detail.userName && normalizedUser && detail.userName !== normalizedUser) {
        return null;
      }
      return {
        ...job,
        ...detail,
      };
    } catch (error) {
      console.warn(`[codex-im] failed to inspect slurm job ${job.jobId}: ${error.message}`);
      return null;
    }
  }));

  return detailedJobs.filter(Boolean);
}

async function getJobDetails(jobId, { userName = "" } = {}) {
  const normalizedJobId = normalizeJobId(jobId);
  if (!normalizedJobId) {
    throw new Error("作业 ID 无效");
  }

  const cache = loadCache(userName);
  const cachedText = cache?.jobDetails?.[normalizedJobId];
  if (CACHE_PREFERRED && cachedText) {
    return parseScontrolJob(cachedText, normalizedJobId);
  }

  try {
    const stdout = await execCommand("scontrol", ["show", "job", "-dd", normalizedJobId]);
    return parseScontrolJob(stdout, normalizedJobId);
  } catch (error) {
    if (cachedText) {
      return parseScontrolJob(cachedText, normalizedJobId);
    }
    throw error;
  }
}

async function queryJobGpuSnapshot(jobId, { allowedGpuIds = [], userName = "" } = {}) {
  const normalizedJobId = normalizeJobId(jobId);
  if (!normalizedJobId) {
    throw new Error("作业 ID 无效");
  }

  const cache = loadCache(userName);
  const cachedText = cache?.gpuSnapshots?.[normalizedJobId];
  let snapshots = [];
  if (CACHE_PREFERRED && cachedText) {
    snapshots = parseGpuSnapshotOutput(cachedText);
  } else {
    try {
      const stdout = await execCommand(
        "srun",
        [
          "--jobid",
          normalizedJobId,
          "--overlap",
          "--ntasks=1",
          "nvidia-smi",
          "--query-gpu=index,name,power.draw,power.limit,utilization.gpu,memory.used,memory.total",
          "--format=csv,noheader,nounits",
        ],
        {
          timeoutMs: GPU_QUERY_TIMEOUT_MS,
        }
      );
      snapshots = parseGpuSnapshotOutput(stdout);
    } catch (error) {
      if (!cachedText) {
        throw error;
      }
      snapshots = parseGpuSnapshotOutput(cachedText);
    }
  }

  const normalizedAllowedIds = Array.isArray(allowedGpuIds)
    ? allowedGpuIds.filter((value) => Number.isInteger(value))
    : [];

  if (!normalizedAllowedIds.length) {
    return snapshots;
  }

  const allowedSet = new Set(normalizedAllowedIds);
  return snapshots.filter((item) => allowedSet.has(item.index));
}

function parseSqueueOutput(stdout) {
  return String(stdout || "")
    .split(/\r?\n/)
    .map((line) => parseSqueueLine(line))
    .filter(Boolean);
}

function parseSqueueLine(line) {
  const raw = String(line || "").trim();
  if (!raw) {
    return null;
  }

  const parts = raw.split("\t");
  if (parts.length < 5) {
    return null;
  }

  return {
    jobId: normalizeJobId(parts[0]),
    state: normalizeText(parts[1]),
    name: normalizeText(parts[2]) || "未命名作业",
    time: normalizeText(parts[3]) || "0:00",
    nodeList: normalizeText(parts[4]) || "-",
  };
}

function parseScontrolJob(stdout, fallbackJobId = "") {
  const text = String(stdout || "");
  const nodeAssignments = extractNodeAssignments(text);
  const primaryAssignment = nodeAssignments[0] || null;
  const assignedGpuIds = primaryAssignment?.gpuIds || [];
  const gpuResource = extractSimpleField(text, "JOB_GRES");

  return {
    jobId: normalizeJobId(extractSimpleField(text, "JobId") || fallbackJobId),
    jobName: normalizeText(extractSimpleField(text, "JobName")) || "未命名作业",
    userName: parseUserName(extractSimpleField(text, "UserId")),
    state: normalizeText(extractSimpleField(text, "JobState")).toUpperCase(),
    runTime: normalizeText(extractSimpleField(text, "RunTime")) || "0:00",
    nodeList: normalizeText(extractSimpleField(text, "NodeList")) || "-",
    numNodes: parseInteger(extractSimpleField(text, "NumNodes")),
    gpuResource,
    gpuModel: parseGpuModel(gpuResource),
    hasGpuAllocation: hasGpuAllocation(text, nodeAssignments),
    assignedGpuIds,
    nodeAssignments,
  };
}

function extractNodeAssignments(text) {
  const assignments = [];
  const lines = String(text || "").split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.startsWith("Nodes=")) {
      continue;
    }

    const nodeName = normalizeText(extractLineField(line, "Nodes"));
    const gres = normalizeText(extractLineField(line, "GRES"));
    assignments.push({
      nodeName,
      gres,
      gpuIds: extractGpuIdsFromGres(gres),
    });
  }

  return assignments;
}

function parseGpuSnapshotLine(line) {
  const raw = String(line || "").trim();
  if (!raw) {
    return null;
  }

  const parts = raw.split(",").map((part) => part.trim());
  if (parts.length < 7) {
    return null;
  }

  return {
    index: parseInteger(parts[0]),
    name: normalizeText(parts[1]),
    powerDraw: parseFloatValue(parts[2]),
    powerLimit: parseFloatValue(parts[3]),
    utilization: parseInteger(parts[4]),
    memoryUsed: parseInteger(parts[5]),
    memoryTotal: parseInteger(parts[6]),
  };
}

function parseGpuSnapshotOutput(stdout) {
  return String(stdout || "")
    .split(/\r?\n/)
    .map((line) => parseGpuSnapshotLine(line))
    .filter(Boolean);
}

function hasGpuAllocation(text, nodeAssignments) {
  if (Array.isArray(nodeAssignments) && nodeAssignments.some((item) => item.gpuIds.length)) {
    return true;
  }
  return /gres\/gpu=\d+/i.test(String(text || "")) || /JOB_GRES=gpu:/i.test(String(text || ""));
}

function parseUserName(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return "";
  }
  const index = normalized.indexOf("(");
  return index >= 0 ? normalized.slice(0, index) : normalized;
}

function parseGpuModel(resourceText) {
  const normalized = normalizeText(resourceText);
  if (!normalized) {
    return "";
  }
  const match = normalized.match(/^gpu:([^:()]+)/i);
  return match ? match[1].toUpperCase() : "";
}

function extractGpuIdsFromGres(gres) {
  const normalized = normalizeText(gres);
  if (!normalized) {
    return [];
  }
  const match = normalized.match(/IDX:([^)]+)/i);
  if (!match) {
    return [];
  }
  return parseIndexExpression(match[1]);
}

function parseIndexExpression(value) {
  const parts = String(value || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const output = [];
  const seen = new Set();

  for (const part of parts) {
    const cleaned = part.replace(/[^0-9-]/g, "");
    if (!cleaned) {
      continue;
    }
    const rangeMatch = cleaned.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      if (!Number.isFinite(start) || !Number.isFinite(end)) {
        continue;
      }
      const lower = Math.min(start, end);
      const upper = Math.max(start, end);
      for (let current = lower; current <= upper; current += 1) {
        if (!seen.has(current)) {
          seen.add(current);
          output.push(current);
        }
      }
      continue;
    }

    const single = Number(cleaned);
    if (Number.isFinite(single) && !seen.has(single)) {
      seen.add(single);
      output.push(single);
    }
  }

  return output.sort((left, right) => left - right);
}

function extractSimpleField(text, fieldName) {
  const match = String(text || "").match(new RegExp(`(?:^|\\s)${escapeRegExp(fieldName)}=([^\\s]+)`));
  return match ? match[1] : "";
}

function extractLineField(line, fieldName) {
  const match = String(line || "").match(new RegExp(`${escapeRegExp(fieldName)}=([^\\s]+)`));
  return match ? match[1] : "";
}

function normalizeJobId(value) {
  const normalized = normalizeText(value);
  return /^\d+$/.test(normalized) ? normalized : "";
}

function parseInteger(value) {
  const parsed = Number.parseInt(String(value || "").trim(), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseFloatValue(value) {
  const parsed = Number.parseFloat(String(value || "").trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function execCommand(command, args, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: MAX_BUFFER_BYTES,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = normalizeText(stderr) || normalizeText(stdout) || normalizeText(error.message);
          reject(new Error(detail || `${command} 执行失败`));
          return;
        }
        resolve(String(stdout || ""));
      }
    );
  });
}

function loadCache(userName) {
  const normalizedUser = normalizeText(userName) || getCurrentUsername();
  if (!normalizedUser) {
    return null;
  }
  const cachePath = path.join(CACHE_DIRECTORY, `${normalizedUser}.json`);
  try {
    const raw = fs.readFileSync(cachePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

module.exports = {
  getCurrentUsername,
  getJobDetails,
  listRunningGpuJobsForUser,
  listUserJobs,
  parseGpuModel,
  queryJobGpuSnapshot,
};
