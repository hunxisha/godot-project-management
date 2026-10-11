<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import TabBar from './components/TabBar.vue'
import Icon from './components/Icon.vue'
import Dashboard from './views/Dashboard.vue'
import ProjectsView from './views/ProjectsView.vue'
import VersionsView from './views/VersionsView.vue'
import MarketplaceView from './views/MarketplaceView.vue'
import AddonsView from './views/AddonsView.vue'
import DocsView from './views/DocsView.vue'
import DocSearchPalette from './components/docs/DocSearchPalette.vue'
import BackupsView from './views/BackupsView.vue'
import ToolsView from './views/ToolsView.vue'
import SettingsView from './views/SettingsView.vue'
import { notify } from './services/bridge'
import type { BackupTask, DocsTask, DownloadTask, ExportTask } from './types/godot'

const tab = ref('dashboard')
/** 插件页(市场+已安装合并为一个导航项)当前子页:切走再切回「插件」时回到上次位置 */
const pluginSubTab = ref<'marketplace' | 'addons'>('marketplace')
watch(tab, (v) => {
  if (v === 'marketplace' || v === 'addons') pluginSubTab.value = v
})
/** TabBar「插件」→ 上次的子页(默认市场);其余 key 直通 */
function onTabBar(v: string) {
  tab.value = v === 'plugins' ? pluginSubTab.value : v
}
/** addProject 功能(拖入)带入的文件路径 */
const enterPayload = ref<string[] | null>(null)
/** 概览页触发「新建项目」:切到项目页并自动打开新建弹窗 */
const pendingCreate = ref(false)
/** 项目页触发「管理插件」:切到已安装页并定位到该项目 */
const pendingAddonProject = ref<string | null>(null)
/** 项目页「从市场模板创建」→ 市场页:进入后自动切到模板模式 */
const pendingMarketMode = ref<string | null>(null)
/** 项目页 → 备份页:切到备份页并只显示该项目的备份 */
const backupScope = ref<string | null>(null)
/** 备份页 → 项目页:切到项目页并直接打开该项目的备份弹窗 */
const backupRequest = ref<string | null>(null)
/** 全局搜索(Ctrl+K)命中的跳转目标:切到文档页并打开对应类 */
const docTarget = ref<{ className: string, anchor?: string } | null>(null)
/** 文档搜索面板开关 */
const paletteOpen = ref(false)
/** 项目页 → 文档页:按项目绑定的引擎版本选库(docVersionId 为待切换的版本 id) */
const docVersionRequest = ref<string | null>(null)

// ---------- 全局任务(引擎/模板下载 + 备份/恢复 + 一键导出,常驻订阅,切页不断线) ----------

const tasks = ref<DownloadTask[]>([])
const backupTasks = ref<BackupTask[]>([])
const exportTasks = ref<ExportTask[]>([])
const docsTasks = ref<DocsTask[]>([])
let unwatchTasks: (() => void) | null = null
let unwatchBackupTasks: (() => void) | null = null
let unwatchExportTasks: (() => void) | null = null
let unwatchDocsTasks: (() => void) | null = null

const TASK_STATUS: Record<string, string> = {
  queued: '排队中',
  downloading: '下载中',
  extracting: '解压中',
  verifying: '校验中',
  done: '完成',
  error: '失败',
  canceled: '已取消'
}

const BACKUP_PHASE: Record<string, string> = {
  scanning: '扫描中',
  packing: '打包中',
  copying: '复制中',
  finalizing: '收尾中',
  unpacking: '解压中',
  replacing: '替换原目录',
  registering: '注册项目'
}

const BACKUP_TERMINAL: Record<string, true> = { done: true, error: true, canceled: true }

/** 任务栏条目:把两种来源的任务归一化后再渲染 */
interface BarTask {
  id: string
  label: string
  brief: string
  error: boolean
}

