// 桌面版的窗口策略。
//
// 单独成文件是为了能单测:主进程入口 index.js 一 require 就要拉起 electron 的 app,
// 没法在 node 里跑;而这两个策略恰是「启动项目后软件关闭」那个缺陷的成因,
// 必须有护栏钉住 —— 否则改回 close() 就能复现线上问题而无人察觉。

/**
 * 「隐藏主窗口」在桌面宿主里的等价动作 = 最小化。
 *
 * ZTools 宿主里 hideMainWindow 是让插件窗口让位给刚启动的 Godot 编辑器(宿主常驻托盘)。
 * 桌面版若照 Electron 字面语义 close():唯一窗口一关就触发 window-all-closed → app.quit(),
 * 用户看到的是「点了启动项目,软件自己关了」;而 v1.0 没有托盘,关掉就再也找不回来。
 * 最小化既保留了「让位」的原意,又随时可从任务栏/程序坞取回。
 *
 * @param {{ isDestroyed?: () => boolean, minimize: () => void } | null} win
 * @returns {boolean} 是否执行了最小化
 */
function hideMainWindow(win) {
  if (!win) return false
  if (typeof win.isDestroyed === 'function' && win.isDestroyed()) return false
  win.minimize()
  return true
}

/**
 * 关掉最后一个窗口时是否退出应用(macOS 留在程序坞,与平台惯例一致)。
 * @param {string} platform process.platform
 * @returns {boolean}
 */
function shouldQuitOnAllWindowsClosed(platform) {
  return platform !== 'darwin'
}

module.exports = { hideMainWindow, shouldQuitOnAllWindowsClosed }
