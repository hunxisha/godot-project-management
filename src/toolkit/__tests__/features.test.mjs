// 工具箱 · 第 1 批 Task 8:feature 注册与关键词冲突(src/toolkit/features.ts)的断言。
//
// 两个必须钉住的宿主事实(都是从 app.asar grep 得证的,见记忆 reference-ztools-host-internals):
//   · 宿主 `set-feature` **只以 code 去重、完全不查 cmds 冲突** ⇒ 「后装让位」只能我们自己做;
//   · `setFeature` 实测回 `{success,error?}` 而 d.ts 声明 `boolean` ⇒ `if (res)` 永远为真(R-6)。
// 第二条是本文件最容易被写歪的地方:实现里如果只判 truthy,所有断言在「宿主明确说失败」时仍然绿,
// 而那正是用户看不到任何提示、却有个工具悄悄没注册成功的形态。
//
// 用法:node src/composables/__tests__/build-bundle.mjs && node src/toolkit/__tests__/features.test.mjs
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../../..')
const BUNDLE = path.resolve(ROOT, '.gpm-test/out/tkfeatures.mjs')

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
/**
 * 安全取值。本批第 5 次撞在同一类形态上(变异刀把套件撞停而不是判红),
 * 所以定成规矩:凡从数组/对象里按位置取成员,一律走 P()/F(),红一条断言而不是没有末行统计。
 */
const P = (arr, i) => F(FA(arr)[i])
const TOOL = (id, over) => ({ id, name: id, summary: '一句话', cmds: ['关键词' + id], enabled: true, ...(over || {}) })

section('0. 导出面')
for (const n of ['CODE_PREFIX', 'featureCode', 'toolIdOfCode', 'staticFeatures', 'staticTaken', 'codeIsStatic',
  'cmdConflicts', 'conflictText', 'planFeatures', 'interpretSetFeature', 'applyFeatures', 'unapplyFeatures', 'ourFeatureCodes']) {
  ok(T[n] !== undefined, `${n} 已在打包产物里导出`)
}

section('1. code 的前缀与反解')
{
  ok(T.CODE_PREFIX === 'tool-', '前缀是 tool-(与那 5 个静态 code 天然隔开)', T.CODE_PREFIX)
  ok(T.featureCode('gdscript-format') === 'tool-gdscript-format', '拼法固定', T.featureCode('gdscript-format'))
  ok(T.toolIdOfCode('tool-gdscript-format') === 'gdscript-format', '反解回去(卸载与对账用)')
  ok(T.toolIdOfCode('projects') === '', '静态 code 反解不出工具 id(不是我们的)')
  ok(T.toolIdOfCode('tool-') === '', '只有前缀没有 id ⇒ 空')
  for (const v of [undefined, null, 42, {}, 'x']) ok(T.toolIdOfCode(v) === '', `脏 code ⇒ 空串(${JSON.stringify(v) ?? String(v)})`)
  ok(T.featureCode('  spaced  ') === 'tool-spaced', '两端空白先 trim(code 里不许留空格)')
}

section('2. 静态 feature 清单:读的是 plugin.json 的 code 字段(读错字段名会静默失效)')
{
  const list = FA(T.staticFeatures())
  ok(FA(list).length === 5, '五个静态入口全被读到(godot / projects / versions / plugins / addProject)', FA(list).map((f) => f.code))
  ok(FA(list).map((f) => f.code).join(',') === 'godot,projects,versions,plugins,addProject',
    '字段名是 `code`:如果误读成 featureName,这里会得到空数组,冲突判定从此形同虚设', FA(list).map((f) => f.code))
  const taken = FA(T.staticTaken())
  ok(FA(taken).length > 8, '静态关键词全部展开(含 files 型的 label)', FA(taken).length)
  const words = FA(taken).map((t) => t.cmd)
  for (const w of ['godot', 'gp', 'gv', 'godot插件', '添加Godot项目']) {
    ok(words.includes(w), `静态关键词「${w}」在冲突判定范围内`, words.slice(0, 14))
  }
  ok(FA(taken).every((t) => t.owner.startsWith('static:')), 'owner 一律带 static: 前缀(提示语要能分清是谁占的)', FA(taken).map((t) => t.owner))
  ok(FA(taken).every((t) => S(t.cmd).length > 0 && S(t.cmd) === t.cmd.trim()), '展开的词都非空且已 trim')
}

