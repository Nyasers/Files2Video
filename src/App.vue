<template>
  <div class="app-shell">
    <div class="app-header">
      <div class="app-brand">
        <svg class="app-logo" width="24" height="24" viewBox="0 0 64 64" fill="none" aria-hidden="true">
          <rect x="4" y="10" width="56" height="38" rx="4" stroke="var(--accent)" stroke-width="2" fill="none" />
          <polygon points="26,22 44,29 26,36" fill="var(--accent)" opacity="0.5" />
          <circle cx="52" cy="17" r="4" fill="var(--success)" />
        </svg>
        <h1 class="app-title">F2V</h1>
        <span class="app-tagline">隐于帧流，读之如晤</span>
      </div>
    </div>

    <TopBar :activeTab="activeTab" @tab-change="switchTab" />

    <EncodePanel v-show="activeTab === 'enc'" @encode-done="switchTab('tasks')" />
    <DecodePanel v-show="activeTab === 'dec'" />
    <TasksPanel v-show="activeTab === 'tasks'" />

    <div class="app-footer">
      <SWStatus />
    </div>
    <ToastHost />
  </div>
</template>

<script setup>
import { ref } from "vue";
import TopBar from "./components/TopBar.vue";
import EncodePanel from "./components/EncodePanel.vue";
import DecodePanel from "./components/DecodePanel.vue";
import TasksPanel from "./components/TasksPanel.vue";
import SWStatus from "./components/SWStatus.vue";
import ToastHost from "./components/ToastHost.vue";

const activeTab = ref("enc");

function switchTab(tab) {
  activeTab.value = tab;
  try {
    sessionStorage.setItem("f2v.tab", tab);
  } catch { }
}

// 恢复上次选中的标签
try {
  const saved = sessionStorage.getItem("f2v.tab");
  if (saved && ["enc", "dec", "tasks"].includes(saved)) {
    activeTab.value = saved;
  }
} catch { }
</script>
