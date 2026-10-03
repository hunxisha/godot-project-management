// 修复动作的安全边界(spec §5.3 四条硬规则)—— 「这条修复能不能执行、执行时说什么话」
// 的全部判据收在这个纯函数里。FixConfirmDialog 只渲染它的返回值,useTools.applyFix 只照它给的
// rel 清单调原语;判据留在组件里就会说错话,而 Node harness 跑不到 .vue(与 outcomeOf 同一先例)。
//
// 平台事实(逐处核实过,别凭印象写):
//   · ZTools/Electron 宿主**按 OS 分叉** —— src-ztools/preload/lib/fsutil.js:205-219 的
//     trashPath():process.platform==='win32' 走 PowerShell 的 SendToRecycleBin(可还原),
//     否则目录走 fs.rmSync(recursive)、文件走 fs.unlinkSync(**真删**)。
//   · Tauri 宿主**没有 OS 分叉** —— src-tauri/src/fsutil.rs:52-57 的 delete_to_trash() 在
//     所有平台都调 trash::delete。于是「非 Windows = 永久删除」在 Tauri 侧是保守而非事实。
//   · 结论:UI 的措辞按 OS 分叉(取两个宿主里更可怕的那一句说),**真正的可还原性由宿主决定**;
//     所以这里只保证「绝不把不可还原说成可还原」,不保证反向精确。
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
  /** 「移入回收站」/「永久删除」/「改写文件」—— 按平台与 kind 定,确认框的按钮与回执共用它;
   *  service 为 null(本管线执行不了)时**一定是空串**,不给永不执行的计划配动词 */
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
  /** 要交给 movePathsToTrash 的 rel 清单(与 items 同序同集合,同一趟去重) */
  rels: string[]
  /**
   * 要交给 writeProjectText 的内容。
   * rewrite 通道:与 items **同序同键同长度** —— 预览说几个就写几个,原语自己负责 .gpm-bak- 备份。
   * trash 通道:恒为空数组(items 照样有行),要动的东西在 rels 里。
   */
  files: { rel: string; text: string }[]
  /** items 里**已知**体积之和(清单外的不计入,不臆造) */
  bytes: number
  /** 这条结论的修复类型,便于 UI 与日志区分 */
  kind: FixKind | 'missing'
}

/** 与 resolveRel(inspectfs.js:37-50)逐条同规则的**忠实镜像**:四条拒绝一律回空串。
 *
 * 归一在这里少挡一条,越界串就会被「改写」成一个看起来合法的项目内路径,而那道闸收到的
 * 已经是改写后的串 —— 它照删/照写,预览却什么都没警告(实测 payload="/etc/passwd" 曾交出
 * rels=["etc/passwd"])。渲染层的职责是把原样那串送到闸前,不是替闸做判断。
 * 反斜杠→正斜杠、折叠 `./` 与空段是 resolveRel 自己也会做的(path.join(root, ...stack)),
 * 跟着归一才不会把同一个文件点成两条。
 */
