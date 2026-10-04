// P0 工具 #7：addons 体检（spec §3.1 #7、§5.2、§6 风险表；简报判据 1-7）。
//
// **本工具全程只报告**：产出的每一条结论都不带 `fix` 字段 —— spec #7 的 fix 列写的是
// 「none（跳转「已安装」页处理）」，而简报第 9-11 行把 `kind:'existing'` 也一起禁了：existing 在
// `fixPlan.ts:290-296` 就是「一次跳转」（service 一律 null、verb 留空），而跳转的落点是 B10 的视图活。
// 这条红线由 addons.test.mjs 末尾的 ALL 收集器咬住：测试里每一次 run() 的产出都进 ALL，逐条断言
// `!('fix' in f)`，将来任何一条判据挂上 fix 都会红（不是只挑几条看）。
//
// 判据 1 只用 B2 的 `parseGodotIni`（台账 Ruling B2 只允许一份 INI 规则）：`plugin.cfg` 与
// project.godot 是同一个 INI 子集，取键一律走 `getIni(doc, 'plugin/<键>')` 这类 fullKey 取法，
// 取不到就是 undefined，不猜默认值。**不新写第二个解析器**。
//
// 判据 2 是防噪音的主闸：扫描对象只有 `addons/<目录>/plugin.cfg` 这一层深度。
// addons/ 下没有 plugin.cfg 的子目录**一条都不报** —— 素材包、字体集、第三方库放进 addons 是常态
// （本仓的资产安装链路就是这么用的：纯素材按 zip 里有没有 plugin.cfg 分流，
// `src-ztools/preload/lib/assetsinstall.js:21`、`assetfiles.js:59-66`），它们不是插件，
// 给它们发「缺 plugin.cfg」的结论就是凭空造噪音。更深层的 `addons/A/B/plugin.cfg` 同样不参与。
//
// 引擎行为不许凭印象（简报第 51-59 行，B4/B5/B6 三轮共同的教训）。本文件里的仓库内证据：
//   · enabled 的**值形态与比对键**：`src-ztools/preload/lib/assetfiles.js:96-114` 的 setPluginEnabled
//     —— :100 就是 `res://addons/<目录>/plugin.cfg`，:114 写出的模板是
//     `enabled=PackedStringArray("…")`。所以判据 5 用 getIniList 取值、用 resToRel 归一后再比，
//     不拼字符串比大小写（简报第 41 行的口径）。
//   · 「enabled 里没有 = 未启用」不是本工具新发明的读法：`assetfiles.js:259-285` 的 listAddons
//     读整份 project.godot，:266 收启用路径、:285 按 `enabledPaths.includes('res://addons/<目录>/plugin.cfg')`
//     给每个插件打 enabled；没有那一行时 enabledPaths 是空集 = 全部未启用。判据 5 的第二方向与
//     「没有 [editor_plugins] 段」的处理都跟这份既有页面同源。
//   · `plugin/name`/`version`/`author` 确实是给人看的显示字段：`assetfiles.js:75-87` 的 parsePluginCfg
//     只取这三个键，:281-283 用它们填「已安装」页的名字/版本/作者。
//   · 唯一那条 error 的先例是 `brokenRefs.ts:1`（同样是「res:// 指的文件在清单里查不到」）。
// 反过来，**本文件不主张编辑器的任何具体报错文案或加载步骤**：仓库里既没有引擎插件加载器的代码，
// 也没有能替代它的观测（我们读不到编辑器的输出）。所以每条结论的话都说在「盘上看到了什么/清单里
// 查不到什么」这一侧，把结论的核对动作交给用户（项目设置→插件 页），需要因果的地方留给用户自证。
//
// 存在性一律用 `lowerRelSet(ctx.tree)` + `hasRelCI()` 查表（treeUtils.ts:102-118，B6 评审裁定 2 的
// 共享小写像），不做精确大小写比对，也不做字符串包含。**判据 4 是本工具唯一的 error**，而 error 一侧
// 最容易造假：`brokenRefs.ts:33-35` 记的就是同一件事（精确大小写查表会把其实存在的文件说成丢失）。
//
// `ctx.truncated` 的降级口径与 imports.ts:17-20（B6 裁定 3）一致：作废的是**存在性主张**
// （入口脚本缺失、enabled 点名文件不在），内容型判据（字段缺失、显示名重名、已安装未启用）
// 只看读得到的 plugin.cfg 正文与 enabled 清单本身，照常判；降级卡排首位。
//
// 判据 7 明写不判的东西一律不碰：插件内容好坏、script 指向的 .gd 里有没有 `@tool`、是不是继承
// EditorPlugin（那要读 .gd 正文，还要引擎行为取证）、plugin.cfg 里的多余字段、addons 资产的
// `.import` 是否失效（B6 已把它记成 P0b 已知缺口，见 imports.ts:96-99，不是给 B7 加的活）、
// `bin/` 里的 `.gdextension`。
//
// 成本：读入面只有候选 `plugin.cfg`（每个一次）与根目录 `project.godot`（一次）。**不调 buildRefIndex**
// —— addons 不需要引用面；也不读任何 `.gd` 正文。
//
// 结论顺序是定死的类别序（截断卡 → error 的入口脚本 → 重名 → enabled 缺失 → 字段两档 → 未启用），
// 类内按 rel/键的码元序，与 imports.ts:30 同一口径。
//
// 红线：纯函数，只吃 ToolContext —— 不碰 window / services / vue / DOM；唯一 IO 是 await ctx.readText。
import type { Finding, ToolContext } from '../types'
import type { TreeEntry } from '../../types/godot'
import { truncatedFinding } from '../finding'
import { getIni, getIniList, getIniRaw, parseGodotIni } from '../parsers/godotIni'
import type { IniDoc } from '../parsers/godotIni'
import { resToRel } from '../parsers/sceneRefs'
import { gdignoredDirs, hasRelCI, isGdignored, lowerRelSet, lowerSet } from '../treeUtils'

