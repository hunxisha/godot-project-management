// 工具页 B6：`.import` 的类型化读数层（src/tools/parsers/importFile.ts）的断言。
//
// ⚠ 本层的红线是**薄**：INI 的全部规则（段头、引号、转义、重复键、多行块、认不出的行）都归
//   B2 的 parseGodotIni（src/tools/parsers/godotIni.ts），这里只回答「`.import` 的哪几个键是什么」。
//   于是下面有几条断言专门钉住「规则真的只有一份」：B2 的多行块配平、重复键取末条、
//   裸值原样返回、括号列表的「不猜」形状 —— 任何一条在第二个文件里被重写，这几条就会红。
//
// 用法（npm script 会先跑打包步骤）:
//   node src/composables/__tests__/build-bundle.mjs && node src/tools/__tests__/importFile.test.mjs
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

const KEY_SET = ['destFiles', 'generator', 'importer', 'legacy', 'sourceFile', 'type', 'uid'].join(',')

/**
 * 判据 1 的自证夹具:Godot 4.x 编辑器写出的真实形态(逐段照上游 .import 文件排,含
 * `[remap]` 里的 metadata 多行块与 `[params]` 的几十行导入选项 —— 那些都是判据 5 明写不读的)。
 */
const REAL_4X = [
  '[remap]',
  '',
  'importer="texture"',
  'type="CompressedTexture2D"',
  'uid="uid://bkm2b5nqf3rhe"',
  'path="res://.godot/imported/foo.png-1a2b3c4d5e6f.ctex"',
  'metadata={',
  '"vram_texture": false',
  '}',
  '',
  '[deps]',
  '',
  'source_file="res://art/foo.png"',
  'dest_files=["res://.godot/imported/foo.png-1a2b3c4d5e6f.ctex"]',
  '',
  '[params]',
  '',
  'compress/mode=0',
  'compress/high_quality=false',
  'compress/lossy_quality=0.7',
  'mipmaps/generate=false',
  'process/fix_alpha_border=true'
].join('\n')

/** Godot 3 的老形态（判据 1：legacy = 没有 [remap] 却有 generator；它压根没有 source_file） */
const LEGACY_3 = [
  'generator="organically.godot.texture"',
  '',
  '[params]',
  '',
  'compress/mode=0'
].join('\n')

