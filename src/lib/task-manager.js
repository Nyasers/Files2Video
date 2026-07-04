// 任务管理器 — 编码/解码任务列表 UI
"use strict";

import { clone } from "./template.js";
import { showToast } from "./ui-shell.js";

const tasksList = document.getElementById("tasksList");
const tasks = new Map();

export function addTask(jobId, kind, label) {
  const node = clone("task-item");
  if (!node) return;
  const el = node.firstElementChild;
  if (!el) return;
  el.querySelector(".task-kind").textContent =
    kind === "encode" ? "🎬 编码" : "📂 解码";
  el.querySelector(".task-label").textContent = label || "";
  el.querySelector(".task-file").textContent = "";
  el.querySelector(".tbar").style.width = "0%";
  el.querySelector(".task-pct").textContent = "0%";

  const empty = tasksList.querySelector(".tasks-empty");
  if (empty) empty.remove();

  tasksList.appendChild(node);
  tasks.set(jobId, {
    el,
    kind,
    progress: 0,
    status: "running",
  });
}

export function updateTask(jobId, data) {
  const t = tasks.get(jobId);
  if (!t) return;
  if (data.progress != null) {
    t.progress = data.progress;
    t.el.querySelector(".tbar").style.width = data.progress + "%";
    t.el.querySelector(".task-pct").textContent = data.progress + "%";
  }
  if (data.currentFile != null) {
    t.el.querySelector(".task-file").textContent = data.currentFile;
  }
  if (data.status) {
    t.status = data.status;
    const statusEl = t.el.querySelector(".task-status");
    if (data.status === "done") {
      statusEl.textContent = "✅ 完成";
      statusEl.className = "task-status ok";
      t.el.classList.add("history");
    } else if (data.status === "error") {
      statusEl.textContent = "❌ " + (data.error || "失败");
      statusEl.className = "task-status err";
      t.el.classList.add("history");
    } else if (data.status === "cancelled") {
      statusEl.textContent = "⏹ 已取消";
      statusEl.className = "task-status";
      t.el.classList.add("history");
    }
  }
  if (data.fileName) {
    t.el.querySelector(".task-file").textContent = data.fileName;
  }
}

export function clearTasks() {
  tasksList.innerHTML = '<div class="tasks-empty">暂无任务</div>';
  tasks.clear();
}
