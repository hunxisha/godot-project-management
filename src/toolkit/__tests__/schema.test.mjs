// 工具箱 · 第 1 批 Task 4:声明式参数 schema(src/toolkit/schema.ts)的断言。
//
// 这一层是 `ui:'schema'` 型插件的全部门槛:作者只写一张表,框架负责画表单**并校验用户填的值**。
// 所以这里钉的两类错都很实在:
//   · 作者把声明写坏(key 撞车 / select 没有 options / def 与 type 不匹配 / 用第 1 批不支持的 scope:'any');
//   · 用户把值填坏(数字填成文字 / 越界 / 枚举外的值 / files 里混进绝对路径或别人的扩展名)。
// 第二类的判据方向是**报错而不是猜**:参数会被插件拿去改写用户的源文件,
// 「静默夹到边界」看着友好,实际是框架替用户改了主意 —— 与 orchestrate 那条同源。
//
// 用法:node src/composables/__tests__/build-bundle.mjs && node src/toolkit/__tests__/schema.test.mjs
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../../..')
const BUNDLE = path.resolve(ROOT, '.gpm-test/out/tkschema.mjs')

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
  else { failures.push(label); console.log(`  FAIL  ${label}${extra !== undefined ? '  → ' + JSON.stringify(extra) : ''}`) }
}
function section(t) { console.log(`\n=== ${t} ===`) }

/** 全都要走「同一条读取路径」:变异态下少字段时红一条,不撞停 */
const F = (x) => (x && typeof x === 'object' ? x : {})
const FA = (x) => (Array.isArray(x) ? x : [])
const N = (x) => (typeof x === 'number' ? x : -1)
const S = (x) => (typeof x === 'string' ? x : '')
const V = (raw, over) => {
  const r = T.validateSchema([{ key: 'mode', type: 'select', label: '模式', options: [{ value: 'tab', label: 'Tab' }], def: 'tab' }, ...FA(raw), ...[over].filter(Boolean)])
  return r
}
const F1 = (over) => [{ key: 'n', type: 'number', label: '数字', def: 1, ...over }]
const OK1 = (over) => T.validateSchema([{ key: 'x', type: 'text', label: '文本', ...over }])
const R = (fields, vals) => T.resolveParams(fields, vals)
const msg = (res, key) => {
  const hit = FA(res.issues).filter((i) => F(i).key === key)
  return hit.length ? S(hit[0].message) : ''
}
const fieldsOf = (raw) => {
  const r = T.validateSchema(raw)
  return r.ok ? FA(r.fields) : []
}
/** 拿单个校验好的字段(先证明它真通过了,否则后面全是拿 undefined 做判据) */
const one = (raw) => {
  const fs = fieldsOf(FA(raw))
  return fs.length ? fs[0] : null
}

section('0. 导出面')
for (const n of ['FIELD_TYPES', 'validateSchema', 'usableFields', 'defaultsOf', 'resolveParams', 'regexHits', 'fieldHint']) {
  ok(T[n] !== undefined, `${n} 已在打包产物里导出`)
}
ok(T.FIELD_TYPES.join(',') === 'text,textarea,number,boolean,select,regex,files',
  '第 1 批就这七种(§5.8:table / folder / scope:any / regex 高亮一律留给后批)', T.FIELD_TYPES)

section('1. schema 本体必须是数组')
{
  for (const [v, word] of [[undefined, '缺失'], [null, 'null'], [{}, '对象'], ['x', '字符串']]) {
    const r = T.validateSchema(v)
    ok(r.ok === false && FA(r.issues).length === 1, `${word} 入参:单条原因,不进逐字段检查`, r.issues)
    ok(r.ok === false && S(r.issues[0].message).includes('数组'), `${word} 入参的原因说「必须是数组」`, r.ok)
  }
  ok(T.validateSchema([]).ok === true, '空数组合法:有的 action 工具不需要参数')
}

