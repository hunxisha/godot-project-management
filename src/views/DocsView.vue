<!-- 文档页:引擎类参考浏览(Workbench 2.0)。
     无可用库时引导生成;有库时左类导航 + 右详情的 IDE 双栏(占满视口高,内部各自滚动);
     库管理(全部版本生成/删除/导入/差异对比/项目扫描)收进「库管理」面板,由 view-head 切换。
     生成任务进度在本页行内展示(全局任务栏由 App 负责)。 -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Icon from '../components/Icon.vue'
import DocClassPanel from '../components/docs/DocClassPanel.vue'
import DocTreePanel from '../components/docs/DocTreePanel.vue'
import DocDiffDialog from '../components/docs/DocDiffDialog.vue'
import { useDocs } from '../composables/useDocs'
import { notify, pickFile } from '../services/bridge'
import type { DocClassSummary, DocsTask, GodotProject } from '../types/godot'

const props = defineProps<{
  /** 来自全局搜索命中的跳转目标,消费后回调 */
  pendingTarget?: { className: string, anchor?: string } | null
  /** 来自项目卡片:要切换到的引擎版本文档库,消费后回调 */
  pendingVersionId?: string | null
}>()
const emit = defineEmits<{
  (e: 'consumed'): void
  (e: 'version-consumed'): void
}>()

const {
  versions, statuses, currentVersionId, currentStatus, readyVersions, classes,
  favorites, history, init, selectVersion, generate, importLibrary, scanProject, removeLibrary, afterTaskSettled
} = useDocs()

/** 当前打开的类 */
const selected = ref('')
/** 搜索命中带来的定位锚点 */
const anchor = ref<string | null>(null)
/** 侧栏过滤 */
const filter = ref('')
/** 侧栏想要哪种视图。真正生效的见 showTree */
const navView = ref<'list' | 'tree'>('list')
const treeEl = ref<InstanceType<typeof DocTreePanel> | null>(null)
/**
 * 树视图是否真的铺开:过滤中强制回列表 —— 成员名匹配(见 memberMatchNames)与
 * 「类名命中优先、其次成员名命中」的排序分组都是列表语义,塞进树里没有对应物。
 */
const showTree = computed(() => navView.value === 'tree' && !filter.value.trim())
/** 管理模式:显示全部版本的生成/删除操作 */
const managing = ref(false)
/** 窄窗(单栏布局)下是否停在列表 */
const showList = ref(true)

const tasks = ref<DocsTask[]>([])
let unwatch: (() => void) | null = null

onMounted(() => {
  init()
  refreshProjects()
  // 默认打开上次浏览或历史里的第一个类(桌面双栏才有意义;窄窗停在列表)
  if (!selected.value) {
    const first = history.value.find((h) => classes.value.some((c) => c.name === h.name))
    selected.value = first?.name ?? (window.innerWidth > 900 ? firstClass.value : '')
  }
  unwatch = window.services.watchDocsTasks((snap) => {
    const prev = tasks.value
    tasks.value = snap
    // 任务从在途变为终态时刷新库状态(生成完成 → 新库可浏览;失败 → 状态回退)
    const settled = snap.filter((t) => ['done', 'error', 'canceled'].includes(t.status))
    for (const t of settled) {
      const before = prev.find((x) => x.id === t.id)
      if (before && !['done', 'error', 'canceled'].includes(before.status)) afterTaskSettled()
    }
  })
  applyPending()
  applyPendingVersion()
})

onBeforeUnmount(() => { if (unwatch) unwatch() })

const firstClass = computed(() => classes.value[0]?.name ?? '')

/** 在途任务(进度条用),按版本取最新 */
const activeTaskByVersion = computed(() => {
  const map: Record<string, DocsTask> = {}
  for (const t of tasks.value) {
    if (['done', 'error', 'canceled'].includes(t.status)) continue
    map[t.versionId] = t
  }
  return map
})

/** 成员名命中集合(用于列表项角标与排序分组) */
const memberMatchNames = computed(() => {
  const kw = filter.value.trim().toLowerCase()
  if (!kw) return new Set<string>()
  const out = new Set<string>()
  for (const c of classes.value) {
    if (c.name.toLowerCase().includes(kw)) continue
    if (
      c.m.some((x) => x.toLowerCase().includes(kw)) ||
      c.p.some((x) => x.toLowerCase().includes(kw)) ||
      c.s.some((x) => x.toLowerCase().includes(kw)) ||
      c.c.some((x) => x.toLowerCase().includes(kw)) ||
      c.e.some((x) => x.toLowerCase().includes(kw))
    ) out.add(c.name)
  }
  return out
})

