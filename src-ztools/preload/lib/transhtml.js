// 富文本 HTML 的翻译切分与回填(纯函数,不碰网络、不碰 db)。
//
// 为什么不让模型整段吃 HTML:商店的 body_html / changes_html 是直接 v-html 渲染的
// (AssetDetailDialog.vue:137 / :150),模型改坏一个标签,整块版面就崩。这里的做法是
// 把 HTML 切成「标签 + 文本节点」两种 token,只把文本节点送出去翻,回来按**同一个索引**
// 回填 —— 标签一个字节都不经过模型,DeepL/Google 也走同一条路(它们会乱动标签,
// 但在这套形状里根本没有机会碰)。
//
// 约束(与设计定稿一致):
//   · 文本节点 trim 后长度 ≤ 2 或没有任何字母/汉字 → 不送翻(纯符号、数字、空白);
//   · <code> / <pre> / <script> / <style> 内的文本不送翻(代码翻了就是坏代码);
//   · 回填时保留节点原有的首尾空白,免得行内空格被吃掉;
//   · 送翻条目数与回填条目数不一致 → 整段放弃(ok:false),调用方回落原文。

/** 会被跳过整段内容的容器标签(标签本身保留,里面的文本不送翻) */
const SKIP_CONTAINERS = new Set(['code', 'pre', 'script', 'style', 'kbd', 'samp'])

/** 注释与标签;自闭合与属性里的 `>` 由「引号内不切」的写法兜住不了的少数畸形 HTML 由调用方回落 */
const TAG_RE = /<!--[\s\S]*?-->|<\/?[A-Za-z][^>]*>/g

/**
 * 有可翻译内容的判定:去掉首尾空白后长度 > 2 且含字母或汉字。
 * @param {string} text
 * @returns {boolean}
 */
function isTranslatable(text) {
  const s = String(text == null ? '' : text).trim()
  if (s.length <= 2) return false
  return /[A-Za-z\u3400-\u9fff]/.test(s)
}

/**
 * 取标签名与是否闭合。
 * @param {string} tag 形如 `<p>` / `</p>` / `<img ... />` / `<!-- -->`
 * @returns {{name: string, closing: boolean, selfClosing: boolean}}
 */
function tagInfo(tag) {
  if (tag.startsWith('<!--') || tag.startsWith('<!')) return { name: '', closing: false, selfClosing: true }
  const closing = /^<\s*\//.test(tag)
  const m = /^<\s*\/?\s*([A-Za-z][A-Za-z0-9-]*)/.exec(tag)
  const name = m ? m[1].toLowerCase() : ''
  const selfClosing = /\/\s*>$/.test(tag) || ['br', 'img', 'hr', 'input', 'meta', 'link'].includes(name)
  return { name, closing, selfClosing }
}

/**
 * 切分成 token 序列。
 * @param {string} sourceHtml
 * @returns {{tokens: {type: 'tag' | 'text', value: string}[], indexes: number[], texts: string[]}}
 *   indexes 是**可翻译文本节点**在 tokens 里的下标,texts 与之逐项对应
 */
function splitHtml(sourceHtml) {
  const source = String(sourceHtml == null ? '' : sourceHtml)
  /** @type {{type: 'tag' | 'text', value: string}[]} */
  const tokens = []
  let last = 0
  TAG_RE.lastIndex = 0
  let m
  while ((m = TAG_RE.exec(source))) {
    if (m.index > last) tokens.push({ type: 'text', value: source.slice(last, m.index) })
    tokens.push({ type: 'tag', value: m[0] })
    last = m.index + m[0].length
  }
  if (last < source.length) tokens.push({ type: 'text', value: source.slice(last) })

  /** 当前嵌套的跳过容器数量 */
  let skipDepth = 0
  /** @type {string[]} */
  const stack = []
  /** @type {number[]} */
  const indexes = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.type === 'tag') {
      const info = tagInfo(t.value)
      if (!info.name || info.selfClosing) continue
      if (info.closing) {
        const at = stack.lastIndexOf(info.name)
        if (at >= 0) {
          stack.splice(at, 1)
          if (SKIP_CONTAINERS.has(info.name)) skipDepth = Math.max(0, skipDepth - 1)
        }
        continue
      }
      stack.push(info.name)
      if (SKIP_CONTAINERS.has(info.name)) skipDepth++
      continue
    }
    if (skipDepth > 0) continue
    if (isTranslatable(t.value)) indexes.push(i)
  }

  return { tokens, indexes, texts: indexes.map((i) => tokens[i].value) }
}

/**
 * 把译文按索引回填,重建 HTML。
 *
 * 条目数不一致时**不做部分回填**:半翻的文档比不翻更难读,调用方拿到 ok:false 就用原文。
 * @param {{tokens: {type: string, value: string}[], indexes: number[], texts: string[]}} split
 * @param {string[]} translated 与 split.texts 等长的译文数组
 * @returns {{ok: boolean, html: string, error?: string}}
 */
function mergeHtml(split, translated) {
  const list = Array.isArray(translated) ? translated : []
  if (!split || !Array.isArray(split.indexes)) return { ok: false, html: '', error: '切分结果无效' }
  if (list.length !== split.indexes.length) {
    return { ok: false, html: '', error: `译文条目数不符(期望 ${split.indexes.length},实际 ${list.length})` }
  }
  // 复制一份再改:同一份 split 结果可能被重试复用,不能就地污染
  const tokens = split.tokens.map((t) => ({ type: t.type, value: t.value }))
  for (let n = 0; n < split.indexes.length; n++) {
    const at = split.indexes[n]
    const orig = tokens[at].value
    const lead = (orig.match(/^\s*/) || [''])[0]
    const trail = (orig.match(/\s*$/) || [''])[0]
    const text = String(list[n] == null ? '' : list[n]).trim()
    // 译文为空(模型漏了这一条)时保留原文,不把段落掏空
    tokens[at].value = lead + (text || orig.trim()) + trail
  }
  return { ok: true, html: tokens.map((t) => t.value).join('') }
}

/**
 * 一步到位:HTML → 译文 HTML。给不需要单独看到中间结果的调用方用(测试也走这条)。
 * @param {string} sourceHtml
 * @param {(texts: string[]) => Promise<string[]>} translate
 * @returns {Promise<{ok: boolean, html?: string, skipped?: boolean, error?: string}>}
 */
async function translateHtml(sourceHtml, translate) {
  const split = splitHtml(sourceHtml)
  if (!split.indexes.length) return { ok: true, html: String(sourceHtml || ''), skipped: true }
  let out
  try {
    out = await translate(split.texts)
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) }
  }
  const merged = mergeHtml(split, out)
  return merged.ok ? { ok: true, html: merged.html } : merged
}

module.exports = { splitHtml, mergeHtml, translateHtml, isTranslatable, tagInfo }
