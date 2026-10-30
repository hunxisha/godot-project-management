// 任务看板的纯数据操作:建板、列与卡片的增删改移、标签汇总、过滤与截止日状态。
//
// 全部函数都返回新看板(入口 JSON 深拷贝、不改入参),供 useTasks 以
// 「算出新板 → 落库 → 采纳」的方式持久化,也让断言测试无需 Vue。
// 移动函数的 toIndex 一律是「原数组坐标里插到第 toIndex 个之前」(列尾传 length),
// 摘出元素造成的下标偏移由函数内部消化。
import type { TaskBoard, TaskCard, TaskColumn, TaskPriority } from '../types/godot'

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
  return findCard(board, cardId)?.column.id ?? null
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
 * 空标题不采纳(返回原看板)。
 */
export function updateCard(
  prev: TaskBoard,
  cardId: string,
  patch: Partial<Pick<TaskCard, 'title' | 'notes' | 'priority' | 'due' | 'tags'>>,
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

/** 本地时区的今天,YYYY-MM-DD(dueState 的比较基准,测试可注入) */
export function todayStr(now = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** 截止日状态:已过期(昨天及更早)/ 就是今天 / 未设置或未到期 */
export function dueState(due: string | undefined, today = todayStr()): 'overdue' | 'today' | null {
  if (!due) return null
  if (due < today) return 'overdue'
  if (due === today) return 'today'
  return null
}

/** 卡片过滤:关键词命中标题或备注(忽略大小写),且标签任一命中(未选标签则不限) */
export function matchCard(card: TaskCard, query: string, tags: string[]): boolean {
  const kw = query.trim().toLowerCase()
  if (kw && !card.title.toLowerCase().includes(kw) && !(card.notes ?? '').toLowerCase().includes(kw)) return false
  if (tags.length && !(card.tags ?? []).some((t) => tags.includes(t))) return false
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
          createdAt: typeof c.createdAt === 'number' ? c.createdAt : 0,
          updatedAt: typeof c.updatedAt === 'number' ? c.updatedAt : 0
        })
      }
    }
    columns.push({
      id: typeof col.id === 'string' && col.id ? col.id : newId(),
      title: typeof col.title === 'string' && col.title.trim() ? col.title : '未命名列',
      cards
    })
  }
  return {
    schema: 1,
    columns,
    updatedAt: typeof src.updatedAt === 'number' ? src.updatedAt : 0
  }
}
