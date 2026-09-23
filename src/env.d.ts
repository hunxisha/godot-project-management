/// <reference types="vite/client" />
/// <reference types="@ztools-center/ztools-api-types" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>
  export default component
}

// Preload services 类型声明(对应 src-ztools/preload/services.js)
interface DownloadParams {
  tag: string
  variant: import('./types/godot').Variant
  platform: import('./types/godot').Platform
  url: string
  fileName: string
  totalSize: number
}

interface Services {
  currentPlatform(): import('./types/godot').Platform
  fetchReleases(force?: boolean): Promise<import('./types/godot').GodotRelease[]>
  /** 下载并安装版本(入队),返回任务 id */
  downloadAndInstall(
    params: DownloadParams,
    opts: { versionsRoot: string }
  ): string
  cancelTask(id: string): void
  dismissTask(id: string): void
  /** 订阅下载任务快照,返回取消订阅函数 */
  watchTasks(fn: (tasks: import('./types/godot').DownloadTask[]) => void): () => void
  importLocalExe(exePath: string): Promise<{ ok: boolean, error?: string, version?: import('./types/godot').GodotVersion }>
  deleteVersion(v: { id: string, installDir?: string, managed: boolean }): { ok: boolean, error?: string }
  /** 添加项目(目录或 project.godot 文件路径) */
  addProject(inputPath: string): {
    ok: boolean
    error?: string
    project?: import('./types/godot').GodotProject
    exists?: boolean
  }
  /** 递归扫描目录,返回所有含 project.godot 的目录 */
  scanProjects(rootDir: string): string[]
  /** 新建项目:生成 project.godot 与默认图标并加入列表 */
  createProject(opts: {
    name: string
    parentDir: string
    renderer: 'forward_plus' | 'mobile' | 'gl_compatibility'
    /** 已装引擎版本 tag(如 4.7.2-stable),用于写入 features 版本号 */
    versionTag?: string
    /** 已装引擎版本 id,用于绑定项目与引擎 */
    versionId?: string
  }): {
    ok: boolean
    error?: string
    project?: import('./types/godot').GodotProject
  }
  /** 删除项目记录(deleteFiles=true 同时删除项目文件夹,Windows 移入回收站) */
  removeProject(id: string, deleteFiles?: boolean): { ok: boolean, error?: string, filesDeleted?: boolean }
  /** 复制插件目录到另一个项目(不自动启用) */
  copyAddonsToProject(opts: {
    sourceProjectId: string
    dirNames: string[]
    targetProjectId: string
  }): { ok: boolean, error?: string, copied?: number, skipped?: string[], targetName?: string }
  /** 启动项目(editor=编辑器,run=运行) */
  launchProject(opts: { projectId: string, action: 'editor' | 'run' }): {
    ok: boolean
    error?: string
    project?: import('./types/godot').GodotProject & { _id: string }
  }
  /** 搜索 Asset Store */
  searchAssets(
    filter: string,
    godotVersion?: string,
    page?: number
  ): Promise<{ result: import('./types/godot').MarketAsset[], page: number, pages: number }>
  /** 官方精选(推荐)Addon */
  listFeatured(): Promise<import('./types/godot').MarketAsset[]>
  /** 全部资产(默认热度排序,分页) */
  listAllAssets(page?: number): Promise<{ result: import('./types/godot').MarketAsset[], page: number, pages: number }>
  /** 最新上架的资产(按发布时间倒序,分页) */
  listNewAssets(page?: number): Promise<{ result: import('./types/godot').MarketAsset[], page: number, pages: number }>
  /** 最近更新的 Addon */
  listRecentlyUpdated(page?: number): Promise<{ result: import('./types/godot').MarketAsset[], page: number, pages: number }>
  /** 本地收藏列表 */
  listFavorites(): import('./types/godot').FavoriteAsset[]
  /** 收藏/取消收藏 */
  toggleFavorite(asset: import('./types/godot').MarketAsset): boolean
  /** 是否已收藏 */
  isFavorite(assetId: string): boolean
  /** 批量获取资产最新 release 信息(版本/兼容 Godot 版本/发布日期) */
  getReleaseInfos(assetIds: string[]): Promise<
    Record<string, { version: string, minGodot: string, maxGodot: string, created: string }>
  >
  /** 列出资产全部 release(版本选择用) */
  listAssetReleases(assetId: string): Promise<
    { version: string, created: string, stable: boolean, minGodot: string, maxGodot: string, size: number }[]
  >
  /** 验证 Asset Store API Key */
  verifyApiKey(key: string): Promise<{ authenticated: boolean, name?: string }>
  /** 列出项目已安装插件 */
  listAddons(projectId: string): import('./types/godot').AddonInfo[]
  /** 安装市场插件(version 指定 release 版本,缺省为最新) */
  installAsset(
    opts: {
      projectId: string
      assetId: string
      version?: string
      assetMeta?: {
        title?: string,
        author?: string,
        category?: string,
        rating?: number,
        iconUrl?: string,
        description?: string,
        storeUrl?: string
      }
    },
    onProgress?: (p: { stage: 'downloading' | 'extracting', received?: number, total?: number }) => void
  ): Promise<{ ok: boolean, error?: string, addon?: { title: string, versionString: string, dirNames: string[], enabled: boolean } }>
  /** 更新插件(覆盖安装) */
  updateAsset(
    opts: { projectId: string, assetId: string },
    onProgress?: (p: { stage: 'downloading' | 'extracting', received?: number, total?: number }) => void
  ): Promise<{ ok: boolean, error?: string, addon?: { title: string, versionString: string, dirNames: string[], enabled: boolean } }>
  /** 检查插件更新 */
  checkAddonUpdate(opts: { projectId: string, assetId: string }): Promise<{ hasUpdate: boolean, latest?: string, error?: string }>
  /** 卸载插件 */
  uninstallAddon(opts: { projectId: string, dirName: string }): { ok: boolean, error?: string }
  /** 启用/禁用插件 */
  setAddonEnabled(opts: { projectId: string, dirName: string, enabled: boolean }): { ok: boolean, error?: string }
}

declare global {
  interface Window {
    services: Services
  }
}

export {}
