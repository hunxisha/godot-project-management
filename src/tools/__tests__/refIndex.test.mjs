// 工具页 B3:一次建、多工具共享的引用索引(src/tools/refIndex.ts)的断言。
//
// 夹具是「内存文件树 + readText 桩」,与 tools.test.mjs 同形(那边钉检查器,这里钉索引)。
// 每条判据上方的注释写清「为什么这条判据是这个方向」—— 孤儿资产工具(B5)会把
// 我们**没报成引用**的东西当成可删的,所以这里的每条判据都是拿「宁可少报引用」定的形,
// 不要在没有说明的情况下放宽它(简报 §B3 判据 2/3/4)。
//
// 用法(npm script 会先跑打包步骤):
//   node src/composables/__tests__/build-bundle.mjs && node src/tools/__tests__/refIndex.test.mjs
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

/** ext 推导与原语两端逐字一致(照 tools.test.mjs 的同一份实现,别在这儿漂) */
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
 * 内存 ctx 工厂:`fail` 里的 rel 走指定返回形态(不给 text 就是「读不到」),其余只认 texts。
 * calls 记录 readText 被问过的 rel —— 判据 1/2/3/7 都要靠它证明「根本没去读」。
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

/** 某行在文本里的 1-based 行号(写死数字会让夹具一改就错) */
function lineOf(text, needle) {
  const i = text.split('\n').findIndex((l) => l.includes(needle))
  if (i < 0) throw new Error(`夹具里没有这一行: ${needle}`)
  return i + 1
}
const sitesOf = (idx, rel) => (idx.to.get(rel) || []).map((s) => `${s.from}:${s.via}`)
const pathsOf = (idx, rel) => (idx.to.get(rel) || []).map((s) => `${s.from}@${s.via}@${s.line}`)

// ---------- 夹具:一份「真实形态」的项目 ----------

const TSCN_MAIN = [
  'gd_scene load_steps=3 format=3 uid="uid://bmain1"',
  '',
  '[ext_resource type="Script" uid="uid://cscript9" path="res://scripts/player.gd" id="1_a"]',
  '[ext_resource type="Texture2D" uid="uid://btex007" path="res://assets/bg.png" id="2_b"]',
  '',
  '[node name="Main" type="Node2D"]',
  'script = ExtResource("1_a")'
].join('\n')

// 场景引用自己(编辑器里「实例化自己」的手滑产物)+ 引用 main
const TSCN_SELF = [
  'gd_scene load_steps=3 format=3',
  '',
  '[ext_resource type="PackedScene" uid="uid://bmain1" path="res://scene/self.tscn" id="1_s"]',
  '[ext_resource type="PackedScene" path="res://scene/main.tscn" id="2_m"]'
].join('\n')

// .gd:注释里的引用与死代码里的引用**也要收**(保守方向,见判据 4)
const GD_PLAYER = [
  'extends Node',
  '# 旧实现走 preload("res://assets/dead.png"),留着当线索',
  'const LEVELS = load("res://data/levels.json")',
  'const SAVE_PATH = "user://save.dat"',
  'const BARE = "res://"',
  'const ESCAPE = "res://../outside/x.png"',
  'const DOT = "res://./assets/bg.png"',
  'const UIDTXT = "uid://crazy1"',
  'const BADUID = "uid://BAD"',
  'const INVALID = "uid://<invalid>"'
].join('\n')

const GDSHADER = [
  'shader_type canvas_item;',
  '',
  'uniform vec4 tint_color : source_color = vec4(1.0); // 配色表在 "res://assets/tint.png"',
  '',
  'void fragment() {',
  '  COLOR = texture(TEXTURE, UV) * tint_color; // 旧图 "res://assets/dead.png"',
  '}'
].join('\n')

const JSON_LEVELS = [
  '{',
  '  "start": "res://scene/main.tscn",',
  '  "music": "res://audio/bgm.ogg"',
  '}'
].join('\n')

const GDEXT = [
  '[configuration]',
  'entry_symbol = "foo_entry"',
  '',
  '[libraries]',
  'X11/linux.x86_64 = "res://addons/foo/bin/libfoo.so"',
  'icon = "res://addons/foo/icon.png"'
].join('\n')

const PRESETS = [
  '[preset.0]',
  '',
  'name="Windows Desktop"',
  'run/main_scene="res://scene/main.tscn"',
  'script_export_mode/{ "res://scripts/player.gd": 1 }=1'
].join('\n')

