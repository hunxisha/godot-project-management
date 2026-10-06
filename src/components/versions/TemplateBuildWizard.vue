<script setup lang="ts">
// 自编译导出模板向导(三步):工具链检测 → 跑编译(尾行实时展示,可取消)→ 产物导入。
//
// 这个组件里**没有任何判据**:能不能构建(python/SCons/vcvars 齐不齐)、缺了给什么下一步、
// 编译用什么命令(实测验证过的固定选项组,见 docs/template-build-wizard-plan.md)、
// 产物整理成什么形态,全部在宿主侧 buildtools / 第 5 项的 installExportTemplates 里;
// 本组件只负责把「检测 → 构建 → 导入」的流程摆出来,失败时把 problems/尾行如实显示。
// 与 FixConfirmDialog 同一先例:判据不进 .vue(跑不进 Node harness),这里只是展示与调度。
import { computed, ref, watch } from 'vue'
import Icon from '../Icon.vue'
import { pickDirectory } from '../../services/bridge'
import type { TemplateBuildTask } from '../../types/godot'

const props = defineProps<{
  open: boolean
  /** 要给哪台引擎编译模板(版本串/任务都挂在它身上) */
  versionId: string
  /** 引擎 tag(任务展示与 versionDir 默认值) */
  tag: string
}>()
const emit = defineEmits<{ (e: 'close'): void; (e: 'imported', msg: string): void }>()

type Step = 'checking' | 'check' | 'build' | 'building' | 'done'
const step = ref<Step>('checking')
const checkResult = ref<{ ok: boolean; pythonVersion: string; sconsVersion: string; vcvarsPath: string; cpuCount: number; problems: string[] } | null>(null)
const srcDir = ref('')
const buildTask = ref<TemplateBuildTask | null>(null)
const importMsg = ref('')
let taskId = ''
let unwatch: (() => void) | null = null

/** 编译命令预览(与宿主写进临时 bat 的逐字一致,只有路径和并行度来自输入) */
const commandPreview = computed(() =>
  `scons platform=windows target=template_release disable_3d=yes accesskit=no d3d12=no -j${checkResult.value?.cpuCount || '?'}`
)
/** 目录名默认值:tag 派生(模板给官方同 tag 引擎用正好;自编译引擎要按它的 --version 改) */
const defaultVersionDir = computed(() => String(props.tag || '').replace(/-/g, '.'))
const importDirName = ref('')

watch(
  () => props.open,
  (open) => {
    if (!open) return
    // 每次打开都是一轮干净的检测:上一次的结果/输入不跟到下一次
    step.value = 'checking'
    checkResult.value = null
    srcDir.value = ''
    buildTask.value = null
    importMsg.value = ''
    importDirName.value = defaultVersionDir.value
    taskId = ''
    runCheck()
  }
)

async function runCheck() {
  const r = await window.services.checkTemplateBuildTools()
  checkResult.value = r
  step.value = 'check'
}

function pickSrc() {
  void pickDirectory('选择 Godot 源码根(含 SConstruct)').then((d) => {
    if (d) srcDir.value = d
  })
}

async function startBuild() {
  // 先订阅再入队:入队到首帧快照之间没有空窗,任务不会闪没
  unwatch = window.services.watchTemplateBuildTasks((list) => {
    const t = list.find((x) => x.id === taskId)
    if (!t) return
    buildTask.value = t
    if (t.status === 'done') {
      importDirName.value = t.versionDir || defaultVersionDir.value
      step.value = 'done'
    }
  })
  const r = await window.services.buildTemplatePack({ srcDir: srcDir.value, tag: props.tag })
  if (!r.ok || !r.taskId) {
    if (unwatch) { unwatch(); unwatch = null }
    return
  }
  taskId = r.taskId
  step.value = 'building'
}

function cancelBuild() {
  window.services.cancelTemplateBuildTask(taskId)
}

/** 构建完成 → 导入:stage 目录(templates/ 顶层)交给第 5 项的目录形态导入 */
async function startImport() {
  const t = buildTask.value
  if (!t || !t.stageDir) return
  const name = importDirName.value.trim()
  const r = await window.services.installExportTemplates(props.versionId, { srcPath: t.stageDir, versionDir: name })
  if (!r.ok) {
    importMsg.value = r.error || '导入失败'
    return
  }
  importMsg.value = '导入任务已排队,完成后版本卡会显示「模板已装」'
  emit('imported', importMsg.value)
}

function close() {
  // 构建在途不拦着关窗:任务在独立队列里继续跑,重开向导前先 dismiss 那条记录即可;
  // 这里只解除本窗的订阅,避免向已卸载的视图泄漏回调
  if (unwatch) {
    unwatch()
    unwatch = null
  }
  emit('close')
}
</script>

