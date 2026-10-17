<script setup lang="ts">
/** Workbench 2.0 左侧导航栏(替代旧 TabBar):
 *  · 分组导航(工作区 / 资源),Godot 编辑器 dock 式左侧竖栏
 *  · 顶部品牌 + 命令面板入口(Ctrl+K),底部主题/设置
 *  · 可收起为纯图标模式(状态持久化到 localStorage),窄窗口自动图标化 */
import { onMounted, ref, watch } from 'vue'
import Icon from './Icon.vue'
import ThemeSwitcher from './ThemeSwitcher.vue'
import { listDocs } from '../services/bridge'
import type { GodotProject } from '../types/godot'

type NavItem = { key: string; label: string; icon: string; match?: string[] }

const NAV_GROUPS: { label: string; items: NavItem[] }[] = [
  {
    label: '工作区',
    items: [
      { key: 'dashboard', label: '概览', icon: 'grid' },
      { key: 'projects', label: '项目', icon: 'folder' },
      { key: 'plugins', label: '插件', icon: 'puzzle', match: ['marketplace', 'addons'] }
    ]
  },
  {
    label: '资源',
    items: [
      { key: 'versions', label: '引擎', icon: 'package' },
      { key: 'docs', label: '文档', icon: 'book' },
      { key: 'backups', label: '备份', icon: 'archive' }
    ]
  }
]

const props = defineProps<{ modelValue: string }>()
const emit = defineEmits<{
  (e: 'update:modelValue', v: string): void
  (e: 'command'): void
}>()

const COLLAPSE_KEY = 'gpm.sidebar.collapsed'
const collapsed = ref(localStorage.getItem(COLLAPSE_KEY) === '1')

function toggleCollapse() {
  collapsed.value = !collapsed.value
  localStorage.setItem(COLLAPSE_KEY, collapsed.value ? '1' : '0')
}

/** 徽标:项目数(挂载与每次切页时刷新,够用于侧栏展示) */
const projectCount = ref(0)

async function refreshCount() {
  try {
    const docs = await listDocs<GodotProject>('godot/project/')
    projectCount.value = docs.length
  } catch {
    /* 宿主未就绪时静默,侧栏徽标非关键数据 */
  }
}

onMounted(refreshCount)
watch(() => props.modelValue, refreshCount)

function isActive(t: NavItem) {
  return t.match ? t.match.includes(props.modelValue) : props.modelValue === t.key
}

function pick(t: NavItem) {
  emit('update:modelValue', t.key)
}
</script>

<template>
  <aside class="rail" :class="{ collapsed }">
    <!-- 品牌 -->
    <div class="brand">
      <svg class="logo" viewBox="0 0 48 48" width="28" height="28" aria-hidden="true">
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
      <div class="brand-text">
        <span class="name">Godot 工坊</span>
        <span class="sub">Workbench 2.0</span>
      </div>
    </div>

    <!-- 命令面板入口 -->
    <button class="command" :title="collapsed ? '命令面板 (Ctrl+K)' : ''" @click="emit('command')">
      <Icon name="search" :size="14" />
      <span class="command-text">搜索或执行命令…</span>
      <span class="kbd k-in">Ctrl K</span>
    </button>

    <!-- 分组导航 -->
    <nav class="nav">
      <template v-for="group in NAV_GROUPS" :key="group.label">
        <div class="group-label">{{ group.label }}</div>
        <button
          v-for="t in group.items"
          :key="t.key"
          class="nav-item"
          :class="{ active: isActive(t) }"
          :title="collapsed ? t.label : ''"
          :aria-current="isActive(t) ? 'page' : undefined"
          @click="pick(t)"
        >
          <span class="ni-bar" aria-hidden="true"></span>
          <Icon :name="t.icon" :size="15" />
          <span class="ni-label">{{ t.label }}</span>
          <span v-if="t.key === 'projects' && projectCount" class="ni-badge">{{ projectCount }}</span>
        </button>
      </template>
    </nav>

    <span class="grow"></span>

    <!-- 底部:收起 / 主题 / 设置 -->
    <div class="rail-foot">
      <button class="foot-btn" :title="collapsed ? '展开侧边栏' : '收起侧边栏'" @click="toggleCollapse">
        <Icon name="chevrons-left" :size="15" :style="collapsed ? 'transform:rotate(180deg)' : ''" />
      </button>
      <ThemeSwitcher place="side" />
      <button
        class="foot-btn"
        :class="{ active: modelValue === 'settings' }"
        title="设置"
        aria-label="设置"
        @click="emit('update:modelValue', 'settings')"
      >
        <Icon name="gear" :size="15" />
      </button>
    </div>
  </aside>
</template>

<style scoped>
.rail {
  display: flex;
  flex-direction: column;
  width: 208px;
  flex-shrink: 0;
  padding: 10px 8px;
  background: var(--chrome);
  border-right: 1px solid var(--chrome-border);
  overflow: visible; /* 主题浮层需要溢出显示 */
  transition: width 0.18s ease;
}

