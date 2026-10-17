// 翻译编排:选服务商 → 查缓存 → 分片请求 → 写缓存 → 回落与暂停。
//
// 这一层是唯一同时知道「缓存」「服务商」「失败策略」三件事的地方;
// 渲染层只递一批 {key, text, assetId, kind},拿回 {key, text} —— 中间发生了什么
// (命中缓存、换了服务商、某几条进了抑制表)由这里决定,并且只在返回值里体现。
//
// 失败策略(见设计定稿):
//   · 401/403 → 致命:暂停 10 分钟,避免用户改配置前每翻一页烧一次钱;
//   · 429/5xx/超时 → 单次重试(退避 1s),仍失败就换下一个服务商;
//   · 部分成功 → 成功条目写缓存,失败条目进**内存**抑制表(不落盘,重启即恢复);
//   · HTML 回填校验失败 → 整段回落原文,不写缓存。
const { getDoc } = require('./store')
const http = require('./http')
const providers = require('./transproviders')
const cache = require('./transcache')
const html = require('./transhtml')

/** 致命错误后的暂停时长 */
const SUSPEND_MS = 10 * 60 * 1000
/** 失败条目的内存抑制时长 */
const FAIL_SUPPRESS_MS = 10 * 60 * 1000
/** 单次请求超时 */
const TIMEOUT_MS = 20000

/** 暂停截止时间与原因(进程内,不落盘) */
let suspendUntil = 0
let suspendReason = ''
/** 暂停时的配置指纹:用户一改设置(换 Key/加服务商)就自动解除暂停 */
let suspendSig = ''
/** 失败条目 key → 失败时间 */
const recentFailures = new Map()

/**
 * 配置指纹:只看会影响鉴权与端点的字段
 * @param {any} s
 * @returns {string}
 */
function signatureOf(s) {
  const list = providersOf(s).map((p) =>
    `${p.id || ''}|${p.kind}|${p.model || ''}|${p.baseUrl || ''}|${String(p.apiKey || '').slice(-4)}|${p.plan || ''}`
  )
  return list.join('~') + '#' + (s.translateActiveId || '')
}

/** 读设置:每次现读,设置页保存后立即生效(与 http.js 的 currentProxy 同一策略) */
function settings() {
  return getDoc('godot/settings') || {}
}

/**
 * 只取结构合法的服务商条目
 * @param {any} s
 * @returns {any[]}
 */
function providersOf(s) {
  /** @type {any[]} */
  const raw = Array.isArray(s.translateProviders) ? s.translateProviders : []
  return raw.filter((p) => p && p.kind)
}

/**
 * 错误信息统一成一句人话
 * @param {any} e
 * @returns {string}
 */
function msgOf(e) {
  return (e && (e.message || String(e))) || '翻译失败'
}

/**
 * 该条目是否还在抑制期
 * @param {string} key
 * @returns {boolean}
 */
function suppressed(key) {
  const at = recentFailures.get(key)
  if (!at) return false
  if (Date.now() - at > FAIL_SUPPRESS_MS) {
    recentFailures.delete(key)
    return false
  }
  return true
}

/**
 * 标记失败(顺带清掉过期的键,防止 Map 无限增长)
 * @param {string} key
 */
function markFailure(key) {
  const now = Date.now()
  recentFailures.set(key, now)
  if (recentFailures.size > 500) {
    for (const [k, at] of recentFailures) {
      if (now - at > FAIL_SUPPRESS_MS) recentFailures.delete(k)
    }
  }
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/** 设置变更后清掉暂停标记(设置页保存时调,CACHE 之外的唯一复位入口) */
function resetSuspend() {
  suspendUntil = 0
  suspendReason = ''
  recentFailures.clear()
  return true
}

/**
 * 调一次服务商,网络类错误重试一次(致命错误不重试)。
 * @param {any} p
 * @param {string[]} texts
 * @param {{target: string, terms: string[]}} opts
 * @returns {Promise<string[]>}
 */
async function callProvider(p, texts, opts) {
  let last
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const req = providers.buildRequest(p, texts, opts)
      const json = await http.postJson(req.url, req.body, req.headers, { timeoutMs: TIMEOUT_MS })
      return providers.parseResponse(req.kind, json, texts.length)
    } catch (e) {
      last = e
      const fatal = !!(e && (e.status === 401 || e.status === 403))
      if (fatal || attempt === 1) throw e
      await sleep(1000)
    }
  }
  throw last || new Error('翻译失败')
}

