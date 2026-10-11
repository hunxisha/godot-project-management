// 工具箱 · 三段式调度(纯函数 + 一个只调注入依赖的异步执行器)。
//
// 这里是旧 `src/tools/gate.ts` 那 5 个纯函数的后继(gate.ts 随第 0 批拆除,DEV-1 把它挪到本批按
// 真实的 `ChangePlan` 重写,67 条断言作废)。动手前逐行读过 `git show 2382316~1:src/tools/gate.ts`,
// 它 `:15-20` 那六条安全纪律原样继承,一条没丢:
//   1. **宁可少报,不许说错** —— 认不出形状的那一条直接丢进 `rejected`,不猜、不动盘;
//   2. `plan.changes` 永远是要动的**完整**清单,只按勾选裁子集,裁掉的必须是「用户没选的」而不是「显示不下的」;
//   3. **空选择必须带着原因被拒**,不许静默什么都不做(§5.3 规则 3 的反面就是「点了没反应」);
//   4. 勾选集合里父计划没有的 id **一律忽略** —— 门不许凭空造出一条要删/要写的记录;
//   5. 子集顺序按**父计划顺序**,不按点选顺序:账目与宿主原语的报数口径都要求 payload 确定;
//   6. 拿不到新内容的那条**不进写入清单** —— `writeProjectText` 会照 `undefined` 把文件覆成空内容,
//      而那不在「用户勾了这条」的授权范围内(旧 `subsetPlan` 注释里最贵的一句)。
//
// 措辞纪律(DEV-7,旧 `gate.test.mjs:9`「门不许另写措辞」的新表达):
//   面向用户的整句风险话**只在本模块生成**一处(`NO_SELECTION_REASON` / `rewriteWarn` / `summaryText`);
//   插件的 `label`/`reason` 逐条原样沿用,框架不复述、不改写、也不自己判断风险。
//
// 红线:纯函数为主。唯一的异步入口 `executePlan` 只调**注入进来的** writeText/trash/apply 三个函数,
// 不碰 window、不碰 vue、不碰 fs —— 所以 Node harness 里跑的是真判据,不是假加载器(Q33)。

import type {
  ApplyOutcome,
  ApplyReceipt,
  Change,
  ChangePlan,
  ExecutedItem,
  PlannedChange
} from './change'
import { isInsidePath } from './manifest'

/** 空选择那句拒绝的话(措辞唯一来源) */
export const NO_SELECTION_REASON = '没有勾选任何一条变更,已拒绝执行(至少要选中一条)'
/** plan() 本身没给出可执行清单时的兜底原因 */
export const EMPTY_PLAN_REASON = '这一步算完没有任何要动的东西,已拒绝执行'
/** 第 1 批的执行通道只有改写与回收站:rename 的原语还没建,绝不假装能做 */
export const RENAME_UNSUPPORTED = '重命名的执行通道在第 2 批接入(需要新的宿主原语),本轮不写盘'

const KINDS = ['rewrite', 'rename', 'trash'] as const
const RISKS = ['low', 'high'] as const

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** rel 的比对形态:反斜杠归正斜杠(宿主给的 rel 恒是正斜杠,而插件作者会手写 Windows 分隔) */
function key(v: unknown): string {
  return typeof v === 'string' ? v.replace(/\\/g, '/') : ''
}

/**
 * 改写通道的风险句,按「这一批里有没有清单外的目标」分三档 —— 判据与措辞同源自旧 `fixPlan.rewriteWarn`,
 * 但换了依据:那边看 `size`/`note`,这边看框架自己判定的 `creates`。
 * 三档不能合成一档:新建文件**不产生备份**(`inspectfs.js:206` 的 `if (exists && ...)`),
 * 对着那一批还说「可随时还原」就是在给用户一条没有退路的承诺。
 */
export function rewriteWarn(items: readonly PlannedChange[]): string {
  let creates = false
  let known = false
  for (const it of items) {
    if (it.kind !== 'rewrite') continue
    if (it.creates) creates = true
    else known = true
  }
  if (!creates) {
    return known
      ? '改写前会先把原文件复制成「原名.gpm-bak-时间戳」备份,再原子替换,可随时还原。'
      : '这一批里没有改写目标,不涉及备份。'
  }
  return known
    ? '清单里有的文件会先复制成「原名.gpm-bak-时间戳」备份再原子替换;清单里没有的那些会被新建,新建没有备份可还原。'
    : '这些文件都不在本次文件清单里:改写会直接新建文件,新建没有备份可还原。'
}

