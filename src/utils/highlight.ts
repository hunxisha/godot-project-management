// 代码语法着色(零依赖):把一段代码切成着色 token。
//
// 角色与 Godot 编辑器默认高亮对齐:关键字 / 控制流 / 基础类型 / 引擎类型 / 用户类型 /
// 函数 / 成员 / 字符串 / 数字 / 注释 / 文档注释 / 运算符与标点。颜色由 main.css 的
// `--syn-*` 提供(亮/暗各一套,语义跨明暗稳定)。
//
// 只做词法上色,不做语法分析;所有 token 的 v 按序拼接 === 原文(内容永不丢失),
// 该不变量由 src/__tests__/bbcode.test.mjs 断言。

/** 单次着色产物:c 为 CSS 类后缀(kw/cf/tyb/tye/tyu/fn/mem/str/num/com/doc/sym),空串表示原样 */
export interface HLToken { c: string, v: string }

type Lang = 'gdscript' | 'csharp'

interface LangProfile {
  /** 行注释起始符('#' / '//') */
  line: string
  /** 文档注释起始符('##' / '///'),需先于行注释匹配 */
  doc: string
  /** 块注释定界符(C# 用;GDScript 没有) */
  block: [string, string] | null
  /** 字符串前缀,按长度降序(含裸引号;如 &"…" / @"…" / """…""") */
  strings: string[]
  keywords: Set<string>
  controlFlow: Set<string>
  baseTypes: Set<string>
  /** GDScript 的 @注解 */
  annotations: boolean
  /** GDScript 的 $Node / %Unique 节点路径 */
  nodePaths: boolean
  /** 大写标识符默认是类型(GDScript);C# 里大写方法名更常见,留给「后跟 (」判断 */
  pascalIsType: boolean
}

const GD_KEYWORDS = new Set([
  'var', 'func', 'signal', 'enum', 'const', 'static', 'class', 'class_name', 'extends',
  'is', 'in', 'as', 'self', 'super', 'and', 'or', 'not', 'true', 'false', 'null', 'void',
  'breakpoint', 'assert', 'yield'
])

const GD_CONTROL_FLOW = new Set(['if', 'elif', 'else', 'for', 'while', 'match', 'when', 'return', 'break', 'continue', 'pass', 'await'])

const GD_BASE_TYPES = new Set([
  'int', 'float', 'bool', 'String', 'StringName', 'NodePath', 'Variant',
  'Array', 'Dictionary', 'Callable', 'Signal', 'RID'
])

const CS_KEYWORDS = new Set([
  'using', 'namespace', 'class', 'struct', 'var', 'new', 'public', 'private', 'protected',
  'internal', 'static', 'readonly', 'const', 'void', 'this', 'base', 'override', 'virtual',
  'abstract', 'sealed', 'interface', 'enum', 'true', 'false', 'null', 'in', 'out', 'ref', 'is',
  'as', 'typeof', 'default', 'get', 'set', 'partial', 'where', 'select', 'record', 'delegate',
  'event', 'params', 'extern', 'unsafe', 'fixed', 'checked', 'unchecked', 'implicit', 'explicit',
  'operator', 'async', 'nameof', 'lock', 'sizeof', 'stackalloc', 'volatile'
])

const CS_CONTROL_FLOW = new Set([
  'if', 'else', 'for', 'foreach', 'while', 'do', 'switch', 'case', 'break', 'continue',
  'return', 'throw', 'try', 'catch', 'finally', 'yield', 'goto', 'when', 'await'
])

const CS_BASE_TYPES = new Set([
  'bool', 'byte', 'sbyte', 'char', 'decimal', 'double', 'float', 'int', 'uint', 'long',
  'ulong', 'short', 'ushort', 'object', 'string', 'dynamic', 'nint', 'nuint',
  // Godot C# 沿用的值类型(Godot.Collections.*)
  'Array', 'Dictionary', 'StringName', 'NodePath', 'Variant', 'Callable', 'Signal', 'Rid'
])

