// 任务到期感知(跨看板):一次扫描全部看板文档,同时产出——
//  · stats:各看板「逾期 + 今日到期」未完成卡总数(侧栏徽标 / 页头徽标 / 打开通知);
//  · overviewEntries:逾期/今日/3 天内到期的未完成卡片清单(看板页「总览」模式),
//    带来源板名与分节,按 紧急度 → 截止日 → 优先级 → 标题 排序。
// 模块级单例(与 useTasks 同模式):侧栏常驻,统计必须留在模块里。
//
// 刷新时机(不做后台轮询):
//  · AppSidebar 挂载与每次切页 → refresh;
//  · App.vue 挂载(= 每次打开插件)→ refresh + 有逾期/今日则弹一次汇总通知;
//  · 看板页的每次落库成功采纳新板会替换 useTasks.board 引用,模块内的 watch 即时跟进;
//  · 总览里就地完成卡片后由视图显式调 refresh(含旁路写库的情况)。
import { ref, watch } from 'vue'
import { listDocs } from '../services/bridge'
import { DOC_PREFIX, type TaskBoard, type TaskCard, type TaskPriority } from '../types/godot'
import { countDue, dueState, normalizeBoard } from '../utils/taskBoard'
import { useTasks } from './useTasks'

export interface DueStats {
  /** 已逾期(未完成) */
  overdue: number
  /** 今日到期(未完成) */
  today: number
}

/** 总览模式的一条待办:卡片 + 来源板 + 紧急度分节 */
export interface OverviewEntry {
  boardKey: string
  /** 来源板显示名:通用看板 / 项目名(项目已删时兜底) */
  boardName: string
  card: TaskCard
  section: 'overdue' | 'today' | 'soon'
}

const stats = ref<DueStats>({ overdue: 0, today: 0 })
const overviewEntries = ref<OverviewEntry[]>([])
/** 首次扫描成功前总览视图显示载入态 */
const ready = ref(false)
/** 并发去旧:refresh 会被挂载/切页/看板变更并发触发,只采纳最后一次的结果 */
let seq = 0

/** 项目名旁路用不到 useProjectList 的页面状态,直接读 useTasks 的项目清单 */
function boardNameOf(key: string, projects: { _id: string, name: string }[]): string {
  if (key === 'global') return '通用看板'
  return projects.find((p) => p._id === key)?.name ?? '未知项目'
}

const SECTION_ORDER: Record<OverviewEntry['section'], number> = { overdue: 0, today: 1, soon: 2 }
const PRIORITY_WEIGHT: Record<TaskPriority, number> = { high: 0, normal: 1, low: 2 }

/** 扫描全部看板文档,重算统计与总览清单(看板都是小 JSON 文档,同步量级可接受) */
async function refresh(): Promise<void> {
  const run = ++seq
  const { projects, refreshProjects } = useTasks()
  try {
    await refreshProjects() // 项目名要在总览里显示,顺带保持新鲜(项目可能刚改名)
    const docs = await listDocs<TaskBoard>(DOC_PREFIX.taskBoard)
    let overdue = 0
    let today = 0
    const entries: OverviewEntry[] = []
    for (const raw of docs) {
      const board = normalizeBoard(raw)
      if (!board) continue
      const due = countDue(board)
      overdue += due.overdue
      today += due.today
      // boardKey 从文档 id 还原:godot/taskboard/<boardKey>
      const boardKey = String((raw as { _id?: string })._id ?? '').slice(DOC_PREFIX.taskBoard.length)
      for (const column of board.columns) {
        for (const card of column.cards) {
          if (card.done === true) continue
          const s = dueState(card.due)
          if (!s) continue
          entries.push({ boardKey, boardName: boardNameOf(boardKey, projects.value), card, section: s })
        }
      }
    }
    entries.sort((a, b) => {
      if (SECTION_ORDER[a.section] !== SECTION_ORDER[b.section]) return SECTION_ORDER[a.section] - SECTION_ORDER[b.section]
      if ((a.card.due ?? '') !== (b.card.due ?? '')) return (a.card.due ?? '').localeCompare(b.card.due ?? '')
      const pw = PRIORITY_WEIGHT[a.card.priority ?? 'normal'] - PRIORITY_WEIGHT[b.card.priority ?? 'normal']
      if (pw !== 0) return pw
      return a.card.title.localeCompare(b.card.title)
    })
    if (run !== seq) return
    stats.value = { overdue, today }
    overviewEntries.value = entries
    ready.value = true
  } catch {
    // 宿主未就绪等异常:保持上次统计(徽标非关键数据,与侧栏项目数同口径)
    return
  }
}

// 看板页任何变更落库成功(commit 采纳新板)都会替换 board 引用,借此即时刷新统计与总览
watch(useTasks().board, () => {
  refresh()
})

export function useTaskAlerts() {
  return { stats, overviewEntries, ready, refresh }
}
