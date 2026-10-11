// GDScript 批量重命名 · 引用改写(§G Task 17)。
//
// 一句话职责:给定「旧 rel → 新 rel」这张表和一份**已经读进内存**的文本,算出改完的文本与改了几处。
// 纯函数:不碰 IO、不碰 window / vue / fs —— 读盘与选文件是 `index.ts` 那层(插件入口)的事,
// 而它拿到的候选来自框架注入的 `ctx.refIndex()`(§5.3 那张表里的 `ref` 能力)。
//
// ★ 方向与 `refIndex.ts` **相反**,这条是本文件最要紧的一段(§G DEV-22):
//   引用索引那一侧的判据是「一句提及即引用」,连注释与死代码里的字符串都算 —— 因为少收一条引用
//   就会让孤儿工具多摆一个删除按钮,方向是保守地**多报**。
//   而这里要动的是用户文件里的字节:多改一处就是改了不该改的东西。于是只认**能证明是引用的那一处** ——
//   引号内文整串等于那条 `res://` 路径,或 ini 里 `key=res://x` 那种值恰好就是这条路径的裸值形态。
//   `refIndex` 在这里只用来回答「哪个文件值得一读」,不回答「这一处该不该改」。
//
// 四条实现纪律:
//   1. **计数与产出同一循环**:`hits` 是替换那一刻累加的,A-22 那句「将有 N 处引用断链」与真正改掉的
//      处数出自同一趟扫描(旧 `inspectors/format.ts` 的同一条老规矩,两套计数一定会漂)。
//   2. **一次过按表替换,不做链式**:一轮里 A→B 与 B→C 同时存在时,`res://A` 变成 `res://B` 之后
//      **不许**再被 B→C 吃掉一次。做法是先在原文上找出所有目标区间、再一次性拼出去(§G 补充第 4 条 b)。
//   3. **换行符逐行保住**:`.gd` 用 `scanGdScript` 给的 `raw + term` 重组(它把 `\r\n` 单独收在 term 里),
//      其余面用带终止符的行切分。`split('\n') + join('\n')` 那种写法会把 CRLF 项目静默改成 LF。
//   4. **读不懂就不改**:引号不配对(半截字符串)、`#` 之外的语法不认识、值带尾巴标点 —— 一律原样交回,
//      不猜。宁可留下一处断链让用户看见(它进 `dangling` 的计数),也不要写出一个 Godot 认不出来的文件。

import { scanGdScript } from '../../parsers/gdScript'

/** 四类文件面:决定「什么算一处引用」的那套规则归哪一档 */
export type RefKind = 'scene' | 'gd' | 'ini' | 'literal'

/** 旧 rel → 新 rel(键与值都是 `res://` 形态,与文件里写的那样,免得每处再拼一次) */
export type RenameMap = Map<string, string>

export interface Rewritten {
  /** 改完的文本;一处都没改时与入参逐字节相同 */
  out: string
  /** 真正替换掉的处数(与产出同一循环,A-22 的 N 就来自这里) */
  hits: number
  /** 命中所在的行号(1-based,升序去重):预览要能说「第 3、17 行」而不只是给个总数 */
  lines: number[]
}

/** `player/gamer.gd` → `res://player/gamer.gd`;不是项目内 rel 就给空串 */
export function resPath(rel: unknown): string {
  if (typeof rel !== 'string') return ''
  const s = rel.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!s || s.includes('..')) return ''
  return 'res://' + s
}

/**
 * 组表。三种脏输入要挡在前面而不是留给替换去处理:
 *   · 缺 from 或 to ⇒ 这一对不收(收了就会把别处改成 `res://undefined`);
 *   · 新旧同一个名字 ⇒ 不收(那是空操作,却会让 hits 虚增);
 *   · 同一旧名指向两个新名 ⇒ **先给的赢**(与 `buildPlan` 的「同一个文件被改写两次只留第一条」同方向,
 *     静默合并成第三种名字是更坏的结果 —— 那种映射没有任何一处代码能预测)。
 */
export function buildRenameMap(pairs: unknown): RenameMap {
  const map: RenameMap = new Map()
  const list = Array.isArray(pairs) ? pairs : []
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    const from = resPath((raw as { from?: unknown }).from)
    const to = resPath((raw as { to?: unknown }).to)
    if (!from || !to || from === to) continue
    if (!map.has(from)) map.set(from, to)
  }
  return map
}

/**
 * 这个引用者属于哪一面。判据与 `refIndex.ts:117-124` 的白名单同一批扩展名,
 * 但**分成两套规则而不是共用一份**:那边决定「读不读」,这边决定「改不改得动」。
 */
