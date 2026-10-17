// translate.js 回归测试:编排层的四条主干 —— 未启用 / 没服务商 / 命中缓存不重复请求 /
// 富文本回填 / 服务商回落 / 401 后暂停。
//
// 这一层手测最贵:真要验一条就得配一个 Key、等一次网络、再数一遍钱。
// 这里把 http 换成可编程的假通道,store 走内存假 db,于是每条判定都是确定的。
//
// 用法:
//   node src-ztools/preload/lib/__tests__/translate.test.js
const path = require('node:path')
const Module = require('node:module')

const LIB = path.resolve(__dirname, '..')

// ---------- 假宿主 db ----------
const docs = new Map()
global.window = {
  ztools: {
    db: {
      get: (id) => docs.get(id) || null,
      put: (doc) => {
        const old = docs.get(doc._id)
        docs.set(doc._id, { ...doc, _rev: ((old && old._rev) || 0) + 1 })
        return { ok: true, id: doc._id }
      },
      remove: (doc) => { docs.delete(doc._id); return { ok: true } },
      allDocs: (prefix) => [...docs.values()].filter((d) => !prefix || String(d._id).startsWith(prefix))
    }
  }
}

// ---------- 假 http(必须在 require translate.js 之前注入) ----------
const calls = []
let responder = () => ({ choices: [{ message: { content: '{"items":[]}' } }] })
const fakeHttp = {
  postJson(url, body) {
    calls.push({ url, body })
    return Promise.resolve(responder(url, body))
  }
}
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  const file = (parent && parent.filename) || ''
  if (/translate\.js$/.test(file) && request === './http') return fakeHttp
  return origLoad.apply(this, arguments)
}

const translate = require(path.join(LIB, 'translate.js'))

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

/** 写设置文档(每次整体覆盖,避免上一条用例的残留) */
function settings(patch) {
  docs.set('godot/settings', { _id: 'godot/settings', ...patch })
}

/** AI 形状的应答:把每条 t 前加「译:」 */
function aiEcho(prefix = '译:') {
  return (url, body) => {
    const items = JSON.parse(body.messages[1].content).items
    return { choices: [{ message: { content: JSON.stringify({ items: items.map((it) => ({ i: it.i, t: prefix + it.t })) }) } }] }
  }
}

const OPENAI = { id: 'a', kind: 'openai', baseUrl: 'https://api.test/v1', apiKey: 'sk', model: 'm' }
const DEEPL = { id: 'd', kind: 'deepl', apiKey: 'dk' }

function reset() {
  docs.clear()
  calls.length = 0
  translate.resetSuspend()
}

