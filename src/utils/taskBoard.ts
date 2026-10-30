// 任务看板的纯数据操作:建板、列与卡片的增删改移、标签汇总、过滤与截止日状态。
//
// 全部函数都返回新看板(入口 JSON 深拷贝、不改入参),供 useTasks 以
// 「算出新板 → 落库 → 采纳」的方式持久化,也让断言测试无需 Vue。
// 移动函数的 toIndex 一律是「原数组坐标里插到第 toIndex 个之前」(列尾传 length),
// 摘出元素造成的下标偏移由函数内部消化。
import type { TaskBoard, TaskCard, TaskColumn, TaskColor, TaskPriority } from '../types/godot'

/** 卡片/列颜色色板(key 稳定存库,颜色值在 CSS 变量 --task-c-<key> 里随主题走) */
export const TASK_COLORS = ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'gray'] as const

/** 色板 key 的中文标签(swatch 的 title 提示用) */
export const TASK_COLOR_LABELS: Record<TaskColor, string> = {
  red: '红',
  orange: '橙',
  yellow: '黄',
  green: '绿',
  cyan: '青',
  blue: '蓝',
  purple: '紫',
  gray: '灰'
}

/** 「即将到期」窗口(天):due 在今天之后、SOON_DAYS 天内算 soon */
export const SOON_DAYS = 3

