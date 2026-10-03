// 检查器共用的「文件清单被截断」结论(spec §5.1 的 ctx.truncated)。
//
// 为什么抽成一份:size / cache / brokenRefs 都要在 ctx.truncated 时先出一条
// 「文件清单被截断」的 warn 条目。三处各写一遍同形六行,措辞一定会各漂各的
// (改一句漏两句);标题与理由各自可覆盖(见下面 TRUNCATED_TITLE 的注释)。
// 但 **id 必须按检查器分开** —— 渲染层的折叠状态和将来
// 「忽略这条结论」的记忆都按 id 记账,`size:truncated` 与 `cache:truncated`
// 是两条互不相干的结论,合并成一个 id 就会互相顶掉。
//
// 红线同 treeUtils:纯函数,不碰 window / services / vue / DOM。
import type { Finding } from './types'

/**
 * 默认截断标题。测试按「部分」这个关键词判 —— 但**只有 size 用得到它**(审查 F-2 之后):
 * size 截断时照常出结论,标题讲的是「以下结论只基于部分文件」;而 cache 与 brokenRefs
 * 截断时一个结论都不下,各自把 title 覆盖成「本次不做缓存体检 / 本次不做断链判定」。
 */
const TRUNCATED_TITLE = '文件清单被截断,以下结论只基于部分文件'

/**
 * 没给检查器专属理由时的兜底文案(讲清「为什么会被截断」+「只能怎么安全地重跑」)。
 *
 * ⚠ 审查 F-4:这里**不许**建议「用 skipDirs / 扩展名过滤缩小范围后重跑」(旧文案就是这么写的)。
 * 那条建议对「依赖清单完整性」的检查器是有害的:过滤出来的清单同样不完整,而原语只在
 * maxEntries 上限处才打 truncated 标记 —— 用户照做,下一轮就得到一份**自称完整**的部分清单,
 * brokenRefs 会把其实存在的文件报成丢失(error 级假阳性)。安全动作只有两个:提高 maxEntries、
 * 完整重扫。文案里也别说出这两个开关的名字,免得又被当成建议。
 */
const TRUNCATED_WHY = '宿主在 maxEntries 处停了,清单不完整。请把 maxEntries 调高或做一次完整重扫后再看' +
  ' —— 别用排除目录、按扩展名筛选这类过滤来「缩小范围」:过滤后的清单同样不完整,却不会再带截断标记,结论只会更假。'

/**
 * @param toolId 检查器 id(`size` / `cache` / `brokenRefs`),决定 `id` 前缀
 * @param why    该检查器特有的原因;省略则用兜底文案
 * @param title  只在一个检查器根本不做某类判定时才覆盖(cache 与 brokenRefs 都用它)
 */
export function truncatedFinding(toolId: string, why?: string, title: string = TRUNCATED_TITLE): Finding {
  return {
    id: `${toolId}:truncated`,
    severity: 'warn',
    title,
    detail: why || TRUNCATED_WHY
  }
}
