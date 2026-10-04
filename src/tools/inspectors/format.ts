// 工具页 P0b-B9:代码格式化(只做文本卫生)。spec §3.1 #9、§5.7、§5.3 四条硬规则、§6 风险表「格式化改坏源文件」。
//
// 一句话:把 `.gd` 脚本里**五件不涉及语义**的排版问题整理掉,整份新文本交给 B1 的 rewrite 通道。
// 五件是:删行尾空白、统一整行前导缩进、补齐文件末尾单个换行、统一换行符、把 3 行以上连续空行压成 1 行。
// 「不做」清单(简报钉的,刻意留白而不是漏做):不加也不去分号、不动运算符与冒号两侧空格、不改引号风格、
// 不重排 `if`/`()` 内的换行、不碰 `.gdshader`/`.cs`/`.tres`/`.cfg`、不碰 `.tscn` 内嵌的脚本文本 ——
// 那些要真解析 GDScript,是 gdformat 那种完整格式化器的活。
//
// ## 为什么这份文件里每一条闸都往「少改」的方向收
//
// P0b 前面六个工具要么只报告(B6/B7/B8),要么删**整个文件**(B4/B5/B6,后面还有回收站兜底)。
// 这个工具改写用户的源代码。备份(`.gpm-bak-`)能还原文件,还原不了「500 行无关 diff 污染了下一次提交」。
// 所以红线是:**任何一处不确定,就不要动那个字节**。落到实现上是五道闸:
//   1. `inString` 的行一个字节都不动 —— 多行字符串里的行尾空白、缩进、空行、换行符都是**内容**(判据 2);
//   2. 引号不成对时保守当作仍在字符串里,直到闭合或文件尾 —— 判据 1 的「少动」方向;
//   3. 前导空白混着 tab 与空格、或者按空格缩进而空格数不是 4 的整倍数 ⇒ 那一行的缩进不改;
//   4. 续行(上一行以 `\` 结尾)与括号未闭合的行**跳过缩进转换**,而且不参与缩进多数派统计(判据 4);
//   5. 只要有任一字符串**内容**里的换行符与代码区主导不同,整个文件的「换行符统一」直接不做;
//      正文里出现裸 `\r` 时同理(引擎自己就把这种字符当错误报,见 gdScript.ts 文件头的出处)。
// 计数与产出同一个循环累加(判据 7 要「可核对的计数」),测试里另有第二趟纯比较交叉核对。
//
// ## 缩进为什么按「文件自身的多数派」而不读编辑器设置(判据 3)
//
// 简报把这条钉死成文件内判定,原因是**取证**:编辑器那套缩进设置的键名与取值语义,在本仓**没有任何一份
// 真实 `project.godot` 文本**可以举证。按 B8-2/B6 立下的取证标准(拿不到证据就不判 —— `importFile.ts:71-110`
// 因为拿不到证据明确不判 png/glb),这里不读那个设置,只用该文件自己的前导空白多数派。
// 真要做「按项目设置统一」,得先举证键名与取值语义并上报裁定,不在本轮自己猜。
// tab↔空格换算用 4 格:它只是**本工具的换算口径**,卡面上不许说成「引擎或编辑器要求你项目这么缩进」。
//
// ## 产出形态与措辞(同 orphans.ts / imports.ts 的纪律)
//
// 一条聚合结论 `format:all`,只挂 `fix:{ kind:'rewrite', label:'格式化 N 个脚本', payload:{ files } }`。
// 动词、风险句、预览清单、备份与原子替换全部归 `fixPlan.ts` + B1 —— 检查器里再写一遍就是 B1 建这条
// 管线要防的漂移。卡面裁切只裁展示,`payload.files` 永远全量(§5.3 规则 3);每条 rel 都取自 `ctx.tree`,
// 所以 `planFix` 那句「清单外会新建文件、没有备份」的措辞永不触发(判据 6)。
//
// 红线:纯函数。不碰 window / services / vue / DOM、不写文件、不拼绝对路径;唯一 IO 是 await ctx.readText。
import type { Finding, ToolContext } from '../types'
import type { TreeEntry } from '../../types/godot'
import type { GdLineInfo, GdScan } from '../parsers/gdScript'
import { gdScopeOf, scanGdScript } from '../parsers/gdScript'
import { LIST_CAP, truncatedFinding } from '../finding'
import { fmtBytes } from '../treeUtils'

