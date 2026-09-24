// useProjectList 回归测试:项目列表的读取、过滤、排序与行内变更。
//
// 「过滤 + 排序」是纯计算却原本只能靠肉眼在界面上翻 —— 排序规则还是三级的
// (收藏优先 → 最近打开 → 名称),任何一级写错都不容易看出来。这里逐条锁住。
//
// 用法(npm script 会先跑打包步骤):
//   npm run test:renderer
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.resolve(__dirname, '../../../.gpm-test/out')

for (const name of ['useprojectlist', 'vueshim']) {
  if (!existsSync(path.join(OUT, `${name}.mjs`))) {
    console.error(`找不到打包产物: ${path.join(OUT, `${name}.mjs`)}`)
    console.error('请先运行: node src/composables/__tests__/build-bundle.mjs')
    process.exit(2)
  }
}

const { ref } = await import(pathToFileURL(path.join(OUT, 'vueshim.mjs')).href)
const { useProjectList } = await import(pathToFileURL(path.join(OUT, 'useprojectlist.mjs')).href)

// ---------- 桩:window.ztools.db + 渲染层 db 封装 ----------
// useProjectList 直接调 window.ztools.db.allDocs;putDoc 走 services/bridge → 同样落到这个 db。
const store = new Map()
const puts = []

global.window = {
  ztools: {
    db: {
      get: (id) => (store.has(id) ? { ...store.get(id) } : null),
      put: (doc) => { puts.push(doc._id); store.set(doc._id, { ...doc }); return { ok: true, rev: 'r1' } },
      remove: (doc) => { store.delete(doc._id); return { ok: true } },
      allDocs: (prefix) => [...store.values()].filter((d) => d._id.startsWith(prefix)).map((d) => ({ ...d }))
    }
  }
}

let pass = 0
const failures = []
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log(`  PASS  ${label}`) }
  else { failures.push(label); console.log(`  FAIL  ${label}  → ${extra}`) }
}
const section = (t) => console.log(`\n=== ${t} ===`)

const P = (id, name, over = {}) => ({
  _id: `godot/project/${id}`,
  id,
  name,
  path: `E:\\Godot\\${name}`,
  addedAt: 1000,
  favorite: false,
  ...over
})

function seed(projects, versions = []) {
  store.clear()
  puts.length = 0
  for (const p of projects) store.set(p._id, p)
  for (const v of versions) store.set(v._id, v)
}

// ---------- 1. reload ----------
section('1. reload:从本地库读项目与引擎')
{
  seed([P('a', 'Alpha'), P('b', 'Beta')], [{ _id: 'godot/version/4.7-standard-win64', tag: '4.7-stable' }])
  const l = useProjectList()
  ok(l.projects.value.length === 0, '初始为空(需要显式 reload)')
  l.reload()
  ok(l.projects.value.length === 2, 'reload 读到 2 个项目', String(l.projects.value.length))
  ok(l.versions.value.length === 1, 'reload 同时读到引擎列表')
}

// ---------- 2. 关键词过滤 ----------
section('2. 关键词过滤:名称或路径,忽略大小写')
{
  seed([
    P('a', 'Alpha', { path: 'E:\\Godot\\Alpha' }),
    P('b', 'Beta', { path: 'D:\\Projects\\beta-2d' }),
    P('c', 'Gamma', { path: 'E:\\Other\\Gamma' })
  ])
  const l = useProjectList()
  l.reload()
  ok(l.visible.value.length === 3, '无关键词时全部可见')

  l.filter.value = 'alp'
  ok(l.visible.value.length === 1 && l.visible.value[0].name === 'Alpha', '按名称匹配(忽略大小写)', l.visible.value.map((p) => p.name).join(','))

  l.filter.value = 'PROJECTS'
  ok(l.visible.value.length === 1 && l.visible.value[0].name === 'Beta', '按路径匹配(忽略大小写)', l.visible.value.map((p) => p.name).join(','))

  l.filter.value = '  gamma  '
  ok(l.visible.value.length === 1, '首尾空白不影响匹配')

  l.filter.value = 'zzz'
  ok(l.visible.value.length === 0, '无命中时为空')
}

// ---------- 3. 收藏筛选 + favCount ----------
section('3. 收藏筛选')
{
  seed([P('a', 'Alpha', { favorite: true }), P('b', 'Beta'), P('c', 'Gamma', { favorite: true })])
  const l = useProjectList()
  l.reload()
  ok(l.favCount.value === 2, 'favCount 统计收藏数', String(l.favCount.value))
  l.favOnly.value = true
  ok(l.visible.value.length === 2, '只看收藏时过滤掉非收藏', String(l.visible.value.length))
  l.favOnly.value = false
  ok(l.visible.value.length === 3, '关掉后恢复全部')

  // 与关键词叠加
  l.favOnly.value = true
  l.filter.value = 'gamma'
  ok(l.visible.value.length === 1 && l.visible.value[0].name === 'Gamma', '收藏与关键词同时生效')
}

