// `.import`(Godot 写在资源旁边的导入元数据边车)的**类型化读数层**。设计见 docs/tools-page-plan.md
// §3.1 #8,台账 Ruling B2。
//
// 为什么只是一层薄读数、而不是第二个 INI 解析器:`.import` 与 project.godot 用的是同一套 INI 方言
// (段头 `[…]`、`key="value"`、`;` 注释、`{}`/`[]` 多行块),B2 已经把这套规则连同它的边界
// (重复键取末条、裸值原样返回、配平吃整块、引号不配对就丢)一次实现完,并在 godotIni.test.mjs 钉住。
// 这里再写一遍,就会在 B8 那天长出两套「同一个文件读成两个样子」的规则(台账 Ruling B2 点名的分叉)。
// 于是本文件只回答两件事:**`.import` 的哪几个键是什么**(readImportFile,取值一律走 getIni / getIniList),
// 以及**引擎里哪些导入器名能逐条举证**(KNOWN_IMPORTERS,域数据不是判定 —— 见它自己的注释)。
//
// 键位照编辑器真实写出的形态核对过(Godot 4.x):
//   · `[remap]` 段:`importer` / `type` / `uid`。同一段里还有 `path`、`validated`、`metadata={…}`,
//     但判据 5 明写不判它们,所以**不进本层的返回值** —— 类型里没有的字段,调用方就顺手判不了。
//   · `[deps]` 段:`source_file`(spec §3.1 #8 说的「`.import` 指向的源文件」就在这里)、
//     `dest_files`(照原样读成列表;判据 5 不判它的对错,读出来只是别把形状猜错)。
//   · `[params]` 段(#16 纹理审计起开放三键,仍是「点名列出,不做通用字典」):
//     `compress/mode`(0=无损 1=有损 2=VRAM)、`mipmaps/generate`、`detect_3d/compress_to`
//     (检测到 3D 用途后引擎自动改写导入参数的开关;0 = 用户显式关掉了自动转压)。
//     键名按编辑器真实写出的形态核对(Godot 4.x texture 导入器)。**只抽这三键**:
//     params 里还有几十个键(lossy_quality、roughness、process/*…),来一个键加一个字段的
//     「通用 params 字典」会让本层长成第二个判定面;没有列入的字段照旧不进返回值,
//     调用方就顺手判不了 —— 与上面 [remap] 不读 path/validated 是同一条纪律。
//   · 顶层:`generator="organically.godot.texture"` 是 Godot 3 老形态的唯一痕迹,那种文件没有
//     `[remap]` 也没有 `[deps]`,即压根没有 source_file —— 所以 legacy 单独标出来给调用方当闸门。
//
// 缺失就是 undefined:不补 `res://` 占位、不把裸串猜成列表、不给 `validated` 兜默认值。
// 红线:纯函数,不碰 window / services / vue / DOM;输入是调用方读到的文本(本层不做 IO)。
import { getIni, getIniBool, getIniInt, getIniList, parseGodotIni } from './godotIni'
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
  /**
   * `[params] compress/mode`(getIniInt:裸整数才解析)。0=无损 1=有损 2=VRAM 压缩。
   * **缺失就是 undefined**:不把「没写」猜成引擎默认 0 —— 手写/老版本的边车可能真没有这段,
   * 拿 undefined 当 0 判,检查器就会对读不到参数的文件说「它开了无损」。
   */
  compressMode?: number
  /** `[params] mipmaps/generate`(getIniBool:只有裸 true/false 算)。缺失同样是 undefined,不猜默认 */
  mipmapsGenerate?: boolean
  /**
   * `[params] detect_3d/compress_to`(getIniInt)。非 0 = 引擎检测到纹理被 3D 用途引用后
   * 会**自动改写** compress/mode 与 mipmaps 并重导入;0 = 用户显式关掉了这条自动链路,
   * 参数从此只听手改的。
   */
  detect3dCompressTo?: number
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
    compressMode: getIniInt(doc, 'params/compress/mode'),
    mipmapsGenerate: getIniBool(doc, 'params/mipmaps/generate'),
    detect3dCompressTo: getIniInt(doc, 'params/detect_3d/compress_to'),
    generator,
    // 空串(`generator=""`)不算「写了 generator」:那是个没有值的键,不是 Godot 3 的形态证据
    legacy: typeof generator === 'string' && generator !== '' && !hasRemap(doc)
  }
}

