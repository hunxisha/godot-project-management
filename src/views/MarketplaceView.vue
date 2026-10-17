<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { notify } from '../services/bridge'
import { IS_DESKTOP } from '../services/desktop'
import EmptyState from '../components/EmptyState.vue'
import Icon from '../components/Icon.vue'
import VersionPickerDialog from '../components/dialogs/VersionPickerDialog.vue'
import InstallPreviewDialog from '../components/dialogs/InstallPreviewDialog.vue'
import AssetDetailDialog from '../components/dialogs/AssetDetailDialog.vue'
import { useAssetHydration } from '../composables/useAssetHydration'
import { useMarketSearch } from '../composables/useMarketSearch'
import { useMarketBrowse, MODE_META, type BrowseMode } from '../composables/useMarketBrowse'
import { useMarketInstall } from '../composables/useMarketInstall'
import { useMarketFavorites } from '../composables/useMarketFavorites'
import { compatOf as assetCompat, godotRange, projectGodotVersion } from '../utils/godotVersion'
import { MARKET_TAG_GROUPS, isLikelyAsset } from '../utils/marketTags'
import { normVersion } from '../utils/format'
import type { AddonInfo, GodotProject, GodotVersion, MarketAsset } from '../types/godot'

// 被 App 的 KeepAlive 缓存:切走再切回不重新加载浏览数据(直到插件重启)
defineOptions({ name: 'MarketplaceView' })

const props = defineProps<{
  /** 跨页意图:从项目页「从市场模板创建」跳入时为 'projects',消费后置空 */
  enterMode?: string | null
}>()

const emit = defineEmits<{
  (e: 'navigate', tab: string): void
  (e: 'consumed'): void
}>()

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
  page: searchPage,
  pages: searchPages,
  onSearchEnter,
  changePage: changeSearchPage
} = useMarketSearch({
  hydrate: hydrateVersions,
  // 模板模式下搜索查 type=1;mode 在下方 useMarketBrowse 里声明,闭包到搜索时才求值
  getAssetType: () => (mode.value === 'projects' ? 1 : 0)
})

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
  preview,
  previewingId,
  install,
  openPicker,
  installFromPicker,
  confirmPreview,
  cancelPreview,
  cancelPreviewDownload,
  saveAsProject,
  saveZip,
  defaultStripOf
} = useMarketInstall({
  targetId,
  addons,
  reloadAddons: () => reloadAddons(),
  notify
})

/**
 * 收藏:星标状态与收藏/取消收藏动作都在 useMarketFavorites 里。
 * 那里有一条硬约束 —— 跨层传参必须经 toBridgeData() 拍平成纯数据,
 * 否则 contextBridge 克隆响应式对象时会抛「An object could not be cloned」。
 */
const { isFav, toggleFav, favDiag } = useMarketFavorites({
  favorites,
  reloadFavorites: () => reloadFavorites(),
  notify
})

/**
 * 桌面版(Tauri)没有本地收藏:动作在垫片里如实抛错(tauri-shim.js 的 toggleFavorite)。
 * 这里不等用户点下去才看到红条 —— 星标直接禁用,收藏模式的空态也改成「不支持」而不是
 * 「点 ★ 试试」那种做不到的建议。项目收藏(`p.favorite`)是另一回事,不受这条影响。
 */
const isDesktop = IS_DESKTOP

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
  if (e.key !== 'Escape') return
  // 先关安装确认层(取消要释放暂存包),再关详情与版本选择器
  if (preview.value) {
    cancelPreview()
    return
  }
  if (detailTarget.value) {
    detailTarget.value = null
    return
  }
  if (picker.value) picker.value = null
}

function onTargetChange() {
  reloadAddons()
}

async function reloadAddons() {
  if (!targetId.value) {
    addons.value = []
    return
  }
  addons.value = await window.services.listAddons(targetId.value)
}

// ---------- 商店入口 ----------

/** 打开商店页面 */
function openStore(a: MarketAsset) {
  if (a.storeUrl) window.ztools.shellOpenExternal(a.storeUrl)
}

/** 资产详情弹层 */
const detailTarget = ref<MarketAsset | null>(null)

/** 卡片标题点击 → 详情弹层(在商店外链移入弹层内部) */
function openDetail(a: MarketAsset) {
  detailTarget.value = a
}

