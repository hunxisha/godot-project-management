// 桌面版 JSON 文档存储(desktop/preload/dbdoc.js)的语义测试。
//
// dbdoc 是 ZTools 宿主 db 的桌面替代,契约以 lib/store.js 与渲染层 bridge.ts 的用法为准:
// CouchDB 风格 _rev 冲突检测、get 返回副本、allDocs 前缀过滤排序、写穿持久化与损坏回滚。
// 契约错一条,「写了但没生效」「收藏静默丢失」这类问题就会在桌面版复现,
// 因此这里把 _rev 语义逐条钉死,并让 store.js 直连 dbdoc 跑一遍集成段。
//
// 用法:
//   node desktop/preload/__tests__/dbdoc.test.js
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createDb } = require(path.resolve(__dirname, '../dbdoc.js'))

let pass = 0
const failures = []
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log(`  PASS  ${label}`) }
  else { failures.push(label); console.log(`  FAIL  ${label}${extra !== undefined ? '  → ' + extra : ''}`) }
}
const section = (t) => console.log(`\n=== ${t} ===`)

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gpm-dbdoc-test-'))

const dbFile = () => path.join(tmpRoot, `db-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)

// ---------- 1. put/get 往返与副本语义 ----------
section('1. put/get 往返与副本语义')

{
  const db = createDb(dbFile())
  const res = db.put({ _id: 'a/1', v: 1, nested: { x: 1 } })
  ok(res.ok === true, '新建返回 ok')
  ok(typeof res.rev === 'string' && res.rev.length > 0, '新建返回 rev 字符串', JSON.stringify(res))

  const doc = db.get('a/1')
  ok(doc && doc.v === 1 && doc.nested.x === 1, 'get 读回数据字段')
  ok(doc._id === 'a/1' && doc._rev === res.rev, 'get 带回 _id/_rev')

  doc.v = 999
  doc.nested.x = 999
  ok(db.get('a/1').v === 1 && db.get('a/1').nested.x === 1, 'get 返回副本,外部修改不进库')

  ok(db.get('a/missing') === null, 'get 不存在返回 null')

  const bad = db.put({ v: 1 })
  ok(bad.error === true && bad.name === 'bad_request', '无 _id 拒绝', JSON.stringify(bad))
  const bad2 = db.put({ _id: '', v: 1 })
  ok(bad2.error === true && bad2.name === 'bad_request', '空 _id 拒绝')
}

// ---------- 2. _rev 冲突语义(CouchDB 风格) ----------
section('2. _rev 冲突语义')

{
  const db = createDb(dbFile())
  const first = db.put({ _id: 'r/1', v: 1 })

  const noRev = db.put({ _id: 'r/1', v: 2 })
  ok(noRev.error === true && noRev.name === 'conflict', '更新不带 _rev → conflict', JSON.stringify(noRev))

  const stale = db.put({ _id: 'r/1', _rev: 'rev-99999', v: 2 })
  ok(stale.error === true && stale.name === 'conflict', '过期 _rev → conflict')

  const second = db.put({ _id: 'r/1', _rev: first.rev, v: 2 })
  ok(second.ok === true && second.rev !== first.rev, '正确 _rev 更新成功且 rev 递进')
  ok(db.get('r/1').v === 2 && db.get('r/1')._rev === second.rev, '更新后数据与 rev 生效')

  const withRevNew = db.put({ _id: 'r/new', _rev: 'rev-1', v: 1 })
  ok(withRevNew.error === true && withRevNew.name === 'conflict', '新建携带 _rev → conflict')

  ok(first.rev !== second.rev, 'rev 单调不重复')

  // 调用方把整份文档展开回写时可能连带旧 _rev(store.js 的 putDoc 即此形态)
  const doc = db.get('r/1')
  const spread = db.put({ ...doc, v: 3 })
  ok(spread.ok === true && db.get('r/1').v === 3, '展开回写(带当前 _rev)成功')
}

// ---------- 3. remove 语义 ----------
section('3. remove 语义')

{
  const db = createDb(dbFile())
  const res = db.put({ _id: 'd/1', v: 1 })

  const stale = db.remove({ _id: 'd/1', _rev: 'rev-99999' })
  ok(stale.error === true && stale.name === 'conflict', '过期 _rev 删除 → conflict')

  const missing = db.remove({ _id: 'd/none', _rev: 'rev-1' })
  ok(missing.error === true && missing.name === 'not_found', '删除不存在的文档 → not_found')

  const gone = db.remove(db.get('d/1'))
  ok(gone.ok === true, '按当前文档删除成功')
  ok(db.get('d/1') === null, '删除后 get 为 null')

  const noId = db.remove({})
  ok(noId.error === true, '无 _id 删除报错')
}

// ---------- 4. allDocs 前缀与排序 ----------
section('4. allDocs 前缀与排序')

{
  const db = createDb(dbFile())
  db.put({ _id: 'godot/b/2', v: 1 })
  db.put({ _id: 'godot/a/1', v: 2 })
  db.put({ _id: 'other/c/3', v: 3 })

  const all = db.allDocs('')
  ok(all.length === 3, '空前缀列出全部')
  ok(all.map((d) => d._id).join(',') === 'godot/a/1,godot/b/2,other/c/3', '按 _id 排序')

  const part = db.allDocs('godot/')
  ok(part.length === 2 && part.every((d) => d._id.startsWith('godot/')), '前缀过滤')

  const none = db.allDocs('nope/')
  ok(Array.isArray(none) && none.length === 0, '无命中返回空数组')

  part[0].v = 999
  ok(db.get('godot/a/1').v === 2, 'allDocs 返回副本')

  const undef = db.allDocs(undefined)
  ok(undef.length === 3, 'undefined 前缀列出全部')
}

// ---------- 5. 持久化与 _rev 连续性 ----------
section('5. 持久化与 _rev 连续性')

{
  const file = dbFile()
  const db1 = createDb(file)
  const res = db1.put({ _id: 'p/1', v: 1 })
  db1.put({ _id: 'p/1', _rev: res.rev, v: 2 })
  const cur = db1.get('p/1')

  const db2 = createDb(file)
  ok(db2.get('p/1') && db2.get('p/1').v === 2, '重开库数据仍在')
  ok(db2.get('p/1')._rev === cur._rev, '_rev 跨进程保持一致')

  const next = db2.put({ _id: 'p/1', _rev: cur._rev, v: 3 })
  ok(next.ok === true, '重开库后用旧 rev 更新成功(非 conflict)')

  ok(!fs.existsSync(`${file}.tmp`), '写穿不留 .tmp 残留')
}

// ---------- 6. 损坏回滚 ----------
section('6. 损坏回滚')

{
  const file = dbFile()
  const db1 = createDb(file)
  db1.put({ _id: 'keep/1', v: 1 })
  db1.put({ _id: 'keep/2', v: 2 })

  fs.writeFileSync(file, '{corrupted!')
  const db2 = createDb(file)
  ok(db2.get('keep/1') !== null, '主文件损坏回滚 .bak(保留上一代)')
  // .bak 在每次写入前轮转,故只保住上一代:keep/2 写入后才进主文件,回滚丢失属设计取舍
  ok(db2.get('keep/2') === null, '回滚为上一代(最后一次写入不进 .bak)')
  ok(fs.existsSync(`${file}.corrupt`), '损坏主文件留档 .corrupt')
}

{
  const file = dbFile()
  const db1 = createDb(file)
  db1.put({ _id: 'x/1', v: 1 })

  fs.writeFileSync(file, '{bad')
  fs.writeFileSync(`${file}.bak`, '[[bad')
  const db2 = createDb(file)
  ok(db2.get('x/1') === null, '主备全坏 → 空库起步')
  ok(fs.existsSync(`${file}.corrupt`), '全坏仍留档 .corrupt')
}

{
  const file = dbFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = createDb(file)
  ok(db.get('any') === null, '全新路径直接空库可用')
}

// ---------- 7. store.js 集成(能力层直连 dbdoc) ----------
section('7. store.js 集成')

{
  const file = dbFile()
  global.window = { ztools: { db: createDb(file) } }
  const store = require(path.resolve(__dirname, '../../../src-ztools/preload/lib/store.js'))

  ok(store.putDoc('int/1', { a: 1 }) === true, 'putDoc 写入成功')
  ok(store.getDoc('int/1') && store.getDoc('int/1').a === 1, 'getDoc 读回')
  ok(!!store.getDoc('int/1')._rev, 'getDoc 带回 _rev')

  const verbose = store.putDocVerbose('int/1', { a: 2 })
  ok(verbose.ok === true && verbose.reason === '', 'putDocVerbose 成功路径')

  const realPut = global.window.ztools.db.put
  global.window.ztools.db.put = () => ({ error: true, name: 'conflict', message: 'Document update conflict' })
  const failed = store.putDocVerbose('int/1', { a: 3 })
  ok(failed.ok === false && /conflict/.test(failed.reason), 'putDocVerbose 失败路径带出宿主原因', JSON.stringify(failed))
  global.window.ztools.db.put = realPut

  store.putDoc('int/2', { b: 1 })
  ok(store.listDocs('int/').length === 2, 'listDocs 前缀列出')
  ok(store.removeDoc('int/1') === true, 'removeDoc 删除成功')
  ok(store.removeDoc('int/1') === true, 'removeDoc 不存在视为成功')
  ok(store.getDoc('int/1') === null, '删除后读回 null')

  const doc = store.getDoc('int/2')
  doc.b = 999
  ok(store.getDoc('int/2').b === 1, 'store.getDoc 副本语义(dbdoc 深拷贝兜底)')

  ok(typeof store.putDocVerbose === 'function', 'store.js 全量方法可用')
}

// ---------- 汇总 ----------
console.log(`\n${pass} passed, ${failures.length} failed`)
if (failures.length) {
  console.error('失败项:\n  - ' + failures.join('\n  - '))
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch (e) { /* 留下现场便于排查 */ }
  process.exit(1)
}
try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch (e) { /* 临时目录清理失败不影响结果 */ }
