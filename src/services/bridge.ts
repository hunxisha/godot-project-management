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

/**
 * 拍平成纯数据(递归去掉 Vue 的响应式代理)。
 *
 * 为什么必须做:设置里现在有嵌套结构(translateProviders 是对象数组)。
 * 把响应式代理直接交给宿主 db,某些宿主会在跨边界克隆时失败或丢弃字段 ——
 * 表现正是「改完设置、关掉页面再打开就没了」。这里在写入前统一拍平,
 * 读回来的永远是普通对象,比较与序列化都不再受代理影响。
 * @param value 任意可 JSON 化的值
 */
function toPlain<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((v) => toPlain(v)) as unknown as T
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(value as Record<string, unknown>)) {
    out[k] = toPlain((value as Record<string, unknown>)[k])
  }
  return out as T
}

/** 去掉 db 元字段 */
function stripMeta(doc: AnyDoc | null): Record<string, unknown> {
  if (!doc) return {}
  const { _id, _rev, ...data } = doc
  return data
}

export async function getSettings(): Promise<GodotSettings> {
  const doc = await getDoc<GodotSettings>('godot/settings')
  if (!doc) return { ...DEFAULT_SETTINGS }
  const { _id, _rev, ...data } = doc as AnyDoc
  return { ...DEFAULT_SETTINGS, ...data }
}

/**
 * 保存设置(浅合并到现有文档)。
 *
 * 两点与「静默丢失」有关,缺一不可:
 *   1. 写前把 patch 里的代理拍平(toPlain)—— 嵌套数组/对象是新增风险;
 *   2. 写后**按本次 patch 的键回读校验**,对不上就抛错。
 * 宿主 db 的 put 只回 ok/error,不回「哪些字段被丢了」;不回读的话,
 * 一次失败就是「关掉设置页再打开,刚填的又没了」,而界面上毫无线索。
 */
export async function saveSettings(patch: Partial<GodotSettings>): Promise<GodotSettings> {
  const next = { ...(await getSettings()), ...patch }
  const plain = toPlain(next)
  const ok = await putDoc('godot/settings', plain)
  if (!ok) throw new Error('宿主拒绝了这次写入(文档冲突或数据库不可写)')

  const back = stripMeta(await getDoc<GodotSettings>('godot/settings'))
  // 只校验本次改动的键:宿主可能补默认值,那不该算失败
  for (const key of Object.keys(patch)) {
    const want = JSON.stringify((plain as Record<string, unknown>)[key])
    const got = JSON.stringify(back[key])
    if (want !== got) {
      throw new Error(`「${key}」没有写进数据库(写入被宿主丢弃)`)
    }
  }
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
