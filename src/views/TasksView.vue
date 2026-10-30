<script setup lang="ts">
// 任务看板页:通用看板 + 每个项目的独立看板,多列卡片,列可增删改名/排序。
// 数据与变更都在 useTasks(模块级单例,切页不丢);本组件负责装配、
// 过滤(关键词含标签文本 + 标签 + 优先级 + 仅逾期)与拖拽交互。拖拽用原生 HTML5 DnD
// (全项目首例):卡片按指针与卡片中点比较算插入位置,落点画 brand 色横条;列头可拖动整列,
// 落点画列左右侧竖条。两种拖拽共用 dragend 清理,互不干扰(各 handler 判 dragKind)。
// 卡片删除有一步撤销(提示条,仅记最近一次);完成标记是独立于列位置的显式语义。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Icon from '../components/Icon.vue'
import EmptyState from '../components/EmptyState.vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import TaskCardDialog from '../components/dialogs/TaskCardDialog.vue'
import { useTasks } from '../composables/useTasks'
import { useTaskAlerts, type OverviewEntry } from '../composables/useTaskAlerts'
import { countDue, dueState, matchCard, TASK_COLORS, TASK_COLOR_LABELS, type TaskFilter } from '../utils/taskBoard'
import type { TaskCard, TaskColor, TaskColumn, TaskPriority } from '../types/godot'

const {
  board,
  currentKey,
  projects,
  saveError,
  lastDelete,
  tags,
  cardCount,
  init,
  selectBoard,
  addCard,
  updateCard,
  setCardDone,
  setCardDoneOnBoard,
  removeCard,
  undoDelete,
  duplicateCard,
  moveCard,
  addColumn,
  renameColumn,
  setColumnColor,
  removeColumn,
  clearColumn,
  moveColumn
} = useTasks()

onMounted(init)

// ---------- 过滤 ----------

const query = ref('')
const activeTags = ref<string[]>([])
const filterPriority = ref<'' | TaskPriority>('')
const overdueOnly = ref(false)

/** matchCard 条件对象:关键词命中标题/备注/标签文本,标签任一命中,优先级,仅逾期 */
const cardFilter = computed<TaskFilter>(() => ({
  query: query.value,
  tags: activeTags.value,
  priority: filterPriority.value || undefined,
  overdueOnly: overdueOnly.value
}))

function visibleCards(col: TaskColumn): TaskCard[] {
  return col.cards.filter((c) => matchCard(c, cardFilter.value))
}

function toggleTag(t: string) {
  activeTags.value = activeTags.value.includes(t)
    ? activeTags.value.filter((x) => x !== t)
    : [...activeTags.value, t]
}

/** 是否有任何过滤条件生效(决定「清除过滤」的显隐) */
const hasFilter = computed(
  () => !!query.value.trim() || activeTags.value.length > 0 || !!filterPriority.value || overdueOnly.value
)

function clearFilters() {
  query.value = ''
  activeTags.value = []
  filterPriority.value = ''
  overdueOnly.value = false
}

// ---------- 页头到期徽标(当前板,排除已完成卡) ----------

const dueBadge = computed(() => (board.value ? countDue(board.value) : { overdue: 0, today: 0 }))
const dueTotal = computed(() => dueBadge.value.overdue + dueBadge.value.today)
const dueText = computed(() => {
  const { overdue, today } = dueBadge.value
  if (overdue && today) return `逾期 ${overdue} · 今日 ${today}`
  if (overdue) return `逾期 ${overdue}`
  return `今日 ${today}`
})

// ---------- 总览模式(跨看板,按紧急度分组) ----------

const viewMode = ref<'board' | 'overview'>('board')
const { overviewEntries, ready: overviewReady, refresh: refreshAlerts } = useTaskAlerts()
const overviewLoading = computed(() => viewMode.value === 'overview' && !overviewReady.value)
const overviewCount = computed(() => overviewEntries.value.length)

const overviewSections = computed(() =>
  [
    { key: 'overdue', label: '已逾期', icon: 'alert' },
    { key: 'today', label: '今日到期', icon: 'clock' },
    { key: 'soon', label: '3 天内到期', icon: 'clock' }
  ]
    .map((s) => ({ ...s, cards: overviewEntries.value.filter((e) => e.section === s.key) }))
    .filter((s) => s.cards.length)
)

