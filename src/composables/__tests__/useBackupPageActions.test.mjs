// useBackupPageActions 回归测试:备份页的删除确认与批量备份。
//
// 备份页的列表逻辑早已在 useBackups 里,这个组合式函数只收拢「带判断」的两块:
//   · 删除确认文案要区分「文件还在」(真删文件)与「文件已丢失」(只是清数据库记录)
//   · 批量备份要能报告进度、如实反馈成功数、并在设置缺备份目录时给出可操作的错误
//
// 用法(npm script 会先跑打包步骤):
//   npm run test:renderer
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.resolve(__dirname, '../../../.gpm-test/out')

for (const name of ['usebackuppageactions', 'vueshim']) {
  if (!existsSync(path.join(OUT, `${name}.mjs`))) {
    console.error(`找不到打包产物: ${path.join(OUT, `${name}.mjs`)}`)
    console.error('请先运行: node src/composables/__tests__/build-bundle.mjs')
    process.exit(2)
  }
}

const { ref } = await import(pathToFileURL(path.join(OUT, 'vueshim.mjs')).href)
const { useBackupPageActions } = await import(pathToFileURL(path.join(OUT, 'usebackuppageactions.mjs')).href)

// ---------- 桩 ----------
const removed = []
let backupManyImpl = null
const notifications = []
let exitBatchCalls = 0

function reset() {
  removed.length = 0
  notifications.length = 0
  exitBatchCalls = 0
  backupManyImpl = async (ids, onProgress) => {
    for (let i = 0; i < ids.length; i++) onProgress?.(i, ids.length, `P${i}`)
    return { ok: true, count: ids.length }
  }
}

const REC = (id, over = {}) => ({
  _id: id,
  projectId: 'godot/project/p1',
  projectName: 'Alpha',
  label: '',
  mode: 'zip',
  destPath: `E:\\Backups\\${id}.zip`,
  size: 1024,
  missing: false,
  ...over
})

function make(over = {}) {
  const uncovered = over.uncovered || ref([])
  const selectedRecords = over.selectedRecords || ref([])
  const batchMode = over.batchMode || ref(false)
  const a = useBackupPageActions({
    uncovered,
    selectedRecords,
    batchMode,
    exitBatch: () => { exitBatchCalls++ },
    removeOne: (id) => removed.push(id),
    removeMany: (ids) => removed.push(...ids),
    backupMany: (ids, onProgress) => backupManyImpl(ids, onProgress),
    notify: (m) => notifications.push(m)
  })
  return { a, uncovered, selectedRecords, batchMode }
}

let pass = 0
const failures = []
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log(`  PASS  ${label}`) }
  else { failures.push(label); console.log(`  FAIL  ${label}  → ${extra}`) }
}
const section = (t) => console.log(`\n=== ${t} ===`)
const sleep = (ms = 0) => new Promise((r) => setTimeout(r, ms))

