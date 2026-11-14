<script setup lang="ts">
// 管理项目标签:与 Godot 4.3+ 官方启动器同一存储(project.godot 的 [application] config/tags)。
// 这里增删保存后,官方启动器的项目卡与标签过滤即刻可见;官方侧改的标签重新加载项目同样可见。
// 「其他项目在用」的建议区与官方启动器行为一致(从既有标签里快速复用)。
import { computed, nextTick, ref, watch } from 'vue'
import Icon from '../Icon.vue'
import { notify } from '../../services/bridge'
import { godotTagLabel, tagChipVars } from '../../utils/godotTags'
import type { GodotProject } from '../../types/godot'

type Row = GodotProject & { _id: string }

const props = defineProps<{
  open: boolean
  project: Row | null
  /** 其他项目的标签用于建议(排除当前项目自己的) */
  projects?: Row[]
}>()

const emit = defineEmits<{ (e: 'close'): void, (e: 'saved'): void }>()

const draft = ref<string[]>([])
const input = ref('')
const saving = ref(false)
const inputEl = ref<HTMLInputElement | null>(null)

watch(
  () => props.open,
  (v) => {
    if (!v) return
    draft.value = [...(props.project?.tags || [])]
    input.value = ''
    nextTick(() => inputEl.value?.focus())
  }
)

/** 其他项目在用的标签:使用次数多 → 名称;已在草稿里的不再重复推荐 */
const suggestions = computed(() => {
  const mine = new Set(draft.value)
  const count = new Map<string, number>()
  for (const p of props.projects || []) {
    if (props.project && p._id === props.project._id) continue
    for (const t of p.tags || []) count.set(t, (count.get(t) || 0) + 1)
  }
  return [...count.entries()]
    .filter(([t]) => !mine.has(t))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([t]) => t)
})

/** 输入侧先做与宿主一致的清洗(引号/反斜杠/换行不安全),写回时宿主还会再兜一道 */
function sanitize(raw: string) {
  return raw.replace(/["\\]/g, '').replace(/\s+/g, ' ').trim()
}

function addTag(raw: string) {
  const t = sanitize(raw)
  input.value = ''
  if (!t || draft.value.includes(t)) return
  draft.value.push(t)
  inputEl.value?.focus()
}

function removeTag(t: string) {
  draft.value = draft.value.filter((x) => x !== t)
}

async function save() {
  const p = props.project
  if (!p || saving.value) return
  saving.value = true
  try {
    const r = await window.services.setProjectTags(p._id, draft.value)
    if (r.ok) {
      notify(r.tags && r.tags.length ? `已保存 ${r.tags.length} 个标签(官方启动器同步可见)` : '已清除全部标签')
      emit('saved')
      emit('close')
    } else {
      notify(r.error || '保存失败')
    }
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="modal-mask" @click.self="emit('close')">
      <div class="card modal">
        <div class="modal-head">
          <div class="modal-title"><Icon name="tag" :size="15" /> 管理标签 · {{ project?.name }}</div>
          <span class="grow"></span>
          <button type="button" class="btn small ghost icon-x" title="关闭" @click="emit('close')">
            <Icon name="x" :size="14" />
          </button>
        </div>

        <!-- 草稿标签 -->
        <div class="field">
          <span class="f-label">当前标签</span>
          <div v-if="draft.length" class="chip-flow">
            <span v-for="t in draft" :key="t" class="tag-chip editable" :style="tagChipVars(t)" :title="`标签:${t}`">
              <span class="chip-text">{{ godotTagLabel(t) }}</span>
              <button type="button" class="chip-x" title="移除标签" @click="removeTag(t)">
                <Icon name="x" :size="11" :stroke-width="2.4" />
              </button>
            </span>
          </div>
          <div v-else class="empty-tags">暂无标签。加一个,项目卡与官方启动器都会用它检索/过滤。</div>
        </div>

        <!-- 添加 -->
        <div class="field">
          <label class="f-label" for="pt-add">添加标签</label>
          <div class="dir-row">
            <input
              id="pt-add"
              ref="inputEl"
              v-model="input"
              class="input"
              placeholder="输入后回车或点「添加」,如:rpg / demo / 我的标签"
              maxlength="40"
              autocomplete="off"
              spellcheck="false"
              @keydown.enter.prevent="addTag(input)"
            />
            <button type="button" class="btn ghost" :disabled="!sanitize(input)" @click="addTag(input)">
              <Icon name="plus" :size="14" /> 添加
            </button>
          </div>
        </div>

        <!-- 其他项目在用的标签(官方启动器同款复用入口) -->
        <div v-if="suggestions.length" class="field">
          <span class="f-label">其他项目在用</span>
          <div class="chip-flow">
            <button
              v-for="t in suggestions"
              :key="t"
              type="button"
              class="tag-chip suggest"
              :style="tagChipVars(t)"
              :title="`添加标签:${t}`"
              @click="addTag(t)"
            >
              <Icon name="plus" :size="10" :stroke-width="2.2" />
              {{ godotTagLabel(t) }}
            </button>
          </div>
        </div>

        <div class="f-hint wrap">
          标签存储在项目的 <code>project.godot</code>(<code>config/tags</code>),与 Godot 官方启动器(4.3+)互通显示与过滤。
        </div>

        <div class="modal-foot">
          <span class="grow"></span>
          <button type="button" class="btn ghost" @click="emit('close')">取消</button>
          <button type="button" class="btn primary" :disabled="saving" @click="save">
            <Icon name="check" :size="13" /> {{ saving ? '保存中…' : '保存' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.chip-flow {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.empty-tags {
  padding: 8px 0;
  font-size: 12px;
  color: var(--text-3);
}

/* 草稿 chip:可移除 */
.chip-x {
  display: inline-flex;
  align-items: center;
  margin-left: 2px;
  padding: 1px;
  border: none;
  background: none;
  color: inherit;
  cursor: pointer;
  border-radius: 3px;
  opacity: 0.65;
  transition: opacity 0.12s;
}

.chip-x:hover {
  opacity: 1;
}

/* 建议 chip:可点击添加,带 + 号 */
.tag-chip.suggest {
  border: none;
  cursor: pointer;
  font: inherit;
  font-size: 11px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.tag-chip.suggest:hover {
  filter: brightness(1.1);
}
</style>
