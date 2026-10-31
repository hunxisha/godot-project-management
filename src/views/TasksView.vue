<script setup lang="ts">
// 任务工作台(重设计):把「看板」升级成四种互补视图 —— 看板 / 列表 / 聚焦 / 归档。
//  · 快速捕获:顶部一条输入,支持 #标签 @今天 !高 的轻量语法(借鉴 Todoist 的 inline syntax);
//  · 看板:保留拖拽(卡片与列)、列菜单、颜色;新增卡片操作菜单(移动/复制/归档/删除),让不用鼠标拖也能换列;
//  · 列表:按列分组、可排序、可直接勾完成,适合快速扫读;
//  · 聚焦:当前板按「逾期/今天/未来三天/未排期」分桶,也可切全部看板(沿用跨板到期扫描);
//  · 归档:已完成或手动归档的卡进归档箱,可恢复原列或彻底删除;
//  · 多选工具条:批量完成/移动/归档/删除(借鉴 Linear 的批量操作);
//  · 键盘:1-4 切视图、N 聚焦快速捕获、/ 搜索、Esc 关浮层。
// 数据层完全沿用 useTasks/taskBoard 的「纯函数算新板 → 落库 → 采纳」模型。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Icon from '../components/Icon.vue'
import EmptyState from '../components/EmptyState.vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import TaskCardDialog from '../components/dialogs/TaskCardDialog.vue'
import { useTasks } from '../composables/useTasks'
import { useTaskAlerts, type OverviewEntry } from '../composables/useTaskAlerts'
import { formatRelative, formatTime } from '../utils/format'
import {
  addDays,
  boardStats,
  checklistProgress,
  dueHint,
  dueState,
  focusGroups,
  matchCard,
  parseQuickAdd,
  sortCards,
  TASK_COLORS,
  TASK_COLOR_LABELS,
  TASK_FOCUS_LABELS,
  TASK_PRIORITY_LABELS,
  TASK_SORT_LABELS,
  todayStr,
  type TaskDueScope,
  type TaskFilter,
  type TaskSortKey
} from '../utils/taskBoard'
import type { TaskCard, TaskColor, TaskColumn, TaskPriority } from '../types/godot'

const {
  board,
  currentKey,
  projects,
  saveError,
  lastDelete,
  tags,
  cardCount,
  archivedCards,
  init,
  selectBoard,
  addCard,
  updateCard,
  setCardDone,
  setCardsDone,
  setCardDoneOnBoard,
  removeCard,
  undoDelete,
  duplicateCard,
  moveCard,
  moveCards,
  removeCards,
  archiveCard,
  archiveCards,
  archiveDoneCards,
  restoreArchivedCard,
  removeArchivedCard,
  clearArchivedCards,
  addColumn,
  renameColumn,
  setColumnColor,
  removeColumn,
  clearColumn,
  moveColumn
} = useTasks()

onMounted(init)

// 今天只解析一次:截止日状态比较用本地时区(与 taskBoard.todayStr 同口径)
const today = todayStr()

// ---------- 视图与过滤 ----------

type ViewMode = 'board' | 'list' | 'focus' | 'archive'

const viewMode = ref<ViewMode>('board')
const query = ref('')
const activeTags = ref<string[]>([])
const filterPriority = ref<'' | TaskPriority>('')
const dueScope = ref<'' | TaskDueScope>('')
const hideDone = ref(false)
const sortKey = ref<TaskSortKey>('manual')
const sortDir = ref<'asc' | 'desc'>('asc')
const filterOpen = ref(false)
const helpOpen = ref(false)
const searchInput = ref<HTMLInputElement | null>(null)

/** matchCard 条件对象:关键词命中标题/备注/标签/子任务,标签任一命中,优先级,截止日范围,隐藏已完成 */
const cardFilter = computed<TaskFilter>(() => ({
  query: query.value,
  tags: activeTags.value,
  priority: filterPriority.value || undefined,
  dueScope: dueScope.value || undefined,
  hideDone: hideDone.value
}))

/** 聚焦/归档不受「截止日范围/隐藏完成」影响(它们的语义就是未完成 + 紧急度) */
const focusFilter = computed<TaskFilter>(() => ({
  query: query.value,
  tags: activeTags.value,
  priority: filterPriority.value || undefined
}))

function visibleCards(col: TaskColumn): TaskCard[] {
  return col.cards.filter((card) => matchCard(card, cardFilter.value))
}

const activeFilterCount = computed(() => {
  let n = 0
  if (query.value.trim()) n++
  if (activeTags.value.length) n++
  if (filterPriority.value) n++
  if (dueScope.value) n++
  if (hideDone.value) n++
  return n
})

const hasFilter = computed(() => activeFilterCount.value > 0)

function toggleTag(t: string) {
  activeTags.value = activeTags.value.includes(t)
    ? activeTags.value.filter((x) => x !== t)
    : [...activeTags.value, t]
}

function clearFilters() {
  query.value = ''
  activeTags.value = []
  filterPriority.value = ''
  dueScope.value = ''
  hideDone.value = false
}

const dueScopeOptions: { value: '' | TaskDueScope, label: string }[] = [
  { value: '', label: '任何日期' },
  { value: 'overdue', label: '已逾期' },
  { value: 'today', label: '今天' },
  { value: 'soon', label: '未来三天' },
  { value: 'later', label: '更远' },
  { value: 'none', label: '无截止日' }
]

/** 排序键的中文选项(模板里用显式数组,避免把对象 key 当字符串赋给 TaskSortKey) */
const sortOptions = (Object.keys(TASK_SORT_LABELS) as TaskSortKey[]).map((key) => ({
  value: key,
  label: TASK_SORT_LABELS[key]
}))

/** 优先级选项(过滤弹层用;值域窄,避免模板里写 as 断言) */
const priorityOptions: { value: TaskPriority, label: string }[] = [
  { value: 'high', label: TASK_PRIORITY_LABELS.high },
  { value: 'normal', label: TASK_PRIORITY_LABELS.normal },
  { value: 'low', label: TASK_PRIORITY_LABELS.low }
]

// ---------- 看板健康度 ----------

const stats = computed(() => (board.value ? boardStats(board.value, today) : null))
const viewCount = computed(() => {
  if (viewMode.value === 'archive') return archivedCards.value.length
  if (viewMode.value === 'focus') return focusTotal.value
  return cardCount.value
})

// ---------- 快速捕获 ----------
// 顶部捕获条与列尾快加是两套独立状态,变量前缀刻意分开(capture* / colQuick*),
// 避免在同一个 <script setup> 作用域里出现同名声明(曾因此触发 SFC 编译报错)。
const captureTitle = ref('')
const captureInput = ref<HTMLInputElement | null>(null)
const captureColumnId = ref('')

const captureParsed = computed(() => parseQuickAdd(captureTitle.value, today))
const captureTarget = computed(
  () => board.value?.columns.find((c) => c.id === captureColumnId.value) ?? board.value?.columns[0] ?? null
)
const captureValid = computed(() => !!captureParsed.value.title.trim() && !!captureTarget.value)

/** 列变化(切板/删列/建列)时把目标列钳到存在的列上 */
watch(
  () => board.value?.columns.map((c) => c.id).join('|'),
  () => {
    if (!board.value?.columns.some((c) => c.id === captureColumnId.value)) {
      captureColumnId.value = board.value?.columns[0]?.id ?? ''
    }
  },
  { immediate: true }
)

async function submitCapture() {
  const target = captureTarget.value
  if (!captureValid.value || !target) return
  const parsed = captureParsed.value
  await addCard(target.id, {
    title: parsed.title,
    tags: parsed.tags,
    priority: parsed.priority,
    due: parsed.due
  })
  captureTitle.value = ''
  flash(`已添加到「${target.title}」`)
  await nextTick()
  captureInput.value?.focus()
}

function focusCapture() {
  captureInput.value?.focus()
  captureInput.value?.select()
}

function priorityClass(p?: TaskPriority) {
  return p === 'high' ? 'danger' : p === 'low' ? 'muted' : ''
}

// ---------- 轻提示(快速捕获/批量操作/归档反馈) ----------

const flashText = ref('')
let flashTimer: ReturnType<typeof setTimeout> | null = null

function flash(text: string) {
  flashText.value = text
  if (flashTimer) clearTimeout(flashTimer)
  flashTimer = setTimeout(() => {
    flashText.value = ''
    flashTimer = null
  }, 2600)
}

// ---------- 看板切换 ----------

const boardKey = computed({
  get: () => currentKey.value,
  set: (v: string) => {
    selectBoard(v)
  }
})

// 切板后拖拽/菜单/过滤/撤销条/多选都是旧板的东西,全部清掉
watch(currentKey, () => {
  dragCard.value = null
  dragColId.value = null
  drop.value = null
  dropColIdx.value = null
  menuCol.value = null
  cardMenu.value = null
  quickCol.value = null
  query.value = ''
  activeTags.value = []
  filterPriority.value = ''
  dueScope.value = ''
  hideDone.value = false
  clearSelection()
  selectMode.value = false
  batchTargetId.value = ''
})
// 过滤变了,落点指示的 visible 下标已失义
watch([query, activeTags, filterPriority, dueScope, hideDone, sortKey, sortDir], () => {
  drop.value = null
})

// 切视图:收起浮层与多选(多选只服务于看板/列表)
watch(viewMode, () => {
  filterOpen.value = false
  helpOpen.value = false
  cardMenu.value = null
  menuCol.value = null
  dragCard.value = null
  dragColId.value = null
  drop.value = null
  dropColIdx.value = null
  if (viewMode.value === 'focus' || viewMode.value === 'archive') {
    selectMode.value = false
    clearSelection()
  }
  if (viewMode.value === 'focus' && focusScope.value === 'all') refreshAlerts()
})

// ---------- 拖拽(卡片) ----------

const dragCard = ref<string | null>(null)
const dragColId = ref<string | null>(null)
/** 卡片落点:目标列 + 在「过滤后列表」里的插入下标(0..vis.length) */
const drop = ref<{ colId: string, vi: number } | null>(null)
/** 列落点:columns 原数组坐标的插入下标 */
const dropColIdx = ref<number | null>(null)

function onCardDragStart(col: TaskColumn, card: TaskCard, e: DragEvent) {
  dragCard.value = card.id
  dragColId.value = null
  e.dataTransfer?.setData('text/plain', card.id)
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
}

function onCardDragOver(col: TaskColumn, vi: number, e: DragEvent) {
  if (!dragCard.value) return
  e.preventDefault()
  e.stopPropagation() // 别冒泡到列体 dragover(会把落点覆盖成列尾)
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
  const before = e.clientY < r.top + r.height / 2
  setDrop(col.id, vi + (before ? 0 : 1))
}

function onBodyDragOver(col: TaskColumn, e: DragEvent) {
  if (!dragCard.value) return
  e.preventDefault()
  setDrop(col.id, visibleCards(col).length)
}

function setDrop(colId: string, vi: number) {
  const d = drop.value
  if (d && d.colId === colId && d.vi === vi) return
  drop.value = { colId, vi }
}

/** 把过滤后列表里的插入下标映射回原数组坐标(插到锚点卡之前/列尾) */
function onDrop(col: TaskColumn) {
  const cardId = dragCard.value
  const d = drop.value
  if (!cardId || !d || d.colId !== col.id || !board.value) return
  const vis = visibleCards(col)
  const anchor = d.vi < vis.length ? vis[d.vi].id : null
  const toIndex = anchor ? col.cards.findIndex((c) => c.id === anchor) : col.cards.length
  if (toIndex >= 0) moveCard(cardId, col.id, toIndex)
}

function showLine(colId: string, vi: number) {
  const d = drop.value
  return !!d && !!dragCard.value && d.colId === colId && d.vi === vi
}

function onDragEnd() {
  dragCard.value = null
  dragColId.value = null
  drop.value = null
  dropColIdx.value = null
}

// ---------- 拖拽(列头排序) ----------

function onColDragStart(col: TaskColumn, e: DragEvent) {
  dragColId.value = col.id
  dragCard.value = null
  e.dataTransfer?.setData('text/plain', col.id)
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
}

