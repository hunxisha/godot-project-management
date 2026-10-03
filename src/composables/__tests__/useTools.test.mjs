// useTools 回归测试:扫描只发生一次、单工具抛错不拖垮全量、宿主能力缺失时降级。
//
// 为什么值得单测:「一个项目的 tree 只扫一次」是整套架构成立的前提(spec §5.1)。
// 一旦有人把 ctx 改成每工具自建,功能仍然全绿,但 10 万文件的项目会被扫 3~9 遍 ——
// 这种回归只有计数桩能抓住。
//
// 第 7~15 节是五条控制器裁定的补钉:
//   R-A(第 7 节)扫描必须**显式带 includeCache 且不得过滤** —— 只数调用次数抓不到
//     「漏传参数」和「顺手加了 skipDirs」,所以这里把原语实际收到的 opts 录下来逐条判。
//   R-B(第 8 节)ScanTreeResult 的 files/truncated 是可选字段,必须在边界上归零。
//   R-C(第 9 节)两个宿主对同一件事各说一句话,UI 只呈现一种口径。
//   R-D(第 12 节)P0a 不接全局任务条,进度只在 running/progress 上。
//   R-E(第 13 节)能力缺失是状态不是异常:既不抛,也不调用缺失的原语。
//   第 10/11/14/15 节把「切项目清 tree+results+LRU」「TEXT_LRU 上限」「单文件读炸
//   不拖垮整个检查器」这些架构不变量钉住。
//
// 用法:
//   node src/composables/__tests__/build-bundle.mjs && node src/composables/__tests__/useTools.test.mjs
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../../..')
const BUNDLE = path.resolve(ROOT, '.gpm-test/out/usetools.mjs')
if (!existsSync(BUNDLE)) {
  console.error(`找不到打包产物: ${BUNDLE}\n请先运行: node src/composables/__tests__/build-bundle.mjs`)
  process.exit(2)
}

const TREE = [
  { rel: 'project.godot', size: 100, mtimeMs: 1, ext: 'godot' },
  { rel: 'scene/main.tscn', size: 200, mtimeMs: 1, ext: 'tscn' },
  { rel: '.godot/imported/a.stex', size: 900, mtimeMs: 1, ext: 'stex' }
]

let scanCalls = 0
let readCalls = 0
// R-A:光数调用次数不够,必须把原语**真正收到**的参数录下来
const scanLog = []
const readLog = []
const TEXTS = { 'scene/main.tscn': '[ext_resource type="Script" path="res://gone.gd" id="1_a"]\n' }
const PROJECT = { _id: 'godot/project/p1', id: 'p1', path: 'E:/proj', name: 'Demo', favorite: false, openCount: 0, configVersion: 5 }

global.window = {
  services: {
    scanProjectTree: (pid, opts) => {
      scanCalls++
      scanLog.push({ pid, opts })
      if (pid !== 'godot/project/p1') return { ok: false, error: '项目不存在' }
      return { ok: true, files: TREE.map((t) => ({ ...t })), truncated: false }
    },
    readProjectText: (pid, rel) => {
      readCalls++
      readLog.push({ pid, rel })
      return { ok: true, text: TEXTS[rel] ?? '', bytes: 1, truncated: false }
    }
  },
  ztools: { db: { allDocs: async () => [{ ...PROJECT }] } }
}

// 第 8 节起的用例临时换桩,跑完必须还原,否则后面的计数断言会被前一节污染
const BASE_SCAN = global.window.services.scanProjectTree
const BASE_READ = global.window.services.readProjectText
const BASE_ALLDOCS = global.window.ztools.db.allDocs
function restore() {
  global.window.services.scanProjectTree = BASE_SCAN
  global.window.services.readProjectText = BASE_READ
  global.window.ztools.db.allDocs = BASE_ALLDOCS
}

let pass = 0
const failures = []
function ok(cond, label, extra) {
  if (cond) { pass++; console.log(`  PASS  ${label}`) }
  else { failures.push(label); console.log(`  FAIL  ${label}${extra !== undefined ? '  → ' + extra : ''}`) }
}
function section(t) { console.log(`\n=== ${t} ===`) }

