// 文档签名着色(src/utils/docSig.ts)的回归测试(经 vite 打包后在 Node 里跑)。
//
// 两条硬约束:
//   1. 只上色、不改字:token 的 v 按序拼接 === 纯文本签名(和 highlight 同一条不变量)。
//   2. 角色只许落在代码块已有的 12 个 .tok-* 上,避免写出一个没有颜色的 class。
//
// 用法:npm run test:renderer(会先打包)
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BUNDLE = path.resolve(__dirname, '../../.gpm-test/out/docsig.mjs')

if (!existsSync(BUNDLE)) {
  console.error(`找不到打包产物: ${BUNDLE}`)
  console.error('请先运行: node src/composables/__tests__/build-bundle.mjs')
  process.exit(2)
}

const {
  sigText, typeTokens, methodText, methodTokens, signalText, signalTokens,
  memberTokens, enumHeaderTokens, enumValueTokens, constantTokens,
  operatorText, operatorTokens, paramListText
} = await import(pathToFileURL(BUNDLE).href)

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

const ROLES = new Set(['', 'kw', 'cf', 'tyb', 'tye', 'tyu', 'fn', 'mem', 'str', 'num', 'com', 'doc', 'sym'])
const roleOf = (tokens, v) => tokens.find((t) => t.v === v)?.c

function rolesOk(tokens, label) {
  const bad = tokens.filter((t) => !ROLES.has(t.c)).map((t) => `${t.v}:${t.c}`)
  ok(bad.length === 0, `${label} 角色都在 12 个 .tok-* 内`, bad.join(', '))
}

section('类型串:上色且字符不丢')
const curve = typeTokens('enum::Curve.TangentMode')
ok(sigText(curve) === 'enum::Curve.TangentMode', 'enum:: 前缀原样保留', sigText(curve))
ok(roleOf(curve, 'enum') === 'kw', 'enum:: 的 enum 是关键字')
ok(roleOf(curve, 'Curve') === 'tye', 'Curve 是引擎类型')
ok(roleOf(curve, 'TangentMode') === 'tyu', '枚举名 TangentMode 是具名类型')
ok(roleOf(curve, '::') === 'sym' && roleOf(curve, '.') === 'sym', ':: 和 . 是标点')

const arr = typeTokens('Array[int]')
ok(sigText(arr) === 'Array[int]', 'Array[int] 字符不丢', sigText(arr))
ok(roleOf(arr, 'Array') === 'tyb' && roleOf(arr, 'int') === 'tyb', 'Array / int 是基础类型')

const dict = typeTokens('Dictionary[String, Variant]')
ok(sigText(dict) === 'Dictionary[String, Variant]', '泛型逗号空格原样', sigText(dict))
ok(roleOf(dict, 'String') === 'tyb' && roleOf(dict, 'Variant') === 'tyb', 'String / Variant 是基础类型')

const nested = typeTokens('Array[Array[Vector2]]')
ok(sigText(nested) === 'Array[Array[Vector2]]', '嵌套泛型字符不丢', sigText(nested))
ok(roleOf(nested, 'Vector2') === 'tye', 'Vector2 是引擎类型')

ok(sigText(typeTokens('bitfield::MouseButtonMask')) === 'bitfield::MouseButtonMask', 'bitfield:: 原样')
ok(sigText(typeTokens('typedarray::Node')) === 'typedarray::Node', 'typedarray:: 原样')
ok(sigText(typeTokens('void')) === 'void' && typeTokens('void')[0].c === 'tyb', 'void 当基础类型,不是关键字黄')
ok(sigText(typeTokens('MyNode')) === 'MyNode' && typeTokens('MyNode')[0].c === 'tyu', '未知大写类型是用户类型')
ok(sigText(typeTokens('')) === '', '空类型得到空 token')
rolesOk(curve, '类型')

section('方法')
const method = {
  name: 'add_point',
  returnType: 'void',
  qualifiers: ['const'],
  params: [
    { name: 'position', type: 'Vector2' },
    { name: 'left_tangent', type: 'float', defaultValue: '0' },
    { name: 'left_mode', type: 'enum::Curve.TangentMode', defaultValue: '0' }
  ]
}
const mTok = methodTokens(method)
ok(sigText(mTok) === methodText(method), '方法 token 拼接 === methodText', sigText(mTok))
ok(methodText(method) === 'add_point(position: Vector2, left_tangent: float = 0, left_mode: enum::Curve.TangentMode = 0) -> void', '方法纯文本与旧展示一致')
ok(mTok[0].c === 'fn' && mTok[0].b === true && mTok[0].v === 'add_point', '方法名是加粗的 fn')
ok(roleOf(mTok, 'position') === '', '参数名保持正文色,不和类型抢')
ok(roleOf(mTok, 'Vector2') === 'tye', '参数类型 Vector2 上色')
ok(roleOf(mTok, 'float') === 'tyb', 'float 是基础类型')
ok(mTok.some((t) => t.c === 'num' && t.v === '0'), '默认值 0 是数字')
ok(roleOf(mTok, 'void') === 'tyb', '返回值 void 按类型上色')
ok(!sigText(mTok).includes('const'), '限定词不进方法正文(模板单独画)')
rolesOk(mTok, '方法')