function enterOverview() {
  viewMode.value = 'overview'
  refreshAlerts()
}

/** 总览就地完成:写库(可能是旁路的非当前板)后刷新跨板清单 */
function completeEntry(e: OverviewEntry) {
  void setCardDoneOnBoard(e.boardKey, e.card.id, true).then(() => refreshAlerts())
}

/** 跳回来源板并短暂高亮目标卡(过滤条件可能挡住它,先清掉) */
const highlightId = ref<string | null>(null)

async function gotoCard(e: OverviewEntry) {
  clearFilters()
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

// ---------- 看板切换 ----------

const boardKey = computed({
  get: () => currentKey.value,
  set: (v: string) => {
    selectBoard(v)
  }
})

// 切板后拖拽/菜单/过滤/撤销条都是旧板的东西,全部清掉
watch(currentKey, () => {
  dragCard.value = null
  dragColId.value = null
  drop.value = null
  dropColIdx.value = null
  menuCol.value = null
  quickCol.value = null
  query.value = ''
  activeTags.value = []
  filterPriority.value = ''
  overdueOnly.value = false
})
// 过滤变了,落点指示的 visible 下标已失义
watch([query, activeTags, filterPriority, overdueOnly], () => {
  drop.value = null
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

// ---------- 卡片:打开编辑 / 完成 / 复制 / 删除 ----------

const dialogOpen = ref(false)
const editing = ref<TaskCard | null>(null)
const editingColumnId = ref('')

function openCard(card: TaskCard) {
  editingColumnId.value = board.value?.columns.find((c) => c.cards.some((k) => k.id === card.id))?.id ?? ''
  editing.value = card
  dialogOpen.value = true
}

/** 勾选/取消完成(勾选框在卡片上,别触发打开弹窗) */
function toggleDone(card: TaskCard) {
  setCardDone(card.id, !card.done)
}

function duplicate(card: TaskCard) {
  duplicateCard(card.id)
}

const confirmState = ref<{ title: string, message: string, details?: string[], run: () => void } | null>(null)

function askDeleteCard(card: TaskCard) {
  confirmState.value = {
    title: '删除卡片',
    message: `将删除卡片「${card.title}」,删除后可在提示条里撤销。`,
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

// ---------- 列:菜单 / 新建重命名 / 清空删除 ----------

const menuCol = ref<string | null>(null)

function toggleMenu(colId: string) {
  menuCol.value = menuCol.value === colId ? null : colId
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
    run: () => removeColumn(col.id)
  }
}

// ---------- 列尾快加 ----------

const quickCol = ref<string | null>(null)
const quickTitle = ref('')
const quickInput = ref<HTMLInputElement | null>(null)

async function startQuick(col: TaskColumn) {
  quickCol.value = col.id
  quickTitle.value = ''
  await nextTick()
  quickInput.value?.focus()
}

function submitQuick(col: TaskColumn) {
  const title = quickTitle.value.trim()
  if (!title) return
  addCard(col.id, { title })
  quickTitle.value = ''
  nextTick(() => quickInput.value?.focus()) // 保持焦点,便于连续录入
}

function cancelQuick() {
  quickCol.value = null
  quickTitle.value = ''
}

// ---------- 展示辅助 ----------

/** 卡片/列颜色 → CSS 变量(--task-color 指向主题化的 --task-c-<key>;无色不绑) */
function colorStyle(color: string | undefined): Record<string, string> | undefined {
  return color ? { '--task-color': `var(--task-c-${color})` } : undefined
}

function dueCls(card: TaskCard) {
  const s = dueState(card.due)
  return s === 'overdue' ? 'over' : s === 'today' ? 'today' : s === 'soon' ? 'soon' : ''
}

function shortDue(due: string) {
  return due.length >= 10 ? due.slice(5) : due
}

// ---------- 全局监听:点外关菜单 / Escape 关列弹窗 ----------

function onDocClick(e: MouseEvent) {
  if (menuCol.value && !(e.target as HTMLElement | null)?.closest('.col-menu-wrap')) menuCol.value = null
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && colModal.value) colModal.value = null
}

onMounted(() => {
  document.addEventListener('click', onDocClick)
  window.addEventListener('keydown', onKey)
})

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick)
  window.removeEventListener('keydown', onKey)
  if (undoTimer) clearTimeout(undoTimer)
})
</script>

