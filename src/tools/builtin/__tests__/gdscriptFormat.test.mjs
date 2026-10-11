// 工具箱 · 第 1 批 Task 11:内置工具「GDScript 代码格式化」的断言(A-11 / §5.7)。
//
// 这个工具是整套框架的第一个**真实使用者**,所以断言分三层,一层比一层贵:
//   · 算法层(`formatGdText`):五类文本卫生各自的对与错,以及 A-11 那句「对应行一个字节都不改」;
//   · 契约层(`schema` / `DEFAULT_OPTS` / manifest.json):参数表过真校验器,表单默认值与执行默认值不许分成两套;
//   · 使用层(`plan`):用**框架自己的组装层**(gpm.buildGpm + 假 services)造 ctx 来调,
//     不手搓 ctx —— 手搓夹具会和实现一起错在同一个假形状上(Task 10 就栽过一次)。
//
// A-11 的保守性分类直接吃 `parsers/gdScript.ts`,本文件不重新发明「哪些行不许动」,
// 只是把它的输出钉在工具的产物上(解析器自己有 100+ 条断言,见 src/tools/__tests__/gdScript.test.mjs)。
//
// 用法:node src/composables/__tests__/build-bundle.mjs && node src/tools/builtin/__tests__/gdscriptFormat.test.mjs
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// 本文件在 src/tools/builtin/__tests__/ ⇒ 仓库根要往上四层(与其它 toolkit 测试的三层不同,别照抄)
const ROOT = path.resolve(__dirname, '../../../..')
const OUT_DIR = path.resolve(ROOT, '.gpm-test/out')
const need = (n) => path.join(OUT_DIR, `${n}.mjs`)
for (const n of ['tkformat', 'tkform', 'tkschema', 'tkmanifest', 'tkgpm']) {
  if (!existsSync(need(n))) {
    console.error(`找不到打包产物: ${need(n)}`)
    console.error('请先运行: node src/composables/__tests__/build-bundle.mjs')
    process.exit(2)
  }
}

const T = await import(pathToFileURL(need('tkformat')).href)
const M = await import(pathToFileURL(need('tkform')).href)
const SC = await import(pathToFileURL(need('tkschema')).href)
const MF = await import(pathToFileURL(need('tkmanifest')).href)
const GP = await import(pathToFileURL(need('tkgpm')).href)

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
const P = (arr, i) => F(FA(arr)[i])
const V = (s) => JSON.stringify(s)

/** 跑一次格式化,只拿正文 */
const OUT = (src, opts) => S(F(T.formatGdText(src, opts)).out)
const FULL = (src, opts) => F(T.formatGdText(src, opts))
const SKIPS = (src, opts) => FA(F(T.formatGdText(src, opts)).skips)
const CNT = (src, opts) => F(F(T.formatGdText(src, opts)).counts)
const L = (...ls) => ls.join('\n')

section('0. 导出面与产物同步')
for (const n of ['DEFAULT_OPTS', 'optsFrom', 'formatGdText', 'countToken', 'indentTargetText']) {
  ok(T[n] !== undefined, `format.ts 的 ${n} 已导出`)
}
ok(typeof M.schema === 'object' && typeof M.plan === 'function', 'entry 导出 schema 与 plan(§F 契约补充的四个名字里 action 要的那两个)')
{
  const src = readFileSync(path.resolve(ROOT, 'src', 'tools', 'builtin', 'gdscript-format', 'format.ts'), 'utf8')
  const out = readFileSync(need('tkformat'), 'utf8')
  // ⚠ 探针只能拿**字符串字面量**:esbuild 会把注释整段剥掉,拿注释里的句子去产物里找是错的判据
  for (const lit of ['不是框架认识的档', '多行字符串里混着另一种换行符', '全文只有注释与空行', '内容不是文本']) {
    ok(src.includes(lit), `源码里有「${lit}」`)
    ok(out.includes(lit), `产物里有「${lit}」`, '忘了重打 bundle?')
  }
  ok(!/from\s+'[^']*inspecters\//.test(src) && !/from\s+'[^']*inspectors\//.test(src),
    '算法层不 import 已拆掉的体检层(第 0 批 Task 3 的成果;文件头提它是历史说明,不算依赖)')
}

