// 中文类参考翻译:po 解析 + 按原文查表替换(纯函数),与翻译表下载/磁盘缓存(网络)。
// 从 docs.js 拆出(2026-09-29);EXTRAS_TIMEOUT_MS 随教程域移到 docextras.js。
const fs = require('node:fs')
const path = require('node:path')
const { ensureDir } = require('./extract')
const { rmQuiet, checkCancel } = require('./fsutil')
const { getText } = require('./http')
const { docsRoot } = require('./docpaths')

/** @typedef {import('../../../src/types/godot').DocClassDetail} DocClassDetail */

// ---------- 中文类参考翻译 ----------
//
// 官方中文翻译在 godot 仓库的 doc/translations/zh_Hans.po(与编辑器内置中文帮助同源),
// msgid 就是类文档英文原文 —— 实测(4.7.2)与 --dump-extension-api-with-docs 的描述字符串
// 逐字符一致,brief 1018/1018、description 1009/1009 精确命中。因此「按原文查表替换」即可,
// 无需任何对齐算法;未命中的条目(未翻译/新版本新增)保持英文。

const TRANSLATION_LOCALE = 'zh_Hans'
/** 翻译下载超时:9-10MB 的 po,慢网络下给足余量 */
const TRANSLATION_TIMEOUT_MS = 60_000

/**
 * @param {string} s po 单段转义还原
 * @returns {string}
 */
function unescapePo(s) {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '\\' && i + 1 < s.length) {
      const n = s[++i]
      out += n === 'n' ? '\n' : n === 't' ? '\t' : n === '"' ? '"' : n === '\\' ? '\\' : n
    } else out += c
  }
  return out
}

/**
 * 解析 .po 为 msgid→msgstr 表。
 * 跳过:头部(msgid 为空)、fuzzy(未复核)、msgctxt(避免同文异译误替换)、复数形式、空 msgstr(未翻译)。
 * @param {string} text
 * @returns {{map: Map<string, string>, entries: number, untranslated: number, skipped: number}}
 */
function parsePo(text) {
  const map = new Map()
  let entries = 0, untranslated = 0, skipped = 0
  const lines = String(text || '').split(/\r?\n/)
  /** @type {{msgid: string, msgstr: string} | null} */
  let cur = null
  let field = null
  // #, fuzzy / msgctxt 出现在条目**之前**,属于下一个 msgid —— 不能在 flush 时才消费,
  // 否则会错标到上一条(fuzzy 误杀上一条、msgctxt 条目反而混进表,实测踩过)。
  let pendingFuzzy = false
  let pendingCtx = false
  let fuzzyFlag = false
  let hasCtx = false
  const flush = () => {
    if (cur && cur.msgid) {
      entries++
      if (!cur.msgstr) untranslated++
      else if (fuzzyFlag || hasCtx) skipped++
      else map.set(cur.msgid, cur.msgstr)
    }
    cur = null
    field = null
  }
  for (const line of lines) {
    if (line.startsWith('#,') && line.includes('fuzzy')) { pendingFuzzy = true; continue }
    if (line.startsWith('#')) continue
    if (line.startsWith('msgctxt ')) { pendingCtx = true; field = null; continue }
    if (line.startsWith('msgid_plural') || line.startsWith('msgstr[')) { field = 'plural'; continue }
    if (line.startsWith('msgid ')) {
      flush()
      cur = { msgid: '', msgstr: '' }
      field = 'msgid'
      fuzzyFlag = pendingFuzzy
      hasCtx = pendingCtx
      pendingFuzzy = false
      pendingCtx = false
    } else if (line.startsWith('msgstr ')) field = 'msgstr'
    // 关键字行(msgid "…")与续行("…")都要提取引号内容
    const body = line.replace(/^(msgid|msgstr)\s+/, '')
    const m = /^"(.*)"\s*$/.exec(body)
    if (!m || !cur) continue
    if (field === 'msgid') cur.msgid += unescapePo(m[1])
    else if (field === 'msgstr') cur.msgstr += unescapePo(m[1])
  }
  flush()
  return { map, entries, untranslated, skipped }
}

