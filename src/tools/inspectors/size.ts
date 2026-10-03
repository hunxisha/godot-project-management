// P0 工具 #1:项目体积与大文件(spec §3.1)。只读,不产生任何修复。
//
// 红线:纯函数,只吃 ToolContext —— 不碰 window / services / vue / DOM,
// 这样 src/tools/__tests__/tools.test.mjs 才能在 Node 里直接跑。
import type { Finding, ToolContext } from '../types'
import { truncatedFinding } from '../finding'
import { fmtBytes, groupByExt, groupByTopDir, isCache, noCache, sumBytes, topFiles } from '../treeUtils'

/** 单文件超过它才单独成条 —— 20MB 是「值得看一眼」的经验线 */
const BIG_FILE = 20 * 1024 * 1024
/** 阈值常量(钉死,别顺手改成 10 × 1000 × 1000):20 MiB,`BIG_FILE_MB` 只是文案里复用它的值 */
const BIG_FILE_MB = BIG_FILE / (1024 * 1024)
/** 大文件最多单列几行 —— 刷屏上限,不是阈值;超出部分由 `size:bigTail` 报差额 */
const BIG_LIST = 20

export async function run(ctx: ToolContext): Promise<Finding[]> {
  const out: Finding[] = []
  if (ctx.truncated) {
    out.push(truncatedFinding('size'))
  }
  // 源文件口径 = 去掉 .godot:这条文案会写「源文件共 X」,把缓存算进去等于每次导入大纹理
  // 都告诉用户「你的项目变大了」。(缓存体积另立一条,见下。)
  const src = noCache(ctx.tree)
  const cache = ctx.tree.filter((f) => isCache(f.rel))
  const cacheBytes = sumBytes(cache)

  out.push({
    id: 'size:total',
    severity: 'info',
    title: `源文件共 ${fmtBytes(sumBytes(src))} · ${src.length} 个`,
    detail: `按类型:${groupByExt(src, 3).map((g) => `${g.ext} ${fmtBytes(g.bytes)}`).join('、') || '（无）'}。` +
      ` 按顶层目录:${groupByTopDir(src, 3).map((d) => `${d.dir} ${fmtBytes(d.bytes)}`).join('、') || '（无）'}。`
  })

  if (cacheBytes > 0) {
    out.push({
      id: 'size:cache',
      severity: 'info',
      title: `.godot 缓存 ${fmtBytes(cacheBytes)} · ${cache.length} 个文件`,
      detail: '缓存是引擎生成的可再生内容,不计入源文件体积。清理入口在「项目」页。',
      rel: '.godot'
    })
  }

  // 大文件单列上限 BIG_LIST=20 行(刷屏控制),id 用 rel(证据本身)、不含时间戳 —— 折叠/忽略记忆靠它。
  // ⚠ 但写法不能是「先 topFiles(src, 20) 砍到前 20 名、再从这 20 条里筛 ≥20MB」:那样第 21 个之后
  // 的超标文件会被**静默丢掉** —— 21 个超标文件只列得出 20 个,而 size:total 说的却是「21 个」,
  // 界面上完全看不出少了一条(审查 F-5)。上限保留,差额改成从**未过滤**的 src 算出来、单独成条。
  // 因为 src 按体积降序,只要有超标文件被截断,列出的那 20 行必然全部超标(bigRows.length = BIG_LIST)。
  const oversizeTotal = src.filter((f) => f.size >= BIG_FILE).length
  const bigRows = topFiles(src, BIG_LIST).filter((f) => f.size >= BIG_FILE)
  for (const f of bigRows) {
    out.push({
      id: `size:big:${f.rel}`,
      severity: 'info',
      title: `大文件 ${fmtBytes(f.size)} · ${f.rel}`,
      detail: '如果它其实没被引用,等「未引用资源」检查上线可批量回收;要进 Git 建议改用 Git LFS。',
      rel: f.rel
    })
  }
  const hiddenBig = oversizeTotal - bigRows.length
  if (hiddenBig > 0) {
    // 这条只报「还有多少没列」,id 不带数量(数量每次扫描都会变,带进 key 会让折叠/忽略
    // 记忆每次漂移),也不带时间戳。
    out.push({
      id: 'size:bigTail',
      severity: 'info',
      title: `另有 ${hiddenBig} 个 ≥${BIG_FILE_MB}MB 文件未列出`,
      detail: `≥${BIG_FILE_MB}MB 的单文件共 ${oversizeTotal} 个,这里按体积只列前 ${bigRows.length} 个(刷屏控制)。` +
        '想看全量请把 maxEntries 调高后完整重扫。'
    })
  }
  return out
}