section('2. key:它是 params 的键,撞车就有人丢值')
{
  ok(OK1({ key: 'indent' }).ok === true, '小写单词过')
  ok(OK1({ key: 'max_blank' }).ok === true, '下划线过')
  ok(OK1({ key: 'a2' }).ok === true, '数字可以跟在后面')
  for (const k of ['Indent', '2a', '_a', 'a-b', 'a b', '', '   ', 'a'.repeat(33)]) {
    ok(OK1({ key: k }).ok === false, `不合法 key 拒载:${JSON.stringify(k).slice(0, 12)}`)
  }
  const dup = T.validateSchema([
    { key: 'same', type: 'text', label: 'A' },
    { key: 'same', type: 'number', label: 'B' }
  ])
  ok(dup.ok === false && msg(dup, 'same').includes('重复'), '同 key 两个字段 ⇒ 拒载并点名重复', dup.issues)
  ok(msg(dup, 'same').includes('盖掉'), '原因要说清后果:表单会盖掉其中一个值', msg(dup, 'same'))
  const dirty = T.validateSchema([null, 7, 'x', {}, { key: 'ok', type: 'text', label: 'L' }])
  ok(dirty.ok === false, 'schema 里混进非对象元素 ⇒ 拒载,不静默跳过', dirty.issues)
  // null/7/'x' 不是对象(第 1 类),{} 是对象但没有 key(第 2 类)——两条都按位置报,作者才找得到是哪一行
  ok(FA(dirty.issues).filter((i) => S(i.key).startsWith('第 ')).length === 4, '四个坏元素各报一条(按位置报)', dirty.issues)
  ok(FA(dirty.fields).length === 1, '好的那个仍然收下来(整页白屏是最糟的收法)', dirty.fields)
  ok(T.validateSchema([{ key: 'ok2', type: 'text', label: 'L' }]).ok === true, '把坏元素拿掉就过(报的是元素,不是整张表)')
}

section('3. type 只认这七种')
{
  // 每种类型都配一份「对它合法」的 def:select 的 def 必须在 options 里,files 的 def 必须是数组……
  const defFor = (t) => (t === 'boolean' ? true : t === 'files' ? [] : t === 'number' ? 1 : t === 'select' ? 'v' : 'x')
  for (const t of T.FIELD_TYPES) {
    const r = T.validateSchema([{ key: 'f', type: t, label: 'L', options: [{ value: 'v', label: 'V' }], exts: ['gd'], def: defFor(t) }])
    ok(r.ok === true, `七种类型逐个都能过:${t}`, FA(r.issues))
  }
  const bad = T.validateSchema([{ key: 'f', type: 'color', label: 'L' }])
  ok(bad.ok === false && msg(bad, 'f').includes('color'), '不认识的 type 拒载,原因带上那个名字', bad.issues)
  ok(msg(bad, 'f').includes('text'), '原因里列出支持的类型全集(作者不用翻文档)', msg(bad, 'f'))
  const missing = T.validateSchema([{ key: 'f', label: 'L' }])
  ok(missing.ok === false && msg(missing, 'f').includes('第 1 批只支持'), '缺 type 同样拒载', missing.issues)
}

section('4. label 没有替代物,必须有')
{
  ok(OK1({ label: undefined }).ok === false, '缺 label 拒载')
  ok(msg(OK1({ label: '  ' }), 'x').includes('label'), '空白 label 也算缺', OK1({ label: '  ' }).issues)
  const r = OK1({ label: undefined })
  ok(msg(r, 'x').includes('表单'), '原因说清为什么非要 label(表单上那句提示没有替代物)', msg(r, 'x'))
}

