// GDScript 的**逐行状态扫描**(纯函数)—— 工具页 B9「代码格式化(只做文本卫生)」的唯一判据底座。
//
// 它不格式化任何东西,只回答一个问题:**这一行能不能动**。B9 会改写用户的源代码,
// 简报的红线是「任何一处不确定就不要动那个字节」,所以这里把三种不确定一律折算成「不动」:
//   · inString      —— 这一行与多行字符串或没闭合的引号有过任何接触 ⇒ **整行一个字节都不动**。
//                      多行字符串里的行尾空白、缩进、空行都是**内容**,删了就是改程序的行为。
//   · continuation  —— 这一行的前导空白是「跟着上一行继续」的(上一行以 `\` 结尾,或括号没闭合)
//                      ⇒ 不许做缩进转换(对齐是排版意图)。行尾空白照删,那是判据 4 的约定。
//   · suspect       —— 括号配对认不出(凭空多出一个闭括号)⇒ 之后每一行都按 continuation 处理,
//                      **单向不解除**:认不出一次,后面就一直没有缩进判据(宁可漏格式)。
//
// 引擎出处(godotengine/godot **4.4-stable**,`modules/gdscript/` 下的原文逐段读过,不是凭印象):
//   · `gdscript_tokenizer.cpp:891-914` —— 字符串可以带 `r`(raw)/ `&`(StringName)/ `^`(NodePath)前缀,
//     引号后紧跟两个同类引号就是**多行串**;`:1106-1128` —— 多行串要凑齐三个**同类**引号才算结束,
//     单个引号只是内容(所以块内出现另一类引号不闭合块);`:944-960` —— raw 串不解析转义,
//     但 `\"`/`\\` 仍然吃掉配对的字符;`:1050-1062` —— 普通串里 `\` 紧跟换行是 escaped newline,串续到下一行;
//     `:919` + `:1131-1142` —— 普通串遇到裸换行**不自己收尾**,状态一直续到闭合引号或 EOF("Unterminated string.")。
//     最后一条就是判据 1「引号不成对时保守当作仍在字符串里」的引擎依据:保守方向与引擎同侧。
//   · `gdscript_tokenizer.cpp:1268-1281` —— 引擎自己把「同一缩进层级混用 tab 与空格」当错误,
//     而且**续行与括号内的 multiline 模式一律跳过缩进检查**:判据 3(混用才判不一致)与
//     判据 4(续行对齐不动)不是本工具发明的规矩。
//   · `gdscript_parser.cpp:557-566` 的 `push_multiline(true)` 调用点是 `(`(函数签名 :1632、
//     括号表达式 :1424/:2071)、`{`(enum :1467)、`[`(数组 :2427)—— 所以这里只数这三种括号。
//
// 已知**不建模**的构造,以及它为什么越不过「不动」这条线:
//   · `$"..."` 插值串里的嵌套引号 —— 配对可能算错,后果是多算几行「未闭合」⇒ 更不动;
//   · 同一行里挨着的两个串(`a = "x" "y"`)—— 会被读成块,那一行不动;
//   · 正文中间的裸 `\r`(老 Mac 残留)—— 不解释,只如实还原(是否因此放弃统一换行符由调用方判,见 GdScan.strayCR)。
//
// 行切分口径(判据 5 的前提):按 `\n` 切,**不把 `\r` 当换行**。CRLF 文本里行尾的 `\r` 折进 `term`,
// 所以「改主导换行符」永远只改终止符、改不到正文中间的 `\r`。`raw + term` 逐字节可还原原文。
//
// 红线:纯函数。不碰 window / services / vue / DOM,不读文件、不拼路径。
import type { TreeEntry } from '../../types/godot'

/** GDScript 认的三种「表达式跨行」括号(parser 的 push_multiline 调用点就是这三种) */
const OPEN_BRACKETS = '([{'
const CLOSE_BRACKETS = ')]}'

/**
 * 字符串前缀字母(`gdscript_tokenizer.cpp:895-906`):`r` raw、`&` StringName、`^` NodePath。
 * 引擎的认法是「吃掉开引号之后回看紧挨着的前一个字符」,这里照抄同一个形状:引号前是这三个字母之一
 * 就当它是带前缀的串,**整行保守不动**(标 inString 后不再往里解析)。
 * 为什么宁可误伤:漏掉前缀会把 `r"路径\"` 里的 `\"` 当转义 ⇒ 后面的行被误判成代码 ⇒ 真会改坏字节;
 * 误伤的代价只是这几行不动。多标一行 inString 永远安全。
 */
const STRING_PREFIX = new Set(['r', '&', '^'])

/** 一个条目在格式化眼里的身份:目标 / 缓存 / 第三方插件 / 别的东西 */
export type GdScope = 'target' | 'cache' | 'addons' | 'other'

