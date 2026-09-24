// useTaskDialog 回归测试:备份/恢复对话框的共用骨架。
//
// 这段逻辑原本内联在 BackupCreateDialog.vue 与 RestoreDialog.vue 里,组件无法被回归测试
// 触达 —— 抽成组合式函数后,这里用现有方式(vite 打包 + Node 断言 + 桩掉 window.services)
// 直接验证订阅、可取消判断、进度百分比、取消失败提示与开始/结束生命周期。
//
// 用法(npm script 会先跑打包步骤):
//   npm run test:taskdialog
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BUNDLE = path.resolve(__dirname, '../../../.gpm-test/out/usetaskdialog.mjs')

if (!existsSync(BUNDLE)) {
  console.error(`找不到打包产物: ${BUNDLE}`)
  console.error('请先运行: node src/composables/__tests__/build-bundle.mjs')
  process.exit(2)
}

// ---------- 桩:window.services / window.ztools ----------
let watchers = []
let subscribeCount = 0
let unsubscribeCount = 0
let snapshot = []
let cancelResult = true
const cancelCalls = []
const notifications = []

global.window = {
  services: {
    watchBackupTasks(fn) {
      subscribeCount++
      watchers.push(fn)
      // 真实实现订阅时会立即回调一次当前状态
      fn(snapshot)
      return () => {
        unsubscribeCount++
        watchers = watchers.filter((w) => w !== fn)
      }
    },
    cancelBackupTask(id) {
      cancelCalls.push(id)
      return cancelResult
    }
  },
  ztools: { showNotification: (body) => notifications.push(body) }
}

function pushSnapshot(snap) {
  snapshot = snap
  for (const w of [...watchers]) w(snap)
}
function reset() {
  watchers = []
  subscribeCount = 0
  unsubscribeCount = 0
  snapshot = []
  cancelResult = true
  cancelCalls.length = 0
  notifications.length = 0
}

const { useTaskDialog, PHASE_LABEL } = await import(pathToFileURL(BUNDLE).href)

let pass = 0
const failures = []
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log(`  PASS  ${label}`) }
  else { failures.push(label); console.log(`  FAIL  ${label}${extra !== undefined ? '  → ' + extra : ''}`) }
}
const section = (t) => console.log(`\n=== ${t} ===`)

const BACKUP_TASK = (over) => ({
  id: 'bt-1', kind: 'backup', projectId: 'p1', projectName: 'Alpha', mode: 'zip',
  phase: 'packing', done: 0, total: 0, bytes: 0, current: '', startedAt: 1, ...over
})

// ---------- 1. 订阅 ----------
section('1. 订阅:幂等 / 快照写入 / 解除')
{
  reset()
  const d = useTaskDialog({ kind: 'backup', initialPhase: 'scanning' })
  ok(subscribeCount === 0, '未开始时没有订阅')
  d.startWatching()
  ok(subscribeCount === 1, 'startWatching 订阅一次')
  d.startWatching()
  ok(subscribeCount === 1, '重复 startWatching 不会重复订阅', String(subscribeCount))
  pushSnapshot([BACKUP_TASK()])
  ok(d.tasks.value.length === 1, '订阅者收到任务快照')
  d.stopWatching()
  ok(unsubscribeCount === 1, 'stopWatching 解除订阅')
  ok(d.tasks.value.length === 0, '解除后清空任务快照')
  d.stopWatching()
  ok(unsubscribeCount === 1, '重复 stopWatching 安全(不会重复解除)')
}

// ---------- 2. activeTask / canCancel ----------
section('2. activeTask 只认自己的 kind;canCancel 的三条判据')
{
  reset()
  const d = useTaskDialog({ kind: 'backup', initialPhase: 'scanning' })
  d.startWatching()
  ok(d.activeTask.value === undefined, '无任务时没有 activeTask')
  ok(d.canCancel.value === false, '无任务时不可取消')

  pushSnapshot([
    { ...BACKUP_TASK(), id: 'r-1', kind: 'restore' },
    BACKUP_TASK({ id: 'b-1' })
  ])
  ok(d.activeTask.value.id === 'b-1', '混合快照里挑出 backup 任务', String(d.activeTask.value && d.activeTask.value.id))
  ok(d.canCancel.value === true, '可取消阶段(未标 cancelable)可取消')

  pushSnapshot([BACKUP_TASK({ id: 'b-2', cancelable: false })])
  ok(d.canCancel.value === false, 'cancelable=false(已进入不可回滚阶段)不可取消')

  pushSnapshot([BACKUP_TASK({ id: 'b-3' })])
  ok(d.canCancel.value === true, '恢复正常后可取消')
  d.result.value = { ok: true }
  ok(d.canCancel.value === false, '结果已出时不可取消')
}