section('5. number:min/max 与 def 要对得上')
{
  const f = one(F1({ min: 1, max: 4 }))
  ok(f !== null && F(f).min === 1 && F(f).max === 4, '边界原样收下', f)
  ok(T.validateSchema(F1({ min: 'a' })).ok === false, 'min 不是数字 ⇒ 拒载')
  ok(T.validateSchema(F1({ max: Number.NaN })).ok === false, 'NaN 不当数(min/max 要有限数字)')
  const flip = T.validateSchema(F1({ min: 5, max: 1 }))
  ok(flip.ok === false && msg(flip, 'n').includes('没有任何取值能同时满足'), 'min>max 拒载,原因说清无解', msg(flip, 'n'))
  const out = T.validateSchema(F1({ min: 1, max: 4, def: 9 }))
  ok(out.ok === false && msg(out, 'n').includes('表单打开就是一条红'), '默认值落在边界外 ⇒ 拒载(而不是让 UI 先红给用户看)', msg(out, 'n'))
  const wrongType = T.validateSchema(F1({ def: 'tab' }))
  ok(wrongType.ok === false && msg(wrongType, 'n').includes('number'), 'number 的 def 给了串 ⇒ 拒载', msg(wrongType, 'n'))
}

/** 校验器**不许抛**:抛了就是整页白屏,而 schema 是插件作者手写的东西,坏形态层出不穷。
 *  变异取证 K2 就是把 options 的守卫摘掉,结果 validateSchema 自己对 undefined 抛了 TypeError ——
 *  撞停的样子在终端上很像「抓到了」,所以这里显式把它记成一条红。 */
const tryV = (raw) => {
  try {
    return T.validateSchema(raw)
  } catch (e) {
    return { __threw: String(e && e.message), ok: false, fields: [], issues: [] }
  }
}

section('6. select:options 是它的命')
{
  const f = one([{ key: 's', type: 'select', label: 'L', options: [{ value: 'a' }, { value: 'b', label: '乙' }] }])
  ok(f !== null && FA(F(f).options).length === 2, '两项过', f)
  ok(F(FA(F(f).options)[0]).label === 'a', '缺 label 的选项退化成显示 value(不是显示 undefined)', F(FA(f.options)[0]).label)
  ok(F(FA(F(f).options)[1]).label === '乙', '给了 label 就用 label')

  const noOpts = tryV([{ key: 's', type: 'select', label: 'L' }])
  ok(noOpts.__threw === undefined, 'select 完全没有 options 键:拒载,但**不许抛异常**(抛了就是整页白屏)', noOpts.__threw)
  ok(noOpts.ok === false && msg(noOpts, 's').includes('options'), '缺 options 的原因是拒载级', msg(noOpts, 's'))
  const emptyOpts = tryV([{ key: 's', type: 'select', label: 'L', options: [] }])
  ok(emptyOpts.__threw === undefined && emptyOpts.ok === false, 'options 是空数组:同样拒载且不抛', emptyOpts.__threw)
  ok(msg(emptyOpts, 's').includes('一个可选项都没有'), '原因说清后果', msg(emptyOpts, 's'))
  const dupOpt = T.validateSchema([{ key: 's', type: 'select', label: 'L', options: [{ value: 'a' }, { value: 'a' }] }])
  ok(dupOpt.ok === false && msg(dupOpt, 's').includes('重复'), 'options 的 value 撞车 ⇒ 拒载', msg(dupOpt, 's'))
  const dirtyOpt = T.validateSchema([{ key: 's', type: 'select', label: 'L', options: [7, null] }])
  ok(dirtyOpt.ok === false && msg(dirtyOpt, 's').includes('第 1 项'), '非对象选项按序号报', msg(dirtyOpt, 's'))
  const badDef = T.validateSchema([{ key: 's', type: 'select', label: 'L', options: [{ value: 'a' }], def: 'zzz' }])
  ok(badDef.ok === false && msg(badDef, 's').includes('不在 options 里'), '默认值不在枚举里 ⇒ 拒载', msg(badDef, 's'))
}

