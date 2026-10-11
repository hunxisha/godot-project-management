// GDScript 批量重命名 · 插件入口(§3 P1 第 15–19 项 / A-20 ~ A-24 的数据侧)。
//
// 三个模块各管一段,这条分工是本工具最要紧的读法:
//   · `modes.ts` —— 新名叫什么(纯字符串运算,不知道盘上有什么);
//   · `refs.ts`  —— 引用点在哪一处、怎么改(纯文本运算,不做 IO);
//   · **本文件** —— 把两者接到 ctx 上:读选中集、算新名、拿引用索引、逐文件改写、产出 `Change[]`。
//
// 本文件**不写盘也不改名**:rename 由框架的执行通道做(§G Task 15/16),rewrite 走 `payload.text`。
// 所以这里不实现 `apply` —— action 型工具从来拿不到裸写接口(§5.2),改名也不是它能做的事。
//
// 三条容易做错的判据,写在离代码最近的地方:
//   1. **`dangling` 与真正会改的处数出自同一趟改写**。开关关掉时它是「全部可证明引用点」,
//      打开时是「读不到而没能改上的那些」—— 两种成因同一个字段,A-22 那句「N 与实际断链数一致」
//      在两个开关位置都要成立,靠的就是不另起第二套计数。
//   2. **一个引用者只读一次、只改一次**:一轮里所有改名构成同一张表,一次过替换。
//      既避免「A→B 之后又被 B→C 吃掉」的链式重复,也避免同一个文件读两遍。
//   3. **`{index}` 的位次 = `files` 的顺序 = 候选表顺序**(框架保证的唯一真源,§F 契约补充第 2 条),
//      所以同一批勾注重跑,序号分布必须一模一样。

import type { Change } from '../../../toolkit/change'
import type { FieldDesc } from '../../../toolkit/schema'
import { buildRenameMap, kindOfReferrer, resPath, rewriteRefs, unreadableReason } from './refs'
import { newNameFor, paramsFrom, regexHitsOnNames } from './modes'

/** 本工具的处理范围(用户 2026-10-11 拍板:只做脚本文本资源,导入资产不进选择面) */
const EXT_TARGETS = ['gd', 'tscn', 'tres']

/**
 * 参数表(§5.7 那张单子的原样落地)。
 *
 * ⚠ 这里的 `def` 必须与 `modes.ts` 的 `DEFAULT_PARAMS` 同值 —— 表单显示的默认值与实际执行的默认值
 * 分成两套是这类工具最容易被用户当成 bug 的地方(内置格式化同一条纪律,断言钉住)。
 */
