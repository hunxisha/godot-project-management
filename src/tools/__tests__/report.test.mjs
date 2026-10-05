// 工具页 P2 #19:体检报告生成(src/tools/report.ts)的断言。
//
// 这一层只该做一件事:把 `Tool[] + Record<toolId, ToolResult> + meta` 变成文本/JSON。
// 不吃 window、不吃 DOM、不吃 vue 响应式 —— 所以它能在 Node 里直接测,而「复制到剪贴板 + 存库」
// 那两件事留在 useTools(有 window,测起来要一整套桩,那边已有夹具)。
//
// 两条方向纪律由断言钉住:
//   · **三态都要出现**:跑过的、没跑的、宿主不支持的。静默少一行是让报告失去可信度最快的方式;
//   · **不得出现凭据原文**:finding 对象本来就不含原文(secretPatterns 只交掩码),但红线要有牙齿 ——
//     将来谁给 Finding 加一个 `raw` 字段,就该从这里漏出去并被这条测到。
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

/** 假凭据一律拼出来:整串进任何一次提交都会被 GitHub push protection 拦掉 */
const fakeAws = (t16) => 'AKIA' + t16
const AWS_FULL = fakeAws('IOSFODNN7EXAMPLE')

const HAS = typeof T.buildToolReport === 'function' && typeof T.buildToolReportJson === 'function'
ok(HAS, 'buildToolReport / buildToolReportJson 已导出')
if (!HAS) {
  console.log('\n实现尚未落地,后续断言无法执行(这就是 RED 那一步)。')
  console.log(`\n${'='.repeat(56)}\nPASS ${pass}  FAIL ${failures.length}`)
  process.exit(1)
}

const CAPS = { tree: true, text: true, write: true, trash: true }
const META = {
  projectId: 'godot/project/p1', projectName: '示例项目', root: 'E:/games/demo',
  generatedAt: Date.UTC(2026, 9, 5, 8, 30, 0), truncated: false, fileCount: 1234, caps: CAPS
}
const mkTool = (id, name, needs = ['tree']) => ({ id, name, summary: name + ' 的说明', phase: 'P0', needs, run: async () => [] })
const mkResult = (toolId, findings = [], over = {}) => ({
  toolId, ok: true, findings, scannedFiles: over.scannedFiles ?? 10, ms: over.ms ?? 5, ...over
})
const f = (id, severity, title, extra = {}) => ({ id, severity, title, ...extra })

const TOOLS = [mkTool('size', '项目体积'), mkTool('scripts', '脚本体检', ['tree', 'text']), mkTool('format', '代码格式化', ['tree', 'write'])]

section('1. 头部元信息:项目 / 时间 / 截断 / 文件数')
{
  const md = T.buildToolReport(TOOLS, {}, META)
  ok(md.includes('示例项目'), '带项目名', md.slice(0, 80))
  ok(md.includes('E:/games/demo'), '带根目录', md.slice(0, 200))
  ok(/2026-10-05/.test(md), '生成时间是可读的日期(不是裸 epoch)', md.match(/2026[^\n]*/)?.[0])
  ok(md.includes('1234'), '带文件数', md.slice(0, 300))
  ok(/截断[^是否]*否/.test(md), '写明清单是否被截断', md.slice(0, 300))

  const tr = T.buildToolReport(TOOLS, {}, { ...META, truncated: true })
  ok(/截断[^是否]*是/.test(tr), '截断时必须自报', tr.slice(0, 300))
}