/** 图标加载失败时回退到占位块 */
function onIconError(id: string) {
  brokenIcons.value = new Set(brokenIcons.value).add(id)
}

// 跨页意图:项目页「从市场模板创建」跳入 → 直接切到模板模式
watch(
  () => props.enterMode,
  (m) => {
    if (m === 'projects') {
      switchMode('projects')
      emit('consumed')
    }
  }
)
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
      <!-- 页头:子页切换 + 安装目标 + 搜索 -->
      <div class="view-head">
        <h2>
          <Icon name="puzzle" :size="17" /> 插件市场
          <span class="count-pill" title="当前列表中的资产数">{{ displayAssets.length }}</span>
        </h2>
        <div class="seg head-seg" role="tablist" aria-label="插件子页">
          <button class="on" aria-current="true">市场</button>
          <button @click="emit('navigate', 'addons')">已安装</button>
        </div>
        <span class="grow"></span>
        <label class="target" :title="target?.path ? `安装到 ${target.path}` : '选择要安装插件的项目'">
          <Icon name="folder" :size="13" />
          <select v-model="targetId" class="select target-select" @change="onTargetChange">
            <option v-for="p in sortedProjects" :key="p._id" :value="p._id">{{ p.favorite ? '★ ' : '' }}{{ p.name }}</option>
          </select>
        </label>
        <span v-if="targetGodot" class="tag brand" title="该项目绑定的 Godot 版本">Godot {{ targetGodot }}</span>
        <div class="search-box">
          <Icon name="search" :size="13" class="sb-icon" />
          <input
            v-model="query"
            class="input sb-input"
            placeholder="搜索插件,回车立即搜索…"
            spellcheck="false"
            @keyup.enter="onSearchEnter"
          />
        </div>
      </div>

      <!-- 浏览面板:模式 seg + 标签/兼容筛选在头部,网格与分页在主体 -->
      <div class="panel browse">
        <div class="panel-head">
          <div class="panel-title"><Icon name="globe" :size="13" /> 资产库</div>
          <div class="seg mode-seg" role="tablist" aria-label="浏览模式">
            <button
              v-for="(m, key) in MODE_META"
              :key="key"
              :class="{ on: mode === key }"
              @click="switchMode(key as BrowseMode)"
            >
              <Icon :name="m.icon" :size="11" />
              {{ m.label }}
              <span v-if="key === 'favorites' && favorites.length" class="seg-count">{{ favorites.length }}</span>
            </button>
          </div>
          <span class="grow"></span>
          <select v-model="tagFilter" class="select head-select" title="按标签筛选当前列表">
            <option value="">全部标签</option>
            <option v-for="g in MARKET_TAG_GROUPS" :key="g.label" :value="g.label">{{ g.label }}</option>
          </select>
          <div class="seg" title="按目标项目的 Godot 版本筛选兼容插件">
            <button :class="{ on: !compatOnly }" @click="compatOnly = false">全部</button>
            <button
              :class="{ on: compatOnly }"
              :disabled="!targetGodot"
              :title="targetGodot ? `仅显示兼容 Godot ${targetGodot} 的插件` : '项目未绑定 Godot 版本'"
              @click="compatOnly = true"
            >仅满足版本</button>
          </div>
        </div>

        <div class="panel-body">
          <!-- 收藏失败诊断:只在失败时出现,点击可关闭 -->
          <div v-if="favDiag" class="fav-diag" title="点击关闭诊断信息" @click="favDiag = ''">
            <Icon name="alert" :size="12" />
            <span>{{ favDiag }}</span>
            <Icon name="x" :size="11" />
          </div>

          <!-- 搜索结果概要(服务端分页,每页 20;多页时提供翻页) -->
          <div v-if="query.trim() && hasSearched && !searchError && !browsing" class="result-line">
            <span class="rl-text">
              “{{ query.trim() }}” 的搜索结果 · {{ displayAssets.length }} 项<template v-if="tagFilter">({{ tagFilter }})</template>
            </span>
            <span v-if="searchPages > 1" class="search-pager">
              <button class="btn small" :disabled="searchPage <= 1 || searching" title="上一页" @click="changeSearchPage(-1)">
                <Icon name="chevron-left" :size="12" />
              </button>
              <span class="search-page-info mono">{{ searchPage }} / {{ searchPages }}</span>
              <button class="btn small" :disabled="searchPage >= searchPages || searching" title="下一页" @click="changeSearchPage(1)">
                <Icon name="chevron-right" :size="12" />
              </button>
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
            :title="isDesktop ? '桌面版暂不支持收藏' : '还没有收藏'"
            :desc="isDesktop
              ? '桌面版还没移植本地收藏(★),这一栏在桌面版会是空的;浏览与安装不受影响,需要收藏请用 ZTools 插件版。'
              : '在推荐、最近更新或搜索结果中点击 ★ 收藏插件,方便下次快速安装。'"
          />
          <EmptyState
            v-else-if="tagFilter && !displayAssets.length"
            icon="puzzle"
            title="该标签下暂无插件"
            :desc="aggregating ? `已扫描商店全部页面,没有找到「${tagFilter}」标签的插件,可切换其他标签。` : `当前列表中没有「${tagFilter}」标签的插件,可切换其他标签或浏览模式。`"
          />

          <!-- 资产卡片网格 -->
          <div v-if="displayAssets.length" class="asset-grid">
            <div v-for="a in displayAssets" :key="a.assetId" class="card asset" :title="`${a.title} · 查看详情`" @click="openDetail(a)">
              <button
                class="fav-btn"
                :class="{ active: isFav(a.assetId) }"
                :disabled="isDesktop"
                :title="isDesktop ? '桌面版暂不支持收藏' : isFav(a.assetId) ? '取消收藏' : '收藏'"
                @click.stop="toggleFav(a)"
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
                  <span class="asset-title" :title="a.title">
                    {{ a.title }}
                    <Icon name="external" :size="10" />
                  </span>
                  <span v-if="a.versionString" class="asset-ver mono" :title="a.versionString">v{{ normVersion(a.versionString) }}</span>
                </div>
              </div>
              <div class="asset-author" :title="a.author">{{ a.author }}</div>
              <div class="asset-desc" :title="a.description">{{ a.description }}</div>
              <div class="asset-tags">
                <span class="tag">{{ a.category }}</span>
                <span
                  v-if="isLikelyAsset(a)"
                  class="tag brand"
                  title="根据标签推测为纯素材(模型/精灵等),将安装到项目根而非 addons/,以确认页为准"
                >素材</span>
                <span
                  v-if="godotRange(a)"
                  class="gver"
                  :class="{ bad: compatOf(a) === false }"
                  :title="compatOf(a) === false ? `需要 ${godotRange(a)},当前项目为 Godot ${targetGodot || '未知'}` : `兼容 ${godotRange(a)}`"
                >{{ godotRange(a) }}<template v-if="compatOf(a) === false"> · 项目 {{ targetGodot || '?' }}</template></span>
                <span v-if="installedIds.has(a.assetId)" class="tag ok">已安装</span>
              </div>
              <div class="install-row">
                <button
                  v-if="installing && installing.assetId === a.assetId && previewingId === a.assetId"
                  class="btn small ghost pick-ver"
                  title="取消预览下载"
                  @click.stop="cancelPreviewDownload(a.assetId)"
                >取消</button>
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
                  :title="mode === 'projects' ? '另存为新项目' : target ? `安装最新版到「${target.name}」` : '安装'"
                  @click.stop="install(a)"
                ><Icon name="download" :size="12" /> {{ mode === 'projects' ? '另存' : '安装' }}</button>
                <button
                  class="btn small ghost pick-ver"
                  :disabled="!!installing"
                  :title="`选择版本安装${installedIds.has(a.assetId) ? '(覆盖已装版本)' : ''}`"
                  @click.stop="openPicker(a)"
                ><Icon name="chevron-down" :size="12" /></button>
                <button
                  class="btn small ghost"
                  :disabled="!!installing"
                  title="仅下载 zip 包到本地,不安装"
                  @click.stop="saveZip(a)"
                ><Icon name="hard-drive" :size="12" /></button>
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
              class="page-info mono"
              :title="aggregating ? `已聚合 ${matchPool.length} 个「${tagFilter}」插件(共扫描 ${poolFetched} 页)` : ''"
            >{{ pageNum }} / {{ aggregating ? poolPages + (poolDone ? '' : '+') : pageTotal }}</span>
            <button
              class="btn small"
              :disabled="aggregating ? poolDone && pageNum >= poolPages : pageNum >= pageTotal"
              @click="changePage(1)"
            >下一页 <Icon name="chevron-right" :size="12" /></button>
          </div>
        </div>
      </div>

      <!-- 版本选择器模态框 -->
      <VersionPickerDialog
        :open="!!picker"
        :asset-id="picker?.asset.assetId || ''"
        :title="picker?.asset.title || ''"
        @pick="installFromPicker"
        @close="picker = null"
      />

      <!-- 安装确认模态框(素材/完整项目;插件直接安装不经过这里) -->
      <InstallPreviewDialog
        :open="!!preview"
        :title="preview?.title || ''"
        :version="preview?.versionString || ''"
        :project-name="target?.name || ''"
        :plan="preview?.plan || null"
        :default-strip="preview ? defaultStripOf(preview.asset.assetId) : false"
        @confirm="confirmPreview"
        @close="cancelPreview"
        @save-as-project="saveAsProject"
      />

      <!-- 资产详情模态框 -->
      <AssetDetailDialog
        :open="!!detailTarget"
        :asset-id="detailTarget?.assetId || ''"
        @close="detailTarget = null"
      />
    </template>
  </div>
