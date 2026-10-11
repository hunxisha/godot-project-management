// 工具箱 · 第 1 批 Task 1:manifest 校验(src/toolkit/manifest.ts)的断言。
//
// 这份合同是**第三方插件作者的入口**,而 apiVersion 不匹配硬拒载、不做兼容适配层(Q30)意味着
// 今天定下的每一条判据,将来都改不动——改语义等于让已存在的插件当场全废(§6 R-2)。
// 所以这里钉的不是「函数返回 true/false」,而是**每种坏形态各自说出人话**:
// §7 A-7 要求缺字段 / apiVersion 不匹配 / view+schema / id 非法 / entry 指向不存在文件
// 这五种都要有**可读的拒载原因**,而"可读"只能靠断言里写清期望的字样来验,
// 否则实现把原因写成 'invalid' 也算绿。
//
// 另外三组是本任务书 §F 新定的规则,一并钉住:
//   · apiVersion 不对时**提前返回单条原因**(契约版本都不对,逐字段挑错毫无意义);
//   · unsafe:true 只允许 view 型(§5.2:action 型拿不到裸写接口,这是三段式的地基);
//   · 三个新补的可选字段(§D #4 用户拍板)给了就要合法,不给补默认值。
//
// 脚手架的一条硬约定(第 0 批之后在这里第一次踩到,写下来免得复发):
//   取原因的辅助函数**必须全返回字符串**。上一版让 `why()` 在「没拒载」时返回 null,
//   于是变异刀把大写 id 改成合法之后,断言是在 `.includes()` 上抛 TypeError 把整个套件撞停的——
//   终端上看着像红,其实一条 PASS/FAIL 统计都没产出,既数不出红了几条,也容易把「撞停」误报成「抓到了」。
//   现在:`reason()` 没拒载给空串,断言老老实实红一条。
//
// 用法(npm script 会先跑打包步骤):
//   node src/composables/__tests__/build-bundle.mjs && node src/toolkit/__tests__/manifest.test.mjs
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../../..')
const BUNDLE = path.resolve(ROOT, '.gpm-test/out/tkmanifest.mjs')

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

/** 一份合法的最小 manifest(每测现取现改,避免互相污染) */
const GOOD = () => ({
  id: 'demo-tool',
  name: '演示工具',
  version: '1.0.0',
  apiVersion: 1,
  kind: 'action',
  ui: 'schema',
  summary: '一句话说明',
  cmds: ['演示'],
  entry: 'index.js',
  capabilities: ['tree', 'text']
})

const R = (raw, opts) => T.validateManifest(raw, opts)
/** 通过 ⇒ true */
const isOk = (raw, opts) => R(raw, opts).ok === true
/** 归一后的 manifest(仅在通过时有意义) */
const M = (raw, opts) => {
  const r = R(raw, opts)
  return r.ok ? r.manifest : null
}
/** 该字段有没有报错:没拒载 ⇒ false(不返回 null,免得调用点忘了判空就 .includes) */
const hasWhy = (field, raw, opts) => {
  const r = R(raw, opts)
  return r.ok === false && r.issues.some((i) => i.field === field)
}
/** 该字段的第一条拒载原因;没拒载 ⇒ 空串(断言红,但撞不坏) */
const reason = (field, raw, opts) => {
  const r = R(raw, opts)
  if (r.ok) return ''
  const hit = r.issues.filter((i) => i.field === field)
  return hit.length ? hit[0].message : ''
}

section('0. 导出面')
for (const n of ['GPM_API_VERSION', 'validateManifest', 'isInsidePath', 'missingCapabilities',
  'missingCapabilityText', 'rejectionText', 'TOOL_CAPABILITIES', 'TOOL_KINDS', 'TOOL_UIS', 'TOOL_STATUSES', 'CAPABILITY_LABELS']) {
  ok(T[n] !== undefined, `${n} 已在打包产物里导出`)
}
ok(T.GPM_API_VERSION === 1, '当前框架契约版本是 1(改它=让全部旧插件拒载,必须是刻意的决定)', T.GPM_API_VERSION)

