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

// ── 假宿主:照着真宿主的门面摆 ────────────────────────────────
// `services.js:347` 那个对象里**没有** getDoc/putDoc/removeDoc —— 文档读写在渲染层走的是桥接层
// (`services/bridge.ts` → `window.ztools.db`)。所以这里只给 ztools.db 那一条路,
// services 那张表一个文档方法都不给:补进夹具就等于把 DEV-18 那个缺口重新藏起来。
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
      if (rel === 'big.gd') return { ok: true, bytes: 900000, truncated: true }
      if (rel === 'bin.gd') return { ok: true, bytes: 40, skippedBinary: true }
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
    movePathsToTrash: async (pid, rels) => { trashed.push(rels); return { ok: true, moved: rels.length, failed: [] } }
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

section('11. diff 预览:只裁展示,三种「给不出 diff」各自说清')
{
  resetDisk()
  P = T.useToolPage(toolOf(MOD), pid)
  await P.open()
  P.picked.value = ['a.gd']
  P.rawParams.value.limit = 1
  await P.makePlan()
  const ch = AT(FA(P.plan.value.changes), 0)
  ok(P.diffible(ch) === true, '正文在 payload 里 ⇒ 这条可以看差异')
  reads.length = 0
  const d1 = F(await P.loadDiff(ch))
  ok(d1.ready === true && S(d1.error) === '', '读到旧正文并算出 diff', d1.error)
  // 'A1\nA2\n' 按仓库的行数口径(split('\n'),末尾换行多出一个空元素)是 3 行 ⇒ 换成 1 行就是 +1 / -3
  ok(F(d1.diff).added === 1 && F(d1.diff).removed === 3, '增删数与行数口径同源(见 diff.ts 的 toLines)', F(d1.diff))
  ok(d1.oldText === 'A1\nA2\n' && d1.newText === 'X-a.gd', '新旧两边都交出去(UI 要画 hunks)', [d1.oldText, d1.newText])
  await P.loadDiff(ch)
  ok(reads.length === 1, '第二条不重复读盘(展开→收起→再展开只读一次)', reads)
  // 计划重算 ⇒ 缓存作废:同一 rel 也要重新读一次
  await P.makePlan()
  ok(Object.keys(F(P.previews.value)).length === 0, '重算计划后 diff 缓存清空(不然显示的是上一轮的正文)')
  const noText = F(await P.loadDiff({ id: 'x', rel: 'a.gd', kind: 'rewrite', payload: {} }))
  ok(noText.ready === false && S(noText.error).includes('执行那一刻'), 'payload 里没正文 ⇒ 说清是插件的形状决定没有 diff', noText.error)
  ok(noText.oldText === 'A1\nA2\n', '旧正文还是给了(只缺新正文,不该一起装没有)')
  const gone = F(await P.loadDiff({ id: 'y', rel: 'nope.gd', kind: 'rewrite', payload: { text: 'z' } }))
  ok(gone.ready === false && S(gone.error).includes('文件不存在'), '读不到原文件时不画空 diff', gone.error)
  const half = F(await P.loadDiff({ id: 'z', rel: 'big.gd', kind: 'rewrite', payload: { text: 'z' } }))
  ok(half.ready === false && S(half.error).includes('完整正文'), '只拿到部分内容就不画 diff(改了会把半个文件写回去)', half.error)
  ok(F(await P.loadDiff(null)).ready === false, '脏入参不抛')
}

