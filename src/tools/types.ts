// 工具页(项目体检)的类型层。设计见 docs/tools-page-plan.md §5.1 / §5.2。
import type { TreeEntry } from '../types/godot'

export type Severity = 'error' | 'warn' | 'info'

/** 工具声明它需要什么宿主能力;缺失时卡片显示「当前宿主不支持」 */
export type Capability = 'tree' | 'text' | 'write' | 'trash'

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
}

export interface Tool {
  id: string
  name: string
  /** 卡片上的一句话 */
  summary: string
  phase: 'P0' | 'P1' | 'P2'
  needs: Capability[]
  run(ctx: ToolContext): Promise<Finding[]>
}
