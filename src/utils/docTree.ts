// 继承树的扁平行构建(纯函数,可独立断言)。
//
// 设计要点:树以**当前类为中心**——默认只展开「根 → 当前类」这条路径上的节点,
// 每层隐藏的兄弟用「还有 N 个」提示(点开才铺开)。这既让当前类一打开就可见,
// 又避免从 Object 铺开几十上百行把正文/侧栏淹掉。
//
// 老的实现按数量上限截断子节点,导致路径上的节点被截掉后直接中断(Object 有 70 个子类,
// RefCounted 排在 R 位被 slice(0,40) 切掉),当前类根本不出现在树里 —— 这里不再做
// 任何截断:要么全部显示(用户显式展开),要么只显示路径节点并给出隐藏计数。

/** 树的一行(扁平化渲染) */
export interface DocTreeRow {
  name: string
  /** 缩进层级(根为 0) */
  depth: number
  /** 直接派生总数 */
  childCount: number
  /** 是否在「根 → 当前类」路径上 */
  onPath: boolean
  /** 是否当前类 */
  isCurrent: boolean
  /** 本行是否已展开子节点 */
  expanded: boolean
  /** 未显示的兄弟数(折叠路径时用于「还有 N 个」入口;0 表示没有隐藏项) */
  hiddenSiblings: number
}

export interface DocTreeInput {
  /** 类名 → 直接派生列表(调用方保证已按名排序) */
  childrenOf: (name: string) => string[]
  /** 类名 → 父类名(根返回 null) */
  parentOf: (name: string) => string | null
  /** 当前打开的类 */
  currentClass: string
  /** 用户显式展开的节点(展开即显示全部子节点) */
  expanded: Set<string>
}

/**
 * 构建扁平树行。
 *
 * 展开规则:
 *   · 用户显式展开(expanded 命中)→ 显示全部子节点
 *   · 路径节点(onPath)→ 自动展开,但只显示路径上的那个子节点,其余收进 hiddenSiblings
 *   · 其余 → 折叠
 */
export function buildTreeRows(input: DocTreeInput): DocTreeRow[] {
  const { childrenOf, parentOf, currentClass, expanded } = input
  const pathSet = new Set<string>()
  // 从当前类向上收集路径(含当前类自身)
  let cursor: string | null = currentClass
  let guard = 0
  while (cursor && guard++ < 200) {
    pathSet.add(cursor)
    cursor = parentOf(cursor)
  }
  // 根 = 路径最顶端;当前类不在库中(或就是根)时以自身为根
  const chain: string[] = []
  let walkUp: string | null = currentClass
  guard = 0
  while (walkUp && guard++ < 200) {
    chain.unshift(walkUp)
    walkUp = parentOf(walkUp)
  }
  const rootName = chain[0] ?? currentClass

  const rows: DocTreeRow[] = []
  /** @type {number} 最近一次压入的行在 rows 中的下标(用于回填 hiddenSiblings) */
  let lastIdx = -1

  const visit = (name: string, depth: number) => {
    const kids = childrenOf(name)
    const onPath = pathSet.has(name)
    const userExpanded = expanded.has(name)
    const isCurrent = name === currentClass
    // 路径节点自动展开(否则当前类不可见);用户展开或当前类则铺开全部
    const expand = userExpanded || onPath
    // 当前类要看「谁继承了我」,所以它展开时列全部子类;路径中间层只列路径上的那一个,
    // 其余收进 hiddenSiblings(否则 Object 这类根节点的几十个兄弟会立刻淹掉当前类)
    const showAll = userExpanded || isCurrent
    const rowIdx = rows.length
    rows.push({
      name,
      depth,
      childCount: kids.length,
      onPath,
      isCurrent,
      expanded: expand && kids.length > 0,
      hiddenSiblings: 0
    })
    lastIdx = rowIdx
    if (!expand || !kids.length) return
    const shown = showAll ? kids : kids.filter((k) => pathSet.has(k))
    for (const k of shown) visit(k, depth + 1)
    if (shown.length < kids.length) rows[rowIdx].hiddenSiblings = kids.length - shown.length
  }

  visit(rootName, 0)
  void lastIdx
  return rows
}

/**
 * 从「父类映射」构造 childrenOf(按名排序)。供组件层一次性建表后复用。
 */
export function childrenMapFrom(parents: Map<string, string | null>): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const [name, parent] of parents) {
    if (!parent) continue
    const list = map.get(parent)
    if (list) list.push(name)
    else map.set(parent, [name])
  }
  for (const list of map.values()) list.sort((a, b) => a.localeCompare(b))
  return map
}
