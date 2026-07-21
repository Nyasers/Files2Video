<template>
  <div class="panel">
    <div class="card">
      <div class="card-header">
        <h2>选择视频</h2>
        <div class="card-actions">
          <button class="btn-ghost" @click="resetAll">清空</button>
        </div>
      </div>

      <div class="drop-zone" :class="{ 'drag-over': dragOver }" @dragenter.prevent="onDragEnter" @dragover.prevent
        @dragleave.prevent="onDragLeave" @drop.prevent="onDrop" @click="fileInput?.click()">
        <input ref="fileInput" type="file" accept=".avi,.mp4" class="hidden" @change="onFileInput" />
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"
          stroke-linecap="round" stroke-linejoin="round" class="drop-icon">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <polyline points="21 15 16 10 5 21" />
        </svg>
        <div class="drop-text">
          {{ fileInfo.name || "拖放 F2V 文件，或点击选择" }}
        </div>
        <div class="drop-hint">{{ fileInfo.hint }}</div>
      </div>

      <div class="field-row">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"
          stroke-linecap="round" stroke-linejoin="round" class="field-icon">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
        <input v-model="password" type="text" class="input" placeholder="输入密码（可留空）" autocomplete="off" />
      </div>

      <div class="controls-row" v-if="decFile && !decodeResult">
        <button class="btn-primary" @click="submitDecode" :disabled="!decFormat || decoding">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"
            stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 12a9 9 0 1 1-9-9" />
            <path d="M12 3v9l4 4" />
          </svg>
          {{ decoding ? "提取中…" : "提取" }}
        </button>
      </div>

      <!-- 解码结果 -->
      <div v-if="decodeResult" class="decode-result">
        <div class="file-list">
          <div class="result-header">
            <input type="checkbox" :checked="allSelected" @change="toggleAll" class="select-all-cb" />
            <span class="result-summary">共 {{ decodeResult.length }} 个文件</span>
            <span class="selected-count">已选 {{ selectedCount }} 个</span>
            <button class="btn-secondary" @click="batchDownload" :disabled="!selectedCount">
              下载选中
            </button>
          </div>
          <div class="file-list-body">
            <div v-for="(entry, i) in decodeResult" :key="i" class="file-item result-item">
              <input type="checkbox" v-model="selected[i]" :true-value="true" :false-value="false" />
              <span class="col-name">{{ entry.name }}</span>
              <span class="col-size">{{ fmtSize(entry.size) }}</span>
              <button class="btn-dl" @click="downloadFile(i)">下载</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onUnmounted } from "vue";
import { fmt } from "../lib/f2v-core.js";
import { swSend, onSWMessage, toast } from "../lib/sw-client.js";

// ── 状态 ──
const decFile = ref(null);
const decFormat = ref("");
const password = ref("");
const decoding = ref(false);
const dragOver = ref(false);
const decodeResult = ref(null);
const selected = reactive({});
const currentJobId = ref(null);
const fileInput = ref(null);
let dragCount = 0;

// ── 文件信息显示 ──
const fileInfo = computed(() => {
  if (!decFile.value) {
    return { name: "", hint: "F2V1 (AVI) 或 F2V2 (MP4)" };
  }
  const sizeStr = fmt(decFile.value.size);
  let hint = "";
  if (decFormat.value === "f2v2") hint = "F2V2 格式 (MP4)";
  else if (decFormat.value === "f2v1") hint = "F2V1 格式 (AVI)";
  else hint = "未知格式";
  return { name: `${decFile.value.name} (${sizeStr})`, hint };
});

// ── 选择状态 ──
const allSelected = computed(() => {
  if (!decodeResult.value) return false;
  return (
    decodeResult.value.length > 0 &&
    selectedCount.value === decodeResult.value.length
  );
});

const selectedCount = computed(() => {
  return Object.values(selected).filter(Boolean).length;
});

function fmtSize(b) {
  return fmt(b);
}

// ── 格式检测 ──
async function detectFormat(file) {
  const hdr = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (hdr.length < 12) return "";
  // ISOBMFF: bytes 4-7 = 'ftyp'
  if (hdr[4] === 0x66 && hdr[5] === 0x74 && hdr[6] === 0x79 && hdr[7] === 0x70)
    return "f2v2";
  // RIFF: bytes 0-3 = 'RIFF'
  if (hdr[0] === 0x52 && hdr[1] === 0x49 && hdr[2] === 0x46 && hdr[3] === 0x46)
    return "f2v1";
  return "";
}

// ── 文件处理 ──
async function handleFile(file) {
  if (!file) return;
  resetState();
  decFile.value = file;
  decFormat.value = await detectFormat(file);
}

function resetState() {
  decFile.value = null;
  decFormat.value = "";
  currentJobId.value = null;
  decodeResult.value = null;
  for (const key of Object.keys(selected)) delete selected[key];
  fileInput.value && (fileInput.value.value = "");
}

function resetAll() {
  resetState();
  password.value = "";
}

// ── 拖放 / 选择 ──
function onDragEnter() {
  dragCount++;
  dragOver.value = true;
}
function onDragLeave() {
  dragCount--;
  if (dragCount <= 0) {
    dragCount = 0;
    dragOver.value = false;
  }
}
function onDrop(e) {
  dragCount = 0;
  dragOver.value = false;
  if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
}
function onFileInput(e) {
  const f = e.target.files?.[0];
  e.target.value = "";
  if (f) handleFile(f);
}

// ── 提交解码 ──
function submitDecode() {
  if (!decFile.value || !decFormat.value || decoding.value) return;
  decoding.value = true;

  const pwd = password.value;
  const jId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  currentJobId.value = jId;

  const msgType = decFormat.value === "f2v2" ? "f2v2-decode" : "f2v-decode";

  swSend({
    type: msgType,
    jobId: jId,
    file: decFile.value,
    password: pwd,
  });
}

// ── 下载 ──
function triggerDownloadByIdx(idx) {
  if (!currentJobId.value) return;
  const dlUrl = "/files?id=" + currentJobId.value + "&idx=" + idx;
  const f = document.createElement("iframe");
  f.style.display = "none";
  document.body.appendChild(f);
  f.src = dlUrl;
  setTimeout(() => {
    if (f.parentNode) f.remove();
  }, 30000);
}

function downloadFile(idx) {
  triggerDownloadByIdx(idx);
}

function batchDownload() {
  const indices = Object.entries(selected)
    .filter(([, v]) => v)
    .map(([k]) => parseInt(k));
  for (const idx of indices) {
    triggerDownloadByIdx(idx);
  }
}

function toggleAll() {
  if (!decodeResult.value) return;
  const all = allSelected.value;
  decodeResult.value.forEach((_, i) => {
    selected[i] = !all;
  });
}

// ── SW 消息 ──
let unsubResult = null;
let unsubError = null;

onMounted(() => {
  unsubResult = onSWMessage("f2v-decode-result", (msg) => {
    if (msg.jobId !== currentJobId.value) return;
    decodeResult.value = msg.entries;
    // 初始化全选
    for (let i = 0; i < msg.entries.length; i++) {
      selected[i] = true;
    }
    decoding.value = false;
    toast("解码完成，共 " + msg.entries.length + " 个文件");
  });

  unsubError = onSWMessage("job-error", (msg) => {
    if (msg.jobId === currentJobId.value) {
      decoding.value = false;
      toast("解码失败: " + (msg.error || ""));
    }
  });
});

onUnmounted(() => {
  if (unsubResult) unsubResult();
  if (unsubError) unsubError();
});
</script>
