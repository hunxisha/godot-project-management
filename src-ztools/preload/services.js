// 通过 window 对象向渲染进程注入 Node 能力
// 能力模块位于 lib/ 下,按功能领域拆分
const { currentPlatform, fetchReleases } = require('./lib/releases')
const install = require('./lib/install')

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
  deleteVersion: (v) => install.deleteVersion(v)
}
