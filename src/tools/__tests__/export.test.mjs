// 工具页 P1 第二批 #10 导出预设体检(src/tools/inspectors/export.ts)的断言。
//
// 本批只做**文件里能判死**的四条;§3.2 #10 原文里的「模板齐全度」与「versionDir 与引擎版本串是否匹配」
// 一条都不做 —— 前者要调 `services.exportTemplateStatus`(它是契约方法,不在 types.ts:8 的四个 Capability 里),
// 后者依赖 §3.4 A 的自定义模板实测(待确认 #9/#10 至今未做)。未实测的判据不落笔。
//
// export_presets.cfg 的引用面已经被 refIndex 收过一遍(refIndex.ts:96 认根级那一份),
// 本工具**不复用那份索引**也**不与之冲突**:索引管「谁引用了某资源」,这里管「预设自己指对了没」。
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

const HAS = typeof T.runExport === 'function'
ok(HAS, 'runExport 已在打包产物里导出')
if (!HAS) {
  console.log('\n实现尚未落地,后续断言无法执行(这就是 RED 那一步)。')
  console.log(`\n${'='.repeat(56)}\nPASS ${pass}  FAIL ${failures.length}`)
  process.exit(1)
}

function extOf(rel) {
  const base = rel.slice(rel.lastIndexOf('/') + 1)
  const i = base.lastIndexOf('.')
  return i > 0 ? base.slice(i + 1).toLowerCase() : ''
}
function tree(specs) {
  const base = Date.UTC(2026, 0, 1)
  return specs.map(([rel, size, off = 0]) => ({ rel, size, mtimeMs: base + off * 86400000, ext: extOf(rel) }))
}
function makeCtx(specs, { trunc = false, texts = {}, fail = {} } = {}) {
  const calls = []
  const ctx = {
    projectId: 'godot/project/p', root: 'E:/proj', truncated: trunc, tree: tree(specs),
    readText: async (rel) => {
      calls.push(rel)
      if (Object.prototype.hasOwnProperty.call(fail, rel)) return fail[rel]
      return typeof texts[rel] === 'string' ? { text: texts[rel] } : { skipped: true }
    }
  }
  return { ctx, calls }
}

const dupOf = (fs) => fs.filter((f) => f.id.startsWith('export:dup-name:'))
const missOf = (fs) => fs.filter((f) => f.id.startsWith('export:missing:'))
const noFileOf = (fs) => fs.filter((f) => f.id === 'export:no-file')
const tmplOf = (fs) => fs.filter((f) => f.id === 'export:templates-here')
const skipOf = (fs) => fs.filter((f) => f.id === 'export:skip-count')
const idsOf = (fs) => fs.map((f) => f.id).join('|')

/** 引擎写盘的真实形态:每个预设一段,键名带斜杠,空值成串出现 */
const PRESETS = [
  '[preset.0]',
  '',
  'name="Windows Desktop"',
  'platform="Windows"',
  'run/main_scene="res://scene/main.tscn"',
  'export_path="E:/build/win/game.exe"',
  'custom_template/debug=""',
  'custom_template/release=""',
  'application/Win32icon_file="res://art/app.ico"',
  '',
  '[preset.1]',
  '',
  'name="Windows Desktop"',
  'platform="Windows"',
  'run/main_scene="res://scene/gone.tscn"',
  'export_path=""',
  '',
  '[preset.2]',
  '',
  'name="Linux X11"',
  'platform="Linux"',
  'run/main_scene="res://scene/main.tscn"',
].join('\n')

const SPECS = [['project.godot', 400], ['export_presets.cfg', 900], ['scene/main.tscn', 300], ['art/app.ico', 100]]

section('1. 预设名重复:同名两份是一组,不报两遍')
{
  const fs = await T.runExport(makeCtx(SPECS, { texts: { 'export_presets.cfg': PRESETS } }).ctx)
  const d = dupOf(fs)
  ok(d.length === 1, '两份同名的合成一条;preset.2 名字唯一 → 不该入选', idsOf(d))
  ok(d[0].severity === 'warn', '同名预设是 warn(编辑器里能共存,但 CLI 按名字选预设会撞)', d[0].severity)
  ok(d[0].title.includes('Windows Desktop'), '标题点名重复的预设名', d[0].title)
  ok(d[0].detail.includes('preset.0') && d[0].detail.includes('preset.1'), 'detail 带两段段名(用户要在编辑器里认得出是哪两段)', d[0].detail)
}

section('2. 预设点名的资源不存在:逐个判,空串一律放过')
{
  const fs = await T.runExport(makeCtx(SPECS, { texts: { 'export_presets.cfg': PRESETS } }).ctx)
  const m = missOf(fs)
  ok(m.length === 1 && m[0].id.includes('res://scene/gone.tscn'),
    '只有 gone.tscn 那条;main.tscn 与 app.ico 在清单里 → 不报', idsOf(m))
  ok(m[0].severity === 'error', '导出的包里主场景丢了是 error', m[0].severity)
  ok(m[0].detail.includes('preset.1'), '说清是哪个预设点的', m[0].detail)
}