export function kindOfReferrer(rel: unknown): RefKind {
  const s = typeof rel === 'string' ? rel.replace(/\\/g, '/').toLowerCase() : ''
  if (!s) return 'literal'
  if (s === 'project.godot') return 'ini'
  const segs = s.split('/')
  if (segs.length === 1 && s.endsWith('.cfg')) return 'ini'
  if (s.endsWith('.tscn') || s.endsWith('.tres')) return 'scene'
  if (s.endsWith('.gd')) return 'gd'
  return 'literal'
}

interface Span {
  /** 开引号的下标 */
  start: number
  /** 闭引号之后那位 */
  end: number
  /** 引号内文(不解码:路径里不该有转义,解码了反而对不上表) */
  value: string
}

/**
 * 逐字符扫出「引号字面量」在**一行**里的区间。
 *   · `\\` 转义吃掉下一个字符(与 `godotIni.ts` 的 scanLiterals 同一套读法,两处不同步就会一边改一边不改);
 *     ⚠ 这一支是**防御性读取**,没有断言能证到它:表里的键一律经 `resPath()` 归一,反斜杠在 rel 里
 *     根本存不住(会被换成正斜杠),所以「值里带转义引号的路径」永远进不了表。它挡的是配对错位
 *     (半截引号把后面的引号吃掉 ⇒ 造出一个假字面量),不是「支持带反斜杠的路径」;
 *   · 到行尾还没配对 ⇒ 这一处**丢弃**,不猜它是路径(半截字符串改坏了是整个文件废掉);
 *   · 空内文 `""` 也收(它对不上任何表键,自然不改)。
 */
function scanQuotes(line: string, quotes: string[]): Span[] {
  const out: Span[] = []
  let i = 0
  while (i < line.length) {
    const ch = line[i]
    if (!quotes.includes(ch)) { i++; continue }
    let j = i + 1
    let closed = false
    while (j < line.length) {
      const c = line[j]
      if (c === '\\') { j += 2; continue }
      if (c === ch) { closed = true; break }
      j++
    }
    if (!closed) break
    out.push({ start: i, end: j + 1, value: line.slice(i + 1, j) })
    i = j + 1
  }
  return out
}

/** 一行里「代码区」的右边界:第一个不在引号内的 `#`(GDScript 的行尾注释)。没找到给行长 */
function codeEnd(line: string): number {
  let i = 0
  while (i < line.length) {
    const ch = line[i]
    if (ch === '"' || ch === "'") {
      const q = ch
      let j = i + 1
      while (j < line.length) {
        if (line[j] === '\\') { j += 2; continue }
        if (line[j] === q) break
        j++
      }
      i = (j >= line.length) ? line.length : j + 1
      continue
    }
    if (ch === '#') return i
    i++
  }
  return line.length
}

/** 逐行切分且**把终止符单独留着**(重组时逐字节还原,CRLF 不会被抹平) */
function splitLines(text: string): { body: string, term: string }[] {
  const out: { body: string, term: string }[] = []
  let i = 0
  while (i < text.length) {
    let j = i
    while (j < text.length && text[j] !== '\n' && text[j] !== '\r') j++
    if (j >= text.length) { out.push({ body: text.slice(i), term: '' }); break }
    const term = text[j] === '\r' && text[j + 1] === '\n' ? '\r\n' : text[j]
    out.push({ body: text.slice(i, j), term })
    i = j + term.length
  }
  return out
}

/**
 * 引号内文**整串等于**表里某条旧路径 ⇒ 换成新路径(引号本身原样保留)。
 * 返回改过的行文本 + 命中处数。`limit` 是代码区右边界(GDScript 用它躲开行尾注释)。
 */
/**
 * 引号内文**整串等于**表里某条旧路径 ⇒ 换成新路径(引号本身原样保留)。
 * 两种带前缀的写法也要认(都不在表里,剥掉前缀再查一次,前缀原样写回):
 *   · `*res://x` —— autoload 的「启用单例」标记(`godotIni.ts:402-404` 同一条),`*` 不是路径的一部分;
 *   · 别的 `res://` 前缀不在考虑范围:`user://` 与绝对路径根本不在项目树里(`sceneRefs.resToRel` 明写不解析)。
 * `limit` 是代码区右边界(GDScript 用它躲开行尾注释)。
 */
function swapQuoted(line: string, map: RenameMap, quotes: string[], limit: number): { text: string, hits: number } {
  const spans = scanQuotes(line, quotes).filter((s) => s.start < limit)
  const hitSpans = spans.filter((s) => map.has(s.value) || (s.value.startsWith('*') && map.has(s.value.slice(1))))
  if (!hitSpans.length) return { text: line, hits: 0 }
  let out = ''
  let cursor = 0
  for (const s of hitSpans) {
    const q = line.charAt(s.start)
    const star = s.value.startsWith('*')
    const nv = map.get(star ? s.value.slice(1) : s.value) as string
    out += line.slice(cursor, s.start) + q + (star ? '*' : '') + nv + q
    cursor = s.end
  }
  out += line.slice(cursor)
  return { text: out, hits: hitSpans.length }
}