// ---------- 4. 三级排序 ----------
section('4. 排序:收藏优先 → 最近打开 → 名称')
{
  seed([
    P('a', 'Zeta', { lastOpenedAt: 500 }),
    P('b', 'alpha', { lastOpenedAt: 900 }),
    P('c', 'Beta', { favorite: true, lastOpenedAt: 100 }),
    P('d', 'Delta', { favorite: true, lastOpenedAt: 800 })
  ])
  const l = useProjectList()
  l.reload()
  const names = l.visible.value.map((p) => p.name)
  ok(names[0] === 'Delta' && names[1] === 'Beta', '收藏排前,且收藏内部按最近打开', names.join('>'))
  ok(names[2] === 'alpha' && names[3] === 'Zeta', '非收藏内部按最近打开', names.join('>'))

  // 最近打开相同 → 按名称(localeCompare)
  seed([P('a', 'Gamma', { lastOpenedAt: 0 }), P('b', 'Alpha', { lastOpenedAt: 0 }), P('c', 'Beta', { lastOpenedAt: 0 })])
  const l2 = useProjectList()
  l2.reload()
  ok(
    l2.visible.value.map((p) => p.name).join(',') === 'Alpha,Beta,Gamma',
    '打开时间相同则按名称升序',
    l2.visible.value.map((p) => p.name).join(',')
  )

  // 未打开过(lastOpenedAt 缺失)按 0 处理
  seed([P('a', 'Old', { lastOpenedAt: undefined, addedAt: 5000 }), P('b', 'New', { lastOpenedAt: 100 })])
  const l3 = useProjectList()
  l3.reload()
  ok(l3.visible.value[0].name === 'New', '未打开过的排在后面(lastOpenedAt 缺失按 0)', l3.visible.value.map((p) => p.name).join('>'))

  // 排序不应改动原数组
  const before = l.visible.value.map((p) => p.name).join(',')
  l.filter.value = ''
  ok(before === l.visible.value.map((p) => p.name).join(','), '重复读取结果稳定')
}

// ---------- 5. toggleFavorite / bindVersion ----------
section('5. 行内变更:就地改 + 落库')
{
  seed([P('a', 'Alpha', { favorite: false })])
  const l = useProjectList()
  l.reload()
  const p = l.projects.value[0]
  l.toggleFavorite(p)
  ok(p.favorite === true, '就地切换收藏状态')
  ok(puts.length === 1 && puts[0] === 'godot/project/a', '落库到同一条记录', puts.join(','))
  ok(store.get('godot/project/a').favorite === true, '库里的值也变了')
  ok(store.get('godot/project/a')._id === 'godot/project/a', '落库时保留 _id')
  l.toggleFavorite(p)
  ok(p.favorite === false, '可再次切回')

  l.bindVersion(p, 'godot/version/4.7-standard-win64')
  ok(p.versionId === 'godot/version/4.7-standard-win64', '绑定版本写入对象')
  ok(store.get('godot/project/a').versionId === 'godot/version/4.7-standard-win64', '绑定版本落库')
  l.bindVersion(p, '')
  ok(p.versionId === undefined, '传空串表示解绑(置 undefined,不是空串)', String(p.versionId))
}

// ---------- 6. dropLocal ----------
section('6. dropLocal:只影响本地列表')
{
  seed([P('a', 'Alpha'), P('b', 'Beta')])
  const l = useProjectList()
  l.reload()
  l.dropLocal('godot/project/a')
  ok(l.projects.value.length === 1 && l.projects.value[0].name === 'Beta', '从列表摘掉目标项')
  ok(store.has('godot/project/a'), '不动本地库(库清理由 preload 负责)')
  l.dropLocal('不存在')
  ok(l.projects.value.length === 1, '摘除不存在的 id 安全')
}

// ---------- 7. 选中项 ----------
section('7. selected 索引')
{
  seed([P('a', 'Alpha')])
  const l = useProjectList()
  l.reload()
  ok(l.selected.value === -1, '初始无选中(用 -1 而不是 0,避免误打开第一个)')
}

// ---------- 结果 ----------
console.log(`\n${'='.repeat(56)}`)
console.log(`PASS ${pass}  FAIL ${failures.length}`)
if (failures.length) {
  console.log('失败项:')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log('全部通过')
