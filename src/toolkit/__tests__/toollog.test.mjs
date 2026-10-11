// 工具箱 · 第 1 批 Task 9:动作账本(src/toolkit/toollog.ts)的断言。
//
// 这一份要守住的三条(A-16 / Q17=B / Q29=C):
//   · 账本只**誊写**回执,不在自己肚子里重算一遍(重算就是第二份真相);
//   · 一键还原的承诺与拒绝理由必须同一张嘴 —— 表驱动那条断言钉的就是这个等价关系;
//   · 超 50 条只丢记录,绝不碰备份文件(结构上做不到:模块只拿到 getDoc/putDoc,源码级断言再钉一遍)。
//
// 沿用本批定下的两条 harness 纪律:
//   · 凡按位置取成员一律走 F()/FA()/P(),变异刀要把套件「判红」而不是「撞停」;
//   · 产物与源码的同步用字符串字面量做探针(esbuild 会改标识符,不会改字面量)。
//
// 用法:node src/composables/__tests__/build-bundle.mjs && node src/toolkit/__tests__/toollog.test.mjs
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../../..')
const BUNDLE = path.resolve(ROOT, '.gpm-test/out/tktoollog.mjs')

if (!existsSyncGuard(BUNDLE)) {
  console.error(`找不到打包产物: ${BUNDLE}`)
  console.error('请先运行: node src/composables/__tests__/build-bundle.mjs')
  process.exit(2)
}
function existsSyncGuard(p) { try { readFileSync(p); return true } catch { return false } }

const T = await import(pathToFileURL(BUNDLE).href)

let pass = 0
const failures = []
function ok(cond, label, extra) {
  if (cond) { pass++; console.log(`  PASS  ${label}`) }
  else { failures.push(label); console.log(`  FAIL  ${label}${extra !== undefined ? '  → ' + JSON.stringify(extra) : ''}`) }
}
function section(t) { console.log(`\n=== ${t} ===`) }
const F = (x) => (x && typeof x === 'object' ? x : {})
const FA = (x) => (Array.isArray(x) ? x : [])
const S = (x) => (typeof x === 'string' ? x : '')
const P = (arr, i) => F(FA(arr)[i])

/** 一条合格账目(单写一个文件、拿到备份名 ⇒ 可还原) */
const CH_ROW = (over) => ({ rel: 'a.gd', kind: 'rewrite', label: '改 a.gd', risk: 'low', outOfScope: false, ...(over || {}) })
const ENTRY = (at, over) => ({
  at, toolId: 'fmt', toolName: '格式化', projectId: 'p1',
  changes: [CH_ROW()],
  backups: [{ rel: 'a.gd', backupRel: 'a.gd.gpm-bak-1' }],
  written: ['a.gd'], moved: [], failed: [], cancelled: false, canRollback: false,
  ...(over || {})
})
const PC = (id, rel, kind, over) => ({
  id, rel, kind: kind || 'rewrite', label: '改 ' + rel, risk: 'low', reason: 'r',
  outOfScope: false, creates: false, defaultSelected: true, ...(over || {})
})
const PLAN = (cs, over) => ({ toolId: 'fmt', changes: cs, planError: '', rejected: [], selectedRels: ['a.gd'], treeKnown: true, ...(over || {}) })
const RECEIPT = (over) => ({
  toolId: 'fmt', projectId: 'p1', at: 1000, items: [], written: [], moved: [], failed: [], backups: [], cancelled: false, ok: true,
  ...(over || {})
})
const EX = (id, rel, over) => ({ id, rel, kind: 'rewrite', ok: true, ...(over || {}) })

/** 假存储:记录每次调用,并摆一批「删除能力」陷阱 —— 账本要是伸手碰文件,这里会响 */
function mkStore(opt) {
  const o = opt || {}
  const calls = []
  const traps = []
  const store = {
    getDoc: (id) => {
      calls.push({ m: 'getDoc', id })
      if (o.getError) throw new Error(o.getError)
      return 'doc' in o ? o.doc : undefined
    },
    putDoc: (id, data) => {
      calls.push({ m: 'putDoc', id, data })
      if (o.putError) throw new Error(o.putError)
      return { ok: true }
    }
  }
  for (const m of ['unlink', 'unlinkSync', 'rm', 'rmSync', 'writeText', 'movePathsToTrash', 'delDoc', 'deleteDoc', 'removeDoc', 'trash']) {
    store[m] = () => { traps.push(m); return { ok: true } }
  }
  const putCalls = () => calls.filter((c) => c.m === 'putDoc')
  // ⚠ puts / lastDoc 必须**按需**取:早先写成创建时的快照,「putDoc 一次都没被调用」那条断言
  //   就永远读到 0 —— 恒真、没有牙(本文件自查时正是这么露馅的)。
  return {
    store, calls, traps,
    get puts() { return putCalls().length },
    lastDoc: () => { const p = putCalls(); return p.length ? p[p.length - 1].data : undefined }
  }
}

/** 读一份 doc 归一出来的结果:list 是归一后的数组,entry 是第一条 */
async function loadOne(raw) {
  const r = await T.loadLog({ getDoc: () => [raw], putDoc: () => ({ ok: true }) })
  const res = F(r)
  const list = FA(res.entries)
  return { list, entry: P(list, 0), dirty: res.dirty, error: S(res.error) }
}

