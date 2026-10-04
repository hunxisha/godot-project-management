// `.import`(Godot 写在资源旁边的导入元数据边车)的**类型化读数层**。设计见 docs/tools-page-plan.md
// §3.1 #8,台账 Ruling B2。
//
// 为什么只是一层薄读数、而不是第二个 INI 解析器:`.import` 与 project.godot 用的是同一套 INI 方言
// (段头 `[…]`、`key="value"`、`;` 注释、`{}`/`[]` 多行块),B2 已经把这套规则连同它的边界
// (重复键取末条、裸值原样返回、配平吃整块、引号不配对就丢)一次实现完,并在 godotIni.test.mjs 钉住。
// 这里再写一遍,就会在 B8 那天长出两套「同一个文件读成两个样子」的规则(台账 Ruling B2 点名的分叉)。
// 于是本文件只回答一件事:**`.import` 的哪几个键是什么**,取值一律走 getIni / getIniList。
//
// 键位照编辑器真实写出的形态核对过(Godot 4.x):
//   · `[remap]` 段:`importer` / `type` / `uid`。同一段里还有 `path`、`validated`、`metadata={…}`,
//     但判据 5 明写不判它们,所以**不进本层的返回值** —— 类型里没有的字段,调用方就顺手判不了。
//   · `[deps]` 段:`source_file`(spec §3.1 #8 说的「`.import` 指向的源文件」就在这里)、
//     `dest_files`(照原样读成列表;判据 5 不判它的对错,读出来只是别把形状猜错)。
//   · 顶层:`generator="organically.godot.texture"` 是 Godot 3 老形态的唯一痕迹,那种文件没有
//     `[remap]` 也没有 `[deps]`,即压根没有 source_file —— 所以 legacy 单独标出来给调用方当闸门。
//
// 缺失就是 undefined:不补 `res://` 占位、不把裸串猜成列表、不给 `validated` 兜默认值。
// 红线:纯函数,不碰 window / services / vue / DOM;输入是调用方读到的文本(本层不做 IO)。
import { getIni, getIniList, parseGodotIni } from './godotIni'
import type { IniDoc } from './godotIni'

/** 一份 `.import` 里本工具关心的全部字段(其余键留在 IniDoc 里,判据 5 决定不读) */
export interface ImportFile {
  /** `[remap] importer`(导入器名,不是可见名:texture / wav / oggvorbisstr / …) */
  importer?: string
  /** `[remap] type`(产出的资源类型,如 CompressedTexture2D) */
  type?: string
  /** `[remap] uid`(这份资源自己的 uid;与场景引用的比对归 B4,本层只负责读数) */
  uid?: string
  /** `[deps] source_file`(原样,带 `res://` 前缀;归一成 rel 是调用方的事 —— 走 sceneRefs.resToRel) */
  sourceFile?: string
  /** `[deps] dest_files`(只认 B2 认识的两种列表形态;别的形态给 undefined,不猜) */
  destFiles?: string[]
  /** 顶层 `generator`(Godot 3 老形态才有的键) */
  generator?: string
  /** 没有 `[remap]` 段却写了非空 `generator` —— 即 Godot 3 的老形态 */
  legacy: boolean
}

/**
 * 有没有 `[remap]` 这一段:B2 的 values 只收键值行,所以「段里出现过任何键」就是这段存在过的证据。
 * 只写了空头 `[remap]` 而里面一个键都没有的文件会被当成没有 remap —— 那种文件本来也没有 4.x 的
 * 导入信息,配合 generator 判成 legacy 正是想要的方向(legacy 只会让调用方**少判**,不会多判)。
 */
function hasRemap(doc: IniDoc): boolean {
  if (!doc || !Array.isArray(doc.values)) return false
  return doc.values.some((v) => v && v.section === 'remap')
}

/**
 * 读一份 `.import`。非字符串 / 空 / 半截文件都不抛错(parseGodotIni 对这三种都收成空文档),
 * 返回值永远是 `legacy` 为布尔的对象。
 */
export function readImportFile(text: string): ImportFile {
  const doc = parseGodotIni(text)
  const generator = getIni(doc, 'generator')
  return {
    importer: getIni(doc, 'remap/importer'),
    type: getIni(doc, 'remap/type'),
    uid: getIni(doc, 'remap/uid'),
    sourceFile: getIni(doc, 'deps/source_file'),
    destFiles: getIniList(doc, 'deps/dest_files'),
    generator,
    // 空串(`generator=""`)不算「写了 generator」:那是个没有值的键,不是 Godot 3 的形态证据
    legacy: typeof generator === 'string' && generator !== '' && !hasRemap(doc)
  }
}
