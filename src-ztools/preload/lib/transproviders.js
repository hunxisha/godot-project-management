// 三个翻译服务商的请求体构造与响应解析。
//
// 对外只暴露一种形状:**字符串数组进、字符串数组出**。HTML 的拆分/回填在 transhtml.js,
// 缓存与失败抑制在 translate.js —— 这里不碰 db、不碰 window,只做纯数据变换,
// 于是三条通道都能被同一个测试夹具钉住(见 __tests__/transproviders.test.js)。
//
// 两个真实坑:
//   1. DeepL 与 Google 会「顺手优化」HTML 标签。术语保护因此不能靠提示词,只能把词包成
//      <x>…</x> 再让服务端原样保留(DeepL: tag_handling=xml + ignore_tags;
//      Google: format=html)。没用到词时退回纯文本模式,少传两个参数少一分风险。
//   2. OpenAI 兼容端点的能力参差不齐(Ollama / LM Studio 不认 response_format 之类的字段)。
//      这里**只发 messages**,让模型按系统提示词自己吐 JSON,解析层兜住多余的前后缀。

const glossary = require('./transglossary')

/** 支持的服务商类型 */
const KINDS = ['openai', 'deepl', 'google']

/** 单批条数上限:DeepL 官方 50 段、Google 受 URL/请求体限制、AI 走上下文长度 */
const BATCH_LIMIT = { openai: 20, deepl: 50, google: 10 }

/** 类型的中文名(设置页与错误信息共用,避免两处各写一份) */
const KIND_LABEL = { openai: 'OpenAI 兼容', deepl: 'DeepL', google: 'Google 翻译' }

/** 目标语言的中文名(AI 提示词要用自然语言说「译成什么」) */
const LANG_LABEL = {
  'zh-CN': '简体中文', 'zh-TW': '繁體中文', 'zh-HK': '繁體中文',
  en: 'English', ja: '日本語', ko: '한국어', ru: 'Русский',
  es: 'Español', fr: 'Français', de: 'Deutsch', pt: 'Português', it: 'Italiano'
}

/** 不译词在提示词里的显示顺序:内置 + 用户追加 */
const TERM_LIMIT = 60

/**
 * 去掉尾部斜杠,避免拼出 `//chat/completions`
 * @param {string} s
 * @returns {string}
 */
function trimSlash(s) {
  return String(s == null ? '' : s).trim().replace(/\/+$/, '')
}

/**
 * DeepL 的目标语言代码与 BCP-47 不同(中文分简繁)
 * @param {string} lang
 * @returns {string}
 */
function deeplTarget(lang) {
  const l = String(lang || 'zh-CN').toLowerCase()
  if (l.startsWith('zh')) return /tw|hk|hant/.test(l) ? 'ZH-HANT' : 'ZH-HANS'
  return l.split('-')[0].toUpperCase()
}

/**
 * Google 直接吃 BCP-47
 * @param {string} lang
 * @returns {string}
 */
function googleTarget(lang) {
  return String(lang || 'zh-CN')
}

/**
 * 服务商标识:缓存键的一部分,`openai:deepseek-chat` 这种形状
 * @param {any} p
 * @returns {string}
 */
function providerId(p) {
  if (!p) return ''
  return `${p.kind}:${p.model || ''}`
}

/**
 * 服务商是否可用(能发请求)。
 * 本地推理(Ollama/LM Studio)常常没有 Key,所以 openai 类型允许空 Key ——
 * 但它必须有 baseUrl,否则拼出来的地址是官方地址、空 Key 必然 401。
 * @param {any} p
 * @returns {boolean}
 */
function usable(p) {  if (!p || !KINDS.includes(p.kind)) return false
  if (p.kind === 'openai') return !!trimSlash(p.baseUrl)
  return !!String(p.apiKey || '').trim()
}

/**
 * 按场景排出服务商优先级。
 *
 * 设计定稿:只配了一个就它翻全部;配了两个以上才按「短文本 → 传统 MT,长文本/富文本 → AI」分工,
 * 因为 20 条卡片描述交给 DeepL 是几十毫秒,交给模型要等它吐一整段 JSON;而长 HTML 交给
 * 传统 MT 会把标签弄乱。返回的是**尝试顺序**,第一个失败就换下一个。
 * @param {any[]} list
 * @param {string} activeId 用户指定的默认服务商 id(空则不加权)
 * @param {'short' | 'long'} scene
 * @returns {any[]}
 */
function order(list, activeId, scene) {
  const valid = (Array.isArray(list) ? list : []).filter(usable)
  if (valid.length <= 1) return valid
  const prefer = scene === 'short' ? ['deepl', 'google'] : ['openai']
  const active = valid.find((p) => providerId(p) === activeId)
  let primary = valid.find((p) => prefer.includes(p.kind))
  // 默认服务商优先:用户显式选过就尊重它,即使它不属于该场景的偏好类
  if (active && active.kind === (primary && primary.kind)) primary = active
  if (!primary) primary = active || valid[0]
  return [primary, ...valid.filter((p) => p !== primary)]
}

/**
 * 该服务商单批最多几条
 * @param {any} p
 * @returns {number}
 */
function batchLimit(p) {
  const limit = /** @type {Record<string, number>} */ (BATCH_LIMIT)
  return limit[(p && p.kind) || ''] || 20
}

/**
 * 构造一次翻译请求。
 * @param {any} provider
 * @param {string[]} texts
 * @param {{target?: string, terms?: string[]}} [opts]
 * @returns {{url: string, headers: Record<string, string>, body: any, kind: string}}
 */
