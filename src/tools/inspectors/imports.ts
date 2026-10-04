// P0 工具 #8：`.import` 一致性体检（spec §3.1 #8、§5.3 修复四条硬规则、§6 风险表、简报判据 1-5；
// 量词读法与排除口径跟台账 B4/B5 已裁定的两份保持一致）。
//
// 三条判据的破坏面不一样，先说清哪一条能动用户的盘：
//   · 判据 2 失效 `.import`（`[deps] source_file` 指向的资源不在清单里）= warn + **聚合 trash 修复** ——
//     这是本文件唯一把「删除」摆到用户文件旁边的地方，于是它所有闸门都朝「少报」的方向收（spec §6
//     那句失败模式很直白：用户真会删）。删错的代价不是少一个文件：编辑器下次重扫会把那个资源当新资源
//     重新导入，哈希变、`.import` 里的 uid 换，引用它的场景跟着变（简报判据 2 点名的破坏面）。
//   · 判据 3 资源存在但没有 `.import` = warn，**不带 fix**（简报明写）。
//   · 判据 4 导入器名与扩展名对不上 = warn，不带 fix，而且只在两侧都能举证时才开口（见下表）。
// 判据 5 明写不判的东西（`path=`/`dest_files` 指向的产物对不对、`validated` 的值、`[params]` 里任何
// 导入选项、边车内容与源文件是否「同步」、`uid` 与场景引用是否一致）一律不碰：那是编辑器与 B4/B8 的
// 职责，越界判就是在凭空造误报。
//
// 存在性一律用 lowerRelSet(ctx.tree) + hasRelCI() 查表（treeUtils 里那份共享的小写像，B6 评审裁定 2），
// 不做字符串包含（brokenRefs.ts:11-13 的同一口径）。
// `ctx.truncated` 的降级口径（控制方 2026-10-05 裁定 3，覆盖简报判据 2 那句字面的「一条都不判」）：
//   截断作废的是**存在性主张**（stale / missing / 项目闸门三条），因为它们的证据是「整份清单里查不到」；
//   **内容派生**的判据 4 不依赖清单完整性（证据是一份读得到的边车自己的 `[remap] importer` 对它自己的文件名），
//   而且它不带 fix，所以照常判 —— 与 uid.ts 保留「重复 uid」同一读法。降级卡仍然排第一。
// 与 orphans 不同的是：这里读不到一份边车只让**那一份**的判定失效，不出整工具的降级结论 ——
// 本文件每条结论的证据都是「这一份读得到的文件自己写了什么」，不是「整份索引里查不到」。
//
// 成本红线：`.import` 边车是本文件唯一的读入面（每个候选一次 ctx.readText）。**不调 buildRefIndex**
// —— 引用面是 B5 的猎物，这里一行都不需要；调了就会为几千个 .gd/.tscn 白读一遍。
//
// 措辞红线（同 uid.ts:19-22、orphans.ts:31-34）：聚合结论只挂 `fix:{kind:'trash', label, payload:{rels}}`。
// 动词（「移入回收站」/「永久删除」）、风险句、预览清单全部由 fixPlan.ts 给（按 isWin 与 kind 分叉，
// fixPlan.ts:240）；label 只给数量与中性动词「移除」，简报钉的那句措辞照用。
// 结论顺序是定死的类别序（聚合 stale → 逐条不匹配 → 逐条缺边车 → 项目闸门），类内按 rel 码元序。
//
// 红线：纯函数，只吃 ToolContext —— 不碰 window / services / vue / DOM；唯一 IO 是 await ctx.readText。
import type { Finding, ToolContext } from '../types'
import { truncatedFinding } from '../finding'
import { KNOWN_IMPORTERS, readImportFile } from '../parsers/importFile'
import { resToRel } from '../parsers/sceneRefs'
import { dirOf, gdignoredDirs, hasRelCI, isCache, isGdignored, lowerRelSet } from '../treeUtils'

/** 边车尾缀：切「这份边车属于哪个资源」一律用它，不按最后一个点重拼（`X.a.b.import` 的源是 `X.a.b`） */
const IMPORT_SUFFIX = '.import'

/** 聚合结论的展示上限：与 uid.ts:35 / orphans.ts:43 同口径（刷屏控制，不影响 payload.rels 全量） */
const LIST_CAP = 20

