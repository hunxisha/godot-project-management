// transproviders.js 回归测试:三套请求体的形状、响应解析、服务商分工优先级。
//
// 这层最容易出的错是「字段名写错但请求还是发出去了」——服务端回 200 而解析出空数组,
// 表现是「翻译了但没内容」。所以这里同时钉构造(URL/头/body)与解析(条数/错误体)。
//
// 用法:
//   node src-ztools/preload/lib/__tests__/transproviders.test.js
const path = require('node:path')

const LIB = path.resolve(__dirname, '..')
const p = require(path.join(LIB, 'transproviders.js'))

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

async function main() {
  section('1. OpenAI 兼容:请求体')
  {
    const req = p.buildRequest(
      { kind: 'openai', baseUrl: 'https://api.deepseek.com/v1/', apiKey: 'sk-1', model: 'deepseek-chat' },
      ['Hello', 'World'],
      { target: 'zh-CN', terms: ['Godot'] }
    )
    ok(req.url === 'https://api.deepseek.com/v1/chat/completions', '拼出 /chat/completions(尾部斜杠不重复)', req.url)
    ok(req.headers.Authorization === 'Bearer sk-1', '带 Bearer 头', req.headers.Authorization)
    ok(req.body.model === 'deepseek-chat', '模型名透传', req.body.model)
    ok(req.body.messages.length === 2 && req.body.messages[0].role === 'system', '一条 system + 一条 user')
    const payload = JSON.parse(req.body.messages[1].content)
    ok(payload.items.length === 2 && payload.items[1].t === 'World', 'user 消息是 [{i,t}] 数组', req.body.messages[1].content)
    ok(/Godot/.test(req.body.messages[0].content), '不译词进了系统提示词')
    ok(req.body.response_format === undefined, '不发 response_format(本地推理端点不认)', JSON.stringify(req.body.response_format))
  }

  section('2. OpenAI 兼容:无 Key 的本地推理')
  {
    const req = p.buildRequest({ kind: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen' }, ['x'], {})
    ok(req.headers.Authorization === undefined, '空 Key 时不带 Authorization 头')
    ok(req.url === 'http://127.0.0.1:11434/v1/chat/completions', '本地端点照常拼地址', req.url)
  }

  section('3. DeepL:端点/目标语言/术语包裹')
  {
    const free = p.buildRequest({ kind: 'deepl', apiKey: 'k' }, ['Godot is great'], { target: 'zh-CN', terms: ['Godot'] })
    ok(free.url === 'https://api-free.deepl.com/v2/translate', '默认走免费端点', free.url)
    ok(free.body.target_lang === 'ZH-HANS', '中文目标语言映射为 ZH-HANS', free.body.target_lang)
    ok(free.body.text[0] === '<x>Godot</x> is great', '术语被 <x> 包裹', free.body.text[0])
    ok(free.body.tag_handling === 'xml' && free.body.ignore_tags[0] === 'x', '开了 xml 模式并忽略 x 标签')

    const pro = p.buildRequest({ kind: 'deepl', apiKey: 'k', plan: 'pro' }, ['hi'], { target: 'zh-TW' })
    ok(pro.url === 'https://api.deepl.com/v2/translate', 'pro 套餐走付费端点', pro.url)
    ok(pro.body.target_lang === 'ZH-HANT', '繁体映射为 ZH-HANT', pro.body.target_lang)
    ok(pro.body.tag_handling === undefined, '没用到词表时不发 tag_handling', JSON.stringify(pro.body))
  }

  section('4. Google:端点/批量上限/HTML 实体')
  {
    const req = p.buildRequest({ kind: 'google', apiKey: 'g-key' }, ['Hello'], { target: 'zh-CN' })
    ok(req.url.includes('translation.googleapis.com/language/translate/v2?key=g-key'), 'API Key 拼在查询串', req.url)
    ok(req.body.target === 'zh-CN', 'target 用 BCP-47', req.body.target)
    ok(p.batchLimit({ kind: 'google' }) === 10, 'Google 单批 ≤10', String(p.batchLimit({ kind: 'google' })))
    ok(p.batchLimit({ kind: 'deepl' }) === 50 && p.batchLimit({ kind: 'openai' }) === 20, 'DeepL 50 / AI 20')
  }

  section('5. 解析:三家的成功路径')
  {
    const ai = p.parseResponse('openai', { choices: [{ message: { content: '{"items":[{"i":0,"t":"你好"},{"i":1,"t":"世界"}]}' } }] }, 2)
    ok(ai.length === 2 && ai[0] === '你好', 'AI 的 JSON 被解开', JSON.stringify(ai))

    const fenced = p.parseResponse('openai', { choices: [{ message: { content: '好的,结果如下:\n```json\n[{"t":"一"},{"t":"二"}]\n```' } }] }, 2)
    ok(fenced.length === 2 && fenced[1] === '二', '围栏 + 客套话也能抠出数组', JSON.stringify(fenced))

    const deepl = p.parseResponse('deepl', { translations: [{ text: '<x>Godot</x> 很棒' }] }, 1)
    ok(deepl[0] === 'Godot 很棒', 'DeepL 的 <x> 包裹被去掉', deepl[0])

    const google = p.parseResponse('google', { data: { translations: [{ translatedText: '&quot;你好&quot;' }] } }, 1)
    ok(google[0] === '"你好"', 'Google 的 HTML 实体被还原', google[0])
  }

  section('6. 解析:失败与守卫')
  {
    let threw = ''
    try {
      p.parseResponse('openai', { choices: [{ message: { content: '[{"t":"只有一条"}]' } }] }, 3)
    } catch (e) { threw = e.message }
    ok(/条目数不符/.test(threw), '条数不符 → 抛错(绝不把少一条的结果回填)', threw)

    threw = ''
    try {
      p.parseResponse('google', { error: { message: 'API key not valid' } }, 1)
    } catch (e) { threw = e.message }
    ok(/密钥|API key not valid/.test(threw), '服务端错误体被翻成人话', threw)

    threw = ''
    try {
      p.parseResponse('openai', { choices: [{ message: { content: '我无法完成' } }] }, 1)
    } catch (e) { threw = e.message }
    ok(/没有返回可解析的 JSON/.test(threw), '模型不吐 JSON 时明确报错', threw)
  }

  section('7. 服务商分工:单服务商翻全部,多服务商按场景')
  {
    const ai = { id: 'a', kind: 'openai', baseUrl: 'https://x/v1', model: 'm' }
    const deepl = { id: 'd', kind: 'deepl', apiKey: 'k' }

    ok(p.order([ai], '', 'short').length === 1 && p.order([ai], '', 'short')[0] === ai,
      '只有一个服务商 → 短文本也用它')
    ok(p.order([ai, deepl], '', 'short')[0] === deepl, '短文本优先传统 MT', JSON.stringify(p.order([ai, deepl], '', 'short').map((x) => x.kind)))
    ok(p.order([ai, deepl], '', 'long')[0] === ai, '长文本优先 AI', JSON.stringify(p.order([ai, deepl], '', 'long').map((x) => x.kind)))
    ok(p.order([ai, deepl], 'a', 'long')[0] === ai, '显式默认服务商在该场景的偏好类里时优先它')
    ok(p.order([ai, deepl], '', 'long').length === 2, '返回的是回落链(两个都在)')

    const incomplete = { id: 'x', kind: 'openai', baseUrl: '' }
    ok(p.order([incomplete], '', 'short').length === 0, '缺 Base URL 的 AI 不可用,不进候选')
    ok(p.usable({ kind: 'openai', baseUrl: 'http://127.0.0.1:1234/v1' }) === true, '本地端点(无 Key)可用')
    ok(p.usable({ kind: 'deepl', apiKey: '' }) === false, 'DeepL 没 Key 不可用')
  }

  section('8. providerId 是缓存键的一部分')
  {
    ok(p.providerId({ kind: 'openai', model: 'deepseek-chat' }) === 'openai:deepseek-chat', 'AI 带模型名')
    ok(p.providerId({ kind: 'deepl' }) === 'deepl:', 'DeepL 无模型段')
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
