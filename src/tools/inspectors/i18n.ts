// P1 工具 #15:本地化体检(spec §3.2 #15,拆解见 docs/tools-page-plan.md P1-4 #15)。
//
// 两条判据:
//   · 配置点名的翻译文件不在清单里 = **error**(该 locale 整块翻译失效,是看得见的坏);
//   · 翻译 csv 的首列 `_key` 重复 = **warn**(引擎按加载顺序覆盖前者并 push_warning,项目照跑)。
//
// 最容易写错的是**收集面**:必须只吃 `[internationalization]` 段里的 res:// 值。
// 直接把 iniResPaths(doc) 的全量结果拿去判,`application/config/icon="res://icon.svg"` 这类也会被
// 当翻译文件查一遍 —— 图标/启动图的写法在各项目里五花八门,于是长出一批假 error。
// 这条过滤是 iniResPaths 的 fullKey(`godotIni.ts:207` 的 section + '/' + key)现成给的,不新造规则。
//
// csv 的「读不下去」按 spec §5.2 处理:未闭合引号 → partial → 这份文件不判重复,并计一笔上卡。
// `.po` 只判存在性:它的 msgid 查重要先验一遍 gettext 转义规则,未实测前不落判据(待确认 #16)。
//
// 截断时撤掉的只有存在性那一路(与 scenes 同一方向):清单残缺时「不在清单里」不等于「文件没了」。
//
// 红线:纯函数,只吃 ToolContext —— 不碰 window / services / vue / DOM。
import type { Finding, ToolContext } from '../types'
import { LIST_CAP } from '../finding'
import { iniResPaths, parseGodotIni } from '../parsers/godotIni'
import { dupFirstCells, readTranslationCsv } from '../parsers/translationCsv'
import { resPathShapeOk, resToRel } from '../parsers/sceneRefs'
import { byText, hasRelCI, lowerRelSet, rootRelOf } from '../treeUtils'

/** 本地化配置所在的段名(Godot 4 写盘就是这个) */
const I18N_SECTION = 'internationalization/'

export async function run(ctx: ToolContext): Promise<Finding[]> {
  const pRel = rootRelOf(ctx.tree, 'project.godot')
  const projText = pRel ? (await ctx.readText(pRel)).text : undefined
  if (typeof projText !== 'string') {
    // 没有对照物就什么都别发:配置读不到时「翻译文件不存在」这个结论的来源也一并没了。
    return [{
      id: 'i18n:no-project',
      severity: 'info',
      title: '读不到 project.godot,本次不做本地化体检',
      detail: '翻译表清单来自 project.godot 的 [internationalization] 段;它不在文件清单中或文本读不出来时,' +
        '本工具既不知道该有哪些翻译文件,也就无从判缺失或重复。'
    }]
  }

  const have = lowerRelSet(ctx.tree)
  const out: Finding[] = []
  let truncSkipped = 0
  let shapeSkipped = 0
  let partialCsv = 0
  let unreadCsv = 0

  const doc = parseGodotIni(projText)
  const listed: { path: string; line: number }[] = []
  for (const r of iniResPaths(doc)) {
    if (!r.fullKey.startsWith(I18N_SECTION)) continue
    listed.push({ path: r.path, line: r.line })
  }

  for (const item of listed) {
    if (!resPathShapeOk(item.path)) { shapeSkipped++; continue }
    const rel = resToRel(item.path)
    if (rel === null) { shapeSkipped++; continue }
    if (ctx.truncated) { truncSkipped++; continue }
    if (!hasRelCI(have, rel)) {
      out.push({
        id: `i18n:missing:${item.path}`,
        severity: 'error',
        title: `[internationalization] 点名的翻译文件不存在:${item.path}`,
        detail: `${pRel || 'project.godot'}:${item.line} 配置了这个翻译表,而它不在文件清单里。` +
          ' 该文件覆盖的那些词条会全部退回原文(界面显示 en 键名而不是译文),而且没有任何弹窗提示。',
        rel: pRel || 'project.godot',
        related: [item.path]
      })
      continue
    }

    // 只有 csv 查首列重复;.po / .translation 到这儿为止只判存在性。
    const ext = rel.slice(rel.lastIndexOf('.') + 1).toLowerCase()
    if (ext !== 'csv') continue
    const { text } = await ctx.readText(rel)
    if (typeof text !== 'string') { unreadCsv++; continue }
    const read = readTranslationCsv(text)
    if (read.partial) { partialCsv++; continue }
    // 表头行不当翻译键:第一条记录是 `_key` 那一行,跳掉它再查重(语义归本检查器,不下沉到解析器)。
    const body = read.cells.slice(1)
    for (const d of dupFirstCells(body)) {
      out.push({
        id: `i18n:dup-key:${rel}:${d.cell}`,
        severity: 'warn',
        title: `翻译表里有 ${d.lines.length} 行用了同一个键:${d.cell}`,
        detail: `${rel} 的第 ${d.lines.slice(0, LIST_CAP).join('、')} 行首列都是 "${d.cell}"` +
          (d.lines.length > LIST_CAP ? `(共 ${d.lines.length} 处,这里点名前 ${LIST_CAP} 行)` : '') +
          '。Godot 加载词条按顺序覆盖,最终生效的是最后一行 —— 前面那几行的译文静默消失。' +
          ' 给其中一处换键名,或把两条文案合到同一个键下。',
        rel,
        line: d.lines[0]
      })
    }
  }

  const counts: string[] = []
  if (truncSkipped) counts.push(`${truncSkipped} 条翻译表引用因文件清单被截断而不判存在性`)
  if (shapeSkipped) counts.push(`${shapeSkipped} 条路径写法首尾带空白或以标点收尾,没拿它去比清单`)
  if (partialCsv) counts.push(`${partialCsv} 份 csv 有未闭合引号(行界不可信),没判首列重复`)
  if (unreadCsv) counts.push(`${unreadCsv} 份 csv 读不到文本`)
  const noteTxt = counts.length ? `本次未判定:${counts.join(';')}。` : ''
  if (noteTxt) {
    if (out.length) for (const f of out) f.detail += ` ${noteTxt}`
    else out.push({
      id: 'i18n:skip-count',
      severity: 'info',
      title: `${truncSkipped + shapeSkipped + partialCsv + unreadCsv} 项未纳入本次本地化体检`,
      detail: noteTxt + ' 没有未判定项时本条不会出现 —— 它存在的意义就是别让「没报」看起来像「没问题」。'
    })
  }

  return out
}