/**
 * ini 的裸值形态:`run/main_scene=res://main.tscn`(`godotIni.ts:296-315` 明写这种写法也要认 ——
 * 编辑器外手改与合并冲突后手补就是它)。只认「= 号之后整串(去掉 autoload 的 `*` 前缀、去掉首尾空白)
 * 就是那条路径」;带尾巴标点的(`res://a,` 那种)不改:值到底是什么说不清(§G 补充第 4 条的少改方向)。
 */
function swapBareIni(line: string, map: RenameMap): { text: string, hits: number } {
  const eq = line.indexOf('=')
  if (eq < 0) return { text: line, hits: 0 }
  const value = line.slice(eq + 1)
  const lead = value.length - value.trimStart().length
  const trail = value.length - value.trimEnd().length
  const core = value.slice(lead, value.length - trail)
  if (!core) return { text: line, hits: 0 }
  const star = core.charAt(0) === '*'
  const body = star ? core.slice(1) : core
  if (!body || !map.has(body)) return { text: line, hits: 0 }
  const nv = map.get(body) as string
  return { text: line.slice(0, eq + 1) + value.slice(0, lead) + (star ? '*' : '') + nv + value.slice(value.length - trail), hits: 1 }
}

/** scene / ini / literal 三面共用:只认双引号(C# 的单引号是 char 字面量,不是路径) */
function swapLine(line: string, map: RenameMap): { text: string, hits: number } {
  return swapQuoted(line, map, ['"'], line.length)
}

/**
 * 主入口:按面改。表为空 / 文本不是字符串 ⇒ 原样交回(hits 0),不抛。
 */
export function rewriteRefs(kind: RefKind, text: unknown, map: RenameMap): Rewritten {
  const body = typeof text === 'string' ? text : ''
  const hitsAll = { out: body, hits: 0, lines: [] as number[] }
  if (!body || !(map instanceof Map) || map.size === 0) return hitsAll

  // 两个分支都是「改了一行才记一行」,所以行号天然不重复 —— 同一行两处命中只进一条 line。
  // 这里不加 `includes` 兜底:那是一道永远测不到的闸(变异刀拿掉它 0 条红),契约靠调用点的位置保证。
  const record = (lineNo: number): void => { hitsAll.lines.push(lineNo) }

  if (kind === 'gd') {
    // GDScript 要用 `scanGdScript` 的行分类:**多行字符串与注释里的路径一个都不改**。
    // 那是「内容」不是「引用」——改了它就等于动了用户的数据(与 A-11 那条分档同一条线)。
    const scan = scanGdScript(body)
    let out = ''
    let hits = 0
    for (const l of scan.lines) {
      if (l.inString || l.isComment) { out += l.raw + l.term; continue }
      const r = swapQuoted(l.raw, map, ['"', "'"], codeEnd(l.raw))
      if (r.hits) { hits += r.hits; record(l.line) }
      out += r.text + l.term
    }
    return { out, hits, lines: hitsAll.lines }
  }

  const rows = splitLines(body)
  let out = ''
  let hits = 0
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    let lineText = row.body
    let lineHits = 0
    if (kind === 'ini') {
      // ini 注释行(`;` 开头)整行跳过:那是给人看的说明,不是配置
      if (lineText.trim().startsWith(';')) { out += lineText + row.term; continue }
      const q = swapLine(lineText, map)
      lineHits += q.hits
      lineText = q.text
      if (!lineHits) {
        const b = swapBareIni(lineText, map)
        lineHits += b.hits
        lineText = b.text
      }
    } else {
      const q = swapLine(lineText, map)
      lineHits += q.hits
      lineText = q.text
    }
    if (lineHits) { hits += lineHits; record(i + 1) }
    out += lineText + row.term
  }
  return { out, hits, lines: hitsAll.lines }
}

/**
 * 一处都读不出来的时候给 UI 的那句实话(措辞在这里,不在视图里)。
 * `index.ts` 用它把「读不到 / 半截 / 二进制」的引用者并进 reason,而不是静默少改。
 */
export function unreadableReason(r: { error?: string, truncated?: boolean, skippedBinary?: boolean }): string {
  if (r && r.error) return String(r.error)
  if (r && r.truncated) return '超出读取上限,只拿到部分内容'
  if (r && r.skippedBinary) return '被认成二进制'
  return '读不到正文'
}
