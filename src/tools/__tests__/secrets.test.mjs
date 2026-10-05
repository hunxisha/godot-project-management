// 工具页 P2 #18 敏感信息扫描(src/tools/inspectors/secrets.ts)的断言。
//
// 与 secretPatterns.test.mjs 的分工:那边钉「形态识别与掩码」的纯函数规则,这边钉**检查器决定**:
// 扫哪些文件、定几级、结论里能不能出现原文、读不到与截断时怎么说人话。
// 形态表在解析层已经测透,这里的夹具只放最小可用的命中串,免得两份测试互相冒充覆盖。
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

const HAS = typeof T.runSecrets === 'function'
ok(HAS, 'runSecrets 已在打包产物里导出')
if (!HAS) {
  console.log('\n实现尚未落地,后续断言无法执行(这就是 RED 那一步)。')
  console.log(`\n${'='.repeat(56)}\nPASS ${pass}  FAIL ${failures.length}`)
  process.exit(1)
}

function extOf(rel) {
  const base = rel.slice(rel.lastIndexOf('/') + 1)
  const i = base.lastIndexOf('.')
  return i > 0 ? base.slice(i + 1).toLowerCase() : ''
}
function tree(specs) {
  const base = Date.UTC(2026, 0, 1)
  return specs.map(([rel, size, off = 0]) => ({ rel, size, mtimeMs: base + off * 86400000, ext: extOf(rel) }))
}
function makeCtx(specs, { trunc = false, texts = {}, fail = {} } = {}) {
  const calls = []
  const ctx = {
    projectId: 'godot/project/p', root: 'E:/proj', truncated: trunc, tree: tree(specs),
    readText: async (rel) => {
      calls.push(rel)
      if (Object.prototype.hasOwnProperty.call(fail, rel)) return fail[rel]
      return typeof texts[rel] === 'string' ? { text: texts[rel] } : { skipped: true }
    }
  }
  return { ctx, calls }
}

const AKIA = AWS_EXAMPLE
const PRIV = privKeyBlock('RSA', 'MIIEo' + 'wIBAAKCAQEAabc')
const errOf = (fs) => fs.filter((f) => f.severity === 'error')
const warnOf = (fs) => fs.filter((f) => f.severity === 'warn')
const tailOf = (fs) => fs.filter((f) => f.id === 'secrets:tail')
const truncOf = (fs) => fs.filter((f) => f.id === 'secrets:truncated')
const idsOf = (fs) => fs.map((f) => f.id).join('|')

section('1. 命中定级:厂商前缀与私钥块 error,关键词档 warn')
{
  const { ctx } = makeCtx(
    [['project.godot', 400], ['addons/pay.gd', 100], ['keys.pem', 200]],
    { texts: {
      'addons/pay.gd': `const AWS = "${AKIA}"`,
      'keys.pem': PRIV,
      'project.godot': 'application/config/api_key="7f3a9c2b1d8e4f6a0b5c9d2e1f8a3b7c"'
    } }
  )
  const fs = await T.runSecrets(ctx)
  ok(errOf(fs).length === 2, '前缀 + 私钥块各一条 error', idsOf(fs))
  ok(warnOf(fs).length === 1, '关键词档是 warn(变量名撞 token 的情况太多,不敢定死)', idsOf(fs))
  const e = errOf(fs)[0]
  ok(e.rel === 'addons/pay.gd' && e.title.includes('addons/pay.gd'), '标题带文件与行,用户能直接跳过去', e.title)
  ok(/轮换|吊销|revoke/i.test(e.detail), '处置建议讲的是换密钥,不是删这一行', e.detail)
}

section('2. 红线:任何一条结论都不带原文')
{
  const fs = await T.runSecrets(makeCtx(
    [['a.gd', 50], ['b.pem', 50]],
    { texts: { 'a.gd': `const K = "${AKIA}"`, 'b.pem': PRIV } }
  ).ctx)
  const blob = JSON.stringify(fs)
  ok(!blob.includes(AKIA), 'title/detail/related 里不许出现完整命中串', blob.slice(0, 120))
  ok(!blob.includes('MIIEowIBAAKCAQEAabc'), '私钥正文同样不外露', blob.slice(0, 120))
  ok(fs.every((f) => !new RegExp('BEGIN RSA PRI' + 'VATE KEY').test(f.title)), '标题里也不放形态原文', fs.map((f) => f.title).join('|'))
  const d = fs.find((f) => f.rel === 'a.gd').detail
  ok(/AKIA/.test(d) && /•|\*/.test(d), '掩码要看得出是哪一个(AKIA…••),但不给全串', d.slice(0, 100))
}

