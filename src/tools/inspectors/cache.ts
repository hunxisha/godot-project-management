// P0 工具 #2:.godot 缓存体检(spec §3.1)。只读 —— 清理入口留在「项目」页,
// 不在这里复制一个操作入口(spec §6「与既有功能重叠」)。
//
// 红线:纯函数,只吃 ToolContext —— 不碰 window / services / vue / DOM。
import type { Finding, ToolContext } from '../types'
import { truncatedFinding } from '../finding'
import { fmtBytes, isCache, noCache, sumBytes } from '../treeUtils'

/** 缓存体积超过源文件这个倍数才算异常膨胀 */
const CACHE_OVER_SRC = 10

export async function run(ctx: ToolContext): Promise<Finding[]> {
  const out: Finding[] = []
  if (ctx.truncated) {
    out.push(truncatedFinding('cache', '缓存是否过期依赖完整清单。'))
  }
  const cache = ctx.tree.filter((f) => isCache(f.rel))
  const src = noCache(ctx.tree)

  // 没有缓存 = 新克隆 / 还没用编辑器打开过,是事实陈述不是问题:一条 info 收口,
  // 不再叠加体积与陈旧判定(没东西可判),界面上也不会三条同义反复。
  if (!cache.length) {
    out.push({
      id: 'cache:none',
      severity: 'info',
      title: '这个项目还没有 .godot 缓存',
      detail: '用编辑器打开过一次就会生成,当前无需清理。',
      rel: '.godot'
    })
    return out
  }

  const cacheBytes = sumBytes(cache)
  const srcBytes = sumBytes(src)
  out.push({
    id: 'cache:size',
    severity: 'info',
    title: `.godot 缓存 ${fmtBytes(cacheBytes)} · ${cache.length} 个文件`,
    detail: `源文件共 ${fmtBytes(srcBytes)}。缓存可由引擎重建,清理入口在「项目」页。`,
    rel: '.godot'
  })

  const cacheMax = cache.reduce((a, f) => Math.max(a, f.mtimeMs), 0)
  const newer = src.filter((f) => f.mtimeMs > cacheMax)
  if (newer.length) {
    out.push({
      id: `cache:stale:${newer[0].rel}`,
      severity: 'warn',
      title: '缓存可能已过期:有源文件比缓存更新',
      detail: `例如 ${newer.slice(0, 3).map((f) => f.rel).join('、')}` +
        `${newer.length > 3 ? ` 等 ${newer.length} 个` : ''}。打开编辑器会自动重建;` +
        '若刚遇到过 import 报错,清一次缓存再试。',
      rel: newer[0].rel,
      related: newer.slice(0, 10).map((f) => f.rel)
    })
  }

  if (srcBytes > 0 && cacheBytes > srcBytes * CACHE_OVER_SRC) {
    out.push({
      id: 'cache:bloat',
      severity: 'warn',
      title: `缓存体积(${fmtBytes(cacheBytes)}) 大于源文件的 ${CACHE_OVER_SRC} 倍`,
      detail: '常见于反复导入大纹理或切过多个引擎版本。清理前确认编辑器没在跑。',
      rel: '.godot'
    })
  }
  return out
}
