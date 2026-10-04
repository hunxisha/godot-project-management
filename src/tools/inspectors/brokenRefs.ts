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
// 存在性一律用 lowerRelSet(ctx.tree) + hasRelCI 查表比对(任意大小写写法命中都算),不做字符串包含判断:Tasks 9/10 审查后
// resToRel 会归一化('./' 吃掉、重复斜杠折叠、.. 与盘符判 null),归一后的 rel
// 与树里的 rel 同形,只有「是不是树里的某个 key」这种判据才站得住。
//
// 第四条(B10b 债 6 收口):resToRel **之前**先过共享形状闸 `sceneRefs.resPathShapeOk`。
// `path="res://a.gd "` 那枚空格在引号**内**,`attr()` 原样交出;`path="res://a.gd,"` 的逗号同理
// (两份孪生解析器都会剥尾逗号,见 godotIni.ts:15-16,所以「值尾巴上有标点」是真实写盘/手写形态)。
// 两条归一出来的是 `a.gd ` / `a.gd,` 那种「路径 + 尾巴」,拿去比清单**永远查不到**,
// 于是本工具唯一的 error 档会落在一个其实存在的文件上(§6 头号失败模式:虚假的「你的配置坏了」)。
// 方向被钉死成**只撤主张不新增**:过闸的值走的还是原来那三行,不过闸的一条 error 都不发、
// 只并进下面的排除计数(与 addons/imports/ini 同一口径:藏起来的要看得见)。
// 残余(台账记着,不偷偷扩):一条结论都没有时这份计数没有落点 —— 本工具没有聚合卡,
// 凭空造一张 info 就是「超出撤主张」的语义变更,不在本轮授权范围内。
//
// 红线:纯函数,只吃 ToolContext —— 不碰 window / services / vue / DOM。
import type { Finding, ToolContext } from '../types'
import { truncatedFinding } from '../finding'
import { SCENE_EXT, parseExtResources, resPathShapeOk, resToRel } from '../parsers/sceneRefs'
import { hasRelCI, lowerRelSet } from '../treeUtils'

/**
 * 「不判的条数」上卡面的那句话(B5 立下的口径,写法与 addons.ts 的 `exclNote`、ini.ts 的同名函数同一读法)。
 * 只数**形状闸**挡下来的那些:空串 / `user://` / 越界写法本来就被 `resToRel` 判 null 挡在外面,
 * 套到这句上就是说假话(那句讲的是首尾空白与尾巴标点)。
 */
function shapeNote(n: number): string {
  return ` 本次未判定:${n} 条 [ext_resource] 的 path 值首尾带空白或以标点收尾(, ; ) ]),` +
    '归一出来的串不是那条路径本身,没拿它去比文件清单(这类值既不能说「文件在」、也不能说「文件丢了」)。'
}

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
  // 存在性一律走大小写不敏感查表(B6 修复轮裁定 2 的同一口径):Windows/macOS 的文件系统不区分大小写,
  // 引擎自己也是这么解析 res:// 的。按精确大小写比对会把 `res://Assets/Icon.PNG`(树里实为
  // assets/icon.png)报成「文件不存在」—— 而这是本工具唯一的 error 级结论,假 error 比漏报更伤信任。
  const have = lowerRelSet(ctx.tree)
  const scenes = ctx.tree.filter((f) => SCENE_EXT.has(f.ext))
  const out: Finding[] = []
  /** 形状闸挡下来的条数(见文件头第四条与 `shapeNote`) */
  let shape = 0
  for (const f of scenes) {
    const { text } = await ctx.readText(f.rel)
    if (typeof text !== 'string') continue
    for (const ref of parseExtResources(text)) {
      // ★ 形状闸:空串不从这里过(它本来就归不出 rel,计数也不套那句假话),其余首尾脏 / 尾巴带标点的
      //   一律不判存在性 —— 撤掉的是「文件不存在」这条 error,不新增任何东西。
      if (ref.path && !resPathShapeOk(ref.path)) { shape++; continue }
      const rel = resToRel(ref.path)
      if (rel === null || hasRelCI(have, rel)) continue
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
  // 排除计数并进**每一条**结论的 detail(addons.ts 的 exclNote 同一落点:整趟扫完才知道总数,
  // 而这里每条结论都是同一个判据的产物,少说一次就是让读另一条卡的人看不见)。
  if (shape > 0) {
    const note = shapeNote(shape)
    for (const f of out) f.detail += note
  }
  return out
}
