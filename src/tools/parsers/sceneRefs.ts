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

/**
 * `resToRel` 之前的**形状前置闸**(共享):这个值串是不是一条「干净的 res:// 项目路径写法」?
 *
 * 为什么要单独出一份(B8 修复轮 Important 2):`resToRel` 忠实得可怕 —— 它不 trim、也不看标点,
 * 所以 `res://a.gd ` 归一出 `a.gd `(带尾空格)、`res://a.gd,` 归一出 `a.gd,`。那两条串拿去比清单
 * **永远查不到**,于是「配置点名的文件不在本次文件清单里」的 error 就落在了一个其实存在的文件上
 * (§6 的头号失败模式:虚假的「你的配置坏了」)。尾逗号不是假想形态:本仓那两份孪生解析器都对值做
 * `trim_end_matches(',')` / `replace(/,\s*$/,'')`(见上面 godotIni.ts:15-16 记下的分叉),
 * 说明「值尾巴上有逗号」是真实写盘/手写里会出现的东西。
 *
 * 闸只做**首尾**判断,不碰内部:`res://my scene.tscn` 里的空格是合法的(Godot 允许路径含空格,
 * godotIni.ts:290 明写这条),内部空白/半个引号那种「裸值混了别的东西」是各调用方自己的事
 * (ini.ts 的裸值另有一道更严的闸),这一份只管「切出来的 rel 会不会带上不属于路径的尾巴」。
 *
 * 放在本文件而不是 treeUtils:treeUtils 的口径是「进 TreeEntry[]、出统计」(见它的文件头),
 * 而这条判的是**一个值串**的形状;判 resToRel 的入参归 resToRel 的模块管,才不会再长出第二份 rel 语义。
 *
 * 面向 B10:`brokenRefs` 的存在性判定与 `addons` 的存在性两档走的是同一个形状
 * (`resToRel(...)` → `hasRelCI`),要接这条闸就在 resToRel 之前加一次 `resPathShapeOk(value)`,
 * 不判的条数并入各自的排除计数。**B10b 已把这两扇门指过来**(债清单 6 收口),两侧各自多挡的形态不同:
 *   · `brokenRefs` 吃的是 `attr()` 的引号**内文**,首尾空白与尾巴标点两样都归这条闸管;
 *   · `addons` 的 `filled()` 已经 trim 过,所以那边真正多挡的只有尾巴标点一类
 *     (计数因此分成 `shapeScript`/`shapeEnabled` 两档各自的措辞,不与「不是 res:// 写法」混记)。
 * 两侧采的都是**只撤主张**的方向:过闸的值判定路径一字未改,不过闸的只并进排除计数。
 * 收集面(refIndex/godotIni)那一侧的方向纪律相反(宁多勿少,少收一条引用就会多一个孤儿),
 * 见 refIndex.ts 的 `add()` 注释 —— 同一条闸在两处用法不同,不是分叉。
 *
 * 红线:纯函数,不抛错;非字符串 / 空串一律 false(方向是少报)。
 */
export function resPathShapeOk(value: string): boolean {
  if (typeof value !== 'string' || !value) return false
  // 首尾空白:引号里的 `res://a.gd ` 解码后仍带那个空格,而 rel 的生产端(原语层)不会给出尾巴空格
  if (value !== value.trim()) return false
  // 尾部标点:`,` `;` `)` `]` 都是「值到这里结束了」的分隔符,不是路径的一部分(孪生解析器会剥掉尾逗号)
  return !/[,;)\]]$/.test(value)
}