function onColHeadDragOver(col: TaskColumn, e: DragEvent) {
  if (!dragColId.value) return
  e.preventDefault()
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
  const idx = board.value?.columns.findIndex((c) => c.id === col.id) ?? -1
  if (idx < 0) return
  dropColIdx.value = e.clientX < r.left + r.width / 2 ? idx : idx + 1
}

function onColHeadDrop() {
  if (dragColId.value && dropColIdx.value !== null) moveColumn(dragColId.value, dropColIdx.value)
}

// ---------- 卡片:打开 / 完成 / 复制 / 删除 ----------

const dialogOpen = ref(false)
const editing = ref<TaskCard | null>(null)
const editingColumnId = ref('')

function openCard(card: TaskCard, columnId?: string) {
  editingColumnId.value =
    columnId ?? board.value?.columns.find((c) => c.cards.some((k) => k.id === card.id))?.id ?? ''
  editing.value = card
  dialogOpen.value = true
  cardMenu.value = null
}

/** 勾选/取消完成(勾选框在卡片上,别触发打开弹窗) */
function toggleDone(card: TaskCard) {
  setCardDone(card.id, !card.done)
}

function duplicate(card: TaskCard) {
  duplicateCard(card.id)
  flash('已复制卡片')
}

const confirmState = ref<{
  title: string
  message: string
  details?: string[]
  confirmLabel: string
  run: () => void
} | null>(null)

function askDeleteCard(card: TaskCard) {
  cardMenu.value = null
  confirmState.value = {
    title: '删除卡片',
    message: `将删除卡片「${card.title}」,删除后可在提示条里撤销。`,
    confirmLabel: '删除',
    run: () => removeCard(card.id)
  }
}

function runConfirm() {
  const c = confirmState.value
  confirmState.value = null
  c?.run()
}

// ---------- 撤销条:最近一次删除,7 秒后自动作废 ----------

let undoTimer: ReturnType<typeof setTimeout> | null = null
watch(lastDelete, (v) => {
  if (undoTimer) clearTimeout(undoTimer)
  undoTimer = null
  if (v) undoTimer = setTimeout(() => { lastDelete.value = null }, 7000)
})

// ---------- 卡片操作菜单(不用拖拽也能换列) ----------

const cardMenu = ref<{ card: TaskCard, columnId: string, x: number, y: number } | null>(null)

// 菜单里的「移动到」目标:排除卡片当前所在列。模板里直接对可空 ref 调函数会丢失窄化,
// 所以先在这里算好。
const menuOtherColumns = computed(() =>
  (board.value?.columns ?? []).filter((c) => c.id !== cardMenu.value?.columnId)
)

function openCardMenu(card: TaskCard, col: TaskColumn, e: MouseEvent) {
  e.stopPropagation()
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
  const width = 186
  const height = 330
  const x = Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8))
  const y = Math.max(8, Math.min(r.bottom + 6, window.innerHeight - height - 8))
  cardMenu.value = { card, columnId: col.id, x, y }
}

function closeCardMenu() {
  cardMenu.value = null
}

function menuEdit() {
  const m = cardMenu.value
  if (!m) return
  openCard(m.card, m.columnId)
}

async function menuMoveTo(card: TaskCard, col: TaskColumn) {
  cardMenu.value = null
  await moveCard(card.id, col.id, col.cards.length)
  flash(`已移到「${col.title}」`)
}

async function menuArchive(card: TaskCard) {
  cardMenu.value = null
  await archiveCard(card.id)
  flash('已移入归档箱')
}

function menuDuplicate(card: TaskCard) {
  cardMenu.value = null
  duplicate(card)
}

function menuDelete(card: TaskCard) {
  cardMenu.value = null
  askDeleteCard(card)
}

// ---------- 列:菜单 / 新建重命名 / 清空删除 ----------

const menuCol = ref<string | null>(null)
const menuColPos = ref({ x: 0, y: 0 })

// 列菜单可以是任意一列(浮层 Teleport 到 body,避免被列面板的 overflow 裁切)
const menuColumn = computed(
  () => (board.value?.columns ?? []).find((c) => c.id === menuCol.value) ?? null
)

function toggleMenu(colId: string, e: MouseEvent) {
  if (menuCol.value === colId) {
    menuCol.value = null
    return
  }
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
  const width = 168
  const height = 224
  const x = Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8))
  const y = Math.max(8, Math.min(r.bottom + 6, window.innerHeight - height - 8))
  menuColPos.value = { x, y }
  menuCol.value = colId
}

/** 菜单里的操作都从当前 menuColumn 取列,模板里就不用处理可空类型 */
function menuSetColor(color?: TaskColor) {
  const col = menuColumn.value
  if (col) setColumnColor(col.id, color)
}

function menuRename() {
  if (menuColumn.value) openRenameColumn(menuColumn.value)
}

function menuClear() {
  if (menuColumn.value) askClearColumn(menuColumn.value)
}

function menuRemove() {
  if (menuColumn.value) askRemoveColumn(menuColumn.value)
}

const colModal = ref<{ mode: 'create' | 'rename', id: string, title: string } | null>(null)
const colModalInput = ref<HTMLInputElement | null>(null)

watch(colModal, async (m) => {
  if (!m) return
  await nextTick()
  colModalInput.value?.focus()
})

function openCreateColumn() {
  colModal.value = { mode: 'create', id: '', title: '' }
}

function openRenameColumn(col: TaskColumn) {
  menuCol.value = null
  colModal.value = { mode: 'rename', id: col.id, title: col.title }
}

async function saveColModal() {
  const m = colModal.value
  if (!m || !m.title.trim()) return
  const { mode, id, title } = m
  colModal.value = null
  if (mode === 'create') await addColumn(title)
  else await renameColumn(id, title)
}

function askClearColumn(col: TaskColumn) {
  menuCol.value = null
  confirmState.value = {
    title: '清空该列',
    message: `将删除「${col.title}」列的全部 ${col.cards.length} 张卡片,此操作不可撤销。`,
    details: col.cards.map((c) => c.title),
    confirmLabel: '清空',
    run: () => clearColumn(col.id)
  }
}

function askRemoveColumn(col: TaskColumn) {
  menuCol.value = null
  confirmState.value = {
    title: '删除列',
    message: col.cards.length
      ? `将删除「${col.title}」列及其 ${col.cards.length} 张卡片,此操作不可撤销。`
      : `将删除空列「${col.title}」。`,
    confirmLabel: '删除',
    run: () => removeColumn(col.id)
  }
}

// ---------- 列尾快加 ----------

const quickCol = ref<string | null>(null)
const colQuickTitle = ref('')
const colQuickInput = ref<HTMLInputElement | null>(null)

/** 输入框在 v-for 里,字符串 ref 会变成数组;改用函数 ref 才能拿到唯一的那个 input */
function setColQuickInput(el: unknown) {
  colQuickInput.value = el instanceof HTMLInputElement ? el : null
}

async function startQuick(col: TaskColumn) {
  quickCol.value = col.id
  colQuickTitle.value = ''
  await nextTick()
  colQuickInput.value?.focus()
}

function submitColQuick(col: TaskColumn) {
  const title = colQuickTitle.value.trim()
  if (!title) return
  addCard(col.id, { title })
  colQuickTitle.value = ''
  nextTick(() => colQuickInput.value?.focus()) // 保持焦点,便于连续录入
}

function cancelQuick() {
  quickCol.value = null
  colQuickTitle.value = ''
}

// ---------- 列表视图 ----------

const listGroups = computed(() => {
  if (!board.value) return []
  return board.value.columns
    .map((col) => ({ col, cards: sortCards(visibleCards(col), sortKey.value, sortDir.value) }))
    .filter((group) => !hasFilter.value || group.cards.length > 0)
})

function groupDone(col: TaskColumn) {
  return col.cards.filter((c) => c.done === true).length
}

// ---------- 聚焦视图 ----------

const focusScope = ref<'board' | 'all'>('board')
const { overviewEntries, ready: overviewReady, refresh: refreshAlerts } = useTaskAlerts()
const focusLoading = computed(() => focusScope.value === 'all' && !overviewReady.value)
const focusCollapsed = ref<Record<string, boolean>>({ unscheduled: true })

interface FocusRow {
  card: TaskCard
  columnTitle: string
  columnId?: string
  boardName?: string
  boardKey?: string
  source: 'board' | 'all'
}

const focusSections = computed(() => {
  if (focusScope.value === 'board') {
    if (!board.value) return []
    return focusGroups(board.value, today)
      .map((group) => ({
        key: group.key,
        label: TASK_FOCUS_LABELS[group.key],
        rows: group.entries
          .filter((entry) => matchCard(entry.card, focusFilter.value))
          .map<FocusRow>((entry) => ({
            card: entry.card,
            columnTitle: entry.columnTitle,
            columnId: entry.columnId,
            source: 'board'
          }))
      }))
      .filter((group) => group.rows.length > 0)
  }
  const sections: { key: OverviewEntry['section'], label: string }[] = [
    { key: 'overdue', label: '已逾期' },
    { key: 'today', label: '今日到期' },
    { key: 'soon', label: '三天内到期' }
  ]
  return sections
    .map((section) => ({
      key: section.key,
      label: section.label,
      rows: overviewEntries.value
        .filter((entry) => entry.section === section.key && matchCard(entry.card, focusFilter.value))
        .map<FocusRow>((entry) => ({
          card: entry.card,
          columnTitle: '跨看板',
          boardName: entry.boardName,
          boardKey: entry.boardKey,
          source: 'all'
        }))
    }))
    .filter((section) => section.rows.length > 0)
})

const focusTotal = computed(() => focusSections.value.reduce((sum, section) => sum + section.rows.length, 0))

function toggleFocusSection(key: string) {
  focusCollapsed.value = { ...focusCollapsed.value, [key]: !focusCollapsed.value[key] }
}

function isFocusCollapsed(key: string) {
  return !!focusCollapsed.value[key]
}

async function completeFocusRow(row: FocusRow) {
  if (row.source === 'board') {
    await setCardDone(row.card.id, true)
  } else if (row.boardKey) {
    await setCardDoneOnBoard(row.boardKey, row.card.id, true)
    await refreshAlerts()
  }
}

function openFocusRow(row: FocusRow) {
  if (row.source === 'board') {
    openCard(row.card, row.columnId)
    return
  }
  if (row.boardKey) {
    gotoCard({ boardKey: row.boardKey, boardName: row.boardName ?? '', card: row.card, section: 'overdue' } as OverviewEntry)
  }
}

async function snoozeFocusRow(row: FocusRow) {
  if (row.source !== 'board') return
  await updateCard(row.card.id, { due: addDays(today, 1) })
  flash('已推迟到明天')
}

watch(focusScope, (scope) => {
  if (scope === 'all') refreshAlerts()
})

// ---------- 跨板总览跳转(沿用原行为:清过滤、切板、高亮目标卡) ----------

const highlightId = ref<string | null>(null)

async function gotoCard(e: OverviewEntry) {
  clearFilters()
  selectMode.value = false
  clearSelection()
  viewMode.value = 'board'
  await selectBoard(e.boardKey)
  highlightId.value = e.card.id
  await nextTick()
  const smooth = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
  document.querySelector(`[data-card-id="${e.card.id}"]`)?.scrollIntoView({ block: 'center', behavior: smooth })
  setTimeout(() => {
    if (highlightId.value === e.card.id) highlightId.value = null
  }, 2400)
}

// ---------- 归档视图 ----------

const archivedVisible = computed(() => {
  const list = archivedCards.value.filter((card) => {
    if (query.value.trim() && !matchCard(card, { query: query.value })) return false
    if (activeTags.value.length && !matchCard(card, { tags: activeTags.value })) return false
    if (filterPriority.value && !matchCard(card, { priority: filterPriority.value })) return false
    return true
  })
  return [...list].sort((a, b) => (b.archivedAt || 0) - (a.archivedAt || 0))
})

function archiveOrigin(card: TaskCard) {
  if (!board.value) return '—'
  if (!card.archivedFrom) return '未记录'
  return board.value.columns.find((c) => c.id === card.archivedFrom)?.title ?? '原列已删除'
}

