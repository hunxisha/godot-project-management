// 通过 window 对象向渲染进程注入 Node 能力
// 能力模块位于 lib/ 下,按功能领域拆分
//
// 下面的 @type 引用渲染层的类型契约(src/types/services.ts) —— 它是**唯一权威**:
// 这份对象必须不多不少地实现 Services 的 61 个方法,少一个、多一个、签名不对都会编译失败。
// 这取代了原先「两处手写 + 一个比对测试」的做法(见 docs/optimization-plan.md 的 P0-2)。
const { currentPlatform, fetchReleases } = require('./lib/releases')
const install = require('./lib/install')
const projects = require('./lib/projects')
const backup = require('./lib/backup')
const { launchProject } = require('./lib/launcher')
const assets = require('./lib/assets')
const templates = require('./lib/templates')
const exporter = require('./lib/exporter')
const datatransfer = require('./lib/datatransfer')
const diagnostics = require('./lib/diagnostics')
const docs = require('./lib/docs')

/** @type {import('../../src/types/services').Services} */
window.services = {
  /** 当前平台标识 */
  currentPlatform: () => currentPlatform(),
  /** 获取 GitHub 版本列表(24h 缓存) */
  fetchReleases: (force) => fetchReleases(force),
  /** 下载并安装版本(入队),返回任务 id */
  downloadAndInstall: (params, opts) => install.downloadAndInstall(params, opts),
  cancelTask: (id) => install.cancelTask(id),
  /** 移除任务记录 */
  dismissTask: (id) => install.dismissTask(id),
  /** 订阅任务快照,返回取消订阅函数 */
  watchTasks: (fn) => install.watchTasks(fn),
  /** 导入本地引擎可执行文件 */
  importLocalExe: (exePath) => install.importLocalExe(exePath),
  /** 删除已装版本(同时清理该版本的文档库缓存;文档库可再生成,无需确认) */
  deleteVersion: (v) => {
    const r = install.deleteVersion(v)
    if (r.ok) docs.docsDeleteLibrary(v.id)
    return r
  },
  /** 查询已装引擎的导出模板状态 */
  exportTemplateStatus: (versionId) => templates.exportTemplateStatus({ versionId }),
  /** 下载安装导出模板(入队,进度走 watchTasks,任务 kind='templates') */
  installExportTemplates: (versionId) => templates.downloadAndInstallTemplates({ versionId }),
  /** 卸载导出模板(删除模板目录与记录) */
  uninstallExportTemplates: (versionId) => templates.uninstallExportTemplates({ versionId }),
  /** 添加项目(目录或 project.godot 文件) */
  addProject: (inputPath) => projects.addProject(inputPath),
  /** 新建项目(生成 project.godot 与默认图标并加入列表) */
  createProject: (opts) => projects.createProject(opts),
  /** 递归扫描目录下的所有项目 */
  scanProjects: (rootDir) => projects.scanProjects(rootDir),
  /** 删除项目记录(deleteFiles=true 同时删除项目文件夹,Windows 移入回收站) */
  removeProject: (id, deleteFiles) => projects.removeProject(id, deleteFiles),
  /** 复制插件目录到另一个项目 */
  copyAddonsToProject: (opts) => projects.copyAddonsToProject(opts),
  /** 复制已装纯素材到另一个项目(按安装清单逐文件复制,目标已有同名文件跳过) */
  copyAssetToProject: (opts) => assets.copyAssetToProject(opts),
  /** 查询项目的 .godot 编辑器缓存大小 */
  getProjectCacheInfo: (projectId) => projects.getProjectCacheInfo(projectId),
  /** 清理项目的 .godot 编辑器缓存(下次打开编辑器时自动重建) */
  cleanProjectCache: (projectId) => projects.cleanProjectCache(projectId),
  /** 列出项目的导出预设(解析 export_presets.cfg) */
  listExportPresets: (projectId) => exporter.listExportPresets(projectId),
  /** 发起导出(入队,进度走 watchExportTasks,任务 kind='export') */
  runExport: (params) => exporter.runExport(params),
  /** 订阅导出任务快照,返回取消订阅函数 */
  watchExportTasks: (fn) => exporter.watchExportTasks(fn),
  /** 取消导出任务 */
  cancelExportTask: (id) => exporter.cancelExportTask(id),
  /** 移除导出任务记录 */
  dismissExportTask: (id) => exporter.dismissExportTask(id),
  /** 导出历史(时间倒序;projectId 省略时返回全部) */
  listExportHistory: (projectId) => exporter.listExportHistory(projectId),
  /** 删除一条导出历史记录(只删记录,不动产物文件) */
  removeExportHistoryEntry: (id) => exporter.removeExportHistoryEntry(id),
  /** 导出插件数据(设置+项目清单+市场收藏)到 JSON 文件 */
  exportPluginData: (destPath) => datatransfer.exportPluginData(destPath),
  /** 从 JSON 文件导入插件数据(项目仅登记本机存在的路径;收藏合并;设置只补缺失键) */
  importPluginData: (srcPath) => datatransfer.importPluginData(srcPath),
  /** 网络诊断:依次探测商店 API/GitHub/官方 CDN 的可达性与延迟 */
  runNetworkDiagnostics: () => diagnostics.runNetworkDiagnostics(),
  /** 备份项目:先写临时产物,成功后原子改名并落库;失败/取消不留痕迹 */
  backupProject: (projectId, opts, onProgress) => backup.backupProject(projectId, opts, onProgress),
  /** 预估备份规模(文件数 + 字节) */
  estimateBackup: (projectId, opts) => backup.estimateBackup(projectId, opts),
  /** 备份记录列表(按时间倒序);兼容 listBackups(projectId) 与 listBackups({projectId, withStatus}) */
  listBackups: (arg) => backup.listBackups(arg),
  /** 每个项目最近一份备份(preload 侧聚合,避免渲染层拉全量) */
  listLatestBackups: () => backup.listLatestBackups(),
  /** 单条备份记录 */
  getBackup: (backupId) => backup.getBackup(backupId),
  /** 备份汇总统计(份数 / 占用 / 缺失 / 覆盖项目数) */
  backupStats: () => backup.backupStats(),
  /** 更新备份备注名(label 传空串清除) */
  updateBackup: (backupId, patch) => backup.updateBackup(backupId, patch),
  /** 校验备份内容是否可用(是否含 project.godot) */
  verifyBackup: (backupId) => backup.verifyBackup(backupId),
  /** 删除备份(记录 + 文件移入回收站;keepRecordOnly=true 仅移除记录) */
  deleteBackup: (backupId, opts) => backup.deleteBackup(backupId, opts),
  /** 批量删除备份 */
  deleteBackups: (backupIds, opts) => backup.deleteBackups(backupIds, opts),
  /** 清理备份(默认 dryRun:true 只返回预览,需显式传 dryRun:false 才执行) */
  pruneBackups: (opts) => backup.pruneBackups(opts),
  /** 从备份恢复(mode: 'overwrite' 覆盖原项目 | 'new' 恢复为新项目) */
  restoreBackup: (backupId, opts, onProgress) => backup.restoreBackup(backupId, opts, onProgress),
  /** 进行中的备份/恢复任务快照 */
  listBackupTasks: () => backup.listBackupTasks(),
  /** 订阅备份任务快照,返回取消订阅函数 */
  watchBackupTasks: (fn) => backup.watchBackupTasks(fn),
  /** 取消备份/恢复任务(进入不可回滚阶段后返回 false) */
  cancelBackupTask: (taskId) => backup.cancelBackupTask(taskId),
  /** 移除已结束的任务记录 */
  dismissBackupTask: (taskId) => backup.dismissBackupTask(taskId),
  /** 启动项目(editor=打开编辑器带 -e,run=直接运行) */
  launchProject: (opts) => launchProject(opts),
  /** 搜索 Asset Store(assetType:0=插件/素材,1=完整项目) */
  searchAssets: (filter, godotVersion, page, assetType) => assets.searchAssets(filter, godotVersion, page, assetType),
  /** 官方精选(推荐)Addon */
  listFeatured: () => assets.listFeatured(),
  /** 全部资产(默认热度排序,分页) */
  listAllAssets: (page) => assets.listAllAssets(page),
  /** 最新上架的资产(按发布时间倒序,分页) */
  listNewAssets: (page) => assets.listNewAssets(page),
  /** 最近更新的 Addon */
  listRecentlyUpdated: (page) => assets.listRecentlyUpdated(page),
  /** 完整项目/模板(type=1,按更新时间倒序,分页) */
  listProjectAssets: (page) => assets.listProjectAssets(page),
  /** 本地收藏列表 */
  listFavorites: () => assets.listFavorites(),
  /** 收藏/取消收藏 */
  toggleFavorite: (asset) => assets.toggleFavorite(asset),
  /** 是否已收藏 */
  isFavorite: (assetId) => assets.isFavorite(assetId),
  /** 批量获取资产最新 release 信息(版本/兼容 Godot 版本/发布日期) */
  getReleaseInfos: (assetIds) => assets.getReleaseInfos(assetIds),
  /** 列出资产全部 release(版本选择用) */
  listAssetReleases: (assetId) => assets.listAssetReleases(assetId),
  /** 验证 Asset Store API Key */
  verifyApiKey: (key) => assets.verifyApiKey(key),
  /** 列出项目已安装插件 */
  listAddons: (projectId) => assets.listAddons(projectId),
  /** 资产详情(含媒体/许可/评分等扩展字段,详情弹层用) */
  getAssetDetail: (assetId, version) => assets.getAssetDetail(assetId, version),
  /** 安装预览:预下载并归纳安装计划(确认后凭 stageId 安装,复用已下载的包) */
  previewAssetInstall: (opts, onProgress) => assets.previewAssetInstall(opts, onProgress),
  /** 取消进行中的预览下载(幂等;无在途下载时空操作) */
  cancelAssetPreview: (assetId) => assets.cancelAssetPreview(assetId),
  /** 释放预览暂存的安装包(取消确认时调用;幂等) */
  cancelStagedAsset: (stageId) => assets.cancelStagedAsset(stageId),
  /** 安装市场资产(version 指定 release 版本,缺省为最新;含 plugin.cfg 走插件链路,否则按纯素材落项目根) */
  installAsset: (opts, onProgress) => assets.installAsset(opts, onProgress),
  /** 把完整项目/模板另存为独立项目(解压到 destRoot 下的 slug 子目录并登记) */
  saveAssetAsProject: (opts, onProgress) => assets.saveAssetAsProject(opts, onProgress),
  /** 仅下载资产 zip 到指定目录(不安装、不写记录;重名自动加序号) */
  downloadAssetZip: (opts, onProgress) => assets.downloadAssetZip(opts, onProgress),
  /** 更新资产(覆盖安装;素材先按旧清单清理再安装) */
  updateAsset: (opts, onProgress) => assets.updateAsset(opts, onProgress),
  /** 检查插件更新 */
  checkAddonUpdate: (opts) => assets.checkAddonUpdate(opts),
  /** 卸载插件或素材(市场素材传 assetId 按安装清单删除) */
  uninstallAddon: (opts) => assets.uninstallAddon(opts),
  /** 启用/禁用插件 */
  setAddonEnabled: (opts) => assets.setAddonEnabled(opts),
  /** ---------- 引擎文档库 ---------- */
  /** 生成版本文档库(入队,进度走 watchDocsTasks,任务 kind='docs';在途时拒绝重复)。
   *  opts.forceTranslation=true 忽略 po 磁盘缓存重新下载官方翻译 */
  docsGenerate: (versionId, opts) => docs.generateDocs(versionId, opts),
  /** 从外部 extension_api.json 导入建库(无引擎可用时的兜底;版本取 header.version_full_name) */
  docsImport: (opts) => docs.importDocsLibrary(opts),
  /** 扫描项目脚本(带 class_name 的 .gd)生成项目文档库,与引擎库同构 */
  docsScanProject: (projectId) => docs.scanProjectDocs({ projectId }),
  /** 取消文档库生成任务 */
  docsCancelTask: (id) => docs.cancelDocsTask(id),
  /** 移除已结束的文档库任务记录 */
  dismissDocsTask: (id) => docs.dismissDocsTask(id),
  /** 订阅文档库任务快照,返回取消订阅函数 */
  watchDocsTasks: (fn) => docs.watchDocsTasks(fn),
  /** 文档库状态(ready=已生成 / building=生成中 / null=未生成) */
  docsLibraryStatus: (versionId) => docs.docsLibraryStatus(versionId),
  /** 删除文档库(目录+db 记录;收藏/历史为全局,保留) */
  docsDeleteLibrary: (versionId) => docs.docsDeleteLibrary(versionId),
  /** 类列表(来自索引;未生成时 ok=false) */
  docsListClasses: (versionId) => docs.docsListClasses(versionId),
  /** 类正文(未知类/非法类名返回 null) */
  docsGetClass: (versionId, className) => docs.docsGetClass(versionId, className),
  /** 类附加信息(教程链接):缓存命中直接返回,否则按需拉官方 XML;离线/失败返回 null */
  docsGetClassExtras: (versionId, className) => docs.docsGetClassExtras(versionId, className),
  /** 本地搜索:类名/方法/成员/信号/枚举/常量,按分值排序 */
  docsSearch: (versionId, query, limit) => docs.docsSearch(versionId, query, limit),
  /** 描述正文检索(懒加载整库正文并缓存;返回按命中次数排序的类,附片段) */
  docsSearchFullText: (versionId, query, limit) => docs.docsSearchFullText(versionId, query, limit),
  /** 库级差异汇总(新增/移除/有变化的类;两库都需已生成) */
  docsDiffLibraries: (versionA, versionB) => docs.docsDiffLibraries(versionA, versionB),
  /** 单类在两库之间的成员级差异 */
  docsDiffClass: (versionA, versionB, className) => docs.docsDiffClass(versionA, versionB, className),
  /** 收藏/取消收藏(全局,按类名跨版本) */
  docsToggleFavorite: (className, fav) => docs.docsToggleFavorite(className, fav),
  /** 收藏列表 */
  docsListFavorites: () => docs.docsListFavorites(),
  /** 最近浏览(最新在前,上限 30) */
  docsListHistory: () => docs.docsListHistory(),
  /** 记录一次浏览(去重置顶) */
  docsPushHistory: (className) => docs.docsPushHistory(className),
  /** 文档库缓存统计(设置页清理用) */
  docsCacheInfo: () => docs.docsCacheInfo(),
  /** 清理文档库缓存(versionIds 省略时清全部;收藏/历史不受影响) */
  docsCleanCache: (versionIds) => docs.docsCleanCache(versionIds)
}