/** 侧栏列表:类名命中优先,其次成员名命中(找「哪个类有 tween_interval」不用开 Ctrl+K) */
const filtered = computed(() => {
  const kw = filter.value.trim().toLowerCase()
  const byName: DocClassSummary[] = []
  const byMember: DocClassSummary[] = []
  for (const c of classes.value) {
    if (!kw) { byName.push(c); continue }
    if (c.name.toLowerCase().includes(kw)) byName.push(c)
    else if (memberMatchNames.value.has(c.name)) byMember.push(c)
  }
  const cmp = (a: DocClassSummary, b: DocClassSummary) => a.name.localeCompare(b.name)
  return [...byName.sort(cmp), ...byMember.sort(cmp)]
})

const favoriteItems = computed(() =>
  favorites.value
    .filter((f) => filtered.value.some((c) => c.name === f))
    .sort((a, b) => a.localeCompare(b))
)

const historyItems = computed(() =>
  history.value
    .filter((h) => filtered.value.some((c) => c.name === h.name))
    .slice(0, 8)
)

function openClass(name: string) {
  gotoClass(name)
}

/**
 * 正文头部「在继承树中查看」:切到树视图并定位当前类。
 * 有过滤词时先清掉 —— 用户明确要看树,留着搜索词只会让树出不来。
 */
function showInTree() {
  filter.value = ''
  navView.value = 'tree'
  nextTick(() => treeEl.value?.revealCurrent())
}

const anchorKey = ref(0)
/** 导航栈:跨类跳转时压入上一个类,支持返回(Alt+← / 返回按钮) */
const backStack = ref<string[]>([])

/** 统一入口:记录来路后打开某个类 */
function gotoClass(cls: string, anchorName?: string | null, opts: { push?: boolean } = {}) {
  const push = opts.push !== false
  if (cls !== selected.value && selected.value && push) {
    backStack.value.push(selected.value)
    if (backStack.value.length > 50) backStack.value.shift()
  }
  anchor.value = anchorName ?? null
  if (cls === selected.value && anchorName) {
    // 同类跳转:通过 anchorKey 变化让面板重新定位
    anchorKey.value++
  } else {
    selected.value = cls
  }
  if (window.innerWidth <= 900) showList.value = false
}

const canGoBack = computed(() => backStack.value.length > 0)
/** 返回按钮上显示的上一个类名 */
const prevClassName = computed(() => backStack.value[backStack.value.length - 1] ?? '')
/** 窄窗(≤900px):列表与详情二选一,详情区需要「类列表」入口 */
const isNarrow = ref(window.innerWidth <= 900)

function onResize() {
  isNarrow.value = window.innerWidth <= 900
}

function goBack() {
  const prev = backStack.value.pop()
  if (!prev) return
  gotoClass(prev, null, { push: false })
}

function onNavigate(cls: string, anchorName?: string) {
  gotoClass(cls, anchorName)
}

/** 管理面板里的取消(模板不能直接访问 window) */
function cancelTask(id: string) {
  window.services.docsCancelTask(id)
}

/** 发起生成:preload 拒绝入队的原因(版本缺失/在途)必须浮出来,不能静默 */
async function onGenerate(id: string, forceTranslation = false) {
  const r = await generate(id, { forceTranslation })
  if (!r.ok) notify(r.error || '无法发起生成')
}

/** 重新生成(勾选强刷翻译时忽略 po 缓存,重新下载官方翻译) */
function onRegenerate(id: string, forceTranslation: boolean) {
  onGenerate(id, forceTranslation)
}

/**
 * 导入外部 extension_api.json 建库(无引擎可用的兜底):
 * 在任意机器跑 `godot --headless --dump-extension-api-with-docs` 得到该文件即可。
 */
async function onImport() {
  const file = await pickFile('选择 extension_api.json', ['json'])
  if (!file) return
  const r = await importLibrary(file)
  if (!r.ok) {
    notify(r.error || '导入失败')
    return
  }
  notify('已开始导入,进度见任务栏')
}

/** 项目脚本扫描:列出项目让用户选一个 */
const projects = ref<(GodotProject & { _id: string })[]>([])
const scanProjectId = ref('')

async function refreshProjects() {
  projects.value = ((await window.ztools.db.allDocs('godot/project/')) || []) as unknown as (GodotProject & { _id: string })[]
  if (!scanProjectId.value || !projects.value.some((p) => p._id === scanProjectId.value)) {
    scanProjectId.value = projects.value[0]?._id ?? ''
  }
}

async function onScanProject() {
  if (!scanProjectId.value) return
  const r = await scanProject(scanProjectId.value)
  if (!r.ok) {
    notify(r.error || '扫描失败')
    return
  }
  notify('已开始扫描项目脚本,完成后出现在库列表')
}

