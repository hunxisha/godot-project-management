// 桌面版 preload:① 挂 window.ztools 垫片 ② 原样加载 ZTools 插件的能力层(services.js)。
// 顺序不可颠倒:services.js 的 lib 模块(store.js 等)在调用期就要访问 window.ztools.db。

const { ipcRenderer, shell } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { createDb } = require('./dbdoc')
const { buildZtoolsShim } = require('./ztshim')

// 主进程经 webPreferences.additionalArguments 注入 userData 基点(preload 里拿不到 app 模块)
const DATA_ARG = '--ztools-user-data='
const dataArg = process.argv.find((a) => a.startsWith(DATA_ARG))
const userData = dataArg
  ? dataArg.slice(DATA_ARG.length)
  : process.env.APPDATA || process.env.HOME || '.'

window.ztools = buildZtoolsShim({
  ipcRenderer,
  shell,
  db: createDb(path.join(userData, 'godot-workshop', 'db.json'))
})

// 双布局:打包后能力层被 sync-vendor 复制到 desktop/vendor/preload,开发态直连 src-ztools
const vendorServices = path.join(__dirname, '../vendor/preload/services.js')
require(fs.existsSync(vendorServices)
  ? vendorServices
  : path.join(__dirname, '../../src-ztools/preload/services.js'))
