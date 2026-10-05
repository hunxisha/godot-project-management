// 已装引擎的导出模板状态与操作:状态查询、下载安装、卸载(二次确认)。
//
// 从 VersionsView.vue 抽出(与 useProjectActions/useAddonActions 同一套拆分惯例):
// 状态是每台引擎一次的同步查询(preload 读库 + existsSync),任务终态后由视图调用
// refreshTplStatuses 刷新。
import { ref, type Ref } from 'vue'
import { pickFile } from '../services/bridge'
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

  async function refreshTplStatuses() {
    const next: Record<string, TemplateStatus> = {}
    for (const v of opts.installed.value) next[v._id] = await window.services.exportTemplateStatus(v._id)
    tplStatuses.value = next
  }

  async function installTemplates(v: GodotVersion & { _id: string }) {
    const r = await window.services.installExportTemplates(v._id)
    if (!r.ok) opts.notify(r.error || '下载失败')
  }

  /**
   * 本地导入(自编译 / 第三方 .tpz)的两步状态机:先选文件,再确认目标目录名。
   * 目录名默认取状态查询给的那个值(status 与安装共用「记录优先、tag 派生兜底」同一条取法,
   * 所以这个默认值就是「什么都不改会装到哪」),用户可改成自编译引擎真正的版本串 ——
   * 编辑器按版本串在固定位置查找,装错名字等于白装(待确认 #10,界面提示一句)。
   */
  const localImport = ref<{ versionId: string; srcPath: string; dirName: string } | null>(null)

  async function startLocalImport(v: GodotVersion & { _id: string }) {
    const src = await pickFile('选择导出模板包(.tpz)', ['tpz'])
    if (!src) return
    const dft = tplStatuses.value[v._id]?.versionDir || String(v.tag || '').replace(/-/g, '.')
    localImport.value = { versionId: v._id, srcPath: src, dirName: dft }
  }

  function cancelLocalImport() {
    localImport.value = null
  }

  async function confirmLocalImport() {
    const li = localImport.value
    if (!li) return
    // 与宿主白名单(is_valid_version_dir_name / templates.js 的同一规则)镜像:
    // 目录名会被 join 到数据目录下,放行分隔符与 .. 等于允许把模板装到任意位置
    const name = li.dirName.trim()
    if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/.test(name)) {
      opts.notify('模板目录名不合法:只允许字母数字、点、下划线、连字符')
      return
    }
    localImport.value = null
    const r = await window.services.installExportTemplates(li.versionId, { srcPath: li.srcPath, versionDir: name })
    if (!r.ok) opts.notify(r.error || '导入失败')
    // 入队成功不刷新状态:任务终态后视图的既有回调(watch tasks)会 refreshTplStatuses
  }

  async function askUninstallTemplates(v: GodotVersion & { _id: string }) {
    if (confirmingTplId.value === v._id) {
      confirmingTplId.value = null
      if (tplTimer) {
        clearTimeout(tplTimer)
        tplTimer = null
      }
      const r = await window.services.uninstallExportTemplates(v._id)
      if (r.ok) await refreshTplStatuses()
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
    localImport,
    tplTaskFor,
    refreshTplStatuses,
    installTemplates,
    startLocalImport,
    confirmLocalImport,
    cancelLocalImport,
    askUninstallTemplates
  }
}
