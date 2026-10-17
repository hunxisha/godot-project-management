<script setup lang="ts">
/** Workbench 2.0 常驻状态栏(Godot 编辑器底部栏语汇):
 *  · 左侧任务区:空闲显示「就绪」;有任务时显示最前线任务摘要,点击展开任务中心抽屉
 *  · 右侧:命令面板入口提示
 *  · 全局任务订阅(引擎/模板下载、备份/恢复、一键导出、文档库)从 App 迁入,
 *    状态栏常驻挂载,切页不断线;完成通知与 dismiss 逻辑一并在此 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import Icon from './Icon.vue'
import { notify } from '../services/bridge'
import type { BackupTask, DocsTask, DownloadTask, ExportTask } from '../types/godot'

const emit = defineEmits<{ (e: 'navigate', tab: string): void, (e: 'command'): void }>()

const tasks = ref<DownloadTask[]>([])
const backupTasks = ref<BackupTask[]>([])
const exportTasks = ref<ExportTask[]>([])
const docsTasks = ref<DocsTask[]>([])
let unwatchTasks: (() => void) | null = null
let unwatchBackupTasks: (() => void) | null = null
let unwatchExportTasks: (() => void) | null = null
let unwatchDocsTasks: (() => void) | null = null

const TASK_STATUS: Record<string, string> = {
  queued: '排队中',
  downloading: '下载中',
  extracting: '解压中',
  verifying: '校验中',
  done: '完成',
  error: '失败',
  canceled: '已取消'
}

const BACKUP_PHASE: Record<string, string> = {
  scanning: '扫描中',
  packing: '打包中',
  copying: '复制中',
  finalizing: '收尾中',
  unpacking: '解压中',
  replacing: '替换原目录',
  registering: '注册项目'
}

const DOCS_PHASE: Record<string, string> = {
  queued: '排队中',
  dumping: '引擎导出中',
  translating: '翻译下载中',
  parsing: '解析中'
}

const BACKUP_TERMINAL: Record<string, true> = { done: true, error: true, canceled: true }

/** 任务中心条目:把四种来源的任务归一化后再渲染 */
interface CenterTask {
  id: string
  icon: string
  label: string
  brief: string
  error: boolean
  pct: number | null
  goto?: string
}

const centerTasks = computed<CenterTask[]>(() => {
  const out: CenterTask[] = []
  for (const t of tasks.value) {
    if (t.status === 'done' || t.status === 'canceled') continue
    const base = TASK_STATUS[t.status] || t.status
    const pct = t.totalSize ? Math.min(100, (t.received / t.totalSize) * 100) : null
    out.push({
      id: `dl-${t.id}`,
      icon: t.kind === 'templates' ? 'package' : 'download',
      label: t.tag,
      brief: base,
      error: t.status === 'error',
      pct,
      goto: t.kind === 'templates' ? 'marketplace' : 'versions'
    })
  }
  for (const t of backupTasks.value) {
    if (BACKUP_TERMINAL[t.phase]) continue
    const base = BACKUP_PHASE[t.phase] || t.phase
    out.push({
      id: `bk-${t.id}`,
      icon: 'archive',
      label: `${t.kind === 'restore' ? '恢复' : '备份'} · ${t.projectName}`,
      brief: base,
      error: t.phase === 'error',
      pct: t.total ? Math.min(100, (t.done / t.total) * 100) : null,
      goto: 'backups'
    })
  }
  for (const t of exportTasks.value) {
    if (t.status === 'done' || t.status === 'canceled') continue
    out.push({
      id: `exp-${t.id}`,
      icon: 'upload',
      label: `导出 · ${t.projectName}`,
      brief: t.status === 'exporting' ? (t.log.split('\n').pop() || '导出中') : '排队中',
      error: t.status === 'error',
      pct: null,
      goto: 'projects'
    })
  }
  for (const t of docsTasks.value) {
    if (t.status === 'done' || t.status === 'canceled') continue
    const base = t.status === 'parsing' && t.total
      ? `解析 ${Math.min(100, Math.round((t.done / t.total) * 100))}%`
      : DOCS_PHASE[t.status] || t.status
    out.push({
      id: `docs-${t.id}`,
      icon: 'book',
      label: `文档 · ${t.tag}`,
      brief: base,
      error: t.status === 'error',
      pct: null,
      goto: 'docs'
    })
  }
  return out
})

const activeCount = computed(() => centerTasks.value.length)
const hasError = computed(() => centerTasks.value.some((t) => t.error))

const topTask = computed(() => centerTasks.value[0] ?? null)

/** 任务中心抽屉 */
const drawerOpen = ref(false)

function toggleDrawer() {
  if (!activeCount.value && !drawerOpen.value) return
  drawerOpen.value = !drawerOpen.value
}

function goto(tab?: string) {
  if (tab) emit('navigate', tab)
  drawerOpen.value = false
}

