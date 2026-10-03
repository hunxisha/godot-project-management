<script setup lang="ts">
// 通用结论列表:任何检查器产出的 Finding[] 都按「错误 / 警告 / 提示」三段渲染。
// 这里不认识具体工具,也不做折叠/忽略(P0a 没有 ignore-per-id,不要在这里加)。
//
// 修复动作同理:能不能修、动词叫什么、为什么不能修,全部由父组件用 planFix 算好后从
// `plans` 喂进来,执行结果从 `fixState` 喂进来 —— 本组件只做渲染与「把这条结论交出去」,
// 不加任何判据(spec §5.3 的判据只许住在 src/tools/fixPlan.ts 里)。
import { computed } from 'vue'
import { showInFolder } from '../../services/bridge'
import type { Finding, Severity } from '../../tools/types'
import type { FixPlan } from '../../tools/fixPlan'
import type { FixOutcome } from '../../composables/useTools'

const props = defineProps<{
  findings: Finding[]
  root: string
  /** 按 finding id 存好的修复预告(planFix 的产物);缺项就退回「只当建议显示」 */
  plans: Record<string, FixPlan>
  /** 按 finding id 存好的执行回执(useTools.applyFix 记账);缺项表示这条还没执行过 */
  fixState: Record<string, FixOutcome>
  /** 有修复在途或别的扫描在跑:按钮冻结,不让两个动盘的动作叠在一起 */
  busy: boolean
}>()
const emit = defineEmits<{ (e: 'fix', f: Finding): void }>()

const ORDER: Severity[] = ['error', 'warn', 'info']
const TEXT: Record<Severity, string> = { error: '错误', warn: '警告', info: '提示' }

// 按级别分组。用 filter 产出**新数组**:props.findings 是 useTools 存下来的那份结论,
// 组件不许就地排序/截取它(渲染期改动共享状态会让别的订阅者看到被改过的数组)。
//
// 截断声明(*:truncated)本身就是 warn 级,所以它一定排在 info 级体积数字**之前**、
// 且在同一个面板里 —— 不许把它拆到别处,否则「源文件共 X」会被当成全量数字读。
const groups = computed(() =>
  ORDER.map((sev) => ({ sev, items: props.findings.filter((f) => f.severity === sev) })).filter((g) => g.items.length)
)

/** rel → 绝对路径:root 由视图给(项目记录里的 path),rel 永远是正斜杠相对路径 */
function reveal(rel?: string) {
  if (rel && props.root) showInFolder(`${props.root.replace(/[\\/]+$/, '')}/${rel}`)
}
</script>

<template>
  <div class="list">
    <section v-for="g in groups" :key="g.sev" :class="['grp', g.sev]">
      <h4>{{ TEXT[g.sev] }} · {{ g.items.length }}</h4>
      <!--
        key 必须带段内序号:Finding.id 只由证据推导(路径/引用 id/资源路径),
        同一文件里两行**字节完全相同**的 [ext_resource] 会算出同一个 id,
        于是一份列表里出现重复 key —— 纯 :key="f.id" 会让 Vue 报重复 key 并错误复用 DOM。
      -->
      <div v-for="(f, i) in g.items" :key="`${f.id}#${i}`" class="item">
        <div class="title">{{ f.title }}</div>
        <div v-if="f.rel" class="rel">
          <code class="mono">{{ f.rel }}</code>
          <button class="btn small ghost" title="在文件管理器中打开该文件所在目录" @click="reveal(f.rel)">
            打开所在目录
          </button>
        </div>
        <div v-if="f.detail" class="detail">{{ f.detail }}</div>
        <div v-if="f.related && f.related.length" class="related">相关:{{ f.related.join('、') }}</div>
        <div v-if="f.fix" class="fix">
          <span class="fix-label">建议:{{ f.fix.label }}</span>
          <!-- 可执行 → 一个真正的动作(点开确认框);不可执行 → 把「为什么」说出来,不摆空按钮 -->
          <button
            v-if="plans[f.id] && plans[f.id].service && !plans[f.id].empty"
            class="btn small"
            :disabled="busy"
            :title="`先看清要动哪些文件,再确认${plans[f.id].verb}`"
            @click="emit('fix', f)"
          >
            {{ plans[f.id].verb }}
          </button>
          <span v-else-if="plans[f.id]" class="fix-na">{{ plans[f.id].reason }}</span>
        </div>
        <!-- 执行回执:成败都显示,失败项逐条带原语的中文原因(spec §5.3 规则 4) -->
        <div v-if="fixState[f.id]" :class="['fix-res', fixState[f.id].ok ? 'ok' : 'bad']">
          <span>{{ fixState[f.id].message }}</span>
          <span
            v-for="(x, xi) in fixState[f.id].failed"
            :key="`${f.id}#fx${xi}`"
            class="fix-res-fail mono"
          >{{ x.rel }}:{{ x.error }}</span>
        </div>
      </div>
    </section>
    <p v-if="!groups.length" class="empty">没有发现问题。</p>
  </div>
</template>

<style scoped>
.list {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}

.grp {
  min-width: 0;
}

.grp h4 {
  margin: 0 0 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-3);
}

.grp.error h4 {
  color: var(--danger);
}

.grp.warn h4 {
  color: var(--warn);
}

.item {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.title {
  font-size: 13px;
  font-weight: 500;
  color: var(--text);
}

.rel {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

/* 长路径必须能折行:否则窄窗口里整页横向滚动 */
.rel code {
  font-size: 11.5px;
  color: var(--text-3);
  overflow-wrap: anywhere;
}

.detail,
.related,
.fix {
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-2);
  overflow-wrap: anywhere;
}

/* 建议行:文案 + 可选的一键动作,窄面板里换行而不是撑破卡片 */
.fix {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.fix-na {
  font-size: 11.5px;
  color: var(--text-3);
}

.fix-res {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 11.5px;
  line-height: 1.6;
}

.fix-res.ok {
  color: var(--ok);
}

.fix-res.bad {
  color: var(--danger);
}

.fix-res-fail {
  color: var(--text-2);
  overflow-wrap: anywhere;
}

.empty {
  margin: 0;
  font-size: 12.5px;
  color: var(--text-2);
}
</style>
