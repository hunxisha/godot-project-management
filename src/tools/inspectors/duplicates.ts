// P2 工具 #17:重复文件检测(spec §3.3 #17;「建议缓做」的原语成本已由本轮 hashPaths 摊薄)。
//
// 判定链只有三步,每步都把量往下压:**同体积分组**(O(n) 纯内存,不同体积不可能同内容)
// → 组内 >1 才进哈希 → 同 SHA-256 才成组。哈希是这页最重的一次 IO,两层闸控制它:
// ① 只哈希「体积相同的组」;② 单次体检有总字节预算(HASH_BUDGET),超出预算的组不哈希、
// 如实报「还有多少组没检测」—— 不设闸的话,一个「一万个同体积小文件」的项目会把这张卡跑成分钟级。
//
// 结论全部 info 级、**没有修复动作**:内容相同只是「可以合并」,留哪一份、改哪几处引用
// 是用户的决定(改 .tscn/.gd 里的引用超出工具页低风险修复边界,计划书原文);
// 给一个「删掉其余」的一键按钮就是在没有引用图的情况下劝人动盘。
//
// 口径三条(都朝「少报」的方向偏,方向安全):
//   · addons/ 整体跳过 —— 第三方插件自带的重复(两个插件各带一份同名库)要由插件作者解决;
//   · `.gdignore` 屏蔽目录跳过 —— 引擎看不见那些文件,「重复」无从谈起;
//   · 大小写异体(`a.png` 与 `A.png`)只留一个代表 —— Windows 盘上它们就是同一个文件,
//     哈希必然相同,报「2 处相同」是把一个文件说成两个。(Linux 上真共存的异体被漏报一组。)
//
// 截断时**照常判**另出覆盖面警示(secrets/textures 同款):清单截断只会让重复的另一份
// 落在没扫到的部分(少报),不会把不同文件误判成相同;静默漏报会被读成「没有重复」。
//
// 红线:纯函数,只吃 ToolContext —— 不碰 window / services / vue / DOM;哈希走 ctx.hash 通道。
import type { Finding, ToolContext } from '../types'
import { LIST_CAP, truncatedFinding } from '../finding'
import { byText, fmtBytes, gdignoredDirs, hasAddonSeg, isGdignored, sourceFiles } from '../treeUtils'

/** 小于它的文件不进候选(1 KiB):空壳 / .gdignore 标记 / 许可证头,报出来全是噪声 */
export const MIN_DUP_BYTES = 1024
/** 单次体检的哈希总字节预算(256 MiB);超出预算的同体积组不哈希、如实报差额 */
export const HASH_BUDGET = 256 * 1024 * 1024

