// 工具页 B6：`.import` 一致性体检（src/tools/inspectors/imports.ts）的断言。
//
// ⚠ 判据 2 的失效清单会直接进「删除」按钮（spec §6 的失败模式是用户真会删）。所以本文件里
//   「不该进 rels」的断言比「该进 rels」的更要紧 —— ★那条大小写异体的断言是本任务最重要的一条:
//   把还在用的边车当失效删掉,下次编辑器重扫会改哈希、连带让引用它的场景全变。
//
// 夹具是「内存文件树 + readText 桩」,与 refIndex / uid / orphans 测试同一份口径(extOf/tree/makeCtx)。
// calls 记 readText 问过的 rel —— 成本红线(`.import` 是唯一的读入面、不调 buildRefIndex)全靠它。
//
// 用法（npm script 会先跑打包步骤）:
//   node src/composables/__tests__/build-bundle.mjs && node src/tools/__tests__/imports.test.mjs
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

/** ext 推导与原语两端逐字一致（照 refIndex/uid/orphans 测试的同一份实现） */
function extOf(rel) {
  const base = rel.slice(rel.lastIndexOf('/') + 1)
  const i = base.lastIndexOf('.')
  return i > 0 ? base.slice(i + 1).toLowerCase() : ''
}
function tree(specs) {
  const base = Date.UTC(2026, 0, 1)
  return specs.map(([rel, size, off = 0]) => ({ rel, size, mtimeMs: base + off * 86400000, ext: extOf(rel) }))
}

/** 内存 ctx 工厂:fail 里的 rel 走指定返回形态(不给 text 就是读不到),其余只认 texts */
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

const staleOf = (fs) => fs.filter((f) => f.id === 'imports:stale:all')
const missingOf = (fs) => fs.filter((f) => f.id.startsWith('imports:missing:'))
const mismatchOf = (fs) => fs.filter((f) => f.id.startsWith('imports:mismatch:'))
const gateOf = (fs) => fs.filter((f) => f.id === 'imports:gate:no-import')
const truncOf = (fs) => fs.filter((f) => f.id === 'imports:truncated')
const ids = (fs) => fs.map((f) => f.id).join('|')
const relsOf = (f) => (f && f.fix && f.fix.payload && f.fix.payload.rels) || null

/**
 * 编辑器写出的 4.x 边车正文（判据 1 的取键位置:[remap] 拿 importer、[deps] 拿 source_file）。
 * 默认 importer="texture" —— 它是**表外**导入器(图像扩展名由运行时注册),所以默认值永不触发判据 4,
 * 干净夹具里的每条边车都只被当「有边车」这件事用。
 */
function imp(sourceFile, importer = 'texture') {
  return [
    '[remap]',
    '',
    `importer="${importer}"`,
    'type="CompressedTexture2D"',
    'uid="uid://bkm2b5nqf3rhe"',
    'path="res://.godot/imported/x-1a2b.ctex"',
    '',
    '[deps]',
    '',
    `source_file="${sourceFile}"`,
    'dest_files=["res://.godot/imported/x-1a2b.ctex"]',
    '',
    '[params]',
    '',
    'compress/mode=0'
  ].join('\n')
}

/** Godot 3 的老形态:没有 [remap]/[deps],只有 generator（判据 2 明写不参与 stale/不匹配） */
const LEGACY = 'generator="organically.godot.texture"\n\n[params]\n\ncompress/mode=0\n'

