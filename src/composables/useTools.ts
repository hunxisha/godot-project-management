// 工具页的状态与调度:选项目 → 扫一次树 → 按注册表跑检查器 → 存结果 → 按结论执行修复。
// 关键不变量(spec §5.1):同一个项目的 tree 只扫一次,所有工具共享 ctx。
// 它的孪生不变量(审查 F-1):一份 tree 只属于**发起它的那个项目**。扫描是真的异步 IPC,
// 所以「tree 与 readText 同属一个项目」靠世代号 + 捕获的 pid 绑定,过期结果整份丢弃。
// B10a 把同一条不变量延伸到引用索引(ctx.refIndex 那份按 (projectId, scanGen) 键控的 memo):
// 索引是这页唯一带真实 IO 的公共调用,清单换代它就是旧目录的引用图 —— 与 tree 同生同灭。
//
// 修复调度的不变量(spec §5.3,Task B1):渲染层只交 rel,绝对路径与越界/符号链接的包含闸
// 归原语(inspectfs.js 的 resolveInside);原语回报的 ok/failed/moved 一律如实上浮;
// 磁盘真变了才 invalidateTree(改过的清单不能让 60s TTL 端着,而什么都没改成的失败不配一次重扫)。
//
// 红线:这是渲染层组合式函数,只用 vue 的 ref/computed,不碰 DOM;能力一律走
// window.services 契约(两端 JS 宿主与 Tauri 宿主同一份签名)。
import { computed, ref } from 'vue'
import { isWindows, listDocs } from '../services/bridge'
import type { GodotProject, ScanTreeResult, TreeEntry } from '../types/godot'
import type { Capability, Finding, Tool, ToolContext, ToolResult } from '../tools/types'
import { planFix, type FixService } from '../tools/fixPlan'
import { subsetPlan } from '../tools/gate'
import { buildRefIndex, type RefIndex } from '../tools/refIndex'
import { TOOLS as BASE_TOOLS, isSupported, toolById } from '../tools/registry'

// 注册表跟着本模块一起导出:视图只要 useTools 这一处,就能同时拿到「有哪些工具」和「怎么跑」。
// (不要改去 import `../tools/index.ts` —— 那个 barrel 只为渲染层测试存在,会把无关模块拖进 chunk。)
export { TOOLS, isSupported, toolById } from '../tools/registry'

/** 超过它就重扫;修完文件要手动 invalidate */
const TREE_TTL = 60000
/** 文本读取的 LRU 上限:一次全量体检最多驻留这么多文件的内容 */
const TEXT_LRU = 200

/**
 * 两个宿主对「项目目录读不到」各说一句话(JS 侧 `项目目录已不存在`、Rust 侧
 * `项目目录不可读`,见 src-ztools/preload/lib/inspectfs.js:245 与
 * src-tauri/src/inspectfs.rs:511),而双端 parity 测试钉死了原语的文案不许动。
 * 所以在 UI 这一层归一成一个口径,别让用户看到两句其实同一件事的提示。
 * 除这两句之外的错误原文一律透传 —— 它们是各自的诊断信息,归一等于吞掉线索。
 * 真实的透传样本如 '项目不存在'(shim 查不到项目根)、'非法路径'(rel 校验拒),
 * 见 src/public/tauri-shim.js:83-85;测试的第 9 节就按这两句判透传那一路。
 */
const SCAN_ERROR_ALIAS: Record<string, string> = {
  '项目目录已不存在': '项目目录无法读取',
  '项目目录不可读': '项目目录无法读取'
}
/** 扫描失败文案的唯一出口(R-C):已知同义句归一,其余原样透传 */
function scanErrorText(raw?: string): string {
  const msg = (raw || '').trim()
  if (!msg) return '扫描失败'
  return SCAN_ERROR_ALIAS[msg] || msg
}

/**
 * 一次修复的回执:成败、动了什么、哪几项失败、备份去哪了,全部在这里定好,
 * FindingList / FixConfirmDialog 只渲染字段,不再自己判「这算不算成功」。
 * message 里的失败原因是**原语原话**(inspectfs.js 的中文错误串),不重译、不改写。
 */
