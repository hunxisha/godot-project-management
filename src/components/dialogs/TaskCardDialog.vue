<script setup lang="ts">
// 任务卡片详情弹窗:左栏写内容(标题/子任务/备注),右栏是元数据(优先级/截止日/所属列/标签/颜色)。
// 设计参考 Things / Todoist 的「先写清楚做什么,再补属性」:内容区占视觉主位,
// 元数据用时间预设(今天/明天/+3 天)降低随手记录的成本。
// 保存仍走 useTasks.saveCard 一次落库(字段 + 可选换列);归档是轻动作,不弹二次确认。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Icon from '../Icon.vue'
import { useTasks } from '../../composables/useTasks'
import { addDays, checklistProgress, dueHint, newId, TASK_COLORS, TASK_COLOR_LABELS, todayStr } from '../../utils/taskBoard'
import type { TaskCard, TaskChecklistItem, TaskColumn, TaskColor, TaskPriority } from '../../types/godot'

const props = defineProps<{
  open: boolean
  /** 编辑中的卡片(open 时必有值) */
  card: TaskCard | null
  /** 卡片当前所在列 id */
  columnId: string
  /** 看板全部列(所属列下拉) */
  columns: TaskColumn[]
}>()

const emit = defineEmits<{ (e: 'close'): void }>()

const { saveCard, archiveCard, tags } = useTasks()

const title = ref('')
const notes = ref('')
const priority = ref<TaskPriority>('normal')
const due = ref('')
const columnId = ref('')
const tagList = ref<string[]>([])
const tagDraft = ref('')
/** 卡片颜色('' = 无颜色);存库走色板 key,值随 --task-c-<key> 变 */
const color = ref<TaskColor | ''>('')
/** 子任务清单(本地副本,保存时一次性写库) */
const checklist = ref<TaskChecklistItem[]>([])
const newItem = ref('')
const busy = ref(false)
const titleInput = ref<HTMLInputElement | null>(null)
const itemInput = ref<HTMLInputElement | null>(null)

const today = todayStr()

watch(
  () => props.open,
  (open) => {
    if (!open) return
    const c = props.card
    title.value = c?.title ?? ''
    notes.value = c?.notes ?? ''
    priority.value = c?.priority ?? 'normal'
    due.value = c?.due ?? ''
    columnId.value = props.columnId
    tagList.value = [...(c?.tags ?? [])]
    tagDraft.value = ''
    color.value = c?.color ?? ''
    checklist.value = (c?.checklist ?? []).map((item) => ({ ...item }))
    newItem.value = ''
    busy.value = false
    nextTick(() => titleInput.value?.focus())
  }
)

const canSave = computed(() => !!title.value.trim() && !busy.value)
const progress = computed(() => checklistProgress({ checklist: checklist.value } as TaskCard))
const currentColumn = computed(() => props.columns.find((c) => c.id === columnId.value)?.title ?? '—')

/** 截止日人话提示(今天 / 明天 / 逾期 2 天) */
const dueText = computed(() => dueHint(due.value || undefined, today))

function setDue(day: string) {
  due.value = day
}

function shiftDue(days: number) {
  due.value = addDays(due.value || today, days)
}

function addTag() {
  const t = tagDraft.value.trim()
  if (!t) return
  if (!tagList.value.includes(t)) tagList.value.push(t)
  tagDraft.value = ''
}

function removeTag(t: string) {
  tagList.value = tagList.value.filter((x) => x !== t)
}

function addItem() {
  const text = newItem.value.trim()
  if (!text) return
  checklist.value.push({ id: newId(), text })
  newItem.value = ''
  nextTick(() => itemInput.value?.focus())
}

function removeItem(id: string) {
  checklist.value = checklist.value.filter((item) => item.id !== id)
}

function toggleItem(item: TaskChecklistItem) {
  item.done = item.done === true ? undefined : true
}

async function onSave() {
  if (!canSave.value || !props.card) return
  busy.value = true
  await saveCard(
    props.card.id,
    {
      title: title.value,
      notes: notes.value.trim() || undefined,
      priority: priority.value,
      due: due.value.trim() || undefined,
      tags: tagList.value,
      color: color.value || undefined,
      checklist: checklist.value
    },
    columnId.value
  )
  busy.value = false
  emit('close')
}

