// 工具页渲染层断言:tree 聚合纯函数 + .tscn 解析器 + 3 个 P0 检查器。
//
// 为什么合成一个文件:P0a 的六套逻辑都吃同一份「内存项目树」夹具,
// 拆成六个文件就要六份 fixture —— 需要分开的是**函数**,不是文件。
// 每个 section 顶部注释写清「为什么这条断言存在」,改断言前先读。
//
// 用法(npm script 会先跑打包步骤):
//   node src/composables/__tests__/build-bundle.mjs && node src/tools/__tests__/tools.test.mjs
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

/**
 * 造文件清单:[ [rel, size, mtimeOffsetDays?] ]
 *
 * ext 推导必须与原语两端逐字一致(只取**文件名 basename**,最后一个点在其后才截,统一小写):
 *   · JS  端 src-ztools/preload/lib/inspectfs.js:263  `path.extname(rel).slice(1).toLowerCase()`
 *   · Rust 端 src-tauri/src/inspectfs.rs:83-88        `ext_of(name)`,name 就是文件名
 * 旧夹具对整个 rel 做 `rel.split('.').pop()`:'.gitignore' 得 'gitignore'、'scene/.hidden'
 * 得 'hidden'、'v1.2/build' 得 '2/build',两端原语给的都是空串。真实 Godot 项目里
 * .gitignore/.gdignore 满地都是,Tasks 11-13 还要在这份夹具上继续加断言 —— 推导先对上。
 */
function extOf(rel) {
  const base = rel.slice(rel.lastIndexOf('/') + 1)
  const i = base.lastIndexOf('.')
  return i > 0 ? base.slice(i + 1).toLowerCase() : ''
}
function tree(specs) {
  const base = Date.UTC(2026, 0, 1)
  return specs.map(([rel, size, off = 0]) => ({
    rel,
    size,
    mtimeMs: base + off * 86400000,
    ext: extOf(rel)
  }))
}

/**
 * 各检查器共用的 ctx 工厂:specs 走上面那个 tree(),trunc 控制截断标记。
 *
 * 放在 tree() **下面**而不是 brief 说的「`const T = await import(...)` 之后」:
 * 它调 tree(),挨着读才看得出夹具是同一份(函数声明提升,位置只影响可读性)。
 * readText 只认 texts 里显式给的字符串,其余一律 `{ skipped: true }` ——
 * 与宿主原语同形(缺文件 / 超 maxBytes / 二进制都是「读不到」,不是「读出错」),
 * 检查器必须把它当「跳过」而不是「断链」(Tasks 9/10 审查钉的三态口径)。
 */
function makeCtx(specs, { trunc = false, texts = {} } = {}) {
  return {
    projectId: 'godot/project/p',
    root: 'E:/proj',
    truncated: trunc,
    tree: tree(specs),
    readText: async (rel) => (typeof texts[rel] === 'string' ? { text: texts[rel] } : { skipped: true })
  }
}

