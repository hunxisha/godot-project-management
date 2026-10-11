// 工具箱 · manifest 的规范与校验(纯函数)。
//
// 这里是**插件作者与框架之间的合同正文**。定死之后不能再改语义:`apiVersion` 不匹配一律硬拒载、
// 不做兼容适配层(§2.7 Q30),所以「加一个字段」便宜、「改一个字段的含义」等于让所有已存在的
// 第三方插件当场失效(§6 R-2)。可选字段一律留默认值,不给就按最保守的那一侧走。
//
// 分工红线:
//   · 本模块只管**形态**(字段在不在、取值合不合法、路径越不越界)。插件声明的能力框架给不给得起,
//     是加载期才知道的事,判据走下面的 `missingCapabilities`(由 Task 7 的 loader 传能力集进来)。
//   · 拒载原因的**措辞只在本模块生成**(`rejectionText`),列表那一行不许再自己组织语言 ——
//     旧 `gate.ts:12-14`「门不许另写措辞」的同一条纪律。
//   · 纯函数。不碰 window / services / fs / vue。entry 是否存在由调用方把目录清单传进来(`opts.files`),
//     本模块不自己去问磁盘 —— 那会让 Node 里的断言变成只能真机验的东西(§2.7 Q33 的反面)。
//
// 未知字段**忽略**:将来新加的字段不该让现在的校验器报错;而真正不兼容的那一类由 apiVersion 挡住。

/** 框架契约版本。插件的 `apiVersion` 必须**恰好**等于它(§5.1:整数、不匹配硬拒载、不做适配层)。 */
export const GPM_API_VERSION = 1

export type ToolKind = 'action' | 'view'
export type ToolUi = 'schema' | 'render'
export type ToolStatus = 'dev' | 'stable'
export type ToolCapability = 'tree' | 'text' | 'ref' | 'write' | 'store' | 'ui'

export const TOOL_KINDS: readonly ToolKind[] = ['action', 'view']
export const TOOL_UIS: readonly ToolUi[] = ['schema', 'render']
export const TOOL_STATUSES: readonly ToolStatus[] = ['dev', 'stable']
export const TOOL_CAPABILITIES: readonly ToolCapability[] = ['tree', 'text', 'ref', 'write', 'store', 'ui']

/** 能力的人话名字:列表里「缺少 X 能力」那一行要用,措辞也只在这里出现一次 */
export const CAPABILITY_LABELS: Record<ToolCapability, string> = {
  tree: '项目文件树',
  text: '读文本与哈希',
  ref: '引用图',
  write: '经框架写盘(三段式)',
  store: '插件自己的配置存储',
  ui: '宿主 UI(通知/对话框/剪贴板/打开路径)'
}

/**
 * `id` 的字符集:`^[a-z0-9][a-z0-9._-]{0,63}$`。
 * 首字符强制字母或数字,所以 `..` 这种目录名形态根本进不来(它同时是 store 前缀、feature code
 * 与账本归属的键,三者都要能原样拼进 LMDB 的 key 与文件系统目录名)。
 */
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/

/** 校验通过后的 manifest:所有字段都存在,可选项已补默认值,字符串已 trim */
export interface ToolManifest {
  id: string
  name: string
  /** 插件自己的版本,框架只拿来显示,不解析、不比较 */
  version: string
  apiVersion: number
  kind: ToolKind
  ui: ToolUi
  summary: string
  /** 内置图标 key 或插件目录内图片的相对路径;空串 = 用默认的 wrench */
  icon: string
  cmds: string[]
  entry: string
  capabilities: ToolCapability[]
  unsafe: boolean
  author: string
  homepage: string
  description: string
  tags: string[]
  status: ToolStatus
}

export interface ManifestIssue {
  field: string
  /** 中文、可读、指名道姓:这一串会直接显示在工具列表那一行 */
  message: string
}

export type ManifestResult = { ok: true; manifest: ToolManifest } | { ok: false; issues: ManifestIssue[] }

export interface ValidateOptions {
  /** 插件目录里的相对路径清单(正斜杠)。给了就检查 entry 真在里面;不给则只查形态 */
  files?: string[]
}

