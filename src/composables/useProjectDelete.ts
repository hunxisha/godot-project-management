// 删除项目确认:弹窗状态、是否同时删文件、执行与本地摘除。
//
// 从 ProjectsView.vue 抽出。这是项目页唯一的破坏性操作,而「是否删除磁盘文件」的判定
// 由全局设置(ask/always/never)与弹窗勾选共同决定 —— 三种组合都值得断言,抽出来才能测。
import { ref, type Ref } from 'vue'
import type { ProjectRow } from './useProjectList'

/** 与 GodotSettings.deleteProjectFiles 同形 */
export type DeleteFilesPolicy = 'ask' | 'always' | 'never'

export interface UseProjectDeleteOptions {
  projects: Ref<ProjectRow[]>
  /** 全局设置:删除项目时如何处理文件 */
  policy?: DeleteFilesPolicy
  notify: (msg: string) => void
  /** 删除成功后从本地列表摘掉该项 */
  dropLocal: (id: string) => void
}

export function useProjectDelete(opts: UseProjectDeleteOptions) {
  const showDelete = ref(false)
  const deleteTarget = ref<ProjectRow | null>(null)
  const delFiles = ref(false)
  const deleting = ref(false)

  /** 弹出确认框;策略为「总是删除」时默认勾选 */
  function askDelete(p: ProjectRow) {
    deleteTarget.value = p
    delFiles.value = opts.policy === 'always'
    showDelete.value = true
  }

  /** 实际是否连带删除磁盘文件 */
  function willDeleteFiles(): boolean {
    return opts.policy !== 'never' && delFiles.value
  }

  function confirmDelete() {
    const p = deleteTarget.value
    if (!p || deleting.value) return
    deleting.value = true
    const deleteFiles = willDeleteFiles()
    const r = window.services.removeProject(p._id, deleteFiles)
    deleting.value = false
    if (!r.ok) {
      opts.notify(r.error || '删除失败')
      return
    }
    showDelete.value = false
    opts.dropLocal(p._id)
    opts.notify(deleteFiles ? `已删除项目及文件(回收站):${p.name}` : `已移除项目记录:${p.name}`)
  }

  return {
    showDelete,
    deleteTarget,
    delFiles,
    deleting,
    askDelete,
    willDeleteFiles,
    confirmDelete
  }
}
