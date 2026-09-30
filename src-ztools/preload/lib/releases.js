// Godot 官方下载归档(godotengine.org/download/archive):版本列表解析 + 官方 CDN 直链构造(24h 缓存)
const { getText } = require('./http')
const { getDoc, putDoc } = require('./store')
const { currentPlatform, displayName } = require('./godotExe')

const ARCHIVE_URL = 'https://godotengine.org/download/archive/'
const CDN = 'https://downloads.godotengine.org/'
// 官方构建仓库:CDN 的 ?version=&flavor= 映射表就是转发到这里的同名资产
const BUILDS = 'https://github.com/godotengine/godot-builds/releases/download/'
const CACHE_ID = 'godot/cache/releases'
const TTL = 24 * 60 * 60 * 1000

/** 英文日期 → ISO 字符串,如 '18 August 2026' → '2026-08-18T00:00:00Z' */
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/**
 * 归档页里的英文日期 → ISO 字符串。
 * @param {string} s 形如 '18 August 2026'
 * @returns {string} ISO 字符串;无法解析时返回空串
 */
function parseArchiveDate(s) {
  const m = s.match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/)
  if (!m) return ''
  const mi = MONTHS.findIndex((k) => k.toLowerCase() === m[2].toLowerCase())
  if (mi < 0) return ''
  return new Date(Date.UTC(+m[3], mi, +m[1])).toISOString()
}

/**
 * 按版本+平台+变体构造官方 CDN 下载链接。
 * URL 规律(经 4.x stable/dev 与 3.x stable 页面验证):
 *   https://downloads.godotengine.org/?version={ver}&flavor={flavor}&slug={slug}&platform={pf}
 * tag = {version}-{flavor},flavor 为完整后缀(stable/dev6/beta3/rc2…)。
 * 3.x 与 4.x 的 Linux/macOS slug 命名不同,按 major 区分。
 * @param {string} tag 形如 '4.7.2-stable'
 * @returns {{name: string, url: string, fallbackUrl: string, size: number}[]} 当前平台的标准/mono 两种变体;不支持的版本返回空数组
 */
function buildAssets(tag) {
  const idx = tag.indexOf('-')
  const version = idx < 0 ? tag : tag.slice(0, idx)
  const flavor = idx < 0 ? 'stable' : tag.slice(idx + 1)
  const major = parseInt(version, 10)
  if (!(major >= 3)) return [] // 1.x/2.x 资产命名不同且已无使用价值

  const platform = currentPlatform()
  let slugs
  if (platform === 'win64') {
    slugs = [
      ['standard', 'win64.exe.zip', 'windows.64'],
      ['mono', 'mono_win64.zip', 'windows.64']
    ]
  } else if (platform === 'macos') {
    slugs = major >= 4
      ? [
          ['standard', 'macos.universal.zip', 'macos.universal'],
          ['mono', 'mono_macos.universal.zip', 'macos.universal']
        ]
      : [
          ['standard', 'osx.universal.zip', 'macos.universal'],
          ['mono', 'mono_osx.universal.zip', 'macos.universal']
        ]
  } else {
    slugs = major >= 4
      ? [
          ['standard', 'linux.x86_64.zip', 'linux.64'],
          ['mono', 'mono_linux_x86_64.zip', 'linux.64']
        ]
      : [
          ['standard', 'x11.64.zip', 'linux.64'],
          ['mono', 'mono_x11_64.zip', 'linux.64']
        ]
  }
  return slugs.map(([variant, slug, pf]) => {
    const name = `Godot_v${tag}_${slug}`
    return {
      name,
      url: `${CDN}?version=${version}&flavor=${flavor}&slug=${slug}&platform=${pf}`,
      // 备用直链。CDN 只是映射层:归档页会先把版本列出来,而产物在构建仓库里迟到
      // (实测 4.8-dev7 归档页有条目、构建仓库里却没有桌面版包),此时 CDN 直接 404。
      // 落回构建仓库的同名资产,既绕开映射滞后,也把「真的没有」与「映射没更新」区分开。
      fallbackUrl: `${BUILDS}${tag}/${name}`,
      size: 0 // 归档页不提供大小,下载开始后从响应 Content-Length 获取
    }
  })
}

/**
 * 获取版本列表(缓存 24h)。
 * 解析官方归档页,返回 [{ tag, name, publishedAt, prerelease, assets: [{ name, url, size }] }],
 * 含稳定版与 dev/beta/rc 预发布版,assets 为当前平台的标准/mono 两种变体直链。
 * @param {boolean} [force] 为真时忽略缓存强制重新拉取
 * @returns {Promise<Array<{tag: string, name: string, publishedAt: string, prerelease: boolean, assets: {name: string, url: string, fallbackUrl: string, size: number}[]}>>}
 */
async function fetchReleases(force) {
  const cache = getDoc(CACHE_ID)
  if (!force && cache && cache.source === 'archive' && Date.now() - cache.fetchedAt < TTL) {
    return cache.releases
  }

  const html = await getText(ARCHIVE_URL)
  const re = /archive-version" href="\/download\/archive\/([0-9A-Za-z.\-]+)"[^>]*>\s*<h4[^>]*>[^<]+<\/h4>\s*<p class="archive-download-meta"><span>([^<]+)<\/span>/g
  const seen = new Set()
  const releases = []
  let m
  while ((m = re.exec(html))) {
    const tag = m[1]
    if (seen.has(tag)) continue
    seen.add(tag)
    const assets = buildAssets(tag)
    if (!assets.length) continue
    releases.push({
      tag,
      name: displayName(tag),
      publishedAt: parseArchiveDate(m[2].trim()),
      prerelease: !tag.endsWith('-stable'),
      assets
    })
  }
  if (!releases.length) throw new Error('归档页解析失败:未识别到任何版本条目')

  putDoc(CACHE_ID, { fetchedAt: Date.now(), source: 'archive', releases })
  return releases
}

// currentPlatform 继续对外导出:services.js 从这里取,实现已统一到 godotExe.js
module.exports = { currentPlatform, fetchReleases }