/** 值是什么类型(拒载原因要用,不能把 undefined 显示成「缺失」以外的怪话) */
function typeName(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return '数组'
  switch (typeof v) {
    case 'undefined': return '缺失'
    case 'string': return '字符串'
    case 'number': return '数字'
    case 'boolean': return '布尔'
    case 'object': return '对象'
    default: return typeof v
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * 「必须落在某个目录之内」的字面闸:反斜杠归正斜杠、吃掉 `.` 段与空段,
 * 而 `..` / 绝对路径 / 盘符 一律判 false。
 *
 * 与生产闸 `resolveRel`(`src-ztools/preload/lib/inspectfs.js:40-53`)同形 —— 那边拼的是项目根,
 * 这里拼的是插件目录根,但**四条拒载规则必须一致**,否则 manifest 放过的路径会在 preload 那边再撞一次,
 * 而那时用户看到的是一句没有字段名的「非法路径」。
 * 真实落点(符号链接)不在本模块的判断力之内:纯函数看不到磁盘,那道闸在 Task 5 的 `resolveInside`。
 */
export function isInsidePath(v: unknown): boolean {
  if (typeof v !== 'string') return false
  const norm = v.replace(/\\/g, '/')
  if (!norm) return false
  if (norm.startsWith('/')) return false
  if (/^[a-zA-Z]:/.test(norm)) return false
  const stack: string[] = []
  for (const p of norm.split('/')) {
    if (!p || p === '.') continue
    if (p === '..') return false
    stack.push(p)
  }
  return stack.length > 0
}

/** 归一清单元素:反斜杠归正斜杠,好与 entry 的写法无关地比对 */
function slash(v: string): string {
  return v.replace(/\\/g, '/')
}

/**
 * 校验一份 manifest。
 *
 * 一次性把所有字段问题收集完(除了 apiVersion —— 它不对就没有后面可言),这样列表那一行能说全,
 * 而不是让用户改一轮错一轮。
 */
export function validateManifest(raw: unknown, opts?: ValidateOptions): ManifestResult {
  const issues: ManifestIssue[] = []
  const bad = (field: string, message: string): void => { issues.push({ field, message }) }

  if (!isPlainObject(raw)) {
    return { ok: false, issues: [{ field: '-', message: `manifest 必须是一个 JSON 对象,现在拿到的是${typeName(raw)}` }] }
  }

  // ---- apiVersion:硬拒载,先于一切字段检查 ----
  const api = raw.apiVersion
  if (typeof api !== 'number' || !Number.isInteger(api)) {
    return { ok: false, issues: [{ field: 'apiVersion', message: `apiVersion 必须是整数(框架契约版本),现在拿到的是${typeName(api)}` }] }
  }
  if (api !== GPM_API_VERSION) {
    return {
      ok: false,
      issues: [{
        field: 'apiVersion',
        message: `插件要求 apiVersion ${api},本框架是 ${GPM_API_VERSION};不匹配一律拒载,不做兼容适配层`
      }]
    }
  }

  const req = (field: string): string | null => {
    const v = raw[field]
    if (typeof v !== 'string' || !v.trim()) {
      bad(field, `${field} 必须是非空字符串,现在拿到的是${typeName(v)}`)
      return null
    }
    return v.trim()
  }
  const optStr = (field: string): string => {
    const v = raw[field]
    if (v === undefined) return ''
    if (typeof v !== 'string' || !v.trim()) {
      bad(field, `${field} 给了就必须是非空字符串,现在拿到的是${typeName(v)}`)
      return ''
    }
    return v.trim()
  }
  const oneOf = <T extends string>(field: string, list: readonly T[], label: string): T | null => {
    const v = req(field)
    if (v === null) return null
    if (!list.includes(v as T)) {
      bad(field, `${field} 只能是 ${label} 之一,现在是「${v}」`)
      return null
    }
    return v as T
  }

  // ---- id ----
  const id = req('id')
  if (id !== null && !ID_RE.test(id)) {
    bad('id', `id「${id}」不合法:只能用小写字母、数字、点、下划线和短横线,首字符必须是字母或数字,总长不超过 64(它要用作目录名、存储前缀与 feature code)`)
  }

  const name = req('name')
  const version = req('version')
  const summary = req('summary')

  // ---- kind / ui(§5.2:view 型必须 render;action 型两种都许)----
  const kind = oneOf('kind', TOOL_KINDS, "'action' | 'view'")
  const ui = oneOf('ui', TOOL_UIS, "'schema' | 'render'")
  if (kind === 'view' && ui === 'schema') {
    bad('ui', "kind 为 'view' 的工具必须由插件自己渲染,所以 ui 不能是 'schema'")
  }

  // ---- entry:必须在插件目录之内;给了目录清单就查它真在不在 ----
  const entry = req('entry')
  if (entry !== null && !isInsidePath(entry)) {
    bad('entry', `entry「${entry}」必须是插件目录内的相对路径,不许用绝对路径、盘符或 ..`)
  } else if (entry !== null && Array.isArray(opts?.files)) {
    const want = slash(entry)
    if (!opts!.files!.map(slash).includes(want)) {
      bad('entry', `entry 指向的文件在插件目录里不存在:${entry}`)
    }
  }

  // ---- icon:给了就要合法;形态像路径时同样过目录闸 ----
  const icon = optStr('icon')
  if (icon && looksLikePath(icon) && !isInsidePath(icon)) {
    bad('icon', `icon「${icon}」若是图片路径,必须是插件目录内的相对路径,不许用绝对路径、盘符或 ..`)
  }

  // ---- cmds:非空数组,每项非空字符串(Q14 全部工具都要注册成 feature)----
  const cmdsRaw = raw.cmds
  let cmds: string[] = []
  if (!Array.isArray(cmdsRaw)) {
    bad('cmds', `cmds 必须是数组(它要注册成 ZTools feature 的关键词),现在拿到的是${typeName(cmdsRaw)}`)
  } else if (cmdsRaw.length === 0) {
    bad('cmds', 'cmds 不能是空数组:一个没有任何关键词的工具在 ZTools 搜索框里永远打不开')
  } else {
    const seen = new Set<string>()
    for (let i = 0; i < cmdsRaw.length; i++) {
      const c = cmdsRaw[i]
      if (typeof c !== 'string' || !c.trim()) {
        bad('cmds', `cmds 第 ${i + 1} 项必须是非空字符串,现在拿到的是${typeName(c)}`)
        continue
      }
      const t = c.trim()
      if (!seen.has(t)) { seen.add(t); cmds.push(t) }
    }
  }

  // ---- capabilities:数组、每项属于枚举、不许重复 ----
  const capsRaw = raw.capabilities
  let capabilities: ToolCapability[] = []
  if (!Array.isArray(capsRaw)) {
    bad('capabilities', `capabilities 必须是数组(声明这个工具要框架给哪些能力),现在拿到的是${typeName(capsRaw)}`)
  } else {
    const seen = new Set<string>()
    for (let i = 0; i < capsRaw.length; i++) {
      const c = capsRaw[i]
      if (typeof c !== 'string' || !c.trim()) {
        bad('capabilities', `capabilities 第 ${i + 1} 项必须是字符串,现在拿到的是${typeName(c)}`)
        continue
      }
      const t = c.trim()
      if (!(TOOL_CAPABILITIES as readonly string[]).includes(t)) {
        bad('capabilities', `capabilities 里有框架不认的能力「${t}」;框架 ${GPM_API_VERSION} 只给 ${TOOL_CAPABILITIES.join(' / ')}`)
      } else if (seen.has(t)) {
        bad('capabilities', `capabilities 里的「${t}」重复了`)
      } else {
        seen.add(t)
        capabilities.push(t as ToolCapability)
      }
    }
  }

  // ---- unsafe:true 只允许 view 型(§5.2:action 型的写盘只能经框架三段式,拿不到裸写接口)----
  const unsafeRaw = raw.unsafe
  let unsafe = false
  if (unsafeRaw !== undefined) {
    if (typeof unsafeRaw !== 'boolean') {
      bad('unsafe', `unsafe 必须是布尔,现在拿到的是${typeName(unsafeRaw)}`)
    } else {
      unsafe = unsafeRaw
      if (unsafe && kind === 'action') {
        bad('unsafe', "unsafe:true 只允许给 kind:'view' 的工具:'action' 型的写盘一律走框架三段式,框架不会把裸写接口交给它")
      }
    }
  }

  // ---- 三个新补的可选字段(§D #4,用户 2026-10-11 拍板)----
  const description = optStr('description')
  const tagsRaw = raw.tags
  let tags: string[] = []
  if (tagsRaw !== undefined) {
    if (!Array.isArray(tagsRaw)) {
      bad('tags', `tags 必须是字符串数组(首页的筛选 chip 按它分组),现在拿到的是${typeName(tagsRaw)}`)
    } else {
      for (let i = 0; i < tagsRaw.length; i++) {
        const t = tagsRaw[i]
        if (typeof t !== 'string' || !t.trim()) {
          bad('tags', `tags 第 ${i + 1} 项必须是非空字符串,现在拿到的是${typeName(t)}`)
          continue
        }
        tags.push(t.trim())
      }
    }
  }
  let status: ToolStatus = 'stable'
  const statusRaw = raw.status
  if (statusRaw !== undefined) {
    if (typeof statusRaw !== 'string' || !(TOOL_STATUSES as readonly string[]).includes(statusRaw)) {
      bad('status', `status 只能是 ${TOOL_STATUSES.join(' / ')}(作者声明自己没写完就写 'dev'),现在是${typeName(statusRaw)}`)
    } else {
      status = statusRaw as ToolStatus
    }
  }

  // ---- author / homepage:homepage 只认 http(s),渲染层会把它当外链打开 ----
  const author = optStr('author')
  const homepage = optStr('homepage')
  if (homepage && !/^https?:\/\//i.test(homepage)) {
    bad('homepage', `homepage 必须以 http:// 或 https:// 开头,现在是「${homepage}」(它会被当成外链打开,不接受 javascript: 之类的形态)`)
  }

  if (issues.length) return { ok: false, issues }

  return {
    ok: true,
    manifest: {
      id: id as string,
      name: name as string,
      version: version as string,
      apiVersion: api,
      kind: kind as ToolKind,
      ui: ui as ToolUi,
      summary: summary as string,
      icon,
      cmds,
      entry: entry as string,
      capabilities,
      unsafe,
      author,
      homepage,
      description,
      tags,
      status
    }
  }
}

/** 只有斜杠/反斜杠/盘符/扩展名能把它和「内置图标 key」区分开:内置 key 是裸词(`pen` `wrench`) */
function looksLikePath(v: string): boolean {
  return /[/\\]/.test(v) || /^[a-zA-Z]:/.test(v) || /\.[a-z0-9]{1,5}$/i.test(v)
}

/**
 * 插件声明的能力里,框架当前给不起的那几个(顺序按声明原样,已去重)。
 * 判据在加载期用:非空 ⇒ 该工具灰显并说明原因,**不报错**(§5.1)。
 * 两个入参都不挑刺:非数组当空集,元素 String 化后比对,反正上游已经过 validateManifest。
 */
export function missingCapabilities(declared: unknown, granted: unknown): ToolCapability[] {
  const want = Array.isArray(declared) ? declared : []
  const has = new Set(Array.isArray(granted) ? granted.map((g) => String(g)) : [])
  const out: ToolCapability[] = []
  for (const c of want) {
    const t = String(c)
    if (has.has(t)) continue
    if (!(TOOL_CAPABILITIES as readonly string[]).includes(t)) continue
    if (!out.includes(t as ToolCapability)) out.push(t as ToolCapability)
  }
  return out
}

/** 缺能力那一行的话术(措辞只在这一处):`缺少框架能力:项目文件树、引用图` */
export function missingCapabilityText(missing: readonly ToolCapability[]): string {
  return `缺少框架能力:${missing.map((c) => CAPABILITY_LABELS[c]).join('、')}`
}

/**
 * 把拒载问题汇成列表那一行的一句话。
 * 只说第一条 + 剩余条数:全部塞进一行会把那一行撑爆,而第一条永远是最该改的那个
 * (apiVersion 不对时校验已经提前返回,不会带着别的字段错误一起来)。
 */
export function rejectionText(issues: readonly ManifestIssue[]): string {
  if (!issues.length) return 'manifest 校验未通过,但没有给出原因(框架 bug)'
  const head = issues[0].message
  return issues.length === 1 ? head : `${head}(另有 ${issues.length - 1} 处问题)`
}
