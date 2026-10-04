// P1 工具 #12:脚本体检(spec §3.2 #12,拆解见 docs/tools-page-plan.md P1-4 #12)。
//
// 三条判据,方向各不相同:
//   · **class_name 重复** = error:两个文件抢同一个 global class,编辑器直接拒绝,不可能误报;
//   · **继承环** = error:环上的类两边都拿不到基类,表现为「随机一个文件打不开」;
//   · **基类认不出** ≠ error。这是待确认 #13 选定的**甲方案**:手写白名单(下面那份)与项目内声明
//     都不认识的基类,本工具**不判**,只出一条聚合 info 把条数与名字说出口。
//     为什么不报 error:甲方案没有引擎权威类表(那是乙方案的 `services.docsListClasses`),
//     白名单少列一个冷门引擎类就会造出「你的脚本继承了一个不存在的东西」这种假 error ——
//     用户会照着这句话去改代码,说错一次就烧掉整页的信任(§6 头号失败模式)。
//
// 与 orphans 的分工:那边判「文件没人引用」,并明确脚本是按 class_name 被用的(orphans.ts:10);
// 这边判「class_name 本身撞了 / 成环」。两边共用的是 scanGdDecls(gdSymbols.ts),不是各写一份正则。
//
// 截断时整体不判:重复与环都是**跨文件**判据 —— 清单少一半,「没重复」这个结论就是假的。
//
// 红线:纯函数,只吃 ToolContext —— 不碰 window / services / vue / DOM。
import type { Finding, ToolContext } from '../types'
import { LIST_CAP, truncatedFinding } from '../finding'
import { scanGdDecls } from '../parsers/gdSymbols'
import { resPathShapeOk, resToRel } from '../parsers/sceneRefs'
import { byText, gdignoredDirs, hasRelCI, isCache, isGdignored, lowerRelSet } from '../treeUtils'

/**
 * 甲方案的手写引擎类白名单(Godot 4 常见继承基类)。
 *
 * ⚠ 这份表只用来**免除怀疑**,不用来定罪:表里的基类一律当正常,表外的一个 error 都不发。
 * 所以它不完整没关系(冷门类只是并进聚合 info 那笔数),写错才有关系。
 */
const ENGINE_BASES = new Set([
  'Object', 'RefCounted', 'Resource', 'ShaderMaterial', 'Material', 'Environment',
  'Node', 'Node2D', 'Node3D', 'Control', 'CanvasItem', 'CanvasLayer', 'Viewport', 'SubViewport', 'Window',
  'CharacterBody2D', 'CharacterBody3D', 'RigidBody2D', 'RigidBody3D', 'StaticBody2D', 'StaticBody3D',
  'AnimatableBody2D', 'AnimatableBody3D', 'PhysicalBone2D', 'PhysicalBone3D', 'SoftBody3D',
  'Area2D', 'Area3D', 'CollisionShape2D', 'CollisionShape3D', 'CollisionPolygon2D', 'CollisionPolygon3D',
  'Marker2D', 'Marker3D', 'Timer', 'MultiplayerSpawner', 'MultiplayerSynchronizer',
  'Sprite2D', 'Sprite3D', 'AnimatedSprite2D', 'AnimatedSprite3D', 'Line2D', 'Line3D', 'Polygon2D',
  'Camera2D', 'Camera3D', 'Path2D', 'Path3D', 'PathFollow2D', 'PathFollow3D',
  'MeshInstance3D', 'GeometryInstance3D', 'VisualInstance3D', 'OccluderInstance3D', 'Decal',
  'Light2D', 'PointLight2D', 'DirectionalLight3D', 'OmniLight3D', 'SpotLight3D',
  'TileMap', 'TileMapLayer', 'NavigationAgent2D', 'NavigationAgent3D', 'NavigationRegion2D', 'NavigationRegion3D',
  'GPUParticles2D', 'GPUParticles3D', 'CPUParticles2D', 'CPUParticles3D',
  'Parallax2D', 'ParallaxLayer', 'Parallax3D', 'Position2D', 'Position3D', 'RemoteTransform2D', 'RemoteTransform3D',
  'WorldBoundary2D', 'VisibleOnScreenNotifier2D', 'VisibleOnScreenNotifier3D',
  'Container', 'BoxContainer', 'VBoxContainer', 'HBoxContainer', 'GridContainer', 'MarginContainer',
  'Panel', 'PanelContainer', 'ColorRect', 'TextureRect', 'TextureButton', 'Button', 'Label', 'Label3D',
  'RichTextLabel', 'ProgressBar', 'ScrollContainer', 'SplitContainer', 'TabContainer', 'TabBar',
  'LineEdit', 'TextEdit', 'CodeEdit', 'OptionButton', 'CheckBox', 'CheckButton', 'RadioButton',
  'MenuButton', 'LinkButton', 'Tree', 'ItemList', 'GraphEdit', 'GraphFrame', 'GraphNode',
  'Popup', 'PopupMenu', 'AcceptDialog', 'ConfirmationDialog', 'FileDialog',
  'AudioStreamPlayer', 'AudioStreamPlayer2D', 'AudioStreamPlayer3D', 'VideoStreamPlayer',
  'AnimationPlayer', 'AnimationTree', 'Skeleton2D', 'Skeleton3D', 'Bone2D', 'BoneAttachment3D',
  'HTTPRequest', 'ResourceFormatLoader'
])

