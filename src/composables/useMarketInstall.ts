// 市场插件安装:安装进度、已安装集合、版本选择器。
//
// 从 MarketplaceView.vue 抽出。安装是唯一会写目标项目目录的操作,它的进度回调必须按
// assetId 配对(否则并发/切换资产时进度会串到别的卡片上),这条约束原本只体现在一个
// 内联判断里,现在独立成模块并配了断言。
import { computed, ref, type Ref } from 'vue'
import { useInstallProgress } from './useInstallProgress'
import type { AddonInfo, MarketAsset } from '../types/godot'

export interface UseMarketInstallOptions {
  /** 安装目标项目 */
  targetId: Ref<string>
  /** 目标项目已装插件(用于算「已安装」) */
  addons: Ref<AddonInfo[]>
  /** 安装成功后刷新已装插件 */
  reloadAddons: () => void
  /** 用户提示 */
  notify: (msg: string) => void
}

export function useMarketInstall(opts: UseMarketInstallOptions) {
  // 进度状态与阶段文案统一由 useInstallProgress 提供(与「更新」「切换版本」共用同一实现)
  const { progress: installing, percent, begin, onProgress, end, busy } = useInstallProgress()

  /** 目标项目已安装的市场资产 ID */
  const installedIds = computed(
    () => new Set(opts.addons.value.filter((a) => a.fromMarket && a.assetId).map((a) => a.assetId!))
  )

  /** 安装插件;version 指定 release 版本(版本选择器),缺省为最新 */
  async function install(asset: MarketAsset, version?: string): Promise<void> {
    if (!opts.targetId.value || busy()) return
    begin(asset.assetId)
    const r = await window.services.installAsset(
      {
        projectId: opts.targetId.value,
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
      (p) => onProgress(asset.assetId, p)
    )
    end()
    if (r.ok) {
      opts.notify(`已安装 ${r.addon?.title}${version ? ` ${r.addon?.versionString}` : ''}${r.addon?.enabled ? '(已启用)' : ''}`)
      opts.reloadAddons()
    } else {
      opts.notify(r.error || '安装失败')
    }
  }

  // ---------- 版本选择器 ----------

  /** 只保留「要选哪个资产」;release 列表与加载态由对话框自己管 */
  const picker = ref<{ asset: MarketAsset } | null>(null)

  function openPicker(a: MarketAsset) {
    if (busy()) return
    picker.value = { asset: a }
  }

  /** 从版本选择器安装指定版本 */
  function installFromPicker(version: string) {
    const a = picker.value?.asset
    if (!a || busy()) return
    picker.value = null
    install(a, version)
  }

  return {
    installing,
    installedIds,
    picker,
    install,
    openPicker,
    installFromPicker,
    percent
  }
}
