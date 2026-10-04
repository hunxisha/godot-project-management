// 工具页 P1/M-P1a:GDScript 顶层声明抽取(src/tools/parsers/gdSymbols.ts)的断言。
//
// 为什么单开一个文件:gdScript.test.mjs 钉的是**格式级**扫描(换行符、缩进、多行字符串),
// 这里钉的是**声明级**语义(class_name / extends)。两层共用不上夹具 —— 那边喂的是排版形态,
// 这边喂的是「这一行到底是不是顶格声明」。
//
// 设计口径见 docs/tools-page-plan.md P1-4 #12:
//   · 只认顶格(indent === '')的声明 —— 缩进位置上的 extends 是成员/参数,不是继承声明;
//   · 一律吃 classifyLines 的 code 字段(已剥行尾注释,inString 行为空串),
//     本解析器**不再引第二份字符串状态机**(债 8 的红线)。
//
// 用法(npm script 会先跑打包步骤):
//   node src/composables/__tests__/build-bundle.mjs && node src/tools/__tests__/gdSymbols.test.mjs
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

/** 缺函数时把整节标红而不是抛错 —— 抛错的输出看不出「缺的是哪个能力」 */
const HAS = typeof T.scanGdDecls === 'function'
ok(HAS, 'scanGdDecls 已在打包产物里导出')
if (!HAS) {
  console.log('\n实现尚未落地,后续断言无法执行(这就是 RED 那一步)。')
  console.log(`\n${'='.repeat(56)}\nPASS ${pass}  FAIL ${failures.length}`)
  process.exit(1)
}

section('1. 顶格声明:class_name / extends 各自成条')
{
  const d = T.scanGdDecls(['extends Node', '', 'func _ready() -> void:', '\tpass'].join('\n'))
  ok(d.className === '' && d.base === 'Node', '只有 extends 的文件:base=Node,className 空', JSON.stringify(d))
  ok(d.baseLine === 1, 'extends 行号给 1(不是 0)', d.baseLine)

  const c = T.scanGdDecls(['class_name MyEffect', 'extends EffectBase', '', 'var power := 1'].join('\n'))
  ok(c.className === 'MyEffect' && c.base === 'EffectBase', '两条顶格声明都抽到', JSON.stringify(c))
  ok(c.classNameLine === 1 && c.baseLine === 2, '行号按文件实际行号给', [c.classNameLine, c.baseLine])
}

section('2. 空文本与无声明文本给全空,不臆造')
{
  for (const [text, label] of [['', '空字符串'], ['\n\n', '只有换行'], ['# 纯注释文件\n', '只有注释']]) {
    const d = T.scanGdDecls(text)
    ok(d.className === '' && d.base === '' && d.classNameLine === 0 && d.baseLine === 0,
      `${label}:四个字段一律空/0`, JSON.stringify(d))
  }
}

section('3. 缩进位置的 extends 不算继承声明')
{
  // GDScript 的 class 关键字也允许写在缩进里(内部类、或函数体内的字符串拼接残留)。
  // 判据必须是「顶格」:把缩进的当声明,#12 会把「函数里定义的内部类」报成全局 class 重复。
  const d = T.scanGdDecls(['extends Node', '', 'func f():', '\tclass_name Inner', '\textends RefCounted'].join('\n'))
  ok(d.className === '', '缩进的 class_name 不抽', d.className)
  ok(d.base === 'Node', '缩进的 extends 不覆盖顶格那条', d.base)
}

section('4. 注释里的声明不算声明')
{
  const d = T.scanGdDecls(['# class_name NotReal  (旧写法,已注释掉)', '# extends Node', '', 'class_name Real', 'extends Node2D'].join('\n'))
  ok(d.className === 'Real', '整行注释里的 class_name 不抽', d.className)
  ok(d.base === 'Node2D', '整行注释里的 extends 不抽', d.base)

  const t = T.scanGdDecls(['class_name Real # 后面这条注释写 extends Node 不算', 'extends Node2D'].join('\n'))
  ok(t.className === 'Real', '行尾注释剥掉后值不带尾巴', JSON.stringify(t.className))
  ok(t.base === 'Node2D', '行尾注释里的 extends 不抢值', t.base)
}

section('5. 同一行组合声明:`class_name Foo extends Bar`')
{
  // 这是合法写法,不是笔误。命中一条就 continue 的实现会抽出 className 而漏掉 base,
  // #12 于是把「有基类的全局类」当无继承声明处理 —— 第二轮补这条就是为了钉住它。
  const d = T.scanGdDecls('class_name Foo extends Bar\n')
  ok(d.className === 'Foo' && d.base === 'Bar', '两条都在同一行时也各自成条', JSON.stringify(d))
  ok(d.classNameLine === 1 && d.baseLine === 1, '行号同为 1', [d.classNameLine, d.baseLine])
}

section('6. extends "res://base.gd" 的路径形态')
{
  // GDScript 允许按路径继承(不常见但合法)。裸标识符正则吞不下引号,
  // 若把它当 base='"res://base.gd"' 交出去,#12 的「基类不存在」会必报一条假 error。
  const p = T.scanGdDecls('extends "res://skill/base_skill.gd"\n')
  ok(p.base === '' && p.basePath === 'res://skill/base_skill.gd', '路径形态进 basePath,不污染 base', JSON.stringify(p))
  ok(p.basePathLine === 1, '路径形态也给行号', p.basePathLine)

  const q = T.scanGdDecls("extends 'res://a/b.gd'\n")
  ok(q.basePath === 'res://a/b.gd', '单引号串同样认(两种引号都合法)', JSON.stringify(q.basePath))

  const bad = T.scanGdDecls('extends 42\n')
  ok(bad.base === '' && bad.basePath === '', '既不是标识符也不是串:什么都不抽,不臆造', JSON.stringify(bad))
}

section('7. 多行字符串块内的声明形态不算声明')
{
  const text = ['class_name Real', 'extends Node', 'const DOC = """', 'class_name Fake', 'extends Fake', '"""'].join('\n')
  const d = T.scanGdDecls(text)
  ok(d.className === 'Real' && d.base === 'Node', '块内行(inString)一律跳过', JSON.stringify(d))
  ok(d.suspect === false, '闭合的块不算可疑', d.suspect)
}

section('8. 文本可疑时给 suspect,交调用方降级')
{
  // 未闭合引号之后 classifyLines 已经无法判断行列界(gdScript.ts:106 unterminated)。
  // #12 遇到 suspect 必须**整文件不判**并计入 skipped —— 宁漏不误(与债 6/债 7 同方向)。
  const u = T.scanGdDecls('class_name Real\nconst S = "未闭合\n')
  ok(u.suspect === true, '未闭合引号 → suspect=true', JSON.stringify(u))

  const clean = T.scanGdDecls('class_name Real\nextends Node\n')
  ok(clean.suspect === false, '正常文本 suspect=false', JSON.stringify(clean))

  const none = T.scanGdDecls(undefined)
  ok(none.className === '' && none.suspect === false, '非字符串入参给全空而不抛错(红线:纯函数不抛)', JSON.stringify(none))
}

console.log(`\n${'='.repeat(56)}\nPASS ${pass}  FAIL ${failures.length}`)
if (failures.length) {
  console.log('失败项:')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log('全部通过')
