<script setup lang="ts">
// 一键导出对话框:列出项目 export_presets.cfg 里的预设,选择后调用引擎 headless 导出。
// 导出前预检导出模板(缺模板给出一键获取入口);导出中展示引擎输出尾行,可取消。
import { computed, ref, watch } from 'vue'
import Icon from '../Icon.vue'
import { useExport } from '../../composables/useExport'
import type { ExportPreset, GodotProject } from '../../types/godot'

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

const task = computed(() => (props.project ? ex.taskFor(props.project._id) : undefined))

async function load() {
  if (!props.project) return
  loading.value = true
  loadError.value = ''
  presets.value = []
  selected.value = ''
  missingTemplates.value = false
  templateHint.value = ''
  try {
    const r = window.services.listExportPresets(props.project._id)
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

watch(
  () => props.open,
  (open) => {
    if (open) load()
  }
)

function start() {
  if (!props.project || !selected.value || task.value) return
  missingTemplates.value = false
  const r = ex.run(props.project._id, selected.value)
  if (r.ok) return
  if (r.missingTemplates) {
    missingTemplates.value = true
    return
  }
  loadError.value = r.error || '发起导出失败'
}

/** 缺模板时的一键获取:下载任务在全局任务栏可见,完成后重新点击导出即可 */
function fetchTemplates() {
  if (!props.project?.versionId) return
  const r = window.services.installExportTemplates(props.project.versionId)
  if (r.ok) {
    templateHint.value = '模板开始下载(进度见任务栏),完成后即可导出'
    missingTemplates.value = false
  } else {
    templateHint.value = r.error || '模板下载失败'
  }
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
          <span class="grow"></span>
          <button class="btn ghost" @click="emit('close')">关闭</button>
          <button
            class="btn primary"
            :disabled="!selected || !!task || loading || !!loadError || missingTemplates"
            @click="start"
          ><Icon name="upload" :size="12" /> 开始导出</button>
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
</style>
