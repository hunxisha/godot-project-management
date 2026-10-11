// 工具箱 · 首页状态与扫描装配(§3 P0-b 第 10 项 / Q13=B / Q25 / Q26 / DEV-4 / DEV-6)。
//
// 这一层的分工要说清楚,不然会被误读成「加载器在这里测过了」:
//   · 注册、校验、能力门、冲突、启停、搜索过滤、feature 计划 —— 全在 `toolkit/loader.ts` 与
//     `toolkit/features.ts` 里,是纯函数,Node 里有真断言钉着;
//   · **读盘与执行插件代码**在这里,而且只能真机验(Q33:用假加载器在 Node 里跑绿是明确禁止的形态)。
//     所以扫描管线收成一个可注入的 `ScanDeps`:测试注入假 deps 测的是**装配顺序与错误隔离**
//     (哪个条目变成哪个 state),真实执行路径由 A-10 在真宿主上验。两件事不许混着说。
//
// 状态挂在**模块级**而不是组件里:`App.vue:297-304` 记着 ToolsView 的 KeepAlive 实测无效
// (include 命中不了),组件一卸载列表就回到未扫描状态。模块级单例是那次实测之后的定案。

import { computed, ref } from 'vue'
import { getSettings, openPath, saveSettings } from '../services/bridge'
import { BUILTIN_TOOLS } from '../tools/builtin/registry'
import type { ToolCapability } from '../toolkit/manifest'
import { TOOL_CAPABILITIES } from '../toolkit/manifest'
import type { RegisteredTool, ToolKindFilter, ToolRegistry } from '../toolkit/loader'
import { allTags, buildRegistry, filterTools, registerTool, sortTools } from '../toolkit/loader'
import type { TakenCmd } from '../toolkit/features'
import { applyFeatures, ourFeatureCodes, planFeatures, staticTaken, toolIdOfCode, unapplyFeatures } from '../toolkit/features'

/** `services.toolsRoot()` 的回报形状(source 是宿主给的 'default' | 'settings',这里放宽成字符串) */
export interface RootInfo { ok: boolean, dir: string, source: string, error: string }

/** 扫描需要的四个外部动作。全部由真宿主提供,测试里注入假的一一对位 */
export interface ScanDeps {
  /** 解析工具目录(设置优先,缺省 ~/.gpm-tools)。宿主那一侧全是 async,这里两种都收 */
  toolsRoot(): PromiseLike<RootInfo> | RootInfo
  /** 列插件目录 + 交回每份 manifest 原文 */
  listPlugins(dir: string): PromiseLike<any> | any
  /** 读插件目录内的一个文件 */
  readFile(dir: string, pluginDir: string, rel: string): PromiseLike<any> | any
  /** 执行 entry 文本拿到模块对象(真实实现是 blob + 动态 import) */
  execute(text: string): Promise<unknown>
  /** 宿主 ztools 的 feature 三件套(注册与摘除) */
  ztools(): { setFeature?: (f: any) => unknown, removeFeature?: (c: string | string[]) => unknown, getFeatures?: (codes?: string[]) => unknown }
}

function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * 真实deps:磁盘走 `window.services`,执行走 blob 动态 import。
 *
 * ⚠ 这一档只有真宿主能验(A-10 / A-19):插件 JS 拿到的是浏览器上下文,
 * `new Function` / 动态 import 都挡不住它碰 `globalThis`,所以这不是沙箱 —— 措辞见 A-12 那段。
 */
export const REAL_DEPS: ScanDeps = {
  toolsRoot: () => window.services.toolsRoot(),
  listPlugins: (dir) => window.services.listToolPlugins(dir),
  readFile: (dir, pluginDir, rel) => window.services.readToolPlugin(dir, pluginDir, rel),
  async execute(text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }))
    try {
      // @vite-ignore:这个 URL 是运行时拼出来的,不能让构建期去解析
      return await import(/* @vite-ignore */ url)
    } finally {
      // 不回收的话每个插件每次扫描都留一份 blob 在内心里挂着
      URL.revokeObjectURL(url)
    }
  },
  ztools: () => window.ztools as any
}

// ── 模块级单例 ────────────────────────────────────────────────────────────
const tools = ref<RegisteredTool[]>([])
const scanState = ref<'idle' | 'scanning' | 'done' | 'error'>('idle')
/** 扫描层面的错(目录打不开);单个插件自己的错在各自条目的 reason 里 */
const scanError = ref('')
const dirInfo = ref({ dir: '', source: '', created: false })
const featureReports = ref<{ code: string, toolId: string, ok: boolean, error: string }[]>([])
const newDirs = ref<string[]>([])
const loadedOnce = ref(false)

