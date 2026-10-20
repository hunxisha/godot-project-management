// 文档签名着色:把方法/成员/信号/枚举/常量/运算符的结构化字段切成 token。
//
// 角色与代码块同一套 12 个 --syn-*(见 docs/theme-system.md),组件只渲染 .tok-*:
//   kw  限定词与 signal/enum/const,以及 enum:: / bitfield:: 这类类型前缀
//   fn  方法、信号、运算符名(可调用的东西)
//   mem 成员名(你读写的属性)
//   tyb/tye/tyu  基础类型 / 引擎类型 / 其余具名类型(含常量名、枚举名)
//   num/str/kw  默认值与枚举值里的字面量(交给 highlightCode,和代码块一致)
//   sym  冒号、等号、箭头、括号、点号
//   ''  参数名(继承正文色,不和类型抢注意力)
//
// 不变量:token 的 v 按序拼接 === 对应的纯文本签名(sigText)。显示与复制共用同一套拼法,
// 由 src/__tests__/docSig.test.mjs 断言。内容只上色,不改写(enum:: 前缀原样保留)。

import { highlightCode, typeRole, type HLToken } from './highlight'

/** b=true 的 token 是这一行的名字,渲染时加粗 */
export interface SigToken extends HLToken {
  b?: boolean
}

export interface SigParam {
  name: string
  type: string
  defaultValue?: string
}

export interface SigCallable {
  name: string
  returnType: string
  params: SigParam[]
  qualifiers?: string[]
}

const tok = (c: string, v: string, b = false): SigToken => (b ? { c, v, b } : { c, v })

/** 拼接回纯文本。空 token 列表得到空串。 */
export function sigText(tokens: SigToken[]): string {
  return tokens.map((t) => t.v).join('')
}

function isIdStart(ch: string): boolean {
  return /[A-Za-z_]/.test(ch)
}

/** 顶层逗号切开泛型实参,逗号及其后的空白原样留在分隔符里 */
function splitArgs(inner: string): { text: string, sep: string }[] {
  const parts: { text: string, sep: string }[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]
    if (ch === '[') depth++
    else if (ch === ']') depth = Math.max(0, depth - 1)
    else if (ch === ',' && depth === 0) {
      let j = i + 1
      while (j < inner.length && (inner[j] === ' ' || inner[j] === '\t')) j++
      parts.push({ text: inner.slice(start, i), sep: inner.slice(i, j) })
      start = j
      i = j - 1
    }
  }
  parts.push({ text: inner.slice(start), sep: '' })
  return parts
}

function bracketEnd(src: string, open: number): number {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '[') depth++
    else if (src[i] === ']') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** 一段不含泛型括号的类型碎片:标识符按类型上色,其余标点走 sym,空白原样 */
function emitHead(head: string, out: SigToken[]): void {
  let i = 0
  while (i < head.length) {
    const ch = head[i]
    if (isIdStart(ch)) {
      let j = i + 1
      while (j < head.length && /[A-Za-z0-9_]/.test(head[j])) j++
      const id = head.slice(i, j)
      out.push(tok(id === 'void' ? 'tyb' : typeRole(id), id))
      i = j
      continue
    }
    let j = i + 1
    while (j < head.length && !isIdStart(head[j])) j++
    const chunk = head.slice(i, j)
    out.push(tok(/^\s+$/.test(chunk) ? '' : 'sym', chunk))
    i = j
  }
}

const TYPE_PREFIX = /^(enum|bitfield|typedarray)::/

/** 类型串 → token。enum:: / bitfield:: / typedarray:: 前缀按关键字,泛型实参递归。字符不丢。 */
export function typeTokens(raw: string): SigToken[] {
  const out: SigToken[] = []
  emitType(String(raw ?? ''), out)
  return out
}

