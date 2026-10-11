// 工具箱 · 第 1 批 Task 7:加载器纯函数层(src/toolkit/loader.ts)的断言。
//
// ⚠ 这一份**不碰磁盘、不碰 new Function**,这是刻意的(Q33:加载器与执行路径只能真机验,
// 不许用 Node 里的假加载器冒充)。这里测的是「拿到 manifest 原文与执行结果之后,怎么归类它们」:
// 单个插件坏掉不许带走整页、内置与用户插件同一条注册路径(Q23=A)、id 撞车必须看得见。
// 真机那一段(读盘 + blob import + 全链跑通)进 A-10 / A-19,不在这里假装验过。
//
// 用法:node src/composables/__tests__/build-bundle.mjs && node src/toolkit/__tests__/loader.test.mjs
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../../..')
const BUNDLE = path.resolve(ROOT, '.gpm-test/out/tkloader.mjs')

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
  else { failures.push(label); console.log(`  FAIL  ${label}${extra !== undefined ? '  → ' + JSON.stringify(extra) : ''}`) }
}
function section(t) { console.log(`\n=== ${t} ===`) }
const F = (x) => (x && typeof x === 'object' ? x : {})
const FA = (x) => (Array.isArray(x) ? x : [])
const S = (x) => (typeof x === 'string' ? x : '')
const N = (x) => (typeof x === 'number' ? x : -1)
/** 从注册结果里取 id:拒载条目没有 manifest,回落到目录名(列表那一行也是这么显示的) */
const ID = (t) => { const m = F(t).manifest; return m && typeof m.id === 'string' ? m.id : S(F(t).dirName) || 'bad' }
/** 一组注册结果的 id 序列(断言里反复要用,别每处手写 .manifest.id 把 null 踩穿) */
const IDS = (list) => FA(list).map(ID).join(',')

/** 一份最小合法 manifest(与 manifest.ts 的 GOOD 同形) */
const MAN = (over) => ({
  id: 'demo', name: '演示工具', version: '1.0.0', apiVersion: 1, kind: 'action', ui: 'schema',
  summary: '一句话', cmds: ['演示'], entry: 'index.js', capabilities: ['tree', 'text'], ...over
})
/** action + schema 的合法模块 */
const MOD = { schema: [], plan: async () => [], apply: async () => ({ ok: true }) }
const VIEW_MOD = { view: () => null }
const reg = (man, mod, opts) => T.registerTool(man, mod, { source: 'user', dirName: 'demo', granted: ['tree', 'text', 'ref', 'write', 'store', 'ui'], ...(opts || {}) })

section('0. 导出面')
for (const n of ['checkModuleShape', 'registerTool', 'buildRegistry', 'conflictText', 'sortTools', 'filterTools', 'allTags']) {
  ok(T[n] !== undefined, `${n} 已在打包产物里导出`)
}

section('1. registerTool:四态各自说人话')
{
  const good = reg(MAN(), MOD)
  ok(good.state === 'ok' && good.reason === '', '一切正常 ⇒ ok 且没有原因', good.reason)
  ok(good.manifest && good.manifest.id === 'demo', 'manifest 归一后带在结果上(渲染层不必再校验一遍)')
  ok(good.module === MOD, '模块对象原样交出去(框架不复制插件的函数)')

  const badM = reg(MAN({ id: 'DEMO' }), MOD)
  ok(badM.state === 'bad-manifest', 'manifest 坏 ⇒ bad-manifest', badM.state)
  ok(S(badM.reason).startsWith('manifest 不合格:'), '原因带前缀,一眼分清是 manifest 的锅', badM.reason)
  ok(S(badM.reason).includes('id'), '原因里保留 manifest.ts 的原话内容', badM.reason)
  ok(badM.manifest === null && badM.module === null, '拒载时不把 module 交出去(免得 UI 拿着一个坏插件的函数去跑)')

  const api = reg(MAN({ apiVersion: 2 }), MOD)
  ok(api.state === 'bad-manifest' && S(api.reason).includes('apiVersion'), 'apiVersion 不匹配走的也是 bad-manifest(同一条拒载路径)', api.reason)
  ok(S(api.reason).includes('不做兼容适配'), '拒载原因原样上浮到列表那一行(A-7 的「原因写进那一行」)', api.reason)
}

