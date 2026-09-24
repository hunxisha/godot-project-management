// taskqueue.js 回归测试:两套任务生命周期合并后的共享实现。
//
// 背景:install.js(下载队列)与 backup.js(备份/恢复)原本各写一套同形的任务表。合并时
// 它们的行为差异被显式化成选项,这里逐项锁住 —— 尤其是「快照必须拷贝」「监听器异常必须
// 隔离」「终态才可 dismiss」「串行执行」这四条曾经只靠复制粘贴保持一致的行为。
//
// 另有一条回归:finish() 曾经把阶段**值**当成字段**名**写入(phaseField 与取值混用同一个
// 访问器),导致任务的 phase 永远不更新、取消与终态全部失效 —— 备份测试当场抓到。
// 这里用 phaseField:'status' 显式覆盖字段名,防止同类错误再次出现。
//
// 用法:
//   node src-ztools/preload/lib/__tests__/taskqueue.test.js
const path = require('node:path')

const LIB = path.resolve(__dirname, '..')
const { createTaskQueue, TERMINAL_PHASES } = require(path.join(LIB, 'taskqueue.js'))

let pass = 0
const failures = []
function ok(cond, label, extra) {
  if (cond) {
    pass++
    console.log(`  PASS  ${label}`)
  } else {
    failures.push(label)
    console.log(`  FAIL  ${label}${extra !== undefined ? '  → ' + extra : ''}`)
  }
}
function section(t) {
  console.log(`\n=== ${t} ===`)
}
const tick = () => new Promise((r) => setTimeout(r, 0))

