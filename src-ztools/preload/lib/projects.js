// 项目管理:解析 project.godot、添加/扫描项目、自动绑定引擎版本
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { getDoc, putDoc, removeDoc, listDocs } = require('./store')
const { trashPath } = require('./fsutil')
const { dirSize } = require('./extract')

const IGNORE_DIRS = new Set(['.git', '.godot', 'node_modules', '.import', 'build', 'dist', 'addons'])

/**
 * @typedef {import('../../../src/types/godot').GodotProject} ProjectDoc
 */

/**
 * @typedef {object} ProjectGodotInfo project.godot 里我们关心的字段
 * @property {string} name
 * @property {number} configVersion
 * @property {string} [engineVersion]
 * @property {string} [icon]
 * @property {boolean} hasPlugins
 */

/**
 * 解析 project.godot(Godot 配置为 INI 风格,含 PackedStringArray 值)。
 * @param {string} rootDir
 * @returns {ProjectGodotInfo}
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

/**
 * 去掉 INI 值外层的引号。
 * @param {string} v
 * @returns {string}
 */
function unquote(v) {
  const m = /^"(.*)"$/.exec(v.trim())
  return m ? m[1] : v.trim()
}

/**
 * 项目根目录:输入可能是项目目录,也可能是 project.godot 文件本身。
 * @param {string} inputPath
 * @returns {string}
 */
function resolveProjectRoot(inputPath) {
  const stat = fs.statSync(inputPath)
  if (stat.isFile()) return path.dirname(inputPath)
  return inputPath
}

/**
 * 项目文档 id(路径 md5)。
 * @param {string} rootDir
 * @returns {string}
 */
function projectDocId(rootDir) {
  const abs = path.resolve(rootDir)
  const hash = crypto.createHash('md5').update(abs).digest('hex')
  return `godot/project/${hash}`
}

/**
 * 为项目自动选择引擎版本:engineVersion major.minor → config_version 兜底。
 * @param {{engineVersion?: string, configVersion?: number}} project
 * @returns {string | undefined} 命中版本的文档 id
 */
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

/**
 * 添加项目(已存在时更新并保留收藏/最近打开等本地字段)。
 * @param {string} inputPath 项目目录或 project.godot 文件路径
 * @param {string} [versionIdOverride] 强制绑定的引擎版本 id
 * @returns {{ok: boolean, error?: string, project?: ProjectDoc, exists?: boolean}}
 */
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
 * @param {{
 *   name: string,
 *   parentDir: string,
 *   renderer: 'forward_plus'|'mobile'|'gl_compatibility',
 *   versionTag?: string,
 *   versionId?: string,
 * }} opts
 * @returns {{ok: boolean, error?: string, project?: ProjectDoc, exists?: boolean}}
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

/**
 * 递归扫描目录下的项目(忽略 .git/.godot 等,深度 5)。
 * @param {string} rootDir
 * @returns {string[]} 含 project.godot 的目录路径
 */
