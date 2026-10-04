// 工具页 P1/M-P1b #14 输入映射体检(src/tools/inspectors/inputMap.ts)的断言。
//
// 这一条的全部风险都在**「什么算一次动作引用」**上:把整行的字符串字面量都当动作名,
// 每一个 print("jump") 都会变成一条 warn,页面上就是刷屏假阳性(§6 头号失败模式)。
// 所以下面第 2 节是核心:调用点谓词不收的东西,一条都不许进判定。
//
// 定级按 docs/tools-page-plan.md 待确认 #15 的暂定值:**warn**。
// 引擎对未知动作是 push_warning + 返回 false(不崩、不报错),它与「文件丢了」不同级。
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

const HAS = typeof T.runInputMap === 'function'
ok(HAS, 'runInputMap 已在打包产物里导出')
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
    projectId: 'godot/project/p', root: 'E:/proj', truncated: trunc, tree: tree(specs),
    readText: async (rel) => {
      calls.push(rel)
      if (Object.prototype.hasOwnProperty.call(fail, rel)) return fail[rel]
      return typeof texts[rel] === 'string' ? { text: texts[rel] } : { skipped: true }
    }
  }
  return { ctx, calls }
}

const PROJECT = [
  'config_version=5',
  '[application]',
  'config/name="Demo"',
  '[input]',
  'jump={',
  '"deadzone": 0.5,',
  '"events": []',
  '}',
  'dash={',
  '"deadzone": 0.5',
  '}',
].join('\n')
const SPECS = [['project.godot', 300], ['player.gd', 200]]
const unDefOf = (fs) => fs.filter((f) => f.id.startsWith('inputMap:undefined:'))
const caseOf = (fs) => fs.filter((f) => f.id.startsWith('inputMap:case:'))
const noProjOf = (fs) => fs.filter((f) => f.id === 'inputMap:no-project')
const skipOf = (fs) => fs.filter((f) => f.id === 'inputMap:skip-count')
const idsOf = (fs) => fs.map((f) => f.id).join('|')

section('1. 未定义动作:一条动作一张卡,证据带引用处')
{
  const { ctx } = makeCtx(SPECS, { texts: {
    'project.godot': PROJECT,
    'player.gd': ['extends CharacterBody2D', '', 'func _physics_process(delta):',
      '\tif Input.is_action_pressed("jump"):', '\t\tmove_and_slide()',
      '\tif Input.is_action_just_pressed("fly"):', '\t\tfly()'].join('\n')
  } })
  const fs = await T.runInputMap(ctx)
  const u = unDefOf(fs)
  ok(u.length === 1, 'jump 已定义不报、fly 未定义报一条', idsOf(u))
  ok(u[0].severity === 'warn', '未定义动作是 warn(引擎只 push_warning,不崩)', u[0].severity)
  ok(u[0].title.includes('fly'), '标题点名动作名', u[0].title)
  ok(u[0].detail.includes('player.gd') && /\d/.test(u[0].detail), 'detail 带引用处与行号', u[0].detail)
}

section('2. 调用点谓词之外的字符串一律不算引用')
{
  const { ctx } = makeCtx(SPECS, { texts: {
    'project.godot': PROJECT,
    'player.gd': ['extends Node',
      'print("fly")',
      'var s = "jump"',
      'func _input(e):',
      '\tif e.is_action() == false: pass',
      '\tInput.get_gravity_direction("fly")'].join('\n')
  } })
  const fs = await T.runInputMap(ctx)
  ok(unDefOf(fs).length === 0, 'print / 赋值 / 别的 API 都不算动作引用', idsOf(fs))
}

section('3. 认下的调用形态与串形态')
{
  const fs = await T.runInputMap(makeCtx(SPECS, { texts: {
    'project.godot': PROJECT,
    'player.gd': ['extends Node',
      'var a = is_action_pressed("alpha")',
      'var b = Input.is_action_just_released("beta")',
      'var c = action_is_pressed("gamma")',
      'var d = Input.get_action_strength("delta")',
      "var e = Input.is_action_pressed('eps')",
      'var f = Input.is_action_pressed(&"zeta")'].join('\n')
  } }).ctx)
  const names = unDefOf(fs).map((f) => f.id.split(':')[2])
  ok(names.length === 6, '六种形态各出一条(双引号/单引号/&"" 都认)', names.join('|'))
  ok(['alpha', 'beta', 'gamma', 'delta', 'eps', 'zeta'].every((n) => names.includes(n)),
    '名字逐个对得上', names.join('|'))
}

