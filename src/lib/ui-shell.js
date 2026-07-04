// UI 外壳 — Tab 切换 + Toast + Chunk Size + SW 状态
"use strict";

const $ = (id) => document.getElementById(id);

const sections = {
  enc: $("encSection"),
  dec: $("decSection"),
  tasks: $("tasksSection"),
};

const tabs = {
  enc: $("tabEnc"),
  dec: $("tabDec"),
  tasks: $("tabTasks"),
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
  const c = $("toastContainer");
  if (!c) return;
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  c.appendChild(el);
  toasts.push(el);
  setTimeout(() => {
    el.classList.add("out");
    setTimeout(() => {
      el.remove();
    }, 250);
  }, dur || 3000);
}

// ── SW 状态（DOM 引用缓存，避免重复查询） ──

let _cachedDot = null;
let _cachedLabel = null;
let _cachedStatus = null;

const SW_COLORS = [
  "green",
  "red",
  "yellow",
  "blue",
  "orange",
  "purple",
  "gray",
];
const SW_COLOR_SET = new Set(SW_COLORS);

function resolveDot() {
  return _cachedDot || (_cachedDot = $("swDot"));
}
function resolveLabel() {
  return _cachedLabel || (_cachedLabel = $("swLabel"));
}
function resolveStatus() {
  return _cachedStatus || (_cachedStatus = $("swStatus"));
}

export function setSWStatus(color, label) {
  if (!SW_COLOR_SET.has(color)) color = "gray";
  const dot = resolveDot();
  const lbl = resolveLabel();
  const st = resolveStatus();
  if (st) {
    st.classList.remove(...SW_COLORS);
    st.classList.add(color);
  }
  if (dot) {
    dot.classList.remove(...SW_COLORS);
    dot.classList.add(color);
    dot.title = "Service Worker: " + label;
  }
  if (lbl) lbl.textContent = label;
}

// ── Chunk Size（与 F2P 同步） ──

const CHUNK_SIZES = [
  64, 256, 1024, 2048, 3072, 4096, 6144, 8192, 12288, 16384, 24576, 32768,
  49152, 65536, 98304, 131072, 196608, 262144, 393216, 524288, 786432, 1048576,
  1572864, 2097152, 3145728, 3932160,
];

function fmtChunkSize(kb) {
  return kb < 1024 ? `${kb} KB` : `${kb / 1024} MB`;
}

const chunkSelect = $("chunkSize");
const memHint = $("memHint");

CHUNK_SIZES.forEach((val) => {
  const opt = document.createElement("option");
  opt.value = val;
  opt.textContent = fmtChunkSize(val);
  if (val === 64) opt.selected = true;
  chunkSelect.appendChild(opt);
});

export function getChunkSize() {
  return parseInt(chunkSelect.value) || 64;
}

function updateMemHint() {
  const kb = parseInt(chunkSelect.value, 10) || 64;
  const peak = kb * 8; // 同时最多 8 个 chunk 在内存中
  let cls = "";
  if (peak >= 262144) cls = peak < 1048576 ? "warn" : "danger";
  memHint.textContent = "\u25CF"; // ●
  memHint.className = "mem-hint" + (cls ? " " + cls : "");
  memHint.title = cls ? "内存占用偏高" : "内存占用正常";
}

chunkSelect.addEventListener("change", updateMemHint);
chunkSelect.addEventListener("input", updateMemHint);
updateMemHint();

// ── 初始 ──

showTab("enc");

if (navigator.serviceWorker.controller) {
  setSWStatus("green", "已就绪");
} else {
  setSWStatus("gray", "等待注册");
}

// ── 监听 SW 状态 ──

navigator.serviceWorker.addEventListener("message", (e) => {
  if (e.data?.type === "sw-ready") setSWStatus("green", "已连接");
});

export { showTab };
