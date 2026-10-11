// 一次建立、多个工具共享的引用索引(spec §5.2「ctx 一次扫描多工具共享」、§6 风险表)。
// 给 B4(UID 体检)与 B5(未引用资源)用:若各工具自己扫一遍,一个 1 万文件的项目要被
// readText 读两遍 —— 而 readText 是唯一有真实 IO 成本的调用。
//
// 红线同 P0a:**只吃 ToolContext**,不碰 window / services / vue / DOM。纯函数(除 await 读文本)。
//
// ★ B10b 债 7 收口:三条通道抓到的目标一律过 `note()`(判据 9),共享形状闸
// `sceneRefs.resPathShapeOk` 在那里落地 —— phantom(首尾带空白/尾巴带标点归出的那种
// 「路径 + 尾巴」)不再进 `to`,并计进 `shapeSkipped` 由 B5 写进孤儿结论。
//
// 判据的方向由 §6 风险表钉死:孤儿工具会把「没人引用」的东西摆到删除按钮旁边,用户真会删。
// 于是「引用收集」这一侧的方向是**宁多勿少**(判据 4 连注释与死代码里的字符串都算引用);
// 而判据 2/3 排除的两类不是「引用」而是**生成的边车与缓存** —— 它们让每个资产都被自己引用,
// 那条判据错了孤儿检查就永远报不出东西(假阴性比假阳性更难发现,简报 B3 判据 2)。
//
// 与 spec §3.1 #6 原文的冲突已裁定:原文写「收集全部 .gd/.tscn/.tres/.cfg/.import 里的路径」,
// 本轮按判据 2 执行 —— `.import` 一律不算来源(foo.png.import 里就有 source_file="res://foo.png",
// 每个带导入元数据的资产都会被自己「引用」)。回写 spec 由台账记一笔。
//
// 判据 4 的 uid:// 形状(核实自 godotengine/godot 的 core/io/resource_uid.cpp,master 版
// 2026-10-04 用 gh api 取的原文逐行读过,不是凭印象):
//   · 编码表 uuid_characters(:51)= a–y 再补 0–8 —— **没有大写,没有 `-`/`_`**;
//   · :42-45 的注释自陈 char_count / base 两个常量各差 1,所以 'z' 与 '9' 引擎自己永不写出
//     (GH-83843,兼容性原因不修);
//   · 解码端 text_to_id(:92,字符分类在 :102-104)只接受「小写字母」与「数字」两种字符,
//     其余一律 INVALID_ID;id_to_text 对负数给的是 `uid://<invalid>`(:57),那也不是 uid 串;
//   · 长度上限 13(:53 max_uuid_number_length,同注释给的例子 uid://d4n4ub6itg400)。
// 于是正则取 `\buid://[0-9a-z]+`:它是引擎**解码端接受集**(小写字母 + 数字)的精确形状 ——
// 收窄到 a–y/0–8 会把引擎认得的合法输入判成不是 uid,放宽到大写则会把引擎拒掉的串当成引用。
// 同一形状在 addUid 里还有第二道锚定校验(UID_TOKEN):扫描正则与校验各挡一半,
// 变异取证证明「只放宽其中一道」不会改变结果(两道都放宽才会红)。
import type { TreeEntry } from '../types/godot'
import { iniResPaths, parseGodotIni, stringLiterals } from './parsers/godotIni'
import { parseExtResources, resPathShapeOk, resToRel } from './parsers/sceneRefs'
import { hasRelCI, isCache, lowerRelSet } from './treeUtils'

