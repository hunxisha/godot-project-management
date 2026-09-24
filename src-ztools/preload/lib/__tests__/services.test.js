// preload 服务面契约测试:window.services 与 src/env.d.ts 的 Services 接口必须一致。
//
// 为什么需要:渲染层访问宿主能力只有一条路 —— window.services(定义在
// src-ztools/preload/services.js 的 47 个透传方法),而它的类型是**手写**在
// src/env.d.ts 的 interface Services 里的。两边一旦漂移,渲染层就会拿到
// 「类型说有、运行时没有」的方法(或缺类型断言),而 TypeScript 无法发现,
// 因为它只看得见 env.d.ts 那一侧。
//
// 这个测试把「两处手写」变成「一处实现 + 一处声明 + 一个断言」:
//   - 只改 services.js 忘了改 env.d.ts → 报「声明缺失」
//   - 只改 env.d.ts 忘了实现         → 报「实现缺失」
//
// 用法:
//   node src-ztools/preload/lib/__tests__/services.test.js
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '../../../..')
const SERVICES = path.resolve(ROOT, 'src-ztools/preload/services.js')
const DTS = path.resolve(ROOT, 'src/env.d.ts')

let pass = 0
const failures = []
function ok(cond, label, extra) {
  if (cond) {
    pass++
    console.log(`  PASS  ${label}`)
  } else {
    failures.push(label)
    console.log(`  FAIL  ${label}${extra !== undefined ? '  → ' + extra : ''}`)
  }
}
function section(t) {
  console.log(`\n=== ${t} ===`)
}

// ---------- 加载真实实现 ----------
// services.js 的写法是 window.services = {...}(不是 module.exports),且各领域模块
// 只在函数体内访问 window.ztools,所以给一个空 window 即可安全加载。
global.window = {}
require(SERVICES)
const implemented = window.services
const implKeys = Object.keys(implemented).sort()

// ---------- 解析手写声明 ----------
if (!fs.existsSync(DTS)) {
  console.error(`找不到类型声明: ${DTS}`)
  process.exit(2)
}
const dts = fs.readFileSync(DTS, 'utf-8')
const start = dts.indexOf('interface Services {')
if (start < 0) {
  console.error('env.d.ts 中找不到 interface Services')
  process.exit(2)
}
const end = dts.indexOf('\n}', start)
const block = dts.slice(start, end)
// 成员行形如「  currentPlatform(): ...」「  downloadAndInstall(」——恰两个空格缩进
const declaredKeys = [...block.matchAll(/^ {2}([A-Za-z_][A-Za-z0-9_]*)\s*[(<]/gm)]
  .map((m) => m[1])
  .sort()

section('1. 解析结果')
ok(implKeys.length > 0, `services.js 导出 ${implKeys.length} 个方法`, String(implKeys.length))
ok(declaredKeys.length > 0, `env.d.ts 声明 ${declaredKeys.length} 个方法`, String(declaredKeys.length))

section('2. 实现与声明逐项一致')

const implSet = new Set(implKeys)
const declSet = new Set(declaredKeys)

const missingImpl = declaredKeys.filter((k) => !implSet.has(k))
ok(
  missingImpl.length === 0,
  'env.d.ts 声明的每个方法都有实现',
  missingImpl.length ? `缺少实现: ${missingImpl.join(', ')}` : ''
)

const missingDecl = implKeys.filter((k) => !declSet.has(k))
ok(
  missingDecl.length === 0,
  'services.js 的每个方法都有类型声明',
  missingDecl.length ? `缺少声明(请补 env.d.ts 的 interface Services): ${missingDecl.join(', ')}` : ''
)

ok(implKeys.length === declaredKeys.length, '两侧数量一致', `实现 ${implKeys.length} / 声明 ${declaredKeys.length}`)

section('3. 导出值都是可调用方法')
const notFn = implKeys.filter((k) => typeof implemented[k] !== 'function')
ok(notFn.length === 0, 'window.services 的每个成员都是函数', notFn.join(', '))

section('4. 平台能力可调用(冒烟)')
ok(implemented.currentPlatform() === 'win64' || ['win64', 'macos', 'linux64'].includes(implemented.currentPlatform()), 'currentPlatform() 返回合法平台标识', implemented.currentPlatform())

// ---------- 结果 ----------
console.log(`\n${'='.repeat(56)}`)
console.log(`PASS ${pass}  FAIL ${failures.length}`)
if (failures.length) {
  console.log('失败项:')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log('全部通过')
