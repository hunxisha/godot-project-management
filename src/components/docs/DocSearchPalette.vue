<!-- 全局文档搜索面板(Ctrl+K):任意标签页呼出,对当前文档库做本地搜索。
     命中项回传给 App → 切到「文档」页并打开对应类(带锚点定位)。 -->
<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import Icon from '../Icon.vue'
import { useDocs } from '../../composables/useDocs'
import type { DocSearchHit } from '../../types/godot'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'select', hit: { className: string, anchor?: string }): void
  (e: 'navigate-docs'): void
}>()

const { search, currentStatus, history, favorites } = useDocs()

const query = ref('')
const active = ref(0)
const inputEl = ref<HTMLInputElement | null>(null)
/** 含正文检索(懒加载整库正文,首次稍慢;开启后在名称结果后追加描述命中) */
const withBody = ref(false)

const KIND_LABEL: Record<string, string> = {
  class: '类',
  method: '方法',
  member: '成员',
  signal: '信号',
  enum: '枚举',
  constant: '常量',
  body: '正文'
}

// 搜索异步化后(阶段 A)不能再用 computed 同步派生,改为 watch + 竞态守卫:
// 只认最后一次输入的查询结果,防止快速输入时旧结果覆盖新结果
const results = ref<DocSearchHit[]>([])

watch([query, withBody], async () => {
  const q = query.value.trim()
  if (!q) {
    results.value = []
    return
  }
  const named = await search(q, 30)
  if (query.value.trim() !== q) return
  if (!withBody.value) {
    results.value = named
    return
  }
  // 正文命中追加在名称命中之后(名称命中永远是更精确的意图)
  const body = currentStatus.value?.versionId
    ? await window.services.docsSearchFullText(currentStatus.value.versionId, q, 15)
    : []
  if (query.value.trim() !== q) return
  const seen = new Set(named.map((h) => h.className))
  results.value = [...named, ...body.filter((h) => !seen.has(h.className))]
})

/** 空查询时给最近浏览/收藏作快速入口 */
const quickEntries = computed(() => {
  const hist = history.value.slice(0, 6).map((h) => ({ className: h.name }))
  const favs = favorites.value.filter((f) => !hist.some((h) => h.className === f)).slice(0, 4).map((f) => ({ className: f }))
  return [...favs, ...hist]
})

watch(() => props.open, (v) => {
  if (!v) return
  query.value = ''
  active.value = 0
  nextTick(() => inputEl.value?.focus())
})

watch(results, () => { active.value = 0 })

function move(delta: number) {
  const total = query.value.trim() ? results.value.length : quickEntries.value.length
  if (!total) return
  active.value = (active.value + delta + total) % total
}

function pickCurrent() {
  if (query.value.trim()) {
    const hit = results.value[active.value]
    if (hit) emit('select', { className: hit.className, anchor: hit.kind === 'class' ? undefined : `${hit.kind}-${hit.name}` })
  } else {
    const entry = quickEntries.value[active.value]
    if (entry) emit('select', { className: entry.className })
  }
  emit('close')
}

