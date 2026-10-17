<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { getSettings, notify, pickDirectory, pickFile, isWindows, saveSettings, showInFolder, openPath } from '../services/bridge'
import EmptyState from '../components/EmptyState.vue'
import Icon from '../components/Icon.vue'
import { useExportTemplates } from '../composables/useExportTemplates'
import TemplateBuildWizard from '../components/versions/TemplateBuildWizard.vue'
import { DEFAULT_SETTINGS, type DownloadTask, type GodotRelease, type GodotSettings, type GodotVersion, type ReleaseAsset, type Variant } from '../types/godot'
import type { TemplatePack } from '../types/services'

// 设置异步读取(阶段 A):先给默认值,onMounted 后用持久化值覆盖
const settings = reactive<GodotSettings>({ ...DEFAULT_SETTINGS })
getSettings().then((s) => Object.assign(settings, s)).catch(() => {})
const platform = window.services.currentPlatform()

const installed = ref<(GodotVersion & { _id: string })[]>([])
const tasks = ref<DownloadTask[]>([])
const releases = ref<GodotRelease[]>([])
const releasesLoading = ref(false)
const releasesError = ref('')
const stableOnly = ref(true)
const variant = ref<Variant>('standard')
const majorFilter = ref('all')
const importing = ref(false)
const confirmingId = ref<string | null>(null)
let unwatchTasks: (() => void) | null = null

onMounted(async () => {
  installed.value = ((await window.ztools.db.allDocs('godot/version/')) || []) as any[]
})

// ---------- 下载任务 ----------

onMounted(() => {
  unwatchTasks = window.services.watchTasks((snap) => {
    tasks.value = snap
    // 完成通知与任务清理由 App.vue 全局订阅负责,这里只负责展示与本地列表合并
    for (const t of snap) {
      if (t.status === 'done' && t.version && !installed.value.some((v) => v._id === t.version!.id)) {
        installed.value.unshift({ ...t.version, _id: t.version.id })
      }
    }
    // 导出模板任务进入终态后刷新各引擎的模板状态
    if (snap.some((t) => t.kind === 'templates' && ['done', 'error', 'canceled'].includes(t.status))) {
      refreshTplStatuses()
    }
  })
  loadReleases(false)
  refreshTplStatuses()
})

onBeforeUnmount(() => unwatchTasks && unwatchTasks())

// ---------- 版本列表 ----------

async function loadReleases(force: boolean) {
  releasesLoading.value = true
  releasesError.value = ''
  try {
    releases.value = await window.services.fetchReleases(force)
  } catch (e: any) {
    releasesError.value = e?.message || String(e)
  } finally {
    releasesLoading.value = false
  }
}

/** 从 tag 提取大版本(major.minor),如 4.7.1-stable / 4.8-beta1 → 4.7 / 4.8 */
function majorOf(tag: string): string {
  const m = tag.match(/^v?(\d+\.\d+)/)
  return m ? m[1] : ''
}

/** 列表中出现的所有大版本,按新到旧排序 */
const majorOptions = computed(() => {
  const set = new Map<string, number>()
  for (const r of releases.value) {
    const m = majorOf(r.tag)
    if (!m) continue
    const [a, b] = m.split('.').map(Number)
    set.set(m, a * 1000 + b)
  }
  return [...set.entries()].sort((x, y) => y[1] - x[1]).map(([k]) => k)
})

const visibleReleases = computed(() =>
  releases.value.filter((r) => {
    if (stableOnly.value && r.prerelease) return false
    if (majorFilter.value !== 'all' && majorOf(r.tag) !== majorFilter.value) return false
    return true
  })
)

function assetFor(release: GodotRelease): ReleaseAsset | undefined {
  return release.assets.find((a) => (variant.value === 'mono') === a.name.toLowerCase().includes('mono'))
}

function isInstalled(release: GodotRelease): boolean {
  return installed.value.some((v) => v.tag === release.tag && v.variant === variant.value)
}

function isDownloading(release: GodotRelease): boolean {
  return !!taskFor(release)
}

/** 该版本对应的活动下载任务(含排队/下载/解压/校验;不含导出模板任务) */
function taskFor(release: GodotRelease): DownloadTask | undefined {
  return tasks.value.find(
    (t) =>
      t.kind !== 'templates' &&
      t.tag === release.tag &&
      t.variant === variant.value &&
      t.status !== 'error' &&
      t.status !== 'canceled' &&
      t.status !== 'done'
  )
}

