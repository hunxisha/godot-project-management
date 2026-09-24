// 文件系统工具:备份、项目与解压模块共用。
//
// 关键约束:preload 环境的 fs.promises 不完整(无 write),因此统一使用**同步 fs API**。
// 但同步长循环会独占事件循环 —— 由于 preload 与渲染层同线程,这会让整个插件界面冻结
// (进度不刷新、取消按钮点不动)。因此所有遍历/复制/打包循环都必须通过 forEachSliced()
// 周期性让出事件循环。
const fs = require('node:fs')
const path = require('node:path')

/** 每处理 N 个文件让出一次事件循环 */
const SLICE_FILES = 24
/** 或每 N 毫秒让出一次(取先到者),避免单个超大文件长时间不让出 */
const SLICE_MS = 30

/**
 * 让出事件循环:使渲染层得以重绘并处理取消请求。
 *
 * 环境差异(踩过坑):preload 运行在渲染进程的沙箱里,**没有 setImmediate**
 * (它是 Node 特有全局,浏览器侧不存在)。因此按可用性依次降级:
 *   1. setImmediate —— 纯 Node 环境最快;
 *   2. MessageChannel —— 浏览器/沙箱里不受 setTimeout 的 4ms 嵌套钳制;
 *   3. setTimeout(0) —— 兜底,任何环境都有。
 * 直接写 setImmediate 会在 ZTools 里抛 "setImmediate is not defined"。
 */
let channel = null
const pendingYields = []

/** 惰性创建 MessageChannel:Node 下走 setImmediate 分支时不必创建 */
function getChannel() {
  if (channel) return channel
  if (typeof MessageChannel !== 'function') return null
  channel = new MessageChannel()
  channel.port1.onmessage = () => {
    const resolve = pendingYields.shift()
    if (resolve) resolve()
  }
  channel.port1.start()
  // 刻意不调用 unref():这个端口在需要它的环境里正是维持调度的句柄。
  // 渲染进程的事件循环不会「因为没有待处理任务而退出」,所以不存在泄漏问题;
  // 反过来 unref 会让纯 Node 宿主在等待让出时提前退出。
  return channel
}

function yieldToLoop() {
  if (typeof setImmediate === 'function') {
    return new Promise((resolve) => setImmediate(resolve))
  }
  const ch = getChannel()
  if (ch) {
    return new Promise((resolve) => {
      // 用队列而非单个变量:并发任务同时让出时不会互相覆盖回调
      pendingYields.push(resolve)
      ch.port2.postMessage(0)
    })
  }
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** 取消信号(被取消时抛出,由调用方转为 canceled 终态) */
class CanceledError extends Error {
  constructor(message) {
    super(message || '已取消')
    this.name = 'CanceledError'
    this.canceled = true
  }
}

/**
 * 取消令牌。
 * lock() 之后不再响应取消 —— 用于「已进入不可回滚阶段」(如覆盖恢复替换原目录之后)。
 */
function createCancelToken() {
  const token = {
    canceled: false,
    locked: false,
    cancel() {
      if (token.locked) return false
      token.canceled = true
      return true
    },
    lock() {
      token.locked = true
      token.canceled = false
    },
    isCanceled() {
      return token.canceled
    }
  }
  return token
}

/** 若已取消则抛 CanceledError */
function checkCancel(token) {
  if (token && token.canceled) throw new CanceledError()
}

/**
 * 分片遍历:逐个交给 handler,周期性让出事件循环并检查取消。
 * @param {any[]} items
 * @param {(item:any, index:number) => void} handler
 * @param {{token?:object, sliceFiles?:number, sliceMs?:number}} [opts]
 */
async function forEachSliced(items, handler, opts) {
  const o = opts || {}
  const sliceFiles = o.sliceFiles || SLICE_FILES
  const sliceMs = o.sliceMs || SLICE_MS
  const total = items.length
  let sliceStart = Date.now()
  for (let i = 0; i < total; i++) {
    handler(items[i], i)
    const last = i === total - 1
    if (!last && (i % sliceFiles === sliceFiles - 1 || Date.now() - sliceStart > sliceMs)) {
      await yieldToLoop()
      checkCancel(o.token)
      sliceStart = Date.now()
    }
  }
}

/** Windows 非法文件名字符过滤 */
function sanitizeName(s) {
  return String(s || '').replace(/[\\/:*?"<>|]/g, '_').trim() || 'project'
}

/** 时间戳片段 YYYYMMDD_HHmm */
function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`
}

/** 精确到秒的时间戳片段 YYYYMMDD_HHmm_ss(避免同分钟重复备份互相覆盖) */
function stampSec() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${stamp()}_${String(d.getSeconds()).padStart(2, '0')}`
}

/** 目标路径已存在时追加 _2 / _3 …,直到不冲突 */
function uniquePath(target) {
  if (!fs.existsSync(target)) return target
  const ext = path.extname(target)
  const base = ext ? target.slice(0, -ext.length) : target
  for (let i = 2; i < 1000; i++) {
    const next = `${base}_${i}${ext}`
    if (!fs.existsSync(next)) return next
  }
  return `${base}_${Date.now()}${ext}`
}

/** 移入回收站(Windows)/永久删除(其他平台) */
function trashPath(p, isDir) {
  if (process.platform === 'win32') {
    const method = isDir ? 'DeleteDirectory' : 'DeleteFile'
    const ps =
      'Add-Type -AssemblyName Microsoft.VisualBasic; ' +
      `[Microsoft.VisualBasic.FileIO.FileSystem]::${method}(${JSON.stringify(p)}, 'OnlyErrorDialogs', 'SendToRecycleBin')`
    require('node:child_process').execSync(
      `powershell.exe -NoProfile -Command ${JSON.stringify(ps)}`,
      { stdio: 'ignore' }
    )
  } else if (isDir) {
    fs.rmSync(p, { recursive: true, force: true })
  } else {
    fs.unlinkSync(p)
  }
}

/** 静默删除(用于清理临时产物,失败不抛) */
function rmQuiet(p) {
  try {
    if (p && fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true })
  } catch (e) { /* 清理失败不影响主流程 */ }
}

/**
 * 临时产物路径:与最终目标同目录,保证 rename 不跨盘、可原子替换。
 * 以 .gpm-tmp- 开头,便于用户识别与事后清理。
 */
function tempPath(destDir, taskId, isDir) {
  return path.join(destDir, `.gpm-tmp-${taskId}${isDir ? '' : '.zip'}`)
}

/**
 * 构造目录名排除器。按**目录名**在任意层级匹配(大小写不敏感)。
 * @param {string[]} [names] 如 ['.git', 'build']
 * @returns {null | ((name:string, isDir:boolean) => boolean)}
 */
function makeExcluder(names) {
  const set = new Set((names || []).filter(Boolean).map((n) => String(n).toLowerCase()))
  if (!set.size) return null
  return (name, isDir) => isDir && set.has(String(name).toLowerCase())
}

/**
 * 递归收集文件清单。
 * @param {string} srcDir
 * @param {{includeCache?:boolean, exclude?:Function}} [opts] includeCache=false 时跳过 .godot
 * @returns {{abs:string, rel:string}[]}
 */
function walkFiles(srcDir, opts) {
  const o = opts || {}
  const includeCache = o.includeCache !== false
  const exclude = o.exclude
  const files = []
  const walk = (dir, rel) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (exclude && exclude(ent.name, ent.isDirectory())) continue
      if (!includeCache && ent.isDirectory() && ent.name === '.godot') continue
      const abs = path.join(dir, ent.name)
      const relPath = rel ? rel + '/' + ent.name : ent.name
      if (ent.isDirectory()) walk(abs, relPath)
      else if (ent.isFile()) files.push({ abs, rel: relPath })
    }
  }
  walk(srcDir, '')
  return files
}