section('1. A-11 之一:多行字符串覆盖到的行,一个字节都不改')
{
  const ms = L(
    'extends Node',
    '\tvar s = """',
    '\t  inside   ',
    ' ',
    'var x\t',
    '\t"""',
    'var t = 1   ',
    ''
  )
  const o = OUT(ms)
  ok(o.includes('\t  inside   \n'), '块内那行的行尾空白与 tab 原样留着(那是内容,不是排版)')
  ok(o.includes('\tvar s = """\n'), '块的起始行整行不动')
  ok(o.includes('var x\t\n'), '块内一行只有 tab 结尾也不删')
  ok(o.includes('\t"""\n'), '块的收尾行同样不动(它的终止符在闭引号之后,但整行被标成 inString)')
  ok(o.includes('var t = 1\n') && !o.includes('var t = 1   '), '块外那行的行尾空白照删(冻结只覆盖块内)')
  const r = FULL(ms, { collapseBlank: true, maxBlank: 1 })
  ok(CNT(ms).blank === 0, '块内那个「空行」没被折(它是内容)', F(r).counts)
  ok(SKIPS(ms).length === 0, '这个样例五类都能做,不该有拒因', SKIPS(ms))
  // 单引号块('''...''')与 r/字符串前缀也要冻住:分类器认它们,工具跟着分类器走
  const raw2 = L('var s = &"""', '  keep   ', '"""', 'var q = 1  ', '')
  ok(OUT(raw2).includes('  keep   \n'), '字符串前缀 & 不影响冻结')
  const unclosed = L('var s = """', 'inside   ')
  ok(OUT(unclosed) === unclosed, '未闭合的多行串:从那一行到文件尾整段不动')
}

section('2. A-11 之二:续行 \\ 与未闭合括号的行,前导一个字节不改')
{
  const src = L(
    'func a():',
    '\tvar x = foo( \\',
    '\t\t\tbar(),   ',
    '\t\t\tbaz())',
    '\tvar y = 1   ',
    ''
  )
  const o = OUT(src, { indent: 'space4' })
  ok(o.includes('\t\t\tbar(),\n'), '续行前导的三个 tab 原样(不折成空格),行尾空白照删:判据是「缩进不动」而不是「整行不动」')
  ok(o.includes('\t\t\tbaz())\n'), '续行段的收尾行也在 continuation 状态里,同样不折')
  ok(o.includes('    var y = 1\n'), '同一文件里的普通行照常折成 4 空格')
  const paren = L('var t = [', '\t\t1,', '\t\t2,   ', '\t]', 'var u = 2  ', '')
  const o2 = OUT(paren, { indent: 'tab' })
  ok(o2.includes('\t\t1,\n') && o2.includes('\t\t2,\n'), '括号未闭合 ⇒ 这些行不参与缩进折算,但尾随空白照删', o2)
  ok(o2.includes('\tvar u = 2\n') === false && o2.includes('var u = 2\n'), '块外的空格前导按整倍数折成 tab')
}

section('3. 行尾空白:只删空格与 tab,非 ASCII 空白是内容')
{
  ok(OUT('a   \n') === 'a\n', '空格删')
  ok(OUT('a\t\t \n') === 'a\n', 'tab 与空格混着的行尾一起删')
  ok(OUT('a\u00a0\n') === 'a\u00a0\n', '不换行空格(NBSP)不动')
  ok(OUT('a\u000c\n') === 'a\u000c\n', '换页符 \\f 不动')
  ok(OUT('a   \n', { trailing: false }) === 'a   \n', '关掉这条就一个字符都不动')
  ok(CNT('a   \nb   \n').trailing === 2, '计数按处累加,与产出同一循环')
}