/** 整批的风险句:只有真的存在改写目标时才说备份那段 */
export function warnText(items: readonly PlannedChange[]): string {
  return items.some((i) => i.kind === 'rewrite') ? rewriteWarn(items) : ''
}

/**
 * 预览分组:范围内一组、越界一组(§5.4 要求越界**单独分组**且底色不同)。
 * 空组不出现;顺序固定范围内在前 —— 越界那组再显眼,也不该把用户自己要动的东西挤到后面。
 */
export function groupPreview(plan: ChangePlan): { key: 'in' | 'out'; title: string; changes: PlannedChange[] }[] {
  const inScope = plan.changes.filter((c) => !c.outOfScope)
  const out = plan.changes.filter((c) => c.outOfScope)
  const out2: { key: 'in' | 'out'; title: string; changes: PlannedChange[] }[] = []
  if (inScope.length) out2.push({ key: 'in', title: '选中文件内的变更', changes: inScope })
  if (out.length) out2.push({ key: 'out', title: `范围外 · ${out.length} 条(框架强制逐条确认)`, changes: out })
  return out2
}

/** 列表那一行的摘要(措辞只在这里) */
export function planSummary(plan: ChangePlan): string {
  if (plan.planError) return plan.planError
  const n = plan.changes.length
  if (!n) return EMPTY_PLAN_REASON
  const out = plan.changes.filter((c) => c.outOfScope).length
  const def = plan.changes.filter((c) => c.defaultSelected).length
  const rej = plan.rejected.length
  const parts = [`共 ${n} 条(默认勾选 ${def} 条)`]
  if (out) parts.push(`${out} 条在选中范围外`)
  if (rej) parts.push(`${rej} 条无法识别已丢弃`)
  return parts.join(';')
}

/**
 * 三段式第一拍:调插件的 `plan()`,把返回的未校验数据归一成 `ChangePlan`。
 *
 * 插件那边可能什么都不给 —— 不是函数、抛异常、返回数组以外的东西、数组里塞 null。
 * 每一种都要**接住**并给出人话,而不是让异常冒到视图层变成白屏;
 * 也不能顺手"修复"成看起来能用的数据(纪律 1)。
 *
 * @param opts.selectedRels 用户选中的文件 rel ⇒ 不在这里面的变更一律 `outOfScope` + `risk:'high'`(Q28 兜底)
 * @param opts.treeRels 本次项目清单里的 rel;不给就等于「不知道文件在不在」,`creates` 按 true 判(措辞退到最保守档)
 */
