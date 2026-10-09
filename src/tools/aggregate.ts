// 聚合问题流的判据:把 18 项工具的结论跨工具分组、排序、筛选。
// 住在纯函数层而不是 .vue 的先例见 src/tools/outcome.ts:1-4 —— 判据写进组件就跑不进 Node harness,
// 而「哪条排最上面」正是这一页的产品主张:说错话的代价是用户看不见要紧的那几条。
import { CATEGORIES } from './registry'
import { planFix } from './fixPlan'
import type { AggFinding, AggGroup, Severity, Tool, ToolResult } from './types'

/** 本模块的输入输出类型住在 types.ts(与 Finding/ToolResult 同层),这里转出统一的取用面 */
export type { AggFinding, AggGroup } from './types'

/** 严重度从重到轻的档位;组的排序、组内的排序、陈旧判定都只看这一个表 */
export const SEV_RANK: Record<Severity, number> = { error: 0, warn: 1, info: 2 }

/**
 * @param tools   注册表顺序的那一份(视图从 useTools.tools 取)
 * @param results 按 toolId 存的本轮结论
 * @param isWin   planFix 的平台口径(动词与可执行性相关)。纯函数不许自己去问 bridge:
 *                否则同一份输入在 Windows 与非 Windows 宿主上会跑出不同的组,断言就写不死了。
 *
 * 顺序的两条规矩:
 *  · 组间按「该组最高严重度 → 该组 error 条数 → CATEGORIES 里的位置」;
 *  · 组内按严重度,**同档保持注册表顺序**。累加按 tools 顺序 push,同档不重排因此稳定成立,
 *    将来即使 Array.prototype.sort 的实现变了也不会让同一份输入排出两种顺序。
 */
export function aggregate(tools: Tool[], results: Record<string, ToolResult>, isWin: boolean): AggGroup[] {
  const meta = new Map(CATEGORIES.map((c) => [c.id, c]))
  const out: AggGroup[] = []
  for (const t of tools) {
    const r = results[t.id]
    // 失败的工具不产组:它在摘要带与左栏徽标上点名,不许在问题流里冒充结论
    if (!r || !r.ok) continue
    for (const finding of r.findings) {
      // 「可修复」的口径只认 planFix,与 useTools.counts 那一路同源(视图里不许有第二套判据)
      const plan = planFix(finding, [], isWin)
      const item: AggFinding = {
        finding,
        toolId: t.id,
        toolName: t.name,
        category: t.category,
        fixable: plan.service !== null && !plan.empty
      }
      let g = out.find((x) => x.category === t.category)
      if (!g) {
        const m = meta.get(t.category)
        g = {
          category: t.category,
          label: m ? m.label : t.category,
          icon: m ? m.icon : 'wrench',
          counts: { error: 0, warn: 0, info: 0 },
          items: []
        }
        out.push(g)
      }
      g.items.push(item)
    }
  }
  // 计数与排序都按「组内这一份 items」算一遍:分档计数只留一个算法,
  // 聚合、筛选、裁剪三条路同源,否则三处数字会各自漂移
  for (const g of out) {
    g.items.sort((a, b) => SEV_RANK[a.finding.severity] - SEV_RANK[b.finding.severity])
    g.counts = countsOf(g.items)
  }
  const catOrder = CATEGORIES.map((c) => c.id)
  const rank = (g: AggGroup) => (g.items.length ? SEV_RANK[g.items[0].finding.severity] : 9)
  out.sort((a, b) => rank(a) - rank(b)
    || b.counts.error - a.counts.error
    || catOrder.indexOf(a.category) - catOrder.indexOf(b.category))
  return out
}

/** 聚合流的筛选条件。`sev: 'all'` 表示不按严重度筛。 */
export interface FilterSel {
  sev: 'all' | Severity
  fixableOnly: boolean
  query: string
}

/**
 * 筛选判据也住纯函数层:「大小写敏不敏感」「匹配 title 还是 rel」是产品口径,不是视图细节
 * —— 只有口径能进 Node 断言。
 * 筛选后的 counts 重算并与 items.length 一致:组头数字若仍是筛选前的总数,
 * 用户会拿它跟屏面上的行数对账而对不上。
 */
