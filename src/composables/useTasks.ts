// 任务看板数据层:项目列表、当前看板与其全部变更。模块级单例(与 useDocs 同模式):
// 看板页不被 KeepAlive 缓存,切页状态必须留在模块里才不丢。
//
// 一张看板是 db 里的一个文档:godot/taskboard/<boardKey>,boardKey 取 'global'
// (通用看板)或完整项目文档 id(嵌套 id 先例:godot/asset/{projectId}/{assetId})。
// 变更统一走「taskBoard 纯函数算出新板 → toPlain 拍平 → putDoc → 成功采纳 /
// 失败回读」,界面永远与库对齐;上次浏览的板记在 settings.taskBoardId。
import { computed, ref } from 'vue'
import { getDoc, getSettings, listDocs, putDoc, saveSettings, toPlain } from '../services/bridge'
import { DOC_ID, type GodotProject, type TaskBoard, type TaskCard, type TaskColor, type TaskPriority } from '../types/godot'
import {
  addCard as opAddCard,
  addColumn as opAddColumn,
  archiveCards as opArchiveCards,
  archiveDoneCards as opArchiveDoneCards,
  boardTags,
  cardPosition,
  clearArchived as opClearArchived,
  clearColumn as opClearColumn,
  columnIdOfCard,
  countCards,
  createDefaultBoard,
  duplicateCard as opDuplicateCard,
  moveCard as opMoveCard,
  moveCards as opMoveCards,
  moveColumn as opMoveColumn,
  normalizeBoard,
  removeArchivedCard as opRemoveArchivedCard,
  removeCard as opRemoveCard,
  removeCards as opRemoveCards,
  removeColumn as opRemoveColumn,
  renameColumn as opRenameColumn,
  restoreArchivedCard as opRestoreArchivedCard,
  restoreCard as opRestoreCard,
  setCardsDone as opSetCardsDone,
  setChecklistItemDone as opSetChecklistItemDone,
  updateCard as opUpdateCard,
  updateColumn as opUpdateColumn
} from '../utils/taskBoard'
import type { TaskChecklistItem } from '../types/godot'

/** 当前看板('global' 或项目文档 id) */
const currentKey = ref('global')
const board = ref<TaskBoard | null>(null)
/** 选板器的项目清单 */
const projects = ref<(GodotProject & { _id: string })[]>([])
/** 最近一次保存失败(界面提示条;成功写入后清空) */
const saveError = ref('')
/** 最近一次删除的卡片(撤销用):原列 id + 原下标 + 卡片快照;切板/删列/清列时作废 */
const lastDelete = ref<{ columnId: string, index: number, card: TaskCard } | null>(null)
let initialized = false

/** 看板内全部标签(去重排序) */
const tags = computed(() => (board.value ? boardTags(board.value) : []))
/** 卡片总数(页头徽标) */
const cardCount = computed(() => (board.value ? countCards(board.value) : 0))
/** 归档箱卡片(不参与统计;按归档时间倒序由界面排) */
const archivedCards = computed(() => board.value?.archived ?? [])

/** 卡片可编辑字段(弹窗保存与快捷变更共用,避免两处各写一份联合类型) */
type TaskCardPatch = Partial<Pick<TaskCard, 'title' | 'notes' | 'priority' | 'due' | 'tags' | 'done' | 'color' | 'checklist'>>

/** 选板器项目排序:收藏 → 最近打开 → 名称(与 useProjectList 同口径) */
const projectOptions = computed(() =>
  [...projects.value].sort((a, b) => {
    if (!!a.favorite !== !!b.favorite) return a.favorite ? -1 : 1
    if ((b.lastOpenedAt || 0) !== (a.lastOpenedAt || 0)) return (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0)
    return a.name.localeCompare(b.name)
  })
)

async function loadProjects() {
  projects.value = await listDocs<GodotProject>('godot/project/')
}

async function loadBoard(key: string) {
  board.value = normalizeBoard(await getDoc<TaskBoard>(DOC_ID.taskBoard(key)))
}

/** 变更落库:成功采纳新板;失败回读以库为准并置 saveError */
async function commit(next: TaskBoard) {
  next.updatedAt = Date.now()
  const ok = await putDoc(DOC_ID.taskBoard(currentKey.value), toPlain(next))
  if (ok) {
    board.value = next
    saveError.value = ''
  } else {
    await loadBoard(currentKey.value)
    saveError.value = '看板保存失败(写入被宿主拒绝),已恢复为库中的内容'
  }
}

/** 看板不存在时建默认板并落库 */
async function ensureBoard() {
  if (!board.value) await commit(createDefaultBoard())
}

