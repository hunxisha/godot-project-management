// bridge.saveSettings 回归测试:设置必须**真的**写进宿主 db。
//
// 这条是用户报过的真机 bug:「在设置里配完 AI、关掉设置、再打开,配置就没了」。
// 成因有两类,这里各钉一条:
//   1. 把 Vue 的响应式代理直接交给宿主 db —— 跨边界克隆会抛错/丢字段;
//   2. 宿主把某次写入悄悄丢了(冲突、只读),而调用方毫不知情。
// 于是假宿主刻意用 structuredClone 模拟首类失败,并支持「丢弃某个键」模拟第二类。
//
// 用法:
//   node src/__tests__/settings.test.mjs
import { saveSettings, getSettings } from '../../.gpm-test/out/bridge.mjs'

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

// ---------- 假宿主 db ----------
const docs = new Map()
/** 写这些键时模拟宿主丢弃(不回 error,但内容不在) */
let dropKeys = []
let putCount = 0

const db = {
  get: (id) => docs.get(id) || null,
  put: (doc) => {
    putCount++
    // 宿主边界:结构化克隆。Proxy 在这里会抛 DataCloneError —— 正是真机的第一类失败
    const cloned = structuredClone(doc)
    if (cloned._id !== 'godot/settings') {
      docs.set(cloned._id, cloned)
      return { ok: true, id: cloned._id }
    }
    for (const k of dropKeys) delete cloned[k]
    const old = docs.get(cloned._id)
    docs.set(cloned._id, { ...cloned, _rev: ((old && old._rev) || 0) + 1 })
    return { ok: true, id: cloned._id }
  },
  remove: (doc) => { docs.delete(doc._id); return { ok: true } },
  allDocs: (prefix) => [...docs.values()].filter((d) => !prefix || String(d._id).startsWith(prefix))
}

globalThis.window = { ztools: { db } }

/** 造一个响应式代理,模拟 SettingsView 里 `reactive()` 交出来的对象 */
function reactive(obj) {
  return new Proxy(obj, {
    get(target, key, receiver) { return Reflect.get(target, key, receiver) },
    set(target, key, value, receiver) { return Reflect.set(target, key, value, receiver) }
  })
}

async function main() {
  section('1. 嵌套结构(translateProviders)能穿过宿主边界落库')
  {
    docs.clear()
    dropKeys = []
    const providers = reactive([
      reactive({ id: 'p1', kind: 'openai', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-x', model: 'deepseek-chat' })
    ])
    await saveSettings({ translateEnabled: true, translateProviders: providers })
    const back = docs.get('godot/settings')
    ok(!!back && Array.isArray(back.translateProviders), '文档里确实有 translateProviders', JSON.stringify(back && back.translateProviders))
    ok(back.translateProviders[0].model === 'deepseek-chat', '字段逐字落库', JSON.stringify(back.translateProviders[0]))
    ok(back.translateEnabled === true, '同批的开关也落库')
  }

  section('2. 重新读回:关掉设置页再打开能拿到配置')
  {
    const s = await getSettings()
    ok(Array.isArray(s.translateProviders) && s.translateProviders.length === 1, 'getSettings 读回服务商列表', JSON.stringify(s.translateProviders))
    ok(s.translateProviders[0].baseUrl === 'https://api.deepseek.com', '读回的不是空对象')
  }

  section('3. 宿主悄悄丢弃字段时必须报错,而不是静默成功')
  {
    docs.clear()
    dropKeys = ['translateProviders']
    let threw = ''
    try {
      await saveSettings({ translateProviders: [{ id: 'p2', kind: 'deepl', apiKey: 'k' }] })
    } catch (e) {
      threw = e.message
    }
    ok(/translateProviders/.test(threw), '错误里点名是哪个键没写进去', threw)
    ok(/没有写进数据库/.test(threw), '文案说清是「写入被丢弃」而不是普通异常', threw)
  }

  section('4. 正常保存不抛错,并返回合并后的完整设置')
  {
    docs.clear()
    dropKeys = []
    await saveSettings({ translateEnabled: false, translateTarget: 'zh-CN' })
    const s = await saveSettings({ translateTarget: 'en' })
    ok(s.translateTarget === 'en', '返回合并后的值', s.translateTarget)
    ok(s.defaultOpenAction === 'editor', '未改动的键沿用默认值(浅合并)', String(s.defaultOpenAction))
    const back = docs.get('godot/settings')
    ok(back.translateTarget === 'en' && back.translateEnabled === false, '两次写入都留在库里', JSON.stringify({ t: back.translateTarget, e: back.translateEnabled }))
    ok(putCount > 0, '确实走了宿主 db.put')
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
