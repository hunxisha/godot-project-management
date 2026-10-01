// 已装插件的各类操作:批量启停/卸载、单个启停/卸载、检查更新、更新、切换历史版本、复制到其他项目。
//
// 从 AddonsView.vue 抽出(该视图脚本 290 行,这块占了大半)。抽出后可以断言几件原本
// 只靠人工点的事:
//   · 批量启停**只处理需要变更的项**(已是目标状态的跳过),并按实际成功数报告
//   · 卸载/批量卸载的二次确认语义
//   · 更新与切换版本共用同一套进度状态,且成功后让「可更新」判断作废
//   · 复制到其他项目时把 skipped / adopted 如实带进提示文案
import { computed, ref, type Ref } from 'vue'
import { useInstallProgress } from './useInstallProgress'
import type { useAddonSelection } from './useAddonSelection'
import type { ProjectRow } from './useProjectList'
import type { AddonInfo } from '../types/godot'

export interface UseAddonActionsOptions {
  targetId: Ref<string>
  projects: Ref<ProjectRow[]>
  addons: Ref<AddonInfo[]>
  selection: ReturnType<typeof useAddonSelection>
  reload: () => void
  notify: (msg: string) => void
  /** 单个卸载的「待确认」自动解除时长;测试可传极小值 */
  confirmMs?: number
}

