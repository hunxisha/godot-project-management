<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { getSettings, notify, pickDirectory, pickFile, isWindows, saveSettings, showInFolder } from '../services/bridge'
import EmptyState from '../components/EmptyState.vue'
import type { DownloadTask, GodotRelease, GodotVersion, ReleaseAsset, Variant } from '../types/godot'

const settings = reactive(getSettings())
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

installed.value = window.ztools.db.allDocs('godot/version/') as any[]

// ---------- 下载任务 ----------

onMounted(() => {
  unwatchTasks = window.services.watchTasks((snap) => {
    tasks.value = snap
    for (const t of snap) {
      if (t.status === 'done' && t.version && !installed.value.some((v) => v._id === t.version!.id)) {
        installed.value.unshift({ ...t.version, _id: t.version.id })
      }
    }
  })
  loadReleases(false)
})

onBeforeUnmount(() => unwatchTasks && unwatchTasks())

watch(
  tasks,
  (list) => {
    for (const t of list) {
      if (t.status === 'done') {
        notify(`${t.version?.name ?? t.tag} 安装完成`)
        window.services.dismissTask(t.id)
      } else if (t.status === 'canceled') {
        window.services.dismissTask(t.id)
      }
    }
  },
  { deep: false }
)

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

/** 该版本对应的活动下载任务(含排队/下载/解压/校验) */
function taskFor(release: GodotRelease): DownloadTask | undefined {
  return tasks.value.find(
    (t) =>
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
  const dir = pickDirectory('选择 Godot 引擎安装目录')
  if (!dir) return null
  saveSettings({ versionsRoot: dir })
  settings.versionsRoot = dir
  return dir
}

async function download(release: GodotRelease) {
  const asset = assetFor(release)
  if (!asset) return
  const root = await ensureRoot()
  if (!root) return
  window.services.downloadAndInstall(
    { tag: release.tag, variant: variant.value, platform, url: asset.url, fileName: asset.name, totalSize: asset.size },
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
  window.services.downloadAndInstall(
    { tag: t.tag, variant: t.variant, platform: t.platform, url: t.url, fileName: t.fileName, totalSize: t.totalSize },
    { versionsRoot: settings.versionsRoot! }
  )
}

// ---------- 导入 / 删除 / 默认 ----------

async function importLocal() {
  const exe = pickFile('选择 Godot 可执行文件', isWindows() ? ['exe'] : ['*'])
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
  saveSettings({ defaultVersionId: v._id })
  settings.defaultVersionId = v._id
}

function askDelete(v: GodotVersion & { _id: string }) {
  if (confirmingId.value === v._id) {
    confirmingId.value = null
    const r = window.services.deleteVersion({ id: v._id, installDir: v.installDir, managed: v.managed })
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
</script>

<template>
  <div class="versions">
    <!-- 下载任务 -->
    <div v-for="t in tasks" :key="t.id" class="card task">
      <div class="task-head">
        <span class="task-name">{{ t.tag }}</span>
        <span class="tag">{{ t.variant === 'mono' ? 'C#' : '标准' }}</span>
        <span class="grow"></span>
        <span class="task-status" :class="t.status">{{ statusText[t.status] }}</span>
        <button
          v-if="t.status !== 'error' && t.status !== 'canceled' && t.status !== 'done'"
          class="btn small danger-text"
          @click="cancelTask(t)"
        >取消</button>
      </div>
      <div v-if="t.status === 'downloading'" class="task-bar">
        <div class="bar" :class="{ indet: !t.totalSize }"><div class="fill" :style="{ width: progressOf(t) + '%' }"></div></div>
        <span class="task-meta">{{ progressText(t) }} · {{ formatSize(t.received) }}{{ t.totalSize ? '/' + formatSize(t.totalSize) : '' }} · {{ formatSpeed(t.speed) }}</span>
      </div>
      <div v-else-if="t.status === 'error'" class="task-error">
        {{ t.error }}
        <button class="btn small" @click="retryTask(t)">重试</button>
        <button class="btn small" @click="dismissTask(t)">关闭</button>
      </div>
      <div v-else-if="t.status !== 'done'" class="task-meta">{{ statusText[t.status] }}…</div>
    </div>

    <!-- 已安装 -->
    <div class="section-head">
      <h2>已安装 <span class="count">{{ installed.length }}</span></h2>
      <span class="grow"></span>
      <button class="btn small" :disabled="importing" @click="importLocal">{{ importing ? '导入中…' : '导入本地引擎' }}</button>
    </div>

    <div v-if="installed.length" class="installed">
      <div v-for="v in installed" :key="v._id" class="card ver">
        <div class="ver-main">
          <div class="ver-name-row">
            <span class="ver-name">{{ v.name }}</span>
            <span class="tag">{{ v.variant === 'mono' ? 'C#' : '标准' }}</span>
            <span v-if="settings.defaultVersionId === v._id" class="tag brand">默认</span>
            <span v-if="v.verified === false" class="tag warn">未通过校验</span>
            <span v-if="!v.managed" class="tag">导入</span>
          </div>
          <div class="ver-path mono" :title="v.exePath">{{ v.exePath }}</div>
          <div class="ver-meta">
            <span v-if="v.size">{{ formatSize(v.size) }} · </span>
            <span>{{ formatDate(v.installedAt) }}</span>
          </div>
        </div>
        <div class="ver-actions">
          <button v-if="settings.defaultVersionId !== v._id" class="btn small" @click="setDefault(v)">设为默认</button>
          <button class="btn small" @click="showInFolder(v.exePath)">所在目录</button>
          <button class="btn small danger-text" @click="askDelete(v)">
            {{ confirmingId === v._id ? '确认删除?' : '删除' }}
          </button>
        </div>
      </div>
    </div>
    <EmptyState
      v-else
      title="尚未安装 Godot 引擎"
      desc="从下方「可用版本」下载官方引擎,或点击「导入本地引擎」使用已有的 Godot 可执行文件。"
    />

    <!-- 可用版本 -->
    <div class="section-head">
      <h2>可用版本</h2>
      <span class="grow"></span>
      <select v-model="majorFilter" class="select" title="按大版本筛选">
        <option value="all">全部大版本</option>
        <option v-for="m in majorOptions" :key="m" :value="m">{{ m }}.x</option>
      </select>
      <label class="check">
        <input v-model="stableOnly" type="checkbox" />
        <span>仅稳定版</span>
      </label>
      <div class="seg">
        <button :class="{ on: variant === 'standard' }" @click="variant = 'standard'">标准</button>
        <button :class="{ on: variant === 'mono' }" @click="variant = 'mono'">C#</button>
      </div>
      <button class="btn small" :disabled="releasesLoading" @click="loadReleases(true)">
        {{ releasesLoading ? '加载中…' : '刷新' }}
      </button>
    </div>

    <div v-if="releasesError" class="card error-box">
      <span>获取版本列表失败:{{ releasesError }}</span>
      <button class="btn small" @click="loadReleases(true)">重试</button>
    </div>
    <div v-else-if="releasesLoading" class="loading">正在获取版本列表…</div>
    <div v-else class="rel-list">
      <div v-for="r in visibleReleases" :key="r.tag" class="card rel">
        <div class="rel-main">
          <span class="rel-name">{{ r.name }}</span>
          <span v-if="r.prerelease" class="tag warn">预发布</span>
        </div>
        <span class="rel-date">{{ formatDate(r.publishedAt) }}</span>
        <span v-if="assetFor(r) && assetFor(r)!.size" class="rel-size mono">{{ formatSize(assetFor(r)!.size) }}</span>
        <button
          v-if="isInstalled(r)"
          class="btn small"
          disabled
        >已安装</button>
        <div v-else-if="isDownloading(r)" class="rel-progress" :title="statusText[taskFor(r)!.status]">
          <div class="bar" :class="{ indet: !taskFor(r)!.totalSize }">
            <div class="fill" :style="{ width: progressOf(taskFor(r)!) + '%' }"></div>
          </div>
          <span class="rel-pct">{{ progressText(taskFor(r)!) }}</span>
        </div>
        <button v-else-if="!assetFor(r)" class="btn small" disabled title="该版本无此变体">无此变体</button>
        <button v-else class="btn small primary" @click="download(r)">下载</button>
      </div>
      <div v-if="!visibleReleases.length" class="loading">没有匹配的版本</div>
    </div>
  </div>
</template>

<style scoped>
.versions {
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
  margin-top: 6px;
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

.check {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  color: var(--text-2);
  cursor: pointer;
}

.seg {
  display: flex;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  overflow: hidden;
}

.seg button {
  padding: 3px 10px;
  border: none;
  background: var(--surface);
  color: var(--text-2);
  font-size: 12px;
  cursor: pointer;
}

.seg button.on {
  background: var(--brand-weak);
  color: var(--brand);
  font-weight: 600;
}

/* 任务 */
.task {
  padding: 10px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.task-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.task-name {
  font-weight: 600;
}

.task-status {
  font-size: 12px;
  color: var(--text-3);
}

.task-status.downloading,
.task-status.extracting,
.task-status.verifying,
.task-status.queued {
  color: var(--brand);
}

.task-status.done {
  color: var(--ok);
}

.task-status.error {
  color: var(--danger);
}

.task-bar {
  display: flex;
  align-items: center;
  gap: 10px;
}

.bar {
  flex: 1;
  height: 6px;
  border-radius: 3px;
  background: var(--surface-2);
  overflow: hidden;
}

.fill {
  height: 100%;
  border-radius: 3px;
  background: var(--brand);
  transition: width 0.15s linear;
}

/* 总大小未知时的不确定进度动画 */
.bar.indet .fill {
  width: 30% !important;
  animation: indet-slide 1.2s ease-in-out infinite alternate;
}

@keyframes indet-slide {
  from {
    margin-left: 0;
  }
  to {
    margin-left: 70%;
  }
}

/* 版本行内进度条 */
.rel-progress {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.rel-progress .bar {
  flex: none;
  width: 96px;
  height: 6px;
}

.rel-pct {
  font-size: 12px;
  color: var(--brand);
  white-space: nowrap;
}

.task-meta {
  font-size: 12px;
  color: var(--text-3);
  white-space: nowrap;
}

.task-error {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--danger);
}

/* 已安装卡片 */
.installed {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.ver {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 10px 14px;
}

.ver-main {
  flex: 1;
  min-width: 0;
}

.ver-name-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.ver-name {
  font-weight: 600;
}

.ver-path {
  margin-top: 2px;
  font-size: 12px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ver-meta {
  font-size: 12px;
  color: var(--text-3);
}

.ver-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}

/* 可用版本列表 */
.error-box {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  color: var(--danger);
  font-size: 13px;
}

.loading {
  padding: 20px 0;
  text-align: center;
  color: var(--text-3);
  font-size: 13px;
}

.rel-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.rel {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
}

.rel-main {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.rel-name {
  font-weight: 500;
}

.rel-date,
.rel-size {
  font-size: 12px;
  color: var(--text-3);
  white-space: nowrap;
}
</style>
