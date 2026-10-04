// P0 工具 #6：未引用资源（孤儿资产）（spec §3.1 #6、§5.2 ctx 共享、§5.3 四条硬规则、
// §6 风险表「孤儿资产误判」行、§7 验收；台账 B5 的设计裁定已定，按此实现）。
//
// ⚠ 这是整个 P0b 里唯一把「删除按钮」摆到用户自己文件旁边的工具。spec §6 那句失败模式很直白:
//   用户真会删。所以本文件每条判据的方向都是**单向**的 —— 宁可少报孤儿,绝不误报。
//   任何「更聪明但可能漏收引用」的做法都不采用;反过来,只会「多藏一个孤儿」的规则(如大小写异体闸、
//   .gd/.tscn 非候选闸)方向上永远安全。
//
// 候选集 = **只有带 `<file>.import` 边车的导入资产**(png/wav/ttf/glb…)。为什么只有这一类可靠(台账 B5):
//   · `.gd`/`.cs` 脚本按 **class_name** 被用、不按路径 —— 按路径查引用会把满屏在用的脚本报成孤儿;
//   · `.tscn` 场景常被 `change_scene_to_file` / `load` 的**动态字符串**指向,静态分析盖不住;
//   · 而导入资产是编辑器**自己生成 .import、并在场景/代码里写出 res:// 路径**的那一类,引用面能被静态
//     分析覆盖 —— 只有这一类,「没人引用」才是可信的证据。
//   `.gd`/`.tscn` 正常情况下根本没有 .import 边车,「有边车」判据已把它们挡在候选集外;这里再显式挡一道
//   (NON_CANDIDATE_EXT)是为了防御畸形项目(一个 .gd 旁边恰好有个 .gd.import)导致的**误删**。
//
// 引用来源**只**用 buildRefIndex(ctx)（spec §5.2「一次扫描多工具共享」）。本文件不调 ctx.readText、
// 不再造第二套引用收集 —— 判据 1/8 全靠这条:成本 = 一次建索引,孤儿工具自己零 IO。
// buildRefIndex 把 `.import`/`.uid` 边车与 `.godot/**` 排除在**引用来源**之外(refIndex.ts:121-128):
// foo.png.import 里就有 source_file="res://foo.png",把它当引用会让**每个导入资产都被自己「引用」**,
// 孤儿检查永远报不出东西(假阴性比假阳性更难发现,B3 判据 2)。于是「只被自己的 .png.import 提到」的
// 资源照样算孤儿 —— 这条在本文件里重新钉一次(判据 2 的反面)。
//
// 判据 4(§5.3):ctx.truncated 或 index.partial(有来源读不到)→ 一条孤儿都不报。清单/读取不全时
// 「索引里查不到」不是「没人引用」的证据,把它端上删除按钮就是误删。沿用 brokenRefs.ts:25-35 与 truncatedFinding 的先例。
//
// 大小写(判据 5,Windows 大小写不敏感):只要索引里存在指向**同一文件的另一种大小写写法**(引用写
// res://UI/Banner.PNG、树里是 ui/banner.png),该目标**不判孤儿**。这条只可能隐藏孤儿、绝不凭空造孤儿。
// 做法:在 orphans.ts 内部建一张「to 键的小写集合」比对 —— 不改 refIndex 的公开形状(B3 已关闭)。
//
// 措辞红线(同 uid.ts:19-22):孤儿结论只挂 `fix:{kind:'trash',label,payload:{rels}}`。动词(「移入回收站」/
// 「永久删除」)、风险句、预览清单全部由 fixPlan.ts 给(按 isWin 与 kind 分叉,fixPlan.ts:240);检查器里
// 再写一遍就是 B1 建这条管线要防的漂移。label 只给数量与中性动词「移除」。逐条不另发结论(几百张卡片会压垮
// 页面),聚合成一条 orphans:all,与 uid:orphan:all 同形(但 id 不带数量,detail 带数量与体积)。
//
// 红线:纯函数,只吃 ToolContext —— 不碰 window / services / vue / DOM;唯一 IO 是 buildRefIndex(ctx)。
import type { Finding, ToolContext } from '../types'
import { truncatedFinding } from '../finding'
import { buildRefIndex } from '../refIndex'
import { fmtBytes, isCache } from '../treeUtils'

/** 聚合结论展示上限:与 uid.ts:38 的 LIST_CAP 同口径(刷屏控制,不影响 payload.rels 全量) */
const LIST_CAP = 20

/**
 * 按码元序比较(UTF-16),不用 localeCompare:locale 随宿主语言环境变,而 rels 顺序、related、预览清单
 * 要跨机器逐字节一致(判据 6 的 id 稳定性靠它)。同 uid.ts:58-60。
 */