section('3. codeIsStatic:同 code 覆盖会抢走内置入口')
{
  for (const c of ['godot', 'projects', 'versions', 'plugins', 'addProject']) ok(T.codeIsStatic(c) === true, `静态 code「${c}」被认出`)
  ok(T.codeIsStatic('tool-projects') === false, '带我们前缀的不算撞(这正是加前缀的理由)')
  ok(T.codeIsStatic('anything-else') === false, '无关 code 放行')
  for (const v of [undefined, null, '', '   ', 42, {}]) ok(T.codeIsStatic(v) === false, `脏入参 ⇒ false(${JSON.stringify(v) ?? String(v)})`)
  // 工具 id 经过前缀后不可能撞静态 code:这一条是 planFeatures 那道保险的前提
  ok(T.codeIsStatic(T.featureCode('projects')) === false, '就算用户装一个 id 叫 projects 的插件,code 也是 tool-projects,不抢入口')
}

section('4. cmdConflicts:顺序、去重、脏元素')
{
  const taken = [{ cmd: 'gp', owner: 'static:projects' }, { cmd: 'gv', owner: 'static:versions' }, { cmd: 'gp', owner: 'static:projects' }]
  const hit = FA(T.cmdConflicts(['gp'], taken))
  ok(FA(hit).length === 1 && P(hit,0).owner === 'static:projects', '同一 (cmd,owner) 只报一次', hit)
  ok(FA(T.cmdConflicts(['nope'], taken)).length === 0, '没踩到就不报')
  ok(FA(T.cmdConflicts(['gp', 'gv'], taken)).map((h) => h.cmd).join(',') === 'gp,gv', '顺序按 taken 原序(提示语要稳定)', FA(T.cmdConflicts(['gv', 'gp'], taken)))
  ok(FA(T.cmdConflicts(null, taken)).length === 0 && FA(T.cmdConflicts(['x'], null)).length === 0, '脏入参给空数组不抛')
  ok(FA(T.cmdConflicts(['  gp  '], taken)).length === 1, '候选词两端空白不影响匹配')
  ok(FA(T.cmdConflicts(['gp'], [null, 7, { cmd: 'gp' }, { owner: 'x' }, { cmd: 'gp', owner: 'tool:a' }])).length === 1,
    'taken 里的脏元素跳过,合法那条仍然报', FA(T.cmdConflicts(['gp'], [null, 7, { cmd: 'gp' }, { owner: 'x' }, { cmd: 'gp', owner: 'tool:a' }])))
}

section('5. conflictText:那句提示要把「工具仍然可用」说出来')
{
  const st = S(T.conflictText([{ cmd: 'gp', owner: 'static:projects' }]))
  ok(st.includes('gp') && st.includes('projects') && !st.includes('static:'), '静态占用:点名关键词与内置入口,同样不漏内部前缀', st)
  ok(st.includes('不注册') && st.includes('工具箱'), '要说清后果:搜索框没有,但工具箱里照样能打开', st)
  const tool = S(T.conflictText([{ cmd: 'x', owner: 'tool:other' }]))
  ok(tool.includes('工具 other'), '工具占用:owner 不带 static: 时说法要变', tool)
  const many = S(T.conflictText([{ cmd: 'a', owner: 'tool:o' }, { cmd: 'b', owner: 'tool:o' }]))
  ok(many.includes('等 2 个关键词'), '多个冲突时带上总数(不能只说第一个就完事)', many)
  ok(T.conflictText([]) === '' && T.conflictText(null) === '', '空冲突不给空话')
  ok(S(T.conflictText([{ cmd: 'a', owner: '裸 owner' }])).includes('已有条目'), 'owner 不带任何已知前缀时也有话说(不显示 undefined)', T.conflictText([{ cmd: 'a', owner: '裸 owner' }]))
}

