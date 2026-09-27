<!-- 文档页:引擎类参考浏览。无可用文档库时引导生成;有库时左列表右详情。
     生成任务进度在本页以卡片展示(全局任务栏由 App 负责)。 -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Icon from '../components/Icon.vue'
import DocClassPanel from '../components/docs/DocClassPanel.vue'
import { useDocs } from '../composables/useDocs'
import { notify } from '../services/bridge'
import type { DocsTask } from '../types/godot'

const props = defineProps<{
  /** 来自全局搜索命中的跳转目标,消费后回调 */
  pendingTarget?: { className: string, anchor?: string } | null
}>()
const emit = defineEmits<{
  (e: 'consumed'): void
}>()

const {
  versions, statuses, currentVersionId, currentStatus, readyVersions, classes,
  favorites, history, init, selectVersion, generate, removeLibrary, afterTaskSettled
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

/** 侧栏列表:收藏置顶 + 过滤后的字母序 */
const filtered = computed(() => {
  const kw = filter.value.trim().toLowerCase()
  const list = kw
    ? classes.value.filter((c) => c.name.toLowerCase().includes(kw))
    : classes.value
  return [...list].sort((a, b) => a.name.localeCompare(b.name))
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
  selected.value = name
  anchor.value = null
  if (window.innerWidth <= 900) showList.value = false
}

function onNavigate(cls: string, anchorName?: string) {
  anchor.value = anchorName ?? null
  if (cls === selected.value && anchorName) {
    // 同类跳转:通过 anchorKey 变化让面板重新定位
    anchorKey.value++
  } else {
    selected.value = cls
  }
  if (window.innerWidth <= 900) showList.value = false
}

const anchorKey = ref(0)

/** 管理面板里的取消(模板不能直接访问 window) */
function cancelTask(id: string) {
  window.services.docsCancelTask(id)
}

/** 发起生成:preload 拒绝入队的原因(版本缺失/在途)必须浮出来,不能静默 */
function onGenerate(id: string) {
  const r = generate(id)
  if (!r.ok) notify(r.error || '无法发起生成')
}

function applyPending() {
  const t = props.pendingTarget
  if (!t) return
  anchor.value = t.anchor ?? null
  anchorKey.value++
  selected.value = t.className
  if (window.innerWidth <= 900) showList.value = false
  emit('consumed')
}

watch(() => props.pendingTarget, (v, old) => {
  if (v && v !== old) applyPending()
})

/** 状态徽标文案 */
function statusText(id: string): string {
  const s = statuses.value[id]
  if (!s) return '未生成'
  if (s.status === 'ready') return `${s.classCount} 类${s.lang === 'en' ? ' · 英文' : ' · 中文'}`
  return '生成中…'
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
        <div v-if="!versions.length" class="boot-empty">还没有已安装的引擎 —— 先到「版本」页安装一个 Godot。</div>
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
          <button class="icon-btn" title="管理文档库" @click="managing = !managing">
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
            <button v-if="!activeTaskByVersion[v._id]" class="mini-btn" title="生成/重新生成" @click="onGenerate(v._id)">
              <Icon name="refresh" :size="12" />
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
            <span v-if="c.inherits" class="cls-inherits mono">{{ c.inherits }}</span>
          </button>
          <div v-if="!filtered.length" class="list-empty">没有匹配「{{ filter }}」的类</div>
        </div>
      </aside>

      <section class="detail">
        <button class="btn-back" @click="showList = true">
          <Icon name="chevron-left" :size="13" /> 类列表
        </button>
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

  .btn-back {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin: 10px 14px 0;
    padding: 5px 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
    color: var(--text-2);
    font-size: 12px;
    cursor: pointer;
    align-self: flex-start;
  }
}
</style>
