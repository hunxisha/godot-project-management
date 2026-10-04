<script setup lang="ts">
// 修复确认框:先看清「要动哪些文件」再执行(spec §5.3 规则 3 的 dry-run,规则 1/2/4 的文案)。
//
// 这个组件里**没有任何判据**:动词/风险句/受影响清单/能不能执行,全部来自 planFix
// (src/tools/fixPlan.ts);「哪些条要逐条确认、选完算什么」全部来自 gate.ts(src/tools/gate.ts);
// 成败/失败原因/备份去向,全部来自 useTools.applyFix 的回执。
// 与 outcomeOf 同一先例 —— 判据写进组件就跑不进 Node harness,而这里的判据是「用户对
// 自己项目文件的处置依据」,说错话的代价是删掉东西,必须可测。
// 因此本文件也没有单测:仓库没有组件渲染测试框架,这里的职责就是把「已测过的判据」摆出来
// —— 勾选交互只能靠人在真宿主里点一遍,判据部分(gate.ts / applyFix)全部另有断言。
import { computed, ref, watch } from 'vue'
import Icon from '../Icon.vue'
import { fmtBytes } from '../../tools/treeUtils'
import type { FixPlan } from '../../tools/fixPlan'
import { REJECT_NOTE } from '../../tools/fixPlan'
import { allRels, gateKind, selectionBytes, selectionCount } from '../../tools/gate'
import type { FixOutcome } from '../../composables/useTools'

const props = defineProps<{
  open: boolean
  /** planFix 的返回值:本组件唯一的判据来源 */
  plan: FixPlan
  /** 要修的那条结论的标题:确认框得说清在修哪一条,而不是空泛的「修复」 */
  title: string
  /** 修复在途:禁止第二次点击,也禁止关闭 */
  busy: boolean
  /** 执行完的回执(null = 还没执行) */
  outcome: FixOutcome | null
}>()
// confirm 的载荷是**用户勾选的那一份 rel 集合**:父组件必须原样交给 applyFix,
// 不能在这里省略、也不能在 ToolsView 里补默认值(那样「忘了传」就等于「整单执行」)。
const emit = defineEmits<{ (e: 'close'): void; (e: 'confirm', selected: string[]): void }>()

// 显式确认:whole 形态仍是「勾了确认框才让点」(原有取舍,与 PruneDialog 一致)。
const checked = ref(false)
// 逐条勾选状态(B10a,spec §5.3 规则 3):**默认全不选** —— 高危动作(trash 批量、rewrite 改写)
// 必须由用户逐条勾或显式全选。存的是 rel 数组,顺序无关紧要(subsetPlan 按父计划顺序重排)。
const selected = ref<string[]>([])
// 换一条结论 / 重新打开 / 刚执行完,勾选与确认框都要归零:上一次勾的是上一份清单
watch(
  () => [props.open, props.title, props.outcome] as const,
  ([open]) => {
    if (open) {
      checked.value = false
      selected.value = []
    }
  }
)

/**
 * 形态判据只问 gate.ts —— 组件不许自己写「哪些条要逐条确认」。
 * 今天能走到这一步的计划(executable)全是 per-item;whole 分支为「执行不了」与
 * 将来非动盘的 service 保留,行为与 B1 起完全一致。
 */
const perItem = computed(() => gateKind(props.plan) === 'per-item')
const selectedSet = computed(() => new Set(selected.value))
/**
 * 条数与体积都问 gate.ts:勾过的 rel 可能因为重扫从 items 里消失,
 * 用 selected.length 会让按钮亮着而子集是空的(点了没反应 = spec §5.3 规则 3 的反面)。
 */
const selectedCount = computed(() => selectionCount(props.plan, selected.value))
const allSelected = computed(() => selectedCount.value > 0 && selectedCount.value === props.plan.items.length)
/** 已选体积合计按**完整 items** 算(不是裁过的 shownItems),与上面的条数口径同一套 */
const selectedBytes = computed(() => selectionBytes(props.plan, selected.value))
function toggle(rel: string, on: boolean) {
  const next = new Set(selected.value)
  if (on) next.add(rel)
  else next.delete(rel)
  selected.value = [...next]
}
/** 全选走 allRels(plan) 而不是 shownItems:裁切只裁画出来的行,不裁要动盘的账 */
function selectAll() {
  selected.value = allRels(props.plan)
}
function clearAll() {
  selected.value = []
}

/**
 * 没有体积的行分两种,摘要行得说清是哪种:被闸拒绝的那些(原语不会碰盘)与只是清单里查不到
 * 体积的那些(原语会自己去问磁盘)。判据仍来自 planFix 的 note,这里只做不相交的计数。
 */
const rejectedCount = computed(() => props.plan.items.filter((i) => i.note === REJECT_NOTE).length)
const unknownCount = computed(() => props.plan.items.filter((i) => typeof i.size !== 'number' && i.note !== REJECT_NOTE).length)
/**
 * 渲染上限,与 PruneDialog.vue:87/191 同一口径(B5 孤儿资产一次点几千上万个文件时,
 * 逐条铺满 DOM 会让确认框本身变成卡顿源)。只裁**画出来的行**:上面的条数、合计体积与
 * 确认按钮的数字仍按完整 plan.items 算 —— 预览的账必须还是完整的账。
 * 裁掉的那些没有复选框可勾,但「全选」会把它们一起选中(下面那行要说清)。
 */
