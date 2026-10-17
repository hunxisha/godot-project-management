<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AppSidebar from './components/AppSidebar.vue'
import StatusBar from './components/StatusBar.vue'
import CommandPalette from './components/CommandPalette.vue'
import Dashboard from './views/Dashboard.vue'
import ProjectsView from './views/ProjectsView.vue'
import VersionsView from './views/VersionsView.vue'
import MarketplaceView from './views/MarketplaceView.vue'
import AddonsView from './views/AddonsView.vue'
import DocsView from './views/DocsView.vue'
import BackupsView from './views/BackupsView.vue'
import SettingsView from './views/SettingsView.vue'

const tab = ref('dashboard')
/** 插件页(市场+已安装合并为一个导航项)当前子页:切走再切回「插件」时回到上次位置 */
const pluginSubTab = ref<'marketplace' | 'addons'>('marketplace')
watch(tab, (v) => {
  if (v === 'marketplace' || v === 'addons') pluginSubTab.value = v
})
/** 侧边栏/命令面板「插件」→ 上次的子页(默认市场);其余 key 直通 */
function gotoTab(v: string) {
  tab.value = v === 'plugins' ? pluginSubTab.value : v
}
/** addProject 功能(拖入)带入的文件路径 */
const enterPayload = ref<string[] | null>(null)
/** 概览页/命令面板触发「新建项目」:切到项目页并自动打开新建弹窗 */
const pendingCreate = ref(false)
/** 命令面板「添加已有项目」:切到项目页并自动弹出目录选择 */
const pendingAdd = ref(false)
/** 项目页触发「管理插件」:切到已安装页并定位到该项目 */
const pendingAddonProject = ref<string | null>(null)
/** 项目页「从市场模板创建」→ 市场页:进入后自动切到模板模式 */
const pendingMarketMode = ref<string | null>(null)
/** 项目页 → 备份页:切到备份页并只显示该项目的备份 */
const backupScope = ref<string | null>(null)
/** 备份页 → 项目页:切到项目页并直接打开该项目的备份弹窗 */
const backupRequest = ref<string | null>(null)
/** 命令面板命中的跳转目标:切到文档页并打开对应类 */
const docTarget = ref<{ className: string, anchor?: string } | null>(null)
/** 全局命令面板(Ctrl+K)开关 */
const paletteOpen = ref(false)
/** 项目页 → 文档页:按项目绑定的引擎版本选库(docVersionId 为待切换的版本 id) */
const docVersionRequest = ref<string | null>(null)

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

  // Ctrl+K / Cmd+K 呼出全局命令面板
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
  if (keydownCleanup) keydownCleanup()
})

/** 命令面板「新建项目」 */
function commandCreate() {
  pendingCreate.value = true
  tab.value = 'projects'
}

/** 命令面板「添加项目」:切到项目页并自动弹出目录选择 */
function commandAdd() {
  pendingAdd.value = true
  tab.value = 'projects'
}

/** 命令面板文档命中 → 切到文档页并打开对应类 */
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
    <AppSidebar :model-value="tab" @update:model-value="gotoTab" @command="paletteOpen = true" />
    <div class="main">
      <main class="content">
        <!-- 仅缓存市场页:切走再切回保留浏览状态(模式/标签/页码/数据),直到插件重启。
             其余页实测 include 不生效(根因未定),状态走模块级单例,不要再试。 -->
        <KeepAlive include="MarketplaceView">
          <Dashboard v-if="tab === 'dashboard'" @navigate="tab = $event" @create="commandCreate" />
          <ProjectsView
            v-else-if="tab === 'projects'"
            :enter-payload="enterPayload"
            :auto-create="pendingCreate"
            :auto-add="pendingAdd"
            :auto-backup="backupRequest"
            @consumed="enterPayload = null"
            @create-done="pendingCreate = false"
            @add-done="pendingAdd = false"
            @backup-consumed="backupRequest = null"
            @manage-addons="(id) => { pendingAddonProject = id; tab = 'addons' }"
            @open-backups="gotoBackups"
            @backup-project="gotoCreateBackup"
            @template-market="() => { pendingMarketMode = 'projects'; tab = 'marketplace' }"
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
          <SettingsView v-else />
        </KeepAlive>
      </main>
      <StatusBar @navigate="tab = $event" @command="paletteOpen = true" />
    </div>

    <!-- 全局命令面板(Ctrl+K):命令 / 最近项目 / 文档搜索 -->
    <CommandPalette
      :open="paletteOpen"
      @close="paletteOpen = false"
      @navigate="gotoTab"
      @create="commandCreate"
      @add="commandAdd"
      @select-doc="gotoDocTarget"
    />
  </div>
</template>

<style scoped>
.app {
  display: flex;
  height: 100%;
}

.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  height: 100%;
}

.content {
  flex: 1;
  overflow-y: auto;
}
</style>
