// F2V 入口 — 模块导入 + SW 启动
"use strict";

import "./style.css";
import { initSW } from "./lib/sw-client.js";

// 各模块在 import 时自动注册 DOM 事件和 SW 消息订阅
import "./lib/ui-shell.js";
import "./lib/task-manager.js";
import "./lib/encode-tab.js";
import "./lib/decode-tab.js";

// SW 启动
initSW();

if (window.deloading) window.deloading();
