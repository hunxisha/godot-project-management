// 工具箱重做 · 第 0 批 Task 1：.tscn/.tres 文本解析(src/tools/parsers/sceneRefs.ts)的断言。
//
// 为什么单开一个文件：本解析器此前**没有独立测试**，覆盖散在 ini.test.mjs / scenes.test.mjs /
// tools.test.mjs 三个「检查器级」测试里。第 0 批要把那三个检查器与它们的测试一起删
// (docs/toolkit-redesign-plan.md §6 R-10),而第 2 批的「GDScript 批量重命名」要靠这里改
// ext_resource path —— 一个要留的文件被一批要删的测试覆盖着，就是拆除最大的隐性损失。
//
// 所以这里**不迁断言、按解析器自己的边界直接写**：迁只能覆盖到检查器顺带碰到的那部分，
// 而 resToRel 的 `.` / 空段 / `..` / 盘符四条规则、resPathShapeOk 的首尾闸，此前只在检查器
// 测试里间接命中。
//
// 钉的是解析器自己的边界，不是任何一个检查器的结论：
//   · attr 只认 key="value" 的引号形,且取**首个**(非全局正则);
//   · resToRel 忠实得可怕:不 trim、不看标点,所以尾巴形态由 resPathShapeOk 单独拦(sceneRefs.ts:98-103);
//   · countSteps 的引擎不变式是 load_steps = ext + sub + 1,比的是 expected 不是 actual
//     —— 拿 actual 比会把每一个引擎写出的真场景误报成不符(sceneRefs.ts:75-83);
//   · declared === 0 表示属性缺失,不得当声明值参与比对(sceneRefs.ts:79-81)。
//
// 用法(npm script 会先跑打包步骤):
//   node src/composables/__tests__/build-bundle.mjs && node src/tools/__tests__/sceneRefs.test.mjs
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

section('0. 导出面')
for (const n of ['SCENE_EXT', 'attr', 'parseExtResources', 'resToRel', 'countSteps', 'resPathShapeOk']) {
  ok(T[n] !== undefined, `${n} 已在打包产物里导出`)
}

section('1. SCENE_EXT：只有两个后缀是文本资源文件')
ok(T.SCENE_EXT instanceof Set && T.SCENE_EXT.size === 2, '恰好两员', T.SCENE_EXT.size)
ok(T.SCENE_EXT.has('tscn') && T.SCENE_EXT.has('tres'), '认 tscn / tres')
ok(!T.SCENE_EXT.has('gd') && !T.SCENE_EXT.has('png') && !T.SCENE_EXT.has('json'), '不认别的')
ok(!T.SCENE_EXT.has('TSCN'), '大小写敏感：不认 TSCN（树 rel 的后缀恒小写）')

section('2. attr：只认 key="value"，取首个，取不到给空串')
ok(T.attr('type="script" path="res://a.gd"', 'type') === 'script', '取第一个键值')
ok(T.attr('path="res://a.gd" path="res://b.gd"', 'path') === 'res://a.gd', '重复 key 取首个（非全局正则）')
ok(T.attr('uid=""', 'uid') === '', '空值给空串而不是 null')
ok(T.attr('type="script"', 'path') === '', '缺 key 给空串')
ok(T.attr('path="a]b"', 'path') === 'a]b', '值里带 `]` 照常取出（Godot 允许，故不按整行切）')
ok(T.attr('type=script', 'type') === '', '无引号的裸值不认')
// 这条要有区分度就得挑一个**真的紧邻在 key 尾巴上**的子串：'th' 在 `path=` 里排在 'a' 之后，
// 有 \\b 就进不去。（原来想用 'at' 演示，但 `path` 的字母序是 p-a-t-h，'at=' 压根不构成子串，
// 那条断言拿掉 \\b 也照样绿 —— 是废断言，已换掉。）
ok(T.attr('path="res://x"', 'th') === '', '词界生效：\\b 让 "th" 不匹配 path= 里的 th=')
ok(T.attr(undefined, 'type') === '', 'undefined 入参不抛（exec 内部转成 "undefined" 串，没有引号形）')