section('7. boolean / text / regex 的默认值方向')
{
  ok(F(one([{ key: 'b', type: 'boolean', label: 'L' }])).def === false, 'boolean 不声明默认值时给 false(不许勾上才走)')
  ok(T.validateSchema([{ key: 'b', type: 'boolean', label: 'L', def: 'yes' }]).ok === false, 'boolean 的 def 给了串 ⇒ 拒载')
  ok(F(one([{ key: 't', type: 'text', label: 'L' }])).def === '', 'text 缺省给空串')
  ok(F(one([{ key: 'r', type: 'regex', label: 'L' }])).def === '', 'regex 缺省给空串(空正则会让 exec 死循环,所以下面还要拦)')
  ok(T.validateSchema([{ key: 'r', type: 'regex', label: 'L', def: 5 }]).ok === false, 'regex 的 def 给了数字 ⇒ 拒载')
  const nn = one([{ key: 'n', type: 'number', label: 'L' }])
  ok(F(nn).def === null, 'number 不声明默认值时给 null,**不臆造一个 0**(0 是合法取值,给了就等于替用户选了)')
}

section('8. files:第 1 批只允许项目内,扩展名要像扩展名')
{
  const f = one([{ key: 'fs', type: 'files', label: 'L', exts: ['gd', '.GD', 'tscn'] }])
  ok(FA(F(f).exts).join(',') === 'gd,tscn', 'exts 归一(去点、转小写)且保序', f)
  ok(F(f).multiple === true, 'files 缺省 multiple=true(批量工具是常态)')
  ok(F(one([{ key: 'fs', type: 'files', label: 'L', multiple: false }])).multiple === false, '显式 multiple:false 认')
  const scopeAny = T.validateSchema([{ key: 'fs', type: 'files', label: 'L', scope: 'any' }])
  ok(scopeAny.ok === false && msg(scopeAny, 'fs').includes('第 1 批不支持'), "scope:'any' 在第 1 批就被拒(留给第 3 批,别让插件先写起来再崩)", msg(scopeAny, 'fs'))
  ok(T.validateSchema([{ key: 'fs', type: 'files', label: 'L', scope: 'project' }]).ok === true, "scope:'project' 显式写也认")
  ok(T.validateSchema([{ key: 'fs', type: 'files', label: 'L', exts: 'gd' }]).ok === false, 'exts 不是数组 ⇒ 拒载')
  for (const e of ['', '  ', 'a'.repeat(9), 'g.d', 'GDX!']) {
    ok(T.validateSchema([{ key: 'fs', type: 'files', label: 'L', exts: [e] }]).ok === false, `不像扩展名的 ${JSON.stringify(e)} ⇒ 拒载`)
  }
  ok(T.validateSchema([{ key: 'fs', type: 'files', label: 'L', def: 'a.gd' }]).ok === false, 'files 的 def 必须是数组')
  const badDef = T.validateSchema([{ key: 'fs', type: 'files', label: 'L', def: ['a.gd', '../etc/passwd', '/abs/x.gd', 'C:/y.gd'] }])
  ok(badDef.ok === false && FA(badDef.issues).length === 3, 'def 里的越界/绝对/盘符逐个拒载(3 条)', badDef.issues)
  const single = T.validateSchema([{ key: 'fs', type: 'files', label: 'L', multiple: false, def: ['a.gd', 'b.gd'] }])
  ok(single.ok === false && msg(single, 'fs').includes('单选'), '单选 files 给了两项 ⇒ 拒载', msg(single, 'fs'))
}