/** 一条 .gd 的读结果(只留判据要用的四个值) */
interface FileDecl {
  rel: string
  className: string
  classNameLine: number
  base: string
  baseLine: number
  basePath: string
  basePathLine: number
}

/** 「不判的条数」那句话的两个落点(§5.2 的口径:藏起来的要看得见) */
function skipDetail(unread: number, suspect: number): string {
  const parts: string[] = []
  if (unread) parts.push(`${unread} 份 .gd 读不到文本(缺失 / 超体积上限 / 被判二进制)`)
  if (suspect) parts.push(`${suspect} 份 .gd 文本可疑(未闭合引号一类,行列界已不可信),整份不判`)
  return `本次未判定:${parts.join(';')}。`
}

export async function run(ctx: ToolContext): Promise<Finding[]> {
  if (ctx.truncated) {
    return [truncatedFinding(
      'scripts',
      '重复 class_name 与继承环都是跨文件判据:清单被截断时,另一半声明可能根本没进来,' +
        '「没有重复」这个结论就是假的。请把 maxEntries 调高或做一次完整重扫后再看' +
        ' —— 别用排除目录、按扩展名筛选来缩小范围,那样得到的清单同样不完整,却不会再带截断标记。',
      '文件清单被截断,本次不做脚本体检'
    )]
  }

  const dirs = gdignoredDirs(ctx.tree)
  const have = lowerRelSet(ctx.tree)
  const out: Finding[] = []
  const decls: FileDecl[] = []
  let unread = 0
  let suspect = 0

  for (const f of ctx.tree) {
    if (!f || typeof f.rel !== 'string' || !f.rel || f.ext !== 'gd') continue
    if (isCache(f.rel) || isGdignored(dirs, f.rel)) continue
    const { text } = await ctx.readText(f.rel)
    if (typeof text !== 'string') { unread++; continue }
    const d = scanGdDecls(text)
    if (d.suspect) { suspect++; continue }
    decls.push({ rel: f.rel, ...d })
  }

  // 项目内声明表:同名多条时归入重复档,这里只留第一条给继承链用(重复本身已单独报)。
  const declaredBy = new Map<string, { rel: string; line: number }[]>()
  const firstByClass = new Map<string, FileDecl>()
  for (const d of decls) {
    if (!d.className) continue
    const list = declaredBy.get(d.className)
    if (list) list.push({ rel: d.rel, line: d.classNameLine })
    else declaredBy.set(d.className, [{ rel: d.rel, line: d.classNameLine }])
    if (!firstByClass.has(d.className)) firstByClass.set(d.className, d)
  }

  // ── 判据 1:class_name 重复 ────────────────────────────────
  const dups: { name: string; sites: { rel: string; line: number }[] }[] = []
  for (const [name, sites] of declaredBy) if (sites.length > 1) dups.push({ name, sites })
  dups.sort((a, b) => byText(a.name, b.name))
  for (const d of dups.slice(0, LIST_CAP)) {
    out.push({
      id: `scripts:dup:${d.name}`,
      severity: 'error',
      title: `class_name ${d.name} 被 ${d.sites.length} 个文件重复声明`,
      detail: `${d.sites.map((s) => `${s.rel}:${s.line}`).join('、')}。` +
        ' Godot 的 global class 是全局表,同名两份会让其中一份在别处引用时随机失效 ——' +
        ' 编辑器只在解析到冲突时报错,所以先改掉后声明的那份,或者干脆去掉 class_name 改用 preload。',
      rel: d.sites[0].rel,
      related: d.sites.map((s) => s.rel)
    })
  }
  const hiddenDups = dups.length - Math.min(dups.length, LIST_CAP)

  // ── 判据 2:继承环(含自继承) ─────────────────────────────
  // 只在「基类也是项目里声明过的 class」时建边:白名单里的引擎类天然不成环,未知基类不参与(甲方案)。
  const reported = new Set<string>()
  for (const [name, d] of firstByClass) {
    if (!d.base || !firstByClass.has(d.base)) continue
    const chain: string[] = []
    const pos = new Map<string, number>()
    let cur: string | undefined = name
    while (cur && firstByClass.has(cur)) {
      if (pos.has(cur)) { chain.push(cur); break }
      pos.set(cur, chain.length)
      chain.push(cur)
      const next: FileDecl | undefined = firstByClass.get(cur)
      cur = next && next.base ? next.base : undefined
    }
    const start = chain[chain.length - 1]
    if (!pos.has(start)) continue // 没走回已访问节点 = 无环
    const cycle = chain.slice(pos.get(start) as number)
    cycle.pop()
    if (cycle.length === 0) continue
    const key = [...cycle].sort().join('|')
    if (reported.has(key)) continue
    reported.add(key)
    const sites = cycle.map((c) => firstByClass.get(c) as FileDecl)
    out.push({
      id: `scripts:cycle:${key}`,
      severity: 'error',
      title: cycle.length === 1
        ? `class_name ${cycle[0]} 继承了自己`
        : `继承成环:${cycle.join(' → ')} → ${cycle[0]}`,
      detail: (cycle.length === 1
        ? `声明处 ${sites[0].rel}:${sites[0].baseLine}。一个类不能以自己的名字作基类。`
        : `声明处 ${sites.map((s) => `${s.rel}:${s.baseLine}`).join('、')}。`) +
        ' GDScript 解析类时要先知道基类,环上的每一个都拿不到 —— 表现是这几个文件在编辑器里随机打不开。',
      rel: sites[0].rel,
      related: sites.map((s) => s.rel)
    })
  }

  // ── 判据 3:extends "res://…" 的路径形态(这一条**能**判死) ──
  let shapeSkipped = 0
  const missing: { rel: string; line: number; path: string }[] = []
  for (const d of decls) {
    if (!d.basePath) continue
    if (!resPathShapeOk(d.basePath)) { shapeSkipped++; continue }
    const rel = resToRel(d.basePath)
    if (rel === null || hasRelCI(have, rel)) continue
    missing.push({ rel: d.rel, line: d.baseLine || d.basePathLine, path: d.basePath })
  }
  for (const m of missing.sort((a, b) => byText(a.rel, b.rel))) {
    out.push({
      id: `scripts:base-missing:${m.rel}:${m.path}`,
      severity: 'error',
      title: `继承的脚本路径不存在:${m.path}`,
      detail: `${m.rel}:${m.line} 用 `+ 'extends "res://…"' + ' 按路径继承,而这个目标不在文件清单里。' +
        ' 该脚本会加载失败;补回文件,或把路径改成现在真实位置。',
      rel: m.rel,
      related: [m.path]
    })
  }

  // ── 甲方案的那笔「不判」:白名单外的基类 ───────────────────
  const unknown: { name: string; rel: string }[] = []
  for (const d of decls) {
    if (!d.base || ENGINE_BASES.has(d.base) || firstByClass.has(d.base)) continue
    unknown.push({ name: d.base, rel: d.rel })
  }
  unknown.sort((a, b) => byText(a.name, b.name))
  const unknownShown = unknown.slice(0, LIST_CAP)
  const counts = skipDetail(unread, suspect) + (shapeSkipped ? ` 另有 ${shapeSkipped} 条路径形态首尾带空白或标点,没拿它去比清单。` : '')
  if (unknown.length) {
    out.push({
      id: 'scripts:unknown-base',
      severity: 'info',
      title: `${unknown.length} 处 extends 的基类本工具判不了`,
      detail: `认不出的基类:${unknownShown.map((u) => u.name).join('、')}` +
        (unknown.length > unknownShown.length ? ` 等 ${unknown.length} 个(按字典序列前 ${LIST_CAP} 个)` : '') +
        `。这些名字既不在项目声明的 class_name 里,也不在内置引擎类表里 —— ` +
        '可能是打错的引擎类名,也可能只是我们的内置表没收录它,**所以本工具不下结论**。' +
        ' 想拿到引擎类全集,请先生成该版本的引擎文档库(文档页),工具随后可以按权威表判这条。' +
        (dups.length > 0 ? ` ${counts}` : ''),
      related: unknownShown.slice(0, 8).map((u) => u.rel)
    })
  }

  // 排除数:有别的结论时并进每一条 detail;一条都没有时单独出一条 info(否则这笔数没有落点)。
  if (unread || suspect || shapeSkipped) {
    if (out.length) {
      const note = (hiddenDups ? `重复组共 ${dups.length} 组,这里只列前 ${LIST_CAP} 组。` : '') + counts
      for (const f of out) f.detail += ` ${note}`
    } else {
      out.push({
        id: 'scripts:skip-count',
        severity: 'info',
        title: `${unread + suspect + shapeSkipped} 项未纳入本次脚本体检`,
        detail: counts + ' 没有未判定项时本条不会出现 —— 它存在的意义就是别让「没报」看起来像「没问题」。'
      })
    }
  } else if (hiddenDups) {
    for (const f of out) f.detail += ` 重复组共 ${dups.length} 组,这里只列前 ${LIST_CAP} 组。`
  }

  return out
}
