// 工具箱 · 行级 LCS diff(纯函数,预览用)。
//
// Q16=B 把三段式定成框架强制,前提是**预览真的能看出改了哪里**。对「GDScript 代码格式化」来说,
// 如果 diff 只显示「player.gd 会被改」,那 dry-run 就只是盲改前给你看个文件名 —— 所以 §5.8 把 diff
// 划进第 1 批必做,而 §7 A-9 要求它有独立断言 + 变异取证(把 LCS 换成朴素逐行比对要红)。
//
// 为什么不引库:本仓库零运行时依赖,而显示层只要「哪些行相同 / 哪些删了 / 哪些加了」这一种事实。
//
// 算法与预算(DEV-9):
//   1. 先剥公共前缀与公共后缀。格式化产生的差异几乎全是局部的(改缩进、去尾空格),这一步就把
//      LCS 的规模压到中间那一小段;
//   2. 中间段跑经典 LCS 动态规划。为了**只算一趟**,把每格的来路记进一张 2-bit 宽的有符号表
//      (Int8Array:-1=对齐/相等,0=从上=删,1=从左=增),回溯直接读它;
//   3. 单元格数超过 maxCells 就放弃逐行比对,退化成「两侧行数 + 中间差异行数」的摘要并标 degraded。
//      退化必须**看得见**:UI 要如实说「差异过大,未逐行比对」,不许拿一个像 diff 的东西糊过去;
//   4. degraded 的那条照样可勾选、照样可执行 —— diff 只是预览,不是判据(DEV-8)。
//
// 红线:纯函数。不碰 window / vue / fs。行切分只按 `\n`(与 parsers/gdScript.ts 同一口径)——
// 那边守着「raw + term 逐字节可还原原文」,这里再发明一套切分就是第二份真相。

/** LCS 的单元格预算:20k × 20k = 4 亿格会把界面冻死,超过就退化(DEV-9) */
export const MAX_LCS_CELLS = 4_000_000

export type DiffOp = 'same' | 'del' | 'add'

export interface DiffLine {
  op: DiffOp
  /** 新文件里的行号(1-based);op==='del' 时是 null */
  newNo: number | null
  /** 旧文件里的行号(1-based);op==='add' 时是 null */
  oldNo: number | null
  text: string
}

export interface FileDiff {
  /** 完整逐行结果(含公共前后缀,UI 要能给出上下文) */
  lines: DiffLine[]
  /** 中间差异段的增删行数(公共前后缀不计入,所以「格式化只动 2 行」就说 2) */
  added: number
  removed: number
  oldCount: number
  newCount: number
  /** 过大而没做逐行比对 ⇒ true,lines 为空 */
  degraded: boolean
  /** 两侧逐行一致:UI 该显示「无变化」而不是零个 +/- */
  identical: boolean
}

/** 只按 `\n` 切;空串是「零行」而不是「一行为空的行」(与 scanGdScript 同一口径) */
function toLines(text: unknown): string[] {
  if (typeof text !== 'string') return []
  if (text === '') return []
  return text.split('\n')
}

const ALIGN = -1
const FROM_UP = 0
const FROM_LEFT = 1

/**
 * 一份文件的行级差异。
 *
 * 入参宽容:非字符串当空文本(上游是宿主读回来的 text,可能缺字段),但**不抛异常** ——
 * 预览渲染器里抛异常等于整页白屏。
 * maxCells 是**中间段**的格子预算,注入它是为了让退化路径能在断言里跑(不必造 4 亿行的文件)。
 */
