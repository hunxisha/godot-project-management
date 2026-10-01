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
  ExportPreset,
  ExportTask,
  ExportHistoryEntry,
  AssetDetail,
  NetworkCheckResult,
  GodotRelease,
  GodotVersion,
  InstallPlan,
  MarketAsset,
  Platform,
  Variant,
  DocClassDetail,
  DocClassDiff,
  DocClassExtras,
  DocClassSummary,
  DocLibraryDiff,
  DocHistoryItem,
  DocLibraryStatus,
  DocSearchHit,
  DocsCacheInfo,
  DocsTask
} from './godot'

/** 下载安装一个引擎版本的入参 */
export interface DownloadParams {
  tag: string
  variant: Variant
  platform: Platform
  url: string
  /**
   * 备用直链(官方构建仓库同名资产)。CDN 的版本映射表会滞后于构建仓库 ——
   * 归档页已经列出新版本、CDN 却还没映射时,点下载就是「下载失败 HTTP 404」;
   * 主地址 404/403 时自动回落这条地址(见 ReleaseAsset.fallbackUrl)。
   */
  fallbackUrl?: string
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
  /** 查询已装引擎的导出模板状态(versionDir 形如 4.3.stable;目录存在即视为已安装) */
  exportTemplateStatus(versionId: string): { versionDir: string, installed: boolean, tracked: boolean, path: string }
  /** 下载安装导出模板(入队,进度走 watchTasks,任务 kind='templates') */
  installExportTemplates(versionId: string): { ok: boolean, error?: string, taskId?: string }
  /** 卸载导出模板(删除模板目录与记录) */
  uninstallExportTemplates(versionId: string): { ok: boolean, error?: string }
  /** 列出项目的导出预设(解析 export_presets.cfg;无该文件时返回空列表) */
  listExportPresets(projectId: string): { ok: boolean, error?: string, presets?: ExportPreset[] }
  /** 发起一键导出(入队;缺模板时返回 missingTemplates=true 不入队) */
  runExport(params: { projectId: string, presetName: string, outputPath?: string }): {
    ok: boolean
    error?: string
    taskId?: string
    missingTemplates?: boolean
  }
  /** 订阅导出任务快照,返回取消订阅函数 */
  watchExportTasks(fn: (tasks: ExportTask[]) => void): () => void
  /** 取消导出任务 */
  cancelExportTask(id: string): void
  /** 移除导出任务记录 */
  dismissExportTask(id: string): void
  /** 导出历史(时间倒序;projectId 省略时返回全部) */
  listExportHistory(projectId?: string): ExportHistoryEntry[]
  /** 删除一条导出历史记录(只删记录,不动产物文件) */
  removeExportHistoryEntry(id: string): { ok: boolean }
  /** 导出插件数据(设置+项目清单+市场收藏)到 JSON 文件 */
  exportPluginData(destPath: string): { ok: boolean, error?: string, projects?: number, favorites?: number }
  /** 从 JSON 文件导入插件数据(项目仅登记本机存在的路径;收藏合并;设置只补缺失键) */
  importPluginData(srcPath: string): {
    ok: boolean
    error?: string
    projectsAdded?: number
    projectsOffline?: number
    projectsSkipped?: number
    favoritesAdded?: number
    docFavoritesAdded?: number
    docHistoryAdded?: number
    settingsAdopted?: number
  }
  /** 网络诊断:依次探测商店 API/GitHub/官方 CDN 的可达性与延迟 */
  runNetworkDiagnostics(): Promise<{ ok: boolean, results: NetworkCheckResult[] }>
  /** 查询项目的 .godot 编辑器缓存大小 */
  getProjectCacheInfo(projectId: string): { ok: boolean, error?: string, exists?: boolean, size?: number }
  /** 清理项目的 .godot 编辑器缓存 */
  cleanProjectCache(projectId: string): { ok: boolean, error?: string, freed?: number }
  /** 添加项目(目录或 project.godot 文件路径) */
  addProject(inputPath: string): {
    ok: boolean
    error?: string
    project?: GodotProject
    exists?: boolean
  }
  /** 递归扫描目录,返回所有含 project.godot 的目录 */
  scanProjects(rootDir: string): string[]
  /** 新建项目:生成 project.godot、官方默认图标与 .editorconfig;
   *  gitInit=true 时额外 git init 并写官方 .gitignore/.gitattributes(含首次提交) */
  createProject(opts: {
    name: string
    parentDir: string
    renderer: 'forward_plus' | 'mobile' | 'gl_compatibility'
    /** 已装引擎版本 tag(如 4.7.2-stable),用于写入 features 版本号 */
    versionTag?: string
    /** 已装引擎版本 id,用于绑定项目与引擎 */
    versionId?: string
    /** 用 Git 管理项目 */
    gitInit?: boolean
  }): {
    ok: boolean
    error?: string
    project?: GodotProject
    /** gitInit 时的结果(git 不可用/提交失败不阻断项目创建) */
    git?: { initialized: boolean, error?: string, committed: boolean }
  }
  /** 删除项目记录(deleteFiles=true 同时删除项目文件夹,Windows 移入回收站) */
  removeProject(id: string, deleteFiles?: boolean): { ok: boolean, error?: string, filesDeleted?: boolean }
  /** 复制插件目录到另一个项目(不自动启用);同时把市场来源记录一并过户 */
  copyAddonsToProject(opts: {
    sourceProjectId: string
    dirNames: string[]
    targetProjectId: string
  }): { ok: boolean, error?: string, copied?: number, skipped?: string[], adopted?: number, targetName?: string }
  /** 复制已装纯素材到另一个项目(按安装清单逐文件复制,目标已有同名文件跳过) */
  copyAssetToProject(opts: {
    sourceProjectId: string
    assetId: string
    targetProjectId: string
  }): { ok: boolean, error?: string, copied?: number, skipped?: string[] }
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
  /** 搜索市场资产(assetType:0=插件/素材,1=完整项目) */
  searchAssets(
    filter: string,
    godotVersion?: string,
    page?: number,
    assetType?: number
  ): Promise<{ result: MarketAsset[], page: number, pages: number }>
  /** 官方精选(推荐)Addon */
  listFeatured(): Promise<MarketAsset[]>
  /** 全部资产(默认热度排序,分页) */
  listAllAssets(page?: number): Promise<{ result: MarketAsset[], page: number, pages: number }>
  /** 最新上架的资产(按发布时间倒序,分页) */
  listNewAssets(page?: number): Promise<{ result: MarketAsset[], page: number, pages: number }>
  /** 最近更新的 Addon */
  listRecentlyUpdated(page?: number): Promise<{ result: MarketAsset[], page: number, pages: number }>
  /** 完整项目/模板(type=1,按更新时间倒序,分页) */
  listProjectAssets(page?: number): Promise<{ result: MarketAsset[], page: number, pages: number }>
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
  /** 资产详情(含媒体/许可/评分等扩展字段,详情弹层用) */
  getAssetDetail(assetId: string, version?: string): Promise<AssetDetail>
  /** 安装预览:预下载 zip 并归纳安装计划(kind/顶层条目/冲突);确认后凭 stageId 安装,取消后释放 */
  previewAssetInstall(
    opts: { projectId: string, assetId: string, version?: string },
    onProgress?: (p: { stage: 'downloading' | 'extracting', received?: number, total?: number }) => void
  ): Promise<{ ok: boolean, error?: string, stageId?: string, title?: string, versionString?: string, plan?: InstallPlan }>
  /** 取消进行中的预览下载(幂等;无在途下载时空操作) */
  cancelAssetPreview(assetId: string): { ok: boolean }
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
  /** 把完整项目/模板另存为独立项目(解压到 destRoot 下的 slug 子目录并登记进项目列表) */
  saveAssetAsProject(
    opts: { assetId: string, version?: string, stageId?: string, destRoot: string },
    onProgress?: (p: { stage: 'downloading' | 'extracting', received?: number, total?: number }) => void
  ): Promise<{ ok: boolean, error?: string, projectName?: string, projectId?: string, path?: string }>
  /** 仅下载资产 zip 到指定目录(不安装、不写记录;重名自动加序号) */
  downloadAssetZip(
    opts: { assetId: string, version?: string, destDir: string },
    onProgress?: (p: { stage: 'downloading' | 'extracting', received?: number, total?: number }) => void
  ): Promise<{ ok: boolean, error?: string, file?: string }>
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
  /** ---------- 引擎文档库 ---------- */
  /** 生成版本文档库(入队,进度走 watchDocsTasks,任务 kind='docs';在途时拒绝重复)。
   *  opts.forceTranslation=true 忽略 po 磁盘缓存重新下载官方翻译 */
  docsGenerate(versionId: string, opts?: { forceTranslation?: boolean }): { ok: boolean, error?: string, taskId?: string }
  /** 从外部 extension_api.json 导入建库(无引擎可用时的兜底;版本取 header.version_full_name) */
  docsImport(opts: { jsonPath: string, tag?: string, name?: string }): {
    ok: boolean
    error?: string
    taskId?: string
    versionId?: string
  }
  /** 扫描项目脚本(带 class_name 的 .gd)生成项目文档库,与引擎库同构、复用同一套浏览 UI */
  docsScanProject(projectId: string): { ok: boolean, error?: string, taskId?: string, versionId?: string }
  /** 取消文档库生成任务 */
  docsCancelTask(id: string): void
  /** 移除已结束的文档库任务记录 */
  dismissDocsTask(id: string): void
  /** 订阅文档库任务快照,返回取消订阅函数 */
  watchDocsTasks(fn: (tasks: DocsTask[]) => void): () => void
  /** 文档库状态(ready=已生成 / building=生成中 / null=未生成) */
  docsLibraryStatus(versionId: string): DocLibraryStatus | null
  /** 删除文档库(目录+db 记录;收藏/历史为全局,保留) */
  docsDeleteLibrary(versionId: string): { ok: boolean }
  /** 类列表(来自索引;未生成时 ok=false) */
  docsListClasses(versionId: string): { ok: boolean, error?: string, classes?: DocClassSummary[] }
  /** 类正文(未知类/非法类名返回 null) */
  docsGetClass(versionId: string, className: string): DocClassDetail | null
  /** 类附加信息(教程链接):缓存命中直接返回,否则按需拉官方 XML;离线/失败返回 null */
  docsGetClassExtras(versionId: string, className: string): Promise<DocClassExtras | null>
  /** 本地搜索:类名/方法/成员/信号/枚举/常量,按分值排序 */
  docsSearch(versionId: string, query: string, limit?: number): DocSearchHit[]
  /** 描述正文检索(懒加载整库正文并缓存;返回按命中次数排序的类,附片段) */
  docsSearchFullText(versionId: string, query: string, limit?: number): DocSearchHit[]
  /** 库级差异汇总(新增/移除/有变化的类;两库都需已生成) */
  docsDiffLibraries(versionA: string, versionB: string): DocLibraryDiff
  /** 单类在两库之间的成员级差异 */
  docsDiffClass(versionA: string, versionB: string, className: string): { ok: boolean, error?: string, diff?: DocClassDiff }
  /** 收藏/取消收藏(全局,按类名跨版本) */
  docsToggleFavorite(className: string, fav: boolean): { ok: boolean }
  /** 收藏列表 */
  docsListFavorites(): string[]
  /** 最近浏览(最新在前,上限 30) */
  docsListHistory(): DocHistoryItem[]
  /** 记录一次浏览(去重置顶) */
  docsPushHistory(className: string): void
  /** 文档库缓存统计(设置页清理用) */
  docsCacheInfo(): DocsCacheInfo
  /** 清理文档库缓存(versionIds 省略时清全部;收藏/历史不受影响) */
  docsCleanCache(versionIds?: string[]): { ok: boolean, removed?: number }
}

/**
 * 渲染层看到的 services 视图:所有数据方法统一为 Promise 返回(Tauri 2 的 IPC 只有异步,
 * 阶段 A 见 docs/tauri-migration-plan.md §7)。Electron 门面返回普通值也满足本视图
 * —— `await` 对普通值与 Promise 等价,两端共用同一份渲染层。
 * 订阅(watch*)是「注册回调→返回取消函数」的事件通道,无需异步;currentPlatform
 * 是注入的平台常量。二者保持同步签名。
 * 注意:门面验证仍以 `Services` 为准(本类型只是视图变换),不影响 preload 的 @type 校验。
 */
type AsyncServices = {
  [K in keyof Services]: K extends
    | 'currentPlatform'
    | 'watchTasks'
    | 'watchExportTasks'
    | 'watchBackupTasks'
    | 'watchDocsTasks'
    ? Services[K]
    : Services[K] extends (...args: infer A) => infer R
      ? (...args: A) => Promise<Awaited<R>>
      : Services[K]
}

declare global {
  interface Window {
    services: AsyncServices
  }
}
