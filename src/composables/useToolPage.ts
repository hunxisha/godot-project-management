// 工具箱 · 工具独立页的状态机(§3 P0-b 第 11 项 / Q16=B 三段式 / Q26 项目上下文 / A-8 / A-16)。
//
// 页面形态是「一屏看完」那种(旧体检卡片的后继):参数表单 + 文件挑选 + 预览勾选 + 执行 + 回执 +
// 本工具最近几条账,不做向导分步 —— 用户要能在按执行之前把整轮看全。
//
// 三条结构性判据(不是风格问题):
//   1. **选中集只有一个真源**。`plan(ctx, files, params)` 的 `files` 就是用户在页面上勾中的那几份
//      (按 schema 的 files 字段过滤候选),插件不许自己去 scanTree 猜;`selectedRels` 同一份数据交
//      给 buildPlan 做越界判定(§F 契约补充第 2 条 / Q28)。
//   2. **措辞不在这里生成**。预览分组、摘要、风险警告、回执那句话全部走 orchestrate 的导出;
//      账本那一行走 toollog 的导出(它内部又复用 orchestrate.summaryText,DEV-7)。
//      本文件里出现的新句子只有本页特有的:参数校验没过的提示、回滚结果的话。
//   3. **执行与回滚是同一条通道**。回滚不是「另一个写盘按钮」:它把账本里的备份读回来,
//      组成一份 ChangePlan 再走 executePlan ⇒ 备份、回执、账本、取消语义全部自动同构。
//
// ⚠ 状态挂在函数返回的对象上(每次进入页面新建一份)。离开页面就丢弃:预览是易碎品,
// 把「上一轮的勾选」留在模块缓存里,更常见的是让用户按执行时面对一份已经过期、文件已被改动的计划。
// 首页的工具列表反过来必须挂模块级(见 useToolkit 文件头),两者的取舍不一样,别照着抄。

import { computed, ref } from 'vue'
import type { CancelBox } from '../toolkit/gpm'
import type { Change, ChangePlan, PlannedChange } from '../toolkit/change'
import type { ApplyReceipt } from '../toolkit/change'
import type { GpmHost } from '../toolkit/gpm'
import { buildGpm, makeCancelBox } from '../toolkit/gpm'
import type { RegisteredTool } from '../toolkit/loader'
import type { FieldDesc, ParamResult } from '../toolkit/schema'
import { resolveParams, usableFields, validateSchema } from '../toolkit/schema'
import type { LoadResult } from '../toolkit/toollog'
import { appendRun, entryFromRun, loadLog, recentFor, rollbackPlan } from '../toolkit/toollog'
import type { ToolLogEntry } from '../toolkit/toollog'
import type { Services } from '../types/services'
import { getDoc, putDoc } from '../services/bridge'
import {
  allIds,
  buildPlan,
  defaultSelectedIds,
  executePlan,
  groupPreview,
  planSummary,
  runGate,
  selectionBytes,
  selectionCount,
  subsetPlan,
  summaryText,
  warnText
} from '../toolkit/orchestrate'

/** 桥接层需要的东西都用 `window.services`,测试里桩掉它(与 useToolkit 同一套做法) */
function svc(): Partial<Services> {
  return (typeof window !== 'undefined' ? (window as any).services : null) || {}
}

export interface RollbackResult {
  ok: boolean
  /** 一句结论(本页特有的话,不复用插件文案) */
  text: string
  restored: string[]
  failed: { rel: string, error: string }[]
}