section('2. 三态齐列:跑过 / 没跑 / 宿主不支持 / 失败')
{
  const results = {
    size: mkResult('size', [f('size:total', 'info', '源文件共 1 MB')]),
    scripts: { toolId: 'scripts', ok: false, error: '宿主读不到文件', findings: [], scannedFiles: 0, ms: 0 }
  }
  const md = T.buildToolReport(TOOLS, results, META)
  const rows = md.split('\n').filter((l) => l.startsWith('|'))
  ok(TOOLS.every((t) => rows.some((r) => r.includes(t.name))), '汇总表每个注册工具各一行,一个不少', rows.join(' '))
  ok(rows.some((r) => r.includes('脚本体检') && /失败/.test(r)), '跑失败的那条状态是「失败」', rows.find((r) => r.includes('脚本体检')))
  ok(/宿主读不到文件/.test(md.slice(md.indexOf('### 脚本体检'))), '失败原因写在它的明细区', md.slice(md.indexOf('### 脚本体检'), md.indexOf('### 脚本体检') + 160))
  ok(rows.some((r) => r.includes('代码格式化') && /未运行/.test(r)), '没跑过的列「未运行」而不是消失', rows.find((r) => r.includes('代码格式化')))

  const noWrite = T.buildToolReport(TOOLS, results, { ...META, caps: { tree: true, text: true, write: false, trash: true } })
  // 断言必须盯**那一行本身**:汇总头部有「宿主不支持 N」这句,拿全文匹配 /不支持/ 会假绿
  const fmtRow = (noWrite.split('\n').find((l) => l.startsWith('|') && l.includes('代码格式化')) || '').trim()
  ok(/\| 宿主不支持 \|/.test(fmtRow), '宿主缺 write 时 format 那行的状态列是「宿主不支持」', fmtRow)
  ok(!/\| 未运行 \|/.test(fmtRow), '不能被写成「未运行」(那是在说用户没点,而不是宿主不能点)', fmtRow)
}

section('3. 计数与排序:error → warn → info')
{
  const findings = [
    f('x:i1', 'info', 'info 一'), f('x:e2', 'error', 'error 二'), f('x:w1', 'warn', 'warn 一'),
    f('x:e1', 'error', 'error 一'), f('x:i2', 'info', 'info 二'), f('x:w2', 'warn', 'warn 二'), f('x:i3', 'info', 'info 三')
  ]
  const md = T.buildToolReport(TOOLS, { size: mkResult('size', findings) }, META)
  const row = md.split('\n').find((l) => l.startsWith('|') && l.includes('项目体积'))
  ok(/\|\s*2\s*\|\s*2\s*\|\s*3\s*\|/.test(row || ''), '汇总按 error|warn|info 三列计数(2/2/3)', row)
  // 只按档排序,**同档内保持来源顺序**(稳定排序)—— e2 在源数组里就在 e1 前面,所以报告里也是它在前。
  // 这条同时钉住两件事:档位不能乱、实现不能顺手按标题字典序重排(那会让同档顺序随文案漂)。
  const order = ['error 二', 'error 一', 'warn 一', 'warn 二', 'info 一', 'info 二', 'info 三'].map((s) => md.indexOf(s))
  ok(order.every((n, i) => n >= 0 && (i === 0 || n > order[i - 1])), '明细按严重度排序、同档保序', JSON.stringify(order))
}

section('4. 明细带证据:rel:line 与 related')
{
  const findings = [f('s:dup:Foo', 'error', 'class_name Foo 重复', {
    rel: 'src/a.gd', line: 12, detail: '两份声明。', related: ['src/a.gd', 'src/b.gd']
  })]
  const md = T.buildToolReport(TOOLS, { scripts: mkResult('scripts', findings) }, META)
  ok(md.includes('src/a.gd:12'), '定位到文件与行', md.match(/[^\n]*Foo[^\n]*/g)?.join('|'))
  ok(md.includes('src/b.gd'), 'related 也进报告', md.slice(md.indexOf('src/b.gd') - 60, md.indexOf('src/b.gd') + 20))
  ok(md.includes('两份声明'), 'detail 正文进报告', '')
}

section('5. 上限:超过 20 条省略并报差额')
{
  const many = Array.from({ length: 25 }, (_, i) => f(`m:${i}`, 'info', `结论 ${i}`))
  const md = T.buildToolReport(TOOLS, { size: mkResult('size', many) }, META)
  const listed = many.filter((h) => md.includes(h.title)).length
  ok(listed === 20, '只列前 20 条(刷屏控制与界面同一条线)', listed)
  ok(md.includes('另有 5 条'), '省略多少要说出口', md.match(/[^\n]*省略[^\n]*/g)?.join('|') || md.slice(-200))
}