section('9. defaultsOf:表单初值')
{
  const fs = fieldsOf([
    { key: 'a', type: 'text', label: 'A', def: 'x' },
    { key: 'b', type: 'boolean', label: 'B' },
    { key: 'c', type: 'files', label: 'C', def: ['p/a.gd'] },
    { key: 'd', type: 'number', label: 'D' }
  ])
  ok(fs.length === 4, '四个字段都校验通过', fs)
  const d = T.defaultsOf(fs)
  ok(d.a === 'x' && d.b === false && d.d === null, '初值按 def 给,缺省的按类型补', d)
  ok(Array.isArray(d.c) && d.c.join(',') === 'p/a.gd', 'files 初值是数组', d.c)
  const c1 = T.defaultsOf(fs)
  const c2 = T.defaultsOf(fs)
  c1.c.push('脏了一下')
  ok(c2.c.length === 1, 'files 的初值**复制**了新数组:两个表单不许共享同一份引用', { c2: c2.c })
  ok(Object.keys(T.defaultsOf([])).length === 0, '空字段表 ⇒ 空初值,不抛')
  for (const v of [undefined, null, 'x']) ok(Object.keys(T.defaultsOf(v)).length === 0, `defaultsOf(${JSON.stringify(v)}) 给空对象不抛`)
}

section('10. resolveParams:数字与布尔')
{
  const fs = fieldsOf(F1({ min: 1, max: 4, def: 2 }))
  ok(R(fs, { n: 3 }).ok === true && R(fs, { n: 3 }).values.n === 3, '范围内过')
  ok(R(fs, { n: '3' }).ok === true && R(fs, { n: '3' }).values.n === 3, 'input 给的是串「3」⇒ 认(表单天生给串)')
  const low = R(fs, { n: 0 })
  ok(low.ok === false && msg(low, 'n').includes('不能小于 1'), '小于 min ⇒ 拒,不夹到边界(夹就是替用户改主意)', msg(low, 'n'))
  ok(low.ok === false && msg(low, 'n').includes('0'), '原因里带上用户实际填的那个值', msg(low, 'n'))
  ok(R(fs, { n: 99 }).ok === false, '大于 max ⇒ 拒')
  ok(R(fs, { n: 'abc' }).ok === false && msg(R(fs, { n: 'abc' }), 'n').includes('要填数字'), '填了文字 ⇒ 说「要填数字」')
  ok(R(fs, { n: '  ' }).ok === true, '只有空白视作没填,补默认值(不是「要填数字」)')
  ok(R(fs, { n: Infinity }).ok === false, 'Infinity 不是有限数字 ⇒ 拒')
  const bools = fieldsOf([{ key: 'b', type: 'boolean', label: 'B' }])
  ok(R(bools, { b: true }).values.b === true && R(bools, { b: false }).values.b === false, '布尔原样过')
  ok(R(bools, { b: 'true' }).values.b === true, '串 "true" 认(复选框经 DOM 会变串)')
  ok(R(bools, { b: 'false' }).values.b === false, '串 "false" 认,不当成 truthy 串')
  ok(R(bools, { b: 'yes' }).ok === false, '"yes" 这种仍拒 —— 只认三种形态,不扩大解释')
  ok(R(bools, { b: 1 }).ok === false, '数字 1 不当 true')
}

section('11. resolveParams:select 与文本与正则')
{
  const sel = fieldsOf([{ key: 'm', type: 'select', label: '模式', options: [{ value: 'tab' }, { value: 'space' }] }])
  ok(R(sel, { m: 'tab' }).values.m === 'tab', '枚举内过')
  const off = R(sel, { m: 'other' })
  ok(off.ok === false && msg(off, 'm').includes('不在可选项里'), '枚举外 ⇒ 拒', msg(off, 'm'))
  ok(msg(off, 'm').includes('tab / space'), '原因列出可选值(用户能自己改回来)', msg(off, 'm'))
  const txt = fieldsOf([{ key: 't', type: 'text', label: 'T', required: true }])
  ok(R(txt, { t: 'abc' }).values.t === 'abc', '文本过')
  ok(R(txt, {}).ok === false && msg(R(txt, {}), 't').includes('必填'), 'required 缺值 ⇒ 拒(而不是给个空串蒙过去)')
  ok(R(txt, { t: 5 }).ok === false, '文本字段给了数字 ⇒ 拒')
  const rx = fieldsOf([{ key: 'r', type: 'regex', label: '正则' }])
  ok(R(rx, { r: '^\\s*func' }).ok === true, '能编译的正则过')
  const badRx = R(rx, { r: '(unclosed' })
  ok(badRx.ok === false && msg(badRx, 'r').includes('编译不过'), '编译不过的正则 ⇒ 拒并说明', msg(badRx, 'r'))
  ok(R(rx, { r: undefined }).ok === true, '非必填的正则留空 ⇒ 过(补默认空串)')
}

