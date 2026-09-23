<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { getSettings, notify, pickDirectory, putDoc } from '../services/bridge'
import EmptyState from '../components/EmptyState.vue'
import { openProjectAction } from '../composables/useProjectActions'
import type { GodotProject, GodotVersion, OpenAction } from '../types/godot'

type Row = GodotProject & { _id: string }

const props = defineProps<{ enterPayload?: string[] | null }>()
const emit = defineEmits<{ (e: 'consumed'): void }>()

const settings = getSettings()
const projects = ref<Row[]>([])
const versions = ref<(GodotVersion & { _id: string })[]>([])
const filter = ref('')
const confirmingId = ref<string | null>(null)
const selected = ref(-1)

const ACTION_LABEL: Record<OpenAction, string> = { editor: '打开', run: '运行', folder: '目录' }

const visible = computed<Row[]>(() => {
  const kw = filter.value.trim().toLowerCase()
  const list = projects.value.filter((p) => !kw || p.name.toLowerCase().includes(kw) || p.path.toLowerCase().includes(kw))
  return [...list].sort((a, b) => {
    if (!!a.favorite !== !!b.favorite) return a.favorite ? -1 : 1
    if ((b.lastOpenedAt || 0) !== (a.lastOpenedAt || 0)) return (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0)
    return a.name.localeCompare(b.name)
  })
})

function reload() {
  projects.value = window.ztools.db.allDocs('godot/project/') as any[]
  versions.value = window.ztools.db.allDocs('godot/version/') as any[]
}

onMounted(() => {
  reload()
  window.ztools.setSubInput(({ text }) => {
    filter.value = text
    selected.value = -1
  }, '过滤项目')
  window.addEventListener('keydown', onKeyDown)
})

onBeforeUnmount(() => {
  window.ztools.removeSubInput()
  window.removeEventListener('keydown', onKeyDown)
})

// ---------- 拖拽 / 添加 ----------

watch(
  () => props.enterPayload,
  (paths) => {
    if (!paths || !paths.length) return
    addFromPaths(paths)
    emit('consumed')
  },
  { immediate: true }
)

function addFromPaths(paths: string[]) {
  const names: string[] = []
  for (const p of paths) {
    const r = window.services.addProject(p)
    if (r.ok && r.project) {
      names.push(r.project.name + (r.exists ? '(已存在,已更新)' : ''))
    } else {
      notify(r.error || '添加失败')
    }
  }
  reload()
  if (names.length) notify(`已添加项目:${names.join('、')}`)
}

function addManually() {
  const dir = pickDirectory('选择项目目录')
  if (!dir) return
  const r = window.services.addProject(dir)
  if (r.ok) {
    reload()
    notify(`已添加项目:${r.project?.name}${r.exists ? '(已存在,已更新)' : ''}`)
    return
  }
  if (r.error === '未找到 project.godot') {
    const found = window.services.scanProjects(dir)
    if (!found.length) {
      notify('该目录下未找到 Godot 项目')
      return
    }
    let added = 0
    for (const f of found) {
      const fr = window.services.addProject(f)
      if (fr.ok) added++
    }
    reload()
    notify(`扫描到 ${found.length} 个项目,已添加 ${added} 个`)
  } else {
    notify(r.error || '添加失败')
  }
}

// ---------- 项目操作 ----------

function removeProject(p: Row) {
  if (confirmingId.value === p._id) {
    confirmingId.value = null
    window.services.removeProject(p._id)
    projects.value = projects.value.filter((x) => x._id !== p._id)
  } else {
    confirmingId.value = p._id
    setTimeout(() => {
      if (confirmingId.value === p._id) confirmingId.value = null
    }, 2500)
  }
}

function toggleFavorite(p: Row) {
  p.favorite = !p.favorite
  const { _id, ...data } = p
  putDoc(_id, data)
}

function bindVersion(p: Row, versionId: string) {
  p.versionId = versionId || undefined
  const { _id, ...data } = p
  putDoc(_id, data)
}

function openProject(p: Row, action?: OpenAction) {
  openProjectAction(p, action)
}

// ---------- 展示辅助 ----------

function mismatch(p: Row): boolean {
  if (!p.engineVersion || !p.versionId) return false
  const v = versions.value.find((x) => x._id === p.versionId)
  if (!v) return false
  const minor = p.engineVersion.split('.').slice(0, 2).join('.')
  return !v.tag.startsWith(minor + '.') && !v.tag.startsWith(minor + '-')
}