/** 扫描深度与文件名：只认 `addons/<目录>/plugin.cfg`（判据 2） */
const ADDONS_DIR = 'addons'
const CFG_BASENAME = 'plugin.cfg'
/** 根目录的项目配置文件名与它的启用清单键（判据 5） */
const INI_BASENAME = 'project.godot'
const ENABLED_KEY = 'editor_plugins/enabled'
/** plugin.cfg 里的段名：取键一律走 `plugin/<键>` 这种 fullKey（判据 1） */
const SECTION = 'plugin'

/**
 * 判据 3 的两档：加载档（名字与入口）缺失给 warn，元信息档缺失给 info。
 * 两档都不升 error —— 简报第 21 行的理由：「字段没填」要断言编辑器的加载行为，仓库里拿不到证据。
 * 数组顺序就是 detail 里的点名顺序（定死，不随物件键序漂）。
 */
const LOAD_KEYS = ['name', 'script']
const META_KEYS = ['description', 'author', 'version']

/** 排除与「不判」的逐类计数，写进结论 detail（B5 立下的口径：排除要看得见，同 imports.ts 的 Excl） */
interface Excl {
  /** .gdignore 屏蔽掉的插件目录（判据 6） */
  ignore: number
  /** plugin.cfg 读不到（缺文件/超限/二进制），内容型判据全部失效 */
  unread: number
  /** script 有值但不是 res:// 形态（相对文件名、user://、带盘符、越界）→ 不判存在性（判据 4） */
  relScript: number
  /** enabled 条目里不是 res:// 形态的条数 → 不判（判据 5） */
  relEnabled: number
  /** enabled 这个键存在但值形态认不出（getIniList 给 undefined） */
  badEnabled: number
  /** project.godot 不在清单里或读不到 → 启用状态两条判据都不做 */
  noIni: number
}

/** 一个插件目录的候选配置（rel 是清单里的写法，dir 是 addons 下的那一段） */
interface Cand {
  rel: string
  dir: string
}

interface FieldHit {
  c: Cand
  /** 缺失的加载档键（不含 plugin/ 前缀） */
  load: string[]
  /** 缺失的元信息档键 */
  meta: string[]
}

interface ScriptHit {
  c: Cand
  /** plugin/script 的原值（带 res:// 前缀，证据形态） */
  value: string
  /** resToRel 归一后的 rel */
  target: string
}

interface NameHit {
  key: string
  items: { c: Cand; name: string }[]
}

interface EnabledHit {
  /** 归一 rel 的小写像：既是去重键，也是结论 id 的稳定键 */
  key: string
  /** 归一后的 rel（取清单里第一个写法） */
  rel: string
  /** enabled 里点到这个目标的全部原样写法（证据全列） */
  spellings: string[]
}

/**
 * 字典序一律用 `<`/`>`（UTF-16 码元），不用 localeCompare：locale 随宿主环境变，而结论顺序、
 * related 与 id 要跨机器逐字节一致（同 imports.ts:89-91、uid.ts:48-50）。
 */
