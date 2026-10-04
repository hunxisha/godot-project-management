// 工具页 P1/M-P1a:翻译 csv 首列抽取(src/tools/parsers/translationCsv.ts)的断言。
//
// 为什么单开一个文件:#15 本地化体检只需两件事(文件在不在、首列 _key 重不重),
// 而 Godot 的 translation csv 的坑全在**首列怎么切**上:引号里有逗号、有换行、有 "" 转义。
// 这些形态与 godotIni 的引号扫描不是一回事(csv 没有 `key=` 形态,也没有 `#` 注释),
// 所以不复用那份状态机,也不让它长进 treeUtils。
//
// 设计口径见 docs/tools-page-plan.md P1-4 #15:
//   · 只解**首列**,列数一致性本批不做(未实测,见待确认 #16);
//   · 表头行照常出一条记录,跳不跳由调用方(#15 检查器)决定 —— 解析器不替用户猜语义;
//   · 遇到未闭合引号置 partial,**不报重复**(宁漏报不误报,与债 6/债 7 同方向)。
//
// 用法(npm script 会先跑打包步骤):
//   node src/composables/__tests__/build-bundle.mjs && node src/tools/__tests__/translationCsv.test.mjs
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

const HAS = typeof T.readTranslationCsv === 'function'
ok(HAS, 'readTranslationCsv 已在打包产物里导出')
if (!HAS) {
  console.log('\n实现尚未落地,后续断言无法执行(这就是 RED 那一步)。')
  console.log(`\n${'='.repeat(56)}\nPASS ${pass}  FAIL ${failures.length}`)
  process.exit(1)
}

/** 取首列串数组(行号语义另测) */
const firsts = (text) => T.readTranslationCsv(text).cells.map((c) => c.cell)

section('1. 常规 csv:每条记录出首列,含表头')
{
  const r = T.readTranslationCsv('_key,en,zh\nstart,Start,开始\nquit,Quit,退出\n')
  ok(JSON.stringify(firsts('_key,en,zh\nstart,Start,开始\nquit,Quit,退出')) === JSON.stringify(['_key', 'start', 'quit']),
    '首列按记录顺序给,表头不特殊处理', JSON.stringify(firsts('_key,en,zh\nstart,Start,开始\nquit,Quit,退出')))
  ok(r.cells.length === 3 && r.cells[2].line === 3, 'line 是记录起始行(1 起)', JSON.stringify(r.cells))
  ok(r.partial === false, '正常文本 partial=false', r.partial)
}

section('2. 首列带引号且内含逗号')
{
  const f = firsts('"menu,main",Open Menu,打开菜单\nnext,Next,下一个')
  ok(f[0] === 'menu,main', '引号内的逗号不当分隔符', JSON.stringify(f[0]))
  ok(f[1] === 'next', '后续记录照常', JSON.stringify(f[1]))
}

section('3. BOM 与 CRLF 不污染首列')
{
  // Godot 官方翻译模板与 Excel 导出常带 UTF-8 BOM;不剥掉的话第一条 key 永远对不上
  // (查重会认为 `_key` 与 `` 是两个键,而缺失文件判据又拿它当合法 key)。
  const bom = firsts('\uFEFF_key,en\nHELLO,Hello\n')
  ok(bom[0] === '_key', 'BOM 被剥掉', JSON.stringify(bom[0]))
  ok(bom[1] === 'HELLO', 'BOM 只影响第一条', JSON.stringify(bom))

  const crlf = T.readTranslationCsv('_key,en\r\nHELLO,Hello\r\n')
  ok(JSON.stringify(crlf.cells.map((c) => c.cell)) === JSON.stringify(['_key', 'HELLO']),
    'CRLF 与 LF 同形', JSON.stringify(crlf.cells))
}

section('4. 空文本与只有表头')
{
  for (const [text, n, label] of [['', 0, '空字符串'], ['\n', 0, '只有一个换行'], ['_key,en\n', 1, '只有表头']]) {
    const r = T.readTranslationCsv(text)
    ok(Array.isArray(r.cells) && r.cells.length === n && r.partial === false,
      `${label}:${n} 条记录、partial=false`, JSON.stringify(r))
  }
}

