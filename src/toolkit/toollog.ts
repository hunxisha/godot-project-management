// 工具箱 · 动作账本(§5.5 / Q17=B / Q29=C / A-16)。
//
// 一句话:每次执行留一条账,用户能一键把整次回滚。它是 §1.5 那条红线(「写文件先落备份」)的收口 ——
// 备份文件是宿主原语写的(`*.gpm-bak-<时间戳>`),账本负责记住**哪些文件对应哪个备份**,
// 没有这份对应关系,盘上那一堆 `.gpm-bak-` 就是没人能认回来的孤儿。
//
// 存储形状(DEV-16,与 §5.3 的 store 前缀是两件事):
//   整个账本是**一个文档** `godot/toollog/entries`,值是按时间倒序的数组,超过 50 条丢最旧的。
//   理由:「索引文档 + 每条目一个文档」会造出两份真相(索引说要的东西条目里没有 / 反过来),
//   而 50 条的上限让单文档方案没有任何体积压力。删记录时**绝不删备份文件**(A-16 明写),
//   所以哪怕账本整份清空,用户盘上的退路还在。这一条不是靠「记得别调用删除」做到的,
//   是靠这个模块**只拿到 getDoc/putDoc 两个方法**做到的(测试里有一条源码级断言钉住)。
//
// 四条判据各有归宿:
//   · `canRollback` 不由插件说,也不由存储里那个布尔说了算:读盘时按这一轮真做了什么**重算**;
//   · 回滚承诺只有一句来源 —— `refuseReason()` 返回空串才允许还原,按钮与拒绝理由不可能各说一套;
//   · rename 与 trash 都算「不可自动回滚」:rename 的反向改引用是第 2 批的事(DEV-11),
//     trash 的东西在回收站里,框架不去碰它(§1.5:删除一律进回收站,还原是用户自己的动作);
//   · 读脏数据时**判据字段不合法就整条丢弃**(纯展示字段用兜底值留行)——
//     「宁可少显示一条历史,也不能拿半截数据给用户按回滚」。
//
// 纯函数 + 注入的 store 面(渲染层的 getDoc/putDoc),不碰 window、不碰 fs。

import type { ApplyReceipt, Change, ChangePlan, ExecutedItem, PlannedChange } from './change'
import { summaryText } from './orchestrate'

/** 账本文档 id(单文档方案,见文件头) */
export const LOG_DOC_ID = 'godot/toollog/entries'
/** 保留条数(Q29=C):超出只丢记录,不删备份文件 */
export const LOG_KEEP = 50
/** 工具页内显示的条数(Q29=C) */
export const LOG_RECENT_PER_TOOL = 5

/** 取消标记:与 orchestrate.ts:372 推给 `ExecutedItem.error` 的那个串同一个字(全仓约定串) */
const CANCELLED_MARK = '已取消'

/** 账本里的一条变更快照(比 Change 精简:UI 与回滚要用的字段留下,回调数据不留) */
export interface LoggedChange {
  rel: string
  kind: Change['kind']
  label: string
  risk: Change['risk']
  outOfScope: boolean
  /** rename 的新名(第 2 批才用得上,先如实记着) */
  to?: string
}

export interface ToolLogEntry {
  /** 毫秒时间戳。只在账本里出现 —— `Change.id` 的稳定键纪律不许它进 id(§F 契约补充) */
  at: number
  toolId: string
  toolName: string
  projectId: string
  changes: LoggedChange[]
  /** 宿主写盘回报的备份名,回滚就靠这一组对应关系 */
  backups: { rel: string, backupRel: string }[]
  written: string[]
  moved: string[]
  failed: { rel: string, error: string }[]
  cancelled: boolean
  /** 框架算出来的「这一轮能不能一键还原」 */
  canRollback: boolean
}

/** 注入进来的存储面(渲染层 bridge 的形状,故意收得很窄) */
export interface LogStore {
  getDoc: (id: string) => Promise<unknown> | unknown
  putDoc: (id: string, data: unknown) => Promise<unknown> | unknown
}

/** 回滚还原清单:一条 = 「把这个备份的正文写回那个 rel」 */
export interface RollbackItem {
  rel: string
  backupRel: string
}

