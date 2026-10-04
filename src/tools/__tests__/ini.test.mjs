// 工具页 B8:`project.godot` 配置校验(src/tools/inspectors/ini.ts)的断言。
//
// ⚠ 本工具**只报告**(简报 Ruling B8-1):产出的每一条结论都不带 `fix` 字段,连 `kind:'none'` 也不带
//   (`none` 在 fixPlan.ts 里同样执行不了,写了只是让界面多一个灰按钮)。末尾那条 ALL 收集器
//   把每次 run() 的产出都收进 ALL,逐条断言 `!('fix' in f)` —— 将来任何一条判据挂上 fix 都会红,
//   不是只挑几条看。理由写在 ini.ts 文件头:writeProjectText 是整文件覆写,而 parseGodotIni 是只读
//   解析器(不保留注释与排版),我们没有任何「改一条键而不动其余部分」的序列化能力。
//
// ⚠ ★ 那几条是本轮的两条命门:
//   1) 大小写闸(autoload / main_scene / icon 的存在性)配**正向对照** —— 只断言「不报」证明不了闸门
//      真的进了面(短路在任何一道前置闸上都能伪装成「大小写闸生效了」),所以每条旁边都配一条
//      「把树里那份拿掉 → 必须出 error」。做法照 addons.test.mjs:323-331。
//   2) 判据档位与 detail 的措辞一起钉:error 只有「配置点名的文件在这次清单里查不到」这一类形状;
//      写法认不出、值读不出整数、features 撞渲染器名这些一律停在 warn,而且不许替引擎/编辑器说话
//      (简报 Ruling B8-2:凡主张引擎行为的档位,先要有出处)。
//
// 夹具是「内存文件树 + readText 桩」,与 addons/imports/uid/orphans 测试同一份口径(extOf/tree/makeCtx)。
// calls 记 readText 问过的 rel —— 成本红线(判据 10:最多 project.godot + main_scene 两个文件)全靠它。
// 行号一律用 lineOf() 按内容现算,不写死数字(照 godotIni.test.mjs:89-94 的同一做法,夹具一改就错)。
//
// 用法(npm script 会先跑打包步骤):
//   node src/composables/__tests__/build-bundle.mjs && node src/tools/__tests__/ini.test.mjs
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

/** ext 推导与原语两端逐字一致(照 addons/imports/uid/orphans 测试的同一份实现) */
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

/** project.godot 正文:逐行给原样文本(引号、裸值、畸形行、重复行都要能钉死写法) */
function iniText(...lines) { return lines.join('\n') + '\n' }
/**
 * 真实形态的配置正文:头部带上 config_version=5 那一行(本仓两份写盘模板与 B2 的夹具都有它)。
 * 不带就会被判据 4 出一条 info,把别的判据的夹具搅浑 —— 所以只有专门测 config_version 的夹具
 * 才用裸的 iniText()(那两条在旁边各写了注释说明)。
 */
function godot(...lines) { return iniText('config_version=5', '', ...lines) }
/** 某行在正文里的 1-based 行号(写死数字会让夹具一改就错) */
function lineOf(text, needle) {
  const i = text.split('\n').findIndex((l) => l.includes(needle))
  if (i < 0) throw new Error(`夹具里没有这一行: ${needle}`)
  return i + 1
}

/** 引擎自己写盘的干净形态(照 godotIni.test.mjs:44-84 那份真实形态夹具的写法) */
const CLEAN = iniText(
  '; Engine configuration file.',
  '; It is best edited using the editor UI and not directly.',
  'config_version=5',
  '',
  '[application]',
  '',
  'config/name="Demo"',
  'run/main_scene="res://scene/main.tscn"',
  'config/features=PackedStringArray("4.4", "Forward Plus")',
  'config/icon="res://icon.svg"',
  '',
  '[display]',
  '',
  'window/size/viewport_width=1280',
  'window/size/viewport_height=720',
  '',
  '[autoload]',
  '',
  'GameState="*res://autoload/game_state.gd"',
  'Net="$GameState"',
  '',
  '[rendering]',
  '',
  'renderer/rendering_method="forward_plus"'
)
const CLEAN_SPECS = [
  ['project.godot', 400], ['scene/main.tscn', 200], ['icon.svg', 300],
  ['autoload/game_state.gd', 100], ['autoload/net.gd', 100]
]
const SCENE_HEAD = '[gd_scene load_steps=2 format=3 uid="uid://bmain1"]\n[node name="Root" type="Node2D"]\n'

const ids = (fs) => fs.map((f) => f.id).join('|')
const sevOf = (fs) => fs.map((f) => `${f.id}=${f.severity}`).join('|')
const detailOf = (f) => (f && f.detail) || ''

/** 全局收集器:每条结论都进 ALL(末尾的零 fix 红线与形状红线吃它),并核对 rel 落在本次 tree 里 */
const ALL = []
const REL_OK = []
/** 成本红线收集:任何一次 run 的 readText 次数都不许超过 2(判据 10) */
const CALLS = []
async function check(specs, opts = {}) {
  const m = makeCtx(specs, opts)
  const fs = await T.runIni(m.ctx)
  CALLS.push(m.calls.length)
  const rels = new Set(m.ctx.tree.map((f) => f.rel))
  for (const f of fs) {
    ALL.push(f)
    // 降级卡是项目级的,本来就没有主证据文件(与 addons/imports 的 truncatedFinding 同形)
    if (f.id === 'ini:truncated') continue
    REL_OK.push(typeof f.rel === 'string' && rels.has(f.rel))
  }
  return { fs, calls: m.calls }
}

