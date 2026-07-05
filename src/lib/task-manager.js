// 任务管理 — 任务列表渲染 + Job 状态回调
// 与 F2P 同步模式：全量渲染 + 历史保留
"use strict";

import { clone } from "./template.js";
import {
  swSend,
  onSWMessage,
  onSWReady,
  onControllerChange,
} from "./sw-client.js";
import { showToast } from "./ui-shell.js";

// ── Job 状态存储 ──

const jobHandlers = new Map();
const taskHistory = []; // 保留最近 50 条历史
const tasksList = document.getElementById("tasksList");

function renderEmpty() {
  tasksList.innerHTML = "";
  const t = document.getElementById("tasks-empty");
  if (t) tasksList.appendChild(t.content.cloneNode(true));
}

export function refreshTasks() {
  swSend({ type: "list-jobs" });
}

onSWReady(refreshTasks);
onControllerChange(refreshTasks);

// ── 全量渲染（新增任务 / sync 时用）──

function renderTasks() {
  const running = Array.from(jobHandlers.entries()).filter(
    ([, j]) => j.status === "running",
  );
  const items = [];

  for (const [jobId, job] of running) {
    items.push({ jobId, job, isHistory: false });
  }
  for (const h of taskHistory) {
    items.push({ jobId: h.jobId, job: h, isHistory: true });
  }

  if (!items.length) {
    renderEmpty();
    return;
  }

  items.sort((a, b) => {
    if (a.isHistory !== b.isHistory) return a.isHistory ? 1 : -1;
    if (!a.isHistory) return (b.jobId || "").localeCompare(a.jobId || "");
    return 0;
  });

  const frag = document.createDocumentFragment();
  for (const { jobId, job, isHistory } of items) {
    const pct = job.progress || 0;
    const node = clone("task-item");
    const div = node.firstElementChild;
    if (!div) continue;
    div.dataset.jobId = jobId;

    node.querySelector(".task-kind").textContent =
      job.kind === "encode" ? "🎬 编码" : "📂 解码";

    if (isHistory) div.classList.add("history");

    const labelEl = node.querySelector(".task-label");
    if (labelEl) {
      if (job.label) labelEl.textContent = job.label;
      else labelEl.remove();
    }

    const fileEl = node.querySelector(".task-file");
    if (fileEl) {
      fileEl.textContent = job.currentFile || "";
      fileEl.style.display = job.currentFile ? "" : "none";
    }

    const statusEl = node.querySelector(".task-status");
    if (statusEl) {
      if (!isHistory) {
        statusEl.textContent = "运行中…";
        statusEl.className = "task-status";
      } else if (job.status === "done") {
        statusEl.textContent = "✅ 完成";
        statusEl.className = "task-status ok";
      } else if (job.status === "error") {
        statusEl.textContent = "❌ " + (job.error || "失败");
        statusEl.className = "task-status err";
      } else if (job.status === "cancelled") {
        statusEl.textContent = "⏹ 已取消";
        statusEl.className = "task-status";
      }
    }

    const bar = node.querySelector(".tbar");
    if (bar)
      bar.style.width = (isHistory && job.status === "done" ? 100 : pct) + "%";
    const pctEl = node.querySelector(".task-pct");
    if (pctEl)
      pctEl.textContent =
        (isHistory && job.status === "done" ? 100 : pct) + "%";

    frag.appendChild(node);
  }
  tasksList.innerHTML = "";
  tasksList.appendChild(frag);
}

// ── 增量更新：只更新进度条和文件名 ──

function updateTaskProgress(jobId, progress, currentFile) {
  const item = document.querySelector(
    '.task-item[data-job-id="' + jobId + '"]',
  );
  if (!item) return;
  const bar = item.querySelector(".tbar");
  if (bar) bar.style.width = progress + "%";
  const pct = item.querySelector(".task-pct");
  if (pct) pct.textContent = progress + "%";
  const fileEl = item.querySelector(".task-file");
  if (fileEl) {
    fileEl.textContent = currentFile || "";
    fileEl.style.display = currentFile ? "" : "none";
  }
}

// ── 回调 ──

function handleJobNew(msg) {
  jobHandlers.set(msg.jobId, {
    jobId: msg.jobId,
    kind: msg.kind,
    status: "running",
    progress: 0,
    label: msg.label,
    currentFile: "",
  });
  renderTasks();
}

function handleJobProgress(msg) {
  const job = jobHandlers.get(msg.jobId);
  if (!job) return;
  job.progress = msg.progress;
  if (msg.currentFile) job.currentFile = msg.currentFile;
  updateTaskProgress(msg.jobId, msg.progress, msg.currentFile);
}

function handleJobDone(msg) {
  const job = jobHandlers.get(msg.jobId);
  if (!job) return;
  job.status = "done";
  job.progress = 100;
  jobHandlers.delete(msg.jobId);
  taskHistory.unshift({
    jobId: msg.jobId,
    kind: job.kind,
    status: "done",
    progress: 100,
    label: job.label
      ? job.label.replace(" → AVI", " 完成")
      : msg.fileName || "完成",
    currentFile: "",
    error: null,
  });
  if (taskHistory.length > 50) taskHistory.length = 50;
  renderTasks();
  showToast("✅ 编码完成");
}

function handleJobError(msg) {
  const job = jobHandlers.get(msg.jobId);
  if (!job) return;
  jobHandlers.delete(msg.jobId);
  taskHistory.unshift({
    jobId: msg.jobId,
    kind: job.kind,
    status: "error",
    progress: job.progress || 0,
    label: job.label || "",
    currentFile: job.currentFile || "",
    error: msg.error,
  });
  if (taskHistory.length > 50) taskHistory.length = 50;
  renderTasks();
  showToast("❌ " + msg.error);
}

function handleJobCancelled(msg) {
  const job = jobHandlers.get(msg.jobId);
  if (job) {
    jobHandlers.delete(msg.jobId);
    taskHistory.unshift({
      jobId: msg.jobId,
      kind: job.kind,
      status: "cancelled",
      progress: job.progress || 0,
      label: job.label || "",
      currentFile: job.currentFile || "",
      error: null,
    });
    if (taskHistory.length > 50) taskHistory.length = 50;
  }
  renderTasks();
}

function handleJobSync(j) {
  const job = jobHandlers.get(j.jobId);
  if (job) {
    Object.assign(job, j);
  } else {
    jobHandlers.set(j.jobId, { ...j });
  }
  renderTasks();
}

// ── 注册消息处理 ──

onSWMessage("job-new", handleJobNew);
onSWMessage("job-progress", handleJobProgress);
onSWMessage("job-done", handleJobDone);
onSWMessage("job-error", handleJobError);
onSWMessage("job-cancelled", handleJobCancelled);
onSWMessage("jobs-list", (msg) => {
  for (const j of msg.jobs) handleJobSync(j);
});
