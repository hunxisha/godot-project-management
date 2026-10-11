/**
 * bridge: 渲染层访问 ZTools API(db、对话框、通知、shell 等)的统一入口。
 * Node 能力(fs/网络/进程)由 src-ztools/preload 注入的 window.services 提供,按里程碑扩展。
 */
import { DEFAULT_SETTINGS, type GodotSettings } from '../types/godot'

type AnyDoc = { _id: string, _rev?: string, [key: string]: any }

/** 读取单个文档,返回 _id + 数据字段(异步:Tauri 的 db 是 IPC,阶段 A 起两端统一) */
export async function getDoc<T>(id: string): Promise<(T & { _id: string }) | null> {
  return (window.ztools.db.get(id) as AnyDoc | null) as any
}

/** 创建/更新文档 */
export async function putDoc<T extends object>(id: string, data: T): Promise<boolean> {
  const old = window.ztools.db.get(id) as AnyDoc | null
  const result = window.ztools.db.put({ _id: id, _rev: old?._rev, ...data })
  return !result.error
}

/** 删除文档 */
export async function removeDoc(id: string): Promise<boolean> {
  const old = window.ztools.db.get(id) as AnyDoc | null
  if (!old) return true
  return !window.ztools.db.remove(old).error
}

/** 按前缀列出文档 */
export async function listDocs<T>(prefix: string): Promise<(T & { _id: string })[]> {
  return (window.ztools.db.allDocs(prefix) || []) as any[]
}

// ---------- 设置 ----------

export async function getSettings(): Promise<GodotSettings> {
  const doc = await getDoc<GodotSettings>('godot/settings')
  if (!doc) return { ...DEFAULT_SETTINGS }
  const { _id, _rev, ...data } = doc as AnyDoc
  return { ...DEFAULT_SETTINGS, ...data }
}

export async function saveSettings(patch: Partial<GodotSettings>): Promise<GodotSettings> {
  const next = { ...(await getSettings()), ...patch }
  await putDoc('godot/settings', next)
  return next
}

// ---------- 环境与系统能力 ----------

export const isDark = () => window.ztools.isDarkColors()
export const isWindows = () => window.ztools.isWindows()
export const isMacOS = () => window.ztools.isMacOS()
export const isLinux = () => window.ztools.isLinux()

export const notify = (body: string) => window.ztools.showNotification(body)
export const hideMainWindow = () => window.ztools.hideMainWindow()

/** 选择目录,返回绝对路径;取消返回 undefined */
export async function pickDirectory(title: string, defaultPath?: string): Promise<string | undefined> {
  const result = window.ztools.showOpenDialog({
    title,
    defaultPath,
    properties: ['openDirectory', 'createDirectory']
  })
  return result?.[0]
}

/** 选择单个文件,返回绝对路径;取消返回 undefined */
export async function pickFile(title: string, extensions: string[], defaultPath?: string): Promise<string | undefined> {
  const result = window.ztools.showOpenDialog({
    title,
    defaultPath,
    properties: ['openFile'],
    filters: [{ name: extensions.join('/'), extensions }]
  })
  return result?.[0]
}

/** 后缀去点、去空:宿主 filters 要的是 `gd`,不是 `.gd` */
function filterExts(list: unknown): string[] {
  return (Array.isArray(list) ? list : []).map((e) => String(e).replace(/^\./, '')).filter(Boolean)
}

/**
 * 选多个文件或目录(工具箱 `ctx.openDialog` 用):取消返回空数组。
 * 与 pickFile 的差别只有 multiSelections —— 插件一次挑若干个是常态,一次只许挑一个会把它逼回去写循环。
 */
export async function pickPaths(opts: { title?: string, extensions?: string[], defaultPath?: string, directory?: boolean } = {}): Promise<string[]> {
  const exts = filterExts(opts.extensions)
  const result = window.ztools.showOpenDialog({
    title: opts.title || (opts.directory ? '选择目录' : '选择文件'),
    defaultPath: opts.defaultPath,
    ...(exts.length ? { filters: [{ name: exts.join('/'), extensions: exts }] } : {}),
    properties: [opts.directory ? 'openDirectory' : 'openFile', 'multiSelections']
  })
  return Array.isArray(result) ? result : []
}

/** 选一个保存路径(工具箱 `ctx.saveDialog` 用):取消返回空串 */
export async function pickSavePath(opts: { title?: string, defaultPath?: string, extensions?: string[] } = {}): Promise<string> {
  const exts = filterExts(opts.extensions)
  const picked = window.ztools.showSaveDialog({
    title: opts.title || '另存为',
    defaultPath: opts.defaultPath,
    ...(exts.length ? { filters: [{ name: exts.join('/'), extensions: exts }] } : {})
  })
  return typeof picked === 'string' ? picked : ''
}

export const openPath = (p: string) => window.ztools.shellOpenPath(p)
export const showInFolder = (p: string) => window.ztools.shellShowItemInFolder(p)
export const openExternal = (url: string) => window.ztools.shellOpenExternal(url)

// ---------- 剪贴板 ----------

/** execCommand 兜底:clipboard API 在部分宿主 webview 里不可用 */
function fallbackCopy(text: string): boolean {
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  } catch (e) {
    return false
  }
}

/** 复制文本到剪贴板;优先 clipboard API,失败走 execCommand 兜底 */
export function copyText(text: string): boolean {
  try {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).catch(() => fallbackCopy(text))
      return true
    }
  } catch (e) {
    // 走兜底
  }
  return fallbackCopy(text)
}
