// 通过 window 对象向渲染进程注入 Node 能力
// 能力模块位于 lib/ 下,按功能领域拆分
const { currentPlatform, fetchReleases } = require('./lib/releases')
const install = require('./lib/install')
const projects = require('./lib/projects')
const { launchProject } = require('./lib/launcher')
const assets = require('./lib/assets')

window.services = {
  /** 当前平台标识 */
  currentPlatform: () => currentPlatform(),
  /** 获取 GitHub 版本列表(24h 缓存) */
  fetchReleases: (force) => fetchReleases(force),
  /** 下载并安装版本(入队),返回任务 id */
  downloadAndInstall: (params, opts) => install.downloadAndInstall(params, opts),
  /** 取消下载任务 */
  cancelTask: (id) => install.cancelTask(id),
  /** 移除任务记录 */
  dismissTask: (id) => install.dismissTask(id),
  /** 订阅任务快照,返回取消订阅函数 */
  watchTasks: (fn) => install.watchTasks(fn),
  /** 导入本地引擎可执行文件 */
  importLocalExe: (exePath) => install.importLocalExe(exePath),
  /** 删除已装版本 */
  deleteVersion: (v) => install.deleteVersion(v),
  /** 添加项目(目录或 project.godot 文件) */
  addProject: (inputPath) => projects.addProject(inputPath),
  /** 递归扫描目录下的所有项目 */
  scanProjects: (rootDir) => projects.scanProjects(rootDir),
  /** 删除项目记录 */
  removeProject: (id) => projects.removeProject(id),
  /** 启动项目(editor=打开编辑器带 -e,run=直接运行) */
  launchProject: (opts) => launchProject(opts),
  /** 搜索 Asset Store */
  searchAssets: (filter, godotVersion, page) => assets.searchAssets(filter, godotVersion, page),
  /** 官方精选(推荐)Addon */
  listFeatured: () => assets.listFeatured(),
  /** 最近更新的 Addon */
  listRecentlyUpdated: (page) => assets.listRecentlyUpdated(page),
  /** 本地收藏列表 */
  listFavorites: () => assets.listFavorites(),
  /** 收藏/取消收藏 */
  toggleFavorite: (asset) => assets.toggleFavorite(asset),
  /** 是否已收藏 */
  isFavorite: (assetId) => assets.isFavorite(assetId),
  /** 我的库:全部项目的市场插件安装记录聚合 */
  listLibrary: () => assets.listLibrary(),
  /** 批量获取资产最新版本号(列表展示用) */
  getLatestVersions: (assetIds) => assets.getLatestVersions(assetIds),
  /** 验证 Asset Store API Key */
  verifyApiKey: (key) => assets.verifyApiKey(key),
  /** 列出项目已安装插件 */
  listAddons: (projectId) => assets.listAddons(projectId),
  /** 安装市场插件 */
  installAsset: (opts, onProgress) => assets.installAsset(opts, onProgress),
  /** 更新插件 */
  updateAsset: (opts, onProgress) => assets.updateAsset(opts, onProgress),
  /** 检查插件更新 */
  checkAddonUpdate: (opts) => assets.checkAddonUpdate(opts),
  /** 卸载插件 */
  uninstallAddon: (opts) => assets.uninstallAddon(opts),
  /** 启用/禁用插件 */
  setAddonEnabled: (opts) => assets.setAddonEnabled(opts)
}