section('3. `custom_template/debug=""` 这类空值不是引用')
{
  // 每个没用自己模板的预设都会写空串 —— 把它当路径判就等于对每一个正常预设报一条 error。
  const fs = await T.runExport(makeCtx(SPECS, { texts: { 'export_presets.cfg': PRESETS } }).ctx)
  ok(!m_ids(fs).some((p) => p.includes('custom_template')), '空串值一条都不产', m_ids(fs).join('|'))
  function m_ids(fs) { return missOf(fs).map((f) => f.id) }
}

section('4. `export_path` 是磁盘路径,不参与项目内存在性判定')
{
  const fs = await T.runExport(makeCtx(SPECS, { texts: { 'export_presets.cfg': PRESETS } }).ctx)
  ok(!m_ids(fs).some((p) => /E:|build|game\.exe/.test(p)), '导出目标目录在不在盘上不是本工具的判据', m_ids(fs).join('|'))
  function m_ids(fs) { return missOf(fs).map((f) => f.id) }
}

section('5. 没有 export_presets.cfg:一条说明,而不是空卡')
{
  const fs = await T.runExport(makeCtx([['project.godot', 400], ['scene/main.tscn', 300]], { texts: {} }).ctx)
  ok(fs.length === 1 && noFileOf(fs).length === 1, '只出「没配预设」这一条 info', idsOf(fs))
  ok(noFileOf(fs)[0].severity === 'info', '没配预设不是错', noFileOf(fs)[0].severity)
}

section('6. 模板齐全度与版本串匹配:本批明确不做,但要告诉用户去哪看')
{
  const fs = await T.runExport(makeCtx(SPECS, { texts: { 'export_presets.cfg': PRESETS } }).ctx)
  ok(tmplOf(fs).length === 1 && tmplOf(fs)[0].severity === 'info',
    '固定出一条 info 指明「模板齐全度在版本页」', idsOf(fs))
  ok(/版本/.test(tmplOf(fs)[0].detail), '措辞给出可去的去处,不是空喊未实现', tmplOf(fs)[0].detail)
}

section('7. 截断:撤存在性那一路,同名照判')
{
  const fs = await T.runExport(makeCtx(SPECS, { trunc: true, texts: { 'export_presets.cfg': PRESETS } }).ctx)
  ok(missOf(fs).length === 0, '清单残缺时不报「资源丢了」', idsOf(fs))
  ok(dupOf(fs).length === 1, '预设名重复是文件内判据,照判', idsOf(fs))
  ok(/截断|清单不完整/.test(dupOf(fs)[0].detail), '撤掉的那一路说进 detail', dupOf(fs)[0].detail)
}

section('8. 只认根级那一份;读不到文本时不瞎判')
{
  const c = makeCtx([['export_presets.cfg', 900], ['addons/x/export_presets.cfg', 20]], { texts: { 'export_presets.cfg': PRESETS } })
  await T.runExport(c.ctx)
  ok(c.calls.includes('export_presets.cfg') && !c.calls.includes('addons/x/export_presets.cfg'),
    '插件里那份同名文件不算项目预设表', c.calls.join('|'))

  const fs = await T.runExport(makeCtx([['export_presets.cfg', 900]], { fail: { 'export_presets.cfg': { skipped: true } } }).ctx)
  ok(noFileOf(fs).length === 1 || skipOf(fs).length === 1, '读不到就当没有收集面,一条判定都不发', idsOf(fs))
}

section('9. 红线:畸形输入不抛')
{
  const e = await T.runExport({ projectId: 'p', root: 'E:/x', truncated: false, tree: [], readText: async () => ({}) })
  ok(Array.isArray(e) && e.length >= 1, '空清单给 info 而不是空卡', e.length)
  const j = await T.runExport({
    projectId: 'p', root: 'E:/x', truncated: false,
    tree: [{ rel: 'export_presets.cfg', size: 1, mtimeMs: 0, ext: 'cfg' }],
    readText: async () => ({ text: '[preset.0]\nname="A"\nrun/main_scene="res://\u4e2d\u6587 \u5e26\u7a7a\u683c.tscn"' })
  })
  ok(Array.isArray(j), '路径里有空格/中文时不抛(内部空格是合法路径字符)', j)
}

console.log(`\n${'='.repeat(56)}\nPASS ${pass}  FAIL ${failures.length}`)
if (failures.length) { console.log('失败项:'); for (const f of failures) console.log('  - ' + f); process.exit(1) }
console.log('全部通过')
