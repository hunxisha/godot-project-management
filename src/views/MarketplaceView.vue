<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { notify } from '../services/bridge'
import EmptyState from '../components/EmptyState.vue'
import Icon from '../components/Icon.vue'
import VersionPickerDialog from '../components/dialogs/VersionPickerDialog.vue'
import { fmtSize, normVersion } from '../utils/format'
import type { AddonInfo, FavoriteAsset, GodotProject, GodotVersion, MarketAsset } from '../types/godot'

// 被 App 的 KeepAlive 缓存:切走再切回不重新加载浏览数据(直到插件重启)
defineOptions({ name: 'MarketplaceView' })

const emit = defineEmits<{ (e: 'navigate', tab: string): void }>()

const projects = ref<(GodotProject & { _id: string })[]>([])
const versions = ref<(GodotVersion & { _id: string })[]>([])
const targetId = ref('')
const query = ref('')
const tagFilter = ref('')
/** 仅显示兼容当前项目 Godot 版本的插件 */
const compatOnly = ref(false)
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

// ---------- Godot 版本兼容(安装目标) ----------

/** 安装目标项目的 Godot 版本(major.minor,优先绑定引擎 tag,回退 project.godot 声明) */
const targetGodot = computed(() => {
  const p = target.value
  if (!p) return ''
  const v = versions.value.find((x) => x._id === p.versionId)
  const m = /^v?(\d+\.\d+)/.exec(v?.tag || p.engineVersion || '')
  return m ? m[1] : ''
})

/** 版本串 → 可比较数值("4.4"→404,"4"→400),无法解析返回 null */
function verNum(v?: string): number | null {
  if (!v) return null
  const m = /^v?(\d+)(?:\.(\d+))?/.exec(v.trim())
  if (!m) return null
  return Number(m[1]) * 100 + Number(m[2] || 0)
}

/** 资产是否兼容目标项目的 Godot 版本:无要求或项目版本未知返回 null(无法判断) */
function compatOf(a: MarketAsset): boolean | null {
  const min = verNum(a.minGodot)
  const max = verNum(a.maxGodot)
  const t = verNum(targetGodot.value)
  if ((min == null && max == null) || t == null) return null
  if (min != null && t < min) return false
  if (max != null && t > max) return false
  return true
}

/** 兼容版本范围展示文案 */
function godotRange(a: MarketAsset): string {
  const min = a.minGodot
  const max = a.maxGodot
  if (min && max) return `Godot ${min} ~ ${max}`
  if (min) return `Godot ${min}+`
  if (max) return `Godot ≤ ${max}`
  return ''
}

// ---------- 浏览模式:全部 / 推荐 / 新品 / 最近更新 / 收藏,搜索常驻工具栏 ----------

type BrowseMode = 'all' | 'featured' | 'new' | 'recent' | 'favorites'
const mode = ref<BrowseMode>('featured')
const all = ref<MarketAsset[]>([])
const featured = ref<MarketAsset[]>([])
const fresh = ref<MarketAsset[]>([])
const recent = ref<MarketAsset[]>([])
/** 分页模式(全部/新品/最近更新)共用页码 */
const pageNum = ref(1)
const pageTotal = ref(1)
const favorites = ref<FavoriteAsset[]>([])
const browsing = ref(false)
const browseError = ref('')

// ---------- 标签聚合分页 ----------
// 商店 API 不支持服务端标签过滤,分页模式下每页仅少量匹配项会"看着不满一页"。
// 标签筛选 + 分页模式(全部/新品/最近更新)时改用聚合池:批量并发拉服务端多页,
// 把匹配项汇入本地池,每屏固定展示 20 个匹配项;翻页按需继续聚合,直到拉完全库。

const POOL_PAGE = 20
/** 聚合池:按当前(模式+标签)收集的匹配资产 */
const matchPool = ref<MarketAsset[]>([])
/** 已拉取的服务端页数 */
const poolFetched = ref(0)
/** 服务端是否已拉完(无更多页) */
const poolDone = ref(false)
/** 服务端总页数(首批返回前未知) */
const poolTotalPages = ref(Infinity)
const poolLoading = ref(false)

/** 聚合模式:分页模式 + 已选标签 */
const aggregating = computed(
  () => !!tagFilter.value && (mode.value === 'all' || mode.value === 'new' || mode.value === 'recent')
)
/** 聚合池的客户端页数(未拉完时持续增长,展示时加 + 号) */
const poolPages = computed(() => Math.max(1, Math.ceil(matchPool.value.length / POOL_PAGE)))

