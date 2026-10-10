<script setup lang="ts">
// 自编译导出模板向导(三步):工具链检测 → 选源码 + 挑功能(裁剪配置)→ 编译中(可取消)→ 产物导入。
//
// 这个组件里**没有任何判据**:工具链齐不齐、源码里有哪些开关与默认值、取消一项会连带什么、
// 哪些组合编出废模板、三档预设各关哪些项、校验出什么软问题与硬拦、编译命令与裁剪参数 ——
// 全部在宿主侧 buildtools / tplfeatures / tplprobe / tplprofile 里(预设连编译模式 mode 一起交,
// 见下);本组件只负责把流程摆出来,失败与风险如实显示。
// 与 FixConfirmDialog 同一先例:判据不进 .vue(跑不进 Node harness),这里只是展示与调度。
import { computed, ref, watch } from 'vue'
import Icon from '../Icon.vue'
import TemplateFeaturePanel from './TemplateFeaturePanel.vue'
import { pickDirectory } from '../../services/bridge'
import type { FeatureWithProbe, TemplateBuildTask, TplIssue, TplProfileMode } from '../../types/godot'

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
const buildErr = ref('')
let taskId = ''
let unwatch: (() => void) | null = null

// ---------- 第二步:功能勾选与静态校验(数据与判定全部来自宿主) ----------
const panelItems = ref<FeatureWithProbe[]>([])
const features = ref<Record<string, boolean>>({})
const panelErr = ref('')
const sourceVersion = ref('')
const tested = ref(true)
const issues = ref<TplIssue[]>([])
const hardBlocks = ref<TplIssue[]>([])
const suppressed = ref<string[]>([])
const skippedOk = ref(false)                    // 用户点过「仍然继续」后为真
const mode = ref<TplProfileMode>('default-on')  // 未选预设时的编译模式;选了预设由宿主重给(Ruling #74)

/** 编译命令预览:只是示意形状 —— 真实命令行上还挂着按勾选下发的编译选项(下方提示已明说),不在这里拼 */
const commandPreview = computed(() =>
  `scons platform=windows target=template_release build_profile="<本次生成的 profile 文件>" -j${checkResult.value?.cpuCount || '?'}`
)
/** 目录名默认值:tag 派生(模板给官方同 tag 引擎用正好;自编译引擎要按它的 --version 改) */
const defaultVersionDir = computed(() => String(props.tag || '').replace(/-/g, '.'))
const importDirName = ref('')

let validateTimer: ReturnType<typeof setTimeout> | null = null
let loadTimer: ReturnType<typeof setTimeout> | null = null

/** 勾选变化 → 去抖跑一次校验(Ruling #75):连带变灰、软问题、按钮禁用态都跟着勾选即时更新 */
function scheduleValidate() {
  if (validateTimer) clearTimeout(validateTimer)
  validateTimer = setTimeout(() => { validateTimer = null; void runValidate() }, 200)
}

/** 源码根变化 → 去抖拉面板(手动敲路径时不会每敲一个字就整套探测一遍) */
function scheduleLoadPanel(dir: string) {
  if (loadTimer) clearTimeout(loadTimer)
  loadTimer = setTimeout(() => { loadTimer = null; void loadPanel(dir) }, 300)
}

/** 面板数据 = 宿主的能力表 + 这份源码的探测结果。探测失败(不是源码根 / 整表空)就拒绝进面板 */
async function loadPanel(dir: string) {
  skippedOk.value = false
  const r = await window.services.listTemplateFeatures(dir)
  if (dir !== srcDir.value) return // 输入已经改到别的目录了:这份响应作废,过时数据不落到面板上
  if (!r.ok) {
    panelErr.value = r.error || '无法读取这份源码的功能开关'
    panelItems.value = []
    features.value = {}
    return
  }
  panelErr.value = ''
  panelItems.value = r.items ?? []
  const init: Record<string, boolean> = {}
  for (const it of panelItems.value) init[it.id] = it.present ? it.defaultOn : false
  features.value = init
  const probe = await window.services.probeTemplateSource(dir)
  sourceVersion.value = probe.sourceVersion || ''
  tested.value = !!probe.tested
}

/** 编译前静态校验:issues / hardBlocks / suppressed 三份一起更新,三份都由宿主算 */
async function runValidate() {
  if (!srcDir.value || panelErr.value || !panelItems.value.length) {
    issues.value = []
    hardBlocks.value = []
    suppressed.value = []
    return
  }
  const v = await window.services.validateTemplateConfig({
    srcDir: srcDir.value,
    features: features.value,
    mode: mode.value
  })
  issues.value = v.issues || []
  hardBlocks.value = v.hardBlocks || []
  suppressed.value = v.suppressed || []
}

