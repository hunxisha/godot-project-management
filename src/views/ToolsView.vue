<script setup lang="ts">
// 工具箱首页(§3 P0-b 第 10 项 / Q13=B / Q25 / Q29=C / A-12 / A-15)。
//
// 形态:密集列表为主,可切网格卡片(选择记进 settings)。旧的「体检控制台」不在这儿复活 ——
// 这一页只做四件事:找到工具、说明工具的状态、开一个工具、管一下目录与历史。
//
// 判据:
//   · 列表的排序、搜索可搜面、筛选 chip 的判据全在 `toolkit/loader`(有断言),这页只调不调不自己判;
//   · 一行坏插件不能连累其他行(loader 的错误隔离),所以坏条目**照样列出来**并带原因;
//   · 关键词让位(A-15)只标黄 + 说明被谁占,不藏起来 —— 工具本身仍可打开是明确的验收项;
//   · 权限面文案的唯一来源是 `scaffold.PERMISSION_TEXT`(经 PermissionNotice 组件),这页一个字都不写。
import { computed, onMounted, ref, watch } from 'vue'
import type { ExistingTool } from '../toolkit/scaffold'
import type { ToolLogEntry } from '../toolkit/toollog'
import { entriesForProject, loadLog } from '../toolkit/toollog'
import Icon from '../components/Icon.vue'
import LedgerPanel from '../components/toolkit/LedgerPanel.vue'
import PermissionNotice from '../components/toolkit/PermissionNotice.vue'
import ScaffoldDialog from '../components/toolkit/ScaffoldDialog.vue'
import ToolPageView from './ToolPageView.vue'
import { getDoc, notify } from '../services/bridge'
import { useProjectList } from '../composables/useProjectList'
import { useToolkit } from '../composables/useToolkit'

const K = useToolkit()
const projects = useProjectList()

const historyOpen = ref(false)
const histProject = ref('*')
const allHistory = ref<ToolLogEntry[]>([])
const historyError = ref('')
const scaffoldOpen = ref(false)
const consentOpen = ref(false)

onMounted(async () => {
  if (!K.loadedOnce.value) await K.ensureLoaded()
  if (!projects.projects.value.length) await projects.reload()
  await refreshHistory()
  // 首次见到新装的插件 ⇒ 把权限面摊到脸上(§6 R-1 缓解① / A-12「首次装插件时」)
  if (K.newDirs.value.length) consentOpen.value = true
})

watch(() => K.activeToolId.value, async (v) => {
  if (v) await refreshHistory()
})

async function refreshHistory() {
  // 面板只读账本;数组住在文档的 value 字段里(与 useToolPage 的 storeBridge 同一约定)
  const r = await loadLog({
    getDoc: async (id: string) => { const doc = await getDoc(id); return doc ? (doc as any).value : undefined },
    putDoc: async () => true
  })
  historyError.value = r.error
  allHistory.value = r.entries
}

const shownHistory = computed<ToolLogEntry[]>(() =>
  histProject.value === '*' ? allHistory.value : entriesForProject(allHistory.value, histProject.value)
)

const existing = computed<ExistingTool[]>(() =>
  K.sorted.value.map((t) => ({
    id: t.manifest ? t.manifest.id : '',
    dirName: t.dirName,
    name: t.manifest ? t.manifest.name : '',
    source: t.source
  }))
)

function openTool(t: any) {
  if (t.state !== 'ok') return
  if (!K.currentProjectId.value && projects.visible.value.length) K.setCurrentProject(projects.visible.value[0].id)
  K.openTool(t.manifest ? t.manifest.id : '')
}

async function onToggle(t: any) {
  await K.toggleEnabled(t)
}

async function onRescan() {
  await K.rescan()
  await refreshHistory()
  notify(K.counts.value.total ? `重新扫描完成:${K.counts.value.ok} 个可用、${K.counts.value.bad} 个载入失败` : '工具目录里还没有插件')
  if (K.newDirs.value.length) consentOpen.value = true
}

async function onOpenDir() {
  const r = await K.openToolsDir()
  if (!r.ok) notify(r.error)
}

function onGenerated(dirName: string, noticeText: string) {
  notify(noticeText || `骨架已生成到 ${dirName}/`)
}

/** 「我看懂了」:把这批目录名记进 settings,下次扫描不再弹(否则天天弹) */
async function ackConsent() {
  await K.acknowledgeNewTools()
  consentOpen.value = false
}