section('0. 导出面与常量')
for (const n of ['LOG_DOC_ID', 'LOG_KEEP', 'LOG_RECENT_PER_TOOL', 'entryFromRun', 'loadLog', 'appendRun',
  'entriesForProject', 'recentFor', 'rollbackPlan', 'entrySummaryText', 'droppedNotice']) {
  ok(T[n] !== undefined, `${n} 已在打包产物里导出`)
}
{
  ok(T.LOG_DOC_ID === 'godot/toollog/entries', '单文档方案的文档 id(DEV-16)', T.LOG_DOC_ID)
  ok(T.LOG_KEEP === 50, '保留 50 条(Q29=C)', T.LOG_KEEP)
  ok(T.LOG_RECENT_PER_TOOL === 5, '工具页内最近 5 条(Q29=C)', T.LOG_RECENT_PER_TOOL)
}

section('0b. 产物与源码同步(本批被 stale bundle 咬过两轮)')
{
  const src = readFileSync(path.resolve(ROOT, 'src', 'toolkit', 'toollog.ts'), 'utf8')
  const out = readFileSync(BUNDLE, 'utf8')
  for (const lit of ['这一轮包含删除或改名', '备份记录不完整', '备份文件仍在磁盘上', '账本文档不是一个数组', '为不覆掉已有记录']) {
    ok(src.includes(lit), `源码里有「${lit}」`)
    ok(out.includes(lit), `产物里有「${lit}」`, '忘了重打 bundle?')
  }
}

section('1. 账目形状 = §5.5 那一行的字段名(改名要红)')
{
  const e = T.entryFromRun({
    toolId: 'fmt', toolName: '格式化', projectId: 'proj-1',
    plan: PLAN([PC('i1', 'a.gd')]), receipt: RECEIPT({ items: [EX('i1', 'a.gd')], written: ['a.gd'], backups: [{ rel: 'a.gd', backupRel: 'a.gd.gpm-bak-1' }] })
  })
  const keys = Object.keys(F(e)).sort().join(',')
  ok(keys === 'at,backups,canRollback,cancelled,changes,failed,moved,projectId,toolId,toolName,written',
    '§5.5 那条账目一共这 11 个键', keys)
}

section('2. entryFromRun:身份与时间戳的三个来源')
{
  const e = T.entryFromRun({ toolId: 'fmt', toolName: '格式化', projectId: 'p1', plan: PLAN([]), receipt: RECEIPT({ at: 1000 }), at: 5 })
  ok(F(e).at === 5, 'args.at 优先(同一轮里调用方说了算)')
  ok(F(e).toolId === 'fmt' && F(e).toolName === '格式化' && F(e).projectId === 'p1', '身份字段来自 args,不从回执猜')
  const noAt = T.entryFromRun({ toolId: 'fmt', toolName: 'n', projectId: 'p', plan: PLAN([]), receipt: RECEIPT({ at: 777 }) })
  ok(F(noAt).at === 777, 'args 没给 ⇒ 用回执的时间戳')
  const bare = T.entryFromRun({ toolId: 'fmt', toolName: 'n', projectId: 'p', plan: PLAN([]), receipt: { toolId: 'fmt', items: [], failed: [] } })
  ok(F(bare).at === 0, '两边都没有 ⇒ 记 0,不编一个「现在」(账本不许自己拿 Date.now)')
  // 记 0 比丢掉这条账好:备份对应关系还在,还原能力不该因为一个时间戳而消失。测试钉住它仍被接受。
  const st = mkStore({ doc: [] })
  const r = await T.appendRun(st.store, bare)
  ok(F(r).ok === true && st.puts === 1, 'at=0 的账目照样记上(丢了记录比时间戳不对更糟)', { ok: F(r).ok, err: F(r).error })
  for (const bad of [NaN, Infinity, -Infinity, '2026-01-01', null, undefined]) {
    const x = T.entryFromRun({ toolId: 'fmt', toolName: 'n', projectId: 'p', plan: PLAN([]), receipt: RECEIPT({ at: 1000 }), at: bad })
    ok(F(x).at === 1000, `非法 args.at(${JSON.stringify(bad) ?? String(bad)}) ⇒ 退回回执时间戳`)
  }
}

