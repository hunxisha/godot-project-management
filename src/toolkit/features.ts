// 工具箱 · ZTools feature 的注册与关键词冲突(§4.3 / Q5=B / Q14=A / Q22=A / R-6)。
//
// 三条从宿主里查出来的事实决定了这一层长什么样(见记忆 reference-ztools-host-internals,
// 都是从 app.asar 直接 grep 得证的,不是推断):
//   1. **宿主完全不做 cmds 冲突检查**。`ipcMain.on("set-feature")` 只以 `code` 去重
//      (同 code 覆盖、新 code 追加),两个不同 code 声明同一个 `cmds` 会**都存下来**。
//      ⇒ Q22「后装让位」从推荐升级为唯一可行:去重只能我们自己做。
//   2. **`setFeature` 实际返回 `{ success, error? }`,而 `ztools.api.d.ts:489` 声明的是 `boolean`**。
//      ⇒ 按 boolean 判会**永远为真**(对象是 truthy)。所以判据只能走 `interpretSetFeature`,
//        并且要有断言钉住(R-6),否则这条会一直绿到某次真的注册失败才暴露。
//   3. **`getFeatures()` 只返回动态 feature,看不到 plugin.json 里那 5 个静态的**。
//      ⇒ 冲突判定必须自己把静态 cmds 算进来,而那份清单只能从 `src-ztools/plugin.json` 读 ——
//        往代码里复制一份字符串就是第二份真相,改了 json 忘了改这里就漏。
//
// 注册失败与冲突**都不该把工具藏起来**:工具照样在列表里、照样能从工具页打开,只是搜索框敲不出来。
// 所以本模块的返回结构是「注册计划 + 跳过原因」,不是「有罪就删」。
// 纯函数 + 一个只调注入进来的 setFeature/removeFeature 的异步收口(不碰 window)。

import pluginJson from '../../src-ztools/plugin.json'

/** 宿主 PluginFeature 的形(`ztools.api.d.ts:301`);第 1 批的 cmds 只用裸字符串形态 */
export interface GpmFeature {
  code: string
  explain: string
  cmds: string[]
  icon?: string
  platform?: string
  mainHide?: boolean
  mainPush?: boolean
}

/** 一个已被占用的关键词。owner 用 `static:` / `tool:` 前缀区分来源,提示语要能指名道姓 */
export interface TakenCmd {
  cmd: string
  owner: string
}

/** 工具 code 的统一前缀:与 plugin.json 那 5 个静态 code 隔开,避免「同 code 覆盖」抢走入口 */
export const CODE_PREFIX = 'tool-'

/** 一个工具的 feature code */
export function featureCode(toolId: string): string {
  const id = typeof toolId === 'string' ? toolId.trim() : ''
  return `${CODE_PREFIX}${id}`
}

/** 从 code 反解工具 id(卸载与对账时用) */
export function toolIdOfCode(code: unknown): string {
  if (typeof code !== 'string' || !code.startsWith(CODE_PREFIX)) return ''
  return code.slice(CODE_PREFIX.length)
}

/**
 * `plugin.json` 里的静态 feature(渲染层拿不到它们,只能读包内声明)。
 *
 * 任何一环缺失都退回空数组:宁可少检出一次冲突,也不许在启动路径上抛异常。
 * cmds 的宿主形状是 `(string | { type, label })[]`,这里只取 label / 裸串两种。
 */
