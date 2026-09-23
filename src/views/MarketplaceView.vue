<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { notify } from '../services/bridge'
import EmptyState from '../components/EmptyState.vue'
import Icon from '../components/Icon.vue'
import type { AddonInfo, FavoriteAsset, GodotProject, LibraryAsset, MarketAsset } from '../types/godot'

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
const brokenIcons = ref(new Set<string>())

// ---------- 浏览模式:推荐 / 最近更新 / 搜索 / 收藏 ----------

type BrowseMode = 'featured' | 'recent' | 'search' | 'favorites' | 'library'
const mode = ref<BrowseMode>('featured')
const featured = ref<MarketAsset[]>([])
const recent = ref<MarketAsset[]>([])
const recentPage = ref(1)
const recentPages = ref(1)
const favorites = ref<FavoriteAsset[]>([])
const library = ref<LibraryAsset[]>([])
const browsing = ref(false)
const browseError = ref('')

const MODE_META: Record<BrowseMode, { label: string, icon: string }> = {
  featured: { label: '推荐', icon: 'sparkle' },
  recent: { label: '最近更新', icon: 'clock' },
  search: { label: '搜索', icon: 'search' },
  favorites: { label: '收藏', icon: 'star' },
  library: { label: '我的库', icon: 'bookmark' }
}

/** 当前模式展示的资产列表 */
const displayAssets = computed<MarketAsset[]>(() => {
  if (mode.value === 'featured') return featured.value
  if (mode.value === 'recent') return recent.value
  if (mode.value === 'favorites') return favorites.value
  if (mode.value === 'library') return library.value
  return results.value
})

/** 目标项目已安装的市场资产 ID */
const installedIds = computed(
  () => new Set(addons.value.filter((a) => a.fromMarket && a.assetId).map((a) => a.assetId!))
)

/** 加载当前模式的数据(推荐只拉一次;最近更新按页;收藏/我的库读本地) */
async function loadBrowse() {
  if (mode.value === 'favorites') {
    favorites.value = window.services.listFavorites()
    hydrateVersions(favorites.value)
    return
  }
  if (mode.value === 'library') {
    library.value = window.services.listLibrary()
    return
  }
  if (mode.value === 'featured' && featured.value.length) return
  browsing.value = true
  browseError.value = ''
  try {
    if (mode.value === 'featured') {
      featured.value = await window.services.listFeatured()
      hydrateVersions(featured.value)
    } else if (mode.value === 'recent') {
      const r = await window.services.listRecentlyUpdated(recentPage.value)
      recent.value = r.result
      recentPages.value = r.pages
      hydrateVersions(recent.value)
    }
  } catch (e: any) {
    browseError.value = e?.message || String(e)
  } finally {
    browsing.value = false
  }
}