/** 生成卡片/列 id(宿主 webview 与 Node 18+ 都有 crypto.randomUUID,兜底时间+随机) */
export function newId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
  } catch {
    // 忽略,走兜底
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** 看板是纯 JSON,JSON 往返即深拷贝(顺带拍平任何响应式代理) */
export function cloneBoard(board: TaskBoard): TaskBoard {
  return JSON.parse(JSON.stringify(board)) as TaskBoard
}

/** 新建看板:默认 待办 / 进行中 / 已完成 三列 */
export function createDefaultBoard(now = Date.now()): TaskBoard {
  return {
    schema: 1,
    columns: [
      { id: newId(), title: '待办', cards: [] },
      { id: newId(), title: '进行中', cards: [] },
      { id: newId(), title: '已完成', cards: [] }
    ],
    updatedAt: now
  }
}

function findColumn(board: TaskBoard, columnId: string): TaskColumn | null {
  return board.columns.find((c) => c.id === columnId) ?? null
}

function findCard(board: TaskBoard, cardId: string): { column: TaskColumn, index: number } | null {
  for (const column of board.columns) {
    const index = column.cards.findIndex((c) => c.id === cardId)
    if (index >= 0) return { column, index }
  }
  return null
}

/** 卡片所在的列 id;找不到返回 null(saveCard 判断是否换列用) */
export function columnIdOfCard(board: TaskBoard, cardId: string): string | null {
  return cardPosition(board, cardId)?.columnId ?? null
}

/** 卡片位置:{ 列 id, 列内数组下标 };找不到返回 null(撤销删除要用原坐标) */
export function cardPosition(board: TaskBoard, cardId: string): { columnId: string, index: number } | null {
  const hit = findCard(board, cardId)
  return hit ? { columnId: hit.column.id, index: hit.index } : null
}

function normalizeTags(tags: string[] | undefined): string[] | undefined {
  const list = [...new Set((tags ?? []).map((t) => t.trim()).filter(Boolean))]
  return list.length ? list : undefined
}

/** 新建卡片并追加到列尾(空标题/列不存在时不改动) */
export function addCard(
  prev: TaskBoard,
  columnId: string,
  input: { title: string, notes?: string, priority?: TaskPriority, due?: string, tags?: string[] },
  now = Date.now()
): TaskBoard {
  const title = input.title.trim()
  if (!title || !findColumn(prev, columnId)) return prev
  const next = cloneBoard(prev)
  const card: TaskCard = {
    id: newId(),
    title,
    notes: input.notes?.trim() || undefined,
    priority: input.priority || undefined,
    due: input.due?.trim() || undefined,
    tags: normalizeTags(input.tags),
    createdAt: now,
    updatedAt: now
  }
  findColumn(next, columnId)!.cards.push(card) // cloneBoard 保留了同结构,断言安全
  next.updatedAt = now
  return next
}

/**
 * 更新卡片字段:patch 里出现的键才生效(置 undefined 即清空)。
 * 空标题不采纳(返回原看板);done 只存 true(未完成 = 字段缺省,与老数据兼容);
 * color 只接受色板 key,非法值视为清色。
 */
export function updateCard(
  prev: TaskBoard,
  cardId: string,
  patch: Partial<Pick<TaskCard, 'title' | 'notes' | 'priority' | 'due' | 'tags' | 'done' | 'color'>>,
  now = Date.now()
): TaskBoard {
  const hit = findCard(prev, cardId)
  if (!hit) return prev
  if (patch.title !== undefined && !patch.title.trim()) return prev
  const next = cloneBoard(prev)
  const target = findCard(next, cardId)! // cloneBoard 保留了同结构,断言安全
  const card = target.column.cards[target.index]
  if (patch.title !== undefined) card.title = patch.title.trim()
  if ('notes' in patch) card.notes = patch.notes?.trim() || undefined
  if ('priority' in patch) card.priority = patch.priority || undefined
  if ('due' in patch) card.due = patch.due?.trim() || undefined
  if ('tags' in patch) card.tags = normalizeTags(patch.tags)
  if ('done' in patch) card.done = patch.done === true || undefined
  if ('color' in patch) card.color = TASK_COLORS.includes(patch.color as TaskColor) ? patch.color : undefined
  card.updatedAt = now
  next.updatedAt = now
  return next
}

/** 删除卡片(列不存在/卡片不存在时不改动) */
export function removeCard(prev: TaskBoard, cardId: string, now = Date.now()): TaskBoard {
  const hit = findCard(prev, cardId)
  if (!hit) return prev
  const next = cloneBoard(prev)
  const target = findCard(next, cardId)!
  target.column.cards.splice(target.index, 1)
  next.updatedAt = now
  return next
}

/** 复制卡片:副本插在原卡之后,标题加「(副本)」,其余字段照搬(新 id、新时间戳) */
export function duplicateCard(prev: TaskBoard, cardId: string, now = Date.now()): TaskBoard {
  const hit = findCard(prev, cardId)
  if (!hit) return prev
  const next = cloneBoard(prev)
  const target = findCard(next, cardId)! // cloneBoard 保留了同结构,断言安全
  const src = target.column.cards[target.index]
  target.column.cards.splice(target.index + 1, 0, {
    ...src,
    id: newId(),
    title: `${src.title}(副本)`,
    createdAt: now,
    updatedAt: now
  })
  next.updatedAt = now
  return next
}

/** 把卡片插回指定列的 index 处(撤销删除用;越界钳到列尾,列不存在不改动) */
export function restoreCard(prev: TaskBoard, columnId: string, index: number, card: TaskCard, now = Date.now()): TaskBoard {
  const next = cloneBoard(prev)
  const column = findColumn(next, columnId)
  if (!column) return prev
  const idx = Math.max(0, Math.min(index, column.cards.length))
  column.cards.splice(idx, 0, JSON.parse(JSON.stringify(card)) as TaskCard)
  next.updatedAt = now
  return next
}

/** 移动卡片到目标列 toIndex 处(跨列/列内重排共用,同列偏移内部消化) */
export function moveCard(prev: TaskBoard, cardId: string, toColumnId: string, toIndex: number, now = Date.now()): TaskBoard {
  const next = cloneBoard(prev)
  const hit = findCard(next, cardId)
  const target = findColumn(next, toColumnId)
  if (!hit || !target) return prev
  const [card] = hit.column.cards.splice(hit.index, 1)
  let idx = toIndex
  if (target.id === hit.column.id && toIndex > hit.index) idx = toIndex - 1
  idx = Math.max(0, Math.min(idx, target.cards.length))
  target.cards.splice(idx, 0, card)
  next.updatedAt = now
  return next
}

/** 新建列(空标题不改动);atIndex 缺省追加到末尾 */
export function addColumn(prev: TaskBoard, title: string, atIndex = prev.columns.length, now = Date.now()): TaskBoard {
  const name = title.trim()
  if (!name) return prev
  const next = cloneBoard(prev)
  const idx = Math.max(0, Math.min(atIndex, next.columns.length))
  next.columns.splice(idx, 0, { id: newId(), title: name, cards: [] })
  next.updatedAt = now
  return next
}

/** 重命名列(空标题不改动) */
export function renameColumn(prev: TaskBoard, columnId: string, title: string, now = Date.now()): TaskBoard {
  const name = title.trim()
  if (!name) return prev
  const next = cloneBoard(prev)
  const column = findColumn(next, columnId)
  if (!column) return prev
  column.title = name
  next.updatedAt = now
  return next
}

/** 更新列字段(patch 出现的键才生效;color 只接受色板 key,非法值视为清色) */
export function updateColumn(
  prev: TaskBoard,
  columnId: string,
  patch: Partial<Pick<TaskColumn, 'color'>>,
  now = Date.now()
): TaskBoard {
  const next = cloneBoard(prev)
  const column = findColumn(next, columnId)
  if (!column) return prev
  if ('color' in patch) column.color = TASK_COLORS.includes(patch.color as TaskColor) ? patch.color : undefined
  next.updatedAt = now
  return next
}

/** 删除列,连同列内全部卡片 */
export function removeColumn(prev: TaskBoard, columnId: string, now = Date.now()): TaskBoard {
  const next = cloneBoard(prev)
  const idx = next.columns.findIndex((c) => c.id === columnId)
  if (idx < 0) return prev
  next.columns.splice(idx, 1)
  next.updatedAt = now
  return next
}

/** 清空一列的全部卡片(保留列本身) */
export function clearColumn(prev: TaskBoard, columnId: string, now = Date.now()): TaskBoard {
  const next = cloneBoard(prev)
  const column = findColumn(next, columnId)
  if (!column || !column.cards.length) return prev
  column.cards = []
  next.updatedAt = now
  return next
}

/** 移动列到 toIndex 处(列头拖拽排序) */
export function moveColumn(prev: TaskBoard, columnId: string, toIndex: number, now = Date.now()): TaskBoard {
  const next = cloneBoard(prev)
  const from = next.columns.findIndex((c) => c.id === columnId)
  if (from < 0) return prev
  const [column] = next.columns.splice(from, 1)
  let idx = toIndex > from ? toIndex - 1 : toIndex
  idx = Math.max(0, Math.min(idx, next.columns.length))
  next.columns.splice(idx, 0, column)
  next.updatedAt = now
  return next
}

/** 汇总看板内出现过的标签(去重 + 排序),供过滤 chips 与输入建议 */
export function boardTags(board: TaskBoard): string[] {
  const set = new Set<string>()
  for (const column of board.columns) {
    for (const card of column.cards) {
      for (const tag of card.tags ?? []) set.add(tag)
    }
  }
  return [...set].sort((a, b) => a.localeCompare(b))
}

/** 看板卡片总数 */
export function countCards(board: TaskBoard): number {
  return board.columns.reduce((sum, c) => sum + c.cards.length, 0)
}

/** 看板内「逾期 + 今日到期」的未完成卡片数(侧栏/页头徽标与打开通知的统计口径,已完成卡一律排除) */
export function countDue(board: TaskBoard, today = todayStr()): { overdue: number, today: number } {
  let overdue = 0
  let todayCount = 0
  for (const column of board.columns) {
    for (const card of column.cards) {
      if (card.done === true) continue
      const s = dueState(card.due, today)
      if (s === 'overdue') overdue++
      else if (s === 'today') todayCount++
    }
  }
  return { overdue, today: todayCount }
}

/** 本地时区的今天,YYYY-MM-DD(dueState 的比较基准,测试可注入) */
export function todayStr(now = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** YYYY-MM-DD 加 n 天(本地时区,月末自动进位);格式不合法原样返回 */
export function addDays(date: string, n: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return date
  const [y, m, d] = date.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  dt.setDate(dt.getDate() + n)
  return todayStr(dt)
}

/** 截止日状态:已过期(昨天及更早)/ 就是今天 / SOON_DAYS 天内到期 / 未设置或更远 */
export function dueState(due: string | undefined, today = todayStr()): 'overdue' | 'today' | 'soon' | null {
  if (!due) return null
  if (due < today) return 'overdue'
  if (due === today) return 'today'
  if (due <= addDays(today, SOON_DAYS)) return 'soon'
  return null
}

/** 卡片过滤条件。query 命中标题/备注/标签文本(忽略大小写);tags 任一命中(未选不限);
 *  priority 缺省不限(normal 也匹配未设置);overdueOnly 只看未完成的逾期卡 */
export interface TaskFilter {
  query?: string
  tags?: string[]
  priority?: TaskPriority
  overdueOnly?: boolean
}

export function matchCard(card: TaskCard, f: TaskFilter): boolean {
  const kw = (f.query ?? '').trim().toLowerCase()
  if (kw) {
    const hay = [card.title, card.notes ?? '', (card.tags ?? []).join(' ')].join('\n').toLowerCase()
    if (!hay.includes(kw)) return false
  }
  if (f.tags?.length && !(card.tags ?? []).some((t) => f.tags!.includes(t))) return false
  if (f.priority && (card.priority ?? 'normal') !== f.priority) return false
  if (f.overdueOnly && (card.done === true || dueState(card.due) !== 'overdue')) return false
  return true
}

/**
 * 宽容读取宿主文档:缺字段给默认值、剔除坏行,保证调用方拿到合法 TaskBoard。
 * 文档不存在返回 null;列被用户删光时返回空列看板(这是合法状态,不能当缺失重建默认板)。
 */
export function normalizeBoard(raw: unknown): TaskBoard | null {
  if (!raw || typeof raw !== 'object') return null
  const src = raw as Record<string, unknown>
  const columnsRaw = Array.isArray(src.columns) ? src.columns : []
  const columns: TaskColumn[] = []
  for (const colRaw of columnsRaw) {
    if (!colRaw || typeof colRaw !== 'object') continue
    const col = colRaw as Record<string, unknown>
    const cards: TaskCard[] = []
    if (Array.isArray(col.cards)) {
      for (const cardRaw of col.cards) {
        if (!cardRaw || typeof cardRaw !== 'object') continue
        const c = cardRaw as Record<string, unknown>
        if (typeof c.id !== 'string' || !c.id) continue
        if (typeof c.title !== 'string' || !c.title.trim()) continue
        cards.push({
          id: c.id,
          title: c.title,
          notes: typeof c.notes === 'string' && c.notes.trim() ? c.notes : undefined,
          priority: c.priority === 'high' || c.priority === 'low' || c.priority === 'normal' ? c.priority : undefined,
          due: typeof c.due === 'string' && c.due ? c.due : undefined,
          tags: normalizeTags(Array.isArray(c.tags) ? c.tags.filter((t): t is string => typeof t === 'string') : undefined),
          done: c.done === true || undefined,
          color: TASK_COLORS.includes(c.color as TaskColor) ? (c.color as TaskColor) : undefined,
          createdAt: typeof c.createdAt === 'number' ? c.createdAt : 0,
          updatedAt: typeof c.updatedAt === 'number' ? c.updatedAt : 0
        })
      }
    }
    columns.push({
      id: typeof col.id === 'string' && col.id ? col.id : newId(),
      title: typeof col.title === 'string' && col.title.trim() ? col.title : '未命名列',
      color: TASK_COLORS.includes(col.color as TaskColor) ? (col.color as TaskColor) : undefined,
      cards
    })
  }
  return {
    schema: 1,
    columns,
    updatedAt: typeof src.updatedAt === 'number' ? src.updatedAt : 0
  }
}
