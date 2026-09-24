<script setup lang="ts">
// 新建备份对话框:项目 / 备注 / 方式 / 压缩级别 / 位置 / 高级排除 / 预估 / 进度 / 取消 / 结果。
// 由项目页行内按钮(锁定项目)与备份页「新建备份」(可选项目)共用。
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Icon from '../Icon.vue'
import { getSettings, notify, openPath, pickDirectory, saveSettings } from '../../services/bridge'
import { fmtDuration, fmtSize } from '../../utils/format'
import type { BackupTask, GodotProject } from '../../types/godot'

type ProjectRow = GodotProject & { _id: string }

const props = withDefaults(defineProps<{
  open: boolean
  /** 锁定的项目(从项目页进入);为空时允许在对话框内选择 */
  projectId?: string | null
  projects?: ProjectRow[]
}>(), {
  projectId: null,
  projects: () => []
})

const emit = defineEmits<{ (e: 'close'): void, (e: 'done'): void }>()

const PHASE_LABEL: Record<string, string> = {
  scanning: '扫描文件',
  packing: '压缩打包',
  copying: '复制快照',
  finalizing: '收尾'
}

const targetId = ref('')
const label = ref('')
const mode = ref<'zip' | 'copy'>('zip')
const level = ref<1 | 6 | 9>(6)
const destDir = ref('')
const includeCache = ref(false)
const excludeGit = ref(false)
const excludeBuild = ref(false)
const makeDefault = ref(false)

const advancedOpen = ref(false)
const running = ref(false)
const progress = ref<{ phase: string, done: number, total: number, current: string } | null>(null)
const result = ref<{ ok: boolean, canceled?: boolean, error?: string, size?: number, fileCount?: number, durationMs?: number, destPath?: string } | null>(null)

const estimate = ref<{ fileCount: number, bytes: number } | null>(null)
const estimating = ref(false)
const estimateError = ref('')

// ---------- 任务订阅(取消) ----------
const tasks = ref<BackupTask[]>([])
let unwatch: (() => void) | null = null

function startWatching() {
  if (unwatch) return
  unwatch = window.services.watchBackupTasks((snap) => { tasks.value = snap })
}

function stopWatching() {
  if (unwatch) {
    unwatch()
    unwatch = null
  }
  tasks.value = []
}

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeyDown)
  stopWatching()
})

function onKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape' && props.open) close()
}

onMounted(() => window.addEventListener('keydown', onKeyDown))

const activeTask = computed(() => tasks.value.find((t) => t.kind === 'backup'))
const canCancel = computed(() => !result.value && !!activeTask.value && activeTask.value.cancelable !== false)

const locked = computed(() => !!props.projectId)
const targetProject = computed(() => props.projects.find((p) => p._id === targetId.value) || null)

const excludeList = computed(() => {
  const list: string[] = []
  if (excludeGit.value) list.push('.git')
  if (excludeBuild.value) list.push('build', 'export')
  return list
})

const phrase = computed(() =>
  progress.value ? PHASE_LABEL[progress.value.phase] || progress.value.phase : '准备中'
)
const percent = computed(() => {
  const p = progress.value
  if (!p || !p.total) return 0
  return Math.min(100, Math.round((p.done / p.total) * 100))
})

const canStart = computed(() =>
  !running.value && !!targetId.value && !!destDir.value.trim() && !!targetProject.value
)

const levelHint = computed(() => {
  if (mode.value !== 'zip') return ''
  if (level.value === 1) return '最快,体积最大。适合临时快照。'
  if (level.value === 9) return '体积最小,耗时最长。适合长期归档。'
  return '速度与体积平衡,推荐。'
})

// ---------- 预估 ----------

let estimateSeq = 0

async function runEstimate() {
  const id = targetId.value
  if (!id) {
    estimate.value = null
    return
  }
  const seq = ++estimateSeq
  estimating.value = true
  estimateError.value = ''
  try {
    const r = await window.services.estimateBackup(id, {
      includeCache: includeCache.value,
      exclude: excludeList.value
    })
    if (seq !== estimateSeq) return
    estimate.value = r
  } catch (e: any) {
    if (seq !== estimateSeq) return
    estimate.value = null
    estimateError.value = e?.message || '无法预估'
  } finally {
    if (seq === estimateSeq) estimating.value = false
  }
}

