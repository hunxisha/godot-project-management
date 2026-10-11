// 工具箱 · 插件加载器:注册与错误隔离的**纯**部分(§A / Q4=B / Q23=A)。
//
// ⚠ 这一层在 Node 里只测「拿到东西之后怎么办」,**不测「东西怎么来」**:
// 怎么读盘、`new Function` / blob import 怎么执行插件代码、插件目录在真宿主上叫什么 —— 全部只能真机验
// (A-10 / A-19),用假加载器在 Node 里跑绿是 Q33 明确禁止的形态。
// 所以本文件里**没有任何一处** import fs 或 window:磁盘与执行由调用方(useToolkit)做完,
// 结果作为参数交进来。这样能测的与被测的东西是同一件事,而不是它的替身。
//
// 三件事必须钉住:
//   · **单个插件失败只标它自己**(§3 P0-b 第 5 项):一个坏 manifest 不许让整页空白 ——
//     用户刚丢进去一个 .js 就什么都打不开,是插件系统最劝退的失败形态;
//   · **内置与用户插件同一套**(Q23=A):校验、能力门、冲突、账本归属全部同码,只差 `source`;
//   · **id 撞车要看得见**:store 前缀、feature code、账本归属都以 id 为键,
//     两个插件同名 = 其中一个的数据会被另一个读到。这里不做「后装自动改名」那种看着友好的事,
//     直接拒,并把冲突对象说给对方听。

import type { ToolCapability, ToolManifest } from './manifest'
import { missingCapabilities, rejectionText, validateManifest } from './manifest'

/** 插件 entry 被执行之后拿到的模块对象(形状由 §F 的 entry 契约定死) */
export interface ToolModule {
  schema?: unknown
  plan?: unknown
  apply?: unknown
  view?: unknown
}

export type ToolSource = 'builtin' | 'user'

/** 一个工具在列表里的一切状态。渲染层只读它,不再自己判任何东西 */
export interface RegisteredTool {
  /** manifest 校验通过才有;null = 拒载(原因见 reason) */
  manifest: ToolManifest | null
  source: ToolSource
  /** 用户插件的目录名(内置工具是空串):「打开目录」与错误定位都靠它 */
  dirName: string
  /** 插件自己的版本与框架契约版本分离(§5.1:version 只用来显示) */
  module: ToolModule | null
  /**
   * - ok              校验全过、能力齐、可直接打开
   * - bad-manifest    manifest 形态不对(含 apiVersion 不匹配)
   * - bad-module      entry 导出的形状与 kind/ui 不符
   * - no-capability   manifest 没问题,但框架给不起它声明的能力
   * 四种坏态各自的 reason 措辞不同,列表那一行要能分清是「作者的错」还是「环境的错」。
   */
  state: 'ok' | 'bad-manifest' | 'bad-module' | 'no-capability'
  /** 一句话原因(措辞由本模块或 manifest.ts 生成,渲染层不复述) */
  reason: string
  /** 缺的能力(state='no-capability' 时非空) */
  missing: ToolCapability[]
  /** 与别的插件 id 撞车(仍可见可打开,但 store/feature 归属有风险,要标出来) */
  idConflictWith: string[]
}

/** 注册表:列表页与 feature 注册共用的唯一真源 */
export interface ToolRegistry {
  tools: RegisteredTool[]
  /** id → tool(重名时保留第一个,后面的进 idConflictWith) */
  byId: Record<string, RegisteredTool>
  conflicts: { id: string, names: string[] }[]
}

const KINDS = ['action', 'view']

/**
 * 校验 entry 模块导出的形状。
 *
 * §F 的 entry 契约:`schema`(ui:'schema' 时必填)、`plan`(action 型必填)、`apply`、`view`(view 型必填)。
 * 判据方向与 manifest 一样 —— 认不出来就拒这个工具并说清缺什么,
 * 而不是「运行时点执行按钮才发现 plan 不是函数」(那种错会浪费用户已经勾选好的一整轮预览)。
 */
