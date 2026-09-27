// 文档浏览的组合式函数:版本列表、各版本文档库状态、当前库的类列表、收藏/历史、搜索。
//
// 状态是模块级单例(与 useTheme 同模式):DocsView 与全局 Ctrl+K 搜索面板(DocSearchPalette)
// 共享同一份当前库选择,palette 命中后 DocsView 直接打开对应类。
//
// 当前库选择持久化在 godot/settings 的 docsVersionId(换机/重启后回到上次浏览的库);
// 收藏与历史由 preload 按类名全局存储(docs.js),跨版本生效。
import { computed, ref } from 'vue'
import { getSettings, saveSettings } from '../services/bridge'
import type { DocClassSummary, DocHistoryItem, DocLibraryStatus, DocSearchHit, GodotVersion } from '../types/godot'

/**
 * db 行的稳定标识:全插件约定 versionId = 完整 db 文档 id(godot/version/...),即 _id。
 * (版本数据里同时有 id 与 _id,两者通常相同,但 _id 是 listDocs 行的主键,与 VersionsView 一致。)
 */
type VersionRow = GodotVersion & { _id: string }

const versions = ref<VersionRow[]>([])
const statuses = ref<Record<string, DocLibraryStatus | null>>({})
const currentVersionId = ref('')
const classes = ref<DocClassSummary[]>([])
const favorites = ref<string[]>([])
const history = ref<DocHistoryItem[]>([])
let initialized = false

/** 已生成文档库的版本 */
const readyVersions = computed(() => versions.value.filter((v) => statuses.value[v._id]?.status === 'ready'))
const currentStatus = computed(() => statuses.value[currentVersionId.value] ?? null)

function refreshVersions() {
  versions.value = (window.ztools.db.allDocs('godot/version/') || []) as unknown as VersionRow[]
  const next: Record<string, DocLibraryStatus | null> = {}
  for (const v of versions.value) next[v._id] = window.services.docsLibraryStatus(v._id)
  statuses.value = next
}

function loadClasses() {
  classes.value = []
  if (!currentVersionId.value) return
  const r = window.services.docsListClasses(currentVersionId.value)
  if (r.ok && r.classes) classes.value = r.classes
}

function refreshFavorites() {
  favorites.value = window.services.docsListFavorites()
}

function refreshHistory() {
  history.value = window.services.docsListHistory()
}

/** 首次进入:恢复上次浏览的库(失效则落到第一个已生成库) */
function init() {
  if (initialized) {
    refreshVersions()
    refreshFavorites()
    refreshHistory()
    loadClasses()
    return
  }
  initialized = true
  refreshVersions()
  refreshFavorites()
  refreshHistory()
  const saved = getSettings().docsVersionId
  const savedReady = !!saved && statuses.value[saved]?.status === 'ready'
  currentVersionId.value = savedReady && saved ? saved : (readyVersions.value[0]?.id ?? '')
  // 回退/清空后把解析结果写回去,避免每次进入都重复回退
  if (currentVersionId.value !== saved) saveSettings({ docsVersionId: currentVersionId.value || undefined })
  loadClasses()
}

function selectVersion(id: string) {
  if (!statuses.value[id] || statuses.value[id]!.status !== 'ready') return
  currentVersionId.value = id
  saveSettings({ docsVersionId: id })
  loadClasses()
}

/** 发起生成;成功后状态转为 building(进度由 DocsView 订阅任务快照展示)。
 *  opts.forceTranslation=true 忽略 po 磁盘缓存重新下载官方翻译 */
function generate(versionId: string, opts?: { forceTranslation?: boolean }): { ok: boolean, error?: string } {
  const r = window.services.docsGenerate(versionId, opts)
  if (r.ok) {
    statuses.value = { ...statuses.value, [versionId]: { status: 'building', versionId, tag: versions.value.find((v) => v._id === versionId)?.tag ?? '' } }
  }
  return r
}

/** 从外部 extension_api.json 导入建库(无引擎可用时的兜底) */
function importLibrary(jsonPath: string): { ok: boolean, error?: string, versionId?: string } {
  return window.services.docsImport({ jsonPath })
}

function removeLibrary(versionId: string) {
  window.services.docsDeleteLibrary(versionId)
  refreshVersions()
  if (currentVersionId.value === versionId) {
    currentVersionId.value = readyVersions.value[0]?.id ?? ''
    saveSettings({ docsVersionId: currentVersionId.value || undefined })
    loadClasses()
  }
}

/** 任务完成/失败后调用:以 preload 实际状态为准刷新,并把当前库对齐到仍可用的库 */
function afterTaskSettled() {
  refreshVersions()
  refreshFavorites()
  refreshHistory()
  const cur = currentVersionId.value
  if (cur && statuses.value[cur]?.status === 'ready') {
    loadClasses()
    return
  }
  const next = readyVersions.value[0]?.id ?? ''
  currentVersionId.value = next
  saveSettings({ docsVersionId: next || undefined })
  loadClasses()
}

function toggleFavorite(className: string) {
  const fav = !favorites.value.includes(className)
  window.services.docsToggleFavorite(className, fav)
  favorites.value = window.services.docsListFavorites()
}

function pushHistory(className: string) {
  window.services.docsPushHistory(className)
  history.value = window.services.docsListHistory()
}

function search(query: string, limit = 30): DocSearchHit[] {
  if (!currentVersionId.value) return []
  return window.services.docsSearch(currentVersionId.value, query, limit)
}

/** 某类的直接派生(详情面板「派生」分节用) */
function derivedOf(className: string): DocClassSummary[] {
  return classes.value.filter((c) => c.inherits === className)
}

/** 继承树节点:懒加载(children 仅在展开时填充) */
export interface DocTreeNode {
  name: string
  /** 直接派生数(含未展开的部分) */
  childCount: number
  children: DocTreeNode[]
  /** 是否已展开过(区分「未加载」与「确实没有子节点」) */
  expanded: boolean
}

/** 建一个懒加载节点(childCount>0 时可展开) */
function treeNode(name: string): DocTreeNode {
  return { name, childCount: derivedOf(name).length, children: [], expanded: false }
}

/** 继承链:从当前类一路向上到根(详情面板面包屑用) */
function inheritsChainOf(className: string): DocClassSummary[] {
  const chain: DocClassSummary[] = []
  let cur = classes.value.find((c) => c.name === className)
  const guard = new Set<string>()
  while (cur && cur.inherits && !guard.has(cur.inherits)) {
    guard.add(cur.inherits)
    const parent = classes.value.find((c) => c.name === cur!.inherits)
    if (!parent) break
    chain.push(parent)
    cur = parent
  }
  return chain
}

export function useDocs() {
  return {
    versions,
    statuses,
    currentVersionId,
    currentStatus,
    readyVersions,
    classes,
    favorites,
    history,
    init,
    selectVersion,
    generate,
    importLibrary,
    removeLibrary,
    afterTaskSettled,
    toggleFavorite,
    pushHistory,
    search,
    derivedOf,
    inheritsChainOf,
    treeNode
  }
}
