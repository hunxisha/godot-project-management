// 桌面版主进程:窗口、垫片所需的 IPC(dialog/notification/主题/窗口隐藏)、单实例锁。
// 渲染层与能力层零改动复用:窗口加载与 ZTools 插件同一份构建产物(src-ztools/dist)。

const { app, BrowserWindow, ipcMain, dialog, nativeTheme, Notification } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

// 双布局:打包后走 desktop/renderer(sync-vendor 同步),仓库开发态直接用 src-ztools/dist
function resolveDistIndex() {
  const packaged = path.join(__dirname, '../renderer/index.html')
  if (fs.existsSync(packaged)) return packaged
  return path.join(__dirname, '../../src-ztools/dist/index.html')
}

const DIST_INDEX = resolveDistIndex()
const SMOKE = process.argv.includes('--ztools-smoke')

// 冒烟模式用独立临时 userData,不污染真实库
if (SMOKE) {
  const os = require('node:os')
  app.setPath('userData', path.join(os.tmpdir(), 'gpm-desktop-smoke'))
}

let win = null

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    title: 'Godot 工坊',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      // 与 ZTools 宿主同构:preload 有 Node、渲染层无 Node、共享 window ——
      // services.js / store.js 直接引用 window.ztools 能零改动工作的前提
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
      additionalArguments: [`--ztools-user-data=${app.getPath('userData')}`]
    }
  })
  win.loadFile(DIST_INDEX)
  win.on('closed', () => { win = null })
  if (SMOKE) runSmoke()
}

// ---------- 垫片依赖的 IPC(全部在窗口创建前注册) ----------

ipcMain.on('ztools:is-dark', (e) => { e.returnValue = nativeTheme.shouldUseDarkColors })

ipcMain.on('ztools:show-open-dialog', (e, opts) => {
  e.returnValue = dialog.showOpenDialogSync(BrowserWindow.fromWebContents(e.sender), opts)
})

ipcMain.on('ztools:notification', (_e, body) => {
  if (Notification.isSupported()) new Notification({ title: 'Godot 工坊', body }).show()
})

ipcMain.on('ztools:hide-main-window', (e) => {
  BrowserWindow.fromWebContents(e.sender)?.close()
})

// 主进程 → 渲染层的进入事件(.godot 文件关联等,后续版本接入;预留转发通道)
function sendPluginEnter(code, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send('ztools:plugin-enter', { code, payload })
  }
}

// ---------- 冒烟自检:页面加载后校验垫片/能力层/挂载,SMOKE 日志行以 JSON 输出 ----------

function runSmoke() {
  const consoleErrors = []
  win.webContents.on('console-message', (...args) => {
    // Electron 各版本签名不一:event, level, message[, line, sourceId] 或 event, {level, message}
    const second = args[1]
    const level = typeof second === 'object' && second !== null ? second.level : second
    const message = typeof second === 'object' && second !== null ? second.message : args[2]
    const isError = (typeof level === 'number' && level >= 3) || level === 'error'
    if (isError && message && !/favicon|net::ERR/.test(String(message))) {
      consoleErrors.push(String(message))
    }
  })
  win.webContents.on('did-finish-load', () => {
    setTimeout(() => {
      win.webContents
        .executeJavaScript(`(() => {
          const z = window.ztools
          const s = window.services
          let methodCount = 0
          if (s && typeof s === 'object') for (const k of Object.keys(s)) if (typeof s[k] === 'function') methodCount++
          // 关键方法在位抽查(横跨各域);方法总数只设下限 —— 硬编码精确值曾因注释漂移(61→91)误报
          const probes = ['fetchReleases', 'downloadAndInstall', 'watchTasks', 'backupProject', 'installAsset', 'docsGenerate']
          const missing = probes.filter((k) => typeof (s || {})[k] !== 'function')
          let dbOk = false
          try {
            const probe = '_smoke_' + Date.now()
            dbOk = z.db.put({ _id: probe, v: 1 }).ok === true
              && z.db.get(probe).v === 1
              && z.db.remove(z.db.get(probe)).ok === true
          } catch (e) { dbOk = false }
          const appEl = document.querySelector('#app')
          return {
            hasZtools: !!z && typeof z === 'object',
            hasServices: !!s && typeof s === 'object',
            methodCount,
            missing,
            dbOk,
            mounted: !!appEl && appEl.children.length > 0
          }
        })()`)
        .then((r) => {
          const pass = r.hasZtools && r.hasServices && r.methodCount >= 80 && r.missing.length === 0 && r.dbOk && r.mounted && consoleErrors.length === 0
          console.log(`[SMOKE] ${JSON.stringify({ ...r, consoleErrors })}`)
          app.exit(pass ? 0 : 1)
        })
        .catch((e) => {
          console.log(`[SMOKE] {"error":${JSON.stringify(String(e))}}`)
          app.exit(1)
        })
    }, 1500)
  })
}

// ---------- 单实例 + 启动 ----------

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  })

  app.whenReady().then(() => {
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
