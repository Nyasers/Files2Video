// UI 外壳 — Tab 切换 + SW 状态 + Toast
"use strict";

const sections = {
  enc: document.getElementById("encSection"),
  dec: document.getElementById("decSection"),
  tasks: document.getElementById("tasksSection"),
};

const tabs = {
  enc: document.getElementById("tabEnc"),
  dec: document.getElementById("tabDec"),
  tasks: document.getElementById("tabTasks"),
};

function showTab(name) {
  Object.keys(sections).forEach((k) => {
    sections[k].style.display = k === name ? "" : "none";
    tabs[k].classList.toggle("active", k === name);
  });
}

tabs.enc.addEventListener("click", () => showTab("enc"));
tabs.dec.addEventListener("click", () => showTab("dec"));
tabs.tasks.addEventListener("click", () => showTab("tasks"));

// ── Toast ──

let toasts = [];

export function showToast(msg, dur) {
  const c = document.getElementById("toastContainer");
  if (!c) return;
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  c.appendChild(el);
  toasts.push(el);
  setTimeout(() => {
    el.classList.add("out");
    setTimeout(() => { el.remove(); }, 250);
  }, dur || 3000);
}

// ── SW 状态 ──

const swDot = document.getElementById("swDot");
const swLabel = document.getElementById("swLabel");
const swStatus = document.getElementById("swStatus");

export function setSWStatus(state, label) {
  swDot.className = "sw-dot " + state;
  swLabel.textContent = label || "";
  swStatus.className = "sw-status " + state;
}

// ── Chunk Size ──

const chunkSelect = document.getElementById("chunkSize");
const memHint = document.getElementById("memHint");
const chunkValues = [16, 32, 64, 128, 256, 512, 1024];
const chunkLabels = ["16 KB", "32 KB", "64 KB", "128 KB", "256 KB", "512 KB", "1024 KB"];

chunkValues.forEach((v, i) => {
  const opt = document.createElement("option");
  opt.value = v;
  opt.textContent = chunkLabels[i];
  if (v === 64) opt.selected = true;
  chunkSelect.appendChild(opt);
});

export function getChunkSize() {
  return parseInt(chunkSelect.value) || 64;
}

chunkSelect.addEventListener("change", () => {
  const v = getChunkSize();
  memHint.textContent = "chunk " + (v >= 1024 ? (v / 1024).toFixed(1) + "MB" : v + "KB");
});

// ── 初始 ──

showTab("enc");
setSWStatus("gray", "等待注册");

export { showTab };