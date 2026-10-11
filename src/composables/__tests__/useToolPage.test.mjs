// 工具箱 · 第 1 批 Task 12b:工具页状态机 src/composables/useToolPage.ts 的断言(A-8 / A-16 / Q26 / Q28)。
//
// 这一页是三段式的**用户界面**,所以断言的重点不是「函数返回什么」(那在 orchestrate 与 toollog 里已经钉死),
// 而是四件事:
//   · 选中集只有一个真源:交给插件的 `files` = 页面上勾中的;
//   · 参数没过校验就**不去算**(插件拿到坏值可能算出更坏的东西);
//   · 执行只碰勾中的那些,回执之后账本记的是**执行子集**;
//   · 回滚走的是同一条执行通道(所以它也有备份、也有回执、也进账本),被拒时一条都不写。
//
// 工具对象用 registerTool 真造(跨 bundle 取 tkloader),插件的 plan 是真函数;
// 只有最底层的 window.services / window.ztools.db 是假的 —— 与 useToolkit / gpm 的测试同一档做法。
// ⚠ 本文件是 .mjs:仓库刻意不依赖 Node 的类型剥离,所以这里一律不写 TS 标注。
//
// 用法:node src/composables/__tests__/build-bundle.mjs && node src/composables/__tests__/useToolPage.test.mjs
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../../..')
const BUNDLE = path.resolve(ROOT, '.gpm-test/out/usetoolpage.mjs')
const need = (n) => path.resolve(ROOT, '.gpm-test/out', `${n}.mjs`)
for (const n of ['usetoolpage', 'tkloader', 'tktoollog']) {
  if (!existsSync(need(n))) {
    console.error(`找不到打包产物: ${need(n)}`)
    console.error('请先运行: node src/composables/__tests__/build-bundle.mjs')
    process.exit(2)
  }
}

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
const AT = (arr, i) => F(FA(arr)[i])
const relsOf = (list) => FA(list).map((x) => F(x).rel).join(',')
const relsOfArr = (list) => FA(list).map((x) => S(x)).join(',')

// ── 假宿主:一个库两条路(桥接层走 ztools.db,插件 store 走 services.getDoc)────────
const DB = new Map()
const TREE = [{ rel: 'a.gd', size: 10 }, { rel: 'sub/b.gd', size: 5 }, { rel: 'icon.png', size: 20 }, { rel: 'out.gd', size: 3 }]
const SEED = { 'a.gd': 'A1\nA2\n', 'sub/b.gd': 'B1\n', 'icon.png': 'PNG', 'out.gd': 'O\n' }
let DISK = { ...SEED }
let writes = []
let reads = []
let scanned = []
let trashed = []
const notes = []
let bakSeq = 0

global.window = {
  ztools: {
    db: {
      get: (id) => (DB.has(id) ? { ...DB.get(id) } : null),
      put: (doc) => { DB.set(doc._id, { ...doc }); return { _id: doc._id } },
      remove: (doc) => { DB.delete((doc && doc._id) || ''); return {} },
      allDocs: (p) => [...DB.values()].filter((d) => String(d._id).startsWith(p))
    },
    showNotification: (t) => notes.push(t),
    setFeature: () => ({ success: true }),
    removeFeature: () => ({ success: true }),
    getFeatures: () => []
  },
  services: {
    scanProjectTree: async (pid, opts) => {
      scanned.push({ pid, opts: opts || {} })
      const exts = FA(F(opts).exts).map((e) => String(e).replace(/^\./, '').toLowerCase())
      const files = exts.length ? TREE.filter((f) => exts.includes(f.rel.split('.').pop().toLowerCase())) : TREE
      return { ok: true, files, truncated: false, error: '' }
    },
    readProjectText: async (pid, rel) => {
      reads.push(rel)
      if (!(rel in DISK)) return { ok: false, error: '文件不存在' }
      return { ok: true, text: DISK[rel], bytes: DISK[rel].length, truncated: false, skippedBinary: false }
    },
    writeProjectText: async (pid, rel, text) => {
      writes.push([rel, text])
      if (rel in DISK) {
        const bak = `${rel}.gpm-bak-${++bakSeq}`
        DISK[bak] = DISK[rel]
        DISK[rel] = text
        return { ok: true, bytes: text.length, backupRel: bak, truncated: false, skippedBinary: false }
      }
      DISK[rel] = text
      return { ok: true, bytes: text.length, truncated: false, skippedBinary: false }
    },
    movePathsToTrash: async (pid, rels) => { trashed.push(rels); return { ok: true, moved: rels.length, failed: [] } },
    getDoc: (id) => (DB.has(id) ? { ...DB.get(id) } : null),
    putDoc: (id, data) => { DB.set(id, { ...(data || {}), _id: id }); return true },
    removeDoc: (id) => { DB.delete(id); return true }
  }
}

