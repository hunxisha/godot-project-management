// 跨项目的资产/插件更新巡检:逐项目扫描已装内容,汇总「谁有新版本」。
// 检查本身复用单项目的 checkAddonUpdate(网络请求受其内部节奏约束),
// 项目之间串行推进,避免一次性打出太多请求。
import { ref } from 'vue'

export interface UpdateScanRow {
  projectId: string
  projectName: string
  dirName: string
  name: string
  assetId?: string
  kind: 'addon' | 'asset'
  current?: string
  latest: string
}

export interface ScanProjectInput {
  id: string
  name: string
}

export function useUpdateScan() {
  const scanning = ref(false)
  /** 扫描进度文案,如 "3/8" */
  const progress = ref('')
  const rows = ref<UpdateScanRow[]>([])
  /** 是否完成过一次扫描(区分「还没扫」与「没有可更新」) */
  const scanned = ref(false)

  async function scanAll(projects: ScanProjectInput[]) {
    if (scanning.value) return
    scanning.value = true
    rows.value = []
    scanned.value = false
    try {
      for (let i = 0; i < projects.length; i++) {
        const p = projects[i]
        progress.value = `${i + 1}/${projects.length}`
        const addons = window.services.listAddons(p.id) || []
        const jobs = addons.filter((a) => a.fromMarket && a.assetId)
        await Promise.all(
          jobs.map(async (a) => {
            try {
              const r = await window.services.checkAddonUpdate({ projectId: p.id, assetId: a.assetId! })
              if (r.hasUpdate) {
                rows.value.push({
                  projectId: p.id,
                  projectName: p.name,
                  dirName: a.dirName,
                  name: a.name,
                  assetId: a.assetId,
                  kind: a.kind === 'asset' ? 'asset' : 'addon',
                  current: a.versionString,
                  latest: r.latest || ''
                })
              }
            } catch (e) {
              // 单个资产检查失败不中断整体巡检
            }
          })
        )
      }
      scanned.value = true
    } finally {
      scanning.value = false
      progress.value = ''
    }
  }

  return { scanning, progress, rows, scanned, scanAll }
}
