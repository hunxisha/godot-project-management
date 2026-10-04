// 工具页 P1/M-P1b #13 场景体检(src/tools/inspectors/scenes.ts)的断言。
//
// 三条判据的落点各不相同,夹具也就各不相同:
//   · 同名兄弟 —— 段内递推(sceneNodes.ts),跨文件无关;
//   · load_steps —— 接上**一直没有消费者**的 countSteps(sceneRefs.ts:85,此前只有 tools.test.mjs:290 在调它);
//   · 脚本路径失效 —— 存在性判定,与 brokenRefs 同一把形状闸 + 同一份清单口径。
//
// 截断的处理跟 brokenRefs 不一样,是这里最容易写错的一点:同名与 load_steps 是**文件内**判据,
// 清单残缺不影响它们;只有存在性那一路需要完整清单。所以截断时撤的只是存在性,并要把撤掉的条数说出口。
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

const HAS = typeof T.runScenes === 'function'
ok(HAS, 'runScenes 已在打包产物里导出')
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

const sibOf = (fs) => fs.filter((f) => f.id.startsWith('scenes:siblings:'))
const stepsOf = (fs) => fs.filter((f) => f.id.startsWith('scenes:steps:'))
const goneOf = (fs) => fs.filter((f) => f.id.startsWith('scenes:script-missing:'))
const badIdOf = (fs) => fs.filter((f) => f.id.startsWith('scenes:script-badid:'))
const skipOf = (fs) => fs.filter((f) => f.id === 'scenes:skip-count')
const idsOf = (fs) => fs.map((f) => f.id).join('|')
const all = (parts) => parts.join('\n')

section('1. 同名兄弟:同父才叫兄弟')
{
  const t = all([
    '[gd_scene format=3]',
    '[node name="Main" type="Node2D"]',
    '[node name="Label" type="Label" parent="."]',
    '[node name="Label" type="Label" parent="."]',
    '[node name="Box" type="Node" parent="."]',
    '[node name="Label" type="Label" parent="Box"]',
  ])
  const { ctx } = makeCtx([['main.tscn', 200]], { texts: { 'main.tscn': t } })
  const fs = await T.runScenes(ctx)
  const s = sibOf(fs)
  ok(s.length === 1, '同一父下重名一条;挂在别的父下的同名不算', idsOf(s))
  ok(s[0].severity === 'error', '同名兄弟是 error(引擎里后者会顶掉前者的路径)', s[0].severity)
  ok(s[0].title.includes('Label') && s[0].rel === 'main.tscn', '点名重名的是谁、在哪个文件', s[0].title)
}

section('2. 认不出根的文件不做同名判定(否则全树都被当成同一父)')
{
  // 畸形:所有段都写 parent=".",没有任何一段是根 → sceneNodes 的 path 一律空串。
  // 这时候按 path 分组会把不同父的节点并成「同一父的兄弟」,报出一堆假 error。
  const t = all([
    '[gd_scene format=3]',
    '[node name="A" type="Node" parent="."]',
    '[node name="B" type="Node" parent="."]',
  ])
  const { ctx } = makeCtx([['x.tscn', 100]], { texts: { 'x.tscn': t } })
  const fs = await T.runScenes(ctx)
  ok(sibOf(fs).length === 0, '不发同名结论', idsOf(fs))
  ok(skipOf(fs).length === 1, '这笔「判不了」要有一个落点', idsOf(fs))
}

section('3. load_steps:引擎不变式是 ext + sub + 1')
{
  const canon = all([
    '[gd_scene load_steps=3 format=3]',
    '[ext_resource type="Script" path="res://a.gd" id="1_a"]',
    '[ext_resource type="Texture2D" path="res://a.png" id="2_t"]',
    '[node name="R" type="Node2D"]',
  ])
  const off = canon.replace('load_steps=3', 'load_steps=9')
  const noAttr = all(['[gd_scene format=3]', '[ext_resource type="Script" path="res://a.gd" id="1_a"]'])

  const a = await T.runScenes(makeCtx([['c.tscn', 10], ['a.gd', 5], ['a.png', 5]], { texts: { 'c.tscn': canon } }).ctx)
  ok(stepsOf(a).length === 0, '规范值不报(每一个引擎写出的场景都满足 +1)', idsOf(a))

  const b = await T.runScenes(makeCtx([['c.tscn', 10], ['a.gd', 5], ['a.png', 5]], { texts: { 'c.tscn': off } }).ctx)
  const st = stepsOf(b)
  ok(st.length === 1 && st[0].severity === 'warn', '声明与实际不符只给 warn(它多半是合并/手改留下的,不是打不开)', idsOf(b))
  ok(st[0].detail.includes('9') && st[0].detail.includes('3'), 'detail 把声明值与应然值都说出来', st[0].detail)

  const c = await T.runScenes(makeCtx([['c.tscn', 10], ['a.gd', 5]], { texts: { 'c.tscn': noAttr } }).ctx)
  ok(stepsOf(c).length === 0, '头部没有 load_steps 属性时跳过比对(缺属性合法,臆造成 1 就是假阳性)', idsOf(c))
}

