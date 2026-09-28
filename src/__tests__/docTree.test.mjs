// 继承树扁平行构建(src/utils/docTree.ts)的回归测试。
//
// 关键约束(都是实际踩过的坑):
//   · 当前类必须出现在树里 —— 老实现按数量上限截断子节点,Object 有 70 个派生时
//     RefCounted(路径上的关键节点)被切掉,导致树只展开一层、当前类根本不显示;
//   · 路径中间层默认只列路径上的那个子节点,其余兄弟收进 hiddenSiblings(否则 Object
//     的几十个兄弟会立刻淹掉当前类);
//   · 当前类展开时列全部子类(用户要看「谁继承了我」)。
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

const { buildTreeRows, childrenMapFrom } = await import(pathToFileURL(BUNDLE).href)

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

/** 造一棵与引擎库形状相同的继承关系:Object 有 70 个直接派生(含 RefCounted) */
function makeEngineLike() {
  const parents = new Map()
  parents.set('Object', null)
  // 60 个以 A 开头的类(排序后都在 RefCounted 之前,用来复现「截断把路径切掉」)
  for (let i = 0; i < 60; i++) parents.set(`AServer${String(i).padStart(2, '0')}`, 'Object')
  parents.set('RefCounted', 'Object')
  parents.set('Node', 'Object')
  parents.set('AStar2D', 'RefCounted')
  parents.set('AStarGrid2D', 'AStar2D')
  parents.set('AStar3D', 'AStar2D')
  parents.set('Resource', 'RefCounted')
  const children = childrenMapFrom(parents)
  return {
    parentOf: (n) => parents.get(n) ?? null,
    childrenOf: (n) => children.get(n) ?? [],
    total: parents.size
  }
}

section('路径聚焦:当前类必须出现且路径完整')
const t1 = makeEngineLike()
const rows1 = buildTreeRows({
  childrenOf: t1.childrenOf,
  parentOf: t1.parentOf,
  currentClass: 'AStarGrid2D',
  expanded: new Set()
})
const names1 = rows1.map((r) => r.name)
ok(names1.includes('AStarGrid2D'), '当前类在树里(不被数量截断)', names1.join(' > '))
ok(names1.includes('RefCounted') && names1.includes('AStar2D'), '路径中间层都在')
ok(names1[0] === 'Object', '根是 Object')
ok(names1.join('>') === 'Object>RefCounted>AStar2D>AStarGrid2D', '默认只显示路径(兄弟收起)', names1.join('>'))
ok(rows1.find((r) => r.name === 'AStarGrid2D')?.isCurrent === true, '当前类标记 isCurrent')
ok(rows1.filter((r) => r.isCurrent).length === 1, '只有一个当前类')

section('隐藏兄弟以计数暴露,点开才铺开')
const objectRow = rows1.find((r) => r.name === 'Object')
// Object 的 70 个子类里只显示了 RefCounted,其余 69 个计入 hiddenSiblings
ok(objectRow.childCount === 62, 'Object 子类总数被记录(60 个 AServer + RefCounted + Node)', String(objectRow.childCount))
ok(objectRow.hiddenSiblings === 61, '其余兄弟计入隐藏计数(62 个子类只显示路径上的 RefCounted)', String(objectRow.hiddenSiblings))
const astar2dRow = rows1.find((r) => r.name === 'AStar2D')
ok(astar2dRow.childCount === 2 && astar2dRow.hiddenSiblings === 1, 'AStar2D 隐藏了 AStar3D 之外的 1 个', JSON.stringify({ c: astar2dRow.childCount, h: astar2dRow.hiddenSiblings }))

section('当前类展开:列出全部直接派生')
const aStarGrid = rows1.find((r) => r.name === 'AStarGrid2D')
ok(aStarGrid.childCount === 0 && aStarGrid.expanded === false, '无子类的当前类不展开')
const t2 = makeEngineLike()
// 让当前类有多个派生:再挂 3 个到 AStarGrid2D
const parents2 = new Map([['Object', null], ['RefCounted', 'Object'], ['AStar2D', 'RefCounted'], ['AStarGrid2D', 'AStar2D'], ['G1', 'AStarGrid2D'], ['G2', 'AStarGrid2D'], ['G3', 'AStarGrid2D']])
const children2 = childrenMapFrom(parents2)
const rows2 = buildTreeRows({
  childrenOf: (n) => children2.get(n) ?? [],
  parentOf: (n) => parents2.get(n) ?? null,
  currentClass: 'AStarGrid2D',
  expanded: new Set()
})
const names2 = rows2.map((r) => r.name)
ok(names2.filter((n) => ['G1', 'G2', 'G3'].includes(n)).length === 3, '当前类的全部派生都列出(不折叠)', names2.join('>'))
ok(rows2.find((r) => r.name === 'AStarGrid2D')?.hiddenSiblings === 0, '当前类不产生隐藏计数')

section('用户显式展开:铺开全部子节点')
const rows3 = buildTreeRows({
  childrenOf: t1.childrenOf,
  parentOf: t1.parentOf,
  currentClass: 'AStarGrid2D',
  expanded: new Set(['Object'])
})
const objectKids = rows3.filter((r) => r.depth === 1).map((r) => r.name)
ok(objectKids.length === 62, '展开 Object 后列出全部 62 个子类', String(objectKids.length))
ok(objectKids.includes('RefCounted') && objectKids.includes('AServer00'), '子类同时包含路径节点与普通兄弟')
ok(rows3.find((r) => r.name === 'Object').hiddenSiblings === 0, '展开后不再有隐藏计数')

section('边界')
const emptyRows = buildTreeRows({
  childrenOf: () => [],
  parentOf: () => null,
  currentClass: 'Solo',
  expanded: new Set()
})
ok(emptyRows.length === 1 && emptyRows[0].isCurrent, '孤立类(无父无子)只有一行')
const unknownRows = buildTreeRows({
  childrenOf: t1.childrenOf,
  parentOf: t1.parentOf,
  currentClass: 'NotInLib',
  expanded: new Set()
})
ok(unknownRows.length === 1 && unknownRows[0].name === 'NotInLib', '库中没有的类以自身为根')

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