section('3. parseExtResources：逐行、不跨行、不去重、顺序即文件顺序')
const scene = [
  '[gd_scene load_steps=3 format=3 uid="uid://abc"]',
  '[ext_resource type="Script" path="res://player.gd" id="1_a"]',
  '[ext_resource type="Texture2D" uid="uid://t1" path="res://icon.svg" id="2_b"]',
  '[sub_resource type="RectangleShape2D" id="r1"]',
  '[node name="Player" type="CharacterBody2D"]',
  'script = ExtResource("1_a")',
].join('\n')
const refs = T.parseExtResources(scene)
ok(refs.length === 2, '只抓 [ext_resource] 行：文件头 / [sub_resource] / [node] / 正文全不算', refs.length)
ok(refs[0].type === 'Script' && refs[0].path === 'res://player.gd' && refs[0].id === '1_a' && refs[0].uid === '',
  '四字段各归位；缺 uid 给空串', JSON.stringify(refs[0]))
ok(refs[1].uid === 'uid://t1' && refs[1].type === 'Texture2D', '第二条的 uid/type 取到', JSON.stringify(refs[1]))
ok(refs.map((r) => r.id).join(',') === '1_a,2_b', '顺序即文件顺序')
const dup = T.parseExtResources('[ext_resource path="res://a"]\n[ext_resource path="res://a"]\n')
ok(dup.length === 2, '不去重（重复引用是真实形态，裁不得）', dup.length)
ok(T.parseExtResources('  [ext_resource path="res://a"]  ').length === 1, '行首尾空白 trim 后仍认')
// 缺右方括号时 t.lastIndexOf(']') === -1，slice(1, -1) 退化成「砍掉最后一个字符」，
// 于是引号不闭合、attr 什么都取不到 —— 记录仍出一条、字段全空串。这条钉的是**具体实现事实**，
// 改成「整行丢弃」或「抛异常」都会红，那正是将来重构这里时想要的刹车。
const noBracket = T.parseExtResources('[ext_resource type="Script"\n')
ok(noBracket.length === 1 && noBracket[0].type === '',
  '缺右方括号的畸形行仍出一条记录、字段空串，不抛（怎么报是调用方的事）', JSON.stringify(noBracket[0]))
const crlf = T.parseExtResources('[ext_resource path="res://a"]\r\n[ext_resource path="res://b"]\r\n')
ok(crlf.length === 2 && crlf[1].path === 'res://b', 'CRLF 行尾照常切分', JSON.stringify(crlf))
// 有区分度的跨行夹具：path 在**下一行**。逐行判定 → 这一条记录的 path 是空串；
// 谁将来把它改成跨行匹配，path 就会变成 res://b，这条立刻红。
const xline = T.parseExtResources('[ext_resource type="X"\npath="res://b"]\n')
ok(xline.length === 1 && xline[0].path !== 'res://b',
  '不跨行：换行后的 path 不会拼进当前引用', JSON.stringify(xline[0]))
for (const [v, label] of [[undefined, 'undefined'], [null, 'null'], ['', '空串'], [123, '数字']]) {
  ok(Array.isArray(T.parseExtResources(v)) && T.parseExtResources(v).length === 0,
    `${label} 入参给空数组（红线：纯函数不抛）`, JSON.stringify(T.parseExtResources(v)))
}

section('4. resToRel：归一规则必须与生产闸 resolveRel(inspectfs.js:40) 同形')
ok(T.resToRel('res://a/b.png') === 'a/b.png', '基本形去掉 res://')
ok(T.resToRel('res://a\\b.png') === 'a/b.png', '反斜杠归成正斜杠（原语给的 rel 只会是正斜杠）')
ok(T.resToRel('res://./a') === 'a', '吃掉 `.` 段')
ok(T.resToRel('res://a//b') === 'a/b', '吃掉空段')
ok(T.resToRel('res://a/../b') === null, '`..` 越界判 null —— 与 resolveRel 同规则')
ok(T.resToRel('res://') === null, '裸 res:// 判 null（栈为空）')
ok(T.resToRel('res://C:/x') === null, '带盘符判 null（树 rel 恒无盘符）')
ok(T.resToRel('user://save/x') === null, 'user:// 是运行时可写目录，不在项目树里，不解析')
ok(T.resToRel('./a.png') === null, '非 res:// 开头判 null')
ok(T.resToRel('') === null, '空串判 null')
ok(T.resToRel(undefined) === null && T.resToRel(42) === null, '非字符串不抛')
ok(T.resToRel('res://my scene.tscn') === 'my scene.tscn', '路径含空格是合法的，不许当畸形拦掉')
// 下面两条钉的是「resToRel 忠实得可怕」这个已知事实 —— 它是 resPathShapeOk 存在的理由，不是 bug。
ok(T.resToRel('res://a.gd ') === 'a.gd ', '尾巴空格照原样归出来（不 trim）：所以才需要形状闸')
ok(T.resToRel('res://a.gd,') === 'a.gd,', '尾逗号照原样归出来：那串在归一过的树里永远查不到')

