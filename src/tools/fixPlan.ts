// 修复动作的安全边界(spec §5.3 四条硬规则)—— 「这条结论能不能修、修的时候说什么话」
// 的全部判据收在这个纯函数里。FixConfirmDialog 只渲染它的返回值,useTools.applyFix 只照它给的
// rel 清单调原语;判据留在组件里就会说错话,而 Node harness 跑不到 .vue(与 outcomeOf 同一先例)。
//
// 为什么「动词按平台分叉」必须是判据而不是文案:
//   `movePathsToTrash` 在 Windows 走 PowerShell 的 SendToRecycleBin(**可还原**),
//   在 macOS/Linux 走 `fs.rmSync` / `fs.unlinkSync`(**真删,不可还原**),
//   见 src-ztools/preload/lib/fsutil.js:205-219 与 lib/inspectfs.js:274 的注释。
//   同一个 kind 在两个平台是两件不同的事,所以 UI 不许在它上面统一说「移入回收站」。
// 红线:纯函数。不碰 window、不碰 DOM,`isWin` 由调用方传(视图侧用 bridge.isWindows())。
import type { TreeEntry } from '../types/godot'
import type { Finding, FixKind } from './types'

/** 这次修复要走的宿主原语;null = 本管线执行不了(理由见 reason) */
export type FixService = 'movePathsToTrash' | 'writeProjectText' | null

/** 预览清单里的一行(dry-run 的账本,spec §5.3 规则 3) */
export interface FixPlanItem {
  /** 相对项目根、正斜杠 —— 对外只有 rel 这一个键,绝对路径由原语拼 */
  rel: string
  /** 清单里查得到的体积;**查不到时是 undefined 而不是 0** —— 臆造体积会让预览说「0 B」而原语随后报「文件不存在」 */
  size?: number
  /** 清单外/越界这类文件的说明,让「说不清」在预览里看得见而不是静默 */
  note?: string
}

export interface FixPlan {
  /** 「移入回收站」/「永久删除」/「改写文件」—— 按平台与 kind 定,确认框的按钮与回执共用它 */
  verb: string
  /** 一句风险说明(可撤销性、备份去向、不可还原) */
  warn: string
  /** 将受影响的完整文件清单(spec §5.3 规则 3:确认框必须列全) */
  items: FixPlanItem[]
  /** 清单为空:没有可执行的东西,调度层要拒 */
  empty: boolean
  /** null => 这条修复动作不归本管线执行(既有能力跳转、只报告、payload 认不出) */
  service: FixService
  /** 为什么不能执行(service 为 null 或 empty 时必有;绝不出现「点了没反应」) */
  reason: string
  /** 要交给 movePathsToTrash 的 rel 清单(与 items 同序同集合,已归一去重) */
  rels: string[]
  /** 要交给 writeProjectText 的内容(逐文件,原语自己负责 .gpm-bak- 备份) */
  files: { rel: string; text: string }[]
  /** items 里**已知**体积之和(清单外的不计入,不臆造) */
  bytes: number
  /** 这条结论的修复类型,便于 UI 与日志区分 */
  kind: FixKind | 'missing'
}

/** 与 resolveRel(inspectfs.js:37-50)同规则的归一:反斜杠→正斜杠、吃掉 `./` 与空段;越界返回空串 */
function normalizeRel(rel: string): string {
  const stack: string[] = []
  for (const p of String(rel).replace(/\\/g, '/').split('/')) {
    if (!p || p === '.') continue
    if (p === '..') return ''
    stack.push(p)
  }
  return stack.join('/')
}

/**
 * payload → 要删除的 rel 清单。认不出的形态回 null(而不是回空清单假装「没什么要删」)。
 * 接受的形态(P0b 各检查器按需选一种即可,不必反过来改本函数):
 *   · `string[]` / `{ rels: string[] }`                     —— uid / orphans / imports
 *   · `[{ rel }]` / `{ files: [{ rel }] }`                  —— 与 rewrite 通道同形时也能读
 *   · `{ rel }` / 省略 payload                              —— 单文件,退回 Finding.rel
 */
function trashRels(payload: unknown, fallback?: string): string[] | null {
  const fromList = (arr: unknown): string[] | null => {
    if (!Array.isArray(arr)) return null
    const out: string[] = []
    for (const x of arr) {
      if (typeof x === 'string') { if (x) out.push(x); continue }
      if (x && typeof x === 'object' && typeof (x as { rel?: unknown }).rel === 'string') {
        const r = (x as { rel: string }).rel
        if (r) out.push(r)
        continue
      }
      return null // 数组里混进认不出的元素:整份不认,别静默丢掉那一项
    }
    return out
  }
  if (payload == null) return fallback ? [fallback] : []
  if (Array.isArray(payload)) return fromList(payload)
  if (Array.isArray((payload as { rels?: unknown }).rels)) return fromList((payload as { rels: unknown[] }).rels)
  if (Array.isArray((payload as { files?: unknown }).files)) return fromList((payload as { files: unknown[] }).files)
  if (typeof (payload as { rel?: unknown }).rel === 'string') {
    const r = (payload as { rel: string }).rel
    return r ? [r] : []
  }
  if (typeof payload === 'string') return payload ? [payload] : []
  return null
}

/**
 * payload → 要写入的「rel + 新内容」清单。缺内容一律判「不可执行」:
 * 写空字符串等于把用户的 project.godot / .gd 覆成空文件,比不修更糟。
 * 接受 `{ rel, text }` / `[{ rel, text }]` / `{ files: [{ rel, text }] }`(格式化逐文件给)。
 */