const MODE_META: Record<BrowseMode, { label: string, icon: string }> = {
  all: { label: '全部', icon: 'grid' },
  featured: { label: '推荐', icon: 'sparkle' },
  new: { label: '新品', icon: 'zap' },
  recent: { label: '最近更新', icon: 'clock' },
  favorites: { label: '收藏', icon: 'star' }
}

/** 当前展示的资产列表:搜索词非空时优先显示搜索结果;标签/兼容筛选在客户端应用 */
const displayAssets = computed<MarketAsset[]>(() => {
  // 聚合模式:池内已按标签过滤,直接按客户端页码切片(每屏凑满匹配项)
  if (aggregating.value && !query.value.trim()) {
    const start = (pageNum.value - 1) * POOL_PAGE
    let list = matchPool.value.slice(start, start + POOL_PAGE)
    if (compatOnly.value) list = list.filter((a) => compatOf(a) !== false)
    return list
  }
  let list: MarketAsset[]
  if (query.value.trim()) list = results.value
  else if (mode.value === 'all') list = all.value
  else if (mode.value === 'new') list = fresh.value
  else if (mode.value === 'recent') list = recent.value
  else if (mode.value === 'favorites') list = favorites.value
  else list = featured.value
  const g = TAG_GROUPS.find((x) => x.label === tagFilter.value)
  if (g) list = list.filter((a) => inGroup(a, g.slugs))
  if (compatOnly.value) list = list.filter((a) => compatOf(a) !== false)
  return list
})

/** 目标项目已安装的市场资产 ID */
const installedIds = computed(
  () => new Set(addons.value.filter((a) => a.fromMarket && a.assetId).map((a) => a.assetId!))
)

/** 按当前模式拉取服务端指定页(全部/新品/最近更新共用) */
function fetchPage(page: number) {
  if (mode.value === 'all') return window.services.listAllAssets(page)
  if (mode.value === 'new') return window.services.listNewAssets(page)
  return window.services.listRecentlyUpdated(page)
}

/** 重置聚合池 */
function resetPool() {
  matchPool.value = []
  poolFetched.value = 0
  poolDone.value = false
  poolTotalPages.value = Infinity
  pageNum.value = 1
}

/**
 * 聚合服务端多页数据(每批 4 页并发,按页序追加保持排序):
 * 把匹配当前标签的资产汇入池,直到凑满 targetCount 个或拉完全库。
 */
async function fillPool(targetCount: number) {
  if (poolDone.value || poolLoading.value) return
  poolLoading.value = true
  browsing.value = true
  browseError.value = ''
  const g = TAG_GROUPS.find((x) => x.label === tagFilter.value)
  try {
    while (!poolDone.value && matchPool.value.length < targetCount) {
      const batch: number[] = []
      while (batch.length < 4 && poolFetched.value + batch.length + 1 <= poolTotalPages.value) {
        batch.push(poolFetched.value + batch.length + 1)
      }
      if (!batch.length) {
        poolDone.value = true
        break
      }
      const rs = await Promise.all(batch.map((p) => fetchPage(p)))
      for (const r of rs) {
        poolFetched.value += 1
        if (r.pages) poolTotalPages.value = r.pages
        const matched = g ? r.result.filter((a) => inGroup(a, g.slugs)) : r.result
        matchPool.value.push(...matched)
        if (!r.result.length || poolFetched.value >= poolTotalPages.value) poolDone.value = true
      }
    }
  } catch (e: any) {
    browseError.value = e?.message || String(e)
  } finally {
    poolLoading.value = false
    browsing.value = false
  }
}

/** 给聚合模式下当前屏可见资产补齐 release 信息 */
function hydrateScreen() {
  const start = (pageNum.value - 1) * POOL_PAGE
  hydrateVersions(matchPool.value.slice(start, start + POOL_PAGE))
}

/** 加载当前模式的数据(推荐只拉一次;全部/新品/最近更新按页;收藏读本地) */
async function loadBrowse() {
  if (mode.value === 'favorites') {
    favorites.value = window.services.listFavorites()
    hydrateVersions(favorites.value)
    return
  }
  // 聚合模式:重置池并填充第一屏
  if (aggregating.value) {
    resetPool()
    await fillPool(POOL_PAGE)
    hydrateScreen()
    return
  }
  if (mode.value === 'featured' && featured.value.length) return
  browsing.value = true
  browseError.value = ''
  try {
    if (mode.value === 'featured') {
      featured.value = await window.services.listFeatured()
      hydrateVersions(featured.value)
    } else if (mode.value === 'all') {
      const r = await window.services.listAllAssets(pageNum.value)
      all.value = r.result
      pageTotal.value = r.pages
      hydrateVersions(all.value)
    } else if (mode.value === 'new') {
      const r = await window.services.listNewAssets(pageNum.value)
      fresh.value = r.result
      pageTotal.value = r.pages
      hydrateVersions(fresh.value)
    } else if (mode.value === 'recent') {
      const r = await window.services.listRecentlyUpdated(pageNum.value)
      recent.value = r.result
      pageTotal.value = r.pages
      hydrateVersions(recent.value)
    }
  } catch (e: any) {
    browseError.value = e?.message || String(e)
  } finally {
    browsing.value = false
  }
}