function normalizeRel(rel: string): string {
  const norm = String(rel).replace(/\\/g, '/')
  if (norm.startsWith('/')) return ''
  if (/^[a-zA-Z]:/.test(norm)) return ''
  const stack: string[] = []
  for (const p of norm.split('/')) {
    if (!p || p === '.') continue
    if (p === '..') return ''
    stack.push(p)
  }
  if (!stack.length) return ''
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

/** toItems 的输入:一条 rel,rewrite 通道额外带上它的新内容 */
interface FixSource {
  rel: string
  text?: string
}

/** 导出给确认框:摘要行要按它把「会被拒绝」与「只是体积未知」分开计数 */
export const REJECT_NOTE = '路径越界或是绝对路径,原语会回「非法路径」拒绝'
const OUTSIDE_NOTE = '不在本次文件清单中,仍会交给原语并如实回报'
// 删除通道说「原语会如实回报」就够了(盘上没这个文件时它回「文件不存在」);
// 改写通道必须换一句:writeProjectText 对不存在的目标是**新建文件**,而新建不产生备份
// (inspectfs.js:185-188 的 ENOENT 分支 + :203 的 `if (exists && ...)`)——
// 继续说「原文件已备份」就是在给用户一条没有退路的承诺。
const NEWFILE_NOTE = '文件清单里没有它:改写会新建文件,没有备份可还原'

/**
 * items / rels / files / bytes **一起算**,一趟去重(审查 Important 2:分两趟算,预览就能说出
 * 「确认改写 1 个文件」而盘上落两次写)。items 与 keys 逐条对应同键;files 只收带 text 的那一类,
 * 所以 rewrite 通道下它与 items 同序同键同长度,trash 通道下它是空的 —— 三者不可能再分叉。
 *
 * 重复 rel 一律**首次优先**:rels 沿用首次那条原始串,两个宿主的 trash 也是按 abs 去重后
 * 沿用首次那条 rel(inspectfs.js:329、src-tauri/src/inspectfs.rs:411),text 跟同一个口径 ——
 * 若改成后者覆盖前者,预览与执行仍同源,但会和上面两处原语的报数口径不一致。
 *
 * @param wording 只有 rewrite 通道需要「清单外 = 会新建」这句措辞;它不改可执行性,只改文案。
 */
function toItems(
  sources: FixSource[],
  sizeOf: Map<string, number>,
  wording: 'trash' | 'rewrite'
): { items: FixPlanItem[]; keys: string[]; files: { rel: string; text: string }[]; bytes: number; createdNew: boolean; listed: number } {
  const items: FixPlanItem[] = []
  const keys: string[] = []
  const files: { rel: string; text: string }[] = []
  const seen = new Set<string>()
  let bytes = 0
  let createdNew = false
  let listed = 0
  for (const s of sources) {
    const raw = String(s.rel)
    const norm = normalizeRel(raw)
    // 归一失败(越界/绝对/盘符/空段)= 把**原样**那串交下去,由 resolveRel 回 '非法路径'。
    // 在这里改成「看起来合法」的项目内路径,就等于替用户绕过那道闸,而且预览看不出来。
    const key = norm || raw
    if (seen.has(key)) continue
    seen.add(key)
    const size = sizeOf.get(key)
    const item: FixPlanItem = { rel: key }
    if (!norm) item.note = REJECT_NOTE
    else if (typeof size === 'number') {
      item.size = size
      bytes += size
      listed += 1
    } else {
      item.note = wording === 'rewrite' ? NEWFILE_NOTE : OUTSIDE_NOTE
      if (wording === 'rewrite') createdNew = true
    }
    keys.push(key)
    // 带 text 的那一类(rewrite)与 items 逐条对应;trash 不带 text,files 留空。
    if (typeof s.text === 'string') files.push({ rel: key, text: s.text })
    items.push(item)
  }
  return { items, keys, files, bytes, createdNew, listed }
}

/**
 * 一条结论该怎么修、修之前要向用户承诺什么。
 * @param f   检查器产出的结论(fix.kind / fix.payload 是唯一入口)
 * @param tree 当前文件清单:只用来查体积与**措辞**(清单外的改写项要说「会新建、没备份」),
 *             不参与「能不能执行」的判定 —— 那种判定会让 counts.fixable 与确认框随清单新鲜度漂移
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
      // 执行不了的计划一律不给动词:确认框在这种分支只渲染 reason(FixConfirmDialog 的
      // !executable 支),applyFix 也在 service===null 处短路 —— 留着「移入回收站」只会
      // 在非 Windows 上挂一句谎话在一个永不执行的计划上。
      return {
        verb: '', warn: '', items: [], empty: true, service: null, kind,
        reason: '这条结论的修复数据认不出来,不能执行', rels: [], files: [], bytes: 0
      }
    }
    const r = toItems(rels.map((x) => ({ rel: x })), sizeOf, 'trash')
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
    const sources = rewriteFiles(f?.fix?.payload)
    if (sources === null) {
      return {
        verb: '', warn: '', items: [], empty: true, service: null, kind,
        reason: '改写动作缺少要写入的新内容,拒绝执行(不写空文件覆掉原文件)', rels: [], files: [], bytes: 0
      }
    }
    const r = toItems(sources, sizeOf, 'rewrite')
    // 备份名以原扩展名**之后**收尾(player.gd.gpm-bak-<stamp>),这是原语刻意的设计,
    // 见 inspectfs.js:147-153、204 —— 文案照它说,别写成「<原名>.bak」那种根本不会出现的形态。
    // 三档措辞:清单外目标走 ENOENT 分支当**新建**,新建不产生备份(:185-188 + :203),
    // 所以只要有一个清单外项就不能再统一承诺「可随时还原」;而一个清单内项都没有时,
    // 连「有的文件会先备份」这句都会指向根本不存在的备份,只能说新建那一半。
    const warn = !r.createdNew
      ? '改写前会先把原文件复制成「原名.gpm-bak-时间戳」备份,再原子替换,可随时还原。'
      : r.listed === 0
        ? '这些文件都不在本次文件清单里:改写会直接新建文件,新建没有备份可还原。'
        : '清单里有的文件会先复制成「原名.gpm-bak-时间戳」备份再原子替换;清单里没有的那些会被新建,新建没有备份可还原。'
    return {
      verb: '改写文件',
      warn,
      items: r.items,
      empty: r.items.length === 0,
      service: 'writeProjectText',
      reason: r.items.length === 0 ? '没有要改写的文件' : '',
      rels: [],
      files: r.files,
      bytes: r.bytes,
      kind
    }
  }

  // existing:复用既有能力(如清缓存)。按 spec §5.3 与「重叠功能只读 + 跳转」的取舍,
  // 它仍是一次跳转,不是在本页第二次执行同一件事 —— 所以 service 必须是 null。
  // none / 没有 fix:只报告。三种都执行不了,动词一律留空(见上面 trash 分支的理由)。
  const reason = kind === 'existing'
    ? `「${label || '该操作'}」由既有能力完成,工具页只跳转,不在这里重复执行一次`
    : kind === 'none'
      ? '这条结论只提供报告,没有自动修复动作'
      : '这条结论没有提供修复动作'
  return { verb: '', warn: '', items: [], empty: true, service: null, reason, rels: [], files: [], bytes: 0, kind }
}
