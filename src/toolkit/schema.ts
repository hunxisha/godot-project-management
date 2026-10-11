// 工具箱 · 声明式参数 schema(Q10=D / Q31)。
//
// `ui:'schema'` 的工具连 `h()` 都不用写:插件在自己的 entry 里 `export const schema = [...]`,
// 框架按这张表画表单、按这张表校验用户填的值。**参数集长在模块里而不是 manifest.json 里**
// (§F DEV-5):manifest 是静态元数据,而「匹配到 12 处」这类要随输入实时变的提示只能是代码。
//
// 第 1 批只做 §5.8 点名的七种字段类型 —— `table` / `folder` / `scope:'any'` / regex 高亮
// 一律留给第 2、3 批的真需求(过早定一堆没人用的类型,就是接口被自己臆想带歪的机制)。
//
// 三条分工红线:
//   · `validateSchema` 管**声明**合不合法(插件作者写错,拒载级别的错,一次说全);
//   · `resolveParams` 管**用户填的值**(UI 传进来的东西一律不可信:缺项补默认、越界拒、脏元素丢);
//   · 两者的原因都由本模块生成(措辞同源,同 §5.4 那条纪律)。
// 纯函数。不碰 window / vue / fs。

import { isInsidePath } from './manifest'

export type FieldType = 'text' | 'textarea' | 'number' | 'boolean' | 'select' | 'regex' | 'files'

export const FIELD_TYPES: readonly FieldType[] = ['text', 'textarea', 'number', 'boolean', 'select', 'regex', 'files']

/** 字段里出现过的键(给 reason 与 UI 用,顺序按声明原样) */
export interface FieldDesc {
  key: string
  type: FieldType
  label: string
  /** 悬停说明。regex 型在这里放「为什么这条规则危险」最合适 */
  help: string
  required: boolean
  /** 默认值:number 要 number、boolean 要布尔、select 要 options 里的 value、files 要 rel 数组 */
  def: unknown
  min: number | null
  max: number | null
  /** select 的枚举;files 的 exts */
  options: { value: string; label: string }[]
  exts: string[]
  /** files 是否多选(第 1 批只有 files 用得到;单选就是「挑一个文件」那种工具) */
  multiple: boolean
  placeholder: string
}

export interface SchemaIssue {
  key: string
  message: string
}

export type SchemaResult = { ok: true; fields: FieldDesc[] } | { ok: false; fields: FieldDesc[]; issues: SchemaIssue[] }

const KEY_RE = /^[a-z][a-z0-9_]{0,31}$/

