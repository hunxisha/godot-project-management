// 项目管理:解析 project.godot、添加/扫描项目、自动绑定引擎版本
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { getDoc, putDoc, removeDoc, listDocs } = require('./store')

const IGNORE_DIRS = new Set(['.git', '.godot', 'node_modules', '.import', 'build', 'dist', 'addons'])

/**
 * 解析 project.godot(Godot 配置为 INI 风格,含 PackedStringArray 值)。
 * 返回 { name, configVersion, engineVersion?, icon?, hasPlugins }
 */
function parseProjectGodot(rootDir) {
  const file = path.join(rootDir, 'project.godot')
  const text = fs.readFileSync(file, 'utf8')

  let section = ''
  let name = ''
  let icon
  let configVersion = 0
  let engineVersion
  let hasPlugins = false

  for (const line of text.split(/\r?\n/)) {
    const sec = /^\s*\[(.+)\]\s*$/.exec(line)
    if (sec) {
      section = sec[1]
      continue
    }
    const kv = /^\s*([\w./]+)\s*=\s*(.*)$/.exec(line)
    if (!kv) continue
    const [, key, raw] = kv
    const value = raw.replace(/,\s*$/, '')

    if (key === 'config_version') {
      configVersion = parseInt(value, 10) || 0
    } else if (key === 'config/name') {
      name = unquote(value)
    } else if (key === 'config/icon') {
      icon = unquote(value)
    } else if (key === 'config/features') {
      const m = /"([^"]+)"/.exec(value)
      if (m) engineVersion = m[1]
    } else if (key === 'enabled' && section === 'editor_plugins') {
      if (/"[^"]*"/.test(value)) hasPlugins = true
    }
  }

  return { name: name || path.basename(rootDir), configVersion, engineVersion, icon, hasPlugins }
}

function unquote(v) {
  const m = /^"(.*)"$/.exec(v.trim())
  return m ? m[1] : v.trim()
}

/** 项目根目录:输入可能是项目目录,也可能是 project.godot 文件本身 */
function resolveProjectRoot(inputPath) {
  const stat = fs.statSync(inputPath)
  if (stat.isFile()) return path.dirname(inputPath)
  return inputPath
}

/** 项目文档 id(路径 md5) */
function projectDocId(rootDir) {
  const abs = path.resolve(rootDir)
  const hash = crypto.createHash('md5').update(abs).digest('hex')
  return `godot/project/${hash}`
}

/** 为项目自动选择引擎版本:engineVersion major.minor → config_version 兜底 */
function matchVersion(project) {
  const versions = listDocs('godot/version/')
  if (!versions.length) return undefined

  const wanted = project.engineVersion ? project.engineVersion.split('.').slice(0, 2).join('.') : ''
  let pool = []
  if (wanted) {
    pool = versions.filter((v) => v.tag && v.tag.startsWith(wanted + '.') || v.tag === wanted || v.tag.startsWith(wanted + '-'))
  }
  if (!pool.length) {
    // config_version: 5=4.x, 4=3.x
    const major = project.configVersion >= 5 ? '4' : '3'
    pool = versions.filter((v) => v.tag && v.tag.startsWith(major + '.'))
  }
  if (!pool.length) return undefined
  // 同版本号优先标准版
  pool.sort((a, b) => {
    const va = a.variant === 'standard' ? 0 : 1
    const vb = b.variant === 'standard' ? 0 : 1
    if (va !== vb) return va - vb
    return (b.installedAt || 0) - (a.installedAt || 0)
  })
  return pool[0].id
}

/** 添加项目,返回 { ok, error?, project?, exists? } */
function addProject(inputPath, versionIdOverride) {
  try {
    const rootDir = resolveProjectRoot(inputPath)
    if (!fs.existsSync(path.join(rootDir, 'project.godot'))) {
      return { ok: false, error: '未找到 project.godot' }
    }
    const id = projectDocId(rootDir)
    const existed = getDoc(id)
    const info = parseProjectGodot(rootDir)
    const versionId = versionIdOverride || (existed && existed.versionId) || matchVersion(info)
    const project = {
      id,
      path: rootDir,
      name: info.name,
      icon: info.icon,
      configVersion: info.configVersion,
      engineVersion: info.engineVersion,
      versionId,
      favorite: existed ? !!existed.favorite : false,
      lastOpenedAt: existed ? existed.lastOpenedAt : undefined,
      openCount: existed ? existed.openCount || 0 : 0,
      addedAt: existed ? existed.addedAt : Date.now()
    }
    putDoc(id, project)
    return { ok: true, project, exists: !!existed }
  } catch (e) {
    return { ok: false, error: (e && e.message) || '添加失败' }
  }
}

/** 递归扫描目录下的项目(忽略 .git/.godot 等,深度 5) */
function scanProjects(rootDir) {
  const found = []
  const walk = (dir, depth) => {
    if (depth > 5) return
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch (e) {
      return
    }
    if (fs.existsSync(path.join(dir, 'project.godot'))) {
      found.push(dir)
      return
    }
    for (const ent of entries) {
      if (!ent.isDirectory() || IGNORE_DIRS.has(ent.name)) continue
      walk(path.join(dir, ent.name), depth + 1)
    }
  }
  walk(rootDir, 0)
  return found
}

/** 删除项目记录 */
function removeProject(id) {
  removeDoc(id)
  return { ok: true }
}

module.exports = { parseProjectGodot, addProject, scanProjects, removeProject, projectDocId, matchVersion }