function applyPending() {
  const t = props.pendingTarget
  if (!t) return
  gotoClass(t.className, t.anchor ?? null)
  emit('consumed')
}

watch(() => props.pendingTarget, (v, old) => {
  if (v && v !== old) applyPending()
})

/** 项目卡片「查看文档」:切到该项目绑定的引擎版本;未生成则给出提示(留在库管理可见处) */
function applyPendingVersion() {
  const id = props.pendingVersionId
  if (!id) return
  const st = statuses.value[id]
  if (st && st.status === 'ready') {
    selectVersion(id)
  } else if (versions.value.some((v) => v._id === id)) {
    notify('该项目绑定的引擎还没有文档库,点「生成」即可创建')
    if (!readyVersions.value.length) return
  } else {
    notify('该项目未绑定已安装的引擎')
  }
  emit('version-consumed')
}

watch(() => props.pendingVersionId, (v, old) => {
  if (v && v !== old) applyPendingVersion()
})

// Alt+← 返回上一个类(Ctrl+K 之外的第二个键盘入口)
function onKeydown(e: KeyboardEvent) {
  if (!e.altKey || e.key !== 'ArrowLeft') return
  if (!canGoBack.value) return
  // 输入框内不拦截(侧栏过滤/搜索面板),避免与文本编辑快捷键打架
  const el = e.target as HTMLElement | null
  const tag = el?.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable) return
  e.preventDefault()
  goBack()
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('resize', onResize)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('resize', onResize)
})

/** 当前类不在当前库时的提示(切库/搜索跳转到未收录的类) */
const classMissing = computed(() => !!selected.value && classes.value.length > 0 && !classes.value.some((c) => c.name === selected.value))

/** 发起强刷翻译(带确认语义:会重新下载 9-10MB 翻译) */
const forceTpl = ref(false)
/** 跨版本差异对比对话框 */
const diffOpen = ref(false)

/** 参与对比的库(已生成的) */
const diffLibs = computed(() =>
  versions.value
    .map((v) => ({ versionId: v._id, tag: v.tag, status: statuses.value[v._id] ?? null }))
    .filter((l) => l.status?.status === 'ready')
)

/** 状态徽标文案 */
function statusText(id: string): string {
  const s = statuses.value[id]
  if (!s) return '未生成'
  if (s.status === 'ready') {
    // 项目脚本库不涉及官方翻译,单独标注
    if (s.kind === 'project') return `${s.classCount} 类 · 项目`
    return `${s.classCount} 类${s.lang === 'en' ? ' · 英文' : ' · 中文'}`
  }
  return '生成中…'
}

/**
 * 差异对比 → 文档跳转:关弹窗,切到该类所在的库(新增/变化 → 目标库,移除 → 基准库)
 * 再打开类文档;带成员锚点时直接定位到对应成员。
 * 先 gotoClass 后 selectVersion:两个同步更新合并成一次面板重挂载,避免中间态闪烁。
 */
function onDiffOpenDoc(t: { className: string, versionId: string, anchor?: string }) {
  diffOpen.value = false
  gotoClass(t.className, t.anchor ?? null)
  if (t.versionId && t.versionId !== currentVersionId.value) selectVersion(t.versionId)
}

/** 翻译覆盖率(中文库才有意义):命中/可翻译总数 */
function coverageText(id: string): string {
  const s = statuses.value[id]
  if (!s || s.status !== 'ready' || s.lang === 'en') return ''
  const total = s.stringCount || 0
  const hit = s.translatedCount || 0
  if (!total) return ''
  return `翻译覆盖 ${Math.round((hit / total) * 100)}%(${hit}/${total})`
}

const PHASE_TEXT: Record<string, string> = {
  queued: '排队中',
  dumping: '引擎导出中',
  translating: '翻译下载中',
  parsing: '解析中'
}
</script>