/**
 * 读入面判据(判据 8):只有 `.gd` 参与,`.godot/**` 与 `addons/**` 各算一类**排除计数**。
 *
 * 与 `inspectors/orphans.ts:129-130`、`inspectors/imports.ts:311` 同一条路径段判据:
 *   · 缓存按**路径段**判,不用子串匹配 —— `project.godot` 与 `sub/x.godot` 都不是缓存
 *     (子串匹配的坑与出处写在 treeUtils.ts:19-22);
 *   · addons 按**大小写不敏感**判:Windows 上 `Addons/` 与 `addons/` 是同一个目录,漏判一侧就会
 *     把归 B7 的第三方插件脚本改写掉 —— 这一侧的漏判是**越界改动**,不是「少改」,必须堵住。
 *     (方向与 orphans 那条不同:那里漏判只是少报孤儿,这里漏判会动别人的代码。)
 *   · rel 里出现反斜杠 → 形状不认识,一律不进读入面(宁可不读,不替原语猜路径)。
 *   · 扩展名用原语给的 `f.ext`(小写无点,两端同形,记录见 refIndex.ts:59-63),不在这里重算;
 *     `Main.GD` 的 ext 就是 `gd`,所以照样进面。
 */
export function gdScopeOf(entry: TreeEntry): GdScope {
  const rel = entry && typeof entry.rel === 'string' ? entry.rel : ''
  if (!rel || rel.includes('\\')) return 'other'
  const segments = rel.split('/')
  if (segments.some((c) => c === '.godot')) return 'cache'
  if (entry.ext !== 'gd') return 'other'
  if (segments.some((c) => c.toLowerCase() === 'addons')) return 'addons'
  return 'target'
}

/** 一行的分类结果 */
export interface GdLineInfo {
  /** 1-based 行号 */
  line: number
  /** 去掉行尾终止符之后的原文(行尾 `\r` 在 term 里,不在这里) */
  raw: string
  /** 这一行的终止符:`'\n'` / `'\r\n'` / `''`(文件末行且不带换行) */
  term: string
  /** 与多行字符串或未闭合引号有过接触 ⇒ 整行不动 */
  inString: boolean
  /** 整行注释(前导空白之后第一个字符就是 `#`) */
  isComment: boolean
  /** 前导空白(只含空格与 tab) */
  indent: string
  /** 去掉前导空白与行尾注释、再右去空白后的代码文本;inString 时是空串 */
  code: string
  /** 上一行的续行状态(`\` 结尾 / 括号没闭合 / suspect)*/
  continuation: boolean
  /** 本行**结束时**的括号深度 */
  depth: number
  /** suspect 状态(本行结束时;本行或更早出现过多余闭括号) */
  suspect: boolean
  /** 本行结束时是不是停在 `"""` / `'''` 块里(块内的 term 是内容) */
  inBlock: boolean
}

/** 一份文本的扫描结果:逐行状态 + 文件级信息(判据 5 吃后三条) */
export interface GdScan {
  lines: GdLineInfo[]
  /** 文件是否以换行收尾(末行 term 是空串就得补,判据「文件末尾单个换行」) */
  endsWithNewline: boolean
  /** 代码区主导换行符;平局或代码区一个终止符都没有时是 null */
  dominantTerm: string | null
  /** 代码区两种终止符各多少个(计数与产出同源,判据 7 的「可核对计数」) */
  termCounts: { crlf: number; lf: number }
  /** 字符串**内容**里混着与主导不同类的终止符 ⇒ 统一换行符会改内容,这一条不能做 */
  blockTermConflict: boolean
  /** 正文里出现过非行尾的裸 `\r`(老 Mac 残留):本模块不解释它 */
  strayCR: boolean
  /** 文件结束时仍有没闭合的字符串/块 */
  unterminated: boolean
}

/** 跨行携带的扫描状态(字段名直说用途,不用一个 boolean 打包两件事) */
interface ScanState {
  /** 多行串定界符:`''` 不在块内,`'"""'` / `"'''"` 在块内 */
  block: string
  /** 从上一行没闭合过来的单/双引号(块外) */
  quote: string
  /** 上一行以反斜杠结尾(行级续行) */
  backslash: boolean
  /** 括号深度 */
  depth: number
  /** 括号配对认不出过,永不解除 */
  suspect: boolean
}

/**
 * 判据 1 的公开形状:`Array<{ line, inString, isComment, indent, code }>`,
 * 另带 raw/term/continuation/depth/suspect/inBlock(格式化还要判缩进与换行符)。
 * 纯函数:同一份文本永远得到同一份结果。
 */
export function classifyLines(text: string): GdLineInfo[] {
  return scanGdScript(text).lines
}

