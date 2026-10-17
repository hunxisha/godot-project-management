// transhtml.js 回归测试:HTML ↔ 文本节点的拆分与回填。
//
// 这条链路决定「富文本翻完还能不能看」:标签必须原样保留,文本节点必须按同一索引回填,
// 条目数不符必须整段放弃。任何一条退化(比如把 <code> 里的代码也送去翻)在界面上
// 都是「整块详细介绍变样」,手测很难定位。
//
// 用法:
//   node src-ztools/preload/lib/__tests__/transhtml.test.js
const path = require('node:path')

const LIB = path.resolve(__dirname, '..')
const html = require(path.join(LIB, 'transhtml.js'))

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
  section('1. 拆分:只挑可翻译文本节点')
  {
    const src = '<h2>Getting Started</h2><p>Hello world.</p>'
    const s = html.splitHtml(src)
    ok(s.texts.length === 2, '两个文本节点', JSON.stringify(s.texts))
    ok(s.texts[0] === 'Getting Started', '第一个是标题文本', s.texts[0])
    ok(s.texts[1] === 'Hello world.', '第二个是段落文本', s.texts[1])
    ok(s.tokens.filter((t) => t.type === 'tag').length === 4, '四个标签 token 原样保留', String(s.tokens.length))
  }

  section('2. 跳过:代码块 / 过短节点 / 纯符号')
  {
    const src = '<p>Intro</p><pre><code>var x = 1</code></pre><p>2</p><p>—</p>'
    const s = html.splitHtml(src)
    ok(s.texts.length === 1 && s.texts[0] === 'Intro',
      'code/pre 里的内容与过短节点都不送翻', JSON.stringify(s.texts))

    const s2 = html.splitHtml('<p><code>print("hi")</code></p>')
    ok(s2.texts.length === 0, '整段都是代码时没有可翻条目', JSON.stringify(s2.texts))
  }

  section('3. 回填:标签不变、文本替换、空白保留')
  {
    const src = '<p>  Hello  </p><ul><li>One</li><li>Two</li></ul>'
    const s = html.splitHtml(src)
    const merged = html.mergeHtml(s, ['你好', '一', '二'])
    ok(merged.ok === true, '回填成功', merged.error)
    ok(merged.html === '<p>  你好  </p><ul><li>一</li><li>二</li></ul>',
      '标签与首尾空白原样保留', merged.html)
  }

  section('4. 守卫:条目数不符 / 空译文')
  {
    const s = html.splitHtml('<p>Aaa</p><p>Bbb</p>')
    const bad = html.mergeHtml(s, ['只有一条'])
    ok(bad.ok === false && /条目数不符/.test(bad.error), '少一条 → ok:false(不半翻)', JSON.stringify(bad))

    const empty = html.mergeHtml(s, ['', '乙'])
    ok(empty.ok === true && empty.html.includes('Aaa'),
      '某条译文为空 → 该段保留原文,不把段落掏空', empty.html)
  }

  section('5. 一步到位:translateHtml')
  {
    const out = await html.translateHtml('<p>Hello</p><p>World</p>', async (texts) => texts.map((t) => `【${t}】`))
    ok(out.ok && out.html === '<p>【Hello】</p><p>【World】</p>', '透传译文并回填', out.html)

    const none = await html.translateHtml('<img src="a.png">', async () => [])
    ok(none.ok === true && none.skipped === true, '没有可翻文本时跳过,不算失败', JSON.stringify(none))

    const failed = await html.translateHtml('<p>Hello</p>', async () => { throw new Error('网络错误') })
    ok(failed.ok === false && failed.error === '网络错误', '翻译抛错时把原因带回', JSON.stringify(failed))
  }

  section('6. 边界:空串 / 纯文本(无标签)')
  {
    ok(html.splitHtml('').texts.length === 0, '空串没有节点')
    const plain = html.splitHtml('Just text here')
    ok(plain.texts.length === 1, '无标签时整段是一个文本节点', JSON.stringify(plain.texts))
    const back = html.mergeHtml(plain, ['只有文字'])
    ok(back.ok && back.html === '只有文字', '无标签也能回填', back.html)
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