const M = await import(pathToFileURL(BUNDLE).href)

async function main() {
  section('1. 注册表')
  ok(Array.isArray(M.TOOLS) && M.TOOLS.length === 3, 'P0a 注册 3 个工具', M.TOOLS.length)
  ok(new Set(M.TOOLS.map((t) => t.id)).size === M.TOOLS.length, '工具 id 不重复')
  ok(M.TOOLS.every((t) => t.name && t.summary && t.phase === 'P0' && Array.isArray(t.needs) && typeof t.run === 'function'),
    '每项都有 name/summary/phase/needs/run')
  ok(M.toolById('cache').id === 'cache' && M.toolById('nope') === undefined, 'toolById 命中与未命中都对')
  ok(M.isSupported(M.TOOLS[0], { tree: true, text: true, write: false, trash: false }) === true, 'isSupported 满足时需要项全 true')
  ok(M.isSupported(M.toolById('brokenRefs'), { tree: true, text: false, write: false, trash: false }) === false,
    'brokenRefs 需要 text,缺了就不支持')

  section('2. 扫描只发生一次')
  const t = M.useTools()
  await t.load()
  ok(t.projects.value.length === 1, 'load 拿到项目')
  ok(t.projectId.value === 'godot/project/p1', '默认选中完整文档 id', t.projectId.value)
  const r1 = await t.runTool('size')
  ok(scanCalls === 1, '首次跑扫一次', scanCalls)
  ok(r1.ok === true && r1.scannedFiles === 3, '结果带 ok 与文件数', JSON.stringify(r1))
  await t.runTool('cache')
  ok(scanCalls === 1, '第二个工具**复用同一棵树**(架构前提)', scanCalls)
  // 注:results 是 Record<toolId, ToolResult>(brief 第 3 节自己按 `t.results.value.brokenRefs`
  // 取结果),没有 Map 的 .size;这里按 Object.keys 计数,断的是同一件事。
  ok(Object.keys(t.results.value).length === 2 && !!t.results.value.cache, '两个工具的结果都在 results 里', JSON.stringify(Object.keys(t.results.value)))

  section('3. readText 走缓存')
  const before = readCalls
  await t.runTool('brokenRefs')
  ok(readCalls > before, 'brokenRefs 读了文本', readCalls)
  const mid = readCalls
  await t.runTool('brokenRefs')
  ok(readCalls === mid, '同一 rel 第二次不再读(LRU 生效)', readCalls)
  const br = t.results.value.brokenRefs
  ok(br.ok === true && br.findings.length === 1 && br.findings[0].severity === 'error',
    '断链结论贯通到 UI 层', JSON.stringify(br.findings))

  section('4. 单工具失败隔离')
  t.registerTool({ id: 'boom', name: 'x', summary: 'y', phase: 'P0', needs: [], run: async () => { throw new Error('炸了') } })
  const all = await t.runAll()
  const boom = all.find((x) => x.toolId === 'boom')
  ok(boom.ok === false && boom.error === '炸了', '炸掉的工具标 ok:false 并带原因', JSON.stringify(boom))
  ok(all.filter((x) => x.ok).length === 3, '其他 3 个工具不受影响', all.filter((x) => x.ok).length)
  ok(scanCalls === 2, 'runAll 强制重扫一次(之前是 1)', scanCalls)

  section('5. counts 汇总')
  ok(t.counts.value.error >= 1 && t.counts.value.info >= 1, 'counts 按严重度累计', JSON.stringify(t.counts.value))
  ok(typeof t.findingsOf('size') === 'object', 'findingsOf 可取')

  section('6. 宿主能力缺失时降级')
  delete global.window.services.scanProjectTree
  const t2 = M.useTools()
  await t2.load()
  const r2 = await t2.runTool('size')
  ok(r2.ok === false && r2.error === '当前宿主不支持', '缺原语时明确降级而不是抛异常', JSON.stringify(r2))

  // ---------- 以下是五条裁定的补钉 ----------
  restore()

  section('7. R-A 扫描必须显式带 includeCache,且不得过滤')
  ok(scanLog.length >= 2, `前面的断言确实扫过 ${scanLog.length} 次`)
  const noCache = scanLog.filter((c) => !c.opts || c.opts.includeCache !== true)
  ok(noCache.length === 0, '每次扫描都显式 includeCache: true(cache 检查器才有 .godot 可看)',
    JSON.stringify(scanLog.map((c) => c.opts)))
  const FILTER_KEYS = ['exts', 'skipDirs', 'maxEntries']
  const filtered = scanLog.filter((c) => c.opts && FILTER_KEYS.some((k) => k in c.opts))
  ok(filtered.length === 0, '扫描不传 exts/skipDirs/maxEntries(过滤后的清单同样不完整,却不再带 truncated 标记)',
    JSON.stringify(scanLog.map((c) => Object.keys(c.opts || {}))))
  ok(scanLog.every((c) => c.pid === 'godot/project/p1'), '扫描用的是完整文档 id 而不是短 id',
    JSON.stringify(scanLog.map((c) => c.pid)))

  section('8. R-B 宿主没给 files/truncated 时在边界归零')
  global.window.services.scanProjectTree = () => ({ ok: true })
  const t3 = M.useTools()
  await t3.load()
  const r3 = await t3.runTool('size')
  ok(Array.isArray(t3.tree.value) && t3.tree.value.length === 0, '缺 files → tree 归零而不是 undefined',
    JSON.stringify(t3.tree.value))
  ok(t3.truncated.value === false, '缺 truncated → false 而不是 undefined', String(t3.truncated.value))
  ok(r3.ok === true && r3.scannedFiles === 0, '空清单也算跑成功', JSON.stringify(r3))
  restore()

  section('9. R-C 两个宿主的扫描失败文案归一为一句')
  const seenErr = []
  for (const raw of ['项目目录已不存在', '项目目录不可读', '路径非法']) {
    global.window.services.scanProjectTree = () => ({ ok: false, error: raw })
    const inst = M.useTools()
    await inst.load()
    await inst.runTool('size')
    seenErr.push(inst.error.value)
  }
  ok(seenErr[0] === '项目目录无法读取', 'JS 宿主的「项目目录已不存在」归一', seenErr[0])
  ok(seenErr[1] === seenErr[0], 'Rust 宿主的「项目目录不可读」归一到同一句', seenErr[1])
  ok(seenErr[2] === '路径非法', '其它失败原因原样透传,不吞掉诊断', seenErr[2])
  restore()

  section('10. 切换项目清空 tree / results / 文本 LRU')
  const PROJECT2 = { _id: 'godot/project/p2', id: 'p2', path: 'E:/proj2', name: 'Demo2', favorite: false, openCount: 0, configVersion: 5, lastOpenedAt: 1000 }
  const swScan = { 'godot/project/p1': 0, 'godot/project/p2': 0 }
  const swRead = []
  global.window.services.scanProjectTree = (pid) => { swScan[pid] += 1; return { ok: true, files: TREE.map((x) => ({ ...x })), truncated: false } }
  global.window.services.readProjectText = (pid, rel) => { swRead.push(`${pid}|${rel}`); return { ok: true, text: TEXTS[rel] ?? '', bytes: 1, truncated: false } }
  global.window.ztools.db.allDocs = async () => [{ ...PROJECT }, { ...PROJECT2 }]
  const t7 = M.useTools()
  await t7.load()
  ok(t7.projectId.value === 'godot/project/p2', '默认选中最近打开的项目(spec §5.8)', t7.projectId.value)
  await t7.runTool('brokenRefs')
  ok(swScan['godot/project/p2'] === 1, 'p2 扫一次', swScan['godot/project/p2'])
  await t7.runTool('size')
  ok(swScan['godot/project/p2'] === 1, '同项目第二个工具仍共用这棵树', swScan['godot/project/p2'])
  ok(swRead.length === 1, 'p2 的文本只读过一次', swRead.length)
  t7.select('godot/project/p1')
  ok(t7.tree.value.length === 0, '切项目清空 tree', String(t7.tree.value.length))
  ok(Object.keys(t7.results.value).length === 0, '切项目清空 results', JSON.stringify(Object.keys(t7.results.value)))
  await t7.runTool('brokenRefs')
  ok(swScan['godot/project/p1'] === 1, '新项目自己扫一次', swScan['godot/project/p1'])
  ok(swRead.length === 2, 'p1 的文本读了一次', swRead.length)
  await t7.runTool('brokenRefs')
  ok(swRead.length === 2, '同项目同 rel 命中 LRU 不重读', swRead.length)
  t7.select('godot/project/p2')
  t7.select('godot/project/p1')
  await t7.runTool('brokenRefs')
  ok(swRead.length === 3, '切走再切回来必须清空 LRU(同一个 rel 要重读)', swRead.length)
  ok(swScan['godot/project/p1'] === 2, '切回来 tree 也重扫一次', swScan['godot/project/p1'])
  t7.select('godot/project/p1')
  await t7.runTool('brokenRefs')
  ok(swScan['godot/project/p1'] === 2 && swRead.length === 3, 'select 同项目是空操作,不清缓存', `${swScan['godot/project/p1']}/${swRead.length}`)
  restore()

  section('11. invalidateTree 与 runAll 的扫描计数')
  const t8 = M.useTools()
  await t8.load()
  const s0 = scanCalls
  await t8.runTool('size')
  await t8.runTool('cache')
  ok(scanCalls === s0 + 1, '两个工具共用一次扫描', scanCalls - s0)
  t8.invalidateTree()
  await t8.runTool('size')
  ok(scanCalls === s0 + 2, 'invalidateTree 后下一次强制重扫', scanCalls - s0)
  const all8 = await t8.runAll()
  ok(scanCalls === s0 + 3, 'runAll 只再强制重扫一次', scanCalls - s0)
  ok(all8.length === 3 && all8.every((x) => x.ok === true), '三个工具全绿', JSON.stringify(all8.map((x) => [x.toolId, x.ok])))
  ok(t8.running.value === '' && t8.allRunning.value === false && t8.progress.value === '', '跑完进度归位',
    `${t8.running.value}|${t8.allRunning.value}|${t8.progress.value}`)

  section('12. R-D 进度只在 running/progress 上(P0a 不接全局任务条)')
  const seen = []
  t8.registerTool({
    id: 'spy', name: '探针', summary: 's', phase: 'P0', needs: [],
    run: async () => { seen.push({ running: t8.running.value, progress: t8.progress.value, allRunning: t8.allRunning.value }); return [] }
  })
  await t8.runAll()
  ok(seen.length === 1 && seen[0].running === 'spy', '跑某个工具时 running 就是它的 id', JSON.stringify(seen[0]))
  ok(/探针/.test(seen[0].progress) && /\d+\s*\/\s*\d+/.test(seen[0].progress), 'progress 给出「第几个/共几个 + 工具名」', seen[0].progress)
  ok(seen[0].allRunning === true, 'runAll 期间 allRunning 为 true', String(seen[0].allRunning))
  ok(t8.allRunning.value === false && t8.progress.value === '', 'runAll 结束 allRunning/progress 归位')

  section('13. R-E 只缺 readProjectText 时的降级')
  delete global.window.services.readProjectText
  const capsProbe = M.useTools().caps
  ok(capsProbe.tree === true && capsProbe.text === false && capsProbe.write === false && capsProbe.trash === false,
    'caps 是按 typeof 探出来的', JSON.stringify(capsProbe))
  const t9 = M.useTools()
  await t9.load()
  const scanBeforeDeg = scanCalls
  const r9 = await t9.runTool('brokenRefs')
  ok(scanCalls === scanBeforeDeg, '能力缺失时在扫描前就短路,一个原语都不碰', scanCalls)
  ok(r9.ok === false && r9.error === '当前宿主不支持', '缺 text 时明确降级而不是抛异常', JSON.stringify(r9))
  const r9size = await t9.runTool('size')
  ok(r9size.ok === true, '只吃 tree 的工具不受 text 缺失影响', JSON.stringify(r9size))
  restore()

  section('14. TEXT_LRU 是有界缓存(上限 200 条)')
  const mkScenes = (n) => Array.from({ length: n }, (_, i) => ({ rel: `scene/s${i}.tscn`, size: 10, mtimeMs: 1, ext: 'tscn' }))
  let curTree = mkScenes(120)
  let lruReads = 0
  global.window.services.scanProjectTree = () => ({ ok: true, files: curTree.map((x) => ({ ...x })), truncated: false })
  global.window.services.readProjectText = () => { lruReads++; return { ok: true, text: '无引用\n', bytes: 4, truncated: false } }
  const t10 = M.useTools()
  await t10.load()
  const rA = await t10.runTool('brokenRefs')
  ok(lruReads === 120, '首轮把 120 个场景各读一次', lruReads)
  ok(rA.ok === true && rA.findings.length === 0, '无引用的场景不产生结论', JSON.stringify(rA.findings))
  await t10.runTool('brokenRefs')
  ok(lruReads === 120, '工作集没超上限:次轮全部命中,一次都不重读', lruReads)
  // 工作集超出上限(250 > 200):缓存**不扩容**,只把最早的挤出去。
  // 实测行为(不是笔误):次轮重读的是整整 250 次,而不是「被淘汰的 50 次」—— 反复按
  // 同一顺序访问 250 个 key 的循环序列会让任何有界缓存整体抖动(thrash),一条都命不中。
  // 这里断的是「有界」本身:把淘汰那行删掉,次轮就变成 0 次重读(缓存无限增长)→ 本条转红。
  // 命中率换内存是有意的取舍(P0a 取有界),不是缺陷。
  curTree = mkScenes(250)
  t10.invalidateTree()
  await t10.runTool('brokenRefs')
  ok(lruReads === 120 + 250, '清单换成 250 个场景后重扫并重读', lruReads)
  await t10.runTool('brokenRefs')
  ok(lruReads === 120 + 250 + 250, '工作集超出 TEXT_LRU 时缓存保持有界(次轮重读 250 条而不是命中)', lruReads)
  restore()

  section('15. 单个文件读炸不拖垮整个检查器')
  const twoScenes = [
    { rel: 'scene/boom.tscn', size: 10, mtimeMs: 1, ext: 'tscn' },
    { rel: 'scene/main.tscn', size: 10, mtimeMs: 1, ext: 'tscn' }
  ]
  global.window.services.scanProjectTree = () => ({ ok: true, files: twoScenes.map((x) => ({ ...x })), truncated: false })
  global.window.services.readProjectText = (pid, rel) => {
    if (rel === 'scene/boom.tscn') throw new Error('磁盘读炸')
    return { ok: true, text: TEXTS[rel] ?? '', bytes: 1, truncated: false }
  }
  const t11 = M.useTools()
  await t11.load()
  const r11 = await t11.runTool('brokenRefs')
  ok(r11.ok === true, '读炸的文件按「读不到」跳过,检查器整体仍成功', JSON.stringify(r11))
  ok(r11.findings.length === 1 && r11.findings[0].rel === 'scene/main.tscn', '另一个场景的断链结论照常报出', JSON.stringify(r11.findings))
  restore()
}
main().then(() => {
  console.log(`\n${'='.repeat(56)}\nPASS ${pass}  FAIL ${failures.length}`)
  if (failures.length) { console.log('失败项:'); for (const f of failures) console.log('  - ' + f); process.exit(1) }
  console.log('全部通过')
}).catch((e) => {
  console.log(`\n${'='.repeat(56)}\nPASS ${pass}  FAIL ${failures.length}`)
  console.log('用例执行中抛出未捕获异常:')
  console.log(e && e.stack ? e.stack : e)
  process.exit(1)
})
