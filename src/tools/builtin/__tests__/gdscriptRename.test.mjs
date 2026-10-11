// GDScript 批量重命名 · 内置工具(entry 层)的断言(§G Task 19)。
//
// ⚠ ctx 一律用**框架自己的组装层** `buildGpm` + 假 services 造,不手搓 ctx
//   —— 手搓夹具会和实现一起错在同一个假形状上(§F Task 10/11 的教训,第 1 批栽过两次)。
//   这条尤其要紧的是 `refIndex()`:它内部要 scanTree + 逐文件 readText,手搓一个「假索引」
//   等于把第 0 批 DEV-3 收窄过的那条入参通道绕过掉,而 A-20 的引用图半边就白测了。
//
// 这份套件钉的是**装配是否正确**,不是算法(算法在 refs.ts / modes.ts 的两份套件里,共 211 条):
//   · 一个被 N 个文件引用的 .gd 改名 ⇒ 出 1 条 rename + 每个引用者一条 rewrite(A-20 的假宿主半边);
//   · 开关关掉 ⇒ 一条 rewrite 都不出,而 `dangling` 等于本来能改上的处数(A-22);
//   · `project.godot` 的 `run/main_scene` 会作为引用者出现(A-23);
//   · 边车**不由工具产条目** —— 那是改名原语的事(A-24 的分工,别在这里抢做);
//   · 读不到的引用者计进断链并说得出原因,**不静默少改**。
//
// 用法:node src/composables/__tests__/build-bundle.mjs && node src/tools/builtin/__tests__/gdscriptRename.test.mjs
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../../../..')
const OUT_DIR = path.resolve(ROOT, '.gpm-test/out')
const need = (n) => path.join(OUT_DIR, `${n}.mjs`)
for (const n of ['tkrenameform', 'tkschema', 'tkmanifest', 'tkgpm', 'tkmodes', 'tkrefs']) {
  if (!existsSync(need(n))) {
    console.error(`找不到打包产物: ${need(n)}`)
    console.error('请先运行: node src/composables/__tests__/build-bundle.mjs')
    process.exit(2)
  }
}

const M = await import(pathToFileURL(need('tkrenameform')).href)
const SC = await import(pathToFileURL(need('tkschema')).href)
const MF = await import(pathToFileURL(need('tkmanifest')).href)
const GP = await import(pathToFileURL(need('tkgpm')).href)
const MD = await import(pathToFileURL(need('tkmodes')).href)

let pass = 0
const failures = []
function ok(cond, label, extra) {
  if (cond) { pass++; console.log(`  PASS  ${label}`) }
  else { failures.push(label); console.log(`  FAIL  ${label}${extra !== undefined ? '  → ' + JSON.stringify(extra) : ''}`) }
}
function section(t) { console.log(`\n=== ${t} ===`) }
const F = (x) => (x && typeof x === 'object' ? x : {})
const FA = (x) => (Array.isArray(x) ? x : [])
const S = (x) => (typeof x === 'string' ? x : '')
const N = (x) => (typeof x === 'number' ? x : -1)
const P = (arr, i) => F(FA(arr)[i])

const extOf = (rel) => (rel.includes('.') ? rel.slice(rel.lastIndexOf('.') + 1).toLowerCase() : '')
const FILES = (map) => Object.keys(map).map((rel) => ({ rel, size: String(map[rel]).length, mtimeMs: 1, ext: extOf(rel) }))

/**
 * 造一份真 ctx:services 是假的,但**通路是框架的那一套**(scanTree → buildRefIndex → readText)。
 * `broken` 里的 rel 读不到(超限 / 二进制 / 不存在),用来钉「读不到的引用者怎么算」。
 */