export async function buildPlan(opts: {
  toolId: string
  plan: unknown
  ctx?: unknown
  files?: unknown
  params?: unknown
  selectedRels: readonly string[]
  treeRels?: readonly string[]
}): Promise<ChangePlan> {
  const selected = new Set((Array.isArray(opts.selectedRels) ? opts.selectedRels : []).map(key).filter(Boolean))
  const treeKnown = Array.isArray(opts.treeRels)
  const tree = new Set(treeKnown ? (opts.treeRels as readonly string[]).map(key).filter(Boolean) : [])

  const base: ChangePlan = {
    toolId: opts.toolId,
    changes: [],
    planError: '',
    rejected: [],
    selectedRels: [...selected],
    treeKnown
  }

  if (typeof opts.plan !== 'function') {
    return { ...base, planError: '这个工具没有实现 plan():action 型工具必须给出「算出要动哪些条」的函数' }
  }

  let raw: unknown
  try {
    raw = await (opts.plan as (c: unknown, f: unknown, p: unknown) => unknown)(opts.ctx, opts.files, opts.params)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ...base, planError: `plan() 抛异常:${msg}` }
  }
  // 插件返回 { changes: [...] } 也算数:第三方作者很容易多包一层,拒载比猜更糟
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && Array.isArray((raw as { changes?: unknown }).changes)) {
    raw = (raw as { changes: unknown }).changes
  }
  if (!Array.isArray(raw)) {
    return { ...base, planError: `plan() 返回的不是数组,而是${raw === null ? ' null' : ` ${typeof raw}`};每条变更要写成数组元素` }
  }

  const changes: PlannedChange[] = []
  const rejected: ChangePlan['rejected'] = []
  const usedIds = new Set<string>()
  const rewrittenRels = new Set<string>()

  for (let index = 0; index < raw.length; index++) {
    const c = raw[index] as Partial<Change> | null | undefined
    if (!c || typeof c !== 'object') {
      rejected.push({ index, why: `第 ${index + 1} 条不是对象(拿到 ${c === null ? 'null' : typeof c})` })
      continue
    }
    const rel = key(c.rel)
    if (!rel) { rejected.push({ index, why: '第 ' + (index + 1) + ' 条没有 rel' }); continue }
    if (!isInsidePath(rel)) {
      rejected.push({ index, why: `第 ${index + 1} 条的 rel「${rel}」越界(要相对项目根的正斜杠路径)` })
      continue
    }
    const kind = str(c.kind)
    if (!(KINDS as readonly string[]).includes(kind)) {
      rejected.push({ index, why: `第 ${index + 1} 条的 kind「${kind}」不认识(只能是 ${KINDS.join('/')} 之一)` })
      continue
    }
    if (!str(c.label).trim()) { rejected.push({ index, why: `第 ${index + 1} 条没有 label(预览列表那一行会说不出要干什么)` }); continue }
    if (!str(c.reason).trim()) { rejected.push({ index, why: `第 ${index + 1} 条没有 reason(风险档必须附理由,悬停要显示)` }); continue }
    const selfRisk = str(c.risk)
    if (!(RISKS as readonly string[]).includes(selfRisk)) {
      rejected.push({ index, why: `第 ${index + 1} 条的 risk「${selfRisk}」不认识(只能是 low/high)` })
      continue
    }
    if (kind === 'rename') {
      const to = key(c.to)
      if (!to) { rejected.push({ index, why: `第 ${index + 1} 条是 rename 但没有 to(新名)` }); continue }
      if (!isInsidePath(to)) { rejected.push({ index, why: `第 ${index + 1} 条的新名「${to}」越界` }); continue }
      if (to === rel) { rejected.push({ index, why: `第 ${index + 1} 条改名前后是同一个名字` }); continue }
    }

    // ---- 框架侧判定:越界强制 high(插件说了不算),默认勾选按 low && 不越界 ----
    const outOfScope = !selected.has(rel)
    const risk = outOfScope ? 'high' : selfRisk
    const creates = kind === 'rewrite' ? (treeKnown ? !tree.has(rel) : true) : false
    // 两种「重复」要分开说,否则会把作者引到错误的修法上:
    //   · 同一个文件被改写两次 = 后一条会静默覆掉前一条,而预览只说「1 个文件」(旧 fixPlan 审查 Important 2);
    //   · 显式 id 撞车但目标是两个不同文件 = 作者的 id 写错了。
    // 所以先按 rel 判(消息更具体),再按 id 判。
    if (kind === 'rewrite' && rewrittenRels.has(rel)) {
      rejected.push({ index, why: `第 ${index + 1} 条与前面的改写目标是同一个文件:${rel}` })
      continue
    }
    let id = str(c.id).trim() || `${opts.toolId}:${kind}:${rel}`
    if (usedIds.has(id)) {
      rejected.push({ index, why: `第 ${index + 1} 条的 id「${id}」与前面某条重复了(同一个 id 会被勾选与账本当成同一条)` })
      continue
    }
    usedIds.add(id)
    if (kind === 'rewrite') rewrittenRels.add(rel)

    changes.push({
      id,
      rel,
      kind: kind as PlannedChange['kind'],
      label: str(c.label).trim(),
      risk: risk as PlannedChange['risk'],
      reason: str(c.reason).trim(),
      to: kind === 'rename' ? key(c.to) : undefined,
      bytes: typeof c.bytes === 'number' && c.bytes >= 0 ? c.bytes : undefined,
      payload: c.payload,
      outOfScope,
      creates,
      defaultSelected: risk === 'low' && !outOfScope
    })
  }

  return { ...base, changes, rejected }
}

