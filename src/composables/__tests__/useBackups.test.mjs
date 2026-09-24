// useBackups 派生逻辑回归测试。
//
// useBackups 依赖 Vue 响应式与 .ts 源码,Node 无法直接 import,因此先用 vite 把它打成一个
// 自包含 ESM 包(build-bundle.mjs),再在这里桩掉 window.services / window.ztools.db 后
// 驱动**真实的组合式函数**,验证筛选、分组、时间轴、未备份项目、批量选择、巡检与批量备份。
//
// 用法(npm script 会先跑打包步骤):
//   npm run test:composable
//   node src/composables/__tests__/build-bundle.mjs && node src/composables/__tests__/useBackups.test.mjs
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
/** 默认读取 vite 打包产物(<项目根>/.gpm-test/out/usebackups.mjs) */
const DEFAULT_BUNDLE = path.resolve(__dirname, '../../../.gpm-test/out/usebackups.mjs')
const BUNDLE = process.argv[2] || DEFAULT_BUNDLE

if (!existsSync(BUNDLE)) {
  console.error(`找不到打包产物: ${BUNDLE}`)
  console.error('请先运行: node src/composables/__tests__/build-bundle.mjs')
  process.exit(2)
}

const DAY = 86400000
const now = Date.now()
const today = new Date()
const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()

// ---------- 夹具 ----------
const PROJECTS = [
  { _id: 'godot/project/aaa', id: 'aaa', path: 'E:\\Godot项目\\Alpha', name: 'Alpha', configVersion: 5, favorite: false, openCount: 0, addedAt: now - 5 * DAY },
  { _id: 'godot/project/bbb', id: 'bbb', path: 'E:\\Godot项目\\Beta', name: 'Beta', configVersion: 5, favorite: false, openCount: 0, addedAt: now - 5 * DAY },
  { _id: 'godot/project/ccc', id: 'ccc', path: 'E:\\Godot项目\\Gamma', name: 'Gamma', configVersion: 5, favorite: false, openCount: 0, addedAt: now - 5 * DAY }
]

let RECORDS = [
  { _id: 'b1', projectId: 'godot/project/aaa', projectName: 'Alpha', mode: 'zip', destPath: 'E:\\Backups\\Alpha_发布前.zip', size: 1000, fileCount: 10, createdAt: startOfToday + 3600000, label: '发布前', level: 6, missing: false },
  { _id: 'b2', projectId: 'godot/project/aaa', projectName: 'Alpha', mode: 'copy', destPath: 'E:\\Backups\\Alpha_snap', size: 4000, fileCount: 40, createdAt: startOfToday + 1800000, missing: false },
  { _id: 'b3', projectId: 'godot/project/aaa', projectName: 'Alpha', mode: 'zip', destPath: 'E:\\Backups\\Alpha_old.zip', size: 900, fileCount: 9, createdAt: startOfToday - 3 * DAY, missing: false },
  { _id: 'b4', projectId: 'godot/project/aaa', projectName: 'Alpha', mode: 'zip', destPath: 'E:\\Backups\\Alpha_ancient.zip', size: 800, fileCount: 8, createdAt: startOfToday - 20 * DAY, missing: false },
  { _id: 'b5', projectId: 'godot/project/bbb', projectName: 'Beta', mode: 'zip', destPath: 'E:\\Backups\\Beta_昨天.zip', size: 2000, fileCount: 20, createdAt: startOfToday - DAY + 3600000, missing: false },
  { _id: 'b6', projectId: 'godot/project/gone', projectName: '已删除的项目', mode: 'zip', destPath: 'E:\\Backups\\Gone.zip', size: 300, fileCount: 3, createdAt: startOfToday - 5 * DAY, missing: false },
  { _id: 'b7', projectId: 'godot/project/aaa', projectName: 'Alpha', mode: 'copy', destPath: 'E:\\Backups\\Alpha_lost', size: 500, fileCount: 5, createdAt: startOfToday + 600000, missing: true }
]

const stats = () => {
  const covered = new Set()
  let totalSize = 0, missingCount = 0, zip = 0, copy = 0
  for (const r of RECORDS) {
    totalSize += r.size || 0
    if (r.mode === 'copy') copy++; else zip++
    if (r.missing) missingCount++
    covered.add(r.projectId)
  }
  let coveredProjects = 0
  for (const p of PROJECTS) if (covered.has(p._id)) coveredProjects++
  return { count: RECORDS.length, totalSize, missingCount, coveredProjects, totalProjects: PROJECTS.length, byMode: { zip, copy } }
}

