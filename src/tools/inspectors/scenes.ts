// P1 工具 #13:场景体检(spec §3.2 #13,拆解见 docs/tools-page-plan.md P1-4 #13)。
//
// 三条判据,来自两个解析件:
//   · **同名兄弟**(sceneNodes.ts 递推出的 path 分组)= error:引擎按名字寻路,后一个顶掉前一个的节点路径;
//   · **load_steps 与实数不符**(countSteps,sceneRefs.ts:85)= warn。这条此前**一直没有消费者**
//     (唯一调用方是 tools.test.mjs:290 那组解析器自测),本轮接上就是白捡的 ——
//     不变式 `load_steps = ext + sub + 1` 与「缺属性就跳过比对」都已经是它的既定口径,不在这里改;
//   · **节点脚本失效** = error。两种形态各判:`script = ExtResource("id")` 先看 id 在不在本文件的
//     [ext_resource] 里(不在 → 单独一档,措辞是「引用不到声明」而不是「文件丢了」),
//     再看那条 path 在不在清单里;`script = "res://x.gd"` 的内联串形态直接判后者。
//
// 截断的处理**与 brokenRefs 不同**,这是本文件最容易写错的一点:同名与 load_steps 是**文件内**判据,
// 清单残缺不影响它们;只有存在性那一路需要完整清单。所以截断时撤掉的只有存在性,并把撤掉的条数说进
// detail(spec §5.2「不判的要说出口」与债 6「只撤主张不新增」同一方向)。
//
// 认不出根的文件(sceneNodes 给出全空 path)不做同名分组:那时所有节点的父路径都归零,
// 按分组判会造出一批「同一父下重名」的假 error。
//
// 红线:纯函数,只吃 ToolContext —— 不碰 window / services / vue / DOM。
import type { Finding, ToolContext } from '../types'
import type { SceneNode } from '../parsers/sceneNodes'
import { LIST_CAP } from '../finding'
import { SCENE_EXT, countSteps, parseExtResources, resPathShapeOk, resToRel } from '../parsers/sceneRefs'
import { parseSceneNodes } from '../parsers/sceneNodes'
import { byText, gdignoredDirs, hasRelCI, isCache, isGdignored, lowerRelSet } from '../treeUtils'

/** 「不判的条数」那句话。四种成因各说各的,不并成一句含糊的「部分文件未检查」 */
function noteOf(truncSkipped: number, shapeSkipped: number, unread: number, unrooted: number): string {
  const parts: string[] = []
  if (truncSkipped) parts.push(`${truncSkipped} 条脚本引用因文件清单被截断而不判存在性(清单残缺时「不在清单里」不等于「文件没了」)`)
  if (shapeSkipped) parts.push(`${shapeSkipped} 条脚本路径写法首尾带空白或以标点收尾,归一出来的串不是那条路径本身,没拿它去比清单`)
  if (unread) parts.push(`${unread} 个场景文件读不到文本(缺失 / 超体积上限 / 被判二进制)`)
  if (unrooted) parts.push(`${unrooted} 个文件认不出根节点(没有任何一段不带 parent),对它们不做同名分组`)
  return `本次未判定:${parts.join(';')}。`
}