section('2. checkModuleShape:kind / ui 决定必须导出什么')
{
  ok(T.checkModuleShape(MAN(), MOD).ok === true, 'action + schema + plan/apply 过')
  const noPlan = T.checkModuleShape(MAN(), { schema: [] })
  ok(noPlan.ok === false && S(noPlan.reason).includes('plan'), 'action 缺 plan ⇒ 拒并点名', noPlan.reason)
  ok(S(noPlan.reason).includes('三段式'), '原因要说清为什么非要 plan(它是三段式第一拍)', noPlan.reason)
  const noSchema = T.checkModuleShape(MAN({ ui: 'schema' }), { plan: async () => [] })
  ok(noSchema.ok === false && S(noSchema.reason).includes('schema'), 'ui:schema 缺 schema ⇒ 拒', noSchema.reason)
  ok(T.checkModuleShape(MAN({ ui: 'render' }), { plan: async () => [] }).ok === true, 'ui:render 的 action 不强制 schema 数组')
  const viewBad = T.checkModuleShape(MAN({ kind: 'view', ui: 'render' }), { plan: async () => [] })
  ok(viewBad.ok === false && S(viewBad.reason).includes('view'), 'view 型没导出 view() ⇒ 拒', viewBad.reason)
  ok(T.checkModuleShape(MAN({ kind: 'view', ui: 'render' }), VIEW_MOD).ok === true, 'view + view() 过')
  for (const junk of [null, undefined, 'x', 42, []]) {
    const r = T.checkModuleShape(MAN(), junk)
    ok(r.ok === false && r.reason.length > 0, `entry 结果是 ${JSON.stringify(junk) ?? 'undefined'} ⇒ 拒且有原因`, r)
  }
  ok(T.checkModuleShape(MAN({ kind: 'tool' }), MOD).ok === false, 'kind 不认识时拒(不默认按 action 跑)')
}

section('3. 单个坏插件不许带走整页(错误隔离到它自己)')
{
  const list = [
    reg(MAN({ id: 'a', name: 'A' }), MOD, { dirName: 'a' }),
    reg(MAN({ id: 'b', name: 'B' }), { schema: '不是数组' }, { dirName: 'b' }),
    reg(MAN({ id: 'c', name: 'C' }), MOD, { dirName: 'c' })
  ]
  ok(list[0].state === 'ok' && list[1].state === 'bad-module' && list[2].state === 'ok',
    '中间那个坏了,两边照样 ok(用户刚丢一个 .js 进去就整页打不开,是最劝退的失败形态)')
  ok(list[1].manifest !== null && list[1].manifest.id === 'b', '坏的那个仍然带 manifest(列表要显示它是谁、为什么不能用)')
  const registry = T.buildRegistry(list)
  ok(FA(registry.tools).length === 3, '注册表不丢条目(拒载的也要出现在列表里)', registry.tools && registry.tools.length)
  ok(F(registry.byId.a) === list[0] && F(registry.byId.b) === list[1], 'byId 覆盖好与坏的(点进去看原因要用)')
}

section('4. 能力门:no-capability 与 bad-* 是两种话')
{
  const miss = reg(MAN({ capabilities: ['tree', 'ref', 'store'] }), MOD, { granted: ['tree'] })
  ok(miss.state === 'no-capability', '给不起能力 ⇒ no-capability(不是「作者写错了」)', miss.state)
  ok(miss.missing.join(',') === 'ref,store', '缺哪些按声明顺序列出', miss.missing)
  ok(S(miss.reason).includes('ref') && S(miss.reason).includes('store'), '原因里点名', miss.reason)
  ok(miss.module === MOD, '缺能力时模块仍然在(用户改了宿主能力后不必重新装插件)')
  const noneGranted = reg(MAN({ capabilities: [] }), MOD, { granted: [] })
  ok(noneGranted.state === 'ok', '不声明能力 ⇒ ok(纯 UI 型工具合法)')
  const junkGranted = reg(MAN(), MOD, { granted: undefined })
  ok(junkGranted.state === 'no-capability', 'granted 没给 ⇒ 当成「什么都没给」(方向是拒,不是放行)', junkGranted.state)
}

section('5. id 撞车:保留先注册的,后装的标出来')
{
  const a = reg(MAN({ id: 'same', name: '甲' }), MOD, { dirName: 'dirA' })
  const b = reg(MAN({ id: 'same', name: '乙' }), MOD, { dirName: 'dirB' })
  const c = reg(MAN({ id: 'other', name: '丙' }), MOD, { dirName: 'dirC' })
  const r = T.buildRegistry([a, b, c])
  ok(FA(r.conflicts).length === 1 && r.conflicts[0].id === 'same', '只报一组冲突', r.conflicts)
  ok(r.conflicts[0].names.join(',') === 'dirA,dirB', '冲突组里带目录名(用户找得到是哪个文件夹)', r.conflicts[0].names)
  ok(r.byId.same === a, 'byId 保留先注册的那个(不做「自动改名」:那会让 store 前缀跟着搬)')
  ok(a.idConflictWith.join(',') === 'dirB' && b.idConflictWith.join(',') === 'dirA', '两边都标出对手', [a.idConflictWith, b.idConflictWith])
  ok(c.idConflictWith.length === 0, '不相干的工具不被牵连')
  const txt = S(T.conflictText(b))
  ok(txt.includes('same') && txt.includes('dirA') && txt.includes('存储前缀'), '撞车那句话点名 id、对手与后果', txt)
  const noConflict = T.buildRegistry([reg(MAN({ id: 'x1' }), MOD), reg(MAN({ id: 'x2' }), MOD)])
  ok(FA(noConflict.conflicts).length === 0 && xid(noConflict.byId) === 2, '没有撞车时 conflicts 为空数组', noConflict.conflicts)
  function xid(byId) { return Object.keys(F(byId)).length }
}

