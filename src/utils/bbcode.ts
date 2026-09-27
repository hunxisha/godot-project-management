// Godot 类文档描述是 BBCode(非 HTML)。本模块把 BBCode 解析成 token 序列,
// 交给 Vue 组件按 token 类型渲染 —— 全程文本插值转义,不使用 v-html。
//
// 降级原则:识别不了的标签一律按字面文本保留,内容永不丢失(策划书 5.2 节)。
// 嵌套只处理样式标签(b/i/u/s)包裹任意内容;code/codeblock 内部不解析(原样保留)。

export type BBStyle = 'bold' | 'italic' | 'underline' | 'strike' | 'center'

export type BBToken =
  | { t: 'text', v: string }
  | { t: 'code', v: string }
  | { t: 'codeblock', v: string }
  | { t: 'style', style: BBStyle, children: BBToken[] }
  /** 站内引用:[method add_child] / [member owner] / [SceneTree] … */
  | { t: 'ref', kind: string, target: string }
  | { t: 'url', href: string, label: string }
  | { t: 'br' }

/** 简单样式标签名 → token style */
const STYLE_TAGS: Record<string, BBStyle> = { b: 'bold', i: 'italic', u: 'underline', s: 'strike', center: 'center' }

/** 带目标参数的引用标签(标签名 kind,后面跟目标符号) */
const REF_KINDS = new Set(['method', 'member', 'constant', 'signal', 'enum', 'param', 'theme_item', 'annotation'])

/** 裸类名引用:[Node] / [Vector2] / [@GlobalScope] */
const BARE_CLASS_RE = /^@?[A-Za-z][A-Za-z0-9_]*$/

/** 嵌套深度上限(防御异常输入,正常文档不会超过 3 层) */
const MAX_DEPTH = 8

/**
 * 找到配对闭合标签 [/${tag}] 的位置;找不到返回 -1。
 */
function findClosing(src: string, tag: string, from: number): number {
  return src.indexOf(`[/${tag}]`, from)
}

/**
 * 解析 BBCode 为 token 序列。
 * @param src 原文
 * @param depth 递归深度(内部用)
 */
export function tokenizeBBCode(src: string, depth = 0): BBToken[] {
  const text = String(src || '')
  /** @type {BBToken[]} */
  const tokens: BBToken[] = []
  const pushText = (v: string) => { if (v) tokens.push({ t: 'text', v }) }
  let i = 0
  const n = text.length
  // 超深嵌套直接放弃解析,整段按纯文本降级
  if (depth > MAX_DEPTH) return [{ t: 'text', v: text }]

  while (i < n) {
    const open = text.indexOf('[', i)
    if (open < 0) { pushText(text.slice(i)); break }
    if (open > i) pushText(text.slice(i, open))
    const close = text.indexOf(']', open)
    if (close < 0) { pushText(text.slice(open)); break }
    const rawTag = text.slice(open + 1, close)

    // 孤立闭合标签或带等号但非 url 的标签:按字面降级
    if (rawTag.startsWith('/')) {
      pushText(text.slice(open, close + 1))
      i = close + 1
      continue
    }

    // [codeblock] 与 [code]:内部原样保留,不解析任何标签
    if (rawTag === 'codeblock' || rawTag.startsWith('codeblock=') || rawTag === 'code' || rawTag.startsWith('code=')) {
      const kind = rawTag.startsWith('codeblock') ? 'codeblock' : 'code'
      const inner = findClosing(text, kind, close + 1)
      if (inner < 0) {
        // 没有闭合:整个 remainder 按字面降级
        pushText(text.slice(open))
        i = n
      } else {
        tokens.push({ t: kind, v: text.slice(close + 1, inner) })
        i = inner + kind.length + 3
      }
      continue
    }

    // [br] → 换行
    if (rawTag === 'br') {
      tokens.push({ t: 'br' })
      i = close + 1
      continue
    }

    // [url=href]label[/url] 或 [url]href[/url]
    if (rawTag.startsWith('url=')) {
      const href = rawTag.slice(4).replace(/^["']|["']$/g, '')
      const end = findClosing(text, 'url', close + 1)
      if (end < 0) {
        pushText(text.slice(open))
        i = n
      } else {
        tokens.push({ t: 'url', href, label: text.slice(close + 1, end) })
        i = end + 6
      }
      continue
    }
    if (rawTag === 'url') {
      const end = findClosing(text, 'url', close + 1)
      if (end < 0) {
        pushText(text.slice(open))
        i = n
      } else {
        const href = text.slice(close + 1, end)
        tokens.push({ t: 'url', href, label: href })
        i = end + 6
      }
      continue
    }

    // [method X] / [member X] …(也兼容 [method=X] 写法)
    const sp = rawTag.search(/[ =]/)
    const head = sp < 0 ? rawTag : rawTag.slice(0, sp)
    if (sp > 0 && REF_KINDS.has(head)) {
      const target = rawTag.slice(sp + 1).trim()
      if (target) {
        tokens.push({ t: 'ref', kind: head, target })
        i = close + 1
        continue
      }
    }

    // 样式标签 [b]…[/b]:内容递归解析,保留内部引用
    if (STYLE_TAGS[head] && (sp < 0)) {
      const style = STYLE_TAGS[head]
      const end = findClosing(text, head, close + 1)
      if (end < 0) {
        pushText(text.slice(open))
        i = n
      } else {
        tokens.push({ t: 'style', style, children: tokenizeBBCode(text.slice(close + 1, end), depth + 1) })
        i = end + head.length + 3
      }
      continue
    }

    // 裸类名 [Node] / [@GlobalScope]
    if (BARE_CLASS_RE.test(rawTag)) {
      tokens.push({ t: 'ref', kind: 'class', target: rawTag })
      i = close + 1
      continue
    }

    // 其余一律字面降级
    pushText(text.slice(open, close + 1))
    i = close + 1
  }
  return tokens
}

/**
 * 提取纯文本(收藏悬浮提示/无富文本场景用)。
 */
export function bbToPlainText(tokens: BBToken[]): string {
  const out: string[] = []
  for (const tk of tokens) {
    if (tk.t === 'text') out.push(tk.v)
    else if (tk.t === 'code' || tk.t === 'codeblock') out.push(tk.v)
    else if (tk.t === 'style') out.push(bbToPlainText(tk.children))
    else if (tk.t === 'url') out.push(tk.label)
    else if (tk.t === 'br') out.push(' ')
  }
  return out.join('')
}