export const schema: FieldDesc[] = [
  {
    key: 'targets',
    type: 'files',
    label: '要改名的文件',
    help: '只显示 .gd / .tscn / .tres;引用点可以是任何被索引的来源(.cs / .json / .gdshader / project.godot …)',
    required: true,
    def: [],
    min: null,
    max: null,
    options: [],
    exts: EXT_TARGETS,
    multiple: true,
    placeholder: ''
  },
  {
    key: 'mode',
    type: 'select',
    label: '模式',
    help: '四种模式都只改文件名那一段:扩展名永远不动(改成别的扩展名 Godot 就不认这个文件了)',
    required: false,
    def: 'regex',
    min: null,
    max: null,
    options: [
      { value: 'regex', label: '正则替换' },
      { value: 'affix', label: '加前缀 / 后缀' },
      { value: 'template', label: '命名模板' },
      { value: 'case', label: '大小写转换' }
    ],
    exts: [],
    multiple: false,
    placeholder: ''
  },
  {
    key: 'pattern',
    type: 'regex',
    label: '正则(作用在文件名上,不含扩展名)',
    help: '全局替换;表单上的命中数按选中的文件名统计',
    required: false,
    def: '',
    min: null,
    max: null,
    options: [],
    exts: [],
    multiple: false,
    placeholder: '^(enemy)_'
  },
  {
    key: 'replacement',
    type: 'text',
    label: '替换为',
    help: '可以用 $1 这种反向引用;替换后如果撞上前置空白、结尾点或平台不能用的字符,那一条会被跳过并说明原因',
    required: false,
    def: '',
    min: null,
    max: null,
    options: [],
    exts: [],
    multiple: false,
    placeholder: '$1_'
  },
  {
    key: 'prefix',
    type: 'text',
    label: '前缀',
    help: '加在文件名最前面(不含扩展名)',
    required: false,
    def: '',
    min: null,
    max: null,
    options: [],
    exts: [],
    multiple: false,
    placeholder: 'npc_'
  },
  {
    key: 'suffix',
    type: 'text',
    label: '后缀',
    help: '加在文件名最后面、扩展名之前',
    required: false,
    def: '',
    min: null,
    max: null,
    options: [],
    exts: [],
    multiple: false,
    placeholder: '_v2'
  },
  {
    key: 'template',
    type: 'text',
    label: '命名模板',
    help: '只认 {name} / {index} / {ext} 三个占位符,且必须含 {ext}({ext} 自带那个点,前面别再写点)',
    required: false,
    def: '{name}{index}{ext}',
    min: null,
    max: null,
    options: [],
    exts: [],
    multiple: false,
    placeholder: '{name}{index}{ext}'
  },
  {
    key: 'start',
    type: 'number',
    label: '序号起始',
    help: '第一个文件拿到的序号',
    required: false,
    def: 1,
    min: 0,
    max: 999999,
    options: [],
    exts: [],
    multiple: false,
    placeholder: ''
  },
  {
    key: 'digits',
    type: 'number',
    label: '序号位数',
    help: '左补零的位数;实际序号超过它时自然变宽(截断会让两个文件撞成同一个名字)',
    required: false,
    def: 2,
    min: 1,
    max: 9,
    options: [],
    exts: [],
    multiple: false,
    placeholder: ''
  },
  {
    key: 'case_mode',
    type: 'select',
    label: '大小写形式',
    help: 'lower / upper 只换大小写;pascal / snake 会按下划线、连字符、空格与驼峰边界切段',
    required: false,
    def: 'snake',
    min: null,
    max: null,
    options: [
      { value: 'lower', label: '全小写' },
      { value: 'upper', label: '全大写' },
      { value: 'pascal', label: 'PascalCase' },
      { value: 'snake', label: 'snake_case' }
    ],
    exts: [],
    multiple: false,
    placeholder: ''
  },
  {
    key: 'update_refs',
    type: 'boolean',
    label: '同时更新引用',
    help: '关掉它只改文件名:预览会用红字标出将有多少处引用留在旧名上(那些地方里的路径不会被改)',
    required: false,
    def: true,
    min: null,
    max: null,
    options: [],
    exts: [],
    multiple: false,
    placeholder: ''
  }
]

/** 框架交给 plan 的 ctx(只声明本工具真用到的那几个成员,形状由 gpm.ts 保证) */
interface PlanCtx {
  cancelled: boolean
  readText(rel: string): Promise<{ text: string, truncated: boolean, skippedBinary: boolean, bytes: number, error: string }>
  scanTree(opts?: { exts?: string[] }): Promise<{ files: { rel: string }[], truncated: boolean, error: string }>
  refIndex(): Promise<{
    index: { to: Map<string, { from: string }[]>, readFailures?: { rel: string, reason: string }[] } | null
    error: string
  }>
  log(level: string, msg: string): void
}

const relOf = (item: unknown): string => {
  const o = (item && typeof item === 'object' ? item : {}) as { rel?: unknown }
  return typeof o.rel === 'string' ? o.rel : ''
}

/**
 * 只算不写。
 *
 * 三种「不产条」都是有意的,每种都说得出原因:
 *   · 模式算不出合法新名(坏名字、正则没命中)⇒ 跳过 + 日志;
 *   · 改前改后同一个名字 ⇒ noop,不产一条假变更;
 *   · 引用索引拿不到 ⇒ **仍然改名**,但把所有引用点计进 `dangling`(那句红字因此是实话)。
 */
