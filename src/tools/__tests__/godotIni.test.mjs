// 工具页 B2:project.godot INI 解析器(src/tools/parsers/godotIni.ts)的断言。
//
// 为什么单开一个文件:tools.test.mjs 的夹具是「一份内存文件树喂三个检查器」,
// 这里喂的是**文本解析规则**,夹具是一段段 project.godot 原文,两边共用不上。
// 每条断言上方的注释写清「这条规则为什么存在」(多数钉的是 Godot 实际写盘的形态),改规则前先读。
//
// ⚠ 台账 Ruling B2 让本解析器与 preload 的 src-ztools/preload/lib/projects.js:26
//   (Rust 孪生 src-tauri/src/projects.rs:10)**并存**。下面标了 [分叉] 的断言钉的是
//   「我们这一份的行为与那份不同」的那些点 —— 分叉是刻意付出的代价,但只能停在已写明的
//   差异上,别让它悄悄扩大。
//
// 用法(npm script 会先跑打包步骤):
//   node src/composables/__tests__/build-bundle.mjs && node src/tools/__tests__/godotIni.test.mjs
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

/**
 * 一份真实形态的 Godot 4.x project.godot(写盘顺序、空行、段头后的空行都照编辑器输出)。
 * 里面同时埋了:值里带 `=`、段头内带空格、多行 input 块(块里字符串含 `]` 与转义引号)、
 * `[editor_plugins]` 的 PackedStringArray 路径、autoload 的 `*` 前缀与 `$` 引用、
 * 一个重复键、一行畸形。
 */
const INI_REAL = [
  '; Engine configuration file.',
  '; It can be edited manually, but the editor rewrites it on every change.',
  'config_version=5',
  '',
  '[application]',
  '',
  'config/name="A=B"',
  'run/main_scene="res://scene/main.tscn"',
  'config/features=PackedStringArray("4.3", "Forward Plus")',
  'config/icon="res://icon.svg"',
  '',
  '[ display ]',
  '',
  'window/size/viewport_width=1280',
  'window/size/viewport_height=720',
  'window/stretch/mode="canvas_items"',
  '',
  '[autoload]',
  '',
  'GameState="*res://autoload/game_state.gd"',
  'Net="$GameState"',
  '',
  '[editor_plugins]',
  '',
  'enabled=PackedStringArray("res://addons/foo/plugin.cfg")',
  '',
  '[input]',
  '',
  'move_left={',
  '"deadzone": 0.5,',
  '"events": [Object(InputEventKey,"resource_local_to_scene":false,"string=\\"a]b\\"","physical_keycode":65)',
  ']',
  '}',
  '',
  '[rendering]',
  '',
  'renderer/rendering_method="gl_compatibility"',
  'renderer/rendering_method="forward_plus"',
  'this line is not a valid entry'
].join('\n')

/** INI_REAL 去掉最后一行畸形行 = 引擎能写出的干净文件(重复键**不是**畸形:见判据 7) */
const INI_CLEAN = INI_REAL.split('\n').slice(0, -1).join('\n')

/** 某行在 INI_REAL 里的 1-based 行号(写死数字会让夹具一改就错,这里按内容找) */
function lineIn(text, needle) {
  const i = text.split('\n').findIndex((l) => l.includes(needle))
  if (i < 0) throw new Error(`夹具里没有这一行: ${needle}`)
  return i + 1
}
/** 取某个键的 IniValue(按 fullKey,取最后一条) */
function valOf(doc, sectionName, key) {
  return doc.values.filter((v) => v.section === sectionName && v.key === key).pop()
}
/** 造只含一条键值的文档(fullKey 无段名时用顶层) */
function docOf(...lines) {
  return T.parseGodotIni(lines.join('\n'))
}

