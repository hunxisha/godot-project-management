// 市场数据层测试:useAssetHydration(信息补齐) + useMarketSearch(搜索与防抖)。
//
// 两块都从 MarketplaceView.vue 抽出,原本内联在视图里无法断言。useAssetHydration 有一条
// 关键约束写在校验里:**只请求尚未补齐过的资产**(聚合模式翻屏靠它避免重复请求),
// 这里用调用次数把它锁住。
//
// 用法(npm script 会先跑打包步骤):
//   npm run test:renderer
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.resolve(__dirname, '../../../.gpm-test/out')

for (const name of ['useassethydration', 'usemarketsearch']) {
  if (!existsSync(path.join(OUT, `${name}.mjs`))) {
    console.error(`找不到打包产物: ${path.join(OUT, `${name}.mjs`)}`)
    console.error('请先运行: node src/composables/__tests__/build-bundle.mjs')
    process.exit(2)
  }
}

// ---------- 桩:window.services ----------
let releaseCalls = []
let releaseMap = {}
let releaseShouldThrow = false
let searchCalls = []
let searchArgList = []
let searchResult = { result: [], page: 1, pages: 1 }
let searchShouldThrow = null

global.window = {
  services: {
    getReleaseInfos(ids) {
      releaseCalls.push(ids)
      if (releaseShouldThrow) throw new Error('网络断了')
      return Promise.resolve(releaseMap)
    },
    searchAssets(...args) {
      searchCalls.push(args[0])
      searchArgList.push(args)
      if (searchShouldThrow) return Promise.reject(new Error(searchShouldThrow))
      return Promise.resolve(searchResult)
    }
  }
}

function reset() {
  releaseCalls = []
  releaseMap = {}
  releaseShouldThrow = false
  searchCalls = []
  searchArgList = []
  searchResult = { result: [], page: 1, pages: 1 }
  searchShouldThrow = null
}

const { useAssetHydration } = await import(pathToFileURL(path.join(OUT, 'useassethydration.mjs')).href)
const { useMarketSearch } = await import(pathToFileURL(path.join(OUT, 'usemarketsearch.mjs')).href)