section('1. 最小合法样本 + 默认值')
{
  const m = M(GOOD())
  ok(m !== null, '草案 §5.1 的最小集(不含任何可选字段)应当通过', R(GOOD()).issues)
  if (m) {
    ok(m.apiVersion === 1, 'apiVersion 原样保留')
    ok(m.icon === '', 'icon 缺省给空串(渲染层据此退到默认 wrench,而不是在列表里显示 undefined)')
    ok(m.author === '' && m.homepage === '' && m.description === '', 'author/homepage/description 缺省给空串')
    ok(Array.isArray(m.tags) && m.tags.length === 0, 'tags 缺省给空数组')
    ok(m.status === 'stable', "status 缺省是 'stable'(作者不声明就当已完工,不给它凭空挂个「未完成」标签)")
    ok(m.unsafe === false, 'unsafe 缺省 false')
    ok(m.capabilities.join(',') === 'tree,text', 'capabilities 按声明顺序原样给出(顺序要能对上作者的意图)')
  }
  ok(R(GOOD()).ok === true && Object.keys(R(GOOD())).includes('manifest'), '通过时返回体带 manifest')
}

section('2. 顶层形状:不是对象就一句话拒载,不进字段检查')
// 期望字样按 typeName 的实际输出写(undefined 显示成「缺失」,不是「undefined」)
for (const [v, word] of [[undefined, '缺失'], [null, 'null'], [['a'], '数组'], ['x', '字符串'], [42, '数字']]) {
  const r = R(v)
  ok(r.ok === false && r.issues.length === 1, `${word} 入参:单条原因,不逐字段挑刺`, JSON.stringify(r.issues))
  ok(r.ok === false && r.issues[0].field === '-', `${word} 入参的原因挂在 field '-' 上`)
  ok((r.ok === false ? r.issues[0].message : '').includes(word),
    `${word} 入参的原因里写明了拿到的是什么`, r.ok === false && r.issues[0].message)
}
ok(isOk(GOOD()), '空对象以外的合法对象照常过')

section('3. apiVersion:硬拒载且提前返回单条原因(§5.1)')
{
  ok(isOk({ ...GOOD(), apiVersion: 1 }), '等于框架版本 ⇒ 过')
  const miss = R({})
  ok(miss.ok === false && miss.issues.length === 1 && miss.issues[0].field === 'apiVersion',
    'apiVersion 缺失时**只报这一条**:契约版本不对,逐字段挑错毫无意义', JSON.stringify(miss.issues))
  for (const [v, label] of [['1', '字符串 "1"'], [1.5, '小数'], [Number.NaN, 'NaN'], [undefined, '缺失']]) {
    const w = reason('apiVersion', { ...GOOD(), apiVersion: v })
    ok(w.includes('整数'), `${label} 不是整数:原因是「必须是整数」而不是版本不等`, w)
  }
  for (const v of [0, 2, 999]) {
    const r = R({ ...GOOD(), apiVersion: v })
    const w = r.ok === false ? r.issues[0].message : ''
    ok(r.ok === false && w.includes(String(v)) && w.includes('1'), `版本 ${v} 的原因里两个数字都写出来(用户要能看出差在哪)`, w)
    ok(r.ok === false && w.includes('拒载') && w.includes('不做兼容适配'), `版本 ${v} 的原因说清后果:拒载、不做适配层`, w)
    ok(r.ok === false && r.issues.length === 1, `版本 ${v} 提前返回,不再报别的字段`, JSON.stringify(r.issues))
  }
  // 这条要有区分度:即使其它字段全坏,apiVersion 不对也只报版本 —— 反证「提前返回」没被改成「继续挑字段」
  const rb = R({ apiVersion: 2, id: 'BAD ID', kind: 'tool', cmds: [] })
  ok(rb.ok === false && rb.issues.length === 1 && rb.issues[0].field === 'apiVersion',
    '全坏的 manifest 只要版本不对,就只说版本不对', JSON.stringify(rb.issues))
}

