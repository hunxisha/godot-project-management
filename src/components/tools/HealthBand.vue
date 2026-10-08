<script setup lang="ts">
// 摘要带:这一页的第一段 —— 打开就该知道「有没有事」。
// 显隐与文案判据全在 outcomeOf(src/tools/outcome.ts:33-54)里,本组件只渲染它的返回值,
// 不新增第二条 verdict 判据(五态早就存在并被六条断言钉住)。
// 上次体检的结果来自快照(godot/tools-report/<尾id>),不是自动跑体检:
// 待确认 #1 没有大项目的扫描耗时实测,进页面就扫一次树是拿未验证的成本换便利。
import { computed, onMounted, onUnmounted, ref } from 'vue'
import Icon from '../Icon.vue'
import type { ToolsOutcome } from '../../tools/outcome'
import type { ReportSnapshot } from '../../composables/useTools'

const props = defineProps<{
  counts: { error: number; warn: number; info: number; fixable: number }
  /** 文件清单条目数:截断时它是**下限**,不是总数 */
  files: number
  truncated: boolean
  ran: number
  total: number
  running: boolean
  hasProject: boolean
  progress: string
  outcome: ToolsOutcome
  lastReport: ReportSnapshot | null
  /** 清单已落后于磁盘(刚修过文件):其余结论是旧世代的账,必须说出来(spec §6 R1) */
  stale: boolean
  /** 报告弹层在 Task 14 才接线;默认关,免得先摆一个点了没反应的按钮 */
  canOpenReport?: boolean
}>()
const emit = defineEmits<{
  (e: 'run-all'): void
  (e: 'report'): void
  (e: 'last-report'): void
}>()

const VERDICT: Record<ToolsOutcome['kind'], { text: string; cls: string }> = {
  failed: { text: '项目读不到', cls: 'bad' },
  running: { text: '体检中', cls: 'run' },
  idle: { text: '尚未体检', cls: 'idle' },
  allClean: { text: '未发现问题', cls: 'ok' },
  partial: { text: '需要处理', cls: 'hot' }
}
const verdict = computed(() => VERDICT[props.outcome.kind])

// 相对时间要真的「相对」:computed 只在依赖变化时重算,不 tick 的话页面开着不动
// 一小时,「3 分钟前」会一直挂着变成谎话。这一页每次进入都重新挂载(不在 KeepAlive 里,
// 见 §D #12),所以 onMounted/onUnmounted 就足够,定时器不会漏在页外空转。
const now = ref(Date.now())
let timer: number | null = null
onMounted(() => {
  timer = window.setInterval(() => (now.value = Date.now()), 60000)
})
onUnmounted(() => {
  if (timer !== null) clearInterval(timer)
  timer = null
})

/** 直说「多久之前」:摘要带要回答的是「旧不旧」,不是「几点」 */
const lastText = computed(() => {
  const at = props.lastReport?.generatedAt
  if (!at) return ''
  const min = Math.floor((now.value - at) / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} 小时前`
  return `${Math.floor(h / 24)} 天前`
})
const lastCounts = computed(() => props.lastReport?.counts || null)

/**
 * 陈旧句里的条数 = 已有结论的全部项数。
 * 理由是复位时机:任何一次 runTool 都会强制重扫并把 treeStale 归假，所以陈旧提示为真的
 * 那段时间里**一个工具都还没重跑**，不存在「除了刚重跑的那项」这种算法。
 * 也不看 total - ran：修完文件后 ran 并不减少（18 项仍各有结论），那样会说出「其余 0 项」。
 */
const staleText = computed(() =>
  props.ran > 0
    ? `文件清单已更新，这 ${props.ran} 项结论来自改动之前的扫描`
    : '文件清单已更新，跑一次体检让结论跟上新状态'
)
</script>

<template>
  <div class="card band">
    <div class="left">
      <span :class="['v', verdict.cls]"><span class="vdot"></span>{{ verdict.text }}</span>
      <span class="c err">错误 {{ counts.error }}</span>
      <span class="c wrn">警告 {{ counts.warn }}</span>
      <span class="c">提示 {{ counts.info }}</span>
      <span v-if="counts.fixable" class="c fx">可修复 {{ counts.fixable }}</span>
      <span v-if="files" class="c meta">{{ truncated ? `清单已截断 · 至少 ${files} 项` : `${files} 文件` }}</span>
      <span v-if="ran" class="c meta">{{ ran }}/{{ total }} 项已检查</span>
    </div>

    <div class="right">
      <!-- 陈旧提示只在这里说(全页唯一出口):它一出现就说明下面那条流混着两代结论 -->
      <span v-if="stale" class="stale">
        <Icon name="alert" :size="12" /> {{ staleText }}
      </span>
      <span v-else-if="progress" class="prog">{{ progress }}</span>
      <template v-else-if="lastReport">
        <span class="c meta">上次体检 {{ lastText }}</span>
        <!-- 缺 counts 的老快照只能说总数:把「不知道」显示成「没有」是另一种骗 -->
        <span v-if="lastCounts" class="c meta">
          错误 {{ lastCounts.error }} · 警告 {{ lastCounts.warn }} · 提示 {{ lastCounts.info }}
        </span>
        <span v-else class="c meta">共 {{ lastReport.findings }} 条</span>
        <button v-if="canOpenReport" class="btn small ghost" @click="emit('last-report')">看上次报告</button>
      </template>
      <button
        class="btn small"
        :disabled="running || !hasProject"
        title="复制 Markdown 报告到剪贴板"
        @click="emit('report')"
      >
        复制报告
      </button>
      <button class="btn small primary" :disabled="running || !hasProject" @click="emit('run-all')">
        <span v-if="running" class="spin"></span>
        {{ running ? '体检中…' : stale || ran < total ? '重新全量体检' : '一键全量体检' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.band {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
  padding: 9px 13px;
  font-size: 12.5px;
}

.left,
.right {
  display: flex;
  align-items: center;
  gap: 11px;
  flex-wrap: wrap;
  min-width: 0;
}

.right {
  margin-left: auto;
}

.c {
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.c.err {
  color: var(--danger);
}

.c.wrn {
  color: var(--warn);
}

.c.fx {
  color: var(--brand);
}

.c.meta {
  font-size: 11.5px;
  color: var(--text-3);
}

.v {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 700;
  color: var(--text);
}

.vdot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--border-strong);
}

.v.ok .vdot {
  background: var(--ok);
}

.v.ok {
  color: var(--ok);
}

.v.hot .vdot {
  background: var(--danger);
}

.v.hot {
  color: var(--danger);
}

.v.bad .vdot {
  background: var(--danger);
}

.v.bad {
  color: var(--danger);
}

.v.run .vdot {
  background: var(--brand);
}

.v.run {
  color: var(--brand);
}

.v.idle {
  color: var(--text-2);
}

.stale {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11.5px;
  color: var(--warn);
}

.prog {
  font-size: 11.5px;
  color: var(--brand);
}
</style>
