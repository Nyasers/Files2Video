<template>
  <div class="panel">
    <div class="card">
      <div class="card-header">
        <h2>选择文件</h2>
        <div class="card-actions">
          <button class="btn-ghost" @click="clearFiles" :disabled="!files.length">
            清空
          </button>
        </div>
      </div>

      <div class="drop-zone" :class="{ 'drag-over': dragOver }" @dragenter.prevent="onDragEnter" @dragover.prevent
        @dragleave.prevent="onDragLeave" @drop.prevent="onDrop" @click="fileInput?.click()">
        <input ref="fileInput" type="file" multiple class="hidden" @change="onFileInput" />
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"
          stroke-linecap="round" stroke-linejoin="round" class="drop-icon">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" y1="3" x2="12" y2="15" />
        </svg>
        <div class="drop-text">
          {{ files.length ? files.length + " 个文件已选择" : "拖放文件到此处" }}
        </div>
        <div class="drop-hint">支持任意格式，可追加</div>
      </div>

      <div class="field-row">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"
          stroke-linecap="round" stroke-linejoin="round" class="field-icon">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
        <input v-model="password" type="text" class="input" placeholder="输入密码（可留空）" autocomplete="off" />
      </div>

      <div class="controls-row">
        <div class="video-params">
          <label class="vp-label">
            <select v-model="resolution" class="vp-select">
              <option value="480x360">360P</option>
              <option value="640x480">480P</option>
              <option value="1280x720">720P</option>
              <option value="1920x1080">1080P</option>
              <option value="2560x1440">1440P</option>
              <option value="3840x2160">4K</option>
              <option value="7680x4320">8K</option>
            </select>
            @
            <input v-model.number="fps" type="number" class="vp-input" min="1" max="1000000" />
          </label>
        </div>
        <button class="btn-primary" :disabled="!files.length || encoding" @click="submitEncode">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"
            stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
          </svg>
          {{ encoding ? "准备中…" : "生成" }}
        </button>
      </div>

      <div v-if="files.length" class="file-list">
        <div class="file-list-summary">{{ summaryText }}</div>
        <div class="file-list-header">
          <span class="col-idx">#</span>
          <span class="col-name">文件名</span>
          <span class="col-size">大小</span>
          <span class="col-action"></span>
        </div>
        <div class="file-list-body">
          <div v-for="(f, i) in files" :key="f.id" class="file-item">
            <span class="col-idx">{{ i + 1 }}</span>
            <span class="col-name" :title="f.name">{{ f.name }}</span>
            <span class="col-size">{{ fmtSize(f.size) }}</span>
            <button class="btn-remove" @click="removeFile(i)" title="移除">
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
                <path d="M1 1 L9 9 M9 1 L1 9"/>
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from "vue";
import { fmt, precomputeFramesV2 } from "../lib/f2v-core.js";
import { swSend, onSWMessage, waitForSw, toast } from "../lib/sw-client.js";
import { getChunkSize } from "../composables/useSettings.js";

const emit = defineEmits(["encode-done"]);

// ── 状态 ──
const files = ref([]);
const password = ref("");
const resolution = ref("1920x1080");
const fps = ref(30);
const encoding = ref(false);
const dragOver = ref(false);
let dragCount = 0;
const fileInput = ref(null);
let idCounter = 0;

function nextId() {
  return ++idCounter;
}

function fmtSize(b) {
  return fmt(b);
}

// ── 汇总文本 ──
const summaryText = computed(() => {
  if (!files.value.length) return "";
  let text = `共 ${files.value.length} 个文件 · ${fmt(files.value.reduce((s, f) => s + f.size, 0))}`;
  try {
    const parts = resolution.value.split("x");
    const w = parseInt(parts[0]) || 640;
    const h = parseInt(parts[1]) || 320;
    const fi = precomputeFramesV2(
      files.value.map((f) => f.file),
      w,
      h,
    );
    text += ` · ${fi.totalFrames} 帧`;
  } catch {
    // fallback: just show size
  }
  return text;
});

// ── 文件操作 ──
function addFiles(newFiles) {
  const exist = new Set(files.value.map((f) => f.name + "|" + f.size));
  let added = 0;
  for (const f of newFiles) {
    const key = f.name + "|" + f.size;
    if (exist.has(key)) continue;
    files.value.push({ id: nextId(), file: f, name: f.name, size: f.size });
    exist.add(key);
    added++;
  }
  if (added) toast("已添加 " + added + " 个文件");
}

function removeFile(i) {
  files.value.splice(i, 1);
}

function clearFiles() {
  files.value = [];
}

// ── 拖放 ──
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
  if (e.dataTransfer.files.length) {
    addFiles(Array.from(e.dataTransfer.files));
  }
}

function onFileInput(e) {
  const f = Array.from(e.target.files);
  e.target.value = "";
  if (f.length) addFiles(f);
}

// ── 提交编码 ──
async function submitEncode() {
  if (!files.value.length || encoding.value) return;
  encoding.value = true;

  await waitForSw();
  const pwd = password.value;
  const parts = resolution.value.split("x");
  const w = parseInt(parts[0]) || 640;
  const h = parseInt(parts[1]) || 320;
  const fpsVal = parseInt(fps.value) || 30;

  let frameInfo;
  try {
    const rawFiles = files.value.map((f) => f.file);
    frameInfo = precomputeFramesV2(rawFiles, w, h);
  } catch (e) {
    toast("编码参数错误: " + e.message);
    encoding.value = false;
    return;
  }

  const jobId =
    Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const CHUNK = getChunkSize();

  swSend({
    type: "f2v2-encode",
    jobId,
    files: files.value.map((f) => f.file),
    password: pwd,
    w,
    h,
    fps: fpsVal,
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

  // 清空并切换到任务 Tab
  files.value = [];
  encoding.value = false;
  emit("encode-done");
}

// ── SW 消息：编码完成时触发下载 ──
let unsubReady = null;

onMounted(() => {
  unsubReady = onSWMessage("f2v-encode-ready", (msg) => {
    const dlUrl = "/files?id=" + msg.jobId;
    const f = document.createElement("iframe");
    f.style.display = "none";
    document.body.appendChild(f);
    f.src = dlUrl;
    setTimeout(() => {
      if (f.parentNode) f.remove();
    }, 30000);
    toast("下载: " + msg.fileName);
  });
});

onUnmounted(() => {
  if (unsubReady) unsubReady();
});
</script>