const stateOf = (t: any) => (t.state === 'ok' ? (K.enabledOf(t) ? '可用' : '已禁用') : '载入失败')
</script>

<template>
  <div class="tk">
    <ToolPageView v-if="K.activeTool.value" :key="K.activeToolId.value" :tool="K.activeTool.value" />

    <div v-else class="home">
      <header class="head">
        <h2><Icon name="wrench" :size="15" /> 工具箱<span class="count-pill">{{ K.counts.value.total }}</span></h2>
        <span class="grow" />
        <div class="seg">
          <button type="button" :class="{ on: K.viewMode.value === 'list' }" @click="K.setViewMode('list')"><Icon name="list" :size="13" /> 列表</button>
          <button type="button" :class="{ on: K.viewMode.value === 'grid' }" @click="K.setViewMode('grid')"><Icon name="grid" :size="13" /> 网格</button>
        </div>
        <button class="btn small" type="button" @click="historyOpen = !historyOpen"><Icon name="layers" :size="13" /> 历史</button>
        <button class="btn small" type="button" @click="scaffoldOpen = true"><Icon name="sparkle" :size="13" /> 新建工具骨架</button>
        <button class="btn small" type="button" @click="onOpenDir"><Icon name="folder" :size="13" /> 打开目录</button>
        <button class="btn small primary" type="button" :disabled="K.scanState.value === 'scanning'" @click="onRescan">
          <Icon name="refresh" :size="13" /> {{ K.scanState.value === 'scanning' ? '扫描中' : '重新扫描' }}
        </button>
      </header>

      <p class="dir">
        工具目录<span class="mono">{{ K.dirInfo.value.dir || '(还没扫过)' }}</span>
        <span v-if="K.dirInfo.value.source === 'settings'" class="tag brand">来自设置</span>
        <span v-else-if="K.dirInfo.value.source === 'default'" class="tag">默认 ~/.gpm-tools</span>
        <span v-if="K.dirInfo.value.created" class="tag warn">本次新建</span>
      </p>
      <p v-if="K.scanError.value" class="bad"><Icon name="alert" :size="13" /> {{ K.scanError.value }}(内置工具仍然可用)</p>

      <PermissionNotice />

      <div v-if="historyOpen" class="card">
        <div class="hist-bar">
          <label>按项目筛选</label>
          <select v-model="histProject" class="select">
            <option value="*">全部项目</option>
            <option v-for="p in projects.visible.value" :key="p.id" :value="p.id">{{ p.name }}</option>
          </select>
          <span class="dim">{{ shownHistory.length }} 条</span>
        </div>
        <p v-if="historyError" class="bad">{{ historyError }}</p>
        <LedgerPanel :entries="shownHistory" />
        <p class="dim">超出 50 条只会丢记录,盘上的 <span class="mono">*.gpm-bak-</span> 备份文件不会被删。</p>
      </div>

      <div class="filters">
        <input v-model="K.query.value" class="input grow" placeholder="搜名称、说明、关键词、目录名(坏插件按目录名也搜得到)" />
        <div class="seg">
          <button type="button" :class="{ on: K.kindFilter.value === 'all' }" @click="K.kindFilter.value = 'all'">全部</button>
          <button type="button" :class="{ on: K.kindFilter.value === 'action' }" @click="K.kindFilter.value = 'action'">action</button>
          <button type="button" :class="{ on: K.kindFilter.value === 'view' }" @click="K.kindFilter.value = 'view'">view</button>
        </div>
        <button
          v-for="tg in K.tags.value"
          :key="tg"
          class="chip"
          :class="{ on: K.tagFilter.value === tg }"
          type="button"
          @click="K.tagFilter.value = K.tagFilter.value === tg ? 'all' : tg"
        >{{ tg }}</button>
        <button v-if="K.tagFilter.value !== 'all'" class="chip" type="button" @click="K.tagFilter.value = 'all'"><Icon name="x" :size="11" /> 清标签</button>
      </div>

      <p v-if="!K.visible.value.length" class="dim empty">
        {{ K.counts.value.total ? '没有匹配的工具:换个词或把筛选清掉。' : '工具目录里还没有插件。点「新建工具骨架」生成一个能直接跑的样板,或往目录里丢一个插件后点「重新扫描」。' }}
      </p>

      <div v-else :class="K.viewMode.value === 'grid' ? 'grid' : 'list'">
        <div
          v-for="t in K.visible.value"
          :key="(t.manifest ? t.manifest.id : '') + '|' + t.dirName"
          class="item"
          :class="{ off: t.state === 'ok' && !K.enabledOf(t), bad: t.state !== 'ok' }"
        >
          <div class="ico"><Icon :name="t.state === 'ok' ? 'package' : 'alert'" :size="16" /></div>
          <div class="txt">
            <div class="l1">
              <span class="nm">{{ t.manifest ? t.manifest.name : (t.dirName || '(没名字的目录)') }}</span>
              <span v-if="t.source === 'builtin'" class="tag brand">内置</span>
              <span v-if="t.manifest && t.manifest.status === 'dev'" class="tag warn">未完成</span>
              <span v-if="t.state !== 'ok'" class="tag danger">{{ stateOf(t) }}</span>
              <span v-else-if="K.conflictOf(t)" class="tag warn">关键词被占</span>
            </div>
            <p class="sm">{{ t.manifest ? t.manifest.summary : t.reason }}</p>
            <p v-if="t.state === 'ok' && t.manifest" class="meta">
              <span class="mono">{{ t.manifest.id }}</span>
              <span>{{ t.manifest.kind }} / {{ t.manifest.ui }}</span>
              <span>{{ t.manifest.capabilities.join(' · ') }}</span>
            </p>
            <p v-if="K.conflictOf(t)" class="conf">{{ K.conflictOf(t) }}</p>
          </div>
          <div class="act">
            <label class="switch" :title="K.enabledOf(t) ? '禁用后不再注册成搜索关键词' : '启用后注册关键词'">
              <input type="checkbox" class="chk" :disabled="t.state !== 'ok'" :checked="K.enabledOf(t)" @change="onToggle(t)" />
            </label>
            <button class="btn small" type="button" :disabled="t.state !== 'ok'" @click="openTool(t)">打开</button>
          </div>
        </div>
      </div>

      <ScaffoldDialog :open="scaffoldOpen" :existing="existing" :dir="K.dirInfo.value.dir" @close="scaffoldOpen = false" @generated="onGenerated" />

      <div v-if="consentOpen" class="modal-mask" @click.self="ackConsent">
        <div class="card modal">
          <div class="modal-head"><div class="modal-title"><Icon name="shield-check" :size="15" /> 你刚装进了新的插件</div></div>
          <p class="dim">新出现的目录:{{ K.newDirs.value.join('、') }}</p>
          <PermissionNotice head="它们能做什么(这不是安全边界)" />
          <div class="modal-foot">
            <button class="btn primary" type="button" @click="ackConsent">我看懂了</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tk {
  height: 100%;
  overflow-y: auto;
}

