// 任务看板的纯数据操作:建板、列与卡片的增删改移、标签汇总、过滤与截止日状态。
//
// 全部函数都返回新看板(入口 JSON 深拷贝、不改入参),供 useTasks 以
// 「算出新板 → 落库 → 采纳」的方式持久化,也让断言测试无需 Vue。
// 移动函数的 toIndex 一律是「原数组坐标里插到第 toIndex 个之前」(列尾传 length),
// 摘出元素造成的下标偏移由函数内部消化。
import type { TaskBoard, TaskCard, TaskChecklistItem, TaskColumn, TaskColor, TaskPriority } from '../types/godot'

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

/** 优先级中文标签(过滤/详情/菜单共用) */
export const TASK_PRIORITY_LABELS: Record<TaskPriority, string> = {
  high: '高',
  normal: '中',
  low: '低'
}

/** 列表视图的排序键 */
export type TaskSortKey = 'manual' | 'due' | 'priority' | 'updated' | 'title'

/** 按截止日过滤的范围('soon' 只含今天之后、SOON_DAYS 天内,与 dueState 同口径) */
export type TaskDueScope = 'overdue' | 'today' | 'soon' | 'none' | 'later'

/** 列表视图排序的中文标签 */
export const TASK_SORT_LABELS: Record<TaskSortKey, string> = {
  manual: '手动顺序',
  due: '截止日期',
  priority: '优先级',
  updated: '最近更新',
  title: '标题'
}

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

/** 检查项归一化:丢空文本、补 id、done 只存 true(与卡片 done 同口径) */
function normalizeChecklist(items: TaskChecklistItem[] | undefined): TaskChecklistItem[] | undefined {
  if (!Array.isArray(items)) return undefined
  const list: TaskChecklistItem[] = []
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue
    const text = typeof raw.text === 'string' ? raw.text.trim() : ''
    if (!text) continue
    list.push({
      id: typeof raw.id === 'string' && raw.id ? raw.id : newId(),
      text,
      done: raw.done === true || undefined
    })
  }
  return list.length ? list : undefined
}