const notifications = []
// 内存版文档库:bridge 的 getDoc/listDocs/getSettings 都走这里
const dbDocs = new Map()
for (const p of PROJECTS) dbDocs.set(p._id, { ...p })

global.window = {
  services: {
    listBackups: () => RECORDS.map((r) => ({ ...r })),
    backupStats: stats,
    updateBackup: (id, patch) => {
      const rec = RECORDS.find((r) => r._id === id)
      if (!rec) return { ok: false, error: '备份记录不存在' }
      if ('label' in patch) {
        const next = String(patch.label || '').trim()
        if (next) rec.label = next
        else delete rec.label
      }
      return { ok: true }
    },
    verifyBackup: (id) => {
      const rec = RECORDS.find((r) => r._id === id)
      if (!rec) return { ok: false, valid: false, error: '备份记录不存在' }
      const valid = !rec.missing
      rec.verified = valid
      rec.verifyError = valid ? undefined : '备份文件已不存在'
      return { ok: true, valid, error: rec.verifyError }
    },
    deleteBackup: (id) => {
      const i = RECORDS.findIndex((r) => r._id === id)
      if (i < 0) return { ok: false, error: '备份记录不存在' }
      RECORDS.splice(i, 1)
      return { ok: true }
    },
    deleteBackups: (ids) => {
      let removed = 0
      const failed = []
      for (const id of ids) {
        const i = RECORDS.findIndex((r) => r._id === id)
        if (i < 0) failed.push({ id, error: '备份记录不存在' })
        else { RECORDS.splice(i, 1); removed++ }
      }
      return { ok: failed.length === 0, removed, failed }
    },
    listBackupTasks: () => []
  },
  ztools: {
    db: {
      get: (id) => (dbDocs.has(id) ? { ...dbDocs.get(id) } : null),
      put: (doc) => {
        dbDocs.set(doc._id, { ...doc })
        return { ok: true }
      },
      remove: (doc) => {
        dbDocs.delete(doc._id)
        return { ok: true }
      },
      allDocs: (prefix) =>
        [...dbDocs.values()].filter((d) => d._id.startsWith(prefix)).map((d) => ({ ...d }))
    },
    showNotification: (body) => notifications.push(body)
  }
}

// ---------- 断言 ----------
let pass = 0
const failures = []
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log(`  PASS  ${label}`) }
  else { failures.push(label); console.log(`  FAIL  ${label}${extra !== undefined ? '  → ' + extra : ''}`) }
}
const section = (t) => console.log(`\n=== ${t} ===`)

const { useBackups } = await import(pathToFileURL(BUNDLE).href)

const bk = useBackups()
bk.refresh()

// ---------- 1 ----------
section('1. 加载与统计')
ok(bk.records.value.length === 7, `载入 7 条备份(实际 ${bk.records.value.length})`)
ok(bk.projects.value.length === 3, '载入 3 个项目')
ok(bk.stats.value.count === 7, 'stats.count = 7')
ok(bk.stats.value.totalSize === 1000 + 4000 + 900 + 800 + 2000 + 300 + 500, 'stats.totalSize 累加正确')
ok(bk.stats.value.missingCount === 1, 'stats.missingCount = 1')
ok(bk.stats.value.coveredProjects === 2, `覆盖项目数 = 2(实际 ${bk.stats.value.coveredProjects})`)
ok(bk.stats.value.totalProjects === 3, '项目总数 = 3')
ok(bk.stats.value.byMode.zip === 5 && bk.stats.value.byMode.copy === 2, `byMode zip=${bk.stats.value.byMode.zip} copy=${bk.stats.value.byMode.copy}`)
const sc = bk.statusCounts.value
ok(sc.all === 7 && sc.zip === 5 && sc.copy === 2 && sc.missing === 1 && sc.uncovered === 1,
  `筛选计数 all/zip/copy/missing/uncovered = ${sc.all}/${sc.zip}/${sc.copy}/${sc.missing}/${sc.uncovered}`)