export function useToolPage(tool: RegisteredTool, projectIdRef: { value: string }) {
  const fields = ref<FieldDesc[]>([])
  const schemaIssues = ref<string[]>([])
  const rawParams = ref<Record<string, unknown>>({})
  const candidates = ref<{ rel: string, size: number }[]>([])
  const picked = ref<string[]>([])
  const treeRels = ref<string[]>([])
  const treeTruncated = ref(false)
  const plan = ref<ChangePlan | null>(null)
  const checked = ref<string[]>([])
  const running = ref(false)
  const planning = ref(false)
  const receipt = ref<ApplyReceipt | null>(null)
  const notice = ref('')
  const history = ref<ToolLogEntry[]>([])
  const historyError = ref('')
  const cancelBox = ref<CancelBox | null>(null)

  const manifest = computed(() => (tool && tool.manifest) || null)
  const usable = computed(() => !!manifest.value && tool.state === 'ok' && !!tool.module)

  /** 组一份真 ctx:能力按 manifest 声明给,取消框按页持有(gpm.ts 的那道门不在这里重写) */
  function makeHost(pid: string, box: CancelBox): GpmHost {
    const m = manifest.value
    return {
      services: svc(),
      toolId: m ? m.id : '',
      toolName: m ? m.name : '',
      projectId: pid,
      capabilities: (m ? m.capabilities : []) as any,
      unsafe: !!m && m.unsafe === true,
      cancelled: box.isCancelled,
      onCancel: box.onCancel
    }
  }

  function ctxFor(pid: string, box: CancelBox) {
    return buildGpm(makeHost(pid, box))
  }

  /**
   * 打开页面:读参数表 → 拉文件树 → 挑默认文件。
   *
   * `schema` 是插件模块给的未校验数据:坏声明只把坏字段筛掉(整页白屏是最糟的收法),
   * 并把原因显示在表单上方 —— 让作者看得见自己写错了什么。
   */
  async function open(): Promise<void> {
    const m = manifest.value
    if (!m || !tool.module) return
    const v = validateSchema((tool.module as any).schema)
    schemaIssues.value = v.ok ? [] : (v as any).issues.map((i: any) => `${i.key}:${i.message}`)
    fields.value = usableFields(v)
    const init: Record<string, unknown> = {}
    for (const f of fields.value) init[f.key] = f.type === 'files' && Array.isArray(f.def) ? [...f.def] : f.def
    rawParams.value = init
    await loadTree()
  }

  /** 文件树:候选 = 按 files 字段声明的后缀过滤;`truncated` 要显式带出去(清单不全时不敢说「这些就是全部」) */
  async function loadTree(): Promise<void> {
    const pid = projectIdRef.value
    if (!pid) { candidates.value = []; treeRels.value = []; return }
    const filesField = fields.value.find((f) => f.type === 'files')
    const exts = filesField && filesField.exts.length ? filesField.exts : undefined
    let r: any = { files: [], truncated: false, error: '本工具没声明 tree 能力' }
    try {
      const s = svc()
      r = typeof s.scanProjectTree === 'function' ? await s.scanProjectTree(pid, exts ? { exts } : {}) : r
    } catch {
      r = { files: [], truncated: false, error: '读文件树抛异常' }
    }
    const list = Array.isArray(r && r.files) ? r.files : []
    treeRels.value = list.map((f: any) => String(f && f.rel || '')).filter(Boolean)
    treeTruncated.value = r && r.truncated === true
    candidates.value = list
      .filter((f: any) => f && typeof f.rel === 'string')
      .map((f: any) => ({ rel: f.rel, size: Number(f.size) || 0 }))
    // 默认选中:files 字段的 def(作者预置)优先,否则空着让用户自己勾
    const filesFieldKey = filesField ? filesField.key : ''
    const defList = Array.isArray(rawParams.value[filesFieldKey]) ? (rawParams.value[filesFieldKey] as unknown[]) : []
    if (defList.length) picked.value = defList.map((x) => String(x)).filter((x) => !!x)
  }

  /** 用户在文件挑选里勾中的那些,作为 `files` 交给插件 */
  const fileArgs = computed(() => {
    const set = new Set(picked.value)
    return candidates.value.filter((f) => set.has(f.rel))
  })

  /**
   * 交给 `resolveParams` 的那份值。
   *
   * files 字段的值来自页面上的勾选,**不是** rawParams 里那份作者预置的 def:
   * 表单上勾的是用户意图,def 只是初值,两者混在一个对象里读会让「用户到底选了哪些」又出现两个真源。
   * 顺序也取候选表顺序而不是点击顺序 —— 与 `files` 参数同一份顺序,否则同一个选择会有两种排法,
   * 插件里凡是按序号取文件的东西都会跟着抖。
   */
  const paramsForResolve = computed<Record<string, unknown>>(() => {
    const filesField = fields.value.find((f) => f.type === 'files')
    const out: Record<string, unknown> = { ...rawParams.value }
    if (filesField) out[filesField.key] = FA(fileArgs.value).map((f) => f.rel)
    return out
  })

  const paramResult = computed<ParamResult>(() => resolveParams(fields.value, paramsForResolve.value))
  /** 读 issues 走判别式(`ParamResult` 的 ok:true 那一支没有 issues 字段),不靠 any */
  const paramIssues = computed<string[]>(() => {
    const r = paramResult.value
    return r.ok === false ? FA(r.issues).map((i: any) => `${S(i.key)}:${S(i.message)}`) : []
  })

  /**
   * 第一拍:算出计划。
   *
   * 参数没过校验就不调用插件 —— 插件拿到坏值可能算出更坏的东西(它以为框架拦过了)。
   * `selectedRels` 用的就是页面上的勾选,与 `files` 同一份数据,不留两个真源。
   */
  async function makePlan(): Promise<void> {
    if (!usable.value || !manifest.value) return
    if (paramIssues.value.length) { notice.value = '参数还没填对,没有去算改动'; return }
    planning.value = true
    notice.value = ''
    receipt.value = null
    const box = makeCancelBox()
    cancelBox.value = box
    const pid = projectIdRef.value
    const ctx = ctxFor(pid, box)
    const mod = tool.module as any
    const built = await buildPlan({
      toolId: manifest.value.id,
      plan: typeof mod.plan === 'function' ? mod.plan : null,
      ctx,
      files: fileArgs.value,
      params: paramResult.value.values,
      selectedRels: [...picked.value],
      treeRels: [...treeRels.value]
    })
    plan.value = built
    checked.value = defaultSelectedIds(built)
    if (built.planError) notice.value = built.planError
    else if (!built.changes.length) notice.value = planSummary(built)
    planning.value = false
  }

  const groups = computed(() => (plan.value ? groupPreview(plan.value) : []))
  const summary = computed(() => (plan.value ? planSummary(plan.value) : ''))
  const warn = computed(() => (plan.value ? warnText(plan.value.changes) : ''))
  const gate = computed(() => (plan.value ? runGate(plan.value, checked.value) : { ok: false, reason: '还没有计划' }))
  const pickedCount = computed(() => (plan.value ? selectionCount(plan.value, checked.value) : 0))
  const pickedBytes = computed(() => (plan.value ? selectionBytes(plan.value, checked.value) : { bytes: 0, unknown: 0 }))
  const canExecute = computed(() => usable.value && !!plan.value && gate.value.ok === true && !running.value)

  function toggleChange(id: string): void {
    const set = new Set(checked.value)
    if (set.has(id)) set.delete(id)
    else set.add(id)
    checked.value = [...set]
  }

  function checkAll(): void { checked.value = plan.value ? allIds(plan.value) : [] }
  function checkNone(): void { checked.value = [] }
  function checkDefaults(): void { checked.value = plan.value ? defaultSelectedIds(plan.value) : [] }

  /**
   * 第二拍:执行 → 回执 → 记账。
   *
   * 写盘/回收站走宿主的原语(备份由宿主在写之前落),取消由本页的 CancelBox 驱动;
   * 账本记录的是**真正执行的那份子集**(subsetPlan),不是整份预览 —— 否则用户会看到自己没执行的条。
   */
  async function execute(): Promise<void> {
    if (!plan.value || !manifest.value) return
    if (gate.value.ok !== true) { notice.value = S(gate.value.reason); return }
    running.value = true
    notice.value = ''
    const box = cancelBox.value || makeCancelBox()
    cancelBox.value = box
    const pid = projectIdRef.value
    const s = svc()
    const subset = subsetPlan(plan.value, checked.value)
    const r = await executePlan({
      plan: subset,
      apply: typeof (tool.module as any).apply === 'function' ? (tool.module as any).apply : undefined,
      projectId: pid,
      isCancelled: box.isCancelled,
      deps: {
        writeText: (rel: string, text: string) => (typeof s.writeProjectText === 'function' ? s.writeProjectText(pid, rel, text) : { ok: false, error: '宿主没有写盘原语' }),
        trash: (rels: string[]) => (typeof s.movePathsToTrash === 'function' ? s.movePathsToTrash(pid, rels) : { ok: false, error: '宿主没有回收站原语' })
      }
    })
    receipt.value = r
    notice.value = summaryText(r)
    running.value = false
    await recordToLog(subset, r)
  }

  /** 记一笔账。失败不拦回执,但要把「没记上」说出口(备份文件仍在盘上,退路没断) */
  async function recordToLog(subset: ChangePlan, r: ApplyReceipt): Promise<void> {
    const m = manifest.value
    if (!m) return
    const entry = entryFromRun({
      toolId: m.id,
      toolName: m.name,
      projectId: projectIdRef.value,
      plan: subset,
      receipt: r
    })
    const res = await appendRun(storeBridge(), entry)
    if (res.ok !== true) notice.value = `${notice.value};${res.error}`
    else if (res.overflow > 0) notice.value = `${notice.value};已丢弃 ${res.overflow} 条最旧记录,备份文件仍在磁盘上`
    await loadHistory()
  }

  /**
   * 账本用的存储面:走桥接层的 getDoc/putDoc(渲染层唯一那条路,不自己碰 window.ztools.db)。
   *
   * ⚠ 这里的 `value` 包装不是可有可无的:桥接层的 `putDoc` 把数据摊平成 LMDB 文档
   * (`{_id, ...data}`),直接交一个数组过去会变成 `{0:…,1:…}` —— 读回来不是数组,
   * 而 toollog 会说「这个 id 被别的记录占了」。数组住在 `value` 字段里,与插件 store 同一个约定。
   */
  function storeBridge() {
    return {
      getDoc: async (id: string) => F(await getDoc(id)).value,
      putDoc: (id: string, data: unknown) => putDoc(id, { value: data })
    }
  }

  async function loadHistory(): Promise<void> {
    const res: LoadResult = await loadLog(storeBridge())
    historyError.value = res.error
    history.value = FA(res.entries) as ToolLogEntry[]
  }

  /** 工具页底部那几条(Q29=C:本工具最近 5 条) */
  const recent = computed<ToolLogEntry[]>(() => {
    const m = manifest.value
    if (!m) return []
    return recentFor(history.value, m.id)
  })

  /**
   * 回滚一条账目 —— 与执行同一条通道(见文件头判据 3)。
   *
   * 备份内容读回来当作新正文,组成一份 rewrite 计划交给 executePlan:于是回滚本身也有备份、
   * 有回执、进账本(用户能看到「我回滚过一次」,而不是盘上悄悄变了)。
   */
  async function rollback(entry: ToolLogEntry): Promise<RollbackResult> {
    const pid = entry && entry.projectId ? entry.projectId : projectIdRef.value
    const s = svc()
    const rp = rollbackPlan(entry)
    if (S(rp.refused)) return { ok: false, text: rp.refused, restored: [], failed: [] }
    const items = FA(rp.items)
    if (!items.length) return { ok: false, text: '这条账目里没有可还原的文件', restored: [], failed: [] }
    const changes: Change[] = []
    for (const it of items) {
      const rel = S(F(it).rel)
      const bak = S(F(it).backupRel)
      const read = typeof s.readProjectText === 'function' ? await s.readProjectText(pid, bak) : { ok: false, error: '宿主没有读文本原语' }
      if (!read || read.ok !== true || read.truncated === true || read.skippedBinary === true) {
        return { ok: false, text: `读不回备份 ${bak}`, restored: [], failed: [{ rel, error: S(F(read).error) || '备份读不出来' }] }
      }
      changes.push({
        rel,
        kind: 'rewrite',
        label: `还原 ${rel}(取自 ${bak})`,
        risk: 'low',
        reason: '这是按账目还原:把备份的正文写回原文件;当前内容同样会先落一份新备份。',
        payload: { text: String(F(read).text || '') }
      })
    }
    const built = await buildPlan({
      toolId: S(manifest.value && manifest.value.id) || 'toollog',
      plan: () => changes,
      ctx: ctxFor(pid, makeCancelBox()),
      files: [],
      params: {},
      selectedRels: changes.map((c) => c.rel),
      treeRels: [...treeRels.value]
    })
    const box = makeCancelBox()
    cancelBox.value = box
    const r = await executePlan({
      plan: built,
      projectId: pid,
      isCancelled: box.isCancelled,
      deps: {
        writeText: (rel: string, text: string) => (typeof s.writeProjectText === 'function' ? s.writeProjectText(pid, rel, text) : { ok: false, error: '宿主没有写盘原语' }),
        trash: (rels: string[]) => ({ ok: false, error: `回滚不该删文件:${rels.join(',')}` })
      }
    })
    await recordToLog(built, r)
    const failed = FA(r.failed).map((f: any) => ({ rel: S(f.rel), error: S(f.error) }))
    return {
      ok: r.ok === true,
      text: r.ok === true ? `已还原 ${FA(r.written).length} 个文件` : `有 ${failed.length} 个文件没还原成功`,
      restored: FA(r.written).map((x: any) => S(x)),
      failed
    }
  }

  function cancel(): void {
    if (cancelBox.value) cancelBox.value.cancel()
  }

  const cancelled = computed(() => cancelBox.value ? cancelBox.value.cancelled === true : false)

  return {
    tool,
    fields,
    schemaIssues,
    rawParams,
    candidates,
    picked,
    fileArgs,
    treeRels,
    treeTruncated,
    plan,
    checked,
    running,
    planning,
    receipt,
    notice,
    history,
    historyError,
    recent,
    usable,
    paramIssues,
    groups,
    summary,
    warn,
    gate,
    pickedCount,
    pickedBytes,
    canExecute,
    cancelled,
    open,
    loadTree,
    makePlan,
    toggleChange,
    checkAll,
    checkNone,
    checkDefaults,
    execute,
    rollback,
    cancel,
    loadHistory
  }
}

// 局部小工具:与测试夹具同一套安全取值口径(变异态下不抛异常)
function F(x: any): any { return x && typeof x === 'object' ? x : {} }
function FA(x: any): any[] { return Array.isArray(x) ? x : [] }
function S(x: any): string { return typeof x === 'string' ? x : '' }
