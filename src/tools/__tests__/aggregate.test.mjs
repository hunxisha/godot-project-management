// 聚合判据回归测试:跨工具分组、组间/组内排序、筛选口径。
//
// 为什么值得单测:聚合流的「哪条排在最上面」就是这一页的产品主张。
// 判据一旦写进 .vue 就跑不进 Node harness —— 先例见 src/tools/outcome.ts:1-4,
// 那里的判据曾住在视图的 computed 里,于是「扫描失败 + 陈旧全绿结论」并排显示只能靠肉眼发现。
//
// 用法:
//   node src/composables/__tests__/build-bundle.mjs && node src/tools/__tests__/aggregate.test.mjs
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../../..')
const BUNDLE = path.resolve(ROOT, '.gpm-test/out/tools.mjs')
if (!existsSync(BUNDLE)) {
  console.error(`找不到打包产物: ${BUNDLE}\n请先运行: node src/composables/__tests__/build-bundle.mjs`)
  process.exit(2)
}

let pass = 0
const failures = []
function ok(cond, label, extra) {
  if (cond) { pass++; console.log(`  PASS  ${label}`) }
  else { failures.push(label); console.log(`  FAIL  ${label}${extra !== undefined ? '  → ' + extra : ''}`) }
}
function section(t) { console.log(`\n=== ${t} ===`) }

const T = await import(pathToFileURL(BUNDLE).href)

/** 造一条结论:id 必须是 `${toolId}:${键}` 形态 —— 修复后重跑靠这个前缀反推 */
const f = (toolId, key, severity, rest = {}) => ({
  id: `${toolId}:${key}`, severity, title: `${toolId} 的 ${key}`, rel: `${key}.txt`, ...rest
})
const mkTool = (id, category) => ({ id, name: id, summary: '', phase: 'P0', category, needs: ['tree'], run: async () => [] })
const mkResult = (toolId, findings) => ({
  toolId, ok: true, findings, scannedFiles: findings.length, ms: 1
})

section('1. 分组与顺序')
// 夹具的两处刻意设计,否则断言恒真(变异取证过):
//  · config 的 error 条数**多于** refs,而 refs 在 CATEGORIES 里排前面 —— 组间若真按条数排,
//    结果必须与登记顺序相反;删掉那条 tiebreak 就会转红。
//  · refs 的入参顺序是 warn,error,warn —— 组内降序才有得测;两条 warn 的相对顺序则钉住「同档不重排」。
const tools = [mkTool('size', 'weight'), mkTool('cache', 'weight'), mkTool('brokenRefs', 'refs'), mkTool('ini', 'config')]
const res = {
  size: mkResult('size', [f('size', 'a', 'info')]),
  cache: mkResult('cache', []),
  brokenRefs: mkResult('brokenRefs', [f('brokenRefs', 'y', 'warn'), f('brokenRefs', 'x', 'error'), f('brokenRefs', 'y2', 'warn')]),
  ini: mkResult('ini', [f('ini', 'k', 'error'), f('ini', 'k2', 'error')])
}
const g = T.aggregate(tools, res, true)
ok(g.length === 3, '只对有结论的类别出组(size 有 1 条 info,故 weight 仍出组;cache 零结论不出组)',
  JSON.stringify(g.map((x) => x.category)))
ok(g[0].category === 'config' && g[1].category === 'refs',
  '同为有 error 的两组按 error 条数排(config 2 条 > refs 1 条),而不是按 CATEGORIES 的登记顺序',
  JSON.stringify(g.map((x) => [x.category, x.counts.error])))
ok(g[2].category === 'weight', 'info-only 的组排在有 error 的组之后', JSON.stringify(g.map((x) => x.category)))
ok(g[1].items.map((i) => i.finding.severity).join(',') === 'error,warn,warn',
  '组内按严重度降序(入参是 warn,error,warn)', JSON.stringify(g[1].items.map((i) => i.finding.severity)))
ok(g[1].items.map((i) => i.finding.id).join(',') === 'brokenRefs:x,brokenRefs:y,brokenRefs:y2',
  '同档保持注册表顺序,不重排(同档重排会让两次渲染顺序不同)', JSON.stringify(g[1].items.map((i) => i.finding.id)))

section('2. 每条带出处与可修复标志')
const fxFix = f('orphans', 'o', 'warn', { fix: { kind: 'trash', label: '移入回收站', payload: ['scene/main.tscn'] } })
const fxNone = f('size', 's', 'info')
const g2 = T.aggregate([mkTool('orphans', 'assets'), mkTool('size', 'weight')],
  { orphans: mkResult('orphans', [fxFix, fxNone]), size: mkResult('size', []) }, true)
const assets = g2.find((x) => x.category === 'assets')
ok(assets.items[0].toolId === 'orphans' && assets.items[0].toolName === 'orphans' && assets.items[0].category === 'assets',
  '每条带 toolId/toolName/category,视图不自己反推',
  JSON.stringify([assets.items[0].toolId, assets.items[0].toolName, assets.items[0].category]))
ok(assets.items[0].fixable === true, 'trash 类修复在 Windows 口径下判为可执行', String(assets.items[0].fixable))
ok(assets.items[1].fixable === false, '没有 fix 字段的结论不算可修复', String(assets.items[1].fixable))

section('3. 纯函数:不许改动收到的结论')
const src = [f('brokenRefs', 'x', 'warn'), f('brokenRefs', 'y', 'error')]
const frozen = src.map((x) => x.id).join(',')
const r3 = mkResult('brokenRefs', src)
T.aggregate([mkTool('brokenRefs', 'refs')], { brokenRefs: r3 }, true)
ok(r3.findings.map((x) => x.id).join(',') === frozen,
  '不就地排序入参(渲染期改动共享状态会让别的订阅者看到被改过的数组)', r3.findings.map((x) => x.id).join(','))

section('4. 空输入与边界')
ok(T.aggregate([], {}, true).length === 0, '一份结论都没有 → 空数组,不抛')
ok(T.aggregate([mkTool('size', 'weight')],
  { size: { toolId: 'size', ok: false, error: '检查失败', findings: [], scannedFiles: 0, ms: 1 } }, true).length === 0,
  '失败的工具不产组(失败在摘要带与左栏徽标上点名,不在问题流里冒充结论)')

console.log(`\n${'='.repeat(56)}\nPASS ${pass}  FAIL ${failures.length}`)
if (failures.length) { console.log('失败项:'); for (const m of failures) console.log('  - ' + m); process.exit(1) }
console.log('全部通过')