export async function run(ctx: ToolContext): Promise<Finding[]> {
  const dirs = gdignoredDirs(ctx.tree)
  const have = lowerRelSet(ctx.tree)
  const trunc = ctx.truncated
  const out: Finding[] = []
  let truncSkipped = 0
  let shapeSkipped = 0
  let unread = 0
  let unrooted = 0

  /** 存在性那一路的唯一出口:先撤截断、再撤脏形状,剩下的才比清单 */
  function reportMissing(relFile: string, node: SceneNode, path: string, via: string, key: string) {
    if (trunc) { truncSkipped++; return }
    if (!resPathShapeOk(path)) { shapeSkipped++; return }
    const rel = resToRel(path)
    if (rel === null || hasRelCI(have, rel)) return
    out.push({
      id: `scenes:script-missing:${relFile}:${key}`,
      severity: 'error',
      title: `节点挂的脚本路径不存在:${path}`,
      detail: `${relFile}:${node.line} 的节点 ${node.name || '(无名)'} 通过 ${via} 指向 ${path},而它不在文件清单里。` +
        ' 打开场景时该节点的脚本会加载失败 —— 生命周期函数与导出变量全部消失。' +
        ' 补回文件,或在编辑器里给节点重挂到现在的位置。',
      rel: relFile,
      related: [path]
    })
  }

  for (const f of ctx.tree) {
    if (!f || typeof f.rel !== 'string' || !f.rel || !SCENE_EXT.has(f.ext)) continue
    if (isCache(f.rel) || isGdignored(dirs, f.rel)) continue
    const { text } = await ctx.readText(f.rel)
    if (typeof text !== 'string') { unread++; continue }

    const nodes = parseSceneNodes(text)

    // ── 判据 1:同名兄弟(父路径 + 名字分组) ────────────────
    const rooted = nodes.filter((n) => n.path !== '')
    if (nodes.length && !rooted.length) unrooted++
    if (rooted.length) {
      const byParent = new Map<string, number[]>()
      for (const n of rooted) {
        if (!n.name) continue
        const slash = n.path.lastIndexOf('/')
        const parentPath = slash < 0 ? '' : n.path.slice(0, slash)
        const key = `${parentPath}\u0000${n.name}`
        const list = byParent.get(key)
        if (list) list.push(n.line)
        else byParent.set(key, [n.line])
      }
      const dups: { parentPath: string; name: string; lines: number[] }[] = []
      for (const [key, lines] of byParent) {
        if (lines.length < 2) continue
        const sep = key.indexOf('\u0000')
        dups.push({ parentPath: key.slice(0, sep), name: key.slice(sep + 1), lines })
      }
      dups.sort((a, b) => byText(`${a.parentPath}/${a.name}`, `${b.parentPath}/${b.name}`))
      for (const d of dups.slice(0, LIST_CAP)) {
        out.push({
          id: `scenes:siblings:${f.rel}:${d.parentPath}/${d.name}`,
          severity: 'error',
          title: `同一父节点下有 ${d.lines.length} 个同名节点:${d.name}`,
          detail: `${f.rel} 的第 ${d.lines.join('、')} 行都声明了 name="${d.name}",父路径 ${d.parentPath || '(根)'}。` +
            ' 引擎按名字寻路,后一个会顶掉前一个的节点路径 —— get_node 只能拿到其中一个,另一份的数据在运行时静默消失。',
          rel: f.rel
        })
      }
    }

    // ── 判据 2:load_steps 与实数(不变式与「缺属性跳过」都归 countSteps) ──
    const steps = countSteps(text)
    if (steps.declared > 0 && steps.declared !== steps.expected) {
      out.push({
        id: `scenes:steps:${f.rel}`,
        severity: 'warn',
        title: '头部 load_steps 与文件里的资源条数不符',
        detail: `${f.rel} 声明 load_steps=${steps.declared},而 [ext_resource] + [sub_resource] 共 ${steps.actual} 条;` +
          ` 引擎的不变式是再加 1(资源文件自己)= ${steps.expected}。多半是手改或合并留下的:编辑器打开时会自己修正。` +
          ` 声明比实际**小**时(这里 ${steps.declared} < ${steps.expected})说明有引用被删掉了却没回头改头部,值得逐个看一眼。`,
        rel: f.rel
      })
    }

    // ── 判据 3:节点脚本失效 ────────────────────────────────
    const byId = new Map<string, string>()
    for (const ref of parseExtResources(text)) if (ref.id && !byId.has(ref.id)) byId.set(ref.id, ref.path)

    for (const n of nodes) {
      if (n.scriptId) {
        const path = byId.get(n.scriptId)
        if (path === undefined) {
          out.push({
            id: `scenes:script-badid:${f.rel}:${n.scriptId}`,
            severity: 'error',
            title: `节点 ${n.name || '(无名)'} 的脚本引用指到了不存在的 ext_resource id`,
            detail: `${f.rel}:${n.line} 写 script = ExtResource("${n.scriptId}"),但这个文件的 [ext_resource] 里没有这个 id。` +
              ' 这是引用表本身断了(声明被删掉、用法留下了),不是「文件丢了」—— 补回那条声明,或在编辑器里给节点重挂脚本。',
            rel: f.rel,
            related: [n.scriptId]
          })
          continue
        }
        reportMissing(f.rel, n, path, `ExtResource("${n.scriptId}")`, n.scriptId)
        continue
      }
      if (n.scriptPath) reportMissing(f.rel, n, n.scriptPath, '内联的 res:// 路径', n.scriptPath)
    }
  }

  const note = noteOf(truncSkipped, shapeSkipped, unread, unrooted)
  if (truncSkipped || shapeSkipped || unread || unrooted) {
    if (out.length) for (const f of out) f.detail += ` ${note}`
    else out.push({
      id: 'scenes:skip-count',
      severity: 'info',
      title: `${truncSkipped + shapeSkipped + unread + unrooted} 项未纳入本次场景体检`,
      detail: note + ' 没有未判定项时本条不会出现 —— 它存在的意义就是别让「没报」看起来像「没问题」。'
    })
  }

  return out
}