/**
 * 引擎内置类(常见 ~200 个,覆盖文档示例)。不在表内的大写标识符归「用户类型」——
 * 这里刻意不追求穷举:两者只差一个蓝调,且维护成本远高于收益。
 */
const ENGINE_TYPES = new Set([
  'Object', 'RefCounted', 'Resource', 'Node', 'Node2D', 'Node3D', 'CanvasItem', 'CanvasLayer',
  'CanvasModulate', 'Window', 'Viewport', 'SubViewport', 'Control', 'Container', 'BoxContainer',
  'VBoxContainer', 'HBoxContainer', 'GridContainer', 'MarginContainer', 'PanelContainer',
  'CenterContainer', 'ScrollContainer', 'TabContainer', 'SplitContainer', 'Label',
  'RichTextLabel', 'Button', 'TextureButton', 'LinkButton', 'CheckBox', 'CheckButton',
  'OptionButton', 'MenuButton', 'ColorPickerButton', 'ColorPicker', 'LineEdit', 'TextEdit',
  'CodeEdit', 'ProgressBar', 'TextureProgressBar', 'Slider', 'HSlider', 'VSlider', 'SpinBox',
  'ItemList', 'Tree', 'TreeItem', 'TabBar', 'PopupMenu', 'PopupPanel', 'FileDialog',
  'AcceptDialog', 'ConfirmationDialog', 'Sprite2D', 'Sprite3D', 'AnimatedSprite2D',
  'TextureRect', 'NinePatchRect', 'Texture', 'Texture2D', 'ImageTexture', 'Image', 'Camera2D',
  'Camera3D', 'Light2D', 'PointLight2D', 'DirectionalLight3D', 'OmniLight3D', 'SpotLight3D',
  'MeshInstance3D', 'Mesh', 'ArrayMesh', 'ImmediateMesh', 'PrimitiveMesh', 'BoxMesh',
  'SphereMesh', 'CylinderMesh', 'QuadMesh', 'PlaneMesh', 'Material', 'StandardMaterial3D',
  'ShaderMaterial', 'Shader', 'Environment', 'WorldEnvironment', 'PhysicsBody2D',
  'PhysicsBody3D', 'CharacterBody2D', 'CharacterBody3D', 'RigidBody2D', 'RigidBody3D',
  'StaticBody2D', 'StaticBody3D', 'Area2D', 'Area3D', 'CollisionShape2D', 'CollisionShape3D',
  'CollisionPolygon2D', 'CollisionPolygon3D', 'RayCast2D', 'RayCast3D', 'Shape2D', 'Shape3D',
  'RectangleShape2D', 'CircleShape2D', 'CapsuleShape2D', 'PhysicsMaterial', 'TileMap',
  'TileMapLayer', 'TileSet', 'AnimationPlayer', 'AnimationTree', 'AnimationNodeStateMachine',
  'Animation', 'AnimationLibrary', 'AnimationMixer', 'Tween', 'Timer', 'SceneTree',
  'SceneTreeTimer', 'Input', 'InputEvent', 'InputEventKey', 'InputEventMouseButton',
  'InputEventMouseMotion', 'InputEventAction', 'InputMap', 'Engine', 'OS', 'ProjectSettings',
  'DisplayServer', 'ResourceLoader', 'ResourceSaver', 'FileAccess', 'DirAccess', 'JSON',
  'ConfigFile', 'Gradient', 'GradientTexture1D', 'GradientTexture2D', 'Font', 'FontFile',
  'SystemFont', 'LabelSettings', 'StyleBox', 'StyleBoxFlat', 'Theme', 'PackedScene',
  'PackedByteArray', 'PackedInt32Array', 'PackedInt64Array', 'PackedFloat32Array',
  'PackedFloat64Array', 'PackedStringArray', 'PackedVector2Array', 'PackedVector3Array',
  'PackedColorArray', 'AABB', 'Aabb', 'Vector2', 'Vector2i', 'Vector2I', 'Vector3', 'Vector3i',
  'Vector3I', 'Vector4', 'Vector4i', 'Vector4I', 'Rect2', 'Rect2i', 'Rect2I', 'Transform2D',
  'Transform3D', 'Basis', 'Quaternion', 'Plane', 'Projection', 'Color', 'MultiplayerAPI',
  'MultiplayerSpawner', 'MultiplayerSynchronizer', 'ENetMultiplayerPeer', 'HTTPRequest',
  'HTTPClient', 'WebSocketPeer', 'PacketPeerUDP', 'AudioStream', 'AudioStreamPlayer',
  'AudioStreamPlayer2D', 'AudioStreamPlayer3D', 'AudioStreamMP3', 'AudioStreamOggVorbis',
  'AudioServer', 'AudioEffect', 'PhysicsServer2D', 'PhysicsServer3D', 'RenderingServer',
  'NavigationAgent2D', 'NavigationAgent3D', 'NavigationRegion2D', 'NavigationRegion3D',
  'NavigationMesh', 'AStar2D', 'AStar3D', 'AStarGrid2D', 'RandomNumberGenerator', 'Curve',
  'Curve2D', 'Curve3D', 'Path2D', 'Path3D', 'PathFollow2D', 'PathFollow3D', 'Line2D', 'Line3D',
  'Polygon2D', 'CPUParticles2D', 'CPUParticles3D', 'GPUParticles2D', 'GPUParticles3D',
  'ParticleProcessMaterial', 'Skeleton2D', 'Skeleton3D', 'Bone2D', 'BoneAttachment3D',
  'Parallax2D', 'ParallaxBackground', 'GridMap', 'MultiMesh', 'MultiMeshInstance3D',
  'ReflectionProbe', 'Decal', 'VisualShader', 'FastNoiseLite', 'NoiseTexture2D', 'PhysicsRayQueryParameters2D',
  'PhysicsRayQueryParameters3D', 'SphereShape3D', 'BoxShape3D', 'WorldBoundaryShape3D',
  'GDScript', 'CSharpScript', 'Script', 'Time', 'Marshalls', 'Geometry2D', 'Geometry3D'
])

