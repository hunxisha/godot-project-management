/**
 * bridge: 渲染层访问 ZTools API(db、对话框、通知、shell 等)的统一入口。
 * Node 能力(fs/网络/进程)由 src-ztools/preload 注入的 window.services 提供,按里程碑扩展。
 */
import { DEFAULT_SETTINGS, type GodotSettings } from '../types/godot'

type AnyDoc = { _id: string, _rev?: string, [key: string]: any }

/** 读取单个文档,返回 _id + 数据字段 */
export function getDoc<T>(id: string): (T & { _id: string }) | null {
  return (window.ztools.db.get(id) as AnyDoc | null) as any
}

/** 创建/更新文档 */
export function putDoc<T extends object>(id: string, data: T): boolean {
  const old = window.ztools.db.get(id) as AnyDoc | null
  const result = window.ztools.db.put({ _id: id, _rev: old?._rev, ...data })
  return !result.error
}

/** 删除文档 */
export function removeDoc(id: string): boolean {
  const old = window.ztools.db.get(id) as AnyDoc | null
  if (!old) return true
  return !window.ztools.db.remove(old).error
}

/** 按前缀列出文档 */
export function listDocs<T>(prefix: string): (T & { _id: string })[] {
  return (window.ztools.db.allDocs(prefix) || []) as any[]
}

// ---------- 设置 ----------

export function getSettings(): GodotSettings {
  const doc = getDoc<GodotSettings>('godot/settings')
  if (!doc) return { ...DEFAULT_SETTINGS }
  const { _id, _rev, ...data } = doc as AnyDoc
  return { ...DEFAULT_SETTINGS, ...data }
}

export function saveSettings(patch: Partial<GodotSettings>): GodotSettings {
  const next = { ...getSettings(), ...patch }
  putDoc('godot/settings', next)
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
export function pickDirectory(title: string, defaultPath?: string): string | undefined {
  const result = window.ztools.showOpenDialog({
    title,
    defaultPath,
    properties: ['openDirectory', 'createDirectory']
  })
  return result?.[0]
}

/** 选择单个文件,返回绝对路径;取消返回 undefined */
export function pickFile(title: string, extensions: string[], defaultPath?: string): string | undefined {
  const result = window.ztools.showOpenDialog({
    title,
    defaultPath,
    properties: ['openFile'],
    filters: [{ name: extensions.join('/'), extensions }]
  })
  return result?.[0]
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
