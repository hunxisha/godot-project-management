// 备份领域层回归测试。
//
// 在 Node 中桩掉 window.ztools.db,直接驱动 preload 模块本身(require 真实源码),验证:
//   分片让出事件循环、创建(zip/快照)、原子落盘、无残留、重复备份不覆盖、压缩级别、
//   统计、校验、备注、批量删除、清理预览、恢复(new/overwrite)、取消与终态、排除规则。
//
// 用法:
//   node src-ztools/preload/lib/__tests__/backup.test.js
//   node src-ztools/preload/lib/__tests__/backup.test.js --no-immediate
//   node src-ztools/preload/lib/__tests__/backup.test.js <libDir> <workDir> [--no-immediate]
//
// --no-immediate 会先删除 globalThis.setImmediate 再加载被测模块,用来模拟 ZTools preload
// 沙箱(那里没有 setImmediate 这个 Node 专有全局)。**两条路径都要跑**:只跑默认路径会漏掉
// 一整类「在 Node 里能跑、在宿主里报错」的问题(详见 docs/backup-redesign-plan.md §15)。
//
// 回收站:「真实删除 → 移入回收站」这条链路默认**跳过**。它会调用 Windows 资源管理器
// 的 SendToRecycleBin,每次运行都在系统回收站里留下一个临时文件,使 `npm test` 变成
// 非幂等(详见 lib/__tests__/README.md 的「已知副作用」)。需要验证该链路时显式开启:
//   GPM_TEST_TRASH=1 npm run test:preload
// 其余删除断言一律走 keepRecordOnly,只动记录、不碰磁盘。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const argv = process.argv.slice(2)
const flags = new Set(argv.filter((a) => a.startsWith('--')))
const positional = argv.filter((a) => !a.startsWith('--'))

// 默认被测目录 = 本文件所在目录的上一级(lib/);默认工作目录 = 系统临时目录下的新目录
const LIB = positional[0] || path.resolve(__dirname, '..')
const WORK = positional[1] || fs.mkdtempSync(path.join(os.tmpdir(), 'gpm-backup-test-'))

if (!fs.existsSync(path.join(LIB, 'backup.js'))) {
  console.error(`找不到被测模块: ${path.join(LIB, 'backup.js')}`)
  process.exit(2)
}

if (flags.has('--no-immediate')) {
  delete globalThis.setImmediate
  console.log('[harness] setImmediate 已移除,用于验证 yieldToLoop 的降级路径')
}
/** 是否验证「删除 → 移入回收站」真实链路(默认关闭,避免污染系统回收站) */
const TRASH = process.env.GPM_TEST_TRASH === '1'
if (TRASH) {
  console.log('[harness] GPM_TEST_TRASH=1:将验证「删除 → 移入回收站」真实链路(会写入系统回收站)')
}
console.log(`[harness] lib=${LIB}`)
console.log(`[harness] work=${WORK}`)

// ---------- 内存版 ztools.db 桩(store.js 只用到 get/put/remove/allDocs) ----------
const docs = new Map()
let rev = 0
global.window = {
  ztools: {
    db: {
      get: (id) => (docs.has(id) ? { ...docs.get(id) } : null),
      put: (doc) => {
        if (!doc || !doc._id) return { error: 'no id' }
        rev++
        docs.set(doc._id, { ...doc, _rev: `r${rev}` })
        return { ok: true, rev: `r${rev}` }
      },
      remove: (doc) => {
        docs.delete(doc._id)
        return { ok: true }
      },
      allDocs: (prefix) => [...docs.values()].filter((d) => d._id.startsWith(prefix)).map((d) => ({ ...d }))
    }
  }
}

const backup = require(path.join(LIB, 'backup.js'))
const projects = require(path.join(LIB, 'projects.js'))
const { readZipEntries } = require(path.join(LIB, 'extract.js'))
const { listDocs } = require(path.join(LIB, 'store.js'))

