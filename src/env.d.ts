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

/** 备份/恢复进度回调载荷 */
interface BackupProgress {
  phase: import('./types/godot').BackupPhase
  done: number
  total: number
  current: string
  bytes: number
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
  /** 备份项目:先写临时产物,成功后原子改名并落库;失败/取消不留痕迹 */
  backupProject(
    projectId: string,
    opts: {
      mode: 'zip' | 'copy'
      destDir: string
      includeCache?: boolean
      level?: 1 | 6 | 9
      label?: string
      exclude?: string[]
    },
    onProgress?: (p: BackupProgress) => void
  ): Promise<import('./types/godot').BackupRecord>
  /** 预估备份规模(文件数 + 字节),分片让出避免卡界面 */
  estimateBackup(
    projectId: string,
    opts?: { includeCache?: boolean, exclude?: string[] }
  ): Promise<{ fileCount: number, bytes: number }>
  /** 备份记录列表(按时间倒序);兼容 listBackups(projectId) 与 listBackups({projectId, withStatus}) */
  listBackups(
    arg?: string | { projectId?: string, withStatus?: boolean }
  ): import('./types/godot').BackupRecord[]
  /** 每个项目最近一份备份 */
  listLatestBackups(): Record<string, import('./types/godot').BackupRecord>
  /** 单条备份记录 */
  getBackup(backupId: string): import('./types/godot').BackupRecord | null
  /** 备份汇总统计 */
  backupStats(): import('./types/godot').BackupStats
  /** 更新备份备注名(label 传空串清除) */
  updateBackup(backupId: string, patch: { label?: string }): { ok: boolean, error?: string }
  /** 校验备份内容是否可用(是否含 project.godot) */
  verifyBackup(backupId: string): { ok: boolean, valid: boolean, error?: string, entryCount?: number }
  /** 删除备份(keepRecordOnly=true 仅移除记录,保留磁盘文件) */
  deleteBackup(backupId: string, opts?: { keepRecordOnly?: boolean }): { ok: boolean, error?: string }
  /** 批量删除备份 */
  deleteBackups(backupIds: string[], opts?: { keepRecordOnly?: boolean }): {
    ok: boolean
    removed: number
    failed: { id: string, error: string }[]
  }
  /** 清理备份(默认 dryRun:true 只返回预览,需显式传 dryRun:false 才执行) */
  pruneBackups(opts: { keepPerProject?: number, olderThanDays?: number, dryRun?: boolean }): {
    ok: boolean
    dryRun: boolean
    targets: import('./types/godot').BackupRecord[]
    totalSize: number
    removed?: number
    failed?: { id: string, error: string }[]
    error?: string
  }
  /** 从备份恢复(mode: 'overwrite' 覆盖原项目 | 'new' 恢复为新项目) */
  restoreBackup(
    backupId: string,
    opts: { mode: 'overwrite' | 'new', destDir?: string, newName?: string },
    onProgress?: (p: BackupProgress) => void
  ): Promise<{
    ok: boolean
    error?: string
    canceled?: boolean
    newProjectName?: string
    newProjectId?: string
  }>
  /** 进行中的备份/恢复任务快照 */
  listBackupTasks(): import('./types/godot').BackupTask[]
  /** 订阅备份任务快照,返回取消订阅函数 */
  watchBackupTasks(fn: (tasks: import('./types/godot').BackupTask[]) => void): () => void
  /** 取消备份/恢复任务(进入不可回滚阶段后返回 false) */
  cancelBackupTask(taskId: string): boolean
  /** 移除已结束的任务记录 */
  dismissBackupTask(taskId: string): boolean
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
