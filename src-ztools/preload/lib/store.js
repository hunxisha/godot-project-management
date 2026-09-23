// preload 侧 db 访问封装(与渲染层 bridge.ts 同构,preload 中 window.ztools.db 同样可用)

function getDoc(id) {
  return window.ztools.db.get(id)
}

function putDoc(id, data) {
  const old = getDoc(id)
  return !window.ztools.db.put({ _id: id, _rev: old && old._rev, ...data }).error
}

function removeDoc(id) {
  const old = getDoc(id)
  if (!old) return true
  return !window.ztools.db.remove(old).error
}

function listDocs(prefix) {
  return window.ztools.db.allDocs(prefix) || []
}

module.exports = { getDoc, putDoc, removeDoc, listDocs }
