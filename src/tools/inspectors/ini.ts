// P0 工具 #3:`project.godot` 配置校验(spec §3.1 #3、§5.2、§6 风险表;简报判据 1-11)。
//
// **B10 接线时的 needs**:`['tree', 'text']`(简报 Ruling B8-1 钉死)——不含 `write`/`trash`,
// 本工具没有执行面,宿主缺哪个都不该把这张卡片藏起来。
//
// **本工具全程只报告,零 fix(Ruling B8-1)**:spec §3.1 #3 的 fix 列写的是 rewrite(写前 `.bak`),
// 本轮**不做**,理由是证据而不是偷懒 —— `writeProjectText` 是整文件覆写,而 `parseGodotIni` 是**只读**
// 解析器(它不保留注释、不保留段内排版、也不保留引号写法,godotIni.ts:123-202),我们没有任何
// 「改一条键而不动其余部分」的序列化能力。自己拼一份重新序列化的文本,等于把用户的配置文件整体
// 规范化重写一遍:版本控制里会出现几百行无谓 diff,而 `.bak` 只能救误删、救不了 diff 噪音。
// 所以每条结论都不带 `fix`(ini.test.mjs 末尾的 ALL 收集器咬住全量结论),detail 只说
// 「哪个键、现在的值、自己怎么核对」,不替用户动手。
//
// **判据 1:只用 B2 的解析器读**(台账 Ruling B2 只允许一份 INI 规则)。取键一律
// `getIni/getIniRaw/getIniInt/getIniList` + fullKey,取不到就是 undefined、不猜默认值;
// `values`(重复键全留)与 `problems`(归不进键值的行)两条现成产物直接吃。
// ⚠ **`configVersion` 这一条本工具刻意不用**当「缺失」信号:它按设计把「没有这一行」「值不是裸整数」
//   「出现多次」三种情况统统记成 0(godotIni.ts:191-196,断言在 __tests__/godotIni.test.mjs:227-243),
//   而判据 4 要的正是这三种的区分 —— 拿 `configVersion === 0` 判缺失会把 `config_version=0` 这个合法值
//   说成「头部没有这一行」(简报判据 4 那句「注意 0 是缺失不是值为 0」)。所以缺失走
//   `getIniRaw(...) === undefined`,档位走 `getIniInt(...) === undefined`。
// 本文件里唯一自己算的一次是 fullKey 的拼法(段名 + '/' + 键名),那是照抄 godotIni.ts:207-211
// 的 `fullKeyOf`(它没导出),只为把 `values` 按键分组数重复,不含任何第二条解析规则。
//
// **档位一律先要出处(Ruling B8-2)**,标准就是 importFile.ts:77-112 那张 `KNOWN_IMPORTERS`
// (7 个逐个举证的导入器,png/jpg/webp/glb/gltf/svg 因为举不出证据明确不判)。本文件用到的出处:
//   · `[autoload]` 的值形态与 `$单例` 引用:`godotIni.ts:392-402`(resPathLiteral 的注释:
//     `*` 是「启用单例」标记不是路径的一部分、`$MyAuto` 压根不是路径)+ 真实夹具
//     `__tests__/godotIni.test.mjs:64-65`(`GameState="*res://autoload/game_state.gd"`、`Net="$GameState"`)。
//   · 未加引号的整串路径也要认:`godotIni.ts:283-291`(B2 的裸值通道与它写明的副作用),
//     夹具 `__tests__/godotIni.test.mjs:446-458`。反过来**同一段注释**给出本轮收紧的理由:
//     `res://a.png 尾巴` 那串会被它整串当路径、得到一条对不上任何树条目的 rel —— B5 拿它当引用
//     (多一条引用只会少报孤儿),B8 拿它判存在性就是说「你的文件丢了」;所以那种值在这里
//     **不判存在性**,只按「写法认不出」开口(判据 6 的第二档)。
//   · `run/main_scene` / `config/icon` / `config/features` 的键名与写法:`godotIni.test.mjs:52-54`
//     的夹具,与本仓自己写 project.godot 的两处模板
//     (`src-ztools/preload/lib/projects.js:278-300`、`src-tauri/src/projects.rs:262-267`)逐行一致。
//   · 整数键只报两个:`godotIni.test.mjs:58-59` 是本仓真实写出的
//     `window/size/viewport_width=1280` / `viewport_height=720`。**[rendering] 的整数族与
//     `window_width_override`/`window/height_override` 一族整族不做** —— 仓库里(含两份写盘模板、
//     全部测试夹具)举不出任何一条真实文本,凭印象列键名就是拿「你的配置不对」去骗用户改文件。
//   · 渲染器 feature 名只有三个:`projects.js:169-172` 与 `projects.rs:243-247` 那两张
//     渲染器表(两端逐字一致的 'Forward Plus' / 'Mobile' / 'GL Compatibility'),
//     而模板一次只写其中一个 → 数组里同时出现两个就是本工具**能直接观测**的冲突,不需要引擎主张。
//   · 「场景文件头部首 token 是 gd_scene」:`parsers/sceneRefs.ts:73-80` 与 `inspectors/uid.ts:74-78`
//     的既有读法,夹具见 `orphans.test.mjs:74`、`refIndex.test.mjs:77`。
//   · 存在性查不到 = error 的先例:`brokenRefs.ts:1` 与它 :33-35 记下的教训(精确大小写查表
//     会把其实存在的文件说成丢失,而那是本仓唯一的 error 级结论)。
// 反过来,**本文件不主张编辑器的任何具体后果**:仓库里没有引擎的配置读取器,也读不到编辑器的输出,
// 所以每条 detail 都只说「盘上这份文件写了什么 / 这次清单里查不到什么」,把核对动作交给用户。
// 两条明写不做的判据也不越界:features 与**绑定引擎版本**的比对(ToolContext 只有 tree + readText,
// 拿不到引擎绑定信息,判它就得新加契约或跨模块取数 —— 简报判据 9 第二条,已上报但本轮不动),
// 以及 spec #3 提到的 boot splash 缺失(本轮举不出「哪个键、缺了会怎样」的仓库内出处)。
//
// 存在性一律 `lowerRelSet(ctx.tree)` + `hasRelCI()` 查表(treeUtils.ts:102-118,B6 评审裁定 2 的
// 共享小写像),不做精确大小写比对;★ 这条闸在 ini.test.mjs 里配了**正向对照**(把树里那份拿掉
// 必须出 error),否则「不报」可能只是那条值压根没进面。
//
// `ctx.truncated` 的降级口径与 imports.ts:17-20、addons.ts:42-44 一致(B6 裁定 3):作废的是**存在性
// 主张**(单例/主场景/图标点名的文件在不在),内容型判据(重复键、畸形行、config_version 档位、
// 值的写法、整数形态、features 撞名)只看这份配置自己的正文,照常判;降级卡仍排首位。
// 简报判据 10 把「5/6/7」整体称作存在性判据,而 6/7 里各有一条纯内容的档(写法认不出、头部首 token),
// 本轮按 B6 裁定 3 的**证据形状**切:证据是「清单里查不到」的才停用,证据是「这行自己写成什么样」的照判。
//
// 成本红线(判据 10):本工具最多读 **2 个文件** —— 根目录 project.godot 一次,
// 加上「主场景存在且是 .tscn」时那一份的头部核对一次。**不调 buildRefIndex**、不扫全项目、
// 不碰 .gdignore(只读一份配置文件,屏蔽目录与它无关),也不碰 window / services / vue / DOM。
//
// 结论顺序定死的类别序(类内一律按码元序 `.sort()`,与 addons.ts:139 的 byText 同语义而不再加一份
// 比较器 —— 台账 B5 收尾点名 byText 已有两份、LIST_CAP 已有三份,别再加第四第五份):
// 降级卡 → error(autoload 按名 → main_scene)→ warn(dup → problem → config_version →
// main_scene 写法/头部 → 整数键 → features → icon)→ info(config_version 缺失)。
import type { Finding, ToolContext } from '../types'
import type { TreeEntry } from '../../types/godot'
import type { IniDoc, IniValue } from '../parsers/godotIni'
import { getIni, getIniInt, getIniList, getIniRaw, parseGodotIni } from '../parsers/godotIni'
import { resToRel } from '../parsers/sceneRefs'
import { hasRelCI, lowerRelSet } from '../treeUtils'
import { LIST_CAP, truncatedFinding } from '../finding'

