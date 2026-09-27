<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { getSettings, isWindows, notify, pickDirectory, putDoc } from '../services/bridge'
import EmptyState from '../components/EmptyState.vue'
import Icon from '../components/Icon.vue'
import BackupCreateDialog from '../components/dialogs/BackupCreateDialog.vue'
import ExportDialog from '../components/dialogs/ExportDialog.vue'
import { openProjectAction } from '../composables/useProjectActions'
import { useProjectList, type ProjectRow } from '../composables/useProjectList'
import { useProjectCreate } from '../composables/useProjectCreate'
import { useProjectDelete } from '../composables/useProjectDelete'
import { gradOf } from '../utils/avatar'
import { versionMismatch } from '../utils/godotVersion'
import { formatRelative, fmtSize } from '../utils/format'
import type { BackupRecord, OpenAction } from '../types/godot'

type Row = ProjectRow

const props = defineProps<{
  enterPayload?: string[] | null
  autoCreate?: boolean
  /** 从备份页「立即备份」跳入:直接打开该项目的备份弹窗 */
  autoBackup?: string | null
}>()
const emit = defineEmits<{
  (e: 'consumed'): void
  (e: 'create-done'): void
  (e: 'backup-consumed'): void
  (e: 'manage-addons', id: string): void
  /** 跳转备份管理页(id 为空表示显示全部) */
  (e: 'open-backups', id?: string): void
  /** 跳到市场模板模式(新建对话框的「从市场模板创建」入口) */
  (e: 'template-market'): void
  /** 打开该项目的引擎版本文档库(未绑定/未生成时切到文档页引导) */
  (e: 'open-docs', id: string): void
}>()

const settings = getSettings()
const isWin = isWindows()

const ACTION_LABEL: Record<OpenAction, string> = { editor: '打开', run: '运行', folder: '目录' }
const ACTION_ICON: Record<OpenAction, string> = { editor: 'pencil', run: 'play', folder: 'folder' }

// ---------- 列表 / 新建 / 删除 ----------
// 三块各自独立成组合式函数;本视图只做装配与页面级联动(拖拽、键盘、跨页跳转)。

const {
  projects,
  versions,
  filter,
  selected,
  favOnly,
  visible,
  favCount,
  reload,
  toggleFavorite,
  bindVersion,
  dropLocal
} = useProjectList()

const {
  showCreate,
  creating,
  cName,
  cParent,
  cRenderer,
  cVersionId,
  cOpen,
  nameInput,
  cPreview,
  openCreate,
  chooseParent,
  submitCreate
} = useProjectCreate({
  projects,
  versions,
  defaultVersionId: settings.defaultVersionId,
  notify,
  reload,
  openProject: (row) => openProject(row)
})

const {
  showDelete,
  deleteTarget,
  delFiles,
  deleting,
  askDelete,
  confirmDelete
} = useProjectDelete({
  projects,
  policy: settings.deleteProjectFiles,
  notify,
  dropLocal
})

/** 绑定的引擎版本与 project.godot 声明不一致(判定逻辑在 utils/godotVersion) */
const mismatch = (p: Row) => versionMismatch(p, versions.value)