// ---------- 断言 ----------
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
/** 显式跳过的断言:必须打印出来,不能静默少跑 */
let skipped = 0
function skip(label) {
  skipped++
  console.log(`  SKIP  ${label}`)
}
// 让出一次事件循环(harness 自身也要能在无 setImmediate 的模拟沙箱里运行)
const tick = () =>
  new Promise((r) => (typeof setImmediate === 'function' ? setImmediate(r) : setTimeout(r, 0)))
const TERMINAL = { done: 1, error: 1, canceled: 1 }
const liveTasks = (kind) =>
  backup.listBackupTasks().filter((t) => (!kind || t.kind === kind) && !TERMINAL[t.phase])
function clearTasks() {
  for (const t of backup.listBackupTasks()) backup.dismissBackupTask(t.id)
}

// ---------- 造项目 ----------
function makeProject(name, opts) {
  const o = opts || {}
  const root = path.join(WORK, name)
  fs.mkdirSync(path.join(root, 'scenes'), { recursive: true })
  fs.mkdirSync(path.join(root, 'addons', 'demo'), { recursive: true })
  fs.mkdirSync(path.join(root, '.godot', 'imported'), { recursive: true })
  if (o.withGit) fs.mkdirSync(path.join(root, '.git', 'objects'), { recursive: true })
  fs.writeFileSync(path.join(root, 'project.godot'), [
    '; Engine configuration file.',
    'config_version=5',
    '',
    '[application]',
    '',
    `config/name="${name}"`,
    'config/features=PackedStringArray("4.8", "Forward Plus")',
    'config/icon="res://icon.svg"',
    ''
  ].join('\n'))
  fs.writeFileSync(path.join(root, 'icon.svg'), '<svg/>')
  fs.writeFileSync(path.join(root, 'scenes', 'main.tscn'), '[gd_scene]\n')
  fs.writeFileSync(path.join(root, 'scenes', 'player.tscn'), '[gd_scene]\n')
  fs.writeFileSync(path.join(root, 'addons', 'demo', 'plugin.cfg'), '[plugin]\nname="demo"\n')
  fs.writeFileSync(path.join(root, '.godot', 'imported', 'cache.bin'), Buffer.alloc(4096, 7))
  if (o.withGit) fs.writeFileSync(path.join(root, '.git', 'objects', 'pack'), Buffer.alloc(2048, 3))
  fs.writeFileSync(path.join(root, 'scenes', 'big.bin'), Buffer.alloc(512 * 1024, 5))
  return root
}

/** 造一个文件数足够多的项目,便于观察分片让出 */
function makeBulkProject(name, files) {
  const root = path.join(WORK, name)
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true })
  fs.writeFileSync(path.join(root, 'project.godot'), `config_version=5\n[application]\nconfig/name="${name}"\n`)
  for (let i = 0; i < files; i++) {
    fs.writeFileSync(path.join(root, 'assets', `f${i}.bin`), Buffer.alloc(64 * 1024, i % 251))
  }
  return root
}

function tempLeftovers(dir) {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter((n) => n.startsWith('.gpm-tmp-') || n.startsWith('.godot-restore-'))
}
const backupDocs = () => listDocs('godot/backup/')