const barTasks = computed<BarTask[]>(() => {
  const out: BarTask[] = []
  for (const t of tasks.value) {
    if (t.status === 'done' || t.status === 'canceled') continue
    const base = TASK_STATUS[t.status] || t.status
    const pct = t.totalSize ? Math.min(100, (t.received / t.totalSize) * 100) : 0
    out.push({
      id: `dl-${t.id}`,
      label: t.tag,
      brief: t.status === 'downloading' && t.totalSize ? `${base} ${pct.toFixed(0)}%` : base,
      error: t.status === 'error'
    })
  }
  for (const t of backupTasks.value) {
    if (BACKUP_TERMINAL[t.phase]) continue
    const base = BACKUP_PHASE[t.phase] || t.phase
    const pct = t.total ? Math.min(100, (t.done / t.total) * 100) : 0
    out.push({
      id: `bk-${t.id}`,
      label: `${t.kind === 'restore' ? '恢复' : '备份'} · ${t.projectName}`,
      brief: t.total ? `${base} ${pct.toFixed(0)}%` : base,
      error: t.phase === 'error'
    })
  }
  for (const t of exportTasks.value) {
    if (t.status === 'done' || t.status === 'canceled') continue
    out.push({
      id: `exp-${t.id}`,
      label: `导出 · ${t.projectName}`,
      brief: t.status === 'exporting' ? (t.log.split('\n').pop() || '导出中') : '排队中',
      error: t.status === 'error'
    })
  }
  for (const t of docsTasks.value) {
    if (t.status === 'done' || t.status === 'canceled') continue
    const base = t.status === 'parsing' && t.total
      ? `解析 ${Math.min(100, Math.round((t.done / t.total) * 100))}%`
      : DOCS_PHASE[t.status] || t.status
    out.push({
      id: `docs-${t.id}`,
      label: `文档 · ${t.tag}`,
      brief: base,
      error: t.status === 'error'
    })
  }
  return out
})

const DOCS_PHASE: Record<string, string> = {
  queued: '排队中',
  dumping: '引擎导出中',
  translating: '翻译下载中',
  parsing: '解析中'
}

const hasBackupTask = computed(() => backupTasks.value.some((t) => !BACKUP_TERMINAL[t.phase]))

onMounted(() => {
  // 主题(色板 × 明暗)已在 main.ts 挂载前应用,见 composables/useTheme.ts
  window.ztools.setExpendHeight(600)
  window.ztools.onPluginEnter(({ code, payload }) => {
    if (code === 'projects') tab.value = 'projects'
    else if (code === 'versions') tab.value = 'versions'
    else if (code === 'plugins') tab.value = 'marketplace'
    else if (code === 'addProject') {
      tab.value = 'projects'
      enterPayload.value = payload as string[]
    } else tab.value = 'dashboard'
  })
  // 任务完成通知与清理由 App 常驻负责(不随页面切换丢失);
  // dismiss 放入微任务,避免在订阅回调内同步触发嵌套 emit 导致旧快照滞留
  const notified = new Set<string>()
  unwatchTasks = window.services.watchTasks((snap) => {
    tasks.value = snap
    const finished = snap.filter((t) => t.status === 'done' || t.status === 'canceled')
    if (!finished.length) return
    queueMicrotask(() => {
      for (const t of finished) {
        if (t.status === 'done' && !notified.has(t.id)) {
          notified.add(t.id)
          notify(t.kind === 'templates' ? `${t.tag} 导出模板安装完成` : `${t.version?.name ?? t.tag} 安装完成`)
        }
        window.services.dismissTask(t.id)
      }
    })
  })

  // 备份/恢复任务同样常驻订阅:备份可以跨页面继续,完成后统一通知
  const notifiedBackup = new Set<string>()
  unwatchBackupTasks = window.services.watchBackupTasks((snap) => {
    backupTasks.value = snap
    const finished = snap.filter((t) => BACKUP_TERMINAL[t.phase])
    if (!finished.length) return
    queueMicrotask(() => {
      for (const t of finished) {
        if (t.phase === 'done' && !notifiedBackup.has(t.id)) {
          notifiedBackup.add(t.id)
          notify(t.kind === 'restore'
            ? `「${t.projectName}」恢复完成`
            : `「${t.projectName}」备份完成`)
        }
        window.services.dismissBackupTask(t.id)
      }
    })
  })

  // 一键导出任务:进度条目显示在任务栏,完成/失败统一通知
  const notifiedExport = new Set<string>()
  unwatchExportTasks = window.services.watchExportTasks((snap) => {
    exportTasks.value = snap
    const finished = snap.filter((t) => t.status === 'done' || t.status === 'canceled' || t.status === 'error')
    if (!finished.length) return
    queueMicrotask(() => {
      for (const t of finished) {
        if (!notifiedExport.has(t.id)) {
          notifiedExport.add(t.id)
          if (t.status === 'done') notify(`「${t.projectName}」导出完成:${t.outputPath}`)
          else if (t.status === 'error') notify(`「${t.projectName}」导出失败:${t.error || '未知原因'}`)
        }
        window.services.dismissExportTask(t.id)
      }
    })
  })

  // 文档库生成任务:任务栏条目 + 完成通知(库内容刷新由 DocsView 自己订阅处理)
  const notifiedDocs = new Set<string>()
  unwatchDocsTasks = window.services.watchDocsTasks((snap) => {
    docsTasks.value = snap
    const finished = snap.filter((t) => t.status === 'done' || t.status === 'canceled' || t.status === 'error')
    if (!finished.length) return
    queueMicrotask(() => {
      for (const t of finished) {
        if (!notifiedDocs.has(t.id)) {
          notifiedDocs.add(t.id)
          if (t.status === 'done') notify(`${t.versionName} 文档库生成完成(${t.total} 类)`)
          else if (t.status === 'error') notify(`${t.versionName} 文档库生成失败:${t.error || '未知原因'}`)
        }
        window.services.dismissDocsTask(t.id)
      }
    })
  })

  // Ctrl+K / Cmd+K 呼出全局文档搜索
  const onKeydown = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault()
      paletteOpen.value = true
    }
  }
  window.addEventListener('keydown', onKeydown)
  keydownCleanup = () => window.removeEventListener('keydown', onKeydown)
})