/** 默认勾选集合(risk==='low' 且不越界) */
export function defaultSelectedIds(plan: ChangePlan): string[] {
  return plan.changes.filter((c) => c.defaultSelected).map((c) => c.id)
}

/** 全选(供「全选」按钮):返回**全部** id,不裁长度 —— 裁这里等于把 payload 缩水 */
export function allIds(plan: ChangePlan): string[] {
  return plan.changes.map((c) => c.id)
}

/** 真正会被执行的条数:只数清单里真有的那些 id(按钮门槛用它,不用 selected.length) */
export function selectionCount(plan: ChangePlan, ids: readonly unknown[]): number {
  const set = new Set(Array.isArray(ids) ? ids.filter((i) => typeof i === 'string' && i) : [])
  let n = 0
  for (const c of plan.changes) if (set.has(c.id)) n++
  return n
}

/** 已选体积合计:插件没给 bytes 的条**不臆造成 0 参与求和**,而是让它不进这一档(预览说「体积未知」) */
export function selectionBytes(plan: ChangePlan, ids: readonly unknown[]): { bytes: number; unknown: number } {
  const set = new Set(Array.isArray(ids) ? ids.filter((i) => typeof i === 'string' && i) : [])
  let bytes = 0
  let unknown = 0
  for (const c of plan.changes) {
    if (!set.has(c.id)) continue
    if (typeof c.bytes === 'number') bytes += c.bytes
    else unknown++
  }
  return { bytes, unknown }
}

/**
 * 从父计划 + 勾选集合裁子计划(纪律 4/5 的正身):
 *   · 只认父计划里真有的 id,凭空多出来的勾选一律忽略;
 *   · 顺序按父计划,不按点选顺序(payload 必须与点法无关);
 *   · 同一 id 点两次只留一条;
 *   · 非数组/空串/非字符串元素一律当「没勾」,不抛异常;
 *   · planError / rejected / selectedRels / treeKnown 原样沿用 —— 子集不许把父计划的坏消息洗白。
 */
export function subsetPlan(plan: ChangePlan, ids: readonly unknown[]): ChangePlan {
  const wanted = new Set<string>()
  if (Array.isArray(ids)) {
    for (const s of ids) {
      if (typeof s === 'string' && s) wanted.add(s)
    }
  }
  return {
    ...plan,
    changes: plan.changes.filter((c) => wanted.has(c.id))
  }
}

/**
 * 执行前的门:交一份「能不能跑 + 不能跑时说什么」的判决。
 * 三道短路按**先坏先说**排:plan 本身失败 → 清单为空 → 一条没勾。
 * 顺序不能换:planError 非空时 changes 必空,若先判空就会把「工具坏了」说成「没东西可做」。
 */
export function runGate(plan: ChangePlan, ids: readonly unknown[]): { ok: boolean; reason: string } {
  if (plan.planError) return { ok: false, reason: plan.planError }
  if (!plan.changes.length) return { ok: false, reason: EMPTY_PLAN_REASON }
  if (selectionCount(plan, ids) === 0) return { ok: false, reason: NO_SELECTION_REASON }
  return { ok: true, reason: '' }
}

/**
 * 写盘注入面:返回形态**照宿主原语**(`inspectfs.writeProjectText` 回 `{ok, bytes, truncated, error}`),
 * 判据不许自己发明一个简化版 —— 清单被截断 / 目标是二进制时原语根本不会写,
 * 框架要是把那也算成「改写成功」,回执就在对用户说谎。
 */
export interface WriteResultLike {
  ok?: boolean
  error?: string
  backupRel?: string
  bytes?: number
  truncated?: boolean
  skippedBinary?: boolean
}
/**
 * 写盘注入面。返回值一律按「可能是脏的」对待:注入方(最终是宿主原语,也可能是插件自己包的 shim)
 * 漏 return、回 undefined、回一个字符串,都不能让框架抛 TypeError 把整轮崩掉,
 * 更不能被当成成功 —— 判据统一是「拿不到成功证据 = 失败」(Task 2 的变异刀 K6 就是撞在这上面)。
 */
