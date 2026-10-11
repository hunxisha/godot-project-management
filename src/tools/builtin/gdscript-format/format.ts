// GDScript 代码格式化 · 纯算法层(§5.7 的「文本卫生级」五件事 / A-11)。
//
// 这一层是从 git 历史里捞出来的旧 `src/tools/inspectors/format.ts` 改写的(第 0 批 Task 3 随体检一起拆掉,
// 恢复自 `2382316~1`),**算法骨架一条判据都没重新发明**:
//   · 顺序照旧 ①逐行整理(缩进 + 行尾空白)→ ②折叠空行 → ③统一换行符 → ④补末尾换行,
//     空行的判定必须在删尾随空白之后(一行只剩 tab 时,删掉它才算得上空行);
//   · 「哪些字节不许动」继续直接吃 `parsers/gdScript.ts` 的分类器,不重写(§5.7 明写),
//     所以 A-11 的保守性契约由解析器那一层的断言兜着;
//   · 计数与产出同一个循环累加,「少做了 N 行」必须说得出为什么(旧判据 7)。
//
// 与旧实现的两处**故意**不同,都记在这里而不是埋在代码里:
//   1. 目标缩进形态不再靠「本文件的多数派」猜,而是 §5.7 给用户显式选(保持原样 / Tab / 空格 2 / 空格 4)。
//      猜多数派时代码里那两处「平局就说判不出」的降级随之消失,但**折算本身的两道闸原样保留**:
//      混排前导两个方向都不转、空格数不是整倍数不折 —— 折不出唯一形状就不动(旧判据 3)。
//   2. 连续空行按参数折(旧实现固定「3 行以上折成 1 行」,即 2 行空行是合法的);
//      新默认「最多 1 行」比旧的严,由用户勾着走,不是实现自己加戏。
//
// DEV-17(本批偏离):旧判据 8 的「`.godot/**` 与 `addons/**` 排除计数」在这里**不再保留**。
// 理由:那是体检时代的产物 —— 那时是「框架替用户挑文件」,所以要防引擎缓存目录被误伤;
// 工具箱里 `files` 是用户自己勾的选中集(§F 契约补充第 2 条:插件不许自己去 scanTree 猜),
// 静默把用户勾中的文件排除掉才是新的错。非 `.gd` 的文件由 schema 的 `exts` 在挑选阶段就挡住。
// 反悔成本:低(要恢复就在 `plan` 里加一次路径段判断 + 一条参数开关)。拍板人是我。

import type { GdLineInfo, GdScan } from '../../parsers/gdScript'
import { scanGdScript } from '../../parsers/gdScript'

/** §5.7 的缩进档:保持原样 / Tab / 空格(2 或 4) */
export type IndentTarget = 'keep' | 'tab' | 'space2' | 'space4'
/** §5.7 的换行符档:保持 / LF / CRLF */
export type EndingTarget = 'keep' | 'lf' | 'crlf'

export interface FormatOpts {
  indent: IndentTarget
  trailing: boolean
  finalNewline: boolean
  endings: EndingTarget
  collapseBlank: boolean
  /** 折叠后允许保留的连续空行数(0 表示一段都不留) */
  maxBlank: number
}

export interface FormatCounts {
  trailing: number
  indent: number
  blank: number
  finalNL: number
  endings: number
}

export interface FormatResult {
  out: string
  counts: FormatCounts
  /** 「这条为什么没做 / 少做了多少」,逐文件跟着 rel 上卡面(旧判据 7) */
  skips: string[]
}

/** 表单默认值(§5.7 的 ● 那一档)。index.ts 的 schema 与此处必须同值,测试钉住这条 */
export const DEFAULT_OPTS: FormatOpts = {
  indent: 'tab',
  trailing: true,
  finalNewline: true,
  endings: 'lf',
  collapseBlank: true,
  maxBlank: 1
}

/** 空格↔tab 折算的「一级多宽」:空格目标就用用户选的那档宽度,tab 目标沿用旧的 4 格口径 */
const TAB_LEVEL_WIDTH = 4
const SPACE_WIDTH: Record<'space2' | 'space4', number> = { space2: 2, space4: 4 }

