// 工具页 B9:GDScript 逐行状态扫描(src/tools/parsers/gdScript.ts)的断言。
//
// 这份分类器是 B9 唯一的「这一行能不能动」判据来源,而 B9 是 P0b 里唯一**改写用户源代码**的工具。
// 所以这里钉的是「哪些字节永远不许动」,不是「格式好不好看」:
//   · inString = 这一行与多行字符串(或与未闭合引号)有过任何接触 → 格式化整行不动;
//   · 未闭合引号的方向是**少动**:从那一行起,直到闭合引号出现为止的每一行都算 inString;
//   · continuation = 上一行以 `\` 结尾、或上一行结束时括号没闭合 → 这一行的前导空白不许转换;
//   · 括号配对认不出(凭空多出一个闭括号)→ suspect 一旦置起,后面每一行都按 continuation 处理(单向,不解除)。
// 不认识的构造一律落进上面三条里最保守的那一侧,所以「分类器看不懂」的后果只会是少改,不会是改坏。
//
// 夹具全是**手写的 GDScript 文本**(不是本仓源码),逐行断言状态位。
// 用法(npm script 会先跑打包步骤):
//   node src/composables/__tests__/build-bundle.mjs && node src/tools/__tests__/gdScript.test.mjs
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

/** 逐行给正文,末尾补一个换行(真实 .gd 文件的常态) */
function L(...lines) { return lines.join('\n') + '\n' }
const classify = (text) => T.classifyLines(text)
/** 取第 n 行(1-based)的分类结果 */
function at(text, n) {
  const l = classify(text).find((x) => x.line === n)
  if (!l) throw new Error(`夹具只有 ${classify(text).length} 行,拿不到第 ${n} 行`)
  return l
}
/** 逐行状态串,用来把「一整段的行为」压成一条可比对的断言(S=inString C=整行注释 K=续行) */
function sig(text) {
  return classify(text).map((l) => `${l.inString ? 'S' : '-'}${l.isComment ? 'C' : '-'}${l.continuation ? 'K' : '-'}`).join(' ')
}
/** raw + term 必须能逐字节还原入参 —— 格式化就是靠这个不变量重建文本的 */
const rebuild = (text) => classify(text).map((l) => l.raw + l.term).join('')

// ---------- 1. 导出与记录形状 ----------
section('1. 导出与记录形状')
ok(typeof T.classifyLines === 'function', '判据 1:classifyLines 从 barrel 导出')
const shapeText = L('extends Node', '\tvar x = 1 # c', '', 'var s = """')
const shape = classify(shapeText)
ok(shape.length === 4, '形状:四行正文得四条记录(末尾换行不额外造空行)', String(shape.length))
ok(shape.every((l, i) => l.line === i + 1), '形状:line 是 1-based 连续行号', shape.map((l) => l.line).join(','))
ok(shape.every((l) => typeof l.inString === 'boolean' && typeof l.isComment === 'boolean' &&
    typeof l.continuation === 'boolean' && typeof l.indent === 'string' && typeof l.code === 'string' &&
    typeof l.raw === 'string' && typeof l.term === 'string' &&
    Number.isFinite(l.depth) && typeof l.suspect === 'boolean'),
  '形状:每条记录都带 inString/isComment/indent/code(+ raw/term/continuation/depth/suspect)')
ok(JSON.stringify(shape) === JSON.stringify(classify(shapeText)), '判据 9:同一份文本两次分类逐字段一致(纯函数)')

// ---------- 2. 普通代码行与前导缩进 ----------
section('2. 普通代码行:indent / code 的切法')
const t2 = L('extends Node', '\tvar x = 1', '    var y = 2', '', '\t\treturn')
ok(at(t2, 1).indent === '' && at(t2, 1).code === 'extends Node',
  '判据 1:零缩进行 indent 空串、code 是整行', `${JSON.stringify(at(t2, 1).indent)}|${at(t2, 1).code}`)
ok(at(t2, 2).indent === '\t' && at(t2, 2).code === 'var x = 1',
  '判据 1:tab 前导原样进 indent', JSON.stringify(at(t2, 2).indent))
