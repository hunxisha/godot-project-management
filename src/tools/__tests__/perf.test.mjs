// 工具页性能基准(opt-in,不入任何 npm 脚本):spec §7 第 3 条「1 万文件全量体检 < 10s」的可复测口径。
//
// 为什么要把脚本入库:上一轮验收的夹具与驱动脚本全放在 %TEMP%,跑完即删,报告里的
// 「runAllMs=295.0」无法复测(评审 Fix round 1 F-4.2)。这份 harness 自带夹具生成、
// 计时与清理,数字随仓库走,谁都能重跑对质。
//
// 运行(必须先产 bundle;刻意**不挂** npm test / test:renderer —— 它会写盘上万文件):
//   node src/composables/__tests__/build-bundle.mjs
//   GPM_PERF_FILES=10000 node src/tools/__tests__/perf.test.mjs
//   (Windows PowerShell: $env:GPM_PERF_FILES=10000; node src/tools/__tests__/perf.test.mjs)
//   不设 GPM_PERF_FILES(或 < 100)时只打印 SKIP 并退 0 —— 约定仿 GPM_TEST_TRASH=1
//   (见 src-ztools/preload/lib/__tests__/README.md「已知副作用」)。
//
// 测什么:
//   1. os.tmpdir()/gpm-perf-* 下造 GPM_PERF_FILES 个真实文件的 Godot 项目树
//      (与 Task 16 报告同配比:png 60% / gd 20% / tscn 10% / .godot stex 补余 / project.godot ×1);
//   2. window.services 的两个方法直接接**真实 JS 宿主原语** src-ztools/preload/lib/inspectfs.js
//      (真遍历磁盘、真读文本;项目文档走 window.ztools.db.get 桩);
//   3. 上层用 CI 同一份打包产物 .gpm-test/out/usetools.mjs:useTools() → load() → runAll();
//   4. performance.now() 计 scanAloneMs 与 runAllMs,判 ≤10000ms;
//   5. (B5) 在同一份真夹具上补 .png.import 边让 png 进候选,再用真实原语**直接**调
//      .gpm-test/out/tools.mjs 的 buildRefIndex + runOrphans(不走 registry)并计时 —— orphans 是第一个
//      把 readText 吃满的工具,registry 里没有它(B5 不接线),runAll 量不到,这一段就是补上这块成本;
//   无论成败最后删除整个临时目录并**核实它没了**(残留 = harness 自己 FAIL)。
//
// 诚实边界(不冒充):测的是 Node 侧调度器 + JS 宿主原语的耗时,不是浏览器绘制耗时,
// 也没走 Tauri 的 IPC / JSON 跨桥序列化;两端扫描都是同步整树遍历,无中途让出(P0b 议题)。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../../..')

const N = Math.trunc(Number(process.env.GPM_PERF_FILES || 0))
if (!Number.isFinite(N) || N < 100) {
  console.log('SKIP  未显式开启性能基准。用法:GPM_PERF_FILES=10000 node src/tools/__tests__/perf.test.mjs')
  console.log('      (不挂 npm test / test:renderer;夹具建在 os.tmpdir() 下,跑完自删)')
  process.exit(0)
}

const BUNDLE = path.resolve(ROOT, '.gpm-test/out/usetools.mjs')
if (!fs.existsSync(BUNDLE)) {
  console.error(`找不到打包产物: ${BUNDLE}`)
  console.error('请先运行: node src/composables/__tests__/build-bundle.mjs')
  process.exit(2)
}

/** 夹具根(mkdtempSync 保证并发/重跑不互踩) */
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'gpm-perf-'))
const DOC = { _id: 'godot/project/perf', id: 'perf', path: WORK, name: 'Perf', favorite: false, openCount: 0, configVersion: 5, lastOpenedAt: 1 }

// window 桩先建、再 require inspectfs:store.js 的 getDoc 在**调用时**才摸 window.ztools.db,
// 但把顺序摆正是 inspectfs.test.js 立下的规矩(也是宿主里的真实顺序)。
global.window = {
  services: {},
  ztools: { db: { get: (id) => (id === DOC._id ? { ...DOC } : null), allDocs: () => [{ ...DOC }] } }
}
const F = require(path.join(ROOT, 'src-ztools', 'preload', 'lib', 'inspectfs.js'))
global.window.services.scanProjectTree = (pid, opts) => F.scanProjectTree(pid, opts)
global.window.services.readProjectText = (pid, rel) => F.readProjectText(pid, rel)

