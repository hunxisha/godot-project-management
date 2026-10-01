// 文档浏览数据层测试:useDocs(库状态/当前库选择/收藏历史/搜索委托)。
//
// 两条关键约束:当前库选择持久化到 godot/settings.docsVersionId(重启回到上次浏览);
// 保存的库失效(被删/未生成)时回退到第一个可用库 —— 这里都用 db 桩把它锁住。
//
// 用法(npm script 会先跑打包步骤):
//   npm run test:renderer
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.resolve(__dirname, '../../../.gpm-test/out')

for (const name of ['usedocs', 'vueshim']) {
  if (!existsSync(path.join(OUT, `${name}.mjs`))) {
    console.error(`找不到打包产物: ${path.join(OUT, `${name}.mjs`)}`)
    console.error('请先运行: node src/composables/__tests__/build-bundle.mjs')
    process.exit(2)
  }
}

// ---------- 桩:window.ztools.db + window.services ----------

const docs = new Map()
let rev = 0
const VA = 'godot/version/vA'
const VB = 'godot/version/vB'
const VERSIONS = [
  { _id: 'godot/version/vA', id: 'godot/version/vA', tag: '4.7.2-stable', name: '4.7.2 Stable', exePath: 'X:/a.exe' },
  { _id: 'godot/version/vB', id: 'godot/version/vB', tag: '4.8-dev6', name: '4.8 Dev 6', exePath: 'X:/b.exe' }
]
let listClassesResult = { ok: false, error: '文档库不存在或未生成' }
let searchCalls = []
let generateCalls = []
let favList = []
let historyList = []
let libraryStatuses = { [VA]: null, [VB]: null }

const dbApi = {
  get: (id) => (docs.has(id) ? { ...docs.get(id) } : null),
  put: (doc) => {
    if (!doc || !doc._id) return { error: 'no id' }
    rev++
    docs.set(doc._id, { ...doc, _rev: `r${rev}` })
    return { ok: true }
  },
  remove: (doc) => {
    docs.delete(doc._id)
    return { ok: true }
  },
  allDocs: (prefix) => [...docs.values()].filter((d) => d._id.startsWith(prefix)).map((d) => ({ ...d }))
}

const servicesApi = {
  docsLibraryStatus: (versionId) => libraryStatuses[versionId] ?? null,
  docsListClasses: (versionId) => listClassesResult,
  docsSearch: (versionId, query, limit) => {
    searchCalls.push({ versionId, query, limit })
    return [{ kind: 'class', className: 'Node', name: 'Node', brief: '', score: 103 }]
  },
  docsGenerate: (versionId, opts) => {
    generateCalls.push({ versionId, opts })
    return { ok: true, taskId: 'docs-x' }
  },
  docsDeleteLibrary: () => ({ ok: true }),
  docsListFavorites: () => favList,
  docsToggleFavorite: (className, fav) => {
    favList = fav ? [...favList, className].sort() : favList.filter((f) => f !== className)
    return { ok: true }
  },
  docsListHistory: () => historyList,
  docsPushHistory: (className) => {
    historyList = [{ name: className, at: Date.now() }, ...historyList.filter((h) => h.name !== className)]
  }
}

global.window = { ztools: { db: dbApi }, services: servicesApi }

const { ref, nextTick } = await import(pathToFileURL(path.join(OUT, 'vueshim.mjs')).href)

let freshSeq = 0
/** useDocs 是模块级单例 —— 每个用例组用 cache-busting import 拿一个全新实例 */
async function freshModule() {
  freshSeq++
  return import(`${pathToFileURL(path.join(OUT, 'usedocs.mjs')).href}?fresh=${freshSeq}`)
}

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
const sleep = (ms = 5) => new Promise((r) => setTimeout(r, ms))