section('3. entryFromRun:changes 只记真正执行过的条')
{
  const plan = PLAN([PC('i1', 'a.gd'), PC('i2', 'b.gd'), PC('i3', 'c.gd')])
  const rec = RECEIPT({
    items: [EX('i1', 'a.gd'), EX('i2', 'b.gd', { ok: false, error: '已取消' })],
    written: ['a.gd'], failed: [EX('i1', 'a.gd', { ok: false, error: '写坏了' }), EX('i2', 'b.gd', { ok: false, error: '已取消' }), EX('i3', 'c.gd', { ok: false, error: '已取消' })],
    cancelled: true
  })
  const e = T.entryFromRun({ toolId: 'fmt', toolName: '格式化', projectId: 'p1', plan, receipt: rec })
  ok(FA(F(e).changes).length === 1, '被取消没处理的条不进 changes(它们没碰过盘)', FA(F(e).changes).map((c) => c.rel))
  ok(FA(F(e).changes).map((c) => c.rel).join(',') === 'a.gd', '只有真跑过的那条留在账上')
  ok(FA(F(e).failed).length === 3, 'failed 三条全在:账本要说得出「这一轮停在哪」', FA(F(e).failed))
  ok(F(P(FA(F(e).failed), 2)).error === '已取消', '取消原因串原样进账')
  ok(F(e).cancelled === true, 'cancelled 记真')
  const spaced = T.entryFromRun({
    toolId: 'fmt', toolName: 'n', projectId: 'p',
    plan: PLAN([PC('i1', 'a.gd'), PC('i2', 'b.gd')]),
    receipt: RECEIPT({ failed: [EX('i2', 'b.gd', { ok: false, error: ' 已取消 ' })] })
  })
  ok(FA(F(spaced).changes).length === 1 && F(P(FA(F(spaced).changes), 0)).rel === 'a.gd', '「已取消」带空白也算取消(不按字面串漏判)')
  const mid = T.entryFromRun({
    toolId: 'fmt', toolName: 'n', projectId: 'p', plan,
    receipt: RECEIPT({ failed: [EX('i2', 'b.gd', { ok: false, error: '已取消' }), EX('i3', 'c.gd', { ok: false, error: '已取消' })] })
  })
  ok(FA(F(mid).changes).map((c) => c.rel).join(',') === 'a.gd', '中间那条被取消 ⇒ 它和它之后的都不记')
  const last = T.entryFromRun({
    toolId: 'fmt', toolName: 'n', projectId: 'p', plan,
    receipt: RECEIPT({ failed: [EX('i3', 'c.gd', { ok: false, error: '已取消' })] })
  })
  ok(FA(F(last).changes).map((c) => c.rel).join(',') === 'a.gd,b.gd', '只砍掉最后一条 ⇒ 前面的顺序照父计划,不重排', FA(F(last).changes).map((c) => c.rel))
  ok(F(last).cancelled === true, '回执顶层没标取消、但 failed 里有「已取消」⇒ 也算取消(两个来源都读)')
  ok(F(mid).cancelled === true, '中间断掉的同样记 cancelled')
  const noPlan = T.entryFromRun({ toolId: 'fmt', toolName: 'n', projectId: 'p', receipt: RECEIPT({ written: ['a.gd'], backups: [{ rel: 'a.gd', backupRel: 'x' }] }) })
  ok(FA(F(noPlan).changes).length === 0, '没给 plan ⇒ changes 空,不臆造行文案')
  ok(F(noPlan).canRollback === true, 'changes 空但有完整备份 ⇒ 还原照样承诺(按 backups 判)')
  const nothing = T.entryFromRun({ toolId: 'fmt', toolName: 'n', projectId: 'p' })
  ok(F(nothing).at === 0 && FA(F(nothing).changes).length === 0 && S(F(nothing).toolId) === 'fmt', 'plan/receipt 全缺也不抛(记账不能把回执带崩)')
  ok(F(nothing).canRollback === false, '什么都没做成的那轮不承诺还原')
}

section('4. entryFromRun:只誊写回执,不替调用方重算')
{
  const withItems = T.entryFromRun({
    toolId: 'fmt', toolName: 'n', projectId: 'p', plan: PLAN([PC('i1', 'a.gd')]),
    receipt: RECEIPT({ items: [EX('i1', 'a.gd', { backupRel: 'b1' })] })
  })
  ok(FA(F(withItems).written).length === 0, '只给 items 不给 written ⇒ written 留空(重算就是第二份真相)')
  ok(P(FA(withItems.changes), 0).label === '改 a.gd', 'changes 走的是 plan 那一侧(有 label 可誊)', FA(withItems.changes))
  const onlyWritten = T.entryFromRun({
    toolId: 'fmt', toolName: 'n', projectId: 'p', plan: PLAN([]),
    receipt: RECEIPT({ written: ['a.gd'], backups: [{ rel: 'a.gd', backupRel: 'b1' }] })
  })
  ok(FA(F(onlyWritten).written).join(',') === 'a.gd', '给了 written 就照记(证明读的是 written 而不是从 items 算)')
  const dirtyFailed = T.entryFromRun({
    toolId: 'fmt', toolName: 'n', projectId: 'p', plan: PLAN([]),
    receipt: RECEIPT({ failed: [null, 42, EX('i1', 'a.gd', { ok: false, error: '   ' })] })
  })
  ok(FA(F(dirtyFailed).failed).length === 3, '脏 failed 元素不丢(记录条数要如实)', FA(F(dirtyFailed).failed))
  ok(F(P(FA(F(dirtyFailed).failed), 0)).rel === '' && F(P(FA(F(dirtyFailed).failed), 0)).error === '回执里的失败记录不是一个对象', '非对象失败记录给兜底原因')
  ok(F(P(FA(F(dirtyFailed).failed), 2)).error === '没给原因', '空白原因 ⇒ 兜底串,回执不许是空白')
  const strNumbers = T.entryFromRun({ toolId: 'fmt', toolName: 'n', projectId: 'p', plan: PLAN([]), receipt: RECEIPT({ written: ['a.gd', 7] }) })
  ok(FA(F(strNumbers).written).length === 2, '脏 written 元素保留个数(宁可显示成"2 个"也不静默少计)')
  const keepRaw = T.entryFromRun({ toolId: 'fmt', toolName: 'n', projectId: 'p', plan: PLAN([PC('i1', 'a.gd', 'rename', { to: 'b.gd' })]), receipt: RECEIPT({}) })
  ok(P(FA(keepRaw.changes), 0).to === 'b.gd', 'rename 的新名如实记着(第 2 批用)', P(FA(keepRaw.changes), 0))
  ok(F(P(FA(keepRaw.changes), 0)).kind === 'rename', 'kind 不美化')
  const plain = T.entryFromRun({ toolId: 'f', toolName: 'n', projectId: 'p', plan: PLAN([PC('i1', 'a.gd')]), receipt: RECEIPT({}) })
  ok(!('to' in P(FA(plain).changes, 0)), '非 rename 不塞空 to 键', P(FA(plain).changes, 0))
}

