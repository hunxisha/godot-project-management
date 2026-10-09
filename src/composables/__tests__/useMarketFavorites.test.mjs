// useMarketFavorites 回归测试。
//
// 这个组合式函数存在的直接原因是踩过一个**只有宿主能暴露**的坑:
// 收藏按钮点了没反应,不写库也不报错。诊断出来是 contextBridge 的
// `An object could not be cloned.` —— 传进去的是 Vue 的响应式资产对象(Proxy)。
// 安装按钮之所以正常,是因为它传的是新建的纯对象。
//
// 所以本文件第 1 节是重点:断言跨层传参**不是 Proxy**、且嵌套数组也已脱离响应式。
// 这类断言只能在渲染层跑(Node 的 util.types.isProxy 能直接识破 Proxy),
// preload 侧的 favorites.test.js 测不到它。
//
// 用法:
//   node src/composables/__tests__/build-bundle.mjs && node src/composables/__tests__/useMarketFavorites.test.mjs
//
// 注意:必须从**打包产物**里导入 ref/reactive(下面这段)。
// 直接 `import { ref } from './vue-shim.mjs'` 会让 Node 去加载 node_modules 的 vue,
// 那是与产物内联 vue **不同的实例**,于是组合式函数里的 computed 永远看不到测试创建的 ref
// —— 表现就是「收藏成功了但 isFav 还是 false」,看起来像业务 bug,其实是测试自坑。
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { types } from 'node:util'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.resolve(__dirname, '../../../.gpm-test/out')

for (const name of ['usemarketfavorites', 'vueshim']) {
  if (!existsSync(path.join(OUT, `${name}.mjs`))) {
    console.error(`找不到打包产物: ${path.join(OUT, `${name}.mjs`)}`)
    console.error('请先运行: node src/composables/__tests__/build-bundle.mjs')
    process.exit(2)
  }
}

const { reactive, ref } = await import(pathToFileURL(path.join(OUT, 'vueshim.mjs')).href)
const { useMarketFavorites, toBridgeData } = await import(
  pathToFileURL(path.join(OUT, 'usemarketfavorites.mjs')).href
)

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

// ---------- 夹具:一个会真的维护收藏库的假跨层服务 ----------
let captured = null
let shouldThrow = ''
const notifies = []
/** 假服务的「库」:只存 assetId,够验证往返语义 */
const favDb = new Set()
global.window = {
  services: {
    toggleFavorite(arg) {
      if (shouldThrow) throw new Error(shouldThrow)
      captured = arg
      const id = String(arg.assetId)
      if (favDb.has(id)) favDb.delete(id)
      else favDb.add(id)
      return true
    }
  }
}

const favorites = ref([])
const reloadFavorites = () => {
  favorites.value = [...favDb].map((id) => ({ assetId: id, title: id, addedAt: Date.now() }))
}
const notify = (m) => notifies.push(m)

const fav = useMarketFavorites({ favorites, reloadFavorites, notify })

const assetOf = (assetId, title) => ({
  assetId,
  title,
  author: 'someone',
  category: '3D',
  versionString: '1.0.0',
  godotVersion: '4.0',
  description: 'desc',
  tagSlugs: ['3d', 'tools']
})

// ---------- 1. 跨层传参必须是纯数据(本文件的核心) ----------
section('1. 跨层传参:不得把响应式对象交给 contextBridge')

const reactiveAsset = reactive(assetOf('matias-szylkowski/richtext3d', 'RichText3D'))
ok(types.isProxy(reactiveAsset), '夹具本身是响应式 Proxy(否则本节没有意义)')
ok(types.isProxy(reactiveAsset.tagSlugs), '嵌套数组也是 Proxy(浅拷贝脱不掉)')

captured = null
await fav.toggleFav(reactiveAsset)
ok(captured !== null, '入参已送达跨层服务')
ok(!types.isProxy(captured), '送达的是纯对象,不是 Proxy')
ok(!types.isProxy(captured.tagSlugs), '嵌套数组也已脱离响应式')
ok(captured.assetId === 'matias-szylkowski/richtext3d', 'assetId 原样保留')
ok(captured.title === 'RichText3D', '展示字段原样保留')
ok(Array.isArray(captured.tagSlugs) && captured.tagSlugs.length === 2, '数组内容原样保留', JSON.stringify(captured.tagSlugs))
ok(JSON.stringify(captured).length > 0, '可 JSON 序列化(克隆的前提)')

// toBridgeData 本身:浅拷贝不够,必须是 JSON 往返
const shallow = { ...reactiveAsset }
ok(types.isProxy(shallow.tagSlugs), '浅拷贝脱不掉嵌套代理(所以不能用 { ...a } 代替)')
ok(!types.isProxy(toBridgeData(reactiveAsset).tagSlugs), 'toBridgeData 能脱掉嵌套代理')

// ---------- 2. 收藏成功 ----------
section('2. 收藏成功:状态、星标集合与提示')

favDb.clear()
reloadFavorites()
notifies.length = 0

const A = assetOf('a/plug', 'Plug A')
ok(fav.isFav(A.assetId) === false, '收藏前 isFav 为 false')
ok(await fav.toggleFav(A) === true, 'toggleFav 返回 true')
ok(fav.isFav(A.assetId) === true, '收藏后 isFav 为 true')
ok(fav.favIds.value.has('a/plug'), '星标集合包含该 assetId')
ok(fav.favDiag.value === '', '成功时没有诊断信息')
ok(notifies.length === 1 && notifies[0] === '已收藏 Plug A', '提示文案正确', notifies.join(' | '))

