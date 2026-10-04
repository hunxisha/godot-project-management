// 工具页 B7：addons 体检（src/tools/inspectors/addons.ts）的断言。
//
// ⚠ 本工具**只报告**：简报第 9-11 行钉死「连 kind:'existing' 也不带」（那会被 planFix 当成一次
//   跳转执行，而落点是 B10 的视图活）。所以末尾那条「ALL 每条结论都不带 fix」的全局断言是本轮
//   红线之一；另一条是 ★ 大小写闸 —— script 写成 MISSING.GD 而树里有异体时**不许**出 error，
//   那是本工具唯一的 error 档，报错了就等于对用户说「你的插件坏了」。
//   全局断言靠 addons() 收集器把每次 run() 的产出都收进 ALL，将来新判据只要挂上 fix 就会红。
//
// 夹具是「内存文件树 + readText 桩」，与 imports/uid/orphans 测试同一份口径（extOf/tree/makeCtx）。
// calls 记 readText 问过的 rel —— 成本红线（只读 addons/*/plugin.cfg 与 project.godot，
// 不调 buildRefIndex、不读 .gd 正文）全靠它。
//
// 用法（npm script 会先跑打包步骤）:
//   node src/composables/__tests__/build-bundle.mjs && node src/tools/__tests__/addons.test.mjs
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

/** ext 推导与原语两端逐字一致（照 imports/uid/orphans 测试的同一份实现） */
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

/**
 * plugin.cfg 正文。键值为 undefined ⇒ 整行不写（判据 3 的「缺失」）；字符串 ⇒ 加引号；
 * `{raw}` ⇒ 等号右侧原样（测裸值、空值与畸形形态，判据 1 的 getIni 读法）。
 */
function cfg(fields) {
  const out = ['[plugin]', '']
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue
    out.push(typeof v === 'object' && v.raw !== undefined ? `${k}=${v.raw}` : `${k}="${v}"`)
  }
  return out.join('\n') + '\n'
}

/** 字段齐全的样板（script 用市场插件常见的相对写法，判据 4 不判它的存在性） */
const FULL = { name: 'Foo', description: 'demo plugin', author: 'me', version: '1.0.0', script: 'plugin.gd' }

/** project.godot 正文,只带 [editor_plugins] enabled 一行;[] 就是 PackedStringArray() */
function iniEnabled(entries) {
  return [
    'config_version=5',
    '',
    '[application]',
    '',
    'config/name="Demo"',
    '',
    '[editor_plugins]',
    '',
    `enabled=PackedStringArray(${entries.map((e) => `"${e}"`).join(', ')})`,
    ''
  ].join('\n')
}

/** 没有 [editor_plugins] 段的项目（本仓「已安装」页在这种项目里也判全部未启用） */
const NO_SECTION = 'config_version=5\n\n[application]\n\nconfig/name="Demo"\n'

const fieldsOf = (fs) => fs.filter((f) => f.id.startsWith('addons:fields:'))
const scriptOf = (fs) => fs.filter((f) => f.id.startsWith('addons:script-missing:'))
const enMissOf = (fs) => fs.filter((f) => f.id.startsWith('addons:enabled-missing:'))
const notEnOf = (fs) => fs.filter((f) => f.id.startsWith('addons:not-enabled:'))
const dupOf = (fs) => fs.filter((f) => f.id.startsWith('addons:dup-name:'))
const ids = (fs) => fs.map((f) => f.id).join('|')
/** detail 的安全取法(B10b 那批断言要正则匹配它,缺卡时得报 FAIL 而不是抛 TypeError) */
const det = (f) => (f && typeof f.detail === 'string' ? f.detail : '(无 detail)')
const sevOf = (fs) => fs.map((f) => `${f.id}=${f.severity}`).join('|')

/** 全局收集器:每条结论都进 ALL(末尾的零 fix 红线与形状红线吃它),并核对 rel 落在本次 tree 里 */
const ALL = []
const REL_OK = []
async function addons(specs, opts = {}) {
  const m = makeCtx(specs, opts)
  const fs = await T.runAddons(m.ctx)
  const rels = new Set(m.ctx.tree.map((f) => f.rel))
  for (const f of fs) {
    ALL.push(f)
    // 降级卡是项目级的,本来就没有主证据文件(与 imports/uid 的 truncatedFinding 同形)
    if (f.id === 'addons:truncated') continue
    REL_OK.push(typeof f.rel === 'string' && rels.has(f.rel))
  }
  return { fs, calls: m.calls }
}

