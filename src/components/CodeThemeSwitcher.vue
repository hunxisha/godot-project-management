<script setup lang="ts">
// 代码配色切换器。两种形态:
//   · 默认(文档页头部) → 图标 + 当前方案名按钮 + 浮层
//   · inline(设置页)    → 方案列表直接铺在页面里
//
// 预览不是画出来的色块:每行都是一段真代码,用 .tok-* 着色,外层带
// data-code/data-mode —— main.css 里同一份变量规则同时作用于 <html> 和这里,
// 所以「看到的就是选下去后长成的样子」。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import Icon from './Icon.vue'
import { useTheme } from '../composables/useTheme'
import type { CodeThemeId } from '../types/godot'

const props = withDefaults(defineProps<{ inline?: boolean }>(), { inline: false })

const { codeTheme, currentCodeTheme, codeThemes, resolvedMode, setCodeTheme } = useTheme()

const open = ref(false)
const rootEl = ref<HTMLElement>()

/** 浮层里的预览行:与当前明暗一致,避免「看着是浅色、选下去是深色」 */
const previewMode = computed(() => resolvedMode.value)

function pick(id: CodeThemeId) {
  setCodeTheme(id)
  // 浮层形态选完就收,设置页的 inline 列表保持展开便于来回比较
  if (!props.inline) open.value = false
}

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
  <div ref="rootEl" class="ct-root" :class="{ inline }">
    <button
      v-if="!inline"
      type="button"
      class="ct-btn"
      :class="{ on: open }"
      :aria-expanded="open"
      aria-haspopup="listbox"
      :title="`代码配色:${currentCodeTheme.name} — ${currentCodeTheme.desc}`"
      @click="open = !open"
    >
      <Icon name="terminal" :size="13" />
      <span class="ct-btn-label">{{ currentCodeTheme.name }}</span>
      <Icon name="chevron-down" :size="11" />
    </button>

    <div v-show="inline || open" class="ct-panel" :class="{ pop: !inline }">
      <div class="ct-hint">
        文档签名与代码块共用这套颜色
      </div>

      <button
        v-for="c in codeThemes"
        :key="c.id"
        type="button"
        class="ct-item"
        :class="{ on: codeTheme === c.id }"
        :aria-pressed="codeTheme === c.id"
        :title="c.desc"
        @click="pick(c.id)"
      >
        <!-- 两行样例:第一行盖住关键字/函数/类型/运算符,第二行盖住字符串/数字/注释/成员 -->
        <span class="ct-code mono" :data-code="c.id" :data-mode="previewMode">
          <span class="ct-line">
            <span class="tok-kw">func</span> <span class="tok-fn">add_point</span><span class="tok-sym">(</span><span class="tok-tye">Vector2</span><span class="tok-sym">)</span> <span class="tok-sym">-&gt;</span> <span class="tok-tyb">void</span>
          </span>
          <span class="ct-line">
            <span class="tok-kw">var</span> <span class="tok-mem">n</span> <span class="tok-sym">=</span> <span class="tok-num">3</span><span class="tok-sym">,</span> <span class="tok-str">"ok"</span> <span class="tok-com"># 注释</span>
          </span>
        </span>
        <span class="ct-meta">
          <span class="ct-name">
            {{ c.name }}
            <Icon v-if="codeTheme === c.id" name="check" :size="11" />
          </span>
          <span class="ct-desc">{{ c.desc }}</span>
        </span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.ct-root {
  position: relative;
  flex-shrink: 0;
}

/* ---------- 触发按钮(文档页头部) ---------- */
.ct-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 9px;
  border: 1px solid var(--border-strong);
  border-radius: 7px;
  background: var(--surface);
  color: var(--text-2);
  font-size: 12px;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s, background 0.15s;
}

.ct-btn:hover,
.ct-btn.on {
  color: var(--brand);
  border-color: var(--brand);
  background: var(--brand-weak);
}

.ct-btn-label {
  max-width: 5em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ct-panel {
  width: 302px;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: var(--shadow-lift);
}

.ct-panel.pop {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  z-index: 60;
  max-height: min(430px, calc(100vh - 48px));
  overflow-y: auto;
  animation: ct-pop 0.14s ease;
}

@keyframes ct-pop {
  from {
    opacity: 0;
    transform: translateY(-6px) scale(0.98);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

.ct-root.inline .ct-panel {
  width: auto;
  padding: 0;
  border: none;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}

.ct-hint {
  padding: 2px 6px 8px;
  font-size: 11px;
  color: var(--text-3);
}

.ct-root.inline .ct-hint {
  padding-bottom: 10px;
}

/* ---------- 方案行 ---------- */
.ct-item {
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

.ct-item:hover {
  background: var(--surface-2);
}

.ct-item.on {
  border-color: var(--brand);
  background: var(--brand-weak);
}

/* 预览块:底色跟随代码块(与真实 CodeBlock 的 --surface-2 一致) */
.ct-code {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex-shrink: 0;
  width: 148px;
  padding: 5px 7px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface-2);
  font-size: 10.5px;
  line-height: 1.45;
  white-space: nowrap;
  overflow: hidden;
}

.ct-line {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ct-meta {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.ct-name {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  font-weight: 650;
  color: var(--text);
}

.ct-item.on .ct-name {
  color: var(--brand);
}

.ct-desc {
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ct-root.inline .ct-item {
  padding: 9px 10px;
}

.ct-root.inline .ct-code {
  width: 176px;
  font-size: 11.5px;
}

.ct-root.inline .ct-desc {
  white-space: normal;
}
</style>