function scanProjects(rootDir) {
  /** @type {string[]} */
  const found = []
  /**
   * @param {string} dir
   * @param {number} depth
   */
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
 * @param {string} id
 * @param {boolean} [deleteFiles]
 * @returns {{ok: boolean, error?: string, filesDeleted?: boolean}}
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

/**
 * @typedef {object} MarketSourceRecord 市场来源记录(godot/asset/{projectId}/{assetId})
 * @property {string} [_id]
 * @property {string} [_rev]
 * @property {string} [assetId]
 * @property {string[]} [dirNames]
 * @property {string} [projectId]
 */

/**
 * 把某个 addon 目录在「市场来源」上的记录过户到目标项目。
 *
 * 为什么需要:插件目录本身不携带来源信息,来源记录在 `godot/asset/{projectId}/{assetId}`。
 * 只复制目录会让目标项目把它当成手动放置的插件 —— 显示「未知来源」,并失去商店链接与
 * 版本管理入口。目标已有同 assetId 记录时只补 dirNames,不覆盖目标自己的版本信息。
 *
 * @param {MarketSourceRecord[]} srcRecords 源项目的市场来源记录(godot/asset/{srcProjectId}/*)
 * @param {string} dirName 要过户的插件目录名
 * @param {string} targetProjectId 目标项目文档 id
 * @returns {boolean} 是否新建/补充了记录
 */
function adoptMarketRecord(srcRecords, dirName, targetProjectId) {
  const src = srcRecords.find((r) => (r.dirNames || []).includes(dirName))
  if (!src || !src.assetId) return false
  const id = `godot/asset/${targetProjectId}/${src.assetId}`
  const existing = getDoc(id)
  if (existing) {
    if ((existing.dirNames || []).includes(dirName)) return false
    const { _id, _rev, ...data } = existing
    putDoc(id, { ...data, dirNames: [...(data.dirNames || []), dirName] })
    return true
  }
  const { _id, _rev, ...data } = src
  putDoc(id, {
    ...data,
    projectId: targetProjectId,
    dirNames: [dirName],
    copiedFrom: src.projectId
  })
  return true
}

/**
 * 复制插件目录到另一个项目(不自动启用)。
 * @param {{sourceProjectId: string, dirNames: string[], targetProjectId: string}} opts
 * @returns {{ok: boolean, error?: string, copied?: number, skipped?: string[], adopted?: number, targetName?: string}}
 */
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

    /** 源项目里由市场安装的插件记录 */
    const srcRecords = listDocs(`godot/asset/${sourceProjectId}/`)

    const copied = []
    const skipped = []
    const adopted = []
    for (const d of dirNames || []) {
      const s = path.join(srcAddons, d)
      const t = path.join(dstAddons, d)
      if (!fs.existsSync(s)) {
        skipped.push(`${d}(不存在)`)
        continue
      }
      if (fs.existsSync(t)) {
        skipped.push(`${d}(目标已存在)`)
      } else {
        fs.cpSync(s, t, { recursive: true })
        copied.push(d)
      }
      // 目录已在目标里也照样过户来源记录:这次操作本身就表达了「它是同一个插件」的意图,
      // 也让「早先复制过去、当时还没有来源信息」的插件可以靠再复制一次补回来源。
      if (adoptMarketRecord(srcRecords, d, targetProjectId)) adopted.push(d)
    }
    return { ok: true, copied: copied.length, skipped, adopted: adopted.length, targetName: dst.name }
  } catch (e) {
    return { ok: false, error: (e && e.message) || '复制失败' }
  }
}

/**
 * 查询项目的 .godot 编辑器缓存大小(导入卡顿时的自救参考)。
 * @param {string} projectId
 * @returns {{ok: boolean, error?: string, exists?: boolean, size?: number}}
 */
function getProjectCacheInfo(projectId) {
  const project = getDoc(projectId)
  if (!project) return { ok: false, error: '项目不存在' }
  const dir = path.join(project.path, '.godot')
  if (!fs.existsSync(dir)) return { ok: true, exists: false, size: 0 }
  return { ok: true, exists: true, size: dirSize(dir) }
}

/**
 * 清理项目的 .godot 编辑器缓存(下次打开编辑器时 Godot 会自动重建)。
 * @param {string} projectId
 * @returns {{ok: boolean, error?: string, freed?: number}}
 */
function cleanProjectCache(projectId) {
  try {
    const project = getDoc(projectId)
    if (!project) return { ok: false, error: '项目不存在' }
    const dir = path.join(project.path, '.godot')
    if (!fs.existsSync(dir)) return { ok: true, freed: 0 }
    const size = dirSize(dir)
    fs.rmSync(dir, { recursive: true, force: true })
    return { ok: true, freed: size }
  } catch (e) {
    return { ok: false, error: (e && e.message) || '清理失败' }
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
  createProject,
  getProjectCacheInfo,
  cleanProjectCache
}