function mkCtx(files, over) {
  const o = over || {}
  const logs = []
  const reads = []
  const ctx = GP.buildGpm({
    services: {
      scanProjectTree: async (pid, opts) => {
        if (o.scanError) return { ok: false, error: '项目目录已不存在' }
        const list = FILES(files)
        const exts = opts && Array.isArray(opts.exts) && opts.exts.length ? opts.exts : null
        return { ok: true, files: exts ? list.filter((f) => exts.includes(f.ext)) : list, truncated: o.truncated === true }
      },
      readProjectText: async (pid, rel) => {
        reads.push(rel)
        if (o.binary && o.binary.includes(rel)) return { ok: true, bytes: 8, skippedBinary: true }
        if (o.big && o.big.includes(rel)) return { ok: true, bytes: 900000, truncated: true }
        if (!(rel in files)) return { ok: false, error: '文件不存在' }
        return { ok: true, text: files[rel], bytes: files[rel].length, truncated: false, skippedBinary: false }
      },
      ...(o.services || {})
    },
    toolId: 'gdscript-rename',
    toolName: 'GDScript 批量重命名',
    projectId: 'godot/project/p1',
    capabilities: ['tree', 'text', 'ref', 'write'],
    unsafe: false,
    onLog: (lvl, msg) => logs.push(lvl + ':' + msg),
    cancelled: () => o.cancelled === true
  })
  return { ctx, logs, reads }
}

/** schema 的默认值(与页面初值同源) + 覆盖若干字段 */
const PARAMS = (over) => ({ ...SC.defaultsOf(FA(F(SC.validateSchema(M.schema)).fields)), ...(over || {}) })
const PLAN = async (files, map, over) => {
  const c = mkCtx(map, (over && over.ctx) || {})
  let rows
  try {
    rows = await M.plan(c.ctx, files.map((rel) => ({ rel, size: 1 })), PARAMS(over && over.params))
  } catch (e) {
    return { threw: String(e && e.message), rows: [], logs: c.logs, reads: c.reads }
  }
  return { threw: null, rows: FA(rows), logs: c.logs, reads: c.reads }
}
const KIND = (rows, kind) => rows.filter((r) => r && r.kind === kind)
const BYREL = (rows, rel) => rows.find((r) => r && r.rel === rel)
const EXT_TEXT = '[gd_scene load_steps=2 format=3 uid="uid://s1"]\n[ext_resource type="Script" path="res://player.gd" id="1_a"]\n'

// ---------------------------------------------------------------- 0. 导出面与契约
section('0. 导出面、manifest 与 schema 自检')
{
  ok(typeof M.schema === 'object' && typeof M.plan === 'function' && typeof M.count === 'function',
    'entry 导出 schema / plan / count(action 型那一套;count 是可选的参数预览,§G-5)')
  ok(M.plan !== undefined && M.apply === undefined, '本工具**不实现 apply**:rename 由框架执行,rewrite 的正文在 payload 里')
  const v = F(SC.validateSchema(M.schema))
  ok(v.ok === true, 'schema 声明自身过校验(作者写错声明就没有第二次机会才发现)', FA(v.issues))
  ok(FA(F(SC.validateSchema(M.schema)).fields).length === 11, '参数表 11 个字段(§5.7 那张单子的落地)', FA(v.fields).length)
  const mf = F(MF.validateManifest(
    JSON.parse(readFileSync(path.resolve(ROOT, 'src', 'tools', 'builtin', 'gdscript-rename', 'manifest.json'), 'utf8')),
    { files: ['manifest.json', 'index.ts', 'refs.ts', 'modes.ts'] }
  ))
  ok(mf.ok === true, 'manifest 原文过框架的校验器(与用户插件同一张嘴)', FA(mf.issues))
  ok(mf.manifest && FA(mf.manifest.capabilities).join(',') === 'tree,text,ref,write',
    '能力声明里必须有 ref:引用图是这工具的两条腿之一', mf.manifest && mf.manifest.capabilities)
  // 表单显示的默认值与 modes 里的默认值必须是同一套(分成两套是这类工具最容易被当成 bug 的地方)
  const d = PARAMS({})
  ok(d.mode === MD.DEFAULT_PARAMS.mode && d.template === MD.DEFAULT_PARAMS.template,
    'mode / template 的默认值两边一致', { d: d.mode, t: d.template })
  ok(d.start === MD.DEFAULT_PARAMS.start && d.digits === MD.DEFAULT_PARAMS.digits,
    '序号起始与位数两边一致', { s: d.start, g: d.digits })
  ok(d.case_mode === MD.DEFAULT_PARAMS.caseMode && d.update_refs === true,
    '大小写档与「同时更新引用」默认两边一致', { c: d.case_mode, u: d.update_refs })
}

