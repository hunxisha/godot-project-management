// 工具箱 · 第 1 批 Task 2:三段式调度(src/toolkit/orchestrate.ts)的断言。
//
// 这个模块决定「往用户的盘上写哪几个文件、删哪几个文件」,而它的错话没有回滚键 ——
// 与旧 gate.ts 同一句理由(宁可少报,不许说错)。旧 gate 的 67 条断言按 DEV-1 作废重写,
// 这里钉的就是那六条纪律在 ChangePlan 形状上的后继版本 + Q28 的越界兜底 + A-8 明写的四条
// (plan 返回空 / 非数组 / 抛异常;apply 单条失败不中断;越界强制 high 且 outOfScope)。
//
// ⚠ DEV-7 的两半都在这里:第 22 节的夹具**直接吃内置格式化工具的真实 plan() 产物**(旧 gate.test.mjs:9
//   「门不许另写措辞」的同一条意图换了生产者),证明 buildPlan 认得下真实 Change、
//   且框架那句风险话与插件的 label 各说各的、互不复述。
//
// 用法:node src/composables/__tests__/build-bundle.mjs && node src/toolkit/__tests__/orchestrate.test.mjs
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../../..')
const BUNDLE = path.resolve(ROOT, '.gpm-test/out/tkorchestrate.mjs')

if (!existsSync(BUNDLE)) {
  console.error(`找不到打包产物: ${BUNDLE}`)
  console.error('请先运行: node src/composables/__tests__/build-bundle.mjs')
  process.exit(2)
}

const T = await import(pathToFileURL(BUNDLE).href)

let pass = 0
const failures = []
function ok(cond, label, extra) {
  if (cond) { pass++; console.log(`  PASS  ${label}`) }
  else { failures.push(label); console.log(`  FAIL  ${label}${extra !== undefined ? '  → ' + extra : ''}`) }
}
function section(t) { console.log(`\n=== ${t} ===`) }

/**
 * 安全取值。变异态下少一个字段时,断言要**红一条**,而不是抛 TypeError 撞停整个套件——
 * 撞停的样子在终端上很像「抓到了」,其实一条 PASS/FAIL 统计都没产出,红数根本没法报。
 * (第 1 批 Task 1 与 Task 2 各撞一次:一次是 why() 返回 null,一次是 failed[0] 在变异态下不存在。)
 */
function F(x) {
  return (x && typeof x === 'object') ? x : {}
}
/** 同上,但用在数组上:变异让 ok() 变成 null 时,`.changes.length` 之类要报 false 而不是撞停 */
const FA = (x) => (Array.isArray(x) ? x : [])
/** 同上,但用在字符串上:变异让某个文案字段变成 undefined 时,`.includes(...)` 要报 false 而不是撞停 */
const S = (x) => (typeof x === 'string' ? x : '')
const N = (x) => (typeof x === 'number' ? x : -1)
/** 按位置取成员(变异让数组短一节时给空对象,断言红一条而不是撞停) */
const P = (arr, i) => F(FA(arr)[i])
function buildPlanSafe(opts) {
  // 关键:async 包装让**await 里的**异常也落进 catch(同步 try 接不到 promise rejection)
  return (async () => {
    try {
      return F(await T.buildPlan(opts))
    } catch (e) {
      return { toolId: opts.toolId, changes: [], planError: '框架调用 buildPlan 时抛异常:' + (e && e.message), rejected: [], selectedRels: [], treeKnown: false }
    }
  })()
}
/** 取字符串字段:变异态下缺字段时给空串,让断言红一条而不是抛 TypeError 撞停整个套件 */
const ERRS = (x) => (typeof x === 'string' ? x : '')
/** buildPlan 结果里的 planError(变异把它改成 null 返回时也读得出) */
const PERR = (r) => ERRS(F(r).planError)
/** 归一结果的安全读法:变异让 buildPlan 提前返回 null 时,断言红一条而不是把套件撞停 */
const L = (r) => N(FA(F(r).changes).length)
const RJ = (r) => N(FA(F(r).rejected).length)
const ONE = (r) => F(FA(F(r).changes)[0])
const REJ0 = (r) => F(FA(F(r).rejected)[0])
/**
 * 执行器结果的安全读法。`AR` 会把 promise 与「变异造成的同步返回 / 同步抛异常」都收成一个对象,
 * 所以注入方坏了时是断言红一条,而不是整个套件没有末行。
 */
const AR = (p) => (async () => {
  try {
    return F(await p)
  } catch (e) {
    return { __threw: String(e && e.message) }
  }
})()
const WR = (r) => N(FA(F(r).written).length)
const MR = (r) => N(FA(F(r).moved).length)
const FL = (r) => N(FA(F(r).failed).length)
const ERR0 = (r) => ERRS(F(FA(F(r).failed)[0]).error)
const JOIN0 = (r) => FA(F(r).written).join(',')

/** 一条合法的改写变更(每测现取现改)。PlannedChange 的三个框架字段给默认值,测 buildPlan 时被覆盖 */
const CH = (over) => ({
  rel: 'a.gd', kind: 'rewrite', label: '整理缩进', risk: 'low', reason: '只动排版',
  outOfScope: false, creates: false, defaultSelected: true, ...over
})
/** 直接造一份 ChangePlan(绕过 buildPlan 时用,只在测纯裁子集/分组那几节) */
const PLAN = (changes, over) => ({
  toolId: 'demo',
  changes,
  planError: '',
  rejected: [],
  selectedRels: ['a.gd'],
  treeKnown: true,
  ...over
})
const build = (rows, over) => buildPlanSafe({
  toolId: 'demo',
  plan: async () => rows,
  selectedRels: ['a.gd'],
  ...over
})

section('0. 导出面')
for (const n of ['buildPlan', 'subsetPlan', 'runGate', 'defaultSelectedIds', 'allIds', 'selectionCount',
  'selectionBytes', 'groupPreview', 'planSummary', 'executePlan', 'summaryText', 'rewriteWarn', 'warnText',
  'NO_SELECTION_REASON', 'EMPTY_PLAN_REASON', 'RENAME_UNSUPPORTED']) {
  ok(T[n] !== undefined, `${n} 已在打包产物里导出`)
}

