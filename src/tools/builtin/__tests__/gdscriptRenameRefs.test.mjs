// GDScript 批量重命名 · 引用改写(refs.ts)的断言(§G Task 17)。
//
// 这一份守的是本批最贵的一件事:**改的是用户文件里的字节**。
// 所以判据方向与 `refIndex.ts` 相反(§G DEV-22):那边「一句提及即引用」连注释都算,是为了
// 孤儿工具少摆删除按钮;这边多改一处就是动了不该动的东西 —— 于是每一节都在钉「什么情况下**不许**改」。
//
// 四条反复用到的判据:
//   · 引号内文**整串等于**旧路径才改(前缀超集、尾巴标点、内部混了别的东西 ⇒ 都不改);
//   · `.gd` 的多行字符串与注释区一个字不改(A-11 那条分档的下游:同一条分类器,同一个方向);
//   · `hits` 与产出同一循环(A-22 那句「N 处断链」用的就是它,两套计数一定会漂);
//   · 换行符逐行保住(CRLF 项目改完还是 CRLF,不许被 split/join 抹平)。
//
// 用法:node src/composables/__tests__/build-bundle.mjs && node src/tools/builtin/__tests__/gdscriptRenameRefs.test.mjs
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../../../..')
const BUNDLE = path.resolve(ROOT, '.gpm-test/out/tkrefs.mjs')

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

/** 造表 + 改一遍的常用组合(表用 pairs 写,贴近插件那边的真实入参) */
function RW(kind, text, pairs) {
  let r
  try {
    r = T.rewriteRefs(kind, text, T.buildRenameMap(Array.isArray(pairs) ? pairs : []))
  } catch (e) {
    return { out: null, hits: -1, lines: [], threw: String(e && e.message) }
  }
  return F(r)
}
const MAP = (pairs) => T.buildRenameMap(pairs)

// ---------------------------------------------------------------- 0. 导出面
section('0. 导出面')
{
  for (const n of ['resPath', 'buildRenameMap', 'kindOfReferrer', 'rewriteRefs', 'unreadableReason']) {
    ok(typeof T[n] === 'function', `${n} 是函数`)
  }
}

// ---------------------------------------------------------------- 1. resPath
section('1. resPath:表里的键与值都要和文件里写的形态一致')
{
  ok(T.resPath('player/gamer.gd') === 'res://player/gamer.gd', '普通 rel 加前缀')
  ok(T.resPath('a\\b.gd') === 'res://a/b.gd', '反斜杠归正斜杠(宿主给的是正斜杠,作者会手写反斜杠)')
  ok(T.resPath('/a.gd') === 'res://a.gd', '开头的斜杠吃掉(rel 永远不带前导斜杠)')
  ok(T.resPath('') === '', '空串 ⇒ 空串')
  ok(T.resPath('../x.gd') === '', '含 .. ⇒ 空串(不进表)')
  ok(T.resPath(undefined) === '', '非字符串 ⇒ 空串,不抛')
  ok(T.resPath(42) === '', '数字 ⇒ 空串')
}

// ---------------------------------------------------------------- 2. buildRenameMap
section('2. buildRenameMap:三种脏输入挡在组表阶段')
{
  const m = MAP([{ from: 'a.gd', to: 'b.gd' }])
  ok(m instanceof Map && m.get('res://a.gd') === 'res://b.gd', '正常一对(键值都带 res://)')
  ok(MAP([{ from: 'a.gd' }]).size === 0, '缺 to ⇒ 不收(收了就会把别处改成 res://undefined)')
  ok(MAP([{ from: 'a.gd', to: 'a.gd' }]).size === 0, '前后同名 ⇒ 不收(那是空操作,却会让 hits 虚增)')
  ok(MAP('nope').size === 0, '入参不是数组 ⇒ 空表,不抛')
  ok(MAP([null, 42, 'x', {}]).size === 0, '数组里塞非对象 ⇒ 逐条跳过')
  const dup = MAP([{ from: 'a.gd', to: 'b.gd' }, { from: 'a.gd', to: 'c.gd' }])
  ok(dup.get('res://a.gd') === 'res://b.gd', '同一旧名给两个新名 ⇒ 先给的赢(与 buildPlan「只留第一条」同方向,不发明第三种)')
}

