// `window.services` 的类型契约 —— preload 暴露给渲染层的唯一能力面。
//
// 原状:这份接口写在 `src/env.d.ts` 里(渲染层手写),而实现写在
// `src-ztools/preload/services.js`(preload 手写)。两边各写一遍、靠一个契约测试比对,
// 任何新增能力都要改两处。抽成模块后可导出,于是:
//   · 渲染层通过下方 `declare global` 拿到 `window.services` 的类型;
//   · preload 侧用 `/** @type {import('../../src/types/services').Services} */`
//     标注 services.js —— **编译器**会强制那 47 个方法一个不多一个不少。
//
// 因此这份文件是**唯一权威**。新增能力只需在这里加签名 + 在 services.js 加实现,
// 少写一边会直接编译失败(见 docs/optimization-plan.md 的 P0-2)。
import type {
  AddonInfo,
  BackupPhase,
  BackupRecord,
  BackupStats,
  BackupTask,
  DownloadTask,
  FavoriteAsset,
  GodotProject,
  GodotRelease,
  GodotVersion,
  InstallPlan,
  MarketAsset,
  Platform,
  Variant
} from './godot'

/** 下载安装一个引擎版本的入参 */
export interface DownloadParams {
  tag: string
  variant: Variant
  platform: Platform
  url: string
  fileName: string
  /** 安装包字节数;商店/发布列表偶尔缺这个字段,下游只把它当进度条分母的提示值 */
  totalSize?: number
}

/** 备份/恢复进度回调载荷 */
export interface BackupProgress {
  phase: BackupPhase
  done: number
  total: number
  current: string
  bytes: number
}