/** 根目录那份配置的文件名(只认根目录那一份,与 addons.ts:161-170 同一口径) */
const INI_BASENAME = 'project.godot'
/** [autoload] 段名:每条键名就是单例名,这条判据的证据必须落到「哪一条」 */
const AUTOLOAD_SECTION = 'autoload'
/** 简报点名的四个 fullKey(段名 + '/' + 键名,判据 1 的唯一取法) */
const KEY_MAIN_SCENE = 'application/run/main_scene'
const KEY_ICON = 'application/config/icon'
const KEY_FEATURES = 'application/config/features'
const KEY_CONFIG_VERSION = 'config_version'
/**
 * 判据 8 的整数键清单:**只有这两个**。依据是仓库里真实写出的那两行
 * (`__tests__/godotIni.test.mjs:58-59` 的 `window/size/viewport_width=1280` / `viewport_height=720`)。
 * 简报提的 `window_width_override` / `window/height_override` 一族与 [rendering] 的整数族在仓库里
 * (两份写盘模板 + 全部夹具)一条真实文本都没有,所以整族不做 —— 见文件头的取证纪律。
 */
const INT_KEYS = ['display/window/size/viewport_width', 'display/window/size/viewport_height']
/**
 * 判据 9 认的三个 feature 名:逐字取自本仓两端写盘的那两张渲染器表
 * (`projects.js:169-172`、`projects.rs:243-247`),数组顺序就是 detail 的点名顺序。
 * 大小写敏感是刻意的:只认这两张表里能举证的拼写,别的一律不算(方向是少报)。
 */