/** 账本里参与回滚判定的那几个字段(与 `ToolLogEntry` 的对应子集) */
type RollbackInput = Partial<Pick<ToolLogEntry, 'changes' | 'backups' | 'moved' | 'written'>>

function str(v: unknown): string { return typeof v === 'string' ? v : '' }
function msg(e: unknown): string { return e instanceof Error ? e.message : String(e) }
function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : String(x))) : []
}

/** 从一条 `PlannedChange` 抽快照 */
function logOf(c: PlannedChange): LoggedChange {
  const o: LoggedChange = {
    rel: str(c.rel),
    kind: c.kind,
    label: str(c.label),
    risk: c.risk === 'high' ? 'high' : 'low',
    outOfScope: c.outOfScope === true
  }
  if (typeof c.to === 'string' && c.to) o.to = c.to
  return o
}

/**
 * 「这一轮能不能自动还原」的**唯一**判据:返回空串就是能,非空就是那句拒绝理由。
 *
 * 判据只看这一轮真做了什么,顺序按「先决定性、后细节」:
 *   1. 盘面根本没动过(written 与 moved 都空)⇒ 没什么可还原;
 *   2. 混进任何一条非 rewrite 的动作 ⇒ 拒绝。一键还原只能把写入复原,
 *      做不到把回收站里的东西捞回来、也做不到把新名引用改回去 ——
 *      给一个「半截还原」的按钮比没有按钮更伤(§5.4 宁可少说同一个方向)。
 *      注意这里按**尝试过的条**判,不按成功与否判:删除失败也算这一轮做过删除动作,
 *      框架不去推断那一条有没有留下半截状态。
 *   3. 有文件进了回收站 ⇒ 拒绝。这一条排在备份检查之前,因为它是更决定性的事实;
 *      它在第 2 条之后看起来够不着,它防的是「调用方只给回执没给 plan」那种账目:
 *      `changes` 为空时第 2 条不响。
 *   4. 一个备份名都没拿到,却写了 N 个文件 ⇒ 这些文件没有退路,不许承诺还原;
 *   5. 备份记录不完整(有 rel 没 backupRel)⇒ 同上,而且比第 4 种更危险:
 *      还原会悄悄少还原几个文件,所以宁可整条拒绝。
 */
function refuseReason(entry: RollbackInput): string {
  const written = Array.isArray(entry.written) ? entry.written : []
  const moved = Array.isArray(entry.moved) ? entry.moved : []
  const backups = Array.isArray(entry.backups) ? entry.backups : []
  const list = Array.isArray(entry.changes) ? entry.changes : []
  if (!written.length && !moved.length) return '这一轮没有任何落盘记录,无需还原'
  if (list.some((c) => !c || c.kind !== 'rewrite')) return '这一轮包含删除或改名,一键还原只能做到一半'
  if (moved.length) return '这一轮有文件进了回收站,还原得由你在回收站里做'
  if (!backups.length) return `写了 ${written.length} 个文件却一个备份名都没拿到,不能保证还原`
  const broken = backups.filter((b) => !b || !str(b.rel) || !str(b.backupRel)).length
  if (broken) return `备份记录不完整(${broken} 条缺对应关系),不拿半截数据做还原`
  return ''
}

/** 承诺与理由共用一张嘴:能还原 ⇔ 拒绝理由为空。测试里有一条断言钉住这个等价关系 */
function canRollbackOf(entry: RollbackInput): boolean { return refuseReason(entry) === '' }

/**
 * 从一次执行的回执 + 这一轮真正执行的那份子集,做出一条账目。
 *
 * `plan` 传的是**勾选后真正执行的那份子集**(不是整份预览),否则用户会看到「账本记了我没执行的条」。
 * 被取消而根本没处理的条**不进 `changes`**(它们没碰过盘),但**必须进 `failed`**(§F 契约补充:
 * 原因串固定 `'已取消'`)—— 账本要说得出「这一轮停在哪」。
 * 缺信息时不抛异常:各字段退回空数组/空串,不合格的那几条由 `appendRun` 在写盘前拒掉。
 */
