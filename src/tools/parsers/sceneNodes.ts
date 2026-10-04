// `.tscn` / `.tres` 的 `[node]` 段解析(纯函数,可单测)。设计见 docs/tools-page-plan.md P1-4 #13。
//
// 与 sceneRefs 的分工:那边**刻意不碰** node 段(逐行判 ext_resource 时天然挡掉,
// 见 sceneRefs.ts:7 与 tools.test.mjs:300 那条断言),因为引用收集多收一条就会多一个假孤儿;
// 本件是同一份文本的另一半 —— 真把节点树读出来。两边共用 attr() 与同一把「段头前缀」尺子,
// 长不出第二份正则(债 8 的红线)。
//
// parent 的语义照 Godot 写盘格式:`parent="."` 是根,`parent="HUD"` / `parent="A/B"` 是**相对根**的路径。
// 所以递推不需要查表 —— 根 path 就是根节点自己的 name,其余一律 `根 name + '/' + parent + '/' + name`。

import { attr } from './sceneRefs'

export interface SceneNode {
  name: string
  type: string
  /** 段头原样的 parent(`.` = 根;空串 = 这个段自己就是根) */
  parent: string
  /** 递推出的完整节点路径;根 = 自己的 name。认不出根时给空串,不臆造 */
  path: string
  /** 1-based 段头行号;0 = 未声明 */
  line: number
  /** 体内 `script = ExtResource("id")` 的 id;没有则空串 */
  scriptId: string
  /**
   * 体内 `script = "res://a/x.gd"` 的**串形态**(手写 .tscn 与某些插件产物会这么写,不走 id)。
   * 与 scriptId 各自保留:两边都判存在性才有意义,合成一个字段就会丢一种形态。
   */
  scriptPath: string
}

/** 段头谓词:`[node ...]` 必须带空格才有属性区(与 sceneRefs.ts:42 同一把尺子) */
function isNodeHead(t: string): boolean {
  return t.startsWith('[node ')
}

const SCRIPT_EXT_RE = /^script\s*=\s*ExtResource\(\s*"([^"]*)"\s*\)/
const SCRIPT_PATH_RE = /^script\s*=\s*("[^"]*"|'[^']*')\s*$/

/**
 * 按文件顺序给出所有 `[node]` 段;非 node 段(ext_resource / sub_resource / connection / 文件头)
 * 只负责让上一个节点「收口」,自己不产出条目。
 */
export function parseSceneNodes(text: string): SceneNode[] {
  const out: SceneNode[] = []
  let cur: SceneNode | null = null

  const rows = String(text || '').split(/\r?\n/)
  for (let i = 0; i < rows.length; i++) {
    const t = rows[i].trim()
    if (t.startsWith('[')) {
      cur = isNodeHead(t)
        ? {
            name: attr(t.slice(t.indexOf('[') + 1, t.lastIndexOf(']')), 'name'),
            type: attr(t.slice(t.indexOf('[') + 1, t.lastIndexOf(']')), 'type'),
            parent: attr(t.slice(t.indexOf('[') + 1, t.lastIndexOf(']')), 'parent'),
            path: '',
            line: i + 1,
            scriptId: '',
            scriptPath: '',
          }
        : null
      if (cur) out.push(cur)
      continue
    }
    if (!cur) continue
    const m = SCRIPT_EXT_RE.exec(t)
    if (m && !cur.scriptId) { cur.scriptId = m[1]; continue }
    const p = SCRIPT_PATH_RE.exec(t)
    if (p && !cur.scriptPath) cur.scriptPath = p[1].slice(1, -1) // 剥外层引号;res:// 原样留着
  }

  // path 递推放在第二趟:根要等它自己那条先落袋,后面才认得 `.` 指谁。
  // 根的定义是**没有 parent 属性**的那个段(`parent="."` 是「挂在根下」,不是根自己)。
  // 一个只写 parent="." 却没有根段的畸形文件,path 一律给空串 —— 编一个路径出来
  // 会让 #13 的「同名兄弟」分组落到一个引擎里根本不存在的前缀上。
  const root = out.length ? out.find((n) => n.parent === '') || null : null
  const rootPath = root ? root.name : ''
  for (const n of out) {
    if (n === root || n.parent === '') n.path = n.name
    else if (!rootPath) n.path = ''
    else if (n.parent === '.') n.path = rootPath + '/' + n.name
    else n.path = rootPath + '/' + n.parent + '/' + n.name
  }
  return out
}
