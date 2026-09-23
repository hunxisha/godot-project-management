<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { notify } from '../services/bridge'
import EmptyState from '../components/EmptyState.vue'
import Icon from '../components/Icon.vue'
import type { AddonInfo, FavoriteAsset, GodotProject, MarketAsset } from '../types/godot'

const emit = defineEmits<{ (e: 'navigate', tab: string): void }>()

const projects = ref<(GodotProject & { _id: string })[]>([])
const targetId = ref('')
const query = ref('')
const tagFilter = ref('')
const searching = ref(false)
const searchError = ref('')
const results = ref<MarketAsset[]>([])
const addons = ref<AddonInfo[]>([])
const installing = ref<{ assetId: string, percent: number, stage: string } | null>(null)
const brokenIcons = ref(new Set<string>())

// ---------- 标签筛选(商店 API 不支持服务端过滤,客户端按标签 slug 筛) ----------

/** 商店标签为自由标签,按 slug 聚合为常用分类 */
const TAG_GROUPS: { label: string, slugs: string[] }[] = [
  { label: '2D', slugs: ['2d'] },
  { label: '3D', slugs: ['3d'] },
  { label: 'UI', slugs: ['ui', 'gui', 'userinterface'] },
  { label: 'AI', slugs: ['ai'] },
  { label: '工具', slugs: ['tool', 'tools', 'editortool', 'tooling'] },
  { label: '模板', slugs: ['template', 'templates'] },
  { label: '材质', slugs: ['material', 'materials'] },
  { label: '着色器', slugs: ['shader', 'shaders'] },
  { label: '编辑器', slugs: ['editor', 'editors'] }
]

/** 资产是否属于标签组(旧收藏无标签列表时按分类名兜底) */
function inGroup(a: MarketAsset, slugs: string[]): boolean {
  if (a.tagSlugs?.length) return a.tagSlugs.some((s) => slugs.includes(s))
  return slugs.includes((a.category || '').toLowerCase())
}

// ---------- 浏览模式:推荐 / 最近更新 / 收藏,搜索常驻工具栏 ----------

type BrowseMode = 'featured' | 'recent' | 'favorites'
const mode = ref<BrowseMode>('featured')
const featured = ref<MarketAsset[]>([])
const recent = ref<MarketAsset[]>([])
const recentPage = ref(1)
const recentPages = ref(1)
const favorites = ref<FavoriteAsset[]>([])
const browsing = ref(false)
const browseError = ref('')

const MODE_META: Record<BrowseMode, { label: string, icon: string }> = {
  featured: { label: '推荐', icon: 'sparkle' },
  recent: { label: '最近更新', icon: 'clock' },
  favorites: { label: '收藏', icon: 'star' }
}

/** 当前展示的资产列表:搜索词非空时优先显示搜索结果;标签筛选在客户端应用 */
const displayAssets = computed<MarketAsset[]>(() => {
  let list: MarketAsset[]
  if (query.value.trim()) list = results.value
  else if (mode.value === 'recent') list = recent.value
  else if (mode.value === 'favorites') list = favorites.value
  else list = featured.value
  const g = TAG_GROUPS.find((x) => x.label === tagFilter.value)
  return g ? list.filter((a) => inGroup(a, g.slugs)) : list
})

/** 目标项目已安装的市场资产 ID */
const installedIds = computed(
  () => new Set(addons.value.filter((a) => a.fromMarket && a.assetId).map((a) => a.assetId!))
)