function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * 判据 1 的取键：整段 `plugin/<key>` 走 getIni；**undefined（没这行）与纯空白值都算「没填」**。
 * 返回 trim 后的值，是因为 `name=" Foo "` 与 `name="Foo"` 在显示名与路径上都指向同一件事；
 * 判据 5 的重名本来就要求 trim（简报第 43 行）。
 */
function filled(doc: IniDoc, key: string): string | undefined {
  const v = getIni(doc, `${SECTION}/${key}`)
  if (v === undefined) return undefined
  const t = v.trim()
  return t === '' ? undefined : t
}

/**
 * 根目录 project.godot 在清单里的写法：优先引擎自己那个拼写，其次任意大小写异体里码元序第一个。
 * 读 tree 里真存在的那个 rel（而不是硬拼 'project.godot'）有两个理由：
 *   · 存在性口径与判据 4/5 同源（hasRelCI 那一套），`Project.godot` 这种手改写法在 Windows 上就是同一份文件；
 *   · 结论的 rel 要能进 related/jump —— 指一个清单里没有的名字就是死链（uid.ts:187-190 的同一顾虑）。
 */
function iniRelOf(tree: TreeEntry[]): string | undefined {
  let alt: string | undefined
  for (const f of tree) {
    const rel = f && typeof f.rel === 'string' ? f.rel : ''
    if (!rel || rel.includes('/')) continue // 只认根目录那一份
    if (rel === INI_BASENAME) return rel
    if (rel.toLowerCase() === INI_BASENAME && (alt === undefined || rel < alt)) alt = rel
  }
  return alt
}

/**
 * 排除计数与覆盖面声明（每条结论都带）。写法与 imports.ts:192-196 的 `ignored` 同一读法：被「不判」
 * 按住的主张要在结论里看得见。里面唯一一句讲引擎语义的是「引擎不扫那些目录」，那不是本文件的新断言，
 * 而是共享闸门自己记下的出处（treeUtils.ts:120-131；仓库内同规则另见
 * `src-ztools/preload/lib/assetsinstall.js:96` 与 `src-tauri/src/main.rs:596`）。其余各项都只说
 * 「本次没判什么」，不替编辑器的行为作断言。
 */
function exclNote(ex: Excl): string {
  const bits: string[] = []
  if (ex.ignore) bits.push(`.gdignore 屏蔽的插件目录 ${ex.ignore} 个（引擎不扫那些目录，四条判据一起不判）`)
  if (ex.unread) bits.push(`plugin.cfg 读不到 ${ex.unread} 个（字段/入口脚本/重名三条对它失效）`)
  if (ex.relScript) bits.push(`script 不是 res:// 写法、不判存在性的 ${ex.relScript} 个`)
  if (ex.relEnabled) bits.push(`enabled 里不是 res:// 写法、不判的 ${ex.relEnabled} 条`)
  if (ex.badEnabled) bits.push(`enabled 的值形态认不出（既不是 PackedStringArray(...) 也不是 [...]），启用状态两条判据本次未做`)
  if (ex.noIni) bits.push(`project.godot 读不到，启用状态两条判据本次未做`)
  return bits.length ? ` 本次未判定：${bits.join('；')}。` : ''
}

/** 只报告这件事本身也要说出来：本工具不写 project.godot、不碰插件目录（跳转与启用操作是编辑器/「已安装」页的活） */
const REPORT_ONLY = ' 本工具只报告，不代改配置、不代增删插件文件。'

/** 判据 3：一个插件一条结论，两档缺项分组列全（简报第 24-25 行：一字段一卡会把页面刷死） */
function fieldsFinding(h: FieldHit, ex: Excl): Finding {
  const groups: string[] = []
  if (h.load.length) groups.push(`加载必需档缺：${h.load.map((k) => `${SECTION}/${k}`).join('、')}`)
  if (h.meta.length) groups.push(`元信息档缺：${h.meta.map((k) => `${SECTION}/${k}`).join('、')}`)
  return {
    // id 落到插件目录：同一个插件再缺别的字段仍是这一条，折叠状态与「忽略这条」不换键（spec §5.2 的 id 稳定口径）
    id: `addons:fields:${h.c.dir}`,
    severity: h.load.length ? 'warn' : 'info',
    title: `插件配置字段不全：${h.c.rel}`,
    detail: `${h.c.rel} —— ${groups.join('；')}。` +
      ' name 与 script 这两条是插件的显示名与入口脚本，description/author/version 是元信息。' +
      ' 本项目「已安装」页列的名字、版本、作者就取自 plugin.cfg 里的同名键，缺了只能退回目录名或留空。' +
      ' 取键按 plugin/ 段前缀走，所以正文里没有 [plugin] 段时整批算缺（那是配置自身的形态，不是本工具猜的）。' +
      ' 缺字段会不会让编辑器报错，以编辑器为准（项目设置→插件 页可自查），本工具不替你判断这个插件能不能跑。' +
      `${REPORT_ONLY}${exclNote(ex)}`,
    rel: h.c.rel
  }
}