<template>
  <div class="docs view" :class="{ ide: readyVersions.length && !managing }">
    <!-- 顶部:标题 + 当前库 tag + 切换 + 重新生成/删除 + 库管理入口 -->
    <div class="view-head">
      <h2><Icon name="book" :size="17" /> 文档 <span v-if="readyVersions.length" class="count-pill">{{ readyVersions.length }}</span></h2>

      <template v-if="readyVersions.length && !managing">
        <span class="tag brand mono head-lib-tag" :title="`当前文档库 · ${statusText(currentVersionId)}`">{{ currentStatus?.tag ?? '' }}</span>
        <select
          class="select head-ver"
          :value="currentVersionId"
          title="切换文档库"
          @change="selectVersion(($event.target as HTMLSelectElement).value)"
        >
          <option v-for="v in readyVersions" :key="v._id" :value="v._id">{{ v.name }}</option>
        </select>
        <!-- 当前库在途任务:进度条代替操作按钮 -->
        <span v-if="activeTaskByVersion[currentVersionId]" class="head-task" title="正在重新生成当前文档库">
          <span class="bar" :class="{ indet: !activeTaskByVersion[currentVersionId].total }">
            <span class="fill" :style="{ width: activeTaskByVersion[currentVersionId].total ? `${Math.min(100, (activeTaskByVersion[currentVersionId].done / activeTaskByVersion[currentVersionId].total) * 100)}%` : '30%' }"></span>
          </span>
          <span class="head-task-text">{{ PHASE_TEXT[activeTaskByVersion[currentVersionId].status] || activeTaskByVersion[currentVersionId].status }}</span>
        </span>
        <span v-else class="head-acts">
          <button class="btn small ghost" title="重新生成当前文档库(强制刷新翻译在「库管理」中勾选)" @click="onRegenerate(currentVersionId, forceTpl)">
            <Icon name="refresh" :size="13" /> 重新生成
          </button>
          <button class="btn small danger-text" title="删除当前文档库" @click="removeLibrary(currentVersionId)">
            <Icon name="trash" :size="13" /> 删除
          </button>
        </span>
      </template>

      <span class="grow"></span>
      <!-- 版本差异对比:常驻 view-head(删除/库管理之间),两处模式都能直达 -->
      <button
        v-if="versions.length"
        class="btn small ghost"
        :disabled="readyVersions.length < 2"
        :title="readyVersions.length < 2 ? '至少需要两个已生成的文档库' : '对比两个版本的 API 差异(升级前评估)'"
        @click="diffOpen = true"
      >
        <Icon name="layers" :size="13" /> 版本差异对比
      </button>
      <button
        class="btn small ghost head-manage"
        :class="{ on: managing }"
        :title="managing ? '收起管理面板,回到类参考浏览' : '管理文档库(生成 / 删除 / 导入 / 项目扫描)'"
        @click="managing = !managing; if (managing) refreshProjects()"
      >
        <Icon name="gear" :size="13" /> {{ managing ? '返回浏览' : '库管理' }}
      </button>
    </div>

    <!-- 库管理面板:全部版本的生成/删除 + 导入 + 项目扫描(差异对比入口在 view-head) -->
    <div v-if="managing" class="panel manage-panel">
      <div class="panel-head">
        <span class="panel-title"><Icon name="gear" :size="13" /> 文档库管理</span>
        <span class="grow"></span>
        <button class="btn small ghost" title="从 extension_api.json 导入建库(无引擎可用时的兜底)" @click="onImport">
          <Icon name="upload" :size="12" /> 导入 API 文件
        </button>
      </div>

      <div v-if="versions.length" class="rows">
        <div v-for="v in versions" :key="v._id" class="row">
          <div class="row-main">
            <div class="row-name">
              <span class="vname">{{ v.name }}</span>
              <span class="vtag mono">{{ v.tag }}</span>
            </div>
            <div class="row-meta">
              <span class="tag" :class="statuses[v._id]?.status === 'ready' ? 'ok' : activeTaskByVersion[v._id] ? 'warn' : ''">{{ statusText(v._id) }}</span>
              <span v-if="coverageText(v._id)" class="cov" title="官方翻译未覆盖的条目保留英文原文">{{ coverageText(v._id) }}</span>
            </div>
          </div>
          <span class="grow"></span>
          <div v-if="activeTaskByVersion[v._id]" class="row-task">
            <span class="bar" :class="{ indet: !activeTaskByVersion[v._id].total }">
              <span class="fill" :style="{ width: activeTaskByVersion[v._id].total ? `${Math.min(100, (activeTaskByVersion[v._id].done / activeTaskByVersion[v._id].total) * 100)}%` : '30%' }"></span>
            </span>
            <span class="task-text">{{ PHASE_TEXT[activeTaskByVersion[v._id].status] || activeTaskByVersion[v._id].status }}{{ activeTaskByVersion[v._id].total ? ` ${activeTaskByVersion[v._id].done}/${activeTaskByVersion[v._id].total}` : '' }}</span>
            <button class="btn small ghost icon-btn" title="取消任务" @click="cancelTask(activeTaskByVersion[v._id].id)"><Icon name="x" :size="12" /></button>
          </div>
          <template v-else>
            <button
              class="btn small ghost icon-btn"
              :title="statuses[v._id]?.status === 'ready' ? '重新生成文档库' : '生成文档库'"
              @click="onRegenerate(v._id, forceTpl)"
            >
              <Icon :name="statuses[v._id]?.status === 'ready' ? 'refresh' : 'download'" :size="13" />
            </button>
            <button
              v-if="statuses[v._id]?.status === 'ready'"
              class="btn small danger-text icon-btn"
              title="删除文档库"
              @click="removeLibrary(v._id)"
            >
              <Icon name="trash" :size="13" />
            </button>
          </template>
        </div>
      </div>
      <div v-else class="boot-none">
        <div class="glyph"><Icon name="box" :size="26" /></div>
        <p>还没有已安装的引擎 —— 到「版本」页安装一个 Godot,或导入现成的 API 文件。</p>
        <button class="btn" @click="onImport"><Icon name="upload" :size="13" /> 导入 extension_api.json</button>
        <p class="hint">在任意机器执行 <code class="mono">godot --headless --dump-extension-api-with-docs</code> 得到该 JSON</p>
      </div>

      <!-- 引擎列表之外的在途任务(项目脚本扫描等) -->
      <div v-if="Object.values(activeTaskByVersion).some((t) => !versions.some((v) => v._id === t.versionId))" class="tasks">
        <div class="list-group">进行中的任务</div>
        <div
          v-for="t in Object.values(activeTaskByVersion).filter((t) => !versions.some((v) => v._id === t.versionId))"
          :key="t.id"
          class="row task-row"
        >
          <Icon name="terminal" :size="13" class="task-ico" />
          <span class="task-name mono">{{ t.versionName || t.tag }}</span>
          <span class="grow"></span>
          <span class="bar" :class="{ indet: !t.total }">
            <span class="fill" :style="{ width: t.total ? `${Math.min(100, (t.done / t.total) * 100)}%` : '30%' }"></span>
          </span>
          <span class="task-text">{{ PHASE_TEXT[t.status] || t.status }}{{ t.total ? ` ${t.done}/${t.total}` : '' }}</span>
          <button class="btn small ghost icon-btn" title="取消任务" @click="cancelTask(t.id)"><Icon name="x" :size="12" /></button>
        </div>
      </div>

      <div class="panel-body extra">
        <label class="force-row">
          <input v-model="forceTpl" type="checkbox" class="switch">
          <span>重新生成时强制刷新中文翻译<span class="row-hint">忽略本地 po 缓存,重新下载约 10MB 官方翻译</span></span>
        </label>
        <!-- 项目脚本扫描:把项目里带 class_name 的 .gd 解析成同类文档 -->
        <div v-if="projects.length" class="scan-row">
          <select v-model="scanProjectId" class="select scan-select" title="选择要扫描的项目">
            <option v-for="p in projects" :key="p._id" :value="p._id">{{ p.name }}</option>
          </select>
          <button class="btn small" title="扫描项目脚本(带 class_name 的 .gd)生成文档库" @click="onScanProject">
            <Icon name="pen" :size="12" /> 扫描项目脚本
          </button>
        </div>
      </div>
    </div>

    <!-- 无可用库:引导生成 -->
    <div v-else-if="!readyVersions.length" class="panel boot-panel">
      <div class="panel-head">
        <span class="panel-title"><Icon name="book" :size="13" /> 生成文档库</span>
        <span class="grow"></span>
        <button class="btn small ghost" title="从 extension_api.json 导入建库(无引擎可用时的兜底)" @click="onImport">
          <Icon name="upload" :size="12" /> 导入 API 文件
        </button>
      </div>
      <p class="boot-desc">
        从已安装的 Godot 引擎一键导出离线类参考(--dump-extension-api-with-docs),与引擎版本逐字节对应;自动套用官方简体中文翻译,未翻译条目保留英文。
      </p>

      <div v-if="versions.length" class="rows">
        <div v-for="v in versions" :key="v._id" class="row">
          <div class="row-main">
            <div class="row-name">
              <span class="vname">{{ v.name }}</span>
              <span class="vtag mono">{{ v.tag }}</span>
            </div>
            <div class="row-meta">
              <span class="tag" :class="statuses[v._id]?.status === 'ready' ? 'ok' : activeTaskByVersion[v._id] ? 'warn' : ''">{{ statusText(v._id) }}</span>
              <span v-if="coverageText(v._id)" class="cov" title="官方翻译未覆盖的条目保留英文原文">{{ coverageText(v._id) }}</span>
            </div>
          </div>
          <span class="grow"></span>
          <button v-if="!activeTaskByVersion[v._id]" class="btn small primary" @click="onGenerate(v._id)">
            <Icon name="download" :size="12" /> 生成
          </button>
          <div v-else class="row-task">
            <span class="bar" :class="{ indet: !activeTaskByVersion[v._id].total }">
              <span class="fill" :style="{ width: activeTaskByVersion[v._id].total ? `${Math.min(100, (activeTaskByVersion[v._id].done / activeTaskByVersion[v._id].total) * 100)}%` : '30%' }"></span>
            </span>
            <span class="task-text">{{ PHASE_TEXT[activeTaskByVersion[v._id].status] || activeTaskByVersion[v._id].status }}{{ activeTaskByVersion[v._id].total ? ` ${activeTaskByVersion[v._id].done}/${activeTaskByVersion[v._id].total}` : '' }}</span>
            <button class="btn small ghost icon-btn" title="取消生成" @click="cancelTask(activeTaskByVersion[v._id].id)"><Icon name="x" :size="12" /></button>
          </div>
        </div>
      </div>
      <div v-else class="boot-none">
        <div class="glyph"><Icon name="box" :size="26" /></div>
        <p>还没有已安装的引擎 —— 到「版本」页安装一个 Godot,或导入现成的 API 文件。</p>
        <button class="btn" @click="onImport"><Icon name="upload" :size="13" /> 导入 extension_api.json</button>
        <p class="hint">在任意机器执行 <code class="mono">godot --headless --dump-extension-api-with-docs</code> 得到该 JSON</p>
      </div>

      <!-- 引擎列表之外的在途任务(项目脚本扫描等) -->
      <div v-if="versions.length && Object.values(activeTaskByVersion).some((t) => !versions.some((v) => v._id === t.versionId))" class="tasks">
        <div class="list-group">进行中的任务</div>
        <div
          v-for="t in Object.values(activeTaskByVersion).filter((t) => !versions.some((v) => v._id === t.versionId))"
          :key="t.id"
          class="row task-row"
        >
          <Icon name="terminal" :size="13" class="task-ico" />
          <span class="task-name mono">{{ t.versionName || t.tag }}</span>
          <span class="grow"></span>
          <span class="bar" :class="{ indet: !t.total }">
            <span class="fill" :style="{ width: t.total ? `${Math.min(100, (t.done / t.total) * 100)}%` : '30%' }"></span>
          </span>
          <span class="task-text">{{ PHASE_TEXT[t.status] || t.status }}{{ t.total ? ` ${t.done}/${t.total}` : '' }}</span>
          <button class="btn small ghost icon-btn" title="取消任务" @click="cancelTask(t.id)"><Icon name="x" :size="12" /></button>
        </div>
      </div>
    </div>

    <!-- 类参考浏览:左类导航 + 右详情 -->
    <div v-else class="layout" :class="{ narrow: !showList }">
      <aside class="side panel">
        <div class="side-top">
          <div class="filter-box">
            <Icon name="search" :size="13" class="filter-ico" />
            <input v-model="filter" class="filter-input" placeholder="过滤类名或成员…" spellcheck="false">
          </div>
          <div class="seg side-seg">
            <button :class="{ on: !showTree }" title="按名称浏览全部类" @click="navView = 'list'">
              <Icon name="list" :size="11" /> 列表
            </button>
            <button
              :class="{ on: showTree }"
              :disabled="!!filter.trim()"
              :title="filter.trim() ? '过滤中只能看列表,清空过滤词后可用继承树' : '按继承层级浏览全部类'"
              @click="navView = 'tree'"
            >
              <Icon name="git-branch" :size="11" /> 继承树
            </button>
          </div>
        </div>

        <div class="class-list">
          <div v-if="favoriteItems.length" class="list-group">收藏</div>
          <button
            v-for="name in favoriteItems"
            :key="`fav-${name}`"
            class="cls-item"
            :class="{ active: name === selected }"
            @click="openClass(name)"
          >
            <Icon name="star" :size="11" class="fav-ico" />
            <span class="cls-name mono">{{ name }}</span>
          </button>

          <div v-if="historyItems.length" class="list-group">最近</div>
          <button
            v-for="h in historyItems"
            :key="`his-${h.name}`"
            class="cls-item"
            :class="{ active: h.name === selected }"
            @click="openClass(h.name)"
          >
            <Icon name="clock" :size="11" class="his-ico" />
            <span class="cls-name mono">{{ h.name }}</span>
          </button>

          <!--
            树用 v-show、列表用 v-if,这个分工是有意的:
            树只渲染「已展开路径」上的行(几十行量级),常驻挂载几乎不要钱,却能让用户
            手动铺开的分支在「列表 ↔ 树」来回切之后还在;而扁平列表在 1075 类库里是上千个
            按钮,藏在树视图后面继续渲染就是白付的钱,所以它该跟着 v-if 卸掉。
          -->
          <div v-show="showTree">
            <div class="list-group">继承树 <span class="cnt">{{ classes.length }}</span></div>
            <DocTreePanel ref="treeEl" :current-class="selected" @navigate="openClass" />
          </div>

          <template v-if="!showTree">
            <div class="list-group">全部 <span class="cnt">{{ filtered.length }}</span></div>
            <button
              v-for="c in filtered"
              :key="c.name"
              class="cls-item"
              :class="{ active: c.name === selected }"
              @click="openClass(c.name)"
            >
              <span class="cls-name mono">{{ c.name }}</span>
              <span v-if="memberMatchNames.has(c.name)" class="hit" title="成员名匹配">成员</span>
              <span v-else-if="c.inherits" class="cls-inherits mono">{{ c.inherits }}</span>
            </button>
            <div v-if="!filtered.length" class="list-empty">没有匹配「{{ filter }}」的类</div>
          </template>
        </div>
      </aside>

      <section class="detail">
        <!-- 返回条:按钮上直接印 Alt+←,让快捷键一眼可见;无来路时禁用并说明原因。
             窄窗额外给「类列表」入口(宽窗左侧列表常驻,不需要) -->
        <div class="detail-bar">
          <button v-if="isNarrow" class="btn small ghost" @click="showList = true">
            <Icon name="chevron-left" :size="13" /> 类列表
          </button>
          <button
            class="btn small ghost btn-back"
            :disabled="!canGoBack"
            :title="canGoBack ? '返回上一个类' : '点击描述里的链接跳转后会记录来路,即可返回'"
            @click="goBack"
          >
            <Icon name="chevron-left" :size="13" /> 返回
            <span v-if="prevClassName" class="prev-name mono">{{ prevClassName }}</span>
            <span class="kbd">Alt+←</span>
          </button>
        </div>
        <div v-if="classMissing" class="missing-lib">
          <Icon name="alert" :size="15" />
          <span>「{{ selected }}」不在当前文档库({{ currentStatus?.tag }})中 —— 可能属于其他引擎版本。</span>
        </div>
        <DocClassPanel
          v-if="selected && currentVersionId"
          :key="`${currentVersionId}-${selected}-${anchorKey}`"
          :version-id="currentVersionId"
          :class-name="selected"
          :anchor="anchor"
          @navigate="onNavigate"
          @show-tree="showInTree"
          @anchor-done="anchor = null"
        />
        <div v-else class="detail-empty">
          <div class="glyph"><Icon name="book" :size="26" /></div>
          <p>从左侧选择一个类开始浏览</p>
          <p class="hint"><span class="kbd">Ctrl+K</span> 可在任意页面搜索类与方法</p>
        </div>
      </section>
    </div>

    <!-- 跨版本 API 差异对比 -->
    <DocDiffDialog
      :open="diffOpen"
      :libraries="diffLibs"
      :initial-a="currentVersionId"
      @close="diffOpen = false"
      @open-doc="onDiffOpenDoc"
    />
  </div>
