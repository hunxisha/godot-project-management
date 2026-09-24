<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { notify } from '../services/bridge'
import EmptyState from '../components/EmptyState.vue'
import Icon from '../components/Icon.vue'
import VersionPickerDialog from '../components/dialogs/VersionPickerDialog.vue'
import { useAssetHydration } from '../composables/useAssetHydration'
import { useMarketSearch } from '../composables/useMarketSearch'
import { useMarketBrowse, MODE_META, type BrowseMode } from '../composables/useMarketBrowse'
import { useMarketInstall } from '../composables/useMarketInstall'
import { compatOf as assetCompat, godotRange, projectGodotVersion } from '../utils/godotVersion'
import { MARKET_TAG_GROUPS } from '../utils/marketTags'
import { normVersion } from '../utils/format'
import type { AddonInfo, GodotProject, GodotVersion, MarketAsset } from '../types/godot'

// 被 App 的 KeepAlive 缓存:切走再切回不重新加载浏览数据(直到插件重启)
defineOptions({ name: 'MarketplaceView' })

const emit = defineEmits<{ (e: 'navigate', tab: string): void }>()

// 本视图自己持有的状态:目标项目、标签筛选、兼容开关、图标回退、已装插件
const projects = ref<(GodotProject & { _id: string })[]>([])
const versions = ref<(GodotVersion & { _id: string })[]>([])
const targetId = ref('')
const tagFilter = ref('')
/** 仅显示兼容当前项目 Godot 版本的插件 */
const compatOnly = ref(false)
const addons = ref<AddonInfo[]>([])
const brokenIcons = ref(new Set<string>())

// 资产 release 信息补齐(浏览与搜索共用同一实现)
const { hydrateVersions } = useAssetHydration()

// 搜索:关键词防抖、请求状态、结果列表
const {
  query,
  searching,
  searchError,
  results,
  hasSearched,
  onSearchEnter
} = useMarketSearch({ hydrate: hydrateVersions })

// ---------- Godot 版本兼容(安装目标) ----------
// 换算逻辑在 src/utils/godotVersion.ts(纯函数、可独立测试);这里只把当前目标项目接上去。

/** 安装目标项目的 Godot 版本(major.minor) */
const targetGodot = computed(() => projectGodotVersion(target.value, versions.value))

/** 资产是否兼容当前目标项目(模板里按单参数调用) */
const compatOf = (a: MarketAsset): boolean | null => assetCompat(a, targetGodot.value)

// ---------- 浏览与安装 ----------
// 浏览(模式/分页/标签聚合池/展示过滤)与安装(进度/已装集合/版本选择器)分别在两个
// 组合式函数里,本视图只做装配与页面级交互。

const {
  mode,
  pageNum,
  pageTotal,
  favorites,
  browsing,
  browseError,
  matchPool,
  poolFetched,
  poolDone,
  poolPages,
  poolLoading,
  aggregating,
  displayAssets,
  switchMode,
  changePage,
  loadBrowse,
  reloadFavorites
} = useMarketBrowse({
  tagFilter,
  query,
  results,
  compatOnly,
  compatOf,
  hydrate: hydrateVersions
})

const {
  installing,
  installedIds,
  picker,
  install,
  openPicker,
  installFromPicker
} = useMarketInstall({
  targetId,
  addons,
  reloadAddons: () => reloadAddons(),
  notify
})

/**
 * 收藏状态的唯一真相是浏览层那份 `favorites` 列表。
 * 原先每个卡片的三处绑定各自调一次 `window.services.isFavorite()`,有两个问题:
 *   1. 那是普通函数调用,不是响应式依赖 —— 收藏后星标能不能重绘,取决于组件恰好因别的原因重渲染;
 *   2. 一屏 18 张卡片 × 3 处 = 每次渲染 54 次跨层同步调用。
 * 现在改成从 `favorites` 派生的集合:收藏列表一变,星标必然跟着变。
 */
const favIds = computed(() => new Set(favorites.value.map((f) => String(f.assetId))))

function isFav(id: string): boolean {
  return favIds.value.has(String(id))
}

