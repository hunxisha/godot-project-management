// 任务到期感知(跨看板):统计全部看板文档里「逾期 + 今日到期」的未完成卡片数,
// 供侧栏看板项徽标、看板页头徽标与打开插件时的一次性汇总通知使用。
// 模块级单例(与 useTasks 同模式):侧栏常驻,统计必须留在模块里。
//
// 刷新时机(不做后台轮询):
//  · AppSidebar 挂载与每次切页 → refresh;
//  · App.vue 挂载(= 每次打开插件)→ refresh + 有逾期/今日则弹一次汇总通知;
//  · 看板页的每次落库成功采纳新板会替换 useTasks.board 引用,模块内的 watch 即时跟进;
//  · 跨板文档的旁路变动(如删项目清理看板)靠下一次切页/开插件兜底。
import { ref, watch } from 'vue'
import { listDocs } from '../services/bridge'
import { DOC_PREFIX, type TaskBoard } from '../types/godot'
import { countDue, normalizeBoard } from '../utils/taskBoard'
import { useTasks } from './useTasks'

export interface DueStats {
  /** 已逾期(未完成) */
  overdue: number
  /** 今日到期(未完成) */
  today: number
}

const stats = ref<DueStats>({ overdue: 0, today: 0 })
/** 并发去旧:refresh 会被挂载/切页/看板变更并发触发,只采纳最后一次的结果 */
let seq = 0

/** 扫描全部看板文档,重算逾期/今日统计(看板都是小 JSON 文档,同步量级可接受) */
async function refresh(): Promise<void> {
  const run = ++seq
  let overdue = 0
  let today = 0
  try {
    const docs = await listDocs<TaskBoard>(DOC_PREFIX.taskBoard)
    for (const raw of docs) {
      const board = normalizeBoard(raw)
      if (!board) continue
      const due = countDue(board)
      overdue += due.overdue
      today += due.today
    }
  } catch {
    // 宿主未就绪等异常:保持上次统计(徽标非关键数据,与侧栏项目数同口径)
    return
  }
  if (run !== seq) return
  stats.value = { overdue, today }
}

// 看板页任何变更落库成功(commit 采纳新板)都会替换 board 引用,借此即时刷新统计
watch(useTasks().board, () => {
  refresh()
})

export function useTaskAlerts() {
  return { stats, refresh }
}
