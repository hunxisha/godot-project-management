// 继承树扁平行构建(src/utils/docTree.ts)的回归测试。
//
// 关键约束:
//   · 完整树语义:节点展开即铺开它的**全部**直接子类,折叠即只剩自身行。
//     不再有「只显示根→当前类路径 + 还有 N 个兄弟」的聚焦模式 —— 继承树搬进左侧
//     常驻导航后那套零消费者,留着只会让下一个改树的人猜哪个是活的;
//   · 孤儿类(父类不在库内)必须算根。否则整支子树在导航里永远不可达 —— 这是
//     老实现按数量截断把当前类切掉那一类 bug 的另一种形态;
//   · 当前类标 isCurrent,其祖先链标 onPath,供高亮与「定位当前类」自动展开;
//   · 全展开时库里每个类**恰好**出现一次:既不截断漏类,也不重复出行 —— 老实现
//     按数量上限截断子节点,把路径上的 RefCounted 切掉导致当前类不可见,就是漏的那一侧。
//
// 用法(npm script 会先跑打包步骤):
//   npm run test:renderer
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.resolve(__dirname, '../../.gpm-test/out')
const BUNDLE = path.join(OUT, 'doctree.mjs')

if (!existsSync(BUNDLE)) {
  console.error(`找不到打包产物: ${BUNDLE}`)
  console.error('请先运行: node src/composables/__tests__/build-bundle.mjs')
  process.exit(2)
}

const { buildFullTreeRows, rootsFrom, childrenMapFrom } = await import(pathToFileURL(BUNDLE).href)

let pass = 0
const failures = []
function ok(cond, label, extra) {
  if (cond) {
    pass++
    console.log(`  PASS  ${label}`)
  } else {
    failures.push(label)
    console.log(`  FAIL  ${label}${extra !== undefined ? '  → ' + extra : ''}`)
  }
}
function section(t) {
  console.log(`\n=== ${t} ===`)
}

/** 造一棵形状接近引擎库的继承关系,含多根、孤儿分支、深层链 */
function makeLib() {
  const parents = new Map()
  parents.set('Object', null)
  parents.set('AServer0', 'Object')
  parents.set('AServer1', 'Object')
  parents.set('AServer2', 'Object')
  parents.set('Node', 'Object')
  parents.set('RefCounted', 'Object')
  parents.set('AStar2D', 'RefCounted')
  parents.set('AStarGrid2D', 'AStar2D')
  parents.set('Resource', 'RefCounted')
  // 父类 NotInLib 不在库内:OrphanKind 只能当根才可达
  parents.set('OrphanKind', 'NotInLib')
  const children = childrenMapFrom(parents)
  return {
    parents,
    parentOf: (n) => parents.get(n) ?? null,
    childrenOf: (n) => children.get(n) ?? []
  }
}

/** 按 input 契约跑一遍,回扁平行 */
function rowsOf(lib, expanded, currentClass) {
  return buildFullTreeRows({
    roots: rootsFrom(lib.parents),
    childrenOf: lib.childrenOf,
    parentOf: lib.parentOf,
    expanded,
    currentClass
  })
}

section('rootsFrom:谁是根')
const lib = makeLib()
const roots = rootsFrom(lib.parents)
ok(roots.join(',') === 'Object,OrphanKind', '父类为 null 或父类不在库内的算根,并按名排序', roots.join(','))
ok(rootsFrom(new Map([['Root', null]])).join(',') === 'Root', '单根库回一个根')
ok(rootsFrom(new Map()).length === 0, '空库回空数组')

section('默认只展开根:铺开第一层,更深层不出现')
const base = rowsOf(lib, new Set(roots), 'AStarGrid2D')
ok(base.map((r) => r.name).join('>') === 'Object>AServer0>AServer1>AServer2>Node>RefCounted>OrphanKind',
  '展开根后列出全部根与它们的直接子类', base.map((r) => r.name).join('>'))
ok(base.every((r) => r.depth === 0 || r.depth === 1), '默认不出现第二层以下的行')
ok(base.find((r) => r.name === 'Object')?.depth === 0 && base.find((r) => r.name === 'Node')?.depth === 1,
  'depth 按层级给出(根 0,直接子类 1)')
ok(base.find((r) => r.name === 'OrphanKind')?.depth === 0, '孤儿类作为根从 depth 0 开始')
ok(base.find((r) => r.name === 'RefCounted')?.childCount === 2, 'childCount 是直接派生数', String(base.find((r) => r.name === 'RefCounted')?.childCount))