/** 按 Task 16 报告的配比切段;补余给 .godot,总数恒等于 N */
function counts(n) {
  const png = Math.round(n * 0.6)
  const gd = Math.round(n * 0.2)
  const tscn = Math.round(n * 0.1)
  const stex = Math.max(0, n - 1 - png - gd - tscn)
  return { png, gd, tscn, stex }
}

function buildFixture() {
  const c = counts(N)
  const PNG_BUF = Buffer.from('89504e470d0a1a0a-stub'.repeat(24), 'hex')
  let written = 0
  const touch = (rel, buf) => {
    const abs = path.join(WORK, ...rel.split('/'))
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, buf)
    written++
  }
  touch('project.godot', '[application]\nconfig/name="Perf"\n')
  // 与报告夹具同形态:assets/tex*/img*.png(100 张一组)
  for (let i = 0; i < c.png; i++) touch(`assets/tex${Math.floor(i / 100)}/img${i % 100}.png`, PNG_BUF)
  for (let i = 0; i < c.gd; i++) touch(`scripts/mod${Math.floor(i / 100)}/s${i % 100}.gd`, 'extends Node\n')
  // 每个场景引用一个**确实存在**的 png:全绿结论才是「体检跑完且没问题」的形态
  for (let i = 0; i < c.tscn; i++) {
    const ref = `assets/tex${Math.floor(i % c.png / 100)}/img${i % c.png % 100}.png`
    touch(`scene/main_${i}.tscn`, `[ext_resource type="Texture2D" path="res://${ref}" id="1_a"]\n[node name="R" type="Node2D"]\n`)
  }
  for (let i = 0; i < c.stex; i++) touch(`.godot/imported/i${i}.stex`, PNG_BUF)
  return { total: written, c }
}

/** 数一遍盘上条目(含 .godot),钉住「N 个真实文件」不是嘴说的 */
function countOnDisk(dir) {
  let n = 0
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += countOnDisk(path.join(dir, e.name))
    else n++
  }
  return n
}

function cleanup() {
  try { fs.rmSync(WORK, { recursive: true, force: true }) } catch { /* 下面用 existsSync 定成败 */ }
  const gone = !fs.existsSync(WORK)
  console.log(gone ? `fixture cleaned: ${WORK} 已删除并核实不存在` : `FIXTURE LEAK: ${WORK} 仍在盘上`)
  return gone
}