section('1. plan() 的三种坏出口各有自己的话(A-8 前半)')
{
  const notFn = await buildPlanSafe({ toolId: 'demo', plan: undefined, selectedRels: [] })
  ok(PERR(notFn).includes('没有实现 plan'), 'plan 不是函数 ⇒ 原因点名「没实现 plan()」', PERR(notFn))
  ok(L(notFn) === 0 && RJ(notFn) === 0, '这种失败不产生任何条目')

  const boom = await build(undefined, { plan: async () => { throw new Error('引用图挂了') } })
  ok(PERR(boom).includes('plan() 抛异常') && PERR(boom).includes('引用图挂了'),
    'plan() 抛异常被接住,原因带上原文(视图层不该白屏)', PERR(boom))

  for (const [v, word] of [[null, 'null'], [42, 'number'], ['x', 'string'], [{}, 'object']]) {
    const r = await build(v)
    ok(PERR(r).includes('不是数组') && PERR(r).includes(word), `返回${word} ⇒ 原因说「不是数组」并带类型:${PERR(r)}`)
  }

  const empty = await build([])
  ok(PERR(empty) === '' && L(empty) === 0, '返回空数组**不是**失败:那是「这一轮没活干」', PERR(empty))
  ok(T.runGate(empty, []).reason === T.EMPTY_PLAN_REASON, '空清单被拒时说的是「没东西可做」而不是「工具坏了」', T.runGate(empty, []).reason)

  const wrapped = await build({ changes: [CH()] })
  ok(L(wrapped) === 1, '插件多包一层 {changes:[...]} 也认(拒载比兼容更糟)')
}

section('2. 逐条归一:认不出的一律丢,并说清丢了几条')
{
  const r = await build([null, 7, 'x', undefined])
  ok(L(r) === 0 && RJ(r) === 4, '四条非对象全丢,每条都进 rejected', r.rejected)
  ok(r.rejected[0].index === 0 && r.rejected[3].index === 3, 'rejected 记下原始下标(作者要找得到是哪一条)')
  ok(r.rejected.map((x) => x.why).every((w) => w.includes('第 ') && w.includes('条')), '每条原因都写成「第 N 条」的人话', r.rejected)
}

section('3. rel:对外唯一的键,越界一律丢')
{
  ok(L(await build([CH()])) === 1, '正常 rel 过')
  for (const rel of ['../a.gd', '/abs/a.gd', 'C:/x/a.gd', '']) {
    const r = await build([CH({ rel })])
    ok(L(r) === 0 && RJ(r) === 1, `rel「${rel}」被丢进 rejected(不许把它交给原语)`, REJ0(r).why)
  }
  ok(ONE(await build([CH({ rel: 'a.gd' })])).rel === 'a.gd', 'rel 原样保留(不做 trim 以外的加工)')
  ok(ONE(await build([CH({ rel: 'dir\\a.gd' })])).rel === 'dir/a.gd', '反斜杠归正斜杠:宿主给的 rel 恒是正斜杠,勾选与账本要用同一个键')
  const noLabel = await build([CH({ label: '  ' })])
  ok(L(noLabel) === 0 && String(REJ0(noLabel).why).includes('label'), '没有 label 丢条:预览那一行说不出要干什么就别摆上盘', REJ0(noLabel).why)
  const noReason = await build([CH({ reason: '' })])
  ok(L(noReason) === 0 && String(REJ0(noReason).why).includes('reason'), '没有 reason 丢条:风险档必须附理由(§5.4)', REJ0(noReason).why)
  const badKind = await build([CH({ kind: 'delete' })])
  ok(L(badKind) === 0 && String(REJ0(badKind).why).includes('kind'), '不认识的 kind 丢条,不猜成 trash', REJ0(badKind).why)
  const badRisk = await build([CH({ risk: 'medium' })])
  ok(L(badRisk) === 0 && String(REJ0(badRisk).why).includes('risk'), '不认识的 risk 丢条(而不是默认 low 放行)', REJ0(badRisk).why)
}

section('4. 越界兜底:插件说了不算(Q28 / A-8 末条)')
{
  const r = await build([CH({ rel: 'scenes/other.tscn', risk: 'low' })], { selectedRels: ['a.gd'] })
  const c = ONE(r)
  ok(c.outOfScope === true, 'rel 不在用户选中范围 ⇒ outOfScope=true')
  ok(c.risk === 'high', '越界一律升成 high —— 插件自报 low 不算数')
  ok(c.defaultSelected === false, '越界那条默认不勾(§1.5 第三条红线的框架化)')
  ok(c.reason === '只动排版', '越界只改风险档,不改插件说的话')

  const inScope = await build([CH({ rel: 'a.gd', risk: 'low' })], { selectedRels: ['a.gd'] })
  ok(ONE(inScope).outOfScope === false && ONE(inScope).defaultSelected === true, '范围内 + low ⇒ 默认勾选')
  const selfHigh = await build([CH({ rel: 'a.gd', risk: 'high' })], { selectedRels: ['a.gd'] })
  ok(ONE(selfHigh).risk === 'high' && ONE(selfHigh).defaultSelected === false, '插件自报 high ⇒ 默认不勾(框架不降级也不代签)')
  const bs = await build([CH({ rel: 'dir\\a.gd' })], { selectedRels: ['dir/a.gd'] })
  ok(ONE(bs).outOfScope === false, '选中集与 rel 的分隔符形态不同也算同一个文件(否则每一条都会被误判越界)')
  const none = await build([CH()], { selectedRels: [] })
  ok(ONE(none).outOfScope === true, '一个文件都没选中时,所有条都是越界')
}

