// GDScript 批量重命名 · 四种模式(§G Task 18 / §3 P1 第 16 项)。
//
// 一句话职责:给定「一个 rel + 它在选中列表里的位置」,算出**新 rel**,或者给出「为什么算不出」。
// 纯函数:不碰 IO、不碰表意文字之外的任何东西 —— 引用改写归 `refs.ts`,读盘与产出 Change 归 `index.ts`。
//
// 三条定死的形状判据:
//   1. **扩展名永远不动**。正则 / 前后缀 / 大小写三档都只作用在 `base`(basename 去掉最后一个点之前的部分),
//      `ext` 那一段原样拼回去(连原始大小写都保留:`Foo.GD` 改完还是 `.GD`)。
//      理由:改名改出别的扩展名 = Godot 不再认这个文件,而 `.gd` 变成 `.gd.txt` 这种错在预览里最难看出来。
//      `treeUtils.extOf` 给的是「小写、无点」的形态,这里**不能用它**(那会把 `.GD` 洗成 `.gd`)。
//   2. **命名模板必须含 `{ext}`**,缺了就整条报错而不是偷偷补上。
//      理由:框架替用户补扩展名 = 静默改主意(与 `schema.ts` 那条「报错而不是猜」同一条线);
//      而「模板里没有 {ext}」多半是手滑,报出来他能立刻看懂。
//   3. **坏名字拦在动手之前**。`/ \ : * ? " < > |`、以空格或点结尾、含 `..`、空串 ⇒ 不产条 + 说清原因。
//      这些字符在 rel 语义上合法(两道越界闸拦不住),但在 Windows 上会让 `renameSync` 抛 `'重命名失败'`
//      —— 而那时候**别的文件已经改完了**(§G DEV-23 的逐条执行),拦在前面比收拾半截状态有用。
//
// `{index}` 的顺序:等于 `files` 参数的顺序,而 `files` 由框架按**候选表顺序**给
// (§F 纯契约补充第 2 条:选中集只有一个真源、顺序不随点选变)。所以同一批勾注重跑,序号分布不变。

/** 四种模式(§5.7 那张单子的四个 radio) */
export type RenameMode = 'regex' | 'affix' | 'template' | 'case'

export const RENAME_MODES: readonly RenameMode[] = ['regex', 'affix', 'template', 'case']

/** 大小写四档:`lower`/`upper` 纯换大小写,`pascal`/`snake` 要按分隔符与驼峰切段 */
export type CaseMode = 'lower' | 'upper' | 'pascal' | 'snake'

export const CASE_MODES: readonly CaseMode[] = ['lower', 'upper', 'pascal', 'snake']

/** 模板只认这三个占位符(§3 #16 原话:`{name}{index}{ext}`) */
export const TEMPLATE_TOKENS: readonly string[] = ['name', 'index', 'ext']

export interface ModeParams {
  mode: RenameMode
  pattern: string
  replacement: string
  prefix: string
  suffix: string
  template: string
  start: number
  digits: number
  caseMode: CaseMode
}

/** 模式参数的默认值(与 `index.ts` 里 schema 的 `def` 必须同值 —— 表单显示的默认与实际执行的两套是经典坑) */
export const DEFAULT_PARAMS: ModeParams = {
  mode: 'regex',
  pattern: '',
  replacement: '',
  prefix: '',
  suffix: '',
  template: '{name}{index}{ext}',
  start: 1,
  digits: 2,
  caseMode: 'snake'
}

export interface SplitName {
  /** 目录段(带尾斜杠;项目根下的文件给空串) */
  dir: string
  /** basename 去掉最后一个点之前的部分(没有点就是整个 basename) */
  base: string
  /** 含点的扩展名尾巴(没有点就是空串);**原始大小写保留** */
  ext: string
}

/** 一个 rel 拆成 dir / base / ext(判据 1:扩展名永不动、也不转小写) */
export function splitName(rel: unknown): SplitName {
  const s = typeof rel === 'string' ? rel.replace(/\\/g, '/') : ''
  const slash = s.lastIndexOf('/')
  const dir = slash >= 0 ? s.slice(0, slash + 1) : ''
  const name = slash >= 0 ? s.slice(slash + 1) : s
  const dot = name.lastIndexOf('.')
  // 点在最前面(`.gitignore` 那种)算「没有扩展名」:整个名字都是 base,和 Godot 的处理一致
  if (dot <= 0) return { dir, base: name, ext: '' }
  return { dir, base: name.slice(0, dot), ext: name.slice(dot) }
}

/** 拼回去 */
export function joinName(dir: string, base: string, ext: string): string {
  return dir + base + ext
}

/**
 * 坏名字闸(四档共用)。返回空串 = 可以用。
 * 逐个点名是什么问题,别说成一句「名字非法」—— 用户要看的是自己模板里哪一段写错了。
 */