/** Q13=B / Q25:缺省密集列表 */
const viewMode = ref<'list' | 'grid'>('list')
/** DEV-6:用户按过的开关(作者声明的 status 是另一层,两者不合并) */
const enabledMap = ref<Record<string, boolean>>({})
const toolsRootSetting = ref('')
const query = ref('')
const kindFilter = ref<ToolKindFilter>('all')
const tagFilter = ref('all')
/** 工具箱内的二级导航(整个应用没有 vue-router,路由就是这种 ref + 分支;见 App.vue:18) */
const activeToolId = ref('')

// ── 计算 ─────────────────────────────────────────────────────────────────
const registry = computed<ToolRegistry>(() => buildRegistry(tools.value))

/** 一个工具现在到底算不算启用(DEV-6 的两层在这里合成一个视图,不改写任何一层) */
function enabledOf(t: RegisteredTool): boolean {
  const id = t.manifest ? t.manifest.id : ''
  if (!id || t.state !== 'ok') return false
  if (Object.prototype.hasOwnProperty.call(enabledMap.value, id)) return enabledMap.value[id] === true
  return t.manifest!.status !== 'dev'
}

/** 排序后的全量列表(内置在前 + zh 序,loader 的判据) */
const sorted = computed<RegisteredTool[]>(() => sortTools(registry.value.tools))

const visible = computed<RegisteredTool[]>(() =>
  filterTools(sorted.value, {
    query: query.value,
    kind: kindFilter.value,
    tag: tagFilter.value,
    onlyEnabled: false
  })
)

const counts = computed(() => {
  let ok = 0
  let bad = 0
  let off = 0
  for (const t of sorted.value) {
    if (t.state !== 'ok') { bad++; continue }
    ok++
    if (!enabledOf(t)) off++
  }
  return { total: sorted.value.length, ok, bad, off }
})

/** 筛选 chip:标签 + 每个标签的条数(按次数降序,loader 的判据) */
const tags = computed(() => allTags(sorted.value))

const activeTool = computed<RegisteredTool | null>(() =>
  activeToolId.value ? (registry.value.byId[activeToolId.value] || null) : null
)

const hasBroken = computed(() => counts.value.bad > 0)

// ── 扫描 ─────────────────────────────────────────────────────────────────
function parseManifestText(text: unknown): { raw: unknown, preReject: string } {
  if (typeof text !== 'string' || !text.trim()) return { raw: null, preReject: '目录里没有 manifest.json(或它是空的)' }
  try {
    return { raw: JSON.parse(text), preReject: '' }
  } catch (e) {
    return { raw: null, preReject: `manifest.json 不是合法 JSON:${msgOf(e)}` }
  }
}

/**
 * 扫一遍工具目录。
 *
 * 三条纪律:
 *   · **内置先注册**,用户插件后注册 ⇒ id 撞车时 `byId` 保留先注册者(loader 的判据),
 *     用户的插件会被顶掉并标出冲突,而不是悄悄把内置覆盖掉;
 *   · 一个条目失败只标它自己:读盘错、JSON 错、manifest 错、能力缺、模块形状错,五种原因分开;
 *   · 目录打不开不等于「一个工具都没有」:内置照样能用,所以那一行的错误是环境错,不是空列表。
 */
