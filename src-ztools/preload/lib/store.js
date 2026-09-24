// preload 侧 db 访问封装(与渲染层 bridge.ts 同构,preload 中 window.ztools.db 同样可用)

/**
 * 读取单个文档。
 * @param {string} id
 * @returns {any} 文档;不存在时返回 null
 */
function getDoc(id) {
  return window.ztools.db.get(id)
}

/**
 * 创建/更新文档。自动带上已有记录的 _rev(宿主 db 需要)。
 * @param {string} id
 * @param {object} data
 * @returns {boolean} 是否成功
 */
function putDoc(id, data) {
  const old = getDoc(id)
  return !window.ztools.db.put({ _id: id, _rev: old && old._rev, ...data }).error
}

/**
 * 删除文档(不存在时视为成功)。
 * @param {string} id
 * @returns {boolean}
 */
function removeDoc(id) {
  const old = getDoc(id)
  if (!old) return true
  return !window.ztools.db.remove(old).error
}

/**
 * 按 _id 前缀列出文档。
 * @param {string} prefix
 * @returns {any[]}
 */
function listDocs(prefix) {
  return window.ztools.db.allDocs(prefix) || []
}

module.exports = { getDoc, putDoc, removeDoc, listDocs }
