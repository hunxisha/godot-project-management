// HTTPS 工具:JSON/文本请求、文件下载(跟随重定向、进度、可取消、支持 HTTP 代理)
const https = require('node:https')
const http = require('node:http')
const tls = require('node:tls')
const fs = require('node:fs')
const { URL } = require('node:url')
const { EventEmitter } = require('node:events')
const { getDoc } = require('./store')

const UA = { 'User-Agent': 'ztools-godot-plugin' }

/** 读取当前代理设置(每次请求时读取,设置保存后立即生效);环境异常时不使用代理 */
function currentProxy() {
  try {
    const s = getDoc('godot/settings')
    return (s && typeof s.proxy === 'string' && s.proxy.trim()) || ''
  } catch (e) {
    return ''
  }
}

/**
 * GET 请求统一入口:无代理直接连接;配置了代理时通过 HTTP CONNECT 隧道。
 * 返回对象支持 .on('error', fn) 与 .destroy()(代理路径返回中转 stub)。
 */
function httpsGet(url, headers, cb) {
  const proxy = currentProxy()
  if (!proxy) {
    return https.get(url, { headers: { ...UA, ...headers } }, cb)
  }

  const stub = new EventEmitter()
  let connectReq = null
  let tlsSock = null
  const fail = (err) => {
    if (!stub.listenerCount('error')) return
    stub.emit('error', err)
  }
  stub.destroy = () => {
    try { connectReq && connectReq.destroy() } catch (e) { /* ignore */ }
    try { tlsSock && tlsSock.destroy() } catch (e) { /* ignore */ }
  }

  let pu
  try {
    pu = new URL(proxy)
    if (pu.protocol !== 'http:') throw new Error('仅支持 HTTP 代理')
  } catch (e) {
    process.nextTick(() => fail(new Error('代理地址无效(' + proxy + '):' + (e && e.message))))
    return stub
  }

  let u
  try {
    u = new URL(url)
  } catch (e) {
    process.nextTick(() => fail(new Error('URL 无效: ' + url)))
    return stub
  }

  const target = `${u.hostname}:${u.port || 443}`
  const proxyPort = Number(pu.port) || 80
  const connectHeaders = { Host: target }
  if (pu.username) {
    connectHeaders['Proxy-Authorization'] =
      'Basic ' + Buffer.from(`${decodeURIComponent(pu.username)}:${decodeURIComponent(pu.password || '')}`).toString('base64')
  }

  connectReq = http.request({
    host: pu.hostname,
    port: proxyPort,
    method: 'CONNECT',
    path: target,
    headers: connectHeaders
  })

  connectReq.on('connect', (res, socket) => {
    if (res.statusCode !== 200) {
      socket.destroy()
      return fail(new Error(`代理连接失败 HTTP ${res.statusCode}`))
    }
    tlsSock = tls.connect({ socket, servername: u.hostname })
    tlsSock.on('secureConnect', () => {
      const req = https.get(
        {
          host: u.hostname,
          port: u.port || 443,
          path: u.pathname + u.search,
          headers: { ...UA, ...headers, Host: u.hostname },
          createConnection: () => tlsSock
        },
        cb
      )
      req.on('error', fail)
    })
    tlsSock.on('error', fail)
  })
  connectReq.on('error', fail)
  connectReq.end()
  return stub
}

/** GET 文本(HTML 等),自动跟随重定向 */
function getText(url, headers) {
  return new Promise((resolve, reject) => {
    httpsGet(url, headers, (res) => {
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
    }).on('error', reject)
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
      activeReq = httpsGet(currentUrl, {}, (res) => {
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