/** 引擎全局常量:按关键字着色,避免被当成用户类型 */
const GLOBAL_CONSTANTS = new Set(['PI', 'TAU', 'INF', 'NAN'])

const GDSCRIPT: LangProfile = {
  line: '#',
  doc: '##',
  block: null,
  strings: ['"""', "'''", '&"', "&'", '^"', "^'", 'r"', "r'", '"', "'"],
  keywords: GD_KEYWORDS,
  controlFlow: GD_CONTROL_FLOW,
  baseTypes: GD_BASE_TYPES,
  annotations: true,
  nodePaths: true,
  pascalIsType: true
}

const CSHARP: LangProfile = {
  line: '//',
  doc: '///',
  block: ['/*', '*/'],
  strings: ['$@"', '@$"', '"""', '$"', '@"', '"', "'"],
  keywords: CS_KEYWORDS,
  controlFlow: CS_CONTROL_FLOW,
  baseTypes: CS_BASE_TYPES,
  annotations: false,
  nodePaths: false,
  pascalIsType: false
}

const isIdStart = (ch: string) => /[A-Za-z_]/.test(ch)
const isIdPart = (ch: string) => /[A-Za-z0-9_]/.test(ch)
const isDigit = (ch: string) => ch >= '0' && ch <= '9'
const isSpace = (ch: string) => ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t'

/** 数字:hex/bin/oct、小数、指数、下划线分隔与 C# 后缀 */
const NUM_RE = /0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*)?\.\d[\d_]*(?:[eE][+-]?\d+)?|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?(?:[fFdDmMuUlL]+)?/y

