// ═══════════════════════════════════════════════
// F2V Service Worker — 编码/解码流式输出 + PWA 缓存
// ═══════════════════════════════════════════════
//
// 编码流程（文件通过 Cache API 获取，不走 postMessage）:
//   1. 页面将文件写入 Cache API
//   2. 页面发 f2v-encode（仅含元数据）→ SW
//   3. SW 从 Cache 读取文件 Blob，构建 ReadableStream
//   4. 页面触发 /file/<hash>/<name> 下载
//   5. SW 截获 fetch，返回流式 Response
//
// 解码由 SW 处理（单个 AVI 文件，无大数据传输问题）
//
// ═══════════════════════════════════════════════
"use strict";

import {
  precomputeFrames,
  buildAVIIndex,
  writeAVIHeader,
  writeChunkHeader,
  writeINDX,
  FRAME0_HEADER_SIZE,
} from "./lib/f2v-core.js";
import {
  prepareIndexParams,
  encodeFrame0,
  encodeDataFrame,
} from "./lib/coders/f2v1-encode.js";
import {
  parseAVI,
  readFrame0,
  extractFileDataRange,
} from "./lib/coders/f2v1-decode.js";

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
    req.onsuccess = () =>
      resolve(
        req.result.reduce((acc, { key, hash }) => ((acc[key] = hash), acc), {}),
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
getAllHashes().then(
  (h) => {
    cachedPaths = new Map(Object.entries(h));
  },
  () => {},
);

function resolvePath(pn) {
  return pn === "/" ? "/index.html" : pn;
}

// ── 60s promise 缓存：短时间多次导航不重复拉 manifest ──

async function syncManifest() {
  return (syncManifest.promise ??= fetch(MANIFEST_URL)
    .then((r) => r.json())
    .then((raw) => {
      const m = {};
      for (const [key, hash] of Object.entries(raw)) m["/" + key] = hash;
      return m;
    })
    .then((manifest) => syncUpdate(manifest).then(() => manifest))
    .then((manifest) => cleanupOrphans().then(() => manifest))
    .then(
      (manifest) => (
        setTimeout(() => delete syncManifest.promise, 60000),
        manifest
      ),
      (reason) => {
        delete syncManifest.promise;
        return Promise.reject(reason);
      },
    ));
}

async function syncUpdate(manifest) {
  const oldHashes = await getAllHashes();
  const updates = Object.entries(manifest).filter(
    ([k, h]) => oldHashes[k] !== h,
  );
  if (updates.length === 0) return;

  const cache = await caches.open(CACHE_NAME);
  await Promise.allSettled(
    updates.map(([key, hash]) =>
      fetch(key)
        .then((res) => {
          if (res.ok) cache.put(key + "#" + hash, res.clone());
        })
        .catch(() => {}),
    ),
  );
  await bulkSetHashes(manifest);

  self.clients.matchAll().then((cs) => {
    for (const c of cs) c.postMessage({ type: "sw-updated" });
  });
}

async function cleanupOrphans() {
  const manifest = await getAllHashes();
  if (Object.keys(manifest).length < 3) return;
  const cache = await caches.open(CACHE_NAME);
  const requests = await cache.keys();
  return Promise.all(
    requests
      .filter((req) => {
        const u = new URL(req.url);
        const pn = u.pathname;
        if (pn.startsWith("/file/")) return false;
        const expectedHash = manifest[pn];
        if (expectedHash === undefined) return true;
        return u.hash.slice(1) !== expectedHash;
      })
      .map((req) => cache.delete(req)),
  );
}

// ── 生命周期 ──

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    syncManifest()
      .catch((e) => console.warn("syncManifest 失败:", e))
      .then(() => self.clients.claim())
      .then(() =>
        self.clients.matchAll().then((cs) => {
          for (const c of cs) c.postMessage({ type: "sw-ready" });
        }),
      ),
  );
});

// ── 编码任务存储 ──

const encodeJobs = new Map(); // jobId → { cancelled }
const encodeStreamsByJob = new Map(); // jobId → { stream, fileName, fileSize }

// ── 解码存储 ──

const decodeContexts = new Map(); // jobId → { file, indexInfo, aviInfo, entries }
const fileRoutes = new Map(); // hash → { jobId, idx, fileName }

// ── 消息处理 ──

self.addEventListener("message", (event) => {
  const msg = event.data;
  if (!msg?.type) return;

  switch (msg.type) {
    case "f2v-encode":
      event.waitUntil(handleEncode(event, msg));
      break;
    case "f2v-decode":
      event.waitUntil(handleDecode(event, msg));
      break;
    case "list-jobs":
      listJobs(event);
      break;
  }
});

// ═══════════════════════════════════════════════
// 编码处理（从 Cache API 读取文件 Blob）
// ═══════════════════════════════════════════════

