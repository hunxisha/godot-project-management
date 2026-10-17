// 市场文案翻译的渲染层状态(模块级单例)。
//
// 为什么是单例:市场页被 `<KeepAlive include="MarketplaceView">` 常驻(App.vue:121),
// 但详情弹层、设置页返回、切页回来都会重建局部状态。译文如果放在组件里,
// 切一次页就要重翻一次 —— 缓存虽然能兜住,可每一批都要多走一次 IPC。
//
// 这一层只管三件事:
//   1. 决定哪些文案要送(过滤空串、已是目标语言的、已在途的、刚失败过的);
//   2. 串行排队(同时只允许一个翻译请求在飞,见设计定稿 Q4);
//   3. 把结果按 `目标语言::key` 存起来 —— 语言进入键空间,切换语言不会串台。
//
// 缓存/服务商/失败策略全在 preload(translate.js),这里不重复判一遍。
import { computed, reactive, ref } from 'vue'
import { getSettings, saveSettings } from '../services/bridge'
import { DEFAULT_SETTINGS, type GodotSettings } from '../types/godot'
import { isMostlyTargetLang } from '../utils/langDetect'

/** 要送翻的一段文案 */
export interface TransItem {
  /** 调用方自己定的稳定键(如 `card:publisher/slug`),只用于回填 */
  key: string
  text: string
  /** 资产 id:有它才会走缓存 */
  assetId?: string
  kind?: 'desc' | 'html' | 'changes'
}

/** 设置(与设置页共享同一份 db 文档,写回即持久化) */
const settings = reactive<GodotSettings>({ ...DEFAULT_SETTINGS })
let settingsLoaded = false

/** 译文表:`语言::key` → 译文 */
const translated = reactive<Record<string, string>>({})
/** 在途的 key,防重复排队 */
const pending = reactive(new Set<string>())
/** 失败过的 key → 时间戳(只用于界面提示,真正的抑制在 preload) */
const failed = reactive<Record<string, number>>({})
/** 队列里是否还有活 */
const running = ref(false)
/** 最近一次失败原因(详情页脚注与市场页提示共用) */
const lastError = ref('')

/** 当前目标语言 */
const target = computed(() => settings.translateTarget || 'zh-CN')

/** 翻译是否启用(市场页头部的「中文 / 原文」直接改这个字段) */
const enabled = computed(() => settings.translateEnabled === true)

function tk(key: string): string {
  return `${target.value}::${key}`
}

/**
 * 某 key 的译文(没有就返回原文)。
 *
 * 「是否启用」要在**读取时**判:关掉翻译后译文仍在表里(重新打开要秒回),
 * 但界面必须立刻回原文 —— 以前这里不看开关,于是「点原文没反应」。
 */
function textOf(key: string, original: string): string {
  if (!enabled.value) return original
  return translated[tk(key)] || original
}

/** 某 key 是否正在显示译文(关闭翻译时一律 false,hover 提示与角标都靠它) */
function hasText(key: string): boolean {
  if (!enabled.value) return false
  return !!translated[tk(key)]
}

/** 某 key 是否失败过(界面据此挂「原文」角标) */
function isFailed(key: string): boolean {
  return !!failed[key]
}

/** 读一次设置(首次调用时;设置页保存后会显式 refresh) */
async function refresh(): Promise<GodotSettings> {
  const s = await getSettings()
  Object.assign(settings, s)
  settingsLoaded = true
  return settings
}

/** 确保设置已加载 */
async function ensureSettings(): Promise<GodotSettings> {
  if (!settingsLoaded) await refresh()
  return settings
}

/**
 * 设置被改动后调用:清掉本地失败标记,让下次进入页面重新尝试。
 * (preload 侧的暂停/抑制也在保存时复位,见 services 的 translateParts 前的设置写入)
 */
function resetFailed() {
  for (const k of Object.keys(failed)) delete failed[k]
  lastError.value = ''
}

/** 切换启用状态(市场页头部 seg 与设置页总开关共用) */
async function setEnabled(on: boolean) {
  settings.translateEnabled = on
  try {
    await saveSettings({ translateEnabled: on })
  } catch (e) {
    // 保存失败时把界面状态退回去,避免「看着开了、其实没存」
    settings.translateEnabled = !on
    throw e
  }
  if (on) resetFailed()
}

// ---------- 队列 ----------

interface Job {
  items: TransItem[]
  scene: 'short' | 'long'
}

const queue: Job[] = []
let pumping = false

/** 哪些条目需要送翻:非空、非目标语言、没译文、没在途、没失败 */
function select(items: TransItem[]): TransItem[] {
  const out: TransItem[] = []
  for (const it of items) {
    const text = String(it.text || '')
    if (!text.trim()) continue
    if (isMostlyTargetLang(text, target.value)) continue
    if (translated[tk(it.key)]) continue
    if (pending.has(it.key)) continue
    if (failed[it.key]) continue
    out.push({ ...it, text })
  }
  return out
}

/** 把一批文案排进队列(已在队列/在途的自动去重) */
function translate(items: TransItem[], scene: 'short' | 'long' = 'short') {
  // 关掉翻译就一个请求都不发:显示层已经不看了,翻出来纯属烧额度
  if (!enabled.value) return
  const todo = select(items)
  if (!todo.length) return
  for (const it of todo) pending.add(it.key)
  queue.push({ items: todo, scene })
  void pump()
}

async function pump() {
  if (pumping) return
  pumping = true
  running.value = true
  try {
    while (queue.length) {
      const job = queue.shift() as Job
      const keys = job.items.map((i) => i.key)
      let res: any = null
      try {
        res = await window.services.translateParts({ target: target.value, scene: job.scene, items: job.items })
      } catch (e: any) {
        // 宿主没实现 / IPC 抛错:当作一次失败,但不进 failed(否则重试不了)
        lastError.value = e?.message || String(e)
      }
      for (const k of keys) pending.delete(k)
      if (!res) continue
      if (res.ok) {
        for (const it of res.items || []) translated[tk(it.key)] = it.text
      }
      const bad: string[] = Array.isArray(res.failed) ? res.failed : []
      for (const k of bad) failed[k] = Date.now()
      lastError.value = res.error || (bad.length ? `${bad.length} 条未翻译` : '')
    }
  } finally {
    pumping = false
    running.value = false
  }
}

/** 清空本地译文表(切换语言/清缓存后用;语言维度已在键里,通常不需要) */
function clearLocal() {
  for (const k of Object.keys(translated)) delete translated[k]
  for (const k of Object.keys(failed)) delete failed[k]
  pending.clear()
  lastError.value = ''
}

/** 失败条目数(市场页「N 条未翻译」用) */
const failedCount = computed(() => Object.keys(failed).length)

/** 是否有翻译在途 */
const busy = computed(() => running.value || queue.length > 0)

export function useTranslation() {
  return {
    settings,
    target,
    enabled,
    translated,
    busy,
    failedCount,
    lastError,
    textOf,
    hasText,
    isFailed,
    translate,
    refresh,
    ensureSettings,
    setEnabled,
    resetFailed,
    clearLocal
  }
}