ok(at(t2, 3).indent === '    ' && at(t2, 3).code === 'var y = 2',
  '判据 1:空格前导原样进 indent(不做宽度折算,那是 format.ts 的事)', JSON.stringify(at(t2, 3).indent))
ok(at(t2, 4).indent === '' && at(t2, 4).code === '' && at(t2, 4).isComment === false,
  '判据 1:空行 indent/code 都空、不算注释')
ok(at(t2, 5).indent === '\t\t' && at(t2, 5).code === 'return',
  '判据 1:两级 tab 缩进', JSON.stringify(at(t2, 5).indent))
ok(at(t2, 2).inString === false && at(t2, 2).isComment === false,
  '判据 1:普通代码行 inString/isComment 都 false')

// ---------- 3. 注释 ----------
section('3. 注释:整行 / 行尾 / 字符串里的 # / 注释里的引号')
const t3 = L(
  '# 整行注释',
  '  # 带缩进的注释',
  'var a = 1 # 行尾注释',
  'var s = "# 这不是注释"',
  "var t = 'a#b' # 尾注释",
  '# " 注释里的引号不开字符串',
  'var after = 1   '
)
ok(at(t3, 1).isComment === true && at(t3, 1).code === '',
  '判据 1:整行注释 isComment true、code 空')
ok(at(t3, 2).isComment === true && at(t3, 2).indent === '  ',
  '判据 1:带缩进的整行注释 indent 仍给出前导', JSON.stringify(at(t3, 2).indent))
ok(at(t3, 3).isComment === false && at(t3, 3).code === 'var a = 1',
  '判据 1:行尾注释切进 code 之外(尾注释不进 code)', at(t3, 3).code)
ok(at(t3, 4).isComment === false && at(t3, 4).code === 'var s = "# 这不是注释"',
  '★判据 1:字符串里的 # 不算注释', at(t3, 4).code)
ok(at(t3, 5).isComment === false && at(t3, 5).code === "var t = 'a#b'",
  '★判据 1:单引号里的 # 同样不算注释', at(t3, 5).code)
ok(at(t3, 6).isComment === true && at(t3, 6).inString === false,
  '★判据 1:注释里的引号不进入字符串状态', sig(t3))
ok(at(t3, 7).inString === false,
  '★判据 1:注释里的引号没留下跨行状态(下一行照常是普通代码)', sig(t3))
ok(at(t3, 7).raw === 'var after = 1   ' && at(t3, 7).code === 'var after = 1',
  '判据 1:raw 保留行尾空白(删不删是 format.ts 的决定)、code 右去空白',
  JSON.stringify(at(t3, 7).raw))
const t3b = L('# """ 三引号写在注释里不开块', 'var x = 1')
ok(at(t3b, 1).isComment === true && at(t3b, 1).inString === false && at(t3b, 2).inString === false,
  '★判据 1:注释里的 """ 不开多行字符串块', sig(t3b))

// ---------- 4. 短字符串:转义与未闭合 ----------
section('4. 短字符串:\\" 与 \\\\ 转义、未闭合引号的保守方向')
const t4 = L(
  'var a = "escaped \\" quote"',
  'var b = "backslash \\\\"',
  "var c = 'single \\' quote'",
  'var d = "unclosed'
)
ok(at(t4, 1).inString === false,
  '判据 1:\\" 是转义不是闭合(整行仍在代码态)', sig(t4))
ok(at(t4, 2).inString === false,
  '★判据 1:\\\\ 吃掉反斜杠本身,后面的 " 才是闭合引号', sig(t4))
ok(at(t4, 3).inString === false,
  '判据 1:单引号串同理', sig(t4))
ok(at(t4, 4).inString === true,
  '★判据 1:行尾未闭合引号 → 保守当作进入字符串', sig(t4))
const t5 = L('var s = "unclosed', 'next line   ', 'still open"', 'var after = 1')
ok(at(t5, 1).inString === true && at(t5, 2).inString === true && at(t5, 3).inString === true,
  '★判据 1:未闭合引号之后每一行都算 inString,直到闭合', sig(t5))
ok(at(t5, 4).inString === false,
  '★判据 1:闭合之后恢复正常', sig(t5))