async function main() {
// ---------- 1. 基本读写 ----------
section('1. 创建 / 读取 / 更新 / 收尾')
{
  const q = createTaskQueue({ idPrefix: 't' })
  let emits = 0
  q.watch(() => { emits++ })
  ok(emits === 1, 'watch 订阅时立即回调一次')
  ok(q.size() === 0, '初始为空')

  const task = q.create({ phase: 'scanning', done: 0 })
  ok(!!task.id && typeof task.startedAt === 'number', 'create 返回带 id 与 startedAt 的任务')
  ok(emits === 1, 'create 不广播(需要时显式 emit)')
  ok(q.get(task.id) === task, 'get 返回同一对象')
  ok(q.list().length === 1, 'list 能看到新任务')

  q.emit()
  ok(emits === 2, '显式 emit 广播一次')

  q.patch(task, { phase: 'packing', done: 3 })
  ok(task.phase === 'packing' && task.done === 3, 'patch 更新字段')
  ok(emits === 3, 'patch 广播一次')

  q.finish(task, 'done')
  ok(task.phase === 'done', 'finish 写入终态')
  ok(typeof task.finishedAt === 'number', 'finish 记录 finishedAt')

  const t2 = q.create({ phase: 'scanning' })
  q.finish(t2, 'error', '炸了')
  ok(t2.phase === 'error' && t2.error === '炸了', 'finish 可带错误信息')
}

// ---------- 2. 快照隔离与排序 ----------
section('2. 快照是拷贝 + 排序')
{
  const q = createTaskQueue({ idPrefix: 't' })
  const a = q.create({ phase: 'p', n: 1 })
  const snap = q.list()
  snap[0].phase = '被订阅者改坏了'
  snap[0].n = 999
  ok(a.phase === 'p' && a.n === 1, '改快照不影响内部任务')
  ok(q.list()[0] !== snap[0], '两次 list 返回不同对象')

  const q2 = createTaskQueue({ idPrefix: 't', sortBy: 'startedAt' })
  const first = q2.create({ phase: 'p', startedAt: 200 })
  const second = q2.create({ phase: 'p', startedAt: 100 })
  const order = q2.list().map((t) => t.startedAt)
  ok(order[0] === 100 && order[1] === 200, 'sortBy 生效(升序)', order.join(','))
  ok(q2.list().length === 2 && !!first && !!second, '排序不影响任务数量')
}

// ---------- 3. 订阅 ----------
section('3. 订阅:立即回调 / 退订 / 异常隔离')
{
  const q = createTaskQueue({ idPrefix: 't' })
  const seen = []
  const unsub = q.watch((snaps) => seen.push(snaps.length))
  ok(seen.length === 1 && seen[0] === 0, '订阅时立即回调当前(空)快照')
  const t = q.create({ phase: 'p' })
  q.patch(t, { phase: 'q' })
  ok(seen.length === 2 && seen[1] === 1, '变更后收到新快照')
  unsub()
  q.patch(t, { phase: 'r' })
  ok(seen.length === 2, '退订后不再回调')

  // 一个监听器抛异常,不能影响其他监听器,也不能影响任务本身
  const q2 = createTaskQueue({ idPrefix: 't' })
  let goodCalls = 0
  q2.watch(() => { throw new Error('坏监听器') })
  q2.watch(() => { goodCalls++ })
  const t2 = q2.create({ phase: 'p' })
  let threw = false
  try {
    q2.patch(t2, { phase: 'q' })
  } catch (e) {
    threw = true
  }
  ok(!threw, '监听器抛异常不会冒泡给调用方')
  ok(goodCalls >= 2, '异常监听器不影响后续监听器', String(goodCalls))
  ok(t2.phase === 'q', '异常监听器不影响任务状态')
}

// ---------- 4. 终态与 dismiss ----------
section('4. dismiss:无终态概念 vs 仅终态可移除')
{
  // 未配置 terminalPhases:任何状态都能移除(install.js 的语义)
  const q = createTaskQueue({ idPrefix: 't' })
  const t = q.create({ status: 'downloading' })
  ok(q.dismiss(t.id) === true, '未配置终态时,进行中的任务也可移除')
  ok(q.get(t.id) === undefined, '移除后取不到')

  // 配置 terminalPhases:仅终态可移除(backup.js 的语义)
  const q2 = createTaskQueue({ idPrefix: 't', terminalPhases: TERMINAL_PHASES })
  const live = q2.create({ phase: 'packing' })
  ok(q2.dismiss(live.id) === false, '终态集合下,进行中的任务不可移除')
  ok(!!q2.get(live.id), '拒绝移除后任务仍在')
  q2.finish(live, 'canceled')
  ok(q2.dismiss(live.id) === true, '终态任务可移除')
  ok(q2.get(live.id) === undefined, '终态移除后取不到')
  ok(q2.dismiss('不存在') === false, '移除不存在的 id 返回 false')
}

// ---------- 5. 阶段字段名可配置 ----------
section('5. phaseField:写入与终态判断共用同一个字段名')
{
  const q = createTaskQueue({ idPrefix: 't', phaseField: 'status', terminalPhases: TERMINAL_PHASES })
  const t = q.create({ status: 'queued' })
  q.finish(t, 'done')
  ok(t.status === 'done', 'finish 写入配置的字段名(status)', String(t.status))
  ok(t.phase === undefined && t.done === undefined, '不会写出无关键名(如 task.done)')
  ok(q.dismiss(t.id) === true, '终态判断读的是同一个字段')
}

// ---------- 6. 取消令牌 ----------
section('6. 取消令牌登记')
{
  const q = createTaskQueue({ idPrefix: 't', terminalPhases: TERMINAL_PHASES })
  const t = q.create({ phase: 'p' })
  const token = { cancel: () => true }
  q.setToken(t.id, token)
  ok(q.tokenOf(t.id) === token, 'setToken / tokenOf 命中')
  q.clearToken(t.id)
  ok(q.tokenOf(t.id) === undefined, 'clearToken 后取不到')
  q.setToken(t.id, token)
  q.finish(t, 'done')
  q.dismiss(t.id)
  ok(q.tokenOf(t.id) === undefined, 'dismiss 一并清掉令牌(不留悬挂引用)')
}

// ---------- 7. 执行 ----------
section('7. enqueue:串行 / 立即')
{
  const q = createTaskQueue({ idPrefix: 't', serial: true })
  const order = []
  let releaseFirst
  const gate = new Promise((r) => { releaseFirst = r })
  q.enqueue(async () => { order.push('a-start'); await gate; order.push('a-end') })
  q.enqueue(async () => { order.push('b-start') })
  await tick()
  ok(order.join(',') === 'a-start', '串行:第二个作业等第一个 await 完才启动', order.join(','))
  releaseFirst()
  await tick()
  await tick()
  ok(order.join(',') === 'a-start,a-end,b-start', '串行:按入队顺序依次执行', order.join(','))

  const q2 = createTaskQueue({ idPrefix: 't', serial: false })
  const order2 = []
  q2.enqueue(async () => { order2.push('x') })
  q2.enqueue(async () => { order2.push('y') })
  await tick()
  ok(order2.join(',') === 'x,y', '非串行:立即执行', order2.join(','))
}

// ---------- 8. id 生成 ----------
section('8. id 生成')
{
  const q = createTaskQueue({ idPrefix: 'bt' })
  const a = q.create({})
  const b = q.create({})
  ok(/^bt-/.test(a.id), '默认 id 带配置的前缀', a.id)
  ok(a.id !== b.id, 'id 互不相同')

  const q2 = createTaskQueue({ makeId: () => `dl-${Date.now()}` })
  ok(/^dl-\d+$/.test(q2.create({}).id), 'makeId 可覆盖(id 形状与旧实现保持一致)')
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
}

main().catch((e) => {
  console.error('\n未捕获异常:', e)
  process.exit(1)
})