section('4. id:目录名 / 存储前缀 / feature code 三处共用的键')
{
  for (const v of ['demo', 'demo2.format', 'a_b-c.d', 'x', 'a' + 'b'.repeat(63)]) ok(isOk({ ...GOOD(), id: v }), `合法:${v.slice(0, 12)}${v.length > 12 ? '…' : ''}`)
  ok(isOk({ ...GOOD(), id: 'a..b' }), "id 里的 '..' 不成段(首字符强制字母或数字 ⇒ 它永远不可能独立成为一个 .. 路径段)")
  for (const v of [undefined, '', '   ', 'Demo', 'demo tool', 'demo/tool', 'demo/../x', '.hidden', '..', '..' + '.x', 'a' + 'b'.repeat(64)]) {
    ok(hasWhy('id', { ...GOOD(), id: v }), `非法 id:${JSON.stringify(v)}`)
  }
  const wUpper = reason('id', { ...GOOD(), id: 'Demo' })
  ok(wUpper.includes('不合法'), '非法 id 的原因是「不合法」并列出允许的字符集', wUpper)
  ok(wUpper.includes('目录名') && wUpper.includes('feature'), '原因要说清 id 的三处用途(用户才知道为什么要挑这个)', wUpper)
  const wEmpty = reason('id', { ...GOOD(), id: '' })
  ok(wEmpty.includes('非空字符串') && !wEmpty.includes('不合法'), '空 id 的原因指向「必填」而不是「字符集」', wEmpty)
  const wNum = reason('id', { ...GOOD(), id: 42 })
  ok(wNum.includes('数字'), '数字 id 的原因报出拿到的类型', wNum)
  const wLong = reason('id', { ...GOOD(), id: 'a' + 'b'.repeat(64) })
  ok(wLong.includes('64'), '超长 id 的原因写出上限是多少(64),而不是只说「不合法」', wLong)
}

section('5. 必填字符串:name / version / summary')
for (const f of ['name', 'version', 'summary']) {
  ok(isOk(GOOD()), `${f} 有值时整体过`)
  const w = reason(f, { ...GOOD(), [f]: undefined })
  ok(w.includes(f) && w.includes('非空字符串'), `缺 ${f}:原因点名这个字段`, w)
  ok(reason(f, { ...GOOD(), [f]: '  ' }).length > 0, `${f} 只有空白也算缺`, reason(f, { ...GOOD(), [f]: '  ' }))
  ok(reason(f, { ...GOOD(), [f]: 7 }).includes('数字'), `${f} 给数字时原因报出类型`, reason(f, { ...GOOD(), [f]: 7 }))
}

section('6. kind / ui:两类工具的形状(§5.2)')
{
  ok(isOk(GOOD()), 'action + schema 过')
  ok(isOk({ ...GOOD(), ui: 'render' }), 'action + render 过(声明式不是唯一路)')
  ok(isOk({ ...GOOD(), kind: 'view', ui: 'render' }), 'view + render 过')
  const w = reason('ui', { ...GOOD(), kind: 'view', ui: 'schema' })
  ok(w.includes('view') && w.includes('schema'), "view + schema 拒载,且原因把两个词都说出来(A-7 第 3 种)", w)
  ok(hasWhy('kind', { ...GOOD(), kind: 'tool' }), '非法 kind 拒载')
  ok(reason('kind', { ...GOOD(), kind: 'tool' }).includes("'action' | 'view'"), '非法 kind 的原因列出允许取值', reason('kind', { ...GOOD(), kind: 'tool' }))
  ok(reason('ui', { ...GOOD(), ui: 'html' }).includes("'schema' | 'render'"), '非法 ui 的原因列出允许取值', reason('ui', { ...GOOD(), ui: 'html' }))
  ok(hasWhy('kind', { ...GOOD(), kind: undefined }), '缺 kind 拒载')
  ok(hasWhy('ui', { ...GOOD(), ui: undefined }), '缺 ui 拒载')
  ok(isOk({ ...GOOD(), kind: 'view', ui: 'render', unsafe: true }), 'view + render + unsafe:true 过(§5.2 的唯一裸写出口)')
}

section('7. entry:插件目录内的相对路径 + 给了清单就查存在性(A-7 第 5 种)')
{
  ok(isOk(GOOD()), '相对 entry 过')
  ok(isOk({ ...GOOD(), entry: 'lib/index.js' }), '带子目录的相对 entry 过')
  ok(isOk({ ...GOOD(), entry: './index.js' }), '`./` 前缀合法(与生产闸 resolveRel 同形:吃掉 . 段)')
  const OUT = ['../evil.js', '/abs/index.js', 'C:/x/index.js', 'c:\\x\\index.js', 'a/../../b.js', 'a\\..\\b.js']
  for (const v of OUT) {
    const w = reason('entry', { ...GOOD(), entry: v })
    ok(w.includes('相对路径') && w.includes('..'), `entry ${JSON.stringify(v)} 拒载,且原因说清「要目录内相对路径」`, w)
  }
  ok(hasWhy('entry', { ...GOOD(), entry: '' }), '空 entry 拒载(必填)')
  ok(isOk({ ...GOOD(), entry: 'nope.js' }), '不给目录清单时**不查**存在性(纯函数不碰磁盘)')
  ok(isOk(GOOD(), { files: ['index.js', 'manifest.json'] }), '给清单且 entry 在内 ⇒ 过')
  const w2 = reason('entry', GOOD(), { files: ['manifest.json'] })
  ok(w2.includes('不存在') && w2.includes('index.js'), '给清单而 entry 不在 ⇒ 原因说「不存在」并带上路径(A-7 第 5 种)', w2)
  ok(isOk({ ...GOOD(), entry: 'src\\index.js' }, { files: ['src/index.js'] }), '清单是正斜杠、entry 写反斜杠 ⇒ 归一后仍认得(Windows 作者不必猜)')
  ok(isOk({ ...GOOD(), entry: 'src/index.js' }, { files: ['src\\index.js'] }), '反方向同理(entry 正斜杠、清单反斜杠)')
}