/** 默认排除与「不判」的逐类计数，全部写进聚合结论的 detail（B5 立下的口径：排除要看得见） */
interface Excl {
  cache: number
  addons: number
  legacy: number
  unread: number
  noSource: number
  cacheSrc: number
  /** 判据 3 的候选里被 `.gdignore` 屏蔽掉的那些（引擎按设计不扫这些目录，见 gdignoredDirs） */
  ignore: number
}

/**
 * 判据 3/4 唯一的依据表在 `parsers/importFile.ts` 的 KNOWN_IMPORTERS（域数据不住在判定里，B6 评审 Minor 4：
 * B7 的 addons 体检要用同一批名字，两处各留一份就是本轮刚替 SCENE_EXT 收掉的那种分叉）。
 * 出处、以及「为什么 texture/bitmap/glb/svg 全都在表外」都写在那张表的注释里，这里只做判定用的两份投影：
 *   · IMPORTER_BY_NAME —— 判据 4 拿边车里的 importer 名查它自己声明的扩展名名单；
 *   · TABLE_EXT —— 判据 3 的候选面（表外扩展名永不报「缺 .import」）与判据 4 的扩展名侧闸门。
 * 收窄的方向与整个文件一致：宁少报，绝不多报。
 */
const IMPORTER_BY_NAME = new Map(KNOWN_IMPORTERS.map((r) => [r.name, r]))

const TABLE_EXT = new Set(KNOWN_IMPORTERS.flatMap((r) => r.exts))

const TABLE_EXT_TEXT = [...TABLE_EXT].sort(byText).join('/')

/** 每条结论都要自带的覆盖面声明（收窄是判据，不是省略） */
const COVERAGE = ' 本判定的扩展名清单逐项取自引擎各导入器自己声明的 recognized_extensions' +
  `（逐行的出处写在 parsers/importFile.ts 的 KNOWN_IMPORTERS 注释里），表内只有 ${TABLE_EXT_TEXT}；` +
  '表外的其余导入器（含 png/jpg/webp 等图像类，以及本轮未逐个取证的 glb/gltf/svg）一律不判。'

const WHY_TRUNC = '失效 .import（source_file 指向的资源不在清单里）与缺 .import 两条都拿整份清单比存在性，' +
  '清单不全时「查不到」不是证据 —— 它会把其实还在用的边车送上删除按钮，所以这两条本次不做，' +
  '项目级「一个边车都没有」那条闸门也一起不按字面断言。导入器与扩展名那条只看一份边车自己写了什么、' +
  '与它自己的文件名比，清单全不全都不影响它，也不提供任何修复动作，所以本次照常判（与 uid 体检保留' +
  '「重复 uid」同一读法）。请把 maxEntries 调高或做一次完整重扫后再看' +
  ' —— 别用排除目录、按扩展名筛选来「缩小范围」：那样得到的清单同样不完整，却不会再带截断标记，结论只会更假。'

const TRUNC_TITLE = '文件清单被截断，本次不做失效与缺 .import 判定（导入器不匹配那条照常）'

/**
 * 字典序一律用 `<`/`>`（UTF-16 码元），不用 localeCompare：locale 随宿主环境变，而 rels 顺序、related
 * 与 id 要跨机器逐字节一致（同 uid.ts:44-50、orphans.ts:45-51）。
 */
function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * 顶层或任一段叫 addons 的条目 —— addons/ 内部整体不判（与 orphans.ts:54-56 同口径：排除并计数）。
 * ⚠ 别把这条读成「addons 有人管」：spec §3.1 #7 那份 addons 体检的清单只有 plugin.cfg 字段、
 * editor_plugins 启用状态与目录是否对得上、重名三条，**不含 `.import` 失效与缺边车**（docs/tools-page-plan.md:117）。
 * 也就是说 P0b 里 addons 下的失效边车**没人判**，这是已知覆盖面缺口，不是已交给他处的判定 ——
 * 控制方 2026-10-05 裁定 4：本轮把这个事实写进注释（B7 立项时按「addons 下的 .import 判不判」显式拍板）。
 */
function isAddon(rel: string): boolean {
  return rel.split('/').includes('addons')
}

