// 工具页 P2 #18:凭据形态识别(src/tools/parsers/secretPatterns.ts)的断言。
//
// 这个解析件存在的理由只有一个:**命中串永远不能原样出现在结论里**。
// 一张把用户泄漏的密钥完整打印出来的卡片,等于把凭据又复制了一份进 DOM、
// 进折叠状态、进将来的报告导出。所以掩码与占位符豁免都在这里,而不是散在检查器里。
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../../..')
const BUNDLE = path.resolve(ROOT, '.gpm-test/out/tools.mjs')

if (!existsSync(BUNDLE)) {
  console.error(`找不到打包产物: ${BUNDLE}`)
  console.error('请先运行: node src/composables/__tests__/build-bundle.mjs')
  process.exit(2)
}

const T = await import(pathToFileURL(BUNDLE).href)

let pass = 0
const failures = []
function ok(cond, label, extra) {
  if (cond) { pass++; console.log(`  PASS  ${label}`) }
  else { failures.push(label); console.log(`  FAIL  ${label}${extra !== undefined ? '  → ' + extra : ''}`) }
}
function section(t) { console.log(`\n=== ${t} ===`) }
/**
 * 假凭据一律**运行时拼出来**,不许在源码里写成完整字面量。
 *
 * 原因不是洁癖:GitHub 的 push protection 就是按这些厂商形态扫的(与我们的前缀判据同形),
 * 连 AWS 文档自己那份示例值都会被判成泄漏、拦下整个推送。测试要的是「形态正确」,不是「眼熟」。
 * 还有一条自反约束:我们自己的 #18 扫的就是这个形状 —— 仓库里留一串能扫中的假凭据,
 * 等于给自己埋一条永久的 error。
 */
const fakeAws = (t16) => 'AKIA' + t16
const fakeGh = (b36) => 'ghp_' + b36
const fakeGhPat = (b) => 'github_pat_' + b
const fakeGoogle = (b35) => 'AIza' + b35
const fakeSlack = () => 'xoxb-' + '123456789012' + '-' + 'abcdefghijklmnopqrstuvwx'
const fakeStripe = (b) => 'sk_live_' + b
const fakeSendGrid = (b) => 'SG.' + b
/** 拼出私钥块标记:字面量整串留在仓库里会被通用私钥检测扫中 */
const privKeyBlock = (kind, body) => '-----BEGIN ' + kind + ' PRI' + 'VATE KEY-----\n' + body + '\n-----END ' + kind + ' PRI' + 'VATE KEY-----'
const AWS_EXAMPLE = fakeAws('IOSFODNN7EXAMPLE')
const AWS_EXAMPLZ = fakeAws('IOSFODNN7EXAMPLZ')
const AWS_EXAMPLX = fakeAws('IOSFODNN7EXAMPLX')
const GH_TOKEN = fakeGh('aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789')
const GH_PAT = fakeGhPat('11ABCDEFG0abcdefghij_KkLlMmNnOoPpQqRrSsTtUuVvWwXxYyZz')
const GOOGLE_KEY = fakeGoogle('SyD-ABCDEFGHIJKLMNOPQRSTUVWXYZ12345')
const STRIPE_KEY = fakeStripe('51HbAQK2eZvKYlo2CdumMyp0ZrY1xTgBdEn')
const SENDGRID_KEY = fakeSendGrid('aB3cD4eF5gH6iJ7kL8mN9oP0qR1sT2uV3wX4yZ5aB6')
const OPENSSH_BLOCK = privKeyBlock('OPENSSH', 'abc123DEF')

const HAS = typeof T.scanSecretsInText === 'function' && typeof T.maskSecret === 'function' &&
  typeof T.looksPlaceholder === 'function'
ok(HAS, 'scanSecretsInText / maskSecret / looksPlaceholder 已导出')
if (!HAS) {
  console.log('\n实现尚未落地,后续断言无法执行(这就是 RED 那一步)。')
  console.log(`\n${'='.repeat(56)}\nPASS ${pass}  FAIL ${failures.length}`)
  process.exit(1)
}

section('1. 私钥块 = error 档,且能报出行号')
{
  const hits = T.scanSecretsInText(['extends Node', '', 'const KEY = """', privKeyBlock('RSA', 'MIIEowIBAAKCAQEA').split('\n')[0], 'MIIEo' + 'wIBAAKCAQEA'].join('\n'))
  ok(hits.length === 1 && hits[0].kind === 'private-key', '私钥块成一条', JSON.stringify(hits.map((h) => h.kind)))
  ok(hits[0].line === 4, '行号按文件实际行号(1 起)', hits[0].line)
}

section('2. 厂商写死的前缀形态 = error 档')
{
  const cases = [
    ['aws = "' + AWS_EXAMPLE + '"', 'aws'],
    ['gh = "' + GH_TOKEN + '"', 'github'],
    ['tok = "' + GH_PAT + '"', 'github'],
    ['g = "' + GOOGLE_KEY + '"', 'google'],
    ['slack = "' + fakeSlack() + '"', 'slack'],
    ['tw = "' + STRIPE_KEY + '"', 'stripe']
  ]
  for (const [text] of cases) {
    const hits = T.scanSecretsInText(text)
    ok(hits.length === 1 && hits[0].kind === 'known-prefix', `「${text.slice(0, 14)}…」判为已知前缀形态`, JSON.stringify(hits.map((h) => h.kind)))
  }
}