async function rescan(deps: ScanDeps = REAL_DEPS): Promise<void> {
  scanState.value = 'scanning'
  scanError.value = ''
  const list: RegisteredTool[] = []
  // 框架这一版给得起的能力就是 manifest.ts 列的那六种:`granted` 是能力门的另一侧,
  // 不传等于「什么都不给得起」⇒ 每个插件都会被标成 no-capability(环境的错冒充作者的错)。
  const granted: readonly ToolCapability[] = TOOL_CAPABILITIES

  for (const b of BUILTIN_TOOLS) {
    list.push(registerTool(b.manifest, b.mod, { source: 'builtin', files: b.files, granted }))
  }

  const root = await deps.toolsRoot()
  if (!root || root.ok !== true) {
    scanError.value = root ? String(root.error || '工具目录不可用') : '工具目录原语没给回报'
  } else {
    dirInfo.value = { dir: String(root.dir || ''), source: String(root.source || ''), created: false }
    let r: any = null
    try {
      r = await deps.listPlugins(String(root.dir))
    } catch (e) {
      scanError.value = `扫描工具目录抛异常:${msgOf(e)}`
      r = null
    }
    if (r) {
      if (r.ok !== true) scanError.value = String(r.error || '工具目录不可用')
      dirInfo.value = { dir: String(r.dir || root.dir || ''), source: String(root.source || ''), created: r.created === true }
      const entries = Array.isArray(r.entries) ? r.entries : []
      for (const e of entries) {
        if (!e || typeof e !== 'object') continue
        const dirName = String(e.name || '')
        // 条目级错误(读不到 manifest、超字节上限…)⇒ 不猜内容,直接按原因标坏
        if (e.error) {
          list.push(registerTool(null, null, { source: 'user', dirName, preReject: String(e.error) }))
          continue
        }
        const parsed = parseManifestText(e.manifestText)
        const reg = registerTool(parsed.raw, null, {
          source: 'user',
          dirName,
          files: Array.isArray(e.files) ? e.files : [],
          granted,
          preReject: parsed.preReject
        })
        // 这一步只用来**先判 manifest**:mod 还没读、没执行,所以此刻的 bad-module 不代表最终结论。
        // 判据是「manifest 有没有拿到」—— 拿不到就是作者的 manifest 有问题,原因已由 manifest.ts 给好,
        // 直接交出去;拿到了才去读入口文件并执行,执行结果再决定 bad-module / no-capability / ok。
        if (reg.manifest) {
          const file = await deps.readFile(String(root.dir), dirName, reg.manifest.entry)
          if (!file || file.ok !== true) {
            list.push(registerTool(parsed.raw, null, {
              source: 'user',
              dirName,
              files: Array.isArray(e.files) ? e.files : [],
              preReject: `读不出入口文件 ${reg.manifest.entry}:${(file && file.error) || '原语没给原因'}`
            }))
            continue
          }
          if (file.truncated === true || file.skippedBinary === true) {
            list.push(registerTool(parsed.raw, null, {
              source: 'user',
              dirName,
              files: Array.isArray(e.files) ? e.files : [],
              preReject: `入口文件 ${reg.manifest.entry} 太大或被认成二进制,没执行它`
            }))
            continue
          }
          let mod: unknown = null
          try {
            mod = await deps.execute(String(file.text || ''))
          } catch (err) {
            list.push(registerTool(parsed.raw, null, {
              source: 'user',
              dirName,
              files: Array.isArray(e.files) ? e.files : [],
              preReject: `入口文件执行失败:${msgOf(err)}`
            }))
            continue
          }
          list.push(registerTool(parsed.raw, mod, { source: 'user', dirName, files: Array.isArray(e.files) ? e.files : [], granted }))
        } else {
          list.push(reg)
        }
      }
    }
  }

  tools.value = list
  scanState.value = scanError.value ? 'error' : 'done'

  // A-12「首次装插件时」:与上次见过的目录名比对,新的才提示
  const s = await getSettings()
  const seenList = Array.isArray(s.toolKnownDirs) ? (s.toolKnownDirs as string[]) : []
  const seen = new Set(seenList)
  newDirs.value = list
    .filter((t) => t.source === 'user' && t.dirName && !seen.has(t.dirName))
    .map((t) => t.dirName)
  await syncFeatures()
}

// ── feature 同步(Q14=A / Q22=A / R-6)───────────────────────────────────
/**
 * 让宿主的动态 feature 与当前注册表对齐:先摘掉不再要的,再注册新的。
 *
 * 摘的依据是 `getFeatures()` 回来的实际清单按 `tool-` 前缀筛(而不是信本地记忆):
 * 宿主可能已经被别处改动过,记忆与盘上不一致时以宿主说的为准。
 * 返回值按 `{success,error?}` 判,不信 d.ts 声明的 boolean(R-6,判据在 features.ts)。
 */
async function syncFeatures(deps: ScanDeps = REAL_DEPS): Promise<void> {
  const zt = deps.ztools() || {}
  const asTools = sorted.value
    .filter((t) => t.state === 'ok' && !!t.manifest)
    .map((t) => ({
      id: t.manifest!.id,
      name: t.manifest!.name,
      summary: t.manifest!.summary,
      cmds: t.manifest!.cmds,
      icon: t.manifest!.icon,
      enabled: enabledOf(t)
    }))
  const plan = planFeatures(asTools, staticTaken() as TakenCmd[])
  const want = new Set(plan.filter((p) => p.register).map((p) => p.code))

  let current: string[] = []
  try {
    current = ourFeatureCodes(typeof zt.getFeatures === 'function' ? await zt.getFeatures() : [])
  } catch {
    current = []
  }
  const stale = current.filter((c) => !want.has(c))
  if (stale.length) {
    const rm = await unapplyFeatures(stale, zt)
    if (!rm.ok) scanError.value = scanError.value ? scanError.value : `摘除旧关键词失败:${rm.error}`
  }
  const r = await applyFeatures(plan, zt)
  featureReports.value = r.applied
}

