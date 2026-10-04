// 工具页 P1/M-P1a:`[node]` 段解析(src/tools/parsers/sceneNodes.ts)的断言。
//
// 为什么单开一个文件:sceneRefs 的既有口径是「只认 ext_resource,逐行判定天然挡住 [node]」
// (src/tools/parsers/sceneRefs.ts:7,tools.test.mjs:300 还钉着「node 段不计入 actual」)。
// 本件是那条口径的**另一半**:真正把 [node] 段读出来。两者共用同一份段属谓词与 attr(),
// 但夹具与判据完全不同,混进 tools.test.mjs 会让「引用收集」和「节点树」两件事互相踩。
//
// 设计口径见 docs/tools-page-plan.md P1-4 #13:
//   · name/type/parent 一律走 sceneRefs.attr(第二份正则就是债 8 说的分叉点);
//   · path 由 parent 递推,`parent="."` 是「挂在已声明的父节点上」的写法,根节点自己写 `.`;
//   · 节点体内的 `script = ExtResource("id")` 归到该节点,段外(script = null)不算。
//
// 用法(npm script 会先跑打包步骤):
//   node src/composables/__tests__/build-bundle.mjs && node src/tools/__tests__/sceneNodes.test.mjs
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

const HAS = typeof T.parseSceneNodes === 'function'
ok(HAS, 'parseSceneNodes 已在打包产物里导出')
if (!HAS) {
  console.log('\n实现尚未落地,后续断言无法执行(这就是 RED 那一步)。')
  console.log(`\n${'='.repeat(56)}\nPASS ${pass}  FAIL ${failures.length}`)
  process.exit(1)
}

/** 编辑器写盘的真实形态:文件头 → ext_resource → node 段(体内属性各占一行) → connection */
const TSCN = [
  '[gd_scene load_steps=3 format=3 uid="uid://cabc"]',
  '',
  '[ext_resource type="Script" path="res://player.gd" id="1_p"]',
  '[ext_resource type="Texture2D" path="res://icon.svg" id="2_i"]',
  '',
  '[node name="Player" type="CharacterBody2D"]',
  'script = ExtResource("1_p")',
  '',
  '[node name="Sprite" type="Sprite2D" parent="."]',
  'texture = ExtResource("2_i")',
  '',
  '[node name="Hitbox" type="Area2D" parent="Sprite"]',
  '',
  '[connection signal="body_entered" from="Sprite/Hitbox" to="Player" method="_on_body_entered"]',
].join('\n')

section('1. 段头三要素:name / type / parent')
{
  const ns = T.parseSceneNodes(TSCN)
  ok(ns.length === 3, '只出 3 个节点(ext_resource 与 connection 不算)', ns.length)
  ok(ns[0].name === 'Player' && ns[0].type === 'CharacterBody2D', '根节点 name/type 抽到', JSON.stringify(ns[0]))
  ok(ns[1].name === 'Sprite' && ns[1].parent === '.', '子节点 parent 原样给 "."', JSON.stringify(ns[1]))
  ok(ns[2].name === 'Hitbox' && ns[2].parent === 'Sprite', '孙节点 parent 是父节点名', JSON.stringify(ns[2]))
  ok(ns[2].line === 12, '行号按文件实际行号给(根在 6、Sprite 在 9、Hitbox 在 12)', ns[2].line)
}

section('2. path 递推:根 = 自己的 name,子 = 父 path + "/" + name')
{
  const ns = T.parseSceneNodes(TSCN)
  ok(ns[0].path === 'Player', '根节点 path = name', ns[0].path)
  ok(ns[1].path === 'Player/Sprite', '`parent="."` 就是挂在根节点下(parent 是相对根的路径)', ns[1].path)
  ok(ns[2].path === 'Player/Sprite/Hitbox', '两层递推(parent="Sprite" → 根的 Sprite 下)', ns[2].path)
}

section('3. 节点体内的 script 归该节点')
{
  const ns = T.parseSceneNodes(TSCN)
  ok(ns[0].scriptId === '1_p', '根节点的 script = ExtResource("1_p")', ns[0].scriptId)
  ok(ns[1].scriptId === '', '体内没有 script 的节点给空串而不是 undefined', JSON.stringify(ns[1].scriptId))
}