export interface WriteDeps {
  /** 正常形态是宿主 `writeProjectText` 的原话 `{ok, bytes, truncated, skippedBinary, error?, backupRel?}` */
  writeText: (rel: string, text: string) => unknown
  /** 正常形态照宿主 `movePathsToTrash`:顶层错只有一条,逐条错在 failed 里 */
  trash: (rels: string[]) => unknown
}

/**
 * 一条改写真正落盘没有 —— 判据与原语同侧,不看 `ok` 一个字段:
 * `ok:true` 但 `truncated`(超限额没读全文)或 `skippedBinary`(前 512 字节含 NUL)时原语什么都没写。
 * 名字带 `Change` 是因为回执里另有一个累计 `written` 数组,别撞(撞了是 TDZ,构建期看不出来)。
 */
function changeLanded(w: WriteResultLike | unknown): boolean {
  const r = (w || {}) as WriteResultLike
  return r.ok === true && r.truncated !== true && r.skippedBinary !== true
}

/**
 * 从一条变更里取出「要写的新正文」。
 * 只认字符串:插件 apply 忘了返回值、或者 payload 里放的是别的东西时,框架**不拿 undefined 去覆写文件**
 * (旧 `subsetPlan` 注释里那句最贵的教训 —— 那等于把用户唯一的源文件清成空)。
 */
function textOf(change: PlannedChange, outcome?: ApplyOutcome): string | null {
  if (outcome && typeof outcome.text === 'string') return outcome.text
  const p = change.payload as { text?: unknown } | null | undefined
  if (p && typeof p.text === 'string') return p.text
  return null
}

/**
 * 单条失败**不中断其余**(A-8 明写的判据),按 kind 分两路:
 *   · rewrite 逐条写(宿主原语本来就是单文件);
 *   · trash 攒成一批交给 movePathsToTrash —— 它自己就承诺「单个失败不中断」并按盘上实况复核;
 *   · rename 在第 1 批一律拒执行(原语还没建),**不调 apply**:既然不写盘,就别让人先跑一遍副作用。
 * 取消语义:`isCancelled()` 为真 ⇒ 停手,剩余条目标 '已取消'(§F 契约补充),已做的不在这回滚。
 */