export function staticFeatures(): { code: string, cmds: string[] }[] {
  const json = pluginJson as unknown as { features?: { code?: unknown, cmds?: unknown }[] }
  const list = Array.isArray(json?.features) ? json.features : []
  const out: { code: string, cmds: string[] }[] = []
  for (const f of list) {
    if (!f || typeof f !== 'object') continue
    // 字段名是 `code`(不是 featureName —— 实测 plugin.json:18 用的就是 code)。
    // 读错字段名不会报错,只会让 staticTaken() 永远返回空数组:那 5 个内置入口的关键词
    // 就再也没被算进冲突判定,而这正是本模块存在的理由之一。所以它得有一条断言钉住。
    const code = typeof f.code === 'string' ? f.code.trim() : ''
    if (!code) continue
    const raw = Array.isArray(f.cmds) ? f.cmds : []
    const cmds: string[] = []
    for (const c of raw) {
      if (typeof c === 'string' && c.trim()) cmds.push(c.trim())
      else if (c && typeof c === 'object' && typeof (c as { label?: unknown }).label === 'string') {
        const l = (c as { label: string }).label.trim()
        if (l) cmds.push(l)
      }
    }
    out.push({ code, cmds })
  }
  return out
}

/** 静态 feature 占掉的关键词(owner 带 `static:` 前缀) */
export function staticTaken(): TakenCmd[] {
  const out: TakenCmd[] = []
  for (const f of staticFeatures()) {
    for (const c of f.cmds) out.push({ cmd: c, owner: `static:${f.code}` })
  }
  return out
}

/**
 * code 是不是被静态 feature 占了。
 *
 * 这条比 cmds 冲突严重得多:宿主 `set-feature` **只以 code 去重**,同 code 覆盖就等于把
 * 「项目 / 版本 / 插件 / 添加项目」那 5 个入口的关键词直接抢走 —— 用户敲「项目」会进到工具页。
 */
export function codeIsStatic(code: unknown): boolean {
  if (typeof code !== 'string' || !code.trim()) return false
  const c = code.trim()
  return staticFeatures().some((f) => f.code === c)
}

/**
 * 候选 cmds 踩到了哪些已占用的词。
 * 返回按 `taken` 原序、同 (cmd,owner) 去重;一个词被两个人踩到就都列出来(提示要说全)。
 */
