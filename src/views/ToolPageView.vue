<script setup lang="ts">
// 工具独立页(§3 P0-b 第 11 项 / Q26 / A-8 / A-16)。`action` 与 `view` 共用这份页头与状态门:
// 区别只在页头下面挂的是「框架按 schema 画的表单 + 预览」还是「插件自己的 view() 渲染」。
//
// 这一层不判断任何东西。参数校验、越界升档、分组、门、执行、账本、回滚全在 `useToolPage`
// 与 `toolkit/*` 那几层(每层都有断言)。页面只负责把话显示出来、把点击转成调用。
//
// ⚠ `view` 型跑的是**插件代码**:它抛异常只塌这一块,不许把整页变白屏。
// 加载器那侧的「单个插件失败只标它自己」要延伸到运行期才算完整。
import { computed, defineComponent, h, onMounted, ref, watch } from 'vue'
import ChangeList from '../components/toolkit/ChangeList.vue'
import DiffView from '../components/toolkit/DiffView.vue'
import FilePicker from '../components/toolkit/FilePicker.vue'
import Icon from '../components/Icon.vue'
import LedgerPanel from '../components/toolkit/LedgerPanel.vue'
import PermissionNotice from '../components/toolkit/PermissionNotice.vue'
import SchemaForm from '../components/toolkit/SchemaForm.vue'
import type { PlannedChange } from '../toolkit/change'
import type { RegisteredTool } from '../toolkit/loader'
import { useProjectList } from '../composables/useProjectList'
import { useToolkit } from '../composables/useToolkit'
import { useToolPage } from '../composables/useToolPage'

const props = defineProps<{ tool: RegisteredTool }>()

const K = useToolkit()
const projects = useProjectList()
const pidRef = computed(() => K.currentProjectId.value)
const page = useToolPage(props.tool, pidRef)

const m = computed(() => props.tool.manifest)
const isView = computed(() => !!m.value && m.value.kind === 'view')

const showPicker = ref(false)
const expanded = ref<{ id: string, preview: any } | null>(null)
const rolling = ref('')

onMounted(async () => {
  if (!projects.projects.value.length) await projects.reload()
  if (!K.currentProjectId.value && projects.visible.value.length) await K.setCurrentProject(projects.visible.value[0].id)
  await page.open()
  await page.loadHistory()
})

// 换项目 ⇒ 文件树与计划都属于上一个项目了,重拉重算;旧 diff 面板收起(留着就是指向别的项目的文件)
watch(pidRef, async () => {
  expanded.value = null
  await page.loadTree()
  if (page.plan.value) await page.makePlan()
})

function setParam(key: string, value: unknown) {
  page.rawParams.value = { ...page.rawParams.value, [key]: value }
}

function setPicked(v: string[]) {
  page.picked.value = v
}

async function onPlan() {
  expanded.value = null
  await page.makePlan()
}

async function onDiff(c: PlannedChange) {
  if (expanded.value && expanded.value.id === c.id) {
    expanded.value = null
    return
  }
  expanded.value = { id: c.id, preview: await page.loadDiff(c) }
}

async function onExecute() {
  await page.execute()
  expanded.value = null
}

async function onRollback(entry: any) {
  rolling.value = `${entry.toolId}|${entry.at}`
  const r = await page.rollback(entry)
  rolling.value = ''
  page.notice.value = r.text
}

const expandedRel = computed(() => {
  const id = expanded.value ? expanded.value.id : ''
  for (const g of page.groups.value) {
    const hit = (g.changes || []).find((c: PlannedChange) => c.id === id)
    if (hit) return hit.rel
  }
  return ''
})

