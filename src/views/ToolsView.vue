<script setup lang="ts">
// 工具页(项目体检):选项目 → 一次扫描共享给所有检查器 → 卡片列表 + 通用结论面板。
// 页面不认识任何具体工具:卡片与结论全部由注册表驱动,加检查器不改这一页(spec §2.1)。
import { computed, onMounted, ref } from 'vue'
import EmptyState from '../components/EmptyState.vue'
import Icon from '../components/Icon.vue'
import ToolCard from '../components/tools/ToolCard.vue'
import FindingList from '../components/tools/FindingList.vue'
import SummaryBar from '../components/tools/SummaryBar.vue'
import { isSupported } from '../tools/registry'
import { useTools } from '../composables/useTools'

const emit = defineEmits<{ (e: 'navigate', tab: string): void }>()

const t = useTools()
/** 当前展开结论的工具 id(空串 = 全部收起) */
const open = ref('')

onMounted(() => {
  void t.load()
})

/** 已出结论的工具数 */
const ranCount = computed(() => Object.keys(t.results.value).length)
/** 有任何扫描/检查在途:冻结按钮,避免两个 run 互相把 running 状态写乱 */
const busy = computed(() => t.allRunning.value || t.running.value !== '')
/** 结论面板里的 rel 要拼成绝对路径才能「打开所在目录」;根路径来自项目记录 */
const rootPath = computed(() => t.projects.value.find((p) => p._id === t.projectId.value)?.path || '')
const openTool = computed(() => t.tools.value.find((x) => x.id === open.value) || null)
const openFindings = computed(() => (open.value ? t.findingsOf(open.value) : []))

/**
 * 「全部工具都跑成功、一条结论都没有」= 项目干净。
 * 这一行必须显式存在:调度器在切项目时返回空结果集(不报错),跑完一轮全绿之后如果页面
 * 什么都不说,用户分不清「体检跑完且没问题」和「刚切了项目、什么都还没跑」——
 * 两种状态下卡片、汇总条、横幅长得一模一样。失败的工具不算干净(ok:false 有自己的红卡片)。
 */
const allClean = computed(() => {
  const rs = Object.values(t.results.value)
  return !busy.value &&
    rs.length > 0 &&
    rs.length === t.tools.value.length &&
    rs.every((r) => r.ok) &&
    t.counts.value.error + t.counts.value.warn + t.counts.value.info === 0
})

/** 再点一次同一张卡片的「结果」= 收起 */
function toggleResult(id: string) {
  open.value = open.value === id ? '' : id
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
      :all-clean="allClean"
      @run-all="t.runAll()"
    />

    <!-- 扫描失败只上浮这一条口径(检查器不各出一行),所以错误横幅是唯一的失败出口 -->
    <p v-if="t.error.value" class="err-line">
      <Icon name="alert" :size="12" /> {{ t.error.value }}
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
        <FindingList :findings="openFindings" :root="rootPath" />
      </section>
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