// ---------------------------------------------------------------- 3. kindOfReferrer
section('3. kindOfReferrer:决定「哪一套改法」的那一分岔')
{
  ok(T.kindOfReferrer('project.godot') === 'ini', '根级 project.godot ⇒ ini')
  ok(T.kindOfReferrer('export_presets.cfg') === 'ini', '根级 .cfg ⇒ ini(导出预设里也写 main_scene)')
  ok(T.kindOfReferrer('addons/x/plugin.cfg') === 'literal', '子目录里的 .cfg 不当 ini 处理(段式语法相同但语义是插件清单)')
  ok(T.kindOfReferrer('a/b.tscn') === 'scene', '.tscn ⇒ scene')
  ok(T.kindOfReferrer('a/b.TRES') === 'scene', '扩展名大小写不敏感')
  ok(T.kindOfReferrer('a\\b.gd') === 'gd', '反斜杠的 .gd 也认成 gd')
  ok(T.kindOfReferrer('data/keep.json') === 'literal', '.json ⇒ literal')
  ok(T.kindOfReferrer('Player.cs') === 'literal', '.cs ⇒ literal(只认双引号)')
  ok(T.kindOfReferrer(undefined) === 'literal', '非字符串 ⇒ literal,不抛')
}

// ---------------------------------------------------------------- 4. scene 面
section('4. .tscn / .tres:改 path,不动 uid/type/id')
{
  const src = '[gd_scene load_steps=2 format=3 uid="uid://scene1"]\n\n[ext_resource type="Script" uid="uid://abc123" path="res://player.gd" id="1_x"]\n\n[node name="Main" type="Node2D"]\nscript = ExtResource("1_x")\ndata = "res://player.gd"\n'
  const r = RW('scene', src, [{ from: 'player.gd', to: 'hero.gd' }])
  ok(S(r.out).includes('path="res://hero.gd"'), 'ext_resource 的 path 改到新名', r.out)
  ok(S(r.out).includes('uid="uid://abc123"'), '同一行的 uid 一个字不改(DEV-26:改了就是自断)')
  ok(S(r.out).includes('type="Script"') && S(r.out).includes('id="1_x"'), 'type / id 不动')
  ok(S(r.out).includes('[gd_scene load_steps=2 format=3 uid="uid://scene1"]'), '头部自己那条 uid 不动(那是所有权声明)')
  ok(S(r.out).includes('data = "res://hero.gd"'), '[node] 段的字符串路径同样算引用')
  ok(N(r.hits) === 2, '两处:ext_resource 一行 + node 一行(计数与产出同一循环)', r.hits)
  ok(FA(r.lines).join(',') === '3,7', '命中行号升序去重(预览要能说「第 3、7 行」)', r.lines)

  const sup = RW('scene', 'path="res://player.gd.bak"\n', [{ from: 'player.gd', to: 'hero.gd' }])
  ok(sup.out === 'path="res://player.gd.bak"\n' && N(sup.hits) === 0, '值只是前缀超集 ⇒ 不改(那是另一个文件的名字)')
  const tail = RW('scene', 'path="res://player.gd,"\n', [{ from: 'player.gd', to: 'hero.gd' }])
  ok(N(tail.hits) === 0, '值尾巴带逗号 ⇒ 不改(refIndex 那一侧会收进 shapeSkipped,改的一侧只能少)')
  const space = RW('scene', 'path="res://my scene.tscn"\n', [{ from: 'my scene.tscn', to: 'main.tscn' }])
  ok(N(space.hits) === 1 && S(space.out).includes('path="res://main.tscn"'), '路径里有空格也照改(Godot 允许,不许当成「混了别的东西」)')
  const empty = RW('scene', 'path="res://player.gd"\n', [])
  ok(N(empty.hits) === 0 && empty.out === 'path="res://player.gd"\n', '空表 ⇒ 原样交回')
  const crlf = RW('scene', 'a = "res://x.gd"\r\nb = 2\r\n', [{ from: 'x.gd', to: 'y.gd' }])
  ok(S(crlf.out).includes('res://y.gd"\r\nb = 2\r\n'), 'CRLF 项目改完还是 CRLF(逐行带终止符重组,不 split/join)')
  const noeol = RW('scene', 'a = "res://x.gd"', [{ from: 'x.gd', to: 'y.gd' }])
  ok(S(noeol.out) === 'a = "res://y.gd"' && !S(noeol.out).endsWith('\n'), '文件末尾本来没换行 ⇒ 不补(那是格式化工具的活)')
  const bslash = RW('scene', 'a = "res://q\\"x.gd"\n', [{ from: 'q\\"x.gd', to: 'ok.gd' }])
  ok(N(bslash.hits) === 0,
    '反斜杠永远进不了表(resPath 把它归成正斜杠)⇒ 这一处不改。scanQuotes 认转义只是防「配对错位」的防御读取,不许当成有断言覆盖的行为来报', bslash.out)
  const same2 = RW('scene', 'a = ["res://x.gd", "res://x.gd"]\n', [{ from: 'x.gd', to: 'y.gd' }])
  ok(N(same2.hits) === 2 && FA(same2.lines).join(',') === '1', '同一行两处 ⇒ hits 记两笔、行号只记一次(预览那句是「第 1 行 2 处」)', same2)
  const mixed = RW('scene', 'a = "res://other.gd"\nb = "res://x.gd"\n', [{ from: 'x.gd', to: 'y.gd' }])
  ok(N(mixed.hits) === 1, 'hits 只数**真改掉的**那一处,不是「扫到几个字面量」(两套计数一定会漂)', mixed)
  const unq = RW('scene', 'a = "res://x.gd\nb = 2\n', [{ from: 'x.gd', to: 'y.gd' }])
  ok(N(unq.hits) === 0 && unq.out === 'a = "res://x.gd\nb = 2\n',
    '引号不配对 ⇒ 这一行不改(半截字符串猜出来的替换会把整个文件写废;方向与 godotIni 的 scanLiterals 一致)')
  const idem = RW('scene', S(r.out), [{ from: 'player.gd', to: 'hero.gd' }])
  ok(N(idem.hits) === 0, '幂等:改完再来一遍一处都不改')
}

