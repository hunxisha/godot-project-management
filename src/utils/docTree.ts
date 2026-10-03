// 继承树的扁平行构建(纯函数,可独立断言)。
//
// 完整树语义:展开即铺开该节点的全部直接子类,折叠即只剩自身行。这棵树常驻在文档页
// 左侧导航里,展开状态由调用方持有(切类不清空,只在切库时清空),所以这里不做任何
// 「只展开根→当前类路径」的聚焦,也不再有 hiddenSiblings 那种「还有 N 个」入口。
//
// 不做数量截断:老实现 slice(0, 40) 会把路径上的 RefCounted 切掉(Object 有 70 个派生,
// 它排在 R 位),导致当前类根本不出现。单父映射保证 children 表是一棵森林,只要根集合
// 完整,全展开时每个类恰好出现一次。

/** 树的一行(扁平化渲染) */
export interface DocTreeRow {
  name: string
  /** 缩进层级(根为 0) */
  depth: number
  /** 直接派生总数 */
  childCount: number
  /** 是否在「根 → 当前类」路径上(含当前类自身) */
  onPath: boolean
  /** 是否当前类 */
  isCurrent: boolean
  /** 本行是否已铺开子节点(无子类的节点恒 false,即便调用方把它塞进了 expanded) */
  expanded: boolean
}

export interface FullTreeInput {
  /** 全部根类名,已按名排序(见 rootsFrom) */
  roots: string[]
  /** 类名 → 直接派生列表(调用方保证已按名排序) */
  childrenOf: (name: string) => string[]
  /** 类名 → 父类名(根返回 null) */
  parentOf: (name: string) => string | null
  /** 用户展开的节点集合 */
  expanded: Set<string>
  /** 当前打开的类:标 isCurrent,其祖先链标 onPath */
  currentClass: string
}

/** 构建完整树的扁平可见行 */
export function buildFullTreeRows(input: FullTreeInput): DocTreeRow[] {
  const { roots, childrenOf, parentOf, expanded, currentClass } = input

  const pathSet = new Set<string>()
  let cursor: string | null = currentClass
  while (cursor) {
    pathSet.add(cursor)
    cursor = parentOf(cursor)
  }

  const rows: DocTreeRow[] = []
  const visit = (name: string, depth: number) => {
    const kids = childrenOf(name)
    const open = expanded.has(name) && kids.length > 0
    rows.push({
      name,
      depth,
      childCount: kids.length,
      onPath: pathSet.has(name),
      isCurrent: name === currentClass,
      expanded: open
    })
    if (!open) return
    for (const k of kids) visit(k, depth + 1)
  }
  for (const r of roots) visit(r, 0)
  return rows
}

/**
 * 从「父类映射」取全部根:父类为 null,**或父类不在库内**。
 * 后者不能漏 —— 孤儿分支不当根就整支在导航里不可达(库里没有任何类指向它)。
 */
export function rootsFrom(parents: Map<string, string | null>): string[] {
  const roots: string[] = []
  for (const [name, parent] of parents) {
    if (!parent || !parents.has(parent)) roots.push(name)
  }
  return roots.sort((a, b) => a.localeCompare(b))
}

/**
 * 从「父类映射」构造 childrenOf 表(每个父类的子类按名排序)。供组件层建一次表后复用。
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
