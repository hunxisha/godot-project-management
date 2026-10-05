// 凭据形态识别(纯函数,可单测)。设计见 docs/tools-page-plan.md 第五部分 #18。
//
// 这个模块存在的**第一理由不是识别,是掩码**:命中串一旦原样进入结论,它就会随 DOM、折叠状态、
// 将来的报告导出再复制一份 —— 用户来找泄漏,我们替他扩散泄漏。
// 所以这里给出的 `SecretHit` **刻意不含原文**,只带形态、行号、掩码与长度。
//
// 三档形态,精度递减、定级也递减:
//   · 私钥块 / 厂商写死的前缀(AWS、GitHub、Google、Slack、Stripe、SendGrid)= 撞上基本是真的 → error;
//   · 「关键词赋值 + 高熵值」= 变量名撞 `token`/`secret` 的情况太多 → 只给 warn,
//     并且要求值里至少有一个数字(没数字的一律当占位符或变量名,这是本档刻意接受的漏报)。
//
// 占位符豁免只作用于关键词档:前缀形态不接受豁免(`AKIA…` 这种串没有正当的占位符写法)。

export type SecretKind = 'private-key' | 'known-prefix' | 'keyword'

export interface SecretHit {
  kind: SecretKind
  /** 人类可读的形态名(不含原文) */
  label: string
  /** 1-based 行号 */
  line: number
  /** 掩码后的值(私钥块这类没有「值」的形态给形态名) */
  masked: string
  /** 命中值长度;私钥块给 0 */
  length: number
}

const PRIVKEY_RE = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/

/**
 * 厂商写死的形态:label + 正则。前缀一个字都别改 —— 改了就不是同一家的串了。
 *
 * ⚠ 每条都**必须带 `g`**:上层的 while 靠 `exec` 推进 `lastIndex` 来取一行里的多处命中,
 * 非全局正则的 `exec` 永远从 0 开始、永远返回同一个匹配 —— 那样写就是死循环(本仓实测踩过)。
 */
