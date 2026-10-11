<script setup lang="ts">
// 动作账本面板(§5.5 / Q29=C / A-16)。全局面板与工具页底部那「最近 5 条」共用这一个组件,
// 差别只在父级传进来的列表已经是筛过的(recentFor / entriesForProject 都在 toollog 里)。
//
// 那一行的话来自 `entrySummaryText`(它内部又复用 orchestrate.summaryText),回滚按钮亮不亮来自
// 账本里那个**重算过**的 canRollback —— 渲染层不自己判断「这一轮能不能还原」,也不另写一句理由。
import Icon from '../Icon.vue'
import type { ToolLogEntry } from '../../toolkit/toollog'
import { entrySummaryText } from '../../toolkit/toollog'
import { formatTime } from '../../utils/format'

const props = defineProps<{ entries: ToolLogEntry[], busyId?: string }>()
const emit = defineEmits<{ (e: 'rollback', entry: ToolLogEntry): void }>()

const keyOf = (e: ToolLogEntry) => `${e.toolId}|${e.at}`
</script>

<template>
  <div class="ledger">
    <p v-if="!(props.entries || []).length" class="dim">
      <Icon name="layers" :size="13" /> 还没有记录。执行一次工具之后,这里会列出「哪一轮、动了哪些文件、备份叫什么名字」。
    </p>
    <div v-for="e in props.entries || []" :key="keyOf(e)" class="row">
      <div class="main">
        <span class="time">{{ formatTime(e.at) }}</span>
        <span class="tool">{{ e.toolName || e.toolId }}</span>
        <span class="sum">{{ entrySummaryText(e) }}</span>
      </div>
      <div class="side">
        <button
          v-if="e.canRollback"
          class="btn small ghost"
          type="button"
          :disabled="props.busyId === keyOf(e)"
          @click="emit('rollback', e)"
        >
          <Icon name="refresh" :size="13" /> {{ props.busyId === keyOf(e) ? '还原中' : '还原这一轮' }}
        </button>
        <span v-else class="norev" title="回滚只还原写入,做不到把回收站的东西捞回来或把新名引用改回去">不可自动还原</span>
      </div>
      <p v-if="(e.failed || []).length" class="failed">
        失败 {{ e.failed.length }} 条:
        <span v-for="(f, i) in e.failed.slice(0, 3)" :key="i" class="one">{{ f.rel || '(没给路径)' }} — {{ f.error }}</span>
        <span v-if="e.failed.length > 3">…另有 {{ e.failed.length - 3 }} 条</span>
      </p>
    </div>
  </div>
</template>

<style scoped>
.row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 5px 0;
  border-bottom: 1px solid var(--surface-2);
  font-size: 12px;
}

.row:last-child {
  border-bottom: none;
}

.main {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.time {
  color: var(--text-3);
  font-family: var(--mono);
  white-space: nowrap;
}

.tool {
  color: var(--text);
  font-weight: 600;
  white-space: nowrap;
}

.sum {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-2);
}

.norev {
  color: var(--text-3);
  font-size: 11.5px;
  cursor: help;
}

.failed {
  flex-basis: 100%;
  margin: 0;
  color: var(--danger);
  font-size: 11.5px;
  line-height: 1.5;
}

.one {
  display: inline-block;
  margin-right: 8px;
  color: var(--text-2);
}

.dim {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  color: var(--text-3);
  font-size: 12px;
}
</style>
