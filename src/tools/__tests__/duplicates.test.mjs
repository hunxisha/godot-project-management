// 工具页 P2 #17 重复文件检测(src/tools/inspectors/duplicates.ts)的断言。
//
// 钉的是**检查器决定**:三步判定链(同体积分组 → 组内 >1 才哈希 → 同 SHA-256 成组)里
// 每一步的进出场、三个少报口径(addons/.gdignore/大小写异体)、哈希预算闸的记账、
// 失败与截断怎么说人话、结论为什么没有修复动作。
// 哈希算法本身归原语层(inspectfs.test.js 第 7 节 / inspectfs.rs 内嵌测试 / parity),这里只给桩。
//
// 用法(npm script 会先跑打包步骤):
//   node src/composables/__tests__/build-bundle.mjs && node src/tools/__tests__/duplicates.test.mjs
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

const HAS = typeof T.runDuplicates === 'function' && T.MIN_DUP_BYTES === 1024 && T.HASH_BUDGET === 256 * 1024 * 1024
ok(HAS, 'runDuplicates 与两个闸常量已在打包产物里导出')
if (!HAS) {
  console.log('\n实现尚未落地,后续断言无法执行(这就是 RED 那一步)。')
  console.log(`\n${'='.repeat(56)}\nPASS ${pass}  FAIL ${failures.length}`)
  process.exit(1)
}

const MB = 1024 * 1024
function extOf(rel) {
  const base = rel.slice(rel.lastIndexOf('/') + 1)
  const i = base.lastIndexOf('.')
  return i > 0 ? base.slice(i + 1).toLowerCase() : ''
}
function tree(specs) {
  const base = Date.UTC(2026, 0, 1)
  return specs.map(([rel, size]) => ({ rel, size, mtimeMs: base, ext: extOf(rel) }))
}
/**
 * 哈希桩:同一「内容键」的 rel 返回同一摘要。可选注入失败清单与抛错行为。
 * 记下每次收到的 rels ——「只哈希同体积组」这类闸就是靠这份账钉住的。
 */
function hashStub(spec = {}) {
  const calls = []
  const stub = async (rels) => {
    calls.push([...rels])
    if (spec.throw) throw new Error(spec.throw)
    const hashes = []
    const failed = []
    for (const rel of rels) {
      if (spec.fail && spec.fail.includes(rel)) { failed.push({ rel, error: '读取失败' }); continue }
      hashes.push({ rel, sha256: 'sha-' + (spec.contentOf ? spec.contentOf(rel) : rel) })
    }
    return { hashes, failed }
  }
  stub.calls = calls
  return stub
}
function makeCtx(specs, { trunc = false, hash } = {}) {
  const ctx = {
    projectId: 'godot/project/p', root: 'E:/proj', truncated: trunc, tree: tree(specs),
    readText: async () => ({ skipped: true }),
    hash: hash || hashStub()
  }
  return { ctx }
}
const find = (fs, pred) => fs.filter(pred)