// ---------------------------------------------------------------- 5. gd 面
section('5. .gd:只改代码区,多行字符串与注释一个字不动(DEV-22 的头号靶子)')
{
  const src = 'var a = preload("res://player.gd")\nvar b = load(\'res://player.gd\')\nvar s = """\n他说 "res://player.gd" 是旧的\n"""\n# 旧写法是 "res://player.gd"\nvar c = 1  # 见 "res://player.gd"\nvar d = "#res://player.gd"\n'
  const r = RW('gd', src, [{ from: 'player.gd', to: 'hero.gd' }])
  ok(S(r.out).includes('preload("res://hero.gd")'), '代码区的双引号字面量改了')
  ok(S(r.out).includes('load(\'res://hero.gd\')'), '单引号也改(gdSymbols.ts:38-39 已核实 GDScript 两种都收)')
  ok(S(r.out).includes('var s = """\n他说 "res://player.gd" 是旧的\n"""'),
    '多行字符串里那行**带引号也要原样不动**(它是内容不是引用;夹具必须真带一对引号,否则「拿掉冻结」这种改动测不出来)')
  ok(S(r.out).includes('# 旧写法是 "res://player.gd"'), '整行注释不动(改了等于动用户写的说明)')
  ok(S(r.out).includes('var c = 1  # 见 "res://player.gd"'), '行尾注释区不动(# 之后不算代码,哪怕那段里有一对引号)')
  ok(S(r.out).includes('"#res://player.gd"'), '引号内的 # 不当注释起点(路径可以含 #)')
  ok(N(r.hits) === 2, '只有两处:两个 preload/load(注释与多行串里那三对引号都不计)', r.hits)

  const unterm = RW('gd', 'var x = "res://player.gd\nvar y = 2\n', [{ from: 'player.gd', to: 'hero.gd' }])
  ok(N(unterm.hits) === 0 && unterm.out === 'var x = "res://player.gd\nvar y = 2\n', '引号不配对 ⇒ 整处不改(半截字符串猜出来的替换会把文件写废)')
  const cont = RW('gd', 'var arr = [\n\t"res://player.gd",\n]\n', [{ from: 'player.gd', to: 'hero.gd' }])
  ok(N(cont.hits) === 1 && S(cont.out).includes('\t"res://hero.gd",'), '续行(括号没闭合)里的字面量照样改,缩进保住')
  const hashLine = RW('gd', 'var x = "#" \nvar y = "res://player.gd" \n', [{ from: 'player.gd', to: 'hero.gd' }])
  ok(N(hashLine.hits) === 1 && S(hashLine.out).includes('var x = "#"'), '第一行那个 # 在引号里,不截断代码区(第二行照改)')
  const crlfGd = RW('gd', 'var a = "res://x.gd"\r\nvar b = 1\r\n', [{ from: 'x.gd', to: 'y.gd' }])
  ok(S(crlfGd.out) === 'var a = "res://y.gd"\r\nvar b = 1\r\n', '.gd 的 CRLF 也用 scanGdScript 的 term 逐行还原')
}