function toggleFav(a: MarketAsset) {
  const before = isFav(a.assetId)
  window.services.toggleFavorite(a)
  reloadFavorites()
  const after = isFav(a.assetId)
  // 写库失败时前后状态相同 —— 如实报错,不要谎报成功
  if (after === before) notify('收藏失败,请重试')
  else notify(after ? '已收藏 ' + a.title : '已取消收藏')
}

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
})

const target = computed(() => projects.value.find((p) => p._id === targetId.value))

/** 安装目标:收藏项目排前(其余按最近打开) */
const sortedProjects = computed(() =>
  [...projects.value].sort((a, b) => {
    if (!!a.favorite !== !!b.favorite) return a.favorite ? -1 : 1
    return (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0)
  })
)

onMounted(() => {
  projects.value = window.ztools.db.allDocs('godot/project/') as any[]
  versions.value = window.ztools.db.allDocs('godot/version/') as any[]
  if (projects.value.length) {
    targetId.value = sortedProjects.value[0]._id
    reloadAddons()
  }
  loadBrowse()
  // 星标状态派生自 favorites,任意浏览模式下都要先把它读出来(否则推荐/全部模式的星标会是空的)
  reloadFavorites()
  window.addEventListener('keydown', onKeydown)
})

// 切回本页(KeepAlive 缓存实例被重新激活):轻量同步本地数据,浏览状态全部保留
onActivated(() => {
  projects.value = window.ztools.db.allDocs('godot/project/') as any[]
  versions.value = window.ztools.db.allDocs('godot/version/') as any[]
  // 上次选中的项目已被删除时回退到收藏/最近项目
  if (projects.value.length && !projects.value.some((p) => p._id === targetId.value)) {
    targetId.value = sortedProjects.value[0]._id
  }
  reloadAddons()
  // 本页在别处(如插件页卸载)被改动过收藏时,重新进入也保持一致
  reloadFavorites()
})

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && picker.value) picker.value = null
}

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

// ---------- 商店入口 ----------

/** 打开商店页面 */
function openStore(a: MarketAsset) {
  if (a.storeUrl) window.ztools.shellOpenExternal(a.storeUrl)
}

