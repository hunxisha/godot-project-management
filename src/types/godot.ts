/** 打开项目的动作:编辑器 / 运行 / 打开目录 */
export type OpenAction = 'editor' | 'run' | 'folder'

/** 平台标识 */
export type Platform = 'win64' | 'macos' | 'linux64'

/** 引擎变体:标准版 / C#(mono) 版 */
export type Variant = 'standard' | 'mono'

/** 已安装的 Godot 引擎版本 */
export interface GodotVersion {
  id: string
  tag: string
  /** 展示名,如 "4.3 Stable" */
  name: string
  variant: Variant
  platform: Platform
  exePath: string
  /** 插件创建的安装目录(managed 时用于删除) */
  installDir?: string
  /** true=由插件下载并管理,false=用户本地导入 */
  managed: boolean
  /** 安装包来源(下载 URL 或 'local') */
  source?: string
  installedAt: number
  /** 字节 */
  size?: number
  /** --version 校验是否通过 */
  verified?: boolean
}

/** 管理的 Godot 项目 */
export interface GodotProject {
  id: string
  /** 项目根目录绝对路径 */
  path: string
  name: string
  /** project.godot 中 icon 的相对路径 */
  icon?: string
  /** project.godot 的 config_version(5=4.x,4=3.x) */
  configVersion: number
  /** config/features[0],如 "4.3" */
  engineVersion?: string
  /** 绑定的引擎版本 id */
  versionId?: string
  favorite: boolean
  lastOpenedAt?: number
  openCount: number
  addedAt: number
}

/** 插件设置 */
export interface GodotSettings {
  /** 引擎安装根目录(首次下载时选择并保存) */
  versionsRoot?: string
  /** HTTP 代理地址,如 http://127.0.0.1:7890;留空直连 */
  proxy?: string
  defaultVersionId?: string
  defaultOpenAction: OpenAction
  /** 安装插件后自动在 project.godot 中启用 */
  autoEnablePlugin: boolean
}

export const DEFAULT_SETTINGS: GodotSettings = {
  defaultOpenAction: 'editor',
  autoEnablePlugin: true
}

/** 引擎下载资产(官方 CDN 直链) */
export interface ReleaseAsset {
  name: string
  url: string
  /** 归档页不提供大小;0 表示未知,下载开始后从响应 Content-Length 获取 */
  size?: number
}

/** 官方归档中的引擎版本(含稳定版与 dev/beta/rc 预发布版) */
export interface GodotRelease {
  tag: string
  name: string
  publishedAt: string
  prerelease: boolean
  assets: ReleaseAsset[]
}

/** 下载任务 */
export type DownloadStatus = 'queued' | 'downloading' | 'extracting' | 'verifying' | 'done' | 'error' | 'canceled'

export interface DownloadTask {
  id: string
  tag: string
  variant: Variant
  platform: Platform
  url: string
  fileName: string
  totalSize: number
  status: DownloadStatus
  /** 已接收字节 */
  received: number
  /** B/s */
  speed: number
  error?: string
  /** 完成后对应的版本 id */
  versionId?: string
  /** 完成后对应的版本文档 */
  version?: GodotVersion
}

/** Asset Library 市场资产 */
export interface MarketAsset {
  assetId: number
  title: string
  author: string
  category: string
  versionString: string
  /** 适配的引擎版本,如 "4.3" 或 "any" */
  godotVersion: string
  downloadUrl: string
  downloadCount: number
  iconUrl?: string
  modifyDate?: string
  description?: string
}

/** 项目已安装的插件(Addon) */
export interface InstalledAddon {
  id: string
  projectId: string
  assetId: number
  title: string
  versionString: string
  /** addons/ 下的目录名 */
  dirNames: string[]
  installedAt: number
}

/** 扫描项目 addons/ 得到的插件信息 */
export interface AddonInfo {
  dirName: string
  name: string
  version?: string
  author?: string
  hasCfg: boolean
  enabled: boolean
  fromMarket: boolean
  assetId?: number
  versionString?: string
  installedAt?: number
}

/** project.godot 解析结果 */
export interface ProjectInfo {
  name: string
  configVersion: number
  engineVersion?: string
  icon?: string
}

/** db 文档 id 约定 */
export const DOC_ID = {
  settings: 'godot/settings',
  releasesCache: 'godot/cache/releases',
  version: (tag: string, variant: Variant, platform: Platform) =>
    `godot/version/${tag}-${variant}-${platform}`,
  project: (id: string) => `godot/project/${id}`,
  addon: (projectId: string, assetId: number) => `godot/asset/${projectId}/${assetId}`
} as const