async function main() {
  // ---------- 1. 判定链 ----------
  section('1. 判定链:同体积 → 哈希 → 同摘要成组')
  {
    const specs = [
      ['a.bin', 5 * MB], ['b.bin', 5 * MB],           // 同体积同内容 → 一组
      ['c.bin', 5 * MB], ['d.bin', 5 * MB],           // 同体积不同内容 → 不报
      ['e.bin', 6 * MB], ['f.bin', 7 * MB],           // 体积不同 → 连哈希都不进
      ['small.bin', 999], ['small2.bin', 999]         // <1KiB → 不进候选
    ]
    // 内容键:a/b 同一份,c/d 各自不同,e/f 体积不同根本进不了哈希
    const h = hashStub({
      contentOf: (rel) => (rel === 'a.bin' || rel === 'b.bin' ? 'same-1' : rel === 'c.bin' ? 'c-x' : 'd-y')
    })
    const { ctx } = makeCtx(specs, { hash: h })
    const fs = await T.runDuplicates(ctx)
    const groups = find(fs, (f) => f.id.startsWith('duplicates:group:'))
    ok(groups.length === 1, '★四个同体积文件里只有真同内容的子对成组(同体积只是前置闸,不是同内容)', JSON.stringify(fs.map((f) => f.title)))
    ok(groups[0].severity === 'info' && groups[0].related.join('|') === 'a.bin|b.bin',
      'info 级、related 列出全组路径', groups[0] && `${groups[0].severity}/${groups[0].related && groups[0].related.join('|')}`)
    ok(/2 处相同的 5.0 MB/.test(groups[0].title) && /可省 5.0 MB/.test(groups[0].title),
      '标题说清份数、单份体积与可省体积', groups[0] && groups[0].title)
    ok(/引用的是哪一份/.test(groups[0].detail) && !groups[0].fix,
      '★detail 点明「留哪份由用户决定」且没有 fix 字段(合并引用超出低风险修复边界)',
      groups[0] && groups[0].detail)
    const hashed = h.calls[0]
    ok(hashed.includes('c.bin') && hashed.includes('d.bin') && !hashed.includes('e.bin') && !hashed.includes('small.bin'),
      '★哈希只收同体积组的成员:体积不同的与 <1KiB 的都没进哈希通道', JSON.stringify(hashed))
  }

  // ---------- 2. 三个少报口径 ----------
  section('2. 口径:addons / .gdignore / 大小写异体都朝少报偏')
  {
    const specs = [
      ['addons/x/addon.gd', 2 * MB], ['addons/y/addon.gd', 2 * MB],   // addons 整体跳过
      ['art/a.png', 2 * MB], ['bloc/a.png', 2 * MB],                   // 被 .gdignore 屏蔽
      ['art/.gdignore', 0],
      ['data/A.dat', 2 * MB], ['data2/a.dat', 2 * MB],                 // 大小写异体:只留代表
      ['godot/A.gd', 2 * MB], ['godot2/A.gd', 2 * MB],                 // 正常组照报
      ['.git/objects/aa', 2 * MB], ['.git/objects/bb', 2 * MB]         // VCS 元数据跳过
    ]
    const { ctx } = makeCtx(specs, { hash: hashStub({ contentOf: (rel) => (rel.startsWith('godot') ? 'gd' : rel) }) })
    const fs = await T.runDuplicates(ctx)
    const groups = find(fs, (f) => f.id.startsWith('duplicates:group:'))
    ok(groups.length === 1 && groups[0].related.join('|') === 'godot/A.gd|godot2/A.gd',
      '★addons/.gdignore/.git 全部不进候选;大小写异体只算一处;真重复的那组照报',
      JSON.stringify(fs.map((f) => f.title)))
  }

  // ---------- 3. 预算闸 ----------
  section('3. 哈希预算:最值得报的先吃,超出的如实记账')
  {
    const g = (p, s) => [[`${p}1.bin`, s], [`${p}2.bin`, s]]
    // 三组体积各不相同(同体积分组会把同体积的并进一组,这正是判据该做的):
    // a 组可省 100MiB 先吃 200MiB,b/c 组(180/160MiB 成本)在剩余 56MiB 预算外被闸
    const specs = [...g('a', 100 * MB), ...g('b', 90 * MB), ...g('c', 80 * MB)]
    const { ctx } = makeCtx(specs, { hash: hashStub({ contentOf: (rel) => rel.replace(/\d\.bin$/, '') }) })
    const fs = await T.runDuplicates(ctx)
    const groups = find(fs, (f) => f.id.startsWith('duplicates:group:'))
    ok(groups.length === 1, '预算内只跑得动一组(可省体积最大的那组)', JSON.stringify(fs.map((f) => f.title)))
    const budget = find(fs, (f) => f.id === 'duplicates:budget')
    ok(budget.length === 1 && /还有 2 组同体积候选未检测/.test(budget[0].title) && /4 个同体积文件/.test(budget[0].detail),
      '★预算外组数与文件数都记账,且明说「不算干净也不算重复」', budget[0] && `${budget[0].title} / ${budget[0].detail}`)
  }

  // ---------- 4. 失败与通道异常 ----------
  section('4. 哈希失败:整组不判 + 计数条,不谎称完整')
  {
    const specs = [['a.bin', 2 * MB], ['b.bin', 2 * MB], ['c.bin', 2 * MB], ['d.bin', 2 * MB]]
    const { ctx } = makeCtx(specs, { hash: hashStub({ contentOf: () => 'same', fail: ['b.bin'] }) })
    const fs = await T.runDuplicates(ctx)
    ok(find(fs, (f) => f.id.startsWith('duplicates:group:')).length === 0,
      '★组内任一成员读不到 → 整组不判(少报,不猜其余是否相同)', JSON.stringify(fs.map((f) => f.title)))
    const skip = find(fs, (f) => f.id === 'duplicates:skip-count')
    ok(skip.length === 1 && /2 项读不到/.test(skip[0].title), '失败计数成一条(原语失败 1 项 + 含它的组 1 个)', skip[0] && skip[0].title)
  }
  {
    const specs = [['a.bin', 2 * MB], ['b.bin', 2 * MB]]
    const { ctx } = makeCtx(specs, { hash: hashStub({ contentOf: () => 'same', throw: 'IPC 断了' }) })
    const fs = await T.runDuplicates(ctx)
    ok(find(fs, (f) => f.id.startsWith('duplicates:group:')).length === 0 &&
      find(fs, (f) => f.id === 'duplicates:skip-count').length === 1,
      '★通道层抛异常也被收进失败计数,检查器不炸', JSON.stringify(fs.map((f) => f.title)))
  }

  // ---------- 5. 截断与 LIST_CAP ----------
  section('5. 截断照常报 + 覆盖面警示;超 20 组出尾条')
  {
    const specs = [['a.bin', 2 * MB], ['b.bin', 2 * MB]]
    const { ctx } = makeCtx(specs, { trunc: true, hash: hashStub({ contentOf: () => 'same' }) })
    const fs = await T.runDuplicates(ctx)
    ok(fs.some((f) => f.id === 'duplicates:truncated' && f.severity === 'warn') &&
      find(fs, (f) => f.id.startsWith('duplicates:group:')).length === 1,
      '★截断时照常报 + 警示(另一份可能落在没扫到的部分)', JSON.stringify(fs.map((f) => f.id)))
  }
  {
    const specs = []
    for (let i = 0; i < 23; i++) {
      const n = String(i).padStart(2, '0')
      specs.push([`g${n}/x.bin`, 2 * MB + i], [`g${n}/y.bin`, 2 * MB + i])
    }
    const { ctx } = makeCtx(specs, { hash: hashStub({ contentOf: (rel) => rel.replace(/[xy]\.bin$/, '') }) })
    const fs = await T.runDuplicates(ctx)
    const groups = find(fs, (f) => f.id.startsWith('duplicates:group:'))
    ok(groups.length === 20, '23 组只列前 20(LIST_CAP)', String(groups.length))
    ok(groups[0].related.join('|') === 'g22/x.bin|g22/y.bin', '按可省体积降序(体积大者在前)', groups[0].related.join('|'))
    ok(find(fs, (f) => f.id === 'duplicates:tail').length === 1 && /另有 3 组/.test(find(fs, (f) => f.id === 'duplicates:tail')[0].title),
      '尾条说清差额')
  }

  // ---------- 6. 干净项目 ----------
  section('6. 零重复:一组都不出,不留噪声')
  {
    const specs = [['a.txt', 2 * MB], ['b.txt', 3 * MB], ['c.txt', 999]]
    const { ctx } = makeCtx(specs, { hash: hashStub() })
    const fs = await T.runDuplicates(ctx)
    ok(fs.length === 0, '★没有同体积组、没有截断 → 零结论(「没有重复」由汇总条说)', JSON.stringify(fs.map((f) => f.id)))
  }

  console.log(`\n${'='.repeat(56)}\nPASS ${pass}  FAIL ${failures.length}`)
  if (failures.length) {
    console.log('失败项:\n - ' + failures.join('\n - '))
    process.exit(1)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