section('5. canRollback:由框架按这一轮真做了什么算')
{
  const good = T.entryFromRun({
    toolId: 'fmt', toolName: 'n', projectId: 'p', plan: PLAN([PC('i1', 'a.gd'), PC('i2', 'b.gd')]),
    receipt: RECEIPT({ written: ['a.gd', 'b.gd'], backups: [{ rel: 'a.gd', backupRel: 'b1' }, { rel: 'b.gd', backupRel: 'b2' }] })
  })
  ok(F(good).canRollback === true, '两条改写 + 两个备份名 ⇒ 可还原', good)
  const noBackup = T.entryFromRun({
    toolId: 'fmt', toolName: 'n', projectId: 'p', plan: PLAN([PC('i1', 'a.gd')]),
    receipt: RECEIPT({ written: ['a.gd'] })
  })
  ok(F(noBackup).canRollback === false, '写了文件却一个备份名都没拿到 ⇒ 不承诺还原')
  ok(S(F(T.rollbackPlan(noBackup)).refused).includes('一个备份名都没拿到'), '那句理由说清了为什么')
  const halfBackup = T.entryFromRun({
    toolId: 'fmt', toolName: 'n', projectId: 'p', plan: PLAN([PC('i1', 'a.gd'), PC('i2', 'b.gd')]),
    receipt: RECEIPT({ written: ['a.gd', 'b.gd'], backups: [{ rel: 'a.gd', backupRel: 'b1' }, { rel: 'b.gd' }] })
  })
  ok(F(halfBackup).canRollback === false, '备份记录缺半边 ⇒ 拒绝(半截还原比不还原更坏)')
  ok(FA(F(halfBackup).backups).length === 2, '但那一行仍留在账目里(不因为脏就把历史扔掉)', FA(F(halfBackup).backups))
  const trashFailed = T.entryFromRun({
    toolId: 'fmt', toolName: 'n', projectId: 'p', plan: PLAN([PC('i1', 'a.gd'), PC('i2', 'b.gd', 'trash')]),
    receipt: RECEIPT({ written: ['a.gd'], backups: [{ rel: 'a.gd', backupRel: 'b1' }], failed: [EX('i2', 'b.gd', { ok: false, kind: 'trash', error: '回收站调用失败' })] })
  })
  ok(F(trashFailed).canRollback === false, '删除**失败**也算这一轮做过删除 ⇒ 照样不承诺')
  ok(S(F(T.rollbackPlan(trashFailed)).refused).includes('删除或改名'), '理由是那句「一键还原只能做到一半」', F(T.rollbackPlan(trashFailed)).refused)
  const onlyMoved = T.entryFromRun({
    toolId: 'fmt', toolName: 'n', projectId: 'p',
    receipt: RECEIPT({ moved: ['b.gd'] })
  })
  ok(F(onlyMoved).canRollback === false, 'changes 没给但 moved 非空 ⇒ 兜住(这条判据不是冗余)')
  ok(S(F(T.rollbackPlan(onlyMoved)).refused).includes('回收站'), '回收站那句要说清「还原得由你在回收站里做」')
}

section('6. 一张嘴:canRollback 与 rollbackPlan.refused 永不分家(表驱动)')
{
  const SHAPES = [
    ['正常一轮改写', ENTRY(1), true],
    ['全失败没落盘', ENTRY(2, { written: [], backups: [], failed: [{ rel: 'a.gd', error: 'x' }] }), false],
    ['混进回收站动作', ENTRY(3, { moved: ['b.gd'], changes: [CH_ROW(), CH_ROW({ rel: 'b.gd', kind: 'trash' })] }), false],
    ['混进改名', ENTRY(4, { changes: [CH_ROW(), CH_ROW({ rel: 'b.gd', kind: 'rename', to: 'c.gd' })] }), false],
    ['写了但没备份名', ENTRY(5, { backups: [] }), false],
    ['备份记录缺半边', ENTRY(6, { backups: [{ rel: 'a.gd', backupRel: '' }] }), false],
    ['changes 空但 moved 非空', ENTRY(7, { changes: [], moved: ['b.gd'] }), false],
    ['changes 空但有完整备份', ENTRY(8, { changes: [] }), true]
  ]
  let trues = 0
  for (const [name, raw, expect] of SHAPES) {
    const loaded = await loadOne(raw)
    const plan = T.rollbackPlan(raw)
    const again = T.rollbackPlan(loaded.entry)
    ok(F(loaded.entry).canRollback === (S(plan.refused) === ''), `${name}:承诺 ⇔ 拒绝理由为空`, { canRollback: F(loaded.entry).canRollback, refused: F(plan).refused })
    ok(!!F(loaded.entry).canRollback === expect, `${name}:期望值对得上(${expect})`, F(loaded.entry).canRollback)
    if (F(loaded.entry).canRollback === true) trues++
    ok(S(plan.refused) === S(again.refused), `${name}:归一前后同一张嘴(重算幂等)`)
    ok(S(plan.refused) !== '' || FA(plan.items).length > 0, `${name}:要么拒绝要么给清单,不许「可还原但一条都不还原」`, plan)
    ok(S(plan.refused) === '' || FA(plan.items).length === 0, `${name}:拒绝时 items 必空`, plan)
  }
  ok(trues >= 1 && trues < SHAPES.length, '这批形状既不恒真也不恒假', trues)
}