// ---------- 3. phrase / percent ----------
section('3. phrase 阶段文案 / percent 百分比')
{
  reset()
  const d = useTaskDialog({ kind: 'backup', initialPhase: 'scanning' })
  ok(d.phrase.value === '准备中', '无进度时用默认文案', d.phrase.value)
  ok(d.percent.value === 0, '无进度时百分比为 0')

  d.report({ phase: 'packing', done: 50, total: 200, current: 'a.txt' })
  ok(d.phrase.value === PHASE_LABEL.packing, '已知阶段用中文文案', d.phrase.value)
  ok(d.percent.value === 25, '百分比按 done/total 计算', String(d.percent.value))

  d.report({ phase: 'weird-phase', done: 0, total: 10, current: '' })
  ok(d.phrase.value === 'weird-phase', '未知阶段回落到阶段名本身', d.phrase.value)

  d.report({ phase: 'packing', done: 0, total: 0, current: '' })
  ok(d.percent.value === 0, 'total 为 0 时不做除法', String(d.percent.value))

  d.report({ phase: 'packing', done: 500, total: 200, current: '' })
  ok(d.percent.value === 100, 'done 超过 total 时封顶 100', String(d.percent.value))

  const custom = useTaskDialog({ kind: 'backup', initialPhase: 'scanning', phaseLabels: { packing: '自定义打包' }, idlePhrase: '待命' })
  ok(custom.phrase.value === '待命', 'idlePhrase 可定制', custom.phrase.value)
  custom.report({ phase: 'packing', done: 1, total: 2, current: '' })
  ok(custom.phrase.value === '自定义打包', 'phaseLabels 可覆盖', custom.phrase.value)
}

// ---------- 4. begin / end 生命周期 ----------
section('4. begin / end:running 与订阅的成对关系')
{
  reset()
  const d = useTaskDialog({ kind: 'backup', initialPhase: 'scanning' })
  ok(d.running.value === false, '初始不在执行中')
  ok(d.canClose.value === true, '初始可关闭')

  d.result.value = { ok: false, error: '上一次的残留' }
  d.begin()
  ok(d.running.value === true, 'begin 置为执行中')
  ok(d.canClose.value === false, '执行中不可关闭')
  ok(d.result.value === null, 'begin 清空上一次结果')
  ok(d.progress.value.phase === 'scanning', 'begin 写入起始阶段', d.progress.value.phase)
  ok(subscribeCount === 1, 'begin 自动开始订阅')

  d.report({ phase: 'finalizing', done: 1, total: 1, current: '' })
  ok(d.progress.value.phase === 'finalizing', 'report 更新进度阶段')

  d.end()
  ok(d.running.value === false, 'end 结束执行中')
  ok(d.canClose.value === true, '结束恢复可关闭')
  ok(unsubscribeCount === 1, 'end 自动解除订阅')
  ok(d.tasks.value.length === 0, 'end 清空任务快照')
}

// ---------- 5. cancel ----------
section('5. cancel:成功 / 被拒 / 无任务')
{
  reset()
  const d = useTaskDialog({ kind: 'backup', initialPhase: 'scanning' })
  ok(d.cancel() === false, '没有任务时取消返回 false')
  ok(notifications.length === 0, '没有任务时不打扰用户', notifications.join('|'))

  d.startWatching()
  pushSnapshot([BACKUP_TASK({ id: 'b-9' })])
  ok(d.cancel() === true, '取消成功返回 true')
  ok(cancelCalls[0] === 'b-9', '把 activeTask 的 id 传给了 cancelBackupTask', String(cancelCalls[0]))
  ok(notifications.length === 0, '取消成功不提示')

  cancelResult = false
  ok(d.cancel() === false, '被拒绝时返回 false')
  ok(notifications.length === 1, '被拒绝时提示一次', notifications.join('|'))
  ok(notifications[0] === '该阶段无法取消', '默认提示文案', String(notifications[0]))
}

// ---------- 6. 选项 ----------
section('6. 选项:kind 与取消失败文案按对话框定制')
{
  reset()
  const restore = useTaskDialog({ kind: 'restore', initialPhase: 'unpacking', cancelFailedMessage: '已进入替换阶段,无法取消' })
  restore.startWatching()
  pushSnapshot([BACKUP_TASK({ id: 'b-1' })])
  ok(restore.activeTask.value === undefined, 'kind=restore 时忽略 backup 任务')
  ok(restore.cancel() === false, '没有自己的任务时取消返回 false')
  ok(notifications.length === 0, '此时不提示')

  pushSnapshot([{ ...BACKUP_TASK(), id: 'r-7', kind: 'restore', phase: 'unpacking' }])
  ok(restore.activeTask.value.id === 'r-7', 'kind=restore 认 restore 任务')
  // phrase 由 progress 驱动(与原实现一致),所以要先 report 再断言
  restore.report({ phase: 'unpacking', done: 0, total: 4, current: '' })
  ok(restore.phrase.value === '解压备份', 'restore 的阶段文案取自共享表', restore.phrase.value)
  ok(restore.percent.value === 0, 'total 已给但 done 为 0 时百分比为 0', String(restore.percent.value))
  cancelResult = false
  restore.cancel()
  ok(notifications[0] === '已进入替换阶段,无法取消', '取消失败文案可定制', String(notifications[0]))

  const idle = useTaskDialog({ kind: 'backup', initialPhase: 'scanning' })
  ok(idle.phrase.value === '准备中', '两个对话框共享同一份默认文案')
}

// ---------- 结果 ----------
console.log(`\n${'='.repeat(56)}`)
console.log(`PASS ${pass}  FAIL ${failures.length}`)
if (failures.length) {
  console.log('失败项:')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log('全部通过')
