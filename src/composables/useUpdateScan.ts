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
  /**
   * 首个「根本没查成」的原因(桌面版没有 check_addon_update 命令,宿主会回 error)。
   * 空列表有两种含义:真的都是最新 / 一条都没查。少了这个字段,巡检面板就会把后者说成
   * 「所有项目的已装内容都是最新版本」—— 那是一句结论,不是这里得到的东西。
   */
  const blocked = ref('')

  async function scanAll(projects: ScanProjectInput[]) {
    if (scanning.value) return
    scanning.value = true
    rows.value = []
    blocked.value = ''
    scanned.value = false
    try {
      for (let i = 0; i < projects.length; i++) {
        const p = projects[i]
        progress.value = `${i + 1}/${projects.length}`
        const addons = (await window.services.listAddons(p.id)) || []
        const jobs = addons.filter((a) => a.fromMarket && a.assetId)
        await Promise.all(
          jobs.map(async (a) => {
            try {
              const r = await window.services.checkAddonUpdate({ projectId: p.id, assetId: a.assetId! })
              // error 优先于 hasUpdate:false:宿主明说没查成时,这条不能计成「已确认是最新」
              if (r.error) {
                if (!blocked.value) blocked.value = r.error
              } else if (r.hasUpdate) {
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
              // 单个资产检查失败不中断整体巡检,但原因要留一份:否则空列表会被读成「都是最新」
              if (!blocked.value) blocked.value = String((e as any)?.message || e)
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

  return { scanning, progress, rows, scanned, blocked, scanAll }
}
