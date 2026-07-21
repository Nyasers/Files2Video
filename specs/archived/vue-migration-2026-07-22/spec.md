# F2V Vue 迁移 + 界面美化

## Goal

将 Files2Video 从原生 JS 架构迁移到 Vue 3（Rspack + vue-loader），同时在不影响功能的前提下美化 UI。复用 Files2Picture 的 Vue 迁移经验，保持两个项目在前端技术栈和设计语言上的一致性。

## Non-Goals

- 不修改 Service Worker（sw.js）的编码/解码逻辑
- 不修改核心库 f2v-core.js 和 coders/ 目录下的编解码实现
- 不重构加密/解码数据流，仅将 UI 层从 JS DOM 操作替换为 Vue 模板
- 不与 F2P 共享组件（各自维护独立的组件结构）
- 不新增批量解码/编码功能

## Acceptance Criteria

- [ ] 三个 Tab（编码/解码/任务）切换正常，保留上次活跃 Tab
- [ ] 编码面板：文件选择、拖放、列表显示（#序号、文件名、大小）、移除、清空全部正常
- [ ] 编码面板：分辨率选择、FPS 输入、分块大小选择、内存提示正常
- [ ] 编码面板：密码输入、生成按钮（禁用/启用逻辑）正常
- [ ] 编码流程：点击生成 → 向 SW 发送 f2v2-encode 消息 → 自动跳转任务 Tab
- [ ] 解码面板：文件选择、拖放、F2V1/F2V2 格式检测正常
- [ ] 解码流程：选择视频 → 检测格式 → 点击提取 → 显示文件列表（全选、下载选中、单个下载）
- [ ] 任务面板：运行中任务进度条实时更新，完成后保留历史记录
- [ ] SW 状态指示器正常显示（green/red/yellow/gray 等状态）
- [ ] Toast 通知正常显示
- [ ] 构建成功（`npm run build`），产物在 dist/ 下
- [ ] 所有图标替换为纯 SVG，无深色背景，无 emoji 图标
- [ ] 界面采用极简扁平风格，颜色方案与 F2P 保持一致

## Boundary Conditions

- 浏览器版本过低时显示兼容性提示
- 编码时文件列表为空则生成按钮禁用
- 解码时选择非 F2V 格式文件提示未知格式
- 拖放时 drag-over 状态样式正确
- 任务列表超过 50 条自动裁剪旧记录
- 文件列表超长时滚动正常
- 并发编码/解码任务不受 UI 迁移影响

## Constraints

- 保持 Rspack 构建体系，不引入 Vite
- 添加 vue-loader + vue 依赖
- SW 入口保持 webworker target，不引入 Vue
- 核心库（f2v-core.js, coders/, sw-client.js）不做语法转换，保持原有 ES module
- 兼容 Chrome 86+ / 现代浏览器
- 不引入额外 CSS 框架

## Design Decisions

### 组件结构

```
src/
├── main.js                    ← Vue 入口
├── index.html                 ← 空壳，仅 <div id="app">
├── style.css                  ← 全局样式（Vue 组件使用 scoped 或全局）
├── App.vue                    ← 根组件：标题栏 + 页脚 + Tab 切换
└── components/
    ├── TopBar.vue              ← Tab 切换 + 分块大小选择器
    ├── EncodePanel.vue         ← 编码面板（来自 encode-tab.js + ui-shell.js 编码部分）
    ├── DecodePanel.vue         ← 解码面板（来自 decode-tab.js）
    ├── TasksPanel.vue          ← 任务面板（来自 task-manager.js）
    ├── SWStatus.vue            ← SW 状态指示器（来自 ui-shell.js）
    └── ToastHost.vue           ← Toast 容器（来自 sw-client.js toast）
```

### 核心不变，只换 UI 层

所有业务逻辑和数据流不变：

- swSend/onSWMessage → 与 SW 通信
- f2v-core.js → 核心加密/预计算
- coders/ → 编解码实现
- sw.js → Service Worker

UI 层从 template cloning + 手动 DOM 操作改为 Vue 响应式模板。

### 设计风格

复用 F2P 的极简扁平风格：

- 深色背景 #14151a
- 卡片背景 #1c1d24
- 主色调蓝色 accent（#6a5acd → 紫蓝色渐变）
- 纯 SVG 图标（14-16px，stroke-width 1.5）
- 圆角 10-12px

### index.html 瘦身

去掉内联的 loading overlay、模板 template 标签、noscript。loading 改为 Vue 组件在 app mount 后显示。

### toast 改造

将原有的 `toast()` 函数改为 Vue 组件 ToastHost，通过 provide/inject 或全局变量提供 showToast 能力。保留 `toast` 作为导出函数供其他模块使用。
