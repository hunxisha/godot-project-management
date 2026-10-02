// store.js 回归测试:preload 侧 db 访问封装(与渲染层 bridge.ts 同构)。
//
// store.js 自己不存数据,全部转发给 window.ztools.db —— 宿主 db 是 CouchDB 风格:
// 更新必须带匹配的 _rev,否则回 `{ error: true, name: 'conflict' }`。这层语义错了,
// 表现就是「写了但没生效」「收藏静默丢失」,界面上没有任何线索(排查收藏按钮时正卡在这里)。
// 因此这里用一个内存 db 把 _rev 语义逐条钉死,并覆盖 putDocVerbose 的失败原因透传。
//
// 用法:
//   node src-ztools/preload/lib/__tests__/store.test.js
const path = require('node:path')

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

/** 内存版 CouchDB 风格 db:深拷贝进出、_rev 冲突检测、allDocs 前缀过滤 + 排序 */
function createMemoryDb() {
  const docs = new Map()
  const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)))
  return {
    get(id) {
      return docs.has(id) ? clone(docs.get(id)) : null
    },
    put(doc) {
      if (!doc || !doc._id) return { error: true, name: 'bad_request', message: 'missing _id' }
      const old = docs.get(doc._id)
      if (old) {
        if (doc._rev !== old._rev) return { error: true, name: 'conflict', message: 'rev mismatch' }
      } else if (doc._rev) {
        return { error: true, name: 'conflict', message: 'rev on new doc' }
      }
      const rev = `${(old ? Number(old._rev.split('-')[0]) : 0) + 1}-mem`
      const next = { ...clone(doc), _rev: rev }
      docs.set(doc._id, next)
      return { ok: true, id: doc._id, rev }
    },
    remove(doc) {
      if (!doc || !doc._id) return { error: true, name: 'bad_request', message: 'missing _id' }
      const old = docs.get(doc._id)
      if (!old) return { error: true, name: 'not_found', message: 'missing' }
      if (doc._rev !== old._rev) return { error: true, name: 'conflict', message: 'rev mismatch' }
      docs.delete(doc._id)
      return { ok: true, id: doc._id, rev: doc._rev }
    },
    allDocs(prefix) {
      return [...docs.keys()]
        .filter((id) => !prefix || id.startsWith(prefix))
        .sort()
        .map((id) => clone(docs.get(id)))
    },
  }
}

global.window = { ztools: { db: createMemoryDb() } }
const store = require(path.resolve(__dirname, '../store.js'))

section('1. 读写往返')
{
  ok(store.putDoc('int/1', { a: 1 }) === true, 'putDoc 写入成功')
  ok(store.getDoc('int/1') && store.getDoc('int/1').a === 1, 'getDoc 读回数据字段')
  ok(!!store.getDoc('int/1')._rev, 'getDoc 带回宿主 _rev')
  ok(store.getDoc('int/missing') === null, 'getDoc 不存在返回 null')
}

section('2. 副本语义(由宿主 db 提供,store 不再拷贝)')
{
  const doc = store.getDoc('int/1')
  doc.a = 999
  ok(store.getDoc('int/1').a === 1, '改 getDoc 的返回值不污染库')
}

section('3. 更新自动带上已有 _rev')
{
  const before = store.getDoc('int/1')._rev
  ok(store.putDoc('int/1', { a: 2 }) === true, 'putDoc 更新成功(自动续 _rev)')
  const after = store.getDoc('int/1')
  ok(after.a === 2, '更新后读到新值')
  ok(after._rev !== before, '更新后 _rev 递进', `${before} → ${after._rev}`)
}

section('4. putDocVerbose 透传宿主失败原因')
{
  const good = store.putDocVerbose('int/1', { a: 3 })
  ok(good.ok === true && good.reason === '', '成功时 ok:true 且 reason 为空', JSON.stringify(good))

  // 绕过 putDoc 的自动续 rev:直接让库里的 _rev 与 store 读到的不一致
  const raw = global.window.ztools.db
  raw.put({ _id: 'int/1', _rev: raw.get('int/1')._rev, a: 4 })
  const stale = { ...raw.get('int/1'), _rev: '0-stale' }
  const conflicted = raw.put(stale)
  ok(conflicted.error === true && conflicted.name === 'conflict', '内存 db 确实会判 conflict(前置条件)')

  const origGet = raw.get
  raw.get = (id) => (id === 'int/1' ? { ...origGet(id), _rev: '0-stale' } : origGet(id))
  const bad = store.putDocVerbose('int/1', { a: 5 })
  raw.get = origGet
  ok(bad.ok === false, '_rev 不匹配时 putDocVerbose 报失败')
  ok(/conflict/.test(bad.reason), '失败原因带上宿主的 conflict', bad.reason)
  ok(store.putDoc('int/1', { a: 6 }) === true, '冲突排除后写入恢复')
}

section('5. put 无返回值时的兜底')
{
  const raw = global.window.ztools.db
  const origPut = raw.put
  raw.put = () => undefined
  const res = store.putDocVerbose('int/2', { b: 1 })
  raw.put = origPut
  ok(res.ok === false && res.reason.length > 0, 'db.put 没返回结果时给出可读原因', JSON.stringify(res))
}

section('6. 前缀列举与删除')
{
  ok(store.putDoc('int/2', { b: 1 }) === true, '写入第二个文档')
  ok(store.listDocs('int/').length === 2, 'listDocs 按前缀列出', store.listDocs('int/').length)
  ok(store.listDocs('other/').length === 0, 'listDocs 无匹配返回空数组')
  ok(store.removeDoc('int/1') === true, 'removeDoc 删除成功')
  ok(store.removeDoc('int/1') === true, 'removeDoc 不存在视为成功')
  ok(store.getDoc('int/1') === null, '删除后读回 null')
  ok(store.getDoc('int/2').b === 1, '删除一个不影响另一个')
}

section('7. 方法面完整')
{
  for (const m of ['getDoc', 'putDoc', 'putDocVerbose', 'removeDoc', 'listDocs']) {
    ok(typeof store[m] === 'function', `导出 ${m}`)
  }
}

console.log(`\n通过 ${pass} 项`)
if (failures.length) {
  console.log('失败项:')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log('全部通过')
