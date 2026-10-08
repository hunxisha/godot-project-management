<script setup lang="ts">
// 右栏:三段里的第二段(跨工具聚合问题流)与第三段(单个工具的全部结论)共用这一块区域。
// 筛选条 + 一个 contextual 主操作 + 分组流。
// 分组、排序、筛选三件事的判据全在 aggregate.ts(有 Node 断言),本组件只调它给的 groups。
import { computed, ref } from 'vue'
import Icon from '../Icon.vue'
import FindingRow from './FindingRow.vue'
import { filterGroups } from '../../tools/aggregate'
import type { AggFinding, AggGroup, FilterSel } from '../../tools/aggregate'
import type { FixPlan } from '../../tools/fixPlan'
import type { FixOutcome } from '../../composables/useTools'

const props = defineProps<{
  /** 已经按当前模式算好的组:聚合模式是全部,单工具模式由装配层用 filterToTool 裁过 */
  groups: AggGroup[]
  sel: FilterSel
  root: string
  plans: Record<string, FixPlan>
  receipts: Record<string, FixOutcome>
  busy: boolean
  /** 单工具模式下的工具名;聚合模式传空串 */
  toolName: string
  running: boolean
  supported: boolean
}>()
const emit = defineEmits<{
  (e: 'update:sel', v: FilterSel): void
  (e: 'run-current'): void
  (e: 'fix', item: AggFinding): void
}>()

const view = computed(() => filterGroups(props.groups, props.sel))
const shown = computed(() => view.value.reduce((n, g) => n + g.items.length, 0))
const isTool = computed(() => props.toolName !== '')

/**
 * 组内渲染上限。旧版 FindingList.vue:53 直接 v-for 全量,单个工具出几百条就整页卡。
 * 只裁画出来的行:组头计数与「其余 N 条」都按完整 items 算,预览的账必须还是完整的账。
 */
const CAP = 50
const expanded = ref<Record<string, boolean>>({})
function visibleOf(g: AggGroup) {
  return expanded.value[g.category] ? g.items : g.items.slice(0, CAP)
}
function setSev(sev: FilterSel['sev']) {
  emit('update:sel', { ...props.sel, sev })
}
</script>

<template>
  <section class="card findings" aria-label="体检结论">
    <header class="top">
      <h3>
        <Icon :name="isTool ? 'wrench' : 'list'" :size="14" />
        {{ isTool ? toolName : '全部问题' }}
        <span class="cnt mono">{{ shown }}</span>
      </h3>
      <div class="seg" role="group" aria-label="按严重度筛选">
        <button :class="{ on: sel.sev === 'all' }" @click="setSev('all')">全部</button>
        <button :class="{ on: sel.sev === 'error' }" @click="setSev('error')">错误</button>
        <button :class="{ on: sel.sev === 'warn' }" @click="setSev('warn')">警告</button>
        <button :class="{ on: sel.sev === 'info' }" @click="setSev('info')">提示</button>
      </div>
      <button
        :class="['chip', { on: sel.fixableOnly }]"
        title="只看能一键处置的那几条"
        @click="emit('update:sel', { ...sel, fixableOnly: !sel.fixableOnly })"
      >
        只看待修复
      </button>
      <input
        class="input q"
        type="search"
        placeholder="标题或路径"
        aria-label="按标题或路径筛选结论"
        :value="sel.query"
        @input="emit('update:sel', { ...sel, query: ($event.target as HTMLInputElement).value })"
      />
      <!-- 动作收在这一处:聚合 = 全量体检,单工具 = 重跑本项(旧版是每张卡两个按钮) -->
      <button class="btn small" :disabled="running || !supported" @click="emit('run-current')">
        <span v-if="running" class="spin"></span>
        <Icon v-else name="refresh" :size="12" />
        {{ isTool ? '重跑本项' : '全量体检' }}
      </button>
    </header>

    <p v-if="!supported" class="tip">
      当前宿主缺这一项需要的能力,所以跑不了 —— 能力缺失是状态,不是异常,这里不调任何原语。
    </p>

    <div v-else-if="!view.length" class="empty">
      {{
        groups.length
          ? '没有符合当前筛选条件的结论。'
          : isTool
            ? running
              ? '正在检查…'
              : '这一项还没跑过,点上面的「重跑本项」开始。'
            : '还没有任何结论 —— 跑一次全量体检看看。'
      }}
    </div>

    <section v-for="g in view" :key="g.category" class="grp">
      <h4>
        <Icon :name="g.icon" :size="12" />
        {{ g.label }}
        <span class="gc mono">
          {{ g.items.length }} 条
          <template v-if="g.counts.error"> · 错误 {{ g.counts.error }}</template>
          <template v-if="g.counts.warn"> · 警告 {{ g.counts.warn }}</template>
          <template v-if="g.counts.info"> · 提示 {{ g.counts.info }}</template>
        </span>
      </h4>
      <!-- key 带组内序号:Finding.id 只由证据推导,同一文件里两行字节相同的声明会算出同一个 id,
           纯 :key 会让 Vue 报重复 key 并错误复用 DOM(旧版 FindingList.vue:49-52 的教训) -->
      <FindingRow
        v-for="(it, i) in visibleOf(g)"
        :key="`${it.finding.id}#${g.category}${i}`"
        :item="it"
        :root="root"
        :plan="plans[it.finding.id] || null"
        :receipt="receipts[it.finding.id] || null"
        :busy="busy"
        :show-source="!isTool"
        @fix="emit('fix', $event)"
      />
      <button v-if="g.items.length > visibleOf(g).length" class="btn small ghost more" @click="expanded[g.category] = true">
        展开本类其余 {{ g.items.length - visibleOf(g).length }} 条
      </button>
    </section>
  </section>
</template>

<style scoped>
.findings {
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  overflow-y: auto;
  padding: 0 0 6px;
}

/* 筛选条吸顶:滚动容器是 .findings 自己 —— 这正是换滚动模型的目的,
   面板不再需要被 scrollIntoView 拽进视口(旧版 ToolsView.vue:89-95 的补丁) */
.top {
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 9px;
  flex-wrap: wrap;
  padding: 10px 12px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
}

h3 {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 13.5px;
  font-weight: 700;
  color: var(--text);
}

h3 .icon {
  color: var(--brand);
}

h3 .cnt {
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  color: var(--text-3);
}

.q {
  flex: 1;
  min-width: 96px;
  max-width: 190px;
  padding: 4px 9px;
  font-size: 12px;
}

.top .btn {
  margin-left: auto;
}

.grp + .grp {
  border-top: 1px solid var(--border);
}

h4 {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  padding: 8px 12px 4px;
  font-size: 11.5px;
  font-weight: 700;
  color: var(--text-3);
}

h4 .icon {
  color: currentColor;
}

.gc {
  margin-left: auto;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.more {
  display: block;
  width: 100%;
  margin-top: 4px;
  font-size: 11.5px;
  color: var(--text-3);
}

.empty {
  padding: 26px 16px;
  font-size: 12.5px;
  color: var(--text-2);
  text-align: center;
}

.tip {
  margin: 0;
  padding: 8px 12px;
  font-size: 12px;
  color: var(--text-3);
}
</style>