const RENDERER_FEATURES = ['Forward Plus', 'Mobile', 'GL Compatibility']
/** 场景文件头部应有的首 token(sceneRefs.ts:73-80 与 uid.ts:74-78 的既有读法) */
const SCENE_HEAD_TOKEN = 'gd_scene'

/** 展示上限:重复行/畸形行都按它裁切(共享在 finding.ts:46-56,不再抄第四份字面量) */
/** 单条原文在 detail 里的长度上限:多行块与长串不能把卡片撑爆(本文件独有,别处没有同形需求) */
const RAW_CAP = 60

/** 排除与「不判」的逐类计数,写进结论 detail(B5 立下的口径:排除要看得见) */
interface Excl {
  /** [autoload] 里值不是可判的项目路径写法的条数(含下面这一类) */
  auSkip: number
  /** 其中 `$另一个单例` 引用形态的条数(那种值本来就不是路径,不是「写坏了」) */
  auRef: number
  /** config/icon 的值不是可判的项目路径写法 */
  iconSkip: number
}

/** 一个值读出来的路径形态:`why` 是给 user 看的「为什么判不了」,只有 other/ref 才用它 */
type Form =
  | { kind: 'none' }
  | { kind: 'path'; rel: string; text: string }
  | { kind: 'ref' | 'other'; why: string }

interface AuHit { name: string; rel: string; text: string; line?: number }
interface MsHit { rel: string; text: string; line?: number }
interface FormHit { raw: string; why: string; line?: number }
interface HeadHit { rel: string; token: string; head: string; line?: number }
interface IconHit { rel: string; text: string; line?: number }
interface IntHit { key: string; raw: string; line?: number }
interface FeatHit { found: string[]; feats: string[]; line?: number }

/**
 * 键的完整形态(段名 + '/' + 键名,顶层键就是键名本身)。照 godotIni.ts:207-211 的 `fullKeyOf` ——
 * 那个函数没导出,而判据 2 要按键分组数 `values`,只能就地拼这一条字符串(不是第二份解析规则)。
 */
function keyOf(v: IniValue): string {
  const sec = typeof v.section === 'string' ? v.section : ''
  const key = typeof v.key === 'string' ? v.key : ''
  return sec ? `${sec}/${key}` : key
}

/** 原文进 detail 前的裁切:多行块与超长串折成一行,不把卡片撑爆(证据本身仍在文件里) */
function brief(raw: string): string {
  const t = raw.replace(/\s+/g, ' ').trim()
  return t.length > RAW_CAP ? `${t.slice(0, RAW_CAP)}…` : t
}

/**
 * 一个配置值是不是「能归一成项目内路径」的写法?只认两种形态,与 B2 的两条通道一一对应:
 *   · **恰好一对引号**包住的串 —— `getIni` 会解码它(godotIni.ts:231-240),所以 `decoded !== raw`
 *     就是「这是一对引号」的现成判据,本工具不另写引号配平;
 *   · **不带引号而整串就是一个路径**的裸值(godotIni.ts:283-291 的裸值通道)——
 *     这种值里只要混进空白或半个引号,`resToRel` 切出来的是「路径 + 别的东西」那种串,
 *     拿它去比清单就会把其实存在的文件说成丢失,所以那种值**不判存在性**,只报「写法认不出」。
 * `stripStar` 只给 [autoload] 用:`*` 是启用单例的标记(godotIni.ts:399-402),
 * 别的键前导 `*` 不是本仓任何出处里出现过的写法,不替它猜。
 */
function readPathValue(doc: IniDoc, fullKey: string, stripStar: boolean): Form {
  const raw = getIniRaw(doc, fullKey)
  if (raw === undefined) return { kind: 'none' }
  const decoded = getIni(doc, fullKey)
  if (decoded === undefined) return { kind: 'none' }
  const quoted = decoded !== raw
  let body = decoded
  if (stripStar && body.startsWith('*')) body = body.slice(1)
  if (!quoted && /[\s"]/.test(body)) {
    return { kind: 'other', why: '值没加引号,而串里还混着空白或半个引号,归一出来的是「路径 + 别的东西」那种串' }
  }
  if (body.startsWith('$')) return { kind: 'ref', why: '值是 `$另一个单例` 的引用形态,那本来就不是路径' }
  if (!body.startsWith('res://')) return { kind: 'other', why: '值不是 res:// 开头的路径写法(user://、绝对路径等)' }
  const rel = resToRel(body)
  if (rel === null) return { kind: 'other', why: 'res:// 之后那段归一不出项目内路径(越界 ..、带盘符、或裸 res://)' }
  // text 留**解码后但未剥 `*`** 的原值:detail 要把用户实际写的那一句还给他(godotIni.ts:225-229 的 raw 带引号,不适合上卡面)
  return { kind: 'path', rel, text: decoded }
}

/**
 * 场景/资源正文的**首 token**:取第一行**非空**行,去掉段头的左方括号再取开头的标识符。
 * 这里比 `uid.ts:74-78` 的 headerUid **宽一档**是刻意的:那边只读第一行(空行就当没有声明),
 * 这里跳过前导空行,免得把「真实场景恰好以空行开头」读成「不是场景」—— 两种读法都只在
 * 少报的那一侧动,而这一条判据的证据(文件自己第一非空行的原文)不受影响。
 */
function firstToken(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim()
    if (!t) continue
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(t.replace(/^\[/, ''))
    return m ? m[0] : ''
  }
  return ''
}

/** 第一非空行的原文(证据要能抄给用户看,不能只说「首 token 不对」) */
function firstLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim()
    if (t) return t
  }
  return ''
}