<template>
  <div class="tasks view">
    <div class="view-head">
      <h2>
        <Icon name="kanban" :size="17" /> 任务看板
        <span class="count-pill">{{ viewMode === 'overview' ? overviewCount : cardCount }}</span>
        <span
          v-if="viewMode === 'board' && dueTotal"
          class="count-pill due-pill"
          :title="`当前看板:逾期 ${dueBadge.overdue} · 今日到期 ${dueBadge.today}(未完成)`"
        >{{ dueText }}</span>
      </h2>
      <span class="grow"></span>
      <div class="seg view-mode" role="group" aria-label="视图切换">
        <button type="button" :class="{ on: viewMode === 'board' }" @click="viewMode = 'board'">单板</button>
        <button type="button" :class="{ on: viewMode === 'overview' }" @click="enterOverview">总览</button>
      </div>
      <select v-if="viewMode === 'board'" v-model="boardKey" class="select board-select" title="选择看板(通用或某个项目)">
        <option value="global">通用看板</option>
        <optgroup v-if="projects.length" label="项目">
          <option v-for="p in projects" :key="p._id" :value="p._id">{{ p.name }}</option>
        </optgroup>
      </select>
      <label v-if="viewMode === 'board'" class="search-box">
        <Icon name="search" :size="13" />
        <input v-model="query" class="input" placeholder="搜索标题 / 备注 / 标签…" />
      </label>
    </div>

    <!-- 过滤行(仅单板模式):优先级 + 仅逾期 + 标签 chips(只列当前看板里出现过的标签) -->
    <div v-if="viewMode === 'board'" class="tag-filter">
      <select v-model="filterPriority" class="select tf-select" title="按优先级过滤">
        <option value="">全部优先级</option>
        <option value="high">仅高优先级</option>
        <option value="normal">仅普通</option>
        <option value="low">仅低优先级</option>
      </select>
      <button class="chip tf-chip" :class="{ on: overdueOnly }" title="只看逾期且未完成的卡片" @click="overdueOnly = !overdueOnly">
        仅逾期
      </button>
      <template v-if="tags.length">
        <span class="tf-sep"></span>
        <Icon name="tag" :size="12" class="tf-ico" />
        <button
          v-for="t in tags"
          :key="t"
          class="chip tf-chip"
          :class="{ on: activeTags.includes(t) }"
          @click="toggleTag(t)"
        >
          {{ t }}
        </button>
      </template>
      <button v-if="hasFilter" class="tf-clear" @click="clearFilters">
        <Icon name="x" :size="11" /> 清除过滤
      </button>
    </div>

    <div v-if="saveError" class="save-error">
      <Icon name="alert" :size="13" /> {{ saveError }}
    </div>

    <!-- 撤销条(仅单板模式):最近一次删除的卡片,7 秒后自动消失 -->
    <div v-if="viewMode === 'board' && lastDelete" class="undo-bar">
      <Icon name="trash" :size="13" />
      <span class="undo-text">已删除「{{ lastDelete?.card.title }}」</span>
      <button class="undo-btn" title="把卡片放回原位" @click="undoDelete">
        <Icon name="refresh" :size="12" /> 撤销
      </button>
    </div>

    <template v-if="viewMode === 'board'">
      <!-- 载入中(board 为 null 时) -->
      <EmptyState v-if="!board" icon="kanban" title="正在载入看板…" />

      <!-- 一列都没有:引导建列(列删光也是合法状态,不擅自重建默认板) -->
      <EmptyState v-else-if="board.columns.length === 0" icon="kanban" title="还没有列" desc="先把流程拆成几列,例如 待办 / 进行中 / 已完成。">
        <button class="btn primary" @click="openCreateColumn"><Icon name="plus" :size="14" /> 新建列</button>
      </EmptyState>

      <div v-else class="board" :class="{ 'col-dragging': !!dragColId }">
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
          <span class="tcol-title" :title="col.title">{{ col.title }}</span>
          <span class="count-pill">{{ visibleCards(col).length }}</span>
          <span class="grow"></span>
          <div class="col-menu-wrap">
            <button class="btn small ghost icon-btn tcol-more" title="列操作" @click.stop="toggleMenu(col.id)">
              <Icon name="more" :size="14" />
            </button>
            <div v-if="menuCol === col.id" class="col-menu">
              <div class="cm-swatches">
                <button
                  class="task-swatch none"
                  :class="{ on: !col.color }"
                  title="无颜色"
                  @click.stop="setColumnColor(col.id, undefined)"
                ></button>
                <button
                  v-for="k in TASK_COLORS"
                  :key="k"
                  class="task-swatch"
                  :class="[`sw-${k}`, { on: col.color === k }]"
                  :title="`列颜色:${TASK_COLOR_LABELS[k]}`"
                  @click.stop="setColumnColor(col.id, k)"
                ></button>
              </div>
              <div class="cm-sep"></div>
              <button class="cm-item" @click="openRenameColumn(col)"><Icon name="pen" :size="13" /> 重命名</button>
              <button class="cm-item" :disabled="!col.cards.length" @click="askClearColumn(col)">
                <Icon name="x" :size="13" /> 清空该列
              </button>
              <button class="cm-item danger" @click="askRemoveColumn(col)"><Icon name="trash" :size="13" /> 删除列</button>
            </div>
          </div>
        </header>

        <div class="tcol-body" @dragover="onBodyDragOver(col, $event)" @drop.prevent="onDrop(col)">
          <template v-for="(card, vi) in visibleCards(col)" :key="card.id">
            <div v-if="showLine(col.id, vi)" class="drop-line"></div>
            <article
              class="tcard card"
              :class="{ dragging: dragCard === card.id, done: card.done, 'has-color': !!card.color, highlight: highlightId === card.id }"
              :style="colorStyle(card.color)"
              :data-card-id="card.id"
              draggable="true"
              @dragstart="onCardDragStart(col, card, $event)"
              @dragover="onCardDragOver(col, vi, $event)"
              @drop.prevent="onDrop(col)"
              @dragend="onDragEnd"
              @click="openCard(card)"
            >
              <div class="tcard-top">
                <button
                  class="tcard-check"
                  :class="{ on: card.done }"
                  :title="card.done ? '标记未完成' : '标记完成'"
                  @click.stop="toggleDone(card)"
                >
                  <Icon name="check" :size="11" />
                </button>
                <span v-if="card.priority === 'high'" class="tag danger">高</span>
                <span v-else-if="card.priority === 'low'" class="tag">低</span>
                <span v-if="card.due" class="tcard-due" :class="dueCls(card)" :title="card.due">
                  <Icon name="clock" :size="11" /> {{ shortDue(card.due) }}
                </span>
                <span class="grow"></span>
                <button class="tcard-act" title="复制卡片" @click.stop="duplicate(card)">
                  <Icon name="copy" :size="12" />
                </button>
                <button class="tcard-act danger" title="删除卡片" @click.stop="askDeleteCard(card)">
                  <Icon name="trash" :size="12" />
                </button>
              </div>
              <div class="tcard-title" :title="card.title">{{ card.title }}</div>
              <div v-if="card.tags?.length || card.notes" class="tcard-bottom">
                <span v-if="card.tags?.length" class="tcard-tags">
                  <span v-for="t in card.tags" :key="t" class="tcard-tag">{{ t }}</span>
                </span>
                <span class="grow"></span>
                <span v-if="card.notes" class="tcard-notes" :title="card.notes"><Icon name="list" :size="11" /> 备注</span>
              </div>
            </article>
          </template>
          <div v-if="showLine(col.id, visibleCards(col).length)" class="drop-line"></div>
          <div v-if="!visibleCards(col).length" class="tcol-empty">
            {{ col.cards.length ? '没有匹配的卡片' : '拖卡片到这里,或从下方添加' }}
          </div>
        </div>

        <div class="tcol-foot">
          <input
            v-if="quickCol === col.id"
            ref="quickInput"
            v-model="quickTitle"
            class="input quick-input"
            placeholder="卡片标题,Enter 添加"
            @keydown.enter.prevent="submitQuick(col)"
            @keydown.esc.prevent="cancelQuick"
            @blur="cancelQuick"
          />
          <button v-else class="quick-add" @click="startQuick(col)">
            <Icon name="plus" :size="13" /> 添加卡片
          </button>
        </div>
      </section>

      <section class="tcol addcol">
        <button class="btn small ghost" @click="openCreateColumn"><Icon name="plus" :size="13" /> 新建列</button>
      </section>
    </div>
    </template>

    <!-- 总览:跨看板按紧急度分组,就地完成或点击跳回原板 -->
    <div v-else class="overview">
      <EmptyState v-if="overviewLoading" icon="kanban" title="正在汇总各看板…" />
      <EmptyState
        v-else-if="!overviewSections.length"
        icon="check"
        title="没有待处理"
        desc="全部看板都没有逾期、今日或 3 天内到期的未完成卡片。"
      />
      <template v-else>
        <section v-for="sec in overviewSections" :key="sec.key" class="ov-group">
          <header class="ov-head" :class="sec.key">
            <Icon :name="sec.icon" :size="13" />
            <h3>{{ sec.label }}</h3>
            <span class="count-pill">{{ sec.cards.length }}</span>
          </header>
          <article
            v-for="e in sec.cards"
            :key="`${e.boardKey}/${e.card.id}`"
            class="ov-card card"
            :class="{ 'has-color': !!e.card.color }"
            :style="colorStyle(e.card.color)"
            @click="gotoCard(e)"
          >
            <button class="tcard-check" title="标记完成" @click.stop="completeEntry(e)">
              <Icon name="check" :size="11" />
            </button>
            <span v-if="e.card.priority === 'high'" class="tag danger">高</span>
            <span v-else-if="e.card.priority === 'low'" class="tag">低</span>
            <span class="ov-title" :title="e.card.title">{{ e.card.title }}</span>
            <span v-if="e.card.tags?.length" class="ov-tags">
              <span v-for="t in e.card.tags" :key="t" class="tcard-tag">{{ t }}</span>
            </span>
            <span class="grow"></span>
            <span class="ov-board" :title="e.boardName"><Icon name="folder" :size="11" /> {{ e.boardName }}</span>
            <span v-if="e.card.due" class="tcard-due" :class="sec.key === 'overdue' ? 'over' : sec.key" :title="e.card.due">
              <Icon name="clock" :size="11" /> {{ shortDue(e.card.due) }}
            </span>
          </article>
        </section>
      </template>
    </div>

    <TaskCardDialog
      :open="dialogOpen"
      :card="editing"
      :column-id="editingColumnId"
      :columns="board?.columns ?? []"
      @close="dialogOpen = false"
    />

    <ConfirmDialog
      :open="!!confirmState"
      :title="confirmState?.title ?? ''"
      tone="danger"
      :message="confirmState?.message"
      :details="confirmState?.details"
      confirm-label="删除"
      @confirm="runConfirm"
      @cancel="confirmState = null"
    />

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
  </div>