function pick(hit: { className: string, anchor?: string }) {
  emit('select', hit)
  emit('close')
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="overlay" @click.self="emit('close')">
      <div class="palette">
        <div class="input-row">
          <Icon name="search" :size="15" />
          <input
            ref="inputEl"
            v-model="query"
            class="palette-input"
            placeholder="搜索类 / 方法 / 成员 / 信号 / 常量…"
            spellcheck="false"
            @keydown.down.prevent="move(1)"
            @keydown.up.prevent="move(-1)"
            @keydown.enter.prevent="pickCurrent"
            @keydown.esc.prevent="emit('close')"
          >
          <span class="kbd-hint">Esc</span>
        </div>
        <label class="body-toggle" :title="'在描述正文中检索(首次会读入整库正文,稍慢)'">
          <input v-model="withBody" type="checkbox" class="switch">
          <span>含正文</span>
        </label>

        <div class="results">
          <template v-if="currentStatus?.status === 'ready'">
            <!-- 空查询:最近浏览 + 收藏快速入口 -->
            <template v-if="!query.trim()">
              <div class="group-label">快速进入</div>
              <button
                v-for="(entry, i) in quickEntries"
                :key="entry.className"
                class="hit"
                :class="{ active: i === active }"
                @mouseenter="active = i"
                @click="pick(entry)"
              >
                <span class="kind">类</span>
                <span class="hit-name mono">{{ entry.className }}</span>
              </button>
              <div v-if="!quickEntries.length" class="empty-hint">输入关键字搜索;浏览过的类会出现在这里。</div>
            </template>

            <!-- 有查询:按分值排序的平铺列表 -->
            <template v-else>
              <button
                v-for="(hit, i) in results"
                :key="`${hit.kind}-${hit.className}-${hit.name}`"
                class="hit"
                :class="{ active: i === active }"
                @mouseenter="active = i"
                @click="pick({ className: hit.className, anchor: hit.kind === 'class' ? undefined : `${hit.kind}-${hit.name}` })"
              >
                <span class="kind">{{ KIND_LABEL[hit.kind] || hit.kind }}</span>
                <span v-if="hit.kind === 'body'" class="hit-snippet">{{ hit.snippet }}</span>
                <span v-else class="hit-name mono">{{ hit.name }}</span>
                <span v-if="hit.kind !== 'class' && hit.kind !== 'body'" class="hit-cls mono">{{ hit.className }}</span>
                <span v-else-if="hit.kind === 'body'" class="hit-cls mono">{{ hit.className }}</span>
              </button>
              <div v-if="!results.length" class="empty-hint">没有匹配「{{ query }}」的结果。</div>
            </template>
          </template>

          <div v-else class="empty-hint">
            尚未生成文档库。先到 <a href="#" @click.prevent="emit('navigate-docs')">「文档」页</a> 从已装引擎生成。
          </div>
        </div>

        <div class="foot">
          <span>↑↓ 选择</span>
          <span>Enter 打开</span>
          <span class="grow"></span>
          <span class="lib-tag">{{ currentStatus?.tag ? `当前库 ${currentStatus.tag}` : '无文档库' }}</span>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  z-index: 90;
  background: rgba(15, 23, 42, 0.42);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 64px;
}

.palette {
  width: 580px;
  max-width: calc(100vw - 40px);
  max-height: 68vh;
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 14px;
  box-shadow: 0 18px 50px rgba(15, 23, 42, 0.3);
  overflow: hidden;
}

.input-row {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border);
  color: var(--text-3);
}

.palette-input {
  flex: 1;
  border: none;
  outline: none;
  background: none;
  color: var(--text);
  font-size: 14px;
}

.kbd-hint {
  font-size: 10.5px;
  color: var(--text-3);
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: 1px 6px;
}

.body-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border-bottom: 1px solid var(--border);
  background: var(--surface-2);
  font-size: 11.5px;
  color: var(--text-2);
  cursor: pointer;
}

.hit-snippet {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.results {
  flex: 1;
  overflow-y: auto;
  padding: 7px;
}

.group-label {
  padding: 6px 10px 4px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-3);
}

.hit {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 8px 10px;
  border: none;
  border-radius: 8px;
  background: none;
  cursor: pointer;
  text-align: left;
}

.hit.active {
  background: var(--surface-2);
}

.kind {
  flex-shrink: 0;
  font-size: 10.5px;
  font-weight: 600;
  color: var(--text-3);
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: 1px 6px;
  min-width: 34px;
  text-align: center;
}

.hit-name {
  font-size: 13px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hit-cls {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-3);
  flex-shrink: 0;
}

.empty-hint {
  padding: 22px 12px;
  text-align: center;
  font-size: 12.5px;
  color: var(--text-3);
}

.empty-hint a {
  color: var(--brand);
}

.foot {
  display: flex;
  gap: 12px;
  padding: 8px 14px;
  border-top: 1px solid var(--border);
  font-size: 11px;
  color: var(--text-3);
}

.lib-tag {
  color: var(--brand);
}

.mono {
  font-family: var(--font-mono, ui-monospace, monospace);
}
</style>