export function nameProblem(base: unknown): string {
  const s = typeof base === 'string' ? base : ''
  if (!s) return '新名是空的'
  if (s.includes('..')) return '名字里不能含 ..'
  const bad = '/\\:*?"<>|'.split('').filter((c) => s.includes(c))
  if (bad.length) return `名字里有平台用不了的字符:${bad.join(' ')}`
  if (/\s$/.test(s)) return '名字结尾不能是空白'
  if (s.endsWith('.')) return '名字结尾不能是点'
  return ''
}

/** 切段:pascal / snake 用。分隔符 = `_` `-` 空格 + 驼峰边界(小写或数字后面跟大写) */
export function splitWords(base: string): string[] {
  const spaced = String(base == null ? '' : base)
    .replace(/[_\-\s]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
  if (!spaced) return []
  return spaced.split(' ').filter((w) => !!w)
}

/** 换行大小写(§5.7 的「大小写转换」四档;判据来自 splitWords) */
export function applyCase(base: string, mode: CaseMode): string {
  const s = String(base == null ? '' : base)
  if (mode === 'lower') return s.toLowerCase()
  if (mode === 'upper') return s.toUpperCase()
  const words = splitWords(s)
  if (!words.length) return s
  if (mode === 'pascal') return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('')
  return words.map((w) => w.toLowerCase()).join('_')
}

/** 模板里的占位符都合法吗?返回第一个不认识的(空串 = 全认识) */
export function unknownToken(template: unknown): string {
  const t = String(template == null ? '' : template)
  const re = /\{([a-zA-Z_]*)\}/g
  for (;;) {
    const m = re.exec(t)
    if (!m) break
    if (!(TEMPLATE_TOKENS as readonly string[]).includes(m[1])) return m[1]
  }
  return ''
}

/** 序号:起始 + 位次 - 1,左补零到 digits 位 */
export function ordinalOf(start: number, digits: number, position: number): string {
  const s = Number.isFinite(start) ? Math.floor(start) : 1
  // 下限 1 与下面的 `txt.length >= d` 其实**等价**(d ≤ 0 时永远不会补零),所以这一半测不到 ——
  // 变异刀拿掉它 0 条红(登记在 §G-4)。留着它是为了让「位数」这个字段读起来就是 1..9 的事,
  // 真正有牙的是上限 9:它挡住 digits=99 那种把文件名撑成几百个零的输入。
  const d = Number.isFinite(digits) ? Math.max(1, Math.min(9, Math.floor(digits))) : 1
  const p = Number.isFinite(position) && position > 0 ? Math.floor(position) : 1
  const n = s + p - 1
  const txt = String(Math.abs(n))
  const pad = txt.length >= d ? txt : '0'.repeat(d - txt.length) + txt
  return n < 0 ? '-' + pad : pad
}

/** 一条模式跑一遍的结果。`error` 非空时 `to` 是空串 —— 调用方**不许**拿它去产 Change */
export interface NextName {
  to: string
  /** 正则档:这一条 base 上命中几处(0 表示名字没变)。其它档恒为 0 */
  hits: number
  error: string
  /** 名字算出来与原来一致(不是错误,但也不该产条) */
  noop: boolean
}

/** 从插件的 params(框架给的是已校验值,但仍是外来数据)里取模式参数,坏值退到默认并记原因 */
export function paramsFrom(raw: unknown): { p: ModeParams; skips: string[] } {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const skips: string[] = []
  const strOf = (k: string, d: string): string => (typeof o[k] === 'string' ? (o[k] as string) : d)
  const numOf = (k: string, d: number): number => {
    const v = o[k]
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (v === undefined || v === null || v === '') return d
    skips.push(`${k} 不是数字`)
    return d
  }
  const mode = strOf('mode', DEFAULT_PARAMS.mode)
  if (!(RENAME_MODES as readonly string[]).includes(mode)) skips.push(`mode「${mode}」框架不认识`)
  const caseMode = strOf('case_mode', DEFAULT_PARAMS.caseMode)
  if (!(CASE_MODES as readonly string[]).includes(caseMode)) skips.push(`case_mode「${caseMode}」框架不认识`)
  return {
    p: {
      mode: (RENAME_MODES as readonly string[]).includes(mode) ? (mode as RenameMode) : DEFAULT_PARAMS.mode,
      pattern: strOf('pattern', DEFAULT_PARAMS.pattern),
      replacement: strOf('replacement', DEFAULT_PARAMS.replacement),
      prefix: strOf('prefix', DEFAULT_PARAMS.prefix),
      suffix: strOf('suffix', DEFAULT_PARAMS.suffix),
      template: strOf('template', DEFAULT_PARAMS.template),
      start: numOf('start', DEFAULT_PARAMS.start),
      digits: numOf('digits', DEFAULT_PARAMS.digits),
      caseMode: (CASE_MODES as readonly string[]).includes(caseMode) ? (caseMode as CaseMode) : DEFAULT_PARAMS.caseMode
    },
    skips
  }
}

/**
 * 主入口:`rel` 是旧路径,`position` 是它在 `files` 里的 1-based 位置(`{index}` 用)。
 * 任何一步算不出可用名字都返回 `{to:'', error:'原因', hits:0, noop:false}` —— 调用方跳过那一条并把原因说出去。
 */
export function newNameFor(p: ModeParams, rel: unknown, position: number): NextName {
  const none = (error: string): NextName => ({ to: '', hits: 0, error, noop: false })
  const parts = splitName(rel)
  if (!parts.base && !parts.ext) return none('这个路径没有可改的文件名')
  let base = parts.base
  let hits = 0

  if (p.mode === 'regex') {
    if (!p.pattern) return none('正则是空的')
    let counted: number
    try {
      counted = hitsOf(p.pattern, base)
    } catch (e) {
      return none(`正则编译不过:${e instanceof Error ? e.message : String(e)}`)
    }
    hits = counted
    if (!hits) return { to: '', hits: 0, error: '', noop: true }
    try {
      base = base.replace(new RegExp(p.pattern, 'g'), p.replacement)
    } catch (e) {
      return none(`替换失败:${e instanceof Error ? e.message : String(e)}`)
    }
  } else if (p.mode === 'affix') {
    if (!p.prefix && !p.suffix) return none('前缀与后缀都是空的,那不改任何东西')
    base = p.prefix + base + p.suffix
  } else if (p.mode === 'template') {
    const badTok = unknownToken(p.template)
    if (badTok) return none(`模板里有框架不认的占位符 {${badTok}}(只认 {name} / {index} / {ext})`)
    if (!/\{ext\}/.test(p.template)) return none('模板里必须有 {ext},否则扩展名会被改掉 —— Godot 就不认这个文件了')
    // `{ext}` 本身就带那个点(`.gd`),所以模板里 `{ext}` 前面再写一个点会拼出 `a.1..gd`。
    // 与其让用户面对一句「名字结尾不能是点」的猜测,不如在模板这一层就点名(§G 补充第 5 条:报错而不是猜)。
    if (/\.\s*\{ext\}/.test(p.template)) return none('模板里 {ext} 前面不要再写点 —— 它自带扩展名分隔符(写 {name}{index}{ext} 就好)')
    const filled = String(p.template)
      .split('{name}').join(parts.base)
      .split('{index}').join(ordinalOf(p.start, p.digits, position))
      .split('{ext}').join(parts.ext)
    // 模板自己把扩展名写进去了(那是它唯一的合法写法),所以拆回来重新分界:
    // base 与 ext 的分界永远是「最后一个点」,后面 nameProblem 与拼接都按那一条走。
    const again = splitName(filled)
    base = again.base
    parts.ext = again.ext
  } else {
    // 纵深防御:`paramsFrom` 已经把不认识的 case_mode 退成默认并记一句,但这个函数是**对外导出的**,
    // 插件可以直接拿一份自己拼的 ModeParams 进来 —— 那时必须给得出原因,而不是悄悄按 snake 算。
    if (!(CASE_MODES as readonly string[]).includes(p.caseMode)) return none(`case_mode「${String(p.caseMode)}」框架不认识(只能是 ${CASE_MODES.join(' / ')} 之一)`)
    base = applyCase(parts.base, p.caseMode)
  }

  const problem = nameProblem(base)
  if (problem) return none(problem)
  const to = joinName(parts.dir, base, parts.ext)
  // 第二道闸看的是**整个文件名**(base + ext):模板可以写出 `{name}{ext}.` 这种尾巴落在扩展位之后的点,
  // 只看 base 会放过去,而 Windows 上结尾点是非法文件名 —— 拦在动手之前才是拦,抛在 renameSync 里已经晚了。
  const tail = nameProblem(base + parts.ext)
  if (tail) return none(tail)
  const oldFull = typeof rel === 'string' ? rel.replace(/\\/g, '/') : ''
  return { to, hits, error: '', noop: to === oldFull }
}

/** 数一遍命中(replace 之前先算,避免「替换后新名字里还有可匹配的东西」把计数虚增) */
function hitsOf(pattern: string, base: string): number {
  const re = new RegExp(pattern, 'g')
  let n = 0
  let m: RegExpExecArray | null
  let guard = 0
  for (;;) {
    m = re.exec(base)
    if (!m) break
    if (m[0].length === 0) re.lastIndex++
    n++
    if (++guard > 100000) break
  }
  return n
}

/**
 * 表单那句「匹配到 N 处」(§5.7):N = 所有选中文件的 base 上命中数之和。
 * 与产出同一套正则、同一条零宽纪律 —— 两处各数一遍迟早对不上(A-22 的 N 也是这个口径)。
 */
export function regexHitsOnNames(pattern: unknown, rels: unknown): { count: number; error: string } {
  if (typeof pattern !== 'string' || !pattern) return { count: 0, error: '正则是空的' }
  try {
    new RegExp(pattern, 'g')
  } catch (e) {
    return { count: 0, error: e instanceof Error ? e.message : String(e) }
  }
  const list = Array.isArray(rels) ? rels : []
  let count = 0
  for (const r of list) {
    const parts = splitName(r)
    if (!parts.base) continue
    try {
      count += hitsOf(pattern as string, parts.base)
    } catch (e) {
      return { count, error: e instanceof Error ? e.message : String(e) }
    }
  }
  return { count, error: '' }
}