ok(at(t5, 2).raw === 'next line   ',
  '判据 1:未闭合期间行尾空白仍在 raw 里(没被分类器顺手删掉)', JSON.stringify(at(t5, 2).raw))
const t6 = L('var s = "abc\\', 'def"', 'var x = 1')
ok(at(t6, 1).inString === true && at(t6, 2).inString === true && at(t6, 3).inString === false,
  '判据 1:字符串内的反斜杠续行(跨行)整段算字符串', sig(t6))
const t7 = L('var s = "a\\"')
ok(at(t7, 1).inString === true,
  '判据 1:\\' + '"' + ' 被当作转义 → 串没闭合 → 保守不动', at(t7, 1).code)

// ---------- 5. 三引号块 ----------
section('5. """ / \'\'\' 块:块内一行都不许动')
const t8 = L(
  'func f():',
  '\tvar doc = """',
  '\t\t块内一行   ',
  '',
  '\t"""',
  '\tvar after = 1   '
)
ok(at(t8, 2).inString === true, '★判据 1:块起始行算 inString(它的行尾空白是内容)', sig(t8))
ok(at(t8, 3).inString === true && at(t8, 3).raw === '\t\t块内一行   ',
  '★判据 1:块内行的缩进与行尾空白原样留在 raw 里', JSON.stringify(at(t8, 3).raw))
ok(at(t8, 4).inString === true && at(t8, 4).raw === '',
  '★判据 1:块内的空行也是内容(空行压缩不许碰)', sig(t8))
ok(at(t8, 5).inString === true, '★判据 1:块结束行同样整行不动', sig(t8))
ok(at(t8, 6).inString === false, '判据 1:块闭合后的下一行回到代码态', sig(t8))
ok(at(t8, 6).code === 'var after = 1', '判据 1:块后一行的 code 正常给出', at(t8, 6).code)
const t9 = L('var s = """abc"""', 'var after = 1')
ok(at(t9, 1).inString === true && at(t9, 2).inString === false,
  '判据 1:起止同行的块(单行块)也算动过字符串 → 整行不动', sig(t9))
const t10 = L("var s = '''", 'inside   ', "'''", 'var x = 1')
ok(sig(t10) === 'S-- S-- S-- ---', '判据 1:\'\'\' 块与 """ 同机制', sig(t10))
const t11 = L('var s = """', "''' 不是闭合", '""" 这才算', 'var x = 1')
ok(at(t11, 2).inString === true && at(t11, 3).inString === true && at(t11, 4).inString === false,
  '★判据 1:块内另一类引号不闭合块(必须匹配开块的那个)', sig(t11))
const t12 = L('var s = """a\\"""b"""', 'var x = 1')
ok(at(t12, 1).inString === true && at(t12, 2).inString === false,
  '判据 1:块内 \\" 转义不算闭合,后面的 """ 才是块结束', sig(t12))
const t13 = L('var s = """', 'x = ((', '"""', 'var y = 1')
ok(at(t13, 3).depth === 0 && at(t13, 4).continuation === false,
  '★判据 1:块内的括号不计数(否则块后会一直误判成续行)', `${at(t13, 3).depth}|${sig(t13)}`)
const t14 = L('var s = """未闭合到文件尾', '还在水里')
ok(at(t14, 1).inString === true && at(t14, 2).inString === true,
  '判据 1:块没闭合 → 到文件尾每一行都 inString(方向是少动)', sig(t14))
// 带前缀的多行 raw 串(`r"""`):块**照样建模**。早先的版本「认不出就不建模」,结果整块内容被当成
// 代码行 —— 尾随空白、空行、缩进、换行符全是字符串的值(取证 R1)。
const t22 = L('var p = r"""', 'C:\\path\\to\\   ', '', "it's 里也有引号", '"""', 'var x = 1   ')
ok(at(t22, 1).inString === true && at(t22, 2).inString === true && at(t22, 3).inString === true &&
    at(t22, 4).inString === true && at(t22, 5).inString === true && at(t22, 6).inString === false,
  '★判据 1:r""" 块内的每一行(空行、另一个引号种类)都算内容,闭合后恢复', sig(t22))