export function entryFromRun(args: {
  toolId: string
  toolName: string
  projectId: string
  plan?: ChangePlan | null
  receipt?: ApplyReceipt | null
  at?: number
}): ToolLogEntry {
  const receipt = (args.receipt || {}) as Partial<ApplyReceipt>
  const plan = (args.plan || {}) as Partial<ChangePlan>
  const planChanges = Array.isArray(plan.changes) ? plan.changes : []
  const failedItems = (Array.isArray(receipt.failed) ? receipt.failed : []) as ExecutedItem[]
  const cancelledIds = new Set<string>()
  for (const f of failedItems) {
    if (f && typeof f.id === 'string' && str(f.error).trim() === CANCELLED_MARK) cancelledIds.add(f.id)
  }
  const changes: LoggedChange[] = []
  for (const c of planChanges) {
    if (c && typeof c.id === 'string' && cancelledIds.has(c.id)) continue
    changes.push(logOf(c))
  }
  const rawBackups = Array.isArray(receipt.backups) ? receipt.backups : []
  const backups = rawBackups.map((b) => ({ rel: str(b && b.rel), backupRel: str(b && b.backupRel) }))
  const failed = failedItems.map((f) => {
    if (!f || typeof f !== 'object') return { rel: '', error: '回执里的失败记录不是一个对象' }
    return { rel: str(f.rel), error: str(f.error).trim() || '没给原因' }
  })
  const at = typeof args.at === 'number' && Number.isFinite(args.at)
    ? args.at
    : (typeof receipt.at === 'number' && Number.isFinite(receipt.at) ? receipt.at : 0)
  const entry: ToolLogEntry = {
    at,
    toolId: str(args.toolId),
    toolName: str(args.toolName),
    projectId: str(args.projectId),
    changes,
    backups,
    written: strList(receipt.written),
    moved: strList(receipt.moved),
    failed,
    cancelled: receipt.cancelled === true || failed.some((f) => f.error === CANCELLED_MARK),
    canRollback: false
  }
  entry.canRollback = canRollbackOf(entry)
  return entry
}

type Norm = { ok: true, entry: ToolLogEntry } | { ok: false, why: string }

/**
 * 把一份来历不明的记录归一成可信账目;判据字段不合法就整条丢弃(见文件头)。
 *
 * `canRollback` 一律**重算**:存进去的那个布尔只是判据的缓存,判据本身会变
 * (第 2 批给 rename 开执行通道时,旧缓存就会给出错的承诺),不许信它。
 */
function normOne(raw: unknown): Norm {
  if (!raw || typeof raw !== 'object') return { ok: false, why: '记录不是一个对象' }
  const o = raw as Partial<ToolLogEntry> & Record<string, unknown>
  if (typeof o.at !== 'number' || !Number.isFinite(o.at)) return { ok: false, why: '时间戳不合法' }
  if (!str(o.toolId)) return { ok: false, why: '缺少 toolId(筛选与回滚都按它归属)' }
  const rawChanges = o.changes
  if (!Array.isArray(rawChanges)) return { ok: false, why: 'changes 不是数组' }
  const changes: LoggedChange[] = []
  for (const c of rawChanges) {
    if (!c || typeof c !== 'object') return { ok: false, why: '有一条变更不是对象(丢掉它会改变回滚判定)' }
    const r = c as Partial<LoggedChange> & Record<string, unknown>
    if (typeof r.rel !== 'string') return { ok: false, why: '有一条变更没有 rel' }
    if (r.kind !== 'rewrite' && r.kind !== 'trash' && r.kind !== 'rename') {
      return { ok: false, why: '有一条变更的 kind 无法识别' }
    }
    const lc: LoggedChange = {
      rel: r.rel,
      kind: r.kind,
      label: str(r.label),
      risk: r.risk === 'high' ? 'high' : 'low',
      outOfScope: r.outOfScope === true
    }
    if (typeof r.to === 'string' && r.to) lc.to = r.to
    changes.push(lc)
  }
  const rawBackups = o.backups
  if (!Array.isArray(rawBackups)) return { ok: false, why: 'backups 不是数组' }
  // 备份对应关系缺半边时**保留那一行**(rel/backupRel 留空串),让 refuseReason 去拒绝还原,
  // 而不是把这条记录扔掉:扔掉等于把这段历史也删了。
  const backups = rawBackups.map((b) => {
    const o2 = (b && typeof b === 'object' ? b : {}) as Partial<{ rel: string, backupRel: string }>
    return { rel: str(o2.rel), backupRel: str(o2.backupRel) }
  })
  const rawFailed = o.failed
  const failed = (Array.isArray(rawFailed) ? rawFailed : []).map((f) => {
    if (!f || typeof f !== 'object') return { rel: '', error: '失败记录不是一个对象' }
    const o2 = f as Partial<{ rel: string, error: string }>
    return { rel: str(o2.rel), error: str(o2.error).trim() || '没给原因' }
  })
  const written = strList(o.written)
  const moved = strList(o.moved)
  const entry: ToolLogEntry = {
    at: o.at,
    toolId: str(o.toolId),
    toolName: str(o.toolName),
    projectId: str(o.projectId),
    changes,
    backups,
    written,
    moved,
    failed,
    // 两个来源任一为真就算取消:把「取消」少报比多报危险(用户会以为整轮跑完了)
    cancelled: o.cancelled === true || failed.some((f) => f.error === CANCELLED_MARK),
    canRollback: false
  }
  entry.canRollback = canRollbackOf(entry)
  return { ok: true, entry }
}