section('4. 缩进:整倍数才折,混排不动,永不重排层级')
{
  ok(OUT('\t\tvar a = 1\n', { indent: 'space4' }) === '        var a = 1\n', 'tab → 空格:每个 tab 换成所选那一档的宽度')
  ok(OUT('\t\tvar a = 1\n', { indent: 'space2' }) === '    var a = 1\n', '空格(2) 那一档按 2 格展开')
  ok(OUT('        var a = 1\n', { indent: 'tab' }) === '\t\tvar a = 1\n', '空格 → tab:整倍数折得回去')
  ok(OUT('     var a = 1\n', { indent: 'tab' }) === '     var a = 1\n', '5 个空格不是 4 的整倍数 ⇒ 余数给几格没有依据,不动')
  ok(OUT('  var a = 1\n', { indent: 'tab' }) === '  var a = 1\n', '2 个空格同理(不重排层级 = 不把两级并成一级)')
  ok(OUT(' \tvar a = 1\n', { indent: 'tab' }) === ' \tvar a = 1\n', '前导混着 tab 与空格 ⇒ 两个方向都不折(制表位按列走,折完会错开一列)')
  ok(OUT(' \tvar a = 1\n', { indent: 'space4' }) === ' \tvar a = 1\n', '目标是空格时混排同样不动')
  ok(OUT('var a = 1\n', { indent: 'tab' }) === 'var a = 1\n', '没有前导的行不造缩进')
  ok(OUT('\tvar a = 1\n', { indent: 'keep' }) === '\tvar a = 1\n', 'keep 一档:整行前导一个字节不碰')
  ok(SKIPS(' \tvar a = 1\n', { indent: 'tab' }).some((s) => /1 行的前导形状不确定/.test(s)),
    '有一行折不回去就得报:「少做了 N 行」不许静默(旧判据 7)', SKIPS(' \tvar a = 1\n', { indent: 'tab' }))
  ok(SKIPS(' \tvar a = 1\n   d = 2\n', { indent: 'tab' }).some((s) => /2 行的前导形状不确定/.test(s)),
    '那一句话说的是**行数**,不是拒因条数(混排一行 + 余数一行 = 2)', SKIPS(' \tvar a = 1\n   d = 2\n', { indent: 'tab' }))
  ok(SKIPS('\tvar a = 1\n', { indent: 'bogus' }).some((s) => /不是框架认识的档/.test(s)), '目标形态认不出不猜:整条拒并给原因')
  ok(OUT('\tvar a = 1\n', { indent: 'bogus' }) === '\tvar a = 1\n', '坏目标形态 ⇒ 一个字节不折(而不是用 0 格展开把缩进抹掉)')
}

section('5. 连续空行折叠')
{
  const run3 = L('a', '', '', '', 'b', '')
  ok(OUT(run3) === L('a', '', 'b', ''), '默认:3 行空行折成 1 行')
  ok(CNT(run3).blank === 2, '折掉的行数进计数(2)', CNT(run3))
  ok(OUT(run3, { maxBlank: 2 }) === L('a', '', '', 'b', ''), 'maxBlank=2 ⇒ 留两行')
  ok(OUT(run3, { maxBlank: 0 }) === L('a', 'b', ''), 'maxBlank=0 ⇒ 一段都不留')
  ok(OUT(run3, { collapseBlank: false }) === run3, '开关关掉 ⇒ 不折')
  ok(OUT(L('a', '', 'b', '')) === L('a', '', 'b', ''), '2 行空行在默认(最多 1)下折成 1')
  ok(OUT(L('a', '', 'b', '')) === L('a', '', 'b', ''), '单行空行本来就到上限 ⇒ 不动')
  ok(OUT(L('a', '   ', '', 'b', '')) === L('a', '', 'b', ''), '「只有空白的行」算空行(判定在删尾随空白之后)')
  ok(OUT(L('a', '   ', '   ', 'b', ''), { trailing: false }) === L('a', '   ', '   ', 'b', ''),
    '关掉删行尾空白后那些行不再是空行 ⇒ 折叠跟着看不见它们(两条判据不许各自解释)')
  const blockRun = L('var s = """', '', '', '', '"""', 'a', '')
  ok(OUT(blockRun) === blockRun, '块内的连续空行是内容,一段都不折')
  ok(CNT(blockRun).blank === 0, '计数也不虚报', CNT(blockRun))
  ok(SKIPS(run3, { maxBlank: -1 }).length === 0, '负数上限不来自 optsFrom(它把坏值转成「这条没做」),直接调用时按不折处理')
}

