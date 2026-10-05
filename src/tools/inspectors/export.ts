// P1 工具 #10:导出预设体检(spec §3.2 #10,拆解见 docs/tools-page-plan.md 第四部分)。
//
// 只做**文件里能判死**的两条:
//   · 同一份 cfg 里两个预设用同一个 `name` = warn —— 编辑器里能共存,但命令行 `--export-release "<名字>"`
//     是按名字选预设的,名字撞了之后「导哪一个」取决于引擎先匹配到谁,CI 里这是一类静默错;
//   · 预设点名的 `res://` 资源不在清单里 = error —— 导出的包里主场景/图标丢了,是玩家看得见的坏。
//
// §3.2 原文里另外两条**本批不做**,且卡面上会说明去哪看:
//   · 模板齐全度要调 `services.exportTemplateStatus`(契约方法,不在 types.ts:8 的四个 Capability 里),
//     而工具页与版本页的重叠按 §6 一律「只报告 + 不复制操作入口」;
//   · `versionDir` 与引擎版本串是否匹配依赖 §3.4 A 的自定义模板实测,待确认 #9/#10 至今未做 ——
//     未实测的判据不落笔。
//
// 两条放过的是假阳性的根:空串值(`custom_template/debug=""` 每个不用自编译模板的预设都会写)与
// `export_path`(那是磁盘路径,不是项目内引用)。把它们当引用去判,等于对每一个正常预设报一条 error。
//
// 与 refIndex 的分工:那边把根级 cfg 当**引用来源**收进索引(orphans 靠它不劝人删主场景);
// 这里判的是「预设自己指对了没」,方向相反,所以不复用索引,也不与它的结论打架。
//
// 红线:纯函数,只吃 ToolContext —— 不碰 window / services / vue / DOM。
import type { Finding, ToolContext } from '../types'
import { getIni, iniResPaths, parseGodotIni } from '../parsers/godotIni'
import { resPathShapeOk, resToRel } from '../parsers/sceneRefs'
import { byText, hasRelCI, lowerRelSet, rootRelOf } from '../treeUtils'

/** 只认根级那一份(插件目录里的同名文件是别人家的预设表) */
const CFG_BASENAME = 'export_presets.cfg'

/** `[preset.0]` / `[preset.12]` —— 段名就是编辑器「导出」对话框里的第 N 项 */
const PRESET_SECTION = /^preset\.(\d+)$/

export async function run(ctx: ToolContext): Promise<Finding[]> {
  const cfgRel = rootRelOf(ctx.tree, CFG_BASENAME)
  if (!cfgRel) {
    return [{
      id: 'export:no-file',
      severity: 'info',
      title: '项目还没有 export_presets.cfg(没有导出预设)',
      detail: '没配预设不是问题,但也不意味着「体检通过」—— 本工具这轮没有可查的东西。' +
        ' 要出包先在编辑器「项目 → 导出 → 添加预设」里建一份。'
    }]
  }
  const { text } = await ctx.readText(cfgRel)
  if (typeof text !== 'string') {
    return [{
      id: 'export:skip-count',
      severity: 'info',
      title: 'export_presets.cfg 读不到文本,本次不做导出预设体检',
      detail: `本次未判定:${cfgRel} 读不出文本(缺失 / 超体积上限 / 被判二进制)。` +
        ' 没有这份表,预设名与它点名的资源都无从判起。'
    }]
  }

  const doc = parseGodotIni(text)
  const have = lowerRelSet(ctx.tree)
  const out: Finding[] = []

  // ── 判据 1:预设段与它的 name ─────────────────────────────
  const sections: { sec: string; idx: number }[] = []
  const seenSec = new Set<string>()
  for (const v of doc.values) {
    const m = PRESET_SECTION.exec(v.section || '')
    if (!m || seenSec.has(v.section)) continue
    seenSec.add(v.section)
    sections.push({ sec: v.section, idx: Number(m[1]) })
  }
  sections.sort((a, b) => a.idx - b.idx)

  const byName = new Map<string, string[]>()
  for (const s of sections) {
    const name = getIni(doc, `${s.sec}/name`)
    if (!name) continue
    const list = byName.get(name)
    if (list) list.push(s.sec)
    else byName.set(name, [s.sec])
  }
  const dups: { name: string; secs: string[] }[] = []
  for (const [name, secs] of byName) if (secs.length > 1) dups.push({ name, secs })
  dups.sort((a, b) => byText(a.name, b.name))
  for (const d of dups) {
    out.push({
      id: `export:dup-name:${d.name}`,
      severity: 'warn',
      title: `两个导出预设用了同一个名字:${d.name}`,
      detail: `${d.secs.join(' 与 ')} 的 name 都是 "${d.name}"。编辑器里能并存,但命令行导出是按名字选预设的` +
        '(`--export-release "…"`),名字撞了之后实际导出哪一个取决于匹配顺序 —— 自动化脚本里这是一类静默错。' +
        ' 给其中一个加上目标平台或渠道后缀。',
      rel: cfgRel,
      related: d.secs
    })
  }

  // ── 判据 2:预设点名的 res:// 资源存在性 ──────────────────
  let truncSkipped = 0
  let shapeSkipped = 0
  const missing: { path: string; fullKey: string; line: number }[] = []
  for (const r of iniResPaths(doc)) {
    if (!PRESET_SECTION.test(r.fullKey.split('/')[0])) continue
    if (!resPathShapeOk(r.path)) { shapeSkipped++; continue }
    const rel = resToRel(r.path)
    if (rel === null) { shapeSkipped++; continue }
    if (ctx.truncated) { truncSkipped++; continue }
    if (hasRelCI(have, rel)) continue
    missing.push({ path: r.path, fullKey: r.fullKey, line: r.line })
  }
  missing.sort((a, b) => byText(a.fullKey, b.fullKey))
  for (const m of missing) {
    const sec = m.fullKey.split('/')[0]
    out.push({
      id: `export:missing:${m.fullKey}:${m.path}`,
      severity: 'error',
      title: `预设点名的资源不存在:${m.path}`,
      detail: `${CFG_BASENAME} 的 ${sec}(第 ${m.line} 行)在 ${m.fullKey} 里引用了这个路径,而它不在文件清单里。` +
        ' 导出的包会在启动或用到该资源时才暴露问题(主场景丢了就是黑屏),而且报的是运行时的错,不指向预设。' +
        ' 补回文件,或在该预设里改掉这一项。',
      rel: cfgRel,
      related: [m.path]
    })
  }

  // ── 固定的一条去向说明(本批不判的两条,别让用户以为「没问题」) ──
  out.push({
    id: 'export:templates-here',
    severity: 'info',
    title: '导出模板是否齐全不在本页判,去「版本」页看',
    detail: '模板的下载/安装/卸载与齐全度都在版本页(引擎版本 + 模板区),本页只判预设这份文件写对了没。' +
      ' 「预设要求的模板目录与引擎版本串是否对得上」本批也没做:那需要先实测自定义模板的后缀命名形态,' +
      ' 未实测的判据不落笔。',
    rel: cfgRel
  })

  const counts: string[] = []
  if (truncSkipped) counts.push(`${truncSkipped} 条预设内的资源引用因文件清单被截断而不判存在性`)
  if (shapeSkipped) counts.push(`${shapeSkipped} 条引用值首尾带空白或以标点收尾,没拿它去比清单`)
  if (counts.length) {
    const note = `本次未判定:${counts.join(';')}。`
    for (const f of out) f.detail += ` ${note}`
  }

  return out
}
