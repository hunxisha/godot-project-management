<script setup lang="ts">
// 任务卡片编辑弹窗:标题/优先级/截止日/颜色/标签/备注/所属列。
// 保存经 useTasks.saveCard 一次落库(字段更新 + 可选换列 = 追加到目标列尾);
// 删除不在这里做(卡片悬停删除钮 + 看板页 ConfirmDialog),避免弹窗叠弹窗。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Icon from '../Icon.vue'
import { useTasks } from '../../composables/useTasks'
import { TASK_COLORS, TASK_COLOR_LABELS } from '../../utils/taskBoard'
import type { TaskCard, TaskColumn, TaskColor, TaskPriority } from '../../types/godot'

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

const { saveCard, tags } = useTasks()

const title = ref('')
const notes = ref('')
const priority = ref<TaskPriority>('normal')
const due = ref('')
const columnId = ref('')
const tagList = ref<string[]>([])
const tagDraft = ref('')
/** 卡片颜色('' = 无颜色);存库走色板 key,值随 --task-c-<key> 变 */
const color = ref<TaskColor | ''>('')
const busy = ref(false)
const titleInput = ref<HTMLInputElement | null>(null)

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
    busy.value = false
    nextTick(() => titleInput.value?.focus())
  }
)

const canSave = computed(() => !!title.value.trim() && !busy.value)

function addTag() {
  const t = tagDraft.value.trim()
  if (!t) return
  if (!tagList.value.includes(t)) tagList.value.push(t)
  tagDraft.value = ''
}

function removeTag(t: string) {
  tagList.value = tagList.value.filter((x) => x !== t)
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
      color: color.value || undefined
    },
    columnId.value
  )
  busy.value = false
  emit('close')
}

// Escape 关闭(与 BackupCreateDialog 同约定;busy 期间不关)
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && props.open && !busy.value) emit('close')
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="modal-mask" @click.self="!busy && emit('close')">
      <div class="card modal sm">
        <div class="modal-head">
          <div class="modal-title"><Icon name="pen" :size="15" /> 编辑卡片</div>
          <span class="grow"></span>
          <button type="button" class="btn small ghost icon-x" title="关闭" :disabled="busy" @click="emit('close')">
            <Icon name="x" :size="14" />
          </button>
        </div>

        <div class="field">
          <label class="f-label" for="task-card-title">标题</label>
          <input
            id="task-card-title"
            ref="titleInput"
            v-model="title"
            class="input"
            placeholder="这张卡要做什么?"
            :disabled="busy"
            @keydown.enter="onSave"
          />
        </div>

        <div class="field">
          <label class="f-label">优先级</label>
          <div class="seg" role="group" aria-label="优先级">
            <button type="button" :class="{ on: priority === 'low' }" :disabled="busy" @click="priority = 'low'">低</button>
            <button type="button" :class="{ on: priority === 'normal' }" :disabled="busy" @click="priority = 'normal'">中</button>
            <button type="button" :class="{ on: priority === 'high' }" :disabled="busy" @click="priority = 'high'">高</button>
          </div>
        </div>

        <div class="field">
          <label class="f-label" for="task-card-due">截止日期</label>
          <input id="task-card-due" v-model="due" type="date" class="input" :disabled="busy" />
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

        <div class="field">
          <label class="f-label" for="task-card-column">所属列</label>
          <select id="task-card-column" v-model="columnId" class="select" :disabled="busy">
            <option v-for="c in columns" :key="c.id" :value="c.id">{{ c.title }}</option>
          </select>
          <div class="f-hint">换列保存后卡片会追加到目标列末尾</div>
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
              placeholder="输入后回车添加"
              :disabled="busy"
              @keydown.enter.prevent="addTag"
            />
            <datalist id="task-tag-suggestions">
              <option v-for="t in tags" :key="t" :value="t" />
            </datalist>
          </div>
        </div>

        <div class="field">
          <label class="f-label" for="task-card-notes">备注</label>
          <textarea
            id="task-card-notes"
            v-model="notes"
            class="input notes-input"
            rows="4"
            placeholder="补充说明、链接、验收标准…"
            :disabled="busy"
          ></textarea>
        </div>

        <div class="modal-foot">
          <button type="button" class="btn ghost" :disabled="busy" @click="emit('close')">取消</button>
          <span class="grow"></span>
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
  min-width: 140px;
  box-shadow: none;
  padding: 3px 9px;
  font-size: 12px;
}

.notes-input {
  resize: vertical;
  min-height: 84px;
  font-family: inherit;
}
</style>