section('7. rollbackPlan:还原清单与「同一文件取最早那份备份」')
{
  const two = T.rollbackPlan(ENTRY(1, {
    written: ['a.gd', 'b.gd'],
    changes: [CH_ROW(), CH_ROW({ rel: 'b.gd' })],
    backups: [{ rel: 'b.gd', backupRel: 'b.gd.bak' }, { rel: 'a.gd', backupRel: 'a.gd.bak' }]
  }))
  ok(S(F(two).refused) === '', '两条改写 ⇒ 可还原', two)
  ok(FA(F(two).items).map((i) => i.rel).join(',') === 'b.gd,a.gd', '顺序照账目里的备份顺序(不重排)', FA(F(two).items))
  const dup = T.rollbackPlan(ENTRY(2, {
    written: ['a.gd'],
    backups: [{ rel: 'a.gd', backupRel: 'a.gd.bak-早' }, { rel: 'a.gd', backupRel: 'a.gd.bak-晚' }]
  }))
  ok(FA(F(dup).items).length === 1, '同一文件一轮里写过两次 ⇒ 只还原一次', FA(F(dup).items))
  ok(F(P(FA(F(dup).items), 0)).backupRel === 'a.gd.bak-早', '还原的是最早那份(它才装着本轮开始前的正文)', dup)
  const junk = [undefined, null, 42, 'string', [], {}]
  for (const j of junk) {
    const r = T.rollbackPlan(j)
    ok(S(F(r).refused).length > 0 && FA(F(r).items).length === 0, `垃圾入参(${JSON.stringify(j) ?? String(j)}) ⇒ 拒绝且不抛`, r)
  }
}

section('8. 判据字段不合法 ⇒ 整条丢弃(宁可不显示这条历史)')
{
  const bads = [
    ['changes 不是数组', ENTRY(1, { changes: 'x' })],
    ['有一条变更不是对象', ENTRY(2, { changes: [null] })],
    ['有一条变更没有 rel', ENTRY(3, { changes: [{ kind: 'rewrite' }] })],
    ['变更 kind 无法识别', ENTRY(4, { changes: [{ rel: 'a.gd', kind: 'delete' }] })],
    ['变更 kind 缺失', ENTRY(5, { changes: [{ rel: 'a.gd' }] })],
    ['backups 不是数组', ENTRY(6, { backups: {} })],
    ['缺 toolId', ENTRY(7, { toolId: '' })],
    ['toolId 是数字', ENTRY(8, { toolId: 42 })]
  ]
  for (const [name, raw] of bads) {
    const loaded = await loadOne(raw)
    ok(loaded.list.length === 0, `${name} ⇒ 整条不显示`, loaded)
    ok(F(loaded).dirty === 1, `${name} ⇒ 计入损坏数`, F(loaded).dirty)
    ok(S(F(T.rollbackPlan(raw)).refused).includes('不可信'), `${name} ⇒ 回滚也拒绝`, F(T.rollbackPlan(raw)).refused)
  }
  for (const bad of [undefined, null, 'x', NaN, Infinity, -Infinity]) {
    const loaded = await loadOne(ENTRY(1, { at: bad }))
    ok(loaded.list.length === 0, `时间戳 ${JSON.stringify(bad) ?? String(bad)} 不合法 ⇒ 整条丢弃`, loaded)
  }
  for (const num of [42, 0.5, -5]) {
    const loaded = await loadOne(ENTRY(1, { at: num }))
    ok(loaded.list.length === 1, `有限数字 ${num} 照样收(只是排序靠后,不值得为它抹掉一段历史)`, loaded)
  }
  {
    // at=0 是 entryFromRun 的「两边都没给」哨兵:记录要留下、还原承诺照样给,只是排在最旧那一头。
    const loaded = await loadOne(ENTRY(0))
    ok(loaded.list.length === 1 && F(loaded.entry).at === 0, 'at=0 的记录读得回来', loaded)
    ok(F(loaded.entry).canRollback === true, '还原能力不因为一个缺失的时间戳而消失(备份对应关系还在)')
    const r = await T.loadLog({ getDoc: () => [ENTRY(0), ENTRY(5)], putDoc: () => ({}) })
    ok(FA(F(r).entries).map((e) => e.at).join(',') === '5,0', 'at=0 排在最旧那一头', FA(F(r).entries).map((e) => e.at))
  }
}

section('9. 展示字段脏 ⇒ 用兜底值留行(不该因为文案缺失抹掉一段历史)')
{
  const loaded = await loadOne(ENTRY(1, {
    toolName: undefined, projectId: null,
    changes: [{ rel: 'a.gd', kind: 'rewrite', label: 99, risk: 'bogus', outOfScope: 'yes', to: '' }, { rel: 'b.gd', kind: 'rewrite' }],
    written: ['a.gd', 'b.gd'], failed: [null, { rel: 'b.gd', error: '  ' }]
  }))
  const e = loaded.list
  ok(FA(e).length === 1, '整条留住了', loaded)
  const row = P(FA(F(P(e, 0)).changes), 0)
  ok(S(F(row).label) === '', 'label 脏 ⇒ 空串,不编一句 UI 看得见的假文案')
  ok(F(row).risk === 'low', 'risk 只认 high,别的都按 low 显示(升级判据在 orchestrate 那边)')
  ok(F(row).outOfScope === false, 'outOfScope 只认真布尔')
  ok(!('to' in row), 'to 空串 ⇒ 不占键')
  ok(S(F(P(FA(F(P(e, 0)).changes), 1)).rel) === 'b.gd', '缺 label 的那条也留着')
  ok(F(P(e, 0)).toolName === '' && F(P(e, 0)).projectId === '', '身份展示字段退回空串')
  ok(FA(F(P(e, 0)).failed).length === 2, 'failed 两条都在', FA(F(P(e, 0)).failed))
  ok(F(P(FA(F(P(e, 0)).failed), 1)).error === '没给原因', '空白原因兜底')
}

