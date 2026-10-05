// P2 工具 #16(前半):纹理导入审计(spec §3.3 #16;立项与「拆两半」的决定见 docs/未完成.md)。
//
// 第一批只报一条有把握的判据:**大体积的源纹理仍以无损导入且未开 mipmap**。
// 它的每一样证据都来自已写下的值 —— 源文件字节数来自清单的 size,压缩/米帕米来自
// `.import` 边车 `[params]` 段(importFile.ts 本轮新抽的三键),不做任何「引擎默认值」式的猜测:
// 缺键的边车一律不判(少报方向安全)。「3D 项目未开 VRAM 压缩」「大纹理尺寸非 2 的幂」
// 都要引擎侧事实(项目 2D/3D 类型 / 图像像素头)才能立,归后半,不阻塞本批。
//
// 为什么判据里必须自首「纯 2D 可忽略」:本工具拿不到项目的 2D/3D 用途。无损+无 mipmap
// 对 UI/精灵是完全正当的组合,对 3D 场景则同时浪费显存(未压缩)与远处闪烁(无米帕米)。
// 结论措辞把两种读法都说清,让用户按自己项目的用途定夺 —— 比替他猜用途更诚实。
//
// 候选只认 `importer` 为 `texture` / `bitmap` 的边车(资源导入器名,出处见 importFile.ts
// KNOWN_IMPORTERS 的注释:texture.cpp:171 / bitmap.cpp:39)。cubemap 等分层纹理的导入器名
// 随模式变,svg/字体位图等没逐个取证 —— 全部不判,第一批宁窄勿滥。
//
// 截断时**照常判**另出覆盖面警示(secrets 同款):截断只会让「大纹理」整份漏掉(少报),
// 不会把小文件误报成大文件;静默少报反而会被读成「这张卡查过、没问题」。
//
// 修复动作:无。改导入参数要在编辑器里重导入(改 .import 的 params 而不触发重导入,
// 引擎会在下次打开时按旧产物继续用 —— 结论「改好了」是假的)。
//
// 红线:纯函数,只吃 ToolContext —— 不碰 window / services / vue / DOM。
import type { Finding, ToolContext } from '../types'
import { LIST_CAP, truncatedFinding } from '../finding'
import { readImportFile } from '../parsers/importFile'
import { fmtBytes, isGdignored, gdignoredDirs, sourceFiles, byText } from '../treeUtils'

/** 「大纹理」的体积闸(源文件字节数,4 MiB)。待确认 #24 同类:默认值是拍的,宁可报出来让人忽略 */
export const BIG_TEXTURE_BYTES = 4 * 1024 * 1024

/** 第一批认得的两类图像导入器(出处见 importFile.ts KNOWN_IMPORTERS 的注释) */
const IMAGE_IMPORTERS = new Set(['texture', 'bitmap'])

export async function run(ctx: ToolContext): Promise<Finding[]> {
  const out: Finding[] = []
  if (ctx.truncated) {
    out.push(truncatedFinding(
      'textures',
      '清单被截断时本卡照常报已发现的,但没列出的文件没参与统计 —— ' +
        '「没有报出大纹理」不等于「没有大纹理」,请完整重扫后再当结论用。'
    ))
  }

  const dirs = gdignoredDirs(ctx.tree)
  // 源文件按小写 rel 建表:Windows 上 `Art/A.PNG` 与边车写的 `art/a.png` 是同一个文件,
  // 查不到体积就少判一条(方向安全),不按大小写异体重复报。
  const sizeByLower = new Map<string, number>()
  for (const f of sourceFiles(ctx.tree)) sizeByLower.set(f.rel.toLowerCase(), f.size)

  const hits: { rel: string; size: number; mode?: number; mip?: boolean; d3d?: number }[] = []
  let unread = 0

  for (const f of ctx.tree) {
    if (!f || typeof f.rel !== 'string' || !f.rel.endsWith('.import')) continue
    if (isGdignored(dirs, f.rel)) continue
    const srcRel = f.rel.slice(0, -'.import'.length)
    // 源文件不在清单 = 失效边车,imports 卡管它;这里没有体积可判,跳过(少报方向安全)
    const size = sizeByLower.get(srcRel.toLowerCase())
    if (size === undefined) continue
    const { text } = await ctx.readText(f.rel)
    if (typeof text !== 'string') { unread++; continue }
    const im = readImportFile(text)
    if (im.legacy) continue // Godot 3 老形态:没有 [params] 可读,第一批不判
    if (!IMAGE_IMPORTERS.has(im.importer || '')) continue
    // 判据只看**写下的值**:mode/mip 任一缺键都不判 —— 「没写」不等于引擎默认值,
    // 猜一个默认再判它,读不到参数的文件就替引擎做了主张。
    if (im.compressMode === undefined || im.mipmapsGenerate === undefined) continue
    if (im.compressMode !== 0 || im.mipmapsGenerate !== false) continue
    if (size < BIG_TEXTURE_BYTES) continue
    hits.push({ rel: srcRel, size, mode: im.compressMode, mip: im.mipmapsGenerate, d3d: im.detect3dCompressTo })
  }

  hits.sort((a, b) => b.size - a.size || byText(a.rel, b.rel))
  for (let i = 0; i < Math.min(hits.length, LIST_CAP); i++) {
    const h = hits[i]
    const d3dText = h.d3d === 0
      ? 'detect_3d/compress_to=0(3D 自动转压已被显式关闭,这张图不会被引擎自动改成压缩)'
      : h.d3d === undefined ? 'detect_3d/compress_to 未写' : `detect_3d/compress_to=${h.d3d}`
    out.push({
      id: `textures:big-lossless:${h.rel}:${i}`,
      severity: 'warn',
      title: `${h.rel}(${fmtBytes(h.size)})仍是无损导入且未开 mipmap`,
      detail: '这么大的图以 compress/mode=0(无损)+ mipmaps/generate=false 进显存:若用于 3D 场景,' +
        '未压缩直接吃显存、远处还会因为没有 mipmap 闪烁,建议在编辑器里改为 VRAM 压缩并勾选 Generate Mipmaps 后重新导入;' +
        `若只用于 2D(UI/精灵),这个组合是正当的,可忽略本条。${d3dText}。`,
      rel: h.rel,
      related: [`${h.rel}.import`]
    })
  }

  const hidden = hits.length - Math.min(hits.length, LIST_CAP)
  if (hidden > 0) {
    out.push({
      id: 'textures:tail',
      severity: 'info',
      title: `另有 ${hidden} 张大纹理未列出`,
      detail: `本次共命中 ${hits.length} 张,按体积降序只列前 ${LIST_CAP} 张(刷屏控制)。`
    })
  }

  if (unread) {
    out.push({
      id: 'textures:skip-count',
      severity: 'info',
      title: `${unread} 个边车读不到,本次审计不完整`,
      detail: `${unread} 个 .import 边车读不到内容(缺失 / 超体积上限 / 被判二进制),` +
        '它们描述的纹理没有参与本次判定 —— 没报出 ≠ 不存在。'
    })
  }

  return out
}
