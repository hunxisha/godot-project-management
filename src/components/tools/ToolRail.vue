<script setup lang="ts">
// 左栏:按类别分组的工具导航。
// 分组顺序来自 CATEGORIES(阅读顺序),与 TOOLS 数组顺序(执行顺序)刻意无关 ——
// 这条分离是整个重设计的根,执行顺序的断言在 useTools.test.mjs:212-239。
import { computed } from 'vue'
import Icon from '../Icon.vue'
import ToolRow from './ToolRow.vue'
import { CATEGORIES, isSupported } from '../../tools/registry'
import type { Capability, Tool, ToolResult } from '../../tools/types'

const props = defineProps<{
  tools: Tool[]
  results: Record<string, ToolResult>
  /** 正在跑的那一项 id(单工具与 runAll 都走它) */
  running: string
  caps: Record<Capability, boolean>
  /** 'all' = 全部问题流(聚合视图);其余是 toolId */
  selection: string
  totalFindings: number
}>()
const emit = defineEmits<{ (e: 'select', id: string): void }>()

/**
 * 组头的计数在这里按成员工具相加,而不是复用 aggregate 的组计数:
 * aggregate 把「未跑的工具」整条跳过,而左栏要的是「这一组有几项跑过」,两者口径本就不同。
 * 每行的分档计数住在 ToolRow(它只看自己那一项),不会与组头数字互相推导。
 */
const groups = computed(() => {
  const out: {
    id: string
    label: string
    icon: string
    tools: Tool[]
    error: number
    warn: number
    ran: number
  }[] = []
  for (const c of CATEGORIES) {
    const list = props.tools.filter((t) => t.category === c.id)
    if (!list.length) continue
    let error = 0
    let warn = 0
    let ran = 0
    for (const t of list) {
      const r = props.results[t.id]
      if (!r) continue
      ran++
      for (const f of r.findings) {
        if (f.severity === 'error') error++
        else if (f.severity === 'warn') warn++
      }
    }
    out.push({ id: c.id, label: c.label, icon: c.icon, tools: list, error, warn, ran })
  }
  return out
})
</script>

<template>
  <nav class="card rail" aria-label="体检项">
    <button :class="['all', { on: selection === 'all' }]" @click="emit('select', 'all')">
      <Icon name="list" :size="13" />
      <span>全部问题</span>
      <b v-if="totalFindings" class="mono">{{ totalFindings }}</b>
    </button>

    <section v-for="g in groups" :key="g.id" class="grp">
      <h5 :class="{ hot: g.error, warm: !g.error && g.warn }">
        <Icon :name="g.icon" :size="12" />
        <span class="gl">{{ g.label }}</span>
        <span v-if="g.error + g.warn" class="gc mono">{{ g.error }}/{{ g.warn }}</span>
        <span v-else-if="g.ran === g.tools.length" class="gd">✓</span>
      </h5>
      <ToolRow
        v-for="t in g.tools"
        :key="t.id"
        :tool="t"
        :result="results[t.id] || null"
        :supported="isSupported(t, caps)"
        :running="running === t.id"
        :selected="selection === t.id"
        @select="emit('select', $event)"
      />
    </section>
  </nav>
</template>

<style scoped>
.rail {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px;
  min-height: 0;
  overflow-y: auto;
}

.all {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 6px 8px;
  margin-bottom: 4px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  color: var(--text);
  font: inherit;
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s, color 0.15s;
}

.all:hover {
  border-color: var(--brand);
  color: var(--brand);
}

.all.on {
  border-color: var(--brand);
  background: var(--brand-weak);
  color: var(--brand);
}

.all b {
  margin-left: auto;
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  color: var(--text-3);
}

.grp + .grp {
  margin-top: 6px;
}

h5 {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 6px 0 2px;
  padding: 0 6px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.02em;
  color: var(--text-3);
}

h5.hot {
  color: var(--danger);
}

h5.warm {
  color: var(--warn);
}

h5 .icon {
  color: currentColor;
}

.gl {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gc {
  margin-left: auto;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  opacity: 0.9;
}

.gd {
  margin-left: auto;
  font-size: 11px;
  color: var(--ok);
}
</style>