section('12. 插件面接线:store / 宿主 UI / 项目列表不在 window.services 里,靠桥接层补齐(§5.3 / DEV-18)')
{
  // gpm.test.mjs 是自己注入 host.services 来测那层门的,照不出**装配层有没有把东西接上**。
  // 真宿主的 services 门面(services.js:347)只有项目文件那一族原语,文档读写 / 通知 / 系统对话框
  // 在渲染层唯一的通路是 services/bridge.ts。夹具照真宿主摆 ⇒ 装配层漏一个就当场红。
  const noDocs = !('getDoc' in global.window.services) && !('putDoc' in global.window.services) && !('removeDoc' in global.window.services)
  ok(noDocs, '假宿主与真宿主同形:services 门面没有文档三件套(补进夹具就是把这缺口藏起来)', Object.keys(global.window.services))

  resetDisk()
  global.window.ztools.db.put({ _id: 'godot/project/p1', id: 'godot/project/p1', name: '演示项目', path: 'E:/mock/demo' })
  const OPENED = ['C:/x/a.gd', 'C:/x/b.gd']
  // 两轮各记一份参数:只看「最后一次」的话,取消那一轮的默认标题会把成功那一轮的判据顶掉
  const openCalls = []
  const saveCalls = []
  // 宿主「取消」时给的是 undefined(不是空数组、也不是空串),所以这两支单独摆一次:
  // 只测成功那一支的话,「把 undefined 原样交出去」这种写法在夹具里是抓不出来的
  let OPEN_RETURN = OPENED
  let SAVE_RETURN = 'C:/x/out.json'
  const opened = []
  const savedOpen = global.window.ztools.showOpenDialog
  const savedSave = global.window.ztools.showSaveDialog
  const savedShell = global.window.ztools.shellOpenPath
  global.window.ztools.showOpenDialog = (o) => { openCalls.push(o); return OPEN_RETURN }
  global.window.ztools.showSaveDialog = (o) => { saveCalls.push(o); return SAVE_RETURN }
  global.window.ztools.shellOpenPath = (p) => { opened.push(p) }
  const notesBefore = notes.length

  const rec = {}
  const uiMod = {
    schema: [{ key: 'targets', type: 'files', label: 'f', exts: ['.gd'] }],
    plan: async (ctx, files) => {
      try {
        rec.storePut = await ctx.store.put('prefs', { n: 1, s: 'x' })
        rec.storeGet = await ctx.store.get('prefs')
        rec.rawDoc = global.window.ztools.db.get('gpm/plugin/demo-ui/prefs')
        rec.removed = await ctx.store.remove('prefs')
        rec.afterRemove = await ctx.store.get('prefs')
        rec.staleGet = await ctx.store.get('没有这个键')
        ctx.notify(`这一轮要看 ${files.length} 个文件`)
        rec.dialog = await ctx.openDialog({ title: '挑文件', extensions: ['.gd'] })
        rec.save = await ctx.saveDialog({ title: '存到哪' })
        OPEN_RETURN = undefined
        SAVE_RETURN = undefined
        rec.cancelOpen = await ctx.openDialog({})
        rec.cancelSave = await ctx.saveDialog({})
        rec.projects = await ctx.listProjects()
        rec.one = await ctx.getProject()
        rec.byId = await ctx.getProject('godot/project/p1')
        ctx.copyText('给剪贴板')
        ctx.shellOpenPath('C:/x')
      } catch (e) {
        rec.threw = String((e && e.message) || e)
      }
      return []
    }
  }
  const uiTool = toolOf(uiMod, { ...MAN, id: 'demo-ui', capabilities: ['tree', 'text', 'store', 'ui'] })
  P = T.useToolPage(uiTool, pid)
  await P.open()
  P.picked.value = ['a.gd']
  await P.makePlan()

  ok(rec.threw === undefined, '一整套 ctx 调用没有一个抛(插件里一句 notify 不该把整页炸掉)', rec.threw)
  // store:落进的是 LMDB 那同一个库,键由框架拼前缀,值住在文档的 value 字段里
  ok(rec.storePut === true, 'store.put 真的写成功了(装配层没接桥接层时它永远回 false)', rec.storePut)
  ok(F(rec.rawDoc)._id === 'gpm/plugin/demo-ui/prefs', '前缀由框架拼在 id 上(§D #10)', rec.rawDoc)
  ok(F(F(rec.rawDoc).value).n === 1, '值包在 value 字段里(LMDB 的文档必须是对象)')
  ok(F(rec.storeGet).n === 1 && F(rec.storeGet).s === 'x', 'store.get 读得回来同一个值', rec.storeGet)
  ok(rec.removed === true && !DB.has('gpm/plugin/demo-ui/prefs'), 'store.remove 走的是同一条桥接路', [rec.removed, DB.has('gpm/plugin/demo-ui/prefs')])
  ok(rec.afterRemove === null && rec.staleGet === null, '删掉之后与从没写过的键都读回 null,不是空对象(插件据此判「第一次用」)', [rec.afterRemove, rec.staleGet])
  // 宿主 UI
  ok(notes.length === notesBefore + 1 && S(notes[notes.length - 1]).includes('这一轮要看 1 个文件'), 'ctx.notify 到了宿主的 showNotification', notes.slice(notesBefore))
  ok(F(rec.dialog).canceled === false && FA(F(rec.dialog).paths).join('|') === OPENED.join('|'), 'openDialog 把多选结果交给插件', rec.dialog)
  // 成功那一轮送出去的第一个参数对象(取消那一轮的参数是空的,别拿它判默认标题)
  const oa = F(FA(openCalls)[0])
  const sa = F(FA(saveCalls)[0])
  ok(FA(oa.properties).join(',') === 'openFile,multiSelections', '多选是真的往宿主那儿要了 multiSelections', oa.properties)
  // 先取元素再取字段,而且字段也过一遍 FA:少写一层判据时这里会 TypeError 撞停整节(看着像「抓到了」,其实一条统计都没产出)
  const picked0 = F(FA(F(oa).filters)[0])
  ok(FA(picked0.extensions).join(',') === 'gd', '后缀交给宿主前去掉了点(.gd ⇒ gd)', F(oa).filters)
  ok(F(rec.save).canceled === false && S(F(rec.save).path) === 'C:/x/out.json', 'saveDialog 的返回形状对', rec.save)
  ok(S(sa.title) === '存到哪', '插件给的 title 原样送到宿主', sa)
  ok(openCalls.length === 2 && saveCalls.length === 2, '成功与取消各真打到宿主一次(取消那一支不是夹具编的)', [openCalls.length, saveCalls.length])
  ok(S(F(saveCalls[1]).title) === '另存为', '插件没给 title 时才有默认值(默认值不许盖住用户给的那句)', saveCalls[1])
  ok(F(rec.cancelOpen).canceled === true && FA(F(rec.cancelOpen).paths).length === 0, '取消时是「取消」而不是「选了 0 个文件」的空数组直漏', rec.cancelOpen)
  ok(F(rec.cancelSave).canceled === true && S(F(rec.cancelSave).path) === '', '保存框取消同一条形状', rec.cancelSave)
  ok(FA(rec.projects).length === 1 && S(F(FA(rec.projects)[0]).name) === '演示项目', 'listProjects 从 godot/project/ 前缀读得到项目', rec.projects)
  ok(F(rec.one).name === '演示项目' && F(rec.byId).name === '演示项目', 'getProject 两种写法都认(短 id 补前缀,完整 id 原样)', [rec.one, rec.byId])
  ok(opened.join(',') === 'C:/x', 'shellOpenPath 走的是桥接层的 openPath', opened)

  global.window.ztools.showOpenDialog = savedOpen
  global.window.ztools.showSaveDialog = savedSave
  global.window.ztools.shellOpenPath = savedShell

  // 没声明 ui 的工具:那三个入口按 gpm 的门应该是「不存在」或「只记一行痕」,总之不许打到宿主
  const notesMid = notes.length
  const noUi = toolOf({
    schema: [{ key: 'targets', type: 'files', label: 'f', exts: ['.gd'] }],
    plan: async (ctx) => {
      rec.noUiStore = typeof ctx.store
      rec.noUiDialog = await ctx.openDialog({})
      return []
    }
  }, { ...MAN, id: 'demo-noui', capabilities: ['tree', 'text'] })
  P = T.useToolPage(noUi, pid)
  await P.open()
  P.picked.value = ['a.gd']
  await P.makePlan()
  ok(rec.noUiStore === 'undefined', '没声明 store ⇒ ctx.store 不存在(而不是给一个按下去没反应的物件)', rec.noUiStore)
  ok(F(rec.noUiDialog).canceled === true && FA(F(rec.noUiDialog).paths).length === 0, '没声明 ui ⇒ 对话框直接回「取消」,没去碰宿主', rec.noUiDialog)
  ok(notes.length === notesMid, '没声明 ui 时一句 notify 都没送到宿主', notes.length - notesMid)
}