const T = await import(pathToFileURL(BUNDLE).href)
const LD = await import(pathToFileURL(need('tkloader')).href)

// ── 夹具工具:plan 记录它看到的东西,并故意多返回一条范围外的改动 ─────────
const seen = { calls: 0 }
const MAN = {
  id: 'demo', name: '演示工具', version: '1.0.0', apiVersion: 1, kind: 'action', ui: 'schema',
  summary: 's', cmds: ['演示'], entry: 'index.js', capabilities: ['tree', 'text', 'write', 'store']
}
const MOD = {
  schema: [
    { key: 'targets', type: 'files', label: '要改的文件', exts: ['.gd'] },
    { key: 'limit', type: 'number', label: '上限', min: 1, max: 2, def: 2 },
    // 第 1 批不支持的字段类型:整页不该因此白屏,但原因要显示
    { key: 'wide', type: 'table', label: '不认识的字段' }
  ],
  plan: async (ctx, files, params) => {
    seen.calls++
    seen.files = files
    seen.params = params
    seen.cancelled = ctx.cancelled
    seen.hasWriteText = typeof ctx.writeText
    seen.storeType = typeof ctx.store
    const list = FA(files).map((f) => ({
      rel: f.rel, kind: 'rewrite', label: '加一行 X', risk: 'low', reason: '只追加一行', payload: { text: 'X-' + f.rel }
    }))
    if (params.limit !== 1) list.push({ rel: 'out.gd', kind: 'rewrite', label: '顺手改个没选中的', risk: 'low', reason: 'r', payload: { text: 'O' } })
    return list
  }
}
const toolOf = (mod, manifest) =>
  F(LD.registerTool(manifest || MAN, mod, { source: 'user', dirName: 'demo', files: ['manifest.json', 'index.js'], granted: ['tree', 'text', 'write', 'store', 'ref', 'ui'] }))

const pid = { value: 'p1' }
let P = null

function resetDisk() {
  DISK = { ...SEED }
  writes = []
  reads = []
  scanned = []
  trashed = []
  DB.clear()
  seen.calls = 0
  return { writes, reads }
}
const logDoc = () => FA(F(DB.get('godot/toollog/entries')).value)

section('0. 导出面与工具状态门')
{
  ok(typeof T.useToolPage === 'function', 'useToolPage 已导出')
  const bad = toolOf({ nope: 1 })
  P = T.useToolPage(bad, pid)
  ok(P.usable.value === false, 'bad-module 的工具不可操作(页面该显示原因而不是给一个按下去没反应的按钮)')
  await P.open()
  ok(P.fields.value.length === 0 && P.plan.value === null, '不可操作时不读 schema 不算计划')
  await P.makePlan()
  ok(P.plan.value === null, '坏工具点「算计划」也不产计划')
  await P.execute()
  ok(writes.length === 0, '坏工具执行直接返回,一次写入都不发起')
  ok(typeof P.rollback === 'function' && typeof P.cancel === 'function', '回滚与取消的接口在')
}

section('1. open():坏字段筛掉、其余可用、默认值从 schema 来')
{
  resetDisk()
  P = T.useToolPage(toolOf(MOD), pid)
  await P.open()
  ok(FA(P.schemaIssues.value).length === 1 && S(P.schemaIssues.value[0]).includes('table'),
    '不认识的字段类型被筛掉并给出原因(整页白屏是最糟的收法)', P.schemaIssues.value)
  ok(FA(P.fields.value).map((f) => f.key).join(',') === 'targets,limit', '好字段照常用', FA(P.fields.value).map((f) => f.key))
  ok(P.rawParams.value.limit === 2, 'number 的默认值来自 schema 的 def')
  ok(relsOf(P.candidates.value) === 'a.gd,sub/b.gd,out.gd',
    '候选按 files 字段声明的后缀过滤(页面把 exts 交给宿主,不自己解释路径)', relsOf(P.candidates.value))
  ok(scanned.length === 1 && FA(F(scanned[0]).opts.exts).join(',') === 'gd', '页面把 exts 传给了 scanProjectTree')
  ok(FA(P.treeRels.value).length === 3 && P.treeTruncated.value === false, 'treeRels 是清单原样(creates 判据要靠它)', FA(P.treeRels.value))
}

