// useUpdateScan 回归测试:跨项目巡检的「没查成」与「查了都是最新」必须是两回事。
//
// 起因(2026-10-09):桌面版垫片的 checkAddonUpdate 是 `() => Promise.resolve({ hasUpdate: false })`
// —— 一条都没查,却回了「没更新」的形状。巡检面板于是显示「所有项目的已装内容都是最新版本」,
// 把「没查」报成了一条结论。修法是把原因收进 blocked,视图只在没有 blocked 时才敢说「都是最新」。
// 注意 blocked 这个字段修复前根本不存在,所以本节对着旧代码必然红 —— 不是靠猜形状写的断言。
//
// 用法(npm script 会先跑打包步骤):
//   npm run test:renderer
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.resolve(__dirname, '../../../.gpm-test/out')

for (const name of ['useupdatescan', 'vueshim']) {
  if (!existsSync(path.join(OUT, `${name}.mjs`))) {
    console.error(`找不到打包产物: ${path.join(OUT, `${name}.mjs`)}`)
    console.error('请先运行: node src/composables/__tests__/build-bundle.mjs')
    process.exit(2)
  }
}

await import(pathToFileURL(path.join(OUT, 'vueshim.mjs')).href)
const { useUpdateScan } = await import(pathToFileURL(path.join(OUT, 'useupdatescan.mjs')).href)

let pass = 0
const failures = []
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log(`  PASS  ${label}`) }
  else { failures.push(label); console.log(`  FAIL  ${label}  → ${extra}`) }
}
const section = (t) => console.log(`\n=== ${t} ===`)

const ERR = '桌面版暂不支持检查插件更新,请使用 ZTools 插件版。'
const P1 = { id: 'godot/project/p1', name: '甲项目' }
const P2 = { id: 'godot/project/p2', name: '乙项目' }
const AD = (dir, over = {}) => ({ dirName: dir, name: dir, fromMarket: true, assetId: `a/${dir}`, versionString: '1.0.0', ...over })

/** 装好假宿主:addons 按项目给,check 结果按调用顺序排队(队列空了回「没更新」) */
function host({ addonsByProject, results, throwAt = -1 }) {
  let n = 0
  const seen = []
  global.window = {
    services: {
      listAddons: (pid) => Promise.resolve((addonsByProject && addonsByProject[pid]) || []),
      checkAddonUpdate: (o) => {
        const i = n++
        seen.push(o)
        if (i === throwAt) return Promise.reject(new Error('网络断了'))
        return Promise.resolve((results && results[i]) || { hasUpdate: false })
      }
    }
  }
  return seen
}

async function main() {
  // ---------- 1. 宿主回 error:不许留成「都是最新」 =====
  section('1. 一条都没查成时要把原因立起来')
  {
    host({ addonsByProject: { [P1.id]: [AD('d1'), AD('d2')] }, results: [{ hasUpdate: false, error: ERR }, { hasUpdate: false, error: ERR }] })
    const s = useUpdateScan()
    await s.scanAll([P1])
    ok(s.rows.value.length === 0, 'error 不进结果表(否则会被当成「有新版本」或「已确认最新」)', String(s.rows.value.length))
    ok(s.scanned.value === true, 'scanned 仍要置起来(区分「还没扫」与「扫了但没查成」)')
    ok(s.blocked.value === ERR, 'blocked 收下定性原因', String(s.blocked.value))
  }

  // ---------- 2. 真的查过、确实都最新 ----------
  section('2. 查过且都是最新:blocked 必须为空')
  {
    host({ addonsByProject: { [P1.id]: [AD('d1')] }, results: [{ hasUpdate: false }] })
    const s = useUpdateScan()
    await s.scanAll([P1])
    ok(s.blocked.value === '', '没原因就不许凭空立一个', String(s.blocked.value))
    ok(s.scanned.value === true && s.rows.value.length === 0, '空结果 + 无原因 = 视图那句「都是最新」的唯一合法前提')
  }

  // ---------- 3. 有真结果时仍要留下没查成的那半边 ----------
  section('3. 部分查成')
  {
    const seen = host({
      addonsByProject: { [P1.id]: [AD('d1'), AD('d2')], [P2.id]: [AD('d3')] },
      results: [{ hasUpdate: true, latest: '2.1.0' }, { hasUpdate: false, error: ERR }, { hasUpdate: false }]
    })
    const s = useUpdateScan()
    await s.scanAll([P1, P2])
    ok(s.rows.value.length === 1 && s.rows.value[0].latest === '2.1.0', '真结果照常入表', JSON.stringify(s.rows.value))
    ok(s.blocked.value === ERR, '有结果也要留着原因:表里没列出的那些不等于「已确认最新」', String(s.blocked.value))
    ok(seen.length === 3 && seen[2].projectId === P2.id, '跨项目逐个检查(第二个项目的 assetId 也查了)', JSON.stringify(seen))
    ok(s.rows.value[0].projectId === P1.id && s.rows.value[0].dirName === 'd1', '行上带得回是哪个项目哪个目录')
  }

  // ---------- 4. 抛错同样要留原因(原来那个 catch 是空的) ----------
  section('4. 宿主直接 reject')
  {
    host({ addonsByProject: { [P1.id]: [AD('d1')] }, results: [], throwAt: 0 })
    const s = useUpdateScan()
    await s.scanAll([P1])
    ok(/网络断了/.test(s.blocked.value), '抛错的原因不能被吞进 catch 的黑洞', String(s.blocked.value))
    ok(s.scanning.value === false, '失败后 scanning 复位(否则「全库巡检」按钮永久卡住)')
  }

  // ---------- 5. 重扫要清掉上一轮的原因 ----------
  section('5. 重新扫描')
  {
    host({ addonsByProject: { [P1.id]: [AD('d1')] }, results: [{ hasUpdate: false, error: ERR }, { hasUpdate: false }] })
    const s = useUpdateScan()
    await s.scanAll([P1])
    ok(s.blocked.value === ERR, '第一轮立了原因')
    await s.scanAll([P1])
    ok(s.blocked.value === '', '第二轮查成了,旧原因要作废:换宿主/修好后还挂着上轮的说法就是假故障')
    ok(s.rows.value.length === 0, '结果表同样每轮重置')
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
}

main().then(() => {}, (e) => { console.error(e); process.exit(1) })