export function useAddonActions(opts: UseAddonActionsOptions) {
  const confirmMs = opts.confirmMs ?? 2500
  const { checked, selAddons, confirmingBatch, clear, armBatchConfirm, disarmBatchConfirm } = opts.selection
  const { progress: updating, begin, onProgress, end, busy } = useInstallProgress()

  function projectId(): string {
    return opts.targetId.value
  }

  // ---------- 批量启用 / 禁用 ----------

  async function batchToggle(enabled: boolean) {
    const dirs = selAddons.value
      .filter((a) => a.hasCfg && a.enabled !== enabled)
      .map((a) => a.dirName)
    if (!dirs.length) {
      opts.notify(enabled ? '所选插件均已启用' : '所选插件均已禁用')
      return
    }
    let n = 0
    for (const d of dirs) {
      const r = await window.services.setAddonEnabled({ projectId: projectId(), dirName: d, enabled })
      if (r.ok) n++
    }
    opts.reload()
    opts.notify(`已${enabled ? '启用' : '禁用'} ${n} 个插件`)
  }

  // ---------- 批量卸载(二次确认) ----------

  async function batchUninstall() {
    if (!confirmingBatch.value) {
      armBatchConfirm()
      return
    }
    disarmBatchConfirm()
    const dirs = [...checked.value]
    let n = 0
    const failed: string[] = []
    for (const d of dirs) {
      const r = await window.services.uninstallAddon({
        projectId: projectId(),
        dirName: d,
        // 素材条目凭 assetId 走安装清单删除;插件条目 assetId 缺省不影响原逻辑
        assetId: selAddons.value.find((a) => a.dirName === d)?.assetId
      })
      if (r.ok) n++
      else failed.push(d)
    }
    clear()
    opts.reload()
    opts.notify(
      failed.length ? `已卸载 ${n} 个,失败 ${failed.length} 个(${failed.join('、')})` : `已卸载 ${n} 个插件`
    )
  }

  // ---------- 单个启用 / 卸载(卸载同样二次确认) ----------

  async function toggleEnabled(a: AddonInfo) {
    const r = await window.services.setAddonEnabled({
      projectId: projectId(),
      dirName: a.dirName,
      enabled: !a.enabled
    })
    if (r.ok) opts.reload()
    else opts.notify(r.error || '操作失败')
  }

  const confirmingDir = ref<string | null>(null)
  let dirTimer: ReturnType<typeof setTimeout> | null = null

  async function uninstall(a: AddonInfo) {
    if (confirmingDir.value === a.dirName) {
      if (dirTimer) {
        clearTimeout(dirTimer)
        dirTimer = null
      }
      confirmingDir.value = null
      const r = await window.services.uninstallAddon({ projectId: projectId(), dirName: a.dirName, assetId: a.assetId })
      if (r.ok) opts.reload()
      else opts.notify(r.error || '卸载失败')
      return
    }
    confirmingDir.value = a.dirName
    if (dirTimer) clearTimeout(dirTimer)
    dirTimer = setTimeout(() => {
      if (confirmingDir.value === a.dirName) confirmingDir.value = null
    }, confirmMs)
  }

  // ---------- 复制到其他项目 ----------

  const showCopy = ref(false)
  const copyTargetId = ref('')
  const copying = ref(false)

  /** 可作为复制目标的项目(排除当前项目) */
  const copyTargets = computed(() => opts.projects.value.filter((p) => p._id !== opts.targetId.value))

  function openCopy() {
    if (!checked.value.length) return
    copyTargetId.value = copyTargets.value[0]?._id || ''
    showCopy.value = true
  }

  async function confirmCopy() {
    if (!copyTargetId.value || copying.value) return
    copying.value = true
    // 选中项分区:插件按目录复制,素材按安装清单逐文件复制
    const rows = selAddons.value.filter((a) => checked.value.includes(a.dirName))
    const addonDirs = rows.filter((a) => a.kind !== 'asset').map((a) => a.dirName)
    const assetIds = rows.filter((a) => a.kind === 'asset' && a.assetId).map((a) => a.assetId!)
    let copied = 0
    /** @type {string[]} */
    const skipped: string[] = []
    let adopted = 0
    let targetName = ''
    if (addonDirs.length) {
      const r = await window.services.copyAddonsToProject({
        sourceProjectId: projectId(),
        dirNames: addonDirs,
        targetProjectId: copyTargetId.value
      })
      if (!r.ok) {
        copying.value = false
        opts.notify(r.error || '复制失败')
        return
      }
      copied += r.copied || 0
      skipped.push(...(r.skipped || []))
      adopted += r.adopted || 0
      targetName = r.targetName || ''
    }
    for (const assetId of assetIds) {
      const r = await window.services.copyAssetToProject({
        sourceProjectId: projectId(),
        assetId,
        targetProjectId: copyTargetId.value
      })
      if (r.ok) {
        copied += r.copied || 0
        skipped.push(...(r.skipped || []))
        if (!targetName) targetName = opts.projects.value.find((p) => p._id === copyTargetId.value)?.name || ''
      } else {
        skipped.push(`${assetId}(${r.error})`)
      }
    }
    copying.value = false
    showCopy.value = false
    const noun = assetIds.length ? '项' : '个插件'
    const skippedNote = skipped.length ? `,跳过:${skipped.join('、')}` : ''
    const adoptedNote = adopted ? `,其中 ${adopted} 个已补回市场来源` : ''
    opts.notify(`已复制 ${copied} ${noun}到「${targetName}」${skippedNote}${adoptedNote}`)
  }

  // ---------- 检查更新 / 更新 ----------

  const checking = ref(false)
  const updateInfo = ref<Record<string, { hasUpdate: boolean, latest?: string }>>({})

  async function checkUpdates() {
    if (!projectId() || checking.value) return
    checking.value = true
    const jobs = opts.addons.value.filter((a) => a.fromMarket && a.assetId)
    const next: Record<string, { hasUpdate: boolean, latest?: string }> = {}
    try {
      await Promise.all(
        jobs.map(async (a) => {
          const r = await window.services.checkAddonUpdate({ projectId: projectId(), assetId: a.assetId! })
          if (r.hasUpdate) next[a.dirName] = { hasUpdate: true, latest: r.latest }
        })
      )
    } finally {
      checking.value = false
    }
    updateInfo.value = next
    const count = Object.keys(next).length
    opts.notify(count ? `${count} 个插件有新版本` : '所有插件均为最新版本')
  }

  async function update(a: AddonInfo) {
    if (!projectId() || !a.assetId || busy()) return
    begin(a.assetId)
    const r = await window.services.updateAsset(
      { projectId: projectId(), assetId: a.assetId },
      (p) => onProgress(a.assetId!, p)
    )
    end()
    if (r.ok) {
      opts.notify(`${a.name} 已更新到 ${r.addon?.versionString}`)
      opts.reload()
      checkUpdates()
    } else {
      opts.notify(r.error || '更新失败')
    }
  }

  // ---------- 切换历史版本(覆盖安装) ----------

  const versionTarget = ref<AddonInfo | null>(null)

  function openVersions(a: AddonInfo) {
    if (!a.assetId || busy()) return
    versionTarget.value = a
  }

  async function installVersion(version: string) {
    const a = versionTarget.value
    versionTarget.value = null
    if (!projectId() || !a?.assetId || busy()) return
    begin(a.assetId)
    const r = await window.services.installAsset(
      {
        projectId: projectId(),
        assetId: a.assetId,
        version,
        assetMeta: { title: a.name, storeUrl: a.storeUrl }
      },
      (p) => onProgress(a.assetId!, p)
    )
    end()
    if (r.ok) {
      opts.notify(`${a.name} 已切换到 ${r.addon?.versionString || version}`)
      // 版本变了,之前的「可更新」判断作废
      updateInfo.value = {}
      opts.reload()
    } else {
      opts.notify(r.error || '版本切换失败')
    }
  }

  return {
    updating,
    checking,
    updateInfo,
    versionTarget,
    confirmingDir,
    showCopy,
    copyTargetId,
    copying,
    copyTargets,
    openCopy,
    confirmCopy,
    batchToggle,
    batchUninstall,
    toggleEnabled,
    uninstall,
    checkUpdates,
    update,
    openVersions,
    installVersion
  }
}