async function restoreArchived(card: TaskCard) {
  const ok = await restoreArchivedCard(card.id)
  if (ok) flash(`已恢复「${card.title}」`)
  else flash(board.value?.columns.length ? '恢复失败,请稍后重试' : '还没有列,先新建一列再恢复')
}

function askDeleteArchived(card: TaskCard) {
  confirmState.value = {
    title: '永久删除归档卡片',
    message: `将彻底删除归档卡片「${card.title}」,此操作不可恢复。`,
    confirmLabel: '永久删除',
    run: () => removeArchivedCard(card.id)
  }
}

function askClearArchive() {
  confirmState.value = {
    title: '清空归档箱',
    message: `将永久删除归档箱里的 ${archivedCards.value.length} 张卡片,此操作不可恢复。`,
    details: archivedCards.value.map((c) => c.title),
    confirmLabel: '清空',
    run: () => clearArchivedCards()
  }
}

async function archiveAllDone() {
  const n = await archiveDoneCards()
  flash(n ? `已归档 ${n} 张已完成卡片` : '没有已完成卡片可归档')
}

// ---------- 多选与批量操作 ----------

const selectMode = ref(false)
const selectedIds = ref<string[]>([])
const batchTargetId = ref('')
const batchBusy = ref(false)

function toggleSelectMode() {
  selectMode.value = !selectMode.value
  if (!selectMode.value) clearSelection()
}

function isSelected(id: string) {
  return selectedIds.value.includes(id)
}

function toggleSelect(id: string) {
  selectedIds.value = selectedIds.value.includes(id)
    ? selectedIds.value.filter((x) => x !== id)
    : [...selectedIds.value, id]
}

function clearSelection() {
  selectedIds.value = []
}

function selectAllVisible() {
  if (!board.value) return
  selectedIds.value = board.value.columns.flatMap((col) => visibleCards(col).map((card) => card.id))
}

function selectGroup(col: TaskColumn) {
  const ids = visibleCards(col).map((card) => card.id)
  const all = ids.every((id) => selectedIds.value.includes(id))
  selectedIds.value = all
    ? selectedIds.value.filter((id) => !ids.includes(id))
    : [...new Set([...selectedIds.value, ...ids])]
}

function onCardClick(card: TaskCard, colId: string) {
  if (selectMode.value) toggleSelect(card.id)
  else openCard(card, colId)
}

const selectedCount = computed(() => selectedIds.value.length)

async function batchSetDone(done: boolean) {
  if (!selectedCount.value || batchBusy.value) return
  batchBusy.value = true
  await setCardsDone(selectedIds.value, done)
  batchBusy.value = false
  flash(done ? `已完成 ${selectedCount.value} 张` : `已取消完成 ${selectedCount.value} 张`)
  clearSelection()
}

async function batchMove() {
  if (!batchTargetId.value || !selectedCount.value || batchBusy.value) return
  const target = board.value?.columns.find((c) => c.id === batchTargetId.value)
  if (!target) return
  batchBusy.value = true
  await moveCards(selectedIds.value, batchTargetId.value)
  batchBusy.value = false
  flash(`已移动 ${selectedCount.value} 张到「${target.title}」`)
  clearSelection()
  batchTargetId.value = ''
}

async function batchArchive() {
  if (!selectedCount.value || batchBusy.value) return
  batchBusy.value = true
  await archiveCards(selectedIds.value)
  batchBusy.value = false
  flash(`已归档 ${selectedCount.value} 张`)
  clearSelection()
}

function askBatchDelete() {
  if (!selectedCount.value) return
  const ids = [...selectedIds.value]
  confirmState.value = {
    title: '批量删除卡片',
    message: `将删除选中的 ${ids.length} 张卡片,此操作不可撤销。`,
    details: ids
      .map((id) => board.value?.columns.flatMap((c) => c.cards).find((c) => c.id === id)?.title)
      .filter((t): t is string => !!t),
    confirmLabel: '批量删除',
    run: () => {
      clearSelection()
      void removeCards(ids)
    }
  }
}

// ---------- 展示辅助 ----------

/** 卡片/列颜色 → CSS 变量(--task-color 指向主题化的 --task-c-<key>;无色不绑) */
function colorStyle(color: string | undefined): Record<string, string> | undefined {
  return color ? { '--task-color': `var(--task-c-${color})` } : undefined
}

function dueCls(card: TaskCard) {
  const s = dueState(card.due, today)
  return s === 'overdue' ? 'over' : s === 'today' ? 'today' : s === 'soon' ? 'soon' : ''
}

function cardDueText(card: TaskCard) {
  return dueHint(card.due, today)
}

function progressOf(card: TaskCard) {
  return checklistProgress(card)
}

/** 备注摘要:取第一行非空文字,过长截断(卡片上只做预览,完整内容在详情弹窗/悬停提示) */
function notesPreview(notes?: string): string {
  const line = (notes || '').split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? ''
  return line.length > 48 ? `${line.slice(0, 48)}…` : line
}

function columnOfCard(cardId: string) {
  return board.value?.columns.find((c) => c.cards.some((k) => k.id === cardId) ?? false)?.title ?? ''
}

// ---------- 全局监听:点外关浮层 / 键盘快捷键 ----------

function onDocClick(e: MouseEvent) {
  const el = e.target as HTMLElement | null
  if (menuCol.value && !el?.closest('.col-menu') && !el?.closest('.tcol-more')) menuCol.value = null
  if (cardMenu.value && !el?.closest('.task-card-menu') && !el?.closest('.tcard-more')) cardMenu.value = null
  if (filterOpen.value && !el?.closest('.filter-wrap')) filterOpen.value = false
  if (helpOpen.value && !el?.closest('.help-wrap')) helpOpen.value = false
}

/** 面板滚动/窗口尺寸变化时关闭固定定位的浮层,避免菜单与触发点脱节 */
function closeFloatingMenus() {
  menuCol.value = null
  cardMenu.value = null
}

function isTypingTarget(el: EventTarget | null): boolean {
  const node = el as HTMLElement | null
  if (!node) return false
  const tag = node.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || node.isContentEditable
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    if (confirmState.value) {
      confirmState.value = null
      return
    }
    if (colModal.value) {
      colModal.value = null
      return
    }
    if (cardMenu.value || filterOpen.value || helpOpen.value || menuCol.value) {
      cardMenu.value = null
      filterOpen.value = false
      helpOpen.value = false
      menuCol.value = null
      return
    }
    if (selectedCount.value) {
      clearSelection()
      return
    }
  }
  if (dialogOpen.value || confirmState.value || colModal.value) return
  if (isTypingTarget(e.target)) return
  if (e.ctrlKey || e.metaKey || e.altKey) return
  const key = e.key.toLowerCase()
  if (key === 'n') {
    e.preventDefault()
    focusCapture()
  } else if (key === '/') {
    e.preventDefault()
    searchInput.value?.focus()
  } else if (key === '1') viewMode.value = 'board'
  else if (key === '2') viewMode.value = 'list'
  else if (key === '3') viewMode.value = 'focus'
  else if (key === '4') viewMode.value = 'archive'
}

onMounted(() => {
  document.addEventListener('click', onDocClick)
  window.addEventListener('keydown', onKey)
  window.addEventListener('resize', closeFloatingMenus)
  window.addEventListener('scroll', closeFloatingMenus, true)
})

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick)
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('resize', closeFloatingMenus)
  window.removeEventListener('scroll', closeFloatingMenus, true)
  if (undoTimer) clearTimeout(undoTimer)
  if (flashTimer) clearTimeout(flashTimer)
})
</script>

