// 市场资产信息补齐:为列表里的资产拉取最新 release 信息(版本号 / 兼容范围 / 发布日期)。
//
// 从 MarketplaceView.vue 抽出。原来的注释已经写明它有一条重要约束 ——
// **只拉尚未填充过的资产**,聚合模式翻屏时靠这一点避免重复请求;这条约束值得独立存在
// 并有断言守着,而不是埋在一个 1,100 行的视图里。
import type { MarketAsset } from '../types/godot'

export function useAssetHydration() {
  /**
   * 就地补齐资产的 versionString / minGodot / maxGodot / releaseCreated。
   * 拉取失败时静默跳过(不能因为补充信息拿不到就让列表显示不出来)。
   */
  async function hydrateVersions(list: MarketAsset[]): Promise<void> {
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

  return { hydrateVersions }
}
