// 工具箱 · 第 1 批 Task 3:行级 LCS 的**性能基准**(§D #7:大文件上的表现)。
//
// 两条刻意保留的约定,来自第 0 批删掉的 `src/tools/__tests__/perf.test.mjs`:
//   1. **opt-in**:环境变量 `GPM_PERF_LINES` 没设、或设成小于 100 ⇒ 打印 SKIP 并退 0。
//      它会合成上万行文本,不该拖进每一次 `npm test`。
//   2. **刻意不挂 `npm test`**:`package.json` 里只有 `test:perf:diff`,要跑就明确点名列。
//
// 钉的不是「多少毫秒」这种机器相关的数字,而是**两件事实**:
//   · 局部改动在巨型文件上不许触退化(前后缀剥离把 LCS 规模压到常数级)——这是格式化预览的常态;
//   · 完全改写必须触退化,而且**不许真去算那张 4 亿格的表**(DEV-9 的预算闸是界面冻结的唯一防线)。
// 时间只测量并打印出来看趋势;真要卡回归,看的是下面两条判据红没红,不是毫秒数。
//
// 用法:GPM_PERF_LINES=8000 node src/toolkit/__tests__/diff.perf.mjs
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../../..')
const BUNDLE = path.resolve(ROOT, '.gpm-test/out/tkdiff.mjs')

const LIMIT = Number(process.env.GPM_PERF_LINES || 0)
if (!Number.isFinite(LIMIT) || LIMIT < 100) {
  console.log('SKIP 性能基准:未设 GPM_PERF_LINES 或小于 100(它会合成上万行文本,不该进每次 npm test)')
  console.log('用法: GPM_PERF_LINES=8000 node src/toolkit/__tests__/diff.perf.mjs')
  process.exit(0)
}
if (!existsSync(BUNDLE)) {
  console.error(`找不到打包产物: ${BUNDLE}`)
  console.error('请先运行: node src/composables/__tests__/build-bundle.mjs')
  process.exit(2)
}

const T = await import(pathToFileURL(BUNDLE).href)

let pass = 0
const failures = []
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log(`  PASS  ${label}`) }
  else { failures.push(label); console.log(`  FAIL  ${label}${extra !== undefined ? '  → ' + JSON.stringify(extra) : ''}`) }
}
const timed = (fn) => {
  const t0 = performance.now()
  const r = fn()
  return { r, ms: Math.round(performance.now() - t0) }
}

const N = Math.max(100, Math.floor(LIMIT))
const mk = (n, tag) => Array.from({ length: n }, (_, i) => `${tag}${i}`).join('\n')

console.log(`\n=== 性能基准 · GPM_PERF_LINES=${N} · MAX_LCS_CELLS=${T.MAX_LCS_CELLS} ===`)

// ① 局部改动:N 行里只改中间一行。前后缀剥完之后中间段只有 2×2 格。
{
  const a = mk(N, 'l')
  const b = a.split('\n').map((x, i) => (i === Math.floor(N / 2) ? 'CHANGED' : x)).join('\n')
  const { r: d, ms } = timed(() => T.diffText(a, b))
  console.log(`  · ${N} 行改 1 行:${ms} ms,degraded=${d.degraded},+${d.added} -${d.removed}`)
  ok(d.degraded === false, '局部改动在巨型文件上不许触退化(否则格式化预览只会显示「差异过大」)', d.degraded)
  ok(d.added === 1 && d.removed === 1, `${N} 行里的单行改动仍报 +1 -1`, { add: d.added, rem: d.removed })
  const same = d.lines.filter((x) => x.op === 'same').length
  const dels = d.lines.filter((x) => x.op === 'del').length
  const adds = d.lines.filter((x) => x.op === 'add').length
  ok(same + dels === d.oldCount && same + adds === d.newCount,
    `${N} 行上的不变式:same+del=旧行数、same+add=新行数(行数守恒,UI 不会画丢行)`,
    { same, dels, adds, oldCount: d.oldCount, newCount: d.newCount })
}

// ② 完全改写:N 行 vs N 行不同 ⇒ 必须退化,且退化必须**快**(证明没去算那张表)
{
  const a = mk(N, 'a')
  const b = mk(N, 'b')
  const { r: d, ms } = timed(() => T.diffText(a, b))
  const cells = N * N
  console.log(`  · ${N}×${N} 全不同(${cells} 格):${ms} ms,degraded=${d.degraded}`)
  if (cells > T.MAX_LCS_CELLS) {
    ok(d.degraded === true, `超出预算(${cells}>${T.MAX_LCS_CELLS})⇒ 必须退化`, d.degraded)
    ok(ms < 3000, '退化路径必须很快(慢了就说明它其实在算那张表)', { ms })
    ok(d.lines.length === 0 && d.oldCount === N, '退化时不给逐行结果,但两侧行数照说', d.lines.length)
  } else {
    ok(d.degraded === false, `预算内(${cells}≤${T.MAX_LCS_CELLS})⇒ 不该退化`, d.degraded)
  }
}

// ③ 中间段刚好压在预算线上:退化闸读的是**剥完前后缀之后**的规模,不是文件行数
{
  const half = Math.floor(N / 2)
  const a = [mk(half, 'p'), mk(half, 'x'), mk(half, 's')].join('\n')
  const b = [mk(half, 'p'), mk(half, 'y'), mk(half, 's')].join('\n')
  const { r: d, ms } = timed(() => T.diffText(a, b))
  const midCells = half * half
  console.log(`  · 中间段 ${half}×${half}=${midCells} 格:${ms} ms,degraded=${d.degraded}`)
  ok(d.degraded === (midCells > T.MAX_LCS_CELLS),
    `退化判据只看中间段(${midCells} 格 vs 预算 ${T.MAX_LCS_CELLS}),不看文件总行数`, d.degraded)
}

console.log(`\n${'='.repeat(56)}\nPASS ${pass}  FAIL ${failures.length}`)
if (failures.length) {
  console.log('失败项:')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log('全部通过')