/** 归档:可直接在归档箱恢复,不再弹确认;失败时保持弹窗并显示 saveError 提示条 */
async function onArchive() {
  if (busy.value || !props.card) return
  busy.value = true
  await archiveCard(props.card.id)
  busy.value = false
  emit('close')
}

// Escape 关闭;Ctrl/Cmd+Enter 保存(busy 期间只允许关闭)
function onKey(e: KeyboardEvent) {
  if (!props.open) return
  if (e.key === 'Escape' && !busy.value) {
    emit('close')
    return
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault()
    void onSave()
  }
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="modal-mask" @click.self="!busy && emit('close')">
      <div class="card modal task-modal">
        <div class="modal-head td-head">
          <div class="modal-title"><Icon name="pen" :size="15" /> 卡片详情</div>
          <span v-if="card?.done" class="tag ok">已完成</span>
          <span class="tag td-col-tag" :title="`当前位于「${currentColumn}」`">
            <Icon name="layers" :size="11" /> {{ currentColumn }}
          </span>
          <span class="grow"></span>
          <span class="td-kbd-hint" title="保存快捷键"><span class="kbd">Ctrl</span> + <span class="kbd">Enter</span></span>
          <button type="button" class="btn small ghost icon-x" title="关闭" :disabled="busy" @click="emit('close')">
            <Icon name="x" :size="14" />
          </button>
        </div>

        <div class="td-grid">
          <div class="td-main">
            <div class="field">
              <label class="f-label" for="task-card-title">标题</label>
              <input
                id="task-card-title"
                ref="titleInput"
                v-model="title"
                class="input td-title-input"
                placeholder="这张卡要做什么?"
                :disabled="busy"
                @keydown.enter="onSave"
              />
            </div>

            <div class="field">
              <div class="td-check-head">
                <label class="f-label">子任务</label>
                <span v-if="progress.total" class="td-check-count">{{ progress.done }} / {{ progress.total }}</span>
              </div>
              <div v-if="progress.total" class="bar td-check-bar">
                <div class="fill" :style="{ width: `${progress.pct}%` }"></div>
              </div>
              <ul v-if="checklist.length" class="td-check-list">
                <li v-for="item in checklist" :key="item.id" class="td-check-row">
                  <button
                    type="button"
                    class="td-check-box"
                    :class="{ on: item.done }"
                    :title="item.done ? '标记未完成' : '标记完成'"
                    :disabled="busy"
                    @click="toggleItem(item)"
                  >
                    <Icon name="check" :size="10" />
                  </button>
                  <input
                    v-model="item.text"
                    class="td-check-text"
                    :class="{ done: item.done }"
                    :disabled="busy"
                    aria-label="子任务内容"
                  />
                  <button
                    type="button"
                    class="td-check-del"
                    title="删除子任务"
                    :disabled="busy"
                    @click="removeItem(item.id)"
                  >
                    <Icon name="x" :size="11" />
                  </button>
                </li>
              </ul>
              <div class="td-check-add">
                <Icon name="plus" :size="12" class="td-check-add-ico" />
                <input
                  ref="itemInput"
                  v-model="newItem"
                  class="input td-check-add-input"
                  placeholder="拆一个子任务,回车添加"
                  :disabled="busy"
                  @keydown.enter.prevent="addItem"
                />
              </div>
            </div>

            <div class="field td-notes-field">
              <label class="f-label" for="task-card-notes">备注</label>
              <textarea
                id="task-card-notes"
                v-model="notes"
                class="input notes-input"
                rows="5"
                placeholder="补充说明、链接、验收标准…"
                :disabled="busy"
              ></textarea>
            </div>
          </div>

          <aside class="td-side">
            <div class="field">
              <label class="f-label">优先级</label>
              <div class="seg td-priority" role="group" aria-label="优先级">
                <button type="button" :class="{ on: priority === 'low' }" :disabled="busy" @click="priority = 'low'">低</button>
                <button type="button" :class="{ on: priority === 'normal' }" :disabled="busy" @click="priority = 'normal'">中</button>
                <button type="button" :class="{ on: priority === 'high' }" :disabled="busy" @click="priority = 'high'">高</button>
              </div>
            </div>

            <div class="field">
              <div class="td-field-head">
                <label class="f-label" for="task-card-due">截止日期</label>
                <button
                  v-if="due"
                  type="button"
                  class="td-due-clear"
                  title="清除截止日"
                  :disabled="busy"
                  @click="due = ''"
                >
                  <Icon name="x" :size="11" /> 清除
                </button>
              </div>
              <div class="td-due-presets">
                <button type="button" class="chip td-preset" :disabled="busy" @click="setDue(today)">今天</button>
                <button type="button" class="chip td-preset" :disabled="busy" @click="setDue(addDays(today, 1))">明天</button>
                <button type="button" class="chip td-preset" :disabled="busy" @click="setDue(addDays(today, 3))">+3 天</button>
                <button v-if="due" type="button" class="chip td-preset" :disabled="busy" @click="shiftDue(1)">延 1 天</button>
              </div>
              <input id="task-card-due" v-model="due" type="date" class="input td-date" :disabled="busy" />
              <div v-if="due" class="f-hint">{{ dueText }}</div>
            </div>

            <div class="field">
              <label class="f-label" for="task-card-column">所属列</label>
              <select id="task-card-column" v-model="columnId" class="select" :disabled="busy">
                <option v-for="c in columns" :key="c.id" :value="c.id">{{ c.title }}</option>
              </select>
              <div class="f-hint">换列保存后追加到目标列末尾</div>
            </div>

            <div class="field">
              <label class="f-label" for="task-card-tag">标签</label>
              <div class="tag-editor">
                <span v-for="t in tagList" :key="t" class="tag brand">
                  {{ t }}
                  <button type="button" class="tag-x" title="移除标签" :disabled="busy" @click="removeTag(t)">
                    <Icon name="x" :size="10" />
                  </button>
                </span>
                <input
                  id="task-card-tag"
                  v-model="tagDraft"
                  class="input tag-input"
                  list="task-tag-suggestions"
                  placeholder="输入后回车"
                  :disabled="busy"
                  @keydown.enter.prevent="addTag"
                />
                <datalist id="task-tag-suggestions">
                  <option v-for="t in tags" :key="t" :value="t" />
                </datalist>
              </div>
            </div>

            <div class="field">
              <label class="f-label">颜色</label>
              <div class="swatch-row" role="group" aria-label="卡片颜色">
                <button
                  type="button"
                  class="task-swatch none"
                  :class="{ on: !color }"
                  title="无颜色"
                  :disabled="busy"
                  @click="color = ''"
                ></button>
                <button
                  v-for="k in TASK_COLORS"
                  :key="k"
                  type="button"
                  class="task-swatch"
                  :class="[`sw-${k}`, { on: color === k }]"
                  :title="`卡片颜色:${TASK_COLOR_LABELS[k]}`"
                  :disabled="busy"
                  @click="color = k"
                ></button>
              </div>
            </div>
          </aside>
        </div>

        <div class="modal-foot td-foot">
          <button
            type="button"
            class="btn small ghost td-archive"
            title="移入归档箱,可在归档视图恢复"
            :disabled="busy"
            @click="onArchive"
          >
            <Icon name="archive" :size="13" /> 归档
          </button>
          <span class="grow"></span>
          <button type="button" class="btn ghost" :disabled="busy" @click="emit('close')">取消</button>
          <button type="button" class="btn primary" :disabled="!canSave" @click="onSave">
            <span v-if="busy" class="spin"></span>
            保存
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.task-modal {
  width: min(740px, calc(100vw - 48px));
}

.td-head {
  flex-wrap: wrap;
  gap: 7px;
}

.td-col-tag {
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.td-kbd-hint {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 10.5px;
  color: var(--text-3);
}

/* 两栏:左边写内容,右边补属性;窄窗口回落单栏 */
.td-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 236px;
  gap: 18px;
}

.td-main,
.td-side {
  min-width: 0;
}

.td-main .field:last-child,
.td-side .field:last-child {
  margin-bottom: 0;
}

.td-title-input {
  font-size: 15px;
  font-weight: 600;
  padding: 9px 12px;
}

.td-notes-field {
  display: flex;
  flex-direction: column;
}

.notes-input {
  resize: vertical;
  min-height: 118px;
  font-family: inherit;
  line-height: 1.65;
}

.td-check-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.td-check-head .f-label {
  margin-bottom: 5px;
}

.td-check-count {
  margin-left: auto;
  margin-bottom: 5px;
  font-size: 11px;
  font-weight: 700;
  color: var(--brand);
}

.td-check-bar {
  margin-bottom: 8px;
}

.td-check-list {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin: 0 0 6px;
  padding: 0;
  list-style: none;
}

.td-check-row {
  display: flex;
  align-items: center;
  gap: 7px;
  min-height: 30px;
}

/* 子任务勾选框:与看板卡片的完成框同语言,略小一号 */
.td-check-box {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 15px;
  height: 15px;
  flex-shrink: 0;
  padding: 0;
  border: 1.5px solid var(--border-strong);
  border-radius: 4px;
  background: transparent;
  color: transparent;
  cursor: pointer;
  transition: border-color 0.12s, background 0.12s, color 0.12s;
}

.td-check-box:hover {
  border-color: var(--ok);
}

.td-check-box.on {
  background: var(--ok);
  border-color: var(--ok);
  color: #fff;
}

.td-check-text {
  flex: 1;
  min-width: 0;
  border: 1px solid transparent;
  border-radius: 5px;
  background: transparent;
  padding: 4px 7px;
  color: var(--text);
  font: inherit;
  font-size: 12.5px;
  outline: none;
}

.td-check-text:hover {
  background: var(--surface-2);
}

.td-check-text:focus {
  border-color: var(--brand);
  background: var(--surface);
  box-shadow: 0 0 0 3px var(--brand-weak);
}

.td-check-text.done {
  color: var(--text-3);
  text-decoration: line-through;
}

.td-check-del {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  flex-shrink: 0;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.12s, background 0.12s, color 0.12s;
}

.td-check-row:hover .td-check-del,
.td-check-del:focus-visible {
  opacity: 1;
}

.td-check-del:hover {
  background: var(--danger-weak);
  color: var(--danger);
}

.td-check-add {
  display: flex;
  align-items: center;
  gap: 6px;
}

.td-check-add-ico {
  flex-shrink: 0;
  color: var(--text-3);
}

.td-check-add-input {
  flex: 1;
  min-width: 0;
  padding: 5px 9px;
  font-size: 12.5px;
  box-shadow: none;
  border-style: dashed;
}

.td-priority {
  width: 100%;
}

.td-priority button {
  flex: 1;
}

.td-field-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.td-field-head .f-label {
  margin-bottom: 5px;
}

.td-due-clear {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  margin-left: auto;
  margin-bottom: 5px;
  border: none;
  background: transparent;
  padding: 0;
  font: inherit;
  font-size: 11px;
  color: var(--text-3);
  cursor: pointer;
}

.td-due-clear:hover {
  color: var(--danger);
}

.td-due-presets {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-bottom: 7px;
}

.td-preset {
  padding: 2px 9px;
  font-size: 11.5px;
  box-shadow: none;
}

.td-date {
  width: 100%;
  padding: 5px 9px;
  font-size: 12.5px;
}

.swatch-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.tag-editor {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.tag-x {
  display: inline-flex;
  align-items: center;
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  padding: 0;
  opacity: 0.7;
}

.tag-x:hover {
  opacity: 1;
}

/* 自由宽度的标签输入:最小宽度保证占位符可读,随内容自然收缩 */
.tag-input {
  flex: 1;
  min-width: 128px;
  box-shadow: none;
  padding: 3px 9px;
  font-size: 12px;
}

.td-archive {
  color: var(--text-2);
}

.td-archive:hover:not(:disabled) {
  color: var(--brand);
}

@media (max-width: 720px) {
.td-grid {
    grid-template-columns: minmax(0, 1fr);
    gap: 4px;
  }

  .td-kbd-hint {
    display: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .td-check-del {
    transition: none;
  }
}
</style>