// ---------------------------------------------------------------- 1. A-20 的假宿主半边
section('1. 一个被 3 个 .tscn + 2 个 .gd 引用的 .gd 改名 → 5 处引用全同步(A-20)')
{
  const map = {
    'player.gd': 'class_name Player\nextends Node\n',
    'player.gd.uid': 'uid://abc123\n',
    'a.tscn': EXT_TEXT,
    'b.tscn': EXT_TEXT,
    'c.tscn': EXT_TEXT,
    'spawner.gd': 'const SC = preload("res://player.gd")\n',
    'util.gd': 'var p = "res://player.gd"\n',
    'project.godot': 'config_version=5\n[application]\nrun/main_scene="res://a.tscn"\n'
  }
  const r = await PLAN(['player.gd'], map, { params: { mode: 'affix', prefix: 'hero_' } })
  ok(r.threw === null, 'plan 不抛', r.threw)
  const renames = KIND(r.rows, 'rename')
  const rewrites = KIND(r.rows, 'rewrite')
  ok(renames.length === 1 && rewrites.length === 5, '1 条改名 + 5 条引用改写(每个引用者一条)', r.rows.map((x) => x.kind + ':' + x.rel))
  ok(P(renames, 0).rel === 'player.gd' && P(renames, 0).to === 'hero_player.gd', '改名条带 from/to', P(renames, 0))
  ok(N(P(renames, 0).dangling) === 0, '开关开着且全部改上 ⇒ 断链数 0', P(renames, 0).dangling)
  for (const rel of ['a.tscn', 'b.tscn', 'c.tscn', 'spawner.gd', 'util.gd']) {
    const rw = BYREL(r.rows, rel)
    ok(!!rw && S(F(rw).payload && rw.payload.text).includes('res://hero_player.gd'), `${rel} 的新正文指向新名`, rw && rw.label)
    ok(!!rw && !S(F(rw).payload && rw.payload.text).includes('res://player.gd'), `${rel} 里旧路径一个字不剩`)
  }
  ok(KIND(r.rows, 'rename').every((c) => c.label.includes('player.gd') && c.label.includes('hero_player.gd')),
    '预览那一行是「旧名 → 新名」对照(Q31 的 rename 预览)', KIND(r.rows, 'rename').map((c) => c.label))
  ok(r.rows.every((c) => !!S(c.reason).trim()), '每一条都带 reason(框架要求,不给就整条被丢)')
  ok(!r.rows.some((c) => c.rel.endsWith('.uid') || c.rel.endsWith('.import')),
    'A-24 的分工:边车**不由工具产条目** —— 搬边日是改名原语做的,工具抢做就会和原语各搬一次')
  ok(r.reads.filter((x) => x === 'a.tscn').length === 2,
    '一个引用者总共两遍:索引建图一遍 + 本工具取正文一遍(多条改名共用这张表,不叠加)', r.reads)
}

