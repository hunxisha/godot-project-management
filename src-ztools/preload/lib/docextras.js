// 类的附加信息(教程链接,按需从 GitHub XML 补)。从 docs.js 拆出(2026-09-29)。
// 拆分时去重:原文件里本段被完整定义了两遍(L506-578 与 L580-651,后者覆盖前者),
// 两份逐字相同(仅一处 JSDoc),取后者(JSDoc 更准确)合并为一份。
const fs = require('node:fs')
const path = require('node:path')
const { ensureDir } = require('./extract')
const { getDoc } = require('./store')
const { getText } = require('./http')
const { docsRoot, DB_ID, CLASS_NAME_RE } = require('./docpaths')
const { translationRefs } = require('./docpo')

/** 单个类 XML 的下载超时(约 20-100KB,快) */
const EXTRAS_TIMEOUT_MS = 20_000

// ---------- 类的附加信息(教程链接,按需从 GitHub XML 补) ----------
//
// 为什么按需:教程链接只在 godot 仓库的 doc/classes/*.xml 里(引擎的
// --dump-extension-api-with-docs 与 --doctool 都不含,实测确认);全量拉 1000+ 个 XML
// 会拖慢生成,因此改为「打开某个类时才拉那一个 XML」,解析后缓存到库目录 extras/ 下。
// 注:Godot 4 的 XML 已不再包含 theme_items,主题属性无从获取,不做。

/** $DOCS_URL 占位符 → 官方文档站的实际前缀 */
function docsUrlBase(/** @type {string} */ tag) {
  const m = /^(\d+\.\d+)/.exec(String(tag || ''))
  return `https://docs.godotengine.org/en/${m ? m[1] : 'stable'}/`
}

/**
 * 从类 XML 解析教程链接(纯函数)。
 * @param {string} xml
 * @param {string} tag
 * @returns {{title: string, url: string}[]}
 */
function parseTutorials(xml, tag) {
  const block = /<tutorials>([\s\S]*?)<\/tutorials>/.exec(String(xml || ''))
  if (!block) return []
  const base = docsUrlBase(tag)
  /** @type {{title: string, url: string}[]} */
  const out = []
  const re = /<link\s+title="([^"]*)"\s*>([^<]*)<\/link>/g
  let m
  while ((m = re.exec(block[1])) !== null) {
    const raw = m[2].trim()
    // $DOCS_URL 是官方占位符(自带分隔斜杠);其余(如 GitHub demo 链接)原样保留
    out.push({ title: m[1], url: raw.startsWith('$DOCS_URL') ? base + raw.slice('$DOCS_URL/'.length) : raw })
  }
  return out
}

/**
 * 读取类的附加信息(教程链接)。缓存命中直接返回;未命中按需下载 XML 并落缓存。
 * 网络失败返回 null —— 离线时详情页只是没有教程分节,不影响浏览。
 * @param {string} versionId
 * @param {string} className
 * @returns {Promise<{tutorials: {title: string, url: string}[], fetchedAt?: number, ref?: string} | null>}
 */
async function docsGetClassExtras(versionId, className) {
  if (!CLASS_NAME_RE.test(String(className || ''))) return null
  const cacheFile = path.join(docsRoot(versionId), 'extras', `${className}.json`)
  try {
    if (fs.existsSync(cacheFile)) return JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
  } catch (e) { /* 缓存损坏:走重新下载 */ }
  const record = getDoc(DB_ID(versionId))
  const tag = record && record.tag
  if (!tag) return null
  for (const ref of translationRefs(tag)) {
    try {
      const xml = await Promise.race([
        getText(`https://raw.githubusercontent.com/godotengine/godot/${ref}/doc/classes/${className}.xml`),
        /** @type {Promise<never>} */ (new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error('超时')), EXTRAS_TIMEOUT_MS)
        }))
      ])
      if (!xml || !xml.includes('<class')) throw new Error('内容异常')
      const extras = { tutorials: parseTutorials(xml, tag), fetchedAt: Date.now(), ref }
      ensureDir(path.dirname(cacheFile))
      const tmp = `${cacheFile}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(extras))
      fs.renameSync(tmp, cacheFile)
      return extras
    } catch (e) {
      // 该 ref 没有这个文件(新类在旧分支上不存在):试下一个
    }
  }
  return null
}

module.exports = { docsUrlBase, parseTutorials, docsGetClassExtras }