const bare = { name: 'clear', returnType: 'void', params: [] }
ok(sigText(methodTokens(bare)) === 'clear() -> void', '无参方法')
ok(paramListText([], false) === '', '空参数列表')

section('信号 / 成员 / 枚举 / 常量 / 运算符')
const sig = { name: 'range_changed', params: [{ name: 'from', type: 'float' }, { name: 'to', type: 'float' }] }
const sTok = signalTokens(sig)
ok(sigText(sTok) === signalText(sig), '信号 token 拼接 === signalText', sigText(sTok))
ok(signalText(sig) === 'signal range_changed(from: float, to: float)', '信号不带默认值')
ok(sTok[0].c === 'kw' && sTok[0].v === 'signal', 'signal 是关键字')
ok(sTok.some((t) => t.c === 'fn' && t.b && t.v === 'range_changed'), '信号名是加粗的 fn')

const mem = memberTokens({ type: 'Vector2', name: 'point_count', defaultValue: 'Vector2(0, 0)' })
ok(sigText(mem) === 'Vector2 point_count = Vector2(0, 0)', '成员纯文本', sigText(mem))
ok(roleOf(mem, 'point_count') === 'mem' && mem.find((t) => t.v === 'point_count').b, '成员名是加粗的 mem')
ok(mem.some((t) => t.c === 'tye' && t.v === 'Vector2'), '成员类型与默认构造都按引擎类型上色')

const noDef = memberTokens({ type: 'int', name: 'count' })
ok(sigText(noDef) === 'int count', '无默认值的成员不多一个等号')

const head = enumHeaderTokens({ name: 'TangentMode' })
ok(sigText(head) === 'enum TangentMode', '枚举头')
ok(head[0].c === 'kw' && head.some((t) => t.b && t.v === 'TangentMode'), 'enum 关键字 + 加粗枚举名')

const ev = enumValueTokens({ name: 'TANGENT_FREE', value: '0' })
ok(sigText(ev) === 'TANGENT_FREE = 0', '枚举值')
ok(ev.some((t) => t.c === 'num' && t.v === '0'), '枚举值的数字上色')

const cst = constantTokens({ name: 'NOTIFICATION_READY', value: '10' })
ok(sigText(cst) === 'const NOTIFICATION_READY = 10', '常量')
ok(cst[0].c === 'kw' && cst.some((t) => t.b && t.c === 'tyu' && t.v === 'NOTIFICATION_READY'), '常量名是加粗的具名符号')

const op = { name: '+', returnType: 'Vector2', params: [{ name: 'right', type: 'Vector2' }] }
ok(sigText(operatorTokens(op)) === operatorText(op), '运算符 token 拼接 === operatorText')
ok(operatorText(op) === '+(right: Vector2) -> Vector2', '运算符纯文本与旧展示一致')
ok(operatorTokens({ name: '', returnType: 'bool', params: [] })[0].v === 'op', '空运算符名回退 op')

const strDef = methodTokens({
  name: 'set_name',
  returnType: 'void',
  params: [{ name: 'p', type: 'String', defaultValue: '"hi"' }]
})
ok(sigText(strDef) === 'set_name(p: String = "hi") -> void', '字符串默认值字符不丢', sigText(strDef))
ok(strDef.some((t) => t.c === 'str' && t.v === '"hi"'), '字符串默认值上色')

section('渲染侧真的用上了着色')
const panel = readFileSync(path.resolve(__dirname, '../components/docs/DocClassPanel.vue'), 'utf8')
const code = panel.replace(/<!--[\s\S]*?-->/g, '')
ok(code.includes('<DocSig'), '类详情面板渲染 DocSig')
ok(!code.includes('{{ signature('), '方法签名不再整段插值')
ok(code.includes('methodTokens') && code.includes('memberTokens') && code.includes('signalTokens'), '方法/成员/信号都走 token')
ok(code.includes('k-\' + it.kind') || code.includes("k-' + it.kind"), '目录按种类上色')

console.log(`\n${pass} passed, ${failures.length} failed`)
if (failures.length) {
  process.exit(1)
}
