// 自编译模板 · 探测层:对着用户那份源码树回答"这个开关存不存在、它的默认值是什么"。
//
// 为什么要有这一层而不是在功能表里写 `since: '4.5'`(策划书 §2 决策 2):
// 探测同时给出**存在性**与**源码默认值**,后者是 §5.3 那条"选择 ≠ 默认才输出"规则的前提;
// 而且它不随版本腐化 —— 每次小版本都要改插件的表,迟早和源码对不上,而 scons 对不认识的
// 参数是**静默忽略**的(策划书 §6 末实验:值不进 env、无 warning、退出码 0),
// 对不上不会报错,只会让用户拿到一个"以为裁了其实没裁"的产物。
//
// 三个解析函数都是纯文本函数,IO 由 probeSource() 那层注入,测试直接喂真实源码片段。
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

module.exports = { parseSconsOptions }
