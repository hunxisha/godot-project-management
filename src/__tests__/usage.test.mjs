// 渲染层使用时长聚合函数回归测试(经 vite 打包后在 Node 里跑,见 build-bundle.mjs)。
//
// 锁住四件事:色阶阈值(热力图观感的锚)、fmtMinutes 文案口径、网格形状(周一起始/future
// 占位/月份刻度)、汇总统计(本周/连续/累计)。阈值改了必须改这里,不能悄悄漂移。
//
// 用法(npm script 会先跑打包步骤):
//   npm run test:renderer
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../..')
const BUNDLE = path.resolve(ROOT, '.gpm-test/out/usage.mjs')

if (!existsSync(BUNDLE)) {
  console.error(`找不到打包产物: ${BUNDLE}`)
  console.error('请先运行: node src/composables/__tests__/build-bundle.mjs')
  process.exit(2)
}

const u = await import(pathToFileURL(BUNDLE).href)

let pass = 0
const failures = []
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log(`  PASS  ${label}`) }
  else { failures.push(label); console.log(`  FAIL  ${label}${extra !== undefined ? '  → ' + extra : ''}`) }
}
const eq = (actual, expect, label) =>
  ok(JSON.stringify(actual) === JSON.stringify(expect), label, JSON.stringify(actual))
const section = (t) => console.log(`\n=== ${t} ===`)

// 本地时区构造(直接给 Date 分量,避开 UTC 字符串歧义)
const D = (y, m, d) => new Date(y, m - 1, d).getTime()
const key = (y, m, d) => u.dayKeyOf(D(y, m, d))

// ---------- 1. levelOf ----------
section('1. levelOf:0 / >0 / ≥30 / ≥90 / ≥180 五档')
for (const [minutes, expect, label] of [
  [0, 0, '无记录'], [-5, 0, '负数按无记录'], [1, 1, '碰过引擎'], [29, 1, '未到 30'],
  [30, 2, '半小时'], [89, 2, '未到 90'], [90, 3, '一个半小时'], [179, 3, '未到 180'],
  [180, 4, '三小时'], [600, 4, '封顶档']
]) {
  eq(u.levelOf(minutes), expect, `${label}(${minutes} 分钟)`)
}

// ---------- 2. fmtMinutes ----------
section('2. fmtMinutes:分钟口径文案')
eq(u.fmtMinutes(0), '0 分钟', '零')
eq(u.fmtMinutes(45), '45 分钟', '不足一小时')
eq(u.fmtMinutes(60), '1 小时', '整点不带分')
eq(u.fmtMinutes(75), '1 小时 15 分', '一时十五分')
eq(u.fmtMinutes(130), '2 小时 10 分', '两小时十分')

// ---------- 3. buildHeatmapGrid ----------
section('3. buildHeatmapGrid:周一起始 / future 占位 / 月份刻度')
// 2026-11-14 是周六(与概览页截图同一天);本列 11-09(周一)~11-15(周日)
const days = {
  [key(2026, 11, 12)]: 200,
  [key(2026, 11, 13)]: 35,
  [key(2026, 11, 9)]: 5
}
const grid = u.buildHeatmapGrid(days, { weeks: 4, now: D(2026, 11, 14, 15, 0) })
eq(grid.length, 4, '4 周 → 4 列')
eq(grid[0].cells[0].key, key(2026, 10, 19), '首列从周一起算(10-19)')
eq(grid[3].cells[5].key, key(2026, 11, 14), '末列第 6 格是今天(周六)')
eq(grid[3].cells[6].future, true, '今天的明天标 future')
eq(grid[3].cells[5].future, false, '今天不是 future')
eq(grid[3].cells[3].key, key(2026, 11, 12), '末列第 4 格是周四 11-12')
eq(grid[3].cells[3].minutes, 200, '11-12 的分钟数来自 days')
eq(grid[3].cells[3].level, 4, '200 分钟 → 4 档')
eq(grid[3].cells[4].level, 2, '35 分钟 → 2 档')
eq(grid[3].cells[6].minutes, 0, 'future 格无数据')
ok(grid.some((c) => c.monthLabel === '11月'), '有 11 月刻度', JSON.stringify(grid.map((c) => c.monthLabel)))
ok(grid.some((c) => c.monthLabel === '10月'), '首列标 10 月')

// ---------- 4. 汇总:本周 / 连续 / 累计 ----------
section('4. weekMinutes / streakOf / totalMinutes')
// 本周(2026-11-09 周一起):09/12/13 三天有记录,now=周六 11-14
eq(u.weekMinutes(days, D(2026, 11, 14, 15, 0)), 240, '本周合计 = 5+200+35')
eq(u.weekMinutes({}, D(2026, 11, 14, 15, 0)), 0, '无记录 → 0')
// 连续:今天(11-14)没记录不算断,从昨天往回数 13/12 → 2;11-11 空档截断
eq(u.streakOf(days, D(2026, 11, 14, 15, 0)), 2, '今天没用不断签')
eq(u.streakOf({ ...days, [key(2026, 11, 14)]: 20 }, D(2026, 11, 14, 23, 0)), 3, '今天有记录连上')
eq(u.streakOf({ [key(2026, 11, 13)]: 10, [key(2026, 11, 11)]: 8 }, D(2026, 11, 14, 15, 0)), 1, '空档截断')
eq(u.streakOf({}, D(2026, 11, 14, 15, 0)), 0, '全空 → 0')
eq(u.totalMinutes(days), 240, '累计 = 所有日相加')

// ---------- 5. dayKeyOf ----------
section('5. dayKeyOf:本地时区补零')
eq(key(2026, 11, 14), '2026-11-14', '补零')
eq(key(2026, 1, 3), '2026-01-03', '一月补零')

console.log(`\nPASS ${pass}  FAIL ${failures.length}`)
if (failures.length) {
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log('全部通过')
