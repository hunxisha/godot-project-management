// 工具页的状态与调度:选项目 → 扫一次树 → 按注册表跑检查器 → 存结果。
// 关键不变量(spec §5.1):同一个项目的 tree 只扫一次,所有工具共享 ctx。
//
// 红线:这是渲染层组合式函数,只用 vue 的 ref/computed,不碰 DOM;能力一律走
// window.services 契约(两端 JS 宿主与 Tauri 宿主同一份签名)。
import { computed, ref } from 'vue'
import { listDocs } from '../services/bridge'
import type { GodotProject, ScanTreeResult, TreeEntry } from '../types/godot'
import type { Capability, Finding, Tool, ToolContext, ToolResult } from '../tools/types'
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

  /** 宿主能力探测:方法不存在(旧宿主/未移植)就是不支持,而不是静默假成功 */
  const caps: Record<Capability, boolean> = {
    tree: typeof window.services?.scanProjectTree === 'function',
    text: typeof window.services?.readProjectText === 'function',
    write: typeof window.services?.writeProjectText === 'function',
    trash: typeof window.services?.movePathsToTrash === 'function'
  }

  const textCache = new Map<string, { text?: string; skipped?: boolean }>()

  async function load() {
    const rows = ((await listDocs<GodotProject>('godot/project/')) || []) as WithId[]
    projects.value = rows
    if (!projectId.value && rows.length) {
      // 默认取最近打开的;没有记录退回列表首项(spec §5.8)
      const sorted = [...rows].sort((a, b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0))
      projectId.value = sorted[0]._id || ''
    }
  }

  function selected(): WithId | undefined {
    return projects.value.find((p) => p._id === projectId.value)
  }

  /**
   * 保证 ctx.tree 是本次可用的清单:命中 TTL 就复用,否则扫一次。
   * @param force 全量体检(runAll)与 invalidateTree 后强制重扫
   */
  async function ensureTree(force = false): Promise<boolean> {
    const pid = projectId.value
    if (!pid) { error.value = '还没有添加项目'; return false }
    // 共享树的核心:TTL 内、非强制、清单非空 → 一律复用,不再扫
    if (!force && tree.value.length && Date.now() - treeAt.value < TREE_TTL) return true
    if (!caps.tree) { error.value = '当前宿主不支持文件扫描'; return false }
    running.value = 'scan'
    progress.value = '正在扫描文件清单…'
    let r: ScanTreeResult
    try {
      // 必须显式要 includeCache:原语默认**跳过** .godot,不带上它 cache 检查器永远只会报
      // 「清单里没有 .godot 条目」。同时**不许**传 exts/skipDirs/maxEntries 缩小范围:
      // 原语只在条目上限处才打 truncated,被过滤的清单同样不完整却不再带标记,
      // brokenRefs 就会把其实存在的文件报成丢失(error 级假阳性,spec §5.1 / 审查 F-2)。
      r = await window.services.scanProjectTree(pid, { includeCache: true })
    } catch (e) {
      // 原语本身抛异常(宿主实现出错)也只标失败,不让它把页面卡在「正在扫描」
      error.value = scanErrorText((e as Error)?.message)
      tree.value = []
      treeAt.value = 0
      return false
    } finally {
      running.value = ''
      progress.value = ''
    }
    if (!r.ok) {
      error.value = scanErrorText(r.error)
      tree.value = []
      treeAt.value = 0
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
    return true
  }

  /** 所有工具共用的一份上下文:tree 来自缓存,readText 走 LRU(spec §5.1) */
  function ctx(): ToolContext {
    return {
      projectId: projectId.value,
      root: selected()?.path || '',
      tree: tree.value,
      truncated: truncated.value,
      readText: async (rel: string) => {
        const k = `${projectId.value}|${rel}`
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
          v = { skipped: true }
        } else {
          try {
            const r = await window.services.readProjectText(projectId.value, rel)
            v = r.ok && typeof r.text === 'string' ? { text: r.text } : { skipped: true }
          } catch (e) {
            // 与读文本原语的三态同形:给不出字符串就是「读不到」。单个文件读炸只跳过
            // 这一个文件,不把整个工具拖成 ok:false(否则一个坏文件能让全项目断链体检报废)
            v = { skipped: true }
          }
        }
        if (textCache.size >= TEXT_LRU) textCache.delete(textCache.keys().next().value as string)
        textCache.set(k, v)
        return v
      }
    }
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
    running.value = id
    const started = Date.now()
    let res: ToolResult
    try {
      res = { toolId: id, ok: true, findings: await t.run(ctx()), scannedFiles: tree.value.length, ms: Date.now() - started }
    } catch (e) {
      // 单工具失败只标它自己(spec §5.5)
      res = { toolId: id, ok: false, error: (e as Error)?.message || '检查失败', findings: [], scannedFiles: tree.value.length, ms: Date.now() - started }
    }
    running.value = ''
    results.value = { ...results.value, [id]: res }
    return res
  }

  /** 全量体检:强制重扫一次,再逐个跑;之间让出事件循环保证 UI 可交互 */
  async function runAll(): Promise<ToolResult[]> {
    allRunning.value = true
    await ensureTree(true)
    const list = [...tools.value]
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
    // 换项目 = 三份缓存全部作废:树、结果、文本 LRU 都是按项目成立的
    tree.value = []
    treeAt.value = 0
    truncated.value = false
    results.value = {}
    textCache.clear()
  }

  function registerTool(t: Tool) {
    if (!toolById(t.id) && !tools.value.some((x) => x.id === t.id)) tools.value = [...tools.value, t]
  }

  function findingsOf(id: string): Finding[] {
    return results.value[id]?.findings || []
  }

  const counts = computed(() => {
    const c = { error: 0, warn: 0, info: 0, fixable: 0 }
    for (const r of Object.values(results.value)) {
      for (const f of r.findings) {
        c[f.severity] += 1
        if (f.fix && f.fix.kind !== 'none') c.fixable += 1
      }
    }
    return c
  })

  return {
    projects, projectId, tree, truncated, running, allRunning, progress, error, results, tools, caps,
    load, select, runTool, runAll, registerTool, findingsOf, counts,
    /** 修完文件/外部改过项目后调用:下一次跑强制重扫 */
    invalidateTree: () => { treeAt.value = 0; textCache.clear() }
  }
}