section('12. resolveParams:files 的越界与扩展名')
{
  const fs = fieldsOf([{ key: 'fs', type: 'files', label: '文件', exts: ['gd'], def: [] }])
  ok(R(fs, { fs: ['a.gd', 'b/c.gd'] }).ok === true, '两个项目内 .gd 过')
  const esc = R(fs, { fs: ['a.gd', '../outside.gd'] })
  ok(esc.ok === false && msg(esc, 'fs').includes('第 2 个'), '越界那一项按序号拒', msg(esc, 'fs'))
  ok(R(fs, { fs: ['/abs/a.gd'] }).ok === false, '绝对路径拒')
  ok(R(fs, { fs: ['C:/a.gd'] }).ok === false, '带盘符拒')
  const wrongExt = R(fs, { fs: ['a.png'] })
  ok(wrongExt.ok === false && msg(wrongExt, 'fs').includes('.png'), '扩展名不在 exts 里 ⇒ 拒并点名那个文件', msg(wrongExt, 'fs'))
  ok(R(fs, { fs: [] }).ok === false, '空选择 ⇒ 拒(没输入就没得算)')
  const dedup = R(fs, { fs: ['a.gd', 'a.gd'] })
  ok(dedup.ok === true && FA(dedup.values.fs).join(',') === 'a.gd', '同一项点两次只留一条', dedup.values)
  const single = fieldsOf([{ key: 'fs', type: 'files', label: 'F', multiple: false, def: [] }])
  ok(R(single, { fs: ['a.gd', 'b.gd'] }).ok === false, '单选给两项 ⇒ 拒')
  ok(R(fs, { fs: 'a.gd' }).ok === true, '串当单项处理(上游手滑传成字符串也不炸)')
  ok(R(fs, { fs: [{}] }).ok === false && R(fs, { fs: [undefined] }).ok === false, '数组里的脏元素拒载,不静默变成空选择')
}

section('13. regexHits:只显示匹配到几处(§5.8)')
{
  ok(T.regexHits('\\d', 'a1b22c3').count === 4, '逐处计数:1、2、2、3 共四处', T.regexHits('\\d', 'a1b22c3'))
  ok(T.regexHits('^', 'a\nb\nc').ok === true, '零宽匹配不许死循环(有 guard):能出结果就是活着出来了', T.regexHits('^', 'a\nb\nc'))
  ok(T.regexHits('', 'abc').ok === false && S(T.regexHits('', 'abc').error).includes('空'), '空正则 ⇒ ok:false 并给原因(不返回 count 0 冒充「没匹配」)')
  ok(T.regexHits('((', 'abc').ok === false && T.regexHits('((', 'abc').error.length > 0, '编译不过 ⇒ 带编译器的原话')
  ok(T.regexHits(undefined, 'abc').ok === false && T.regexHits(5, 'abc').ok === false, '非串 pattern 不抛')
  ok(T.regexHits('a', undefined).count === 0 && T.regexHits('a', undefined).ok === true, '正文缺失 ⇒ 当作空文本、count 0(不是错误)')
  ok(T.regexHits('a+', 'aaa').count === 1, '一个连续段算一处(按匹配段数,不是按字符数)', T.regexHits('a+', 'aaa'))
  const many = T.regexHits('a', 'a'.repeat(12))
  ok(many.ok === true && many.count === 12, '12 处如实计数', many)
  // guard 触发:零宽 + 极长文本会在 100 万次处停下并报错,而不是把界面转圈转死
  const huge = T.regexHits('(?=x)|', 'x'.repeat(20))
  ok(huge.ok === false || huge.count > 0, '零宽形态要么给出计数,要么给出停下的原因,不能无声返回', huge)
}

