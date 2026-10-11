// 工具箱 · 第 1 批 Task 10:骨架生成器(src/toolkit/scaffold.ts)的断言(A-17 / Q19 / Q34 / §D #16)。
//
// A-17 说「目录里出现**能直接跑**的插件」。这一份用两种力度去钉:
//   · 弱的(文本级):模板注释里那三条契约与 §6 R-1 的权限面句子必须逐字在场;
//   · 强的(执行级):把生成的 index.js 真的按 ES 模块 import 进来,再看
//     action 的 schema/plan 与 view 的 view 是不是导出了、plan 跑出来的 Change 形状对不对。
//     这不是「假加载器」(Q33 禁的是拿假加载器冒充真链路):真实执行方式就是
//     「把这段 ESM 文本交给 JS 引擎」,这里只是让 Node 用 .mjs 干同一件事。
//     为的是把「模板与校验器/loader 形状漂移」这类只有真机才能发现的问题,提前到测试里炸。
//
// 用法:node src/composables/__tests__/build-bundle.mjs && node src/toolkit/__tests__/scaffold.test.mjs
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../../..')
const BUNDLE = path.resolve(ROOT, '.gpm-test/out/tkscaffold.mjs')

function exists(p) { try { readFileSync(p); return true } catch { return false } }
if (!exists(BUNDLE)) {
  console.error(`找不到打包产物: ${BUNDLE}`)
  console.error('请先运行: node src/composables/__tests__/build-bundle.mjs')
  process.exit(2)
}

const T = await import(pathToFileURL(BUNDLE).href)

let pass = 0
const failures = []
function ok(cond, label, extra) {
  if (cond) { pass++; console.log(`  PASS  ${label}`) }
  else { failures.push(label); console.log(`  FAIL  ${label}${extra !== undefined ? '  → ' + JSON.stringify(extra) : ''}`) }
}
function section(t) { console.log(`\n=== ${t} ===`) }
const F = (x) => (x && typeof x === 'object' ? x : {})
const FA = (x) => (Array.isArray(x) ? x : [])
const S = (x) => (typeof x === 'string' ? x : '')
const P = (arr, i) => F(FA(arr)[i])

/** §6 R-1 缓解①:这段话是验收项 A-12 要求逐字出现的,测试里也照逐字对(漂移就红) */
const R1_TEXT = '插件能读写你的 Godot 项目文件、能调用 ZTools 的全部宿主 API，并可以通过宿主 API 进一步提权。它拿不到裸 Node，但这不构成安全边界。只装你信任的。'

const BUILD = (input, existing) => T.buildSkeleton(input, FA(existing))
const FILES = (r) => FA(F(r).files)
const TEXT = (r, rel) => { const f = FILES(r).find((x) => F(x).rel === rel); return S(F(f).text) }
const MAN = (r) => F(P(FILES(r), 0))
/** manifest 的文本(第一个文件永远是 manifest.json);写成 MT(r) 会拿到 undefined —— 那是第 6 次栽在同一类误用上 */
const MT = (r) => S(MAN(r).text)
/** 解析 manifest:产物不完整时给空对象,而不是让 JSON.parse 把整个套件撞停(变异取证要的是红数,不是崩溃) */
const MF = (r) => { try { return JSON.parse(MT(r) || '{}') } catch { return {} } }
const ACTION = (over) => ({ kind: 'action', id: 'demo-tool', ...(over || {}) })
const VIEW = (over) => ({ kind: 'view', id: 'demo-view', ...(over || {}) })

section('0. 导出面')
for (const n of ['SCAFFOLD_KINDS', 'MANIFEST_FILE', 'ENTRY_FILE', 'README_FILE', 'PERMISSION_TEXT', 'idConflictReason', 'buildSkeleton']) {
  ok(T[n] !== undefined, `${n} 已在打包产物里导出`)
}

