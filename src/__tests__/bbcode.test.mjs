// BBCode → token 解析(src/utils/bbcode.ts)的回归测试(经 vite 打包后在 Node 里跑)。
//
// 关键约束:未知标签必须按字面文本保留(内容永不丢失,策划书 5.2 节的降级原则);
// code/codeblock 内部不解析任何标签;ref 标签指向的 target 原样保留(渲染层据此跳转)。
//
// 用法(npm script 会先跑打包步骤):
//   npm run test:renderer
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BUNDLE = path.resolve(__dirname, '../../.gpm-test/out/bbcode.mjs')

if (!existsSync(BUNDLE)) {
  console.error(`找不到打包产物: ${BUNDLE}`)
  console.error('请先运行: node src/composables/__tests__/build-bundle.mjs')
  process.exit(2)
}

const { tokenizeBBCode, bbToPlainText } = await import(pathToFileURL(BUNDLE).href)

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
/** 找第一个指定类型 token */
const first = (tokens, t) => tokens.find((x) => x.t === t)
const types = (tokens) => tokens.map((x) => x.t).join(',')

section('文本与样式')
const plain = tokenizeBBCode('所有场景对象的基类。')
ok(plain.length === 1 && plain[0].t === 'text' && plain[0].v === '所有场景对象的基类。', '纯文本原样')

const bold = tokenizeBBCode('节点是 [b]Godot[/b] 的基本单元')
ok(types(bold) === 'text,style,text', 'b 标签切分样式段', types(bold))
ok(bold[1].style === 'bold' && bold[1].children[0].v === 'Godot', 'b 内容进 children')

const nest = tokenizeBBCode('[b]x [i]y[/i][/b]')
const inner = first(nest, 'style')
ok(inner && inner.children.length === 2 && inner.children[1].t === 'style' && inner.children[1].style === 'italic', '样式可嵌套')

const center = tokenizeBBCode('[center]标题[/center]')
ok(first(center, 'style')?.style === 'center', 'center 作为独立样式')

section('站内引用')
ok(first(tokenizeBBCode('[method add_child]'), 'ref')?.target === 'add_child', '[method] 解析')
const dotted = tokenizeBBCode('[method Node.add_child]')
ok(first(dotted, 'ref')?.kind === 'method' && first(dotted, 'ref').target === 'Node.add_child', '[method Class.method] 保留点号')
ok(first(tokenizeBBCode('[member owner]'), 'ref')?.kind === 'member', '[member] 解析')
ok(first(tokenizeBBCode('[constant NOTIFICATION_READY]'), 'ref')?.kind === 'constant', '[constant] 解析')
ok(first(tokenizeBBCode('[signal ready]'), 'ref')?.kind === 'signal', '[signal] 解析')
ok(first(tokenizeBBCode('[enum ProcessMode]'), 'ref')?.kind === 'enum', '[enum] 解析')
ok(first(tokenizeBBCode('[param node]'), 'ref')?.kind === 'param', '[param] 解析')
ok(first(tokenizeBBCode('[SceneTree]'), 'ref')?.kind === 'class' && first(tokenizeBBCode('[SceneTree]'), 'ref').target === 'SceneTree', '裸类名 → class 引用')
ok(first(tokenizeBBCode('[@GlobalScope]'), 'ref')?.target === '@GlobalScope', '[@GlobalScope] → class 引用')

section('代码与链接')
const code = tokenizeBBCode('[code]x = [b]1[/b][/code]')
ok(code.length === 1 && code[0].t === 'code' && code[0].v === 'x = [b]1[/b]', 'code 内部不解析')
const block = tokenizeBBCode('[codeblock]\nif true:\n    print(1)\n[/codeblock]\nafter')
ok(first(block, 'codeblock')?.v.includes('\n    print(1)'), 'codeblock 保留换行与缩进')
ok(types(block) === 'codeblock,text', 'codeblock 后的文本继续解析', types(block))

const u1 = tokenizeBBCode('[url=https://docs.a.b]教程[/url]')
ok(u1.length === 1 && u1[0].t === 'url' && u1[0].href === 'https://docs.a.b' && u1[0].label === '教程', '[url=] 带标签')
const u2 = tokenizeBBCode('[url]https://a.b[/url]')
ok(u2[0].t === 'url' && u2[0].href === u2[0].label, '[url] 裸地址')

ok(first(tokenizeBBCode('行一[br]行二'), 'br')?.t === 'br', '[br] → 换行 token')

section('降级原则(内容永不丢失)')
const unknown = tokenizeBBCode('前面 [foo bar] 后面')
ok(unknown.some((x) => x.t === 'text' && x.v.includes('[foo bar]')), '未知标签按字面保留', JSON.stringify(unknown))
const orphan = tokenizeBBCode('a [/b] c')
ok(orphan.some((x) => x.t === 'text' && x.v.includes('[/b]')), '孤立闭合按字面保留')
const unclosed = tokenizeBBCode('加粗 [b]没有闭合')
ok(unclosed.some((x) => x.t === 'text' && x.v.includes('[b]没有闭合')), '未闭合样式标签字面保留')
ok(bbToPlainText(tokenizeBBCode('[b]加粗[/b] 与 [code]代码[/code]')) === '加粗 与 代码', '纯文本提取剥标签')

section('真实样例(实测 extension_api.json 描述)')
const real = tokenizeBBCode(
  'Called when the node enters the [SceneTree] (e.g. upon instantiating, scene changing, or after calling [method add_child] in a script).'
)
const refs = real.filter((x) => x.t === 'ref')
ok(refs.length === 2 && refs[0].target === 'SceneTree' && refs[1].target === 'add_child', '真实句子的两处引用', JSON.stringify(refs))
const bb = tokenizeBBCode('This notification is received [i]before[/i] the related [signal tree_entered] signal.')
ok(bb.some((x) => x.t === 'style' && x.style === 'italic') && bb.some((x) => x.t === 'ref' && x.target === 'tree_entered'), '斜体与信号引用混合')

console.log(`\n${pass} passed, ${failures.length} failed`)
if (failures.length) {
  console.log('FAILURES:')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