const PLUGIN_CFG = ['[plugin]', 'name="Foo"', 'script_file="res://addons/foo/foo.gd"'].join('\n')

const INI_TXT = [
  '; Engine configuration file.',
  'config_version=5',
  '',
  '[application]',
  'run/main_scene="res://scene/main.tscn"',
  'config/icon="res://icon.svg"',
  '',
  '[autoload]',
  'GameState="*res://scripts/player.gd"',
  'Net="$GameState"',
  '',
  '[editor_plugins]',
  'enabled=PackedStringArray("res://addons/foo/plugin.cfg")'
].join('\n')

// 边车:foo.png.import 里就有 source_file="res://foo.png" —— 判据 2 的全部理由
const BG_IMPORT = [
  '[remap]',
  '',
  'importer="texture"',
  'type="CompressedTexture2D"',
  'uid="uid://btex007"',
  'path="res://.godot/imported/bg.png-abc123.ctex"',
  'source_file="res://assets/bg.png"'
].join('\n')

const UID_FILE = 'uid://cscript9'
const CS_IN_CACHE = 'const string P = "res://assets/bg.png"; // 生成的胶水文件\nconst U = "uid://cnested0";'
const CLASS_CACHE = 'list=Array[Dictionary]([{ "base": "res://scripts/player.gd", "path": "res://scripts/player.gd" }])'
const README = '本项目里 res://assets/bg.png 是主背景。'

const TEXTS = {
  'project.godot': INI_TXT,
  'scene/main.tscn': TSCN_MAIN,
  'scene/self.tscn': TSCN_SELF,
  'scripts/player.gd': GD_PLAYER,
  'shaders/sea.gdshader': GDSHADER,
  'data/levels.json': JSON_LEVELS,
  'addons/foo/foo.gdextension': GDEXT,
  'export_presets.cfg': PRESETS,
  'assets/bg.png.import': BG_IMPORT,
  'scripts/player.gd.uid': UID_FILE,
  'scene/main.tscn.uid': 'uid://bmain1',
  '.godot/mono/temp/player.g.cs': CS_IN_CACHE,
  '.godot/global_script_class_cache.cfg': CLASS_CACHE,
  '.godot/imported/bg.png.import': BG_IMPORT,
  'README.md': README
}

/** 主夹具:白名单外的、边车、.godot 下的、以及 8 个真来源混在一起 */
const SPECS = [
  ['project.godot', 400],
  ['scene/main.tscn', 900],
  ['scene/main.tscn.uid', 30],
  ['scene/self.tscn', 300],
  ['scripts/player.gd', 500],
  ['scripts/player.gd.uid', 30],
  ['shaders/sea.gdshader', 200],
  ['data/levels.json', 400],
  ['addons/foo/foo.gdextension', 300],
  ['addons/foo/plugin.cfg', 200],
  ['export_presets.cfg', 1500],
  ['assets/bg.png', 8000],
  ['assets/bg.png.import', 700],
  ['assets/dead.png', 5000],
  ['.godot/mono/temp/player.g.cs', 600],
  ['.godot/global_script_class_cache.cfg', 900],
  ['.godot/imported/bg.png.import', 700],
  ['.godot/imported/bg.png-abc123.ctex', 3000],
  ['README.md', 300]
]

/** 主夹具里**应当**被读的那 8 个(判据 1/2/3 的合取,一条断言钉住「谁被读了」) */
const READS = [
  'project.godot',
  'scene/main.tscn',
  'scene/self.tscn',
  'scripts/player.gd',
  'shaders/sea.gdshader',
  'data/levels.json',
  'addons/foo/foo.gdextension',
  'export_presets.cfg'
]