async function handleEncode(event, msg) {
  const { jobId, files, password, w, h, fps, chunkSize, frameInfo: fi } = msg;
  if (!files?.length) {
    postMsg(event, { type: "job-error", jobId, error: "无文件" });
    return;
  }

  try {
    // 直接用页面 frameInfo，不重新计算 precomputeFrames
    const frameInfo = fi;
    const aviIndex = buildAVIIndex(frameInfo, fps);

    const job = {
      kind: "encode",
      status: "running",
      progress: -1,
      cancelled: false,
      label: files.length + " 个文件编码",
    };
    encodeJobs.set(jobId, job);

    const client = event.source;

    postMsg(event, {
      type: "job-new",
      jobId,
      kind: "encode",
      status: "running",
      label: job.label,
    });

    const shortId = Date.now().toString(36);
    const fileName = "F2V." + shortId + ".avi";

    const { frames, totalFrames, fileTotalData } = frameInfo;
    const totalData = fileTotalData || 1;
    const prefixSum = [0];
    for (let i = 1; i < frames.length; i++)
      prefixSum[i] = prefixSum[i - 1] + (frames[i - 1]?.dataSize || 0);

    const stream = new ReadableStream({
      async start(controller) {
        const push = (d) => controller.enqueue(d);
        const closeStream = () => {
          try {
            controller.close();
          } catch {}
        };
        const isCancelled = () => job.cancelled;

        const sendCancelled = () => {
          const cm = { type: "job-cancelled", jobId };
          if (client) client.postMessage(cm);
          else postMsg(event, cm);
        };

        const report = (fraction, idx) => {
          const cb = prefixSum[idx] || 0;
          const ds = frames[idx]?.dataSize || 0;
          const overall = (cb + fraction * ds) / totalData;
          const pct = Math.min(100, Math.round(overall * 100));
          if (pct !== job.progress) {
            job.progress = pct;
            const msg = {
              type: "job-progress",
              jobId,
              progress: pct,
              currentFile: "[" + (idx + 1) + "/" + totalFrames + "]",
            };
            if (client) client.postMessage(msg);
            else postMsg(event, msg);
          }
        };

        try {
          if (client)
            client.postMessage({
              type: "job-progress",
              jobId,
              progress: 1,
              currentFile: "初始化...",
            });

          writeAVIHeader(push, aviIndex, w, h, fps, totalFrames);
          if (isCancelled()) {
            closeStream();
            sendCancelled();
            return;
          }

          const params = await prepareIndexParams(
            files,
            password,
            frameInfo.nameBufs,
          );
          if (isCancelled()) {
            closeStream();
            sendCancelled();
            return;
          }
          let cumulative = 0;

          writeChunkHeader(push, FRAME0_HEADER_SIZE + frames[0].dataSize);
          cumulative = await encodeFrame0(push, params, frames[0], {
            onProgress: (f) => report(f, 0),
          });
          if (frames[0].chunkSize % 2 !== 0) push(new Uint8Array([0]));
          if (isCancelled()) {
            closeStream();
            sendCancelled();
            return;
          }

          for (let i = 1; i < frames.length; i++) {
            if (isCancelled()) {
              closeStream();
              sendCancelled();
              return;
            }
            writeChunkHeader(push, frames[i].dataSize);
            cumulative += await encodeDataFrame(
              push,
              frames[i],
              files,
              params.encKey,
              params.frameSalt,
              cumulative,
              {
                chunkSize,
                isCancelled,
                onProgress: (f) => report(f, i),
              },
            );
            if (frames[i].chunkSize % 2 !== 0) push(new Uint8Array([0]));
          }

          if (aviIndex.moviPad) push(new Uint8Array([0]));
          writeINDX(push, aviIndex.ix00Buf);
          closeStream();
          job.status = "done";
          const doneMsg = { type: "job-done", jobId };
          if (client) client.postMessage(doneMsg);
          else postMsg(event, doneMsg);
        } catch (e) {
          controller.error(e);
          job.status = "error";
          console.error("encode stream error:", e);
          const errMsg = {
            type: "job-error",
            jobId,
            error: e.message,
            kind: "encode",
          };
          if (client) client.postMessage(errMsg);
          else postMsg(event, errMsg);
        }
      },
      cancel() {
        job.cancelled = true;
      },
    });

    encodeStreamsByJob.set(jobId, {
      stream,
      fileName,
      fileSize: aviIndex.totalFileSize,
    });

    postMsg(event, {
      type: "f2v-encode-ready",
      jobId,
      fileName,
      fileSize: aviIndex.totalFileSize,
    });
  } catch (e) {
    postMsg(event, {
      type: "job-error",
      jobId,
      error: e.message,
      kind: "encode",
    });
  }
}

// ═══════════════════════════════════════════════
// 解码处理
// ═══════════════════════════════════════════════

async function handleDecode(event, msg) {
  const { jobId, file, password } = msg;
  if (!file) {
    postMsg(event, { type: "job-error", jobId, error: "无文件" });
    return;
  }

  try {
    const aviInfo = await parseAVI(file);
    const indexInfo = await readFrame0(file, aviInfo.metaFrame, password);

    decodeContexts.set(jobId, {
      file,
      aviInfo,
      indexInfo,
      entries: indexInfo.entries,
    });

    postMsg(event, {
      type: "f2v-decode-result",
      jobId,
      entries: indexInfo.entries,
      totalSize: aviInfo.totalFileData,
    });
  } catch (e) {
    postMsg(event, {
      type: "job-error",
      jobId,
      error: e.message,
      kind: "decode",
    });
  }
}