/** 异步拉取列表资产的最新 release 信息并填充(版本/兼容范围/发布日期;失败不影响列表展示) */
async function hydrateVersions(list: MarketAsset[]) {
  // 只拉取尚未填充过的资产(聚合模式翻屏时避免重复请求)
  const need = list.filter(
    (a) => a.assetId && a.assetId.includes('/') && !a.versionString && !a.minGodot && !a.maxGodot && !a.releaseCreated
  )
  if (!need.length) return
  try {
    const map = await window.services.getReleaseInfos(need.map((a) => a.assetId))
    for (const a of need) {
      const info = map[a.assetId]
      if (!info) continue
      if (info.version) a.versionString = info.version
      a.minGodot = info.minGodot || undefined
      a.maxGodot = info.maxGodot || undefined
      a.releaseCreated = info.created || undefined
    }
  } catch {
    // 信息拉取失败时静默跳过
  }
}

function switchMode(m: BrowseMode) {
  query.value = ''
  if (mode.value === m) return
  mode.value = m
  pageNum.value = 1
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
  window.removeEventListener('keydown', onKeydown)
})

async function changePage(delta: number) {
  const next = pageNum.value + delta
  if (next < 1) return
  if (aggregating.value) {
    // 聚合模式:池数据不够覆盖下一屏时继续向后聚合
    const need = next * POOL_PAGE
    if (matchPool.value.length < need && !poolDone.value) {
      await fillPool(need)
      if (browseError.value) return
    }
    if ((next - 1) * POOL_PAGE < matchPool.value.length) {
      pageNum.value = next
      hydrateScreen()
    }
    return
  }
  if (next > pageTotal.value) return
  pageNum.value = next
  loadBrowse()
}

// 标签筛选变化:聚合模式下重建匹配池;离开聚合模式时页码是池页码,需回到服务端第 1 页
watch(tagFilter, (_nv, ov) => {
  const wasAgg = !!ov && (mode.value === 'all' || mode.value === 'new' || mode.value === 'recent')
  if (aggregating.value) {
    resetPool()
    fillPool(POOL_PAGE).then(hydrateScreen)
  } else if (wasAgg) {
    pageNum.value = 1
    loadBrowse()
  }
})

function isFav(id: string): boolean {
  return window.services.isFavorite(id)
}

function toggleFav(a: MarketAsset) {
  window.services.toggleFavorite(a)
  favorites.value = window.services.listFavorites()
  notify(isFav(a.assetId) ? '已收藏 ' + a.title : '已取消收藏')
}

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

// ---------- 搜索 ----------

/** 打开商店页面 */
function openStore(a: MarketAsset) {
  if (a.storeUrl) window.ztools.shellOpenExternal(a.storeUrl)
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

function percent(p: { received?: number, total?: number }): number {
  if (!p.total) return 0
  return Math.min(100, ((p.received || 0) / p.total) * 100)
}

/** 安装插件;version 指定 release 版本(版本选择器),缺省为最新 */
async function install(asset: MarketAsset, version?: string) {
  if (!targetId.value || installing.value) return
  installing.value = { assetId: asset.assetId, percent: 0, stage: '下载中' }
  const r = await window.services.installAsset(
    {
      projectId: targetId.value,
      assetId: asset.assetId,
      version,
      assetMeta: {
        title: asset.title,
        author: asset.author,
        category: asset.category,
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
    notify(`已安装 ${r.addon?.title}${version ? ` ${r.addon?.versionString}` : ''}${r.addon?.enabled ? '(已启用)' : ''}`)
    reloadAddons()
  } else {
    notify(r.error || '安装失败')
  }
}

// ---------- 版本选择器 ----------

/** 只保留「要选哪个资产」;release 列表与加载态由对话框自己管 */
const picker = ref<{ asset: MarketAsset } | null>(null)

function openPicker(a: MarketAsset) {
  if (installing.value) return
  picker.value = { asset: a }
}

/** 从版本选择器安装指定版本 */
function installFromPicker(version: string) {
  const a = picker.value?.asset
  if (!a || installing.value) return
  picker.value = null
  install(a, version)
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
