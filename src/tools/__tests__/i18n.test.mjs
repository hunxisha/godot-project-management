// 工具页 P1/M-P1b #15 本地化体检(src/tools/inspectors/i18n.ts)的断言。
//
// 两条判据,一边判「文件在不在」,一边判「csv 首列重不重」:
//   · 缺失 = error:翻译表读不到时该 locale 整块失效,是看得见的坏;
//   · 重复键 = warn:引擎按加载顺序覆盖并 push_warning,数据错但项目照跑。
//
// 最容易写错的是**收集面**:必须只吃 `[internationalization]` 段里的 res:// 值。
// 拿 `iniResPaths(doc)` 的全量结果直接判,`application/config/icon="res://icon.svg"` 这类
// 也会被当成翻译文件查一遍 —— 项目里图标写法五花八门,于是长出一批假 error。
//
// csv 的「读不下去」按 spec §5.2 的口径处理:未闭合引号 → partial → 这条文件不判重复,并计一笔上卡。
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

const HAS = typeof T.runI18n === 'function'
ok(HAS, 'runI18n 已在打包产物里导出')
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

/** 键名里带斜杠(`locale/translations`)是 Godot 的真实写法,fullKey 因此是三段 */
const PROJ = [
  'config_version=5',
  '[application]',
  'config/name="Demo"',
  'config/icon="res://art/icon.svg"',
  '[internationalization]',
  'locale/fallback="en"',
  'locale/translations=PackedStringArray("res://lang/main.csv", "res://lang/gone.csv")',
].join('\n')

const missOf = (fs) => fs.filter((f) => f.id.startsWith('i18n:missing:'))
const dupOf = (fs) => fs.filter((f) => f.id.startsWith('i18n:dup-key:'))
const noProjOf = (fs) => fs.filter((f) => f.id === 'i18n:no-project')
const skipOf = (fs) => fs.filter((f) => f.id === 'i18n:skip-count')
const idsOf = (fs) => fs.map((f) => f.id).join('|')

const CSV_OK = '_key,en,zh\nHELLO,Hello,你好\nbye,Bye,再见\n'
const CSV_DUP = '_key,en,zh\nHELLO,Hello,你好\nstart,Go,走\nHELLO,Hi again,又一遍\n'

section('1. 翻译文件缺失 = error,在清单里的不报')
{
  const { ctx } = makeCtx(
    [['project.godot', 300], ['lang/main.csv', 60], ['art/icon.svg', 100]],
    { texts: { 'project.godot': PROJ, 'lang/main.csv': CSV_OK } }
  )
  const fs = await T.runI18n(ctx)
  const m = missOf(fs)
  ok(m.length === 1 && m[0].id.includes('res://lang/gone.csv'), '只报真不在清单里的那条', idsOf(m))
  ok(m[0].severity === 'error', '缺失是 error(该 locale 整块翻译失效)', m[0].severity)
  ok(m[0].rel === 'project.godot', '引用者是 project.godot', m[0].rel)
  ok(dupOf(fs).length === 0, '内容干净的 csv 不出重复结论', idsOf(fs))
}

section('2. 收集面只吃 [internationalization]')
{
  // config/icon 指到 art/icon.svg,而它确实在清单里;真正要防的是把「别段的 res://」当翻译文件判。
  const gone = PROJ.replace('res://art/icon.svg', 'res://art/nowhere.svg')
  const fs = await T.runI18n(makeCtx(
    [['project.godot', 300], ['lang/main.csv', 60], ['art/icon.svg', 100]],
    { texts: { 'project.godot': gone, 'lang/main.csv': CSV_OK } }
  ).ctx)
  ok(missOf(fs).length === 1, '非本地化段的 res:// 不参与(这里只剩 gone.csv 那一条)', idsOf(fs))
  ok(!missOf(fs)[0].id.includes('nowhere'), '假想的图标缺失没被报出来', idsOf(fs))
}

section('3. csv 首列重复 = warn,一条重复键一张卡')
{
  const fs = await T.runI18n(makeCtx(
    [['project.godot', 300], ['lang/main.csv', 60]],
    { texts: { 'project.godot': PROJ.replace(', "res://lang/gone.csv"', ''), 'lang/main.csv': CSV_DUP } }
  ).ctx)
  const d = dupOf(fs)
  ok(d.length === 1 && d[0].id.includes('HELLO'), 'HELLO 重复两次,合成一条', idsOf(d))
  ok(d[0].severity === 'warn', '重复键是 warn(引擎覆盖前者,不拦加载)', d[0].severity)
  ok(d[0].detail.includes('2') && d[0].detail.includes('4'), '两处行号都说出来', d[0].detail)
  ok(d[0].rel === 'lang/main.csv', '引用者是那份 csv 本身', d[0].rel)
}

