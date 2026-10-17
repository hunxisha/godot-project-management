<!-- 全局命令面板(Ctrl+K):Workbench 2.0 统一入口。
     四类内容:快速命令(动作+导航)、最近项目、文档库搜索(原 DocSearchPalette 能力)。
     空查询展示命令与最近项目;输入后按「命令 → 项目 → 文档」顺序过滤。 -->
<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import Icon from '../components/Icon.vue'
import { useDocs } from '../composables/useDocs'
import { useTheme } from '../composables/useTheme'
import { openProjectAction } from '../composables/useProjectActions'
import { listDocs } from '../services/bridge'
import type { DocSearchHit, GodotProject } from '../types/godot'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'navigate', tab: string): void
  (e: 'create'): void
  (e: 'add'): void
  (e: 'select-doc', hit: { className: string, anchor?: string }): void
}>()

const { search, currentStatus, history, favorites } = useDocs()
const { resolvedMode, setMode } = useTheme()

const query = ref('')
const active = ref(0)
const inputEl = ref<HTMLInputElement | null>(null)
/** 含正文检索(懒加载整库正文,首次稍慢;开启后在名称结果后追加描述命中) */
const withBody = ref(false)

// ---------- 命令定义 ----------

interface Command {
  id: string
  label: string
  hint?: string
  icon: string
  group: '动作' | '导航'
  run: () => void
}

function nav(tab: string) {
  emit('navigate', tab)
  emit('close')
}

const commands = computed<Command[]>(() => [
  {
    id: 'create',
    label: '新建 Godot 项目',
    hint: '从零创建',
    icon: 'plus',
    group: '动作',
    run: () => {
      emit('create')
      emit('close')
    }
  },
  {
    id: 'add',
    label: '添加已有项目',
    hint: '选择目录导入',
    icon: 'folder-plus',
    group: '动作',
    run: () => {
      emit('add')
      emit('close')
    }
  },
  {
    id: 'theme',
    label: `切换为${resolvedMode.value === 'dark' ? '浅色' : '深色'}主题`,
    hint: '明暗一键切换',
    icon: resolvedMode.value === 'dark' ? 'sun' : 'moon',
    group: '动作',
    run: () => {
      setMode(resolvedMode.value === 'dark' ? 'light' : 'dark')
      emit('close')
    }
  },
  { id: 'nav-dashboard', label: '前往 概览', icon: 'grid', group: '导航', run: () => nav('dashboard') },
  { id: 'nav-projects', label: '前往 项目', icon: 'folder', group: '导航', run: () => nav('projects') },
  { id: 'nav-plugins', label: '前往 插件', icon: 'puzzle', group: '导航', run: () => nav('plugins') },
  { id: 'nav-versions', label: '前往 引擎', icon: 'package', group: '导航', run: () => nav('versions') },
  { id: 'nav-docs', label: '前往 文档', icon: 'book', group: '导航', run: () => nav('docs') },
  { id: 'nav-backups', label: '前往 备份', icon: 'archive', group: '导航', run: () => nav('backups') },
  { id: 'nav-settings', label: '前往 设置', icon: 'gear', group: '导航', run: () => nav('settings') }
])

// ---------- 最近项目 ----------

const recentProjects = ref<(GodotProject & { _id: string })[]>([])

async function loadRecent() {
  try {
    const docs = await listDocs<GodotProject & { _id: string }>('godot/project/')
    recentProjects.value = docs
      .sort((a, b) => (b.lastOpenedAt || b.addedAt) - (a.lastOpenedAt || a.addedAt))
      .slice(0, 6)
  } catch {
    recentProjects.value = []
  }
}

function openProject(p: GodotProject & { _id: string }) {
  openProjectAction(p)
  emit('close')
}

// ---------- 文档搜索(沿用原 DocSearchPalette 逻辑) ----------

const KIND_LABEL: Record<string, string> = {
  class: '类',
  method: '方法',
  member: '成员',
  signal: '信号',
  enum: '枚举',
  constant: '常量',
  body: '正文'
}

const docResults = ref<DocSearchHit[]>([])

watch([query, withBody], async () => {
  const q = query.value.trim()
  if (!q) {
    docResults.value = []
    return
  }
  const named = await search(q, 30)
  if (query.value.trim() !== q) return
  if (!withBody.value) {
    docResults.value = named
    return
  }
  const body = currentStatus.value?.versionId
    ? await window.services.docsSearchFullText(currentStatus.value.versionId, q, 15)
    : []
  if (query.value.trim() !== q) return
  const seen = new Set(named.map((h) => h.className))
  docResults.value = [...named, ...body.filter((h) => !seen.has(h.className))]
})

