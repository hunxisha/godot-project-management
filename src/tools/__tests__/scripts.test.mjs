// 工具页 P1/M-P1b #12 脚本体检(src/tools/inspectors/scripts.ts)的断言。
//
// 为什么单开一个文件:判据是**跨文件**的(重复 class_name、继承环都要看全量声明),
// 与 gdSymbols.test.mjs 那种「一份文本进、一个结构出」的解析层夹具共用不上。
//
// 本轮的裁定来自 docs/tools-page-plan.md P1-4 #12 与待确认 #13(甲方案):
//   · `extends` 的基类既不在项目声明里、也不在手写引擎类白名单里 → **不报 error**,
//     只出一条聚合 info 说「这些基类本工具判不了」并计条数;
//   · 「@tool 缺 class_name」这条判据已删(Godot 语义里 @tool 与 class_name 无必然关系);
//   · 跨文件判据在 ctx.truncated 时整体不判(少一份清单就会把重复看成不重复,方向反了也一样)。
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../../..')
const BUNDLE = path.resolve(ROOT, '.gpm-test/out/tools.mjs')

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

const HAS = typeof T.runScripts === 'function'
ok(HAS, 'runScripts 已在打包产物里导出')
if (!HAS) {
  console.log('\n实现尚未落地,后续断言无法执行(这就是 RED 那一步)。')
  console.log(`\n${'='.repeat(56)}\nPASS ${pass}  FAIL ${failures.length}`)
  process.exit(1)
}

function extOf(rel) {
  const base = rel.slice(rel.lastIndexOf('/') + 1)
  const i = base.lastIndexOf('.')
  return i > 0 ? base.slice(i + 1).toLowerCase() : ''
}
function tree(specs) {
  const base = Date.UTC(2026, 0, 1)
  return specs.map(([rel, size, off = 0]) => ({ rel, size, mtimeMs: base + off * 86400000, ext: extOf(rel) }))
}
function makeCtx(specs, { trunc = false, texts = {}, fail = {} } = {}) {
  const calls = []
  const ctx = {
    projectId: 'godot/project/p',
    root: 'E:/proj',
    truncated: trunc,
    tree: tree(specs),
    readText: async (rel) => {
      calls.push(rel)
      if (Object.prototype.hasOwnProperty.call(fail, rel)) return fail[rel]
      return typeof texts[rel] === 'string' ? { text: texts[rel] } : { skipped: true }
    }
  }
  return { ctx, calls }
}

const dupOf = (fs) => fs.filter((f) => f.id.startsWith('scripts:dup:'))
const cycOf = (fs) => fs.filter((f) => f.id.startsWith('scripts:cycle:'))
const unkOf = (fs) => fs.filter((f) => f.id === 'scripts:unknown-base')
const missOf = (fs) => fs.filter((f) => f.id.startsWith('scripts:base-missing:'))
const truncOf = (fs) => fs.filter((f) => f.id === 'scripts:truncated')
const skipOf = (fs) => fs.filter((f) => f.id === 'scripts:skip-count')
const idsOf = (fs) => fs.map((f) => f.id).join('|')

const gd = (s) => s.join('\n')

section('1. class_name 重复:一组一条 error,证据带两份 rel')
{
  const { ctx } = makeCtx(
    [['project.godot', 200], ['a/effect.gd', 100], ['b/effect_copy.gd', 100]],
    { texts: {
      'a/effect.gd': gd(['class_name PlayerEffect', 'extends Node', '', 'var n := 1']),
      'b/effect_copy.gd': gd(['class_name PlayerEffect', 'extends Node2D'])
    } }
  )
  const fs = await T.runScripts(ctx)
  const d = dupOf(fs)
  ok(d.length === 1, '同名的两份声明合成一条(不是两条)', d.length)
  ok(d[0].severity === 'error', '重复 global class 是 error(引擎直接拒绝)', d[0].severity)
  ok(JSON.stringify(d[0].related) === JSON.stringify(['a/effect.gd', 'b/effect_copy.gd']),
    'related 带两个来源 rel(按文件顺序)', d[0].related)
  ok(d[0].title.includes('PlayerEffect'), '标题点名重复的类名', d[0].title)
}

section('2. 只有顶格声明参与(内部类不算全局 class)')
{
  const { ctx } = makeCtx(
    [['project.godot', 200], ['a/x.gd', 100], ['b/y.gd', 100]],
    { texts: {
      'a/x.gd': gd(['class_name RealOne', 'extends Node', '', 'func f():', '\tclass_name RealOne']),
      'b/y.gd': gd(['extends Node', '', 'class_name RealOne'])
    } }
  )
  const fs = await T.runScripts(ctx)
  ok(dupOf(fs).length === 1, '缩进那条没被算进来(仍是「两个文件各声明一次」这一组)', dupOf(fs).length)
}

