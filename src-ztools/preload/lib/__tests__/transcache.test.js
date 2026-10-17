// transcache.js 回归测试:文档结构、命中规则、合并写入、统计与清空。
//
// 缓存是「省钱」与「不串台」的交点:命中的判据错一个字段,用户改完商店描述
// 仍然看到旧译文,或者切了服务商仍拿到上一个引擎的结果。这里把这两个方向都钉住。
//
// 用法:
//   node src-ztools/preload/lib/__tests__/transcache.test.js
const path = require('node:path')

const LIB = path.resolve(__dirname, '..')

// ---------- 假宿主 db(store.js 在调用时才访问 window.ztools.db) ----------
const docs = new Map()
const db = {
  get: (id) => docs.get(id) || null,
  put: (doc) => {
    const old = docs.get(doc._id)
    docs.set(doc._id, { ...doc, _rev: ((old && old._rev) || 0) + 1 })
    return { ok: true, id: doc._id }
  },
  remove: (doc) => {
    docs.delete(doc._id)
    return { ok: true }
  },
  allDocs: (prefix) => [...docs.values()].filter((d) => !prefix || String(d._id).startsWith(prefix))
}
global.window = { ztools: { db } }

const cache = require(path.join(LIB, 'transcache.js'))

let pass = 0
const failures = []
function ok(cond, label, extra) {
  if (cond) {
    pass++
    console.log(`  PASS  ${label}`)
  } else {
    failures.push(label)
    console.log(`  FAIL ${label}${extra !== undefined ? '  → ' + extra : ''}`)
  }
}
function section(t) {
  console.log(`\n=== ${t} ===`)
}

function reset() {
  docs.clear()
  cache.clear()
}

async function main() {
  section('1. 文档 id:assetId 里的斜杠不留在 id 里')
  {
    reset()
    const id = cache.docId('publisher/slug')
    ok(!id.includes('publisher/'), '斜杠被编码', id)
    ok(id.startsWith('godot/trans/'), '前缀正确', id)
    ok(cache.assetIdOf(id) === 'publisher/slug', '可无损还原', cache.assetIdOf(id))
  }

  section('2. 写入与命中')
  {
    reset()
    const hash = cache.hashText('Hello world')
    cache.upsert('p/s', [{ kind: 'desc', lang: 'zh-CN', provider: 'openai:m', srcHash: hash, text: '你好世界' }])
    const entries = cache.readEntries('p/s')
    ok(entries.length === 1 && entries[0].text === '你好世界', '条目落库', JSON.stringify(entries))

    const hit = cache.matchEntry(entries, { kind: 'desc', lang: 'zh-CN', provider: 'openai:m', srcHash: hash })
    ok(hit === '你好世界', '键完全一致才命中', String(hit))

    ok(cache.matchEntry(entries, { kind: 'desc', lang: 'zh-CN', provider: 'deepl:', srcHash: hash }) === null,
      '换服务商不命中(否则切到 AI 却拿到旧引擎的译文)')
    ok(cache.matchEntry(entries, { kind: 'desc', lang: 'zh-CN', provider: 'openai:m', srcHash: cache.hashText('Hello world!') }) === null,
      '原文变了不命中(商店改了描述自动失效)')
    ok(cache.matchEntry(entries, { kind: 'html', lang: 'zh-CN', provider: 'openai:m', srcHash: hash }) === null,
      'kind 不同不命中(简介与详细介绍不互相覆盖)')
    ok(cache.matchEntry(entries, { kind: 'desc', lang: 'en', provider: 'openai:m', srcHash: hash }) === null,
      '换目标语言不命中')
  }

  section('3. 合并写入与去重')
  {
    reset()
    const h1 = cache.hashText('a')
    const h2 = cache.hashText('b')
    cache.upsert('p/s', [{ kind: 'desc', lang: 'zh-CN', provider: 'openai:m', srcHash: h1, text: '甲' }])
    cache.upsert('p/s', [
      { kind: 'desc', lang: 'zh-CN', provider: 'openai:m', srcHash: h1, text: '甲(改)' },
      { kind: 'desc', lang: 'zh-CN', provider: 'openai:m', srcHash: h2, text: '乙' }
    ])
    const entries = cache.readEntries('p/s')
    ok(entries.length === 2, '同键覆盖、新键追加', String(entries.length))
    ok(entries.find((e) => e.srcHash === h1).text === '甲(改)', '同键取最新值')
    ok(cache.upsert('p/s', []) === false, '空列表不写库')
  }

  section('4. 统计与清空')
  {
    reset()
    cache.upsert('a/1', [{ kind: 'desc', lang: 'zh-CN', provider: 'deepl:', srcHash: 'h', text: '甲' }])
    cache.upsert('a/2', [{ kind: 'desc', lang: 'zh-CN', provider: 'deepl:', srcHash: 'h', text: '乙' }])
    const st = cache.stats()
    ok(st.count === 2 && st.entries === 2, '统计条数与段数', JSON.stringify(st))
    ok(st.sizeBytes > 0, '体积是正数', String(st.sizeBytes))

    const cleared = cache.clear()
    ok(cleared.ok === true && cleared.removed === 2, '清空返回删除数', JSON.stringify(cleared))
    ok(cache.stats().count === 0, '清空后确实没了')
  }

  section('5. 结构坏掉的缓存当没有')
  {
    reset()
    docs.set(cache.docId('bad/one'), { _id: cache.docId('bad/one'), entries: 'not-an-array' })
    ok(cache.readEntries('bad/one').length === 0, 'entries 不是数组时返回空,不让界面报错')
    docs.set(cache.docId('bad/two'), { _id: cache.docId('bad/two'), entries: [{ text: 123 }] })
    ok(cache.readEntries('bad/two').length === 0, 'text 不是字符串的条目被过滤')
  }

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
  console.error(e)
  process.exit(1)
})
