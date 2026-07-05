// 编码 Tab — 文件选择 + 分辨率设置 + 生成 AVI
// 文件对象直接 postMessage 给 SW（File 跨进程传的是句柄，不传数据）
"use strict";

import { fmt, precomputeFrames } from "./f2v-core.js";
import { clone } from "./template.js";
import { swSend } from "./sw-client.js";
import { showToast, getChunkSize, showTab } from "./ui-shell.js";

const encInput = document.getElementById("encInput");
const encDrop = document.getElementById("encDrop");
const encPwd = document.getElementById("encPwdInput");
const encBtn = document.getElementById("encBtn");
const clearBtn = document.getElementById("clearBtn");
const fileList = document.getElementById("fileList");
const encResolution = document.getElementById("encResolution");
const encFps = document.getElementById("encFps");
const encInfo = document.getElementById("encInfo");

let files = [];

// ── 拖放 / 选择 ──

encInput.addEventListener("change", () => addFiles(encInput.files));
encDrop.addEventListener("dragover", (e) => {
  e.preventDefault();
  encDrop.classList.add("drag-over");
});
encDrop.addEventListener("dragleave", () =>
  encDrop.classList.remove("drag-over"),
);
encDrop.addEventListener("drop", (e) => {
  e.preventDefault();
  encDrop.classList.remove("drag-over");
  addFiles(e.dataTransfer.files);
});

function addFiles(newFiles) {
  for (const f of newFiles) {
    // 按文件名去重
    const dup = files.some((e) => e.name === f.name);
    if (!dup) files.push(f);
  }
  renderFileList();
  encBtn.disabled = files.length === 0;
  updateInfo();
}

// ── 文件列表 ──

function renderFileList() {
  fileList.style.display = files.length ? "" : "none";
  fileList.innerHTML = "";
  if (files.length === 0) return;

  const container = clone("enc-file-container");
  let summary = "共 " + files.length + " 个文件";
  try {
    const { w, h } = getRes();
    const fi = precomputeFrames(files, w, h);
    summary += " · " + fmt(fi.fileTotalData) + " · " + fi.totalFrames + " 帧";
  } catch (e) {
    summary += " · " + fmt(files.reduce((s, f) => s + f.size, 0));
  }
  container.querySelector(".enc-file-summary").textContent = summary;
  const body = container.querySelector(".enc-file-body");
  files.forEach((f, i) => {
    const item = clone("enc-file-item");
    item.querySelector(".idx").textContent = i + 1;
    item.querySelector(".name").textContent = f.name;
    item.querySelector(".size").textContent = fmt(f.size);
    item.querySelector(".file-remove").addEventListener("click", () => {
      files.splice(i, 1);
      renderFileList();
      encBtn.disabled = files.length === 0;
      updateInfo();
    });
    body.appendChild(item);
  });
  fileList.appendChild(container);
}

// ── 信息行 ──

function getRes() {
  const v = encResolution.value;
  const parts = v.split("x");
  return { w: parseInt(parts[0]) || 640, h: parseInt(parts[1]) || 320 };
}

function updateInfo() {
  // 信息已整合到文件列表头部，encInfo 留空
  encInfo.textContent = "";
}

[encResolution, encFps].forEach((el) =>
  el.addEventListener("change", updateInfo),
);

// ── 生成 ──

encBtn.addEventListener("click", async () => {
  if (files.length === 0) return;
  const pwd = encPwd.value;
  const { w, h } = getRes();
  const fps = parseInt(encFps.value) || 30;

  let frameInfo;
  try {
    frameInfo = precomputeFrames(files, w, h);
  } catch (e) {
    showToast("⚠ " + e.message);
    return;
  }

  const jobId =
    Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const CHUNK = getChunkSize();

  swSend({
    type: "f2v-encode",
    jobId,
    files,
    password: pwd,
    w,
    h,
    fps,
    chunkSize: CHUNK,
    frameInfo: {
      totalFrames: frameInfo.totalFrames,
      fileListSize: frameInfo.fileListSize,
      fileTotalData: frameInfo.fileTotalData,
      frames: frameInfo.frames,
      nameBufs: frameInfo.nameBufs,
      bytesPerFrame: frameInfo.bytesPerFrame,
      fileCount: frameInfo.fileCount,
    },
  });

  // 清空文件列表并跳转到任务列表
  files = [];
  renderFileList();
  encBtn.disabled = true;
  encInfo.textContent = "";
  showTab("tasks");
});

// ── 清空 ──

clearBtn.addEventListener("click", () => {
  files = [];
  renderFileList();
  encBtn.disabled = true;
  encInfo.textContent = "";
});

// ── SW 消息（仅处理 f2v-encode-ready 下载触发器） ──

import { onSWMessage } from "./sw-client.js";

onSWMessage("f2v-encode-ready", (msg) => {
  const dlUrl = "/files?id=" + msg.jobId;
  const f = document.createElement("iframe");
  f.style.display = "none";
  document.body.appendChild(f);
  f.src = dlUrl;
  setTimeout(() => {
    if (f.parentNode) f.remove();
  }, 30000);
  showToast("下载: " + msg.fileName);
});