onMounted(() => {
  reload()
  refreshLastBackups()
  window.ztools.setSubInput(({ text }) => {
    filter.value = text
    selected.value = -1
  }, '过滤项目')
  window.addEventListener('keydown', onKeyDown)
  // 概览页「新建项目」联动:进入本页时自动打开新建弹窗
  if (props.autoCreate) {
    openCreate()
    emit('create-done')
  }
  // 备份页「立即备份」联动:进入本页时自动打开该项目的备份弹窗
  if (props.autoBackup) openBackupFor(props.autoBackup)
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

watch(
  () => props.autoBackup,
  (id) => {
    if (id) openBackupFor(id)
  }
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

// ---------- 新建项目 ----------
// 表单状态与提交在 useProjectCreate 里(上面已装配)。

// ---------- 项目备份(创建在项目页,查看与管理在备份页) ----------

/** 各项目最近一次备份记录(projectId → record),用于行内摘要 */
const lastBackups = ref<Record<string, BackupRecord>>({})

/** 备份创建对话框 */
const showBackupCreate = ref(false)
const backupCreateTarget = ref('')

function refreshLastBackups() {
  lastBackups.value = window.services.listLatestBackups()
}

/** 打开备份创建对话框(行内按钮与跨页跳转共用) */
function openBackupCreate(id: string) {
  backupCreateTarget.value = id
  showBackupCreate.value = true
}

/** 从备份页「立即备份」跳转过来:直接打开该项目的备份对话框,并消费这次请求 */
function openBackupFor(id: string) {
  openBackupCreate(id)
  emit('backup-consumed')
}

function openProject(p: Row, action?: OpenAction) {
  openProjectAction(p, action)
}

// ---------- 导出 / 启动参数 / 缓存清理 ----------
// 三个轻量对话框:导出(预设选择 + 任务进度)、启动参数(单行编辑)、缓存(大小 + 清理)。

const showExport = ref(false)
const exportTarget = ref<Row | null>(null)

function openExport(p: Row) {
  exportTarget.value = p
  showExport.value = true
}

const showArgs = ref(false)
const argsTarget = ref<Row | null>(null)
const argsDraft = ref('')

function openArgs(p: Row) {
  argsTarget.value = p
  argsDraft.value = p.launchArgs || ''
  showArgs.value = true
}

function saveArgs() {
  const p = argsTarget.value
  if (!p) return
  const { _id, launchArgs, ...fields } = p
  const ok = putDoc(_id, { ...fields, launchArgs: argsDraft.value.trim() })
  if (ok) {
    notify('启动参数已保存,下次打开/运行时生效')
    showArgs.value = false
    reload()
  } else {
    notify('保存失败')
  }
}

const showCache = ref(false)
const cacheTarget = ref<Row | null>(null)
const cacheLoading = ref(false)
const cacheExists = ref(false)
const cacheSize = ref(0)
const cleaning = ref(false)

function openCache(p: Row) {
  cacheTarget.value = p
  showCache.value = true
  cacheLoading.value = true
  try {
    const r = window.services.getProjectCacheInfo(p._id)
    cacheExists.value = !!r.exists
    cacheSize.value = r.size || 0
  } finally {
    cacheLoading.value = false
  }
}

function cleanCache() {
  const p = cacheTarget.value
  if (!p || cleaning.value) return
  cleaning.value = true
  try {
    const r = window.services.cleanProjectCache(p._id)
    if (r.ok) {
      notify(`已清理 ${fmtSize(r.freed || 0)} 缓存(下次打开编辑器时自动重建)`)
      showCache.value = false
    } else {
      notify(r.error || '清理失败')
    }
  } finally {
    cleaning.value = false
  }
}

// ---------- 键盘导航(插件页获得焦点时生效) ----------

function onKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    if (showCreate.value) {
      showCreate.value = false
      return
    }
    if (showDelete.value) {
      showDelete.value = false
      return
    }
    if (showExport.value) {
      showExport.value = false
      return
    }
    if (showArgs.value) {
      showArgs.value = false
      return
    }
    if (showCache.value) {
      showCache.value = false
      return
    }
    selected.value = -1
    return
  }
  // 备份对话框自行处理 Escape;这里只阻止列表键盘导航
  if (showCreate.value || showDelete.value || showBackupCreate.value || showExport.value || showArgs.value || showCache.value) return
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
  <div class="projects view">
    <div class="view-head">
      <h2><Icon name="folder" :size="16" /> 项目 <span class="count-pill">{{ projects.length }}</span></h2>
      <div class="seg head-seg">
        <button :class="{ on: !favOnly }" @click="favOnly = false">全部</button>
        <button :class="{ on: favOnly }" :disabled="!favCount" title="只看收藏的项目" @click="favOnly = true">
          <Icon name="star" :size="11" :stroke-width="favOnly ? 2.4 : 1.7" /> 收藏 {{ favCount }}
        </button>
      </div>
      <span class="grow"></span>
      <button class="btn small ghost" title="集中管理所有项目的备份" @click="emit('open-backups')">
        <Icon name="archive" :size="13" /> 备份管理
      </button>
      <button class="btn small ghost" @click="openCreate"><Icon name="plus" :size="13" /> 新建项目</button>
      <button class="btn small primary" @click="addManually"><Icon name="folder-plus" :size="13" /> 添加项目</button>
    </div>

    <EmptyState
      v-if="!projects.length"
      icon="folder"
      title="还没有 Godot 项目"
      desc="从零新建一个项目,或将已有项目文件夹拖入 ZTools 主输入框、点击「添加项目」选择目录(支持子目录扫描)。"
    >
      <button class="btn primary" @click="openCreate"><Icon name="plus" :size="14" /> 新建项目</button>
      <button class="btn" @click="addManually"><Icon name="folder-plus" :size="14" /> 添加项目</button>
    </EmptyState>

    <template v-else>
      <EmptyState
        v-if="!visible.length"
        icon="search"
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
          <div class="avatar" :class="`g-${gradOf(p.name)}`">
            {{ p.name.charAt(0).toUpperCase() }}
            <span v-if="p.favorite" class="pin"><Icon name="star" :size="9" :stroke-width="2.4" /></span>
          </div>
          <div class="row-main">
            <div class="row-name">
              <span class="name">{{ p.name }}</span>
              <span v-if="p.engineVersion" class="tag" :title="`项目要求引擎 ${p.engineVersion}`">{{ p.engineVersion }}</span>
              <span v-if="mismatch(p)" class="tag warn" title="绑定版本与项目引擎要求不一致"><Icon name="alert" :size="10" /> 版本不匹配</span>
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
              <span class="opened"><Icon name="clock" :size="11" /> {{ formatRelative(p.lastOpenedAt, '从未打开') }}</span>
              <button
                v-if="lastBackups[p._id]"
                class="opened link-opened"
                :title="`最近备份:${lastBackups[p._id].destPath}(${lastBackups[p._id].mode === 'zip' ? 'zip 打包' : '完整快照'}) · 点击查看全部备份`"
                @click="emit('open-backups', p._id)"
              ><Icon name="archive" :size="11" /> 备份于 {{ formatRelative(lastBackups[p._id].createdAt) }}</button>
            </div>
          </div>
          <div class="row-actions">
            <button class="btn small primary" @click="openProject(p)">
              <Icon :name="ACTION_ICON[settings.defaultOpenAction]" :size="13" />
              {{ ACTION_LABEL[settings.defaultOpenAction] }}
            </button>
            <button
              v-for="act in (['editor', 'run', 'folder'] as OpenAction[]).filter((a) => a !== settings.defaultOpenAction)"
              :key="act"
              class="btn small ghost icon-act"
              :title="act === 'editor' ? '在编辑器中打开' : act === 'run' ? '直接运行项目' : '打开项目目录'"
              @click="openProject(p, act)"
            >
              <Icon :name="ACTION_ICON[act]" :size="13" />
            </button>
            <span class="act-sep"></span>
            <button
              class="btn small ghost icon-act"
              title="一键导出(headless)"
              @click="openExport(p)"
            >
              <Icon name="upload" :size="13" />
            </button>
            <button
              class="btn small ghost icon-act"
              title="管理该项目的插件"
              @click="emit('manage-addons', p._id)"
            >
              <Icon name="puzzle" :size="13" />
            </button>
            <button
              class="btn small ghost icon-act"
              title="为该项目创建备份"
              @click="openBackupCreate(p._id)"
            >
              <Icon name="archive" :size="13" />
            </button>
            <button
              class="btn small ghost icon-act"
              title="编辑自定义启动参数"
              @click="openArgs(p)"
            >
              <Icon name="zap" :size="13" />
            </button>
            <button
              class="btn small ghost icon-act"
              title="查看该项目的引擎文档(离线类参考)"
              @click="emit('open-docs', p._id)"
            >
              <Icon name="book" :size="13" />
            </button>
            <button
              class="btn small ghost icon-act"
              title="查看并清理 .godot 编辑器缓存"
              @click="openCache(p)"
            >
              <Icon name="hard-drive" :size="13" />
            </button>
            <button class="btn small ghost star" :class="{ on: p.favorite }" title="收藏" @click="toggleFavorite(p)">
              <Icon name="star" :size="13" :stroke-width="p.favorite ? 2.4 : 1.7" />
            </button>
            <button class="btn small danger-text" @click="askDelete(p)">删除</button>
          </div>
        </div>
      </div>
    </template>

    <!-- 新建项目模态框 -->
    <Teleport to="body">
      <div v-if="showCreate" class="modal-mask" @click.self="showCreate = false">
        <form class="card modal" @submit.prevent="submitCreate">
          <div class="modal-head">
            <div class="modal-title"><Icon name="pen" :size="15" /> 新建 Godot 项目</div>
            <span class="grow"></span>
            <button type="button" class="btn small ghost icon-x" title="关闭" @click="showCreate = false">
              <Icon name="x" :size="14" />
            </button>
          </div>

          <div class="field">
            <label class="f-label" for="np-name">项目名称</label>
            <input
              id="np-name"
              ref="nameInput"
              v-model="cName"
              class="input"
              placeholder="例如:My Awesome Game"
              maxlength="60"
              autocomplete="off"
              spellcheck="false"
            />
          </div>

          <div class="field">
            <label class="f-label" for="np-parent">创建位置</label>
            <div class="dir-row">
              <input
                id="np-parent"
                v-model="cParent"
                class="input mono"
                placeholder="选择新项目的保存位置"
                autocomplete="off"
                spellcheck="false"
              />
              <button type="button" class="btn ghost" @click="chooseParent">
                <Icon name="folder" :size="14" /> 浏览
              </button>
            </div>
            <div v-if="cPreview" class="f-hint mono" :title="cPreview">将创建于:{{ cPreview }}</div>
          </div>

          <div class="field">
            <label class="f-label" for="np-ver">引擎版本</label>
            <select id="np-ver" v-model="cVersionId" class="select" :disabled="!versions.length">
              <option value="" disabled>
                {{ versions.length ? '选择引擎版本' : '尚未安装引擎(将写入通用配置)' }}
              </option>
              <option v-for="v in versions" :key="v._id" :value="v._id">
                {{ v.variant === 'mono' ? `${v.name} (C#)` : v.name }}
              </option>
            </select>
          </div>

          <div class="field">
            <span class="f-label">渲染器</span>
            <div class="seg">
              <button
                v-for="r in (['forward_plus', 'mobile', 'gl_compatibility'] as const)"
                :key="r"
                type="button"
                :class="{ on: cRenderer === r }"
                @click="cRenderer = r"
              >
                {{ r === 'forward_plus' ? 'Forward+' : r === 'mobile' ? 'Mobile' : '兼容 GL' }}
              </button>
            </div>
          </div>

          <label class="open-row">
            <input v-model="cOpen" class="switch" type="checkbox" />
            <span>创建后立即打开编辑器</span>
          </label>

          <div class="modal-foot">
            <button type="button" class="btn ghost" title="从市场的完整项目模板创建项目" @click="emit('template-market')">
              <Icon name="package" :size="13" /> 从市场模板创建…
            </button>
            <span class="grow"></span>
            <button type="button" class="btn ghost" @click="showCreate = false">取消</button>
            <button type="submit" class="btn primary" :disabled="!cName.trim() || !cParent.trim() || creating">
              <Icon name="check" :size="13" /> 创建项目
            </button>
          </div>
        </form>
      </div>
    </Teleport>

    <!-- 删除项目确认模态框 -->
    <Teleport to="body">
      <div v-if="showDelete" class="modal-mask" @click.self="showDelete = false">
        <div class="card modal">
          <div class="modal-head">
            <div class="modal-title"><Icon name="trash" :size="15" /> 删除项目</div>
            <span class="grow"></span>
            <button type="button" class="btn small ghost icon-x" title="关闭" @click="showDelete = false">
              <Icon name="x" :size="14" />
            </button>
          </div>

          <p class="del-text">确定要从列表中移除「{{ deleteTarget?.name }}」吗?</p>
          <div class="del-path mono" :title="deleteTarget?.path">{{ deleteTarget?.path }}</div>

          <label v-if="settings.deleteProjectFiles !== 'never'" class="open-row del-check">
            <input v-model="delFiles" type="checkbox" class="chk" />
            <span>同时删除项目文件夹{{ isWin ? '(移入回收站,可恢复)' : '(将永久删除,不可恢复)' }}</span>
          </label>
          <div class="del-hint">
            {{ settings.deleteProjectFiles === 'never'
              ? '已按全局设置仅移除记录,项目文件不受影响。'
              : '不勾选则仅移除列表记录,项目文件不受影响;删除行为可在「设置」中全局配置。' }}
          </div>

          <div class="modal-foot">
            <span class="grow"></span>
            <button type="button" class="btn ghost" @click="showDelete = false">取消</button>
            <button type="button" class="btn del-confirm" :disabled="deleting" @click="confirmDelete">
              <span v-if="deleting" class="spin"></span>
              {{ deleting ? '删除中…' : '删除' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <BackupCreateDialog
      :open="showBackupCreate"
      :project-id="backupCreateTarget"
      :projects="projects"
      @close="showBackupCreate = false"
      @done="refreshLastBackups"
    />

    <!-- 一键导出对话框 -->
    <ExportDialog :open="showExport" :project="exportTarget" @close="showExport = false" />

    <!-- 启动参数对话框 -->
    <Teleport to="body">
      <div v-if="showArgs" class="modal-mask" @click.self="showArgs = false">
        <div class="card modal">
          <div class="modal-head">
            <div class="modal-title"><Icon name="zap" :size="15" /> 启动参数 · {{ argsTarget?.name }}</div>
            <span class="grow"></span>
            <button type="button" class="btn small ghost icon-x" title="关闭" @click="showArgs = false">
              <Icon name="x" :size="14" />
            </button>
          </div>

          <div class="field">
            <label class="f-label" for="la-args">自定义命令行参数</label>
            <input
              id="la-args"
              v-model="argsDraft"
              class="input mono"
              placeholder="例如:--resolution 1280x720 --debug"
              autocomplete="off"
              spellcheck="false"
              @keyup.enter="saveArgs"
            />
            <div class="f-hint">追加在 <code>godot --path 项目 --打开方式</code> 之后;双引号内的空格视为同一参数。</div>
          </div>

          <div class="modal-foot">
            <span class="grow"></span>
            <button type="button" class="btn ghost" @click="showArgs = false">取消</button>
            <button type="button" class="btn primary" @click="saveArgs"><Icon name="check" :size="13" /> 保存</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 缓存清理对话框 -->
    <Teleport to="body">
      <div v-if="showCache" class="modal-mask" @click.self="showCache = false">
        <div class="card modal">
          <div class="modal-head">
            <div class="modal-title"><Icon name="hard-drive" :size="15" /> 编辑器缓存 · {{ cacheTarget?.name }}</div>
            <span class="grow"></span>
            <button type="button" class="btn small ghost icon-x" title="关闭" @click="showCache = false">
              <Icon name="x" :size="14" />
            </button>
          </div>

          <p class="del-text">
            {{ cacheLoading ? '统计中…' : cacheExists ? `.godot 缓存占用 ${fmtSize(cacheSize)}` : '该项目还没有 .godot 缓存' }}
          </p>
          <div class="del-hint">
            导入资源卡住、图标丢失时清缓存是常见的自救手段;清理后下次打开编辑器会自动重建,
            请先关闭正在运行的编辑器实例。
          </div>

          <div class="modal-foot">
            <span class="grow"></span>
            <button type="button" class="btn ghost" @click="showCache = false">关闭</button>
            <button type="button" class="btn del-confirm" :disabled="!cacheExists || cleaning" @click="cleanCache">
              <span v-if="cleaning" class="spin"></span>
              {{ cleaning ? '清理中…' : '清理缓存' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.grow {
  flex: 1;
}

.head-seg {
  margin-left: 10px;
}

.list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.row-item {
  display: flex;
  align-items: center;
  gap: 13px;
  padding: 11px 14px;
  transition: border-color 0.15s, box-shadow 0.15s;
}

.row-item:hover {
  border-color: var(--border-strong);
  box-shadow: var(--shadow);
}

.row-item.selected {
  border-color: var(--brand);
  background: var(--brand-weak);
}

.avatar {
  position: relative;
  width: 36px;
  height: 36px;
  border-radius: var(--radius-sm);
  color: #fff;
  font-weight: 700;
  font-size: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.avatar.g-a { background: var(--grad-a); }
.avatar.g-b { background: var(--grad-b); }
.avatar.g-c { background: var(--grad-c); }
.avatar.g-d { background: var(--grad-d); }

/* 收藏角标 */
.pin {
  position: absolute;
  right: -4px;
  bottom: -4px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--gold);
  color: #fff;
  border: 1.5px solid var(--surface);
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
  font-size: 13.5px;
}

.row-path {
  font-size: 11.5px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 3px;
}

.ver-select {
  max-width: 220px;
  padding: 1px 6px;
  font-size: 12px;
  border-radius: 6px;
  box-shadow: none;
}

.opened {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-3);
}

/* 「备份于 X 前」可点击跳转备份管理 */
.link-opened {
  border: none;
  background: transparent;
  padding: 0;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: color 0.15s;
}

.link-opened:hover {
  color: var(--brand);
  text-decoration: underline;
}

.row-actions {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
}

.icon-act {
  width: 28px;
  padding: 3px 0;
  color: var(--text-2);
}

.icon-act:hover {
  color: var(--brand);
}

.act-sep {
  width: 1px;
  height: 18px;
  background: var(--border);
  margin: 0 3px;
}

.star {
  width: 28px;
  padding: 3px 0;
  color: var(--text-3);
}

.star.on {
  color: var(--gold);
}

/* ---------- 删除项目模态框 ---------- */

.del-text {
  margin: 2px 0 6px;
  font-size: 13.5px;
  color: var(--text);
}

.del-path {
  padding: 6px 10px;
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  border: 1px solid var(--border);
  font-size: 12px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.del-check {
  margin-top: 12px;
}

.chk {
  width: 15px;
  height: 15px;
  accent-color: var(--brand);
  cursor: pointer;
  flex-shrink: 0;
}

.del-hint {
  margin-top: 6px;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--text-3);
}

/* 红色确认按钮(hover 保持红底白字) */
.btn.del-confirm {
  background: var(--danger);
  border-color: transparent;
  color: #fff;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.15), var(--shadow-sm);
}

.btn.del-confirm:hover:not(:disabled) {
  filter: brightness(1.07);
  background: var(--danger);
  border-color: transparent;
  color: #fff;
}
</style>