ok(T.scanGdScript(t22).unterminated === false, '判据 1:带前缀的块闭合了 → 不当成未闭合', sig(t22))
const t23 = L("var p = r'''", 'raw 单引号块   ', "'''", 'var x = 1')
ok(sig(t23) === 'S-- S-- S-- ---', '判据 1:带 r 前缀的单引号块与三双引号块同机制', sig(t23))
const t24 = L('var re = r"\\d+\\s"', 'var x = 1   ')
ok(at(t24, 1).inString === true && at(t24, 2).inString === false,
  '判据 1:带前缀的**单行**串整行保守不动、但不留跨行状态(它本来就闭合在同一行)', sig(t24))

// ---------- 6. 续行与括号配对 ----------
section('6. 判据 4 的地基:\\ 续行、未闭合括号、suspect')
const t15 = L(
  'var x = 1 + 2',
  'var y = 2 \\',
  '\t\t+ 3',
  'var z = foo(',
  '\t\t"对齐的参数",',
  '\t)',
  'var w = 4'
)
ok(at(t15, 1).continuation === false, '判据 4:普通行不是续行', sig(t15))
ok(at(t15, 2).continuation === false,
  '判据 4:自己行尾的 \\ 不影响自己(只影响下一行)', sig(t15))
ok(at(t15, 3).continuation === true, '★判据 4:上一行以 \\ 结尾 → 这一行前导不许转换', sig(t15))
ok(at(t15, 4).continuation === false && at(t15, 4).depth === 1,
  '判据 4:未闭合 ( 让行尾 depth 记到 1', `${at(t15, 4).continuation}|${at(t15, 4).depth}`)
ok(at(t15, 5).continuation === true, '★判据 4:括号没闭合的行按续行处理(对齐缩进不动)', sig(t15))
ok(at(t15, 6).continuation === true,
  '★判据 4:闭括号那一行 itself 也还是续行(它本行的起始 depth 就是 1)', sig(t15))
ok(at(t15, 7).continuation === false && at(t15, 7).depth === 0,
  '判据 4:闭合之后恢复', `${at(t15, 7).continuation}|${at(t15, 7).depth}`)
const t16 = L('var d = {', '\t"a": 1', '}')
ok(sig(t16) === '--- --K --K', '判据 4:{ 与 } 同样算(} 那行也是续行态)', sig(t16))
const t17 = L('var l = [', '\t1,', '\t]', 'var ok = 1')
ok(sig(t17) === '--- --K --K ---', '判据 4:[ 同样算', sig(t17))
const t18 = L('var s = "((" ', 'var x = 1')
ok(at(t18, 1).depth === 0 && at(t18, 2).continuation === false,
  '判据 4:字符串里的括号不计数', `${at(t18, 1).depth}|${sig(t18)}`)
const t19 = L('# 注释里有 ) 和 ] 这两个多余闭括号', 'var x = 1')
ok(at(t19, 1).depth === 0 && at(t19, 1).suspect === false && at(t19, 2).continuation === false,
  '★判据 4:注释里的闭括号不触发 suspect(否则整文件缩进白丢)', sig(t19))
const t20 = L('var x = 1', ') 多出来的闭括号 = 认不出', '    var y = 2', '    var z = 3')
ok(at(t20, 2).suspect === true && at(t20, 2).depth === 0,
  '判据 1:凭空多出的闭括号 → depth 钳在 0 并置 suspect', `${at(t20, 2).depth}|${at(t20, 2).suspect}`)
ok(at(t20, 3).continuation === true && at(t20, 4).continuation === true,
  '★判据 1:suspect 之后每一行都按续行走(单向,不解除)', sig(t20))
const t21 = L('func a():', '\tif x:', '\t\treturn 1', '\tvar y = 2   ')
ok(sig(t21) === '--- --- --- ---', '判据 1:GDScript 靠缩进不需要括号,普通函数体一条续行都不算', sig(t21))

