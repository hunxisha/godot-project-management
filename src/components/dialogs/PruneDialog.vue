<script setup lang="ts">
// 清理备份:按保留策略**先预览后执行**。
// 策略在这里就地设置(可保存为默认),避免设置页出现「改了却什么都不发生」的无效项。
import { computed, ref, watch } from 'vue'
import Icon from '../Icon.vue'
import { getSettings, notify, saveSettings } from '../../services/bridge'
import { fmtSize } from '../../utils/format'
import type { BackupRecord } from '../../types/godot'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ (e: 'close'): void, (e: 'done'): void }>()

type Mode = 'none' | 'keep' | 'days'

const mode = ref<Mode>('keep')
const keepN = ref(5)
const days = ref(30)
const saveDefault = ref(false)
const checked = ref(false)
const loading = ref(false)
const running = ref(false)
const preview = ref<{ targets: BackupRecord[], totalSize: number }>({ targets: [], totalSize: 0 })
const removed = ref<number | null>(null)

const active = computed(() => mode.value !== 'none')

const canRun = computed(
  () => active.value && preview.value.targets.length > 0 && checked.value && !running.value
)

function opts(dryRun: boolean) {
  return {
    keepPerProject: mode.value === 'keep' ? Math.max(0, Math.floor(keepN.value) || 0) : undefined,
    olderThanDays: mode.value === 'days' ? Math.max(1, Math.floor(days.value) || 1) : undefined,
    dryRun
  }
}

async function runPreview() {
  if (!props.open) return
  loading.value = true
  try {
    const r = await window.services.pruneBackups(opts(true))
    preview.value = { targets: r.targets || [], totalSize: r.totalSize || 0 }
  } catch (e) {
    preview.value = { targets: [], totalSize: 0 }
  } finally {
    loading.value = false
  }
}

let timer: ReturnType<typeof setTimeout> | null = null
function schedulePreview() {
  if (timer) clearTimeout(timer)
  timer = setTimeout(runPreview, 120)
}

watch(
  () => props.open,
  async (open) => {
    if (!open) return
    const s = await getSettings()
    const keep = s.backupKeepPerProject
    const day = s.backupKeepDays
    if (typeof keep === 'number' && keep > 0) {
      mode.value = 'keep'
      keepN.value = keep
    } else if (typeof day === 'number' && day > 0) {
      mode.value = 'days'
      days.value = day
    } else {
      mode.value = 'keep'
      keepN.value = 5
      days.value = 30
    }
    saveDefault.value = false
    checked.value = false
    running.value = false
    removed.value = null
    runPreview()
  }
)

watch([mode, keepN, days], schedulePreview)

const details = computed(() =>
  preview.value.targets.slice(0, 200).map((r) => {
    const name = r.label ? `${r.projectName} · ${r.label}` : r.projectName
    return `${name} — ${fmtSize(r.size)} — ${r.destPath}`
  })
)