section('8. icon:内置 key 或目录内图片路径')
{
  ok(isOk({ ...GOOD(), icon: 'pen' }), '内置图标 key 过')
  ok(isOk({ ...GOOD(), icon: 'img/icon.png' }), '相对图片路径过')
  ok(isOk({ ...GOOD(), icon: 'icon.png' }), '只给文件名也过(带扩展名就算路径形态)')
  const w = reason('icon', { ...GOOD(), icon: '../outside.png' })
  ok(w.includes('..'), '越出插件目录的 icon 路径拒载', w)
  ok(hasWhy('icon', { ...GOOD(), icon: 'C:/Windows/x.png' }), '绝对带盘符的 icon 路径拒载')
  ok(isOk(GOOD()), '不给 icon 合法(缺省空串)')
  const w3 = reason('icon', { ...GOOD(), icon: '  ' })
  ok(w3.includes('非空字符串'), 'icon 只有空白 ⇒ 拒载(给了就要有内容,而不是静默退到默认图标)', w3)
}

section('9. cmds:注册成 feature 的关键词(Q14 全部工具都要注册)')
{
  ok(isOk({ ...GOOD(), cmds: ['格式化', 'gdformat'] }), '多个关键词过')
  ok(reason('cmds', { ...GOOD(), cmds: undefined }).includes('数组'), '缺 cmds:原因是「必须是数组」', reason('cmds', { ...GOOD(), cmds: undefined }))
  const wEmpty = reason('cmds', { ...GOOD(), cmds: [] })
  ok(wEmpty.includes('空数组') && wEmpty.includes('搜索框'), '空数组:原因说清后果是「搜索框里永远打不开」', wEmpty)
  ok(reason('cmds', { ...GOOD(), cmds: '格式化' }).includes('数组'), '字符串不算数组(单个关键词也必须是 ["x"])')
  const w = reason('cmds', { ...GOOD(), cmds: ['ok', ''] })
  ok(w.includes('第 2 项'), '空白元素的原因报到序号,作者找得到是哪一条', w)
  ok(reason('cmds', { ...GOOD(), cmds: ['ok', 5] }).includes('第 2 项'), '非字符串元素同样按序号报')
  const m = M({ ...GOOD(), cmds: ['  a  ', 'a', 'b'] })
  ok(m !== null && m.cmds.length === 2 && m.cmds[0] === 'a' && m.cmds[1] === 'b', 'trim 后同名去重(重复关键词不需要注册两次)', m && m.cmds)
}

section('10. capabilities:声明要框架给什么(缺失→灰显的判据在别处,这里只管形态)')
{
  ok(isOk({ ...GOOD(), capabilities: [] }), '空数组合法(纯展示型 view 工具可以什么都不声明)')
  for (const c of T.TOOL_CAPABILITIES) ok(isOk({ ...GOOD(), capabilities: [c] }), `能力「${c}」在枚举内`)
  const w = reason('capabilities', { ...GOOD(), capabilities: ['nope'] })
  ok(w.includes('nope'), '不认的能力:原因带上那个名字', w)
  ok(w.includes('tree'), '不认的能力:原因同时列出框架认的全集(作者不用去翻文档)', w)
  ok(reason('capabilities', { ...GOOD(), capabilities: ['tree', 'tree'] }).includes('重复'), '重复声明拒载', reason('capabilities', { ...GOOD(), capabilities: ['tree', 'tree'] }))
  ok(reason('capabilities', { ...GOOD(), capabilities: 'tree' }).includes('数组'), '非数组的原因')
  ok(reason('capabilities', { ...GOOD(), capabilities: [1] }).includes('第 1 项'), '非字符串元素按序号报')
  ok(isOk({ ...GOOD(), capabilities: ['text', 'tree'] }), '顺序不影响通过')
}