section('点开某个节点:它的子类铺在下一层')
const opened = rowsOf(lib, new Set([...roots, 'RefCounted']), 'AStarGrid2D')
const names2 = opened.map((r) => r.name)
ok(names2.includes('AStar2D') && names2.includes('Resource'), '展开 RefCounted 后它的两个子类都出现', names2.join('>'))
ok(opened.find((r) => r.name === 'AStar2D')?.depth === 2, '新铺出的行 depth 为 2')
ok(!names2.includes('AStarGrid2D'), '未展开的 AStar2D 自己的子类不跟着出现')
ok(opened.find((r) => r.name === 'RefCounted')?.expanded === true, '展开节点标 expanded')
ok(opened.find((r) => r.name === 'Node')?.expanded === false, '无子类的 Node 标未展开')

section('折叠:从 expanded 移除后只剩自身行')
const collapsed = rowsOf(lib, new Set(['OrphanKind']), 'AStarGrid2D')
ok(collapsed.find((r) => r.name === 'Object')?.expanded === false, 'Object 折叠时 expanded 为 false')
ok(!collapsed.some((r) => r.name === 'Node'), '折叠的 Object 不再铺出任何子类')
ok(collapsed.map((r) => r.name).join('>') === 'Object>OrphanKind', '只剩两个根自身', collapsed.map((r) => r.name).join('>'))

section('当前类与路径标记')
const marked = base.filter((r) => r.onPath).map((r) => r.name)
ok(marked.join('>') === 'Object>RefCounted', '祖先链标 onPath(不含未展开的深层)', marked.join('>'))
ok(base.find((r) => r.name === 'AStarGrid2D') === undefined, '路径未展开到位时当前类可以不在可见行里')
const deep = rowsOf(lib, new Set([...roots, 'RefCounted', 'AStar2D']), 'AStarGrid2D')
const cur = deep.find((r) => r.name === 'AStarGrid2D')
ok(cur?.isCurrent === true, '当前类标 isCurrent')
ok(deep.filter((r) => r.isCurrent).length === 1, '只有一个当前类')
ok(deep.find((r) => r.name === 'AStar2D')?.onPath === true, '展开到位后父类在 onPath 里')
ok(deep.find((r) => r.name === 'AServer1')?.onPath === false, '无关兄弟不标 onPath')

section('无子类的节点即使在 expanded 里也不标展开')
const leafForced = rowsOf(lib, new Set([...roots, 'Node']), 'Node')
ok(leafForced.find((r) => r.name === 'Node')?.expanded === false, 'Node 无子类,expanded 回 false')
ok(leafForced.find((r) => r.name === 'Node')?.childCount === 0, 'childCount 为 0')

section('边界:空库与库外的当前类')
const empty = buildFullTreeRows({ roots: [], childrenOf: () => [], parentOf: () => null, expanded: new Set(), currentClass: 'X' })
ok(empty.length === 0, '空库回 0 行')
const unknown = rowsOf(lib, new Set(roots), 'NotInLib')
ok(unknown.every((r) => !r.isCurrent), '库外的当前类不产生 isCurrent 行(不崩)')

section('全展开:库里每个类恰好出现一次')
const all = rowsOf(lib, new Set(lib.parents.keys()), 'AStarGrid2D')
const allNames = all.map((r) => r.name)
ok(lib.parents.size === 10, '夹具规模(10 个类)', String(lib.parents.size))
ok(new Set(allNames).size === allNames.length, '无重复行(遍历不会把同一个类铺两遍)', allNames.join('>'))
ok([...lib.parents.keys()].every((k) => allNames.includes(k)), '库里每个类都在树里,含孤儿分支', allNames.join('>'))
ok(allNames.length === lib.parents.size, '行数恰好等于类数 —— 既不截断也不多余', String(allNames.length))

section('childrenMapFrom:按名排序')
const sorted = childrenMapFrom(new Map([['B', 'P'], ['A', 'P'], ['C', 'P']]))
ok((sorted.get('P') || []).join(',') === 'A,B,C', '子类按名排序', JSON.stringify(sorted.get('P')))
ok(childrenMapFrom(new Map([['Root', null]])).size === 0, '根节点不进 children 表')

console.log(`\n${pass} passed, ${failures.length} failed`)
if (failures.length) {
  console.log('FAILURES:')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