async function main() {
  // ---------- 1. 单个删除确认 ----------
  section('1. askRemove + doRemove')
  {
    reset()
    const { a, batchMode } = make()
    ok(a.removeOpen.value === false, '初始不显示确认框')
    a.askRemove(REC('b1'))
    ok(a.removeOpen.value === true, 'askRemove 打开确认框')
    ok(a.removeTargets.value.length === 1, '记录待删除项')
    a.doRemove()
    ok(removed.join(',') === 'b1', '单个删除走 removeOne', removed.join(','))
    ok(a.removeOpen.value === false, '确认后关闭')
    ok(a.removeTargets.value.length === 0, '清空待删除项')
    ok(a.removeBusy.value === false, 'busy 复位')
    ok(batchMode.value === false || exitBatchCalls === 0, '非批量模式不触发 exitBatch')
  }

  // ---------- 2. 批量删除确认 ----------
  section('2. askRemoveSelected + doRemove')
  {
    reset()
    const selectedRecords = ref([REC('b1'), REC('b2')])
    const batchMode = ref(true)
    const { a } = make({ selectedRecords, batchMode })
    a.askRemoveSelected()
    ok(a.removeTargets.value.length === 2, '把选中的记录都放进待删除')
    a.doRemove()
    ok(removed.sort().join(',') === 'b1,b2', '多个走 removeMany', removed.join(','))
    ok(exitBatchCalls === 1, '批量模式下删除后退出批量', String(exitBatchCalls))

    // 没有选中项:不打开
    reset()
    const empty = make({ selectedRecords: ref([]) })
    empty.a.askRemoveSelected()
    ok(empty.a.removeOpen.value === false, '未选中任何记录时不打开确认框')

    // 传给 removeMany 的必须是副本(不能改到外部数组)
    reset()
    const sel = ref([REC('b9')])
    const m = make({ selectedRecords: sel })
    m.a.askRemoveSelected()
    ok(m.a.removeTargets.value !== sel.value && m.a.removeTargets.value[0]._id === 'b9', '待删除项是副本')
  }

  // ---------- 3. 文案:文件还在 ----------
  section('3. removeMessage:文件还在 → 真删文件')
  {
    reset()
    const { a } = make()
    a.askRemove(REC('b1', { size: 2048 }))
    ok(/将删除这份备份/.test(a.removeMessage.value), '单份文案', a.removeMessage.value)
    ok(/2\.0 KB/.test(a.removeMessage.value), '带上体积', a.removeMessage.value)
    ok(/回收站/.test(a.removeMessage.value), '说明 Windows 下可恢复', a.removeMessage.value)

    a.removeTargets.value = [REC('b1', { size: 1024 }), REC('b2', { size: 1024 })]
    ok(/将删除 2 份备份/.test(a.removeMessage.value), '多份文案', a.removeMessage.value)
    ok(/合计 2\.0 KB/.test(a.removeMessage.value), '多份时合计体积', a.removeMessage.value)
    ok(a.allMissing.value === false, 'mixed 时 allMissing 为假')
  }

  // ---------- 4. 文案:文件已丢失 ----------
  section('4. removeMessage:文件已丢失 → 只清记录')
  {
    reset()
    const { a } = make()
    a.askRemove(REC('b1', { missing: true }))
    ok(a.allMissing.value === true, '单份缺失 → allMissing')
    ok(/只移除数据库里的记录/.test(a.removeMessage.value), '单份缺失文案', a.removeMessage.value)
    ok(!/回收站/.test(a.removeMessage.value), '缺失时不提回收站(不会真删文件)')

    a.removeTargets.value = [REC('b1', { missing: true }), REC('b2', { missing: true })]
    ok(/这 2 份备份的文件均已不存在/.test(a.removeMessage.value), '多份缺失文案', a.removeMessage.value)

    // 只要有一份还在,就按「真删文件」提示
    a.removeTargets.value = [REC('b1', { missing: true }), REC('b2', { missing: false })]
    ok(a.allMissing.value === false, '有一份存在就不是 allMissing')
    ok(/将删除 2 份备份/.test(a.removeMessage.value), '混合时按真删文件提示', a.removeMessage.value)

    // 空列表
    a.removeTargets.value = []
    ok(a.allMissing.value === false, '空列表 allMissing 为假')
  }

  // ---------- 5. 明细 ----------
  section('5. removeDetails')
  {
    reset()
    const { a } = make()
    a.askRemove(REC('b1', { label: '发布前', size: 1024 }))
    ok(a.removeDetails.value.length === 1, '每条一行')
    ok(/发布前/.test(a.removeDetails.value[0]), '优先显示备注名', a.removeDetails.value[0])
    ok(/1\.0 KB/.test(a.removeDetails.value[0]), '带体积', a.removeDetails.value[0])
    ok(/E:\\Backups\\b1\.zip/.test(a.removeDetails.value[0]), '带路径', a.removeDetails.value[0])

    // 无备注名时回退项目名
    a.removeTargets.value = [REC('b2', { label: '', projectName: 'Gamma' })]
    ok(/Gamma/.test(a.removeDetails.value[0]), '无备注名时用项目名', a.removeDetails.value[0])
  }

  // ---------- 6. 批量备份 ----------
  section('6. backupAllUncovered')
  {
    reset()
    const uncovered = ref([{ _id: 'godot/project/p1' }, { _id: 'godot/project/p2' }])
    const { a } = make({ uncovered })
    await a.backupAllUncovered()
    ok(a.backingAll.value === false, '结束后复位 backingAll')
    ok(a.backAllProgress.value === '', '结束后清空进度文案')
    ok(/已为 2\/2 个项目创建备份/.test(notifications[0] || ''), '报告成功数', String(notifications[0]))

    // 进度文案:最后一次进度(done === total)不留文字
    reset()
    const seen = []
    backupManyImpl = async (ids, onProgress) => {
      for (let i = 0; i < ids.length; i++) {
        onProgress?.(i, ids.length, `P${i}`)
        seen.push('sync')
      }
      return { ok: true, count: ids.length }
    }
    const u2 = ref([{ _id: 'p1' }, { _id: 'p2' }, { _id: 'p3' }])
    const s = make({ uncovered: u2 })
    await s.a.backupAllUncovered()
    ok(seen.length === 3, '逐个报告进度')
    ok(s.a.backAllProgress.value === '', '最后一条进度(done=total)不写成文案')

    // 没有未备份项目:什么都不做
    reset()
    const n = make({ uncovered: ref([]) })
    await n.a.backupAllUncovered()
    ok(notifications.length === 0, '没有未备份项目时不提示')
    ok(n.a.backingAll.value === false, '也不进入执行态')

    // 失败:把服务端的错误原样透出(例如没配默认备份目录)
    reset()
    backupManyImpl = async () => ({ ok: false, error: '请先在「设置 → 备份与恢复」中配置默认备份目录', count: 0 })
    const f = make({ uncovered: ref([{ _id: 'p1' }]) })
    await f.a.backupAllUncovered()
    ok(/请先在/.test(notifications[0] || ''), '透出可操作的错误提示', String(notifications[0]))
    ok(f.a.backingAll.value === false, '失败也要复位执行态')

    // 并发保护:执行中再次调用被忽略
    reset()
    let release
    backupManyImpl = () => new Promise((res) => { release = () => res({ ok: true, count: 1 }) })
    const c = make({ uncovered: ref([{ _id: 'p1' }]) })
    const first = c.a.backupAllUncovered()
    await sleep()
    ok(c.a.backingAll.value === true, '第一次调用进行中')
    await c.a.backupAllUncovered()
    ok(notifications.length === 0, '进行中再次调用被忽略(不重复发起)')
    release()
    await first
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
