// 项目管理:解析 project.godot、添加/扫描项目、自动绑定引擎版本
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execSync } = require('node:child_process')
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
    // config_version: 5=4.x, 4=3.x;缺失(undefined)与 <5 同走 3.x —— ?? 0 不改行为
    const major = (project.configVersion ?? 0) >= 5 ? '4' : '3'
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

// 官方默认项目图标(与 Godot 编辑器新建项目写入的 icon.svg 完全一致):
// 取自 godot 仓库 editor/icons/DefaultProjectIcon.svg,经 editor_icons.cpp 的
// get_default_project_icon() 写入新项目 —— 保持原样,不做任何改动。
const DEFAULT_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="124" height="124" x="2" y="2" fill="#363d52" stroke="#212532" stroke-width="4" rx="14"/><g fill="#fff" transform="translate(12.322 12.322)scale(.101)"><path d="M105 673v33q407 354 814 0v-33z"/><path fill="#478cbf" d="m105 673 152 14q12 1 15 14l4 67 132 10 8-61q2-11 15-15h162q13 4 15 15l8 61 132-10 4-67q3-13 15-14l152-14V427q30-39 56-81-35-59-83-108-43 20-82 47-40-37-88-64 7-51 8-102-59-28-123-42-26 43-46 89-49-7-98 0-20-46-46-89-64 14-123 42 1 51 8 102-48 27-88 64-39-27-82-47-48 49-83 108 26 42 56 81zm0 33v39c0 276 813 276 814 0v-39l-134 12-5 69q-2 10-14 13l-162 11q-12 0-16-11l-10-65H446l-10 65q-4 11-16 11l-162-11q-12-3-14-13l-5-69z"/><path d="M483 600c0 34 58 34 58 0v-86c0-34-58-34-58 0z"/><circle cx="725" cy="526" r="90"/><circle cx="299" cy="526" r="90"/></g><g fill="#414042" transform="translate(12.322 12.322)scale(.101)"><circle cx="307" cy="532" r="60"/><circle cx="717" cy="532" r="60"/></g></svg>\n'

// 官方 Git 元数据文件内容(editor/version_control/editor_vcs_interface.cpp
// 的 create_vcs_metadata_files),逐行保持一致。
const GIT_IGNORE = [
  '# Godot 4+ specific ignores',
  '.godot/',
  '/android/',
  ''
].join('\n')

const GIT_ATTRIBUTES = [
  '# Normalize EOL for all files that Git considers text files.',
  '* text=auto eol=lf',
  ''
].join('\n')

// 官方 .editorconfig(project_dialog.cpp:确保外部编辑器/IDE 用 UTF-8)
const EDITOR_CONFIG = [
  'root = true',
  '',
  '[*]',
  'charset = utf-8',
  ''
].join('\n')

/**
 * 在项目目录初始化 Git 仓库:写官方 .gitignore/.gitattributes、git init、
 * 并把初始文件提交为首个 commit。git 不可用或提交失败都不影响项目创建本身
 * (文件已写好,用户可自行 init/commit)。
 *
 * 命令是固定字符串(不含用户输入),工作目录通过 cwd 选项传递 —— 不经过 shell 拼接,
 * 因此没有注入面;沙箱里已声明 execSync,无需新增能力。
 * @param {string} projectDir
 * @returns {{initialized: boolean, error?: string, committed: boolean}}
 */
function initGitRepo(projectDir) {
  try {
    fs.writeFileSync(path.join(projectDir, '.gitignore'), GIT_IGNORE, 'utf8')
    fs.writeFileSync(path.join(projectDir, '.gitattributes'), GIT_ATTRIBUTES, 'utf8')
  } catch (e) {
    return { initialized: false, committed: false, error: (e && e.message) || '写入 Git 元数据文件失败' }
  }
  const opts = { cwd: projectDir, stdio: 'ignore', timeout: 20_000 }
  try {
    execSync('git init', opts)
  } catch (e) {
    return { initialized: false, committed: false, error: '未找到 git 命令或初始化失败(元数据文件已写好,可手动 git init)' }
  }
  // 首次提交:失败常见于用户未配置 git 身份 —— 不算错误,仓库已可用
  let committed = false
  try {
    execSync('git add -A', opts)
    execSync('git commit -m "Initial commit"', opts)
    committed = true
  } catch (e) {
    // 保持未提交状态,交给用户
  }
  return { initialized: true, committed }
}

/**
 * 新建项目:在 parentDir 下创建以 name 命名的目录,写入 project.godot、官方默认图标
 * 与 .editorconfig(与 Godot 编辑器新建项目一致);opts.gitInit 时额外 git init 并写
 * .gitignore/.gitattributes(官方内容)。最后注册到项目列表(复用 addProject)。
 * @param {{
 *   name: string,
 *   parentDir: string,
 *   renderer: 'forward_plus'|'mobile'|'gl_compatibility',
 *   versionTag?: string,
 *   versionId?: string,
 *   gitInit?: boolean,
 * }} opts
 * @returns {{ok: boolean, error?: string, project?: ProjectDoc, exists?: boolean,
 *            git?: {initialized: boolean, error?: string, committed: boolean}}}
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
    // 与官方一致:确保外部编辑器/IDE 使用 UTF-8
    fs.writeFileSync(path.join(projectDir, '.editorconfig'), EDITOR_CONFIG, 'utf8')

    // Git 管理:与 Godot 编辑器的「版本控制:Git」选项等价 —— 先写元数据文件,
    // 再 git init(并把这两个文件纳入首次提交)
    /** @type {{initialized: boolean, error?: string, committed: boolean} | undefined} */
    let git
    if (opts.gitInit) {
      git = initGitRepo(projectDir)
    }

    const added = addProject(projectDir, opts.versionId)
    return git ? { ...added, git } : added
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
