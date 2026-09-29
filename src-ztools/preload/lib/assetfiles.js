// 素材安装的文件系统域:plugin.cfg 嗅探分流、落位、清单精确回收、启用/停用、已装清单。
// 纯文件系统,零网络。从 assets.js 拆出(2026-09-29)。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { trashPath, uniquePath } = require('./fsutil')
const { getDoc, listDocs } = require('./store')
// asArray / STORE_BASE 是商店 API 客户端的纯常量与工具;listAddons 的清单读取同样用到
const { asArray, STORE_BASE } = require('./assetapi')

/** @typedef {import('../../../src/types/godot').AddonInfo} AddonInfo */

/**
 * 同盘直接 rename,跨盘(EXDEV/EPERM)回退为复制后删除。
 * @param {string} src
 * @param {string} dest
 */
function moveSync(src, dest) {
  try {
    fs.renameSync(src, dest)
  } catch (e) {
    if (e.code !== 'EXDEV' && e.code !== 'EPERM') throw e
    fs.cpSync(src, dest, { recursive: true })
    fs.rmSync(src, { recursive: true, force: true })
  }
}

// node:fs Dirent 的最小结构子集(类型闸门下 node 模块不可解析,故按实际用到的成员声明)
/** @typedef {{ name: string, isDirectory(): boolean, isFile(): boolean }} DirEntry */

/**
 * 递归收集 plugin.cfg 路径(限深 5,跳过隐藏目录)。
 * @param {string} dir
 * @param {number} [depth]
 * @param {string[]} [out]
 * @returns {string[]}
 */
function findPluginCfgs(dir, depth = 0, out = []) {
  if (depth > 5) return out
  /** @type {DirEntry[]} */
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (e) {
    return out
  }
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) findPluginCfgs(p, depth + 1, out)
    else if (ent.name === 'plugin.cfg') out.push(p)
  }
  return out
}

/**
 * 确定安装源目录列表(其直接子项即插件目录)。
 * 兼容多种打包结构:根/addons/x、根/x/addons/x、wrapper/x 等——
 * 统一取 plugin.cfg 所在目录的父目录;无 plugin.cfg 时回退旧逻辑。
 * @param {string} extractDir
 * @returns {string[]}
 */
function locateSources(extractDir) {
  const cfgs = findPluginCfgs(extractDir)
  const sources = [...new Set(cfgs.map((c) => path.dirname(path.dirname(c))))]
  if (sources.length) return sources
  return [fs.existsSync(path.join(extractDir, 'addons')) ? path.join(extractDir, 'addons') : extractDir]
}

/**
 * 解析 plugin.cfg(取 name/version/author)。
 * @param {string} cfgPath
 * @returns {Record<string, string>}
 */
function parsePluginCfg(cfgPath) {
  try {
    /** @type {Record<string, string>} */
    const out = {}
    for (const line of fs.readFileSync(cfgPath, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([\w]+)\s*=\s*"?([^"\r\n]*)"?\s*$/.exec(line)
      if (m && ['name', 'version', 'author'].includes(m[1])) out[m[1]] = m[2]
    }
    return out
  } catch (e) {
    return {}
  }
}

/**
 * 在 project.godot 的 [editor_plugins] enabled 行中增删插件路径。
 * 仅精确改写 enabled 一行;缺少 section 时在文件末尾追加。
 * @param {string} projectPath
 * @param {string[]} dirNames
 * @param {boolean} enable
 */
