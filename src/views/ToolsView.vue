<script setup lang="ts">
// 工具页(项目体检):选项目 → 一次扫描共享给所有检查器 → 摘要带 + 左栏导航 + 右栏结论流。
// 页面不认识任何具体工具:分组、排序、能不能修全部由注册表与纯函数算好,视图只做装配(spec §2.1)。
//
// 这副骨架替掉的两件事:
//  · 结论面板曾排在整排卡片之后,展开要靠 scrollIntoView 硬拽(旧 :86-95 的补丁,commit 631c15b)
//    —— 现在两栏各自内滚、摘要带常驻,补丁连根拔掉;
//  · 卡片顺序曾等于注册表顺序,而那是 runAll 的**执行**顺序(旧 registry.ts:26-32 的注释自陈)
//    —— 现在阅读顺序走 CATEGORIES,执行顺序仍由数组承载,两者正交。
//
// 修复动作仍然只有「装配」这一层在这里:判据在 planFix、执行在 useTools.applyFix,
// 视图把两者接起来,并在真改了盘之后重跑**那一条结论所属的检查器**(spec §5.3)。
import { computed, onMounted, ref, watch } from 'vue'
import EmptyState from '../components/EmptyState.vue'
import Icon from '../components/Icon.vue'
import HealthBand from '../components/tools/HealthBand.vue'
import ToolRail from '../components/tools/ToolRail.vue'
import FindingsRail from '../components/tools/FindingsRail.vue'
import FixConfirmDialog from '../components/tools/FixConfirmDialog.vue'
import { isSupported } from '../tools/registry'
import { aggregate, filterToTool, type AggFinding, type FilterSel } from '../tools/aggregate'
import { outcomeOf } from '../tools/outcome'
import { planFix, type FixPlan } from '../tools/fixPlan'
import { isWindows } from '../services/bridge'
import { useTools } from '../composables/useTools'
import type { Finding } from '../tools/types'
import type { FixOutcome } from '../composables/useTools'

const emit = defineEmits<{ (e: 'navigate', tab: string): void }>()

const t = useTools()
/** 右栏在看什么:'all' = 聚合问题流,其余是 toolId。取代旧版那个只能单值收起的 open */
const selection = ref('all')
const sel = ref<FilterSel>({ sev: 'all', fixableOnly: false, query: '' })
/** 当前要点开确认框的那条结论(null = 框关着) */
const fixFinding = ref<Finding | null>(null)
const fixBusy = ref(false)
const fixOutcome = ref<FixOutcome | null>(null)

// 装载项目列表与上次体检快照。这一页今天不在 KeepAlive 里(App.vue 的 include 实测对它
// 不生效,根因记 docs/tools-ui-redesign-plan.md §D #12),每次进入都是重新挂载,
// 所以 onMounted 一次就够 —— 不保留永远不会触发的 activated(那是死代码)。
onMounted(() => {
  void t.load()
  void t.loadLastReport()
})

/** 换项目:结论、清单、快照都是按项目成立的,右栏回到聚合流,筛选保留(那是用户的偏好) */
watch(
  () => t.projectId.value,
  () => {
    selection.value = 'all'
    void t.loadLastReport()
  }
)

/** 有任何扫描/检查在途:冻结按钮,避免两个 run 互相把 running 状态写乱 */
const busy = computed(() => t.allRunning.value || t.running.value !== '')
/** 修复在途,或修复刚把清单作废:这段时间冻结论面板上的所有动作 */
const anyBusy = computed(() => busy.value || t.fixing.value !== '')
const ranCount = computed(() => Object.keys(t.results.value).length)
/** 结论面板里的 rel 要拼成绝对路径才能「打开所在目录」;根路径来自项目记录 */
const rootPath = computed(() => t.projects.value.find((p) => p._id === t.projectId.value)?.path || '')

/**
 * 只有 Windows 有回收站:同一个 fix.kind 在两个平台是两件不同的事(fsutil.trashPath
 * 在非 Windows 走 fs.rmSync/unlinkSync,真删)。这里只**喂参数给判据**,判据本身在 planFix。
 * 取不到平台时 bridge 会抛,退回 false —— 说不准就按更保守的那句说。
 */
const winHost = computed(() => {
  try {
    return isWindows() === true
  } catch {
    return false
  }
})

const groups = computed(() => aggregate(t.tools.value, t.results.value, winHost.value))
const totalFindings = computed(() => groups.value.reduce((n, g) => n + g.items.length, 0))
/** 右栏这一屏:聚合模式给全部组,单工具模式用纯函数裁(计数与筛选同一条重算路径) */
const railGroups = computed(() =>
  selection.value === 'all' ? groups.value : filterToTool(groups.value, selection.value)
)
const shownItems = computed<AggFinding[]>(() => {
  const out: AggFinding[] = []
  for (const g of railGroups.value) for (const it of g.items) out.push(it)
  return out
})