/** 某个工具的关键词被谁占了(列表那一行的黄标) */
function conflictOf(t: RegisteredTool): string {
  const id = t.manifest ? t.manifest.id : ''
  const rep = featureReports.value.find((f) => f.toolId === id && f.ok === false)
  if (rep && rep.error) return rep.error
  return t.idConflictWith.length ? t.idConflictWith.join('、') : ''
}

// ── 设置 ─────────────────────────────────────────────────────────────────
/** 读 settings(viewMode / 开关 / 目录配置)。在挂载时调一次 */
async function ensureLoaded(deps: ScanDeps = REAL_DEPS): Promise<void> {
  const s = await getSettings()
  viewMode.value = s.toolViewMode === 'grid' ? 'grid' : 'list'
  enabledMap.value = (s.toolEnabled && typeof s.toolEnabled === 'object' ? s.toolEnabled : {}) as Record<string, boolean>
  toolsRootSetting.value = typeof s.toolsRoot === 'string' ? s.toolsRoot : ''
  loadedOnce.value = true
  await rescan(deps)
}

/** Q25:视图选择存 settings */
async function setViewMode(m: 'list' | 'grid'): Promise<void> {
  viewMode.value = m === 'grid' ? 'grid' : 'list'
  await saveSettings({ toolViewMode: viewMode.value })
}

/** Q25 / DEV-6:禁用 = 灰显 + 不注册 feature;开关写进 settings,不回写 manifest.status */
async function setEnabled(t: RegisteredTool, on: boolean): Promise<void> {
  const id = t.manifest ? t.manifest.id : ''
  if (!id) return
  enabledMap.value = { ...enabledMap.value, [id]: on === true }
  await saveSettings({ toolEnabled: { ...enabledMap.value } })
  await syncFeatures()
}

function toggleEnabled(t: RegisteredTool): Promise<void> {
  return setEnabled(t, !enabledOf(t))
}

/** 「打开目录」 */
async function openToolsDir(): Promise<{ ok: boolean, error: string }> {
  const dir = dirInfo.value.dir
  if (!dir) return { ok: false, error: '还不知道工具目录在哪:先重新扫描一次' }
  try {
    await openPath(dir)
    return { ok: true, error: '' }
  } catch (e) {
    return { ok: false, error: msgOf(e) }
  }
}

/** 权限面提示被用户看过 ⇒ 记下这批目录名,下次不再算「新装的」 */
async function acknowledgeNewTools(): Promise<void> {
  const s = await getSettings()
  const prev = Array.isArray(s.toolKnownDirs) ? (s.toolKnownDirs as string[]) : []
  const set = new Set(prev)
  for (const d of newDirs.value) set.add(d)
  // 一次扫描见过的新目录全部并入(包括这次没列出来的坏条目:它们同样是「装过」)
  for (const t of tools.value) if (t.source === 'user' && t.dirName) set.add(t.dirName)
  await saveSettings({ toolKnownDirs: [...set] })
  newDirs.value = []
}

function openTool(id: string): void {
  activeToolId.value = typeof id === 'string' ? id : ''
}

function closeTool(): void {
  activeToolId.value = ''
}

/** ZTools 搜索框敲进 tool-<id> 时用它(App.vue 的 onPluginEnter 分支)。
 *  反解判据只有一份,在 features.ts(它同时拥有 CODE_PREFIX)⇒ 这里只转交,不自己再切一次字符串。 */
function toolIdFromCode(code: unknown): string {
  return toolIdOfCode(code)
}

/** 列表悬停要说的能力面(措辞来自 manifest.ts 的同一份表) */
export function capabilitiesOf(t: RegisteredTool): ToolCapability[] {
  return t.manifest ? t.manifest.capabilities : []
}

export function useToolkit() {
  return {
    // 状态
    tools,
    registry,
    sorted,
    visible,
    counts,
    tags,
    scanState,
    scanError,
    dirInfo,
    featureReports,
    newDirs,
    loadedOnce,
    viewMode,
    enabledMap,
    toolsRootSetting,
    query,
    kindFilter,
    tagFilter,
    activeToolId,
    activeTool,
    hasBroken,
    // 判据
    enabledOf,
    conflictOf,
    capabilitiesOf,
    // 动作
    ensureLoaded,
    rescan,
    syncFeatures,
    setViewMode,
    setEnabled,
    toggleEnabled,
    openToolsDir,
    acknowledgeNewTools,
    openTool,
    closeTool,
    toolIdFromCode
  }
}
