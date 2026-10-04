// `project.godot`(Godot 的 INI 变体)的文本解析(纯函数,可单测)。设计见 docs/tools-page-plan.md
// §3.1 #3(配置校验)/ #5(UID)/ #6(孤儿资产),台账 Ruling B2。
//
// ⚠ 与仓库里另外两份 project.godot 解析器**并存**,这是刻意付出的代价(台账 Ruling B2),
//   靠 godotIni.test.mjs 的断言钉住,别让分叉悄悄扩大。两份孪生各引各的:
//     · src-ztools/preload/lib/projects.js:26-67  parseProjectGodot(JSDoc :25-29,函数体 :30 起)
//     · src-tauri/src/projects.rs:10-45           parse_project_godot_text(同一语义的两端实现)
//   它们只抽 name / config_version / config/icon / config/features / editor_plugins.enabled
//   五个字段就返回,其余整行丢弃,既没有行号也没有「这行我没看懂」的回报;而工具页
//   (B8 配置校验、B3 引用索引)要的是**全量、文件序、带行号、重复键不合并**的一份文档 +
//   归不进键值的行(problems)。判定逻辑留在 preload 就没法在 Node 里单测
//   (spec 待确认 #3 的默认口径也是「渲染层新写」)。逐条分叉(测试里以 [分叉] 标注):
//     · 键名筛选:preload 用 `^[\w./]+` 挑键(projects.js:47),键名带 `-`/`#`/引号的行**整行静默丢掉**;
//       Rust 用 `split_once('=')`(projects.rs:24)与本模块一样按第一个 `=` 切,但只留那五个键。
//     · 尾部逗号:两份都对 value 做 `trim_end_matches(',')` / `replace(/,\s*$/,'')`,
//       本模块的 raw 只 trim 两端、不吃尾逗号(判「写成什么」要靠原文)。
//     · config_version:两份都**不看段名**(段内的同名键会冒领项目版本号);preload 用
//       `parseInt(v,10)||0`,`5x` 读成 5,而 Rust 的 `value.parse::<u32>()` 给 0 —— 两份彼此也不一致。
//       本模块只认 section 为空串的顶层那条,非裸整数一律 0 并进 problems。
//     · 引号:两份的 unquote(projects.js:74 / projects.rs:47)只剥外层引号、不解转义;
//       本模块 getIni 剥一层并解码 \n \t \r \" \\。
//     · 段头:两份都不 trim 括号内空白(projects.js:42 的 `\[(.+)\]`、projects.rs:20 的切片),
//       所以 `[ display ]` 会让 `editor_plugins` 判定落空;本模块 trim 段头内空气(判据 3)。
//     · 多行块:两份都没有「块」概念,块内行最终都留不住 —— 不含 `=` 的行:preload 的
//       `^\s*([\w./]+)\s*=`(projects.js:47)匹配不到、Rust 的 `split_once('=')` 给 None
//       (projects.rs:24),都是整行跳过。含 `=` 的行(如块里的 `"physical_keycode=-1, string=\"a]b\""`):
//       preload **同样**匹配不到(键位以 `"` 开头,`[\w./]` 里没有引号),整行丢掉;Rust 会切成
//       key=`"physical_keycode`,但对那五个键之外的键名直接 `_ => {}`(projects.rs:41)丢弃。
//       本模块按配平吃整块(判据 4)。
//
// 红线:纯函数,不碰 window / services / vue / DOM —— 读文件交给调用方(B3 的 readText)。
// 每个函数对 undefined / 非字符串输入都不许抛错(与 treeUtils.ts 同一口径)。

/** 一条 `key=value`;raw 是 `=` 右侧原样文本(未去引号、未解码),多行值是整个 blob */
export interface IniValue {
  /** '' = 任何段头之前的顶层键(config_version 就在这里) */
  section: string
  /** 原样,含 `/` 与 `.`(如 `application/config/name` 里的 `config/name`) */
  key: string
  raw: string
  /** 1-based,值开始那一行 */
  line: number
  /** 多行值的最后一行;单行时 === line */
  endLine: number
}

/** 归不进 key=value 的行(判据 6):reason 要能分出「缺 =」与「段头不闭合」 */
export interface IniProblem {
  line: number
  text: string
  reason: string
}