/**
 * 边车身份：原语给的 `ext === 'import'`（`foo.png.import` 的 ext 就是 'import'，不是 'png'）。
 * 再要 rel 确实以 `.import` 收尾（大小写都收）：两端原语的 ext 本来就是从 rel 的最后一个点算出来并小写的
 * （`refIndex.ts:59-63` 记的 inspectfs.js:263 / inspectfs.rs:83-88），自洽的 rel 一定满足这条，
 * 所以它纯粹是防御 —— 不满足时切出来的 assetRel 就是猜的名字，拿它比存在性会造出假 stale。
 *
 * ⚠ 大小写口径（B6 评审裁定 2 里钉死的那个不对称，另一侧的注释在 uid.ts:152-158）：
 *   · 「**这份边车在不在**」→ 走小写像 hasRelCI()，任意大小写写法都算在（Windows 不敏感；这一侧只会藏主张）。
 *   · 「**这个条目算不算边车**」→ 这里的 endsWith 用大小写不敏感，而 uid.ts 的 `.uid` 那侧保持精确。
 *     两边答案不同是刻意的：判据 4 与 sidecarTotal 都吃这条，放宽它会把 `X.PNG.IMPORT` 这类手改名字
 *     当成边车**读进来**（多出结论），而收紧 uid 那侧只会少读边车（少出结论）。
 *     本轮的改动方向被钉死为「只藏不加」，所以 uid 那侧不动，这里也不动。
 */
function isSidecar(ext: unknown, rel: string): boolean {
  return ext === 'import' && rel.toLowerCase().endsWith(IMPORT_SUFFIX)
}

/**
 * rel 的扩展名（小写、无点），与原语两端同形（JS：`src-ztools/preload/lib/inspectfs.js:263`
 * 的 `path.extname(rel).slice(1).toLowerCase()`；Rust：`src-tauri/src/inspectfs.rs:83-88` 按 basename
 * 最后一个点切 —— 两端记录见 refIndex.ts:59-63）。
 * 只用来算**边车名背后那个资源**与**source_file**的扩展名：那两个路径在清单里时没有 TreeEntry.ext 可用
 * （源已被删掉/边车被改名）。清单里的条目一律用 f.ext，不在这里另起第二套口径。
 */
function extOf(rel: string): string {
  const base = rel.slice(rel.lastIndexOf('/') + 1)
  const i = base.lastIndexOf('.')
  return i > 0 ? base.slice(i + 1).toLowerCase() : ''
}

/** 判据 2：聚合出一条可执行的失效边车清单（与 orphans:all / uid:orphan:all 同一形状） */
function staleFinding(stale: { rel: string; src: string }[], ex: Excl): Finding {
  const rels = stale.map((s) => s.rel).sort(byText)
  const n = rels.length
  const srcOf = new Map(stale.map((s): [string, string] => [s.rel, s.src]))
  const shown = rels.slice(0, LIST_CAP)
  const hidden = n - shown.length
  // 展示行带上「它说自己指向谁」，用户能一眼核对是哪个源没了；related 仍是干净 rel（卡片跳转用）
  const shownTxt = shown.map((r) => `${r}（源 ${srcOf.get(r)}）`).join('、')
  return {
    id: 'imports:stale:all',
    severity: 'warn',
    title: `失效 .import 边车 ${n} 个：[deps] source_file 指向的资源已不在文件清单里`,
    detail: `${shownTxt}${hidden ? ' 等' : ''} —— 这些 .import 记录的 source_file 在本次文件清单里查不到，` +
      `多半是删掉或改名源文件后留下的残留边车。` +
      (hidden ? ` 这里按 rel 只列前 ${shown.length} 个，另有 ${hidden} 个未列出；下面的建议仍按全部 ${n} 个执行。` : '') +
      ` 大小写异体不判：source_file 只要有任意一种大小写写法能在清单里对上，就当作源还在（Windows 文件系统不敏感）。` +
      // 评审 Minor 3：这条聚合是全场唯一可执行的卡片，覆盖面必须和排除项一起说清 ——
      // 失效判定不看扩展名（任何一份能读到的边车都判），缺边车判定却只认表内扩展名，两者的面不一样。
      ` 覆盖面：这条按边车内容判，不看资源的扩展名（任何扩展名的失效边车都会进这份清单）；` +
      `而「资源缺 .import 边车」那条只认表内逐项举证的扩展名（清单抄在每条缺失结论的覆盖面声明里），两边范围不同。` +
      ` 默认排除、不判定的：.godot 缓存 ${ex.cache} 项、addons ${ex.addons} 项、Godot 3 老形态 ${ex.legacy} 项、` +
      `读不到 ${ex.unread} 项、source_file 缺失或不是项目内路径 ${ex.noSource} 项、` +
      `source_file 指向 .godot 缓存 ${ex.cacheSrc} 项、.gdignore 目录内的候选资源 ${ex.ignore} 项。` +
      // spec §6 的失败模式说明：这条是全场唯一会动盘的结论，把不可逆的那一半讲清楚。
      // uid 的说法不钉引擎版本：uid 就写在边车自己的 [remap] 里（importFile.ts 的键位说明），
      // 边车没了那份记录也就没了 —— 简报判据 2 点名的正是这条代价。
      ` 边车没了不会动到源资源本身；但那个源日后要是回来了（从版本库恢复、拷回原处），编辑器会把它当新资源` +
      `重新导入，导入产物与 uid 都会重来 —— 用 uid 引用它的场景可能就此丢链接。要保住旧 uid 就别删边车，` +
      `把源放回原位让编辑器重扫。`,
    rel: rels[0],
    related: shown,
    // 只有 kind/label/payload：动词、风险句、预览清单都是 fixPlan.ts 的活（见文件头措辞红线）。
    // payload.rels 全量：planFix 的预览 items 由它生成（fixPlan.ts:238-251），展示裁切裁不到确认框（§5.3 规则 3）。
    fix: { kind: 'trash', label: `移除 ${n} 个失效 .import`, payload: { rels } }
  }
}