async function main() {
  // ---------- 1. 接线 / 干净项目 / IO 上限 ----------
  section('1. 接线、干净项目与成本')
  ok(typeof T.runIni === 'function' && T.runIni.length === 1,
    'run(ctx) 已进 barrel,签名与 size/cache/brokenRefs/uid/orphans/imports/addons 同形', typeof T.runIni)

  const clean = await check(CLEAN_SPECS, { texts: { 'project.godot': CLEAN, 'scene/main.tscn': SCENE_HEAD } })
  ok(clean.fs.length === 0,
    '★干净项目(照 B2 的真实形态夹具)→ 0 条结论', `${ids(clean.fs)}|${sevOf(clean.fs)}`)
  ok(clean.calls.join('|') === 'project.godot|scene/main.tscn',
    '成本红线:只读 project.godot + main_scene 那一份正文(判据 10 的 1+1)', clean.calls.join('|'))
  ok(/Net="\$GameState"/.test(CLEAN) && clean.fs.length === 0,
    '正向对照:同一条干净夹具里确实有 `$单例` 引用与 `*` 前缀两种形态(上一条 0 结论不是空转)', ids(clean.fs))

  const noKeys = await check([['project.godot', 400]], { texts: { 'project.godot': iniText('config_version=5') } })
  ok(noKeys.fs.length === 0 && noKeys.calls.join('|') === 'project.godot',
    '只有一行 config_version 的项目 → 0 结论、只读 1 个文件', `${ids(noKeys.fs)}|${noKeys.calls.join('|')}`)

  const noIni = await check([['scene/main.tscn', 200], ['icon.svg', 100]], { texts: {} })
  ok(noIni.fs.length === 0 && noIni.calls.length === 0,
    '清单里没有 project.godot(非 Godot 目录/没扫到)→ 0 结论、0 读取(不臆造「配置坏了」)', `${ids(noIni.fs)}|${noIni.calls.length}`)

  const noIniTrunc = await check([['scene/main.tscn', 200]], { texts: {}, trunc: true })
  ok(noIniTrunc.fs.length === 0,
    '连 project.godot 都没有时也不发降级卡(本工具一条判据都没起跑,卡片只会误导)', ids(noIniTrunc.fs))

  const unread = await check([['project.godot', 400]], { texts: {}, fail: { 'project.godot': { skipped: true } } })
  ok(unread.fs.length === 0 && unread.calls.length === 1,
    'project.godot 读不到(超限/二进制/非法路径)→ 一条都不报:证据不出就是不出', ids(unread.fs))

  const iniCase = await check([['Project.godot', 400]], { texts: { 'Project.godot': iniText('config_version=5') } })
  ok(iniCase.calls.join('|') === 'Project.godot' && iniCase.fs.length === 0,
    '根目录 project.godot 的大小写异体也认(读的是 tree 里真存在的那个 rel 名,不是硬拼)', iniCase.calls.join('|'))

  // ---------- 2. 判据 2:重复键 = warn ----------
  section('2. 重复键')
  const DUP_TXT = godot('[application]', '', 'config/name="First"', 'config/name="Second"')
  const dup = await check([['project.godot', 400]], { texts: { 'project.godot': DUP_TXT } })
  ok(ids(dup.fs) === 'ini:dup:application/config/name' && dup.fs[0]?.severity === 'warn',
    '同一 section/key 写两遍 → 一条 warn,id 带 section/key 全形', `${ids(dup.fs)}/${sevOf(dup.fs)}`)
  ok(dup.fs[0]?.line === lineOf(DUP_TXT, 'config/name="Second"') &&
    detailOf(dup.fs[0]).includes(`第 ${lineOf(DUP_TXT, 'config/name="First"')} 行`) &&
    detailOf(dup.fs[0]).includes(`第 ${lineOf(DUP_TXT, 'config/name="Second"')} 行`),
    'detail 与 line 给出**两条各自的行号**(简报:列出全部行号),line 落在生效那一条',
    `${dup.fs[0]?.line}|${detailOf(dup.fs[0])}`)
  ok(detailOf(dup.fs[0]).includes('"First"') && detailOf(dup.fs[0]).includes('"Second"'),
    'detail 同时给出两条各自的 raw(判「写成什么」要靠原文,不是只给行号)', detailOf(dup.fs[0]))
  ok(/生效|读到/.test(detailOf(dup.fs[0])) &&
    detailOf(dup.fs[0]).includes(`第 ${lineOf(DUP_TXT, 'config/name="Second"')} 行那一条`),
    'detail 说清按这份读法哪一条才是读到的值(「取最后一条」是 godotIni.ts:214 的既有约定,不是本工具新发明)',
    detailOf(dup.fs[0]))
  ok(dup.fs[0]?.rel === 'project.godot' && !('fix' in dup.fs[0]),
    '主证据是 project.godot 本身(跳转不会指到一个不存在的键),零 fix', `${dup.fs[0]?.rel}`)

  const DUP3_TXT = godot('[t]', 'k=1', 'k=2', 'k=3')
  const dup3 = await check([['project.godot', 400]], { texts: { 'project.godot': DUP3_TXT } })
  ok(dup3.fs.length === 1 && ['k=1', 'k=2', 'k=3'].every((s) => detailOf(dup3.fs[0]).includes(`第 ${lineOf(DUP3_TXT, s)} 行`)),
    '三条重复也只出一条,三个行号全列', `${dup3.fs.length}|${detailOf(dup3.fs[0])}`)

  const MANY_DUP = godot('[t]', ...Array.from({ length: 25 }, (_, i) => `k=${i}`))
  const manyDup = await check([['project.godot', 400]], { texts: { 'project.godot': MANY_DUP } })
  ok(manyDup.fs.length === 1 && /出现 25 次/.test(detailOf(manyDup.fs[0])) && /另有 5 /.test(detailOf(manyDup.fs[0])),
    '刷屏控制:25 条重复仍一条卡,detail 列前 20 处行号并写出「出现 25 次/另有 5 处未列出」', detailOf(manyDup.fs[0]))
  ok(detailOf(manyDup.fs[0]).includes(`第 ${lineOf(MANY_DUP, 'k=19')} 行`) &&
    !detailOf(manyDup.fs[0]).includes(`第 ${lineOf(MANY_DUP, 'k=20')} 行`),
    '裁切就是前 20 处(第 21 处的行号不出现在 detail 里,而它仍算进「另有 5 处」)', detailOf(manyDup.fs[0]))

  const otherSec = await check([['project.godot', 400]], {
    texts: { 'project.godot': godot('[a]', 'k=1', '', '[b]', 'k=1') }
  })
  ok(otherSec.fs.length === 0, '不同段里的同名键不算重复(section/key 才是同一个键,判据 2 的口径)', ids(otherSec.fs))

  // 两条重复键:文件序是 z 在前,而结论按键的码元序 —— 判据 11 的「顺序只由证据推导」吃这条
  const TWO_DUP = godot('[z]', 'k=1', 'k=2', '', '[a]', 'k=1', 'k=2')
  const twoDup = await check([['project.godot', 400]], { texts: { 'project.godot': TWO_DUP } })
  ok(ids(twoDup.fs) === 'ini:dup:a/k|ini:dup:z/k',
    '两个键都重复 → 两条卡,且按键的码元序而不是文件序(去掉 .sort() 就会红)', ids(twoDup.fs))

  // 简报点名:config_version 顶层重复时,判据 4 与判据 2 别互相吞掉
  const cvDupBad = await check([['project.godot', 400]], {
    texts: { 'project.godot': iniText('config_version=5', 'config_version=abc') }
  })
  ok(ids(cvDupBad.fs) === 'ini:dup:config_version|ini:config-version',
    '★config_version 顶层重复且读到的那条是 "abc" → 重复那条与档位那条都在(不互相吞)', ids(cvDupBad.fs))
  const cvDupOk = await check([['project.godot', 400]], {
    texts: { 'project.godot': iniText('config_version=5', 'config_version=4') }
  })
  ok(ids(cvDupOk.fs) === 'ini:dup:config_version',
    '两条都是整数时只有重复那条(判据 4 不许冒充「值不对」)', ids(cvDupOk.fs))

  // ---------- 3. 判据 3:畸形行 = warn(直接用 parseGodotIni 的 problems,不自己另找) ----------
  section('3. 畸形行')
  const BAD_TXT = iniText('config_version=5', '', 'this line is not a valid entry')
  const bad = await check([['project.godot', 400]], { texts: { 'project.godot': BAD_TXT } })
  ok(ids(bad.fs) === `ini:problem:${lineOf(BAD_TXT, 'not a valid entry')}` && bad.fs[0]?.severity === 'warn',
    '一行没有 = 号 → 一条 warn,id 落在这条的所在行(证据就是这一行)', `${ids(bad.fs)}/${sevOf(bad.fs)}`)
  ok(bad.fs[0]?.line === lineOf(BAD_TXT, 'not a valid entry') &&
    detailOf(bad.fs[0]).includes('this line is not a valid entry'),
    'detail 带行号与**原行文本**(简报判据 3)', `${bad.fs[0]?.line}|${detailOf(bad.fs[0])}`)

  const badHead = await check([['project.godot', 400]], {
    texts: { 'project.godot': godot('[application', 'config/name="X"') }
  })
  ok(badHead.fs.length === 1 && /段头/.test(detailOf(badHead.fs[0])),
    '段头不闭合同样照 parseGodotIni 的 problems 报(本工具不自己另找一类畸形,也不给「段头不闭合」编第二套说法)',
    `${ids(badHead.fs)}|${detailOf(badHead.fs[0])}`)

  const OQ = godot('[t]', 'b=[ "x ]', 'n=1')
  const oddQuote = await check([['project.godot', 400]], {
    texts: { 'project.godot': OQ }
  })
  ok(oddQuote.fs.length === 1 && oddQuote.fs[0]?.id === `ini:problem:${lineOf(OQ, 'b=[')}`,
    '引号不配对的块起始行(B2 的 REASON_ODD_QUOTE)也只一条,紧跟其后的真键没被吞掉', ids(oddQuote.fs))

  const MANY_BAD = iniText('config_version=5', ...Array.from({ length: 25 }, (_, i) => `junk line ${i}`))
  const manyBad = await check([['project.godot', 400]], { texts: { 'project.godot': MANY_BAD } })
  ok(manyBad.fs.length === 1 && manyBad.fs[0]?.id === 'ini:problem:all' && /共 25 行/.test(detailOf(manyBad.fs[0])),
    '刷屏控制:超过 20 行畸形时聚合成一条,detail 写出总行数', `${manyBad.fs.length}|${detailOf(manyBad.fs[0])}`)
  ok(/第 2 行/.test(detailOf(manyBad.fs[0])) && /另有 5 /.test(detailOf(manyBad.fs[0])),
    '聚合那条仍带前若干行的行号与原文(证据不因为聚合就消失)', detailOf(manyBad.fs[0]))

  // 简报判据 3 与 4 的交界:同一行不许报两次
  const cvBadOnly = await check([['project.godot', 400]], {
    texts: { 'project.godot': iniText('config_version=abc', '[application]', '', 'config/name="X"') }
  })
  ok(ids(cvBadOnly.fs) === 'ini:config-version',
    '★config_version=abc 只出判据 4 那一条(problems 里同一行的那条让位,同一行不报两次)', ids(cvBadOnly.fs))

  // ---------- 4. 判据 4:config_version 档位 ----------
  section('4. config_version')
  const cvMissing = await check([['project.godot', 400]], {
    // 这条**故意**用不带 config_version 头部的裸正文:判据 4 测的就是「这一行没有」
    texts: { 'project.godot': iniText('[application]', '', 'config/name="X"') }
  })
  ok(ids(cvMissing.fs) === 'ini:config-version' && cvMissing.fs[0]?.severity === 'info',
    '头部没有 config_version 这一行 → info(不是 warn,更不是 error)', `${ids(cvMissing.fs)}/${sevOf(cvMissing.fs)}`)
  ok(!/值为 0/.test(detailOf(cvMissing.fs[0])) && /没有.*config_version|config_version.*这一行/.test(detailOf(cvMissing.fs[0])),
    '★缺失就说缺失,detail 里不出现「值为 0」(解析器的 0 是「没有」不是「0」,godotIni.ts:58-59)',
    detailOf(cvMissing.fs[0]))

  const cvZero = await check([['project.godot', 400]], { texts: { 'project.godot': iniText('config_version=0') } })
  ok(cvZero.fs.length === 0,
    '★config_version=0 是合法的裸整数:既不报缺失也不报读不出(把 0 当缺失就会在这里露出来)', ids(cvZero.fs))

  const cvStr = await check([['project.godot', 400]], { texts: { 'project.godot': iniText('config_version="5"') } })
  ok(ids(cvStr.fs) === 'ini:config-version' && cvStr.fs[0]?.severity === 'warn',
    '带引号的 "5" 读不出裸整数 → warn(getIniInt 的既有口径,godotIni.ts:252-261)', `${ids(cvStr.fs)}/${detailOf(cvStr.fs[0])}`)

  const cvInSec = await check([['project.godot', 400]], {
    // 同样故意用裸正文:段里那条 config_version 不许冒领项目版本号(顶层仍算「没有这一行」)
    texts: { 'project.godot': iniText('[rendering]', 'config_version=5') }
  })
  ok(ids(cvInSec.fs) === 'ini:config-version' && cvInSec.fs[0]?.severity === 'info',
    '段内的 config_version 不冒领项目版本号(顶层那条仍算缺失,[分叉] 已钉在 godotIni.test.mjs:245-249)',
    `${ids(cvInSec.fs)}/${sevOf(cvInSec.fs)}`)

  const cvLine = await check([['project.godot', 400]], {
    texts: { 'project.godot': iniText('; 注释', 'config_version=abc') }
  })
  ok(cvLine.fs[0]?.line === lineOf('; 注释\nconfig_version=abc\n', 'config_version=abc'),
    'warn 那条带 config_version 自己所在的行号(Finding.line 给视图定位)', cvLine.fs[0]?.line)

  // ---------- 5. 判据 5:[autoload] 每条路径必须存在 ----------
  section('5. autoload 存在性')
  const AU = [['project.godot', 400], ['autoload/one.gd', 50], ['autoload/two.gd', 50]]
  const AU3 = godot('[autoload]', '', 'One="res://autoload/one.gd"', 'Two="*res://autoload/two.gd"', 'Tri="res://autoload/none.gd"')
  const auThree = await check([...AU, ['autoload/gone.gd', 50]], { texts: { 'project.godot': AU3 } })
  ok(ids(auThree.fs) === 'ini:autoload-missing:Tri' && auThree.fs[0]?.severity === 'error',
    '★三条:正常存在、`*` 前缀存在、指向不存在 → 只有第三条出 error', `${ids(auThree.fs)}/${sevOf(auThree.fs)}`)
  ok(detailOf(auThree.fs[0]).includes('Tri') && detailOf(auThree.fs[0]).includes('res://autoload/none.gd') &&
    detailOf(auThree.fs[0]).includes('autoload/none.gd'),
    'error 的证据保住「是哪一条 autoload」:名字 + 原值 + 归一 rel 三样都在(判据 5 逐条要求)',
    detailOf(auThree.fs[0]))
  ok(auThree.fs[0]?.line === lineOf(AU3, 'Tri='),
    'line 给的是那条 autoload 自己的行号(不是聚合位置)', auThree.fs[0]?.line)

  const auStar = await check(AU, { texts: { 'project.godot': godot('[autoload]', 'One="*res://autoload/missing.gd"') } })
  ok(auStar.fs[0]?.severity === 'error' && detailOf(auStar.fs[0]).includes('*res://autoload/missing.gd'),
    '`*` 只当启用标记剥掉再判存在性,detail 仍保留带 `*` 的原值(证据不被改坏)', detailOf(auStar.fs[0]))

  // 两条都缺失:一条卡点名一个单例(id 带名字),而顺序按名字的码元序而非文件序
  const auTwo = await check(AU, {
    texts: { 'project.godot': godot('[autoload]', 'Zed="res://autoload/z.gd"', 'Alpha="res://autoload/a.gd"') }
  })
  ok(ids(auTwo.fs) === 'ini:autoload-missing:Alpha|ini:autoload-missing:Zed',
    '★两条缺失的 autoload → 两条 error,id 落到各自的单例名(聚合结果拿不到这个证据),顺序按名字的码元序',
    ids(auTwo.fs))

  const SKIP_TXT = godot('[autoload]', 'A="$One"', 'B="user://x.gd"', 'C="res://../outside.gd"', 'D="res://"',
    'E="C:/Godot/x.gd"', 'F="/home/x/gd"', 'G=1280')
  const auSkip = await check(AU, { texts: { 'project.godot': SKIP_TXT } })
  ok(auSkip.fs.length === 0,
    '★$单例引用、user://、越界、裸 res://、带盘符、绝对路径、裸整数:一条都不判也不报(判据 5 的「不判」桶)',
    ids(auSkip.fs))
  const auSkip2 = await check([...AU, ['autoload/three.gd', 50]], {
    texts: { 'project.godot': godot('[autoload]', 'A="$One"', 'B="user://x.gd"', 'C="res://../outside.gd"',
      'D="res://"', 'E="C:/Godot/x.gd"', 'F="/home/x/gd"', 'G=1280', 'Bad="res://autoload/gone.gd"') }
  })
  ok(ids(auSkip2.fs) === 'ini:autoload-missing:Bad' && /未判定.*7 条|7 条.*未判定/.test(detailOf(auSkip2.fs[0])),
    '「不判」要看得见:同份配置里有一条真 error 时,7 条被排除的数量写进 detail(B5 立下的口径)',
    detailOf(auSkip2.fs[0]))

  const auCase = await check([['project.godot', 400], ['autoload/game.gd', 50]], {
    texts: { 'project.godot': godot('[autoload]', 'Game="res://Autoload/Game.GD"') }
  })
  ok(auCase.fs.length === 0,
    '★大小写闸:值写 res://Autoload/Game.GD 而清单里是 autoload/game.gd → 不报 error', ids(auCase.fs))
  const auCase2 = await check([['project.godot', 400], ['Autoload/Game.GD', 50]], {
    texts: { 'project.godot': godot('[autoload]', 'Game="res://autoload/game.gd"') }
  })
  ok(auCase2.fs.length === 0,
    '★同一道闸的另一侧:清单写法是异体而值是常规写法 → 仍不报(Windows 上本就是同一个文件)', ids(auCase2.fs))
  // 正向对照:没有它,「不报」可能只是那条 autoload 压根没进面(段名/取值/深度任一前置闸短路都能伪装成闸生效)
  const auCaseCtrl = await check([['project.godot', 400]], {
    texts: { 'project.godot': godot('[autoload]', 'Game="res://Autoload/Game.GD"') }
  })
  ok(ids(auCaseCtrl.fs) === 'ini:autoload-missing:Game',
    '★大小写闸的正向对照:把树里那份异体拿掉就出 error(证明那条值确实进了面,闸是唯一拦下来的东西)', ids(auCaseCtrl.fs))

  const auTrunc = await check([['project.godot', 400]], {
    texts: { 'project.godot': godot('[autoload]', 'Game="res://autoload/gone.gd"') }, trunc: true
  })
  ok(!auTrunc.fs.some((f) => f.id.startsWith('ini:autoload-missing:')),
    '截断时存在性判定整条不做(判据 10):清单不全时「查不到」不是 error 的证据', ids(auTrunc.fs))

  const auDup = await check(AU, {
    texts: { 'project.godot': godot('[autoload]', 'One="res://autoload/one.gd"', 'One="res://autoload/gone.gd"') }
  })
  ok(ids(auDup.fs) === 'ini:autoload-missing:One|ini:dup:autoload/One' &&
    detailOf(auDup.fs[0]).includes('res://autoload/gone.gd'),
    '★同一 autoload 名重复定义:两条结论并存不互相吞掉,存在性用的是读到的那一条(最后一条)的值',
    `${ids(auDup.fs)}|${detailOf(auDup.fs[0])}`)

  const auBare = await check([['project.godot', 400]], {
    texts: { 'project.godot': godot('[autoload]', 'GS=res://autoload/gs.gd') }
  })
  ok(ids(auBare.fs) === 'ini:autoload-missing:GS',
    '未加引号但整串就是路径的裸值照样判存在性(与 B2 的 iniResPaths 裸值通道同口径,godotIni.ts:283-291)',
    ids(auBare.fs))
  const auBareOk = await check([...AU, ['autoload/gs.gd', 50]], {
    texts: { 'project.godot': godot('[autoload]', 'GS=res://autoload/gs.gd') }
  })
  ok(auBareOk.fs.length === 0,
    '裸值正向半边:文件在清单里就 0 结论(B5 说「有人引用它」、B8 说「它在」,两份不能相反)', ids(auBareOk.fs))

  const MESSY_TXT = godot('[ autoload ]', 'A="res://autoload/a.gd"', 'Bad=res://autoload/a.gd "注记"', 'Gone="res://autoload/gone.gd"')
  const auMessy = await check([['project.godot', 400], ['autoload/a.gd', 50]], { texts: { 'project.godot': MESSY_TXT } })
  ok(ids(auMessy.fs) === 'ini:autoload-missing:Gone' && /1 条/.test(detailOf(auMessy.fs[0])),
    '★段头带空气仍认得(A 没被误判);「既不是引号对、整串又不是路径」的值不判存在性而只计数', ids(auMessy.fs))

  const auMessyCtrl = await check([['project.godot', 400], ['autoload/a.gd', 50]], {
    texts: { 'project.godot': godot('[ autoload ]', 'Bad="res://autoload/gone.gd" ') }
  })
  ok(ids(auMessyCtrl.fs) === 'ini:autoload-missing:Bad',
    '反向对照:带尾空白的引号对仍是干净路径 → 该判的照判(排除桶没把正常写法一起吃掉)', ids(auMessyCtrl.fs))

  // ---------- 6. 判据 6:run/main_scene ----------
  section('6. 主场景三档')
  const MS = [['project.godot', 400], ['scene/main.tscn', 200]]
  const msGone = await check([['project.godot', 400]], {
    texts: { 'project.godot': godot('[application]', 'run/main_scene="res://scene/gone.tscn"') }
  })
  ok(ids(msGone.fs) === 'ini:main-scene-missing' && msGone.fs[0]?.severity === 'error',
    '主场景指向清单里没有的文件 → error(与判据 5 同形状)', `${ids(msGone.fs)}/${sevOf(msGone.fs)}`)
  ok(msGone.fs[0]?.rel === 'project.godot' && detailOf(msGone.fs[0]).includes('res://scene/gone.tscn'),
    '主场景 error 的主证据是 project.godot(不是那个不存在的场景),detail 带原值',
    `${msGone.fs[0]?.rel}|${detailOf(msGone.fs[0])}`)

  const msCaseCtrl = await check([['project.godot', 400], ['Scene/Main.TSCN', 200]], {
    texts: { 'project.godot': godot('[application]', 'run/main_scene="res://scene/main.tscn"'), 'Scene/Main.TSCN': SCENE_HEAD }
  })
  ok(msCaseCtrl.fs.length === 0,
    '★主场景这侧的大小写闸:清单写法是异体 → 不报 error(头部核对也照常做完)', ids(msCaseCtrl.fs))

  const msForm = await check(MS, {
    texts: { 'project.godot': godot('[application]', 'run/main_scene="user://x.tscn"') }
  })
  ok(ids(msForm.fs) === 'ini:main-scene-form' && msForm.fs[0]?.severity === 'warn',
    '有值但不是 res:// 写法 → warn(不是 error:这条的主张只是「我们认不得这个写法」)', `${ids(msForm.fs)}/${sevOf(msForm.fs)}`)

  const msRef = await check(MS, {
    texts: { 'project.godot': godot('[application]', 'run/main_scene="$GameState"') }
  })
  ok(ids(msRef.fs) === 'ini:main-scene-form',
    '`$单例` 放在主场景位置同样停在「写法认不出」,不臆造场景文件缺失', ids(msRef.fs))

  const msMessy = await check([['project.godot', 400], ['a.png', 100]], {
    texts: { 'project.godot': godot('[application]', 'run/main_scene=res://a.png "note') }
  })
  ok(ids(msMessy.fs) === 'ini:main-scene-form',
    '★台账留给 B8 的那条:`res://a.png "note`(既不是引号对、整串又不是路径)→ 说出口的是「写法认不出」而不是「文件不存在」',
    ids(msMessy.fs))
  ok(!/不存在|查不到/.test(detailOf(msMessy.fs[0])) && detailOf(msMessy.fs[0]).includes('res://a.png "note'),
    'detail 带原值,而且整句不出现「不存在/查不到」(数据撑不起存在性主张)', detailOf(msMessy.fs[0]))

  const msMessyCtrl = await check([['project.godot', 400]], {
    texts: { 'project.godot': godot('[application]', 'run/main_scene=res://a.png "note') }
  })
  ok(ids(msMessyCtrl.fs) === 'ini:main-scene-form' && msMessyCtrl.calls.length === 1,
    '反向对照:同一个畸形值在 a.png 压根不在清单时也只报「写法认不出」(没顺着升 error),也不为此多读文件',
    `${ids(msMessyCtrl.fs)}|${msMessyCtrl.calls.join('|')}`)

  const msScene = await check(MS, {
    texts: { 'project.godot': godot('[application]', 'run/main_scene="res://scene/main.tscn"'), 'scene/main.tscn': SCENE_HEAD }
  })
  ok(msScene.fs.length === 0 && msScene.calls.join('|') === 'project.godot|scene/main.tscn',
    '存在且头部是 gd_scene → 0 结论,读的第二个文件就是它本身(判据 6 的可选项)', `${ids(msScene.fs)}|${msScene.calls.join('|')}`)

  const msUnread = await check(MS, {
    texts: { 'project.godot': godot('[application]', 'run/main_scene="res://scene/main.tscn"') }
  })
  ok(msUnread.fs.length === 0,
    '★存在但读不到文本 → 0 结论(读不到就当未知,绝不因为读不到而报「场景坏了」)', ids(msUnread.fs))

  const msNotScene = await check(MS, {
    texts: {
      'project.godot': godot('[application]', 'run/main_scene="res://scene/main.tscn"'),
      'scene/main.tscn': '[gd_resource type="Environment" format=3]\n'
    }
  })
  ok(ids(msNotScene.fs) === 'ini:main-scene-not-scene' && msNotScene.fs[0]?.severity === 'warn',
    '头部首 token 是 gd_resource 而不是 gd_scene → warn(证据是这个文件自己写的第一行)',
    `${ids(msNotScene.fs)}/${sevOf(msNotScene.fs)}`)
  ok(/gd_resource/.test(detailOf(msNotScene.fs[0])) && !/编辑器会|加载失败|报错/.test(detailOf(msNotScene.fs[0])),
    'detail 把读到的首 token 抄给用户,而且不主张编辑器的具体后果', detailOf(msNotScene.fs[0]))
  ok(msNotScene.fs[0]?.related?.join('|') === 'scene/main.tscn',
    'related 指向那个真正读得到的场景文件(证据全列,跳转落点仍是 project.godot)', msNotScene.fs[0]?.related)

  const msHeadBlank = await check(MS, {
    texts: {
      'project.godot': godot('[application]', 'run/main_scene="res://scene/main.tscn"'),
      'scene/main.tscn': '\n\n  [gd_scene load_steps=1 format=3]\n'
    }
  })
  ok(msHeadBlank.fs.length === 0, '头部前导空行/缩进不碍事(取第一行**非空**行做首 token 核对)', ids(msHeadBlank.fs))

  const msHeadEmpty = await check(MS, {
    texts: { 'project.godot': godot('[application]', 'run/main_scene="res://scene/main.tscn"'), 'scene/main.tscn': '' }
  })
  ok(msHeadEmpty.fs.length === 0, '空正文 → 首 token 未知,不报(未知不等于坏)', ids(msHeadEmpty.fs))

  const msPng = await check([['project.godot', 400], ['icon.png', 100]], {
    texts: { 'project.godot': godot('[application]', 'run/main_scene="res://icon.png"') }
  })
  ok(msPng.fs.length === 0 && msPng.calls.join('|') === 'project.godot',
    '主场景不是 .tscn 就不花第二次读取去核头部(判据 6 把这条核对只用在 .tscn 上)',
    `${ids(msPng.fs)}|${msPng.calls.join('|')}`)

  const msNone = await check([['project.godot', 400]], {
    texts: { 'project.godot': iniText('config_version=5', '', '[application]', '', 'config/name="X"') }
  })
  ok(msNone.fs.length === 0, '没有 run/main_scene 这个键 → 不报(空项目/新建项目就是这个形状)', ids(msNone.fs))

  const msBareGone = await check([['project.godot', 400], ['autoload/gs.gd', 50]], {
    texts: { 'project.godot': godot('[application]', 'run/main_scene=res://scene/gone.tscn', '', '[autoload]', 'GS=res://autoload/gs.gd') }
  })
  ok(ids(msBareGone.fs) === 'ini:main-scene-missing' && msBareGone.calls.length === 1,
    '裸值主场景按「整串是路径」认 → 该判存在性就判(与同一条裸值 autoload 判法一致,且没为它多读文件)',
    ids(msBareGone.fs))

  // ---------- 7. 判据 7:config/icon ----------
  section('7. 项目图标')
  const iconGone = await check([['project.godot', 400]], {
    texts: { 'project.godot': godot('[application]', 'config/icon="res://icon.svg"') }
  })
  ok(ids(iconGone.fs) === 'ini:icon-missing' && iconGone.fs[0]?.severity === 'warn',
    '图标指向不存在的文件 → warn(判据 7 明写不是 error)', `${ids(iconGone.fs)}/${sevOf(iconGone.fs)}`)
  ok(iconGone.fs.length === 1 && !('fix' in iconGone.fs[0]) &&
    Object.keys(iconGone.fs[0]).join(',') === 'id,severity,title,detail,rel,line',
    '结论形状:不带 fix,字段只有声明过的那几个', Object.keys(iconGone.fs[0] || {}).join('|'))

  const iconTrunc = await check([['project.godot', 400]], {
    texts: { 'project.godot': godot('[application]', 'config/icon="res://icon.svg"') }, trunc: true
  })
  ok(!iconTrunc.fs.some((f) => f.id === 'ini:icon-missing'),
    '★icon 的存在性 warn 在 ctx.truncated 时不出(简报测试清单点名的这一条)', ids(iconTrunc.fs))

  const iconOk = await check([['project.godot', 400], ['icon.svg', 100]], {
    texts: { 'project.godot': godot('[application]', 'config/icon="res://icon.svg"') }
  })
  ok(iconOk.fs.length === 0, '图标在清单里 → 0 结论', ids(iconOk.fs))

  const iconNoKey = await check([['project.godot', 400]], { texts: { 'project.godot': iniText('config_version=5') } })
  ok(iconNoKey.fs.length === 0, '没有 config/icon 这个键 → 不报(判据 7 的后半)', ids(iconNoKey.fs))

  const iconOdd = await check([['project.godot', 400]], {
    texts: { 'project.godot': godot('[application]', 'config/icon="user://icon.svg"') }
  })
  ok(iconOdd.fs.length === 0, '图标值不是 res:// 写法 → 不报也不判(判据 7 只承诺「归一后不在清单」这一种主张)',
    ids(iconOdd.fs))

  // ---------- 8. 判据 8:整数值键 ----------
  section('8. 整数键形态')
  const intBad = await check([['project.godot', 400]], {
    texts: { 'project.godot': godot('[display]', 'window/size/viewport_width="abc"') }
  })
  ok(ids(intBad.fs) === 'ini:int:display/window/size/viewport_width' && intBad.fs[0]?.severity === 'warn',
    'viewport_width 读不出整数 → warn,id 带 fullKey', `${ids(intBad.fs)}/${sevOf(intBad.fs)}`)
  ok(intBad.fs[0]?.line === lineOf(godot('[display]', 'window/size/viewport_width="abc"'), 'viewport_width') &&
    detailOf(intBad.fs[0]).includes('window/size/viewport_width'),
    'detail/line 说清是哪个键、第几行(判据 8 的「不是整数」要能定位)', `${intBad.fs[0]?.line}|${detailOf(intBad.fs[0])}`)

  const intStr = await check([['project.godot', 400]], {
    texts: { 'project.godot': godot('[display]', 'window/size/viewport_height="720"') }
  })
  ok(intStr.fs[0]?.severity === 'warn' && /本工具读不出/.test(detailOf(intStr.fs[0])) &&
    !/引擎会|编辑器会|一定会|报错/.test(detailOf(intStr.fs[0])),
    '带引号的整数也只说「本工具读不出整数」,不主张引擎/编辑器会怎么处理它(Ruling B8-2)', detailOf(intStr.fs[0]))

  const intFloat = await check([['project.godot', 400]], {
    texts: { 'project.godot': godot('[display]', 'window/size/viewport_width=12.5') }
  })
  ok(ids(intFloat.fs) === 'ini:int:display/window/size/viewport_width', '小数同样读不出整数 → warn', ids(intFloat.fs))

  const intNeg = await check([['project.godot', 400]], {
    texts: { 'project.godot': godot('[display]', 'window/size/viewport_width=-1', 'window/size/viewport_height=0') }
  })
  ok(intNeg.fs.length === 0,
    '负数与 0 都是合法裸整数 → 不报(本工具不判取值范围,那需要引擎取证)', ids(intNeg.fs))

  const intWrongSection = await check([['project.godot', 400]], {
    texts: { 'project.godot': godot('[application]', 'window/size/viewport_width="abc"') }
  })
  ok(intWrongSection.fs.length === 0,
    'fullKey 必须带段名:[application] 下的同名键不是那条显示设置(不判,也不冒领)', ids(intWrongSection.fs))

  const intNoKey = await check([['project.godot', 400]], { texts: { 'project.godot': iniText('config_version=5') } })
  ok(intNoKey.fs.length === 0, '这两个键都没写 → 不报(判据 8 只在「有值而读不出整数」时开口)', ids(intNoKey.fs))

  // ---------- 9. 判据 9:features 里的渲染器名 ----------
  section('9. features 渲染器')
  const ftConflict = await check([['project.godot', 400]], {
    texts: { 'project.godot': godot('[application]', 'config/features=PackedStringArray("4.4", "Forward Plus", "Mobile")') }
  })
  ok(ids(ftConflict.fs) === 'ini:features-renderers' && ftConflict.fs[0]?.severity === 'warn',
    '★features 同时含两个渲染器名 → 一条 warn,证据就是数组本身', `${ids(ftConflict.fs)}/${sevOf(ftConflict.fs)}`)
  ok(detailOf(ftConflict.fs[0]).includes('Forward Plus') && detailOf(ftConflict.fs[0]).includes('Mobile'),
    'detail 把撞上的两个名字都点名', detailOf(ftConflict.fs[0]))
  ok(/引擎版本/.test(detailOf(ftConflict.fs[0])) && /不.*比|没.*比/.test(detailOf(ftConflict.fs[0])),
    'detail 明说这条不比「绑定的引擎版本」(判据 9 第二条:ToolContext 里没有那份数据)', detailOf(ftConflict.fs[0]))

  const ftThree = await check([['project.godot', 400]], {
    texts: { 'project.godot': godot('[application]', 'config/features=PackedStringArray("4.4", "Forward Plus", "Mobile", "GL Compatibility")') }
  })
  ok(ftThree.fs.length === 1 && detailOf(ftThree.fs[0]).includes('GL Compatibility'),
    '三个名字都在也只出一条,detail 把三个全列(一条卡讲一件事)', `${ftThree.fs.length}|${detailOf(ftThree.fs[0])}`)

  const ftOk = await check([['project.godot', 400]], {
    texts: { 'project.godot': godot('[application]', 'config/features=PackedStringArray("4.7", "Forward Plus")') }
  })
  ok(ftOk.fs.length === 0, '正常 PackedStringArray("4.7","Forward Plus") → 0 结论', ids(ftOk.fs))

  const ftArr = await check([['project.godot', 400]], {
    texts: { 'project.godot': godot('[application]', 'config/features=["Forward Plus", "Mobile"]') }
  })
  ok(ids(ftArr.fs) === 'ini:features-renderers',
    '[...] 数组形态同样读得出(getIniList 认两种写法),撞名照判', ids(ftArr.fs))

  const ftBare = await check([['project.godot', 400]], {
    texts: { 'project.godot': godot('[application]', 'config/features="4.4"') }
  })
  ok(ftBare.fs.length === 0, '裸串形态 getIniList 给 undefined → 当未知,不报也不猜(判据 9 第一条)', ids(ftBare.fs))

  // 这一条是上一条的「有牙」版本:形态认不出时**连数组内容都没有**,所以「不猜」这条判据要能被变异打到
  const ftTwo = await check([['project.godot', 400]], {
    texts: { 'project.godot': godot('[application]', 'config/features="Forward Plus" "Mobile"') }
  })
  ok(ftTwo.fs.length === 0,
    '★值不是 PackedStringArray/数组形态时,哪怕原文里肉眼看得出两个渲染器名也不开口 —— 不替 B2 的读法猜数组',
    ids(ftTwo.fs))

  const ftCase = await check([['project.godot', 400]], {
    texts: { 'project.godot': godot('[application]', 'config/features=PackedStringArray("forward plus", "mobile")') }
  })
  ok(ftCase.fs.length === 0,
    '名字只认本仓写盘表里的那三种拼写:小写异体不触发(方向是少报,不是判它坏了)', ids(ftCase.fs))

  const ftNoKey = await check([['project.godot', 400]], { texts: { 'project.godot': iniText('config_version=5') } })
  ok(ftNoKey.fs.length === 0, '没有 config/features 这个键 → 不报', ids(ftNoKey.fs))

  // ---------- 10. 判据 10:截断降级 ----------
  section('10. 截断降级')
  const TRUNC_SPECS = [['project.godot', 400], ['scene/main.tscn', 200], ['icon.svg', 100]]
  const TRUNC_TEXT = iniText(
    'config_version=5',
    'config_version=4',
    '',
    '[application]',
    '',
    'run/main_scene="res://scene/gone.tscn"',
    'config/icon="res://gone.svg"',
    '',
    '[autoload]',
    '',
    'One="res://autoload/gone.gd"',
    '',
    '[display]',
    '',
    'window/size/viewport_width="abc"',
    'this line is not a valid entry'
  )
  const PBAD = lineOf(TRUNC_TEXT, 'not a valid entry')
  const fullRun = await check(TRUNC_SPECS, { texts: { 'project.godot': TRUNC_TEXT } })
  ok(ids(fullRun.fs) ===
    `ini:autoload-missing:One|ini:main-scene-missing|ini:dup:config_version|ini:problem:${PBAD}|ini:int:display/window/size/viewport_width|ini:icon-missing`,
    '完整清单下的定死类别序(error 在前、内容型 warn 随后、存在性 warn 收尾)', ids(fullRun.fs))
  const truncRun = await check(TRUNC_SPECS, { texts: { 'project.godot': TRUNC_TEXT }, trunc: true })
  ok(truncRun.fs[0]?.id === 'ini:truncated' && truncRun.fs[0]?.severity === 'warn',
    '降级卡排首位', ids(truncRun.fs))
  ok(!truncRun.fs.some((f) => /^(ini:autoload-missing:|ini:main-scene-missing$|ini:icon-missing$)/.test(f.id)),
    '★三条存在性(单例/主场景/图标)在截断时一条都不出', ids(truncRun.fs))
  ok(ids(truncRun.fs) ===
    `ini:truncated|ini:dup:config_version|ini:problem:${PBAD}|ini:int:display/window/size/viewport_width`,
    '重复键、畸形行、整数形态这些内容型判据截断时照常判(B6 裁定 3 的同一读法)', ids(truncRun.fs))
  ok(/本次不做/.test(truncRun.fs[0]?.title || '') && /重复|畸形|写法/.test(detailOf(truncRun.fs[0])),
    '截断卡说清做了什么、没做什么', `${truncRun.fs[0]?.title}|${detailOf(truncRun.fs[0])}`)
  ok(truncRun.fs.length > 1 && !('rel' in truncRun.fs[0]),
    '降级卡不带 rel(项目级结论没有主证据文件,末尾的 rel 红线按 id 放过它)', Object.keys(truncRun.fs[0] || {}).join('|'))

  // ---------- 11. 判据 11:确定性与成本 ----------
  section('11. 顺序与 id 稳定')
  const rev = await check([...TRUNC_SPECS].reverse(), { texts: { 'project.godot': TRUNC_TEXT } })
  ok(JSON.stringify(rev.fs) === JSON.stringify(fullRun.fs),
    '反序 tree → findings 逐字节一致(顺序只由证据推导,不由扫描顺序)', ids(rev.fs))
  const shuffled = await check([TRUNC_SPECS[2], TRUNC_SPECS[0], TRUNC_SPECS[1]], { texts: { 'project.godot': TRUNC_TEXT } })
  ok(JSON.stringify(shuffled.fs) === JSON.stringify(fullRun.fs), '交错 tree 顺序 → 同一份结论', ids(shuffled.fs))
  ok(shuffled.calls.join('|') === rev.calls.join('|') && shuffled.calls.join('|') === 'project.godot',
    '读取顺序也定死(只读根目录 project.godot 那一个写法),tree 抖动不会换读法', shuffled.calls.join('|'))

  const dupKey = await check([['project.godot', 400]], { texts: { 'project.godot': godot('[t]', 'k=1', 'k=2') } })
  ok(dupKey.fs[0]?.id === 'ini:dup:t/k' && !/:\d+$/.test(dupKey.fs[0]?.id || ''),
    '重复键的 id 只由 section/key 推导,不含出现次序的下标(改行序不会换键)', dupKey.fs[0]?.id)

  const eqSpell = await check([['project.godot', 400], ['Project.godot', 400], ['icon.svg', 100]], {
    texts: {
      'project.godot': godot('[application]', 'config/icon="res://ICON.SVG"'),
      'Project.godot': godot('[application]', 'config/icon="res://ICON.SVG"')
    }
  })
  ok(eqSpell.fs.length === 0 && eqSpell.calls.length === 1 && eqSpell.calls[0] === 'project.godot',
    '同一份配置的大小写重复条目只读一份、只判一次(畸形清单不双报)', `${eqSpell.fs.length}|${eqSpell.calls.join('|')}`)

  // ---------- 12. 真实形态夹具端到端 ----------
  section('12. 真实形态夹具(B2 那份 INI_REAL)')
  const REAL = iniText(
    '; Engine configuration file.',
    '; It can be edited manually, but the editor rewrites it on every change.',
    'config_version=5',
    '',
    '[application]',
    '',
    'config/name="A=B"',
    'run/main_scene="res://scene/main.tscn"',
    'config/features=PackedStringArray("4.3", "Forward Plus")',
    'config/icon="res://icon.svg"',
    '',
    '[ display ]',
    '',
    'window/size/viewport_width=1280',
    'window/size/viewport_height=720',
    'window/stretch/mode="canvas_items"',
    '',
    '[autoload]',
    '',
    'GameState="*res://autoload/game_state.gd"',
    'Net="$GameState"',
    '',
    '[editor_plugins]',
    '',
    'enabled=PackedStringArray("res://addons/foo/plugin.cfg")',
    '',
    '[input]',
    '',
    'move_left={',
    '"deadzone": 0.5,',
    '"events": [Object(InputEventKey,"resource_local_to_scene":false,"string=\\"a]b\\"","physical_keycode":65)',
    ']',
    '}',
    '',
    '[rendering]',
    '',
    'renderer/rendering_method="gl_compatibility"',
    'renderer/rendering_method="forward_plus"',
    'this line is not a valid entry'
  )
  const real = await check(
    [
      ['project.godot', 900], ['scene/main.tscn', 200], ['icon.svg', 300],
      ['autoload/game_state.gd', 100], ['addons/foo/plugin.cfg', 100]
    ],
    { texts: { 'project.godot': REAL, 'scene/main.tscn': SCENE_HEAD } }
  )
  ok(ids(real.fs) === `ini:dup:rendering/renderer/rendering_method|ini:problem:${lineOf(REAL, 'not a valid entry')}`,
    '★真实形态文件只报「重复的 rendering_method」与「最后一行畸形」两条:多行 [input] 块、块里带 ] 的字符串、' +
    '`$` 引用、段头带空气都不被误判(判据 1 复用 B2 解析器的回报)', ids(real.fs))
  ok(real.calls.join('|') === 'project.godot|scene/main.tscn', '端到端也只有 2 次读取', real.calls.join('|'))
  ok(real.fs[0]?.line === lineOf(REAL, 'rendering_method="forward_plus"') &&
    detailOf(real.fs[0]).includes(`第 ${lineOf(REAL, 'rendering_method="gl_compatibility"')} 行`),
    '重复的 rendering_method 两条行号都在 detail,line 给生效的那一条(第 37/38 行那种)',
    `${real.fs[0]?.line}|${detailOf(real.fs[0])}`)

  // ---------- 13. 全局红线 ----------
  section('13. 全局红线(上面每一条结论)')
  ok(ALL.length > 40 && ALL.every((f) => !('fix' in f)),
    `★零 fix 面:全部 ${ALL.length} 条结论一条都不带 fix 字段(Ruling B8-1:本轮零 fix,rewrite 不做)`,
    ALL.filter((f) => 'fix' in f).map((f) => f.id).join('|'))
  ok(ALL.every((f) => f.id === 'ini:truncated' || /只报告|不改写|不代改/.test(detailOf(f))),
    '每条结论都把「只报告、不动手」说给用户(简报:detail 说「哪个键、现在的值、自己怎么核对」)',
    ALL.filter((f) => f.id !== 'ini:truncated' && !/只报告|不改写|不代改/.test(detailOf(f))).map((f) => f.id).join('|'))
  const withRel = ALL.filter((f) => f.id !== 'ini:truncated').length
  ok(REL_OK.length === withRel && REL_OK.length > 0 && REL_OK.every(Boolean),
    `除降级卡外每条结论的 rel 都在本次 tree 里(${REL_OK.length} 条,跳转不会是死链)`,
    `${REL_OK.filter(Boolean).length}/${withRel}`)
  ok(ALL.every((f) => f.id.startsWith('ini:') && ['error', 'warn', 'info'].includes(f.severity) &&
      typeof f.title === 'string' && f.title.length > 0),
    'id 一律 ini: 前缀、severity 合法、title 非空',
    ALL.filter((f) => !f.id.startsWith('ini:')).map((f) => f.id).join('|'))
  ok(ALL.every((f) => !/undefined|null|[Tt]rue|NaN|\d{10,}/.test(f.id)),
    'id 只由证据(段名/键名/autoload 名/行号)推导,不含 undefined/NaN/大数字串味',
    ALL.filter((f) => /undefined|null|[Tt]rue|NaN|\d{10,}/.test(f.id)).map((f) => f.id).join('|'))
  ok(ALL.every((f) => f.id === 'ini:truncated' || (typeof f.detail === 'string' && f.detail.length > 0)),
    '除降级卡外每条都有 detail(证据要说得出出处)',
    ALL.filter((f) => f.id !== 'ini:truncated' && !f.detail).map((f) => f.id).join('|'))
  ok(ALL.filter((f) => f.severity === 'error').every((f) => /^ini:(autoload-missing:|main-scene-missing$)/.test(f.id)),
    `error 档只有「配置点名的文件在这次清单里查不到」两类(${ALL.filter((f) => f.severity === 'error').length} 条),其余判据永不升 error`,
    ALL.filter((f) => f.severity === 'error' && !/^ini:(autoload-missing:|main-scene-missing$)/.test(f.id)).map((f) => f.id).join('|'))
  ok(Math.max(...CALLS) <= 2,
    `★成本红线:全部 ${CALLS.length} 次 run 里 readText 次数最多 ${Math.max(...CALLS)} 次(判据 10 钉的 1+1)`,
    String(Math.max(...CALLS)))
}

main().catch((e) => {
  console.error(`\n测试脚本抛错: ${e && e.stack ? e.stack : e}`)
  process.exit(1)
}).then(() => {
  console.log(`\n${'='.repeat(56)}\nPASS ${pass}  FAIL ${failures.length}`)
  if (failures.length) { console.log('失败项:'); for (const f of failures) console.log('  - ' + f); process.exit(1) }
  console.log('全部通过')
})
