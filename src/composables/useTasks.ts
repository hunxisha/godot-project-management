// 任务看板数据层:项目列表、当前看板与其全部变更。模块级单例(与 useDocs 同模式):
// 看板页不被 KeepAlive 缓存,切页状态必须留在模块里才不丢。
//
// 一张看板是 db 里的一个文档:godot/taskboard/<boardKey>,boardKey 取 'global'
// (通用看板)或完整项目文档 id(嵌套 id 先例:godot/asset/{projectId}/{assetId})。
// 变更统一走「taskBoard 纯函数算出新板 → toPlain 拍平 → putDoc → 成功采纳 /
// 失败回读」,界面永远与库对齐;上次浏览的板记在 settings.taskBoardId。
import { computed, ref } from 'vue'
import { getDoc, getSettings, listDocs, putDoc, saveSettings, toPlain } from '../services/bridge'
import { DOC_ID, type GodotProject, type TaskBoard, type TaskCard, type TaskPriority } from '../types/godot'
import {
  addCard as opAddCard,
  addColumn as opAddColumn,
  boardTags,
  cardPosition,
  clearColumn as opClearColumn,
  columnIdOfCard,
  countCards,
  createDefaultBoard,
  duplicateCard as opDuplicateCard,
  moveCard as opMoveCard,
  moveColumn as opMoveColumn,
  normalizeBoard,
  removeCard as opRemoveCard,
  removeColumn as opRemoveColumn,
  renameColumn as opRenameColumn,
  restoreCard as opRestoreCard,
  updateCard as opUpdateCard
} from '../utils/taskBoard'

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

async function addCard(columnId: string, input: { title: string, notes?: string, priority?: TaskPriority, due?: string, tags?: string[] }) {
  if (!board.value) return
  await commit(opAddCard(board.value, columnId, input))
}

/**
 * 编辑弹窗保存:更新字段 + 可选换列(换列 = 追加到目标列尾),一次落库。
 * patch 直接透传 opUpdateCard(出现的键才生效)。
 */
async function saveCard(cardId: string, patch: Partial<Pick<TaskCard, 'title' | 'notes' | 'priority' | 'due' | 'tags' | 'done' | 'color'>>, toColumnId: string) {
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

async function updateCard(cardId: string, patch: Partial<Pick<TaskCard, 'title' | 'notes' | 'priority' | 'due' | 'tags' | 'done' | 'color'>>) {
  if (!board.value) return
  await commit(opUpdateCard(board.value, cardId, patch))
}

/** 勾选/取消完成(卡片上的勾选框) */
async function setCardDone(cardId: string, done: boolean) {
  await updateCard(cardId, { done })
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

async function addColumn(title: string) {
  if (!board.value) return
  await commit(opAddColumn(board.value, title))
}

async function renameColumn(columnId: string, title: string) {
  if (!board.value) return
  await commit(opRenameColumn(board.value, columnId, title))
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
    init,
    selectBoard,
    refreshProjects,
    addCard,
    saveCard,
    updateCard,
    setCardDone,
    removeCard,
    undoDelete,
    duplicateCard,
    moveCard,
    addColumn,
    renameColumn,
    removeColumn,
    clearColumn,
    moveColumn
  }
}
