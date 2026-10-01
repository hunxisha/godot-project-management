<script setup lang="ts">
// 一键导出对话框:列出项目 export_presets.cfg 里的预设,选择后调用引擎 headless 导出。
// 导出前预检导出模板(缺模板给出一键获取入口);导出中展示引擎输出尾行,可取消;
// 支持一次导出全部预设(串行走导出队列);展示本项目的导出历史(产物大小/打开目录)。
import { computed, ref, watch } from 'vue'
import Icon from '../Icon.vue'
import { showInFolder } from '../../services/bridge'
import { fmtSize, formatRelative } from '../../utils/format'
import { useExport } from '../../composables/useExport'
import type { ExportHistoryEntry, ExportPreset, GodotProject } from '../../types/godot'

const props = defineProps<{
  open: boolean
  project: (GodotProject & { _id: string }) | null
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

const ex = useExport()

const presets = ref<ExportPreset[]>([])
const loading = ref(false)
const loadError = ref('')
const selected = ref('')
/** 模板缺失标记(runExport 的预检结果) */
const missingTemplates = ref(false)
const templateHint = ref('')
/** 导出历史(本项目) */
const history = ref<ExportHistoryEntry[]>([])

const task = computed(() => (props.project ? ex.taskFor(props.project._id) : undefined))

async function load() {
  if (!props.project) return
  loading.value = true
  loadError.value = ''
  presets.value = []
  selected.value = ''
  missingTemplates.value = false
  templateHint.value = ''
  loadHistory()
  try {
    const r = await window.services.listExportPresets(props.project._id)
    if (!r.ok) {
      loadError.value = r.error || '读取导出预设失败'
    } else {
      presets.value = r.presets || []
      if (!presets.value.length) loadError.value = '该项目还没有 export_presets.cfg(在编辑器里添加一次导出预设后即可使用)'
    }
  } finally {
    loading.value = false
  }
}

async function loadHistory() {
  if (!props.project) return
  history.value = (await window.services.listExportHistory(props.project._id)).slice(0, 8)
}

watch(
  () => props.open,
  (open) => {
    if (open) load()
  }
)

// 本项目导出完成后刷新历史(任务由 App 全局订阅清理,这里在清理前就能看到 done)
watch(
  () => ex.tasks.value.map((t) => `${t.id}:${t.status}`).join('|'),
  () => {
    if (props.project && ex.tasks.value.some((t) => t.projectId === props.project!._id && t.status === 'done')) {
      loadHistory()
    }
  }
)

async function start() {
  if (!props.project || !selected.value || task.value) return
  missingTemplates.value = false
  const r = await ex.run(props.project._id, selected.value)
  if (r.ok) return
  if (r.missingTemplates) {
    missingTemplates.value = true
    return
  }
  loadError.value = r.error || '发起导出失败'
}

/** 可实际发起导出的预设(配置了 export_path 的) */
const runnablePresets = computed(() => presets.value.filter((p) => p.exportPath))

/** 一次导出全部预设(串行走导出队列;缺模板时第一个就会失败并给出提示) */
function exportAll() {
  if (!props.project || task.value) return
  missingTemplates.value = false
  for (const p of runnablePresets.value) {
    ex.run(props.project._id, p.name)
  }
}

const exportAllDisabled = computed(() => !runnablePresets.value.length || !!task.value || loading.value || !!loadError.value)

/** 缺模板时的一键获取:下载任务在全局任务栏可见,完成后重新点击导出即可 */
async function fetchTemplates() {
  if (!props.project?.versionId) return
  const r = await window.services.installExportTemplates(props.project.versionId)
  if (r.ok) {
    templateHint.value = '模板开始下载(进度见任务栏),完成后即可导出'
    missingTemplates.value = false
  } else {
    templateHint.value = r.error || '模板下载失败'
  }
}

/** 删除一条历史记录(产物文件不受影响) */
async function removeHistory(id: string) {
  await window.services.removeExportHistoryEntry(id)
  await loadHistory()
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="modal-mask" @click.self="emit('close')">
      <div class="card modal">
        <div class="modal-head">
          <div class="modal-title"><Icon name="upload" :size="15" /> 导出 · {{ project?.name }}</div>
          <span class="grow"></span>
          <button type="button" class="btn small ghost icon-x" title="关闭" @click="emit('close')">
            <Icon name="x" :size="14" />
          </button>
        </div>

        <div v-if="loading" class="hint-line"><span class="spin"></span> 读取导出预设…</div>

        <div v-else-if="loadError" class="ed-warn">
          <Icon name="alert" :size="14" />
          <span>{{ loadError }}</span>
        </div>

        <template v-else>
          <div class="ed-list">
            <button
              v-for="p in presets"
              :key="p.index"
              type="button"
              class="ed-row"
              :class="{ on: selected === p.name }"
              @click="selected = p.name"
            >
              <Icon name="upload" :size="13" />
              <span class="ed-name">{{ p.name }}</span>
              <span v-if="p.platform" class="tag">{{ p.platform }}</span>
              <span class="ed-path mono" :title="p.exportPath">{{ p.exportPath || '未配置导出路径' }}</span>
            </button>
          </div>

          <div v-if="missingTemplates" class="ed-warn">
            <Icon name="alert" :size="14" />
            <span class="grow">尚未安装该引擎版本的导出模板,headless 导出无法进行。</span>
            <button class="btn small primary" @click="fetchTemplates">
              <Icon name="download" :size="12" /> 获取模板
            </button>
          </div>
          <div v-if="templateHint" class="ed-hint">{{ templateHint }}</div>

          <!-- 导出进行中:输出尾行 + 取消 -->
          <div v-if="task" class="ed-running">
            <div class="ed-run-head">
              <span class="spin"></span>
              <span class="grow">正在导出「{{ task.presetName }}」…</span>
              <button class="btn small danger-text" @click="ex.cancel(task.id)">取消</button>
            </div>
            <pre v-if="task.log" class="ed-log mono">{{ task.log }}</pre>
          </div>
        </template>

        <div class="ed-foot">
          <button
            v-if="presets.length > 1"
            class="btn"
            :disabled="exportAllDisabled"
            title="按队列依次导出全部已配置路径的预设"
            @click="exportAll"
          ><Icon name="layers" :size="12" /> 导出全部</button>
          <span class="grow"></span>
          <button class="btn ghost" @click="emit('close')">关闭</button>
          <button
            class="btn primary"
            :disabled="!selected || !!task || loading || !!loadError || missingTemplates"
            @click="start"
          ><Icon name="upload" :size="12" /> 开始导出</button>
        </div>

        <!-- 导出历史(本项目,最近 8 条) -->
        <div v-if="history.length" class="ed-history">
          <div class="ed-hist-title">导出历史</div>
          <div v-for="h in history" :key="h.id" class="ed-hist-row">
            <Icon name="archive" :size="12" />
            <span class="ed-hist-main">
              <span class="ed-hist-name">{{ h.presetName }}</span>
              <span class="ed-hist-meta mono" :title="h.outputPath">{{ fmtSize(h.size) }} · {{ formatRelative(h.finishedAt) }}</span>
            </span>
            <button class="btn small ghost" title="打开产物所在目录" @click="showInFolder(h.outputPath)">
              <Icon name="folder" :size="12" />
            </button>
            <button class="btn small ghost danger-text" title="删除这条历史记录(不影响产物文件)" @click="removeHistory(h.id)">
              <Icon name="x" :size="12" />
            </button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.grow {
  flex: 1;
}

.hint-line {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  color: var(--text-3);
  padding: 12px 0;
}

.ed-list {
  display: flex;
  flex-direction: column;
  gap: 5px;
  max-height: 260px;
  overflow-y: auto;
}

.ed-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 11px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
  text-align: left;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}

.ed-row:hover {
  border-color: var(--border-strong);
}

.ed-row.on {
  border-color: var(--brand);
  background: var(--brand-weak);
}

.ed-row .icon {
  color: var(--text-3);
  flex-shrink: 0;
}

.ed-row.on .icon {
  color: var(--brand);
}

.ed-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}

