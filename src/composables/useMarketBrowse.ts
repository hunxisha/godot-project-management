// 市场浏览:模式切换、分页、标签聚合池、展示列表。
//
// 从 MarketplaceView.vue 抽出。这一块原本占视图脚本近一半,而且它内部同时压着三层逻辑:
//   1. 六个浏览模式(全部/模板/推荐/新品/最近更新/收藏)各自的取数方式
//   2. 服务端分页 vs 客户端聚合池(商店 API 不支持服务端标签过滤,标签筛选要自己攒池)
//   3. 展示层的二次过滤(标签分组 + 兼容性)
// 第 3 层需要视图的搜索状态,所以通过参数注入,而不是把搜索也塞进这里 —— 保持接缝清晰。
import { computed, ref, watch, type Ref } from 'vue'
import { MARKET_TAG_GROUPS, tagSlugsOf, inGroup } from '../utils/marketTags'
import type { FavoriteAsset, MarketAsset } from '../types/godot'

/** 浏览模式:全部 / 模板(完整项目) / 推荐 / 新品 / 最近更新 / 收藏 */
export type BrowseMode = 'all' | 'projects' | 'featured' | 'new' | 'recent' | 'favorites'

/** 聚合模式下每屏固定展示的匹配项数量 */
export const POOL_PAGE = 20

export const MODE_META: Record<BrowseMode, { label: string, icon: string }> = {
  all: { label: '全部', icon: 'grid' },
  projects: { label: '模板', icon: 'package' },
  featured: { label: '推荐', icon: 'sparkle' },
  new: { label: '新品', icon: 'zap' },
  recent: { label: '最近更新', icon: 'clock' },
  favorites: { label: '收藏', icon: 'star' }
}

/** 分页模式(需要服务端分页 + 聚合池) */
const PAGED_MODES: BrowseMode[] = ['all', 'projects', 'new', 'recent']

export interface UseMarketBrowseOptions {
  /** 已选标签分组名(视图持有,模板 v-model) */
  tagFilter: Ref<string>
  /** 搜索关键词(非空时展示搜索结果而不是浏览列表) */
  query: Ref<string>
  /** 搜索结果列表(搜索词非空时优先展示) */
  results: Ref<MarketAsset[]>
  /** 仅显示兼容当前项目版本的插件 */
  compatOnly: Ref<boolean>
  /** 兼容判定(视图按当前目标项目闭包出来) */
  compatOf: (a: MarketAsset) => boolean | null
  /** release 信息补齐 */
  hydrate: (list: MarketAsset[]) => void | Promise<void>
}

export function useMarketBrowse(opts: UseMarketBrowseOptions) {
  const mode = ref<BrowseMode>('featured')
  const all = ref<MarketAsset[]>([])
  const projectList = ref<MarketAsset[]>([])
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
  // 商店 API 不支持服务端标签过滤,分页模式下每页仅少量匹配项会「看着不满一页」。
  // 标签筛选 + 分页模式时改用聚合池:批量并发拉服务端多页,把匹配项汇入本地池,
  // 每屏固定展示 POOL_PAGE 个匹配项;翻页按需继续聚合,直到拉完全库。

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
  const aggregating = computed(() => !!opts.tagFilter.value && PAGED_MODES.includes(mode.value))
  /** 聚合池的客户端页数(未拉完时持续增长,展示时加 + 号) */
  const poolPages = computed(() => Math.max(1, Math.ceil(matchPool.value.length / POOL_PAGE)))

  /** 当前展示的资产列表:搜索词非空时优先显示搜索结果;标签/兼容筛选在客户端应用 */
  const displayAssets = computed<MarketAsset[]>(() => {
    // 聚合模式:池内已按标签过滤,直接按客户端页码切片(每屏凑满匹配项)
    if (aggregating.value && !opts.query.value.trim()) {
      const start = (pageNum.value - 1) * POOL_PAGE
      let list = matchPool.value.slice(start, start + POOL_PAGE)
      if (opts.compatOnly.value) list = list.filter((a) => opts.compatOf(a) !== false)
      return list
    }
    let list: MarketAsset[]
    if (opts.query.value.trim()) list = opts.results.value
    else if (mode.value === 'all') list = all.value
    else if (mode.value === 'projects') list = projectList.value
    else if (mode.value === 'new') list = fresh.value
    else if (mode.value === 'recent') list = recent.value
    else if (mode.value === 'favorites') list = favorites.value
    else list = featured.value
    const slugs = tagSlugsOf(opts.tagFilter.value)
    if (slugs) list = list.filter((a) => inGroup(a, slugs))
    if (opts.compatOnly.value) list = list.filter((a) => opts.compatOf(a) !== false)
    return list
  })

  /** 按当前模式拉取服务端指定页(全部/模板/新品/最近更新共用) */
  function fetchPage(page: number) {
    if (mode.value === 'all') return window.services.listAllAssets(page)
    if (mode.value === 'projects') return window.services.listProjectAssets(page)
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
    const slugs = tagSlugsOf(opts.tagFilter.value)
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
          const matched = slugs ? r.result.filter((a) => inGroup(a, slugs)) : r.result
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
    opts.hydrate(matchPool.value.slice(start, start + POOL_PAGE))
  }

  /** 只刷新本地收藏列表(收藏/取消收藏后调用) */
  async function reloadFavorites() {
    favorites.value = await window.services.listFavorites()
    opts.hydrate(favorites.value)
  }

  /** 加载当前模式的数据(推荐只拉一次;全部/模板/新品/最近更新按页;收藏读本地) */
  async function loadBrowse(): Promise<void> {
    if (mode.value === 'favorites') {
      reloadFavorites()
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
        opts.hydrate(featured.value)
      } else if (mode.value === 'all') {
        const r = await window.services.listAllAssets(pageNum.value)
        all.value = r.result
        pageTotal.value = r.pages
        opts.hydrate(all.value)
      } else if (mode.value === 'projects') {
        const r = await window.services.listProjectAssets(pageNum.value)
        projectList.value = r.result
        pageTotal.value = r.pages
        opts.hydrate(projectList.value)
      } else if (mode.value === 'new') {
        const r = await window.services.listNewAssets(pageNum.value)
        fresh.value = r.result
        pageTotal.value = r.pages
        opts.hydrate(fresh.value)
      } else if (mode.value === 'recent') {
        const r = await window.services.listRecentlyUpdated(pageNum.value)
        recent.value = r.result
        pageTotal.value = r.pages
        opts.hydrate(recent.value)
      }
    } catch (e: any) {
      browseError.value = e?.message || String(e)
    } finally {
      browsing.value = false
    }
  }

  /** 切换浏览模式(会清空搜索关键词,回到浏览语义) */
  function switchMode(m: BrowseMode) {
    opts.query.value = ''
    if (mode.value === m) return
    mode.value = m
    pageNum.value = 1
    loadBrowse()
  }

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
  watch(opts.tagFilter, (_nv, ov) => {
    const wasAgg = !!ov && PAGED_MODES.includes(mode.value)
    if (aggregating.value) {
      resetPool()
      fillPool(POOL_PAGE).then(hydrateScreen)
    } else if (wasAgg) {
      pageNum.value = 1
      loadBrowse()
    }
  })

  return {
    // 状态
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
    // 派生
    aggregating,
    displayAssets,
    // 动作
    switchMode,
    changePage,
    loadBrowse,
    resetPool,
    reloadFavorites,
    hydrateScreen
  }
}