section('13. 插件的 apply 收到的必须是 (ctx, change) —— §F 的 entry 契约(DEV-19)')
{
  // 契约写的是 `apply(ctx, change)`,骨架模板的注释也这么教;而 orchestrate 的注入缝是
  // `apply(change, index)`。这两者之间必须有人绑 ctx —— 交给页面来绑,插件收到的才是契约说的那个东西。
  // 直接把模块上的原函数交出去时(出事那一版),插件的「ctx」其实是 change、「change」是条数,
  // 它自己的 `change.payload.text` 当场 TypeError,而这一层以前一条断言都没有。
  resetDisk()
  const seenApply = {}
  const applier = {
    schema: [{ key: 'targets', type: 'files', label: 'f', exts: ['.gd'] }],
    plan: async (ctx, files) => FA(files).map((f) => ({
      rel: F(f).rel, kind: 'rewrite', label: '换一个正文', risk: 'low', reason: 'r', payload: { text: 'NEW-' + F(f).rel }
    })),
    apply: async (ctx, change, index) => {
      seenApply.ctxType = typeof ctx
      seenApply.readText = typeof F(ctx).readText
      seenApply.store = typeof F(ctx).store
      seenApply.cancelled = F(ctx).cancelled
      seenApply.rel = S(F(change).rel)
      seenApply.kind = S(F(change).kind)
      seenApply.text = S(F(F(change).payload).text)
      seenApply.idIsStable = typeof F(change).id === 'string' && F(change).id.length > 0
      seenApply.rels = (seenApply.rels || []).concat(S(F(change).rel))
      seenApply.seq = (seenApply.seq || []).concat(index)
      return { ok: true }
    }
  }
  P = T.useToolPage(toolOf(applier), pid)
  await P.open()
  P.picked.value = ['a.gd', 'sub/b.gd']
  await P.makePlan()
  await P.execute()

  ok(seenApply.ctxType === 'object' && seenApply.readText === 'function', '第一个参数真是 ctx(有 ctx.readText 那些能力面)', seenApply)
  ok(seenApply.store === 'object', 'apply 里的 ctx.store 也在(执行时也要能读自己的设置)', seenApply.store)
  ok(seenApply.cancelled === false, 'ctx.cancelled 是布尔快照(契约那条:循环里要查它)', seenApply.cancelled)
  ok(seenApply.rel === 'sub/b.gd' && seenApply.kind === 'rewrite', '第二个参数真是那条 change 本身', [seenApply.rel, seenApply.kind])
  ok(FA(seenApply.rels).join(',') === 'a.gd,sub/b.gd', '两条各收到自己那一条(不是把同一件事做两遍)', seenApply.rels)
  ok(FA(seenApply.seq).join(',') === '0,1', '注入缝的第三个参数是这一轮的序号(0 起算),它不该被当成 change', seenApply.seq)
  ok(seenApply.text === 'NEW-sub/b.gd', 'change.payload 在(插件按 payload.text 决定正文)', seenApply.text)
  ok(seenApply.idIsStable === true, 'change.id 是框架补过的稳定键(预览与执行认的是同一条)')
  ok(writes.length === 2 && writes.map((w) => w[1]).join(',') === 'NEW-a.gd,NEW-sub/b.gd', 'apply 只回 {ok} 时框架照 payload.text 写盘(DEV-13 那两条来源)', writes)
  ok(S(P.notice.value).includes('2') && FA(F(P.receipt.value).failed).length === 0, '回执是成功那一条', P.notice.value)
}