section('2. 选中集只有一个真源(files 参数就是页面上勾的那些)')
{
  resetDisk()
  P = T.useToolPage(toolOf(MOD), pid)
  await P.open()
  P.picked.value = ['sub/b.gd', 'a.gd']
  ok(relsOf(P.fileArgs.value) === 'a.gd,sub/b.gd',
    'fileArgs 按候选表顺序给(不按点击顺序:不然同一轮两次算出的计划会长得不一样)')
  await P.makePlan()
  ok(relsOf(seen.files) === 'a.gd,sub/b.gd', '插件拿到的 files 就是页面上勾中的')
  ok(FA(seen.params.targets).join(',') === 'a.gd,sub/b.gd',
    'params 里那个 files 字段的值也来自页面勾选(不是 schema 预置的 def ⇒ 不会有第二份选中集)', seen.params.targets)
  ok(seen.params.limit === 2, '其他参数原样交给插件')
  ok(seen.hasWriteText === 'undefined', 'action 型拿不到裸写接口(§5.2:写盘只能经框架三段式)', seen.hasWriteText)
  ok(seen.storeType === 'object', 'store 在 ctx 上(前缀隔离由 gpm 保证,那边已有断言)', seen.storeType)
  P.picked.value = ['a.gd']
  P.rawParams.value.limit = 1     // 关掉夹具那条「顺手多改一个范围外文件」的演示
  await P.makePlan()
  ok(FA(seen.files).length === 1, '改勾选后插件只看到一个文件')
  ok(relsOf(P.plan.value.changes) === 'a.gd', '计划跟着勾选重算', relsOf(P.plan.value.changes))
  ok(relsOfArr(P.plan.value.selectedRels) === 'a.gd', 'ChangePlan 里的选中集与页面同一份', P.plan.value.selectedRels)
}

section('3. 参数没过校验就不去算(Q31 的「报错而不是猜」在页面上的落点)')
{
  resetDisk()
  P = T.useToolPage(toolOf(MOD), pid)
  await P.open()
  P.picked.value = ['a.gd']
  P.rawParams.value.limit = 9
  ok(FA(P.paramIssues.value).length === 1 && S(P.paramIssues.value[0]).includes('不能大于 2'), '越界直接说越界', P.paramIssues.value)
  await P.makePlan()
  ok(seen.calls === 0, '一次都没调插件的 plan(坏值交进去,插件算出的东西更坏)', seen.calls)
  ok(S(P.notice.value).includes('参数还没填对'), '页面上要有那句解释', P.notice.value)
  ok(P.plan.value === null, '没有计划就没有可执行的东西')
  P.rawParams.value.limit = 1
  ok(FA(P.paramIssues.value).length === 0, '改回合法值后错误消失')
  await P.makePlan()
  ok(seen.calls === 1, '这时才去算', seen.calls)
}

section('4. 越界那条被框架强制升 high 且默认不勾(Q28 / A-8)')
{
  resetDisk()
  P = T.useToolPage(toolOf(MOD), pid)
  await P.open()
  P.picked.value = ['a.gd']
  await P.makePlan()   // limit=2 ⇒ 插件会多返回一条 out.gd
  const cs = FA(P.plan.value.changes)
  ok(cs.length === 2, '插件给的两条都在', cs.length)
  const out = cs.find((c) => c.rel === 'out.gd')
  ok(F(out).outOfScope === true && F(out).risk === 'high' && F(out).defaultSelected === false,
    '范围外:强制 high + 不默认勾(插件自己报的是 low,框架只升不降)', [F(out).risk, F(out).outOfScope, F(out).defaultSelected])
  const groups = FA(P.groups.value)
  ok(groups.length === 2 && F(groups[0]).key === 'in' && F(groups[1]).key === 'out', '越界单独分组,范围内在前', FA(groups).map((g) => g.key))
  ok(S(P.summary.value).includes('1 条在选中范围外'), '摘要把越界数说出口', P.summary.value)
  ok(FA(P.checked.value).length === 1, '默认只勾范围内那条', FA(P.checked.value))
  ok(!S(P.warn.value).includes('加一行 X'), '框架那句风险话不复述插件的 label(DEV-7)', P.warn.value)
  ok(S(P.warn.value).includes('gpm-bak'), '备份那句要说得出来', P.warn.value)
}

