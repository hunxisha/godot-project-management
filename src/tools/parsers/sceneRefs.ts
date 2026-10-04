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

/**
 * 只有这两个后缀是文本资源文件(头部带 `uid=`、正文带 `[ext_resource]`)。
 * 唯一的一份:brokenRefs 决定「读哪些文件」、uid 决定「读哪批文件的头部」都吃这里
 * (B4 评审挂账,B6 收口 —— 同一个判定抄第二份就是将来分叉的地方)。
 */
export const SCENE_EXT = new Set(['tscn', 'tres'])

/**
 * 从段头/头部文本里取 `key="value"` 的值,取**第一个**匹配(非全局正则的 exec 天然首匹配),
 * 取不到给空串。B4 的 `uid.ts` 读场景头部 uid 也走这里,不再自己抄一条正则。
 *
 * ⚠ `key` 会被插进 RegExp 里(`\\b${key}=…`),所以**必须是字面量,不接受外部数据** ——
 *   传进用户串或解析出来的串就是正则注入面(调用方只有本文件的 parseExtResources 与 uid.ts 的 headerUid,
 *   两处都是硬编码的键名)。要按变量取键请走 godotIni,别扩这里的入参。
 */
export function attr(head: string, key: string): string {
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
 * 不归一就永远对不上 —— 而且归一**不止**是换斜杠:切段后吃掉空段与 `.` 段
 * (`res://./a` → `a`、`res://a//b` → `a/b`),`..` 越界判 null,与树 rel 的生产闸
 * `resolveRel`(src-ztools/preload/lib/inspectfs.js:37-50)同规则。旧实现不归一,
 * 交回 `./a`、`a//b` 这类在归一过的树里**永远查不到**的 rel,断链检查会误报缺文件。
 * `user://`(运行时可写目录)与绝对路径不在项目树里,判不了存在性,一律不解析。
 */
export function resToRel(p: string): string | null {
  if (typeof p !== 'string' || !p.startsWith('res://')) return null
  const rest = p.slice('res://'.length).replace(/\\/g, '/')
  if (/^[a-zA-Z]:/.test(rest)) return null // res://C:/… 形态:树 rel 恒无盘符,同 resolveRel 的拒法
  const stack: string[] = []
  for (const seg of rest.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') return null
    stack.push(seg)
  }
  return stack.length ? stack.join('/') : null
}

/**
 * `.tscn/.tres` 头部的 load_steps 计数。**引擎不变式:`load_steps = ext_resource 数
 * + sub_resource 数 + 1`**,+1 是资源文件自身。规范形:1 个 ext_resource 的场景头部
 * 写 `gd_scene load_steps=2`;2 ext + 5 sub 的场景写 `load_steps=8`。所以三个字段是:
 *   · `actual`   = ext + sub(纯引用条数,**不是**可比值 —— 拿它和 load_steps 直接比,
 *                  对每一个引擎写出的场景都恰好差 1,场景体检会把全量真场景误报成不符)
 *   · `expected` = actual + 1(头部应然值;判「声明与实际不符」必须比这个)
 *   · `declared` = 头部读到的值;**0 表示 `load_steps` 属性缺失**(Godot 允许省略该键,
 *                  臆造成 1 会造假阳性),调用方不得拿 0 当声明值去比对 —— 先判
 *                  declared > 0 才比 declared === expected。
 * (docs/tools-page-plan.md §3.2 #13 场景体检按本口径执行,旧文的「与实际条数不符」
 * 等价式已随本轮修正。)
 */
export function countSteps(text: string): { declared: number; actual: number; expected: number } {
  const m = /\bload_steps=(\d+)/.exec(String(text || ''))
  let actual = 0
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim()
    if (t.startsWith('[ext_resource') || t.startsWith('[sub_resource')) actual++
  }
  return { declared: m ? Number(m[1]) : 0, actual, expected: actual + 1 }
}