section('14. fieldHint:表单上那句提示')
{
  const f = one(F1({ min: 1, max: 4, label: '折叠空行数', required: true }))
  const h = S(T.fieldHint(f))
  ok(h.includes('必填') && h.includes('1 到 4'), '必填 + 区间都说', h)
  ok(S(T.fieldHint(one([{ key: 'n', type: 'number', label: 'L', min: 2 }]))).includes('不小于 2'), '只有下界的话法对')
  ok(S(T.fieldHint(one([{ key: 'n', type: 'number', label: 'L', max: 2 }]))).includes('不大于 2'), '只有上界的话法对')
  ok(S(T.fieldHint(one([{ key: 'n', type: 'number', label: 'L' }]))) === '', '没有可提示的信息就返回空串(UI 不画空 chip)')
  const filesHint = S(T.fieldHint(one([{ key: 'fs', type: 'files', label: 'L', exts: ['gd'], multiple: false }])))
  ok(filesHint.includes('单选') && filesHint.includes('.gd'), 'files 的提示带选择模式与扩展名', filesHint)
}

section('15. usableFields 与措辞来源')
{
  const r = T.validateSchema([{ key: 'good', type: 'text', label: 'G' }, { key: 'BAD', type: 'text', label: 'B' }])
  ok(r.ok === false, '一个坏字段就整体不 ok(拒载级的声明错误不部分放行)')
  ok(FA(T.usableFields(r)).length === 1, '但 usableFields 仍交出好的那个(整页白屏是最糟的收法)', T.usableFields(r))
  ok(FA(T.usableFields(T.validateSchema([{ key: 'g2', type: 'text', label: 'x' }]))).length === 1, '全好 ⇒ 全给')
  const keys = FA(r.issues).map((i) => F(i).key)
  ok(S(keys[0]) === 'BAD', '原因按 key 归属(UI 能把红点标到那一行上)', keys)
}

section('17. 字段数组本身混进脏元素')
{
  // defaultsOf / resolveParams 的入参是 `validateSchema` 的输出,但视图那侧可能手滑把原始数组传进来
  // (原始数组里就有 null / 非对象)。判据是**跳过脏元素,不抛**。
  const fs = fieldsOf([{ key: 'k', type: 'text', label: 'K' }])
  const dirty = [null, 7, {}, ...fs]
  const d = T.defaultsOf(dirty)
  ok(Object.keys(d).join(',') === 'k', 'defaultsOf 跳过脏元素,只给合法那个的初值', Object.keys(d))
  const r = T.resolveParams(dirty, { k: 'v' })
  ok(r.ok === true && r.values.k === 'v', 'resolveParams 同样跳过脏元素(不抛、不误报缺值)', r)
  for (const v of [undefined, null, 'x', 42]) {
    ok(Object.keys(T.defaultsOf(v)).length === 0, `defaultsOf(${JSON.stringify(v)}) 给空对象不抛`)
    const rr = T.resolveParams(v, { a: 1 })
    ok(rr.ok === true && Object.keys(rr.values).length === 0, `resolveParams(${JSON.stringify(v)}) 没有字段可校验 ⇒ 过且空值集`)
  }
  // 未知 key 不往 plan() 传:多半是字段改名后的残留,传下去插件会读到它没声明过的东西
  const rr = T.resolveParams(fs, { k: 'v', leftover: 'x' })
  ok(rr.ok === true && !('leftover' in rr.values), '表单里多出来的键既不报错也不往下传', rr.values)
}

console.log(`\n${'='.repeat(56)}\nPASS ${pass}  FAIL ${failures.length}`)
if (failures.length) {
  console.log('失败项:')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log('全部通过')