// ---------------------------------------------------------------- 6. ini 面
section('6. project.godot / export_presets.cfg:引号形与裸值形都改,A-23 落在这里')
{
  const q = RW('ini', '[application]\nrun/main_scene="res://main.tscn"\n', [{ from: 'main.tscn', to: 'menu.tscn' }])
  ok(S(q.out).includes('run/main_scene="res://menu.tscn"'), '带引号的值改了(编辑器写盘的形态)', q.out)
  const bare = RW('ini', '[application]\nrun/main_scene=res://main.tscn\n', [{ from: 'main.tscn', to: 'menu.tscn' }])
  ok(S(bare.out).includes('run/main_scene=res://menu.tscn'), '裸值也改(编辑器外手改与合并冲突后手补就是这种)', bare.out)
  const star = RW('ini', '[autoload]\nAuto="*res://autoload/x.gd"\n', [{ from: 'autoload/x.gd', to: 'autoload/y.gd' }])
  ok(S(star.out).includes('Auto="*res://autoload/y.gd"'), 'autoload 的 * 前缀保住(它是「启用单例」标记,不是路径的一部分)', star.out)
  const space = RW('ini', 'run/main_scene =  res://main.tscn  \n', [{ from: 'main.tscn', to: 'menu.tscn' }])
  ok(S(space.out) === 'run/main_scene =  res://menu.tscn  \n', '等号两侧的空格与行尾空白原样保留', space.out)
  const semi = RW('ini', '; 以前这里是 run/main_scene="res://main.tscn"\nrun/main_scene="res://main.tscn"\n', [{ from: 'main.tscn', to: 'menu.tscn' }])
  ok(S(semi.out).startsWith('; 以前这里是 run/main_scene="res://main.tscn"\n'), '; 注释行不改(那一行里带引号的路径也不算配置)')
  ok(N(semi.hits) === 1, '注释那一处不计进 hits(改了它也不会多一处真引用)', semi.hits)
  const tailPunct = RW('ini', 'run/main_scene=res://main.tscn,\n', [{ from: 'main.tscn', to: 'menu.tscn' }])
  ok(N(tailPunct.hits) === 0, '值尾巴带逗号 ⇒ 不改(那已经不是「整串等于」)')
  const arr = RW('ini', 'include=["res://a.png", "res://b.png"]\n', [{ from: 'a.png', to: 'c.png' }, { from: 'b.png', to: 'd.png' }])
  ok(S(arr.out) === 'include=["res://c.png", "res://d.png"]\n' && N(arr.hits) === 2, '一行里两处各改各的', arr.out)
  const noeq = RW('ini', '[rendering]\n', [{ from: 'main.tscn', to: 'menu.tscn' }])
  ok(N(noeq.hits) === 0, '没有 = 的行不动')
  const multi = RW('ini', 'x=["res://a.tscn",\n"res://b.tscn"]\n', [{ from: 'b.tscn', to: 'c.tscn' }])
  ok(N(multi.hits) === 1 && S(multi.out).includes('"res://c.tscn"]'), '括号块跨行时,第二行里的字面量照样改(逐行走引号规则,不按整值)')
}

// ---------------------------------------------------------------- 7. literal 面
section('7. 其余面(.json / .cs / .gdshader):只认双引号整串')
{
  const j = RW('literal', '{"scene": "res://main.tscn", "note": "res://main.tscn 后面还有字"}\n', [{ from: 'main.tscn', to: 'menu.tscn' }])
  ok(N(j.hits) === 1 && S(j.out).includes('"scene": "res://menu.tscn"'), '整串等于才改,混了别的文字那条不动', j.out)
  const cs = RW('literal', 'var p = "res://main.tscn";\nvar c = \'r\';\n', [{ from: 'main.tscn', to: 'menu.tscn' }, { from: 'r', to: 'z' }])
  ok(N(cs.hits) === 1 && S(cs.out).includes('"res://menu.tscn"'), 'C# 只认双引号(单引号是 char 字面量,不是路径)', cs.out)
  const sh = RW('literal', 'uniform sampler2D tex;\n// res://a.png\np = "res://a.png"\n', [{ from: 'a.png', to: 'b.png' }])
  ok(N(sh.hits) === 1 && S(sh.out).includes('// res://a.png') && S(sh.out).includes('p = "res://b.png"'),
    '非 .gd 面不做注释识别,但规则只认引号内文 ⇒ 注释里的裸路径天然不改(要改的那条在引号里)', sh.out)
  const csCmt = RW('literal', '// see "res://a.png" inside a comment\n', [{ from: 'a.png', to: 'b.png' }])
  ok(N(csCmt.hits) === 1, '已知的一处宽松:注释里正好写了成对引号包住的路径会跟着改 —— Godot 不看注释,改了无害;严格挡住要判错语言的注释语法,风险更大(记在 §G-3)')
}