/** 判据 4：导入器名与扩展名对不上 —— 只报告（简报明写不带 fix） */
function mismatchFinding(m: { rel: string; importer: string; ext: string; exts: string[] }): Finding {
  return {
    id: `imports:mismatch:${m.rel}`,
    severity: 'warn',
    title: `导入器与扩展名对不上：${m.rel}`,
    detail: `${m.rel} 的 [remap] importer 写的是 "${m.importer}"，而这个导入器在引擎源码里只声明认领这些扩展名：` +
      `${m.exts.join(' / ')}；这份边车对应的资源扩展名是 .${m.ext}。` +
      ` 对不上通常是边车被手改过、资源换了扩展名、或连边车一起从别处拷来。` +
      ` 本判定只比对两侧都能逐条举证的名字：表外的 importer 名与表外的扩展名一律不判（自定义导入插件重名时` +
      `也可能被这条点名，那就在编辑器里看一眼该资源的导入页再决定）。${COVERAGE}` +
      ` 不确定就让编辑器把这个资源重新导入一次，边车会与资源重新对上；这条不提供自动修复动作。`,
    rel: m.rel
  }
}

/**
 * 判据 3：资源存在但没有 `.import` 边车（目录闸门成立才报，一条讲一个文件）。
 * `ignored` 是本次被 `.gdignore` 屏蔽掉的候选数 —— 藏起来的主张要在结论里看得见（B5 口径）。
 */
function missingFinding(m: { rel: string; ext: string; siblings: string[] }, ignored: number): Finding {
  const dir = dirOf(m.rel) || '（项目根）'
  const why = ` 这类缺口通常来自绕过编辑器的拷贝或改名：让编辑器重新扫描一次通常会补上边车` +
    `（别复制别人的 .import 内容，那会把 uid 与导入参数一起搬错）。${COVERAGE}` +
    (ignored ? ` 本次另有 ${ignored} 个同类资源位于 .gdignore 屏蔽的目录里，引擎按设计不扫那些目录，一条都没判。` : '')
  return {
    id: `imports:missing:${m.rel}`,
    severity: 'warn',
    title: `资源没有 .import 边车：${m.rel}`,
    detail: m.siblings.length
      ? `同目录 ${dir} 里其他 ${m.siblings.length} 个 .${m.ext} 资源都有 .import 边车` +
        `（${m.siblings.slice(0, 3).join('、')}${m.siblings.length > 3 ? ' 等' : ''}），只有 ${m.rel} 没有。${why}`
      : // 评审 Minor 1：「项目里有边车」是**项目级**证据，撑不起「**它**被编辑器扫过」这个单文件结论，
        // 所以这句按证据的实际强度说话：项目侧导入流程是通的，而眼前这份更常见的原因是拷贝/改名绕开编辑器，
        // 或者它压根还没被扫到过一次。
        `${m.rel} 是 ${dir} 里唯一的 .${m.ext} 资源，没有同级可比对；项目里别处存在 .import 边车，` +
        `说明这个项目的编辑器导入流程是通的，而这一份没有边车 —— 通常来自绕过编辑器的拷贝或改名，` +
        `或者这个文件还没被编辑器扫到过一次。${why}`,
    rel: m.rel
  }
}