.rail.collapsed {
  width: 54px;
}

/* ---------- 品牌 ---------- */

.brand {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 4px 6px 12px;
  border-bottom: 1px solid var(--chrome-border);
  margin-bottom: 10px;
  min-height: 44px;
}

.logo {
  border-radius: 8px;
  box-shadow: 0 1px 3px rgba(15, 25, 40, 0.3);
  flex-shrink: 0;
}

.brand-text {
  display: flex;
  flex-direction: column;
  line-height: 1.2;
  white-space: nowrap;
}

.name {
  font-size: 13px;
  font-weight: 700;
  color: var(--text);
  letter-spacing: 0.01em;
}

.sub {
  font-size: 9.5px;
  letter-spacing: 0.1em;
  color: var(--chrome-text-2);
  font-family: var(--mono);
}

/* ---------- 命令入口 ---------- */

.command {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 9px;
  margin-bottom: 10px;
  border: 1px solid var(--chrome-border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--chrome-text-2);
  font-size: 12px;
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s, box-shadow 0.15s;
}

.command:hover {
  border-color: var(--brand);
  color: var(--brand);
  box-shadow: var(--shadow-sm);
}

.command-text {
  flex: 1;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.k-in {
  flex-shrink: 0;
  font-size: 9.5px;
}

/* ---------- 导航 ---------- */

.nav {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.group-label {
  padding: 8px 10px 4px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.1em;
  color: var(--chrome-text-2);
  text-transform: uppercase;
  white-space: nowrap;
}

.nav-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 6.5px 10px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--chrome-text);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.14s, color 0.14s;
}

/* 左侧品牌指示条(Godot 编辑器 tab 语汇) */
.ni-bar {
  position: absolute;
  left: 0;
  top: 7px;
  bottom: 7px;
  width: 3px;
  border-radius: 3px;
  background: transparent;
  transition: background 0.14s;
}

.nav-item:hover {
  background: var(--chrome-2);
  color: var(--text);
}

.nav-item.active {
  background: var(--brand-weak);
  color: var(--brand);
  font-weight: 600;
}

.nav-item.active .ni-bar {
  background: var(--brand);
}

.ni-label {
  flex: 1;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ni-badge {
  min-width: 18px;
  height: 16px;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--surface-3);
  color: var(--chrome-text);
  font-size: 10px;
  font-weight: 700;
  line-height: 16px;
  text-align: center;
}

.nav-item.active .ni-badge {
  background: var(--brand);
  color: #fff;
}

/* ---------- 底部 ---------- */

.rail-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  padding-top: 8px;
  border-top: 1px solid var(--chrome-border);
  margin-top: 8px;
}

.rail.collapsed .rail-foot {
  flex-direction: column;
  justify-content: flex-start;
}

.foot-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 28px;
  border: 1px solid transparent;
  border-radius: 7px;
  background: transparent;
  color: var(--chrome-text);
  cursor: pointer;
  transition: color 0.15s, background 0.15s, border-color 0.15s;
}

.foot-btn:hover {
  color: var(--brand);
  background: var(--chrome-2);
}

.foot-btn.active {
  color: var(--brand);
  background: var(--brand-weak);
  border-color: var(--brand);
}

/* ---------- 收起模式 ---------- */

.rail.collapsed .brand {
  justify-content: center;
  padding-left: 0;
  padding-right: 0;
}

.rail.collapsed .brand-text,
.rail.collapsed .command-text,
.rail.collapsed .k-in,
.rail.collapsed .group-label,
.rail.collapsed .ni-label,
.rail.collapsed .ni-badge {
  display: none;
}

.rail.collapsed .command {
  justify-content: center;
  padding: 6px 0;
}

.rail.collapsed .nav-item {
  justify-content: center;
  padding: 7px 0;
  gap: 0;
}

/* 窄窗口:无论收起状态如何都图标化,避免挤压内容区 */
@media (max-width: 820px) {
  .rail:not(.collapsed) {
    width: 54px;
  }

  .rail:not(.collapsed) .brand-text,
  .rail:not(.collapsed) .command-text,
  .rail:not(.collapsed) .k-in,
  .rail:not(.collapsed) .group-label,
  .rail:not(.collapsed) .ni-label,
  .rail:not(.collapsed) .ni-badge {
    display: none;
  }

  .rail:not(.collapsed) .brand {
    justify-content: center;
    padding-left: 0;
    padding-right: 0;
  }

  .rail:not(.collapsed) .command {
    justify-content: center;
    padding: 6px 0;
  }

  .rail:not(.collapsed) .nav-item {
    justify-content: center;
    padding: 7px 0;
    gap: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .rail {
    transition: none;
  }
}
</style>