export interface FixOutcome {
  findingId: string
  /** 由 `${toolId}:${稳定键}` 的约定反推,供「重跑这个检查器」用;推不出时是空串 */
  toolId: string
  ok: boolean
  /** 失败原因:宿主不支持 / 管线认不出这条修复 / 原语给的中文原因 */
  error: string
  service: FixService
  /** planFix 定的动词(平台相关:Windows「移入回收站」、其他平台「永久删除」) */
  verb: string
  /** 交给原语的 rel 清单(相对路径,渲染层不拼绝对路径) */
  rels: string[]
  /** 回收站通道真正移走的项数(按磁盘复核,inspectfs.js:292-293) */
  moved: number
  /** 改写通道真正落盘成功的 rel */
  written: string[]
  /** 失败项:rel + 原语原话 */
  failed: { rel: string; error: string }[]
  /** 原语回报的备份 rel(spec §5.3 规则 4 的「可撤销提示」) */
  backups: string[]
  /** 磁盘是否真的变了:这是「要不要重扫」的唯一判据 */
  changed: boolean
  /** changed 且确实调了 invalidateTree(切了项目时不调,回执照样如实) */
  invalidated: boolean
  message: string
  at: number
}

/** 失败项的一行汇总:`rel:原语原话`,多项用分号隔开 */
function failedText(failed: { rel: string; error: string }[]): string {
  return failed.map((x) => `${x.rel}:${x.error}`).join(';')
}

/**
 * 平台口径取不到时退回 false(非 Windows 口径)。
 * 方向是刻意选的:说不准就按「永久删除」说 —— 把可还原说成不可还原只是难听,
 * 把不可还原说成可还原会让用户以为能撤回而真的删掉东西。
 */
function hostIsWindows(): boolean {
  try {
    return isWindows() === true
  } catch {
    return false
  }
}

type WithId = GodotProject & { _id?: string }