/** 一个文件里五类操作各改了多少处(与产出同一个循环累加 —— 判据 7 的「可核对计数」) */
export interface FormatCounts {
  /** 删掉行尾空白的行数 */
  trailing: number
  /** 前导缩进被转换的行数 */
  indent: number
  /** 压掉的多余空行数(3 行以上连续空行 → 1 行,所以这里最少是 2) */
  blank: number
  /** 末尾补了几个换行(0 或 1) */
  finalNL: number
  /** 换行符被改写的行数 */
  endings: number
}

/** 一个 .gd 的整理结果。`out === 原文` 时这个文件不进改写清单(零改动的文件不配上卡面) */
interface FileFormat {
  rel: string
  size?: number
  out: string
  counts: FormatCounts
  /** 「这一条为什么没做」,逐文件挂在卡面上(判据 5/7 都要它可见) */
  skips: string[]
}

/** 排除与降级计数,一律写进 detail(B5 立下的口径:藏起来的东西要在卡面上看得见) */
interface Excl {
  /** `.godot/**` 下的 .gd:生成的缓存,不归格式化管 */
  cache: number
  /** `addons/**` 下的 .gd:第三方插件代码,归 B7 */
  addons: number
  /** 进了读入面但 `readText` 给不出正文的(二进制 / 超限 / 读错误) */
  unread: number
}

/**
 * 截断时的降级说明(判据 10)。改写比报告更吃清单完整性:清单不全时卡面上的「N 个文件」
 * 既不是全部、也不能保证「这一份就是全部要改的」,所以一条改写都不提议。
 * 文案与 `finding.ts:22-30` 同一条纪律:**不许**建议用过滤来「缩小范围」。
 */
const WHY_TRUNC = '格式化要改的是文件正文,而「这些就是全部要改的」只有在清单完整时才敢说:' +
  '清单被截断时,没列进来的 .gd 既没被读也没被改,卡面上的文件数与各项计数都会是假的。所以本次一条改写都不提议。' +
  '请把 maxEntries 调高或做一次完整重扫后再看' +
  ' —— 别用排除目录、按扩展名筛选这类过滤来「缩小范围」:过滤后的清单同样不完整,却不会再带截断标记,结论只会更假。'

const TRUNC_TITLE = '文件清单被截断,本次不做代码格式化'

/** 卡面固定文案:做什么、不做什么、哪些字节永远不动。逐条与上面的实现对照,别写成第三份口径。 */
const SCOPE_TXT = ' 本次只做五项文本卫生:删行尾空白、统一整行前导缩进、补齐文件末尾单个换行、统一换行符、' +
  '把 3 行以上的连续空行压成 1 行(1-2 行的分节间隔不动)。'
const NOT_DOING = ' 不做:不加也不去分号、不动运算符与冒号两侧的空格、不改引号风格、不重排 if 或括号里的换行、' +
  '不碰 .gdshader/.cs/.tres/.cfg 与 .tscn 内嵌的脚本文本 —— 那些要真解析 GDScript,不在本次范围。'
const STRING_GUARD = ' 多行字符串(三个双引号或三个单引号包起来的写法)覆盖到的行一个字节都不动:' +
  '里面的行尾空白、缩进、空行与换行符都按内容保留;同一行里起止的多行字符串也算碰过,照样不动。' +
  '引号不成对的行同侧处理:从那行起到闭合引号(或文件尾)为止都当还在字符串里。'
const INDENT_TXT = ' 缩进目标按每个文件自己的多数派定,不读编辑器的缩进设置(那个设置的键名与取值语义在用户项目里' +
  '没有可举证的文本,拿它当依据就是猜);tab 与空格互转按 4 格宽,这个 4 只是本工具的换算口径,' +
  '不代表引擎或编辑器对你项目的要求。上一行以反斜杠续行、或括号还没闭合的行,前导空白是排版对齐,一律不转换。'
const BACKUP_TXT = ' 改写会先备份再原子替换,预览清单就是下面这些文件(逐文件勾选默认不选)。'

const empty = (s: string): boolean => s === '' || /^[ \t]+$/.test(s)

/** 只删行尾的空格与 tab:非 ASCII 空白(\f/\v/NBSP)不当「行尾空白」处理,那是内容 */
function rstrip(s: string): string {
  return s.replace(/[ \t]+$/, '')
}

/**
 * tab↔空格 的换算宽度。只是本工具的口径(为什么用它、它不代表什么见文件头与卡面文案)。
 * 用它的地方有两处:前导 tab 展开成空格、前导空格折回 tab。
 */
const TAB_WIDTH = 4

/** 前导空白的形状:纯 tab / 纯空格 / 混着 / 没有。混排只说明「不一致」,说不出目标形态,所以单独一档。 */
function leadKind(indent: string): 'tab' | 'space' | 'mixed' | 'none' {
  if (!indent) return 'none'
  const hasTab = indent.includes('\t')
  const hasSpace = indent.includes(' ')
  if (hasTab && hasSpace) return 'mixed'
  return hasTab ? 'tab' : hasSpace ? 'space' : 'none'
}