export function checkModuleShape(m: ToolManifest, mod: unknown): { ok: boolean; reason: string } {
  if (!mod || typeof mod !== 'object') return { ok: false, reason: 'entry 没有导出任何东西(执行结果不是对象)' }
  const o = mod as ToolModule
  if (KINDS.indexOf(m.kind) < 0) return { ok: false, reason: `kind「${m.kind}」不认识` }
  if (m.kind === 'view') {
    if (typeof o.view !== 'function') return { ok: false, reason: "kind:'view' 的工具必须导出 view(ctx, files) 渲染函数" }
    return { ok: true, reason: '' }
  }
  if (typeof o.plan !== 'function') {
    return { ok: false, reason: "kind:'action' 的工具必须导出 plan(ctx, files, params) 函数(三段式的第一拍)" }
  }
  if (m.ui === 'schema' && !Array.isArray(o.schema)) {
    return { ok: false, reason: "ui:'schema' 的工具必须导出 schema 数组(参数表;没有参数就给空数组)" }
  }
  return { ok: true, reason: '' }
}

/**
 * 注册一个工具。
 *
 * @param manifestRaw manifest.json 的**已解析值**(解析失败由调用方给成 Error,这里不碰 JSON)
 * @param mod         entry 执行结果;还没执行(内置工具静态 import)时同样传对象进来
 * @param opts.files  插件目录的文件清单,用于查 entry 是否真存在(manifest.ts 的 opts.files)
 */
export function registerTool(
  manifestRaw: unknown,
  mod: unknown,
  opts: { source: ToolSource, dirName?: string, granted?: readonly ToolCapability[], files?: string[] }
): RegisteredTool {
  const base: RegisteredTool = {
    manifest: null,
    source: opts.source === 'builtin' ? 'builtin' : 'user',
    dirName: typeof opts.dirName === 'string' ? opts.dirName : '',
    module: null,
    state: 'bad-manifest',
    reason: '',
    missing: [],
    idConflictWith: []
  }
  const r = validateManifest(manifestRaw, Array.isArray(opts.files) ? { files: opts.files } : undefined)
  if (!r.ok) {
    // manifest.ts 是拒载原因的唯一来源,这里只贴一个前缀说明是哪一类失败
    return { ...base, reason: `manifest 不合格:${rejectionText(r.issues)}` }
  }
  const manifest = r.manifest
  const shape = checkModuleShape(manifest, mod)
  if (!shape.ok) return { ...base, manifest, state: 'bad-module', reason: shape.reason }
  const granted = Array.isArray(opts.granted) ? opts.granted : []
  const missing = missingCapabilities(manifest.capabilities, granted)
  if (missing.length) {
    return {
      ...base,
      manifest,
      module: mod as ToolModule,
      state: 'no-capability',
      missing,
      reason: `缺框架能力:${missing.join(' / ')}`
    }
  }
  return { ...base, manifest, module: mod as ToolModule, state: 'ok', reason: '' }
}

/**
 * 一批注册结果 → 注册表:建索引、找 id 撞车、把撞车的两边都标出来。
 *
 * 撞车时**保留先注册的那个**(与 Q22 的「后装让位」同方向:框架不做「自动改名」这种
 * 会让用户的 store 数据跟着搬家的动作)。后一个仍然出现在列表里、仍然可打开,
 * 只是 idConflictWith 里写明跟谁撞了。
 */
export function buildRegistry(tools: readonly RegisteredTool[]): ToolRegistry {
  const list = Array.isArray(tools) ? tools.filter((t) => !!t) : []
  const byId: Record<string, RegisteredTool> = {}
  const seen: Record<string, RegisteredTool[]> = {}
  for (const t of list) {
    const id = t.manifest ? t.manifest.id : ''
    if (!id) continue
    if (!seen[id]) seen[id] = []
    seen[id].push(t)
  }
  const conflicts: { id: string, names: string[] }[] = []
  for (const [id, group] of Object.entries(seen)) {
    if (group.length > 1) {
      conflicts.push({ id, names: group.map((g) => g.dirName || id) })
      for (const g of group) g.idConflictWith = group.filter((x) => x !== g).map((x) => x.dirName || (x.manifest ? x.manifest.id : id))
    }
    if (!byId[id]) byId[id] = group[0]
  }
  return { tools: list, byId, conflicts }
}