/** 进度文案:totalSize 已知显示百分比,未知显示"下载中" */
function progressText(t: DownloadTask): string {
  return t.totalSize ? `${progressOf(t).toFixed(0)}%` : '下载中'
}

// ---------- 下载 ----------

async function ensureRoot(): Promise<string | null> {
  if (settings.versionsRoot) return settings.versionsRoot
  const dir = await pickDirectory('选择 Godot 引擎安装目录')
  if (!dir) return null
  saveSettings({ versionsRoot: dir }).catch(() => {})
  settings.versionsRoot = dir
  return dir
}

async function download(release: GodotRelease) {
  const asset = assetFor(release)
  if (!asset) return
  const root = await ensureRoot()
  if (!root) return
  window.services.downloadAndInstall(
    {
      tag: release.tag,
      variant: variant.value,
      platform,
      url: asset.url,
      fallbackUrl: asset.fallbackUrl,
      fileName: asset.name,
      totalSize: asset.size
    },
    { versionsRoot: root }
  )
}

function cancelTask(t: DownloadTask) {
  window.services.cancelTask(t.id)
}

function dismissTask(t: DownloadTask) {
  window.services.dismissTask(t.id)
}

function retryTask(t: DownloadTask) {
  window.services.dismissTask(t.id)
  if (t.kind === 'templates') {
    if (t.versionId) window.services.installExportTemplates(t.versionId)
    return
  }
  window.services.downloadAndInstall(
    {
      tag: t.tag,
      variant: t.variant,
      platform: t.platform,
      url: t.url,
      fallbackUrl: t.fallbackUrl,
      fileName: t.fileName,
      totalSize: t.totalSize
    },
    { versionsRoot: settings.versionsRoot! }
  )
}

// ---------- 导入 / 删除 / 默认 ----------

async function importLocal() {
  const exe = await pickFile('选择 Godot 可执行文件', isWindows() ? ['exe'] : ['*'])
  if (!exe) return
  importing.value = true
  const r = await window.services.importLocalExe(exe)
  importing.value = false
  if (r.ok && r.version) {
    const idx = installed.value.findIndex((v) => v._id === r.version!.id)
    const item = { ...r.version, _id: r.version.id }
    if (idx >= 0) installed.value[idx] = item
    else installed.value.unshift(item)
    notify(`已导入 ${r.version.name}`)
  } else {
    notify(r.error || '导入失败')
  }
}

function setDefault(v: GodotVersion & { _id: string }) {
  saveSettings({ defaultVersionId: v._id }).catch(() => {})
  settings.defaultVersionId = v._id
}

async function askDelete(v: GodotVersion & { _id: string }) {
  if (confirmingId.value === v._id) {
    confirmingId.value = null
    const r = await window.services.deleteVersion({ id: v._id, installDir: v.installDir, managed: v.managed })
    if (r.ok) {
      installed.value = installed.value.filter((x) => x._id !== v._id)
      if (settings.defaultVersionId === v._id) {
        saveSettings({ defaultVersionId: undefined })
        settings.defaultVersionId = undefined
      }
    } else {
      notify(r.error || '删除失败')
    }
  } else {
    confirmingId.value = v._id
    setTimeout(() => {
      if (confirmingId.value === v._id) confirmingId.value = null
    }, 2500)
  }
}

// ---------- 导出模板(状态与操作在 useExportTemplates 里,本视图只装配) ----------

const {
  tplStatuses,
  confirmingTplId,
  localImport,
  tplTaskFor,
  refreshTplStatuses,
  installTemplates,
  startLocalImport,
  confirmLocalImport,
  cancelLocalImport,
  askUninstallTemplates
} = useExportTemplates({ installed, tasks, notify })

// ---------- 模板库(docs/tpllib-plan.md):列存档 / 切换 / 删除 / 收编,判据全在宿主 tpllib.js ----------
const libFor = ref('')
const libPacks = ref<TemplatePack[]>([])
const libBusy = ref(false)
const libErr = ref('')
const confirmingPackId = ref('')

async function reloadLib(versionId: string) {
  const r = await window.services.listTemplatePacks(versionId)
  libPacks.value = r.ok ? r.packs : []
  libErr.value = r.ok ? '' : r.error || '模板库读取失败'
}