// ---------------------------------------------------------------- 8. 一次过、不链式
section('8. 一轮里多条改名一次过:A→B 与 B→C 不许把同一段吃两次')
{
  const src = 'a = "res://a.gd"\nb = "res://b.gd"\n'
  const r = RW('scene', src, [{ from: 'a.gd', to: 'b.gd' }, { from: 'b.gd', to: 'c.gd' }])
  ok(S(r.out).includes('a = "res://b.gd"'), '第一行按表变成 b(没有被 B→C 再吃一次)', r.out)
  ok(S(r.out).includes('b = "res://c.gd"'), '第二行变成 c')
  ok(N(r.hits) === 2, '两处各一次,没有链式重复替换', r.hits)
  ok(S(r.out).indexOf('c.gd"') === S(r.out).lastIndexOf('c.gd"'), '输出里不出现「a 一路跑到 c」的那种连锁')
}

// ---------------------------------------------------------------- 9. 计数与产出同源
section('9. hits 与产出同一循环(A-22 那句红字的 N 就靠它)')
{
  const src = 'x = "res://a.gd"\ny = "res://a.gd"\nz = "res://b.gd"\n'
  const r = RW('scene', src, [{ from: 'a.gd', to: 'c.gd' }, { from: 'b.gd', to: 'c.gd' }])
  const inOut = (S(r.out).match(/c\.gd/g) || []).length
  ok(N(r.hits) === 3 && inOut === 3, 'hits 与「新名字在产出里出现的次数」一致(两处计数会漂,同一循环不会)', { hits: r.hits, inOut })
  ok(FA(r.lines).join(',') === '1,2,3', '三条都记了行号')
}

// ---------------------------------------------------------------- 10. 不抛红线
section('10. 脏入参一律原样交回,不抛')
{
  for (const bad of [undefined, null, 42, {}, []]) {
    const r = RW('scene', bad, [{ from: 'a.gd', to: 'b.gd' }])
    ok(r.threw === undefined && N(r.hits) === 0, `text 是 ${JSON.stringify(bad) ?? String(bad)} ⇒ 不抛、hits 0`, r)
  }
  for (const kind of ['nope', undefined, 42]) {
    let r
    try { r = F(T.rewriteRefs(kind, 'a = "res://a.gd"', MAP([{ from: 'a.gd', to: 'b.gd' }]))) } catch (e) { r = { threw: String(e) } }
    ok(r.threw === undefined, `kind 是 ${JSON.stringify(kind) ?? String(kind)} ⇒ 走兜底面,不抛`, r)
  }
  let m
  try { m = F(T.rewriteRefs('scene', 'a = "res://a.gd"', 'not-a-map')) } catch (e) { m = { threw: String(e) } }
  ok(m.threw === undefined && N(m.hits) === 0, 'map 不是 Map ⇒ 不改,不抛', m)
  const emptyText = RW('gd', '', [{ from: 'a.gd', to: 'b.gd' }])
  ok(emptyText.out === '' && N(emptyText.hits) === 0, '空文件不改')
}

// ---------------------------------------------------------------- 11. unreadableReason
section('11. unreadableReason:读不到的那几种说法')
{
  ok(T.unreadableReason({ error: '文件不存在' }) === '文件不存在', '有原话就用原话')
  ok(T.unreadableReason({ truncated: true }) === '超出读取上限,只拿到部分内容', '超限那一档')
  ok(T.unreadableReason({ skippedBinary: true }) === '被认成二进制', '二进制那一档')
  ok(T.unreadableReason({}) === '读不到正文', '什么都没给也要有句话')
  ok(T.unreadableReason(undefined) === '读不到正文', '整个对象缺失也不抛')
}

console.log(`\n${'='.repeat(56)}\nPASS ${pass}  FAIL ${failures.length}`)
if (failures.length) {
  console.log('失败项:')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log('全部通过')