watch(
  () => props.open,
  (open) => {
    if (!open) {
      stopWatching()
      return
    }
    // 每次打开都重新读取设置,避免用到组件挂载时的过期快照
    const settings = getSettings()
    targetId.value = props.projectId || props.projects[0]?._id || ''
    label.value = ''
    mode.value = settings.backupMode === 'copy' ? 'copy' : 'zip'
    level.value = settings.backupLevel === 1 || settings.backupLevel === 9 ? settings.backupLevel : 6
    includeCache.value = !!settings.backupIncludeCache
    const preset = settings.backupExclude || []
    excludeGit.value = preset.includes('.git')
    excludeBuild.value = preset.includes('build') || preset.includes('export')
    destDir.value = settings.backupRoot || ''
    makeDefault.value = false
    advancedOpen.value = false
    running.value = false
    progress.value = null
    result.value = null
    estimate.value = null
    estimateError.value = ''
    runEstimate()
    if (!destDir.value) chooseDir()
  }
)

// 影响预估的选项变化后重新估算(防抖到下一次微任务批次)
let estimateTimer: ReturnType<typeof setTimeout> | null = null
watch([targetId, includeCache, excludeGit, excludeBuild], () => {
  if (!props.open) return
  if (estimateTimer) clearTimeout(estimateTimer)
  estimateTimer = setTimeout(runEstimate, 180)
})

function chooseDir() {
  const d = pickDirectory('选择备份保存位置', destDir.value || getSettings().backupRoot)
  if (d) destDir.value = d
}

// ---------- 执行 ----------

async function start() {
  const p = targetProject.value
  if (!p || !canStart.value) return
  running.value = true
  result.value = null
  progress.value = { phase: 'scanning', done: 0, total: 0, current: '' }
  startWatching()
  try {
    const rec = await window.services.backupProject(
      p._id,
      {
        mode: mode.value,
        destDir: destDir.value.trim(),
        includeCache: includeCache.value,
        level: level.value,
        label: label.value.trim() || undefined,
        exclude: excludeList.value
      },
      (pr) => {
        progress.value = { phase: pr.phase, done: pr.done, total: pr.total, current: pr.current }
      }
    )
    if (makeDefault.value) saveSettings({ backupRoot: destDir.value.trim() })
    result.value = {
      ok: true,
      size: rec.size,
      fileCount: rec.fileCount,
      durationMs: rec.durationMs,
      destPath: rec.destPath
    }
    notify(`备份完成:${rec.projectName} · ${fmtSize(rec.size)} / ${rec.fileCount} 个文件`)
    emit('done')
  } catch (e: any) {
    if (e?.canceled) result.value = { ok: false, canceled: true }
    else result.value = { ok: false, error: e?.message || '备份失败' }
  } finally {
    running.value = false
    stopWatching()
  }
}

function cancel() {
  const t = activeTask.value
  if (!t) return
  if (!window.services.cancelBackupTask(t.id)) notify('该阶段无法取消')
}

function reveal() {
  if (result.value?.destPath) openPath(result.value.destPath)
}