async function main() {
  fs.rmSync(WORK, { recursive: true, force: true })
  fs.mkdirSync(WORK, { recursive: true })
  const backupsDir = path.join(WORK, 'backups')
  fs.mkdirSync(backupsDir, { recursive: true })

  const rootA = makeProject('Alpha', { withGit: true })
  const addA = projects.addProject(rootA)
  ok(addA.ok, 'addProject 注册项目 A', addA.error)
  const projectA = addA.project

  // ---------- 1. zip 备份 ----------
  section('1. zip 备份:落盘 / 记录 / 无残留')
  const phases = []
  let progressCalls = 0
  const rec1 = await backup.backupProject(projectA.id, {
    mode: 'zip', destDir: backupsDir, label: '发布前'
  }, (p) => {
    progressCalls++
    if (phases[phases.length - 1] !== p.phase) phases.push(p.phase)
  })
  ok(progressCalls > 0, `onProgress 被调用(${progressCalls} 次)`)
  ok(rec1.destPath.endsWith('.zip') && fs.existsSync(rec1.destPath), 'zip 文件已生成')
  ok(rec1.label === '发布前' && path.basename(rec1.destPath).startsWith('发布前_'), '备注名用于文件名与记录')
  ok(rec1.schema === 2 && rec1.level === 6, 'schema/level 已写入记录')
  ok(rec1.includeCache === false, 'includeCache=false 已写入记录')
  ok(rec1.engineVersion === '4.8', `引擎版本快照已记录(${rec1.engineVersion})`)
  ok(typeof rec1.durationMs === 'number' && rec1.durationMs >= 0, '耗时已记录')
  ok(backupDocs().length === 1, '恰好写入 1 条记录')
  ok(tempLeftovers(backupsDir).length === 0, '无 .gpm-tmp-* 残留', tempLeftovers(backupsDir).join(','))
  ok(!phases.includes('copying'), `阶段序列只含 zip 阶段: ${phases.join(' → ')}`)

  // ---------- 2. .godot 排除 ----------
  section('2. .godot 缓存排除')
  const entries1 = readZipEntries(rec1.destPath).entries
  ok(!entries1.some((e) => e.startsWith('.godot/')), '.godot 未进入 zip')
  ok(entries1.includes('project.godot'), 'zip 内含 project.godot')

  // ---------- 3. 重复备份不覆盖 ----------
  section('3. 重复备份不覆盖(原实现同一分钟会静默覆盖)')
  const rec2 = await backup.backupProject(projectA.id, { mode: 'zip', destDir: backupsDir })
  ok(rec2.destPath !== rec1.destPath, '两次备份目标路径不同')
  ok(fs.existsSync(rec1.destPath) && fs.existsSync(rec2.destPath), '两份文件同时存在')
  ok(backupDocs().length === 2, '记录数为 2')

  // ---------- 4. 自定义排除 ----------
  section('4. 自定义排除目录')
  const rec3 = await backup.backupProject(projectA.id, {
    mode: 'zip', destDir: backupsDir, exclude: ['.git', 'addons']
  })
  const entries3 = readZipEntries(rec3.destPath).entries
  ok(!entries3.some((e) => e.startsWith('.git/')), '.git 已排除')
  ok(!entries3.some((e) => e.startsWith('addons/')), 'addons 已排除')
  ok(entries3.includes('scenes/main.tscn'), '其余内容仍在')
  ok(Array.isArray(rec3.excluded) && rec3.excluded.length === 2, 'excluded 已记录')

  // ---------- 5. 快照备份 ----------
  section('5. 完整快照 + 包含缓存')
  const rec4 = await backup.backupProject(projectA.id, {
    mode: 'copy', destDir: backupsDir, includeCache: true
  })
  ok(fs.existsSync(path.join(rec4.destPath, 'project.godot')), '快照目录含 project.godot')
  ok(fs.existsSync(path.join(rec4.destPath, '.godot', 'imported', 'cache.bin')), 'includeCache=true 保留 .godot')
  ok(rec4.level === undefined, '快照模式不写 level')

  // ---------- 6. 压缩级别 ----------
  section('6. zip 压缩级别影响体积')
  const bulkRoot = makeBulkProject('Beta', 1)
  fs.writeFileSync(path.join(bulkRoot, 'repetitive.txt'), Buffer.from('godot engine '.repeat(200000)))
  const addB = projects.addProject(bulkRoot)
  const recL1 = await backup.backupProject(addB.project.id, { mode: 'zip', destDir: backupsDir, level: 1 })
  const recL9 = await backup.backupProject(addB.project.id, { mode: 'zip', destDir: backupsDir, level: 9 })
  ok(recL1.level === 1 && recL9.level === 9, 'level 已记录')
  ok(recL9.size < recL1.size, `L9 体积小于 L1(${recL9.size} < ${recL1.size})`)

  // ---------- 7. 查询 / 统计 ----------
  section('7. 查询与统计')
  const all = backup.listBackups()
  ok(all.length === 6, `listBackups() 返回全部 ${all.length} 条`)
  ok(all.every((d) => d.missing === false), 'missing 标记为 false')
  ok(backup.listBackups(projectA.id).length === 4, 'listBackups(projectId) 兼容字符串入参')
  ok(backup.listBackups({ projectId: projectA.id, withStatus: false }).every((d) => d.missing === undefined),
    'withStatus:false 跳过磁盘探测')
  const latest = backup.listLatestBackups()
  ok(Object.keys(latest).length === 2, 'listLatestBackups 按项目折叠为 2 组')
  const stats = backup.backupStats()
  ok(stats.count === 6, `统计份数 ${stats.count}`)
  ok(stats.totalSize > 0, `统计占用 ${stats.totalSize}`)
  ok(stats.missingCount === 0, '统计缺失数为 0')
  ok(stats.coveredProjects === 2 && stats.totalProjects === 2, '覆盖项目数 2/2')
  ok(stats.byMode.zip === 5 && stats.byMode.copy === 1, `按模式统计 zip=${stats.byMode.zip} copy=${stats.byMode.copy}`)
  ok(backup.getBackup(rec1._id).label === '发布前', 'getBackup 可读单条')

  // ---------- 8. 校验 ----------
  section('8. 完整性校验')
  const v1 = backup.verifyBackup(rec1._id)
  ok(v1.ok && v1.valid, 'zip 备份校验通过')
  ok(v1.entryCount > 0, `读出条目数 ${v1.entryCount}`)
  ok(backup.getBackup(rec1._id).verified === true, '校验结果写回记录')
  ok(backup.verifyBackup(rec4._id).valid === true, '快照备份校验通过')
  const broken = path.join(backupsDir, 'broken.zip')
  fs.writeFileSync(broken, fs.readFileSync(recL1.destPath).slice(0, 200))
  const { _id: _drop1, ...recL1data } = recL1
  docs.set('godot/backup/broken-test', { _id: 'godot/backup/broken-test', ...recL1data, destPath: broken })
  const v3 = backup.verifyBackup('godot/backup/broken-test')
  ok(v3.ok && v3.valid === false, '截断 zip 判定为无效', v3.error)
  docs.set('godot/backup/gone-test', { _id: 'godot/backup/gone-test', ...recL1data, destPath: path.join(backupsDir, 'gone.zip') })
  const v4 = backup.verifyBackup('godot/backup/gone-test')
  ok(v4.valid === false && /不存在/.test(v4.error || ''), '文件缺失判定为无效', v4.error)

  // ---------- 9. 备注 ----------
  section('9. 备注更新')
  ok(backup.updateBackup(rec2._id, { label: '  v1.0 通过审核  ' }).ok, 'updateBackup 成功')
  ok(backup.getBackup(rec2._id).label === 'v1.0 通过审核', 'label 已 trim 并保存')
  ok(backup.updateBackup(rec2._id, { label: '' }).ok && backup.getBackup(rec2._id).label === undefined,
    'label 传空串可清除')
  ok(backup.updateBackup('godot/backup/nope', { label: 'x' }).ok === false, '不存在的记录返回失败')

  // ---------- 10. 预估 ----------
  section('10. 备份规模预估')
  const estAll = await backup.estimateBackup(projectA.id, { includeCache: true, exclude: ['.git'] })
  const estNoCache = await backup.estimateBackup(projectA.id, { includeCache: false, exclude: ['.git'] })
  ok(estAll.fileCount > estNoCache.fileCount, `含缓存文件数更多(${estAll.fileCount} > ${estNoCache.fileCount})`)
  ok(estAll.bytes > estNoCache.bytes, '含缓存字节更多')

  // ---------- 11. 恢复为新项目 ----------
  section('11. 恢复为新项目')
  const snapEvents = []
  const r1 = await backup.restoreBackup(rec4._id, { mode: 'new', newName: 'AlphaRestored', destDir: WORK },
    (p) => snapEvents.push(p.phase))
  ok(r1.ok, '快照恢复成功', r1.error)
  ok(fs.existsSync(path.join(WORK, 'AlphaRestored', 'project.godot')), '新项目目录含 project.godot')
  ok(!!r1.newProjectId, `新项目已注册(id=${r1.newProjectId})`)
  // 展示名来自 project.godot 的 config/name,与 addProject 行为一致
  ok(r1.newProjectName === 'Alpha', `项目显示名取自 project.godot(实际 ${r1.newProjectName})`)
  ok(snapEvents.every((p) => p === 'copying'), `快照恢复阶段全为 copying: ${[...new Set(snapEvents)].join(',')}`)
  ok(tempLeftovers(path.dirname(rec4.destPath)).length === 0, '恢复后无临时目录残留')

  const zipEvents = []
  const rZip = await backup.restoreBackup(rec1._id, { mode: 'new', newName: 'AlphaFromZip', destDir: WORK },
    (p) => zipEvents.push(p.phase))
  ok(rZip.ok, '从 zip 恢复成功', rZip.error)
  ok(fs.existsSync(path.join(WORK, 'AlphaFromZip', 'project.godot')), 'zip 恢复出 project.godot')
  ok(zipEvents.includes('unpacking') && zipEvents.includes('copying'),
    `zip 恢复阶段含 unpacking→copying: ${[...new Set(zipEvents)].join(' → ')}`)
  ok(fs.existsSync(path.join(WORK, 'AlphaFromZip', 'scenes', 'big.bin')), '大文件完整还原')
  const reAdd = projects.addProject(path.join(WORK, 'AlphaFromZip'))
  ok(reAdd.ok && reAdd.exists === true, '恢复出的项目可被再次识别(幂等)')

  // ---------- 12. 覆盖恢复 ----------
  section('12. 覆盖恢复')
  const marker = path.join(rootA, 'scenes', 'main.tscn')
  fs.writeFileSync(marker, '[gd_scene]\n; 已被本地修改\n')
  ok(fs.readFileSync(marker, 'utf8').includes('已被本地修改'), '覆盖前本地改动已写入')
  const r2 = await backup.restoreBackup(rec4._id, { mode: 'overwrite' })
  ok(r2.ok, '覆盖恢复成功', r2.error)
  ok(!fs.readFileSync(marker, 'utf8').includes('已被本地修改'), '原目录已被备份内容替换')
  ok(fs.existsSync(path.join(rootA, 'project.godot')), '覆盖后项目仍可识别')
  ok(fs.existsSync(projectA.path), '原路径仍然存在')

  // ---------- 13. 分片让出(P0 修复的直接证据) ----------
  section('13. 分片让出:备份期间事件循环仍在转动(P0 修复)')
  clearTasks()
  const gammaRoot = makeBulkProject('Gamma', 160)
  const addG = projects.addProject(gammaRoot)
  let finished = false
  let turns = 0
  const spinner = (async () => {
    while (!finished) {
      turns++
      await tick()
    }
  })()
  const beforeCount13 = backupDocs().length
  const recG = await backup.backupProject(addG.project.id, { mode: 'zip', destDir: backupsDir })
  finished = true
  await spinner
  // 旧实现(全程同步 fs)下 turns 会是 0:备份跑完之前事件循环根本没有机会转
  ok(turns >= 1, `备份期间事件循环被让出 ${turns} 次(纯同步实现应为 0)`)
  ok(fs.existsSync(recG.destPath), '分片后备份结果依然完整')
  ok(backup.verifyBackup(recG._id).valid === true, '分片产出的 zip 可正常解析')
  ok(backupDocs().length === beforeCount13 + 1, '只新增 1 条记录')

  // ---------- 14. 取消 ----------
  section('14. 取消备份:终态 / 无脏记录 / 无残留')
  clearTasks()
  const beforeCount14 = backupDocs().length
  const beforeFiles14 = fs.readdirSync(backupsDir).length
  let watchPushes = 0
  // 用任务订阅捕获「进行中」的任务,而不是靠 tick() 的时序假设:
  // yield 实现速度不同(MessageChannel 比 setTimeout 快得多)会让时序断言变得不稳定。
  let liveId = null
  const unsub = backup.watchBackupTasks((snaps) => {
    watchPushes++
    if (!liveId) {
      const live = snaps.find((t) => t.kind === 'backup' && !TERMINAL[t.phase])
      if (live) liveId = live.id
    }
  })
  ok(watchPushes >= 1, 'watchBackupTasks 订阅时立即回调一次')
  const pCancel = backup.backupProject(addG.project.id, { mode: 'zip', destDir: backupsDir })
  ok(!!liveId, '备份启动后立刻捕获到进行中的任务')
  ok(!!liveId && backup.dismissBackupTask(liveId) === false, '进行中的任务不可 dismiss')
  const cancelAccepted = backup.cancelBackupTask(liveId)
  let canceledErr = false
  try {
    await pCancel
  } catch (e) {
    canceledErr = !!e.canceled
  }
  unsub()
  ok(cancelAccepted && canceledErr, '取消被接受且以 canceled 抛出', `accepted=${cancelAccepted} err=${canceledErr}`)
  ok(backupDocs().length === beforeCount14, '取消后未写入记录')
  ok(fs.readdirSync(backupsDir).length === beforeFiles14, '取消后目标目录文件数不变')
  ok(tempLeftovers(backupsDir).length === 0, '取消后无临时产物残留')
  const tCancel = backup.listBackupTasks().find((t) => t.id === liveId)
  ok(tCancel && tCancel.phase === 'canceled', `任务终态为 canceled(实际 ${tCancel && tCancel.phase})`)
  ok(backup.dismissBackupTask(liveId) === true && backup.listBackupTasks().length === 0, '终态任务可 dismiss')

  // ---------- 15. 取消恢复 ----------
  section('15. 取消恢复(解包阶段)')
  clearTasks()
  const pRestore = backup.restoreBackup(recG._id, { mode: 'new', newName: 'GammaCancelled', destDir: WORK })
  let restoreCancelAccepted = null
  for (let i = 0; i < 400; i++) {
    const t = backup.listBackupTasks().find((x) => x.kind === 'restore')
    if (t && t.phase === 'unpacking') {
      restoreCancelAccepted = backup.cancelBackupTask(t.id)
      break
    }
    if (t && TERMINAL[t.phase]) break
    await tick()
  }
  const rr = await pRestore
  ok(restoreCancelAccepted === true, `解包阶段取消被接受(实际 ${restoreCancelAccepted})`)
  ok(rr.canceled === true, `恢复被中止(ok=${rr.ok} canceled=${!!rr.canceled})`)
  const rt = backup.listBackupTasks().find((t) => t.kind === 'restore')
  if (rr.canceled) {
    ok(rt && rt.phase === 'canceled', '恢复任务终态为 canceled')
    ok(!fs.existsSync(path.join(WORK, 'GammaCancelled')), '取消后未留下半成品项目目录')
    ok(tempLeftovers(WORK).length === 0, '取消后无 .godot-restore-* 残留')
  }
  clearTasks()

  // ---------- 16. 覆盖恢复的取消锁定 ----------
  section('16. 覆盖恢复进入替换阶段后取消被拒绝')
  clearTasks()
  // 用大备份(161 条目)保证解包/替换都跨多个分片,才能观察到 replacing 阶段
  const pOver = backup.restoreBackup(recG._id, { mode: 'overwrite' })
  let sawReplacing = false
  let acceptedAtReplacing = null
  for (let i = 0; i < 400; i++) {
    const t = backup.listBackupTasks().find((x) => x.kind === 'restore')
    if (t && (t.phase === 'replacing' || t.cancelable === false)) {
      sawReplacing = true
      acceptedAtReplacing = backup.cancelBackupTask(t.id)
      break
    }
    if (t && TERMINAL[t.phase]) break
    await tick()
  }
  const rOver = await pOver
  ok(rOver.ok || rOver.canceled, `覆盖恢复有明确终态(ok=${rOver.ok} canceled=${!!rOver.canceled})`)
  ok(sawReplacing, '观察到 replacing 阶段(已锁定取消)')
  ok(acceptedAtReplacing === false, `锁定后取消被拒绝,返回 false(实际 ${acceptedAtReplacing})`)
  ok(rOver.ok === true, '锁定后的覆盖恢复顺利完成(未被取消打断)')
  clearTasks()
  ok(fs.existsSync(path.join(rootA, 'project.godot')), '覆盖恢复后项目结构完整')

  // 反向确认:解包阶段取消是生效的
  clearTasks()
  const pPre = backup.restoreBackup(recG._id, { mode: 'overwrite' })
  let acceptedPre = null
  for (let i = 0; i < 400; i++) {
    const t = backup.listBackupTasks().find((x) => x.kind === 'restore')
    if (t && t.phase === 'unpacking') {
      acceptedPre = backup.cancelBackupTask(t.id)
      break
    }
    if (t && TERMINAL[t.phase]) break
    await tick()
  }
  const rPre = await pPre
  ok(acceptedPre === true, `解包阶段取消被接受(实际 ${acceptedPre})`)
  ok(rPre.canceled === true, '解包阶段取消使恢复中止')
  ok(fs.existsSync(path.join(rootA, 'project.godot')), '取消中止后原项目目录完好')
  clearTasks()

  // ---------- 17. 清理预览 ----------
  section('17. 清理策略(默认 dryRun)')
  const dry = backup.pruneBackups({ keepPerProject: 1 })
  ok(dry.ok && dry.dryRun === true, 'pruneBackups 默认只预览')
  ok(dry.targets.length > 0, `预览到 ${dry.targets.length} 条待清理`)
  ok(dry.totalSize > 0, `预览占用 ${dry.totalSize}`)
  const countBefore17 = backupDocs().length
  ok(backupDocs().length === countBefore17, 'dryRun 未删除任何记录')
  ok(backup.pruneBackups({}).ok === false, '未给条件时返回失败')
  ok(backup.pruneBackups({ olderThanDays: 3650 }).targets.length === 0, '超长保留期无目标')

  // ---------- 18. 删除 ----------
  section('18. 单条 / 批量删除')
  const keep = backup.deleteBackup(rec3._id, { keepRecordOnly: true })
  ok(keep.ok && fs.existsSync(rec3.destPath), 'keepRecordOnly 保留磁盘文件')
  ok(backup.getBackup(rec3._id) === null, 'keepRecordOnly 移除记录')

  const toDelete = backup.listBackups({ withStatus: false }).slice(0, 2).map((d) => d._id)
  // keepRecordOnly:只移除记录,不动磁盘文件 —— 避免每次回归都往回收站塞东西
  const delRes = backup.deleteBackups(toDelete, { keepRecordOnly: true })
  ok(delRes.ok && delRes.removed === 2, `批量删除 ${delRes.removed}/2(仅移除记录)`)
  ok(toDelete.every((id) => backup.getBackup(id) === null), '记录均已移除')
  const delEmpty = backup.deleteBackups([])
  ok(delEmpty.ok && delEmpty.removed === 0, '空数组批量删除安全')
  if (TRASH) {
    const victim = backup.listBackups({ withStatus: false })[0]
    ok(backup.deleteBackup(victim._id).ok, '真实删除(移入回收站)成功')
  } else {
    skip('真实删除(移入回收站)成功 —— 默认跳过,设 GPM_TEST_TRASH=1 开启')
  }

  // ---------- 结果 ----------
  console.log(`\n${'='.repeat(56)}`)
  console.log(`PASS ${pass}  SKIP ${skipped}  FAIL ${failures.length}`)
  if (failures.length) {
    console.log('失败项:')
    for (const f of failures) console.log('  - ' + f)
    process.exit(1)
  }
  console.log('全部通过')
  // 无 setImmediate 环境下 yieldToLoop 会持有 MessageChannel 端口,显式退出避免挂住
  process.exit(0)
}

main().catch((e) => {
  console.error('\n未捕获异常:', e)
  process.exit(1)
})
