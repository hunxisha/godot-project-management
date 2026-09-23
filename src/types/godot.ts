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
  /** Asset Store API Key(在 store.godotengine.org 登录后生成) */
  apiKey?: string
  /** API Key 验证通过的用户名(本地缓存显示用) */
  storeAccount?: string
  defaultVersionId?: string
  defaultOpenAction: OpenAction
  /** 安装插件后自动在 project.godot 中启用 */
  autoEnablePlugin: boolean
  /** 删除项目时如何处理项目文件:ask=弹窗询问,always=总是同时删除,never=仅移除记录 */
  deleteProjectFiles: 'ask' | 'always' | 'never'
  /** 项目备份默认目录 */
  backupRoot?: string
}

/** 项目备份记录 */
export interface BackupRecord {
  _id: string
  projectId: string
  projectName: string
  /** zip=打包备份,copy=完整快照目录 */
  mode: 'zip' | 'copy'
  /** 备份文件(zip)或目录(快照)的绝对路径 */
  destPath: string
  /** 字节(zip 为压缩后估算) */
  size: number
  fileCount: number
  createdAt: number
  /** 备份文件已被外部删除 */
  missing?: boolean
}

export const DEFAULT_SETTINGS: GodotSettings = {
  defaultOpenAction: 'editor',
  autoEnablePlugin: true,
  deleteProjectFiles: 'ask'
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
  /** Asset Store 标识:"{publisherSlug}/{assetSlug}" */
  assetId: string
  title: string
  author: string
  category: string
  /** 全部标签 slug(用于客户端标签筛选;旧收藏等历史数据可能缺失) */
  tagSlugs?: string[]
  /** 商店搜索结果不逐资产提供版本,安装时从 releases 端点实时获取 */
  versionString: string
  godotVersion: string
  /** 最新 release 兼容的 Godot 版本范围(列表页由 getReleaseInfos 补齐) */
  minGodot?: string
  maxGodot?: string
  /** 最新 release 发布日期(ISO 日期串,判断新品用) */
  releaseCreated?: string
  /** 商店评分(0-50,除以 10 得星级) */
  rating: number
  iconUrl?: string
  description?: string
  /** 商店页面链接 */
  storeUrl?: string
}

/** 本地收藏的市场资产(官方 API 暂未开放收藏,存于本地) */
export interface FavoriteAsset extends MarketAsset {
  addedAt: number
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
  assetId?: string
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