/** 判据 4：入口脚本文件不在清单里 —— 本工具唯一的 error */
function scriptFinding(h: ScriptHit, ex: Excl): Finding {
  return {
    // id 落到插件目录：这条结论讲的是「这个插件的入口脚本不在」，脚本值改了也是同一个待办
    id: `addons:script-missing:${h.c.dir}`,
    severity: 'error',
    title: `插件入口脚本文件不存在：${h.c.rel}`,
    detail: `${h.c.rel} 的 plugin/script 写的是 "${h.value}"，归一成项目内路径 ${h.target}，` +
      `而它在这次文件清单里查不到（任意大小写写法都没有）。` +
      ` 这条插件配置把入口脚本指到了一个不存在的文件：要么把脚本放回原位，要么在编辑器的` +
      ` 项目设置→插件 里核对该插件的状态。结论不猜「为什么不在」（被删、被改名、还是拷贝时漏了）。` +
      ` 覆盖面：只认写成 res:// 的 script 值；相对文件名（市场插件的主流写法，如 script="plugin.gd"）、` +
      `user://、带盘符与越界写法一律不判存在性 —— 归一不了的路径不是「脚本丢失」的证据。` +
      `${REPORT_ONLY}${exclNote(ex)}`,
    rel: h.c.rel
  }
}

/** 判据 5 第一方向：enabled 点了名而文件不在清单 */
function enabledFinding(h: EnabledHit, iniRel: string, ex: Excl): Finding {
  return {
    // id 用小写像：同一目标的两种写法（Windows 上是同一个文件）在任意扫描顺序下都是同一条结论
    id: `addons:enabled-missing:${h.key}`,
    severity: 'warn',
    title: `启用清单点名的插件配置不在文件清单里：${h.rel}`,
    detail: `${iniRel} 的 [editor_plugins] enabled 里点了 ${h.spellings.join('、')}，` +
      `归一成 ${h.rel} 后在这次文件清单里查不到（任意大小写写法都没有）。` +
      ` 启用清单记的就是各插件 plugin.cfg 的路径（本项目「已安装」页的启用状态也按同一份清单判），` +
      `而这条记录现在指着一个项目里不存在的目标 —— 多半是插件目录被删、改名或搬走了，配置里那一条还留着。` +
      ` 想核对就在编辑器的 项目设置→插件 里看有没有这一条。` +
      `${REPORT_ONLY}${exclNote(ex)}`,
    rel: iniRel,
    related: [h.rel]
  }
}

/** 判据 5 第二方向：磁盘有 plugin.cfg 而 enabled 里没有 —— 用户选择，info 不是 warn */
function notEnabledFinding(c: Cand, iniRel: string, ex: Excl): Finding {
  return {
    id: `addons:not-enabled:${c.dir}`,
    severity: 'info',
    title: `插件已安装但未启用：${c.dir}`,
    detail: `${c.rel} 在这次的文件清单里，而 ${iniRel} 的 [editor_plugins] enabled 没有它 —— 已安装但未启用。` +
      ' 这不是错：装在 addons/ 下而暂时不启用是常见选择，本项目的「已安装」页给出的也是同一个状态。' +
      ' 想启用就在编辑器的 项目设置→插件 列表里勾选（启用记录由编辑器写进 project.godot，不由本工具改）。' +
      `${REPORT_ONLY}${exclNote(ex)}`,
    rel: c.rel
  }
}