section('11. unsafe:true 只允许 view 型(§5.2 的地基)')
{
  const w = reason('unsafe', { ...GOOD(), kind: 'action', unsafe: true })
  ok(w.includes('view') && w.includes('三段式'), 'action + unsafe:true 拒载,原因说清「action 型拿不到裸写」', w)
  ok(isOk({ ...GOOD(), kind: 'view', ui: 'render', unsafe: true }), 'view + unsafe:true 过')
  const mv = M({ ...GOOD(), kind: 'view', ui: 'render', unsafe: true })
  ok(mv !== null && mv.unsafe === true, 'unsafe 归一为 true 传下去(列表要标红)')
  ok(reason('unsafe', { ...GOOD(), unsafe: 'yes' }).includes('布尔'), '非布尔 unsafe 拒载')
  ok(isOk({ ...GOOD(), unsafe: false }), 'unsafe:false 过')
  ok(M(GOOD()).unsafe === false, '缺省 false')
}

section('12. §D #4 补的三个可选字段')
{
  ok(isOk({ ...GOOD(), description: '两段话的长说明' }), 'description 可选')
  ok(M({ ...GOOD(), description: '  x  ' }).description === 'x', 'description trim')
  ok(reason('description', { ...GOOD(), description: '' }).includes('非空字符串'), 'description 给了空串拒载(宁缺勿空)')
  ok(isOk({ ...GOOD(), tags: ['gdscript', '格式'] }), 'tags 可选')
  ok(isOk({ ...GOOD(), tags: [] }), 'tags 空数组合法')
  const mt = M({ ...GOOD(), tags: ['a', 'a'] })
  ok(mt !== null && mt.tags.length === 2, 'tags **不去重**(重复标签是作者的分类意图,框架不裁)')
  ok(reason('tags', { ...GOOD(), tags: 'x' }).includes('数组'), 'tags 非数组拒载')
  ok(reason('tags', { ...GOOD(), tags: [' '] }).includes('第 1 项'), 'tags 空白元素按序号拒载')
  ok(isOk({ ...GOOD(), status: 'dev' }), "status:'dev' 过")
  ok(isOk({ ...GOOD(), status: 'stable' }), "status:'stable' 过")
  ok(M({ ...GOOD(), status: 'dev' }).status === 'dev', 'status 传给归一体(DEV-6:dev ⇒ 默认未启用,靠的是这一个字段)')
  ok(reason('status', { ...GOOD(), status: 'beta' }).includes('dev'), '非法 status 的原因列出允许取值', reason('status', { ...GOOD(), status: 'beta' }))
  ok(reason('status', { ...GOOD(), status: 1 }).includes('dev'), '非字符串 status 也拒载,不静默退回默认', reason('status', { ...GOOD(), status: 1 }))
}

section('13. author / homepage:homepage 只认 http(s)(它会被当外链打开)')
{
  ok(isOk({ ...GOOD(), author: '冰冻琪露诺' }), 'author 可选')
  ok(isOk({ ...GOOD(), homepage: 'https://example.com/x' }), 'https 过')
  ok(isOk({ ...GOOD(), homepage: 'http://example.com' }), 'http 过')
  for (const v of ['javascript:alert(1)', 'data:text/html,x', 'file:///C:/x', 'example.com']) {
    const w = reason('homepage', { ...GOOD(), homepage: v })
    ok(w.includes('http'), `homepage「${v}」拒载,原因是「必须以 http(s):// 开头」`, w)
  }
  const wJs = reason('homepage', { ...GOOD(), homepage: 'javascript:alert(1)' })
  ok(wJs.includes('javascript'), '原因里点名 javascript: 这种形态(让后来人看得懂为什么挑)', wJs)
  ok(reason('author', { ...GOOD(), author: 7 }).includes('数字'), 'author 非串拒载')
}

section('14. 一次报全多条问题(除 apiVersion 以外)')
{
  const r = R({ ...GOOD(), id: 'BAD ID', name: '', kind: 'tool' })
  ok(r.ok === false && r.issues.length === 3, '三个坏字段 ⇒ 三条原因(不让用户改一轮错一轮)', JSON.stringify(r.issues))
  ok(r.ok === false && r.issues.map((i) => i.field).join(',') === 'id,name,kind', '原因顺序按字段检查顺序,稳定可断言', r.ok === false && r.issues.map((i) => i.field))
  ok(r.ok === false && r.issues.every((i) => typeof i.message === 'string' && i.message.length > 0), '每条原因都有话,不是空串')
}