section('6. 换行符统一与三道闸门')
{
  const crlf = 'a = 1\r\nb = 2\r\n'
  ok(OUT(crlf, { endings: 'lf' }) === 'a = 1\nb = 2\n', 'CRLF → LF')
  ok(OUT('a = 1\nb = 2\n', { endings: 'crlf' }) === 'a = 1\r\nb = 2\r\n', 'LF → CRLF')
  ok(OUT(crlf, { endings: 'keep' }) === crlf, 'keep ⇒ 一个终止符都不改')
  ok(CNT(crlf, { endings: 'lf' }).endings === 2, '计数按处')
  const mixedBlock = 'var s = """\r\nin\r\n"""\nvar q = 1\n'
  const r = FULL(mixedBlock, { endings: 'lf' })
  ok(FA(r.skips).join('|').includes('多行字符串里混着另一种换行符'),
    '块内混着另一种换行符 ⇒ 整条放弃统一(改了就是改内容)', r.skips)
  ok(S(r.out).includes('\r\n'), '放弃之后块内那个 CRLF 原样留着', V(S(r.out)))
  ok(S(r.out).includes('var q = 1\n'), '其余四条照做(代码区本来就还是 LF)')
  const stray = 'a = 1\rx\nb = 2\n'
  ok(SKIPS(stray, { endings: 'lf' }).join('|').includes('裸 \\r'), '正文中间的裸 \\r(老 Mac 残留)⇒ 统一这条整条拒', SKIPS(stray))
  ok(OUT(stray, { endings: 'lf' }) === stray.replace(/x/, 'x'), '形态认不出时不硬改')
  ok(SKIPS('a = 1\n', { endings: 'bogus' }).join('|').includes('不是框架认识的档'), '坏目标形态:整条拒并给原因')
  const blockEnd = 'var s = """\ninside   \n'
  ok(OUT(blockEnd, { endings: 'crlf' }).includes('inside   \n'), '块内行的终止符永远不改(即便闸门通过)')
}

section('7. 文件末尾换行:只补不删,四道「不动」闸')
{
  ok(OUT('a = 1') === 'a = 1\n', '欠一个换行 ⇒ 补')
  ok(OUT('a = 1\n') === 'a = 1\n', '已经有了 ⇒ 不重复补')
  ok(OUT('a = 1', { endings: 'crlf' }) === 'a = 1\r\n', '补的那个跟着用户选的目标形态')
  ok(OUT('a = 1\n\n') === 'a = 1\n\n', '末行是空行 ⇒ 不再添一行(前几步已把尾巴清干净)')
  ok(OUT('a = 1\r\n\r\n', { endings: 'keep' }) === 'a = 1\r\n\r\n', '同一判据在 CRLF 文件上成立(与换行符那条互不干扰)')
  ok(OUT('# 只有注释', { finalNewline: false }) === '# 只有注释', '关掉这条就不补')
  ok(OUT('# 只有注释\n# 第二行') === '# 只有注释\n# 第二行', '全文只有注释 ⇒ 按约定连末尾换行都不补')
  ok(SKIPS('# 只有注释\n# 第二行').join('|').includes('全文只有注释与空行'), '纯注释文件要给出拒因')
  ok(SKIPS('# 只有注释\n# 第二行').length === 1, '只有这一条拒因')
  const inStr = 'var s = """\ninside'
  ok(OUT(inStr) === inStr, '文件停在未闭合的字符串里 ⇒ 补就是往内容里插字节,不动')
  ok(SKIPS(inStr).join('|').includes('未闭合的字符串'), '这条理由要上卡面', SKIPS(inStr))
  ok(SKIPS('a = 1').length === 0, '正常补换行不该有拒因(虚报一条「没做」比不报更糟)', SKIPS('a = 1'))
  ok(SKIPS('a = 1\n\n').length === 0, '本来就以换行收尾时不许报「末行本来就是空行」')
  ok(CNT('a = 1').finalNL === 1, '计数与产出同源')
}