/** 预设:三档各关哪些项、编译模式是什么都由宿主给(Ruling #74:判定不进 .vue,向导只透传) */
async function applyPreset(name: string) {
  const r = await window.services.applyTemplatePreset(name, srcDir.value)
  if (!r.ok) {
    panelErr.value = r.error || '预设应用失败'
    return
  }
  skippedOk.value = false
  features.value = r.features
  mode.value = r.mode
}

/** 点「开始编译」:先让宿主再校一次 —— 硬拦不给编,软问题要用户先看过 */
async function tryStartBuild() {
  await runValidate()
  if (hardBlocks.value.length) return
  if (issues.value.length && !skippedOk.value) return
  await startBuild()
}

watch(features, scheduleValidate)
watch(srcDir, (dir) => {
  skippedOk.value = false
  if (!dir) {
    if (loadTimer) { clearTimeout(loadTimer); loadTimer = null }
    panelItems.value = []
    features.value = {}
    panelErr.value = ''
    return
  }
  scheduleLoadPanel(dir)
})

watch(
  () => props.open,
  (open) => {
    if (!open) return
    // 每次打开都是一轮干净的检测:上一次的结果/输入/勾选不跟到下一次
    step.value = 'checking'
    checkResult.value = null
    srcDir.value = ''
    buildTask.value = null
    importMsg.value = ''
    buildErr.value = ''
    importDirName.value = defaultVersionDir.value
    taskId = ''
    panelItems.value = []
    features.value = {}
    panelErr.value = ''
    issues.value = []
    hardBlocks.value = []
    suppressed.value = []
    skippedOk.value = false
    mode.value = 'default-on'
    if (validateTimer) { clearTimeout(validateTimer); validateTimer = null }
    if (loadTimer) { clearTimeout(loadTimer); loadTimer = null }
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
  // features 是必填(漏传被宿主同步拒);mode 与校验那次用的是同一个状态量(Ruling #74)
  const r = await window.services.buildTemplatePack({ srcDir: srcDir.value, tag: props.tag, features: features.value, mode: mode.value })
  if (!r.ok || !r.taskId) {
    // 入队被同步拒(版本闸形态不符 / 空间不足等):把宿主那句原因摆出来,不静默消失
    if (unwatch) { unwatch(); unwatch = null }
    buildErr.value = r.error || '无法发起编译'
    return
  }
  buildErr.value = ''
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
        <h3><Icon name="package" :size="14" /> 自编译模板 · {{ tag }}</h3>
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

      <!-- 第二步:选源码 + 挑功能,发起编译 -->
      <template v-else-if="step === 'build'">
        <label class="row">
          <span>Godot 源码根</span>
          <input v-model="srcDir" class="select grow" placeholder="含 SConstruct 的目录(如 E:\godot-4.7.2-stable)">
          <button class="btn small" @click="pickSrc">选择目录</button>
        </label>
        <p v-if="panelErr" class="hint bad-line">{{ panelErr }}</p>
        <template v-else>
          <TemplateFeaturePanel
            v-model="features"
            :items="panelItems"
            :source-version="sourceVersion"
            :tested="tested"
            :suppressed="suppressed"
            @preset="applyPreset"
          />
          <p class="hint">将执行:</p>
          <pre class="cmd mono">{{ commandPreview }}</pre>
          <p class="hint">另有若干裁剪选项按你的勾选追加在命令行上(与 profile 文件一起由宿主生成)。产物只含 Windows 平台,3D 节点、物理、无障碍树等按勾选裁剪。</p>
          <ul v-if="hardBlocks.length" class="problems danger">
            <li v-for="(b, i) in hardBlocks" :key="b.itemId + '|' + b.flag + '|' + i">
              {{ b.why }} —— {{ b.action }}
            </li>
          </ul>
          <ul v-if="issues.length" class="problems">
            <li v-for="(x, i) in issues" :key="x.itemId + '|' + x.flag + '|' + i">
              {{ x.why }} <em>{{ x.action }}</em>
              <button class="btn small ghost" @click="skippedOk = true">仍然继续</button>
            </li>
          </ul>
          <p v-if="buildErr" class="hint bad-line">{{ buildErr }}</p>
          <div class="acts-row">
            <button class="btn primary" :disabled="!srcDir || !panelItems.length || hardBlocks.length > 0 || (issues.length > 0 && !skippedOk)" @click="tryStartBuild">开始编译</button>
          </div>
        </template>
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

.problems.danger {
  color: var(--danger);
}

.problems em {
  font-style: normal;
  color: var(--text-2);
}

.bad-line {
  color: var(--danger);
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