function buildRequest(provider, texts, opts = {}) {
  const target = opts.target || 'zh-CN'
  const terms = glossary.allTerms(opts.terms).slice(0, TERM_LIMIT)
  const items = Array.isArray(texts) ? texts : []

  if (provider.kind === 'openai') {
    const base = trimSlash(provider.baseUrl) || 'https://api.openai.com/v1'
    const label = /** @type {Record<string, string>} */ (LANG_LABEL)[target] || target
    /** @type {Record<string, string>} */
    const headers = { 'Content-Type': 'application/json' }
    if (String(provider.apiKey || '').trim()) headers.Authorization = `Bearer ${String(provider.apiKey).trim()}`
    return {
      kind: 'openai',
      url: `${base}/chat/completions`,
      headers,
      body: {
        model: provider.model || 'gpt-4o-mini',
        temperature: 0.2,
        messages: [
          { role: 'system', content: glossary.systemPrompt(label, terms) },
          { role: 'user', content: JSON.stringify({ items: items.map((t, i) => ({ i, t })) }) }
        ]
      }
    }
  }

  if (provider.kind === 'deepl') {
    const pro = String(provider.plan || '').toLowerCase() === 'pro'
    const base = trimSlash(provider.baseUrl) || (pro ? 'https://api.deepl.com' : 'https://api-free.deepl.com')
    /** @type {Record<string, string>} */
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `DeepL-Auth-Key ${String(provider.apiKey || '').trim()}`
    }
    // 有词要保护才开 xml 模式:纯文本模式下 tag_handling 反而可能被当成正文
    const wrapped = items.map((t) => glossary.wrapTerms(t, terms))
    const usesTags = wrapped.some((t, i) => t !== items[i])
    /** @type {any} */
    const body = { text: wrapped, target_lang: deeplTarget(target), preserve_formatting: true }
    if (usesTags) {
      body.tag_handling = 'xml'
      body.ignore_tags = ['x']
    }
    return { kind: 'deepl', url: `${base}/v2/translate`, headers, body }
  }

  // google
  const base = trimSlash(provider.baseUrl) || 'https://translation.googleapis.com'
  const wrapped = items.map((t) => glossary.wrapTerms(t, terms))
  const usesTags = wrapped.some((t, i) => t !== items[i])
  return {
    kind: 'google',
    url: `${base}/language/translate/v2?key=${encodeURIComponent(String(provider.apiKey || '').trim())}`,
    headers: { 'Content-Type': 'application/json' },
    // Google 的 html 模式会保留标签;不用词时也走 html,免得 &amp; 这类实体被二次转义
    body: { q: wrapped, target: googleTarget(target), format: usesTags ? 'html' : 'text' }
  }
}

/**
 * 常见 HTML 实体还原(Google 在 html 模式下会把引号、尖括号转义回来)
 * @param {string} s
 * @returns {string}
 */
function unescapeBasics(s) {
  return String(s == null ? '' : s)
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&')
}

/**
 * 从模型输出里抠出数组。先整份 JSON.parse,失败再抓第一个 `[` 到最后一个 `]`
 * (模型常把 JSON 包在 ```json 围栏或一句客套话里)。
 * @param {string} content
 * @returns {any[] | null}
 */
function extractArray(content) {
  const raw = String(content == null ? '' : content).trim()
  if (!raw) return null
  /**
   * @param {string} s
   * @returns {any[] | null}
   */
  const tryParse = (s) => {
    try {
      const v = JSON.parse(s)
      if (Array.isArray(v)) return v
      if (v && Array.isArray(v.items)) return v.items
      return null
    } catch (e) {
      return null
    }
  }
  const direct = tryParse(raw)
  if (direct) return direct
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw)
  if (fenced) {
    const inside = tryParse(fenced[1].trim())
    if (inside) return inside
  }
  const from = raw.indexOf('[')
  const to = raw.lastIndexOf(']')
  if (from >= 0 && to > from) {
    const sliced = tryParse(raw.slice(from, to + 1))
    if (sliced) return sliced
  }
  return null
}

/**
 * 解析响应。条目数与请求不一致时**抛错**,由调用方降级(绝不把少一条的结果回填进 HTML)。
 * @param {string} kind
 * @param {any} json 已解析的响应体
 * @param {number} count 期望条数
 * @returns {string[]}
 */
function parseResponse(kind, json, count) {
  const out = []
  if (kind === 'openai') {
    const err = json && json.error && (json.error.message || json.error)
    if (err) throw new Error(`服务端报错:${typeof err === 'string' ? err : JSON.stringify(err)}`)
    const content = json && json.choices && json.choices[0] && json.choices[0].message
      ? json.choices[0].message.content
      : ''
    const arr = extractArray(content)
    if (!arr) throw new Error('模型没有返回可解析的 JSON')
    for (const item of arr) {
      out.push(typeof item === 'string' ? item : String((item && (item.t != null ? item.t : item.text)) || ''))
    }
  } else if (kind === 'deepl') {
    if (json && json.message) throw new Error(`服务端报错:${json.message}`)
    const arr = (json && json.translations) || []
    for (const t of arr) out.push(glossary.unwrapTerms(t && t.text))
  } else {
    const err = json && json.error && (json.error.message || json.error)
    if (err) throw new Error(`服务端报错:${typeof err === 'string' ? err : JSON.stringify(err)}`)
    const arr = (json && json.data && json.data.translations) || []
    for (const t of arr) out.push(glossary.unwrapTerms(unescapeBasics(t && t.translatedText)))
  }
  if (count != null && out.length !== count) {
    throw new Error(`返回条目数不符(期望 ${count},实际 ${out.length})`)
  }
  return out
}

module.exports = {
  KINDS,
  BATCH_LIMIT,
  KIND_LABEL,
  LANG_LABEL,
  buildRequest,
  parseResponse,
  extractArray,
  order,
  batchLimit,
  providerId,
  usable,
  deeplTarget,
  googleTarget,
  unescapeBasics
}