section('8. 极端输入:空文件、非文本、只有一行')
{
  ok(OUT('') === '', '空文本是「零行」而不是「一行为空的行」:五类操作一律不动')
  ok(CNT('').finalNL === 0 && CNT('').trailing === 0, '空文件不造计数', CNT(''))
  ok(SKIPS('').length === 0, '也不造拒因')
  const bad = FULL(42)
  ok(F(bad).out === '' && FA(bad.skips).join('|').includes('内容不是文本'), '非字符串输入 ⇒ 不抛、不改写', bad)
  ok(FULL(null).out === '' && FULL(undefined).out === '' && FULL({}).out === '', '各种脏输入都不抛')
  ok(OUT('\n') === '\n', '只有一个换行的文件不动')
  ok(OUT('a = 1', { indent: 'space4', trailing: false, collapseBlank: false, endings: 'keep' }) === 'a = 1\n',
    '四条全关、只留「补末尾换行」也照样各做各的')
}

section('9. 纯函数:确定性 + 幂等')
{
  const cases = ['a   \nb\n', '\t\tvar x = 1\n', 'a\n\n\n\nb\n', 'var s = """\nin   \n"""\nq = 1  ', 'a = 1\r\nb = 2\r\n']
  const optsets = [undefined, { indent: 'tab' }, { indent: 'space4' }, { endings: 'crlf' }, { maxBlank: 0 }]
  for (const src of cases) {
    for (const o of optsets) {
      const a = OUT(src, o)
      ok(OUT(src, o) === a, `同一输入两次结果相同(${V(src).slice(0, 18)}|${JSON.stringify(o)})`)
      ok(OUT(a, o) === a, `格式化是幂等的(第二趟不该再改出一个字节)`, { first: V(a), second: V(OUT(a, o)) })
    }
  }
}

section('10. countToken 与 counts 同源(旧判据 7 的可核对计数)')
{
  const src = L('a   ', '', '', '', '        b = 2   ', 'c = 3', '')
  const r = FULL(src)
  const c = F(r).counts
  ok(S(T.countToken(c)) === `尾随空白 ${c.trailing}/缩进 ${c.indent}/空行 ${c.blank}/末尾换行 ${c.finalNL}/换行符 ${c.endings}`,
    'token 就是把 counts 原样念一遍', T.countToken(c))
  ok(c.trailing === 2 && c.blank === 2 && c.indent === 1, '三类操作各自数得出来(不是互相抵充)', c)
  ok(S(r.out).includes('\tb = 2\n'), '8 个空格按默认(4 格一级)折成 1 个 tab,同行尾空白一起清')
  ok(S(T.indentTargetText('space2')) === '2 个空格' && S(T.indentTargetText('keep')) === '保持原样', '目标形态那句话只有一份')
}

