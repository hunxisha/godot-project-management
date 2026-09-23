// HTTPS 工具:JSON 请求、文件下载(跟随重定向、进度、可取消)
const https = require('node:https')
const fs = require('node:fs')

const UA = { 'User-Agent': 'ztools-godot-plugin' }

/** GET 文本(HTML 等),自动跟随重定向 */
function getText(url, headers) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { ...UA, ...headers } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume()
          return resolve(getText(res.headers.location, headers))
        }
        if (res.statusCode !== 200) {
          res.resume()
          return reject(new Error(`HTTP ${res.statusCode}: ${url}`))
        }
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      })
      .on('error', reject)
  })
}

/** GET JSON,自动跟随重定向 */
function getJson(url, headers) {
  return getText(url, headers).then((text) => {
    try {
      return JSON.parse(text)
    } catch (e) {
      throw new Error('响应解析失败: ' + e.message)
    }
  })
}

/**
 * 下载文件到 destPath,支持进度回调与取消。
 * @param {string} url 下载地址
 * @param {string} destPath 目标文件路径
 * @param {{ total?: number, onProgress?: (received: number, total: number) => void }} opts
 * @returns {{ promise: Promise<void>, cancel: () => void }}
 */
function downloadFile(url, destPath, opts = {}) {
  let aborted = false
  let activeReq = null
  let activeWs = null

  const promise = new Promise((resolve, reject) => {
    const attempt = (currentUrl, depth = 0) => {
      if (aborted) return reject(new Error('已取消'))
      if (depth > 5) return reject(new Error('重定向次数过多'))
      activeReq = https.get(currentUrl, { headers: UA }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume()
          return attempt(res.headers.location, depth + 1)
        }
        if (res.statusCode !== 200) {
          res.resume()
          return reject(new Error(`下载失败 HTTP ${res.statusCode}`))
        }
        const total = parseInt(res.headers['content-length'], 10) || opts.total || 0
        let received = 0
        let lastEmit = 0
        activeWs = fs.createWriteStream(destPath)
        res.on('data', (chunk) => {
          received += chunk.length
          const now = Date.now()
          if (now - lastEmit > 100) {
            lastEmit = now
            opts.onProgress && opts.onProgress(received, total)
          }
        })
        res.pipe(activeWs)
        activeWs.on('finish', () => {
          if (aborted) return reject(new Error('已取消'))
          opts.onProgress && opts.onProgress(received, total)
          resolve()
        })
        activeWs.on('error', (e) => reject(new Error('写入文件失败: ' + e.message)))
      })
      activeReq.on('error', (e) => reject(new Error('网络错误: ' + e.message)))
    }
    attempt(url)
  })

  return {
    promise,
    cancel() {
      aborted = true
      try {
        activeReq && activeReq.destroy()
      } catch (e) { /* ignore */ }
      try {
        activeWs && activeWs.destroy()
      } catch (e) { /* ignore */ }
      try {
        fs.existsSync(destPath) && fs.unlinkSync(destPath)
      } catch (e) { /* ignore */ }
    }
  }
}

module.exports = { getText, getJson, downloadFile }
