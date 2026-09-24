// 市场收藏的回归测试。
//
// 为什么单独一个文件:收藏是「渲染层状态 + 本地库」两侧配合的功能,曾经的实现对了两件事,
// 而两件事都不会报错:
//   1. `delete asset.addedAt` —— 改动了**调用方**(渲染层的响应式资产)对象。它是多余动作
//      (后面显式写了 addedAt: Date.now(),旧值本就会被覆盖),却让收藏走了一条会碰入参的路径。
//   2. 忽略 `putDoc` 的返回值 —— 宿主写库失败时「收藏」静默不生效,调用方还以为成功了。
// 本文件把这两条钉成断言,并补上 assetId 归一化(库里存字符串,已安装插件的 assetId 是数字)。
//
// 用法:
//   node src-ztools/preload/lib/__tests__/favorites.test.js
const path = require('node:path')

const LIB = path.resolve(__dirname, '..')
if (!require('node:fs').existsSync(path.join(LIB, 'assets.js'))) {
  console.error(`找不到被测模块: ${path.join(LIB, 'assets.js')}`)
  process.exit(2)
}

// ---------- 内存版 ztools.db 桩(与真实宿主一致:get 返回浅拷贝,_rev 由宿主维护) ----------
const docs = new Map()
let rev = 0
/** 置为 true 时 put 一律失败,用于验证「写库失败不谎报成功」 */
let putFails = false
global.window = {
  ztools: {
    db: {
      get: (id) => (docs.has(id) ? { ...docs.get(id) } : null),
      put: (doc) => {
        if (putFails) return { error: 'write failed' }
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
  }
}

const assets = require(path.join(LIB, 'assets.js'))

let pass = 0
const failures = []
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log(`  PASS  ${label}`) }
  else { failures.push(label); console.log(`  FAIL  ${label}${extra !== undefined ? '  → ' + extra : ''}`) }
}
const section = (t) => console.log(`\n=== ${t} ===`)

const FAV_ID = 'godot/market/favorites'
const stored = () => (docs.has(FAV_ID) ? docs.get(FAV_ID).items : null)

/** 一份最小市场资产 */
const assetOf = (assetId, title) => ({
  assetId,
  title,
  author: 'someone',
  category: '3D',
  versionString: '1.0.0',
  godotVersion: '4.0',
  description: 'desc'
})

// ---------- 1. 收藏 → 查询 → 取消 ----------
section('1. 收藏往返')

const A = assetOf('matias-szylkowski/richtext3d', 'RichText3D')

ok(assets.isFavorite(A.assetId) === false, '初始未收藏')
ok(assets.toggleFavorite(A) === true, '收藏返回 true')
ok(assets.isFavorite(A.assetId) === true, '收藏后 isFavorite 为 true')
ok(stored() !== null && stored().length === 1, '库里出现 1 条收藏', stored() && String(stored().length))
ok(assets.listFavorites().length === 1, 'listFavorites 返回 1 条')
ok(assets.listFavorites()[0].title === 'RichText3D', '收藏条目保留了展示字段')
ok(typeof assets.listFavorites()[0].addedAt === 'number', '收藏条目带 addedAt 时间戳')

ok(assets.toggleFavorite(A) === false, '再点一次取消收藏,返回 false')
ok(assets.isFavorite(A.assetId) === false, '取消后 isFavorite 为 false')
ok(stored().length === 0, '库里收藏被清空', stored() && String(stored().length))

// ---------- 2. 不得改动入参(旧实现的 delete asset.addedAt) ----------
section('2. 不改动调用方对象')

const fromFavorites = { ...assetOf('x/plug', 'Plug'), addedAt: 12345 }
const snapshot = JSON.stringify(fromFavorites)
assets.toggleFavorite(fromFavorites)
ok(
  JSON.stringify(fromFavorites) === snapshot,
  '收藏后入参对象逐字节不变(旧实现会 delete 掉 addedAt)',
  JSON.stringify(fromFavorites)
)
ok(fromFavorites.addedAt === 12345, '入参的 addedAt 仍在(调用方可能是渲染层的响应式资产)')
ok(stored()[0].addedAt !== 12345, '库里存的是新的时间戳,而不是沿用入参的旧值')