export async function plan(ctx: PlanCtx, files: unknown, params: unknown): Promise<Change[]> {
  const { p, skips } = paramsFrom(params)
  const raw = (params && typeof params === 'object' ? params : {}) as Record<string, unknown>
  const updateRefs = raw.update_refs !== false
  const list = Array.isArray(files) ? files : []
  const rels = list.map(relOf).filter((r) => !!r)
  if (skips.length) for (const s of skips) ctx.log('warn', `参数问题:${s}`)

  // ---- 1. 新名 ----
  const pairs: { from: string, to: string }[] = []
  for (let i = 0; i < rels.length; i++) {
    if (ctx.cancelled) break
    const n = newNameFor(p, rels[i], i + 1)
    if (n.error) { ctx.log('warn', `${rels[i]}:${n.error}`); continue }
    if (n.noop) { ctx.log('warn', `${rels[i]}:改前改后是同一个名字,跳过`); continue }
    pairs.push({ from: rels[i], to: n.to })
  }
  if (!pairs.length) return []
  const map = buildRenameMap(pairs)

  // ---- 2. 引用点 ----
  // 两条来路,合在一张候选表里:
  //   · **索引报的站点**:`ctx.refIndex()` 的 `to`(引号字面量通道)—— 精确规则不认时仍算断链,
  //     因为索引就是它的证据;
  //   · **ini 候选**:`project.godot` 与根级 `.cfg` 整个都当候选读一遍。
  //     非做不可的理由:索引只对 `project.godot` 走 ini 通道,其余源文件走「引号字面量」通道,
  //     而 `export_presets.cfg` 里的 `run/main_scene=res://main.tscn` 是**裸值没有引号** ⇒ 索引看不见它
  //     (那边的方向是宁多勿少地收引用,这种形态本来就没打算收)。候选总共就两三个文件,读得起。
  const idx = await ctx.refIndex()
  if (!idx.index) ctx.log('warn', `引用索引读不出来:${idx.error};这一批的引用点只能按已知的算,断链数是下限`)
  /** referrer rel → { targets, reported } */
  const referrers = new Map<string, { targets: string[], reported: boolean }>()
  const addRef = (rel: string, from: string, reported: boolean): void => {
    const cur = referrers.get(rel)
    if (cur) {
      if (!cur.targets.includes(from)) cur.targets.push(from)
      if (reported) cur.reported = true
      return
    }
    referrers.set(rel, { targets: [from], reported })
  }
  for (const pr of pairs) {
    const sites = idx.index ? (idx.index.to.get(pr.from) || []) : []
    for (const s of sites) {
      if (!s || typeof s.from !== 'string' || !s.from) continue
      addRef(s.from, pr.from, true)
    }
  }
  const tree = await ctx.scanTree({})
  // 清单被截断 ⇒ 「查不到引用」不是证据(refIndex 判据 7 的同一件事,那一侧是直接不读,这一侧要说出口)
  const treeIncomplete = tree.truncated === true
  if (treeIncomplete) ctx.log('warn', '文件清单在 maxEntries 处被截断:引用图不完整,断链数只能给下限')
  if (!tree.error) {
    const entries = Array.isArray(tree.files) ? tree.files : []
    for (const f of entries) {
      const rel = f && typeof f.rel === 'string' ? f.rel : ''
      if (!rel || kindOfReferrer(rel) !== 'ini') continue
      for (const pr of pairs) addRef(rel, pr.from, false)
    }
  }
  // 索引自己没读进去的源文件:里面有没有引用**不知道**,只能披露不能臆造(报 0 会说谎,报 1 会随项目规模虚涨)
  const unreadableSources = idx.index && Array.isArray(idx.index.readFailures)
    ? idx.index.readFailures.filter((x) => x && typeof x.rel === 'string' && !referrers.has(x.rel)).length
    : 0
  if (unreadableSources) {
    ctx.log('warn', `引用索引有 ${unreadableSources} 个文件没读进去(超限或二进制),断链数只是下限`)
  }

  /** from rel → 本可以改上的处数 / 没能改上的处数(读不到、或规则不认) */
  const canFix = new Map<string, number>()
  const cantFix = new Map<string, number>()
  for (const pr of pairs) {
    canFix.set(pr.from, 0)
    cantFix.set(pr.from, 0)
  }

  const rewrites: { rel: string, text: string, hits: number }[] = []
  for (const [refRel, info] of referrers) {
    if (ctx.cancelled) break
    const targets = info.targets
    const rd = await ctx.readText(refRel)
    const kind = kindOfReferrer(refRel)
    const siteCount = idx.index ? countSites(idx.index, refRel, targets) : 0
    if (rd.error || rd.truncated || rd.skippedBinary) {
      // 索引报了它、我们自己却读不到:里面**到底几处**说不清,按站点点数计(宁可多报不少报)
      if (info.reported) {
        for (const from of targets) cantFix.set(from, (cantFix.get(from) || 0) + Math.max(1, siteCount))
      }
      ctx.log('warn', `${refRel}:${unreadableReason(rd)},这一处的引用没法改`)
      continue
    }
    const full = rewriteRefs(kind, rd.text, map)
    if (!full.hits) {
      // 精确规则一处都不认。索引报过的 ⇒ 计进断链(那确实是没跟上的引用)并说清两边口径不同;
      // 只是候选的 ini 文件 ⇒ 本来就没提这条路径,不算断链。
      if (info.reported) {
        for (const from of targets) cantFix.set(from, (cantFix.get(from) || 0) + Math.max(1, siteCount))
        ctx.log('warn', `${refRel}:索引提到过 ${targets.join(' / ')},但改写的精确规则一处没认出(注释里、半截字符串里的路径不改),按引用点计进断链数`)
      }
      continue
    }
    rewrites.push({ rel: refRel, text: full.out, hits: full.hits })
    // 每条 from 各自改了几处:同一份已经读进来的原文 + 只含那一条的表,纯字符串运算,不再读盘
    for (const from of targets) {
      const one = rewriteRefs(kind, rd.text, buildRenameMap([{ from, to: map.get(resPath(from)) || '' }]))
      canFix.set(from, (canFix.get(from) || 0) + one.hits)
    }
  }

  // ---- 3. 产出 ----
  const changes: Change[] = []
  for (const pr of pairs) {
    if (ctx.cancelled) break
    const cant = cantFix.get(pr.from) || 0
    const can = canFix.get(pr.from) || 0
    // 同一个字段两种成因(§G-3):开关开着时「没跟上」的只有读不到那些;关掉时全部都没跟上。
    const dangling = updateRefs ? cant : cant + can
    changes.push({
      rel: pr.from,
      to: pr.to,
      kind: 'rename',
      risk: 'low',
      dangling,
      label: `改名:${fileName(pr.from)} → ${fileName(pr.to)}`,
      reason: `只改文件名,连它自己的边车(.uid / .import)一起由框架搬走,不改任何文件内容。` +
        ` 头部与边车里的 uid 一个字节都不动(uid 与文件名无关,改它等于自断所有引用)。` +
        (updateRefs
          ? ` 引用点由下面「更新引用」那几条改写,没被勾上的那些仍会留在旧名上。`
          : ` 「同时更新引用」已关闭:文件里的路径不会被改。`) +
        (dangling > 0 ? ` 这一条改完会有 ${dangling} 处引用留在旧名上。` : '') +
        (unreadableSources || treeIncomplete
          ? ` 有 ${unreadableSources} 个文件没能读进引用图${treeIncomplete ? ',且文件清单本身被截断' : ''} —— 这个数是下限而不是准确值。`
          : ''),
      bytes: undefined
    })
  }
  // 开关关掉时**一条改写都不出**:算改写文本是为了让 dangling 与真实处数同源,不是为了偷偷留下它们
  if (updateRefs) {
    for (const rw of rewrites) {
      if (ctx.cancelled) break
      changes.push({
        rel: rw.rel,
        kind: 'rewrite',
        risk: 'low',
        label: `更新引用 ${rw.hits} 处`,
        reason: `这个文件里 ${rw.hits} 处指向被改名文件的引用换成新路径(只有引号内文整串等于旧路径才算;"uid=" 与注释一个字不动)。` +
          ` 改写前会先把原文件复制成备份。`,
        payload: { text: rw.text }
      })
    }
  }
  return changes
}