// ---------- 3. 取消收藏 ----------
section('3. 取消收藏')

notifies.length = 0
ok(await fav.toggleFav(A) === false, '再点一次返回 false(表示已取消)')
ok(fav.isFav(A.assetId) === false, '取消后 isFav 为 false')
ok(notifies[0] === '已取消收藏', '提示文案正确', notifies.join(' | '))

// ---------- 4. 跨层/写库失败:说出原因,不静默 ----------
section('4. 失败必须可见')

favDb.clear()
reloadFavorites()
notifies.length = 0
shouldThrow = 'An object could not be cloned.'
const failedReturn = await fav.toggleFav(assetOf('x/y', 'Y'))
shouldThrow = ''

ok(failedReturn === false, '失败时返回 false')
ok(/An object could not be cloned/.test(fav.favDiag.value), '诊断信息带出宿主原因', fav.favDiag.value)
ok(notifies.length === 1 && /收藏失败/.test(notifies[0]), '同时给出用户可见的提示', notifies.join(' | '))
ok(fav.isFav('x/y') === false, '失败后星标保持未收藏')

// ---------- 5. 没抛错但没生效:也要被发现 ----------
section('5. 写入未生效(前后状态相同)')

notifies.length = 0
// 假服务收下参数但什么都没存(模拟「写库没报错也没生效」)
const favNoop = useMarketFavorites({
  favorites: ref([]),
  reloadFavorites: () => { /* 列表始终为空 */ },
  notify
})
ok(await favNoop.toggleFav(assetOf('z/w', 'W')) === false, '返回 false')
ok(/收藏未生效/.test(favNoop.favDiag.value), '诊断信息点明「收藏未生效」', favNoop.favDiag.value)
ok(/收藏数=0/.test(favNoop.favDiag.value), '诊断信息带上可核对的收藏数', favNoop.favDiag.value)
ok(notifies.length === 1 && notifies[0] === '收藏失败,请重试', '提示文案可读', notifies.join(' | '))

// ---------- 6. assetId 归一化:数字与字符串同一身份 ----------
section('6. assetId 归一化')

favDb.clear()
favDb.add('998877')
reloadFavorites()
ok(fav.isFav(998877) === true, '数字 id 能匹配到字符串存储')
ok(fav.isFav('998877') === true, '字符串 id 也能匹配')
ok(fav.favIds.value.has('998877'), '集合里存的是字符串形式')

// ---------- 7. 竞态:生产接线的 reloadFavorites 是 async 的 ----------
section('7. reloadFavorites 是 async 时,验证必须等它落地')
// MarketplaceView 传进来的是 useMarketBrowse.ts:163 那个 `async reloadFavorites()`
// (内部 `favorites.value = await window.services.listFavorites()`)。
// 上面几节的桩是同步的,所以这条竞态一直没被覆盖:同步读回必然看到旧列表,
// 于是**写入成功也会**报「收藏未生效」—— 2026-10 用户截图就是这条:
// 顶部收藏徽标已经从 2 变 3(写进去了),红条却写着「前=false 后=false 收藏数=2」。
const favDb2 = new Set()
const favorites2 = ref([])
const notify2 = []
// 全局那个 toggleFavorite 桩写的是 favDb(见文件顶部),本节要的是同一份库;
// 前面几节往里留过条目,这里先清干净,否则「收藏数」这个字段就不是它看起来的那个意思。
favDb.clear()
const reloadAsync = async () => {
  // 先 await 再赋值:赋值落在微任务里,与生产同形(少了这个 await 就等于没建模竞态)
  const list = await Promise.resolve([...favDb].map((id) => ({ assetId: id, title: id })))
  favorites2.value = list
}
const fav2 = useMarketFavorites({
  favorites: favorites2,
  reloadFavorites: reloadAsync,
  notify: (m) => notify2.push(m)
})
const retAdd = await fav2.toggleFav(assetOf('q/r', 'QR'))
ok(retAdd === true, '写入成功时返回 true(而不是被微任务抢跑报成失败)', String(retAdd))
ok(fav2.favDiag.value === '', '不得误报「收藏未生效」', fav2.favDiag.value)
ok(notify2.length === 1 && notify2[0] === '已收藏 QR', '提示说的是成功', notify2.join(' | '))
ok(fav2.isFav('q/r') === true, '星标状态为已收藏')

// 取消收藏同样要等:否则「已取消」会被报成失败
const retDel = await fav2.toggleFav(assetOf('q/r', 'QR'))
ok(retDel === false, '取消收藏返回 false(表示当前未收藏)', String(retDel))
ok(fav2.favDiag.value === '', '取消这条路径也不许误报', fav2.favDiag.value)
ok(notify2[1] === '已取消收藏', '取消的提示文案正确', notify2.join(' | '))

// 真的没生效时仍要报出来(修复不能让诊断变哑):库什么都不存
const favorites3 = ref([])
const notify3 = []
const fav3 = useMarketFavorites({
  favorites: favorites3,
  reloadFavorites: async () => {
    const list = await Promise.resolve([])
    favorites3.value = list
  },
  notify: (m) => notify3.push(m)
})
ok(await fav3.toggleFav(assetOf('no/save', 'N')) === false, '写入没落地时返回 false')
ok(/收藏未生效/.test(fav3.favDiag.value), '写入真没落地时诊断仍在(修复不许把探针弄哑)', fav3.favDiag.value)

// ---------- 结果 ----------
console.log(`\n${'='.repeat(56)}`)
console.log(`PASS ${pass}  FAIL ${failures.length}`)
if (failures.length) {
  console.log('失败项:')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log('全部通过')
