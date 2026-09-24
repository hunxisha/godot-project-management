// 主题系统回归测试(静态分析 src/main.css,无需浏览器)。
//
// 主题是「色板 × 明暗」的组合,最容易出的问题是**某一块漏了令牌**或**某组配色对比度不足**——
// 这两类问题在界面上往往只表现为「某个角落颜色怪怪的」,很难靠肉眼穷举 10 种组合。
// 所以这里直接解析 CSS 并逐组合校验。
//
// 用法:npm run test:theme
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CSS_PATH = path.resolve(__dirname, '../main.css')

const THEMES = ['steel', 'graphite', 'forest', 'violet', 'amber']
const MODES = ['light', 'dark']
/** 每个「色板 × 明暗」组合都必须完整定义的色彩令牌 */
const PALETTE_TOKENS = [
  '--brand', '--brand-strong', '--brand-deep', '--brand-weak', '--brand-grad',
  '--bg', '--surface', '--surface-2', '--surface-3',
  '--border', '--border-strong',
  '--text', '--text-2', '--text-3'
]
/** 语义色与头像渐变:设计上不随色板变化 */
const MODE_TOKENS = ['--danger', '--danger-weak', '--ok', '--ok-weak', '--warn', '--warn-weak', '--gold', '--gold-weak']
const FIXED_TOKENS = ['--grad-a', '--grad-b', '--grad-c', '--grad-d', '--mono', '--radius', '--radius-sm', '--radius-lg']

let pass = 0
const failures = []
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log(`  PASS  ${label}`) }
  else { failures.push(label); console.log(`  FAIL  ${label}${extra !== undefined ? '  → ' + extra : ''}`) }
}
const section = (t) => console.log(`\n=== ${t} ===`)

// ---------- 解析 ----------

const css = readFileSync(CSS_PATH, 'utf-8')
// 先剥掉注释:注释里也含「:」(如 `浅色:语义色`),会让按 ; 切分后的前缀解析错位
const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, '')

/** 取出所有 :root… 规则块 */
function parseBlocks(source) {
  const blocks = []
  const re = /(:root(?:\[[^\]]+\])*)\s*\{([^}]*)\}/g
  let m
  while ((m = re.exec(source)) !== null) {
    const selector = m[1]
    const tokens = {}
    for (const decl of m[2].split(';')) {
      const i = decl.indexOf(':')
      if (i < 0) continue
      const name = decl.slice(0, i).trim()
      if (!name.startsWith('--')) continue
      tokens[name] = decl.slice(i + 1).trim()
    }
    const attrs = [...selector.matchAll(/\[([a-z-]+)='([^']+)'\]/g)].map((a) => [a[1], a[2]])
    blocks.push({ selector, attrs, tokens, index: blocks.length })
  }
  return blocks
}

const blocks = parseBlocks(cssNoComments)
ok(blocks.length >= 10, `解析到 ${blocks.length} 个 :root 规则块`)

/** 特异性:伪类 + 属性选择器个数(:root 记 1) */
function specificity(block) {
  return 1 + block.attrs.length
}

/** 模拟层叠:取所有命中该组合的块,按(特异性, 源序)升序覆盖 */
function resolve(theme, mode) {
  const out = {}
  const hits = blocks
    .filter((b) => b.attrs.every(([k, v]) => (k === 'data-theme' ? v === theme : k === 'data-mode' ? v === mode : false)))
    .sort((a, b) => specificity(a) - specificity(b) || a.index - b.index)
  for (const b of hits) Object.assign(out, b.tokens)
  return out
}

// ---------- 颜色与对比度 ----------

function parseColor(v) {
  const s = String(v).trim()
  let m = /^#([0-9a-f]{6})$/i.exec(s)
  if (m) {
    const n = parseInt(m[1], 16)
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 }
  }
  m = /^#([0-9a-f]{3})$/i.exec(s)
  if (m) {
    const h = m[1]
    return { r: parseInt(h[0] + h[0], 16), g: parseInt(h[1] + h[1], 16), b: parseInt(h[2] + h[2], 16), a: 1 }
  }
  m = /^rgba?\(([^)]+)\)$/i.exec(s)
  if (m) {
    const p = m[1].split(',').map((x) => parseFloat(x.trim()))
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }
  }
  return null
}

