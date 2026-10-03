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

/** 造文件清单:[ [rel, size, mtimeOffsetDays?] ] */
function tree(specs) {
  const base = Date.UTC(2026, 0, 1)
  return specs.map(([rel, size, off = 0]) => ({
    rel,
    size,
    mtimeMs: base + off * 86400000,
    ext: (rel.includes('.') ? rel.split('.').pop() : '').toLowerCase()
  }))
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
  // 入参快照:rel + size 一起比,既抓「原地 sort 改了顺序」也抓「改写了元素」
  const snapshot = () => T1.map((f) => `${f.rel}:${f.size}`).join('|')
  const T1_BEFORE = snapshot()

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
  ok(T.groupByExt([tree([['LICENSE', 5]])[0]]).find((g) => g.ext === '(无扩展名)')?.count === 1,
    'ext 空串归入 (无扩展名)')

  const byDir = T.groupByTopDir(T.noCache(T1))
  ok(byDir.find((d) => d.dir === 'scene')?.bytes === 540, '嵌套文件并进顶层目录', JSON.stringify(byDir))
  ok(byDir.find((d) => d.dir === 'scene')?.count === 2, '顶层目录组同时给出条数')
  ok(byDir.find((d) => d.dir === '(根目录)')?.bytes === 100, '根目录文件归进 (根目录)', JSON.stringify(byDir))
  ok(byDir.every((g, i) => i === 0 || byDir[i - 1].bytes >= g.bytes), 'groupByTopDir 按体积降序')

  const beforeTop = snapshot()
  const top = T.topFiles(T1, 3)
  // 计划书此处期望 ['.godot/imported/a.stex', ...] —— 但 bg.png 5000 > a.stex 900,
  // 降序取前 3 的第一名就是 assets/bg.png。以实现真实输出为准。
  ok(top.map((f) => f.rel).join('|') === 'assets/bg.png|.godot/imported/a.stex|scene/main.tscn',
    'topFiles 取前 n 且降序', JSON.stringify(top.map((f) => f.rel)))
  ok(T.topFiles(T1, 0).length === 0, 'n=0 返回空数组')
  ok(T.topFiles(T1, 99).length === T1.length, 'n 超过长度时返回全部,不报错')
  // 这条替代计划书里的 `JSON.stringify(T1) === JSON.stringify(T1)`(自己等于自己,恒真,
  // 实现改成 `tree.sort(...)` 也照样绿)。现在比的是调用前后的真实快照。
  ok(snapshot() === beforeTop, 'topFiles 不改动入参(前后快照比对)', snapshot())
  ok(snapshot() === T1_BEFORE, 'treeUtils 全程不改动入参树', snapshot())
  ok(T.relSet(T1).has('project.godot') === true && T.relSet(T1).size === T1.length, 'relSet 建得出查表集')
  ok(T.fmtBytes(0) === '0 B' && T.fmtBytes(1024) === '1.0 KB' && T.fmtBytes(1500000) === '1.4 MB',
    'fmtBytes 可读', [T.fmtBytes(0), T.fmtBytes(1024), T.fmtBytes(1500000)].join(' / '))
  ok(T.fmtBytes(-5) === '0 B' && T.fmtBytes(NaN) === '0 B', 'fmtBytes 对负数/NaN 不崩')
  ok(T.fmtMs(900) === '900 ms' && T.fmtMs(2500) === '2.5 s', 'fmtMs 可读')
  ok(T.dirOf('a/b/c.txt') === 'a/b/' && T.dirOf('c.txt') === '', 'dirOf 含尾斜杠、根目录返回空串')
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