</template>

<style scoped>
/* ---------- 页头 ---------- */
.view-head {
  flex-wrap: wrap;
}

.head-seg {
  margin-left: 10px;
}

/* 安装目标 */
.target {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-2);
  min-width: 0;
}

.target .icon {
  color: var(--brand);
  flex-shrink: 0;
}

.target-select {
  max-width: 170px;
  padding: 3px 8px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--brand);
  box-shadow: none;
}

/* 搜索框 */
.search-box {
  position: relative;
  width: 230px;
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
  font-size: 12.5px;
  box-shadow: none;
}

/* ---------- 浏览面板头 ---------- */
.browse .panel-head {
  flex-wrap: wrap;
}

/* 六个浏览模式横排较宽,窄窗口下允许换行 */
.mode-seg {
  flex-wrap: wrap;
}

/* 模式按钮里的计数(收藏数),复用 chip-count 的视觉 */
.seg-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 15px;
  padding: 0 4px;
  border-radius: 999px;
  background: var(--brand-weak);
  color: var(--brand);
  font-size: 10px;
  font-weight: 700;
}

.head-select {
  padding: 3px 8px;
  font-size: 12px;
  box-shadow: none;
}

/* ---------- 收藏诊断条(仅失败时渲染) ---------- */
.fav-diag {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 10px;
  padding: 7px 10px;
  border: 1px solid var(--danger);
  border-radius: var(--radius-sm);
  background: var(--danger-weak);
  color: var(--danger);
  font-size: 12px;
  cursor: pointer;
  word-break: break-all;
}

