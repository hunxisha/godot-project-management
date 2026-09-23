<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { notify } from '../services/bridge'
import EmptyState from '../components/EmptyState.vue'
import type { AddonInfo, FavoriteAsset, GodotProject, MarketAsset } from '../types/godot'

const emit = defineEmits<{ (e: 'navigate', tab: string): void }>()

const projects = ref<(GodotProject & { _id: string })[]>([])
const targetId = ref('')
const query = ref('')
const verFilter = ref('')
const searching = ref(false)
const searchError = ref('')
const results = ref<MarketAsset[]>([])
const checking = ref(false)
const addons = ref<AddonInfo[]>([])
const installing = ref<{ assetId: string, percent: number, stage: string } | null>(null)
const confirmingDir = ref<string | null>(null)
const updateInfo = ref<Record<string, { hasUpdate: boolean, latest?: string }>>({})

// ---------- 浏览模式:推荐 / 最近更新 / 搜索 / 收藏 ----------

type BrowseMode = 'featured' | 'recent' | 'search' | 'favorites'
const mode = ref<BrowseMode>('featured')
const featured = ref<MarketAsset[]>([])
const recent = ref<MarketAsset[]>([])
const recentPage = ref(1)
const recentPages = ref(1)
const favorites = ref<FavoriteAsset[]>([])
const browsing = ref(false)
const browseError = ref('')

/** 当前模式展示的资产列表 */
const displayAssets = computed<MarketAsset[]>(() => {
  if (mode.value === 'featured') return featured.value
  if (mode.value === 'recent') return recent.value
  if (mode.value === 'favorites') return favorites.value
  return results.value
})

/** 目标项目已安装的市场资产 ID */
const installedIds = computed(
  () => new Set(addons.value.filter((a) => a.fromMarket && a.assetId).map((a) => a.assetId!))
)

/** 加载当前模式的数据(推荐只拉一次;最近更新按页;收藏读本地) */
async function loadBrowse() {
  if (mode.value === 'favorites') {
    favorites.value = window.services.listFavorites()
    return
  }
  if (mode.value === 'featured' && featured.value.length) return
  browsing.value = true
  browseError.value = ''
  try {
    if (mode.value === 'featured') {
      featured.value = await window.services.listFeatured()
    } else if (mode.value === 'recent') {
      const r = await window.services.listRecentlyUpdated(recentPage.value)
      recent.value = r.result
      recentPages.value = r.pages
    }
  } catch (e: any) {
    browseError.value = e?.message || String(e)
  } finally {
    browsing.value = false
  }
}

function switchMode(m: BrowseMode) {
  if (mode.value === m) return
  mode.value = m
  loadBrowse()
}

function changeRecentPage(delta: number) {
  const next = recentPage.value + delta
  if (next < 1 || next > recentPages.value) return
  recentPage.value = next
  loadBrowse()
}

function isFav(id: string): boolean {
  return window.services.isFavorite(id)
}

function toggleFav(a: MarketAsset) {
  window.services.toggleFavorite(a)
  favorites.value = window.services.listFavorites()
  notify(isFav(a.assetId) ? '已收藏 ' + a.title : '已取消收藏')
}

const target = computed(() => projects.value.find((p) => p._id === targetId.value))

/** 引擎版本筛选选项:已装引擎的 major.minor */
const versionOptions = computed(() => {
  const set = new Set<string>()
  for (const p of projects.value) {
    if (p.engineVersion) set.add(p.engineVersion.split('.').slice(0, 2).join('.'))
  }
  return [...set]
})

onMounted(() => {
  projects.value = window.ztools.db.allDocs('godot/project/') as any[]
  projects.value.sort((a, b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0))
  if (projects.value.length) {
    targetId.value = projects.value[0]._id
    if (projects.value[0].engineVersion) {
      verFilter.value = projects.value[0].engineVersion.split('.').slice(0, 2).join('.')
    }
    reloadAddons()
  }
  loadBrowse()
})

function onTargetChange() {
  updateInfo.value = {}
  reloadAddons()
}

function reloadAddons() {
  if (!targetId.value) {
    addons.value = []
    return
  }
  addons.value = window.services.listAddons(targetId.value)
}