function sortDesc(list: ToolLogEntry[]): ToolLogEntry[] {
  return list.slice().sort((a, b) => b.at - a.at)
}

/** 保留策略:时间倒序后截前 `keep` 条。只丢记录,不碰任何文件 */
function trimLog(list: ToolLogEntry[], keep = LOG_KEEP): { kept: ToolLogEntry[], overflow: number } {
  const sorted = sortDesc(list)
  const kept = sorted.slice(0, keep)
  return { kept, overflow: sorted.length - kept.length }
}

function parseDoc(raw: unknown): { entries: ToolLogEntry[], dirty: number } {
  const arr = Array.isArray(raw) ? raw : []
  const entries: ToolLogEntry[] = []
  let dirty = 0
  for (const x of arr) {
    const n = normOne(x)
    if (n.ok) entries.push(n.entry)
    else dirty++
  }
  return { entries, dirty }
}

export interface LoadResult {
  entries: ToolLogEntry[]
  /** 被丢掉的脏记录条数(面板要如实说「N 条记录已损坏」,不能装作从来没有过) */
  dirty: number
  error: string
}

/** 读账本。读失败与「账本还空着」是两张嘴:前者必须给 error,后者给空数组 */
export async function loadLog(store: LogStore): Promise<LoadResult> {
  let raw: unknown
  try {
    raw = await store.getDoc(LOG_DOC_ID)
  } catch (e) {
    return { entries: [], dirty: 0, error: `账本读取失败:${msg(e)}` }
  }
  if (raw !== undefined && raw !== null && !Array.isArray(raw)) {
    return { entries: [], dirty: 0, error: '账本文档不是一个数组(这个 id 被别的记录占了)' }
  }
  const parsed = parseDoc(raw)
  return { entries: sortDesc(parsed.entries), dirty: parsed.dirty, error: '' }
}

/**
 * 「这次 put 真落下去了吗」—— 判据与 orchestrate 写盘那侧同一条:**拿不到成功证据就是失败**。
 * 桥接层的 `putDoc` 用返回值 `false` 表示 LMDB 写失败(它不抛异常),
 * 只看「有没有抛」会把没记上的账当成记上了 —— 那是 A-16 最不能有的形态。
 */
function putLanded(r: unknown): boolean {
  if (r === true) return true
  if (!r || typeof r !== 'object') return false
  const o = r as { ok?: unknown, success?: unknown, error?: unknown }
  if (str(o.error).trim()) return false
  return o.ok === true || o.success === true
}

/**
 * 记一笔账。三种「没记上」都必须回报,不许静默:
 *   · 这一轮的账目本身不合格(没时间戳/没有 toolId)⇒ 一条都没写;
 *   · **读失败时拒绝写** —— 单文档方案里 putDoc 是整份覆盖,拿不到旧记录就写会把 50 条历史抹掉;
 *   · 写入没给成功证据:抛异常,**或像桥接层那样回 `false`**(见 putLanded)。
 *     宁可这一轮少一条账(备份文件仍在盘上,退路没断),也不能抹掉既有记录或假装记上了。
 */
