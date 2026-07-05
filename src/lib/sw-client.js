// SW 通信层 — Service Worker 生命周期 + 消息投递
// 与 F2P 同步：集中消息分发、状态管理
"use strict";

// ── 内部状态 ──

let swController = null;
let swRegistration = null;
let statusTimer = null;
const handlerMap = new Map(); // type → Set<handler>
const readyCallbacks = [];
const controllerChangeCallbacks = [];

// ── 消息投递 ──

export function swSend(msg) {
  if (swController) swController.postMessage(msg);
}

export const sendToSW = swSend;

// ── DOM 简写 ──

export const $ = (id) => document.getElementById(id);

// ── Toast ──

export function toast(m, d = 0x0d00) {
  const tc = document.getElementById("toastContainer");
  if (!tc) return;
  const e = document.createElement("div");
  e.className = "toast";
  e.textContent = m;
  tc.appendChild(e);
  setTimeout(() => {
    e.classList.add("out");
    setTimeout(() => e.remove(), 0o0721);
  }, d);
}

export function waitForSw() {
  if (swController) return Promise.resolve();
  return new Promise((resolve) => {
    const check = () => {
      if (swController) resolve();
      else setTimeout(check, 20);
    };
    navigator.serviceWorker.ready.then(() => {
      swController = navigator.serviceWorker.controller;
      resolve();
    });
    check();
  });
}

// ── 消息订阅 ──

export function onSWMessage(type, handler) {
  if (!handlerMap.has(type)) handlerMap.set(type, new Set());
  handlerMap.get(type).add(handler);
}

export function offSWMessage(type, handler) {
  const s = handlerMap.get(type);
  if (s) s.delete(handler);
}

export function onSWReady(cb) {
  readyCallbacks.push(cb);
  if (swController) cb();
}

export function onControllerChange(cb) {
  controllerChangeCallbacks.push(cb);
}

// ── 通用消息分发 ──

navigator.serviceWorker.addEventListener("message", (event) => {
  const msg = event.data;
  if (!msg || !msg.type) return;

  if (msg.type === "sw-updated") {
    import("./ui-shell.js").then((mod) => {
      mod.setSWStatus("orange", "🔄 点击刷新");
      const st = document.getElementById("swStatus");
      const parent = st && st.parentElement;
      if (parent) {
        parent.style.cursor = "pointer";
        parent.onclick = () => location.reload();
      }
    });
    return;
  }

  const handlers = handlerMap.get(msg.type);
  if (handlers) handlers.forEach((h) => h(msg));
});

// ── GET 触发流式下载（REST 风格，隐藏 iframe 触发）──

const TRIGGER_TIMEOUT_MS = 30000;

export function triggerDownload(url) {
  const u = new URL(url, location.origin);
  const idParam = u.searchParams.get("id");
  const idxParam = u.searchParams.get("idx");
  const extractedJobId = idxParam ? idParam + "_" + idxParam : idParam;

  const f = document.createElement("iframe");
  f.id = extractedJobId;
  f.style.display = "none";
  document.body.appendChild(f);
  f.src = url;

  let cleanup;
  const cleanupPromise = new Promise((resolve) => {
    cleanup = resolve;
  });

  const handler = (e) => {
    if (e.data.type === "job-start" && e.data.jobId === extractedJobId) {
      navigator.serviceWorker.removeEventListener("message", handler);
      cleanup();
    }
  };
  navigator.serviceWorker.addEventListener("message", handler);

  Promise.race([
    cleanupPromise,
    new Promise((resolve) => setTimeout(resolve, TRIGGER_TIMEOUT_MS)),
  ]).then(() => {
    navigator.serviceWorker.removeEventListener("message", handler);
    if (f.parentNode) {
      setTimeout(() => f.remove(), 465);
    }
  });
}

// ── 生命周期追踪 ──

export function initSW() {
  if (!("serviceWorker" in navigator)) {
    import("./ui-shell.js").then((mod) =>
      mod.setSWStatus("gray", "浏览器不支持"),
    );
    toast("⚠️ 当前浏览器不支持 Service Worker");
    return;
  }

  const hadController = !!navigator.serviceWorker.controller;

  import("./ui-shell.js").then((mod) => mod.setSWStatus("yellow", "注册中"));

  navigator.serviceWorker
    .register("sw.js")
    .then((registration) => {
      swRegistration = registration;
      import("./ui-shell.js").then((mod) => {
        if (registration.waiting) {
          mod.setSWStatus("orange", "新版本可用");
        } else if (navigator.serviceWorker.controller) {
          mod.setSWStatus("green", "已就绪");
        } else if (registration.installing) {
          mod.setSWStatus("blue", "安装中");
        } else {
          mod.setSWStatus("blue", "等待激活");
        }
      });

      registration.addEventListener("updatefound", () => {
        const sw = registration.installing;
        if (!sw) return;
        if (navigator.serviceWorker.controller)
          import("./ui-shell.js").then((mod) =>
            mod.setSWStatus("orange", "新版本可用"),
          );
        sw.addEventListener("statechange", () => {
          if (sw.state === "installed" && navigator.serviceWorker.controller) {
            import("./ui-shell.js").then((mod) =>
              mod.setSWStatus("orange", "新版本已就绪"),
            );
          }
        });
      });
    })
    .catch((e) => {
      console.error("SW 注册失败", e);
      import("./ui-shell.js").then((mod) => mod.setSWStatus("red", "注册失败"));
      toast("⚠️ Service Worker 注册失败");
    });

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    swController = navigator.serviceWorker.controller;
    if (hadController) {
      import("./ui-shell.js").then((mod) => {
        mod.setSWStatus("purple", "更新中");
        statusTimer = setTimeout(() => mod.setSWStatus("green", "已更新"), 600);
      });
    }
    controllerChangeCallbacks.forEach((cb) => cb());
  });

  navigator.serviceWorker.ready.then(() => {
    swController = navigator.serviceWorker.controller;
    if (!swRegistration || !swRegistration.waiting) {
      import("./ui-shell.js").then((mod) => mod.setSWStatus("green", "已就绪"));
    }
    readyCallbacks.forEach((cb) => cb());
  });
}