let keydownCleanup: (() => void) | null = null

onBeforeUnmount(() => {
  if (unwatchTasks) unwatchTasks()
  if (unwatchBackupTasks) unwatchBackupTasks()
  if (unwatchExportTasks) unwatchExportTasks()
  if (unwatchDocsTasks) unwatchDocsTasks()
  if (keydownCleanup) keydownCleanup()
})

/** 文档搜索命中 → 切到文档页并打开对应类 */
function gotoDocTarget(hit: { className: string, anchor?: string }) {
  docTarget.value = hit
  tab.value = 'docs'
}

/** 项目卡片「查看文档」→ 文档页,并尝试切到该项目绑定的引擎版本 */
function gotoProjectDocs(projectId: string) {
  const project = window.ztools.db.get(projectId) as { versionId?: string } | null
  docVersionRequest.value = project?.versionId ?? null
  tab.value = 'docs'
}

function gotoCreate() {
  pendingCreate.value = true
  tab.value = 'projects'
}

/** 项目页「从市场模板创建」→ 市场页模板模式 */
function gotoMarketTemplates() {
  pendingMarketMode.value = 'projects'
  tab.value = 'marketplace'
}

function gotoAddons(id: string) {
  pendingAddonProject.value = id
  tab.value = 'addons'
}

/** 切到备份页(id 为空表示显示全部项目的备份) */
function gotoBackups(id?: string) {
  backupScope.value = id ?? null
  tab.value = 'backups'
}

/** 切到项目页并打开该项目的备份弹窗 */
function gotoCreateBackup(id: string) {
  backupRequest.value = id
  tab.value = 'projects'
}
</script>

