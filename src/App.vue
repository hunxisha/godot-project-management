<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import TabBar from './components/TabBar.vue'
import Icon from './components/Icon.vue'
import Dashboard from './views/Dashboard.vue'
import ProjectsView from './views/ProjectsView.vue'
import VersionsView from './views/VersionsView.vue'
import MarketplaceView from './views/MarketplaceView.vue'
import AddonsView from './views/AddonsView.vue'
import BackupsView from './views/BackupsView.vue'
import SettingsView from './views/SettingsView.vue'
import { notify } from './services/bridge'
import type { DownloadTask } from './types/godot'

const tab = ref('dashboard')
/** addProject 功能(拖入)带入的文件路径 */
const enterPayload = ref<string[] | null>(null)
/** 概览页触发「新建项目」:切到项目页并自动打开新建弹窗 */
const pendingCreate = ref(false)
/** 项目页触发「管理插件」:切到已安装页并定位到该项目 */
const pendingAddonProject = ref<string | null>(null)
/** 项目页 → 备份页:切到备份页并只显示该项目的备份 */
const backupScope = ref<string | null>(null)
/** 备份页 → 项目页:切到项目页并直接打开该项目的备份弹窗 */
const backupRequest = ref<string | null>(null)

// ---------- 全局下载任务(常驻订阅,切页不断线) ----------

const tasks = ref<DownloadTask[]>([])
let unwatchTasks: (() => void) | null = null

const TASK_STATUS: Record<string, string> = {
  queued: '排队中',
  downloading: '下载中',
  extracting: '解压中',
  verifying: '校验中',
  done: '完成',
  error: '失败',
  canceled: '已取消'
}

/** 进行中 / 失败的任务 */
const activeTasks = computed(() =>
  tasks.value.filter((t) => t.status !== 'done' && t.status !== 'canceled')
)

function taskPercent(t: DownloadTask): number {
  if (!t.totalSize) return 0
  return Math.min(100, (t.received / t.totalSize) * 100)
}

function taskBrief(t: DownloadTask): string {
  const base = TASK_STATUS[t.status] || t.status
  return t.status === 'downloading' && t.totalSize ? `${base} ${taskPercent(t).toFixed(0)}%` : base
}

onMounted(() => {
  document.documentElement.dataset.theme = window.ztools.isDarkColors() ? 'dark' : 'light'
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
          notify(`${t.version?.name ?? t.tag} 安装完成`)
        }
        window.services.dismissTask(t.id)
      }
    })
  })
})

onBeforeUnmount(() => unwatchTasks && unwatchTasks())

function gotoCreate() {
  pendingCreate.value = true
  tab.value = 'projects'
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
    <TabBar v-model="tab" />
    <main class="content">
      <!-- 仅缓存市场页:切走再切回保留浏览状态(模式/标签/页码/数据),直到插件重启 -->
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
        />
        <VersionsView v-else-if="tab === 'versions'" />
        <MarketplaceView v-else-if="tab === 'marketplace'" @navigate="tab = $event" />
        <AddonsView
          v-else-if="tab === 'addons'"
          :enter-project-id="pendingAddonProject"
          @navigate="tab = $event"
          @consumed="pendingAddonProject = null"
        />
        <BackupsView
          v-else-if="tab === 'backups'"
          :enter-project-id="backupScope"
          @consumed="backupScope = null"
          @navigate="tab = $event"
          @backup-project="gotoCreateBackup"
        />
        <SettingsView v-else />
      </KeepAlive>
    </main>

    <!-- 全局任务栏:版本页有详细任务卡,其余页面显示紧凑进度条 -->
    <div v-if="tab !== 'versions' && activeTasks.length" class="taskbar">
      <span class="spin"></span>
      <template v-for="(t, i) in activeTasks.slice(0, 2)" :key="t.id">
        <span v-if="i > 0" class="tb-sep"></span>
        <span class="tb-item" :class="t.status">
          <span class="tb-name mono">{{ t.tag }}</span>
          <span class="tb-status">{{ taskBrief(t) }}</span>
        </span>
      </template>
      <span v-if="activeTasks.length > 2" class="tb-more">+{{ activeTasks.length - 2 }}</span>
      <span class="grow"></span>
      <button class="btn small ghost" @click="tab = 'versions'">
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