async function toggleLib(v: { _id: string }) {
  if (libFor.value === v._id) {
    libFor.value = ''
    return
  }
  libFor.value = v._id
  libErr.value = ''
  confirmingPackId.value = ''
  await reloadLib(v._id)
}

async function actActivate(v: { _id: string }, p: TemplatePack) {
  if (libBusy.value) return
  libBusy.value = true
  libErr.value = ''
  try {
    const r = await window.services.activateTemplatePack(v._id, p.packId)
    if (!r.ok) {
      libErr.value = r.error || '切换失败'
      return
    }
    notify(r.moved === false ? '该存档本就在生效位' : '已切换生效模板,重启编辑器后生效')
    await reloadLib(v._id)
    void refreshTplStatuses()
  } finally {
    libBusy.value = false
  }
}

async function actDelete(v: { _id: string }, p: TemplatePack) {
  if (confirmingPackId.value !== p.packId) {
    confirmingPackId.value = p.packId
    setTimeout(() => {
      if (confirmingPackId.value === p.packId) confirmingPackId.value = ''
    }, 2500)
    return
  }
  confirmingPackId.value = ''
  const r = await window.services.deleteTemplatePack(v._id, p.packId)
  if (!r.ok) {
    libErr.value = r.error || '删除失败'
    return
  }
  await reloadLib(v._id)
}

async function actAdopt(v: { _id: string }) {
  libErr.value = ''
  const r = await window.services.adoptTemplatePack(v._id)
  if (!r.ok) {
    libErr.value = r.error || '收编失败'
    return
  }
  await reloadLib(v._id)
}

// ---------- 自编译模板向导(检测/构建/导入的判据都在宿主侧,这里只装配) ----------
const tplWizardFor = ref('')

// ---------- 展示 ----------

