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

import { computed, ref, shallowRef } from 'vue'
import type { CancelBox } from '../toolkit/gpm'
import type { Change, ChangePlan, PlannedChange } from '../toolkit/change'
import type { ApplyReceipt } from '../toolkit/change'
import type { GpmHost } from '../toolkit/gpm'
import { buildGpm, makeCancelBox } from '../toolkit/gpm'
import type { RegisteredTool } from '../toolkit/loader'
import type { FieldDesc, ParamResult } from '../toolkit/schema'
import { resolveParams, usableFields, validateSchema } from '../toolkit/schema'
import type { FileDiff } from '../toolkit/diff'
import { diffText } from '../toolkit/diff'
import type { LoadResult } from '../toolkit/toollog'
import { appendRun, entryFromRun, loadLog, recentFor, rollbackPlan } from '../toolkit/toollog'
import type { ToolLogEntry } from '../toolkit/toollog'
import type { Services } from '../types/services'
import { copyText, getDoc, listDocs, notify, openPath, pickPaths, pickSavePath, putDoc, removeDoc } from '../services/bridge'
import {
  allIds,
  buildPlan,
  danglingWarn,
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
import { extOf } from '../tools/treeUtils'

/** 宿主的原语面(测试里桩掉 window.services 就能跑,与 useToolkit 同一套做法) */
function svc(): Partial<Services> {
  return (typeof window !== 'undefined' ? (window as any).services : null) || {}
}

/** 交给 `buildGpm` 的项目文档前缀(与 `useProjectList` 读列表用的同一个前缀) */
const PROJECT_PREFIX = 'godot/project/'

/**
 * 宿主原语在 `window.services` 里(`scanProjectTree` 那一族),但 §5.3 承诺给插件的
 * **store / 宿主 UI / 项目列表**不在那儿 —— 真宿主的 `services.js` 门面只有项目文件那几个原语,
 * 文档读写、通知、系统对话框在渲染层唯一的那条路是桥接层 `services/bridge.ts`(它才碰
 * `window.ztools.db` 与 `showOpenDialog`)。
 *
 * 所以这一层必须把两份面**拼起来**交给 gpm:不拼的话插件的 `ctx.store.put()` 永远回 false、
 * `ctx.notify()` 永远没声音、`ctx.listProjects()` 永远是空数组 —— 而 gpm 的纯函数测试是自己注入
 * `host.services` 的,照不出这一层漏了,这类缺口能一路绿到真机(Q33 说「只能真机验」的那些除外)。
 */
function pluginServices(): GpmHost['services'] {
  const s: Record<string, unknown> = { ...(svc() as Record<string, unknown>) }
  s.listProjects = () => listDocs<unknown>(PROJECT_PREFIX)
  // 插件可能给完整文档 id,也可能只给后缀:补成同一个形状,读不到就回 null 而不是猜一个
  s.getProject = (id: string) => {
    const raw = String(id ?? '')
    return getDoc(raw.startsWith(PROJECT_PREFIX) ? raw : PROJECT_PREFIX + raw)
  }
  s.getDoc = (id: string) => getDoc(String(id ?? ''))
  s.putDoc = (id: string, data: object) => putDoc(String(id ?? ''), data)
  s.removeDoc = (id: string) => removeDoc(String(id ?? ''))
  s.notify = (text: string) => notify(String(text ?? ''))
  s.copyText = (text: string) => copyText(String(text ?? ''))
  s.shellOpenPath = (p: string) => openPath(String(p ?? ''))
  s.openDialog = async (opts: unknown) => {
    const o = (opts ?? {}) as { title?: string, extensions?: string[], defaultPath?: string, directory?: boolean }
    const paths = await pickPaths(o)
    return { canceled: paths.length === 0, filePaths: paths }
  }
  s.saveDialog = async (opts: unknown) => {
    const o = (opts ?? {}) as { title?: string, defaultPath?: string, extensions?: string[] }
    const picked = await pickSavePath(o)
    return { canceled: picked === '', filePath: picked }
  }
  return s as GpmHost['services']
}

export interface RollbackResult {
  ok: boolean
  /** 一句结论(本页特有的话,不复用插件文案) */
  text: string
  restored: string[]
  failed: { rel: string, error: string }[]
}

/**
 * 单条改写的 diff 预览。
 *
 * 三种「不给 diff」分开说,而不是画一张空表糊弄过去:
 *   · 原文件读不出来 / 没拿到完整正文(超限、二进制)—— 那连"旧"都没有;
 *   · 这一条的正文要执行那一刻才产出(插件实现了 `apply` 而 payload 里没放 text)—— 旧文本有,新文本还没有。
 *     这一档是**插件的形状**决定的,不是页面偷懒,所以措辞要把责任说清。
 */
export interface DiffPreview {
  ready: boolean
  oldText: string
  newText: string
  diff: unknown
  error: string
}

/** 只读也行:传 computed / ref 都算,页面不许反过来通过它改当前项目 */
export function useToolPage(tool: RegisteredTool, projectIdRef: { readonly value: string }) {
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
  /**
   * 那条提示「这一轮成了没」:'' 没话 / 'ok' 真的落盘并记上了 / 'bad' 被拦、失败、没算出东西。
   *
   * 以前 `.notice` 只有一种颜色 var(--ok),而 notice 承载八处语义 —— 门拒绝、planError、
   * 回滚失败、账本没记上全都是绿的(真宿主上用户读成「显示错误」的那条就是它)。
   * 定级收在 `say()` 一个口子里:新增一条提示**必须**经过它,漏定级在结构上不可能。
   */
  const noticeKind = ref('')

  /** notice 唯一的写入口:文本与级别一次设好;清空时级别跟着清(不挂一个看着像成功的类) */
  function say(text: string, kind = ''): void {
    notice.value = text
    noticeKind.value = text ? kind : ''
  }
  const history = ref<ToolLogEntry[]>([])
  const historyError = ref('')
  const cancelBox = shallowRef<CancelBox | null>(null)
  /** diff 预览按 change.id 缓存:展开一条只读一次盘,收起再展开不重复读 */
  const previews = ref<Record<string, DiffPreview>>({})
  /**
   * 插件自己 `ctx.log` 出来的话(§G DEV-27)。
   *
   * 第 1 批这两个注入物**根本没传**:`makeHost` 不给 `onLog` / `onProgress` ⇒ `ctx.log` 是静默 no-op,
   * 内置格式化那两处「这个文件为什么没做」一个字都没上卡面(纯函数测试各自测自己那一层,照不出装配层漏接)。
   * 现在接上了,并且每次「算一遍 / 执行」都清空 —— 上一轮的跳过原因留着,用户会以为这一轮也跳过了。
   */
  const logs = ref<{ level: string, msg: string }[]>([])
  /** 插件报的进度(done/total);拿不到就是 null(不画 0/0 那种假进度) */
  const progress = ref<{ done: number, total: number } | null>(null)

  const manifest = computed(() => (tool && tool.manifest) || null)
  const usable = computed(() => !!manifest.value && tool.state === 'ok' && !!tool.module)

  /** 组一份真 ctx:能力按 manifest 声明给,取消框按页持有(gpm.ts 的那道门不在这里重写) */
  function makeHost(pid: string, box: CancelBox): GpmHost {
    const m = manifest.value
    return {
      services: pluginServices(),
      toolId: m ? m.id : '',
      toolName: m ? m.name : '',
      projectId: pid,
      capabilities: (m ? m.capabilities : []) as any,
      unsafe: !!m && m.unsafe === true,
      cancelled: box.isCancelled,
      onCancel: box.onCancel,
      // DEV-27:这两条就是「插件的话能不能上卡面」的唯一通道。少接一条,插件里所有 ctx.log/progress
      // 都会静默消失 —— 而它在自己那层的单测里永远是好的(它测的是 buildGpm 收不收,不收谁都不说)。
      onLog: (level: string, msg: string) => {
        const list = logs.value.concat([{ level: String(level ?? ''), msg: String(msg ?? '') }])
        // 上限只护住内存;卡面上显示最近几条 + 「还有 N 条」,不做起伏滚动组件
        logs.value = list.length > 60 ? list.slice(-60) : list
      },
      onProgress: (done: number, total: number) => {
        const t = Number(total)
        const d = Number(done)
        if (!Number.isFinite(t) || t <= 0 || !Number.isFinite(d)) return
        progress.value = { done: Math.max(0, Math.min(d, t)), total: t }
      }
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

  /**
   * 文件树:候选 = 按 files 字段声明的后缀筛过;`truncated` 要显式带出去(清单不全时不敢说「这些就是全部」)。
   *
   * ⚠ 声明了 `ref` 的工具**那一次扫描不按后缀筛**,筛候选这一步挪到内存里做。
   * `treeRels` 是框架回答「这个改写目标在不在盘上」的唯一依据(`buildPlan` 用它判 `creates`),
   * 而 ref 型工具的改写面天生比挑选面广 —— 改名工具要写 `project.godot`、`.cs`、`.json`,那些都不在
   * `.gd/.tscn/.tres` 里。拿按后缀筛过的清单去判,盘上明明有的文件会被说成
   * 「新建,没有备份可还原」(假宿主整页跑第一次就撞上这句谎话,而它在真宿主上一样成立)。
   * 现在这副清单与 `ctx.refIndex()` 自己那次 `scanTree({})` 是同一份,扫描次数不增加。
   */
  async function loadTree(): Promise<void> {
    const pid = projectIdRef.value
    if (!pid) { candidates.value = []; treeRels.value = []; return }
    const filesField = fields.value.find((f) => f.type === 'files')
    const exts = filesField && filesField.exts.length
      ? filesField.exts.map((e) => String(e).replace(/^\./, '').toLowerCase())
      : []
    const m = manifest.value
    // 与 gpm.ts 的能力门同一个来源(manifest 声明),不留第二套「它有没有 ref」的说法
    const wide = Array.isArray(m && m.capabilities) && (m as any).capabilities.includes('ref')
    let r: any = { files: [], truncated: false, error: '本工具没声明 tree 能力' }
    try {
      const s = svc()
      const opts = exts.length && !wide ? { exts } : {}
      r = typeof s.scanProjectTree === 'function' ? await s.scanProjectTree(pid, opts) : r
    } catch {
      r = { files: [], truncated: false, error: '读文件树抛异常' }
    }
    const scanned = Array.isArray(r && r.files) ? r.files : []
    // 内存里筛候选只按 ① 层那一条 `extOf`,不去读宿主的 `ext` 键:两条规则判同一件事就是第二个真源
    const list = exts.length && wide
      ? scanned.filter((f: any) => exts.includes(extOf(String(f && f.rel || ''))))
      : scanned
    treeRels.value = scanned.map((f: any) => String(f && f.rel || '')).filter(Boolean)
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
    if (paramIssues.value.length) { say('参数还没填对,没有去算改动', 'bad'); return }
    planning.value = true
    say('')
    logs.value = []
    progress.value = null
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
    // 计划一重算,旧的 diff 预览就过期了(同一 rel 的新正文可能已经不同):缓存必须跟着作废
    previews.value = {}
    if (built.planError) say(built.planError, 'bad')
    else if (!built.changes.length) say(planSummary(built), 'bad')
    planning.value = false
  }

  /**
   * 展开某一条时按需读旧正文并算 diff(§5.8:diff 只裁展示,不影响能不能勾)。
   *
   * 读盘走同一个 ctx(能力门与前缀隔离都照 manifest 的声明),不新开第二条读文件的通路。
   */
  async function loadDiff(change: PlannedChange | null): Promise<DiffPreview> {
    const id = change && typeof change.id === 'string' ? change.id : ''
    if (!change || !id) return { ready: false, oldText: '', newText: '', diff: null, error: '没有这一条的标识,读不到它要改什么' }
    const hit = previews.value[id]
    if (hit) return hit
    const ctx = ctxFor(projectIdRef.value, makeCancelBox())
    const r = await ctx.readText(change.rel)
    const payload = F(change.payload)
    let out: DiffPreview
    if (r.error) out = { ready: false, oldText: '', newText: '', diff: null, error: `读不到原文件:${r.error}` }
    else if (r.truncated || r.skippedBinary) out = { ready: false, oldText: '', newText: '', diff: null, error: '没拿到完整正文(超出读取上限或被判成二进制),不拿半截内容画 diff' }
    else if (typeof payload.text !== 'string') out = { ready: false, oldText: r.text, newText: '', diff: null, error: '这条的正文由插件在执行那一刻产出,预览阶段没有 diff' }
    else out = { ready: true, oldText: r.text, newText: payload.text, diff: diffText(r.text, payload.text), error: '' }
    previews.value = { ...previews.value, [id]: out }
    return out
  }

  /** 这条能不能给出 diff(决定 UI 上那个「看差异」按钮要不要亮着) */
  function diffible(change: PlannedChange | null): boolean {
    return !!change && typeof F(change.payload).text === 'string'
  }

  const groups = computed(() => (plan.value ? groupPreview(plan.value) : []))
  const summary = computed(() => (plan.value ? planSummary(plan.value) : ''))
  const warn = computed(() => (plan.value ? warnText(plan.value.changes) : ''))
  /** A-22 那句红字:整句由框架生成(`orchestrate.danglingWarn`),这里只搬 —— 视图不许自己拼数字 */
  const dangling = computed(() => (plan.value ? danglingWarn(plan.value.changes) : ''))
  /**
   * 表单旁边那句**参数预览**(§5.7 的「匹配到 12 处」)。
   * 话由插件的可选导出 `count(params, files)` 说(§G DEV-28):它才知道自己的正则作用于什么之上。
   * 没有这个导出、或它抛异常 ⇒ 空串不画条(一个工具的坏导出不能把整个表单弄白屏)。
   */
  const paramHint = computed(() => {
    const mod = tool.module as { count?: unknown } | null | undefined
    if (!mod || typeof mod.count !== 'function' || !paramResult.value) return ''
    try {
      const v = (mod.count as (p: unknown, f: unknown) => unknown)(paramResult.value.values, fileArgs.value)
      return typeof v === 'string' ? v : ''
    } catch {
      return ''
    }
  })
  /** 卡面上显示的最近几条(视图不做切片运算:那是判断,不是排版) */
  const logsTail = computed(() => logs.value.slice(-3))
  const logsMore = computed(() => Math.max(0, logs.value.length - 3))
  const gate = computed(() => (plan.value ? runGate(plan.value, checked.value) : { ok: false, reason: '还没有计划' }))
  /**
   * 「同一句话在屏上出现三次」的修法(假宿主整页跑撞到的排版 bug:算完 0 条时,摘要、门、结论三处
   * 都来自 orchestrate 的同一句 `EMPTY_PLAN_REASON`,读起来像页面卡住了重复渲染)。
   * 三处**各有各的角色**(摘要=这一遍算出什么、门=为什么按不下去、结论=这一轮成了没成),
   * 所以不是删渠道,而是同一句只画第一次出现的那一处:
   *   · 摘要永远画,并且在这种「其实是拒绝」的场合带坏色(以前坏色只在 notice 上,摘要那行是中性的);
   *   · 结论与门那句只要与已经画出来的那句逐字相同,就不再重复。
   */
  const summaryKind = computed(() => (plan.value && !plan.value.changes.length ? 'bad' : ''))
  const noticeText = computed(() => (notice.value === summary.value ? '' : notice.value))
  const gateText = computed(() => {
    const g = gate.value
    if (g.ok === true) return ''
    const t = S(g.reason)
    if (!t || t === summary.value || t === noticeText.value) return ''
    return t
  })
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
    if (gate.value.ok !== true) { say(S(gate.value.reason), 'bad'); return }
    running.value = true
    say('')
    logs.value = []
    progress.value = null
    const box = cancelBox.value || makeCancelBox()
    cancelBox.value = box
    const pid = projectIdRef.value
    const s = svc()
    const subset = subsetPlan(plan.value, checked.value)
    // 插件侧的契约是 `apply(ctx, change)`(§F 的 entry 契约,骨架模板注释也这么写),
    // 而 orchestrate 的注入缝是 `apply(change, index)` —— 这里得先把 ctx 绑上再交出去。
    // 直接把模块上的原函数交过去时,插件收到的「ctx」其实是那条 change、「change」是一个数字,
    // 于是它自己的 `change.payload.text` 当场炸成「reading 'text' of undefined」(DEV-19)。
    const mod = tool.module as any
    const applyCtx = typeof mod.apply === 'function' ? ctxFor(pid, box) : null
    const r = await executePlan({
      plan: subset,
      apply: applyCtx ? (change: PlannedChange, index: number) => mod.apply(applyCtx, change, index) : undefined,
      projectId: pid,
      isCancelled: box.isCancelled,
      deps: {
        writeText: (rel: string, text: string) => (typeof s.writeProjectText === 'function' ? s.writeProjectText(pid, rel, text) : { ok: false, error: '宿主没有写盘原语' }),
        trash: (rels: string[]) => (typeof s.movePathsToTrash === 'function' ? s.movePathsToTrash(pid, rels) : { ok: false, error: '宿主没有回收站原语' }),
        // §G Task 15 的改名原语。宿主没有它时**逐条**说清楚,而不是让框架拿 undefined 当成功
        rename: (rel: string, to: string) => (typeof s.renameProjectPath === 'function' ? s.renameProjectPath(pid, rel, to) : { ok: false, error: '宿主没有改名原语' })
      }
    })
    receipt.value = r
    // 部分完成(有失败项)不算成:回执那句自己会写「失败 N 条」,颜色跟着走
    say(summaryText(r), FA(F(r).failed).length ? 'bad' : 'ok')
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
    if (res.ok !== true) say(`${notice.value};${res.error}`, 'bad')
    else if (res.overflow > 0) say(`${notice.value};已丢弃 ${res.overflow} 条最旧记录,备份文件仍在磁盘上`, 'ok')
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
  /** 外面看到的这一个只多做一件事:把「成了没成」定好级 —— 每一条 return 都经过这里,包括早退的拒绝 */
  async function rollback(entry: ToolLogEntry): Promise<RollbackResult> {
    const r = await doRollback(entry)
    say(r.text, r.ok === true ? 'ok' : 'bad')
    return r
  }

  async function doRollback(entry: ToolLogEntry): Promise<RollbackResult> {
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
        trash: (rels: string[]) => ({ ok: false, error: `回滚不该删文件:${rels.join(',')}` }),
        // 还原不该动名字:含 rename 的账目在 `refuseReason` 那一步就被拒了(§G DEV-20),
        // 走到这里还带改名条目只可能是别处漏下来的 —— 宁可拒绝执行,也不悄悄把名字改回去一半
        rename: (rel: string, to: string) => ({ ok: false, error: `回滚不该改名:${rel} → ${to}` })
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
    noticeKind,
    noticeText,
    summaryKind,
    gateText,
    logs,
    logsTail,
    logsMore,
    progress,
    dangling,
    paramHint,
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
    /** view 型工具要的 ctx(同一套能力门与前缀隔离,不另开一条给插件的通路) */
    ctx: () => ctxFor(projectIdRef.value, cancelBox.value || makeCancelBox()),
    open,
    loadTree,
    makePlan,
    loadDiff,
    diffible,
    previews,
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