async function execute() {
  if (!canRun.value) return
  running.value = true
  try {
    if (saveDefault.value) {
      await saveSettings({
        backupKeepPerProject: mode.value === 'keep' ? Math.max(1, Math.floor(keepN.value) || 1) : undefined,
        backupKeepDays: mode.value === 'days' ? Math.max(1, Math.floor(days.value) || 1) : undefined
      })
    }
    const r = await window.services.pruneBackups(opts(false))
    removed.value = r.removed ?? 0
    const failed = r.failed?.length || 0
    notify(failed
      ? `已清理 ${removed.value} 份,${failed} 份失败`
      : `已清理 ${removed.value} 份备份(移入回收站)`)
    emit('done')
  } catch (e: any) {
    notify(e?.message || '清理失败')
  } finally {
    running.value = false
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="modal-mask" @click.self="!running && emit('close')">
      <div class="card modal lg">
        <div class="modal-head">
          <div class="modal-title"><Icon name="trash" :size="15" /> 清理备份</div>
          <span class="grow"></span>
          <button type="button" class="btn small ghost icon-x" title="关闭" :disabled="running" @click="emit('close')">
            <Icon name="x" :size="14" />
          </button>
        </div>

        <!-- 策略 -->
        <div class="field">
          <span class="f-label">保留策略</span>
          <div class="pr-modes">
            <button
              type="button"
              class="pr-mode"
              :class="{ on: mode === 'keep' }"
              :disabled="running"
              @click="mode = 'keep'"
            >
              <span class="pr-mode-title">每个项目保留最近 N 份</span>
              <input
                v-model.number="keepN"
                type="number"
                min="0"
                max="999"
                class="input pr-num"
                :disabled="mode !== 'keep' || running"
                @click.stop
              />
            </button>
            <button
              type="button"
              class="pr-mode"
              :class="{ on: mode === 'days' }"
              :disabled="running"
              @click="mode = 'days'"
            >
              <span class="pr-mode-title">删除早于 M 天的备份</span>
              <input
                v-model.number="days"
                type="number"
                min="1"
                max="3650"
                class="input pr-num"
                :disabled="mode !== 'days' || running"
                @click.stop
              />
            </button>
            <button type="button" class="pr-mode slim" :class="{ on: mode === 'none' }" :disabled="running" @click="mode = 'none'">
              <span class="pr-mode-title">不清理</span>
            </button>
          </div>
        </div>

        <!-- 预览 -->
        <div class="pr-preview" :class="{ none: !preview.targets.length }">
          <Icon name="alert" :size="13" />
          <template v-if="loading"><span class="spin"></span> 正在计算…</template>
          <template v-else-if="!active">已选择不清理,不会删除任何备份。</template>
          <template v-else-if="!preview.targets.length">按当前策略没有需要清理的备份。</template>
          <template v-else>
            将删除 <b>{{ preview.targets.length }}</b> 份备份,释放约 <b>{{ fmtSize(preview.totalSize) }}</b>
            <span class="pr-dim">(文件移入回收站,Windows 可恢复)</span>
          </template>
        </div>

        <div v-if="preview.targets.length" class="pr-list">
          <div v-for="(d, i) in details" :key="i" class="pr-item mono" :title="d">{{ d }}</div>
          <div v-if="preview.targets.length > details.length" class="pr-item pr-dim">
            另有 {{ preview.targets.length - details.length }} 份…
          </div>
        </div>

        <label v-if="preview.targets.length" class="open-row pr-check">
          <input v-model="checked" type="checkbox" class="chk" :disabled="running" />
          <span>我了解这些备份文件将被移除</span>
        </label>

        <label class="open-row pr-check">
          <input v-model="saveDefault" type="checkbox" class="chk" :disabled="running" />
          <span>把当前策略保存为默认(下次打开自动填入)</span>
        </label>

        <div class="modal-foot">
          <span class="grow"></span>
          <button type="button" class="btn ghost" :disabled="running" @click="emit('close')">
            {{ removed === null ? '取消' : '关闭' }}
          </button>
          <button type="button" class="btn del-confirm" :disabled="!canRun" @click="execute">
            <span v-if="running" class="spin"></span>
            {{ running ? '清理中…' : `清理 ${preview.targets.length || ''} 份` }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.pr-modes {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.pr-mode {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 9px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
  cursor: pointer;
  text-align: left;
  transition: border-color 0.15s, background 0.15s;
}

.pr-mode:hover:not(:disabled) {
  border-color: var(--brand);
}

.pr-mode.on {
  border-color: var(--brand);
  background: var(--brand-weak);
}

.pr-mode.slim {
  justify-content: center;
}

.pr-mode-title {
  flex: 1;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}

.pr-num {
  width: 78px;
  padding: 3px 8px;
  font-size: 12.5px;
  text-align: center;
}

.pr-preview {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 9px 12px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--danger);
  background: var(--danger-weak);
  color: var(--danger);
  font-size: 12.5px;
  margin: 12px 0 0;
}

.pr-preview.none {
  border-color: var(--border);
  background: var(--surface-2);
  color: var(--text-2);
}

.pr-dim {
  color: var(--text-3);
  font-size: 11.5px;
}

.pr-list {
  margin-top: 8px;
  max-height: 150px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  padding: 8px 10px;
}

.pr-item {
  font-size: 11px;
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pr-item + .pr-item {
  margin-top: 3px;
}

.pr-check {
  margin: 10px 0 0;
  align-items: flex-start;
  line-height: 1.6;
}

.pr-check .chk {
  margin-top: 2px;
}

.btn.del-confirm {
  background: var(--danger);
  border-color: transparent;
  color: #fff;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.15), var(--shadow-sm);
}

.btn.del-confirm:hover:not(:disabled) {
  filter: brightness(1.07);
  background: var(--danger);
  border-color: transparent;
  color: #fff;
}
</style>
