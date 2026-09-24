// 项目管理:解析 project.godot、添加/扫描项目、自动绑定引擎版本
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { getDoc, putDoc, removeDoc, listDocs } = require('./store')
const { trashPath } = require('./fsutil')

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

// ---------- 新建项目 ----------

const RENDERERS = {
  forward_plus: { feature: 'Forward Plus', method: 'forward_plus', mobileMethod: 'mobile' },
  mobile: { feature: 'Mobile', method: 'mobile', mobileMethod: 'mobile' },
  gl_compatibility: { feature: 'GL Compatibility', method: 'gl_compatibility', mobileMethod: 'gl_compatibility' }
}

const DEFAULT_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 48 48">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5aa6db"/><stop offset="1" stop-color="#33689a"/></linearGradient></defs>
<rect x="1.5" y="1.5" width="45" height="45" rx="11" fill="url(#g)"/>
<rect x="14" y="17" width="20" height="17" rx="4.5" fill="#fff"/>
<rect x="9.6" y="19.6" width="5.2" height="7" rx="1.7" fill="#fff"/>
<rect x="33.2" y="19.6" width="5.2" height="7" rx="1.7" fill="#fff"/>
<rect x="18.4" y="22.6" width="4.6" height="6.4" rx="1.5" fill="#33689a"/>
<rect x="25" y="22.6" width="4.6" height="6.4" rx="1.5" fill="#33689a"/>
</svg>
`

/**
 * 新建项目:在 parentDir 下创建以 name 命名的目录,写入 project.godot 与默认图标,
 * 然后注册到项目列表(复用 addProject 的解析与自动绑定逻辑)。
 * opts: { name, parentDir, renderer, versionTag?, versionId? }
 */
function createProject(opts) {
  try {
    const name = String(opts.name || '').trim()
    // 去掉 Windows 非法文件名字符
    const safe = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim()
    if (!safe || safe === '.' || safe === '..') {
      return { ok: false, error: '项目名称无效' }
    }
    const parentDir = String(opts.parentDir || '').trim()
    if (!parentDir) {
      return { ok: false, error: '请选择创建位置' }
    }

    const projectDir = path.join(parentDir, safe)
    if (fs.existsSync(projectDir)) {
      return { ok: false, error: `目录已存在:${safe}` }
    }
    fs.mkdirSync(projectDir, { recursive: true })

    // 引擎版本号:从所选已装版本的 tag 提取 major.minor,兜底 4.3
    const tagMatch = /^v?(\d+\.\d+)/.exec(String(opts.versionTag || ''))
    const versionStr = tagMatch ? tagMatch[1] : '4.3'
    const r = RENDERERS[opts.renderer] || RENDERERS.forward_plus

    const godotIni = [
      '; Engine configuration file.',
      "; It's best edited using the editor UI and not directly,",
      '; since the parameters that go here are not all obvious.',
      ';',
      '; Format:',
      ';   [section] ; section goes between []',
      ';   param=value ; assign values to parameters',
      '',
      'config_version=5',
      '',
      '[application]',
      '',
      `config/name="${name.replace(/"/g, '')}"`,
      `config/features=PackedStringArray("${versionStr}", "${r.feature}")`,
      'config/icon="res://icon.svg"',
      '',
      '[rendering]',
      '',
      `renderer/rendering_method="${r.method}"`,
      `renderer/rendering_method.mobile="${r.mobileMethod}"`,
      ''
    ].join('\n')

    fs.writeFileSync(path.join(projectDir, 'project.godot'), godotIni, 'utf8')
    fs.writeFileSync(path.join(projectDir, 'icon.svg'), DEFAULT_ICON_SVG, 'utf8')

    return addProject(projectDir, opts.versionId)
  } catch (e) {
    return { ok: false, error: (e && e.message) || '创建失败' }
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

/**
 * 删除项目记录;deleteFiles=true 时同时删除项目文件夹。
 * Windows 下移入回收站(可恢复),其他平台永久删除。
 */
function removeProject(id, deleteFiles) {
  try {
    const project = getDoc(id)
    if (deleteFiles && project && project.path) {
      // 安全校验:目录内必须存在 project.godot 才执行删除,防止误删任意路径
      if (!fs.existsSync(path.join(project.path, 'project.godot'))) {
        return { ok: false, error: '目录校验失败(未找到 project.godot),已取消删除文件,仅移除记录请重试' }
      }
      // Windows 移入回收站,其他平台永久删除
      trashPath(project.path, true)
    }
    removeDoc(id)
    return { ok: true, filesDeleted: !!deleteFiles }
  } catch (e) {
    return { ok: false, error: (e && e.message) || '删除失败' }
  }
}

/** 复制插件目录到另一个项目(不自动启用) */
function copyAddonsToProject({ sourceProjectId, dirNames, targetProjectId }) {
  try {
    const src = getDoc(sourceProjectId)
    const dst = getDoc(targetProjectId)
    if (!src || !dst) return { ok: false, error: '项目不存在' }
    if (path.resolve(src.path) === path.resolve(dst.path)) {
      return { ok: false, error: '不能复制到同一项目' }
    }
    const srcAddons = path.join(src.path, 'addons')
    if (!fs.existsSync(srcAddons)) return { ok: false, error: '源项目没有 addons 目录' }
    const dstAddons = path.join(dst.path, 'addons')
    fs.mkdirSync(dstAddons, { recursive: true })

    const copied = []
    const skipped = []
    for (const d of dirNames || []) {
      const s = path.join(srcAddons, d)
      const t = path.join(dstAddons, d)
      if (!fs.existsSync(s)) {
        skipped.push(`${d}(不存在)`)
        continue
      }
      if (fs.existsSync(t)) {
        skipped.push(`${d}(目标已存在)`)
        continue
      }
      fs.cpSync(s, t, { recursive: true })
      copied.push(d)
    }
    return { ok: true, copied: copied.length, skipped, targetName: dst.name }
  } catch (e) {
    return { ok: false, error: (e && e.message) || '复制失败' }
  }
}

module.exports = {
  parseProjectGodot,
  addProject,
  scanProjects,
  removeProject,
  copyAddonsToProject,
  projectDocId,
  matchVersion,
  createProject
}