function formatSize(n?: number): string {
  if (!n) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function formatSpeed(n: number): string {
  return n ? `${formatSize(n)}/s` : ''
}

function formatDate(ts?: number | string): string {
  if (!ts) return ''
  const d = typeof ts === 'string' ? new Date(ts) : new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const statusText: Record<string, string> = {
  queued: '排队中',
  downloading: '下载中',
  extracting: '解压中',
  verifying: '校验中',
  done: '完成',
  error: '失败',
  canceled: '已取消'
}

function progressOf(t: DownloadTask): number {
  if (!t.totalSize) return 0
  return Math.min(100, (t.received / t.totalSize) * 100)
}

// ---------- 纯 UI:头部「已安装 / 官方下载」分区切换,不承载业务逻辑 ----------
const tab = ref<'installed' | 'market'>('installed')
</script>

<template>
  <div class="versions view">
    <!-- 页头:标题 + 分区切换 + 动作 -->
    <div class="view-head">
      <h2><Icon name="package" :size="17" /> 引擎 <span class="count-pill">{{ installed.length }}</span></h2>
      <div class="seg head-seg">
        <button :class="{ on: tab === 'installed' }" @click="tab = 'installed'">已安装</button>
        <button :class="{ on: tab === 'market' }" @click="tab = 'market'">官方下载</button>
      </div>
      <span class="grow"></span>
      <button
        class="btn small ghost"
        :disabled="importing"
        title="选择本地已有的 Godot 可执行文件登记为引擎(不复制文件)"
        @click="importLocal"
      >
        <span v-if="importing" class="spin"></span>
        <Icon v-else name="upload" :size="13" />
        {{ importing ? '导入中…' : '导入本地引擎' }}
      </button>
      <button
        class="btn small"
        :disabled="releasesLoading"
        title="重新拉取官方版本列表(强制刷新缓存)"
        @click="loadReleases(true)"
      >
        <span v-if="releasesLoading" class="spin"></span>
        <Icon v-else name="refresh" :size="13" />
        刷新官方列表
      </button>
    </div>

    <!-- 下载任务:页内详细视图(底部状态栏任务中心之外的完整进度) -->
    <div v-if="tasks.length" class="panel">
      <div class="panel-head">
        <span class="panel-title"><Icon name="terminal" :size="13" /> 下载任务</span>
        <span class="grow"></span>
        <span class="root-note">底部状态栏的任务中心同步显示进度</span>
      </div>
      <div v-for="t in tasks" :key="t.id" class="task-row">
        <div class="t-head">
          <span class="t-name mono">{{ t.tag }}</span>
          <span class="tag mono">{{ t.variant === 'mono' ? 'C#' : '标准' }}</span>
          <span v-if="t.kind === 'templates'" class="tag brand">导出模板</span>
          <span class="grow"></span>
          <span class="t-status" :class="t.status">
            <span v-if="['queued', 'downloading', 'extracting', 'verifying'].includes(t.status)" class="spin"></span>
            {{ statusText[t.status] }}
          </span>
          <button
            v-if="t.status !== 'error' && t.status !== 'canceled' && t.status !== 'done'"
            class="btn small danger-text"
            @click="cancelTask(t)"
          >取消</button>
        </div>
        <div v-if="t.status === 'downloading'" class="t-bar">
          <div class="bar" :class="{ indet: !t.totalSize }"><div class="fill active" :style="{ width: progressOf(t) + '%' }"></div></div>
          <span class="t-meta">{{ progressText(t) }} · {{ formatSize(t.received) }}{{ t.totalSize ? '/' + formatSize(t.totalSize) : '' }} · {{ formatSpeed(t.speed) }}</span>
        </div>
        <div v-else-if="t.status === 'error'" class="t-err">
          <Icon name="alert" :size="13" />
          <span class="grow">{{ t.error }}</span>
          <button class="btn small" @click="retryTask(t)">重试</button>
          <button class="btn small ghost" @click="dismissTask(t)">关闭</button>
        </div>
        <div v-else-if="t.status !== 'done'" class="t-meta plain">{{ statusText[t.status] }}…</div>
      </div>
    </div>

    <!-- 已安装 -->
    <template v-if="tab === 'installed'">
      <div v-if="installed.length" class="panel">
        <div class="panel-head">
          <span class="panel-title"><Icon name="gear" :size="13" /> 已安装引擎</span>
          <span class="grow"></span>
          <span
            v-if="settings.versionsRoot"
            class="root-note mono"
            :title="`引擎安装根目录:${settings.versionsRoot}`"
          ><Icon name="hard-drive" :size="12" /> {{ settings.versionsRoot }}</span>
        </div>
        <div v-for="v in installed" :key="v._id" class="ver-item">
          <div class="row">
            <div class="v-ico" :class="{ default: settings.defaultVersionId === v._id }">
              <Icon name="gear" :size="18" />
              <span v-if="settings.defaultVersionId === v._id" class="pin"><Icon name="star" :size="9" :stroke-width="2.4" /></span>
            </div>
            <div class="row-main">
              <div class="row-name">
                <span class="name mono">{{ v.name }}</span>
                <span class="tag mono">{{ v.variant === 'mono' ? 'C#' : '标准' }}</span>
                <span v-if="settings.defaultVersionId === v._id" class="tag brand">默认</span>
                <span v-if="!v.managed" class="tag" title="本地导入登记的引擎,删除仅移除记录">导入</span>
                <span v-if="v.verified === false" class="tag warn" title="--version 校验未通过,可能无法正常启动">未通过校验</span>
                <span
                  v-if="tplStatuses[v._id]?.installed"
                  class="tag ok"
                  :title="`导出模板已就绪:${tplStatuses[v._id]?.path}`"
                >模板已装</span>
              </div>
              <div class="row-path mono" :title="v.exePath">{{ v.exePath }}</div>
              <div class="row-meta">
                <span v-if="v.size">{{ formatSize(v.size) }} · </span>
                <span>安装于 {{ formatDate(v.installedAt) }}</span>
              </div>
            </div>
            <div class="row-actions">
              <button
                v-if="settings.defaultVersionId !== v._id"
                class="btn small ghost"
                title="设为默认引擎:新建项目默认使用它"
                @click="setDefault(v)"
              ><Icon name="star" :size="12" /> 设为默认</button>
              <span class="act-sep"></span>
              <button
                v-if="!tplStatuses[v._id]?.installed"
                class="btn small ghost"
                :disabled="!!tplTaskFor(v._id)"
                :title="tplTaskFor(v._id) ? '导出模板下载中' : '下载并安装该版本的导出模板(约 1GB),导出游戏必需'"
                @click="installTemplates(v)"
              ><Icon name="download" :size="13" /> {{ tplTaskFor(v._id) ? '模板任务中' : '获取模板' }}</button>
              <button
                class="btn small ghost icon-act"
                :disabled="!!tplTaskFor(v._id)"
                title="从本地 .tpz 安装(自编译/第三方模板);不发起下载"
                @click="startLocalImport(v)"
              ><Icon name="upload" :size="13" /></button>
              <button
                v-if="isWindows()"
                class="btn small ghost"
                :disabled="!!tplTaskFor(v._id)"
                title="挑选要保留的功能后自行编译导出模板(需要本机 MSVC 工具链与 Godot 源码)"
                @click="tplWizardFor = v._id"
              ><Icon name="terminal" :size="13" /> 自编译模板</button>
              <template v-if="tplStatuses[v._id]?.installed">
                <button
                  class="btn small ghost"
                  :class="{ 'danger-text': confirmingTplId === v._id }"
                  :title="`卸载导出模板(${tplStatuses[v._id]?.versionDir})`"
                  @click="askUninstallTemplates(v)"
                >{{ confirmingTplId === v._id ? '确认卸载?' : '卸载模板' }}</button>
                <button
                  class="btn small ghost icon-act"
                  :title="`打开导出模板所在目录:${tplStatuses[v._id]?.path}`"
                  @click="openPath(tplStatuses[v._id].path)"
                ><Icon name="external" :size="13" /></button>
              </template>
              <button
                class="btn small ghost icon-act"
                title="模板库:列存档 / 切换生效 / 删除 / 收编(同版本串引擎共享存档)"
                @click="toggleLib(v)"
              ><Icon name="archive" :size="13" /></button>
              <span class="act-sep"></span>
              <button class="btn small ghost icon-act" title="打开所在目录" @click="showInFolder(v.exePath)">
                <Icon name="folder" :size="13" />
              </button>
              <button class="btn small danger-text" @click="askDelete(v)">
                {{ confirmingId === v._id ? '确认删除?' : '删除' }}
              </button>
            </div>
          </div>

          <!-- 本地导入的确认行:选完 .tpz 后在这里改目标目录名(默认就是状态查询给的那个),
               确认才入队;编辑器按版本串查找模板,目录名必须与它的 --version 输出一致 -->
          <div v-if="localImport && localImport.versionId === v._id" class="sub-row">
            <span class="sub-label">模板目录名</span>
            <input
              v-model="localImport.dirName"
              class="input mono sub-input"
              title="编辑器按版本串在 export_templates/ 下查找,须与引擎 --version 输出一致(如 4.3.stable)"
              @keyup.enter="confirmLocalImport"
            >
            <button class="btn small" @click="confirmLocalImport">开始导入</button>
            <button class="btn small ghost" @click="cancelLocalImport">取消</button>
            <span class="sub-hint">只允许字母数字、点、下划线、连字符</span>
          </div>
          <!-- 模板库下拉:列存档 + 切换/删除/收编;切换 = 宿主两次 move,重启编辑器后生效 -->
          <div v-if="libFor === v._id" class="sub-row lib">
            <div class="lib-head">
              <span class="sub-label">模板库存档(同版本串引擎共享)</span>
              <span class="grow"></span>
              <button
                v-if="tplStatuses[v._id]?.installed && !libPacks.some((p) => p.active)"
                class="btn small ghost"
                title="把当前生效目录登记为存档(不搬文件,首次被换出时才进存档槽)"
                @click="actAdopt(v)"
              >收编当前</button>
            </div>
            <p v-if="libErr" class="lib-note bad">{{ libErr }}</p>
            <div v-for="p in libPacks" :key="p.packId" class="lib-row">
              <span class="tag mono">{{ p.source === 'selfbuild' ? '自编译' : '收编' }}</span>
              <span v-if="p.active" class="tag ok">生效中</span>
              <span class="lib-note">{{ Math.round(p.bytes / 1048576) }} MB · {{ p.packId }}</span>
              <span class="grow"></span>
              <button class="btn small ghost" :disabled="libBusy || p.active" @click="actActivate(v, p)">切换</button>
              <button
                class="btn small ghost"
                :class="{ 'danger-text': confirmingPackId === p.packId }"
                @click="actDelete(v, p)"
              >{{ confirmingPackId === p.packId ? '确认删除?' : '删除' }}</button>
            </div>
            <p v-if="!libPacks.length && !libErr" class="lib-note">暂无存档:自编译导入会自动存档,或点「收编当前」把生效目录登记入库。</p>
          </div>
        </div>
      </div>
      <EmptyState
        v-else
        icon="package"
        title="尚未安装 Godot 引擎"
        desc="从「官方下载」获取官方引擎,或导入本地 Godot 可执行文件;安装完成后即可在项目中绑定使用。"
      >
        <button class="btn primary" @click="tab = 'market'"><Icon name="download" :size="14" /> 前往官方下载</button>
        <button class="btn" :disabled="importing" @click="importLocal">
          <Icon name="upload" :size="14" /> {{ importing ? '导入中…' : '导入本地引擎' }}
        </button>
      </EmptyState>
    </template>

    <!-- 官方下载 -->
    <template v-else>
      <div class="panel">
        <div class="panel-head filters-head">
          <span class="panel-title"><Icon name="globe" :size="13" /> 官方版本</span>
          <span class="grow"></span>
          <select v-model="majorFilter" class="select" title="按大版本筛选">
            <option value="all">全部大版本</option>
            <option v-for="m in majorOptions" :key="m" :value="m">{{ m }}.x</option>
          </select>
          <label class="check" title="隐藏 beta / rc 等预发布版">
            <input v-model="stableOnly" type="checkbox" />
            <span>仅稳定版</span>
          </label>
          <div class="seg">
            <button :class="{ on: variant === 'standard' }" title="标准版(内置 GDScript)" @click="variant = 'standard'">标准</button>
            <button :class="{ on: variant === 'mono' }" title="C# 版(需 .NET,支持 C# 项目)" @click="variant = 'mono'">C#</button>
          </div>
        </div>

        <div v-if="releasesError" class="state-box err">
          <Icon name="alert" :size="14" />
          <span class="grow">获取版本列表失败:{{ releasesError }}</span>
          <button class="btn small" @click="loadReleases(true)">重试</button>
        </div>
        <div v-else-if="releasesLoading" class="state-box">
          <span class="spin"></span> 正在获取版本列表…
        </div>
        <template v-else>
          <div v-for="r in visibleReleases" :key="r.tag" class="row">
            <span class="rel-dot" :class="{ pre: r.prerelease }" :title="r.prerelease ? '预发布' : '稳定版'"></span>
            <div class="rel-main">
              <span class="name mono">{{ r.name }}</span>
              <span class="rel-tag mono">{{ r.tag }}</span>
              <span v-if="r.prerelease" class="tag warn" title="预发布(beta / rc),不建议生产环境使用">预发布</span>
            </div>
            <span class="rel-date">{{ formatDate(r.publishedAt) }}</span>
            <span v-if="assetFor(r) && assetFor(r)!.size" class="rel-size mono">{{ formatSize(assetFor(r)!.size) }}</span>
            <a
              class="btn small ghost icon-act"
              :href="`https://github.com/godotengine/godot/releases/tag/${r.tag}`"
              target="_blank"
              rel="noopener"
              title="在 GitHub 查看发布说明"
            ><Icon name="external" :size="13" /></a>
            <button
              v-if="isInstalled(r)"
              class="btn small ghost ok-btn"
              disabled
            ><Icon name="check" :size="12" /> 已安装</button>
            <div v-else-if="isDownloading(r)" class="rel-progress" :title="statusText[taskFor(r)!.status]">
              <div class="bar" :class="{ indet: !taskFor(r)!.totalSize }"><div class="fill active" :style="{ width: progressOf(taskFor(r)!) + '%' }"></div></div>
              <span class="rel-pct">{{ progressText(taskFor(r)!) }}</span>
            </div>
            <button v-else-if="!assetFor(r)" class="btn small" disabled title="该版本无此变体">无此变体</button>
            <button v-else class="btn small primary" @click="download(r)"><Icon name="download" :size="12" /> 下载</button>
          </div>
          <div v-if="!visibleReleases.length" class="state-box plain">没有匹配的版本</div>
        </template>
      </div>
    </template>

    <TemplateBuildWizard
      :open="!!tplWizardFor"
      :version-id="tplWizardFor"
      :tag="installed.find((v) => v._id === tplWizardFor)?.tag || ''"
      @close="tplWizardFor = ''"
      @imported="(msg) => { notify(msg); void refreshTplStatuses() }"
    />
  </div>
</template>

<style scoped>
.head-seg {
  margin-left: 10px;
}

/* ---------- 通用行:已安装行内线 / 官方版本行 ---------- */
.row {
  display: flex;
  align-items: center;
  gap: 13px;
  padding: 11px 16px;
  transition: background 0.13s, box-shadow 0.13s;
}

.row + .row {
  border-top: 1px solid var(--surface-2);
}

.row:hover {
  background: var(--surface-2);
}

/* ---------- 已安装项:横排行 + 条件下挂行 ---------- */
.ver-item + .ver-item {
  border-top: 1px solid var(--surface-2);
}

.v-ico {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: var(--radius-sm);
  background: var(--surface-3);
  color: var(--text-3);
  flex-shrink: 0;
}

.v-ico.default {
  background: var(--brand-weak);
  color: var(--brand);
}

/* 默认引擎的金星角标(与项目列表的收藏角标同语言) */
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
  font-weight: 700;
  font-size: 13.5px;
  white-space: nowrap;
}

.row-path {
  margin-top: 2px;
  font-size: 11.5px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-meta {
  margin-top: 1px;
  font-size: 12px;
  color: var(--text-3);
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

.icon-act:hover:not(:disabled) {
  color: var(--brand);
}

a.icon-act {
  text-decoration: none;
}

.act-sep {
  width: 1px;
  height: 18px;
  background: var(--border);
  margin: 0 3px;
}

/* ---------- 下挂行:本地导入确认 / 模板库 ---------- */
.sub-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  /* 左边距 = 行内边距 16 + 图标 40 + 间距 13,与主行文字对齐 */
  padding: 9px 16px 12px 69px;
  border-top: 1px dashed var(--border);
  background: var(--surface-2);
}

.sub-row.lib {
  flex-direction: column;
  align-items: stretch;
  flex-wrap: nowrap;
  gap: 7px;
}

.sub-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
  white-space: nowrap;
}

.sub-input {
  width: 150px;
  min-width: 0;
  padding: 4px 8px;
  font-size: 12.5px;
}

.sub-hint {
  font-size: 11.5px;
  color: var(--text-3);
}

.lib-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.lib-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.lib-note {
  margin: 0;
  font-size: 11.5px;
  color: var(--text-3);
}

.lib-note.bad {
  color: var(--danger);
}

/* ---------- 面板头辅助 ---------- */
.filters-head {
  flex-wrap: wrap;
  row-gap: 6px;
}

.filters-head .select {
  padding: 3px 8px;
  font-size: 12px;
  box-shadow: none;
}

.filters-head .check {
  font-size: 12px;
}

.root-note {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 38%;
  font-size: 11.5px;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ---------- 下载任务行 ---------- */
.task-row {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 11px 16px;
}

.task-row + .task-row {
  border-top: 1px solid var(--surface-2);
}

.t-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.t-name {
  font-weight: 700;
  font-size: 13px;
}

.t-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-3);
}