/**
 * 批量翻译入口(对渲染层与 services.js 暴露的唯一入口)。
 * @param {{target?: string, scene?: string, items?: {key: string, text: string, assetId?: string, kind?: string}[]}} [payload]
 * @returns {Promise<{ok: boolean, items: {key: string, text: string}[], failed: string[], error?: string, paused?: boolean, noProvider?: boolean, fromCache?: number}>}
 */
async function translateParts(payload = {}) {
  const items = (Array.isArray(payload.items) ? payload.items : [])
    .filter((i) => i && i.key && typeof i.text === 'string')
  const keys = items.map((i) => i.key)
  if (!items.length) return { ok: true, items: [], failed: [], fromCache: 0 }

  const s = settings()
  if (s.translateEnabled !== true) {
    return { ok: false, error: '翻译未启用', items: [], failed: keys }
  }
  // 用户改过设置(换了 Key 或加了服务商)就解除暂停 —— 提示里承诺的「改完自动恢复」
  if (suspendUntil && signatureOf(s) !== suspendSig) resetSuspend()
  if (Date.now() < suspendUntil) {
    return { ok: false, error: suspendReason || '翻译已暂停(请检查密钥或稍后重试)', items: [], failed: keys, paused: true }
  }

  const target = payload.target || s.translateTarget || 'zh-CN'
  const scene = payload.scene === 'long' ? 'long' : 'short'
  const list = providers.order(providersOf(s), s.translateActiveId || '', scene)
  if (!list.length) {
    return { ok: false, error: '没有可用的翻译服务商,请先到设置里配置', items: [], failed: keys, noProvider: true }
  }
  const terms = Array.isArray(s.translateGlossary) ? s.translateGlossary : []

  // ---------- 1. 展开成工作单元(HTML 拆成文本节点,一个节点一个单元) ----------
  /** @type {{key: string, slot: number, text: string, assetId: string, kind: string}[]} */
  const units = []
  for (const item of items) {
    // changes(更新日志)与 body_html 一样是富文本:都要按 HTML 拆合,
    // 只是缓存键里的 kind 分开,免得同一资产的简介与日志互相覆盖。
    const isHtml = item.kind === 'html' || item.kind === 'changes'
    const kind = isHtml ? (item.kind === 'changes' ? 'changes' : 'html') : 'desc'
    // 记下本条目第一个单元的下标:回填时按 base + 序号取,不用二次查找
    const base = units.length
    // @ts-ignore 同一次调用内的临时字段
    item._base = base
    // @ts-ignore
    item._isHtml = isHtml
    if (isHtml) {
      const split = html.splitHtml(item.text)
      // @ts-ignore
      item._split = split
      split.texts.forEach((t, n) => units.push({
        key: item.key, slot: n, text: t, assetId: item.assetId || '', kind
      }))
    } else {
      units.push({ key: item.key, slot: -1, text: item.text, assetId: item.assetId || '', kind })
    }
  }

  // ---------- 2. 查缓存 ----------
  /** @type {Map<string, any[]>} assetId → entries */
  const cacheMap = new Map()
  const primaryId = providers.providerId(list[0])
  /** @type {Map<number, string>} 单元下标 → 译文 */
  const resolved = new Map()
  /** 命中缓存的下标集合:写缓存时跳过它们,省掉无谓的 putDoc */
  const cachedIdx = new Set()
  units.forEach((u, i) => {
    if (!u.assetId) return
    if (!cacheMap.has(u.assetId)) cacheMap.set(u.assetId, cache.readEntries(u.assetId))
    const entries = cacheMap.get(u.assetId) || []
    const text = cache.matchEntry(entries, {
      kind: u.kind, lang: target, provider: primaryId, srcHash: cache.hashText(u.text)
    })
    if (text != null) {
      resolved.set(i, text)
      cachedIdx.add(i)
    }
  })

  // ---------- 3. 未命中的分片请求(按服务商优先级回落) ----------
  /** @type {{i: number, u: any}[]} */
  let pending = []
  units.forEach((u, i) => {
    if (resolved.has(i)) return
    if (u.assetId && suppressed(`${u.assetId}|${u.kind}`)) return
    pending.push({ i, u })
  })

  /** @type {{provider: string, message: string}[]} */
  const errors = []
  let fatal = null
  /** 实际出过力的服务商(写缓存用它的 id) */
  let used = null

  for (const p of list) {
    if (!pending.length) break
    if (fatal) break
    while (pending.length) {
      const chunk = pending.slice(0, providers.batchLimit(p))
      try {
        const out = await callProvider(p, chunk.map((x) => x.u.text), { target, terms })
        chunk.forEach((x, n) => resolved.set(x.i, out[n]))
        used = p
        pending.splice(0, chunk.length)
      } catch (e) {
        errors.push({ provider: providers.providerId(p), message: msgOf(e) })
        if (e && (e.status === 401 || e.status === 403)) {
          // 密钥错:再翻下去每一条都是 401,直接停手
          fatal = e
          suspendUntil = Date.now() + SUSPEND_MS
          suspendSig = signatureOf(s)
          suspendReason = `翻译已暂停:${msgOf(e)}(密钥无效或无权限,改完设置后自动恢复)`
          pending = []
          break
        }
        // 非致命:换下一个服务商承接这批,已成功的部分保留
        break
      }
    }
  }

  // ---------- 4. 写缓存(成功的、非 HTML 单元的原文哈希) ----------
  /** @type {Map<string, any[]>} assetId → 新条目 */
  const toWrite = new Map()
  const writeProvider = providers.providerId(used || list[0])
  units.forEach((u, i) => {
    if (!u.assetId || !resolved.has(i) || cachedIdx.has(i)) return
    const list2 = toWrite.get(u.assetId) || []
    list2.push({ kind: u.kind, lang: target, provider: writeProvider, srcHash: cache.hashText(u.text), text: resolved.get(i) })
    toWrite.set(u.assetId, list2)
  })
  for (const [assetId, entries] of toWrite) cache.upsert(assetId, entries)

  // ---------- 5. 按 owner 拼回返回值 ----------
  /** @type {{key: string, text: string}[]} */
  const out = []
  /** @type {string[]} */
  const failed = []
  for (const item of items) {
    const src = String(item.text || '')
    // @ts-ignore 展开时记下的首个单元下标
    const base = item._base
    // @ts-ignore 富文本标记(html 与 changes 都走拆合)
    if (item._isHtml) {
      // @ts-ignore 上面挂的切分结果
      const split = item._split
      if (!split || !split.indexes.length) {
        // 没有可翻的文本节点(纯图/纯代码):原样返回,不算失败
        out.push({ key: item.key, text: src })
        continue
      }
      const parts = []
      let missing = false
      for (let n = 0; n < split.indexes.length; n++) {
        const text = resolved.get(base + n)
        if (text == null) { missing = true; break }
        parts.push(text)
      }
      if (missing) {
        failed.push(item.key)
        continue
      }
      const merged = html.mergeHtml(split, parts)
      if (!merged.ok) {
        failed.push(item.key)
        continue
      }
      out.push({ key: item.key, text: merged.html })
      continue
    }
    const text = resolved.get(base)
    if (text == null) {
      failed.push(item.key)
      if (item.assetId) markFailure(`${item.assetId}|${item.kind || 'desc'}`)
      continue
    }
    out.push({ key: item.key, text })
  }

  const errorText = fatal
    ? suspendReason
    : (errors.length && out.length === 0 ? errors[0].message : '')
  return {
    ok: out.length > 0,
    items: out,
    failed,
    fromCache: cachedIdx.size,
    error: errorText || undefined,
    paused: !!fatal
  }
}

