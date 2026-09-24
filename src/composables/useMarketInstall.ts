// 市场插件安装:安装进度、已安装集合、版本选择器。
//
// 从 MarketplaceView.vue 抽出。安装是唯一会写目标项目目录的操作,它的进度回调必须按
// assetId 配对(否则并发/切换资产时进度会串到别的卡片上),这条约束原本只体现在一个
// 内联判断里,现在独立成模块并配了断言。
import { computed, ref, type Ref } from 'vue'
import { fmtSize } from '../utils/format'
import type { AddonInfo, MarketAsset } from '../types/godot'

/** 安装中的进度(assetId 用于把进度对回到对应卡片) */
export interface InstallProgress {
  assetId: string
  percent: number
  stage: string
}

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
  const installing = ref<InstallProgress | null>(null)

  /** 目标项目已安装的市场资产 ID */
  const installedIds = computed(
    () => new Set(opts.addons.value.filter((a) => a.fromMarket && a.assetId).map((a) => a.assetId!))
  )

  function percent(p: { received?: number, total?: number }): number {
    if (!p.total) return 0
    return Math.min(100, ((p.received || 0) / p.total) * 100)
  }

  /** 安装插件;version 指定 release 版本(版本选择器),缺省为最新 */
  async function install(asset: MarketAsset, version?: string): Promise<void> {
    if (!opts.targetId.value || installing.value) return
    installing.value = { assetId: asset.assetId, percent: 0, stage: '下载中' }
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
      (p) => {
        // 进度只回填给发起安装的那个资产(装机过程中切卡片不会串进度)
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