/** 项目闸门：一个边车都没有时只发一条 info，缺失判定整条不做（与 uid:gate:no-uid 同形） */
function gateFinding(): Finding {
  return {
    id: 'imports:gate:no-import',
    severity: 'info',
    title: '本项目没有 .import 边车，本次不做「缺 .import」判定',
    detail: `.import 是编辑器扫描资源后写下的导入元数据。整个项目（不含 .godot 缓存）一个都没有，` +
      `通常说明这个项目没有需要导入的资源、只在运行时自行加载，或从未在编辑器里打开/扫描过 —— ` +
      `这几种情况下「缺 .import」不是问题，一条都不报。失效边车与导入器不匹配两条判定以边车自身为证据，` +
      `没有边车时它们本来也无从判起。${COVERAGE}`
  }
}

export async function run(ctx: ToolContext): Promise<Finding[]> {
  const tree = Array.isArray(ctx.tree) ? ctx.tree : []
  // 降级态照常做判据 4（内容派生），关掉判据 2/3 与项目闸门（存在性派生）—— 见文件头的裁定 3 说明。
  const truncated = ctx.truncated === true

  const lower = lowerRelSet(tree)
  // `.gdignore` 屏蔽的目录（一次收集，整条判据 3 的候选面都按它过滤）：引擎根本不扫这些目录，
  // 于是「让编辑器重新扫描一次就会补上边车」这句建议在里头永远做不到 —— 那条 warn 没有闸门证据。
  const ignoredDirs = gdignoredDirs(tree)
  // 项目闸门的分母照 uid.ts 的 sidecarCount 口径：只排 .godot 生成物，addons 下的边车照样算
  // 「这个项目写过导入元数据」的证据（B4 已裁的读法，两份工具不各自发明一遍）。
  let sidecarTotal = 0
  for (const f of tree) {
    const rel = f && typeof f.rel === 'string' ? f.rel : ''
    if (!rel) continue
    if (isSidecar(f && f.ext, rel) && !isCache(rel)) sidecarTotal++
  }
  // 「这份资源有没有边车」按小写像查：`sound/A.WAV` 配 `sound/A.wav.import` 在 Windows 上就是配上了。
  const hasSidecar = (rel: string): boolean => hasRelCI(lower, rel + IMPORT_SUFFIX)

  const ex: Excl = { cache: 0, addons: 0, legacy: 0, unread: 0, noSource: 0, cacheSrc: 0, ignore: 0 }
  const stale: { rel: string; src: string }[] = []
  const mismatches: { rel: string; importer: string; ext: string; exts: string[] }[] = []
  const seen = new Set<string>()

  // 唯一的读入面：非缓存、非 addons 的 `.import` 边车，一份读一次。
  for (const f of tree) {
    const rel = f && typeof f.rel === 'string' ? f.rel : ''
    if (!rel || !isSidecar(f && f.ext, rel)) continue
    if (isCache(rel)) { ex.cache++; continue }
    if (isAddon(rel)) { ex.addons++; continue }
    if (seen.has(rel)) continue // 畸形清单里同一个 rel 出现两次：只读一次、也只进一次删除清单
    seen.add(rel)
    const { text } = await ctx.readText(rel)
    if (typeof text !== 'string') {
      // 读不到（超限 / 二进制 / 缺文件 / 非法路径）就是证据不出：不进 rels、不报不匹配（同 brokenRefs 的三态）
      ex.unread++
      continue
    }
    const data = readImportFile(text)
    // Godot 3 的 generator 形态整条不判（简报明写）。那种文件通常压根没有 source_file；真的写出了
    // source_file 的混合文件（手改 / 半迁移）也一律按老形态处理 —— 拿半迁移的文件去劝人删边车不划算。
    if (data.legacy) { ex.legacy++; continue }

    const assetRel = rel.slice(0, rel.length - IMPORT_SUFFIX.length)
    const srcRel = typeof data.sourceFile === 'string' ? resToRel(data.sourceFile) : null

    // ---------- 判据 2：失效边车（存在性主张 —— 截断时整条不做） ----------
    if (!truncated) {
      if (srcRel === null) {
        // 没有 source_file / 不是 res://（user://、绝对路径、越界串、裸 res://）：简报判据 2 明写
        // 「不造成源缺失」—— 那些路径压根不在项目树的管辖范围里。
        ex.noSource++
      } else if (isCache(srcRel)) {
        // 源指向 .godot 缓存：清缓存是常态（缓存体检还会主动劝人清），「查不到」此时不是边车失效的证据
        ex.cacheSrc++
      } else if (!hasRelCI(lower, srcRel)) {
        stale.push({ rel, src: data.sourceFile as string })
      }
    }

    // ---------- 判据 4：导入器名与扩展名对不上（内容主张 —— 截断时照做） ----------
    const row = typeof data.importer === 'string' && data.importer ? IMPORTER_BY_NAME.get(data.importer) : undefined
    if (row) {
      const nameExt = extOf(assetRel)
      const srcExt = srcRel === null ? null : extOf(srcRel)
      // 边车名与 source_file 给出的扩展名互相矛盾（手改/改名留下的）→ 不知道哪个是真的，不判；
      // 表外的扩展名（png/jpg/glb…）也不判 —— 两侧都得能逐条举证（见 KNOWN_IMPORTERS 的出处）。
      if ((srcExt === null || srcExt === nameExt) && TABLE_EXT.has(nameExt) && !row.exts.includes(nameExt)) {
        mismatches.push({ rel, importer: row.name, ext: nameExt, exts: row.exts })
      }
    }
  }

  // ---------- 判据 3：资源存在但没有边车（项目闸门 + 目录闸门 + `.gdignore` 闸门） ----------
  const gate = sidecarTotal === 0
  const missing: { rel: string; ext: string; siblings: string[] }[] = []
  if (!truncated && !gate) {
    const byDirExt = new Map<string, string[]>()
    const seenAsset = new Set<string>()
    for (const f of tree) {
      const rel = f && typeof f.rel === 'string' ? f.rel : ''
      const ext = f && typeof f.ext === 'string' ? f.ext : ''
      if (!rel || !TABLE_EXT.has(ext)) continue // 表外扩展名一律不判缺失（候选清单与判据 4 同一张表）
      if (isCache(rel) || isAddon(rel)) continue
      // .gdignore 屏蔽的目录：引擎不扫，边车本来就不会有，报「缺边车」是一条永远修不了的 warn
      if (isGdignored(ignoredDirs, rel)) { ex.ignore++; continue }
      if (seenAsset.has(rel)) continue
      seenAsset.add(rel)
      const key = `${dirOf(rel)}\u0000${ext}`
      const arr = byDirExt.get(key)
      if (arr) arr.push(rel)
      else byDirExt.set(key, [rel])
    }
    for (const [key, rels] of byDirExt) {
      const ext = key.slice(key.indexOf('\u0000') + 1)
      for (const rel of rels) {
        if (hasSidecar(rel)) continue
        // 目录闸门照 B4 已裁的量词读法（uid.ts:267-275）：「同目录其他同扩展名资源都有边车」才报这一个；
        // 域为空（目录里就它一个同扩展名资源）时全称命题**真空成立 → 照样报**，那不是漏网。
        if (rels.some((x) => x !== rel && !hasSidecar(x))) continue
        missing.push({ rel, ext, siblings: rels.filter((x) => x !== rel).sort(byText) })
      }
    }
  }

  // ---------- 组装（类别序 + 类内 rel 码元序，逐字节确定） ----------
  const out: Finding[] = []
  // 降级卡永远排第一：判据 4 在截断态照常出，但读它之前得先知道清单不全（裁定 3）。
  if (truncated) out.push(truncatedFinding('imports', WHY_TRUNC, TRUNC_TITLE))
  if (stale.length) out.push(staleFinding(stale, ex))
  for (const m of mismatches.slice().sort((a, b) => byText(a.rel, b.rel))) out.push(mismatchFinding(m))
  for (const m of missing.slice().sort((a, b) => byText(a.rel, b.rel))) out.push(missingFinding(m, ex.ignore))
  // 闸门那条永远单独出现：sidecarTotal === 0 时既没有边车可判失效/不匹配，缺失判定也被它按住
  if (!truncated && gate) out.push(gateFinding())
  return out
}
