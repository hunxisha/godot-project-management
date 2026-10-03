// P0 工具 #1:项目体积与大文件(spec §3.1)。只读,不产生任何修复。
//
// 红线:纯函数,只吃 ToolContext —— 不碰 window / services / vue / DOM,
// 这样 src/tools/__tests__/tools.test.mjs 才能在 Node 里直接跑。
import type { Finding, ToolContext } from '../types'
import { truncatedFinding } from '../finding'
import { fmtBytes, groupByExt, groupByTopDir, isCache, noCache, sumBytes, topFiles } from '../treeUtils'

/** 单文件超过它才单独成条 —— 20MB 是「值得看一眼」的经验线 */
const BIG_FILE = 20 * 1024 * 1024

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

  // topFiles(src, 20) 先取前 20 再筛:清单再大也只可能报出 20 条中的大文件,
  // 界面上不会刷屏。id 用 rel(证据本身),不含时间戳 —— 折叠/忽略记忆靠它。
  for (const f of topFiles(src, 20).filter((f) => f.size >= BIG_FILE)) {
    out.push({
      id: `size:big:${f.rel}`,
      severity: 'info',
      title: `大文件 ${fmtBytes(f.size)} · ${f.rel}`,
      detail: '如果它其实没被引用,等「未引用资源」检查上线可批量回收;要进 Git 建议改用 Git LFS。',
      rel: f.rel
    })
  }
  return out
}
