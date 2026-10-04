// P0 工具 #4:资源引用完整性(spec §3.1)。断链 = 编辑器会直接报错,所以是 error。
//
// 两条保守规则,避免误导:
//   · 只在 tree 未被截断时判定 —— 否则「不在清单里」会被当成「文件不存在」。
//   · 只判 res://;user:// 与绝对路径不是项目内引用,不参与。
//
// 第三条(同形于读文本原语的三态):ctx.readText 给不出字符串 text 就是「读不到」
// (缺文件 / 超 maxBytes / 二进制 / 非法路径),一律静默跳过 —— 把它当成断链
// 就会对每一个 .png/.ttf 之外的正常场景报出假 error。
//
// 存在性一律用 relSet(ctx.tree) 查表比对,不做字符串包含判断:Tasks 9/10 审查后
// resToRel 会归一化('./' 吃掉、重复斜杠折叠、.. 与盘符判 null),归一后的 rel
// 与树里的 rel 同形,只有「是不是树里的某个 key」这种判据才站得住。
//
// 红线:纯函数,只吃 ToolContext —— 不碰 window / services / vue / DOM。
import type { Finding, ToolContext } from '../types'
import { truncatedFinding } from '../finding'
import { SCENE_EXT, parseExtResources, resToRel } from '../parsers/sceneRefs'
import { relSet } from '../treeUtils'

export async function run(ctx: ToolContext): Promise<Finding[]> {
  if (ctx.truncated) {
    // 不判、也不留「以下结论只基于部分文件」这种仍有结论的标题:这条用例唯一的输出
    // 就是「这次没做判定」,标题要说清做了什么没做什么。
    return [truncatedFinding(
      'brokenRefs',
      '断链判定需要完整清单,否则会把你其实有的文件报成丢失(而且是 error 级)。' +
        '请把 maxEntries 调高或做一次完整重扫 —— 别用排除目录、按扩展名筛选来「缩小范围」,' +
        '那样得到的清单同样不完整,却不会再带截断标记。',
      '文件清单被截断,本次不做断链判定'
    )]
  }
  const have = relSet(ctx.tree)
  const scenes = ctx.tree.filter((f) => SCENE_EXT.has(f.ext))
  const out: Finding[] = []
  for (const f of scenes) {
    const { text } = await ctx.readText(f.rel)
    if (typeof text !== 'string') continue
    for (const ref of parseExtResources(text)) {
      const rel = resToRel(ref.path)
      if (rel === null || have.has(rel)) continue
      out.push({
        // id = 场景 rel + 该条 ext_resource 的 id + 该条的引用 path(全是证据,不含时间戳)。
        // ⚠ 光靠 id 不够:同一个场景里两条 [ext_resource] 可以复用同一个 id 却指向两个
        // 不同的丢失文件(编辑器改引用时就会长这样),旧写法 `${f.rel}:${ref.id}` 会让两条
        // 撞出同一个 key —— 而 id 是渲染层折叠状态与将来「忽略这条」记忆的记账键,撞了
        // 就等于「忽略一条、静默吞掉另一条」(审查 F-1 实测复现)。缺 id 时补 'noid'
        // 占位(手写/半截文件),区分工作交给 path。
        id: `brokenRefs:${f.rel}:${ref.id || 'noid'}:${ref.path}`,
        severity: 'error',
        title: `引用了不存在的文件:${ref.path}`,
        detail: `${f.rel} 的 [ext_resource] 声明类型为 ${ref.type || '未标注'}、id=${ref.id || '未标注'}。` +
          ' 打开该场景时编辑器会报加载失败;要么补回文件,要么在编辑器里删除这个引用。',
        rel: f.rel,
        related: [ref.path]
      })
    }
  }
  return out
}
