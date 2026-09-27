<script setup lang="ts">
import Icon from './Icon.vue'
import ThemeSwitcher from './ThemeSwitcher.vue'

const tabs = [
  { key: 'dashboard', label: '概览', icon: 'grid' },
  { key: 'projects', label: '项目', icon: 'folder' },
  { key: 'versions', label: '版本', icon: 'package' },
  { key: 'marketplace', label: '市场', icon: 'puzzle' },
  { key: 'addons', label: '已安装', icon: 'check' },
  { key: 'docs', label: '文档', icon: 'book' },
  { key: 'backups', label: '备份', icon: 'archive' },
  { key: 'settings', label: '设置', icon: 'gear' }
]

defineProps<{ modelValue: string }>()
const emit = defineEmits<{ (e: 'update:modelValue', v: string): void }>()
</script>

<template>
  <nav class="tabbar">
    <div class="brand">
      <!-- 品牌标识:齿轮冠 + 机器人头 + 项目立方体(与 src-ztools/logo.png 同源,见 design/logo.svg) -->
      <svg class="logo" viewBox="0 0 48 48" width="30" height="30" aria-hidden="true">
        <defs>
          <linearGradient id="gpm-logo-g" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="48" y2="48">
            <stop offset="0" stop-color="#5aa6db" />
            <stop offset="1" stop-color="#478cbf" />
          </linearGradient>
        </defs>
        <rect width="48" height="48" rx="11" fill="url(#gpm-logo-g)" />
        <g fill="#ffffff">
          <circle cx="24" cy="25" r="14.3" />
          <rect x="21.1" y="5.8" width="5.8" height="9.8" rx="1.6" transform="rotate(-46 24 25)" />
          <rect x="21.1" y="5.8" width="5.8" height="9.8" rx="1.6" transform="rotate(-15 24 25)" />
          <rect x="21.1" y="5.8" width="5.8" height="9.8" rx="1.6" transform="rotate(15 24 25)" />
          <rect x="21.1" y="5.8" width="5.8" height="9.8" rx="1.6" transform="rotate(46 24 25)" />
        </g>
        <g fill="none" stroke="url(#gpm-logo-g)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round">
          <path d="M24 16.6l7.2 4.2v8.4L24 33.4l-7.2-4.2v-8.4z" />
          <path d="M16.8 20.8L24 25l7.2-4.2M24 25v8.4" />
        </g>
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

    <span class="grow"></span>
    <ThemeSwitcher />
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
  /* 让主题浮层盖在内容区之上 */
  position: relative;
  z-index: 30;
}

.brand {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-right: 6px;
  flex-shrink: 0;
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

/* 8 个标签 + 品牌区接近窗口宽度上限:允许横向滚动,任何宽度下都不换行、不溢出 */
.tabs {
  display: flex;
  gap: 2px;
  padding: 3px;
  border-radius: 999px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
}

.tabs::-webkit-scrollbar {
  display: none;
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
  flex-shrink: 0;
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

/* 窄窗口:先收标签内边距,再隐藏品牌副标题,最后只留品牌图标 */
@media (max-width: 980px) {
  .tabbar {
    gap: 8px;
    padding: 9px 12px;
  }

  .tab {
    padding: 5px 10px;
    gap: 4px;
  }
}

@media (max-width: 900px) {
  .titles {
    display: none;
  }
}

@media (max-width: 800px) {
  .tab span {
    display: none;
  }

  .tab {
    padding: 5px 9px;
  }
}
</style>