// ---------- 搜索 ----------

/** 打开商店页面 */
function openStore(a: MarketAsset) {
  if (a.storeUrl) window.ztools.shellOpenExternal(a.storeUrl)
}

async function search() {
  searching.value = true
  searchError.value = ''
  try {
    const r = await window.services.searchAssets(query.value.trim(), verFilter.value || undefined)
    results.value = r.result
  } catch (e: any) {
    searchError.value = e?.message || String(e)
  } finally {
    searching.value = false
  }
}

// ---------- 安装 / 更新 ----------

function fmtSize(n?: number): string {
  if (!n) return ''
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function percent(p: { received?: number, total?: number }): number {
  if (!p.total) return 0
  return Math.min(100, ((p.received || 0) / p.total) * 100)
}

async function install(asset: MarketAsset) {
  if (!targetId.value || installing.value) return
  installing.value = { assetId: asset.assetId, percent: 0, stage: '下载中' }
  const r = await window.services.installAsset(
    { projectId: targetId.value, assetId: asset.assetId },
    (p) => {
      if (!installing.value || installing.value.assetId !== asset.assetId) return
      if (p.stage === 'downloading') {
        installing.value.percent = percent(p)
        installing.value.stage = `下载中 ${fmtSize(p.received)}`
      } else {
        installing.value.percent = 100
        installing.value.stage = '解压中'
      }
    }
  )
  installing.value = null
  if (r.ok) {
    notify(`已安装 ${r.addon?.title}${r.addon?.enabled ? '(已启用)' : ''}`)
    reloadAddons()
  } else {
    notify(r.error || '安装失败')
  }
}

async function checkUpdates() {
  if (!targetId.value) return
  checking.value = true
  const jobs = addons.value.filter((a) => a.fromMarket && a.assetId)
  const next: Record<string, { hasUpdate: boolean, latest?: string }> = {}
  await Promise.all(
    jobs.map(async (a) => {
      const r = await window.services.checkAddonUpdate({ projectId: targetId.value, assetId: a.assetId! })
      if (r.hasUpdate) next[a.dirName] = { hasUpdate: true, latest: r.latest }
    })
  )
  updateInfo.value = next
  checking.value = false
  const count = Object.keys(next).length
  notify(count ? `${count} 个插件有新版本` : '所有插件均为最新版本')
}

async function update(a: AddonInfo) {
  if (!targetId.value || !a.assetId || installing.value) return
  installing.value = { assetId: a.assetId, percent: 0, stage: '下载中' }
  const r = await window.services.updateAsset(
    { projectId: targetId.value, assetId: a.assetId },
    (p) => {
      if (p.stage === 'downloading') {
        installing.value = { assetId: a.assetId!, percent: percent(p), stage: `下载中 ${fmtSize(p.received)}` }
      } else {
        installing.value = { assetId: a.assetId!, percent: 100, stage: '解压中' }
      }
    }
  )
  installing.value = null
  if (r.ok) {
    notify(`${a.name} 已更新到 ${r.addon?.versionString}`)
    reloadAddons()
    checkUpdates()
  } else {
    notify(r.error || '更新失败')
  }
}

// ---------- 启用 / 卸载 ----------

function toggleEnabled(a: AddonInfo) {
  const r = window.services.setAddonEnabled({ projectId: targetId.value, dirName: a.dirName, enabled: !a.enabled })
  if (r.ok) reloadAddons()
  else notify(r.error || '操作失败')
}

function uninstall(a: AddonInfo) {
  if (confirmingDir.value === a.dirName) {
    confirmingDir.value = null
    const r = window.services.uninstallAddon({ projectId: targetId.value, dirName: a.dirName })
    if (r.ok) reloadAddons()
    else notify(r.error || '卸载失败')
  } else {
    confirmingDir.value = a.dirName
    setTimeout(() => {
      if (confirmingDir.value === a.dirName) confirmingDir.value = null
    }, 2500)
  }
}
</script>

<template>
  <div class="marketplace">
    <EmptyState
      v-if="!projects.length"
      title="先添加一个 Godot 项目"
      desc="插件(Addon)安装在具体项目中,请先在「项目」页添加项目。"
    >
      <button class="btn primary" @click="emit('navigate', 'projects')">去添加项目</button>
    </EmptyState>

    <template v-else>
      <!-- 目标项目 -->
      <div class="card target-bar">
        <span class="tb-label">安装到</span>
        <select v-model="targetId" class="select" @change="onTargetChange">
          <option v-for="p in projects" :key="p._id" :value="p._id">{{ p.name }}</option>
        </select>
        <span v-if="target" class="tb-path mono" :title="target.path">{{ target.path }}</span>
      </div>

      <!-- 浏览模式切换 -->
      <div class="seg mode-tabs">
        <button :class="{ on: mode === 'featured' }" @click="switchMode('featured')">推荐</button>
        <button :class="{ on: mode === 'recent' }" @click="switchMode('recent')">最近更新</button>
        <button :class="{ on: mode === 'search' }" @click="switchMode('search')">搜索</button>
        <button :class="{ on: mode === 'favorites' }" @click="switchMode('favorites')">
          收藏<span v-if="favorites.length" class="fav-count">{{ favorites.length }}</span>
        </button>
      </div>

      <!-- 搜索(仅搜索模式) -->
      <div v-if="mode === 'search'" class="search-row">
        <input
          v-model="query"
          class="input"
          placeholder="搜索插件,如 dialogic、tiled importer…"
          spellcheck="false"
          @keyup.enter="search"
        />
        <select v-model="verFilter" class="select" title="按引擎版本过滤">
          <option value="">全部版本</option>
          <option v-for="v in versionOptions" :key="v" :value="v">Godot {{ v }}</option>
        </select>
        <button class="btn primary" :disabled="searching" @click="search">
          {{ searching ? '搜索中…' : '搜索' }}
        </button>
      </div>

      <!-- 结果区(推荐/最近更新/搜索/收藏共用) -->
      <div v-if="browseError || searchError" class="card error-box">
        <span>加载失败:{{ browseError || searchError }}</span>
      </div>
      <div v-else-if="browsing" class="hint-line">加载中…</div>
      <div v-else-if="mode === 'search' && !results.length && !searching" class="hint-line">
        输入关键词搜索 Godot 官方资产商店(Asset Store),可按引擎版本过滤,点击名称可在浏览器中打开详情。
      </div>
      <EmptyState
        v-else-if="mode === 'favorites' && !favorites.length"
        title="还没有收藏"
        desc="在推荐、最近更新或搜索结果中点击 ★ 收藏插件,方便下次快速安装。"
      />
      <div v-if="displayAssets.length" class="asset-list">
        <div v-for="a in displayAssets" :key="a.assetId" class="card asset">
          <img v-if="a.iconUrl" :src="a.iconUrl" class="asset-icon" alt="" @error="($event.target as HTMLImageElement).style.display = 'none'" />
          <div v-else class="asset-icon placeholder"></div>
          <div class="asset-main">
            <div class="asset-name">
              <span class="name link" title="在商店中查看" @click="openStore(a)">{{ a.title }}</span>
              <span class="tag">{{ a.category }}</span>
              <span v-if="a.rating" class="tag brand" title="商店评分">★ {{ (a.rating / 10).toFixed(1) }}</span>
              <span v-if="installedIds.has(a.assetId)" class="tag ok">已安装</span>
            </div>
            <div class="asset-meta" :title="a.description">
              {{ a.author }}{{ a.description ? ' · ' + a.description : '' }}
            </div>
          </div>
          <button
            class="btn small fav-btn"
            :class="{ active: isFav(a.assetId) }"
            :title="isFav(a.assetId) ? '取消收藏' : '收藏'"
            @click="toggleFav(a)"
          >★</button>
          <button
            v-if="installing && installing.assetId === a.assetId"
            class="btn small"
            disabled
          >{{ installing.stage }} {{ installing.percent.toFixed(0) }}%</button>
          <button
            v-else
            class="btn small primary"
            :disabled="!!installing"
            @click="install(a)"
          >安装</button>
        </div>
      </div>

      <!-- 最近更新分页 -->
      <div v-if="mode === 'recent' && recent.length && !browsing" class="page-row">
        <button class="btn small" :disabled="recentPage <= 1" @click="changeRecentPage(-1)">上一页</button>
        <span class="page-info">{{ recentPage }} / {{ recentPages }}</span>
        <button class="btn small" :disabled="recentPage >= recentPages" @click="changeRecentPage(1)">下一页</button>
      </div>

      <!-- 已安装 -->
      <div class="section-head">
        <h2>已安装插件 <span class="count">{{ addons.length }}</span></h2>
        <span class="grow"></span>
        <button v-if="addons.some((a) => a.fromMarket)" class="btn small" :disabled="checking" @click="checkUpdates">
          {{ checking ? '检查中…' : '检查更新' }}
        </button>
      </div>

      <EmptyState v-if="!addons.length" title="该项目还没有插件" desc="在上方搜索并安装,安装后自动写入 addons/ 目录。" />
      <div v-else class="addon-list">
        <div v-for="a in addons" :key="a.dirName" class="card addon">
          <div class="addon-main">
            <div class="addon-name">
              <span class="name">{{ a.name }}</span>
              <span v-if="a.version" class="tag">v{{ a.version }}</span>
              <span class="tag" :class="a.enabled ? 'ok' : 'warn'">{{ a.enabled ? '已启用' : '未启用' }}</span>
              <span v-if="a.fromMarket" class="tag brand">市场</span>
              <span v-else class="tag" title="手动放置或未通过市场安装">未知来源</span>
              <span v-if="updateInfo[a.dirName]" class="tag warn">可更新到 v{{ updateInfo[a.dirName].latest }}</span>
            </div>
            <div class="addon-meta mono" :title="`addons/${a.dirName}`">addons/{{ a.dirName }}</div>
          </div>
          <div class="addon-actions">
            <button
              v-if="a.fromMarket && updateInfo[a.dirName]"
              class="btn small primary"
              :disabled="!!installing"
              @click="update(a)"
            >更新</button>
            <button v-if="a.hasCfg" class="btn small" @click="toggleEnabled(a)">
              {{ a.enabled ? '禁用' : '启用' }}
            </button>
            <button class="btn small danger-text" @click="uninstall(a)">
              {{ confirmingDir === a.dirName ? '确认卸载?' : '卸载' }}
            </button>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.marketplace {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px;
}

.grow {
  flex: 1;
}

.target-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
}

