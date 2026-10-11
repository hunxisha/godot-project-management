// 内置工具清单(DEV-4:内置走**构建期静态 import**,用户插件走磁盘 + 动态执行)。
//
// 两条路只在这一个文件里分开,之后校验、能力门、feature 注册、启停、账本全部同码
// —— 只差 `source: 'builtin' | 'user'`(Q23=A 的「同一套」在实现上的落点)。
//
// 为什么不按 Q23 的字面做(内置也按磁盘文件加载):
// 那要 preload 去读包内目录,而 §D #1 那条事实未坐实,且本仓库的 preload 从未读过自己的包目录。
// 反悔成本低:将来把这里换成一次 `listToolPlugins(包内目录)` 即可,manifest 与注册代码一行不改。
//
// ⚠ `files` 要写全:manifest.ts 的校验器在拿到 files 时会检查 `entry` 真在目录里。
// 内置工具没有真实目录清单,这里给的是「这个模块在仓库里对应哪两个文件」,与磁盘上的名字一致。

import gdFormatManifest from './gdscript-format/manifest.json'
import * as gdFormat from './gdscript-format/index'

export interface BuiltinTool {
  /** manifest 原文(交给 validateManifest 解析,不在这里手写对象) */
  manifest: unknown
  /** 已 import 进来的 entry 模块 */
  mod: unknown
  files: string[]
}

export const BUILTIN_TOOLS: BuiltinTool[] = [
  { manifest: gdFormatManifest, mod: gdFormat, files: ['manifest.json', 'index.ts'] }
]