section('5. 勾选操作与门的判据')
{
  resetDisk()
  P = T.useToolPage(toolOf(MOD), pid)
  await P.open()
  P.picked.value = ['a.gd', 'sub/b.gd']
  await P.makePlan()
  ok(FA(P.checked.value).length === 2, '两条范围内默认全勾;范围外那条(limit=2 时夹具多给的)不自动勾', FA(P.checked.value))
  P.checkNone()
  ok(FA(P.checked.value).length === 0 && P.gate.value.ok === false, '一条都没勾 ⇒ 门拒', P.gate.value)
  ok(S(P.gate.value.reason).length > 0, '拒的原因是人话', P.gate.value.reason)
  ok(P.canExecute.value === false, '门拒着就没有执行按钮')
  await P.execute()
  ok(writes.length === 0, '一条都没勾时就算被调用也不写(按钮禁用之外还要有一道真闸)', writes.length)
  ok(S(P.notice.value).includes(S(P.gate.value.reason)), '被门拦下时要把门那句原因显示出来,不是静默什么都不做', P.notice.value)
  P.checkAll()
  ok(FA(P.checked.value).length === 3, '全选会连范围外那条一起勾上(用户显式负责,框架已经警告过)', FA(P.checked.value))
  P.checkDefaults()
  ok(FA(P.checked.value).length === 2, '回到默认勾选就是去掉越界那条')
  const one = FA(P.checked.value)[0]
  P.toggleChange(one)
  ok(FA(P.checked.value).length === 1 && P.pickedCount.value === 1, '单条取消生效且计数跟着变', FA(P.checked.value))
  P.toggleChange(one)
  ok(FA(P.checked.value).length === 2, '再点回来')
  ok(F(P.pickedBytes.value).bytes >= 0, '字节数给得出(选 0 条时报 0 而不是 undefined)', P.pickedBytes.value)
}

section('6. 执行:只写勾中的,回执之后账本记的是执行子集(A-16)')
{
  resetDisk()
  P = T.useToolPage(toolOf(MOD), pid)
  await P.open()
  P.picked.value = ['a.gd']
  await P.makePlan()   // 两条:a.gd 勾中,out.gd 范围外没勾
  await P.execute()
  ok(writes.map((w) => w[0]).join(',') === 'a.gd', '只写勾中的那一条(范围外那条一个字节都没动)', writes.map((w) => w[0]))
  ok(DISK['a.gd'] === 'X-a.gd', '盘上真的变了', DISK['a.gd'])
  ok(DISK['a.gd.gpm-bak-1'] === 'A1\nA2\n', '原内容先落备份', Object.keys(DISK))
  const r = F(P.receipt.value)
  ok(relsOfArr(r.written) === 'a.gd' && FA(r.failed).length === 0 && r.ok === true, '回执如实', r.written)
  ok(S(P.notice.value) === '完成:改写 1 个文件', '回执那句话来自 orchestrate', P.notice.value)
  ok(logDoc().length === 1, '账本多了一条', logDoc().length)
  const e0 = AT(logDoc(), 0)
  ok(S(e0.toolId) === 'demo' && S(e0.projectId) === 'p1' && typeof e0.at === 'number', '账目带归属', [e0.toolId, e0.projectId])
  ok(FA(e0.changes).length === 1 && S(AT(FA(e0.changes), 0).rel) === 'a.gd',
    '账本记的是**执行的那份子集**,不是整份预览', FA(e0.changes).map((c) => c.rel))
  ok(FA(e0.backups).length === 1 && e0.canRollback === true, '备份对应关系进了账本', e0.backups)
  ok(FA(P.recent.value).length === 1, '工具页底部能看到这一条(Q29=C 的最近 5 条)', FA(P.recent.value).length)
  ok(P.running.value === false, '跑完不留在 running(按钮不许卡在禁用态)')
}