// ---------- 2 ----------
section('2. 默认排序与筛选')
ok(bk.filtered.value[0]._id === 'b1', '默认按时间倒序,最新一条在前')
ok(bk.filtered.value.every((r, i, a) => i === 0 || (a[i - 1].createdAt || 0) >= (r.createdAt || 0)), '严格时间倒序')
bk.status.value = 'zip'
ok(bk.filtered.value.length === 5 && bk.filtered.value.every((r) => r.mode === 'zip'), 'zip 筛选')
bk.status.value = 'copy'
ok(bk.filtered.value.length === 2 && bk.filtered.value.every((r) => r.mode === 'copy'), '快照筛选')
bk.status.value = 'missing'
ok(bk.filtered.value.length === 1 && bk.filtered.value[0]._id === 'b7', '缺失筛选')
bk.status.value = 'uncovered'
ok(bk.filtered.value.length === 0, 'uncovered 筛选下不列备份记录')
bk.status.value = 'all'

// ---------- 3 ----------
section('3. 关键词搜索(备注 / 项目名 / 路径)')
bk.keyword.value = '发布前'
ok(bk.filtered.value.length === 1 && bk.filtered.value[0]._id === 'b1', '按备注名搜索')
bk.keyword.value = 'beta'
ok(bk.filtered.value.length === 1 && bk.filtered.value[0]._id === 'b5', '按项目名搜索(大小写不敏感)')
bk.keyword.value = 'ancient'
ok(bk.filtered.value.length === 1 && bk.filtered.value[0]._id === 'b4', '按路径搜索')
bk.keyword.value = '不存在的关键词'
ok(bk.filtered.value.length === 0, '无匹配时返回空')
bk.keyword.value = ''

// ---------- 4 ----------
section('4. 排序切换')
bk.sort.value = 'size'
ok(bk.filtered.value[0]._id === 'b2', '按体积降序,最大一条在前')
ok(bk.filtered.value[0].size >= bk.filtered.value[1].size, '体积单调不增')
bk.sort.value = 'project'
const names = bk.filtered.value.map((r) => r.projectName)
ok(names.join('|') === [...names].sort((a, b) => a.localeCompare(b)).join('|'), '按项目名排序')
bk.sort.value = 'time'

// ---------- 5 ----------
section('5. 按项目分组')
const groups = bk.groups.value
ok(groups.length === 3, `3 个分组(Alpha / Beta / 孤立)(实际 ${groups.length})`)
ok(groups[0].name === 'Alpha' && groups[0].records.length === 5, `Alpha 组 5 份(实际 ${groups[0].records.length})`)
ok(groups[0].totalSize === 1000 + 4000 + 900 + 800 + 500, `Alpha 组体积合计正确(${groups[0].totalSize})`)
ok(groups[0].latestAt === startOfToday + 3600000, 'Alpha 组最新时间为当天 01:00')
ok(groups[0].records[0]._id === 'b1', '组内按时间倒序')
ok(groups[2].orphan === true && groups[2].name === '已删除的项目', '孤立备份排最后且标记 orphan')
ok(groups[1].orphan === false, 'Beta 组非孤立')

// ---------- 6 ----------
section('6. 时间轴分桶')
const tl = bk.timeline.value
const tlMap = Object.fromEntries(tl.map((b) => [b.key, b]))
ok(!!tlMap.today && tlMap.today.records.length === 3, `今天 3 份(实际 ${tlMap.today?.records.length})`)
ok(!!tlMap.yesterday && tlMap.yesterday.records.length === 1, `昨天 1 份(实际 ${tlMap.yesterday?.records.length})`)
ok(!!tlMap.week && tlMap.week.records.length === 2, `最近 7 天 2 份(实际 ${tlMap.week?.records.length})`)
ok(!!tlMap.older && tlMap.older.records.length === 1, `更早 1 份(实际 ${tlMap.older?.records.length})`)
ok(tl.length === 4 && tl[0].key === 'today' && tl[3].key === 'older', '分桶顺序 今天→昨天→最近7天→更早')

// ---------- 7 ----------
section('7. 未备份项目')
const un = bk.uncovered.value
ok(un.length === 1 && un[0]._id === 'godot/project/ccc', `只有 Gamma 未备份(实际 ${un.map((p) => p.name).join(',')})`)
bk.keyword.value = 'gamma'
ok(bk.uncovered.value.length === 1, '未备份列表支持关键词过滤')
bk.keyword.value = 'alpha'
ok(bk.uncovered.value.length === 0, '已备份项目不出现在未备份列表')
bk.keyword.value = ''