section('5. 引号内换行:一条记录跨行不炸条数')
{
  // 官方翻译表里长译文常见跨行(Excel 里 Alt+Enter 就是这种产物)。裸 split 会把它切成两条,
  // 于是「首列查重」凭空多出空键 —— 本条钉的正是这个失败模式。
  const r = T.readTranslationCsv('_key,en\nhello,"Line one\nLine two"\nquit,Bye\n')
  ok(r.cells.length === 3, '三条记录(跨行仍是一条)', JSON.stringify(r.cells))
  ok(r.cells[1].cell === 'hello' && r.cells[1].line === 2, '行号记**起始行**而不是末行', JSON.stringify(r.cells[1]))
  ok(r.cells[2].line === 4, '后续记录的起始行按实际推进(跨了两行 → quit 在第 4 行)', r.cells[2].line)
}

section('6. `""` 转义引号')
{
  const r = T.readTranslationCsv('_key,en\nquote,"He said ""hi"""\ndone,Done\n')
  ok(r.cells.length === 3 && r.cells[1].cell === 'quote', '转义只影响后面字段,首列照常', JSON.stringify(r.cells))
  ok(r.partial === false, '转义不算未闭合', r.partial)

  const self = T.readTranslationCsv('"a""b",en\n')
  ok(self.cells[0].cell === 'a"b', '首列自己带转义引号时还原成字面 `"`', JSON.stringify(self.cells[0].cell))
}

section('7. 未闭合引号 → partial,已收到的记录保留')
{
  const r = T.readTranslationCsv('_key,en\nhello,"未闭合的译文\n')
  ok(r.partial === true, 'partial=true', r.partial)
  ok(r.cells.length === 1 && r.cells[0].cell === '_key', '截断之前那条照常给(检查器据此只判「读不下去」)', JSON.stringify(r.cells))

  // 尾随字段里断掉的引号同样要让调用方知道:那条记录的首列虽然读到了,
  // 但它之后的行界已经不可信,继续喂给查重就是拿脏数据报「重复键」。
  const late = T.readTranslationCsv('a,"x"\nb,"y\n')
  ok(late.partial === true && late.cells.length === 1, '后面字段断引号:partial 且只保留可信的那条', JSON.stringify(late))
}

section('8. 空行不产记录,只含分隔符的记录首列为空串')
{
  const blank = T.readTranslationCsv('_key,en\n\n\nhello,Hi\n')
  ok(blank.cells.length === 2 && blank.cells[1].line === 4, '连续空行不当记录(否则空键会被判重复)', JSON.stringify(blank.cells))

  const onlyCommas = T.readTranslationCsv(',en,zh\n')
  ok(onlyCommas.cells.length === 1 && onlyCommas.cells[0].cell === '', '首列本身为空仍是一条记录,值给空串', JSON.stringify(onlyCommas.cells))
}

section('9. dupFirstCells:重复键给全部行号')
{
  const r = T.readTranslationCsv('_key,en\nstart,A\nquit,B\nstart,C\nstart,D\n')
  const body = r.cells.slice(1) // 表头由调用方跳过 —— 解析器不替用户猜语义
  const d = T.dupFirstCells(body)
  ok(d.length === 1 && d[0].cell === 'start', '只有一条重复键被报出', JSON.stringify(d))
  ok(JSON.stringify(d[0].lines) === JSON.stringify([2, 4, 5]), '每次出现的行号都保留(1-based,照文件行)', JSON.stringify(d[0].lines))

  const clean = T.dupFirstCells(T.readTranslationCsv('_key,en\na,1\nb,2\n').cells.slice(1))
  ok(clean.length === 0, '不重复给空数组', JSON.stringify(clean))

  const empty = T.dupFirstCells([])
  ok(Array.isArray(empty) && empty.length === 0, '空入参给空数组(红线:纯函数不抛)', JSON.stringify(empty))
}

console.log(`\n${'='.repeat(56)}\nPASS ${pass}  FAIL ${failures.length}`)
if (failures.length) {
  console.log('失败项:')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log('全部通过')
