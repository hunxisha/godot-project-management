// P1 工具 #14:输入映射体检(spec §3.2 #14,拆解见 docs/tools-page-plan.md P1-4 #14)。
//
// 判据两条:
//   · 脚本/场景引用的动作名不在 `[input]` 里 = **warn**。引擎对未知动作是 push_warning + 返回 false,
//     项目照跑、按键失灵,量级与「文件丢了」不同(定级按待确认 #15 的暂定值)。
//   · `[input]` 里两个名字只差大小写 = warn。Windows/macOS 上引擎的处理与 Linux 不一致,
//     这种键位在手柄/键盘重映射时最容易咬到。
//
// **全部风险都在「什么算一次动作引用」**:把整行字符串字面量都当动作名,每个 `print("jump")`
// 都会长出一张卡(§6 头号失败模式)。所以这里只认「调用点后面紧跟的第一个实参」,
// 且谓词表外的一律不收。跨行的调用(`is_action_pressed(` 换行再给参数)行界不确定 ——
// 不判,计一笔说出口(与债 6/债 7 的「宁漏不误」同方向)。
//
// 为什么不复用 refIndex 的 literal 通道:那条通道收集的是「res:// 路径」,判据是路径形状;
// 这里要的是「动作名」,两者语义不同,硬套会让引用索引多收一批非路径串(它还得负责孤儿判定)。
//
// 截断**不影响**判定:定义集来自 project.godot 这一份文件,清单残缺只会少找引用处(假阴性方向),
// 不会凭空造出「未定义」。所以这里没有 truncated 不判的分支。
//
// 已知残留(不偷偷扩,记在这里):退回 `raw` 取串的那条支路(带前缀单行串整行 inString)会把
// **多行字符串正文里**写着 `is_action_pressed("x")` 的那一行也当引用 —— 只有那一行同时带引号时才可能,
// 方向是「多一条 warn」而不是「少一条」。要收干净得让文本层区分「进入行时的串态」与「带前缀的单行串」,
// 那是改 gdScript.ts 的契约,超出本工具授权。
//
// 红线:纯函数,只吃 ToolContext —— 不碰 window / services / vue / DOM。
import type { Finding, ToolContext } from '../types'
import { LIST_CAP } from '../finding'
import { scanGdScript } from '../parsers/gdScript'
import { parseGodotIni, stringLiterals } from '../parsers/godotIni'
import { SCENE_EXT } from '../parsers/sceneRefs'
import { byText, gdignoredDirs, isCache, isGdignored, rootRelOf } from '../treeUtils'

/**
 * 引擎自带的 UI 动作(不在 project.godot 的 [input] 里,但永远合法)。
 *
 * ⚠ 与 scripts.ts 的引擎类白名单同一哲学:**只用来免除怀疑,不用来定罪**。
 * 漏一个的后果是把内建动作报成未定义(假阳性),所以这里宁可多列。
 */
const BUILTIN_ACTIONS = new Set([
  'ui_accept', 'ui_cancel', 'ui_select', 'ui_menu', 'ui_focus_next', 'ui_focus_prev',
  'ui_left', 'ui_right', 'ui_up', 'ui_down',
  'ui_page_up', 'ui_page_down', 'ui_home', 'ui_end',
  'ui_text_completion_query', 'ui_copy', 'ui_paste', 'ui_cut', 'ui_undo', 'ui_redo',
  'ui_next', 'ui_previous', 'ui_next_focus', 'ui_previous_focus'
])