section('6. 拒载条目没有 manifest:索引与话术都不能崩')
{
  const junk = [reg(null, MOD), reg(undefined, MOD), reg('x', MOD), reg(MAN(), MOD)]
  const r = T.buildRegistry(junk)
  ok(FA(r.tools).length === 4, '四条全在列表里(拒载的也要看得见)', r.tools.length)
  ok(Object.keys(F(r.byId)).length === 1, '只有那条合法的进 byId', Object.keys(r.byId))
  ok(FA(r.conflicts).length === 0, '拒载条目不参与 id 撞车判定(它们根本没有 id)')
  ok(S(T.conflictText(junk[0])).includes('另一个插件'), '没有 manifest 时话术也不给 undefined', T.conflictText(junk[0]))
}

section('7. sortTools:内置在前 + 稳定序')
{
  const u1 = reg(MAN({ id: 'zz', name: '阿哲' }), MOD, { dirName: 'zz' })
  const u2 = reg(MAN({ id: 'aa', name: '保' }), MOD, { dirName: 'aa' })
  const b1 = T.registerTool(MAN({ id: 'bb', name: '格式化' }), MOD, { source: 'builtin', granted: ['tree', 'text'] })
  const out = T.sortTools([u1, b1, u2]).map((t) => F(F(t).manifest).name)
  ok(out[0] === '格式化', '内置工具排第一(与用户插件同列但来源不同,Q23=A)', out)
  ok(out.slice(1).join(',') === '阿哲,保', '用户部分按中文名字序(目录名字面序会是 aa,zz ⇒ 保,阿哲,两者能分清)', out.slice(1))
  ok(T.sortTools([]).length === 0 && T.sortTools(null).length === 0, '空/脏入参给空数组不抛')
  const same = [reg(MAN({ id: 'k1', name: '同名' }), MOD, { dirName: 'd1' }), reg(MAN({ id: 'k2', name: '同名' }), MOD, { dirName: 'd2' })]
  ok(IDS(T.sortTools(same)) === 'k1,k2', '同名字时按 id 稳定收尾(否则每次扫完列表会重排)', IDS(T.sortTools(same)))
}

section('8. filterTools:搜索命中五个面,坏条目永不被筛掉')
{
  const tools = [
    reg(MAN({ id: 'fmt', name: 'GDScript 代码格式化', summary: '清一清', tags: ['gdscript'], cmds: ['格式化', 'gdformat'] }), MOD, { dirName: 'fmt' }),
    reg(MAN({ id: 'ren', name: '批量重命名', tags: ['gdscript', 'refactor'] }), VIEW_MOD, { dirName: 'ren', granted: ['tree', 'text', 'ref', 'write', 'store', 'ui'] }),
    reg(MAN({ id: 'view1', name: '画布', kind: 'view', ui: 'render', tags: ['shader'] }), { view: () => null }, { dirName: 'view1' }),
    reg({ id: 'BAD', name: '坏' }, MOD, { dirName: 'bad' })
  ]
  ok(T.filterTools(tools, {}).length === 4, '不筛时全给(含拒载那条:列表要显示它并说明原因)')
  const q = (s) => T.filterTools(tools, { query: s }).map((t) => t.manifest ? t.manifest.id : 'bad').join(',')
  ok(q('gdsc') === 'fmt,ren', '命中标题与 tag(大小写不敏感);拒载那条目录名不含 gdsc 所以被滤掉', q('gdsc'))
  ok(q('gdformat') === 'fmt', '命中共识词 cmds', q('gdformat'))
  ok(q('refactor') === 'ren', '命中 tag', q('refactor'))
  ok(q('清一清') === 'fmt', '命中 summary', q('清一清'))
  ok(q('fmt') === 'fmt', '命中 id(用户从目录名搜也是常态)', q('fmt'))
  ok(q('不存在的东西') === '', '搜不到就是空:拒载那条也不该永远赖在结果里(那会让搜索框冒出一堆不相关的红条)', q('不存在的东西'))
  ok(q('bad') === 'bad', '拒载的条目按**目录名**可搜到(用户找坏插件的唯一办法)', q('bad'))
  ok(q('manifest') === 'bad', '拒载条目按原因可搜(原因里含 manifest 一词)', q('manifest'))
  ok(q('  ') === 'fmt,ren,view1,bad', '空白 query 当没筛', q('  '))
  ok(IDS(T.filterTools(tools, { kind: 'view' })) === 'view1', 'kind chip 只认真正的 view 型', IDS(T.filterTools(tools, { kind: 'view' })))
  ok(T.filterTools(tools, { tag: 'gdscript' }).length === 2, 'tag chip')
  const en = IDS(T.filterTools(tools, { onlyEnabled: true, enabledIds: ['fmt'] }))
  ok(en === 'fmt', '「只看启用」把拒载条目滤掉:它本来就启用不了,留着等于骗用户说它被禁用了', en)
  const junk = T.filterTools(tools, { kind: 'all', tag: 'all', onlyEnabled: false, enabledIds: undefined })
  ok(junk.length === 4, "kind/tag 给 'all' 与缺省时一律不筛(连拒载那条也留着)", junk.length)
  const withQ = T.filterTools(tools, { query: 'gd', kind: 'all', tag: 'all' })
  ok(withQ.length === 2, "同一组 chip 下,有 query 时才真的收窄(证明 'all' 与 query 各管一段)", withQ.length)
  ok(T.filterTools(null, {}).length === 0 && T.filterTools(undefined, { query: 'x' }).length === 0, '脏入参不抛')
}