section('10. loadLog:两张嘴(读失败 / 空账本)与排序')
{
  const boom = mkStore({ getError: 'LMDB 打开失败' })
  const r = await T.loadLog(boom.store)
  ok(S(F(r).error).startsWith('账本读取失败:') && S(F(r).error).includes('LMDB 打开失败'), '读抛异常 ⇒ error 带原因', F(r).error)
  ok(FA(F(r).entries).length === 0 && F(r).dirty === 0, '读失败时不许把「失败」演成「账本还空着」', r)
  for (const shape of [{}, 'x', 42, true]) {
    const rr = await T.loadLog({ getDoc: () => shape, putDoc: () => ({}) })
    ok(S(F(rr).error).includes('不是一个数组'), `文档不是数组(${JSON.stringify(shape)})⇒ 说清这个 id 被占了`, F(rr).error)
  }
  for (const empty of [undefined, null, []]) {
    const rr = await T.loadLog({ getDoc: () => empty, putDoc: () => ({}) })
    ok(S(F(rr).error) === '' && FA(F(rr).entries).length === 0 && F(rr).dirty === 0, `首次使用(${JSON.stringify(empty) ?? String(empty)})⇒ 空账本且无错`, rr)
  }
  {
    const sync = await T.loadLog({ getDoc: () => [ENTRY(9)], putDoc: () => ({}) })
    ok(FA(F(sync).entries).length === 1, 'getDoc 同步返回(不给 Promise)也读得到', sync)
  }
  {
    const rr = await T.loadLog({ getDoc: () => [ENTRY(10), ENTRY(30), ENTRY(20)], putDoc: () => ({}) })
    ok(FA(F(rr).entries).map((e) => e.at).join(',') === '30,20,10', '按时间倒序返回(面板直接渲染)', FA(F(rr).entries).map((e) => e.at))
  }
  {
    const same = await T.loadLog({ getDoc: () => [ENTRY(7, { toolId: 'x1' }), ENTRY(7, { toolId: 'x2' }), ENTRY(7, { toolId: 'x3' })], putDoc: () => ({}) })
    ok(FA(F(same).entries).map((e) => e.toolId).join(',') === 'x1,x2,x3', '同一毫秒的账目保持原顺序(稳定排序,不许乱跳)', FA(F(same).entries).map((e) => e.toolId))
  }
  {
    const rr = await T.loadLog({ getDoc: () => [null, ENTRY(1), 'x', 42, ENTRY(2)], putDoc: () => ({}) })
    ok(FA(F(rr).entries).length === 2 && F(rr).dirty === 3, '脏记录丢弃并计数(面板要能说「3 条已损坏」)', { n: FA(F(rr).entries).length, dirty: F(rr).dirty })
  }
  {
    const rr = await loadOne(ENTRY(1, { changes: [CH_ROW({ kind: 'trash' })], moved: ['a.gd'], canRollback: true }))
    ok(F(rr).entry.canRollback === false, '存储里那句 canRollback:true 不被相信:判据变了旧缓存就是空头承诺', F(rr).entry)
  }
  {
    const rr = await loadOne(ENTRY(1, { cancelled: false, failed: [{ rel: 'b.gd', error: '已取消' }] }))
    ok(F(rr).entry.cancelled === true, '两个来源任一为真就算取消(少报取消比多报危险)', F(rr).entry)
  }
}

section('11. appendRun:记一笔账,只用那两个方法')
{
  const st = mkStore({ doc: [] })
  const r = await T.appendRun(st.store, ENTRY(100))
  ok(F(r).ok === true && S(F(r).error) === '', '记成功', r)
  ok(st.calls.map((c) => c.m).join(',') === 'getDoc,putDoc', '全程只碰 getDoc/putDoc(没有第三个能力可用)', st.calls.map((c) => c.m))
  ok(st.traps.length === 0, '一个删除陷阱都没被触发 —— 备份文件不可能被账本删掉', st.traps)
  const doc = FA(st.lastDoc())
  ok(FA(doc).length === 1 && F(P(doc, 0)).at === 100, '写进去的就是这一条', doc)
  ok(st.calls.filter((c) => c.m === 'putDoc').map((c) => c.id)[0] === T.LOG_DOC_ID, '写的是那个固定文档 id')
  const st2 = mkStore({ doc: [ENTRY(1), ENTRY(2)] })
  await T.appendRun(st2.store, ENTRY(3))
  ok(FA(st2.lastDoc()).map((e) => e.at).join(',') === '3,2,1', '新记录排在最前', FA(st2.lastDoc()).map((e) => e.at))
  const st3 = mkStore({ doc: [ENTRY(50), ENTRY(10)] })
  await T.appendRun(st3.store, ENTRY(20))
  ok(FA(st3.lastDoc()).map((e) => e.at).join(',') === '50,20,10', '乱序的旧账本也按时间归位(不是无脑 prepend)', FA(st3.lastDoc()).map((e) => e.at))
}