/** 值是什么类型(原因里要指名道姓,'object' 说成「对象」) */
function typeName(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return '数组'
  switch (typeof v) {
    case 'undefined': return '缺失'
    case 'string': return '字符串'
    case 'number': return '数字'
    case 'boolean': return '布尔'
    case 'object': return '对象'
    default: return typeof v
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * 校验插件声明的参数表。
 *
 * 空数组**合法**:有些 action 工具不需要参数(选完文件就直接算)。
 * 但一旦给了字段,key 必须唯一且合法 —— key 是 params 对象的键,也是插件 `plan()` 读值的依据,
 * 撞键会让后一个字段静默盖掉前一个,用户在表单上填的东西直接消失。
 */
export function validateSchema(raw: unknown): SchemaResult {
  const issues: SchemaIssue[] = []
  const bad = (key: string, message: string): void => { issues.push({ key, message }) }

  if (!Array.isArray(raw)) {
    return { ok: false, fields: [], issues: [{ key: '-', message: `schema 必须是数组,现在拿到的是${typeName(raw)}` }] }
  }

  const fields: FieldDesc[] = []
  const seen = new Set<string>()

  for (let i = 0; i < raw.length; i++) {
    const f = raw[i] as Record<string, unknown> | null | undefined
    const where = `第 ${i + 1} 个字段`
    if (!isPlainObject(f)) { bad(where, `${where}不是对象(拿到 ${f === null ? 'null' : typeName(f)})`); continue }

    const key = typeof f.key === 'string' ? f.key.trim() : ''
    if (!key) { bad(where, `${where}的 key 必须是非空字符串`); continue }
    if (!KEY_RE.test(key)) {
      bad(key, `key「${key}」不合法:要用小写字母开头,只能含小写字母、数字、下划线,总长不超过 32(它是 params 的键)`)
      continue
    }
    if (seen.has(key)) { bad(key, `key「${key}」与前面的字段重复了:表单会盖掉其中一个值,插件读到的也不是你填的那个`); continue }
    seen.add(key)

    const type = typeof f.type === 'string' ? f.type.trim() : ''
    if (!(FIELD_TYPES as readonly string[]).includes(type)) {
      bad(key, `字段「${key}」的 type「${type}」不认识;第 1 批只支持 ${FIELD_TYPES.join(' / ')}`)
      continue
    }
    const t = type as FieldType

    const label = typeof f.label === 'string' ? f.label.trim() : ''
    if (!label) bad(key, `字段「${key}」必须有 label(表单上那句提示没有替代物)`)

    const help = typeof f.help === 'string' ? f.help.trim() : ''
    const required = f.required === true
    const placeholder = typeof f.placeholder === 'string' ? f.placeholder.trim() : ''

    // ---- number 的边界 ----
    let min: number | null = null
    let max: number | null = null
    if (t === 'number') {
      if (f.min !== undefined) {
        if (typeof f.min !== 'number' || !Number.isFinite(f.min)) bad(key, `字段「${key}」的 min 要是有限数字,拿到 ${typeName(f.min)}`)
        else min = f.min
      }
      if (f.max !== undefined) {
        if (typeof f.max !== 'number' || !Number.isFinite(f.max)) bad(key, `字段「${key}」的 max 要是有限数字,拿到 ${typeName(f.max)}`)
        else max = f.max
      }
      if (min !== null && max !== null && min > max) bad(key, `字段「${key}」的 min(${min})大于 max(${max}),没有任何取值能同时满足`)
    }

    // ---- select 的枚举 ----
    let options: { value: string; label: string }[] = []
    if (t === 'select') {
      const opts = f.options
      if (!Array.isArray(opts) || opts.length === 0) {
        bad(key, `字段「${key}」是 select 但没有 options:下拉框里一个可选项都没有`)
      } else {
        const used = new Set<string>()
        for (let k = 0; k < opts.length; k++) {
          const o = opts[k]
          if (!isPlainObject(o)) { bad(key, `字段「${key}」的 options 第 ${k + 1} 项不是 {value, label} 对象`); continue }
          const value = typeof o.value === 'string' ? o.value.trim() : ''
          if (!value) { bad(key, `字段「${key}」的 options 第 ${k + 1} 项缺 value(value 才是 params 里存的串)`); continue }
          if (used.has(value)) { bad(key, `字段「${key}」的 options 里 value「${value}」重复`); continue }
          used.add(value)
          const ol = typeof o.label === 'string' && o.label.trim() ? o.label.trim() : value
          options.push({ value, label: ol })
        }
      }
    }

    // ---- files 的扩展名与多选 ----
    const exts: string[] = []
    if (t === 'files') {
      const e = f.exts
      if (e !== undefined) {
        if (!Array.isArray(e)) bad(key, `字段「${key}」是 files 但 exts 不是数组(拿到 ${typeName(e)})`)
        else {
          for (let k = 0; k < e.length; k++) {
            const s = typeof e[k] === 'string' ? e[k].trim().replace(/^\./, '').toLowerCase() : ''
            if (!s) { bad(key, `字段「${key}」的 exts 第 ${k + 1} 项是空的`); continue }
            if (!/^[a-z0-9_]{1,8}$/.test(s)) { bad(key, `字段「${key}」的 exts 里「${s}」不像扩展名(只允许 1-8 位小写字母数字下划线)`); continue }
            if (!exts.includes(s)) exts.push(s)
          }
        }
      }
      if (f.scope !== undefined && f.scope !== 'project') {
        bad(key, `字段「${key}」的 scope「${String(f.scope)}」在第 1 批不支持:文件选择只能限在项目内(scope:'any' 留给第 3 批的真需求)`)
      }
    }
    const multiple = t === 'files' ? f.multiple !== false : false

    // ---- 默认值与类型必须对得上 ----
    const def = f.def
    if (def !== undefined) {
      if (t === 'number' && (typeof def !== 'number' || !Number.isFinite(def))) bad(key, `字段「${key}」是 number 但 def 不是有限数字(拿到 ${typeName(def)})`)
      if (t === 'number' && typeof def === 'number' && ((min !== null && def < min) || (max !== null && def > max))) {
        bad(key, `字段「${key}」的默认值 ${def} 落在 min/max 之外:表单打开就是一条红`)
      }
      if (t === 'boolean' && typeof def !== 'boolean') bad(key, `字段「${key}」是 boolean 但 def 不是布尔(拿到 ${typeName(def)})`)
      if (t === 'select' && typeof def !== 'string') bad(key, `字段「${key}」是 select 但 def 不是字符串(拿到 ${typeName(def)})`)
      if (t === 'select' && typeof def === 'string' && options.length && !options.some((o) => o.value === def)) {
        bad(key, `字段「${key}」的默认值「${def}」不在 options 里`)
      }
      if ((t === 'text' || t === 'textarea' || t === 'regex') && typeof def !== 'string') bad(key, `字段「${key}」是 ${t} 但 def 不是字符串(拿到 ${typeName(def)})`)
      if (t === 'files' && !Array.isArray(def)) bad(key, `字段「${key}」是 files 但 def 不是数组(拿到 ${typeName(def)});预置选中项要写成 rel 字符串数组`)
      if (t === 'files' && Array.isArray(def)) {
        for (let k = 0; k < def.length; k++) {
          const s = def[k]
          if (typeof s !== 'string' || !isInsidePath(s)) bad(key, `字段「${key}」的 def 第 ${k + 1} 项不是项目内相对路径:${JSON.stringify(s)}`)
        }
        if (!multiple && Array.isArray(def) && def.length > 1) bad(key, `字段「${key}」是单选 files(multiple:false)但 def 给了 ${def.length} 项`)
      }
    }

    fields.push({
      key, type: t, label, help, required,
      def: normalizeDef(t, def),
      min, max, options, exts, multiple, placeholder
    })
  }

  if (issues.length) return { ok: false, fields, issues }
  return { ok: true, fields }
}

/** 缺省默认值:按类型给「最不动东西」的那一侧 —— 布尔给 false,字符串给空,数字给 null 语义的空(交给必填校验) */
function normalizeDef(t: FieldType, def: unknown): unknown {
  if (def !== undefined) return def
  if (t === 'boolean') return false
  if (t === 'files') return []
  if (t === 'number') return null
  return ''
}

/** 只取合法字段:作者写错时视图仍能画出好的那些(整页白屏是最糟的收法) */
export function usableFields(res: SchemaResult): FieldDesc[] {
  return res.ok ? res.fields : res.fields.filter((f) => f && typeof f.key === 'string')
}

/** 表单初值:每项取 def(files 复制数组,免得插件改到同一份引用) */
export function defaultsOf(fields: readonly FieldDesc[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  // 显式标注不是洁癖:`Array.isArray` 的守卫签名会把 `readonly FieldDesc[]` 收窄成 `any[]`,
  // 于是 f.options 的回调参数全成隐式 any(typecheck 是三门之一,不许漂过去)。
  const list: readonly FieldDesc[] = Array.isArray(fields) ? fields : []
  for (const f of list) {
    if (!f || typeof f.key !== 'string') continue
    out[f.key] = f.type === 'files' && Array.isArray(f.def) ? [...f.def] : f.def
  }
  return out
}

export type ParamResult =
  | { ok: true; values: Record<string, unknown> }
  | { ok: false; values: Record<string, unknown>; issues: SchemaIssue[] }

/**
 * 校验用户在表单里填的值。
 *
 * UI 传进来的东西一律当不可信:字段可能整个缺失(新加的字段还没填)、数字可能是字符串
 * (input 的 value 天生是串)、select 可能被塞进枚举外的值(files 可能带着绝对路径)。
 * 判据方向与 `buildPlan` 一致 —— **报错而不是猜**:不做「夹到边界」这种看起来友好的静默修正,
 * 因为参数是插件要拿去改写用户源文件的,静默改值等于框架替用户改了主意。
 */
export function resolveParams(fields: readonly FieldDesc[], raw: unknown): ParamResult {
  const issues: SchemaIssue[] = []
  const values: Record<string, unknown> = {}
  const input = isPlainObject(raw) ? raw : {}

  // 显式标注不是洁癖:`Array.isArray` 的守卫签名会把 `readonly FieldDesc[]` 收窄成 `any[]`,
  // 于是 f.options 的回调参数全成隐式 any(typecheck 是三门之一,不许漂过去)。
  const list: readonly FieldDesc[] = Array.isArray(fields) ? fields : []
  for (const f of list) {
    if (!f || typeof f.key !== 'string') continue
    const given = input[f.key]
    // 只有空白的输入框等于没填:用户在 DOM 里清空一个 input,传回来的是 ' ' 或 ''。
    // 把它当「填了一个坏值」去报「要填数字」是噪音,而当「没填」补默认值才是表单该有的行为。
    const missing = given === undefined || given === null || (typeof given === 'string' && !given.trim())

    if (missing) {
      if (f.required) {
        issues.push({ key: f.key, message: `「${f.label || f.key}」是必填的,没填就没法算` })
        continue
      }
      values[f.key] = f.type === 'files' && Array.isArray(f.def) ? [...f.def] : f.def
      continue
    }

    switch (f.type) {
      case 'number': {
        const n = typeof given === 'number' ? given : (typeof given === 'string' && given.trim() && Number.isFinite(Number(given)) ? Number(given) : NaN)
        if (!Number.isFinite(n)) { issues.push({ key: f.key, message: `「${f.label || f.key}」要填数字,拿到的是${typeName(given)}` }); break }
        if (f.min !== null && n < f.min) { issues.push({ key: f.key, message: `「${f.label || f.key}」不能小于 ${f.min}(现在填的是 ${n})` }); break }
        if (f.max !== null && n > f.max) { issues.push({ key: f.key, message: `「${f.label || f.key}」不能大于 ${f.max}(现在填的是 ${n})` }); break }
        values[f.key] = n
        break
      }
      case 'boolean': {
        if (typeof given !== 'boolean') {
          // 复选框在真实 DOM 里给的是 'true'/'false' 串或 0/1:只认这三形态,别的仍报错
          if (given === 'true') values[f.key] = true
          else if (given === 'false') values[f.key] = false
          else issues.push({ key: f.key, message: `「${f.label || f.key}」是勾选框,拿到的是${typeName(given)}` })
        } else values[f.key] = given
        break
      }
      case 'select': {
        const v = String(given)
        if (!f.options.some((o) => o.value === v)) {
          issues.push({ key: f.key, message: `「${f.label || f.key}」的值「${v}」不在可选项里(可选:${f.options.map((o) => o.value).join(' / ') || '无'})` })
          break
        }
        values[f.key] = v
        break
      }
      case 'regex':
      case 'text':
      case 'textarea': {
        if (typeof given !== 'string') { issues.push({ key: f.key, message: `「${f.label || f.key}」要填文本,拿到的是${typeName(given)}` }); break }
        if (f.type === 'regex') {
          const err = compileError(given)
          if (err) { issues.push({ key: f.key, message: `「${f.label || f.key}」这条正则编译不过:${err}` }); break }
        }
        values[f.key] = given
        break
      }
      case 'files': {
        const list = Array.isArray(given) ? given : [given]
        const okList: string[] = []
        for (let i = 0; i < list.length; i++) {
          const s = list[i]
          const rel = typeof s === 'string' ? s.trim() : ''
          if (!rel || !isInsidePath(rel)) {
            issues.push({ key: f.key, message: `「${f.label || f.key}」第 ${i + 1} 个文件不是项目内的相对路径:${JSON.stringify(s)}` })
            continue
          }
          if (f.exts.length && !f.exts.includes(rel.includes('.') ? rel.slice(rel.lastIndexOf('.') + 1).toLowerCase() : '')) {
            issues.push({ key: f.key, message: `「${f.label || f.key}」里的 ${rel} 不属于这个工具挑的扩展名(${f.exts.join('/')})` })
            continue
          }
          if (!okList.includes(rel)) okList.push(rel)
          if (!f.multiple && list.length > 1) {
            issues.push({ key: f.key, message: `「${f.label || f.key}」是单选,给了 ${list.length} 个` })
            break
          }
        }
        if (!okList.length && !issues.some((x) => x.key === f.key)) {
          issues.push({ key: f.key, message: `「${f.label || f.key}」一个文件都没选中:没有输入就没得算` })
          break
        }
        values[f.key] = okList
        break
      }
      default:
        issues.push({ key: f.key, message: `字段「${f.key}」的类型「String(f.type)」框架不认识` })
    }
  }

  // 未知 key 不报错也不往下传:表单里多出来的键多半是字段改名后的残留,
  // 传进 plan() 只会让插件读到它没声明过的东西。
  if (issues.length) return { ok: false, values, issues }
  return { ok: true, values }
}

/** 正则只编译不执行:先看能不能编译,能不能编译决定要不要在表单上标红 */
function compileError(pattern: string): string {
  try {
    new RegExp(pattern)
    return ''
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

/**
 * 「匹配到几处」——§5.8 明说 regex 第 1 批**只显示计数,不做高亮**。
 * 为什么不提取匹配内容给用户看:格式化那类工具的正则是拿来挑「哪些行归我管」的,
 * 计数够用户判断规则对不对;提取出来的片段要排版进 UI,又会引出一套第二真相。
 *
 * 空串 / 编译不过 / 非字符串 ⇒ {ok:false,error},绝不抛异常(表单每敲一个字都会调这里)。
 * `text` 非字符串当空文本处理:上游是宿主读回来的正文,可能缺字段。
 */
export function regexHits(pattern: unknown, text: unknown): { ok: boolean; count: number; error: string } {
  if (typeof pattern !== 'string' || !pattern) return { ok: false, count: 0, error: '正则是空的' }
  const err = compileError(pattern)
  if (err) return { ok: false, count: 0, error: err }
  const body = typeof text === 'string' ? text : ''
  if (!body) return { ok: true, count: 0, error: '' }
  try {
    const re = new RegExp(pattern, 'g')
    let count = 0
    let m: RegExpExecArray | null
    let guard = 0
    for (;;) {
      m = re.exec(body)
      if (!m) break
      // 零宽匹配必须手动前移,否则 exec 会永远停在同一个位置(while 死循环是界面冻结的形态)
      if (m[0].length === 0) re.lastIndex++
      count++
      if (++guard > 1_000_000) return { ok: false, count, error: '匹配数超过 100 万,先停在这里(规则大概写错了)' }
    }
    return { ok: true, count, error: '' }
  } catch (e) {
    return { ok: false, count: 0, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 表单渲染要的那句「必填 / 有默认值」的话(措辞唯一来源) */
export function fieldHint(f: FieldDesc): string {
  const parts: string[] = []
  if (f.required) parts.push('必填')
  if (f.min !== null || f.max !== null) {
    parts.push(f.min !== null && f.max !== null ? `${f.min} 到 ${f.max}` : f.min !== null ? `不小于 ${f.min}` : `不大于 ${f.max}`)
  }
  if (f.type === 'files') parts.push(f.multiple ? '可多选' : '单选')
  if (f.exts.length) parts.push(`限 ${f.exts.map((e) => '.' + e).join('/')}`)
  return parts.join(' · ')
}