// ---------- 3. assetId 归一化 ----------
section('3. assetId 归一化:数字与字符串视为同一个')

const NUM = 998877
ok(assets.toggleFavorite({ assetId: NUM, title: 'Numeric' }) === true, '数字 assetId 可以收藏')
ok(assets.isFavorite(NUM) === true, '用数字查询命中')
ok(assets.isFavorite(String(NUM)) === true, '用字符串查询也命中(两侧归一化)')
ok(stored().some((x) => x.assetId === String(NUM)), '库里存的是字符串形式')
const countAfterNum = stored().length
assets.toggleFavorite({ assetId: String(NUM), title: 'Numeric' })
ok(stored().length === countAfterNum - 1, '用字符串形式再点一次是取消,而不是新增一条', String(stored().length))
ok(assets.isFavorite(NUM) === false, '取消后数字查询也为 false')

// ---------- 4. 缺 assetId / 空值不写脏数据 ----------
section('4. 缺 assetId 明确失败,不写脏记录')

const before = stored().length
ok(assets.toggleFavorite({ title: '无 id' }) === false, '缺 assetId 返回 false')
ok(assets.toggleFavorite({ assetId: '' }) === false, '空串 assetId 返回 false')
ok(assets.toggleFavorite(null) === false, 'null 入参返回 false')
ok(stored().length === before, '三次失败都没有往库里写东西', String(stored().length))
ok(assets.isFavorite('') === false, 'isFavorite("") 为 false')
ok(assets.isFavorite(null) === false, 'isFavorite(null) 为 false')
ok(assets.listFavorites().every((x) => x && x.assetId), '库里不存在没有 assetId 的条目')

// ---------- 5. 写库失败:不谎报成功,也不留半条脏数据 ----------
section('5. 写库失败的处理')

const B = assetOf('ramokz/phantom-camera', 'Phantom Camera')
ok(assets.toggleFavorite(B) === true, '先正常收藏一条作为基线')
const baseCount = stored().length

putFails = true
const failAdd = assets.toggleFavorite(assetOf('some/failing', 'Failing'))
const failRemove = assets.toggleFavorite(B)
putFails = false

ok(failAdd === false, '写库失败时新增返回 false(而不是谎报已收藏)')
ok(failRemove === true, '写库失败时取消返回原状态 true(而不是谎报已取消)')
ok(assets.isFavorite('some/failing') === false, '失败的新增没有落库')
ok(assets.isFavorite(B.assetId) === true, '失败的取消没有把已有收藏弄丢')
ok(stored().length === baseCount, '库内容与失败前一致', `期望 ${baseCount} 实际 ${stored().length}`)

// ---------- 6. 排序:按收藏时间倒序 ----------
section('6. listFavorites 按收藏时间倒序')

const list = assets.listFavorites()
ok(list.length >= 2, '至少有 2 条可以验证顺序', String(list.length))
let desc = true
for (let i = 1; i < list.length; i++) {
  if ((list[i - 1].addedAt || 0) < (list[i].addedAt || 0)) desc = false
}
ok(desc, 'addedAt 单调不增', list.map((x) => x.addedAt).join(' > '))

// ---------- 7. 同一 assetId 不会重复收藏 ----------
section('7. 同一 assetId 不重复')

const C = assetOf('tokisan-games/terrain3d', 'Terrain3D')
assets.toggleFavorite(C)
const n1 = stored().length
assets.toggleFavorite(C) // 取消
assets.toggleFavorite(C) // 再收藏
ok(stored().length === n1, '收藏/取消/再收藏后条数不变', `期望 ${n1} 实际 ${stored().length}`)
ok(stored().filter((x) => String(x.assetId) === C.assetId).length === 1, '同一 assetId 只有一条')

// ---------- 结果 ----------
console.log(`\n${'='.repeat(56)}`)
console.log(`PASS ${pass}  FAIL ${failures.length}`)
if (failures.length) {
  console.log('失败项:')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log('全部通过')