section('4. 空文本 / 只有文件头 / 残缺段头')
{
  // `[node` 后面没有空格就没有属性区,不构成段头 —— 与 parseExtResources 的
  // `t.startsWith('[ext_resource')` 同一把尺子(sceneRefs.ts:42),两边别一把松一把紧。
  for (const [text, label] of [['', '空字符串'], ['[gd_scene format=3]\n', '只有文件头'], ['[gd_scene format=3]\n[node', '残缺段头(没有空格)']]) {
    const ns = T.parseSceneNodes(text)
    ok(Array.isArray(ns) && ns.length === 0, `${label}:给空数组,不抛错`, JSON.stringify(ns))
  }
}

section('5. 内联 `script = "res://x.gd"` 形态')
{
  // 手写的 .tscn 与某些插件产物会把脚本路径直接写成串(不走 ExtResource id)。
  // 只认 id 形态的话,#13 的「节点脚本路径失效」会对这类节点闭嘴 —— 漏报也是错。
  const ns = T.parseSceneNodes(['[node name="A" type="Node"]', 'script = "res://a/x.gd"'].join('\n'))
  ok(ns[0].scriptId === '' && ns[0].scriptPath === 'res://a/x.gd', '串形态进 scriptPath,不污染 scriptId', JSON.stringify(ns[0]))

  const both = T.parseSceneNodes(['[node name="A"]', 'script = "res://b.gd"', 'script = ExtResource("1_x")'].join('\n'))
  ok(both[0].scriptId === '1_x' && both[0].scriptPath === 'res://b.gd', '两种形态同时出现时各自保留,不互相覆盖', JSON.stringify(both[0]))

  const nul = T.parseSceneNodes(['[node name="A"]', 'script = null'].join('\n'))
  ok(nul[0].scriptId === '' && nul[0].scriptPath === '', 'script = null 不算挂了脚本', JSON.stringify(nul[0]))
}

section('6. 段属收口:非 node 段的内容不污染上一个节点')
{
  const t = [
    '[node name="A" type="Node"]',
    '[connection signal="x" from="A" to="B" method="m"]',
    'script = ExtResource("9_z")',
  ].join('\n')
  const ns = T.parseSceneNodes(t)
  ok(ns.length === 1 && ns[0].scriptId === '', '[connection] 段里的 script 不归上一个 node', JSON.stringify(ns))

  const inst = ['[node name="A" type="Node"]', 'instance = ExtResource("2_p")'].join('\n')
  const i = T.parseSceneNodes(inst)
  ok(i[0].scriptId === '', 'instance 不是 script,别混为一谈', JSON.stringify(i[0]))
}

section('7. 畸形与罕见形态一律不抛错')
{
  // 没有根节点就写 parent=".":path 无从递推,给空串而不是编一个路径出来。
  const noRoot = T.parseSceneNodes('[node name="A" type="Node" parent="."]\n')
  ok(noRoot.length === 1 && noRoot[0].path === '', '认不出根 → path 空串', JSON.stringify(noRoot[0]))

  const noName = T.parseSceneNodes('[node type="Node"]\n')
  ok(noName.length === 1 && noName[0].name === '', '段头缺 name → 空串,不崩(怎么报是检查器的事)', JSON.stringify(noName[0]))

  const bracket = T.parseSceneNodes('[node name="A]B" type="Node"]\nscript = ExtResource("1_x")\n')
  ok(bracket.length === 1 && bracket[0].scriptId === '1_x', 'name 里带 `]` 时体内属性照常归位', JSON.stringify(bracket[0]))

  for (const [text, label] of [[undefined, 'undefined'], [null, 'null'], [123, '数字']]) {
    const ns = T.parseSceneNodes(text)
    ok(Array.isArray(ns) && ns.length === 0, `${label} 入参给空数组(红线:纯函数不抛)`, JSON.stringify(ns))
  }
}

console.log(`\n${'='.repeat(56)}\nPASS ${pass}  FAIL ${failures.length}`)
if (failures.length) {
  console.log('失败项:')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log('全部通过')
