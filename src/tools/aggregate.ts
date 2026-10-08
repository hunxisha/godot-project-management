// 聚合问题流的判据:把 18 项工具的结论跨工具分组、排序、筛选。
// 住在纯函数层而不是 .vue 的先例见 src/tools/outcome.ts:1-4 —— 判据写进组件就跑不进 Node harness,
// 而「哪条排最上面」正是这一页的产品主张:说错话的代价是用户看不见要紧的那几条。
import { CATEGORIES } from './registry'
import { planFix } from './fixPlan'
import type { AggFinding, AggGroup, Severity, Tool, ToolResult } from './types'

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
      g.counts[finding.severity] += 1
      g.items.push(item)
    }
  }
  for (const g of out) g.items.sort((a, b) => SEV_RANK[a.finding.severity] - SEV_RANK[b.finding.severity])
  const catOrder = CATEGORIES.map((c) => c.id)
  const rank = (g: AggGroup) => (g.items.length ? SEV_RANK[g.items[0].finding.severity] : 9)
  out.sort((a, b) => rank(a) - rank(b)
    || b.counts.error - a.counts.error
    || catOrder.indexOf(a.category) - catOrder.indexOf(b.category))
  return out
}