section('5. rename 的形态闸(第 1 批只验形状,执行通道在第 2 批)')
{
  const good = await build([CH({ kind: 'rename', to: 'b.gd' })])
  ok(L(good) === 1 && ONE(good).to === 'b.gd', 'rename + to 过')
  const noTo = await build([CH({ kind: 'rename' })])
  ok(L(noTo) === 0 && REJ0(noTo).why.includes('to'), '缺 to ⇒ 丢条且原因点名 to 字段', noTo.rejected[0]?.why)
  const outTo = await build([CH({ kind: 'rename', to: '../b.gd' })])
  ok(L(outTo) === 0 && REJ0(outTo).why.includes('越界'), '新名越界 ⇒ 丢条', outTo.rejected[0]?.why)
  const sameTo = await build([CH({ kind: 'rename', to: 'a.gd' })])
  ok(L(sameTo) === 0 && REJ0(sameTo).why.includes('同一个名字'), '改前改后同名 ⇒ 丢条(那根本不是变更)', sameTo.rejected[0]?.why)
  const bsTo = await build([CH({ kind: 'rename', to: 'sub\\b.gd' })])
  ok(L(bsTo) === 1 && ONE(bsTo).to === 'sub/b.gd', '新名的反斜杠同样归一(与 rel 用同一个键比对)')
}

section('6. 同一个文件被改写两次:只留第一条')
{
  const r = await build([CH(), CH({ label: '再改一遍' })])
  ok(L(r) === 1, '两条同 rel 的改写只留一条(后一条会静默覆掉前一条)', r.changes)
  ok(RJ(r) === 1 && REJ0(r).why.includes('同一个文件'), '被丢的那条说清原因', r.rejected[0]?.why)
  const two = await build([CH(), CH({ rel: 'b.gd' })], { selectedRels: ['a.gd', 'b.gd'] })
  ok(L(two) === 2, '不同文件各算一条')
  const sameFileTrash = await build([CH({ kind: 'trash' }), CH({ kind: 'trash' })])
  ok(L(sameFileTrash) === 1 && REJ0(sameFileTrash).why.includes('重复'),
    '同 rel 同 kind 的 trash 会被自动 id 撞掉 —— 钉住「自动 id 的键就是 toolId:kind:rel」这件事', sameFileTrash.rejected[0]?.why)
  const trashTwo = await build([CH({ kind: 'trash', id: 't1' }), CH({ kind: 'trash', id: 't2' })])
  ok(L(trashTwo) === 2, '显式给不同 id 时同 rel 可以并存;真正的去重发生在交给原语的那一批(§17)')
  const dupId = await build([CH({ rel: 'a.gd', id: 'x' }), CH({ rel: 'b.gd', id: 'x' })], { selectedRels: ['a.gd', 'b.gd'] })
  ok(L(dupId) === 1 && REJ0(dupId).why.includes('重复'), '显式 id 撞车 ⇒ 后一条丢弃并说明', dupId.rejected[0]?.why)
}

section('7. id 是稳定键:不含时间戳、不含序号')
{
  const r1 = await build([CH()])
  const r2 = await build([CH()])
  ok(ONE(r1).id === ONE(r2).id, '同一份输入两次归一得到同一个 id(预览→勾选→执行要认得出同一条)', ONE(r1).id)
  ok(ONE(r1).id.includes('demo:'), 'id 前缀是 toolId(账本归属与存储前缀同一个键)', ONE(r1).id)
  ok(!/\d{10}/.test(ONE(r1).id), 'id 里没有时间戳形态的数字串')
}

section('8. 勾选集合的三道门(旧 gate 纪律 3/4/5)')
{
  const plan = PLAN([CH({ id: 'i1' }), CH({ id: 'i2', rel: 'b.gd' }), CH({ id: 'i3', rel: 'c.gd' })])
  ok(T.selectionCount(plan, ['i1', 'i2']) === 2, '勾选计数')
  ok(T.selectionCount(plan, ['i1', 'nope']) === 1, '父计划里没有的 id 一律忽略(门不许凭空造一条)')
  ok(T.selectionCount(plan, ['i1', 'i1']) === 1, '同一个 id 点两次只算一条')
  ok(T.selectionCount(plan, []) === 0 && T.selectionCount(plan, undefined) === 0 && T.selectionCount(plan, 'i1') === 0,
    '空/非数组入参都当「没勾」,不抛异常')

  ok(FA(T.subsetPlan(plan, ['i3', 'i1']).changes).map((c) => c.id).join(',') === 'i1,i3',
    '子集顺序按父计划,不按点选顺序(纪律 5:payload 要确定)', T.subsetPlan(plan, ['i3', 'i1']).changes)
  ok(N(FA(T.subsetPlan(plan, ['i1', 'i1']).changes).length) === 1, '子集里同一条只出现一次')
  ok(FA(T.subsetPlan(plan, ['ghost', 'i2']).changes).map((c) => c.id).join(',') === 'i2', '幽灵勾选不进子集')
  ok(N(FA(T.subsetPlan(plan, []).changes).length) === 0, '空勾选 ⇒ 空子集')
  const bad = PLAN([CH()], { planError: 'plan() 抛异常:炸了', rejected: [{ index: 0, why: 'x' }] })
  const badSub = T.subsetPlan(bad, [])
  ok(PERR(bad) === 'plan() 抛异常:炸了' && PERR(badSub) === PERR(bad) && RJ(badSub) === 1,
    '子集**不许**把父计划的坏消息洗白(措辞与判据同源)', PERR(badSub))
  ok(T.allIds(plan).join(',') === 'i1,i2,i3', '全选取全部条,一条不裁(纪律 2:裁掉的必须是「用户没选的」)')
  ok(T.defaultSelectedIds(plan).join(',') === 'i1,i2,i3', '默认勾选 = 三条 low 且不越界')
  // 配套:证明上一条不是「夹具全 true」造成的空对空 —— 这一层只读 defaultSelected 这一个字段,
  // 「谁该被置上 false」的判据在 §4(buildPlan)那一层钉,两层各管一段,别在这里重复判。
  const mixed = PLAN([CH({ id: 'j1' }), CH({ id: 'j2', rel: 'b.gd', defaultSelected: false }), CH({ id: 'j3', rel: 'c.gd', defaultSelected: false })])
  ok(T.defaultSelectedIds(mixed).join(',') === 'j1', 'defaultSelected=false 的两条不入选(按钮初值只认这一个字段)', T.defaultSelectedIds(mixed))
  ok(T.allIds(mixed).length === 3, '「全选」仍然给全部三条(默认不勾 ≠ 不许勾)')
}