section('4. 表头 `_key` 不当成翻译键')
{
  // 首行是表头;若把它算进查重,任何一份 csv 与另一份表头同名都会撞,而 `_key` 本身出现一次不该报。
  const csv = '_key,en\n_key,Extra\nb,B\n'
  const fs = await T.runI18n(makeCtx(
    [['project.godot', 300], ['lang/main.csv', 30]],
    { texts: { 'project.godot': PROJ.replace(', "res://lang/gone.csv"', ''), 'lang/main.csv': csv } }
  ).ctx)
  const d = dupOf(fs)
  ok(dupOf(fs).length === 0, '表头那一行不参与查重:两处 `_key` 里有一处是表头位,不该报重复', idsOf(fs))
  ok(skipOf(fs).length === 0 && missOf(fs).length === 0, '这条夹具只该一条结论都不发', idsOf(fs))
}

section('5. csv 读不下去就不判重复,并计一笔')
{
  const broken = '_key,en\nA,"未闭合的译文\n'
  const fs = await T.runI18n(makeCtx(
    [['project.godot', 300], ['lang/main.csv', 30]],
    { texts: { 'project.godot': PROJ.replace(', "res://lang/gone.csv"', ''), 'lang/main.csv': broken } }
  ).ctx)
  ok(dupOf(fs).length === 0, 'partial 的 csv 不发重复结论', idsOf(fs))
  ok(skipOf(fs).length === 1, '这笔「判不了」要上卡', idsOf(fs))
  ok(/未闭合|partial|读不下去/.test(skipOf(fs)[0].detail), '措辞讲的是没做成什么', skipOf(fs)[0].detail)
}

section('6. .po 只判存在性(不解析内容)')
{
  const p = PROJ.replace('res://lang/main.csv', 'res://lang/main.po').replace('res://lang/gone.csv', 'res://lang/gone.po')
  const fs = await T.runI18n(makeCtx(
    [['project.godot', 300], ['lang/main.po', 30]],
    { texts: { 'project.godot': p, 'lang/main.po': 'msgid ""\nmsgstr ""\n' } }
  ).ctx)
  ok(missOf(fs).length === 1 && missOf(fs)[0].id.includes('res://lang/gone.po'), '缺失照判', idsOf(fs))
  ok(dupOf(fs).length === 0, '内容不解析(未实测前不落判据,见待确认 #16)', idsOf(fs))
}

section('7. 形状闸:脏写法不判存在性,只计数')
{
  const p = PROJ.replace('"res://lang/gone.csv")', '"res://lang/tail.csv ", "res://lang/main.csv")')
  const fs = await T.runI18n(makeCtx(
    [['project.godot', 300], ['lang/main.csv', 30]],
    { texts: { 'project.godot': p, 'lang/main.csv': CSV_OK } }
  ).ctx)
  ok(missOf(fs).length === 0, '尾巴带空格的值不发「文件丢了」', idsOf(fs))
  const anyNote = fs.concat(skipOf(fs)).map((f) => f.detail).join('')
  ok(/未判定/.test(anyNote) || skipOf(fs).length > 0, '这笔数要有一个说得出口的落点', idsOf(fs))
}

section('8. 读不到 project.godot:只出一条说明,不发缺失 error')
{
  const fs = await T.runI18n(makeCtx([['lang/main.csv', 30]], { texts: { 'lang/main.csv': CSV_DUP } }).ctx)
  ok(missOf(fs).length === 0 && dupOf(fs).length === 0 && noProjOf(fs).length === 1,
    '没有配置就没有收集面:一条判据都不发', idsOf(fs))
  ok(noProjOf(fs)[0].severity === 'info', '这条是 info', noProjOf(fs)[0].severity)
}

section('9. 红线:空清单与畸形条目不抛')
{
  const e = await T.runI18n({ projectId: 'p', root: 'E:/x', truncated: false, tree: [], readText: async () => ({}) })
  ok(Array.isArray(e), '空清单不抛', e)
  const j = await T.runI18n({
    projectId: 'p', root: 'E:/x', truncated: false,
    tree: [{ rel: 'project.godot', size: 1, mtimeMs: 0, ext: '' }, null],
    readText: async () => ({ text: 12 })
  })
  ok(Array.isArray(j), 'text 非字符串按读不到处理', j)
}

section('7b. 截断:存在性那一路撤掉(与 scenes 同方向)')
{
  const fs = await T.runI18n(makeCtx(
    [['project.godot', 300]], { trunc: true, texts: { 'project.godot': PROJ } }
  ).ctx)
  ok(missOf(fs).length === 0, '清单残缺时「不在清单里」不等于「文件没了」,不发 error', idsOf(fs))
  ok(skipOf(fs).length === 1, '撤掉的条数上卡', idsOf(fs))
}

console.log(`\n${'='.repeat(56)}\nPASS ${pass}  FAIL ${failures.length}`)
if (failures.length) { console.log('失败项:'); for (const f of failures) console.log('  - ' + f); process.exit(1) }
console.log('全部通过')
