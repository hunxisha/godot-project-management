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
// 第 24~28 节是 P0b-B1 的修复动作管线 applyFix:只把 rel 交给原语、原语的 ok:false / failed[]
// 如实上浮、改过磁盘必 invalidateTree、什么都没改成的失败**不**重扫、缺能力时一个原语都不碰。
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
  // B1 起还有两个修复桩:基线状态是「宿主压根没有」(caps 探不到),
  // 不删掉的话第 6/13 节那种「缺能力降级」用例会被后面新加的桩反向喂饱。
  delete global.window.services.movePathsToTrash
  delete global.window.services.writeProjectText
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
  ok(Array.isArray(M.TOOLS) && M.TOOLS.length === 9, 'P0a 的 3 条 + P0b-B10a 接线的 6 条 = 9 条', M.TOOLS.length)
  ok(new Set(M.TOOLS.map((t) => t.id)).size === M.TOOLS.length, '工具 id 不重复')
  ok(M.TOOLS.every((t) => t.name && t.summary && t.phase === 'P0' && Array.isArray(t.needs) && typeof t.run === 'function'),
    '每项都有 name/summary/phase/needs/run')
  ok(M.toolById('cache').id === 'cache' && M.toolById('nope') === undefined, 'toolById 命中与未命中都对')
  ok(M.isSupported(M.TOOLS[0], { tree: true, text: true, write: false, trash: false }) === true, 'isSupported 满足时需要项全 true')
  ok(M.isSupported(M.toolById('brokenRefs'), { tree: true, text: false, write: false, trash: false }) === false,
    'brokenRefs 需要 text,缺了就不支持')

  // ---------- B10a:六条新工具的接线(逐条钉 needs) ----------
  // needs 少写一项的后果不是报错而是**点亮了一张点不动的卡**:卡片照显示、体检照跑,
  // 直到用户点修复按钮才撞上「宿主没有这个原语」。多写一项反过来:旧宿主上这张卡凭空消失,
  // 连「只报告」的那一半都看不见。所以逐条比 needs 的**内容与集合**,不靠注释。
  const NEEDS_BY_ID = {
    uid: ['tree', 'text', 'trash'],
    orphans: ['tree', 'text', 'trash'],
    imports: ['tree', 'text', 'trash'],
    addons: ['tree', 'text'],
    ini: ['tree', 'text'],
    format: ['tree', 'text', 'write']
  }
  for (const [id, needs] of Object.entries(NEEDS_BY_ID)) {
    const tool = M.toolById(id)
    ok(!!tool, `${id} 已登记进 TOOLS`, tool && tool.id)
    ok(!!tool && [...tool.needs].sort().join(',') === [...needs].sort().join(','),
      `${id} 的 needs 逐字对上接线表(${needs.join('/')})`, tool && tool.needs.join(','))
    ok(!!tool && tool.phase === 'P0', `${id} 属 P0 阶段`, tool && tool.phase)
  }
  // 缺 trash 的宿主:三条 trash 工具不支持,只吃 tree/text 的五条不受牵连
  const NO_TRASH = { tree: true, text: true, write: true, trash: false }
  ok(['uid', 'orphans', 'imports'].every((id) => M.isSupported(M.toolById(id), NO_TRASH) === false),
    '宿主没有 movePathsToTrash 时三条 trash 工具一律不支持(spec §5.4:缺能力是状态不是异常)')
  ok(['size', 'cache', 'brokenRefs', 'addons', 'ini'].every((id) => M.isSupported(M.toolById(id), NO_TRASH) === true),
    '缺 trash 不许牵连只吃 tree/text 的五条(needs 写宽 = 旧宿主上整张卡消失)')
  // 缺 write 的宿主:只有 format 不支持;只报告的两条(B7/B8 头部声明)照常点亮
  const NO_WRITE = { tree: true, text: true, write: false, trash: true }
  ok(M.isSupported(M.toolById('format'), NO_WRITE) === false,
    '宿主没有 writeProjectText 时 format 不支持(它会点出「改写」按钮却没有落盘通道)',
    JSON.stringify(M.toolById('format').needs))
  ok(['addons', 'ini', 'uid', 'orphans', 'imports'].every((id) => M.isSupported(M.toolById(id), NO_WRITE) === true),
    '缺 write 不许牵连其余五条(addons/ini 声明的就是 tree+text 那一对)')
  // 顺序 = runAll 的执行顺序:注册表被 useTools 直接遍历,所以这条决定必须由数组顺序本身承载
  const idx = (id) => M.TOOLS.findIndex((x) => x.id === id)
  const READ_FIRST = ['addons', 'ini', 'uid']
  const WRITE_LAST = ['orphans', 'imports', 'format']
  ok(READ_FIRST.every((a) => WRITE_LAST.every((b) => idx(a) < idx(b))),
    '「先只读、后可写」:批量动盘的 orphans/imports/format 三条全在 addons/ini/uid 之后(spec 待确认 #8)',
    M.TOOLS.map((x) => x.id).join('>'))
  ok(['size', 'cache', 'brokenRefs'].every((a) => WRITE_LAST.every((b) => idx(a) < idx(b))),
    'P0a 的三条只读工具同样排在动盘三条之前', M.TOOLS.map((x) => x.id).join('>'))
  // 卡面(name/summary 是用户唯一看到的两个字面)不许出现实现术语
  const JARGON = /rewrite|聚合卡|payload|service|needs|\bctx\b|LRU|引用索引/
  ok(M.TOOLS.every((x) => !JARGON.test(x.name) && !JARGON.test(x.summary)),
    '九条卡面都不含实现术语(rewrite 通道 / 聚合卡 / payload 这类)',
    M.TOOLS.filter((x) => JARGON.test(x.name) || JARGON.test(x.summary)).map((x) => `${x.name}|${x.summary}`).join(' // '))

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
  // B10a 起这台宿主(tree+text)只跑得动 9 条里的 5 条:缺 trash/write 的四条按 §5.4 走
  // 「当前宿主不支持」这条**状态**,既不算失败也不算假成功。三个口径分开数,
  // 才咬得住「一个工具炸了不拖垮别人」这条不变量在接线后仍然成立。
  ok(all.length === t.tools.value.length, 'runAll 每个注册工具一行(含 registerTool 的探针)',
    `${all.length}/${t.tools.value.length}`)
  ok(all.filter((x) => x.error === '当前宿主不支持').map((x) => x.toolId).sort().join(',') === 'format,imports,orphans,uid',
    '缺 trash/write 的四条在调用任何原语之前就短路(不是跑成也不是炸掉)',
    all.filter((x) => x.error === '当前宿主不支持').map((x) => x.toolId).join(','))
  ok(['size', 'cache', 'brokenRefs', 'addons', 'ini'].every((id) => (all.find((x) => x.toolId === id) || {}).ok === true),
    '宿主能跑的 5 条全部跑成,不受「另一个工具炸了」影响(单工具失败隔离,B10a 后仍成立)',
    JSON.stringify(all.map((x) => [x.toolId, x.ok])))
  ok(scanCalls === 2, 'runAll 强制重扫一次(之前是 1)', scanCalls)

  section('5. counts 汇总')
  ok(t.counts.value.error >= 1 && t.counts.value.info >= 1, 'counts 按严重度累计', JSON.stringify(t.counts.value))
  // M-6:原来的 `typeof findingsOf(...) === 'object'` 恒真(findingsOf 里就写了 `|| []`),
  // 换成能失败的形状:取到的是**那个工具真实的结论数组**,没跑过/不存在的 id 才回空数组。
  // Task 16 修复:上一版拿 `br.findings[0].id` 与 `findingsOf('brokenRefs')[0].id` 相比,而
  // `br` 就是 `t.results.value.brokenRefs` —— 同一份数组自比,**永远为真**,findingsOf 返回
  // 别的工具的结果、或返回空数组之外的任何东西都照样绿。id 改成钉字面量(证据推导:场景 rel +
  // ext_resource id + 引用 path),这条才有失败能力。
  ok(t.findingsOf('brokenRefs').length === 1 &&
    t.findingsOf('brokenRefs')[0].id === 'brokenRefs:scene/main.tscn:1_a:res://gone.gd',
    'findingsOf 返回的就是该工具那一次跑出来的那批结论(id 与夹具证据逐字对上)', JSON.stringify(t.findingsOf('brokenRefs')))
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

  section('10. 切换项目清空 tree / results / error / 文本 LRU')
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
  // Task 16 修复:error 也按项目成立。旧 select() 清了 tree/results/truncated/LRU,却漏了 error,
  // 于是上一个项目的扫描横幅(「项目目录无法读取」)会挂在新项目页面上,直到下一次成功扫描才消失
  // —— 而 ToolsView 的 err-line 是唯一的失败出口,残留就等于报一个不存在的问题。
  global.window.services.scanProjectTree = (pid) => pid === 'godot/project/p1'
    ? { ok: false, error: '项目目录不可读' }
    : { ok: true, files: TREE.map((x) => ({ ...x })), truncated: false }
  t7.invalidateTree() // 强制下一次真的重扫:命中 TTL 就走不到失败那一路
  await t7.runTool('size')
  ok(t7.error.value === '项目目录无法读取', '前置:p1 扫描失败,error 已按 R-C 归一上浮', t7.error.value)
  t7.select('godot/project/p2')
  ok(t7.error.value === '', '切项目一并清空 error:上一个项目的扫描横幅不残留', JSON.stringify(t7.error.value))
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
  ok(all8.length === M.TOOLS.length, 'runAll 每个注册工具一行(接线后 9 行)', all8.length)
  // 缺原语的四条不扫树(isSupported 在 ensureTree 之前短路),所以 scanCalls 的计数与 3 条时代一致
  ok(all8.filter((x) => x.ok).length === 5 && all8.filter((x) => x.error === '当前宿主不支持').length === 4,
    '能跑的 5 条全绿、缺原语的 4 条按能力降级(不是失败,也不许冒充跑成)', JSON.stringify(all8.map((x) => [x.toolId, x.ok])))
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
  ok(allE.length === M.TOOLS.length && allE.filter((x) => x.ok).length === 5,
    '空项目的全量体检:能跑的 5 行成功,缺原语的 4 行按能力降级(降级来自宿主而不是空清单)',
    JSON.stringify(allE.map((x) => [x.toolId, x.ok])))
  ok(allE.every((x) => x.ok === true || x.error === '当前宿主不支持'),
    '空项目不产生第三种状态:每一行要么跑成、要么明确「宿主不支持」',
    JSON.stringify(allE.filter((x) => x.ok !== true && x.error !== '当前宿主不支持').map((x) => [x.toolId, x.error])))
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
  ok(rowsM2.length === M.TOOLS.length && rowsM2.filter((x) => x.ok).length === 5,
    'deferred 收尾后 runAll 照常跑完(9 行:5 行跑成 + 4 行能力降级)', JSON.stringify(rowsM2.map((x) => [x.toolId, x.ok])))
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

  // ---------- 以下是 Task B1:修复动作管线 applyFix(spec §5.3) ----------
  // 为什么值得单测:P0b 的 6 个新检查器里有 4 个会**改用户的磁盘**。调度层承担四件事
  // ① 只把 rel 交给原语(包含闸与绝对路径拼接归 inspectfs.js,渲染层一拼就绕过它);
  // ② 原语的 ok:false / failed[] 不许被美化成成功(TrashResult 的复核语义在 :284-297);
  // ③ 改过磁盘必须 invalidateTree,否则 60s TTL 会让下一次体检拿着「已经删掉的文件」出结论;
  // ④ 反之**什么都没改成的失败不许重扫**(白扫一次 10 万文件的遍历)。
  // ②③④ 全是「看起来正常」的行为,只有计数桩抓得住。
  const FIX_FINDING = {
    id: 'uid:scene/main.tscn',
    severity: 'warn',
    title: '孤儿 .uid',
    fix: { kind: 'trash', label: '移入回收站', payload: ['scene/main.tscn'] }
  }

  section('24. applyFix 成功:只交 rel、成功后强制重扫')
  const trashLog = []
  global.window.services.movePathsToTrash = (pid, rels) => {
    trashLog.push({ pid, rels })
    return { ok: true, moved: rels.length, failed: [] }
  }
  const tF = M.useTools()
  await tF.load()
  await tF.runTool('size') // 先把清单扫进来(applyFix 用 tree 解析预览体积)
  const scanBeforeFix = scanCalls
  const oK = await tF.applyFix(FIX_FINDING, { isWin: true })
  ok(oK.ok === true && oK.moved === 1 && oK.failed.length === 0, '回收站成功回执', JSON.stringify(oK))
  ok(trashLog.length === 1 && trashLog[0].rels.join(',') === 'scene/main.tscn',
    '只把 rel 交给原语(渲染层不拼绝对路径,越界与符号链接由 resolveInside 把关)', JSON.stringify(trashLog))
  ok(trashLog[0].pid === 'godot/project/p1', '调用带完整文档 id 而不是短 id', trashLog[0].pid)
  ok(oK.verb === '移入回收站' && oK.message.includes('移入回收站') && !oK.message.includes('永久删除'),
    '成功回执按平台动词说话(Windows 可还原,不提永久删除)', `${oK.verb}|${oK.message}`)
  ok(oK.changed === true && oK.invalidated === true, '磁盘真的变了 → 标记 invalidated', `${oK.changed}/${oK.invalidated}`)
  // 记账比对**字段**而不是引用:ref 的 Record 会给读出来的对象包一层 reactive 代理,
  // `=== oK` 恒假(实现是对的,别把这条改成删掉记账的借口)。
  const rec = tF.fixResults.value['uid:scene/main.tscn']
  ok(!!rec && rec.ok === true && rec.moved === 1 && rec.findingId === FIX_FINDING.id,
    '修复结果按 finding id 记账,UI 能回显并重跑该检查器', JSON.stringify(Object.keys(tF.fixResults.value)))
  await tF.runTool('size')
  ok(scanCalls === scanBeforeFix + 1, '成功修复后 invalidateTree:下一次 runTool 真的重扫(60s TTL 不许端着改过的旧清单)',
    scanCalls - scanBeforeFix)

  section('25. applyFix 如实回报失败(ok:false + failed[])')
  global.window.services.movePathsToTrash = (pid, rels) => ({
    ok: false, moved: Math.max(0, rels.length - 1), failed: [{ rel: 'scene/main.tscn', error: '移入回收站失败' }]
  })
  const tFxP = M.useTools()
  await tFxP.load()
  await tFxP.runTool('size')
  const oP = await tFxP.applyFix(
    { id: 'uid:multi', severity: 'warn', title: '孤儿 .uid', fix: { kind: 'trash', label: '移入回收站', payload: ['scene/main.tscn', '.godot/imported/a.stex'] } },
    { isWin: true })
  ok(oP.ok === false, '原语回 ok:false 时回执必须 ok:false(不把部分失败美化成成功)', JSON.stringify(oP))
  ok(oP.moved === 1 && oP.failed.length === 1 && oP.failed[0].rel === 'scene/main.tscn',
    '成功数与失败项原样带出(UI 据此写「N 项成功、M 项失败」)', JSON.stringify([oP.moved, oP.failed]))
  ok(/1 项失败/.test(oP.message) && oP.message.includes('移入回收站失败'),
    '失败条数与原语的中文原因原样上浮,不重译不吞掉', oP.message)
  ok(oP.changed === true && oP.invalidated === true, '部分成功仍然改了磁盘 → 照样重扫', `${oP.changed}/${oP.invalidated}`)
  const scanAfterPartial = scanCalls
  await tFxP.runTool('size')
  ok(scanAfterPartial + 1 === scanCalls, '部分成功后的下一次体检确实重扫', scanCalls - scanAfterPartial)
  // 全失败:盘上什么都没少(复核语义见 inspectfs.js:292-293)→ 不重扫
  global.window.services.movePathsToTrash = () => ({ ok: false, moved: 0, failed: [{ rel: 'scene/main.tscn', error: '文件不存在' }] })
  await tFxP.runTool('cache') // 把上一次重扫用掉,TTL 重新变新鲜,下面的 0 增量才有意义
  const scanBeforeDead = scanCalls
  const oD = await tFxP.applyFix(FIX_FINDING, { isWin: true })
  ok(oD.ok === false && oD.changed === false && oD.invalidated === false,
    '一项都没删掉的失败:changed/invalidated 都是 false', JSON.stringify([oD.ok, oD.changed, oD.invalidated]))
  ok(oD.message.includes('文件不存在'), '原语的中文原因照旧透传', oD.message)
  await tFxP.runTool('size')
  ok(scanCalls === scanBeforeDead, '什么都没改成的失败**不**触发重扫(白扫一遍 10 万文件的遍历)', scanCalls - scanBeforeDead)

  section('26. applyFix 在能力缺失时一个原语都不碰')
  delete global.window.services.movePathsToTrash
  const tH = M.useTools()
  await tH.load()
  ok(tH.caps.trash === false && tH.caps.write === false, 'caps 探到宿主没有 trash/write 能力', JSON.stringify(tH.caps))
  const trashCallsBefore = trashLog.length
  const oN = await tH.applyFix(FIX_FINDING, { isWin: true })
  ok(oN.ok === false && oN.error === '当前宿主不支持', '缺能力时结构化返回而不是抛异常', JSON.stringify(oN))
  ok(trashLog.length === trashCallsBefore, '缺失的原语压根没被调用', trashLog.length - trashCallsBefore)
  ok(oN.changed === false && oN.invalidated === false, '没执行 = 磁盘没变,不重扫', `${oN.changed}/${oN.invalidated}`)

  section('27. applyFix 改写通道:逐文件调用 + 备份去向回执')
  const writeLog = []
  global.window.services.movePathsToTrash = (pid, rels) => ({ ok: true, moved: rels.length, failed: [] })
  global.window.services.writeProjectText = (pid, rel, text) => {
    writeLog.push({ pid, rel, text })
    return rel === 'a.gd' ? { ok: true, backupRel: 'a.gd.gpm-bak-20260301_1200_00' } : { ok: false, error: '写入失败' }
  }
  const tI = M.useTools()
  await tI.load()
  await tI.runTool('size')
  const oW = await tI.applyFix(
    { id: 'format:1', severity: 'info', title: '行尾空白', fix: { kind: 'rewrite', label: '格式化', payload: { files: [{ rel: 'a.gd', text: 'x' }, { rel: 'b.gd', text: 'y' }] } } },
    { isWin: true })
  ok(writeLog.length === 2 && writeLog.every((w) => w.rel === 'a.gd' || w.rel === 'b.gd') && writeLog[0].text === 'x',
    '逐文件调 writeProjectText,参数只有 rel + 新内容', JSON.stringify(writeLog.map((w) => w.rel)))
  ok(oW.ok === false && oW.written.join(',') === 'a.gd' && oW.failed.length === 1 && oW.failed[0].error === '写入失败',
    '一个改成一个、一个失败报一个(不把 ok:false 说成成功)', JSON.stringify([oW.ok, oW.written, oW.failed]))
  ok(/gpm-bak/.test(oW.message) && oW.backups.join(',') === 'a.gd.gpm-bak-20260301_1200_00',
    '可撤销提示:回执里带原语的备份去向(spec §5.3 规则 2/4)', `${oW.message}|${JSON.stringify(oW.backups)}`)
  ok(oW.verb === '改写文件' && oW.service === 'writeProjectText', '改写通道的动词与服务名对上', `${oW.verb}|${oW.service}`)
  ok(oW.changed === true && oW.invalidated === true, '改成过一个文件就要重扫(清单与文本 LRU 都过时了)', `${oW.changed}/${oW.invalidated}`)
  global.window.services.writeProjectText = () => ({ ok: false, error: '备份失败' })
  await tI.runTool('size')
  const scanBeforeW = scanCalls
  const oWF = await tI.applyFix(
    { id: 'ini:1', severity: 'warn', title: '重复键', fix: { kind: 'rewrite', label: '改写配置', payload: { rel: 'project.godot', text: 'z' } } },
    { isWin: true })
  ok(oWF.ok === false && oWF.changed === false && oWF.written.length === 0,
    '备份失败 = 原文件一个字节没动(原语正是这么保证的)', JSON.stringify([oWF.ok, oWF.changed, oWF.written]))
  ok(oWF.message.includes('备份失败'), '失败原因用原语原话', oWF.message)
  await tI.runTool('size')
  ok(scanCalls === scanBeforeW, '改写全失败同样不触发重扫', scanCalls - scanBeforeW)

  section('28. applyFix 的不可执行路径:既有能力 / 缺新内容 / 原语炸')
  const writeCallsBefore = writeLog.length
  const oE = await tI.applyFix(
    { id: 'cache:1', severity: 'info', title: '缓存可清理', fix: { kind: 'existing', label: '去项目页清理', service: 'cleanProjectCache' } },
    { isWin: true })
  ok(oE.ok === false && oE.service === null, 'existing 不是可执行动作:service 为 null', JSON.stringify([oE.ok, oE.service]))
  ok(/既有能力|跳转/.test(oE.message), '说不清「为什么不做」不算完 —— 回执必须给原因', oE.message)
  ok(writeLog.length === writeCallsBefore && trashLog.length === trashCallsBefore,
    '不可执行的修复一个原语都不碰(不重复执行既有能力)', `${writeLog.length}/${trashLog.length}`)
  const oNT = await tI.applyFix(
    { id: 'ini:2', severity: 'warn', title: '重复键', rel: 'project.godot', fix: { kind: 'rewrite', label: '改写配置' } },
    { isWin: true })
  ok(oNT.ok === false && oNT.service === null && /内容/.test(oNT.message),
    'rewrite 没带新内容 → 拒执行并说明缺什么(不写空文件覆掉用户配置)', oNT.message)
  ok(writeLog.length === writeCallsBefore, '这条路也没调原语', writeLog.length - writeCallsBefore)
  global.window.services.movePathsToTrash = () => { throw new Error('宿主炸了') }
  const oBoom = await tI.applyFix(FIX_FINDING, { isWin: true })
  ok(oBoom.ok === false && oBoom.error === '宿主炸了' && oBoom.changed === false,
    '原语抛异常也只标失败,不冒泡(工具页要能在结论里显示原因)', JSON.stringify([oBoom.ok, oBoom.error, oBoom.changed]))
  global.window.services.movePathsToTrash = (pid, rels) => ({ ok: true, moved: rels.length, failed: [] })
  // 缺省 isWin:测试桩宿主压根没有 ztools.isWindows,取平台口径那一步不许把整个修复炸掉,
  // 也不许猜成 Windows —— 退回「永久删除」这个更保守的口径(宁可说得可怕,不可说得安心)。
  let boomMsg = ''
  let oNoWin = null
  try { oNoWin = await tI.applyFix(FIX_FINDING) } catch (e) { boomMsg = (e && e.message) || 'throw' }
  ok(boomMsg === '' && !!oNoWin && oNoWin.ok === true && oNoWin.verb === '永久删除' && /永久删除/.test(oNoWin.message),
    '缺省 isWin 不抛异常,并退回非 Windows 的「永久删除」口径', `${boomMsg}|${oNoWin && oNoWin.verb}|${oNoWin && oNoWin.message}`)
  restore()

  // ---------- Fix round 1:审查 Important 1/2(执行侧)+ Minor 1/2 ----------
  // §24~28 已钉住「只交 rel、如实回报、改盘才重扫」。这一批钉四件同类的账:
  //   ①(Important 2)预览条数与**真正发出的写次数**同源 —— 上一轮 items 去重、files 不去重,
  //     确认框写「确认改写 1 个文件」而这里循环了两次,ok 还拿未去重的 files.length 当比数;
  //   ②(Important 1)越界/绝对 rel 必须**原样**送到原语面前 —— 改写成项目内名字就是绕过 resolveRel;
  //   ③(Minor 1)删除/改写都是逐个 await 的循环,第二次 applyFix 能插在两次 await 之间进来,
  //     于是两份清单同时改盘,后一份的 rel 可能已被前一份删掉,回执还各说各的;
  //   ④(Minor 2)counts.fixable 说「可修复 N」,N 必须是本管线真能执行的条数,否则 SummaryBar
  //     报「可修复 5」而面板上只有 1 个按钮点得动(existing 是跳转、none 只报告、payload 认不出)。
  section('29. applyFix 的执行清单与预览同源(重复点名只写一次 / 越界串原样送闸)')
  const dupWriteLog = []
  const rawRelLog = []
  global.window.services.movePathsToTrash = (pid, rels) => {
    rawRelLog.push(rels)
    return { ok: true, moved: rels.length, failed: [] }
  }
  global.window.services.writeProjectText = (pid, rel, text) => {
    dupWriteLog.push({ rel, text })
    return { ok: true, backupRel: `${rel}.gpm-bak-x` }
  }
  const tP = M.useTools()
  await tP.load()
  await tP.runTool('size')
  const oDup = await tP.applyFix(
    { id: 'fmt:dup', severity: 'info', title: '行尾空白', fix: { kind: 'rewrite', label: '格式化', payload: { files: [{ rel: 'a.gd', text: 'FIRST' }, { rel: './a.gd', text: 'SECOND' }] } } },
    { isWin: true })
  ok(dupWriteLog.length === 1 && dupWriteLog[0].text === 'FIRST',
    '同一个 rel 点名两次只发一次写(预览说 1 个文件,盘上就只写 1 次)', JSON.stringify(dupWriteLog))
  ok(oDup.ok === true && oDup.written.length === 1 && oDup.failed.length === 0,
    'ok 的比数是去重后的那份清单(未去重时 written 永远追不上 files.length)', JSON.stringify([oDup.ok, oDup.written, oDup.failed]))
  await tP.applyFix(
    { id: 'uid:abs', severity: 'warn', title: '孤儿 .uid', fix: { kind: 'trash', label: '移入回收站', payload: ['/etc/passwd', 'C:\\Windows\\x'] } },
    { isWin: true })
  ok(rawRelLog.length === 1 && rawRelLog[0].length === 2 &&
    rawRelLog[0][0] === '/etc/passwd' && rawRelLog[0][1] === 'C:\\Windows\\x',
    '绝对路径/带盘符的 rel **原样**交给原语(渲染层不改写成项目内路径,越界判断是 resolveRel 的活)', JSON.stringify(rawRelLog))
  restore()

  section('30. applyFix 重入:上一次还在 await 期间不许进来第二次')
  // 桩故意返回**手动 resolve** 的 promise:未修复时第二次调用会走到同一个 await 上并且永远不返回
  // (它的 resolve 还没被交给测试),所以这里用 Promise.race 观察「挡回 / 卡住」而不是直接 await ——
  // 直接 await 在未修复的代码上会把整个 harness 挂死,连失败都报不出来。
  const releases = []
  const holdLog = []
  global.window.services.movePathsToTrash = (pid, rels) => {
    holdLog.push(rels.join(','))
    return new Promise((resolve) => {
      releases.push(() => resolve({ ok: true, moved: rels.length, failed: [] }))
    })
  }
  const tRe = M.useTools()
  await tRe.load()
  await tRe.runTool('size')
  const firstP = tRe.applyFix(
    { id: 'uid:r1', severity: 'warn', title: 't', fix: { kind: 'trash', label: '移入回收站', payload: ['scene/main.tscn'] } },
    { isWin: true })
  await tick()
  ok(tRe.fixing.value === 'uid:r1' && holdLog.length === 1,
    '前置条件成立:第一次修复真的卡在 await 上(同步桩复现不出竞态,与 F-1 同一取舍)', `${tRe.fixing.value}|${holdLog.length}`)
  const blockedP = tRe.applyFix(
    { id: 'uid:r2', severity: 'warn', title: 't', fix: { kind: 'trash', label: '移入回收站', payload: ['.godot/imported/a.stex'] } },
    { isWin: true })
  const raced = await Promise.race([
    blockedP.then((o) => ['done', o]),
    new Promise((resolve) => setTimeout(() => resolve(['hang', null]), 30))
  ])
  ok(raced[0] === 'done' && raced[1].ok === false && /上一次修复还在执行中/.test(raced[1].message),
    '第二次被挡回并说清为什么没动(未修复时它自己卡在 await 上)', JSON.stringify(raced))
  ok(holdLog.length === 1, '挡回的那一次一个原语都没调(两份清单同时在改盘就是互相踩)', JSON.stringify(holdLog))
  while (releases.length) releases.shift()()
  const oFirst = await firstP
  // 回执这条要放在**两次调用都尘埃落定之后**再查:未修复时第二次是走完整个删除循环才写回执的,
  // 在 await 之前查它永远缺席,断言就咬不住。
  ok(tRe.fixResults.value['uid:r2'] === undefined,
    '挡回的不写回执:压根没执行的东西记进回执就是假账', JSON.stringify(Object.keys(tRe.fixResults.value)))
  ok(oFirst.ok === true && !!tRe.fixResults.value['uid:r1'] && tRe.fixing.value === '',
    '第一次照常执行完、记账并复位 fixing(挡回不等于把在途那次也弄坏)', JSON.stringify([oFirst.ok, tRe.fixing.value]))
  restore()

  section('31. counts.fixable 只数 planFix 判为可执行的结论')
  const tCx = M.useTools()
  await tCx.load()
  tCx.registerTool({
    id: 'fxmix', name: '修复口径', summary: 's', phase: 'P0', needs: [],
    run: async () => [
      { id: 'fxmix:1', severity: 'warn', title: 't', fix: { kind: 'trash', label: '移入回收站', payload: ['scene/main.tscn'] } },
      { id: 'fxmix:2', severity: 'warn', title: 't', fix: { kind: 'existing', label: '去项目页清理', service: 'cleanProjectCache' } },
      { id: 'fxmix:3', severity: 'info', title: 't', fix: { kind: 'none', label: '只报告' } },
      { id: 'fxmix:4', severity: 'warn', title: 't', rel: 'project.godot', fix: { kind: 'rewrite', label: '改写配置' } },
      { id: 'fxmix:5', severity: 'warn', title: 't', fix: { kind: 'trash', label: '移入回收站', payload: { nope: 1 } } },
      { id: 'fxmix:6', severity: 'warn', title: 't', fix: { kind: 'trash', label: '移入回收站', payload: [] } }
    ]
  })
  await tCx.runTool('fxmix')
  ok(tCx.counts.value.fixable === 1,
    '六条里只有第一条真能由本管线执行:existing 是跳转、none 只报告、缺内容/认不出/空清单都执行不了',
    JSON.stringify(tCx.counts.value))
  ok(tCx.counts.value.warn === 5 && tCx.counts.value.info === 1,
    '严重度计数不受 fixable 口径影响', JSON.stringify([tCx.counts.value.warn, tCx.counts.value.info]))
  restore()

  // ---------- 以下是 Task B10a:按条勾选门的执行侧(spec §5.3 规则 3) ----------
  // 为什么这一批必须落在 useTools 而不是组件:组件没有渲染测试框架,而「交给原语的到底是勾选
  // 那几条、还是整单」是删用户文件的最后一道闸。判据本身在 src/tools/gate.ts(另有 53 条断言),
  // 这里咬的是**调度层真的照门给的清单执行**:裁剪后过原有的两道短路、回执只记实际执行的那一份、
  // 能力闸 / 重入闸 / 换代守卫一条都不许因为「多了个 selected」被绕过去。
  const THREE_REL_IDS = 'project.godot,scene/main.tscn,.godot/imported/a.stex'
  const trashThree = (id) => ({
    id,
    severity: 'warn',
    title: '未引用资源',
    fix: { kind: 'trash', label: '移除 3 个', payload: ['project.godot', 'scene/main.tscn', '.godot/imported/a.stex'] }
  })
  const rewriteThree = (id) => ({
    id,
    severity: 'info',
    title: '代码格式化',
    fix: {
      kind: 'rewrite',
      label: '格式化 3 个脚本',
      payload: [{ rel: 'project.godot', text: 'A' }, { rel: 'scene/main.tscn', text: 'B' }, { rel: '.godot/imported/a.stex', text: 'C' }]
    }
  })

  section('32. applyFix(f, selected):回收站通道只交勾选的那几条')
  const subLog = []
  global.window.services.movePathsToTrash = (pid, rels) => {
    subLog.push({ pid, rels: rels.slice() })
    return { ok: true, moved: rels.length, failed: [] }
  }
  const tS = M.useTools()
  await tS.load()
  await tS.runTool('size')
  const oSub = await tS.applyFix(trashThree('orphans:sub'), ['scene/main.tscn'], { isWin: true })
  ok(subLog.length === 1 && subLog[0].rels.join(',') === 'scene/main.tscn',
    '★勾 1 条就只把这一条交给原语(整单三条 = 「忘了传 selected 就把没勾的也删了」那条禁路)', JSON.stringify(subLog))
  ok(subLog[0].pid === 'godot/project/p1', '裁剪不影响调用带的完整文档 id', subLog[0].pid)
  ok(oSub.rels.join(',') === 'scene/main.tscn' && oSub.moved === 1,
    '回执的 rels/moved 记的是实际执行的那一份(父计划的三条不许留在账上)', JSON.stringify([oSub.rels, oSub.moved]))
  ok(oSub.ok === true && oSub.verb === '移入回收站' && oSub.service === 'movePathsToTrash',
    '子集不改判据:动词/服务/成败口径与整单同一套(措辞仍归 fixPlan.ts)', JSON.stringify([oSub.verb, oSub.service, oSub.ok]))
  ok(oSub.changed === true && oSub.invalidated === true, '子集真改了磁盘 → 照样要重扫(裁剪不削弱 invalidateTree 时机)',
    JSON.stringify([oSub.changed, oSub.invalidated]))
  ok(tS.fixResults.value['orphans:sub'].rels.join(',') === 'scene/main.tscn' &&
    tS.fixResults.value['orphans:sub'].moved === 1,
    '按 finding id 记的那笔账就是子集那一份', JSON.stringify(tS.fixResults.value['orphans:sub']))

  const oOrder = await tS.applyFix(trashThree('orphans:order'), ['.godot/imported/a.stex', 'project.godot'], { isWin: true })
  ok(subLog[1].rels.join(',') === 'project.godot,.godot/imported/a.stex',
    '先勾 a.stex 再勾 project.godot,交给原语的仍是父计划顺序(payload 顺序不随点选抖)', JSON.stringify(subLog[1].rels))
  ok(oOrder.rels.join(',') === 'project.godot,.godot/imported/a.stex' && oOrder.moved === 2,
    '两条勾选中:回执两条,顺序同源', JSON.stringify([oOrder.rels, oOrder.moved]))

  const callsBeforeRefuse = subLog.length
  const oEmpty = await tS.applyFix(trashThree('orphans:empty'), [], { isWin: true })
  ok(oEmpty.ok === false && oEmpty.changed === false && oEmpty.invalidated === false,
    '空选择 → 明确失败,不是「执行了 0 项的成功」', JSON.stringify([oEmpty.ok, oEmpty.changed, oEmpty.invalidated]))
  ok(!!oEmpty.error && /选|勾/.test(oEmpty.message),
    '空选择带原因(spec §5.3 规则 3 的反面就是「点了没反应」)', JSON.stringify(oEmpty.message))
  ok(subLog.length === callsBeforeRefuse, '被拒的空选择一个原语都没碰', subLog.length - callsBeforeRefuse)
  ok(oEmpty.service === 'movePathsToTrash' && oEmpty.rels.length === 0 && oEmpty.moved === 0,
    '拒绝靠 empty + reason,不把计划伪装成「本管线执行不了」,账上也不留父计划的三条',
    JSON.stringify([oEmpty.service, oEmpty.rels, oEmpty.moved]))
  const oGhost = await tS.applyFix(trashThree('orphans:ghost'), ['never/in/plan.png'], { isWin: true })
  ok(oGhost.ok === false && /选|勾/.test(oGhost.message) && subLog.length === callsBeforeRefuse,
    '勾选集合里全是父计划没有的 rel → 与空选择同样被拒,不拿陌生串去撞原语', JSON.stringify([oGhost.message, subLog.length]))

  const oAbs = await tS.applyFix(
    { id: 'orphans:abs', severity: 'warn', title: 't', fix: { kind: 'trash', label: '移除', payload: ['/etc/passwd', 'project.godot'] } },
    ['/etc/passwd'], { isWin: true })
  ok(subLog[subLog.length - 1].rels.join(',') === '/etc/passwd' && oAbs.moved === 1,
    '勾选越界那条:原样交给原语(门与调度层都不替 resolveRel 把它改写成项目内路径)', JSON.stringify(subLog[subLog.length - 1].rels))

  section('33. applyFix(f, selected):改写通道只写勾选的那几条')
  const wLog = []
  global.window.services.writeProjectText = (pid, rel, text) => {
    wLog.push({ pid, rel, text })
    return { ok: true, backupRel: `${rel}.gpm-bak-x` }
  }
  const tW = M.useTools()
  await tW.load()
  await tW.runTool('size')
  const oWSub = await tW.applyFix(rewriteThree('format:sub'), ['scene/main.tscn'], { isWin: true })
  ok(wLog.length === 1 && wLog[0].rel === 'scene/main.tscn' && wLog[0].text === 'B',
    '★勾 1 个只发 1 次写,内容还是那一条自己的(整单三条 = 改了用户没勾的两个源文件)', JSON.stringify(wLog))
  ok(oWSub.written.length === 1 && oWSub.written[0] === 'scene/main.tscn' && oWSub.backups.length === 1 && oWSub.ok === true,
    'written / backups 的条数不超过选中数', JSON.stringify([oWSub.written, oWSub.backups]))
  ok(/已改写 1 个文件/.test(oWSub.message) && !/3 个/.test(oWSub.message),
    '回执文案按实际执行说(不是「已改写 3 个文件」)', oWSub.message)
  ok(oWSub.verb === '改写文件' && oWSub.service === 'writeProjectText',
    '改写子集的判据字段与父计划同一套', JSON.stringify([oWSub.verb, oWSub.service]))
  const writesAfterSub = wLog.length
  const oWEmpty = await tW.applyFix(rewriteThree('format:empty'), [], { isWin: true })
  ok(wLog.length === writesAfterSub && oWEmpty.ok === false && /选|勾/.test(oWEmpty.message),
    'rewrite 的空选择:一次写都不发,带原因被拒', JSON.stringify([wLog.length - writesAfterSub, oWEmpty.message]))
  const oWTwo = await tW.applyFix(rewriteThree('format:two'), ['.godot/imported/a.stex', 'project.godot'], { isWin: true })
  ok(wLog.slice(writesAfterSub).map((w) => w.rel).join(',') === 'project.godot,.godot/imported/a.stex',
    '两条勾选中:写序按父计划而不是点选顺序(与 items/files 同源那条规矩一致)', JSON.stringify(wLog.slice(writesAfterSub)))
  ok(oWTwo.written.length === 2 && oWTwo.backups.length === 2 && oWTwo.ok === true,
    '两条都写成 → 回执两条', JSON.stringify([oWTwo.written, oWTwo.backups]))
  const writesBeforeFail = wLog.length
  global.window.services.writeProjectText = (pid, rel, text) => {
    wLog.push({ pid, rel, text })
    return { ok: false, error: '备份失败' }
  }
  const oWPart = await tW.applyFix(rewriteThree('format:part'), ['scene/main.tscn'], { isWin: true })
  ok(wLog.length === writesBeforeFail + 1 && oWPart.ok === false && oWPart.written.length === 0 && oWPart.failed.length === 1,
    '子集里那一条写失败:只发那一次写、ok:false 且 written 不夸大(成功/失败口径不因裁剪改变)',
    JSON.stringify([wLog.length - writesBeforeFail, oWPart.ok, oWPart.written, oWPart.failed]))
  ok(oWPart.changed === false && oWPart.invalidated === false,
    '子集一个都没写成 → 不重扫(与整单通道同一条规矩)', JSON.stringify([oWPart.changed, oWPart.invalidated]))
  section('34. 子集执行没有绕过能力闸 / 重入闸 / 换代守卫')
  // ① 能力闸:缺 trash 时,「有勾选」与「空勾选」两条都必须在一个原语都不碰之前短路,且各有原因
  delete global.window.services.movePathsToTrash
  const tC = M.useTools()
  await tC.load()
  const refuseBefore = subLog.length
  const oNoCapEmpty = await tC.applyFix(trashThree('orphans:c1'), [], { isWin: true })
  ok(oNoCapEmpty.ok === false && /选|勾/.test(oNoCapEmpty.message),
    '两道短路的先后没动:空选择在能力闸之前就被拒(先说用户能改的那条原因)', JSON.stringify(oNoCapEmpty.message))
  const oNoCap = await tC.applyFix(trashThree('orphans:c2'), ['project.godot'], { isWin: true })
  ok(oNoCap.ok === false && oNoCap.error === '当前宿主不支持' && subLog.length === refuseBefore,
    '有勾选但宿主缺 trash:照样在调用任何原语之前短路(裁剪不削弱能力闸)', JSON.stringify([oNoCap.error, subLog.length]))

  // ② 重入闸:第一次子集执行卡在 await 上时,第二次带 selected 的调用不许插进来
  const subReleases = []
  const subHoldLog = []
  global.window.services.movePathsToTrash = (pid, rels) => {
    subHoldLog.push(rels.slice())
    return new Promise((resolve) => { subReleases.push(() => resolve({ ok: true, moved: rels.length, failed: [] })) })
  }
  const tSub = M.useTools()
  await tSub.load()
  await tSub.runTool('size')
  const subFirstP = tSub.applyFix(trashThree('orphans:re1'), ['project.godot'], { isWin: true })
  await tick()
  ok(tSub.fixing.value === 'orphans:re1' && subHoldLog.length === 1,
    '前置条件成立:第一次子集执行真的卡在 await 上(与 §30 同一取舍)', `${tSub.fixing.value}|${subHoldLog.length}`)
  const subBlockedP = tSub.applyFix(trashThree('orphans:re2'), ['.godot/imported/a.stex'], { isWin: true })
  const subRaced = await Promise.race([
    subBlockedP.then((o) => ['done', o]),
    new Promise((resolve) => setTimeout(() => resolve(['hang', null]), 30))
  ])
  ok(subRaced[0] === 'done' && subRaced[1].ok === false && /上一次修复还在执行中/.test(subRaced[1].message),
    '带 selected 的第二次调用同样被重入闸挡回', JSON.stringify(subRaced))
  ok(subHoldLog.length === 1, '挡回的一个原语都没调(两份子集同时在改盘就是互相踩)', JSON.stringify(subHoldLog))
  while (subReleases.length) subReleases.shift()()
  const oReFirst = await subFirstP
  ok(tSub.fixResults.value['orphans:re2'] === undefined && oReFirst.ok === true && tSub.fixing.value === '',
    '挡回的不写回执,第一次照常执行完并复位 fixing', JSON.stringify([Object.keys(tSub.fixResults.value), oReFirst.ok, tSub.fixing.value]))

  // ③ 换代守卫:子集执行在途时切项目 → 磁盘确实动了,但那一笔账不进现在这个项目、也不重扫
  const P_A = { _id: 'godot/project/pa', id: 'pa', path: 'E:/pa', name: 'A', favorite: false, openCount: 0, configVersion: 5, lastOpenedAt: 2000 }
  const P_B = { _id: 'godot/project/pb', id: 'pb', path: 'E:/pb', name: 'B', favorite: false, openCount: 0, configVersion: 5, lastOpenedAt: 1000 }
  const bleedLog = []
  global.window.services.movePathsToTrash = (pid, rels) => {
    bleedLog.push(rels.slice())
    return new Promise((resolve) => { subReleases.push(() => resolve({ ok: true, moved: rels.length, failed: [] })) })
  }
  global.window.ztools.db.allDocs = async () => [{ ...P_A }, { ...P_B }]
  const tX = M.useTools()
  await tX.load()
  await tX.runTool('size')
  const bleedP = tX.applyFix(trashThree('orphans:bleed'), ['project.godot'], { isWin: true })
  await tick()
  tX.select('godot/project/pb')
  while (subReleases.length) subReleases.shift()()
  const oBleed = await bleedP
  ok(oBleed.ok === true && oBleed.changed === true && oBleed.invalidated === false,
    '在途子集执行成功后切了项目:磁盘动了(invalidated=false 如实说没重扫)', JSON.stringify([oBleed.ok, oBleed.changed, oBleed.invalidated]))
  ok(tX.fixResults.value['orphans:bleed'] === undefined,
    '上一个项目的修复账不写进当前项目(F-1 的同一口径,selected 不改变它)', JSON.stringify(Object.keys(tX.fixResults.value)))
  ok(bleedLog.length === 1 && bleedLog[0].join(',') === 'project.godot',
    '交给原语的仍然是勾选那一条,与切项目无关', JSON.stringify(bleedLog))
  restore()

  section('35. 不传 selected:与今天的整单执行逐字节一致(向后兼容留给测试与旧调用)')
  const compatLog = []
  const rwCompat = []
  // ⚠ caps 是**构造时快照**(useTools.ts 的 caps 注释),所以两个动盘原语必须在 new useTools()
  //   之前就桩好;先建实例再补桩的话,后面那条改写用例会拿到「当前宿主不支持」而不是执行结果。
  global.window.services.movePathsToTrash = (pid, rels) => {
    compatLog.push(rels.slice())
    return { ok: true, moved: rels.length, failed: [] }
  }
  global.window.services.writeProjectText = (pid, rel, text) => {
    rwCompat.push({ rel, text })
    return { ok: true, backupRel: `${rel}.gpm-bak-x` }
  }
  const tBk = M.useTools()
  await tBk.load()
  await tBk.runTool('size')
  const oLegacy = await tBk.applyFix(trashThree('orphans:legacy'), { isWin: true })
  const oBare = await tBk.applyFix(trashThree('orphans:bare'), undefined, { isWin: true })
  const oNull = await tBk.applyFix(trashThree('orphans:nullish'), null, { isWin: true })
  ok(compatLog.every((r) => r.join(',') === THREE_REL_IDS),
    '★三种「不传 selected」的写法都交出整单三条(裁剪只在显式传数组时发生)', JSON.stringify(compatLog))
  ok(oLegacy.ok === true && oBare.ok === true && oNull.ok === true, '三条调用都执行成功',
    JSON.stringify([oLegacy.ok, oBare.ok, oNull.ok]))
  ok(oNull.verb === '移入回收站' && oLegacy.verb === '移入回收站' && oBare.verb === '移入回收站',
    '第二参是 null/对象时,第三参的 isWin 照常生效(判别只按「是不是数组」,不靠真假)',
    JSON.stringify([oLegacy.verb, oBare.verb, oNull.verb]))
  const strip = (o) => JSON.stringify({ ...o, at: 0, findingId: '' })
  ok(strip(oLegacy) === strip(oBare) && strip(oBare) === strip(oNull),
    '整单回执逐字段相同(时间戳归一后)', `${strip(oLegacy)} vs ${strip(oNull)}`)
  const oRwLegacy = await tBk.applyFix(rewriteThree('format:legacy'), { isWin: true })
  ok(oRwLegacy.written.length === 3 && oRwLegacy.ok === true && rwCompat.length === 3,
    '改写通道的不传 selected 同样整单三条(3 次写 + 3 份备份都在回执里)',
    JSON.stringify([oRwLegacy.written, oRwLegacy.ok, rwCompat.length]))
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