/** 每条结论都要带的那句:本工具不动手,核对动作交给用户 */
const REPORT_ONLY = ' 本工具只报告:不改写 project.godot、不代删这一行,也不替你决定留哪一条写法。'

/** 排除计数(判据 5/7 的「不判」要看得见),写法照 addons.ts:179-188 的 exclNote 同一读法 */
function exclNote(ex: Excl): string {
  const bits: string[] = []
  if (ex.auSkip) {
    bits.push(`[autoload] 里 ${ex.auSkip} 条的值不是可判的项目路径写法、没做存在性判定` +
      (ex.auRef ? `(其中 $单例引用 ${ex.auRef} 条)` : ''))
  }
  if (ex.iconSkip) bits.push('config/icon 的值不是可判的项目路径写法,同样没判它在不在')
  return bits.length ? ` 本次未判定:${bits.join('；')}。` : ''
}

/** 判据 2:同一 section/key 出现两次以上 —— 一条卡把所有行号与各自原文列出来 */
function dupFinding(key: string, items: IniValue[], iniRel: string, ex: Excl): Finding {
  const last = items[items.length - 1]
  const n = items.length
  const shown = items.slice(0, LIST_CAP).map((v) => `第 ${v.line} 行 ${brief(v.raw)}`).join('；')
  const hidden = n - Math.min(n, LIST_CAP)
  return {
    // id 落到 fullKey:同一个键再写几遍仍是这一条待办(不含出现次序的下标)
    id: `ini:dup:${key}`,
    severity: 'warn',
    title: `同一个键在这份配置里写了两遍以上：${key}`,
    detail: `${key} 一共出现 ${n} 次：${shown}${hidden ? ` 等(另有 ${hidden} 处未列出)` : ''}。` +
      ` 本工具的取键读法是「重复取最后一条」—— 这条约定是本仓 project.godot 读法自己的口径` +
      `(写在 parsers/godotIni.ts:214 的 findLast 上,B2 起就只有一份),所以读到的是第 ${last.line} 行那一条。` +
      ` 「你以为生效的写法」与「实际读到的那一条」可能不是同一句:请在编辑器的 项目设置 里核对当前值,再决定删哪一行。` +
      `${REPORT_ONLY}${exclNote(ex)}`,
    rel: iniRel,
    line: last.line
  }
}

/** 判据 3:parseGodotIni 回报的畸形行,逐行一条(超过 LIST_CAP 才聚合成一条) */
function problemFinding(p: { line: number; text: string; reason: string }, iniRel: string): Finding {
  return {
    // id 落在行号上:每一条畸形行各自可忽略,不因为聚合而互相顶掉(行号就是证据,不是数组下标)
    id: `ini:problem:${p.line}`,
    severity: 'warn',
    title: `这一行没被读成任何配置：第 ${p.line} 行`,
    detail: `第 ${p.line} 行的原文是「${brief(p.text)}」，${p.reason}。` +
      ` 这是 parsers/godotIni.ts 的 parseGodotIni 自己回报的 problems 之一,本工具没有另找一类畸形、` +
      `也没给它编第二套说法。这一行现在读不出任何键值(段头也不算),它会不会连带影响前后几行由编辑器决定,` +
      `本工具读不到编辑器的输出。建议把这份文件与版本库里的上一份对一下再改。` +
      REPORT_ONLY,
    rel: iniRel,
    line: p.line
  }
}

/** 判据 3 的聚合形态(畸形行多到刷屏时):逐条卡换成一条,总行数与裁掉的数量照样说出来 */
function problemsAllFinding(problems: { line: number; text: string; reason: string }[], iniRel: string): Finding {
  const shown = problems.slice(0, LIST_CAP).map((p) => `第 ${p.line} 行「${brief(p.text)}」(${p.reason})`).join('；')
  const hidden = problems.length - Math.min(problems.length, LIST_CAP)
  return {
    id: 'ini:problem:all',
    severity: 'warn',
    title: `这份配置里有 ${problems.length} 行没被读成任何键值`,
    detail: `${shown}${hidden ? ` 等(另有 ${hidden} 行未列出,共 ${problems.length} 行)` : ''}。` +
      ` 逐条来源是 parseGodotIni 回报的 problems,本工具没有另找一类畸形。行数多到这张卡时,` +
      `本工具只列前 ${LIST_CAP} 行:请优先把这份文件与版本库里的上一份整体对比,而不是逐行猜。` +
      REPORT_ONLY,
    rel: iniRel
  }
}