/** 只取 basename:预览那一行说「改名:enemy_01.gd → mob_01.gd」比说整条路径有用 */
function fileName(rel: string): string {
  const s = String(rel || '')
  const i = s.lastIndexOf('/')
  return i >= 0 ? s.slice(i + 1) : s
}

/** 索引里这个 referrer 为这批 targets 一共留了几个站点 */
function countSites(index: { to: Map<string, { from: string }[]> }, refRel: string, targets: string[]): number {
  let n = 0
  for (const from of targets) {
    const sites = index.to.get(from) || []
    n += sites.filter((s) => s && s.from === refRel).length
  }
  return n
}

/**
 * 表单旁边那句**参数预览**的活话(§5.7 的「匹配到 12 处」)。
 * 它不是风险话 —— 风险话永远只在 `orchestrate.ts` 一处(DEV-7),这句说的是「这条规则现在命中几个」,
 * 只有工具自己知道作用于什么之上(这里是选中的文件名),所以它属于插件。
 * 非正则模式返回空串(框架不画条)。
 */
export function count(params: unknown, files: unknown): string {
  const { p } = paramsFrom(params)
  if (p.mode !== 'regex') return ''
  const list = Array.isArray(files) ? files : []
  const rels = list.map(relOf).filter((r) => !!r)
  const r = regexHitsOnNames(p.pattern, rels)
  if (r.error) return `正则:${r.error}`
  if (!rels.length) return '还没选文件,没法数命中'
  return r.count ? `在选中的 ${rels.length} 个文件名里命中 ${r.count} 处` : '没有命中任何文件名'
}
