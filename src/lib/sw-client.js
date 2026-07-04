// SW 客户端 — 注册 + 状态监听
"use strict";

export function initSW() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker
    .register("sw.js")
    .then(() => console.log("SW registered"))
    .catch((e) => console.warn("SW register failed:", e));
}

export function swSend(msg) {
  if (navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage(msg);
  } else {
    console.warn("SW not ready");
  }
}