/** 判据 4:值存在但不是裸整数 */
function cvBadFinding(raw: string, line: number | undefined, iniRel: string): Finding {
  return {
    id: 'ini:config-version',
    severity: 'warn',
    title: `config_version 读不出整数：${brief(raw)}`,
    detail: `第 ${line ?? '?'} 行写的是 config_version=${brief(raw)}，本工具读不出裸整数 ——` +
      ` 带引号的数字、小数、带字母、数组形态都算读不出(只认裸整数是 parsers/godotIni.ts:252-261 的 getIniInt 既有口径)。` +
      ` 本仓两处新建项目的模板都写 config_version=5(src-ztools/preload/lib/projects.js:287、src-tauri/src/projects.rs:266)。` +
      ` 这一行到底该是什么由编辑器决定,本工具读不到它的输出,所以不替你断言现在这个值就是错的 —— 请在编辑器的 项目设置 里核对。` +
      REPORT_ONLY,
    rel: iniRel,
    line
  }
}

/** 判据 4:头部没有这一行 —— info,而且不许说成「值为 0」 */
function cvMissingFinding(iniRel: string): Finding {
  return {
    id: 'ini:config-version',
    severity: 'info',
    title: '这份 project.godot 的头部没有 config_version 这一行',
    detail: '任何段头之前的那一行 config_version=… 在这份文件里没有。这是「这一行不存在」,' +
      '不是「值写成 0」:本仓的解析器把缺失记成 0,而它明确不许把 0 当成值(parsers/godotIni.ts:58-59)。' +
      '其余键照样读得到,本工具因此不判它是错,也不说缺了这一行编辑器会怎么处理 —— 那读不到。' +
      '想确认就在编辑器里打开这个项目,看 项目设置 能不能正常读出来。' + REPORT_ONLY,
    rel: iniRel
  }
}

/** 判据 5:单例点名的文件在这次清单里查不到 —— error(证据形状与 brokenRefs.ts:1 同类) */
function autoloadFinding(h: AuHit, iniRel: string, ex: Excl): Finding {
  return {
    // id 落在单例名上:证据就是「哪一条 autoload」,不含出现次序的下标
    id: `ini:autoload-missing:${h.name}`,
    severity: 'error',
    title: `启用单例点名的文件不在本次文件清单里：${h.name}`,
    detail: `[${AUTOLOAD_SECTION}] 的 ${h.name} 写的是 "${h.text}"，去掉启用标记 ` +
      `* 后归一成项目内路径 ${h.rel}，而它在这次文件清单里查不到（任意大小写写法都没有）。` +
      ` 这条结论只说到「配置点名的文件读不到」,不猜它为什么不在(改名、删除、搬走、还是清单本身没扫全都可能),` +
      `也不说编辑器会因此报什么(读不到它的输出)。想核对就在编辑器的 项目设置 里看这一条单例指向哪里,` +
      `或把文件放回原位让编辑器重扫。` +
      `${exclNote(ex)}${REPORT_ONLY}`,
    rel: iniRel,
    line: h.line
  }
}

/** 判据 6 第一档:主场景点名的文件不在清单 —— 与判据 5 同形状的 error */
function mainSceneFinding(h: MsHit, iniRel: string, ex: Excl): Finding {
  return {
    id: 'ini:main-scene-missing',
    severity: 'error',
    title: `主场景点名的文件不在本次文件清单里：${h.rel}`,
    detail: `[application] 的 run/main_scene 写的是 "${h.text}"，归一成项目内路径 ${h.rel}，` +
      `而它在这次文件清单里查不到（任意大小写写法都没有）。这条只说到「配置点名的文件读不到」,` +
      `不猜原因,也不说编辑器打开项目时会发生什么(本工具读不到它的输出)。` +
      `请在编辑器的 项目设置→运行 里核对主场景那一项,或把场景放回原位。` +
      `${exclNote(ex)}${REPORT_ONLY}`,
    rel: iniRel,
    line: h.line
  }
}

/** 判据 6 第二档:值读不成路径写法 —— warn,主张只是「我们认不得这个写法」 */
function msFormFinding(h: FormHit, iniRel: string): Finding {
  return {
    id: 'ini:main-scene-form',
    severity: 'warn',
    title: `主场景的写法本工具认不出来：${brief(h.raw)}`,
    detail: `[application] 的 run/main_scene 现在写的是 ${brief(h.raw)}：${h.why}。` +
      ` 本工具认得的两种写法是「恰好一对引号包住的 res:// 路径」与「整串就是一个 res:// 路径的裸值」` +
      `(后者是编辑器外手改的常见形态,B2 的 iniResPaths 也按这一种认,见 parsers/godotIni.ts:283-291)。` +
      `两种都不是时本工具**不判那个文件在不在** —— 那要先把值读成一个路径,而现在这个值读不出:` +
      `归一出来的串不能当真实路径用,拿它去比清单就会得出「文件丢了」这种本工具撑不起的说法。` +
      `请在编辑器的 项目设置→运行 里看主场景那一项实际是什么。` +
      REPORT_ONLY,
    rel: iniRel,
    line: h.line
  }
}