async function main() {
  // ---------- 1. 判据 1:来源白名单 ----------
  section('1. 判据 1:来源白名单(谁可能被读)')
  const m1 = makeCtx(SPECS, { texts: TEXTS })
  const idx = await T.buildRefIndex(m1.ctx)
  ok(m1.calls.length === READS.length && [...new Set(m1.calls)].sort().join('|') === [...READS].sort().join('|'),
    '判据 1+2+3:只读白名单来源(边车/.godot/非白名单扩展名一个都不碰)',
    m1.calls.join('|'))
  ok(idx.sourcesScanned === READS.length, 'sourcesScanned = 被尝试读取的来源数', idx.sourcesScanned)
  ok(idx.partial === false && idx.readFailures.length === 0,
    '全读到了 → partial 假(读不到才要让调用方降级)', JSON.stringify(idx.readFailures))
  ok(idx.sidecarSkipped === 3,
    'sidecarSkipped 只数 .godot 之外的 .import/.uid(判据 3 已整体排除 .godot,同一个文件不数两遍)',
    idx.sidecarSkipped)
  // export_presets.cfg 写有每个预设的 run/main_scene 与脚本路径 —— 待确认 #4 的一半答案
  ok(sitesOf(idx, 'scene/main.tscn').includes('export_presets.cfg:literal'),
    '判据 1:根级 export_presets.cfg 算来源(它引用的 main_scene 不收,孤儿工具就会劝人删主场景)',
    sitesOf(idx, 'scene/main.tscn').join('|'))
  ok(sitesOf(idx, 'scripts/player.gd').includes('export_presets.cfg:literal'),
    '判据 1:export_presets.cfg 的 script_export_mode/{ "res://…": 1 } 行里的字面量也收',
    sitesOf(idx, 'scripts/player.gd').join('|'))
  ok(idx.from.has('addons/foo/foo.gdextension') && idx.from.has('shaders/sea.gdshader') &&
    idx.from.has('data/levels.json'),
    '判据 1:gdshader/json/gdextension 都在白名单里', JSON.stringify([...idx.from.keys()]))
  ok(!idx.to.has('addons/foo/foo.gd') && !idx.from.has('addons/foo/plugin.cfg'),
    '判据 1:非根级的 cfg(addons/foo/plugin.cfg)不算来源(白名单写的是「根级 cfg」)',
    JSON.stringify([...idx.from.keys()]))
  ok(!idx.from.has('README.md') && idx.to.has('assets/bg.png') &&
    !sitesOf(idx, 'assets/bg.png').includes('README.md:literal'),
    '判据 1:白名单外(md)即便原文里有 res:// 也不是来源', sitesOf(idx, 'assets/bg.png').join('|'))
  ok(!idx.from.has('assets/bg.png') && !idx.from.has('assets/dead.png'),
    '判据 1:被引用者(png)自己不是来源,不进 from', JSON.stringify([...idx.from.keys()]))

  // ---------- 2. 判据 4:三种 via 与归一 ----------
  section('2. 判据 4:ext_resource / ini / literal 三条识别通道')
  ok(sitesOf(idx, 'assets/bg.png').join('|') === 'scene/main.tscn:ext_resource|scripts/player.gd:literal',
    '判据 4:场景走 ext_resource、脚本走 literal,顺序按文件树序(下游 Finding.id 要稳)',
    sitesOf(idx, 'assets/bg.png').join('|'))
  ok(pathsOf(idx, 'assets/bg.png')[0] === `scene/main.tscn@ext_resource@${lineOf(TSCN_MAIN, 'assets/bg.png')}`,
    '判据 4:ext_resource 站点带 1-based 行号', pathsOf(idx, 'assets/bg.png')[0])
  ok(sitesOf(idx, 'scripts/player.gd').join('|') ===
    'project.godot:ini|scene/main.tscn:ext_resource|export_presets.cfg:literal',
    '判据 4:project.godot 走 ini 通道(via:ini),且与场景/预设三条并存不互相顶掉',
    sitesOf(idx, 'scripts/player.gd').join('|'))
  ok(pathsOf(idx, 'scripts/player.gd')[0] === `project.godot@ini@${lineOf(INI_TXT, 'GameState')}`,
    '判据 4:ini 站点带 project.godot 里的行号', pathsOf(idx, 'scripts/player.gd')[0])
  ok(sitesOf(idx, 'scene/main.tscn').join('|') ===
    'project.godot:ini|scene/self.tscn:ext_resource|data/levels.json:literal|export_presets.cfg:literal',
    '判据 4:同一个目标被三条通道命中,四条站点都在', sitesOf(idx, 'scene/main.tscn').join('|'))
  // autoload 的 `*` 是启用标记,不是路径的一部分:留下 `*res://…` 就永远对不上树里的 rel
  ok([...idx.to.keys()].every((k) => !k.includes('*')),
    '判据 4:autoload 的 `*` 前缀在索引里已经不存在(键必须是能与树对上的 rel)',
    [...idx.to.keys()].join('|'))
  ok([...idx.to.keys()].includes('assets/bg.png'),
    '判据 8:目标 rel 与树同形(res://assets/bg.png → assets/bg.png)', [...idx.to.keys()].join('|'))
  // resToRel 归一:`res://./assets/bg.png` 与 `res://assets/bg.png` 必须是同一个键
  ok(sitesOf(idx, 'assets/bg.png').includes('scripts/player.gd:literal') &&
    !idx.to.has('./assets/bg.png'),
    '判据 8:目标一律过 resToRel(./ 吃掉、重复斜杠折叠),不留永远查不到的形状',
    [...idx.to.keys()].filter((k) => k.includes('bg.png')).join('|'))
  ok(!idx.to.has('user://save.dat') && !idx.to.has('save.dat') && !sitesOf(idx, 'user://save.dat').length,
    '判据 4:user:// 不是项目内引用,一条都不收', [...idx.to.keys()].filter((k) => k.includes('save')).join('|'))
  ok(![...idx.to.keys()].some((k) => k.includes('outside') || k.startsWith('..')),
    '判据 4:res://../ 越界的不收(resToRel 判 null,与生产闸 resolveRel 同规则)',
    [...idx.to.keys()].join('|'))
  ok(![...idx.to.keys()].includes('') && ![...idx.to.keys()].some((k) => k === 'res:'),
    '判据 4:裸 `res://` 不产生空键', [...idx.to.keys()].join('|'))
  ok(idx.to.has('icon.svg') && !idx.from.has('icon.svg'),
    '判据 8:本模块不判目标存不存在(树里没有 icon.svg 照样进索引),存在性是 B5 的活',
    [...idx.to.keys()].filter((k) => k.includes('icon')).join('|'))

  // ---------- 3. 判据 2:边车不算来源(本任务最重要的一条) ----------
  section('3. 判据 2:.import / .uid 边车一律不算来源')
  // 这张图里 bg.png 只被**自己的** bg.png.import 提到(source_file="res://assets/bg.png")。
  // 一旦把边车当引用,每个带导入元数据的资产都「被自己引用」,孤儿检查就永远报不出东西 —— 假阴性。
  const soloCtx = makeCtx([['assets/bg.png', 8000], ['assets/bg.png.import', 700]],
    { texts: { 'assets/bg.png.import': BG_IMPORT } })
  const soloIdx = await T.buildRefIndex(soloCtx.ctx)
  ok(!soloIdx.to.has('assets/bg.png'),
    '★判据 2:png 只被自己的 .png.import 引用 → to 里没有它(本任务最重要的一条)',
    JSON.stringify([...soloIdx.to.keys()]))
  ok(!soloIdx.to.has('.godot/imported/bg.png-abc123.ctex') && !soloIdx.to.has('assets/bg.png.import'),
    '判据 2:边车不读,它里面的 path/source_file 一个字都不收', JSON.stringify([...soloIdx.to.keys()]))
  ok(soloIdx.sourcesScanned === 0 && soloCtx.calls.length === 0 && soloIdx.sidecarSkipped === 1 &&
    soloIdx.partial === false,
    '判据 2:两个文件的图里一个来源都没有(连 readText 都没发),sidecarSkipped 记 1', JSON.stringify({
      calls: soloCtx.calls, s: soloIdx.sourcesScanned, k: soloIdx.sidecarSkipped, p: soloIdx.partial }))
  ok(!soloIdx.uids.has('assets/bg.png.import') && !soloIdx.uids.has('assets/bg.png'),
    '判据 2:边车里的 uid= 也不收(bg.png.import 写着 uid://btex007,读了它 B4 就会把它当引用证据)',
    JSON.stringify([...soloIdx.uids.keys()]))
  // 主图里 .uid 边车同样不读:player.gd.uid 的内容就是 uid://cscript9
  ok(!idx.uids.has('scripts/player.gd.uid') && !idx.uids.has('scene/main.tscn.uid'),
    '判据 2:.uid 边车不是来源(它自己就是被 B4 检查的对象)', JSON.stringify([...idx.uids.keys()]))

  // ---------- 4. 判据 3:.godot 下的任何文件都不是来源 ----------
  section('4. 判据 3:.godot/ 下一律不读')
  // 与判据 2 分开判:cfg 在白名单里,而 .godot 里全是 res://(global_script_class_cache.cfg
  // 把每个类都「引用」一遍),放过它就等于所有资产都有人引用。
  // 这里用 .cs(白名单扩展名 + 不在 .godot 里就该被读)才能单独钉住判据 3。
  const godotOnly = makeCtx([['assets/bg.png', 8000], ['.godot/mono/temp/player.g.cs', 600]],
    { texts: { '.godot/mono/temp/player.g.cs': CS_IN_CACHE } })
  const gIdx = await T.buildRefIndex(godotOnly.ctx)
  ok(!gIdx.to.has('assets/bg.png') && gIdx.sourcesScanned === 0 && godotOnly.calls.length === 0,
    '判据 3:.godot 下的 .cs 不是来源(生成的胶水文件里有的是 res://)', JSON.stringify({
      keys: [...gIdx.to.keys()], s: gIdx.sourcesScanned, calls: godotOnly.calls }))
  ok(!gIdx.uids.has('.godot/mono/temp/player.g.cs'),
    '判据 3:.godot 下的 uid:// 也不收', JSON.stringify([...gIdx.uids.keys()]))
  const cacheCtx = makeCtx([['.godot/global_script_class_cache.cfg', 900], ['scripts/player.gd', 500]],
    { texts: { '.godot/global_script_class_cache.cfg': CLASS_CACHE } })
  const cIdx = await T.buildRefIndex(cacheCtx.ctx)
  ok(cIdx.sourcesScanned === 1 && !cIdx.from.has('.godot/global_script_class_cache.cfg'),
    '判据 3:.godot 下的 cfg 即使扩展名+段名都像来源也不读(判据 1 的根级 cfg 与判据 3 分开判)',
    JSON.stringify({ s: cIdx.sourcesScanned, calls: cacheCtx.calls }))
  ok(!idx.from.has('.godot/imported/bg.png.import') && m1.calls.every((r) => !r.split('/').includes('.godot')),
    '判据 3 复用:主图里三个 .godot 条目一个都没被读', m1.calls.filter((r) => r.includes('.godot')).join('|'))

  // ---------- 5. 判据 4:literal 通道连注释与死代码一起收(保守方向) ----------
  section('5. 判据 4:注释里的引用也算')
  // 孤儿资产工具会把「没人引用」的东西摆到删除按钮旁边。注释里 preload("res://x.png")
  // 说明**人**还记得这个文件在用;把它判成没人引用就可能被真删。方向是保守的:
  // 宁可少报孤儿,也不误删。
  ok(sitesOf(idx, 'assets/dead.png').join('|') === 'scripts/player.gd:literal|shaders/sea.gdshader:literal',
    '判据 4:注释里的 res:// 与死代码里的 res:// 都算引用(两条通道的来源都在)', sitesOf(idx, 'assets/dead.png').join('|'))
  ok(pathsOf(idx, 'assets/dead.png')[0] === `scripts/player.gd@literal@${lineOf(GD_PLAYER, '旧实现走 preload')}`,
    '判据 4:literal 站点带行号(注释行也一样给得出)', pathsOf(idx, 'assets/dead.png')[0])
  ok(sitesOf(idx, 'assets/tint.png').join('|') === 'shaders/sea.gdshader:literal',
    '判据 4:.gdshader 原文里的字面量走 literal 通道', sitesOf(idx, 'assets/tint.png').join('|'))
  const dupText = [
    'extends Node',
    'const A = preload("res://x/a.png")',
    'const B = preload("res://x/a.png")',
    'const C = [preload("res://x/a.png"), preload("res://x/a.png")]'
  ].join('\n')
  const dup = await T.buildRefIndex(makeCtx([['dup.gd', 200]], { texts: { 'dup.gd': dupText } }).ctx)
  ok((dup.to.get('x/a.png') || []).length === 4,
    'to 逐处保留证据(4 处引用就是 4 条站点,不静默合并)', JSON.stringify(dup.to.get('x/a.png')))
  ok((dup.from.get('dup.gd') || []).join('|') === 'x/a.png',
    '判据 1 接口:from 的目标是**去重后**的 rel(一处引用与四处引用都算「它引用了这个」)',
    JSON.stringify(dup.from.get('dup.gd')))

  // ---------- 6. 判据 5:自引用丢弃 ----------
  section('6. 判据 5:from === to 的自引用丢弃')
  // 不丢弃的话,一个场景永远「被自己引用」,而 .tscn/.tres/.gd 都是孤儿工具的猎物 —— 全灭。
  ok(!idx.to.has('scene/self.tscn'),
    '判据 5:场景引用自己 → to 里没有它', JSON.stringify([...idx.to.keys()].filter((k) => k.includes('self'))))
  ok((idx.from.get('scene/self.tscn') || []).join('|') === 'scene/main.tscn',
    '判据 5:from 里也不留自己 —— 丢弃要在两条账上同时成立(只在 to 丢、from 留着自引用,B5 数引用数就会多一)',
    JSON.stringify(idx.from.get('scene/self.tscn')))
  ok(sitesOf(idx, 'scene/main.tscn').includes('scene/self.tscn:ext_resource'),
    '判据 5 反面钉:同一个文件既自引用又引用别人,只丢自己那一条', sitesOf(idx, 'scene/main.tscn').join('|'))
  const selfGd = await T.buildRefIndex(makeCtx([['scripts/loop.gd', 100]],
    { texts: { 'scripts/loop.gd': 'const S = "res://scripts/loop.gd"' } }).ctx)
  ok(selfGd.to.size === 0 && selfGd.from.get('scripts/loop.gd')?.length === 0,
    '判据 5:literal 通道同样丢自引用(脚本 preload 自己也是真会出现的形态)', JSON.stringify([...selfGd.to.keys()]))

  // ---------- 7. 判据 6:读不到的三态与 partial ----------
  section('7. 判据 6:readText 给不出 text 时记 readFailures')
  const f1 = await T.buildRefIndex(makeCtx(SPECS, {
    texts: TEXTS, fail: { 'scripts/player.gd': { skipped: true } }
  }).ctx)
  ok(f1.readFailures.length === 1 && f1.readFailures[0].rel === 'scripts/player.gd' &&
    f1.readFailures[0].reason === 'skipped',
    '判据 6:白名单文件 skipped → 记 reason=skipped(用 ctx 给的原语串,不编造)',
    JSON.stringify(f1.readFailures))
  ok(f1.partial === true, '判据 6:有读不到 → partial 为真(B5 必须据此降级措辞)', f1.partial)
  ok(!f1.from.has('scripts/player.gd') && !sitesOf(f1, 'assets/dead.png').includes('scripts/player.gd:literal'),
    '判据 6:读不到的那条不产 from 也不产站点(「查不到引用」不是证据)', JSON.stringify([...f1.from.keys()]))
  ok(f1.sourcesScanned === READS.length,
    'sourcesScanned 数的是**尝试**读取的来源数(读失败也算扫过)', f1.sourcesScanned)
  const f2 = await T.buildRefIndex(makeCtx(SPECS, {
    texts: TEXTS, fail: { 'shaders/sea.gdshader': {} }
  }).ctx)
  ok(f2.readFailures.length === 1 && f2.readFailures[0].reason === 'error' && f2.partial === true,
    '判据 6:既没 text 也没 skipped → reason=error(宿主给什么形态都收口成这两个串)',
    JSON.stringify(f2.readFailures))
  const f3 = await T.buildRefIndex(makeCtx(SPECS, {
    texts: TEXTS, fail: { 'assets/bg.png': { skipped: true }, 'README.md': { skipped: true } }
  }).ctx)
  ok(f3.readFailures.length === 0 && f3.partial === false,
    '判据 6:白名单外的文件读不到**不记**(png 本来就不该被读,记了就是把噪声当结论)',
    JSON.stringify(f3.readFailures))

  // ---------- 8. 判据 7:清单截断时一个文件都不读 ----------
  section('8. 判据 7:ctx.truncated → 空索引 + partial')
  const t1 = makeCtx(SPECS, { trunc: true, texts: TEXTS })
  const tIdx = await T.buildRefIndex(t1.ctx)
  ok(t1.calls.length === 0 && tIdx.sourcesScanned === 0,
    '判据 7:截断时**一次 readText 都不发**(与 brokenRefs 同一口径:清单不全时「查不到引用」不是证据)',
    `${t1.calls.length}/${tIdx.sourcesScanned}`)
  ok(tIdx.to.size === 0 && tIdx.from.size === 0 && tIdx.uids.size === 0 && tIdx.sidecarSkipped === 0,
    '判据 7:返回的是空索引,不给半成品结论', JSON.stringify({
      to: tIdx.to.size, from: tIdx.from.size, uids: tIdx.uids.size, sk: tIdx.sidecarSkipped }))
  ok(tIdx.partial === true && tIdx.readFailures.length === 0,
    '判据 7:partial 为真,但没有 readFailures(什么都没读,不是读失败)', `${tIdx.partial}/${tIdx.readFailures.length}`)

  // ---------- 9. uids:ext_resource 的 uid= 与正文里的 uid:// ----------
  section('9. uids:给 B4 的 uid:// 收集')
  const mu = (idx.uids.get('scene/main.tscn') || []).slice().sort().join('|')
  ok(mu === ['uid://bmain1', 'uid://cscript9', 'uid://btex007'].sort().join('|'),
    'uids:场景的 ext_resource uid= 与文件头自己的 uid= 都收(按来源 rel 归组)', mu)
  ok((idx.uids.get('scene/self.tscn') || []).length === 1 &&
    idx.uids.get('scene/self.tscn')[0] === 'uid://bmain1',
    'uids:同一条 uid 来自 uid= 属性与正文扫描两路,按来源去重(给 B4 的清单不能靠调用方再收拾)',
    JSON.stringify(idx.uids.get('scene/self.tscn')))
  ok((idx.uids.get('scripts/player.gd') || []).join('|') === 'uid://crazy1',
    'uids:正文里的 uid:// 也收(注释里的算 —— 与 literal 通道同一保守方向)',
    JSON.stringify(idx.uids.get('scripts/player.gd')))
  // 核实过的形状(见 refIndex.ts 头注:引擎解码只认小写字母与数字,z/9 因 GH-83843 永不出现)
  ok(!mu.includes('BAD') && !JSON.stringify(idx.uids).includes('UID') &&
    !JSON.stringify(idx.uids).includes('<invalid>'),
    'uids:大写与 uid://<invalid> 都不算 uid 串(引擎 text_to_id 对这些给 INVALID_ID)', mu)
  ok([...idx.uids.keys()].every((k) => READS.includes(k)),
    'uids 的键只有白名单来源', JSON.stringify([...idx.uids.keys()]))

  // ---------- 10. 整体形状与确定性 ----------
  section('10. 索引形状')
  ok(idx.to instanceof Map && idx.from instanceof Map && idx.uids instanceof Map,
    '三个索引都是 Map(简报钉的接口,B4/B5 直接 get/has)',
    [idx.to?.constructor?.name, idx.from?.constructor?.name, idx.uids?.constructor?.name].join('/'))
  ok([...idx.to.keys()].every((k) => idx.to.get(k).every((s) => typeof s.from === 'string' &&
    ['ext_resource', 'literal', 'ini'].includes(s.via))),
    '每条站点都有 from 与合法 via(B5 的措辞按 via 分档:引用来自场景/代码/配置)')
  const again = await T.buildRefIndex(makeCtx(SPECS, { texts: TEXTS }).ctx)
  ok(JSON.stringify({
    to: [...idx.to.entries()], from: [...idx.from.entries()], uids: [...idx.uids.entries()],
    n: [idx.sourcesScanned, idx.sidecarSkipped, idx.partial]
  }) === JSON.stringify({
    to: [...again.to.entries()], from: [...again.from.entries()], uids: [...again.uids.entries()],
    n: [again.sourcesScanned, again.sidecarSkipped, again.partial]
  }),
    '同一份图两次构建逐字节一致(结论 id 由这些内容推导,抖动一次就等于给用户换了一批 id)')
  ok(SPECS.every(([, size]) => typeof size === 'number') &&
    idx.from.get('project.godot')?.join('|') ===
    'scene/main.tscn|icon.svg|scripts/player.gd|addons/foo/plugin.cfg',
    'from 的目标顺序 = 文件里的出现顺序(project.godot 的四条 ini 引用)',
    JSON.stringify(idx.from.get('project.godot')))
  ok(idx.from.get('scripts/player.gd')?.join('|') === 'assets/dead.png|data/levels.json|assets/bg.png',
    'from:跳过 user:// / 裸 res:// / 越界后的其余三条,按行序', JSON.stringify(idx.from.get('scripts/player.gd')))
}

main().catch((e) => {
  console.error(`\n测试脚本抛错: ${e && e.stack ? e.stack : e}`)
  process.exit(1)
}).then(() => {
  console.log(`\n${'='.repeat(56)}\nPASS ${pass}  FAIL ${failures.length}`)
  if (failures.length) { console.log('失败项:'); for (const f of failures) console.log('  - ' + f); process.exit(1) }
  console.log('全部通过')
})