export async function run(ctx: ToolContext): Promise<Finding[]> {
  const out: Finding[] = []
  if (ctx.truncated) {
    out.push(truncatedFinding(
      'duplicates',
      '清单被截断时本卡照常报已发现的,但另一份重复可能落在没列出的部分 —— ' +
        '「没有报出重复」不等于「没有重复」,请完整重扫后再当结论用。'
    ))
  }

  const dirs = gdignoredDirs(ctx.tree)
  // 候选与大小写去重(小写 rel 只留第一个;Windows 上同一文件不重复进组)
  const seenLower = new Set<string>()
  const bySize = new Map<number, string[]>()
  for (const f of sourceFiles(ctx.tree)) {
    if (!f || typeof f.rel !== 'string' || f.size < MIN_DUP_BYTES) continue
    if (hasAddonSeg(f.rel) || isGdignored(dirs, f.rel)) continue
    const lower = f.rel.toLowerCase()
    if (seenLower.has(lower)) continue
    seenLower.add(lower)
    const g = bySize.get(f.size)
    if (g) g.push(f.rel)
    else bySize.set(f.size, [f.rel])
  }

  // 组内 >1 才可能重复;按「可省体积」降序,预算闸从最值得报的那头开始吃
  const groups = [...bySize.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([size, files]) => ({ size, files: [...files].sort(byText) }))
    .sort((a, b) => (b.files.length - 1) * b.size - (a.files.length - 1) * a.size || byText(a.files[0], b.files[0]))

  let budget = 0
  const within: typeof groups = []
  let skippedGroups = 0
  let skippedFiles = 0
  for (const g of groups) {
    const cost = g.size * g.files.length
    if (budget + cost > HASH_BUDGET) { skippedGroups++; skippedFiles += g.files.length; continue }
    budget += cost
    within.push(g)
  }

  const shaByRel = new Map<string, string>()
  let hashFailed = 0
  if (within.length) {
    const rels = within.flatMap((g) => g.files)
    // ctx.hash 的契约就是「失败不抛,统一收进 failed」(useTools 侧已这么实现);这里再兜一层
    // 是同一个形状的收口:检查器自身对通道违约也保持「报出来而不是炸掉」(Node 直调时没有 useTools 那层)。
    let r: { hashes: { rel: string; sha256: string }[]; failed: { rel: string; error: string }[] }
    try {
      r = await ctx.hash(rels)
    } catch (e) {
      r = { hashes: [], failed: [{ rel: '', error: (e as Error)?.message || '哈希失败' }] }
    }
    for (const h of r.hashes) if (h && typeof h.rel === 'string') shaByRel.set(h.rel, h.sha256)
    hashFailed = r.failed.length
  }

  // 同体积只是哈希的**前置闸**,不是「同体积 = 同内容」:一组 5 个同体积文件里
  // 完全可能只有 2 个相同。所以哈希回来后还要**按摘要再分子组**,每个 ≥2 的子组才是一条结论;
  // 整组要求全同会把这类最常见的形态整组漏掉。
  const dups: typeof groups = []
  for (const g of within) {
    const buckets = new Map<string, string[]>()
    let missing = false
    for (const rel of g.files) {
      const sha = shaByRel.get(rel)
      if (sha === undefined) { missing = true; break } // 组内有读不到的 → 整组不判(少报)
      const b = buckets.get(sha)
      if (b) b.push(rel)
      else buckets.set(sha, [rel])
    }
    if (missing) { hashFailed++; continue }
    for (const files of buckets.values()) if (files.length > 1) dups.push({ size: g.size, files })
  }

  for (let i = 0; i < Math.min(dups.length, LIST_CAP); i++) {
    const g = dups[i]
    out.push({
      id: `duplicates:group:${g.files[0]}:${i}`,
      severity: 'info',
      title: `${g.files.length} 处相同的 ${fmtBytes(g.size)} 文件,占 ${fmtBytes(g.size * g.files.length)},可省 ${fmtBytes((g.files.length - 1) * g.size)}`,
      detail: '这些文件内容逐字节相同。合并或删除前先确认场景/代码引用的是哪一份' +
        '(改引用在编辑器里做,本工具不代劳);只想省空间时,保留被引用的那一份、把其余的清掉即可。' +
        ' 清单里所有路径见「相关」一栏。',
      rel: g.files[0],
      related: [...g.files]
    })
  }

  const hidden = dups.length - Math.min(dups.length, LIST_CAP)
  if (hidden > 0) {
    out.push({
      id: 'duplicates:tail',
      severity: 'info',
      title: `另有 ${hidden} 组重复未列出`,
      detail: `本次共命中 ${dups.length} 组,按可省体积降序只列前 ${LIST_CAP} 组(刷屏控制)。`
    })
  }
  if (skippedGroups > 0) {
    out.push({
      id: 'duplicates:budget',
      severity: 'info',
      title: `哈希预算外还有 ${skippedGroups} 组同体积候选未检测`,
      detail: `单次体检最多哈希 ${fmtBytes(HASH_BUDGET)},这次已经用满 —— 还有 ${skippedFiles} 个同体积文件` +
        '没参与比对。分组本身可信(体积不同不可能同内容),没检测的那部分不算干净也不算重复;想查它们请缩小项目范围后单独跑。'
    })
  }
  if (hashFailed > 0) {
    out.push({
      id: 'duplicates:skip-count',
      severity: 'info',
      title: `${hashFailed} 项读不到,未参与比对`,
      detail: '读不到的文件,与「组里有成员读不到」的那些组,都没有参与本次判定 —— 没报出 ≠ 不存在。' +
        '失败原因(缺失 / 越界 / 读不到)以原语回报为准。'
    })
  }

  return out
}