/** 图标加载失败时回退到占位块 */
function onIconError(id: string) {
  brokenIcons.value = new Set(brokenIcons.value).add(id)
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
              <option v-for="p in sortedProjects" :key="p._id" :value="p._id">{{ p.favorite ? '★ ' : '' }}{{ p.name }}</option>
            </select>
            <span v-if="targetGodot" class="tb-gver" title="该项目绑定的 Godot 版本">Godot {{ targetGodot }}</span>
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
            <option v-for="g in MARKET_TAG_GROUPS" :key="g.label" :value="g.label">{{ g.label }}</option>
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
          <div class="compat-seg" title="按目标项目的 Godot 版本筛选兼容插件">
            <button :class="{ on: !compatOnly }" @click="compatOnly = false">全部</button>
            <button
              :class="{ on: compatOnly }"
              :disabled="!targetGodot"
              :title="targetGodot ? `仅显示兼容 Godot ${targetGodot} 的插件` : '项目未绑定 Godot 版本'"
              @click="compatOnly = true"
            >仅满足版本</button>
          </div>
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
        <span class="spin"></span>
        {{ searching || query.trim() ? '搜索中…' : poolLoading ? `正在从商店聚合「${tagFilter}」标签的插件…` : '加载中…' }}
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
        :desc="aggregating ? `已扫描商店全部页面,没有找到「${tagFilter}」标签的插件,可切换其他标签。` : `当前列表中没有「${tagFilter}」标签的插件,可切换其他标签或浏览模式。`"
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
              <span v-if="a.versionString" class="asset-ver" :title="a.versionString">v{{ normVersion(a.versionString) }}</span>
            </div>
          </div>
          <div class="asset-tags">
            <span class="tag">{{ a.category }}</span>
            <span
              v-if="godotRange(a)"
              class="gver"
              :class="{ bad: compatOf(a) === false }"
              :title="compatOf(a) === false ? `需要 ${godotRange(a)},当前项目为 Godot ${targetGodot || '未知'}` : `兼容 ${godotRange(a)}`"
            >{{ godotRange(a) }}<template v-if="compatOf(a) === false"> · 项目 {{ targetGodot || '?' }}</template></span>
            <span v-if="installedIds.has(a.assetId)" class="tag ok">已安装</span>
          </div>
          <div class="asset-author">{{ a.author }}</div>
          <div class="asset-desc" :title="a.description">{{ a.description }}</div>
          <div class="install-row">
            <button
              v-if="installing && installing.assetId === a.assetId"
              class="btn small asset-install busy"
              disabled
            >
              <span class="spin"></span>
              {{ installing.stage }} {{ installing.percent.toFixed(0) }}%
            </button>
            <button
              v-else-if="installedIds.has(a.assetId)"
              class="btn small asset-install ok"
              disabled
            >已安装</button>
            <button
              v-else
              class="btn small primary asset-install"
              :disabled="!!installing"
              :title="target ? `安装最新版到「${target.name}」` : '安装'"
              @click="install(a)"
            ><Icon name="download" :size="12" /> 安装</button>
            <button
              class="btn small ghost pick-ver"
              :disabled="!!installing"
              :title="`选择版本安装${installedIds.has(a.assetId) ? '(覆盖已装版本)' : ''}`"
              @click="openPicker(a)"
            ><Icon name="chevron-down" :size="12" /></button>
          </div>
        </div>
      </div>

      <!-- 分页(全部/新品/最近更新;标签筛选时为聚合分页,页码为匹配项页数,+ 表示还有更多) -->
      <div
        v-if="(mode === 'all' || mode === 'new' || mode === 'recent') && displayAssets.length && !browsing"
        class="page-row"
      >
        <button class="btn small" :disabled="pageNum <= 1" @click="changePage(-1)"><Icon name="chevron-left" :size="12" /> 上一页</button>
        <span
          class="page-info"
          :title="aggregating ? `已聚合 ${matchPool.length} 个「${tagFilter}」插件(共扫描 ${poolFetched} 页)` : ''"
        >{{ pageNum }} / {{ aggregating ? poolPages + (poolDone ? '' : '+') : pageTotal }}</span>
        <button
          class="btn small"
          :disabled="aggregating ? poolDone && pageNum >= poolPages : pageNum >= pageTotal"
          @click="changePage(1)"
        >下一页 <Icon name="chevron-right" :size="12" /></button>
      </div>

      <!-- 版本选择器模态框 -->
      <VersionPickerDialog
        :open="!!picker"
        :asset-id="picker?.asset.assetId || ''"
        :title="picker?.asset.title || ''"
        @pick="installFromPicker"
        @close="picker = null"
      />
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

/* 安装目标的 Godot 版本 */
.tb-gver {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-2);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 2px 8px;
  white-space: nowrap;
}

/* 兼容筛选 seg(全部 / 仅满足版本) */
.compat-seg {
  display: inline-flex;
  padding: 2px;
  gap: 2px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
}

.compat-seg button {
  border: none;
  background: transparent;
  color: var(--text-3);
  font-size: 11.5px;
  font-weight: 600;
  padding: 3px 10px;
  border-radius: calc(var(--radius-sm) - 1px);
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
  white-space: nowrap;
}

.compat-seg button:not(:disabled):hover {
  color: var(--text);
}

.compat-seg button.on {
  background: var(--surface);
  color: var(--brand);
  box-shadow: var(--shadow-sm);
}

.compat-seg button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
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

/* 安装行:安装按钮 + 版本选择按钮 */
.install-row {
  margin-top: auto;
  display: flex;
  gap: 6px;
}

.install-row .asset-install {
  flex: 1;
  min-width: 0;
}

.asset-install.busy {
  color: var(--brand);
}

.pick-ver {
  flex-shrink: 0;
}

/* Godot 兼容版本范围 */
.gver {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-3);
  white-space: nowrap;
}

.gver.bad {
  color: var(--danger);
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

/* ---------- 版本选择器模态框 ---------- */
.modal-mask {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(18, 26, 40, 0.45);
}

.modal {
  width: min(520px, calc(100vw - 48px));
  max-height: calc(100vh - 64px);
  overflow-y: auto;
  padding: 18px 20px;
  box-shadow: var(--shadow-lift);
}

.modal-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.modal-title {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 14.5px;
  font-weight: 700;
  color: var(--text);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.icon-x {
  width: 26px;
  padding: 3px 0;
  color: var(--text-3);
  flex-shrink: 0;
}
</style>