</template>

<style scoped>
/* 根:类参考模式占满视口高(双栏内部各自滚动);引导/管理面板自然流式 */
.docs.view.ide {
  height: 100%;
}

.docs.view.ide .view-head {
  flex-shrink: 0;
}

/* ---------- 顶部 view-head ---------- */
.head-lib-tag {
  flex-shrink: 0;
}

.head-ver {
  max-width: 176px;
  padding: 3px 8px;
  font-size: 12px;
  border-radius: 6px;
  box-shadow: none;
}

.head-acts {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.head-task {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.head-task .bar {
  width: 96px;
}

.head-task-text {
  font-size: 11.5px;
  color: var(--brand);
  white-space: nowrap;
}

.head-manage.on {
  color: var(--brand);
  border-color: var(--brand);
  background: var(--brand-weak);
}

/* ---------- 引导 / 管理面板共用行 ---------- */
.boot-desc {
  margin: 12px 14px 2px;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--text-3);
}

.rows {
  margin-top: 6px;
}

.row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  transition: background 0.13s;
}

.row + .row {
  border-top: 1px solid var(--surface-2);
}

.row:hover {
  background: var(--surface-2);
}

.row-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.row-name {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.vname {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.vtag {
  font-size: 11px;
  color: var(--text-3);
}

.row-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.cov {
  font-size: 11px;
  color: var(--text-3);
  white-space: nowrap;
}

.row-task {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.row-task .bar {
  width: 118px;
}

.task-text {
  font-size: 11.5px;
  color: var(--text-3);
  white-space: nowrap;
}

/* 引擎列表之外的在途任务(项目脚本扫描等) */
.tasks {
  padding: 2px 0 4px;
}

.tasks .list-group {
  padding: 10px 14px 4px;
}

.task-row .bar {
  width: 118px;
  flex-shrink: 0;
}

.task-name {
  font-size: 12px;
  color: var(--text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.task-ico {
  color: var(--text-3);
  flex-shrink: 0;
}

/* 无引擎可用的空态 */
.boot-none {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 34px 24px;
  text-align: center;
  font-size: 12.5px;
  color: var(--text-3);
}

.boot-none .glyph {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
  margin-bottom: 4px;
  border-radius: 50%;
  background: var(--brand-weak);
  color: var(--brand);
}

.boot-none .hint {
  font-size: 11.5px;
}

.boot-none code {
  padding: 1px 5px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--surface-2);
  font-size: 11px;
}

/* 管理面板底部:强刷翻译 + 项目扫描 */
.extra {
  border-top: 1px solid var(--border);
  margin-top: 4px;
}

.force-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 12px;
  color: var(--text-2);
  cursor: pointer;
  user-select: none;
}

.force-row .switch {
  margin-top: 1px;
  flex-shrink: 0;
}

.scan-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 11px;
}

.scan-select {
  flex: 1;
  min-width: 0;
}

/* ---------- 类参考浏览(IDE 双栏) ---------- */
.layout {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 264px minmax(0, 1fr);
  gap: 14px;
}

.side {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.side-top {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 10px 9px;
  border-bottom: 1px solid var(--border);
  background: var(--panel-head);
  flex-shrink: 0;
}

.filter-box {
  display: flex;
  align-items: center;
  gap: 7px;
  height: 28px;
  padding: 0 9px;
  border: 1px solid var(--border-strong);
  border-radius: 7px;
  background: var(--surface);
  color: var(--text-3);
  transition: border-color 0.15s, box-shadow 0.15s;
}

.filter-box:focus-within {
  border-color: var(--brand);
  box-shadow: 0 0 0 3px var(--brand-weak);
}

.filter-ico {
  flex-shrink: 0;
}

.filter-input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: none;
  color: var(--text);
  font-size: 12.5px;
}

.filter-input::placeholder {
  color: var(--text-3);
}

.side-seg {
  width: 100%;
}

.side-seg button {
  flex: 1;
  justify-content: center;
}

/* 过滤中树视图不可用:置灰而不是「点了没反应」,原因写在 title 里 */
.side-seg button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.class-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 2px 6px 12px;
}

.list-group {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 10px 8px 4px;
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--text-3);
}