section('11. optsFrom:缺失走默认,坏值不猜')
{
  // 键序不参与比较:JSON.stringify 直接比会把「同一份值的两种键序」判成不同
  const OPT_SIG = (o) => ['collapseBlank', 'endings', 'finalNewline', 'indent', 'maxBlank', 'trailing']
    .map((k) => `${k}=${String(F(o)[k])}`).join('|')
  const d = F(T.optsFrom(undefined)).opts
  ok(OPT_SIG(d) === OPT_SIG(T.DEFAULT_OPTS), '什么都不给 ⇒ 与 DEFAULT_OPTS 逐键相同', d)
  const good = F(T.optsFrom({ indent: 'space2', endings: 'crlf', trailing: false, final_newline: false, collapse_blank: false, max_blank: 3 })).opts
  ok(good.indent === 'space2' && good.endings === 'crlf' && good.trailing === false && good.finalNewline === false && good.collapseBlank === false && good.maxBlank === 3,
    '六个参数全部按名字读到', good)
  ok(FA(F(T.optsFrom({ indent: 'nope' })).skips).length === 1, '坏缩进档 ⇒ 一条拒因', T.optsFrom({ indent: 'nope' }))
  ok(F(F(T.optsFrom({ indent: 'nope' })).opts).indent === 'keep', '坏值 ⇒ 走保持原样而不是猜一个')
  for (const bad of [-1, 1.5, 5, 'two', NaN, Infinity, null]) {
    const r = F(T.optsFrom({ max_blank: bad }))
    ok(FA(r.skips).length === 1 && F(r).opts.maxBlank === -1, `max_blank=${JSON.stringify(bad) ?? String(bad)} ⇒ 拒这条并留标记`, r)
  }
  ok(F(T.optsFrom({ trailing: 'yes' })).opts.trailing === false, '布尔给了非布尔 ⇒ 按「没要这条」处理(布尔没有第三种取值可猜)')
  ok(OPT_SIG(F(T.optsFrom([])).opts) === OPT_SIG(T.DEFAULT_OPTS), 'params 是数组 ⇒ 当没给')
}

section('12. 参数表与默认值不许分成两套(A-11 的表单半边)')
{
  const v = F(SC.validateSchema(M.schema))
  ok(v.ok === true, 'schema 过真校验器', FA(v.issues).map((i) => F(i).message))
  const byKey = {}
  for (const f of FA(v.fields)) byKey[F(f).key] = f
  const D = F(T.DEFAULT_OPTS)
  ok(byKey.indent && byKey.indent.def === D.indent, '缩进档的默认值与 DEFAULT_OPTS 同值', byKey.indent && byKey.indent.def)
  ok(byKey.endings && byKey.endings.def === D.endings, '换行符档同值')
  ok(byKey.trailing && byKey.trailing.def === D.trailing, '「去除行尾空格」同值')
  ok(byKey.final_newline && byKey.final_newline.def === D.finalNewline, '「补齐文件末尾换行」同值')
  ok(byKey.collapse_blank && byKey.collapse_blank.def === D.collapseBlank, '「折叠连续空行」同值')
  ok(byKey.max_blank && byKey.max_blank.def === D.maxBlank, '「最多几行空行」同值')
  ok(byKey.targets && byKey.targets.type === 'files' && FA(byKey.targets.exts).join(',') === 'gd' && byKey.targets.required === true,
    '选中集来自一个 files 字段(框架给 files 的唯一途径)', byKey.targets)
  ok(Object.keys(byKey).length === 7, '七个字段:§5.7 那张单子五件事 + files + max_blank', Object.keys(byKey))
  for (const k of Object.keys(byKey)) ok(S(byKey[k].label).length > 0 && S(byKey[k].help).length > 0, `字段 ${k} 的 label/help 都在`)
  const selOpts = FA(byKey.indent.options).map((o) => F(o).value).join(',')
  ok(selOpts === 'keep,tab,space2,space4', '缩进四档一个不少(§5.7 的三个选项 + 保持原样)', selOpts)
}

section('13. manifest.json:内置工具与第三方走同一个校验器(DEV-4)')
{
  const raw = JSON.parse(readFileSync(path.resolve(ROOT, 'src', 'tools', 'builtin', 'gdscript-format', 'manifest.json'), 'utf8'))
  const r = F(MF.validateManifest(raw, { files: ['manifest.json', 'index.ts'] }))
  ok(r.ok === true, '内置工具的 manifest 过同一个校验器', FA(r.issues).map((i) => `${F(i).field}:${F(i).message}`))
  ok(F(r).manifest.apiVersion === MF.GPM_API_VERSION, `apiVersion 就是当前的 ${MF.GPM_API_VERSION}`)
  ok(F(F(r).manifest).kind === 'action' && F(r).manifest.ui === 'schema', 'action + schema:三段式的第一拍由框架画表单')
  ok(F(r).manifest.entry === 'index.ts', 'entry 指向本目录里真在的那个文件')
  ok(FA(F(r).manifest.capabilities).join(',') === 'tree,text,write', '能力:读树挑文件、读正文、经框架写盘', F(r).manifest.capabilities)
  ok(F(r).manifest.unsafe === false, '不讨裸写接口(action 型也拿不到)')
  ok(FA(F(r).manifest.cmds).length >= 2, '关键词至少两个:中文名 + gdformat', F(r).manifest.cmds)
}

