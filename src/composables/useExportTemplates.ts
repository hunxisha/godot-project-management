// 已装引擎的导出模板状态与操作:状态查询、下载安装、卸载(二次确认)。
//
// 从 VersionsView.vue 抽出(与 useProjectActions/useAddonActions 同一套拆分惯例):
// 状态是每台引擎一次的同步查询(preload 读库 + existsSync),任务终态后由视图调用
// refreshTplStatuses 刷新。
import { ref, type Ref } from 'vue'
import type { DownloadTask, GodotVersion } from '../types/godot'

export interface TemplateStatus {
  installed: boolean
  versionDir: string
  path: string
}

export interface UseExportTemplatesOptions {
  installed: Ref<(GodotVersion & { _id: string })[]>
  tasks: Ref<DownloadTask[]>
  notify: (msg: string) => void
}

export function useExportTemplates(opts: UseExportTemplatesOptions) {
  const tplStatuses = ref<Record<string, TemplateStatus>>({})
  const confirmingTplId = ref<string | null>(null)
  let tplTimer: ReturnType<typeof setTimeout> | null = null

  /** 该引擎是否有进行中的模板任务(排队/下载/解压/校验) */
  function tplTaskFor(versionId: string): DownloadTask | undefined {
    return opts.tasks.value.find(
      (t) => t.kind === 'templates' && t.versionId === versionId && !['error', 'canceled', 'done'].includes(t.status)
    )
  }

  function refreshTplStatuses() {
    const next: Record<string, TemplateStatus> = {}
    for (const v of opts.installed.value) next[v._id] = window.services.exportTemplateStatus(v._id)
    tplStatuses.value = next
  }

  function installTemplates(v: GodotVersion & { _id: string }) {
    const r = window.services.installExportTemplates(v._id)
    if (!r.ok) opts.notify(r.error || '下载失败')
  }

  function askUninstallTemplates(v: GodotVersion & { _id: string }) {
    if (confirmingTplId.value === v._id) {
      confirmingTplId.value = null
      if (tplTimer) {
        clearTimeout(tplTimer)
        tplTimer = null
      }
      const r = window.services.uninstallExportTemplates(v._id)
      if (r.ok) refreshTplStatuses()
      else opts.notify(r.error || '卸载失败')
      return
    }
    confirmingTplId.value = v._id
    if (tplTimer) clearTimeout(tplTimer)
    tplTimer = setTimeout(() => {
      if (confirmingTplId.value === v._id) confirmingTplId.value = null
    }, 2500)
  }

  return {
    tplStatuses,
    confirmingTplId,
    tplTaskFor,
    refreshTplStatuses,
    installTemplates,
    askUninstallTemplates
  }
}
