<script setup lang="ts">
// 恢复向导:① 选择方式 → ② 确认影响 → ③ 执行。
// 覆盖原项目是破坏性操作,必须输入项目名确认;进入替换阶段后禁止取消。
import { computed, ref, watch } from 'vue'
import Icon from '../Icon.vue'
import { getDoc, notify, openPath, pickDirectory } from '../../services/bridge'
import { useTaskDialog } from '../../composables/useTaskDialog'
import { fmtSize, formatTime } from '../../utils/format'
import type { BackupRecord, GodotProject } from '../../types/godot'

type ProjectRow = GodotProject & { _id: string }

/** 恢复结果(由向导第三步渲染) */
type RestoreResult = {
  ok: boolean
  canceled?: boolean
  error?: string
  newProjectName?: string
  newProjectId?: string
}

const props = withDefaults(defineProps<{
  open: boolean
  record: BackupRecord | null
  project?: ProjectRow | null
  /** 项目记录已不存在:只能恢复为新项目 */
  orphan?: boolean
}>(), {
  project: null,
  orphan: false
})

const emit = defineEmits<{ (e: 'close'): void, (e: 'done'): void }>()

// 任务订阅 / 进度百分比 / 可取消判断 / 取消失败提示都走共享组合式函数
const {
  progress,
  result,
  running,
  activeTask,
  canCancel,
  phrase,
  percent,
  begin,
  end,
  report,
  cancel
} = useTaskDialog<RestoreResult>({
  kind: 'restore',
  initialPhase: 'unpacking',
  cancelFailedMessage: '已进入替换阶段,无法取消'
})

const step = ref<1 | 2 | 3>(1)
const mode = ref<'new' | 'overwrite'>('new')
const newName = ref('')
const destDir = ref('')
const typed = ref('')

/** 覆盖恢复的目标项目名(用于输入确认) */
const expectName = computed(() => props.project?.name || props.record?.projectName || '')
const typedOk = computed(() => !expectName.value || typed.value.trim() === expectName.value)

/** 目标路径预览 */
const targetPath = computed(() => {
  if (!props.record) return ''
  if (mode.value === 'overwrite') return props.project?.path || '(原项目路径未知)'
  const base = (destDir.value || '').replace(/[\\/]+$/, '')
  const name = newName.value.trim() || 'restored'
  return base ? `${base}\\${name}` : name
})