section('7. 写盘原语失败 / 执行中取消 / 账本溢出,三种话都要说')
{
  resetDisk()
  const saved = global.window.services
  global.window.services = { ...saved, writeProjectText: async (p, rel) => ({ ok: false, error: '只读文件系统' }) }
  P = T.useToolPage(toolOf(MOD), pid)
  await P.open()
  P.picked.value = ['a.gd']
  await P.makePlan()
  await P.execute()
  global.window.services = saved
  ok(S(AT(FA(F(P.receipt.value).failed), 0).error).includes('只读文件系统'), '原语的原话进回执那一条(细节不塞进摘要句)', FA(F(P.receipt.value).failed))
  ok(S(P.notice.value).includes('失败 1 条'), '摘要只说数量,原因在回执的行里', P.notice.value)
  ok(logDoc().length === 1, '失败那一轮照样记账(用户得知道试过什么)', logDoc().length)

  resetDisk()
  P = T.useToolPage(toolOf(MOD), pid)
  await P.open()
  P.picked.value = ['a.gd', 'sub/b.gd']
  await P.makePlan()
  const realWrite = global.window.services.writeProjectText
  global.window.services.writeProjectText = async (p, rel, text) => {
    const out = await realWrite(p, rel, text)
    P.cancel()
    return out
  }
  await P.execute()
  global.window.services.writeProjectText = realWrite
  ok(writes.length === 1, '取消之后没有继续写下一个', writes.map((w) => w[0]))
  const r2 = F(P.receipt.value)
  ok(FA(r2.failed).length === 1 && S(AT(FA(r2.failed), 0).error) === '已取消', '被取消的那条记「已取消」', FA(r2.failed))
  ok(r2.cancelled === true, '回执标了取消')
  const e2 = AT(logDoc(), 0)
  ok(e2.cancelled === true && FA(e2.changes).length === 1, '账本里 changes 只有真做过的那条,failed 说清停在哪', [FA(e2.changes).length, FA(e2.failed).length])
  ok(S(P.notice.value).includes('已取消'), '回执那句来自同一份数据', P.notice.value)

  resetDisk()
  const many = []
  for (let i = 0; i < 50; i++) many.push({ at: 1000 + i, toolId: 'other', toolName: 'o', projectId: 'p1', changes: [], backups: [], written: [], moved: [], failed: [], cancelled: false, canRollback: false })
  DB.set('godot/toollog/entries', { _id: 'godot/toollog/entries', value: many })
  P = T.useToolPage(toolOf(MOD), pid)
  await P.open()
  P.picked.value = ['a.gd']
  await P.makePlan()
  await P.execute()
  ok(S(P.notice.value).includes('备份文件仍在磁盘上'), '丢记录时必须连带说明退路还在', P.notice.value)
  ok(logDoc().length === 50, '仍然只留 50 条', logDoc().length)
  ok(!logDoc().some((e) => e.at === 1000), '丢的是最旧那条')
}

section('8. 回滚走同一条执行通道:有备份、有回执、进账本')
{
  resetDisk()
  P = T.useToolPage(toolOf(MOD), pid)
  await P.open()
  P.picked.value = ['a.gd']
  await P.makePlan()
  await P.execute()
  writes = []
  reads = []
  const entry = AT(logDoc(), 0)
  const bak0 = S(AT(FA(entry.backups), 0).backupRel)
  ok(FA(entry.backups).length === 1 && bak0.startsWith('a.gd.gpm-bak-'), '账本记下了备份名(回滚靠的就是这一组对应关系)', entry.backups)
  ok(DISK['a.gd'] === 'X-a.gd', '对照:回滚前它是新内容', DISK['a.gd'])
  const res = F(await P.rollback(entry))
  ok(res.ok === true && relsOfArr(res.restored) === 'a.gd', '还原成功', res)
  ok(DISK['a.gd'] === 'A1\nA2\n', '内容真的回到执行前', DISK['a.gd'])
  ok(reads.includes(bak0), '还原读的就是账本里那个备份名', reads)
  ok(writes.length === 1 && writes[0][1] === 'A1\nA2\n', '写回去的走的是同一条原语(不是另开一个裸写口子)', writes)
  // 回滚那一轮自己也要能撤销:宿主写之前又落了一份新备份,里面装的是回滚前的内容
  const newer = Object.keys(DISK).filter((k) => /^a\.gd\.gpm-bak-\d+$/.test(k) && DISK[k] === 'X-a.gd')
  ok(newer.length >= 1, '回滚前那份「X-a.gd」也进了新备份(改错了还能改回来)', Object.keys(DISK))
  ok(logDoc().length === 2, '回滚也记了一条账(不然盘上变了而账上没有)', logDoc().length)
  ok(S(AT(logDoc(), 0).toolId).length > 0 && AT(logDoc(), 0).canRollback === true, '新那条同样可还原', AT(logDoc(), 0).canRollback)

  resetDisk()
  P = T.useToolPage(toolOf(MOD), pid)
  await P.open()
  const r1 = F(await P.rollback({ at: 1, toolId: 'x', toolName: 'x', projectId: 'p1', changes: [], backups: [], written: ['a.gd'], moved: [], failed: [], cancelled: false, canRollback: false }))
  ok(r1.ok === false && S(r1.text).includes('备份'), '没备份就拒绝,并说清为什么', r1.text)
  ok(writes.length === 0, '拒绝时一个字节都没写')
  const r2 = F(await P.rollback({ at: 1, toolId: 'x', toolName: 'x', projectId: 'p1', changes: [{ rel: 'a.gd', kind: 'trash', label: '删', risk: 'high', outOfScope: false }], backups: [{ rel: 'a.gd', backupRel: 'b' }], written: [], moved: ['a.gd'], failed: [], cancelled: false, canRollback: false }))
  ok(r2.ok === false && S(r2.text).includes('删除或改名'), '账目里有 trash 那一行 ⇒ 按「一键还原只能做到一半」拒绝(判据顺序在 toollog 那侧)', r2.text)
  ok(writes.length === 0 && trashed.length === 0, '既不写也不删(回滚不该顺手做别的动作)')
  const r2b = F(await P.rollback({ at: 1, toolId: 'x', toolName: 'x', projectId: 'p1', changes: [], backups: [{ rel: 'a.gd', backupRel: 'b' }], written: [], moved: ['a.gd'], failed: [], cancelled: false, canRollback: false }))
  ok(r2b.ok === false && S(r2b.text).includes('回收站'), 'changes 空而 moved 非空 ⇒ 走到那句「得由你在回收站里做」', r2b.text)
  const r3 = F(await P.rollback(null))
  ok(r3.ok === false && S(r3.text).length > 0, '脏账目不抛,给一句原因', r3)
}