/** 面板里每条结论的修复预告(视图只调纯函数,不自己判能不能修) */
const plansById = computed<Record<string, FixPlan>>(() => {
  const out: Record<string, FixPlan> = {}
  for (const it of shownItems.value) out[it.finding.id] = planFix(it.finding, t.tree.value, winHost.value)
  return out
})

/** 确认框要渲染的那份预告;没选中结论时用一条「没有 fix 字段」的结论走同一条判据,不另立文案 */
const fixPlan = computed<FixPlan>(() =>
  planFix(fixFinding.value || { id: '', severity: 'info', title: '' }, t.tree.value, winHost.value)
)

/**
 * 体检结论横幅的唯一判据(审查 F-1):「体检完成 · 未发现问题」与「项目目录无法读取」
 * 该怎么说、说不说,全部由 outcomeOf 决定,这一页只渲染它的返回值。
 * (纯函数与它的六条断言见 src/tools/outcome.ts 与 tools.test.mjs 第 6 节。)
 */
const outcome = computed(() =>
  outcomeOf(t.results.value, t.tools.value.length, t.counts.value, t.error.value, busy.value)
)

const currentTool = computed(() =>
  selection.value === 'all' ? null : t.tools.value.find((x) => x.id === selection.value) || null
)
const currentSupported = computed(() =>
  selection.value === 'all' ? true : !!currentTool.value && isSupported(currentTool.value, t.caps)
)

/** 右栏头部那一个主操作:聚合 = 全量体检,单工具 = 重跑本项 */
function runCurrent() {
  if (selection.value === 'all') void t.runAll()
  else if (currentSupported.value) void t.runTool(selection.value)
}

/** 点结论上的修复按钮:每次都开一张干净的框(上一次的回执不许跟到下一条结论) */
function openFix(item: AggFinding) {
  fixFinding.value = item.finding
  fixOutcome.value = null
}

/**
 * 确认框点「确认」之后的执行:applyFix 负责闸与调原语,这里只负责
 * ① 把在途状态告诉框;② 真改了磁盘就重跑**这一条结论所属的那一个检查器** —— 结论得跟上刚动过的文件。
 * 旧版重跑的是「视图记住的 open」,聚合流里没有这个概念可记,所以依据换成回执里的 toolId
 * (由 finding.id 的 `${toolId}:` 前缀反推,useTools.ts:470;断言 §42)。
 * 推不出 toolId(空串)时不重跑,只让摘要带的陈旧提示说话 —— 宁可不重跑,也不能凭猜跑一个别的工具。
 * applyFix 自己不抛异常(失败一律回结构化回执),所以只有「重跑检查器」那一步需要单独兜。
 *
 * ★断言级注释(B10a,spec §5.3 规则 3):`selected` 是**用户勾选的那一份**,必须原样交给 applyFix。
 * 这一页不许出现「整单执行」的入口 —— 高危动作(批量进回收站、批量改写源文件)默认逐条不选,
 * 忘了传就等于把用户没勾的文件也删了。三条规矩与它们的实际约束力(逐条实测过,不靠推测):
 *   · **不许给默认值**:`selected ?? []`、`|| allRels(plan)` 这类兜底都不许写 —— 后者是整单执行。
 *   · vue-tsc 咬得住「组件不再发载荷」:emit 签名去掉 selected 时,模板里 `@confirm="runFix"`
 *     那一行直接编译失败(TS2322,实测过,不是推测)。
 *   · vue-tsc **咬不住**「处理器把载荷丢掉」:函数参数逆变让 `runFix()` 依然类型相容
 *     (实测:把本函数改成无参、applyFix 退回整单调用 → vue-tsc rc=0,一片绿)。
 *     所以下面那行 Array.isArray 兜底是**故意朝「关死」的方向**写的:载荷不是数组(有调用点忘了传)
 *     就当空选择处理,由 gate.ts 裁成 empty 并带着「没有勾选任何文件」的原因被拒,绝不退化成整单执行。
 *   · 新增调用点(比如将来的一键清理)同样必须显式算出勾选集合 —— applyFix 省略第二参的整单行为
 *     是给测试与 B1 旧调用留的,不是给界面留的口子。
 */
async function runFix(selected: string[]) {
  if (!fixFinding.value) return
  // 载荷形状兜底 = 空选择(拒绝),而不是整单执行:见上面那条「咬不住丢载荷」的实测结论
  const sel2 = Array.isArray(selected) ? selected : []
  fixBusy.value = true
  try {
    const o = await t.applyFix(fixFinding.value, sel2, { isWin: winHost.value })
    fixOutcome.value = o
    if (o.changed && o.toolId) {
      try {
        await t.runTool(o.toolId)
      } catch {
        /* 重跑失败只影响结论新旧,不改变已经如实落盘的修复回执 */
      }
    }
  } finally {
    fixBusy.value = false
  }
}