// ---------- 扁平化结果(键盘导航作用于完整序列) ----------

type Row =
  | { kind: 'label'; id: string; text: string }
  | { kind: 'command'; id: string; cmd: Command }
  | { kind: 'project'; id: string; project: GodotProject & { _id: string } }
  | { kind: 'doc'; id: string; hit: DocSearchHit }

const match = (text: string, q: string) => text.toLowerCase().includes(q.toLowerCase())

const rows = computed<Row[]>(() => {
  const q = query.value.trim()
  const out: Row[] = []

  const cmds = q
    ? commands.value.filter((c) => match(c.label, q) || (c.hint && match(c.hint, q)))
    : commands.value.filter((c) => c.group === '动作')
  if (cmds.length) {
    if (!q) out.push({ kind: 'label', id: 'l-cmd', text: '快速命令' })
    for (const c of cmds) out.push({ kind: 'command', id: c.id, cmd: c })
  }

  const projects = q
    ? recentProjects.value.filter((p) => match(p.name, q) || match(p.path, q))
    : recentProjects.value
  if (projects.length) {
    out.push({ kind: 'label', id: 'l-proj', text: q ? '项目' : '最近项目' })
    for (const p of projects) out.push({ kind: 'project', id: `p-${p._id}`, project: p })
  }

  if (q && docResults.value.length && currentStatus.value?.status === 'ready') {
    out.push({ kind: 'label', id: 'l-doc', text: '文档' })
    for (const h of docResults.value) out.push({ kind: 'doc', id: `d-${h.kind}-${h.className}-${h.name}`, hit: h })
  }

  return out
})

/** 键盘可聚焦的行(跳过分组标签) */
const focusable = computed(() => rows.value.filter((r) => r.kind !== 'label') as Array<Exclude<Row, { kind: 'label' }>>)

watch(rows, () => { active.value = 0 })

function move(delta: number) {
  const total = focusable.value.length
  if (!total) return
  active.value = (active.value + delta + total) % total
}

function pickCurrent() {
  const row = focusable.value[active.value]
  if (!row) return
  if (row.kind === 'command') row.cmd.run()
  else if (row.kind === 'project') openProject(row.project)
  else if (row.kind === 'doc') {
    emit('select-doc', { className: row.hit.className, anchor: row.hit.kind === 'class' ? undefined : `${row.hit.kind}-${row.hit.name}` })
    emit('close')
  }
}

watch(() => props.open, (v) => {
  if (!v) return
  query.value = ''
  active.value = 0
  loadRecent()
  nextTick(() => inputEl.value?.focus())
})

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && props.open) {
    e.preventDefault()
    emit('close')
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown))
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
            placeholder="输入命令、项目名,或搜索文档…"
            spellcheck="false"
            @keydown.down.prevent="move(1)"
            @keydown.up.prevent="move(-1)"
            @keydown.enter.prevent="pickCurrent"
            @keydown.esc.prevent="emit('close')"
          >
          <span class="kbd">Esc</span>
        </div>
        <label class="body-toggle" title="在描述正文中检索(首次会读入整库正文,稍慢)">
          <input v-model="withBody" type="checkbox" class="switch">
          <span>文档含正文</span>
        </label>

        <div class="results">
          <template v-for="(row, i) in rows">
            <div v-if="row.kind === 'label'" :key="row.id" class="group-label">{{ row.text }}</div>
            <button
              v-else-if="row.kind === 'command'"
              :key="row.id"
              class="row-item"
              :class="{ active: focusable[active] && focusable[active].id === row.cmd.id }"
              @mouseenter="active = focusable.findIndex((f) => f.id === row.cmd.id)"
              @click="row.cmd.run()"
            >
              <span class="row-icon"><Icon :name="row.cmd.icon" :size="14" /></span>
              <span class="row-name">{{ row.cmd.label }}</span>
              <span v-if="row.cmd.hint" class="row-hint">{{ row.cmd.hint }}</span>
              <span class="row-kind" :class="`k-${row.cmd.group === '动作' ? 'action' : 'nav'}`">{{ row.cmd.group }}</span>
            </button>
            <button
              v-else-if="row.kind === 'project'"
              :key="row.id"
              class="row-item"
              :class="{ active: focusable[active] && focusable[active].id === row.id }"
              @mouseenter="active = focusable.findIndex((f) => f.id === row.id)"
              @click="openProject(row.project)"
            >
              <span class="row-icon"><Icon name="folder" :size="14" /></span>
              <span class="row-name">{{ row.project.name }}</span>
              <span class="row-hint mono">{{ row.project.path }}</span>
              <span class="row-kind k-project">打开</span>
            </button>
            <button
              v-else
              :key="row.id"
              class="row-item"
              :class="{ active: focusable[active] && focusable[active].id === row.id }"
              @mouseenter="active = focusable.findIndex((f) => f.id === row.id)"
              @click="pickCurrent"
            >
              <span class="row-kind-flat">{{ KIND_LABEL[row.hit.kind] || row.hit.kind }}</span>
              <span v-if="row.hit.kind === 'body'" class="row-hint">{{ row.hit.snippet }}</span>
              <span v-else class="row-name mono">{{ row.hit.name }}</span>
              <span v-if="row.hit.kind !== 'class'" class="row-hint mono">{{ row.hit.className }}</span>
              <span class="grow"></span>
              <Icon name="book" :size="12" class="row-cta" />
            </button>
          </template>

          <div v-if="!rows.length" class="empty-hint">
            <template v-if="query.trim()">没有匹配「{{ query }}」的命令或项目。</template>
            <template v-else-if="currentStatus?.status !== 'ready'">
              尚未生成文档库;到「文档」页从已装引擎生成后,可在此直接搜索 API。
            </template>
          </div>
        </div>

        <div class="foot">
          <span class="f-hint"><span class="kbd">↑↓</span> 选择</span>
          <span class="f-hint"><span class="kbd">Enter</span> 执行</span>
          <span class="grow"></span>
          <span class="lib-tag">{{ currentStatus?.tag ? `文档库 ${currentStatus.tag}` : '无文档库' }}</span>
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
  background: rgba(10, 16, 26, 0.45);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 72px;
}

