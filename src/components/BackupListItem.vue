<script setup lang="ts">
// 备份列表条目(分组视图与时间轴视图共用)。
// 纯展示 + 事件上抛,不持有任何状态。
import { computed } from 'vue'
import Icon from './Icon.vue'
import { fmtSize, formatRelative, formatTime } from '../utils/format'
import type { BackupRecord } from '../types/godot'

const props = withDefaults(defineProps<{
  record: BackupRecord
  /** 项目记录已不存在:不能覆盖恢复 */
  orphan?: boolean
  batchMode?: boolean
  selected?: boolean
  busy?: boolean
  /** 时间轴视图需要显示项目名 */
  showProject?: boolean
}>(), {
  orphan: false,
  batchMode: false,
  selected: false,
  busy: false,
  showProject: false
})

const emit = defineEmits<{
  (e: 'toggle'): void
  (e: 'restore'): void
  (e: 'rename'): void
  (e: 'verify'): void
  (e: 'remove'): void
  (e: 'reveal'): void
}>()

/** 标题:优先备注名,否则「项目名 · 时间」 */
const title = computed(() => props.record.label || defaultTitle.value)
const defaultTitle = computed(
  () => `${props.record.projectName || '备份'} · ${formatTime(props.record.createdAt)}`
)

const modeLabel = computed(() => (props.record.mode === 'zip' ? 'zip' : '快照'))

const sizeText = computed(
  () => `${fmtSize(props.record.size)} · ${props.record.fileCount ?? 0} 文件`
)

/** 校验状态:missing 优先,其次 verified / 未校验 */
const verifyState = computed<'missing' | 'ok' | 'bad' | 'none'>(() => {
  if (props.record.missing) return 'missing'
  if (props.record.verified === true) return 'ok'
  if (props.record.verified === false) return 'bad'
  return 'none'
})

const verifyText = computed(() => {
  switch (verifyState.value) {
    case 'missing': return '文件缺失'
    case 'ok': return '有效'
    case 'bad': return '无效'
    default: return '未校验'
  }
})

const verifying = computed(() => props.busy)
</script>

<template>
  <div class="bk-row" :class="{ missing: record.missing, selected }">
    <label v-if="batchMode" class="bk-check">
      <input
        type="checkbox"
        class="chk"
        :checked="selected"
        :disabled="busy"
        @change="emit('toggle')"
      />
    </label>
    <span v-else class="bk-dot" :class="verifyState" :title="verifyText" />

    <div class="bk-main">
      <div class="bk-line">
        <span class="bk-title" :title="title">{{ title }}</span>
        <span v-if="showProject && record.label" class="bk-proj">{{ record.projectName }}</span>
        <span class="tag">{{ modeLabel }}</span>
        <span v-if="record.level && record.mode === 'zip'" class="tag">L{{ record.level }}</span>
        <span v-if="record.engineVersion" class="tag">{{ record.engineVersion }}</span>
        <span v-if="record.includeCache" class="tag" title="包含 .godot 编辑器缓存">含缓存</span>
        <span class="bk-meta">{{ sizeText }}</span>
        <span class="bk-sep">·</span>
        <span class="bk-meta" :title="formatTime(record.createdAt)">
          {{ formatRelative(record.createdAt) }}
        </span>
        <span v-if="orphan" class="tag warn"><Icon name="alert" :size="10" /> 项目已移除</span>
        <span
          class="bk-verify"
          :class="verifyState"
          :title="record.verifyError || verifyText"
        >
          <span v-if="verifying" class="spin"></span>
          <Icon v-else :name="verifyState === 'ok' ? 'shield-check' : 'alert'" :size="11" />
          {{ verifyText }}
        </span>
      </div>
      <div class="bk-path mono" :title="record.destPath">{{ record.destPath }}</div>
    </div>

    <div v-if="!batchMode" class="bk-acts">
      <button
        class="btn small primary"
        :disabled="busy || record.missing"
        :title="record.missing ? '备份文件已不存在,无法恢复' : '从这份备份恢复'"
        @click="emit('restore')"
      >
        <Icon name="upload" :size="12" /> 恢复
      </button>
      <button class="btn small ghost icon-act" title="在文件管理器中定位" :disabled="busy" @click="emit('reveal')">
        <Icon name="external" :size="13" />
      </button>
      <button class="btn small ghost icon-act" title="编辑备注名" :disabled="busy" @click="emit('rename')">
        <Icon name="pen" :size="13" />
      </button>
      <button
        class="btn small ghost icon-act"
        :title="record.missing ? '文件已丢失,无法校验' : '校验备份内容是否可用'"
        :disabled="busy || record.missing"
        @click="emit('verify')"
      >
        <Icon name="shield-check" :size="13" />
      </button>
      <button
        class="btn small danger-text"
        :disabled="busy"
        :title="record.missing ? '移除这条失效记录' : '删除备份文件(移入回收站)'"
        @click="emit('remove')"
      >
        {{ record.missing ? '移除记录' : '删除' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.bk-row {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 9px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
  transition: border-color 0.15s, box-shadow 0.15s;
}

.bk-row:hover {
  border-color: var(--border-strong);
  box-shadow: var(--shadow-sm);
}

.bk-row.selected {
  border-color: var(--brand);
  background: var(--brand-weak);
}

.bk-row.missing {
  opacity: 0.66;
}

.bk-check {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  cursor: pointer;
}

/* 状态点:颜色即结论 */
.bk-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--text-3);
}

.bk-dot.ok { background: var(--ok); }
.bk-dot.bad,
.bk-dot.missing { background: var(--danger); }
.bk-dot.none { background: var(--border-strong); }

.bk-main {
  flex: 1;
  min-width: 0;
}

.bk-line {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
}

.bk-title {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text);
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bk-proj {
  font-size: 11.5px;
  color: var(--text-3);
}

.bk-meta {
  font-size: 11.5px;
  color: var(--text-3);
  white-space: nowrap;
}

.bk-sep {
  font-size: 11.5px;
  color: var(--border-strong);
}

.bk-verify {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
}

.bk-verify.ok { color: var(--ok); }
.bk-verify.bad,
.bk-verify.missing { color: var(--danger); }
.bk-verify.none { color: var(--text-3); }

.bk-path {
  margin-top: 2px;
  font-size: 10.5px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bk-acts {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.icon-act {
  width: 28px;
  padding: 3px 0;
  color: var(--text-2);
}

.icon-act:hover:not(:disabled) {
  color: var(--brand);
}
</style>