function stamp() {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`
}

function parentDir(p?: string) {
  if (!p) return ''
  const idx = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
  return idx > 0 ? p.slice(0, idx) : p
}

watch(
  () => props.open,
  (open) => {
    if (!open) {
      end()
      return
    }
    step.value = 1
    mode.value = 'new'
    newName.value = `${props.record?.projectName || 'project'}_restore_${stamp()}`
    destDir.value = props.project ? parentDir(props.project.path) : parentDir(props.record?.destPath)
    typed.value = ''
    running.value = false
    progress.value = null
    result.value = null
  }
)

function chooseDestDir() {
  const d = pickDirectory('选择恢复位置', destDir.value || undefined)
  if (d) destDir.value = d
}

function toStep2() {
  if (mode.value === 'new') {
    if (!newName.value.trim()) return notify('请填写新项目目录名')
    if (!destDir.value.trim()) return notify('请选择恢复位置')
  }
  step.value = 2
}

async function start() {
  const rec = props.record
  if (!rec || running.value) return
  if (mode.value === 'overwrite' && !typedOk.value) return

  begin()
  step.value = 3

  try {
    const r = await window.services.restoreBackup(
      rec._id,
      mode.value === 'new'
        ? { mode: 'new', destDir: destDir.value.trim(), newName: newName.value.trim() }
        : { mode: 'overwrite' },
      report
    )
    result.value = r
    if (r.ok) emit('done')
  } catch (e: any) {
    result.value = { ok: false, error: e?.message || '恢复失败' }
  } finally {
    end()
  }
}

function openTarget() {
  if (mode.value === 'overwrite') {
    if (props.project?.path) openPath(props.project.path)
    return
  }
  const id = result.value?.newProjectId
  if (!id) return
  const p = getDoc<GodotProject>(id)
  if (p?.path) openPath(p.path)
  else notify('未找到项目路径')
}

function close() {
  if (running.value) return
  emit('close')
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open && record" class="modal-mask" @click.self="close">
      <div class="card modal lg">
        <div class="modal-head">
          <div class="modal-title"><Icon name="upload" :size="15" /> 恢复备份</div>
          <span class="grow"></span>
          <button type="button" class="btn small ghost icon-x" title="关闭" :disabled="running" @click="close">
            <Icon name="x" :size="14" />
          </button>
        </div>

        <!-- 步骤指示 -->
        <div class="seg rd-steps">
          <button :class="{ on: step === 1 }" :disabled="running || step === 3" @click="step = 1">1 选择方式</button>
          <button :class="{ on: step === 2 }" :disabled="running || step === 3" @click="step = 2">2 确认影响</button>
          <button :class="{ on: step === 3 }" disabled>3 执行</button>
        </div>

        <!-- ---------- 步骤 1 ---------- -->
        <template v-if="step === 1">
          <div class="rd-modes">
            <button
              type="button"
              class="rd-mode"
              :class="{ on: mode === 'new' }"
              :disabled="running"
              @click="mode = 'new'"
            >
              <Icon name="copy" :size="16" />
              <span class="rd-mode-title">恢复为新项目</span>
              <span class="rd-mode-desc">复制到一个新目录并加入项目列表,<b>不影响现有项目</b>。推荐。</span>
            </button>
            <button
              type="button"
              class="rd-mode"
              :class="{ on: mode === 'overwrite', danger: true }"
              :disabled="running || orphan"
              :title="orphan ? '原项目记录已不存在,只能恢复为新项目' : '用备份内容替换原项目目录'"
              @click="mode = 'overwrite'"
            >
              <Icon name="alert" :size="16" />
              <span class="rd-mode-title">覆盖原项目</span>
              <span class="rd-mode-desc">
                {{ orphan ? '原项目记录已不存在,不可选。' : '用备份内容替换原项目目录,原目录会先移入回收站。' }}
              </span>
            </button>
          </div>

          <template v-if="mode === 'new'">
            <div class="field">
              <label class="f-label" for="rd-name">新项目目录名</label>
              <input
                id="rd-name"
                v-model="newName"
                class="input"
                autocomplete="off"
                spellcheck="false"
                :disabled="running"
              />
              <div class="f-hint wrap">
                这只是目录名;在项目列表里显示的名称仍取自 <code>project.godot</code> 的 config/name。
              </div>
            </div>
            <div class="field">
              <label class="f-label" for="rd-dest">恢复位置</label>
              <div class="dir-row">
                <input
                  id="rd-dest"
                  v-model="destDir"
                  class="input mono"
                  placeholder="选择恢复到的父目录"
                  autocomplete="off"
                  spellcheck="false"
                  :disabled="running"
                />
                <button type="button" class="btn ghost" :disabled="running" @click="chooseDestDir">
                  <Icon name="folder" :size="14" /> 浏览
                </button>
              </div>
              <div class="f-hint mono" :title="targetPath">将创建于:{{ targetPath }}</div>
            </div>
          </template>

          <div v-else class="rd-warn">
            <Icon name="alert" :size="13" />
            <div>
              <div class="rd-warn-title">覆盖恢复将替换当前项目目录</div>
              <div class="rd-warn-path mono">{{ project?.path }}</div>
              <div class="rd-warn-desc">
                原目录会先改名为 <code>_old_</code> 备份,复制成功后移入回收站(Windows 可恢复);
                复制失败会自动回滚。<b>进入替换阶段后无法取消。</b>
              </div>
            </div>
          </div>
        </template>

        <!-- ---------- 步骤 2 ---------- -->
        <template v-else-if="step === 2">
          <div class="rd-summary">
            <div class="rd-kv"><span>备份</span><b>{{ record.label || record.projectName }}</b></div>
            <div class="rd-kv"><span>时间</span><b>{{ formatTime(record.createdAt) }}</b></div>
            <div class="rd-kv"><span>方式</span><b>{{ record.mode === 'zip' ? 'zip 打包' : '完整快照' }}<template v-if="record.level"> · L{{ record.level }}</template></b></div>
            <div class="rd-kv"><span>规模</span><b>{{ fmtSize(record.size) }} · {{ record.fileCount }} 文件</b></div>
            <div class="rd-kv"><span>来源项目</span><b :class="{ danger: orphan }">{{ record.projectName }}{{ orphan ? '(已移除)' : '' }}</b></div>
            <div class="rd-kv"><span>源文件</span><b class="mono rd-ellipsis" :title="record.destPath">{{ record.destPath }}</b></div>
            <div class="rd-kv">
              <span>目标</span>
              <b class="mono rd-ellipsis" :title="targetPath" :class="{ danger: mode === 'overwrite' }">{{ targetPath }}</b>
            </div>
          </div>

          <div v-if="mode === 'overwrite'" class="field rd-confirm">
            <label class="f-label" for="rd-typed">
              请输入项目名「{{ expectName }}」以确认覆盖
            </label>
            <input
              id="rd-typed"
              v-model="typed"
              class="input mono"
              autocomplete="off"
              spellcheck="false"
              :placeholder="expectName"
              :disabled="running"
            />
            <div v-if="typed && !typedOk" class="f-hint wrap rd-err">输入内容与项目名不一致</div>
          </div>
          <div v-else class="f-hint wrap rd-safe">
            恢复为新项目是安全的:现有项目与备份文件都不会被修改。
          </div>
        </template>

        <!-- ---------- 步骤 3 ---------- -->
        <template v-else>
          <template v-if="!result">
            <div class="rd-progress">
              <div class="rd-phase">
                <span class="spin"></span>
                <b>{{ phrase }}</b>
                <span class="grow"></span>
                <span v-if="progress?.total" class="rd-count">{{ progress.done }} / {{ progress.total }}</span>
              </div>
              <div class="bar" :class="{ indet: !progress?.total }">
                <div class="fill active" :style="{ width: (progress?.total ? percent : 30) + '%' }"></div>
              </div>
              <div v-if="progress?.current" class="rd-current mono" :title="progress.current">
                {{ progress.current }}
              </div>
            </div>
            <div class="f-hint wrap">
              恢复期间可以离开本页,任务会在后台继续。
              <template v-if="mode === 'overwrite' && activeTask?.cancelable === false">
                已进入替换阶段,取消已不可用。
              </template>
            </div>
          </template>

          <template v-else-if="result.ok">
            <div class="rd-result ok">
              <Icon name="check" :size="16" />
              <div>
                <div class="rd-result-title">
                  {{ mode === 'new' ? '已恢复为新项目' : '已覆盖原项目' }}
                </div>
                <div class="rd-result-desc">
                  <template v-if="mode === 'new'">
                    「{{ result.newProjectName || newName }}」已加入项目列表。
                  </template>
                  <template v-else>
                    原项目目录已用备份内容替换,原目录已移入回收站。
                  </template>
                </div>
              </div>
            </div>
          </template>

          <div v-else-if="result.canceled" class="rd-result warn">
            <Icon name="x" :size="16" />
            <div>
              <div class="rd-result-title">已取消</div>
              <div class="rd-result-desc">未产生任何文件改动。</div>
            </div>
          </div>

          <div v-else class="rd-result err">
            <Icon name="alert" :size="16" />
            <div>
              <div class="rd-result-title">恢复失败</div>
              <div class="rd-result-desc">{{ result.error || '未知原因' }}</div>
            </div>
          </div>
        </template>

        <div class="modal-foot">
          <template v-if="step === 1">
            <span class="grow"></span>
            <button type="button" class="btn ghost" :disabled="running" @click="close">取消</button>
            <button type="button" class="btn primary" :disabled="running" @click="toStep2">
              下一步 <Icon name="chevron-right" :size="13" />
            </button>
          </template>
          <template v-else-if="step === 2">
            <span class="grow"></span>
            <button type="button" class="btn ghost" :disabled="running" @click="step = 1">
              <Icon name="chevron-left" :size="13" /> 上一步
            </button>
            <button
              type="button"
              class="btn"
              :class="mode === 'overwrite' ? 'del-confirm' : 'primary'"
              :disabled="running || (mode === 'overwrite' && !typedOk)"
              @click="start"
            >
              <Icon name="upload" :size="13" />
              {{ mode === 'overwrite' ? '覆盖并恢复' : '开始恢复' }}
            </button>
          </template>
          <template v-else>
            <span class="grow"></span>
            <button v-if="!result" type="button" class="btn ghost" :disabled="!canCancel" @click="cancel">
              取消恢复
            </button>
            <template v-else>
              <button v-if="result.ok" type="button" class="btn ghost" @click="openTarget">
                <Icon name="external" :size="13" /> 打开项目目录
              </button>
              <button type="button" class="btn primary" @click="close">
                {{ result.ok ? '完成' : '关闭' }}
              </button>
            </template>
          </template>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.rd-steps {
  margin-bottom: 14px;
}

.rd-modes {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 14px;
}

.rd-mode {
  display: grid;
  grid-template-columns: 22px 1fr;
  grid-template-rows: auto auto;
  gap: 2px 8px;
  align-items: center;
  text-align: left;
  padding: 11px 13px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}

.rd-mode:hover:not(:disabled) {
  border-color: var(--brand);
}

.rd-mode.on {
  border-color: var(--brand);
  background: var(--brand-weak);
}

.rd-mode.on.danger {
  border-color: var(--danger);
  background: var(--danger-weak);
}

.rd-mode:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.rd-mode .icon {
  grid-row: span 2;
  color: var(--brand);
}

.rd-mode.on.danger .icon {
  color: var(--danger);
}

.rd-mode-title {
  font-size: 13.5px;
  font-weight: 650;
  color: var(--text);
}

.rd-mode-desc {
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--text-3);
  grid-column: 2;
}

.rd-warn {
  display: flex;
  gap: 9px;
  padding: 11px 13px;
  border: 1px solid var(--danger);
  border-radius: var(--radius-sm);
  background: var(--danger-weak);
  color: var(--danger);
  margin-bottom: 14px;
}

.rd-warn-title {
  font-size: 13px;
  font-weight: 650;
  margin-bottom: 4px;
}

.rd-warn-path {
  font-size: 11.5px;
  color: var(--danger);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rd-warn-desc {
  margin-top: 5px;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--text-2);
}

.rd-summary {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  padding: 10px 12px;
  margin-bottom: 14px;
}

.rd-kv {
  display: flex;
  gap: 10px;
  font-size: 12.5px;
  line-height: 1.9;
}

.rd-kv > span {
  width: 64px;
  flex-shrink: 0;
  color: var(--text-3);
}

.rd-kv > b {
  min-width: 0;
  font-weight: 600;
  color: var(--text);
}

.rd-kv > b.danger {
  color: var(--danger);
}

.rd-ellipsis {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rd-confirm {
  margin-bottom: 12px;
}

.rd-err {
  color: var(--danger);
}

.rd-safe {
  color: var(--text-3);
}

.rd-progress {
  margin-bottom: 6px;
}

.rd-phase {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  color: var(--brand);
  margin-bottom: 8px;
}

.rd-count {
  font-size: 11.5px;
  color: var(--text-3);
}

.rd-current {
  margin-top: 6px;
  font-size: 10.5px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rd-result {
  display: flex;
  gap: 10px;
  padding: 12px 14px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
}

.rd-result.ok {
  border-color: var(--ok);
  background: var(--ok-weak);
  color: var(--ok);
}

.rd-result.warn {
  border-color: var(--warn);
  background: var(--warn-weak);
  color: var(--warn);
}

.rd-result.err {
  border-color: var(--danger);
  background: var(--danger-weak);
  color: var(--danger);
}

.rd-result-title {
  font-size: 13.5px;
  font-weight: 650;
  margin-bottom: 3px;
}

.rd-result-desc {
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-2);
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