section('4. 节点脚本失效:id 指不到 ext_resource、或指到的文件不在清单')
{
  const t = all([
    '[gd_scene load_steps=3 format=3]',
    '[ext_resource type="Script" path="res://scripts/alive.gd" id="1_ok"]',
    '[ext_resource type="Script" path="res://scripts/gone.gd" id="2_bad"]',
    '[node name="A" type="Node"]',
    'script = ExtResource("1_ok")',
    '[node name="B" type="Node"]',
    'script = ExtResource("2_bad")',
    '[node name="C" type="Node"]',
    'script = ExtResource("9_none")',
  ])
  const { ctx } = makeCtx([['s.tscn', 200], ['scripts/alive.gd', 20], ['s.tscn.uid', 20]], { texts: { 's.tscn': t } })
  const fs = await T.runScenes(ctx)
  ok(goneOf(fs).length === 1 && goneOf(fs)[0].id.includes('2_bad'),
    '只有「引用在、文件不在」的那条算失效', idsOf(goneOf(fs)))
  ok(goneOf(fs)[0].severity === 'error', '失效脚本引用是 error', goneOf(fs)[0].severity)
  const bad = badIdOf(fs)
  ok(bad.length === 1 && bad[0].id.includes('9_none'), '段体内指到文件里没有的 id,单独一档(措辞不能混成「文件丢了」)', idsOf(bad))
  ok(bad[0].detail.includes('ext_resource'), '说清是 id 对不上,不是路径对不上', bad[0].detail)
}

section('5. 内联 script 串形态同样判存在性,脏形状只撤不报')
{
  const t = all([
    '[gd_scene format=3]',
    '[node name="A" type="Node"]',
    'script = "res://x/missing.gd"',
    '[node name="B" type="Node"]',
    'script = "res://x/present.gd "',
  ])
  const { ctx } = makeCtx([['i.tscn', 100], ['x/other.gd', 10]], { texts: { 'i.tscn': t } })
  const fs = await T.runScenes(ctx)
  ok(goneOf(fs).length === 1 && goneOf(fs)[0].id.includes('res://x/missing.gd'),
    '串形态缺文件照样报 error', idsOf(goneOf(fs)))
  ok(goneOf(fs).length === 1 && /尾空格|形状|未判定/.test(goneOf(fs)[0].detail),
    '尾巴带空格的那条走形状闸:不判存在性,并计一笔', goneOf(fs)[0].detail)
}

section('6. 截断:撤掉的只有存在性那一路')
{
  const t = all([
    '[gd_scene format=3]',
    '[ext_resource type="Script" path="res://gone.gd" id="1_g"]',
    '[node name="R" type="Node"]',
    'script = ExtResource("1_g")',
    '[node name="A" type="Node" parent="."]',
    '[node name="A" type="Node" parent="."]',
  ])
  const { ctx } = makeCtx([['t.tscn', 100]], { trunc: true, texts: { 't.tscn': t } })
  const fs = await T.runScenes(ctx)
  ok(goneOf(fs).length === 0, '清单残缺时不发「文件丢了」(它可能只是没被列进清单)', idsOf(fs))
  ok(sibOf(fs).length === 1, '同名兄弟是文件内判据,照判', idsOf(fs))
  ok(/截断|清单不完整/.test(sibOf(fs)[0].detail), '并把这撤掉的一路说进 detail', sibOf(fs)[0].detail)
}

section('7. 扫描面与非文本')
{
  const { ctx, calls } = makeCtx(
    [['main.tscn', 100], ['data/thing.tres', 50], ['.godot/imported/c.tscn', 20],
     ['dlc/.gdignore', 1], ['dlc/x.tscn', 20], ['readme.md', 20]],
    { texts: { 'main.tscn': '[gd_scene format=3]\n[node name="R" type="Node"]' } }
  )
  const fs = await T.runScenes(ctx)
  ok(calls.includes('data/thing.tres') && calls.includes('main.tscn'), '.tscn 与 .tres 同属文本资源场景(SCENE_EXT 一份口径)', calls)
  ok(!calls.includes('.godot/imported/c.tscn') && !calls.includes('dlc/x.tscn') && !calls.includes('readme.md'),
    '缓存 / .gdignore / 非场景不读', calls)
  ok(Array.isArray(fs), '返回数组', typeof fs)

  const r = await T.runScenes(makeCtx([['m.tscn', 10]], { fail: { 'm.tscn': { skipped: true } } }).ctx)
  ok(r.length === 1 && skipOf(r).length === 1 && skipOf(r)[0].severity === 'info',
    '一条判定都没有时,读不到的那份也要上卡', idsOf(r))
}

section('8. 红线:空清单与畸形条目不抛')
{
  const e = await T.runScenes({ projectId: 'p', root: 'E:/x', truncated: false, tree: [], readText: async () => ({}) })
  ok(Array.isArray(e) && e.length === 0, '空清单给空数组', e)
  const j = await T.runScenes({
    projectId: 'p', root: 'E:/x', truncated: false,
    tree: [{ rel: 'a.tscn', size: 1, mtimeMs: 0, ext: 'tscn' }, null],
    readText: async () => ({ text: 42 })
  })
  ok(Array.isArray(j), 'text 给非字符串时按「读不到」处理,不抛', j)
}

console.log(`\n${'='.repeat(56)}\nPASS ${pass}  FAIL ${failures.length}`)
if (failures.length) { console.log('失败项:'); for (const f of failures) console.log('  - ' + f); process.exit(1) }
console.log('全部通过')
