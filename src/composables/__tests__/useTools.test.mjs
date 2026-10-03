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
// 第 16~23 节是修复轮 1 的三条 Important 与四条 Minor:
//   F-1(第 16/17 节)扫描是真异步 IPC,在途时切项目 → 上一份清单必须**整份丢弃**。
//     这两节用手动 resolve 的 deferred 桩,同步桩复现不出竞态(未修复也照样绿)。
//   F-2(第 18/19 节)空项目要命中 TTL(新鲜度看 treeAt 而不是 tree.length);
//     扫描失败时 runAll 停下并上浮单条失败,而不是产出 N 行「未运行」。
//   F-3(第 20 节)读失败不进缓存,下一轮会真的重试。
//   M-5(第 21 节)工具返回值在边界归一成数组;M-8(第 22 节)runAll 的进度行不被
//   扫描收尾擦掉;M-9(第 23 节)扫描失败路径复位 truncated。
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

/** 让出事件循环,确保 runTool 里的 await 真的挂起了 */
const tick = () => new Promise((r) => setTimeout(r, 0))

/**
 * F-1 专用:把 scanProjectTree 换成**手动 resolve 的 deferred 桩**。
 * 桌面宿主里它是真的异步 IPC(几百毫秒到几秒);「扫描在途时用户点了项目选择器」这个竞态
 * 在同步桩下**根本复现不出来** —— 未修复的代码在同步桩上照样全绿。
 * 第 16/17 两条用例必须先靠这个桩转红,才有资格谈修复。
 */