</template>

<style scoped>
/* ---------- 页头控件 ---------- */

/* 视图切换(单板/总览) */
.view-mode {
  flex-shrink: 0;
}

/* 页头到期徽标:danger 调(与侧栏看板徽标同语义) */
.due-pill {
  background: var(--danger-weak);
  color: var(--danger);
}

.board-select {
  width: 168px;
  flex-shrink: 0;
}

.search-box {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  border: 1px solid var(--border-strong);
  border-radius: 7px;
  background: var(--surface);
  box-shadow: var(--shadow-sm);
  color: var(--text-3);
  transition: border-color 0.15s;
}

.search-box:focus-within {
  border-color: var(--brand);
  box-shadow: 0 0 0 3px var(--brand-weak);
}

.search-box .input {
  border: none;
  box-shadow: none;
  padding: 6px 0;
  width: 150px;
  background: transparent;
}

.search-box .input:focus {
  box-shadow: none;
}

/* ---------- 标签过滤行 ---------- */

.tag-filter {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 7px;
}

.tf-ico {
  color: var(--text-3);
}

.tf-chip {
  padding: 2px 11px;
  font-size: 12px;
  box-shadow: none;
}

.tf-select {
  width: auto;
  padding: 2px 24px 2px 8px;
  font-size: 12px;
  box-shadow: none;
}