section('2b. 顶格约束的真正证据:内部类名撞全局类名不该长出一组假重复')
{
  // Godot 允许「内部类/函数体里的 class_name」与别处的 global class 同名(前者不进全局表)。
  // 放松顶格约束,a.gd 缩进那条就会参与重复 → 这一组会变成假 error。
  const { ctx } = makeCtx(
    [['project.godot', 200], ['a.gd', 100], ['b.gd', 100]],
    { texts: {
      'a.gd': gd(['extends Node', '', 'func f():', '\tclass_name Solo']),
      'b.gd': gd(['class_name Solo', 'extends Resource'])
    } }
  )
  const fs = await T.runScripts(ctx)
  ok(dupOf(fs).length === 0, '只有顶格那条参与重复 → 本例不该有任何重复结论', idsOf(fs))
  ok(cycOf(fs).length === 0, '缩进的 extends 也不参与成环判定', idsOf(fs))
}

section('3. 继承环:互继承与自继承各成一条')
{
  const { ctx } = makeCtx(
    [['project.godot', 200], ['a.gd', 50], ['b.gd', 50], ['c.gd', 50]],
    { texts: {
      'a.gd': gd(['class_name Alpha', 'extends Beta']),
      'b.gd': gd(['class_name Beta', 'extends Alpha']),
      'c.gd': gd(['class_name Gamma', 'extends Gamma'])
    } }
  )
  const fs = await T.runScripts(ctx)
  const c = cycOf(fs)
  ok(c.length === 2, '一个二元环 + 一个自继承 = 两条(二元环不报两遍)', c.length)
  ok(c.every((f) => f.severity === 'error'), '继承环一律 error', c.map((f) => f.severity))
  ok(c.some((f) => (f.related || []).includes('a.gd') && (f.related || []).includes('b.gd')),
    '环上的 rel 全部带出来', idsOf(c))
  ok(c.some((f) => f.title.includes('自己') || f.title.includes('Gamma')),
    '自继承那条要点得出来(措辞不同于二元环)', c.map((f) => f.title))
}

section('4. 甲方案:白名单外的基类不报 error,只出聚合 info')
{
  const { ctx } = makeCtx(
    [['project.godot', 200], ['a.gd', 50], ['b.gd', 50], ['c.gd', 50]],
    { texts: {
      'a.gd': gd(['class_name Uses', 'extends CharacterBody2D']),   // 常见引擎类 → 白名单内,不提
      'b.gd': gd(['class_name Owns', 'extends Uses']),              // 项目内声明 → 不算未知
      'c.gd': gd(['class_name Odd', 'extends SomeWeirdBase'])       // 既非引擎白名单也非项目类 → 只计不判
    } }
  )
  const fs = await T.runScripts(ctx)
  ok(fs.every((f) => f.id !== 'scripts:unknown:SomeWeirdBase'), '不给未知基类发 error', fs.map((f) => f.id))
  const u = unkOf(fs)
  ok(u.length === 1 && u[0].severity === 'info', '未知基类合成一条 info', u.length)
  ok(u[0].detail.includes('SomeWeirdBase'), '聚合卡点名认不出的基类(不报的也要看得见)', u[0].detail)
  ok(!u[0].detail.includes('CharacterBody2D') && !u[0].detail.includes('Uses'),
    '白名单内与项目内的都不进这笔数', u[0].detail)
}

section('5. extends "res://…" 路径形态:缺文件报 error,在树里不报')
{
  const specs = [['project.godot', 200], ['base/skill.gd', 60], ['a.gd', 40], ['b.gd', 40]]
  const { ctx } = makeCtx(specs, { texts: {
    'a.gd': 'extends "res://base/skill.gd"',
    'b.gd': "extends 'res://base/gone.gd'"
  } } )
  const fs = await T.runScripts(ctx)
  const m = missOf(fs)
  ok(m.length === 1, '只有真的不在树里的那条被报', idsOf(m))
  ok(m[0].severity === 'error', '路径形态基类缺失是 error(引擎加载脚本就失败)', m[0].severity)
  ok(m[0].rel === 'b.gd' && m[0].title.includes('res://base/gone.gd'), '证据带引用者与目标路径', m[0])
}

