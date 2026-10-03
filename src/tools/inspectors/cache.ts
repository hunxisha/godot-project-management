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
  // 审查 F-2:截断时**只出这一条,然后返回**(与 brokenRefs 同形)。
  // 旧写法把警示 push 进 out 再继续算,于是同一次体检既说「以下结论只基于部分文件」
  // 又说「这个项目还没有 .godot 缓存」(清单本来就可能没带 .godot)、
  // 「缓存体积大于源文件 10 倍」(实测 3 KB 缓存 ÷ 100 B 可见源 = 30 倍 → warn,
  // 分母只是被截断后剩下的一小块源),cacheMax 也只是子集最大值 —— 这些都是
  // 自己的警示已声明为不可知的结论。
  if (ctx.truncated) {
    return [truncatedFinding(
      'cache',
      '缓存体检的三个结论都吃完整清单:体积倍数要拿全部源文件当分母、' +
        '「缓存是否最新」要比全部缓存条目的最后修改时间、有没有缓存更是只能看全量。' +
        '提高 maxEntries 或做一次完整重扫后再看。',
      '文件清单被截断,本次不做缓存体检'
    )]
  }
  const out: Finding[] = []
  const cache = ctx.tree.filter((f) => isCache(f.rel))
  const src = noCache(ctx.tree)

  // 清单里没有缓存条目 = 只能陈述「这份清单里没有」,不能断言磁盘上真没有(宿主可能没带
  // .godot、或清单被 exts/skipDirs 过滤过 —— 审查 F-2)。新克隆项目确实也没有,所以是
  // info 不是问题:一条收口,不再叠加体积与陈旧判定(没东西可判)。
  if (!cache.length) {
    out.push({
      id: 'cache:none',
      severity: 'info',
      title: '文件清单里没有 .godot 缓存条目',
      detail: '清单里没有不等于磁盘上没有:本次扫描可能没包含 .godot。' +
        '项目用编辑器打开过一次就会生成缓存,真要清理请在「项目」页确认。',
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

  // 审查 F-3:mtimeMs <= 0 一律当「未知」,不是 1970-01-01。这是宿主两端的共同约定 ——
  // Rust 侧 src-tauri/src/inspectfs.rs:90-95 `md.modified().ok()… .unwrap_or(0)`
  // (取不到 metadata 就给 0),JS 侧 pre-1970 的时间戳也折成 0/负数。
  // 旧写法 `cache.reduce((a,f) => Math.max(a, f.mtimeMs), 0)` 会把 0 当真实时间:
  // 缓存条目一个 mtime 都读不到 → cacheMax=0 → 每个源文件都「比缓存新」→
  // 一个完全新鲜的缓存被永久报成「可能已过期」。
  // 所以:cacheMax 只在 > 0 的缓存条目里取;一个都没有就整条陈旧判定跳过(未知 ≠ 过期);
  // 比较时源文件也先剔掉 mtime<=0 的未知项(这一条在 cacheMax>0 时是冗余保险:
  // 0 本来就不会 > 正数,写出来是把「0 不参与时间比较」这个约定摆在明面上)。
  const cacheMax = cache.reduce((a, f) => (f.mtimeMs > 0 ? Math.max(a, f.mtimeMs) : a), 0)
  const newer = cacheMax > 0 ? src.filter((f) => f.mtimeMs > 0 && f.mtimeMs > cacheMax) : []
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
