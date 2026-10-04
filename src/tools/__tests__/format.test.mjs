// 工具页 B9:代码格式化(只做文本卫生)的断言。被测:src/tools/inspectors/format.ts(+ parsers/gdScript.ts)。
//
// ⚠ B9 是 P0b 里唯一**改写用户源代码**的工具。前面六个要么只报告、要么删整个文件(还有回收站兜底)。
//   备份能还原文件,还原不了「500 行无关 diff 污染下一次提交」。所以这里的断言方向与别的 harness 相反:
//   别家钉「报得全不全」,这里钉的是「**不该动的字节一个都没动**」。五类操作逐条给新文本时一律用
//   **逐字节等值**(`out === 期望`),不许用「包含」糊。
//
// ★ 三条命门(简报点名的):
//   1) `"""` 块免疫:块内的行尾空白、缩进、空行、CRLF 全部原样(那是字符串内容);
//   2) 未闭合引号的保守方向:引号不成对之后,后续行的行尾空白**不许被删**,直到闭合;
//   3) 判据 5 的换行符优先序:多行字符串里混着非主导换行符 ⇒ 只对这一个文件放弃「换行符统一」,
//      其余四条照做,detail 里说清为什么少做了一条。
//
// 计数交叉核对(measureDelta):新文本是「产出」、detail 里的计数是「账」,两笔必须对得上 ——
// 用户会按那个数字决定要不要点改写,账与产出分叉就是真缺陷。measureDelta 只读两份文本自己算第二趟,
// 不碰实现里的任何计数,也算不出「这行在字符串里」(那是分类器的事,由 gdScript.test.mjs 单独钉);
// 它只按位置比对行与前导/尾部空白、终止符、空行段,所以任何**未被四类计数解释**的字节变化都会落进 other。
//
// 夹具是「内存文件树 + readText 桩」,与 ini/imports/addons 测试同一份口径。
// 用法(npm script 会先跑打包步骤):
//   node src/composables/__tests__/build-bundle.mjs && node src/tools/__tests__/format.test.mjs
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

/** ext 推导与原语两端逐字一致(照 ini/addons/imports 测试的同一份实现) */
function extOf(rel) {
  const base = rel.slice(rel.lastIndexOf('/') + 1)
  const i = base.lastIndexOf('.')
  return i > 0 ? base.slice(i + 1).toLowerCase() : ''
}
function tree(specs) {
  const base = Date.UTC(2026, 0, 1)
  return specs.map(([rel, size, off = 0]) => ({ rel, size, mtimeMs: base + off * 86400000, ext: extOf(rel) }))
}
/** 内存 ctx 工厂:fail 里的 rel 走指定返回形态(不给 text 就是读不到),其余只认 texts */
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

/** 逐行给正文(末尾自动补换行)——真实 .gd 的常态 */
function L(...lines) { return lines.join('\n') + '\n' }
const J = (s) => JSON.stringify(s)
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 单文件跑一趟 */
async function one(rel, text, fail = {}) {
  const { ctx, calls } = makeCtx([[rel, Buffer.byteLength(text)]], { texts: { [rel]: text }, fail })
  return { findings: await T.runFormat(ctx), calls }
}
/** 多文件一趟(顺序就是传参顺序,反序/交错那两条另走 runCtx) */
async function many(texts, opts = {}) {
  const specs = Object.entries(texts).map(([rel, t]) => [rel, Buffer.byteLength(t)])
  const { ctx, calls } = makeCtx(specs, { texts, trunc: opts.trunc === true, fail: opts.fail || {} })
  return { findings: await T.runFormat(ctx), calls }
}
const filesOf = (f) => (f && f.fix && f.fix.payload && f.fix.payload.files) || []
const outOf = (f, rel) => { const x = filesOf(f).find((y) => y.rel === rel); return x ? x.text : undefined }
/** detail 里某个文件的五类计数(读回来与 measureDelta 对账) */
function reported(detail, rel) {
  const m = new RegExp(esc(rel) + '\\[尾随空白 (\\d+)/缩进 (\\d+)/空行 (\\d+)/末尾换行 (\\d+)/换行符 (\\d+)\\]').exec(detail)
  return m ? { trailing: +m[1], indent: +m[2], blank: +m[3], finalNL: +m[4], endings: +m[5] } : null
}
const KEYS = ['trailing', 'indent', 'blank', 'finalNL', 'endings']

/** 行切分:rows 不含终止符,terms 逐行给形态('' = 末行不带换行)。只看形状,不做任何判定 */
function shape(text) {
  const parts = text.split('\n')
  const drop = parts.length > 1 && parts[parts.length - 1] === ''
  const n = drop ? parts.length - 1 : parts.length
  const rows = []
  const terms = []
  for (let i = 0; i < n; i++) {
    const cr = parts[i].endsWith('\r')
    const term = i < n - 1 || drop ? (cr ? '\r\n' : '\n') : ''
    rows.push(cr && term !== '' ? parts[i].slice(0, -1) : parts[i])
    terms.push(term)
  }
  return { rows, terms, n }
}
const isBlank = (s) => s === '' || /^[ \t]+$/.test(s)
const lead = (s) => /^[ \t]*/.exec(s)[0]

/**
 * 第二趟纯比较:只拿**原文**与**新文本**算五类操作各实际改了几处,完全不读实现里的计数。
 * 对齐规则:非空行一对一;空行段原文 len 行、新文本保留 min(len, 1 if len>=3 else len) 行,
 * 且保留的是段内**最后**那一行(与实现的取舍同形 —— 这只影响位置对齐,不影响任何计数)。
 * 任何落不进四类形状的差别都算进 other,由调用处断言 other === 0。
 */
function measureDelta(oldText, newText) {
  const o = shape(oldText)
  const n = shape(newText)
  const d = { trailing: 0, indent: 0, blank: 0, finalNL: 0, endings: 0, other: 0 }
  const segs = []
  for (let i = 0; i < o.n;) {
    if (isBlank(o.rows[i])) {
      let k = i
      while (k < o.n && isBlank(o.rows[k])) k++
      segs.push({ blank: true, from: i, to: k })
      i = k
    } else {
      segs.push({ blank: false, from: i, to: i + 1 })
      i++
    }
  }
  let j = 0
  const term = (ot, nt) => {
    if (ot === nt) return
    if (ot === '' && nt !== '') d.finalNL++
    else if ((ot === '\n' && nt === '\r\n') || (ot === '\r\n' && nt === '\n')) d.endings++
    else d.other++
  }
  for (const s of segs) {
    const len = s.to - s.from
    if (!s.blank) {
      const ob = o.rows[s.from]
      const nb = n.rows[j]
      if (nb === undefined) { d.other++; continue }
      if (lead(ob) !== lead(nb)) d.indent++
      const oRest = ob.slice(lead(ob).length)
      const nRest = nb.slice(lead(nb).length)
      if (/[ \t]$/.test(oRest) && !/[ \t]$/.test(nRest)) d.trailing++
      else if (oRest !== nRest) d.other++
      term(o.terms[s.from], n.terms[j])
      j++
      continue
    }
    const kept = len >= 3 ? 1 : len
    if (len >= 3) d.blank += len - 1
    for (let q = s.to - kept; q < s.to; q++) {
      const ob = o.rows[q]
      const nb = n.rows[j]
      if (nb === undefined) { d.other++; continue }
      if (ob === nb) { /* 空行内容没变 */ }
      else if (nb === '' && ob !== '') d.trailing++ // 只剩空白的行被清空,那是「删行尾空白」
      else d.other++
      term(o.terms[q], n.terms[j])
      j++
    }
  }
  if (j !== n.n) d.other++ // 新文本多出来的行(格式化不该新增任何行)
  return d
}

const ALL = []