/**
 * 设置页「测试连接」:发一句 Hello,把耗时与回译样本带回去。
 * @param {any} cfg {kind, baseUrl, apiKey, model, plan}
 * @returns {Promise<{ok: boolean, ms?: number, sample?: string, error?: string, status?: number}>}
 */
async function testTranslateProvider(cfg) {
  const p = { ...(cfg || {}) }
  if (!providers.usable(p)) {
    return { ok: false, error: p.kind === 'openai' ? '需要填写 Base URL' : '需要填写 API Key' }
  }
  const started = Date.now()
  try {
    const out = await callProvider(p, ['Hello, world'], { target: 'zh-CN', terms: [] })
    return { ok: true, ms: Date.now() - started, sample: out[0] || '' }
  } catch (e) {
    // @ts-ignore 状态码透传:设置页据此把「密钥错」与「网络不通」分开说
    return { ok: false, error: msgOf(e), status: e && e.status }
  }
}

/** 缓存统计(设置页显示 N 条 / X KB) */
function translateCacheInfo() {
  return cache.stats()
}

/** 清空译文缓存 */
function translateCacheClear() {
  return cache.clear()
}

module.exports = {
  translateParts,
  testTranslateProvider,
  translateCacheInfo,
  translateCacheClear,
  resetSuspend,
  // 测试用:内部状态复位
  _internals: { recentFailures, get suspendUntil() { return suspendUntil }, SUSPEND_MS, FAIL_SUPPRESS_MS }
}
