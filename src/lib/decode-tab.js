// 解码 Tab — AVI 选择 + 文件提取（SW 流式解码）
"use strict";

import { fmt } from "./f2v-core.js";
import { clone } from "./template.js";
import { swSend } from "./sw-client.js";
import { showToast } from "./ui-shell.js";

const decInput = document.getElementById("decInput");
const decDrop = document.getElementById("decDrop");
const decPwd = document.getElementById("decPwdInput");
const decBtn = document.getElementById("decBtn");
const decClearBtn = document.getElementById("decClearBtn");
const decFileList = document.getElementById("decFileList");
const decText = document.getElementById("decText");
const decHint = document.getElementById("decHint");

let aviFile = null;
let currentJobId = null;

// ── 拖放 / 选择 ──

decInput.addEventListener("change", () => handleFile(decInput.files[0]));
decDrop.addEventListener("dragover", (e) => { e.preventDefault(); decDrop.classList.add("drag-over"); });
decDrop.addEventListener("dragleave", () => decDrop.classList.remove("drag-over"));
decDrop.addEventListener("drop", (e) => { e.preventDefault(); decDrop.classList.remove("drag-over"); handleFile(e.dataTransfer.files[0]); });

function handleFile(file) {
  if (!file) return;
  aviFile = file;
  currentJobId = null;
  decText.textContent = file.name + " (" + fmt(file.size) + ")";
  decHint.textContent = "F2V1 格式";
  decBtn.disabled = false;
  decFileList.style.display = "none";
  decFileList.innerHTML = "";
}

// ── 提取 ──

decBtn.addEventListener("click", () => {
  if (!aviFile) return;
  const pwd = decPwd.value;
  decBtn.disabled = true;
  decHint.textContent = "正在提取...";

  currentJobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  // 把 AVI 文件发给 SW（File 可通过 structured clone 传输）
  swSend({
    type: "f2v-decode",
    jobId: currentJobId,
    file: aviFile,
    password: pwd,
  });
});

// ── 清空 ──

decClearBtn.addEventListener("click", () => {
  aviFile = null; currentJobId = null;
  decInput.value = "";
  decText.textContent = "拖放 AVI 文件，或点击选择";
  decHint.textContent = "F2V1 格式的 AVI 文件";
  decBtn.disabled = true;
  decFileList.style.display = "none";
  decFileList.innerHTML = "";
});

// ── 触发流式下载（走 /files 路由注册后 302 → /file/hash/name） ──

function triggerDownload(idx) {
  if (!currentJobId) return;
  const dlUrl = "/files?id=" + currentJobId + "&idx=" + idx;
  const f = document.createElement("iframe");
  f.style.display = "none";
  document.body.appendChild(f);
  f.src = dlUrl;
  setTimeout(() => { if (f.parentNode) f.remove(); }, 30000);
}

function batchDownload() {
  const cbs = decFileList.querySelectorAll(".dec-file-cb:checked");
  cbs.forEach((cb) => {
    const idx = parseInt(cb.dataset.idx);
    if (!isNaN(idx)) triggerDownload(idx);
  });
}

// ── SW 消息 ──

navigator.serviceWorker.addEventListener("message", (e) => {
  const msg = e.data;
  if (!msg) return;

  switch (msg.type) {
    case "f2v-decode-result":
      if (msg.jobId !== currentJobId) return;
      decHint.textContent = msg.entries.length + " 个文件";
      renderDecFileList(msg.entries);
      decBtn.disabled = false;
      break;

    // 下载走 /files 路由 302 重定向，不再通过消息传递

    case "job-error":
      if (msg.jobId === currentJobId) {
        decHint.textContent = "❌ " + msg.error;
        decBtn.disabled = false;
        showToast("解码失败: " + msg.error);
      }
      break;
  }
});

// ── 渲染文件列表 ──

function renderDecFileList(entries) {
  if (!entries?.length) return;
  decFileList.style.display = "";
  decFileList.innerHTML = "";

  const container = clone("dec-file-container");
  container.querySelector(".dec-file-summary").textContent = entries.length + " 个文件";
  container.querySelector(".select-all-dec").addEventListener("change", (e) => {
    decFileList.querySelectorAll(".dec-file-cb").forEach((cb) => cb.checked = e.target.checked);
    updateSelectedCount(entries);
  });
  container.querySelector(".btn-batch-dl").addEventListener("click", batchDownload);

  const body = container.querySelector(".dec-file-body");
  entries.forEach((e, i) => {
    const item = clone("dec-file-item");
    item.querySelector(".dec-file-cb").dataset.idx = i;
    item.querySelector(".name").textContent = e.name;
    item.querySelector(".size").textContent = fmt(e.size);
    item.querySelector(".dl-btn").addEventListener("click", () => triggerDownload(i));
    body.appendChild(item);
  });

  decFileList.appendChild(container);
  updateSelectedCount(entries);
}

function updateSelectedCount(entries) {
  const checked = decFileList.querySelectorAll(".dec-file-cb:checked").length;
  const el = decFileList.querySelector(".dec-selected-count");
  if (el) el.textContent = "已选 " + checked + " / " + (entries?.length || 0);
}