onMounted(() => {
  // 任务完成通知与清理由状态栏常驻负责(不随页面切换丢失);
  // dismiss 放入微任务,避免在订阅回调内同步触发嵌套 emit 导致旧快照滞留
  const notified = new Set<string>()
  unwatchTasks = window.services.watchTasks((snap) => {
    tasks.value = snap
    const finished = snap.filter((t) => t.status === 'done' || t.status === 'canceled')
    if (!finished.length) return
    queueMicrotask(() => {
      for (const t of finished) {
        if (t.status === 'done' && !notified.has(t.id)) {
          notified.add(t.id)
          notify(t.kind === 'templates' ? `${t.tag} 导出模板安装完成` : `${t.version?.name ?? t.tag} 安装完成`)
        }
        window.services.dismissTask(t.id)
      }
    })
  })

  const notifiedBackup = new Set<string>()
  unwatchBackupTasks = window.services.watchBackupTasks((snap) => {
    backupTasks.value = snap
    const finished = snap.filter((t) => BACKUP_TERMINAL[t.phase])
    if (!finished.length) return
    queueMicrotask(() => {
      for (const t of finished) {
        if (t.phase === 'done' && !notifiedBackup.has(t.id)) {
          notifiedBackup.add(t.id)
          notify(t.kind === 'restore'
            ? `「${t.projectName}」恢复完成`
            : `「${t.projectName}」备份完成`)
        }
        window.services.dismissBackupTask(t.id)
      }
    })
  })

  const notifiedExport = new Set<string>()
  unwatchExportTasks = window.services.watchExportTasks((snap) => {
    exportTasks.value = snap
    const finished = snap.filter((t) => t.status === 'done' || t.status === 'canceled' || t.status === 'error')
    if (!finished.length) return
    queueMicrotask(() => {
      for (const t of finished) {
        if (!notifiedExport.has(t.id)) {
          notifiedExport.add(t.id)
          if (t.status === 'done') notify(`「${t.projectName}」导出完成:${t.outputPath}`)
          else if (t.status === 'error') notify(`「${t.projectName}」导出失败:${t.error || '未知原因'}`)
        }
        window.services.dismissExportTask(t.id)
      }
    })
  })

  const notifiedDocs = new Set<string>()
  unwatchDocsTasks = window.services.watchDocsTasks((snap) => {
    docsTasks.value = snap
    const finished = snap.filter((t) => t.status === 'done' || t.status === 'canceled' || t.status === 'error')
    if (!finished.length) return
    queueMicrotask(() => {
      for (const t of finished) {
        if (!notifiedDocs.has(t.id)) {
          notifiedDocs.add(t.id)
          if (t.status === 'done') notify(`${t.versionName} 文档库生成完成(${t.total} 类)`)
          else if (t.status === 'error') notify(`${t.versionName} 文档库生成失败:${t.error || '未知原因'}`)
        }
        window.services.dismissDocsTask(t.id)
      }
    })
  })
})

onBeforeUnmount(() => {
  if (unwatchTasks) unwatchTasks()
  if (unwatchBackupTasks) unwatchBackupTasks()
  if (unwatchExportTasks) unwatchExportTasks()
  if (unwatchDocsTasks) unwatchDocsTasks()
})
</script>

<template>
  <div class="statusbar">
    <!-- 任务中心抽屉:从状态栏向上展开 -->
    <Transition name="drawer">
      <div v-if="drawerOpen" class="task-drawer" role="dialog" aria-label="任务中心">
        <div class="td-head">
          <span class="td-title"><Icon name="inbox" :size="13" /> 任务中心</span>
          <span class="td-count">{{ activeCount ? `${activeCount} 个进行中` : '暂无进行中的任务' }}</span>
          <span class="grow"></span>
          <button class="td-x" title="收起" aria-label="收起任务中心" @click="drawerOpen = false">
            <Icon name="chevron-down" :size="13" />
          </button>
        </div>
        <div v-if="centerTasks.length" class="td-list">
          <button
            v-for="t in centerTasks"
            :key="t.id"
            class="td-item"
            :class="{ error: t.error }"
            :title="t.goto ? '点击查看详情' : ''"
            @click="goto(t.goto)"
          >
            <span class="td-icon"><Icon :name="t.icon" :size="13" /></span>
            <span class="td-main">
              <span class="td-label">{{ t.label }}</span>
              <span class="td-brief">{{ t.brief }}</span>
            </span>
            <span class="td-side">
              <span v-if="t.pct !== null" class="td-pct">{{ t.pct.toFixed(0) }}%</span>
              <Icon v-if="t.goto" name="chevron-right" :size="12" class="td-arrow" />
            </span>
          </button>
        </div>
        <div v-else class="td-empty">
          <Icon name="check" :size="14" />
          没有进行中的任务;引擎下载、备份恢复、导出与文档库生成都会在这里汇报进度
        </div>
      </div>
    </Transition>

    <!-- 左侧:任务区 -->
    <button class="zone tasks" :class="{ busy: activeCount > 0, error: hasError }" :title="activeCount ? '查看任务中心' : '任务中心'" @click="toggleDrawer">
      <span v-if="activeCount" class="spin"></span>
      <Icon v-else name="activity" :size="12" />
      <template v-if="activeCount">
        <span class="z-label mono">{{ topTask?.label }}</span>
        <span class="z-brief">{{ topTask?.brief }}{{ topTask?.pct !== null && topTask?.pct !== undefined ? ` ${topTask.pct.toFixed(0)}%` : '' }}</span>
        <span v-if="activeCount > 1" class="z-more">+{{ activeCount - 1 }}</span>
      </template>
      <template v-else>
        <span class="z-label">就绪</span>
      </template>
    </button>

    <span class="grow"></span>

    <!-- 右侧:命令面板快捷入口 -->
    <button class="zone" title="打开命令面板 (Ctrl+K)" @click="emit('command')">
      <Icon name="terminal" :size="11" />
      命令面板
      <span class="kbd k-px">Ctrl K</span>
    </button>
  </div>
