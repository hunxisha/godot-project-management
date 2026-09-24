// 备份/恢复对话框的共用骨架:任务订阅 + 进度百分比 + 可取消判断 + 取消失败提示。
//
// 为什么抽出来:BackupCreateDialog.vue 与 RestoreDialog.vue 原本各写了一份同样的
// 「订阅 watchBackupTasks → 找 activeTask → 算 canCancel / percent / phrase → cancel」
// 逻辑(约 27 行 × 2),只在 kind、阶段文案与取消失败提示上有差异。
// 这类逻辑写在组件里无法被回归测试触达,抽成组合式函数后可以用既有方式
// (build-bundle.mjs + Node 断言,见 useTaskDialog.test.mjs)直接验证。
import { computed, getCurrentInstance, onBeforeUnmount, ref } from 'vue'
import { notify } from '../services/bridge'
import type { BackupTask } from '../types/godot'

/** 进度回调载荷(与 preload 侧 BackupProgress 同形) */
export interface TaskProgress {
  phase: string
  done: number
  total: number
  current: string
}

/**
 * 备份/恢复任务的阶段中文名。
 * 两个对话框各自只会遇到其中一部分(新建备份:scanning/packing/copying/finalizing;
 * 恢复:unpacking/copying/replacing/registering),合并成一张表不会冲突。
 */
export const PHASE_LABEL: Record<string, string> = {
  scanning: '扫描文件',
  packing: '压缩打包',
  copying: '复制快照',
  unpacking: '解压备份',
  replacing: '替换原项目目录',
  registering: '注册项目',
  finalizing: '收尾'
}

export interface UseTaskDialogOptions {
  /** 只认这个 kind 的任务 */
  kind: BackupTask['kind']
  /** begin() 时写入的起始阶段 */
  initialPhase: string
  /** 取消失败时的提示文案(备份与恢复措辞不同) */
  cancelFailedMessage?: string
  /** 阶段文案表,默认 PHASE_LABEL */
  phaseLabels?: Record<string, string>
  /** 尚无进度时的文案 */
  idlePhrase?: string
}

export function useTaskDialog<TResult = unknown>(opts: UseTaskDialogOptions) {
  const labels = opts.phaseLabels || PHASE_LABEL
  const idlePhrase = opts.idlePhrase || '准备中'
  const cancelFailedMessage = opts.cancelFailedMessage || '该阶段无法取消'

  const progress = ref<TaskProgress | null>(null)
  const result = ref<TResult | null>(null)
  const tasks = ref<BackupTask[]>([])
  /** 任务执行中(原 running / busy):期间禁止关闭对话框 */
  const running = ref(false)
  let unwatch: (() => void) | null = null

  /** 订阅任务表(幂等:重复调用不会重复订阅) */
  function startWatching() {
    if (unwatch) return
    unwatch = window.services.watchBackupTasks((snap) => {
      tasks.value = snap
    })
  }

  /** 解除订阅并清空任务快照 */
  function stopWatching() {
    if (unwatch) {
      unwatch()
      unwatch = null
    }
    tasks.value = []
  }

  const activeTask = computed(() => tasks.value.find((t) => t.kind === opts.kind))

  /** 结果已出、或任务已进入不可回滚阶段时不可取消 */
  const canCancel = computed(
    () => !result.value && !!activeTask.value && activeTask.value.cancelable !== false
  )

  const phrase = computed(() =>
    progress.value ? labels[progress.value.phase] || progress.value.phase : idlePhrase
  )

  const percent = computed(() => {
    const p = progress.value
    if (!p || !p.total) return 0
    return Math.min(100, Math.round((p.done / p.total) * 100))
  })

  const canClose = computed(() => !running.value)

  /** 开始一次任务:清空上次结果、写起始阶段、开始订阅 */
  function begin() {
    running.value = true
    result.value = null
    progress.value = { phase: opts.initialPhase, done: 0, total: 0, current: '' }
    startWatching()
  }

  /** 结束任务(成功 / 失败 / 取消都走这里):解除订阅 */
  function end() {
    running.value = false
    stopWatching()
  }

  /** 把 preload 的进度回调写入内部状态 */
  function report(p: TaskProgress) {
    progress.value = { phase: p.phase, done: p.done, total: p.total, current: p.current }
  }

  /** 请求取消;被拒绝(已锁定)时提示用户并返回 false */
  function cancel(): boolean {
    const t = activeTask.value
    if (!t) return false
    if (!window.services.cancelBackupTask(t.id)) {
      notify(cancelFailedMessage)
      return false
    }
    return true
  }

  // 组件卸载时务必解除订阅,否则任务表会把已销毁组件挂在监听器上。
  // 放在组合式函数里注册,调用方就不会漏;在组件外使用(如回归测试)时跳过。
  if (getCurrentInstance()) onBeforeUnmount(stopWatching)

  return {
    // 状态
    progress,
    result,
    tasks,
    running,
    // 派生
    activeTask,
    canCancel,
    canClose,
    phrase,
    percent,
    // 生命周期
    startWatching,
    stopWatching,
    begin,
    end,
    report,
    cancel
  }
}
