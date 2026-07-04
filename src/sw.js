// ═══════════════════════════════════════════════
// F2V Service Worker — 编码流式输出 + PWA 缓存
// ═══════════════════════════════════════════════
//
// 编码流程:
//   1. 页面发 f2v-encode → SW 创建编码任务
//   2. SW 构建 ReadableStream (AVI)
//   3. 页面触发 /file/<hash>/<name> 下载
//   4. SW 截获 fetch，返回流式 Response
//
// 解码由页面直接调用 f2v2-decode.js 完成，
// SW 不参与（页面持有 blob，无传输问题）
//
// ═══════════════════════════════════════════════
"use strict";

import { precomputeFrames, buildAVIIndex, writeAVIHeader, writeChunkHeader, writeINDX, FRAME0_HEADER_SIZE } from "./lib/f2v-core.js";
import { prepareIndexParams, encodeFrame0, encodeDataFrame } from "./lib/coders/f2v2-encode.js";

// ── PWA 缓存 ──

const CACHE_NAME = "f2v-v1";
const DB_NAME = "f2v-cache";
const STORE_NAME = "hashes";
const MANIFEST_URL = "/hashes.json";

async function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME))
        req.result.createObjectStore(STORE_NAME, { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getAllHashes() {
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve(
      req.result.reduce((acc, { key, hash }) => ((acc[key] = hash), acc), {})
    );
    req.onerror = () => resolve({});
  });
}

async function bulkSetHashes(manifest) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.clear();
    Object.entries(manifest).forEach(([key, hash]) => store.put({ key, hash }));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

let cachedPaths = new Map();
getAllHashes().then((h) => { cachedPaths = new Map(Object.entries(h)); }, () => {});

function resolvePath(pn) { return pn === "/" ? "/index.html" : pn; }

async function syncManifest() {
  const manifest = await fetch(MANIFEST_URL).then((r) => r.json()).then((raw) => {
    const m = {};
    for (const [key, hash] of Object.entries(raw)) m["/" + key] = hash;
    return m;
  });
  const oldHashes = await getAllHashes();
  const updates = Object.entries(manifest).filter(([k, h]) => oldHashes[k] !== h);
  const cache = await caches.open(CACHE_NAME);
  await Promise.allSettled(updates.map(([key, hash]) =>
    fetch(key).then((res) => { if (res.ok) cache.put(key + "#" + hash, res.clone()); }).catch(() => {})
  ));
  await bulkSetHashes(manifest);
  return manifest;
}

// ── 生命周期 ──

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    syncManifest().catch(() => {}).then(() => self.clients.claim())
      .then(() => self.clients.matchAll().then((cs) => {
        for (const c of cs) c.postMessage({ type: "sw-ready" });
      }))
  );
});

// ── 任务存储 ──

const encodeStreams = new Map();      // hash → ReadableStream
const encodeJobs = new Map();         // jobId → job state
const encodeFileInfo = new Map();     // hash → { jobId, fileName, size }

// ── 消息处理 ──

self.addEventListener("message", (event) => {
  const msg = event.data;
  if (!msg?.type) return;

  switch (msg.type) {
    case "f2v-encode":
      event.waitUntil(handleEncode(event, msg));
      break;
    case "cancel":
      cancelJob(msg.jobId);
      break;
  }
});

// ═══════════════════════════════════════════════
// 编码处理
// ═══════════════════════════════════════════════

