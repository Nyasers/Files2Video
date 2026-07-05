// SW 通信层 — Service Worker 生命周期 + 消息投递
// 与 F2P 同步：集中消息分发、状态管理
"use strict";

// ── 内部状态 ──

let swController = null;
const handlerMap = new Map(); // type → Set<handler>
const readyCallbacks = [];
const controllerChangeCallbacks = [];

// ── 消息投递 ──

export function swSend(msg) {
  if (swController) swController.postMessage(msg);
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

  // sw-updated 由消息层自己处理
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

// ── 生命周期追踪 ──

navigator.serviceWorker.addEventListener("controllerchange", () => {
  swController = navigator.serviceWorker.controller;
  controllerChangeCallbacks.forEach((cb) => cb());
});

export function initSW() {
  if (!("serviceWorker" in navigator)) return;

  if (navigator.serviceWorker.controller) {
    swController = navigator.serviceWorker.controller;
  }

  navigator.serviceWorker
    .register("sw.js")
    .then(() => {
      swController = navigator.serviceWorker.controller;
      readyCallbacks.forEach((cb) => cb());
    })
    .catch(() => {});

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    swController = navigator.serviceWorker.controller;
    if (swController) readyCallbacks.forEach((cb) => cb());
  });
}