<template>
  <div class="tasks view">
    <!-- ---------- 页头:看板名 + 健康度脉搏 + 看板选择 ---------- -->
    <header class="task-hero">
      <div class="hero-main">
        <div class="hero-title">
          <h2><Icon name="kanban" :size="18" /> 任务工作台</h2>
          <span class="count-pill">{{ viewCount }}</span>
          <span
            v-if="stats && stats.overdue"
            class="count-pill due-pill"
            :title="`当前看板未完成卡片中,逾期 ${stats.overdue} 项`"
          >逾期 {{ stats.overdue }}</span>
        </div>
        <div v-if="stats" class="hero-pulse">
          <span class="pulse-item danger" :title="`逾期 ${stats.overdue} 项`">
            <span class="pulse-num">{{ stats.overdue }}</span>逾期
          </span>
          <span class="pulse-item warn" :title="`今日到期 ${stats.today} 项`">
            <span class="pulse-num">{{ stats.today }}</span>今日
          </span>
          <span class="pulse-item" :title="`未来三天到期 ${stats.soon} 项`">
            <span class="pulse-num">{{ stats.soon }}</span>三天内
          </span>
          <span class="pulse-item muted" :title="`未完成 ${stats.active} 项 / 共 ${stats.total} 项`">
            <span class="pulse-num">{{ stats.active }}</span>未完成
          </span>
          <span v-if="stats.archived" class="pulse-item muted">
            <span class="pulse-num">{{ stats.archived }}</span>归档
          </span>
        </div>
      </div>
      <div class="hero-side">
        <div
          class="stat-ring"
          :style="{ '--pct': `${stats?.pct ?? 0}%` }"
          :title="`完成率 ${stats?.pct ?? 0}%(${stats?.done ?? 0}/${stats?.total ?? 0})`"
        >
          <span class="stat-ring-num">{{ stats?.pct ?? 0 }}<small>%</small></span>
          <span class="stat-ring-label">完成率</span>
        </div>
        <select v-model="boardKey" class="select board-select" title="选择看板(通用或某个项目)">
          <option value="global">通用看板</option>
          <optgroup v-if="projects.length" label="项目">
            <option v-for="p in projects" :key="p._id" :value="p._id">{{ p.name }}</option>
          </optgroup>
        </select>
      </div>
    </header>

    <!-- ---------- 快速捕获:一条输入 + 轻量语法预览 ---------- -->
    <div class="capture card">
      <Icon name="zap" :size="16" class="capture-ico" />
      <input
        ref="captureInput"
        v-model="captureTitle"
        class="input capture-input"
        placeholder="记下一件事,回车添加…#标签 @明天 !高"
        aria-label="快速添加任务"
        @keydown.enter.prevent="submitCapture"
      />
      <div v-if="captureParsed.tags.length || captureParsed.priority || captureParsed.due" class="capture-chips">
        <span
          v-if="captureParsed.priority"
          class="tag"
          :class="captureParsed.priority === 'high' ? 'danger' : captureParsed.priority === 'low' ? '' : 'brand'"
        >{{ TASK_PRIORITY_LABELS[captureParsed.priority] }}优先级</span>
        <span v-if="captureParsed.due" class="capture-chip">
          <Icon name="clock" :size="11" /> {{ dueHint(captureParsed.due, today) }}
        </span>
        <span v-for="t in captureParsed.tags" :key="t" class="capture-chip">
          <Icon name="tag" :size="10" /> {{ t }}
        </span>
      </div>
      <select v-model="captureColumnId" class="select capture-target" title="添加到哪一列" :disabled="!board?.columns.length">
        <option v-for="c in board?.columns ?? []" :key="c.id" :value="c.id">{{ c.title }}</option>
      </select>
      <button type="button" class="btn primary small capture-submit" :disabled="!captureValid" @click="submitCapture">
        <Icon name="plus" :size="13" /> 添加
      </button>
    </div>
    <div v-if="!captureTitle" class="capture-tip">
      <span class="kbd">#标签</span>
      <span class="kbd">@今天</span>
      <span class="kbd">@+3</span>
      <span class="kbd">!高</span>
      直接写在输入框里,不用打开弹窗。
    </div>

    <!-- ---------- 视图切换 / 搜索 / 筛选 / 排序 ---------- -->
    <div class="work-bar">
      <div class="seg view-tabs" role="tablist" aria-label="视图切换">
        <button
          type="button"
          role="tab"
          :aria-selected="viewMode === 'board'"
          :class="{ on: viewMode === 'board' }"
          title="看板视图(1)"
          @click="viewMode = 'board'"
        ><Icon name="kanban" :size="12" /> 看板</button>
        <button
          type="button"
          role="tab"
          :aria-selected="viewMode === 'list'"
          :class="{ on: viewMode === 'list' }"
          title="列表视图(2)"
          @click="viewMode = 'list'"
        ><Icon name="list" :size="12" /> 列表</button>
        <button
          type="button"
          role="tab"
          :aria-selected="viewMode === 'focus'"
          :class="{ on: viewMode === 'focus' }"
          title="聚焦视图(3)"
          @click="viewMode = 'focus'"
        ><Icon name="inbox" :size="12" /> 聚焦</button>
        <button
          type="button"
          role="tab"
          :aria-selected="viewMode === 'archive'"
          :class="{ on: viewMode === 'archive' }"
          title="归档箱(4)"
          @click="viewMode = 'archive'"
        ><Icon name="archive" :size="12" /> 归档</button>
      </div>

      <span class="grow"></span>

      <label class="search-box">
        <Icon name="search" :size="13" />
        <input ref="searchInput" v-model="query" class="input" placeholder="搜索标题 / 备注 / 子任务…" aria-label="搜索任务" />
        <button v-if="query" type="button" class="search-clear" title="清空搜索" @click.prevent="query = ''">
          <Icon name="x" :size="11" />
        </button>
      </label>

      <div v-if="viewMode === 'list'" class="sort-wrap">
        <select v-model="sortKey" class="select sort-select" title="列表排序方式">
          <option v-for="o in sortOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>
        <button
          type="button"
          class="btn small ghost sort-dir"
          :title="sortDir === 'asc' ? '当前升序,点击切为降序' : '当前降序,点击切为升序'"
          @click="sortDir = sortDir === 'asc' ? 'desc' : 'asc'"
        >
          <Icon :name="sortDir === 'asc' ? 'chevron-up' : 'chevron-down'" :size="13" />
        </button>
      </div>

      <div class="filter-wrap">
        <button
          type="button"
          class="btn small ghost filter-btn"
          :class="{ on: filterOpen || hasFilter }"
          title="筛选任务"
          @click.stop="filterOpen = !filterOpen"
        >
          <Icon name="filter" :size="13" /> 筛选
          <span v-if="activeFilterCount" class="filter-dot">{{ activeFilterCount }}</span>
        </button>
        <div v-if="filterOpen" class="filter-pop card">
          <div class="fp-head">
            <span><Icon name="filter" :size="12" /> 筛选条件</span>
            <span class="grow"></span>
            <button v-if="hasFilter" type="button" class="fp-clear" @click="clearFilters">清除全部</button>
          </div>

          <div class="fp-block">
            <div class="fp-label">优先级</div>
            <div class="seg fp-seg" role="group" aria-label="按优先级筛选">
              <button type="button" :class="{ on: filterPriority === '' }" @click="filterPriority = ''">全部</button>
              <button
                v-for="o in priorityOptions"
                :key="o.value"
                type="button"
                :class="{ on: filterPriority === o.value }"
                @click="filterPriority = o.value"
              >{{ o.label }}</button>
            </div>
          </div>

          <div class="fp-block">
            <div class="fp-label">截止日</div>
            <select v-model="dueScope" class="select fp-select">
              <option v-for="o in dueScopeOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
            </select>
          </div>

          <div class="fp-block">
            <label class="open-row fp-check">
              <input v-model="hideDone" type="checkbox" class="chk" />
              <span>隐藏已完成卡片</span>
            </label>
          </div>

          <div v-if="tags.length" class="fp-block">
            <div class="fp-label"><Icon name="tag" :size="11" /> 标签</div>
            <div class="fp-tags">
              <button
                v-for="t in tags"
                :key="t"
                type="button"
                class="chip fp-chip"
                :class="{ on: activeTags.includes(t) }"
                @click="toggleTag(t)"
              >{{ t }}</button>
            </div>
          </div>

          <div v-if="viewMode === 'list'" class="fp-block">
            <div class="fp-label">排序</div>
            <div class="fp-sort">
              <select v-model="sortKey" class="select fp-select">
                <option v-for="o in sortOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
              </select>
              <button
                type="button"
                class="btn small ghost"
                @click="sortDir = sortDir === 'asc' ? 'desc' : 'asc'"
              >{{ sortDir === 'asc' ? '升序' : '降序' }}</button>
            </div>
          </div>
        </div>
      </div>

      <button
        v-if="viewMode === 'board' || viewMode === 'list'"
        type="button"
        class="btn small ghost select-mode-btn"
        :class="{ on: selectMode }"
        :title="selectMode ? '退出多选' : '进入多选(批量完成 / 移动 / 归档 / 删除)'"
        @click="toggleSelectMode"
      >
        <Icon name="check" :size="13" /> {{ selectMode ? '退出多选' : '多选' }}
      </button>

      <div class="help-wrap">
        <button
          type="button"
          class="btn small ghost help-btn"
          title="键盘快捷键"
          aria-label="键盘快捷键"
          @click.stop="helpOpen = !helpOpen"
        ><Icon name="terminal" :size="13" /></button>
        <div v-if="helpOpen" class="help-pop card">
          <div class="help-title">键盘快捷键</div>
          <div class="help-row"><span class="kbd">N</span><span>聚焦快速捕获</span></div>
          <div class="help-row"><span class="kbd">/</span><span>聚焦搜索框</span></div>
          <div class="help-row"><span class="kbd">1</span>–<span class="kbd">4</span><span>切换四种视图</span></div>
          <div class="help-row"><span class="kbd">Esc</span><span>关闭浮层 / 退出多选</span></div>
          <div class="help-row"><span class="kbd">Ctrl</span>+<span class="kbd">Enter</span><span>卡片弹窗内保存</span></div>
        </div>
      </div>
    </div>

    <!-- 已生效的过滤条件(点 chip 可单独移除) -->
    <div v-if="hasFilter" class="filter-summary">
      <span class="fs-label"><Icon name="filter" :size="11" /> 筛选中</span>
      <button v-if="query" type="button" class="chip fs-chip" @click="query = ''">
        “{{ query }}” <Icon name="x" :size="10" />
      </button>
      <button
        v-for="t in activeTags"
        :key="t"
        type="button"
        class="chip fs-chip on"
        @click="toggleTag(t)"
      >#{{ t }} <Icon name="x" :size="10" /></button>
      <button v-if="filterPriority" type="button" class="chip fs-chip" @click="filterPriority = ''">
        {{ TASK_PRIORITY_LABELS[filterPriority] }}优先级 <Icon name="x" :size="10" />
      </button>
      <button v-if="dueScope" type="button" class="chip fs-chip" @click="dueScope = ''">
        {{ dueScopeOptions.find((o) => o.value === dueScope)?.label }} <Icon name="x" :size="10" />
      </button>
      <button v-if="hideDone" type="button" class="chip fs-chip" @click="hideDone = false">
        隐藏已完成 <Icon name="x" :size="10" />
      </button>
      <button type="button" class="fs-clear" @click="clearFilters">清除全部</button>
    </div>

    <div v-if="saveError" class="save-error">
      <Icon name="alert" :size="13" /> {{ saveError }}
    </div>

    <!-- 撤销条:最近一次删除的卡片,7 秒后自动作废 -->
    <div v-if="lastDelete && (viewMode === 'board' || viewMode === 'list')" class="undo-bar">
      <Icon name="trash" :size="13" />
      <span class="undo-text">已删除「{{ lastDelete.card.title }}」</span>
      <button type="button" class="undo-btn" title="把卡片放回原位" @click="undoDelete">
        <Icon name="refresh" :size="12" /> 撤销
      </button>
    </div>

    <!-- ---------- 看板视图:拖拽卡片与列 + 卡片操作菜单 ---------- -->
    <template v-if="viewMode === 'board'">
      <EmptyState v-if="!board" icon="kanban" title="正在载入看板…" />

      <EmptyState
        v-else-if="board.columns.length === 0"
        icon="kanban"
        title="还没有列"
        desc="先把流程拆成几列,例如 待办 / 进行中 / 已完成。"
      >
        <button type="button" class="btn primary" @click="openCreateColumn">
          <Icon name="plus" :size="14" /> 新建列
        </button>
      </EmptyState>

      <div v-else class="board" :class="{ 'col-dragging': !!dragColId }" @scroll.passive="closeFloatingMenus">
        <section
          v-for="(col, ci) in board.columns"
          :key="col.id"
          class="tcol panel"
          :class="{
            'drop-left': !!dragColId && dropColIdx === ci,
            'drop-right': !!dragColId && dropColIdx === ci + 1,
            'has-color': !!col.color
          }"
          :style="colorStyle(col.color)"
        >
          <header
            class="tcol-head"
            :class="{ dragging: dragColId === col.id }"
            draggable="true"
            title="拖动列头可调整列顺序"
            @dragstart="onColDragStart(col, $event)"
            @dragover="onColHeadDragOver(col, $event)"
            @drop.prevent="onColHeadDrop"
            @dragend="onDragEnd"
          >
            <span
              v-if="col.color"
              class="tcol-dot"
              :title="`列颜色:${TASK_COLOR_LABELS[col.color]}`"
            ></span>
            <span class="tcol-title" :title="col.title">{{ col.title }}</span>
            <span
              class="count-pill"
              :title="`${visibleCards(col).length} 张可见${groupDone(col) ? `,${groupDone(col)} 张已完成` : ''}`"
            >{{ visibleCards(col).length }}</span>
            <button
              type="button"
              class="btn small ghost icon-btn tcol-add"
              title="在此列添加卡片"
              @click.stop="startQuick(col)"
            >
              <Icon name="plus" :size="13" />
            </button>
            <button
              type="button"
              class="btn small ghost icon-btn tcol-more"
              title="列操作:重命名 / 颜色 / 清空 / 删除列"
              @click.stop="toggleMenu(col.id, $event)"
            >
              <Icon name="more" :size="14" />
            </button>
          </header>

          <div class="tcol-body" @dragover="onBodyDragOver(col, $event)" @drop.prevent="onDrop(col)">
            <template v-for="(card, vi) in visibleCards(col)" :key="card.id">
              <div v-if="showLine(col.id, vi)" class="drop-line"></div>
              <article
                class="tcard card"
                :class="{
                  dragging: dragCard === card.id,
                  done: card.done,
                  'has-color': !!card.color,
                  highlight: highlightId === card.id,
                  sel: selectMode && isSelected(card.id)
                }"
                :style="colorStyle(card.color)"
                :data-card-id="card.id"
                draggable="true"
                @dragstart="onCardDragStart(col, card, $event)"
                @dragover="onCardDragOver(col, vi, $event)"
                @drop.stop.prevent="onDrop(col)"
                @dragend="onDragEnd"
                @click="onCardClick(card, col.id)"
              >
                <div class="tcard-top">
                  <button
                    type="button"
                    class="tcard-check"
                    :class="{ on: card.done }"
                    :title="card.done ? '标记未完成' : '标记完成'"
                    @click.stop="toggleDone(card)"
                  >
                    <Icon name="check" :size="11" />
                  </button>
                  <span
                    v-if="card.priority"
                    class="tag tcard-prio"
                    :class="card.priority === 'high' ? 'danger' : card.priority === 'low' ? 'faint' : ''"
                    :title="`优先级:${TASK_PRIORITY_LABELS[card.priority]}`"
                  >{{ TASK_PRIORITY_LABELS[card.priority] }}</span>
                  <span v-if="card.due" class="tcard-due" :class="dueCls(card)" :title="card.due">
                    <Icon name="clock" :size="11" /> {{ cardDueText(card) }}
                  </span>
                  <span class="grow"></span>
                  <span v-if="selectMode" class="sel-tick" :class="{ on: isSelected(card.id) }" title="已选中">
                    <Icon name="check" :size="10" />
                  </span>
                  <button
                    type="button"
                    class="tcard-more"
                    title="卡片操作:编辑 / 移动 / 复制 / 归档 / 删除"
                    @click.stop="openCardMenu(card, col, $event)"
                  >
                    <Icon name="more" :size="13" />
                  </button>
                </div>
                <div class="tcard-title" :title="card.title">{{ card.title }}</div>

                <div v-if="progressOf(card).total" class="tcard-subtasks">
                  <div class="bar tcard-bar">
                    <div class="fill" :style="{ width: `${progressOf(card).pct}%` }"></div>
                  </div>
                  <span class="tcard-subnum" :title="`子任务 ${progressOf(card).done}/${progressOf(card).total}`">
                    <Icon name="check" :size="10" /> {{ progressOf(card).done }}/{{ progressOf(card).total }}
                  </span>
                </div>

                <div v-if="card.notes && notesPreview(card.notes)" class="tcard-notes-line" :title="card.notes">
                  <Icon name="list" :size="11" />
                  <span class="tcard-notes-text">{{ notesPreview(card.notes) }}</span>
                </div>

                <div v-if="card.tags?.length || card.updatedAt" class="tcard-bottom">
                  <span v-if="card.tags?.length" class="tcard-tags">
                    <span v-for="t in card.tags.slice(0, 2)" :key="t" class="tcard-tag">{{ t }}</span>
                    <span
                      v-if="card.tags.length > 2"
                      class="tcard-tag extra"
                      :title="card.tags.join('、')"
                    >+{{ card.tags.length - 2 }}</span>
                  </span>
                  <span class="grow"></span>
                  <span
                    v-if="card.updatedAt"
                    class="tcard-time"
                    :title="`最后更新 ${formatTime(card.updatedAt)}`"
                  >
                    <Icon name="clock" :size="10" /> {{ formatRelative(card.updatedAt) }}
                  </span>
                </div>
              </article>
            </template>

            <div v-if="showLine(col.id, visibleCards(col).length)" class="drop-line"></div>
            <div v-if="!visibleCards(col).length" class="tcol-empty">
              {{ col.cards.length ? '没有匹配的卡片' : '拖卡片到这里,或点右上角 + 添加' }}
            </div>
          </div>

          <div class="tcol-foot">
            <input
              v-if="quickCol === col.id"
              :ref="setColQuickInput"
              v-model="colQuickTitle"
              class="input quick-input"
              placeholder="卡片标题,Enter 添加"
              @keydown.enter.prevent="submitColQuick(col)"
              @keydown.esc.prevent="cancelQuick"
              @blur="cancelQuick"
            />
            <button v-else type="button" class="quick-add" @click="startQuick(col)">
              <Icon name="plus" :size="13" /> 添加卡片
            </button>
          </div>
        </section>

        <section class="tcol addcol">
          <button type="button" class="btn small ghost" @click="openCreateColumn">
            <Icon name="plus" :size="13" /> 新建列
          </button>
        </section>
      </div>
    </template>

    <!-- ---------- 列表视图:按列分组 + 可排序 + 行内完成 ---------- -->
    <template v-if="viewMode === 'list'">
      <EmptyState v-if="!board" icon="list" title="正在载入看板…" />

      <EmptyState
        v-else-if="board.columns.length === 0"
        icon="kanban"
        title="还没有列"
        desc="列表视图按列分组,先建一列再往里放卡片。"
      >
        <button type="button" class="btn primary" @click="openCreateColumn">
          <Icon name="plus" :size="14" /> 新建列
        </button>
      </EmptyState>

      <EmptyState
        v-else-if="!listGroups.length"
        icon="check"
        title="没有匹配的卡片"
        desc="换个关键词,或者清除筛选条件。"
      >
        <button type="button" class="btn ghost" @click="clearFilters">清除筛选</button>
      </EmptyState>

      <div v-else class="list-wrap">
        <section v-for="group in listGroups" :key="group.col.id" class="list-group">
          <header class="list-head">
            <span class="list-dot" :style="colorStyle(group.col.color)"></span>
            <h3>{{ group.col.title }}</h3>
            <span class="count-pill">{{ group.cards.length }}</span>
            <span v-if="groupDone(group.col)" class="list-done">{{ groupDone(group.col) }} 已完成</span>
            <span class="grow"></span>
            <button
              v-if="selectMode && group.cards.length"
              type="button"
              class="list-select"
              @click="selectGroup(group.col)"
            >
              {{ visibleCards(group.col).every((c) => isSelected(c.id)) ? '取消全选' : '全选本列' }}
            </button>
          </header>

          <article
            v-for="card in group.cards"
            :key="card.id"
            class="lrow card"
            :class="{
              done: card.done,
              'has-color': !!card.color,
              highlight: highlightId === card.id,
              sel: selectMode && isSelected(card.id)
            }"
            :style="colorStyle(card.color)"
            :data-card-id="card.id"
            @click="onCardClick(card, group.col.id)"
          >
            <button
              type="button"
              class="tcard-check"
              :class="{ on: card.done }"
              :title="card.done ? '标记未完成' : '标记完成'"
              @click.stop="toggleDone(card)"
            >
              <Icon name="check" :size="11" />
            </button>
            <span v-if="card.priority === 'high'" class="tag danger">高</span>
            <span v-else-if="card.priority === 'low'" class="tag">低</span>

            <div class="lrow-main">
              <span class="lrow-title">{{ card.title }}</span>
              <span v-if="card.notes" class="lrow-notes" :title="card.notes">{{ card.notes }}</span>
              <span v-if="card.tags?.length" class="lrow-tags">
                <span v-for="t in card.tags" :key="t" class="tcard-tag">{{ t }}</span>
              </span>
            </div>

            <span
              v-if="progressOf(card).total"
              class="lrow-check"
              :title="`子任务 ${progressOf(card).done}/${progressOf(card).total}`"
            >
              <Icon name="check" :size="10" /> {{ progressOf(card).done }}/{{ progressOf(card).total }}
            </span>
            <span v-if="card.due" class="tcard-due" :class="dueCls(card)" :title="card.due">
              <Icon name="clock" :size="11" /> {{ cardDueText(card) }}
            </span>
            <span v-if="selectMode" class="sel-tick" :class="{ on: isSelected(card.id) }" title="已选中">
              <Icon name="check" :size="10" />
            </span>
            <button
              type="button"
              class="tcard-more"
              title="卡片操作:编辑 / 移动 / 复制 / 归档 / 删除"
              @click.stop="openCardMenu(card, group.col, $event)"
            >
              <Icon name="more" :size="13" />
            </button>
          </article>

          <div v-if="!group.cards.length" class="list-empty">本列还没有卡片</div>
        </section>
      </div>
    </template>

    <!-- ---------- 聚焦视图:按「现在该做什么」分桶,可切全部看板 ---------- -->
    <div v-if="viewMode === 'focus'" class="focus-wrap">
      <div class="focus-bar">
        <div class="seg focus-scope" role="group" aria-label="聚焦范围">
          <button type="button" :class="{ on: focusScope === 'board' }" @click="focusScope = 'board'">当前看板</button>
          <button type="button" :class="{ on: focusScope === 'all' }" @click="focusScope = 'all'">全部看板</button>
        </div>
        <span class="focus-hint">
          <template v-if="focusScope === 'board'">只看当前看板,按 逾期 → 今天 → 未来三天 → 未排期 排序</template>
          <template v-else>扫描全部看板 · {{ overviewEntries.length }} 条到期提醒</template>
        </span>
        <span class="grow"></span>
        <button type="button" class="btn small ghost" title="重新扫描到期卡片" @click="refreshAlerts">
          <Icon name="refresh" :size="13" /> 刷新
        </button>
      </div>

      <EmptyState v-if="focusLoading" icon="inbox" title="正在汇总各看板…" />
      <EmptyState
        v-else-if="!focusSections.length"
        icon="check"
        title="现在没有需要处理的"
        desc="逾期、今天和三天内到期的未完成卡片都会出现在这里。"
      />

      <div v-else class="focus-sections">
        <section v-for="sec in focusSections" :key="sec.key" class="focus-sec">
          <header class="focus-head" :class="sec.key" @click="toggleFocusSection(sec.key)">
            <Icon :name="isFocusCollapsed(sec.key) ? 'chevron-right' : 'chevron-down'" :size="13" />
            <h3>{{ sec.label }}</h3>
            <span class="count-pill">{{ sec.rows.length }}</span>
            <span class="grow"></span>
            <span class="focus-toggle">{{ isFocusCollapsed(sec.key) ? '展开' : '收起' }}</span>
          </header>

          <div v-show="!isFocusCollapsed(sec.key)" class="focus-rows">
            <article
              v-for="row in sec.rows"
              :key="`${row.boardKey ?? ''}/${row.card.id}`"
              class="frow card"
              :class="{ done: row.card.done, 'has-color': !!row.card.color }"
              :style="colorStyle(row.card.color)"
            >
              <button
                type="button"
                class="tcard-check"
                title="标记完成"
                @click.stop="completeFocusRow(row)"
              >
                <Icon name="check" :size="11" />
              </button>

              <div class="frow-main" @click="openFocusRow(row)">
                <span class="frow-title">{{ row.card.title }}</span>
                <span class="frow-meta">
                  <span class="frow-src">
                    <Icon :name="row.source === 'all' ? 'folder' : 'layers'" :size="10" />
                    {{ row.source === 'all' ? row.boardName : row.columnTitle }}
                  </span>
                  <span v-if="row.card.tags?.length" class="frow-tags">
                    <span v-for="t in row.card.tags" :key="t" class="tcard-tag">{{ t }}</span>
                  </span>
                  <span v-if="progressOf(row.card).total" class="frow-sub">
                    子任务 {{ progressOf(row.card).done }}/{{ progressOf(row.card).total }}
                  </span>
                </span>
              </div>

              <span v-if="row.card.due" class="tcard-due" :class="dueCls(row.card)" :title="row.card.due">
                <Icon name="clock" :size="11" /> {{ cardDueText(row.card) }}
              </span>
              <button
                v-if="row.source === 'board'"
                type="button"
                class="frow-snooze"
                title="把截止日推迟到明天"
                @click.stop="snoozeFocusRow(row)"
              >
                <Icon name="clock" :size="11" /> 明天
              </button>
            </article>
          </div>
        </section>
      </div>
    </div>

    <!-- ---------- 归档视图:已完成 / 手动归档的卡片,可恢复原列 ---------- -->
    <div v-if="viewMode === 'archive'" class="archive-wrap">
      <div class="archive-bar panel">
        <div class="archive-copy">
          <h3><Icon name="archive" :size="14" /> 归档箱</h3>
          <span class="archive-sub">恢复时会优先放回原列;定时清理前,归档内容一直保留。</span>
        </div>
        <span class="grow"></span>
        <span class="count-pill">{{ archivedCards.length }}</span>
        <button
          type="button"
          class="btn small ghost"
          :disabled="!stats?.done"
          title="把当前板里所有已完成卡片移入归档箱"
          @click="archiveAllDone"
        >
          <Icon name="archive" :size="12" /> 归档 {{ stats?.done ?? 0 }} 张已完成
        </button>
        <button
          type="button"
          class="btn small ghost danger-text"
          :disabled="!archivedCards.length"
          @click="askClearArchive"
        >
          <Icon name="trash" :size="12" /> 清空
        </button>
      </div>

      <EmptyState
        v-if="!archivedCards.length"
        icon="archive"
        title="归档箱是空的"
        desc="卡片菜单里的「归档」或上方的「归档已完成」会把卡片收进这里。"
      />
      <EmptyState
        v-else-if="!archivedVisible.length"
        icon="filter"
        title="没有匹配的归档卡片"
        desc="换个关键词,或者清除筛选条件。"
      >
        <button type="button" class="btn ghost" @click="clearFilters">清除筛选</button>
      </EmptyState>

      <div v-else class="archive-list">
        <article
          v-for="card in archivedVisible"
          :key="card.id"
          class="arow card"
          :class="{ 'has-color': !!card.color }"
          :style="colorStyle(card.color)"
        >
          <span class="arow-ico"><Icon name="archive" :size="13" /></span>
          <div class="arow-main">
            <span class="arow-title">{{ card.title }}</span>
            <span class="arow-meta">
              <span><Icon name="layers" :size="10" /> 来自 {{ archiveOrigin(card) }}</span>
              <span>·</span>
              <span><Icon name="clock" :size="10" /> {{ formatTime(card.archivedAt || card.updatedAt) }}</span>
              <span v-if="card.tags?.length" class="arow-tags">
                <span v-for="t in card.tags" :key="t" class="tcard-tag">{{ t }}</span>
              </span>
              <span v-if="progressOf(card).total" class="arow-sub">
                子任务 {{ progressOf(card).done }}/{{ progressOf(card).total }}
              </span>
            </span>
            <span v-if="card.notes" class="arow-notes" :title="card.notes">{{ card.notes }}</span>
          </div>
          <button type="button" class="btn small ghost arow-restore" title="恢复到看板" @click="restoreArchived(card)">
            <Icon name="refresh" :size="12" /> 恢复
          </button>
          <button
            type="button"
            class="btn small ghost danger-text arow-del"
            title="永久删除,不可恢复"
            @click="askDeleteArchived(card)"
          >
            <Icon name="trash" :size="12" />
          </button>
        </article>
      </div>
    </div>

    <!-- ---------- 多选工具条:批量完成 / 移动 / 归档 / 删除 ---------- -->
    <Teleport to="body">
      <div v-if="selectMode" class="batch-bar card">
        <span class="batch-count"><Icon name="check" :size="13" /> 已选 {{ selectedCount }} 张</span>
        <button type="button" class="chip batch-chip" @click="selectAllVisible">全选可见</button>
        <button type="button" class="chip batch-chip" :disabled="!selectedCount" @click="clearSelection">清空</button>
        <span class="grow"></span>
        <select v-model="batchTargetId" class="select batch-select" :disabled="!selectedCount || batchBusy" title="批量移动的目标列">
          <option value="">移到…</option>
          <option v-for="c in board?.columns ?? []" :key="c.id" :value="c.id">{{ c.title }}</option>
        </select>
        <button
          type="button"
          class="btn small ghost"
          :disabled="!selectedCount || !batchTargetId || batchBusy"
          @click="batchMove"
        >移动</button>
        <button type="button" class="btn small ghost" :disabled="!selectedCount || batchBusy" @click="batchSetDone(true)">完成</button>
        <button type="button" class="btn small ghost" :disabled="!selectedCount || batchBusy" @click="batchSetDone(false)">取消完成</button>
        <button type="button" class="btn small ghost" :disabled="!selectedCount || batchBusy" @click="batchArchive">归档</button>
        <button type="button" class="btn small danger-text" :disabled="!selectedCount || batchBusy" @click="askBatchDelete">删除</button>
        <button type="button" class="btn small primary" @click="toggleSelectMode">完成选择</button>
      </div>
    </Teleport>

    <!-- ---------- 列操作菜单:挂到 body,空列/窄列也不会被面板裁切 ---------- -->
    <Teleport to="body">
      <div
        v-if="menuColumn"
        class="col-menu"
        :style="{ left: `${menuColPos.x}px`, top: `${menuColPos.y}px` }"
        @click.stop
      >
        <div class="cm-head" :style="colorStyle(menuColumn.color)">
          <span v-if="menuColumn.color" class="cm-dot"></span>
          <span class="cm-title" :title="menuColumn.title">{{ menuColumn.title }}</span>
          <span class="cm-meta">{{ menuColumn.cards.length }} 张</span>
        </div>
        <div class="cm-swatches">
          <button
            type="button"
            class="task-swatch none"
            :class="{ on: !menuColumn.color }"
            title="无颜色"
            @click="menuSetColor(undefined)"
          ></button>
          <button
            v-for="k in TASK_COLORS"
            :key="k"
            type="button"
            class="task-swatch"
            :class="[`sw-${k}`, { on: menuColumn.color === k }]"
            :title="`列颜色:${TASK_COLOR_LABELS[k]}`"
            @click="menuSetColor(k)"
          ></button>
        </div>
        <div class="cm-sep"></div>
        <button type="button" class="cm-item" @click="menuRename">
          <Icon name="pen" :size="13" /> 重命名
        </button>
        <button type="button" class="cm-item" :disabled="!menuColumn.cards.length" @click="menuClear">
          <Icon name="x" :size="13" /> 清空该列
        </button>
        <button type="button" class="cm-item danger" @click="menuRemove">
          <Icon name="trash" :size="13" /> 删除列
        </button>
      </div>
    </Teleport>

    <!-- ---------- 卡片操作菜单(不用拖拽也能换列) ---------- -->
    <Teleport to="body">
      <div
        v-if="cardMenu"
        class="task-card-menu card"
        :style="{ left: `${cardMenu.x}px`, top: `${cardMenu.y}px` }"
        @click.stop
      >
        <div class="tcm-head">
          <span class="tcm-title" :title="cardMenu.card.title">{{ cardMenu.card.title }}</span>
          <span class="tcm-meta"><Icon name="layers" :size="10" /> {{ columnOfCard(cardMenu.card.id) }}</span>
        </div>
        <button type="button" class="cm-item" @click="menuEdit"><Icon name="pen" :size="13" /> 编辑详情</button>
        <div class="cm-sep"></div>
        <div class="cm-label">移动到</div>
        <button
          v-for="c in menuOtherColumns"
          :key="c.id"
          type="button"
          class="cm-item"
          @click="menuMoveTo(cardMenu.card, c)"
        ><Icon name="layers" :size="13" /> {{ c.title }}</button>
        <div v-if="menuOtherColumns.length === 0" class="cm-empty">
          只有当前这一列
        </div>
        <div class="cm-sep"></div>
        <button type="button" class="cm-item" @click="menuDuplicate(cardMenu.card)"><Icon name="copy" :size="13" /> 复制卡片</button>
        <button type="button" class="cm-item" @click="menuArchive(cardMenu.card)"><Icon name="archive" :size="13" /> 移入归档箱</button>
        <button type="button" class="cm-item danger" @click="menuDelete(cardMenu.card)"><Icon name="trash" :size="13" /> 删除卡片</button>
      </div>
    </Teleport>

    <!-- ---------- 列弹窗(新建 / 重命名) ---------- -->
    <Teleport to="body">
      <div v-if="colModal" class="modal-mask" @click.self="colModal = null">
        <div class="card modal sm">
          <div class="modal-head">
            <div class="modal-title">
              <Icon name="layers" :size="15" /> {{ colModal.mode === 'create' ? '新建列' : '重命名列' }}
            </div>
            <span class="grow"></span>
            <button type="button" class="btn small ghost icon-x" title="关闭" @click="colModal = null">
              <Icon name="x" :size="14" />
            </button>
          </div>
          <div class="field">
            <label class="f-label" for="task-col-title">列名</label>
            <input
              id="task-col-title"
              ref="colModalInput"
              v-model="colModal.title"
              class="input"
              placeholder="如:待办 / 进行中 / 待验收"
              @keydown.enter="saveColModal"
            />
          </div>
          <div class="modal-foot">
            <button type="button" class="btn ghost" @click="colModal = null">取消</button>
            <span class="grow"></span>
            <button type="button" class="btn primary" :disabled="!colModal.title.trim()" @click="saveColModal">保存</button>
          </div>
        </div>
      </div>
    </Teleport>

    <ConfirmDialog
      :open="!!confirmState"
      :title="confirmState?.title ?? ''"
      tone="danger"
      :message="confirmState?.message"
      :details="confirmState?.details"
      :confirm-label="confirmState?.confirmLabel ?? '确认'"
      @confirm="runConfirm"
      @cancel="confirmState = null"
    />

    <TaskCardDialog
      :open="dialogOpen"
      :card="editing"
      :column-id="editingColumnId"
      :columns="board?.columns ?? []"
      @close="dialogOpen = false"
    />

    <!-- 轻提示:快速捕获 / 批量操作 / 归档反馈 -->
    <Teleport to="body">
      <div v-if="flashText" class="task-flash" role="status">{{ flashText }}</div>
    </Teleport>
  </div>