/**
 * 这一行的前导空白能不能作为「块缩进」处理(判据 3/4 的合取)。
 * · inString ⇒ 整行都不动,轮不到这里;
 * · continuation ⇒ 前导是「跟着上一行对齐」的排版意图,一刀切会把可读的多行调用弄丑(判据 4);
 * · 空行 ⇒ 不参与统计,也不参与转换:它的前导会被「删行尾空白」清掉。
 *   排除空行是必须的,否则一个文件里几行只写了 tab 的空行会把多数派投给 tab,凭空造出转换。
 */
function indentEligible(l: GdLineInfo): boolean {
  return !l.inString && !l.continuation && !empty(l.raw)
}

/**
 * 一份 `.gd` 文本 → 新文本 + 五类计数 + 逐条「为什么没做」。
 *
 * 顺序是有讲究的:①逐行整理(缩进、行尾空白)→ ②压空行(空行的判定必须在删尾随空白**之后**:
 * 一行只剩 tab 时,删掉它才算得上空行)→ ③统一换行符 → ④补末尾换行(要看前几步留下的末行形状)。
 * 换行符与末尾换行都要先看文件级闸门(`blockTermConflict` / `strayCR` / 平局),闸门不过就整条跳过,
 * 其余四条照做(判据 5)。
 */