function deferredScanner(treesByPid, counters) {
  const pending = []
  global.window.services.scanProjectTree = (pid) => {
    counters[pid] = (counters[pid] || 0) + 1
    return new Promise((resolve) => { pending.push({ pid, resolve }) })
  }
  const take = (pid) => {
    const i = pending.findIndex((p) => p.pid === pid)
    if (i < 0) throw new Error(`测试桩里没有 ${pid} 的在途扫描(前置断言没成立)`)
    const [one] = pending.splice(i, 1)
    return one
  }
  return {
    /** 让某个项目的在途扫描「迟到送达」——成功 */
    settle: (pid) => take(pid).resolve({
      ok: true,
      files: (treesByPid[pid] || []).map((x) => ({ ...x })),
      truncated: false
    }),
    /** 迟到送达 ——失败 */
    settleFail: (pid, error) => take(pid).resolve({ ok: false, error })
  }
}

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
  // M-6:readLog 是「LRU 命中 vs 真的重读」这台仪器,以前只填不判。
  // 它同时钉住 ctx 交出去的那个 pid:每次读都带**完整文档 id**,短 id 会让两端都查不到根。
  ok(readLog.length === readCalls, '桩录到的读次数与计数器一致(readLog 确实在跟)', `${readLog.length}/${readCalls}`)
  ok(readLog.every((r) => r.pid === 'godot/project/p1' && r.rel === 'scene/main.tscn'),
    '每一次 readProjectText 都用完整文档 id + 树里那个 rel', JSON.stringify(readLog))
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
  // M-6:原来的 `typeof findingsOf(...) === 'object'` 恒真(findingsOf 里就写了 `|| []`),
  // 换成能失败的形状:取到的是**那个工具真实的结论数组**,没跑过/不存在的 id 才回空数组。
  ok(t.findingsOf('brokenRefs').length === 1 && t.findingsOf('brokenRefs')[0].id === br.findings[0].id,
    'findingsOf 返回的就是该工具那一次跑出来的那批结论(不是恒真的 typeof 判据)', JSON.stringify(t.findingsOf('brokenRefs')))
  ok(t.findingsOf('nope').length === 0, '未注册 / 没跑过的 id 回空数组而不是 undefined', JSON.stringify(t.findingsOf('nope')))

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
  // M-7:第三个样本原来写的是「路径非法」—— 两个宿主都不会吐这句(它属于 readProjectText
  // 的 rel 校验,见 src/public/tauri-shim.js:85),换成**扫描**真会给的两句之一:
  // 项目 id 查不到根时 shim 回 '项目不存在'(src/public/tauri-shim.js:83)。
  for (const raw of ['项目目录已不存在', '项目目录不可读', '项目不存在']) {
    global.window.services.scanProjectTree = () => ({ ok: false, error: raw })
    const inst = M.useTools()
    await inst.load()
    await inst.runTool('size')
    seenErr.push(inst.error.value)
  }
  ok(seenErr[0] === '项目目录无法读取', 'JS 宿主的「项目目录已不存在」归一', seenErr[0])
  ok(seenErr[1] === seenErr[0], 'Rust 宿主的「项目目录不可读」归一到同一句', seenErr[1])
  ok(seenErr[2] === '项目不存在', '其它失败原因原样透传,不吞掉诊断', seenErr[2])
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

  // ---------- 以下是修复轮 1:审查 F-1 / F-2 / F-3 与 M-5 ~ M-9 ----------

  // F-1 两节共用的项目表:p1 与 p2 各有**自己的** scene/main.tscn,引用各自存在的文件,
  // 单独看都干净。只有「A 的清单 + B 的文本」这种混搭才会凭空造出 error 级假阳性。
  const F1_P1 = { _id: 'godot/project/p1', id: 'p1', path: 'E:/proj', name: 'Demo', favorite: false, openCount: 0, configVersion: 5, lastOpenedAt: 2000 }
  const F1_P2 = { _id: 'godot/project/p2', id: 'p2', path: 'E:/proj2', name: 'Demo2', favorite: false, openCount: 0, configVersion: 5, lastOpenedAt: 1000 }
  const F1_TREES = {
    'godot/project/p1': [
      { rel: 'project.godot', size: 100, mtimeMs: 1, ext: 'godot' },
      { rel: 'scene/main.tscn', size: 200, mtimeMs: 1, ext: 'tscn' },
      { rel: 'data/ok_in_p1.res', size: 300, mtimeMs: 1, ext: 'res' }
    ],
    'godot/project/p2': [
      { rel: 'project.godot', size: 100, mtimeMs: 1, ext: 'godot' },
      { rel: 'scene/main.tscn', size: 200, mtimeMs: 1, ext: 'tscn' },
      { rel: 'data/only_p2.res', size: 300, mtimeMs: 1, ext: 'res' }
    ]
  }
  const F1_TEXTS = {
    'godot/project/p1|scene/main.tscn': '[ext_resource type="Script" path="res://data/ok_in_p1.res" id="1_a"]\n',
    'godot/project/p2|scene/main.tscn': '[ext_resource type="Script" path="res://data/only_p2.res" id="1_a"]\n'
  }

  section('16. F-1 扫描在途时切项目:过期结果整份丢弃')
  const f1calls = { 'godot/project/p1': 0, 'godot/project/p2': 0 }
  const f1scan = deferredScanner(
    { 'godot/project/p1': F1_TREES['godot/project/p1'], 'godot/project/p2': [{ rel: 'project.godot', size: 100, mtimeMs: 1, ext: 'godot' }] },
    f1calls
  )
  global.window.ztools.db.allDocs = async () => [{ ...F1_P1 }, { ...F1_P2 }]
  const tA = M.useTools()
  await tA.load()
  ok(tA.projectId.value === 'godot/project/p1', 'F-1 前置:默认选中 p1', tA.projectId.value)
  const runA = tA.runTool('size')
  await tick()
  ok(f1calls['godot/project/p1'] === 1, 'p1 的扫描已发起且仍挂起(deferred 未 resolve)', f1calls['godot/project/p1'])
  tA.select('godot/project/p2') // ← await 与「写状态」之间插入一次项目切换
  f1scan.settle('godot/project/p1') // ← p1 的清单迟到送达
  const resA = await runA
  ok(resA === null, '过期扫描不产出结果(runTool 返回 null)', JSON.stringify(resA))
  ok(tA.tree.value.length === 0, 'p1 的清单**没有**被写进 p2 的状态', JSON.stringify(tA.tree.value.map((x) => x.rel)))
  ok(tA.truncated.value === false, '过期扫描也不写 truncated', String(tA.truncated.value))
  ok(Object.keys(tA.results.value).length === 0, '过期扫描不在 results 里留一行', JSON.stringify(Object.keys(tA.results.value)))
  ok(f1calls['godot/project/p2'] === 0, '切项目本身不扫描:p2 的扫描次数没被牵连', f1calls['godot/project/p2'])
  // 换项目后仍要各自扫一次、拿到自己的清单
  // (invalidateTree 是为了让修复前后都真的走到「扫 p2」:修复前那份串进来的 p1 清单
  // 会让 TTL 直接命中、p2 一次都不扫,后面的桩断言就无从 settle。)
  tA.invalidateTree()
  const runB = tA.runTool('size')
  await tick()
  f1scan.settle('godot/project/p2')
  const resB = await runB
  ok(resB.ok === true && f1calls['godot/project/p2'] === 1, 'p2 随后自己扫一次', `${JSON.stringify(resB)}|${f1calls['godot/project/p2']}`)
  ok(tA.tree.value.length === 1 && tA.tree.value[0].rel === 'project.godot', '状态里是 p2 自己的清单', JSON.stringify(tA.tree.value.map((x) => x.rel)))
  // 迟到的**失败**结果同样不许串项目(用新实例,不与上一段的状态纠缠)
  const tA2 = M.useTools()
  await tA2.load()
  const runC = tA2.runTool('cache')
  await tick()
  tA2.select('godot/project/p2')
  f1scan.settleFail('godot/project/p1', '项目目录不可读')
  const resC = await runC
  ok(resC === null && tA2.error.value === '', '过期扫描的失败也不上浮到当前项目(R-C 文案不跨项目)', `${JSON.stringify(resC)}|${tA2.error.value}`)
  restore()

  section('17. F-1 跨项目的 tree + 当前项目的文本不得产出 error 级假阳性')
  const f1bcalls = { 'godot/project/p1': 0, 'godot/project/p2': 0 }
  const f1b = deferredScanner(F1_TREES, f1bcalls)
  const f1bread = []
  global.window.services.readProjectText = (pid, rel) => {
    f1bread.push(`${pid}|${rel}`)
    const text = F1_TEXTS[`${pid}|${rel}`]
    return typeof text === 'string' ? { ok: true, text, bytes: text.length, truncated: false } : { ok: false, error: '文件不存在' }
  }
  global.window.ztools.db.allDocs = async () => [{ ...F1_P1 }, { ...F1_P2 }]
  const tB = M.useTools()
  await tB.load()
  const run1 = tB.runTool('brokenRefs') // p1 的扫描挂起中
  await tick()
  tB.select('godot/project/p2')
  const run2 = tB.runTool('brokenRefs') // p2 的扫描挂起中
  await tick()
  f1b.settle('godot/project/p2') // 先让 p2 完整跑完,状态里是 p2 的清单
  const p2Res = await run2
  ok(p2Res.ok === true && p2Res.findings.length === 0, 'p2 单独看没有断链', JSON.stringify(p2Res.findings))
  ok(tB.tree.value.some((x) => x.rel === 'data/only_p2.res'), '此刻状态里是 p2 的清单', JSON.stringify(tB.tree.value.map((x) => x.rel)))
  const readsBefore = f1bread.length
  f1b.settle('godot/project/p1') // ← p1 的清单此刻才迟到
  const lateRes = await run1
  ok(lateRes === null, '迟到的 p1 扫描整份丢弃', JSON.stringify(lateRes))
  ok(tB.tree.value.some((x) => x.rel === 'data/only_p2.res') && !tB.tree.value.some((x) => x.rel === 'data/ok_in_p1.res'),
    'p1 的清单没有把 p2 的状态换掉', JSON.stringify(tB.tree.value.map((x) => x.rel)))
  ok((tB.results.value.brokenRefs?.findings || []).length === 0,
    '不会拿 A 的场景去比 B 的清单从而报出 error 级假阳性', JSON.stringify(tB.results.value.brokenRefs?.findings))
  ok(f1bread.length === readsBefore, '被丢弃的那轮一个文本都没读(ctx 的 pid 与 tree 同属一个项目)', `${f1bread.length}/${readsBefore}`)
  ok(f1bcalls['godot/project/p2'] === 1 && f1bcalls['godot/project/p1'] === 1, '两个项目各自只扫一次', JSON.stringify(f1bcalls))
  restore()

  section('18. F-2a 空项目(合法的空清单)同样命中 TTL')
  // Rust 侧对「空而可读」的根如实回 { ok:true, files:[] }(src-tauri/src/inspectfs.rs:509-512)。
  // 新鲜度若看 tree.length,这种项目就永远命中不了 TTL → 每个工具各重扫一次。
  let emptyScans = 0
  global.window.services.scanProjectTree = () => { emptyScans++; return { ok: true, files: [], truncated: false } }
  global.window.services.readProjectText = () => ({ ok: true, text: '无引用\n', bytes: 4, truncated: false })
  const tE = M.useTools()
  await tE.load()
  const e1 = await tE.runTool('size')
  const e2 = await tE.runTool('cache')
  const e3 = await tE.runTool('brokenRefs')
  ok(emptyScans === 1, '空清单也算「扫过了」:三个工具共用同一次扫描', emptyScans)
  ok(e1.ok && e2.ok && e3.ok && e3.findings.length === 0 && e1.scannedFiles === 0,
    '空项目的三张卡片都是正常成功而不是失败', JSON.stringify([e1.ok, e2.ok, e3.ok, e3.findings.length, e1.scannedFiles]))
  const allE = await tE.runAll()
  ok(emptyScans === 2, 'runAll 在空项目上也只重扫一次(1+N 次遍历的退化已消除)', emptyScans)
  ok(allE.length === 3 && allE.every((x) => x.ok === true), '空项目的全量体检仍是三行成功', JSON.stringify(allE.map((x) => [x.toolId, x.ok])))
  restore()

  section('19. F-2b 扫描失败时 runAll 停下并上浮单条失败')
  let deadScans = 0
  global.window.services.scanProjectTree = () => { deadScans++; return { ok: false, error: '项目目录不可读' } }
  const tD = M.useTools()
  await tD.load()
  const rowsD = await tD.runAll()
  ok(deadScans === 1, '清单拿不到时整轮只试一次扫描,而不是每个工具各试一次', deadScans)
  ok(rowsD.length === 0 && !rowsD.some((x) => x.error === '未运行'),
    '口径:停下并上浮单条失败,不产出一排「未运行」冒充三个问题', JSON.stringify(rowsD.map((x) => [x.toolId, x.error])))
  ok(tD.error.value === '项目目录无法读取', '失败原因仍按 R-C 归一后上浮到 error', tD.error.value)
  ok(Object.keys(tD.results.value).length === 0, 'results 里不留半截结果', JSON.stringify(Object.keys(tD.results.value)))
  ok(tD.allRunning.value === false && tD.progress.value === '' && tD.running.value === '',
    '提前收尾时 allRunning/progress/running 全部归位', `${tD.allRunning.value}|${tD.progress.value}|${tD.running.value}`)
  restore()

  section('20. F-3 读失败不进缓存:下一轮会真的重试')
  const f3Tree = [{ rel: 'scene/main.tscn', size: 200, mtimeMs: 1, ext: 'tscn' }]
  const f3Attempt = {}
  global.window.services.scanProjectTree = () => ({ ok: true, files: f3Tree.map((x) => ({ ...x })), truncated: false })
  global.window.services.readProjectText = (pid, rel) => {
    f3Attempt[rel] = (f3Attempt[rel] || 0) + 1
    // 每个 rel 的**第一次**读都炸(模拟一次临时 EACCES),之后就正常
    if (f3Attempt[rel] === 1) throw new Error('EACCES: 权限暂时读不到')
    return { ok: true, text: TEXTS[rel] ?? '', bytes: 1, truncated: false }
  }
  const tR = M.useTools()
  await tR.load()
  const fr1 = await tR.runTool('brokenRefs')
  ok(fr1.ok === true && fr1.findings.length === 0, '首轮读炸按「读不到」跳过,这一轮不下断链结论', JSON.stringify(fr1))
  const fr2 = await tR.runTool('brokenRefs')
  ok(f3Attempt['scene/main.tscn'] === 2, '失败的读**不写缓存**:第二轮会真的重试(缓存它 = 整个清单周期内不再试)', f3Attempt['scene/main.tscn'])
  ok(fr2.findings.length === 1 && fr2.findings[0].severity === 'error', '重试成功后真实断链才报出来', JSON.stringify(fr2.findings))
  // 直接看 readText 的三态,不靠检查器间接观察:第一次 skipped、第二次 text;
  // 而**成功**的结果(含 skipped 的正常态)照旧进缓存,不反复重试。
  let f3pair = null
  tR.registerTool({
    id: 'retryProbe', name: '重读探针', summary: 's', phase: 'P0', needs: ['tree'],
    run: async (ctx) => { f3pair = [await ctx.readText('scene/other.tscn'), await ctx.readText('scene/other.tscn')]; return [] }
  })
  await tR.runTool('retryProbe')
  ok(f3pair[0].skipped === true && typeof f3pair[1].text === 'string',
    '同一次运行里:第一次给 skipped,重试立刻拿到文本', JSON.stringify(f3pair))
  await tR.runTool('retryProbe')
  ok(f3Attempt['scene/other.tscn'] === 2, '成功过的读仍走缓存(只有失败不入缓存),没有变成每次都重读', f3Attempt['scene/other.tscn'])
  restore()

  section('21. M-5 工具返回值在边界归一成数组(R-B 口径)')
  const tG = M.useTools()
  await tG.load()
  // registerTool 是公开出口,第三方/P1 的动态注册都可能给出 undefined
  tG.registerTool({ id: 'ghost', name: '幽灵', summary: 's', phase: 'P0', needs: [], run: async () => undefined })
  const rg = await tG.runTool('ghost')
  ok(rg.ok === true && Array.isArray(rg.findings) && rg.findings.length === 0,
    '工具 resolve undefined 时 findings 归一成 [](不把 undefined 存进 results)', JSON.stringify(rg))
  let countsErr = ''
  try {
    void tG.counts.value
  } catch (e) {
    countsErr = (e && e.message) || 'throw'
  }
  ok(countsErr === '', 'counts 不会在渲染期因为 findings 不是数组而抛 TypeError', countsErr)
  ok(tG.findingsOf('ghost').length === 0, 'findingsOf 对归一后的结果照常给空数组', JSON.stringify(tG.findingsOf('ghost')))
  restore()

  section('22. M-8 runAll 的进度行不被扫描收尾擦掉')
  let m8Scans = 0
  global.window.services.scanProjectTree = () => { m8Scans++; return { ok: true, files: TREE.map((x) => ({ ...x })), truncated: false } }
  const seen8 = []
  const tM = M.useTools()
  await tM.load()
  // 第一个工具在 run() 里 invalidateTree → **下一个**工具的 ensureTree 真的会重扫,
  // 而那次扫描的收尾正是把 runAll 刚写好的「正在体检 i/n:名字」擦成空串的地方。
  tM.registerTool({ id: 'inv', name: '清缓存', summary: 's', phase: 'P0', needs: [], run: async () => { tM.invalidateTree(); return [] } })
  tM.registerTool({
    id: 'spy2', name: '哨兵', summary: 's', phase: 'P0', needs: [],
    run: async () => { seen8.push({ p: tM.progress.value, r: tM.running.value }); return [] }
  })
  await tM.runAll()
  ok(seen8.length === 1, '哨兵确实被跑到', seen8.length)
  ok(m8Scans === 2, '前置条件成立:被 invalidateTree 过的那个工具确实重扫了一次', m8Scans)
  ok(typeof seen8[0].p === 'string' && seen8[0].p !== '' && /哨兵/.test(seen8[0].p),
    '工具内部触发重扫时,runAll 的进度行仍然留在 progress 上', JSON.stringify(seen8[0].p))
  ok(/\d+\s*\/\s*\d+/.test(seen8[0].p), '进度行保留「第几个/共几个」', seen8[0].p)
  ok(tM.progress.value === '' && tM.allRunning.value === false, 'runAll 结束后 progress 照常归位', tM.progress.value)
  // M-8 的另一半:runAll 起手那次强制重扫**期间** progress 也得有内容。
  // progress 归 runAll 所有(扫描不越权覆盖它),那行由 runAll 自己写。
  const f22calls = { 'godot/project/p1': 0 }
  const f22scan = deferredScanner({ 'godot/project/p1': TREE }, f22calls)
  global.window.ztools.db.allDocs = async () => [{ ...PROJECT }]
  const tM2 = M.useTools()
  await tM2.load()
  const runAllP = tM2.runAll()
  await tick()
  const duringScan = tM2.progress.value
  ok(f22calls['godot/project/p1'] === 1, 'runAll 起手确实在扫清单(deferred 挂起中)', f22calls['godot/project/p1'])
  ok(duringScan !== '' && /体检/.test(duringScan), '强制重扫期间 progress 不是空串', JSON.stringify(duringScan))
  f22scan.settle('godot/project/p1')
  const rowsM2 = await runAllP
  ok(rowsM2.length === 3 && rowsM2.every((x) => x.ok === true), 'deferred 收尾后 runAll 照常跑完', JSON.stringify(rowsM2.map((x) => [x.toolId, x.ok])))
  restore()

  section('23. M-9 扫描失败路径复位 truncated')
  global.window.services.scanProjectTree = () => ({ ok: true, files: TREE.map((x) => ({ ...x })), truncated: true })
  const tT = M.useTools()
  await tT.load()
  await tT.runTool('size')
  ok(tT.truncated.value === true, '前置:上一轮确实拿到截断标记', String(tT.truncated.value))
  global.window.services.scanProjectTree = () => ({ ok: false, error: '项目目录不可读' })
  tT.invalidateTree()
  await tT.runTool('size')
  ok(tT.truncated.value === false && tT.tree.value.length === 0,
    '扫描失败(ok:false)时 truncated 与 tree 一并复位,不残留上个项目的截断标记', `${tT.truncated.value}|${tT.tree.value.length}`)
  global.window.services.scanProjectTree = () => { throw new Error('宿主炸了') }
  tT.invalidateTree()
  await tT.runTool('size')
  ok(tT.truncated.value === false, '扫描抛异常时同样复位 truncated', String(tT.truncated.value))
  ok(tT.error.value === '宿主炸了', '异常消息也走 R-C 出口(未知原因原样透传)', tT.error.value)
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