section('14. notice 按「成了没成」分级(真宿主反馈:被拦的提示是绿色的,读起来像成功)')
{
  // `.notice` 以前只有一种颜色 var(--ok),而 notice 承载八处语义 —— 门拒绝、planError、回滚失败全是绿的。
  // 判据方向:**只有「这一轮真的落盘并记上了」才算 ok,其余一律 bad**。
  // 「没算出东西」也归 bad 是有意的:用户点「算一遍」而什么都没成,下一步动作正是被这条提示驱动的;
  // 颜色只负责回答「成没成」,原因归措辞。反悔成本低(要三级就是再加一个分支)。
  ok(typeof P.noticeKind === 'object' && typeof F(P.noticeKind).value === 'string', 'noticeKind 在导出面上(渲染层靠它挂类)', typeof P.noticeKind)

  // ① 参数没过校验 ⇒ 被拦
  resetDisk()
  P = T.useToolPage(toolOf(MOD), pid)
  await P.open()
  P.picked.value = ['a.gd']
  P.rawParams.value.limit = 99          // 超出 schema 的 max:2
  await P.makePlan()
  ok(S(P.notice.value).includes('参数还没填对'), '被拦时那句话还在(措辞一个字没动)', P.notice.value)
  ok(F(P.noticeKind).value === 'bad', '但它是 bad 不是 ok —— 用户报的那条「显示错误」就是这个绿色', F(P.noticeKind).value)

  // ② 插件算失败(planError)
  resetDisk()
  P = T.useToolPage(toolOf({ schema: MOD.schema, plan: async () => '不是数组' }), pid)
  await P.open()
  P.picked.value = ['a.gd']
  P.rawParams.value.limit = 1
  await P.makePlan()
  ok(S(P.notice.value).length > 0 && F(P.noticeKind).value === 'bad', 'planError 同级(失败冒充成功是最坏的一种)', [P.notice.value, F(P.noticeKind).value])

  // ③ 门拒绝(一条都没勾)
  resetDisk()
  P = T.useToolPage(toolOf(MOD), pid)
  await P.open()
  P.picked.value = ['a.gd']
  P.rawParams.value.limit = 1
  await P.makePlan()
  P.checkNone()
  await P.execute()
  ok(S(P.notice.value).length > 0 && F(P.noticeKind).value === 'bad', '执行被门拦下 ⇒ bad', [P.notice.value, F(P.noticeKind).value])

  // ④ 真的做完了 ⇒ ok(这一级只留给它)
  resetDisk()
  P = T.useToolPage(toolOf(MOD), pid)
  await P.open()
  P.picked.value = ['a.gd']
  P.rawParams.value.limit = 1
  await P.makePlan()
  await P.execute()
  ok(F(P.noticeKind).value === 'ok' && S(P.notice.value).includes('改写 1 个文件'), '执行成功才是 ok', [P.notice.value, F(P.noticeKind).value])

  // ⑤ 回滚失败 ⇒ bad(它以前是「绿字里追加一段失败」)
  const entry = AT(logDoc(), 0)
  const bak = S(AT(FA(entry.backups), 0).backupRel)
  delete DISK[bak]                      // 备份没了:还原做不成,这一轮就是没成
  const res = F(await P.rollback(entry))
  ok(res.ok !== true, '夹具确实造出了失败那一支', res.ok)
  ok(F(P.noticeKind).value === 'bad', '回滚失败 ⇒ bad(不许接着用成功色)', [S(P.notice.value), F(P.noticeKind).value])

  // ⑥ 没话可说时不留一条「看着像成功」的着色
  resetDisk()
  P = T.useToolPage(toolOf(MOD), pid)
  await P.open()
  ok(S(P.notice.value) === '' && F(P.noticeKind).value === '', 'notice 空 ⇒ 级别也空(类不挂上去)', [P.notice.value, F(P.noticeKind).value])

  // ⑦ 部分完成:回执那句自己会写「失败 N 条」,颜色必须跟着翻 —— 它是最容易被当成成功的一种没成
  resetDisk()
  const savedWrite = global.window.services.writeProjectText
  global.window.services.writeProjectText = async () => ({ ok: false, error: '磁盘是只读的' })
  P = T.useToolPage(toolOf(MOD), pid)
  await P.open()
  P.picked.value = ['a.gd']
  P.rawParams.value.limit = 1
  await P.makePlan()
  await P.execute()
  global.window.services.writeProjectText = savedWrite
  ok(S(P.notice.value).includes('失败'), '回执说的是失败', P.notice.value)
  ok(F(P.noticeKind).value === 'bad', '部分完成 ⇒ bad(不是那条成功绿)', F(P.noticeKind).value)
}

