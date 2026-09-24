// useMarketBrowse 回归测试:市场浏览的模式、分页与标签聚合池。
//
// 这块从 MarketplaceView.vue 抽出(原本占视图脚本近一半),里面同时压着三层逻辑:
// 五种模式各自的取数方式、服务端分页 vs 客户端聚合池、展示层二次过滤。
// 其中**聚合池**是最容易出错的部分(商店不支持服务端标签过滤,要自己批量拉页攒池),
// 这里用可控的服务端桩把它逐条锁住。
//
// 用法(npm script 会先跑打包步骤):
//   npm run test:renderer
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.resolve(__dirname, '../../../.gpm-test/out')

for (const name of ['usemarketbrowse', 'vueshim']) {
  if (!existsSync(path.join(OUT, `${name}.mjs`))) {
    console.error(`找不到打包产物: ${path.join(OUT, `${name}.mjs`)}`)
    console.error('请先运行: node src/composables/__tests__/build-bundle.mjs')
    process.exit(2)
  }
}

const { ref } = await import(pathToFileURL(path.join(OUT, 'vueshim.mjs')).href)
const { useMarketBrowse, MODE_META, POOL_PAGE } = await import(
  pathToFileURL(path.join(OUT, 'usemarketbrowse.mjs')).href
)

// ---------- 桩:window.services ----------
const calls = []
const pages = { all: 1, new: 1, recent: 1 }
/** 每页返回的资产工厂:可按页定制 */
let pageFactory = (kind, p) => ({ result: [{ assetId: `a/${kind}${p}`, title: `${kind}${p}` }], pages: pages[kind] })
let failOn = null
let favoritesList = []
let featuredList = []
let hydrateCalls = []

global.window = {
  services: {
    listAllAssets(p) { return serve('all', p) },
    listNewAssets(p) { return serve('new', p) },
    listRecentlyUpdated(p) { return serve('recent', p) },
    listFeatured() { calls.push('featured'); return Promise.resolve(featuredList) },
    // 真实实现是同步的(读本地库),别写成 Promise
    listFavorites() { calls.push('favorites'); return favoritesList }
  }
}

/** 越界页按真实服务端行为返回空列表(否则会凭空放大聚合池) */
function serve(kind, p) {
  calls.push(`${kind}:${p}`)
  if (failOn === kind) return Promise.reject(new Error('商店挂了'))
  if (p > pages[kind]) return Promise.resolve({ result: [], pages: pages[kind] })
  return Promise.resolve(pageFactory(kind, p))
}

function reset() {
  calls.length = 0
  hydrateCalls.length = 0
  pages.all = 1; pages.new = 1; pages.recent = 1
  pageFactory = (kind, p) => ({ result: [{ assetId: `a/${kind}${p}`, title: `${kind}${p}` }], pages: pages[kind] })
  failOn = null
  favoritesList = []
  featuredList = []
}

/** 造一个浏览组合式函数(注入的 ref 用共享 vue 创建,watch 才能真正触发) */
function make(over = {}) {
  const tagFilter = over.tagFilter || ref('')
  const query = over.query || ref('')
  const results = over.results || ref([])
  const compatOnly = over.compatOnly || ref(false)
  const compatOf = over.compatOf || (() => true)
  const b = useMarketBrowse({
    tagFilter,
    query,
    results,
    compatOnly,
    compatOf,
    hydrate: (list) => { hydrateCalls.push(list) }
  })
  return { b, tagFilter, query, results, compatOnly }
}

let pass = 0
const failures = []
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log(`  PASS  ${label}`) }
  else { failures.push(label); console.log(`  FAIL  ${label}${extra !== undefined ? '  → ' + extra : ''}`) }
}
const section = (t) => console.log(`\n=== ${t} ===`)
const sleep = (ms = 0) => new Promise((r) => setTimeout(r, ms))
const asset = (id) => ({ assetId: id, title: id })