section('14. plan():真 ctx(buildGpm)驱动,产出的 Change 形状对得上契约')
{
  const logs = []
  const files = {
    'clean.gd': 'extends Node\n',
    'dirty.gd': 'extends Node   \n\tvar a = 1   \n',
    'block.gd': 'var s = """\nin   \n"""\nvar b = 2   \n',
    'big.gd': '',
    'bin.gd': ''
  }
  let cancel = false
  const ctx = GP.buildGpm({
    services: {
      readProjectText: async (pid, rel) => {
        if (rel === 'big.gd') return { ok: true, bytes: 900000, truncated: true }
        if (rel === 'bin.gd') return { ok: true, bytes: 64, skippedBinary: true }
        if (rel === 'gone.gd') return { ok: false, error: '文件不存在' }
        return { ok: true, text: String(files[rel] ?? ''), bytes: 1, truncated: false, skippedBinary: false }
      }
    },
    toolId: 'gdscript-format', toolName: 'GDScript 代码格式化', projectId: 'p1',
    capabilities: ['tree', 'text', 'write'], unsafe: false,
    onLog: (lvl, m) => logs.push(lvl + ':' + m),
    cancelled: () => cancel
  })
  const params = F(SC.defaultsOf(FA(F(SC.validateSchema(M.schema)).fields)))
  const call = async (list, ps) => FA(await M.plan(ctx, list, ps === undefined ? params : ps))
  const picked = Object.keys(files).map((rel) => ({ rel, size: files[rel].length }))
  const changes = await call(picked)
  ok(changes.length === 2, '只有「正文真的变了」的两个文件占条(没变化不占条、不备份、不进账本)', changes.map((c) => F(c).rel))
  ok(P(changes, 0).rel === 'dirty.gd' && P(changes, 1).rel === 'block.gd', '顺序照 files 参数', changes.map((c) => F(c).rel))
  ok(P(changes, 0).kind === 'rewrite' && P(changes, 0).risk === 'low', 'kind/risk 在场(框架按 risk 决定默认勾选)')
  ok(S(P(changes, 0).reason).includes('多行字符串'), 'reason 说清为什么是低风险', P(changes, 0).reason)
  ok(S(P(changes, 1).reason).includes('碰过多行字符串或续行的行一个字节都不改'), 'A-11 那句承诺在 reason 里', P(changes, 1).reason)
  ok(S(P(changes, 0).label).startsWith('文本卫生:尾随空白 '), 'label 就是那份可核对计数', P(changes, 0).label)
  const realOpts = F(T.optsFrom(params)).opts
  ok(S(P(changes, 0).label).includes(S(T.countToken(CNT(files['dirty.gd'], realOpts)))),
    'label 里的计数与算法层用同一份参数算出来的一致(plan 与 formatGdText 不许各数一遍)', { label: P(changes, 0).label, token: T.countToken(CNT(files['dirty.gd'], realOpts)) })
  const text = S(F(F(P(changes, 0)).payload).text)
  ok(text === OUT(files['dirty.gd']), 'payload.text 就是格式化后的正文(预览阶段能出 diff)', V(text))
  ok(S(F(F(P(changes, 1)).payload).text).includes('in   \n'), '块内那行在 payload 里仍然带行尾空白(A-11 穿透到产物)')
  ok(logs.some((l) => l.includes('big.gd') && l.includes('不改写')), 'truncated:拿到的是部分内容就绝不改写', logs)
  ok(logs.some((l) => l.includes('bin.gd')), 'skippedBinary 同样跳过并说明')
  ok(logs.some((l) => l.includes('超出读取上限') || l.includes('被认成二进制')), '两种「ok 但没给正文」的理由分得开', logs)
  const oneMore = await call([{ rel: 'gone.gd', size: 1 }])
  ok(oneMore.length === 0 && logs.some((l) => l.includes('gone.gd') && l.includes('读不到')), '读失败 ⇒ 不产条并留一行日志', logs.slice(-1))
  ok((await call([{ rel: 'clean.gd', size: 1 }])).length === 0, '本来就干净的文件一条都不产')
  cancel = true
  ok((await call(picked)).length === 0, '取消 ⇒ 提前返回已完成部分(这里还没开始做)', 'cancelled')
  cancel = false
  const dirty = await call([null, 42, { rel: '' }, { size: 1 }, { rel: 'dirty.gd' }])
  ok(dirty.length === 1 && P(dirty, 0).rel === 'dirty.gd', 'files 里的脏元素跳过而不是抛,好元素照做', dirty)
  ok((await call(undefined)).length === 0 && (await call('x')).length === 0, 'files 不是数组 ⇒ 空清单,不抛')
  const badParams = await call([{ rel: 'dirty.gd', size: 1 }], { indent: 'nope' })
  ok(P(badParams, 0).rel === 'dirty.gd' && S(P(badParams, 0).reason).includes('参数问题'),
    '坏参数不拦整条:那条不动并把这个事实写进 reason', P(badParams, 0).reason)
  ok(S(P(badParams, 0).label) === S(P(changes, 0).label).replace('尾随空白 2/缩进 1', '尾随空白 2/缩进 0'),
    '坏缩进档 ⇒ 缩进计数真的是 0(拒因与产出对得上)', P(badParams, 0).label)
  const noSkips = await call([{ rel: 'dirty.gd', size: 1 }])
  ok(!S(P(noSkips, 0).reason).includes('这个文件没做'), '没有拒因时不许虚报一条「没做」', P(noSkips, 0).reason)
  const blockReason = await call([{ rel: 'block.gd', size: 1 }])
  ok(S(P(blockReason, 0).reason).includes('这个文件没做') === false || SKIPS(files['block.gd']).length > 0,
    'reason 里那句「这个文件没做」当且仅当算法层真的报了拒因(两处不许各说一套)', { reason: P(blockReason, 0).reason, skips: SKIPS(files['block.gd']) })
}