export function useTools() {
  const projects = ref<WithId[]>([])
  const projectId = ref('')
  const tree = ref<TreeEntry[]>([])
  const treeAt = ref(0)
  const truncated = ref(false)
  const running = ref('')
  const allRunning = ref(false)
  const progress = ref('')
  const error = ref('')
  const results = ref<Record<string, ToolResult>>({})
  const tools = ref<Tool[]>([...BASE_TOOLS])
  /** 正在执行的修复所属的 finding id(空串 = 没有修复在途) */
  const fixing = ref('')
  /** 按 finding id 记账的修复回执:结论面板要回显「已移入回收站 3 项 / 1 项失败」并据此重跑检查器 */
  const fixResults = ref<Record<string, FixOutcome>>({})

  /**
   * 宿主能力探测:方法不存在(旧宿主/未移植)就是不支持,而不是静默假成功。
   * 这是**构造时快照**,理由:index.html 用 `<script src="/tauri-shim.js">` 这种阻塞式经典脚本
   * 在模块入口之前把 window.services 建好,而 src/main.ts 在 window.services 缺失时直接拒绝挂载
   * (显示启动错误而不是挂载),所以任何 useTools() 实例创建时能力都已定型,不存在「晚一点再探」。
   */
  const caps: Record<Capability, boolean> = {
    tree: typeof window.services?.scanProjectTree === 'function',
    text: typeof window.services?.readProjectText === 'function',
    write: typeof window.services?.writeProjectText === 'function',
    trash: typeof window.services?.movePathsToTrash === 'function'
  }

  /**
   * 扫描世代号(审查 F-1):select() 与 invalidateTree() 各自 +1。
   * ensureTree 在 await 之前记下当时的值,await 之后比对 —— 不一致就说明这份清单属于
   * 上一个项目 / 上一次作废之前的目录,整份丢弃。桌面宿主的 scanProjectTree 是真的异步
   * IPC(几百毫秒到几秒),「扫描在途时用户点了项目选择器」是常态而不是边角。
   */
  let scanGen = 0
  /** 最近一次**发起**的扫描属于哪个世代:只有它有权复位 running/progress,免得迟到的旧扫描把正在扫的那次显示成空闲 */
  let scanOwnedGen = -1

  const textCache = new Map<string, { text?: string; skipped?: boolean }>()

  /**
   * 引用索引的**单份**缓存(B10a,spec §5.2「ctx 一次扫描多工具共享」的最后一笔欠账)。
   *
   * buildRefIndex 是整页唯一带真实 IO 的公共调用(每个来源一次 readText)。接线 6 个工具之后,
   * 吃索引的工具各自重读约 3 千个文件是不可接受的 —— 缓存这一处就把重复遍历全部消掉。
   *
   * 键 = `项目id#扫描世代`,失效有三处(三处的分工由变异取证区分,不是随手多写):
   *   · **承重的那一处是 `ensureTree`**:它每成功装进一份新清单就清一次。TTL 到期与 runAll 的
   *     强制重扫**不推进 scanGen**,只有这里能察觉「清单换了」(删掉它 → §36 的 runAll 那条转红)。
   *   · `select()` 与 `invalidateTree()` 各清一次:这两处同时也推进 scanGen,所以键本身就够用,
   *     显式清是为了不把上一个项目/世代的索引留在内存里,并且让「索引寿命 = 清单新鲜度」这条
   *     规则不依赖调用点纪律(变异取证:单独删这两处之一当前无观测差异)。
   * 存的是 **promise** 而不是结果:同一代里两个工具同时取用时只有一趟遍历,第二个等同一份。
   * 只存索引本身,不存 finding:结论按工具与项目成立,缓存它就绕过了「修完重跑这一个检查器」的语义。
   */
  let refCache: { key: string; promise: Promise<RefIndex> } | null = null

  function refIndexOf(context: ToolContext): Promise<RefIndex> {
    const key = `${context.projectId}#${scanGen}`
    if (refCache && refCache.key === key) return refCache.promise
    const promise = buildRefIndex(context)
    // 建索引失败不留缓存:与 readText 的「失败的读不写 LRU」同一口径(审查 F-3)。
    // 一次临时 IO 错如果粘在缓存上,整个世代都拿不到索引,而 orphans 会拿着残缺的引用图劝人删文件。
    promise.catch(() => {
      if (refCache && refCache.key === key) refCache = null
    })
    refCache = { key, promise }
    return promise
  }

  async function load() {
    const rows = ((await listDocs<GodotProject>('godot/project/')) || []) as WithId[]
    projects.value = rows
    if (!projectId.value && rows.length) {
      // 默认取最近打开的;没有记录退回列表首项(spec §5.8)
      const sorted = [...rows].sort((a, b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0))
      projectId.value = sorted[0]._id || ''
    }
  }

  function selected(id = projectId.value): WithId | undefined {
    return projects.value.find((p) => p._id === id)
  }

  /**
   * 保证 ctx.tree 是本次可用的清单:命中 TTL 就复用,否则扫一次。
   * @param force 全量体检(runAll)与 invalidateTree 后强制重扫
   */
  async function ensureTree(force = false): Promise<boolean> {
    const pid = projectId.value
    if (!pid) { error.value = '还没有添加项目'; return false }
    // 共享树的核心:TTL 内、非强制 → 一律复用,不再扫。
    // 新鲜度标记只看 treeAt(只有成功那一路会置位,任何失败路径与 select() 都归零),
    // **不看 tree.value.length**:Rust 侧对「空而可读」的根目录如实回 { ok:true, files:[] }
    // (src-tauri/src/inspectfs.rs:509-512),按长度判这种项目永远命中不了 TTL ——
    // 每个工具各重扫一遍,runAll 直接退化成 1+N 次目录遍历(审查 F-2a)。
    if (!force && treeAt.value > 0 && Date.now() - treeAt.value < TREE_TTL) return true
    if (!caps.tree) { error.value = '当前宿主不支持文件扫描'; return false }
    const gen = scanGen
    scanOwnedGen = gen
    running.value = 'scan'
    // 审查 M-8:progress 在 runAll 期间归 runAll 所有(它写的是「正在体检 i/n:工具名」)。
    // 某个工具内部触发重扫时,这次扫描既不能覆盖那一行,收尾时也不能把它擦成空 ——
    // 全量体检自己的那行「正在体检:准备文件清单…」由 runAll 写。
    if (!allRunning.value) progress.value = '正在扫描文件清单…'
    let r: ScanTreeResult | undefined
    let thrownMsg = ''
    try {
      // 必须显式要 includeCache:原语默认**跳过** .godot,不带上它 cache 检查器永远只会报
      // 「清单里没有 .godot 条目」。同时**不许**传 exts/skipDirs/maxEntries 缩小范围:
      // 原语只在条目上限处才打 truncated,被过滤的清单同样不完整却不再带标记,
      // brokenRefs 就会把其实存在的文件报成丢失(error 级假阳性,spec §5.1 / 审查 F-2)。
      r = await window.services.scanProjectTree(pid, { includeCache: true })
    } catch (e) {
      // 原语本身抛异常(宿主实现出错)也只标失败,不让它把页面卡在「正在扫描」
      thrownMsg = scanErrorText((e as Error)?.message)
    }
    // 审查 F-1:await 期间 select()/invalidateTree() 可能已经推进了世代号。这份清单属于
    // **上一个项目**(或上一个已被作废的目录),写进当前状态就是跨项目串树:treeAt 一并刷新,
    // 于是接下来整个 TTL 里所有检查器都复用这棵错树;而 ctx.readText 读的是当前项目的文本,
    // brokenRefs 会拿 A 的场景去比 B 的清单,产出 error 级假阳性 —— 正是 R-A 要防的那一类。
    // 处置:整份丢弃(不写 tree/treeAt/truncated/textCache,也不上浮它的错误),返回 false。
    if (projectId.value !== pid || gen !== scanGen) {
      if (scanOwnedGen === gen) {
        // 只有「最近发起的那次扫描」才是自己人:后面已有新扫描时把进度让给它自己收
        running.value = ''
        if (!allRunning.value) progress.value = ''
      }
      return false
    }
    running.value = ''
    // 审查 M-8:同上 —— runAll 的进度行「正在体检 i/n:工具名」由 runAll 自己收尾。
    if (!allRunning.value) progress.value = ''
    if (thrownMsg || !r || !r.ok) {
      error.value = thrownMsg || scanErrorText(r?.error)
      tree.value = []
      treeAt.value = 0
      // 审查 M-9:失败路径同样要复位 truncated。select() 已经懂这一手,扫描失败也一样 ——
      // 残留的 true 会让接下来所有检查器一律「只出截断结论、不判定」,把结论静默吃掉。
      truncated.value = false
      return false
    }
    error.value = ''
    // ScanTreeResult 的 files/truncated 在契约里是**可选**字段(两端都可能不给),
    // 在这里归一成必填的形状,下游检查器拿到的 ctx.tree/ctx.truncated 才是诚实的。
    tree.value = r.files ?? []
    truncated.value = r.truncated === true
    treeAt.value = Date.now()
    // 清单变了(重扫/换项目),之前读到的文本随时可能已经过时
    textCache.clear()
    // 同理,B10a 的索引缓存也属于**上一份清单**:这一路不推进 scanGen,靠这里显式作废。
    refCache = null
    return true
  }

  /**
   * 所有工具共用的一份上下文:tree 来自缓存,readText 走 LRU(spec §5.1)。
   * @param pid 调用方当场选中的项目 id —— 审查 F-1:这里**捕获一次**并一路用它,
   *   于是「A 的清单 + B 的文本」这种混搭配在构造上就不可能出现;文本缓存的键也带上它,
   *   跨项目同名的 rel 不会互相命中。
   */
  function ctx(pid: string): ToolContext {
    const root = selected(pid)?.path || ''
    const context: ToolContext = {
      projectId: pid,
      root,
      tree: tree.value,
      truncated: truncated.value,
      readText: async (rel: string) => {
        const k = `${pid}|${rel}`
        const hit = textCache.get(k)
        if (hit) {
          // 命中也要把它挪到队尾:这是 LRU 而不是 FIFO —— 不刷新最近使用顺序的话,
          // 正在被反复读的热文件会和冷文件一起被淘汰,缓存等于没起作用。
          textCache.delete(k)
          textCache.set(k, hit)
          return hit
        }
        let v: { text?: string; skipped?: boolean }
        if (!caps.text) {
          // 宿主压根没有读文本能力:这是**恒定**状态(caps 是构造时快照),按 skipped 缓存住,
          // 不必每次重试。缺该能力的工具早在 isSupported 那一步就短路了,走到这里只可能是
          // 一个没声明 text 需求的工具自己去读。
          v = { skipped: true }
        } else {
          try {
            const rr = await window.services.readProjectText(pid, rel)
            v = rr.ok && typeof rr.text === 'string' ? { text: rr.text } : { skipped: true }
          } catch {
            // 与读文本原语的三态同形:给不出字符串就是「读不到」。单个文件读炸只跳过
            // 这一个文件,不把整个工具拖成 ok:false(否则一个坏文件能让全项目断链体检报废)。
            // 但审查 F-3:**失败的结果不进缓存** —— 一次 EACCES/临时 IO 错如果被缓存成
            // skipped,这个文件在整个清单生命周期里再也不会被重试,而 brokenRefs 会静默跳过它
            // 并回 ok:true + 零结论,UI 无法区分「真的没有断链」和「我什么都没读到」。
            // 这里只把本次调用标成 skipped,下一次读会真的重试。
            // (宿主明确回 ok:false 的二进制/超限/非法路径是**确定性**结果,照旧进缓存。)
            return { skipped: true }
          }
        }
        if (textCache.size >= TEXT_LRU) textCache.delete(textCache.keys().next().value as string)
        textCache.set(k, v)
        return v
      },
      /**
       * 索引取用入口(B10a)。**必须**经由 ctx 递进去:检查器一旦 import 一个模块级单例,
       * 「一次扫描共享一份」就变成「整个渲染进程共享一份」,跨项目与换代失效都得重写一遍。
       * 用闭包外的 context 而不是新建一份 ctx:索引读的是**这个工具正在用的**那份清单与文本 LRU,
       * 同源才能保证「同一代两次取用逐字节同一份」。
       */
      refIndex: () => refIndexOf(context)
    }
    return context
  }

  async function runTool(id: string): Promise<ToolResult | null> {
    const t = tools.value.find((x) => x.id === id)
    if (!t) return null
    // 能力缺失是状态不是异常:在调用任何原语之前就短路(spec §5.4)
    if (!isSupported(t, caps)) {
      const res: ToolResult = { toolId: id, ok: false, error: '当前宿主不支持', findings: [], scannedFiles: 0, ms: 0 }
      results.value = { ...results.value, [id]: res }
      return res
    }
    if (!(await ensureTree())) return null
    // ensureTree 回 true 就意味着它刚校验过「项目没换、世代没动」,所以此刻的 projectId
    // 与 tree.value 必然同属一个项目;把它捕获进 ctx,F-1 的保证就闭合到 readText 上。
    const pid = projectId.value
    const context = ctx(pid)
    const scanned = context.tree.length
    running.value = id
    const started = Date.now()
    let res: ToolResult
    try {
      // 审查 M-5:R-B 的边界口径同样适用于工具返回值。registerTool 是公开出口,第三方工具
      // (或 P1 的动态注册)完全可能 resolve(undefined);把 undefined 原样存进 results,
      // 渲染期 counts 遍历 r.findings 就会抛 TypeError —— 一个坏工具炸掉整页。
      const findings = await t.run(context)
      res = { toolId: id, ok: true, findings: Array.isArray(findings) ? findings : [], scannedFiles: scanned, ms: Date.now() - started }
    } catch (e) {
      // 单工具失败只标它自己(spec §5.5)
      res = { toolId: id, ok: false, error: (e as Error)?.message || '检查失败', findings: [], scannedFiles: scanned, ms: Date.now() - started }
    }
    running.value = ''
    // 审查 F-1 的残余路径:长工具跑完时项目可能已经被换掉。select() 清空 results 是有意的
    // (结论按项目成立),不能把一个旧项目的结论补写进新项目的面板。
    // 只比 projectId 不比世代号:工具在 run() 里自己调 invalidateTree(修完文件的正常姿势)
    // 不该让它顺手丢掉自己刚产出的结论。
    if (projectId.value === pid) results.value = { ...results.value, [id]: res }
    return res
  }

  /** 全量体检:强制重扫一次,再逐个跑;之间让出事件循环保证 UI 可交互 */
  async function runAll(): Promise<ToolResult[]> {
    allRunning.value = true
    const list = [...tools.value]
    // 起手这行挂在**强制重扫**期间:ensureTree 在 runAll 里不碰 progress(审查 M-8),
    // 之后每个工具把它换成「正在体检 i/n:工具名」。
    progress.value = '正在体检:准备文件清单…'
    // 审查 F-2b:强制重扫失败(目录被弹走 / 权限变了 / 宿主出错)时,这一轮体检**不成立**。
    // 口径:立即停下、只上浮 error 里那一条(R-C 归一后的原因),不产 per-tool 行。
    // 选「停下」而不是「给每工具记一条显式失败」:原因只有一个,摊成 N 张红卡片会让人
    // 以为有 N 个问题,而且那 N 次重扫全都注定失败(1+N 次遍历)。
    if (!(await ensureTree(true))) {
      allRunning.value = false
      progress.value = ''
      return []
    }
    const out: ToolResult[] = []
    for (let i = 0; i < list.length; i++) {
      const t = list[i]
      progress.value = `正在体检 ${i + 1}/${list.length}:${t.name}`
      out.push((await runTool(t.id)) || { toolId: t.id, ok: false, error: '未运行', findings: [], scannedFiles: 0, ms: 0 })
      await new Promise((r) => setTimeout(r, 0))
    }
    allRunning.value = false
    progress.value = ''
    return out
  }

  function select(id: string) {
    if (projectId.value === id) return
    projectId.value = id
    // 审查 F-1:推进世代号 = 作废**所有在途扫描**。桌面宿主的 scanProjectTree 是真异步 IPC,
    // 点选择器时那份扫描还在路上;不推进世代号,它就会把上一个项目的清单写进当前项目。
    scanGen += 1
    // 换项目 = 三份缓存全部作废:树、结果、文本 LRU 都是按项目成立的
    tree.value = []
    treeAt.value = 0
    truncated.value = false
    results.value = {}
    fixResults.value = {}
    textCache.clear()
    refCache = null // 引用索引同样按项目成立(B10a):scanGen 已经推进,键不会再命中,这里连内存一起还
    // error 同样按项目成立:扫描失败的横幅(「项目目录无法读取」)属于**上一个**项目,
    // 不清的话切到正常项目后它会一直挂着,直到下一次扫描成功才消失(Task 16 修复)。
    error.value = ''
  }

  function registerTool(t: Tool) {
    if (!toolById(t.id) && !tools.value.some((x) => x.id === t.id)) tools.value = [...tools.value, t]
  }

  /**
   * 修完文件/外部改过项目后调用:下一次跑强制重扫(世代号同时作废在途的那次扫描,F-1)。
   * 提成具名函数是因为 applyFix 也要用它 —— 回执里的 invalidated 必须说的是「真的调过它」。
   */
  function invalidateTree() {
    scanGen += 1
    treeAt.value = 0
    textCache.clear()
    // 引用索引的键含 scanGen,推进后自然取不到;显式清一次是为了不把上一个世代的引用图留在内存里
    // (修完文件的那一代索引说的正是「已经被删掉的那些文件还被引用」,这种旧图绝不能被下一个工具复用)
    refCache = null
  }

  /**
   * 执行一条结论的修复动作(spec §5.3)。
   * 三道闸依次过:① planFix 认不认这条修复 ② 宿主有没有对应能力 ③ 原语自己的包含闸。
   * **一个原语都不许在闸外被调用**,也不论哪一道闸都不抛异常 —— 工具页要把原因显示出来。
   *
   * **关于 selected(B10a,spec §5.3 规则 3)**:高危动作(trash 批量、rewrite 改写)在确认框里
   * 逐条默认不选,UI 必须把用户勾选的那一份显式传进来 —— 省略第二参就是**整单执行**,
   * 那条路只为测试与 B1 起的旧调用保留,不是给界面留的口子(视图侧的对应注释在 ToolsView.runFix)。
   * 传了 selected 时先过 `subsetPlan` 裁子集,**再**走原有的两道短路:空选择会变成
   * `plan.empty` 带着原因被拒(useTools.ts 下面的「① 管线执行不了的两种情形」),
   * 于是「一条都没勾」既不会被静默吞掉,也不会绕过能力闸去碰原语。
   * @param selected 勾选集合(数组),或与今天同形的选项对象(不裁剪);缺省 = 整单
   * @param opts 选项;第二参给了对象时它就是本参数(B1 起的调用形状)
   * @param opts.isWin 平台口径;省略时问 bridge(取不到按非 Windows 的保守口径)
   */
  async function applyFix(
    f: Finding,
    selected?: string[] | { isWin?: boolean },
    opts?: { isWin?: boolean }
  ): Promise<FixOutcome> {
    const pid = projectId.value
    // 第二参是数组 = 勾选集合;是对象 = 今天的选项对象;都不是(undefined / null)= 整单。
    // 判别只看 Array.isArray,不靠真假:applyFix(f, null, { isWin: true }) 的第三参必须照常生效。
    const sel = Array.isArray(selected) ? selected : undefined
    const options = selected && !Array.isArray(selected) ? selected : opts
    const isWin = typeof options?.isWin === 'boolean' ? options.isWin : hostIsWindows()
    const fullPlan = planFix(f, tree.value, isWin)
    const plan = sel === undefined ? fullPlan : subsetPlan(fullPlan, sel)
    const base: FixOutcome = {
      findingId: f.id,
      toolId: f.id.includes(':') ? f.id.slice(0, f.id.indexOf(':')) : '',
      ok: false,
      error: '',
      service: plan.service,
      verb: plan.verb,
      rels: plan.rels,
      moved: 0,
      written: [],
      failed: [],
      backups: [],
      changed: false,
      invalidated: false,
      message: '',
      at: Date.now()
    }
    // 回执按项目成立(与 runTool 同一口径):await 期间用户切了项目,就不把上一个项目的
    // 修复结果写进现在这块面板(F-1 的延伸,不是新发明)。
    const done = (patch: Partial<FixOutcome>): FixOutcome => {
      const o: FixOutcome = { ...base, ...patch }
      if (projectId.value === pid) fixResults.value = { ...fixResults.value, [f.id]: o }
      return o
    }
    // ⓪ 重入闸(放在所有分支最前面):改写/删除通道是**逐个 await** 的循环,第二次 applyFix
    //    能从两次 await 之间插进来,于是两份清单同时改盘(后一份的 rel 可能已被前一份删掉)、
    //    fixing 被后一次的 finally 提前复位、两份回执互相覆盖。
    //    这里既不调原语也**不写回执** —— 压根没执行的东西记进账本就是假账。
    if (fixing.value !== '') {
      const why = '上一次修复还在执行中'
      return { ...base, error: why, message: why }
    }
    if (!pid) return done({ error: '还没有添加项目', message: '还没有添加项目' })
    // ① 管线执行不了的两种情形:service 为 null(既有能力/只报告/payload 认不出)、清单为空。
    //    两种都必须带着原因回来,不能静默什么都不做(spec §5.3 规则 3 的反面就是「点了没反应」)。
    if (plan.service === null || plan.empty) {
      const why = plan.reason || '这条结论不支持一键修复'
      return done({ error: why, message: why })
    }
    // ② 能力缺失是状态不是异常:在调用任何原语之前短路(spec §5.4)
    const need: Capability = plan.service === 'movePathsToTrash' ? 'trash' : 'write'
    if (!caps[need]) return done({ error: '当前宿主不支持', message: '当前宿主不支持' })

    fixing.value = f.id
    try {
      if (plan.service === 'movePathsToTrash') {
        // 只交 rel(相对路径):绝对路径拼接与越界/符号链接的包含闸都在原语里,渲染层一拼就绕过它
        const r = await window.services.movePathsToTrash(pid, plan.rels)
        const failed = r?.failed || []
        const moved = r?.moved || 0
        // moved 才是「盘上真的少了东西」的依据(原语按磁盘复核,inspectfs.js:292-293),
        // 单看 r.ok 会把「全失败」与「什么都没做」混成一种;单看 failed.length===0 又会被
        // ok:false + error 的整批失败(如 '项目不存在')骗过去。
        const changed = moved > 0
        let message: string
        if (failed.length) {
          message = changed
            ? `已${plan.verb} ${moved} 项,${failed.length} 项失败:${failedText(failed)}`
            : `${plan.verb}失败,${failed.length} 项:${failedText(failed)}`
        } else if (changed && r?.ok === true) {
          message = `已${plan.verb} ${moved} 项`
        } else {
          message = r?.error || `${plan.verb}失败(磁盘上没有变化)`
        }
        // 成败只认原语自己的回报:r.ok 为真、一个失败项都没有、且真的移走过东西,才算成功。
        // 「部分成功」在回执里是失败(ok:false)但 changed:true —— 盘上确实少了东西。
        const ok = r?.ok === true && failed.length === 0 && changed
        // ③ 改过磁盘才重扫:修完文件的下一次体检必须重新遍历,60s TTL 不许端着改过的旧清单。
        //    反过来,一项都没动的失败**不**触发重扫(白扫一遍 10 万文件的遍历)。
        const invalidated = changed && projectId.value === pid
        if (invalidated) invalidateTree()
        return done({
          ok, error: ok ? '' : message, moved, failed, changed, invalidated, message
        })
      }

      // 改写通道:逐文件调原语(格式化按文件给新内容),单个失败不中断其余,
      // 与回收站通道同一种「如实报数」的口径。备份由原语负责(<原名>.gpm-bak-<时间戳>)。
      const written: string[] = []
      const failed: { rel: string; error: string }[] = []
      const backups: string[] = []
      for (const file of plan.files) {
        try {
          const r = await window.services.writeProjectText(pid, file.rel, file.text)
          if (r?.ok) {
            written.push(file.rel)
            if (r.backupRel) backups.push(r.backupRel)
          } else {
            failed.push({ rel: file.rel, error: r?.error || '写入失败' })
          }
        } catch (e) {
          failed.push({ rel: file.rel, error: (e as Error)?.message || '写入失败' })
        }
      }
      const changed = written.length > 0
      let message = written.length ? `已改写 ${written.length} 个文件` : '改写失败'
      // 可撤销提示(spec §5.3 规则 4):备份去向要点名,多了只列前 3 个免得刷屏
      if (backups.length) {
        message += `,原文件已备份为 ${backups.slice(0, 3).join('、')}${backups.length > 3 ? ` 等 ${backups.length} 份` : ''}`
      }
      if (failed.length) message += `;${failed.length} 个失败:${failedText(failed)}`
      const ok = failed.length === 0 && written.length === plan.files.length && changed
      const invalidated = changed && projectId.value === pid
      if (invalidated) invalidateTree()
      return done({ ok, error: ok ? '' : message, written, failed, backups, changed, invalidated, message })
    } catch (e) {
      // 宿主实现抛异常(而不是回 ok:false)也只标失败:工具页要在结论里显示原因,不是崩掉面板
      const msg = (e as Error)?.message || '修复失败'
      return done({ error: msg, message: msg })
    } finally {
      fixing.value = ''
    }
  }

  function findingsOf(id: string): Finding[] {
    return results.value[id]?.findings || []
  }

  const counts = computed(() => {
    const c = { error: 0, warn: 0, info: 0, fixable: 0 }
    const isWin = hostIsWindows()
    for (const r of Object.values(results.value)) {
      for (const f of r.findings) {
        c[f.severity] += 1
        // 「可修复」的口径必须是 planFix 自己的判定,而不是 fix.kind !== 'none':
        // kind 为 existing 的结论是一次跳转、payload 认不出或缺新内容的结论执行不了,
        // 把它们数进去就等于 SummaryBar 报「可修复 5」而面板上只有 1 个按钮点得动。
        // tree 传空数组有两个理由:可执行性本来就与清单无关(fixPlan 的 Important 3 约束,
        // 否则这条计数会随清单新鲜度漂移),而 planFix 里那趟 O(tree) 的体积建表若为每条结论
        // 重做一遍,10 万文件的项目会把一个 computed 变成 findings × tree 的二次方。
        const plan = planFix(f, [], isWin)
        if (plan.service !== null && !plan.empty) c.fixable += 1
      }
    }
    return c
  })

  return {
    projects, projectId, tree, truncated, running, allRunning, progress, error, results, tools, caps,
    fixing, fixResults,
    load, select, runTool, runAll, registerTool, findingsOf, counts, applyFix,
    /** 修完文件/外部改过项目后调用:下一次跑强制重扫(世代号同时作废在途的那次扫描,F-1) */
    invalidateTree
  }
}