section('9. 账本读不出来:页面要说「读取失败」而不是「还没有记录」')
{
  resetDisk()
  const savedGet = global.window.ztools.db.get
  global.window.ztools.db.get = () => { throw new Error('LMDB 打开失败') }
  P = T.useToolPage(toolOf(MOD), pid)
  await P.loadHistory()
  global.window.ztools.db.get = savedGet
  ok(S(P.historyError.value).includes('LMDB 打开失败'), '错误原话说出来', P.historyError.value)
  ok(FA(P.history.value).length === 0, '读失败时列表是空的(但配着那句错误,不是「一条都没有」)')
  ok(trashed.length === 0 && writes.length === 0, '读失败绝不写盘(单文档覆盖会抹掉既有记录,判据在 toollog)', [trashed.length, writes.length])
}

section('9b. 账本写不进去:不许假装记上了(A-16 的诚实那一半)')
{
  resetDisk()
  const savedPut = global.window.ztools.db.put
  global.window.ztools.db.put = () => ({ error: 'LMDB 写失败' })
  P = T.useToolPage(toolOf(MOD), pid)
  await P.open()
  P.picked.value = ['a.gd']
  P.rawParams.value.limit = 1
  await P.makePlan()
  await P.execute()
  global.window.ztools.db.put = savedPut
  ok(writes.length === 1, '盘是**真的写了**(账本失败不该拦执行,那是另一件事)', writes.map((w) => w[0]))
  ok(S(P.notice.value).includes('没记上') || S(P.notice.value).includes('失败'), '但回执那句话必须带上「账本没记上」', P.notice.value)
  ok(FA(P.recent.value).length === 0, '列表里没有假装成功的那条')
}

section('10. view 型工具:不跑三段式,页面不给执行按钮')
{
  resetDisk()
  const vt = toolOf({ view: () => null }, { ...MAN, id: 'viewer', kind: 'view', ui: 'render', capabilities: ['tree', 'text', 'ui'] })
  ok(vt.state === 'ok', 'view 型注册成功', vt.state)
  P = T.useToolPage(vt, pid)
  await P.open()
  ok(FA(P.fields.value).length === 0, 'render 型没有 schema 也正常(§5.2:view 必须 render)', FA(P.fields.value))
  await P.makePlan()
  ok(P.plan.value !== null && FA(P.plan.value.changes).length === 0, '不跑三段式:交一个空计划而不是崩', F(P.plan.value).planError)
  ok(S(P.plan.value.planError).includes('plan'), '原因说清是缺 plan', S(P.plan.value.planError))
  ok(P.canExecute.value === false, 'view 型的页面不该有可点的执行按钮')
}

console.log(`\n${'='.repeat(56)}\nPASS ${pass}  FAIL ${failures.length}`)
if (failures.length) {
  console.log('失败项:')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log('全部通过')