async function main() {
  // ---------- 1. treeUtils ----------
  section('1. treeUtils')
  // 为什么存在:体积/数量类结论全靠这几个函数,口径一旦错(比如把 project.godot 当缓存、
  // 把 .tscn.uid 并进 .tscn),界面上每个数字都错,而且检查器的判定会跟着翻。
  const T1 = tree([
    ['project.godot', 100],
    ['scene/main.tscn', 500],
    ['scene/main.tscn.uid', 40],
    ['.godot/imported/a.stex', 900],
    ['.godot/editor_state.cfg', 10],
    ['assets/bg.png', 5000],
    ['addons/one/plugin.cfg', 20]
  ])
  // 入参快照:rel + size + mtimeMs + ext 四字段一起比 —— 既抓「原地 sort 改了顺序」也抓
  // 「改写了元素的任何字段」。旧版只比 rel+size,`tree.forEach(f => { f.mtimeMs = 0 })`
  // 这类污染完全溜得过(实测 55 条照全绿)。
  const snapshot = () => T1.map((f) => `${f.rel}:${f.size}:${f.mtimeMs}:${f.ext}`).join('|')
  const T1_BEFORE = snapshot()

  // 夹具自检(见文件头 extOf 注释):钉住「夹具与两端原语同口径」。改回旧推导
  // (rel.split('.').pop())时这三条立刻变红。
  ok(tree([['.gitignore', 5]])[0].ext === '', '夹具 ext:.gitignore 归空串(原语口径,非 gitignore)',
    JSON.stringify(tree([['.gitignore', 5]])[0].ext))
  ok(tree([['scene/.hidden', 5]])[0].ext === '' && tree([['v1.2/build', 5]])[0].ext === '',
    '夹具 ext:basename 以 . 开头 / 点只在目录名里都给空串',
    [tree([['scene/.hidden', 5]])[0].ext, tree([['v1.2/build', 5]])[0].ext].map((e) => JSON.stringify(e)).join(' / '))
  ok(tree([['a.tar.gz', 5]])[0].ext === 'gz', '夹具 ext:多点文件名取最后一段',
    JSON.stringify(tree([['a.tar.gz', 5]])[0].ext))
  // 点文件的真实去向:与 LICENSE 一起并进 (无扩展名),而不是各自成 'gitignore' 组
  const NOEXT = tree([['.gitignore', 5], ['.gdignore', 5], ['LICENSE', 5], ['a.tar.gz', 5]])
  const noExtGroup = T.groupByExt(NOEXT).find((g) => g.ext === '(无扩展名)')
  ok(noExtGroup?.count === 3 && noExtGroup?.bytes === 15 &&
    T.groupByExt(NOEXT).find((g) => g.ext === 'gz')?.count === 1,
    '点文件与无点文件合并进 (无扩展名) 组', JSON.stringify(T.groupByExt(NOEXT)))

  // isCache 是「缓存体积」与「源码体积」两条统计的唯一分界,必须按路径段判:
  // 子串匹配(rel.includes('.godot'))会把每个项目都有的 project.godot 误判成缓存。
  ok(T.isCache('.godot/imported/a.stex') === true, 'isCache 认 .godot/ 前缀')
  ok(T.isCache('scene/.godot/x') === true, 'isCache 认任意层级的 .godot/')
  ok(T.isCache('a/b/.godot/imported/c.stex') === true, 'isCache 认更深一层 .godot/')
  ok(T.isCache('.godot') === true, 'isCache 认裸的 .godot 目录名')
  ok(T.isCache('addons/res.godot/x') === false, 'isCache 不把名为 res.godot 的目录算成缓存')
  ok(T.isCache('project.godot') === false, 'isCache 不误伤普通文件')
  ok(T.isCache('.godotx/y') === false, 'isCache 不被 .godot 打头的别的目录名骗到')
  ok(T.isCache('godot/notes.md') === false, 'isCache 不被文件名里的 godot 骗到')
  ok(T.noCache(T1).length === 5, 'noCache 去掉两条缓存记录', T.noCache(T1).length)
  ok(T.sumBytes(T1) === 6570, 'sumBytes 合计全部', T.sumBytes(T1))
  // 计划书此处写的是 660 —— 漏算了 assets/bg.png 的 5000(100+500+40+5000+20=5660)。
  // 以实现真实输出为准,不迁就错值。
  ok(T.sumBytes(T.noCache(T1)) === 5660, 'noCache 后合计只剩源文件', T.sumBytes(T.noCache(T1)))

  const byExt = T.groupByExt(T1)
  // 用 ?. 取值:分组缺失时报 FAIL,而不是抛 TypeError 让整个脚本崩掉(崩了看不到是哪条错)
  ok(byExt.find((g) => g.ext === 'png')?.bytes === 5000, 'groupByExt 能按类型查到体积')
  ok(byExt.find((g) => g.ext === 'uid')?.count === 1, 'uid 单独成组(不并进 tscn)')
  ok(byExt.find((g) => g.ext === 'cfg')?.bytes === 30 && byExt.find((g) => g.ext === 'cfg')?.count === 2,
    '同名扩展名跨目录合并(两条 .cfg)', JSON.stringify(byExt.find((g) => g.ext === 'cfg')))
  ok(byExt.every((g, i) => i === 0 || byExt[i - 1].bytes >= g.bytes), 'groupByExt 按体积降序')
  ok(T.groupByExt(T1, 2).length === 2 && T.groupByExt(T1, 2).map((g) => g.ext).join(',') === 'png,stex',
    '传 n 时截断且截的是头部(留最大的)', T.groupByExt(T1, 2).map((g) => g.ext).join(','))
  // 统一 top-N 口径(审查 F-2):n 省略或 <= 0 → 返回整个降序清单,三个函数同规则。
  // 旧行为分叉:groupByExt/groupByTopDir 用 `n ? slice : out`(0=全部、-1=悄悄丢最小
  // 一组),topFiles 用 Math.max(0,n)(0/-1=全空)—— 下面六条把共享规则钉死。
  ok(T.groupByExt(T1, 0).length === byExt.length, 'groupByExt n=0 返回整个降序清单(不是空组)',
    T.groupByExt(T1, 0).length)
  ok(T.groupByExt(T1, -1).length === byExt.length, 'groupByExt n<0 同返回全部(旧值丢最小一组→5)',
    T.groupByExt(T1, -1).length)
  ok(T.groupByExt(T1, 99).length === byExt.length, 'groupByExt n 超出组数返回全部')
  ok(T.groupByExt([tree([['LICENSE', 5]])[0]]).find((g) => g.ext === '(无扩展名)')?.count === 1,
    'ext 空串归入 (无扩展名)')

  const byDir = T.groupByTopDir(T.noCache(T1))
  ok(byDir.find((d) => d.dir === 'scene')?.bytes === 540, '嵌套文件并进顶层目录', JSON.stringify(byDir))
  ok(byDir.find((d) => d.dir === 'scene')?.count === 2, '顶层目录组同时给出条数')
  ok(byDir.find((d) => d.dir === '(根目录)')?.bytes === 100, '根目录文件归进 (根目录)', JSON.stringify(byDir))
  ok(byDir.every((g, i) => i === 0 || byDir[i - 1].bytes >= g.bytes), 'groupByTopDir 按体积降序')
  ok(T.groupByTopDir(T.noCache(T1), 0).length === byDir.length, 'groupByTopDir n=0 返回整个降序清单(同规则)',
    T.groupByTopDir(T.noCache(T1), 0).length)
  ok(T.groupByTopDir(T.noCache(T1), -1).length === byDir.length, 'groupByTopDir n<0 同返回全部(旧值→4)',
    T.groupByTopDir(T.noCache(T1), -1).length)

  const beforeTop = snapshot()
  const top = T.topFiles(T1, 3)
  // 计划书此处期望 ['.godot/imported/a.stex', ...] —— 但 bg.png 5000 > a.stex 900,
  // 降序取前 3 的第一名就是 assets/bg.png。以实现真实输出为准。
  ok(top.map((f) => f.rel).join('|') === 'assets/bg.png|.godot/imported/a.stex|scene/main.tscn',
    'topFiles 取前 n 且降序', JSON.stringify(top.map((f) => f.rel)))
  // 口径从「n=0 → 空数组」改为与 group 函数一致:n<=0 返回整个清单(审查 F-2,
  // 排名摘要里「0 个」无意义,静默空输出比全量更糟)。
  ok(T.topFiles(T1, 0).length === T1.length, 'topFiles n=0 返回整个降序清单(与 group 函数同规则)',
    T.topFiles(T1, 0).length)
  ok(T.topFiles(T1, -1).length === T1.length, 'topFiles n<0 同返回全部(旧值→空数组)',
    T.topFiles(T1, -1).length)
  ok(T.topFiles(T1, 99).length === T1.length, 'n 超过长度时返回全部,不报错')
  // 这条替代计划书里的 `JSON.stringify(T1) === JSON.stringify(T1)`(自己等于自己,恒真,
  // 实现改成 `tree.sort(...)` 也照样绿)。现在比的是调用前后的真实快照。
  ok(snapshot() === beforeTop, 'topFiles 不改动入参(前后快照比对)', snapshot())
  ok(snapshot() === T1_BEFORE, 'treeUtils 全程不改动入参树', snapshot())
  ok(T.relSet(T1).has('project.godot') === true && T.relSet(T1).size === T1.length, 'relSet 建得出查表集')
  ok(T.fmtBytes(0) === '0 B' && T.fmtBytes(1024) === '1.0 KB' && T.fmtBytes(1500000) === '1.4 MB',
    'fmtBytes 可读', [T.fmtBytes(0), T.fmtBytes(1024), T.fmtBytes(1500000)].join(' / '))
  ok(T.fmtBytes(-5) === '0 B' && T.fmtBytes(NaN) === '0 B', 'fmtBytes 对负数/NaN 不崩')
  // 审查 F-3(旧代码实测全中):① 0<n<1 时 log 层数为负、Math.min 只钳上界 → u[-1]
  // 出 "409.6 undefined";② .toFixed(1) 会把 1023.9xx 进位显示成 1024.0,层级却不进。
  ok(!String(T.fmtBytes(0.4)).includes('undefined') && !String(T.fmtBytes(0.5)).includes('undefined'),
    'fmtBytes 小数输入不出 undefined', [T.fmtBytes(0.4), T.fmtBytes(0.5)].join(' / '))
  ok(T.fmtBytes(0.5) === '1 B', 'fmtBytes(0.5) 落在 B 层四舍五入', T.fmtBytes(0.5))
  ok(T.fmtBytes(1048575) === '1.0 MB' && T.fmtBytes(1073741823) === '1.0 GB' && T.fmtBytes(2 ** 40 - 1) === '1.0 TB',
    'fmtBytes 显示值进位到 1024.0 时升一级(旧实测 1024.0 KB/MB/GB)',
    [T.fmtBytes(1048575), T.fmtBytes(1073741823), T.fmtBytes(2 ** 40 - 1)].join(' / '))
  ok(T.fmtBytes(1023.5) === '1.0 KB', 'fmtBytes B 层同理:1023.5 不再显示 "1024 B"', T.fmtBytes(1023.5))
  // TB 是最高档,无级可升 —— 钉住这个饱和行为是刻意的,不是漏网(见 treeUtils 注释)。
  ok(T.fmtBytes(2 ** 50 - 1) === '1024.0 TB', 'fmtBytes 顶档饱和为 1024.0 TB(上面没有 PB)',
    T.fmtBytes(2 ** 50 - 1))
  ok(T.fmtMs(900) === '900 ms' && T.fmtMs(2500) === '2.5 s', 'fmtMs 可读')
  ok(T.dirOf('a/b/c.txt') === 'a/b/' && T.dirOf('c.txt') === '', 'dirOf 含尾斜杠、根目录返回空串')

  // ---------- 2. sceneRefs 解析器 ----------
  // 为什么存在:断链检查(唯一 P0 错误级结论)全靠这三个函数。解析器多吐一条引用就是
  // 误报「缺文件」,少吐一条就是漏报;resToRel 归一不稳会让断链判据整体失真。
  section('2. sceneRefs')
  const SCENE = `gd_scene load_steps=4 format=3 uid="uid://abc"

[ext_resource type="Script" path="res://player.gd" id="1_x"]
[ext_resource type="Texture2D" uid="uid://tex1" path="res://assets/bg.png" id="2_y"]
[ext_resource type="PackedScene" path="res://sub/missing.tscn" id="3_z"]
[ext_resource type="AudioStream" path="user://cfg/sample.ogg" id="4_w"]
[ext_resource type="Shader" path="C:\\\\abs\\\\bad.shader" id="5_v"]

[sub_resource type="RectangleShape2D" id="1_a"]
[node name="Root" type="Node2D"]
`
  const refs = T.parseExtResources(SCENE)
  ok(refs.length === 5, '解析出 5 条 ext_resource', refs.length)
  ok(refs[0].path === 'res://player.gd' && refs[0].id === '1_x', '取到 path 与 id')
  ok(refs[1].uid === 'uid://tex1' && refs[1].type === 'Texture2D', '取到 uid 与 type')
  ok(refs.every((r) => !String(r.path).includes('\n')), 'path 不吞行')
  ok(T.parseExtResources('[ext_resource type="Script"]').length === 1, '只有 type 也出一条(path 空)')
  ok(T.parseExtResources('').length === 0, '空文本零引用')
  ok(T.parseExtResources('[node name="x" ]').length === 0, 'node 段不算引用')
  ok(T.parseExtResources('[gd_scene load_steps=2]').length === 0, '文件头不算引用')
  ok(T.parseExtResources('[ext_resource type="Texture2D" path="res://a.png" id="1_a"] tail').length === 1, '行尾有杂字也能取')
  // 缺字段一律给空串而不是 undefined:断链检查会对 uid 直接 startsWith, undefined 会抛。
  ok(refs[0].uid === '' && refs[2].uid === '' && refs[4].id === '5_v', '缺字段出空串(字段恒为字符串)')
  // Godot 的文本格式允许 value 里出现 `]`(罕见):按 key 抓值才不会把 path 截断。
  const bracket = T.parseExtResources('[ext_resource type="Texture2D" path="res://a]b.png" id="1_a"]')
  ok(bracket.length === 1 && bracket[0].path === 'res://a]b.png', 'path 里含 ] 也不被截', JSON.stringify(bracket))
  // CRLF 的 .tscn(被别的编辑器改写过)不能留下尾随 \r —— 否则 rel 永远查不到,断链误报。
  const crlf = T.parseExtResources('[ext_resource type="Script" path="res://a.gd" id="1_a"]\r\n[ext_resource type="Script" path="res://b.gd" id="2_b"]\r\n')
  ok(crlf.length === 2 && crlf.every((r) => !r.path.includes('\r')), 'CRLF 行不留尾随 \\r', JSON.stringify(crlf.map((r) => r.path)))

  ok(T.resToRel('res://a/b.png') === 'a/b.png', 'res:// → rel')
  ok(T.resToRel('res://x') === 'x', '根下文件也认')
  // 反斜杠归一成正斜杠:tree 的 rel 只会是正斜杠,不归一就永远对不上。
  ok(T.resToRel('res://dir\\sub\\f.png') === 'dir/sub/f.png', 'Windows 反斜杠归一', T.resToRel('res://dir\\sub\\f.png'))
  ok(T.resToRel('res://') === null, '裸 res:// 无意义')
  ok(T.resToRel('user://x') === null, 'user:// 不解析')
  ok(T.resToRel('C:\\a') === null, '绝对路径不解析')
  ok(T.resToRel('') === null && T.resToRel(null) === null, '空串/null 不解析')
  // 审查 F-5 附带:旧实现不归一,`res://./a` 出 './a'、`res://a//b` 出 'a//b' —— 这类
  // rel 在 scan 归一过的树里永远查不到,断链检查会误报。归一必须与 resolveRel
  // (inspectfs.js:37-50)同规则:吃掉 './'、折叠重复斜杠、越界 '..' 判 null。
  ok(T.resToRel('res://./a') === 'a', '开头的 ./ 被吃掉(与 resolveRel 同归一)', JSON.stringify(T.resToRel('res://./a')))
  ok(T.resToRel('res://a//b') === 'a/b', '重复斜杠折叠', JSON.stringify(T.resToRel('res://a//b')))
  ok(T.resToRel('res://sub/../a') === null, '越出项目的 .. 判 null(与 resolveRel 一致)', JSON.stringify(T.resToRel('res://sub/../a')))

  const steps = T.countSteps(SCENE)
  ok(steps.declared === 4, 'load_steps 读得到', steps.declared)
  ok(steps.actual === 6, '实际 = 5 ext + 1 sub', steps.actual)
  // 引擎不变式:load_steps = ext + sub + 1(+1 是资源文件自身)。可比值是 expected,
  // 不是 actual —— 旧代码拿 actual 当可比值,对每个引擎写出的场景都差 1(审查 F-1)。
  ok(steps.expected === 7, '可比值 expected = actual + 1', steps.expected)
  ok(T.countSteps('format=3').declared === 0, '缺 load_steps 记 0(不臆造)')
  ok(T.countSteps('format=3').actual === 0 && T.countSteps('format=3').expected === 1,
    '缺属性时 expected 照常给(调用方须先看 declared 是否缺)', JSON.stringify(T.countSteps('format=3')))
  ok(T.countSteps('').declared === 0 && T.countSteps('').actual === 0, '空文本 0/0')
  ok(T.countSteps('[node name="A" parent="."]').actual === 0, 'node 段不计入 actual')
  // 规范最小场景:一个 ext_resource 的 .tscn 头部就是 gd_scene load_steps=2。
  // 这条是旧发布代码永远过不了的断言(actual 恒比 declared 少 1)。
  const CANON = `gd_scene load_steps=2 format=3 uid="uid://c1"

[ext_resource type="Script" path="res://a.gd" id="1_a"]

[node name="Root" type="Node2D"]
`
  const canon = T.countSteps(CANON)
  ok(canon.actual === 1 && canon.expected === 2 && canon.declared === canon.expected,
    '规范最小场景 declared === expected(load_steps=2 = 1 ext + 0 sub + 1)', JSON.stringify(canon))

  // ---------- 3. size 检查器 ----------
  // 为什么存在:这是用户在工具页上看到的第一批数字。「源文件体积」必须**不含** .godot,
  // 否则缓存一膨胀,界面就说你的项目变大了;大文件条目只该在 20MB 以上出现(噪声控制)。
  section('3. size:项目体积与大文件')
  const S1 = await T.runSize(makeCtx([
    ['project.godot', 100],
    ['scene/main.tscn', 500],
    ['.godot/imported/a.stex', 9 * 1024 * 1024],
    ['assets/bg.png', 6 * 1024 * 1024],
    ['assets/hero.png', 50 * 1024 * 1024],
    ['addons/one/plugin.cfg', 20]
  ]))
  ok(S1.length >= 2, '至少给出总体积 + 缓存两条', S1.length)
  const total = S1.find((f) => f.id === 'size:total')
  ok(!!total && total.severity === 'info', '总体积是 info', JSON.stringify(total))
  ok(/MB|KB/.test(total.title), '总体积用可读单位', total.title)
  ok(total.detail.includes('png') && total.detail.includes('assets'), 'detail 带类型与目录前 3 名', total.detail)
  // 这条钉住「源文件口径 = noCache」:实现改成 `sumBytes(ctx.tree)` 时这里必须红
  // (缓存 9MB 混进源体积 → 数字与条数同时虚高,而 /MB|KB/ 与 detail 的两条断言照样绿)。
  ok(total.title.includes('56.0 MB') && total.title.includes('5 个'),
    '源文件体积不含 .godot 缓存(56.0 MB · 5 个,含缓存会是 65.0 MB · 6 个)', total.title)
  const cacheLine = S1.find((f) => f.id === 'size:cache')
  ok(!!cacheLine && cacheLine.rel === '.godot', '缓存体积单独一条并指向 .godot')
  const big = S1.filter((f) => String(f.id).startsWith('size:big:'))
  ok(big.length === 1 && big[0].rel === 'assets/hero.png', '只对 >=20MB 的单文件出条目', JSON.stringify(big.map((f) => f.rel)))
  ok(big[0].title.includes('50.0 MB'), '大文件条目带体积', big[0].title)
  ok(!S1.some((f) => f.id === 'size:bigTail'), '一个没漏列时不出「未列出」条', JSON.stringify(S1.map((f) => f.id)))
  // 审查 F-5:实现是 `topFiles(src, 20).filter(f => f.size >= BIG_FILE)` —— 先砍到前 20 名
  // 再筛阈值。21 个超标文件时只列得下 20 个,而 size:total 说「21 个」,界面上完全看不出
  // 少了谁。20 行上限本身是对的(刷屏控制),要补的是**从未过滤的 src 算出差额并报出去**。
  const MANY = Array.from({ length: 21 }, (_, i) => [`big/f${String(i + 1).padStart(2, '0')}.png`, (21 + i) * 1024 * 1024])
  const S2 = await T.runSize(makeCtx(MANY))
  const listed = S2.filter((f) => String(f.id).startsWith('size:big:'))
  ok(listed.length === 20, '21 个超标文件仍只列 20 行(上限是刻意的)', listed.length)
  ok(!listed.some((f) => f.rel === 'big/f01.png'), '排在第 21 名的文件没被列出', listed.length)
  const tail = S2.find((f) => f.id === 'size:bigTail')
  ok(!!tail && tail.severity === 'info' && tail.title.includes('另有 1 个'),
    '未列出的差额单独成条(info)', JSON.stringify(tail && tail.title))
  ok(!!tail && tail.title.includes('20MB'), '「未列出」条点名 20MB 阈值', tail && tail.title)
  ok(S2.find((f) => f.id === 'size:total').title.includes('21 个'),
    '源文件条数按全量算(21 个,不是砍完前 20 名再数)', S2.find((f) => f.id === 'size:total').title)
  const t = await T.runSize(makeCtx([['a.png', 10]], { trunc: true }))
  ok(t.some((f) => f.severity === 'warn' && f.title.includes('部分')), '截断时先报「只基于部分文件」', JSON.stringify(t.map((f) => f.title)))
  // 审查 F-6:全套断言此前没有一条把 `truncated` 当 **id** 查 —— truncatedFinding 里把
  // toolId 传错、或干脆写死成一个共享 id,都能一路绿。而 id 是渲染层折叠与将来
  // 「忽略这条」记忆的 key,三个检查器共用一个 key 就会互相顶掉(裁决 1 的测试缺口)。
  ok(t.some((f) => f.id === 'size:truncated'), 'size 的截断条目 id 是自己的 size:truncated', JSON.stringify(t.map((f) => f.id)))
  // 审查 F-4:截断文案不许建议「用 skipDirs / exts 缩小范围后重跑」。过滤出来的清单同样
  // 不完整,可原语只在 maxEntries 上限处才标 truncated —— 照着这条建议做,下一轮
  // brokenRefs 就会把用户其实有的文件报成「不存在」(假 error 全量复活,还是 error 级)。
  // 只准给安全动作:提高 maxEntries / 完整重扫。
  const sizeTrunc = t.find((f) => f.id === 'size:truncated')
  ok(!!sizeTrunc && !/skipDirs|exts/.test(String(sizeTrunc.detail)),
    'size 截断文案不给 skipDirs/exts 建议', sizeTrunc && sizeTrunc.detail)
  ok(!!sizeTrunc && /maxEntries|完整重扫/.test(String(sizeTrunc.detail)),
    'size 截断文案给的是安全动作(提高 maxEntries / 完整重扫)', sizeTrunc && sizeTrunc.detail)
  const e = await T.runSize(makeCtx([]))
  ok(e.every((f) => f.severity === 'info'), '空树不报 error/warn(没什么可查)', JSON.stringify(e.map((f) => f.severity)))
  ok(!e.some((f) => f.id === 'size:cache'), '无缓存时不出缓存条目')

  // ---------- 4. cache 检查器 ----------
  // 为什么存在:.godot 陈旧是「编辑器里改了但插件看到的还是旧的」的根因之一。
  // 无缓存**不是**错误(新克隆项目就是没有),异常膨胀才是 warn。
  section('4. cache:.godot 缓存体检')
  // 新鲜:缓存最新(off=5)晚于源(off=1)
  // ⚠ 夹具体积从 brief 原文的 9000 改为 900:源 600 B + 缓存 9000 B = 15 倍,
  // 必然同时踩中 CACHE_OVER_SRC=10 的 bloat 分支(实测 ["cache:size/info","cache:bloat/warn"]),
  // 于是「缓存比源新 → 只有 info」这条用例其实在考「不报膨胀」——而阈值 10 是 brief 钉死的。
  // 用例的意图是 mtime 陈旧判定,所以改夹具而不是改断言/阈值(900/600 = 1.5 倍,阈值下界)。
  const fresh = await T.runCache(makeCtx([
    ['project.godot', 100, 1], ['scene/main.tscn', 500, 1], ['.godot/imported/a.stex', 900, 5]
  ]))
  ok(fresh.every((f) => f.severity === 'info'), '缓存比源新 → 只有 info', JSON.stringify(fresh.map((f) => f.severity)))
  ok(fresh[0].id === 'cache:size', '第一条是体积')
  ok(fresh[0].title.includes('.godot'), '标题点明 .godot', fresh[0].title)
  // 阈值下界:1.5 倍不许报膨胀。CACHE_OVER_SRC 被改成 1 时这条必须红(上面 every 也会红)。
  ok(!fresh.some((f) => f.id === 'cache:bloat'), '未超源 10 倍(实测 1.5 倍)不报膨胀', JSON.stringify(fresh.map((f) => f.id)))

  const stale = await T.runCache(makeCtx([
    ['project.godot', 100, 9], ['scene/main.tscn', 500, 9], ['.godot/imported/a.stex', 900, 2]
  ]))
  const st = stale.find((f) => f.severity === 'warn')
  ok(!!st, '源文件更新 → 报「缓存可能已过期」', JSON.stringify(stale.map((f) => f.severity)))
  // Task 16 修复:下面两条改为**先判 st 存在**。旧写法是裸 `st.detail.includes(...)` ——
  // 回归时 stale.find 回 undefined,这里抛 TypeError 直接把整个测试脚本打断,
  // 屏幕上只剩上面那条 PASS 加一坨堆栈,拿不到「哪一条错」也拿不到 FAIL 汇总。
  ok(!!st && String(st.detail).includes('scene/main.tscn'), 'detail 点出具体源文件', st && st.detail)
  ok(String(st && st.id).startsWith('cache:stale:'), 'stale 条目 id 稳定可折叠', st && st.id)

  // 审查 F-3:mtimeMs === 0 是宿主「取不到 metadata」的哨兵(src-tauri/src/inspectfs.rs:90-95
  // `md.modified().ok()...unwrap_or(0)`,JS 端 pre-1970 也折成 0),不是「1970-01-01 修改过」。
  // 旧实现把它当真实时间 → cacheMax=0 → 每个源文件都「比缓存新」→ 再新鲜的缓存也永远
  // 报「缓存可能已过期」。夹具:与 fresh 同形,只把 .godot 条目的 mtime 覆成 0。
  const unknownCtx = makeCtx([
    ['project.godot', 100, 1], ['scene/main.tscn', 500, 1], ['.godot/imported/a.stex', 900, 5]
  ])
  unknownCtx.tree.forEach((f) => { if (T.isCache(f.rel)) f.mtimeMs = 0 })
  const unknownMtime = await T.runCache(unknownCtx)
  ok(unknownMtime.every((f) => f.severity === 'info'), '缓存 mtime 全为 0(未知) → 不报过期',
    JSON.stringify(unknownMtime.map((f) => `${f.id}/${f.severity}`)))
  ok(!unknownMtime.some((f) => String(f.id).startsWith('cache:stale:')),
    '缓存侧没有有效 mtime → 整个陈旧判定跳过', JSON.stringify(unknownMtime.map((f) => f.id)))

  const none = await T.runCache(makeCtx([['project.godot', 100, 1]]))
  // 审查 F-2:「清单里没有」是对这份列表的观察,「这个项目还没有 .godot 缓存」是对磁盘事实的
  // 断言 —— 清单里没有证明不了磁盘上没有(宿主没带 .godot、用了 exts 过滤,都会长空)。
  ok(none.some((f) => f.severity === 'info' && f.title.includes('清单里没有')),
    '无缓存条目 → info,措辞只讲清单不讲项目', JSON.stringify(none.map((f) => f.title)))
  ok(none.length === 1 && none[0].id === 'cache:none', '无缓存时只有一条,不再叠加体积/陈旧', JSON.stringify(none.map((f) => f.id)))
  ok(!none.some((f) => f.id === 'cache:bloat' || String(f.id).startsWith('cache:stale:')),
    '无缓存条目时不出膨胀/陈旧', JSON.stringify(none.map((f) => f.id)))

  const huge = await T.runCache(makeCtx([
    ['project.godot', 100, 1], ['.godot/imported/big.bin', 400 * 1024 * 1024, 5]
  ]))
  ok(huge.some((f) => f.severity === 'warn' && f.id === 'cache:bloat'), '缓存体积超源 10 倍 → warn', JSON.stringify(huge.map((f) => f.id)))
  // 审查 F-2:截断时**只出截断这一条**,别的结论一律不下(旧实现在 warn 之后继续算体积/膨胀/
  // 陈旧,同一次体检既说「以下结论只基于部分文件」又说「这个项目还没有 .godot 缓存」,自相矛盾)。
  const truncEmpty = await T.runCache(makeCtx([['project.godot', 100, 1]], { trunc: true }))
  ok(truncEmpty.length === 1 && truncEmpty[0].id === 'cache:truncated',
    '截断时只有一条:cache:truncated(不再断言「没有缓存」)', JSON.stringify(truncEmpty.map((f) => f.id)))
  // Task 16 修复:cache 的截断**标题**此前没有任何文案断言 —— 上面那条把旧的关键字判换成了
  // 「条数 + id」,而 F-4 那两条只查 detail,标题写成「缓存体积异常」也能全绿。
  // cache 走的是 truncatedFinding 的 title 覆盖(默认标题讲「以下结论只基于部分文件」,
  // 而 cache 截断时一个结论都不下),所以这里钉它自己那句里的「截断」。
  // 修复轮 1(F-4.1):[0] 先判存在再取字段 —— 回归返回 [] 时旧写法抛 TypeError 打断整个 harness,
  // 拿不到 FAIL 汇总(与同轮 !!st && 的修法一致;上一条「条数 + id」断言会同时红,不缺线索)。
  ok(!!truncEmpty[0] && String(truncEmpty[0].title).includes('截断'),
    'cache 截断那条的标题点明「截断」', truncEmpty[0] && truncEmpty[0].title)
  // 第二个复现:3 KB 缓存 ÷ 100 B 可见源 = 30 倍 → 旧实现照样报 cache:bloat/warn,
  // 而分母只是被截断后剩下的一小块源;cacheMax 同样只是子集里的最大值。
  const truncCache = await T.runCache(makeCtx(
    [['project.godot', 100, 1], ['.godot/imported/a.stex', 3072, 5]], { trunc: true }))
  ok(truncCache.length === 1 && truncCache[0].id === 'cache:truncated',
    '截断时不报体积/膨胀/陈旧(倍数与最新时间都算自部分清单)', JSON.stringify(truncCache.map((f) => `${f.id}/${f.severity}`)))
  // 审查 F-4:截断文案不许建议「用 skipDirs / exts 缩小范围」—— 过滤出来的清单同样不完整,
  // 却不会被标记 truncated,下一轮就会把用户其实有的文件报成丢失。
  // 修复轮 1(F-4.1):同样先判 [0] 存在,回归时 FAIL 而不是把 harness 打断。
  ok(!!truncCache[0] && !/skipDirs|exts/.test(String(truncCache[0].detail)),
    'cache 截断文案不给过滤建议', truncCache[0] && truncCache[0].detail)

  // ---------- 5. brokenRefs 检查器 ----------
  // 为什么存在:P0a 唯一的 error 级结论。两种假阳性都比漏报更伤信任 ——
  // ① 清单截断时「没扫到」≠「文件不存在」,必须拒绝判定;② 读不到文本
  // (二进制/超 maxBytes/缺文件)必须静默跳过,不能当成断链。
  section('5. brokenRefs:资源引用完整性')
  const SCENE_A = '[ext_resource type="Script" path="res://player.gd" id="1_a"]\n[node name="R"]\n'
  const SCENE_B = '[ext_resource type="Texture2D" path="res://assets/gone.png" id="2_b"]\n'
  const base = [['player.gd', 10], ['assets/bg.png', 10], ['scene/a.tscn', 10], ['sub/b.tres', 10]]
  const cleanCtx = makeCtx(base, { texts: { 'scene/a.tscn': SCENE_A, 'sub/b.tres': '' } })
  ok((await T.runBrokenRefs(cleanCtx)).length === 0, '引用都存在 → 零结论')

  const broken = await T.runBrokenRefs(makeCtx(base, { texts: { 'scene/a.tscn': SCENE_B } }))
  ok(broken.length === 1, '一条断链', JSON.stringify(broken))
  ok(broken[0].severity === 'error', '断链是 error')
  ok(broken[0].rel === 'scene/a.tscn', '主证据是含断链的场景文件', broken[0].rel)
  ok(broken[0].title.includes('res://assets/gone.png'), '标题带原始引用路径', broken[0].title)
  ok(broken[0].detail.includes('Texture2D'), 'detail 带资源类型', broken[0].detail)
  // id 只由证据(场景 rel + ext_resource id + 引用 path)推导:渲染层的折叠状态与将来的
  // 「忽略这条」记忆都按它记账,换成含时间戳或数组下标的形态就会每次扫描都漂移。
  ok(broken[0].id === 'brokenRefs:scene/a.tscn:2_b:res://assets/gone.png',
    '断链 id 稳定(证据推导,场景 rel + 引用 id + 引用 path)', broken[0].id)
  // 审查 F-1:Godot 允许(编辑器也会写出)同一个场景里两条 ext_resource 复用同一个 id 段,
  // 指向两个不同的丢失文件。旧 id 只到 id 为止 → 两条结论撞出同一个 key,忽略/折叠一条
  // 就静默吞掉另一条(实测 ["brokenRefs:scene/a.tscn:2_b","brokenRefs:scene/a.tscn:2_b"])。
  const dupId = await T.runBrokenRefs(makeCtx(base, {
    texts: { 'scene/a.tscn':
      '[ext_resource type="Texture2D" path="res://assets/gone.png" id="2_b"]\n' +
      '[ext_resource type="Script" path="res://assets/gone2.png" id="2_b"]\n' }
  }))
  ok(dupId.length === 2, '同 id 的两条断链都出条目', JSON.stringify(dupId.map((f) => f.id)))
  ok(new Set(dupId.map((f) => f.id)).size === 2, '同 id 不同 path → 两个不同 id(不撞车)',
    JSON.stringify(dupId.map((f) => f.id)))

  const notScanned = await T.runBrokenRefs(makeCtx([['scene/a.tscn', 10]], { texts: { 'scene/a.tscn': SCENE_B }, trunc: true }))
  ok(notScanned.every((f) => f.severity !== 'error'), '清单被截断时不把「没扫到」当成断链', JSON.stringify(notScanned.map((f) => f.severity)))
  ok(notScanned.some((f) => f.severity === 'warn'), '截断本身要报一条 warn')
  ok(notScanned.some((f) => f.id === 'brokenRefs:truncated'),
    'brokenRefs 的截断条目 id 是自己的 brokenRefs:truncated', JSON.stringify(notScanned.map((f) => f.id)))
  // 审查 F-4(同 size):断链判定最怕的就是「用过滤缩小范围」这个建议 —— 它会让下一轮的
  // 清单既不完整、又不带 truncated 标记,这条保守规则直接被绕过。
  ok(!/skipDirs|exts/.test(String(notScanned[0].detail)),
    'brokenRefs 截断文案不给 skipDirs/exts 建议', notScanned[0].detail)
  ok(/maxEntries|完整重扫/.test(String(notScanned[0].detail)),
    'brokenRefs 截断文案给的是安全动作', notScanned[0].detail)
  // 审查 F-6:三个检查器的截断条目必须各带自己的前缀。传错 toolId 或写死成一个共享 id
  // 都会让这里红(单条断言只考一个检查器,这一条考的是「三者互不相同」)。
  const truncIds = [t, truncEmpty, notScanned].map((list) => {
    const f = list.find((x) => String(x.id).endsWith(':truncated'))
    return f ? f.id : '(none)'
  })
  ok(truncIds.join('|') === 'size:truncated|cache:truncated|brokenRefs:truncated',
    '三条截断条目各自独立(不共用一个 id)', JSON.stringify(truncIds))

  const multi = await T.runBrokenRefs(makeCtx([['player.gd', 10]], {
    texts: { 'scene/a.tscn': SCENE_B, 'sub/b.tres': SCENE_B }
  }))
  ok(multi.length === 0, '未在清单里的文件不去读(不会凭空断链)', JSON.stringify(multi))

  const skipUser = await T.runBrokenRefs(makeCtx(base, {
    texts: { 'scene/a.tscn': '[ext_resource type="AudioStream" path="user://x.ogg" id="1_a"]\n' }
  }))
  ok(skipUser.length === 0, 'user:// 与绝对路径不参与判定')
  const unreadable = await T.runBrokenRefs(makeCtx(base, { texts: {} }))
  ok(unreadable.length === 0, '读不到文本(二进制/超限)的场景文件跳过,不报假断链')

  // ---------- 6. outcomeOf:体检结论判定(修复轮 1,审查 F-1) ----------
  // 为什么存在:「体检完成 · 未发现问题」曾直接在 ToolsView.vue 的 computed 里判,而扫描失败
  // **不会**清空 results —— useTools.ts:146-153 置 error、清 tree、复位 truncated 后返回,
  // runAll 拿到 false 直接早退,results 原样留着。可达序列:全量跑一轮全绿 → 项目目录被移走/改名
  // → 再跑一轮 → 红色「项目目录无法读取」旁边并排打出「体检完成 · 未发现问题 · 3 项已检查 · 0 文件」。
  // 判据抽成 outcomeOf(src/tools/outcome.ts)后,这四路迁移第一次被 harness 钉住;(d) 就是那条矛盾。
  section('6. outcomeOf:体检结论判定')
  const mkResult = (id, toolOk = true, findings = []) => ({
    toolId: id, ok: toolOk, findings, scannedFiles: 10, ms: 1, ...(toolOk ? {} : { error: '检查失败' })
  })
  const ZERO = { error: 0, warn: 0, info: 0 }
  const ALL3 = { size: mkResult('size'), cache: mkResult('cache'), brokenRefs: mkResult('brokenRefs') }
  // (a) 每个注册工具都有 ok:true 结论、零发现、无 error → all-clean
  const oA = T.outcomeOf(ALL3, 3, ZERO, '')
  ok(oA.kind === 'allClean' && oA.showAllClean === true && oA.error === '',
    'outcomeOf(a):全部跑成且零结论 → 「体检完成 · 未发现问题」', JSON.stringify(oA))
  // (b) 还有一个工具没跑过 → 不算 all-clean(「完成」不许在没完成时说)
  const oB = T.outcomeOf({ size: mkResult('size'), cache: mkResult('cache') }, 3, ZERO, '')
  ok(oB.kind !== 'allClean' && oB.showAllClean === false,
    'outcomeOf(b):一个工具还没跑 → 不宣布体检完成', JSON.stringify(oB))
  // (c) 一个工具 ok:false → 不算 all-clean,且失败被点名(failedToolIds 就是那排红卡片的账)
  const oC = T.outcomeOf({ ...ALL3, cache: mkResult('cache', false) }, 3, ZERO, '')
  ok(oC.showAllClean === false && oC.kind === 'partial' && oC.failedToolIds.join(',') === 'cache',
    'outcomeOf(c):单工具失败 → 不干净并点名失败工具', JSON.stringify(oC))
  // (d) F-1 本体:结论明明全绿,但 error 非空(目录移走后的失败扫描,results 是上一轮陈迹)
  //     → 必须**不是** all-clean,失败横幅是唯一出口。修复前(naive:判据不看 error)这条 RED。
  const oD = T.outcomeOf(ALL3, 3, ZERO, '项目目录无法读取')
  ok(oD.showAllClean === false && oD.kind === 'failed' && oD.error === '项目目录无法读取',
    'outcomeOf(d):扫描失败 + 陈旧全绿结论 → 不宣布体检完成,失败原样上浮', JSON.stringify(oD))
  // 既有行为一并钉住(从视图 computed 原样搬来,防抽取时弄丢):
  // (e) 有扫描/检查在途 → 不宣布完成(那是上一轮的状态,这一轮还没跑完)
  const oE = T.outcomeOf(ALL3, 3, ZERO, '', true)
  ok(oE.kind === 'running' && oE.showAllClean === false,
    'outcomeOf(e):在跑的一轮期间不宣布「体检完成」', JSON.stringify(oE))
  // (f) 一份结论都没有(刚切项目/没选项目)→ idle,与 (a) 的「跑完且没问题」区分开
  const oF = T.outcomeOf({}, 3, ZERO, '')
  ok(oF.kind === 'idle' && oF.showAllClean === false,
    'outcomeOf(f):什么都没跑 → idle 而不是「未发现问题」', JSON.stringify(oF))
}
main().catch((e) => {
  // 断言里不该抛错;真抛了(比如实现返回了 undefined)也要以退出码 1 收口,不能让 CI 看到绿。
  console.error(`\n测试脚本抛错: ${e && e.stack ? e.stack : e}`)
  process.exit(1)
}).then(() => {
  console.log(`\n${'='.repeat(56)}\nPASS ${pass}  FAIL ${failures.length}`)
  if (failures.length) { console.log('失败项:'); for (const f of failures) console.log('  - ' + f); process.exit(1) }
  console.log('全部通过')
})