section('6. planFeatures:后装让位(Q22=A)')
{
  const p = T.planFeatures([TOOL('fmt', { cmds: ['格式化', 'gdformat'] })], [])
  ok(p.length === 1 && P(p,0).register === true, '干净的一条 ⇒ 注册', p)
  ok(P(p,0).code === 'tool-fmt' && P(p,0).feature.cmds.join(',') === '格式化,gdformat', 'feature 形状齐', P(p,0).feature)
  ok(P(p,0).why === '', '注册项不带原因')

  const clash = T.planFeatures([TOOL('late', { cmds: ['gp'] })], [{ cmd: 'gp', owner: 'static:projects' }])
  ok(P(clash,0).register === false, '踩到静态关键词 ⇒ 后装让位,不注册')
  ok(P(clash,0).conflicts.length === 1, '冲突详情留在结果上(列表那行要标黄)', P(clash,0).conflicts)
  ok(P(clash,0).why.includes('gp'), '原因点名是哪个词', P(clash,0).why)

  const two = T.planFeatures([TOOL('a', { cmds: ['x'] }), TOOL('b', { cmds: ['x'] })], [])
  ok(P(two,0).register === true && P(two,1).register === false, '同一批里两个工具撞词 ⇒ 后一个让位(宿主会两个都存,更乱)', two.map((i) => i.register))
  ok(P(two,1).why.length > 0, '让位的那个有话说', P(two,1).why)

  const dis = T.planFeatures([TOOL('off', { enabled: false })], [])
  ok(P(dis,0).register === false && P(dis,0).why.includes('禁用'), '禁用 = 不注册(Q25)', dis[0])
  const noCmds = T.planFeatures([TOOL('silent', { cmds: [] })], [])
  ok(P(noCmds,0).register === false && P(noCmds,0).why.includes('关键词'), '没有关键词 ⇒ 不注册并说明(注册了也搜不到)', noCmds[0])
  const junkCmds = T.planFeatures([TOOL('j', { cmds: ['  ', '', 7, 'ok'] })], [])
  ok(P(junkCmds,0).register === true && junksFeasible(junkCmds[0]), 'cmds 里的脏元素被丢掉,剩下的仍注册', P(junkCmds,0).feature.cmds)
  function junksFeasible(i) { return i.feature.cmds.join(',') === 'ok' }

  const idJunk = T.planFeatures([null, { id: '', cmds: ['a'], enabled: true }, TOOL('z')], [])
  ok(idJunk.length === 1 && P(idJunk,0).toolId === 'z', '脏条目直接跳过(它连 code 都拼不出来)', idJunk)
  ok(T.planFeatures(null, []).length === 0 && T.planFeatures([], null).length === 0, '脏入参不抛')
  const order = T.planFeatures([TOOL('m'), TOOL('n')], [])
  ok(order.map((i) => i.toolId).join(',') === 'm,n', '输出顺序与输入一致(列表顺序不能被重排)', order.map((i) => i.toolId))
}

section('7. interpretSetFeature:R-6 的那条判据(声明 boolean,实回对象)')
{
  ok(T.interpretSetFeature(true).ok === true, 'boolean true ⇒ 成功(照 d.ts 的声明形状)')
  ok(T.interpretSetFeature({ success: true }).ok === true, '{success:true} ⇒ 成功(宿主实际形状)')
  ok(T.interpretSetFeature({ success: true, error: '顺手带的字段' }).ok === true, 'success:true 时附带 error 也算成功')
  ok(T.interpretSetFeature({ ok: true }).ok === true, '{ok:true} 也认(另一种宿主实现)')
  const fail = T.interpretSetFeature({ success: false })
  ok(fail.ok === false, '★ {success:false} 必须判失败:它是 truthy 对象,`if (res)` 会永远为真', fail)
  ok(fail.error.length > 0 && fail.error.includes('原因'), '失败又不给原因时要补一句人话,不许留空', fail.error)
  const withErr = T.interpretSetFeature({ success: false, error: 'code 非法' })
  ok(withErr.ok === false && withErr.error === 'code 非法', '宿主给的原因原样上浮(不套框架的话术)', withErr)
  ok(T.interpretSetFeature({ ok: false, message: 'LMDB 写失败' }).error === 'LMDB 写失败', 'message 也是一种原因载体')
  ok(T.interpretSetFeature({}).ok === false, '没有 success/ok 字段的对象 ⇒ 失败(方向是不许谎报成功)')
  ok(T.interpretSetFeature({ success: 'true' }).ok === false, 'success 是字符串 "true" ⇒ 不算成功(不做宽松解释)', T.interpretSetFeature({ success: 'true' }))
  const undef = T.interpretSetFeature(undefined)
  ok(undef.ok === false && undef.error.includes('没有回执'), 'undefined ⇒ 失败并说「宿主没有回执」', undef)
  ok(T.interpretSetFeature(null).ok === false, 'null ⇒ 失败')
  ok(T.interpretSetFeature(false).ok === false, 'boolean false ⇒ 失败')
  ok(T.interpretSetFeature('ok').ok === false && T.interpretSetFeature(1).ok === false, '字符串/数字 ⇒ 失败,形态不认识也要说出来')
  ok(T.interpretSetFeature([]).ok === false, '空数组是 truthy 对象 ⇒ 仍然判失败(不是 length 判据)')
}

