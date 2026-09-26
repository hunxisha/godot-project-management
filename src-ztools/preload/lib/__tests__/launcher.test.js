// launcher 的启动参数拆分回归测试(支持引号内的空白)。
//
// 用法:
//   node src-ztools/preload/lib/__tests__/launcher.test.js
const path = require('node:path')

const LIB = path.resolve(__dirname, '..')
const { splitLaunchArgs } = require(path.join(LIB, 'launcher.js'))

let pass = 0
const failures = []
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log(`  PASS  ${label}`) }
  else { failures.push(label); console.log(`  FAIL  ${label}${extra !== undefined ? '  → ' + extra : ''}`) }
}
const eq = (actual, expect, label) =>
  ok(JSON.stringify(actual) === JSON.stringify(expect), label, JSON.stringify(actual))

eq(splitLaunchArgs(undefined), [], '未设置参数 → 空数组')
eq(splitLaunchArgs(''), [], '空串 → 空数组')
eq(splitLaunchArgs('   '), [], '纯空白 → 空数组')
eq(splitLaunchArgs('--debug'), ['--debug'], '单参数')
eq(splitLaunchArgs('--resolution 1280x720'), ['--resolution', '1280x720'], '多参数按空白切分')
eq(splitLaunchArgs('"a b" c'), ['a b', 'c'], '引号内空白属于同一参数')
eq(splitLaunchArgs('--x="a b" --y'), ['--x=a b', '--y'], '引号出现在参数中段')
eq(splitLaunchArgs('  --a   --b  '), ['--a', '--b'], '多余空白被忽略')
eq(splitLaunchArgs('未完结"引号'), ['未完结引号'], '未闭合引号不抛错')

console.log(`\nPASS ${pass}  FAIL ${failures.length}`)
if (failures.length) {
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log('全部通过')