section('1. 产物就是三个文件,名字与约定一致')
{
  const r = BUILD(ACTION(), [])
  ok(F(r).ok === true, '最简入参就能生成(只给 kind 与 id)', F(r).errors)
  ok(FILES(r).map((f) => F(f).rel).join(',') === 'manifest.json,index.js,README.md', '三个文件的相对路径是裸名(正斜杠)', FILES(r).map((f) => F(f).rel))
  ok(T.MANIFEST_FILE === 'manifest.json' && T.ENTRY_FILE === 'index.js' && T.README_FILE === 'README.md', '常量与产物同源(`toolplugins.js:35` 也认这个名字)')
  ok(F(r).dirName === 'demo-tool', '目录名 = id(§5.1)', F(r).dirName)
  ok(MT(r).startsWith('{'), 'manifest 是 JSON 文本', MT(r).slice(0, 12))
  const back = MF(r)
  ok(back.id === 'demo-tool' && back.apiVersion === 1 && back.kind === 'action' && back.entry === 'index.js',
    'JSON 往返后与校验结果一致(模板没有「文本一套、对象一套」)', { id: back.id, api: back.apiVersion })
  ok(back.status === 'dev', '新骨架默认 status:dev(README 与提示语承诺的就是这一档)', back.status)
  ok(!('unsafe' in back), 'unsafe 不写(默认 false):骨架不该一上来就讨裸写接口', Object.keys(back))
}

section('2. 三种「拒绝生成」,每条都直接可显示')
{
  const kinds = [{}, { kind: '' }, { kind: 'Action' }, { kind: 'both' }, { kind: 42 }, { kind: null }, undefined]
  for (const input of kinds) {
    const r = BUILD(input, [])
    ok(F(r).ok === false && FA(F(r).errors).length === 1 && FA(F(r).errors).join('|').includes('action / view'),
      `kind 坏值(${JSON.stringify(input && F(input).kind) ?? 'undefined'})⇒ 只说这一条`, F(r).errors)
  }
  const noId = BUILD({ kind: 'action' }, [])
  ok(F(noId).ok === false, '没给 id ⇒ 不生成(目录名与 store 前缀都按它)', F(noId).errors)
  ok(FA(F(noId).errors).length > 0, '原因不止一条也行,但必须说得出', FA(F(noId).errors).length)
  const badId = BUILD(ACTION({ id: 'Bad ID' }), [])
  ok(F(badId).ok === false && S(FA(F(badId).errors).join('|')).includes('id'), 'id 不合法 ⇒ 由校验器点名(manifest 的 ID_RE),措辞不另写', F(badId).errors)
  const dotdot = BUILD(ACTION({ id: '..' }), [])
  ok(F(dotdot).ok === false, '「..」这种目录名形态进不来(首字符强制字母或数字)', F(dotdot).errors)
}

section('3. id 冲突:内置单独点名、目录撞名也拒、大小写不敏感')
{
  const builtin = [{ id: 'gdscript-format', dirName: 'gdscript-format', name: 'GDScript 代码格式化', source: 'builtin' }]
  const r = BUILD({ kind: 'action', id: 'gdscript-format' }, builtin)
  ok(F(r).ok === false, '与内置工具抢 id ⇒ 拒', F(r).errors)
  ok(S(FA(F(r).errors).join('|')).includes('先注册者保留'), '要说清为什么抢不得(loader.byId 保留先注册者 ⇒ 用户的插件会悄悄消失)', F(r).errors)
  ok(S(FA(F(r).errors).join('|')).includes('GDScript 代码格式化'), '点名被谁占了')
  const user = [{ id: 'other', dirName: 'other', name: '别人的工具' }]
  const r2 = BUILD({ kind: 'action', id: 'other' }, user)
  ok(F(r2).ok === false && S(FA(F(r2).errors).join('|')).includes('卸载'), '与用户插件撞 id ⇒ 给「先卸载那个」这条路', F(r2).errors)
  const ghost = [{ id: '', dirName: 'half-broken', name: '' }]
  const r3 = BUILD({ kind: 'action', id: 'half-broken' }, ghost)
  ok(F(r3).ok === false && S(FA(F(r3).errors).join('|')).includes('读不出 id'),
    '目录存在但那份 manifest 连 id 都读不出 ⇒ 照样占名(否则用户会以为目录是空的)', F(r3).errors)
  const casey = BUILD({ kind: 'action', id: 'My-Tool' }, [{ dirName: 'MY-TOOL' }])
  ok(F(casey).ok === false, '大小写不同也算撞目录(Windows 目录不区分大小写)', F(casey).errors)
  ok(FA(F(casey).errors).join('|').includes('撞名'),
    '拒的理由必须是「撞目录」而不是「id 不合法」:后者只证明大写进不了 ID_RE,证明不了这条判据在场', F(casey).errors)
  ok(S(T.idConflictReason('DEMO', [{ id: 'demo' }])).includes('占用'), '比对时两侧都抹平大小写(用户给的那侧也要)')
  ok(T.idConflictReason('a', []) === '', '没有已有插件 ⇒ 无冲突')
  ok(T.idConflictReason('', [{ id: '' }]) === '', '空 id 不在这里报(交给 manifest 校验器说)', T.idConflictReason('', [{ id: '' }]))
  ok(T.idConflictReason(undefined, [null, 42, 'x']) === '', '脏 existing 元素不抛', T.idConflictReason(undefined, [null, 42, 'x']))
  ok(S(T.idConflictReason('demo', [{ id: 'demo', source: 'builtin', name: 'B' }])).includes('内置工具'), '内置那档的措辞在 reason 里就有')
  ok(S(T.idConflictReason('demo', [{ id: 'DEMO' }])).includes('demo'), '比对前双方都小写(报出来的是用户给的那个 id)')
}