async function main() {
  // ---------- 0. 接线与形状 ----------
  section('0. 接线与形状')
  ok(typeof T.readImportFile === 'function' && T.readImportFile.length === 1,
    'readImportFile(text) 已进 barrel,签名一参', `${typeof T.readImportFile}/${T.readImportFile?.length}`)
  const r4 = T.readImportFile(REAL_4X)
  ok(r4 && Object.keys(r4).sort().join(',') === KEY_SET,
    '★返回值只有简报钉死的那 7 个键(path/validated/[params] 一律不外露 —— 判据 5 的「不读」面在类型层就挡住)',
    Object.keys(r4 || {}).sort().join(','))
  ok(r4.importer === 'texture' && r4.type === 'CompressedTexture2D' && r4.uid === 'uid://bkm2b5nqf3rhe',
    '判据 1:importer/type/uid 取自 [remap] 段(不是任何段里的同名键)',
    `${r4.importer}/${r4.type}/${r4.uid}`)
  ok(r4.sourceFile === 'res://art/foo.png', '判据 1:sourceFile 取自 [deps] 段的 source_file', r4.sourceFile)
  ok(Array.isArray(r4.destFiles) && r4.destFiles.join('|') === 'res://.godot/imported/foo.png-1a2b3c4d5e6f.ctex',
    '判据 1:destFiles 走 getIniList 的 [ ... ] 形态', JSON.stringify(r4.destFiles))
  ok(r4.legacy === false && r4.generator === undefined,
    '4.x 形态:legacy=false、generator 缺失就是缺失(不臆造成空串)', `${r4.legacy}/${r4.generator}`)

  // ---------- 1. 判据 1:薄层 —— 规则全部来自 parseGodotIni ----------
  section('1. 判据 1:读数层不重造 INI')
  // 多行块:B2 按配平吃掉整块,块内长得像键值的文本不得变成键
  const blockTrap = [
    '[remap]',
    'importer="texture"',
    'metadata={',
    '"note": "source_file=\\"res://trap.png\\"",',
    '"inner": [ 1, 2 ]',
    '}',
    '[deps]',
    'source_file="res://art/real.png"'
  ].join('\n')
  const trap = T.readImportFile(blockTrap)
  ok(trap.sourceFile === 'res://art/real.png',
    '★薄层证据:metadata 多行块里那句「source_file=」被 B2 当块内容吃掉,读数层照样只认 [deps] 那条',
    trap.sourceFile)
  ok(trap.importer === 'texture',
    '薄层证据:块后的 [deps] 段头没被块吞掉(B2 的配平规则在替这里干活)', trap.importer)
  // 重复键:B2 的「取最后一条」直通到读数层
  const dupKey = ['[deps]', 'source_file="res://art/old.png"', 'source_file="res://art/new.png"'].join('\n')
  ok(T.readImportFile(dupKey).sourceFile === 'res://art/new.png',
    '薄层证据:同名键重复时取末条(与 getIni 同一份规则,合并/取首都属于分叉)',
    T.readImportFile(dupKey).sourceFile)
  // 段作用域:[params] 里写 importer= 不得污染 [remap] 的值
  const secScope = ['[remap]', 'importer="texture"', '[params]', 'importer="trap"'].join('\n')
  ok(T.readImportFile(secScope).importer === 'texture',
    '薄层证据:fullKey 是 remap/importer,params 段的同名键不串段', T.readImportFile(secScope).importer)
  // 裸值(B2 判据 8):不带引号的值原样当字符串返回,不加引号才解 escapes
  const bare = ['[remap]', 'importer=texture', '[deps]', 'source_file=res://art/a.png'].join('\n')
  const bareRead = T.readImportFile(bare)
  ok(bareRead.importer === 'texture' && bareRead.sourceFile === 'res://art/a.png',
    '薄层证据:编辑器外手改的裸值(无引号)也读得到原样内容(判据 8 的通道归 B2)',
    `${bareRead.importer}/${bareRead.sourceFile}`)
  // 转义解码归 B2:值里的 \n 解码后送给调用方
  const esc = T.readImportFile(['[remap]', 'type="A\\nB"'].join('\n'))
  ok(esc.type === 'A\nB', '薄层证据:转义解码只有一份(getIni 的 \\n 在这里直通)', JSON.stringify(esc.type))
  // 注释与空行
  const commented = T.readImportFile(['; 手写注释', '[deps]', '', ';another', 'source_file="res://a.png"'].join('\n'))
  ok(commented.sourceFile === 'res://a.png', '薄层证据:; 注释与空行照 B2 的判据跳过', commented.sourceFile)

  // ---------- 2. 判据 1:legacy 的判据与 Godot 3 形态 ----------
  section('2. 判据 1:legacy = 没有 [remap] 却有 generator')
  const leg = T.readImportFile(LEGACY_3)
  ok(leg.legacy === true && leg.generator === 'organically.godot.texture',
    'Godot 3 老形态:legacy=true 且 generator 读得到', `${leg.legacy}/${leg.generator}`)
  ok(leg.importer === undefined && leg.type === undefined && leg.uid === undefined &&
    leg.sourceFile === undefined && leg.destFiles === undefined,
    '老形态里那些键压根不存在 → 一律 undefined(不猜默认值)', JSON.stringify(leg))
  ok(T.readImportFile(['[remap]', 'importer="texture"'].join('\n')).legacy === false,
    '有 [remap] 又没有 generator → legacy=false')
  ok(T.readImportFile(['[deps]', 'source_file="res://a.png"'].join('\n')).legacy === false,
    '只有 [deps]、既没 [remap] 也没 generator → 不算 legacy(缺 importer 是畸形,不是 Godot 3)')
  ok(T.readImportFile(['[remap]', 'generator="x"'].join('\n')).legacy === false,
    'generator 只写在 [remap] 段里 → 顶层那个键压根不存在(fullKey 是 remap/generator),不当 legacy')
  // hasRemap 那半守卫要能被咬:同一个顶层 generator 配上一个真的有键的 [remap] 段(手改/半迁移的混合文件)
  const mixed = T.readImportFile('generator="organically.godot.texture"\n\n[remap]\nimporter="texture"\n')
  ok(mixed.generator === 'organically.godot.texture' && mixed.importer === 'texture' && mixed.legacy === false,
    '★顶层有 generator、又存在 [remap] 段 → 不算老形态(有 [remap] 就是 4.x 的文件,legacy 会让调用方少判)',
    `${mixed.generator}/${mixed.importer}/${mixed.legacy}`)
  ok(T.readImportFile('generator=""\n\n[params]\n\ncompress/mode=0\n').legacy === false,
    '★顶层 generator="" 是写了个空名字 → 不算老形态的证据(没有这条,「非空」那半守卫从未被咬过)',
    JSON.stringify(T.readImportFile('generator=""\n\n[params]\n\ncompress/mode=0\n')))

  // ---------- 3. 判据 1:dest_files 的形态与「不猜」 ----------
  section('3. 判据 1:dest_files 只认 B2 认识的两种列表')
  const destOf = (line) => T.readImportFile(['[deps]', line].join('\n')).destFiles
  ok(String(destOf('dest_files=["res://a.ctex","res://b.ctex"]')) === 'res://a.ctex,res://b.ctex',
    'dest_files 的 [ "a", "b" ] 形态(4.x 实际写法)', String(destOf('dest_files=["res://a.ctex","res://b.ctex"]')))
  ok(String(destOf('dest_files=[ "res://a.stex" ]')) === 'res://a.stex',
    'dest_files 的 [ "a" ] 带空格形态(3.x 实际写法)', String(destOf('dest_files=[ "res://a.stex" ]')))
  ok(String(destOf('dest_files=PackedStringArray("res://a","res://b")')) === 'res://a,res://b',
    'dest_files 的 PackedStringArray(...) 形态照样认', String(destOf('dest_files=PackedStringArray("res://a","res://b")')))
  ok(Array.isArray(destOf('dest_files=[]')) && destOf('dest_files=[]').length === 0,
    '空列表给空数组(不是 undefined,也不是猜一个)', JSON.stringify(destOf('dest_files=[]')))
  ok(destOf('dest_files="res://a.ctex"') === undefined,
    '★裸引号串不是列表 → undefined(判据 1「缺失就是 undefined,不猜」;把裸串读成一个元素就是替用户编清单)',
    JSON.stringify(destOf('dest_files="res://a.ctex"')))
  ok(destOf('dest_files=[Object(InputTexture2D,"subresource:0")]') === undefined,
    '★括号里混进 Object(...) 这种非字符串数组元素 → undefined(B2 的「不猜」直通到读数层)',
    JSON.stringify(destOf('dest_files=[Object(InputTexture2D,"subresource:0")]')))
  ok(destOf('dest_files=res://a.ctex') === undefined, '裸值也不是列表 → undefined',
    JSON.stringify(destOf('dest_files=res://a.ctex')))

  // ---------- 4. 边界:不许抛错 ----------
  section('4. 边界与非法输入')
  const junk = [[], {}, null, undefined, 123, '', '   ', '[remap]', 'source_file', '=', '"res://x"']
  let threw = null
  for (const j of junk) {
    try {
      const r = T.readImportFile(j)
      if (!r || typeof r.legacy !== 'boolean') { threw = `${String(j)} → legacy 不是布尔`; break }
    } catch (e) { threw = `${String(j)} → ${e && e.message}`; break }
  }
  ok(threw === null, '非字符串 / 空 / 半截行一律不抛错,legacy 恒为布尔', threw)
  const noDeps = T.readImportFile('[remap]\nimporter="texture"\ntype="CompressedTexture2D"')
  ok(noDeps.importer === 'texture' && noDeps.sourceFile === undefined && noDeps.destFiles === undefined,
    '只有 [remap] 的畸形文件:读得到的读到,读不到的 undefined(不补 res:// 占位)',
    `${noDeps.importer}/${noDeps.sourceFile}/${JSON.stringify(noDeps.destFiles)}`)
  const crlf = T.readImportFile('[remap]\r\nimporter="wav"\r\n\r\n[deps]\r\nsource_file="res://s/a.wav"\r\n')
  ok(crlf.importer === 'wav' && crlf.sourceFile === 'res://s/a.wav',
    'CRLF 换行的边车照样读(B2 按 /\\r?\\n/ 切行)', `${crlf.importer}/${crlf.sourceFile}`)
  const bom = T.readImportFile('﻿[deps]\nsource_file="res://a.png"\n')
  ok(bom.sourceFile === 'res://a.png', 'BOM 开头的文件不脏第一个段头(trim 归 B2)', bom.sourceFile)
}

main().catch((e) => {
  console.error(`\n测试脚本抛错: ${e && e.stack ? e.stack : e}`)
  process.exit(1)
}).then(() => {
  console.log(`\n${'='.repeat(56)}\nPASS ${pass}  FAIL ${failures.length}`)
  if (failures.length) { console.log('失败项:'); for (const f of failures) console.log('  - ' + f); process.exit(1) }
  console.log('全部通过')
})