async function main() {
  // ---------- 1. 干净文件 ----------
  section('1. 干净文件 → 零结论')
  const CLEAN = L('extends Node', '', '# 顶部注释', '', 'func _ready() -> void:',
    '\tvar t := Toplevel.new()', '\tadd_child(t)', '\tprint("""多行', '\t内容   ', '\t""")')
  const c1 = await one('clean.gd', CLEAN)
  ok(c1.findings.length === 0, '判据 7:全 tab、无尾随空白、末尾单换行、无三连空行 → 一条结论都不发',
    J(c1.findings.map((f) => f.id)))
  ok(c1.calls.length === 1 && c1.calls[0] === 'clean.gd', '判据 8:一个候选 .gd 只读一次', J(c1.calls))
  ALL.push(...c1.findings)

  // ---------- 2. 五类操作各一例,新文本逐字节 ----------
  section('2. 五类操作各一例(新文本逐字节)')
  const tTrail = 'var a = 1   \n# 注释\t\nvar s = """\n块内   \n"""\nvar b = 2\t\n'
  const rTrail = await one('a.gd', tTrail)
  ok(outOf(rTrail.findings[0], 'a.gd') === 'var a = 1\n# 注释\nvar s = """\n块内   \n"""\nvar b = 2\n',
    '(a) 判据 2:删行尾空白只动非字符串行(块内的尾随空格逐字节留着)', J(outOf(rTrail.findings[0], 'a.gd')))
  ok(reported(rTrail.findings[0].detail, 'a.gd')?.trailing === 3,
    '判据 7:计数说 3 处(代码行、注释行、块外那行)', J(reported(rTrail.findings[0].detail, 'a.gd')))
  ok(outOf(rTrail.findings[0], 'a.gd')?.includes('\t') === false,
    '判据 2:注释行末尾那个 tab 也算行尾空白被删', J(outOf(rTrail.findings[0], 'a.gd')))
  ALL.push(...rTrail.findings)

  const tIndent = L('func f():', '\tvar a = 1', '    var b = 2', '        var c = 3')
  const rIndent = await one('b.gd', tIndent)
  ok(outOf(rIndent.findings[0], 'b.gd') === L('func f():', '    var a = 1', '    var b = 2', '        var c = 3'),
    '(b) 判据 3:多数派是空格 → 那行 tab 前导按 4 格展开,只动整行前导', J(outOf(rIndent.findings[0], 'b.gd')))
  ok(reported(rIndent.findings[0].detail, 'b.gd')?.indent === 1, '判据 7:缩进计 1 行')
  ALL.push(...rIndent.findings)

  const rFinal = await one('c.gd', 'var a = 1\nvar b = 2')
  ok(outOf(rFinal.findings[0], 'c.gd') === 'var a = 1\nvar b = 2\n',
    '(c) 判据 5 表:末行没有换行 → 补一个 \\n', J(outOf(rFinal.findings[0], 'c.gd')))
  ok(reported(rFinal.findings[0].detail, 'c.gd')?.finalNL === 1, '判据 7:末尾换行计 1')
  ALL.push(...rFinal.findings)

  const rTerm = await one('d.gd', 'var a = 1\r\nvar b = 2\nvar c = 3\nvar d = 4\n')
  ok(outOf(rTerm.findings[0], 'd.gd') === 'var a = 1\nvar b = 2\nvar c = 3\nvar d = 4\n',
    '(d) 判据 5:代码区主导是 LF → 混进来的那行 CRLF 归一成 LF', J(outOf(rTerm.findings[0], 'd.gd')))
  ok(reported(rTerm.findings[0].detail, 'd.gd')?.endings === 1, '判据 7:换行符计 1 行')
  ALL.push(...rTerm.findings)

  const rBlank = await one('e.gd', 'var a = 1\n\n\n\nvar b = 2\n')
  ok(outOf(rBlank.findings[0], 'e.gd') === 'var a = 1\n\nvar b = 2\n',
    '(e) 判据 2:3 个连续空行压成 1 个', J(outOf(rBlank.findings[0], 'e.gd')))
  ok(reported(rBlank.findings[0].detail, 'e.gd')?.blank === 2, '判据 7:空行压缩按**删掉的行数**计 2')
  const rBlank2 = await one('e2.gd', 'var a = 1\n\nvar b = 2\n')
  ok(rBlank2.findings.length === 0, '判据 2:2 个连续空行不动(压缩只针对 3 行以上)', J(rBlank2.findings.map((f) => f.id)))
  ALL.push(...rBlank.findings)

  // ---------- 3. ★ 多行字符串免疫 ----------
  section('3. ★ """ / \'\'\' 块:块内的尾随空白/缩进/空行/CRLF 一律不动')
  const blockCRLF = 'var s = """\r\n\r\n\t  里面   \r\n"""\r\nvar x = 1   \r\n'
  const rBlock = await one('block.gd', blockCRLF)
  ok(outOf(rBlock.findings[0], 'block.gd') === 'var s = """\r\n\r\n\t  里面   \r\n"""\r\nvar x = 1\r\n',
    '★块内每一行(空行、缩进、尾随空格、CRLF)逐字节原样,只有块外那行的尾随空格被删',
    J(outOf(rBlock.findings[0], 'block.gd')))
  const rBlockBlank = await one('blockb.gd', 'var s = """\n\n\n\n"""\nvar a = 1   \n')
  ok(outOf(rBlockBlank.findings[0], 'blockb.gd') === 'var s = """\n\n\n\n"""\nvar a = 1\n',
    '★块内的 3 行以上空行是内容,压缩那条不许动它', J(outOf(rBlockBlank.findings[0], 'blockb.gd')))
  const rBlockClose = await one('blockc.gd', 'var doc = """\n\t第一行\t\n第二行\n"""  \nvar y = 2  \n')
  ok(outOf(rBlockClose.findings[0], 'blockc.gd') === 'var doc = """\n\t第一行\t\n第二行\n"""  \nvar y = 2\n',
    '★闭合行自己也算「整行在字符串里」:它末尾的两个空格留着,只有块外的行被清',
    J(outOf(rBlockClose.findings[0], 'blockc.gd')))
  const rOneLineBlock = await one('blockd.gd', 'var s = """abc"""   \nvar a = 1   \n')
  ok(outOf(rOneLineBlock.findings[0], 'blockd.gd') === 'var s = """abc"""   \nvar a = 1\n',
    '★起止同行的单行块也算碰过字符串:那一行不动(判据 1「块内每一行 inString」的推广侧)',
    J(outOf(rOneLineBlock.findings[0], 'blockd.gd')))
  ALL.push(...rBlock.findings, ...rBlockBlank.findings, ...rBlockClose.findings, ...rOneLineBlock.findings)

  // ---------- 4. ★ 未闭合引号的保守方向 ----------
  section('4. ★ 引号不成对:后续行的行尾空白不许被删')
  const rOpen = await one('open.gd', 'var s = "没闭合\nvar a = 1   \nvar b = 2   \n')
  ok(rOpen.findings.length === 0,
    '★未闭合引号一路到文件尾 ⇒ 没有任何一行敢动 → 零结论(绝不猜着改)', J(rOpen.findings.map((f) => f.id)))
  const tOpen2 = 'var s = "没闭合\nvar a = 1   \n这里闭合了"\nvar b = 2   \n'
  const rOpen2 = await one('open2.gd', tOpen2)
  ok(outOf(rOpen2.findings[0], 'open2.gd') === 'var s = "没闭合\nvar a = 1   \n这里闭合了"\nvar b = 2\n',
    '★闭合之前的行尾空白原样留着,闭合之后的那行才删', J(outOf(rOpen2.findings[0], 'open2.gd')))
  const rOpen3 = await one('open3.gd', "var s = '单引号没闭合\nvar a = 1   \n")
  ok(rOpen3.findings.length === 0, '★单引号同侧处理(不区分引号种类地保守)', J(rOpen3.findings.map((f) => f.id)))
  ALL.push(...rOpen2.findings)

  // ---------- 5. # 与引号互相免疫 ----------
  section('5. 字符串里的 # / 注释里的引号')
  const rHash = await one('hash.gd', 'var url = "http://x#frag"   \nvar s = "# 整行才是注释"\n')
  ok(outOf(rHash.findings[0], 'hash.gd') === 'var url = "http://x#frag"\nvar s = "# 整行才是注释"\n',
    '判据 1:# 在字符串里不是注释起点(串被正确闭合才能删掉那三个空格)', J(outOf(rHash.findings[0], 'hash.gd')))
  const rQ = await one('q.gd', '# 注释里有 " 和 \' 还有三个引号 """\nvar a = 1   \n')
  ok(outOf(rQ.findings[0], 'q.gd') === '# 注释里有 " 和 \' 还有三个引号 """\nvar a = 1\n',
    '★判据 1:注释里的引号既不进入字符串状态、也不开多行块(下一行的尾随空白照删)',
    J(outOf(rQ.findings[0], 'q.gd')))
  ALL.push(...rHash.findings, ...rQ.findings)

  // ---------- 6. 判据 4:续行与对齐缩进 ----------
  section('6. 判据 4:\\ 续行与未闭合括号里的对齐缩进不动')
  const tCont = L('var x = foo(', '\t"对齐的参数",', '"第二个")')
  const rCont = await one('cont.gd', tCont)
  ok(rCont.findings.length === 0,
    '★未闭合 ( 里的 tab 对齐既不被转换、也不参与多数派统计 → 整份文件零改动',
    J(outOf(rCont.findings[0], 'cont.gd')))
  // 多数派要**clearly** 是空格(两行 space vs 一行 tab),续行那两行的 tab 前导既不被转换、
  // 也不参与统计 —— 否则统计面会翻到 tab 那边(把这条改掉就是下面那个断言的红点)。
  const tCont2 = L('func f():', '    var a = 1', '    var b = 2', '\tvar c = 3',
    'var d = foo(', '\t\t"空格对齐",', '\t\t"第二行"')
  const rCont2 = await one('cont2.gd', tCont2)
  ok(outOf(rCont2.findings[0], 'cont2.gd') === L('func f():', '    var a = 1', '    var b = 2', '    var c = 3',
    'var d = foo(', '\t\t"空格对齐",', '\t\t"第二行"'),
    '★续行里的 tab 对齐保持原样(多数派是空格也不动它,普通行的 tab 才被转换)',
    J(outOf(rCont2.findings[0], 'cont2.gd')))
  // 变异取证补强:原来这份夹具里 tab 与空格各一行(平局)⇒ G6(续行状态不携带)在 format 侧零红。
  // 现在把多数派做成明确是空格,续行那一行才真正被「跳过转换」这条判据保护住。
  const tBs = 'func f():\n    var a = 1\n    var b = 2\nvar c = 3 \\\n\t继续   \n'
  const rBs = await one('bs.gd', tBs)
  ok(outOf(rBs.findings[0], 'bs.gd') === 'func f():\n    var a = 1\n    var b = 2\nvar c = 3 \\\n\t继续\n',
    '★判据 4:\\ 续行的下一行只删行尾空白、前导 tab 不转换(多数派明确是空格也不动它)',
    J(outOf(rBs.findings[0], 'bs.gd')))
  ok(reported(rBs.findings[0].detail, 'bs.gd')?.indent === 0,
    '判据 7:续行那一行不计进缩进改动(账上 0)', J(reported(rBs.findings[0].detail, 'bs.gd')))
  ALL.push(...rCont2.findings, ...rBs.findings)

  // ---------- 7. 判据 3:多数派、混用、平局 ----------
  section('7. 判据 3:多数派、混用、平局')
  const rTabOnly = await one('t1.gd', L('func f():', '\tif x:', '\t\treturn'))
  ok(rTabOnly.findings.length === 0, '只有 tab → 0 结论', J(rTabOnly.findings.map((f) => f.id)))
  const rSpOnly = await one('t2.gd', L('func f():', '    if x:', '        return'))
  ok(rSpOnly.findings.length === 0, '只有空格 → 0 结论')
  const rMix = await one('t3.gd', L('func f():', '    var a = 1', '\tvar b = 2', '        var c = 3'))
  ok(outOf(rMix.findings[0], 't3.gd') === L('func f():', '    var a = 1', '    var b = 2', '        var c = 3'),
    'tab/space 混用 → 报,并按多数派(空格)改写那一行', J(outOf(rMix.findings[0], 't3.gd')))
  ok(reported(rMix.findings[0].detail, 't3.gd')?.indent === 1, '判据 7:缩进计数 1')
  const rTie = await one('t4.gd', L('func f():', '\tvar a = 1', '    var b = 2'))
  ok(rTie.findings.length === 0, '★平局 → 保持原样(一个字都不改,所以也不发卡)',
    J(rTie.findings.map((f) => f.id)))
  const rTie2 = await one('t5.gd', L('func f():', '\tvar a = 1   ', '    var b = 2   '))
  ok(outOf(rTie2.findings[0], 't5.gd') === L('func f():', '\tvar a = 1', '    var b = 2'),
    '★平局时缩进不动,但其余四类照做(这里删了两处行尾空白)', J(outOf(rTie2.findings[0], 't5.gd')))
  ok(/统一缩进[^\n]*打平[^\n]*一处没改/.test(rTie2.findings[0].detail),
    '★判据 3/7:平局的「无法判定」写进 detail,不静默',
    rTie2.findings[0].detail.match(/统一缩进[^\n]*/)?.[0]?.slice(0, 80))
  const rOdd = await one('t6.gd', L('func f():', '\tvar a = 1', '\t\tvar b = 2', '  var c = 3   '))
  ok(outOf(rOdd.findings[0], 't6.gd') === L('func f():', '\tvar a = 1', '\t\tvar b = 2', '  var c = 3'),
    '目标 tab 时前导 2 空格不是 4 的整倍数 → 那行不动(只删它的行尾空白)',
    J(outOf(rOdd.findings[0], 't6.gd')))
  ok(/前导形状不确定/.test(rOdd.findings[0].detail), '判据 7:「为什么少做一行」写进 detail',
    rOdd.findings[0].detail.match(/统一缩进:[^\n]*/)?.[0]?.slice(0, 90))
  const rMixedLead = await one('t7.gd', L('func f():', '    var a = 1', ' \tvar b = 2   ', '    var c = 3'))
  ok(outOf(rMixedLead.findings[0], 't7.gd') === L('func f():', '    var a = 1', ' \tvar b = 2', '    var c = 3'),
    '★Fix3:前导混着 tab 与空格 ⇒ 那一行的缩进一律不转换(旧写法把 \' +tab 展开成 5 空格,' +
    '却拿不出「引擎按列计数」的证据:tab 是走到**下一个制表位**,\' +tab 落第 4 列,5 个空格落第 5 列)',
    J(outOf(rMixedLead.findings[0], 't7.gd')))
  ok(reported(rMixedLead.findings[0].detail, 't7.gd')?.indent === 0 &&
      /前导形状不确定/.test(rMixedLead.findings[0].detail),
    '判据 7:少做的这一行进「为什么少做」账(与目标 = tab 那一侧同一档,不再是单向静默)',
    J(reported(rMixedLead.findings[0].detail, 't7.gd')))
  const rMixedTab = await one('t8.gd', L('func f():', '\tvar a = 1   ', '\t \tvar b = 2', '\t\tvar c = 3'))
  ok(outOf(rMixedTab.findings[0], 't8.gd') === L('func f():', '\tvar a = 1', '\t \tvar b = 2', '\t\tvar c = 3'),
    '反向:目标 = tab 时混排前导折不出唯一形状 ⇒ 那行不动(只有别处的行尾空白被清)',
    J(outOf(rMixedTab.findings[0], 't8.gd')))
  ok(/前导形状不确定/.test(rMixedTab.findings[0].detail),
    '判据 7:「为什么少做一行」在 detail 里说得出具体行数', rMixedTab.findings[0].detail.match(/统一缩进:[^\n]*/)?.[0]?.slice(0, 80))
  ALL.push(...rMix.findings, ...rTie2.findings, ...rOdd.findings, ...rMixedLead.findings)

  // ---------- 8. ★ 判据 5:换行符与多行字符串的优先序 ----------
  section('8. ★ 判据 5:块内混着非主导换行符 → 只对这一条跳过')
  const tConflict = 'var s = """\n块内行   \n"""\r\nvar a = 1   \r\nvar b = 2\r\nvar c = 3\r\n'
  const rCon = await one('conflict.gd', tConflict)
  ok(outOf(rCon.findings[0], 'conflict.gd') === 'var s = """\n块内行   \n"""\r\nvar a = 1\r\nvar b = 2\r\nvar c = 3\r\n',
    '★块里那行 LF 留着、块内尾随空格留着;尾随空白照删;换行符一处都没统一',
    J(outOf(rCon.findings[0], 'conflict.gd')))
  ok(reported(rCon.findings[0].detail, 'conflict.gd')?.endings === 0,
    '判据 7:换行符计数为 0(账与产出一致)', J(reported(rCon.findings[0].detail, 'conflict.gd')))
  ok(/统一换行符[^\n]*多行字符串[^\n]*没做/.test(rCon.findings[0].detail),
    '★判据 5/7:detail 说清这条为什么跳过', rCon.findings[0].detail.match(/统一换行符[^\n]*/)?.[0]?.slice(0, 80))
  ok(reported(rCon.findings[0].detail, 'conflict.gd')?.trailing === 1,
    '判据 5「其余四条照做」:那 1 处行尾空白确实删了', J(reported(rCon.findings[0].detail, 'conflict.gd')))
  const rNoCon = await one('noconf.gd', 'var a = 1   \r\nvar b = 2\r\nvar s = """\r\n块内\r\n"""\r\nvar c = 3\n')
  ok(outOf(rNoCon.findings[0], 'noconf.gd') === 'var a = 1\r\nvar b = 2\r\nvar s = """\r\n块内\r\n"""\r\nvar c = 3\r\n',
    '★反向对照:块内也是 CRLF(与主导同类)→ 统一照做,LF 那行归一成 CRLF',
    J(outOf(rNoCon.findings[0], 'noconf.gd')))
  ok(reported(rNoCon.findings[0].detail, 'noconf.gd')?.endings === 1, '判据 7:换行符计 1 行(反向对照的账)')
  const rOddCR = await one('oddc.gd', 'var a = 1\nvar b\r= 2   \n')
  ok(outOf(rOddCR.findings[0], 'oddc.gd') === 'var a = 1\nvar b\r= 2\n',
    '★正文中间的裸 \\r:该行的行尾空白照删,但换行符统一整条不做', J(outOf(rOddCR.findings[0], 'oddc.gd')))
  ok(/统一换行符[^\n]*裸 \\r/.test(rOddCR.findings[0].detail), '判据 7:裸 CR 那条的跳过理由进 detail',
    rOddCR.findings[0].detail.match(/统一换行符[^\n]*/)?.[0]?.slice(0, 60))
  const rTieTerm = await one('tieterminate.gd', 'var a = 1\r\nvar b = 2\n')
  ok(rTieTerm.findings.length === 0, '代码区 CRLF 与 LF 打平 → 判不出主导,整份不动',
    J(rTieTerm.findings.map((f) => [f.id, outOf(f, 'tieterminate.gd')])))
  ALL.push(...rCon.findings, ...rNoCon.findings, ...rOddCR.findings)

  // ---------- 9. 边界形状 ----------
  section('9. 空文件 / 只有一个换行 / 全文注释 / 全文字符串')
  ok((await one('e1.gd', '')).findings.length === 0, '空文件 → 零结论(绝不产「改成空文件」的 rewrite)')
  ok((await one('e2.gd', '\n')).findings.length === 0, '只有一个换行 → 零结论')
  ok((await one('e2b.gd', '\n\n')).findings.length === 0, '两个空行、一个字符都没有 → 零结论(不到 3 行不压)')
  const rAllBlank = await one('e2c.gd', '\n\n\n')
  ok(outOf(rAllBlank.findings[0], 'e2c.gd') === '\n',
    '三个空行是纯排版(不在任何字符串里)→ 压成一个空行,且**不**再补末尾换行',
    J(outOf(rAllBlank.findings[0], 'e2c.gd')))
  ok(reported(rAllBlank.findings[0].detail, 'e2c.gd')?.finalNL === 0,
    '判据 5 表:补完空行后末行是空行 ⇒ 不往纯空行尾巴上添字节', J(reported(rAllBlank.findings[0].detail, 'e2c.gd')))
  const rCommentOnly = await one('e3.gd', '# 全是注释\n# 第二行   \n')
  ok(outOf(rCommentOnly.findings[0], 'e3.gd') === '# 全是注释\n# 第二行\n',
    '判据 2:注释行的行尾空白可以删(注释里尾随空格不是内容)', J(outOf(rCommentOnly.findings[0], 'e3.gd')))
  const rNoFinal = await one('e4.gd', '# 只有注释,没有末尾换行')
  ok(rNoFinal.findings.length === 0,
    '★简报表上「空文件、纯注释外一律加一个 \\n」⇒ 纯注释文件不补末尾换行', J(rNoFinal.findings.map((f) => f.id)))
  const rNoFinal2 = await one('e5.gd', '\n# 注释\n# 又一条')
  ok(rNoFinal2.findings.length === 0, '纯注释 + 前导空行:同样不补末尾换行', J(rNoFinal2.findings.map((f) => f.id)))
  const rAllStr = await one('e6.gd', 'var s = """\n全部是内容   \n\n\n"""')
  ok(rAllStr.findings.length === 0, '★全文都在字符串里 → 一个字节都不动(包括不补末尾换行)',
    J(rAllStr.findings.map((f) => f.id)))
  ALL.push(...rCommentOnly.findings, ...rNoFinal.findings, ...rAllStr.findings)

  // ---------- 10. 判据 8/10:排除、读不到、截断 ----------
  section('10. 判据 8/10:排除计数、读不到的 .gd、截断降级')
  const dirty = 'var a = 1   \n'
  const rScope = await many({
    'main.gd': dirty,
    'addons/lovely/plug.gd': dirty,
    'Addons/Other/plug.gd': dirty,
    '.godot/shader_cache/x.gd': dirty,
    'gen/x.gd': dirty,
    'ui/panel.tscn': dirty,
    'shader.gdshader': dirty
  })
  ok(filesOf(rScope.findings[0]).map((x) => x.rel).join('|') === 'gen/x.gd|main.gd',
    '判据 8:只有 .gd 参与;addons/**(含大小写异体)与 .godot/** 都被排除',
    filesOf(rScope.findings[0]).map((x) => x.rel).join('|'))
  ok(/addons 目录下的 \.gd 2 个/.test(rScope.findings[0].detail) && /\.godot 缓存里的 \.gd 1 个/.test(rScope.findings[0].detail),
    '★判据 8:两类排除各自**计数**并写进 detail,不是静默跳过',
    rScope.findings[0].detail.match(/默认不参与[^\n]*/)?.[0]?.slice(0, 150))
  ok(!rScope.calls.includes('addons/lovely/plug.gd') && !rScope.calls.includes('.godot/shader_cache/x.gd') &&
      !rScope.calls.includes('ui/panel.tscn') && !rScope.calls.includes('shader.gdshader'),
    '判据 8:被排除的文件连 readText 都没发起(读入面就是 IO 面)', J(rScope.calls))
  ALL.push(...rScope.findings)

  const rUnread = await makeCtx([['big.gd', 99999], ['ok.gd', Buffer.byteLength(dirty)]],
    { texts: { 'ok.gd': dirty }, fail: { 'big.gd': { skipped: true } } })
  const fUnread = await T.runFormat(rUnread.ctx)
  ok(filesOf(fUnread[0]).map((x) => x.rel).join('|') === 'ok.gd',
    '★判据 10:读不到的 .gd 整份跳过,不进 rewrite 清单(绝不写成空文件)', filesOf(fUnread[0]).map((x) => x.rel).join('|'))
  ok(/读不进正文的 \.gd 1 个/.test(fUnread[0].detail), '判据 10:读不到的数量在 detail 里可见',
    fUnread[0].detail.match(/读不进正文[^\n]*/)?.[0]?.slice(0, 60))
  ALL.push(...fUnread)

  const rTruncCtx = makeCtx([['a.gd', 10]], { texts: { 'a.gd': dirty }, trunc: true })
  const fTrunc = await T.runFormat(rTruncCtx.ctx)
  ok(fTrunc.length === 1 && fTrunc[0].id === 'format:truncated' && fTrunc[0].severity === 'warn',
    '★判据 10:截断时只发 truncatedFinding', J(fTrunc.map((f) => [f.id, f.severity])))
  ok(fTrunc[0].fix === undefined, '判据 10:降级卡不带任何可执行 fix', J(fTrunc[0].fix))
  ok(rTruncCtx.calls.length === 0, '判据 10:截断时零 IO(不改写就不读)', J(rTruncCtx.calls))
  ok(/别用排除目录/.test(fTrunc[0].detail) && /maxEntries/.test(fTrunc[0].detail),
    '文案纪律:不许建议用过滤缩小范围(finding.ts:22-30)', fTrunc[0].detail.slice(-70))
  ALL.push(...fTrunc)

  // ---------- 11. 判据 6/7:聚合形状与真实 planFix 对接 ----------
  section('11. 判据 6/7:聚合卡形状与真实 planFix 对接')
  const manyTexts = {}
  for (let i = 0; i < 40; i++) manyTexts[`scripts/m${String(i).padStart(2, '0')}.gd`] = 'var a = 1   \n'
  const rMany = await many(manyTexts)
  const agg = rMany.findings[0]
  ok(rMany.findings.length === 1, '判据 7:40 个文件仍只一条聚合结论(不做逐文件卡片)', String(rMany.findings.length))
  ok(agg.id === 'format:all' && !/[0-9]/.test(agg.id), '判据 9:id 是常量键 format:all,不含数量/下标/时间戳', agg.id)
  ok(filesOf(agg).length === 40, '判据 6/7:payload.files 是全量 40(卡面裁切不裁账)', String(filesOf(agg).length))
  ok(agg.title.includes('40') && /另有 20 个文件未列出/.test(agg.detail),
    '判据 7:标题给总数,detail 列到 LIST_CAP 并说「另有 N 个未列出」', agg.title)
  ok((agg.detail.match(/尾随空白 \d+\//g) || []).length === 20,
    '判据 7:逐文件计数正好点名 20 个(LIST_CAP)', String((agg.detail.match(/尾随空白 \d+\//g) || []).length))
  ok(!agg.detail.includes('scripts/m20.gd['), '判据 7:第 21 个不点名(裁切真的生效)', '—')
  ok(agg.fix.kind === 'rewrite' && agg.fix.label === '格式化 40 个脚本',
    '判据 6:label 就是简报钉的那句「格式化 N 个脚本」', agg.fix.label)
  ok(JSON.stringify(Object.keys(agg.fix).sort()) === '["kind","label","payload"]',
    '措辞纪律:fix 只带 kind/label/payload,动词与风险句归 fixPlan.ts')
  ok(!/回收站|永久删除|随时还原|改写文件/.test(agg.detail),
    'detail 不替 B1 的动词与平台措辞说话', (agg.detail.match(/回收站|永久删除|随时还原|改写文件/g) || []).join('|'))
  const plan = T.planFix(agg, tree(Object.entries(manyTexts).map(([rel, t]) => [rel, Buffer.byteLength(t)])), true)
  ok(plan.service === 'writeProjectText' && plan.items.length === 40 && plan.files.length === 40,
    '★B1 对接:聚合卡过真实 planFix → writeProjectText,items/files 全量 40',
    `${plan.service}/${plan.items.length}/${plan.files.length}`)
  ok(plan.items.every((it) => typeof it.size === 'number' && it.note === undefined),
    '★判据 6:每条 rel 都有 size、没有一条带「会新建文件」措辞(rel 全部来自 ctx.tree)',
    J(plan.items.filter((it) => it.note !== undefined).map((it) => it.rel)))
  ok(/gpm-bak/.test(plan.warn) && !/新建/.test(plan.warn),
    '判据 6:warn 停在「会先备份再原子替换」那一档', plan.warn)
  ok(plan.files.every((f) => f.text === 'var a = 1\n'),
    'B1 对接:交给 rewrite 的每份 text 都是整份新内容且非空')
  const planMac = T.planFix(agg, tree(Object.entries(manyTexts).map(([rel, t]) => [rel, Buffer.byteLength(t)])), false)
  ok(planMac.verb !== '格式化' && planMac.service === 'writeProjectText',
    'B1 对接:非 Windows 也走同一通道(措辞由 planFix 分叉,检查器一个字没写)', planMac.verb)
  ALL.push(agg)

  // ---------- 12. ★ 计数与产出交叉核对 ----------
  section('12. ★ 账与产出:每文件计数 === 第二趟纯比较')
  const corpus = {
    'x1.gd': 'var a = 1   \nvar b = 2\n\n\n\n\nvar c = 3',
    'x2.gd': 'func f():\n\tvar a = 1\n    var b = 2   \n\t\tvar c = 3\n',
    'x3.gd': 'var s = """\n块内   \n"""\r\nvar a = 1   \r\nvar b = 2\n',
    'x4.gd': 'var x = foo(\n\t"对齐",\n\t"第二行   "\n)\nvar y = 1   ',
    'x5.gd': 'var u = "带 # 的串"\n# 注释   \nvar v = 1\n\n\n\nvar w = 2\n',
    'x6.gd': 'func g():\n    var t = """\n内容\t\n    """\n    var s = 1  \n\n\n\n\n    return s'
  }
  const rCorpus = await many(corpus)
  const det = rCorpus.findings[0].detail
  const bad = []
  const sums = { trailing: 0, indent: 0, blank: 0, finalNL: 0, endings: 0 }
  for (const f of filesOf(rCorpus.findings[0])) {
    const rep = reported(det, f.rel)
    const act = measureDelta(corpus[f.rel], f.text)
    for (const k of KEYS) sums[k] += act[k]
    if (act.other > 0) bad.push(`${f.rel} 出现无法归类的改动 other=${act.other}`)
    if (J(rep) !== J({ trailing: act.trailing, indent: act.indent, blank: act.blank, finalNL: act.finalNL, endings: act.endings })) {
      bad.push(`${f.rel} 账=${J(rep)} 实际=${J(act)}`)
    }
  }
  ok(bad.length === 0 && filesOf(rCorpus.findings[0]).length === Object.keys(corpus).length,
    '★判据 7:六个文件的五类计数与「只读两份文本另算一趟」逐类相等,且没有任何未归类改动',
    bad.join(' | '))
  const totalLine = det.match(/总计改动:尾随空白 (\d+) 行、缩进 (\d+) 行、压掉空行 (\d+) 行、补末尾换行 (\d+) 个文件、换行符 (\d+) 行/)
  ok(totalLine && KEYS.every((k, i) => Number(totalLine[i + 1]) === sums[k]),
    '判据 7:detail 的总计 === 逐文件实际改动之和', `${totalLine?.[0]} vs ${J(sums)}`)
  const idemTexts = Object.fromEntries(Object.entries(corpus).map(([rel, t]) => [rel, outOf(rCorpus.findings[0], rel) || t]))
  const idem = await many(idemTexts)
  ok(idem.findings.length === 0, '★幂等:改完再跑一趟零结论(没有字节剩下可动 —— 第三方向产出发言)',
    J(idem.findings.map((f) => [f.id, f.detail.slice(0, 40)])))
  ALL.push(...rCorpus.findings)

  // ---------- 12b. ★ 变异取证补出来的盲区夹具 ----------
  // 这一段的每一条都对应一次「把判定改坏却零红(或只咬一处)」的实测:原夹具看不见那个差别,
  // 所以先跑变异、确认盲区、再补夹具补断言(补完反过来重跑同一条变异,必须见红)。
  section('12b. ★ 变异取证补出来的盲区夹具(每条对应一次零红变异)')

  // (i) 只写了 tab 的空行:它的前导会被「删行尾空白」清掉,所以绝不能再来投缩进票
  const rBlankVote = await one('t9.gd', 'func f():\n    var a = 1\n\t\n\t\n\t\n    var b = 2\n')
  ok(outOf(rBlankVote.findings[0], 't9.gd') === L('func f():', '    var a = 1', '', '    var b = 2'),
    '★判据 3:空行不投缩进票(否则 3 票 tab 压过 2 票空格,凭空造出一整片转换)',
    J(outOf(rBlankVote.findings[0], 't9.gd')))
  ok(reported(rBlankVote.findings[0].detail, 't9.gd')?.trailing === 3 &&
      reported(rBlankVote.findings[0].detail, 't9.gd')?.blank === 2,
    '判据 7:那三行 tab 空行的前导按「行尾空白」删掉,空行段按删掉的行数计 2',
    J(reported(rBlankVote.findings[0].detail, 't9.gd')))

  // (ii) 括号未闭合里的 tab 对齐、**不带字符串**那种(cont/cont2 的前导行都在串里,证不到这条)
  const tCont3 = L('func f():', '    var a = 1', '    var pts = [', '\t\tVector2(1, 2),',
    '\t\tVector2(3, 4),   ', '    ]', '    var b = 2', '    return a + b   ')
  const rCont3 = await one('cont3.gd', tCont3)
  ok(outOf(rCont3.findings[0], 'cont3.gd') === L('func f():', '    var a = 1', '    var pts = [',
    '\t\tVector2(1, 2),', '\t\tVector2(3, 4),', '    ]', '    var b = 2', '    return a + b'),
    '★判据 4:未闭合括号里的 tab 对齐既不被转换也不投票,而它的行尾空白照删',
    J(outOf(rCont3.findings[0], 'cont3.gd')))
  ok(reported(rCont3.findings[0].detail, 'cont3.gd')?.indent === 0 &&
      reported(rCont3.findings[0].detail, 'cont3.gd')?.trailing === 2,
    '判据 7:缩进 0 处 / 行尾空白 2 处(账与产出同形)', J(reported(rCont3.findings[0].detail, 'cont3.gd')))

  // (iii) 缩进转换只动整行前导:串里的 tab 与代码中段的 tab 都是内容
  const tInner = L('func f():', '    var a = 1', '    var b = 2', '\tprint("a\tb")', '\tvar c := 1\t+ 2', '    pass')
  const rInner = await one('t10.gd', tInner)
  ok(outOf(rInner.findings[0], 't10.gd') === L('func f():', '    var a = 1', '    var b = 2',
    '    print("a\tb")', '    var c := 1\t+ 2', '    pass'),
    '★判据 3 表:tab→空格只换整行前导 —— 字面量里与代码中段的 tab 一个都不换',
    J(outOf(rInner.findings[0], 't10.gd')))
  ok(reported(rInner.findings[0].detail, 't10.gd')?.indent === 2,
    '判据 7:缩进计 2 行(就是前导那两行,不含行内的 tab)', J(reported(rInner.findings[0].detail, 't10.gd')))

  // (iv) 补的那个末尾换行用文件自己的主导形态
  const rCrlfFinal = await one('f1.gd', 'var a = 1\r\nvar b = 2   \r\nvar c = 3')
  ok(outOf(rCrlfFinal.findings[0], 'f1.gd') === 'var a = 1\r\nvar b = 2\r\nvar c = 3\r\n',
    '★判据 5 表:CRLF 文件缺的末尾换行补的是 CRLF,不是硬写 \\n(硬写就给整份文件混进 LF)',
    J(outOf(rCrlfFinal.findings[0], 'f1.gd')))
  ok(reported(rCrlfFinal.findings[0].detail, 'f1.gd')?.finalNL === 1 &&
      reported(rCrlfFinal.findings[0].detail, 'f1.gd')?.endings === 0,
    '判据 7:末尾换行 1 个 / 换行符 0 行(其余本来就是 CRLF)', J(reported(rCrlfFinal.findings[0].detail, 'f1.gd')))

  // (v) 裸 \r 的闸门要在「主导判得出来」时才见血(oddc.gd 那份恰好是平局,证不到闸门)
  const rStray2 = await one('f2.gd', 'var a = 1\nvar b\r= 2   \r\nvar c = 3\nvar d = 4\n')
  ok(outOf(rStray2.findings[0], 'f2.gd') === 'var a = 1\nvar b\r= 2\r\nvar c = 3\nvar d = 4\n',
    '★判据 5:正文有裸 \\r ⇒ 即使主导判得出(LF 3 : CRLF 1)整条统一也不做,那行 CRLF 留着',
    J(outOf(rStray2.findings[0], 'f2.gd')))
  ok(reported(rStray2.findings[0].detail, 'f2.gd')?.endings === 0,
    '判据 7:裸 CR 闸门下换行符计 0,少做的这一条也在账上看得见')

  // (vi) blockTermConflict 的「整条不做」要能在**字节**上看出来(conflict.gd 那份没有少数结尾的代码行)
  const rCon2 = await one('f3.gd', 'var s = """\r\n块内   \r\n"""\nvar a = 1   \nvar b = 2\nvar c = 3\nvar d = 4\r\n')
  ok(outOf(rCon2.findings[0], 'f3.gd') === 'var s = """\r\n块内   \r\n"""\nvar a = 1\nvar b = 2\nvar c = 3\nvar d = 4\r\n',
    '★判据 5:块里混着 CRLF 而主导是 LF ⇒ 块外那行 CRLF 也不归一(其余四条照做)',
    J(outOf(rCon2.findings[0], 'f3.gd')))
  ok(reported(rCon2.findings[0].detail, 'f3.gd')?.endings === 0 &&
      reported(rCon2.findings[0].detail, 'f3.gd')?.trailing === 1,
    '判据 7:换行符 0 处、行尾空白 1 处(少做一条要能在账上看出来)', J(reported(rCon2.findings[0].detail, 'f3.gd')))

  // (vii) 行尾空白只认空格与 tab:NBSP 这类非 ASCII 空白是内容
  const rNbsp = await one('f4.gd', 'var a = 1\u00a0  \n')
  ok(outOf(rNbsp.findings[0], 'f4.gd') === 'var a = 1\u00a0\n',
    '★判据 2:只删空格与 tab —— NBSP 留着(\\s 会把 NBSP 一起吞掉,那是改内容)',
    J(outOf(rNbsp.findings[0], 'f4.gd')))
  ok((await one('f5.gd', 'var a = 1\n\n\u00a0\n\nvar b = 2\n')).findings.length === 0,
    '★判据 2:只写了一个 NBSP 的行不是空行,三行一段也不压(NBSP 不是排版字符)', '—')

  // (vii-b) 碰过字符串的行连**终止符**都不改写:主导是 CRLF 时那一行的 LF 留着,而它下面那行照被归一
  const rTermGuard = await one('f6.gd', 'var s = """abc"""\nvar a = 1   \nvar b = 2\r\nvar c = 3\r\nvar d = 4\r\n')
  ok(outOf(rTermGuard.findings[0], 'f6.gd') === 'var s = """abc"""\nvar a = 1\r\nvar b = 2\r\nvar c = 3\r\nvar d = 4\r\n',
    '★判据 2/5:单行块那一行的 LF 不被归一成主导 CRLF,而紧跟那行(代码区)照归一 —— 确定与不确定的分界',
    J(outOf(rTermGuard.findings[0], 'f6.gd')))
  ok(reported(rTermGuard.findings[0].detail, 'f6.gd')?.endings === 1,
    '判据 7:换行符计 1(只有代码区那一行被改),少做的没算进账', J(reported(rTermGuard.findings[0].detail, 'f6.gd')))

  // (vii-c) 前导以非 ASCII 空白开头:那一整段前导都是内容,既不投票也不被折算(G19 变异补出来的盲区)
  const rNbspLead = await one('f7.gd', L('func f():', '\tvar a = 1', '\tvar b = 2', '\u00a0   var c = 3   '))
  ok(outOf(rNbspLead.findings[0], 'f7.gd') === L('func f():', '\tvar a = 1', '\tvar b = 2', '\u00a0   var c = 3'),
    '★判据 3:目标=tab 时也不把「NBSP + 3 空格」折成一个 tab —— 非 ASCII 空白不认作前导缩进',
    J(outOf(rNbspLead.findings[0], 'f7.gd')))
  ok(reported(rNbspLead.findings[0].detail, 'f7.gd')?.indent === 0,
    '判据 7:那一行既不转换也不投票(缩进计 0)', J(reported(rNbspLead.findings[0].detail, 'f7.gd')))
  ALL.push(...rNbspLead.findings)

  // (x) ★ 带前缀的多行 raw 串(`r"""…"""`):块内一个字节都不动(取证 R1 抓出来的改写内容 bug)
  const tRaw = 'var p = r"""\n块内内容   \n\n\n\n"""\nvar a = 1   \n'
  const rRaw = await one('f8.gd', tRaw)
  ok(outOf(rRaw.findings[0], 'f8.gd') === 'var p = r"""\n块内内容   \n\n\n\n"""\nvar a = 1\n',
    '★判据 1/2:r 前缀的多行串块内尾随空白与三连空行都是内容,只有块外那行的尾随空白被删',
    J(outOf(rRaw.findings[0], 'f8.gd')))
  ok(reported(rRaw.findings[0].detail, 'f8.gd')?.trailing === 1 &&
      reported(rRaw.findings[0].detail, 'f8.gd')?.blank === 0,
    '判据 7:块内的空行段不计、尾随空白只算块外那一处(账上也别记)',
    J(reported(rRaw.findings[0].detail, 'f8.gd')))
  const tRawCRLF = 'var p = r"""\n块内 LF   \n"""\r\nvar a = 1   \r\nvar b = 2\r\nvar c = 3\r\n'
  const rRawCRLF = await one('f9.gd', tRawCRLF)
  ok(outOf(rRawCRLF.findings[0], 'f9.gd') === 'var p = r"""\n块内 LF   \n"""\r\nvar a = 1\r\nvar b = 2\r\nvar c = 3\r\n',
    '★判据 5:raw 块里的 LF 算「字符串内容」⇒ 与主导 CRLF 冲突,整条换行符统一不做(内容会变)',
    J(outOf(rRawCRLF.findings[0], 'f9.gd')))
  ok(/统一换行符[^\n]*多行字符串[^\n]*没做/.test(rRawCRLF.findings[0].detail),
    '判据 5/7:少做的这一条在 detail 里说得出理由',
    rRawCRLF.findings[0].detail.match(/统一换行符[^\n]*/)?.[0]?.slice(0, 60))
  ALL.push(...rRaw.findings, ...rRawCRLF.findings)

  ALL.push(...rBlankVote.findings, ...rCont3.findings, ...rInner.findings, ...rCrlfFinal.findings,
    ...rStray2.findings, ...rCon2.findings, ...rNbsp.findings, ...rTermGuard.findings)

  // (viii) 判据 8 的路径段口径与 rel 形状:三种「长得像该排除/该保留」的路径
  const rScope2 = await many({
    '.godotfiles/x.gd': dirty,
    'Main.GD': dirty,
    'weird\\path.gd': dirty,
    'a/.godot/b.gd': dirty
  })
  ok(filesOf(rScope2.findings[0]).map((x) => x.rel).join('|') === '.godotfiles/x.gd|Main.GD',
    '★判据 8:缓存按**路径段**判(.godotfiles 不是 .godot)、扩展名用原语的小写 ext(Main.GD 进面)、' +
    'rel 里带反斜杠的不进面(形状不认识,宁可不读)',
    filesOf(rScope2.findings[0]).map((x) => x.rel).join('|'))
  ok(!rScope2.calls.includes('weird\\path.gd') && !rScope2.calls.includes('a/.godot/b.gd'),
    '判据 8:反斜杠 rel 与真缓存都不发 IO', J(rScope2.calls))
  ALL.push(...rScope2.findings)

  // (ix) 畸形清单里同一个 rel 出现两次:只读一次、只进一次改写(改写清单里重复同一份 text 也是噪音)
  const dupCtx = makeCtx([['dup.gd', Buffer.byteLength(dirty)], ['dup.gd', Buffer.byteLength(dirty)],
    ['z.gd', Buffer.byteLength(dirty)]], { texts: { 'dup.gd': dirty, 'z.gd': dirty } })
  const fDup = await T.runFormat(dupCtx.ctx)
  ok(filesOf(fDup[0]).map((x) => x.rel).join('|') === 'dup.gd|z.gd',
    '判据 9:同一个 rel 在 tree 里出现两次 → 改写清单里只有一份(不重复计费也不重复覆写)',
    filesOf(fDup[0]).map((x) => x.rel).join('|'))
  ok(dupCtx.calls.filter((r) => r === 'dup.gd').length === 1, '判据 8:重复条目只发一次 IO', J(dupCtx.calls))
  ALL.push(...fDup)

  // ---------- 12c. ★ Fix round 1:`""` / 带前缀单行串 / 「补末尾换行没做」上卡 ----------
  // 评审实测的三种形状(旧写法都吃得到):
  //   · `foo("", 2)` 里那个没被数到的 `(` 把后半份文件全判成续行 ⇒ 缩进判据一路白丢,卡面上既无计数也无理由;
  //   · 空串行自己的尾随空白被留下;
  //   · 「补末尾换行」的四条拒绝理由是**死字符串**(算出来了却没进 skips)⇒ 判据 7 的五类里少一类。
  section('12c. ★ Fix round 1:空串/带前缀单行串的括号续串 + 最终换行的「没做」要上卡')
  // 这一段的断言全部走 `o0/d0/c0` 三个安全访问器:旧写法在 (xi) 就是**零结论**,
  // 直接 `findings[0].detail` 会让 harness 抛错、后面九条断言一条都印不出来(RED 要能看全)。
  const o0 = (r, rel) => (r.findings[0] ? outOf(r.findings[0], rel) : `零结论(${r.findings.length} 张卡)`)
  const d0 = (r) => (r.findings[0] ? r.findings[0].detail : '零结论')
  const c0 = (r, rel) => (r.findings[0] ? reported(r.findings[0].detail, rel) : null)

  // (xi) 空串:后面的行不再被当续行(与 `foo(1, 2)` 那份对照,差别只在 `""`)
  const tEmpty = L('func f():', '    var s = foo("", 2)', '\tvar x = 1', '\tvar y = 2', '\tvar z = 3')
  const rEmpty = await one('g1.gd', tEmpty)
  ok(o0(rEmpty, 'g1.gd') === L('func f():', '\tvar s = foo("", 2)', '\tvar x = 1', '\tvar y = 2', '\tvar z = 3'),
    '★Fix1:`foo("", 2)` 之后三行不再是续行 ⇒ 多数派按 tab 定,那行的 4 空格被折回一个 tab',
    J(o0(rEmpty, 'g1.gd')))
  ok(c0(rEmpty, 'g1.gd')?.indent === 1,
    '判据 7:这一处缩进改动记在账上(旧写法是 0 结论,连「少做了什么」都没得说)', J(c0(rEmpty, 'g1.gd')))

  // (xii) 空串那一行自己:尾随空白照删(它就是一个闭合的字符串,与已经上线的 `"abc"` 同档)
  const rEmptyTrail = await one('g2.gd', 'var s = ""   \nvar b = 1   \n')
  ok(o0(rEmptyTrail, 'g2.gd') === 'var s = ""\nvar b = 1\n',
    '★Fix1:闭合空串那一行的行尾空白被删(单双引号同机制见下一条)', J(o0(rEmptyTrail, 'g2.gd')))
  ok(c0(rEmptyTrail, 'g2.gd')?.trailing === 2,
    '判据 7:两处尾随空白都记账', J(c0(rEmptyTrail, 'g2.gd')))
  const rEmptyTrail2 = await one('g2b.gd', "var s = ''   \nvar b = 1   \n")
  ok(o0(rEmptyTrail2, 'g2b.gd') === "var s = ''\nvar b = 1\n",
    '判据 1/2:单引号空串同档', J(o0(rEmptyTrail2, 'g2b.gd')))

  // (xiii) 带前缀的单行串:**那一行仍整行不动**,只把闭引号之后的括号算回来(方向只多算括号)
  const tRawLine = L('func f():', '    var s = foo(r"\\d+", 2)   ', '    var x = 1', '\tvar y = 2   ', '    var z = 3')
  const rRawLine = await one('g3.gd', tRawLine)
  ok(o0(rRawLine, 'g3.gd') === L('func f():', '    var s = foo(r"\\d+", 2)   ', '    var x = 1',
    '    var y = 2', '    var z = 3'),
    '★Fix1:带前缀单行串那一行的字节一个没动(尾随空格仍留着),但它后面的行不再是续行',
    J(o0(rRawLine, 'g3.gd')))
  ok(c0(rRawLine, 'g3.gd')?.indent === 1 && c0(rRawLine, 'g3.gd')?.trailing === 1,
    '判据 7:缩进 1 行 / 尾随空白 1 处(那行的尾随空格不在账上,因为它没动)', J(c0(rRawLine, 'g3.gd')))

  // (xiv) 未闭合的带前缀串:仍只放弃本行(残留钉住,不扩大成跨行状态)
  const rRawOpen = await one('g4.gd', 'var p = r"没闭合\nvar a = 1   \n')
  ok(o0(rRawOpen, 'g4.gd') === 'var p = r"没闭合\nvar a = 1\n',
    '判据 1:带前缀且真未闭合 ⇒ 放弃本行剩下的扫描,下一行回到代码态(已知残留,与文件头同一口径)',
    J(o0(rRawOpen, 'g4.gd')))

  // (xv) ★ 判据 7 的第五类:补末尾换行的四条拒绝理由都要在卡面上说得出(旧写法是四条死字符串)
  const NOFINAL = [
    ['g5.gd', '# 全是注释   \n# 第二行   ', /补末尾换行:全文只有注释与空行/, '纯注释(评审点名的那条复现形状)'],
    ['g6.gd', 'var a = 1   \nvar s = "没闭合', /补末尾换行:文件停在未闭合的字符串里/, '文件停在未闭合串里'],
    ['g7b.gd', 'var a = 1   \nvar b\r= 2', /补末尾换行:正文中间有裸/, '正文里有裸 \\r'],
    ['g8b.gd', 'var a = 1   \n\n  ', /补末尾换行:末行本来就是空行/, '末行本来就是空行']
  ]
  const skipSeg = (r) => (r.findings[0] ? r.findings[0].detail.match(/\{没做:[^}]*\}/)?.[0] || '无没做段' : '零结论')
  const skipReasons = []
  for (const [rel, text, re, what] of NOFINAL) {
    const r = await one(rel, text)
    const seg = skipSeg(r)
    ok(r.findings.length === 1 && re.test(seg),
      `★判据 7:${what} ⇒ 卡片发了、末尾换行没补,「没做」的理由必须跟着 rel 上卡`, `${rel}:${seg}`)
    ok(reported(r.findings[0]?.detail || '', rel)?.finalNL === 0, `判据 7:${what} 那一档末尾换行计 0(账与产出一致)`,
      J(reported(r.findings[0]?.detail || '', rel)))
    skipReasons.push(rel)
    ALL.push(...r.findings)
  }
  ok(skipReasons.length === 4, '判据 7:四类「补末尾换行没做」的形状各一份夹具(旧写法四条都是死字符串)',
    skipReasons.join('|'))
  ALL.push(...rEmpty.findings, ...rEmptyTrail.findings, ...rEmptyTrail2.findings, ...rRawLine.findings, ...rRawOpen.findings)
  // 反过来:文件本来就以换行收尾时**不该**冒出这条理由(没欠一个字节就别喊「没做」)
  const rNoSkipNoise = await one('g9.gd', '# 全是注释   \n# 第二行   \n')
  ok(rNoSkipNoise.findings.length === 1 && !/补末尾换行/.test(skipSeg(rNoSkipNoise)),
    '★判据 7:已经以换行收尾的文件不欠末尾换行 ⇒「没做」段里不许虚报一条(总计那行给的是 0,不算承诺)',
    skipSeg(rNoSkipNoise))
  ALL.push(...rNoSkipNoise.findings)

  // ---------- 13. 判据 9:确定性与唯一 fix 形态 ----------
  section('13. 判据 9:确定性与 fix 形态')
  const detTexts = { 'a/a.gd': 'var a = 1   \n', 'a/b.gd': 'var b = 2\nvar c = 3   ', 'z/z.gd': 'var z = 1\n\n\n\nvar y = 2\n' }
  const dump = (fs) => JSON.stringify(fs)
  const base = await many(detTexts)
  const specsRev = [...tree(Object.entries(detTexts).map(([rel, t]) => [rel, Buffer.byteLength(t)]))].reverse()
  const revCtx = { projectId: 'p', root: 'E:/proj', truncated: false, tree: specsRev, readText: async (rel) => ({ text: detTexts[rel] }) }
  const rev = await T.runFormat(revCtx)
  ok(Array.isArray(rev) && dump(base.findings) === dump(rev),
    '判据 9:tree 反序 → findings 逐字节一致', `${base.findings.length}/${(rev || []).length}`)
  const mixed = await T.runFormat({ ...revCtx, tree: [specsRev[1], specsRev[0], ...specsRev.slice(2)] })
  ok(dump(base.findings) === dump(mixed), '判据 9:交错顺序同样一致(结论不靠 tree 下标)')
  ok(base.calls.join('|') === 'a/a.gd|a/b.gd|z/z.gd',
    '判据 9:readText 的发起顺序也按 rel 码元序(不跟 tree 顺序)', base.calls.join('|'))
  ok(ALL.every((f) => !f.fix || f.fix.kind === 'rewrite'),
    `判据 6:${ALL.length} 条结论里 fix 形态只有 rewrite(没有 trash/none/existing 混进来)`,
    J([...new Set(ALL.filter((f) => f.fix).map((f) => f.fix.kind))]))
  ok(ALL.every((f) => !/undefined|null|NaN/.test(`${f.title}${f.detail}`)), '文案里没有 undefined/NaN 漏出来')

  // ---------- 14. 纯函数红线与卡面文案 ----------
  section('14. 纯函数红线与卡面文案')
  const fs = await import('node:fs')
  const src = fs.readFileSync(path.join(ROOT, 'src', 'tools', 'inspectors', 'format.ts'), 'utf8')
  // 只查**调用形状**,不查裸词:文件头的红线注释里就写着「不碰 window / services / vue」,
  // 按裸词匹配会把注释也算成违规(那是自我实现约束,不是宿主耦合)。
  const BAD = /\bwindow\.[a-zA-Z]|\bglobalThis\b|\bservices\.[a-zA-Z]|from ['"]vue['"]|from ['"]node:|require\(|readFileSync|writeFileSync|mkdirSync|rmSync/
  ok(!BAD.test(src), '纯函数红线:format.ts 里没有 window/services/vue/DOM/IO 的调用形状',
    J(src.match(new RegExp(BAD.source))))
  ok(!/path\.join|path\.resolve|ctx\.root|\.root\s*\+/.test(src), '纯函数红线:不拼绝对路径(判定只用 rel)')
  const INTERNAL = /(src-ztools|src-tauri|src\/|parsers\/|inspectors\/|__tests__|[\w./-]+\.(ts|mjs|js|rs)\b|formatGdText|scanGdScript|classifyLines|LIST_CAP|truncatedFinding|planFix|treeUtils|gdScopeOf|TAB_WIDTH|\.gd 的)|\bB9\b|简报|spec §/
  ok(ALL.every((f) => !INTERNAL.test(`${f.title}\n${f.detail}`)),
    `★用户可见文案里没有仓库内部引用与工单话术(${ALL.length} 条逐条查)`,
    ALL.filter((f) => INTERNAL.test(`${f.title}\n${f.detail}`)).map((f) => f.id).join('|'))
  ok(ALL.every((f) => f.id.startsWith('format:')), 'id 一律 format: 前缀',
    ALL.filter((f) => !f.id.startsWith('format:')).map((f) => f.id).join('|'))
  ok(ALL.every((f) => f.id === 'format:truncated' || (typeof f.detail === 'string' && f.detail.length > 0)),
    '除降级卡外每条都有 detail(证据要说得出出处)')
  ok(ALL.every((f) => f.id === 'format:truncated' || typeof f.rel === 'string'),
    '每条结论都带主证据 rel(卡片跳转不落空)')
  const withFix = ALL.filter((f) => f.fix)
  ok(withFix.every((f) => filesOf(f).length > 0 && filesOf(f).every((x) => typeof x.text === 'string' && x.text !== '')),
    `rewrite 载荷里没有空 text(${withFix.length} 条卡:宁可不发,也不发一条会把文件覆空的 rewrite)`)

  console.log(`\n${'='.repeat(56)}\nPASS ${pass}  FAIL ${failures.length}`)
  if (failures.length) { console.log('失败项:'); for (const f of failures) console.log('  - ' + f); process.exit(1) }
  console.log('全部通过')
}

main().catch((e) => {
  console.error(`\n测试脚本抛错: ${e && e.stack ? e.stack : e}`)
  process.exit(1)
})