function close() {
  if (running.value) return
  emit('close')
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="modal-mask" @click.self="close">
      <div class="card modal">
        <div class="modal-head">
          <div class="modal-title"><Icon name="box" :size="15" /> 新建备份</div>
          <span class="grow"></span>
          <button type="button" class="btn small ghost icon-x" title="关闭" :disabled="running" @click="close">
            <Icon name="x" :size="14" />
          </button>
        </div>

        <!-- 项目 -->
        <div class="field">
          <label class="f-label" for="bc-proj">项目</label>
          <select id="bc-proj" v-model="targetId" class="select" :disabled="locked || running">
            <option v-for="p in projects" :key="p._id" :value="p._id">{{ p.name }}</option>
          </select>
          <div v-if="targetProject" class="f-hint mono" :title="targetProject.path">
            {{ targetProject.path }}
          </div>
        </div>

        <!-- 备注名 -->
        <div class="field">
          <label class="f-label" for="bc-label">备注名(可选)</label>
          <input
            id="bc-label"
            v-model="label"
            class="input"
            maxlength="80"
            :placeholder="targetProject ? `${targetProject.name} · 自动时间` : '如:发布前 / v1.0 通过审核'"
            autocomplete="off"
            spellcheck="false"
            :disabled="running"
          />
          <div class="f-hint wrap">留空则用「项目名 + 时间」命名;填写后同时作为备份文件名前缀。</div>
        </div>

        <!-- 方式 -->
        <div class="field">
          <span class="f-label">备份方式</span>
          <div class="bc-modes">
            <button
              type="button"
              class="bc-mode"
              :class="{ on: mode === 'zip' }"
              :disabled="running"
              @click="mode = 'zip'"
            >
              <Icon name="box" :size="15" />
              <span class="bc-mode-title">zip 打包</span>
              <span class="bc-mode-desc">压缩为单个文件,便于归档与传输。</span>
            </button>
            <button
              type="button"
              class="bc-mode"
              :class="{ on: mode === 'copy' }"
              :disabled="running"
              @click="mode = 'copy'"
            >
              <Icon name="layers" :size="15" />
              <span class="bc-mode-title">完整快照</span>
              <span class="bc-mode-desc">复制为目录,不用解压即可用 Godot 打开。</span>
            </button>
          </div>
        </div>

        <!-- 压缩级别 -->
        <div v-if="mode === 'zip'" class="field">
          <span class="f-label">压缩级别</span>
          <div class="seg">
            <button :class="{ on: level === 1 }" :disabled="running" @click="level = 1">快速</button>
            <button :class="{ on: level === 6 }" :disabled="running" @click="level = 6">标准</button>
            <button :class="{ on: level === 9 }" :disabled="running" @click="level = 9">最大</button>
          </div>
          <div class="f-hint wrap">{{ levelHint }}</div>
        </div>

        <!-- 位置 -->
        <div class="field">
          <label class="f-label" for="bc-dir">保存位置</label>
          <div class="dir-row">
            <input
              id="bc-dir"
              v-model="destDir"
              class="input mono"
              placeholder="选择备份保存位置"
              autocomplete="off"
              spellcheck="false"
              :disabled="running"
            />
            <button type="button" class="btn ghost" :disabled="running" @click="chooseDir">
              <Icon name="folder" :size="14" /> 浏览
            </button>
          </div>
          <label class="open-row bc-inline-check">
            <input v-model="makeDefault" type="checkbox" class="chk" :disabled="running" />
            <span>设为默认备份目录</span>
          </label>
        </div>

        <!-- 预估 -->
        <div class="bc-estimate">
          <Icon name="hard-drive" :size="13" />
          <template v-if="estimating"><span class="spin"></span> 正在估算…</template>
          <template v-else-if="estimateError"><span class="bc-err">{{ estimateError }}</span></template>
          <template v-else-if="estimate">
            约 <b>{{ fmtSize(estimate.bytes) }}</b> · <b>{{ estimate.fileCount }}</b> 个文件
            <span class="bc-dim">{{ includeCache ? '(含 .godot 缓存)' : '(不含 .godot 缓存)' }}</span>
          </template>
          <template v-else><span class="bc-dim">选择项目后自动估算</span></template>
        </div>

        <!-- 高级 -->
        <div class="field bc-advanced">
          <button type="button" class="bc-adv-toggle" :disabled="running" @click="advancedOpen = !advancedOpen">
            <Icon :name="advancedOpen ? 'chevron-down' : 'chevron-right'" :size="12" />
            高级选项
          </button>
          <div v-if="advancedOpen" class="bc-adv-body">
            <label class="open-row bc-inline-check">
              <input v-model="includeCache" type="checkbox" class="chk" :disabled="running" />
              <span>包含 <code>.godot</code> 编辑器缓存(默认排除,体积更小且可再生成)</span>
            </label>
            <label class="open-row bc-inline-check">
              <input v-model="excludeGit" type="checkbox" class="chk" :disabled="running" />
              <span>排除 <code>.git</code> 目录</span>
            </label>
            <label class="open-row bc-inline-check">
              <input v-model="excludeBuild" type="checkbox" class="chk" :disabled="running" />
              <span>排除 <code>build/</code> 与 <code>export/</code> 产物目录</span>
            </label>
            <div class="f-hint wrap">默认不排除任何内容,保证备份保真。排除项按目录名匹配,记入备份记录。</div>
          </div>
        </div>

        <!-- 进度 -->
        <div v-if="running" class="bc-progress">
          <div class="bc-phase">
            <span class="spin"></span>
            <b>{{ phrase }}</b>
            <span class="grow"></span>
            <span v-if="progress?.total" class="bc-count">{{ progress.done }} / {{ progress.total }}</span>
          </div>
          <div class="bar" :class="{ indet: !progress?.total }">
            <div class="fill active" :style="{ width: (progress?.total ? percent : 30) + '%' }"></div>
          </div>
          <div v-if="progress?.current" class="bc-current mono" :title="progress.current">{{ progress.current }}</div>
        </div>

        <!-- 结果 -->
        <div v-if="result && !running" class="bc-result" :class="result.ok ? 'ok' : result.canceled ? 'warn' : 'err'">
          <Icon :name="result.ok ? 'check' : result.canceled ? 'x' : 'alert'" :size="15" />
          <div class="bc-result-body">
            <div class="bc-result-title">
              {{ result.ok ? '备份完成' : result.canceled ? '已取消' : '备份失败' }}
            </div>
            <div class="bc-result-desc">
              <template v-if="result.ok">
                {{ fmtSize(result.size) }} · {{ result.fileCount }} 个文件
                <template v-if="result.durationMs"> · 耗时 {{ fmtDuration(result.durationMs) }}</template>
                <div class="mono bc-result-path" :title="result.destPath">{{ result.destPath }}</div>
              </template>
              <template v-else-if="result.canceled">已取消,未产生任何文件或记录。</template>
              <template v-else>{{ result.error }}</template>
            </div>
          </div>
        </div>

        <div class="modal-foot">
          <span class="grow"></span>
          <template v-if="running">
            <button type="button" class="btn ghost" :disabled="!canCancel" @click="cancel">取消备份</button>
          </template>
          <template v-else>
            <button type="button" class="btn ghost" @click="close">
              {{ result ? '关闭' : '取消' }}
            </button>
            <button v-if="result?.ok" type="button" class="btn" @click="reveal">
              <Icon name="external" :size="13" /> 打开所在位置
            </button>
            <button v-else type="button" class="btn primary" :disabled="!canStart" @click="start">
              <Icon name="box" :size="13" /> 开始备份
            </button>
          </template>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.bc-modes {
  display: flex;
  gap: 8px;
}

.bc-mode {
  flex: 1;
  display: grid;
  grid-template-columns: 20px 1fr;
  grid-template-rows: auto auto;
  gap: 2px 7px;
  align-items: center;
  text-align: left;
  padding: 9px 11px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}

.bc-mode:hover:not(:disabled) {
  border-color: var(--brand);
}

.bc-mode.on {
  border-color: var(--brand);
  background: var(--brand-weak);
}

.bc-mode:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.bc-mode .icon {
  grid-row: span 2;
  color: var(--brand);
}

.bc-mode-title {
  font-size: 13px;
  font-weight: 650;
  color: var(--text);
}

.bc-mode-desc {
  grid-column: 2;
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-3);
}