/* ---------- 搜索结果概要 ---------- */
.result-line {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}

.rl-text {
  font-size: 12.5px;
  color: var(--text-2);
}

.search-pager {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.search-page-info {
  font-size: 11.5px;
  color: var(--text-3);
  min-width: 44px;
  text-align: center;
}

/* ---------- 状态行 ---------- */
.error-box {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-color: var(--danger);
  background: var(--danger-weak);
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

/* ---------- 资产卡片网格 ---------- */
.asset-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
  gap: 10px;
}

.asset {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 13px;
  /* 整卡即详情入口(内部按钮已 @click.stop 隔离) */
  cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s, transform 0.15s;
}

.asset:hover {
  border-color: var(--brand);
  box-shadow: var(--shadow-lift);
  transform: translateY(-1px);
}

.fav-btn {
  position: absolute;
  top: 8px;
  right: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}

.fav-btn:hover:not(:disabled) {
  background: var(--surface-2);
  color: var(--gold);
}

.fav-btn.active {
  color: var(--gold);
}

/* 桌面版禁用态:压淡且不抢卡片光标 —— 不是「加载中」也不是「坏了」,是该宿主没有此功能 */
.fav-btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.asset-head {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  padding-right: 22px;
}

.asset-icon {
  width: 42px;
  height: 42px;
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
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

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

.asset-tags {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
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

/* 安装行:安装按钮 + 版本选择 + 下载 zip */
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

.asset-install.ok {
  color: var(--ok);
}

.pick-ver {
  flex-shrink: 0;
}

/* ---------- 分页 ---------- */
.page-row {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  margin-top: 14px;
}

.page-info {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--text-3);
}
</style>