export interface IniDoc {
  /** 文件顺序,**重复键全部保留**(B8 判「重复键」唯一的证据来源) */
  values: IniValue[]
  problems: IniProblem[]
  /** 0 = 头部没有 config_version;**不得臆造成 5**(3.x 项目会因此被冒领 4.x 规则) */
  configVersion: number
}

/** 一条项目内路径引用;path 保留 `res://` 前缀,归一成 rel 的活交给调用方(sceneRefs.resToRel) */
export interface IniResPath {
  path: string
  fullKey: string
  line: number
}

// reason 文案:B8 的结论直接用它们成句,所以「缺 =」与「段头不闭合」必须是两句不同的话(判据 6)。
const REASON_NO_EQ = '这一行没有 = 号,归不进 key=value'
const REASON_BAD_HEAD = '段头不闭合:缺少右方括号 ]'
const REASON_NO_KEY = '= 号前没有键名'
const REASON_OPEN_BLOCK = '多行块未闭合:到文件尾括号仍未配平'
const REASON_ODD_QUOTE = '括号块的起始行有半个引号,本行按单行值保留(不吞掉后续行)'
const REASON_BAD_VERSION = 'config_version 不是裸整数'

/** 解码集:简报钉死的这五种;`\u`/`\x` 之类一律原样留着(不猜引擎的转义表) */
const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\' }

interface Balance {
  braces: number
  brackets: number
  inString: boolean
}

/**
 * 引号感知的配平计数(判据 4 的心脏),状态跨行传递。
 *
 * 为什么必须跳过双引号内容:`[input]` 动作块写成 `move_left={ "deadzone": 0.5,
 * "events": [Object(InputEventKey,...)] }`,而 Godot 会把带 `]` 的**字符串**原样写进
 * Object(...) 参数里(如 `"string=\"a]b\""`)。按整行字符计数时那个 `]` 会提前关掉数组,
 * 于是 `}` 变成散落行、紧跟其后的 `[rendering]` 被当成块内容吃掉 —— B8 会对每个
 * 带输入动作的项目报出根本不存在的畸形。`environment/...` 的 Object(...) 同形。
 */
function scanBalance(text: string, st: Balance): Balance {
  let { braces, brackets, inString } = st
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      // 转义吃掉两个字符:`\"` 不是收尾(它之后的那个引号才是)
      if (c === '\\') { i++; continue }
      if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === '{') braces++
    else if (c === '}') braces--
    else if (c === '[') brackets++
    else if (c === ']') brackets--
  }
  return { braces, brackets, inString }
}

/** 配平 = 两种括号都不欠;用 <=0 而不是 ===0,是多 `}` 的畸形行不该把整块拖到文件尾 */
function isBalanced(st: Balance): boolean {
  return st.braces <= 0 && st.brackets <= 0
}

/**
 * 解析 project.godot。逐行判定、不跨行猜测(判据 1–8 全在这里)。
 * 单行值 endLine === line;多行值(raw 以 `{`/`[` 开头且本行未配平)吃掉后续行直到配平。
 */