interface Piece { c: string, start: number, end: number }

function lineEnd(code: string, from: number): number {
  const nl = code.indexOf('\n', from)
  return nl < 0 ? code.length : nl
}

function nextNonSpace(code: string, from: number): string {
  let j = from
  while (j < code.length && isSpace(code[j])) j++
  return code[j] ?? ''
}

/**
 * 从 start 处的字符串前缀开始,返回该字符串的结束位置(开区间)。
 * 支持三引号、C# 逐字字符串(@"…" 的双引号转义)、反斜杠转义;
 * 单行字符串未闭合时止于行尾(不吞掉后续代码)。
 */
function scanString(code: string, start: number, prefix: string): number {
  const quote = prefix[prefix.length - 1]
  const triple = prefix.length >= 3 && prefix.slice(-3) === quote.repeat(3)
  const verbatim = prefix.includes('@')
  const n = code.length
  let j = start + prefix.length
  if (triple) {
    while (j < n) {
      if (code[j] === '\\' && !verbatim) { j += 2; continue }
      if (code.startsWith(quote.repeat(3), j)) return j + 3
      j++
    }
    return n
  }
  while (j < n) {
    const ch = code[j]
    if (!verbatim && ch === '\\') { j += 2; continue }
    if (ch === quote) {
      if (verbatim && code[j + 1] === quote) { j += 2; continue }
      return j + 1
    }
    if (!verbatim && (ch === '\n' || ch === '\r')) return j
    j++
  }
  return n
}

/** 标识符 → 角色。判断顺序即优先级:类型不会被后面的「调用」误判成函数 */
function classifyIdent(id: string, p: LangProfile, afterDot: boolean, nextIsCall: boolean, prevWord: string): string {
  if (p.controlFlow.has(id)) return 'cf'
  if (p.keywords.has(id)) return 'kw'
  if (p.baseTypes.has(id)) return 'tyb'
  if (GLOBAL_CONSTANTS.has(id)) return 'kw'
  if (id.startsWith('@')) return 'kw'
  if (ENGINE_TYPES.has(id)) return 'tye'
  // `.` 之后:成员优先于「大写即类型」,否则 .ZERO / .Print 会被错标成类型
  if (afterDot) return 'mem'
  if (prevWord === 'new') return 'tyu'
  const first = id[0]
  const upper = !!first && first !== first.toLowerCase()
  if (upper && p.pascalIsType) return 'tyu'
  if (nextIsCall) return 'fn'
  if (upper) return 'tyu'
  return ''
}