let exitCode = 0
try {
  console.log(`building fixture: ${N} files under ${WORK}`)
  const tBuild = performance.now()
  const { total, c: fc } = buildFixture()
  const onDisk = countOnDisk(WORK)
  console.log(`fixture built in ${(performance.now() - tBuild).toFixed(0)} ms: written=${total} onDisk=${onDisk} (want ${N})`)
  if (total !== N || onDisk !== N) throw new Error(`夹具数目不符:written=${total}, onDisk=${onDisk}, want=${N}`)

  const M = await import(pathToFileURL(BUNDLE).href)
  const t = M.useTools()
  await t.load()
  if (t.projectId.value !== DOC._id) throw new Error(`load 没选中夹具项目: ${t.projectId.value}`)

  // 单扫一次(与原语直连,不经 useTools 的 TTL):10000 条遍历 + stat 的成本
  const s0 = performance.now()
  const scan = F.scanProjectTree(DOC._id, { includeCache: true })
  const scanAloneMs = performance.now() - s0
  if (!scan.ok) throw new Error(`夹具扫描失败: ${scan.error}`)

  // 计时对象:CI 同一份 bundle 的 useTools().runAll()(内部会再强制重扫一次)
  const r0 = performance.now()
  const rows = await t.runAll()
  const runAllMs = performance.now() - r0

  console.log(`entries=${scan.files.length} truncated=${scan.truncated} scanAloneMs=${scanAloneMs.toFixed(1)}`)
  console.log(`runAllMs=${runAllMs.toFixed(1)} tools=${rows.length} ok=${rows.filter((x) => x.ok).length}`)
  for (const r of rows) console.log(`  ${r.toolId}: ok=${r.ok} findings=${r.findings.length} scannedFiles=${r.scannedFiles} ms=${r.ms}`)
  const c = t.counts.value
  console.log(`uiCounts=${JSON.stringify(c)} error=${JSON.stringify(t.error.value)}`)
  const pass = runAllMs <= 10000
  console.log(`limit=10000ms verdict=${pass ? 'PASS' : 'FAIL'}`)
  if (!pass) exitCode = 1

  // ---------- B5:buildRefIndex + runOrphans 直测(不走 registry) ----------
  // orphans 是 P0b 第一个把 readText 吃满的工具:引用来源(buildRefIndex 要读**全部**白名单文本文件,
  // 不只是 brokenRefs 读的 .tscn)才是成本大头。而 registry 里没接线 orphans(B5 交付不接线),
  // 上面的 runAll 压根没跑它。于是在同一份真夹具上补 .png.import 边让 png 进候选集,
  // 用真实宿主原语**直接**调 buildRefIndex 与 runOrphans,分别计时。
  const TOOLS_BUNDLE = path.resolve(ROOT, '.gpm-test/out/tools.mjs')
  if (!fs.existsSync(TOOLS_BUNDLE)) throw new Error(`找不到打包产物: ${TOOLS_BUNDLE}(build-bundle.mjs 应产出 tools.mjs)`)
  const SIDE_BUF = Buffer.from('[remap]\nimporter="texture"\n')
  for (let i = 0; i < fc.png; i++) {
    const rel = `assets/tex${Math.floor(i / 100)}/img${i % 100}.png.import`
    const abs = path.join(WORK, ...rel.split('/'))
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, SIDE_BUF)
  }
  const TB = await import(pathToFileURL(TOOLS_BUNDLE).href)
  const scan2 = F.scanProjectTree(DOC._id, { includeCache: true })
  if (!scan2.ok) throw new Error(`孤儿夹具重扫失败: ${scan2.error}`)
  // 合成 ctx 直接接真原语(与 useTools.ctx 同一 readText 三态收口:给不出字符串就是读不到)。
  // 刻意**不接 LRU**:runOrphans 内部会再 buildRefIndex 一次,第二趟是真读,所以 runOrphansMs
  // 是「孤儿工具单独跑一遍」的成本上界 —— 恰好是要防退化的那个数。
  const orphanCtx = {
    projectId: DOC._id, root: WORK, tree: scan2.files, truncated: scan2.truncated === true,
    readText: async (rel) => {
      const rr = F.readProjectText(DOC._id, rel)
      return rr.ok && typeof rr.text === 'string' ? { text: rr.text } : { skipped: true }
    }
  }
  const bi0 = performance.now()
  const idx = await TB.buildRefIndex(orphanCtx)
  const buildRefMs = performance.now() - bi0
  const or0 = performance.now()
  const orphanFindings = await TB.runOrphans(orphanCtx)
  const orphanMs = performance.now() - or0
  const combinedMs = buildRefMs + orphanMs
  const agg = orphanFindings.find((f) => f.id === 'orphans:all')
  const orphanRels = agg && agg.fix && agg.fix.payload ? agg.fix.payload.rels.length : 0
  console.log(`[orphans 直测] entries=${scan2.files.length} truncated=${orphanCtx.truncated} ` +
    `sourcesScanned=${idx.sourcesScanned} indexPartial=${idx.partial} findings=${orphanFindings.length} orphanRels=${orphanRels}`)
  console.log(`[orphans 直测] buildRefIndexMs=${buildRefMs.toFixed(1)} runOrphansMs=${orphanMs.toFixed(1)} combinedMs=${combinedMs.toFixed(1)}`)
  // 护栏,不是 §7 的 <10s 验收:真验收(B10 接线后在真宿主、含 LRU 与全局调度)另行取证。
  // 30s 对 1 万级两次真读 + 两趟线性扫描留足机器抖动余量;若哪天退化成二次全树扫 / 平方级引用查找,
  // 这个数会飙到几十分钟必然红 —— 这就是它存在的意义(宁可宽松也不制造不稳定红)。
  const GUARD_MS = 30000
  const guard = combinedMs <= GUARD_MS
  console.log(`[orphans 直测] guard=${GUARD_MS}ms(护栏) verdict=${guard ? 'PASS' : 'FAIL'}`)
  if (!guard) exitCode = 1
} catch (e) {
  console.error(`perf harness 抛错: ${e && e.stack ? e.stack : e}`)
  exitCode = 1
} finally {
  if (!cleanup() && exitCode === 0) exitCode = 1
  process.exit(exitCode)
}