/** 行首的空格与 tab(不动其他空白字符:\f/\v/NBSP 这些本工具一律不当排版处理) */
function leadWhitespace(raw: string): string {
  let i = 0
  while (i < raw.length && (raw[i] === ' ' || raw[i] === '\t')) i++
  return raw.slice(0, i)
}

/**
 * 逐行分类一份 GDScript 文本,并把文件级的换行符统计一起给出(B9 一份文本只扫一趟)。
 *
 * 换行符统计的口径(判据 5):只有**块外**的终止符算「代码区形态」。
 * 块内行(进线时 `st.block` 非空)的终止符是**内容** —— 它在不在主导之外,决定要不要放弃
 * 「统一换行符」这一条(`blockTermConflict`)。块的收尾行不在此列:它自己那个终止符在闭合引号**之后**,
 * 是代码区的排版,改它不改内容(判据 5 的统计分支就按「出线时是否仍在串里」分)。
 */
export function scanGdScript(text: string): GdScan {
  const parts = typeof text === 'string' ? text.split('\n') : []
  const dropLastEmpty = parts.length > 1 && parts[parts.length - 1] === ''
  // 空文本是「零行」而不是「一行为空的行」—— 空文件五类操作一律不动,别给它造出一行来
  const count = typeof text !== 'string' || text === '' ? 0 : dropLastEmpty ? parts.length - 1 : parts.length
  const endsWithNewline = parts.length > 0 && dropLastEmpty

  const st: ScanState = { block: '', quote: '', backslash: false, depth: 0, suspect: false }
  const lines: GdLineInfo[] = []
  let crlf = 0
  let lf = 0
  let contentCrlf = 0
  let contentLf = 0
  let strayCR = false

  for (let n = 0; n < count; n++) {
    const full = parts[n]
    // 行尾的 `\r` 只有在**这一行真的有终止符**时才折进 term:末行没有换行时它的 `\r` 是正文,
    // 折走就会破坏「raw + term 逐字节还原原文」这条不变量(B9 靠它重建文本)。
    const endsNL = n < count - 1 || endsWithNewline
    const hadCR = endsNL && full.length > 0 && full.charCodeAt(full.length - 1) === 13
    const raw = hadCR ? full.slice(0, -1) : full
    const term = endsNL ? (hadCR ? '\r\n' : '\n') : ''
    if (raw.includes('\r')) strayCR = true // 正文中间的裸 `\r`(老 Mac 残留):不解释,只标记

    const startedDepth = st.depth
    const cont = st.backslash || st.suspect || st.depth > 0
    const res = scanLine(raw, st)

    // ---- 状态推进:这一处是唯一写 st 的地方 ----
    st.depth = Math.max(0, startedDepth + res.bracketDelta)
    if (startedDepth + res.bracketDelta < 0) st.suspect = true
    st.backslash = res.endsBackslash
    st.block = res.block
    st.quote = res.quote

    // ---- 终止符归账(判据 5)----
    // 出线时仍停在字符串里 ⇒ 这一行的终止符是**内容**(块内换行、或未闭合引号续行),它不参与主导统计;
    // 块在本行中间闭合 ⇒ 闭合引号之后的终止符属于代码区。
    if (term !== '') {
      if (res.block || res.quote) {
        if (term === '\r\n') contentCrlf++
        else contentLf++
      } else if (term === '\r\n') crlf++
      else lf++
    }

    const indent = leadWhitespace(raw)
    const body = res.inString ? '' : raw.slice(indent.length, res.codeEnd)
    lines.push({
      line: n + 1,
      raw,
      term,
      inString: res.inString,
      // 整行注释:代码区在 `#` 处截断,且 `#` 之前除了空白什么都没有
      isComment: !res.inString && res.codeEnd < raw.length && raw.slice(indent.length, res.codeEnd).trim() === '' && raw[indent.length] === '#',
      indent,
      code: res.inString ? '' : body.replace(/[ \t]+$/, ''),
      continuation: cont,
      depth: st.depth,
      suspect: st.suspect,
      inBlock: st.block !== ''
    })
  }

  const total = crlf + lf
  let dominant: string | null = null
  if (total > 0 && crlf !== lf) dominant = crlf > lf ? '\r\n' : '\n'
  // 判据 5 的那道闸:字符串**内容**里混着与主导不同类的终止符 ⇒ 统一换行符会改内容。
  // 主导还没定(平局或代码区没有终止符)时谈不上冲突 —— 那种文件本来就统一不了。
  const conflict = dominant !== null &&
    ((dominant === '\r\n' && contentLf > 0) || (dominant === '\n' && contentCrlf > 0))
  return {
    lines,
    endsWithNewline,
    dominantTerm: dominant,
    termCounts: { crlf, lf },
    blockTermConflict: conflict,
    strayCR,
    unterminated: st.block !== '' || st.quote !== ''
  }
}