// ═══════════════════════════════════════════════
// 任务列表查询
// ═══════════════════════════════════════════════

function listJobs(event) {
  const list = [];
  for (const [jobId, job] of encodeJobs) {
    list.push({
      jobId,
      kind: "encode",
      status: job.status,
      progress: job.progress || 0,
      label: job.label || "",
    });
  }
  const msg = { type: "jobs-list", jobs: list };
  if (event.source) event.source.postMessage(msg);
  else postMsg(null, msg);
}

// ═══════════════════════════════════════════════
// Fetch 拦截
// ═══════════════════════════════════════════════

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  if (event.request.mode === "navigate") {
    event.waitUntil(syncManifest().catch(() => {}));
  }

  // 流式下载路由: /files?id=X → 302 → /file/hash/name
  if (url.pathname === "/files") {
    event.respondWith(handleFilesRoute(event, url));
    return;
  }

  if (url.pathname.startsWith("/file/")) {
    event.respondWith(serveEncodedFile(event));
    return;
  }

  event.respondWith(serveFromCache(event.request, event));
});

async function handleFilesRoute(event, url) {
  const jobId = url.searchParams.get("id");
  if (!jobId) return new Response("Missing id", { status: 400 });

  // 解码文件下载: /files?id=xxx&idx=N
  const idx = url.searchParams.get("idx");
  if (idx != null) {
    const ctx = decodeContexts.get(jobId);
    if (!ctx) return new Response("Decode context not found", { status: 404 });
    const entry = ctx.entries[parseInt(idx)];
    if (!entry) return new Response("File entry not found", { status: 404 });
    const hash =
      jobId + "_d" + idx + "_" + ((Math.random() * 0xffffff) | 0).toString(16);
    fileRoutes.set(hash, { jobId, idx: parseInt(idx), hash });
    return Response.redirect(
      "/file/" + hash + "/" + encodeURIComponent(entry.name),
      302,
    );
  }

  // 编码流式下载: /files?id=xxx
  const entry = encodeStreamsByJob.get(jobId);
  if (!entry) return new Response("Job not found", { status: 404 });

  const hash = jobId + "_" + ((Math.random() * 0xffffff) | 0).toString(16);
  encodeStreamsByJob.set(hash, entry);
  encodeStreamsByJob.delete(jobId);

  return Response.redirect(
    "/file/" + hash + "/" + encodeURIComponent(entry.fileName),
    302,
  );
}

async function serveEncodedFile(event) {
  const url = new URL(event.request.url);
  const parts = url.pathname.split("/");
  const hash = parts[2];

  // 解码文件下载
  const decRoute = fileRoutes.get(hash);
  if (decRoute) {
    const ctx = decodeContexts.get(decRoute.jobId);
    if (ctx) return serveDecodedStream(event, ctx, decRoute);
  }

  // 编码流式下载
  const entry = encodeStreamsByJob.get(hash);
  if (!entry) return new Response("Not found", { status: 404 });

  encodeStreamsByJob.delete(hash);

  const headers = new Headers({
    "Content-Type": "video/avi",
    "Content-Disposition": 'attachment; filename="' + entry.fileName + '"',
    "Content-Length": String(entry.fileSize),
  });
  return new Response(entry.stream, { headers });
}

async function serveDecodedStream(event, ctx, route) {
  const { file, indexInfo, aviInfo } = ctx;
  const entry = indexInfo.entries[route.idx];
  if (!entry) return new Response("Entry not found", { status: 404 });

  fileRoutes.delete(route.hash);

  const CHUNK = 64 * 1024;
  const fileSize = entry.size;

  const stream = new ReadableStream({
    async start(controller) {
      try {
        let offset = 0;
        while (offset < fileSize) {
          const take = Math.min(CHUNK, fileSize - offset);
          const chunk = await extractFileDataRange(
            file,
            indexInfo,
            aviInfo.dataFrames,
            route.idx,
            offset,
            take,
          );
          if (chunk.length === 0) break;
          controller.enqueue(chunk);
          offset += chunk.length;
        }
        controller.close();
      } catch (e) {
        controller.error(e);
      }
    },
  });

  const headers = new Headers({
    "Content-Type": "application/octet-stream",
    "Content-Disposition": 'attachment; filename="' + entry.name + '"',
  });
  if (fileSize) headers.set("Content-Length", String(fileSize));

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
    if (res.ok && hash)
      event.waitUntil(cache.put(pn + "#" + hash, res.clone()));
    return res;
  } catch {
    return new Response("Offline", {
      status: 503,
      headers: { "Content-Type": "text/plain" },
    });
  }
}

// ── 消息工具 ──

function postMsg(event, msg) {
  if (event && event.source) event.source.postMessage(msg);
  else
    self.clients.matchAll().then((cs) => {
      for (const c of cs) c.postMessage(msg);
    });
}