section('6. 清单被截断:整体不判,只出一条截断')
{
  const { ctx } = makeCtx([['a.gd', 10], ['b.gd', 10]], { trunc: true, texts: {
    'a.gd': 'class_name Dup\nextends Node',
    'b.gd': 'class_name Dup\nextends Node'
  } })
  const fs = await T.runScripts(ctx)
  ok(fs.length === 1 && truncOf(fs).length === 1, '截断时一条判据都不发', idsOf(fs))
  ok(truncOf(fs)[0].severity === 'warn', '截断本身是 warn 级', truncOf(fs)[0].severity)
  ok(!dupOf(fs).length, '重复不报(清单可能缺了另一半)', dupOf(fs).length)
}

section('7. 扫描面:.godot/、.gdignore 目录、非 .gd 一律不读')
{
  const { ctx, calls } = makeCtx(
    [['project.godot', 200], ['scripts/a.gd', 10], ['.godot/imported/b.gd', 10],
     ['dlc/.gdignore', 1], ['dlc/c.gd', 10], ['notes.txt', 10], ['c.cs', 10]],
    { texts: { 'scripts/a.gd': 'class_name OnlyReal\nextends Node' } }
  )
  const fs = await T.runScripts(ctx)
  ok(calls.indexOf('.godot/imported/b.gd') === -1, '.godot 缓存不读', calls)
  ok(calls.indexOf('dlc/c.gd') === -1, '.gdignore 目录不读', calls)
  ok(calls.indexOf('notes.txt') === -1 && calls.indexOf('c.cs') === -1, '非 .gd 不读(C# 的 class_name 不是一套东西)', calls)
  ok(calls.indexOf('scripts/a.gd') >= 0, '正常 .gd 照常读', calls)
  ok(Array.isArray(fs), '返回数组', typeof fs)
}

section('8. 「读不到」与「可疑文本」的条数要上卡')
{
  // 有结论时:计数并进每一条 detail(与 addons/brokenRefs 同一落点)。
  const a = await T.runScripts(makeCtx(
    [['project.godot', 200], ['x.gd', 10], ['y.gd', 10], ['z.gd', 10]],
    { texts: { 'x.gd': 'class_name D\nextends Node', 'y.gd': 'class_name D\nextends Node' },
      fail: { 'z.gd': { skipped: true } } }
  ).ctx)
  ok(dupOf(a).length === 1 && dupOf(a)[0].detail.includes('z.gd') === false,
    'detail 报的是条数,不是逐个 rel', dupOf(a)[0].detail)
  ok(/1\s*(?:个|份|条)/.test(dupOf(a)[0].detail), '未读到的那 1 份被说出口', dupOf(a)[0].detail)

  // 一条结论都没有时:光有计数没地方说 → 单独出一条 info 聚合。
  const b = await T.runScripts(makeCtx(
    [['project.godot', 200], ['big.gd', 10]],
    { fail: { 'big.gd': { skipped: true } } }
  ).ctx)
  ok(skipOf(b).length === 1 && skipOf(b)[0].severity === 'info', '只有排除数时也上卡', idsOf(b))
  ok(!dupOf(b).length && !cycOf(b).length, '排除数不产出任何 error/warn 判定', idsOf(b))

  // 未闭合引号的整文件不判(值不可信),同时计一笔。
  const c = await T.runScripts(makeCtx(
    [['project.godot', 200], ['bad.gd', 10], ['ok.gd', 10]],
    { texts: { 'bad.gd': 'class_name Broken\nconst S = "未闭合\n', 'ok.gd': 'extends Node' } }
  ).ctx)
  ok(!missOf(c).length && !dupOf(c).length, '可疑文本不产出判定', idsOf(c))
  ok(/可疑|未闭合/.test(skipOf(c).concat(unkOf(c)).map((f) => f.detail).join('')) || skipOf(c).length > 0,
    '可疑那份要有一个说得出口的落点', idsOf(c))
}

section('9. 红线:空 ctx / 畸形 tree 不抛错')
{
  const empty = await T.runScripts({ projectId: 'p', root: 'E:/x', truncated: false, tree: [], readText: async () => ({}) })
  ok(Array.isArray(empty) && empty.length === 0, '空清单给空数组', empty)
  const junk = await T.runScripts({
    projectId: 'p', root: 'E:/x', truncated: false,
    tree: [{ rel: '', size: 1, mtimeMs: 0, ext: 'gd' }, null],
    readText: async () => ({ text: 'class_name A\nextends Node' })
  })
  ok(Array.isArray(junk), '畸形条目不抛(空 rel 与 null 都得扛住)', junk)
}

console.log(`\n${'='.repeat(56)}\nPASS ${pass}  FAIL ${failures.length}`)
if (failures.length) { console.log('失败项:'); for (const f of failures) console.log('  - ' + f); process.exit(1) }
console.log('全部通过')
