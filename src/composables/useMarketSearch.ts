// 市场搜索:关键词防抖、请求状态、结果列表、回车立即搜索。
//
// 从 MarketplaceView.vue 抽出(模板里搜索框的 v-model、结果列表与空态判断都还留在视图,
// 这里只管「查什么、查到没有、正在查吗」)。补全 release 信息的能力由调用方注入,
// 因为浏览模式也要用同一份 hydrateVersions。
import { getCurrentInstance, onBeforeUnmount, ref, watch, type Ref } from 'vue'
import type { MarketAsset } from '../types/godot'

export interface UseMarketSearchOptions {
  /** 拉取完成后的信息补齐(与浏览模式共用同一实现) */
  hydrate: (list: MarketAsset[]) => void | Promise<void>
  /** 输入防抖时长,默认 400ms */
  debounceMs?: number
  /** 当前商店资产类型(0=插件/素材,1=完整项目);模板模式下搜索应查 type=1 */
  getAssetType?: () => number
}

export function useMarketSearch(opts: UseMarketSearchOptions) {
  const debounceMs = opts.debounceMs ?? 400

  const query = ref('')
  const searching = ref(false)
  const searchError = ref('')
  const results = ref<MarketAsset[]>([])
  /** 已完成过一次搜索(用来区分「防抖等待中」与「确实没有结果」) */
  const hasSearched = ref(false)
  /** 当前搜索页(服务端分页,每页 20) */
  const page = ref(1)
  /** 服务端返回的总页数 */
  const pages = ref(1)

  let timer: ReturnType<typeof setTimeout> | null = null
  /** 搜索序号:回车立即搜索与防抖搜索可能并发,旧请求晚到时不得覆盖新结果 */
  let seq = 0

  function cancelPending() {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  async function search() {
    const mySeq = ++seq
    searching.value = true
    searchError.value = ''
    try {
      const assetType = opts.getAssetType?.() ?? 0
      const r = await window.services.searchAssets(query.value.trim(), undefined, page.value, assetType)
      if (mySeq !== seq) return
      results.value = r.result
      pages.value = r.pages || 1
      await opts.hydrate(results.value)
    } catch (e: any) {
      if (mySeq !== seq) return
      searchError.value = e?.message || String(e)
    } finally {
      if (mySeq === seq) {
        searching.value = false
        hasSearched.value = true
      }
    }
  }

  /** 回车立即搜索(绕过防抖;回到第 1 页) */
  function onSearchEnter() {
    if (!query.value.trim()) return
    cancelPending()
    page.value = 1
    search()
  }

  /** 翻页(上一页/下一页,立即请求当前关键词对应页) */
  function changePage(delta: number) {
    const next = page.value + delta
    if (!query.value.trim() || next < 1 || next > pages.value) return
    page.value = next
    cancelPending()
    search()
  }

  /** 清空关键词即回到浏览模式 */
  function reset() {
    results.value = []
    searchError.value = ''
    hasSearched.value = false
    page.value = 1
    pages.value = 1
  }

  // 输入防抖自动搜索;换词回到第 1 页
  watch(query as Ref<string>, () => {
    cancelPending()
    if (!query.value.trim()) {
      reset()
      return
    }
    page.value = 1
    timer = setTimeout(search, debounceMs)
  })

  // 组件卸载时清掉未触发的防抖定时器;组件外使用(回归测试)时跳过
  if (getCurrentInstance()) onBeforeUnmount(cancelPending)

  return {
    query,
    searching,
    searchError,
    results,
    hasSearched,
    page,
    pages,
    search,
    onSearchEnter,
    changePage,
    /** 关键词是否非空(视图用来决定「显示搜索结果还是浏览列表」) */
    isSearching: () => !!query.value.trim(),
    cancelPending,
    reset
  }
}
