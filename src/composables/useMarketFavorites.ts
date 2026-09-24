// 市场收藏:星标状态与收藏/取消收藏动作。
//
// 从 MarketplaceView.vue 抽出。抽出来的直接原因是这里踩过一个只有宿主才能暴露的坑:
//
//   **跨层调用必须传纯数据。** `window.services.*` 是 contextBridge 暴露的,
//   它克隆不了 Vue 的响应式对象(Proxy)。把资产对象原样传过去,Electron 会直接抛
//   `An object could not be cloned.` —— 点击在进入 preload 之前就失败了,
//   于是既不写库、也没有任何线索。表现就是「点收藏没反应」,而取消收藏、
//   安装(传的是新建的纯对象)都正常。
//
// 所以这里统一经 `toBridgeData()` 把入参拍平成纯 JSON 数据;它同时让嵌套数组
// (如 tagSlugs)也脱离响应式代理,而收藏本来就要序列化落库,不存在信息损失。
import { computed, ref, type Ref } from 'vue'
import type { FavoriteAsset, MarketAsset } from '../types/godot'

/**
 * 拍平成纯数据,用于跨层传参。
 * 不要用 `{ ...obj }` 代替:浅拷贝只能脱掉最外层的代理,嵌套数组/对象仍是 Proxy。
 */
export function toBridgeData<T>(v: T): T {
  return JSON.parse(JSON.stringify(v))
}

export interface MarketFavoritesOpts {
  /** 浏览层的收藏列表(星标状态的唯一真相) */
  favorites: Ref<FavoriteAsset[]>
  /** 重新读库刷新上面那份列表 */
  reloadFavorites: () => void
  notify: (msg: string) => void
}

export function useMarketFavorites(opts: MarketFavoritesOpts) {
  /**
   * 已收藏的 assetId 集合。原先每张卡片的三处绑定各自调一次
   * `window.services.isFavorite()`,有两个问题:一是普通函数调用不是响应式依赖,
   * 收藏后星标能否重绘取决于组件是否恰好因别的原因重渲染;二是一屏 18 张卡片
   * 每次渲染就是 54 次跨层同步调用。改成从 favorites 派生后两个问题一起消失。
   */
  const favIds = computed(() => new Set(opts.favorites.value.map((f) => String(f.assetId))))

  /** 失败诊断:只在失败时非空,内容用于定位「点了没反应」到底卡在哪一步 */
  const favDiag = ref('')

  function isFav(id: string): boolean {
    return favIds.value.has(String(id))
  }

  /**
   * 收藏/取消收藏。
   * @returns 操作后是否处于「已收藏」状态(失败时为 false),与 Services.toggleFavorite 同语义
   */
  function toggleFav(asset: MarketAsset): boolean {
    const before = isFav(asset.assetId)
    favDiag.value = ''
    try {
      window.services.toggleFavorite(toBridgeData(asset))
    } catch (e) {
      // 跨层/写库失败:如实说出原因,不要静默
      favDiag.value = `收藏失败:${(e as any)?.message || String(e)}`
      opts.notify(favDiag.value)
      return false
    }
    opts.reloadFavorites()
    const after = isFav(asset.assetId)
    if (after === before) {
      // 没抛错但状态没变:写入既没报错也没生效,附上可核对的现场
      favDiag.value = `收藏未生效:assetId=${asset.assetId} 前=${before} 后=${after} 收藏数=${opts.favorites.value.length}`
      opts.notify('收藏失败,请重试')
      return false
    }
    opts.notify(after ? '已收藏 ' + asset.title : '已取消收藏')
    return after
  }

  return { favIds, isFav, toggleFav, favDiag }
}
