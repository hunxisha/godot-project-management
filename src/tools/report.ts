// 体检报告生成(spec §3.3 #19,立项见 docs/tools-page-plan.md 第六部分)。
//
// 纯函数层:`Tool[] + Record<toolId, ToolResult> + meta` 进,字符串 / 普通对象出。
// 不碰 window / DOM / vue 响应式 —— 复制到剪贴板与存 db 留在 useTools(那里才有宿主)。
//
// 两条纪律由 report.test.mjs 钉住:
//   · **三态齐列**:跑过的、跑失败的、没跑的、宿主不支持的,一个都不能从报告里消失。
//     静默少一行是让报告失去可信度最快的方式(与 §5.2「不判的要说出口」同一条方向纪律);
//   · **不得出现凭据原文**:#18 的掩码红线延伸到这里。finding 对象本来就不含原文
//     (`secretPatterns` 只交掩码),但红线要有牙齿 —— 将来谁给 Finding 加个 `raw` 字段就该从这里漏出去。
import type { Capability, Finding, Severity, Tool, ToolResult } from './types'
import { LIST_CAP } from './finding'

export interface ReportMeta {
  projectId: string
  projectName: string
  root: string
  /** epoch ms;0 或非法值一律渲染成「未知时刻」而不是 1970 */
  generatedAt: number
  truncated: boolean
  fileCount: number
  caps: Partial<Record<Capability, boolean>>
}

export type ReportStatus = 'ran' | 'failed' | 'skipped' | 'unsupported'
export interface ReportTool {
  toolId: string
  name: string
  status: ReportStatus
  counts: Record<Severity, number>
  ms: number
  scannedFiles: number
  error?: string
  findings?: Finding[]
  hidden?: number
}
export interface ReportJson {
  kind: 'gpm-tools-report'
  version: 1
  meta: ReportMeta
  tools: ReportTool[]
  totals: Record<ReportStatus | 'findings', number>
}

const STATUS_CN: Record<ReportStatus, string> = {
  ran: '已运行', failed: '失败', skipped: '未运行', unsupported: '宿主不支持'
}
const ORDER: Severity[] = ['error', 'warn', 'info']

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}
function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/** 状态优先级:能力不全先于「没跑」 —— 不支持的工具本来就不该被跑,列成「未运行」会说假话 */
function statusOf(t: Tool, res: ToolResult | undefined, caps: ReportMeta['caps']): ReportStatus {
  const needs = Array.isArray(t.needs) ? t.needs : []
  if (!needs.every((c) => caps[c] === true)) return 'unsupported'
  if (!res) return 'skipped'
  return res.ok === true ? 'ran' : 'failed'
}

function emptyCounts(): Record<Severity, number> {
  return { error: 0, warn: 0, info: 0 }
}

function findingsOf(res: ToolResult | undefined): Finding[] {
  return res && Array.isArray(res.findings) ? res.findings.filter((f) => !!f) : []
}

function sortFindings(list: Finding[]): Finding[] {
  return [...list].sort((a, b) => ORDER.indexOf(a.severity) - ORDER.indexOf(b.severity))
}

function stampOf(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '未知时刻'
  try {
    return new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
  } catch (e) {
    return '未知时刻'
  }
}

/** 结构化形态:给 db 存档与将来的前后对比用,Markdown 只是它的一份渲染 */
export function buildToolReportJson(
  tools: Tool[] | null | undefined,
  results: Record<string, ToolResult> | null | undefined,
  meta: Partial<ReportMeta> | null | undefined
): ReportJson {
  const list = Array.isArray(tools) ? tools.filter((t) => !!t && typeof t.id === 'string') : []
  const m: ReportMeta = {
    projectId: str(meta?.projectId), projectName: str(meta?.projectName), root: str(meta?.root),
    generatedAt: num(meta?.generatedAt), truncated: meta?.truncated === true,
    fileCount: num(meta?.fileCount), caps: (meta?.caps || {}) as ReportMeta['caps']
  }
  const totals: Record<ReportStatus | 'findings', number> = { ran: 0, failed: 0, skipped: 0, unsupported: 0, findings: 0 }

  const rows: ReportTool[] = list.map((t) => {
    const res = results && typeof results === 'object' ? results[t.id] : undefined
    const status = statusOf(t, res, m.caps)
    const findings = findingsOf(res)
    const counts = emptyCounts()
    for (const f of findings) if (counts[f.severity] !== undefined) counts[f.severity]++
    totals[status]++
    totals.findings += counts.error + counts.warn + counts.info
    const row: ReportTool = {
      toolId: t.id, name: str(t.name) || t.id, status, counts,
      ms: num(res?.ms), scannedFiles: num(res?.scannedFiles)
    }
    if (status === 'failed') row.error = str(res?.error) || '未给出原因'
    if (status === 'ran') {
      const sorted = sortFindings(findings)
      row.findings = sorted.slice(0, LIST_CAP)
      row.hidden = Math.max(0, sorted.length - LIST_CAP)
    }
    return row
  })

  return { kind: 'gpm-tools-report', version: 1, meta: m, tools: rows, totals }
}