export function diffText(oldText: unknown, newText: unknown, maxCells: number = MAX_LCS_CELLS): FileDiff {
  const a = toLines(oldText)
  const b = toLines(newText)
  if (!a.length && !b.length) {
    return { lines: [], added: 0, removed: 0, oldCount: 0, newCount: 0, degraded: false, identical: true }
  }

  // ---- 1. 剥公共前缀 / 后缀 ----
  let p = 0
  while (p < a.length && p < b.length && a[p] === b[p]) p++
  let s = 0
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++

  const midA = a.slice(p, a.length - s)
  const midB = b.slice(p, b.length - s)
  const head: DiffLine[] = []
  for (let k = 0; k < p; k++) head.push({ op: 'same', newNo: k + 1, oldNo: k + 1, text: a[k] })
  const tail: DiffLine[] = []
  for (let k = 0; k < s; k++) {
    const oi = a.length - s + k
    const ni = b.length - s + k
    tail.push({ op: 'same', newNo: ni + 1, oldNo: oi + 1, text: a[oi] })
  }

  if (!midA.length && !midB.length) {
    // 前后缀吃满 ⇒ 两侧逐行相同:同一行号、零增删,identical 必须为真
    return {
      lines: [...head, ...tail], added: 0, removed: 0,
      oldCount: a.length, newCount: b.length, degraded: false, identical: true
    }
  }

  // ---- 2. 预算闸 ----
  if (maxCells >= 0 && midA.length * midB.length > maxCells) {
    return {
      lines: [], added: midB.length, removed: midA.length,
      oldCount: a.length, newCount: b.length, degraded: true, identical: false
    }
  }

  // ---- 3. LCS 一趟 DP + 来路表 ----
  const n = midA.length
  const m = midB.length
  const width = m + 1
  const dp = new Int32Array((n + 1) * width)
  const back = new Int8Array((n + 1) * width)
  for (let i = 1; i <= n; i++) {
    const row = i * width
    const up = (i - 1) * width
    for (let j = 1; j <= m; j++) {
      if (midA[i - 1] === midB[j - 1]) {
        dp[row + j] = dp[up + j - 1] + 1
        back[row + j] = ALIGN
      } else if (dp[up + j] >= dp[row + j - 1]) {
        dp[row + j] = dp[up + j]
        back[row + j] = FROM_UP
      } else {
        dp[row + j] = dp[row + j - 1]
        back[row + j] = FROM_LEFT
      }
    }
  }

  const mid: DiffLine[] = []
  let i = n
  let j = m
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && back[i * width + j] === ALIGN) {
      mid.push({ op: 'same', newNo: p + i, oldNo: p + i, text: midA[i - 1] })
      i--; j--
    } else if (i > 0 && (j === 0 || back[i * width + j] === FROM_UP)) {
      mid.push({ op: 'del', newNo: null, oldNo: p + i, text: midA[i - 1] })
      i--
    } else {
      mid.push({ op: 'add', newNo: p + j, oldNo: null, text: midB[j - 1] })
      j--
    }
  }
  mid.reverse()

  // added/removed **按 emit 出来的 op 数**,不是中间段的行数:
  // 交错改动(b→B、d→D,中间的 c 其实没动)时,中间段是 3 行,而真实只增 2 删 2。
  // 拿中间段长度当统计会让预览虚报「+3 -3」,而格式化那张卡的「动了几个字节」就是从这里来的。
  let added = 0
  let removed = 0
  for (const x of mid) {
    if (x.op === 'add') added++
    else if (x.op === 'del') removed++
  }

  return {
    lines: [...head, ...mid, ...tail],
    added,
    removed,
    oldCount: a.length,
    newCount: b.length,
    degraded: false,
    identical: false
  }
}

/**
 * 一个改动块:`changed` 是块内要画的行(已含上下文),startOld/startNew 是**第一行**的行号。
 * 显示层的折叠策略,不参与任何执行判据。
 */
export interface DiffHunk {
  startOld: number
  startNew: number
  lines: DiffLine[]
}

/**
 * 把 lines 切成改动块:连续 same 超过 `context` 行就只留边上的 context 行当上下文。
 * 两块之间隔得不超过 `context * 2` 行 same 就并成一块(否则格式化会产生一堆只有一行的碎块)。
 * 纯显示逻辑,但必须有断言:A-9 说的「行级 LCS」在 UI 上是以块为单位出现的。
 */
export function hunks(lines: readonly DiffLine[], context = 3): DiffHunk[] {
  const src = Array.isArray(lines) ? lines : []
  const changed: number[] = []
  for (let i = 0; i < src.length; i++) if (src[i] && src[i].op !== 'same') changed.push(i)
  if (!changed.length) return []

  const out: DiffHunk[] = []
  let blockStart = 0
  // prev 必须从**第一个改动行**起算,不是 0:初始化成 0 会让第 1、2 个改动行之间的距离凭空多出 1,
  // context=0 时一处改动被拆成两块(Task 3 实测抓到)。
  let prev = changed[0]
  const flush = (endK: number): void => {
    let lo = changed[endK]
    let hi = changed[endK]
    for (let k = blockStart; k <= endK; k++) {
      if (changed[k] < lo) lo = changed[k]
      if (changed[k] > hi) hi = changed[k]
    }
    // 下界只要 `lo - context`(夹在 0 与块首之间):两块之间隔得开(> 2·context+1 行 same),
    // 上下文就天然不重叠,不需要再记上一块的结束位置。
    const from = Math.max(0, lo - context)
    const to = Math.min(src.length - 1, hi + context)
    const slice = src.slice(from, to + 1)
    const first = slice[0] || src[hi]
    out.push({
      startOld: first ? first.oldNo ?? first.newNo ?? 0 : 0,
      startNew: first ? first.newNo ?? first.oldNo ?? 0 : 0,
      lines: slice
    })
  }
  for (let k = 1; k < changed.length; k++) {
    if (changed[k] - prev > context * 2 + 1) {
      flush(k - 1)
      blockStart = k
    }
    prev = changed[k]
  }
  flush(changed.length - 1)
  return out
}

/** 预览标题那一句:格式化的差异通常极小,所以「无变化」与「+2 -1」要分得清 */
export function diffStat(d: FileDiff | null | undefined): string {
  if (!d) return '没有可比对的差异'
  if (d.degraded) return `差异过大,未逐行比对(旧 ${d.oldCount} 行 / 新 ${d.newCount} 行)`
  if (d.identical) return '无变化'
  return `+${d.added} -${d.removed}`
}

/** rename 预览的对照(§5.8 的另一种预览形态):旧名 → 新名,一行一条 */
export function renamePairs(changes: readonly { rel?: unknown; to?: unknown }[]): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = []
  for (const c of Array.isArray(changes) ? changes : []) {
    if (!c || typeof c.rel !== 'string' || typeof c.to !== 'string') continue
    if (!c.rel || !c.to || c.rel === c.to) continue
    out.push({ from: c.rel, to: c.to })
  }
  return out
}