section('15. rejectionText:列表那一行的措辞只在 §F 说的这一处')
{
  ok(T.rejectionText([]).includes('框架 bug'), '空数组不返回空串(宁可说「框架 bug」也不给用户一行没有原因的话)', T.rejectionText([]))
  const one = R({ ...GOOD(), kind: 'tool' }).issues
  ok(T.rejectionText(one) === one[0].message, '单条 ⇒ 原样那句话')
  const three = R({ ...GOOD(), id: 'BAD ID', name: '', kind: 'tool' }).issues
  ok(T.rejectionText(three) === three[0].message + '(另有 2 处问题)', '多条 ⇒ 第一条 + 剩余条数(全塞一行会撑爆那一行)', T.rejectionText(three))
}

section('16. isInsidePath:与生产闸 resolveRel(inspectfs.js:40-53)同形')
{
  for (const v of ['a/b', './a', 'a/./b', 'a//b', 'a', 'lib/index.js', 'x.png']) ok(T.isInsidePath(v) === true, `目录内:${v}`)
  for (const v of ['..', '../a', 'a/../b', 'a/../../b', 'a\\..\\b', '/', '/abs', 'C:/x', 'c:\\x', '']) ok(T.isInsidePath(v) === false, `越界/绝对/空:${JSON.stringify(v)}`)
  for (const v of [undefined, null, 42, {}, ['a']]) ok(T.isInsidePath(v) === false, `非字符串给 false(${JSON.stringify(v) || String(v)})`)
}

section('17. missingCapabilities:加载期的灰显判据')
{
  ok(T.missingCapabilities(['tree', 'ref'], ['tree']).join(',') === 'ref', '缺的那一个被点出来')
  ok(T.missingCapabilities(['ref', 'tree'], ['tree']).join(',') === 'ref', '顺序按声明原样(列表里那句话要稳定)')
  ok(T.missingCapabilities(['nope'], []).length === 0, '框架不认的能力不算「缺」—— 上游 validateManifest 已经拒载了它')
  ok(T.missingCapabilities(['tree', 'tree'], []).join(',') === 'tree', '重复声明只报一次')
  ok(T.missingCapabilities(undefined, undefined).length === 0, '非数组入参不抛,给空数组')
  ok(T.missingCapabilities(['tree', 5], ['tree']).length === 0, '脏元素不臆造成缺失')
  ok(T.missingCapabilities([...T.TOOL_CAPABILITIES], []).length === T.TOOL_CAPABILITIES.length, '全声明 + 全没给 ⇒ 全缺')
  ok(T.missingCapabilities(T.TOOL_CAPABILITIES, T.TOOL_CAPABILITIES).length === 0, '全给 ⇒ 不缺')
}

section('18. missingCapabilityText:那句灰显的话')
{
  ok(T.missingCapabilityText(['tree', 'ref']) === '缺少框架能力:项目文件树、引用图', '中文标签按 CAPABILITY_LABELS,顺序同声明', T.missingCapabilityText(['tree', 'ref']))
  ok(T.missingCapabilityText(['write']).includes('三段式'), 'write 的标签要说「经框架写盘(三段式)」(裸写与三段式的区别不能在这一行糊掉)', T.missingCapabilityText(['write']))
  for (const c of T.TOOL_CAPABILITIES) ok(T.CAPABILITY_LABELS[c] && T.CAPABILITY_LABELS[c].length > 1, `每个能力都有中文标签:${c}`)
}

section('19. 未知字段忽略(前向兼容:未来的新字段不该让现在的校验器报错)')
{
  ok(isOk({ ...GOOD(), futureField: 'x', minApiVersion: 1, colors: ['red'] }), '多出来的键不拒载')
  const m = M({ ...GOOD(), futureField: 'x' })
  ok(m !== null && !('futureField' in m), '归一体只带合同里有的字段(未知键不往下传,免得渲染层以为它有意义)', m && Object.keys(m))
}

console.log(`\n${'='.repeat(56)}\nPASS ${pass}  FAIL ${failures.length}`)
if (failures.length) {
  console.log('失败项:')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log('全部通过')
