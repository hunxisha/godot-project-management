<!-- 完整继承树弹层:空间充裕,可搜索类名并跳转;树本体复用 DocTreePanel。 -->
<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import Icon from '../Icon.vue'
import DocTreePanel from './DocTreePanel.vue'
import { useDocs } from '../../composables/useDocs'

const props = defineProps<{
  open: boolean
  /** 打开时聚焦的类 */
  currentClass: string
}>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'navigate', name: string): void
}>()

const { classes, classes: all } = useDocs()

const query = ref('')
const inputEl = ref<HTMLInputElement | null>(null)
/** 搜索命中的类(用于快速跳转列表) */
const matches = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return []
  return classes.value.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 12)
})

watch(() => props.open, (open) => {
  if (!open) return
  query.value = ''
  nextTick(() => inputEl.value?.focus())
})

/** 统计信息:库内类总数与当前类的直接派生数 */
const stats = computed(() => {
  const cur = all.value.find((c) => c.name === props.currentClass)
  const derived = all.value.filter((c) => c.inherits === props.currentClass).length
  return { total: all.value.length, inherits: cur?.inherits ?? null, derived }
})

function goto(name: string) {
  emit('navigate', name)
  emit('close')
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="overlay" @click.self="emit('close')">
      <div class="dialog">
        <div class="head">
          <Icon name="layers" :size="15" />
          <span class="title">继承树 · <span class="mono">{{ currentClass }}</span></span>
          <span class="grow"></span>
          <button class="x" title="关闭" @click="emit('close')"><Icon name="x" :size="14" /></button>
        </div>

        <div class="meta">
          <span>继承自 <b class="mono">{{ stats.inherits || '无(根类)' }}</b></span>
          <span class="dot">·</span>
          <span>直接派生 <b class="mono">{{ stats.derived }}</b></span>
          <span class="dot">·</span>
          <span>库内共 <b class="mono">{{ stats.total }}</b> 个类</span>
          <span class="grow"></span>
        </div>

        <div class="search-row">
          <Icon name="search" :size="13" />
          <input ref="inputEl" v-model="query" class="search" placeholder="搜索类名并跳转…" spellcheck="false">
        </div>
        <div v-if="matches.length" class="matches">
          <button v-for="m in matches" :key="m.name" class="match" @click="goto(m.name)">
            <span class="mono">{{ m.name }}</span>
            <span v-if="m.inherits" class="match-parent mono">← {{ m.inherits }}</span>
          </button>
        </div>

        <div class="tree-scroll">
          <DocTreePanel :current-class="currentClass" roomy @navigate="(n) => goto(n)" />
        </div>

        <div class="foot">
          <span class="foot-hint">点击类名跳转;箭头展开/折叠;路径上的祖先自动展开</span>
          <span class="grow"></span>
          <button class="btn small" @click="emit('close')">关闭</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  z-index: 95;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
}

.dialog {
  width: 620px;
  max-width: calc(100vw - 40px);
  max-height: 84vh;
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 14px;
  box-shadow: var(--shadow-lift);
  overflow: hidden;
}

.head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 11px 14px;
  border-bottom: 1px solid var(--border);
  color: var(--text);
}

.title {
  font-size: 13.5px;
  font-weight: 700;
}

.grow {
  flex: 1;
}

.x {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--surface);
  color: var(--text-3);
  cursor: pointer;
}

.meta {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  padding: 8px 14px;
  background: var(--surface-2);
  border-bottom: 1px solid var(--border);
  font-size: 11.5px;
  color: var(--text-2);
}

.meta b {
  color: var(--brand);
}

.dot {
  color: var(--text-3);
}

.search-row {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 10px 14px 6px;
  padding: 6px 9px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-2);
  color: var(--text-3);
}

.search {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: none;
  color: var(--text);
  font-size: 12.5px;
}

.matches {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  padding: 0 14px 6px;
}

.match {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  font-size: 11.5px;
  color: var(--text-2);
  cursor: pointer;
}

.match:hover {
  color: var(--brand);
  border-color: color-mix(in srgb, var(--brand) 35%, transparent);
}

.match-parent {
  font-size: 10px;
  color: var(--text-3);
}

.tree-scroll {
  flex: 1;
  overflow: auto;
  padding: 4px 14px;
}

.foot {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 14px;
  border-top: 1px solid var(--border);
}

.foot-hint {
  font-size: 11px;
  color: var(--text-3);
}

.mono {
  font-family: var(--mono);
}
</style>