section('12. 超 50 条:丢的是最旧那一条(A-16 前半)')
{
  const old = []
  for (let i = 1; i <= 50; i++) old.push(ENTRY(i))
  const st = mkStore({ doc: old })
  const r = await T.appendRun(st.store, ENTRY(1000))
  ok(F(r).ok === true && F(r).overflow === 1, '刚记的第 51 条挤掉一条', r)
  const doc = FA(st.lastDoc())
  ok(FA(doc).length === 50, '文档里正好 50 条', FA(doc).length)
  ok(FA(doc).map((e) => e.at).join(',').startsWith('1000,') === true, '新记录没被挤掉', FA(doc)[0])
  ok(FA(doc).some((e) => e.at === 1) === false, '被丢的是 at=1 那条最旧的', FA(doc).map((e) => e.at).slice(-3))
  ok(FA(doc).some((e) => e.at === 2) === true, '第二旧的还在')
  ok(st.traps.length === 0, '丢记录的过程没碰过文件(备份仍在盘上)', st.traps)
  ok(S(T.droppedNotice(F(r).overflow)).includes('备份文件仍在磁盘上'), '那句提示要把退路说清', T.droppedNotice(F(r).overflow))
  {
    const st2 = mkStore({ doc: old })
    const r2 = await T.appendRun(st2.store, ENTRY(0))
    ok(F(r2).ok === true && F(r2).overflow === 1, '新记录本身最旧时也一样只留 50 条', r2)
    ok(FA(st2.lastDoc()).some((e) => e.at === 0) === false, '刚记这条因为最旧被丢:诚实执行保留规则,不为了「刚记的」开后门')
    ok(FA(st2.lastDoc()).some((e) => e.at === 50) === true, '旧的 50 条一条没少')
  }
  {
    const st3 = mkStore({ doc: [ENTRY(5, { changes: [] })] })
    await T.appendRun(st3.store, ENTRY(6))
    const back = await T.loadLog({ getDoc: () => st3.lastDoc(), putDoc: () => ({}) })
    ok(FA(F(back).entries).length === 2, '记进去的账读得回来(往返无损)', back)
    const older = P(FA(F(back).entries), 1)
    ok(F(older).at === 5 && FA(F(older).changes).length === 0, '空 changes 往返仍是空(不会被 written 反推出行文案)', older)
    ok(FA(F(older).written).length === 1 && FA(F(older).backups).length === 1, 'written/backups 各留各的,不互相补')
    ok(F(older).canRollback === true, '没给 changes 也能承诺还原:判据按 backups 与 moved 走')
    ok(F(P(FA(F(back).entries), 0)).changes.length === 1, '另一条的 changes 没被串味', P(FA(F(back).entries), 0))
  }
}

section('13. 读失败时拒绝写:不拿一条新账抹掉 50 条历史')
{
  const st = mkStore({ getError: 'db 忙' })
  const r = await T.appendRun(st.store, ENTRY(1))
  ok(F(r).ok === false, '这一轮没记上', r)
  ok(st.puts === 0, 'putDoc 一次都没被调用(单文档覆盖写,读不到旧的就等于会删掉旧的)', st.calls)
  ok(S(F(r).error).includes('为不覆掉已有记录') && S(F(r).error).includes('备份文件仍在磁盘上'),
    '原因要把「为什么没记」和「退路还在哪」一起说', F(r).error)
  ok(st.traps.length === 0, '也没顺手做任何删除动作', st.traps)
}

section('14. appendRun 的另两种失败:账目不合格 / 写不进去')
{
  const st = mkStore({ doc: [] })
  const bad = await T.appendRun(st.store, ENTRY(1, { toolId: '' }))
  ok(F(bad).ok === false && S(F(bad).error).includes('缺少 toolId'), '不合格账目先拒,不写', F(bad).error)
  ok(st.puts === 0, '拒了就没碰 putDoc')
  ok(F(bad).overflow === 0, '没写就没有丢弃')
  const st2 = mkStore({ doc: [], putError: '配额满了' })
  const r2 = await T.appendRun(st2.store, ENTRY(2))
  ok(F(r2).ok === false && S(F(r2).error).startsWith('账本写入失败:') && S(F(r2).error).includes('配额满了'), '写入抛异常 ⇒ 如实回报,不重试不吞', F(r2).error)
  ok(st2.calls.filter((c) => c.m === 'putDoc').length === 1, '只试一次', st2.calls.map((c) => c.m))
  const st3 = mkStore({ doc: {} })
  const r3 = await T.appendRun(st3.store, ENTRY(3))
  ok(F(r3).ok === false && S(F(r3).error).includes('不是一个数组'), '文档形状不对 ⇒ 同样拒绝覆盖', F(r3).error)
}

