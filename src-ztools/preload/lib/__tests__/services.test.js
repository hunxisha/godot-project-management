// preload 服务面契约测试:window.services 与类型契约 Services 必须逐项一致。
//
// 为什么需要:渲染层访问宿主能力只有一条路 —— window.services(47 个透传方法,实现在
// src-ztools/preload/services.js),其类型契约在 src/types/services.ts。
//
// 演进说明:这份契约原先手写在 src/env.d.ts,与 services.js 各写一遍、靠本测试比对。
// 现在 services.js 用 `@type {import('../../src/types/services').Services}` 直接引用它,
// **编译器**已能强制 47 个方法一个不多一个不少(见 docs/optimization-plan.md 的 P0-2)。
// 这个测试因此从「唯一的护栏」变成「双保险」:
//   · 编译器管签名是否匹配(本测试看不见的那部分);
//   · 本测试管运行时对象真的有这些键(编译产物若被手改/降级打包,这里会立刻发现)。
//
// 解析对象已从 env.d.ts 改为 src/types/services.ts。
//
// 用法:
//   node src-ztools/preload/lib/__tests__/services.test.js
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '../../../..')
const SERVICES = path.resolve(ROOT, 'src-ztools/preload/services.js')
const DTS = path.resolve(ROOT, 'src/types/services.ts')

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
const start = dts.indexOf('export interface Services {')
if (start < 0) {
  console.error('src/types/services.ts 中找不到 export interface Services')
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
ok(declaredKeys.length > 0, `Services 契约声明 ${declaredKeys.length} 个方法`, String(declaredKeys.length))

section('2. 实现与声明逐项一致')

const implSet = new Set(implKeys)
const declSet = new Set(declaredKeys)

const missingImpl = declaredKeys.filter((k) => !implSet.has(k))
ok(
  missingImpl.length === 0,
  'Services 契约声明的每个方法都有实现',
  missingImpl.length ? `缺少实现: ${missingImpl.join(', ')}` : ''
)

const missingDecl = implKeys.filter((k) => !declSet.has(k))
ok(
  missingDecl.length === 0,
  'services.js 的每个方法都有类型声明',
  missingDecl.length ? `缺少声明(请补 src/types/services.ts 的 export interface Services): ${missingDecl.join(', ')}` : ''
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