</template>

<style scoped>
/* ================================================================
   任务工作台 2.0
   ----------------------------------------------------------------
   布局层级:健康度页头 → 快速捕获 → 视图工具栏 → 内容区。
   内容区四种视图共用一套卡片语言(完成框 / 优先级 / 截止日 / 子任务进度),
   只是密度不同:看板是「扫一眼」,列表是「快速勾」,聚焦是「现在做什么」。
   ================================================================ */

/* ---------- 页头:标题 + 脉搏数字 + 完成率环 ---------- */

.task-hero {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  padding: 13px 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background:
    linear-gradient(135deg, var(--brand-weak) 0%, transparent 46%),
    var(--surface);
  box-shadow: var(--shadow-sm);
}

.hero-main {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.hero-title {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 9px;
}

.hero-title h2 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  letter-spacing: 0.01em;
  color: var(--text);
}

.hero-title h2 .icon {
  color: var(--brand);
}

.due-pill {
  background: var(--danger-weak);
  color: var(--danger);
}

.hero-pulse {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

.pulse-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 1px 9px;
  border-radius: 999px;
  background: var(--surface-2);
  color: var(--text-3);
  font-size: 11.5px;
  font-weight: 500;
  white-space: nowrap;
}

.pulse-num {
  font-family: var(--mono);
  font-size: 12.5px;
  font-weight: 700;
  color: var(--text-2);
  line-height: 1;
}