async function main() {
  // ---------- 1. 接线 + 判据 2 的扫描面(防噪音主闸) ----------
  section('1. 接线与扫描面')
  ok(typeof T.runAddons === 'function' && T.runAddons.length === 1,
    'run(ctx) 已进 barrel,签名与 size/cache/brokenRefs/uid/orphans/imports 同形', typeof T.runAddons)

  const CLEAN_SPECS = [['project.godot', 400], ['addons/Foo/plugin.cfg', 120], ['addons/Foo/plugin.gd', 900]]
  const CLEAN_TEXTS = {
    'addons/Foo/plugin.cfg': cfg(FULL),
    'project.godot': iniEnabled(['res://addons/Foo/plugin.cfg'])
  }
  const clean = await addons(CLEAN_SPECS, { texts: CLEAN_TEXTS })
  ok(clean.fs.length === 0,
    '★干净项目(字段齐全、script 存在、已在 enabled 里)→ 0 条结论', ids(clean.fs))
  ok(clean.calls.join('|') === 'addons/Foo/plugin.cfg|project.godot',
    '成本红线:读入面只有候选 plugin.cfg 与 project.godot,各一次(不读 .gd 正文、不建引用索引)',
    clean.calls.join('|'))

  const cleanRes = await addons(
    [['project.godot', 400], ['addons/Foo/plugin.cfg', 120], ['addons/Foo/entry.gd', 900]],
    { texts: { 'addons/Foo/plugin.cfg': cfg({ ...FULL, script: 'res://addons/Foo/entry.gd' }), 'project.godot': iniEnabled(['res://addons/Foo/plugin.cfg']) } }
  )
  ok(cleanRes.fs.length === 0,
    'script 写成 res:// 且文件在清单里 → 0 条(判据 4 的正向半边)', ids(cleanRes.fs))

  const PACK_SPECS = [
    ['project.godot', 400],
    ['addons/pack/hero.png', 1], ['addons/pack/LICENSE.md', 1], ['addons/pack/icons/x.svg', 1],
    ['addons/fonts/mono.ttf', 1]
  ]
  const pack = await addons(PACK_SPECS, { texts: { 'project.godot': iniEnabled([]) } })
  ok(pack.fs.length === 0 && pack.calls.join('|') === 'project.godot',
    '★防噪音主闸:addons 下没有 plugin.cfg 的子目录(素材包/字体集)一条都不报、也不读', ids(pack.fs))
  const packNeg = await addons([...PACK_SPECS, ['addons/pack/plugin.cfg', 50]],
    { texts: { 'addons/pack/plugin.cfg': cfg({ ...FULL, name: 'Pack', version: undefined }), 'project.godot': iniEnabled(['res://addons/pack/plugin.cfg']) } })
  ok(packNeg.fs.length === 1 && packNeg.fs[0]?.id === 'addons:fields:pack' && packNeg.fs[0]?.severity === 'info',
    '反向对照:同一批目录里放一份 plugin.cfg 就出结论(上一条 0 结论不是空转)', ids(packNeg.fs))

  const deep = await addons(
    [['project.godot', 400], ['addons/A/plugin.cfg', 50], ['addons/A/B/plugin.cfg', 50], ['addons/A/B/deep.gd', 10]],
    { texts: { 'addons/A/plugin.cfg': cfg({ ...FULL, name: 'A', version: undefined }), 'addons/A/B/plugin.cfg': cfg({ name: 'B' }), 'project.godot': iniEnabled(['res://addons/A/plugin.cfg']) } }
  )
  ok(ids(deep.fs) === 'addons:fields:A' && !(deep.fs[0]?.detail || '').includes('addons/A/B'),
    '深层 addons/A/B/plugin.cfg 完全不参与(字段、未启用、重名三条都不判),只有浅层那条', ids(deep.fs))

  const inCache = await addons(
    [['project.godot', 400], ['.godot/addons/Foo/plugin.cfg', 50]],
    { texts: { '.godot/addons/Foo/plugin.cfg': cfg({ name: 'Foo' }), 'project.godot': iniEnabled([]) } }
  )
  ok(inCache.fs.length === 0,
    '.godot 里的 addons 副本不是插件候选(第一段不是 addons 就不进面)', ids(inCache.fs))

  const upper = await addons(
    [['project.godot', 400], ['addons/Foo/PLUGIN.CFG', 50]],
    { texts: { 'addons/Foo/PLUGIN.CFG': cfg({ name: 'Foo' }), 'project.godot': iniEnabled([]) } }
  )
  ok(upper.fs.length === 0,
    '文件名只认 plugin.cfg 这一种写法:PLUGIN.CFG 不进面(方向是少报,不是判它坏了)', ids(upper.fs))

  const upperDir = await addons(
    [['project.godot', 400], ['Addons/Foo/plugin.cfg', 50]],
    { texts: { 'Addons/Foo/plugin.cfg': cfg({ name: undefined, script: undefined }), 'project.godot': iniEnabled([]) } }
  )
  ok(upperDir.fs.length === 0 && upperDir.calls.join('|') === 'project.godot',
    '第一段也只认 addons 这一种拼写:Addons/Foo/plugin.cfg 不进面、也不读(与 orphans/imports 的 isAddon 同一口径)',
    `${ids(upperDir.fs)}|${upperDir.calls.join('|')}`)

  const emptyDir = await addons(
    [['project.godot', 400], ['addons//plugin.cfg', 50]],
    { texts: { 'addons//plugin.cfg': cfg({ name: undefined }), 'project.godot': iniEnabled([]) } }
  )
  ok(emptyDir.fs.length === 0 && emptyDir.calls.join('|') === 'project.godot',
    '畸形 rel(addons//plugin.cfg 的空目录段)不进面:不给它编一个空目录名的 id,也不读它',
    `${ids(emptyDir.fs)}|${emptyDir.calls.join('|')}`)

  // 目录名恰好叫 plugin.cfg 是盘上真的能出现的形态(有人建了这么个文件夹),候选必须要求它是**最后一段**
  const cfgDir = await addons(
    [['project.godot', 400], ['addons/Foo/plugin.cfg/keep.txt', 50]],
    { texts: { 'addons/Foo/plugin.cfg/keep.txt': cfg({ name: undefined }), 'project.godot': iniEnabled([]) } }
  )
  ok(cfgDir.fs.length === 0 && cfgDir.calls.join('|') === 'project.godot',
    'addons/Foo/plugin.cfg/keep.txt(同名目录)不进面:段数闸门要求 plugin.cfg 就是第三段',
    `${ids(cfgDir.fs)}|${cfgDir.calls.join('|')}`)

  const noSidecar = await addons(
    [['project.godot', 400], ['addons/Foo/plugin.cfg', 120], ['addons/Foo/icon.png', 900]],
    { texts: { 'addons/Foo/plugin.cfg': cfg(FULL), 'project.godot': iniEnabled(['res://addons/Foo/plugin.cfg']) } }
  )
  ok(noSidecar.fs.length === 0,
    '判据 7:addons 资产的 .import 边车缺不缺失不由本工具判(B6 记为 P0b 已知缺口)', ids(noSidecar.fs))

  // ---------- 2. 判据 1 + 3:字段两档,一个插件一条 ----------
  section('2. 必填字段两档')
  const noLoad = await addons(CLEAN_SPECS, {
    texts: { 'addons/Foo/plugin.cfg': cfg({ description: 'd', author: 'me', version: '1.0' }), 'project.godot': iniEnabled(['res://addons/Foo/plugin.cfg']) }
  })
  ok(ids(noLoad.fs) === 'addons:fields:Foo' && noLoad.fs[0]?.severity === 'warn',
    '缺 name+script(加载档)→ 一条 warn,id 按插件目录', `${ids(noLoad.fs)}/${sevOf(noLoad.fs)}`)
  ok(/加载必需档缺：plugin\/name、plugin\/script/.test(noLoad.fs[0]?.detail || ''),
    'warn 档缺项在 detail 里一次列全', noLoad.fs[0]?.detail)
  ok(!/元信息档缺/.test(noLoad.fs[0]?.detail || ''),
    'warn 档独占时不出现元信息档那一组', noLoad.fs[0]?.detail)

  const noVer = await addons(CLEAN_SPECS, {
    texts: { 'addons/Foo/plugin.cfg': cfg({ ...FULL, version: undefined }), 'project.godot': iniEnabled(['res://addons/Foo/plugin.cfg']) }
  })
  ok(ids(noVer.fs) === 'addons:fields:Foo' && noVer.fs[0]?.severity === 'info',
    '只缺 version → 一条 info(不升 warn,更不升 error)', `${ids(noVer.fs)}/${sevOf(noVer.fs)}`)
  ok(/元信息档缺：plugin\/version/.test(noVer.fs[0]?.detail || '') && !/加载必需档缺/.test(noVer.fs[0]?.detail || ''),
    'info 档缺项单独成组,不冒充加载档', noVer.fs[0]?.detail)

  const both = await addons(CLEAN_SPECS, {
    texts: { 'addons/Foo/plugin.cfg': cfg({ description: 'd', author: 'me' }), 'project.godot': iniEnabled(['res://addons/Foo/plugin.cfg']) }
  })
  ok(both.fs.length === 1 && both.fs[0]?.severity === 'warn',
    '★两档同时缺也只出一条(取高的一档定 severity),不是一个字段一张卡片', `${both.fs.length}/${sevOf(both.fs)}`)
  ok((both.fs[0]?.detail || '').indexOf('加载必需档缺') < (both.fs[0]?.detail || '').indexOf('元信息档缺'),
    'detail 里两档固定序:加载档在前(它决定 severity),元信息档在后', both.fs[0]?.detail)

  const blank = await addons(CLEAN_SPECS, {
    texts: { 'addons/Foo/plugin.cfg': cfg({ name: '', description: 'd', author: ' ', version: '1.0', script: { raw: '' } }), 'project.godot': iniEnabled(['res://addons/Foo/plugin.cfg']) }
  })
  ok(blank.fs.length === 1 && /plugin\/name/.test(blank.fs[0]?.detail || '') &&
    /plugin\/script/.test(blank.fs[0]?.detail || '') && /plugin\/author/.test(blank.fs[0]?.detail || ''),
    '空串与纯空白都算「空」(name=""、script=、author=" "),而且不因 script 空而造 error 卡',
    `${ids(blank.fs)}|${blank.fs[0]?.detail}`)
  ok(!/script 不是 res:\/\/ 写法/.test(blank.fs[0]?.detail || ''),
    '空着的 script 不算「写法不对、不判存在性」(缺失与形态不兼容是两件事,计数不许混起来)',
    blank.fs[0]?.detail)

  const allMissing = await addons(CLEAN_SPECS, {
    texts: { 'addons/Foo/plugin.cfg': '', 'project.godot': iniEnabled(['res://addons/Foo/plugin.cfg']) }
  })
  ok(allMissing.fs.length === 1 && ['name', 'script', 'description', 'author', 'version']
    .every((k) => (allMissing.fs[0]?.detail || '').includes(`plugin/${k}`)),
    '空正文 → 一条 warn 把五个键全列出来(缺什么一次说完)', allMissing.fs[0]?.detail)

  const extraKey = await addons(CLEAN_SPECS, {
    texts: { 'addons/Foo/plugin.cfg': cfg(FULL) + 'odd="x"\n\n[extra]\n\nwhatever=1\n', 'project.godot': iniEnabled(['res://addons/Foo/plugin.cfg']) }
  })
  ok(extraKey.fs.length === 0,
    '判据 7:plugin.cfg 里的多余字段/多余段一律不判', ids(extraKey.fs))

  const eqInValue = await addons(CLEAN_SPECS, {
    texts: { 'addons/Foo/plugin.cfg': cfg({ ...FULL, description: 'A=B' }), 'project.godot': iniEnabled(['res://addons/Foo/plugin.cfg']) }
  })
  ok(eqInValue.fs.length === 0,
    '判据 1:走 B2 的解析器,值里带 = 的 description 不被读成缺失(只在第一个 = 处切)', ids(eqInValue.fs))

  const bareName = await addons(CLEAN_SPECS, {
    texts: { 'addons/Foo/plugin.cfg': cfg({ ...FULL, name: { raw: 'Foo' }, script: { raw: 'res://addons/Foo/plugin.gd' } }), 'project.godot': iniEnabled(['res://addons/Foo/plugin.cfg']) }
  })
  ok(bareName.fs.length === 0,
    '判据 1:没加引号的值按裸串读(getIni 判据 8),既不报缺失也照样能判存在性', ids(bareName.fs))

  const noSection = await addons(CLEAN_SPECS, {
    texts: { 'addons/Foo/plugin.cfg': 'name="Foo"\nversion="1.0"\n', 'project.godot': iniEnabled(['res://addons/Foo/plugin.cfg']) }
  })
  ok(noSection.fs.length === 1 && /plugin\/name/.test(noSection.fs[0]?.detail || '') &&
    noSection.fs[0]?.severity === 'warn',
    '键都在顶层、没有 [plugin] 段时按 plugin/ 前缀取键 → 报缺字段,detail 用 fullKey 形态让用户看得懂',
    ids(noSection.fs))

  const dupKey = await addons(CLEAN_SPECS, {
    texts: { 'addons/Foo/plugin.cfg': cfg(FULL) + 'name="Foo2"\n', 'project.godot': iniEnabled(['res://addons/Foo/plugin.cfg']) }
  })
  ok(dupKey.fs.length === 0,
    '重复键取最后一条(getIni 既有规则),本工具不判重复(那是配置校验那条线的活)', ids(dupKey.fs))

  // ---------- 3. 判据 4:script 指向的文件必须存在(唯一 error) ----------
  section('3. 入口脚本存在性(唯一 error)')
  const gone = await addons([['project.godot', 400], ['addons/Foo/plugin.cfg', 120]], {
    texts: { 'addons/Foo/plugin.cfg': cfg({ ...FULL, script: 'res://addons/Foo/missing.gd' }), 'project.godot': iniEnabled(['res://addons/Foo/plugin.cfg']) }
  })
  ok(ids(gone.fs) === 'addons:script-missing:Foo' && gone.fs[0]?.severity === 'error',
    'script 指向清单里没有的文件 → 一条 error,这是本工具唯一的 error 档', `${ids(gone.fs)}/${sevOf(gone.fs)}`)
  ok(gone.fs[0]?.rel === 'addons/Foo/plugin.cfg' &&
    (gone.fs[0]?.detail || '').includes('res://addons/Foo/missing.gd') &&
    (gone.fs[0]?.detail || '').includes('addons/Foo/missing.gd'),
    'error 的主证据是读得到的 plugin.cfg(跳转不会指到丢失的脚本),detail 同时给原值与归一 rel',
    `${gone.fs[0]?.rel}|${gone.fs[0]?.detail}`)
  ok(/任意大小写写法都没有/.test(gone.fs[0]?.detail || ''),
    'error 的证据口径写进 detail:任意大小写写法都没有才算不在', gone.fs[0]?.detail)

  const caseVariant = await addons(
    [['project.godot', 400], ['addons/Foo/plugin.cfg', 120], ['addons/foo/MISSING.gd', 900]],
    { texts: { 'addons/Foo/plugin.cfg': cfg({ ...FULL, script: 'res://addons/foo/missing.gd' }), 'project.godot': iniEnabled(['res://addons/Foo/plugin.cfg']) } }
  )
  ok(caseVariant.fs.length === 0,
    '★大小写闸:script 写成 res://addons/foo/missing.gd 而树里有 addons/foo/MISSING.gd → 不报 error',
    ids(caseVariant.fs))
  const caseVariant2 = await addons(
    [['project.godot', 400], ['addons/Foo/plugin.cfg', 120], ['addons/Foo/Missing.GD', 900]],
    { texts: { 'addons/Foo/plugin.cfg': cfg({ ...FULL, script: 'res://addons/FOO/MISSING.GD' }), 'project.godot': iniEnabled(['res://addons/Foo/plugin.cfg']) } }
  )
  ok(caseVariant2.fs.length === 0,
    '★同一道闸的另一侧:script 写法与树里的写法两侧都可能是异体 → 仍不报', ids(caseVariant2.fs))
  // 上面两条只断言「不报」。没有正向对照就没人证明那份 cfg 真的进了扫描面 ——
  // 短路在任何一道前置闸(深度、大小写、fields 判定)上都能伪装成「大小写闸生效了」。
  const caseVariantCtrl = await addons(
    [['project.godot', 400], ['addons/Foo/plugin.cfg', 120]],
    { texts: { 'addons/Foo/plugin.cfg': cfg({ ...FULL, script: 'res://addons/foo/missing.gd' }), 'project.godot': iniEnabled(['res://addons/Foo/plugin.cfg']) } }
  )
  ok(ids(caseVariantCtrl.fs).includes('addons:script-missing:Foo'),
    '★大小写闸的正向对照:同一份 cfg 把树里那份异体文件拿掉就出 error(证明它确实进了面、闸是唯一拦下来的东西)',
    ids(caseVariantCtrl.fs))

  const oddScripts = await addons(
    [
      ['project.godot', 400],
      ['addons/U1/plugin.cfg', 50], ['addons/U2/plugin.cfg', 50], ['addons/U3/plugin.cfg', 50],
      ['addons/U4/plugin.cfg', 50], ['addons/U5/plugin.cfg', 50], ['addons/U6/plugin.cfg', 50]
    ],
    {
      texts: {
        'addons/U1/plugin.cfg': cfg({ ...FULL, name: 'U1', script: 'user://x.gd' }),
        'addons/U2/plugin.cfg': cfg({ ...FULL, name: 'U2', script: 'res://C:/Windows/x.gd' }),
        'addons/U3/plugin.cfg': cfg({ ...FULL, name: 'U3', script: 'res://../outside.gd' }),
        'addons/U4/plugin.cfg': cfg({ ...FULL, name: 'U4', script: 'res://' }),
        'addons/U5/plugin.cfg': cfg({ ...FULL, name: 'U5', script: 'plugin.gd' }),
        'addons/U6/plugin.cfg': cfg({ ...FULL, name: 'U6', script: 'sub/entry.gd' }),
        'project.godot': iniEnabled([
          'res://addons/U1/plugin.cfg', 'res://addons/U2/plugin.cfg', 'res://addons/U3/plugin.cfg',
          'res://addons/U4/plugin.cfg', 'res://addons/U5/plugin.cfg', 'res://addons/U6/plugin.cfg'
        ])
      }
    }
  )
  ok(oddScripts.fs.length === 0,
    '判据 4 不判的形态:user://、带盘符、越界 ..、裸 res://、相对文件名(市场插件主流写法)全部不臆造「脚本丢失」',
    ids(oddScripts.fs))

  const oddNote = await addons(
    [['project.godot', 400], ['addons/U1/plugin.cfg', 50], ['addons/U2/plugin.cfg', 50]],
    {
      texts: {
        'addons/U1/plugin.cfg': cfg({ ...FULL, name: 'U1', script: 'plugin.gd', version: undefined }),
        'addons/U2/plugin.cfg': cfg({ ...FULL, name: 'U2', script: 'user://x.gd', version: undefined }),
        'project.godot': iniEnabled(['res://addons/U1/plugin.cfg', 'res://addons/U2/plugin.cfg'])
      }
    }
  )
  ok(oddNote.fs.length === 2 && /script 不是 res:\/\/ 写法、不判存在性的 2 个/.test(oddNote.fs[0]?.detail || ''),
    '「不判」要看得见:排除计数并进 detail(与 imports 的 ex.ignore 同一表达方式)', oddNote.fs[0]?.detail)

  // ---- B10b 债 6:形状闸接进判据 4/5 的两扇存在性门(只撤主张) ----
  // 为什么存在:`filled()` 已经 trim 两端，所以 script 这一侧真正多挡的是「以 , ; ) ] 收尾」那一种；
  // enabled 那一侧吃 getIniList 的解码原值，首尾空白与尾巴标点两样都新挡。两条都能让 resToRel
  // 切出「路径 + 尾巴」那种永远查不到的 rel，于是判据 4 会对**其实存在的入口脚本**发本工具唯一的 error。
  const scriptTail = await addons(
    [['project.godot', 400], ['addons/Foo/plugin.cfg', 120], ['addons/Foo/entry.gd', 900]],
    {
      texts: {
        'addons/Foo/plugin.cfg': cfg({ ...FULL, name: 'Foo', script: { raw: '"res://addons/Foo/entry.gd,"' }, version: undefined }),
        'project.godot': iniEnabled(['res://addons/Foo/plugin.cfg'])
      }
    }
  )
  ok(scriptTail.fs.length === 1 && scriptTail.fs[0]?.id === 'addons:fields:Foo' && !scriptOf(scriptTail.fs).length,
    '★script 带尾逗号不再判存在性:entry.gd 明明在清单里，旧闸归一成 `addons/Foo/entry.gd,` 后说出 error',
    ids(scriptTail.fs))
  ok(/script 以标点收尾\(, ; \) \]、那是「值到这里结束了」的分隔符不是路径的一部分\)、不判存在性的 1 个/.test(det(scriptTail.fs[0])),
    '★被闸挡下的那条要计进「本次未判定」，且不混进「不是 res:// 写法」那笔(两句说的是不同的事)', det(scriptTail.fs[0]))
  const scriptTailCtrl = await addons(
    [['project.godot', 400], ['addons/Foo/plugin.cfg', 120], ['addons/Foo/entry.gd', 900]],
    {
      texts: {
        'addons/Foo/plugin.cfg': cfg({ ...FULL, name: 'Foo', script: 'res://addons/Foo/gone.gd,' }),
        'project.godot': iniEnabled(['res://addons/Foo/plugin.cfg'])
      }
    }
  )
  ok(scriptTailCtrl.fs.length === 0,
    '带尾巴的目标**真的不在清单**时同样不判(撤主张不等于反过来说它在；这一条本次没判，见上一条计数)',
    ids(scriptTailCtrl.fs))
  const scriptCleanCtrl = await addons(
    [['project.godot', 400], ['addons/Foo/plugin.cfg', 120], ['addons/Foo/entry.gd', 900]],
    {
      texts: {
        'addons/Foo/plugin.cfg': cfg({ ...FULL, name: 'Foo', script: 'res://addons/Foo/gone.gd' }),
        'project.godot': iniEnabled(['res://addons/Foo/plugin.cfg'])
      }
    }
  )
  ok(ids(scriptCleanCtrl.fs) === 'addons:script-missing:Foo' && scriptCleanCtrl.fs[0]?.severity === 'error',
    '★正向对照:干净的 res:// 而脚本真不在清单 → 那条 error 一条没少(闸没把正常判定一起吃掉)', ids(scriptCleanCtrl.fs))
  // 合法的内部空格（Godot 允许路径里有空格）不属于「首尾脏」，两档都照常判
  const nameSpace = await addons(
    [['project.godot', 400], ['addons/My Plugin/plugin.cfg', 120], ['addons/My Plugin/entry.gd', 900]],
    {
      texts: {
        'addons/My Plugin/plugin.cfg': cfg({ ...FULL, name: 'My Plugin', script: 'res://addons/My Plugin/entry.gd' }),
        'project.godot': iniEnabled(['res://addons/My Plugin/plugin.cfg'])
      }
    }
  )
  ok(nameSpace.fs.length === 0,
    '★正向对照:内部空格合法(`addons/My Plugin/…`)两档都不受影响(共享闸只判首尾)', ids(nameSpace.fs))

  const enTailSpace = await addons(CLEAN_SPECS, {
    texts: { 'addons/Foo/plugin.cfg': cfg(FULL), 'project.godot': iniEnabled(['res://addons/Foo/plugin.cfg ']) }
  })
  ok(enMissOf(enTailSpace.fs).length === 0 && notEnOf(enTailSpace.fs).length === 1 &&
    /enabled 里首尾带空白或以标点收尾\(, ; \) \]、归一出来的串不是那条路径本身\)、不判的 1 条/.test(det(enTailSpace.fs[0])),
    '★enabled 条目带尾空格:不报「点名的配置不在清单里」(那条 warn 旧写法照发)，计数上卡；' +
    '「已安装但未启用」那侧新旧一致(带尾巴的 rel 结构上对不上 plugin.cfg 这个 basename)',
    `${ids(enTailSpace.fs)}|${det(enTailSpace.fs[0])}`)
  const enTailComma = await addons(CLEAN_SPECS, {
    texts: { 'addons/Foo/plugin.cfg': cfg(FULL), 'project.godot': iniEnabled(['res://addons/Foo/plugin.cfg,']) }
  })
  ok(enMissOf(enTailComma.fs).length === 0 && /、不判的 1 条/.test(det(enTailComma.fs[0])),
    'enabled 条目带尾逗号同样不判并计数', `${ids(enTailComma.fs)}|${det(enTailComma.fs[0])}`)
  const enMissCtrl = await addons(CLEAN_SPECS, {
    texts: { 'addons/Foo/plugin.cfg': cfg({ ...FULL, script: 'res://addons/Foo/plugin.gd' }), 'project.godot': iniEnabled(['res://addons/Gone/plugin.cfg']) }
  })
  ok(ids(enMissCtrl.fs) === 'addons:enabled-missing:addons/gone/plugin.cfg|addons:not-enabled:Foo' &&
    enMissCtrl.fs[0]?.severity === 'warn' && !/本次未判定/.test(det(enMissCtrl.fs[0])),
    '★正向对照:干净写法而配置真不在清单 → 那条 warn 一条没少，且**没有任何东西被挡下时一句「本次未判定」都不写**',
    `${ids(enMissCtrl.fs)}|${det(enMissCtrl.fs[0])}`)
  const enClean = await addons(CLEAN_SPECS, {
    texts: { 'addons/Foo/plugin.cfg': cfg({ ...FULL, script: 'res://addons/Foo/plugin.gd', version: undefined }), 'project.godot': iniEnabled(['res://addons/Foo/plugin.cfg']) }
  })
  ok(ids(enClean.fs) === 'addons:fields:Foo' && !/本次未判定/.test(det(enClean.fs[0])),
    '正向对照:同一条 enabled 去掉尾巴就 0 笔不判、字段卡也不带那句(闸的措辞不会常驻在每张卡上)',
    `${ids(enClean.fs)}|${det(enClean.fs[0])}`)

  const unread = await addons(
    [['project.godot', 400], ['addons/Off/plugin.cfg', 50], ['addons/Ok/plugin.cfg', 50]],
    {
      texts: { 'addons/Ok/plugin.cfg': cfg({ ...FULL, name: 'Ok', author: undefined }), 'project.godot': iniEnabled(['res://addons/Off/plugin.cfg']) },
      fail: { 'addons/Off/plugin.cfg': { skipped: true } }
    }
  )
  ok(ids(unread.fs) === 'addons:fields:Ok|addons:not-enabled:Ok' &&
    /plugin\.cfg 读不到 1 个/.test(unread.fs[0]?.detail || ''),
    '读不到的 plugin.cfg 一条内容判据都不出,但计数看得见;「未启用」只看清单实存,照常出',
    `${ids(unread.fs)}|${unread.fs[0]?.detail}`)

  // ---------- 4. 判据 5:enabled 与磁盘实存,两个方向分开报 ----------
  section('4. enabled 一致性(两个方向)')
  const enMiss = await addons(CLEAN_SPECS, {
    texts: { 'addons/Foo/plugin.cfg': cfg(FULL), 'project.godot': iniEnabled(['res://addons/Foo/plugin.cfg', 'res://addons/Gone/plugin.cfg']) }
  })
  ok(ids(enMiss.fs) === 'addons:enabled-missing:addons/gone/plugin.cfg' && enMiss.fs[0]?.severity === 'warn',
    'enabled 点了名而文件不在清单 → warn,一条点名一个目标', `${ids(enMiss.fs)}/${sevOf(enMiss.fs)}`)
  ok(enMiss.fs[0]?.rel === 'project.godot' &&
    (enMiss.fs[0]?.detail || '').includes('res://addons/Gone/plugin.cfg'),
    'warn 的主证据是那条 enabled 所在的 project.godot,detail 带上启用清单里的原值',
    `${enMiss.fs[0]?.rel}|${enMiss.fs[0]?.detail}`)

  const enCase = await addons(
    [['project.godot', 400], ['addons/foo/plugin.cfg', 120], ['addons/foo/plugin.gd', 900]],
    { texts: { 'addons/foo/plugin.cfg': cfg(FULL), 'project.godot': iniEnabled(['res://addons/FOO/plugin.cfg']) } }
  )
  ok(enCase.fs.length === 0,
    '★同一条大小写口径:enabled 写 res://addons/FOO/plugin.cfg 而清单是 addons/foo/plugin.cfg → 不算缺失',
    ids(enCase.fs))
  const enCase2 = await addons(
    [['project.godot', 400], ['addons/Foo/plugin.cfg', 120], ['addons/Foo/plugin.gd', 900]],
    { texts: { 'addons/Foo/plugin.cfg': cfg(FULL), 'project.godot': iniEnabled(['res://addons/FOO/plugin.cfg']) } }
  )
  ok(enCase2.fs.length === 0,
    '★同一条口径的第二方向:清单是 addons/Foo/plugin.cfg、enabled 写 res://addons/FOO/plugin.cfg → 不算「未启用」',
    ids(enCase2.fs))

  const notEn = await addons(CLEAN_SPECS, {
    texts: { 'addons/Foo/plugin.cfg': cfg(FULL), 'project.godot': iniEnabled([]) }
  })
  ok(ids(notEn.fs) === 'addons:not-enabled:Foo' && notEn.fs[0]?.severity === 'info',
    '磁盘有 plugin.cfg 而 enabled 里没有 → info(用户选择,不是错)', `${ids(notEn.fs)}/${sevOf(notEn.fs)}`)
  ok(notEn.fs[0] !== undefined && !('fix' in notEn.fs[0]) && /已安装但未启用/.test(notEn.fs[0]?.detail || ''),
    '「已安装但未启用」措辞 + 零 fix(简报钉死本工具不发任何修复动作)', notEn.fs[0]?.detail)

  const noSec = await addons(
    [['project.godot', 400], ['addons/Foo/plugin.cfg', 120], ['addons/Bar/plugin.cfg', 120]],
    { texts: { 'addons/Foo/plugin.cfg': cfg({ ...FULL, name: 'Foo' }), 'addons/Bar/plugin.cfg': cfg({ ...FULL, name: 'Bar' }), 'project.godot': NO_SECTION } }
  )
  ok(ids(noSec.fs) === 'addons:not-enabled:Bar|addons:not-enabled:Foo',
    '没有 [editor_plugins] 段 = 启用清单为空(与本仓「已安装」页同口径),每个插件一条 info', ids(noSec.fs))

  const badEnabled = await addons(
    [['project.godot', 400], ['addons/Foo/plugin.cfg', 120]],
    { texts: { 'addons/Foo/plugin.cfg': cfg(FULL), 'project.godot': '[editor_plugins]\n\nenabled="res://addons/Foo/plugin.cfg"\n' } }
  )
  ok(badEnabled.fs.length === 0,
    'enabled 的值形态认不出(getIniList 给 undefined:既不是 PackedStringArray 也不是数组)→ 两个方向都不判',
    ids(badEnabled.fs))

  const noIni = await addons(
    [['addons/Foo/plugin.cfg', 120]],
    { texts: { 'addons/Foo/plugin.cfg': cfg({ ...FULL, version: undefined }) } }
  )
  ok(ids(noIni.fs) === 'addons:fields:Foo' && /project\.godot 读不到/.test(noIni.fs[0]?.detail || ''),
    'project.godot 不在清单 → 启用状态两条判据都不做,并在 detail 里说明', `${ids(noIni.fs)}|${noIni.fs[0]?.detail}`)

  const enOdd = await addons(
    [['project.godot', 400], ['addons/Foo/plugin.cfg', 120]],
    { texts: { 'addons/Foo/plugin.cfg': cfg(FULL), 'project.godot': iniEnabled(['res://addons/Foo/plugin.cfg', 'user://x/plugin.cfg', 'res://dev/foo/plugin.cfg']) } }
  )
  ok(ids(enOdd.fs) === 'addons:enabled-missing:dev/foo/plugin.cfg',
    '启用清单里非 res:// 的条目不判;addons 目录之外的启用目标同样按存在性判(判据不限 addons 内)',
    ids(enOdd.fs))

  const enDup = await addons(
    [['project.godot', 400], ['addons/Foo/plugin.cfg', 120]],
    { texts: { 'addons/Foo/plugin.cfg': cfg(FULL), 'project.godot': iniEnabled(['res://addons/Foo/plugin.cfg', 'res://addons/Gone/plugin.cfg', 'res://addons//Gone///plugin.cfg']) } }
  )
  ok(enDup.fs.length === 1 && (enDup.fs[0]?.detail || '').includes('res://addons//Gone///plugin.cfg'),
    '同一目标的两种写法归并成一条结论,而两种原样写法都留在 detail 里', `${enDup.fs.length}|${enDup.fs[0]?.detail}`)

  // ---------- 5. 判据 5 尾条:显示名重复 ----------
  section('5. 插件显示名重复')
  const dup = await addons(
    [['project.godot', 400], ['addons/One/plugin.cfg', 50], ['addons/Two/plugin.cfg', 50]],
    { texts: { 'addons/One/plugin.cfg': cfg({ ...FULL, name: 'My Tool' }), 'addons/Two/plugin.cfg': cfg({ ...FULL, name: 'my tool ' }), 'project.godot': iniEnabled(['res://addons/One/plugin.cfg', 'res://addons/Two/plugin.cfg']) } }
  )
  ok(ids(dup.fs) === 'addons:dup-name:my tool' && dup.fs[0]?.severity === 'warn',
    '两个插件显示名相同(trim + 大小写不敏感)→ 一条 warn,id 用小写显示名', `${ids(dup.fs)}/${sevOf(dup.fs)}`)
  ok((dup.fs[0]?.detail || '').includes('addons/One/plugin.cfg') && (dup.fs[0]?.detail || '').includes('addons/Two/plugin.cfg'),
    'warn 把每一个同名插件都点名(证据全列)', dup.fs[0]?.detail)
  ok(dup.fs[0]?.rel === 'addons/One/plugin.cfg' && dup.fs[0]?.related?.join('|') === 'addons/Two/plugin.cfg',
    '主证据取码元序第一个 cfg,其余进 related(都是树里真看得到的文件)', `${dup.fs[0]?.rel}|${dup.fs[0]?.related}`)

  const dup3 = await addons(
    [['project.godot', 400], ['addons/A/plugin.cfg', 50], ['addons/B/plugin.cfg', 50], ['addons/C/plugin.cfg', 50]],
    { texts: { 'addons/A/plugin.cfg': cfg({ ...FULL, name: 'X' }), 'addons/B/plugin.cfg': cfg({ ...FULL, name: 'x' }), 'addons/C/plugin.cfg': cfg({ ...FULL, name: ' X ' }), 'project.godot': iniEnabled(['res://addons/A/plugin.cfg', 'res://addons/B/plugin.cfg', 'res://addons/C/plugin.cfg']) } }
  )
  ok(dup3.fs.length === 1 && (dup3.fs[0]?.detail || '').split('plugin.cfg').length === 4,
    '三个插件同名也只出一条,证据三条全列', `${dup3.fs.length}|${dup3.fs[0]?.detail}`)

  const noDup = await addons(
    [['project.godot', 400], ['addons/One/plugin.cfg', 50], ['addons/Two/plugin.cfg', 50]],
    { texts: { 'addons/One/plugin.cfg': cfg({ ...FULL, name: 'One' }), 'addons/Two/plugin.cfg': cfg({ ...FULL, name: 'Two' }), 'project.godot': iniEnabled(['res://addons/One/plugin.cfg', 'res://addons/Two/plugin.cfg']) } }
  )
  ok(noDup.fs.length === 0, '显示名不同 → 不出重名结论', ids(noDup.fs))

  const blankName = await addons(
    [['project.godot', 400], ['addons/One/plugin.cfg', 50], ['addons/Two/plugin.cfg', 50]],
    { texts: { 'addons/One/plugin.cfg': cfg({ ...FULL, name: '' }), 'addons/Two/plugin.cfg': cfg({ ...FULL, name: '' }), 'project.godot': iniEnabled(['res://addons/One/plugin.cfg', 'res://addons/Two/plugin.cfg']) } }
  )
  ok(dupOf(blankName.fs).length === 0 && fieldsOf(blankName.fs).length === 2,
    'name 为空的插件不参与重名(两个空名不是「同名的两个插件」),各进字段那条', ids(blankName.fs))

  // ---------- 6. 判据 6:.gdignore 闸门 ----------
  section('6. .gdignore 闸门')
  const ignored = await addons(
    [['project.godot', 400], ['addons/Off/.gdignore', 0], ['addons/Off/plugin.cfg', 50], ['addons/Ok/plugin.cfg', 50]],
    { texts: { 'addons/Off/plugin.cfg': cfg({ name: undefined, script: undefined }), 'addons/Ok/plugin.cfg': cfg({ ...FULL, name: 'Ok', version: undefined }), 'project.godot': iniEnabled(['res://addons/Ok/plugin.cfg']) } }
  )
  ok(ids(ignored.fs) === 'addons:fields:Ok' && /\.gdignore 屏蔽的插件目录 1 个/.test(ignored.fs[0]?.detail || ''),
    '被 .gdignore 屏蔽的 addon 全跳过(字段/脚本/启用状态/重名都不判),计数并进 detail',
    `${ids(ignored.fs)}|${ignored.fs[0]?.detail}`)
  ok(ignored.calls.includes('addons/Ok/plugin.cfg') && !ignored.calls.includes('addons/Off/plugin.cfg'),
    '屏蔽目录里的 plugin.cfg 连读都不读(IO 也不浪费在不会判的文件上)', ignored.calls.join('|'))

  const allIgnored = await addons(
    [['project.godot', 400], ['addons/.gdignore', 0], ['addons/Off/plugin.cfg', 50], ['addons/Other/plugin.cfg', 50]],
    { texts: { 'addons/Off/plugin.cfg': cfg({ name: 'Off' }), 'addons/Other/plugin.cfg': cfg({ name: 'Off' }), 'project.godot': iniEnabled([]) } }
  )
  ok(allIgnored.fs.length === 0,
    '整层 addons 被屏蔽时一条都不报(字段、重名、未启用全都不不判)', ids(allIgnored.fs))

  const rootIgnored = await addons(
    [['project.godot', 400], ['.gdignore', 0], ['addons/Off/plugin.cfg', 50]],
    { texts: { 'addons/Off/plugin.cfg': cfg({ name: 'Off' }), 'project.godot': iniEnabled([]) } }
  )
  ok(rootIgnored.fs.length === 0, '根目录的 .gdignore 屏蔽整棵树 → 0 条(isGdignored 的空前缀那条分支)', ids(rootIgnored.fs))

  // ---------- 7. ctx.truncated:存在性两条停用,内容型三条照出 ----------
  section('7. 截断降级')
  const TRUNC_SPECS = [
    ['project.godot', 400],
    ['addons/Foo/plugin.cfg', 120], ['addons/Idle/plugin.cfg', 120],
    ['addons/D1/plugin.cfg', 120], ['addons/D2/plugin.cfg', 120]
  ]
  const TRUNC_TEXTS = {
    'addons/Foo/plugin.cfg': cfg({ ...FULL, name: undefined, script: 'res://addons/Foo/gone.gd' }),
    'addons/Idle/plugin.cfg': cfg({ ...FULL, name: 'Idle' }),
    'addons/D1/plugin.cfg': cfg({ ...FULL, name: 'Dup' }),
    'addons/D2/plugin.cfg': cfg({ ...FULL, name: 'Dup' }),
    'project.godot': iniEnabled(['res://addons/Foo/plugin.cfg', 'res://addons/Gone/plugin.cfg', 'res://addons/D1/plugin.cfg', 'res://addons/D2/plugin.cfg'])
  }
  const fullRun = await addons(TRUNC_SPECS, { texts: TRUNC_TEXTS })
  ok(ids(fullRun.fs) === 'addons:script-missing:Foo|addons:dup-name:dup|addons:enabled-missing:addons/gone/plugin.cfg|addons:fields:Foo|addons:not-enabled:Idle',
    '完整清单下的全类别顺序(定死的类别序:存在性 error → 内容型 warn → 字段 → 未启用)', ids(fullRun.fs))
  const truncRun = await addons(TRUNC_SPECS, { texts: TRUNC_TEXTS, trunc: true })
  ok(truncRun.fs[0]?.id === 'addons:truncated' && truncRun.fs[0]?.severity === 'warn',
    '降级卡排首位', ids(truncRun.fs))
  ok(scriptOf(truncRun.fs).length === 0 && enMissOf(truncRun.fs).length === 0,
    '★截断时存在性两条判据都不出(入口脚本缺失 / enabled 点名文件不在)', ids(truncRun.fs))
  ok(ids(truncRun.fs) === 'addons:truncated|addons:dup-name:dup|addons:fields:Foo|addons:not-enabled:Idle',
    '字段缺失、重名、未启用三条是内容型判据 → 截断时照常出(与 B6 裁定 3 同一读法)', ids(truncRun.fs))
  ok(/本次不做/.test(truncRun.fs[0]?.title || '') && /字段|重名|未启用/.test(truncRun.fs[0]?.detail || ''),
    '截断卡说清做了什么、没做什么', `${truncRun.fs[0]?.title}|${truncRun.fs[0]?.detail}`)

  ok(!('rel' in truncRun.fs[0]), '降级卡不带 rel(项目级结论没有主证据文件,末尾的 rel 红线按 id 放过它)', Object.keys(truncRun.fs[0]).join('|'))
  // ---------- 8. 确定性与 id 稳定 ----------
  section('8. 顺序与 id 稳定')
  const rev = await addons([...TRUNC_SPECS].reverse(), { texts: TRUNC_TEXTS })
  ok(JSON.stringify(rev.fs) === JSON.stringify(fullRun.fs),
    '反序 tree → findings 逐字节一致(顺序只由证据推导,不由扫描顺序)', ids(rev.fs))
  const shuffled = await addons(
    [TRUNC_SPECS[3], TRUNC_SPECS[0], TRUNC_SPECS[4], TRUNC_SPECS[1], TRUNC_SPECS[2]],
    { texts: TRUNC_TEXTS }
  )
  ok(JSON.stringify(shuffled.fs) === JSON.stringify(fullRun.fs),
    '交错 tree 顺序 → 同一份结论', ids(shuffled.fs))
  ok(shuffled.calls.join('|') === rev.calls.join('|'),
    '读取顺序也定死(候选按 rel 码元序读、project.godot 收尾),tree 抖动不重读文件',
    `${shuffled.calls.join('|')} vs ${rev.calls.join('|')}`)

  const twice = await addons(
    [['project.godot', 400], ['addons/Foo/plugin.cfg', 120], ['addons/Foo/plugin.cfg', 120], ['addons/foo/plugin.cfg', 120]],
    { texts: { 'addons/Foo/plugin.cfg': cfg(FULL), 'addons/foo/plugin.cfg': cfg(FULL), 'project.godot': iniEnabled(['res://addons/Foo/plugin.cfg']) } }
  )
  ok(twice.fs.length === 0 && twice.calls.length === 2,
    '同一份 cfg 的重复条目/大小写异体按小写像归并成一个插件目录,只读一次也不重复出卡',
    `${ids(twice.fs)}|${twice.calls.join('|')}`)

  const dirs = Array.from({ length: 60 }, (_, i) => `P${String(i).padStart(2, '0')}`)
  const bigTail = await addons(
    [['project.godot', 400], ...dirs.map((d) => [`addons/${d}/plugin.cfg`, 50])],
    {
      texts: {
        ...Object.fromEntries(dirs.map((d) => [`addons/${d}/plugin.cfg`, cfg({ ...FULL, name: d, version: undefined })])),
        'project.godot': iniEnabled(dirs.map((d) => `res://addons/${d}/plugin.cfg`))
      }
    }
  )
  ok(bigTail.fs.length === 60 && bigTail.fs.every((f) => f.severity === 'info'),
    '60 个插件都缺 version → 60 条 info(一插件一条,不是 60×5 条字段卡)', `${bigTail.fs.length}`)

  const noTree = await addons([], { texts: {} })
  ok(noTree.fs.length === 0 && noTree.calls.length === 0,
    '空清单:0 结论、0 读取(不臆造「项目坏了」)', ids(noTree.fs))

  const iniCase = await addons(
    [['Project.godot', 400], ['addons/Foo/plugin.cfg', 120]],
    { texts: { 'Project.godot': iniEnabled([]), 'addons/Foo/plugin.cfg': cfg(FULL) } }
  )
  ok(ids(iniCase.fs) === 'addons:not-enabled:Foo' && iniCase.calls.includes('Project.godot'),
    '根目录 project.godot 的大小写异体也认(读的是 tree 里真存在的那个 rel 名)', `${ids(iniCase.fs)}|${iniCase.calls}`)

  // ---------- 9. 全局红线 ----------
  section('9. 全局红线(上面每一条结论)')
  ok(ALL.length > 40 && ALL.every((f) => !('fix' in f)),
    `★零 fix 面:全部 ${ALL.length} 条结论一条都不带 fix 字段(spec #7 只报告,跳转落点是 B10 的视图活)`,
    ALL.filter((f) => 'fix' in f).map((f) => f.id).join('|'))
  const withRel = ALL.filter((f) => f.id !== 'addons:truncated').length
  ok(REL_OK.length === withRel && REL_OK.length > 0 && REL_OK.every(Boolean),
    `除降级卡外每条结论的 rel 都在本次 tree 里(${REL_OK.length} 条,跳转不会是死链)`,
    `${REL_OK.filter(Boolean).length}/${withRel}`)
  ok(ALL.every((f) => f.id.startsWith('addons:') && ['error', 'warn', 'info'].includes(f.severity) &&
      typeof f.title === 'string' && f.title.length > 0),
    'id 一律 addons: 前缀、severity 合法、title 非空',
    ALL.filter((f) => !f.id.startsWith('addons:')).map((f) => f.id).join('|'))
  ok(ALL.every((f) => !/\d{10,}|[Tt]rue|null|undefined/.test(f.id)),
    'id 只由证据(目录名/路径/显示名)推导,不含大数字、布尔、null/undefined 串味',
    ALL.filter((f) => /\d{10,}|[Tt]rue|null|undefined/.test(f.id)).map((f) => f.id).join('|'))
  ok(ALL.filter((f) => !f.id.startsWith('addons:script-missing:')).every((f) => f.severity !== 'error'),
    `error 档只有「入口脚本不存在」一条(${ALL.filter((f) => f.id.startsWith('addons:script-missing:')).length} 条),其余判据永不升 error`,
    ALL.filter((f) => f.severity === 'error' && !f.id.startsWith('addons:script-missing:')).map((f) => f.id).join('|'))
}

main().catch((e) => {
  console.error(`\n测试脚本抛错: ${e && e.stack ? e.stack : e}`)
  process.exit(1)
}).then(() => {
  console.log(`\n${'='.repeat(56)}\nPASS ${pass}  FAIL ${failures.length}`)
  if (failures.length) { console.log('失败项:'); for (const f of failures) console.log('  - ' + f); process.exit(1) }
  console.log('全部通过')
})