section('4. ui_* 内置动作豁免(不在 [input] 里也合法)')
{
  const fs = await T.runInputMap(makeCtx(SPECS, { texts: {
    'project.godot': PROJECT,
    'player.gd': ['extends Control', 'if Input.is_action_pressed("ui_accept"): pass',
      'if Input.is_action_just_pressed("ui_cancel"): pass'].join('\n')
  } }).ctx)
  ok(unDefOf(fs).length === 0, '引擎自带的 UI 动作不该被报成未定义', idsOf(fs))
}

section('5. 跨行调用:参数不在同一行时不判,只计一笔')
{
  const fs = await T.runInputMap(makeCtx(SPECS, { texts: {
    'project.godot': PROJECT,
    'player.gd': ['extends Node', 'var ok = Input.is_action_pressed(', '    "multiline_action",)',
      'var bad = Input.is_action_pressed("lonely")'].join('\n')
  } }).ctx)
  const u = unDefOf(fs)
  ok(u.length === 1 && u[0].id.includes('lonely'), '跨行那条不产判定(行界不确定),同行那条照常', idsOf(u))
  ok(skipOf(fs).length === 1 || /跨行|未判定/.test(u[0].detail), '不判的那笔要说出口', idsOf(fs) + '|' + u[0].detail)
}

section('6. 大小写冲突:[input] 里同时定义 move_left 与 Move_Left')
{
  const p = [PROJECT, 'move_left={', '"deadzone": 0.5', '}', 'Move_Left={', '"deadzone": 0.5', '}'].join('\n')
  const fs = await T.runInputMap(makeCtx(SPECS, { texts: { 'project.godot': p, 'player.gd': 'extends Node\n' } }).ctx)
  const c = caseOf(fs)
  ok(c.length === 1 && c[0].severity === 'warn', '冲突合成一条 warn(两个名字并存,平台不同行为就不同)', idsOf(c))
  ok(c[0].detail.includes('Move_Left') && c[0].detail.includes('move_left'),
    '两个写法都点名;没撞的 jump / dash 不在里面', c[0].detail)
}

section('7. 读不到 project.godot:整体不判,而不是「所有动作都未定义」')
{
  const fs = await T.runInputMap(makeCtx([['player.gd', 10]], { texts: {
    'player.gd': 'extends Node\nif Input.is_action_pressed("fly"): pass'
  } }).ctx)
  ok(unDefOf(fs).length === 0 && noProjOf(fs).length === 1, '只出一条「读不到配置」,不发任何未定义结论', idsOf(fs))
  ok(noProjOf(fs)[0].severity === 'info', '这条是 info(它讲的是本工具没做成什么)', noProjOf(fs)[0].severity)
}

section('8. 扫描面与截断')
{
  const specs = [['project.godot', 300], ['a.gd', 10], ['.godot/imported/b.gd', 10],
    ['dlc/.gdignore', 1], ['dlc/c.gd', 10], ['main.tscn', 10]]
  const { ctx, calls } = makeCtx(specs, { texts: {
    'project.godot': PROJECT,
    'a.gd': 'if Input.is_action_pressed("solo"): pass',
    'main.tscn': ['[gd_scene format=3]', '[sub_resource type="InputEventKey" id="k"]', 'action = &"tscn_action"'].join('\n')
  } })
  const fs = await T.runInputMap(ctx)
  ok(!calls.includes('.godot/imported/b.gd') && !calls.includes('dlc/c.gd'), '缓存与 .gdignore 不读', calls)
  const names = unDefOf(fs).map((f) => f.id.split(':')[2])
  ok(names.includes('solo') && names.includes('tscn_action'), '场景里的 action 属性同样收(键位重映射就在这)', names.join('|'))

  const tr = await T.runInputMap(makeCtx(specs, { trunc: true, texts: {
    'project.godot': PROJECT, 'a.gd': 'if Input.is_action_pressed("solo"): pass'
  } }).ctx)
  ok(unDefOf(tr).length === 1, '截断不影响判定:定义集来自 project.godot,截断只会少找引用处(假阴性方向)', idsOf(tr))
}

section('9. 红线:空清单与畸形条目不抛')
{
  const e = await T.runInputMap({ projectId: 'p', root: 'E:/x', truncated: false, tree: [], readText: async () => ({}) })
  ok(Array.isArray(e), '空清单不抛(没有 project.godot 时走 no-project 那条)', e)
  const j = await T.runInputMap({
    projectId: 'p', root: 'E:/x', truncated: false,
    tree: [{ rel: 'project.godot', size: 1, mtimeMs: 0, ext: '' }, null],
    readText: async () => ({ text: null })
  })
  ok(Array.isArray(j), 'text 非字符串按读不到处理', j)
}

console.log(`\n${'='.repeat(56)}\nPASS ${pass}  FAIL ${failures.length}`)
if (failures.length) { console.log('失败项:'); for (const f of failures) console.log('  - ' + f); process.exit(1) }
console.log('全部通过')
