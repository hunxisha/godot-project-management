<script setup lang="ts">
import Icon from './Icon.vue'

const tabs = [
  { key: 'dashboard', label: '概览', icon: 'grid' },
  { key: 'projects', label: '项目', icon: 'folder' },
  { key: 'versions', label: '版本', icon: 'package' },
  { key: 'marketplace', label: '插件', icon: 'puzzle' },
  { key: 'settings', label: '设置', icon: 'gear' }
]

defineProps<{ modelValue: string }>()
const emit = defineEmits<{ (e: 'update:modelValue', v: string): void }>()
</script>

<template>
  <nav class="tabbar">
    <div class="brand">
      <!-- 品牌标识:机器人齿轮 -->
      <svg class="logo" viewBox="0 0 48 48" width="30" height="30" aria-hidden="true">
        <defs>
          <linearGradient id="gpm-logo-g" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stop-color="#5aa6db" />
            <stop offset="1" stop-color="#33689a" />
          </linearGradient>
        </defs>
        <rect x="1.5" y="1.5" width="45" height="45" rx="11" fill="url(#gpm-logo-g)" />
        <rect x="14" y="17" width="20" height="17" rx="4.5" fill="#fff" />
        <rect x="9.6" y="19.6" width="5.2" height="7" rx="1.7" fill="#fff" />
        <rect x="33.2" y="19.6" width="5.2" height="7" rx="1.7" fill="#fff" />
        <rect x="18.4" y="22.6" width="4.6" height="6.4" rx="1.5" fill="#33689a" />
        <rect x="25" y="22.6" width="4.6" height="6.4" rx="1.5" fill="#33689a" />
      </svg>
      <div class="titles">
        <span class="name">Godot 管理</span>
        <span class="sub">引擎 · 项目 · 插件</span>
      </div>
    </div>

    <div class="tabs">
      <button
        v-for="t in tabs"
        :key="t.key"
        class="tab"
        :class="{ active: modelValue === t.key }"
        @click="emit('update:modelValue', t.key)"
      >
        <Icon :name="t.icon" :size="14" />
        <span>{{ t.label }}</span>
      </button>
    </div>
  </nav>
</template>

<style scoped>
.tabbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 16px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.brand {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-right: 6px;
}

.logo {
  border-radius: 8px;
  box-shadow: 0 1px 3px rgba(23, 37, 56, 0.25);
  flex-shrink: 0;
}

.titles {
  display: flex;
  flex-direction: column;
  line-height: 1.15;
}

.name {
  font-size: 13px;
  font-weight: 700;
  color: var(--text);
}

.sub {
  font-size: 10px;
  letter-spacing: 0.08em;
  color: var(--text-3);
}

.tabs {
  display: flex;
  gap: 2px;
  padding: 3px;
  border-radius: 999px;
  background: var(--surface-2);
  border: 1px solid var(--border);
}

.tab {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 13px;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: var(--text-2);
  font-size: 12.5px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.15s, color 0.15s, box-shadow 0.15s;
  white-space: nowrap;
}

.tab:hover {
  color: var(--text);
}

.tab.active {
  background: var(--surface);
  color: var(--brand);
  font-weight: 600;
  box-shadow: var(--shadow-sm);
}
</style>
