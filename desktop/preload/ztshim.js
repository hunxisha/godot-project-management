// 桌面版 window.ztools 垫片:把 ZTools 宿主 API 映射到 Electron 等价物。
// 依赖面来自全库 grep(docs/desktop-app-plan.md §2.2):db 四方法 + 14 个杂项方法,
// 渲染层与能力层对宿主的引用只有 window.ztools 这一个全局对象 —— 本模块挂好后
// require src-ztools/preload/services.js 即可原样复用整个能力层。

function buildZtoolsShim({ ipcRenderer, shell, db }) {
  let enterCb = null
  // 首个进入事件在垫片内合成:插件宿主由 onPluginEnter 驱动首页,
  // 桌面版启动即落在概览页;后续真实事件(如 .godot 文件关联)由主进程经 IPC 转发
  let pendingEnter = { code: 'godot', payload: '' }
  ipcRenderer.on('ztools:plugin-enter', (_e, ev) => {
    if (enterCb) setTimeout(() => enterCb(ev), 0)
    else pendingEnter = ev
  })

  return {
    /** 桌面版特性开关(渲染层据此分流,ZTools 宿主上为 undefined) */
    isDesktop: true,

    db: {
      get: (id) => db.get(id),
      put: (doc) => db.put(doc),
      remove: (doc) => db.remove(doc),
      allDocs: (prefix) => db.allDocs(prefix)
    },

    isWindows: () => process.platform === 'win32',
    isMacOS: () => process.platform === 'darwin',
    isLinux: () => process.platform !== 'win32' && process.platform !== 'darwin',
    // nativeTheme 是主进程模块,同步 IPC 取即时值(bridge.ts 的 isDark 为同步调用)
    isDarkColors: () => ipcRenderer.sendSync('ztools:is-dark'),

    showNotification: (body) => ipcRenderer.send('ztools:notification', String(body ?? '')),

    // ZTools 的 showOpenDialog 同步返回路径数组;Electron 的同步版本经 sendSync 对齐
    showOpenDialog: (opts) => ipcRenderer.sendSync('ztools:show-open-dialog', opts),

    shellOpenExternal: (url) => { shell.openExternal(url) },
    shellOpenPath: (p) => { shell.openPath(p) },
    shellShowItemInFolder: (p) => { shell.showItemInFolder(p) },

    onPluginEnter: (cb) => {
      enterCb = cb
      const ev = pendingEnter
      pendingEnter = null
      if (ev) setTimeout(() => cb(ev), 0)
    },

    // 桌面版项目页用内嵌搜索框(isDesktop 分流)替代子输入栏
    setSubInput: () => true,
    removeSubInput: () => {},

    // 桌面窗口尺寸自管,展开高度无意义
    setExpendHeight: () => {},

    // v1.0 无托盘:关窗即退出(macOS 留在程序坞);托盘常驻落地后改为 win.hide()
    hideMainWindow: () => ipcRenderer.send('ztools:hide-main-window')
  }
}

module.exports = { buildZtoolsShim }
