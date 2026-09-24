// 备份页的页面级动作:删除确认(含文案与明细)与「为未备份项目批量备份」。
//
// 从 BackupsView.vue 抽出。该页的列表/筛选/分组/巡检逻辑早已在 useBackups 里,视图剩下的是
// 各对话框的开关状态;其中只有这两块带真正的判断逻辑,值得单独存在并被断言:
//   · 删除确认的文案要区分「文件还在」与「文件已丢失」两种语义(后者只是清理数据库记录)
//   · 批量备份要知道有多少个未备份项目、并逐个串行报告进度
import { computed, ref, type Ref } from 'vue'
import { fmtSize } from '../utils/format'
import type { ProjectRow } from './useProjectList'
import type { BackupRecord } from '../types/godot'

export interface UseBackupPageActionsOptions {
  /** 尚未有任何备份的项目 */
  uncovered: Ref<ProjectRow[]>
  /** 当前勾选的备份记录(批量模式) */
  selectedRecords: Ref<BackupRecord[]>
  batchMode: Ref<boolean>
  exitBatch: () => void
  removeOne: (id: string) => unknown
  removeMany: (ids: string[]) => unknown
  backupMany: (
    projectIds: string[],
    onProgress?: (done: number, total: number, name: string) => void
  ) => Promise<{ ok: boolean, error?: string, count: number }>
  notify: (msg: string) => void
}

export function useBackupPageActions(opts: UseBackupPageActionsOptions) {
  // ---------- 删除确认 ----------

  const removeOpen = ref(false)
  const removeTargets = ref<BackupRecord[]>([])
  const removeBusy = ref(false)

  /** 待删除的备份文件全部已丢失(此时只是清理数据库记录) */
  const allMissing = computed(
    () => removeTargets.value.length > 0 && removeTargets.value.every((r) => r.missing)
  )

  /** 确认框正文:区分「删文件」与「只清记录」 */
  const removeMessage = computed(() => {
    const n = removeTargets.value.length
    const size = removeTargets.value.reduce((s, r) => s + (r.size || 0), 0)
    if (allMissing.value) {
      return n === 1
        ? '这份备份的文件已不存在,此操作只移除数据库里的记录。'
        : `这 ${n} 份备份的文件均已不存在,此操作只移除数据库里的记录。`
    }
    return n === 1
      ? `将删除这份备份(${fmtSize(size)})。Windows 下文件移入回收站可恢复,其他平台为永久删除。`
      : `将删除 ${n} 份备份,合计 ${fmtSize(size)}。Windows 下文件移入回收站可恢复,其他平台为永久删除。`
  })

  /** 确认框里的明细行(备份名 · 体积 · 路径) */
  const removeDetails = computed(() =>
    removeTargets.value.map((r) => `${r.label || r.projectName} · ${fmtSize(r.size)} · ${r.destPath}`)
  )

  function askRemove(record: BackupRecord) {
    removeTargets.value = [record]
    removeOpen.value = true
  }

  function askRemoveSelected() {
    if (!opts.selectedRecords.value.length) return
    removeTargets.value = [...opts.selectedRecords.value]
    removeOpen.value = true
  }

  function doRemove() {
    const targets = removeTargets.value
    removeBusy.value = true
    try {
      if (targets.length === 1) opts.removeOne(targets[0]._id)
      else opts.removeMany(targets.map((r) => r._id))
      removeOpen.value = false
      removeTargets.value = []
      if (opts.batchMode.value) opts.exitBatch()
    } finally {
      removeBusy.value = false
    }
  }

  // ---------- 批量备份(未备份项目) ----------

  const backingAll = ref(false)
  const backAllProgress = ref('')

  async function backupAllUncovered() {
    const ids = opts.uncovered.value.map((p) => p._id)
    if (!ids.length || backingAll.value) return
    backingAll.value = true
    try {
      const r = await opts.backupMany(ids, (done, total, name) => {
        backAllProgress.value = done < total ? `${done}/${total} ${name}` : ''
      })
      if (!r.ok) opts.notify(r.error || '批量备份失败')
      else opts.notify(`已为 ${r.count}/${ids.length} 个项目创建备份`)
    } finally {
      backingAll.value = false
      backAllProgress.value = ''
    }
  }

  return {
    removeOpen,
    removeTargets,
    removeBusy,
    allMissing,
    removeMessage,
    removeDetails,
    askRemove,
    askRemoveSelected,
    doRemove,
    backingAll,
    backAllProgress,
    backupAllUncovered
  }
}
