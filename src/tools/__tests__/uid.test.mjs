// 工具页 B4：UID 体检（src/tools/inspectors/uid.ts）的断言。
//
// 判据方向由 spec §3.1 #5 与简报钉死：第一期只判三类保守情形（重复 uid、孤儿 .uid、
// 同目录一致性缺失），**不判**「.uid 边文与头部 uid 不一致」「token 格式错误」「.import 里的 uid」
// —— 那些是 B6/后续轮次的活，本期顺手加就是越界（「不加判据」是要求，不是建议）。
//
// 夹具是「内存文件树 + readText 桩」，与 refIndex.test.mjs 同形（extOf / tree / makeCtx 一份口径）。
// calls 记 readText 问过的 rel —— 判据 6 的成本红线全靠它证明「根本没去读」。
//
// 用法（npm script 会先跑打包步骤）：
//   node src/composables/__tests__/build-bundle.mjs && node src/tools/__tests__/uid.test.mjs
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

/** ext 推导必须与原语两端逐字一致（照 refIndex.test.mjs 的同一份实现，别在这儿漂） */
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
 * calls 记录 readText 被问过的 rel。
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

/** 结论按判据分组，断言才不会被别组的结论顶掉 */
const dupsOf = (fs) => fs.filter((f) => f.id.startsWith('uid:dup:'))
const orphansOf = (fs) => fs.filter((f) => f.id.startsWith('uid:orphan'))
const missingOf = (fs) => fs.filter((f) => f.id.startsWith('uid:missing:'))
const gateOf = (fs) => fs.filter((f) => f.id === 'uid:gate:no-uid')
const truncOf = (fs) => fs.filter((f) => f.id === 'uid:truncated')
const ids = (fs) => fs.map((f) => f.id).join('|')
const relsOf = (f) => (f && f.fix && f.fix.payload && f.fix.payload.rels) || null

// ---------- 夹具 ----------

const CLEAN = {
  texts: {
    // 头部 + 自己的边文同一个 uid（判据 2 明写：同一 rel 两渠道同 uid 不算重复）
    'scene/main.tscn': 'gd_scene load_steps=2 format=3 uid="uid://cscena1"\n[ext_resource type="Script" uid="uid://cscript9" path="res://scripts/player.gd" id="1_s"]',
    'scene/main.tscn.uid': 'uid://cscena1',
    'scripts/player.gd.uid': 'uid://cscript9',
    'scripts/npc.gd.uid': 'uid://cnpc001'
  }
}
const CLEAN_SPECS = [
  ['project.godot', 400],
  ['scene/main.tscn', 900],
  ['scene/main.tscn.uid', 30],
  ['scripts/player.gd', 500],
  ['scripts/player.gd.uid', 30],
  ['scripts/npc.gd', 400],
  ['scripts/npc.gd.uid', 30],
  ['assets/bg.png', 8000],
  ['assets/bg.png.import', 700],
  ['README.md', 300]
]