/**
 * `buildRefIndex` 实际用到的通道子集。
 *
 * 原来这里 import 的是 `ToolContext` —— 体检产品层(`types.ts`)的类型。工具箱重做把那一层
 * 整个删掉,而引用图**要留下来**(第 2 批「GDScript 批量重命名」要靠它把改动同步到引用点),
 * 所以改成只声明自己真用到的三件事,不反过来依赖一个已作废的「一次扫描的体检上下文」概念。
 *
 * 真实依赖被 `refIndex.test.mjs` 第 11 节钉着:拿最小 ctx 与五成员 ctx 建出的索引必须是同一套键,
 * 且截断路径在最小 ctx 上同样成立 —— 也就是 `projectId` / `root` / `hash` 从来不是判据的输入。
 * 收窄只动类型标注;那三个成员一个都不能少(`truncated` 少了就把判据 7 改没了)。
 *
 * ⚠ 三条纪律与旧 ToolContext 完全一致,本次收窄**不改变**它们:
 *   · `tree` 与 `readText` 必须同属一个项目 —— 世代闸归调用方(旧 `useTools` 里那套 scanGen 记账),
 *     这里不建第二份账,也不能在这里补:拿到手的 tree 已经晚了。
 *   · `truncated` 为真时**一个文件都不读**(判据 7):清单不全时「查不到引用」不是证据。
 *   · `readText` 给不出 text 就是「读不到」,按 skipped 处理,不抛。
 */
export interface RefScanSource {
  tree: TreeEntry[]
  /** 宿主在 maxEntries 处截断了 tree */
  truncated: boolean
  readText(rel: string): Promise<{ text?: string; skipped?: boolean }>
}

/** 一条引用站点:from(引用者 rel)在什么通道、哪一行提到了目标 */
export interface RefSite {
  from: string
  via: 'ext_resource' | 'literal' | 'ini'
  line?: number
}

export interface RefIndex {
  /** 被引用者 rel → 谁引用它(逐处保留:4 处引用就是 4 条站点,不静默合并) */
  to: Map<string, RefSite[]>
  /** 引用者 rel → 它指出的目标(去重后的 rel)。读过且只读过白名单来源,所以这张表的键 = 来源清单 */
  from: Map<string, string[]>
  /** 引用者 rel → 文中出现的 uid:// 串(去重)。B4 用 */
  uids: Map<string, string[]>
  /** 因是 `.import`/`.uid` 边车而跳过的候选来源数(判据 2) */
  sidecarSkipped: number
  /**
   * ★ B10b 债 7:形状闸挡下、**没有计进 `to`** 的引用条数(判据 9)。
   * 判的是「值的写法」(`res://a.png ` 带尾空格、`res://a.png,` 带尾逗号),不是「目标存不存在」:
   * 这种串归一出来的是「路径 + 尾巴」,结构上对不上清单里任何一个 rel —— 留在 `to` 里
   * 就是一条永远查不到的 phantom(台账债 7 点名的就是它)。**只有清单里确实没有同名条目时才不计入**;
   * 清单里真有那种名字的条目时照旧算引用(收集侧少收一条 = 孤儿工具多报一个可删的文件,方向违令)。
   */
  shapeSkipped: number
  /** 「本该是来源却读不到」:reason 用 ctx 给的原语串,不编造(判据 6) */
  readFailures: { rel: string; reason: string }[]
  /** 被**尝试**读取的来源数(读失败也算扫过,否则 B5 会把「一个都没读」念成「读完了没有引用」) */
  sourcesScanned: number
  /** ctx.truncated || readFailures.length > 0:调用方据此降级措辞 */
  partial: boolean
}

/**
 * 判据 1:来源白名单(只有这些可能是引用来源)。
 * `'godot'` **不在**这张表里,而且不打算加:project.godot 的 ext 就是 'godot'
 * (JS 端 src-ztools/preload/lib/inspectfs.js:263 `path.extname(rel).slice(1).toLowerCase()`;
 * Rust 端 src-tauri/src/inspectfs.rs:83-88 `ext_of` 按 basename 最后一个点切,两端同形),
 * 但「任何叫 x.godot 的文件都是配置」这个推断过头 —— 判据按 rel 全等特判 `project.godot`,
 * 子目录里那份 `sub/project.godot`(多项目仓库)不是本次体检的项目配置。
 */