section('5. countSteps：引擎不变式 load_steps = ext + sub + 1')
const c1 = T.countSteps('[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://a.gd" id="1"]\n')
ok(c1.declared === 2 && c1.actual === 1 && c1.expected === 2, '1 个 ext → expected=2，与声明相等', JSON.stringify(c1))
const c2 = T.countSteps([
  '[gd_scene load_steps=9 format=3]',
  '[ext_resource path="res://a"]',
  '[sub_resource type="X"]',
  '[sub_resource type="Y"]',
  '[node name="A" type="Node"]',
  '[node name="B" type="Node"]',
].join('\n'))
ok(c2.actual === 3, 'ext + sub 一起数；[node] 段不计入（旧 tools.test.mjs:300 钉的口径）', c2.actual)
ok(c2.expected === 4 && c2.declared === 9, 'expected = actual + 1；declared 读头部', JSON.stringify(c2))
ok(c2.declared !== c2.actual && c2.declared !== c2.expected, 'declared 与两者都不等 → 这才是「不符」样本')
// 头号误报形态：拿 actual 和 load_steps 直接比，对每一个真场景都恰好差 1。
ok(c1.actual !== c1.declared && c1.expected === c1.declared,
  '一个正确的场景：比 actual 会误报「不符」，比 expected 才通过 —— 判据必须比 expected')
const c3 = T.countSteps('[gd_scene format=3]\n[ext_resource path="res://a"]\n')
ok(c3.declared === 0 && c3.actual === 1 && c3.expected === 2,
  '缺 load_steps → declared 给 0，不是臆造成 1；调用方须先判 declared > 0 再比', JSON.stringify(c3))
const c4 = T.countSteps('')
ok(c4.declared === 0 && c4.actual === 0 && c4.expected === 1, '空文本：expected 仍是 1（资源自身）')
for (const [v, label] of [[undefined, 'undefined'], [null, 'null'], [7, '数字']]) {
  const c = T.countSteps(v)
  ok(c && c.declared === 0 && c.actual === 0 && c.expected === 1, `${label} 入参不抛，给同一形状`)
}

section('6. resPathShapeOk：只管首尾，不管前缀与内部')
ok(T.resPathShapeOk('res://a.gd') === true, '干净形过闸')
ok(T.resPathShapeOk('res://my scene.tscn') === true, '内部空格合法，不拦')
ok(T.resPathShapeOk('res://a.gd ') === false, '尾巴空格拦下')
ok(T.resPathShapeOk(' res://a.gd') === false, '头部空格拦下')
for (const ch of [',', ';', ')', ']']) {
  ok(T.resPathShapeOk(`res://a.gd${ch}`) === false, `尾巴 ${ch} 拦下（孪生解析器会剥尾逗号 → 真实形态）`)
}
ok(T.resPathShapeOk('res://a.gd, ') === false, '尾逗号带空格也拦得住')
ok(T.resPathShapeOk('a.gd') === true,
  '本闸不判 res:// 前缀（那是 resToRel 的事）：两条闸各管一段，不许在这儿重复判前缀')
ok(T.resPathShapeOk('') === false, '空串 false')
for (const [v, label] of [[undefined, 'undefined'], [null, 'null'], [42, '数字']]) {
  ok(T.resPathShapeOk(v) === false, `${label} 入参给 false 且不抛（方向是少报）`)
}

console.log(`\n${'='.repeat(56)}\nPASS ${pass}  FAIL ${failures.length}`)
if (failures.length) {
  console.log('失败项:')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log('全部通过')
