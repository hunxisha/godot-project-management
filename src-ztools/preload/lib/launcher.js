// 启动 Godot:打开项目编辑器 / 运行项目(支持项目级自定义启动参数)
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const { getDoc, putDoc } = require('./store')

/**
 * 拆分启动参数:双引号内的空白属于同一个参数;引号本身不保留。
 * "a b" c → ['a b', 'c'];空串 → []。
 * @param {string} [input]
 * @returns {string[]}
 */
function splitLaunchArgs(input) {
  /** @type {string[]} */
  const out = []
  let cur = ''
  let has = false
  let quote = false
  for (const ch of String(input || '')) {
    if (ch === '"') {
      has = true
      quote = !quote
      continue
    }
    if (!quote && /\s/.test(ch)) {
      if (has || cur) {
        out.push(cur)
        cur = ''
        has = false
      }
      continue
    }
    cur += ch
  }
  if (has || cur) out.push(cur)
  return out
}

/**
 * 启动项目。
 * @param {{ projectId: string, action: 'editor' | 'run' }} opts
 * 返回 { ok, error?, project? };成功后更新 lastOpenedAt/openCount。
 */
function launchProject({ projectId, action }) {
  try {
    const project = getDoc(projectId)
    if (!project) return { ok: false, error: '项目不存在' }
    if (!fs.existsSync(project.path)) return { ok: false, error: '项目目录不存在' }
    const version = project.versionId ? getDoc(project.versionId) : null
    if (!version || !fs.existsSync(version.exePath)) {
      return { ok: false, error: '未绑定可用的 Godot 引擎,请先在「版本」页安装或绑定' }
    }

    // Linux/macOS 上解压出来的引擎在部分文件系统(或被解压器丢位)会缺执行位。
    // 这时 spawn 报 EACCES,而 'error' 是**异步**事件:没有监听者就是未捕获异常,
    // 宿主进程直接退出 —— 桌面版上表现为「点启动,软件就关了」。先补位再前置校验。
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(version.exePath, 0o755)
      } catch (e) { /* ignore */ }
      /** 补位后仍没有任何执行位(0o111)—— 再 spawn 只会换回 EACCES,而它的报错是异步的 */
      let executable = false
      try {
        executable = (fs.statSync(version.exePath).mode & 0o111) !== 0
      } catch (e) {
        executable = false
      }
      if (!executable) {
        return { ok: false, error: '引擎文件不可用(缺少执行权限或已被移动),请删除该版本后重新下载' }
      }
    }

    const args = ['--path', project.path]
    if (action === 'editor') args.push('-e')
    args.push(...splitLaunchArgs(project.launchArgs))
    const child = spawn(version.exePath, args, { detached: true, stdio: 'ignore' })
    // 兜底:spawn 的失败晚于本函数返回,只能在这里接住。吞掉是为了不让宿主陪葬,
    // 但要让用户看见,否则「点了没反应」同样无从排查。
    child.on('error', (e) => {
      const msg = (e && e.message) || '未知错误'
      console.error('[godot-workshop] 启动 Godot 失败:', msg)
      try {
        const host = typeof window !== 'undefined' ? window.ztools : null
        host && typeof host.showNotification === 'function' && host.showNotification(`启动 Godot 失败:${msg}`)
      } catch (err) { /* 通知失败不影响其它功能 */ }
    })
    child.unref()

    const updated = {
      ...project,
      lastOpenedAt: Date.now(),
      openCount: (project.openCount || 0) + 1
    }
    putDoc(projectId, updated)
    return { ok: true, project: { ...updated, _id: projectId } }
  } catch (e) {
    return { ok: false, error: (e && e.message) || '启动失败' }
  }
}

module.exports = { launchProject, splitLaunchArgs }
