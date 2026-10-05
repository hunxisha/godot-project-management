<script setup lang="ts">
// 通用工具卡片:UI 不认识任何具体检查器,只渲染 `Tool` + `ToolResult`(spec §2.1)。
// 新增检查器不需要改这个文件 —— 名称/一句话/结论全部来自注册表。
import { computed } from 'vue'
import Icon from '../Icon.vue'
import { fmtMs } from '../../tools/treeUtils'
import type { Tool, ToolResult } from '../../tools/types'

const props = defineProps<{
  tool: Tool
  /** null = 这个工具还没跑过 */
  result: ToolResult | null
  /** 这张卡片自己正在跑 */
  running: boolean
  /** 别的扫描/检查在途:此时不允许再点(两个 run 会互相把 running 写乱) */
  busy: boolean
  /** 宿主能力是否齐备(isSupported 的产物;caps 是构造时快照,这里不调任何原语) */
  supported: boolean
  /** 这个工具的结论面板当前是否展开:让「结果」按钮呈按下态,收起/展开在点击处就有反馈 */
  open: boolean
}>()
const emit = defineEmits<{ (e: 'run', id: string): void; (e: 'open', id: string): void }>()

/** 按级别数结论条数(只读统计:不排序、不截取、不改动收到的 findings) */
const parts = computed(() => {
  const c = { error: 0, warn: 0, info: 0 }
  for (const f of props.result?.findings || []) c[f.severity]++
  return c
})
const done = computed(() => !!props.result && props.result.ok)
</script>

<template>
  <div class="card tool-card" :class="{ bad: supported && result && !result.ok }">
    <div class="head">
      <span class="name">{{ tool.name }}</span>
      <span v-if="!supported" class="pill na">当前宿主不支持</span>
      <span v-else-if="running" class="pill run">检查中…</span>
      <span v-else-if="result && !result.ok" class="pill fail">失败</span>
      <span v-else-if="!result" class="pill idle">未运行</span>
      <template v-if="done">
        <span v-if="parts.error" class="tag danger">错误 {{ parts.error }}</span>
        <span v-if="parts.warn" class="tag warn">警告 {{ parts.warn }}</span>
        <span v-if="parts.info" class="tag">提示 {{ parts.info }}</span>
        <span v-if="!parts.error && !parts.warn && !parts.info" class="tag ok">未发现问题</span>
      </template>
    </div>

    <p class="sum">{{ tool.summary }}</p>

    <div class="foot">
      <span v-if="result && result.ok" class="meta">{{ result.scannedFiles }} 文件 · {{ fmtMs(result.ms) }}</span>
      <!-- 不支持的工具不重复播报「当前宿主不支持」:头顶的状态胶囊已经说过了 -->
      <span v-else-if="result && supported" class="meta err" :title="result.error">{{ result.error }}</span>
      <div class="acts">
        <button
          class="btn small ghost"
          :class="{ on: open }"
          :disabled="!(result && result.findings.length)"
          title="展开这个工具的全部结论"
          @click="emit('open', tool.id)"
        >
          结果
        </button>
        <button
          class="btn small"
          :disabled="running || busy || !supported"
          @click="emit('run', tool.id)"
        >
          <span v-if="running" class="spin"></span>
          <Icon v-else name="refresh" :size="12" />
          {{ result ? '重新检查' : '检查' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 卡片外壳用全局 .card(surface/border/radius/shadow),这里只补布局 */
.tool-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 14px;
}

.tool-card.bad {
  border-color: var(--danger);
}

/* 窄卡片里让徽标换行而不是撑破卡片 */
.head {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.name {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text);
}

.sum {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--text-2);
}

.foot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: auto;
  min-width: 0;
}

.meta {
  font-size: 11.5px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.meta.err {
  color: var(--danger);
}

.acts {
  margin-left: auto;
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}

/* 展开态(与 .pill.run 同一套品牌色):面板在整排卡片之后,按钮自己的按下态
   是「已经展开了」在点击处唯一可见的证据 */
.acts .btn.on {
  border-color: var(--brand);
  background: var(--brand-weak);
  color: var(--brand);
}

.pill {
  font-size: 11px;
  font-weight: 600;
  line-height: 18px;
  padding: 0 8px;
  border-radius: 999px;
  white-space: nowrap;
}

.pill.na,
.pill.idle {
  color: var(--text-3);
  border: 1px solid var(--border);
}

.pill.run {
  color: var(--brand);
  background: var(--brand-weak);
}

.pill.fail {
  color: var(--danger);
  background: var(--danger-weak);
}

/* 检查中的转圈用全局 .spin(main.css 已定义,含 prefers-reduced-motion 处理) */
</style>