.list-group .cnt {
  font-weight: 500;
  opacity: 0.8;
}

.cls-item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  height: 24px;
  padding: 0 8px;
  border: none;
  border-radius: var(--radius-sm);
  background: none;
  cursor: pointer;
  text-align: left;
  transition: background 0.13s;
}

.cls-item:hover {
  background: var(--surface-2);
}

/* 当前类:brand-weak 底 + 左侧 inset 品牌条 */
.cls-item.active {
  background: var(--brand-weak);
  box-shadow: inset 2px 0 0 var(--brand);
}

.cls-item.active .cls-name {
  color: var(--brand);
  font-weight: 600;
}

.cls-name {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fav-ico {
  color: var(--gold);
  flex-shrink: 0;
}

.his-ico {
  color: var(--text-3);
  flex-shrink: 0;
}

/* 成员名命中角标(「哪个类有 tween_interval」) */
.hit {
  flex-shrink: 0;
  padding: 0 5px;
  font-size: 9.5px;
  font-weight: 600;
  line-height: 15px;
  color: var(--brand);
  background: var(--brand-weak);
  border-radius: 5px;
}

.cls-inherits {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--text-3);
  opacity: 0.75;
}

.list-empty {
  padding: 16px 10px;
  font-size: 12px;
  color: var(--text-3);
  text-align: center;
}