export function formatGdText(text: string, scan?: GdScan): { out: string; counts: FormatCounts; skips: string[] } {
  const info: GdScan = scan || scanGdScript(text)
  const lines = info.lines
  const counts: FormatCounts = { trailing: 0, indent: 0, blank: 0, finalNL: 0, endings: 0 }
  const skips: string[] = []
  if (lines.length === 0) return { out: text, counts, skips } // 空文件:五类操作一律不动(表上明写)

  // ---------- 判据 3:目标缩进形态 = 本文件自己的多数派 ----------
  // 统计面就是 `indentEligible` 的行 —— 续行行不参与,理由与判据 4 同源:它的前导是对齐不是块缩进。
  // 混排前导既不算 tab 也不算 space(它说不出目标该是什么),只算「不一致」。
  let tabLines = 0
  let spaceLines = 0
  let mixedLeads = 0
  for (const l of lines) {
    if (!indentEligible(l)) continue
    const kind = leadKind(l.indent)
    if (kind === 'tab') tabLines++
    else if (kind === 'space') spaceLines++
    else if (kind === 'mixed') mixedLeads++
  }
  let target: 'tab' | 'space' | null = null
  if (tabLines === 0 && spaceLines === 0) {
    // 一种「干净前导」都没有:可能整份文件没有块缩进(不必说),也可能只剩混排前导(说不出多数派)。
    if (mixedLeads > 0) {
      skips.push(`统一缩进:${mixedLeads} 行的前导同时混着 tab 与空格,说不出这个文件的多数派,一处没改`)
    }
  } else if (tabLines === spaceLines) {
    // 平局 ⇒ 保持原样并报「无法判定」(判据 3)
    skips.push('统一缩进:前导 tab 的行与前导空格的行数打平,判不出多数派,一处没改')
  } else {
    target = tabLines > spaceLines ? 'tab' : 'space'
  }

  // ---------- ① 逐行整理:缩进 + 行尾空白(判据 2/3/4)----------
  const bodies = lines.map((l) => l.raw)
  let indentLeft = 0
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (l.inString) continue // ★ 这一行碰过字符串 ⇒ 一个字节都不动
    let body = l.raw
    if (target && indentEligible(l) && l.indent) {
      const kind = leadKind(l.indent)
      if (target === 'space') {
        // tab → 空格:形状确定(每个 tab 换成 4 格),混排前导也能确定性展开
        if (kind === 'tab' || kind === 'mixed') {
          const converted = l.indent.replace(/\t/g, ' '.repeat(TAB_WIDTH))
          if (converted !== l.indent) {
            body = converted + body.slice(l.indent.length)
            counts.indent++
          }
        }
      } else if (kind === 'space' && l.indent.length % TAB_WIDTH === 0) {
        // 空格 → tab:只有整倍数才折得回去,余数不知道该给几格 ⇒ 不动(判据 3 的「只动整行前导」)
        body = '\t'.repeat(l.indent.length / TAB_WIDTH) + body.slice(l.indent.length)
        counts.indent++
      } else if (kind === 'space' || kind === 'mixed') {
        indentLeft++
      }
    }
    const trimmed = rstrip(body)
    if (trimmed !== body) {
      body = trimmed
      counts.trailing++
    }
    bodies[i] = body
  }
  if (indentLeft > 0) {
    // 只有「目标 = tab」这一侧会走到这里:空格折回 tab 需要整倍数,混排前导也折不出唯一形状。
    // 目标 = 空格时混排前导是能确定性展开的(每个 tab 换成 4 格,与引擎按列计数的口径同形),所以不算少做。
    skips.push(`统一缩进:${indentLeft} 行的前导形状不确定(空格数不是 ${TAB_WIDTH} 的整倍数、或同一行里 tab 与空格混着),这些行没动`)
  }

  // ---------- ② 压缩 3 行以上连续空行(判据 2 的「空行」那一半)----------
  // 3 行及以上 → 1 行,保留**最后**那一行(它的终止符就是这段空行的收尾形状)。
  // 只碰非 inString 的空行:块内的空行是内容(★测试钉住的那条)。
  const keep: number[] = []
  let run: number[] = []
  const flush = (): void => {
    if (run.length >= 3) {
      counts.blank += run.length - 1
      keep.push(run[run.length - 1])
    } else {
      for (const i of run) keep.push(i)
    }
    run = []
  }
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].inString && bodies[i] === '') { run.push(i); continue }
    flush()
    keep.push(i)
  }
  flush()

  // ---------- ③④ 换行符统一 + 末尾单个换行(判据 5 与「文件末尾」那一行)----------
  const dominant = info.dominantTerm
  let applyEndings = false
  if (info.blockTermConflict) {
    skips.push('统一换行符:多行字符串里混着另一种换行符,改了就是改内容,整条没做(其余四条照做)')
  } else if (info.strayCR) {
    skips.push('统一换行符:正文中间出现裸 \\r(老式换行残留),形态认不出,整条没做')
  } else if (dominant === null && info.termCounts.crlf + info.termCounts.lf > 0) {
    skips.push('统一换行符:代码区里 CRLF 与 LF 的行数打平,判不出主导,整条没做')
  } else {
    applyEndings = dominant !== null
  }
  // 补末尾换行有四道「不动」闸:
  //   · 空文件(上面早退)· 全文只有注释与空行(简报表上明写「纯注释外」)
  //   · 末行碰过字符串(未闭合的串跨到文件尾 ⇒ 补换行是往内容里插字节)
  //   · 末行本身是空行(前两步已把尾巴清干净,再补就是凭空添一行)
  //   · 正文里有裸 `\r`(补 \n 会把它和 \n 拼成 CRLF,顺手改了换行形态)
  const lastKept = keep.length ? keep[keep.length - 1] : -1
  const pureComment = lines.every((l) => !l.inString && (empty(l.raw) || l.isComment))
  let finalNLBlocked = ''
  if (pureComment) finalNLBlocked = '补末尾换行:全文只有注释与空行,按约定不动'
  else if (info.strayCR) finalNLBlocked = '补末尾换行:正文中间有裸 \\r,补 \n 会顺手改掉换行形态,不动'
  else if (lastKept >= 0 && lines[lastKept].inString) finalNLBlocked = '补末尾换行:文件停在未闭合的字符串里,补就是改内容,不动'
  else if (lastKept >= 0 && bodies[lastKept] === '') finalNLBlocked = '补末尾换行:末行本来就是空行,不再添一行'

  let out = ''
  for (let k = 0; k < keep.length; k++) {
    const i = keep[k]
    const l = lines[i]
    let term = l.term
    if (applyEndings && !l.inString && term !== '' && term !== dominant) {
      term = dominant as string
      counts.endings++
    }
    if (k === keep.length - 1 && term === '' && !info.endsWithNewline && !finalNLBlocked && bodies[i] !== '') {
      // 补的那个换行用文件自己的主导形态;主导没定时用 \n(最常见的形态)
      term = dominant || '\n'
      counts.finalNL++
    }
    out += bodies[i] + term
  }
  return { out, counts, skips }
}

/** 卡面上一个文件的一行计数(测试按同样的形状反解出来做交叉核对,所以这里就是唯一一份形状) */
function countToken(c: FormatCounts): string {
  return `尾随空白 ${c.trailing}/缩进 ${c.indent}/空行 ${c.blank}/末尾换行 ${c.finalNL}/换行符 ${c.endings}`
}

/** 逐文件计数与「为什么少做」:每条 rel 都带自己的五类计数(判据 7),跳过的原因跟着 rel 说(判据 5) */
function perFileText(f: FileFormat): string {
  return `${f.rel}[${countToken(f.counts)}]${f.skips.length ? `{没做:${f.skips.join(';')}}` : ''}`
}