// ---------- 8 ----------
section('8. 项目范围限定(项目页跳转)')
bk.scopedProjectId.value = 'godot/project/aaa'
ok(bk.filtered.value.length === 5 && bk.filtered.value.every((r) => r.projectId === 'godot/project/aaa'), '限定后有 5 条')
ok(bk.scopedProject.value?.name === 'Alpha', 'scopedProject 解析出项目名')
ok(bk.groups.value.length === 1, '限定后只有 1 个分组')
bk.status.value = 'copy'
ok(bk.filtered.value.length === 2, '限定范围与模式筛选可叠加')
bk.status.value = 'all'
bk.scopedProjectId.value = ''
ok(bk.filtered.value.length === 7, '清除限定后恢复全部')

// ---------- 9 ----------
section('9. 批量选择')
ok(bk.selected.value.length === 0 && bk.batchMode.value === false, '初始未进入批量')
bk.enterBatch()
ok(bk.batchMode.value === true, 'enterBatch 生效')
bk.toggleSelectAll()
ok(bk.selected.value.length === 7, `全选 7 条(实际 ${bk.selected.value.length})`)
ok(bk.allSelected.value === true, 'allSelected 为 true')
ok(bk.selectedSize.value === bk.stats.value.totalSize, '选中体积合计等于总占用')
bk.toggleSelect('b1')
ok(bk.selected.value.length === 6 && bk.allSelected.value === false, '取消单条后 allSelected 变为 false')
bk.toggleSelect('b1')
ok(bk.selected.value.length === 7, '再次勾选恢复')
bk.keyword.value = 'beta'
ok(bk.selected.value.length === 7, '切换筛选不影响已有选择')
bk.toggleSelectAll()
ok(bk.selected.value.length === 6 && !bk.selected.value.includes('b5'),
  `已全选时取消全选只移除列表内的项(剩 ${bk.selected.value.length},含 b5=${bk.selected.value.includes('b5')})`)
bk.toggleSelectAll()
ok(bk.selected.value.length === 7, '再次全选把列表加回(并集)')
bk.keyword.value = ''
bk.exitBatch()
ok(bk.batchMode.value === false && bk.selected.value.length === 0, 'exitBatch 清空选择')
bk.enterBatch()
bk.keyword.value = 'beta'
bk.toggleSelectAll()
ok(bk.selected.value.length === 1 && bk.selected.value[0] === 'b5',
  `空选择时全选只选中列表内的 1 条(实际 ${bk.selected.value.length})`)
bk.keyword.value = ''
bk.exitBatch()

// ---------- 10 ----------
section('10. 备注 / 校验 / 删除')
ok(bk.setLabel('b2', '备份快照 01') === true, 'setLabel 返回成功')
ok(bk.records.value.find((r) => r._id === 'b2').label === '备份快照 01', '本地记录已更新备注')
ok(bk.setLabel('b2', '') === true, '清除备注成功')
ok(bk.records.value.find((r) => r._id === 'b2').label === undefined, '备注已移除')
ok(bk.setLabel('nope', 'x') === false, '不存在的记录返回 false 并通知')
ok(notifications.some((n) => /备注保存失败|不存在/.test(n)), '失败时弹出通知')

const vr = bk.verify('b1')
ok(vr.valid === true && bk.records.value.find((r) => r._id === 'b1').verified === true, '校验有效并写回本地')
const vr2 = bk.verify('b7')
ok(vr2.valid === false && bk.records.value.find((r) => r._id === 'b7').verified === false, '缺失备份校验为无效')
const vm = bk.verifyMany(['b1', 'b5', 'b7'])
ok(vm.valid === 2 && vm.invalid === 1, `批量校验 2 有效 / 1 无效(实际 ${vm.valid}/${vm.invalid})`)

const removed = bk.removeMany(['b1', 'b3'])
ok(removed === 2, `批量删除 2 条(实际 ${removed})`)
ok(bk.records.value.length === 5, `刷新后剩 5 条(实际 ${bk.records.value.length})`)
ok(bk.stats.value.count === 5, '统计同步刷新')
ok(bk.removeOne('b5') === true, '单条删除成功')
ok(bk.records.value.length === 4, '单条删除后剩 4 条')

// ---------- 11 ----------
section('11. 折叠状态')
ok(bk.isCollapsed('godot/project/aaa') === false, '默认展开')
bk.toggleGroup('godot/project/aaa')
ok(bk.isCollapsed('godot/project/aaa') === true, 'toggleGroup 折叠')
bk.toggleGroup('godot/project/aaa')
ok(bk.isCollapsed('godot/project/aaa') === false, '再次 toggle 展开')

