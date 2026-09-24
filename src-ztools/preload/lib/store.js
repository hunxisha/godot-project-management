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
 * 同 putDoc,但把**宿主的失败原因**带出来。
 *
 * 宿主 db 是 CouchDB 风格:失败时返回 `{ error: true, name, message }`(`name` 常见取值
 * `conflict`),成功时只回 `{ ok: true, id, rev }`。`putDoc` 只回布尔值,于是「写了但没生效」
 * 这类问题在界面上完全没有线索 —— 排查收藏按钮时正是卡在这里。需要报错给用户时用本函数。
 *
 * @param {string} id
 * @param {object} data
 * @returns {{ok: boolean, reason: string}} reason 仅在失败时非空
 */
function putDocVerbose(id, data) {
  const old = getDoc(id)
  const res = window.ztools.db.put({ _id: id, _rev: old && old._rev, ...data })
  if (res && !res.error) return { ok: true, reason: '' }
  if (!res) return { ok: false, reason: '宿主 db.put 没有返回结果' }
  const detail = [res.name, res.message].filter(Boolean).join(' / ')
  return { ok: false, reason: detail || '宿主未给出原因' }
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

module.exports = { getDoc, putDoc, putDocVerbose, removeDoc, listDocs }