/** 异步拉取列表资产的最新版本号并填充(失败不影响列表展示) */
async function hydrateVersions(list: MarketAsset[]) {
  const ids = list.map((a) => a.assetId).filter((id) => typeof id === 'string' && id.includes('/'))
  if (!ids.length) return
  try {
    const map = await window.services.getLatestVersions(ids)
    for (const a of list) {
      const v = map[a.assetId]
      if (v) a.versionString = v
    }
  } catch {
    // 版本号拉取失败时静默跳过
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

function formatDate(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

async function search() {
  searching.value = true
  searchError.value = ''
  try {
    const r = await window.services.searchAssets(query.value.trim(), verFilter.value || undefined)
    results.value = r.result
    hydrateVersions(results.value)
  } catch (e: any) {
    searchError.value = e?.message || String(e)
  } finally {
    searching.value = false
  }
}

/** 图标加载失败时回退到占位块 */
function onIconError(id: string) {
  brokenIcons.value = new Set(brokenIcons.value).add(id)
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
    {
      projectId: targetId.value,
      assetId: asset.assetId,
      assetMeta: {
        title: asset.title,
        author: asset.author,
        category: asset.category,
        rating: asset.rating,
        iconUrl: asset.iconUrl,
        description: asset.description,
        storeUrl: asset.storeUrl
      }
    },
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
  <div class="marketplace view">
    <EmptyState
      v-if="!projects.length"
      icon="folder-plus"
      title="先添加一个 Godot 项目"
      desc="插件(Addon)安装在具体项目中,请先在「项目」页添加项目。"
    >
      <button class="btn primary" @click="emit('navigate', 'projects')"><Icon name="folder-plus" :size="14" /> 去添加项目</button>
    </EmptyState>

    <template v-else>
      <!-- 目标项目 -->
      <div class="card target-bar">
        <span class="tb-label"><Icon name="folder" :size="13" /> 安装到</span>
        <select v-model="targetId" class="select" @change="onTargetChange">
          <option v-for="p in projects" :key="p._id" :value="p._id">{{ p.name }}</option>
        </select>
        <span v-if="target" class="tb-path mono" :title="target.path">{{ target.path }}</span>
      </div>

      <!-- 浏览模式切换 -->
      <div class="mode-tabs">
        <button
          v-for="(m, key) in MODE_META"
          :key="key"
          class="chip"
          :class="{ on: mode === key }"
          @click="switchMode(key as BrowseMode)"
        >
          <Icon :name="m.icon" :size="12" />
          {{ m.label }}
          <span v-if="key === 'favorites' && favorites.length" class="chip-count">{{ favorites.length }}</span>
          <span v-if="key === 'library' && library.length" class="chip-count">{{ library.length }}</span>
        </button>
      </div>

      <!-- 搜索(仅搜索模式) -->
      <div v-if="mode === 'search'" class="search-row">
        <div class="search-box">
          <Icon name="search" :size="14" class="sb-icon" />
          <input
            v-model="query"
            class="input"
            placeholder="搜索插件,如 dialogic、tiled importer…"
            spellcheck="false"
            @keyup.enter="search"
          />
        </div>
        <select v-model="verFilter" class="select" title="按引擎版本过滤">
          <option value="">全部版本</option>
          <option v-for="v in versionOptions" :key="v" :value="v">Godot {{ v }}</option>
        </select>
        <button class="btn primary" :disabled="searching" @click="search">
          <span v-if="searching" class="spin"></span>
          {{ searching ? '搜索中…' : '搜索' }}
        </button>
      </div>

      <!-- 结果区(推荐/最近更新/搜索/收藏共用) -->
      <div v-if="browseError || searchError" class="card error-box">
        <Icon name="alert" :size="14" />
        <span>加载失败:{{ browseError || searchError }}</span>
      </div>
      <div v-else-if="browsing" class="hint-line"><span class="spin"></span> 加载中…</div>
      <div v-else-if="mode === 'search' && !results.length && !searching" class="hint-line">
        输入关键词搜索 Godot 官方资产商店(Asset Store),可按引擎版本过滤,点击名称可在浏览器中打开详情。
      </div>
      <EmptyState
        v-else-if="mode === 'favorites' && !favorites.length"
        icon="star"
        title="还没有收藏"
        desc="在推荐、最近更新或搜索结果中点击 ★ 收藏插件,方便下次快速安装。"
      />
      <EmptyState
        v-else-if="mode === 'library' && !library.length"
        icon="bookmark"
        title="我的库还是空的"
        desc="通过市场安装过的插件会自动记录到这里,可在不同项目间快速重装。"
      />
      <div v-if="displayAssets.length" class="asset-grid">
        <div v-for="a in displayAssets" :key="a.assetId" class="card asset">
          <button
            class="fav-btn"
            :class="{ active: isFav(a.assetId) }"
            :title="isFav(a.assetId) ? '取消收藏' : '收藏'"
            @click="toggleFav(a)"
          ><Icon name="star" :size="14" :stroke-width="isFav(a.assetId) ? 2.4 : 1.7" /></button>
          <div class="asset-head">
            <img
              v-if="a.iconUrl && !brokenIcons.has(a.assetId)"
              :src="a.iconUrl"
              class="asset-icon"
              alt=""
              @error="onIconError(a.assetId)"
            />
            <div v-else class="asset-icon ph"><Icon name="puzzle" :size="22" /></div>
            <div class="asset-title-box">
              <span class="asset-title link" title="在商店中查看" @click="openStore(a)">
                {{ a.title }}
                <Icon name="external" :size="10" />
              </span>
              <span v-if="a.versionString" class="asset-ver">v{{ a.versionString }}</span>
            </div>
          </div>
          <div class="asset-tags">
            <span class="tag">{{ a.category }}</span>
            <span v-if="a.rating" class="tag brand"><Icon name="star" :size="10" :stroke-width="2.2" /> {{ (a.rating / 10).toFixed(1) }}</span>
            <span v-if="installedIds.has(a.assetId)" class="tag ok">已安装</span>
          </div>
          <div
            v-if="mode === 'library' && (a as LibraryAsset).projectCount"
            class="asset-meta lib"
            :title="(a as LibraryAsset).projectNames.join('\n')"
          >
            已装于 {{ (a as LibraryAsset).projectCount }} 个项目 · {{ formatDate((a as LibraryAsset).installedAt) }}
          </div>
          <div v-else class="asset-meta" :title="a.description">
            {{ a.author }}{{ a.description ? ' · ' + a.description : '' }}
          </div>
          <button
            v-if="installing && installing.assetId === a.assetId"
            class="btn small asset-install busy"
            disabled
          >
            <span class="spin"></span>
            {{ installing.stage }} {{ installing.percent.toFixed(0) }}%
          </button>
          <button
            v-else
            class="btn small primary asset-install"
            :disabled="!!installing"
            @click="install(a)"
          ><Icon name="download" :size="12" /> 安装</button>
        </div>
      </div>

      <!-- 最近更新分页 -->
      <div v-if="mode === 'recent' && recent.length && !browsing" class="page-row">
        <button class="btn small" :disabled="recentPage <= 1" @click="changeRecentPage(-1)"><Icon name="chevron-left" :size="12" /> 上一页</button>
        <span class="page-info">{{ recentPage }} / {{ recentPages }}</span>
        <button class="btn small" :disabled="recentPage >= recentPages" @click="changeRecentPage(1)">下一页 <Icon name="chevron-right" :size="12" /></button>
      </div>

      <!-- 已安装 -->
      <div class="view-head installed-head">
        <h2><Icon name="puzzle" :size="16" /> 已安装插件 <span class="count-pill">{{ addons.length }}</span></h2>
        <span class="grow"></span>
        <button v-if="addons.some((a) => a.fromMarket)" class="btn small" :disabled="checking" @click="checkUpdates">
          <span v-if="checking" class="spin"></span>
          <Icon v-else name="refresh" :size="12" />
          {{ checking ? '检查中…' : '检查更新' }}
        </button>
      </div>

      <EmptyState v-if="!addons.length" icon="puzzle" title="该项目还没有插件" desc="在上方搜索并安装,安装后自动写入 addons/ 目录。" />
      <div v-else class="addon-list">
        <div v-for="a in addons" :key="a.dirName" class="card addon">
          <div class="ad-ico" :class="{ off: !a.enabled }"><Icon name="puzzle" :size="17" /></div>
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
            ><Icon name="download" :size="12" /> 更新</button>
            <button v-if="a.hasCfg" class="btn small ghost" @click="toggleEnabled(a)">
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
.grow {
  flex: 1;
}

/* ---------- 目标项目 ---------- */
.target-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
}

.tb-label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-2);
  flex-shrink: 0;
}

.tb-label .icon {
  color: var(--brand);
}

.target-bar .select {
  padding: 3px 10px;
  font-size: 13px;
  box-shadow: none;
}

.tb-path {
  flex: 1;
  font-size: 11.5px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---------- 模式标签 ---------- */
.mode-tabs {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
}

/* ---------- 搜索 ---------- */
.search-row {
  display: flex;
  gap: 8px;
}

.search-box {
  position: relative;
  flex: 1;
}

.sb-icon {
  position: absolute;
  left: 10px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--text-3);
  pointer-events: none;
}

.search-box .input {
  width: 100%;
  padding-left: 32px;
}

.search-row .select {
  box-shadow: none;
}

.error-box {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  color: var(--danger);
  font-size: 13px;
}

.hint-line {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 26px 0;
  text-align: center;
  font-size: 12.5px;
  color: var(--text-3);
}

/* ---------- 资产网格 ---------- */
.asset-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
  gap: 10px;
}