/** 判据 5 尾条：不同目录、同一显示名 */
function dupFinding(g: NameHit, ex: Excl): Finding {
  const rels = g.items.map((i) => i.c.rel)
  return {
    // id 用小写显示名（简报第 43 行）：证据就是这个键本身，谁先扫到不影响 id
    id: `addons:dup-name:${g.key}`,
    severity: 'warn',
    title: `插件显示名重复：${g.items[0].name}`,
    detail: `${rels.join('、')} 这几份配置的 plugin/name 都是「${g.items[0].name}」` +
      `（比对按 trim + 大小写不敏感，共 ${g.items.length} 个插件目录）。` +
      ' 插件目录各不相同而显示名相同：列表里会出现几条同名条目，分不清哪条对应哪个目录' +
      '（本项目「已安装」页显示的就是这个键）。' +
      ' 想消歧就把其中一个的名字改成可区分的写法。' +
      `${REPORT_ONLY}${exclNote(ex)}`,
    rel: rels[0],
    related: rels.slice(1)
  }
}

const WHY_TRUNC =
  '入口脚本文件在不在、enabled 点名的配置在不在，这两条都拿整份清单比存在性 —— 清单不全时「查不到」' +
  '不是证据，而前者正是本工具唯一的 error，所以这两条本次不做。字段缺失、显示名重名、已安装但未启用三条' +
  '只看读得到的 plugin.cfg 正文与 enabled 清单本身，清单全不全都不影响它们，本次照常判（与 imports/uid ' +
  '保留内容型判据同一读法）。请把 maxEntries 调高或做一次完整重扫后再看' +
  ' —— 别用排除目录、按扩展名筛选这类过滤来「缩小范围」：那样得到的清单同样不完整，却不会再带截断标记，结论只会更假。'

const TRUNC_TITLE = '文件清单被截断，本次不做 addons 的存在性判定（字段、重名、未启用三条照常判）'

