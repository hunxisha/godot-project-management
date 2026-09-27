<!-- 文档页:引擎类参考浏览。无可用文档库时引导生成;有库时左列表右详情。
     生成任务进度在本页以卡片展示(全局任务栏由 App 负责)。 -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Icon from '../components/Icon.vue'
import DocClassPanel from '../components/docs/DocClassPanel.vue'
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
function onGenerate(id: string, forceTranslation = false) {
  const r = generate(id, { forceTranslation })
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
function onImport() {
  const file = pickFile('选择 extension_api.json', ['json'])
  if (!file) return
  const r = importLibrary(file)
  if (!r.ok) {
    notify(r.error || '导入失败')
    return
  }
  notify('已开始导入,进度见任务栏')
}

/** 项目脚本扫描:列出项目让用户选一个 */
const projects = ref<(GodotProject & { _id: string })[]>([])
const scanProjectId = ref('')

function refreshProjects() {
  projects.value = (window.ztools.db.allDocs('godot/project/') || []) as unknown as (GodotProject & { _id: string })[]
  if (!scanProjectId.value || !projects.value.some((p) => p._id === scanProjectId.value)) {
    scanProjectId.value = projects.value[0]?._id ?? ''
  }
}

function onScanProject() {
  if (!scanProjectId.value) return
  const r = scanProject(scanProjectId.value)
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
  <div class="docs-view">
    <!-- 无可用库:引导生成 -->
    <div v-if="!readyVersions.length" class="bootstrap">
      <div class="boot-head">
        <Icon name="book" :size="26" />
        <h2>引擎文档库</h2>
        <p>从已安装的 Godot 引擎一键导出离线类参考(--dump-extension-api-with-docs),与引擎版本逐字节对应;自动套用官方简体中文翻译,未翻译条目保留英文。</p>
      </div>
      <div class="ver-cards">
        <div v-for="v in versions" :key="v._id" class="ver-card">
          <div class="vc-main">
            <span class="vc-name">{{ v.name }}</span>
            <span class="vc-sub mono">{{ v.tag }}</span>
          </div>
          <span class="vc-status" :class="{ ready: statuses[v._id]?.status === 'ready' }">{{ statusText(v._id) }}</span>
          <span v-if="coverageText(v._id)" class="vc-coverage" :title="`官方翻译未覆盖的条目保留英文原文`">{{ coverageText(v._id) }}</span>
          <button
            v-if="!activeTaskByVersion[v._id]"
            class="btn small"
            @click="onGenerate(v._id)"
          >
            <Icon name="download" :size="12" /> 生成
          </button>
          <span v-else class="vc-progress">
            <span class="bar"><span class="fill" :style="{ width: activeTaskByVersion[v._id].total ? `${Math.min(100, (activeTaskByVersion[v._id].done / activeTaskByVersion[v._id].total) * 100)}%` : '30%' }"></span></span>
            <span class="pct">{{ PHASE_TEXT[activeTaskByVersion[v._id].status] || activeTaskByVersion[v._id].status }}</span>
          </span>
        </div>
        <div v-if="!versions.length" class="boot-empty">
          <p>还没有已安装的引擎 —— 到「版本」页安装一个 Godot,或导入现成的 API 文件:</p>
          <button class="btn small" @click="onImport">
            <Icon name="upload" :size="12" /> 导入 extension_api.json
          </button>
        </div>
      </div>
      <div v-if="versions.length" class="boot-foot">
        <button class="btn small ghost" @click="onImport">
          <Icon name="upload" :size="12" /> 导入 API 文件建库
        </button>
        <span class="boot-hint">在任意机器执行 <code>godot --headless --dump-extension-api-with-docs</code> 得到该 JSON</span>
      </div>
    </div>

    <!-- 双栏浏览 -->
    <div v-else class="layout" :class="{ narrow: !showList }">
      <aside class="sidebar">
        <div class="side-top">
          <select
            class="ver-select"
            :value="currentVersionId"
            @change="selectVersion(($event.target as HTMLSelectElement).value)"
          >
            <option v-for="v in readyVersions" :key="v._id" :value="v._id">{{ v.name }}</option>
          </select>
          <button class="icon-btn" :title="managing ? '收起库管理' : '管理文档库(生成/删除/导入/对比)'" @click="managing = !managing; if (managing) refreshProjects()">
            <Icon name="gear" :size="14" />
          </button>
        </div>

        <div v-if="managing" class="manage">
          <div v-for="v in versions" :key="v._id" class="mg-row">
            <span class="mg-name mono">{{ v.tag }}</span>
            <span class="mg-status">{{ statusText(v._id) }}</span>
            <span class="grow"></span>
            <button v-if="statuses[v._id]?.status === 'ready' && !activeTaskByVersion[v._id]" class="mini-btn" title="删除文档库" @click="removeLibrary(v._id)">
              <Icon name="trash" :size="12" />
            </button>
            <button v-if="!activeTaskByVersion[v._id]" class="mini-btn" title="生成/重新生成" @click="onGenerate(v._id, forceTpl)">
              <Icon name="refresh" :size="12" />
            </button>
          </div>
          <label class="force-row">
            <input v-model="forceTpl" type="checkbox" class="switch">
            <span>重新生成时强制刷新中文翻译(忽略本地 po 缓存,重新下载约 10MB)</span>
          </label>
          <button class="btn small ghost import-btn" @click="onImport">
            <Icon name="upload" :size="12" /> 导入 API 文件建库
          </button>
          <button
            class="btn small ghost import-btn"
            :disabled="readyVersions.length < 2"
            :title="readyVersions.length < 2 ? '至少需要两个已生成的文档库' : '对比两个版本的 API 差异(升级前评估)'"
            @click="diffOpen = true"
          >
            <Icon name="layers" :size="12" /> 版本差异对比
          </button>
          <!-- 项目脚本扫描:把项目里带 class_name 的 .gd 解析成同类文档 -->
          <div v-if="projects.length" class="scan-row">
            <select v-model="scanProjectId" class="scan-select">
              <option v-for="p in projects" :key="p._id" :value="p._id">{{ p.name }}</option>
            </select>
            <button class="btn small ghost" title="扫描项目脚本(带 class_name 的 .gd)生成文档库" @click="onScanProject">
              <Icon name="pen" :size="12" /> 扫描项目脚本
            </button>
          </div>
          <div v-for="t in Object.values(activeTaskByVersion)" :key="t.id" class="mg-row">
            <span class="mg-name mono">{{ t.tag }}</span>
            <span class="mg-status">{{ PHASE_TEXT[t.status] || t.status }} {{ t.total ? `${t.done}/${t.total}` : '' }}</span>
            <span class="grow"></span>
            <button class="mini-btn" title="取消" @click="cancelTask(t.id)">
              <Icon name="x" :size="12" />
            </button>
          </div>
        </div>

        <div class="filter-row">
          <Icon name="search" :size="13" />
          <input v-model="filter" class="filter-input" placeholder="过滤类名…" spellcheck="false">
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
            class="cls-item dim"
            :class="{ active: h.name === selected }"
            @click="openClass(h.name)"
          >
            <Icon name="clock" :size="11" class="his-ico" />
            <span class="cls-name mono">{{ h.name }}</span>
          </button>

          <div class="list-group">全部 <span class="cnt">{{ filtered.length }}</span></div>
          <button
            v-for="c in filtered"
            :key="c.name"
            class="cls-item"
            :class="{ active: c.name === selected }"
            @click="openClass(c.name)"
          >
            <span class="cls-name mono">{{ c.name }}</span>
            <span v-if="memberMatchNames.has(c.name)" class="cls-member-hit" title="成员名匹配">成员</span>
            <span v-else-if="c.inherits" class="cls-inherits mono">{{ c.inherits }}</span>
          </button>
          <div v-if="!filtered.length" class="list-empty">没有匹配「{{ filter }}」的类</div>
        </div>
      </aside>

      <section class="detail">
        <!-- 返回条常驻:按钮上直接印 Alt+←,让快捷键一眼可见;无来路时禁用并说明原因。
             窄窗额外给「类列表」入口(宽窗左侧列表常驻,不需要) -->
        <div class="detail-bar">
          <button v-if="isNarrow" class="btn-back" @click="showList = true">
            <Icon name="chevron-left" :size="13" /> 类列表
          </button>
          <button
            class="btn-back"
            :disabled="!canGoBack"
            :title="canGoBack ? '返回上一个类' : '点击描述里的链接跳转后会记录来路,即可返回'"
            @click="goBack"
          >
            <Icon name="chevron-left" :size="13" />
            返回<span v-if="prevClassName" class="prev-name mono">{{ prevClassName }}</span>
            <span class="kbd">Alt+←</span>
          </button>
          <span class="grow"></span>
          <!-- 详情页快速切库:保持当前类名,缺失由 classMissing 提示兜底 -->
          <select
            v-if="readyVersions.length > 1"
            class="detail-ver mono"
            :value="currentVersionId"
            :title="`当前文档库:${currentStatus?.tag ?? ''}`"
            @change="selectVersion(($event.target as HTMLSelectElement).value)"
          >
            <option v-for="v in readyVersions" :key="v._id" :value="v._id">{{ v.tag }}</option>
          </select>
        </div>
        <div v-if="classMissing" class="missing-lib">
          <Icon name="alert" :size="16" />
          <span>「{{ selected }}」不在当前文档库({{ currentStatus?.tag }})中 —— 可能属于其他引擎版本。</span>
        </div>
        <DocClassPanel
          v-if="selected && currentVersionId"
          :key="`${currentVersionId}-${selected}-${anchorKey}`"
          :version-id="currentVersionId"
          :class-name="selected"
          :anchor="anchor"
          @navigate="onNavigate"
          @anchor-done="anchor = null"
        />
        <div v-else class="detail-empty">
          <Icon name="book" :size="24" />
          <p>从左侧选择一个类</p>
          <p class="hint">Ctrl+K 可在任意页面搜索类与方法</p>
        </div>
      </section>
    </div>

    <!-- 跨版本 API 差异对比 -->
    <DocDiffDialog
      :open="diffOpen"
      :libraries="diffLibs"
      :initial-a="currentVersionId"
      @close="diffOpen = false"
    />
  </div>
</template>

<style scoped>
.docs-view {
  height: 100%;
}

/* ---------- 引导生成 ---------- */
.bootstrap {
  max-width: 620px;
  margin: 0 auto;
  padding: 48px 20px;
}

.boot-head {
  text-align: center;
  color: var(--text-2);
}

.boot-head h2 {
  margin: 10px 0 6px;
  font-size: 17px;
  color: var(--text);
}

.boot-head p {
  margin: 0;
  font-size: 12.5px;
  color: var(--text-3);
}

.ver-cards {
  margin-top: 22px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.ver-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 11px 14px;
  border: 1px solid var(--border);
  border-radius: 11px;
  background: var(--surface);
}

.vc-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.vc-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}

.vc-sub {
  font-size: 11px;
  color: var(--text-3);
}

.vc-status {
  margin-left: auto;
  font-size: 11.5px;
  color: var(--text-3);
}

.vc-status.ready {
  color: var(--success, #4caf7d);
}

.vc-progress {
  display: flex;
  align-items: center;
  gap: 8px;
}

.bar {
  width: 110px;
  height: 5px;
  border-radius: 999px;
  background: var(--surface-2);
  overflow: hidden;
}

.fill {
  display: block;
  height: 100%;
  background: var(--brand);
  border-radius: 999px;
  transition: width 0.3s;
}

.pct {
  font-size: 11px;
  color: var(--brand);
  white-space: nowrap;
}

.boot-empty {
  padding: 18px;
  text-align: center;
  font-size: 12.5px;
  color: var(--text-3);
  border: 1px dashed var(--border);
  border-radius: 11px;
}

.boot-empty p {
  margin: 0 0 10px;
}

.boot-foot {
  margin-top: 16px;
  display: flex;
  align-items: center;
  gap: 9px;
  flex-wrap: wrap;
}

.boot-hint {
  font-size: 11.5px;
  color: var(--text-3);
}

.boot-hint code {
  padding: 1px 5px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--surface-2);
  font-family: var(--mono);
}

.import-btn {
  margin: 2px 0 6px;
}

.scan-row {
  display: flex;
  align-items: center;
  gap: 5px;
  margin: 2px 0 6px;
}

.scan-select {
  flex: 1;
  min-width: 0;
  padding: 4px 6px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--surface);
  color: var(--text);
  font-size: 11.5px;
}

