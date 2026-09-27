// 网络诊断:依次探测插件依赖的三个远端端点,给出可达性与延迟。
// 走 http.js 的 getText —— 自动应用当前代理设置,诊断结果反映的是「插件实际会怎么连」。
const { getText } = require('./http')

const TARGETS = [
  { name: 'Asset Store API', url: 'https://store.godotengine.org/api/v1/asset-types/' },
  { name: 'GitHub Releases', url: 'https://github.com/godotengine/godot/releases' },
  { name: '官方下载 CDN', url: 'https://downloads.godotengine.org/' }
]

const TIMEOUT_MS = 8000

/**
 * 依次探测(串行,避免同时打三个远端互相干扰计时)。
 * @returns {Promise<{ok: boolean, results: {name: string, url: string, ok: boolean, ms: number, error?: string}[]}>}
 */
async function runNetworkDiagnostics() {
  /** @type {{name: string, url: string, ok: boolean, ms: number, error?: string}[]} */
  const results = []
  for (const t of TARGETS) {
    const start = Date.now()
    try {
      await Promise.race([
        getText(t.url),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`超时(${TIMEOUT_MS / 1000}s)`)), TIMEOUT_MS))
      ])
      results.push({ ...t, ok: true, ms: Date.now() - start })
    } catch (e) {
      results.push({ ...t, ok: false, ms: Date.now() - start, error: (e && e.message) || '失败' })
    }
  }
  return { ok: true, results }
}

module.exports = { runNetworkDiagnostics }