function closeFix() {
  if (fixBusy.value) return
  fixFinding.value = null
  fixOutcome.value = null
}

/** 复制完顺手把快照读回来:摘要带立刻从「尚未体检」变成「上次体检 刚刚」,不用重进页面 */
async function onReport() {
  await t.copyReport()
  await t.loadLastReport()
}
</script>

<template>
  <div class="tools view">
    <div class="view-head">
      <h2>
        <Icon name="wrench" :size="16" /> 工具
        <span class="count-pill">{{ t.tools.value.length }}</span>
      </h2>
      <span class="grow"></span>
      <label v-if="t.projects.value.length" class="pick">
        项目
        <select
          class="select"
          :value="t.projectId.value"
          title="体检按项目成立:切换项目会清空结论并重扫"
          @change="t.select(($event.target as HTMLSelectElement).value)"
        >
          <option value="" disabled>请选择</option>
          <option v-for="p in t.projects.value" :key="p._id" :value="p._id">{{ p.name }}</option>
        </select>
      </label>
    </div>

    <EmptyState
      v-if="!t.projects.value.length"
      icon="wrench"
      title="还没有添加项目"
      desc="体检以项目为单位。先到「项目」页添加或新建一个 Godot 项目,再回来做体检。"
    >
      <button class="btn primary" @click="emit('navigate', 'projects')">
        <Icon name="folder" :size="14" /> 去项目页
      </button>
    </EmptyState>

    <template v-else>
      <HealthBand
        :counts="t.counts.value"
        :files="t.tree.value.length"
        :truncated="t.truncated.value"
        :ran="ranCount"
        :total="t.tools.value.length"
        :running="busy"
        :has-project="!!t.projectId.value"
        :progress="t.progress.value"
        :outcome="outcome"
        :last-report="t.lastReport.value"
        :stale="t.treeStale.value"
        @run-all="t.runAll()"
        @report="onReport()"
      />

      <!-- 扫描失败只上浮这一条口径(检查器不各出一行),所以错误横幅是唯一的失败出口;
           文案与显隐同样来自 outcome(审查 F-1:横幅与「未发现问题」不许同时出现) -->
      <p v-if="outcome.error" class="err-line">
        <Icon name="alert" :size="12" /> {{ outcome.error }}
      </p>

      <div class="split">
        <ToolRail
          class="rail-col"
          :tools="t.tools.value"
          :results="t.results.value"
          :running="t.running.value"
          :caps="t.caps"
          :selection="selection"
          :total-findings="totalFindings"
          @select="selection = $event"
        />
        <FindingsRail
          class="main-col"
          :groups="railGroups"
          :sel="sel"
          :root="rootPath"
          :plans="plansById"
          :receipts="t.fixResults.value"
          :busy="anyBusy"
          :tool-name="currentTool ? currentTool.name : ''"
          :running="busy"
          :supported="currentSupported"
          @update:sel="sel = $event"
          @run-current="runCurrent"
          @fix="openFix"
        />
      </div>

      <!-- 修复确认框:执行前先看清「要动哪些文件」,勾了确认才落地(spec §5.3 规则 3) -->
      <FixConfirmDialog
        :open="!!fixFinding"
        :plan="fixPlan"
        :title="fixFinding ? fixFinding.title : ''"
        :busy="fixBusy || t.fixing.value !== ''"
        :outcome="fixOutcome"
        @confirm="runFix"
        @close="closeFix"
      />
    </template>
  </div>
</template>

<style scoped>
/* 页面骨架用全局 .view / .view-head(padding、间距、进场动画都在 main.css) */
.tools .view-head {
  flex-wrap: wrap;
}

.split {
  display: grid;
  grid-template-columns: 232px minmax(0, 1fr);
  gap: 10px;
  align-items: start;
}

.rail-col {
  align-self: stretch;
}

.main-col {
  min-width: 0;
}

.pick {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  color: var(--text-2);
  min-width: 0;
}

.pick select {
  min-width: 160px;
  max-width: 240px;
  font-size: 12.5px;
}

.err-line {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  padding: 7px 12px;
  border: 1px solid var(--danger);
  border-radius: var(--radius-sm);
  background: var(--danger-weak);
  color: var(--danger);
  font-size: 12.5px;
}

@media (max-width: 900px) {
  .split {
    grid-template-columns: minmax(0, 1fr);
  }

  .pick {
    margin-left: auto;
  }
}
</style>