/* ---------- 双栏 ---------- */
.layout {
  display: grid;
  grid-template-columns: 252px 1fr;
  height: 100%;
}

.sidebar {
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--surface);
}

.side-top {
  display: flex;
  gap: 6px;
  padding: 10px 10px 6px;
}

.ver-select {
  flex: 1;
  min-width: 0;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-2);
  color: var(--text);
  font-size: 12.5px;
}

.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--surface);
  color: var(--text-3);
  cursor: pointer;
}

.icon-btn.on {
  color: var(--brand);
}

.manage {
  padding: 4px 10px 8px;
  border-bottom: 1px solid var(--border);
}

.mg-row {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 5px 0;
  font-size: 11.5px;
}

.mg-name {
  color: var(--text-2);
}

.mg-status {
  color: var(--text-3);
}

.mini-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--text-3);
  cursor: pointer;
}

.mini-btn:hover {
  color: var(--danger, #e05252);
}

.filter-row {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 8px 10px;
  padding: 6px 9px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-2);
  color: var(--text-3);
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

.class-list {
  flex: 1;
  overflow-y: auto;
  padding: 0 6px 12px;
}

.list-group {
  padding: 10px 8px 4px;
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.05em;
  color: var(--text-3);
}

.list-group .cnt {
  font-weight: 500;
  color: var(--text-3);
  opacity: 0.8;
}

.cls-item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 5px 8px;
  border: none;
  border-radius: 7px;
  background: none;
  cursor: pointer;
  text-align: left;
}