function emitType(src: string, out: SigToken[]): void {
  if (!src) return
  const prefixed = TYPE_PREFIX.exec(src)
  let rest = src
  if (prefixed) {
    out.push(tok('kw', prefixed[1]))
    out.push(tok('sym', '::'))
    rest = src.slice(prefixed[0].length)
  }
  const open = rest.indexOf('[')
  if (open < 0) {
    emitHead(rest, out)
    return
  }
  emitHead(rest.slice(0, open), out)
  const close = bracketEnd(rest, open)
  if (close < 0) {
    out.push(tok('sym', rest.slice(open)))
    return
  }
  out.push(tok('sym', '['))
  const inner = rest.slice(open + 1, close)
  if (inner) {
    for (const part of splitArgs(inner)) {
      emitType(part.text, out)
      if (part.sep) out.push(tok('sym', part.sep))
    }
  }
  out.push(tok('sym', ']'))
  if (close + 1 < rest.length) emitHead(rest.slice(close + 1), out)
}

function paramTokens(params: SigParam[], withDefault: boolean): SigToken[] {
  const out: SigToken[] = []
  params.forEach((p, i) => {
    if (i) out.push(tok('sym', ', '))
    out.push(tok('', p.name))
    out.push(tok('sym', ': '))
    out.push(...typeTokens(p.type))
    if (withDefault && p.defaultValue !== undefined) {
      out.push(tok('sym', ' = '))
      out.push(...highlightCode(String(p.defaultValue)))
    }
  })
  return out
}

/** 参数列表的纯文本。withDefault=false 时不带默认值(信号/运算符的现有展示) */
export function paramListText(params: SigParam[], withDefault = true): string {
  return params.map((p) => {
    const d = withDefault && p.defaultValue !== undefined ? ` = ${p.defaultValue}` : ''
    return `${p.name}: ${p.type}${d}`
  }).join(', ')
}

/** 方法正文(不含限定词):name(a: Type = default, ...) -> Ret */
export function methodText(m: SigCallable): string {
  return `${m.name}(${paramListText(m.params, true)}) -> ${m.returnType}`
}

export function methodTokens(m: SigCallable): SigToken[] {
  return [
    tok('fn', m.name, true),
    tok('sym', '('),
    ...paramTokens(m.params, true),
    tok('sym', ')'),
    tok('sym', ' -> '),
    ...typeTokens(m.returnType)
  ]
}

/** 信号展示:signal name(a: Type, ...) */
export function signalText(s: { name: string, params: SigParam[] }): string {
  return `signal ${s.name}(${paramListText(s.params, false)})`
}

export function signalTokens(s: { name: string, params: SigParam[] }): SigToken[] {
  return [
    tok('kw', 'signal'),
    tok('', ' '),
    tok('fn', s.name, true),
    tok('sym', '('),
    ...paramTokens(s.params, false),
    tok('sym', ')')
  ]
}

export function memberTokens(mb: { type: string, name: string, defaultValue?: string }): SigToken[] {
  const out: SigToken[] = [
    ...typeTokens(mb.type),
    tok('', ' '),
    tok('mem', mb.name, true)
  ]
  if (mb.defaultValue !== undefined) {
    out.push(tok('sym', ' = '))
    out.push(...highlightCode(String(mb.defaultValue)))
  }
  return out
}

/** enum 头(不含 flags 徽标,那个保持警告色由模板单独画) */
export function enumHeaderTokens(e: { name: string }): SigToken[] {
  return [tok('kw', 'enum'), tok('', ' '), tok('tyu', e.name, true)]
}

export function enumValueTokens(v: { name: string, value: string }): SigToken[] {
  return [tok('tyu', v.name, true), tok('sym', ' = '), ...highlightCode(String(v.value ?? ''))]
}

export function constantTokens(c: { name: string, value: string }): SigToken[] {
  return [
    tok('kw', 'const'),
    tok('', ' '),
    tok('tyu', c.name, true),
    tok('sym', ' = '),
    ...highlightCode(String(c.value ?? ''))
  ]
}

export function operatorText(op: SigCallable): string {
  return `${op.name || 'op'}(${paramListText(op.params, false)}) -> ${op.returnType}`
}

export function operatorTokens(op: SigCallable): SigToken[] {
  return [
    tok('fn', op.name || 'op', true),
    tok('sym', '('),
    ...paramTokens(op.params, false),
    tok('sym', ')'),
    tok('sym', ' -> '),
    ...typeTokens(op.returnType)
  ]
}
