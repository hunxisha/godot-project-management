// 一键导出的任务订阅与动作:导出任务在独立队列里跑,跨页面继续;
// 本组合式函数负责订阅快照、发起/取消导出,展示由调用方(ExportDialog / App 任务栏)负责。
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { ExportTask } from '../types/godot'

export function useExport() {
  const tasks = ref<ExportTask[]>([])
  let unwatch: (() => void) | null = null

  onMounted(() => {
    unwatch = window.services.watchExportTasks((snap) => {
      tasks.value = snap
    })
  })

  onBeforeUnmount(() => {
    if (unwatch) unwatch()
  })

  /** 某项目当前的活动导出任务(排队/导出中) */
  function taskFor(projectId: string): ExportTask | undefined {
    return tasks.value.find(
      (t) => t.projectId === projectId && !['done', 'error', 'canceled'].includes(t.status)
    )
  }

  /**
   * 发起导出;缺模板时返回原始结果(missingTemplates=true),由调用方给出补救入口。
   */
  function run(projectId: string, presetName: string, outputPath?: string) {
    return window.services.runExport({ projectId, presetName, outputPath })
  }

  function cancel(id: string) {
    window.services.cancelExportTask(id)
  }

  function dismiss(id: string) {
    window.services.dismissExportTask(id)
  }

  return { tasks, taskFor, run, cancel, dismiss }
}