/** 加载当前模式的数据(推荐只拉一次;最近更新按页;收藏读本地) */
async function loadBrowse() {
  if (mode.value === 'favorites') {
    favorites.value = window.services.listFavorites()
    hydrateVersions(favorites.value)
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
  query.value = ''
  if (mode.value === m) return
  mode.value = m
  loadBrowse()
}

// 输入防抖自动搜索;清空关键词即回到浏览模式
let searchTimer: ReturnType<typeof setTimeout> | null = null
/** 已完成过一次搜索(区分"防抖等待中"与"确实没有结果") */
const hasSearched = ref(false)

watch(query, () => {
  if (searchTimer) clearTimeout(searchTimer)
  const kw = query.value.trim()
  if (!kw) {
    results.value = []
    searchError.value = ''
    hasSearched.value = false
    return
  }
  searchTimer = setTimeout(search, 400)
})

onBeforeUnmount(() => {
  if (searchTimer) clearTimeout(searchTimer)
})

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

onMounted(() => {
  projects.value = window.ztools.db.allDocs('godot/project/') as any[]
  projects.value.sort((a, b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0))
  if (projects.value.length) {
    targetId.value = projects.value[0]._id
    reloadAddons()
  }
  loadBrowse()
})

function onTargetChange() {
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

/** 去掉版本串的前导 v(展示时统一补 v 前缀) */
function fmtVer(v?: string): string {
  return (v || '').replace(/^v+/i, '')
}

/** 商店评分为百分制,换算为 5 星制显示 */
function starsOf(rating?: number): string {
  if (!rating) return ''
  return (rating / 20).toFixed(1)
}

async function search() {
  searching.value = true
  searchError.value = ''
  try {
    const r = await window.services.searchAssets(query.value.trim())
    results.value = r.result
    hydrateVersions(results.value)
  } catch (e: any) {
    searchError.value = e?.message || String(e)
  } finally {
    searching.value = false
    hasSearched.value = true
  }
}

/** 回车立即搜索(绕过防抖) */
function onSearchEnter() {
  if (!query.value.trim()) return
  if (searchTimer) clearTimeout(searchTimer)
  search()
}

/** 图标加载失败时回退到占位块 */
function onIconError(id: string) {
  brokenIcons.value = new Set(brokenIcons.value).add(id)
}

// ---------- 安装 ----------

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
      <!-- 页面标题 -->
      <div class="view-head">
        <h2><Icon name="puzzle" :size="16" /> 插件市场</h2>
        <span class="head-sub">官方 Asset Store</span>
        <span class="grow"></span>
      </div>

      <!-- 工具栏(滚动时吸顶):第一行 安装目标 + 搜索,第二行 浏览模式 -->
      <div class="toolbar">
        <div class="tb-row">
          <label class="tb-target" :title="target?.path ? `安装到 ${target.path}` : '选择要安装插件的项目'">
            <Icon name="folder" :size="13" />
            <span class="tb-caption">安装到</span>
            <select v-model="targetId" class="tb-select" @change="onTargetChange">
              <option v-for="p in projects" :key="p._id" :value="p._id">{{ p.name }}</option>
            </select>
          </label>
          <div class="search-box">
            <Icon name="search" :size="13" class="sb-icon" />
            <input
              v-model="query"
              class="sb-input"
              placeholder="搜索插件,回车立即搜索…"
              spellcheck="false"
              @keyup.enter="onSearchEnter"
            />
          </div>
          <select v-model="tagFilter" class="sb-ver" title="按标签筛选当前列表">
            <option value="">全部标签</option>
            <option v-for="g in TAG_GROUPS" :key="g.label" :value="g.label">{{ g.label }}</option>
          </select>
        </div>
        <div class="tb-row">
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
            </button>
          </div>
          <span class="grow"></span>
        </div>
      </div>

      <!-- 搜索结果概要 -->
      <div v-if="query.trim() && hasSearched && !searchError && !browsing" class="result-line">
        <span class="rl-text">
          “{{ query.trim() }}” 的搜索结果 · {{ displayAssets.length }} 项<template v-if="tagFilter">({{ tagFilter }})</template>
        </span>
        <span class="grow"></span>
        <button class="btn small ghost" @click="query = ''"><Icon name="x" :size="11" /> 清除搜索</button>
      </div>

      <!-- 结果区(浏览/搜索共用) -->
      <div v-if="browseError || searchError" class="card error-box">
        <Icon name="alert" :size="14" />
        <span>加载失败:{{ browseError || searchError }}</span>
      </div>
      <div v-else-if="browsing || searching || (query.trim() && !hasSearched)" class="hint-line">
        <span class="spin"></span> {{ searching || query.trim() ? '搜索中…' : '加载中…' }}
      </div>
      <EmptyState
        v-else-if="query.trim() && !results.length"
        icon="search"
        title="没有找到相关插件"
        :desc="`没有与「${query.trim()}」匹配的插件,试试其他关键词。`"
      />
      <EmptyState
        v-else-if="mode === 'favorites' && !favorites.length"
        icon="star"
        title="还没有收藏"
        desc="在推荐、最近更新或搜索结果中点击 ★ 收藏插件,方便下次快速安装。"
      />
      <EmptyState
        v-else-if="tagFilter && !displayAssets.length"
        icon="puzzle"
        title="该标签下暂无插件"
        :desc="`当前列表中没有「${tagFilter}」标签的插件,可切换其他标签或浏览模式。`"
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
              <span class="asset-title link" :title="`${a.title} · 在商店中查看`" @click="openStore(a)">
                {{ a.title }}
                <Icon name="external" :size="10" />
              </span>
              <span v-if="a.versionString" class="asset-ver" :title="a.versionString">v{{ fmtVer(a.versionString) }}</span>
            </div>
          </div>
          <div class="asset-tags">
            <span class="tag">{{ a.category }}</span>
            <span v-if="a.rating && a.rating >= 20" class="rating" :title="`商店评分 ${starsOf(a.rating)} / 5`">
              <Icon name="star" :size="10" :stroke-width="2.2" /> {{ starsOf(a.rating) }}
            </span>
            <span v-if="installedIds.has(a.assetId)" class="tag ok">已安装</span>
          </div>
          <div class="asset-author">{{ a.author }}</div>
          <div class="asset-desc" :title="a.description">{{ a.description }}</div>
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
            :title="target ? `安装到「${target.name}」(可在工具栏切换)` : '安装'"
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
    </template>
  </div>
</template>

<style scoped>
.grow {
  flex: 1;
}

/* ---------- 页面标题 ---------- */
.head-sub {
  font-size: 12px;
  color: var(--text-3);
  white-space: nowrap;
}

/* ---------- 工具栏(吸顶,两行布局) ---------- */
.toolbar {
  position: sticky;
  top: -16px;
  z-index: 20;
  display: flex;
  flex-direction: column;
  gap: 9px;
  margin: 0 -18px;
  padding: 10px 18px;
  background: var(--bg);
  border-bottom: 1px solid var(--border);
}

.tb-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.tb-target {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-2);
  flex-shrink: 0;
}

.tb-target .icon {
  color: var(--brand);
}

.tb-select {
  max-width: 170px;
  padding: 3px 10px;
  font-size: 13px;
  font-weight: 600;
  color: var(--brand);
  border-color: var(--brand);
  background: var(--brand-weak);
  box-shadow: none;
}

/* ---------- 模式标签 ---------- */
.mode-tabs {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
}

/* ---------- 搜索 ---------- */
.search-box {
  position: relative;
  flex: 1;
  min-width: 180px;
  max-width: 460px;
}

.sb-icon {
  position: absolute;
  left: 9px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--text-3);
  pointer-events: none;
}

.sb-input {
  width: 100%;
  padding: 5px 10px 5px 28px;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text);
  font: inherit;
  font-size: 12.5px;
  outline: none;
  transition: border-color 0.15s, box-shadow 0.15s;
}

.sb-input:focus {
  border-color: var(--brand);
  box-shadow: 0 0 0 3px var(--brand-weak);
}

.sb-input::placeholder {
  color: var(--text-3);
}

.sb-ver {
  padding: 5px 6px;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text-2);
  font-size: 12px;
  box-shadow: none;
}

/* ---------- 搜索结果概要 ---------- */
.result-line {
  display: flex;
  align-items: center;
  gap: 8px;
}

.rl-text {
  font-size: 12.5px;
  color: var(--text-2);
}

/* ---------- 商店评分(5 星制) ---------- */
.rating {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  line-height: 20px;
  background: var(--gold-weak);
  color: var(--gold);
  white-space: nowrap;
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
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.asset-tags {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
}

/* 作者与简介分行,层次更清晰 */
.asset-author {
  font-size: 12px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.asset-desc {
  font-size: 12px;
  line-height: 1.55;
  color: var(--text-2);
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  min-height: 37px;
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
</style>