// ---------- 7. 行切分与终止符 ----------
section('7. 行切分:raw / term 必须能逐字节还原原文')
const crlf = 'a\r\nb\r\nc'
ok(at(crlf, 1).raw === 'a' && at(crlf, 1).term === '\r\n',
  '判据 5:CRLF 拆成 term,raw 里不留 \\r', JSON.stringify(at(crlf, 1).raw))
ok(at(crlf, 3).term === '', '判据 5:末行没有换行 → term 空串', JSON.stringify(at(crlf, 3).term))
ok(rebuild(crlf) === crlf, '判据 5:CRLF 原文可逐字节还原', JSON.stringify(rebuild(crlf)))
ok(classify('a\n').length === 1 && at('a\n', 1).term === '\n',
  '判据 5:末尾换行不额外造出一个空行记录')
ok(classify('a\n\n').length === 2, '判据 5:a + 空行 得两条记录', String(classify('a\n\n').length))
ok(classify('').length === 0, '判据 5:空文本 → 零行(空文件无从改动)')
ok(classify('\n').length === 1 && at('\n', 1).raw === '',
  '判据 5:只有一个换行的文件 → 一行空正文')
ok(rebuild(L('var s = """块', '\t里面   ', '"""', '')) === L('var s = """块', '\t里面   ', '"""', ''),
  '判据 5:混合内容(块 + 尾随空白 + 尾空行)逐字节还原')
ok(rebuild('a\rb\nc\r\nd') === 'a\rb\nc\r\nd',
  '判据 5:正文中间的裸 \\r(老 Mac 残留)也逐字节还原', JSON.stringify(rebuild('a\rb\nc\r\nd')))
ok(at('a\rb\nc', 1).raw === 'a\rb' && at('a\rb\nc', 1).term === '\n',
  '判据 5:中间 \\r 留在 raw 里(交给 format.ts 判「这一行形态认不出」)')

// ---------- 8. 混合大夹具:整段状态串 ----------
section('8. 一段真实形状的脚本:逐行状态串')
const big = L(
  'extends Node',
  '# 顶部注释',
  '',
  '@export var speed := 1.0   ',
  '',
  '',
  '',
  'func _ready() -> void:',
  '\tprint("""多行',
  '\t\t字符串里的缩进   ',
  '\t""")',
  '\tvar q = "含 # 的串"',
  '\tvar r = ("未闭合的括号",',
  '\t\t对齐的一行',
  '\t)',
  '\treturn speed \\'
)
ok(sig(big) === '--- -C- --- --- --- --- --- --- S-- S-K S-K --- --- --K --K ---',
  '整段:注释/块/未闭合括号/续行的状态位一次看全', sig(big))
ok(at(big, 4).code === '@export var speed := 1.0' && at(big, 4).raw === '@export var speed := 1.0   ',
  '整段:行尾空白只在 raw 里保留,code 已右去空白', JSON.stringify(at(big, 4).raw))
ok(at(big, 9).inString === true && at(big, 10).inString === true && at(big, 11).inString === true,
  '整段:块的三行全不动', sig(big))
ok(at(big, 12).inString === false && at(big, 12).code === 'var q = "含 # 的串"',
  '整段:块后一行的 code 正常(字符串里的 # 没被当注释)', at(big, 12).code)
ok(at(big, 15).continuation === true, '整段:闭括号行仍算续行', sig(big))

// ---------- 9. 文件级产物(判据 5 三条闸的直接证据)----------
// 判据 5 吃的不是逐行状态位而是这一组文件级产物(dominantTerm / termCounts / blockTermConflict /
// strayCR / unterminated)。format.ts 只是转手用它们,所以「内容换行符归哪一边」这类账必须在这里
// 直接钉住 —— 只在 format 侧钉的话,分类器把内容行算进代码区时两边会一起错、一起绿。
section('9. 文件级产物:主导换行符 / 内容换行符 / 裸 CR / 未闭合')
const u1 = 'var s = "未闭合\n下一行   \n这里闭合了"\r\nvar a = 1\r\nvar b = 2\r\n'
const s1 = T.scanGdScript(u1)
ok(classify(u1).map((l) => (l.inString ? 'S' : '-')).join(' ') === 'S S S - -',
  '★判据 1:未闭合引号覆盖的三行(含闭合那一行)都算字符串内,闭合后立刻恢复',
  classify(u1).map((l) => (l.inString ? 'S' : '-')).join(' '))