/** 判据 6 的可选核对:那个 .tscn 自己的头部说的不是场景形态 —— warn,证据是它自己的第一行 */
function notSceneFinding(h: HeadHit, iniRel: string): Finding {
  return {
    id: 'ini:main-scene-not-scene',
    severity: 'warn',
    title: `主场景那个文件自己不是场景形态：${h.rel}`,
    detail: `run/main_scene 归一成 ${h.rel},它在清单里,所以本工具读了它自己的正文(本轮第二个也是最后一个文件)。` +
      `第一非空行是「${brief(h.head)}」，首 token 是 ${h.token} 而不是 ${SCENE_HEAD_TOKEN}` +
      `(场景文件头部写 gd_scene 这个规范形的既有出处: parsers/sceneRefs.ts:73-80,` +
      `仓库里真实写出的场景头部见 __tests__/orphans.test.mjs:74 与 __tests__/refIndex.test.mjs:77)。` +
      `这条只说到「这个文件自己没写成场景形态」,不断言它能不能当主场景用(那是编辑器的决定,本工具读不到它的输出)。` +
      REPORT_ONLY,
    rel: iniRel,
    line: h.line,
    // related 只放**读得到**的文件;缺失的目标留在 detail 里说,不进跳转面(B10 待办 4:related 是证据不是落点)
    related: [h.rel]
  }
}

/** 判据 7:图标点名的文件不在清单 —— warn(不是 error:档位就按「我们只能证明清单里没有」定) */
function iconFinding(h: IconHit, iniRel: string, ex: Excl): Finding {
  return {
    id: 'ini:icon-missing',
    severity: 'warn',
    title: `项目图标点名的文件不在本次文件清单里：${h.rel}`,
    detail: `[application] 的 config/icon 写的是 "${h.text}"，归一成 ${h.rel}，而它在这次文件清单里查不到` +
      `（任意大小写写法都没有）。这条停在 warn 而不是 error:本工具能证明的只有「清单里没有」,` +
      `图标缺失会不会影响项目运行、编辑器会不会改用别的显示,都在我们读不到的那一侧。` +
      `想核对就在编辑器的 项目设置 里看图标那一项(本仓新建项目的模板写的是 config/icon="res://icon.svg",` +
      `见 src-ztools/preload/lib/projects.js:293、src-tauri/src/projects.rs:266)。` +
      `${exclNote(ex)}${REPORT_ONLY}`,
    rel: iniRel,
    line: h.line
  }
}

/** 判据 8:已知是整数的键读不出整数 */
function intFinding(h: IntHit, iniRel: string): Finding {
  return {
    id: `ini:int:${h.key}`,
    severity: 'warn',
    title: `这个键的值本工具读不出整数：${h.key}`,
    detail: `第 ${h.line ?? '?'} 行的 ${h.key} 现在写的是 ${brief(h.raw)}，` +
      `而本工具读不出整数:带引号的数字、小数、带单位、纯文字都算读不出(只认裸整数是 getIniInt 的既有口径,` +
      `parsers/godotIni.ts:252-261)。这条只说「本工具读不出」,不主张这个写法会不会被谁接受 —— 请在编辑器的` +
      ` 项目设置 里核对这一项。覆盖面:本判定只认 ${INT_KEYS.join(' 与 ')} 这两个键,` +
      `依据是仓库里真实写出的那两行(__tests__/godotIni.test.mjs:58-59);` +
      `[rendering] 的整数族与各 override 一族在本仓里举不出真实文本,所以没做。` +
      REPORT_ONLY,
    rel: iniRel,
    line: h.line
  }
}

/** 判据 9:features 数组里同时出现两个互斥的渲染器名 —— 证据就是数组本身 */
function featuresFinding(h: FeatHit, iniRel: string): Finding {
  return {
    id: 'ini:features-renderers',
    severity: 'warn',
    title: `config/features 同时列了 ${h.found.length} 个渲染器名：${h.found.join('、')}`,
    detail: `第 ${h.line ?? '?'} 行的 config/features 读到的是数组 ${JSON.stringify(h.feats)}，` +
      `其中 ${h.found.join(' 与 ')} 同时出现。这三个名字逐字取自本仓两端新建项目时那两张渲染器表` +
      `(src-ztools/preload/lib/projects.js:169-172、src-tauri/src/projects.rs:243-247),` +
      `而模板一次只写其中一个 —— 所以两个都在就是这一行被手改或合并过的形态。` +
      `到底哪个渲染器实际生效,以编辑器的 项目设置→渲染 为准,本工具不替你判断。` +
      `本工具也**不**把数组里那串版本号(如 "4.4")与项目绑定的引擎版本相比:` +
      `ToolContext 只有文件树与文本读取,拿不到引擎绑定信息,要比就得先加契约。` +
      REPORT_ONLY,
    rel: iniRel,
    line: h.line
  }
}