function setPluginEnabled(projectPath, dirNames, enable) {
  const file = path.join(projectPath, 'project.godot')
  /** @type {string} */
  const text = fs.readFileSync(file, 'utf8')
  const paths = dirNames.map((d) => `res://addons/${d}/plugin.cfg`)
  const re = /^enabled\s*=\s*PackedStringArray\(([^)]*)\)/m
  const sectionRe = /^\[editor_plugins\]\s*$/m

  /** @type {string[]} */
  let current = []
  const m = re.exec(text)
  if (m) {
    current = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1])
  }
  let next = enable
    ? [...new Set([...current, ...paths])]
    : current.filter((p) => !paths.includes(p))

  const newline = `enabled=PackedStringArray(${next.map((p) => `"${p}"`).join(', ')})`

  if (re.test(text)) {
    const updated = text.replace(re, newline)
    if (updated !== text) fs.writeFileSync(file, updated)
    return
  }
  if (sectionRe.test(text)) {
    const updated = text.replace(sectionRe, (m) => `${m}\n\n${newline}`)
    fs.writeFileSync(file, updated)
    return
  }
  const trailing = text.endsWith('\n') ? '\n' : '\n\n'
  fs.writeFileSync(file, text + trailing + '[editor_plugins]\n\n' + newline + '\n')
}

// ---------- 纯素材(非插件)的文件落盘与清单清理 ----------

/**
 * 递归收集目录下全部文件的相对路径(正斜杠)。
 * 只跳过 macOS 打包垃圾 __MACOSX;点开头文件(如 .gdignore)按作者意图原样保留。
 * @param {string} dir 当前遍历目录(绝对路径)
 * @param {string} [rel] 相对根的路径
 * @param {string[]} [out]
 * @returns {string[]}
 */
function collectFiles(dir, rel = '', out = []) {
  /** @type {DirEntry[]} */
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (e) {
    return out
  }
  for (const ent of entries) {
    if (ent.name === '__MACOSX') continue
    const r = rel ? `${rel}/${ent.name}` : ent.name
    if (ent.isDirectory()) collectFiles(path.join(dir, ent.name), r, out)
    else if (ent.isFile()) out.push(r)
  }
  return out
}

/**
 * 把相对路径解析到 root 之下;越界(清单里混入 ../ 等)返回 null。
 * 安装清单存于本地数据库,属于可被改写的数据,删除前必须确认不逃出项目根。
 * @param {string} root
 * @param {string} rel
 * @returns {string|null}
 */
function resolveUnder(root, rel) {
  const dest = path.resolve(root, ...String(rel).split('/'))
  if (dest !== root && !dest.startsWith(root + path.sep)) return null
  return dest
}

/**
 * 按安装清单删除素材文件,然后自底向上清掉因此变空的父目录(到项目根为止)。
 * @param {string} projectPath
 * @param {string[]} [relPaths]
 */
/**
 * 按安装清单删除素材文件,然后自底向上清掉因此变空的父目录(到项目根为止)。
 * toTrash=true 时(显式卸载):先把文件移进同一暂存目录再整体移入回收站 ——
 * Windows 下逐文件入回收站要为每个文件起一个 PowerShell 进程,大清单慢到不可用;
 * 更新(先清后装)走直接删除,没必要为被替换的旧版本保留回收站记录。
 * @param {string} projectPath
 * @param {string[]} [relPaths]
 * @param {{toTrash?: boolean}} [opts]
 */
function removeInstalledFiles(projectPath, relPaths, opts) {
  const o = opts || {}
  /** @type {Set<string>} */
  const parentDirs = new Set()
  // 回收站暂存目录:所有待删文件先移进来,最后一次 trashPath
  let stageDir = ''
  if (o.toTrash) stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-trash-'))
  for (const rel of relPaths || []) {
    const dest = resolveUnder(projectPath, rel)
    if (!dest) continue
    try {
      const st = fs.statSync(dest)
      if (st.isFile()) {
        if (stageDir) {
          // 同盘 rename 瞬时完成;跨盘回退复制后删除(最终都会进回收站)
          const target = uniquePath(path.join(stageDir, path.basename(dest)))
          try {
            fs.renameSync(dest, target)
          } catch (e) {
            fs.cpSync(dest, target)
            fs.rmSync(dest, { force: true })
          }
        } else {
          fs.rmSync(dest, { force: true })
        }
      }
    } catch (e) { /* 不存在或删不掉:跳过,不阻断其余清理 */ }
    const parent = path.dirname(dest)
    if (parent !== projectPath) parentDirs.add(parent)
  }
  // 深的先清:父目录要等子目录腾空后才可能变空
  const dirs = [...parentDirs].sort((a, b) => b.length - a.length)
  for (const d of dirs) {
    let cur = d
    while (cur !== projectPath && cur.startsWith(projectPath + path.sep)) {
      let entries
      try {
        entries = fs.readdirSync(cur)
      } catch (e) {
        break
      }
      if (entries.length) break
      try {
        fs.rmdirSync(cur)
      } catch (e) {
        break
      }
      cur = path.dirname(cur)
    }
  }
  if (stageDir) {
    // 整体移入回收站;失败(如宿主无回收站能力)回退为直接删除,不留悬空清单
    try {
      trashPath(stageDir, true)
    } catch (e) {
      try { fs.rmSync(stageDir, { recursive: true, force: true }) } catch (e2) { /* ignore */ }
    }
  }
}

