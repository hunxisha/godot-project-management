// .tscn/.tres 的文本解析(纯函数,可单测)。设计见 docs/tools-page-plan.md §3.1 #4。
//
// 只认 `[ext_resource ...]` 行里的 key="value"。Godot 的文本格式允许 value 含 `]`
// (罕见),所以我们按 key 抓值而不是整行切分 —— 宁可漏,不可错。
//
// 不跨行是硬要求:.tscn 里每个段头各占一行,跨行匹配会把下一段的属性拼进当前引用,
// 于是断链检查报出根本不存在的引用。逐行判定同时天然挡住了 `[node ...]` 与文件头。

export interface ExtRef {
  type: string
  uid: string
  path: string
  id: string
}

function attr(head: string, key: string): string {
  const m = new RegExp(`\\b${key}="([^"]*)"`).exec(head)
  return m ? m[1] : ''
}

/** 逐行抓 `[ext_resource ...]`;不跨行、不去重(顺序即文件顺序) */
export function parseExtResources(text: string): ExtRef[] {
  const out: ExtRef[] = []
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim()
    if (!t.startsWith('[ext_resource')) continue
    const head = t.slice(t.indexOf('[') + 1, t.lastIndexOf(']'))
    out.push({ type: attr(head, 'type'), uid: attr(head, 'uid'), path: attr(head, 'path'), id: attr(head, 'id') })
  }
  return out
}

/**
 * `res://a/b.png` → `a/b.png`;非 res://、裸 `res://`、空值返回 null。
 *
 * 反斜杠归成正斜杠:原语层给出的 rel 只会是正斜杠(inspectfs.js / Rust 两侧同形),
 * 不归一就永远对不上 —— 而且 `.replace` 只作用于 res:// 之后的部分,不受盘符影响。
 * `user://`(运行时可写目录)与绝对路径不在项目树里,判不了存在性,一律不解析。
 */
export function resToRel(p: string): string | null {
  if (typeof p !== 'string' || !p.startsWith('res://')) return null
  const rel = p.slice('res://'.length).replace(/\\/g, '/')
  return rel && rel !== '/' ? rel : null
}

/**
 * load_steps 声明值 vs 实际(ext_resource + sub_resource 条数)。
 * 缺 load_steps 记 0:Godot 允许省略该键,臆造成 1 会把「声明与实际不符」变成误报。
 */
export function countSteps(text: string): { declared: number; actual: number } {
  const m = /\bload_steps=(\d+)/.exec(String(text || ''))
  let actual = 0
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim()
    if (t.startsWith('[ext_resource') || t.startsWith('[sub_resource')) actual++
  }
  return { declared: m ? Number(m[1]) : 0, actual }
}