section('15. 按项目筛选与「最近 5 条」(Q29=C)')
{
  const list = [ENTRY(1, { projectId: 'pA' }), ENTRY(2, { projectId: 'pB' }), ENTRY(3, { projectId: 'pA' })]
  ok(T.entriesForProject(list, 'pA').length === 2, '筛出本项目的两条')
  ok(T.entriesForProject(list, 'pA').map((e) => e.at).join(',') === '3,1', '顺序仍是时间倒序')
  ok(T.entriesForProject(list, 'nope').length === 0, '别的项目一条不混')
  ok(T.entriesForProject([ENTRY(4, { projectId: '' }), ENTRY(5, { projectId: 'pA' })], '').length === 1, '空 projectId 只匹配「没归属」,不当「全部」用')
  for (const junk of [null, undefined, 'x', 42, {}]) ok(FA(T.entriesForProject(junk, 'pA')).length === 0, `脏入参返回空(${JSON.stringify(junk) ?? String(junk)})`)
  const many = []
  for (let i = 1; i <= 7; i++) many.push(ENTRY(i, { toolId: i % 2 ? 'fmt' : 'other' }))
  const mine = FA(T.recentFor(many, 'fmt'))
  ok(mine.length === 4, '只看本工具的账目(4 条)', mine.length)
  ok(FA(T.recentFor([ENTRY(1), ENTRY(2), ENTRY(3), ENTRY(4), ENTRY(5), ENTRY(6), ENTRY(7, { toolId: 'fmt' })], 'fmt')).length === 5, '默认截到 5 条(Q29=C)')
  const asc = []
  for (let i = 1; i <= 9; i++) asc.push(ENTRY(i))
  ok(FA(T.recentFor(asc, 'fmt', 3)).map((e) => e.at).join(',') === '9,8,7', '先排序再截,给的是最近的而不是数组最前的', FA(T.recentFor(asc, 'fmt', 3)).map((e) => e.at))
  for (const n of [0, -1, NaN, undefined, null, '5']) ok(FA(T.recentFor(asc, 'fmt', n)).length === 5, `n=${JSON.stringify(n) ?? String(n)} ⇒ 退回默认 5 条`)
  ok(FA(T.recentFor(asc, 'fmt', 2.7)).length === 2, '小数向下取整')
  ok(FA(T.recentFor(null, 'fmt')).length === 0, '脏列表返回空')
}

section('16. 措辞:账本行与执行回执共用一句话(DEV-7)')
{
  const twoOk = ENTRY(1, { written: ['a.gd', 'b.gd'], changes: [CH_ROW(), CH_ROW({ rel: 'b.gd' })], backups: [{ rel: 'a.gd', backupRel: 'x' }, { rel: 'b.gd', backupRel: 'y' }] })
  ok(T.entrySummaryText(twoOk) === '完成:改写 2 个文件,可一键还原', '可还原的那句', T.entrySummaryText(twoOk))
  const mixed = ENTRY(2, { written: ['a.gd'], failed: [{ rel: 'b.gd', error: '炸了' }], backups: [{ rel: 'a.gd', backupRel: 'x' }], changes: [CH_ROW(), CH_ROW({ rel: 'b.gd', kind: 'trash' })] })
  ok(T.entrySummaryText(mixed) === '部分完成:改写 1 个文件、失败 1 条,不可自动还原', '「改写 N 个文件、失败 N 条」这半句必须与 orchestrate.summaryText 逐字相同', T.entrySummaryText(mixed))
  const cancel = ENTRY(3, { written: ['a.gd'], cancelled: true, failed: [{ rel: 'b.gd', error: '已取消' }], backups: [{ rel: 'a.gd', backupRel: 'x' }] })
  ok(S(T.entrySummaryText(cancel)).startsWith('已取消,已完成:改写 1 个文件'), '取消字样排在最前(与回执同规则)', T.entrySummaryText(cancel))
  ok(S(T.entrySummaryText(ENTRY(4, { written: [], backups: [], failed: [] }))).includes('什么都没做成'), '全失败那轮沿用回执那句', T.entrySummaryText(ENTRY(4)))
  for (const junk of [null, undefined, 42, 'x', {}, { written: 'no', failed: null, changes: 3 }]) {
    const s = T.entrySummaryText(junk)
    ok(typeof s === 'string' && s.length > 0, `脏账目也要给出一句话且不抛(${JSON.stringify(junk) ?? String(junk)})`, s)
  }
  ok(T.droppedNotice(0) === '', '没丢东西就不提示')
  ok(T.droppedNotice(-1) === '' && T.droppedNotice(NaN) === '', '脏数字也不提示')
  ok(T.droppedNotice(3) === '已丢弃 3 条最旧记录,备份文件仍在磁盘上', '提示要把「不删备份」说出口(A-16 另一半)', T.droppedNotice(3))
}

section('17. 源码级:这个模块没有删除能力,也不另起措辞')
{
  const src = readFileSync(path.resolve(ROOT, 'src', 'toolkit', 'toollog.ts'), 'utf8')
  for (const banned of ['unlink', 'rmSync', 'rmdir', 'require(', 'window.', 'node:fs', 'movePathsToTrash', 'localStorage', 'writeText']) {
    ok(!src.includes(banned), `源码里不出现「${banned}」:删备份文件这件事在本模块做不到`, src.split('\n').filter((l) => l.includes(banned))[0])
  }
  ok(src.includes("import { summaryText } from './orchestrate'"), '措辞复用 orchestrate,账本不自己再拼一句')
  ok(!/function\s+summaryText/.test(src), '账本里没有第二份 summaryText 实现')
  // ⚠ 这里不再去产物里找那句话:多入口共享 orchestrate.ts 时 Rollup 会把它拆进共享 chunk,
  //   字面量不在 tktoollog.mjs 里。复用由上面两条源码断言 + 第 16 节那句逐字对照共同钉住。
}

console.log(`\n${'='.repeat(56)}\nPASS ${pass}  FAIL ${failures.length}`)
if (failures.length) {
  console.log('失败项:')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log('全部通过')