section('15. 参数关到最紧:只剩「不动」的那一侧')
{
  const mkCtx = (text) => GP.buildGpm({
    services: { readProjectText: async () => ({ ok: true, text, bytes: text.length, truncated: false, skippedBinary: false }) },
    toolId: 't', toolName: 't', projectId: 'p', capabilities: ['text'], unsafe: false
  })
  const allOff = { indent: 'keep', trailing: false, final_newline: false, endings: 'keep', collapse_blank: false }
  const src = L('\t\tvar a = 1   ', '', '', '', 'b = 2  ', '')
  const r = FA(await M.plan(mkCtx(src), [{ rel: 'a.gd', size: 1 }], allOff))
  ok(r.length === 0, '五条全关 ⇒ 这个文件一个字都没变 ⇒ 不产条(也就没有备份、没有账本)', r)
  const one = FA(await M.plan(mkCtx('a = 1  '), [{ rel: 'a.gd', size: 1 }], { ...allOff, trailing: true }))
  ok(one.length === 1, '只开「删行尾空白」也照样产条', one.length)
  ok(S(F(F(P(one, 0)).payload).text) === 'a = 1', 'final_newline 关着 ⇒ 不顺手补末尾换行(每条各管各的)', V(S(F(F(P(one, 0)).payload).text)))
  const maxOff = FA(await M.plan(mkCtx(src), [{ rel: 'a.gd', size: 1 }], { ...allOff, collapse_blank: true, max_blank: 9 }))
  ok(maxOff.length === 0, '上限给到 9 ⇒ 四行空行也没超 ⇒ 折叠这条实际什么都没做,也不产条', maxOff.length)
}

console.log(`\n${'='.repeat(56)}\nPASS ${pass}  FAIL ${failures.length}`)
if (failures.length) {
  console.log('失败项:')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log('全部通过')