section('6. 红线:报告里没有凭据原文')
{
  const findings = [f('secrets:known-prefix:a.gd:3:0', 'error', 'a.gd:3 有厂商格式的凭据', {
    detail: `形态:AWS Access Key ID;值:AKIA•••LE(${AWS_FULL.length})。`
  })]
  const md = T.buildToolReport(TOOLS, { scripts: mkResult('scripts', findings) }, META)
  ok(!md.includes(AWS_FULL), 'Markdown 里不许出现完整串', md.slice(0, 120))
  ok(md.includes('AKIA•••LE'), '掩码照留(人要能对上是哪一条)', '')
  const json = JSON.stringify(T.buildToolReportJson(TOOLS, { scripts: mkResult('scripts', findings) }, META))
  ok(!json.includes(AWS_FULL), 'JSON 出口同样不许', json.slice(0, 120))
}

section('7. 一条都没跑:说清楚,不留空壳')
{
  const md = T.buildToolReport(TOOLS, {}, META)
  ok(/没有跑过|未运行/.test(md), '空结果要有一句人话', md.slice(-260))
  ok(!md.includes('undefined') && !md.includes('NaN'), '不出现 undefined/NaN 这类漏底', md.match(/undefined|NaN/g)?.join(','))
}

section('8. 纯文本纪律与 JSON 出口')
{
  const md = T.buildToolReport(TOOLS, { size: mkResult('size', [f('a', 'warn', '标题')]) }, META)
  ok(!md.includes('\r'), '统一 \\n,不夹 CRLF', JSON.stringify(md.slice(0, 40)))
  ok(!/<[a-z]/i.test(md), '不掺 HTML', md.match(/<[a-z][^>\n]*/i)?.[0])
  ok(md.endsWith('\n') && !md.endsWith('\n\n'), '结尾恰好一个换行', JSON.stringify(md.slice(-6)))

  const j = T.buildToolReportJson(TOOLS, { size: mkResult('size', [f('a', 'warn', '标题')]) }, META)
  ok(j.meta.projectName === '示例项目' && j.meta.generatedAt === META.generatedAt, 'JSON 带 meta', JSON.stringify(j.meta).slice(0, 90))
  ok(Array.isArray(j.tools) && j.tools.length === TOOLS.length, 'JSON 里每个注册工具一条', j.tools?.length)
  ok(j.tools.some((t) => t.toolId === 'size' && t.counts.warn === 1), 'JSON 计数与 Markdown 同源', JSON.stringify(j.tools[0]))
  ok(j.tools.some((t) => t.toolId === 'format' && t.status === 'skipped'), '没跑的在 JSON 里也有明确状态', JSON.stringify(j.tools[2]))
}

section('9. 红线:畸形入参不抛')
{
  for (const [tools, results, meta, label] of [
    [[], {}, META, '空 tools'],
    [TOOLS, null, META, 'results 为 null'],
    [TOOLS, { size: { toolId: 'size' } }, META, '结果缺字段'],
    [TOOLS, {}, { }, 'meta 为空对象'],
    [null, null, null, '全 null']
  ]) {
    let out = ''
    let threw = null
    try { out = T.buildToolReport(tools, results, meta) } catch (e) { threw = String(e && e.message) }
    ok(threw === null, `${label}:不抛`, threw)
    ok(typeof out === 'string', `${label}:仍给字符串`, typeof out)
    let threw2 = null
    try { T.buildToolReportJson(tools, results, meta) } catch (e) { threw2 = String(e && e.message) }
    ok(threw2 === null, `${label}:JSON 也不抛`, threw2)
  }
}

console.log(`\n${'='.repeat(56)}\nPASS ${pass}  FAIL ${failures.length}`)
if (failures.length) { console.log('失败项:'); for (const x of failures) console.log('  - ' + x); process.exit(1) }
console.log('全部通过')