async function main() {
  section('1. 前置闸:未启用 / 没服务商')
  {
    reset()
    settings({ translateEnabled: false, translateProviders: [OPENAI] })
    const r = await translate.translateParts({ items: [{ key: 'k1', text: 'Hello' }] })
    ok(r.ok === false && r.error === '翻译未启用', '未启用时不开网络,直接回明确原因', JSON.stringify(r.error))
    ok(calls.length === 0, '未启用时一次请求都没发')

    reset()
    settings({ translateEnabled: true, translateProviders: [] })
    const r2 = await translate.translateParts({ items: [{ key: 'k1', text: 'Hello' }] })
    ok(r2.ok === false && r2.noProvider === true, '没配服务商时标 noProvider(界面据此引导去设置)', JSON.stringify(r2))
    ok(/设置/.test(r2.error || ''), '错误文案指向设置页', r2.error)
  }

  section('2. 正常路径:请求 → 回填 → 落缓存')
  {
    reset()
    settings({ translateEnabled: true, translateProviders: [OPENAI] })
    responder = aiEcho()
    const r = await translate.translateParts({
      items: [
        { key: 'k1', text: 'Hello', assetId: 'p/s', kind: 'desc' },
        { key: 'k2', text: 'World', assetId: 'p/s', kind: 'desc' }
      ]
    })
    ok(r.ok === true && r.items.length === 2, '两条都回填', JSON.stringify(r.items))
    ok(r.items[0].text === '译:Hello', '译文按 key 回填', r.items[0].text)
    ok(calls.length === 1, '两条合成一次请求(不是两次)', String(calls.length))
    ok(docs.has('godot/trans/' + encodeURIComponent('p/s')), '缓存文档已写入')
  }

  section('3. 缓存命中:第二次不再发请求')
  {
    const before = calls.length
    const r = await translate.translateParts({
      items: [{ key: 'k1', text: 'Hello', assetId: 'p/s', kind: 'desc' }]
    })
    ok(r.ok === true && r.items[0].text === '译:Hello', '命中缓存拿到同一译文', JSON.stringify(r.items))
    ok(calls.length === before, '没有新增请求', `${calls.length} vs ${before}`)
  }

  section('4. 富文本:标签原样保留,文本被替换')
  {
    reset()
    settings({ translateEnabled: true, translateProviders: [OPENAI] })
    responder = aiEcho('')
    const src = '<h2>Intro</h2><p>Hello</p><pre><code>keep()</code></pre>'
    const r = await translate.translateParts({
      items: [{ key: 'body', text: src, assetId: 'p/s', kind: 'html' }]
    })
    ok(r.ok === true, '回填成功', JSON.stringify(r))
    ok(r.items[0].text === '<h2>Intro</h2><p>Hello</p><pre><code>keep()</code></pre>',
      '译文与原文相同(echo 前缀为空)→ 结构逐字一致', r.items[0].text)
    const sent = JSON.parse(calls[0].body.messages[1].content).items.map((x) => x.t)
    ok(!sent.includes('keep()'), '代码块内容没有送翻', JSON.stringify(sent))
  }

  section('5. 服务商回落:第一个失败换第二个')
  {
    reset()
    // 短文本场景默认先 DeepL;让它抛非致命错误,应回落到 AI
    settings({ translateEnabled: true, translateProviders: [DEEPL, OPENAI] })
    let n = 0
    responder = (url, body) => {
      n++
      if (String(url).includes('deepl')) throw new Error('HTTP 500: upstream')
      return aiEcho()(url, body)
    }
    const r = await translate.translateParts({ scene: 'short', items: [{ key: 'k1', text: 'Hello', assetId: 'p/s' }] })
    ok(r.ok === true && r.items[0].text === '译:Hello', '第一个失败后由第二个服务商完成', JSON.stringify(r.items))
    ok(n >= 2, '确实尝试了两家', String(n))
    ok(r.items.length === 1 && r.failed.length === 0, '不算失败,不挂角标')
  }

  section('6. 401:暂停后续翻译')
  {
    reset()
    settings({ translateEnabled: true, translateProviders: [OPENAI] })
    responder = () => {
      const e = new Error('HTTP 401: unauthorized')
      e.status = 401
      throw e
    }
    const r = await translate.translateParts({ items: [{ key: 'k1', text: 'Hello', assetId: 'p/s' }] })
    ok(r.ok === false && r.paused === true, '密钥错 → paused', JSON.stringify({ ok: r.ok, paused: r.paused }))
    ok(/暂停/.test(r.error || ''), '文案说清是暂停而不是普通失败', r.error)

    const before = calls.length
    const r2 = await translate.translateParts({ items: [{ key: 'k2', text: 'Another', assetId: 'p/s' }] })
    ok(r2.paused === true && calls.length === before, '暂停期内不再发请求(不重复烧钱)', String(calls.length))

    // 改设置(换 Key)后自动恢复
    settings({ translateEnabled: true, translateProviders: [{ ...OPENAI, apiKey: 'sk-new' }] })
    responder = aiEcho()
    const r3 = await translate.translateParts({ items: [{ key: 'k3', text: 'Third', assetId: 'p/s' }] })
    ok(r3.ok === true, '改完设置自动解除暂停', JSON.stringify(r3.items))
  }

  section('7. 测试连接')
  {
    reset()
    responder = aiEcho()
    const r = await translate.testTranslateProvider({ kind: 'openai', baseUrl: 'https://api.test/v1', apiKey: 'sk', model: 'm' })
    ok(r.ok === true && typeof r.ms === 'number' && /译:/.test(r.sample || ''), '成功时回耗时与试译', JSON.stringify(r))

    const bad = await translate.testTranslateProvider({ kind: 'deepl', apiKey: '' })
    ok(bad.ok === false && /API Key/.test(bad.error || ''), '配置不全时直接说缺什么', bad.error)
  }

  section('8. 缓存统计与清空')
  {
    reset()
    settings({ translateEnabled: true, translateProviders: [OPENAI] })
    responder = aiEcho()
    await translate.translateParts({ items: [{ key: 'k1', text: 'Hello', assetId: 'p/s' }] })
    const info = translate.translateCacheInfo()
    ok(info.count === 1 && info.entries === 1, '统计到一条资产一段译文', JSON.stringify(info))
    const cleared = translate.translateCacheClear()
    ok(cleared.ok === true && cleared.removed === 1, '清空成功', JSON.stringify(cleared))
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