/** Markdown 形态:给人读、给复制出去贴给同事/AI 看的 */
export function buildToolReport(
  tools: Tool[] | null | undefined,
  results: Record<string, ToolResult> | null | undefined,
  meta: Partial<ReportMeta> | null | undefined
): string {
  const j = buildToolReportJson(tools, results, meta)
  const m = j.meta
  const out: string[] = []
  const capsLine = (['tree', 'text', 'write', 'trash', 'hash'] as Capability[])
    .map((c) => `${c} ${m.caps[c] === true ? '✓' : '✗'}`).join(' / ')

  out.push('# Godot 工坊 · 项目体检报告', '')
  out.push(`- 项目：${m.projectName || '（无名）'}（${m.projectId || '（无 id）'}）`)
  out.push(`- 根目录：${m.root || '（未知）'}`)
  out.push(`- 生成时间：${stampOf(m.generatedAt)}`)
  out.push(`- 文件清单：${m.fileCount} 个条目 · 清单截断：${m.truncated ? '是' : '否'}`)
  out.push(`- 宿主能力：${capsLine}`)
  out.push(`- 工具：${j.tools.length} 项 · 已运行 ${j.totals.ran} · 失败 ${j.totals.failed} · 未运行 ${j.totals.skipped} · 宿主不支持 ${j.totals.unsupported} · 结论 ${j.totals.findings} 条`)
  if (j.totals.ran === 0) {
    out.push('', '本轮没有跑过任何体检 —— 下面的状态列全是「未运行 / 不支持」，别把它读成「项目很干净」。')
  }

  out.push('', '| 工具 | 状态 | error | warn | info | 耗时 | 扫描文件 |', '| --- | --- | --- | --- | --- | --- | --- |')
  for (const t of j.tools) {
    out.push(`| ${t.name} | ${STATUS_CN[t.status]} | ${t.counts.error} | ${t.counts.warn} | ${t.counts.info} | ${t.ms} ms | ${t.scannedFiles} |`)
  }

  out.push('', '## 明细', '')
  for (const t of j.tools) {
    out.push(`### ${t.name}（${t.toolId}）· ${STATUS_CN[t.status]}`)
    if (t.status === 'failed') {
      out.push('', `- 失败原因：${t.error || '未给出原因'}`, '')
      continue
    }
    if (t.status !== 'ran') { out.push('', '（本轮无结论）', ''); continue }
    const list = t.findings || []
    if (!list.length) { out.push('', '- 本轮没有结论', ''); continue }
    for (const f of list) {
      const where = str(f.rel) ? ` — ${f.rel}${typeof f.line === 'number' && f.line > 0 ? ':' + f.line : ''}` : ''
      out.push('', `- [${f.severity}] ${str(f.title) || '（无标题）'}${where}`)
      const d = str(f.detail).replace(/\s+/g, ' ').trim()
      if (d) out.push(`  - ${d}`)
      if (Array.isArray(f.related) && f.related.length) {
        out.push(`  - 相关：${f.related.filter((r) => typeof r === 'string' && r).slice(0, LIST_CAP).join('、')}`)
      }
    }
    if (t.hidden && t.hidden > 0) out.push('', `（结论共 ${list.length + t.hidden} 条，这里按严重度只列前 ${list.length} 条，另有 ${t.hidden} 条省略。）`)
    out.push('')
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}