section('15. 插件面的三条话路:ctx.log / ctx.progress / 参数预览 count(§G DEV-27 / DEV-28)')
{
  // 第 1 批的断线:`makeHost` 没传 onLog / onProgress ⇒ 插件里所有 ctx.log 都是静默 no-op。
  // gpm.ts 那层的单测只回答「给了 onLog 会不会往外传」,**照不出装配层传没传**(与 DEV-18/19 同一族)。
  ok(typeof P.logs === 'object' && Array.isArray(F(P.logs).value), 'logs 在导出面上(视图靠它显示最近几条)')
  ok(typeof P.logsTail === 'object' && Array.isArray(F(P.logsTail).value), 'logsTail:切几条这件事在页面里做,视图不判断')
  ok(typeof P.paramHint === 'object' && typeof S(F(P.paramHint).value) === 'string', 'paramHint 在导出面上')
  ok(typeof P.dangling === 'object' && typeof S(F(P.dangling).value) === 'string', 'dangling(断链那句)在导出面上')

  // ① log 真的落地
  resetDisk()
  const LOUD = {
    schema: MOD.schema,
    plan: async (ctx) => {
      ctx.log('warn', 'big.gd:超出读取上限,不改写')
      ctx.log('warn', 'bin.gd:被认成二进制,不改写')
      ctx.progress(3, 10)
      return [{ rel: 'a.gd', kind: 'rewrite', label: '加一行 X', risk: 'low', reason: 'r', payload: { text: 'X' } }]
    }
  }
  P = T.useToolPage(toolOf(LOUD), pid)
  await P.open()
  P.picked.value = ['a.gd']
  P.rawParams.value.limit = 1
  await P.makePlan()
  ok(FA(P.logs.value).length === 2, '插件 ctx.log 的两条都收到了(没接 onLog 时这里必定是 0)', FA(P.logs.value).length)
  ok(S(F(AT(P.logsTail.value, 1)).msg).includes('二进制'), 'tail 给的是最近几条、按顺序', P.logsTail.value)
  ok(F(P.progress).value && F(P.progress).value.done === 3 && F(P.progress).value.total === 10,
    'ctx.progress 接到了(不传 onProgress 时永远是 null)', F(P.progress).value)
  ok(F(P.logs).value.length === 2, 'total<=0 / 脏数字不许把它画成 0/0 —— 只挡在写入口')
  // ② 重算一次要清空:上一轮的「为什么没做」留着,用户会以为这一轮也跳过了
  await P.makePlan()
  ok(FA(P.logs.value).length === 2, '清的是这一轮重算出来的那两条(重算后又填回两条)', FA(P.logs.value).length)
  P = T.useToolPage(toolOf({ schema: MOD.schema, plan: async () => [] }), pid)
  await P.open()
  P.picked.value = ['a.gd']
  P.rawParams.value.limit = 1
  await P.makePlan()
  ok(FA(P.logs.value).length === 0 && F(P.progress).value === null, '新的工具实例从头开始:没有残留的 log 与进度')

  // ③ log 条数上限(长清单里插件每条都 log 一句时不许无界涨)
  resetDisk()
  const SPAM = {
    schema: MOD.schema,
    plan: async (ctx) => {
      for (let i = 0; i < 200; i++) ctx.log('info', '第 ' + i + ' 条')
      return []
    }
  }
  P = T.useToolPage(toolOf(SPAM), pid)
  await P.open()
  P.picked.value = ['a.gd']
  P.rawParams.value.limit = 1
  await P.makePlan()
  ok(FA(P.logs.value).length <= 60, 'log 有上限(60 条)', FA(P.logs.value).length)
  ok(S(F(AT(P.logs.value, P.logs.value.length - 1)).msg).includes('199'),
    '留的是最近的那批,不是最早那批', S(F(AT(P.logs.value, P.logs.value.length - 1)).msg))
  ok(P.logsMore.value >= 57, '"还有 N 条更早的没显示" 要算得出(视图不做算术)', P.logsMore.value)

  // ④ 参数预览:话由插件的 count() 说,页面只搬;没有 / 抛异常 / 返回脏值都不能把表单弄坏
  const withCount = (fn) => ({ schema: MOD.schema, plan: async () => [], count: fn })
  P = T.useToolPage(toolOf(withCount((params, files) => `在 ${FA(files).length} 个文件名里命中 ${params.limit} 处`)), pid)
  await P.open()
  P.picked.value = ['a.gd']
  P.rawParams.value.limit = 1
  ok(S(P.paramHint.value).includes('命中 1 处'), 'count() 的句子原样上卡面', P.paramHint.value)
  ok(S(P.paramHint.value).includes('1 个文件名'), '传进去的 files 就是页面上勾中的那些(同一份真源)', P.paramHint.value)
  P = T.useToolPage(toolOf(withCount(() => { throw new Error('插件写坏了') })), pid)
  await P.open()
  P.picked.value = ['a.gd']
  ok(S(P.paramHint.value) === '', 'count() 抛异常 ⇒ 空串:一个工具的坏导出不能把整个表单弄白屏')
  P = T.useToolPage(toolOf({ schema: MOD.schema, plan: async () => [] }), pid)
  await P.open()
  ok(S(P.paramHint.value) === '', '没有 count 导出(第 1 批的工具都是这样)⇒ 空串,不画条')
  P = T.useToolPage(toolOf(withCount(() => 42)), pid)
  await P.open()
  ok(S(P.paramHint.value) === '', 'count() 返回非字符串 ⇒ 当没给,不把数字拼成一句话')

  // ⑤ 断链那句:整句话来自 orchestrate.danglingWarn,页面只搬数字之外的整句
  resetDisk()
  const REN = {
    schema: MOD.schema,
    plan: async () => [{ rel: 'a.gd', to: 'b.gd', kind: 'rename', label: '改名:a.gd → b.gd', risk: 'low', reason: '只改文件名', dangling: 4 }]
  }
  P = T.useToolPage(toolOf(REN), pid)
  await P.open()
  P.picked.value = ['a.gd']
  P.rawParams.value.limit = 1
  await P.makePlan()
  ok(S(P.dangling.value).includes('将有 4 处引用断链'), 'A-22 那句红字在场,数字是插件给的 4', P.dangling.value)
  ok(S(P.dangling.value).indexOf('加一行 X') < 0, '框架不复述插件的 label(那句里的数字与措辞都来自 danglingWarn)')
  const noRef = await P.execute()
  ok(noRef === undefined && FA(F(P.receipt.value).failed).length === 1, 'rename 走真执行通道了(第 1 批是直接被拒)')
  ok(S(F(AT(F(P.receipt.value).failed, 0)).error).includes('宿主没有改名原语'),
    '假宿主没给 renameProjectPath ⇒ 原样说清是缺原语,而不是悄悄成功', F(P.receipt.value).failed)
  ok(FA(F(P.receipt.value).renamed).length === 0, '没改成就不进 renamed(回执不替用户高兴)')
}

console.log(`\n${'='.repeat(56)}\nPASS ${pass}  FAIL ${failures.length}`)
if (failures.length) {
  console.log('失败项:')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log('全部通过')