.tf-sep {
  width: 1px;
  height: 14px;
  background: var(--border);
  margin: 0 2px;
}

.tf-clear {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: none;
  background: transparent;
  padding: 0 2px;
  font: inherit;
  font-size: 12px;
  color: var(--text-3);
  cursor: pointer;
}

.tf-clear:hover {
  color: var(--danger);
}

/* ---------- 保存失败提示条 ---------- */

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

/* ---------- 删除撤销条 ---------- */

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
  border: none;
  border-radius: 5px;
  background: transparent;
  padding: 3px 8px;
  color: var(--brand);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.12s;
}

.undo-btn:hover {
  background: var(--brand-weak);
}

/* ---------- 看板区 ---------- */

.board {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  overflow-x: auto;
  padding: 2px 2px 10px;
}

.board.col-dragging {
  cursor: grabbing;
}

.tcol {
  width: 264px;
  flex-shrink: 0;
  max-height: calc(100vh - 265px);
  position: relative;
}

/* 列颜色:面板顶部 3px 内嵌色条(inset shadow 叠加 panel 原阴影,不占布局) */
.tcol.has-color {
  box-shadow: inset 0 3px 0 var(--task-color), var(--shadow-sm);
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
  width: auto;
  min-width: 108px;
  max-height: none;
  background: transparent;
  border: 1px dashed var(--border);
  box-shadow: none;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 8px;
}