section('9. selectionBytes:不知道体积就不臆造')
{
  const plan = PLAN([CH({ id: 'i1', bytes: 100 }), CH({ id: 'i2', rel: 'b.gd' }), CH({ id: 'i3', rel: 'c.gd', bytes: 0 })])
  const s = T.selectionBytes(plan, ['i1', 'i2', 'i3'])
  ok(s.bytes === 100, '只有给了 bytes 的条参与求和', s)
  ok(s.unknown === 1, '没给 bytes 的那条进 unknown 计数(预览要能说「体积未知」,不是说 0 B)')
  const z = T.selectionBytes(plan, ['i3'])
  ok(z.bytes === 0 && z.unknown === 0, '给了 0 就是 0,不是未知', z)
  const e = T.selectionBytes(plan, [])
  ok(e.bytes === 0 && e.unknown === 0, '空勾选不抛')
}

section('10. runGate:先坏先说,顺序不许换')
{
  const broken = PLAN([], { planError: 'plan() 抛异常:炸了' })
  ok(T.runGate(broken, ['i1']).reason === 'plan() 抛异常:炸了', 'plan 失败排在「没东西可做」之前(否则「工具坏了」会被说成「无事发生」)')
  const empty = PLAN([])
  ok(T.runGate(empty, []).reason === T.EMPTY_PLAN_REASON, '空清单 ⇒ EMPTY_PLAN_REASON')
  const has = PLAN([CH({ id: 'i1' })])
  const g = T.runGate(has, [])
  ok(g.ok === false && g.reason === T.NO_SELECTION_REASON, '一条没勾 ⇒ 带着原因被拒(纪律 3:不能静默什么都不做)')
  ok(T.NO_SELECTION_REASON.includes('拒绝执行'), '空选择那句话本身要说「已拒绝执行」,不能只是描述', T.NO_SELECTION_REASON)
  ok(T.runGate(has, ['ghost']).reason === T.NO_SELECTION_REASON, '勾了但不存在于清单 ⇒ 同样是空选择(按钮不能亮着却交出空子集)')
  ok(T.runGate(has, ['i1']).ok === true, '正常勾选放行')
  ok(T.runGate(has, 'i1').reason === T.NO_SELECTION_REASON, '非数组勾选入参当没勾,不抛')
}

section('11. 分组与摘要(Q28 的「单独分组」)')
{
  const plan = await build([CH(), CH({ rel: 'x.tscn', id: 'x' })], { selectedRels: ['a.gd'] })
  const g = T.groupPreview(plan)
  ok(FA(g).length === 2, '范围内 + 越界 ⇒ 两组', g)
  ok(F(g[0]).key === 'in' && FA(F(g[0]).changes).length === 1, '第一组是范围内(不把自己的东西挤到后面)', g)
  ok(F(g[1]).key === 'out' && F(FA(F(g[1]).changes)[0]).outOfScope === true, '第二组只有越界那条', g)
  ok(String(ERRS(F(g[1]).title)).includes('1 条') && String(F(g[1]).title).includes('逐条确认'), '越界组的标题带条数与「要单独确认」', F(g[1]).title)
  const only = await build([CH()])
  ok(N(FA(T.groupPreview(only)).length) === 1 && F(T.groupPreview(only)[0]).key === 'in', '没有越界就只有一组,不摆空组')
  const s = T.planSummary(plan)
  ok(String(s).includes('共 2 条') && String(s).includes('1 条在选中范围外'), '摘要把越界数说出来', s)
  const rej = await build([CH(), null])
  ok(String(T.planSummary(rej)).includes('1 条无法识别已丢弃'), '摘要把丢掉的条数说出来(少报了也要看得见)', T.planSummary(rej))
  ok(String(T.planSummary(PLAN([]))).includes('没有任何要动的东西'), '空清单的摘要就是那句拒绝原因')
  ok(T.planSummary(PLAN([], { planError: '炸了' })) === '炸了', 'planError 时摘要直接是它,不再拼数字')
}

section('12. 改写风险句:三档不能合一(备份与新建的区别必须说准)')
{
  const knownOne = { id: '1', rel: 'a.gd', kind: 'rewrite', label: 'l', risk: 'low', reason: 'r', outOfScope: false, creates: false, defaultSelected: true }
  const mixedBatch = [knownOne, { ...knownOne, id: '2', rel: 'ghost.gd', creates: true }]
  const w1 = T.rewriteWarn([knownOne])
  ok(w1.includes('gpm-bak') && w1.includes('原子替换'), '全是已存在的文件 ⇒ 承诺备份可还原', w1)
  ok(w1.includes('原名'), '备份名形态照原语说(以原扩展名之后收尾),不写成「<原名>.bak」那种不会出现的形态')
  const w3 = T.rewriteWarn(mixedBatch)
  ok(w3.includes('新建没有备份可还原') && w3.includes('gpm-bak'), '混着新建目标 ⇒ 两半都说,不许整体承诺备份', w3)
  const w4 = T.rewriteWarn(mixedBatch.map((c) => ({ ...c, creates: true })))
  ok(w4.includes('都不在本次文件清单里') && !w4.includes('gpm-bak'), '全是新建 ⇒ 一句备份都不许提', w4)
  const w5 = T.rewriteWarn([{ ...knownOne, kind: 'trash' }])
  ok(w5.includes('不涉及备份'), '整批没有改写目标 ⇒ 不空谈备份', w5)
  ok(T.warnText(mixedBatch) === T.rewriteWarn(mixedBatch), 'warnText 只负责「有没有 rewrite」这一层分派')
  ok(T.warnText([{ ...knownOne, kind: 'trash' }]) === '', '纯 trash 批不给风险句(风险在别处说)')
}