const RENDER_CAP = 200
const shownItems = computed(() => props.plan.items.slice(0, RENDER_CAP))
const omittedCount = computed(() => props.plan.items.length - shownItems.value.length)
/** 有没有可执行的东西:判据就是 planFix 给的两个字段,这里不再补一条自己的规则 */
const executable = computed(() => props.plan.service !== null && !props.plan.empty)
/**
 * 能不能执行:per-item 形态 = **至少选中一条**(勾选这个动作本身就是处置授权,
 * 不再叠加「我已核对」那条整单勾);whole 形态保持 B1 起的整单确认。
 */
const canRun = computed(() => {
  if (!executable.value || props.busy || props.outcome) return false
  return perItem.value ? selectedCount.value > 0 : checked.value
})
/** 按钮上的数字要说实话:per-item 时执行的是选中的那几条,不是整单 */
const runLabel = computed(() =>
  perItem.value ? `确认${props.plan.verb} ${selectedCount.value} 个文件` : `确认${props.plan.verb} ${props.plan.items.length} 个文件`
)
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="modal-mask" @click.self="!busy && emit('close')">
      <div class="card modal">
        <div class="modal-head">
          <div class="modal-title"><Icon name="wrench" :size="15" /> 修复确认</div>
          <span class="grow"></span>
          <button type="button" class="btn small ghost icon-x" title="关闭" :disabled="busy" @click="emit('close')">
            <Icon name="x" :size="14" />
          </button>
        </div>

        <p class="fx-title">{{ title }}</p>

        <!-- 执行不了就说清为什么,而不是摆一个点了没反应的按钮 -->
        <div v-if="!executable" class="fx-note">
          <Icon name="alert" :size="13" />
          <span>{{ plan.reason || '这条结论不支持一键修复' }}</span>
        </div>

        <template v-else>
          <!-- 动词 + 风险句:Windows「移入回收站 · 可还原」/ 其他平台「永久删除 · 不可还原」/
               改写「.gpm-bak- 自动备份」—— 三句话的差别全在 planFix 里判,这里只渲染 -->
          <div class="fx-warn">
            <Icon name="alert" :size="13" />
            <span><b>{{ plan.verb }}</b> —— {{ plan.warn }}</span>
          </div>

          <div class="fx-sum">
            <template v-if="perItem">本条结论涉及 <b>{{ plan.items.length }}</b> 个文件 · 整单约 <b>{{ fmtBytes(plan.bytes) }}</b></template>
            <template v-else>将影响 <b>{{ plan.items.length }}</b> 个文件 · 合计约 <b>{{ fmtBytes(plan.bytes) }}</b></template>
            <span v-if="unknownCount" class="fx-dim">(其中 {{ unknownCount }} 个不在本次文件清单里,体积未知)</span>
            <span v-if="rejectedCount" class="fx-dim">({{ rejectedCount }} 个路径非法,原语会拒绝)</span>
          </div>

          <!-- 逐条勾选的工具条:高危动作默认全不选(spec §5.3 规则 3) -->
          <div v-if="perItem" class="fx-bar">
            <span class="fx-dim">默认不选 · 已选 <b>{{ selectedCount }}</b> / {{ plan.items.length }} · 约 {{ fmtBytes(selectedBytes) }}</span>
            <span class="grow"></span>
            <button type="button" class="btn small ghost" :disabled="busy || !!outcome || allSelected" @click="selectAll">
              全选
            </button>
            <button type="button" class="btn small ghost" :disabled="busy || !!outcome || selectedCount === 0" @click="clearAll">
              清空
            </button>
          </div>

          <!-- 清单逐条列出(spec §5.3 规则 3「必须列出将影响的完整文件清单」),超过上限只裁行数
               并点名还剩多少 —— 条数与合计体积用的是完整 items,不是裁过的 shownItems。
               key 带序号:同一个 rel 被点名两次也各占一行,不能让 Vue 撞 key 复用 DOM。 -->
          <div class="fx-list">
            <div v-for="(it, i) in shownItems" :key="`${it.rel}#${i}`" class="fx-item">
              <input
                v-if="perItem"
                class="chk fx-box"
                type="checkbox"
                :checked="selectedSet.has(it.rel)"
                :disabled="busy || !!outcome"
                :aria-label="`选中 ${it.rel}`"
                @change="toggle(it.rel, ($event.target as HTMLInputElement).checked)"
              />
              <span class="mono fx-rel" :title="it.rel">{{ it.rel }}</span>
              <span class="fx-size mono">{{ typeof it.size === 'number' ? fmtBytes(it.size) : '—' }}</span>
              <span v-if="it.note" class="fx-dim fx-note-line">{{ it.note }}</span>
            </div>
            <div v-if="omittedCount > 0" class="fx-item fx-dim">
              另有 {{ omittedCount }} 个文件未列出(上面的条数与合计仍按完整清单计<template v-if="perItem">;点「全选」会把它们一起选中</template>)
            </div>
          </div>

          <!-- whole 形态(执行不了的分支走不到这里,留的是非动盘的整单确认)才是这条整单勾;
               per-item 形态的处置授权就是上面的逐条勾选本身。 -->
          <label v-if="!perItem" class="open-row fx-check">
            <input v-model="checked" type="checkbox" class="chk" :disabled="busy || !!outcome" />
            <span>我已核对上面这份清单,确认要{{ plan.verb }}</span>
          </label>
        </template>

        <!-- 执行回执(spec §5.3 规则 4:明示动了什么、备份去了哪、哪几项没成) -->
        <div v-if="outcome" :class="['fx-res', outcome.ok ? 'ok' : 'bad']">
          <Icon :name="outcome.ok ? 'check' : 'alert'" :size="13" />
          <div class="fx-res-body">
            <div class="fx-res-line">{{ outcome.message }}</div>
            <div v-for="(x, i) in outcome.failed" :key="`${x.rel}#f${i}`" class="fx-res-fail mono">
              {{ x.rel }}:{{ x.error }}
            </div>
          </div>
        </div>

        <div class="modal-foot">
          <span class="grow"></span>
          <button type="button" class="btn ghost" :disabled="busy" @click="emit('close')">
            {{ outcome ? '关闭' : '取消' }}
          </button>
          <button
            v-if="executable && !outcome"
            type="button"
            :class="['btn', plan.kind === 'rewrite' ? 'primary' : 'fix-go']"
            :disabled="!canRun"
            :title="perItem ? (selectedCount > 0 ? '' : '先勾选至少一条') : (checked ? '' : '先勾选上面的确认项')"
            @click="emit('confirm', perItem ? selected.slice() : allRels(plan))"
          >
            <span v-if="busy" class="spin"></span>
            {{ busy ? '执行中…' : runLabel }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* 外壳/遮罩/标题行/底部按钮行全部用全局 .modal-mask / .card.modal / .modal-head / .modal-foot,
   色板只用现成 token —— 五套配色集中管理,组件不许新增变量 */
.fx-title {
  margin: 0 0 10px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  overflow-wrap: anywhere;
}

.fx-warn {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  padding: 9px 12px;
  border: 1px solid var(--danger);
  border-radius: var(--radius-sm);
  background: var(--danger-weak);
  color: var(--danger);
  font-size: 12.5px;
  line-height: 1.6;
}

.fx-note {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  padding: 9px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: 12.5px;
  line-height: 1.6;
}

.fx-sum {
  margin-top: 10px;
  font-size: 12.5px;
  color: var(--text-2);
}

.fx-dim {
  color: var(--text-3);
  font-size: 11.5px;
}

/* 逐条勾选的工具条:只用来摆「已选几条」与两个批量按钮,不引入新色板 */
.fx-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap; /* 窄窗口里「已选 N / M · 约 X」要能换行,不许把两个按钮挤出模态 */
  gap: 6px;
  margin-top: 8px;
}