section('4. 自检承重:模板产出的 manifest 必须过自己的校验器')
{
  const cases = [
    ['cmds 空数组', { cmds: [] }, /cmds 不能是空数组/],
    ['cmds 里有空串', { cmds: ['ok', '  '] }, /cmds 第 2 项/],
    ['能力名框架不认', { capabilities: ['tree', 'god-mode'] }, /不认的能力「god-mode」/],
    ['能力重复', { capabilities: ['tree', 'tree'] }, /重复/],
    ['tags 不是数组', { tags: 'demo' }, /tags 必须是字符串数组/],
    ['tags 里有空串', { tags: ['a', ''] }, /tags 第 2 项/]
  ]
  for (const [name, over, re] of cases) {
    const r = BUILD(ACTION(over), [])
    ok(F(r).ok === false, `${name} ⇒ 拒绝生成`, F(r).errors)
    ok(re.test(FA(F(r).errors).join('|')), `${name} ⇒ 原因由校验器给(措辞与拒载那行同一份)`, F(r).errors)
  }
  const ok2 = BUILD(VIEW({ capabilities: ['tree', 'text', 'ui', 'store'] }), [])
  ok(F(ok2).ok === true, '合法的能力集照样过', F(ok2).errors)
  const dv = BUILD(ACTION({ version: '   ', name: '  ', summary: '  ' }), [])
  ok(F(dv).ok === true, '空白字段不拒生成(那是表单默认值那一档,不是猜用户意图)', F(dv).errors)
  const dm = MF(dv)
  ok(dm.version === '0.1.0' && dm.name === 'demo-tool' && S(dm.summary).includes('请改这句'),
    '空白 ⇒ 退回模板默认值,且默认值本身过得了校验', { v: dm.version, n: dm.name })
}

