// useTranslation 回归测试:「关掉翻译就该立刻回原文」。
//
// 用户报过的真机 bug:翻译成中文后点头部「原文」,卡片还是中文。
// 根因是读取文案时不看开关 —— 译文表里还留着译文,textOf 就直接把它返回了。
// 这条判据在界面上只有一次点击的距离,退化了也「看起来正常」,所以必须钉住。
//
// 用法:
//   node src/composables/__tests__/useTranslation.test.mjs
import { useTranslation } from '../../../.gpm-test/out/usetranslation.mjs'

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

// ---------- 假宿主 ----------
const docs = new Map()
const db = {
  get: (id) => docs.get(id) || null,
  put: (doc) => {
    // 和真宿主一样过一遍结构化克隆:响应式代理会在这一层炸(见 settings.test.mjs)
    const cloned = structuredClone(doc)
    const old = docs.get(cloned._id)
    docs.set(cloned._id, { ...cloned, _rev: ((old && old._rev) || 0) + 1 })
    return { ok: true, id: cloned._id }
  },
  remove: (doc) => { docs.delete(doc._id); return { ok: true } },
  allDocs: (prefix) => [...docs.values()].filter((d) => !prefix || String(d._id).startsWith(prefix))
}
/** 每次 translateParts 调用都记一笔,并在下一轮微任务里回译文 */
const calls = []
globalThis.window = {
  ztools: {
    db,
    showNotification: () => {}
  },
  services: {
    translateParts(payload) {
      calls.push(payload)
      return Promise.resolve({
        ok: true,
        items: payload.items.map((i) => ({ key: i.key, text: `译:${i.text}` })),
        failed: []
      })
    }
  }
}

function seedSettings(patch) {
  docs.set('godot/settings', { _id: 'godot/settings', _rev: 1, ...patch })
}

/** 等队列跑空(translate 是 fire-and-forget) */
async function settle(tr, ms = 400) {
  const started = Date.now()
  while (tr.busy.value && Date.now() - started < ms) {
    await new Promise((r) => setTimeout(r, 5))
  }
  // busy 由 ref 决定,再让一轮微任务把赋值落完
  await new Promise((r) => setTimeout(r, 5))
}

async function main() {
  seedSettings({
    translateEnabled: true,
    translateTarget: 'zh-CN',
    translateProviders: [{ id: 'p1', kind: 'openai', baseUrl: 'https://api.test/v1', model: 'm' }]
  })
  const tr = useTranslation()
  await tr.ensureSettings()

  section('1. 启用时显示译文')
  {
    tr.translate([{ key: 'card:p/s', text: 'Hello world', assetId: 'p/s', kind: 'desc' }], 'short')
    await settle(tr)
    ok(calls.length === 1, '发了一次请求', String(calls.length))
    ok(tr.textOf('card:p/s', 'Hello world') === '译:Hello world', 'textOf 返回译文', tr.textOf('card:p/s', 'Hello world'))
    ok(tr.hasText('card:p/s') === true, 'hasText 为真(卡片据此挂 hover 原文)')
  }

  section('2. 关掉翻译:同一份状态必须立刻回原文')
  {
    await tr.setEnabled(false)
    ok(tr.textOf('card:p/s', 'Hello world') === 'Hello world', '★关掉后 textOf 回原文(点「原文」没反应就是这个 bug)', tr.textOf('card:p/s', 'Hello world'))
    ok(tr.hasText('card:p/s') === false, 'hasText 同步变 false(hover 提示不该再说「原文:…」)')
    ok(tr.enabled.value === false, '开关状态为 false')
  }

  section('3. 再打开:译文还在,不用重新请求')
  {
    const before = calls.length
    await tr.setEnabled(true)
    ok(tr.textOf('card:p/s', 'Hello world') === '译:Hello world', '译文立刻回来(没有重新翻)', tr.textOf('card:p/s', 'Hello world'))
    ok(calls.length === before, '没有新增请求(缓存与译文表都还在)', String(calls.length))
  }

  section('4. 关掉后一个新请求都不发')
  {
    await tr.setEnabled(false)
    const before = calls.length
    tr.translate([{ key: 'card:p/t', text: 'Another item', assetId: 'p/t', kind: 'desc' }], 'short')
    await settle(tr)
    ok(calls.length === before, '★关掉后 translate() 直接返回,不发请求(显示层不看译文了,翻出来是纯烧额度)', `${calls.length} vs ${before}`)
    ok(tr.textOf('card:p/t', 'Another item') === 'Another item', '未翻译条目显示原文')
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
