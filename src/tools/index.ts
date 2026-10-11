// 只为「渲染层测试」存在的 barrel:build-bundle.mjs 打一个 tools.mjs 入口,
// 测试按名字从这里取全部纯函数。视图代码**不要** import 这里 —— 直接 import 具体模块
// (`../tools/treeUtils`),否则会把无关模块一起拖进视图的 chunk。
//
// 工具箱重做 · 第 0 批:这里**只留 Godot 项目文件的解析器与树工具**(旧三层结构里的 ① 层)。
//
// 被请出去的是体检这一**产品**自己的东西 —— registry / types / aggregate / outcome /
// fixPlan / report / gate / finding。它们讲的都是一句话:「一次扫树,出 18 份结论,
// 再汇成一条按类别分组的问题流」。那个产品形态已被否掉(理由与取舍见
// docs/toolkit-redesign-plan.md §2.1),所以连着 18 个检查器一起拆了。
//
// 留下来的这批**不属于体检**,它是「怎么读懂 Godot 的项目文件」:
//   · 第 1 批的「GDScript 代码格式化」吃 parsers/gdScript 的 inString / continuation / suspect
//     三个状态位 —— 那份分类器钉的是「哪些字节永远不许动」,不认识构造一律落进最保守那一侧,
//     所以它看不懂的后果只会是少改,不会是改坏。
//   · 第 2 批的「批量重命名」吃 refIndex + parsers/sceneRefs + gdSymbols + importFile + godotIni,
//     因为改一个 .gd 的名字就得同步所有 load/preload/ext_resource/project.godot 里的引用点。
//   · treeUtils 是两批共用的文件树过滤、排序与计数。
//
// ⚠ 本文件是 .gpm-test/out/tools.mjs 的**唯一构建入口**(build-bundle.mjs 的 tools 项)。
// 删它等于删掉上面全部测试的取符号通道 —— 要动请先动 build-bundle.mjs,别只改这里。
export * from './treeUtils'
export * from './parsers/sceneRefs'
export * from './parsers/godotIni'
export * from './parsers/importFile'
export * from './parsers/gdScript'
export * from './parsers/secretPatterns'
export * from './parsers/gdSymbols'
export * from './parsers/sceneNodes'
export * from './parsers/translationCsv'
export * from './refIndex'