/** view 型的渲染宿主:插件给什么画什么;它炸了就在这里显示原因 */
const ViewHost = defineComponent({
  setup() {
    return () => {
      try {
        const mod = props.tool.module as any
        const node = typeof mod.view === 'function' ? mod.view(page.ctx(), page.fileArgs.value) : null
        return node || h('p', { class: 'dim' }, '这个工具的 view() 没返回可画的东西。')
      } catch (e) {
        return h('p', { class: 'bad' }, `view() 抛异常:${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }
})
</script>

<template>
  <div class="tool-page">
    <header class="head">
      <button class="btn small ghost" type="button" @click="K.closeTool()"><Icon name="x" :size="13" /> 返回工具箱</button>
      <h3>
        <Icon name="wrench" :size="15" />
        {{ m ? m.name : (tool.dirName || '未知工具') }}
        <span v-if="m" class="ver">v{{ m.version }}</span>
        <span v-if="tool.source === 'builtin'" class="tag brand">内置</span>
        <span v-if="m && m.status === 'dev'" class="tag warn">未完成</span>
      </h3>
      <span class="grow" />
      <label class="pid-lab">项目</label>
      <select
        class="select pid"
        :value="K.currentProjectId.value"
        @change="K.setCurrentProject(($event.target as HTMLSelectElement).value)"
      >
        <option value="">(没选项目)</option>
        <option v-for="p in projects.visible.value" :key="p.id" :value="p.id">{{ p.name }}</option>
      </select>
    </header>

    <p v-if="tool.state !== 'ok'" class="why"><Icon name="alert" :size="13" /> {{ tool.reason || '这个工具没载入成功' }}</p>

    <section v-if="isView" class="body">
      <p v-if="!K.currentProjectId.value" class="dim">先在右上角选一个项目。</p>
      <component :is="ViewHost" v-else />
    </section>

    <section v-else class="body">
      <div class="card">
        <SchemaForm
          :fields="page.fields.value"
          :model="page.rawParams.value"
          :issues="page.paramIssues.value"
          :picked-count="page.picked.value.length"
          @set="setParam"
          @pick-files="showPicker = !showPicker"
        />
        <p v-for="(s, i) in page.schemaIssues.value" :key="'s' + i" class="bad">{{ s }}</p>
      </div>

      <div v-if="showPicker" class="card">
        <FilePicker
          :candidates="page.candidates.value"
          :model="page.picked.value"
          :truncated="page.treeTruncated.value"
          @update:model="setPicked"
        />
      </div>

      <div class="bar">
        <button class="btn primary" type="button" :disabled="page.planning.value || !page.usable.value" @click="onPlan">
          <Icon name="refresh" :size="13" /> {{ page.planning.value ? '计算中' : '算一遍要改什么' }}
        </button>
        <span class="sum">{{ page.summary.value }}</span>
      </div>

      <p v-if="page.warn.value" class="warn">{{ page.warn.value }}</p>

      <ChangeList
        :groups="page.groups.value"
        :checked="page.checked.value"
        :expanded-id="expanded ? expanded.id : ''"
        :can-diff="page.diffible"
        @toggle="page.toggleChange"
        @diff="onDiff"
      />
      <DiffView v-if="expanded" :diff="expanded.preview.diff" :error="expanded.preview.error" :rel="expandedRel" />

      <div class="foot">
        <button class="btn primary" type="button" :disabled="!page.canExecute.value" @click="onExecute">
          <Icon name="check" :size="13" /> 执行选中的 {{ page.pickedCount.value }} 条
        </button>
        <button v-if="page.running.value" class="btn small" type="button" @click="page.cancel()"><Icon name="x" :size="13" /> 取消</button>
        <span v-else-if="page.gate.value.ok === false" class="gate">{{ page.gate.value.reason }}</span>
      </div>

      <p v-if="page.notice.value" class="notice">{{ page.notice.value }}</p>

      <h4 class="sec">这个工具最近几条</h4>
      <p v-if="page.historyError.value" class="bad">{{ page.historyError.value }}</p>
      <LedgerPanel :entries="page.recent.value" :busy-id="rolling" @rollback="onRollback" />
    </section>
  </div>
</template>

<style scoped>
/* 只用 main.css 里已有的变量;尺寸一律字面 px(本仓库没有间距令牌) */
.tool-page {
  padding: 10px 14px 18px;
}

.head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--surface-2);
}

.head h3 {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  color: var(--text);
  font-size: 14.5px;
  font-weight: 700;
}

.grow {
  flex: 1;
}

.ver {
  color: var(--text-3);
  font-size: 11.5px;
  font-weight: 400;
}

.pid-lab {
  color: var(--text-3);
  font-size: 11.5px;
}

.pid {
  max-width: 190px;
}

.body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 10px;
}

.card {
  padding: 8px 10px;
  border: 1px solid var(--surface-2);
  border-radius: var(--radius);
}

.bar,
.foot {
  display: flex;
  align-items: center;
  gap: 8px;
}

.sum {
  color: var(--text-2);
  font-size: 12px;
}

.why {
  display: flex;
  align-items: center;
  gap: 5px;
  margin: 8px 0 0;
  color: var(--warn);
  font-size: 12px;
}

.warn {
  margin: 0;
  padding: 6px 8px;
  border-left: 3px solid var(--warn);
  border-radius: var(--radius-sm);
  background: var(--warn-weak);
  color: var(--text);
  font-size: 12px;
}

.gate {
  color: var(--text-3);
  font-size: 11.5px;
}

.notice {
  margin: 0;
  color: var(--ok);
  font-size: 12.5px;
  font-weight: 600;
}

.bad {
  margin: 0;
  color: var(--danger);
  font-size: 11.5px;
}

.dim {
  margin: 0;
  color: var(--text-3);
  font-size: 12px;
}

.sec {
  margin: 8px 0 0;
  color: var(--text-2);
  font-size: 12px;
  font-weight: 700;
}
</style>