// ---------------------------------------------------------------- 2. A-22 开关关掉
section('2. 关掉「同时更新引用」→ 不出一条改写,而 dangling 等于本来能改上的处数(A-22)')
{
  const map = {
    'player.gd': 'extends Node\n',
    'a.tscn': EXT_TEXT,
    'b.tscn': EXT_TEXT,
    'spawner.gd': 'const SC = preload("res://player.gd")\nvar q = "res://player.gd"\n',
    'project.godot': 'run/main_scene="res://a.tscn"\n'
  }
  const on = await PLAN(['player.gd'], map, { params: { mode: 'affix', suffix: '_x' } })
  const off = await PLAN(['player.gd'], map, { params: { mode: 'affix', suffix: '_x', update_refs: false } })
  ok(KIND(off.rows, 'rewrite').length === 0, '关掉后一条引用改写都不出', KIND(off.rows, 'rewrite').map((c) => c.rel))
  ok(KIND(off.rows, 'rename').length === 1, '改名那条照出')
  const dOff = N(P(KIND(off.rows, 'rename'), 0).dangling)
  const dOn = N(P(KIND(on.rows, 'rename'), 0).dangling)
  ok(dOn === 0, '开着时没有断链', dOn)
  ok(dOff === 4, '关掉时 dangling = 4 处(a.tscn 1 + b.tscn 1 + spawner.gd 2)—— 与开着时真正改上的处数同源', dOff)
  ok(S(P(KIND(off.rows, 'rename'), 0).reason).includes('已关闭'), 'reason 说清是用户关的,不是工具不会改', P(KIND(off.rows, 'rename'), 0).reason)
}

// ---------------------------------------------------------------- 3. A-23 主场景
section('3. 改主场景 → project.godot 的 run/main_scene 同步(A-23)')
{
  const map = {
    'main.tscn': '[gd_scene format=3]\n',
    'project.godot': 'config_version=5\n[application]\nrun/main_scene="res://main.tscn"\n',
    'export_presets.cfg': '[preset.0]\nrun/main_scene=res://main.tscn\n'
  }
  const r = await PLAN(['main.tscn'], map, { params: { mode: 'regex', pattern: 'main', replacement: 'menu' } })
  const pg = BYREL(r.rows, 'project.godot')
  ok(!!pg && S(F(pg.payload).text).includes('run/main_scene="res://menu.tscn"'), 'project.godot 带引号形态改了', F(pg).payload)
  const cf = BYREL(r.rows, 'export_presets.cfg')
  ok(!!cf && S(F(cf).text || F(cf.payload).text).includes('run/main_scene=res://menu.tscn'),
    '根级 cfg 的**裸值**形态也改(编辑器外手改就是这种写法)', F(cf).payload)
  ok(KIND(r.rows, 'rename').length === 1 && KIND(r.rows, 'rewrite').length === 2, '一条改名 + 两个配置点各一条', r.rows.map((x) => x.rel))
}

// ---------------------------------------------------------------- 4. 读不到 / 规则不认
section('4. 引用点读不到或规则不认时:计进断链并说得出原因,不静默少改')
{
  const map = {
    'player.gd': 'extends Node\n',
    'ok.tscn': EXT_TEXT,
    'big.tscn': EXT_TEXT,
    'bin.tscn': EXT_TEXT
  }
  const r = await PLAN(['player.gd'], map, {
    params: { mode: 'affix', prefix: 'p' },
    ctx: { big: ['big.tscn'], binary: ['bin.tscn'] }
  })
  ok(KIND(r.rows, 'rewrite').length === 1, '只有读得到的那个引用者产改写条', KIND(r.rows, 'rewrite').map((c) => c.rel))
  const dn = N(P(KIND(r.rows, 'rename'), 0).dangling)
  ok(dn === 0, '索引自己读不到的文件**没有证据**说它引用了什么 ⇒ 不臆造处数(臆造会让 N 随项目规模虚涨)', dn)
  const reason = S(P(KIND(r.rows, 'rename'), 0).reason)
  ok(reason.includes('没能读进引用图') && reason.includes('下限'),
    '但必须在 reason 里披露「这个数是下限」—— 报 0 而不说是因为没读进去,就是在给用户一条假保证', reason)
  ok(r.logs.some((l) => l.includes('没读进去') && l.includes('下限')), '日志也要说一次(卡面上看不全时日志是退路)', r.logs)

  // 索引提到、但精确规则不认(注释里的路径)⇒ 也进断链,并说清两边口径不同
  const map2 = {
    'player.gd': 'extends Node\n',
    'note.gd': '# 以前是 "res://player.gd" 这个名字\nvar x = 1\n'
  }
  const r2 = await PLAN(['player.gd'], map2, { params: { mode: 'affix', prefix: 'p' } })
  ok(KIND(r2.rows, 'rewrite').length === 0, '注释里那对引号包住的旧路径不改(内容不是引用)', KIND(r2.rows, 'rewrite').map((c) => c.rel))
  const dn2 = N(P(KIND(r2.rows, 'rename'), 0).dangling)
  ok(dn2 >= 1, '但索引认为它提过 ⇒ 计进断链数,并在日志里说清是两套口径不同', { dn: dn2, logs: r2.logs })
  ok(r2.logs.some((l) => l.includes('精确规则一处没认出')), '日志要能用「一处没认出」这句话解释差异来源', r2.logs)
}