section('8. applyFeatures:只把该注册的打给宿主')
{
  const sent = []
  const zt = { setFeature: (f) => { sent.push(f.code); return { success: true } } }
  const plan = T.planFeatures([TOOL('a'), TOOL('b', { enabled: false }), TOOL('c', { cmds: [] })], [])
  const r1 = await T.applyFeatures(plan, zt)
  ok(sent.join(',') === 'tool-a', '只有 register 的那条真被打给宿主', sent)
  ok(FA(F(r1).applied).length === 3, '三条都有回报(不注册的也要说为什么)', FA(F(r1).applied).map((a) => [F(a).code, F(a).ok]))
  const okA = FA(F(r1).applied).find((a) => a.code === 'tool-a')
  const offB = FA(F(r1).applied).find((a) => a.code === 'tool-b')
  ok(F(okA).ok === true && F(offB).ok === false && S(F(offB).error).includes('禁用'), '成功/让位分别落到 applied', [okA, offB])
  ok(FA(F(r1).taken).length === 1 && P(F(r1).taken, 0).owner === 'tool:a', '占用表只累加真注册成功的(让位的不占词)', F(r1).taken)

  const failZt = { setFeature: () => ({ success: false, error: ' cmds 太长' }) }
  const r2 = await T.applyFeatures(T.planFeatures([TOOL('x')], []), failZt)
  ok(P(F(r2).applied, 0).ok === false && P(F(r2).applied, 0).error === 'cmds 太长',
    '★宿主说失败时不许被判成成功(R-6 的落点);原因里的空白被 trim 是刻意的(带空白的串进 UI 与存储都是噪音)', r2.applied[0])
  ok(FA(F(r2).taken).length === 0, '注册失败 ⇒ 不占关键词(否则第二个工具会被一个没注册成功的对手让位)', F(r2).taken)

  const boom = await T.applyFeatures(T.planFeatures([TOOL('y')], []), { setFeature: () => { throw new Error('ipc 断了') } })
  ok(P(F(boom).applied, 0).ok === false && P(F(boom).applied, 0).error.includes('ipc 断了'), 'setFeature 抛异常收口成一条失败', F(boom).applied)
  const noFn = await T.applyFeatures(T.planFeatures([TOOL('z')], []), {})
  ok(P(F(noFn).applied, 0).ok === false && P(F(noFn).applied, 0).error.includes('没有 setFeature'), '宿主没实现 setFeature ⇒ 明确说,而不是静默', F(noFn).applied)
  const asyncRes = await T.applyFeatures(T.planFeatures([TOOL('w')], []), { setFeature: async () => ({ success: true }) })
  ok(P(F(asyncRes).applied, 0).ok === true, 'setFeature 回 Promise 也照常判', F(asyncRes).applied)
  ok(FA(F(await T.applyFeatures(null, { setFeature: () => true })).applied).length === 0, '脏 plan 入参不抛')
}

section('9. unapplyFeatures:禁用与卸载要能把 code 摘掉')
{
  let got = null
  let count = 0
  const zt = { removeFeature: (c) => { count++; got = c; return { success: true } } }
  const r = await T.unapplyFeatures(['tool-a', 'tool-b'], zt)
  ok(r.ok === true && count === 1, '一次调用摘多个(不逐个来回打宿主)', count)
  ok(FA(got).join(',') === 'tool-a,tool-b', '收 code 数组(宿主支持)', got)
  const empty = await T.unapplyFeatures([], zt)
  ok(empty.ok === true && count === 1, '空清单不调宿主(也不报错)', count)
  ok((await T.unapplyFeatures(null, zt)).ok === true, '脏入参当空清单')
  const noFn = await T.unapplyFeatures(['tool-a'], {})
  ok(noFn.ok === false && noFn.error.includes('removeFeature'), '宿主没实现 ⇒ 明确说(不能假装摘掉了)', noFn)
  const fail = await T.unapplyFeatures(['tool-a'], { removeFeature: () => ({ success: false, error: '没找到' }) })
  ok(fail.ok === false && fail.error === '没找到', '宿主说失败 ⇒ 上浮', fail)
  const boom = await T.unapplyFeatures(['tool-a'], { removeFeature: () => { throw new Error('boom') } })
  ok(boom.ok === false && boom.error.includes('抛异常'), '抛异常收口成失败', boom)
  const filtered = await T.unapplyFeatures(['tool-a', 7, '', null], { removeFeature: (c) => { got = c; return true } })
  ok(filtered.ok === true && FA(got).join(',') === 'tool-a', '脏 code 先滤掉再交给宿主(不把 undefined/空串塞进 ipc)', got)
}

section('10. ourFeatureCodes:从宿主要回来的动态 feature 里认出自己的')
{
  const codes = FA(T.ourFeatureCodes([{ code: 'tool-a' }, { code: 'projects' }, { code: 'tool-b' }, { code: 'tool-a' }]))
  ok(FA(codes).join(',') === 'tool-a,tool-b', '只留我们前缀的、去重(重进页面时不能重复摘)', codes)
  for (const v of [undefined, null, 'x', 42, [null, { }, { code: 7 }]]) ok(T.ourFeatureCodes(v).length === 0, `脏入参给空数组(${JSON.stringify(v) ?? String(v)})`)
  ok(T.ourFeatureCodes([{ code: 'tool-' }]).length === 0, '只有前缀没 id 的不算')
}

console.log(`\n${'='.repeat(56)}\nPASS ${pass}  FAIL ${failures.length}`)
if (failures.length) {
  console.log('失败项:')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log('全部通过')