.palette {
  width: 600px;
  max-width: calc(100vw - 40px);
  max-height: 70vh;
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-overlay);
  overflow: hidden;
  animation: palette-in 0.16s ease;
}

@keyframes palette-in {
  from {
    opacity: 0;
    transform: translateY(-8px) scale(0.99);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

.input-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 13px 16px;
  border-bottom: 1px solid var(--border);
  color: var(--text-3);
}

.palette-input {
  flex: 1;
  border: none;
  outline: none;
  background: none;
  color: var(--text);
  font-size: 14.5px;
}

.body-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--surface-2);
  font-size: 11.5px;
  color: var(--text-2);
  cursor: pointer;
}

.body-toggle .switch {
  width: 28px;
  height: 16px;
}

.body-toggle .switch::after {
  width: 12px;
  height: 12px;
}

.body-toggle .switch:checked::after {
  left: 12px;
}

.results {
  flex: 1;
  overflow-y: auto;
  padding: 7px;
}

.group-label {
  padding: 7px 10px 4px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--text-3);
}

.row-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 7.5px 10px;
  border: none;
  border-radius: 8px;
  background: none;
  cursor: pointer;
  text-align: left;
  transition: background 0.1s;
}

.row-item.active {
  background: var(--brand-weak);
}

.row-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 6px;
  background: var(--surface-3);
  color: var(--text-2);
  flex-shrink: 0;
}

.row-item.active .row-icon {
  background: var(--brand);
  color: #fff;
}

.row-name {
  font-size: 13px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-hint {
  flex: 1;
  min-width: 0;
  font-size: 11.5px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-kind {
  flex-shrink: 0;
  font-size: 10.5px;
  font-weight: 600;
  color: var(--text-3);
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: 1px 7px;
  white-space: nowrap;
}

.row-kind.k-action {
  color: var(--brand);
  border-color: var(--brand);
  background: var(--brand-weak);
}

.row-kind.k-project {
  color: var(--ok);
  border-color: var(--ok);
  background: var(--ok-weak);
}

/* 文档行内联类型徽标 */
.row-kind-flat {
  flex-shrink: 0;
  min-width: 38px;
  text-align: center;
  font-size: 10.5px;
  font-weight: 600;
  color: var(--text-3);
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: 1px 6px;
}

.row-cta {
  color: var(--text-3);
  flex-shrink: 0;
}

.row-item.active .row-cta {
  color: var(--brand);
}

.mono {
  font-family: var(--mono);
}

.empty-hint {
  padding: 24px 12px;
  text-align: center;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--text-3);
}

.foot {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 8px 16px;
  border-top: 1px solid var(--border);
  font-size: 11px;
  color: var(--text-3);
}

.f-hint {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.lib-tag {
  color: var(--brand);
}
</style>