.pulse-item.danger .pulse-num {
  color: var(--danger);
}

.pulse-item.warn .pulse-num {
  color: var(--warn);
}

.pulse-item.muted .pulse-num {
  color: var(--text-3);
}

.hero-side {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
}

/* 完成率环:conic-gradient 环形进度,内圈用 surface 挖空 */
.stat-ring {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 60px;
  height: 60px;
  flex-shrink: 0;
  border-radius: 50%;
  background: conic-gradient(var(--brand) 0 var(--pct, 0%), var(--surface-3) var(--pct, 0%) 100%);
}

.stat-ring::after {
  content: '';
  position: absolute;
  inset: 5px;
  border-radius: 50%;
  background: var(--surface);
}

.stat-ring-num {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: baseline;
  gap: 1px;
  font-family: var(--mono);
  font-size: 16px;
  font-weight: 700;
  line-height: 1;
  color: var(--text);
}

.stat-ring-num small {
  font-size: 9px;
  font-weight: 600;
  color: var(--text-3);
}

.stat-ring-label {
  position: relative;
  z-index: 1;
  margin-top: 3px;
  font-size: 9px;
  color: var(--text-3);
}

.board-select {
  width: 168px;
  flex-shrink: 0;
}

/* ---------- 快速捕获 ---------- */

.capture {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 6px 8px 6px 12px;
  border-color: var(--border-strong);
  transition: border-color 0.15s, box-shadow 0.15s;
}

.capture:focus-within {
  border-color: var(--brand);
  box-shadow: 0 0 0 3px var(--brand-weak);
}

.capture-ico {
  flex-shrink: 0;
  color: var(--brand);
}

.capture-input {
  flex: 1;
  min-width: 120px;
  padding: 5px 2px;
  border: none;
  background: transparent;
  box-shadow: none;
  font-size: 13.5px;
}

.capture-input:focus {
  box-shadow: none;
}

.capture-chips {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
  max-width: 300px;
}

.capture-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--surface-2);
  color: var(--text-2);
  font-size: 11px;
  white-space: nowrap;
}

.capture-target {
  width: auto;
  max-width: 138px;
  padding: 3px 24px 3px 8px;
  font-size: 12px;
  box-shadow: none;
}

.capture-submit {
  flex-shrink: 0;
}

.capture-tip {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: -7px;
  font-size: 11px;
  color: var(--text-3);
}

.capture-tip .kbd {
  font-size: 9.5px;
}

/* ---------- 视图工具栏 ---------- */

.work-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.view-tabs {
  flex-shrink: 0;
}

.view-tabs button {
  padding: 3px 11px;
  font-size: 11.5px;
}

.search-box {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0 9px;
  border: 1px solid var(--border-strong);
  border-radius: 7px;
  background: var(--surface);
  box-shadow: var(--shadow-sm);
  color: var(--text-3);
  transition: border-color 0.15s, box-shadow 0.15s;
}

