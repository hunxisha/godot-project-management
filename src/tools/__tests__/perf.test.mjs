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
//   6. (B6) 在同一份真夹具上用同一个 ctx 直测 runImports —— 它**只**读 .import 边车(不调 buildRefIndex),
//      成本面与 5 正交:边车数量 × 单次读文本 × 一份完整 4.x 正文的解析。边车正文是**真形状**(含 [deps]
//      与 [params]),并且 1/10 的 source_file 指向已不存在的名字,于是失效分类、聚合 rels 排序、二十行
//      detail 模板都被计时(Fix round 1 Important 2 咬的就是上一轮那份 27 字节存根:findings=0,判定路径
//      一次没走)。png/gd/tscn 全在 KNOWN_IMPORTERS 的**表外**,不匹配与缺边车两条模板在这份配比里打不到,
//      所以在 B5 计时之后另补 200 份 `.ogg` 边车(importer 写 wav → 不匹配)与 60 份无边车的 `.ttf`
//      (目录里唯一 → 缺边车),重扫后再跑一趟**全判据**计时。两段各给护栏;
//   7. (B9) 把同一份夹具里的 .gd 正文换成**真实形状的脏脚本**(尾随空白 + 三连空行 + 未闭合括号的对齐行 +
//      一个 `"""` 块;每 7 份给一份 CRLF 版),每 5 份留 1 份干净脚本作反向对照,然后直测 runFormat ——
//      它只读 .gd 全文(不调 buildRefIndex、不读边车),计时的是「逐行状态扫描 + 整份新文本拼装」。
//      硬自查三条:改写清单数量 == 埋进去的脏脚本数、每一份新文本与盘上原文逐字节不同、干净脚本一份都不漏进清单。
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

let TOUCHED = 0
/** 往夹具根里写一个真文件(建夹具与 B6 的补路批次共用同一份落盘口径,顺便统一计数) */
function touch(rel, content) {
  const abs = path.join(WORK, ...rel.split('/'))
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
  TOUCHED++
}