ok(JSON.stringify(s1.termCounts) === JSON.stringify({ crlf: 3, lf: 0 }),
  '★判据 5:未闭合引号续行的那两个行尾换行归「字符串内容」,代码区只剩 3 个 CRLF',
  JSON.stringify(s1.termCounts))
ok(s1.dominantTerm === '\r\n', '判据 5:主导换行符只按代码区形态定', JSON.stringify(s1.dominantTerm))
ok(s1.blockTermConflict === true, '★判据 5:内容里混着 LF 而主导是 CRLF ⇒ 冲突置起,整条统一做不得')
ok(s1.unterminated === false, '判据 1:闭合引号出现过 → 文件级 unterminated 为假')
ok(s1.endsWithNewline === true, '判据 5:末行有终止符 → 不需要补末尾换行')
const u2 = 'var s = """\r\n块内\r\n"""\nvar a = 1\nvar b = 2\n'
const s2 = T.scanGdScript(u2)
ok(JSON.stringify(s2.termCounts) === JSON.stringify({ crlf: 0, lf: 3 }) && s2.dominantTerm === '\n' &&
    s2.blockTermConflict === true,
  '★判据 5 反向:块内的 CRLF 算内容,主导按代码区定成 LF,冲突照样置起',
  JSON.stringify([s2.termCounts, s2.dominantTerm, s2.blockTermConflict]))
const u3 = 'var a = 1\nvar b\r= 2   \r\nvar c = 3\nvar d = 4\n'
const s3 = T.scanGdScript(u3)
ok(s3.strayCR === true && JSON.stringify(s3.termCounts) === JSON.stringify({ crlf: 1, lf: 3 }) &&
    s3.dominantTerm === '\n' && s3.blockTermConflict === false,
  '判据 5:正文中间的裸 \\r 单独置 strayCR(行内那一个 \\r 不进任何一边的换行统计)',
  JSON.stringify([s3.strayCR, s3.termCounts, s3.dominantTerm, s3.blockTermConflict]))
const u4 = 'var a = 1\nvar b = 2\r'
ok(rebuild(u4) === u4 && at(u4, 2).raw === 'var b = 2\r' && at(u4, 2).term === '',
  '★判据 5:末行没有换行时它的 \\r 是**正文**,不许折进 term(折走就是凭空少一个字节)',
  JSON.stringify([rebuild(u4), at(u4, 2).raw]))
ok(T.scanGdScript(u4).strayCR === true, '判据 5:同一个 \\r 也被认成「换行形态认不出」')
ok(T.scanGdScript('var s = "一路到文件尾\nvar a = 1\n').unterminated === true,
  '判据 1:文件停在未闭合引号里 → unterminated 置起(调用方据此更保守)')
const u5 = 'var s = """\n块内未闭合\n'
ok(T.scanGdScript(u5).unterminated === true && classify(u5).every((l) => l.inString),
  '★判据 1:块没闭合到文件尾 → 每一行 inString、unterminated 置起')

// ---------- 10. Fix round 1 Important 1:`""` 与带前缀单行串要把本行剩下的括号算完 ----------
// 评审实测:旧写法一遇 `""` / `r"…"` 就 `i = raw.length` 放弃整行剩下的扫描,于是 `foo("", 2)` 里那个
// 没被数到的 `(` 把**后半份文件**全判成续行(缩进判据一路白丢,而卡面上既没有计数也没有「没做」说明)。
// 修法只放开两处「多算括号」,不放开任何字节:空串按开并闭处理(与已经上线的 `"abc"` 同一档);
// 带前缀的单行串往后找同类闭引号,找到就接着算括号,**那一行仍然整行标 inString、一个字节都不动**。
section('10. Fix round 1:`""` 空串与带前缀单行串不再吞掉本行剩下的括号统计')
const f1 = L('func f():', '    var s = foo("", 2)', '\tvar x = 1', '\tvar y = 2')
ok(sig(f1) === '--- --- --- ---', '★Fix1:`""` 是开并闭 ⇒ 后面的行不再是续行', sig(f1))
ok(at(f1, 2).inString === false && at(f1, 2).depth === 0 && at(f1, 2).code === 'var s = foo("", 2)',
  '★Fix1:闭合的空串让那一行回到代码态(与 `"abc"` 同档:串内没有任何字节,谈不上内容被改)',
  `${sig(f1)}|${at(f1, 2).code}`)