/** 撞车那一行的话(措辞唯一来源) */
export function conflictText(t: RegisteredTool): string {
  const names = t.idConflictWith.length ? t.idConflictWith.join('、') : '另一个插件'
  const id = t.manifest ? t.manifest.id : '?'
  return `id「${id}」与 ${names} 撞了:存储前缀与 feature code 会互相覆盖,请后装的换一个 id`
}

/** 排序:内置在前,其后按名字拼音序(用 localeCompare 的 zh 档);同组内按 id 保证稳定 */
export function sortTools(list: readonly RegisteredTool[]): RegisteredTool[] {
  const arr = (Array.isArray(list) ? [...list] : [])
  arr.sort((a, b) => {
    const ab = a.source === 'builtin' ? 0 : 1
    const bb = b.source === 'builtin' ? 0 : 1
    if (ab !== bb) return ab - bb
    const an = a.manifest ? a.manifest.name : a.dirName
    const bn = b.manifest ? b.manifest.name : b.dirName
    const byName = String(an).localeCompare(String(bn), 'zh')
    if (byName !== 0) return byName
    return String(a.manifest ? a.manifest.id : a.dirName).localeCompare(String(b.manifest ? b.manifest.id : b.dirName))
  })
  return arr
}

/** 搜索 + 筛选(Q13 的密集列表顶部)。query 命中标题/摘要/id/关键词/tags;chip 按 kind 与 tag 过滤 */
export function filterTools(
  list: readonly RegisteredTool[],
  q: { query?: string, kind?: ToolKindFilter, tag?: string, onlyEnabled?: boolean, enabledIds?: readonly string[] }
): RegisteredTool[] {
  const query = typeof q.query === 'string' ? q.query.trim().toLowerCase() : ''
  const enabled = Array.isArray(q.enabledIds) ? new Set(q.enabledIds) : null
  const out: RegisteredTool[] = []
  for (const t of Array.isArray(list) ? list : []) {
    if (!t) continue
    // 拒载的条目没有 manifest:它**也参与搜索**,可搜面是目录名与拒载原因
    // (「用户从目录名搜」正是他找坏插件的唯一办法)。
    // 早先写法是「坏的一律永远保留」,那会让搜索框里冒出一堆不相关的红条,反而更找不到。
    const m = t.manifest
    if (!m) {
      if (q.kind && q.kind !== 'all') continue // 没 kind 可言,类别 chip 一律不匹配
      if (q.tag && q.tag !== 'all') continue
      if (q.onlyEnabled) continue // 它根本启用不了,「只看启用」里不该出现
      if (query && !`${t.dirName} ${t.reason}`.toLowerCase().includes(query)) continue
      out.push(t)
      continue
    }
    if (q.kind && q.kind !== 'all' && m.kind !== q.kind) continue
    if (q.tag && q.tag !== 'all' && !(m.tags || []).includes(q.tag)) continue
    if (q.onlyEnabled && enabled && !enabled.has(m.id)) continue
    if (query) {
      const hay = [m.name, m.summary, m.id, m.description, ...(m.cmds || []), ...(m.tags || []), t.dirName]
        .join(' ')
        .toLowerCase()
      if (!hay.includes(query)) continue
    }
    out.push(t)
  }
  return out
}

export type ToolKindFilter = 'all' | 'action' | 'view'

/** 列表页的筛选 chip:出现过的 tag 全集(按出现次数降序,同次数按字面序) */
export function allTags(list: readonly RegisteredTool[]): string[] {
  const count = new Map<string, number>()
  for (const t of Array.isArray(list) ? list : []) {
    if (!t || !t.manifest) continue
    for (const tag of t.manifest.tags || []) count.set(tag, (count.get(tag) || 0) + 1)
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh')).map((e) => e[0])
}