.search-box:focus-within {
  border-color: var(--brand);
  box-shadow: 0 0 0 3px var(--brand-weak);
}

.search-box .input {
  width: 196px;
  padding: 5px 0;
  border: none;
  background: transparent;
  box-shadow: none;
  font-size: 12.5px;
}

.search-box .input:focus {
  box-shadow: none;
}

.search-clear {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: var(--surface-3);
  color: var(--text-3);
  cursor: pointer;
}

.search-clear:hover {
  background: var(--danger-weak);
  color: var(--danger);
}

.sort-wrap,
.filter-wrap,
.help-wrap {
  position: relative;
  display: flex;
  align-items: center;
  gap: 4px;
}

.sort-select {
  width: auto;
  padding: 3px 24px 3px 8px;
  font-size: 12px;
  box-shadow: none;
}

.sort-dir {
  width: 26px;
  padding: 3px 0;
}

.filter-btn.on,
.select-mode-btn.on {
  background: var(--brand-weak);
  color: var(--brand);
}

.filter-dot {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 15px;
  height: 15px;
  padding: 0 4px;
  border-radius: 999px;
  background: var(--brand);
  color: #fff;
  font-size: 9.5px;
  font-weight: 700;
}

/* 筛选浮层 */

.filter-pop {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 50;
  width: 266px;
  padding: 11px 12px;
  box-shadow: var(--shadow-lift);
}

.fp-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 10px;
  font-size: 12px;
  font-weight: 700;
  color: var(--text-2);
}

.fp-head .grow {
  flex: 1;
}

.fp-clear {
  padding: 0;
  border: none;
  background: transparent;
  color: var(--brand);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}

.fp-clear:hover {
  text-decoration: underline;
}

.fp-block {
  margin-bottom: 11px;
}

.fp-block:last-child {
  margin-bottom: 0;
}

.fp-label {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 5px;
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.05em;
  color: var(--text-3);
  text-transform: uppercase;
}

.fp-seg {
  display: flex;
  width: 100%;
}

.fp-seg button {
  flex: 1;
  justify-content: center;
  padding: 2px 0;
}

.fp-select {
  width: 100%;
  padding: 4px 24px 4px 8px;
  font-size: 12px;
  box-shadow: none;
}

.fp-check {
  margin: 0;
  font-size: 12px;
}

.fp-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}

.fp-chip {
  padding: 2px 9px;
  font-size: 11px;
  box-shadow: none;
}

.fp-sort {
  display: flex;
  align-items: center;
  gap: 6px;
}

.fp-sort .fp-select {
  flex: 1;
  min-width: 0;
}

/* 快捷键浮层 */

.help-pop {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 50;
  width: 236px;
  padding: 10px 12px;
  box-shadow: var(--shadow-lift);
}

.help-title {
  margin-bottom: 7px;
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--text-3);
  text-transform: uppercase;
}

.help-row {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 3px 0;
  font-size: 11.5px;
  color: var(--text-2);
}

.help-row .kbd {
  font-size: 9.5px;
}

.help-row span:last-child {
  margin-left: auto;
  color: var(--text-3);
}

/* 已生效的过滤条件 */

.filter-summary {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

.fs-label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--text-3);
}

.fs-chip {
  gap: 4px;
  padding: 2px 9px;
  font-size: 11px;
  box-shadow: none;
}

.fs-chip .icon {
  opacity: 0.6;
}

.fs-clear {
  padding: 0 2px;
  border: none;
  background: transparent;
  color: var(--text-3);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}

.fs-clear:hover {
  color: var(--danger);
}

/* ---------- 保存失败 / 撤销条 ---------- */

.save-error {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 8px 12px;
  border: 1px solid var(--danger-weak);
  border-radius: var(--radius-sm);
  background: var(--danger-weak);
  color: var(--danger);
  font-size: 12.5px;
}

.undo-bar {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
  box-shadow: var(--shadow-sm);
  color: var(--text-2);
  font-size: 12.5px;
}

.undo-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.undo-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  flex-shrink: 0;
  padding: 3px 8px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--brand);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.12s;
}

.undo-btn:hover {
  background: var(--brand-weak);
}

/* ---------- 看板视图 ---------- */

/* 任务页吃满内容区高度:看板列随窗口高度伸展,底部不留大片空白 */
.tasks.view {
  height: 100%;
  box-sizing: border-box;
}

.board {
  display: flex;
  align-items: stretch;
  gap: 12px;
  flex: 1 1 auto;
  min-height: 0;
  overflow-x: auto;
  overflow-y: hidden;
  padding: 2px 2px 10px;
}

.board.col-dragging {
  cursor: grabbing;
}

.tcol {
  /* 列宽按可用宽度等分:4 列并排能完整放进内容区;列太多时再横向滚动 */
  flex: 1 1 0;
  width: auto;
  min-width: 140px;
  max-width: 480px;
  min-height: 128px;
  position: relative;
}

/* 列颜色:整列淡色底 + 列头深一档 + 同色描边 + 顶部色条,让整列一眼能看出颜色 */
.tcol.has-color {
  background: color-mix(in srgb, var(--task-color) 8%, var(--surface));
  border-color: color-mix(in srgb, var(--task-color) 32%, var(--border));
  box-shadow: inset 0 3px 0 var(--task-color), var(--shadow-sm);
}

.tcol.has-color .tcol-head {
  background: color-mix(in srgb, var(--task-color) 16%, var(--panel-head));
  border-bottom-color: color-mix(in srgb, var(--task-color) 30%, var(--border));
}

/* 列头与列菜单里的颜色圆点(颜色由外层 --task-color 提供) */
.tcol-dot,
.cm-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--task-color);
}

/* 列拖拽落点:左右两侧的 brand 竖条 */
.tcol.drop-left::before,
.tcol.drop-right::after {
  content: '';
  position: absolute;
  top: 6px;
  bottom: 6px;
  width: 3px;
  border-radius: 3px;
  background: var(--brand);
  z-index: 5;
}

.tcol.drop-left::before {
  left: -8px;
}

.tcol.drop-right::after {
  right: -8px;
}

.tcol.addcol {
  flex: 0 0 100px;
  width: 100px;
  min-width: 100px;
  max-width: 100px;
  height: auto;
  max-height: none;
  min-height: 0;
  align-self: flex-start;
  padding: 8px;
  border: 1px dashed var(--border);
  background: transparent;
  box-shadow: none;
  display: flex;
  align-items: flex-start;
  justify-content: center;
}

/* ---------- 列头 ---------- */

.tcol-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  background: var(--panel-head);
  cursor: grab;
  user-select: none;
  flex-shrink: 0;
}

.tcol-head.dragging {
  opacity: 0.5;
}

.tcol-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11.5px;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--text-2);
  text-transform: uppercase;
}

.tcol-head .count-pill {
  flex-shrink: 0;
}

.tcol-add,
.tcol-more {
  width: 23px;
  flex-shrink: 0;
  padding: 3px 0;
  color: var(--text-3);
  opacity: 0.55;
  transition: opacity 0.12s, color 0.12s;
}

.tcol-head:hover .tcol-add,
.tcol-head:hover .tcol-more,
.tcol-add:focus-visible,
.tcol-more:focus-visible {
  opacity: 1;
}

.tcol-add:hover,
.tcol-more:hover {
  color: var(--brand);
}

.col-menu {
  /* 固定定位的浮层(Teleport 到 body):不受列面板 overflow:hidden 裁切 */
  position: fixed;
  z-index: 120;
  width: 168px;
  max-height: calc(100vh - 16px);
  overflow-y: auto;
  padding: 5px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-overlay);
}

.cm-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px 3px;
}

.cm-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
}

.cm-meta {
  flex-shrink: 0;
  font-size: 10.5px;
  color: var(--text-3);
}

.cm-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 10px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--text-2);
  font-size: 12.5px;
  cursor: pointer;
  text-align: left;
}

.cm-item:hover:not(:disabled) {
  background: var(--surface-2);
  color: var(--text);
}

.cm-item:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.cm-item.danger {
  color: var(--danger);
}

.cm-item.danger:hover:not(:disabled) {
  background: var(--danger-weak);
  color: var(--danger);
}

.cm-swatches {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 8px 10px 6px;
}

.cm-sep {
  height: 1px;
  margin: 2px 5px 4px;
  background: var(--border);
}

/* ---------- 列体 ---------- */

.tcol-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  overflow-y: auto;
}

.tcol-empty {
  padding: 18px 8px;
  border: 1px dashed var(--border);
  border-radius: var(--radius-sm);
  text-align: center;
  font-size: 12px;
  color: var(--text-3);
  user-select: none;
}

/* ---------- 卡片(看板与列表共用的视觉语言) ---------- */

.tcard {
  padding: 9px 11px;
  cursor: pointer;
  flex-shrink: 0;
  transition: border-color 0.15s, box-shadow 0.15s;
}

/* 卡片颜色:整张卡片淡色底 + 左色条(与列颜色同一套视觉语言) */
.tcard.has-color {
  background: color-mix(in srgb, var(--task-color) 10%, var(--surface));
  border-left: 3px solid var(--task-color);
}

.tcard.has-color:hover {
  border-left-color: var(--task-color);
}

.tcard:hover {
  border-color: var(--brand);
  box-shadow: var(--shadow-lift);
}

.tcard.dragging {
  opacity: 0.45;
}

/* 已完成卡:整卡淡化 + 标题删除线(拖拽等操作照常) */
.tcard.done {
  opacity: 0.62;
}

.tcard.done .tcard-title {
  text-decoration: line-through;
  color: var(--text-3);
}

/* 多选选中:品牌色描边,不改变卡片尺寸 */
.tcard.sel {
  border-color: var(--brand);
  box-shadow: 0 0 0 2px var(--brand-weak), var(--shadow-sm);
}

.tcard-top {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 18px;
}

/* 完成勾选框:空心方块,选中填充 --ok(卡片/列表/聚焦/归档共用) */
.tcard-check {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  padding: 0;
  border: 1.5px solid var(--border-strong);
  border-radius: 5px;
  background: transparent;
  color: transparent;
  cursor: pointer;
  transition: border-color 0.12s, background 0.12s, color 0.12s;
}

.tcard-check:hover {
  border-color: var(--ok);
}

.tcard-check.on {
  background: var(--ok);
  border-color: var(--ok);
  color: #fff;
}

.tcard-due {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 1;
  min-width: 0;
  overflow: hidden;
  font-size: 11px;
  font-weight: 600;
  font-family: var(--mono);
  white-space: nowrap;
  color: var(--text-3);
}

/* 优先级徽标:高/中/低三档都显示,只按档位换色与降透明 */
.tcard-prio {
  flex-shrink: 0;
  padding: 0 6px;
  font-size: 10.5px;
  line-height: 16px;
}

.tcard-prio.faint {
  opacity: 0.6;
}

.tcard-due.over {
  color: var(--danger);
}

.tcard-due.today {
  color: var(--warn);
}

/* 3 天内到期:与今日同色系但降调,提示而不报警 */
.tcard-due.soon {
  color: var(--warn);
  opacity: 0.65;
}

/* 多选勾标记(右上角小圆点) */
.sel-tick {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 15px;
  height: 15px;
  flex-shrink: 0;
  border: 1.5px solid var(--border-strong);
  border-radius: 50%;
  color: transparent;
  transition: background 0.12s, border-color 0.12s, color 0.12s;
}

.sel-tick.on {
  border-color: var(--brand);
  background: var(--brand);
  color: #fff;
}

/* 卡片操作菜单入口:常驻低透明度,悬停变清晰(触屏也能点到) */
.tcard-more {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  flex-shrink: 0;
  padding: 0;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
  opacity: 0.38;
  transition: opacity 0.12s, color 0.12s, background 0.12s;
}

.tcard:hover .tcard-more,
.tcard:focus-within .tcard-more,
.tcard.sel .tcard-more {
  opacity: 1;
}

.tcard-more:hover {
  background: var(--brand-weak);
  color: var(--brand);
}