function buildFixture() {
  const c = counts(N)
  const PNG_BUF = Buffer.from('89504e470d0a1a0a-stub'.repeat(24), 'hex')
  TOUCHED = 0
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
  return { total: TOUCHED, c }
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
  // ⚠ 边车正文必须是**完整 4.x 形状**(B6 评审 Fix round 1 Important 2:上一轮这里是一条 27 字节的存根,
  // 没有 [deps] ⇒ 每份都落进 noSource 分支,findings=0/staleRels=0,于是失效清单的构建、聚合 detail 的
  // 二十行模板、不匹配那条判定**一次都没被计时**,而 parse 成本被低估了一个量级)。
  // 这里照编辑器真实写出的段落排:[remap](importer/type/uid/path/metadata)+[deps](source_file/dest_files)
  // +[params](真实选项块)。type 与 params 按导入器分形,否则「一份正文打天下」本身就是不真实。
  const PARAMS = {
    texture: [
      'compress/mode=0', 'compress/high_quality=false', 'compress/lossy_quality=0.7',
      'compress/hdr_compression=1', 'compress/normal_map=0', 'channel_pack/repack=false',
      'mipmaps/generate=false', 'mipmaps/limit=-1', 'process/fix_alpha_border=true',
      'process/premult_alpha=false', 'process/normal_map_invert_y=false', 'process/hdr_as_srgb=false',
      'process/hdr_clamp_exposure=false', 'process/size_limit=0', 'detect_3d/compress_to=1'
    ],
    wav: [
      'force_max/{sample_rate}=0', 'compress/mode=0', 'compress/multiple_of_zero=1',
      'edit/normalize=false', 'edit/loop_mode=0', 'edit/loop_begin=0', 'edit/loop_end=-1',
      'edit/loop_use_default=false', 'threshold/peak_denoise_db=0.0', 'threshold/silence_start_db=0.0'
    ],
    font_data_dynamic: [
      'antialiasing=1', 'generate_mipmaps=false', 'multichannel_signed_distance_field=false',
      'force_system_hint=0', 'rendering_mode=0', 'size=16', 'oversampling=6.0', 'fallbacks=[]'
    ]
  }
  const sidecarBody = (sourceRel, importer = 'texture', type = 'CompressedTexture2D', dest = 'x-3f2a1b.ctex') => [
    '[remap]',
    '',
    `importer="${importer}"`,
    `type="${type}"`,
    'uid="uid://bh8y2vkq1n2f4"',
    `path="res://.godot/imported/${dest}"`,
    'metadata={',
    '"vram_texture": false',
    '}',
    '',
    '[deps]',
    '',
    `source_file="${sourceRel}"`,
    `dest_files=["res://.godot/imported/${dest}"]`,
    '',
    '[params]',
    '',
    ...(PARAMS[importer] || PARAMS.texture)
  ].join('\n')
  let staleSide = 0
  for (let i = 0; i < fc.png; i++) {
    const dir = `assets/tex${Math.floor(i / 100)}`
    const rel = `${dir}/img${i % 100}.png`
    // 每 10 份里挑 1 份把 source_file 指向一个**不存在**的名字:这就是「删了源没删边车」的真实残留形状,
    // 让 runImports 真的走一遍失效分类 + 聚合 rels 排序 + 二十行 detail 模板(而不是全部落进 noSource)。
    const gone = i % 10 === 3
    if (gone) staleSide++
    const abs = path.join(WORK, ...`${rel}.import`.split('/'))
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, sidecarBody(gone ? `res://${dir}/gone${i}.png` : `res://${rel}`))
  }
  const sidecarBytes = Buffer.byteLength(sidecarBody('res://x'))
  console.log(`[imports 夹具] sidecarBodyBytes=${sidecarBytes} staleSidecars=${staleSide}`)
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

  // ---------- B6:runImports 直测(同样不走 registry) ----------
  // imports 的成本面与 orphans 正交:它**只读** `.import` 边车(不调 buildRefIndex),上面那份夹具刚好
  // 给每张 png 都补了边车 ⇒ 6000 次真读文本。这里复用同一个 orphanCtx(readText 仍不接 LRU),
  // 量到的是「边车数量 × 单次读」的线性上界 —— 哪天它变成两趟读或去调引用索引,这个数就会飞。
  const im0 = performance.now()
  const importFindings = await TB.runImports(orphanCtx)
  const importsMs = performance.now() - im0
  const staleAgg = importFindings.find((f) => f.id === 'imports:stale:all')
  const staleRels = staleAgg && staleAgg.fix && staleAgg.fix.payload ? staleAgg.fix.payload.rels.length : 0
  console.log(`[imports 直测] 与 B5 同一棵树: entries=${orphanCtx.tree.length} sidecars=${fc.png} ` +
    `bodyBytes=${sidecarBytes} findings=${importFindings.length} staleRels=${staleRels}`)
  console.log(`[imports 直测] runImportsMs=${importsMs.toFixed(1)}`)
  // 同样是护栏而不是 §7 的 <10s 验收(那条要等 B10 在真宿主、含 LRU 与全局调度时量)。
  const GUARD_IMPORTS_MS = 30000
  const importsGuard = importsMs <= GUARD_IMPORTS_MS
  console.log(`[imports 直测] guard=${GUARD_IMPORTS_MS}ms(护栏) verdict=${importsGuard ? 'PASS' : 'FAIL'}`)
  if (!importsGuard) exitCode = 1
  // 上一轮的教训就是这里没自查:27 字节的假边车让 staleRels=0 也照样「绿」,于是要判的东西一条没判、
  // 时间却量得挺好看。stale 这条路径(分类 + 600 条排序 + 聚合 detail 模板)必须真被踩到才算数。
  if (staleRels !== staleSide) {
    console.error(`[imports 直测] 失效判定路径没被踩到:staleRels=${staleRels}(夹具里埋了 ${staleSide} 份)`)
    exitCode = 1
  }

  // ---------- B6 之二:把 png 打不到的两条判定路径也计上时(评审 Fix round 1 Important 2) ----------
  // 上面那一趟虽然读的是完整正文,但 Task-16 的配比只有 png/gd/tscn —— 全是 KNOWN_IMPORTERS **表外**扩展名,
  // 于是「导入器不匹配」与「缺 .import 边车」两条模板一次都没被构造(表外扩展名既不报不匹配也不报缺失,
  // 这是判据本身的收窄,不是夹具的疏漏)。所以这里在 B5 已经测完之后,再补两小批真文件:
  //   · assets/mis/*.ogg + 自称 importer="wav" 的边车 → 200 条不匹配结论(逐条一张卡,模板最贵的那条);
  //   · assets/solo{k}/f.ttf(表内扩展名、目录里唯一、没有边车)→ 60 条缺边车结论(空集真空那条分支)。
  // 补在 B5 之后是刻意的:B5 那两个数仍落在与上一轮**同一份**树上,可直接对比(本轮的断言是
  // 「正文变长不许动 orphans 的计时」,refIndex.ts:121-128 把 .import 排除在来源之外、runOrphans 只看 ext)。
  const MIS = 200
  const SOLO = 60
  for (let i = 0; i < MIS; i++) {
    const rel = `assets/mis/e${i}.ogg`
    touch(rel, Buffer.from('OggSfake-stub'.repeat(40)))
    touch(`${rel}.import`, sidecarBody(`res://${rel}`, 'wav', 'AudioStreamWAV', `e${i}-9f8e7d.oggvorbisstr`))
  }
  for (let k = 0; k < SOLO; k++) touch(`assets/solo/s${k}/f.ttf`, Buffer.from('OTTOfake-stub'.repeat(30)))
  const scan3 = F.scanProjectTree(DOC._id, { includeCache: true })
  if (!scan3.ok) throw new Error(`全判据路径夹具重扫失败: ${scan3.error}`)
  const allCtx = {
    projectId: DOC._id, root: WORK, tree: scan3.files, truncated: scan3.truncated === true,
    readText: async (rel) => {
      const rr = F.readProjectText(DOC._id, rel)
      return rr.ok && typeof rr.text === 'string' ? { text: rr.text } : { skipped: true }
    }
  }
  const ia0 = performance.now()
  const allFindings = await TB.runImports(allCtx)
  const allMs = performance.now() - ia0
  const allStale = allFindings.find((f) => f.id === 'imports:stale:all')
  const allStaleRels = allStale && allStale.fix && allStale.fix.payload ? allStale.fix.payload.rels.length : 0
  const mmCount = allFindings.filter((f) => f.id.startsWith('imports:mismatch:')).length
  const missCount = allFindings.filter((f) => f.id.startsWith('imports:missing:')).length
  console.log(`[imports 全判据] entries=${allCtx.tree.length} sidecars=${fc.png + MIS} staleRels=${allStaleRels} ` +
    `mismatchFindings=${mmCount} missingFindings=${missCount} findings=${allFindings.length}`)
  console.log(`[imports 全判据] runImportsMs=${allMs.toFixed(1)}`)
  const allGuard = allMs <= GUARD_IMPORTS_MS
  console.log(`[imports 全判据] guard=${GUARD_IMPORTS_MS}ms(护栏) verdict=${allGuard ? 'PASS' : 'FAIL'}`)
  if (!allGuard) exitCode = 1
  if (mmCount !== MIS || missCount !== SOLO) {
    console.error(`[imports 全判据] 判定路径没被踩到:mismatch=${mmCount}(want ${MIS}) missing=${missCount}(want ${SOLO})`)
    exitCode = 1
  }
  // ---------- B9:runFormat 直测(同样不走 registry)----------
  // format 的读入面与 B5/B6 正交:它**只读** .gd 全文(不调 buildRefIndex、不读边车),成本大头是
  // 「每份 .gd 一次逐行状态扫描 + 一次整份新文本拼装」。上面那份 .gd 夹具是 20 字节的 'extends Node\n',
  // 干净文本走不到任何一条改写路径( files.length=0 )—— 那正是 B6 评审 Fix round 1 Important 2 咬过的
  // 「零判定计时」。所以这里把 .gd 正文换成**真实形状**的脏脚本(尾随空白 + 空行段 + 未闭合括号 +
  // 一个 """ 块),每 5 份里 1 份保持干净(反向对照:干净的必须一条都不产),另每 7 份给一份 CRLF 版
  // (换行符统一那条也要被计时)。
  const GD_DIRTY = [
    'extends Node',
    '# 顶部注释   ',
    '',
    '@export var speed := 1.0   ',
    '',
    '',
    '',
    'func _ready() -> void:',
    '\tvar doc := """',
    '\t\t多行字符串里的尾随空白   ',
    '',
    '\t"""',
    '\tvar pts = [',
    '\t\tVector2(1, 2),',
    '\t\tVector2(3, 4)   ',
    '\t]',
    '\tprint(doc)',
    '\treturn speed \\'
  ]
  const GD_CLEAN_TXT = 'extends Node\n\nfunc _ready() -> void:\n\tprint(1)\n'
  let dirtyGd = 0
  const cleanGd = new Set()
  let crlfGd = 0
  for (let i = 0; i < fc.gd; i++) {
    const rel = `scripts/mod${Math.floor(i / 100)}/s${i % 100}.gd`
    const abs = path.join(WORK, ...rel.split('/'))
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    if (i % 5 === 2) {
      fs.writeFileSync(abs, GD_CLEAN_TXT)
      cleanGd.add(rel)
      continue
    }
    let body = GD_DIRTY.join('\n') + '\n'
    if (i % 7 === 3) {
      body = body.replace(/\n/g, '\r\n')
      crlfGd++
    }
    fs.writeFileSync(abs, body)
    dirtyGd++
  }
  console.log(`[format 夹具] gdTotal=${fc.gd} dirty=${dirtyGd} clean=${cleanGd.size} crlf=${crlfGd} ` +
    `dirtyBytes=${Buffer.byteLength(GD_DIRTY.join('\n') + '\n')}`)
  const scan4 = F.scanProjectTree(DOC._id, { includeCache: true })
  if (!scan4.ok) throw new Error(`格式化夹具重扫失败: ${scan4.error}`)
  const fmtCtx = {
    projectId: DOC._id, root: WORK, tree: scan4.files, truncated: scan4.truncated === true,
    readText: async (rel) => {
      const rr = F.readProjectText(DOC._id, rel)
      return rr.ok && typeof rr.text === 'string' ? { text: rr.text } : { skipped: true }
    }
  }
  const fmt0 = performance.now()
  const fmtFindings = await TB.runFormat(fmtCtx)
  const fmtMs = performance.now() - fmt0
  const fmtAgg = fmtFindings.find((f) => f.id === 'format:all')
  const fmtFiles = fmtAgg && fmtAgg.fix && fmtAgg.fix.payload ? fmtAgg.fix.payload.files : []
  // 硬自查(B6 的教训):零判定的计时没有意义。三条都要过 ——
  //   ① 真的产出了改写清单,且数量 == 埋进去的脏脚本数;
  //   ② 每一份新文本与盘上原文**逐字节不同**(不是把原文回填);
  //   ③ 干净的那批一份都没进清单(否则①的相等只是「全都改」的假象)。
  let fmtRewritten = 0
  let fmtMissing = 0
  for (const f of fmtFiles) {
    const abs = path.join(WORK, ...f.rel.split('/'))
    if (!fs.existsSync(abs)) { fmtMissing++; continue }
    if (fs.readFileSync(abs, 'utf8') !== f.text) fmtRewritten++
  }
  console.log(`[format 直测] entries=${fmtCtx.tree.length} truncated=${fmtCtx.truncated} ` +
    `findings=${fmtFindings.length} files=${fmtFiles.length} 非恒等新文本=${fmtRewritten}`)
  console.log(`[format 直测] runFormatMs=${fmtMs.toFixed(1)}`)
  const GUARD_FORMAT_MS = 30000
  const fmtGuard = fmtMs <= GUARD_FORMAT_MS
  console.log(`[format 直测] guard=${GUARD_FORMAT_MS}ms(护栏) verdict=${fmtGuard ? 'PASS' : 'FAIL'}`)
  if (!fmtGuard) exitCode = 1
  if (fmtMissing > 0) {
    console.error(`[format 直测] 改写清单里有 ${fmtMissing} 个 rel 不在盘上(rel 必须来自 ctx.tree)`)
    exitCode = 1
  }
  if (fmtFiles.length !== dirtyGd || fmtRewritten !== dirtyGd) {
    console.error(`[format 直测] 改写路径没被踩到:files=${fmtFiles.length} 非恒等=${fmtRewritten}(夹具里埋了 ${dirtyGd} 份脏脚本)`)
    exitCode = 1
  }
  const cleanLeaked = fmtFiles.filter((f) => cleanGd.has(f.rel))
  if (cleanLeaked.length > 0) {
    console.error(`[format 直测] 干净脚本被拖进改写清单:${cleanLeaked.map((f) => f.rel).slice(0, 3).join('、')}`)
    exitCode = 1
  }
  console.log(`[format 直测] 自查 files=${fmtFiles.length}/${dirtyGd} 非恒等=${fmtRewritten}/${dirtyGd} ` +
    `干净泄漏=${cleanLeaked.length}(want 0) verdict=${fmtFiles.length === dirtyGd && fmtRewritten === dirtyGd && cleanLeaked.length === 0 ? 'PASS' : 'FAIL'}`)
} catch (e) {
  console.error(`perf harness 抛错: ${e && e.stack ? e.stack : e}`)
  exitCode = 1
} finally {
  if (!cleanup() && exitCode === 0) exitCode = 1
  process.exit(exitCode)
}