export async function appendRun(store: LogStore, entry: ToolLogEntry): Promise<{ ok: boolean, overflow: number, error: string }> {
  const norm = normOne(entry)
  if (!norm.ok) return { ok: false, overflow: 0, error: `这一轮的账目不合格:${norm.why}` }
  const loaded = await loadLog(store)
  if (loaded.error) {
    return { ok: false, overflow: 0, error: `${loaded.error};为不覆掉已有记录,这一轮没记上(备份文件仍在磁盘上)` }
  }
  const merged = [norm.entry].concat(loaded.entries)
  const trimmed = trimLog(merged)
  let put: unknown
  try {
    put = await store.putDoc(LOG_DOC_ID, trimmed.kept)
  } catch (e) {
    return { ok: false, overflow: 0, error: `账本写入失败:${msg(e)}` }
  }
  if (!putLanded(put)) {
    return { ok: false, overflow: 0, error: `账本写入没给成功证据(拿到 ${JSON.stringify(put) ?? String(put)}),这一轮没记上(备份文件仍在磁盘上)` }
  }
  return { ok: true, overflow: trimmed.overflow, error: '' }
}

/** 按项目筛选(Q29=C 的「且能按项目筛选」)。`''` 只匹配没归属的账目,不当「全部」用 */
export function entriesForProject(entries: ToolLogEntry[], projectId: string): ToolLogEntry[] {
  if (!Array.isArray(entries)) return []
  // 与 recentFor 一样先排再给:面板可能把几份列表并起来传进来,顺序不该由调用方负责
  return sortDesc(entries.filter((e) => !!e && e.projectId === projectId))
}

/** 某个工具的最近 N 条(工具页底部那一段,Q29=C) */
export function recentFor(entries: ToolLogEntry[], toolId: string, n = LOG_RECENT_PER_TOOL): ToolLogEntry[] {
  if (!Array.isArray(entries)) return []
  const mine = entries.filter((e) => !!e && e.toolId === toolId)
  const limit = Number.isFinite(n) && n > 0 ? Math.floor(n) : LOG_RECENT_PER_TOOL
  return sortDesc(mine).slice(0, limit)
}

/**
 * 回滚要还原哪些文件。返回空 items 且 refused 非空 ⇒ UI 不许有可点的还原按钮。
 * 与 `canRollback` 同一张嘴:`refuseReason` 是唯一判据。
 */
export function rollbackPlan(entry: unknown): { items: RollbackItem[], refused: string } {
  const norm = normOne(entry)
  if (!norm.ok) return { items: [], refused: `这一条账目不可信:${norm.why}` }
  const why = refuseReason(norm.entry)
  if (why) return { items: [], refused: why }
  // 同一 rel 在一轮里被写过两次 ⇒ 只还原最早那份备份:它装的才是本轮开始前的正文,
  // 后一份备份是中间态,拿它还原等于只回退一半。
  const seen = new Set<string>()
  const items: RollbackItem[] = []
  for (const b of norm.entry.backups) {
    if (seen.has(b.rel)) continue
    seen.add(b.rel)
    items.push({ rel: b.rel, backupRel: b.backupRel })
  }
  return { items, refused: '' }
}

/** 账本列表里那一行的话(措辞复用 orchestrate.summaryText,不另起一句,DEV-7) */
export function entrySummaryText(entry: ToolLogEntry): string {
  const safe = (entry && typeof entry === 'object' ? entry : {}) as Partial<ToolLogEntry>
  const written = strList(safe.written)
  const moved = strList(safe.moved)
  const failed = Array.isArray(safe.failed) ? safe.failed : []
  const base = summaryText({
    written,
    moved,
    failed,
    cancelled: safe.cancelled === true,
    ok: failed.length === 0
  })
  return base + (canRollbackOf({ written, moved, backups: safe.backups, changes: safe.changes }) ? ',可一键还原' : ',不可自动还原')
}

/** 「超出 50 条」那句提示:必须连带说明备份文件没被删(A-16 的另一半) */
export function droppedNotice(overflow: number): string {
  if (!Number.isFinite(overflow) || overflow <= 0) return ''
  return `已丢弃 ${overflow} 条最旧记录,备份文件仍在磁盘上`
}