section('13. buildPlan 的 creates 判据:不知道文件在不在就按最坏说')
{
  ok(ONE(await build([CH()], { treeRels: ['a.gd'] })).creates === false, '在项目清单里 ⇒ creates=false(备份承诺站得住)')
  const fk = await build([CH()], { treeRels: ['a.gd'] })
  ok(F(fk).treeKnown === true, 'treeKnown 如实回报')
  ok(ONE(await build([CH({ rel: 'ghost.gd' })], { treeRels: ['a.gd'], selectedRels: ['ghost.gd'] })).creates === true, '不在清单里的改写 ⇒ creates=true(原语会新建,没有备份)')
  const unknown = await build([CH()])
  ok(F(unknown).treeKnown === false && ONE(unknown).creates === true, '没给项目清单 ⇒ 一律按可能新建判(措辞退到最保守档)')
  const t = await build([CH({ kind: 'trash', rel: 'ghost.gd' })], { treeRels: ['a.gd'], selectedRels: ['ghost.gd'] })
  ok(ONE(t).creates === false, 'creates 只描述改写通道:trash 不新建文件,别把它混进来')
}

section('14. executePlan:apply 单条失败不中断其余(A-8)')
{
  const writes = []
  const plan = PLAN([CH({ id: 'i1' }), CH({ id: 'i2', rel: 'b.gd' }), CH({ id: 'i3', rel: 'c.gd' })])
  const r = await AR(T.executePlan({
    plan,
    apply: async (c) => (c.id === 'i2' ? { ok: false, error: '读不到内容' } : { ok: true, text: 'X' + c.rel }),
    deps: {
      writeText: (rel, text) => { writes.push([rel, text]); return { ok: true, backupRel: rel + '.gpm-bak-1' } },
      trash: () => ({ ok: true, moved: 0 })
    },
    projectId: 'godot/project/p1',
    now: () => 1700000000000
  }))
  ok(writes.length === 2 && writes.every(([rel, text]) => text === 'X' + rel), '中间那条失败后,其余两条照样写', writes)
  ok(FL(r) === 1 && ERR0(r) === '读不到内容', '失败原因原样上浮到回执', r.failed)
  ok(JOIN0(r) === 'a.gd,c.gd', '成功集合只数真写成的')
  ok(F(r).ok === false, '有失败 ⇒ 整批不算成功')
  ok(N(FA(F(r).items).length) === 3 && F(FA(F(r).items)[1]).id === 'i2', 'items 保留完整逐条账目(顺序按父计划)', r.items)
  ok(N(FA(F(r).backups).length) === 2 && F(FA(F(r).backups)[0]).backupRel === 'a.gd.gpm-bak-1', '备份名逐条记账(回滚要靠它)', r.backups)
  ok(F(r).projectId === 'godot/project/p1' && F(r).at === 1700000000000, 'projectId / at 由注入给出(时间戳只进账本,不进 Change.id)')
  ok(F(r).cancelled === false, '没取消就不是取消')

  const boom = await AR(T.executePlan({
    plan: PLAN([CH({ id: 'i1' }), CH({ id: 'i2', rel: 'b.gd' })]),
    apply: async (c) => { if (c.id === 'i1') throw new Error('插件里炸了'); return { ok: true, text: 'y' } },
    deps: { writeText: () => ({ ok: true }), trash: () => ({ ok: true }) }
  }))
  ok(FL(boom) === 1 && ERR0(boom).includes('apply 抛异常'), 'apply 抛异常只砸那一条,并写明是异常', boom.failed)
  ok(WR(boom) === 1, '第二条仍执行完')
}

section('15. 没有内容就不写盘(旧 subsetPlan 最贵的那条教训)')
{
  const writes = []
  const r = await AR(T.executePlan({
    plan: PLAN([CH({ id: 'i1' })]),
    deps: { writeText: (rel, text) => { writes.push([rel, text]); return { ok: true } }, trash: () => ({ ok: true }) }
  }))
  ok(writes.length === 0, '没有 apply、payload 里也没正文 ⇒ 一次写入都不发起', writes)
  ok(ERR0(r).includes('不拿 undefined 覆写文件'), '原因把「为什么不写」说清', r.failed)
  ok(FL(r) === 1 && F(FA(F(r).failed)[0]).id === 'i1', '没写成的那一条进失败账目,而不是从账上消失', r.failed)

  const undef = await AR(T.executePlan({
    plan: PLAN([CH({ id: 'i1' })]),
    apply: async () => ({ ok: true }),
    deps: { writeText: () => ({ ok: true }), trash: () => ({ ok: true }) }
  }))
  ok(WR(undef) === 0 && FL(undef) === 1, 'apply 说成功但没给 text ⇒ 仍然不写(否则文件被覆成空)', undef)

  const payload = await AR(T.executePlan({
    plan: PLAN([CH({ id: 'i1', payload: { text: 'from payload' } })]),
    deps: { writeText: (rel, text) => ({ ok: text === 'from payload' }), trash: () => ({ ok: true }) }
  }))
  ok(WR(payload) === 1, '正文放 payload.text 也算数(插件可以不实现 apply)', payload)

  const badText = await AR(T.executePlan({
    plan: PLAN([CH({ id: 'i1', payload: { text: 42 } })]),
    deps: { writeText: () => ({ ok: true }), trash: () => ({ ok: true }) }
  }))
  ok(WR(badText) === 0, 'payload.text 不是字符串 ⇒ 当没内容,不把 42 覆进 .gd', badText)

  const emptyText = await AR(T.executePlan({
    plan: PLAN([CH({ id: 'i1' })]),
    apply: async () => ({ ok: true, text: '' }),
    deps: { writeText: () => ({ ok: true }), trash: () => ({ ok: true }) }
  }))
  ok(WR(emptyText) === 1, 'apply 给出空串 ⇒ 真的写空串(那是插件声明的结果,框架不改口)', emptyText)

  const errNoMsg = await AR(T.executePlan({
    plan: PLAN([CH({ id: 'i1' })]),
    apply: async () => ({ ok: false }),
    deps: { writeText: () => ({ ok: true }), trash: () => ({ ok: true }) }
  }))
  ok(ERR0(errNoMsg).length > 0 && ERR0(errNoMsg).includes('没给原因'), 'ok:false 又不给原因 ⇒ 兜底原因顶上,回执不许是空白', errNoMsg.failed)
}