async function main() {
  // ---------- 0. 接线与形状 ----------
  section('0. 接线与形状')
  ok(typeof T.runImports === 'function' && T.runImports.length === 1,
    'run(ctx) 已进 barrel,签名与 size/cache/brokenRefs/uid/orphans 同形', typeof T.runImports)
  const CLEAN_SPECS = [
    ['project.godot', 400],
    ['art/a.png', 800], ['art/a.png.import', 120],
    ['sound/a.wav', 900], ['sound/a.wav.import', 130],
    ['fonts/f.ttf', 4000], ['fonts/f.ttf.import', 150]
  ]
  const CLEAN_TEXTS = {
    'art/a.png.import': imp('res://art/a.png'),
    'sound/a.wav.import': imp('res://sound/a.wav', 'wav'),
    'fonts/f.ttf.import': imp('res://fonts/f.ttf', 'font_data_dynamic')
  }
  const cleanCtx = makeCtx(CLEAN_SPECS, { texts: CLEAN_TEXTS })
  const clean = await T.runImports(cleanCtx.ctx)
  ok(Array.isArray(clean) && clean.length === 0,
    '★干净项目(源与边车都在、导入器与扩展名匹配)→ 0 条结论', ids(clean))
  const shape = await T.runImports(makeCtx([
    ['art/gone.png.import', 100], ['sound/b.wav', 10], ['fonts/z.ttf', 10]
  ], { texts: { 'art/gone.png.import': imp('res://art/gone.png') } }).ctx)
  ok(shape.every((f) => f.id.startsWith('imports:') && ['error', 'warn', 'info'].includes(f.severity) &&
    typeof f.title === 'string' && f.title),
    '每条结论都带 imports: 前缀、合法 severity 与非空 title', ids(shape))
  ok(new Set(shape.map((f) => f.id)).size === shape.length, '一次运行内 id 互不重复', ids(shape))
  ok(shape.every((f) => f.id !== 'imports:gate:no-import'),
    '项目里存在边车时不再出那条 info(项目闸门按字面)', ids(shape))

  // ---------- 1. 判据 2：stale .import ----------
  section('1. 判据 2：失效 .import 与聚合删除清单')
  const oneCtx = makeCtx([['art/gone.png.import', 100]], { texts: { 'art/gone.png.import': imp('res://art/gone.png') } })
  const one = await T.runImports(oneCtx.ctx)
  const agg = staleOf(one)[0]
  ok(one.length === 1 && agg && agg.severity === 'warn',
    'source_file 指向的源不在清单里 → 恰好 1 条 warn 的聚合结论', ids(one))
  ok(relsOf(agg) && relsOf(agg).join('|') === 'art/gone.png.import',
    '判据 2：rels 装的是**边车本身**(art/gone.png.import),不是它指向的源', relsOf(agg)?.join('|'))
  ok(agg && agg.rel === 'art/gone.png.import' && agg.related.join('|') === 'art/gone.png.import',
    '判据 2：rel/related 指向列出的边车(卡片能跳到的文件一定在盘上)', `${agg?.rel}/${agg?.related?.join('|')}`)
  ok(agg && JSON.stringify(Object.keys(agg.fix).sort()) === '["kind","label","payload"]',
    '判据 2：fix 只带 kind/label/payload(动词、风险句、预览清单归 fixPlan.ts)',
    JSON.stringify(agg?.fix && Object.keys(agg.fix)))
  ok(agg && /移除 1 个失效 \.import/.test(agg.fix.label) && !/回收站|永久删除|备份|还原/.test(agg.fix.label),
    '判据 2：label 用简报钉死的中性措辞,不写平台动词', agg?.fix?.label)
  ok(agg && /source_file/.test(agg.detail) && agg.detail.includes('art/gone.png'),
    '判据 2：detail 说明证据是 [deps] 的 source_file 并点名缺失的那个源', agg?.detail)
  // 控制组:源在清单里 → 一条都不报(证明上一条不是恒报)
  const kept = await T.runImports(makeCtx([
    ['art/a.png', 800], ['art/a.png.import', 120]
  ], { texts: { 'art/a.png.import': imp('res://art/a.png') } }).ctx)
  ok(kept.length === 0, '判据 2 控制组:源就在清单里 → 不是失效边车', ids(kept))
  // ★本任务最重要的一条:大小写异体必须挡住误判
  const caseVar = await T.runImports(makeCtx([
    ['art/a.png', 800], ['art/a.png.import', 120]
  ], { texts: { 'art/a.png.import': imp('res://Art/A.png') } }).ctx)
  ok(caseVar.length === 0,
    '★★source_file 写成 res://Art/A.png 而树里是 art/a.png → 不算 stale(Windows 不敏感,报了就等于删掉在用的边车)',
    `${ids(caseVar)}/${relsOf(staleOf(caseVar)[0])?.join('|')}`)
  const caseCtrl = await T.runImports(makeCtx([
    ['other/x.png', 800], ['art/a.png.import', 120]
  ], { texts: { 'art/a.png.import': imp('res://Art/A.png') } }).ctx)
  ok(relsOf(staleOf(caseCtrl)[0])?.join('|') === 'art/a.png.import',
    '★控制组:清单里连一种大小写写法都没有 → 同一句 res://Art/A.png 就真算 stale(上一条不是恒不报)',
    relsOf(staleOf(caseCtrl)[0])?.join('|'))
  // resToRel 的归一直通:反斜杠与 ./ 与重复斜杠都算对得上(不靠字符串包含)
  const norm = await T.runImports(makeCtx([
    ['art/a.png', 800], ['art/a.png.import', 120]
  ], {
    texts: {
      'art/a.png.import': imp('res://art/./sub/../a.png'),
      'art/b.png.import': imp('res://art\\\\b.png')
    }
  }).ctx)
  ok(norm.length === 0, '判据 2：存在性比对走 resToRel 的归一(./ 吃掉、.. 折回、反斜杠转正)', ids(norm))
  // 非项目内路径与畸形值:一律不判
  const nonsrc = await T.runImports(makeCtx([
    ['u1.png.import', 100], ['u2.png.import', 100], ['u3.png.import', 100], ['u4.png.import', 100]
  ], {
    texts: {
      'u1.png.import': imp('user://keep.png'),
      'u2.png.import': imp('E:/proj/keep.png'),
      'u3.png.import': imp('res://../outside.png'),
      'u4.png.import': imp('res://')
    }
  }).ctx)
  ok(nonsrc.length === 0,
    '判据 2：user://、绝对路径、越界串、裸 res:// 一律不判(不造成「源缺失」)', ids(nonsrc))
  // 畸形但合法的键位:[deps] 有 source_file、[remap] 缺 importer → 不崩、源在就不算 stale
  const malformed = await T.runImports(makeCtx([
    ['art/a.png', 800], ['art/a.png.import', 60]
  ], { texts: { 'art/a.png.import': '[deps]\nsource_file="res://art/a.png"\ndest_files=[]\n' } }).ctx)
  ok(malformed.length === 0,
    '判据 2：只有 [deps]、缺 importer 的畸形文件不崩也不误判(源在清单里)', ids(malformed))
  const malformedGone = await T.runImports(makeCtx([
    ['art/gone.png.import', 60]
  ], { texts: { 'art/gone.png.import': '[deps]\nsource_file="res://art/gone.png"\n' } }).ctx)
  ok(relsOf(staleOf(malformedGone)[0])?.join('|') === 'art/gone.png.import',
    '判据 2：同一份畸形文件,源真的不在 → 照样算 stale(importer 缺不缺不是这条的证据)',
    relsOf(staleOf(malformedGone)[0])?.join('|'))
  // Godot 3 的 generator 形态压根没有 source_file → 不参与 stale
  const legacyRun = await T.runImports(makeCtx([['art/a.png.import', 60]], { texts: { 'art/a.png.import': LEGACY } }).ctx)
  ok(legacyRun.length === 0 || staleOf(legacyRun).length === 0,
    '判据 2：Godot 3 老形态不参与失效判定(它没有 source_file)', ids(legacyRun))
  // 老形态的键与 [deps] 混在一起(手改/半迁移的文件):仍按 legacy 处理,一条都不判。
  // 没有这一条,legacy 那道闸就是个从未被咬过的分支(变异取下掉它也不会红)。
  const legacyDeps = await T.runImports(makeCtx([['art/gone.png.import', 60]], {
    texts: { 'art/gone.png.import': 'generator="organically.godot.texture"\n\n[deps]\nsource_file="res://art/gone.png"\n' }
  }).ctx)
  ok(staleOf(legacyDeps).length === 0 && legacyDeps.length === 0,
    '★判据 2：generator 形态即使自己写了 source_file 也不进失效清单(闸门真的在挡)', ids(legacyDeps))
  // 读不到的边车:内容读不出就是证据不出,不猜
  const unreadCtx = makeCtx([['art/a.png.import', 60]], { fail: { 'art/a.png.import': { skipped: true } } })
  const unread = await T.runImports(unreadCtx.ctx)
  ok(unread.length === 0 && unreadCtx.calls.join('|') === 'art/a.png.import',
    '判据 2：超限/二进制/缺文件 → 这条边车不判(它不进删除清单),但仍被读过一次',
    `${ids(unread)}/${unreadCtx.calls.join('|')}`)
  // 同 rel 出现两次的畸形清单:只读一次、只进一次
  const dupRel = makeCtx([['art/gone.png.import', 60], ['art/gone.png.import', 60]],
    { texts: { 'art/gone.png.import': imp('res://art/gone.png') } })
  const dupRun = await T.runImports(dupRel.ctx)
  ok(relsOf(staleOf(dupRun)[0])?.length === 1 && dupRel.calls.length === 1,
    '判据 2：同一 rel 在清单里出现两次 → 只读一次、rels 里只有一条(否则预览与删除都会重踩)',
    `${relsOf(staleOf(dupRun)[0])?.length}/${dupRel.calls.length}`)

  // ---------- 2. 判据 2/3：默认排除与计数 ----------
  section('2. 判据 2/3：.godot、addons、缓存源与排除计数')
  const exSpecs = [
    ['project.godot', 400],
    ['art/gone.png.import', 100],
    ['.godot/imported/x.png.import', 50],
    ['.godot/gen/y.png.import', 50],
    ['addons/foo/y.png.import', 50],
    ['addons/bar/z.wav.import', 50],
    ['art/legacy.png.import', 50],
    ['art/unread.png.import', 50],
    ['art/nosrc1.png.import', 50], ['art/nosrc2.png.import', 50], ['art/nosrc3.png.import', 50],
    ['art/cachesrc.png.import', 50]
  ]
  const exTexts = {
    'art/gone.png.import': imp('res://art/gone.png'),
    '.godot/imported/x.png.import': imp('res://.godot/imported/gone.ctex'),
    '.godot/gen/y.png.import': imp('res://gen/gone.png'),
    'addons/foo/y.png.import': imp('res://addons/foo/gone.png'),
    'addons/bar/z.wav.import': imp('res://addons/bar/gone.wav', 'wav'),
    'art/legacy.png.import': LEGACY,
    'art/nosrc1.png.import': imp('user://keep.png'),
    'art/nosrc2.png.import': imp('E:/proj/keep.png'),
    'art/nosrc3.png.import': '[remap]\nimporter="texture"\n',
    'art/cachesrc.png.import': imp('res://.godot/imported/gone.ctex')
  }
  const exCtx = makeCtx(exSpecs, { texts: exTexts, fail: { 'art/unread.png.import': { skipped: true } } })
  const exRun = await T.runImports(exCtx.ctx)
  const exAgg = staleOf(exRun)[0]
  ok(exRun.length === 1 && relsOf(exAgg)?.join('|') === 'art/gone.png.import',
    '★判据 2：整幅排除图里只有非缓存非 addons 且源真不在的那条进 rels', relsOf(exAgg)?.join('|'))
  ok(exAgg && !exAgg.detail.includes('.godot/imported/x.png.import') && !exAgg.detail.includes('addons/foo/y.png.import'),
    '判据 2：被排除的边车不进展示清单(否则用户会以为它也在删除范围内)', exAgg?.detail)
  ok(exAgg && /\.godot 缓存 2 项/.test(exAgg.detail) && /addons 2 项/.test(exAgg.detail),
    '判据 2：.godot 与 addons 的排除计数逐类写进 detail(与 orphans 同口径)', exAgg?.detail)
  ok(exAgg && /老形态 1 项/.test(exAgg.detail) && /读不到 1 项/.test(exAgg.detail),
    '判据 2：Godot 3 老形态与读不到的计数也写进 detail', exAgg?.detail)
  ok(exAgg && /不是项目内路径 3 项/.test(exAgg.detail),
    '判据 2：source_file 缺失/不是项目内路径的计数写进 detail', exAgg?.detail)
  ok(exAgg && /指向 \.godot 缓存 1 项/.test(exAgg.detail),
    '★判据 2：source_file 指向 .godot 缓存的边车单独计数 —— 清缓存是常态,拿它当 stale 就是假证据',
    exAgg?.detail)
  ok(!exCtx.calls.includes('.godot/imported/x.png.import') && !exCtx.calls.includes('addons/foo/y.png.import'),
    '判据 2+成本：.godot 与 addons 下的边车一个字都不读', exCtx.calls.join('|'))
  // addons 下的资源也不进「缺边车」判定
  const addonAsset = await T.runImports(makeCtx([
    ['addons/foo/x.wav', 10], ['keep/a.wav', 10], ['keep/a.wav.import', 10]
  ], { texts: { 'keep/a.wav.import': imp('res://keep/a.wav', 'wav') } }).ctx)
  ok(missingOf(addonAsset).length === 0, '判据 3：addons 下的资源不判缺边车(addons 整体归 addons 体检)', ids(addonAsset))
  const cacheAsset = await T.runImports(makeCtx([
    ['.godot/gen/x.wav', 10], ['keep/a.wav', 10], ['keep/a.wav.import', 10]
  ], { texts: { 'keep/a.wav.import': imp('res://keep/a.wav', 'wav') } }).ctx)
  ok(missingOf(cacheAsset).length === 0, '判据 3：.godot 下的资源不判缺边车(生成物)', ids(cacheAsset))
  // 项目闸门的分母**含** addons 下的边车(照 uid.ts:136-145 的 sidecarCount 口径):那批边车同样是
  // 「这个项目写过导入元数据」的证据。两份工具在同一个量词上不许各说各话。
  const addonGate = await T.runImports(makeCtx([
    ['addons/foo/icon.png.import', 10], ['sound/a.wav', 10]
  ], { texts: { 'addons/foo/icon.png.import': imp('res://addons/foo/icon.png') } }).ctx)
  ok(gateOf(addonGate).length === 0 && ids(missingOf(addonGate)) === 'imports:missing:sound/a.wav',
    '★判据 3：只有 addons 下有边车时项目闸门**不**成立(addons 的边车照样算证据,与 B4 同一读法)', ids(addonGate))

  // ---------- 3. 降级闸门：ctx.truncated 一条都不判 ----------
  section('3. 降级闸门：ctx.truncated')
  const TRUNC_SPECS = [
    ['art/gone.png.import', 100], ['sound/b.wav', 10], ['fonts/z.ttf', 10]
  ]
  const truncCtx = makeCtx(TRUNC_SPECS, { trunc: true, texts: { 'art/gone.png.import': imp('res://art/gone.png') } })
  const t1 = await T.runImports(truncCtx.ctx)
  ok(t1.length === 1 && truncOf(t1).length === 1 && truncOf(t1)[0].severity === 'warn',
    'ctx.truncated → 只有一条降级结论(三类判据一条都不出)', ids(t1))
  ok(truncOf(t1)[0] && /截断/.test(truncOf(t1)[0].title) && truncOf(t1)[0].detail.includes('maxEntries'),
    '降级结论说清「为什么没做」并给安全动作', `${truncOf(t1)[0]?.title}/${truncOf(t1)[0]?.detail}`)
  ok(!truncOf(t1)[0]?.fix && staleOf(t1).length === 0 && missingOf(t1).length === 0 &&
    mismatchOf(t1).length === 0 && gateOf(t1).length === 0,
    '★降级态不许有删除入口,也不许有缺失/不匹配/闸门结论', ids(t1))
  ok(truncCtx.calls.length === 0, '成本红线:截断时一个文件都不读', truncCtx.calls.length)

  // ---------- 4. 判据 3：资源存在但没有 .import ----------
  section('4. 判据 3：缺边车与两道闸门')
  const noSidecar = await T.runImports(makeCtx([
    ['sound/a.wav', 10], ['fonts/b.ttf', 10], ['scripts/x.gd', 10]
  ], {}).ctx)
  ok(noSidecar.length === 1 && gateOf(noSidecar).length === 1 && gateOf(noSidecar)[0].severity === 'info',
    '项目一个 .import 都没有 → 只那一条 info,缺失一条都不报', ids(noSidecar))
  ok(gateOf(noSidecar)[0] && /本次不做/.test(gateOf(noSidecar)[0].title) &&
    !gateOf(noSidecar)[0].fix, '闸门 info 的标题声明本次不做缺失判定且不带修复', gateOf(noSidecar)[0]?.title)
  ok(gateOf(noSidecar)[0] && /导入元数据|\.import/.test(gateOf(noSidecar)[0].detail),
    '闸门 detail 解释 .import 是什么、为什么没有它不是问题', gateOf(noSidecar)[0]?.detail)
  // 项目闸门的分母不看 .godot:唯一的边车在缓存里 → 仍按「没有边车」出 info
  const cacheOnlyGate = await T.runImports(makeCtx([
    ['.godot/imported/x.png.import', 10], ['sound/a.wav', 10]
  ], { texts: { '.godot/imported/x.png.import': imp('res://sound/gone.wav') } }).ctx)
  ok(gateOf(cacheOnlyGate).length === 1 && missingOf(cacheOnlyGate).length === 0 &&
    staleOf(cacheOnlyGate).length === 0,
    '项目闸门只看清单里的非缓存边车:唯一边车在 .godot 下 → 按「没有边车」出 info', ids(cacheOnlyGate))
  // 目录闸门四例
  const dirGate1 = await T.runImports(makeCtx([
    ['sound/a.wav', 10], ['sound/a.wav.import', 10], ['sound/b.wav', 10]
  ], { texts: { 'sound/a.wav.import': imp('res://sound/a.wav', 'wav') } }).ctx)
  ok(ids(missingOf(dirGate1)) === 'imports:missing:sound/b.wav',
    '★目录闸门按字面量词:a.wav 有边车 → b.wav 的「其他都有」成立,报 b.wav(与 B4 的裁定一致)',
    ids(missingOf(dirGate1)))
  ok(missingOf(dirGate1)[0] && missingOf(dirGate1)[0].severity === 'warn' && !missingOf(dirGate1)[0].fix,
    '判据 3：缺失结论是 warn 且**不带 fix**(简报明写)', JSON.stringify(missingOf(dirGate1)[0]?.fix))
  ok(missingOf(dirGate1)[0] && missingOf(dirGate1)[0].detail.includes('sound/a.wav') &&
    missingOf(dirGate1)[0].rel === 'sound/b.wav' && missingOf(dirGate1)[0].title.includes('sound/b.wav'),
    '判据 3：一条结论只讲一个文件,detail 点名是跟谁比',
    `${missingOf(dirGate1)[0]?.rel}/${missingOf(dirGate1)[0]?.detail}`)
  const dirGate2 = await T.runImports(makeCtx([
    ['sound/a.wav', 10], ['sound/b.wav', 10], ['fonts/z.ttf', 10], ['fonts/z.ttf.import', 10]
  ], { texts: { 'fonts/z.ttf.import': imp('res://fonts/z.ttf', 'font_data_dynamic') } }).ctx)
  ok(missingOf(dirGate2).length === 0,
    '判据 3 目录闸门:同目录还有别的 .wav 也没有边车 → 那是目录级既有状态,一条都不报', ids(dirGate2))
  const lone = await T.runImports(makeCtx([
    ['only/a.wav', 10], ['fonts/z.ttf', 10], ['fonts/z.ttf.import', 10]
  ], { texts: { 'fonts/z.ttf.import': imp('res://fonts/z.ttf', 'font_data_dynamic') } }).ctx)
  ok(ids(missingOf(lone)) === 'imports:missing:only/a.wav',
    '判据 3:目录里唯一的同扩展名资源 → 空集上的全称成立(与 B4 同读法,不许悄悄反过来)', ids(missingOf(lone)))
  ok(missingOf(lone)[0] && /唯一/.test(missingOf(lone)[0].detail) &&
    !missingOf(lone)[0].detail.includes('fonts/z.ttf'),
    '空同级时的 detail 不假称有参照,也不把别的目录的文件说成同级', missingOf(lone)[0]?.detail)
  const rootLone = await T.runImports(makeCtx([
    ['root.wav', 10], ['fonts/z.ttf', 10], ['fonts/z.ttf.import', 10]
  ], { texts: { 'fonts/z.ttf.import': imp('res://fonts/z.ttf', 'font_data_dynamic') } }).ctx)
  ok(missingOf(rootLone)[0] && missingOf(rootLone)[0].detail.includes('（项目根）'),
    '判据 3:根目录里的资源 detail 说「（项目根）」而不是空目录名', missingOf(rootLone)[0]?.detail)
  const manySiblings = await T.runImports(makeCtx([
    ['big/a.wav', 10], ['big/a.wav.import', 10], ['big/b.wav', 10], ['big/b.wav.import', 10],
    ['big/c.wav', 10], ['big/c.wav.import', 10], ['big/d.wav', 10], ['big/d.wav.import', 10],
    ['big/z.wav', 10]
  ], {
    texts: {
      'big/a.wav.import': imp('res://big/a.wav', 'wav'), 'big/b.wav.import': imp('res://big/b.wav', 'wav'),
      'big/c.wav.import': imp('res://big/c.wav', 'wav'), 'big/d.wav.import': imp('res://big/d.wav', 'wav')
    }
  }).ctx)
  ok(missingOf(manySiblings).length === 1 && / 等/.test(missingOf(manySiblings)[0].detail) &&
    missingOf(manySiblings)[0].detail.includes('其他 4 个') &&
    missingOf(manySiblings)[0].detail.includes('big/a.wav') &&
    !missingOf(manySiblings)[0].detail.includes('big/d.wav'),
    '判据 3:同级超过 3 个只点名前 3 个 + 计数说全部(裁切只裁展示不裁账)', manySiblings[0]?.detail)
  const twoDirs = await T.runImports(makeCtx([
    ['a/x.wav', 10], ['a/y.wav', 10], ['a/y.wav.import', 10],
    ['b/x.ogg', 10], ['b/y.ogg', 10], ['b/y.ogg.import', 10],
    ['fonts/z.ttf', 10], ['fonts/z.ttf.import', 10]
  ], {
    texts: {
      'a/y.wav.import': imp('res://a/y.wav', 'wav'), 'b/y.ogg.import': imp('res://b/y.ogg', 'oggvorbisstr'),
      'fonts/z.ttf.import': imp('res://fonts/z.ttf', 'font_data_dynamic')
    }
  }).ctx)
  ok(ids(missingOf(twoDirs)) === 'imports:missing:a/x.wav|imports:missing:b/x.ogg',
    '判据 3:两个目录各缺一个 → 两条独立结论,按 rel 排序;不同扩展名互不当同级', ids(missingOf(twoDirs)))
  // 表外扩展名一律不判缺失(判据 3 的「候选清单要写清来源」反面)
  const outTable = await T.runImports(makeCtx([
    ['art/a.png', 10], ['art/a.png.import', 10], ['art/b.png', 10],
    ['art/c.glb', 10], ['art/c.glb.import', 10], ['art/d.glb', 10],
    ['keep/a.wav', 10], ['keep/a.wav.import', 10]
  ], {
    texts: {
      'art/a.png.import': imp('res://art/a.png'), 'art/c.glb.import': imp('res://art/c.glb'),
      'keep/a.wav.import': imp('res://keep/a.wav', 'wav')
    }
  }).ctx)
  ok(missingOf(outTable).length === 0,
    '★判据 3：png/glb 这些**图像与场景类**扩展名不在能举证的表内 → 同目录别人都有边车也不判它缺',
    ids(missingOf(outTable)))
  ok(outTable.length === 0, '判据 3 的表外图:整幅图一条结论都不产(不判就是静默)', ids(outTable))
  // 大小写异体的边车也算「有边车」
  const caseSidecar = await T.runImports(makeCtx([
    ['sound/A.WAV', 10], ['sound/A.wav.import', 10], ['sound/b.wav', 10], ['sound/b.wav.import', 10]
  ], {
    texts: {
      'sound/A.wav.import': imp('res://sound/A.WAV', 'wav'), 'sound/b.wav.import': imp('res://sound/b.wav', 'wav')
    }
  }).ctx)
  ok(missingOf(caseSidecar).length === 0,
    '判据 3：边车写法与资源名大小写不同(sound/A.WAV vs sound/A.wav.import)→ 仍算有边车', ids(caseSidecar))
  const caseCtrl2 = await T.runImports(makeCtx([
    ['sound/A.WAV', 10], ['sound/b.wav', 10], ['sound/b.wav.import', 10]
  ], { texts: { 'sound/b.wav.import': imp('res://sound/b.wav', 'wav') } }).ctx)
  ok(ids(missingOf(caseCtrl2)) === 'imports:missing:sound/A.WAV',
    '判据 3 控制组:把那份异体边车拿走就立刻报缺失(上一条的静默确实来自大小写闸)', ids(caseCtrl2))
  // 已经有边车的资源永不报缺失;Godot 3 老形态的边车照样算「有边车」
  const hasSide = await T.runImports(makeCtx([
    ['sound/a.wav', 10], ['sound/a.wav.import', 10], ['keep/z.ttf', 10], ['keep/z.ttf.import', 10]
  ], { texts: { 'sound/a.wav.import': LEGACY, 'keep/z.ttf.import': imp('res://keep/z.ttf', 'font_data_dynamic') } }).ctx)
  ok(missingOf(hasSide).length === 0, '判据 3：有边车(哪怕是 Godot 3 老形态)就不报缺失', ids(hasSide))

  // ---------- 5. 判据 4：导入器与扩展名不匹配 ----------
  section('5. 判据 4：导入器与扩展名对不上')
  const mm = await T.runImports(makeCtx([
    ['sound/x.wav', 10], ['sound/x.wav.import', 10], ['fonts/z.ttf', 10], ['fonts/z.ttf.import', 10]
  ], {
    texts: {
      'sound/x.wav.import': imp('res://sound/x.wav', 'oggvorbisstr'),
      'fonts/z.ttf.import': imp('res://fonts/z.ttf', 'font_data_dynamic')
    }
  }).ctx)
  ok(ids(mismatchOf(mm)) === 'imports:mismatch:sound/x.wav.import',
    '★wav 边车写 oggvorbisstr(该导入器只声明 .ogg)→ 恰好 1 条不匹配,匹配的那条不出', ids(mm))
  ok(mismatchOf(mm)[0] && mismatchOf(mm)[0].severity === 'warn' && !mismatchOf(mm)[0].fix,
    '判据 4：不匹配是 warn 且不带 fix(简报明写:只报告,不动盘)',
    JSON.stringify(mismatchOf(mm)[0]?.fix))
  ok(mismatchOf(mm)[0] && mismatchOf(mm)[0].detail.includes('oggvorbisstr') &&
    mismatchOf(mm)[0].detail.includes('ogg') && mismatchOf(mm)[0].detail.includes('wav'),
    '判据 4：detail 同时给出边车里的 importer、该导入器声明的扩展名与实际扩展名', mismatchOf(mm)[0]?.detail)
  ok(mismatchOf(mm)[0] && mismatchOf(mm)[0].rel === 'sound/x.wav.import',
    '判据 4：rel 指向那份边车本身(卡片跳到能打开的文件)', mismatchOf(mm)[0]?.rel)
  // 表外 importer 一律不判
  const tableOutImp = await T.runImports(makeCtx([
    ['sound/a.wav', 10], ['sound/a.wav.import', 10]
  ], { texts: { 'sound/a.wav.import': imp('res://sound/a.wav', 'texture') } }).ctx)
  ok(mismatchOf(tableOutImp).length === 0,
    '★判据 4：importer="texture" 是**表外**导入器(图像扩展名清单由运行时注册)→ 不判,哪怕它配着 .wav',
    ids(tableOutImp))
  const customImp = await T.runImports(makeCtx([
    ['art/a.csv', 10], ['art/a.csv.import', 10]
  ], { texts: { 'art/a.csv.import': imp('res://art/a.csv', 'aseprite_importer') } }).ctx)
  ok(mismatchOf(customImp).length === 0, '判据 4：addon 自定义的 importer 名 → 表外,不判', ids(customImp))
  // 表外扩展名一律不判(两侧都要在表内)
  const tableOutExt = await T.runImports(makeCtx([
    ['art/a.png', 800], ['art/a.png.import', 120]
  ], { texts: { 'art/a.png.import': imp('res://art/a.png', 'wav') } }).ctx)
  ok(mismatchOf(tableOutExt).length === 0,
    '★判据 4：.png 在表外 → 哪怕 importer="wav" 也「不知道,不判」(两侧都得能举证才报)', ids(tableOutExt))
  // 名字与 source_file 的扩展名互相矛盾 → 不知道哪个是真的,不判
  const conflict = await T.runImports(makeCtx([
    ['sound/x.wav', 10], ['sound/x.ogg', 10], ['sound/x.wav.import', 10], ['fonts/z.ttf', 10], ['fonts/z.ttf.import', 10]
  ], {
    texts: {
      'sound/x.wav.import': imp('res://sound/x.ogg', 'wav'),
      'fonts/z.ttf.import': imp('res://fonts/z.ttf', 'font_data_dynamic')
    }
  }).ctx)
  ok(mismatchOf(conflict).length === 0,
    '判据 4：边车名说 .wav、source_file 说 .ogg → 两个证据互相打不开,不判(不替用户挑一个)', ids(conflict))
  // Godot 3 老形态不判不匹配
  const legacyMm = await T.runImports(makeCtx([['art/a.png.import', 60]], { texts: { 'art/a.png.import': LEGACY } }).ctx)
  ok(mismatchOf(legacyMm).length === 0, '判据 4：Godot 3 的 generator 形态不参与不匹配判定', ids(legacyMm))
  // importer 缺失(畸形文件)不判
  const noImp = await T.runImports(makeCtx([
    ['sound/a.wav', 10], ['sound/a.wav.import', 60]
  ], { texts: { 'sound/a.wav.import': '[deps]\nsource_file="res://sound/a.wav"\n' } }).ctx)
  ok(noImp.length === 0, '判据 4：缺 importer 的畸形文件不报不匹配(没有名字可比)', ids(noImp))

  // ---------- 6. 判据 5：明写不判的东西 ----------
  section('6. 判据 5：越界即误报的那些')
  const notJudged = await T.runImports(makeCtx([
    ['art/a.png', 800],
    ['art/a.png.import', 120],
    ['art/b.wav', 900], ['art/b.wav.import', 120], ['art/b.wav.uid', 30]
  ], {
    texts: {
      // path/dest_files 指向盘上根本没有的 .godot 产物、validated=false、[params] 与源「不同步」
      'art/a.png.import': [
        '[remap]',
        'importer="texture"',
        'type="CompressedTexture2D"',
        'uid="uid://cAAA"',
        'path="res://.godot/imported/does-not-exist-99.ctex"',
        'validated=false',
        '[deps]',
        'source_file="res://art/a.png"',
        'dest_files=["res://.godot/imported/does-not-exist-99.ctex"]',
        '[params]',
        'compress/mode=3'
      ].join('\n'),
      'art/b.wav.import': '[remap]\nimporter="wav"\nuid="uid://cBBB"\n[deps]\nsource_file="res://art/b.wav"\n',
      'art/b.wav.uid': 'uid://cZZZ'
    }
  }).ctx)
  ok(notJudged.length === 0,
    '★判据 5：path/dest_files 指向的产物不存在、validated=false、[params] 内容与源不同步、' +
    '边车 uid 与 .uid 边文不一致 —— 四类全都一条不报(那是编辑器的事与 B4 的活)', ids(notJudged))

  // ---------- 7. 规模与 B1 对接 ----------
  section('7. 判据 2 的规模上限与 planFix 全量预览')
  const manySpecs = []
  const manyTexts = { 'project.godot': '[application]\n' }
  for (let i = 0; i < 60; i++) {
    const n = String(i).padStart(2, '0')
    const rel = `assets/tex/g${n}.png.import`
    manySpecs.push([rel, 60])
    manyTexts[rel] = imp(`res://assets/tex/g${n}.png`)
  }
  const manyCtx = makeCtx([...manySpecs, ['project.godot', 400]], { texts: manyTexts })
  const many = await T.runImports(manyCtx.ctx)
  const ma = staleOf(many)[0]
  ok(many.length === 1 && ma && relsOf(ma).length === 60,
    '判据 2：60 个失效边车仍只有 1 条结论,payload.rels 含全部 60 个', `${many.length}/${relsOf(ma)?.length}`)
  ok(ma && ma.title.includes('60'), '判据 2：标题点名总数 60', ma?.title)
  ok(ma && /移除 60 个失效 \.import/.test(ma.fix.label),
    '判据 2：label 的数量是总数而不是列出的行数(否则删完还剩一半,卡片却说删过了)', ma?.fix?.label)
  ok(ma && ma.detail.includes('另有 40 个'), '判据 2：detail 说「另有 40 个未列出」而删除仍按 60 个执行', ma?.detail)
  ok(ma && ma.related.length === 20 && ma.related.join('|') === relsOf(ma).slice(0, 20).join('|'),
    '判据 2：related 只列前 20(刷屏上限),且就是码元序前 20', `${ma?.related?.length}`)
  ok(ma && JSON.stringify(relsOf(ma)) === JSON.stringify(relsOf(ma).slice().sort()),
    '判据 2：rels 全量按码元序(逐字节确定,不跟 tree 顺序)', relsOf(ma)?.slice(0, 3).join('|'))
  const planWin = T.planFix(ma, tree([...manySpecs, ['project.godot', 400]]), true)
  ok(planWin.items.length === 60 && planWin.rels.length === 60 && planWin.empty === false &&
    planWin.service === 'movePathsToTrash' && planWin.verb === '移入回收站',
    '★B1 对接：planFix 从 payload.rels 建预览 → 展示裁切不裁确认框(spec §5.3 规则 3)',
    JSON.stringify({ i: planWin.items.length, s: planWin.service, v: planWin.verb }))
  const planMac = T.planFix(ma, tree(manySpecs), false)
  ok(planMac.verb === '永久删除' && planMac.warn.includes('永久删除'),
    'B1 对接：同一条 finding 在非 Windows 自动换措辞(措辞真的没写在检查器里)', planMac.verb)
  const planMissing = T.planFix(missingOf(lone)[0], tree([['only/a.wav', 10]]), true)
  ok(planMissing.service === null && planMissing.empty === true && planMissing.verb === '' &&
    planMissing.items.length === 0,
    '判据 3 与 planFix：缺失结论走「没有修复动作」那条,预览一条都不列', JSON.stringify(planMissing.items))

  // ---------- 8. 成本红线 ----------
  section('8. 成本红线：只读 .import')
  const costCtx = makeCtx(CLEAN_SPECS, { texts: CLEAN_TEXTS })
  const costFindings = await T.runImports(costCtx.ctx)
  ok(costFindings.length === 0 && [...new Set(costCtx.calls)].sort().join('|') ===
    ['art/a.png.import', 'fonts/f.ttf.import', 'sound/a.wav.import'].sort().join('|'),
    '★成本红线:读入面只有那 3 份 .import —— png/wav/ttf/gd/tscn/project.godot 一个字都不读',
    costCtx.calls.join('|'))
  ok(!costCtx.calls.some((r) => !r.toLowerCase().endsWith('.import')),
    '成本红线:calls 里没有任何非边车 rel ⇒ 没调 buildRefIndex(那会去读 .gd/.tscn 等引用来源)',
    costCtx.calls.join('|'))
  ok(new Set(costCtx.calls).size === costCtx.calls.length, '一个候选只读一次(没有按判据重复读)', costCtx.calls.length)

  // 两处**防御分支**:原语两端都不会给出这种形状(inspectfs.js:263 / inspectfs.rs:83-88 的 ext
  // 就是从 rel 算出来的),但畸形清单不能让它们变成第二次删除入口或撞 id 的结论。
  const dupAssetCtx = makeCtx([
    ['sound/a.wav', 10], ['sound/a.wav', 10], ['sound/b.wav', 10], ['sound/b.wav.import', 10]
  ], { texts: { 'sound/b.wav.import': imp('res://sound/b.wav', 'wav') } })
  const dupAsset = await T.runImports(dupAssetCtx.ctx)
  ok(missingOf(dupAsset).length === 1 && new Set(dupAsset.map((f) => f.id)).size === dupAsset.length,
    '防御:同一资源在清单里出现两次也只报一条缺失(id 不撞)', ids(dupAsset))
  const fakeExtCalls = []
  const fakeExtCtx = {
    projectId: 'godot/project/p', root: 'E:/proj', truncated: false,
    tree: [
      // 畸形条目:ext 写 'import' 而 rel 并不以 .import 收尾(两端原语都给不出这种形状)
      { rel: 'art/gone.png', size: 10, mtimeMs: 1, ext: 'import' },
      { rel: 'keep/a.wav', size: 10, mtimeMs: 1, ext: 'wav' },
      { rel: 'keep/a.wav.import', size: 10, mtimeMs: 1, ext: 'import' }
    ],
    readText: async (rel) => {
      fakeExtCalls.push(rel)
      return rel === 'art/gone.png'
        ? { text: imp('res://art/elsewhere.png') }
        : { text: imp('res://keep/a.wav', 'wav') }
    }
  }
  const fakeExt = await T.runImports(fakeExtCtx)
  ok(fakeExt.length === 0 && fakeExtCalls.join('|') === 'keep/a.wav.import',
    '防御:那条 ext 与 rel 不自洽的条目(rel 不以 .import 收尾 → 切出的 assetRel 是猜的)既不读也不判',
    `${ids(fakeExt)}/${fakeExtCalls.join('|')}`)

  // ---------- 9. 判据 6：id 稳定性与确定性 ----------
  section('9. 判据 6：id 稳定与确定性')
  const DET_SPECS = [
    ['art/z.png.import', 10], ['art/a.png.import', 10],
    ['big/one.wav', 10], ['big/two.wav', 10], ['big/two.wav.import', 10],
    ['mm/x.ogg', 10], ['mm/x.ogg.import', 10],
    ['root/bbb.csv', 10], ['root/bbb.csv.import', 10], ['root/aaa.csv', 10]
  ]
  const DET_TEXTS = {
    'art/z.png.import': imp('res://art/gone1.png'),
    'art/a.png.import': imp('res://art/gone2.png'),
    'big/two.wav.import': imp('res://big/two.wav', 'wav'),
    'mm/x.ogg.import': imp('res://mm/x.ogg', 'wav'),
    'root/bbb.csv.import': imp('res://root/bbb.csv', 'csv_translation')
  }
  const d1 = await T.runImports(makeCtx(DET_SPECS, { texts: DET_TEXTS }).ctx)
  const d2 = await T.runImports(makeCtx(DET_SPECS, { texts: DET_TEXTS }).ctx)
  const dRev = await T.runImports(makeCtx([...DET_SPECS].reverse(), { texts: DET_TEXTS }).ctx)
  const mix = [DET_SPECS[6], DET_SPECS[0], DET_SPECS[8], DET_SPECS[3], DET_SPECS[9], DET_SPECS[1], DET_SPECS[5], DET_SPECS[2], DET_SPECS[4], DET_SPECS[7]]
  const dMix = await T.runImports(makeCtx(mix, { texts: DET_TEXTS }).ctx)
  const dump = (fs) => JSON.stringify(fs)
  ok(dump(d1) === dump(d2), '判据 6：同一份清单两次运行 findings 逐字节一致', `${d1.length}/${d2.length}`)
  ok(dump(d1) === dump(dRev), '判据 6：文件顺序反序后逐字节一致(结论不靠 tree 下标)', `${ids(d1)} vs ${ids(dRev)}`)
  ok(dump(d1) === dump(dMix), '判据 6：任意交错顺序同样一致', ids(dMix))
  ok(staleOf(d1)[0] && relsOf(staleOf(d1)[0]).join('|') === 'art/a.png.import|art/z.png.import',
    '判据 6：聚合 rels 按码元序(a 在 z 前,与 tree 顺序无关)', relsOf(staleOf(d1)[0])?.join('|'))
  // 排序口径要钉死成 UTF-16 码元而不是 localeCompare:`.`(46) 与 `_`(95) 这一对在 ICU 里的先后是**反的**
  // (ICU 把下划线当可变权重标点,排到点之前),用 localeCompare 就会随宿主语言环境换掉 rels 顺序与 rel。
  const orderRun = await T.runImports(makeCtx([
    ['old/a.png.import', 10], ['old/a_1.png.import', 10]
  ], {
    texts: { 'old/a.png.import': imp('res://old/ga.png'), 'old/a_1.png.import': imp('res://old/gb.png') }
  }).ctx)
  ok(relsOf(staleOf(orderRun)[0])?.join('|') === 'old/a.png.import|old/a_1.png.import',
    '判据 6：rels 与 rel 的先后按码元序(localeCompare 会把 a_1 排到 a 前面,清单就会跟着抖)',
    relsOf(staleOf(orderRun)[0])?.join('|'))
  const WANT_ORDER = 'imports:stale:all|imports:mismatch:mm/x.ogg.import|' +
    'imports:missing:big/one.wav|imports:missing:root/aaa.csv'
  ok(ids(d1) === WANT_ORDER,
    '判据 6：结论的先后是定死的类别序(聚合 stale → 逐条 mismatch → 逐条 missing),类内按 rel 码元序',
    ids(d1))
  ok(mismatchOf(d1).length === 1 && missingOf(d1).length === 2 && staleOf(d1).length === 1,
    '判据 6 夹具自检:三类判据在同一次运行里都有产出(确定性断言不是空转)', ids(d1))
  ok(d1.every((f) => !/\d{10,}|[Tt]rue|null/.test(f.id)), '判据 6：id 里没有数字串/布尔/null', ids(d1))
  const fewStale = await T.runImports(makeCtx([['a.png.import', 10]], { texts: { 'a.png.import': imp('res://a.png') } }).ctx)
  ok(staleOf(fewStale)[0] && staleOf(fewStale)[0].id === 'imports:stale:all' &&
    staleOf(fewStale)[0].id === ma.id,
    '判据 6：聚合 id 是常量键,1 个与 60 个失效边车是同一条结论(忽略记忆不换键)',
    `${staleOf(fewStale)[0]?.id}/${ma?.id}`)
  const empty = await T.runImports(makeCtx([]).ctx)
  ok(Array.isArray(empty) && ids(empty) === 'imports:gate:no-import',
    '空清单:项目闸门按字面执行(0 个边车也是「没有 .import」),除此之外一条都不造', ids(empty))
}

main().catch((e) => {
  console.error(`\n测试脚本抛错: ${e && e.stack ? e.stack : e}`)
  process.exit(1)
}).then(() => {
  console.log(`\n${'='.repeat(56)}\nPASS ${pass}  FAIL ${failures.length}`)
  if (failures.length) { console.log('失败项:'); for (const f of failures) console.log('  - ' + f); process.exit(1) }
  console.log('全部通过')
})