async function handleEncode(event, msg) {
  const { jobId, files, password, w, h, fps, chunkSize } = msg;
  if (!files?.length) {
    postMsg(event, { type: "job-error", jobId, error: "无文件" });
    return;
  }

  try {
    const fileObjs = files.map((f) => ({ name: f.name, size: f.size }));
    const frameInfo = precomputeFrames(fileObjs, w, h);
    const aviIndex = buildAVIIndex(frameInfo, fps);

    const job = {
      kind: "encode", status: "running", progress: 0, cancelled: false,
      label: files.length + " 个文件编码",
    };
    encodeJobs.set(jobId, job);

    postMsg(event, { type: "job-new", jobId, kind: "encode", status: "running", label: job.label });

    const shortId = Date.now().toString(36);
    const fileName = "F2V." + shortId + ".avi";
    const hash = shortId + (Math.random() * 0xffff | 0).toString(16);

    const { frames, totalFrames, fileTotalData } = frameInfo;
    const totalData = fileTotalData || 1;
    const prefixSum = [0];
    for (let i = 1; i < frames.length; i++)
      prefixSum[i] = prefixSum[i - 1] + (frames[i - 1]?.dataSize || 0);

    encodeFileInfo.set(hash, { jobId, fileName, size: aviIndex.totalFileSize });

    const stream = new ReadableStream({
      async start(controller) {
        const push = (d) => controller.enqueue(d);
        const closeStream = () => { try { controller.close(); } catch {} };
        const isCancelled = () => job.cancelled;

        const report = (fraction, idx) => {
          const cb = prefixSum[idx] || 0;
          const ds = frames[idx]?.dataSize || 0;
          const overall = (cb + fraction * ds) / totalData;
          const pct = Math.min(100, Math.round(overall * 100));
          if (pct !== job.progress) {
            job.progress = pct;
            postMsg(event, { type: "job-progress", jobId, progress: pct, currentFile: "[" + (idx + 1) + "/" + totalFrames + "]" });
          }
        };

        try {
          writeAVIHeader(push, aviIndex, w, h, fps, totalFrames);
          if (isCancelled()) return;
          const params = await prepareIndexParams(fileObjs, password, frameInfo.nameBufs);
          if (isCancelled()) return;
          let cumulative = 0;

          writeChunkHeader(push, FRAME0_HEADER_SIZE + frames[0].dataSize);
          cumulative = await encodeFrame0(push, params, frames[0], { onProgress: (f) => report(f, 0) });
          if (isCancelled()) return;

          for (let i = 1; i < frames.length; i++) {
            if (isCancelled()) return;
            writeChunkHeader(push, frames[i].dataSize);
            cumulative += await encodeDataFrame(push, frames[i], fileObjs, params.encKey, params.frameSalt, cumulative, {
              chunkSize, isCancelled, onProgress: (f) => report(f, i),
            });
          }

          writeINDX(push, aviIndex.indxBuf);
          closeStream();
          job.status = "done";
          postMsg(event, { type: "job-done", jobId });
        } catch (e) {
          controller.error(e);
          job.status = "error";
          postMsg(event, { type: "job-error", jobId, error: e.message });
        }
      },
      cancel() { job.cancelled = true; },
    });

    encodeStreams.set(hash, stream);

    // 通知页面准备下载
    postMsg(event, {
      type: "f2v-encode-ready",
      jobId,
      hash,
      fileName,
      fileSize: aviIndex.totalFileSize,
    });
  } catch (e) {
    postMsg(event, { type: "job-error", jobId, error: e.message });
  }
}

// ═══════════════════════════════════════════════
// 取消任务
// ═══════════════════════════════════════════════

function cancelJob(jobId) {
  const job = encodeJobs.get(jobId);
  if (job) job.cancelled = true;
}

// ═══════════════════════════════════════════════
// Fetch 拦截
// ═══════════════════════════════════════════════

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  if (event.request.mode === "navigate") {
    event.waitUntil(syncManifest().catch(() => {}));
  }

  // 编码流式输出
  if (url.pathname.startsWith("/file/")) {
    event.respondWith(serveEncodedStream(event));
    return;
  }

  // PWA 缓存
  event.respondWith(serveFromCache(event.request, event));
});

async function serveEncodedStream(event) {
  const url = new URL(event.request.url);
  const parts = url.pathname.split("/");
  const hash = parts[2];
  const info = encodeFileInfo.get(hash);
  if (!info) return new Response("Not found", { status: 404 });

  const stream = encodeStreams.get(hash);
  if (!stream) return new Response("Stream not ready", { status: 404 });

  // 清理
  encodeStreams.delete(hash);
  encodeFileInfo.delete(hash);

  const headers = new Headers({
    "Content-Type": "video/avi",
    "Content-Disposition": 'attachment; filename="' + info.fileName + '"',
    "Content-Length": String(info.size),
  });
  return new Response(stream, { headers });
}

async function serveFromCache(request, event) {
  const cache = await caches.open(CACHE_NAME);
  const pn = resolvePath(new URL(request.url).pathname);
  const hash = cachedPaths.get(pn);
  if (hash) {
    const cached = await cache.match(pn + "#" + hash);
    if (cached) return cached;
  }
  try {
    const res = await fetch(request);
    if (res.ok && hash) event.waitUntil(cache.put(pn + "#" + hash, res.clone()));
    return res;
  } catch {
    return new Response("Offline", { status: 503, headers: { "Content-Type": "text/plain" } });
  }
}

// ── 消息工具 ──

function postMsg(event, msg) {
  if (event.source) event.source.postMessage(msg);
  else self.clients.matchAll().then((cs) => { for (const c of cs) c.postMessage(msg); });
}