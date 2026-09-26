// 通过 window 对象向渲染进程注入 Node 能力
// 能力模块位于 lib/ 下,按功能领域拆分
//
// 下面的 @type 引用渲染层的类型契约(src/types/services.ts) —— 它是**唯一权威**:
// 这份对象必须不多不少地实现 Services 的 47 个方法,少一个、多一个、签名不对都会编译失败。
// 这取代了原先「两处手写 + 一个比对测试」的做法(见 docs/optimization-plan.md 的 P0-2)。
const { currentPlatform, fetchReleases } = require('./lib/releases')
const install = require('./lib/install')
const projects = require('./lib/projects')
const backup = require('./lib/backup')
const { launchProject } = require('./lib/launcher')
const assets = require('./lib/assets')
const templates = require('./lib/templates')

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
  /** 删除已装版本 */
  deleteVersion: (v) => install.deleteVersion(v),
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
  /** 安装预览:预下载并归纳安装计划(确认后凭 stageId 安装,复用已下载的包) */
  previewAssetInstall: (opts, onProgress) => assets.previewAssetInstall(opts, onProgress),
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
  setAddonEnabled: (opts) => assets.setAddonEnabled(opts)
}