section('16. 写盘原语自己失败:如实落账,不重试不吞')
{
  const r = await AR(T.executePlan({
    plan: PLAN([CH({ id: 'i1' }), CH({ id: 'i2', rel: 'b.gd' })]),
    apply: async (c) => ({ ok: true, text: 'new-' + c.rel }),
    deps: {
      writeText: (rel) => (rel === 'a.gd' ? { ok: false, error: '备份失败' } : { ok: true, backupRel: 'b' }),
      trash: () => ({ ok: true })
    }
  }))
  ok(FL(r) === 1 && ERR0(r) === '备份失败', '原语的错话原样进回执', r.failed)
  ok(JOIN0(r) === 'b.gd', '另一条不受影响')
  ok(FA(F(r).backups).map((b) => b.rel).join(',') === 'b.gd', '失败那条没有备份,不臆造', r.backups)

  const boom = await AR(T.executePlan({
    plan: PLAN([CH({ id: 'i1' })]),
    apply: async () => ({ ok: true, text: 'x' }),
    deps: { writeText: () => { throw new Error('EPERM') }, trash: () => ({ ok: true }) }
  }))
  ok(ERR0(boom).includes('写入抛异常'), '原语抛异常也被接住成一条失败,不冒到视图层', boom.failed)

  // 宿主原语的另一种「ok 但没写」:超限额 / 二进制都回 ok:true,而盘上一个字节没动
  // (inspectfs.js:122 的 truncated 与 :125 的 skippedBinary)。只判 ok 就会把没写成的报成成年人。
  const trunc = await AR(T.executePlan({
    plan: PLAN([CH({ id: 'i1' })]),
    apply: async () => ({ ok: true, text: 'x' }),
    deps: { writeText: () => ({ ok: true, truncated: true }), trash: () => ({ ok: true }) }
  }))
  ok(WR(trunc) === 0 && ERR0(trunc).includes('限额'), 'ok:true 但 truncated ⇒ 不算写成,回执要说清没写', trunc.failed)
  const bin = await AR(T.executePlan({
    plan: PLAN([CH({ id: 'i1' })]),
    apply: async () => ({ ok: true, text: 'x' }),
    deps: { writeText: () => ({ ok: true, skippedBinary: true }), trash: () => ({ ok: true }) }
  }))
  ok(WR(bin) === 0 && N(FA(F(bin).backups).length) === 0, 'ok:true 但 skippedBinary ⇒ 没写也没备份,不许进成功集合', bin)
}

section('17. trash 批量:一次调用,逐条落账')
{
  let calls = []
  const plan = PLAN([
    CH({ id: 't1', kind: 'trash', rel: 'x.gd' }),
    CH({ id: 't2', kind: 'trash', rel: 'y.gd' }),
    CH({ id: 't3', kind: 'trash', rel: 'y.gd' }),
    CH({ id: 'r1', rel: 'a.gd' })
  ], { selectedRels: ['x.gd', 'y.gd', 'a.gd'] })
  const r = await AR(T.executePlan({
    plan,
    apply: async () => ({ ok: true, text: 'kept' }),
    deps: {
      writeText: () => ({ ok: true }),
      trash: (rels) => { calls = rels; return { ok: false, failed: [{ rel: 'x.gd', error: '移入回收站失败' }] } }
    }
  }))
  ok(calls.length === 2 && calls[0] === 'x.gd' && calls[1] === 'y.gd', '同 rel 只交给原语一次,顺序按父计划', calls)
  ok(FA(F(r).moved).join(',') === 'y.gd,y.gd', '两条同 rel 都按盘上实况计成 moved(t3 不是被凭空造出来的记录)', r.moved)
  ok(FA(F(r).failed).some((f) => f.id === 't1' && f.error === '移入回收站失败'), '原语报的那条失败按 id 落账', r.failed)
  ok(JOIN0(r) === 'a.gd', '改写通道不受 trash 结果影响')

  // 配套:证明上一条不是「实现压根没数 trash」造成的假绿 —— 全批失败时 moved 必须变空
  const noneMoved = await AR(T.executePlan({
    plan: PLAN([CH({ id: 't2', kind: 'trash', rel: 'y.gd' }), CH({ id: 't3', kind: 'trash', rel: 'y.gd' })]),
    deps: { writeText: () => ({ ok: true }), trash: () => ({ ok: false, failed: [{ rel: 'y.gd', error: '移入回收站失败' }] }) }
  }))
  ok(MR(noneMoved) === 0 && FL(noneMoved) === 2, '同 rel 两条全失败 ⇒ moved 为空(与上一条构成对照)', noneMoved.moved)

  const allfail = await AR(T.executePlan({
    plan: PLAN([CH({ id: 't1', kind: 'trash', rel: 'x.gd' })]),
    deps: { writeText: () => ({ ok: true }), trash: () => ({ ok: false, error: '项目不存在' }) }
  }))
  ok(ERR0(allfail) === '项目不存在', '整批失败时把顶层原因分给每一条', allfail.failed)

  const throwTrash = await AR(T.executePlan({
    plan: PLAN([CH({ id: 't1', kind: 'trash', rel: 'x.gd' })]),
    deps: { writeText: () => ({ ok: true }), trash: () => { throw new Error('EACCES') } }
  }))
  ok(ERR0(throwTrash).includes('回收站调用抛异常'), 'trash 抛异常同样收口成失败项', throwTrash.failed)
}