<template>
  <div v-if="open" class="modal-mask" @click.self="close">
    <div class="modal lg wizard">
      <div class="modal-head">
        <h3><Icon name="package" :size="14" /> 自编译 2D 模板 · {{ tag }}</h3>
        <button class="btn small ghost" @click="close">关闭</button>
      </div>

      <!-- 第一步:工具链检测 -->
      <p v-if="step === 'checking'" class="hint"><span class="spin"></span> 正在检测 python / SCons / MSVC 工具链…</p>
      <template v-else-if="step === 'check' && checkResult">
        <div class="check-grid">
          <span :class="checkResult.pythonVersion ? 'ok' : 'bad'">{{ checkResult.pythonVersion || '未找到' }}</span><span>Python</span>
          <span :class="checkResult.sconsVersion ? 'ok' : 'bad'">{{ checkResult.sconsVersion || '未找到' }}</span><span>SCons</span>
          <span :class="checkResult.vcvarsPath ? 'ok' : 'bad'">{{ checkResult.vcvarsPath ? '已找到' : '未找到' }}</span><span>MSVC (vcvars64)</span>
          <span class="ok">{{ checkResult.cpuCount }}</span><span>CPU 核数(并行度)</span>
        </div>
        <ul v-if="checkResult.problems.length" class="problems">
          <li v-for="p in checkResult.problems" :key="p">{{ p }}</li>
        </ul>
        <p class="hint">确保源码所在盘剩余空间 ≥ 20 GB(源码约 2 GB,编译中间物约 10 GB)。预期耗时:16 核约 5 分钟。</p>
        <div class="acts-row">
          <button class="btn primary" :disabled="!checkResult.ok" @click="step = 'build'">下一步:选择源码</button>
        </div>
      </template>

      <!-- 第二步:选源码,发起编译 -->
      <template v-else-if="step === 'build'">
        <label class="row">
          <span>Godot 源码根</span>
          <input v-model="srcDir" class="select grow" placeholder="含 SConstruct 的目录(如 E:\godot-4.7.2-stable)">
          <button class="btn small" @click="pickSrc">选择目录</button>
        </label>
        <p class="hint">将执行:</p>
        <pre class="cmd mono">{{ commandPreview }}</pre>
        <p class="hint">产物只含 Windows 平台(裁掉 3D/物理/D3D12/无障碍树),导出的游戏用 Vulkan 或 Compatibility 渲染法均可用。</p>
        <div class="acts-row">
          <button class="btn primary" :disabled="!srcDir" @click="startBuild">开始编译</button>
        </div>
      </template>

      <!-- 编译中:尾行实时展示 + 可取消 -->
      <template v-else-if="step === 'building' || buildTask?.status === 'building' || buildTask?.status === 'queued'">
        <p class="hint"><span class="spin"></span> 编译中(任务 {{ taskId }})—— 关闭窗口任务会继续,重开可见。</p>
        <pre class="log mono">{{ buildTask?.log || '启动编译…' }}</pre>
        <div class="acts-row">
          <button class="btn danger-text" @click="cancelBuild">取消编译</button>
        </div>
      </template>

      <!-- 第三步:导入 -->
      <template v-else-if="step === 'done' && buildTask">
        <p class="hint ok-line">编译完成:{{ buildTask.files }} 个产物已就位。</p>
        <label class="row">
          <span>模板目录名</span>
          <input
            v-model="importDirName"
            class="select"
            title="编辑器按版本串在 export_templates/ 下查找,须与用模板的那台引擎 --version 输出一致(自编译引擎带 custom_build 后缀)"
          >
        </label>
        <p v-if="importMsg" class="hint ok-line">{{ importMsg }}</p>
        <div class="acts-row">
          <button class="btn primary" :disabled="!!importMsg" @click="startImport">导入该模板</button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.wizard {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.modal-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.modal-head h3 {
  margin: 0;
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text);
}

.hint {
  margin: 0;
  font-size: 12px;
  color: var(--text-2);
  line-height: 1.6;
}

.ok-line {
  color: var(--ok);
}

.check-grid {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 4px 12px;
  font-size: 12.5px;
}

.check-grid span:nth-child(odd) {
  text-align: right;
  font-weight: 600;
}

.check-grid .ok {
  color: var(--ok);
}

.check-grid .bad {
  color: var(--danger);
}

.problems {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  color: var(--warn);
  line-height: 1.7;
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  color: var(--text-2);
}

.cmd {
  margin: 0;
  padding: 8px 10px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 11.5px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.log {
  margin: 0;
  max-height: 260px;
  overflow-y: auto;
  padding: 8px 10px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 11px;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.acts-row {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
