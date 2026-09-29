// 文档库路径工具:versionId 归一化、库目录定位、db 文档 id、类名白名单。
// 从 docs.js 拆出(2026-09-29,见 docs/optimization-plan.md);docs.js 门面的对外契约不变。
const os = require('node:os')
const path = require('node:path')
const { getDoc } = require('./store')

/** 类名合法性:仅字母数字下划线与 @ 伪类前缀;同时阻断路径穿越 */
const CLASS_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$|^@[A-Za-z]+$/

// ---------- 路径 ----------

const VERSION_PREFIX = 'godot/version/'

/**
 * 版本标识归一化:全插件的约定是 versionId = 完整 db 文档 id(godot/version/<tag>-<变体>-<平台>,
 * 见 install.js 的 version.id),但也接受裸键。返回 docId(查文档用)与 key(路径/db 落盘用的
 * 安全裸键 —— 完整 id 里的斜杠不能进文件路径)。
 * @param {string} versionId
 * @returns {{docId: string, key: string}}
 */
function versionKey(versionId) {
  const input = String(versionId || '').trim()
  const docId = input.startsWith(VERSION_PREFIX) ? input : VERSION_PREFIX + input
  const key = docId.slice(VERSION_PREFIX.length).replace(/[^A-Za-z0-9._-]/g, '_')
  return { docId, key }
}

/**
 * 文档库根目录:优先设置里的引擎安装根;未设置(用户只导入过本地引擎)时退回家目录。
 * @param {string} [versionId]
 */
function docsRoot(versionId) {
  const settings = getDoc('godot/settings') || {}
  const base = settings.versionsRoot || path.join(os.homedir(), '.gpm-docs')
  if (!versionId) return path.join(base, 'gpm-docs')
  return path.join(base, 'gpm-docs', versionKey(versionId).key)
}

/**
 * @param {string} versionId
 */
function libClassesDir(versionId) {
  return path.join(docsRoot(versionId), 'classes')
}

/**
 * @param {string} versionId
 */
function libIndexPath(versionId) {
  return path.join(docsRoot(versionId), 'index.json')
}

/**
 * @param {string} versionId
 */
const DB_ID = (versionId) => `godot/docs/${versionKey(versionId).key}`
const FAVORITES_ID = 'godot/docs/favorites'
const HISTORY_ID = 'godot/docs/history'

module.exports = {
  VERSION_PREFIX,
  versionKey,
  docsRoot,
  libClassesDir,
  libIndexPath,
  DB_ID,
  FAVORITES_ID,
  HISTORY_ID,
  CLASS_NAME_RE
}