section('9. allTags:chip 的候选集')
{
  const tools = [
    reg(MAN({ id: 'a', tags: ['gdscript', 'x'] }), MOD),
    reg(MAN({ id: 'b', tags: ['gdscript'] }), MOD),
    reg(MAN({ id: 'c' }), MOD)
  ]
  const tags = FA(T.allTags(tools))
  ok(tags[0] === 'gdscript', '出现次数多的排前面', tags)
  ok(tags.join(',') === 'gdscript,x', '全集不重复', tags)
  ok(T.allTags([]).length === 0 && T.allTags(null).length === 0, '空/脏入参给空数组')
  const noManifest = T.allTags([reg(null, MOD)])
  ok(noManifest.length === 0, '拒载条目不贡献 tag', noManifest)
  // ★区分「按次数排」与「按插入序排」的样本:先出现的 tag 反而次数少。
  //   少了这一组,K8 那把刀(直接把 sort 摘掉)跑出来是 PASS 79 FAIL 0 —— 无牙刀。
  const order = FA(T.allTags([
    reg(MAN({ id: 'p1', tags: ['rare'] }), MOD),
    reg(MAN({ id: 'p2', tags: ['hot', 'rare'] }), MOD),
    reg(MAN({ id: 'p3', tags: ['hot'] }), MOD),
    reg(MAN({ id: 'p4', tags: ['hot'] }), MOD)
  ]))
  ok(order.join(',') === 'hot,rare', '出现 3 次的 hot 排在出现 2 次的 rare 前面,即使 rare 先出现', order)
  ok(order.join(',') !== ['rare', 'hot'].join(','), '不是插入序(那会是 rare,hot)', order)
}

section('10. 内置与用户插件同一条路径(Q23=A 的形状证明)')
{
  const user = reg(MAN({ id: 'same-id', name: '同一个工具' }), MOD, { dirName: 'same-id' })
  const bi = T.registerTool(MAN({ id: 'same-id', name: '同一个工具' }), MOD, { source: 'builtin', granted: ['tree', 'text'] })
  ok(user.state === bi.state && user.manifest.id === bi.manifest.id, '注册结果除 source 外完全同形(内置没有特权路径)', [user.state, bi.state])
  ok(bi.source === 'builtin' && user.source === 'user', '只差 source 这一个字段', [bi.source, user.source])
  ok(T.registerTool(MAN(), MOD, { granted: ['tree', 'text'] }).source === 'user', 'source 缺省按 user(不冒充内置)', T.registerTool(MAN(), MOD, { granted: ['tree', 'text'] }).source)
  ok(T.registerTool(MAN(), MOD, { source: 'nope', granted: ['tree', 'text'] }).source === 'user', '脏 source 收口成 user(不产生第三种来源)')
  ok(T.registerTool(MAN(), MOD, { source: 'builtin', dirName: 42, granted: ['tree', 'text'] }).dirName === '', '脏 dirName 收口成空串')
}

console.log(`\n${'='.repeat(56)}\nPASS ${pass}  FAIL ${failures.length}`)
if (failures.length) {
  console.log('失败项:')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log('全部通过')
