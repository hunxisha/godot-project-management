<script setup lang="ts">
// 一条结论一行:严重度色条 + 标题 + 出处路径 + 工具名(聚合模式) + 动词按钮。
// 旧版每条结论一圈边框(已删的 FindingList.vue),几百条时全是框,读不出层次。
// 判据一律不在这儿:能不能修、动词叫什么、为什么不能修,全部住在 planFix;
// 成败与失败原因住在 applyFix 的回执里。本组件只渲染喂进来的字段。
import Icon from '../Icon.vue'
import { showInFolder } from '../../services/bridge'
import type { AggFinding } from '../../tools/aggregate'
import type { FixPlan } from '../../tools/fixPlan'
import type { FixOutcome } from '../../composables/useTools'

const props = defineProps<{
  item: AggFinding
  /** 项目根绝对路径:「打开所在目录」要拼它(rel 永远是正斜杠相对路径) */
  root: string
  /** 该结论的修复预告;null 表示装配层没给(按「只当建议显示」处理) */
  plan: FixPlan | null
  /** 该结论最近一次执行的回执(null = 没执行过) */
  receipt: FixOutcome | null
  busy: boolean
  /** 聚合模式:同一屏混着 18 个工具的结论,每条得说出处 */
  showSource: boolean
}>()
const emit = defineEmits<{ (e: 'fix', item: AggFinding): void }>()

const BAR: Record<string, string> = { error: 'err', warn: 'wrn', info: 'inf' }

/** rel → 绝对路径:root 由视图给(项目记录里的 path),组件不认项目对象 */
function reveal(rel?: string) {
  if (rel && props.root) showInFolder(`${props.root.replace(/[\\/]+$/, '')}/${rel}`)
}
</script>

<template>
  <article :class="['row', BAR[item.finding.severity]]">
    <div class="main">
      <div class="head">
        <span class="title">{{ item.finding.title }}</span>
        <span v-if="showSource" class="src">{{ item.toolName }}</span>
      </div>
      <div v-if="item.finding.rel" class="path">
        <code class="mono">{{ item.finding.rel }}</code>
        <button class="btn small ghost" title="在文件管理器中打开该文件所在目录" @click="reveal(item.finding.rel)">
          打开所在目录
        </button>
      </div>
      <p v-if="item.finding.detail" class="detail">{{ item.finding.detail }}</p>
      <p v-if="item.finding.related && item.finding.related.length" class="detail">
        相关：{{ item.finding.related.join('、') }}
      </p>
    </div>

    <div class="acts">
      <!-- 可执行 → 一个真正的动作(点开确认框);不能执行 → 把「为什么」说出来,不摆空按钮 -->
      <button
        v-if="plan && plan.service && !plan.empty"
        class="btn small"
        :disabled="busy"
        :title="`先看清要动哪些文件，再确认${plan.verb}`"
        @click="emit('fix', item)"
      >
        {{ plan.verb }}
      </button>
      <span v-else-if="item.finding.fix && plan" class="na">{{ plan.reason }}</span>
    </div>

    <!-- 执行回执:成败都显示,失败项逐条带原语的中文原因(spec §5.3 规则 4) -->
    <div v-if="receipt" :class="['res', receipt.ok ? 'ok' : 'bad']">
      <Icon :name="receipt.ok ? 'check' : 'alert'" :size="11" />
      <span class="res-msg">{{ receipt.message }}</span>
      <span v-for="(x, i) in receipt.failed" :key="`${item.finding.id}#fx${i}`" class="res-fail mono">
        {{ x.rel }}：{{ x.error }}
      </span>
    </div>
  </article>
</template>

<style scoped>
.row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  column-gap: 10px;
  row-gap: 4px;
  padding: 8px 10px 8px 9px;
  border-bottom: 1px solid var(--border);
  /* 3px inset 色条:语义色不随色板变(theme-system.md:34-36) */
  box-shadow: inset 3px 0 0 var(--border);
  transition: background 0.15s;
  min-width: 0;
}

.row:hover {
  background: var(--surface-2);
}

.row.err {
  box-shadow: inset 3px 0 0 var(--danger);
}

.row.wrn {
  box-shadow: inset 3px 0 0 var(--warn);
}

/* info 档用 --text-3:/--surface 实测 3.13,过图形件 3.0 门槛(theme-system.md:68) */
.row.inf {
  box-shadow: inset 3px 0 0 var(--text-3);
}

.row:last-child {
  border-bottom: none;
}

.main {
  grid-column: 1;
  grid-row: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
  min-width: 0;
}

.title {
  font-size: 13px;
  font-weight: 500;
  color: var(--text);
  overflow-wrap: anywhere;
}

.src {
  font-size: 11px;
  color: var(--text-3);
  white-space: nowrap;
}

.path {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

/* 长路径必须能折行:否则窄窗口里整页横向滚动 */
.path code {
  font-size: 11.5px;
  color: var(--text-3);
  overflow-wrap: anywhere;
}

.detail {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-2);
  overflow-wrap: anywhere;
}

.acts {
  grid-column: 2;
  grid-row: 1;
  align-self: start;
  display: flex;
  align-items: center;
  gap: 8px;
}

.na {
  font-size: 11.5px;
  color: var(--text-3);
  max-width: 200px;
  text-align: right;
}

.res {
  grid-column: 1 / -1;
  grid-row: 2;
  display: flex;
  align-items: flex-start;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 11.5px;
  line-height: 1.6;
}

.res.ok {
  color: var(--ok);
}

.res.bad {
  color: var(--danger);
}

.res-msg {
  overflow-wrap: anywhere;
}

.res-fail {
  flex-basis: 100%;
  color: var(--text-2);
  overflow-wrap: anywhere;
}
</style>