export async function run(ctx: ToolContext): Promise<Finding[]> {
  const tree = Array.isArray(ctx.tree) ? ctx.tree : []
  // 截断作废存在性主张、不作废内容型判据（B6 裁定 3 的先例，见文件头）
  const truncated = ctx.truncated === true
  const lower = lowerRelSet(tree)
  // 判据 6：`.gdignore` 屏蔽的目录整体不进面（treeUtils.ts:133-158，B6 落地的共享闸）
  const ignoredDirs = gdignoredDirs(tree)
  const ex: Excl = { ignore: 0, unread: 0, relScript: 0, relEnabled: 0, badEnabled: 0, noIni: 0 }

  // ---------- 判据 2：扫描面 = addons/<目录>/plugin.cfg，只认这一层深度 ----------
  // 第一段必须是 addons（与 orphans/imports 的 isAddon 同一形状），第三段必须是文件名本身，
  // 段数不等于 3 的一律不参与 —— 引擎不按那个位置加载插件，深层配置参与只会多出无法核对的结论。
  // 文件名与第一段都只认 `plugin.cfg`/`addons` 这一种拼写：异体拼写不进面是**少报**（方向安全），
  // 不是判它坏了 —— 与两端原语给出的 rel 形状一致（rel 的空段/点段在 resolveRel 就被吃掉，
  // `src-ztools/preload/lib/inspectfs.js:36-49`，所以 `Addons/`、`addons//plugin.cfg` 只可能来自畸形清单）。
  const byKey = new Map<string, Cand>()
  for (const f of tree) {
    const rel = f && typeof f.rel === 'string' ? f.rel : ''
    if (!rel) continue
    const segs = rel.split('/')
    // !segs[1] 是纯防御：目录段为空时 id 会退化成 `addons:fields:`（空键），多个畸形条目还会互相顶掉
    if (segs.length !== 3 || segs[0] !== ADDONS_DIR || segs[2] !== CFG_BASENAME || !segs[1]) continue
    // 大小写异体/重复条目归并成同一个插件目录（Windows 上本就是同一个文件）；留码元序那个写法
    const key = rel.toLowerCase()
    const kept = byKey.get(key)
    if (kept && kept.rel <= rel) continue
    byKey.set(key, { rel, dir: segs[1] })
  }
  // 读取与结论都按这份顺序走，tree 的抖动不会变成不同的 IO 或不同的 id（判据 8）
  const cands = [...byKey.values()].sort((a, b) => byText(a.rel, b.rel))

  const hits: FieldHit[] = []
  const scriptHits: ScriptHit[] = []
  const nameGroups = new Map<string, { c: Cand; name: string }[]>()
  /** 过了 .gdignore 闸门的插件目录：判据 5 的第二方向只看清单实存，连读不到的配置也算「装在那里」 */
  const live: Cand[] = []

  for (const c of cands) {
    if (isGdignored(ignoredDirs, c.rel)) { ex.ignore++; continue }
    live.push(c)
    const { text } = await ctx.readText(c.rel)
    // 读不到（缺文件/超 maxBytes/二进制/非法路径）就是证据不出：三条内容判据对它失效，只留计数
    if (typeof text !== 'string') { ex.unread++; continue }
    const doc = parseGodotIni(text)

    // ---------- 判据 3：必填字段两档，一个插件一条结论 ----------
    const load = LOAD_KEYS.filter((k) => filled(doc, k) === undefined)
    const meta = META_KEYS.filter((k) => filled(doc, k) === undefined)
    if (load.length || meta.length) hits.push({ c, load, meta })

    // ---------- 判据 4：入口脚本的存在性（唯一的 error；截断时不做） ----------
    const script = filled(doc, 'script')
    if (script !== undefined) {
      const target = resToRel(script)
      if (target === null) ex.relScript++ // 相对文件名 / user:// / 带盘符 / 越界：不臆造「脚本丢失」
      else if (!truncated && !hasRelCI(lower, target)) scriptHits.push({ c, value: script, target })
    }

    // ---------- 判据 5 尾条：显示名分组（trim + 大小写不敏感） ----------
    const name = filled(doc, 'name')
    if (name !== undefined) {
      const key = name.toLowerCase()
      const arr = nameGroups.get(key)
      if (arr) arr.push({ c, name })
      else nameGroups.set(key, [{ c, name }])
    }
  }

  // ---------- 判据 5：enabled 清单 ----------
  // undefined = 「启用清单不知道」，两个方向都不判；[] = 明确没有插件被启用（没有 [editor_plugins]
  // 段时按这一档处理，与 listAddons 那份既有判定同源 —— assetfiles.js:266、285，见文件头）。
  let enabled: string[] | undefined
  let enabledIn = ''
  const iniRel = iniRelOf(tree)
  if (!iniRel) {
    ex.noIni++
  } else {
    const { text } = await ctx.readText(iniRel)
    if (typeof text !== 'string') ex.noIni++
    else {
      const doc = parseGodotIni(text)
      enabledIn = iniRel
      if (getIniRaw(doc, ENABLED_KEY) === undefined) enabled = []
      else {
        const list = getIniList(doc, ENABLED_KEY)
        if (list === undefined) ex.badEnabled++ // 值形态认不出就是不知道，不猜空集
        else enabled = list
      }
    }
  }

  const enabledHits: EnabledHit[] = []
  const notEnabled: Cand[] = []
  if (enabled !== undefined) {
    const byTarget = new Map<string, EnabledHit>()
    for (const entry of enabled) {
      const rel = resToRel(entry)
      if (rel === null) { ex.relEnabled++; continue }
      const key = rel.toLowerCase()
      const kept = byTarget.get(key)
      if (kept) {
        if (!kept.spellings.includes(entry)) kept.spellings.push(entry)
        continue
      }
      byTarget.set(key, { key, rel, spellings: [entry] })
    }
    // 比对键两边都归一（resToRel）+ 都走小写像：enabled 写 res://addons/FOO/plugin.cfg 而清单是
    // addons/foo/plugin.cfg 时**不算缺失、也不算未启用**（判据 4 同一条口径，简报第 41 行）
    const enabledLower = lowerSet([...byTarget.keys()])
    for (const c of live) {
      if (!hasRelCI(enabledLower, c.rel)) notEnabled.push(c)
    }
    if (!truncated) {
      for (const h of byTarget.values()) {
        if (!hasRelCI(lower, h.rel)) enabledHits.push(h)
      }
    }
    enabledHits.sort((a, b) => byText(a.key, b.key))
  }

  const dupGroups: NameHit[] = []
  for (const [key, items] of nameGroups) {
    if (items.length < 2) continue // 一个插件谈不上重复
    dupGroups.push({ key, items })
  }
  dupGroups.sort((a, b) => byText(a.key, b.key))

  // ---------- 组装：定死的类别序 + 类内码元序（逐字节确定） ----------
  const out: Finding[] = []
  if (truncated) out.push(truncatedFinding('addons', WHY_TRUNC, TRUNC_TITLE))
  for (const h of scriptHits) out.push(scriptFinding(h, ex)) // cands 已按 rel 码元序
  for (const g of dupGroups) out.push(dupFinding(g, ex))
  for (const h of enabledHits) out.push(enabledFinding(h, enabledIn, ex))
  for (const h of hits) out.push(fieldsFinding(h, ex))
  for (const c of notEnabled) out.push(notEnabledFinding(c, enabledIn, ex))
  return out
}
