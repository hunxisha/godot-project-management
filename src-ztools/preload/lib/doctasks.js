// 文档任务队列单例:引擎生成 / JSON 导入 / 项目扫描三个入口共用同一串行队列
// (刻意与导出/模板的队列隔离)。setTask 与任务三件套同住这里。
// 从 docs.js 拆出(2026-09-29)。
const { createTaskQueue, TERMINAL_PHASES } = require('./taskqueue')

const tasks = createTaskQueue({
  serial: true,
  makeId: () => `docs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
  // phaseField 指向 status(与 ExportTask 同名同义),终态集合启用「仅终态可 dismiss」
  terminalPhases: TERMINAL_PHASES,
  phaseField: 'status'
})

/**
 * 更新任务字段(任务已被移除时静默跳过)。
 * @param {string} id
 * @param {Record<string, any>} patch
 */
function setTask(id, patch) {
  tasks.patch(tasks.get(id), patch)
}

// ---------- 任务三件套 ----------

/**
 * 取消生成任务(排队中直接取消;dumping 中 kill 子进程)。
 * @param {string} id
 */
function cancelDocsTask(id) {
  const t = tasks.get(id)
  if (!t) return
  if (tasks.isTerminal(t.status)) return
  const handle = tasks.tokenOf(id)
  if (handle) handle.cancel()
  setTask(id, { status: 'canceled' })
}

/**
 * 移除任务记录(仅终态可移除)。
 * @param {string} id
 */
function dismissDocsTask(id) {
  tasks.dismiss(id)
}

/**
 * 订阅任务快照,返回取消订阅函数。
 * @param {(t: any[]) => void} fn
 * @returns {() => void}
 */
function watchDocsTasks(fn) {
  return tasks.watch(fn)
}

module.exports = { tasks, setTask, cancelDocsTask, dismissDocsTask, watchDocsTasks }