export function filterGroups(groups: AggGroup[], sel: FilterSel): AggGroup[] {
  const q = sel.query.trim().toLowerCase()
  const out: AggGroup[] = []
  for (const g of groups) {
    const items = g.items.filter((it) => {
      if (sel.sev !== 'all' && it.finding.severity !== sel.sev) return false
      if (sel.fixableOnly && !it.fixable) return false
      if (q) {
        const hay = `${it.finding.title}\n${it.finding.rel || ''}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
    if (!items.length) continue
    out.push(regroup(g, items))
  }
  return out
}

/**
 * 单工具模式:把聚合结果裁成「只有那一项」的组。
 * 住在纯函数层而不是视图里 —— 视图一旦把组压平再自己筛,组头计数与「展开其余 N 条」
 * 就得重算第二遍,而这两处数字与聚合模式必须同源,否则同一批数据两处对不上账。
 */
export function filterToTool(groups: AggGroup[], toolId: string): AggGroup[] {
  const out: AggGroup[] = []
  for (const g of groups) {
    const items = g.items.filter((it) => it.toolId === toolId)
    if (!items.length) continue
    out.push(regroup(g, items))
  }
  return out
}

/** 换掉一组的成员时,计数只有这一种重算方式(筛选与裁剪两条路共用,防止两处数字各自漂移) */
function regroup(g: AggGroup, items: AggFinding[]): AggGroup {
  return { ...g, items, counts: countsOf(items) }
}

export interface PaneEmptyCtx {
  /** 右栏在看单个工具(而非聚合流) */
  isTool: boolean
  /**
   * 那个工具本轮的状态。三态而不是一个布尔:失败的工具在 results 里**有**记录却没有结论,
   * 按「跑过且干净」说它就是第二句假话 —— 与左栏那枚「失败」徽标对不上。
   */
  toolState: 'idle' | 'clean' | 'fail'
  running: boolean
  /** 有组但被当前筛选条件筛空了 */
  filtered: boolean
  /** 本轮已出结论的工具数(聚合模式用它区分「什么都没跑」与「跑完且干净」) */
  ranCount: number
}

/**
 * 右栏空态该说哪句话。判据住纯函数层而不是模板里的三元套娃 —— 先例见 outcome.ts:1-4,
 * 那里的判据曾写在视图 computed 里,于是「扫描失败 + 陈旧全绿」并排显示只能靠肉眼发现。
 * 这里防的是同一类话:aggregate 只对**有结论的**工具建组,groups 为空既可能是「没跑」
 * 也可能是「跑过且没问题」,不分开说就会与左栏那一枚 ✓ 当街打脸。
 */
export function emptyPaneText(c: PaneEmptyCtx): string {
  if (c.running) return '正在检查…'
  // filtered 必须排在 isTool 之前:单工具模式下把「有结论的工具」筛到一条不剩时,
  // 先走 isTool 会说出「这一项跑过了,没有发现问题」—— 它有问题,只是被筛掉了。
  if (c.filtered) return '没有符合当前筛选条件的结论。'
  if (c.isTool) {
    if (c.toolState === 'fail') return '这一项没跑成。失败原因在左栏那一行上悬停可见,修好宿主能力后点「重跑本项」。'
    if (c.toolState === 'clean') return '这一项跑过了，没有发现问题。'
    return '这一项还没跑过，点上面的「重跑本项」开始。'
  }
  return c.ranCount > 0
    ? `本轮 ${c.ranCount} 项都跑过了，未发现问题。`
    : '还没有任何结论 —— 跑一次全量体检看看。'
}

/** 分档计数只有一个算法:聚合、筛选、裁剪三条路都走它,否则三处数字会各自漂移 */
function countsOf(items: AggFinding[]): { error: number; warn: number; info: number } {
  const c = { error: 0, warn: 0, info: 0 }
  for (const it of items) c[it.finding.severity] += 1
  return c
}
