<script setup lang="ts">
// 汇总条:全站结论计数 + 文件清单状态 + 「一键全量体检」入口。
// P0a 裁决:体检**不进** App.vue 的全局任务栏,进度只在这里显示(running/progress 由视图喂进来)。
import { computed } from 'vue'

const props = defineProps<{
  /** useTools 的 counts(跨所有已跑工具);fixable 从 P0b-B1 起真有人数了(口径 = planFix 判为可执行的条数) */
  counts: { error: number; warn: number; info: number; fixable: number }
  /** 文件清单条目数:截断时它是**下限**,不是总数 */
  files: number
  truncated: boolean
  /** 已出结论的工具数 */
  ran: number
  /** 有扫描/检查在途(单工具或全量) */
  running: boolean
  /** 是否选了项目:没项目时一键体检必须禁用 —— 不能用 files 判,清单要跑过一次才有长度 */
  hasProject: boolean
  /** useTools 的进度文案(空串表示没有进度可显示) */
  progress: string
  /** 全部工具都跑成且零结论:由 outcomeOf(src/tools/outcome.ts)算好喂进来;组件不认识 useTools,判据也不在视图里 */
  allClean: boolean
}>()
const emit = defineEmits<{ (e: 'run-all'): void }>()

// 截断时把标记和数字写进同一句:分两处渲染就等于让「N 项」被读成总数
const filesText = computed(() =>
  props.truncated ? `文件清单已截断 · 至少 ${props.files} 项` : `${props.files} 文件`
)
</script>

<template>
  <div class="card sum-bar">
    <span class="c err">错误 {{ counts.error }}</span>
    <span class="c warn">警告 {{ counts.warn }}</span>
    <span class="c info">提示 {{ counts.info }}</span>
    <span v-if="counts.fixable" class="c fixable">可修复 {{ counts.fixable }}</span>
    <span v-if="files" class="c meta">{{ filesText }}</span>
    <span v-if="ran" class="c meta">{{ ran }} 项已检查</span>
    <!-- 全绿时的显式结果:没有结论 ≠ 什么都没跑(见 props.allClean)。用现成的 .c.meta,不新增色板 -->
    <span v-if="allClean" class="c meta">体检完成 · 未发现问题</span>
    <span v-if="progress" class="c prog">{{ progress }}</span>
    <button class="btn small primary" :disabled="running || !hasProject" @click="emit('run-all')">
      <span v-if="running" class="spin"></span>
      {{ running ? '体检中…' : '一键全量体检' }}
    </button>
  </div>
</template>

<style scoped>
/* 外壳用全局 .card;这里只排行内布局。刻意不叫 .bar —— 那与 main.css 的进度条全局类同名 */
.sum-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding: 8px 12px;
  font-size: 12.5px;
}

.c {
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.c.err {
  color: var(--danger);
}

.c.warn {
  color: var(--warn);
}

.c.fixable {
  color: var(--brand);
}

.c.meta {
  font-size: 11.5px;
  color: var(--text-3);
}

.c.prog {
  font-size: 11.5px;
  color: var(--brand);
}

.sum-bar .btn {
  margin-left: auto;
}
</style>