function rewriteFiles(payload: unknown): { rel: string; text: string }[] | null {
  const one = (x: unknown): { rel: string; text: string } | null => {
    if (!x || typeof x !== 'object') return null
    const o = x as { rel?: unknown; text?: unknown }
    if (typeof o.rel !== 'string' || !o.rel || typeof o.text !== 'string') return null
    return { rel: o.rel, text: o.text }
  }
  const fromList = (arr: unknown[]): { rel: string; text: string }[] | null => {
    const out: { rel: string; text: string }[] = []
    for (const x of arr) {
      const o = one(x)
      // 一个元素认不出就整份拒:格式化跑到第 5 个文件才发现内容缺失,不如一开始就不动盘
      if (!o) return null
      out.push(o)
    }
    return out
  }
  if (Array.isArray(payload)) return fromList(payload)
  if (payload && typeof payload === 'object') {
    const p = payload as { files?: unknown; rel?: unknown; text?: unknown }
    if (Array.isArray(p.files)) return fromList(p.files)
    const single = one(p)
    if (single) return [single]
  }
  return null
}

/** items/rels/bytes 一起算:归一 + 去重(沿用首次那条 rel),体积只算清单里查得到的 */
function toItems(rels: string[], sizeOf: Map<string, number>): { items: FixPlanItem[]; keys: string[]; bytes: number } {
  const items: FixPlanItem[] = []
  const keys: string[] = []
  const seen = new Set<string>()
  let bytes = 0
  for (const raw of rels) {
    const norm = normalizeRel(raw)
    // 越界/空段:原样交给原语,由它回「非法路径」(inspectfs.js:326 的闸前失败态)。
    // 在这里悄悄丢掉就是「预览说 1 项、盘上删了 0 项」的口径分叉。
    const key = norm || String(raw)
    if (seen.has(key)) continue
    seen.add(key)
    const size = sizeOf.get(key)
    if (typeof size === 'number') bytes += size
    keys.push(key)
    const item: FixPlanItem = { rel: key }
    if (typeof size === 'number') item.size = size
    else item.note = norm ? '不在本次文件清单中,仍会交给原语并如实回报' : '路径越界,原语会拒绝'
    items.push(item)
  }
  return { items, keys, bytes }
}

/**
 * 一条结论该怎么修、修之前要向用户承诺什么。
 * @param f   检查器产出的结论(fix.kind / fix.payload 是唯一入口)
 * @param tree 当前文件清单:只用来查体积,不参与「能不能修」的判定(清单项可以不在树里)
 * @param isWin Windows 才有回收站;其余平台原语是真删,文案必须跟着变
 */
export function planFix(f: Finding, tree: TreeEntry[], isWin: boolean): FixPlan {
  const sizeOf = new Map<string, number>()
  for (const e of tree || []) {
    const norm = normalizeRel(e.rel)
    if (norm && !sizeOf.has(norm)) sizeOf.set(norm, e.size)
  }
  const kind: FixKind | 'missing' = f && f.fix ? f.fix.kind : 'missing'
  const label = (f && f.fix && f.fix.label) || ''

  if (kind === 'trash') {
    const rels = trashRels(f?.fix?.payload, f?.rel)
    if (rels === null) {
      return {
        verb: '移入回收站', warn: '', items: [], empty: true, service: null, kind,
        reason: '这条结论的修复数据认不出来,不能执行', rels: [], files: [], bytes: 0
      }
    }
    const r = toItems(rels, sizeOf)
    // 动词与风险句按平台分叉:这是 spec §5.3 规则 1 的**唯一破口**,必须如实说明而不是粉饰。
    const verb = isWin ? '移入回收站' : '永久删除'
    const warn = isWin
      ? '文件将移入系统回收站,之后可从回收站还原。'
      : '当前系统没有回收站,这些文件将被永久删除且无法还原。'
    return {
      verb,
      warn,
      items: r.items,
      empty: r.items.length === 0,
      service: 'movePathsToTrash',
      reason: r.items.length === 0 ? '没有要处理的文件' : '',
      rels: r.keys,
      files: [],
      bytes: r.bytes,
      kind
    }
  }

  if (kind === 'rewrite') {
    const files = rewriteFiles(f?.fix?.payload)
    if (files === null) {
      return {
        verb: '改写文件', warn: '', items: [], empty: true, service: null, kind,
        reason: '改写动作缺少要写入的新内容,拒绝执行(不写空文件覆掉原文件)', rels: [], files: [], bytes: 0
      }
    }
    const r = toItems(files.map((x) => x.rel), sizeOf)
    // 备份名以原扩展名**之后**收尾(player.gd.gpm-bak-<stamp>),这是原语刻意的设计,
    // 见 inspectfs.js:147-153 —— 文案照它说,别写成「<原名>.bak」那种根本不会出现的形态。
    return {
      verb: '改写文件',
      warn: '改写前会先把原文件复制成「原名.gpm-bak-时间戳」备份,再原子替换,可随时还原。',
      items: r.items,
      empty: r.items.length === 0,
      service: 'writeProjectText',
      reason: r.items.length === 0 ? '没有要改写的文件' : '',
      rels: [],
      files,
      bytes: r.bytes,
      kind
    }
  }

  // existing:复用既有能力(如清缓存)。按 spec §5.3 与「重叠功能只读 + 跳转」的取舍,
  // 它仍是一次跳转,不是在本页第二次执行同一件事 —— 所以 service 必须是 null。
  // none / 没有 fix:只报告。
  const verb = kind === 'existing' ? '跳转处理' : '仅报告'
  const reason = kind === 'existing'
    ? `「${label || '该操作'}」由既有能力完成,工具页只跳转,不在这里重复执行一次`
    : kind === 'none'
      ? '这条结论只提供报告,没有自动修复动作'
      : '这条结论没有提供修复动作'
  return { verb, warn: '', items: [], empty: true, service: null, reason, rels: [], files: [], bytes: 0, kind }
}
