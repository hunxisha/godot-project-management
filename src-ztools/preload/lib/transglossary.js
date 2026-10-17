// 不译词(AI 提示词白名单)与术语占位(<x>…</x>)两种术语保护手段。
//
// 为什么两套:AI 通道可以把「这些词保持英文」写进系统提示词,模型基本会照做;
// DeepL / Google 没有提示词这一层 —— DeepL 靠 tag_handling=xml + ignore_tags,
// Google 靠 format=html 保留标签。于是同一份词表在传统通道里要变成标签包裹。
// 词表本身只有这一份(BUILTIN_TERMS),设置页的「自定义不译词」追加在它后面。

/** 内置不译词:Godot 生态里的产品名/类名/格式名。翻掉它们,读者反而认不出原物 */
const BUILTIN_TERMS = [
  'Godot', 'Godot Engine', 'GDScript', 'C#', '.NET', 'GDNative', 'GDExtension',
  'Godot Asset Library', 'Asset Library', 'Asset Store', 'AssetLib',
  'Node', 'Node2D', 'Node3D', 'SceneTree', 'Control', 'CharacterBody2D', 'CharacterBody3D',
  'Area2D', 'Area3D', 'RigidBody2D', 'RigidBody3D', 'StaticBody2D', 'TileMap', 'TileMapLayer',
  'AnimationPlayer', 'AnimationTree', 'ShaderMaterial', 'CanvasItem', 'Sprite2D', 'Sprite3D',
  'PackedScene', 'Resource', 'Signal', 'Autoload', 'Tween', 'RayCast2D', 'RayCast3D',
  'NavigationAgent2D', 'NavigationAgent3D', 'Camera2D', 'Camera3D', 'Viewport', 'SubViewport',
  'TSCN', 'GDShader', 'GDScript 2.0', 'PCK', 'ZIP', 'git', 'GitHub', 'LFS',
  'Windows', 'macOS', 'Linux', 'Android', 'iOS', 'Web', 'HTML5'
]

/**
 * 合并内置与用户自定义词表:去空、去重、按长度倒序。
 * 长词先匹配,否则 `CharacterBody2D` 会被 `Node` 之类的短词先切碎。
 * @param {string[]} [extra]
 * @returns {string[]}
 */
function allTerms(extra) {
  const seen = new Set()
  const out = []
  for (const t of [...BUILTIN_TERMS, ...(Array.isArray(extra) ? extra : [])]) {
    const s = String(t == null ? '' : t).trim()
    if (!s || seen.has(s)) continue
    seen.add(s)
    out.push(s)
  }
  return out.sort((a, b) => b.length - a.length)
}

/**
 * 整词边界判定:前后不能紧挨字母/数字,免得把 `Node` 切进 `Nodes` 里
 * @param {string} ch
 * @returns {boolean}
 */
function isWordBoundary(ch) {
  return !ch || !/[A-Za-z0-9_#.+-]/.test(ch)
}

/**
 * 用 `<x>…</x>` 包裹词表里的词,供 DeepL(tag_handling=xml)与 Google(format=html)原样保留。
 * 已经在标签里的内容不再包裹(既防止嵌套畸形,也避免二次包裹)。
 * @param {string} text
 * @param {string[]} terms
 * @returns {string}
 */
function wrapTerms(text, terms) {
  let out = String(text == null ? '' : text)
  if (!out || !terms || !terms.length) return out
  for (const term of terms) {
    const idx = []
    let from = 0
    for (;;) {
      const at = out.indexOf(term, from)
      if (at < 0) break
      idx.push(at)
      from = at + term.length
    }
    if (!idx.length) continue
    // 从后往前插,前面的下标才不会失效
    for (let i = idx.length - 1; i >= 0; i--) {
      const at = idx[i]
      if (!isWordBoundary(out[at - 1]) || !isWordBoundary(out[at + term.length])) continue
      out = out.slice(0, at) + '<x>' + term + '</x>' + out.slice(at + term.length)
    }
  }
  return out
}

/**
 * 去掉 <x> 包裹(服务端可能把标签翻成大写或加空格)。
 * @param {string} text
 * @returns {string}
 */
function unwrapTerms(text) {
  return String(text == null ? '' : text).replace(/<\s*\/?\s*x\s*>/gi, '')
}

/**
 * AI 通道的系统提示词。
 * 明确「只输出 JSON」这一点很重要:没有这句,模型会先寒暄一段再给译文,
 * 解析层就得靠猜(见 transproviders.parseAi)。
 * @param {string} targetLabel 目标语言的中文名,如「简体中文」
 * @param {string[]} terms
 * @returns {string}
 */
function systemPrompt(targetLabel, terms) {
  const list = (terms || []).slice(0, 60).join(', ')
  return [
    `You are a translation engine for a Godot plugin manager. Translate each item into ${targetLabel}.`,
    'Rules:',
    '- Output STRICT JSON only: {"items":[{"i":0,"t":"translated text"}, ...]} — same number of items, same order, same "i" values.',
    '- Translate the meaning naturally for game developers; do not add explanations, notes, or quotes.',
    '- Keep code, identifiers, file paths, version numbers and URLs EXACTLY as they are.',
    '- Keep these terms untranslated: ' + (list || '(none)') + '.',
    '- Preserve leading/trailing whitespace and any newlines of each item.'
  ].join('\n')
}

module.exports = { BUILTIN_TERMS, allTerms, wrapTerms, unwrapTerms, systemPrompt, isWordBoundary }