/* ---------- 列头 ---------- */

.tcol-head {
  cursor: grab;
  user-select: none;
}

.tcol-head.dragging {
  opacity: 0.5;
}

.tcol-title {
  font-size: 11.5px;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--text-2);
  text-transform: uppercase;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.col-menu-wrap {
  position: relative;
}

.col-menu {
  position: absolute;
  right: 0;
  top: calc(100% + 6px);
  z-index: 40;
  min-width: 132px;
  padding: 5px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-lift);
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

/* 列菜单顶部的颜色 swatch 行 */
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

/* ---------- 列体与卡片 ---------- */

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

.tcard {
  padding: 9px 11px;
  cursor: pointer;
  flex-shrink: 0;
  transition: border-color 0.15s, box-shadow 0.15s;
}

/* 卡片颜色:左侧 3px 色条 */
.tcard.has-color {
  border-left: 3px solid var(--task-color);
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

.tcard-top {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 18px;
}

/* 完成勾选框:空心方块,选中填充 --ok */
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
  font-size: 11px;
  font-weight: 600;
  font-family: var(--mono);
  color: var(--text-3);
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

/* 卡片悬停操作钮(复制 / 删除),与删除钮共用显隐 */
.tcard-act {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.12s, color 0.12s, background 0.12s;
}

.tcard:hover .tcard-act {
  opacity: 1;
}

.tcard-act:hover {
  color: var(--brand);
  background: var(--brand-weak);
}

.tcard-act.danger:hover {
  color: var(--danger);
  background: var(--danger-weak);
}

.tcard-title {
  margin-top: 4px;
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

.tcard-notes {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  font-size: 10.5px;
  color: var(--text-3);
}

/* 卡片间落点横条 */
.drop-line {
  height: 3px;
  border-radius: 2px;
  background: var(--brand);
  flex-shrink: 0;
}

/* 跳转高亮:总览点击后目标卡短暂描边 */
.tcard.highlight {
  border-color: var(--brand);
  box-shadow: 0 0 0 3px var(--brand-weak);
}

/* ---------- 总览模式(跨看板) ---------- */

.overview {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 880px;
  padding: 2px 2px 10px;
}

.ov-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.ov-head {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--text-2);
}

.ov-head h3 {
  margin: 0;
  font: inherit;
}

.ov-head.overdue {
  color: var(--danger);
}

.ov-head.today {
  color: var(--warn);
}

.ov-card {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 11px;
  cursor: pointer;
  flex-shrink: 0;
  transition: border-color 0.15s, box-shadow 0.15s;
}

.ov-card:hover {
  border-color: var(--brand);
  box-shadow: var(--shadow-lift);
}

.ov-card.has-color {
  border-left: 3px solid var(--task-color);
}

.ov-card .tcard-check {
  width: 15px;
  height: 15px;
}

.ov-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 550;
  color: var(--text);
}

.ov-tags {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

.ov-board {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--text-3);
}

/* ---------- 列尾快加 ---------- */

.tcol-foot {
  border-top: 1px solid var(--border);
  padding: 8px 10px;
  flex-shrink: 0;
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

@media (prefers-reduced-motion: reduce) {
  .tcard,
  .tcard-check,
  .tcard-act,
  .ov-card,
  .quick-add,
  .undo-btn {
    transition: none;
  }
}
</style>