.ed-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--text-3);
  text-align: right;
}

.ed-warn {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 9px;
  padding: 9px 11px;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--danger);
  border: 1px solid var(--danger);
  border-radius: var(--radius-sm);
  background: var(--danger-weak);
}

.ed-warn .icon {
  flex-shrink: 0;
}

.ed-hint {
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-3);
}

.ed-running {
  margin-top: 10px;
  padding: 9px 11px;
  border: 1px solid var(--brand);
  border-radius: var(--radius-sm);
  background: var(--brand-weak);
}

.ed-run-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
}

.ed-log {
  margin: 8px 0 0;
  padding: 7px 9px;
  max-height: 110px;
  overflow-y: auto;
  font-size: 10.5px;
  line-height: 1.5;
  color: var(--text-3);
  background: var(--surface);
  border-radius: var(--radius-sm);
  white-space: pre-wrap;
  word-break: break-all;
}

.ed-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-top: 12px;
  margin-top: 12px;
  border-top: 1px solid var(--border);
}

/* 导出历史 */
.ed-history {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px dashed var(--border);
}

.ed-hist-title {
  font-size: 11.5px;
  font-weight: 650;
  color: var(--text-3);
  margin-bottom: 6px;
}

.ed-hist-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 0;
  font-size: 12px;
}

.ed-hist-row .icon {
  color: var(--text-3);
  flex-shrink: 0;
}

.ed-hist-main {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

.ed-hist-name {
  font-weight: 600;
  color: var(--text-2);
}

.ed-hist-meta {
  font-size: 10.5px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