let pass = 0
const failures = []
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log(`  PASS  ${label}`) }
  else { failures.push(label); console.log(`  FAIL  ${label}${extra !== undefined ? '  → ' + extra : ''}`) }
}
const section = (t) => console.log(`\n=== ${t} ===`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const asset = (over = {}) => ({ assetId: 'author/name', title: 'T', ...over })

// ---------- 1. hydrateVersions:补齐 ----------
section('1. hydrateVersions:就地补齐 release 信息')
{
  reset()
  const { hydrateVersions } = useAssetHydration()
  releaseMap = { 'author/name': { version: '1.2.3', minGodot: '4.0', maxGodot: '4.4', created: '2026-01-01' } }
  const a = asset()
  await hydrateVersions([a])
  ok(releaseCalls.length === 1, '发起了一次批量请求', String(releaseCalls.length))
  ok(releaseCalls[0].length === 1 && releaseCalls[0][0] === 'author/name', '请求带上 assetId')
  ok(a.versionString === '1.2.3', '写入 versionString', String(a.versionString))
  ok(a.minGodot === '4.0' && a.maxGodot === '4.4', '写入兼容范围')
  ok(a.releaseCreated === '2026-01-01', '写入发布日期')

  // 已补齐过的资产不再请求(聚合模式翻屏的关键约束)
  const before = releaseCalls.length
  await hydrateVersions([a])
  ok(releaseCalls.length === before, '已补齐的资产不再请求(避免翻屏重复拉取)', String(releaseCalls.length))
}

section('2. hydrateVersions:哪些不该请求')
{
  reset()
  const { hydrateVersions } = useAssetHydration()
  // 无 assetId / assetId 不含斜杠 / 已部分补齐
  await hydrateVersions([asset({ assetId: undefined }), asset({ assetId: 'noslash' })])
  ok(releaseCalls.length === 0, '无有效 assetId 时不发请求', String(releaseCalls.length))

  reset()
  await hydrateVersions([asset({ versionString: '9.9' })])
  ok(releaseCalls.length === 0, '已有 versionString 时不重复请求')
  reset()
  await hydrateVersions([asset({ minGodot: '4.0' })])
  ok(releaseCalls.length === 0, '已有 minGodot 时不重复请求')
  reset()
  await hydrateVersions([asset({ maxGodot: '4.4' })])
  ok(releaseCalls.length === 0, '已有 maxGodot 时不重复请求')
  reset()
  await hydrateVersions([asset({ releaseCreated: 'x' })])
  ok(releaseCalls.length === 0, '已有 releaseCreated 时不重复请求')
  reset()
  await hydrateVersions([])
  ok(releaseCalls.length === 0, '空列表不请求')
}

section('3. hydrateVersions:异常与缺失')
{
  reset()
  const { hydrateVersions } = useAssetHydration()
  releaseShouldThrow = true
  const a = asset()
  let threw = false
  try {
    await hydrateVersions([a])
  } catch (e) { threw = true }
  ok(!threw, '拉取失败不抛给调用方(否则列表显示不出来)')
  ok(a.versionString === undefined, '失败时资产保持原样')

  reset()
  releaseMap = {} // 服务端没返回这个 assetId
  const b = asset()
  await hydrateVersions([b])
  ok(b.versionString === undefined, 'map 里没有该 assetId 时跳过')
}

section('4. hydrateVersions:部分字段缺失')
{
  reset()
  const { hydrateVersions } = useAssetHydration()
  releaseMap = { 'author/name': { version: '2.0.0' } }
  const a = asset()
  await hydrateVersions([a])
  ok(a.versionString === '2.0.0', '只给 version 时也写入')
  ok(a.minGodot === undefined && a.maxGodot === undefined, '未给的字段保持 undefined(不写空串)')
}

// ---------- 5. useMarketSearch ----------
section('5. useMarketSearch:初始状态与显式搜索')
{
  reset()
  // 本节不测防抖,用一个极长窗口避免留下未触发的定时器污染后续小节
  const s = useMarketSearch({ hydrate: () => {}, debounceMs: 60000 })
  ok(s.query.value === '', '初始关键词为空')
  ok(s.searching.value === false, '初始不在搜索中')
  ok(s.searchError.value === '', '初始无错误')
  ok(s.results.value.length === 0, '初始无结果')
  ok(s.hasSearched.value === false, '初始未搜索过')
  ok(s.isSearching() === false, '空关键词不算搜索模式')

  searchResult = { result: [{ assetId: 'a/b', title: 'X' }], page: 1, pages: 1 }
  s.query.value = 'shader'
  await s.search()
  ok(searchCalls[0] === 'shader', '用 trim 后的关键词请求', String(searchCalls[0]))
  ok(s.results.value.length === 1, '结果写入 results')
  ok(s.searching.value === false, '完成后 searching 复位')
  ok(s.hasSearched.value === true, '标记已搜索过')
  ok(s.isSearching() === true, '关键词非空时进入搜索模式')
  s.cancelPending()
}

section('6. useMarketSearch:失败与防抖')
{
  reset()
  const s = useMarketSearch({ hydrate: () => {}, debounceMs: 60000 })
  searchShouldThrow = '商店 500'
  s.query.value = 'x'
  await s.search()
  ok(s.searchError.value === '商店 500', '失败写入 searchError', s.searchError.value)
  ok(s.searching.value === false, '失败后 searching 也复位')
  ok(s.hasSearched.value === true, '失败也算「搜索过」,界面才能显示错误而不是转圈')
  s.cancelPending()

  // 防抖:设关键词后先等一个微任务让 watch 触发,再等过防抖窗口
  reset()
  const d = useMarketSearch({ hydrate: () => {}, debounceMs: 1 })
  d.query.value = 'physics'
  ok(searchCalls.length === 0, '刚设关键词时不立即请求')
  await sleep(40)
  ok(searchCalls.length === 1, '防抖窗口过后自动搜索一次', String(searchCalls.length))
  ok(searchCalls[0] === 'physics', '自动搜索用的是当前关键词', String(searchCalls[0]))
  d.cancelPending()

  // 清空关键词:回到浏览模式,不请求
  reset()
  const c = useMarketSearch({ hydrate: () => {}, debounceMs: 1 })
  searchResult = { result: [{ assetId: 'a/b', title: 'X' }], page: 1, pages: 1 }
  c.query.value = 'abc'
  await c.search()
  ok(c.hasSearched.value === true, '前置:已搜索过')
  c.query.value = ''
  await sleep(20)
  ok(searchCalls.length === 1, '清空关键词不再触发搜索', String(searchCalls.length))
  ok(c.results.value.length === 0, '清空时丢掉旧结果')
  ok(c.searchError.value === '', '清空时清掉错误')
  ok(c.hasSearched.value === false, '清空时回到「未搜索」状态')
}

section('7. useMarketSearch:回车立即搜索')
{
  reset()
  const s = useMarketSearch({ hydrate: () => {}, debounceMs: 5000 })
  s.query.value = 'tilemap'
  s.onSearchEnter()
  await sleep(20)
  ok(searchCalls.length === 1, '回车绕过防抖立即请求', String(searchCalls.length))
  await sleep(30)
  ok(searchCalls.length === 1, '已取消的防抖不再补一次请求', String(searchCalls.length))

  reset()
  const e = useMarketSearch({ hydrate: () => {}, debounceMs: 1 })
  e.onSearchEnter()
  await sleep(20)
  ok(searchCalls.length === 0, '空关键词回车不发请求')
}

section('8. useMarketSearch:hydrate 被调用')
{
  reset()
  const hydrated = []
  searchResult = { result: [{ assetId: 'a/b', title: 'X' }], page: 1, pages: 1 }
  const s = useMarketSearch({ hydrate: (list) => { hydrated.push(list.length) } })
  s.query.value = 'x'
  await s.search()
  ok(hydrated.length === 1 && hydrated[0] === 1, '搜索结果交给注入的 hydrate 处理', hydrated.join(','))
}

section('9. useMarketSearch:getAssetType 注入搜索类型')
{
  reset()
  const s = useMarketSearch({ hydrate: () => {}, debounceMs: 60000 })
  s.query.value = 'shader'
  await s.search()
  ok(searchArgList[0][3] === 0, '未注入时按插件/素材类型(type=0)搜索', JSON.stringify(searchArgList[0]))

  reset()
  let typeNow = 1
  const s2 = useMarketSearch({ hydrate: () => {}, debounceMs: 60000, getAssetType: () => typeNow })
  s2.query.value = 'city'
  await s2.search()
  ok(searchArgList[0][3] === 1, '注入后按完整项目类型(type=1)搜索', JSON.stringify(searchArgList[0]))
  ok(searchArgList[0][0] === 'city', '关键词不变')

  typeNow = 0
  await s2.search()
  ok(searchArgList[1][3] === 0, '动态 getter 在下一次搜索时生效')
  s2.cancelPending()
}

section('10. useMarketSearch:竞态守卫,旧请求晚到不覆盖新结果')
{
  reset()
  const s = useMarketSearch({ hydrate: () => {} })
  // 让两次 search 的服务端响应都可手动控制
  let resolveA
  let resolveB
  let callN = 0
  window.services.searchAssets = () => {
    callN++
    const no = callN
    return new Promise((resolve) => {
      if (no === 1) resolveA = () => resolve({ result: [{ assetId: 'old/1', title: 'OLD' }], page: 1, pages: 1 })
      else resolveB = () => resolve({ result: [{ assetId: 'new/1', title: 'NEW' }], page: 1, pages: 1 })
    })
  }
  s.query.value = 'a'
  const pA = s.search()
  s.query.value = 'ab'
  const pB = s.search()
  await sleep(10)
  resolveB()
  await pB
  resolveA()
  await pA
  ok(s.results.value.length === 1 && s.results.value[0].assetId === 'new/1',
    '旧请求晚到时结果仍是新请求的', JSON.stringify(s.results.value))
  ok(s.searching.value === false && s.hasSearched.value === true, '状态以最后一次搜索为准')
  s.cancelPending()
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