export function parseGodotIni(text: string): IniDoc {
  const values: IniValue[] = []
  const problems: IniProblem[] = []
  // 不必单独处理 BOM:每行都先 trim() 再判定,而 ECMAScript 的 WhiteSpace 生产里就含 U+FEFF
  // (`'\uFEFF; hi'.trim() === '; hi'`),所以「另存为 UTF-8 带 BOM」的头注释与首行键名都不会脏。
  // 这条靠 godotIni.test.mjs 的「BOM 加严」两条断言钉住(改了 trim 就会红)。
  const src = typeof text === 'string' ? text : ''
  const lines = src.split(/\r?\n/)
  let section = ''

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const t = line.trim()
    const no = i + 1
    // 判据 1:空行跳过,trim 后以 `;` 开头的是注释
    if (!t || t.startsWith(';')) continue
    if (t.startsWith('[')) {
      // 判据 3:段头内的空白容忍(`[ display ]` 是手写与合并冲突后会出现的形态)
      const head = /^\[\s*([^\]]*?)\s*\]$/.exec(t)
      if (!head) {
        problems.push({ line: no, text: line, reason: REASON_BAD_HEAD })
        continue // 不闭合的段头不改当前段:证据留在 problems 里,不臆造新段
      }
      section = head[1]
      continue
    }
    // 判据 2:只在**第一个** `=` 处切(config/name="A=B" 的值必须留全)
    const eq = t.indexOf('=')
    if (eq < 0) {
      problems.push({ line: no, text: line, reason: REASON_NO_EQ })
      continue
    }
    const key = t.slice(0, eq).trim()
    if (!key) {
      problems.push({ line: no, text: line, reason: REASON_NO_KEY })
      continue
    }
    let raw = t.slice(eq + 1).trim()
    let endLine = no
    // 判据 4:`=` 右侧以 `{` 或 `[` 开头**且本行括号未配平** → 整块都是这一条的值
    if (raw[0] === '{' || raw[0] === '[') {
      let st = scanBalance(raw, { braces: 0, brackets: 0, inString: false })
      // 判据 4 的闸:起始行**停在字符串里**(手改坏的行,如 `b=[ "x ]`)就不进块模式。
      // inString 是跨行传递的,进了块就等于把后面每一行的引号都跟「错的那一个」配对:
      // 真键 c=/d= 被吞成 b 的值 ⇒ 它们的 res:// 全消失(B5 报孤儿),而 problems 里只有一句
      // 「块未闭合」—— 证据没丢在磁盘上,却丢在结论里。这种行按单行值留着 + 记一条独立 problem。
      if (st.inString) {
        problems.push({ line: no, text: line, reason: REASON_ODD_QUOTE })
      } else {
        while (!isBalanced(st)) {
          // 判据 5:吃到文件尾仍未配平 → 记 problem,但已吃到的行**整体**留作值(别丢证据)
          if (i + 1 >= lines.length) {
            problems.push({ line: no, text: line, reason: REASON_OPEN_BLOCK })
            break
          }
          i++
          endLine = i + 1
          raw += '\n' + lines[i]
          // 状态跨行传递:这一行没关掉的字符串,下一行仍然在字符串里(否则引号内外会算反)
          st = scanBalance(lines[i], st)
        }
        // 块到文件尾时 split 出来的那个空行是排版不是值的内容
        raw = raw.replace(/\s+$/, '')
      }
    }
    values.push({ section, key, raw, line: no, endLine })
  }

  // 判据 7:config_version 只认顶层(section 为空)那一条。
  // 非数字 → 0 + problems;多次出现 → 0,重复本身交给 values(B8 判重复键的证据不能丢)。
  const cv = values.filter((v) => v.section === '' && v.key === 'config_version')
  let configVersion = 0
  if (cv.length === 1 && /^\d+$/.test(cv[0].raw)) configVersion = Number(cv[0].raw)
  else if (cv.length === 1) problems.push({ line: cv[0].line, text: lines[cv[0].line - 1] ?? '', reason: REASON_BAD_VERSION })

  // problems 按行号排序:散落行是逐行推的、config_version 那条是二次扫描补的,
  // 不排就会在「文件第 3 行的畸形」后面冒出「文件第 1 行的畸形」,B8 的结论列表读起来跳行。
  problems.sort((a, b) => a.line - b.line)
  return { values, problems, configVersion }
}

// ---------- 访问器(同一个文件,纯函数;取不到一律 undefined 而不是猜默认值) ----------

/** 键的完整形态:section + '/' + key(section 为空时就是 key 本身);B8 修复轮导出 —— 分组键必须与 findLast 同一条规则,别让调用方再拼一遍 */
export function fullKeyOf(v: IniValue): string {
  const sec = typeof v.section === 'string' ? v.section : ''
  const key = typeof v.key === 'string' ? v.key : ''
  return sec ? `${sec}/${key}` : key
}

/** 重复键取**最后一条**(与编辑器载入顺序一致;判重复本身请数 values) */
function findLast(doc: IniDoc, fullKey: string): IniValue | undefined {
  if (!doc || !Array.isArray(doc.values) || typeof fullKey !== 'string' || !fullKey) return undefined
  let hit: IniValue | undefined
  for (const v of doc.values) {
    if (!v || typeof v.key !== 'string') continue
    if (fullKeyOf(v) === fullKey) hit = v
  }
  return hit
}

