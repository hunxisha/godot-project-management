// 渲染层格式化函数回归测试(经 vite 打包后在 Node 里跑,见 build-bundle.mjs)。
//
// 为什么需要这个测试:版本号归一化原本有**两份实现,而且行为不一致**——
//   VersionPickerDialog.vue 的 norm():   trim + 只去掉一个前缀 v
//   MarketplaceView.vue 的 fmtVer():     不 trim + 去掉连续多个前缀 v
// 于是 ' v4.3' 这类输入在两处会得到不同结果,「切换到该版本」的相等判断可能失效。
// 现已统一到 src/utils/format.ts 的 normVersion()。这里做两件事:
//   1. 锁住归一化行为(改行为必须改测试,不能悄悄漂移);
//   2. 去重护栏 —— 禁止第二份实现重新长出来(功能等价于「只剩一份」这条验收项)。
//
// 用法(npm script 会先跑打包步骤):
//   npm run test:format
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../..')
const SRC = path.resolve(ROOT, 'src')
const BUNDLE = path.resolve(ROOT, '.gpm-test/out/format.mjs')

if (!existsSync(BUNDLE)) {
  console.error(`找不到打包产物: ${BUNDLE}`)
  console.error('请先运行: node src/composables/__tests__/build-bundle.mjs')
  process.exit(2)
}

const { normVersion } = await import(pathToFileURL(BUNDLE).href)

let pass = 0
const failures = []
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log(`  PASS  ${label}`) }
  else { failures.push(label); console.log(`  FAIL  ${label}${extra !== undefined ? '  → ' + extra : ''}`) }
}
const section = (t) => console.log(`\n=== ${t} ===`)

// ---------- 1. 归一化行为 ----------
section('1. normVersion:去空白 + 去掉前缀 v/V(连续多个也去掉)')

const cases = [
  ['4.3.1', '4.3.1', '无前缀原样返回'],
  ['v4.3.1', '4.3.1', '小写 v 前缀'],
  ['V4.3.1', '4.3.1', '大写 V 前缀'],
  [' v4.3.1 ', '4.3.1', '首尾空白一并去掉'],
  ['vv4.3', '4.3', '连续多个 v 全部去掉'],
  ['4.3-stable', '4.3-stable', '频道后缀不受影响'],
  ['local', 'local', '非版本串原样返回'],
  ['', '', '空串返回空串'],
  [undefined, '', 'undefined 归为空串'],
  [null, '', 'null 归为空串']
]

for (const [input, expect, label] of cases) {
  const actual = normVersion(input)
  ok(actual === expect, `${label}: ${JSON.stringify(input)} → ${JSON.stringify(expect)}`, JSON.stringify(actual))
}

// isCurrent() 依赖的不变量:带不带 v 前缀必须判等
ok(normVersion('v4.3.1') === normVersion('4.3.1'), '不变量:v4.3.1 与 4.3.1 归一化后相等')
ok(normVersion(' V4.3.1 ') === normVersion('v4.3.1'), '不变量:大小写与空白不影响判等')

// ---------- 2. 去重护栏 ----------
section('2. 去重护栏:不得存在第二份版本归一化实现')

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|vue|js|mjs)$/.test(name)) out.push(p)
  }
  return out
}

const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/')
const sources = walk(SRC).filter((p) => !p.includes(`${path.sep}__tests__${path.sep}`))

// 归一化的特征写法:去前缀 v 的正则 /^v+/i(解析用的 /^v?( 不算)
const reImpl = /\^v\+/
const hits = sources.filter((p) => reImpl.test(readFileSync(p, 'utf-8'))).map(rel)
ok(hits.length === 1, '全渲染层只有一处去前缀 v 的实现', hits.join(', '))
ok(hits[0] === 'src/utils/format.ts', '该实现在 src/utils/format.ts 内', hits[0])

// 命名实现不得复活
const reNamed = /\bfunction\s+(?:fmtVer|norm)\s*\(/
const named = sources.filter((p) => reNamed.test(readFileSync(p, 'utf-8'))).map(rel)
ok(named.length === 0, '不存在名为 fmtVer / norm 的第二份归一化函数', named.join(', '))

// 调用方应只用共享实现
const callers = ['src/views/MarketplaceView.vue', 'src/components/dialogs/VersionPickerDialog.vue']
for (const c of callers) {
  const code = readFileSync(path.resolve(ROOT, c), 'utf-8')
  ok(/normVersion/.test(code), `${c} 使用共享的 normVersion`)
  ok(!/\bfmtVer\s*\(/.test(code), `${c} 不再引用本地 fmtVer`)
}

// ---------- 结果 ----------
console.log(`\n${'='.repeat(56)}`)
console.log(`PASS ${pass}  FAIL ${failures.length}`)
if (failures.length) {
  console.log('失败项:')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log('全部通过')
