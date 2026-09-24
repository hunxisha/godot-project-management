// 安装/更新/切版本共用的进度状态。
//
// 原实现:同一段「百分比换算 + 进度回调 → 阶段文案」在三个地方各写了一遍 ——
// useMarketInstall(市场安装)、AddonsView 的 update(更新)、installVersion(切换版本),
// 而且三处的文案格式必须完全一致,否则同一个下载过程在不同入口显示不同措辞。
// 这里合成唯一实现,并把「按 assetId 配对」这条约束固定下来(切换卡片时不会串进度)。
import { ref } from 'vue'
import { fmtSize } from '../utils/format'

/** 安装进度:assetId 用于把进度对回到对应的卡片/插件 */
export interface InstallProgress {
  assetId: string
  percent: number
  stage: string
}

/** preload 侧 installAsset/updateAsset 的进度回调载荷 */
export interface InstallProgressPayload {
  stage?: string
  received?: number
  total?: number
}

export function useInstallProgress() {
  const progress = ref<InstallProgress | null>(null)

  /** `{received,total}` → 0~100,total 缺失时按 0(不做除零) */
  function percent(p: { received?: number, total?: number }): number {
    if (!p.total) return 0
    return Math.min(100, ((p.received || 0) / p.total) * 100)
  }

  /** 开始一次安装/更新/切版本 */
  function begin(assetId: string) {
    progress.value = { assetId, percent: 0, stage: '下载中' }
  }

  /**
   * 进度回调 → 状态。**只接受发起时那个 assetId 的回调**,
   * 否则并发安装或切换卡片时进度会画到别的条目上。
   * @returns 是否被接受
   */
  function onProgress(assetId: string, p: InstallProgressPayload): boolean {
    const cur = progress.value
    if (!cur || cur.assetId !== assetId) return false
    if (p.stage === 'downloading') {
      progress.value = { assetId, percent: percent(p), stage: `下载中 ${fmtSize(p.received)}` }
    } else {
      progress.value = { assetId, percent: 100, stage: '解压中' }
    }
    return true
  }

  /** 结束(成功或失败都要调,否则界面会一直停在进度条上) */
  function end() {
    progress.value = null
  }

  /** 是否正有一次安装在进行(用于并发保护与按钮禁用) */
  function busy(): boolean {
    return !!progress.value
  }

  return { progress, percent, begin, onProgress, end, busy }
}