const INDENTS: readonly string[] = ['keep', 'tab', 'space2', 'space4']
const ENDINGS: readonly string[] = ['keep', 'lf', 'crlf']

const empty = (s: string): boolean => s === '' || /^[ \t]+$/.test(s)

/** 只删行尾的空格与 tab:非 ASCII 空白(\f/\v/NBSP)不当「行尾空白」处理,那是内容 */
function rstrip(s: string): string {
  return s.replace(/[ \t]+$/, '')
}

/** 前导空白的形状:纯 tab / 纯空格 / 混着 / 没有。混排说不出目标形态,所以单独一档。 */
function leadKind(indent: string): 'tab' | 'space' | 'mixed' | 'none' {
  if (!indent) return 'none'
  const hasTab = indent.includes('\t')
  const hasSpace = indent.includes(' ')
  if (hasTab && hasSpace) return 'mixed'
  return hasTab ? 'tab' : hasSpace ? 'space' : 'none'
}

/**
 * 这一行的前导空白能不能作为「块缩进」处理(旧判据 3/4 的合取,原样保留)。
 * · inString ⇒ 整行都不动,轮不到这里;
 * · continuation ⇒ 前导是「跟着上一行对齐」的排版意图,一刀切会把可读的多行调用弄丑;
 * · 空行 ⇒ 它的前导会被「删行尾空白」清掉,不该再被当缩进处理。
 * 目标形态改成用户显式选之后,「不参与多数派统计」这一半用不上了,但**不转换**这一半必须留着。
 */
function indentEligible(l: GdLineInfo): boolean {
  return !l.inString && !l.continuation && !empty(l.raw)
}

/**
 * 把表单来的参数读成 FormatOpts。
 *
 * 判据方向与 `schema.ts` 一致:**认不出来的值不猜**。
 * 具体分两种:字段缺失 ⇒ 用声明的默认值(表单上显示的就是它,按默认走才对得上用户看到的界面);
 * 字段给了但值不合法 ⇒ 把**那一条**关掉并写进 skips,其余四条照做(旧判据 5 的同一形状)。
 */
export function optsFrom(params: unknown): { opts: FormatOpts, skips: string[] } {
  const p = (params && typeof params === 'object' && !Array.isArray(params) ? params : {}) as Record<string, unknown>
  const skips: string[] = []
  const d = DEFAULT_OPTS

  let indent: IndentTarget = d.indent
  if (p.indent === undefined) indent = d.indent
  else if (typeof p.indent === 'string' && INDENTS.includes(p.indent)) indent = p.indent as IndentTarget
  else { indent = 'keep'; skips.push(`统一缩进:参数值「${String(p.indent)}」不是框架认识的档(keep / tab / space2 / space4),这条没做`) }

  let endings: EndingTarget = d.endings
  if (p.endings === undefined) endings = d.endings
  else if (typeof p.endings === 'string' && ENDINGS.includes(p.endings)) endings = p.endings as EndingTarget
  else { endings = 'keep'; skips.push(`统一换行符:参数值「${String(p.endings)}」不是框架认识的档(keep / lf / crlf),这条没做`) }

  let maxBlank = d.maxBlank
  if (p.max_blank !== undefined) {
    const n = p.max_blank
    if (typeof n !== 'number' || !Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 4) {
      maxBlank = -1
      skips.push(`折叠空行:参数「${String(n)}」不是 0–4 之间的整数,这条没做`)
    } else {
      maxBlank = n
    }
  }

  return {
    opts: {
      indent,
      endings,
      maxBlank,
      // 三个开关:缺失走默认;给了但不是布尔 ⇒ 按「没要这条」处理(布尔没有第三种合法取值可猜)
      trailing: p.trailing === undefined ? d.trailing : p.trailing === true,
      finalNewline: p.final_newline === undefined ? d.finalNewline : p.final_newline === true,
      collapseBlank: p.collapse_blank === undefined ? d.collapseBlank : p.collapse_blank === true
    },
    skips
  }
}