section('18. rename 在第 1 批拒绝执行:不假装能做,也不先跑副作用')
{
  let applied = 0
  const r = await AR(T.executePlan({
    plan: PLAN([CH({ id: 'n1', kind: 'rename', rel: 'a.gd', to: 'b.gd' })]),
    apply: async () => { applied++; return { ok: true, text: 'x' } },
    deps: { writeText: () => ({ ok: true }), trash: () => ({ ok: true }) }
  }))
  ok(ERR0(r) === T.RENAME_UNSUPPORTED, '原因说清「第 2 批接入」,而不是含糊的失败', r.failed)
  ok(applied === 0, '既然不写盘,就不该先跑插件的副作用')
  ok(WR(r) === 0 && MR(r) === 0, '一条盘都没动')
}

section('19. 取消语义:剩余条目标「已取消」')
{
  let n = 0
  const r = await AR(T.executePlan({
    plan: PLAN([CH({ id: 'i1' }), CH({ id: 'i2', rel: 'b.gd' }), CH({ id: 'i3', rel: 'c.gd' })]),
    apply: async () => { n++; return { ok: true, text: 't' } },
    deps: { writeText: () => ({ ok: true }), trash: () => ({ ok: true }) },
    isCancelled: () => n >= 1
  }))
  ok(F(r).cancelled === true, '回执标出这是被取消的一轮')
  ok(WR(r) === 1, '第一条已经做完,不假装回滚')
  ok(FA(F(r).failed).filter((f) => f.error === '已取消').length === 2, '剩余两条各带「已取消」进账本', r.failed)
  ok(N(FA(F(r).items).length) === 3, 'items 仍是完整清单(三条都在账上,不凭空少)', r.items)
}

section('20. summaryText:回执那句话与 items 同源')
{
  const allDone = { written: ['a', 'b'], moved: [], failed: [], cancelled: false, ok: true }
  ok(T.summaryText(allDone).includes('改写 2 个文件'), '改写计数', T.summaryText(allDone))
  const part = T.summaryText({ written: ['a'], moved: ['z'], failed: [{ rel: 'b' }], cancelled: false })
  ok(part.startsWith('部分完成:') && part.includes('移入回收站 1 个') && part.includes('失败 1 条'), '部分完成 ⇒ 三种计数都说', part)
  const cancelled = T.summaryText({ written: [], moved: [], failed: [{ rel: 'b' }], cancelled: true })
  ok(cancelled.includes('已取消'), '取消字样排在最前', cancelled)
  ok(T.summaryText({ written: [], moved: [], failed: [] }).includes('什么都没做成'), '全空不返回空串')
}

section('21. 纯函数红线与契约面')
{
  ok(typeof globalThis.window === 'undefined', 'Node harness 里确实没有 window(判据没偷偷依赖它)')
  const p = await build([CH()])
  ok(Object.keys(p).sort().join(',') === 'changes,planError,rejected,selectedRels,toolId,treeKnown', 'ChangePlan 的字段面就是合同,不多不少', Object.keys(p))
  // §5.1 已写明契约边界不是安全边界:这里钉的是「plan 里碰 globalThis 会被接住而不是冒出来」,
  // 而不是假装框架挡得住 —— 挡不住才是要写在 UI 上的那句话(A-12)。
  const usesGlobal = await buildPlanSafe({
    toolId: 'demo',
    plan: () => { globalThis.__gpm_probe = 1; return [CH()] },
    selectedRels: ['a.gd']
  })
  ok(L(usesGlobal) === 1, 'plan 里写 globalThis 也照样跑完(不抛、不白屏)', PERR(usesGlobal))
  ok(globalThis.__gpm_probe === 1, '插件确实改到了全局:所以「这不是安全边界」必须写在 UI 上(A-12)')
  delete globalThis.__gpm_probe
}