const SOURCE_EXT = new Set(['tscn', 'tres', 'gd', 'cs', 'gdshader', 'json', 'gdextension'])

/** uid 串的形状,见文件头核实记录 */
const UID_TOKEN = /^uid:\/\/[0-9a-z]+$/
const UID_IN_TEXT = /\buid:\/\/[0-9a-z]+/g

/**
 * 「这个串是不是一个合法 uid」—— 全项目**唯一**一份判据(形状逐条核实见文件头)。
 * 导给 B4(`inspectors/uid.ts`)判 `.uid` 边文与场景头部的所有权声明:同一个规则在第二个文件里
 * 再抄一遍就是 `godotIni.ts` 那份分叉注释点过的风险(改一处、另一处静默留在旧口径)。
 */
export function isUidToken(s: unknown): boolean {
  return typeof s === 'string' && UID_TOKEN.test(s)
}

/** 判据 1:这个条目是不是「可能的引用来源」 */
function isSource(ext: string, rel: string): boolean {
  // 根级 project.godot:判据 1 的最后一项,也是 B2 解析器的唯一入口
  if (rel === 'project.godot') return true
  // cfg 只认**根级**(即 export_presets.cfg:它写有每个预设的 run/main_scene 与脚本路径,
  // 待确认 #4 的一半答案);addons/**/plugin.cfg 这类嵌套 cfg 不算来源。
  if (ext === 'cfg') return !rel.includes('/')
  return SOURCE_EXT.has(ext)
}

/** 判据 2 的边车扩展名:Godot 由资产自己生成的旁路文件 */
function isSidecar(ext: string): boolean {
  return ext === 'import' || ext === 'uid'
}

/**
 * 一次遍历建索引。顺序 = ctx.tree 顺序,文件内顺序 = 出现顺序:
 * B4/B5 的 Finding.id 由这些内容推导,构建顺序抖一次就等于给用户换了一批结论 id。
 */