.asset {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px;
  transition: border-color 0.15s, box-shadow 0.15s, transform 0.15s;
}

.asset:hover {
  border-color: var(--brand);
  box-shadow: var(--shadow-lift);
  transform: translateY(-1px);
}

.fav-btn {
  position: absolute;
  top: 10px;
  right: 10px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}

.fav-btn:hover {
  background: var(--surface-2);
  color: var(--gold);
}

.fav-btn.active {
  color: var(--gold);
}

.asset-head {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  padding-right: 24px;
}

.asset-icon {
  width: 44px;
  height: 44px;
  border-radius: var(--radius-sm);
  object-fit: contain;
  background: var(--surface-2);
  border: 1px solid var(--border);
  flex-shrink: 0;
}

.asset-icon.ph {
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--brand-weak);
  border-color: transparent;
  color: var(--brand);
}

.asset-title-box {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.asset-title {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}

.asset-title .icon {
  color: var(--text-3);
  flex-shrink: 0;
}

.asset-title:hover,
.asset-title:hover .icon {
  color: var(--brand);
}

.asset-ver {
  font-size: 11px;
  color: var(--text-3);
  font-family: var(--mono);
}

.asset-tags {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
}

.asset-meta {
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-3);
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  min-height: 36px;
}

.asset-meta.lib {
  color: var(--brand);
  display: block;
  min-height: 0;
}

.asset-install {
  margin-top: auto;
  width: 100%;
}

.asset-install.busy {
  color: var(--brand);
}

/* ---------- 分页 ---------- */
.page-row {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
}

.page-info {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--text-3);
}

/* ---------- 已安装插件 ---------- */
.installed-head {
  margin-top: 4px;
}

.addon-list {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.addon {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 14px;
  transition: border-color 0.15s, box-shadow 0.15s;
}

.addon:hover {
  border-color: var(--border-strong);
  box-shadow: var(--shadow-sm);
}

.ad-ico {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: var(--radius-sm);
  background: var(--brand-weak);
  color: var(--brand);
  flex-shrink: 0;
}

.ad-ico.off {
  background: var(--surface-3);
  color: var(--text-3);
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

.name {
  font-weight: 600;
  font-size: 13.5px;
}

.addon-meta {
  font-size: 11.5px;
  color: var(--text-3);
}

.addon-actions {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
}
</style>
