// 编码 Tab — 文件选择 + 分辨率设置 + 生成 AVI
"use strict";

import { fmt, precomputeFrames } from "./f2v-core.js";
import { clone } from "./template.js";
import { swSend } from "./sw-client.js";
import { showToast, getChunkSize } from "./ui-shell.js";
import { addTask, updateTask } from "./task-manager.js";

const encInput = document.getElementById("encInput");
const encDrop = document.getElementById("encDrop");
const encPwd = document.getElementById("encPwdInput");
const encBtn = document.getElementById("encBtn");
const clearBtn = document.getElementById("clearBtn");
const fileList = document.getElementById("fileList");
const encWidth = document.getElementById("encWidth");
const encHeight = document.getElementById("encHeight");
const encFps = document.getElementById("encFps");
const encInfo = document.getElementById("encInfo");

let files = [];

// ── 拖放 / 选择 ──

encInput.addEventListener("change", () => addFiles(encInput.files));
encDrop.addEventListener("dragover", (e) => { e.preventDefault(); encDrop.classList.add("drag-over"); });
encDrop.addEventListener("dragleave", () => encDrop.classList.remove("drag-over"));
encDrop.addEventListener("drop", (e) => { e.preventDefault(); encDrop.classList.remove("drag-over"); addFiles(e.dataTransfer.files); });

function addFiles(newFiles) {
  for (const f of newFiles) files.push(f);
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
  container.querySelector(".enc-file-summary").textContent = files.length + " 个文件，共 " + fmt(files.reduce((s, f) => s + f.size, 0));
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

function updateInfo() {
  if (files.length === 0) { encInfo.textContent = ""; return; }
  const w = parseInt(encWidth.value) || 1920;
  const h = parseInt(encHeight.value) || 1080;
  try {
    const fi = precomputeFrames(files, w, h);
    encInfo.textContent = fi.totalFrames + " 帧 · 输出大小 ≈ " + fmt(fi.totalFrames * (8 + 28 + fi.bytesPerFrame) + fi.totalFrames * 16);
  } catch (e) {
    encInfo.textContent = "⚠ " + e.message;
  }
}

[encWidth, encHeight, encFps].forEach((el) => el.addEventListener("change", updateInfo));

// ── 生成 ──

encBtn.addEventListener("click", async () => {
  if (files.length === 0) return;
  const pwd = encPwd.value;
  const w = parseInt(encWidth.value) || 1920;
  const h = parseInt(encHeight.value) || 1080;
  const fps = parseInt(encFps.value) || 30;

  let frameInfo;
  try {
    frameInfo = precomputeFrames(files, w, h);
  } catch (e) {
    showToast("⚠ " + e.message);
    return;
  }

  const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  addTask(jobId, "encode", files.length + " 个文件 → AVI");

  const CHUNK = getChunkSize();
  swSend({
    type: "f2v-encode",
    jobId,
    files: files.map((f) => ({ name: f.name, size: f.size })),
    password: pwd,
    w,
    h,
    fps,
    chunkSize: CHUNK,
    frameInfo: { // send serializable precompute result
      totalFrames: frameInfo.totalFrames,
      fileListSize: frameInfo.fileListSize,
      fileTotalData: frameInfo.fileTotalData,
      frames: frameInfo.frames,
    },
  });
});

// ── 清空 ──

clearBtn.addEventListener("click", () => {
  files = [];
  renderFileList();
  encBtn.disabled = true;
  encInfo.textContent = "";
});

// ── SW 消息 ──

navigator.serviceWorker.addEventListener("message", (e) => {
  const msg = e.data;
  if (!msg) return;
  switch (msg.type) {
    case "job-new":
      if (msg.kind === "encode") addTask(msg.jobId, "encode", msg.label);
      break;
    case "job-progress":
      updateTask(msg.jobId, msg);
      break;
    case "job-done":
      updateTask(msg.jobId, { progress: 100, status: "done", fileName: msg.fileName });
      break;
    case "job-error":
      updateTask(msg.jobId, { status: "error", error: msg.error });
      showToast("编码失败: " + msg.error);
      break;
    case "f2v-encode-ready":
      // 触发下载
      const a = document.createElement("a");
      a.href = "/file/" + msg.hash + "/" + encodeURIComponent(msg.fileName);
      a.download = msg.fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      showToast("下载: " + msg.fileName);
      break;
  }
});