export async function buildRefIndex(ctx: RefScanSource): Promise<RefIndex> {
  const to = new Map<string, RefSite[]>()
  const from = new Map<string, string[]>()
  const uids = new Map<string, string[]>()
  const readFailures: { rel: string; reason: string }[] = []
  let sidecarSkipped = 0
  let shapeSkipped = 0
  let sourcesScanned = 0

  // 判据 7:清单被截断时**一个文件都不读**,直接给空索引 + partial —— 与 brokenRefs(ts:42-52)
  // 同一口径:清单不全时「查不到引用」不是证据,B5 拿着半份索引会把有主的东西报成孤儿。
  if (ctx.truncated) {
    return { to, from, uids, sidecarSkipped, shapeSkipped, readFailures, sourcesScanned, partial: true }
  }

  const tree = Array.isArray(ctx.tree) ? ctx.tree : []
  // 判据 9(形状闸)要用「清单里真有的名字(任意大小写写法)」当对照集 —— 一次建好,整趟共用。
  // 为什么必须带这个对照集:收集侧的方向纪律与判定侧**相反**,少收一条引用就会让孤儿工具多报一个
  // 可删的文件(§6 风险表)。所以只撤「结构上永远对不上任何条目」的那几种 phantom:
  // 归出来的 rel 在清单里连大小写异体都找不到时才算 phantom,找得到就说明那是个真名字、真引用,照收。
  const inTree = lowerRelSet(tree)
  for (const f of tree) {
    const rel = f && typeof f.rel === 'string' ? f.rel : ''
    if (!rel) continue
    const ext = f && typeof f.ext === 'string' ? f.ext : ''
    // 判据 3:`.godot/` 下的任何文件都不是来源(生成的导入缓存 *.ctex、global_script_class_cache.cfg
    // 里全是 res://,放过它就等于每个资产都有人引用)。与判据 2 **分开判**:cfg 在白名单里,
    // 而 `.godot/.../x.cfg` 同时被两条挡住 —— 先判这条,sidecarSkipped 才不会数重。
    if (isCache(rel)) continue
    if (isSidecar(ext)) {
      // 判据 2:`.import`/`.uid` 一律不算来源。理由必须记住:foo.png.import 里就有
      // source_file="res://foo.png",把它当引用会让**每个有导入元数据的资产都被自己「引用」**,
      // 而带 .import 的纹理/网格正是孤儿工具唯一的猎物 —— 这条判据错了,孤儿检查永远报不出东西。
      sidecarSkipped++
      continue
    }
    if (!isSource(ext, rel)) continue

    sourcesScanned++
    const res = await ctx.readText(rel)
    const text = res && typeof res.text === 'string' ? res.text : undefined
    if (text === undefined) {
      // 判据 6(同 brokenRefs 的三态):readText 给不出 text 就是「读不到」—— 缺文件 / 超
      // maxBytes / 二进制 / 非法路径(见 inspectfs.js:116-125 与 useTools.ts:249-268 的收敛)。
      // 只有白名单来源读不到才记 readFailures:png 本来就不该被读,记了就是把噪声当结论。
      // reason 用 ctx 给的原语串(skipped / error),不编造宿主没说的原因。
      readFailures.push({ rel, reason: res && res.skipped ? 'skipped' : 'error' })
      continue
    }

    // 判据 5:来源提到自己**不计进 to**(add 里丢),也不进 from 的目标清单 ——
    // 否则一个场景永远「被自己引用」,而 .tscn/.tres/.gd 都是孤儿工具的猎物。
    const targets: string[] = []
    const add = (target: string, via: RefSite['via'], line?: number) => {
      if (target === rel) return
      const site: RefSite = { from: rel, via }
      if (typeof line === 'number') site.line = line
      const arr = to.get(target)
      if (arr) arr.push(site)
      else to.set(target, [site])
      if (!targets.includes(target)) targets.push(target)
    }
    const found: string[] = []
    const addUid = (u: string) => {
      if (UID_TOKEN.test(u) && !found.includes(u)) found.push(u)
    }

    /**
     * ★ 判据 9(B10b 债 7):**三条通道唯一的目标入口**,把「取值 → 归一 → 形状闸 → 入账」收在一处。
     *
     * 为什么要收:通道的目标一律是 `resToRel(值)`,而 `resToRel` 不 trim、也不看标点 ——
     * `res://a.png ` / `res://a.png,` 归出来的是 `a.png `(带尾空格)/ `a.png,`。那种串在
     * `to` 里是一条**永远对不上任何树条目的 phantom**:它既保护不了真资源(B5 照旧把它当
     * 「没人引用」),又让索引多一条假目标;同一条值在 ini 体检里(B8)是被拒的,两边不一致
     * 就是台账债 7 点名的那笔。
     *
     * ⚠ 方向与判定侧**相反**,这里不许无条件拒:收集侧少收一条引用 = 孤儿工具多摆一个删除按钮。
     *   于是只有「归出来的 rel 在清单里连大小写异体都找不到」(= 结构上对不上任何条目、
     *   本来就保护不了任何东西)时才撤,并计进 `shapeSkipped`;清单里真有那种名字(如手工建的
     *   `notes)`、带尾空格的文件名)照旧算引用。判定侧(brokenRefs/addons)的同一闸是「只撤主张」,
     *   两侧共用 `sceneRefs.resPathShapeOk` 这一份**形状**判据,判的方向由各自的破坏面决定。
     *   不判的那几条不是静默跳过:`shapeSkipped` 进索引、由 B5 写进孤儿结论的 detail。
     */
    const note = (value: string, via: RefSite['via'], line?: number) => {
      const target = resToRel(value)
      if (target === null) return
      if (!resPathShapeOk(value) && !hasRelCI(inTree, target)) { shapeSkipped++; return }
      add(target, via, line)
    }

    /**
     * 逐行抓引号字面量(判据 4 的 literal 通道,场景与非场景共用一份规则)。
     * **注释与死代码里的字符串也算引用** —— 孤儿工具会把「没人引用」的东西摆到删除按钮旁边,
     * 而注释里的 preload("res://x.tscn") 至少说明人还记得它在用;方向是保守的:
     * 宁可少报孤儿,也不误删。
     * 逐行扫(不整篇扫):GDScript 里一个不配对的引号会把后半篇全吞掉,那样漏的是引用、
     * 报出来的是「孤儿」—— 危险的正是这一侧。
     * skipExtResourceLines:场景的 `[ext_resource path="res://…"]` 已由 parseExtResources 收成
     * via:'ext_resource' 站点,再扫一遍会让每个场景引用**静默翻倍**(B5 数「引用处数」就错了)。
     */
    const addLiteralSites = (rows: string[], skipExtResourceLines: boolean) => {
      for (let i = 0; i < rows.length; i++) {
        if (skipExtResourceLines && rows[i].trim().startsWith('[ext_resource')) continue
        for (const lit of stringLiterals(rows[i])) note(lit, 'literal', i + 1)
      }
    }

    if (ext === 'tscn' || ext === 'tres') {
      // 判据 4 通道一:.tscn/.tres 走 parseExtResources(sceneRefs.ts:38),目标一律过 resToRel(判据 8)
      const refs = parseExtResources(text)
      // parseExtResources 没有把行号带出来(ExtRef 只有 type/uid/path/id)。它扫的就是
      // `[ext_resource` 开头的行(sceneRefs.ts:42 同一个谓词),所以位置能一一对齐;
      // 数量一旦对不上(将来那边漂了),退成「不给行号」而不是猜一个错的行给用户看。
      const heads: number[] = []
      const rows = text.split(/\r?\n/)
      for (let i = 0; i < rows.length; i++) if (rows[i].trim().startsWith('[ext_resource')) heads.push(i + 1)
      const aligned = heads.length === refs.length
      refs.forEach((ref, i) => {
        note(ref.path, 'ext_resource', aligned ? heads[i] : undefined)
        addUid(ref.uid)
      })
      // 判据 4 通道四:场景里**非 ext_resource 行**的字符串属性同样是引用。只给场景 ext_resource
      // 一条通道时,`[node]` 段的 `dialogue = "res://data/keep.json"` 与 `Resource("res://…")`
      // 全都看不见 —— 而被按需加载的 json/tres 恰恰是孤儿工具最容易端上删除按钮的东西(§6:
      // 一句提及即引用,收集侧宁多勿少)。
      addLiteralSites(rows, true)
    } else if (rel === 'project.godot') {
      // 判据 4 通道二:project.godot 交给 B2 的解析器,autoload 的 `*` 前缀已由它剥掉
      for (const p of iniResPaths(parseGodotIni(text))) note(p.path, 'ini', p.line)
    } else {
      // 判据 4 通道三:其余白名单文件(.gd/.cs/.gdshader/.json/.gdextension/根级 cfg)
      addLiteralSites(text.split(/\r?\n/), false)
    }

    // 判据 4 尾巴:uid:// 串在白名单文件的**原文**里也要收(B4 拿它比对 .uid 边文与资源内 uid=;
    // 上面 uid="…" 属性通道与这里的正文通道会给出同一个串,addUid 按来源去重)。
    for (const m of text.match(UID_IN_TEXT) || []) addUid(m)

    from.set(rel, targets)
    if (found.length) uids.set(rel, found)
  }

  return {
    to,
    from,
    uids,
    sidecarSkipped,
    shapeSkipped,
    readFailures,
    sourcesScanned,
    partial: readFailures.length > 0
  }
}