async function main() {
  section('init:无保存选择时落到第一个可用库')
  docs.set(VA, VERSIONS[0])
  docs.set(VB, VERSIONS[1])
  libraryStatuses = { [VA]: { status: 'ready', versionId: VA, tag: '4.7.2-stable', classCount: 1080 }, [VB]: null }
  listClassesResult = { ok: true, classes: [{ name: 'Node', inherits: 'Object', brief: '', builtin: false, isSingleton: false, m: [], p: [], s: [], c: [], e: [] }] }
  let { useDocs } = await freshModule()
  const d1 = useDocs()
  await d1.init()
  await nextTick()
  ok(d1.currentVersionId.value === VA, '当前库 = 第一个 ready 版本', d1.currentVersionId.value)
  ok(d1.classes.value.length === 1 && d1.classes.value[0].name === 'Node', '类列表来自当前库')
  ok(d1.readyVersions.value.length === 1 && d1.readyVersions.value[0].id === VA, 'readyVersions 只含可用库')

  section('init:恢复保存的选择')
  docs.set('godot/settings', { _id: 'godot/settings', docsVersionId: VA })
  libraryStatuses = { [VA]: { status: 'ready', versionId: VA, tag: '4.7.2-stable', classCount: 1080 }, [VB]: null }
  ;({ useDocs } = await freshModule())
  const d2 = useDocs()
  await d2.init()
  ok(d2.currentVersionId.value === VA, '保存的库可用 → 恢复')

  section('init:保存的库失效 → 回退')
  docs.set('godot/settings', { _id: 'godot/settings', docsVersionId: VB })
  libraryStatuses = { [VA]: { status: 'ready', versionId: VA, tag: '4.7.2-stable', classCount: 1080 }, [VB]: null }
  ;({ useDocs } = await freshModule())
  const d3 = useDocs()
  await d3.init()
  ok(d3.currentVersionId.value === VA, '失效库回退到第一个可用', d3.currentVersionId.value)
  const settingsDoc = docs.get('godot/settings')
  ok(settingsDoc.docsVersionId === VA, '回退后回写 settings', JSON.stringify(settingsDoc))

  section('selectVersion 持久化')
  libraryStatuses = { [VA]: { status: 'ready', versionId: VA, tag: '4.7.2-stable' }, [VB]: { status: 'ready', versionId: VB, tag: '4.8-dev6' } }
  ;({ useDocs } = await freshModule())
  const d4 = useDocs()
  await d4.init()
  await d4.selectVersion(VB)
  ok(d4.currentVersionId.value === VB, '切换当前库')
  ok(docs.get('godot/settings').docsVersionId === VB, '选择已持久化')

  section('generate → building 状态')
  const g = await d4.generate(VB)
  ok(g.ok === true && generateCalls[0].versionId === VB, 'generate 委托 preload')
  ok(d4.statuses.value[VB]?.status === 'building', '入队后状态转 building', JSON.stringify(d4.statuses.value[VB]))
  await d4.generate(VB, { forceTranslation: true })
  ok(generateCalls[1].opts?.forceTranslation === true, '强刷翻译选项透传 preload', JSON.stringify(generateCalls[1]))

  section('收藏与历史')
  await d4.toggleFavorite('Node')
  ok(d4.favorites.value.includes('Node'), '收藏生效')
  await d4.toggleFavorite('Node')
  ok(!d4.favorites.value.includes('Node'), '再点取消收藏')
  await d4.pushHistory('Vector2')
  ok(d4.history.value.length === 1 && d4.history.value[0].name === 'Vector2', '历史记录')

  section('search 委托(带当前库 id)')
  d4.search('node', 20)
  ok(searchCalls.length === 1 && searchCalls[0].versionId === VB && searchCalls[0].query === 'node' && searchCalls[0].limit === 20, '搜索参数透传', JSON.stringify(searchCalls[0]))

  section('继承链与派生(纯前端计算)')
  listClassesResult = {
    ok: true,
    classes: [
      { name: 'Object', inherits: null, brief: '', builtin: false, isSingleton: false, m: [], p: [], s: [], c: [], e: [] },
      { name: 'Node', inherits: 'Object', brief: '', builtin: false, isSingleton: false, m: [], p: [], s: [], c: [], e: [] },
      { name: 'Node2D', inherits: 'Node', brief: '', builtin: false, isSingleton: false, m: [], p: [], s: [], c: [], e: [] },
      { name: 'Sprite2D', inherits: 'Node2D', brief: '', builtin: false, isSingleton: false, m: [], p: [], s: [], c: [], e: [] }
    ]
  }
  ;({ useDocs } = await freshModule())
  const d5 = useDocs()
  await d5.init()
  await sleep()
  ok(d5.inheritsChainOf('Sprite2D').map((c) => c.name).join(',') === 'Node2D,Node,Object', '面包屑链完整', JSON.stringify(d5.inheritsChainOf('Sprite2D')))
  ok(d5.derivedOf('Node').map((c) => c.name).join(',') === 'Node2D', '直接派生列表')

  console.log(`\n${pass} passed, ${failures.length} failed`)
  if (failures.length) {
    console.log('FAILURES:')
    for (const f of failures) console.log('  - ' + f)
    process.exit(1)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