const WHY_TRUNC =
  '启用单例、主场景、项目图标这三条都拿整份文件清单比「配置点名的那个文件在不在」—— 清单不全时' +
  '「查不到」不是证据,它会把其实存在的文件说成丢失(而且前两条正是本工具仅有的 error),所以这三条本次不做。' +
  '重复键、畸形行、config_version 档位、值的写法、整数形态、features 撞渲染器名这几条只看这份配置自己的正文,' +
  '与清单全不全无关,本次照常判(与 imports/uid/addons 保留内容型判据同一读法)。' +
  '请把 maxEntries 调高或做一次完整重扫后再看 —— 别用排除目录、按扩展名筛选这类过滤来「缩小范围」:' +
  '那样得到的清单同样不完整,却不会再带截断标记,结论只会更假。'

const TRUNC_TITLE = '文件清单被截断，本次不做 project.godot 的路径存在性判定（重复键、畸形行、写法那几条照常判）'

export async function run(ctx: ToolContext): Promise<Finding[]> {
  const tree = Array.isArray(ctx.tree) ? ctx.tree : []
  const truncated = ctx.truncated === true

  // ---------- 读那一份配置(唯一的整文件读取) ----------
  // 存在性口径用小写像(lowerRelSet + hasRelCI,B6 裁定 2);另备一张「小写 → 树里真存在的条目」表,
  // 它**不参与**任何存在性判断,只为两件事:① 读 project.godot 时问对写法(硬拼 'project.godot'
  // 在 Project.godot 那种清单上会读空);② 判 main_scene 是不是 .tscn 时用条目自带的 ext,
  // 不在这里再抄一份 ext 推导(imports.ts:128-132 已有一份,别再长出第二份)。
  const lower = lowerRelSet(tree)
  const entryOf = new Map<string, TreeEntry>()
  let iniExact: string | undefined
  let iniAlt: string | undefined
  for (const f of tree) {
    const rel = f && typeof f.rel === 'string' ? f.rel : ''
    if (!rel) continue
    const k = rel.toLowerCase()
    const kept = entryOf.get(k)
    if (!kept || rel < kept.rel) entryOf.set(k, f)
    if (rel.includes('/')) continue // 只认根目录那一份(子目录里的同名文件不是项目配置)
    if (rel === INI_BASENAME) iniExact = rel
    else if (k === INI_BASENAME && (iniAlt === undefined || rel < iniAlt)) iniAlt = rel
  }
  const iniRel = iniExact ?? iniAlt
  // 清单里没有这份配置(非 Godot 目录/没扫到)或读不到 → 十一条判据一条都没起跑,连降级卡也不发:
  // 那时候发一张卡只会让用户以为「体检过并发现问题」,而实际是压根没数据。
  if (!iniRel) return []
  const { text: iniText } = await ctx.readText(iniRel)
  if (typeof iniText !== 'string') return []
  const doc = parseGodotIni(iniText)

  const ex: Excl = { auSkip: 0, auRef: 0, iconSkip: 0 }
  // 键 → 出现清单(文件序):判据 2 唯一的证据来源,也用来取「最后一条」的行号
  const groups = new Map<string, IniValue[]>()
  for (const v of doc.values) {
    if (!v || typeof v.key !== 'string') continue
    const arr = groups.get(keyOf(v))
    if (arr) arr.push(v)
    else groups.set(keyOf(v), [v])
  }
  const lastOf = (fullKey: string): IniValue | undefined => {
    const arr = groups.get(fullKey)
    return arr ? arr[arr.length - 1] : undefined
  }

  // ---------- 判据 2:重复键(全部 section/key 都数,不只盯那几个我们认识的键) ----------
  // 排序一律「取键名数组 + 默认 .sort()」:默认比较就是 UTF-16 码元序(与 byText 同语义),
  // 而台账 B5 收尾点名 byText/LIST_CAP 别再长出新副本,所以这里不再抄一条比较器。
  const dupKeys = [...groups.keys()].filter((k) => (groups.get(k) || []).length >= 2).sort()

  // ---------- 判据 4 + 判据 3 的交界:config_version 那一行由判据 4 说,不重复报 ----------
  const cvRaw = getIniRaw(doc, KEY_CONFIG_VERSION)
  const cvLast = lastOf(KEY_CONFIG_VERSION)
  const cvBad = cvRaw !== undefined && getIniInt(doc, KEY_CONFIG_VERSION) === undefined
  // parseGodotIni 在「只有一条而它不是裸整数」时把它也塞进 problems(godotIni.ts:191-196),
  // 同一行两张卡就是噪音,所以那一行交给判据 4 的那条结论说话。
  const problems = doc.problems.filter(
    (p) => !(cvBad && cvLast !== undefined && p.line === cvLast.line)
  )

  // ---------- 判据 5:[autoload] 逐条(键名就是证据的一部分,所以不走 iniResPaths 的聚合结果) ----------
  const auNames: string[] = []
  {
    const seenName = new Set<string>()
    for (const v of doc.values) {
      if (!v || v.section !== AUTOLOAD_SECTION || typeof v.key !== 'string' || !v.key) continue
      if (seenName.has(v.key)) continue
      seenName.add(v.key)
      auNames.push(v.key)
    }
  }
  auNames.sort()
  const auHits: AuHit[] = []
  for (const name of auNames) {
    const full = `${AUTOLOAD_SECTION}/${name}`
    const form = readPathValue(doc, full, true)
    if (form.kind === 'path') {
      // 截断时不做:这条是 error,而 error 的证据「清单里没有」在清单不全时不成立(判据 10)
      if (!truncated && !hasRelCI(lower, form.rel)) {
        auHits.push({ name, rel: form.rel, text: form.text, line: lastOf(full)?.line })
      }
    } else if (form.kind !== 'none') {
      ex.auSkip++
      if (form.kind === 'ref') ex.auRef++
    }
  }

  // ---------- 判据 6:run/main_scene(三档:缺失 error / 写法 warn / 头部 warn) ----------
  const msKey = KEY_MAIN_SCENE
  const msRaw = getIniRaw(doc, msKey)
  const msLine = lastOf(msKey)?.line
  let msMissing: MsHit | undefined
  let msForm: FormHit | undefined
  let msHead: HeadHit | undefined
  if (msRaw !== undefined) {
    const form = readPathValue(doc, msKey, false)
    if (form.kind === 'path') {
      const sceneEntry = entryOf.get(form.rel.toLowerCase())
      // 两个条件是同一件事的两面,都要:`hasRelCI(lower, …)` 是判据要求的存在性口径(唯一一份小写像),
      // `sceneEntry` 只是把那个口径下命中的**写法**取回来好去读文件(小写像本身给不出原文写法)。
      if (sceneEntry && hasRelCI(lower, form.rel)) {
        // 可选项(判据 6):只读这一个文件,而且只读 .tscn。读不到文本就当未知,不报(brokenRefs.ts:7-9 同口径)
        if (sceneEntry.ext === 'tscn') {
          const { text: sc } = await ctx.readText(sceneEntry.rel)
          if (typeof sc === 'string') {
            const tok = firstToken(sc)
            if (tok && tok !== SCENE_HEAD_TOKEN) {
              msHead = { rel: sceneEntry.rel, token: tok, head: firstLine(sc), line: msLine }
            }
          }
        }
      } else if (!truncated) {
        msMissing = { rel: form.rel, text: form.text, line: msLine }
      }
    } else if (form.kind !== 'none') {
      msForm = { raw: msRaw, why: form.why, line: msLine }
    }
  }

  // ---------- 判据 7:config/icon(只有「归一后不在清单」这一种主张) ----------
  const iconKey = KEY_ICON
  const iconRaw = getIniRaw(doc, iconKey)
  let iconHit: IconHit | undefined
  if (iconRaw !== undefined) {
    const form = readPathValue(doc, iconKey, false)
    if (form.kind === 'path') {
      if (!truncated && !hasRelCI(lower, form.rel)) {
        iconHit = { rel: form.rel, text: form.text, line: lastOf(iconKey)?.line }
      }
    } else if (form.kind !== 'none') ex.iconSkip++
  }

  // ---------- 判据 8:整数键形态(INT_KEYS 已按码元序,不需要再排) ----------
  const intHits: IntHit[] = []
  for (const key of INT_KEYS) {
    const raw = getIniRaw(doc, key)
    if (raw === undefined) continue
    if (getIniInt(doc, key) === undefined) intHits.push({ key, raw, line: lastOf(key)?.line })
  }

  // ---------- 判据 9:features 里撞渲染器名(数组取不到就当未知) ----------
  let featHit: FeatHit | undefined
  {
    const feats = getIniList(doc, KEY_FEATURES)
    if (feats) {
      const found = RENDERER_FEATURES.filter((r) => feats.includes(r))
      if (found.length >= 2) featHit = { found, feats, line: lastOf(KEY_FEATURES)?.line }
    }
  }

  // ---------- 组装:定死的类别序 + 类内码元序(逐字节确定) ----------
  const out: Finding[] = []
  if (truncated) out.push(truncatedFinding('ini', WHY_TRUNC, TRUNC_TITLE))
  for (const h of auHits) out.push(autoloadFinding(h, iniRel, ex))
  if (msMissing) out.push(mainSceneFinding(msMissing, iniRel, ex))
  for (const key of dupKeys) out.push(dupFinding(key, groups.get(key) || [], iniRel, ex))
  if (problems.length > LIST_CAP) out.push(problemsAllFinding(problems, iniRel))
  else for (const p of problems) out.push(problemFinding(p, iniRel))
  if (cvBad && cvRaw !== undefined) out.push(cvBadFinding(cvRaw, cvLast?.line, iniRel))
  if (msForm) out.push(msFormFinding(msForm, iniRel))
  if (msHead) out.push(notSceneFinding(msHead, iniRel))
  for (const h of intHits) out.push(intFinding(h, iniRel))
  if (featHit) out.push(featuresFinding(featHit, iniRel))
  if (iconHit) out.push(iconFinding(iconHit, iniRel, ex))
  if (cvRaw === undefined) out.push(cvMissingFinding(iniRel))
  return out
}
