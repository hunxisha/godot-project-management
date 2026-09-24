// preload 沙箱边界的守门测试。
//
// 背景:preload 跑在 ZTools 宿主沙箱里,不是 Node —— 没有 setImmediate,fs.promises 也不完整。
// 项目此前踩过一次真实事故(docs/backup-redesign-plan.md §15):代码用了 setImmediate,
// 只跑 Node 的测试全绿,一进宿主就 `setImmediate is not defined`。
//
// 现在边界由 `src-ztools/preload/sandbox.d.ts`(路线 B:手写精简声明)描述,并**刻意不声明
// setImmediate** —— 于是它始终是 TS2304,编译器会替我们盯着。本测试补上扫描类断言:
//
//   1. 用到的 node 模块与声明里的模块必须**完全一致**(不多不少)。多了说明声明在腐化,
//      少了说明有人扩大了运行时依赖却没留下痕迹 —— 后者正是应该被 review 看到的改动。
//   2. sandbox.d.ts 不得声明 setImmediate(声明了就等于把 §15 的教训从类型检查里撤掉)。
//   3. setImmediate 只允许出现在 fsutil.js 的 yieldToLoop 里,且必须带 @ts-expect-error。
//
// 用法:
//   node src-ztools/preload/lib/__tests__/sandbox.test.js
const fs = require('node:fs')
const path = require('node:path')

const PRELOAD = path.resolve(__dirname, '..', '..')
const SANDBOX_DTS = path.join(PRELOAD, 'sandbox.d.ts')

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

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    if (fs.statSync(p).isDirectory()) walk(p, out)
    else if (name.endsWith('.js')) out.push(p)
  }
  return out
}

const sources = walk(PRELOAD).filter((p) => !p.includes(`${path.sep}__tests__${path.sep}`))
const rel = (p) => path.relative(PRELOAD, p).replace(/\\/g, '/')
const read = (p) => fs.readFileSync(p, 'utf-8')
/**
 * 逐行剥掉**块注释与行注释**,返回与原文行号一一对应的「纯代码」数组。
 * 需要它是因为 fsutil.js 的头部注释里就写着 setImmediate(解释 §15 那次事故),
 * 直接按行匹配会把说明文字算成使用点。
 */
function codeLines(text) {
  const out = []
  let inBlock = false
  for (const raw of text.split(/\r?\n/)) {
    let code = ''
    let i = 0
    while (i < raw.length) {
      if (inBlock) {
        const end = raw.indexOf('*/', i)
        if (end === -1) {
          i = raw.length
          break
        }
        inBlock = false
        i = end + 2
        continue
      }
      const b = raw.indexOf('/*', i)
      const l = raw.indexOf('//', i)
      if (l !== -1 && (b === -1 || l < b)) {
        code += raw.slice(i, l)
        break
      }
      if (b === -1) {
        code += raw.slice(i)
        break
      }
      code += raw.slice(i, b)
      inBlock = true
      i = b + 2
    }
    out.push(code)
  }
  return out
}
const dts = read(SANDBOX_DTS)
const dtsCode = codeLines(dts).join('\n')

// ---------- 1. 声明的 node 模块与用到的必须一致 ----------
section('1. node 模块:声明面 == 使用面')

const used = new Set()
for (const p of sources) {
  for (const m of read(p).matchAll(/require\('node:([a-z_]+)'\)/g)) used.add(m[1])
}
const declared = new Set([...dts.matchAll(/declare module 'node:([a-z_]+)'/g)].map((m) => m[1]))

const missing = [...used].filter((m) => !declared.has(m)).sort()
const extra = [...declared].filter((m) => !used.has(m)).sort()
ok(missing.length === 0, '用到的 node 模块都已在 sandbox.d.ts 声明', missing.join(', '))
ok(extra.length === 0, 'sandbox.d.ts 没有声明用不到的模块(保持精简)', extra.join(', '))
ok(used.size === 11, `实际用到 11 个 node 模块(实测 ${used.size})`, [...used].sort().join(', '))

// ---------- 2. 不得声明 setImmediate ----------
section('2. setImmediate 必须保持「未声明」')

ok(
  !/declare\s+(const|var|let|function)\s+setImmediate\b/.test(dtsCode),
  'sandbox.d.ts 没有声明 setImmediate'
)
ok(!/\bsetImmediate\b/.test(dtsCode), 'sandbox.d.ts 的非注释内容不出现 setImmediate')
// 两个全局的声明方式写死:Buffer 有意为 any(真实依赖面在 extract.js 的 ByteBuf),process 写实结构
ok(/declare const Buffer: any/.test(dts), 'Buffer 声明为 any(依赖面由 extract.js 的 ByteBuf 描述)')
ok(/declare const process: \{/.test(dts), 'process 声明为具体结构')

// ---------- 3. setImmediate 只允许出现在 fsutil.js 的 yieldToLoop ----------
section('3. setImmediate 使用点:仅 fsutil.js 且必须带 @ts-expect-error')

let hits = 0
const offenders = []
for (const p of sources) {
  const raw = read(p)
  const rawLines = raw.split(/\r?\n/)
  const code = codeLines(raw)
  code.forEach((line, i) => {
    if (!/\bsetImmediate\b/.test(line)) return
    hits++
    if (rel(p) !== 'lib/fsutil.js') return offenders.push(rel(p))
    const prev = (rawLines[i - 1] || '').trim()
    if (!prev.startsWith('// @ts-expect-error')) offenders.push(`${rel(p)}:${i + 1} 缺 @ts-expect-error`)
  })
}
ok(hits === 2, `setImmediate 全仓只有 2 处代码使用(实测 ${hits})`)
ok(offenders.length === 0, '2 处都在 fsutil.js 的 yieldToLoop 且紧跟 @ts-expect-error', offenders.join(', '))
ok(
  !/declare\s+const\s+setImmediate/.test(dtsCode) && hits === 2,
  '护栏闭环:未声明 + 2 处显式抑制 —— 若将来引入 @types/node,抑制会变成「未使用」而报错'
)

// ---------- 4. 降级链仍存在(§15 的修复本身) ----------
section('4. yieldToLoop 的三级降级链仍在')

const fsutil = read(path.join(PRELOAD, 'lib', 'fsutil.js'))
const fsutilCode = codeLines(fsutil).join('\n')
const yieldIdx = fsutilCode.indexOf('function yieldToLoop')
const yieldBody = fsutilCode.slice(yieldIdx, yieldIdx + 800)
ok(yieldIdx > 0, 'yieldToLoop 仍存在')
ok(/setImmediate/.test(yieldBody), '一级:setImmediate')
ok(/MessageChannel/.test(fsutilCode), '二级:MessageChannel(惰性创建于 getChannel)')
ok(/setTimeout/.test(yieldBody), '三级:setTimeout 兜底')

// ---------- 结果 ----------
console.log(`\n${'='.repeat(56)}`)
console.log(`PASS ${pass}  FAIL ${failures.length}`)
if (failures.length) {
  console.log('失败项:')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log('全部通过')