section('5. action 模板:导出形状与三段式的用法')
{
  const r = BUILD(ACTION(), [])
  const js = TEXT(r, 'index.js')
  ok(/^\s*export const schema = \[/m.test(js), '导出 schema(ui:\'schema\' 必须有,loader.checkModuleShape 就这么查)')
  ok(/^\s*export async function plan/m.test(js), '导出 plan(ctx, files, params)')
  ok(/\/\/\s*export async function apply/.test(js), 'apply 以注释形态给出(正文放 payload.text 时不需要它)')
  ok(!/^\s*export async function apply/m.test(js), '没被注释掉的 apply 不许存在(两个真源)')
  ok(js.includes('payload: { text: next }') || js.includes('payload: {text: next}'), 'plan 把新正文放进 payload.text ⇒ 预览阶段就有 diff')
  ok(js.includes('ctx.cancelled'), '循环里查取消(§F 契约补充第 3 条)')
  ok(js.includes('kind: \'rewrite\'') && js.includes("risk: 'low'") && js.includes('reason:'), '每条 Change 带 kind/risk/reason(框架的措辞靠它们)')
  ok(js.includes('rel:'), '用 rel 不用绝对路径')
  ok(js.includes("type: 'files'"), 'schema 里有 files 字段(选中集的唯一真源)')
  ok(js.includes('exts'), 'files 字段声明了后缀 ⇒ 「挑了 .gd 的工具拿不到 png」这条由 schema 层保证')
  const mf = MF(r)
  ok(mf.ui === 'schema' && mf.kind === 'action', 'action 可以 ui:schema(§5.2)')
  ok(FA(mf.capabilities).join(',') === 'tree,text,write', '默认能力:读树、读文本、经框架写盘', mf.capabilities)
  ok(S(FA(mf.cmds)[0]) === 'demo-tool', '默认关键词取 id', mf.cmds)
  ok(S(mf.summary).includes('请改这句'), 'summary 留一句「改我」而不是编一个功能说明', mf.summary)
}

section('6. view 模板:render 型只能用框架给的 vue')
{
  const r = BUILD(VIEW(), [])
  const js = TEXT(r, 'index.js')
  ok(/^\s*export function view/m.test(js), "kind:'view' 必须导出 view(ctx, files)")
  // ⚠ 契约头注释里四种导出名都出现过,所以「有没有导出」只能按**未被注释的那一行**判
  ok(!/^\s*export async function plan/m.test(js), 'view 型不导出 plan(它不走三段式)', js.split('\n').filter((l) => /^\s*export/.test(l)))
  ok(js.includes('ctx.vue'), '渲染函数从 ctx.vue 拿 h(§5.3:框架把 vue 的 h/ref/computed/onMounted 交给 render 型)')
  ok(js.includes('onMounted'), '局部状态用 ctx.vue.ref/onMounted,不假装有自己的构建')
  const mf = MF(r)
  ok(mf.ui === 'render', 'view 的 ui 恒为 render(§5.2)', mf.ui)
  ok(FA(mf.capabilities).includes('ui'), '声明 ui 能力,否则 ctx.notify 会被框架忽略', mf.capabilities)
  ok(!/^\s*export const schema/m.test(js), 'render 型不给 schema(DEV-5:schema 只在 ui:schema 时必填)', js.split('\n').filter((l) => /^\s*export/.test(l)))
}

section('7. 权限面文案:逐字在场,且不许出现「已沙箱」式暗示(§D #16 / R-1③)')
{
  ok(T.PERMISSION_TEXT === R1_TEXT, '导出的那句与 §6 R-1 缓解①逐字相同', T.PERMISSION_TEXT)
  for (const kind of ['action', 'view']) {
    const r = BUILD({ kind, id: `p-${kind}` }, [])
    const js = TEXT(r, 'index.js')
    const md = TEXT(r, 'README.md')
    ok(js.includes(R1_TEXT), `${kind} 的 index.js 注释里有那句逐字文案`)
    ok(md.includes(R1_TEXT), `${kind} 的 README 里有那句逐字文案`)
    ok(md.includes('框架挡不住恶意插件'), `${kind} 的 README 不许把话说圆(不是免责声明,是事实)`)
    for (const banned of ['已沙箱', '安全沙箱', '沙箱环境', '隔离运行', 'sandboxed', 'isolated']) {
      ok(!js.includes(banned) && !md.includes(banned), `${kind} 的模板里不出现暗示性措辞「${banned}」`)
    }
    // R-1③ 禁的是「暗示」而不是这两个词本身(「这里没有沙箱」是必须说的话),所以按**行**判:
    // 任何含「沙箱/隔离」的行必须同时带否定词,否则就是把你正在暗示它安全。
    for (const [where, text] of [['index.js', js], ['README.md', md]]) {
      const bad = text.split('\n').filter((l) => /(沙箱|隔离)/.test(l) && !/(不|别|没|非|假|挡不住)/.test(l))
      ok(bad.length === 0, `${kind} 的 ${where} 里每一句「沙箱/隔离」都在否定式里`, bad.slice(0, 2))
    }
  }
  {
    const md = TEXT(BUILD(ACTION(), []), 'README.md')
    ok(md.includes('别把它当沙箱'), '「沙箱」二字只允许出现在否定式里', md.split('\n').filter((l) => l.includes('沙箱'))[0])
  }
}

section('8. 契约三条(§F 纯契约补充)必须写进模板与 README')
{
  const js = TEXT(BUILD(ACTION(), []), 'index.js')
  const md = TEXT(BUILD(ACTION(), []), 'README.md')
  ok(js.includes('稳定键') && js.includes('时间戳') && js.includes('数组序号'), '第 1 条:Change.id 不许含时间戳/序号')
  ok(js.includes('scanTree') && /不许.*猜|不要.*猜/.test(js), '第 2 条:files 由框架给,不许自己 scanTree 猜')
  ok(js.includes('ctx.onCancel') || js.includes('onCancel'), '第 3 条:取消回调 API 被点名')
  ok(js.includes('已取消'), '第 3 条的固定原因串在场')
  for (const t of ['稳定键', 'files', 'cancelled']) ok(md.includes(t), `README 复述了「${t}」这一条`)
  ok(js.includes('apiVersion'), '模板说明「改这些语义 = apiVersion+1」')
}

section('9. 提示语(§5.9「生成后提示重新扫描」+ DEV-6 默认未启用)')
{
  const r = BUILD(ACTION(), [])
  const notice = S(F(r).notice)
  ok(notice.includes('重新扫描'), '提示要给出下一步', notice)
  ok(notice.includes('默认没启用') && notice.includes('dev'), 'status:dev 的后果一起说(否则用户以为插件没出现是框架坏了)', notice)
  ok(notice.includes('demo-tool/'), '提示里带上生成的目录名', notice)
  const md = TEXT(r, 'README.md')
  ok(md.includes('status') && md.includes('stable'), 'README 告诉作者写完改成 stable', md.split('\n').filter((l) => l.includes('stable'))[0])
}

section('10. 同一份输入必须生成同一份文本(不许塞时间戳)')
{
  const a = BUILD(ACTION({ name: '我的工具', summary: 's', author: 'me', tags: ['x'] }), [])
  const b = BUILD(ACTION({ name: '我的工具', summary: 's', author: 'me', tags: ['x'] }), [])
  ok(FILES(a).map((f) => F(f).text).join('\n') === FILES(b).map((f) => F(f).text).join('\n'), '两次生成逐字节相同')
  const mf = MF(a)
  ok(mf.name === '我的工具' && mf.summary === 's' && mf.author === 'me' && FA(mf.tags).join(',') === 'x', 'name/summary/author/tags 走用户给的', mf)
  ok(!/\b\d{13}\b/.test(MT(a)) && !/Date\.now/.test(TEXT(a, 'index.js')), '产物里没有-now 类时间戳')
}

section('11. 脏入参一律不抛(生成的入口是用户填的表单)')
{
  for (const input of [null, undefined, 42, 'x', [], { kind: 'action' }, { id: 'x' }, { kind: 'action', id: 42 }]) {
    let r
    try { r = T.buildSkeleton(input, [null, 42, undefined]) } catch (e) { r = { ok: false, threw: S(e && e.message) } }
    ok(F(r).threw === undefined, `不抛异常(${JSON.stringify(input) ?? String(input)})`, F(r).threw)
    ok(typeof F(r).ok === 'boolean', `返回值有 ok(${JSON.stringify(input) ?? String(input)})`)
  }
  ok(FA(F(BUILD(ACTION(), null)).errors).length === 0 && F(BUILD(ACTION(), null)).ok === true, 'existing 给了 null ⇒ 当没有已有插件,不当错误')
}

section('12. 执行级验证:把生成的 index.js 当 ES 模块跑起来')
{
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gpm-scaffold-'))
  try {
    const act = BUILD(ACTION(), [])
    // 真实加载器用 blob + text/javascript 执行同一份文本,与扩展名无关;
    // 这里落一个 .mjs 只是让 Node 按 ESM 解析,执行的是**同一份生成文本**。
    const entry = path.join(dir, 'gen-action.mjs')
    writeFileSync(entry, TEXT(act, 'index.js'), 'utf8')
    const mod = await import(pathToFileURL(entry).href)
    ok(Array.isArray(mod.schema) && mod.schema.length === 2, 'action:schema 真的导出了数组', FA(mod.schema).length)
    ok(FA(mod.schema).map((f) => F(f).type).join(',') === 'files,boolean', '字段类型都是第 1 批那七种之内', FA(mod.schema).map((f) => F(f).type))
    ok(FA(mod.schema).every((f) => /^[a-z][a-z0-9_]{0,31}$/.test(S(F(f).key)) && S(F(f).label) && S(F(f).hint)), '每个字段都有合法 key/label/hint(schema.ts 的必填面)')
    ok(typeof mod.plan === 'function', 'action:plan 是函数')
    ok(mod.apply === undefined, 'action:没导出 apply(正文由 payload.text 交出去)')

    const logs = []
    const ctx = {
      cancelled: false,
      toolId: 'demo-tool',
      toolName: 'demo-tool',
      projectId: 'proj',
      readText: async (rel) => (rel === 'bad.gd' ? { ok: false, error: '太大没读' } : { ok: true, content: 'extends Node\n\nfunc _ready():\n\tpass\n' }),
      log: (lvl, m) => logs.push(lvl + ':' + m),
      notify: () => {}
    }
    // plan 可能压根没导出(模板被换掉/生成被拒时产物是空文本):调用前先判类型,要红不要撞停
    const runPlan = async (c, fs2, ps) => (typeof mod.plan === 'function' ? FA(await mod.plan(c, fs2, ps)) : [])
    const changes = await runPlan(ctx, [{ rel: 'a.gd', size: 10 }, { rel: 'bad.gd', size: 1 }, { rel: 'b.gd', size: 4 }], { mark_lines: true })
    ok(changes.length === 2, '读失败的那条被跳过而不是造一条空 change', changes.length)
    ok(P(changes, 0).rel === 'a.gd' && P(changes, 1).rel === 'b.gd', '顺序照 files 参数(不重排)', changes.map((c) => F(c).rel))
    ok(P(changes, 0).kind === 'rewrite' && P(changes, 0).risk === 'low', 'kind/risk 在场(框架按 risk 决定默认勾选)')
    ok(S(P(changes, 0).reason).length > 0, 'reason 非空:预览悬停要显示,插件必须给', P(changes, 0))
    const c0text = S(F(F(P(changes, 0)).payload).text)
    ok(c0text.startsWith('# gpm 骨架示例'), 'payload.text 是新正文', c0text.slice(0, 24))
    ok(c0text.includes('func _ready()'), '原文一字不动地接在后面(演示只做追加)', c0text.slice(-30))
    // 5 而不是 4:仓库的行数口径是 split('\n')(见 diff.ts 的 toLines,末尾换行多出一个空元素),
    // 骨架演示必须跟着这个口径,否则作者写出的工具与 diff 预览会各报各的行数。
    ok(S(P(changes, 0).label).includes('共 5 行'), 'mark_lines 开 ⇒ label 报行数(参数真的进了逻辑)', P(changes, 0))
    const off = await runPlan(ctx, [{ rel: 'a.gd', size: 1 }], { mark_lines: false })
    ok(!S(P(off, 0).label).includes('共'), 'mark_lines 关 ⇒ 少那半句:参数确实被读', P(off, 0))
    ok(logs.some((l) => l.startsWith('warn:') && l.includes('bad.gd')), '读不到的那条走 ctx.log,不静默消失', logs)
    const gone = await runPlan({ ...ctx, cancelled: true }, [{ rel: 'a.gd', size: 1 }], { mark_lines: true })
    ok(gone.length === 0, '取消 ⇒ 提前返回已完成部分(这里是一条都没做)', gone)

    const vw = BUILD(VIEW(), [])
    const ventry = path.join(dir, 'gen-view.mjs')
    writeFileSync(ventry, TEXT(vw, 'index.js'), 'utf8')
    const vmod = await import(pathToFileURL(ventry).href)
    ok(typeof vmod.view === 'function', 'view:导出 view(ctx, files)')
    const tags = []
    const vctx = {
      toolId: 'demo-view', toolName: '演示视图', projectId: '',
      vue: {
        h: (tag, props, children) => { tags.push(tag); return { tag, n: FA(children).length } },
        ref: (v) => ({ value: v }),
        computed: (fn) => ({ value: fn() }),
        onMounted: (fn) => { try { fn() } catch { /* 骨架里那个回调只是给 shown 赋值,测试不关心 */ } }
      },
      notify: () => {}
    }
    // view 可能压根没导出(变异刀把模板换掉时就是这样),调用前先判类型:要红一条断言,不要撞停整个套件
    const vnode = typeof vmod.view === 'function' ? vmod.view(vctx, [{ rel: 'a.gd' }, { rel: 'b.gd' }]) : {}
    ok(F(vnode).tag === 'div', 'view 返回一个节点(h 的第一参是标签)', vnode)
    // 假 h 是同步调用的:子节点先建、父节点最后建,所以 div 排在 tags 末尾而不是开头
    ok(tags[tags.length - 1] === 'div' && tags.includes('button'), '里面画了段落与按钮', tags)
    ok(F(vnode).n === 3, '里面画了三个子节点(两段说明 + 一个按钮)', F(vnode).n)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log(`\n${'='.repeat(56)}\nPASS ${pass}  FAIL ${failures.length}`)
if (failures.length) {
  console.log('失败项:')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log('全部通过')
