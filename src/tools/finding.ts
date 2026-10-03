// 检查器共用的「文件清单被截断」结论(spec §5.1 的 ctx.truncated)。
//
// 为什么抽成一份:size / cache / brokenRefs 都要在 ctx.truncated 时先说明
// 「下面的结论只基于部分文件」。三处各写一遍同形六行,措辞一定会各漂各的
// (改一句漏两句)。但 **id 必须按检查器分开** —— 渲染层的折叠状态和将来
// 「忽略这条结论」的记忆都按 id 记账,`size:truncated` 与 `cache:truncated`
// 是两条互不相干的结论,合并成一个 id 就会互相顶掉。
//
// 红线同 treeUtils:纯函数,不碰 window / services / vue / DOM。
import type { Finding } from './types'

/** 三个检查器共用的截断标题;测试按「部分」这个关键词判 */
const TRUNCATED_TITLE = '文件清单被截断,以下结论只基于部分文件'

/** 没给检查器专属理由时的兜底文案(讲清「为什么会被截断」+「怎么重跑」) */
const TRUNCATED_WHY = '宿主在 maxEntries 处停了。重跑时用 skipDirs 排除 build/导出产物目录。'

/**
 * @param toolId 检查器 id(`size` / `cache` / `brokenRefs`),决定 `id` 前缀
 * @param why    该检查器特有的原因;省略则用兜底文案
 * @param title  只在一个检查器根本不做某类判定时才覆盖(brokenRefs 用)
 */
export function truncatedFinding(toolId: string, why?: string, title: string = TRUNCATED_TITLE): Finding {
  return {
    id: `${toolId}:truncated`,
    severity: 'warn',
    title,
    detail: why || TRUNCATED_WHY
  }
}
