<script setup lang="ts">
// 工具页(项目体检):选项目 → 一次扫描共享给所有检查器 → 卡片列表 + 通用结论面板。
// 页面不认识任何具体工具:卡片与结论全部由注册表驱动,加检查器不改这一页(spec §2.1)。
// 修复动作也只有「装配」这一层在这里:判据在 planFix、执行在 useTools.applyFix,
// 视图负责把两者接起来并在修完之后重跑那一个检查器(spec §5.3)。
import { computed, onMounted, ref } from 'vue'
import EmptyState from '../components/EmptyState.vue'
import Icon from '../components/Icon.vue'
import ToolCard from '../components/tools/ToolCard.vue'
import FindingList from '../components/tools/FindingList.vue'
import FixConfirmDialog from '../components/tools/FixConfirmDialog.vue'
import SummaryBar from '../components/tools/SummaryBar.vue'
import { isSupported } from '../tools/registry'
import { outcomeOf } from '../tools/outcome'
import { planFix, type FixPlan } from '../tools/fixPlan'
import { isWindows } from '../services/bridge'
import { useTools } from '../composables/useTools'
import type { Finding } from '../tools/types'
import type { FixOutcome } from '../composables/useTools'

const emit = defineEmits<{ (e: 'navigate', tab: string): void }>()

const t = useTools()
/** 当前展开结论的工具 id(空串 = 全部收起) */
const open = ref('')
/** 当前要点开确认框的那条结论(null = 框关着) */
const fixFinding = ref<Finding | null>(null)
const fixBusy = ref(false)
const fixOutcome = ref<FixOutcome | null>(null)

onMounted(() => {
  void t.load()
})

/** 已出结论的工具数 */
const ranCount = computed(() => Object.keys(t.results.value).length)
/** 有任何扫描/检查在途:冻结按钮,避免两个 run 互相把 running 状态写乱 */
const busy = computed(() => t.allRunning.value || t.running.value !== '')
/** 修复在途,或修复刚把清单作废、正要重扫:这段时间冻结论面板上的所有动作 */
const anyBusy = computed(() => busy.value || t.fixing.value !== '')
/** 结论面板里的 rel 要拼成绝对路径才能「打开所在目录」;根路径来自项目记录 */
const rootPath = computed(() => t.projects.value.find((p) => p._id === t.projectId.value)?.path || '')
const openTool = computed(() => t.tools.value.find((x) => x.id === open.value) || null)
const openFindings = computed(() => (open.value ? t.findingsOf(open.value) : []))

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

/** 面板里每条结论的修复预告(视图只调纯函数,不自己判能不能修) */
const plansById = computed<Record<string, FixPlan>>(() => {
  const out: Record<string, FixPlan> = {}
  for (const f of openFindings.value) out[f.id] = planFix(f, t.tree.value, winHost.value)
  return out
})

/** 确认框要渲染的那份预告;没选中结论时用一条「没有 fix 字段」的结论走同一条判据,不另立文案 */
const fixPlan = computed<FixPlan>(() =>
  planFix(fixFinding.value || { id: '', severity: 'info', title: '' }, t.tree.value, winHost.value)
)

/**
 * 体检结论横幅的唯一判据(审查 F-1):「体检完成 · 未发现问题」与「项目目录无法读取」
 * 该怎么说、说不说,全部由 outcomeOf 决定,这一页只渲染它的返回值 —— 判据曾写在本文件里,
 * Node harness 跑不到 .vue,「扫描失败 + 陈旧全绿结论」并排显示的矛盾只能靠肉眼发现。
 * (纯函数与它的四路断言见 src/tools/outcome.ts 与 tools.test.mjs 第 6 节。)
 */
const outcome = computed(() =>
  outcomeOf(t.results.value, t.tools.value.length, t.counts.value, t.error.value, busy.value)
)

/** 再点一次同一张卡片的「结果」= 收起 */
function toggleResult(id: string) {
  open.value = open.value === id ? '' : id
}

/** 点结论上的修复按钮:每次都开一张干净的框(上一次的回执不许跟到下一条结论) */
function openFix(f: Finding) {
  fixFinding.value = f
  fixOutcome.value = null
}

/**
 * 确认框点「确认」之后的执行:applyFix 负责闸与调原语,这里只负责
 * ① 把在途状态告诉框;② 真改了磁盘就重跑**这一个**检查器 —— 结论得跟上刚动过的文件。
 * applyFix 自己不抛异常(失败一律回结构化回执),所以只有「重跑检查器」那一步需要单独兜:
 * 那一步炸了不能把已经如实落盘的修复动作说成失败。
 */
async function runFix() {
  if (!fixFinding.value) return
  fixBusy.value = true
  try {
    const o = await t.applyFix(fixFinding.value, { isWin: winHost.value })
    fixOutcome.value = o
    // applyFix 成功时已经 invalidateTree,这一次 runTool 拿到的必然是重扫后的清单
    if (o.changed && open.value) {
      try {
        await t.runTool(open.value)
      } catch {
        /* 重跑失败只影响结论新旧,不改变修复回执本身 */
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

    <SummaryBar
      :counts="t.counts.value"
      :files="t.tree.value.length"
      :truncated="t.truncated.value"
      :ran="ranCount"
      :running="busy"
      :has-project="!!t.projectId.value"
      :progress="t.progress.value"
      :all-clean="outcome.showAllClean"
      @run-all="t.runAll()"
    />

    <!-- 扫描失败只上浮这一条口径(检查器不各出一行),所以错误横幅是唯一的失败出口;
         文案与显隐同样来自 outcome(审查 F-1:横幅与「未发现问题」不许同时出现) -->
    <p v-if="outcome.error" class="err-line">
      <Icon name="alert" :size="12" /> {{ outcome.error }}
    </p>

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
      <div class="grid">
        <ToolCard
          v-for="tool in t.tools.value"
          :key="tool.id"
          :tool="tool"
          :result="t.results.value[tool.id] || null"
          :running="t.running.value === tool.id"
          :busy="busy && t.running.value !== tool.id"
          :supported="isSupported(tool, t.caps)"
          @run="(id) => t.runTool(id)"
          @open="toggleResult"
        />
      </div>

      <section v-if="openTool && openFindings.length" class="detail card">
        <h3>{{ openTool.name }} · {{ openFindings.length }} 条结论</h3>
        <FindingList
          :findings="openFindings"
          :root="rootPath"
          :plans="plansById"
          :fix-state="t.fixResults.value"
          :busy="anyBusy"
          @fix="openFix"
        />
      </section>

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

.grid {
  display: grid;
  /* min(280px, 100%) :窄于 280px 时轨道跟着容器收缩,不产生横向滚动 */
  grid-template-columns: repeat(auto-fill, minmax(min(280px, 100%), 1fr));
  gap: 10px;
}

.detail {
  padding: 12px 14px;
}

.detail h3 {
  margin: 0 0 10px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}

@media (max-width: 720px) {
  .grid {
    grid-template-columns: 1fr;
  }

  .pick {
    margin-left: auto;
  }
}
</style>