// 动作查询 API:Input. 前缀可省(在 CharacterBody 里直接 is_action_pressed 也常见)。
const CALL_RE = new RegExp(
  '(?:Input\\s*\\.\\s*)?(' +
  'is_action_(?:pressed|just_pressed|just_released|strength)' +
  '|action_is_(?:pressed|just_pressed|just_released)' +
  '|get_action_strength|action_get_strength' +
  ')\\s*\\(\\s*(&?"[^"]*"|\'[^\']*\')',
  'g'
)
// 调用名与实参被换行劈开:`...is_action_pressed(` 收尾 → 这一条不判(行界不确定)。
const CROSSLINE_RE = /(?:is_action_\w+|action_is_\w+|get_action_strength|action_get_strength)\s*\($/
// 场景里的键位声明:InputEventKey/InputEventAction 的 action 属性(&"name" 的 StringName 形态最常见)。
const SCENE_ACTION_RE = /^action\s*=\s*(&?"[^"]*"|'[^']*')\s*$/

/** 剥掉 `&` 前缀与外层引号,拿到动作名本身 */
function actionName(lit: string): string {
  const s = lit.startsWith('&') ? lit.slice(1) : lit
  return s.length >= 2 ? s.slice(1, -1) : s
}

export async function run(ctx: ToolContext): Promise<Finding[]> {
  const pRel = rootRelOf(ctx.tree, 'project.godot')
  const projText = pRel ? (await ctx.readText(pRel)).text : undefined
  if (typeof projText !== 'string') {
    // 定义集拿不到就什么都不能判 —— 否则 [input] 是空的,每个动作都成「未定义」。
    return [{
      id: 'inputMap:no-project',
      severity: 'info',
      title: '读不到 project.godot,本次不做输入映射体检',
      detail: '动作的定义集全在 project.godot 的 [input] 段里;它不在文件清单中、或文本读不出来时,' +
        '「未定义」这个判定没有对照物。这份体检什么都不发,比发一屏假 warn 有用。'
    }]
  }

  const doc = parseGodotIni(projText)
  const defined = new Set<string>()
  for (const v of doc.values) if (v.section === 'input' && typeof v.key === 'string' && v.key) defined.add(v.key)

  const refs = new Map<string, { rel: string; line: number }[]>()
  let crossline = 0
  let unread = 0
  const dirs = gdignoredDirs(ctx.tree)

  const note = (name: string, rel: string, line: number) => {
    const list = refs.get(name)
    if (list) list.push({ rel, line })
    else refs.set(name, [{ rel, line }])
  }

  for (const f of ctx.tree) {
    if (!f || typeof f.rel !== 'string' || !f.rel) continue
    const isGd = f.ext === 'gd'
    const isScene = SCENE_EXT.has(f.ext)
    if (!isGd && !isScene) continue
    if (isCache(f.rel) || isGdignored(dirs, f.rel)) continue
    const { text } = await ctx.readText(f.rel)
    if (typeof text !== 'string') { unread++; continue }

    if (isGd) {
      for (const l of scanGdScript(text).lines) {
        if (l.isComment) continue
        // `code` 在 inString 行是空串,而带前缀的单行串(`&"jump"` 这种 StringName 写法)**整行**会被标
        // inString —— 那是格式化侧「这一行字节一个不动」的刻意契约(gdScript.ts:28 的文件头明写),
        // 不是 bug,也不该为我去放宽它。所以这里退回 raw 取串,再用 stringLiterals 复核
        // 「这个字面量确实在代码位置而不在注释里」。
        const hay = l.code || l.raw
        if (CROSSLINE_RE.test(hay)) { crossline++; continue }
        const lits = l.code ? null : new Set(stringLiterals(l.raw))
        CALL_RE.lastIndex = 0
        let m: RegExpExecArray | null
        while ((m = CALL_RE.exec(hay)) !== null) {
          // 组 1 是 API 名(它必须成组才能撑住那段 alternation),**实参在组 2**。
          // 取错组会把 `is_action_pressed` 本身当动作名报出去(实测红过一次)。
          const name = actionName(m[2])
          if (lits && !lits.has(name)) continue
          note(name, f.rel, l.line)
        }
      }
    } else {
      const rows = text.split(/\r?\n/)
      for (let i = 0; i < rows.length; i++) {
        const m = SCENE_ACTION_RE.exec(rows[i].trim())
        if (m) note(actionName(m[1]), f.rel, i + 1)
      }
    }
  }

  const out: Finding[] = []
  const undefinedNames: { name: string; sites: { rel: string; line: number }[] }[] = []
  for (const [name, sites] of refs) {
    if (defined.has(name) || BUILTIN_ACTIONS.has(name)) continue
    undefinedNames.push({ name, sites })
  }
  undefinedNames.sort((a, b) => byText(a.name, b.name))
  for (const u of undefinedNames.slice(0, LIST_CAP)) {
    const shown = u.sites.slice(0, 5)
    out.push({
      id: `inputMap:undefined:${u.name}`,
      severity: 'warn',
      title: `动作 "${u.name}" 在 [input] 里没有定义`,
      detail: `引用处 ${shown.map((s) => `${s.rel}:${s.line}`).join('、')}` +
        (u.sites.length > shown.length ? ` 等 ${u.sites.length} 处(这里点名前 5 处)` : '') +
        '。引擎对不认识的动作名是 push_warning + 永远返回 false —— 项目照常跑,但这个键位按下去没反应,' +
        '而且运行时只在控制台留一行。在 [input] 里补上它,或把代码里的名字改回已定义的那个。',
      rel: u.sites[0].rel,
      related: u.sites.slice(0, 8).map((s) => s.rel)
    })
  }

  // 大小写冲突:只比**定义集内部**(引用侧的大小写差异本来就要落到上面那条未定义里)。
  const byLower = new Map<string, string[]>()
  for (const name of defined) {
    const k = name.toLowerCase()
    const list = byLower.get(k)
    if (list) { if (!list.includes(name)) list.push(name) }
    else byLower.set(k, [name])
  }
  const collisions: { lower: string; names: string[] }[] = []
  for (const [lower, names] of byLower) if (names.length > 1) collisions.push({ lower, names })
  collisions.sort((a, b) => byText(a.lower, b.lower))
  for (const c of collisions.slice(0, LIST_CAP)) {
    out.push({
      id: `inputMap:case:${c.lower}`,
      severity: 'warn',
      title: `[input] 里有 ${c.names.length} 个只差大小写的动作名`,
      detail: `${c.names.join(' / ')}。输入动作按名字查表,而不同平台的文件系统与手柄映射对大小写的处理不一致 ——` +
        ' 留两个写法等于「按引擎当时读到哪个算哪个」。留一个,另一个改掉或删掉。',
      rel: 'project.godot'
    })
  }

  const counts: string[] = []
  if (crossline) counts.push(`${crossline} 处调用与实参被换行劈开,行界不确定,没算进引用集`)
  if (unread) counts.push(`${unread} 个脚本/场景读不到文本(缺失 / 超体积上限 / 被判二进制)`)
  const noteTxt = counts.length ? `本次未判定:${counts.join(';')}。` : ''
  if (noteTxt) {
    if (out.length) for (const f of out) f.detail += ` ${noteTxt}`
    else out.push({
      id: 'inputMap:skip-count',
      severity: 'info',
      title: `${crossline + unread} 项未纳入本次输入映射体检`,
      detail: noteTxt + ' 没有未判定项时本条不会出现 —— 它存在的意义就是别让「没报」看起来像「没问题」。'
    })
  }

  return out
}