.tcard-title {
  margin-top: 5px;
  font-size: 13px;
  font-weight: 550;
  line-height: 1.45;
  color: var(--text);
  word-break: break-word;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

/* 子任务进度:细条 + 数字,让「拆了但没做完」在卡片上可见 */
.tcard-subtasks {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-top: 7px;
}

.tcard-bar {
  flex: 1;
  min-width: 0;
  height: 4px;
}

.tcard-subnum {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex-shrink: 0;
  font-family: var(--mono);
  font-size: 10px;
  font-weight: 700;
  color: var(--text-3);
}

.tcard-bottom {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 7px;
}

.tcard-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  min-width: 0;
}

.tcard-tag {
  padding: 0 7px;
  border-radius: 999px;
  background: var(--surface-3);
  color: var(--text-2);
  font-size: 10.5px;
  font-weight: 600;
  line-height: 17px;
  white-space: nowrap;
}

.tcard-notes-line {
  display: flex;
  align-items: flex-start;
  gap: 5px;
  margin-top: 6px;
  font-size: 11px;
  line-height: 1.4;
  color: var(--text-3);
}

/* 图标不参与省略,备注文字单行截断(完整内容在悬停提示与详情弹窗) */
.tcard-notes-line > :first-child {
  flex-shrink: 0;
  margin-top: 1px;
}

.tcard-notes-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tcard-time {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex-shrink: 0;
  font-size: 10px;
  white-space: nowrap;
  color: var(--text-3);
}

.tcard-tag.extra {
  background: var(--surface-2);
  color: var(--text-3);
}

/* 卡片间落点横条 */
.drop-line {
  height: 3px;
  border-radius: 2px;
  background: var(--brand);
  flex-shrink: 0;
}

/* 跳转高亮:聚焦/总览点击后目标卡短暂描边 */
.tcard.highlight,
.lrow.highlight {
  border-color: var(--brand);
  box-shadow: 0 0 0 3px var(--brand-weak);
}

/* ---------- 列尾快加 ---------- */

.tcol-foot {
  flex-shrink: 0;
  padding: 8px 10px;
  border-top: 1px solid var(--border);
}

.quick-add {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 5px 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-3);
  font-size: 12.5px;
  cursor: pointer;
  transition: background 0.14s, color 0.14s;
}

.quick-add:hover {
  background: var(--surface-2);
  color: var(--brand);
}

.quick-input {
  padding: 5px 9px;
  font-size: 12.5px;
  box-shadow: none;
}

/* ---------- 列表视图:高密度、可扫读的速记流 ---------- */

.list-wrap {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 980px;
  padding-bottom: 10px;
}

.list-group {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: var(--shadow-sm);
}

.list-head {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--panel-head);
}

.list-dot {
  width: 8px;
  height: 8px;
  flex-shrink: 0;
  border-radius: 50%;
  background: var(--task-color, var(--text-3));
}

.list-head h3 {
  margin: 0;
  font-size: 11.5px;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--text-2);
  text-transform: uppercase;
}

.list-done {
  flex-shrink: 0;
  font-size: 10.5px;
  font-weight: 600;
  color: var(--ok);
}

.list-select {
  flex-shrink: 0;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--brand);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}

.list-select:hover {
  text-decoration: underline;
}

/* 行:覆盖 card 的圆角边框,变成组内的一条记录 */
.lrow {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border: none;
  border-bottom: 1px solid var(--border);
  border-radius: 0;
  background: transparent;
  box-shadow: none;
  cursor: pointer;
  transition: background 0.12s;
}

.lrow:last-of-type {
  border-bottom: none;
}

.lrow:hover {
  background: var(--surface-2);
  box-shadow: none;
}

.lrow.has-color {
  background: color-mix(in srgb, var(--task-color) 8%, var(--surface));
  border-left: 3px solid var(--task-color);
}

.lrow.sel {
  background: var(--brand-weak);
}

.lrow.done {
  opacity: 0.66;
}

.lrow.done .lrow-title {
  color: var(--text-3);
  text-decoration: line-through;
}

.lrow-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}

.lrow-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 550;
  color: var(--text);
}

.lrow-notes {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--text-3);
}

.lrow-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 2px;
}

.lrow-check {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex-shrink: 0;
  font-family: var(--mono);
  font-size: 10.5px;
  font-weight: 700;
  color: var(--text-3);
}

.list-empty {
  padding: 14px 12px;
  text-align: center;
  font-size: 11.5px;
  color: var(--text-3);
}

/* ---------- 聚焦视图:现在该做什么 ---------- */

.focus-wrap {
  display: flex;
  flex-direction: column;
  gap: 14px;
  max-width: 920px;
  padding-bottom: 10px;
}

.focus-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 9px;
}

.focus-scope {
  flex-shrink: 0;
}

.focus-hint {
  font-size: 11.5px;
  color: var(--text-3);
  line-height: 1.5;
}

.focus-sections {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.focus-sec {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.focus-head {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 1px 2px;
  font-size: 12px;
  font-weight: 700;
  color: var(--text-2);
  cursor: pointer;
  user-select: none;
}

.focus-head h3 {
  margin: 0;
  font: inherit;
}

.focus-head.overdue {
  color: var(--danger);
}

.focus-head.today {
  color: var(--warn);
}

.focus-toggle {
  font-size: 10.5px;
  font-weight: 500;
  color: var(--text-3);
  opacity: 0;
  transition: opacity 0.12s;
}

.focus-head:hover .focus-toggle {
  opacity: 1;
}

.focus-rows {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.frow {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 8px 11px;
  transition: border-color 0.15s, box-shadow 0.15s;
}

.frow.has-color {
  border-left: 3px solid var(--task-color);
}

.frow:hover {
  border-color: var(--brand);
  box-shadow: var(--shadow-sm);
}

.frow.done {
  opacity: 0.66;
}

.frow-main {
  display: flex;
  flex-direction: column;
  gap: 3px;
  flex: 1;
  min-width: 0;
  cursor: pointer;
}

.frow-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 550;
  color: var(--text);
}

.frow.done .frow-title {
  color: var(--text-3);
  text-decoration: line-through;
}

.frow-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 3px 9px;
  font-size: 10.5px;
  color: var(--text-3);
}

.frow-src {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.frow-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.frow-sub {
  font-family: var(--mono);
  font-size: 10px;
  font-weight: 600;
}

.frow-snooze {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  padding: 3px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: transparent;
  color: var(--text-3);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
  transition: color 0.12s, border-color 0.12s, background 0.12s;
}

.frow-snooze:hover {
  border-color: var(--brand);
  background: var(--brand-weak);
  color: var(--brand);
}

/* ---------- 归档视图 ---------- */

.archive-wrap {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 920px;
  padding-bottom: 10px;
}

.archive-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 10px 13px;
}

.archive-copy {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.archive-copy h3 {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: 13px;
  font-weight: 700;
  color: var(--text);
}

.archive-copy h3 .icon {
  color: var(--brand);
}

.archive-sub {
  font-size: 11px;
  color: var(--text-3);
}

.archive-list {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.arow {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 10px 12px;
}

.arow.has-color {
  border-left: 3px solid var(--task-color);
}

.arow-ico {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  flex-shrink: 0;
  margin-top: 1px;
  border-radius: 6px;
  background: var(--surface-2);
  color: var(--text-3);
}

.arow-main {
  display: flex;
  flex-direction: column;
  gap: 3px;
  flex: 1;
  min-width: 0;
}

.arow-title {
  font-size: 13px;
  font-weight: 550;
  color: var(--text);
  word-break: break-word;
}

.arow-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 7px;
  font-size: 10.5px;
  color: var(--text-3);
}

.arow-meta > span {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.arow-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.arow-sub {
  font-family: var(--mono);
  font-size: 10px;
}

.arow-notes {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-3);
}

.arow-restore {
  flex-shrink: 0;
  margin-top: 1px;
}

.arow-del {
  width: 26px;
  flex-shrink: 0;
  padding: 3px 0;
  margin-top: 1px;
}

/* ---------- 浮层:多选工具条 / 卡片菜单 / 轻提示 ---------- */

.batch-bar {
  position: fixed;
  left: 50%;
  bottom: 24px;
  z-index: 80;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 7px;
  max-width: calc(100vw - 32px);
  padding: 9px 13px;
  box-shadow: var(--shadow-overlay);
  transform: translateX(-50%);
  animation: batch-in 0.16s ease-out;
}

.batch-count {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--brand);
  white-space: nowrap;
}

.batch-chip {
  padding: 2px 9px;
  font-size: 11px;
  box-shadow: none;
}

.batch-select {
  width: auto;
  max-width: 140px;
  padding: 3px 24px 3px 8px;
  font-size: 12px;
  box-shadow: none;
}

.task-card-menu {
  position: fixed;
  z-index: 90;
  width: 190px;
  padding: 5px;
  box-shadow: var(--shadow-overlay);
  animation: menu-in 0.12s ease-out;
}

.tcm-head {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 7px 10px 6px;
  margin-bottom: 4px;
  border-bottom: 1px solid var(--border);
}

.tcm-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
}

.tcm-meta {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 10px;
  color: var(--text-3);
}

.cm-label {
  padding: 5px 10px 2px;
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--text-3);
  text-transform: uppercase;
}

.cm-empty {
  padding: 4px 10px 7px;
  font-size: 11px;
  color: var(--text-3);
}

.task-flash {
  position: fixed;
  left: 50%;
  bottom: 78px;
  z-index: 100;
  max-width: calc(100vw - 32px);
  padding: 7px 16px;
  border: 1px solid var(--brand);
  border-radius: 999px;
  background: var(--surface);
  color: var(--text-2);
  font-size: 12px;
  text-align: center;
  box-shadow: var(--shadow-lift);
  transform: translateX(-50%);
  animation: flash-in 0.16s ease-out;
}

@keyframes batch-in {
  from {
    opacity: 0;
    transform: translate(-50%, 6px);
  }
  to {
    opacity: 1;
    transform: translate(-50%, 0);
  }
}

@keyframes menu-in {
  from {
    opacity: 0;
    transform: translateY(-3px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

@keyframes flash-in {
  from {
    opacity: 0;
    transform: translate(-50%, 5px);
  }
  to {
    opacity: 1;
    transform: translate(-50%, 0);
  }
}

/* ---------- 响应式:窄窗口优先保住操作入口 ---------- */

@media (max-width: 1024px) {
  .task-hero {
    flex-wrap: wrap;
  }

  .hero-side {
    width: 100%;
    justify-content: flex-end;
  }
}

@media (max-width: 860px) {
  .search-box {
    flex: 1;
    min-width: 180px;
  }

  .search-box .input {
    width: 100%;
    min-width: 0;
  }

  .capture-chips,
  .capture-tip {
    display: none;
  }

  .tcol {
    flex: 0 0 244px;
    min-width: 244px;
    max-width: 244px;
  }

  .list-wrap,
  .focus-wrap,
  .archive-wrap {
    max-width: none;
  }

  .lrow-notes {
    display: none;
  }
}

@media (max-width: 640px) {
  .task-hero {
    padding: 11px 12px;
  }

  .hero-title h2 {
    font-size: 15px;
  }

  .stat-ring {
    width: 52px;
    height: 52px;
  }

  .stat-ring::after {
    inset: 4px;
  }

  .board-select {
    width: 142px;
  }

  .tcol {
    flex: 0 0 216px;
    min-width: 216px;
    max-width: 216px;
  }

  .view-tabs button {
    padding: 3px 8px;
  }

  .focus-hint {
    display: none;
  }

  .archive-sub {
    display: none;
  }

  .arow {
    flex-wrap: wrap;
  }

  .arow-main {
    flex-basis: calc(100% - 34px);
  }
}

@media (prefers-reduced-motion: reduce) {
  .capture,
  .search-box,
  .tcard,
  .tcard-check,
  .tcard-more,
  .sel-tick,
  .quick-add,
  .undo-btn,
  .frow,
  .frow-snooze,
  .focus-toggle,
  .batch-bar,
  .task-card-menu,
  .task-flash,
  .fill {
    transition: none;
    animation: none;
  }
}
</style>
