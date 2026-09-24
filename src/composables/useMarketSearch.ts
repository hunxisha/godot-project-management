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
}

export function useMarketSearch(opts: UseMarketSearchOptions) {
  const debounceMs = opts.debounceMs ?? 400

  const query = ref('')
  const searching = ref(false)
  const searchError = ref('')
  const results = ref<MarketAsset[]>([])
  /** 已完成过一次搜索(用来区分「防抖等待中」与「确实没有结果」) */
  const hasSearched = ref(false)

  let timer: ReturnType<typeof setTimeout> | null = null

  function cancelPending() {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  async function search() {
    searching.value = true
    searchError.value = ''
    try {
      const r = await window.services.searchAssets(query.value.trim())
      results.value = r.result
      await opts.hydrate(results.value)
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
    cancelPending()
    search()
  }

  /** 清空关键词即回到浏览模式 */
  function reset() {
    results.value = []
    searchError.value = ''
    hasSearched.value = false
  }

  // 输入防抖自动搜索
  watch(query as Ref<string>, () => {
    cancelPending()
    if (!query.value.trim()) {
      reset()
      return
    }
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
    search,
    onSearchEnter,
    /** 关键词是否非空(视图用来决定「显示搜索结果还是浏览列表」) */
    isSearching: () => !!query.value.trim(),
    cancelPending,
    reset
  }
}