.home {
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

.head h2 {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0;
  color: var(--text);
  font-size: 15px;
  font-weight: 700;
}

.grow {
  flex: 1;
}

.dir {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 8px 0;
  color: var(--text-3);
  font-size: 11.5px;
}

.mono {
  font-family: var(--mono);
}

.filters {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin: 10px 0 6px;
}

.card {
  margin-bottom: 8px;
  padding: 8px 10px;
  border: 1px solid var(--surface-2);
  border-radius: var(--radius);
}

.hist-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  color: var(--text-2);
  font-size: 12px;
}

.list,
.grid {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
}

.item {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 7px 9px;
  border: 1px solid var(--surface-2);
  border-radius: var(--radius);
  background: var(--surface);
}

.item.bad {
  border-left: 3px solid var(--danger);
  background: var(--danger-weak);
}

.item.off {
  opacity: 0.55;
}

.ico {
  padding-top: 2px;
  color: var(--brand);
}

.item.bad .ico {
  color: var(--danger);
}

.txt {
  flex: 1;
  min-width: 0;
}

.l1 {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.nm {
  color: var(--text);
  font-size: 13px;
  font-weight: 700;
}

.sm {
  margin: 2px 0 0;
  color: var(--text-2);
  font-size: 12px;
  line-height: 1.5;
}

.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 9px;
  margin: 3px 0 0;
  color: var(--text-3);
  font-size: 11px;
}

.conf {
  margin: 3px 0 0;
  color: var(--warn);
  font-size: 11.5px;
}

.act {
  display: flex;
  align-items: center;
  gap: 7px;
}

.dim {
  margin: 0;
  color: var(--text-3);
  font-size: 12px;
}

.empty {
  padding: 14px 0;
  text-align: center;
}

.bad {
  display: flex;
  align-items: center;
  gap: 5px;
  margin: 0 0 8px;
  color: var(--danger);
  font-size: 12px;
}
</style>