.t-status.queued,
.t-status.downloading,
.t-status.extracting,
.t-status.verifying {
  color: var(--brand);
}

.t-status.done {
  color: var(--ok);
}

.t-status.error {
  color: var(--danger);
}

.t-bar {
  display: flex;
  align-items: center;
  gap: 10px;
}

.t-bar .bar {
  flex: 1;
}

.t-meta {
  font-size: 12px;
  color: var(--text-3);
  white-space: nowrap;
}

.t-meta.plain {
  color: var(--brand);
}

.t-err {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--danger);
}

/* ---------- 官方版本行 ---------- */
.rel-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--brand);
  flex-shrink: 0;
}

.rel-dot.pre {
  background: transparent;
  border: 1.5px solid var(--warn);
}

.rel-main {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.rel-tag {
  font-size: 11.5px;
  color: var(--text-3);
  white-space: nowrap;
}

.rel-date,
.rel-size {
  font-size: 12px;
  color: var(--text-3);
  white-space: nowrap;
}

.rel-size {
  min-width: 56px;
  text-align: right;
}

.rel-progress {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.rel-progress .bar {
  width: 96px;
}

.rel-pct {
  font-size: 12px;
  font-weight: 600;
  color: var(--brand);
  white-space: nowrap;
}

.ok-btn {
  color: var(--ok);
}

/* ---------- 状态框:加载 / 出错 / 无匹配 ---------- */
.state-box {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 26px 16px;
  color: var(--text-3);
  font-size: 13px;
}

.state-box.plain {
  padding: 18px 16px;
}

.state-box.err {
  justify-content: flex-start;
  padding: 12px 16px;
  color: var(--danger);
}
</style>
