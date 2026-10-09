// 自编译模板 · 探测层:对着用户那份源码树回答"这个开关存不存在、它的默认值是什么"。
//
// 为什么要有这一层而不是在功能表里写 `since: '4.5'`(策划书 §2 决策 2):
// 探测同时给出**存在性**与**源码默认值**,后者是 §5.3 那条"选择 ≠ 默认才输出"规则的前提;
// 而且它不随版本腐化 —— 每次小版本都要改插件的表,迟早和源码对不上,而 scons 对不认识的
// 参数是**静默忽略**的(策划书 §6 末实验:值不进 env、无 warning、退出码 0),
// 对不上不会报错,只会让用户拿到一个"以为裁了其实没裁"的产物。
//
// 这些解析函数本身都不做 IO:纯文本函数吃源码片段,`detectBuiltinModules` 把「列目录 / 探文件 /
// 读文件」三件事收进参数里由调用方注入(本层不 require('fs'))。真正的 IO 由 probeSource() 那层
// 负责,测试直接喂真实源码片段、或喂一棵假目录树。
/** @typedef {Record<string, {exists: true, default: boolean|string}>} OptionMap */

// 双引号与单引号两种写法都要认:4.7.2 的 SConstruct 用双引号,
// 平台文件与更早的版本里单引号混着出现。默认值只认 True/False/带引号字符串/整数。
const VAR_DECL = /(?:Bool|Enum)Variable\(\s*["']([a-z0-9_]+)["']\s*,\s*(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*,\s*(True|False|"([^"]*)"|'([^']*)'|\d+)/g

/**
 * 解析 SConstruct(或任何 .py 构建脚本)里的变量声明。
 * 同名只取**第一次**出现 —— 源码里同一变量不会重复 Add,重复出现时先出现的才是真声明。
 * @param {string} text
 * @returns {OptionMap}
 */
function parseSconsOptions(text) {
  /** @type {OptionMap} */
  const out = {}
  if (typeof text !== 'string') return out
  VAR_DECL.lastIndex = 0
  let m
  while ((m = VAR_DECL.exec(text))) {
    if (m[1] in out) continue
    out[m[1]] = { exists: true, default: decodeDefault(m[2], m[3], m[4]) }
  }
  return out
}

/** @param {string} raw @param {string} [dq] @param {string} [sq] @returns {boolean|string} */
function decodeDefault(raw, dq, sq) {
  if (raw === 'True') return true
  if (raw === 'False') return false
  if (dq !== undefined) return dq
  if (sq !== undefined) return sq
  return raw // 整数默认值(极少见)原样留字符串,由调用方判
}

// 模块的 is_enabled() 形态固定,但中间可能夹注释行 —— 4.7.2 的 mono 就是:
//   def is_enabled():
//       # The module is disabled by default. Use module_mono_enabled=yes to enable it.
//       return False
// (modules/mono/config.py:31-33;text_server_fb/config.py:10-12 同形态。全树只有这两个模块定义它。)
const IS_ENABLED = /def\s+is_enabled\s*\(\s*\)\s*:\s*(?:#[^\n]*\n\s*)?return\s+(True|False)\b/

/**
 * 读一个 `modules/<x>/config.py` 的默认启用状态。
 * 没有 `is_enabled()` 就是 True —— 依据 `SConstruct:476-483`:先置 True,再 try 调 `config.is_enabled()`,
 * `AttributeError` 才保持 True。4.7.2 全量 57 个模块目录里只有 `mono` 与 `text_server_fb` 定义了它。
 * (注:`SConstruct:476` 外面还套着 `if env["modules_enabled_by_default"]:`,那个选项默认 True,
 * 用户显式设成 no 时全部模块默认 False —— 那是 profile 层的事,本层只管源码声明的默认形态。)
 * @param {string} configText
 * @returns {boolean}
 */
function parseIsEnabled(configText) {
  const m = IS_ENABLED.exec(String(configText || ''))
  if (!m) return true
  return m[1] === 'True'
}

// methods.py:302-309 `is_module()` 的原文判据(文档见 :244):
// "A module must have `register_types.h`, `SCsub`, `config.py` files created to be detected.",
// 且 `os.path.isdir(path)` —— 少一件就不是模块,给它生成 module_x_enabled 是在猜。
const MODULE_MARKERS = ['register_types.h', 'SCsub', 'config.py']

/**
 * 探测内置模块开关。键一律 `module_<目录名>_enabled`(methods.py:258 `module_name = os.path.basename(path)`,
 * 拼键的动作在 SConstruct:485)—— 没有名字翻译层,所以 `jolt_physics` 就是 `module_jolt_physics_enabled`,
 * 官方文档里那个 `module_jolt_enabled` 是滞后写法,源码里不存在。
 * 点开头的条目跳过:methods.py:273 用 `glob.glob(os.path.join(path, "*"))` 枚举子项,`*` 天然不匹配点开头。
 * @param {(rel: string) => string[]} listDir  传 'modules' 时返回其下条目名
 * @param {(rel: string) => boolean} exists
 * @param {(rel: string) => string} read
 * @returns {OptionMap}
 */
function detectBuiltinModules(listDir, exists, read) {
  /** @type {OptionMap} */
  const out = {}
  let names = []
  try { names = listDir('modules') || [] } catch (e) { return out }
  for (const name of names) {
    if (!name || name.startsWith('.')) continue
    const base = `modules/${name}`
    if (!MODULE_MARKERS.every((f) => safeExists(exists, `${base}/${f}`))) continue
    const key = `module_${name}_enabled`
    if (key in out) continue
    out[key] = { exists: true, default: parseIsEnabled(safeRead(read, `${base}/config.py`)) }
  }
  return out
}

/** @param {(p: string) => boolean} fn @param {string} p */
function safeExists(fn, p) {
  try { return !!fn(p) } catch (e) { return false }
}
/** @param {(p: string) => string} fn @param {string} p */
function safeRead(fn, p) {
  try { return String(fn(p) || '') } catch (e) { return '' }
}

/**
 * 解析 `if env["<x>"]:` 块里的 `env["<y>"] = True` 赋值,当作这份源码的真实连带图。
 *
 * 为什么要探不内置:4.3-stable 的 `disable_3d` 块(:963-968)只加一个 `_3D_DISABLED` 宏,
 * 4.5-stable(:1023-1027)起才强制 navigation_3d/physics_3d/xr(4.7.2 在 :1076-1080)。
 * 内置声明会在 4.3 上谎称裁掉了那三项 —— 而 4.3 根本没有那三个选项,探测会正确判 absent。
 * 出块判据用缩进(顶行 `if` 之后所有更深缩进行都属于该块),所以 4.3 那个 if/else 嵌套
 * 也能正确走完;else 分支里没有 `env["x"] = True` 赋值,结果仍为空。
 * @param {string} text
 * @returns {Record<string, string[]>}
 */
function parseCascades(text) {
  /** @type {Record<string, string[]>} */
  const out = {}
  const lines = String(text || '').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const head = /^if\s+env\["([a-z0-9_]+)"\]:\s*$/.exec(lines[i])
    if (!head) continue
    const src = head[1]
    /** @type {string[]} */
    const targets = []
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]
      if (!line.trim()) continue
      if (!/^[ \t]/.test(line)) break // 回到顶格 = 出块
      const a = /^[ \t]+env\["([a-z0-9_]+)"\]\s*=\s*True\s*$/.exec(line)
      if (a && a[1] !== src && !targets.includes(a[1])) targets.push(a[1])
    }
    if (targets.length) out[src] = targets
  }
  return out
}

module.exports = { parseSconsOptions, parseIsEnabled, detectBuiltinModules, parseCascades, MODULE_MARKERS }