/**
 * 初始化:加载项目列表 + 恢复上次浏览的看板。
 * 再次进入只刷新项目列表(看板状态留在模块里);发现当前项目板的项目已被删除则回退通用板。
 */
async function init() {
  const first = !initialized
  initialized = true
  await loadProjects()
  let needLoad = false
  if (first) {
    const saved = (await getSettings()).taskBoardId
    const usable = !!saved && (saved === 'global' || projects.value.some((p) => p._id === saved))
    currentKey.value = usable && saved ? saved : 'global'
    // 回退/首次把解析结果写回去,避免每次进入都重复回退(与 useDocs 同做法)
    if (currentKey.value !== saved) saveSettings({ taskBoardId: currentKey.value }).catch(() => {})
    needLoad = true
  } else if (currentKey.value !== 'global' && !projects.value.some((p) => p._id === currentKey.value)) {
    currentKey.value = 'global'
    needLoad = true
  }
  if (needLoad) {
    await loadBoard(currentKey.value)
    await ensureBoard()
  }
}

/** 切换看板(通用板或某项目);目标没有板则建默认板。撤销条是旧板的东西,一并作废 */
async function selectBoard(key: string) {
  if (key === currentKey.value && board.value) return
  currentKey.value = key
  lastDelete.value = null
  saveSettings({ taskBoardId: key }).catch(() => {})
  await loadBoard(key)
  await ensureBoard()
}

/** 项目列表在他处变动后手动刷新(如刚新建/删除了项目) */
async function refreshProjects() {
  await loadProjects()
}

async function addCard(
  columnId: string,
  input: { title: string, notes?: string, priority?: TaskPriority, due?: string, tags?: string[], checklist?: TaskChecklistItem[] }
) {
  if (!board.value) return
  await commit(opAddCard(board.value, columnId, input))
}

/**
 * 编辑弹窗保存:更新字段 + 可选换列(换列 = 追加到目标列尾),一次落库。
 * patch 直接透传 opUpdateCard(出现的键才生效)。
 */
async function saveCard(cardId: string, patch: TaskCardPatch, toColumnId: string) {
  const prev = board.value
  if (!prev) return
  const next = opUpdateCard(prev, cardId, patch)
  if (next === prev) return
  const from = columnIdOfCard(prev, cardId)
  if (from && from !== toColumnId) {
    const target = next.columns.find((c) => c.id === toColumnId)
    await commit(opMoveCard(next, cardId, toColumnId, target ? target.cards.length : 0))
  } else {
    await commit(next)
  }
}

async function updateCard(cardId: string, patch: TaskCardPatch) {
  if (!board.value) return
  await commit(opUpdateCard(board.value, cardId, patch))
}

/** 勾选/取消完成(卡片上的勾选框) */
async function setCardDone(cardId: string, done: boolean) {
  await updateCard(cardId, { done })
}

/** 勾选/取消一个子任务(卡片详情里的清单) */
async function setChecklistItemDone(cardId: string, itemId: string, done: boolean) {
  if (!board.value) return
  await commit(opSetChecklistItemDone(board.value, cardId, itemId, done))
}

/** 批量完成/取消完成(多选工具条) */
async function setCardsDone(cardIds: string[], done: boolean) {
  if (!board.value || !cardIds.length) return
  await commit(opSetCardsDone(board.value, cardIds, done))
}

/**
 * 总览就地完成:卡片可能属于非当前板。
 * 当前板走内存路径(保持与界面一致);其他板直接读改写其文档,不碰当前内存板。
 * 返回是否已落库(供调用方决定是否刷新跨板统计)。
 */
async function setCardDoneOnBoard(boardKey: string, cardId: string, done: boolean): Promise<boolean> {
  if (boardKey === currentKey.value) {
    await setCardDone(cardId, done)
    return true
  }
  const target = normalizeBoard(await getDoc<TaskBoard>(DOC_ID.taskBoard(boardKey)))
  if (!target) return false
  const next = opUpdateCard(target, cardId, { done })
  if (next === target) return false
  return putDoc(DOC_ID.taskBoard(boardKey), toPlain(next))
}

async function removeCard(cardId: string) {
  const prev = board.value
  if (!prev) return
  const pos = cardPosition(prev, cardId)
  if (!pos) return
  const card = prev.columns.find((c) => c.id === pos.columnId)?.cards[pos.index]
  if (!card) return
  const snapshot = toPlain(card)
  await commit(opRemoveCard(prev, cardId))
  // 落库成功才进入可撤销状态(失败已回读,卡片还在板上)
  if (!saveError.value) lastDelete.value = { columnId: pos.columnId, index: pos.index, card: snapshot }
}