/** 新建卡片并追加到列尾(空标题/列不存在时不改动) */
export function addCard(
  prev: TaskBoard,
  columnId: string,
  input: { title: string, notes?: string, priority?: TaskPriority, due?: string, tags?: string[], checklist?: TaskChecklistItem[] },
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
    checklist: normalizeChecklist(input.checklist),
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
  patch: Partial<Pick<TaskCard, 'title' | 'notes' | 'priority' | 'due' | 'tags' | 'done' | 'color' | 'checklist'>>,
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
  if ('checklist' in patch) card.checklist = normalizeChecklist(patch.checklist)
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
    // 副本的检查项换新 id,避免同一张卡里两张子任务的 key 指向同一个对象
    checklist: src.checklist?.map((item) => ({ ...item, id: newId() })),
    archivedAt: undefined,
    archivedFrom: undefined,
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

// ---------- 批量操作(多选工具条) ----------

/** 批量移动:保持各列内原顺序,统一追加到目标列尾(目标列不存在/无命中不改动) */
export function moveCards(prev: TaskBoard, cardIds: string[], toColumnId: string, now = Date.now()): TaskBoard {
  const target = findColumn(prev, toColumnId)
  if (!target || !cardIds.length) return prev
  const ids = new Set(cardIds)
  const next = cloneBoard(prev)
  const targetCol = findColumn(next, toColumnId)!
  const moved: TaskCard[] = []
  for (const column of next.columns) {
    const keep: TaskCard[] = []
    for (const card of column.cards) {
      if (ids.has(card.id)) moved.push(card)
      else keep.push(card)
    }
    column.cards = keep
  }
  if (!moved.length) return prev
  targetCol.cards.push(...moved)
  next.updatedAt = now
  return next
}

/** 批量删除(无命中不改动;调用方负责确认) */
export function removeCards(prev: TaskBoard, cardIds: string[], now = Date.now()): TaskBoard {
  if (!cardIds.length) return prev
  const ids = new Set(cardIds)
  const next = cloneBoard(prev)
  let changed = false
  for (const column of next.columns) {
    const keep = column.cards.filter((card) => {
      if (ids.has(card.id)) {
        changed = true
        return false
      }
      return true
    })
    column.cards = keep
  }
  if (!changed) return prev
  next.updatedAt = now
  return next
}

/** 批量完成/取消完成(done 只存 true;无命中不改动) */
export function setCardsDone(prev: TaskBoard, cardIds: string[], done: boolean, now = Date.now()): TaskBoard {
  if (!cardIds.length) return prev
  const ids = new Set(cardIds)
  const next = cloneBoard(prev)
  let changed = false
  for (const column of next.columns) {
    for (const card of column.cards) {
      if (!ids.has(card.id)) continue
      const target = done ? true : undefined
      if (card.done !== target) {
        card.done = target
        card.updatedAt = now
        changed = true
      }
    }
  }
  if (!changed) return prev
  next.updatedAt = now
  return next
}

// ---------- 归档箱 ----------

/** 把卡片移入归档箱(记录来源列,便于恢复);无命中不改动 */
export function archiveCards(prev: TaskBoard, cardIds: string[], now = Date.now()): TaskBoard {
  if (!cardIds.length) return prev
  const ids = new Set(cardIds)
  const next = cloneBoard(prev)
  const moved: TaskCard[] = []
  for (const column of next.columns) {
    const keep: TaskCard[] = []
    for (const card of column.cards) {
      if (ids.has(card.id)) {
        moved.push({ ...card, archivedAt: now, archivedFrom: column.id, updatedAt: now })
      } else {
        keep.push(card)
      }
    }
    column.cards = keep
  }
  if (!moved.length) return prev
  next.archived = [...(next.archived ?? []), ...moved]
  next.updatedAt = now
  return next
}

/** 一键归档全部已完成卡片(看板工具栏) */
export function archiveDoneCards(prev: TaskBoard, now = Date.now()): TaskBoard {
  const ids: string[] = []
  for (const column of prev.columns) {
    for (const card of column.cards) {
      if (card.done === true) ids.push(card.id)
    }
  }
  return archiveCards(prev, ids, now)
}

/** 从归档箱恢复:优先回原列,原列已删则回退首列;无列可放时不改动 */
export function restoreArchivedCard(prev: TaskBoard, cardId: string, columnId?: string, now = Date.now()): TaskBoard {
  const archived = prev.archived ?? []
  const hit = archived.find((c) => c.id === cardId)
  if (!hit) return prev
  const next = cloneBoard(prev)
  const list = next.archived ?? []
  const idx = list.findIndex((c) => c.id === cardId)
  if (idx < 0) return prev
  const [card] = list.splice(idx, 1)
  const targetId = columnId || card.archivedFrom
  const column = (targetId ? findColumn(next, targetId) : null) ?? next.columns[0]
  if (!column) return prev
  card.archivedAt = undefined
  card.archivedFrom = undefined
  card.updatedAt = now
  column.cards.push(card)
  next.updatedAt = now
  return next
}

/** 从归档箱彻底删除一张卡(无命中不改动) */
export function removeArchivedCard(prev: TaskBoard, cardId: string, now = Date.now()): TaskBoard {
  const next = cloneBoard(prev)
  const archived = next.archived ?? []
  const idx = archived.findIndex((c) => c.id === cardId)
  if (idx < 0) return prev
  archived.splice(idx, 1)
  next.updatedAt = now
  return next
}

/** 清空归档箱(本来就空则返回原板) */
export function clearArchived(prev: TaskBoard, now = Date.now()): TaskBoard {
  if (!prev.archived?.length) return prev
  const next = cloneBoard(prev)
  next.archived = []
  next.updatedAt = now
  return next
}

// ---------- 检查项与统计 ----------

/** 卡片检查项进度(无清单时 total=0、pct=0) */
export function checklistProgress(card: TaskCard): { done: number, total: number, pct: number } {
  const total = card.checklist?.length ?? 0
  if (!total) return { done: 0, total: 0, pct: 0 }
  const done = card.checklist!.filter((item) => item.done === true).length
  return { done, total, pct: Math.round((done / total) * 100) }
}

/** 勾选/取消一个检查项(卡片/检查项不存在时不改动;走 updateCard 以复用归一化) */
export function setChecklistItemDone(
  prev: TaskBoard,
  cardId: string,
  itemId: string,
  done: boolean,
  now = Date.now()
): TaskBoard {
  const hit = findCard(prev, cardId)
  if (!hit) return prev
  const card = hit.column.cards[hit.index]
  if (!card.checklist?.some((item) => item.id === itemId)) return prev
  return updateCard(
    prev,
    cardId,
    { checklist: card.checklist.map((item) => (item.id === itemId ? { ...item, done: done || undefined } : item)) },
    now
  )
}

/** 看板健康度:完成率 + 到期压力(归档卡不计入) */
export interface BoardStats {
  total: number
  done: number
  active: number
  overdue: number
  today: number
  soon: number
  archived: number
  /** 完成率 0–100(无卡片时为 0) */
  pct: number
}

export function boardStats(board: TaskBoard, today = todayStr()): BoardStats {
  const due = countDue(board, today)
  let total = 0
  let done = 0
  let soon = 0
  for (const column of board.columns) {
    for (const card of column.cards) {
      total++
      if (card.done === true) done++
      else if (dueState(card.due, today) === 'soon') soon++
    }
  }
  return {
    total,
    done,
    active: total - done,
    overdue: due.overdue,
    today: due.today,
    soon,
    archived: board.archived?.length ?? 0,
    pct: total ? Math.round((done / total) * 100) : 0
  }
}

const PRIORITY_WEIGHT: Record<TaskPriority, number> = { high: 0, normal: 1, low: 2 }

/** 列表视图排序(不改入参;截止日排序始终把无截止日放最后) */
export function sortCards(cards: TaskCard[], key: TaskSortKey, dir: 'asc' | 'desc' = 'asc'): TaskCard[] {
  if (key === 'manual') return [...cards]
  const sign = dir === 'desc' ? -1 : 1
  const tie = (a: TaskCard, b: TaskCard) => {
    const pw = PRIORITY_WEIGHT[a.priority ?? 'normal'] - PRIORITY_WEIGHT[b.priority ?? 'normal']
    if (pw !== 0) return pw
    if ((a.due ?? '') !== (b.due ?? '')) return (a.due ?? 'zzzz').localeCompare(b.due ?? 'zzzz')
    return a.title.localeCompare(b.title)
  }
  const sorted = [...cards]
  sorted.sort((a, b) => {
    if (key === 'due') {
      if (!a.due && !b.due) return tie(a, b)
      if (!a.due) return 1
      if (!b.due) return -1
      return sign * a.due.localeCompare(b.due) || tie(a, b)
    }
    if (key === 'priority') {
      return sign * (PRIORITY_WEIGHT[a.priority ?? 'normal'] - PRIORITY_WEIGHT[b.priority ?? 'normal']) || tie(a, b)
    }
    if (key === 'updated') {
      return sign * ((a.updatedAt || 0) - (b.updatedAt || 0)) || tie(a, b)
    }
    return sign * a.title.localeCompare(b.title) || tie(a, b)
  })
  return sorted
}

// ---------- 聚焦视图(当前板) ----------

export type TaskFocusKey = 'overdue' | 'today' | 'soon' | 'unscheduled'

export const TASK_FOCUS_LABELS: Record<TaskFocusKey, string> = {
  overdue: '已逾期',
  today: '今天',
  soon: '未来三天',
  unscheduled: '未排期'
}

export interface TaskFocusEntry {
  card: TaskCard
  columnId: string
  columnTitle: string
}

export interface TaskFocusGroup {
  key: TaskFocusKey
  entries: TaskFocusEntry[]
}

/**
 * 把当前板的未完成卡片按「现在该做什么」分桶:
 * 逾期 → 今天 → 未来三天(SOON_DAYS 内)→ 未排期(无截止日)。
 * 更远的截止日不进聚焦(留在看板/列表)。
 */
export function focusGroups(board: TaskBoard, today = todayStr()): TaskFocusGroup[] {
  const buckets: Record<TaskFocusKey, TaskFocusEntry[]> = {
    overdue: [],
    today: [],
    soon: [],
    unscheduled: []
  }
  for (const column of board.columns) {
    for (const card of column.cards) {
      if (card.done === true) continue
      const state = dueState(card.due, today)
      const key: TaskFocusKey | null = state === 'overdue' || state === 'today' || state === 'soon'
        ? state
        : card.due
          ? null
          : 'unscheduled'
      if (!key) continue
      buckets[key].push({ card, columnId: column.id, columnTitle: column.title })
    }
  }
  const byDue = (a: TaskFocusEntry, b: TaskFocusEntry) =>
    (a.card.due ?? '').localeCompare(b.card.due ?? '') ||
    PRIORITY_WEIGHT[a.card.priority ?? 'normal'] - PRIORITY_WEIGHT[b.card.priority ?? 'normal'] ||
    a.card.title.localeCompare(b.card.title)
  const byPriority = (a: TaskFocusEntry, b: TaskFocusEntry) =>
    PRIORITY_WEIGHT[a.card.priority ?? 'normal'] - PRIORITY_WEIGHT[b.card.priority ?? 'normal'] ||
    (b.card.updatedAt || 0) - (a.card.updatedAt || 0) ||
    a.card.title.localeCompare(b.card.title)
  buckets.overdue.sort(byDue)
  buckets.today.sort(byPriority)
  buckets.soon.sort(byDue)
  buckets.unscheduled.sort(byPriority)
  return (['overdue', 'today', 'soon', 'unscheduled'] as const)
    .map((key) => ({ key, entries: buckets[key] }))
    .filter((group) => group.entries.length > 0)
}

// ---------- 快速捕获:轻量自然语言 ----------

export interface QuickAddResult {
  title: string
  tags: string[]
  priority?: TaskPriority
  due?: string
}

const PRIORITY_TOKENS: Record<string, TaskPriority> = {
  high: 'high',
  h: 'high',
  p1: 'high',
  '高': 'high',
  low: 'low',
  l: 'low',
  '低': 'low',
  normal: 'normal',
  n: 'normal',
  '中': 'normal'
}

/**
 * 快速捕获语法(借鉴 Todoist 的 inline syntax,但只保留最小可用集):
 *   #标签        → 标签(支持 #a#b 一次加两个)
 *   !高 / !h     → 优先级(还有 !中 / !低)
 *   @今天 / @明天 / @+3 / @2026-11-05 → 截止日
 * 认不出的 token 原样留在标题里,不擅自吞掉用户输入。
 */
export function parseQuickAdd(input: string, today = todayStr()): QuickAddResult {
  const original = input.trim()
  const tags: string[] = []
  let priority: TaskPriority | undefined
  let due: string | undefined
  const remain: string[] = []
  for (const token of original.split(/\s+/)) {
    if (token.startsWith('#') && token.length > 1) {
      for (const part of token.slice(1).split('#')) {
        const tag = part.trim()
        if (tag) tags.push(tag)
      }
      continue
    }
    if (token.startsWith('!')) {
      const hit = PRIORITY_TOKENS[token.slice(1).toLowerCase()]
      if (hit) {
        priority = hit
        continue
      }
    }
    if (token.startsWith('@')) {
      const parsed = parseQuickDue(token.slice(1), today)
      if (parsed) {
        due = parsed
        continue
      }
    }
    remain.push(token)
  }
  const title = remain.join(' ').trim() || original
  return {
    title,
    tags: [...new Set(tags)],
    priority,
    due
  }
}

/** @token 的解析:今天/明天/下周/+N/YYYY-MM-DD(无法识别返回 null,由调用方保留原文) */
function parseQuickDue(raw: string, today: string): string | null {
  const low = raw.toLowerCase()
  if (low === 'today' || raw === '今天') return today
  if (low === 'tomorrow' || raw === '明天') return addDays(today, 1)
  if (low === 'week' || raw === '下周') return addDays(today, 7)
  const plus = /^\+(\d{1,3})$/.exec(raw)
  if (plus) return addDays(today, Number(plus[1]))
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw
  return null
}

/** 截止日的简短人话标签(卡片/聚焦/列表共用;today 可注入便于测试) */
export function dueHint(due: string | undefined, today = todayStr()): string {
  if (!due) return ''
  const diff = daysBetween(today, due)
  if (diff < 0) return `${due.slice(5)} · 逾期 ${-diff} 天`
  if (diff === 0) return '今天'
  if (diff === 1) return '明天'
  if (diff <= SOON_DAYS) return `${diff} 天后`
  return due.length >= 10 ? due.slice(5) : due
}

/** 两个 YYYY-MM-DD 的整天差(b - a;本地时区,格式不合法返回 NaN) */
export function daysBetween(from: string, to: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return NaN
  const [fy, fm, fd] = from.split('-').map(Number)
  const [ty, tm, td] = to.split('-').map(Number)
  const a = new Date(fy, fm - 1, fd).getTime()
  const b = new Date(ty, tm - 1, td).getTime()
  return Math.round((b - a) / 86400000)
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

/** 卡片过滤条件。query 命中标题/备注/标签文本/检查项(忽略大小写);tags 任一命中(未选不限);
 *  priority 缺省不限(normal 也匹配未设置);overdueOnly 只看未完成的逾期卡;
 *  dueScope 按截止日范围筛(与 dueState 同口径,但 'later' 是 3 天窗口之外);hideDone 隐藏已完成 */
export interface TaskFilter {
  query?: string
  tags?: string[]
  priority?: TaskPriority
  overdueOnly?: boolean
  dueScope?: TaskDueScope
  hideDone?: boolean
}

export function matchCard(card: TaskCard, f: TaskFilter): boolean {
  if (f.hideDone && card.done === true) return false
  const kw = (f.query ?? '').trim().toLowerCase()
  if (kw) {
    const hay = [
      card.title,
      card.notes ?? '',
      (card.tags ?? []).join(' '),
      (card.checklist ?? []).map((item) => item.text).join(' ')
    ].join('\n').toLowerCase()
    if (!hay.includes(kw)) return false
  }
  if (f.tags?.length && !(card.tags ?? []).some((t) => f.tags!.includes(t))) return false
  if (f.priority && (card.priority ?? 'normal') !== f.priority) return false
  if (f.overdueOnly && (card.done === true || dueState(card.due) !== 'overdue')) return false
  if (f.dueScope) {
    if (f.dueScope === 'none') {
      if (card.due) return false
    } else if (card.done === true) {
      return false
    } else {
      const state = dueState(card.due)
      if (f.dueScope === 'later') {
        if (!card.due || state !== null) return false
      } else if (state !== f.dueScope) {
        return false
      }
    }
  }
  return true
}

/** 单张卡片的宽容读取(列内与归档箱共用;坏卡返回 null) */
function normalizeCard(raw: unknown): TaskCard | null {
  if (!raw || typeof raw !== 'object') return null
  const c = raw as Record<string, unknown>
  if (typeof c.id !== 'string' || !c.id) return null
  if (typeof c.title !== 'string' || !c.title.trim()) return null
  const checklistRaw = Array.isArray(c.checklist)
    ? c.checklist.filter((item): item is TaskChecklistItem => !!item && typeof item === 'object')
    : undefined
  return {
    id: c.id,
    title: c.title,
    notes: typeof c.notes === 'string' && c.notes.trim() ? c.notes : undefined,
    priority: c.priority === 'high' || c.priority === 'low' || c.priority === 'normal' ? c.priority : undefined,
    due: typeof c.due === 'string' && c.due ? c.due : undefined,
    tags: normalizeTags(Array.isArray(c.tags) ? c.tags.filter((t): t is string => typeof t === 'string') : undefined),
    done: c.done === true || undefined,
    color: TASK_COLORS.includes(c.color as TaskColor) ? (c.color as TaskColor) : undefined,
    checklist: normalizeChecklist(checklistRaw),
    archivedAt: typeof c.archivedAt === 'number' ? c.archivedAt : undefined,
    archivedFrom: typeof c.archivedFrom === 'string' && c.archivedFrom ? c.archivedFrom : undefined,
    createdAt: typeof c.createdAt === 'number' ? c.createdAt : 0,
    updatedAt: typeof c.updatedAt === 'number' ? c.updatedAt : 0
  }
}

/**
 * 宽容读取宿主文档:缺字段给默认值、剔除坏行,保证调用方拿到合法 TaskBoard。
 * 文档不存在返回 null;列被用户删光时返回空列看板(这是合法状态,不能当缺失重建默认板)。
 * 归档箱里的坏卡同样剔除;老数据(无 checklist/archived)保持可读。
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
        const card = normalizeCard(cardRaw)
        if (card) cards.push(card)
      }
    }
    columns.push({
      id: typeof col.id === 'string' && col.id ? col.id : newId(),
      title: typeof col.title === 'string' && col.title.trim() ? col.title : '未命名列',
      color: TASK_COLORS.includes(col.color as TaskColor) ? (col.color as TaskColor) : undefined,
      cards
    })
  }
  const archived: TaskCard[] = []
  if (Array.isArray(src.archived)) {
    for (const cardRaw of src.archived) {
      const card = normalizeCard(cardRaw)
      if (card) archived.push(card)
    }
  }
  const board: TaskBoard = {
    schema: 1,
    columns,
    updatedAt: typeof src.updatedAt === 'number' ? src.updatedAt : 0
  }
  if (archived.length) board.archived = archived
  return board
}