// ---------------------------------------------------------------- 5. 索引拿不到 / 取消
section('5. 引用索引拿不到、以及中途取消')
{
  const map = { 'player.gd': 'extends Node\n', 'a.tscn': EXT_TEXT }
  const noIdx = await PLAN(['player.gd'], map, {
    params: { mode: 'affix', prefix: 'p' },
    ctx: { scanError: true }
  })
  ok(KIND(noIdx.rows, 'rename').length === 1, '索引读不出来 ⇒ **仍然改名**(引用图不是改名的前置条件)', KIND(noIdx.rows, 'rename'))
  ok(KIND(noIdx.rows, 'rewrite').length === 0, '这时不出引用改写条(没有依据就不动别的文件)')
  ok(noIdx.logs.some((l) => l.includes('引用索引读不出来')), '日志要说得出是索引没拿到', noIdx.logs)
  ok(N(P(KIND(noIdx.rows, 'rename'), 0).dangling) === 0, '不知道有几处就报 0 并在日志里说清,不臆造成「全部断链」', P(KIND(noIdx.rows, 'rename'), 0).dangling)
  const trunc = await PLAN(['player.gd'], map, { params: { mode: 'affix', prefix: 'p' }, ctx: { truncated: true } })
  ok(trunc.logs.some((l) => l.includes('被截断')), '清单被截断 ⇒ 日志要说「引用图不完整」(refIndex 判据 7 的下游)', trunc.logs)
  ok(S(P(KIND(trunc.rows, 'rename'), 0).reason).includes('下限'), '截断时那句红字的数只能报成下限', P(KIND(trunc.rows, 'rename'), 0).reason)

  const cancelled = await PLAN(['player.gd', 'a.tscn'], map, { params: { mode: 'affix', prefix: 'p' }, ctx: { cancelled: true } })
  ok(cancelled.rows.length === 0, '取消 ⇒ 一条都不产(不假装做过)', cancelled.rows)
}

// ---------------------------------------------------------------- 6. 序号与顺序
section('6. {index} 的位次来自 files 顺序,与点选顺序无关')
{
  const map = { 'one.gd': 'var a = 1\n', 'two.gd': 'var b = 2\n', 'three.gd': 'var c = 3\n' }
  const p = { mode: 'template', template: 'm{index}{ext}', start: 1, digits: 2 }
  const r1 = await PLAN(['one.gd', 'two.gd'], map, { params: p })
  const r2 = await PLAN(['two.gd', 'one.gd'], map, { params: p })
  ok(KIND(r1.rows, 'rename').map((c) => c.to).join(',') === 'm01.gd,m02.gd',
    '序号按传入顺序递增(files 顺序 = 候选表顺序,§F 契约补充第 2 条)', KIND(r1.rows, 'rename').map((c) => c.to))
  ok(KIND(r2.rows, 'rename').map((c) => c.rel).join(',') === 'two.gd,one.gd',
    '换个点法就是换个序号分布 —— 工具不自己排序,那会让「用户选了哪些」长出第二个真源', KIND(r2.rows, 'rename').map((c) => c.rel))
  const same = await PLAN(['one.gd'], map, { params: p })
  ok(KIND(same.rows, 'rename').map((c) => c.to).join(',') === 'm01.gd', '重跑同一份选择 ⇒ 序号一模一样(可复现)')
}