/** 撤销最近一次删除:卡片插回原列原下标(原列已被删/清则无处还原,静默作废) */
async function undoDelete() {
  const snap = lastDelete.value
  const prev = board.value
  if (!snap || !prev) return
  lastDelete.value = null
  const next = opRestoreCard(prev, snap.columnId, snap.index, snap.card)
  if (next === prev) return
  await commit(next)
}

/** 复制卡片:副本插在原卡之后 */
async function duplicateCard(cardId: string) {
  if (!board.value) return
  await commit(opDuplicateCard(board.value, cardId))
}

/** 拖拽落点:toIndex 是「插到第 toIndex 张卡之前」(列尾传 cards.length) */
async function moveCard(cardId: string, toColumnId: string, toIndex: number) {
  if (!board.value) return
  await commit(opMoveCard(board.value, cardId, toColumnId, toIndex))
}

/** 批量移动(多选工具条):统一追加到目标列尾 */
async function moveCards(cardIds: string[], toColumnId: string) {
  if (!board.value || !cardIds.length) return
  await commit(opMoveCards(board.value, cardIds, toColumnId))
}

/** 批量删除(不可撤销;调用方先确认) */
async function removeCards(cardIds: string[]) {
  if (!board.value || !cardIds.length) return
  await commit(opRemoveCards(board.value, cardIds))
}

// ---------- 归档箱 ----------

/** 归档一张卡(可从归档箱恢复,不弹确认) */
async function archiveCard(cardId: string) {
  if (!board.value) return
  await commit(opArchiveCards(board.value, [cardId]))
}

/** 批量归档(多选工具条) */
async function archiveCards(cardIds: string[]) {
  if (!board.value || !cardIds.length) return
  await commit(opArchiveCards(board.value, cardIds))
}

/** 一键归档全部已完成卡片;返回归档数量供界面提示 */
async function archiveDoneCards(): Promise<number> {
  if (!board.value) return 0
  const ids: string[] = []
  for (const column of board.value.columns) {
    for (const card of column.cards) if (card.done === true) ids.push(card.id)
  }
  if (!ids.length) return 0
  await commit(opArchiveDoneCards(board.value))
  return saveError.value ? 0 : ids.length
}

/** 从归档箱恢复(优先回原列);无列可放/写入失败返回 false */
async function restoreArchivedCard(cardId: string, columnId?: string): Promise<boolean> {
  if (!board.value) return false
  const next = opRestoreArchivedCard(board.value, cardId, columnId)
  if (next === board.value) return false
  await commit(next)
  return !saveError.value
}

/** 从归档箱彻底删除一张卡(不可恢复) */
async function removeArchivedCard(cardId: string) {
  if (!board.value) return
  await commit(opRemoveArchivedCard(board.value, cardId))
}

/** 清空归档箱(不可恢复;调用方先确认) */
async function clearArchivedCards() {
  if (!board.value || !board.value.archived?.length) return
  await commit(opClearArchived(board.value))
}

async function addColumn(title: string) {
  if (!board.value) return
  await commit(opAddColumn(board.value, title))
}

async function renameColumn(columnId: string, title: string) {
  if (!board.value) return
  await commit(opRenameColumn(board.value, columnId, title))
}

/** 列颜色(色板 key;不传即清色)。列菜单的 swatch 行用 */
async function setColumnColor(columnId: string, color?: TaskColor) {
  if (!board.value) return
  await commit(opUpdateColumn(board.value, columnId, { color }))
}

async function removeColumn(columnId: string) {
  if (!board.value) return
  lastDelete.value = null // 撤销条指向的列没了,作废(卡片随之删除,不可恢复)
  await commit(opRemoveColumn(board.value, columnId))
}

async function clearColumn(columnId: string) {
  if (!board.value) return
  lastDelete.value = null // 同上:整列清空不做撤销,撤销条一并作废
  await commit(opClearColumn(board.value, columnId))
}

/** 列头拖拽排序:toIndex 是「插到原第 toIndex 列之前」 */
async function moveColumn(columnId: string, toIndex: number) {
  if (!board.value) return
  await commit(opMoveColumn(board.value, columnId, toIndex))
}

export function useTasks() {
  return {
    currentKey,
    board,
    projects: projectOptions,
    saveError,
    lastDelete,
    tags,
    cardCount,
    archivedCards,
    init,
    selectBoard,
    refreshProjects,
    addCard,
    saveCard,
    updateCard,
    setCardDone,
    setChecklistItemDone,
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
  }
}