section('3. 扫描面:白名单 + 点文件 .env;.godot 与 .git 不读')
{
  const specs = [['project.godot', 400], ['x.gd', 10], ['Editor.cs', 10], ['cfg.json', 10], ['.env', 10],
    ['big.png', 10], ['.godot/leak.gd', 10], ['dlc/.gdignore', 1], ['dlc/y.gd', 10], ['.git/config', 10]]
  const { ctx, calls } = makeCtx(specs, { texts: { 'x.gd': `const A = "${AKIA}"` } })
  await T.runSecrets(ctx)
  ok(calls.includes('x.gd') && calls.includes('cfg.json'), '源码与配置读', calls.join(','))
  ok(calls.includes('Editor.cs'), 'C# 源码在读(白名单少一档就是少扫一片)', calls.join(','))
  ok(calls.includes('project.godot'), '引擎配置文件在读(ext 是 godot,不是 cfg)', calls.join(','))
  ok(calls.includes('.env'), '点文件 .env 也读(ext 判不出来,必须按 basename)', calls.join(','))
  ok(!calls.includes('big.png'), '二进制扩展不读', calls.join(','))
  ok(!calls.includes('.godot/leak.gd') && !calls.includes('.git/config'),
    '缓存与 VCS 目录不读(共用 isCache / isVcs 那把尺)', calls.join(','))
  ok(!calls.includes('dlc/y.gd'), '.gdignore 目录不读', calls.join(','))
}

section('4. 读不到文本时不说「没有泄漏」')
{
  const fs = await T.runSecrets(makeCtx(
    [['a.gd', 10], ['b.gd', 10]],
    { fail: { 'b.gd': { skipped: true } }, texts: { 'a.gd': `const A = "${AKIA}"` } }
  ).ctx)
  ok(fs.length === 1, '命中的那条照常出', idsOf(fs))
  ok(/读不到|未判定/.test(fs[0].detail), '但「有一份没读到」要说出口', fs[0].detail.slice(-120))

  const only = await T.runSecrets(makeCtx([['b.gd', 10]], { fail: { 'b.gd': { skipped: true } } }).ctx)
  ok(only.length === 1 && only[0].severity === 'info' && /读不到/.test(only[0].title),
    '一条命中都没有且有文件没读到时,出一份「没全读到」而不是空卡', idsOf(only))
}

section('5. 截断:照常判,另出一条覆盖面警示')
{
  const fs = await T.runSecrets(makeCtx([['a.gd', 10]], {
    trunc: true, texts: { 'a.gd': `const A = "${AKIA}"` }
  }).ctx)
  ok(errOf(fs).length === 1, '安全类工具截断时**继续判**(静默漏扫比误报更危险)', idsOf(fs))
  ok(truncOf(fs).length === 1 && truncOf(fs)[0].severity === 'warn', '另出一条「覆盖面不全」', idsOf(fs))
}

section('6. 刷屏上限:逐条列到 20,差额聚合一条')
{
  const many = []
  const texts = {}
  for (let i = 0; i < 25; i++) {
    const rel = `k${i}.gd`
    many.push([rel, 10])
    texts[rel] = `const K${i} = "${fakeAws('IOSFODNN7EXAMP' + String(i).padStart(2, '0'))}"`
  }
  const fs = await T.runSecrets(makeCtx(many, { texts }).ctx)
  const hits = fs.filter((f) => String(f.id).startsWith('secrets:'))
  const lines = hits.filter((f) => f.id !== 'secrets:tail')
  ok(lines.length === 20, '逐条最多列 20 行(刷屏控制)', lines.length)
  ok(tailOf(fs).length === 1 && tailOf(fs)[0].detail.includes('5'), '差额聚合成一条并给出少了几条', tailOf(fs)[0] && tailOf(fs)[0].detail)
  ok(tailOf(fs)[0].severity === 'info', '聚合条是 info,不是新的告警级', tailOf(fs)[0].severity)
}

section('7. 干净项目与红线')
{
  const clean = await T.runSecrets(makeCtx([['a.gd', 10]], {
    texts: { 'a.gd': 'extends Node\nfunc _ready():\n\tprint("hello")' }
  }).ctx)
  ok(Array.isArray(clean) && clean.length === 0, '没有命中时不发「一切正常」式的填充结论', idsOf(clean))

  const junk = await T.runSecrets({
    projectId: 'p', root: 'E:/x', truncated: false,
    tree: [{ rel: '', size: 1, mtimeMs: 0, ext: 'gd' }, null],
    readText: async () => ({ text: 42 })
  })
  ok(Array.isArray(junk), '畸形条目与非字符串 text 不抛', junk)

  const empty = await T.runSecrets({ projectId: 'p', root: 'E:/x', truncated: false, tree: [], readText: async () => ({}) })
  ok(Array.isArray(empty) && empty.length === 0, '空清单给空数组', empty)
}

console.log(`\n${'='.repeat(56)}\nPASS ${pass}  FAIL ${failures.length}`)
if (failures.length) { console.log('失败项:'); for (const f of failures) console.log('  - ' + f); process.exit(1) }
console.log('全部通过')
