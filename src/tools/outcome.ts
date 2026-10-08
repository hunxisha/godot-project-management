// 体检结论判定(review F-1):「页面此刻该说哪句话」的全部判据都收在这个纯函数里。
// 视图只渲染它的返回值,不再自己算 —— 旧版判据写在 ToolsView.vue 的 computed 里,
// Node harness 跑不到 .vue,于是「扫描失败 + 陈旧全绿结论」这种自相矛盾的横幅
// 只能靠肉眼发现(见本文件底部 outcomeOf 的 F-1 注释与 tools.test.mjs 第 6 节)。
import type { ToolResult } from './types'

/**
 * - idle      一份结论都还没有(没选项目 / 刚切项目)
 * - running   有扫描或检查在途(此刻说什么都算抢答)
 * - failed    扫描层失败,error 非空(唯一的失败出口,横幅必须只有这一条口径)
 * - allClean  跑完且每个工具都 ok、零结论 ——「体检完成 · 未发现问题」
 * - partial   其余情形(跑过一部分 / 有结论 / 有 ok:false 卡片)
 */
export type ToolsOutcomeKind = 'idle' | 'running' | 'failed' | 'allClean' | 'partial'

export interface ToolsOutcome {
  kind: ToolsOutcomeKind
  /** 摘要带的「体检完成 · 未发现问题」显隐 —— 这条线唯一的生产判据 */
  showAllClean: boolean
  /** 扫描失败横幅文案(R-C 归一口径,由 useTools 产出;空串 = 无扫描层失败) */
  error: string
  /** ok:false 的工具 id:失败要在结论里点名,「有红卡片」正是 allClean 的反证之一 */
  failedToolIds: string[]
}

/**
 * @param results   useTools 的 results(按 toolId 存的本轮结论)
 * @param toolCount 注册表里的工具总数(不是已跑数:少跑一个就不算「体检完成」)
 * @param counts    useTools 的 counts(跨所有已跑工具的结论计数;fixable 不参与判定)
 * @param error     useTools 的 error(R-C 归一后的扫描失败文案)
 * @param running   有扫描/检查在途(视图里的 busy:单工具或全量任一路)
 */
export function outcomeOf(
  results: Record<string, ToolResult>,
  toolCount: number,
  counts: { error: number; warn: number; info: number },
  error = '',
  running = false
): ToolsOutcome {
  const rs = Object.values(results || {})
  const failedToolIds = rs.filter((r) => !r || !r.ok).map((r) => r.toolId)
  // 审查 F-1(修复):error 必须**最先**判 —— 扫描失败不会清空 results(useTools.ts:146-153
  // 置 error、清 tree、复位 truncated 后返回,runAll 随即早退),results 里躺着的是**上一轮**
  // 的全绿陈迹。不看 error 的判据(抽取前视图 computed 的原样)会在这种时刻宣布「体检完成 ·
  // 未发现问题」,和红色「项目目录无法读取」并排显示 —— 恰好反转了这一行要消除的歧义。
  if (error) return { kind: 'failed', showAllClean: false, error, failedToolIds }
  if (running) return { kind: 'running', showAllClean: false, error: '', failedToolIds }
  if (!rs.length) return { kind: 'idle', showAllClean: false, error: '', failedToolIds }
  const clean =
    rs.length === toolCount && rs.every((r) => r.ok) && counts.error + counts.warn + counts.info === 0
  return clean
    ? { kind: 'allClean', showAllClean: true, error: '', failedToolIds }
    : { kind: 'partial', showAllClean: false, error: '', failedToolIds }
}