function aggregateFinding(files: FileFormat[], ex: Excl): Finding {
  const n = files.length
  const total: FormatCounts = { trailing: 0, indent: 0, blank: 0, finalNL: 0, endings: 0 }
  for (const f of files) {
    total.trailing += f.counts.trailing
    total.indent += f.counts.indent
    total.blank += f.counts.blank
    total.finalNL += f.counts.finalNL
    total.endings += f.counts.endings
  }
  const shown = files.slice(0, LIST_CAP)
  const hidden = n - shown.length
  const bytes = files.reduce((a, f) => a + (typeof f.size === 'number' && f.size > 0 ? f.size : 0), 0)
  return {
    id: 'format:all',
    severity: 'info',
    title: `代码格式化(文本卫生):${n} 个 .gd 脚本可以整理`,
    detail: `会改写 ${n} 个 .gd 脚本的正文,合计原体积 ${fmtBytes(bytes)}。` +
      `总计改动:尾随空白 ${total.trailing} 行、缩进 ${total.indent} 行、压掉空行 ${total.blank} 行、` +
      `补末尾换行 ${total.finalNL} 个文件、换行符 ${total.endings} 行。` +
      `逐文件计数(按 rel 码元序):${shown.map(perFileText).join(' ')}。` +
      (hidden ? ` 这里只列前 ${shown.length} 个文件,另有 ${hidden} 个文件未列出;下面这个动作仍按全部 ${n} 个执行。` : '') +
      SCOPE_TXT + STRING_GUARD + INDENT_TXT + BACKUP_TXT + NOT_DOING +
      ` 默认不参与:addons 目录下的 .gd ${ex.addons} 个(第三方插件代码,归插件体检那条)、` +
      `.godot 缓存里的 .gd ${ex.cache} 个;读不进正文的 .gd ${ex.unread} 个整份跳过 —— ` +
      '读不到就什么都不做,绝不会把「读不到」当成「改成空文件」。',
    rel: files[0].rel,
    related: shown.map((f) => f.rel),
    // 只带 kind/label/payload:动词、风险句、预览清单都是 fixPlan.ts 的活(见文件头措辞纪律)。
    // payload.files 全量(不裁),因为确认框必须列全(spec §5.3 规则 3)。
    fix: { kind: 'rewrite', label: `格式化 ${n} 个脚本`, payload: { files: files.map((f) => ({ rel: f.rel, text: f.out })) } }
  }
}

/** 码元序比较:顺序、id、计数都要跨机器逐字节一致(同 orphans.ts:49-51) */
function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export async function run(ctx: ToolContext): Promise<Finding[]> {
  // 判据 10:清单不全 ⇒ 不读、不改写、不报可执行结论(整趟 IO 一次都不发起)
  if (ctx.truncated) return [truncatedFinding('format', WHY_TRUNC, TRUNC_TITLE)]

  const tree: TreeEntry[] = Array.isArray(ctx.tree) ? ctx.tree : []
  const ex: Excl = { cache: 0, addons: 0, unread: 0 }
  const targets: { rel: string; size?: number }[] = []
  const seen = new Set<string>()
  for (const f of tree) {
    const scope = gdScopeOf(f)
    if (scope === 'cache') { ex.cache++; continue }
    if (scope === 'addons') { ex.addons++; continue }
    if (scope !== 'target') continue
    if (seen.has(f.rel)) continue // 畸形清单里同一个 rel 出现两次:只读一次、也只进一次改写
    seen.add(f.rel)
    targets.push({ rel: f.rel, size: typeof f.size === 'number' ? f.size : undefined })
  }
  // 判据 9:读入与展示顺序都按 rel 码元序,不跟 ctx.tree 的顺序
  targets.sort((a, b) => byText(a.rel, b.rel))

  const files: FileFormat[] = []
  for (const t of targets) {
    const { text } = await ctx.readText(t.rel)
    // 判据 10:给不出正文(二进制 / 超限 / 读错误)就整份跳过 —— 不产 rewrite,不写空文件
    if (typeof text !== 'string') { ex.unread++; continue }
    const r = formatGdText(text)
    if (r.out === text) continue // 干净文件:不进清单
    files.push({ rel: t.rel, size: t.size, out: r.out, counts: r.counts, skips: r.skips })
  }

  // 判据 7:一个文件都不用改时不发卡(outcomeOf 那条「未发现问题」是它的活);
  // 只跳过了几类操作但没有改动的文件也不单独发卡 —— 那属于「没做好但也没动」,不占卡位。
  if (files.length === 0) return []
  return [aggregateFinding(files, ex)]
}