export function cmdConflicts(cmds: readonly unknown[], taken: readonly TakenCmd[]): { cmd: string, owner: string }[] {
  const list = Array.isArray(cmds) ? cmds : []
  const want = new Set<string>()
  for (const c of list) if (typeof c === 'string' && c.trim()) want.add(c.trim())
  const out: { cmd: string, owner: string }[] = []
  const seen = new Set<string>()
  for (const t of Array.isArray(taken) ? taken : []) {
    if (!t || typeof t.cmd !== 'string' || typeof t.owner !== 'string') continue
    if (!want.has(t.cmd)) continue
    const k = `${t.cmd}\u0000${t.owner}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push({ cmd: t.cmd, owner: t.owner })
  }
  return out
}

/** 「关键词 X 已被 Y 占用」那一行的话术(措辞唯一来源) */
export function conflictText(list: readonly { cmd: string, owner: string }[]): string {
  const hit = Array.isArray(list) ? list : []
  if (!hit.length) return ''
  const head = hit[0]
  // owner 的内部前缀(`static:` / `tool:`)只用于分辨来源,不许出现在给用户的那句话里
  const raw = head.owner
  const owner = raw.startsWith('static:') ? `内置入口 ${raw.slice(7)}` : raw.startsWith('tool:') ? `工具 ${raw.slice(5)}` : `已有条目 ${raw}`
  const rest = hit.length > 1 ? `等 ${hit.length} 个关键词` : ''
  return `关键词「${head.cmd}」已被 ${owner} 占用${rest}:本工具不注册到搜索框,仍可从工具箱打开`
}

/** 计划里的一项 */
export interface FeaturePlanItem {
  toolId: string
  code: string
  feature: GpmFeature
  /** true ⇒ 这一项要注册 */
  register: boolean
  /** register:false 时的原因(冲突 / 被禁用 / 形状不对) */
  why: string
  /** 冲突到的具体关键词(给列表标黄用) */
  conflicts: { cmd: string, owner: string }[]
}

export interface ToolForFeature {
  id: string
  name: string
  summary: string
  cmds: readonly string[]
  icon?: string
  /** 用户在设置里的开关(Q14=A:每项一个开关;禁用 = 不注册) */
  enabled: boolean
}

/**
 * 算出「这一轮该注册哪些 feature」。
 *
 * 三处拒注册,各有独立原因:
 *   · 禁用 ⇒ 不注册(Q25:禁用=灰显+不注册 feature);
 *   · cmds 空 ⇒ 不注册(注册了也搜不到,还会被宿主校验拒);
 *   · 关键词已被占 ⇒ 后装让位(Q22=A)。**不 removeFeature 抢回来**:抢 = 用户的另一个工具当场失灵,
 *     而让位只是少一个入口,损失小一个量级。
 * @param taken 已被占用的 cmds(静态那 5 个 + 已注册的其他工具),由调用方汇总
 */
export function planFeatures(tools: readonly ToolForFeature[], taken: readonly TakenCmd[]): FeaturePlanItem[] {
  const out: FeaturePlanItem[] = []
  const mine = new Set<string>()
  for (const t of Array.isArray(tools) ? tools : []) {
    if (!t || typeof t.id !== 'string' || !t.id) continue
    const code = featureCode(t.id)
    // 回调参数写死 string:`Array.isArray` 的守卫签名会把 `readonly string[]` 收窄成 `any[]`,
    // 不标注就是隐式 any(TS7006 会红 typecheck 门,而这道门是三门之一)
    const cmds = (Array.isArray(t.cmds) ? (t.cmds as readonly string[]) : []).map((c: string) => (typeof c === 'string' ? c.trim() : '')).filter(Boolean)
    const base: FeaturePlanItem = {
      toolId: t.id,
      code,
      feature: { code, explain: typeof t.summary === 'string' ? t.summary : '', cmds, icon: typeof t.icon === 'string' && t.icon ? t.icon : 'wrench' },
      register: false,
      why: '',
      conflicts: []
    }
    if (codeIsStatic(code)) {
      base.why = `code「${code}」与内置入口撞了:同 code 在宿主里是覆盖,会把那个入口的关键词抢走`
      out.push(base)
      continue
    }
    if (t.enabled !== true) {
      base.why = '已禁用'
      out.push(base)
      continue
    }
    if (!cmds.length) {
      base.why = '没有关键词:注册了也搜不到'
      out.push(base)
      continue
    }
    const conflicts = cmdConflicts(cmds, [...(Array.isArray(taken) ? taken : []), ...[...mine].map((c) => ({ cmd: c, owner: '本批前一个工具' }))])
    if (conflicts.length) {
      base.conflicts = conflicts
      base.why = conflictText(conflicts)
      out.push(base)
      continue
    }
    for (const c of cmds) mine.add(c)
    base.register = true
    out.push(base)
  }
  return out
}

/**
 * `setFeature` 的返回值判据。
 *
 * 类型声明说它是 `boolean`,实测回的是 `{success:boolean, error?}`(preload 原样透传 LMDB 的结果)。
 * 判 `if (res)` 会**永远为真** —— 这就是 R-6 要钉的那件事,所以下面每条分支都得有断言。
 * 认的形态只有四种:true / {success:true} / {ok:true} / {success:false|ok:false|error},
 * 其余(含 undefined、字符串、数字)一律**按失败处理**,方向是不许谎报注册成功。
 */
export function interpretSetFeature(res: unknown): { ok: boolean, error: string } {
  if (res === true) return { ok: true, error: '' }
  if (res && typeof res === 'object') {
    const o = res as { success?: unknown, ok?: unknown, error?: unknown, message?: unknown }
    const err = typeof o.error === 'string' && o.error.trim() ? o.error.trim()
      : typeof o.message === 'string' && o.message.trim() ? o.message.trim() : ''
    if (o.success === true || o.ok === true) return { ok: true, error: '' }
    if (o.success === false || o.ok === false) return { ok: false, error: err || '宿主拒绝注册(未给原因)' }
    if (err) return { ok: false, error: err }
    return { ok: false, error: '宿主回执里没有 success 字段,不能当成注册成功' }
  }
  if (res === undefined || res === null) return { ok: false, error: '宿主没有回执(setFeature 未实现或被拦)' }
  return { ok: false, error: `宿主回执形态不认识:${typeof res}` }
}

/** 注入面:渲染层的 window.ztools 子集(不 import window,所以能进 Node harness) */
export interface ZtoolsLike {
  setFeature?: (f: GpmFeature) => unknown
  removeFeature?: (code: string | string[]) => unknown
  getFeatures?: (codes?: string[]) => unknown
}

export interface AppliedFeature {
  code: string
  toolId: string
  ok: boolean
  error: string
}

/**
 * 把注册计划打到宿主上(只调注入进来的函数)。
 *
 * 一项失败不影响其余(与三段式同一口径);被 planFeatures 判为不注册的项**根本不打过去**,
 * 返回值里仍以 ok:false + 原因列出,UI 那一行才知道为什么搜索框敲不出来。
 */
export async function applyFeatures(
  plan: readonly FeaturePlanItem[],
  zt: ZtoolsLike
): Promise<{ applied: AppliedFeature[], taken: TakenCmd[] }> {
  const applied: AppliedFeature[] = []
  const taken: TakenCmd[] = []
  const setFn = typeof zt?.setFeature === 'function' ? zt.setFeature : null
  for (const item of Array.isArray(plan) ? plan : []) {
    if (!item || typeof item.code !== 'string') continue
    if (!item.register) {
      applied.push({ code: item.code, toolId: item.toolId, ok: false, error: item.why || '按冲突判定不注册' })
      continue
    }
    if (!setFn) {
      applied.push({ code: item.code, toolId: item.toolId, ok: false, error: '宿主没有 setFeature,注册不了' })
      continue
    }
    let res: unknown = null
    try {
      res = await (setFn as (f: GpmFeature) => unknown)(item.feature)
    } catch (e) {
      applied.push({ code: item.code, toolId: item.toolId, ok: false, error: `setFeature 抛异常:${e instanceof Error ? e.message : String(e)}` })
      continue
    }
    const r = interpretSetFeature(res)
    applied.push({ code: item.code, toolId: item.toolId, ok: r.ok, error: r.error })
    if (r.ok) for (const c of item.feature.cmds) taken.push({ cmd: c, owner: `tool:${item.toolId}` })
  }
  return { applied, taken }
}

/** 卸载:禁用或卸载插件时要把 code 摘掉(宿主 removeFeature 收 code 或 code[]) */
export async function unapplyFeatures(codes: readonly string[], zt: ZtoolsLike): Promise<{ ok: boolean, error: string }> {
  const list = (Array.isArray(codes) ? codes : []).filter((c) => typeof c === 'string' && c)
  if (!list.length) return { ok: true, error: '' }
  const fn = typeof zt?.removeFeature === 'function' ? zt.removeFeature : null
  if (!fn) return { ok: false, error: '宿主没有 removeFeature,摘不掉' }
  try {
    const r = interpretSetFeature(await (fn as (c: string[]) => unknown)(list))
    return { ok: r.ok, error: r.error }
  } catch (e) {
    return { ok: false, error: `removeFeature 抛异常:${e instanceof Error ? e.message : String(e)}` }
  }
}

/** 从宿主要回来的动态 feature 列表里,挑出我们这一层注册的(按 code 前缀认) */
export function ourFeatureCodes(list: unknown): string[] {
  const arr = Array.isArray(list) ? list : []
  const out: string[] = []
  for (const f of arr) {
    const code = f && typeof f === 'object' ? (f as { code?: unknown }).code : undefined
    const id = toolIdOfCode(code)
    if (id && !out.includes(code as string)) out.push(code as string)
  }
  return out
}
