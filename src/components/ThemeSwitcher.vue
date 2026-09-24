<script setup lang="ts">
// 主题切换器。两种形态共用同一份面板标记:
//   · 默认(顶栏)   → 调色板图标按钮 + 浮层
//   · inline(设置页) → 面板直接铺在页面里
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import Icon from './Icon.vue'
import { useTheme, type ThemeDef } from '../composables/useTheme'
import type { ThemeId, ThemeMode } from '../types/godot'

const props = withDefaults(defineProps<{ inline?: boolean }>(), { inline: false })

const { theme, mode, resolvedMode, currentTheme, currentMode, themes, modes, setTheme, setMode } = useTheme()

const open = ref(false)
const rootEl = ref<HTMLElement>()

/** 预览色跟随当前明暗,避免「浮层里看着是浅色、点下去是深色」 */
function swatchOf(t: ThemeDef) {
  return resolvedMode.value === 'dark' ? t.swatchDark : t.swatch
}

const summary = computed(() => {
  const modeText = mode.value === 'auto'
    ? `跟随宿主(当前${resolvedMode.value === 'dark' ? '深色' : '浅色'})`
    : currentMode.value.name
  return `${currentTheme.value.name} · ${modeText}`
})

function pickTheme(id: ThemeId) {
  setTheme(id)
}

function pickMode(next: ThemeMode) {
  setMode(next)
}

// 点击外部 / Esc 关闭浮层(内联形态不需要)
function onDocMouseDown(e: MouseEvent) {
  if (!open.value || props.inline) return
  if (rootEl.value && !rootEl.value.contains(e.target as Node)) open.value = false
}

function onDocKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && open.value) open.value = false
}

onMounted(() => {
  document.addEventListener('mousedown', onDocMouseDown)
  document.addEventListener('keydown', onDocKey)
})

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocMouseDown)
  document.removeEventListener('keydown', onDocKey)
})
</script>

<template>
  <div ref="rootEl" class="ts-root" :class="{ inline }">
    <button
      v-if="!inline"
      type="button"
      class="ts-btn"
      :class="{ on: open }"
      :title="`界面主题:${summary}`"
      @click="open = !open"
    >
      <Icon name="palette" :size="15" />
    </button>

    <div v-show="inline || open" class="ts-panel" :class="{ pop: !inline }">
      <!-- 明暗 -->
      <div class="ts-modes">
        <button
          v-for="m in modes"
          :key="m.id"
          type="button"
          class="ts-mode"
          :class="{ on: mode === m.id }"
          :title="m.name"
          @click="pickMode(m.id)"
        >
          <Icon :name="m.icon" :size="12" />
          <span>{{ m.name }}</span>
        </button>
      </div>

      <!-- 色板 -->
      <div class="ts-list">
        <button
          v-for="t in themes"
          :key="t.id"
          type="button"
          class="ts-item"
          :class="{ on: theme === t.id }"
          :title="t.desc"
          @click="pickTheme(t.id)"
        >
          <span class="ts-swatch" :style="{ background: swatchOf(t)[1], borderColor: swatchOf(t)[3] }">
            <i :style="{ background: swatchOf(t)[2] }"></i>
            <b :style="{ background: swatchOf(t)[0] }"></b>
          </span>
          <span class="ts-meta">
            <span class="ts-name">
              {{ t.name }}
              <Icon v-if="theme === t.id" name="check" :size="11" />
            </span>
            <span class="ts-desc">{{ t.desc }}</span>
          </span>
        </button>
      </div>

      <div class="ts-foot">{{ summary }}</div>
    </div>
  </div>
</template>

<style scoped>
.ts-root {
  position: relative;
  flex-shrink: 0;
}

/* 顶栏按钮 */
.ts-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 26px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-2);
  color: var(--text-2);
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s, background 0.15s;
}

.ts-btn:hover,
.ts-btn.on {
  color: var(--brand);
  border-color: var(--brand);
  background: var(--brand-weak);
}

/* 面板 */
.ts-panel {
  width: 274px;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: var(--shadow-lift);
}

.ts-panel.pop {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  z-index: 60;
  animation: ts-pop 0.14s ease;
}

/* 本地定义关键帧:scoped 样式引用全局 @keyframes 的改名行为依版本而异,不用它 */
@keyframes ts-pop {
  from {
    opacity: 0;
    transform: translateY(-6px) scale(0.98);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

.ts-root.inline .ts-panel {
  width: auto;
  padding: 0;
  border: none;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}

/* 明暗分段 */
.ts-modes {
  display: flex;
  gap: 3px;
  padding: 3px;
  border-radius: 9px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  margin-bottom: 10px;
}

.ts-mode {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 4px 6px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--text-2);
  font-size: 11.5px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.15s, color 0.15s;
}

.ts-mode:hover {
  color: var(--text);
}

.ts-mode.on {
  background: var(--surface);
  color: var(--brand);
  font-weight: 600;
  box-shadow: var(--shadow-sm);
}

/* 色板列表 */
.ts-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.ts-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 7px 8px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  text-align: left;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}

.ts-item:hover {
  background: var(--surface-2);
}

.ts-item.on {
  border-color: var(--brand);
  background: var(--brand-weak);
}

/* 迷你窗口预览 */
.ts-swatch {
  position: relative;
  width: 40px;
  height: 28px;
  border-radius: 6px;
  border: 1px solid;
  flex-shrink: 0;
  overflow: hidden;
}

.ts-swatch i {
  position: absolute;
  top: 4px;
  right: 4px;
  bottom: 4px;
  left: 4px;
  border-radius: 3px;
}

.ts-swatch b {
  position: absolute;
  left: 5px;
  bottom: 5px;
  width: 13px;
  height: 3px;
  border-radius: 2px;
}

.ts-meta {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.ts-name {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  font-weight: 650;
  color: var(--text);
}

.ts-item.on .ts-name {
  color: var(--brand);
}

.ts-desc {
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ts-root.inline .ts-item {
  padding: 9px 10px;
}

.ts-root.inline .ts-desc {
  white-space: normal;
}

.ts-foot {
  margin-top: 9px;
  padding-top: 8px;
  border-top: 1px solid var(--border);
  font-size: 11px;
  color: var(--text-3);
}

.ts-root.inline .ts-foot {
  margin-top: 12px;
}
</style>