/** 一行表:导入器名 + 它自己在引擎源码里声明认领的扩展名(全小写、无点) */
export interface KnownImporter {
  name: string
  exts: string[]
}

/**
 * 引擎里**能逐条举证**的那批导入器:名字 → 那个导入器自己声明的 recognized_extensions。
 *
 * 为什么这张表住在读数层而不是检查器里(B6 评审 Minor 4):它是「`.import` 这个域里的事实」,
 * 不是一条判定。判据住在 `inspectors/imports.ts`;下一轮做 addons 体检的 B7 也要用同一批名字,
 * 各留一份就是 B6 刚替 `SCENE_EXT` 收掉的那种分叉。
 *
 * 出处逐行读自 godotengine/godot 标签 `4.4-stable`
 * (`https://github.com/godotengine/godot/blob/4.4-stable/<路径>`):
 *   · `editor/import/resource_importer_wav.cpp:36` 名 / `:43-45` 名单 —— `push_back("wav")`
 *   · `modules/vorbis/resource_importer_ogg_vorbis.cpp:44` / `:51-53` —— `ogg`
 *   · `editor/import/resource_importer_bmfont.cpp:37` / `:44-48` —— `font`、`fnt`
 *   · `editor/import/resource_importer_dynamic_font.cpp:40` / `:47-58` —— `ttf ttc otf otc woff woff2 pfb pfm`
 *   · `editor/import/resource_importer_csv_translation.cpp:39` / `:46-48` —— `csv`
 *   · `editor/import/resource_importer_shader_file.cpp:40` / `:47-49` —— `glsl`
 *   · `editor/import/3d/resource_importer_obj.cpp:593` / `:600-602` —— `obj`
 * 只有这七行进表:它们的名单是**各自文件里写死的 `push_back`**,能逐条举证。
 * 故意不进表(= 表外,调用方一律「不知道,不判」):
 *   · texture(`editor/import/resource_importer_texture.cpp:171` 名 / `:178-180` 名单)、
 *     bitmap(`:39` / `:46-48`)、texture_atlas(`:46` / `:53-55`)、
 *     cubemap_texture(`resource_importer_layered_texture.cpp:43-45` 名随模式变 / `:80-82`)、
 *     font_data_image(`:37` / `:44-48`)—— 这五份的名单是 `ImageLoader::get_recognized_extensions(…)`,
 *     而它把**已注册的图像格式 loader** 的名单并起来(`core/io/image_loader.cpp:111-115`):
 *     png/jpg/webp 由构建时开了哪些模块决定。抄一份「png 一定是 texture」的表就是凭印象猜。
 *   · 模块自带的其余名字(glb/gltf、svg、mp3…)本轮没有逐个取证,同样按表外处理。
 * 所以「表外」不等于「引擎里没有」,只等于「这一行我给不出出处」—— 调用方按这个读。
 */
export const KNOWN_IMPORTERS: KnownImporter[] = [
  { name: 'wav', exts: ['wav'] },
  { name: 'oggvorbisstr', exts: ['ogg'] },
  { name: 'font_data_bmfont', exts: ['font', 'fnt'] },
  { name: 'font_data_dynamic', exts: ['ttf', 'ttc', 'otf', 'otc', 'woff', 'woff2', 'pfb', 'pfm'] },
  { name: 'csv_translation', exts: ['csv'] },
  { name: 'glsl', exts: ['glsl'] },
  { name: 'wavefront_obj', exts: ['obj'] }
]