// ---------- 12 ----------
section('12. 全空数据不崩')
RECORDS = []
bk.refresh()
ok(bk.records.value.length === 0 && bk.groups.value.length === 0, '空数据下 groups 为空')
ok(bk.timeline.value.length === 0, '空数据下 timeline 为空')
ok(bk.uncovered.value.length === 3, '无任何备份时 3 个项目都算未备份')
ok(bk.stats.value.missingCount === 0 && bk.stats.value.totalSize === 0, '空数据统计归零')
ok(bk.allSelected.value === false, '空数据下 allSelected 为 false')

// ---------- 13 ----------
section('13. 后台巡检')
RECORDS = [
  { _id: 'p1', projectId: 'godot/project/aaa', projectName: 'Alpha', mode: 'zip', destPath: 'E:\\Backups\\p1.zip', size: 100, fileCount: 1, createdAt: now - 1000 },
  { _id: 'p2', projectId: 'godot/project/aaa', projectName: 'Alpha', mode: 'copy', destPath: 'E:\\Backups\\p2', size: 200, fileCount: 2, createdAt: now - 2000 },
  { _id: 'p3', projectId: 'godot/project/bbb', projectName: 'Beta', mode: 'zip', destPath: 'E:\\Backups\\p3.zip', size: 300, fileCount: 3, createdAt: now - 3000, missing: true },
  { _id: 'p4', projectId: 'godot/project/bbb', projectName: 'Beta', mode: 'zip', destPath: 'E:\\Backups\\p4.zip', size: 400, fileCount: 4, createdAt: now - 4000, verified: true, missing: false }
]
bk.refresh()
const unverified = bk.records.value.filter((r) => r.verified === undefined).length
ok(unverified === 3, `巡检前 3 条未校验(实际 ${unverified})`)
await bk.patrol()
ok(bk.patrolTotal.value === 3 && bk.patrolDone.value === 3, `巡检处理 3 条(实际 ${bk.patrolDone.value}/${bk.patrolTotal.value})`)
ok(bk.records.value.every((r) => r.verified !== undefined), '巡检后所有记录都有校验结论')
ok(bk.records.value.find((r) => r._id === 'p3').verified === false, '缺失记录被判为无效')
ok(bk.records.value.find((r) => r._id === 'p1').verified === true, '正常记录被判为有效')
await bk.patrol()
ok(bk.patrolTotal.value === 0, '二次巡检无需重复校验(缺失记录已判定)')

// ---------- 14 ----------
section('14. 批量备份')
dbDocs.delete('godot/settings')
const r1 = await bk.backupMany(['godot/project/aaa'])
ok(r1.ok === false && /备份目录/.test(r1.error || ''), `未配置默认目录时给出明确错误(${r1.error})`)

dbDocs.set('godot/settings', {
  _id: 'godot/settings',
  backupRoot: 'E:\\Backups',
  backupMode: 'copy',
  backupLevel: 9,
  backupIncludeCache: true,
  backupExclude: ['build']
})
const calls = []
window.services.backupProject = async (id, opts) => {
  calls.push({ id, ...opts })
  if (id === 'godot/project/bbb') throw new Error('磁盘已满')
  return { _id: 'r-' + id, projectId: id, projectName: 'x', mode: opts.mode, destPath: 'p', size: 1, fileCount: 1, createdAt: Date.now() }
}
const prog = []
const r2 = await bk.backupMany(
  ['godot/project/aaa', 'godot/project/bbb', 'godot/project/ccc'],
  (done, total, name) => prog.push(`${done}/${total}:${name}`)
)
ok(r2.ok === true && r2.count === 2, `3 个项目中成功 2 个,单个失败不中断(实际 ${r2.count})`)
ok(calls.length === 3, '三个项目都被尝试过')
ok(calls[0].mode === 'copy' && calls[0].level === 9, `沿用设置的默认方式与级别(${calls[0].mode}/L${calls[0].level})`)
ok(calls[0].destDir === 'E:\\Backups' && calls[0].includeCache === true, '使用默认目录与缓存设置')
ok(JSON.stringify(calls[0].exclude) === '["build"]', '沿用默认排除项')
ok(prog.length === 4 && prog[0].startsWith('0/3') && prog[3].startsWith('3/3'), `进度回调覆盖开始与收尾(${prog.join(' ')})`)
const r3 = await bk.backupMany([])
ok(r3.ok === true && r3.count === 0, '空列表安全返回')

// ---------- 结果 ----------
console.log(`\n${'='.repeat(56)}`)
console.log(`PASS ${pass}  FAIL ${failures.length}`)
if (failures.length) {
  console.log('失败项:')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log('全部通过')
