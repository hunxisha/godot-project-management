<script setup lang="ts">
// 左栏的一行:只显示状态,不显示动作。
// 旧版每张卡两个按钮(ToolCard.vue:56-73),18 张卡就是 36 个按钮;双栏后动作收在右栏头部,
// 这一行只回答「这项跑过没有、出了几条」。
import { computed } from 'vue'
import type { Tool, ToolResult } from '../../tools/types'

const props = defineProps<{
  tool: Tool
  result: ToolResult | null
  /** 宿主能力是否齐备(isSupported 的产物):判据在装配层算,组件里不写第二套 */
  supported: boolean
  running: boolean
  selected: boolean
}>()
const emit = defineEmits<{ (e: 'select', id: string): void }>()

const parts = computed(() => {
  const c = { error: 0, warn: 0, info: 0 }
  for (const f of props.result?.findings || []) c[f.severity]++
  return c
})
const clean = computed(
  () => !!props.result && props.result.ok && parts.value.error + parts.value.warn + parts.value.info === 0
)
const failed = computed(() => !!props.result && !props.result.ok)
</script>

<template>
  <button
    :class="['row', { on: selected }]"
    :aria-current="selected ? 'true' : undefined"
    :title="!supported ? '当前宿主不支持' : failed ? (result && result.error) || '检查失败' : tool.name"
    @click="emit('select', tool.id)"
  >
    <span :class="['dot', { run: running, fail: failed, na: !supported, ok: clean }]"></span>
    <span class="name">{{ tool.name }}</span>
    <span v-if="running" class="spin"></span>
    <span v-else-if="!supported" class="na">不支持</span>
    <span v-else-if="failed" class="fail">失败</span>
    <span v-else-if="!result" class="idle">未跑</span>
    <span v-else-if="clean" class="ok">无问题</span>
    <span v-else class="num mono">
      <b v-if="parts.error" class="err">{{ parts.error }}</b>
      <b v-if="parts.warn" class="wrn">{{ parts.warn }}</b>
      <i v-if="parts.info">{{ parts.info }}</i>
    </span>
  </button>
</template>

<style scoped>
.row {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  min-width: 0;
  padding: 5px 8px 5px 6px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-2);
  font: inherit;
  font-size: 12.5px;
  line-height: 18px;
  text-align: left;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

.row:hover {
  background: var(--surface-2);
  color: var(--text);
}

.row.on {
  background: var(--brand-weak);
  color: var(--brand);
  font-weight: 600;
}

/* 状态点用圆点,与右栏 issue 行的 3px 竖条区分开:一个是「跑没跑」,一个是「哪条要紧」 */
.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--border-strong);
  flex-shrink: 0;
}

.dot.ok {
  background: var(--ok);
}

.dot.fail {
  background: var(--danger);
}

.dot.run {
  background: var(--brand);
}

.dot.na {
  background: var(--surface-3);
}

.name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.num {
  display: inline-flex;
  gap: 5px;
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  color: var(--text-3);
}

.num b {
  font-weight: 700;
}

.num .err {
  color: var(--danger);
}

.num .wrn {
  color: var(--warn);
}

.idle,
.na {
  font-size: 11px;
  color: var(--text-3);
}

.fail {
  font-size: 11px;
  color: var(--danger);
}

.ok {
  font-size: 11px;
  color: var(--ok);
}
</style>