section('22. DEV-7 兑现:夹具吃内置格式化工具的真实 plan() 产物(门与生产者同源)')
{
  // 跨 bundle 取第 11 个任务落地的内置工具与框架自己的组装层。
  // 这里不是「假加载器」(Q33 禁的那个):执行的就是真实 entry 模块,ctx 也是 buildGpm 造的真的 ctx,
  // 只有底层 services 是假的 —— 与 gpm.test.mjs 同一档做法。
  const FM = await import(pathToFileURL(path.resolve(ROOT, '.gpm-test/out/tkform.mjs')).href)
  const GM = await import(pathToFileURL(path.resolve(ROOT, '.gpm-test/out/tkgpm.mjs')).href)
  const SM = await import(pathToFileURL(path.resolve(ROOT, '.gpm-test/out/tkschema.mjs')).href)
  const SRC = 'extends Node   \n\tvar a = 1  \n'
  const mkCtx = () => GM.buildGpm({
    services: { readProjectText: async () => ({ ok: true, text: SRC, bytes: SRC.length, truncated: false, skippedBinary: false }) },
    toolId: 'gdscript-format', toolName: 'GDScript 代码格式化', projectId: 'p1',
    capabilities: ['tree', 'text', 'write'], unsafe: false
  })
  const params = F(SM.defaultsOf(FA(F(SM.validateSchema(FM.schema)).fields)))
  const real = FA(await FM.plan(mkCtx(), [{ rel: 'a.gd', size: 1 }, { rel: 'b.gd', size: 1 }], params))
  ok(real.length === 2, '真实 plan() 交出两条(下面每一个断言吃的都是这份产物,不是手搓夹具)', String(real.length))
  ok(FA(real).every((c) => !c || typeof F(c).id !== 'string'), '插件没给 id ⇒ 稳定键完全由框架补(两边不许各补一套)')

  // buildPlan 吃的是**插件的 plan 函数**(框架自己调它),不是数组:
  // 手搓 Change[] 会让「门与生产者同源」这件事重新变成口头承诺(DEV-7②)。
  const FILES = [{ rel: 'a.gd', size: 1 }, { rel: 'b.gd', size: 1 }]
  const ARGS = (over) => ({
    toolId: 'gdscript-format', plan: FM.plan, ctx: mkCtx(), files: FILES, params,
    selectedRels: ['a.gd', 'b.gd'], treeRels: ['a.gd', 'b.gd', 'c.gd'], ...(over || {})
  })
  const plan = await T.buildPlan(ARGS())
  const built = FA(plan.changes)
  ok(S(F(plan).planError) === '', '框架接得住真实产物(不报「plan() 没实现/返回不对」)', S(F(plan).planError))
  ok(F(plan).rejected.length === 0, '一条都没被丢', JSON.stringify(F(plan).rejected))
  ok(built.length === 2, '两条都归一成功', String(built.length))
  ok(P(built, 0).id === 'gdscript-format:rewrite:a.gd', '补出来的稳定键 = toolId:kind:rel', S(P(built, 0).id))
  ok(P(built, 0).risk === 'low' && P(built, 0).outOfScope === false && P(built, 0).defaultSelected === true,
    '项目内 + 插件自报 low ⇒ 默认勾上(Q28 只兜越界,不降插件的档)')
  ok(P(built, 0).creates === false, 'treeRels 里有它 ⇒ creates false,措辞走「有备份」那一档')
  const again = await T.buildPlan(ARGS())
  ok(JSON.stringify(FA(again.changes).map((c) => F(c).id)) === JSON.stringify(built.map((c) => F(c).id)),
    '同一份真实产物两次生成的 id 一字不差(预览→勾选→执行之间认得出「还是那一条」)')

  // 措辞同源的两半:框架那句风险话不含插件 label;预览那一行就是插件原句
  const warn = S(T.warnText(built))
  ok(warn.includes('gpm-bak') && warn.includes('可随时还原'), '备份那句说的是真的退路(creates 全 false 这一档)', warn)
  ok(!warn.includes('文本卫生'), '框架不复述插件的 label,也就不可能把它说成别的东西(DEV-7①)', warn)
  ok(S(P(built, 0).label) === S(F(real[0]).label), '预览那一行原样是插件给的那句', S(P(built, 0).label))
  ok(S(P(built, 0).reason) === S(F(real[0]).reason), '悬停那句也是原样,框架没另写判断', S(P(built, 0).reason).slice(0, 40))

  // 同一份产物,换一种「框架知不知道清单」⇒ 风险话必须换成另一句实话
  const noTree = await T.buildPlan(ARGS({ treeRels: undefined }))
  ok(FA(noTree.changes).every((c) => F(c).creates === true), '没给 treeRels ⇒ creates 一律按 true 判(宁可少承诺)', JSON.stringify(FA(noTree.changes).map((c) => F(c).creates)))
  const warn2 = S(T.warnText(FA(noTree.changes)))
  ok(warn2.includes('新建没有备份可还原') && !warn2.includes('可随时还原'), '这一档绝不许说「可随时还原」(旧三档措辞的意义)', warn2)

  // 越界兜底:插件说的是 low,框架只看用户勾了哪些
  const out = await T.buildPlan(ARGS({ selectedRels: [] }))
  ok(FA(out.changes).every((c) => F(c).risk === 'high' && F(c).outOfScope === true && F(c).defaultSelected === false),
    '选中集为空 ⇒ 全部越界:强制 high + 不默认勾(Q28)', JSON.stringify(FA(out.changes).map((c) => [F(c).risk, F(c).outOfScope, F(c).defaultSelected])))
  ok(S(T.planSummary(out)) === '共 2 条(默认勾选 0 条);2 条在选中范围外', '摘要那句把越界数说出口', S(T.planSummary(out)))
  ok(S(T.planSummary(plan)) === '共 2 条(默认勾选 2 条)', '范围内的正常摘要不带越界那段', S(T.planSummary(plan)))
  const groups = FA(T.groupPreview(out))
  ok(groups.length === 1 && F(groups[0]).key === 'out', '全越界时只剩那一组(空组不出现)', JSON.stringify(groups.map((g) => F(g).key)))
  ok(S(F(groups[0]).title).includes('框架强制逐条确认'), '越界那组的标题说清框架在做什么', S(F(groups[0]).title))

  // 「选了 0 条时怎么说」—— 旧 gate 的那条纪律在 ChangePlan 上的后继版本
  const gate = F(T.runGate(plan, []))
  ok(gate.ok === false && S(gate.reason) === S(T.NO_SELECTION_REASON), '一条都没勾 ⇒ 门拒,并给出那句话', S(gate.reason))
  ok(S(T.NO_SELECTION_REASON).length > 0 && !S(T.NO_SELECTION_REASON).includes('null'), '那句话不是空串也不是怪话', S(T.NO_SELECTION_REASON))
  const gate2 = F(T.runGate(out, []))
  ok(gate2.ok === false, '全越界且没勾 ⇒ 同样拒', S(gate2.reason))
  ok(F(T.runGate(plan, T.allIds(plan))).ok === true, '全勾上就放行', S(F(T.runGate(plan, T.allIds(plan))).reason))

  // 真产物一路走到执行:两条都写、都拿到备份
  const r = await T.executePlan({
    plan,
    deps: {
      writeText: (rel) => ({ ok: true, backupRel: `${rel}.gpm-bak-1` }),
      trash: () => ({ ok: true })
    },
    projectId: 'p1'
  })
  ok(F(r).written.join(',') === 'a.gd,b.gd', '真实 payload.text 被框架认成正文并写了两个文件', JSON.stringify(F(r).written))
  ok(FA(F(r).backups).length === 2, '两个备份名进了回执(账本就靠这一组对应关系)', FA(F(r).backups).length)
  ok(F(r).failed.length === 0 && F(r).ok === true, '零失败', JSON.stringify(F(r).failed))
  ok(S(T.summaryText(r)) === '完成:改写 2 个文件', '回执那句话与真实条数同源', S(T.summaryText(r)))
}

console.log(`\n${'='.repeat(56)}\nPASS ${pass}  FAIL ${failures.length}`)
if (failures.length) {
  console.log('失败项:')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log('全部通过')
