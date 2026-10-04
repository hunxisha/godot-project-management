// 工具页 B5：未引用资源（孤儿资产）（src/tools/inspectors/orphans.ts）的断言。
//
// ⚠ 这是 P0b 里唯一把「删除按钮」摆到用户自己文件旁边的检查器。spec §6 那句失败模式很直白:
//   用户真会删。所以每条判据的方向都是单向的 —— **宁可少报孤儿,绝不误报**。
//   断言里凡是「不该进 rels」的,都比「该进 rels」的更要紧:那是在挡误删。
//
// 夹具是「内存文件树 + readText 桩」,与 refIndex.test.mjs / uid.test.mjs 同形(extOf / tree / makeCtx)。
// calls 记 readText 问过的 rel —— 判据 1/8 的成本红线全靠它证明 orphans 自己没多读一个文件。
//
// 用法（npm script 会先跑打包步骤）:
//   node src/composables/__tests__/build-bundle.mjs && node src/tools/__tests__/orphans.test.mjs
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

/** ext 推导与原语两端逐字一致（照 refIndex/uid 测试的同一份实现） */
function extOf(rel) {
  const base = rel.slice(rel.lastIndexOf('/') + 1)
  const i = base.lastIndexOf('.')
  return i > 0 ? base.slice(i + 1).toLowerCase() : ''
}
function tree(specs) {
  const base = Date.UTC(2026, 0, 1)
  return specs.map(([rel, size, off = 0]) => ({ rel, size, mtimeMs: base + off * 86400000, ext: extOf(rel) }))
}

/**
 * 内存 ctx 工厂：`fail` 里的 rel 走指定返回形态（不给 text 就是「读不到」），其余只认 texts。
 * calls 记录 readText 被问过的 rel —— 判据 1/8 全靠它。
 */
function makeCtx(specs, { trunc = false, texts = {}, fail = {} } = {}) {
  const calls = []
  const ctx = {
    projectId: 'godot/project/p',
    root: 'E:/proj',
    truncated: trunc,
    tree: tree(specs),
    readText: async (rel) => {
      calls.push(rel)
      if (Object.prototype.hasOwnProperty.call(fail, rel)) return fail[rel]
      return typeof texts[rel] === 'string' ? { text: texts[rel] } : { skipped: true }
    }
  }
  return { ctx, calls }
}

const agg = (fs) => fs.filter((f) => f.id === 'orphans:all')
const degraded = (fs) => fs.filter((f) => f.id === 'orphans:truncated' || f.id === 'orphans:partial')
const relsOf = (f) => (f && f.fix && f.fix.payload && f.fix.payload.rels) || null
const ids = (fs) => fs.map((f) => f.id).join('|')

/** 一份「引用了 used.png」的场景（used 有边车 → 是候选，但被引用，不该进孤儿） */
const SCENE_MAIN = [
  'gd_scene load_steps=2 format=3',
  '',
  '[ext_resource type="Texture2D" path="res://assets/used.png" id="1_u"]',
  '',
  '[node name="Root" type="Node2D"]'
].join('\n')

/** 边车正文里有 source_file="res://assets/solo.png" —— 但边车不是引用来源（B3 判据 2） */
const SOLO_IMPORT = ['[remap]', 'importer="texture"', 'source_file="res://assets/solo.png"'].join('\n')

// ---------- 主图：一个被引用的 used + 一个只被自己 .import 提到的 orphan ----------
const BASE_SPECS = [
  ['project.godot', 400],
  ['scene/main.tscn', 900],
  ['assets/used.png', 8000],
  ['assets/used.png.import', 700],
  ['assets/orphan.png', 5000],
  ['assets/orphan.png.import', 600]
]
const BASE_TEXTS = {
  'project.godot': '[application]\nrun/main_scene="res://scene/main.tscn"\n',
  'scene/main.tscn': SCENE_MAIN,
  'assets/used.png.import': '[remap]\nsource_file="res://assets/used.png"\n',
  'assets/orphan.png.import': '[remap]\nsource_file="res://assets/orphan.png"\n'
}