function lex(code: string, p: LangProfile): HLToken[] {
  const n = code.length
  const pieces: Piece[] = []
  let i = 0
  let afterDot = false
  /** 上一个标识符原文(用于 `new Foo` 这类上下文) */
  let prevWord = ''

  while (i < n) {
    const ch = code[i]
    if (isSpace(ch)) { i++; continue }

    // 文档注释先于行注释匹配(## / ///)
    if (code.startsWith(p.doc, i)) {
      const end = lineEnd(code, i)
      pieces.push({ c: 'doc', start: i, end })
      i = end
      afterDot = false
      continue
    }
    if (code.startsWith(p.line, i)) {
      const end = lineEnd(code, i)
      pieces.push({ c: 'com', start: i, end })
      i = end
      afterDot = false
      continue
    }
    if (p.block && code.startsWith(p.block[0], i)) {
      const close = code.indexOf(p.block[1], i + p.block[0].length)
      const end = close < 0 ? n : close + p.block[1].length
      pieces.push({ c: close >= 0 && code[i + 2] === '*' ? 'doc' : 'com', start: i, end })
      i = end
      afterDot = false
      continue
    }

    // 字符串(含前缀)
    const prefix = p.strings.find((s) => code.startsWith(s, i))
    if (prefix) {
      const end = scanString(code, i, prefix)
      pieces.push({ c: 'str', start: i, end })
      i = end
      afterDot = false
      continue
    }

    // 数字
    if (isDigit(ch) || (ch === '.' && isDigit(code[i + 1] ?? ''))) {
      NUM_RE.lastIndex = i
      const m = NUM_RE.exec(code)
      if (m && m[0].length > 0) {
        pieces.push({ c: 'num', start: i, end: i + m[0].length })
        i += m[0].length
        afterDot = false
        continue
      }
    }

    // GDScript 注解 @export / @onready
    if (p.annotations && ch === '@' && isIdStart(code[i + 1] ?? '')) {
      let j = i + 2
      while (j < n && isIdPart(code[j])) j++
      pieces.push({ c: 'kw', start: i, end: j })
      i = j
      afterDot = false
      continue
    }

    // GDScript 节点路径 $Node/Child、%Unique(整体当字符串; $"…" 的 $ 当符号)
    // % 只在「前面不是标识符」时才算唯一节点名,否则 a%b 会被误当成路径
    const nodeSigil = ch === '$' || (ch === '%' && !isIdPart(code[i - 1] ?? ''))
    if (p.nodePaths && nodeSigil && (isIdStart(code[i + 1] ?? '') || code[i + 1] === '/' || code[i + 1] === '"' || code[i + 1] === "'")) {
      if (code[i + 1] === '"' || code[i + 1] === "'") {
        pieces.push({ c: 'sym', start: i, end: i + 1 })
        i += 1
        afterDot = false
        continue
      }
      let j = i + 1
      while (j < n && (isIdPart(code[j]) || code[j] === '/' || code[j] === '.')) j++
      pieces.push({ c: 'str', start: i, end: j })
      i = j
      afterDot = false
      continue
    }

    // 标识符
    if (isIdStart(ch)) {
      let j = i + 1
      while (j < n && isIdPart(code[j])) j++
      const id = code.slice(i, j)
      const cls = classifyIdent(id, p, afterDot, nextNonSpace(code, j) === '(', prevWord)
      pieces.push({ c: cls, start: i, end: j })
      i = j
      afterDot = false
      prevWord = id
      continue
    }

    // 其余单字符:运算符与标点
    pieces.push({ c: 'sym', start: i, end: i + 1 })
    afterDot = ch === '.'
    prevWord = ''
    i++
  }

  // 补齐 token 之间的原样片段(空白、换行等),保证拼接 === 原文
  const out: HLToken[] = []
  let last = 0
  for (const pc of pieces) {
    if (pc.start > last) out.push({ c: '', v: code.slice(last, pc.start) })
    out.push({ c: pc.c, v: code.slice(pc.start, pc.end) })
    last = pc.end
  }
  if (last < code.length) out.push({ c: '', v: code.slice(last) })
  return out
}

/**
 * 单个类型名 → 着色角色。文档签名与代码块共用这张表,避免两处各维护一份。
 * 基础类型 tyb、引擎类 tye、其余大写标识符 tyu;小写且不认识的返回空串(原样)。
 */
export function typeRole(id: string): string {
  if (!id) return ''
  if (id === 'void' || GD_BASE_TYPES.has(id) || CS_BASE_TYPES.has(id)) return 'tyb'
  if (GLOBAL_CONSTANTS.has(id)) return 'kw'
  if (ENGINE_TYPES.has(id)) return 'tye'
  const first = id[0]
  if (first && first !== first.toLowerCase()) return 'tyu'
  return ''
}

/**
 * 代码语法着色。lang='gdscript'/空 → GDScript 规则;'csharp' → C# 规则;
 * 其他语言(如 lang=text)整段原样。
 */
export function highlightCode(code: string, lang?: string): HLToken[] {
  if (lang === 'csharp') return lex(code, CSHARP)
  if (lang && lang !== 'gdscript') return [{ c: '', v: code }]
  return lex(code, GDSCRIPT)
}
