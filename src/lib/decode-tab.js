// 解码 Tab — AVI 选择 + 文件提取
"use strict";

import { fmt } from "./f2v-core.js";
import { clone } from "./template.js";
import { swSend } from "./sw-client.js";
import { showToast } from "./ui-shell.js";
import { addTask, updateTask } from "./task-manager.js";

const decInput = document.getElementById("decInput");
const decDrop = document.getElementById("decDrop");
const decPwd = document.getElementById("decPwdInput");
const decBtn = document.getElementById("decBtn");
const decClearBtn = document.getElementById("decClearBtn");
const decFileList = document.getElementById("decFileList");
const decText = document.getElementById("decText");
const decHint = document.getElementById("decHint");

let aviBlob = null;
let entries = null;
let jobId = null;

// ── 拖放 / 选择 ──

decInput.addEventListener("change", () => handleFile(decInput.files[0]));
decDrop.addEventListener("dragover", (e) => { e.preventDefault(); decDrop.classList.add("drag-over"); });
decDrop.addEventListener("dragleave", () => decDrop.classList.remove("drag-over"));
decDrop.addEventListener("drop", (e) => { e.preventDefault(); decDrop.classList.remove("drag-over"); handleFile(e.dataTransfer.files[0]); });

function handleFile(file) {
  if (!file) return;
  aviBlob = file;
  decText.textContent = file.name + " (" + fmt(file.size) + ")";
  decHint.textContent = "分析中...";
  decBtn.disabled = false;
  entries = null;
  decFileList.style.display = "none";
  decFileList.innerHTML = "";
}

// ── 提取 ──

decBtn.addEventListener("click", async () => {
  if (!aviBlob) return;
  const pwd = decPwd.value;
  decBtn.disabled = true;
  decHint.textContent = "正在提取...";

  jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  addTask(jobId, "decode", aviBlob.name);

  swSend({
    type: "f2v-decode",
    jobId,
    fileName: aviBlob.name,
    fileSize: aviBlob.size,
    password: pwd,
  });
});

// ── 清空 ──

decClearBtn.addEventListener("click", () => {
  aviBlob = null;
  entries = null;
  decInput.value = "";
  decText.textContent = "拖放 AVI 文件，或点击选择";
  decHint.textContent = "F2V1 格式的 AVI 文件";
  decBtn.disabled = true;
  decFileList.style.display = "none";
  decFileList.innerHTML = "";
});

// ── 单独下载 ──

function triggerDownload(jobId, idx) {
  swSend({ type: "f2v-download", jobId, idx });
}

function batchDownload() {
  if (!jobId) return;
  const cbs = decFileList.querySelectorAll(".dec-file-cb:checked");
  cbs.forEach((cb) => {
    const idx = parseInt(cb.dataset.idx);
    if (!isNaN(idx)) triggerDownload(jobId, idx);
  });
}

// ── SW 消息 ──

navigator.serviceWorker.addEventListener("message", (e) => {
  const msg = e.data;
  if (!msg) return;
  switch (msg.type) {
    case "f2v-decode-result":
      entries = msg.entries;
      jobId = msg.jobId;
      renderDecFileList();
      decHint.textContent = entries.length + " 个文件";
      decBtn.disabled = false;
      break;
    case "job-new":
      if (msg.kind === "decode") addTask(msg.jobId, "decode", msg.label);
      break;
    case "job-progress":
      updateTask(msg.jobId, msg);
      break;
    case "job-done":
      updateTask(msg.jobId, { progress: 100, status: "done" });
      break;
    case "job-error":
      updateTask(msg.jobId, { status: "error", error: msg.error });
      if (msg.jobId === jobId) {
        decBtn.disabled = false;
        decHint.textContent = "❌ " + msg.error;
      }
      break;
  }
});

function renderDecFileList() {
  if (!entries || !entries.length) return;
  decFileList.style.display = "";
  decFileList.innerHTML = "";

  const container = clone("dec-file-container");
  container.querySelector(".dec-file-summary").textContent = entries.length + " 个文件";
  container.querySelector(".select-all-dec").addEventListener("change", (e) => {
    decFileList.querySelectorAll(".dec-file-cb").forEach((cb) => cb.checked = e.target.checked);
    updateSelectedCount();
  });
  container.querySelector(".btn-batch-dl").addEventListener("click", batchDownload);

  const body = container.querySelector(".dec-file-body");
  entries.forEach((e, i) => {
    const item = clone("dec-file-item");
    item.querySelector(".dec-file-cb").dataset.idx = i;
    item.querySelector(".name").textContent = e.name;
    item.querySelector(".size").textContent = fmt(e.size);
    item.querySelector(".dl-btn").addEventListener("click", () => triggerDownload(jobId, i));
    body.appendChild(item);
  });

  decFileList.appendChild(container);
  updateSelectedCount();
}

function updateSelectedCount() {
  const checked = decFileList.querySelectorAll(".dec-file-cb:checked").length;
  const el = decFileList.querySelector(".dec-selected-count");
  if (el) el.textContent = "已选 " + checked + " / " + (entries?.length || 0);
}