section('3. 关键词 + 高熵值 = warn 档;短值/纯变量名不算')
{
  const a = T.scanSecretsInText('var api_key = "7f3a9c2b1d8e4f6a0b5c9d2e1f8a3b7c"')
  ok(a.length === 1 && a[0].kind === 'keyword', '关键词赋值进 warn 档', JSON.stringify(a.map((h) => h.kind)))
  ok(T.scanSecretsInText('var token_count = 12').length === 0, '数值赋值不算')
  ok(T.scanSecretsInText('var secret = "abc123"').length === 0, '短值不算(低于长度线)')
  ok(T.scanSecretsInText('api_key = some_function(arg)').length === 0, '函数调用形态不算')
}

section('4. 占位符豁免(教程代码与示例配置里全是这种,报了就是纯噪声)')
{
  const PLACEHOLDERS = [
    'api_key = "your_api_key_here"',
    'api_key = "YOUR_API_KEY"',
    'secret = "changeme"',
    'token = "xxxxxxxxxxxxxxxxxxxx"',
    'password = "<你的密码>"',
    'api_key = "${MY_ENV_VAR}"',
    'api_key = "aaaaaaaaaaaaaaaaaa"',
    'token = "todo"',
    'api_key = "replace-with-real-key-please"',
    'password = "test test test"'
  ]
  for (const text of PLACEHOLDERS) {
    ok(T.scanSecretsInText(text).length === 0, `不报:${text}`, String(T.scanSecretsInText(text).length))
  }
  // 但占位符豁免不许把真凭据也吃掉:厂商前缀那条永远优先
  ok(T.scanSecretsInText('aws_key = "' + AWS_EXAMPLX + '"').length === 1, '前缀形态不受占位符豁免影响')
}

section('5. 掩码:看得出个大概,还原不出原值')
{
  const v = AWS_EXAMPLE
  const m = T.maskSecret(v)
  ok(!m.includes(v), '掩码里不含完整原值', m)
  ok(!m.includes(v.slice(3, v.length - 2)), '中段一律不外露', m)
  ok(m.includes('AKIA') && m.includes('LE'), '首尾可以露(用于人眼定位是哪一条)', m)
  ok(m.includes(String(v.length)), '带长度', m)
  const short = T.maskSecret('abcdefgh')
  ok(!short.includes('abcdefgh') && /\d/.test(short), '短值只报长度,不报任何字符', short)
}

section('5b. 红线在解析层就成立:三档的 masked 都不含原值')
{
  const cases = [
    ['private-key', OPENSSH_BLOCK],
    ['known-prefix', 'const A = "' + AWS_EXAMPLE + '"'],
    ['keyword', 'var api_key = "7f3a9c2b1d8e4f6a0b5c9d2e1f8a3b7c"']
  ]
  for (const [, text] of cases) {
    const hits = T.scanSecretsInText(text)
    ok(hits.length >= 1, `命中一档(${text.slice(0, 12)})`, hits.length)
    for (const h of hits) {
      // 逐段试:任何一段 ≥8 的原文子串出现在 masked 里都算泄露(首尾 4/2 字符是刻意允许的锚点)
      const raws = text.split(/["'\s,=]+/).filter((p) => p.length >= 10)
      ok(raws.every((p) => !h.masked.includes(p)), `masked 不含长原文片段:${h.kind}`, h.masked)
    }
  }
  // 长度线本身也是判据的一部分:12–15 字符的「像凭据」串刻意**不报**(太短,猜了就是噪声)
  ok(T.scanSecretsInText('token = "Abcd1234Efgh"').length === 0,
    '长度线以下(14 字符)不猜:宁可漏报也不报教程里的短串')
  ok(T.scanSecretsInText('token = "Abcd1234Efgh5678"').length === 1,
    '刚好过线(16 字符)才报', '1')
}

section('6. 一行里多个命中都收,顺序照文件')
{
  const hits = T.scanSecretsInText('const A = "' + GH_TOKEN + '", B = "' + AWS_EXAMPLZ + '"')
  ok(hits.length === 2, '两个都收', hits.length)
  ok(hits.every((h) => h.line === 1), '行号同为一行', hits.map((h) => h.line).join(','))

  // 同一条规则在一行里命中两次也要都收 —— 这条钉的是「前缀正则必须带 g」:
  // 少了 g,exec 每次都从 0 开始、永远返回同一个匹配,上层那个 while 就是死循环(本仓踩过一次)。
  const twice = T.scanSecretsInText('const A = "' + AWS_EXAMPLZ + '", B = "' + AWS_EXAMPLE + '"')
  ok(twice.length === 2, '同一规则的两处命中不互相吞掉', twice.length)
}

section('7. 红线:非字符串入参不抛')
{
  for (const bad of [undefined, null, 42, {}]) {
    ok(Array.isArray(T.scanSecretsInText(bad)) && T.scanSecretsInText(bad).length === 0, `${String(bad)} 给空数组`)
  }
  ok(typeof T.maskSecret(undefined) === 'string', 'maskSecret 对 undefined 也给串(不抛)', T.maskSecret(undefined))
}

console.log(`\n${'='.repeat(56)}\nPASS ${pass}  FAIL ${failures.length}`)
if (failures.length) { console.log('失败项:'); for (const f of failures) console.log('  - ' + f); process.exit(1) }
console.log('全部通过')