/** `= 号右侧原样文本(带引号、未解码)`;fullKey 形如 'application/config/name' */
export function getIniRaw(doc: IniDoc, fullKey: string): string | undefined {
  const v = findLast(doc, fullKey)
  return v && typeof v.raw === 'string' ? v.raw : undefined
}

/**
 * 值若**恰好**是一对双引号包裹 → 剥一次外层引号并解码;否则(`1280` / `true` /
 * `PackedStringArray(...)` / `"a" "b"`)原样返回 raw。「剥一次、不解多层」:
 * `"\"x\""` 解码成 `"x"`(带引号)就是对的。
 */
export function getIni(doc: IniDoc, fullKey: string): string | undefined {
  const raw = getIniRaw(doc, fullKey)
  if (raw === undefined) return undefined
  const q = asQuotedLiteral(raw)
  return q === null ? raw : q
}

/** 只有裸 `true` / `false` 算布尔;引号串、`1`、`True` 一律 undefined(不当 falsy 也不猜) */
export function getIniBool(doc: IniDoc, fullKey: string): boolean | undefined {
  const raw = getIniRaw(doc, fullKey)
  if (raw === undefined) return undefined
  const t = raw.trim()
  if (t === 'true') return true
  if (t === 'false') return false
  return undefined
}

/** 只有裸整数才解析(含负数与 0);引号串 / 小数 / 0x10 / 数组 → undefined */
export function getIniInt(doc: IniDoc, fullKey: string): number | undefined {
  const raw = getIniRaw(doc, fullKey)
  if (raw === undefined) return undefined
  const t = raw.trim()
  if (!/^-?\d+$/.test(t)) return undefined
  const n = Number(t)
  // 超出安全整数范围的「整数」给 undefined:返回一个已经被四舍五入过的数比不给更坏
  return Number.isSafeInteger(n) ? n : undefined
}

/**
 * 认 `PackedStringArray("a", "b")` 与 `[ "a", "b" ]`;空括号 → `[]`;
 * 其它形态(`{...}`、`Array(...)`、`[Object(...)]`、裸串)→ undefined。**不猜** ——
 * 把 `[Object(InputEventKey,"resource_local_to_scene":false)]` 读成一条字符串列表,
 * B8 就会拿它当「配置里列了个值」下结论。
 */
export function getIniList(doc: IniDoc, fullKey: string): string[] | undefined {
  const raw = getIniRaw(doc, fullKey)
  return raw === undefined ? undefined : parseStringArray(raw)
}

/** 扫出每个双引号字面量的**解码后**内容;不配对的尾引号整条丢弃(要么完整要么不要,别给半截串) */
export function stringLiterals(raw: string): string[] {
  if (typeof raw !== 'string' || !raw) return []
  return scanLiterals(raw).items
}

/**
 * 文档里所有 `res://` 路径(给 B3 的引用索引;保留 `res://` 前缀,归一成 rel 是调用方的事)。
 * 每个 value 都过 stringLiterals,所以多行块里的路径同样收得到。
 *
 * **不带引号的值也收**(判据 8 的镜像):Godot 自己写盘一律带引号,但编辑器外手改 / 合并冲突
 * 后手补就是 `run/main_scene=res://main.tscn`。getIni 按判据 8 把这种值原样当裸串返回,
 * 那么这里也必须认它 —— 否则 B8 在同一页说「主场景 = res://main.tscn」、B5 说「没人引用它」,
 * 而 §6「孤儿资产误判」的失败模式是用户真去删那个文件。判定仍走 resPathLiteral:它要的是
 * **整串以 `res://` 开头**(切掉前缀后剩下的全留作路径),所以 `1280` / `true` /
 * `PackedStringArray(...)` / `user://` / `$单例` / `see res://x/y.png` 都不算。
 * 副作用要写清:Godot 允许路径里有空格,于是 `res://a.png 尾巴` 会整串当路径,得到一个
 * 对不上任何树条目的 rel —— 本模块不判目标存在性(判据 8),那条 rel 由调用方(B5)自己去比。
 */