.cls-item:hover {
  background: var(--surface-2);
}

.cls-item.active {
  background: color-mix(in srgb, var(--brand) 13%, transparent);
}

.cls-item.active .cls-name {
  color: var(--brand);
  font-weight: 600;
}

.cls-item.dim .cls-name {
  color: var(--text-3);
}

.fav-ico {
  color: var(--warning, #e8a33d);
  flex-shrink: 0;
}

.his-ico {
  color: var(--text-3);
  flex-shrink: 0;
}

.cls-name {
  font-size: 12.5px;
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cls-inherits {
  margin-left: auto;
  font-size: 10.5px;
  color: var(--text-3);
  opacity: 0.7;
  flex-shrink: 0;
}

.list-empty {
  padding: 14px 10px;
  font-size: 12px;
  color: var(--text-3);
  text-align: center;
}

/* ---------- 详情 ---------- */
.detail {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.detail :deep(.panel) {
  flex: 1;
}

.btn-back {
  display: none;
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

.detail-empty .hint {
  font-size: 11.5px;
  opacity: 0.8;
}

.btn-back {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text-2);
  font-size: 12px;
  cursor: pointer;
  flex-shrink: 0;
}

.btn-back:hover {
  color: var(--brand);
  border-color: color-mix(in srgb, var(--brand) 35%, transparent);
}

.btn-back:disabled {
  opacity: 0.5;
  cursor: default;
  color: var(--text-3);
  border-color: var(--border);
}

/* 返回条:有来路(或窄窗)时常驻,宽窄窗都要看得见 */
.detail-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 18px 0;
  flex-shrink: 0;
}

.prev-name {
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--brand);
}

.kbd {
  margin-left: 3px;
  padding: 1px 5px;
  font-size: 10px;
  color: var(--text-3);
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--surface-2);
}

.detail-ver {
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text-2);
  font-size: 11.5px;
  max-width: 160px;
}

.missing-lib {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 10px 18px 0;
  padding: 8px 12px;
  border: 1px solid color-mix(in srgb, var(--warn) 40%, transparent);
  border-radius: 8px;
  background: var(--warn-weak);
  color: var(--warn);
  font-size: 12.5px;
}

.vc-coverage {
  font-size: 10.5px;
  color: var(--text-3);
  white-space: nowrap;
}

.cls-member-hit {
  margin-left: auto;
  padding: 0 5px;
  font-size: 9.5px;
  font-weight: 600;
  color: var(--brand);
  border: 1px solid color-mix(in srgb, var(--brand) 35%, transparent);
  border-radius: 5px;
  flex-shrink: 0;
}

.force-row {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 6px 2px 8px;
  font-size: 11px;
  color: var(--text-3);
  cursor: pointer;
}

.force-row .switch {
  margin-top: 1px;
  flex-shrink: 0;
}

/* 窄窗:列表与详情二选一 */
@media (max-width: 900px) {
  .layout {
    grid-template-columns: 1fr;
  }

  .layout.narrow .sidebar {
    display: none;
  }

  .layout:not(.narrow) .detail {
    display: none;
  }
}
</style>