/**
 * 扫描项目已安装插件。
 * @param {string} projectId
 * @returns {AddonInfo[]}
 */
function listAddons(projectId) {
  const project = getDoc(projectId)
  if (!project) return []
  /** @type {Record<string, any>} */
  const marketDocs = {}
  for (const doc of listDocs(`godot/asset/${projectId}/`)) {
    marketDocs[doc._id] = doc
  }
  /** @type {AddonInfo[]} */
  const out = []
  const enabledText = (() => {
    try {
      return fs.readFileSync(path.join(project.path, 'project.godot'), 'utf8')
    } catch (e) {
      return ''
    }
  })()
  const enabledPaths = [...enabledText.matchAll(/"([^"]*addons\/[^"\\]+\/plugin\.cfg)"/g)].map((m) => m[1])

  // addons/ 可能不存在(项目只装过纯素材),此时跳过目录扫描、仍输出素材条目
  const addonsDir = path.join(project.path, 'addons')
  if (fs.existsSync(addonsDir)) {
    for (const ent of fs.readdirSync(addonsDir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue
      const cfgPath = path.join(addonsDir, ent.name, 'plugin.cfg')
      const hasCfg = fs.existsSync(cfgPath)
      const cfg = hasCfg ? parsePluginCfg(cfgPath) : {}
      const market = Object.values(marketDocs).find(
        (d) => d.kind !== 'asset' && (d.dirNames || []).includes(ent.name)
      )
      out.push({
        dirName: ent.name,
        name: cfg.name || market?.title || ent.name,
        version: cfg.version || market?.versionString,
        author: cfg.author,
        hasCfg,
        enabled: enabledPaths.includes(`res://addons/${ent.name}/plugin.cfg`),
        fromMarket: !!market,
        assetId: market?.assetId,
        versionString: market?.versionString,
        installedAt: market?.installedAt,
        kind: 'addon',
        // 商店页面:优先用安装时记下的原址,否则按 assetId 拼装
        storeUrl: market
          ? (market.meta && market.meta.storeUrl) ||
            (market.assetId ? `${STORE_BASE}/asset/${market.assetId}/` : undefined)
          : undefined
      })
    }
  }
  // 市场安装的纯素材不落 addons/,从安装记录直接生成条目(卸载/更新走 assetId)
  for (const doc of Object.values(marketDocs)) {
    if (doc.kind !== 'asset') continue
    const slug = String(doc.assetId || '').split('/')[1] || doc._id
    out.push({
      dirName: slug,
      name: doc.title || slug,
      version: doc.versionString,
      hasCfg: false,
      enabled: false,
      fromMarket: true,
      assetId: doc.assetId,
      versionString: doc.versionString,
      installedAt: doc.installedAt,
      kind: 'asset',
      /** 相对项目根的安装清单(正斜杠),展示与校验用;卸载以库里的记录为准 */
      assetPaths: asArray(doc.installedPaths),
      storeUrl:
        (doc.meta && doc.meta.storeUrl) ||
        (doc.assetId ? `${STORE_BASE}/asset/${doc.assetId}/` : undefined)
    })
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

module.exports = {
  moveSync,
  findPluginCfgs,
  locateSources,
  parsePluginCfg,
  setPluginEnabled,
  collectFiles,
  resolveUnder,
  removeInstalledFiles,
  listAddons
}