.tb-label {
  font-size: 13px;
  color: var(--text-2);
}

.tb-path {
  flex: 1;
  font-size: 12px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mode-tabs {
  align-self: flex-start;
}

.fav-count {
  margin-left: 4px;
  font-size: 11px;
  color: var(--brand);
}

.fav-btn {
  color: var(--text-3);
  padding: 4px 8px;
}

.fav-btn.active {
  color: #f5a623;
}

.page-row {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
}

.page-info {
  font-size: 12px;
  color: var(--text-3);
}

.search-row {
  display: flex;
  gap: 8px;
}

.search-row .input {
  flex: 1;
}

.error-box {
  display: flex;
  padding: 10px 14px;
  color: var(--danger);
  font-size: 13px;
}

.hint-line {
  padding: 16px 0;
  text-align: center;
  font-size: 12px;
  color: var(--text-3);
}

.asset-list,
.addon-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.asset {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 14px;
}

.asset-icon {
  width: 32px;
  height: 32px;
  border-radius: var(--radius-sm);
  object-fit: contain;
  background: var(--surface-2);
  flex-shrink: 0;
}

.asset-icon.placeholder {
  background: var(--brand-weak);
}

.asset-main {
  flex: 1;
  min-width: 0;
}

.asset-name {
  display: flex;
  align-items: center;
  gap: 6px;
}

.name {
  font-weight: 600;
}

.name.link {
  cursor: pointer;
}

.name.link:hover {
  color: var(--brand);
}

.asset-meta {
  font-size: 12px;
  color: var(--text-3);
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

.addon {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 14px;
}

.addon-main {
  flex: 1;
  min-width: 0;
}

.addon-name {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.addon-meta {
  font-size: 12px;
  color: var(--text-3);
}

.addon-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}
</style>