async function main() {
  // ---------- 1. 初始与模式切换 ----------
  section('1. 初始状态与模式切换')
  {
    reset()
    const { b } = make()
    ok(b.mode.value === 'featured', '默认进入推荐模式', b.mode.value)
    ok(b.pageNum.value === 1, '默认第 1 页')
    ok(b.aggregating.value === false, '默认不是聚合模式')
    ok(!!MODE_META.all && !!MODE_META.favorites, 'MODE_META 覆盖全部分类')
    ok(POOL_PAGE === 20, '聚合每屏 20 项', String(POOL_PAGE))

    reset()
    await b.switchMode('all')
    ok(b.mode.value === 'all', '切到全部模式')
    ok(calls.some((c) => c === 'all:1'), '切换后拉取第 1 页', calls.join(','))
  }

  // ---------- 2. 各模式取数 ----------
  section('2. 五种模式的取数方式')
  {
    reset()
    featuredList = [asset('f/1')]
    const { b } = make()
    await b.loadBrowse()
    ok(calls.filter((c) => c === 'featured').length === 1, '推荐拉取一次')
    ok(hydrateCalls.length === 1, '拉取后补齐一次 release 信息')
    await b.loadBrowse()
    ok(calls.filter((c) => c === 'featured').length === 1, '推荐已缓存,不重复拉取', String(calls.length))

    reset()
    pages.all = 7
    pageFactory = (kind, p) => ({ result: [asset(`all/${p}`)], pages: 7 })
    await b.switchMode('all')
    ok(b.pageTotal.value === 7, '全部模式写入服务端总页数', String(b.pageTotal.value))

    reset()
    pageFactory = (kind, p) => ({ result: [asset(`${kind}/${p}`)], pages: 3 })
    await b.switchMode('new')
    ok(calls[0] === 'new:1', '新品模式调 listNewAssets', calls[0])
    await b.switchMode('recent')
    ok(b.mode.value === 'recent', '切到最近更新')
    ok(calls.includes('recent:1'), '最近更新调 listRecentlyUpdated', calls.join(','))

    reset()
    favoritesList = [asset('fav/1'), asset('fav/2')]
    b.mode.value = 'favorites'
    await b.loadBrowse()
    ok(calls.includes('favorites'), '收藏读本地 listFavorites', calls.join(','))
    ok(b.favorites.value.length === 2, '收藏写入 favorites')
    ok(hydrateCalls.length === 1, '收藏也补齐 release 信息')
  }

  // ---------- 3. 聚合模式判定 ----------
  section('3. 聚合模式:仅「分页模式 + 已选标签」')
  {
    const { b, tagFilter } = make()
    tagFilter.value = '2D'
    ok(b.aggregating.value === false, '推荐模式 + 标签 → 不聚合')
    b.mode.value = 'all'
    await sleep()
    ok(b.aggregating.value === true, '全部模式 + 标签 → 聚合')
    b.mode.value = 'favorites'
    await sleep()
    ok(b.aggregating.value === false, '收藏模式 + 标签 → 不聚合')

    const t2 = make({ tagFilter: ref('') })
    t2.b.mode.value = 'new'
    await sleep()
    ok(t2.b.aggregating.value === false, '无标签 → 不聚合')
  }

  // ---------- 4. 聚合池填充 ----------
  section('4. 聚合池:批量拉页 / 按标签攒池 / 末页终止')
  {
    reset()
    pages.all = 3
    // 每页 10 项,其中 5 项是 2d;3 页共 15 个匹配项,不足 20 → 会拉完全库
    pageFactory = (kind, p) => ({
      result: [
        ...Array.from({ length: 5 }, (_, i) => ({ assetId: `a/2d-${p}-${i}`, title: 'm', tagSlugs: ['2d'] })),
        ...Array.from({ length: 5 }, (_, i) => ({ assetId: `a/3d-${p}-${i}`, title: 'x', tagSlugs: ['3d'] }))
      ],
      pages: 3
    })
    const { b, tagFilter } = make()
    tagFilter.value = '2D'
    b.mode.value = 'all'
    await sleep()
    await b.loadBrowse()
    ok(b.matchPool.value.length === 15, '池内只收匹配标签的资产', String(b.matchPool.value.length))
    ok(
      b.matchPool.value.every((a) => a.tagSlugs.includes('2d')),
      '池内每一项都命中标签(不含同页的 3d 项)'
    )
    // 首批并发宽度固定为 4 页(建批时还不知道服务端总页数),所以会多请求 1 页;
    // 越界页返回空列表,由 `!r.result.length` 收敛 —— 这是既有行为,不是本次引入的。
    ok(b.poolFetched.value === 4, '首批并发 4 页(含 1 页越界)', String(b.poolFetched.value))
    ok(b.poolDone.value === true, '服务端拉完标记 poolDone')
    ok(b.poolPages.value === 1, '15 项 → 1 页(ceil(15/20))', String(b.poolPages.value))
    ok(b.browsing.value === false, '加载态复位')

    // 每页都匹配:首批 4 页即可凑满 20,不该继续拉
    reset()
    pages.all = 10
    pageFactory = (kind, p) => ({
      result: Array.from({ length: 10 }, (_, i) => ({ assetId: `a/2d-${p}-${i}`, title: 'm', tagSlugs: ['2d'] })),
      pages: 10
    })
    const s = make()
    s.tagFilter.value = '2D'
    s.b.mode.value = 'all'
    await sleep()
    await s.b.loadBrowse()
    ok(s.b.poolFetched.value === 4, '一批 4 页并发,凑满即停', String(s.b.poolFetched.value))
    ok(s.b.matchPool.value.length >= POOL_PAGE, '池内已够一屏', String(s.b.matchPool.value.length))
    ok(s.b.poolDone.value === false, '还没拉完,poolDone 为 false')
    ok(s.b.poolPages.value >= 2, '池页数随之增长', String(s.b.poolPages.value))
    ok(hydrateCalls.length > 0, '聚合后为当前屏补齐 release 信息')
  }

  // ---------- 5. displayAssets ----------
  section('5. displayAssets:搜索优先 / 池切片 / 标签与兼容过滤')
  {
    reset()
    const results = ref([asset('s/1'), asset('s/2')])
    const s = make({ query: ref('shader'), results })
    s.b.mode.value = 'all'
    ok(s.b.displayAssets.value.length === 2, '有搜索词时展示搜索结果', String(s.b.displayAssets.value.length))

    // 聚合模式下按池切片
    reset()
    pages.all = 1
    pageFactory = () => ({
      result: Array.from({ length: 25 }, (_, i) => ({ assetId: `a/2d-${i}`, title: 'm', tagSlugs: ['2d'] })),
      pages: 1
    })
    const p = make()
    p.tagFilter.value = '2D'
    p.b.mode.value = 'all'
    await sleep()
    await p.b.loadBrowse()
    ok(p.b.displayAssets.value.length === POOL_PAGE, '聚合模式每屏固定 20 项', String(p.b.displayAssets.value.length))
    p.b.pageNum.value = 2
    ok(p.b.displayAssets.value.length === 5, '第 2 页取剩余 5 项', String(p.b.displayAssets.value.length))
    p.b.pageNum.value = 1

    // 非聚合模式的标签过滤 + 兼容过滤
    reset()
    featuredList = [
      { assetId: 'a/1', title: '2d', tagSlugs: ['2d'], minGodot: '9.0' },
      { assetId: 'a/2', title: '3d', tagSlugs: ['3d'] }
    ]
    const f = make({ tagFilter: ref('2D'), compatOnly: ref(true), compatOf: (a) => (a.minGodot === '9.0' ? false : true) })
    await f.b.loadBrowse()
    ok(f.b.displayAssets.value.length === 0, '标签分组 + 兼容过滤叠加后为空', String(f.b.displayAssets.value.length))
    f.compatOnly.value = false
    ok(f.b.displayAssets.value.length === 1, '关掉兼容过滤后剩 1 项(标签命中的那个)', String(f.b.displayAssets.value.length))
  }

  // ---------- 6. 标签变化 watcher ----------
  section('6. 标签变化:聚合模式重建池 / 离开聚合回到服务端第 1 页')
  {
    reset()
    pages.all = 1
    pageFactory = () => ({ result: [{ assetId: 'a/2d', title: 'm', tagSlugs: ['2d'] }], pages: 1 })
    const s = make()
    s.b.mode.value = 'all'
    await sleep()
    s.b.pageNum.value = 3
    s.tagFilter.value = '2D'
    await sleep(20)
    ok(s.b.pageNum.value === 1, '进入聚合模式时页码重置', String(s.b.pageNum.value))
    ok(s.b.matchPool.value.length > 0, '进入聚合模式后开始攒池', String(s.b.matchPool.value.length))

    reset()
    const l = make({ tagFilter: ref('2D') })
    l.b.mode.value = 'all'
    await sleep(20)
    l.b.pageNum.value = 3
    l.tagFilter.value = ''
    await sleep(20)
    ok(l.b.pageNum.value === 1, '离开聚合模式时页码回到第 1 页', String(l.b.pageNum.value))
    ok(calls.some((c) => c === 'all:1'), '并重新按服务端第 1 页取数', calls.join(','))
  }

  // ---------- 7. changePage 边界 ----------
  section('7. changePage 边界')
  {
    reset()
    pageFactory = () => ({ result: [asset('a/1')], pages: 2 })
    const s = make()
    await s.b.switchMode('all')
    s.b.pageNum.value = 2
    await s.b.changePage(1)
    ok(s.b.pageNum.value === 2, '超过总页数不再前进', String(s.b.pageNum.value))
    await s.b.changePage(-5)
    ok(s.b.pageNum.value === 2, '页码小于 1 时不动', String(s.b.pageNum.value))
    await s.b.changePage(-1)
    ok(s.b.pageNum.value === 1, '正常后退一页')
  }

  // ---------- 8. 错误路径 ----------
  section('8. 错误路径')
  {
    reset()
    failOn = 'all'
    const s = make()
    await s.b.switchMode('all')
    ok(!!s.b.browseError.value, '取数失败写入 browseError', s.b.browseError.value)
    ok(s.b.browsing.value === false, '失败后加载态复位')
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
}

main().catch((e) => {
  console.error('\n未捕获异常:', e)
  process.exit(1)
})