async function main() {
  // ---------- 1. 整体:真实文件解析得动、干净文件零 problems ----------
  section('1. 真实形态文件整体')
  const real = T.parseGodotIni(INI_REAL)
  const clean = T.parseGodotIni(INI_CLEAN)
  // 为什么存在:B8 的全部结论都建立在这份 values 清单上 —— 干净项目若有 problems,
  // 就是解析器自己造假阳性,而不是项目真有问题。
  ok(clean.problems.length === 0, '干净项目 0 problems(含重复键也不算畸形)',
    JSON.stringify(clean.problems))
  ok(real.problems.length === 1, '畸形行只出一条 problem,不误伤其他行', JSON.stringify(real.problems))
  ok(real.problems[0]?.line === lineIn(INI_REAL, 'not a valid entry') &&
    real.problems[0]?.text === 'this line is not a valid entry',
    'problem 带 1-based 行号与原样行文本(证据不能只给个 reason)',
    JSON.stringify(real.problems[0]))
  ok(real.configVersion === 5, 'config_version=5 读到 5', real.configVersion)
  ok(real.values.length === clean.values.length,
    '畸形行不产 values,也不吃掉任何键值行(逐行了断,不做上下文猜测)',
    `${real.values.length}/${clean.values.length}`)
  // 段序即文件序、重复键全留:B8 判「重复键」唯一的证据来源
  ok(real.values.filter((v) => v.section === 'rendering' && v.key === 'renderer/rendering_method').length === 2,
    '重复键两条都留在 values 里(不覆盖、不合并)',
    JSON.stringify(real.values.filter((v) => v.key === 'renderer/rendering_method')))
  ok(T.getIni(real, 'rendering/renderer/rendering_method') === 'forward_plus',
    'getIni 给最后一条(与编辑器载入顺序一致,B8 拿 values 数重复)',
    T.getIni(real, 'rendering/renderer/rendering_method'))
  // 文件顺序:values 的 line 严格递增
  const linesAsc = real.values.every((v, i) => i === 0 || v.line > real.values[i - 1].line)
  ok(linesAsc, 'values 保持文件顺序(line 严格递增)')

  // ---------- 2. 判据 1–3:段头 / 注释 / 首个 = / 空白 ----------
  section('2. 段头、注释、首个 = 号、空白')
  const cmt = docOf('; 顶注释', '   ; 缩进注释也是注释', '', '[x]', 'k=1')
  ok(cmt.values.length === 1 && cmt.values[0].section === 'x' && cmt.values[0].key === 'k' &&
    cmt.values[0].raw === '1' && cmt.problems.length === 0,
    '判据 1:空行跳过、trim 后以 ; 开头是注释、段头改当前段', JSON.stringify(cmt))
  // 判据 2:只在第一个 = 处切。config/name="A=B" 是真会出现的写法(项目名带等号)
  ok(T.getIniRaw(real, 'application/config/name') === '"A=B"' &&
    T.getIni(real, 'application/config/name') === 'A=B',
    '判据 2:只在第一个 = 处切,值里的 = 全留(项目名 "A=B" 不能被切成 "A")',
    T.getIniRaw(real, 'application/config/name'))
  // 判据 3:key 两侧空白去掉 + 段头内空白容忍(`[ display ]` 手写/合并冲突后会出现)
  const sp = docOf('[  display  ]', '  window/size/viewport_width  =  1280  ')
  ok(sp.values[0]?.section === 'display' && sp.values[0]?.key === 'window/size/viewport_width' &&
    sp.values[0]?.raw === '1280' && T.getIni(sp, 'display/window/size/viewport_width') === '1280',
    '判据 3:key 两侧空白去掉、段头内空白容忍(trim 括号内)', JSON.stringify(sp.values))
  ok(T.getIni(real, 'display/window/size/viewport_height') === '720',
    '判据 3 复用:夹具里 `[ display ]` 带空气,读键仍按 display/ 命中',
    T.getIni(real, 'display/window/size/viewport_height'))
  // [分叉] preload 的正则是 ^\s*([\w./]+)\s*=,键名带 - 或 " 的行会被它整行丢掉
  const dash = docOf('[a]', 'weird-key#1=v')
  ok(dash.values[0]?.key === 'weird-key#1',
    '[分叉] 键名原样保留(不比照 preload 的 [\\w./]+ 白名单挑键)', JSON.stringify(dash.values))

  // ---------- 3. 判据 4–5:多行块与未闭合块 ----------
  section('3. 多行块([input] 动作块)')
  const mv = valOf(real, 'input', 'move_left')
  ok(!!mv && mv.raw.startsWith('{') && mv.raw.endsWith('}') && mv.raw.split('\n').length === 5,
    '判据 4:`{` 开头且本行未配平 → 吃掉后续行,整块是这一条的值', JSON.stringify(mv))
  ok(!!mv && mv.line === lineIn(INI_REAL, 'move_left={') && mv.endLine === lineIn(INI_REAL, '}'),
    '判据 4:line=值开始行、endLine=块最后一行', mv && `${mv.line}/${mv.endLine}`)
  // 这条是本节的心脏:字符串里的 ] 与 " 不得结束块(引号感知计数)。
  // 若按整行字符计数,`"a]b"` 里的 ] 会把 events 数组提前关掉,于是 `}` 变成散落行、
  // [rendering] 之后的所有键被当成块内容吃掉 —— B8 会对每个带 input 动作的项目报错。
  ok(!!mv && mv.raw.includes('a]b') && !mv.raw.includes('[rendering]'),
    '判据 4:块内字符串里的 ] 不结束块(引号感知,含 \\" 转义)', mv && mv.raw)
  ok(T.getIni(real, 'rendering/renderer/rendering_method') === 'forward_plus' &&
    real.problems.length === 1,
    '判据 4 反面钉:块关掉后 [rendering] 仍按段头解析(没被当成块内容吃掉)',
    JSON.stringify(real.problems))
  const arrBlock = docOf('[input]', 'a=[', '"x": [1],', '"tail": "]",', ']')
  ok(arrBlock.values.length === 1 && arrBlock.values[0].endLine === 5 && arrBlock.problems.length === 0,
    '判据 4:`[` 开头的数组块同样配平到底(块内又开数组,且带 `]` 的字符串不算收尾)',
    JSON.stringify({ v: arrBlock.values, p: arrBlock.problems }))
  // 转义必须吃掉**下一个字符**:块里字符串带着 `}` 时(`"a\"}b"`),若 `\` 只算一个普通字符,
  // 紧跟其后的 " 就被当成收尾,于是串外的 `}` 提前关掉块 —— 下一行的真收尾 `}` 变成散落行。
  // 上面 INI_REAL 的那条抓不到这个差异(它少算一个 ] 后仍然在同一行配平),所以单独钉这条。
  const escBlock = T.parseGodotIni('x={\n"k": "a\\"}b"\n}\n')
  ok(escBlock.values.length === 1 && escBlock.values[0].endLine === 3 && escBlock.problems.length === 0,
    '判据 4:块内字符串里的 \\" 吃掉下一个字符,串内的 } 不得提前关块', JSON.stringify({
      v: escBlock.values, p: escBlock.problems }))
  // 判据 5:未闭合块保留证据(整块仍是该键的值)并记 problem —— 别丢证据
  const bad = T.parseGodotIni('x={\n"a": 1\n')
  ok(bad.values.length === 1 && bad.values[0].raw === '{\n"a": 1',
    '判据 5:块未闭合到文件尾,已吃到的行整体留作值(证据不丢)', JSON.stringify(bad.values))
  ok(bad.problems.length === 1 && bad.problems[0].line === 1 && /未闭合/.test(bad.problems[0].reason),
    '判据 5:同时在 problems 里记一条「多行块未闭合」', JSON.stringify(bad.problems))
  // 判据 4 加严:起始行**停在字符串里**的行不得进块模式。scanBalance 把 inString 跨行传递,
  // 于是 `b=[ "x ]` 之后每一行的引号都跟「错的那一个」配对,c= 与 d= 两条真键被吞进 b 的值里 ——
  // 丢的是 res:// 引用(B5 会把 y.png/z.png 报成孤儿),而 getIni 仍把那两个键读得出来(裸值规则),
  // 同一页两个结论互相打脸。畸形本身要记,但不能靠吃键来记。
  const oddQ = T.parseGodotIni('[a]\nb=[ "x ]\nc="res://y.png"\nd="res://z.png"')
  ok(oddQ.values.length === 3 && oddQ.values.map((v) => v.key).join(',') === 'b,c,d',
    '判据 4 加严:起始行引号不配对 → 本行按单行值保留,后续键不再被吃掉', JSON.stringify(oddQ.values))
  ok(T.iniResPaths(oddQ).map((p) => p.path).join('|') === 'res://y.png|res://z.png',
    '判据 4 加严:被吞掉的那两条 res:// 现在收得到(修复的正是在「丢引用」这一侧)',
    JSON.stringify(T.iniResPaths(oddQ)))
  ok(oddQ.problems.length === 1 && oddQ.problems[0].line === 2 &&
    /引号/.test(oddQ.problems[0].reason) && !/未闭合/.test(oddQ.problems[0].reason),
    '判据 4 加严:另记一条独立 problem,不冒用「多行块未闭合」的文案(B8 的结论要说是同一件事)',
    JSON.stringify(oddQ.problems))

  // ---------- 4. 判据 6:散落行的两种 reason ----------
  section('4. 散落行:缺 = 与段头不闭合要分得开')
  const stray = T.parseGodotIni('[application]\nconfig/name="x"\n随手写的一句话\n[unclosed\nk=2')
  ok(stray.problems.length === 2, '判据 6:两种畸形各出一条,后面的 k=2 照常解析',
    JSON.stringify(stray.problems))
  const pText = stray.problems.find((p) => p.line === 3)?.reason || ''
  const pHead = stray.problems.find((p) => p.line === 4)?.reason || ''
  ok(pText.includes('=') && pHead.includes(']'),
    '判据 6:reason 区分「缺 =」与「段头不闭合」(B8 的文案直接吃这两个 reason)',
    `${pText} || ${pHead}`)
  ok(stray.values.length === 2 && stray.values[1].section === 'application',
    '判据 6:不闭合的段头不改当前段(证据留在 problems 里,不臆造新段)',
    JSON.stringify(stray.values))
  const topStray = T.parseGodotIni('散落在任何段头之前')
  ok(topStray.problems.length === 1 && topStray.values.length === 0,
    '判据 6:第一个段头之前的散落行同样记 problem(不因 section 为空而放过)',
    JSON.stringify(topStray))
  ok(T.parseGodotIni('=没有键名').problems.length === 1,
    '判据 6:= 号前没有键名也算归不进 key=value 的行', JSON.stringify(T.parseGodotIni('=没有键名').problems))

  // ---------- 5. 判据 7:config_version 三态 ----------
  section('5. config_version:缺 / 非法 / 重复')
  ok(T.parseGodotIni('[application]\nconfig/name="x"').configVersion === 0,
    '判据 7:头部没有 config_version → 0,**不得臆造成 5**(3.x 项目会被冒领 4.x 规则)',
    T.parseGodotIni('[application]\nconfig/name="x"').configVersion)
  const cvBad = T.parseGodotIni('config_version=abc\n[application]\nk=1')
  ok(cvBad.configVersion === 0 && cvBad.problems.length === 1 && cvBad.problems[0].line === 1,
    '判据 7:非数字 → 0 并把非法交给 problems', JSON.stringify(cvBad.problems))
  // [分叉] preload 用 parseInt(value,10)||0,`5x` 被它读成 5;我们判非裸整数即 0
  const cvHalf = T.parseGodotIni('config_version=5x')
  ok(cvHalf.configVersion === 0 && cvHalf.problems.length === 1,
    '[分叉] 判据 7:`5x` 不算数字(preload 的 parseInt 会读成 5)',
    `${cvHalf.configVersion}/${JSON.stringify(cvHalf.problems)}`)
  ok(T.parseGodotIni('config_version="5"').configVersion === 0,
    '判据 7:带引号的 "5" 不是裸整数 → 0(它是字符串,不是版本号)',
    T.parseGodotIni('config_version="5"').configVersion)
  const cvDup = T.parseGodotIni('config_version=5\nconfig_version=4')
  ok(cvDup.configVersion === 0 && cvDup.values.length === 2,
    '判据 7:多次出现 → 0,重复本身交给 values(B8 判重复键的证据不丢)',
    `${cvDup.configVersion}/${cvDup.values.length}`)
  // [分叉] preload / Rust 两份都不看段名,段里的 config_version 会被冒领
  const cvSec = T.parseGodotIni('[rendering]\nconfig_version=5')
  ok(cvSec.configVersion === 0 && cvSec.values.length === 1 && cvSec.values[0].section === 'rendering',
    '[分叉] 判据 7:只认 section 为空串的顶层那条(段内的同名键不算项目版本号)',
    `${cvSec.configVersion}/${JSON.stringify(cvSec.values)}`)

  // ---------- 6. 判据 8:形态噪声不得抛错 ----------
  section('6. CRLF / tab 续行 / 空值 / 空串')
  const crlf = T.parseGodotIni(INI_REAL.replace(/\n/g, '\r\n'))
  ok(crlf.values.length === real.values.length && crlf.problems.length === real.problems.length &&
    crlf.configVersion === 5,
    '判据 8:CRLF 文件与 LF 同解(Windows 项目里 CRLF 是常态)',
    `${crlf.values.length}/${real.values.length}/${crlf.problems.length}`)
  ok(JSON.stringify(crlf.values) === JSON.stringify(real.values),
    '判据 8:CRLF 与 LF 逐条同解(section/key/raw/line/endLine 全等,行号是要给用户看的证据)',
    `${crlf.values.length} vs ${real.values.length}`)
  const tabbed = T.parseGodotIni('a={\n\t"deadzone": 0.5,\n\t"x": [1]\n]\n}')
  ok(tabbed.values.length === 1 && tabbed.values[0].raw.includes('\t"deadzone"'),
    '判据 8:行首 tab 缩进的续行照吃(块内原文保持制表符)', JSON.stringify(tabbed.values))
  const empt = docOf('[s]', 'k=', 'q=""')
  ok(empt.values[0]?.raw === '' && T.getIni(empt, 's/k') === '' &&
    T.getIniBool(empt, 's/k') === undefined,
    '判据 8:`key=` 空值 → raw 与 getIni 都是空串,不是 undefined;getIniBool 按「取不到一律 undefined」给 undefined',
    JSON.stringify(empt.values[0]))
  ok(empt.values[1]?.raw === '""' && T.getIni(empt, 's/q') === '',
    '判据 8:`key=""` → 剥一层外层引号得空串', JSON.stringify(empt.values[1]))
  // 「另存为 UTF-8 带 BOM」的 project.godot 是真会出现的形态(记事本 / 某些编辑器),
  // BOM 会粘在文件最前面。它靠「每行先 trim 再判定」被吃掉(U+FEFF 属于 ECMAScript 的
  // WhiteSpace),所以两条都要钉:BOM 在头注释上(别白报畸形)、BOM 直接贴在键名上(别查不到)。
  const BOM = String.fromCharCode(0xfeff) // 记事本「另存为 UTF-8 带 BOM」塞在文件最前面那个字符
  const bom = T.parseGodotIni(BOM + INI_CLEAN)
  ok(bom.problems.length === 0 && bom.configVersion === 5 && T.getIni(bom, 'config_version') === '5',
    '判据 8 加严:BOM 粘在头注释上时既不产畸形也不影响 config_version', JSON.stringify({
      p: bom.problems, v: bom.configVersion, k: T.getIni(bom, 'config_version') }))
  const bomKey = T.parseGodotIni(BOM + 'config_version=5\n[application]\nconfig/name="X"\n')
  ok(bomKey.values[0]?.key === 'config_version' && bomKey.configVersion === 5 &&
    T.getIni(bomKey, 'application/config/name') === 'X',
    '判据 8 加严:BOM 直接贴在键名上也进不了 key(逐行 trim 的连带保证)', JSON.stringify({
      k: bomKey.values[0]?.key, v: bomKey.configVersion }))
  // problems 的顺序是给用户读的行序:逐行的畸形在循环里推、config_version 那条是二次扫描补的,
  // 不排序就会把「文件第 1 行的非法值」排在「第 3 行的散落行」后面。
  const order = T.parseGodotIni('config_version=abc\n[o]\n随手一行\n')
  ok(order.problems.map((p) => p.line).join(',') === '1,3',
    'problems 按行号升序(结论列表不能跳行读)', JSON.stringify(order.problems.map((p) => [p.line, p.reason])))

  // ---------- 7. getIni / getIniRaw:剥一层外层引号并解码 ----------
  section('7. getIni 引号与转义解码')
  const esc = docOf('[t]',
    'nl="a\\nb"',
    'tab="a\\tb"',
    'bs="a\\\\b"',
    'qt="\\"x\\""',
    'cr="a\\rb"',
    'uu="a\\u0062"',
    'two="a" "b"',
    'num=1280',
    'arr=PackedStringArray("1")')
  ok(T.getIni(esc, 't/nl') === 'a\nb' && T.getIni(esc, 't/tab') === 'a\tb' && T.getIni(esc, 't/cr') === 'a\rb',
    'getIni:一对双引号包裹 → 剥一层并解码 \\n \\t \\r \\" \\\\(简报钉死的解码集)',
    JSON.stringify([T.getIni(esc, 't/nl'), T.getIni(esc, 't/tab'), T.getIni(esc, 't/cr')]))
  ok(T.getIni(esc, 't/bs') === 'a\\b',
    'getIni:`"a\\\\b"` 解码成一个反斜杠(转义要吃掉,不能留双份)', JSON.stringify(T.getIni(esc, 't/bs')))
  // 简报的原话:「剥一次、不解多层」
  ok(T.getIni(esc, 't/qt') === '"x"',
    'getIni 剥一次不解多层:`"\\"x\\""` → `"x"`(带引号)才算对', JSON.stringify(T.getIni(esc, 't/qt')))
  ok(T.getIni(esc, 't/uu') === 'a\\u0062',
    'getIni:解码集之外的转义原样留着(不猜 \\u 的语义)', JSON.stringify(T.getIni(esc, 't/uu')))
  ok(T.getIni(esc, 't/num') === '1280' && T.getIni(esc, 't/arr') === 'PackedStringArray("1")',
    'getIni:非引号对(裸整数/数组调用)原样返回 raw', JSON.stringify([T.getIni(esc, 't/num'), T.getIni(esc, 't/arr')]))
  ok(T.getIni(esc, 't/two') === '"a" "b"',
    'getIni:不是「一对」引号包裹(两条字面量)就整串原样,不挑第一段', JSON.stringify(T.getIni(esc, 't/two')))
  ok(T.getIniRaw(esc, 't/nl') === '"a\\nb"',
    'getIniRaw 给未解码的原文(判「写没写引号」的工具要靠它)', JSON.stringify(T.getIniRaw(esc, 't/nl')))
  ok(T.getIni(esc, 't/nope') === undefined && T.getIniRaw(esc, 't/nope') === undefined,
    '取不到一律 undefined,不给默认值', [T.getIni(esc, 't/nope'), T.getIniRaw(esc, 't/nope')].join('/'))
  ok(T.getIni(real, 'config_version') === '5',
    '顶层键的 fullKey 不带段前缀(section 为空的键就是 config_version 本身)',
    T.getIni(real, 'config_version'))
  ok(T.getIni(real, 'application/window/size/viewport_width') === undefined &&
    T.getIni(real, 'window/size/viewport_width') === undefined,
    'fullKey 必须带段名:漏段名的查法不给「碰巧同名」的结果', JSON.stringify(T.getIni(real, 'window/size/viewport_width')))
  ok(T.getIni(real, 'application') === undefined && T.getIni(real, '') === undefined,
    '段名单独传 / 空 fullKey 都不当键用', JSON.stringify([T.getIni(real, 'application'), T.getIni(real, '')]))

  // ---------- 8. getIniBool / getIniInt ----------
  section('8. getIniBool / getIniInt')
  const bm = docOf('[b]', 'yes=true', 'no=false', 'str="true"', 'one=1', 'up=True', 'zero=0')
  ok(T.getIniBool(bm, 'b/yes') === true && T.getIniBool(bm, 'b/no') === false,
    'getIniBool:裸 true/false → 布尔', `${T.getIniBool(bm, 'b/yes')}/${T.getIniBool(bm, 'b/no')}`)
  ok(T.getIniBool(bm, 'b/str') === undefined && T.getIniBool(bm, 'b/one') === undefined &&
    T.getIniBool(bm, 'b/up') === undefined && T.getIniBool(bm, 'b/nope') === undefined,
    'getIniBool:引号串 / 1 / True(大写)都不算布尔 → undefined,不当 falsy 也不猜',
    JSON.stringify([T.getIniBool(bm, 'b/str'), T.getIniBool(bm, 'b/one'), T.getIniBool(bm, 'b/up')]))
  const im = docOf('[i]', 'w=1280', 'neg=-3', 'q="1280"', 'f=0.5', 'hex=0x10', 'arr=PackedStringArray("1")', 'z=0', 'huge=99999999999999999999')
  ok(T.getIniInt(im, 'i/w') === 1280 && T.getIniInt(im, 'i/neg') === -3 && T.getIniInt(im, 'i/z') === 0,
    'getIniInt:裸整数(含负数与 0)', `${T.getIniInt(im, 'i/w')}/${T.getIniInt(im, 'i/neg')}/${T.getIniInt(im, 'i/z')}`)
  ok(T.getIniInt(im, 'i/q') === undefined && T.getIniInt(im, 'i/f') === undefined &&
    T.getIniInt(im, 'i/hex') === undefined && T.getIniInt(im, 'i/arr') === undefined,
    'getIniInt:引号串 / 小数 / 0x10 / 数组一律 undefined(简报:只有裸整数才解析)',
    JSON.stringify([T.getIniInt(im, 'i/q'), T.getIniInt(im, 'i/f'), T.getIniInt(im, 'i/hex')]))
  // 第二道闸:能过正则不等于能安全返回 —— 超出双精度的整数 Number() 会给出一个**被改写过的数**,
  // 那比 undefined 更坏(B8 会拿它当读到的配置值下结论)。
  ok(T.getIniInt(im, 'i/huge') === undefined,
    'getIniInt:超出安全整数的裸数字给 undefined,不返回一个已经被四舍五入的数',
    String(T.getIniInt(im, 'i/huge')))
  ok(T.getIniInt(bm, 'b/nope') === undefined && T.getIniBool(im, 'i/nope') === undefined,
    '取不到 → undefined', JSON.stringify([T.getIniInt(bm, 'b/nope'), T.getIniBool(im, 'i/nope')]))

  // ---------- 9. getIniList ----------
  section('9. getIniList:PackedStringArray 与纯字符串数组')
  const lst = docOf('[l]',
    'feat=PackedStringArray("4.3", "Forward Plus")',
    'empty=PackedStringArray()',
    'arr=[ "a", "b" ]',
    'arrEmpty=[]',
    'arrOne=["res://x/y.png"]',
    'dict={ "a": 1 }',
    'objs=[Object(InputEventKey,"resource_local_to_scene":false)]',
    'varr=Array[String]("a")',
    'bare=foo',
    'quoted="a"',
    'broken=PackedStringArray("a"',
    'half=[ "a ]',
    'nested=["a", ["b"]]')
  // 夹具的每条键都必须**真的成为一条 value**。`half=[ "a ]` 在旧实现里把紧跟的 nested 整行吞进
  // 自己的块,于是下面「nested → undefined」是因为**键不见了**而通过 —— 伪装成通过的断言最危险。
  ok(lst.values.length === 13 &&
    lst.values.map((v) => v.key).join('|') ===
    'feat|empty|arr|arrEmpty|arrOne|dict|objs|varr|bare|quoted|broken|half|nested',
    '夹具 13 个键全在 values 里(被上一行的块吃掉的键会让下面的 undefined 断言平凡为真)',
    `${lst.values.length}/${lst.values.map((v) => v.key).join('|')}`)
  ok(T.getIniList(lst, 'l/feat')?.join('|') === '4.3|Forward Plus',
    'getIniList:PackedStringArray("a","b") → 字面量数组(顺序保留)',
    JSON.stringify(T.getIniList(lst, 'l/feat')))
  ok(T.getIniList(lst, 'l/arr')?.join('|') === 'a|b' && T.getIniList(lst, 'l/arrOne')?.join('|') === 'res://x/y.png',
    'getIniList:`[ "a", "b" ]` 也认(手写与合并冲突后的形态)', JSON.stringify(T.getIniList(lst, 'l/arr')))
  ok(Array.isArray(T.getIniList(lst, 'l/empty')) && T.getIniList(lst, 'l/empty').length === 0 &&
    Array.isArray(T.getIniList(lst, 'l/arrEmpty')) && T.getIniList(lst, 'l/arrEmpty').length === 0,
    'getIniList:空括号 → [](空数组是结论,不是「读不出」)',
    JSON.stringify([T.getIniList(lst, 'l/empty'), T.getIniList(lst, 'l/arrEmpty')]))
  ok(T.getIniList(lst, 'l/dict') === undefined && T.getIniList(lst, 'l/objs') === undefined &&
    T.getIniList(lst, 'l/varr') === undefined && T.getIniList(lst, 'l/bare') === undefined &&
    T.getIniList(lst, 'l/quoted') === undefined,
    'getIniList:{...} / Array(...) / 裸串 / 单个引号串一律 undefined(简报:不猜)',
    JSON.stringify([T.getIniList(lst, 'l/dict'), T.getIniList(lst, 'l/objs'), T.getIniList(lst, 'l/bare')]))
  ok(T.getIniList(lst, 'l/nested') === undefined,
    'getIniList:嵌套数组不拍平成交集(undefined 比假列表诚实)', JSON.stringify(T.getIniList(lst, 'l/nested')))
  ok(T.getIniList(lst, 'l/broken') === undefined,
    'getIniList:引号不配对的括号不给半截列表', JSON.stringify(T.getIniList(lst, 'l/broken')))
  ok(T.getIniList(lst, 'l/half') === undefined,
    'getIniList:括号**里面**引号不配对(形态像数组却读不出列表)也是 undefined,不是空数组',
    JSON.stringify(T.getIniList(lst, 'l/half')))
  ok(T.getIniList(lst, 'l/nope') === undefined,
    'getIniList:取不到 → undefined')

  // ---------- 10. stringLiterals ----------
  section('10. stringLiterals:引号感知的字面量抓取')
  ok(T.stringLiterals('PackedStringArray("4", "3")').join('|') === '4|3',
    'stringLiterals:按出现顺序给每个双引号字面量', JSON.stringify(T.stringLiterals('PackedStringArray("4", "3")')))
  ok(T.stringLiterals('"a\\"b" "tail"').join('|') === 'a"b|tail',
    'stringLiterals:解码 \\",且转义引号不得提前关掉字面量', JSON.stringify(T.stringLiterals('"a\\"b" "tail"')))
  ok(T.stringLiterals('"a\\\\b"').join('|') === 'a\\b',
    'stringLiterals:`\\\\` 吃掉两个字符,后面那个引号才是真正的收尾', JSON.stringify(T.stringLiterals('"a\\\\b"')))
  ok(T.stringLiterals('"one" 尾巴 "two').join('|') === 'one',
    'stringLiterals:不配对的尾引号整条丢弃(要么完整要么不要,别给半截串)',
    JSON.stringify(T.stringLiterals('"one" 尾巴 "two')))
  ok(T.stringLiterals('没有引号').length === 0 && T.stringLiterals('').length === 0,
    'stringLiterals:没有字面量 → 空数组', JSON.stringify(T.stringLiterals('没有引号')))
  ok(T.stringLiterals('"a\\u0062"').join('|') === 'a\\u0062',
    'stringLiterals:解码集外的转义原样保留(与 getIni 同一套解码)', JSON.stringify(T.stringLiterals('"a\\u0062"')))

  // ---------- 11. iniResPaths ----------
  section('11. iniResPaths:res:// 字面量清单')
  const rp = T.iniResPaths(real)
  const rpKey = rp.map((p) => `${p.fullKey}@${p.line}=${p.path}`).sort().join('|')
  ok(rpKey === [
    `application/config/icon@${lineIn(INI_REAL, 'config/icon')}=${'res://icon.svg'}`,
    `application/run/main_scene@${lineIn(INI_REAL, 'run/main_scene')}=${'res://scene/main.tscn'}`,
    `autoload/GameState@${lineIn(INI_REAL, 'GameState')}=${'res://autoload/game_state.gd'}`,
    `editor_plugins/enabled@${lineIn(INI_REAL, 'enabled=PackedStringArray')}=${'res://addons/foo/plugin.cfg'}`
  ].sort().join('|'),
    'iniResPaths:main_scene / icon / autoload / PackedStringArray 里的 res:// 全收齐,fullKey 与 line 都对',
    rpKey)
  // autoload 的 * 是「启用单例」标记,不是路径的一部分:留下 `*res://…` 就永远对不上树里的 rel
  ok(rp.every((p) => !p.path.includes('*')),
    'iniResPaths:autoload 的 `*` 前缀剥掉(B3 的 rel 必须能与文件树对上)',
    JSON.stringify(rp.map((p) => p.path)))
  ok(rp.every((p) => p.path !== 'res://$GameState' && !p.fullKey.includes('Net')),
    'iniResPaths:`$MyAuto` 引用别的单例,不是路径,不收', JSON.stringify(rp.map((p) => p.fullKey)))
  ok(rp.every((p) => !p.path.includes('4.3') && !p.path.includes('canvas_items')),
    'iniResPaths:非 res:// 的字面量(features 的 "4.3"、stretch/mode)不混进来', JSON.stringify(rp.map((p) => p.path)))
  const other = T.parseGodotIni('[a]\nb="user://save.dat"\nc="C:/Godot/x.png"\nd="/home/x/y.png"\ne="res://x/y.png"\n')
  ok(T.iniResPaths(other).map((p) => p.path).join('|') === 'res://x/y.png',
    'iniResPaths:user:// 与绝对路径不进结果(它们不在项目树里,判不了存在性)',
    JSON.stringify(T.iniResPaths(other)))
  const blockRp = T.parseGodotIni('[input]\nm={\n"p":"res://a/b.png"\n}\n')
  ok(T.iniResPaths(blockRp).length === 1 && T.iniResPaths(blockRp)[0].line === 2,
    'iniResPaths:多行块里的 res:// 也收,line 给块起始行(块内行号归 endLine 管)',
    JSON.stringify(T.iniResPaths(blockRp)))
  ok(T.iniResPaths(real).every((p) => typeof p.line === 'number' && p.line >= 1),
    'iniResPaths:每条都带 1-based 行号')
  // 编辑器外**手改**的 project.godot 会把值写成不带引号的裸串(Godot 自己写盘带引号,但本项目
  // 的常见场景就是手写 / 合并冲突后手补)。getIni 按判据 8 认它是裸串,那么 iniResPaths 也必须认它:
  // 否则 B8 说「主场景 = res://main.tscn」、B5 在同一页说「没人引用它」→ 用户真会删。
  const unq = T.parseGodotIni(
    '[application]\nrun/main_scene=res://scene/main.tscn\n[autoload]\nGS=res://autoload/gs.gd\n')
  ok(T.iniResPaths(unq).map((p) => `${p.fullKey}@${p.line}=${p.path}`).join('|') ===
    'application/run/main_scene@2=res://scene/main.tscn|autoload/GS@4=res://autoload/gs.gd',
    'iniResPaths:不带引号的 res:// 值也收(fullKey 与 line 同规则)',
    JSON.stringify(T.iniResPaths(unq)))
  ok(T.getIni(unq, 'application/run/main_scene') === 'res://scene/main.tscn' &&
    T.iniResPaths(unq).some((p) => p.path === 'res://scene/main.tscn'),
    'iniResPaths 与 getIni 不对同一个值给相反结论(配置证据与引用证据必须同口径)',
    `${T.getIni(unq, 'application/run/main_scene')}/${JSON.stringify(T.iniResPaths(unq).map((p) => p.path))}`)
  const unqBad = docOf('[t]', 'n=1280', 'b=true', 'arr=PackedStringArray("4.3", "Forward Plus")',
    'u=user://save.dat', 'ref=$GameState', 'note=see res://x/y.png', 'empty=', 'neg=-1')
  ok(T.iniResPaths(unqBad).length === 0,
    'iniResPaths:裸值只有「整串就是路径」才算数(1280 / true / 数组 / user:// / $单例 / 半路提及都不是)',
    JSON.stringify(T.iniResPaths(unqBad)))

  // ---------- 12. 防御:undefined / 非字符串不得抛错 ----------
  section('12. 不抛错红线')
  const guarded = (label, fn) => {
    try {
      const r = fn()
      ok(r === true, label, String(r))
    } catch (e) {
      ok(false, `${label} —— 抛错了: ${e && e.message}`)
    }
  }
  guarded('parseGodotIni(undefined/null/数字) 给空文档而非抛错', () => {
    for (const junk of [undefined, null, 123, {}, []]) {
      const d = T.parseGodotIni(junk)
      if (!d || d.values.length !== 0 || d.problems.length !== 0 || d.configVersion !== 0) return false
    }
    return true
  })
  guarded('访问器吃 undefined doc / 非字符串 fullKey 一律 undefined', () => {
    for (const fn of [T.getIni, T.getIniRaw, T.getIniBool, T.getIniInt, T.getIniList]) {
      if (fn(undefined, 'a/b') !== undefined) return false
      if (fn(real, undefined) !== undefined) return false
      if (fn(real, 123) !== undefined) return false
      if (fn({}, 'config_version') !== undefined) return false
    }
    return true
  })
  guarded('stringLiterals(undefined/数字) → 空数组', () =>
    T.stringLiterals(undefined).length === 0 && T.stringLiterals(42).length === 0)
  guarded('iniResPaths(undefined / 缺 values 的文档) → 空数组', () =>
    T.iniResPaths(undefined).length === 0 && T.iniResPaths({}).length === 0 &&
    T.iniResPaths({ values: null }).length === 0)
  guarded('values 里混进畸形条目也不抛', () =>
    T.iniResPaths({ values: [{ section: 'a', key: 'b', raw: undefined, line: 1 }] }).length === 0)
}

main().catch((e) => {
  // 断言里不该抛错;真抛了(比如实现返回了 undefined)也要以退出码 1 收口,不能让 CI 看到绿。
  console.error(`\n测试脚本抛错: ${e && e.stack ? e.stack : e}`)
  process.exit(1)
}).then(() => {
  console.log(`\n${'='.repeat(56)}\nPASS ${pass}  FAIL ${failures.length}`)
  if (failures.length) { console.log('失败项:'); for (const f of failures) console.log('  - ' + f); process.exit(1) }
  console.log('全部通过')
})