const PREFIX_RULES: { label: string; re: RegExp }[] = [
  { label: 'AWS Access Key ID', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { label: 'GitHub token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/g },
  { label: 'Google API key', re: /\bAIza[0-9A-Za-z\-_]{35}\b/g },
  { label: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { label: 'Stripe key', re: /\bsk_(?:live|test)_[0-9a-zA-Z]{16,}\b/g },
  { label: 'SendGrid key', re: /\bSG\.[A-Za-z0-9_\-]{30,}\b/g }
]

// 关键词档:键名里带凭据味的这些词,后面跟一个引号串或裸长串。
// 值至少要 12 个字符才进入判定(是否占位符由 looksPlaceholder 二次筛,那里还有长度线)。
const KEYWORD_RE = new RegExp(
  '(?:api[_-]?key|apikey|access[_-]?key|client[_-]?secret|secret|auth[_-]?token|access[_-]?token|' +
  'private[_-]?key|token|password|passwd|pwd|bearer)' +
  '[ \\t]*(?:=|:)\\s*(?:"([^"\\n]{12,})"|\'([^\'\\n]{12,})\'|([A-Za-z0-9+/_\\-.=]{16,}))',
  'gi'
)

/** 命中值的长度下限(低于它一律当短值/变量名,不进关键词档) */
const MIN_SECRET_LEN = 16

/** 占位符前缀:教程代码与示例配置里的常见写法,撞上就一条都不发 */
const PLACEHOLDER_HEADS = [
  'your', 'yours', 'my_', 'mys_', 'test_', 'sample', 'example', 'dummy', 'fake',
  'placeholder', 'changeme', 'change_me', 'replace', 'todo', 'tbd', 'fixme', 'xxx', 'n/a', 'na_',
  'none', 'null', 'empty', 'default', 'insert', 'put_', 'set_'
]

/**
 * 这个串像不像「填了个占位符」而不是真凭据?
 *
 * 判不出来的那一侧(比如项目自己发明的 `P-0521-ABCDE` 这种无数字串)会被放行,
 * 反过来所有纯字母的密钥会被**漏掉** —— 这是关键词档刻意接受的取舍:
 * 教程代码里 `token = "myapitokenhere"` 报一条 warn,用户只会把整张卡当噪声。
 */
export function looksPlaceholder(v: string): boolean {
  if (typeof v !== 'string' || !v) return true
  const s = v.trim()
  if (s.length < MIN_SECRET_LEN) return true
  // 模板 / 尖括号 / 空白 / 非 ASCII:这些一律是「给人看的占位」而不是凭据
  if (/[<>{}$`]/.test(s) || /\s/.test(s) || /[^\x00-\x7F]/.test(s)) return true
  const lower = s.toLowerCase()
  if (PLACEHOLDER_HEADS.some((p) => lower.startsWith(p))) return true
  if (/(_|-)?(here|example|placeholder|dummy)$/i.test(lower)) return true
  // 全同一个字符(带少量分隔符也算):`xxxx…`、`aaaa…`
  const stripped = lower.replace(/[._\-]/g, '')
  if (/^(.)\1*$/.test(stripped)) return true
  // 关键词档要求至少有一个数字(见上的取舍说明)
  return !/[0-9]/.test(s)
}

/** `AKIA` + 16 位的形态 → `AKIA•••LE(20)`:够人眼定位是哪一条,不够还原。短值只报长度 */
export function maskSecret(value: string): string {
  const s = typeof value === 'string' ? value : ''
  if (!s) return '(空值)'
  const n = s.length
  if (n <= 8) return `••••(${n})`
  if (n < 12) return `${s.slice(0, 2)}•••(${n})`
  return `${s.slice(0, 4)}•••${s.slice(-2)}(${n})`
}

/**
 * 扫一份文本,按行给出命中。**返回的对象里没有原文**,只有掩码。
 *
 * 同一行上三档都可能命中同一个串(`aws_key = "AKIA…"` 既是关键词档也是前缀档)。
 * 这里按 (行, 值) 去重并**保留更高档** —— 否则同一条泄漏会在卡面上出现两次,
 * 而刷屏上限(LIST_CAP)也被自己人占掉一格。
 */
export function scanSecretsInText(text: string): SecretHit[] {
  if (typeof text !== 'string' || !text) return []
  const TIER: Record<SecretKind, number> = { 'private-key': 0, 'known-prefix': 1, 'keyword': 2 }
  const rows = text.split(/\r?\n/)
  const out: SecretHit[] = []
  const seen = new Set<string>()

  const push = (hit: SecretHit, rawValue: string | null) => {
    const key = `${hit.line}\u0000${rawValue === null ? hit.label : rawValue}`
    if (seen.has(key)) return
    // 同一行同一个值,先到先得:行内先扫前缀/私钥,再扫关键词,所以高档先入
    seen.add(key)
    out.push(hit)
  }

  for (let i = 0; i < rows.length; i++) {
    const line = rows[i]
    if (!line) continue
    const lineNo = i + 1

    const pk = PRIVKEY_RE.exec(line)
    if (pk) push({ kind: 'private-key', label: '私钥块', line: lineNo, masked: '私钥块(内容不外露)', length: 0 }, null)

    for (const r of PREFIX_RULES) {
      r.re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = r.re.exec(line)) !== null) {
        push({ kind: 'known-prefix', label: r.label, line: lineNo, masked: maskSecret(m[0]), length: m[0].length }, m[0])
        if (m.index === r.re.lastIndex) r.re.lastIndex++
      }
    }

    KEYWORD_RE.lastIndex = 0
    let k: RegExpExecArray | null
    while ((k = KEYWORD_RE.exec(line)) !== null) {
      const value = k[1] || k[2] || k[3]
      if (!value || looksPlaceholder(value)) continue
      push({ kind: 'keyword', label: '疑似凭据赋值', line: lineNo, masked: maskSecret(value), length: value.length }, value)
    }
  }

  // 去重后再排一次:同一行里私钥/前缀排在关键词之前,便于上层按档截断
  return out.sort((a, b) => a.line - b.line || TIER[a.kind] - TIER[b.kind])
}