/**
 * 递归复制目录(可跳过 .godot 缓存与排除目录),分片让出 + 可取消。
 * @returns {Promise<{fileCount:number, bytes:number}>}
 */
async function copyTree(src, dest, opts) {
  const o = opts || {}
  const files = walkFiles(src, { includeCache: o.includeCache, exclude: o.exclude })
  const total = files.length
  fs.mkdirSync(dest, { recursive: true })
  let bytes = 0
  await forEachSliced(files, (f, i) => {
    const target = path.join(dest, ...f.rel.split('/'))
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(f.abs, target)
    bytes += fs.statSync(f.abs).size
    if (o.onProgress) {
      o.onProgress({
        phase: o.phase || 'copying',
        done: i + 1,
        total,
        current: f.rel,
        bytes
      })
    }
  }, { token: o.token, sliceFiles: o.sliceFiles, sliceMs: o.sliceMs })
  return { fileCount: total, bytes }
}

/**
 * 统计目录大小与文件数(用于备份前预估),分片让出 + 可取消。
 * @returns {Promise<{fileCount:number, bytes:number}>}
 */
async function estimateTree(srcDir, opts) {
  const o = opts || {}
  const files = walkFiles(srcDir, { includeCache: o.includeCache, exclude: o.exclude })
  const total = files.length
  let bytes = 0
  await forEachSliced(files, (f, i) => {
    try {
      bytes += fs.statSync(f.abs).size
    } catch (e) { /* 文件可能刚被删除,忽略 */ }
    if (o.onProgress) {
      o.onProgress({ phase: 'scanning', done: i + 1, total, current: f.rel, bytes })
    }
  }, { token: o.token, sliceFiles: o.sliceFiles, sliceMs: o.sliceMs })
  return { fileCount: total, bytes }
}

module.exports = {
  SLICE_FILES,
  SLICE_MS,
  CanceledError,
  yieldToLoop,
  createCancelToken,
  checkCancel,
  forEachSliced,
  sanitizeName,
  stamp,
  stampSec,
  uniquePath,
  trashPath,
  rmQuiet,
  tempPath,
  makeExcluder,
  walkFiles,
  copyTree,
  estimateTree
}