.fx-list {
  margin-top: 8px;
  max-height: 190px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  padding: 8px 10px;
}

.fx-item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 11.5px;
  color: var(--text-2);
}

.fx-item + .fx-item {
  margin-top: 4px;
}

/* 逐条复选框:.fx-item 是 baseline 对齐的,勾要落在行的垂直中心才对得齐路径文字 */
.fx-box {
  flex-shrink: 0;
  align-self: center;
}

/* 长路径必须能折行:否则窄窗口里确认框横向滚动 */
.fx-rel {
  flex: 1;
  min-width: 0;
  color: var(--text);
  overflow-wrap: anywhere;
}

.fx-size {
  flex-shrink: 0;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}

.fx-note-line {
  flex-basis: 100%;
}

.fx-check {
  margin-top: 10px;
  align-items: flex-start;
  line-height: 1.6;
  font-size: 12.5px;
}

.fx-check .chk {
  margin-top: 2px;
}

.fx-res {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  margin-top: 12px;
  padding: 9px 12px;
  border-radius: var(--radius-sm);
  font-size: 12.5px;
  line-height: 1.6;
}

.fx-res.ok {
  border: 1px solid var(--ok);
  background: var(--ok-weak);
  color: var(--ok);
}

.fx-res.bad {
  border: 1px solid var(--danger);
  background: var(--danger-weak);
  color: var(--danger);
}

.fx-res-body {
  min-width: 0;
}

.fx-res-line {
  overflow-wrap: anywhere;
}

.fx-res-fail {
  margin-top: 3px;
  font-size: 11.5px;
  color: var(--text-2);
  overflow-wrap: anywhere;
}

/* 会动用户文件的确认键:沿用 PruneDialog 的做法,用现成 --danger 上色,不引入新色板 */
.btn.fix-go {
  background: var(--danger);
  border-color: transparent;
  color: #fff;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.15), var(--shadow-sm);
}

.btn.fix-go:hover:not(:disabled) {
  filter: brightness(1.07);
  background: var(--danger);
  border-color: transparent;
  color: #fff;
}
</style>