function relLum({ r, g, b }) {
  const f = (c) => {
    const x = c / 255
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

/** WCAG 对比度 */
function contrast(a, b) {
  const la = relLum(a)
  const lb = relLum(b)
  const hi = Math.max(la, lb)
  const lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}

/** 取渐变里的两个色标(#rrggbb) */
function gradientStops(value) {
  return [...String(value).matchAll(/#[0-9a-f]{6}/gi)].map((m) => parseColor(m[0]))
}

const WHITE = { r: 255, g: 255, b: 255 }
const ratio = (x, y) => contrast(parseColor(x), parseColor(y))

// ---------- 1. 令牌完整性 ----------

section('1. 令牌完整性(每个色板 × 明暗组合)')
const resolved = {}
for (const theme of THEMES) {
  for (const mode of MODES) {
    const key = `${theme}/${mode}`
    const t = resolve(theme, mode)
    resolved[key] = t
    const missing = PALETTE_TOKENS.filter((k) => !t[k])
    ok(missing.length === 0, `${key} 定义全部 ${PALETTE_TOKENS.length} 个色彩令牌`, missing.join(', '))
    const bad = PALETTE_TOKENS.filter((k) => t[k] && !parseColor(t[k]) && !String(t[k]).includes('gradient'))
    ok(bad.length === 0, `${key} 令牌值可解析(颜色或渐变)`, bad.join(', '))
  }
}

section('2. 语义色与结构令牌')
for (const mode of MODES) {
  const t = resolve('steel', mode)
  const missing = MODE_TOKENS.filter((k) => !t[k])
  ok(missing.length === 0, `${mode} 定义全部语义色`, missing.join(', '))
}
const rootTokens = resolve('steel', 'light')
ok(FIXED_TOKENS.every((k) => rootTokens[k]), '结构/头像渐变令牌已定义', FIXED_TOKENS.filter((k) => !rootTokens[k]).join(', '))

section('3. 设计约束:语义色与头像渐变不随色板变化')
for (const theme of THEMES) {
  for (const mode of MODES) {
    const t = resolved[`${theme}/${mode}`]
    const ref = resolved[`steel/${mode}`]
    const drifted = [...MODE_TOKENS, ...FIXED_TOKENS].filter((k) => t[k] && t[k] !== ref[k])
    ok(drifted.length === 0, `${theme}/${mode} 语义色与结构令牌未被色板改写`, drifted.join(', '))
  }
}

// ---------- 4. 对比度 ----------

section('4. 对比度(WCAG)')
const MIN = {
  'text/surface': 7.0,
  'text/bg': 7.0,
  'text-2/surface': 4.5,
  'text-2/bg': 4.5,
  'text-3/surface': 3.0,
  'brand/surface': 3.0,
  'border/surface': 1.15,
  'surface/bg': 1.05
}

const worst = {}
for (const theme of THEMES) {
  for (const mode of MODES) {
    const key = `${theme}/${mode}`
    const t = resolved[key]
    const pairs = {
      'text/surface': [t['--text'], t['--surface']],
      'text/bg': [t['--text'], t['--bg']],
      'text-2/surface': [t['--text-2'], t['--surface']],
      'text-2/bg': [t['--text-2'], t['--bg']],
      'text-3/surface': [t['--text-3'], t['--surface']],
      'brand/surface': [t['--brand'], t['--surface']],
      'border/surface': [t['--border'], t['--surface']],
      'surface/bg': [t['--surface'], t['--bg']]
    }
    const lines = []
    for (const [name, [fg, bg]] of Object.entries(pairs)) {
      const c = ratio(fg, bg)
      if (!worst[name] || c < worst[name].c) worst[name] = { c, key }
      lines.push(`${name}=${c.toFixed(2)}`)
      ok(c >= MIN[name], `${key} ${name} ≥ ${MIN[name]}`, c.toFixed(2))
    }
    // primary 按钮是白字压在 --brand-grad 上:两端色标都要求可读
    const stops = gradientStops(t['--brand-grad'])
    ok(stops.length === 2, `${key} --brand-grad 含两个色标`, String(t['--brand-grad']))
    const stopRatios = stops.map((s) => contrast(WHITE, s))
    const minStop = Math.min(...stopRatios)
    ok(minStop >= 2.5, `${key} 白字在 brand-grad 两端 ≥ 2.5`, stopRatios.map((x) => x.toFixed(2)).join(' / '))
    console.log(`        ${key.padEnd(16)} ${lines.join('  ')}  白字渐变=${stopRatios.map((x) => x.toFixed(2)).join('/')}`)
  }
}

section('5. 最差项汇总(供设计参考)')
for (const [name, w] of Object.entries(worst)) {
  console.log(`        ${name.padEnd(16)} 最低 ${w.c.toFixed(2)}  (${w.key})`)
}

console.log(`\n${'='.repeat(56)}`)
console.log(`PASS ${pass}  FAIL ${failures.length}`)
if (failures.length) {
  console.log('失败项:')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log('全部通过')