/* ---------- 详情区 ---------- */
.detail {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.detail-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.prev-name {
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--brand);
}

.btn-back .kbd {
  margin-left: 2px;
}

/* DocClassPanel 根节点撑满剩余高度,内部滚动 */
.detail :deep(.panel) {
  flex: 1;
  min-height: 0;
}

.missing-lib {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border: 1px solid color-mix(in srgb, var(--warn) 40%, transparent);
  border-radius: var(--radius);
  background: var(--warn-weak);
  color: var(--warn);
  font-size: 12.5px;
  flex-shrink: 0;
}

.detail-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 5px;
  color: var(--text-3);
  font-size: 13px;
}

.detail-empty .glyph {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
  margin-bottom: 6px;
  border-radius: 50%;
  background: var(--brand-weak);
  color: var(--brand);
}

.detail-empty .hint {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
}

/* 窄窗:列表与详情二选一 */
@media (max-width: 900px) {
  .layout {
    grid-template-columns: 1fr;
  }

  .layout.narrow .side {
    display: none;
  }

  .layout:not(.narrow) .detail {
    display: none;
  }
}

/* 再窄:收紧 view-head,隐藏次要操作 */
@media (max-width: 760px) {
  .head-lib-tag,
  .head-ver,
  .head-task,
  .head-acts {
    display: none;
  }
}
</style>
