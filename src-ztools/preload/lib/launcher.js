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

    const args = ['--path', project.path]
    if (action === 'editor') args.push('-e')
    args.push(...splitLaunchArgs(project.launchArgs))
    const child = spawn(version.exePath, args, { detached: true, stdio: 'ignore' })
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