export function iniResPaths(doc: IniDoc): IniResPath[] {
  const out: IniResPath[] = []
  if (!doc || !Array.isArray(doc.values)) return out
  for (const v of doc.values) {
    if (!v || typeof v.raw !== 'string') continue
    const line = typeof v.line === 'number' ? v.line : 0
    for (const lit of scanLiterals(v.raw).items) {
      const path = resPathLiteral(lit)
      if (path === null) continue
      out.push({ path, fullKey: fullKeyOf(v), line })
    }
    // 不含引号 ⇒ asQuotedLiteral 必为 null(它要求首字符是 `"`),即这确实是判据 8 的裸值形态;
    // 带引号的值走上面那条通道,不重复收。
    if (v.raw.indexOf('"') < 0) {
      const path = resPathLiteral(v.raw.trim())
      if (path !== null) out.push({ path, fullKey: fullKeyOf(v), line })
    }
  }
  return out
}

interface LitScan {
  /** 解码后的字面量(按出现顺序) */
  items: string[]
  /** **去掉全部字面量之后**的剩余文本:parseStringArray 靠它判「括号里只有字符串数组」 */
  residue: string
  /** 最后一个字面量收尾引号的下标;-1 = 一个都没配对 */
  closedAt: number
  /** 结尾有半个字面量(引号不配对) */
  unterminated: boolean
}

/** 双引号字面量扫描的底层:getIni / getIniList / stringLiterals / iniResPaths 共用一份规则 */
function scanLiterals(text: string): LitScan {
  const items: string[] = []
  let residue = ''
  let closedAt = -1
  let unterminated = false
  let i = 0
  while (i < text.length) {
    if (text[i] !== '"') {
      residue += text[i]
      i++
      continue
    }
    let j = i + 1
    let buf = ''
    let closed = false
    while (j < text.length) {
      const c = text[j]
      if (c === '\\') {
        const nx = text[j + 1]
        if (nx === undefined) {
          j++
          break
        }
        buf += ESCAPES[nx] ?? '\\' + nx
        j += 2
        continue
      }
      if (c === '"') {
        closed = true
        break
      }
      buf += c
      j++
    }
    // 判据「不配对的尾引号不得吞掉整行剩余」:这里**整条丢弃**,也不把半截塞进 residue
    if (!closed) {
      unterminated = true
      break
    }
    items.push(buf)
    closedAt = j
    i = j + 1
  }
  return { items, residue, closedAt, unterminated }
}

/** 整串**恰好**是一对双引号包裹时给解码后的内容,否则 null(getIni 的「剥一次」判据) */
function asQuotedLiteral(raw: string): string | null {
  if (!raw.startsWith('"')) return null
  const s = scanLiterals(raw)
  return s.items.length === 1 && !s.unterminated && s.closedAt === raw.length - 1 ? s.items[0] : null
}

/** 见 getIniList:括号里只允许引号字面量 + 逗号 + 空白,别的一律 undefined */
function parseStringArray(raw: string): string[] | undefined {
  const t = raw.trim()
  const packed = /^PackedStringArray\(([\s\S]*)\)$/.exec(t)
  let inner: string | null = null
  if (packed) inner = packed[1]
  else if (/^\[[\s\S]*\]$/.test(t)) inner = t.slice(1, -1)
  if (inner === null) return undefined
  const s = scanLiterals(inner)
  if (s.unterminated || !/^[,\s]*$/.test(s.residue)) return undefined
  return s.items
}

/**
 * 一个字面量是不是项目内路径?两种非路径形态要挡掉:
 *   · `*res://…` —— autoload 的「启用单例」标记(`MyAuto="*res://autoload/x.gd"`),
 *     `*` 不是路径的一部分;留着它 B3 就永远对不上文件树里的 rel,主场景会被当成孤儿。
 *   · `$MyAuto` —— 引用别的单例,压根不是路径。
 * `user://`(运行时可写目录)与绝对路径不在项目树里、判不了存在性,一律不进结果。
 */
function resPathLiteral(lit: string): string | null {
  const body = lit.startsWith('*') ? lit.slice(1) : lit
  return body.startsWith('res://') ? body : null
}