async function main() {
  // ---------- 0. 接线与形状 ----------
  section('0. 接线与形状')
  ok(typeof T.runOrphans === 'function' && T.runOrphans.length === 1,
    'run(ctx) 已进 barrel，签名与 size/cache/brokenRefs/uid 同形', typeof T.runOrphans)
  const base = await T.runOrphans(makeCtx(BASE_SPECS, { texts: BASE_TEXTS }).ctx)
  ok(Array.isArray(base), 'run 返回数组', typeof base)
  ok(base.every((f) => f.id.startsWith('orphans:')), '每条结论都带 orphans: 前缀', ids(base))
  ok(new Set(base.map((f) => f.id)).size === base.length, '一次运行内 id 互不重复', ids(base))
  const a0 = agg(base)[0]
  ok(!!a0 && a0.severity === 'warn', '★孤儿结论是 warn（Ruling B4：默认 warn，不 error）', a0?.severity)

  // ---------- 1. 判据 2：孤儿 = 候选 ∧ to 里没有 ∧ 无大小写异体 ----------
  section('1. 判据 2：候选集与孤儿定义')
  ok(a0 && relsOf(a0).join('|') === 'assets/orphan.png',
    '★主图：只被自己的 .orphan.png.import 提到 → 照样报孤儿（B3 判据 2 在这里重钉一次）',
    relsOf(a0)?.join('|'))
  ok(a0 && !relsOf(a0).includes('assets/used.png'),
    '★判据 3：被场景 [ext_resource] 引用的图 → 不报孤儿（哪怕它是候选）',
    relsOf(a0)?.join('|'))
  ok(a0 && !relsOf(a0).some((r) => r.endsWith('.import') || r.endsWith('.uid')),
    '判据 3：边车自身永不进 rels（.import/.uid 是 B4/B6 的活）', relsOf(a0)?.join('|'))
  ok(a0 && !relsOf(a0).some((r) => r === 'scene/main.tscn' || r === 'project.godot'),
    '判据 1：场景与 project.godot 永不进候选（动态串/配置）', relsOf(a0)?.join('|'))
  // 候选必须有 <file>.import 边车：一个没边车的孤立 png 不是候选（不是这个工具的猎物）
  const noSidecar = await T.runOrphans(makeCtx([['assets/loose.png', 100]], {}).ctx)
  ok(noSidecar.length === 0, '判据 2：没有 .import 边车的 png 不进候选（工具只判导入资产）', ids(noSidecar))
  // 有边车但边车对应的源不在树里（stale .import）→ 该源不是候选，也不报错（那是 B6）
  const staleImp = await T.runOrphans(makeCtx([['assets/gone.png.import', 100]], {
    texts: { 'assets/gone.png.import': SOLO_IMPORT }
  }).ctx)
  ok(staleImp.length === 0, '判据 2：只有 .import、源 png 不在树里 → 无候选、不误报（stale 归 B6）', ids(staleImp))

  // ★判据 3 最要紧的反面：注释 / 死代码 / 断链 的引用都算引用，绝不报孤儿
  const gdRef = [
    'extends Node',
    '# 旧实现走 preload("res://assets/incomment.png")，留着当线索',
    'const DEAD = "res://assets/deadcode.png"',
    'var runtime = "res://assets/nomain.tscn"  # 拼在别处'
  ].join('\n')
  const commentCtx = makeCtx([
    ['assets/incomment.png', 100], ['assets/incomment.png.import', 40],
    ['assets/deadcode.png', 100], ['assets/deadcode.png.import', 40],
    ['scripts/ref.gd', 200]
  ], { texts: { 'scripts/ref.gd': gdRef } })
  const comment = await T.runOrphans(commentCtx.ctx)
  ok(comment.length === 0,
    '★判据 3：注释里的引用（incomment）与死代码里的引用（deadcode）都算引用 → 一条孤儿都不报',
    ids(comment) + ' / rels=' + JSON.stringify(relsOf(comment[0])))
  // 引用者自己已经断链（它同时引用了一个不存在的文件）→ 被它引用的图仍不算孤儿
  const brokenTscn = [
    'gd_scene load_steps=3 format=3',
    '',
    '[ext_resource type="Texture2D" path="res://assets/kept.png" id="1_k"]',
    '[ext_resource type="Texture2D" path="res://assets/missing.png" id="2_m"]'
  ].join('\n')
  const broken = await T.runOrphans(makeCtx([
    ['scene/broken.tscn', 300], ['assets/kept.png', 100], ['assets/kept.png.import', 40]
  ], { texts: { 'scene/broken.tscn': brokenTscn } }).ctx)
  ok(broken.length === 0,
    '判据 3：引用者自身是断链场景（还引用着不存在的 missing.png）→ kept.png 仍不算孤儿，不越界判引用者对错',
    ids(broken))

  // 判据 2 反面的反面：非导入类文件即使带个畸形同名 .import 也永不进候选（挡 class_name/动态误删）
  const nonCandidates = await T.runOrphans(makeCtx([
    ['scripts/lone.gd', 100], ['scripts/lone.gd.import', 40],
    ['scene/lone.tscn', 100], ['scene/lone.tscn.import', 40],
    ['addons/foo/icon.png', 100], ['addons/foo/icon.png.import', 40],
    ['.godot/imported/cache.png', 100], ['.godot/imported/cache.png.import', 40]
  ], {
    texts: {
      'scripts/lone.gd': 'extends Node\nclass_name Lone\n',
      'scene/lone.tscn': 'gd_scene load_steps=1 format=3',
      'addons/foo/icon.png.import': SOLO_IMPORT
    }
  }).ctx)
  const ncRels = nonCandidates.length ? relsOf(agg(nonCandidates)[0]) : []
  ok(nonCandidates.length === 0 || (ncRels && !ncRels.some((r) =>
    r === 'scripts/lone.gd' || r === 'scene/lone.tscn' ||
    r === 'addons/foo/icon.png' || r === '.godot/imported/cache.png')),
    '★判据 1：.gd/.tscn（按类名/动态串用）、addons/、.godot/ 下的文件永不进候选，即使没人引用且带畸形边车',
    JSON.stringify(ncRels))

  // ---------- 2. 判据 5：大小写异体挡误删 ----------
  section('2. 判据 5：大小写异体')
  const caseTscn = [
    'gd_scene load_steps=2 format=3',
    '',
    '[ext_resource type="Texture2D" path="res://UI/Banner.PNG" id="1_b"]'
  ].join('\n')
  const caseRun = await T.runOrphans(makeCtx([
    ['ui/banner.png', 4000], ['ui/banner.png.import', 200], ['scene/refs.tscn', 300]
  ], { texts: { 'scene/refs.tscn': caseTscn } }).ctx)
  ok(caseRun.length === 0,
    '★判据 5：引用写 res://UI/Banner.PNG 而候选是 ui/banner.png（Windows 同一文件）→ 不判孤儿',
    ids(caseRun))
  // 反面控制：同样的图但没人引用 → 应当报孤儿（证明上一条是「大小写异体那一挡」藏住了它，不是恒不报）
  const caseCtrl = await T.runOrphans(makeCtx([
    ['ui/banner.png', 4000], ['ui/banner.png.import', 200],
    ['scene/other.tscn', 300]
  ], { texts: { 'scene/other.tscn': 'gd_scene load_steps=1 format=3\n[node name="R" type="Node2D"]' } }).ctx)
  ok(agg(caseCtrl).length === 1 && relsOf(agg(caseCtrl)[0]).join('|') === 'ui/banner.png',
    '判据 5 控制组：同图无人引用 → 仍报孤儿（上一条的「不报」确实来自异体闸，不是工具恒不报）',
    relsOf(agg(caseCtrl)[0])?.join('|'))
  // ★方向断言（B6 Fix round 1 裁定 2 钉的那条）：小写像用在「**是否被引用**」这一侧只会藏孤儿；
  // 「这个资产有没有边车」（进不进候选集）那一侧**故意保持精确匹配** —— 放宽它会把候选集做大，
  // 于是能凭空多出一条带删除按钮的主张，那不在「只藏不加」的授权范围内（orphans.ts:106-107 的旧注释就是这条）。
  const caseSidecar = await T.runOrphans(makeCtx([
    ['UI/Banner.PNG', 4000], ['ui/banner.png.import', 200],
    ['scene/other.tscn', 300]
  ], { texts: { 'scene/other.tscn': 'gd_scene load_steps=1 format=3\n[node name="R" type="Node2D"]' } }).ctx)
  ok(caseSidecar.length === 0,
    '★单调方向：资产写成 UI/Banner.PNG 而边车是 ui/banner.png.import → 精确匹配认不出边车 → 不进候选 → 一条不报',
    ids(caseSidecar))
  const caseSidecarCtrl = await T.runOrphans(makeCtx([
    ['UI/Banner.PNG', 4000], ['UI/Banner.PNG.import', 200],
    ['scene/other.tscn', 300]
  ], { texts: { 'scene/other.tscn': 'gd_scene load_steps=1 format=3\n[node name="R" type="Node2D"]' } }).ctx)
  ok(relsOf(agg(caseSidecarCtrl)[0])?.join('|') === 'UI/Banner.PNG',
    '★控制组：边车与原样写法对上时就进候选并报孤儿(上一条的静默来自候选侧的精确匹配,不是恒不报)',
    relsOf(agg(caseSidecarCtrl)[0])?.join('|'))
  // 引用比对那一侧走 treeUtils.lowerSet(裁定 2 里 orphans 要adopt的那一行)：
  // 上面 caseRun 已经把「异体引用藏孤儿」钉住了，这里再钉一次「同一条小写像来自 to 的全部键」。
  const refImage = await T.runOrphans(makeCtx([
    ['a/b/x.png', 100], ['a/b/x.png.import', 100], ['a/b/other.png', 100], ['a/b/other.png.import', 100],
    ['scene/r.tscn', 300]
  ], {
    texts: { 'scene/r.tscn': 'gd_scene load_steps=2 format=3\n[ext_resource type="Texture2D" path="res://A/B/X.PNG" id="1"]' }
  }).ctx)
  ok(relsOf(agg(refImage)[0])?.join('|') === 'a/b/other.png',
    'lowerSet 收的是整份 to 键的小写像:异体引用只藏它自己那条,别处的候选照常报(不许把集合建歪成恒真)',
    relsOf(agg(refImage)[0])?.join('|'))
  // 上一条的候选是小写名，所以 `refLower.has(rel)` 与 `hasRelCI(refLower, rel)` 无从区分（变异 OP1 实测零红 =
  // 等价变异，不是判据挂空）。这条把**候选自己**写成大写名：只有走 hasRelCI 才藏得住，精确查表就会报孤儿。
  const refImageUpper = await T.runOrphans(makeCtx([
    ['UI/Banner.PNG', 100], ['UI/Banner.PNG.import', 100], ['scene/r.tscn', 300]
  ], {
    texts: { 'scene/r.tscn': 'gd_scene load_steps=2 format=3\n[ext_resource type="Texture2D" path="res://ui/banner.png" id="1"]' }
  }).ctx)
  ok(refImageUpper.length === 0,
    '★候选写 UI/Banner.PNG 而引用写 res://ui/banner.png：比对必须走 hasRelCI(小写像)，精确查表会误报一条能删的孤儿',
    ids(refImageUpper))

  // ---------- 3. 判据 4：truncated / partial 一条都不报 ----------
  section('3. 判据 4：降级闸门')
  const trCtx = makeCtx(BASE_SPECS, { trunc: true, texts: BASE_TEXTS })
  const tr = await T.runOrphans(trCtx.ctx)
  ok(agg(tr).length === 0 && degraded(tr).length === 1,
    'ctx.truncated → 一条孤儿都不报，只发一条降级结论', ids(tr))
  ok(degraded(tr)[0].id === 'orphans:truncated' && degraded(tr)[0].severity === 'warn' &&
    /截断/.test(degraded(tr)[0].title),
    '截断降级：id 或phans:truncated、warn、标题说「截断」', `${degraded(tr)[0]?.id}/${degraded(tr)[0]?.title}`)
  ok(trCtx.calls.length === 0,
    '判据 4+8：截断时一次 readText 都不发（buildRefIndex 短路，orphans 自己也不读）', trCtx.calls.length)
  // 某引用者（.gd）读不到 → partial 为真 → 整条判据 4 直接不报（链条要钉住）
  const partialCtx = makeCtx([
    ['assets/orphan.png', 5000], ['assets/orphan.png.import', 600], ['scripts/ref.gd', 300]
  ], { texts: { 'scripts/ref.gd': gdRef }, fail: { 'scripts/ref.gd': { skipped: true } } })
  const partial = await T.runOrphans(partialCtx.ctx)
  ok(agg(partial).length === 0 && degraded(partial).length === 1,
    '★判据 4：引用者读不到 → RefIndex.partial → 一条孤儿都不报（否则读丢的那条引用会让有主的东西被误删）',
    ids(partial))
  ok(degraded(partial)[0].id === 'orphans:partial' && degraded(partial)[0].detail.includes('scripts/ref.gd'),
    'partial 降级：id 与 truncated 分开（两种情形安全动作不同），detail 点名读不到的来源',
    `${degraded(partial)[0]?.id}/${degraded(partial)[0]?.detail}`)
  // 简报「没有 fix 的结论一个都不发」的字面读法:两条降级结论都不许带删除入口。
  ok(!degraded(tr)[0].fix && !degraded(partial)[0].fix,
    '判据 4：截断与 partial 两条降级结论都不带 fix(降级态不许有删除按钮)',
    `${JSON.stringify(degraded(tr)[0]?.fix)}/${JSON.stringify(degraded(partial)[0]?.fix)}`)
  // 候选自己的 .import 读不到 → 不影响判定（.import 不是引用来源，根本不会被读）
  const impFail = makeCtx([['assets/solo.png', 5000], ['assets/solo.png.import', 600]], {
    texts: { 'assets/solo.png.import': SOLO_IMPORT }, fail: { 'assets/solo.png.import': { skipped: true } }
  })
  const impRun = await T.runOrphans(impFail.ctx)
  ok(agg(impRun).length === 1 && relsOf(agg(impRun)[0]).includes('assets/solo.png'),
    '判据 4：候选读不到 .import 不影响判定（边车不是来源，partial 不为它翻真）', ids(impRun))
  ok(!impFail.calls.includes('assets/solo.png.import') && !impFail.calls.includes('assets/solo.png'),
    '判据 4：.import 与 png 都不是来源，一个字都不读', impFail.calls.join('|'))

  // ---------- 4. 判据 1+8：成本红线 —— orphans 自己没有多读任何文件 ----------
  section('4. 判据 1+8：引用来源只用 buildRefIndex')
  const c1 = makeCtx(BASE_SPECS, { texts: BASE_TEXTS })
  await T.buildRefIndex(c1.ctx)
  const c2 = makeCtx(BASE_SPECS, { texts: BASE_TEXTS })
  await T.runOrphans(c2.ctx)
  ok(JSON.stringify(c1.calls) === JSON.stringify(c2.calls),
    '★判据 1/8：run 触发的 readText 与单独 buildRefIndex 逐次相同（orphans 只多一趟纯计算，不多读一个文件）',
    `${JSON.stringify(c1.calls)} vs ${JSON.stringify(c2.calls)}`)
  ok(!c2.calls.some((r) => r.endsWith('.png') || r.endsWith('.import') || r.endsWith('.uid')),
    '判据 1：不读 png/边车（引用来源只有白名单文本文件）', c2.calls.join('|'))

  // ---------- 5. 判据 6：id 稳定与确定性 ----------
  section('5. 判据 6：id 稳定与确定性')
  const DET_SPECS = [
    ['assets/a.png', 10], ['assets/a.png.import', 5],
    ['assets/m.png', 10], ['assets/m.png.import', 5],
    ['assets/z.png', 10], ['assets/z.png.import', 5],
    ['scene/x.tscn', 300]
  ]
  const DET_TEXTS = { 'scene/x.tscn': 'gd_scene\n[ext_resource type="Texture2D" path="res://assets/a.png" id="1"]' }
  const r1 = await T.runOrphans(makeCtx(DET_SPECS, { texts: DET_TEXTS }).ctx)
  const r2 = await T.runOrphans(makeCtx(DET_SPECS, { texts: DET_TEXTS }).ctx)
  const rRev = await T.runOrphans(makeCtx([...DET_SPECS].reverse(), { texts: DET_TEXTS }).ctx)
  const mix = [DET_SPECS[4], DET_SPECS[0], DET_SPECS[5], DET_SPECS[2], DET_SPECS[6], DET_SPECS[1], DET_SPECS[3]]
  const rMix = await T.runOrphans(makeCtx(mix, { texts: DET_TEXTS }).ctx)
  const dump = (fs) => JSON.stringify(fs)
  ok(agg(r1).length === 1 && relsOf(agg(r1)[0]).join('|') === 'assets/m.png|assets/z.png',
    '判据 6：a 被引用、m/z 孤儿；rels 按码元序（不跟 tree 顺序）', relsOf(agg(r1)[0])?.join('|'))
  ok(dump(r1) === dump(r2), '判据 6：同一份清单两次运行 findings 逐字节一致', `${r1.length}/${r2.length}`)
  ok(dump(r1) === dump(rRev), '判据 6：文件顺序反序后逐字节一致', `${ids(r1)} vs ${ids(rRev)}`)
  ok(dump(r1) === dump(rMix), '判据 6：任意交错顺序同样一致（结论不靠 tree 下标）', ids(rMix))
  ok(agg(r1)[0].id === 'orphans:all', '判据 6：聚合 id 是常量键 orphans:all，不带数量/下标/时间戳', agg(r1)[0].id)
  ok(!/[0-9]{6,}|null/.test(agg(r1)[0].id), '判据 6：id 里没有数字串/null', agg(r1)[0].id)

  // ---------- 6. 判据 5：聚合 detail 与 B1 对接 ----------
  section('6. 判据 5：detail 计数/体积/裁切 与 planFix 全量预览')
  const manySpecs = []
  const manyTexts = { 'project.godot': '[application]\n' }
  for (let i = 0; i < 40; i++) {
    const n = String(i).padStart(2, '0')
    manySpecs.push([`assets/tex/o${n}.png`, 1000 + i])
    manySpecs.push([`assets/tex/o${n}.png.import`, 50])
  }
  const manyCtx = makeCtx(manySpecs, { texts: manyTexts })
  const many = await T.runOrphans(manyCtx.ctx)
  const ma = agg(many)[0]
  ok(many.length === 1 && ma && relsOf(ma).length === 40,
    '判据 5：40 个孤儿仍只 1 条结论，payload.rels 含全部 40 个', `${many.length}/${relsOf(ma)?.length}`)
  ok(ma && ma.title.includes('40'), '判据 5：标题点名总数 40', ma?.title)
  ok(ma && ma.detail.includes('40') && ma.detail.includes('另有 20 个未列出'),
    '判据 5：detail 说总数 40 且「另有 40-20=20 个未列出」', ma?.detail)
  ok(ma && ma.related.length === 20 && ma.related.join('|') === relsOf(ma).slice(0, 20).join('|'),
    '判据 5：related/清单只列前 20（LIST_CAP 式阈值），且就是码元序前 20', `${ma?.related?.length}`)
  ok(ma && ma.detail.includes(ma.related[19]) && !ma.detail.includes(relsOf(ma)[20]),
    '判据 5：detail 列到第 20 个、不点名第 21 个（裁切只裁展示不裁账）',
    `${ma?.related?.[19]} / ${relsOf(ma)?.[20]}`)
  // 总体积 = Σ(1000+i) i=0..39 = 40000 + (0+39)*40/2 = 40000+780 = 40780 B
  ok(ma && ma.detail.includes(T.fmtBytes(40780)),
    '判据 5：detail 的总体积用 fmtBytes，只算真孤儿（=40780B）', `${ma?.detail?.match(/合计[^：]*/)?.[0]}`)
  ok(ma && JSON.stringify(Object.keys(ma.fix).sort()) === '["kind","label","payload"]',
    '判据 3：fix 只带 kind/label/payload（动词/风险句/预览清单归 fixPlan.ts）',
    JSON.stringify(ma?.fix && Object.keys(ma.fix)))
  ok(ma && /移除 40 个/.test(ma.fix.label) && !/回收站|永久删除|备份|还原/.test(ma.fix.label),
    '判据 3：label 给数量、用中性动词「移除」，不写平台措辞', ma?.fix?.label)
  // ★真过 planFix：预览清单全量 = rels，展示裁切不裁确认框（spec §5.3 规则 3）
  const planWin = T.planFix(ma, tree(manySpecs), true)
  ok(planWin.items.length === relsOf(ma).length && planWin.items.length === 40 && planWin.empty === false,
    '★B1 对接：planFix 从 payload.rels 建 items → 40 全量，detail 的「另有 20」与清单全量不矛盾',
    `${planWin.items.length}/${relsOf(ma).length}`)
  ok(planWin.service === 'movePathsToTrash' && planWin.verb === '移入回收站',
    'B1 对接：可执行性与动词由 planFix 给（检查器没说一句话）', `${planWin.service}/${planWin.verb}`)
  const planMac = T.planFix(ma, tree(manySpecs), false)
  ok(planMac.verb === '永久删除' && planMac.warn.includes('永久删除'),
    'B1 对接：同一条 finding 在非 Windows 自动换措辞（证明措辞真的没写在检查器里）', planMac.verb)

  // ---------- 7. 判据 3：默认排除计数写进 detail ----------
  section('7. 判据 3：默认排除清单计数进 detail')
  const exSpecs = [
    ['project.godot', 400],
    ['.godot/imported/x.ctex', 900], ['.godot/imported/y.ctex', 900], ['.godot/imported/z.ctex', 900],
    ['addons/foo/a.png', 10], ['addons/foo/b.png', 10], ['addons/other.png', 10],
    ['assets/only.png', 100], ['assets/only.png.import', 50],
    ['keep.uid', 30]
  ]
  const exRun = await T.runOrphans(makeCtx(exSpecs, { texts: { 'project.godot': '[application]\n' } }).ctx)
  const exa = agg(exRun)[0]
  ok(exa && relsOf(exa).join('|') === 'assets/only.png',
    '判据 3：非排除区里唯一的导入资产是孤儿', relsOf(exa)?.join('|'))
  ok(exa && /\.godot 缓存 3 项/.test(exa.detail) && /addons 3 项/.test(exa.detail) &&
    /\.import\/\.uid 边车 2 项/.test(exa.detail) && /project\.godot 1 项/.test(exa.detail),
    '判据 3：四类默认排除（.godot/addons/边车/project.godot）的计数逐一写进 detail', exa?.detail)

  // ---------- 8. 判据 6：静态分析边界必须出现在 detail ----------
  section('8. 判据 6：静态分析 / 动态加载无法判定的措辞')
  ok(exa && exa.detail.includes('静态分析') && exa.detail.includes('ResourceLoader') &&
    exa.detail.includes('拼接路径'),
    '判据 6（spec §6 原话含义）：detail 明示静态分析 + 拼接路径/ResourceLoader 动态加载无法判定', exa?.detail)
  // 评审 Important:引擎还有一条 uid:// 引用通道,而本判定只按 res:// 匹配。
  // 标题若说「索引一次都没提到」就是在替一条没走过的通道打包票 —— 标题限缩到 res://,detail 明说盲区。
  ok(exa && exa.title.includes('res:// 引用索引'),
    '判据 6：标题限缩成「res:// 引用索引」,不替 uid 通道背书', exa?.title)
  ok(exa && /uid:\/\//.test(exa.detail) && exa.detail.includes('只用 uid 引用'),
    '判据 6：detail 明说 uid:// 是已知盲区(只用 uid 的资源会被算成未引用),删除前自己确认', exa?.detail)
  ok(!exa || exa.detail.indexOf('等 ') === -1,
    '判据 6：裁切句不再重复报总数(「等」+ 计数两句说的是同一件事,留一处)', exa?.detail)

  // ---------- 9. 判据 7：不产生「空孤儿」噪音 ----------
  section('9. 判据 7：零噪音')
  const zeroCand = await T.runOrphans(makeCtx([['README.md', 10], ['scripts/x.gd', 10]], {
    texts: { 'scripts/x.gd': 'extends Node' }
  }).ctx)
  ok(Array.isArray(zeroCand) && zeroCand.length === 0,
    '判据 7：一个候选都没有 → 0 条结论（不是「未发现孤儿」的 info）', ids(zeroCand))
  const allRef = await T.runOrphans(makeCtx([
    ['scene/s.tscn', 300], ['assets/u.png', 100], ['assets/u.png.import', 40]
  ], { texts: { 'scene/s.tscn': 'gd_scene\n[ext_resource path="res://assets/u.png" id="1"]' } }).ctx)
  ok(allRef.length === 0,
    '判据 7：候选全被引用 → 0 条结论（「跑了但没得删」交给 outcomeOf）', ids(allRef))
  ok(!allRef.some((f) => f.severity === 'info') && !zeroCand.some((f) => f.severity === 'info'),
    '判据 7：两种「无事发生」都不发 info（不在这里重复 outcomeOf 的活）', ids(zeroCand) + '/' + ids(allRef))
  const empty = await T.runOrphans(makeCtx([]).ctx)
  ok(Array.isArray(empty) && empty.length === 0, '判据 7：空清单 → 空数组', ids(empty))
}

main().catch((e) => {
  console.error(`\n测试脚本抛错: ${e && e.stack ? e.stack : e}`)
  process.exit(1)
}).then(() => {
  console.log(`\n${'='.repeat(56)}\nPASS ${pass}  FAIL ${failures.length}`)
  if (failures.length) { console.log('失败项:'); for (const f of failures) console.log('  - ' + f); process.exit(1) }
  console.log('全部通过')
})