const TARGET_LABEL: Record<IndentTarget, string> = {
  keep: '保持原样',
  tab: 'Tab',
  space2: '2 个空格',
  space4: '4 个空格'
}

/**
 * 一份 `.gd` 文本 → 新文本 + 五类计数 + 逐条「为什么没做」。
 *
 * 纯函数:同一份文本 + 同一份参数永远得到同一份结果(账本与 diff 都靠这个前提)。
 */
export function formatGdText(text: unknown, opts?: Partial<FormatOpts>): FormatResult {
  const o: FormatOpts = { ...DEFAULT_OPTS, ...(opts || {}) }
  const counts: FormatCounts = { trailing: 0, indent: 0, blank: 0, finalNL: 0, endings: 0 }
  const skips: string[] = []
  if (typeof text !== 'string') return { out: '', counts, skips: ['内容不是文本,一处没改'] }
  const info: GdScan = scanGdScript(text)
  const lines = info.lines
  // 空文本是「零行」而不是「一行为空的行」:空文件五类操作一律不动(别给它造出一行来)
  if (lines.length === 0) return { out: text, counts, skips }

  // ---------- ① 逐行整理:缩进 + 行尾空白 ----------
  const bodies = lines.map((l) => l.raw)
  let indentLeft = 0
  const wantTab = o.indent === 'tab'
  const spaceWidth = o.indent === 'space2' || o.indent === 'space4' ? SPACE_WIDTH[o.indent] : 0
  // 目标形态认不出来时**不猜**:走「保持原样」并把这条拒因写进 skips(与 optsFrom 同一方向)
  const doIndent = wantTab || spaceWidth > 0
  if (!doIndent && o.indent !== 'keep') skips.push(`统一缩进:目标形态「${String(o.indent)}」不是框架认识的档(keep / tab / space2 / space4),这条没做`)
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (l.inString) continue // ★ 这一行碰过多行字符串/未闭合引号 ⇒ 一个字节都不动
    let body = l.raw
    if (doIndent && indentEligible(l) && l.indent) {
      const kind = leadKind(l.indent)
      if (kind === 'mixed') {
        // 前导同时混着 tab 与空格 ⇒ 两个方向都不折。tab 是走到**下一个制表位**而不是固定宽度,
        // `' ' + '\t'` 落第 4 列而 5 个空格落第 5 列:展开出来的那一行会和同块其它行错开一列。
        indentLeft++
      } else if (wantTab && kind === 'space') {
        // 空格 → tab:只有整倍数才折得回去,余数不知道该给几格 ⇒ 不动
        if (l.indent.length % TAB_LEVEL_WIDTH === 0) {
          body = '\t'.repeat(l.indent.length / TAB_LEVEL_WIDTH) + body.slice(l.indent.length)
          counts.indent++
        } else {
          indentLeft++
        }
      } else if (!wantTab && kind === 'tab') {
        // tab → 空格:纯 tab 前导的形状是确定的(每个 tab 换成所选那一档的宽度)
        const converted = l.indent.replace(/\t/g, ' '.repeat(spaceWidth))
        if (converted !== l.indent) {
          body = converted + body.slice(l.indent.length)
          counts.indent++
        }
      }
    }
    if (o.trailing) {
      const trimmed = rstrip(body)
      if (trimmed !== body) {
        body = trimmed
        counts.trailing++
      }
    }
    bodies[i] = body
  }
  if (indentLeft > 0) {
    // 「少做了 N 行」必须上卡:否则用户看到的还是那句「统一整行前导缩进」被静默少做
    skips.push(`统一缩进:${indentLeft} 行的前导形状不确定(空格数不是 ${wantTab ? TAB_LEVEL_WIDTH : spaceWidth} 的整倍数、或同一行里 tab 与空格混着),这些行没动`)
  }

  // ---------- ② 折叠连续空行(只碰非 inString 的空行:块内的空行是内容)----------
  const maxBlank = o.collapseBlank && o.maxBlank >= 0 ? o.maxBlank : -1
  const keep: number[] = []
  let run: number[] = []
  const flush = (): void => {
    if (maxBlank >= 0 && run.length > maxBlank) {
      // 保留**末尾那几行**:它们的终止符就是这段空行的收尾形状
      counts.blank += run.length - maxBlank
      for (let k = Math.max(0, run.length - maxBlank); k < run.length; k++) keep.push(run[k])
    } else {
      for (const i of run) keep.push(i)
    }
    run = []
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].inString || bodies[i] !== '') {
      flush()
      keep.push(i)
      continue
    }
    run.push(i)
  }
  flush()

  // ---------- ③④ 换行符统一 + 末尾单个换行 ----------
  // 三条闸门原样保留:改这些会把**内容**或用户没要的东西一起改掉,所以整条拒,其余照做。
  let targetTerm: string | null = o.endings === 'lf' ? '\n' : o.endings === 'crlf' ? '\r\n' : null
  let applyEndings = targetTerm !== null
  if (applyEndings && info.blockTermConflict) {
    skips.push('统一换行符:多行字符串里混着另一种换行符,改了就是改内容,这条没做(其余几条照做)')
    applyEndings = false
  } else if (applyEndings && info.strayCR) {
    skips.push('统一换行符:正文中间出现裸 \\r(老式换行残留),形态认不出,这条没做')
    applyEndings = false
  } else if (o.endings !== 'keep' && targetTerm === null) {
    skips.push(`统一换行符:目标形态「${String(o.endings)}」不是框架认识的档(keep / lf / crlf),这条没做`)
  }
  // 补末尾换行那四道「不动」闸原样保留(未闭合串跨到文件尾 / 全文只有注释与空行 / 末行是空行 / 裸 \r)
  const lastKept = keep.length ? keep[keep.length - 1] : -1
  const pureComment = lines.every((l) => !l.inString && (empty(l.raw) || l.isComment))
  let finalNLBlocked = ''
  if (!o.finalNewline) finalNLBlocked = ''
  else if (pureComment) finalNLBlocked = '补末尾换行:全文只有注释与空行,按约定不动'
  else if (info.strayCR) finalNLBlocked = '补末尾换行:正文中间有裸 \\r,补 \\n 会顺手改掉换行形态,不动'
  else if (lastKept >= 0 && lines[lastKept].inString) finalNLBlocked = '补末尾换行:文件停在未闭合的字符串里,补就是改内容,不动'
  else if (lastKept >= 0 && bodies[lastKept] === '') finalNLBlocked = '补末尾换行:末行本来就是空行,不再添一行'
  // 只在**真的欠一个换行**时才写这条理由:本来就以换行收尾时没什么可补,虚报一条「没做」比不报更糟
  if (o.finalNewline && finalNLBlocked && !info.endsWithNewline) skips.push(finalNLBlocked)

  let out = ''
  for (let k = 0; k < keep.length; k++) {
    const i = keep[k]
    const l = lines[i]
    let term = l.term
    if (applyEndings && !l.inString && term !== '' && term !== targetTerm) {
      term = targetTerm as string
      counts.endings++
    }
    if (k === keep.length - 1 && term === '' && !info.endsWithNewline && o.finalNewline && !finalNLBlocked && bodies[i] !== '') {
      // 补的那个换行:用户给了目标就用目标,选「保持」时用文件自己的主导形态,主导没定时用 \n
      term = targetTerm || info.dominantTerm || '\n'
      counts.finalNL++
    }
    out += bodies[i] + term
  }
  return { out, counts, skips }
}

/** 卡面上一个文件的一行计数(计数与产出同源,测试按同样的形状反解出来交叉核对) */
export function countToken(c: FormatCounts): string {
  return `尾随空白 ${c.trailing}/缩进 ${c.indent}/空行 ${c.blank}/末尾换行 ${c.finalNL}/换行符 ${c.endings}`
}

/** 目标形态那一句话(措辞只在这里有一份,label 与 reason 都从这里取) */
export function indentTargetText(t: IndentTarget): string {
  return TARGET_LABEL[t] || t
}