ok(T.scanGdScript(f1).unterminated === false && T.scanGdScript(f1).blockTermConflict === false,
  '判据 1/5:空串不留跨行状态', JSON.stringify(T.scanGdScript(f1).termCounts))
const f2 = L("var a = set('x', '')", 'var b = 1')
ok(sig(f2) === '--- ---', '★Fix1:单引号空串同机制(整行仍是代码态)', sig(f2))
const f3 = L('var s = ""   ', 'var b = 1   ')
ok(at(f3, 1).raw === 'var s = ""   ' && at(f3, 1).inString === false,
  '判据 1:分类器只如实给 raw(删不删那一行的尾随空白是 format.ts 的决定)', JSON.stringify(at(f3, 1).raw))
const f4 = L('func f():', '    var s = foo(r"\\d+", 2)', '    var x = 1')
ok(at(f4, 2).inString === true, '★Fix1:带前缀的**单行**串那一行照旧整行动不了(没放开任何字节)', sig(f4))
ok(at(f4, 2).depth === 0 && at(f4, 3).continuation === false,
  '★Fix1:找到闭引号之后括号照算 ⇒ 下一行不再是续行', `${at(f4, 2).depth}|${sig(f4)}`)
const f5 = L('var s = r""', 'var x = 1')
ok(sig(f5) === '--- ---', '判据 1:带前缀的**空**串(`r""`)也是开并闭 —— 里面确实没有内容', sig(f5))
const f6 = L('var p = r"没闭合', 'var x = 1   ')
ok(at(f6, 1).inString === true && at(f6, 2).inString === false && T.scanGdScript(f6).unterminated === false,
  '★判据 1:带前缀且**真未闭合** ⇒ 只放弃本行剩下的部分,不跨行带状态(已知残留,钉住它不扩大)', sig(f6))
const f7 = L('var s = ""  # 尾注释', 'var x = 1')
ok(at(f7, 1).isComment === false && at(f7, 1).code === 'var s = ""',
  '判据 1:空串之后的 `#` 仍按行尾注释切(代码区继续扫到了注释起点)', at(f7, 1).code)
const f8 = L('var s = """"', 'var x = 1')
ok(at(f8, 1).inString === true && at(f8, 2).inString === true && T.scanGdScript(f8).unterminated === true,
  '★判据 1:四连引号仍按「三连 = 开块」读(空串分支排在三连判定之后),块没闭合 ⇒ 后面整片不动', sig(f8))
const f9 = L('var x = [r"a\\"", 1]', '\tvar y = 2')
ok(at(f9, 1).depth === 0 && at(f9, 2).continuation === false,
  '★判据 1:带前缀串里 `\\"` 照样吃两个字符(与块分支同一条规则)⇒ `]` 被结算、深度归零',
  `${at(f9, 1).depth}|${sig(f9)}`)
const f10 = L("var s = r\"a'b\" + foo(1)", 'var x = 1')
ok(at(f10, 1).inString === true && at(f10, 1).depth === 0 && at(f10, 2).continuation === false &&
    at(f10, 2).inString === false,
  '★判据 1:带前缀的串只认**同类**闭引号(串里的单引号不是终点,与块分支同一条规矩)', sig(f10))

// 本文件的断言全是同步的(分类器不发任何 IO),所以不需要别家 harness 那份 async main 包装。
// 中途抛错(例如夹具里拿不到某一行)会以非零码直接收口且印不出 PASS 行 —— 不会伪装成绿。
console.log(`\n${'='.repeat(56)}\nPASS ${pass}  FAIL ${failures.length}`)
if (failures.length) { console.log('失败项:'); for (const f of failures) console.log('  - ' + f); process.exit(1) }
console.log('全部通过')