<template>
  <div class="app">
    <TabBar :model-value="tab" @update:model-value="onTabBar" />
    <main class="content">
      <!-- 仅缓存市场页:切走再切回保留浏览状态(模式/标签/页码/数据),直到插件重启。
           工具页试过加进 include(字符串与数组两种写法、并给组件补 defineOptions name),
           实测不生效:dev-mock 里切页回来后 .rail 与 .pick select 的元素身份都是新的,
           而 select 的 value 前后一致(排除了「误触发 change 把结论清空」);同一次实验里
           市场页的元素身份是保留的。根因未定(§D #12)。
           工具箱重做第 0 批补一句:这条「实测不生效」的结论**仍然有效**,第 1 批的新工具箱
           状态照样走模块级单例(useToolkitShared),不要再试 include。
           旧的 useToolsShared 连同它的体检状态已在第 0 批拆掉,本页现在是空壳。 -->
      <KeepAlive include="MarketplaceView">
        <Dashboard v-if="tab === 'dashboard'" @navigate="tab = $event" @create="gotoCreate" />
        <ProjectsView
          v-else-if="tab === 'projects'"
          :enter-payload="enterPayload"
          :auto-create="pendingCreate"
          :auto-backup="backupRequest"
          @consumed="enterPayload = null"
          @create-done="pendingCreate = false"
          @backup-consumed="backupRequest = null"
          @manage-addons="gotoAddons"
          @open-backups="gotoBackups"
          @backup-project="gotoCreateBackup"
          @template-market="gotoMarketTemplates"
          @open-docs="gotoProjectDocs"
        />
        <VersionsView v-else-if="tab === 'versions'" />
        <MarketplaceView
          v-else-if="tab === 'marketplace'"
          :enter-mode="pendingMarketMode"
          @navigate="tab = $event"
          @consumed="pendingMarketMode = null"
        />
        <AddonsView
          v-else-if="tab === 'addons'"
          :enter-project-id="pendingAddonProject"
          @navigate="tab = $event"
          @consumed="pendingAddonProject = null"
        />
        <DocsView
          v-else-if="tab === 'docs'"
          :pending-target="docTarget"
          :pending-version-id="docVersionRequest"
          @consumed="docTarget = null"
          @version-consumed="docVersionRequest = null"
        />
        <BackupsView
          v-else-if="tab === 'backups'"
          :enter-project-id="backupScope"
          @consumed="backupScope = null"
          @navigate="tab = $event"
          @backup-project="gotoCreateBackup"
        />
        <!-- 工具页:第 0 批的空壳(旧的体检控制台已拆,理由与去向见 docs/toolkit-redesign-plan.md)。
             空壳不 emit navigate,所以这里不再绑 @navigate。 -->
        <ToolsView v-else-if="tab === 'tools'" />
        <SettingsView v-else />
      </KeepAlive>
    </main>

    <!-- 全局文档搜索(Ctrl+K) -->
    <DocSearchPalette
      :open="paletteOpen"
      @close="paletteOpen = false"
      @select="gotoDocTarget"
      @navigate-docs="paletteOpen = false; tab = 'docs'"
    />

    <!-- 全局任务栏:版本页有详细任务卡,其余页面显示紧凑进度条 -->
    <div v-if="tab !== 'versions' && barTasks.length" class="taskbar">
      <span class="spin"></span>
      <template v-for="(t, i) in barTasks.slice(0, 2)" :key="t.id">
        <span v-if="i > 0" class="tb-sep"></span>
        <span class="tb-item" :class="{ error: t.error }">
          <span class="tb-name mono">{{ t.label }}</span>
          <span class="tb-status">{{ t.brief }}</span>
        </span>
      </template>
      <span v-if="barTasks.length > 2" class="tb-more">+{{ barTasks.length - 2 }}</span>
      <span class="grow"></span>
      <button v-if="hasBackupTask" class="btn small ghost" @click="tab = 'backups'">
        备份任务 <Icon name="chevron-right" :size="11" />
      </button>
      <button v-else class="btn small ghost" @click="tab = 'versions'">
        引擎任务 <Icon name="chevron-right" :size="11" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.content {
  flex: 1;
  overflow-y: auto;
}

.grow {
  flex: 1;
}

/* ---------- 全局任务栏 ---------- */
.taskbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 16px;
  background: var(--surface);
  border-top: 1px solid var(--border);
  box-shadow: 0 -4px 14px rgba(23, 37, 56, 0.06);
  flex-shrink: 0;
  animation: taskbar-in 0.2s ease-out;
}

@keyframes taskbar-in {
  from {
    transform: translateY(6px);
    opacity: 0;
  }
  to {
    transform: none;
    opacity: 1;
  }
}

.tb-item {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}

.tb-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tb-status {
  font-size: 12px;
  font-weight: 600;
  color: var(--brand);
  white-space: nowrap;
}

.tb-item.error .tb-status {
  color: var(--danger);
}

.tb-sep {
  width: 1px;
  height: 14px;
  background: var(--border);
  flex-shrink: 0;
}

.tb-more {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-3);
}
</style>