.bc-inline-check {
  margin: 6px 0 0;
  font-size: 12px;
}

.bc-estimate {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 8px 11px;
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  border: 1px solid var(--border);
  font-size: 12px;
  color: var(--text-2);
  margin-bottom: 12px;
}

.bc-dim {
  color: var(--text-3);
}

.bc-err {
  color: var(--danger);
}

.bc-advanced {
  margin-bottom: 12px;
}

.bc-adv-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: none;
  background: transparent;
  padding: 0;
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
  cursor: pointer;
}

.bc-adv-toggle:hover {
  color: var(--brand);
}

.bc-adv-body {
  margin-top: 8px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
}

.bc-progress {
  margin-bottom: 10px;
}

.bc-phase {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  color: var(--brand);
  margin-bottom: 8px;
}

.bc-count {
  font-size: 11.5px;
  color: var(--text-3);
}

.bc-current {
  margin-top: 6px;
  font-size: 10.5px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bc-result {
  display: flex;
  gap: 10px;
  padding: 11px 13px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  margin-bottom: 4px;
}

.bc-result.ok {
  border-color: var(--ok);
  background: var(--ok-weak);
  color: var(--ok);
}

.bc-result.warn {
  border-color: var(--warn);
  background: var(--warn-weak);
  color: var(--warn);
}

.bc-result.err {
  border-color: var(--danger);
  background: var(--danger-weak);
  color: var(--danger);
}

.bc-result-body {
  min-width: 0;
}

.bc-result-title {
  font-size: 13px;
  font-weight: 650;
  margin-bottom: 3px;
}

.bc-result-desc {
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-2);
}

.bc-result-path {
  font-size: 10.5px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
