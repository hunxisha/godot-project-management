// 工具页(项目体检)的类型层。设计见 docs/tools-page-plan.md §5.1 / §5.2。
import type { TreeEntry } from '../types/godot'
import type { RefIndex } from './refIndex'

export type Severity = 'error' | 'warn' | 'info'

/** 工具声明它需要什么宿主能力;缺失时卡片显示「当前宿主不支持」 */
export type Capability = 'tree' | 'text' | 'write' | 'trash' | 'hash'

/** 阅读分组(与执行顺序无关):聚合问题流按它分组 */
export type Category = 'refs' | 'config' | 'assets' | 'weight' | 'repo' | 'style'

export type FixKind = 'none' | 'trash' | 'rewrite' | 'existing'

export interface Finding {
  /** `${toolId}:${稳定键}` —— 稳定键只由证据推导(路径/序号),不含时间戳 */
  id: string
  severity: Severity
  /** 一句话结论 */
  title: string
  /** 证据与原因 */
  detail?: string
  /** 主证据文件(相对项目根) */
  rel?: string
  line?: number
  /** 其他相关文件 */
  related?: string[]
  fix?: { kind: FixKind; label: string; payload?: unknown; service?: string }
}

export interface ToolResult {
  toolId: string
  ok: boolean
  /** 整个工具失败的原因(不影响其他工具) */
  error?: string
  findings: Finding[]
  scannedFiles: number
  ms: number
}

/** 一次扫描、多个工具共享的上下文(spec §5.1) */
export interface ToolContext {
  projectId: string
  /** 项目根绝对路径,只用于展示;判定一律用 rel */
  root: string
  /** 含 `.godot/`(需要时由工具自己过滤);全量体检只取一次 */
  tree: TreeEntry[]
  /** 宿主在 maxEntries 处截断了 tree */
  truncated: boolean
  /** 读文本;LRU 由调用方(useTools)负责,这里只是通道 */
  readText(rel: string): Promise<{ text?: string; skipped?: boolean }>
  /**
   * 批量 SHA-256(#17 重复文件检测)。与 readText 同一待遇:通道由调用方接进宿主原语,
   * 检查器不碰 window / services;失败不抛,统一收进 failed。
   * 需要 'hash' 能力的工具,在 runTool 的 isSupported 那一步就已被旧宿主挡下。
   */
  hash(rels: string[]): Promise<{ hashes: { rel: string; sha256: string }[]; failed: { rel: string; error: string }[] }>
  /**
   * 引用索引的取用入口(B10a,spec §5.2):同一份索引只建一次,吃索引的工具共享它。
   *
   * **可选**,而且是刻意可选:缓存住在 useTools 的闭包里,只能通过 ctx 递进去 ——
   * 检查器 import 一个全局单例就把「一次扫描共享」变成了第二份没人管的状态(本轮红线)。
   * 宿主/测试没给这一项时,检查器自己 `buildRefIndex(ctx)`:两条路跑的是同一份判据,
   * 差别只在「这一代里是否已经有人建过」。
   */
  refIndex?(): Promise<RefIndex>
}

export interface Tool {
  id: string
  name: string
  /** 卡片上的一句话 */
  summary: string
  phase: 'P0' | 'P1' | 'P2'
  /** 聚合流的分组归属;数组顺序仍是执行顺序,两者刻意分开 */
  category: Category
  needs: Capability[]
  run(ctx: ToolContext): Promise<Finding[]>
}

/** 聚合流里的一条结论:结论本体 + 它的出处 + 能不能修 */
export interface AggFinding {
  finding: Finding
  toolId: string
  toolName: string
  category: Category
  fixable: boolean
}

/** 聚合流的一个类别组。counts 是该组的分档条数,筛选或裁剪后由产出方重算。 */
export interface AggGroup {
  category: Category
  label: string
  icon: string
  counts: { error: number; warn: number; info: number }
  items: AggFinding[]
}