function formatLastOpened(ts?: number): string {
  if (!ts) return '从未打开'
  const diff = Date.now() - ts
  if (diff < 60 * 1000) return '刚刚'
  if (diff < 3600 * 1000) return `${Math.floor(diff / 60000)} 分钟前`
  if (diff < 24 * 3600 * 1000) return `${Math.floor(diff / 3600000)} 小时前`
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// ---------- 键盘导航(插件页获得焦点时生效) ----------

function onKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    selected.value = -1
    return
  }
  if (!['ArrowDown', 'ArrowUp', 'Enter'].includes(e.key)) return
  const tag = (e.target as HTMLElement)?.tagName
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    selected.value = Math.min(visible.value.length - 1, selected.value + 1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    selected.value = Math.max(0, selected.value - 1)
  } else if (e.key === 'Enter' && selected.value >= 0 && visible.value[selected.value]) {
    e.preventDefault()
    openProject(visible.value[selected.value])
  }
}
</script>

<template>
  <div class="projects">
    <div class="section-head">
      <h2>项目 <span class="count">{{ projects.length }}</span></h2>
      <span class="grow"></span>
      <button class="btn small primary" @click="addManually">添加项目</button>
    </div>

    <EmptyState
      v-if="!projects.length"
      title="还没有 Godot 项目"
      desc="将项目文件夹拖入 ZTools 主输入框选择「添加Godot项目」,或点击「添加项目」选择目录(支持子目录扫描)。"
    >
      <button class="btn primary" @click="addManually">添加项目</button>
    </EmptyState>

    <template v-else>
      <EmptyState
        v-if="!visible.length"
        title="没有匹配的项目"
        :desc="`没有名称或路径包含「${filter}」的项目`"
      />
      <div v-else class="list">
        <div
          v-for="(p, i) in visible"
          :key="p._id"
          class="card row-item"
          :class="{ selected: i === selected }"
        >
          <div class="avatar" :class="{ fav: p.favorite }">{{ p.name.charAt(0).toUpperCase() }}</div>
          <div class="row-main">
            <div class="row-name">
              <span class="name">{{ p.name }}</span>
              <span v-if="p.engineVersion" class="tag" :title="`项目要求引擎 ${p.engineVersion}`">{{ p.engineVersion }}</span>
              <span v-if="mismatch(p)" class="tag warn" title="绑定版本与项目引擎要求不一致">版本不匹配</span>
            </div>
            <div class="row-path mono" :title="p.path">{{ p.path }}</div>
            <div class="row-meta">
              <select
                class="select ver-select"
                :value="p.versionId || ''"
                title="绑定的引擎版本"
                @change="bindVersion(p, ($event.target as HTMLSelectElement).value)"
              >
                <option value="" disabled>{{ versions.length ? '选择引擎版本' : '尚未安装引擎' }}</option>
                <option v-for="v in versions" :key="v._id" :value="v._id">
                  {{ v.variant === 'mono' ? `${v.name} (C#)` : v.name }}
                </option>
              </select>
              <span class="opened">{{ formatLastOpened(p.lastOpenedAt) }}</span>
            </div>
          </div>
          <div class="row-actions">
            <button class="btn small primary" @click="openProject(p)">
              {{ ACTION_LABEL[settings.defaultOpenAction] }}
            </button>
            <button
              v-if="settings.defaultOpenAction !== 'editor'"
              class="btn small"
              title="在编辑器中打开"
              @click="openProject(p, 'editor')"
            >编辑</button>
            <button
              v-if="settings.defaultOpenAction !== 'run'"
              class="btn small"
              title="直接运行项目"
              @click="openProject(p, 'run')"
            >运行</button>
            <button
              v-if="settings.defaultOpenAction !== 'folder'"
              class="btn small"
              title="打开项目目录"
              @click="openProject(p, 'folder')"
            >目录</button>
            <button class="btn small star" :class="{ on: p.favorite }" title="收藏" @click="toggleFavorite(p)">★</button>
            <button class="btn small danger-text" @click="removeProject(p)">
              {{ confirmingId === p._id ? '确认?' : '删除' }}
            </button>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.projects {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px;
}

.grow {
  flex: 1;
}

.section-head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.section-head h2 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.count {
  color: var(--text-3);
  font-weight: 400;
  font-size: 13px;
}

.list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.row-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
}

.row-item.selected {
  border-color: var(--brand);
}

.avatar {
  width: 34px;
  height: 34px;
  border-radius: var(--radius-sm);
  background: var(--brand-weak);
  color: var(--brand);
  font-weight: 700;
  font-size: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.avatar.fav {
  background: var(--warn-weak);
  color: var(--warn);
}

.row-main {
  flex: 1;
  min-width: 0;
}

.row-name {
  display: flex;
  align-items: center;
  gap: 6px;
}

.name {
  font-weight: 600;
}

.row-path {
  font-size: 12px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 2px;
}

.ver-select {
  max-width: 220px;
  padding: 1px 6px;
  font-size: 12px;
}

.opened {
  font-size: 12px;
  color: var(--text-3);
}

.row-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.star {
  color: var(--text-3);
}

.star.on {
  color: var(--warn);
}
</style>
