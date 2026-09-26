// 一键导出:解析项目的 export_presets.cfg → 调用引擎 CLI(--headless --export-release / --export-pack)。
//
// 导出是长任务:走独立的串行任务队列(phase: queued/exporting/done/error/canceled),
// 引擎 stdout 尾部保留在任务上,失败时可直接看到原因;取消通过 kill 子进程实现。
// 导出前做模板预检:headless 导出在没有对应版本导出模板时必然失败,提前拦截并告知补救入口。
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { getDoc } = require('./store')
const { ensureDir } = require('./extract')
const { createTaskQueue } = require('./taskqueue')
const { exportTemplateStatus } = require('./templates')

const tasks = createTaskQueue({
  serial: true,
  makeId: () => `exp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
})

/**
 * 更新任务字段(任务已被移除时静默跳过)。
 * @param {string} id
 * @param {Record<string, any>} patch
 */
function setTask(id, patch) {
  tasks.patch(tasks.get(id), patch)
}

/** 任务上保留的引擎输出行数上限(只留尾部,失败诊断用) */
const LOG_TAIL = 40

/**
 * 解析 export_presets.cfg 的顶层预设字段。
 * 文件是 Godot 的扁平 section 格式:[preset.N] 下是 name/platform/export_path 等键,
 * 其后的 [preset.N.options] 等子 section 属于平台细节,不采集。
 * @param {string} text
 * @returns {{index: number, name: string, platform: string, exportPath: string}[]}
 */
function parseExportPresets(text) {
  /** @type {Map<number, Record<string, string>>} */
  const rows = new Map()
  let index = -1
  let inPreset = false
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith(';')) continue
    const sec = /^\[preset\.(\d+)\]$/.exec(line)
    if (sec) {
      index = Number(sec[1])
      inPreset = true
      if (!rows.has(index)) rows.set(index, {})
      continue
    }
    if (line.startsWith('[')) {
      inPreset = false
      continue
    }
    if (!inPreset) continue
    const kv = /^([A-Za-z_]\w*)\s*=\s*(.*)$/.exec(line)
    if (!kv) continue
    const fields = rows.get(index)
    if (fields) fields[kv[1]] = kv[2].replace(/^"(.*)"$/, '$1')
  }
  /** @type {{index: number, name: string, platform: string, exportPath: string}[]} */
  const out = []
  for (const [i, f] of rows) {
    if (!f.name) continue
    out.push({ index: i, name: f.name, platform: f.platform || '', exportPath: f.export_path || '' })
  }
  out.sort((a, b) => a.index - b.index)
  return out
}

/**
 * 列出项目的导出预设。
 * @param {string} projectId
 * @returns {{ok: boolean, error?: string, presets?: {index: number, name: string, platform: string, exportPath: string}[]}}
 */
function listExportPresets(projectId) {
  const project = getDoc(projectId)
  if (!project) return { ok: false, error: '项目不存在' }
  const file = path.join(project.path, 'export_presets.cfg')
  if (!fs.existsSync(file)) return { ok: true, presets: [] }
  try {
    return { ok: true, presets: parseExportPresets(fs.readFileSync(file, 'utf8')) }
  } catch (e) {
    return { ok: false, error: (e && e.message) || '解析 export_presets.cfg 失败' }
  }
}

/**
 * 发起导出(入队,立即返回任务 id)。
 * 输出路径缺省取预设的 export_path(相对项目根);结尾 .pck/.zip 走 --export-pack,其余 --export-release。
 * @param {{projectId: string, presetName: string, outputPath?: string}} params
 * @returns {{ok: boolean, error?: string, taskId?: string, missingTemplates?: boolean}}
 */
function runExport(params) {
  const project = getDoc(params.projectId)
  if (!project) return { ok: false, error: '项目不存在' }
  const version = project.versionId ? getDoc(project.versionId) : null
  if (!version || !version.exePath) {
    return { ok: false, error: '未绑定可用的 Godot 引擎,请先在「版本」页安装或绑定' }
  }
  if (!fs.existsSync(version.exePath)) return { ok: false, error: '绑定的引擎可执行文件不存在' }

  // 模板预检:headless 导出没有对应版本模板时必然失败,提前拦截
  const tpl = exportTemplateStatus({ versionId: version.id })
  if (!tpl.installed) {
    return {
      ok: false,
      missingTemplates: true,
      error: `尚未安装 ${version.tag} 的导出模板,请先获取模板再导出`
    }
  }

  const listed = listExportPresets(params.projectId)
  if (!listed.ok) return { ok: false, error: listed.error }
  const preset = (listed.presets || []).find((p) => p.name === params.presetName)
  if (!preset) return { ok: false, error: '未找到导出预设: ' + params.presetName }

  const outputPath = params.outputPath
    ? path.resolve(params.outputPath)
    : preset.exportPath
      ? path.join(project.path, ...preset.exportPath.replace(/\\/g, '/').split('/'))
      : ''
  if (!outputPath) return { ok: false, error: '预设未配置导出路径' }
  const mode = /\.(pck|zip)$/i.test(outputPath) ? 'export-pack' : 'export-release'

  const task = tasks.create({
    kind: 'export',
    projectId: params.projectId,
    projectName: project.name,
    presetName: preset.name,
    outputPath,
    mode,
    exePath: version.exePath,
    status: 'queued',
    log: ''
  })
  const id = task.id
  tasks.emit()

  const job = () => new Promise((resolve) => {
    if (!tasks.get(id) || tasks.get(id).status === 'canceled') return resolve()
    try {
      ensureDir(path.dirname(outputPath))
    } catch (e) { /* 输出目录创建失败交给导出进程报错 */ }

    setTask(id, { status: 'exporting' })
    const args = ['--headless', '--path', project.path, `--${mode}`, preset.name, outputPath]
    /** @type {string[]} 输出尾部环形缓冲 */
    const tail = []
    let canceled = false
    const child = spawn(version.exePath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    tasks.setToken(id, {
      cancel: () => {
        canceled = true
        try { child.kill() } catch (e) { /* ignore */ }
      }
    })
    /** @param {any} buf */
    const onChunk = (buf) => {
      for (const line of String(buf).split(/\r?\n/)) {
        if (!line.trim()) continue
        tail.push(line)
        if (tail.length > LOG_TAIL) tail.shift()
      }
      setTask(id, { log: tail.join('\n') })
    }
    if (child.stdout) child.stdout.on('data', onChunk)
    if (child.stderr) child.stderr.on('data', onChunk)
    child.on('error', (e) => {
      if (!canceled) setTask(id, { status: 'error', error: '启动引擎失败: ' + e.message })
      resolve()
    })
    child.on('close', (code) => {
      if (canceled) {
        setTask(id, { status: 'canceled' })
      } else if (code === 0) {
        setTask(id, { status: 'done' })
      } else {
        setTask(id, { status: 'error', error: `导出失败(退出码 ${code})` })
      }
      resolve()
    })
  })

  tasks.enqueue(job)
  return { ok: true, taskId: id }
}

/**
 * 取消导出(排队中直接取消;导出中 kill 子进程)。
 * @param {string} id
 */
function cancelExportTask(id) {
  const t = tasks.get(id)
  if (!t) return
  if (['done', 'error', 'canceled'].includes(t.status)) return
  const handle = tasks.tokenOf(id)
  if (handle) handle.cancel()
  setTask(id, { status: 'canceled' })
}

/**
 * 移除任务记录。
 * @param {string} id
 */
function dismissExportTask(id) {
  tasks.dismiss(id)
}

/**
 * 订阅任务快照,返回取消订阅函数。
 * @param {(t: unknown[]) => void} fn
 * @returns {() => void}
 */
function watchExportTasks(fn) {
  return tasks.watch(fn)
}

module.exports = {
  parseExportPresets,
  listExportPresets,
  runExport,
  cancelExportTask,
  dismissExportTask,
  watchExportTasks
}
