// GitHub Releases:拉取 Godot 官方版本列表(24h 缓存),并按当前平台过滤资产
const { getJson } = require('./http')
const { getDoc, putDoc } = require('./store')

const API = 'https://api.github.com/repos/godotengine/godot/releases?per_page=100'
const CACHE_ID = 'godot/cache/releases'
const TTL = 24 * 60 * 60 * 1000

/** 当前平台标识 */
function currentPlatform() {
  if (process.platform === 'win32') return 'win64'
  if (process.platform === 'darwin') return 'macos'
  return 'linux64'
}

/** 判断资产是否为指定平台+变体的引擎压缩包 */
function matchAsset(name, platform, variant) {
  const n = name.toLowerCase()
  if (!n.endsWith('.zip')) return false
  const exclude = ['export_templates', 'libgodot', 'android', 'ios', 'web', 'server', 'headless', 'console', 'win32', 'osx32']
  if (exclude.some((k) => n.includes(k))) return false
  const isMono = n.includes('mono')
  if ((variant === 'mono') !== isMono) return false
  if (platform === 'win64') return n.includes('win64')
  if (platform === 'linux64') return n.includes('linux')
  if (platform === 'macos') return n.includes('macos') || n.includes('osx')
  return false
}

/**
 * 获取版本列表(缓存 24h)。
 * 返回 [{ tag, name, publishedAt, prerelease, assets: [{ name, url, size }] }]
 * assets 已过滤为当前平台的标准/mono 两种变体。
 */
async function fetchReleases(force) {
  const cache = getDoc(CACHE_ID)
  if (!force && cache && Date.now() - cache.fetchedAt < TTL) return cache.releases

  const raw = await getJson(API, { Accept: 'application/vnd.github+json' })
  const platform = currentPlatform()
  const releases = (Array.isArray(raw) ? raw : [])
    .map((r) => ({
      tag: r.tag_name,
      name: r.name || r.tag_name,
      publishedAt: r.published_at,
      prerelease: !!r.prerelease,
      assets: (r.assets || [])
        .filter((a) => matchAsset(a.name, platform, 'standard') || matchAsset(a.name, platform, 'mono'))
        .map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size }))
    }))
    .filter((r) => r.assets.length)

  putDoc(CACHE_ID, { fetchedAt: Date.now(), releases })
  return releases
}

module.exports = { currentPlatform, matchAsset, fetchReleases }
