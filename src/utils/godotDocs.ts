// 文档页与官方在线文档的链接换算。
//
// 在线文档的版本路径按「小版本」组织(如 en/4.3/),引擎 tag 形如 4.7.2-stable,
// 截取主.次位;dev/未知来源回退 stable。@GlobalScope 的在线页名保留 @ 前缀。

/**
 * 类的官方在线文档地址(不带锚点 —— 打开后在页面内检索,锚点格式随文档构建变动不做硬编码)。
 * @param tag 引擎 tag,如 '4.7.2-stable'
 * @param className 类名,如 'Node' / '@GlobalScope'
 */
export function onlineDocsUrl(tag: string | undefined, className: string): string {
  const m = /^(\d+\.\d+)/.exec(String(tag || ''))
  const ver = m ? m[1] : 'stable'
  const name = String(className || '').toLowerCase()
  return `https://docs.godotengine.org/en/${ver}/classes/class_${name}.html`
}

/**
 * 方法/信号/成员的在线页地址(带锚点,格式 class_<name>.html#method-<小写符号名>)。
 * 仅用于「复制 Markdown」;打开类页用 onlineDocsUrl。
 */
export function onlineDocsAnchorUrl(tag: string | undefined, className: string, kind: string, symbol: string): string {
  const base = onlineDocsUrl(tag, className)
  const suffixes: Record<string, string> = { method: 'method', signal: 'signal', constant: 'constant', enum: 'enum', member: 'property' }
  const prefix = suffixes[kind]
  if (!prefix) return base
  return `${base}#${prefix}-${String(symbol).toLowerCase()}`
}