// ---------------------------------------------------------------- 7. 跳过与不产条
section('7. 算不出合法新名的:跳过 + 日志 + 不产条')
{
  const map = { 'player.gd': 'extends Node\n', 'other.gd': 'var x = 1\n' }
  const bad = await PLAN(['player.gd'], map, { params: { mode: 'regex', pattern: 'player', replacement: 'a/b' } })
  ok(bad.rows.length === 0, '替换结果带 / ⇒ 一条都不产(拦在动手之前)', bad.rows)
  ok(bad.logs.some((l) => l.includes('平台用不了的字符')), '跳过的原因要能在日志里读到(DEV-27 之后这句才上得了卡面)', bad.logs)
  const noop = await PLAN(['player.gd'], map, { params: { mode: 'case', case_mode: 'snake' } })
  ok(noop.rows.length === 0, '改前改后同名 ⇒ 不产假变更', noop.rows)
  ok(noop.logs.some((l) => l.includes('同一个名字')), '并说清为什么没做', noop.logs)
  const empty = await PLAN([], map, { params: { mode: 'affix', prefix: 'p' } })
  ok(empty.rows.length === 0, '一个文件都没选 ⇒ 空清单(框架那句「没有任何要动的东西」接手)')
  const noPattern = await PLAN(['player.gd'], map, { params: { mode: 'regex', pattern: '', replacement: '' } })
  ok(noPattern.rows.length === 0 && noPattern.logs.some((l) => l.includes('正则是空的')), '正则档但规则是空的 ⇒ 说清,不猜', noPattern.logs)
}

// ---------------------------------------------------------------- 8. 多条改名的共用改写
section('8. 一轮里多条改名共用一张表:一个引用者改两处也只出一条改写')
{
  const map = {
    'a.gd': 'extends Node\n',
    'b.gd': 'extends Node\n',
    'use.tscn': '[ext_resource type="Script" path="res://a.gd" id="1"]\n[ext_resource type="Script" path="res://b.gd" id="2"]\n'
  }
  const r = await PLAN(['a.gd', 'b.gd'], map, { params: { mode: 'affix', prefix: 'x_' } })
  const rw = BYREL(r.rows, 'use.tscn')
  ok(!!rw && KIND(r.rows, 'rewrite').length === 1, '一个引用者一条改写(两条引用合在一次正文里)', KIND(r.rows, 'rewrite').map((c) => c.rel))
  ok(S(F(rw && rw.payload).text).includes('res://x_a.gd') && S(F(rw && rw.payload).text).includes('res://x_b.gd'),
    '新正文里两个路径都指到新名', F(rw && rw.payload).text)
  ok(rw && rw.label.includes('2 处'), 'label 那句说的是 2 处(hits 与产出同一循环)', F(rw).label)
  ok(KIND(r.rows, 'rename').length === 2 && KIND(r.rows, 'rename').every((c) => N(c.dangling) === 0),
    '两条改名各自的断链数都是 0', KIND(r.rows, 'rename').map((c) => c.dangling))
}

