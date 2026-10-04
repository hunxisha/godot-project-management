// Godot 翻译 csv 的首列抽取(纯函数,可单测)。设计见 docs/tools-page-plan.md P1-4 #15。
//
// 只做一件事:**按记录**(逻辑行)给出第一个字段的值与它的起始行号。
// 为什么不用 split(',') 一把切:Godot 的 translation csv 允许译文里带逗号、带换行、带 `""` 转义引号,
// 裸切分会把一条记录切成两条,首列查重随之报出根本不存在的重复键 —— 而 #15 的措辞是
// 「你的翻译表有重复键」,这种假阳性会直接把用户支去改一个没坏的文件(§6 头号失败模式)。
//
// 为什么不复用 godotIni 的 scanLiterals:那份为 `key=value` 形态服务(要判 `=`、`;` 注释、多行块),
// csv 既没有键值形态也没有注释;两边共用一份只会把两套规则搅在一起。这里是一条**只认引号与换行**的
// 小状态机,规则面比那份窄得多。
//
// 表头行照常产出一条(`_key`),跳不跳由调用方决定 —— 解析器不替用户猜语义。

const BOM_RE = new RegExp('^' + String.fromCharCode(0xfeff))

export interface CsvCell {
  cell: string
  /** 该记录**起始行**的行号,1-based;引号内跨行的记录不按末行算 */
  line: number
}

export interface CsvRead {
  cells: CsvCell[]
  /** 文本在引号区内被截断(未闭合引号):尾部不可信,调用方**不得**据此判重复 */
  partial: boolean
}

/**
 * 逐记录扫一份 csv,只留首列。
 *
 * 方向纪律:读不下去时**少报**(partial=true 交调用方降级),而不是猜一个键出来。
 * 空白行不产出记录 —— 否则一个末尾空行会被查重当成「键为空,重复了 N 次」。
 */
export function readTranslationCsv(text: string): CsvRead {
  const s = typeof text === 'string' ? text.replace(BOM_RE, '') : ''
  const cells: CsvCell[] = []
  let i = 0
  let line = 1
  let partial = false

  while (i < s.length) {
    const recStart = i
    const startLine = line
    let first = ''

    // ── 首字段 ──────────────────────────────────────────────
    if (s[i] === '"') {
      let closed = false
      i++
      while (i < s.length) {
        const c = s[i]
        if (c === '"') {
          if (s[i + 1] === '"') { first += '"'; i += 2; continue } // "" 是一个字面引号
          i++; closed = true; break
        }
        if (c === '\n') line++ // 引号内的换行也是换行:行号照走
        first += c
        i++
      }
      if (!closed) { partial = true; break }
    } else {
      while (i < s.length && s[i] !== ',' && s[i] !== '\n' && s[i] !== '\r') {
        first += s[i]
        i++
      }
    }

    // ── 余下字段:只找「引号外的记录终止符」 ──────────────────
    let inQ = false
    while (i < s.length) {
      const c = s[i]
      if (c === '"') { inQ = !inQ; i++; continue }
      if (!inQ && (c === '\n' || c === '\r')) break
      // 走到这里只可能是「引号内的换行」(引号外的终止符已经 break 走了):
      // 后面字段的跨行译文同样要推进行号,否则后续记录的起始行会整体少 1,
      // 查重报出的行号就指到别的键上去。
      if (c === '\n') line++
      i++
    }
    if (inQ) { partial = true; break }

    if (i > recStart) cells.push({ cell: first, line: startLine })

    // ── 吃终止符(\r\n 当一个,CRLF / 裸 LF / 裸 CR 同形) ──────
    if (i < s.length) {
      if (s[i] === '\r') { i++; if (s[i] === '\n') i++ } else i++
      line++
    }
  }

  return { cells, partial }
}

/**
 * 首列里出现两次以上的键(查重)。
 *
 * 不做任何表头特判:`#15` 检查器传 `cells.slice(1)` 进来,「表头不算键」这个语义归它,
 * 留在解析器里就会变成「这个函数到底跳不跳第一行」的第二次分叉。
 */
export function dupFirstCells(cells: CsvCell[]): { cell: string; lines: number[] }[] {
  const by = new Map<string, number[]>()
  for (const c of cells) {
    const list = by.get(c.cell)
    if (list) list.push(c.line)
    else by.set(c.cell, [c.line])
  }
  const out: { cell: string; lines: number[] }[] = []
  for (const [cell, lines] of by) if (lines.length > 1) out.push({ cell, lines })
  return out.sort((a, b) => a.lines[0] - b.lines[0])
}