export interface Services {
  currentPlatform(): Platform
  fetchReleases(force?: boolean): Promise<GodotRelease[]>
  /** 下载并安装版本(入队),返回任务 id */
  downloadAndInstall(
    params: DownloadParams,
    opts: { versionsRoot: string }
  ): string
  cancelTask(id: string): void
  dismissTask(id: string): void
  /** 订阅下载任务快照,返回取消订阅函数 */
  watchTasks(fn: (tasks: DownloadTask[]) => void): () => void
  importLocalExe(exePath: string): Promise<{ ok: boolean, error?: string, version?: GodotVersion }>
  deleteVersion(v: { id: string, installDir?: string, managed: boolean }): { ok: boolean, error?: string }
  /** 添加项目(目录或 project.godot 文件路径) */
  addProject(inputPath: string): {
    ok: boolean
    error?: string
    project?: GodotProject
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
    project?: GodotProject
  }
  /** 删除项目记录(deleteFiles=true 同时删除项目文件夹,Windows 移入回收站) */
  removeProject(id: string, deleteFiles?: boolean): { ok: boolean, error?: string, filesDeleted?: boolean }
  /** 复制插件目录到另一个项目(不自动启用);同时把市场来源记录一并过户 */
  copyAddonsToProject(opts: {
    sourceProjectId: string
    dirNames: string[]
    targetProjectId: string
  }): { ok: boolean, error?: string, copied?: number, skipped?: string[], adopted?: number, targetName?: string }
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
  ): Promise<BackupRecord>
  /** 预估备份规模(文件数 + 字节),分片让出避免卡界面 */
  estimateBackup(
    projectId: string,
    opts?: { includeCache?: boolean, exclude?: string[] }
  ): Promise<{ fileCount: number, bytes: number }>
  /** 备份记录列表(按时间倒序);兼容 listBackups(projectId) 与 listBackups({projectId, withStatus}) */
  listBackups(
    arg?: string | { projectId?: string, withStatus?: boolean }
  ): BackupRecord[]
  /** 每个项目最近一份备份 */
  listLatestBackups(): Record<string, BackupRecord>
  /** 单条备份记录 */
  getBackup(backupId: string): BackupRecord | null
  /** 备份汇总统计 */
  backupStats(): BackupStats
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
    targets: BackupRecord[]
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
  listBackupTasks(): BackupTask[]
  /** 订阅备份任务快照,返回取消订阅函数 */
  watchBackupTasks(fn: (tasks: BackupTask[]) => void): () => void
  /** 取消备份/恢复任务(进入不可回滚阶段后返回 false) */
  cancelBackupTask(taskId: string): boolean
  /** 移除已结束的任务记录 */
  dismissBackupTask(taskId: string): boolean
  /** 启动项目(editor=编辑器,run=运行) */
  launchProject(opts: { projectId: string, action: 'editor' | 'run' }): {
    ok: boolean
    error?: string
    project?: GodotProject & { _id: string }
  }
  /** 搜索 Asset Store */
  searchAssets(
    filter: string,
    godotVersion?: string,
    page?: number
  ): Promise<{ result: MarketAsset[], page: number, pages: number }>
  /** 官方精选(推荐)Addon */
  listFeatured(): Promise<MarketAsset[]>
  /** 全部资产(默认热度排序,分页) */
  listAllAssets(page?: number): Promise<{ result: MarketAsset[], page: number, pages: number }>
  /** 最新上架的资产(按发布时间倒序,分页) */
  listNewAssets(page?: number): Promise<{ result: MarketAsset[], page: number, pages: number }>
  /** 最近更新的 Addon */
  listRecentlyUpdated(page?: number): Promise<{ result: MarketAsset[], page: number, pages: number }>
  /** 本地收藏列表 */
  listFavorites(): FavoriteAsset[]
  /** 收藏/取消收藏 */
  toggleFavorite(asset: MarketAsset): boolean
  /** 是否已收藏 */
  isFavorite(assetId: string): boolean
  /** 批量获取资产最新 release 信息(版本/兼容 Godot 版本/发布日期) */
  getReleaseInfos(assetIds: string[]): Promise<
    Record<string, { version: string, minGodot: string, maxGodot: string, created: string }>
  >
  /** 列出资产全部 release(版本选择用;size 已由 preload 从 API 的 MB 换算为字节) */
  listAssetReleases(assetId: string): Promise<
    { version: string, created: string, stable: boolean, minGodot: string, maxGodot: string, size: number }[]
  >
  /** 验证 Asset Store API Key */
  verifyApiKey(key: string): Promise<{ authenticated: boolean, name?: string }>
  /** 列出项目已安装插件 */
  listAddons(projectId: string): AddonInfo[]
  /** 安装预览:预下载 zip 并归纳安装计划(kind/顶层条目/冲突);确认后凭 stageId 安装,取消后释放 */
  previewAssetInstall(
    opts: { projectId: string, assetId: string, version?: string },
    onProgress?: (p: { stage: 'downloading' | 'extracting', received?: number, total?: number }) => void
  ): Promise<{ ok: boolean, error?: string, stageId?: string, title?: string, versionString?: string, plan?: InstallPlan }>
  /** 释放预览暂存的安装包(取消确认时调用;幂等) */
  cancelStagedAsset(stageId: string): { ok: boolean }
  /** 安装市场资产(version 指定 release 版本,缺省为最新;含 plugin.cfg 走插件链路,否则按纯素材落项目根)
   *  stageId=复用预览暂存的包;stripTopDir=素材唯一顶层目录是否并入项目根(缺省沿用上次选择) */
  installAsset(
    opts: {
      projectId: string
      assetId: string
      version?: string
      stageId?: string
      stripTopDir?: boolean
      assetMeta?: {
        title?: string,
        author?: string,
        category?: string,
        iconUrl?: string,
        description?: string,
        storeUrl?: string
      }
    },
    onProgress?: (p: { stage: 'downloading' | 'extracting', received?: number, total?: number }) => void
  ): Promise<{ ok: boolean, error?: string, addon?: { title: string, versionString: string, dirNames: string[], enabled: boolean, kind: 'addon' | 'asset' } }>
  /** 更新资产(覆盖安装;素材先按旧清单清理再安装) */
  updateAsset(
    opts: { projectId: string, assetId: string },
    onProgress?: (p: { stage: 'downloading' | 'extracting', received?: number, total?: number }) => void
  ): Promise<{ ok: boolean, error?: string, addon?: { title: string, versionString: string, dirNames: string[], enabled: boolean, kind: 'addon' | 'asset' } }>
  /** 检查插件更新 */
  checkAddonUpdate(opts: { projectId: string, assetId: string }): Promise<{ hasUpdate: boolean, latest?: string, error?: string }>
  /** 卸载插件或素材(市场素材传 assetId 按安装清单删除) */
  uninstallAddon(opts: { projectId: string, dirName: string, assetId?: string }): { ok: boolean, error?: string }
  /** 启用/禁用插件 */
  setAddonEnabled(opts: { projectId: string, dirName: string, enabled: boolean }): { ok: boolean, error?: string }
}

declare global {
  interface Window {
    services: Services
  }
}