// ---------------------------------------------------------------- 9. count() 参数预览
section('9. count():表单旁边那句活话')
{
  const map = { 'aa.gd': 'var x = 1\n', 'ab.gd': 'var y = 2\n', 'zz.gd': 'var z = 3\n' }
  const c = (params, rels) => S(M.count(PARAMS(params), Array.isArray(rels) ? rels.map((rel) => ({ rel })) : rels))
  ok(c({ mode: 'regex', pattern: 'a' }, ['aa.gd', 'ab.gd', 'zz.gd']).includes('命中 3 处'),
    '正则档数的是命中处数(与产出同一套正则)', c({ mode: 'regex', pattern: 'a' }, ['aa.gd', 'ab.gd', 'zz.gd']))
  ok(c({ mode: 'regex', pattern: 'zzz' }, ['aa.gd']) === '没有命中任何文件名', '没命中要说「没有命中」而不是空着', c({ mode: 'regex', pattern: 'zzz' }, ['aa.gd']))
  ok(c({ mode: 'regex', pattern: 'a' }, []).includes('还没选文件'), '一个都没选 ⇒ 说清是没选,不是规则错')
  ok(c({ mode: 'regex', pattern: '(' }, ['aa.gd']).startsWith('正则:'), '坏正则 ⇒ 把编译器的话带出来(不自己改写它的错误)', c({ mode: 'regex', pattern: '(' }, ['aa.gd']))
  ok(c({ mode: 'affix', prefix: 'p' }, ['aa.gd']) === '', '非正则档没有「命中处数」这件事 ⇒ 空串,框架不画条')
  ok(c({ mode: 'regex', pattern: 'a' }, undefined).includes('还没选文件'), 'files 不是数组 ⇒ 不抛')
}

// ---------------------------------------------------------------- 10. 源码级红线
section('10. 源码级红线:这一层只吃 ctx,不摸盘也不碰 window')
{
  const src = readFileSync(path.resolve(ROOT, 'src', 'tools', 'builtin', 'gdscript-rename', 'index.ts'), 'utf8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n')
  for (const banned of ['node:fs', 'require(', 'window.', 'localStorage', 'renameSync', 'movePathsToTrash', 'writeProjectText', 'scanProjectTree(']) {
    ok(!code.includes(banned), `entry 里不出现「${banned}」(读写一律经 ctx / 框架)`)
  }
  ok(!/from\s+'[^']*\/toolkit\/orchestrate/.test(code), '不 import orchestrate:措辞归框架,工具只给 label / reason(DEV-7)')
  ok(code.includes("from './refs'") && code.includes("from './modes'"), '算法两件都在本工具目录里(第 2 批不往框架塞 GDScript 知识)')
}

// ---------------------------------------------------------------- 11. 措辞红线:这一层不承诺回退
// §G DEV-20 拍定「本批不做反向改名」,账本对含改名的一轮**整轮拒绝**一键还原(`toollog.refuseReason`)。
// 工具若在 reason 里写「可一键还原」,就是在动盘之前给用户一条框架随后要收回的路 —— 假宿主整页跑第一次
// 就是这么撞上的:改写那条的 reason 承诺了还原,而同一轮的还原按钮被拒。回退真相归框架(warnText),插件这边一个字都不许承诺。
section('11. 插件的 reason / label 里不许出现回退承诺(DEV-20 的措辞半边)')
{
  const map = {
    'player.gd': 'extends Node\n',
    'a.tscn': EXT_TEXT,
    'project.godot': 'run/main_scene="res://a.tscn"\n'
  }
  const r = await PLAN(['player.gd'], map, { params: { mode: 'affix', prefix: 'x_' } })
  const words = r.rows.map((c) => S(c.label) + ' ' + S(c.reason)).join(' | ')
  ok(KIND(r.rows, 'rewrite').length === 1, '这一份产出里确实有改写条(否则下面两条是在验空气)', KIND(r.rows, 'rewrite').map((c) => c.rel))
  ok(!words.includes('一键还原') && !words.includes('可随时还原'), 'reason 与 label 都不承诺回退', words)
  ok(/备份/.test(words), '备份这件事照说(改写前真的会复制,那半句是真的)')

  const src = readFileSync(path.resolve(ROOT, 'src', 'tools', 'builtin', 'gdscript-rename', 'index.ts'), 'utf8')
  ok(!src.includes('一键还原') && !src.includes('可随时还原'), '源码级也钉住:没被这次输入走到的分支同样不许写这句话')
}

console.log(`\n${'='.repeat(56)}\nPASS ${pass}  FAIL ${failures.length}`)
if (failures.length) {
  console.log('失败项:')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log('全部通过')