</template>

<style scoped>
.statusbar {
  position: relative;
  display: flex;
  align-items: stretch;
  gap: 2px;
  height: 30px;
  padding: 0 8px;
  background: var(--chrome);
  border-top: 1px solid var(--chrome-border);
  flex-shrink: 0;
  z-index: 40;
}

.zone {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--chrome-text-2);
  font-size: 11.5px;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.14s, color 0.14s;
}

.zone:hover {
  background: var(--chrome-2);
  color: var(--chrome-text);
}

.zone.tasks {
  color: var(--chrome-text);
}

.zone.tasks.busy {
  color: var(--brand);
}

.zone.tasks.error {
  color: var(--danger);
}

.zone.tasks .spin {
  width: 11px;
  height: 11px;
  border-width: 1.5px;
  flex-shrink: 0;
}

.z-label {
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  font-weight: 600;
}

.z-brief {
  color: var(--chrome-text-2);
  font-weight: 500;
}

.zone.tasks.busy .z-brief {
  color: var(--brand);
}

.zone.tasks.error .z-brief {
  color: var(--danger);
}

.z-more {
  padding: 0 5px;
  border-radius: 999px;
  background: var(--brand-weak);
  color: var(--brand);
  font-size: 10px;
  font-weight: 700;
}

/* 状态栏内的迷你 kbd */
.k-px {
  padding: 0 5px;
  font-size: 9px;
  line-height: 14px;
  border-radius: 4px;
}

.zone .kbd {
  background: var(--chrome-2);
  border-color: var(--chrome-border);
  color: var(--chrome-text-2);
}

/* ---------- 任务中心抽屉 ---------- */

.task-drawer {
  position: absolute;
  right: 8px;
  bottom: calc(100% + 2px);
  width: 420px;
  max-width: calc(100vw - 60px);
  max-height: 380px;
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-overlay);
  overflow: hidden;
}

.td-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--panel-head);
}

.td-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 700;
  color: var(--text);
}

.td-title .icon {
  color: var(--brand);
}

.td-count {
  font-size: 11px;
  color: var(--text-3);
}

.td-x {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
}

.td-x:hover {
  background: var(--surface-2);
  color: var(--text);
}

.td-list {
  overflow-y: auto;
  padding: 6px;
}

.td-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  border: none;
  border-radius: 8px;
  background: transparent;
  text-align: left;
  cursor: pointer;
  transition: background 0.13s;
}

.td-item:hover {
  background: var(--surface-2);
}

.td-item.error .td-brief {
  color: var(--danger);
}

.td-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 7px;
  background: var(--brand-weak);
  color: var(--brand);
  flex-shrink: 0;
}

.td-item.error .td-icon {
  background: var(--danger-weak);
  color: var(--danger);
}

.td-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.td-label {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.td-brief {
  font-size: 11.5px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.td-side {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.td-pct {
  font-size: 11px;
  font-weight: 700;
  color: var(--brand);
  font-variant-numeric: tabular-nums;
}

.td-arrow {
  color: var(--text-3);
}

.td-empty {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 18px 14px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-3);
}

.td-empty .icon {
  color: var(--ok);
  flex-shrink: 0;
}

/* 抽屉滑入/滑出 */
.drawer-enter-active,
.drawer-leave-active {
  transition: opacity 0.16s ease, transform 0.16s ease;
}

.drawer-enter-from,
.drawer-leave-to {
  opacity: 0;
  transform: translateY(8px);
}

@media (prefers-reduced-motion: reduce) {
  .drawer-enter-active,
  .drawer-leave-active {
    transition: none;
  }
}
</style>
