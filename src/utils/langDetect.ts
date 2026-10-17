// 语言判定:只回答一个问题 —— 这段文字是不是**已经是目标语言**。
//
// 为什么要它:市场里的中文条目(国产插件/模板)翻一遍是纯浪费,而且模型可能把
// 本来就通顺的中文改写成奇怪的腔调。跳过它们的判据必须便宜且可解释,
// 所以这里不引任何语言识别库,只数书写系统的字符占比:商店文案里中英混排很常见,
// 但「汉字占字母总数的三成以上」已经足够把中文条目和英文条目录分开。
//
// 边界:纯符号/纯数字/纯代码的文本在调用方(useTranslation)就被过滤掉,不会走到这里。

/** 汉字(含扩展 A 与兼容区) */
const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g
/** 日文假名 */
const KANA = /[\u3040-\u30ff]/g
/** 谚文 */
const HANGUL = /[\uac00-\ud7af]/g
/** 拉丁字母(英/法/德/西/葡/意) */
const LATIN = /[A-Za-z]/g
/** 西里尔字母(俄) */
const CYRILLIC = /[\u0400-\u04ff]/g

/** 目标语言到「该语言用哪些书写系统」的映射;未列出的语言按拉丁处理 */
const SCRIPT: Record<string, RegExp[]> = {
  zh: [HAN],
  ja: [HAN, KANA],
  ko: [HANGUL],
  ru: [CYRILLIC]
}

/** 认定「已经是目标语言」的占比阈值:汉字三成即可,日文/韩文更低(它们混写拉丁很少) */
const THRESHOLD = 0.3

/** 数一段文本里的字母总数(各书写系统之和),0 表示没有可判定的文字 */
function lettersOf(text: string): number {
  const s = String(text == null ? '' : text)
  return (s.match(HAN) || []).length + (s.match(KANA) || []).length +
    (s.match(HANGUL) || []).length + (s.match(LATIN) || []).length +
    (s.match(CYRILLIC) || []).length
}

/**
 * 某书写系统在字母总数中的占比。
 * @param {string} text
 * @param {RegExp} re 需带 g 标志;内部会复位置零,可安全复用
 * @returns {number} 0~1;没有字母时返回 0
 */
export function scriptShare(text: string, re: RegExp): number {
  const s = String(text == null ? '' : text)
  const total = lettersOf(s)
  if (!total) return 0
  re.lastIndex = 0
  const hit = (s.match(re) || []).length
  re.lastIndex = 0
  return hit / total
}

/**
 * 这段文本是否已经是目标语言(是则不必翻)。
 * @param {string} text
 * @param {string} target BCP-47,如 zh-CN / en / ja
 * @returns {boolean}
 */
export function isMostlyTargetLang(text: string, target: string): boolean {
  const s = String(text == null ? '' : text)
  if (!s.trim()) return true
  const lang = String(target || 'zh-CN').toLowerCase()
  const primary = lang.split('-')[0]
  const scripts = SCRIPT[primary] || [LATIN]
  const share = scripts.reduce((sum, re) => sum + scriptShare(s, re), 0)
  return share >= THRESHOLD
}

/** 目标语言的中文名(界面下拉与提示文案共用一份) */
export const TARGET_LANGS: { value: string, label: string }[] = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'zh-TW', label: '繁體中文' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
  { value: 'ru', label: 'Русский' },
  { value: 'es', label: 'Español' },
  { value: 'fr', label: 'Français' },
  { value: 'de', label: 'Deutsch' }
]

/** 目标语言的显示名 */
export function langLabel(target: string): string {
  return TARGET_LANGS.find((l) => l.value === target)?.label || target || '简体中文'
}