async function main() {
  // ---------- 0. 接线与形状 ----------
  section('0. 接线与形状')
  ok(typeof T.runUid === 'function' && T.runUid.length === 1, 'run(ctx) 已进 barrel，签名与 size/cache/brokenRefs 同形', typeof T.runUid)
  ok(typeof T.isUidToken === 'function',
    '判据 5：token 判据从 refIndex.ts 导出复用（第二个文件里再抄一条正则就是分叉）', typeof T.isUidToken)
  const clean = await T.runUid(makeCtx(CLEAN_SPECS, CLEAN).ctx)
  ok(Array.isArray(clean) && clean.length === 0, '干净项目（边车齐整、无重复、无孤儿）→ 0 条结论', ids(clean))
  const shape = await T.runUid(makeCtx([
    ['scene/a.tscn', 10], ['scene/b.tscn', 10], ['old/x.gd.uid', 10], ['scripts/lone.gd', 10],
    ['keep.gd', 10], ['keep.gd.uid', 10]
  ], {
    texts: {
      'scene/a.tscn': 'gd_scene load_steps=1 format=3 uid="uid://cscena1"',
      'scene/b.tscn': 'gd_scene load_steps=1 format=3 uid="uid://cscena1"',
      'old/x.gd.uid': 'uid://cxyz0001',
      'keep.gd.uid': 'uid://ckeep001'
    }
  }).ctx)
  ok(shape.every((f) => f.id.startsWith('uid:') && ['error', 'warn', 'info'].includes(f.severity) &&
    typeof f.title === 'string' && f.title),
    '每条结论都带 uid: 前缀的 id、合法 severity 与非空 title', ids(shape))
  ok(new Set(shape.map((f) => f.id)).size === shape.length, '一次运行内 id 互不重复（折叠/忽略记忆靠它）', ids(shape))

  // ---------- 1. 判据 1：所有权声明的采集与归属 ----------
  section('1. 判据 1：采集与边文归属')
  // 边文 X.uid 的 uid 归给 X（源 rel = rel.slice(0, -'.uid'.length)），所以
  // scene/main.tscn.uid 与 other.tres 头部同 uid 时，声明者是 scene/main.tscn。
  const attr = await T.runUid(makeCtx([
    ['scene/main.tscn', 100], ['scene/main.tscn.uid', 30], ['other.tres', 50]
  ], {
    texts: {
      'scene/main.tscn.uid': 'uid://cscena1',
      'other.tres': 'gd_resource type="Resource" format=3 uid="uid://cscena1"'
    }
  }).ctx)
  const attrDup = dupsOf(attr)
  ok(attrDup.length === 1 && attrDup[0].id === 'uid:dup:uid://cscena1',
    '判据 1：边文的 uid 归给源文件后与头部声明相撞 → 1 条重复', ids(attr))
  ok(attrDup[0] && attrDup[0].rel === 'other.tres' && attrDup[0].related.join('|') === 'scene/main.tscn',
    '判据 1+2：声明者 rel 是 scene/main.tscn（不是 scene/main、也不是 scene/main.tscn.uid）',
    `${attrDup[0]?.rel} / ${attrDup[0]?.related?.join('|')}`)
  ok(attrDup[0] && attrDup[0].detail.includes('other.tres') && attrDup[0].detail.includes('头部') &&
    attrDup[0].detail.includes('边车 scene/main.tscn.uid'),
    '判据 2：detail 逐条写明这个 uid 与每条声明者的关系（头部 / 哪个边车）', attrDup[0]?.detail)
  // X.a.b.uid 的源必须是 X.a.b：按 basename/最后一个点重拼会得到 X.a 或 X.b（都不存在）→ 假孤儿
  const dots = await T.runUid(makeCtx([
    ['sub/logo.a.b', 20], ['sub/logo.a.b.uid', 30], ['scene/x.tscn', 10]
  ], { texts: { 'sub/logo.a.b.uid': 'uid://cabcd1', 'scene/x.tscn': 'gd_scene uid="uid://cabcd1"' } }).ctx)
  ok(orphansOf(dots).length === 0, '判据 1：X.a.b.uid 的源是 X.a.b（源在清单里 → 不是孤儿）', ids(dots))
  ok(dupsOf(dots).length === 1 &&
    [dupsOf(dots)[0].rel, ...dupsOf(dots)[0].related].sort().join('|') === 'scene/x.tscn|sub/logo.a.b',
    '判据 1：多点文件名的归属仍按整段前缀（owner = sub/logo.a.b）',
    `${dupsOf(dots)[0]?.id}/${[dupsOf(dots)[0]?.rel, ...(dupsOf(dots)[0]?.related || [])].join('|')}`)
  // .godot/** 一律不采集：这里那份边车的源不在清单里，误采集就会长出假孤儿
  const cached = await T.runUid(makeCtx([['.godot/imported/sub/x.uid', 30]],
    { texts: { '.godot/imported/sub/x.uid': 'uid://ccached1' } }).ctx)
  ok(orphansOf(cached).length === 0 && dupsOf(cached).length === 0,
    '判据 1：.godot 下的 .uid 不采集（不判孤儿、也不进重复）', ids(cached))
  ok(gateOf(cached).length === 1,
    '判据 4 项目闸门只看清单内的非缓存边车：唯一边车在 .godot 下 → 仍按「没有 .uid」出 info', ids(cached))
  const cacheCtx = makeCtx([['.godot/uid_cache.bin', 900], ['assets/old.png.uid', 30]],
    { texts: { '.godot/uid_cache.bin': 'uid://cbinqqqq', 'assets/old.png.uid': 'uid://cold0001' } })
  const cacheTree = await T.runUid(cacheCtx.ctx)
  ok(orphansOf(cacheTree).length === 1 && relsOf(orphansOf(cacheTree)[0]).join('|') === 'assets/old.png.uid',
    '判据 1：uid_cache.bin 不是边车（不进孤儿清单），真孤儿照收', relsOf(orphansOf(cacheTree)[0])?.join('|'))
  ok(!cacheCtx.calls.includes('.godot/uid_cache.bin') && !cacheCtx.calls.includes('.godot/imported/sub/x.uid'),
    '判据 1+6：.godot 下的文件一个字都不读', cacheCtx.calls.join('|'))

  // ---------- 2. 判据 2：重复 uid = error ----------
  section('2. 判据 2：重复 uid')
  const two = await T.runUid(makeCtx([
    ['scene/a.tscn', 10], ['scene/b.tres', 10], ['keep.gd', 10], ['keep.gd.uid', 10]
  ], {
    texts: {
      'scene/a.tscn': 'gd_scene load_steps=1 format=3 uid="uid://cshared1"',
      'scene/b.tres': 'gd_resource type="Resource" load_steps=1 format=3 uid="uid://cshared1"',
      'keep.gd.uid': 'uid://ckeep001'
    }
  }).ctx)
  const twoDup = dupsOf(two)
  ok(twoDup.length === 1 && twoDup[0].severity === 'error',
    '场景与资源头部声明同一 uid → 恰好 1 条 error 级结论', `${ids(two)}`)
  ok(twoDup[0] && twoDup[0].rel === 'scene/a.tscn' && twoDup[0].related.join('|') === 'scene/b.tres',
    '判据 2：rel 取字典序第一个声明者，related 列其余全部声明者',
    `${twoDup[0]?.rel} / ${twoDup[0]?.related?.join('|')}`)
  ok(twoDup[0] && twoDup[0].detail.includes('scene/a.tscn') && twoDup[0].detail.includes('scene/b.tres') &&
    twoDup[0].detail.includes('uid://cshared1'),
    '判据 2：detail 同时点名 uid 与两个声明者（简报测试清单那句「两条都列出」按判据 2 落在 rel+related+detail）',
    twoDup[0]?.detail)
  ok(twoDup[0] && !('fix' in twoDup[0]), '判据 2：重复 uid 不带修复（spec §3.1 #5：trash 只给孤儿 .uid）',
    JSON.stringify(twoDup[0]?.fix))
  const sidecars = await T.runUid(makeCtx([
    ['scripts/a.gd', 10], ['scripts/a.gd.uid', 10], ['scripts/b.gd', 10], ['scripts/b.gd.uid', 10]
  ], {
    texts: { 'scripts/a.gd.uid': 'uid://cdup0001', 'scripts/b.gd.uid': 'uid://cdup0001' }
  }).ctx)
  ok(dupsOf(sidecars).length === 1 && dupsOf(sidecars)[0].id === 'uid:dup:uid://cdup0001' &&
    dupsOf(sidecars)[0].related.join('|') === 'scripts/b.gd',
    '判据 2：边文之间重复（两个 .gd.uid 写同一个 uid）→ 1 条', ids(dupsOf(sidecars)))
  // 三个声明者：related 必须是「其余全部」并排序（id 稳定性靠它）
  const three = await T.runUid(makeCtx([
    ['sc/z.tscn', 10], ['sc/a.tscn', 10], ['sc/m.tscn', 10], ['keep.gd', 10], ['keep.gd.uid', 10]
  ], {
    texts: {
      'sc/z.tscn': 'gd_scene uid="uid://cthree1"',
      'sc/a.tscn': 'gd_scene uid="uid://cthree1"',
      'sc/m.tscn': 'gd_scene uid="uid://cthree1"',
      'keep.gd.uid': 'uid://ckeep001'
    }
  }).ctx)
  ok(three.length === 1 && dupsOf(three)[0].rel === 'sc/a.tscn' &&
    dupsOf(three)[0].related.join('|') === 'sc/m.tscn|sc/z.tscn',
    '判据 2：三个声明者 → 1 条结论，rel 取字典序第一、related 其余全部并排序',
    `${dupsOf(three)[0]?.rel} / ${dupsOf(three)[0]?.related?.join('|')}`)
  // 同一 rel 的边文与头部同 uid 不算重复；不同 uid 也不算（那是另一种不一致，本期不判）
  const selfPair = await T.runUid(makeCtx([
    ['scene/m.tscn', 10], ['scene/m.tscn.uid', 10], ['keep.gd', 10], ['keep.gd.uid', 10]
  ], {
    texts: {
      'scene/m.tscn': 'gd_scene uid="uid://cself001"',
      'scene/m.tscn.uid': 'uid://cself001',
      'keep.gd.uid': 'uid://ckeep001'
    }
  }).ctx)
  ok(dupsOf(selfPair).length === 0, '判据 2：同一 rel 的边文与头部同一个 uid 不算重复', ids(selfPair))
  const selfDiff = await T.runUid(makeCtx([
    ['scene/m.tscn', 10], ['scene/m.tscn.uid', 10], ['keep.gd', 10], ['keep.gd.uid', 10]
  ], {
    texts: {
      'scene/m.tscn': 'gd_scene uid="uid://chead001"',
      'scene/m.tscn.uid': 'uid://cside001',
      'keep.gd.uid': 'uid://ckeep001'
    }
  }).ctx)
  ok(dupsOf(selfDiff).length === 0,
    '判据 2：同一 rel 的边文与头部是**不同** uid 也不报（边文 vs 头部不一致本期不判，别顺手加）', ids(selfDiff))
  // 孤儿边文也贡献一条所有权声明，而它归给的那个源已经不在盘上了。此时 rel 必须落在
  // 「树里真看得到」的那一个 —— 指着一个不存在的名字，B10 的跳转/打开所在目录就是死链。
  const dupWithOrphan = await T.runUid(makeCtx([
    ['A.tscn.uid', 10], ['scene/B.tscn', 10], ['keep.gd', 10], ['keep.gd.uid', 10]
  ], {
    texts: {
      'A.tscn.uid': 'uid://cdup0001',
      'scene/B.tscn': 'gd_scene uid="uid://cdup0001"',
      'keep.gd.uid': 'uid://ckeep001'
    }
  }).ctx)
  ok(dupsOf(dupWithOrphan).length === 1, '判据 2：孤儿边文的声明照样参与重复判定', ids(dupWithOrphan))
  ok(dupsOf(dupWithOrphan)[0].rel === 'scene/B.tscn' &&
    dupsOf(dupWithOrphan)[0].related.join('|') === 'A.tscn',
    '判据 2：主证据优先取树里真存在的那个（码元序里 A.tscn 在前，但那是个不存在的名字）',
    `${dupsOf(dupWithOrphan)[0]?.rel} / ${dupsOf(dupWithOrphan)[0]?.related}`)
  ok(orphansOf(dupWithOrphan).length === 1 && relsOf(orphansOf(dupWithOrphan)[0]).join('|') === 'A.tscn.uid',
    '判据 2 与判据 3 互不顶掉:这条既报重复也照样报孤儿 .uid 可清',
    ids(orphansOf(dupWithOrphan)))
  // ext_resource 的 uid= 是**引用**，不是所有权声明：一万次也不算重复
  const BIG_UID = 'uid://cbig0001'
  const REF_UID = 'uid://cref0001'
  const BIG_TSCN = [`gd_scene load_steps=10001 format=3 uid="${BIG_UID}"`]
    .concat(Array.from({ length: 10000 }, (_, i) =>
      `[ext_resource type="Texture2D" uid="${REF_UID}" path="res://assets/t${i}.png" id="${i}_x"]`))
    .join('\n')
  const big = await T.runUid(makeCtx([
    ['scene/big.tscn', 90000], ['scene/a.tscn', 10], ['keep.gd', 10], ['keep.gd.uid', 10]
  ], {
    texts: {
      'scene/big.tscn': BIG_TSCN,
      'scene/a.tscn': `gd_scene uid="${BIG_UID}"`,
      'keep.gd.uid': 'uid://ckeep001'
    }
  }).ctx)
  ok(dupsOf(big).length === 1 && dupsOf(big)[0].id === `uid:dup:${BIG_UID}`,
    '判据 1/2：一万条 [ext_resource uid=] 一条都不算所有权声明（它是引用，不是拥有）', ids(dupsOf(big)))
  ok(dupsOf(big).length === 1 && dupsOf(big)[0].related.join('|') === 'scene/big.tscn' &&
    dupsOf(big)[0].rel === 'scene/a.tscn',
    '判据 1：一万行的场景**自己头部**的 uid 仍被读到（没被大文件跳掉）',
    `${dupsOf(big)[0]?.rel}/${dupsOf(big)[0]?.related?.join('|')}`)
  // 项目闸门只管「缺失」，不该把重复判定一起吞掉
  const nogate = await T.runUid(makeCtx([['scene/a.tscn', 10], ['scene/b.tscn', 10], ['scripts/x.gd', 10]], {
    texts: {
      'scene/a.tscn': 'gd_scene uid="uid://cnogate1"',
      'scene/b.tscn': 'gd_scene uid="uid://cnogate1"'
    }
  }).ctx)
  ok(gateOf(nogate).length === 1 && dupsOf(nogate).length === 1 && missingOf(nogate).length === 0,
    '判据 4 项目闸门只关「缺 .uid」：重复判定照常出，缺失一条都不出', ids(nogate))

  // ---------- 3. 判据 3：孤儿 .uid = warn + trash 修复 ----------
  section('3. 判据 3：孤儿 .uid 与修复管线')
  const oneOrphan = makeCtx([['assets/bg.png.uid', 30], ['keep.gd', 10], ['keep.gd.uid', 10]],
    { texts: { 'assets/bg.png.uid': 'uid://cbg00001', 'keep.gd.uid': 'uid://ckeep001' } })
  const o1 = await T.runUid(oneOrphan.ctx)
  const orphan = orphansOf(o1)[0]
  ok(o1.length === 1 && orphan && orphan.severity === 'warn',
    'X.png.uid 而 X.png 不存在 → 恰好 1 条 warn', ids(o1))
  ok(orphan && orphan.title.includes('.uid'), '孤儿结论的标题点明是 .uid 边车', orphan?.title)
  ok(orphan && orphan.fix && orphan.fix.kind === 'trash' &&
    JSON.stringify(Object.keys(orphan.fix).sort()) === '["kind","label","payload"]',
    '判据 3：fix 只带 kind/label/payload 三键（动词、风险句、预览清单归 fixPlan.ts）',
    JSON.stringify(orphan?.fix && Object.keys(orphan.fix)))
  ok(relsOf(orphan) && relsOf(orphan).join('|') === 'assets/bg.png.uid',
    '判据 3：payload.rels 就是那个边车 rel（交给 movePathsToTrash 的清单）', relsOf(orphan)?.join('|'))
  ok(orphan && String(orphan.fix.label).includes('1') && String(orphan.fix.label).includes('.uid') &&
    !/回收站|永久删除|备份|还原/.test(orphan.fix.label),
    '判据 3：label 给数量但不写平台动词（fixPlan.ts:240 才按 isWin 定「移入回收站/永久删除」）',
    orphan?.fix?.label)
  ok(orphan && orphan.rel === 'assets/bg.png.uid' && orphan.related.join('|') === 'assets/bg.png.uid',
    '判据 3：rel/related 指向列出的孤儿，卡片能跳到具体文件', `${orphan?.rel}/${orphan?.related?.join('|')}`)
  // 与 B1 的对接：同一条 finding 走 planFix，动词/清单都由它给（B10 接线时无需改检查器）
  const planWin = T.planFix(orphan, tree([['assets/bg.png.uid', 30]]), true)
  ok(planWin.service === 'movePathsToTrash' && planWin.verb === '移入回收站' && planWin.empty === false &&
    planWin.items.length === 1 && planWin.items[0].rel === 'assets/bg.png.uid' && planWin.rels.length === 1,
    '★B1 对接：planFix 认这份 payload（verb/预览/可执行性都由它给，检查器没说一句话）',
    JSON.stringify({ s: planWin.service, v: planWin.verb, i: planWin.items, e: planWin.empty }))
  const planMac = T.planFix(orphan, tree([['assets/bg.png.uid', 30]]), false)
  ok(planMac.verb === '永久删除' && planMac.warn.includes('永久删除'),
    '★B1 对接：同一条 finding 在非 Windows 自动换措辞（证明措辞真的没写在检查器里）', planMac.verb)
  // rels 按 rel 字典序（tree 顺序给反的）
  const sorted = await T.runUid(makeCtx([
    ['old/z.gd.uid', 10], ['old/a.gd.uid', 10], ['old/m.gd.uid', 10], ['keep.gd', 10], ['keep.gd.uid', 10]
  ], {
    texts: {
      'old/z.gd.uid': 'uid://cz000001', 'old/a.gd.uid': 'uid://ca000001',
      'old/m.gd.uid': 'uid://cm000001', 'keep.gd.uid': 'uid://ckeep001'
    }
  }).ctx)
  ok(orphansOf(sorted)[0] && relsOf(orphansOf(sorted)[0]).join('|') === 'old/a.gd.uid|old/m.gd.uid|old/z.gd.uid',
    '判据 3：rels 按 rel 字典序，不跟 tree 顺序（否则 id/预览清单每次扫描都抖）',
    relsOf(orphansOf(sorted)[0])?.join('|'))
  // 源存在 → 不是孤儿
  const notOrphan = await T.runUid(makeCtx([['a.gd', 10], ['a.gd.uid', 10]],
    { texts: { 'a.gd.uid': 'uid://cnot0001' } }).ctx)
  ok(orphansOf(notOrphan).length === 0, '判据 3：源文件在清单里就不是孤儿', ids(notOrphan))
  // 清单不全时「查不到源文件」不是证据
  const truncCtx = makeCtx([['old/x.gd.uid', 10], ['keep.gd', 10], ['keep.gd.uid', 10]],
    { trunc: true, texts: { 'old/x.gd.uid': 'uid://cx000001', 'keep.gd.uid': 'uid://ckeep001' } })
  const t1 = await T.runUid(truncCtx.ctx)
  ok(truncOf(t1).length === 1 && truncOf(t1)[0].severity === 'warn',
    '判据 3：ctx.truncated → 出一条 uid:truncated warn', ids(t1))
  ok(orphansOf(t1).length === 0 && missingOf(t1).length === 0 && gateOf(t1).length === 0,
    '判据 3+4：截断时存在性判定一条都不做（孤儿、缺 .uid、项目闸门都不出）', ids(t1))
  ok(!!truncOf(t1)[0] && truncOf(t1)[0].detail.includes('maxEntries') && truncOf(t1)[0].title.includes('截断'),
    '截断结论说清「为什么没做」并给安全动作（不许建议过滤缩小范围）', truncOf(t1)[0]?.detail)
  const truncDup = makeCtx([['scene/a.tscn', 10], ['scene/b.tscn', 10]], {
    trunc: true,
    texts: {
      'scene/a.tscn': 'gd_scene uid="uid://ctrdup01"',
      'scene/b.tscn': 'gd_scene uid="uid://ctrdup01"'
    }
  })
  const t2 = await T.runUid(truncDup.ctx)
  ok(dupsOf(t2).length === 1 && truncOf(t2).length === 1,
    '判据 3 的分工：重复判定只看两个读得到的文件内容，截断时照常做（少报不是错报）', ids(t2))
  // 读不到的边车仍是孤儿：判据 3 吃的是存在性，与内容无关（判据 5 只让「声明」失效）
  const unreadOrphan = await T.runUid(makeCtx([['old/x.gd.uid', 10], ['keep.gd', 10], ['keep.gd.uid', 10]], {
    texts: { 'keep.gd.uid': 'uid://ckeep001' }, fail: { 'old/x.gd.uid': { skipped: true } }
  }).ctx)
  ok(relsOf(orphansOf(unreadOrphan)[0])?.join('|') === 'old/x.gd.uid',
    '判据 3+6：内容读不到的 .uid 只要源文件不在清单里就仍是孤儿（存在性判据不看内容）',
    relsOf(orphansOf(unreadOrphan)[0])?.join('|'))

  // ---------- 4. 判据 4：.gd 缺 .uid（项目闸门 + 目录闸门） ----------
  section('4. 判据 4：缺 .uid 与两道闸门')
  const legacy = await T.runUid(makeCtx([
    ['scripts/a.gd', 10], ['scripts/b.gd', 10], ['scripts/c.gd', 10]
  ], {}).ctx)
  ok(legacy.length === 1 && gateOf(legacy).length === 1 && gateOf(legacy)[0].severity === 'info',
    '项目一个 .uid 都没有 → 只有那条 info（0 条缺失）', ids(legacy))
  ok(!!gateOf(legacy)[0] && gateOf(legacy)[0].detail.includes('4.4') && gateOf(legacy)[0].title.includes('本次不做'),
    '项目闸门的措辞：说明「4.4 之前不生成」并声明本次不做缺失判定', `${gateOf(legacy)[0]?.title}/${gateOf(legacy)[0]?.detail}`)
  // 目录闸门：a.gd 有边文、b.gd 没有 → 报 b.gd。
  // ⚠ 简报测试清单那句「b.gd 的其他每个 .gd 都有 不成立 → 不报」与 spec §3.1 #5
  //   原文「仅当同目录其他 .gd 都有时」以及判据 4 的量词写法相反（a 有边文，所以「其他都有」成立）。
  //   这里按 spec/判据 4 的字面量词执行，并在报告里把这条冲突单独列给控制方裁决。
  const twoGd = await T.runUid(makeCtx([
    ['scripts/a.gd', 10], ['scripts/a.gd.uid', 10], ['scripts/b.gd', 10]
  ], { texts: { 'scripts/a.gd.uid': 'uid://ca000001' } }).ctx)
  ok(missingOf(twoGd).length === 1 && missingOf(twoGd)[0].id === 'uid:missing:scripts/b.gd',
    '目录闸门按字面量词：a 有边文 → b 的「其他每个 .gd 都有」成立 → 报 b.gd（简报括注冲突已在报告里上报）',
    ids(missingOf(twoGd)))
  ok(missingOf(twoGd)[0] && missingOf(twoGd)[0].severity === 'warn' &&
    missingOf(twoGd)[0].detail.includes('scripts/a.gd') &&
    missingOf(twoGd)[0].title.includes('scripts/b.gd'),
    '判据 4：一条 finding 只讲一个 .gd，detail 点名是跟谁比',
    `${missingOf(twoGd)[0]?.title}/${missingOf(twoGd)[0]?.detail}`)
  ok(missingOf(twoGd)[0] && !('fix' in missingOf(twoGd)[0]),
    '判据 4：缺失结论不带修复（spec §3.1 #5：trash 只给孤儿 .uid）', JSON.stringify(missingOf(twoGd)[0]?.fix))
  // 同目录里还有一个 .gd 也没边文 → 那是目录级的既有状态，不报
  const bothMissing = await T.runUid(makeCtx([
    ['scripts/a.gd', 10], ['scripts/b.gd', 10], ['keep.gd', 10], ['keep.gd.uid', 10]
  ], { texts: { 'keep.gd.uid': 'uid://ckeep001' } }).ctx)
  ok(missingOf(bothMissing).length === 0,
    '判据 4 目录闸门：同目录有别的 .gd 也没边文 → 一条都不报', ids(bothMissing))
  const threeGd = await T.runUid(makeCtx([
    ['sc/a.gd', 10], ['sc/a.gd.uid', 10], ['sc/b.gd', 10], ['sc/b.gd.uid', 10], ['sc/c.gd', 10],
    ['keep.gd', 10], ['keep.gd.uid', 10]
  ], {
    texts: { 'sc/a.gd.uid': 'uid://csc00001', 'sc/b.gd.uid': 'uid://csc00002', 'keep.gd.uid': 'uid://ckeep001' }
  }).ctx)
  ok(ids(missingOf(threeGd)) === 'uid:missing:sc/c.gd',
    '判据 4：三个 .gd 里两个有边文一个没有 → 那一个是「别人都有、只它没有」，报（同上※）', ids(threeGd))
  // 单文件目录：其他 .gd 为空集，全称命题真空成立 → 报。这是刻意的读法（见 uid.ts 注释）
  const lone = await T.runUid(makeCtx([
    ['only/x.gd', 10], ['other/y.gd', 10], ['other/y.gd.uid', 10]
  ], { texts: { 'other/y.gd.uid': 'uid://cy000001' } }).ctx)
  ok(ids(missingOf(lone)) === 'uid:missing:only/x.gd',
    '判据 4：目录里唯一的 .gd 没有边文 → 空集全称成立，报（刻意保留这个读法）', ids(lone))
  ok(missingOf(lone)[0] && missingOf(lone)[0].detail.includes('唯一') &&
    !missingOf(lone)[0].detail.includes('other/y.gd'),
    '空目录同伴时的 detail 不假称有同级参照（不能把别的目录的文件说成同级）', missingOf(lone)[0]?.detail)
  // 上面几条报出来的 .gd 全在子目录、同级最多 2 个，于是 detail 的两个分支从没被执行过：
  // 「项目根」那条写法与「同级超过 3 个只点名前 3 个」那条截断写法。零红的判据等于没测（简报要求）。
  const rootLone = await T.runUid(makeCtx([
    ['root.gd', 10], ['sub/y.gd', 10], ['sub/y.gd.uid', 10]
  ], { texts: { 'sub/y.gd.uid': 'uid://csub0001' } }).ctx)
  ok(missingOf(rootLone)[0] && missingOf(rootLone)[0].detail.includes('（项目根）'),
    '判据 4：根目录里唯一的 .gd → detail 说「（项目根）」而不是空目录名',
    missingOf(rootLone)[0]?.detail)
  const manySiblings = await T.runUid(makeCtx([
    ['big/a.gd', 10], ['big/a.gd.uid', 10], ['big/b.gd', 10], ['big/b.gd.uid', 10],
    ['big/c.gd', 10], ['big/c.gd.uid', 10], ['big/d.gd', 10], ['big/d.gd.uid', 10],
    ['big/z.gd', 10]
  ], {
    texts: {
      'big/a.gd.uid': 'uid://cbb00001', 'big/b.gd.uid': 'uid://cbb00002',
      'big/c.gd.uid': 'uid://cbb00003', 'big/d.gd.uid': 'uid://cbb00004'
    }
  }).ctx)
  ok(missingOf(manySiblings).length === 1 && / 等/.test(missingOf(manySiblings)[0].detail),
    '判据 4：同级超过 3 个时 detail 走「等」的截断分支', missingOf(manySiblings)[0]?.detail)
  ok(missingOf(manySiblings)[0].detail.includes('其他 4 个') &&
    missingOf(manySiblings)[0].detail.includes('big/a.gd') &&
    missingOf(manySiblings)[0].detail.includes('big/c.gd') &&
    !missingOf(manySiblings)[0].detail.includes('big/d.gd'),
    '截断只点名前 3 个（第四个进计数、不进名单），计数说全部', missingOf(manySiblings)[0]?.detail)
  // 自己有边文的 .gd 永不报；根目录与其它目录互不影响
  const hasUid = await T.runUid(makeCtx([['scripts/a.gd', 10], ['scripts/a.gd.uid', 10]],
    { texts: { 'scripts/a.gd.uid': 'uid://chu00001' } }).ctx)
  ok(missingOf(hasUid).length === 0, '判据 4：已有边文的 .gd 不报缺失', ids(hasUid))
  const cacheGd = await T.runUid(makeCtx([
    ['.godot/gen/kept.gd', 10], ['keep.gd', 10], ['keep.gd.uid', 10]
  ], { texts: { 'keep.gd.uid': 'uid://ckeep001' } }).ctx)
  ok(missingOf(cacheGd).length === 0, '判据 4：.godot 下的 .gd 不参与缺失判定', ids(cacheGd))
  const twoDirs = await T.runUid(makeCtx([
    ['a/one.gd', 10], ['a/two.gd', 10], ['a/two.gd.uid', 10],
    ['b/one.gd', 10], ['b/two.gd', 10], ['b/two.gd.uid', 10]
  ], {
    texts: { 'a/two.gd.uid': 'uid://caa00001', 'b/two.gd.uid': 'uid://cbb00001' }
  }).ctx)
  ok(ids(missingOf(twoDirs)) === 'uid:missing:a/one.gd|uid:missing:b/one.gd',
    '判据 4：两个目录各缺一个 → 两条独立结论，id 落到具体文件、按 rel 排序', ids(twoDirs))
  ok(!twoDirs.some((f) => f.id === 'uid:gate:no-uid'),
    '项目里有边车时不再出那条 info', ids(twoDirs))

  // ---------- 5. 判据 5：token 合法性 ----------
  section('5. 判据 5：非法 token 当作没有声明')
  ok(T.isUidToken('uid://cscena1') && !T.isUidToken('uid://BAD') && !T.isUidToken('uid://<invalid>') &&
    !T.isUidToken('uid://') && !T.isUidToken('') && !T.isUidToken('uid://cscena1 ') &&
    !T.isUidToken(undefined),
    'isUidToken 的形状判据（大写/<invalid>/空/尾空格/非串都不是 uid）—— 与 refIndex 同一份实现',
    [T.isUidToken('uid://cscena1'), T.isUidToken('uid://BAD'), T.isUidToken('uid://<invalid>')].join('/'))
  const bad = await T.runUid(makeCtx([
    ['scripts/a.gd', 10], ['scripts/a.gd.uid', 10], ['scripts/b.gd', 10], ['scripts/b.gd.uid', 10]
  ], {
    texts: { 'scripts/a.gd.uid': 'uid://BAD', 'scripts/b.gd.uid': 'uid://BAD' }
  }).ctx)
  ok(dupsOf(bad).length === 0,
    '两个边文都写 uid://BAD → 不报重复（放宽大小写就会报出一个引擎根本不认的「重复」）', ids(bad))
  const junk = await T.runUid(makeCtx([
    ['a/x.uid', 10], ['b/x.uid', 10], ['c/x.uid', 10], ['d/x.uid', 10], ['e/x.uid', 10],
    ['keep.gd', 10], ['keep.gd.uid', 10]
  ], {
    texts: {
      'a/x.uid': '', 'b/x.uid': 'uid://', 'c/x.uid': 'uid://<invalid>', 'd/x.uid': '\n\n  \n',
      // 两份同样的非法内容：不做合法性校验的实现会把它们配成「同一个 uid 被两个文件声明」
      'e/x.uid': 'uid://<invalid>',
      'keep.gd.uid': 'uid://ckeep001'
    }
  }).ctx)
  ok(dupsOf(junk).length === 0,
    '空/只有 uid:///<invalid>/纯空白 → 一律当作没有声明，不臆造成 uid', ids(junk))
  ok(!junk.some((f) => (f.detail || '').includes('uid://<invalid>')),
    '结论里不出现被臆造出来的 uid 串', junk.map((f) => f.detail).join('|'))
  // CRLF / 前后空格 / 多一行都要还能取出 token（取出没用的话重复就漏报）
  const messy = await T.runUid(makeCtx([
    ['sc/a.gd', 10], ['sc/a.gd.uid', 10], ['sc/b.tscn', 10], ['sc/c.tres', 10]
  ], {
    texts: {
      'sc/a.gd.uid': 'uid://cmess001\r\n',
      'sc/b.tscn': 'gd_scene uid="uid://cmess001"',
      'sc/c.tres': '  uid://cnotahead1  \n'
    }
  }).ctx)
  ok(dupsOf(messy).length === 1 && dupsOf(messy)[0].id === 'uid:dup:uid://cmess001',
    '判据 5：边文 CRLF + 头部同 uid 仍配成一对（空白与行尾吸收掉）', ids(messy))
  const messy2 = await T.runUid(makeCtx([
    ['p/a.gd', 10], ['p/a.gd.uid', 10], ['p/b.gd', 10], ['p/b.gd.uid', 10],
    ['p/c.gd', 10], ['p/c.gd.uid', 10], ['p/d.tscn', 10]
  ], {
    texts: {
      'p/a.gd.uid': '  uid://cmess002  \n\n',
      'p/b.gd.uid': 'uid://cmess002',
      // 「多一行」：token 在第一行，后面还有别的行（Godot 实际只写一行，畸形文件按第一行取）
      'p/c.gd.uid': 'uid://cmess003\nsecond_line=whatever',
      'p/d.tscn': 'gd_scene uid="uid://cmess003"'
    }
  }).ctx)
  ok(ids(dupsOf(messy2)) === 'uid:dup:uid://cmess002|uid:dup:uid://cmess003' &&
    missingOf(messy2).length === 0 && orphansOf(messy2).length === 0,
    '判据 5：前后空格、多余空行、后面还有一行都取得到 token（三对重复都配得出，取不到就是漏报）', ids(messy2))
  const headless = await T.runUid(makeCtx([
    ['scene/a.tscn', 10], ['scene/b.tscn', 10], ['keep.gd', 10], ['keep.gd.uid', 10]
  ], {
    texts: {
      // a.tscn 的 uid= 写在**第三行**的 [ext_resource] 上（头部那一行没有 uid=）→ 不是所有权声明；
      // b.tscn 的头部有同一个 uid → 只有一个声明者，不构成重复
      'scene/a.tscn': 'gd_scene load_steps=2 format=3\n\n[ext_resource type="Script" uid="uid://chead002" path="res://keep.gd" id="1_s"]',
      'scene/b.tscn': 'gd_scene load_steps=1 format=3 uid="uid://chead002"',
      'keep.gd.uid': 'uid://ckeep001'
    }
  }).ctx)
  ok(dupsOf(headless).length === 0,
    '判据 1：所有权声明只看**第一行**的 uid=（第二行往后的都是引用，不收）', ids(headless))
  // 边文首行不是合法 token 就当没有声明：不往后面的行里捞（捞到的东西不能替用户当真），也不报格式错误
  const laterLine = await T.runUid(makeCtx([
    ['q/a.gd', 10], ['q/a.gd.uid', 10], ['q/b.tscn', 10]
  ], {
    texts: { 'q/a.gd.uid': '# 手写坏了\nuid://clater01', 'q/b.tscn': 'gd_scene uid="uid://clater01"' }
  }).ctx)
  ok(dupsOf(laterLine).length === 0 && laterLine.length === 0,
    '判据 5：边文只有首行参与取值，首行非法就当没有声明（往后面行里捞就会报出这条重复）', ids(laterLine))

  // ---------- 6. 判据 6：成本红线与读不到的三态 ----------
  section('6. 判据 6：只读该读的，读不到就跳过')
  const cost = makeCtx(CLEAN_SPECS, CLEAN)
  await T.runUid(cost.ctx)
  const wantReads = ['scene/main.tscn', 'scene/main.tscn.uid', 'scripts/player.gd.uid', 'scripts/npc.gd.uid']
  ok([...new Set(cost.calls)].sort().join('|') === [...wantReads].sort().join('|'),
    '★判据 6：只读 .uid 边车与 .tscn/.tres —— .gd/.png/.import/project.godot/README 一个字都不读',
    [...new Set(cost.calls)].join('|'))
  ok(!cost.calls.some((r) => r.endsWith('.gd') || r.endsWith('.import') || r === 'project.godot'),
    '判据 6：为了 uid 检查不读脚本/导入元数据/配置（那是 B5/B6/B8 的读取面）', cost.calls.join('|'))
  const unread = await T.runUid(makeCtx([
    ['scene/a.tscn', 10], ['scene/b.tscn', 10], ['scene/c.tscn', 10], ['keep.gd', 10], ['keep.gd.uid', 10]
  ], {
    texts: { 'scene/c.tscn': 'gd_scene uid="uid://cunread1"', 'keep.gd.uid': 'uid://ckeep001' },
    // 两份读不到的场景（超限 / 二进制各一种形态）+ 一份读得到的
    fail: { 'scene/a.tscn': { skipped: true }, 'scene/b.tscn': {} }
  }).ctx)
  ok(dupsOf(unread).length === 0 && unread.every((f) => f.severity !== 'error'),
    '判据 6：超限/二进制读不到 → 这些文件的声明当作未知，不进重复也不报错（漏读不得变假阳性）', ids(unread))
  ok(unread.length === 0,
    '判据 6：读不到的两份场景一条结论都不产（读得到的那份只有一个声明者，也不该被顶出重复）', ids(unread))
  const unreadSidecar = await T.runUid(makeCtx([
    ['s/a.gd', 10], ['s/a.gd.uid', 10], ['s/c.gd', 10], ['s/c.gd.uid', 10], ['s/b.tscn', 10]
  ], {
    texts: { 's/b.tscn': 'gd_scene uid="uid://cur00001"' },
    fail: { 's/a.gd.uid': { skipped: true }, 's/c.gd.uid': {} }
  }).ctx)
  ok(dupsOf(unreadSidecar).length === 0,
    '判据 6：读不到的两份边车不产声明，也不被归成「同一个空 uid」的假重复', ids(unreadSidecar))
  ok(orphansOf(unreadSidecar).length === 0,
    '判据 6：读不到的边车若源文件在清单里，不因读失败被误判成孤儿', ids(unreadSidecar))
  const empty = await T.runUid(makeCtx([]).ctx)
  ok(Array.isArray(empty) && ids(empty) === 'uid:gate:no-uid',
    '空清单：判据 4 的项目闸门按字面执行（0 个边车也是「没有 .uid」），除此之外一条都不造', ids(empty))

  // ---------- 7. 判据 7：规模上限 ----------
  section('7. 判据 7：大清单的上限与 rels 全量')
  const manySpecs = []
  const manyTexts = {}
  for (let i = 0; i < 60; i++) {
    const n = String(i).padStart(2, '0')
    manySpecs.push([`old/s${n}.gd.uid`, 30])
    manyTexts[`old/s${n}.gd.uid`] = `uid://co${n}000001`
  }
  manySpecs.push(['keep.gd', 10], ['keep.gd.uid', 10])
  manyTexts['keep.gd.uid'] = 'uid://ckeep001'
  const manyCtx = makeCtx(manySpecs, { texts: manyTexts })
  const many = await T.runUid(manyCtx.ctx)
  const manyOrphan = orphansOf(many)[0]
  ok(many.length === 1 && manyOrphan && relsOf(manyOrphan).length === 60,
    '判据 7：60 个孤儿仍只有 1 条结论，payload.rels 含全部 60 个', `${many.length}/${relsOf(manyOrphan)?.length}`)
  ok(manyOrphan && manyOrphan.related.length === 20,
    '判据 7：只列前 20 个（刷屏上限，同 size.ts 的 BIG_LIST=20）', manyOrphan?.related.length)
  ok(manyOrphan && manyOrphan.detail.includes('另有 40 个') && manyOrphan.detail.includes('仍按全部 60'),
    '判据 7：汇总要说「还有多少没列」并保证「一键全量」覆盖全部', manyOrphan?.detail)
  ok(manyOrphan && String(manyOrphan.fix.label).includes('60'),
    '判据 7：label 的数量是总数而不是列出的行数（否则删完还剩一半，卡片却说删过了）', manyOrphan?.fix?.label)
  const manyPlan = T.planFix(manyOrphan, tree(manySpecs), true)
  ok(manyPlan.items.length === 60 && manyPlan.rels.length === 60 && manyPlan.empty === false,
    '★判据 7 × spec §5.3 规则 3：确认框的完整清单来自 payload.rels，展示上限不裁预览（无冲突）',
    `${manyPlan.items.length}/${manyPlan.rels.length}`)
  ok(manyCtx.calls.length === 61 && new Set(manyCtx.calls).size === 61,
    '判据 6+7：一个边车读一次，不重复读（61 个边车 = 61 次 readText）', `${manyCtx.calls.length}`)
  const dupSpecs = []
  const dupTexts = { 'keep.gd.uid': 'uid://ckeep001' }
  dupSpecs.push(['keep.gd', 10], ['keep.gd.uid', 10])
  for (let i = 0; i < 25; i++) {
    const n = String(i).padStart(2, '0')
    const a = `sc/a${n}.tscn`
    const b = `sc/b${n}.tscn`
    dupSpecs.push([a, 10], [b, 10])
    dupTexts[a] = `gd_scene uid="uid://cu${n}000001"`
    dupTexts[b] = `gd_scene uid="uid://cu${n}000001"`
  }
  const manyDup = await T.runUid(makeCtx(dupSpecs, { texts: dupTexts }).ctx)
  ok(dupsOf(manyDup).length === 20, '判据 7：25 组重复只列前 20 组', dupsOf(manyDup).length)
  ok(dupsOf(manyDup).map((f) => f.id)[0] === 'uid:dup:uid://cu00000001' &&
    dupsOf(manyDup).map((f) => f.id)[19] === 'uid:dup:uid://cu19000001',
    '判据 7+8：列出的是 uid 字典序前 20 组（不含数组下标进 id）',
    `${dupsOf(manyDup)[0]?.id} … ${dupsOf(manyDup)[19]?.id}`)
  const tail = manyDup.find((f) => f.id === 'uid:dupTail')
  ok(!!tail && tail.severity === 'error' && tail.title.includes('另有 5 组') &&
    tail.detail.includes('共 25 组') && tail.detail.includes('只列前 20 组'),
    '判据 7：差额单独成一条汇总结论，说清还有多少组没列（条数按全量算）', tail ? `${tail.title}/${tail.detail}` : '无 uid:dupTail')
  ok(!!tail && tail.title.includes('5') && !tail.id.includes('5'),
    '判据 7+8：汇总的 id 不带数量（数量每次扫描都变，带进 key 会让折叠记忆漂移）', `${tail?.id}/${tail?.title}`)
  ok(manyDup.length === 21, '判据 7：重复 20 条 + 汇总 1 条 = 21 条，没有别的结论混进来', ids(manyDup))

  // ---------- 8. 判据 8：id 与确定性 ----------
  section('8. 判据 8：id 与确定性')
  const det = [
    ['sc/z.tscn', 10], ['sc/a.tscn', 10], ['old/z.gd.uid', 10], ['old/a.gd.uid', 10],
    ['only/x.gd', 10], ['keep.gd', 10], ['keep.gd.uid', 10]
  ]
  const detTexts = {
    'sc/z.tscn': 'gd_scene uid="uid://cthree1"',
    'sc/a.tscn': 'gd_scene uid="uid://cthree1"',
    'old/z.gd.uid': 'uid://cz000001',
    'old/a.gd.uid': 'uid://ca000001',
    'keep.gd.uid': 'uid://ckeep001'
  }
  const run1 = await T.runUid(makeCtx(det, { texts: detTexts }).ctx)
  const run2 = await T.runUid(makeCtx(det, { texts: detTexts }).ctx)
  const runRev = await T.runUid(makeCtx([...det].reverse(), { texts: detTexts }).ctx)
  const mix = [det[3], det[5], det[1], det[4], det[0], det[2], det[6]]
  const runMix = await T.runUid(makeCtx(mix, { texts: detTexts }).ctx)
  const dump = (fs) => JSON.stringify(fs)
  ok(dump(run1) === dump(run2), '判据 8：同一份清单两次运行 findings 逐字节一致', `${run1.length}/${run2.length}`)
  ok(dump(run1) === dump(runRev), '判据 8：文件顺序打乱（反序）后 findings 与每条 id 逐字节一致',
    `${ids(run1)} vs ${ids(runRev)}`)
  ok(dump(run1) === dump(runMix), '判据 8：任意交错顺序同样一致（结论不靠 tree 下标）', ids(runMix))
  ok(run1.every((f) => !/\d{10,}|[Tt]rue|null/.test(f.id)) && new Set(run1.map((f) => f.id)).size === run1.length,
    '判据 8：id 里没有时间戳/布尔/空值，且互不重复', ids(run1))
  ok(dupsOf(run1).length === 1 && orphansOf(run1).length === 1 && missingOf(run1).length === 1,
    '判据 8 夹具自检：三类判据在同一次运行里都有产出（确定性断言不是空转）', ids(run1))
  ok(orphansOf(run1)[0].id === orphansOf(many)[0].id,
    '判据 8：聚合结论的 id 不随数量漂移（3 个孤儿与 60 个孤儿同一条 —— 忽略记忆才不会被换键）',
    `${orphansOf(run1)[0]?.id}/${orphansOf(many)[0]?.id}`)
  // 排序口径要钉死成 UTF-16 码元，不是 localeCompare：`a.gd.uid` 与 `a_1.gd.uid` 这种
  // 任何文件系统都能共存的组合，两种口径给出的先后是**反的**（ICU 把 '_' 排在 '.' 之前），
  // 用 locale 就会随宿主语言环境换掉 related 的顺序与 rel 的选取 —— 结论 id 与折叠记忆跟着抖。
  const caseRun = await T.runUid(makeCtx([
    ['old/a.gd.uid', 10], ['old/a_1.gd.uid', 10], ['sc/a.tscn', 10], ['sc/a_1.tscn', 10]
  ], {
    texts: {
      'old/a.gd.uid': 'uid://ccase001', 'old/a_1.gd.uid': 'uid://ccase002',
      'sc/a.tscn': 'gd_scene uid="uid://ccase003"', 'sc/a_1.tscn': 'gd_scene uid="uid://ccase003"'
    }
  }).ctx)
  ok(orphansOf(caseRun)[0] && orphansOf(caseRun)[0].related.join('|') === 'old/a.gd.uid|old/a_1.gd.uid',
    '判据 8：孤儿 rels 按码元序（localeCompare 会把 a_1 排到 a 前面）',
    orphansOf(caseRun)[0]?.related?.join('|'))
  ok(dupsOf(caseRun)[0] && dupsOf(caseRun)[0].rel === 'sc/a.tscn' &&
    dupsOf(caseRun)[0].related.join('|') === 'sc/a_1.tscn',
    '判据 2+8：重复结论的「字典序第一个声明者」同样按码元序',
    `${dupsOf(caseRun)[0]?.rel}/${dupsOf(caseRun)[0]?.related?.join('|')}`)
}

main().catch((e) => {
  console.error(`\n测试脚本抛错: ${e && e.stack ? e.stack : e}`)
  process.exit(1)
}).then(() => {
  console.log(`\n${'='.repeat(56)}\nPASS ${pass}  FAIL ${failures.length}`)
  if (failures.length) { console.log('失败项:'); for (const f of failures) console.log('  - ' + f); process.exit(1) }
  console.log('全部通过')
})