export async function executePlan(opts: {
  plan: ChangePlan
  apply?: (change: PlannedChange, index: number) => Promise<ApplyOutcome | null | undefined> | ApplyOutcome | null | undefined
  deps: WriteDeps
  projectId?: string
  isCancelled?: () => boolean
  now?: () => number
}): Promise<ApplyReceipt> {
  const toolId = opts.plan.toolId
  const items: ExecutedItem[] = []
  const cancelled = () => (typeof opts.isCancelled === 'function' ? opts.isCancelled() === true : false)

  const push = (it: ExecutedItem): void => { items.push(it) }

  // 先按 kind 分道:trash 要攒批,rewrite 逐条。顺序仍按父计划。
  const trashQueue: PlannedChange[] = []
  for (let i = 0; i < opts.plan.changes.length; i++) {
    const c = opts.plan.changes[i]
    if (cancelled()) {
      // 从这一条起的全部标 '已取消':账本要说得出「这一轮停在哪」,而不是凭空少几条
      for (let k = i; k < opts.plan.changes.length; k++) {
        const r = opts.plan.changes[k]
        push({ id: r.id, rel: r.rel, kind: r.kind, ok: false, error: '已取消' })
      }
      break
    }
    if (c.kind === 'rename') {
      push({ id: c.id, rel: c.rel, kind: c.kind, ok: false, error: RENAME_UNSUPPORTED })
      continue
    }
    if (c.kind === 'trash') { trashQueue.push(c); continue }

    let outcome: ApplyOutcome | null | undefined = null
    if (opts.apply) {
      try {
        outcome = await opts.apply(c, items.length)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        push({ id: c.id, rel: c.rel, kind: c.kind, ok: false, error: `apply 抛异常:${msg}` })
        continue
      }
    }
    if (outcome && outcome.ok === false) {
      push({ id: c.id, rel: c.rel, kind: c.kind, ok: false, error: str(outcome.error).trim() || 'apply 报失败但没给原因' })
      continue
    }
    const text = textOf(c, outcome ?? undefined)
    if (text === null) {
      push({ id: c.id, rel: c.rel, kind: c.kind, ok: false, error: '没有可写内容,已跳过(框架不拿 undefined 覆写文件)' })
      continue
    }
    let w: WriteResultLike | unknown
    try {
      w = opts.deps.writeText(c.rel, text)
    } catch (e) {
      push({ id: c.id, rel: c.rel, kind: c.kind, ok: false, error: `写入抛异常:${e instanceof Error ? e.message : String(e)}` })
      continue
    }
    const done = changeLanded(w)
    const wr = (w || {}) as WriteResultLike
    push({
      id: c.id,
      rel: c.rel,
      kind: c.kind,
      ok: done,
      error: done ? undefined : str(wr.error).trim() || (wr.truncated ? '文件超出限额,原语没有写入' : wr.skippedBinary ? '目标是二进制文件,原语拒绝写入' : '写入失败'),
      backupRel: done ? str(wr.backupRel) || undefined : undefined
    })
  }

  // 回收站批量:一次调用,失败项按原语回报逐条落账
  if (trashQueue.length && !cancelled()) {
    const byRel = new Map<string, PlannedChange[]>()
    for (const c of trashQueue) {
      const arr = byRel.get(c.rel)
      if (arr) arr.push(c)
      else byRel.set(c.rel, [c])
    }
    const rels = [...byRel.keys()]
    let r: { ok?: boolean; error?: string; moved?: number; failed?: { rel: string; error: string }[] }
    try {
      r = (opts.deps.trash(rels) || {}) as typeof r
    } catch (e) {
      r = { ok: false, error: `回收站调用抛异常:${e instanceof Error ? e.message : String(e)}`, failed: [] }
    }
    const failedRel = new Map<string, string>()
    for (const f of Array.isArray(r.failed) ? r.failed : []) {
      if (f && typeof f.rel === 'string') failedRel.set(key(f.rel), str(f.error).trim() || '移入回收站失败')
    }
    // 逐条落账以**原语的 failed 列表**为准,不按顶层 `ok`:宿主 `movePathsToTrash` 的 ok 只等于
    // 「failed 为空」(inspectfs.js:343),真值来源是它批后按盘复核的那份 failed。
    // 顶层 `error` 非空是另一种形态——整批根本没碰到盘,那才是"每一条都失败"。
    const listed = failedRel.size > 0
    for (const c of trashQueue) {
      const err = failedRel.get(c.rel)
      if (err) push({ id: c.id, rel: c.rel, kind: c.kind, ok: false, error: err })
      else if (listed) push({ id: c.id, rel: c.rel, kind: c.kind, ok: true })
      else if (str(r.error)) push({ id: c.id, rel: c.rel, kind: c.kind, ok: false, error: str(r.error).trim() })
      else push({ id: c.id, rel: c.rel, kind: c.kind, ok: r.ok === true, error: r.ok === true ? undefined : '移入回收站失败' })
    }
  }

  const written = items.filter((i) => i.kind === 'rewrite' && i.ok).map((i) => i.rel)
  const moved = items.filter((i) => i.kind === 'trash' && i.ok).map((i) => i.rel)
  const failed = items.filter((i) => !i.ok)
  const backups = items.filter((i) => i.ok && str(i.backupRel)).map((i) => ({ rel: i.rel, backupRel: i.backupRel as string }))
  return {
    toolId,
    projectId: str(opts.projectId),
    at: (typeof opts.now === 'function' ? opts.now() : Date.now()),
    items,
    written,
    moved,
    failed,
    backups,
    cancelled: items.some((i) => i.error === '已取消'),
    ok: failed.length === 0
  }
}

/** 回执那句话(措辞唯一来源):执行朝与展示朝读同一份 items,不许各自再算一遍 */
export function summaryText(receipt: ApplyReceipt): string {
  const parts: string[] = []
  if (receipt.written.length) parts.push(`改写 ${receipt.written.length} 个文件`)
  if (receipt.moved.length) parts.push(`移入回收站 ${receipt.moved.length} 个`)
  if (receipt.failed.length) parts.push(`失败 ${receipt.failed.length} 条`)
  if (!parts.length) return '什么都没做成(没有一条变更执行成功)'
  return (receipt.cancelled ? '已取消,已完成:' : receipt.ok ? '完成:' : '部分完成:') + parts.join('、')
}
