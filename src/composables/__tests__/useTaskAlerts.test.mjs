// 到期感知数据层测试:useTaskAlerts(跨看板统计逾期/今日未完成卡)。
//
// 用 db 桩锁住:refresh 扫 godot/taskboard/ 前缀全部文档、normalizeBoard 宽容读取、
// 统计口径与 countDue 一致(排除已完成卡);宿主异常时保持上次统计。
//
// 用法(npm script 会先跑打包步骤):
//   npm run test:renderer
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.resolve(__dirname, '../../../.gpm-test/out')
const BUNDLE = path.join(OUT, 'usetaskalerts.mjs')

if (!existsSync(BUNDLE)) {
  console.error(`找不到打包产物: ${BUNDLE}`)
  console.error('请先运行: node src/composables/__tests__/build-bundle.mjs')
  process.exit(2)
}

// ---------- 桩:window.ztools.db(内存 Map) ----------

const docs = new Map()
let failAllDocs = false

const dbApi = {
  get: (id) => (docs.has(id) ? { ...docs.get(id) } : null),
  put: (doc) => {
    if (!doc || !doc._id) return { error: 'no id' }
    docs.set(doc._id, { ...doc, _rev: 'r1' })
    return { ok: true, id: doc._id }
  },
  remove: (doc) => {
    docs.delete(doc._id)
    return { ok: true }
  },
  allDocs: (prefix) => {
    if (failAllDocs) throw new Error('stub: host not ready')
    return [...docs.values()].filter((d) => d._id.startsWith(prefix)).map((d) => ({ ...d }))
  }
}

global.window = { ztools: { db: dbApi } }

function seedBoard(id, cards) {
  docs.set(id, { _id: id, schema: 1, columns: [{ id: `${id}-c1`, title: '待办', cards }], updatedAt: 1 })
}
function card(id, title, extra = {}) {
  return { id, title, createdAt: 1, updatedAt: 1, ...extra }
}
/** 本地时区的今天(与 taskBoard.todayStr 同口径;toISOString 是 UTC,时区差会翻车) */
function localToday() {
  const n = new Date()
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`
}

let pass = 0
const failures = []
function ok(cond, label, extra) {
  if (cond) {
    pass++
    console.log(`  PASS  ${label}`)
  } else {
    failures.push(label)
    console.log(`  FAIL  ${label}${extra !== undefined ? '  → ' + JSON.stringify(extra) : ''}`)
  }
}
function section(t) {
  console.log(`\n=== ${t} ===`)
}

async function main() {
  section('refresh:跨板汇总逾期/今日,排除已完成')
  docs.clear()
  seedBoard('godot/taskboard/global', [
    card('A', '逾期', { due: '2000-01-01' }),
    card('B', '逾期已完成', { due: '2000-01-01', done: true }),
    card('C', '今日', { due: localToday() })
  ])
  seedBoard('godot/taskboard/godot/project/p1', [card('D', '项目板逾期', { due: '1999-12-31' })])
  seedBoard('godot/taskboard/godot/project/p2', [card('E', '三天内不算', { due: '2999-01-01' })])
  docs.set('godot/project/p1', { _id: 'godot/project/p1', name: '项目一' })
  const { useTaskAlerts } = await import(`${pathToFileURL(BUNDLE).href}?fresh=1`)
  const alerts = useTaskAlerts()
  await alerts.refresh()
  ok(alerts.stats.value.overdue === 2 && alerts.stats.value.today === 1, '跨板汇总(逾期 2 + 今日 1)', alerts.stats.value)

  section('总览条目:分节、来源板名与排序')
  const ov = alerts.overviewEntries.value
  ok(ov.length === 3, '只收逾期/今日卡(排除已完成与远期)', ov.length)
  ok(ov[0].card.id === 'D' && ov[1].card.id === 'A' && ov[2].card.id === 'C', '节序 overdue→today,节内按截止日升序', ov.map((e) => e.card.id))
  ok(ov[2].section === 'today' && ov[0].section === 'overdue', '分节标记正确')
  ok(ov.find((e) => e.card.id === 'D')?.boardName === '项目一', '项目板显示项目名')
  ok(ov.find((e) => e.card.id === 'A')?.boardName === '通用看板', '通用板名称')
  ok(alerts.ready.value === true, '首次成功扫描后 ready')

  section('refresh:坏文档跳过、空库归零')
  docs.set('godot/taskboard/broken', { _id: 'godot/taskboard/broken', columns: 'bad' })
  await alerts.refresh()
  ok(alerts.stats.value.overdue === 2 && alerts.stats.value.today === 1, '坏文档不影响统计', alerts.stats.value)
  docs.clear()
  await alerts.refresh()
  ok(alerts.stats.value.overdue === 0 && alerts.stats.value.today === 0, '清库后归零', alerts.stats.value)
  ok(alerts.overviewEntries.value.length === 0, '清库后总览清空', alerts.overviewEntries.value.length)

  section('refresh:宿主异常保持上次统计')
  docs.set('godot/taskboard/global', { _id: 'godot/taskboard/global', schema: 1, columns: [{ id: 'c', title: '待办', cards: [card('F', '逾期', { due: '2000-01-01' })] }], updatedAt: 1 })
  await alerts.refresh()
  ok(alerts.stats.value.overdue === 1, '异常前先算出 1', alerts.stats.value)
  failAllDocs = true
  await alerts.refresh()
  ok(alerts.stats.value.overdue === 1, 'allDocs 抛错保持上次统计', alerts.stats.value)

  console.log(`\n结果: ${pass} 通过, ${failures.length} 失败`)
  if (failures.length) {
    console.error('失败项:\n - ' + failures.join('\n - '))
    process.exit(1)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