/** scanLine 的内部返回:这一行看到了什么、出线状态是什么 */
interface LineResult {
  inString: boolean
  /** 出线时的块/引号状态(非空 ⇒ 本行终止符属于字符串内容) */
  block: string
  quote: string
  /** 代码区结束时的下标(行尾注释就是 `#` 的位置) */
  codeEnd: number
  /** 本行代码区的括号净增 */
  bracketDelta: number
  /** 本行代码区以未成对的 `\` 收尾(行级续行) */
  endsBackslash: boolean
}

/**
 * 扫一行。引擎 `gdscript_tokenizer.cpp:1131-1142` 的读法:普通串里的裸换行**不结束串**,
 * 所以未闭合的引号必须带到下一行 —— 这里用 `st.block` / `st.quote` 携带,方向是少动。
 */
function scanLine(raw: string, st: ScanState): LineResult {
  let block = st.block
  let quote = st.quote
  let i = 0
  let inString = block !== '' || quote !== ''
  let codeEnd = raw.length
  // 进线就在串/块里 ⇒ 代码片段起点先压在行尾:本行没有任何代码区可结算,
  // 除非串/块在这一行中间闭合(那时才把起点挪到闭合引号之后)。不这样压,块内的 `((`
  // 会被当成括号统计,块结束后后面一整片行都被误判成续行(判据 4 的白丢)。
  let bracketStart = inString ? raw.length : 0
  let bracketDelta = 0
  let endsBackslash = false

  /** 把 [bracketStart, end) 这段代码区结算进 bracketDelta 与续行判定 */
  const closeCode = (end: number): void => {
    let delta = 0
    for (let k = bracketStart; k < end; k++) {
      const ch = raw[k]
      if (OPEN_BRACKETS.includes(ch)) delta++
      else if (CLOSE_BRACKETS.includes(ch)) delta--
    }
    bracketDelta += delta
    // 代码区里的 `\` 不是转义符,只有「代码区最后一个字符是 `\`」才是行级续行(转义配对由串内循环处理)
    endsBackslash = end - bracketStart > 0 && raw[end - 1] === '\\'
    bracketStart = end
  }

  while (i < raw.length) {
    if (block) {
      // 多行串:只有**同类**的三个引号才算闭合(:1106-1128);`\x` 一律吃掉两个字符(:944-960)
      if (raw[i] === '\\') { i += 2; continue }
      if (raw.startsWith(block, i)) {
        block = ''
        bracketStart = i + 3
        i += 3
        continue
      }
      i++
      continue
    }
    if (quote) {
      if (raw[i] === '\\') { i += 2; continue }
      if (raw[i] === quote) {
        quote = ''
        bracketStart = i + 1
        i++
        continue
      }
      i++
      continue
    }
    // ---------- 代码区 ----------
    const ch = raw[i]
    if (ch === '#') {
      // 注释到行尾为止,不跨行:代码区就地结算,后面的 `"` `(` 一概不看
      closeCode(i)
      bracketStart = raw.length
      endsBackslash = false
      if (raw.slice(0, i).trim() === '') codeEnd = i // 整行注释
      else if (codeEnd === raw.length) codeEnd = i // 行尾注释:代码到此为止
      i = raw.length
      break
    }
    if (ch === '"' || ch === "'") {
      const prefixed = i > 0 && STRING_PREFIX.has(raw[i - 1])
      if (raw[i + 1] === ch && raw[i + 2] === ch) {
        // 三个同类引号 = 多行串开界(:891-914 的 is_multiline 判据同形)
        if (prefixed) {
          inString = true // 带前缀的块不建模,整行保守不动
          i++
          continue
        }
        inString = true
        block = ch === '"' ? '"""' : "'''"
        closeCode(i)
        bracketStart = raw.length
        endsBackslash = false
        i += 3
        continue
      }
      if (prefixed || raw[i + 1] === ch) {
        // 带前缀的串、或第二个同类引号紧跟的怪形状:认不出 ⇒ 整行不动,不再往里猜
        inString = true
        closeCode(i)
        bracketStart = raw.length
        endsBackslash = false
        i = raw.length
        break
      }
      quote = ch
      closeCode(i)
      bracketStart = raw.length
      endsBackslash = false
      i++
      continue
    }
    i++
  }
  closeCode(raw.length)

  // 出线状态:仍在串/块里 ⇒ 这一行也算内容(未闭合引号的保守方向),
  // 而且这一行的终止符归「字符串内容」那一边统计(见调用处的归账分支)。
  if (block || quote) inString = true

  return { inString, block, quote, codeEnd, bracketDelta, endsBackslash }
}