/**
 * 翻译来源的 ref 回退链:完整 tag(4.7.2-stable)→ 小版本分支(4.7)→ master。
 * dev/预发布版本没有对应 tag,回退到分支或 master 的翻译(按原文查表,多几条少几条不影响正确性)。
 * @param {string} tag
 * @returns {string[]}
 */
function translationRefs(tag) {
  const refs = []
  if (tag) refs.push(tag)
  const m = /^(\d+\.\d+)/.exec(tag || '')
  if (m && !refs.includes(m[1])) refs.push(m[1])
  if (!refs.includes('master')) refs.push('master')
  return refs
}

/**
 * 下载(带磁盘缓存)并解析中文翻译表;全部来源失败返回 null,生成降级为英文。
 * @param {string} tag
 * @param {{canceled: boolean}} token
 * @returns {Promise<Map<string, string> | null>}
 */
async function loadZhTranslations(tag, token, force = false) {
  const cacheDir = path.join(docsRoot(), 'po-cache')
  // 强刷翻译:清掉整个 po 缓存,重新走下载(官方翻译随上游更新)
  if (force) rmQuiet(cacheDir)
  for (const ref of translationRefs(tag)) {
    const cached = path.join(cacheDir, `${TRANSLATION_LOCALE}-${ref}.po`)
    try {
      let text = ''
      if (fs.existsSync(cached)) {
        text = fs.readFileSync(cached, 'utf8')
      } else {
        checkCancel(token)
        text = await Promise.race([
          getText(`https://raw.githubusercontent.com/godotengine/godot/${ref}/doc/translations/${TRANSLATION_LOCALE}.po`),
          /** @type {Promise<never>} */ (new Promise((_resolve, reject) => {
            setTimeout(() => reject(new Error('翻译下载超时')), TRANSLATION_TIMEOUT_MS)
          }))
        ])
        if (!text || !text.includes('msgid')) throw new Error('翻译内容异常')
        checkCancel(token)
        ensureDir(cacheDir)
        const tmp = `${cached}.tmp`
        fs.writeFileSync(tmp, text)
        fs.renameSync(tmp, cached)
      }
      const { map } = parsePo(text)
      if (map.size) return map
    } catch (e) {
      // 该 ref 不可用(404/网络/超时):试下一个,全失败则降级英文
    }
  }
  return null
}

/**
 * 应用翻译:命中 msgid 的描述字段替换为中文,其余保持英文原样。
 * 同时统计「可翻译字符串总数」(hits.total)与「实际命中数」(hits.count),
 * 供 db 记录翻译覆盖率 —— 未命中是官方翻译缺失,不是插件丢失内容。
 * @param {DocClassDetail} cls
 * @param {Map<string, string>} tr
 * @param {{count: number, total: number}} hits 计数器
 * @returns {DocClassDetail}
 */
function applyTranslations(cls, tr, hits) {
  const t = (/** @type {string} */ s) => {
    if (s) {
      hits.total++
      const z = tr.get(s)
      if (z !== undefined) { hits.count++; return z }
    }
    return s
  }
  return {
    ...cls,
    brief: t(cls.brief),
    description: t(cls.description),
    members: cls.members.map((x) => ({ ...x, description: t(x.description) })),
    methods: cls.methods.map((x) => ({ ...x, description: t(x.description) })),
    signals: cls.signals.map((x) => ({ ...x, description: t(x.description) })),
    constants: cls.constants.map((x) => ({ ...x, description: t(x.description) })),
    enums: cls.enums.map((e) => ({ ...e, values: e.values.map((v) => ({ ...v, description: t(v.description) })) })),
    operators: cls.operators.map((x) => ({ ...x, description: t(x.description) }))
  }
}

module.exports = { unescapePo, parsePo, translationRefs, loadZhTranslations, applyTranslations }