function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** 顶层或任一段叫 addons 的条目 —— addons/ 内部归 B7,这里整体不进候选 */
function isAddon(rel: string): boolean {
  return rel.split('/').includes('addons')
}

/**
 * 永不进候选的扩展名:脚本按 class_name 用、场景常被动态字符串指向(文件头理由)。
 * 正常情况下这两类没有 .import 边车,「有边车」判据已经把它们挡在外面;这里显式再挡一道是为了防御
 * 畸形项目导致的误删。这条规则只会**减少**候选(永远只会藏孤儿),方向上安全。
 */
const NON_CANDIDATE_EXT = new Set(['gd', 'tscn'])

export async function run(ctx: ToolContext): Promise<Finding[]> {
  // 判据 1/8:引用收集只有一次 IO —— buildRefIndex(ctx)。本文件不碰 ctx.readText。
  const index = await buildRefIndex(ctx)

  // 判据 4:清单被截断 → 一条孤儿都不报(此时索引本就是空的,见 refIndex.ts:109)。沿用 brokenRefs 先例。
  if (ctx.truncated) {
    return [truncatedFinding(
      'orphans',
      '孤儿判定要拿「整份引用索引里都查不到这个资源」当证据;清单不全时「查不到」≠「没人引用」,' +
        '很可能是引用它的那个文件正好没被列进来。请把 maxEntries 调高或做一次完整重扫后再看' +
        ' —— 别用排除目录、按扩展名筛选来「缩小范围」:那样得到的清单同样不完整,却不会再带截断标记,' +
        '结论只会更假。',
      '文件清单被截断,本次不做孤儿资产判定'
    )]
  }

  // 判据 4:引用来源里有读不到的(.gd/.tscn/… 超限或二进制)→ index.partial → 一条孤儿都不报。
  // 「候选读不到不影响、但引用者读不到要降级」那条链条:refIndex 只对白名单来源记 readFailures,
  // 少读了引用者就是少了几条引用 —— 拿「查不到」去劝人删文件是危险的(会报出一条本不该报的孤儿)。
  if (index.partial) {
    const failed = index.readFailures.map((f) => f.rel)
    const shown = failed.slice(0, LIST_CAP)
    const hidden = failed.length - shown.length
    return [{
      // id 是常量键,不带数量/rel:读不到的那批每次扫描都可能变,带进 key 会让折叠与忽略记忆漂移。
      // 与 ctx.truncated 用不同 id —— 一条是「清单没扫全」、一条是「扫到了但有文件读不进」,
      // 两者的安全动作不同(调 maxEntries vs 处理读不到的文件),「忽略这条」也应分得开。
      id: 'orphans:partial',
      severity: 'warn',
      title: `有 ${failed.length} 个引用来源读不全,本次不做孤儿资产判定`,
      detail: `这些文件本该是引用来源却读不到(超限 / 二进制 / 读错误):${shown.join('、')}` +
        `${hidden ? ` 等 ${failed.length} 个` : ''}。少读了它们,索引就可能少几条引用,而「索引里查不到」` +
        '在这里不能当「没人引用」的证据 —— 拿它去劝人删文件是危险的。本次一条孤儿都不报;' +
        '把读不到的文件处理掉(或调高 maxBytes)后重扫即可。'
    }]
  }

  const tree = Array.isArray(ctx.tree) ? ctx.tree : []

  // 边车清单:带 <rel>.import 的资产才可能是候选。用**原样 rel** 精确匹配(编辑器把边车写成小写 .import;
  // 匹配不上只会漏掉一个候选,方向上安全)。
  const sidecars = new Set<string>()
  for (const f of tree) {
    const rel = f && typeof f.rel === 'string' ? f.rel : ''
    const ext = f && typeof f.ext === 'string' ? f.ext : ''
    if (rel && ext === 'import') sidecars.add(rel)
  }

  // 引用大小写异体集合(判据 5):resToRel 保留原样大小写,所以索引里 UI/Banner.PNG 与树里 ui/banner.png
  // 是两个不同键;把 to 的键都小写收进这张表,候选只要在其中有任意大小写的写法就不算孤儿。
  const refLower = new Set<string>()
  for (const key of index.to.keys()) refLower.add(key.toLowerCase())

  // 一趟遍历选候选 + 逐类计数默认排除项(判据 3:排除要计数并写进 detail)。按优先级判定,互不重数。
  const ex = { cache: 0, addons: 0, sidecar: 0, config: 0, code: 0 }
  const candSize = new Map<string, number>()
  for (const f of tree) {
    const rel = f && typeof f.rel === 'string' ? f.rel : ''
    if (!rel) continue
    const ext = f && typeof f.ext === 'string' ? f.ext : ''
    const size = f && typeof f.size === 'number' ? f.size : 0
    if (isCache(rel)) { ex.cache++; continue }                        // .godot/**:生成的缓存,不是候选也不是来源
    if (isAddon(rel)) { ex.addons++; continue }                        // addons 内部归 B7
    if (ext === 'import' || ext === 'uid') { ex.sidecar++; continue }  // 边车自身不是资产(B4/B6 的活)
    if (rel === 'project.godot') { ex.config++; continue }             // 配置文件:不是可删资产
    if (NON_CANDIDATE_EXT.has(ext)) { ex.code++; continue }            // .gd/.tscn:按类名/动态用,见文件头
    if (!sidecars.has(`${rel}.import`)) continue                       // 无 .import 边车 = 非导入资产 = 不在候选集
    if (!candSize.has(rel)) candSize.set(rel, size)                    // 同 rel 只算一次(防御畸形清单)
  }

  // 判据 2:孤儿 = 候选 ∧ 「引用索引里没有指向它的任何写法」。这一半(以及判据 5 的大小写异体)
  // 合并成一次小写集合判据:候选的小写只要落在 to 键的小写集合里,不管是原样大小写还是别种写法命中,
  // 都算「有人引用」→ 不是孤儿。原样命中(index.to.has)是小写异体命中的特例,两条并入同一集合判,
  // 不留一条永远被 refLower 顶掉的冗余 line(冗余 line 会让变异取不到红、判据虚挂)。
  // 判据 3:算引用不看引用得对不对 —— 哪怕引用来自注释、死代码,或引用者自身已经断链
  // (引用者对不对是 brokenRefs/B6 的事,孤儿工具不越界替它判:越界判就会把「引用它的场景坏了」念成「它可删」)。
  const orphans: string[] = []
  for (const rel of candSize.keys()) {
    if (refLower.has(rel.toLowerCase())) continue
    orphans.push(rel)
  }

  // 判据 7:一个候选都没有 / 候选全被引用 → 0 条结论(不出「未发现孤儿」的 info,那是 outcomeOf 的活)。
  if (!orphans.length) return []

  const rels = orphans.slice().sort(byText)  // 判据 6:逐字节确定,不跟 tree 顺序
  let bytes = 0
  for (const rel of rels) bytes += candSize.get(rel) || 0
  const shown = rels.slice(0, LIST_CAP)
  const hidden = rels.length - shown.length
  const n = rels.length

  return [{
    // 判据 6:id 是常量键,不带数量/时间戳/下标 —— 删掉第一个孤儿仍是同一条结论,折叠与忽略记忆不换键。
    id: 'orphans:all',
    severity: 'warn',
    title: `未引用资源(孤儿资产)${n} 个:引用索引里一次都没提到`,
    detail: `候选(带 .import 边车的导入资产)里没有任何引用指向的文件 ${n} 个,合计 ${fmtBytes(bytes)}:` +
      `${shown.join('、')}${hidden ? ` 等 ${n} 个` : ''}。` +
      (hidden ? ` 这里按 rel 只列前 ${shown.length} 个,另有 ${hidden} 个未列出;下面的建议仍按全部 ${n} 个执行。` : '') +
      ` 默认排除、不进候选的:.godot 缓存 ${ex.cache} 项、addons ${ex.addons} 项、` +
      `.import/.uid 边车 ${ex.sidecar} 项、project.godot ${ex.config} 项、` +
      `.gd/.tscn 脚本与场景 ${ex.code} 项(按类名/动态字符串使用)。` +
      // 判据 6(spec §6 原话含义,必须出现):明示静态分析的边界,动态加载无法判定。
      ` 本判定是**静态分析** —— 只有当引用索引(.gd/.tscn/.tres/.cs/.gdshader/.json/.gdextension/` +
      `export_presets.cfg/project.godot 里的 res:// 路径与字符串字面量)一次都没提到该资源才算孤儿;` +
      `拼接路径、ResourceLoader 运行时动态构造的加载静态分析无法判定,这类资源可能其实在用。删除前请确认无动态引用。`,
    rel: rels[0],
    related: shown,
    // 只有 kind/label/payload:动词/风险句/预览清单归 fixPlan.ts(见文件头措辞红线)。
    // label 里不写「移入回收站」—— 非 Windows 宿主是真删(fixPlan.ts:240 按 isWin 分叉)。
    // payload.rels 一律全量:planFix 的预览 items 就是由它生成(fixPlan.ts:87-112 → :238-251),
    // 所以上面的展示裁切不会裁掉确认框的完整清单(spec §5.3 规则 3)。
    fix: { kind: 'trash', label: `移除 ${n} 个未引用资源`, payload: { rels } }
  }]
}
